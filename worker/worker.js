/**
 * Proxy IA Claude et synchronisation partagée STUDCORP pour Cloudflare Workers.
 * La clé Anthropic reste côté serveur. Le Durable Object fournit un état commun
 * et versionné à tous les appareils qui utilisent la même URL de Worker.
 */
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowedOrigin = (env.ALLOWED_ORIGIN || '').trim();
    const requestOrigin = request.headers.get('Origin') || '';
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin || 'null',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };

    if (!allowedOrigin) return new Response('Configuration manquante : définis le secret ALLOWED_ORIGIN.', { status: 500 });
    if (requestOrigin !== allowedOrigin) return new Response('Origine non autorisée.', { status: 403, headers: corsHeaders });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

    // API partagée de la carte mentale (GET pour charger, PUT pour sauvegarder).
    if (url.pathname === '/api/state') {
      if (!env.MINDMAP_SYNC) return jsonResponse({ error: 'Le stockage partagé MINDMAP_SYNC n’est pas configuré.' }, 500, corsHeaders);
      if (!['GET', 'PUT'].includes(request.method)) return jsonResponse({ error: 'Méthode non autorisée.' }, 405, corsHeaders);
      const id = env.MINDMAP_SYNC.idFromName('studcorp-editorial-map-v1');
      const stub = env.MINDMAP_SYNC.get(id);
      const forwarded = new Request('https://mindmap-sync.internal/state', {
        method: request.method,
        headers: { 'Content-Type': 'application/json' },
        body: request.method === 'PUT' ? await request.text() : undefined
      });
      const upstream = await stub.fetch(forwarded);
      const headers = new Headers(upstream.headers);
      Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
      headers.set('Cache-Control', 'no-store');
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    // L'application conserve son format OpenAI-compatible ; ce Worker le convertit
    // vers l'API Messages d'Anthropic, puis adapte la réponse au format attendu.
    if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      return new Response('Méthode ou chemin non autorisé.', { status: 405, headers: corsHeaders });
    }
    if (!env.ANTHROPIC_API_KEY) {
      return new Response('Configuration manquante : définis le secret ANTHROPIC_API_KEY.', { status: 500, headers: corsHeaders });
    }

    try {
      const rawBody = await request.text();
      if (rawBody.length > 350000) return new Response('Requête trop volumineuse.', { status: 413, headers: corsHeaders });
      const payload = JSON.parse(rawBody);
      if (!Array.isArray(payload.messages) || !payload.messages.length) {
        return new Response('Corps de requête invalide : messages requis.', { status: 400, headers: corsHeaders });
      }

      const systemPrompt = payload.messages
        .filter((message) => message && message.role === 'system')
        .map((message) => messageText(message.content))
        .filter(Boolean)
        .join('\n\n');

      const messages = payload.messages
        .filter((message) => message && message.role !== 'system')
        .map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: messageText(message.content)
        }))
        .filter((message) => message.content);

      if (!messages.length) {
        return new Response('Corps de requête invalide : aucun message utilisateur.', { status: 400, headers: corsHeaders });
      }

      const requestedModel = String(payload.model || '');
      const model = env.ANTHROPIC_MODEL || (requestedModel && !/^(gpt-|o[1-9]|chatgpt)/i.test(requestedModel)
        ? requestedModel
        : 'claude-haiku-5-5');
      const maxTokens = Math.min(Math.max(Number(payload.max_tokens) || 2500, 1), 4000);
      const upstreamPayload = {
        model,
        max_tokens: maxTokens,
        messages,
        temperature: typeof payload.temperature === 'number' ? Math.min(Math.max(payload.temperature, 0), 1) : 0.35
      };
      if (systemPrompt) upstreamPayload.system = systemPrompt;
      if (payload.response_format && payload.response_format.type === 'json_object') {
        upstreamPayload.system = `${upstreamPayload.system || ''}\n\nRéponds uniquement avec un objet JSON valide, sans balises Markdown ni texte avant ou après.`.trim();
      }

      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(upstreamPayload)
      });

      const upstreamText = await upstream.text();
      let anthropicResult;
      try { anthropicResult = JSON.parse(upstreamText); }
      catch (_) {
        return new Response(upstreamText || 'Réponse invalide reçue de Claude.', {
          status: upstream.status,
          headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
        });
      }

      if (!upstream.ok) {
        return jsonResponse({ error: { message: anthropicResult?.error?.message || 'Erreur renvoyée par l’API Claude.', type: anthropicResult?.error?.type || 'anthropic_error' } }, upstream.status, corsHeaders);
      }

      const content = Array.isArray(anthropicResult.content)
        ? anthropicResult.content.filter((block) => block && block.type === 'text').map((block) => block.text || '').join('\n')
        : '';
      const inputTokens = Number(anthropicResult.usage?.input_tokens) || 0;
      const outputTokens = Number(anthropicResult.usage?.output_tokens) || 0;
      return jsonResponse({
        id: anthropicResult.id || `claude-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: anthropicResult.model || model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: anthropicResult.stop_reason === 'max_tokens' ? 'length' : 'stop'
        }],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens
        }
      }, 200, corsHeaders);
    } catch (error) {
      return jsonResponse({ error: { message: 'Erreur du proxy Claude.', detail: String(error && error.message || error) } }, 500, corsHeaders);
    }
  }
};

/** Durable Object : état central versionné, utilisé par tous les appareils. */
export class MindMapSync {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.method === 'GET') {
      const document = await this.ctx.storage.get('document');
      return jsonResponse(document || { state: null, revision: 0, updatedAt: null });
    }
    if (request.method !== 'PUT') return jsonResponse({ error: 'Méthode non autorisée.' }, 405);

    let payload;
    try {
      const raw = await request.text();
      if (raw.length > 2000000) return jsonResponse({ error: 'La carte dépasse la taille autorisée (2 Mo).' }, 413);
      payload = JSON.parse(raw);
    } catch (_) {
      return jsonResponse({ error: 'JSON invalide.' }, 400);
    }
    if (!payload || !payload.state || !payload.state.root || !Array.isArray(payload.state.root.children) || !Array.isArray(payload.state.legend)) {
      return jsonResponse({ error: 'Structure de carte invalide.' }, 400);
    }

    const current = await this.ctx.storage.get('document');
    const currentRevision = current ? Number(current.revision) || 0 : 0;
    const baseRevision = Number(payload.baseRevision) || 0;
    if (current && baseRevision !== currentRevision) {
      return jsonResponse(current, 409);
    }

    const document = {
      state: payload.state,
      revision: currentRevision + 1,
      updatedAt: new Date().toISOString()
    };
    await this.ctx.storage.put('document', document);
    return jsonResponse(document);
  }
}
