// The Explorer "Folders" tree (VS Code's workbench.explorer.fileView): virtualized rows, Seti file
// icons, twisties without folder icons, compact folders, indent guides, git + problem decorations,
// inline New File / New Folder / Rename inputs with VS Code validation messages, multi-selection,
// keyboard navigation, type-to-select, context menus (right-click + long-press) and drag & drop.

import { h, escapeHtml, isApple, isTouch, onContextMenu } from '../../core/dom.js';
import { bus, DisposableStore } from '../../core/events.js';
import { workspace } from '../../core/workspace.js';
import { posix } from '../../core/path.js';
import { settings } from '../../core/settings.js';
import { diagnostics } from '../../core/diagnostics.js';
import { commands, keybindingLabel } from '../../core/commands.js';
import { menus } from '../../core/menus.js';
import { showContextMenu } from '../../platform/contextmenu.js';
import { notify } from '../../platform/notifications.js';
import { dialogs } from '../../platform/dialogs.js';
import { layout } from '../../workbench/layout.js';
import { editors } from '../../workbench/editors.js';
import { fileIconHtml } from '../../workbench/icons.js';
import { git } from '../../scm/api.js';
import { VirtualList } from './virtualList.js';
import { buildTree, flatten, ancestorsOf, topLevelPaths } from './model.js';
import {
  validateFileName, createFile, createFolder, renamePath, movePaths, copyPaths, deletePaths, clipboard,
  pasteInto, duplicatePath, undoLast, explorerLog
} from './fileOps.js';
import { importDrop } from './transfer.js';

const INTERNAL_DRAG = 'text/x-xcoder-paths';
const SESSION_KEY = 'explorer.expanded';

// Git status per path, tracked from module load (Explorer activation) so changes reported before
// the tree is first shown are not lost. Source: bus 'git:changed' ({changes}) and git.getChanges().
const gitChanges = new Map();
function setGitChanges(changes) {
  gitChanges.clear();
  for (const c of Array.isArray(changes) ? changes : []) if (c?.path && c.status) gitChanges.set(c.path, c.status);
}
bus.on('git:changed', ev => setGitChanges(ev?.changes));
bus.on('project:willClose', () => gitChanges.clear());

function mdBold(text) { return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'); }
const modKey = e => (isApple ? e.metaKey : e.ctrlKey);

export class FileTree {
  constructor(body) {
    this.body = body;
    this.store = new DisposableStore();
    this.expanded = new Set();
    this.selection = new Set();
    this.focused = null;
    this.anchor = null;
    this.editing = null;
    this.pendingReveal = null;
    this.problems = new Map();   // file path → { errors, warnings }
    this.folderDeco = new Map(); // folder path → { errors, warnings, git }
    this.typeBuffer = ''; this.typeTimer = 0;
    this.visible = true;

    this.el = h('div', { class: 'explorer-folders-view' });
    this.list = new VirtualList({
      className: 'explorer-tree', role: 'tree', ariaLabel: 'Files Explorer', keyOf: r => r.key,
      sigOf: r => this.rowSig(r), renderRow: (r, i) => this.renderRow(r, i), updateRow: (el, r) => this.updateRow(el, r)
    });
    this.emptyEl = h('div', { class: 'explorer-empty view-message hidden' });
    this.el.append(this.list.scroller, this.emptyEl);
    body.append(this.el);
    this.applyGuidesMode();

    const s = this.list.scroller;
    s.addEventListener('click', e => this.onClick(e));
    s.addEventListener('dblclick', e => this.onDblClick(e));
    s.addEventListener('keydown', e => this.onKeyDown(e));
    this.store.add(onContextMenu(s, (x, y, e) => this.onContextMenu(x, y, e)));
    this.setupDnD();

    const rebuildSoon = this.debounced(() => this.rebuild(), 40);
    const decoSoon = this.debounced(() => { this.computeDecorations(); this.list.render(); }, 120);
    this.store.add(bus.on('project:opened', () => this.onProjectOpened()));
    this.store.add(bus.on('fs:changed', ev => { this.onFsChanged(ev); rebuildSoon(); decoSoon(); }));
    this.store.add(bus.on('editor:activeChanged', e => this.onActiveEditor(e)));
    this.store.add(bus.on('git:changed', decoSoon));
    this.store.add(bus.on('diagnostics:changed', decoSoon));
    this.store.add(bus.on('theme:changed', () => this.list.refresh()));
    this.store.add(bus.on('keyboard:changed', () => { if (this.editing) requestAnimationFrame(() => this.revealEditing()); }));
    this.store.add(bus.on('settings:changed', ({ key }) => {
      if (/^explorer\.(sortOrder|compactFolders)$/.test(key)) this.rebuild();
      else if (/^explorer\.decorations\./.test(key) || key === 'workbench.tree.indent') this.list.render();
      else if (key === 'workbench.tree.renderIndentGuides') this.applyGuidesMode();
    }));
    this.store.add(() => { clearTimeout(this.typeTimer); clearTimeout(this.persistTimer); this.list.dispose(); });

    if (workspace.fs) this.onProjectOpened(true);
  }

  debounced(fn, ms) {
    let t = 0;
    this.store.add(() => clearTimeout(t));
    return () => { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  dispose() { this.cancelEditing(); this.store.dispose(); this.el.remove(); }

  // ---------------- data ----------------
  async onProjectOpened(initial = false) {
    this.cancelEditing();
    this.selection.clear(); this.focused = null; this.anchor = null;
    this.expanded = new Set();
    this.list.scroller.scrollTop = 0;
    this.rebuild();
    const projectId = workspace.id;
    try {
      const saved = await workspace.sessionGet(SESSION_KEY, null);
      if (projectId !== workspace.id) return;
      if (Array.isArray(saved)) for (const p of saved) if (workspace.fs.isFolder(p)) this.expanded.add(p);
    } catch {}
    try { const ch = await git.getChanges(); if (Array.isArray(ch) && (ch.length || !gitChanges.size)) setGitChanges(ch); } catch {}
    this.computeDecorations();
    const active = editors.activePath;
    if (active && settings.get('explorer.autoReveal', true)) this.reveal(active, { focus: false, scroll: 'center', expand: true });
    else this.rebuild();
    if (initial) this.list.render();
  }

  persistExpanded() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => { workspace.sessionSet(SESSION_KEY, [...this.expanded]).catch(() => {}); }, 400);
  }

  onFsChanged(ev) {
    if (!ev) return;
    const remap = (set, from, to) => {
      for (const p of [...set]) if (p === from || p.startsWith(from + '/')) { set.delete(p); set.add(to + p.slice(from.length)); }
    };
    if (ev.type === 'rename' && ev.to) {
      remap(this.expanded, ev.path, ev.to);
      remap(this.selection, ev.path, ev.to);
      if (this.focused && (this.focused === ev.path || this.focused.startsWith(ev.path + '/'))) this.focused = ev.to + this.focused.slice(ev.path.length);
      this.persistExpanded();
    } else if (ev.type === 'delete') {
      const gone = p => p === ev.path || p.startsWith(ev.path + '/');
      for (const p of [...this.expanded]) if (gone(p)) this.expanded.delete(p);
      for (const p of [...this.selection]) if (gone(p)) this.selection.delete(p);
      if (this.focused && gone(this.focused)) { this.focused = posix.dirname(ev.path) || null; if (this.focused) this.selection.add(this.focused); }
      if (this.editing?.mode === 'rename' && gone(this.editing.path)) this.cancelEditing();
      this.persistExpanded();
    }
  }

  gitStatus(path) {
    let s = null;
    try { s = git.statusOf(path); } catch {}
    return s || gitChanges.get(path) || null;
  }

  computeDecorations() {
    this.problems = new Map();
    this.folderDeco = new Map();
    const bump = (folder, key) => {
      let d = this.folderDeco.get(folder);
      if (!d) { d = { errors: 0, warnings: 0, git: null }; this.folderDeco.set(folder, d); }
      if (key === 'M' || key === 'U') d.git = d.git === 'M' || key === 'M' ? 'M' : 'U'; else d[key]++;
    };
    try {
      for (const { path, markers } of diagnostics.all()) {
        let errors = 0, warnings = 0;
        for (const m of markers) { if (m.severity === 'error') errors++; else if (m.severity === 'warning') warnings++; }
        if (!errors && !warnings) continue;
        this.problems.set(path, { errors, warnings });
        for (const a of ancestorsOf(path)) { if (errors) bump(a, 'errors'); else bump(a, 'warnings'); }
      }
    } catch {}
    for (const [path, status] of gitChanges) {
      const kind = status === 'A' || status === 'U' ? 'U' : 'M';
      for (const a of ancestorsOf(path)) bump(a, kind);
    }
  }

  rebuild() {
    const fs = workspace.fs;
    const sortOrder = settings.get('explorer.sortOrder', 'default');
    const entries = fs ? fs.entries() : [];
    const { root, nodes } = buildTree(entries, sortOrder);
    this.root = root; this.nodes = nodes;
    const noCompact = new Set();
    if (this.editing) {
      const target = this.editing.mode === 'rename' ? this.editing.path : this.editing.parent;
      if (target) { noCompact.add(target); for (const a of ancestorsOf(target)) noCompact.add(a); }
    }
    const rows = flatten(root, { expanded: this.expanded, compact: settings.get('explorer.compactFolders', true), noCompact, input: this.editing, sortOrder });
    this.rowIndex = new Map();
    rows.forEach((r, i) => { if (r.kind === 'node') for (const n of r.chain) this.rowIndex.set(n.path, i); });
    // Drop selection entries that no longer exist.
    for (const p of [...this.selection]) if (!nodes.has(p)) this.selection.delete(p);
    this.list.rows = rows;
    this.activeParent = this.activeGuideParent();
    this.list.setRows(rows);
    this.renderEmpty(!!fs && !entries.length && !this.editing);
    if (this.pendingReveal && nodes.has(this.pendingReveal.path)) {
      const { path, opts } = this.pendingReveal;
      this.pendingReveal = null;
      this.reveal(path, opts);
    }
  }

  renderEmpty(empty) {
    this.emptyEl.classList.toggle('hidden', !empty);
    this.list.scroller.classList.toggle('hidden', empty);
    if (!empty) return;
    this.emptyEl.replaceChildren(...[
      h('p', {}, 'The folder is empty.'),
      button('New File', () => this.startNew('newFile', '')),
      button('Import Files', () => commands.execute('xcoder.files.importFiles', { path: '', type: 'folder' }).catch(() => {}), true),
      commands.has('git.clone') ? button('Clone Repository', () => commands.execute('git.clone').catch(() => {}), true) : null
    ].filter(Boolean));
  }

  // ---------------- rendering ----------------
  applyGuidesMode() {
    const mode = settings.get('workbench.tree.renderIndentGuides', 'onHover');
    this.el.dataset.guides = isTouch() && mode === 'onHover' ? 'always' : mode;
  }

  indentPx() { return Math.max(0, Math.min(40, Number(settings.get('workbench.tree.indent', 8)) || 8)); }

  activeGuideParent() {
    const key = this.focused || [...this.selection].at(-1);
    if (!key) return null;
    const idx = this.rowIndex?.get(key);
    const row = idx != null ? this.list.rows[idx] : null;
    return row?.parents.at(-1) ?? null;
  }

  guides(row) {
    const indent = this.indentPx();
    const el = h('div', { class: 'monaco-tl-indent', style: `width:${indent * (row.depth - 1)}px` });
    for (let l = 0; l < row.depth - 1; l++) el.append(h('div', { class: 'indent-guide', style: `width:${indent}px` }));
    return el;
  }

  decorationFor(node) {
    const colors = settings.get('explorer.decorations.colors', true);
    const badges = settings.get('explorer.decorations.badges', true);
    let color = null; const badgeList = []; const tips = [];
    if (node.type === 'file') {
      const p = this.problems.get(node.path);
      const g = this.gitStatus(node.path);
      const letter = g === 'A' ? 'U' : g;
      const gitClass = letter === 'M' ? 'modified' : letter === 'U' ? 'untracked' : letter === 'D' ? 'deleted' : null;
      if (p?.errors || p?.warnings) {
        const n = p.errors + p.warnings;
        color = p.errors ? 'error' : 'warning';
        tips.push(`${n} problem${n === 1 ? '' : 's'} in this file`);
        badgeList.push({ text: n > 9 ? '9+' : String(n), cls: color });
      } else if (gitClass) color = gitClass;
      if (letter) { badgeList.push({ text: letter, cls: gitClass }); tips.push(letter === 'M' ? 'Modified' : letter === 'U' ? 'Untracked' : 'Deleted'); }
    } else {
      const d = this.folderDeco.get(node.path);
      if (d) {
        color = d.errors ? 'error' : d.warnings ? 'warning' : d.git === 'U' ? 'untracked' : d.git ? 'modified' : null;
        if (d.errors || d.warnings) tips.push('Contains emphasized items'); else if (d.git) tips.push('Contains changes');
        if (color) badgeList.push({ dot: true, cls: color });
      }
    }
    return { color: colors ? color : null, badges: badges ? badgeList : [], tooltip: tips.join(' • ') };
  }

  /** Static look of a row; the element is re-created only when this changes. */
  rowSig(row) {
    if (row.kind === 'input' || row.editing) return 'editing';
    const deco = row.deco = this.decorationFor(row.node);
    return `${row.depth}|${this.indentPx()}|${row.node.type}|${row.chain.map(n => n.name).join('/')}|${deco.color}|${deco.badges.map(b => (b.dot ? '*' : b.text) + b.cls).join(',')}|${deco.tooltip}`;
  }

  renderRow(row) {
    if (row.kind === 'input' || row.editing) return this.renderEditingRow(row);
    const node = row.node;
    const isFolder = node.type === 'folder';
    const deco = row.deco || this.decorationFor(node);
    const indent = this.indentPx();
    const el = h('div', {
      class: ['monaco-list-row', 'explorer-row', isFolder ? 'folder' : 'file'],
      role: 'treeitem', 'aria-level': String(row.depth), 'aria-label': row.chain.map(n => n.name).join('/'),
      'data-path': node.path, draggable: isTouch() ? null : 'true',
      title: node.path + (deco.tooltip ? ` • ${deco.tooltip}` : '')
    });
    const label = h('div', { class: ['monaco-icon-label', 'explorer-item', isFolder ? 'folder-icon' : 'file-icon-label', deco.color && `deco-${deco.color}`] });
    if (!isFolder) label.append(h('span', { class: 'explorer-file-icon', html: fileIconHtml(node.path) }));
    const name = h('span', { class: 'label-name' });
    if (row.chain.length > 1) {
      row.chain.forEach((n, i) => {
        if (i) name.append(h('span', { class: 'label-separator' }, '/'));
        name.append(h('span', { class: 'label-segment', 'data-segment': n.path }, n.name));
      });
    } else name.textContent = node.name;
    label.append(h('div', { class: 'monaco-icon-label-container' }, name));
    if (deco.badges.length) {
      const badges = h('div', { class: 'explorer-decorations' });
      for (const b of deco.badges) badges.append(b.dot ? h('span', { class: `decoration-dot deco-${b.cls}` }) : h('span', { class: `decoration-badge deco-${b.cls}` }, b.text));
      label.append(badges);
    }
    el.append(
      this.guides(row),
      h('div', { class: ['monaco-tl-twistie', isFolder && 'collapsible'], style: `padding-left:${8 + (row.depth - 1) * indent}px` }),
      h('div', { class: 'monaco-tl-contents' }, label));
    return el;
  }

  /** Dynamic state applied in place: selection, focus, expanded, cut, active indent guide. */
  updateRow(el, row) {
    if (row.kind === 'input' || row.editing) return;
    const node = row.node;
    const isFolder = node.type === 'folder';
    const expanded = isFolder && this.expanded.has(node.path);
    const selected = row.chain.some(n => this.selection.has(n.path));
    const focused = !!this.focused && row.chain.some(n => n.path === this.focused);
    const cut = clipboard.cut && row.chain.some(n => clipboard.isCut(n.path));
    el.classList.toggle('selected', selected);
    el.classList.toggle('focused', focused);
    el.classList.toggle('cut', cut);
    el.setAttribute('aria-selected', String(selected));
    if (isFolder) { el.setAttribute('aria-expanded', String(expanded)); el.children[1]?.classList.toggle('expanded', expanded); }
    if (row.chain.length > 1) for (const seg of el.querySelectorAll('[data-segment]')) seg.classList.toggle('selected-segment', this.selection.has(seg.dataset.segment));
    const active = this.activeParent;
    const guides = el.firstChild?.children || [];
    for (let l = 0; l < guides.length; l++) guides[l].classList.toggle('active', row.parents[l] === active);
  }

  /** Re-applies dynamic state (selection changes) without re-creating rows. */
  updateStates() { this.activeParent = this.activeGuideParent(); this.list.update(); }

  // ---------------- inline input (new file / new folder / rename) ----------------
  renderEditingRow(row) {
    const ed = this.editing;
    if (!ed) return h('div', { class: 'monaco-list-row' });
    const indent = this.indentPx();
    // Keep the same element (and the focused <input>) across re-renders.
    const guides = this.guides(row);
    ed.rowEl.querySelector('.monaco-tl-indent')?.replaceWith(guides);
    const tw = ed.rowEl.querySelector('.monaco-tl-twistie');
    tw.style.paddingLeft = `${8 + (row.depth - 1) * indent}px`;
    tw.classList.toggle('collapsible', ed.isFolder);
    tw.classList.toggle('expanded', ed.isFolder && ed.mode === 'rename' && this.expanded.has(ed.path));
    ed.rowEl.setAttribute('aria-level', String(row.depth));
    ed.message.style.left = `${8 + (row.depth - 1) * indent + 16 + (ed.isFolder ? 2 : 22)}px`;
    return ed.rowEl;
  }

  /** Starts inline creation inside `parent` (sync so the iOS keyboard opens from the tap). */
  startNew(mode, parent = '') {
    if (!workspace.fs) return;
    parent = posix.clean(parent || '');
    if (parent && !workspace.fs.isFolder(parent)) parent = workspace.fs.isFile(parent) ? posix.dirname(parent) : '';
    this.cancelEditing();
    for (const a of [...ancestorsOf(parent), parent].filter(Boolean)) this.expanded.add(a);
    this.persistExpanded();
    this.beginEditing({ mode, parent, isFolder: mode === 'newFolder', value: '' });
  }

  startRename(path) {
    if (!workspace.fs?.exists(path)) return;
    this.cancelEditing();
    for (const a of ancestorsOf(path)) this.expanded.add(a);
    const isFolder = workspace.fs.isFolder(path);
    this.selection = new Set([path]); this.focused = path;
    this.beginEditing({ mode: 'rename', path, parent: posix.dirname(path), isFolder, value: posix.basename(path) });
  }

  beginEditing(ed) {
    const input = h('input', {
      class: 'input', type: 'text', autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false',
      enterkeyhint: 'done', 'aria-label': 'Type file name. Press Enter to confirm or Escape to cancel.'
    });
    input.value = ed.value;
    const icon = h('span', { class: 'explorer-file-icon' });
    const message = h('div', { class: 'monaco-inputbox-message hidden', role: 'alert' });
    const box = h('div', { class: 'monaco-inputbox explorer-inputbox' }, input);
    const rowEl = h('div', { class: ['monaco-list-row', 'explorer-row', 'editing', ed.isFolder ? 'folder' : 'file'], role: 'treeitem' },
      h('div', { class: 'monaco-tl-indent' }),
      h('div', { class: 'monaco-tl-twistie' }),
      h('div', { class: 'monaco-tl-contents' },
        h('div', { class: 'monaco-icon-label explorer-item' }, ed.isFolder ? null : icon, box)),
      message);
    Object.assign(ed, { input, icon, message, box, rowEl });
    this.editing = ed;
    const update = () => {
      if (!ed.isFolder) icon.innerHTML = fileIconHtml(input.value.split('/').pop() || 'file.txt');
      const v = this.validateEditing(input.value);
      box.classList.toggle('error', v?.severity === 'error');
      box.classList.toggle('warning', v?.severity === 'warning');
      message.className = `monaco-inputbox-message ${v ? v.severity : 'hidden'}`;
      message.innerHTML = v ? mdBold(v.message) : '';
    };
    update();
    input.addEventListener('input', update);
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); this.commitEditing(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.cancelEditing(true); }
    });
    // VS Code commits a valid name when the input loses focus (e.g. iOS "Done"); empty/invalid cancels.
    input.addEventListener('blur', () => setTimeout(() => {
      if (this.editing !== ed || ed.committing || document.activeElement === input || !input.isConnected) return;
      const v = this.validateEditing(input.value);
      if (!input.value.trim() || v?.severity === 'error' || (ed.mode === 'rename' && input.value === posix.basename(ed.path))) this.cancelEditing();
      else this.commitEditing();
    }, 0));
    for (const ev of ['click', 'dblclick', 'pointerdown', 'contextmenu']) rowEl.addEventListener(ev, e => e.stopPropagation());
    this.rebuild();
    input.focus({ preventScroll: true });
    if (ed.mode === 'rename') {
      const dot = ed.isFolder ? -1 : ed.value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : ed.value.length);
    }
    this.revealEditing();
  }

  revealEditing() {
    if (!this.editing) return;
    const idx = this.list.rows.findIndex(r => r.kind === 'input' || r.editing);
    if (idx >= 0) this.list.reveal(idx);
  }

  validateEditing(value) {
    const ed = this.editing;
    if (!ed) return null;
    if (ed.mode === 'rename') {
      if (value === posix.basename(ed.path)) return null;
      if (value.includes('/')) return { severity: 'error', message: `The name **${value}** is not valid as a file or folder name. Please choose a different name.` };
      return validateFileName(ed.parent, value, { ignorePath: ed.path });
    }
    return validateFileName(ed.parent, value);
  }

  cancelEditing(restoreFocus = false) {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    ed.rowEl.remove();
    this.rebuild();
    if (restoreFocus && !layout.isPhone) this.list.scroller.focus({ preventScroll: true });
  }

  async commitEditing() {
    const ed = this.editing;
    if (!ed || ed.committing) return;
    const value = ed.input.value;
    const v = this.validateEditing(value);
    if (v?.severity === 'error') { ed.input.focus(); ed.box.classList.add('shake'); setTimeout(() => ed.box.classList.remove('shake'), 400); return; }
    if (!value.trim() || (ed.mode === 'rename' && value === posix.basename(ed.path))) { this.cancelEditing(true); return; }
    ed.committing = true;
    const keepFocus = !layout.isPhone;
    try {
      if (ed.mode === 'rename') {
        const to = posix.join(ed.parent, value);
        this.editing = null; ed.rowEl.remove();
        this.pendingReveal = { path: to, opts: { focus: keepFocus } };
        await renamePath(ed.path, to);
      } else {
        const folderOnly = ed.mode === 'newFolder' || /\/$/.test(value);
        const full = posix.join(ed.parent, value.replace(/\/+$/, ''));
        this.editing = null; ed.rowEl.remove();
        this.pendingReveal = { path: full, opts: { focus: keepFocus && folderOnly } };
        if (folderOnly) await createFolder(full);
        else {
          await createFile(full, '');
          await editors.open({ type: 'file', path: full }, { pinned: true });
        }
      }
    } catch (err) {
      explorerLog.error('File operation failed', err);
      notify.error(err.message, { source: 'Explorer' });
    } finally {
      if (this.editing === ed) this.editing = null;
      this.rebuild();
    }
  }

  // ---------------- selection / reveal ----------------
  rowAt(target) {
    const rowEl = target?.closest?.('.monaco-list-row');
    if (!rowEl || rowEl.classList.contains('editing')) return null;
    const row = this.list.rows[Number(rowEl.dataset.index)];
    if (!row || row.kind !== 'node') return null;
    const seg = target.closest('[data-segment]')?.dataset.segment;
    return { row, rowEl, path: seg || row.node.path, node: seg ? this.nodes.get(seg) : row.node };
  }

  select(path, { toggle = false, range = false } = {}) {
    if (range && this.anchor) {
      const a = this.rowIndex.get(this.anchor), b = this.rowIndex.get(path);
      if (a != null && b != null) {
        this.selection = new Set();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) { const r = this.list.rows[i]; if (r.kind === 'node') this.selection.add(r.node.path); }
      }
    } else if (toggle) {
      if (this.selection.has(path)) this.selection.delete(path); else this.selection.add(path);
      this.anchor = path;
    } else { this.selection = new Set([path]); this.anchor = path; }
    this.focused = path;
    this.updateStates();
  }

  /** Expands ancestors, selects and scrolls to `path`. */
  reveal(path, { select = true, focus = false, scroll = 'nearest', expand = true } = {}) {
    if (!path || !workspace.fs?.exists(path)) return false;
    let changed = false;
    if (expand) for (const a of ancestorsOf(path)) if (!this.expanded.has(a)) { this.expanded.add(a); changed = true; }
    if (changed) this.persistExpanded();
    if (changed || this.rowIndex?.get(path) == null) this.rebuild();
    const idx = this.rowIndex?.get(path);
    if (idx == null) return false;
    if (select) { this.selection = new Set([path]); this.anchor = path; this.focused = path; }
    this.updateStates();
    this.list.reveal(idx, { block: this.list.isRowVisible(idx) ? 'nearest' : scroll === 'center' ? 'center' : 'nearest' });
    if (focus && !layout.isPhone) this.list.scroller.focus({ preventScroll: true });
    return true;
  }

  onActiveEditor(e) {
    const path = e?.input?.type === 'file' ? e.input.path : null;
    if (!path || !settings.get('explorer.autoReveal', true) || this.editing) return;
    if (this.selection.size === 1 && this.selection.has(path)) return;
    this.reveal(path, { focus: false, scroll: 'center' });
  }

  toggle(path, expand = !this.expanded.has(path)) {
    if (expand) this.expanded.add(path); else this.expanded.delete(path);
    this.persistExpanded();
    this.rebuild();
  }

  collapseAll() { this.expanded.clear(); this.persistExpanded(); this.rebuild(); this.list.scroller.scrollTop = 0; this.list.render(); }

  /** Folder that new items go into: selected folder, or the selected file's folder, or root. */
  targetFolder() {
    const p = this.focused && this.selection.has(this.focused) ? this.focused : [...this.selection].at(-1);
    if (!p || !workspace.fs) return '';
    if (workspace.fs.isFolder(p)) return p;
    return posix.dirname(p);
  }

  selectedPaths() {
    const list = [...this.selection].filter(p => workspace.fs?.exists(p));
    return list.length ? list : (this.focused && workspace.fs?.exists(this.focused) ? [this.focused] : []);
  }

  // ---------------- open ----------------
  open(path, { pinned = false, focus = layout.isPhone } = {}) {
    if (!workspace.fs?.isFile(path)) return;
    editors.open({ type: 'file', path }, { pinned, focus }).catch(err => notify.error(`Could not open '${posix.basename(path)}': ${err.message}`));
  }

  onClick(e) {
    const hit = this.rowAt(e.target);
    if (!hit) {
      if (e.target === this.list.scroller || e.target === this.list.rowsEl) { this.selection.clear(); this.focused = null; this.anchor = null; this.updateStates(); }
      return;
    }
    const { row, path } = hit;
    const touch = isTouch();
    if (!touch && (modKey(e) || e.shiftKey)) { this.select(path, { toggle: modKey(e), range: e.shiftKey }); return; }
    this.select(path);
    if (row.node.type === 'folder') {
      if (e.detail > 1) return; // second click of a double-click
      this.toggle(row.node.path);
    } else {
      this.open(row.node.path, { pinned: e.detail > 1 });
    }
  }

  onDblClick(e) {
    const hit = this.rowAt(e.target);
    if (!hit || hit.row.node.type !== 'file') return;
    this.open(hit.row.node.path, { pinned: true, focus: true });
  }

  // ---------------- keyboard ----------------
  onKeyDown(e) {
    if (this.editing || e.target !== this.list.scroller) return;
    const rows = this.list.rows;
    if (!rows.length) return;
    let idx = this.focused != null ? this.rowIndex.get(this.focused) ?? -1 : -1;
    const focusIdx = (i, extend = false) => {
      i = Math.max(0, Math.min(rows.length - 1, i));
      while (rows[i] && rows[i].kind !== 'node') i += i >= idx ? 1 : -1;
      const r = rows[i]; if (!r) return;
      if (extend) { this.focused = r.node.path; this.select(r.node.path, { range: true }); }
      else this.select(r.node.path);
      this.list.reveal(i);
    };
    const row = idx >= 0 ? rows[idx] : null;
    const node = row?.node;
    const mod = modKey(e);
    let handled = true;
    const pageRows = Math.max(1, Math.floor(this.list.scroller.clientHeight / this.list.rowHeight) - 1);
    switch (true) {
      case e.key === 'ArrowDown' && mod && isApple: if (node?.type === 'file') this.open(node.path, { pinned: true, focus: true }); break;
      case e.key === 'ArrowDown': focusIdx(idx + 1, e.shiftKey); break;
      case e.key === 'ArrowUp': focusIdx(idx < 0 ? 0 : idx - 1, e.shiftKey); break;
      case e.key === 'Home': focusIdx(0); break;
      case e.key === 'End': focusIdx(rows.length - 1); break;
      case e.key === 'PageDown': focusIdx(idx + pageRows); break;
      case e.key === 'PageUp': focusIdx(idx - pageRows); break;
      case e.key === 'ArrowRight':
        if (node?.type === 'folder') { if (!this.expanded.has(node.path)) this.toggle(node.path, true); else focusIdx(idx + 1); }
        break;
      case e.key === 'ArrowLeft':
        if (node?.type === 'folder' && this.expanded.has(node.path)) this.toggle(node.path, false);
        else if (row?.parents.length) { const pi = this.rowIndex.get(row.parents.at(-1)); if (pi != null) focusIdx(pi); }
        break;
      case e.key === 'Enter':
        if (!node) break;
        if (node.type === 'folder') this.toggle(node.path); else this.open(node.path, { pinned: true, focus: true });
        break;
      case e.key === ' ' && !mod:
        if (!node) break;
        if (node.type === 'folder') this.toggle(node.path); else this.open(node.path, { pinned: false, focus: false });
        break;
      case e.key === 'F2': if (this.focused) this.startRename(this.focused); break;
      case e.shiftKey && e.altKey && e.code === 'KeyF': commands.execute('filesExplorer.findInFolder', { path: this.targetFolder() }); break;
      case e.key === 'Delete' || (e.key === 'Backspace' && mod): { const paths = this.selectedPaths(); if (paths.length) deletePaths(paths); break; }
      case mod && !e.shiftKey && !e.altKey && e.code === 'KeyC': clipboard.set(this.selectedPaths(), false); this.updateStates(); break;
      case mod && !e.shiftKey && !e.altKey && e.code === 'KeyX': clipboard.set(this.selectedPaths(), true); this.updateStates(); break;
      case mod && !e.shiftKey && !e.altKey && e.code === 'KeyV': this.paste(this.targetFolder()); break;
      case mod && !e.shiftKey && e.code === 'KeyZ': undoLast(); break;
      case mod && e.code === 'KeyA': this.selection = new Set(rows.filter(r => r.kind === 'node').map(r => r.node.path)); this.updateStates(); break;
      case e.key === 'Escape':
        if (clipboard.cut) { clipboard.clear(); this.updateStates(); } else if (this.selection.size > 1) this.select(this.focused);
        else handled = false;
        break;
      case e.key.length === 1 && !mod && !e.altKey && e.key !== ' ':
        this.typeToSelect(e.key); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  typeToSelect(ch) {
    clearTimeout(this.typeTimer);
    this.typeBuffer += ch.toLowerCase();
    this.typeTimer = setTimeout(() => { this.typeBuffer = ''; }, 800);
    const rows = this.list.rows;
    const start = this.focused != null ? (this.rowIndex.get(this.focused) ?? -1) : -1;
    const same = this.typeBuffer.length > 1 && [...this.typeBuffer].every(c => c === this.typeBuffer[0]);
    const prefix = same ? this.typeBuffer[0] : this.typeBuffer;
    const from = this.typeBuffer.length === 1 || same ? start + 1 : Math.max(0, start);
    for (let n = 0; n < rows.length; n++) {
      const i = (from + n) % rows.length;
      const r = rows[i];
      if (r.kind === 'node' && r.chain[0].name.toLowerCase().startsWith(prefix)) { this.select(r.node.path); this.list.reveal(i); return; }
    }
  }

  async paste(folder) {
    const created = await pasteInto(folder);
    if (created.length) this.pendingReveal = { path: created[0], opts: { focus: !layout.isPhone } };
    this.updateStates();
  }

  // ---------------- context menu ----------------
  onContextMenu(x, y, e) {
    if (this.editing) return;
    const hit = this.rowAt(e?.target);
    if (!hit) { showContextMenu(this.emptyAreaMenu(), { x, y }); return; }
    if (!this.selection.has(hit.path)) this.select(hit.path); else { this.focused = hit.path; this.updateStates(); }
    const paths = this.selection.size > 1 ? this.selectedPaths() : [hit.path];
    showContextMenu(this.itemMenu(hit.path, paths), { x, y });
  }

  emptyAreaMenu() {
    return [
      { label: 'New File…', run: () => this.startNew('newFile', '') },
      { label: 'New Folder…', run: () => this.startNew('newFolder', '') },
      { separator: true },
      { label: 'Paste', keybinding: keybindingLabel('Mod+V'), disabled: !clipboard.has(), run: () => this.paste('') },
      { separator: true },
      { label: 'Import Files…', run: () => commands.execute('xcoder.files.importFiles') },
      { label: 'Import Folder…', run: () => commands.execute('xcoder.files.importFolder') },
      { label: 'Import ZIP…', run: () => commands.execute('xcoder.files.importZip') },
      { label: 'Export Project as ZIP', run: () => commands.execute('xcoder.files.exportZip') },
      { separator: true },
      { label: 'Find in Folder…', run: () => commands.execute('filesExplorer.findInFolder', { path: '' }) },
      { label: 'Collapse Folders in Explorer', run: () => this.collapseAll() },
      ...contributed({ path: '', type: 'folder' })
    ];
  }

  itemMenu(path, paths) {
    const fs = workspace.fs;
    const isFolder = fs.isFolder(path);
    const multi = paths.length > 1;
    const ext = posix.ext(path);
    const folder = isFolder ? path : posix.dirname(path);
    const ctx = { path, type: isFolder ? 'folder' : 'file', paths };
    const items = [];
    if (isFolder) {
      items.push({ label: 'New File…', run: () => this.startNew('newFile', path) });
      items.push({ label: 'New Folder…', run: () => this.startNew('newFolder', path) });
      items.push({ separator: true });
    } else if (!multi) {
      items.push({ label: 'Open', run: () => this.open(path, { pinned: true, focus: true }) });
      if (ext === '.md' || ext === '.markdown') items.push({ label: 'Open Preview', icon: 'open-preview', disabled: !commands.has('markdown.showPreview'), run: () => commands.execute('markdown.showPreview', { type: 'file', path }) });
      if (ext === '.html' || ext === '.htm') items.push({ label: 'Open Preview', icon: 'open-preview', disabled: !commands.has('xcoder.preview.run'), run: () => commands.execute('xcoder.preview.run', { type: 'file', path }) });
      if (['.js', '.mjs', '.cjs', '.py'].includes(ext)) items.push({ label: 'Run', icon: 'play', disabled: !commands.has('xcoder.preview.run'), run: () => commands.execute('xcoder.preview.run', { type: 'file', path }) });
      items.push({ separator: true });
    }
    if (isFolder && !multi) { items.push({ label: 'Find in Folder…', keybinding: keybindingLabel('Shift+Alt+F'), run: () => commands.execute('filesExplorer.findInFolder', { path }) }); items.push({ separator: true }); }
    items.push(
      { label: 'Cut', keybinding: keybindingLabel('Mod+X'), run: () => { clipboard.set(paths, true); this.updateStates(); } },
      { label: 'Copy', keybinding: keybindingLabel('Mod+C'), run: () => { clipboard.set(paths, false); this.updateStates(); } },
      { label: 'Paste', keybinding: keybindingLabel('Mod+V'), disabled: !clipboard.has(), run: () => this.paste(folder) });
    if (!multi) items.push({ label: 'Duplicate', run: () => this.duplicate(path) });
    items.push({ separator: true });
    if (!multi) {
      items.push({ label: 'Copy Path', keybinding: keybindingLabel('Mod+Alt+C'), run: () => commands.execute('copyFilePath', { path }) });
      items.push({ label: 'Copy Relative Path', keybinding: keybindingLabel('Mod+Alt+Shift+C'), run: () => commands.execute('copyRelativeFilePath', { path }) });
      items.push({ separator: true });
      items.push({ label: 'Rename…', keybinding: 'F2', run: () => this.startRename(path) });
    }
    items.push({ label: 'Delete', keybinding: keybindingLabel(isApple ? 'Mod+Backspace' : 'Delete'), run: () => deletePaths(paths) });
    items.push({ separator: true });
    if (!multi) items.push({ label: 'Download…', run: () => commands.execute('explorer.download', { path }) });
    const filePaths = paths.filter(p => fs.isFile(p));
    if (filePaths.length) {
      items.push({ label: filePaths.length > 1 ? 'Add Files to Chat' : 'Add File to Chat', icon: 'sparkle', run: () => addToChat(filePaths) });
    }
    items.push(...contributed(ctx));
    return items;
  }

  async duplicate(path) {
    const created = await duplicatePath(path);
    if (created) this.pendingReveal = { path: created, opts: { focus: !layout.isPhone } };
  }

  // ---------------- drag & drop ----------------
  setupDnD() {
    const s = this.list.scroller;
    let expandTimer = 0, hoverPath = null;
    const clear = () => {
      clearTimeout(expandTimer); hoverPath = null; this.dropTarget = null;
      s.classList.remove('drop-target-root');
      for (const el of s.querySelectorAll('.drop-target')) el.classList.remove('drop-target');
    };
    const targetFor = e => {
      const hit = this.rowAt(e.target);
      if (!hit) return '';
      return hit.node?.type === 'folder' ? hit.path : posix.dirname(hit.path);
    };
    const mark = folder => {
      if (this.dropTarget === folder) return;
      clear();
      this.dropTarget = folder;
      if (!folder) { s.classList.add('drop-target-root'); return; }
      for (const el of s.querySelectorAll('.explorer-row')) {
        const r = this.list.rows[Number(el.dataset.index)];
        if (r?.kind === 'node' && (r.chain.some(n => n.path === folder) || r.parents.includes(folder))) el.classList.add('drop-target');
      }
    };
    s.addEventListener('dragstart', e => {
      const hit = this.rowAt(e.target);
      if (!hit || this.editing) { e.preventDefault(); return; }
      if (!this.selection.has(hit.path)) this.select(hit.path);
      const paths = this.selectedPaths();
      e.dataTransfer.setData(INTERNAL_DRAG, JSON.stringify(paths));
      e.dataTransfer.setData('text/plain', paths.join('\n'));
      e.dataTransfer.effectAllowed = 'copyMove';
      const ghost = h('div', { class: 'explorer-drag-image monaco-drag-image' }, paths.length > 1 ? String(paths.length) : posix.basename(paths[0]));
      document.body.append(ghost);
      try { e.dataTransfer.setDragImage(ghost, -10, -10); } catch {}
      setTimeout(() => ghost.remove(), 0);
    });
    s.addEventListener('dragover', e => {
      const types = [...(e.dataTransfer?.types || [])];
      const internal = types.includes(INTERNAL_DRAG);
      if (!internal && !types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = internal ? ((isApple ? e.altKey : e.ctrlKey) ? 'copy' : 'move') : 'copy';
      const folder = targetFor(e);
      mark(folder);
      if (folder && folder !== hoverPath) {
        hoverPath = folder; clearTimeout(expandTimer);
        if (!this.expanded.has(folder)) expandTimer = setTimeout(() => { this.toggle(folder, true); this.dropTarget = undefined; mark(folder); }, 800);
      }
    });
    s.addEventListener('dragleave', e => { if (!s.contains(e.relatedTarget)) clear(); });
    s.addEventListener('dragend', clear);
    s.addEventListener('drop', e => {
      const types = [...(e.dataTransfer?.types || [])];
      if (!types.includes(INTERNAL_DRAG) && !types.includes('Files')) return;
      e.preventDefault();
      const folder = targetFor(e);
      clear();
      if (types.includes(INTERNAL_DRAG)) {
        let paths = [];
        try { paths = JSON.parse(e.dataTransfer.getData(INTERNAL_DRAG) || '[]'); } catch {}
        const copy = isApple ? e.altKey : e.ctrlKey;
        this.dropInternal(paths, folder, copy);
      } else {
        importDrop(e.dataTransfer, folder).then(res => {
          if (res?.paths?.length) this.pendingReveal = { path: res.paths.find(p => !p.includes('/', folder.length + 1)) || res.paths[0], opts: {} };
          this.rebuild();
        }).catch(err => explorerLog.error('Drop import failed', err));
      }
    });
  }

  async dropInternal(paths, folder, copy) {
    paths = topLevelPaths(paths).filter(p => workspace.fs.exists(p));
    if (!copy) paths = paths.filter(p => posix.dirname(p) !== folder && p !== folder);
    if (!paths.length) return;
    if (!copy && settings.get('explorer.confirmDragAndDrop', true)) {
      const names = paths.map(p => `'${posix.basename(p)}'`);
      const res = await dialogs.show({
        type: 'question',
        message: paths.length === 1 ? `Are you sure you want to move ${names[0]} into '${folder ? posix.basename(folder) : workspace.name}'?` : `Are you sure you want to move the following ${paths.length} files into '${folder ? posix.basename(folder) : workspace.name}'?`,
        detail: paths.length > 1 ? names.join('\n') : '',
        buttons: ['Move', 'Cancel'], defaultId: 0, cancelId: 1,
        checkbox: { label: 'Do not ask me again', checked: false }
      });
      if (res.index !== 0) return;
      if (res.checked) settings.set('explorer.confirmDragAndDrop', false);
    }
    const created = copy ? await copyPaths(paths, folder) : await movePaths(paths, folder);
    if (created.length) { this.expanded.add(folder); this.pendingReveal = { path: created[0], opts: {} }; this.rebuild(); }
  }

  // ---------------- view lifecycle ----------------
  onShow() {
    this.visible = true;
    this.applyGuidesMode();
    this.list.measure();
    this.list.render();
    const p = this.focused;
    if (p) { const i = this.rowIndex?.get(p); if (i != null && !this.list.isRowVisible(i)) this.list.reveal(i, { block: 'center' }); }
  }
  onHide() { this.visible = false; }
  focus() { if (!layout.isPhone) this.list.scroller.focus({ preventScroll: true }); }
}

function button(label, run, secondary = false) {
  const b = h('button', { class: ['monaco-button', secondary && 'secondary'] }, label);
  b.addEventListener('click', run);
  return b;
}

function contributed(ctx) {
  let items = [];
  try { items = menus.resolve('explorer/context', ctx); } catch {}
  return items.length ? [{ separator: true }, ...items] : [];
}

export async function addToChat(paths) {
  try {
    const { ai } = await import('../../ai/api.js');
    for (const path of paths) ai.attach({ type: 'file', path });
    await ai.open();
  } catch (err) {
    notify.warn(`X Coder AI is not available: ${err.message}`, { source: 'Explorer' });
  }
}
