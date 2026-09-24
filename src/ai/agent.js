// X Coder agent loop — drives one user request to completion (see the contract in engine.js).
//
// Each round: build/fit the conversation → stream the model's reply (tool tags hidden in real time) → parse
// → run the tool calls in order (consecutive read-only tools in parallel) → send <tool_result> blocks back →
// repeat until the model answers without tool calls. Transient provider failures fail over to the next route
// with the same conversation. Loop protection stops identical no-progress calls and repeated failing rounds.

import { workspace } from '../core/workspace.js';
import { settings } from '../core/settings.js';
import { bus } from '../core/events.js';
import { output } from '../core/output.js';
import { kvGet, kvSet } from '../core/db.js';
import { isImagePath } from '../core/path.js';
import { catalog } from './catalog.js';
import { callWorker, callPuter, isTransientError } from './providers.js';
import { createStreamFilter, formatToolResult, callSignature, TOOLS } from './protocol.js';
import { buildSystemPrompt, continuationNote } from './prompt.js';
import { buildEnvironment, budgetFor, estimateTokens, projectInstructions, isCasualPrompt, CHARS_PER_TOKEN, apis } from './context.js';
import { runTool, toolLabel } from './tools.js';
import { verifyChanges } from './engine-verify.js';
import { createTurn, publicEdit, summarize, turnCheckpointId } from './edits.js';

export const aiLog = output.channel('X Coder AI');

const abortError = () => Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' });
const RESULT_RE = /(<tool_result\b[^>]*>\n?)([\s\S]*?)(\n?<\/tool_result>)/g;
const KEEP_FULL_RESULTS = 3;
const KEEP_FULL_ASSISTANT = 2;
const MAX_MESSAGES = 44; // the X Coder router keeps only the newest 60 messages
const MAX_AUTO_CHECKS = 2;

let busy = 0;
export const isBusy = () => busy > 0;

// ------------------------------------------------------------------ helpers

function hashText(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return { prompt: 0, completion: 0, total: 0 };
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount ?? u.inputTokens ?? 0) || 0;
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount ?? u.outputTokens ?? 0) || 0;
  const total = Number(u.total_tokens ?? u.totalTokenCount ?? u.totalTokens ?? prompt + completion) || prompt + completion;
  return { prompt, completion, total };
}

async function recordUsage(projectId, providerId, usage) {
  if (!projectId) return;
  try {
    const key = `aiUsage:${projectId}`;
    const u = (await kvGet(key, null)) || { calls: 0, totalTokens: 0, byProvider: {} };
    u.calls = (u.calls || 0) + 1;
    u.totalTokens = (u.totalTokens || 0) + usage.total;
    u.byProvider = u.byProvider || {};
    const row = u.byProvider[providerId] || (u.byProvider[providerId] = { calls: 0, tokens: 0 });
    row.calls += 1; row.tokens += usage.total;
    u.updatedAt = Date.now();
    await kvSet(key, u);
  } catch {}
}

const contentLength = c => (typeof c === 'string' ? c.length : (c || []).reduce((n, p) => n + (p.type === 'text' ? p.text.length : IMAGE_CHARS), 0));
const IMAGE_CHARS = Math.round(1100 * CHARS_PER_TOKEN);
const messagesLength = list => list.reduce((n, m) => n + contentLength(m.content) + 16, 0);

function mapText(content, fn) {
  if (typeof content === 'string') return fn(content);
  return content.map(p => (p.type === 'text' ? { ...p, text: fn(p.text) } : p));
}

/** Older tool results: keep a short head of each body. */
function compressResults(content, keepChars = 280) {
  const squeeze = text => text.replace(RESULT_RE, (m, open, body, close) => {
    if (body.length <= keepChars + 80) return m;
    return `${open}${body.slice(0, keepChars)}\n… [older result compressed — run the tool again if you need it]${close}`;
  });
  if (typeof content === 'string') return squeeze(content);
  return content.filter(p => p.type === 'text').map(p => ({ ...p, text: squeeze(p.text) }))
    .concat(content.some(p => p.type === 'image_url') ? [{ type: 'text', text: '[an image from an earlier tool result was removed to save space]' }] : []);
}

/** Older assistant messages: drop file bodies that were already written. */
function compressAssistant(text) {
  return String(text)
    .replace(/(<(write_file|create_file|update_file)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi, (m, open, name, body, close) => body.length < 1200 ? m : `${open}\n[${body.split('\n').length} lines of file content omitted — this write was already applied]\n${close}`)
    .replace(/(<(edit_file|replace_in_file|apply_diff)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi, (m, open, name, body, close) => body.length < 1500 ? m : `${open}\n[SEARCH/REPLACE blocks omitted — this edit was already processed]\n${close}`);
}

/** Environment message: drop the file sections first, then hard-trim (the user request is always kept). */
function shrinkEnv(content, maxChars) {
  return mapText(content, text => {
    if (text.length <= maxChars) return text;
    const reqAt = text.lastIndexOf('<user_request>');
    const request = reqAt >= 0 ? text.slice(reqAt) : '';
    let env = reqAt >= 0 ? text.slice(0, reqAt) : text;
    const cutAt = env.search(/\n(Relevant files|Project files|Codebase files)[^\n]*:\n/);
    if (cutAt > 0 && env.length + request.length > maxChars) env = `${env.slice(0, cutAt)}\n(File contents were removed to fit the model's context — use read_file.)\n</environment>\n\n`;
    const room = Math.max(1500, maxChars - request.length - 200);
    if (env.length > room) env = `${env.slice(0, room)}\n…(environment truncated to fit the context)\n</environment>\n\n`;
    return env + request;
  });
}

/** One line per tool call of a results message ("read_file index.html (ok)"), for collapsed rounds. */
function summarizeResults(content) {
  const text = typeof content === 'string' ? content : (content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
  const out = [];
  const re = /<tool_result name="([\w-]+)"([^>]*)status="(ok|error)">/g;
  let m;
  while ((m = re.exec(text))) {
    const attrs = {};
    m[2].replace(/(\w+)="([^"]*)"/g, (s, k, v) => { attrs[k] = v; return s; });
    const target = attrs.path ? `${attrs.path}${attrs.to ? ` → ${attrs.to}` : ''}` : attrs.from ? `${attrs.from} → ${attrs.to || ''}` : attrs.query || attrs.entry || attrs.url || attrs.command || attrs.name || '';
    out.push(`${m[1]}${target ? ` ${target.slice(0, 120)}` : ''} (${m[3]})`);
  }
  return out;
}

/**
 * Keeps the conversation under MAX_MESSAGES (routers drop the oldest messages beyond ~60, which would lose the
 * request itself): history goes first, then the oldest assistant/results round pairs after the request are
 * collapsed into a short "earlier steps" note inside the first message.
 */
function capMessageCount(out) {
  while (out.length > MAX_MESSAGES && out[0]?.kind === 'history') out.shift();
  while (out.length && out[0].role !== 'user') out.shift();
  const envIdx = out.findIndex(m => m.kind === 'env');
  if (out.length <= MAX_MESSAGES || envIdx < 0) return out;
  const removable = out.length - MAX_MESSAGES + ((out.length - MAX_MESSAGES) % 2); // whole pairs
  const dropped = out.splice(envIdx + 1, removable);
  const steps = [];
  for (const m of dropped) if (m.kind === 'results') steps.push(...summarizeResults(m.content));
  const note = `\n\n<earlier_steps>\n${Math.ceil(removable / 2)} earlier round(s) of this task were removed to save space. Tool calls you already made: ${steps.length ? steps.slice(-80).join('; ') : '(none)'}.\nFiles may have changed since — re-read a file before editing it again.\n</earlier_steps>`;
  out[envIdx] = { ...out[envIdx], content: mapText(out[envIdx].content, t => t.replace(/\n\n<earlier_steps>[\s\S]*?<\/earlier_steps>/, '') + note) };
  return out;
}

/** Fits the conversation into the route's prompt budget. */
export function fitMessages(messages, promptChars) {
  let out = capMessageCount(messages.map(m => ({ ...m })));
  const resultIdx = out.map((m, i) => (m.kind === 'results' ? i : -1)).filter(i => i >= 0);
  for (const i of resultIdx.slice(0, -KEEP_FULL_RESULTS)) out[i].content = compressResults(out[i].content);
  const asstIdx = out.map((m, i) => (m.kind === 'assistant' ? i : -1)).filter(i => i >= 0);
  for (const i of asstIdx.slice(0, -KEEP_FULL_ASSISTANT)) out[i].content = compressAssistant(out[i].content);
  // drop the oldest chat history first
  while (messagesLength(out) > promptChars && out.some(m => m.kind === 'history')) {
    const i = out.findIndex(m => m.kind === 'history');
    out.splice(i, 1);
    if (out[i]?.kind === 'history' && out[i].role === 'assistant') out.splice(i, 1);
  }
  // then squeeze every tool result but the newest
  if (messagesLength(out) > promptChars) {
    const idx = out.map((m, i) => (m.kind === 'results' ? i : -1)).filter(i => i >= 0);
    for (const i of idx.slice(0, -1)) out[i].content = compressResults(out[i].content, 120);
    for (const i of out.map((m, i) => (m.kind === 'assistant' ? i : -1)).filter(i => i >= 0).slice(0, -1)) out[i].content = compressAssistant(out[i].content);
  }
  // then the environment block
  if (messagesLength(out) > promptChars) {
    const envIdx = out.findIndex(m => m.kind === 'env');
    if (envIdx >= 0) {
      const others = messagesLength(out) - contentLength(out[envIdx].content);
      out[envIdx].content = shrinkEnv(out[envIdx].content, Math.max(3000, promptChars - others));
    }
  }
  // last resort: trim the newest tool results
  if (messagesLength(out) > promptChars) {
    const last = out.length - 1;
    if (out[last].kind === 'results') out[last].content = mapText(out[last].content, t => t.slice(0, Math.max(4000, promptChars - (messagesLength(out) - contentLength(out[last].content)))));
  }
  return out.map(({ role, content }) => ({ role, content }));
}

/** Providers want alternating roles starting with the user. */
function normalizeHistory(history = [], maxChars) {
  const items = [];
  for (const h of history) {
    const role = h?.role === 'assistant' ? 'assistant' : h?.role === 'user' ? 'user' : null;
    const text = String(h?.text ?? h?.content ?? '').trim();
    if (!role || !text) continue;
    const prev = items[items.length - 1];
    if (prev && prev.role === role) prev.content += `\n\n${text}`;
    else items.push({ role, content: text, kind: 'history' });
  }
  while (items.length && items[0].role !== 'user') items.shift();
  if (items.length && items[items.length - 1].role === 'user') items.pop(); // the new request follows
  // keep the newest history within the budget
  let total = 0;
  const kept = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const len = items[i].content.length;
    if (total + len > maxChars) {
      if (!kept.length) kept.unshift({ ...items[i], content: `…${items[i].content.slice(-Math.max(500, maxChars))}` });
      break;
    }
    total += len;
    kept.unshift(items[i]);
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}

function pendingStatus(p) {
  if (!p) return null;
  const path = p.attrs?.path || p.attrs?.from;
  switch (p.name) {
    case 'write_file': return path ? `Writing ${path}…` : 'Writing a file…';
    case 'edit_file': return path ? `Editing ${path}…` : 'Preparing an edit…';
    case 'think': case 'thinking': return 'Thinking…';
    case 'json': return 'Working…';
    default: return null;
  }
}

function friendlyError(err, tried) {
  const msg = err?.message || String(err);
  const routes = tried.length > 1 ? ` (tried ${tried.join(' → ')})` : '';
  if (/router URL is not set/i.test(msg)) return new Error(`No AI model is available: the X Coder AI router URL is not set and you are not signed in to X Coder Cloud. Set the router URL (Settings → X Coder AI → Router Url, or the "Configure AI Router…" command) or sign in to X Coder Cloud to use Puter models.`);
  if (/Could not reach|failed to fetch|network|load failed/i.test(msg)) return Object.assign(new Error(`X Coder AI could not reach any model${routes}. Check your internet connection, or set the router URL in Settings → X Coder AI. Details: ${msg}`), { cause: err });
  return Object.assign(new Error(`${msg}${routes}`), { cause: err, status: err?.status });
}

const ACTION_RE = /\b(build|create|make|add|fix|implement|change|update|write|refactor|rename|remove|delete|replace|restyle|style|convert|improve|redesign|set ?up|generate|move|finish|complete|translate|port|optimi[sz]e|clean ?up)\b/i;
const QUESTION_RE = /^\s*(how|what|why|when|where|which|who|explain|can you explain|could you explain|show me|tell me|is|are|does|do|should)\b/i;
const UNAPPLIED_NOTE = 'You wrote code in your reply but did not apply it. You are in Agent mode: the user expects the project itself to change. Apply the changes now with write_file / edit_file (read files first if needed), verify them, and then give a short summary — do not paste the code again.';
const UNAPPLIED_NOTE_EDIT = 'You wrote code in your reply but did not propose it as edits. You are in Edit mode: output the changes with write_file / edit_file (read files first if needed) so the user can review and keep them, with a one-line explanation — do not paste the code again.';
const AUTO_CHECK_NOTE = 'The IDE checked the files you changed and found the problems above. Fix the ones your changes caused (read the files first if needed), then give your final answer. If a problem is unrelated to your work or cannot be fixed here, explain it briefly in the final answer instead of retrying.';

/** A change request answered with pasted code instead of edit tools (common with weaker models). */
export function looksLikeUnappliedCode(text, prompt) {
  if (!ACTION_RE.test(prompt || '') || QUESTION_RE.test(prompt || '') || isCasualPrompt(prompt)) return false;
  let big = 0;
  const re = /^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n {0,3}\1[ \t]*$/gm;
  let m;
  while ((m = re.exec(text || ''))) if (m[2].split('\n').length >= 8) big++;
  return big > 0;
}

/** Runs the automatic post-edit check and reports it to the UI as a tool step. */
async function autoCheck(turn, { runPreview, signal, emit }) {
  const id = `auto_check_${Date.now().toString(36)}`;
  emit({ type: 'tool', id, name: 'auto_check', label: 'Checking the changed files', state: 'running' });
  emit({ type: 'status', text: 'Checking the changed files…' });
  let res;
  try {
    const preview = runPreview ? await apis.preview() : null;
    res = await verifyChanges(turn, { fs: workspace.fs, runPreview, preview, signal });
  } catch (err) {
    aiLog.warn(`Automatic check failed: ${err.message}`);
    res = { checked: 0, problems: [], report: '', previewRan: false };
  }
  if (signal?.aborted) throw abortError();
  const n = res.problems.length;
  emit({ type: 'tool', id, name: 'auto_check', label: `Checked ${res.checked} changed file${res.checked === 1 ? '' : 's'}${res.previewRan ? ' and ran the preview' : ''}`, state: n ? 'error' : 'done', detail: n ? `${n} problem${n === 1 ? '' : 's'} found — fixing` : 'No problems found' });
  aiLog.info(`Auto-check: ${res.checked} file(s), ${n} problem(s)${res.previewRan ? ', preview ran' : ''}`);
  return res;
}

// ------------------------------------------------------------------ main

export async function runTurn(request = {}) {
  const { prompt = '', attachments = [], history = [], signal } = request;
  const emit = ev => { try { request.onEvent?.(ev); } catch (err) { console.error('[X Coder AI] onEvent handler failed', err); } };
  const mode = ['ask', 'edit', 'agent'].includes(request.mode) ? request.mode : settings.get('xcoder.ai.mode', 'agent');
  if (!workspace.fs || !workspace.project) throw new Error('Open a project first.');
  if (signal?.aborted) throw abortError();
  if (!String(prompt).trim() && !attachments.length) throw new Error('Type a message first.');

  const turn = createTurn({ turnId: request.turnId || undefined, mode, projectId: workspace.id });
  const settingSteps = Math.max(1, Number(settings.get('xcoder.ai.maxSteps', 30)) || 30);
  const maxSteps = mode === 'agent' ? settingSteps : Math.min(8, settingSteps);
  const temperature = Number(settings.get('xcoder.ai.temperature', 0.2));
  const timeoutMs = Math.max(20, Number(settings.get('xcoder.ai.requestTimeoutSeconds', 120)) || 120) * 1000;
  const routerUrl = settings.get('xcoder.ai.routerUrl', '');
  const started = Date.now();
  busy++;
  bus.emit('ai:status', { state: 'busy', text: 'Thinking…' });
  emit({ type: 'status', text: 'Thinking…' });

  const state = { text: '', rounds: 0, usage: { prompt: 0, completion: 0, total: 0 }, provider: '', model: '', routeLabel: '' };
  try {
    await Promise.race([catalog.ensureFresh(), new Promise(r => setTimeout(r, 8000))]);
    if (signal?.aborted) throw abortError();
    const hasImages = attachments.some(a => (a.type === 'image' && a.dataUrl && !/^data:image\/svg/i.test(a.dataUrl)) || (a.type === 'file' && a.path && isImagePath(a.path) && !a.path.endsWith('.svg')));
    const routes = catalog.resolveRoutes(request.model || catalog.current(), { vision: hasImages });
    let routeIndex = 0;
    const primary = budgetFor(routes[0]);
    aiLog.info(`Turn ${turn.id} · mode ${mode} · routes: ${routes.map(r => r.id).join(' → ')}`);

    const system = buildSystemPrompt({
      mode, maxSteps,
      customInstructions: settings.get('xcoder.ai.customInstructions', ''),
      projectInstructions: projectInstructions(workspace.fs),
      vision: !hasImages || routes.some(r => r.vision)
    });
    const historyBudget = Math.floor(primary.promptChars * 0.25);
    const historyMsgs = normalizeHistory(history, historyBudget);
    const historyChars = historyMsgs.reduce((n, m) => n + m.content.length, 0);
    const wantsCodebase = attachments.some(a => a.type === 'codebase');
    const envChars = Math.max(6000, Math.min(wantsCodebase ? 320000 : 120000, Math.floor((primary.promptChars - system.length - historyChars - prompt.length) * 0.6)));
    emit({ type: 'status', text: isCasualPrompt(prompt) ? 'Thinking…' : 'Gathering context…' });
    const env = await buildEnvironment({ prompt, mode, attachments, envChars, includeOpenEditors: settings.get('xcoder.ai.includeOpenEditors', true) !== false });
    if (signal?.aborted) throw abortError();
    // a pasted wall of text must still leave room for the environment and the answer
    const maxRequestChars = Math.max(4000, Math.floor(primary.promptChars * 0.6));
    let requestText = String(prompt).trim() || '(see the attachments)';
    if (requestText.length > maxRequestChars) requestText = `${requestText.slice(0, maxRequestChars)}\n…(the message was cut to fit the model's context: ${requestText.length - maxRequestChars} more characters were not sent)`;
    const firstText = `${env.text}\n\n<user_request>\n${requestText}\n</user_request>`;
    const firstContent = env.images.length
      ? [{ type: 'text', text: firstText }, ...env.images.map(img => ({ type: 'image_url', image_url: { url: img.url } }))]
      : firstText;
    const messages = [...historyMsgs, { role: 'user', content: firstContent, kind: 'env' }];
    const signatures = new Map();
    let failingRounds = 0, stopReason = '', continuing = false, continuations = 0;
    let autoChecks = 0, editsSinceCheck = false, previewSinceEdit = false, nudged = false, editRetries = 0;

    // ---- one model call with failover ----
    const callModel = async round => {
      const tried = [];
      while (true) {
        const route = routes[routeIndex];
        tried.push(route.label);
        const budget = budgetFor(route);
        const fitted = fitMessages(messages, Math.max(8000, budget.promptChars - system.length));
        const imagesInPrompt = fitted.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
        let visibleStreamed = false;
        let routeAnnounced = false;
        const filter = createStreamFilter({ onPending: p => { const s = pendingStatus(p); if (s) emit({ type: 'status', text: s }); } });
        const announce = meta => {
          const provider = meta?.provider || (route.source === 'puter' ? 'Puter' : 'X Coder Router');
          const model = meta?.model || route.model || 'auto';
          if (routeAnnounced && provider === state.provider && model === state.model) return;
          routeAnnounced = true;
          state.provider = provider; state.model = model;
          emit({ type: 'route', provider, model, source: route.source, routeId: route.id });
        };
        const common = {
          system, messages: fitted, maxTokens: budget.maxTokens, temperature, signal, timeoutMs,
          onDelta: d => { const v = filter.push(d); if (v) { visibleStreamed = true; emit({ type: 'text', delta: v }); } },
          onReasoning: d => emit({ type: 'reasoning', delta: d }),
          onMeta: meta => { if (meta?.provider || meta?.model) announce(meta); if (meta?.status) emit({ type: 'status', text: meta.status }); }
        };
        const t0 = Date.now();
        try {
          const res = route.source === 'puter'
            ? await callPuter({ ...common, model: route.model, reasoning: route.reasoning, vision: route.vision })
            : await callWorker({ ...common, routerUrl, provider: route.provider, model: route.model, vision: imagesInPrompt, sendImages: route.vision });
          announce(res);
          const fin = filter.finish();
          if (fin.delta) emit({ type: 'text', delta: fin.delta });
          const usage = normalizeUsage(res.usage);
          if (!usage.total) { usage.prompt = estimateTokens(fitted) + estimateTokens(system); usage.completion = estimateTokens(res.text); usage.total = usage.prompt + usage.completion; usage.estimated = true; }
          state.usage.prompt += usage.prompt; state.usage.completion += usage.completion; state.usage.total += usage.total;
          aiLog.info(`Round ${round} · ${res.provider || route.label}${res.model ? ` · ${res.model}` : ''} · ${Date.now() - t0} ms · ${usage.total}${usage.estimated ? '≈' : ''} tokens${(res.attempts || []).length > 1 ? ` · router attempts: ${res.attempts.map(a => `${a.provider}/${a.model}${a.ok ? '' : `(${a.kind || a.status || 'failed'})`}`).join(' → ')}` : ''}`);
          recordUsage(workspace.id, res.providerId || route.provider || route.source, usage);
          return { raw: res.text, parsed: fin.result, finishReason: res.finishReason, route };
        } catch (err) {
          if (err?.name === 'AbortError' || signal?.aborted) throw abortError();
          aiLog.warn(`Route ${route.label} failed after ${Date.now() - t0} ms: ${err.message}${err.attempts?.length ? ` · attempts: ${err.attempts.map(a => `${a.provider}/${a.model}:${a.kind || a.status || 'failed'}`).join(', ')}` : ''}`);
          const next = routes[routeIndex + 1];
          if (!next) throw friendlyError(err, tried);
          const transient = isTransientError(err);
          const why = transient ? 'is busy' : 'is unavailable';
          emit({ type: 'status', text: `${route.family || route.label} ${why} — continuing with ${next.family && next.family !== route.family ? next.family : next.label}…` });
          if (visibleStreamed) emit({ type: 'round', index: round, retry: true });
          routeIndex++;
        }
      }
    };

    for (let round = 1; ; round++) {
      if (signal?.aborted) throw abortError();
      state.rounds = round;
      if (!continuing) emit({ type: 'round', index: round });
      if (round > 1) emit({ type: 'status', text: continuing ? 'Continuing…' : 'Thinking…' });
      bus.emit('ai:status', { state: 'busy', text: round > 1 ? `Working (step ${round})…` : 'Thinking…' });
      const { raw, parsed, finishReason } = await callModel(round);
      if (parsed.text) state.text += (state.text && !continuing ? '\n\n' : '') + parsed.text;
      if (parsed.reasoning) emit({ type: 'reasoning', delta: parsed.reasoning });
      messages.push({ role: 'assistant', content: raw.trim() || '(empty reply)', kind: 'assistant' });
      const calls = parsed.calls;
      continuing = false;
      // A plain answer cut off by the output limit: ask for the rest (appended to the same text block).
      if (!calls.length && !parsed.truncated && /^(length|max_tokens|max_output_tokens)$/i.test(finishReason || '') && continuations < 3 && round <= maxSteps) {
        continuations++;
        continuing = true;
        messages.push({ role: 'user', content: 'Your previous message was cut off by the output limit. Continue exactly where it stopped — do not repeat anything and do not add an introduction.', kind: 'results' });
        continue;
      }
      if (!calls.length && !parsed.truncated) {
        // Agent/Edit mode, nothing applied, but the answer is a code dump for a change request: use the edit tools.
        if (mode !== 'ask' && !nudged && !turn.edits.length && round <= maxSteps && looksLikeUnappliedCode(parsed.text, prompt)) {
          nudged = true;
          aiLog.info('The reply contains code that was not applied — asking the model to use the edit tools.');
          messages.push({ role: 'user', content: mode === 'edit' ? UNAPPLIED_NOTE_EDIT : UNAPPLIED_NOTE, kind: 'results' });
          continue;
        }
        // Agent mode: check the changed files once the model says it is done; feed real problems back.
        if (mode === 'agent' && editsSinceCheck && autoChecks < MAX_AUTO_CHECKS && round <= maxSteps) {
          autoChecks++;
          editsSinceCheck = false;
          const check = await autoCheck(turn, { runPreview: !previewSinceEdit, signal, emit });
          if (check.previewRan) previewSinceEdit = true;
          if (check.problems.length) {
            messages.push({ role: 'user', content: `${formatToolResult({ name: 'auto_check', ok: false, content: check.report })}\n\n${AUTO_CHECK_NOTE}`, kind: 'results' });
            continue;
          }
        }
        break;
      }
      if (round > maxSteps) {
        stopReason = `I reached the limit of ${maxSteps} steps for one request, so I stopped here. Send "continue" to let me keep going.`;
        break;
      }

      // ---- execute tool calls in order (consecutive read-only calls in parallel) ----
      const results = [];
      const images = [];
      const ctx = {
        turn, mode, signal, routerUrl, vision: routes[routeIndex].vision, capabilities: catalog.status().capabilities || {},
        resultCap: budgetFor(routes[routeIndex]).context >= 100000 ? 40000 : 12000,
        status: text => emit({ type: 'status', text })
      };
      const exec = async call => {
        const kind = TOOLS[call.name]?.kind;
        const isEdit = kind === 'edit';
        const label = toolLabel(call, 'running');
        if (!isEdit) emit({ type: 'tool', id: call.id, name: call.name, label, state: 'running' });
        emit({ type: 'status', text: label });
        const r = await runTool(call, ctx);
        if (r.edit) emit({ type: 'edit', ...publicEdit(r.edit) });
        if (r.project) emit({ type: 'project', id: r.project.id, name: r.project.name });
        if (!isEdit || (!r.edit && !r.ok && !r.unchanged)) {
          const firstLine = String(r.content || '').split('\n')[0].slice(0, 200);
          emit({ type: 'tool', id: call.id, name: call.name, label: toolLabel(call, 'done', r.info || {}), state: r.ok === false ? 'error' : 'done', detail: r.detail || (r.ok === false ? firstLine : '') });
        }
        const pathInfo = call.attrs.path || call.attrs.from || call.attrs.query || call.attrs.entry || call.attrs.url || call.attrs.command || '';
        aiLog.info(`Tool ${call.name}${pathInfo ? ` ${String(pathInfo).slice(0, 120)}` : ''} → ${r.ok === false ? 'error' : 'ok'}`);
        return r;
      };
      let i = 0;
      while (i < calls.length) {
        if (signal?.aborted) throw abortError();
        if (TOOLS[calls[i].name]?.kind === 'read') {
          let j = i;
          while (j < calls.length && TOOLS[calls[j].name]?.kind === 'read') j++;
          const group = calls.slice(i, j);
          const rs = await Promise.all(group.map(exec));
          group.forEach((c, k) => results.push({ call: c, r: rs[k] }));
          i = j;
        } else {
          results.push({ call: calls[i], r: await exec(calls[i]) });
          i++;
        }
      }
      for (const { r } of results) if (r.images?.length) images.push(...r.images);
      if (parsed.errors?.length) aiLog.warn(`Protocol: ${parsed.errors.join(' ')}`);

      // verification bookkeeping (Agent mode auto-check)
      let editedThisRound = false, verifiedThisRound = false;
      for (const { call, r } of results) {
        if (r.edit && r.edit.state === 'applied') { editsSinceCheck = true; previewSinceEdit = false; editedThisRound = true; }
        if (call.name === 'run_preview' && r.ok !== false) { previewSinceEdit = true; verifiedThisRound = true; }
        if (['get_problems', 'run_script', 'run_command'].includes(call.name)) verifiedThisRound = true;
      }

      // Edit mode: the first edit batch ends the turn (the user reviews the staged edits) — unless some edits
      // failed (e.g. a SEARCH mismatch): then the model gets up to two chances to resend only those.
      let editRetry = false;
      if (mode === 'edit' && results.some(x => TOOLS[x.call.name]?.kind === 'edit')) {
        const failedEdits = results.filter(x => TOOLS[x.call.name]?.kind === 'edit' && x.r.ok === false && !x.r.disabled);
        if ((!failedEdits.length && !parsed.truncated) || editRetries >= 2 || round >= maxSteps) break;
        editRetries++;
        editRetry = true;
      }

      // ---- loop protection ----
      let repeated = null;
      for (const { call, r } of results) {
        const sig = `${callSignature(call)}=>${hashText(String(r.content || ''))}`;
        const n = (signatures.get(sig) || 0) + 1;
        signatures.set(sig, n);
        if (n >= 3) repeated = call;
      }
      const allFailed = results.length > 0 && results.every(x => x.r.ok === false);
      failingRounds = allFailed ? failingRounds + 1 : 0;
      if (repeated) { stopReason = `I stopped because I kept repeating the same action (${toolLabel(repeated, 'running').toLowerCase()}) without making progress.`; break; }
      if (failingRounds >= 3) { stopReason = 'I stopped after three rounds in which every tool call failed. The last errors are shown above; tell me how you would like to proceed.'; break; }

      // ---- send the results back ----
      const truncatedInfo = parsed.truncated ? { name: parsed.truncatedCall?.name || 'tool', path: parsed.truncatedCall?.attrs?.path || '' } : null;
      const blocks = results.map(({ call, r }) => formatToolResult({ name: call.name, attrs: call.attrs, ok: r.ok !== false, content: r.content }));
      if (parsed.errors?.length) blocks.push(`Protocol problems in your last message: ${parsed.errors.join(' ')}`);
      let note = continuationNote({
        mode, round, maxSteps, failures: results.filter(x => x.r.ok === false).length, truncated: truncatedInfo, hallucinated: parsed.hallucinated,
        editRetry, unverifiedEdits: mode === 'agent' && editedThisRound && !verifiedThisRound
      });
      if (round === maxSteps) note += '\nThis was your last tool round: reply now with the final answer (what was done, what remains) and no tool tags.';
      const text = `${blocks.join('\n\n') || '(no tool calls were run)'}\n\n${note}`;
      const content = images.length ? [{ type: 'text', text }, ...images.map(img => ({ type: 'image_url', image_url: { url: img.url } }))] : text;
      messages.push({ role: 'user', content, kind: 'results' });
    }

    if (stopReason) {
      const delta = `${state.text ? '\n\n' : ''}> ${stopReason}`;
      state.text += delta;
      emit({ type: 'text', delta });
    }
    if (!state.text.trim()) {
      // Some models end with tool calls only / an empty reply: never leave the user without an answer.
      const changed = turn.edits.filter(e => ['applied', 'pending'].includes(e.state));
      const delta = changed.length
        ? `${mode === 'edit' ? 'Proposed' : 'Made'} ${changed.length} change${changed.length === 1 ? '' : 's'}: ${summarize(changed)}.`
        : 'The model returned an empty reply. Try again, rephrase the request, or pick another model.';
      state.text = delta;
      emit({ type: 'text', delta });
    }
    const edits = turn.edits.map(publicEdit);
    const applied = turn.edits.filter(e => e.state === 'applied');
    if (mode === 'agent' && applied.length) {
      bus.emit('ai:editsApplied', { summary: summarize(applied), paths: [...new Set(applied.map(e => e.to || e.path))], turnId: turn.id, projectId: turn.projectId });
    }
    aiLog.info(`Turn ${turn.id} done in ${((Date.now() - started) / 1000).toFixed(1)} s · ${state.rounds} round(s) · ${edits.length} edit(s) · ${state.usage.total} tokens`);
    bus.emit('ai:status', { state: 'idle', text: 'Ready' });
    emit({ type: 'status', text: '' });
    return {
      turnId: turn.id, text: state.text, edits, checkpointId: turnCheckpointId(turn),
      provider: state.provider, model: state.model, usage: state.usage, rounds: state.rounds, mode,
      stopped: stopReason || null
    };
  } catch (err) {
    const aborted = err?.name === 'AbortError' || signal?.aborted;
    bus.emit('ai:status', aborted ? { state: 'idle', text: 'Cancelled' } : { state: 'error', text: err.message });
    if (!aborted) aiLog.error(`Turn ${turn.id} failed: ${err.message}`);
    const out = aborted ? abortError() : err;
    out.turnId = turn.id;
    out.edits = turn.edits.map(publicEdit);
    out.checkpointId = turnCheckpointId(turn);
    out.text = state.text;
    throw out;
  } finally {
    busy = Math.max(0, busy - 1);
  }
}
