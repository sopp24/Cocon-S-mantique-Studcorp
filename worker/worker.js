/**
 * Proxy IA et synchronisation partagée STUDCORP pour Cloudflare Workers.
 * La clé OpenAI reste côté serveur. Le Durable Object fournit un état commun
 * et versionné à tous les appareils qui utilisent la même URL de Worker.
 */
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
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

    // Proxy IA existant.
    if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      return new Response('Méthode ou chemin non autorisé.', { status: 405, headers: corsHeaders });
    }
    if (!env.OPENAI_API_KEY) return new Response('Configuration manquante : définis le secret OPENAI_API_KEY.', { status: 500, headers: corsHeaders });

    try {
      const rawBody = await request.text();
      if (rawBody.length > 350000) return new Response('Requête trop volumineuse.', { status: 413, headers: corsHeaders });
      const payload = JSON.parse(rawBody);
      if (!Array.isArray(payload.messages) || !payload.messages.length) {
        return new Response('Corps de requête invalide : messages requis.', { status: 400, headers: corsHeaders });
      }
      const model = env.OPENAI_MODEL || payload.model || 'gpt-4o-mini';
      const upstreamPayload = { ...payload, model, stream: false, max_tokens: Math.min(Number(payload.max_tokens) || 2500, 3000) };
      const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(upstreamPayload)
      });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { ...corsHeaders, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    } catch (error) {
      return jsonResponse({ error: { message: 'Erreur du proxy IA.', detail: String(error && error.message || error) } }, 500, corsHeaders);
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
    // Le contrôle de version évite qu’un appareil écrase silencieusement une
    // modification plus récente. Le navigateur fusionne alors les deux états.
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
