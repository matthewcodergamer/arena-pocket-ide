// X Coder AI feature entry: the Chat view container (Secondary Side Bar / phone overlay), chat commands,
// editor menus, the status bar item, voice settings and project/session wiring. The agent engine lives in
// src/ai/engine.js (another module); this file only consumes its documented contract.

import { bus } from '../core/events.js';
import { commands } from '../core/commands.js';
import { menus } from '../core/menus.js';
import { settings } from '../core/settings.js';
import { workspace } from '../core/workspace.js';
import { relativeTime, pickFiles } from '../core/dom.js';
import { output } from '../core/output.js';
import { views } from '../workbench/views.js';
import { statusbar } from '../workbench/statusbar.js';
import { showContextMenu } from '../platform/contextmenu.js';
import { chat, submitChat, getEngine, markdownText } from './chatSession.js';
import { chatHistory } from './history.js';
import { renderChatView, getChatInput, chatHasFocus } from './chatView.js';
import { pickMode, pickModel, handleFiles, currentMode, modeInfo, currentModelLabel, selectionAttachment } from './chatInput.js';
import { voice, registerVoiceSettings } from './voice.js';
import { ai } from './api.js';

const log = output.channel('X Coder AI');
const CONTAINER = 'workbench.view.chat';
const VIEW = 'workbench.panel.chat.view.copilot';
const CATEGORY = 'Chat';

async function notify(kind, msg, opts = {}) {
  try { const { notify: n } = await import('../platform/notifications.js'); return n[kind](msg, { source: 'X Coder AI', ...opts }); } catch { return null; }
}

async function openChat({ focus = true } = {}) { await ai.open({ focus }); }

// ------------------------------------------------------------------ editor commands (Explain, Fix, …)

const CODE_COMMANDS = {
  'xcoder.chat.explain': { slash: 'explain', title: 'Explain', mode: 'ask', icon: 'comment-discussion' },
  'xcoder.chat.fix': { slash: 'fix', title: 'Fix', edits: true, icon: 'wrench' },
  'xcoder.chat.generateTests': { slash: 'tests', title: 'Generate Tests', edits: true, icon: 'beaker' },
  'xcoder.chat.generateDocs': { slash: 'doc', title: 'Generate Docs', edits: true, icon: 'book' },
  'xcoder.chat.review': { slash: 'review', title: 'Review', mode: 'ask', icon: 'eye' }
};

async function runCodeCommand(id, arg) {
  const def = CODE_COMMANDS[id];
  const argPath = typeof arg === 'string' ? arg : arg?.path;
  const attachments = [];
  const sel = await selectionAttachment().catch(() => null);
  if (sel && (!argPath || sel.path === argPath)) attachments.push(sel);
  else {
    let path = argPath;
    if (!path) { try { const { editors } = await import('../workbench/editors.js'); path = editors.activePath; } catch {} }
    if (path && workspace.fs?.isFile(path)) attachments.push({ type: 'file', path });
  }
  if (!attachments.length) { notify('info', `Open a file (or select code) to use X Coder: ${def.title}.`); await openChat(); return null; }
  if (id === 'xcoder.chat.fix') attachments.push({ type: 'problems' });
  const mode = def.mode || (def.edits && currentMode() === 'ask' ? 'edit' : currentMode());
  await openChat({ focus: false });
  if (chat.busy) { notify('info', 'X Coder is still working on the previous request.'); return null; }
  return submitChat({ text: `/${def.slash}`, attachments, mode });
}

// ------------------------------------------------------------------ history quick pick

async function showHistory() {
  const { quickInput } = await import('../platform/quickinput.js');
  const pid = workspace.id;
  if (!pid) { notify('info', 'Open a project to see its chats.'); return null; }
  if (chat.session?.turns.length) await chat.saveNow();
  const pick = await quickInput.pick(async () => {
    const list = await chatHistory.list(pid);
    if (!list.length) return [{ id: '__none', label: 'No saved chats in this project yet', disabled: true, icon: 'info' }];
    return list.map(s => ({
      id: s.id, label: s.title || 'New Chat', icon: s.id === chat.session?.id ? 'comment-discussion' : 'history',
      description: `${relativeTime(s.updatedAt || s.createdAt)} · ${Math.ceil((s.turns?.length || 0) / 2)} request${Math.ceil((s.turns?.length || 0) / 2) === 1 ? '' : 's'}${s.id === chat.session?.id ? ' · current' : ''}`,
      buttons: [{ icon: 'trash', tooltip: 'Delete Chat', run: async item => { await chat.deleteSession(item.id); return 'refresh'; } }]
    }));
  }, { title: 'Chat History', placeholder: 'Select a chat to restore', matchOnDescription: true });
  if (!pick || pick.disabled || pick.id === '__none') return null;
  await chat.openSession(pick.id);
  await openChat({ focus: false });
  return pick.id;
}

// ------------------------------------------------------------------ status bar

let statusItem = null;
let engineState = { busy: false };

function routeProblem() {
  try {
    const eng = engineState.engine;
    const st = eng?.catalog?.status?.();
    if (!st || st.loading || st.worker === 'loading') return null;
    if (st.worker === 'ready' || st.puter === 'signed-in') return null;
    return `${st.worker === 'unconfigured' ? 'No AI router is configured' : `The X Coder AI router is unreachable${st.error ? ` (${st.error})` : ''}`}; ${st.puter === 'signed-in' ? '' : st.puter === 'signed-out' ? 'you are not signed in to X Coder Cloud' : 'Puter AI is unavailable'}.`;
  } catch { return null; }
}

function updateStatus() {
  if (!statusItem) return;
  const problem = routeProblem();
  const mode = modeInfo(currentMode()).label;
  const model = currentModelLabel();
  if (chat.busy) statusItem.update({ text: '$(loading~spin) X Coder', tooltip: `X Coder AI is working… (${mode} · ${model}) — click for options`, kind: undefined });
  else if (problem) statusItem.update({ text: '$(warning) X Coder', tooltip: `X Coder AI: ${problem} Click to test providers or configure the router.`, kind: undefined });
  else statusItem.update({ text: '$(chat-sparkle) X Coder', tooltip: `X Coder AI — ${mode} mode · ${model}`, kind: undefined });
}

function statusMenu(anchor) {
  const items = [
    { label: 'Open Chat', icon: 'chat-sparkle', run: () => openChat() },
    { label: 'New Chat', icon: 'plus', run: () => commands.execute('workbench.action.chat.newChat') },
    chat.busy ? { label: 'Stop Request', icon: 'debug-stop', run: () => chat.stop() } : null,
    { separator: true },
    { label: `Model: ${currentModelLabel()}`, icon: 'sparkle', run: () => pickModel() },
    { label: `Mode: ${modeInfo(currentMode()).label}`, icon: modeInfo(currentMode()).icon, run: () => pickMode() },
    { separator: true },
    { label: 'Test AI Providers', icon: 'pulse', run: () => commands.execute('xcoder.ai.testProviders') },
    { label: 'AI Settings', icon: 'settings-gear', run: () => commands.execute('workbench.action.openSettings', '@id:xcoder.ai.') }
  ].filter(Boolean);
  const el = anchor?.querySelector?.('.statusbar-item-label') || anchor;
  showContextMenu(items, el ? { anchor: el, align: 'right' } : { x: window.innerWidth - 10, y: window.innerHeight - 30 });
}

// ------------------------------------------------------------------ commands

function moreActions() {
  return [
    { label: 'Clear Chat', icon: 'clear-all', run: () => commands.execute('workbench.action.chat.clear') },
    { separator: true },
    { label: `Model: ${currentModelLabel()}…`, icon: 'sparkle', run: () => pickModel() },
    { label: `Mode: ${modeInfo(currentMode()).label}…`, icon: 'robot', run: () => pickMode() },
    { separator: true },
    { label: 'Voice Settings', icon: 'unmute', run: () => commands.execute('xcoder.voice.configure') },
    { label: 'AI Settings', icon: 'settings-gear', run: () => commands.execute('workbench.action.openSettings', '@id:xcoder.ai.') },
    { label: 'Test AI Providers', icon: 'pulse', run: () => commands.execute('xcoder.ai.testProviders') }
  ];
}

function lastResponse() { return [...chat.turns].reverse().find(t => t.role === 'assistant' && t.state !== 'running') || null; }

function registerCommands() {
  // Mod+L means "New Chat" only while the chat has focus (elsewhere the key keeps its usual meaning);
  // the command itself stays available in the Command Palette and menus.
  const newChatWhen = () => {
    const e = window.event;
    const isModL = e?.type === 'keydown' && (e.code === 'KeyL' || String(e.key).toLowerCase() === 'l') && (e.metaKey || e.ctrlKey);
    return isModL ? chatHasFocus() : true;
  };
  const defs = [
    { id: 'workbench.action.chat.open', title: 'Open Chat', category: CATEGORY, icon: 'chat-sparkle',
      run: async arg => {
        await openChat();
        const opts = typeof arg === 'string' ? { query: arg, isPartialQuery: true } : (arg || {});
        if (Array.isArray(opts.attachments)) for (const a of opts.attachments) ai.attach(a);
        if (opts.mode && ['ask', 'edit', 'agent'].includes(opts.mode)) settings.set('xcoder.ai.mode', opts.mode);
        if (opts.query) {
          if (opts.isPartialQuery) { const input = getChatInput(); input?.setText(opts.query); input?.focus(); }
          else return submitChat({ text: opts.query, mode: opts.mode });
        }
        return null;
      } },
    { id: 'workbench.action.chat.newChat', title: 'New Chat', category: CATEGORY, icon: 'plus', keybinding: 'Mod+L', allowInInput: true, when: newChatWhen,
      run: async () => { chat.newSession(); await openChat(); } },
    { id: 'workbench.action.chat.history', title: 'Show Chats…', category: CATEGORY, icon: 'history', run: () => showHistory() },
    { id: 'workbench.action.chat.clear', title: 'Clear Chat', category: CATEGORY, icon: 'clear-all', run: async () => { await chat.clear(); } },
    ...Object.entries(CODE_COMMANDS).map(([id, d]) => ({ id, title: d.title, category: 'X Coder', icon: d.icon, run: arg => runCodeCommand(id, arg) })),
    { id: 'xcoder.chat.analyzeProject', title: 'Analyze Project', category: 'X Coder', icon: 'search',
      run: async () => { await openChat({ focus: false }); return submitChat({ text: '/analyze', mode: currentMode() === 'edit' ? 'ask' : currentMode() }); } },
    { id: 'xcoder.chat.attachFile', title: 'Attach File…', category: CATEGORY, icon: 'attach',
      run: async () => { await openChat({ focus: false }); await handleFiles(await pickFiles({ multiple: true })); getChatInput()?.focus(); } },
    { id: 'xcoder.chat.attachImage', title: 'Attach Photo or Image…', category: CATEGORY, icon: 'file-media',
      run: async () => { await openChat({ focus: false }); await handleFiles(await pickFiles({ accept: 'image/*', multiple: true })); getChatInput()?.focus(); } },
    { id: 'xcoder.chat.takePhoto', title: 'Take Photo', category: CATEGORY, icon: 'device-camera',
      run: async () => { await openChat({ focus: false }); await handleFiles(await pickFiles({ accept: 'image/*', capture: 'environment', multiple: false })); getChatInput()?.focus(); } },
    { id: 'xcoder.chat.selectModel', title: 'Select Model…', category: CATEGORY, icon: 'sparkle', run: () => pickModel() },
    { id: 'xcoder.chat.selectMode', title: 'Select Mode…', category: CATEGORY, icon: 'robot', run: () => pickMode() },
    { id: 'xcoder.chat.startVoice', title: 'Start Voice Input', category: CATEGORY, icon: 'mic',
      run: async () => { await openChat({ focus: false }); const input = getChatInput(); if (input) input.toggleDictation(); } },
    { id: 'xcoder.chat.readAloud', title: 'Read Aloud', category: CATEGORY, icon: 'unmute',
      run: async id => {
        const t = (typeof id === 'string' && chat.find(id)) || lastResponse();
        if (!t) { notify('info', 'There is no answer to read yet.'); return; }
        await voice.speak(t.text || markdownText(t)).catch(err => notify('warn', err.message));
      } },
    { id: 'xcoder.chat.stopSpeaking', title: 'Stop Speaking', category: CATEGORY, icon: 'debug-stop', run: () => voice.stop() },
    { id: 'xcoder.voice.configure', title: 'Configure Voice…', category: 'Voice', icon: 'unmute', run: () => voice.configure() }
  ];
  for (const d of defs) commands.register(d);
}

function registerMenus() {
  const codeItems = Object.entries(CODE_COMMANDS).map(([command, d], i) => ({ command, title: d.title, group: '1_chat', order: i + 1 }));
  menus.appendMany('editor/context/xcoder', codeItems);
  menus.append('editor/context', { submenu: 'editor/context/xcoder', title: 'X Coder', group: '0_xcoder', order: 1 });
  menus.append('editor/title/more', { submenu: 'editor/context/xcoder', title: 'X Coder', group: '8_xcoder', order: 1, when: ctx => ctx?.type === 'file' });
  menus.append('editor/title/more', { command: 'workbench.action.chat.open', title: 'Open Chat', group: '8_xcoder', order: 2 });
}

// ------------------------------------------------------------------ activation

let activated = false;
export async function activate() {
  if (activated) return;
  activated = true;
  registerVoiceSettings();
  try {
    const engine = await getEngine();
    await engine.activate?.();
    engineState.engine = engine;
    engine.catalog?.onChange?.(() => { updateStatus(); bus.emit('ai:status', routeProblem() ? { state: 'error', text: routeProblem() } : { state: chat.busy ? 'busy' : 'ready', text: chat.busy ? 'Working…' : 'Ready' }); });
    engine.edits?.onChange?.(ev => chat.onEditsChanged(ev));
  } catch (err) {
    log.error('X Coder AI engine unavailable — the chat shows the error when you send a message.', err);
  }

  views.registerContainer({ id: CONTAINER, title: 'Chat', icon: 'chat-sparkle', order: 6, location: 'aux', keybinding: 'Ctrl+Mod+I' });
  views.registerView({
    id: VIEW, containerId: CONTAINER, name: 'Chat', containerTitle: 'Chat',
    render: body => renderChatView(body),
    actions: [
      { icon: 'plus', title: 'New Chat', command: 'workbench.action.chat.newChat', run: () => commands.execute('workbench.action.chat.newChat') },
      { icon: 'history', title: 'Chat History', command: 'workbench.action.chat.history', run: () => commands.execute('workbench.action.chat.history') }
    ],
    moreActions
  });
  registerCommands();
  registerMenus();

  statusItem = statusbar.add({ id: 'xcoder.ai.status', alignment: 'right', priority: 400, text: '$(chat-sparkle) X Coder', tooltip: 'X Coder AI', run: el => statusMenu(el) });
  updateStatus();
  chat.events.on('busy', () => updateStatus());
  settings.onChange('xcoder.ai.mode', () => updateStatus());
  settings.onChange('xcoder.ai.model', () => updateStatus());

  bus.on('project:opened', p => chat.onProjectOpened(p));
  bus.on('project:willClose', () => { if (chat.session?.turns.length) chat.saveNow(); });
  window.addEventListener('pagehide', () => { if (chat.session?.turns.length) chat.saveNow(); });
  if (workspace.project) chat.loadForProject(workspace.project);
}

