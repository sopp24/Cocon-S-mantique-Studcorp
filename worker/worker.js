/**
 * Proxy IA Google Gemini + synchronisation partagée STUDCORP.
 * La clé Gemini reste côté Cloudflare. Le Durable Object conserve un état
 * commun et versionné pour les appareils qui utilisent le même Worker.
 */
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
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

function toGeminiContents(messages) {
  const contents = [];
  for (const message of messages) {
    if (!message || message.role === 'system' || message.role === 'developer') continue;
    const text = messageText(message.content);
    if (!text) continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const previous = contents[contents.length - 1];
    // Gemini expects conversation turns to alternate. Merge adjacent turns
    // of the same role defensively instead of sending an invalid transcript.
    if (previous && previous.role === role) previous.parts[0].text += `\n\n${text}`;
    else contents.push({ role, parts: [{ text }] });
  }
  return contents;
}

function extractGeminiText(result) {
  const parts = result?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.filter((part) => typeof part?.text === 'string').map((part) => part.text).join('\n');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowedOrigin = (env.ALLOWED_ORIGIN || '').trim();
    const requestOrigin = request.headers.get('Origin') || '';
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin || 'null',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };

    if (!allowedOrigin) {
      return new Response('Configuration manquante : définis le secret ALLOWED_ORIGIN.', { status: 500 });
    }
    if (requestOrigin !== allowedOrigin) {
      return new Response('Origine non autorisée.', { status: 403, headers: corsHeaders });
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

    // API partagée de la carte mentale : GET charge, PUT sauvegarde.
    if (url.pathname === '/api/state') {
      if (!env.MINDMAP_SYNC) {
        return jsonResponse({ error: 'Le stockage partagé MINDMAP_SYNC n’est pas configuré.' }, 500, corsHeaders);
      }
      if (!['GET', 'PUT'].includes(request.method)) {
        return jsonResponse({ error: 'Méthode non autorisée.' }, 405, corsHeaders);
      }
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

    // L'application envoie déjà un format compatible OpenAI. Ce Worker le
    // convertit vers Gemini, puis reformate la réponse pour ne pas modifier app.js.
    if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      return new Response('Méthode ou chemin non autorisé.', { status: 405, headers: corsHeaders });
    }
    if (!env.GEMINI_API_KEY) {
      return jsonResponse({ error: { message: 'Configuration manquante : définis le secret GEMINI_API_KEY dans Cloudflare.' } }, 500, corsHeaders);
    }

    try {
      const rawBody = await request.text();
      if (rawBody.length > 350000) {
        return jsonResponse({ error: { message: 'Requête trop volumineuse.' } }, 413, corsHeaders);
      }
      const payload = JSON.parse(rawBody);
      if (!Array.isArray(payload.messages) || !payload.messages.length) {
        return jsonResponse({ error: { message: 'Corps de requête invalide : messages requis.' } }, 400, corsHeaders);
      }

      const systemInstruction = payload.messages
        .filter((message) => message && ['system', 'developer'].includes(message.role))
        .map((message) => messageText(message.content))
        .filter(Boolean)
        .join('\n\n');
      const contents = toGeminiContents(payload.messages);
      if (!contents.length || !contents.some((item) => item.role === 'user')) {
        return jsonResponse({ error: { message: 'Corps de requête invalide : aucun message utilisateur.' } }, 400, corsHeaders);
      }

      const requestedModel = String(payload.model || '');
      const safeRequestedModel = /^gemini-[a-z0-9._-]+$/i.test(requestedModel) ? requestedModel : '';
      const model = (env.GEMINI_MODEL || safeRequestedModel || 'gemini-3.8-flash').trim();
      const maxOutputTokens = Math.min(Math.max(Number(payload.max_tokens) || 2500, 1), 4000);

      const generationConfig = { maxOutputTokens };
      if (payload.response_format && payload.response_format.type === 'json_object') {
        generationConfig.responseMimeType = 'application/json';
      }

      const geminiPayload = { contents, generationConfig };
      if (systemInstruction) {
        geminiPayload.systemInstruction = { parts: [{ text: systemInstruction }] };
      }

      const upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': env.GEMINI_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(geminiPayload)
        }
      );

      const upstreamText = await upstream.text();
      let geminiResult;
      try {
        geminiResult = JSON.parse(upstreamText);
      } catch (_) {
        return jsonResponse({ error: { message: upstreamText || 'Réponse invalide reçue de Gemini.' } }, upstream.status || 502, corsHeaders);
      }

      if (!upstream.ok) {
        return jsonResponse({
          error: {
            message: geminiResult?.error?.message || 'Erreur renvoyée par l’API Gemini.',
            type: geminiResult?.error?.status || 'gemini_api_error'
          }
        }, upstream.status, corsHeaders);
      }

      const content = extractGeminiText(geminiResult);
      if (!content) {
        const blockReason = geminiResult?.promptFeedback?.blockReason || geminiResult?.candidates?.[0]?.finishReason;
        return jsonResponse({
          error: {
            message: blockReason
              ? `Gemini n’a pas produit de réponse (motif : ${blockReason}).`
              : 'Gemini a renvoyé une réponse vide. Réessaie avec une demande plus courte.',
            type: 'empty_gemini_response'
          }
        }, 502, corsHeaders);
      }

      const promptTokens = Number(geminiResult.usageMetadata?.promptTokenCount) || 0;
      const completionTokens = Number(geminiResult.usageMetadata?.candidatesTokenCount) || 0;
      return jsonResponse({
        id: `gemini-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: geminiResult.candidates?.[0]?.finishReason === 'MAX_TOKENS' ? 'length' : 'stop'
        }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens
        }
      }, 200, corsHeaders);
    } catch (error) {
      return jsonResponse({
        error: {
          message: 'Erreur du proxy Gemini.',
          detail: String(error && error.message || error)
        }
      }, 500, corsHeaders);
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
    if (current && baseRevision !== currentRevision) return jsonResponse(current, 409);

    const document = {
      state: payload.state,
      revision: currentRevision + 1,
      updatedAt: new Date().toISOString()
    };
    await this.ctx.storage.put('document', document);
    return jsonResponse(document);
  }
}
