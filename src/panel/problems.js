// PROBLEMS panel tab: markers from core/diagnostics.js grouped by file (VS Code's Problems view).
//
// File rows: twistie · Seti icon · name · folder (description) · count badge.
// Marker rows: severity codicon · message · source(code) · [Ln 3, Col 5]. Tap/Enter opens the file at the marker.
// Filter: text, globs ('**/*.ts') and exclusions ('!**/node_modules/**'), comma separated, plus the
// More Filters menu (Show Errors / Warnings / Infos / Active File Only). Collapse All. Badge = errors + warnings.

import { h, codicon, clear, copyText, onContextMenu, escapeHtml } from '../core/dom.js';
import { bus } from '../core/events.js';
import { diagnostics } from '../core/diagnostics.js';
import { posix } from '../core/path.js';
import { editors } from '../workbench/editors.js';
import { layout } from '../workbench/layout.js';
import { panel } from '../workbench/panel.js';
import { fileIconHtml } from '../workbench/icons.js';
import { showContextMenu } from '../platform/contextmenu.js';
import { globToRegExp } from './shell.js';

const STORE = 'xcoder.problems.filters';
export const PLACEHOLDER = 'Filter (e.g. text, **/*.ts, !**/node_modules/**)';

const state = {
  text: '',
  showErrors: true, showWarnings: true, showInfos: true, activeFileOnly: false,
  collapsed: new Set()
};
try { Object.assign(state, JSON.parse(localStorage.getItem(STORE) || '{}'), { collapsed: new Set() }); } catch {}
function saveFilters() {
  try { localStorage.setItem(STORE, JSON.stringify({ text: state.text, showErrors: state.showErrors, showWarnings: state.showWarnings, showInfos: state.showInfos, activeFileOnly: state.activeFileOnly })); } catch {}
}

const SEVERITY_ICON = { error: 'error', warning: 'warning', info: 'info' };
const sevOf = m => (m.severity === 'error' ? 'error' : m.severity === 'warning' ? 'warning' : 'info');

/** Parses the filter text into { words, include: [RegExp], excludeGlobs: [RegExp], excludeWords } (lowercase words). */
export function parseFilter(text) {
  const out = { words: [], include: [], excludeGlobs: [], excludeWords: [] };
  for (let part of String(text || '').split(',')) {
    part = part.trim();
    if (!part) continue;
    const neg = part.startsWith('!');
    const body = neg ? part.slice(1).trim() : part;
    if (!body) continue;
    const isGlob = /[*?/[\]{}]/.test(body);
    if (neg) { if (isGlob) out.excludeGlobs.push(globToRegExp(body.replace(/^\.?\//, ''))); else out.excludeWords.push(body.toLowerCase()); }
    else if (isGlob) out.include.push(globToRegExp(body.replace(/^\.?\//, '')));
    else out.words.push(body.toLowerCase());
  }
  return out;
}

function matchesPath(re, path) { return re.test(path) || re.test(posix.basename(path)); }

/** Visible groups after filtering: [{ path, markers, total }] and counts { shown, total }. */
export function filteredModel() {
  const f = parseFilter(state.text);
  const active = state.activeFileOnly ? editors.activePath : null;
  const groups = [];
  let shown = 0, total = 0;
  for (const { path, markers } of diagnostics.all()) {
    total += markers.length;
    if (state.activeFileOnly && path !== active) continue;
    if (f.include.length && !f.include.some(re => matchesPath(re, path))) continue;
    if (f.excludeGlobs.some(re => matchesPath(re, path))) continue;
    const list = markers.filter(m => {
      const sev = sevOf(m);
      if ((sev === 'error' && !state.showErrors) || (sev === 'warning' && !state.showWarnings) || (sev === 'info' && !state.showInfos)) return false;
      const hay = `${m.message} ${m.source || ''} ${m.code ?? ''} ${path}`.toLowerCase();
      if (f.words.length && !f.words.every(w => hay.includes(w))) return false;
      if (f.excludeWords.some(w => hay.includes(w))) return false;
      return true;
    });
    if (!list.length) continue;
    shown += list.length;
    groups.push({ path, markers: list, total: markers.length });
  }
  return { groups, shown, total, filtering: !!(state.text.trim() || !state.showErrors || !state.showWarnings || !state.showInfos || state.activeFileOnly), words: f.words };
}

function highlight(text, words) {
  let html = escapeHtml(text);
  if (!words.length) return html;
  const re = new RegExp(`(${words.map(w => escapeHtml(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return html.replace(re, '<span class="highlight">$1</span>');
}

let view = null; // current view instance (one Problems view)

function openMarker(m, { focusEditor = true } = {}) {
  editors.open({ type: 'file', path: m.path }, { pinned: true, focus: focusEditor, reveal: { line: m.line || 1, col: m.col || 1, endLine: m.endLine, endCol: m.endCol, select: true } })
    .catch?.(() => {});
}

function markerText(m) {
  const code = m.code != null && m.code !== '' ? `(${typeof m.code === 'object' ? m.code.value : m.code})` : '';
  return `${m.path}:${m.line}:${m.col} - ${sevOf(m)}${m.source ? ` ${m.source}${code}` : code}: ${m.message}`;
}

class ProblemsView {
  constructor(host) {
    this.host = host;
    host.classList.add('problems-panel');
    this.rows = [];
    this.focusIndex = -1;
    this.filterRow = h('div', { class: 'panel-filter-row' });
    this.list = h('div', { class: 'monaco-list problems-tree', role: 'tree', tabindex: '0', 'aria-label': 'Problems' });
    this.message = h('div', { class: 'problems-message view-message hidden' });
    host.append(this.filterRow, this.list, this.message);
    this.filterBox = this.buildFilter();
    this.list.addEventListener('keydown', e => this.onKey(e));
    this.placeFilter();
    this.render();
  }

  buildFilter() {
    this.input = h('input', {
      type: 'text', class: 'problems-filter-input', placeholder: PLACEHOLDER, 'aria-label': PLACEHOLDER, value: state.text,
      autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off', enterkeyhint: 'search'
    });
    this.input.value = state.text;
    this.count = h('span', { class: 'filter-count monaco-count-badge hidden' });
    this.moreFilters = h('a', { class: ['monaco-custom-toggle', 'codicon', 'codicon-filter', 'more-filters'], role: 'button', tabindex: '0', title: 'More Filters...', 'aria-label': 'More Filters...' });
    this.moreFilters.addEventListener('click', e => { e.stopPropagation(); this.showFilterMenu(this.moreFilters); });
    this.input.addEventListener('input', () => { state.text = this.input.value; saveFilters(); this.render(); });
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.input.value) { e.stopPropagation(); this.input.value = ''; state.text = ''; saveFilters(); this.render(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); this.list.focus(); this.setFocus(0); }
    });
    return h('div', { class: 'monaco-inputbox problems-filter' }, this.input, h('div', { class: 'controls' }, this.count, this.moreFilters));
  }

  /** Phones: the filter sits above the tree (panel title space is tight). Desktop: in the title actions. */
  placeFilter() {
    if (layout.isPhone) {
      if (this.filterBox.parentNode !== this.filterRow) this.filterRow.append(this.filterBox);
      this.filterRow.classList.remove('hidden');
    } else this.filterRow.classList.add('hidden');
  }

  showFilterMenu(anchor) {
    const toggle = (key) => () => { state[key] = !state[key]; saveFilters(); this.render(); };
    showContextMenu([
      { label: 'Show Errors', checked: state.showErrors, run: toggle('showErrors') },
      { label: 'Show Warnings', checked: state.showWarnings, run: toggle('showWarnings') },
      { label: 'Show Infos', checked: state.showInfos, run: toggle('showInfos') },
      { separator: true },
      { label: 'Show Active File Only', checked: state.activeFileOnly, run: toggle('activeFileOnly') }
    ], anchor ? { anchor, align: 'right' } : undefined);
  }

  collapseAll() {
    for (const { path } of diagnostics.all()) state.collapsed.add(path);
    this.render();
  }

  clearFilters() {
    Object.assign(state, { text: '', showErrors: true, showWarnings: true, showInfos: true, activeFileOnly: false });
    this.input.value = '';
    saveFilters();
    this.render();
  }

  render() {
    const model = filteredModel();
    const focusedKey = this.rows[this.focusIndex]?.key;
    clear(this.list);
    this.rows = [];
    for (const g of model.groups) {
      const collapsed = state.collapsed.has(g.path);
      const name = posix.basename(g.path), dir = posix.dirname(g.path);
      const fileRow = h('div', {
        class: 'monaco-list-row problems-row file-row', role: 'treeitem', 'aria-level': '1', 'aria-expanded': String(!collapsed),
        'data-path': g.path, title: g.path, 'aria-label': `${name}, ${dir || 'root'}, ${g.markers.length} problems`
      },
        h('div', { class: ['monaco-tl-twistie', 'collapsible', !collapsed && 'expanded'] }),
        h('span', { class: 'file-icon-host', html: fileIconHtml(g.path) }),
        h('span', { class: 'monaco-icon-label' },
          h('span', { class: 'label-name', html: highlight(name, model.words) }),
          dir ? h('span', { class: 'label-description', html: highlight(dir, model.words) }) : null),
        h('span', { class: 'monaco-count-badge' }, String(g.markers.length)));
      const fileEntry = { key: `f:${g.path}`, el: fileRow, kind: 'file', path: g.path, group: g };
      fileRow.addEventListener('click', () => { this.setFocus(this.rows.indexOf(fileEntry)); this.toggle(g.path); });
      onContextMenu(fileRow, (x, y) => showContextMenu([
        { label: 'Copy', icon: 'copy', run: () => copyText(g.markers.map(markerText).join('\n')) },
        { label: 'Copy Path', run: () => copyText(g.path) },
        { separator: true },
        { label: collapsed ? 'Expand' : 'Collapse', run: () => this.toggle(g.path) },
        { label: 'Collapse All', run: () => this.collapseAll() }
      ], { x, y }));
      this.list.append(fileRow);
      this.rows.push(fileEntry);
      if (collapsed) continue;
      for (const m of g.markers) {
        const sev = sevOf(m);
        const code = m.code != null && m.code !== '' ? `(${typeof m.code === 'object' ? m.code.value : m.code})` : '';
        const row = h('div', {
          class: ['monaco-list-row', 'problems-row', 'marker-row', `severity-${sev}`], role: 'treeitem', 'aria-level': '2',
          'data-path': g.path, 'data-line': String(m.line || 1), title: `${m.message}${m.source ? ` ${m.source}${code}` : ''} [Ln ${m.line}, Col ${m.col}]`,
          'aria-label': `${sev}: ${m.message} at line ${m.line} column ${m.col} in ${name}`
        },
          codicon(SEVERITY_ICON[sev], `marker-icon ${sev}`),
          h('span', { class: 'marker-body' },
            h('span', { class: 'marker-message', html: highlight(m.message, model.words) }),
            m.source || code ? h('span', { class: 'marker-source' }, `${m.source || ''}${code}`) : null,
            h('span', { class: 'marker-line' }, `[Ln ${m.line}, Col ${m.col}]`)));
        const entry = { key: `m:${g.path}:${m.line}:${m.col}:${m.message}`, el: row, kind: 'marker', marker: m };
        row.addEventListener('click', () => { this.setFocus(this.rows.indexOf(entry)); openMarker(m); });
        onContextMenu(row, (x, y) => showContextMenu([
          { label: 'Copy', icon: 'copy', run: () => copyText(markerText(m)) },
          { label: 'Copy Message', run: () => copyText(m.message) },
          { separator: true },
          { label: 'Go to Problem', run: () => openMarker(m) }
        ], { x, y }));
        this.list.append(row);
        this.rows.push(entry);
      }
    }
    this.focusIndex = focusedKey ? this.rows.findIndex(r => r.key === focusedKey) : -1;
    this.rows[this.focusIndex]?.el.classList.add('focused', 'selected');

    // Empty states (VS Code wording).
    this.message.classList.toggle('hidden', model.groups.length > 0);
    clear(this.message);
    if (!model.groups.length) {
      if (model.total && model.filtering) {
        this.message.append('No results found with provided filter criteria. ',
          h('a', { class: 'text-link-button', role: 'button', tabindex: '0', onclick: () => this.clearFilters() }, 'Clear Filters'));
      } else this.message.append('No problems have been detected in the workspace.');
    }
    this.count.classList.toggle('hidden', !model.filtering || !model.total);
    this.count.textContent = `Showing ${model.shown} of ${model.total}`;
    this.moreFilters.classList.toggle('checked', !state.showErrors || !state.showWarnings || !state.showInfos || state.activeFileOnly);
  }

  toggle(path) {
    if (state.collapsed.has(path)) state.collapsed.delete(path); else state.collapsed.add(path);
    this.render();
  }

  setFocus(i) {
    for (const r of this.rows) r.el.classList.remove('focused', 'selected');
    this.focusIndex = Math.max(-1, Math.min(this.rows.length - 1, i));
    const r = this.rows[this.focusIndex];
    if (r) { r.el.classList.add('focused', 'selected'); r.el.scrollIntoView({ block: 'nearest' }); }
  }

  onKey(e) {
    const r = this.rows[this.focusIndex];
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); this.setFocus(this.focusIndex + 1); break;
      case 'ArrowUp': e.preventDefault(); this.setFocus(this.focusIndex <= 0 ? 0 : this.focusIndex - 1); break;
      case 'Home': e.preventDefault(); this.setFocus(0); break;
      case 'End': e.preventDefault(); this.setFocus(this.rows.length - 1); break;
      case 'ArrowLeft':
        if (!r) return;
        e.preventDefault();
        if (r.kind === 'file' && !state.collapsed.has(r.path)) this.toggle(r.path);
        else if (r.kind === 'marker') this.setFocus(this.rows.findIndex(x => x.kind === 'file' && x.path === r.marker.path));
        break;
      case 'ArrowRight':
        if (r?.kind === 'file' && state.collapsed.has(r.path)) { e.preventDefault(); this.toggle(r.path); }
        break;
      case 'Enter': case ' ':
        if (!r) return;
        e.preventDefault();
        if (r.kind === 'file') this.toggle(r.path); else openMarker(r.marker, { focusEditor: e.key === 'Enter' });
        break;
    }
  }

  focus() {
    if (layout.isPhone) { this.list.focus({ preventScroll: true }); return; }
    this.list.focus({ preventScroll: true });
    if (this.focusIndex < 0 && this.rows.length) this.setFocus(0);
  }
}

export const problemsTab = {
  id: 'problems',
  title: 'Problems',
  order: 1,
  keybinding: 'Mod+Shift+M',
  render(host) {
    view = new ProblemsView(host);
    return {
      onShow: () => { view.placeFilter(); },
      focus: () => view.focus(),
      dispose: () => { view = null; }
    };
  },
  actions() {
    const list = [];
    if (view && !layout.isPhone) list.push({ element: view.filterBox });
    else list.push({ icon: 'filter', title: 'More Filters...', checked: !state.showErrors || !state.showWarnings || !state.showInfos || state.activeFileOnly, run: el => view?.showFilterMenu(el) });
    list.push({ icon: 'collapse-all', title: 'Collapse All', run: () => view?.collapseAll() });
    return list;
  }
};

/** Counts for the status bar and the tab badge. */
export function problemCounts() { return diagnostics.counts(); }

let lastBadge;
export function refreshProblems() {
  view?.render();
  view?.placeFilter();
  const c = diagnostics.counts();
  const badge = c.errors + c.warnings || null;
  if (badge !== lastBadge) { lastBadge = badge; panel.setBadge('problems', badge); }
}

export function focusProblemsFilter() { view?.input.focus(); }

bus.on('editor:activeChanged', () => { if (state.activeFileOnly) view?.render(); });
bus.on('theme:changed', () => view?.render());
bus.on('layout:changed', () => view?.placeFilter());
