// X Coder AI chat controller: the current chat session of the open project, sending requests through the
// AI engine (src/ai/engine.js runTurn), folding streamed engine events into response turns, edit review
// (keep / undo / diff), history persistence, retry, votes and read-aloud.
//
//   chat.events.on('session' | 'turn' | 'busy' | 'status', fn)
//   await chat.send({ text, attachments, mode, model, display, command })  → engine result (or null)
//   chat.stop()   chat.retry(responseId)   chat.newSession()   await chat.openSession(id)   await chat.clear()
//   await chat.keep(responseId, editId?)   await chat.undo(responseId, editId?)   await chat.openEditDiff(responseId, editId)
//   setEngineForTesting(fakeEngine)   — UI development / tests without the real engine

import { bus, Emitter } from '../core/events.js';
import { workspace } from '../core/workspace.js';
import { settings } from '../core/settings.js';
import { uid } from '../core/dom.js';
import { output } from '../core/output.js';
import { chatHistory, titleFrom } from './history.js';

const log = output.channel('X Coder AI');
const HISTORY_TURNS = 12;

// ------------------------------------------------------------------ engine access

let engineOverride = null;
let enginePromise = null;
/** Replaces the AI engine (UI tests / development). Pass null to restore the real engine. */
export function setEngineForTesting(fake) { engineOverride = fake || null; chat.events.emit('engine'); }
export async function getEngine() {
  if (engineOverride) return engineOverride;
  if (!enginePromise) {
    enginePromise = import('./engine.js').catch(err => {
      enginePromise = null;
      log.error('The X Coder AI engine failed to load', err);
      throw new Error(`The X Coder AI engine failed to load: ${err.message}`);
    });
  }
  return enginePromise;
}
/** Synchronous access once loaded (model/mode pickers). */
export function engineIfLoaded() { return engineOverride || loadedEngine; }
let loadedEngine = null;
getEngine().then(e => { loadedEngine = e; chat.events.emit('engine'); }).catch(() => {});

// ------------------------------------------------------------------ slash commands

export const ANALYZE_PROMPT = 'Analyze this project: explain its purpose, architecture, tech stack, how to run it, and list bugs and improvements.';

export const SLASH_COMMANDS = [
  { name: 'explain', description: 'Explain how the selected code or the current file works', context: 'code',
    prompt: rest => `Explain how the selected code (or the current file, if nothing is selected) works: its purpose, the important steps, and anything surprising or risky.${rest ? `\n\n${rest}` : ''}` },
  { name: 'fix', description: 'Fix the problems in the selected code or the current file', context: 'code', problems: true,
    prompt: rest => `Fix the problems in the selected code (or the current file). Explain the cause of each problem briefly, then fix it.${rest ? `\n\n${rest}` : ''}` },
  { name: 'tests', description: 'Generate unit tests for the selected code', context: 'code',
    prompt: rest => `Generate unit tests for the selected code (or the current file). Use the test framework the project already uses (or a sensible default), cover normal cases, edge cases and errors, and put the tests in an appropriate test file.${rest ? `\n\n${rest}` : ''}` },
  { name: 'doc', description: 'Add documentation comments to the selected code', context: 'code',
    prompt: rest => `Add clear documentation comments (JSDoc, docstrings or the language's convention) to the selected code (or the current file). Document parameters, return values and side effects without changing behavior.${rest ? `\n\n${rest}` : ''}` },
  { name: 'review', description: 'Review the selected code for bugs and improvements', context: 'code',
    prompt: rest => `Review the selected code (or the current file) for bugs, security issues, performance and readability. List concrete findings ordered by severity, each with a suggested fix.${rest ? `\n\n${rest}` : ''}` },
  { name: 'new', description: 'Build a new project from a description', mode: 'agent',
    prompt: rest => (rest
      ? `Build a new project: ${rest}.\n\nCreate a new project for it with every file it needs, make sure it runs in the preview without errors, and finish with a short summary of how to use it.`
      : 'I want to build a new project. Suggest three ideas that work well in X Coder (web apps, games or tools), each in one sentence, and ask which one to build. Do not create files yet.') },
  { name: 'analyze', description: 'Analyze the whole project', codebase: true,
    prompt: rest => `${ANALYZE_PROMPT}${rest ? `\n\n${rest}` : ''}` },
  { name: 'clear', description: 'Start a new chat', local: 'clear' },
  { name: 'help', description: 'Show what X Coder can do', local: 'help' }
];

export const HELP_TEXT = `**X Coder** is your AI pair programmer. Ask questions, attach files or photos, or use a command:

| Command | What it does |
|---|---|
${SLASH_COMMANDS.map(c => `| \`/${c.name}\` | ${c.description} |`).join('\n')}

**Context** — type \`#\` to add context: \`#file\`, \`#selection\`, \`#problems\`, \`#terminal\`, \`#git\`, \`#codebase\`. Tap 📎 to attach files, photos, a folder or a project ZIP.

**Modes** — *Ask* answers questions without changing files · *Edit* proposes edits you review · *Agent* builds, runs and fixes autonomously. Every change can be undone.

**Tips** — hold the Send button to switch models quickly; tap the microphone to dictate; tap 🔊 under an answer to hear it.`;

/** '/fix the bug' → { command, rest } or null. */
export function parseSlash(text) {
  const m = String(text || '').match(/^\/([a-z]+)\b\s*([\s\S]*)$/i);
  if (!m) return null;
  const command = SLASH_COMMANDS.find(c => c.name === m[1].toLowerCase());
  return command ? { command, rest: m[2].trim() } : null;
}

const CONTEXT_VARS = { problems: 'problems', terminal: 'terminal', git: 'git', codebase: 'codebase' };
/** '#codebase' etc. typed in the prompt → attachments. '#file:path' → file attachment. */
export function variablesIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/(^|\s)#(problems|terminal|git|codebase|file:([^\s]+))(?=\s|$|[.,;:!?])/g)) {
    if (m[3]) out.push({ type: 'file', path: m[3].replace(/^\.?\//, '') });
    else out.push({ type: CONTEXT_VARS[m[2]] });
  }
  return out;
}

/** Editor context for code commands: the selection, else the active file (null when no editor is open). */
async function editorContext() {
  try {
    const [{ codeEditor }, { editors }] = await Promise.all([import('../editor/api.js'), import('../workbench/editors.js')]);
    const ed = codeEditor.getActive();
    const sel = ed?.getSelection?.();
    if (ed?.path && sel && sel.to > sel.from) return { type: 'selection', path: ed.path, text: sel.text, startLine: sel.startLine, endLine: sel.endLine };
    const path = ed?.path || editors.activePath;
    return path && workspace.fs?.isFile(path) ? { type: 'file', path } : null;
  } catch { return null; }
}

function attKey(a) { return a.type === 'file' ? `file:${a.path}` : a.type === 'selection' ? `sel:${a.path}:${a.startLine}-${a.endLine}` : a.type === 'image' ? `img:${a.name}:${(a.dataUrl || '').length}` : a.type === 'text' ? `text:${a.name}` : a.type; }

/**
 * Expands what the user typed into an engine request: slash commands become full prompts (plus the context
 * they need), '#codebase'-style variables become attachments. → { local?, text, display, attachments, mode, command }
 */
export async function prepareRequest({ text = '', attachments = [], mode } = {}) {
  const raw = String(text).trim();
  const slash = parseSlash(raw);
  const out = { text: raw, display: raw, attachments: [...attachments], mode, command: undefined };
  const add = a => { if (a && !out.attachments.some(x => attKey(x) === attKey(a))) out.attachments.push(a); };
  if (slash) {
    const c = slash.command;
    if (c.local) return { ...out, local: c.local };
    out.command = c.name;
    out.text = c.prompt(slash.rest);
    if (c.mode) out.mode = c.mode;
    if (c.context === 'code' && !out.attachments.some(a => a.type === 'file' || a.type === 'selection')) add(await editorContext());
    if (c.problems) add({ type: 'problems' });
    if (c.codebase) add({ type: 'codebase' });
  }
  for (const v of variablesIn(raw)) {
    if (v.type === 'file' && !workspace.fs?.isFile(v.path)) continue;
    add(v);
  }
  if (/(^|\s)#selection\b/.test(raw)) add(await editorContext());
  return out;
}

// ------------------------------------------------------------------ model labels

function prettyModel(id = '') {
  const base = String(id).split('/').pop().replace(/[:@].*$/, '').replace(/-(latest|preview|instruct)$/i, '');
  return base.split(/[-_]/).map(w => (/^(gpt|glm|qwq|r1|v\d|o\d)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ').trim();
}
export function modelLabel(ev) {
  try {
    const eng = engineIfLoaded();
    const list = eng?.catalog?.list?.() || [];
    const hit = list.find(m => m.id === ev.routeId && !/auto$/.test(m.id)) || list.find(m => ev.model && m.id.endsWith(`:${ev.model}`));
    if (hit) return hit.label;
  } catch {}
  if (!ev.model || ev.model === 'auto') return ev.provider || '';
  return prettyModel(ev.model);
}

// ------------------------------------------------------------------ response turn model

function newResponse(request, mode) {
  return { id: uid('r'), role: 'assistant', requestId: request.id, turnId: null, mode, parts: [], reasoning: '', edits: [], model: '', provider: '', status: 'Thinking…', state: 'running', error: '', text: '', time: Date.now(), vote: null };
}

function lastPart(resp) { return resp.parts[resp.parts.length - 1]; }

function applyEvent(resp, ev) {
  switch (ev?.type) {
    case 'status': resp.status = ev.text || ''; break;
    case 'route': resp.provider = ev.provider || ''; resp.model = modelLabel(ev); resp.routeId = ev.routeId || ''; break;
    case 'text': {
      if (!ev.delta) break;
      let part = lastPart(resp);
      if (!part || part.kind !== 'markdown' || resp.breakText) {
        part = { kind: 'markdown', text: '' };
        resp.parts.push(part);
        resp.breakText = false;
      }
      part.text += ev.delta;
      break;
    }
    case 'reasoning': resp.reasoning += ev.delta || ''; break;
    case 'tool': {
      let found = null;
      for (const p of resp.parts) if (p.kind === 'tools') { found = p.items.find(i => i.id === ev.id); if (found) break; }
      if (found) Object.assign(found, { label: ev.label || found.label, state: ev.state || found.state, detail: ev.detail ?? found.detail });
      else {
        let part = lastPart(resp);
        if (!part || part.kind !== 'tools') { part = { kind: 'tools', items: [] }; resp.parts.push(part); }
        part.items.push({ id: ev.id || uid('tool'), name: ev.name, label: ev.label || ev.name, state: ev.state || 'running', detail: ev.detail || '' });
      }
      resp.breakText = true;
      break;
    }
    case 'edit': {
      if (ev.turnId) resp.turnId = ev.turnId;
      const i = resp.edits.findIndex(e => e.id === ev.id);
      const rec = { id: ev.id, turnId: ev.turnId, path: ev.path, to: ev.to, kind: ev.kind, added: ev.added, removed: ev.removed, state: ev.state, error: ev.error, projectId: ev.projectId };
      if (i >= 0) resp.edits[i] = { ...resp.edits[i], ...rec }; else resp.edits.push(rec);
      break;
    }
    case 'round': {
      if (ev.retry && resp.roundSnap) {
        const s = resp.roundSnap;
        resp.parts = resp.parts.slice(0, s.count);
        const last = lastPart(resp);
        if (last?.kind === 'markdown' && s.lastText != null) last.text = s.lastText;
        resp.breakText = s.breakText;
      } else {
        if ((ev.index || 1) > 1 && lastPart(resp)?.kind === 'markdown') resp.breakText = true;
        const last = lastPart(resp);
        resp.roundSnap = { count: resp.parts.length, lastText: last?.kind === 'markdown' ? last.text : null, breakText: resp.breakText };
      }
      break;
    }
    default: break;
  }
}

function markdownText(resp) { return resp.parts.filter(p => p.kind === 'markdown').map(p => p.text).join('\n\n').trim(); }

// ------------------------------------------------------------------ controller

class ChatController {
  constructor() {
    this.events = new Emitter();
    this.session = null;
    this.busy = false;
    this.abort = null;
    this.activeResponse = null;
    this.pendingProject = null;
    this.followProject = null;
    this.loadToken = 0;
    this.saveTimer = 0;
  }

  get turns() { return this.session?.turns || []; }
  find(id) { return this.turns.find(t => t.id === id) || null; }

  /** Loads the latest session of the open project (after migrating X Coder 5's conversation once). */
  async loadForProject(project = workspace.project) {
    const token = ++this.loadToken;
    if (!project) { this.setSession(null); return; }
    await chatHistory.migrateLegacy(project.id);
    const latest = await chatHistory.latest(project.id);
    if (token !== this.loadToken) return;
    this.setSession(latest || chatHistory.create(project.id));
  }

  setSession(session) {
    // a turn saved while it was running was interrupted (reload, closed tab): show it as stopped
    for (const t of session?.turns || []) {
      if (t.role === 'assistant' && t.state === 'running' && t !== this.activeResponse) { t.state = 'stopped'; t.aborted = true; t.status = ''; }
      if (t.role === 'assistant' && !t.state) t.state = t.error ? 'error' : 'done';
    }
    this.session = session;
    this.events.emit('session', session);
  }

  newSession() {
    ++this.loadToken; // an explicit choice wins over a pending project load
    if (this.busy) this.stop();
    const pid = workspace.id;
    if (this.session && !this.session.turns.length && this.session.projectId === pid) { this.events.emit('session', this.session); return this.session; }
    this.setSession(pid ? chatHistory.create(pid) : null);
    return this.session;
  }

  async openSession(id) {
    ++this.loadToken;
    const s = await chatHistory.get(id);
    if (!s) throw new Error('This chat is no longer available.');
    if (this.busy) this.stop();
    this.setSession(s);
    return s;
  }

  async deleteSession(id) {
    await chatHistory.remove(id);
    if (this.session?.id === id) this.setSession(chatHistory.create(workspace.id));
  }

  /** Clears the current chat (removes it from history) and starts a new one. */
  async clear() {
    ++this.loadToken;
    if (this.busy) this.stop();
    const id = this.session?.id;
    if (id && this.session.turns.length) await chatHistory.remove(id).catch(() => {});
    this.setSession(workspace.id ? chatHistory.create(workspace.id) : null);
  }

  scheduleSave(session = this.session, delay = 400) {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(session), delay);
  }
  async saveNow(session = this.session) {
    clearTimeout(this.saveTimer);
    if (!session?.turns?.length) return;
    try { await chatHistory.save(session); this.events.emit('saved', session); }
    catch (err) { log.warn('Could not save the chat', err); }
  }

  emitTurn(turn) { this.events.emit('turn', turn); }

  setBusy(busy, text = '') {
    this.busy = busy;
    this.events.emit('busy', busy);
    bus.emit('ai:status', busy ? { state: 'busy', text: text || 'Thinking…' } : { state: 'idle', text: 'Ready' });
  }

  /** History for the engine: prior user prompts + final assistant texts (most recent turns). */
  historyBefore(requestId) {
    const turns = this.turns;
    const end = requestId ? turns.findIndex(t => t.id === requestId) : turns.length;
    const out = [];
    for (const t of turns.slice(0, end < 0 ? turns.length : end)) {
      if (t.local) continue;
      if (t.role === 'user') out.push({ role: 'user', text: t.text });
      else if (t.text || markdownText(t)) out.push({ role: 'assistant', text: t.text || markdownText(t) });
    }
    return out.slice(-HISTORY_TURNS);
  }

  /** Adds a local (no model call) exchange, e.g. /help. */
  addLocalExchange(display, answer) {
    if (!this.session) this.newSession();
    if (!this.session) return;
    const req = { id: uid('q'), role: 'user', text: display, display, attachments: [], time: Date.now(), local: true };
    const resp = { id: uid('r'), role: 'assistant', requestId: req.id, parts: [{ kind: 'markdown', text: answer }], text: answer, state: 'done', local: true, model: 'X Coder', edits: [], reasoning: '', time: Date.now() };
    this.session.turns.push(req, resp);
    this.emitTurn(req); this.emitTurn(resp);
  }

  /**
   * Sends a request. opts: { text (prompt for the engine), display (what the user typed), attachments, mode, model,
   * command, retryOf }. Resolves with the engine result, or null when it failed / was stopped.
   */
  async send({ text = '', display, attachments = [], mode, model, command } = {}) {
    if (this.busy) throw new Error('X Coder is still working on the previous request. Stop it first.');
    if (!workspace.project) throw new Error('Open a project first.');
    ++this.loadToken; // a pending project load must not replace the session this request goes into
    if (!this.session || this.session.projectId !== workspace.id) this.setSession(chatHistory.create(workspace.id));
    const session = this.session;
    mode = ['ask', 'edit', 'agent'].includes(mode) ? mode : settings.get('xcoder.ai.mode', 'agent');
    const request = { id: uid('q'), role: 'user', text: String(text), display: display && display !== text ? display : undefined, command, attachments: [...attachments], mode, time: Date.now() };
    if (!session.title) session.title = titleFrom(display || text);
    session.turns.push(request);
    this.emitTurn(request);
    return this.run(session, request, { mode, model });
  }

  async run(session, request, { mode, model }) {
    const resp = newResponse(request, mode);
    this.lastResponse = resp;
    session.turns.push(resp);
    this.emitTurn(resp);
    this.activeResponse = resp;
    const abort = new AbortController();
    this.abort = abort;
    this.setBusy(true);
    this.saveNow(session);
    // UI updates are batched: streamed markdown is re-rendered at most every 40 ms (every 150 ms for long answers)
    let timer = 0, chars = 0;
    const flush = () => { timer = 0; this.emitTurn(resp); };
    const onEvent = ev => {
      applyEvent(resp, ev);
      if (ev?.type === 'text') chars += ev.delta?.length || 0;
      if (ev?.type === 'status') this.events.emit('status', resp.status);
      if (ev?.type === 'project') this.onAgentProject(ev, session);
      if (!timer) timer = setTimeout(flush, chars > 20000 ? 150 : 40);
    };
    let result = null;
    try {
      const engine = await getEngine();
      const history = this.historyBefore(request.id);
      result = await engine.runTurn({
        sessionId: session.id, prompt: request.text, mode, model: model || engine.catalog?.current?.() || 'auto',
        attachments: request.attachments.filter(a => a.type !== 'image' || a.dataUrl), history, signal: abort.signal, onEvent
      });
      clearTimeout(timer); timer = 0;
      resp.turnId = result?.turnId || resp.turnId;
      resp.text = String(result?.text ?? markdownText(resp));
      if (!resp.parts.some(p => p.kind === 'markdown') && resp.text) resp.parts.push({ kind: 'markdown', text: resp.text });
      if (Array.isArray(result?.edits)) resp.edits = result.edits.map(e => ({ ...e }));
      if (result?.model && !resp.model) resp.model = modelLabel({ model: result.model, provider: result.provider });
      resp.provider = result?.provider || resp.provider;
      resp.usage = result?.usage || null;
      resp.stopped = result?.stopped || null;
      resp.state = 'done';
    } catch (err) {
      clearTimeout(timer); timer = 0;
      const aborted = err?.name === 'AbortError' || abort.signal.aborted;
      resp.turnId = err?.turnId || resp.turnId;
      if (Array.isArray(err?.edits)) resp.edits = err.edits.map(e => ({ ...e }));
      resp.text = String(err?.text || markdownText(resp) || '');
      if (aborted) {
        resp.state = 'stopped';
        resp.aborted = true;
      } else {
        resp.state = 'error';
        resp.error = String(err?.message || err || 'The request failed.');
        log.warn(`Chat request failed: ${resp.error}`);
      }
    } finally {
      for (const p of resp.parts) if (p.kind === 'tools') for (const i of p.items) if (i.state === 'running') i.state = resp.state === 'done' ? 'done' : 'error';
      delete resp.roundSnap; delete resp.breakText;
      resp.status = '';
      if (this.abort === abort) this.abort = null;
      if (this.activeResponse === resp) this.activeResponse = null;
      this.setBusy(false);
      this.emitTurn(resp);
      this.saveNow(session);
      this.afterTurn(resp);
    }
    return result;
  }

  afterTurn(resp) {
    if (this.pendingProject && this.pendingProject !== this.session?.projectId) {
      const pid = this.pendingProject;
      this.pendingProject = null;
      if (workspace.id === pid) this.loadForProject(workspace.project);
    }
    this.pendingProject = null;
    this.followProject = null;
    if (resp.state === 'done' && settings.get('xcoder.voice.autoSpeak', false) && resp.text) {
      import('./voice.js').then(({ voice }) => voice.speak(resp.text)).catch(err => log.warn(`Auto speak failed: ${err.message}`));
    }
  }

  /** The agent created a project mid-turn: the conversation moves with it. */
  onAgentProject(ev, session) {
    if (!ev?.id) return;
    this.followProject = ev.id;
    if (session.projectId !== ev.id) {
      session.projectId = ev.id;
      if (this.pendingProject === ev.id) this.pendingProject = null;
      this.events.emit('session', session);
    }
  }

  /** bus 'project:opened' */
  onProjectOpened(project) {
    if (this.busy) {
      // A running turn keeps streaming into its session; switch after it finishes unless the agent moved it here.
      if (this.followProject === project.id || this.session?.projectId === project.id) return;
      this.pendingProject = project.id;
      return;
    }
    this.loadForProject(project);
  }

  stop() {
    if (!this.abort) return false;
    try { this.abort.abort(); } catch {}
    return true;
  }

  /** Regenerates a response (removes it and the turns after it, then re-sends its request). */
  async retry(responseId) {
    if (this.busy) return null;
    const session = this.session;
    const i = session?.turns.findIndex(t => t.id === responseId) ?? -1;
    if (i < 0) return null;
    const resp = session.turns[i];
    const request = session.turns.find(t => t.id === resp.requestId) || session.turns[i - 1];
    if (!request || request.role !== 'user' || request.local || resp.local) return null;
    const reqIndex = session.turns.indexOf(request);
    session.turns.splice(reqIndex + 1);
    this.events.emit('session', session);
    return this.run(session, request, { mode: resp.mode || request.mode });
  }

  vote(responseId, value) {
    const t = this.find(responseId);
    if (!t) return;
    t.vote = t.vote === value ? null : value;
    this.emitTurn(t);
    this.scheduleSave();
    log.info(`Response ${value === 'up' ? 'helpful' : 'unhelpful'} feedback recorded locally.`);
  }

  // ---------------------------------------------------------------- edit review

  async keep(responseId, editId) {
    const t = this.find(responseId);
    if (!t?.turnId) throw new Error('These edits are no longer available.');
    const engine = await getEngine();
    const res = await engine.edits.keep(t.turnId, editId);
    if (res?.edits) t.edits = res.edits;
    this.emitTurn(t); this.scheduleSave();
    return res;
  }

  async undo(responseId, editId) {
    const t = this.find(responseId);
    if (!t?.turnId) throw new Error('These edits are no longer available.');
    const engine = await getEngine();
    const res = await engine.edits.undo(t.turnId, editId);
    if (res?.edits) t.edits = res.edits;
    this.emitTurn(t); this.scheduleSave();
    return res;
  }

  async openEditDiff(responseId, editId) {
    const t = this.find(responseId);
    if (!t?.turnId) throw new Error('These edits are no longer available.');
    const engine = await getEngine();
    const d = await engine.edits.diff(t.turnId, editId);
    if (!d) throw new Error('The changes of this file are no longer available.');
    const [{ codeEditor }, { editors }] = await Promise.all([import('../editor/api.js'), import('../workbench/editors.js')]);
    const id = `xcoder-edit-${editId}`;
    const key = `diff:${id}`;
    const edit = t.edits.find(e => e.id === editId);
    const reviewable = edit && ['pending', 'applied'].includes(edit.state);
    const act = fn => async () => {
      try { await fn(); } finally { await editors.close(key, { force: true }).catch(() => {}); }
    };
    await codeEditor.openDiff({
      id, title: d.title, path: d.path, original: d.original ?? '', modified: d.modified ?? '', readOnly: true,
      actions: reviewable ? [
        { label: 'Keep', icon: 'check', run: act(() => this.keep(responseId, editId)) },
        { label: 'Undo', icon: 'discard', run: act(() => this.undo(responseId, editId)) }
      ] : []
    });
    return key;
  }

  /** Engine edit records changed (keep/undo from elsewhere, e.g. the diff editor or Undo Last AI Edits). */
  onEditsChanged({ turnId, edits } = {}) {
    if (!turnId) return;
    for (const t of this.turns) {
      if (t.role === 'assistant' && t.turnId === turnId && Array.isArray(edits)) {
        t.edits = edits.map(e => ({ ...e }));
        this.emitTurn(t);
        this.scheduleSave();
      }
    }
  }
}

export const chat = new ChatController();
export { markdownText };

/**
 * The single send path for the chat input, suggestions, editor commands and ai.ask(): expands slash commands
 * and #variables, handles local commands (/clear, /help), then sends. Resolves with the engine result or null.
 */
export async function submitChat({ text = '', attachments = [], mode, model } = {}) {
  const req = await prepareRequest({ text, attachments, mode: mode || settings.get('xcoder.ai.mode', 'agent') });
  if (req.local === 'clear') { await chat.clear(); return null; }
  if (req.local === 'help') { chat.addLocalExchange(req.display, HELP_TEXT); return null; }
  if (!req.text.trim() && !req.attachments.length) return null;
  return chat.send({ text: req.text || 'Look at the attached context.', display: req.display || undefined, attachments: req.attachments, mode: req.mode, model, command: req.command });
}
