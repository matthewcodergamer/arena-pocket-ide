const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_DEFAULT_MODEL = 'gemini-2.5-pro';
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
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/x-goog-api-key[^\s]*/gi, 'x-goog-api-key [redacted]')
    .slice(0, 1200);
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
    for (const [key, value] of buckets) {
      if (now - value.start > WINDOW_MS * 2) buckets.delete(key);
    }
  }

  return bucket.count <= limit;
}

async function parseBody(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) throw new Error('Request body is too large.');

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('Request body is too large.');

  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function contentToText(content) {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return JSON.stringify(part);
    }).join('\n');
  }

  return String(content ?? '');
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error('messages must be a non-empty array.');
  }
  if (messages.length > 60) throw new Error('Too many messages.');

  return messages.map(message => {
    if (!message || !['user', 'assistant'].includes(message.role)) {
      throw new Error('Each message must have role user or assistant.');
    }

    const text = contentToText(message.content);
    if (!text.trim()) throw new Error('Message content cannot be empty.');

    return {
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text }]
    };
  });
}

function configuredModel(env) {
  // Intentionally use only the server-configured model.
  // This prevents a browser client from switching Crain onto a paid model.
  return String(env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL).trim();
}

async function forwardGemini(body, env, signal) {
  if (!env.GEMINI_API_KEY) {
    const error = new Error('GEMINI_API_KEY is not configured on the Worker.');
    error.status = 503;
    throw error;
  }

  const model = configuredModel(env);
  if (!model) {
    const error = new Error('No Gemini model is configured.');
    error.status = 503;
    throw error;
  }

  const contents = validateMessages(body.messages);

  const generationConfig = {
    maxOutputTokens: Math.min(Math.max(Number(body.max_tokens || 8192), 64), 16384),
    responseMimeType: 'application/json'
  };

  if (typeof body.temperature === 'number') {
    generationConfig.temperature = Math.max(0, Math.min(1, body.temperature));
  }

  const payload = {
    contents,
    generationConfig
  };

  if (typeof body.system === 'string' && body.system.trim()) {
    payload.systemInstruction = {
      parts: [{ text: body.system.slice(0, 120_000) }]
    };
  }

  const base = String(env.GEMINI_API_BASE || GEMINI_DEFAULT_BASE).replace(/\/$/, '');
  const endpoint = `${base}/models/${encodeURIComponent(model)}:generateContent`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY
    },
    body: JSON.stringify(payload),
    signal
  });

  const raw = await response.text();
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { raw: raw.slice(0, 3000) };
  }

  if (!response.ok) {
    const message =
      parsed?.error?.message ||
      parsed?.message ||
      `Gemini API returned HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const candidate = Array.isArray(parsed?.candidates) ? parsed.candidates[0] : null;
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const text = parts
    .filter(part => typeof part?.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim();

  if (!text) {
    const blockReason = parsed?.promptFeedback?.blockReason;
    const finishReason = candidate?.finishReason;
    const error = new Error(
      blockReason
        ? `Gemini blocked the request: ${blockReason}`
        : `Gemini returned no text${finishReason ? ` (finish reason: ${finishReason})` : ''}.`
    );
    error.status = 502;
    throw error;
  }

  return {
    text,
    model,
    stop_reason: candidate?.finishReason || null,
    usage: parsed?.usageMetadata || null,
    provider: 'Google Gemini',
    freeOnly: true,
    usageNotice: 'Crain is locked to the server-configured Gemini model. Free-tier quotas and availability are controlled by Google.'
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

    if (!originAllowed(origin, env)) {
      return json({ error: 'Origin not allowed.' }, 403, cors);
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({
        ok: true,
        provider: 'Google Gemini',
        model: configuredModel(env),
        keyConfigured: Boolean(env.GEMINI_API_KEY),
        modelConfigured: Boolean(configuredModel(env)),
        freeOnly: true,
        usageNotice: 'Free-tier quotas and availability are controlled by Google.'
      }, 200, cors);
    }

    if (url.pathname === '/agent' && request.method === 'POST') {
      if (!rateLimit(request, env)) {
        return json(
          { error: 'Too many requests. Try again in about a minute.' },
          429,
          cors
        );
      }

      try {
        const body = await parseBody(request);
        const controller = new AbortController();
        const timeoutMs = Math.min(
          Math.max(Number(env.REQUEST_TIMEOUT_MS || 90_000), 5_000),
          120_000
        );

        const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
        request.signal.addEventListener(
          'abort',
          () => controller.abort('client aborted'),
          { once: true }
        );

        try {
          const result = await forwardGemini(body, env, controller.signal);
          return json(result, 200, cors);
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        const status =
          err?.name === 'AbortError' ? 504 : Number(err?.status || 500);
        return json({ error: safeError(err) }, status, cors);
      }
    }

    return json({ error: 'Not found.' }, 404, cors);
  }
};
