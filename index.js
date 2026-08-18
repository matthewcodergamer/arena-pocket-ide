const MAX_BODY_BYTES = 2 * 1024 * 1024;
const WINDOW_MS = 60_000;
const MODEL_CACHE_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 90_000;
const buckets = new Map();
const modelCache = new Map();
const providerHealth = new Map();

const PROVIDERS = {
  groq: {
    label: 'Groq', secret: 'GROQ_API_KEY', kind: 'openai',
    base: 'https://api.groq.com/openai/v1', capabilities: ['text','code','tools']
  },
  openrouter: {
    label: 'OpenRouter', secret: 'OPENROUTER_API_KEY', kind: 'openai',
    base: 'https://openrouter.ai/api/v1', capabilities: ['text','code','tools','router']
  },
  bazaarlink: {
    label: 'BazaarLink', secret: 'BAZAARLINK_API_KEY', kind: 'openai',
    base: 'https://api.bazaarlink.ai/v1', capabilities: ['text','code','tools','router']
  },
  mistral: {
    label: 'Mistral', secret: 'MISTRAL_API_KEY', kind: 'openai',
    base: 'https://api.mistral.ai/v1', capabilities: ['text','code','tools']
  },
  sambanova: {
    label: 'SambaNova', secret: 'SAMBANOVA_API_KEY', kind: 'openai',
    base: 'https://api.sambanova.ai/v1', capabilities: ['text','code','tools']
  },
  gemini: {
    label: 'Google Gemini', secret: 'GEMINI_API_KEY', kind: 'gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta', capabilities: ['text','code']
  },
  cloudflare: {
    label: 'Cloudflare Workers AI', binding: 'AI', kind: 'cloudflare',
    capabilities: ['text','code']
  },
  runway: {
    label: 'Runway', secret: 'RUNWAY_API_KEY', kind: 'media',
    capabilities: ['image','video']
  }
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });
}
function splitCsv(value = '') { return String(value).split(',').map(v => v.trim()).filter(Boolean); }
function originAllowed(origin, env) {
  if (!origin) return true;
  const allowed = splitCsv(env.ALLOWED_ORIGIN || env.ALLOWED_ORIGINS || '');
  return allowed.length > 0 && allowed.includes(origin);
}
function corsHeaders(origin, env) {
  const h = {
    vary: 'Origin',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'Content-Type',
    'access-control-max-age': '86400'
  };
  if (originAllowed(origin, env) && origin) h['access-control-allow-origin'] = origin;
  return h;
}
function safeError(err) {
  return String(err?.message || err || 'Unknown error')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/x-goog-api-key[^\s]*/gi, 'x-goog-api-key [redacted]')
    .slice(0, 600);
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
    for (const [key, value] of buckets) if (now - value.start > WINDOW_MS * 2) buckets.delete(key);
  }
  return bucket.count <= limit;
}
async function parseBody(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
  try { return JSON.parse(text || '{}'); }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }); }
}
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : (part?.text ?? JSON.stringify(part))).join('\n');
  return String(content ?? '');
}
function normalizedMessages(messages, system = '') {
  if (!Array.isArray(messages) || !messages.length) throw Object.assign(new Error('messages must be a non-empty array.'), { status: 400 });
  const out = [];
  if (system?.trim()) out.push({ role: 'system', content: system.slice(0, 120_000) });
  for (const message of messages.slice(-60)) {
    if (!message || !['user','assistant','system'].includes(message.role)) continue;
    const text = contentToText(message.content);
    if (text.trim()) out.push({ role: message.role, content: text });
  }
  if (!out.some(m => m.role === 'user')) throw Object.assign(new Error('A user message is required.'), { status: 400 });
  return out;
}
function isConfigured(id, env) {
  const p = PROVIDERS[id];
  if (!p) return false;
  if (p.binding) return Boolean(env[p.binding]);
  if (p.secret) return Boolean(env[p.secret]);
  return false;
}
function providerBase(id, env) {
  const names = {
    groq: 'GROQ_API_BASE', openrouter: 'OPENROUTER_API_BASE', mistral: 'MISTRAL_API_BASE',
    sambanova: 'SAMBANOVA_API_BASE', bazaarlink: 'BAZAARLINK_API_BASE', gemini: 'GEMINI_API_BASE'
  };
  return String(env[names[id]] || PROVIDERS[id]?.base || '').replace(/\/$/, '');
}
function configuredDefaultModel(id, env) {
  const names = {
    groq: 'GROQ_MODEL', openrouter: 'OPENROUTER_MODEL', mistral: 'MISTRAL_MODEL',
    sambanova: 'SAMBANOVA_MODEL', bazaarlink: 'BAZAARLINK_MODEL', gemini: 'GEMINI_MODEL', cloudflare: 'CLOUDFLARE_MODEL'
  };
  const defaults = {
    openrouter: 'openrouter/free',
    bazaarlink: 'auto:free',
    sambanova: 'MiniMax-M2.7',
    cloudflare: '@cf/openai/gpt-oss-20b'
  };
  return String(env[names[id]] || defaults[id] || '').trim();
}
function classifyFailure(status, message = '') {
  const s = String(message).toLowerCase();
  if (status === 401 || /invalid api key|unauthorized|authentication/.test(s)) return 'auth';
  if (status === 402 || /insufficient[_ ]funds|credit|billing|payment required/.test(s)) return 'credits';
  if (status === 429 || /quota|rate limit|resource_exhausted|too many requests/.test(s)) return 'quota';
  if ([500,502,503,504].includes(status) || /busy|overload|high demand|temporar|unavailable|timeout/.test(s)) return 'busy';
  return 'error';
}
function cooldownMs(kind){
  if(kind==='credits')return 60*60_000;
  if(kind==='auth')return 15*60_000;
  if(kind==='quota')return 2*60_000;
  if(kind==='busy')return 30_000;
  return 10_000;
}
function modelBadForCoding(id = '') {
  return /embed|embedding|rerank|guard|moderation|speech|audio|whisper|tts|image|video|vision-only/i.test(id);
}
function modelScore(model) {
  const id = String(model.id || '').toLowerCase();
  let score = 0;
  if (modelBadForCoding(id)) return -1000;
  if (/coder|code|devstral|codestral/.test(id)) score += 120;
  if (/gpt-oss-120b/.test(id)) score += 115;
  else if (/gpt-oss/.test(id)) score += 100;
  if (/qwen.*coder/.test(id)) score += 110;
  if (/reason|r1|deepseek/.test(id)) score += 70;
  if (/llama.*70|llama.*90|llama.*405/.test(id)) score += 65;
  if (/mistral-large|magistral/.test(id)) score += 60;
  if (/flash/.test(id)) score += 35;
  if (/mini|small|nano|8b/.test(id)) score += 10;
  if (model.free === true) score += 35;
  if (model.provider === 'groq') score += 22;
  if (model.provider === 'sambanova') score += 18;
  if (model.provider === 'mistral') score += 14;
  if (model.provider === 'gemini') score += 12;
  if (model.provider === 'bazaarlink') score += 28;
  if (model.provider === 'openrouter') score += 8;
  return score;
}
function normalizeModel(provider, raw) {
  const id = String(raw?.id || raw?.name || '').replace(/^models\//, '');
  if (!id) return null;
  let free = null;
  if (provider === 'openrouter') {
    const pricing = raw?.pricing || {};
    const prompt = Number(pricing.prompt ?? NaN), completion = Number(pricing.completion ?? NaN);
    free = id.endsWith(':free') || id === 'openrouter/free' || (Number.isFinite(prompt) && Number.isFinite(completion) && prompt === 0 && completion === 0);
  }
  if (provider === 'bazaarlink') free = id === 'auto:free' || id.endsWith(':free');
  return {
    id, provider, name: raw?.name || id,
    context: raw?.context_length || raw?.context || raw?.max_context_length || null,
    free,
    capabilities: raw?.capabilities || raw?.architecture || null
  };
}
async function fetchJsonWithTimeout(url, init = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('probe timeout'), timeoutMs);
  if (init.signal) init.signal.addEventListener('abort', () => controller.abort('parent aborted'), { once: true });
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    let data; try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 1000) }; }
    return { response, data };
  } finally { clearTimeout(timer); }
}
async function listModels(provider, env, force = false) {
  if (!PROVIDERS[provider] || !isConfigured(provider, env) || PROVIDERS[provider].kind === 'media') return [];
  const cached = modelCache.get(provider);
  if (!force && cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.models;
  let models = [];
  try {
    if (PROVIDERS[provider].kind === 'openai') {
      const key = env[PROVIDERS[provider].secret];
      const url = `${providerBase(provider, env)}/models${provider === 'openrouter' ? '?output_modalities=text' : ''}`;
      const { response, data } = await fetchJsonWithTimeout(url, { headers: { authorization: `Bearer ${key}` } });
      if (!response.ok) throw Object.assign(new Error(data?.error?.message || data?.message || `HTTP ${response.status}`), { status: response.status });
      const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
      models = rows.map(row => normalizeModel(provider, row)).filter(Boolean);
      if (provider === 'openrouter' && !models.some(m => m.id === 'openrouter/free')) models.unshift({ id: 'openrouter/free', provider, name: 'OpenRouter Free Router', free: true, context: null });
      if (provider === 'bazaarlink' && !models.some(m => m.id === 'auto:free')) models.unshift({ id: 'auto:free', provider, name: 'BazaarLink Auto Free', free: true, context: null });
    } else if (provider === 'gemini') {
      const { response, data } = await fetchJsonWithTimeout(`${providerBase(provider, env)}/models`, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
      if (!response.ok) throw Object.assign(new Error(data?.error?.message || `HTTP ${response.status}`), { status: response.status });
      models = (data?.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(row => normalizeModel(provider, { ...row, id: row.name }));
    } else if (provider === 'cloudflare') {
      models = [{ id: configuredDefaultModel('cloudflare', env), provider: 'cloudflare', name: configuredDefaultModel('cloudflare', env), free: null }].filter(m => m.id);
    }
    const fallback = configuredDefaultModel(provider, env);
    if (fallback && !models.some(m => m.id === fallback)) models.unshift({ id: fallback, provider, name: fallback, free: (provider === 'openrouter' && fallback === 'openrouter/free') || (provider === 'bazaarlink' && fallback === 'auto:free') });
    modelCache.set(provider, { at: Date.now(), models });
    {const prev=providerHealth.get(provider)||{};providerHealth.set(provider, { ...prev, catalogOk:true, at:Date.now(), modelCount:models.length, ok:prev.cooldownUntil>Date.now()?false:true });}
    return models;
  } catch (err) {
    {const kind=classifyFailure(Number(err?.status||0),err?.message);providerHealth.set(provider,{ok:false,catalogOk:false,at:Date.now(),error:safeError(err),kind,cooldownUntil:Date.now()+cooldownMs(kind)});}
    const fallback = configuredDefaultModel(provider, env);
    return fallback ? [{ id: fallback, provider, name: fallback, free: (provider === 'openrouter' && fallback === 'openrouter/free') || (provider === 'bazaarlink' && fallback === 'auto:free') }] : [];
  }
}
async function providerSnapshot(env, probe = false) {
  const ids = Object.keys(PROVIDERS);
  if (probe) await Promise.allSettled(ids.filter(id => isConfigured(id, env) && PROVIDERS[id].kind !== 'media').map(id => listModels(id, env, true)));
  return ids.map(id => {
    const p = PROVIDERS[id], h = providerHealth.get(id);
    return {
      id, label: p.label, configured: isConfigured(id, env), kind: p.kind,
      capabilities: p.capabilities,
      status: !isConfigured(id, env) ? 'not_configured' : (h ? (h.cooldownUntil>Date.now() ? h.kind || 'cooldown' : (h.catalogOk===false ? h.kind || 'error' : 'ready')) : 'configured'),
      modelCount: h?.modelCount ?? null,
      lastChecked: h?.at ?? null,
      cooldownUntil: h?.cooldownUntil ?? null
    };
  });
}
async function allTextModels(env, force = false) {
  const ids = Object.keys(PROVIDERS).filter(id => isConfigured(id, env) && ['openai','gemini','cloudflare'].includes(PROVIDERS[id].kind));
  const groups = await Promise.all(ids.map(id => listModels(id, env, force)));
  return groups.flat().filter(m => !modelBadForCoding(m.id));
}
function extractOpenAIText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map(p => p?.text || p?.content || '').join('\n').trim();
  return '';
}
async function callOpenAICompatible(provider, model, body, env, signal) {
  const p = PROVIDERS[provider];
  const key = env[p.secret];
  const messages = normalizedMessages(body.messages, body.system);
  const payload = {
    model,
    messages,
    max_tokens: Math.min(Math.max(Number(body.max_tokens || 8192), 64), 16384),
    temperature: typeof body.temperature === 'number' ? Math.max(0, Math.min(1, body.temperature)) : 0.2
  };
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  if (provider === 'openrouter') {
    headers['X-Title'] = 'X Coder';
    headers['HTTP-Referer'] = env.ALLOWED_ORIGIN || 'https://matthewcodergamer.github.io';
  }
  if (provider === 'bazaarlink') {
    headers['X-Title'] = 'X Coder';
    headers['HTTP-Referer'] = env.ALLOWED_ORIGIN || 'https://matthewcodergamer.github.io';
    // BazaarLink documents this header to prevent a free-route request from falling through to paid balance.
    if (String(env.FREE_ONLY || 'true').toLowerCase() !== 'false') headers['X-Free-Fallback'] = 'false';
  }
  const response = await fetch(`${providerBase(provider, env)}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(payload), signal });
  const raw = await response.text();
  let data; try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 1600) }; }
  if (!response.ok) throw Object.assign(new Error(data?.error?.message || data?.message || `${p.label} HTTP ${response.status}`), { status: response.status });
  const text = extractOpenAIText(data);
  if (!text) throw Object.assign(new Error(`${p.label} returned no text.`), { status: 502 });
  return { text, usage: data?.usage || null, stop_reason: data?.choices?.[0]?.finish_reason || null };
}
async function callGemini(model, body, env, signal) {
  const source = normalizedMessages(body.messages, '');
  const contents = source.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }]
  }));
  const payload = {
    contents,
    generationConfig: {
      maxOutputTokens: Math.min(Math.max(Number(body.max_tokens || 8192), 64), 16384),
      temperature: typeof body.temperature === 'number' ? Math.max(0, Math.min(1, body.temperature)) : 0.2,
      responseMimeType: 'application/json'
    }
  };
  if (body.system?.trim()) payload.systemInstruction = { parts: [{ text: body.system.slice(0, 120_000) }] };
  const response = await fetch(`${providerBase('gemini', env)}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify(payload), signal
  });
  const raw = await response.text();
  let data; try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 1600) }; }
  if (!response.ok) throw Object.assign(new Error(data?.error?.message || `Gemini HTTP ${response.status}`), { status: response.status });
  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts || []).map(p => p?.text || '').join('\n').trim();
  if (!text) throw Object.assign(new Error('Gemini returned no text.'), { status: 502 });
  return { text, usage: data?.usageMetadata || null, stop_reason: candidate?.finishReason || null };
}
async function callCloudflare(model, body, env) {
  if (!env.AI) throw Object.assign(new Error('Workers AI binding is not configured.'), { status: 503 });
  const messages = normalizedMessages(body.messages, body.system);
  const data = await env.AI.run(model, { messages, max_tokens: Math.min(Math.max(Number(body.max_tokens || 8192), 64), 8192), temperature: 0.2 });
  const text = typeof data?.response === 'string' ? data.response.trim() : (typeof data === 'string' ? data.trim() : '');
  if (!text) throw Object.assign(new Error('Workers AI returned no text.'), { status: 502 });
  return { text, usage: data?.usage || null, stop_reason: null };
}
async function callProvider(provider, model, body, env, signal) {
  if (PROVIDERS[provider]?.kind === 'openai') return callOpenAICompatible(provider, model, body, env, signal);
  if (provider === 'gemini') return callGemini(model, body, env, signal);
  if (provider === 'cloudflare') return callCloudflare(model, body, env);
  throw Object.assign(new Error('Provider cannot handle text chat.'), { status: 400 });
}
async function autoCandidates(env) {
  const models = await allTextModels(env, false);
  const freePreferred = String(env.FREE_ONLY || 'true').toLowerCase() !== 'false';
  const filtered = models.filter(m => {
    const health=providerHealth.get(m.provider);if(health?.cooldownUntil>Date.now())return false;
    if (m.provider === 'gemini') return m.id === configuredDefaultModel('gemini', env);
    if (m.provider === 'openrouter') return !freePreferred || m.free === true || m.id === 'openrouter/free';
    if (m.provider === 'bazaarlink') return !freePreferred || m.free === true || m.id === 'auto:free';
    return true;
  });
  const sorted = filtered.sort((a,b) => modelScore(b) - modelScore(a));
  const picked = [];
  const seenProviders = new Set();
  // Broad free routers are intentionally first because they can choose a healthy model internally.
  if (isConfigured('bazaarlink', env)) { picked.push({ provider:'bazaarlink', id:'auto:free', name:'BazaarLink Auto Free', free:true }); seenProviders.add('bazaarlink'); }
  if (isConfigured('openrouter', env)) { picked.push({ provider:'openrouter', id:'openrouter/free', name:'OpenRouter Free Router', free:true }); seenProviders.add('openrouter'); }
  for (const m of sorted) {
    if (seenProviders.has(m.provider)) continue;
    picked.push(m); seenProviders.add(m.provider);
    if (picked.length >= 8) break;
  }
  return picked;
}
async function routeRequest(body, env, signal) {
  const requestedProvider = String(body.provider || '').trim().toLowerCase();
  const requestedModel = String(body.model || '').trim();
  const allowFallback = body.allow_fallback !== false;
  const candidates = [];
  if (requestedProvider && requestedProvider !== 'auto' && requestedProvider !== 'puter' && isConfigured(requestedProvider, env)) {
    const model = requestedModel || configuredDefaultModel(requestedProvider, env) || (await listModels(requestedProvider, env))[0]?.id;
    if (model) candidates.push({ provider: requestedProvider, id: model, name: model });
  } else if (requestedModel && !requestedProvider) {
    const all = await allTextModels(env, false);
    const found = all.find(m => m.id === requestedModel);
    if (found) candidates.push(found);
  }
  if (allowFallback) {
    for (const c of await autoCandidates(env)) if (!candidates.some(x => x.provider === c.provider && x.id === c.id)) candidates.push(c);
  }
  if (!candidates.length) throw Object.assign(new Error('No configured text AI providers are available.'), { status: 503 });

  const maxAttempts = Math.min(Math.max(Number(env.MAX_ROUTE_ATTEMPTS || 8), 1), 10);
  const attempts = [];
  for (const c of candidates.slice(0, maxAttempts)) {
    let providerTry = 0;
    while (providerTry < 2) {
      const started = Date.now();
      try {
        const result = await callProvider(c.provider, c.id, body, env, signal);
        const latencyMs = Date.now() - started;
        providerHealth.set(c.provider, { ...(providerHealth.get(c.provider)||{}), ok:true, catalogOk:true, at:Date.now(), latencyMs, kind:null, error:null, cooldownUntil:0, modelCount:providerHealth.get(c.provider)?.modelCount ?? null });
        attempts.push({ provider: c.provider, model: c.id, ok: true, latencyMs, retry: providerTry });
        return {
          ...result,
          provider: PROVIDERS[c.provider].label,
          providerId: c.provider,
          model: c.id,
          attempts,
          route: attempts.map(a => `${a.provider}:${a.model}`),
          fallbackUsed: attempts.length > 1
        };
      } catch (err) {
        const status = Number(err?.status || 500);
        const kind = classifyFailure(status, err?.message);
        const latencyMs = Date.now() - started;
        attempts.push({ provider: c.provider, model: c.id, ok: false, status, kind, latencyMs, retry: providerTry });
        if (signal?.aborted) throw err;
        // Retry one time only for temporary server/capacity failures. Quota, credits and auth move on immediately.
        if (providerTry === 0 && kind === 'busy') {
          providerTry += 1;
          await sleep(450 + Math.floor(Math.random()*250));
          continue;
        }
        providerHealth.set(c.provider, { ...(providerHealth.get(c.provider)||{}), ok:false, at:Date.now(), latencyMs, kind, error:safeError(err), cooldownUntil:Date.now()+cooldownMs(kind) });
        break;
      }
    }
  }
  const brief=attempts.map(a=>`${a.provider}/${a.model}: ${a.kind||a.status||'failed'}`).join(' → ');
  const err = new Error(`Every configured AI route was unavailable${brief?`. Tried ${brief}`:''}.`);
  err.status = 503; err.attempts = attempts; throw err;
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
      const providers = await providerSnapshot(env, false);
      return json({
        ok: providers.some(p => p.configured && p.kind !== 'media'), product: 'X Coder', mode: 'multi-provider-router',
        providers, configuredProviders: providers.filter(p => p.configured).map(p => p.id),
        freePreferred: String(env.FREE_ONLY || 'true').toLowerCase() !== 'false'
      }, 200, cors);
    }
    if (url.pathname === '/providers' && request.method === 'GET') {
      const probe = ['1','true','yes'].includes(String(url.searchParams.get('probe') || '').toLowerCase());
      return json({ providers: await providerSnapshot(env, probe), checked: probe }, 200, cors);
    }
    if (url.pathname === '/models' && request.method === 'GET') {
      const force = ['1','true','yes'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());
      const models = await allTextModels(env, force);
      return json({ models: models.sort((a,b) => modelScore(b)-modelScore(a)), providers: await providerSnapshot(env, false) }, 200, cors);
    }
    if ((url.pathname === '/agent' || url.pathname === '/chat') && request.method === 'POST') {
      if (!rateLimit(request, env)) return json({ error: 'X Coder is receiving too many requests. Please wait a moment.' }, 429, cors);
      try {
        const body = await parseBody(request);
        const controller = new AbortController();
        const timeoutMs = Math.min(Math.max(Number(env.REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS), 8_000), 120_000);
        const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
        request.signal.addEventListener('abort', () => controller.abort('client aborted'), { once: true });
        try { return json(await routeRequest(body, env, controller.signal), 200, cors); }
        finally { clearTimeout(timer); }
      } catch (err) {
        const status = err?.name === 'AbortError' ? 504 : Number(err?.status || 500);
        return json({ error: safeError(err), attempts: err?.attempts || [] }, status, cors);
      }
    }
    return json({ error: 'Not found.' }, 404, cors);
  }
};
