// Breadcrumbs bar (VS Code "breadcrumbs below tabs"): folder › folder › file › symbol › symbol.
// Tapping a folder lists its contents, the file lists its siblings, a symbol opens Go to Symbol ("@").

import { h, clear, codicon } from '../core/dom.js';
import { settings } from '../core/settings.js';
import { workspace } from '../core/workspace.js';
import { posix } from '../core/path.js';
import { quickInput } from '../platform/quickinput.js';
import { editors } from '../workbench/editors.js';
import { fileIconHtml, folderIconHtml } from '../workbench/icons.js';
import { symbolIcon } from './symbols.js';

export class Breadcrumbs {
  /** owner: { path, symbolPath() → [symbol], revealSymbol(symbol) } */
  constructor(parent, owner) {
    this.owner = owner;
    this.el = h('div', { class: 'breadcrumbs-below-tabs', role: 'navigation', 'aria-label': 'Breadcrumbs' },
      this.list = h('div', { class: 'monaco-breadcrumbs', role: 'list' }));
    parent.prepend(this.el);
    this.lastKey = '';
    this.off = settings.onChange('breadcrumbs.enabled', () => this.render(true));
    this.render(true);
  }

  item(cls, content, onClick, title) {
    const el = h('div', { class: ['monaco-breadcrumb-item', cls], role: 'listitem', tabindex: '0', title: title || '' }, content, h('span', { class: 'codicon codicon-chevron-right breadcrumb-separator', 'aria-hidden': 'true' }));
    el.addEventListener('click', e => { e.preventDefault(); onClick?.(el); });
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(el); } });
    return el;
  }

  render(force = false) {
    const enabled = settings.get('breadcrumbs.enabled', true) !== false;
    this.el.classList.toggle('hidden', !enabled);
    if (!enabled) return;
    const path = this.owner.path || '';
    let symbols = [];
    try { symbols = this.owner.symbolPath?.() || []; } catch {}
    const key = path + '|' + symbols.map(s => `${s.kind}:${s.name}:${s.from}`).join('/');
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    clear(this.list);
    const parts = path.split('/').filter(Boolean);
    const folders = parts.slice(0, -1);
    folders.forEach((name, i) => {
      const folder = folders.slice(0, i + 1).join('/');
      this.list.append(this.item('folder-item', h('span', { class: 'monaco-icon-label' }, h('span', { class: 'label-name' }, name)), () => pickInFolder(folder), folder));
    });
    const fileName = parts[parts.length - 1] || path;
    this.list.append(this.item('file-item', h('span', { class: 'monaco-icon-label' }, h('span', { class: 'breadcrumb-icon', html: fileIconHtml(path) }), h('span', { class: 'label-name' }, fileName)), () => pickInFolder(posix.dirname(path), path), path));
    for (const s of symbols) {
      this.list.append(this.item('symbol-item', h('span', { class: 'monaco-icon-label' }, codicon(symbolIcon(s.kind), 'breadcrumb-symbol-icon'), h('span', { class: 'label-name' }, s.name)), () => quickInput.open('@'), s.name));
    }
    const last = this.list.lastElementChild;
    last?.classList.add('last');
    requestAnimationFrame(() => { this.list.scrollLeft = this.list.scrollWidth; });
  }

  dispose() { this.off?.(); this.el.remove(); }
}

/** Quick pick of a folder's children (folders drill down, files open). */
async function pickInFolder(folder, activePath) {
  const fs = workspace.fs;
  if (!fs) return;
  const entries = fs.list(folder);
  const items = [];
  if (folder) items.push({ label: '..', description: posix.dirname(folder) || workspace.name, iconHtml: folderIconHtml(false), up: true });
  for (const r of entries) {
    const name = posix.basename(r.path);
    items.push(r.type === 'folder'
      ? { label: name, iconHtml: folderIconHtml(false), folder: r.path }
      : { label: name, iconHtml: fileIconHtml(r.path), path: r.path, id: r.path });
  }
  const activeItem = items.find(i => i.path && i.path === activePath);
  const picked = await quickInput.pick(items, { placeholder: folder ? `${folder}/` : workspace.name, title: folder || workspace.name, activeItem });
  if (!picked) return;
  if (picked.up) return pickInFolder(posix.dirname(folder));
  if (picked.folder) return pickInFolder(picked.folder);
  if (picked.path) editors.open({ type: 'file', path: picked.path }, { pinned: false });
}
