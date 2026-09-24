// X Coder AI providers: the X Coder Worker router (keys stay server-side) and Puter (browser-side models).
//
//   callWorker({ routerUrl, system, messages, maxTokens, temperature, provider, model, vision, signal,
//                timeoutMs, onDelta(text), onMeta(meta) }) → { text, provider, providerId, model, usage, attempts, finishReason }
//      POST <router>/agent with stream:true. Handles Server-Sent Events ('data: {type:start|delta|done|error}') and
//      OpenAI-style chunks, as well as plain JSON replies from older deployed routers. Abortable; idle timeout.
//   callPuter({ system, messages, model, maxTokens, temperature, reasoning, signal, onDelta, onReasoning })
//      puter.ai.chat(messages, { model, stream: true, … }) → async iterable of chunks (or a non-stream result).
//   fetchWorkerJSON(routerUrl, path, { timeoutMs, signal })
//   ProviderError { status, transient, attempts, streamed }
//   isTransientError(err)

import { getPuter, puterSignedIn } from '../core/puter.js';

/** Test/diagnostic switches (e.g. the engine test disables streaming to exercise JSON replies). */
export const providerConfig = { stream: true };

export class ProviderError extends Error {
  constructor(message, { status = 0, transient = false, attempts = [], streamed = false, source = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    Object.assign(this, { status, transient, attempts, streamed, source });
  }
}

const TRANSIENT_RE = /high demand|temporar|try again|resource[_ ]exhausted|too many requests|rate.?limit|quota|overload|unavailable|busy|capacity|timed? ?out|timeout|credit|insufficient|funds|exceeded|503|502|504|529|429|network|failed to fetch|load failed|econnreset|socket/i;

export function isTransientError(err) {
  if (!err || err.name === 'AbortError') return false;
  if (err.transient) return true;
  const s = Number(err.status || 0);
  if (s === 408 || s === 409 || s === 425 || s === 429 || s === 402 || s >= 500) return true;
  if (s === 401 || s === 403) return /credit|quota|insufficient|funds|limit/i.test(err.message || '');
  return TRANSIENT_RE.test(String(err.message || err));
}

export const cleanRouterUrl = url => String(url || '').trim().replace(/\/+$/, '');

function abortError(reason) {
  return Object.assign(new Error(reason || 'The request was cancelled.'), { name: 'AbortError' });
}

/** AbortController linked to the caller's signal with an (idle) timeout that can be re-armed. */
function linkedController(signal, timeoutMs) {
  const ctrl = new AbortController();
  let timer = null, timedOut = false;
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) { if (signal.aborted) ctrl.abort(signal.reason); else signal.addEventListener('abort', onAbort, { once: true }); }
  const arm = () => {
    clearTimeout(timer);
    if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; ctrl.abort('timeout'); }, timeoutMs);
  };
  arm();
  return {
    signal: ctrl.signal, arm,
    get timedOut() { return timedOut; },
    dispose() { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); }
  };
}

export async function fetchWorkerJSON(routerUrl, path, { timeoutMs = 12000, signal } = {}) {
  const base = cleanRouterUrl(routerUrl);
  if (!base) throw new ProviderError('The X Coder AI router URL is not set.', { status: 0 });
  const link = linkedController(signal, timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, { signal: link.signal, headers: { accept: 'application/json' } });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) throw new ProviderError(data?.error || `Router HTTP ${res.status}`, { status: res.status, transient: res.status >= 500 || res.status === 429 });
    if (!data) throw new ProviderError('The router returned an invalid response (not JSON).', { status: res.status });
    return data;
  } catch (err) {
    if (link.timedOut) throw new ProviderError(`The router did not respond within ${Math.round(timeoutMs / 1000)} s.`, { status: 504, transient: true });
    if (err.name === 'AbortError') throw signal?.aborted ? abortError() : err;
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`Could not reach the router: ${err.message}`, { status: 0, transient: true });
  } finally { link.dispose(); }
}

// ------------------------------------------------------------------ Worker router

/** Worker messages: images are sent as OpenAI image_url parts only when the route can see images. */
function workerMessages(messages, vision) {
  return messages.map(m => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    const parts = [];
    for (const p of m.content || []) {
      if (p.type === 'text') parts.push({ type: 'text', text: p.text });
      else if (p.type === 'image_url' && vision) parts.push({ type: 'image_url', image_url: { url: p.image_url?.url } });
      else if (p.type === 'image_url') parts.push({ type: 'text', text: '[An image was attached here, but the current AI route cannot view images.]' });
    }
    if (parts.every(p => p.type === 'text')) return { role: m.role, content: parts.map(p => p.text).join('\n\n') };
    return { role: m.role, content: parts };
  });
}

const MAX_WORKER_BODY = 1_900_000; // the X Coder router rejects bodies over 2 MB

/** JSON body for the router; drops images (oldest first) when the request would exceed the size limit. */
export function fitWorkerBody(body) {
  let json = JSON.stringify(body);
  for (let i = 0; i < body.messages.length && json.length > MAX_WORKER_BODY; i++) {
    const c = body.messages[i].content;
    if (!Array.isArray(c) || !c.some(p => p.type === 'image_url')) continue;
    body.messages[i] = { ...body.messages[i], content: c.map(p => (p.type === 'image_url' ? { type: 'text', text: '[An image was removed to keep the request under the router size limit.]' } : p)) };
    json = JSON.stringify(body);
  }
  if (json.length > MAX_WORKER_BODY) throw new ProviderError('The request is too large for the X Coder router (2 MB limit). Remove some attachments or start a new chat.', { status: 413 });
  return json;
}

export async function callWorker({ routerUrl, system, messages, maxTokens = 8192, temperature = 0.2, provider = 'auto', model = '', vision = false, sendImages = vision, signal, timeoutMs = 120000, onDelta, onMeta, onReasoning }) {
  const base = cleanRouterUrl(routerUrl);
  if (!base) throw new ProviderError('The X Coder AI router URL is not set (Settings → X Coder AI → Router Url).', { status: 0 });
  const stream = providerConfig.stream !== false;
  const body = {
    system, messages: workerMessages(messages, sendImages), max_tokens: maxTokens, temperature,
    provider: provider || 'auto', allow_fallback: true, stream, vision: !!vision
  };
  if (model) body.model = model;
  const payload = fitWorkerBody(body);
  const link = linkedController(signal, timeoutMs);
  let streamed = false;
  const meta = { provider: '', providerId: '', model: '', usage: null, attempts: [], finishReason: null };
  try {
    let res;
    try {
      res = await fetch(`${base}/agent`, {
        method: 'POST', signal: link.signal,
        headers: { 'content-type': 'application/json', accept: stream ? 'text/event-stream, application/json' : 'application/json' },
        body: payload
      });
    } catch (err) {
      if (link.timedOut) throw new ProviderError(`The AI router did not respond within ${Math.round(timeoutMs / 1000)} s.`, { status: 504, transient: true });
      if (err.name === 'AbortError') throw abortError();
      throw new ProviderError(`Could not reach the X Coder AI router (${err.message}). Check your connection or the router URL.`, { status: 0, transient: true });
    }
    link.arm();
    const type = res.headers.get('content-type') || '';
    if (!res.ok) {
      let data = null;
      const text = await res.text().catch(() => '');
      try { data = JSON.parse(text); } catch {}
      const msg = data?.error || data?.message || (text && text.length < 300 ? text : '') || `AI router HTTP ${res.status}`;
      throw new ProviderError(String(msg), { status: res.status, attempts: data?.attempts || [], transient: isTransientError({ status: res.status, message: msg }) });
    }
    if (type.includes('text/event-stream') && res.body?.getReader) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '', dataLines = [], text = '';
      const handle = payload => {
        if (!payload || payload === '[DONE]') return;
        let ev;
        try { ev = JSON.parse(payload); } catch { return; }
        if (ev.choices) { // OpenAI-compatible chunk
          const d = ev.choices[0]?.delta?.content ?? ev.choices[0]?.message?.content ?? '';
          if (d) { text += d; streamed = true; onDelta?.(d); }
          if (ev.choices[0]?.finish_reason) meta.finishReason = ev.choices[0].finish_reason;
          if (ev.usage) meta.usage = ev.usage;
          return;
        }
        const t = ev.type || (ev.text != null ? 'delta' : '');
        if (t === 'start' || t === 'route' || t === 'meta') {
          Object.assign(meta, pickMeta(ev));
          onMeta?.({ ...meta });
        } else if (t === 'delta' || t === 'text') {
          const d = ev.text ?? ev.delta ?? '';
          if (d) { text += d; streamed = true; onDelta?.(d); }
        } else if (t === 'reasoning') {
          if (ev.text) onReasoning?.(ev.text);
        } else if (t === 'done' || t === 'end') {
          Object.assign(meta, pickMeta(ev));
          if (ev.text && !text) { text = ev.text; onDelta?.(ev.text); }
        } else if (t === 'error') {
          throw new ProviderError(ev.error || ev.message || 'The AI route failed.', { status: ev.status || 502, attempts: ev.attempts || [], streamed, transient: !streamed && isTransientError({ status: ev.status || 503, message: ev.error || ev.message }) });
        } else if (t === 'status') {
          onMeta?.({ ...meta, status: ev.text || ev.message });
        }
      };
      const flushEvent = () => { if (dataLines.length) { const payload = dataLines.join('\n'); dataLines = []; handle(payload); } };
      while (true) {
        let chunk;
        try { chunk = await reader.read(); }
        catch (err) {
          if (link.timedOut) throw new ProviderError(`The AI response stalled for ${Math.round(timeoutMs / 1000)} s.`, { status: 504, transient: !streamed, streamed });
          if (signal?.aborted || err.name === 'AbortError') throw abortError();
          throw new ProviderError(`The AI stream was interrupted: ${err.message}`, { status: 0, transient: !streamed, streamed });
        }
        if (chunk.done) break;
        link.arm();
        buf += decoder.decode(chunk.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          let line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line) { flushEvent(); continue; }
          if (line.startsWith(':')) continue; // comment / keep-alive
          if (line.startsWith('data:')) {
            const payload = line.slice(5).replace(/^ /, '');
            // most routers send one JSON object per data line; flush eagerly when it parses on its own
            if (!dataLines.length && isCompleteJson(payload)) handle(payload);
            else dataLines.push(payload);
          }
        }
      }
      buf += decoder.decode();
      if (buf.startsWith('data:')) dataLines.push(buf.slice(5).trim());
      flushEvent();
      if (!text.trim()) throw new ProviderError('The AI route returned an empty response.', { status: 502, transient: true, attempts: meta.attempts });
      return { text, ...meta };
    }
    // Plain JSON (older routers, or stream:false)
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); } catch { throw new ProviderError('The AI router returned an invalid response.', { status: 502, transient: true }); }
    if (data.error && !data.text) throw new ProviderError(data.error, { status: 502, attempts: data.attempts || [], transient: isTransientError({ message: data.error }) });
    const text = String(data.text ?? data.content ?? data.choices?.[0]?.message?.content ?? '');
    Object.assign(meta, pickMeta(data));
    onMeta?.({ ...meta });
    if (!text.trim()) throw new ProviderError('The AI route returned an empty response.', { status: 502, transient: true, attempts: meta.attempts });
    onDelta?.(text);
    return { text, ...meta };
  } finally { link.dispose(); }
}

function isCompleteJson(s) {
  const t = s.trim();
  if (!t || t === '[DONE]') return true;
  if (!(t.startsWith('{') && t.endsWith('}'))) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

function pickMeta(ev) {
  const out = {};
  if (ev.provider) out.provider = String(ev.provider);
  if (ev.providerId) out.providerId = String(ev.providerId);
  if (ev.model) out.model = String(ev.model);
  if (ev.usage) out.usage = ev.usage;
  if (Array.isArray(ev.attempts)) out.attempts = ev.attempts;
  const fr = ev.finish_reason || ev.finishReason || ev.stop_reason;
  if (fr) out.finishReason = String(fr);
  return out;
}

// ------------------------------------------------------------------ Puter

/** Puter wants the system prompt as a message and OpenAI-style content arrays for images. */
function puterMessages(system, messages, vision) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    const parts = [];
    for (const p of m.content || []) {
      if (p.type === 'text') parts.push({ type: 'text', text: p.text });
      else if (p.type === 'image_url') parts.push(vision ? { type: 'image_url', image_url: { url: p.image_url?.url } } : { type: 'text', text: '[An image was attached here, but this model cannot view images.]' });
    }
    out.push({ role: m.role, content: parts.every(p => p.type === 'text') ? parts.map(p => p.text).join('\n\n') : parts });
  }
  return out;
}

export function extractPuterText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const content = result?.message?.content ?? result?.content ?? result?.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(x => (typeof x === 'string' ? x : x?.text || '')).join('');
  if (typeof result.toString === 'function' && result.toString !== Object.prototype.toString) return String(result);
  return '';
}

export async function callPuter({ system, messages, model, maxTokens = 8192, temperature = 0.2, reasoning = false, vision = false, signal, timeoutMs = 120000, onDelta, onReasoning, onMeta }) {
  const puter = await getPuter(8000);
  if (!puter?.ai?.chat) throw new ProviderError('Puter AI is unavailable (the Puter library could not load — check your connection).', { status: 0, transient: true, source: 'puter' });
  if (!puterSignedIn()) throw new ProviderError('Sign in to X Coder Cloud (Puter) to use Puter models.', { status: 401, source: 'puter' });
  if (signal?.aborted) throw abortError();
  const opts = { stream: true, max_tokens: maxTokens, temperature };
  if (model) opts.model = model;
  if (reasoning) opts.reasoning_effort = 'high';
  const msgs = puterMessages(system, messages, vision);
  onMeta?.({ provider: 'Puter', providerId: 'puter', model: model || 'auto' });
  let text = '', usage = null, streamed = false;
  let timer = null, timedOut = false, rejectTimeout;
  const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; rejectTimeout(new ProviderError(`Puter did not respond within ${Math.round(timeoutMs / 1000)} s.`, { status: 504, transient: !streamed, streamed, source: 'puter' })); }, timeoutMs); };
  const onAbort = () => rejectTimeout(abortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  arm();
  const run = async () => {
    let result;
    try { result = await puter.ai.chat(msgs, opts); }
    catch (err) {
      const message = err?.message || err?.error?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      if (reasoning && /reasoning/i.test(message)) {
        delete opts.reasoning_effort;
        result = await puter.ai.chat(msgs, opts);
      } else throw new ProviderError(`Puter: ${message}`, { status: err?.status || err?.code || 0, transient: isTransientError({ status: err?.status, message }), source: 'puter' });
    }
    if (result && typeof result[Symbol.asyncIterator] === 'function') {
      for await (const part of result) {
        if (signal?.aborted || timedOut) break;
        arm();
        if (part == null) continue;
        if (typeof part === 'string') { text += part; streamed = true; onDelta?.(part); continue; }
        const type = part.type;
        if (type === 'error' || part.error) {
          const message = part.message || part.error?.message || part.error || 'Puter stream error';
          throw new ProviderError(`Puter: ${message}`, { status: part.status || 502, streamed, transient: !streamed && isTransientError({ message: String(message) }), source: 'puter' });
        }
        if (type === 'usage' || part.usage) { usage = part.usage || usage; if (type === 'usage') continue; }
        if (type === 'reasoning' || part.reasoning) { const r = part.reasoning || part.text || ''; if (r) onReasoning?.(r); continue; }
        const d = part.text ?? part.delta ?? '';
        if (d) { text += d; streamed = true; onDelta?.(d); }
      }
    } else {
      text = extractPuterText(result);
      usage = result?.usage || null;
      if (text) onDelta?.(text);
    }
    return { text, provider: 'Puter', providerId: 'puter', model: model || result?.model || 'auto', usage, attempts: [{ provider: 'puter', model: model || 'auto', ok: true }], finishReason: null };
  };
  try {
    const running = run();
    running.catch(() => {}); // a late failure after a timeout/abort must not become an unhandled rejection
    const out = await Promise.race([running, timeout]);
    if (signal?.aborted) throw abortError();
    if (!out.text.trim()) throw new ProviderError('Puter returned an empty response.', { status: 502, transient: true, source: 'puter' });
    return out;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/** Generates an image with Puter (txt2img) → Blob. */
export async function puterImage(prompt, { signal } = {}) {
  const puter = await getPuter(8000);
  if (!puter?.ai?.txt2img) throw new Error('Image generation needs Puter, which could not load. Check your connection.');
  if (!puterSignedIn()) throw new Error('Sign in to X Coder Cloud (Accounts → Sign in) to generate images.');
  const img = await puter.ai.txt2img(String(prompt).slice(0, 2000));
  if (signal?.aborted) throw abortError();
  const src = img?.src || (typeof img === 'string' ? img : '');
  if (!src) throw new Error('The image model returned no image.');
  const res = await fetch(src);
  return await res.blob();
}
