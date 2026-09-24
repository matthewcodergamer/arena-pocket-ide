// X Coder AI model catalog + routing.
//
//   catalog.refresh({ force }) → Promise<void>   Worker GET /models + /health and Puter listModels (cached 5 min)
//   catalog.list() → [{ id, label, description, group, provider, source: 'auto'|'worker'|'puter', vision, context }]
//   catalog.current() → selection id (settings 'xcoder.ai.model'; X Coder 5 values are migrated)
//   catalog.status() → { worker: 'ready'|'unreachable'|'unconfigured'|'loading', puter: 'signed-in'|'signed-out'|'unavailable',
//                        providers: [...], models: {worker, puter}, routerUrl, capabilities, error }
//   catalog.onChange(fn) → disposer
//   catalog.resolveRoutes(selection, { vision }) → ordered routes for automatic failover
//
// Selection ids: 'auto', 'worker:auto', 'worker:<provider>:auto', 'worker:<provider>:<model>', 'puter:auto', 'puter:<model>'.
// X Coder 5 ids ('puter-auto', 'worker|<provider>|<encodedModel>', 'puter|<provider>|<encodedModel>') are still understood.

import { settings } from '../core/settings.js';
import { getPuter, puterSignedIn } from '../core/puter.js';
import { Emitter } from '../core/events.js';
import { fetchWorkerJSON, cleanRouterUrl } from './providers.js';

export const DEFAULT_ROUTER = 'https://arena-pocket-ide-proxy.hrhw55tdmw.workers.dev';
const TTL = 5 * 60 * 1000;
const DEFAULT_CONTEXT = 32000;

const events = new Emitter();
const state = {
  worker: { status: 'unconfigured', models: [], providers: [], health: null, error: '', url: '' },
  puter: { status: 'unavailable', models: [], error: '' },
  loadedAt: 0,
  loading: null
};

// ------------------------------------------------------------------ selection ids

export function normalizeSelection(value) {
  let v = String(value ?? '').trim();
  if (!v || v === 'auto') return 'auto';
  if (v === 'puter-auto') return 'puter:auto';
  if (v.includes('|')) {
    const [source, provider = '', enc = ''] = v.split('|');
    let model = enc;
    try { model = decodeURIComponent(enc); } catch {}
    if (source === 'worker') return model ? `worker:${provider || 'auto'}:${model}` : provider && provider !== 'auto' ? `worker:${provider}:auto` : 'worker:auto';
    if (source === 'puter') return model ? `puter:${model}` : 'puter:auto';
    return 'auto';
  }
  return v;
}

export function parseSelection(id) {
  const v = normalizeSelection(id);
  if (v === 'auto') return { source: 'auto' };
  if (v.startsWith('worker:')) {
    const rest = v.slice(7);
    if (rest === 'auto' || !rest) return { source: 'worker', provider: 'auto', model: '' };
    const i = rest.indexOf(':');
    if (i < 0) return { source: 'worker', provider: rest, model: '' };
    const provider = rest.slice(0, i), model = rest.slice(i + 1);
    return { source: 'worker', provider, model: model === 'auto' ? '' : model };
  }
  if (v.startsWith('puter:')) {
    const model = v.slice(6);
    return { source: 'puter', model: model === 'auto' ? '' : model };
  }
  return { source: 'auto' };
}

// ------------------------------------------------------------------ model knowledge

const NON_CHAT = /embed|tts|whisper|dall-?e|gpt-image|image-gen|imagen|audio|realtime|moderation|transcri|speech|rerank|guard|sora|veo|flux|stable-diffusion|sdxl|midjourney|computer-use|search-preview|ocr/i;

const VENDORS = [
  [/claude|anthropic/i, 'Anthropic', 'Claude'],
  [/gpt|openai|\bo[134](-|$)|codex/i, 'OpenAI', 'GPT'],
  [/gemini|gemma|google/i, 'Google', 'Gemini'],
  [/grok|x-?ai/i, 'xAI', 'Grok'],
  [/deepseek/i, 'DeepSeek', 'DeepSeek'],
  [/qwen|alibaba/i, 'Qwen', 'Qwen'],
  [/kimi|moonshot/i, 'Moonshot', 'Kimi'],
  [/glm|zhipu|z-ai/i, 'Zhipu', 'GLM'],
  [/llama|meta/i, 'Meta', 'Llama'],
  [/mistral|codestral|devstral|pixtral|magistral/i, 'Mistral', 'Mistral'],
  [/minimax/i, 'MiniMax', 'MiniMax'],
  [/nova|amazon/i, 'Amazon', 'Nova']
];
export function vendorOf(id = '') {
  for (const [re, vendor, family] of VENDORS) if (re.test(id)) return { vendor, family };
  return { vendor: 'Other', family: String(id).split(/[/:-]/)[0] || 'Model' };
}

function versionOf(id, family) {
  // "claude-opus-4-1" → 4.1, "claude-opus-4-20250514" → 4 (a date is not a minor version)
  const m = new RegExp(`${family}[^0-9]{0,12}(\\d+)(?:[.-](\\d)(?!\\d))?`, 'i').exec(id);
  if (!m) return 0;
  return Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0);
}

/** Coding-strength heuristic used to rank models (higher = stronger). */
export function codingScore(rawId = '', name = '') {
  const id = `${rawId} ${name}`.toLowerCase();
  let s = 50;
  if (/claude/.test(id)) {
    const v = versionOf(id, '(?:opus|sonnet|haiku|claude)');
    if (/opus/.test(id)) s = 100 + (v - 4) * 4;
    else if (/sonnet/.test(id)) s = 96 + (v - 4) * 4;
    else if (/haiku/.test(id)) s = 72 + (v - 4) * 3;
    else s = 80;
  } else if (/gpt-5|gpt5/.test(id)) {
    const minor = (/gpt-?5[.-](\d)/.exec(id) || [])[1];
    s = 97 + (minor ? Number(minor) * 0.8 : 0);
    if (/codex/.test(id)) s += 1;
    if (/mini/.test(id)) s -= 14; else if (/nano/.test(id)) s -= 28;
    if (/chat-latest|chat/.test(id)) s -= 3;
  } else if (/\bo3\b|o3-|\bo4\b|o4-/.test(id)) s = /mini/.test(id) ? 84 : 90;
  else if (/gpt-4\.1/.test(id)) s = /mini|nano/.test(id) ? 70 : 82;
  else if (/gpt-4o/.test(id)) s = /mini/.test(id) ? 66 : 76;
  else if (/gemini/.test(id)) {
    const v = versionOf(id, 'gemini');
    s = /pro/.test(id) ? 85 + (v - 2) * 12 : /flash-lite|lite/.test(id) ? 66 + (v - 2) * 3 : /flash/.test(id) ? 78 + (v - 2) * 4 : 70;
  } else if (/grok/.test(id)) {
    const v = versionOf(id, 'grok');
    s = /code/.test(id) ? 86 : 78 + (v - 3) * 10;
    if (/mini|fast/.test(id) && !/code/.test(id)) s -= 8;
  } else if (/deepseek/.test(id)) s = /r1|reason/.test(id) ? 85 : /v3|chat/.test(id) ? 86 : 78;
  else if (/qwen/.test(id)) s = /coder/.test(id) ? (/480|plus|max/.test(id) ? 89 : 84) : /qwen-?3/.test(id) ? 80 : 68;
  else if (/kimi|moonshot/.test(id)) s = /k2/.test(id) ? 87 : 74;
  else if (/glm/.test(id)) s = /4\.[5-9]|5/.test(id) ? 85 : 72;
  else if (/llama/.test(id)) s = /llama-?4/.test(id) ? (/maverick/.test(id) ? 78 : 72) : /70b|405b/.test(id) ? 66 : 55;
  else if (/devstral|codestral/.test(id)) s = 80;
  else if (/mistral|magistral/.test(id)) s = /large|medium/.test(id) ? 75 : 60;
  else if (/minimax/.test(id)) s = 80;
  if (/\b(\d{1,2})b\b/.test(id) && Number(/\b(\d{1,2})b\b/.exec(id)[1]) < 30) s -= 10;
  if (/:free\b/.test(id)) s -= 1;
  if (/^(openrouter|togetherai|together|fireworks|groq|deepinfra):/i.test(rawId) || rawId.includes('/')) s -= 3; // prefer native routes
  if (/preview|exp/.test(id)) s -= 0.5;
  return s;
}

export function guessVision(id = '') {
  const s = id.toLowerCase();
  if (/embed|tts|audio|whisper/.test(s)) return false;
  return /claude|gpt-4o|gpt-4\.1|gpt-5|\bo[34](-|\b)|gemini|grok-4|grok-2-vision|llama-4|qwen[\w.-]*vl|pixtral|vision|mistral-(medium|small)-3|nova-(pro|lite)/.test(s);
}
export function supportsReasoning(id = '') {
  const s = id.toLowerCase().replace(/^[a-z-]+:/, '').replace(/^openai\//, '');
  return /^(gpt-5|o1|o3|o4)/.test(s) && !/chat-latest/.test(s);
}
function guessContext(id = '') {
  const s = id.toLowerCase();
  if (/gemini|gpt-4\.1|llama-4/.test(s)) return 1000000;
  if (/gpt-5/.test(s)) return 400000;
  if (/claude|o3|o4/.test(s)) return 200000;
  if (/grok-4|qwen.*coder|kimi-k2/.test(s)) return 256000;
  if (/deepseek|gpt-4o|glm|mistral|qwen/.test(s)) return 128000;
  return 128000;
}
function prettyName(id) {
  const base = String(id).replace(/^[a-z-]+:/i, '').split('/').pop();
  return base.replace(/[-_]/g, ' ').replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\bGpt\b/g, 'GPT').replace(/\bAi\b/g, 'AI').replace(/(\d) (\d)/g, '$1.$2');
}

function normalizePuterModel(raw) {
  const id = String(typeof raw === 'string' ? raw : raw?.id || raw?.model || raw?.name || '').trim();
  if (!id || NON_CHAT.test(id)) return null;
  const name = typeof raw === 'object' && raw?.name && raw.name !== id ? String(raw.name) : prettyName(id);
  const provider = String((typeof raw === 'object' && (raw.provider || raw.vendor)) || vendorOf(id).vendor);
  const context = Number((typeof raw === 'object' && (raw.context || raw.context_window || raw.contextWindow || raw.max_context || raw.max_input_tokens)) || 0) || guessContext(id);
  const vision = typeof raw === 'object' && typeof raw.vision === 'boolean' ? raw.vision
    : Array.isArray(raw?.modalities?.input) ? raw.modalities.input.includes('image') : guessVision(id);
  return { id, name, provider, context, vision, score: codingScore(id, name), reasoning: supportsReasoning(id) };
}

function normalizeWorkerModel(raw) {
  const id = String(raw?.id || '').trim();
  if (!id) return null;
  return {
    id, name: String(raw.name || id), provider: String(raw.provider || 'auto'),
    context: Number(raw.context) || DEFAULT_CONTEXT, free: raw.free === true,
    vision: typeof raw.vision === 'boolean' ? raw.vision : guessVision(id)
  };
}

// ------------------------------------------------------------------ loading

function emit() { events.emit('change', catalog.status()); }

async function loadWorker(force) {
  const url = cleanRouterUrl(settings.get('xcoder.ai.routerUrl', DEFAULT_ROUTER));
  const w = state.worker;
  w.url = url;
  if (!url) { Object.assign(w, { status: 'unconfigured', models: [], providers: [], health: null, error: 'No router URL is set.' }); return; }
  w.status = 'loading';
  const [models, health] = await Promise.allSettled([
    fetchWorkerJSON(url, `/models${force ? '?refresh=1' : ''}`, { timeoutMs: 15000 }),
    fetchWorkerJSON(url, '/health', { timeoutMs: 10000 })
  ]);
  if (url !== cleanRouterUrl(settings.get('xcoder.ai.routerUrl', DEFAULT_ROUTER))) return; // changed meanwhile
  w.health = health.status === 'fulfilled' ? health.value : null;
  if (models.status === 'fulfilled') {
    const data = models.value || {};
    w.models = (Array.isArray(data.models) ? data.models : []).map(normalizeWorkerModel).filter(Boolean);
    w.providers = Array.isArray(data.providers) ? data.providers : (Array.isArray(w.health?.providers) ? w.health.providers : []);
    const usable = w.providers.filter(p => p.configured !== false && p.kind !== 'media');
    w.status = usable.length || w.models.length ? 'ready' : 'unreachable';
    w.error = w.status === 'ready' ? '' : 'The router has no configured text providers.';
  } else {
    w.models = []; w.providers = w.health?.providers || [];
    w.status = w.health ? 'ready' : 'unreachable';
    w.error = models.reason?.message || 'The router could not be reached.';
  }
}

async function loadPuter(force) {
  const p = state.puter;
  let puter = window.puter || null;
  if (!puter) puter = await getPuter(force ? 8000 : 4000).catch(() => null);
  if (!puter?.ai) { Object.assign(p, { status: 'unavailable', models: [], error: 'The Puter library could not load (offline or blocked).' }); return; }
  if (!puterSignedIn()) { Object.assign(p, { status: 'signed-out', models: [], error: '' }); return; }
  p.status = 'signed-in';
  if (!force && p.models.length) return;
  try {
    const list = await Promise.race([puter.ai.listModels(), new Promise((_, rej) => setTimeout(() => rej(new Error('Puter model list timed out')), 12000))]);
    const arr = Array.isArray(list) ? list : Array.isArray(list?.models) ? list.models : [];
    const seen = new Set();
    p.models = arr.map(normalizePuterModel).filter(m => m && !seen.has(m.id) && seen.add(m.id)).sort((a, b) => b.score - a.score);
    p.error = '';
  } catch (err) { p.error = err.message; }
}

// ------------------------------------------------------------------ routing

function workerCaps() { return state.worker.health?.capabilities || {}; }

/** Top Puter models, one per vendor, optionally vision-capable only. */
function puterBest({ vision = false, count = 3, exclude = [] } = {}) {
  const out = [], vendors = new Set();
  for (const m of state.puter.models) {
    if (exclude.includes(m.id)) continue;
    if (vision && !m.vision) continue;
    const { vendor } = vendorOf(m.id);
    if (vendors.has(vendor)) continue;
    vendors.add(vendor);
    out.push(m);
    if (out.length >= count) break;
  }
  return out;
}

const puterRoute = m => ({
  id: `puter:${m.id}`, source: 'puter', provider: 'puter', model: m.id, label: `${m.name}`, family: vendorOf(m.id).family,
  vision: !!m.vision, context: m.context || 128000, reasoning: !!m.reasoning
});
function workerRoute(provider = 'auto', model = '') {
  const caps = workerCaps();
  const wm = model ? state.worker.models.find(m => m.id === model && (provider === 'auto' || m.provider === provider)) : null;
  const pLabel = state.worker.providers.find(p => p.id === provider)?.label;
  const label = wm?.name || (provider !== 'auto' ? (pLabel || provider) : 'X Coder Router');
  return {
    id: model ? `worker:${provider}:${model}` : provider !== 'auto' ? `worker:${provider}:auto` : 'worker:auto',
    source: 'worker', provider, model, label, family: wm ? vendorOf(wm.id).family : label,
    vision: caps.vision === true && (wm ? wm.vision !== false : true), context: wm?.context || DEFAULT_CONTEXT, reasoning: false
  };
}

/** Ordered routes for a selection. Failover moves down the list (same conversation). */
function resolveRoutes(selection, { vision = false } = {}) {
  const sel = parseSelection(selection ?? catalog.current());
  const puterOn = state.puter.status === 'signed-in' && puterSignedIn();
  const workerOn = state.worker.status !== 'unconfigured';
  const pref = settings.get('xcoder.ai.autoPreference', 'best');
  let bestPuter = puterOn ? puterBest({ vision, count: 2 }).map(puterRoute) : [];
  // signed in but the model list could not be loaded: let Puter pick its default model
  if (puterOn && !bestPuter.length && !state.puter.models.length) bestPuter = [{ id: 'puter:auto', source: 'puter', provider: 'puter', model: '', label: 'Puter', family: 'Puter', vision: true, context: 128000, reasoning: false }];
  const routes = [];
  const add = r => { if (r && !routes.some(x => x.id === r.id)) routes.push(r); };
  const workerAuto = workerOn ? workerRoute('auto') : null;
  const workerSeesImages = workerCaps().vision === true;

  if (sel.source === 'worker') {
    add(workerRoute(sel.provider || 'auto', sel.model || ''));
    if (sel.provider !== 'auto' || sel.model) add(workerAuto);
    bestPuter.forEach(add);
  } else if (sel.source === 'puter') {
    if (puterOn) {
      let chosen = sel.model ? state.puter.models.find(m => m.id === sel.model) || normalizePuterModel({ id: sel.model }) : null;
      if (chosen && vision && !chosen.vision) chosen = null; // cannot see the image → best vision model instead
      if (chosen) add(puterRoute(chosen));
      bestPuter.forEach(add);
    }
    add(workerAuto);
  } else if (vision && !workerSeesImages && bestPuter.length) {
    bestPuter.forEach(add); add(workerAuto);
  } else if (pref === 'router') {
    add(workerAuto); bestPuter.forEach(add);
  } else {
    bestPuter.forEach(add); add(workerAuto);
  }
  if (!routes.length) add(workerRoute('auto'));
  return routes;
}

// ------------------------------------------------------------------ public API

export const catalog = {
  async refresh({ force = false } = {}) {
    if (state.loading) return state.loading;
    if (!force && state.loadedAt && Date.now() - state.loadedAt < TTL && state.worker.status !== 'unreachable') return;
    state.loading = (async () => {
      const w = loadWorker(force).catch(err => { state.worker.status = 'unreachable'; state.worker.error = err.message; }).finally(emit);
      const p = loadPuter(force).catch(err => { state.puter.error = err.message; }).finally(emit);
      await Promise.all([w, p]);
      state.loadedAt = Date.now();
    })().finally(() => { state.loading = null; emit(); });
    return state.loading;
  },

  /** Ensures Puter's sign-in state/models are current before routing (cheap when unchanged). */
  async ensureFresh() {
    const signedIn = puterSignedIn();
    const stale = !state.loadedAt || Date.now() - state.loadedAt > TTL;
    const puterChanged = signedIn !== (state.puter.status === 'signed-in') || (signedIn && !state.puter.models.length);
    if (stale) await this.refresh().catch(() => {});
    else if (puterChanged) { await loadPuter(false).catch(() => {}); emit(); }
  },

  list() {
    const out = [];
    const w = state.worker, p = state.puter;
    out.push({ id: 'auto', label: 'Auto', description: p.status === 'signed-in' && settings.get('xcoder.ai.autoPreference', 'best') === 'best' ? 'Strongest available model, automatic failover' : 'Best available route, automatic failover', group: 'Auto', provider: 'auto', source: 'auto', vision: true, context: null });
    if (w.status !== 'unconfigured') {
      out.push({ id: 'worker:auto', label: 'X Coder Router · Auto', description: 'Free models via your X Coder router', group: 'X Coder Router', provider: 'auto', source: 'worker', vision: workerCaps().vision === true, context: DEFAULT_CONTEXT });
      for (const prov of w.providers) {
        if (prov.configured === false || prov.kind === 'media') continue;
        out.push({ id: `worker:${prov.id}:auto`, label: `${prov.label || prov.id} · Auto`, description: String(prov.status || 'configured').replace(/_/g, ' '), group: 'X Coder Router', provider: prov.id, source: 'worker', vision: workerCaps().vision === true, context: DEFAULT_CONTEXT });
      }
      for (const m of w.models.slice(0, 200)) {
        const provLabel = w.providers.find(x => x.id === m.provider)?.label || m.provider;
        out.push({ id: `worker:${m.provider}:${m.id}`, label: m.name, description: `${provLabel}${m.free ? ' · free' : ''}`, group: `Router · ${provLabel}`, provider: m.provider, source: 'worker', vision: workerCaps().vision === true && !!m.vision, context: m.context });
      }
    }
    if (p.status === 'signed-in') {
      out.push({ id: 'puter:auto', label: 'Puter · Best', description: p.models[0] ? `Currently ${p.models[0].name}` : 'Strongest Puter model', group: 'Puter', provider: 'puter', source: 'puter', vision: true, context: p.models[0]?.context || null });
      for (const m of p.models.slice(0, 80)) {
        out.push({ id: `puter:${m.id}`, label: m.name, description: `${vendorOf(m.id).vendor}${m.vision ? ' · vision' : ''}`, group: `Puter · ${vendorOf(m.id).vendor}`, provider: 'puter', source: 'puter', vision: m.vision, context: m.context });
      }
    }
    const cur = this.current();
    if (!out.some(x => x.id === cur)) {
      const sel = parseSelection(cur);
      out.push({ id: cur, label: sel.model ? prettyName(sel.model) : cur, description: 'Saved selection (not currently available)', group: 'Saved', provider: sel.provider || sel.source, source: sel.source, vision: false, context: null, unavailable: true });
    }
    return out;
  },

  current() {
    const raw = settings.get('xcoder.ai.model', 'auto');
    const norm = normalizeSelection(raw);
    if (norm !== raw) { try { settings.set('xcoder.ai.model', norm); } catch {} }
    return norm;
  },

  select(id) { settings.set('xcoder.ai.model', normalizeSelection(id)); emit(); },

  status() {
    const w = state.worker, p = state.puter;
    const providers = w.providers.map(x => ({ id: x.id, label: x.label || x.id, status: x.status || (x.configured ? 'configured' : 'not configured'), configured: x.configured !== false, kind: x.kind || 'text', source: 'worker', modelCount: x.modelCount ?? w.models.filter(m => m.provider === x.id).length, error: x.error || '' }));
    providers.push({ id: 'puter', label: 'Puter AI', status: p.status === 'signed-in' ? 'ready' : p.status === 'signed-out' ? 'not signed in' : 'unavailable', configured: p.status === 'signed-in', kind: 'browser', source: 'puter', modelCount: p.models.length, error: p.error || '' });
    return {
      worker: w.status === 'loading' ? (w.models.length ? 'ready' : 'loading') : w.status,
      puter: p.status, providers,
      models: { worker: w.models.length, puter: p.models.length },
      routerUrl: w.url || cleanRouterUrl(settings.get('xcoder.ai.routerUrl', DEFAULT_ROUTER)),
      capabilities: workerCaps(), error: w.error || '', puterError: p.error || '',
      loadedAt: state.loadedAt, loading: !!state.loading
    };
  },

  onChange(fn) { return events.on('change', fn); },

  resolveRoutes,
  /** Best Puter model entry (for labels), or null. */
  bestPuterModel: () => state.puter.models[0] || null,
  /** Context window for a selection id (tokens). */
  contextFor(id) { return resolveRoutes(id)[0]?.context || DEFAULT_CONTEXT; },
  /** Internal state for diagnostics. */
  _state: state
};
