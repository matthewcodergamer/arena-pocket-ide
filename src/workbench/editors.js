// Editor area: one editor group with VS Code tabs (preview/italic tabs, dirty dots),
// editor title actions, the empty-group watermark, and per-project session restore.
//
// Editor inputs are plain objects with a `type`, e.g. { type: 'file', path: 'src/app.js' },
// { type: 'welcome' }, { type: 'diff', id, path, title, original, modified }, { type: 'preview', entry }.
// Feature modules register a provider per type:
//
//   editors.registerProvider('file', {
//     title: input => 'app.js',  description?: input => 'src',  tooltip?: input => 'src/app.js',
//     icon?: input => '<svg…>' (HTML string),  key?: input => 'file:src/app.js',
//     serialize?: input => ({...}) | null,       deserialize?: data => input,
//     create(input, container, api) → instance
//       api = { key, input, setDirty(bool), setTitle(), close(), pin() }
//       instance = { dispose(), focus?(), onShow?(), onHide?(), save?(): Promise, isDirty?(): bool,
//                    reveal?({line, col, endLine?, endCol?, select?}), getState?(), setState?(state), setInput?(input) }
//   })
//
//   await editors.open({ type: 'file', path }, { pinned: true, reveal: { line: 10 } })
//   editors.active → { key, input, instance, pinned } | null
//   editors.close(key) · closeAll() · closeOthers(key) · save(key) · saveAll() · list() · findByPath(path)

import { $, h, codicon, clear, onContextMenu, isPhone } from '../core/dom.js';
import { bus } from '../core/events.js';
import { commands, keybindingLabel } from '../core/commands.js';
import { menus } from '../core/menus.js';
import { workspace } from '../core/workspace.js';
import { posix } from '../core/path.js';
import { showContextMenu } from '../platform/contextmenu.js';
import { dialogs } from '../platform/dialogs.js';
import { layout } from './layout.js';
import { fileIconHtml } from './icons.js';

const providers = new Map();
/** @type {Array<{key:string,input:any,pinned:boolean,dirty:boolean,instance:any,container:HTMLElement|null,state:any,lastActive:number}>} */
const entries = [];
let activeKey = null;
let restoring = false;
const MAX_LIVE = 10; // keep at most this many editor instances alive (phones have little memory)

export const editors = {
  registerProvider(type, provider) { providers.set(type, provider); },
  provider(type) { return providers.get(type); },

  keyOf(input) {
    const p = providers.get(input?.type);
    if (p?.key) return p.key(input);
    return `${input?.type}:${input?.path ?? input?.id ?? ''}`;
  },

  get active() { const e = entries.find(x => x.key === activeKey); return e ? publicEntry(e) : null; },
  get activeInput() { return entries.find(x => x.key === activeKey)?.input || null; },
  /** Path of the active editor when it's a file-backed editor. */
  get activePath() { const i = this.activeInput; return i?.type === 'file' ? i.path : null; },
  list() { return entries.map(publicEntry); },
  isOpen(key) { return entries.some(e => e.key === key); },
  findByPath(path) { return entries.filter(e => e.input?.path === path).map(publicEntry); },
  get(key) { const e = entries.find(x => x.key === key); return e ? publicEntry(e) : null; },

  async open(input, opts = {}) {
    const provider = providers.get(input?.type);
    if (!provider) throw new Error(`No editor for "${input?.type}"`);
    const key = this.keyOf(input);
    const { pinned = !!opts.pinned || !!provider.pinnedByDefault, focus = true, background = false } = opts;
    let entry = entries.find(e => e.key === key);
    if (entry) {
      if (pinned) entry.pinned = true;
      const changed = JSON.stringify({ ...entry.input, ...input }) !== JSON.stringify(entry.input);
      if (opts.inputUpdate || (changed && entry.instance?.setInput)) { entry.input = { ...entry.input, ...input }; entry.instance?.setInput?.(entry.input); }
    } else {
      entry = { key, input, pinned, dirty: false, instance: null, container: null, state: null, lastActive: Date.now() };
      const previewIdx = !pinned && opts.preview !== false ? entries.findIndex(e => !e.pinned && !e.dirty) : -1;
      if (previewIdx >= 0) {
        const old = entries[previewIdx];
        disposeEntry(old);
        entries.splice(previewIdx, 1, entry);
        bus.emit('editor:closed', { key: old.key, input: old.input });
      } else {
        const activeIdx = entries.findIndex(e => e.key === activeKey);
        entries.splice(activeIdx >= 0 ? activeIdx + 1 : entries.length, 0, entry);
      }
      bus.emit('editor:opened', { key, input });
    }
    if (!background) await activate(entry, { focus, reveal: opts.reveal });
    renderTabs();
    persistSoon();
    if (focus && !background && layout.isPhone) layout.dismissOverlays();
    return entry.instance;
  },

  pin(key = activeKey) { const e = entries.find(x => x.key === key); if (e && !e.pinned) { e.pinned = true; renderTabs(); persistSoon(); bus.emit('editor:pinned', { key }); } },

  setDirty(key, dirty) {
    const e = entries.find(x => x.key === key);
    if (!e || e.dirty === !!dirty) return;
    e.dirty = !!dirty;
    if (dirty) e.pinned = true;
    renderTabs();
    bus.emit('editor:dirty', { key, path: e.input?.path, dirty: e.dirty });
  },
  isDirty(key) { return !!entries.find(x => x.key === key)?.dirty; },
  anyDirty() { return entries.some(e => e.dirty); },

  async save(key = activeKey) {
    const e = entries.find(x => x.key === key);
    if (!e?.instance?.save) return false;
    await e.instance.save();
    return true;
  },
  async saveAll() { for (const e of [...entries]) if (e.dirty && e.instance?.save) await e.instance.save(); },

  /** Closes an editor; asks to save when dirty (unless force). Returns false if the user cancelled. */
  async close(key = activeKey, { force = false } = {}) {
    const idx = entries.findIndex(e => e.key === key);
    if (idx < 0) return true;
    const e = entries[idx];
    if (e.dirty && !force && e.instance?.save) {
      const name = providers.get(e.input.type)?.title?.(e.input) || 'this file';
      const choice = await dialogs.show({ type: 'warning', message: `Do you want to save the changes you made to ${name}?`, detail: "Your changes will be lost if you don't save them.", buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2 });
      if (choice === 2) return false;
      if (choice === 0) await e.instance.save();
    }
    disposeEntry(e);
    entries.splice(idx, 1);
    bus.emit('editor:closed', { key: e.key, input: e.input });
    if (activeKey === key) {
      activeKey = null;
      const next = [...entries].sort((a, b) => b.lastActive - a.lastActive)[0];
      if (next) await activate(next, { focus: false }); else { showWatermark(); bus.emit('editor:activeChanged', null); }
    }
    renderTabs();
    persistSoon();
    return true;
  },
  async closeAll({ force = false, saved = false } = {}) {
    for (const e of [...entries]) {
      if (saved && e.dirty) continue;
      if (!(await this.close(e.key, { force }))) return false;
    }
    return true;
  },
  async closeOthers(key = activeKey) { for (const e of [...entries]) if (e.key !== key && !(await this.close(e.key))) return false; return true; },
  async closeToRight(key = activeKey) {
    const idx = entries.findIndex(e => e.key === key);
    for (const e of entries.slice(idx + 1)) if (!(await this.close(e.key))) return false;
    return true;
  },
  /** Close editors for paths that were deleted (no save prompt). */
  closeByPath(path) {
    for (const e of [...entries]) if (e.input?.path && (e.input.path === path || e.input.path.startsWith(path + '/'))) {
      e.dirty = false; this.close(e.key, { force: true });
    }
  },
  /** Re-renders tab labels (e.g. after a rename or theme change). */
  refresh() { renderTabs(); },
  /** Cycles tabs (Ctrl+Tab / Ctrl+PageDown). */
  async cycle(dir = 1) {
    if (!entries.length) return;
    const idx = entries.findIndex(e => e.key === activeKey);
    const next = entries[(idx + dir + entries.length) % entries.length];
    await activate(next, { focus: true }); renderTabs();
  },

  // ---- session persistence ----
  serializeSession() {
    return {
      editors: entries.map(e => {
        const p = providers.get(e.input.type);
        const data = p?.serialize ? p.serialize(e.input) : (p?.serializable === false ? null : e.input);
        return data ? { type: e.input.type, data, pinned: e.pinned, key: e.key } : null;
      }).filter(Boolean),
      active: activeKey
    };
  },
  async restoreSession(session) {
    restoring = true;
    try {
      for (const item of session?.editors || []) {
        const p = providers.get(item.type);
        if (!p) continue;
        const input = p.deserialize ? p.deserialize(item.data) : item.data;
        if (!input) continue;
        if (p.exists && !p.exists(input)) continue;
        await this.open(input, { pinned: item.pinned !== false, background: true, focus: false });
      }
      const target = entries.find(e => e.key === session?.active) || entries[0];
      if (target) await activate(target, { focus: false });
      renderTabs();
    } finally { restoring = false; }
    return entries.length;
  }
};

function publicEntry(e) { return { key: e.key, input: e.input, pinned: e.pinned, dirty: e.dirty, instance: e.instance }; }

async function activate(entry, { focus = true, reveal } = {}) {
  const host = $('#editor-container');
  hideWatermark();
  const prev = entries.find(e => e.key === activeKey);
  if (prev && prev !== entry && prev.container) {
    prev.container.classList.add('hidden');
    try { prev.instance?.onHide?.(); } catch {}
  }
  activeKey = entry.key;
  entry.lastActive = Date.now();
  if (!entry.instance) {
    const provider = providers.get(entry.input.type);
    entry.container = h('div', { class: `editor-instance editor-${entry.input.type} hidden`, 'data-key': entry.key });
    host.append(entry.container);
    const api = {
      key: entry.key,
      get input() { return entry.input; },
      setDirty: d => editors.setDirty(entry.key, d),
      setTitle: () => renderTabs(),
      close: () => editors.close(entry.key, { force: true }),
      pin: () => editors.pin(entry.key)
    };
    try {
      entry.instance = await provider.create(entry.input, entry.container, api) || {};
      if (entry.state && entry.instance.setState) entry.instance.setState(entry.state);
    } catch (err) {
      console.error(`[X Coder] editor for ${entry.key} failed`, err);
      entry.container.append(h('div', { class: 'editor-error' }, h('h3', {}, 'The editor could not be opened'), h('p', {}, String(err?.message || err))));
      entry.instance = {};
    }
    trimLiveEditors();
  }
  if (activeKey !== entry.key) return; // another activation won the race
  entry.container.classList.remove('hidden');
  try { entry.instance.onShow?.(); } catch (err) { console.error(err); }
  if (reveal) try { entry.instance.reveal?.(reveal); } catch (err) { console.error(err); }
  if (focus && !restoring) requestAnimationFrame(() => entry.instance?.focus?.());
  renderTitleActions();
  bus.emit('editor:activeChanged', publicEntry(entry));
  if (!restoring) persistSoon();
}

function disposeEntry(e) {
  try { e.instance?.dispose?.(); } catch (err) { console.error(err); }
  e.container?.remove();
  e.instance = null; e.container = null;
}

function trimLiveEditors() {
  const live = entries.filter(e => e.instance && e.key !== activeKey && !e.dirty);
  if (live.length + 1 <= MAX_LIVE) return;
  live.sort((a, b) => a.lastActive - b.lastActive);
  for (const e of live.slice(0, live.length + 1 - MAX_LIVE)) {
    try { e.state = e.instance.getState?.() ?? e.state; } catch {}
    disposeEntry(e);
  }
}

// ---------------- rendering ----------------

function tabLabel(e) {
  const p = providers.get(e.input.type);
  let title = 'Untitled', description = '', tooltip = '', icon = '';
  try { title = p?.title?.(e.input) ?? title; } catch {}
  try { description = p?.description?.(e.input) ?? ''; } catch {}
  try { tooltip = p?.tooltip?.(e.input) ?? (e.input.path || title); } catch {}
  try { icon = p?.icon ? p.icon(e.input) : (e.input.path ? fileIconHtml(e.input.path) : ''); } catch {}
  return { title, description, tooltip, icon };
}

function renderTabs() {
  const strip = $('#tabs-container');
  if (!strip) return;
  const labels = entries.map(e => ({ e, ...tabLabel(e) }));
  const dupes = new Map();
  for (const l of labels) dupes.set(l.title, (dupes.get(l.title) || 0) + 1);
  clear(strip);
  for (const l of labels) {
    const { e } = l;
    const isActive = e.key === activeKey;
    const desc = dupes.get(l.title) > 1 && e.input.path ? (posix.dirname(e.input.path) || '.') : l.description;
    const closeBtn = h('a', { class: 'action-label codicon codicon-close', role: 'button', title: `Close (${keybindingLabel('Mod+W')})`, 'aria-label': 'Close' });
    const tab = h('div', {
      class: ['tab', isActive && 'active', e.dirty && 'dirty', !e.pinned && 'preview', 'has-icon'],
      role: 'tab', 'aria-selected': String(isActive), tabindex: isActive ? '0' : '-1', title: l.tooltip, 'data-key': e.key, draggable: layout.isPhone ? 'false' : 'true'
    },
      h('div', { class: 'tab-border-top-container' }),
      h('div', { class: 'monaco-icon-label' },
        h('span', { class: 'tab-icon', html: l.icon }),
        h('span', { class: 'label-name' }, l.title),
        desc ? h('span', { class: 'label-description' }, desc) : null),
      h('div', { class: 'tab-actions' }, closeBtn));
    tab.addEventListener('click', ev => { if (ev.target.closest('.tab-actions')) return; activate(e, { focus: true }).then(renderTabs); });
    tab.addEventListener('dblclick', () => editors.pin(e.key));
    tab.addEventListener('auxclick', ev => { if (ev.button === 1) { ev.preventDefault(); editors.close(e.key); } });
    closeBtn.addEventListener('click', ev => { ev.stopPropagation(); editors.close(e.key); });
    onContextMenu(tab, (x, y) => showContextMenu(tabContextMenu(e), { x, y }));
    tab.addEventListener('dragstart', ev => { ev.dataTransfer.setData('text/x-xcoder-tab', e.key); ev.dataTransfer.effectAllowed = 'move'; });
    tab.addEventListener('dragover', ev => { if (ev.dataTransfer.types.includes('text/x-xcoder-tab')) { ev.preventDefault(); tab.classList.add('drop-target'); } });
    tab.addEventListener('dragleave', () => tab.classList.remove('drop-target'));
    tab.addEventListener('drop', ev => {
      ev.preventDefault(); tab.classList.remove('drop-target');
      const from = entries.findIndex(x => x.key === ev.dataTransfer.getData('text/x-xcoder-tab'));
      const to = entries.indexOf(e);
      if (from < 0 || from === to) return;
      const [moved] = entries.splice(from, 1); entries.splice(to, 0, moved);
      renderTabs(); persistSoon();
    });
    strip.append(tab);
  }
  $('#editor-part')?.classList.toggle('empty', !entries.length);
  strip.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  renderTitleActions();
}

function tabContextMenu(e) {
  const items = [
    { label: 'Close', keybinding: keybindingLabel('Mod+W'), run: () => editors.close(e.key) },
    { label: 'Close Others', run: () => editors.closeOthers(e.key), disabled: entries.length < 2 },
    { label: 'Close to the Right', run: () => editors.closeToRight(e.key), disabled: entries.indexOf(e) === entries.length - 1 },
    { label: 'Close Saved', run: () => editors.closeAll({ saved: true }) },
    { label: 'Close All', run: () => editors.closeAll() },
    { separator: true }
  ];
  if (e.input.path) {
    items.push({ label: 'Copy Path', run: () => commands.execute('copyFilePath', { path: e.input.path }) });
    items.push({ label: 'Reveal in Explorer View', run: () => commands.execute('workbench.files.action.showActiveFileInExplorer', { path: e.input.path }) });
    items.push({ separator: true });
  }
  if (!e.pinned) items.push({ label: 'Keep Open', run: () => editors.pin(e.key) });
  items.push(...menus.resolve('editor/tab/context', e.input));
  return items;
}

function renderTitleActions() {
  const bar = $('#editor-actions');
  if (!bar) return;
  clear(bar);
  const entry = entries.find(e => e.key === activeKey);
  const ctx = entry?.input || null;
  const items = menus.resolve('editor/title', ctx).filter(i => !i.separator);
  for (const it of items) {
    const b = h('a', { class: ['action-label', 'codicon', `codicon-${it.icon || 'circle'}`, it.checked && 'checked', it.disabled && 'disabled'], role: 'button', title: it.label + (it.keybinding ? ` (${it.keybinding})` : ''), 'aria-label': it.label });
    b.addEventListener('click', () => { if (!it.disabled) it.run?.(); });
    bar.append(b);
  }
  const more = h('a', { class: 'action-label codicon codicon-ellipsis', role: 'button', title: 'More Actions…', 'aria-label': 'More Actions' });
  more.addEventListener('click', () => {
    const base = entry ? [
      ...menus.resolve('editor/title/more', ctx),
      { separator: true },
      { label: 'Close', keybinding: keybindingLabel('Mod+W'), run: () => editors.close(entry.key) },
      { label: 'Close All', run: () => editors.closeAll() },
      { label: 'Close Saved', run: () => editors.closeAll({ saved: true }) }
    ] : [{ label: 'New File…', run: () => commands.execute('workbench.action.files.newFile') }, { label: 'Open Recent…', run: () => commands.execute('workbench.action.openRecent') }];
    showContextMenu(base, { anchor: more, align: 'right' });
  });
  bar.append(more);
}

function showWatermark() { $('#editor-part')?.classList.add('empty'); $('#editor-watermark')?.classList.remove('hidden'); renderWatermark(); renderTitleActions(); }
function hideWatermark() { $('#editor-part')?.classList.remove('empty'); $('#editor-watermark')?.classList.add('hidden'); }

function renderWatermark() {
  const w = $('#editor-watermark');
  if (!w) return;
  const entriesList = [
    ['Show All Commands', 'workbench.action.showCommands'],
    ['Go to File', 'workbench.action.quickOpen'],
    ['Find in Files', 'workbench.view.search'],
    ['Ask X Coder', 'workbench.action.chat.open'],
    ['Toggle Terminal', 'workbench.action.terminal.toggleTerminal']
  ].filter(([, id]) => commands.has(id));
  clear(w);
  w.append(
    h('div', { class: 'letterpress', 'aria-hidden': 'true' }),
    h('div', { class: 'shortcuts' },
      h('dl', {}, ...entriesList.map(([label, id]) => {
        const row = h('div', { class: 'watermark-entry', role: 'button', tabindex: '0' },
          h('dt', {}, label),
          h('dd', {}, h('span', { class: 'monaco-keybinding' }, ...splitKb(commands.keybindingLabel(id)).map(k => h('span', { class: 'monaco-keybinding-key' }, k)))));
        row.addEventListener('click', () => commands.execute(id));
        return row;
      }))));
}
function splitKb(label) {
  if (!label) return [];
  if (label.includes('+')) return label.split('+');
  return label.match(/[⌃⌥⇧⌘]|[^⌃⌥⇧⌘]+/g) || [label];
}

// ---------------- persistence & workspace integration ----------------
let persistTimer = 0;
function persistSoon() {
  if (restoring) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { workspace.sessionSet('workbench.session', editors.serializeSession()).catch(() => {}); }, 400);
}

bus.on('project:willClose', async () => {
  clearTimeout(persistTimer);
  await workspace.sessionSet('workbench.session', editors.serializeSession()).catch(() => {});
  for (const e of [...entries]) {
    if (e.dirty && e.instance?.save) { try { await e.instance.save(); } catch {} }
    disposeEntry(e);
  }
  entries.length = 0;
  activeKey = null;
  renderTabs();
  showWatermark();
});

bus.on('fs:changed', ev => {
  if (ev.type === 'rename') {
    let changed = false;
    for (const e of entries) {
      const p = e.input?.path;
      if (p && (p === ev.path || p.startsWith(ev.path + '/'))) {
        const np = ev.to + p.slice(ev.path.length);
        const wasActive = e.key === activeKey;
        e.input = { ...e.input, path: np };
        const newKey = editors.keyOf(e.input);
        e.container?.setAttribute('data-key', newKey);
        e.key = newKey;
        if (wasActive) activeKey = newKey;
        e.instance?.setInput?.(e.input);
        changed = true;
      }
    }
    if (changed) { renderTabs(); persistSoon(); bus.emit('editor:activeChanged', editors.active); }
  } else if (ev.type === 'delete') {
    editors.closeByPath(ev.path);
  } else if (ev.type === 'reset') {
    for (const e of [...entries]) if (e.input?.type === 'file' && !workspace.fs?.exists(e.input.path)) editors.closeByPath(e.input.path);
  }
});

bus.on('theme:changed', () => renderTabs());

/** Builds the editor part DOM (called once from main). */
export function initEditorPart() {
  const part = $('#editor-part');
  part.append(
    h('div', { class: 'title tabs show-file-icons' },
      h('div', { class: 'tabs-and-actions-container' },
        h('div', { id: 'tabs-container', class: 'tabs-container', role: 'tablist' }),
        h('div', { id: 'editor-actions', class: 'editor-actions monaco-toolbar' }))),
    h('div', { id: 'editor-container', class: 'editor-container' },
      h('div', { id: 'editor-watermark', class: 'editor-group-watermark' })));
  const strip = $('#tabs-container');
  strip.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { strip.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  strip.addEventListener('dblclick', e => { if (e.target === strip) commands.execute('workbench.action.files.newFile'); });
  showWatermark();
  if (isPhone()) part.classList.add('phone');
}
