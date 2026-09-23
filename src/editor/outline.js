// OUTLINE view (Explorer): the symbol tree of the active editor; tap to reveal, follows the cursor.

import { h, clear, escapeHtml } from '../core/dom.js';
import { bus } from '../core/events.js';
import { views } from '../workbench/views.js';
import { layout } from '../workbench/layout.js';
import { editorEvents, activeCode } from './registry.js';
import { SYMBOL_ICON, symbolPathAt } from './symbols.js';

const STORE = 'xcoder.outline.v1';
let prefs = { follow: true, sort: 'position' };
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch {}
const savePrefs = () => { try { localStorage.setItem(STORE, JSON.stringify(prefs)); } catch {} };

class OutlineView {
  constructor(body) {
    this.body = body;
    this.collapsed = new Set();
    this.list = h('div', { class: 'monaco-list outline-tree', role: 'tree', tabindex: '0', 'aria-label': 'Outline' });
    body.append(this.list);
    this.timer = 0;
    this.offs = [
      bus.on('editor:activeChanged', () => this.refreshSoon(0)),
      editorEvents.on('change', () => this.refreshSoon(400)),
      editorEvents.on('language', () => this.refreshSoon(0)),
      editorEvents.on('cursor', ed => { if (prefs.follow && ed === activeCode()) this.follow(); })
    ];
    this.refresh(true);
  }
  refreshSoon(ms) { clearTimeout(this.timer); this.timer = setTimeout(() => this.refresh(), ms); }

  sorted(list) {
    if (prefs.sort === 'name') return [...list].sort((a, b) => a.name.localeCompare(b.name));
    if (prefs.sort === 'kind') return [...list].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    return list;
  }

  refresh(force = false) {
    if (!force && this.body.offsetParent === null) { this.stale = true; return; }
    this.stale = false;
    const ed = activeCode();
    clear(this.list);
    this.rows = new Map();
    this.editor = ed;
    if (!ed) { this.list.append(h('div', { class: 'view-message' }, 'The active editor cannot provide outline information.')); return; }
    const symbols = ed.symbols();
    if (!symbols.length) { this.list.append(h('div', { class: 'view-message' }, 'No symbols found in document \'' + ed.path.split('/').pop() + '\'')); return; }
    const render = (list, depth) => {
      for (const s of this.sorted(list)) {
        const key = `${s.kind}:${s.name}:${s.selFrom}`;
        const hasKids = s.children?.length > 0;
        const expanded = hasKids && !this.collapsed.has(key);
        const twistie = h('span', { class: ['monaco-tl-twistie', hasKids && 'collapsible', expanded && 'expanded'] });
        const row = h('div', { class: 'monaco-list-row outline-row', role: 'treeitem', 'aria-level': String(depth + 1), 'aria-expanded': hasKids ? String(expanded) : null, style: { paddingLeft: `${8 + depth * 8}px` }, title: s.name },
          twistie,
          h('span', { class: `outline-icon codicon codicon-${SYMBOL_ICON[s.kind] || 'symbol-misc'} kind-${s.kind}` }),
          h('span', { class: 'monaco-icon-label' }, h('span', { class: 'label-name', html: escapeHtml(s.name) })));
        twistie.addEventListener('click', e => { e.stopPropagation(); if (hasKids) { if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key); this.refresh(true); } });
        row.addEventListener('click', () => this.reveal(s));
        this.list.append(row);
        this.rows.set(s, row);
        if (expanded) render(s.children, depth + 1);
      }
    };
    render(symbols, 0);
    if (prefs.follow) this.follow();
  }

  reveal(s) {
    const ed = this.editor;
    if (!ed || ed.disposed) return;
    const doc = ed.view.state.doc;
    const a = doc.lineAt(s.selFrom);
    ed.reveal({ line: a.number, col: s.selFrom - a.from + 1, flash: true });
    if (layout.isPhone) layout.dismissOverlays();
    ed.focus();
  }

  follow() {
    const ed = this.editor;
    if (!ed || ed.disposed || !this.rows) return;
    const path = symbolPathAt(ed.symbols(), ed.view.state.selection.main.head);
    for (const row of this.list.querySelectorAll('.outline-row.selected')) row.classList.remove('selected');
    const target = path[path.length - 1];
    if (!target) return;
    const row = this.rows.get(target);
    if (row) { row.classList.add('selected'); row.scrollIntoView({ block: 'nearest' }); }
  }

  collapseAll() {
    const walk = list => { for (const s of list) if (s.children?.length) { this.collapsed.add(`${s.kind}:${s.name}:${s.selFrom}`); walk(s.children); } };
    if (this.editor) walk(this.editor.symbols());
    this.refresh(true);
  }
  dispose() { clearTimeout(this.timer); for (const off of this.offs) off(); }
}

let current = null;
export function registerOutline() {
  views.registerView({
    id: 'outline', containerId: 'workbench.view.explorer', name: 'Outline', order: 3, collapsed: true,
    render(body) { current = new OutlineView(body); return { dispose: () => { current?.dispose(); current = null; }, onShow: () => current?.refresh(true), focus: () => current?.list.focus() }; },
    actions: [{ icon: 'collapse-all', title: 'Collapse All', run: () => current?.collapseAll() }],
    moreActions: () => [
      { label: 'Follow Cursor', checked: prefs.follow, run: () => { prefs.follow = !prefs.follow; savePrefs(); current?.refresh(); } },
      { separator: true },
      { label: 'Sort By: Position', checked: prefs.sort === 'position', run: () => { prefs.sort = 'position'; savePrefs(); current?.refresh(); } },
      { label: 'Sort By: Name', checked: prefs.sort === 'name', run: () => { prefs.sort = 'name'; savePrefs(); current?.refresh(); } },
      { label: 'Sort By: Category', checked: prefs.sort === 'kind', run: () => { prefs.sort = 'kind'; savePrefs(); current?.refresh(); } }
    ]
  });
}

