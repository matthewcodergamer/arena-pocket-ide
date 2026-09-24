// Explorer › OPEN EDITORS (workbench.explorer.openEditorsView): every open editor with its Seti icon,
// preview (italic) state, dirty dot and close button; tap to activate. Mirrors the tab strip.

import { h, codiconHtml, onContextMenu, isApple } from '../../core/dom.js';
import { bus, DisposableStore } from '../../core/events.js';
import { posix } from '../../core/path.js';
import { commands, keybindingLabel } from '../../core/commands.js';
import { menus } from '../../core/menus.js';
import { editors } from '../../workbench/editors.js';
import { views } from '../../workbench/views.js';
import { fileIconHtml } from '../../workbench/icons.js';
import { showContextMenu } from '../../platform/contextmenu.js';

export const OPEN_EDITORS_VIEW = 'workbench.explorer.openEditorsView';

function labelFor(entry) {
  const input = entry.input;
  const p = editors.provider(input?.type);
  let title = 'Untitled', description = '', icon = '', tooltip = '';
  try { title = p?.title?.(input) ?? (input.path ? posix.basename(input.path) : title); } catch {}
  try { description = p?.description?.(input) ?? (input.path ? posix.dirname(input.path) : ''); } catch {}
  try { tooltip = p?.tooltip?.(input) ?? (input.path || title); } catch {}
  try { icon = p?.icon ? p.icon(input) : (input.path ? fileIconHtml(input.path) : codiconHtml('file')); } catch {}
  return { title, description, icon, tooltip };
}

export class OpenEditorsView {
  constructor(body) {
    this.store = new DisposableStore();
    this.el = h('div', { class: 'monaco-list open-editors-list', role: 'listbox', tabindex: '0', 'aria-label': 'Open Editors' });
    body.append(this.el);
    this.renderSoon = () => { if (this.queued) return; this.queued = true; requestAnimationFrame(() => { this.queued = false; this.render(); }); };
    for (const ev of ['editor:opened', 'editor:closed', 'editor:activeChanged', 'editor:dirty', 'editor:saved', 'theme:changed', 'project:opened']) this.store.add(bus.on(ev, this.renderSoon));
    this.store.add(bus.on('fs:changed', ev => { if (ev?.type === 'rename') this.renderSoon(); }));
    // Pinning a preview editor or re-titling a tab re-renders the tab strip: mirror it.
    const strip = document.getElementById('tabs-container');
    if (strip && typeof MutationObserver === 'function') {
      const mo = new MutationObserver(this.renderSoon);
      mo.observe(strip, { childList: true });
      this.store.add(() => mo.disconnect());
    }
    this.el.addEventListener('keydown', e => this.onKeyDown(e));
    this.render();
  }

  render() {
    const list = editors.list();
    const activeKey = editors.active?.key;
    const dirty = list.filter(e => e.dirty).length;
    try { views.setDescription(OPEN_EDITORS_VIEW, dirty ? `${dirty} unsaved` : ''); } catch {}
    this.el.replaceChildren();
    if (!list.length) return;
    for (const entry of list) {
      const { title, description, icon, tooltip } = labelFor(entry);
      const close = h('a', { class: 'action-label codicon codicon-close', role: 'button', title: `Close (${keybindingLabel('Mod+W')})`, 'aria-label': `Close ${title}` });
      const row = h('div', {
        class: ['monaco-list-row', 'open-editor', entry.key === activeKey && 'selected', entry.dirty && 'dirty', !entry.pinned && 'preview'],
        role: 'option', 'aria-selected': String(entry.key === activeKey), title: tooltip, 'data-key': entry.key
      },
        h('div', { class: 'open-editor-actions' }, close, h('span', { class: 'dirty-indicator codicon codicon-circle-filled', 'aria-hidden': 'true' })),
        h('div', { class: 'monaco-icon-label' },
          h('span', { class: 'explorer-file-icon', html: icon }),
          h('span', { class: 'label-name' }, title),
          description && description !== '.' ? h('span', { class: 'label-description' }, description) : null));
      close.addEventListener('click', e => { e.stopPropagation(); editors.close(entry.key); });
      row.addEventListener('click', () => { editors.open(entry.input, { pinned: entry.pinned }).catch(() => {}); });
      row.addEventListener('dblclick', () => editors.pin(entry.key));
      row.addEventListener('auxclick', e => { if (e.button === 1) { e.preventDefault(); editors.close(entry.key); } });
      onContextMenu(row, (x, y) => showContextMenu(this.menu(entry), { x, y }));
      this.el.append(row);
    }
  }

  menu(entry) {
    const path = entry.input?.type === 'file' ? entry.input.path : null;
    const items = [
      { label: 'Close', keybinding: keybindingLabel('Mod+W'), run: () => editors.close(entry.key) },
      { label: 'Close Others', run: () => editors.closeOthers(entry.key) },
      { label: 'Close Saved', run: () => editors.closeAll({ saved: true }) },
      { label: 'Close All', run: () => editors.closeAll() },
      { separator: true }
    ];
    if (entry.dirty && entry.instance?.save) items.push({ label: 'Save', keybinding: keybindingLabel('Mod+S'), run: () => editors.save(entry.key) }, { separator: true });
    if (path) {
      items.push(
        { label: 'Copy Path', keybinding: keybindingLabel('Mod+Alt+C'), run: () => commands.execute('copyFilePath', { path }) },
        { label: 'Copy Relative Path', keybinding: keybindingLabel('Mod+Alt+Shift+C'), run: () => commands.execute('copyRelativeFilePath', { path }) },
        { label: 'Reveal in Explorer View', run: () => commands.execute('workbench.files.action.showActiveFileInExplorer', { path }) },
        { separator: true });
    }
    if (!entry.pinned) items.push({ label: 'Keep Open', run: () => editors.pin(entry.key) });
    try { items.push(...menus.resolve('editor/tab/context', entry.input)); } catch {}
    return items;
  }

  onKeyDown(e) {
    const rows = [...this.el.children];
    if (!rows.length) return;
    let i = rows.findIndex(r => r.classList.contains('focused'));
    if (i < 0) i = rows.findIndex(r => r.classList.contains('selected'));
    const move = n => { rows.forEach(r => r.classList.remove('focused')); const r = rows[Math.max(0, Math.min(rows.length - 1, n))]; r.classList.add('focused'); r.scrollIntoView({ block: 'nearest' }); };
    if (e.key === 'ArrowDown') { e.preventDefault(); move(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(i - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); rows[i]?.click(); }
    else if (e.key === 'Delete' || (e.key === 'Backspace' && (isApple ? e.metaKey : e.ctrlKey))) {
      e.preventDefault(); const key = rows[i]?.dataset.key; if (key) editors.close(key);
    }
  }

  focus() { this.el.focus({ preventScroll: true }); }
  dispose() { this.store.dispose(); this.el.remove(); }
}

export const openEditorsActions = [
  { icon: 'new-file', title: 'New Untitled Text File', command: 'workbench.action.files.newUntitledFile', run: () => commands.execute('workbench.action.files.newUntitledFile') },
  { icon: 'save-all', title: 'Save All', command: 'workbench.action.files.saveAll', run: () => commands.execute('workbench.action.files.saveAll') },
  { icon: 'close-all', title: 'Close All Editors', command: 'workbench.action.closeAllEditors', run: () => commands.execute('workbench.action.closeAllEditors') }
];


