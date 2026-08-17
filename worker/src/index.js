const ARENA_DEFAULT_BASE = 'https://api.preview.arena.ai';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const WINDOW_MS = 60_000;
const buckets = new Map();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });
}

function splitCsv(value = '') {
  return String(value).split(',').map(v => v.trim()).filter(Boolean);
}

function originAllowed(origin, env) {
  if (!origin) return true;
  const allowed = splitCsv(env.ALLOWED_ORIGIN || env.ALLOWED_ORIGINS || '');
  if (!allowed.length) return false;
  return allowed.includes(origin);
}

function corsHeaders(origin, env) {
  const h = {
    'vary': 'Origin',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'Content-Type',
    'access-control-max-age': '86400'
  };
  if (originAllowed(origin, env) && origin) h['access-control-allow-origin'] = origin;
  return h;
}

function safeError(err) {
  const message = String(err?.message || err || 'Unknown error');
  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/x-api-key[^\s]*/gi, 'x-api-key [redacted]')
    .slice(0, 900);
}

function rateLimit(request, env) {
  const limit = Math.max(1, Number(env.REQUESTS_PER_MINUTE || 20));
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || now - bucket.start >= WINDOW_MS) {
    buckets.set(ip, { start: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now - v.start > WINDOW_MS * 2) buckets.delete(k);
  }
  return bucket.count <= limit;
}

function freePolicy(env, requestedModel) {
  const freeOnly = String(env.ARENA_FREE_ONLY ?? 'true').toLowerCase() !== 'false';
  const configured = String(env.ARENA_MODEL || '').trim();
  const model = String(requestedModel || configured || '').trim();
  if (!model) return { ok: false, freeOnly, error: 'No Arena model is configured. Set ARENA_MODEL in the Worker environment.' };

  const freeModels = splitCsv(env.ARENA_FREE_MODELS || '');
  if (freeOnly) {
    if (!freeModels.length) {
      return {
        ok: false,
        freeOnly,
        error: 'Free Only is enabled, but ARENA_FREE_MODELS is empty. Add only model IDs you have verified as free in your Arena account/portal.'
      };
    }
    if (!freeModels.includes(model)) {
      return { ok: false, freeOnly, error: `Model "${model}" is not in ARENA_FREE_MODELS. Free Only policy blocked the request.` };
    }
  }
  return { ok: true, freeOnly, model };
}

async function parseBody(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) throw new Error('Request body is too large.');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('Request body is too large.');
  let body;
  try { body = JSON.parse(text || '{}'); } catch { throw new Error('Request body must be valid JSON.'); }
  return body;
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('messages must be a non-empty array.');
  if (messages.length > 60) throw new Error('Too many messages.');
  return messages.map(m => {
    if (!m || !['user', 'assistant'].includes(m.role)) throw new Error('Each message must have role user or assistant.');
    const content = typeof m.content === 'string' ? m.content : m.content;
    if (typeof content !== 'string' && !Array.isArray(content)) throw new Error('Unsupported message content.');
    return { role: m.role, content };
  });
}

async function forwardArena(body, env, signal) {
  if (!env.ARENA_API_KEY) throw new Error('ARENA_API_KEY is not configured on the Worker.');
  const policy = freePolicy(env, body.model);
  if (!policy.ok) {
    const error = new Error(policy.error);
    error.status = 503;
    throw error;
  }

  const messages = validateMessages(body.messages);
  const payload = {
    model: policy.model,
    max_tokens: Math.min(Math.max(Number(body.max_tokens || 4096), 64), 16384),
    messages,
    stream: false
  };
  if (typeof body.system === 'string' && body.system.trim()) payload.system = body.system.slice(0, 120_000);
  if (typeof body.temperature === 'number') payload.temperature = Math.max(0, Math.min(1, body.temperature));

  const base = String(env.ARENA_API_BASE || ARENA_DEFAULT_BASE).replace(/\/$/, '');
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': env.ARENA_API_KEY
    },
    body: JSON.stringify(payload),
    signal
  });

  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 2000) }; }
  if (!response.ok) {
    const msg = parsed?.error?.message || parsed?.message || `Arena API returned HTTP ${response.status}`;
    const error = new Error(msg);
    error.status = response.status;
    throw error;
  }

  const blocks = Array.isArray(parsed?.content) ? parsed.content : [];
  const output = blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
  return {
    text: output,
    model: parsed?.model || policy.model,
    stop_reason: parsed?.stop_reason || null,
    usage: parsed?.usage || null,
    freeOnly: policy.freeOnly,
    usageNotice: 'Usage information unavailable from provider unless your Arena account/portal exposes it.'
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      if (!originAllowed(origin, env)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }

    if (!originAllowed(origin, env)) return json({ error: 'Origin not allowed.' }, 403, cors);

    if (url.pathname === '/health' && request.method === 'GET') {
      const freeOnly = String(env.ARENA_FREE_ONLY ?? 'true').toLowerCase() !== 'false';
      const freeModelsConfigured = splitCsv(env.ARENA_FREE_MODELS || '').length;
      return json({
        ok: true,
        provider: 'Arena.ai',
        apiBase: String(env.ARENA_API_BASE || ARENA_DEFAULT_BASE),
        keyConfigured: Boolean(env.ARENA_API_KEY),
        modelConfigured: Boolean(env.ARENA_MODEL),
        freeOnly,
        freeModelsConfigured,
        usageNotice: 'Usage information unavailable from provider unless your Arena account/portal exposes it.'
      }, 200, cors);
    }

    if (url.pathname === '/agent' && request.method === 'POST') {
      if (!rateLimit(request, env)) return json({ error: 'Too many requests. Try again in about a minute.' }, 429, cors);
      try {
        const body = await parseBody(request);
        const controller = new AbortController();
        const timeoutMs = Math.min(Math.max(Number(env.REQUEST_TIMEOUT_MS || 90_000), 5_000), 120_000);
        const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
        request.signal.addEventListener('abort', () => controller.abort('client aborted'), { once: true });
        try {
          const result = await forwardArena(body, env, controller.signal);
          return json(result, 200, cors);
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        const status = err?.name === 'AbortError' ? 504 : Number(err?.status || 500);
        return json({ error: safeError(err) }, status, cors);
      }
    }

    return json({ error: 'Not found.' }, 404, cors);
  }
};
