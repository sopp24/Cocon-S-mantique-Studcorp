/**
 * Proxy IA STUDCORP pour Cloudflare Workers.
 * La clé OpenAI est fournie à l'environnement Worker via un secret,
 * jamais depuis le navigateur ni dans le dépôt GitHub.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowedOrigin = (env.ALLOWED_ORIGIN || '').trim();
    const requestOrigin = request.headers.get('Origin') || '';

    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin || 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };

    if (!allowedOrigin) {
      return new Response('Configuration manquante : définis le secret ALLOWED_ORIGIN.', { status: 500 });
    }
    if (requestOrigin !== allowedOrigin) {
      return new Response('Origine non autorisée.', { status: 403, headers: corsHeaders });
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      return new Response('Méthode ou chemin non autorisé.', { status: 405, headers: corsHeaders });
    }
    if (!env.OPENAI_API_KEY) {
      return new Response('Configuration manquante : définis le secret OPENAI_API_KEY.', { status: 500, headers: corsHeaders });
    }

    try {
      const rawBody = await request.text();
      if (rawBody.length > 350000) {
        return new Response('Requête trop volumineuse.', { status: 413, headers: corsHeaders });
      }
      const payload = JSON.parse(rawBody);
      if (!Array.isArray(payload.messages) || !payload.messages.length) {
        return new Response('Corps de requête invalide : messages requis.', { status: 400, headers: corsHeaders });
      }

      const model = env.OPENAI_MODEL || payload.model || 'gpt-4o-mini';
      const upstreamPayload = {
        ...payload,
        model,
        stream: false,
        max_tokens: Math.min(Number(payload.max_tokens) || 2500, 3000)
      };
      const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(upstreamPayload)
      });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: {
          ...corsHeaders,
          'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: { message: 'Erreur du proxy IA.', detail: String(error && error.message || error) } }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }
  }
};
