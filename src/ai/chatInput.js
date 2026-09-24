// Chat input part (VS Code chat input look): attached-context row ("Add Context…" + chips, with the implicit
// current-file chip and its eye toggle), auto-growing textarea, mode and model picker pills, microphone and
// Send / Stop. Also: "/" and "#" suggestion menus, hold-Send-to-switch-model, paste/drop of images and files,
// and a per-project draft.
//
//   const input = new ChatInput({ onSubmit({ text, attachments, mode, model }), onStop() })
//   input.el · input.focus() · input.setText(text) · input.setBusy(bool) · input.addAttachments(list)
//   inputState.attachments (shared, survives view re-renders) · addPendingAttachment(att) (ai.attach)
//   pickMode() · pickModel() · handleFiles(files) · attachMenuItems()

import { h, codicon, clear, debounce, isTouch, pickFiles, fuzzyMatch, uid } from '../core/dom.js';
import { bus, Emitter } from '../core/events.js';
import { settings } from '../core/settings.js';
import { workspace } from '../core/workspace.js';
import { posix } from '../core/path.js';
import { output } from '../core/output.js';
import { fileIconHtml } from '../workbench/icons.js';
import { showContextMenu } from '../platform/contextmenu.js';
import { attachmentChip } from './chatRender.js';
import { classifyFiles, keyOf, MAX_IMAGES, describe, addFilesToProject } from './attachments.js';
import { SLASH_COMMANDS, ANALYZE_PROMPT, engineIfLoaded, getEngine } from './chatSession.js';
import { voice } from './voice.js';

const log = output.channel('X Coder AI');
const DRAFT_KEY = 'xcoder.chat.draft.v6:';
const MODES = [
  { id: 'agent', label: 'Agent', icon: 'robot', description: 'Builds, runs and fixes autonomously. Every change can be undone.' },
  { id: 'ask', label: 'Ask', icon: 'comment-discussion', description: 'Answers questions only — never changes your files.' },
  { id: 'edit', label: 'Edit', icon: 'edit', description: 'Proposes edits that you review, then keep or undo.' }
];
const CONTEXT_ITEMS = [
  { name: 'file', description: 'Pick a project file', icon: 'file' },
  { name: 'selection', description: 'The selected text in the editor', icon: 'selection' },
  { name: 'problems', description: 'Errors and warnings in the project', icon: 'warning' },
  { name: 'terminal', description: 'Recent terminal output', icon: 'terminal' },
  { name: 'git', description: 'Changes since the last pull or push', icon: 'source-control' },
  { name: 'codebase', description: 'Search the whole project for relevant code', icon: 'folder-library' }
];

async function notify(kind, msg, opts = {}) {
  try { const { notify: n } = await import('../platform/notifications.js'); return n[kind](msg, { source: 'X Coder AI', ...opts }); } catch { return null; }
}

// ------------------------------------------------------------------ shared state

export const inputEvents = new Emitter(); // 'attachments' | 'focus' | 'text' (text)
export const inputState = { attachments: [], implicit: true };

export function currentMode() { const m = settings.get('xcoder.ai.mode', 'agent'); return MODES.some(x => x.id === m) ? m : 'agent'; }
export const modeInfo = id => MODES.find(m => m.id === id) || MODES[0];

export function addPendingAttachment(att) {
  if (!att?.type) return false;
  if (att.type === 'image' && inputState.attachments.filter(a => a.type === 'image').length >= MAX_IMAGES) {
    notify('warn', `At most ${MAX_IMAGES} images can be attached to one message.`);
    return false;
  }
  const key = keyOf(att);
  if (inputState.attachments.some(a => keyOf(a) === key)) return false;
  inputState.attachments.push({ ...att, _id: uid('att') });
  inputEvents.emit('attachments');
  return true;
}
export function removeAttachment(att) {
  inputState.attachments = inputState.attachments.filter(a => a !== att && a._id !== att?._id);
  inputEvents.emit('attachments');
}
export function clearAttachments() { inputState.attachments = []; inputEvents.emit('attachments'); }

// ------------------------------------------------------------------ popover (mode menu, suggestions, hold picker)

function popover(anchor, items, { onPick, className = '', placement = 'above', align = 'left', minWidth = 200, maxWidth = 0, title = '', modal = true } = {}) {
  const menu = h('div', { class: `monaco-menu chat-picker-menu ${className}`, role: 'listbox', tabindex: '-1' });
  if (title) menu.append(h('div', { class: 'menu-title' }, title));
  const rows = items.map((it, i) => {
    const row = h('div', { class: ['action-item', 'chat-picker-item', it.checked && 'checked'], role: 'option', 'aria-selected': String(!!it.checked), 'data-index': i, 'data-id': it.id ?? '' },
      h('span', { class: 'menu-item-check' }, it.checked ? codicon('check') : it.iconHtml ? h('span', { html: it.iconHtml }) : it.icon ? codicon(it.icon) : null),
      h('span', { class: 'chat-picker-text' }, h('span', { class: 'action-label' }, it.label), it.description ? h('span', { class: 'chat-picker-description' }, it.description) : null));
    row.addEventListener('click', e => { e.stopPropagation(); pick(i); });
    row.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') setActive(i); });
    return row;
  });
  menu.append(...rows);
  const layer = h('div', { class: ['context-view-layer', 'chat-popover-layer', !modal && 'passive'] }, menu);
  let active = -1, closed = false;
  function setActive(i) { active = i; rows.forEach((r, n) => r.classList.toggle('focused', n === i)); rows[i]?.scrollIntoView?.({ block: 'nearest' }); }
  function close() { if (closed) return; closed = true; layer.remove(); document.removeEventListener('keydown', onKey, true); api.onClose?.(); }
  function pick(i) { const it = items[i]; close(); if (it) onPick?.(it, i); }
  const onKey = e => {
    if (!modal) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % rows.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((active - 1 + rows.length) % rows.length); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); e.stopPropagation(); pick(active); }
  };
  layer.addEventListener('pointerdown', e => { if (e.target === layer) { e.preventDefault(); close(); } });
  if (!modal) menu.addEventListener('mousedown', e => e.preventDefault()); // keep the textarea focused
  document.body.append(layer);
  document.addEventListener('keydown', onKey, true);
  // position next to the anchor
  const r = anchor.getBoundingClientRect();
  menu.style.minWidth = `${Math.min(minWidth, window.innerWidth - 16)}px`;
  if (maxWidth) menu.style.maxWidth = `${Math.min(maxWidth, window.innerWidth - 16)}px`;
  const mw = Math.min(menu.offsetWidth, window.innerWidth - 16);
  let left = align === 'right' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  menu.style.left = `${left}px`;
  const mh = menu.offsetHeight;
  if (placement === 'above' && r.top - mh - 6 > 4) menu.style.top = `${r.top - mh - 6}px`;
  else if (placement === 'above') { menu.style.top = '4px'; menu.style.maxHeight = `${Math.max(120, r.top - 10)}px`; }
  else menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - mh - 4)}px`;
  const checked = items.findIndex(it => it.checked);
  if (checked >= 0 && modal && !isTouch()) setActive(checked);
  const api = { close, setActive, pick, get active() { return active; }, rows, menu, layer, get closed() { return closed; } };
  return api;
}

// ------------------------------------------------------------------ pickers

/** Mode dropdown (anchor) or quick pick (command palette). */
export async function pickMode(anchor) {
  const cur = currentMode();
  if (anchor) {
    return new Promise(resolve => {
      const p = popover(anchor, MODES.map(m => ({ ...m, checked: m.id === cur })), { onPick: it => { settings.set('xcoder.ai.mode', it.id); resolve(it.id); }, className: 'chat-mode-menu', minWidth: 240, maxWidth: 300 });
      p.onClose = () => setTimeout(() => resolve(null), 0);
    });
  }
  const { quickInput } = await import('../platform/quickinput.js');
  const pick = await quickInput.pick(MODES.map(m => ({ id: m.id, label: m.label, icon: m.id === cur ? 'check' : m.icon, description: m.id === cur ? 'Current' : '', detail: m.description })), { title: 'Chat Mode', placeholder: 'Select how X Coder works on your requests' });
  if (pick) settings.set('xcoder.ai.mode', pick.id);
  return pick?.id || null;
}

export function modelList() {
  try { return engineIfLoaded()?.catalog?.list?.() || [{ id: 'auto', label: 'Auto', group: 'Auto', description: 'Best available route' }]; }
  catch { return [{ id: 'auto', label: 'Auto', group: 'Auto' }]; }
}
export function currentModelId() { try { return engineIfLoaded()?.catalog?.current?.() || settings.get('xcoder.ai.model', 'auto'); } catch { return 'auto'; } }
export function currentModelLabel() {
  const id = currentModelId();
  const m = modelList().find(x => x.id === id);
  return m?.label || (id === 'auto' ? 'Auto' : id.split(':').pop());
}
function selectModel(id) {
  const eng = engineIfLoaded();
  try { if (eng?.catalog?.select) eng.catalog.select(id); else settings.set('xcoder.ai.model', id); } catch { settings.set('xcoder.ai.model', id); }
  inputEvents.emit('model', id);
}

/** Model quick pick grouped like VS Code's model picker. */
export async function pickModel() {
  const { quickInput } = await import('../platform/quickinput.js');
  const engine = await getEngine().catch(() => null);
  const refresh = engine?.catalog?.refresh?.().catch(() => {});
  const build = () => {
    const cur = currentModelId();
    const out = [];
    let group = null;
    for (const m of modelList()) {
      if (m.group !== group) { group = m.group; out.push({ kind: 'separator', label: group || '' }); }
      out.push({ id: m.id, label: m.label, description: [m.id === cur ? 'Current' : '', m.description || '', m.vision ? 'vision' : ''].filter(Boolean).join(' · '), icon: m.id === cur ? 'check' : m.source === 'auto' ? 'sparkle' : 'blank', disabled: !!m.unavailable && m.id !== cur });
    }
    out.push({ kind: 'separator', label: '' },
      { id: '__refresh', label: 'Refresh Models', icon: 'refresh', alwaysShow: true },
      { id: '__test', label: 'Test AI Providers', icon: 'pulse', alwaysShow: true },
      { id: '__router', label: 'Configure AI Router…', icon: 'server', alwaysShow: true });
    return out;
  };
  if (refresh && !modelList().some(m => m.source === 'worker' || m.source === 'puter')) await Promise.race([refresh, new Promise(r => setTimeout(r, 2500))]);
  const pick = await quickInput.pick(build(), { title: 'Select Model', placeholder: 'Pick the model for X Coder AI (Auto fails over between routes)', matchOnDescription: true, activeItem: { id: currentModelId() } });
  if (!pick) return null;
  const { commands } = await import('../core/commands.js');
  if (pick.id === '__refresh') { commands.execute('xcoder.ai.refreshModels'); return null; }
  if (pick.id === '__test') { commands.execute('xcoder.ai.testProviders'); return null; }
  if (pick.id === '__router') { commands.execute('xcoder.ai.configureRouter'); return null; }
  selectModel(pick.id);
  return pick.id;
}

/** Short list for the hold-Send gesture (ported from X Coder 5). */
export function quickModelOptions() {
  const list = modelList().filter(m => !m.unavailable);
  const cur = currentModelId();
  const out = [], used = new Set();
  out.push({ id: 'auto', label: 'Auto', description: 'Best available route' }); used.add('auto');
  const concrete = list.filter(m => m.source !== 'auto' && !/:auto$/.test(m.id));
  const add = (label, re) => { const m = concrete.find(x => re.test(`${x.label} ${x.id}`) && !used.has(x.id)); if (m) { out.push({ id: m.id, label, description: m.label }); used.add(m.id); } };
  add('Claude', /claude|anthropic/i); add('ChatGPT', /gpt|openai|codex/i); add('Gemini', /gemini/i); add('Grok', /grok|xai/i); add('Coder', /coder|codestral|devstral|qwen|deepseek/i);
  for (const m of concrete) { if (out.length >= 5) break; if (!used.has(m.id)) { out.push({ id: m.id, label: m.label, description: m.description || '' }); used.add(m.id); } }
  if (!used.has(cur)) { const m = list.find(x => x.id === cur); out.push({ id: cur, label: 'Current', description: m?.label || cur }); }
  return out.slice(0, 7).map(o => ({ ...o, checked: o.id === cur }));
}

// ------------------------------------------------------------------ files, folders, ZIPs

/** Imports a project (folder or ZIP) as a new project, then asks X Coder to analyze it. */
export async function importProjectAndAnalyze(kind, file) {
  const { files } = await import('../views/files-api.js');
  let project = null;
  if (kind === 'zip') project = await files.importZip(file, { newProject: true });
  else { const res = await files.importFolder({ newProject: true }); project = res?.project || (res?.id ? res : null); }
  if (!project) return null;
  const { ai } = await import('./api.js');
  await ai.ask(ANALYZE_PROMPT, { mode: currentMode() === 'edit' ? 'ask' : currentMode(), attachments: [{ type: 'codebase' }], newSession: true });
  return project;
}

/** Adds picked / pasted / dropped files to the chat (images, text) — ZIPs are imported as a new project. */
export async function handleFiles(files) {
  const list = [...(files || [])];
  if (!list.length) return;
  const images = inputState.attachments.filter(a => a.type === 'image').length;
  const { attachments, archives, unsupported } = await classifyFiles(list, { imageBudget: Math.max(0, MAX_IMAGES - images) });
  for (const a of attachments) addPendingAttachment(a);
  if (archives.length) {
    try { await importProjectAndAnalyze('zip', archives[0]); } catch (err) { notify('error', `Could not import ${archives[0].name}: ${err.message}`); }
  }
  if (unsupported.length) {
    const binaries = unsupported.map(u => u.file).filter(f => f.size > 0);
    notify('warn', unsupported.map(u => u.reason).join(' '), binaries.length && workspace.fs ? {
      actions: [{ label: binaries.length === 1 ? 'Add to Project' : `Add ${binaries.length} Files to Project`, run: async () => {
        try { const paths = await addFilesToProject(binaries); notify('info', `Added ${paths.join(', ')} to the project.`); } catch (err) { notify('error', err.message); }
      } }]
    } : {});
  }
}

async function codeEditorApi() { return (await import('../editor/api.js')).codeEditor; }

/** Attachment for the editor selection (or null). */
export async function selectionAttachment() {
  const ed = (await codeEditorApi()).getActive();
  const sel = ed?.getSelection?.();
  if (!ed?.path || !sel || sel.to <= sel.from) return null;
  return { type: 'selection', path: ed.path, text: sel.text, startLine: sel.startLine, endLine: sel.endLine };
}

async function pickProjectFile() {
  const fs = workspace.fs;
  if (!fs) { notify('info', 'Open a project first.'); return null; }
  const { quickInput } = await import('../platform/quickinput.js');
  const items = fs.files().map(r => ({ id: r.path, label: posix.basename(r.path), description: posix.dirname(r.path), iconHtml: safeIcon(r.path) }));
  const pick = await quickInput.pick(items, { title: 'Attach File', placeholder: 'Search project files to add as context', matchOnDescription: true });
  return pick ? { type: 'file', path: pick.id } : null;
}
function safeIcon(p) { try { return fileIconHtml(p); } catch { return ''; } }

/** Adds a context variable (#file, #selection, …) as an attachment. */
export async function addContextVariable(name) {
  if (name === 'file') { const a = await pickProjectFile(); if (a) addPendingAttachment(a); return a; }
  if (name === 'selection') {
    const a = await selectionAttachment();
    if (!a) { notify('info', 'Select some code in the editor first.'); return null; }
    addPendingAttachment(a); return a;
  }
  if (name === 'currentFile') {
    const ed = (await codeEditorApi()).getActive();
    const { editors } = await import('../workbench/editors.js');
    const path = ed?.path || editors.activePath;
    if (!path) { notify('info', 'Open a file in the editor first.'); return null; }
    const a = { type: 'file', path }; addPendingAttachment(a); return a;
  }
  const a = { type: name };
  addPendingAttachment(a);
  return a;
}

export function attachMenuItems() {
  return [
    { label: 'Files…', icon: 'file', run: async () => handleFiles(await pickFiles({ multiple: true })) },
    { label: 'Photos or Camera…', icon: 'file-media', run: async () => handleFiles(await pickFiles({ accept: 'image/*', multiple: true })) },
    { label: 'Take Photo', icon: 'device-camera', run: async () => handleFiles(await pickFiles({ accept: 'image/*', capture: 'environment', multiple: false })) },
    { label: 'Folder…', icon: 'folder', run: () => importProjectAndAnalyze('folder').catch(err => notify('error', err.message)) },
    { label: 'Project ZIP…', icon: 'file-zip', run: async () => { const [f] = await pickFiles({ accept: '.zip,application/zip', multiple: false }); if (f) importProjectAndAnalyze('zip', f).catch(err => notify('error', err.message)); } },
    { separator: true },
    { label: 'Current File', icon: 'file-code', run: () => addContextVariable('currentFile') },
    { label: 'Selection', icon: 'selection', run: () => addContextVariable('selection') },
    { label: 'Problems', icon: 'warning', run: () => addContextVariable('problems') },
    { label: 'Terminal Output', icon: 'terminal', run: () => addContextVariable('terminal') },
    { label: 'Git Changes', icon: 'source-control', run: () => addContextVariable('git') },
    { label: 'Codebase', icon: 'folder-library', run: () => addContextVariable('codebase') },
    { label: 'Project Files…', icon: 'go-to-file', run: () => addContextVariable('file') }
  ];
}

// ------------------------------------------------------------------ the input part

export class ChatInput {
  constructor({ onSubmit, onStop, previewImage, promptHistory } = {}) {
    this.onSubmit = onSubmit; this.onStop = onStop; this.previewImage = previewImage; this.promptHistory = promptHistory;
    this.historyIndex = null;
    this.busy = false;
    this.dictation = null;
    this.disposers = [];
    this.projectId = null;
    this.suggest = null;
    this.build();
    this.loadDraft();
    this.renderChips();
    this.renderPickers();
    this.disposers.push(
      inputEvents.on('attachments', () => this.renderChips()),
      inputEvents.on('model', () => this.renderPickers()),
      settings.onChange('xcoder.ai.mode', () => this.renderPickers()),
      settings.onChange('xcoder.ai.model', () => this.renderPickers()),
      bus.on('editor:activeChanged', () => this.renderChips()),
      bus.on('editor:cursor', debounce(() => this.renderChips(), 200)),
      bus.on('project:opened', () => this.loadDraft()),
      voice.events.on('change', () => this.renderMic())
    );
    getEngine().then(e => { const off = e?.catalog?.onChange?.(() => this.renderPickers()); if (off) this.disposers.push(off); this.renderPickers(); }).catch(() => {});
  }

  build() {
    this.textarea = h('textarea', {
      class: 'interactive-input chat-input-textarea', rows: '1', placeholder: 'Ask X Coder… (/ for commands, # for context)',
      'aria-label': 'Chat input — Enter to send, Shift+Enter for a new line', autocapitalize: 'sentences', autocorrect: 'on', spellcheck: 'true', enterkeyhint: 'send'
    });
    this.chips = h('div', { class: 'chat-attached-context', role: 'list', 'aria-label': 'Attached context' });
    this.attachBtn = h('a', { class: 'chat-attach-button', role: 'button', tabindex: '0', title: 'Add Context… (#)', 'aria-label': 'Add Context' }, codicon('attach'), h('span', { class: 'label' }, 'Add Context…'));
    this.modePill = h('a', { class: 'chat-picker-pill chat-mode-picker', role: 'button', tabindex: '0', 'aria-haspopup': 'listbox' });
    this.modelPill = h('a', { class: 'chat-picker-pill chat-model-picker', role: 'button', tabindex: '0', 'aria-haspopup': 'listbox' });
    this.micBtn = h('a', { class: 'action-label codicon codicon-mic chat-mic-button', role: 'button', tabindex: '0', title: 'Start Voice Input', 'aria-label': 'Start Voice Input' });
    this.sendBtn = h('a', { class: 'action-label codicon codicon-send chat-send-button', role: 'button', tabindex: '0', title: 'Send (Enter) — hold to switch model', 'aria-label': 'Send' });
    this.container = h('div', { class: 'chat-input-container' },
      this.chips, this.textarea,
      h('div', { class: 'chat-input-toolbars' },
        h('div', { class: 'chat-execute-toolbar-left' }, this.modePill, this.modelPill),
        h('div', { class: 'chat-execute-toolbar monaco-toolbar' }, this.micBtn, this.sendBtn)));
    this.el = h('div', { class: 'interactive-input-part' }, this.container);

    const ta = this.textarea;
    ta.addEventListener('input', () => { this.historyIndex = null; this.autoGrow(); this.saveDraft(); this.updateSuggest(); this.updateSendState(); });
    ta.addEventListener('keydown', e => this.onKeyDown(e));
    ta.addEventListener('focus', () => { this.container.classList.add('focused'); inputEvents.emit('focus'); });
    ta.addEventListener('blur', () => { this.container.classList.remove('focused'); setTimeout(() => { if (document.activeElement !== ta) this.closeSuggest(); }, 180); });
    ta.addEventListener('click', () => this.updateSuggest());
    ta.addEventListener('paste', e => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); handleFiles(files); }
    });
    this.container.addEventListener('click', e => { if (e.target === this.container || e.target.classList.contains('chat-input-toolbars')) ta.focus(); });

    const click = (el, fn) => {
      el.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); fn(e); });
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); } });
    };
    click(this.attachBtn, () => showContextMenu(attachMenuItems(), { anchor: this.attachBtn, align: 'left', title: 'Add Context' }));
    click(this.modePill, () => pickMode(this.modePill).then(() => this.focusIfDesktop()));
    click(this.modelPill, () => pickModel().then(() => this.focusIfDesktop()));
    click(this.micBtn, () => this.toggleDictation());
    this.bindSend();
    this.autoGrow();
    this.updateSendState();
  }

  focusIfDesktop() { if (!isTouch()) this.textarea.focus(); }

  // ---------------------------------------------------------------- send / hold-to-switch-model
  bindSend() {
    const b = this.sendBtn;
    const hold = { timer: 0, open: null, long: false, pointer: null };
    const closeHold = commit => {
      const p = hold.open; hold.open = null;
      if (!p) return;
      const i = p.active;
      p.close();
      if (commit && i >= 0) { const opt = hold.options[i]; if (opt) { selectModel(opt.id); notify('info', `Model: ${opt.description && opt.label !== 'Auto' ? opt.description : opt.label}`); } }
    };
    const nearest = e => {
      const rows = hold.open?.rows || [];
      let best = -1, d = 1e9;
      rows.forEach((row, i) => {
        const r = row.getBoundingClientRect();
        const dist = Math.abs(e.clientY - (r.top + r.bottom) / 2);
        if (e.clientX >= r.left - 40 && e.clientX <= r.right + 40 && dist < d) { d = dist; best = i; }
      });
      return d < 48 ? best : -1;
    };
    b.addEventListener('pointerdown', e => {
      if (this.busy || e.button > 0) return;
      hold.long = false; hold.pointer = e.pointerId;
      clearTimeout(hold.timer);
      hold.timer = setTimeout(() => {
        hold.long = true;
        hold.options = quickModelOptions();
        hold.open = popover(b, hold.options, { className: 'chat-quick-model-picker', align: 'right', minWidth: 220, maxWidth: 320, title: 'Switch Model', modal: false, onPick: opt => selectModel(opt.id) });
        navigator.vibrate?.(10);
        try { b.setPointerCapture(e.pointerId); } catch {}
      }, 420);
    });
    b.addEventListener('pointermove', e => { if (hold.open && e.pointerId === hold.pointer) { e.preventDefault(); hold.open.setActive(nearest(e)); } });
    b.addEventListener('pointerup', e => {
      clearTimeout(hold.timer);
      if (hold.open) { e.preventDefault(); closeHold(true); setTimeout(() => { hold.long = false; }, 80); }
    });
    b.addEventListener('pointercancel', () => { clearTimeout(hold.timer); closeHold(false); hold.long = false; });
    b.addEventListener('contextmenu', e => e.preventDefault());
    b.addEventListener('click', e => {
      e.preventDefault();
      if (hold.long) { hold.long = false; return; }
      if (this.busy) this.onStop?.(); else this.submit();
    });
    b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (this.busy) this.onStop?.(); else this.submit(); } });
  }

  onKeyDown(e) {
    if (this.suggest && !this.suggest.closed) {
      const s = this.suggest;
      if (e.key === 'ArrowDown') { e.preventDefault(); s.setActive((s.active + 1) % s.rows.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); s.setActive((s.active - 1 + s.rows.length) % s.rows.length); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && s.active >= 0) { e.preventDefault(); s.pick(s.active); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeSuggest(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.altKey) {
      e.preventDefault();
      if (!this.busy) this.submit();
      return;
    }
    // ↑ / ↓ at the start / end of the input recall earlier prompts (like VS Code's chat input history)
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const ta = this.textarea;
      const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
      const atEnd = ta.selectionStart === ta.value.length;
      if ((e.key === 'ArrowUp' && atStart) || (e.key === 'ArrowDown' && atEnd && this.historyIndex != null)) {
        const prompts = this.promptHistory?.() || [];
        if (!prompts.length) return;
        if (this.historyIndex == null) { this.historyDraft = ta.value; this.historyIndex = prompts.length; }
        const next = this.historyIndex + (e.key === 'ArrowUp' ? -1 : 1);
        if (next < 0) return;
        e.preventDefault();
        this.historyIndex = next;
        if (next >= prompts.length) { this.historyIndex = null; this.setText(this.historyDraft || ''); }
        else this.setText(prompts[next]);
        const pos = e.key === 'ArrowUp' ? 0 : ta.value.length;
        ta.setSelectionRange(pos, pos);
      }
    }
    if (e.key === 'Escape' && this.busy) { e.preventDefault(); this.onStop?.(); }
  }

  /** Implicit current-file / selection context (VS Code's "Current file" chip). */
  async implicitAttachment() {
    try {
      const { editors } = await import('../workbench/editors.js');
      const path = editors.activePath;
      if (!path || !workspace.fs?.isFile(path)) return null;
      const sel = await selectionAttachment();
      if (sel && sel.path === path) return sel;
      return { type: 'file', path };
    } catch { return null; }
  }

  async submit() {
    const text = this.textarea.value.trim();
    const attachments = inputState.attachments.map(({ _id, ...a }) => a);
    if (!text && !attachments.length) { this.textarea.focus(); return; }
    if (inputState.implicit) {
      const imp = await this.implicitAttachment();
      if (imp && !attachments.some(a => keyOf(a) === keyOf(imp) || (a.type === 'file' && a.path === imp.path))) attachments.unshift({ ...imp, implicit: true });
    }
    this.stopDictation();
    this.closeSuggest();
    const payload = { text, attachments, mode: currentMode(), model: currentModelId() };
    this.setText('');
    clearAttachments();
    try { await this.onSubmit?.(payload); }
    catch (err) {
      // restore what the user typed when sending failed before it started
      if (!this.textarea.value) this.setText(text);
      for (const a of payload.attachments) if (!a.implicit) addPendingAttachment(a);
      notify('error', err.message || String(err));
    }
  }

  setBusy(busy) {
    this.busy = busy;
    this.sendBtn.classList.toggle('codicon-send', !busy);
    this.sendBtn.classList.toggle('codicon-debug-stop', busy);
    this.sendBtn.classList.toggle('stop', busy);
    const label = busy ? 'Stop (Esc)' : 'Send (Enter) — hold to switch model';
    this.sendBtn.title = label; this.sendBtn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    this.container.classList.toggle('busy', busy);
    this.updateSendState();
  }

  updateSendState() {
    const empty = !this.textarea.value.trim() && !inputState.attachments.length;
    this.sendBtn.classList.toggle('disabled-look', !this.busy && empty);
  }

  focus() { this.textarea.focus({ preventScroll: true }); const n = this.textarea.value.length; try { this.textarea.setSelectionRange(n, n); } catch {} }
  getText() { return this.textarea.value; }
  setText(text) { this.textarea.value = text || ''; this.autoGrow(); this.saveDraft(); this.updateSendState(); }

  autoGrow() {
    const ta = this.textarea;
    ta.style.height = 'auto';
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    const max = lh * 8 + 8;
    ta.style.height = `${Math.min(max, Math.max(lh + 4, ta.scrollHeight))}px`;
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
  }

  // ---------------------------------------------------------------- draft per project
  draftKey() { return `${DRAFT_KEY}${workspace.id || 'none'}`; }
  loadDraft() {
    if (this.projectId === workspace.id && this.projectId) return;
    this.projectId = workspace.id;
    let text = '';
    try { text = localStorage.getItem(this.draftKey()) || ''; } catch {}
    this.textarea.value = text;
    this.autoGrow();
    this.updateSendState();
  }
  saveDraft = debounce(() => {
    try {
      const v = this.textarea.value;
      if (v.trim()) localStorage.setItem(this.draftKey(), v); else localStorage.removeItem(this.draftKey());
    } catch {}
  }, 250);

  // ---------------------------------------------------------------- chips
  async renderChips() {
    const token = (this.chipToken = (this.chipToken || 0) + 1);
    const imp = await this.implicitAttachment();
    if (token !== this.chipToken) return;
    clear(this.chips);
    this.chips.append(this.attachBtn);
    const hasChips = !!imp || inputState.attachments.length > 0;
    this.attachBtn.classList.toggle('compact', hasChips);
    if (imp && !inputState.attachments.some(a => a.type === 'file' && a.path === imp.path)) {
      const d = describe(imp);
      const on = inputState.implicit;
      const chip = h('div', { class: ['chat-attached-context-attachment', 'implicit', !on && 'disabled'], role: 'listitem', title: on ? `${d.detail} — tap the eye to stop sending it` : `${d.detail} — not included` },
        h('span', { class: 'chip-icon', html: d.iconHtml || '' }),
        h('span', { class: 'chip-label' }, d.label),
        h('span', { class: 'chip-description' }, imp.type === 'selection' ? 'Current selection' : 'Current file'));
      const eye = h('a', { class: `action-label codicon codicon-${on ? 'eye' : 'eye-closed'} chip-toggle`, role: 'button', tabindex: '0', title: on ? 'Exclude the current file' : 'Include the current file', 'aria-label': on ? 'Exclude the current file' : 'Include the current file', 'aria-pressed': String(on) });
      const toggle = e => { e.preventDefault(); e.stopPropagation(); inputState.implicit = !inputState.implicit; this.renderChips(); };
      eye.addEventListener('click', toggle);
      eye.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') toggle(e); });
      chip.append(eye);
      this.chips.append(chip);
    }
    for (const a of inputState.attachments) {
      const chip = attachmentChip(a, { onRemove: removeAttachment, onPreview: a.type === 'image' ? this.previewImage : null });
      this.chips.append(chip);
    }
    this.updateSendState();
  }

  renderPickers() {
    const m = modeInfo(currentMode());
    clear(this.modePill).append(h('span', { class: 'pill-label' }, m.label), codicon('chevron-down'));
    this.modePill.title = `${m.label} mode: ${m.description} Tap to change.`;
    this.modePill.setAttribute('aria-label', `Mode: ${m.label}`);
    const label = currentModelLabel();
    clear(this.modelPill).append(h('span', { class: 'pill-label' }, label), codicon('chevron-down'));
    this.modelPill.title = `Model: ${label}. Tap to pick a model, or hold Send to switch quickly.`;
    this.modelPill.setAttribute('aria-label', `Model: ${label}`);
  }

  // ---------------------------------------------------------------- "/" and "#" suggestions
  tokenAtCursor() {
    const ta = this.textarea;
    const pos = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, pos);
    const m = before.match(/(^|\s)([#/][\w:./-]*)$/);
    if (!m) return null;
    const token = m[2];
    const start = pos - token.length;
    if (token[0] === '/' && start !== 0) return null; // slash commands only at the start
    return { token, start, end: pos };
  }

  updateSuggest() {
    const t = this.tokenAtCursor();
    if (!t) { this.closeSuggest(); return; }
    const q = t.token.slice(1).toLowerCase();
    let items;
    if (t.token[0] === '/') {
      items = SLASH_COMMANDS.filter(c => c.name.startsWith(q)).map(c => ({ id: `/${c.name}`, label: `/${c.name}`, description: c.description, icon: 'symbol-event', kind: 'slash' }));
    } else {
      items = CONTEXT_ITEMS.filter(c => c.name.startsWith(q.replace(/:.*$/, ''))).map(c => ({ id: `#${c.name}`, label: `#${c.name}`, description: c.description, icon: c.icon, kind: 'hash', name: c.name }));
      if (q.length >= 2 && workspace.fs) {
        const needle = q.replace(/^file:/, '');
        const files = workspace.fs.files().map(r => ({ r, m: fuzzyMatch(needle, r.path) })).filter(x => x.m).sort((a, b) => b.m.score - a.m.score).slice(0, 6);
        for (const { r } of files) items.push({ id: `#file:${r.path}`, label: posix.basename(r.path), description: r.path, iconHtml: safeIcon(r.path), kind: 'file', path: r.path });
      }
    }
    if (!items.length) { this.closeSuggest(); return; }
    const sig = items.map(i => i.id).join('|');
    if (this.suggest && !this.suggest.closed && this.suggest.sig === sig) return;
    this.closeSuggest();
    const p = popover(this.container, items, { className: 'chat-suggest-widget', minWidth: Math.min(360, this.container.offsetWidth), maxWidth: Math.max(260, this.container.offsetWidth), modal: false, onPick: it => this.acceptSuggestion(it, t) });
    p.layer.classList.add('passive');
    p.sig = sig;
    p.setActive(0);
    this.suggest = p;
  }

  closeSuggest() { if (this.suggest && !this.suggest.closed) this.suggest.close(); this.suggest = null; }

  async acceptSuggestion(item, t) {
    const cur = this.tokenAtCursor() || t;
    const ta = this.textarea;
    const v = ta.value;
    if (item.kind === 'slash') {
      const rest = v.slice(cur.end).replace(/^\s*/, '');
      ta.value = `${item.label} ${rest}`;
      const pos = item.label.length + 1;
      ta.setSelectionRange(pos, pos);
    } else {
      ta.value = (v.slice(0, cur.start) + v.slice(cur.end)).replace(/\s{2,}/g, ' ');
      ta.setSelectionRange(cur.start, cur.start);
      if (item.kind === 'file') addPendingAttachment({ type: 'file', path: item.path });
      else await addContextVariable(item.name);
    }
    this.autoGrow(); this.saveDraft(); this.updateSendState();
    ta.focus();
  }

  // ---------------------------------------------------------------- voice input
  renderMic() {
    const on = voice.listening && !!this.dictation;
    this.micBtn.classList.toggle('listening', on);
    this.micBtn.classList.toggle('codicon-mic', !on);
    this.micBtn.classList.toggle('codicon-mic-filled', on);
    const label = on ? 'Stop Voice Input' : 'Start Voice Input';
    this.micBtn.title = label; this.micBtn.setAttribute('aria-label', label);
    this.micBtn.setAttribute('aria-pressed', String(on));
  }

  toggleDictation() { if (this.dictation) this.stopDictation(); else this.startDictation(); }

  startDictation() {
    const base = this.textarea.value;
    const sep = base && !/\s$/.test(base) ? ' ' : '';
    this.dictation = voice.startDictation({
      onText: (finalText, interim) => {
        const spoken = `${finalText}${interim ? `${finalText ? ' ' : ''}${interim}` : ''}`.trim();
        this.textarea.value = spoken ? `${base}${sep}${spoken}` : base;
        this.autoGrow(); this.updateSendState();
      },
      onEnd: err => {
        this.dictation = null;
        this.renderMic();
        this.saveDraft();
        if (err) { log.warn(`Voice input: ${err.message}`); notify('warn', err.message); }
      }
    });
    this.renderMic();
  }

  stopDictation() { const d = this.dictation; if (d) { d.stop(); } }

  dispose() {
    this.stopDictation();
    this.closeSuggest();
    for (const d of this.disposers.splice(0)) { try { d(); } catch {} }
  }
}
