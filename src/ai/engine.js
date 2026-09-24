// X Coder AI engine — the contract between the chat UI (src/ai/chat*.js) and the agent engine.
// Implemented by agent.js (loop), protocol.js (tool tags), prompt.js, context.js, tools.js, edits.js,
// checkpoints.js, providers.js (Worker router + Puter), catalog.js, engine-match.js (SEARCH/REPLACE matcher),
// engine-shell.js (read-only run_command shell) and engine-verify.js (automatic post-edit checks). Works headlessly (fetch + IndexedDB only).
//
// runTurn(request) drives one user request to completion (possibly many model/tool rounds):
//   request = {
//     sessionId, prompt,                      // user text (slash command already expanded by the UI)
//     mode: 'ask' | 'edit' | 'agent',
//     model: 'auto' | selection id from catalog.list(),
//     attachments: [ {type:'file', path} | {type:'image', name, dataUrl, mime} | {type:'text', name, text}
//                    | {type:'selection', path, text, startLine, endLine} | {type:'problems'} | {type:'terminal'}
//                    | {type:'codebase'} | {type:'git'} ],
//     history: [{ role: 'user'|'assistant', text }],     // prior turns of this chat session (UI provides)
//     signal: AbortSignal,
//     turnId?,                                            // optional id to use for this turn (else generated)
//     onEvent(event)                                      // streamed progress for the UI
//   }
//   events:
//     { type: 'status', text }                                        e.g. 'Thinking…', 'Reading src/app.js' ('' = idle)
//     { type: 'route', provider, model, source, routeId }             which model is answering
//     { type: 'text', delta }                                         visible markdown text (tool tags already removed)
//     { type: 'reasoning', delta }                                    optional model reasoning summary text
//     { type: 'tool', id, name, label, state: 'running'|'done'|'error', detail }   e.g. label 'Read src/app.js, lines 1 to 120'
//                                                                     (name 'auto_check' = the automatic check of changed files
//                                                                      that Agent mode runs before finishing)
//     { type: 'edit', id, turnId, path, to?, kind: 'create'|'modify'|'delete'|'rename', added, removed, state: 'pending'|'applied'|'failed', error? }
//     { type: 'project', id, name }                                   agent created/switched to a new project
//     { type: 'round', index, retry? }                                a new model round started (UI may start a new text block)
//   resolves → { turnId, text, edits: [{id, turnId, path, to, kind, added, removed, state}], checkpointId, provider, model,
//                usage: {prompt, completion, total}, rounds, mode, stopped }
//   rejects  → Error (AbortError when cancelled; err.turnId / err.edits / err.text carry partial progress).
//              Files are never left half-written.
//
// Edit review (Edit mode stages edits as 'pending'; Agent mode applies them immediately):
//   edits.keep(turnId, editId?)   → writes pending edits (Edit mode) / accepts applied ones      → { edits, written, errors }
//   edits.undo(turnId, editId?)   → discards pending / restores applied edits from the checkpoint → { edits, restored, errors }
//   edits.diff(turnId, editId)    → { path, original, modified, title } for the diff editor
//   edits.list(turnId)            → current edit records of a turn;  edits.onChange(fn) → disposer ({turnId, edits})
//   edits.latestUndoableTurn()    → turnId of the newest turn with applied edits in this project (or null)
//   edits.changedSince(turnId)    → paths changed again after the AI edited them (undo would discard those changes)
//   Edit states after review: 'kept' | 'undone' | 'discarded'.
//
// Model catalog:
//   catalog.refresh({ force }) → Promise<void>      loads Worker /models + Puter models (cached 5 min)
//   catalog.list() → [{ id, label, description, group, provider, source: 'auto'|'worker'|'puter', vision, context }]
//   catalog.current() → selection id (settings 'xcoder.ai.model', default 'auto');  catalog.select(id)
//   catalog.status() → { worker: 'ready'|'unreachable'|'unconfigured'|'loading', puter: 'signed-in'|'signed-out'|'unavailable', providers: [...] }
//   catalog.onChange(fn) → disposer
//
// Also exported: isBusy(), activate() (registers settings + commands; also done on import), testProviders().
// Bus: 'ai:status' ({state, text}); 'ai:editsApplied' ({summary, paths, turnId, projectId}) after Agent edits / Keep.

import { settings } from '../core/settings.js';
import { commands } from '../core/commands.js';
import { bus } from '../core/events.js';
import { workspace } from '../core/workspace.js';
import { puterSignedIn } from '../core/puter.js';
import { runTurn as agentRunTurn, isBusy as agentBusy, aiLog } from './agent.js';
import { catalog as modelCatalog, DEFAULT_ROUTER } from './catalog.js';
import { fetchWorkerJSON, cleanRouterUrl } from './providers.js';
import { keep, undo, diff, listTurnEdits, latestUndoableTurn, editEvents, changedSince } from './edits.js';

export async function runTurn(request) { return agentRunTurn(request); }
export const isBusy = () => agentBusy();

export const edits = {
  async keep(turnId, editId) { return keep(turnId, editId); },
  async undo(turnId, editId) { return undo(turnId, editId); },
  async diff(turnId, editId) { return diff(turnId, editId); },
  list(turnId) { return listTurnEdits(turnId); },
  onChange(fn) { return editEvents.on('changed', fn); },
  latestUndoableTurn(projectId) { return latestUndoableTurn(projectId); },
  changedSince(turnId) { return changedSince(turnId); }
};

export const catalog = modelCatalog;

// ------------------------------------------------------------------ settings

const CATEGORY = 'Extensions/X Coder AI';
function registerSettings() {
  settings.register([
    { key: 'xcoder.ai.routerUrl', type: 'string', default: DEFAULT_ROUTER, title: 'Router Url', category: CATEGORY, order: 1, common: true,
      description: 'URL of your X Coder AI router (a Cloudflare Worker). Provider API keys stay on the router and never reach the browser. Leave empty to use only Puter models.' },
    { key: 'xcoder.ai.model', type: 'string', default: 'auto', title: 'Model', category: CATEGORY, order: 2,
      description: 'The chat model: "auto", "worker:auto", "worker:<provider>:<model>", "puter:auto" or "puter:<model>". Pick it from the model picker in the chat input.' },
    { key: 'xcoder.ai.mode', type: 'enum', default: 'agent', title: 'Mode', category: CATEGORY, order: 3, common: true,
      enum: ['ask', 'edit', 'agent'], enumLabels: ['Ask', 'Edit', 'Agent'],
      enumDescriptions: ['Answers questions; can read the project but never changes files.', 'Proposes edits that you review and keep or undo.', 'Works autonomously: reads, edits, runs the preview and fixes problems. Every change can be undone.'],
      description: 'How X Coder AI works on your requests.' },
    { key: 'xcoder.ai.autoPreference', type: 'enum', default: 'best', title: 'Auto Preference', category: CATEGORY, order: 4,
      enum: ['best', 'router'], enumLabels: ['Best Model', 'Router First'],
      enumDescriptions: ['When signed in to X Coder Cloud, use the strongest Puter model first and fall back to the router.', 'Use the X Coder router first and fall back to Puter models.'],
      description: 'Which route "Auto" tries first. Busy or failing routes automatically hand the same conversation to the next one.' },
    { key: 'xcoder.ai.maxSteps', type: 'number', default: 30, min: 1, max: 100, integer: true, title: 'Max Steps', category: CATEGORY, order: 5,
      description: 'Maximum number of tool rounds for one request in Agent mode (Ask and Edit mode use at most 8).' },
    { key: 'xcoder.ai.temperature', type: 'number', default: 0.2, min: 0, max: 1, title: 'Temperature', category: CATEGORY, order: 6,
      description: 'Sampling temperature. Lower values give more focused, deterministic code.' },
    { key: 'xcoder.ai.customInstructions', type: 'text', default: '', title: 'Custom Instructions', category: CATEGORY, order: 7,
      description: 'Instructions added to every request (coding style, preferred libraries, answer language…). AGENTS.md, .github/copilot-instructions.md and .xcoder/instructions.md in the project are used too.' },
    { key: 'xcoder.ai.includeOpenEditors', type: 'boolean', default: true, title: 'Include Open Editors', category: CATEGORY, order: 8,
      description: 'Send the list of open editors and the active file (with the cursor position or selection) as context.' },
    { key: 'xcoder.ai.requestTimeoutSeconds', type: 'number', default: 120, min: 20, max: 600, integer: true, title: 'Request Timeout Seconds', category: CATEGORY, order: 9,
      description: 'How long to wait for a model to start or continue answering before trying the next route.' }
  ]);
}

// ------------------------------------------------------------------ commands

async function ui() {
  const [{ notify }, { quickInput }, { dialogs }] = await Promise.all([
    import('../platform/notifications.js'), import('../platform/quickinput.js'), import('../platform/dialogs.js')
  ]);
  return { notify, quickInput, dialogs };
}

const STATUS_ICON = { ready: 'pass', configured: 'pass', 'signed-in': 'pass', unreachable: 'error', unconfigured: 'circle-slash', 'signed-out': 'account', unavailable: 'circle-slash', loading: 'loading' };

/** Refreshes the catalog, probes the router and Puter; shows a summary quick pick unless opts.silent. */
export async function testProviders({ silent = false } = {}) {
  aiLog.info('Testing AI providers…');
  let progress = null;
  if (!silent) { try { progress = (await ui()).notify.progress('Testing AI providers…', { source: 'X Coder AI' }); } catch {} }
  let st, latencyMs = null, healthError = '';
  try {
    await modelCatalog.refresh({ force: true });
    st = modelCatalog.status();
    if (st.routerUrl) {
      const t0 = performance.now();
      try { await fetchWorkerJSON(st.routerUrl, '/health', { timeoutMs: 10000 }); latencyMs = Math.round(performance.now() - t0); }
      catch (err) { healthError = err.message; }
    }
  } finally { try { progress?.close?.(); } catch {} }
  aiLog.info(`Router ${st.worker}${latencyMs != null ? ` in ${latencyMs} ms` : ''} · ${st.routerUrl || '(no URL set)'}${healthError ? ` · ${healthError}` : ''}${st.error && st.worker !== 'ready' ? ` · ${st.error}` : ''}`);
  for (const p of st.providers.filter(x => x.source !== 'puter')) aiLog.info(`  ${p.label}: ${p.status}${p.modelCount != null ? ` · ${p.modelCount} models` : ''}${p.error ? ` · ${String(p.error).slice(0, 160)}` : ''}`);
  aiLog.info(`Puter: ${st.puter}${st.models.puter ? ` · ${st.models.puter} models` : ''}${st.puterError ? ` — ${st.puterError}` : ''}`);
  const result = { worker: st.worker, puter: st.puter, providers: st.providers, models: st.models, latencyMs, routerUrl: st.routerUrl, error: healthError || (st.worker === 'ready' ? '' : st.error) };
  if (silent) return result;
  try {
    const { quickInput, notify } = await ui();
    const workerProviders = st.providers.filter(p => p.source === 'worker');
    const puterRow = st.providers.find(p => p.source === 'puter');
    const items = [
      { kind: 'separator', label: 'X Coder Router' },
      {
        label: st.routerUrl ? 'Router' : 'Router not configured', icon: STATUS_ICON[st.worker] || 'info',
        description: st.worker === 'ready' ? `Connected${latencyMs != null ? ` · ${latencyMs} ms` : ''}` : st.worker === 'unconfigured' ? 'Not set' : 'Unreachable',
        detail: st.routerUrl || 'Set a router URL to use free server-side models', run: () => commands.execute('xcoder.ai.configureRouter')
      },
      ...workerProviders.filter(p => p.kind !== 'media').map(p => ({
        label: p.label, icon: p.configured && !/error|fail|cool/i.test(p.status) ? 'pass' : p.configured ? 'warning' : 'circle-slash',
        description: String(p.status).replace(/_/g, ' '), detail: p.configured ? `${p.modelCount ?? 0} coding model(s)${p.error ? ` · ${String(p.error).slice(0, 80)}` : ''}` : 'No API key configured on the router'
      })),
      { kind: 'separator', label: 'Puter (X Coder Cloud)' },
      {
        label: 'Puter AI', icon: STATUS_ICON[st.puter] || 'info',
        description: puterRow?.status || st.puter,
        detail: st.puter === 'signed-in' ? `${st.models.puter} models · best: ${modelCatalog.bestPuterModel()?.name || '—'}` : st.puter === 'signed-out' ? 'Sign in from Accounts to use Claude, GPT, Gemini and more' : (st.puterError || 'Puter could not load (offline or blocked)')
      },
      { kind: 'separator', label: '' },
      { label: 'Show Details in Output', icon: 'output', run: () => aiLog.show() },
      { label: 'Configure Router…', icon: 'server', run: () => commands.execute('xcoder.ai.configureRouter') }
    ];
    const ready = st.worker === 'ready' || st.puter === 'signed-in';
    quickInput.pick(items, { title: 'X Coder AI: Providers', placeholder: ready ? 'AI is ready — select an item for more' : 'No AI route is ready — configure the router or sign in to X Coder Cloud' })
      .then(pick => pick?.run?.()).catch(() => {});
    if (!ready) notify.warn('No X Coder AI route is ready. Check the router URL or sign in to X Coder Cloud.', { source: 'X Coder AI', actions: [{ label: 'Configure Router', run: () => commands.execute('xcoder.ai.configureRouter') }] });
  } catch (err) { aiLog.warn('Could not show the provider summary', err); }
  return result;
}

function validateRouterUrl(v) {
  const s = String(v || '').trim();
  if (!s) return null; // empty = router disabled
  let u;
  try { u = new URL(s); } catch { return 'Enter a full URL, e.g. https://your-router.workers.dev'; }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return 'The router URL must use https:// (http:// is only allowed for localhost).';
  if (u.search || u.hash) return 'Remove the query string or #fragment from the URL.';
  return null;
}

async function configureRouter(value) {
  const { quickInput, notify } = await ui();
  let url = value;
  if (url == null) {
    url = await quickInput.input({
      title: 'X Coder AI: Router URL',
      prompt: 'URL of your X Coder AI router (Cloudflare Worker). Leave empty to use Puter models only. Press Enter to test and save.',
      placeholder: DEFAULT_ROUTER, value: settings.get('xcoder.ai.routerUrl', DEFAULT_ROUTER), validate: validateRouterUrl
    });
    if (url == null) return null;
  }
  const err = validateRouterUrl(url);
  if (err) { notify.error(err, { source: 'X Coder AI' }); return null; }
  const clean = cleanRouterUrl(url);
  settings.set('xcoder.ai.routerUrl', clean);
  if (!clean) { notify.info('The X Coder AI router is disabled. Sign in to X Coder Cloud to use Puter models.', { source: 'X Coder AI' }); modelCatalog.refresh({ force: true }).catch(() => {}); return { url: '', ok: true }; }
  try {
    const health = await fetchWorkerJSON(clean, '/health', { timeoutMs: 12000 });
    const n = (health?.providers || []).filter(p => p.configured && p.kind !== 'media').length;
    notify.info(`Connected to the X Coder AI router${n ? ` — ${n} provider${n === 1 ? '' : 's'} ready` : ''}.`, { source: 'X Coder AI' });
    modelCatalog.refresh({ force: true }).catch(() => {});
    return { url: clean, ok: true };
  } catch (e) {
    notify.warn(`Saved, but the router did not respond: ${e.message}`, { source: 'X Coder AI', actions: [{ label: 'Retry', run: () => testProviders() }] });
    modelCatalog.refresh({ force: true }).catch(() => {});
    return { url: clean, ok: false, error: e.message };
  }
}

async function refreshModels() {
  const { notify } = await ui();
  const progress = notify.progress('Refreshing AI models…', { source: 'X Coder AI' });
  try { await modelCatalog.refresh({ force: true }); } finally { try { progress?.close?.(); } catch {} }
  const st = modelCatalog.status();
  const parts = [];
  if (st.worker === 'ready') parts.push(`${st.models.worker} router model${st.models.worker === 1 ? '' : 's'}`);
  if (st.puter === 'signed-in') parts.push(`${st.models.puter} Puter model${st.models.puter === 1 ? '' : 's'}`);
  if (parts.length) notify.info(`Models refreshed: ${parts.join(', ')}.`, { source: 'X Coder AI' });
  else notify.warn(`No models are available: ${st.worker === 'unconfigured' ? 'the router URL is not set' : st.error || 'the router is unreachable'}${st.puter === 'signed-out' ? ', and you are not signed in to X Coder Cloud' : ''}.`, { source: 'X Coder AI', actions: [{ label: 'Test Providers', run: () => testProviders() }] });
  return { worker: st.models.worker, puter: st.models.puter };
}

async function undoLastEdits({ confirm = true } = {}) {
  const { notify, dialogs } = await ui();
  const turnId = await latestUndoableTurn(workspace.id);
  if (!turnId) { notify.info('There are no X Coder AI edits to undo in this project.', { source: 'X Coder AI' }); return null; }
  const list = listTurnEdits(turnId).filter(e => e.state === 'applied' || e.state === 'kept');
  if (confirm) {
    const later = changedSince(turnId);
    const ok = await dialogs.confirm({
      message: 'Undo the last X Coder AI edits?',
      detail: (list.length ? `This restores ${list.length} change${list.length === 1 ? '' : 's'}: ${list.slice(0, 5).map(e => e.to ? `${e.path} → ${e.to}` : e.path).join(', ')}${list.length > 5 ? '…' : ''}.` : 'Files will be restored to how they were before the last AI request.')
        + (later.length ? ` ${later.join(', ')} ${later.length === 1 ? 'was' : 'were'} changed after the AI edit — those later changes will be lost too.` : ''),
      primary: 'Undo Edits'
    });
    if (!ok) return null;
  }
  const res = await undo(turnId);
  if (res.errors.length) notify.warn(`Restored ${res.restored.length} file(s); ${res.errors.length} could not be restored: ${res.errors.join('; ')}`, { source: 'X Coder AI' });
  else notify.info(`Restored ${res.restored.length} file${res.restored.length === 1 ? '' : 's'} changed by X Coder AI.`, { source: 'X Coder AI' });
  return { turnId, ...res };
}

function registerCommands() {
  const defs = [
    { id: 'xcoder.ai.testProviders', title: 'Test AI Providers', category: 'X Coder AI', icon: 'pulse', run: opts => testProviders(opts || {}) },
    { id: 'xcoder.ai.configureRouter', title: 'Configure AI Router…', category: 'X Coder AI', icon: 'server', run: value => configureRouter(typeof value === 'string' ? value : undefined) },
    { id: 'xcoder.ai.refreshModels', title: 'Refresh Models', category: 'X Coder AI', icon: 'refresh', run: () => refreshModels() },
    { id: 'xcoder.ai.undoLastEdits', title: 'Undo Last AI Edits', category: 'X Coder AI', icon: 'discard', run: opts => undoLastEdits(opts || {}) }
  ];
  for (const d of defs) if (!commands.has(d.id)) commands.register(d);
}

// ------------------------------------------------------------------ activation

let activated = false;
export async function activate() {
  if (activated) return;
  activated = true;
  registerSettings();
  registerCommands();
  settings.onChange('xcoder.ai.routerUrl', () => modelCatalog.refresh({ force: true }).catch(() => {}));
  settings.onChange('xcoder.ai.autoPreference', () => modelCatalog.refresh().catch(() => {}));
  // Load the catalog in the background once the workbench is up (never delays startup).
  let signedIn = null;
  const warm = () => setTimeout(() => modelCatalog.refresh().catch(() => {}), 600);
  if (document.documentElement.dataset.xcoderVersion) warm(); else bus.once('workbench:ready', warm);
  // Pick up X Coder Cloud sign-in/out (Puter models appear/disappear in the picker).
  setInterval(() => {
    const now = puterSignedIn();
    if (signedIn !== null && now !== signedIn) modelCatalog.refresh({ force: true }).catch(() => {});
    signedIn = now;
  }, 5000);
}

// Registering on import makes the engine usable by whichever feature loads it first.
activate().catch(err => console.error('[X Coder AI] engine activation failed', err));
