// SEARCH view (workbench.view.search): VS Code's search widget (replace toggle, Match Case / Whole Word /
// Regex toggles, Preserve Case, Replace All, files to include/exclude) and a virtualized results tree
// grouped by file (list or folder tree) with inline replace previews and per-match / per-file actions.

import { h, isApple, isTouch, onContextMenu, copyText, debounce } from '../../core/dom.js';
import { bus, DisposableStore } from '../../core/events.js';
import { workspace } from '../../core/workspace.js';
import { posix } from '../../core/path.js';
import { settings } from '../../core/settings.js';
import { commands, keybindingLabel } from '../../core/commands.js';
import { notify } from '../../platform/notifications.js';
import { dialogs } from '../../platform/dialogs.js';
import { showContextMenu } from '../../platform/contextmenu.js';
import { editors } from '../../workbench/editors.js';
import { views } from '../../workbench/views.js';
import { layout } from '../../workbench/layout.js';
import { fileIconHtml } from '../../workbench/icons.js';
import { codeEditor } from '../../editor/api.js';
import { VirtualList } from '../explorer/virtualList.js';
import { runSearch, applyReplacements, replacementAt, validateQuery } from './model.js';

export const SEARCH_VIEW = 'workbench.view.search';
const STATE_KEY = 'xcoder.search.v6';
const DEFAULT_STATE = {
  query: '', replace: '', include: '', exclude: '', isRegex: false, caseSensitive: false, wholeWord: false, preserveCase: false,
  replaceVisible: false, detailsVisible: false, useExcludeSettings: true, onlyOpenEditors: false, viewMode: null, history: []
};

function loadState() {
  try { return { ...DEFAULT_STATE, ...JSON.parse(localStorage.getItem(STATE_KEY) || '{}') }; } catch { return { ...DEFAULT_STATE }; }
}

/** VS Code's lcut: keep roughly the last `n` characters of `text`, cutting at a word boundary. */
function lcut(text, n) {
  const trimmed = text.trimStart();
  if (trimmed.length < n) return trimmed;
  const re = /\b/g; let i = 0;
  while (re.test(trimmed)) { if (trimmed.length - re.lastIndex < n) break; i = re.lastIndex; re.lastIndex += 1; }
  return i === 0 ? trimmed : '…' + trimmed.slice(i).trimStart();
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export class SearchView {
  constructor(body) {
    this.store = new DisposableStore();
    this.state = loadState();
    if (!this.state.viewMode) this.state.viewMode = settings.get('search.defaultViewMode', 'list');
    this.result = null;           // { files, total, limitHit, error, q }
    this.collapsed = new Set();   // row keys
    this.selectedKey = null;
    this.historyIndex = -1;
    this.el = h('div', { class: 'search-view' });
    body.append(this.el);
    this.buildWidget();
    this.messages = h('div', { class: 'search-messages', 'aria-live': 'polite' });
    this.list = new VirtualList({
      className: 'search-results show-file-icons', role: 'tree', ariaLabel: 'Search results',
      keyOf: r => r.key, sigOf: r => this.rowSig(r), renderRow: r => this.renderRow(r), updateRow: (el, r) => this.updateRow(el, r)
    });
    this.resultsHost = h('div', { class: 'results' }, this.list.scroller);
    this.el.append(this.messages, this.resultsHost);
    this.bindResults();
    this.applyState();

    this.searchSoon = debounce(() => this.search(), Number(settings.get('search.searchOnTypeDebouncePeriod', 300)) || 300);
    const refreshSoon = debounce(() => { if (this.result && this.state.query) this.search({ keepView: true }); }, 500);
    this.store.add(() => { this.searchSoon.cancel(); refreshSoon.cancel(); });
    this.store.add(bus.on('fs:changed', ev => { if (ev?.source !== 'search-internal') refreshSoon(); }));
    this.store.add(bus.on('project:opened', () => { this.result = null; this.collapsed.clear(); this.render(); if (this.state.query) this.search(); }));
    this.store.add(bus.on('theme:changed', () => this.list.refresh()));
    this.store.add(bus.on('settings:changed', ({ key }) => {
      if (key === 'search.exclude' || key === 'search.smartCase') { if (this.state.query) this.search({ keepView: true }); }
      else if (key === 'search.searchOnTypeDebouncePeriod') { this.searchSoon.cancel(); this.searchSoon = debounce(() => this.search(), Number(settings.get('search.searchOnTypeDebouncePeriod', 300)) || 300); }
    }));
    if (this.state.query && workspace.fs) this.search();
  }

  persist() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(this.state)); } catch {}
  }

  // ---------------- widget ----------------
  toggle(icon, title, key, onChange) {
    const el = h('div', { class: `monaco-custom-toggle codicon codicon-${icon}`, role: 'checkbox', tabindex: '0', title, 'aria-label': title });
    const sync = () => { el.classList.toggle('checked', !!this.state[key]); el.setAttribute('aria-checked', String(!!this.state[key])); };
    const flip = () => { this.state[key] = !this.state[key]; sync(); this.persist(); onChange?.(); };
    el.addEventListener('click', e => { e.preventDefault(); flip(); });
    el.addEventListener('pointerdown', e => e.preventDefault()); // keep the input focused (and the iOS keyboard open)
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
    el.sync = sync; el.flip = flip;
    sync();
    return el;
  }

  input(placeholder, ariaLabel, cls = '') {
    return h('input', {
      class: `input ${cls}`, type: 'text', placeholder, 'aria-label': ariaLabel, autocomplete: 'off', autocapitalize: 'off',
      autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search'
    });
  }

  buildWidget() {
    const alt = k => (isApple ? `⌥${k}` : `Alt+${k}`);
    this.caseToggle = this.toggle('case-sensitive', `Match Case (${alt('C')})`, 'caseSensitive', () => this.search());
    this.wordToggle = this.toggle('whole-word', `Match Whole Word (${alt('W')})`, 'wholeWord', () => this.search());
    this.regexToggle = this.toggle('regex', `Use Regular Expression (${alt('R')})`, 'isRegex', () => this.search());
    this.preserveToggle = this.toggle('preserve-case', `Preserve Case (${alt('P')})`, 'preserveCase', () => this.render());
    this.excludeToggle = this.toggle('exclude', 'Use Exclude Settings and Ignore Files', 'useExcludeSettings', () => this.search());
    this.openEditorsToggle = this.toggle('book', 'Search only in Open Editors', 'onlyOpenEditors', () => this.search());

    this.searchInput = this.input('Search', 'Search: Type Search Term and press Enter to search', 'search-input');
    this.searchMessage = h('div', { class: 'monaco-inputbox-message hidden', role: 'alert' });
    this.searchBox = h('div', { class: 'monaco-inputbox search-inputbox' }, this.searchInput, h('div', { class: 'controls' }, this.caseToggle, this.wordToggle, this.regexToggle));
    this.replaceInput = this.input('Replace', 'Replace: Type replace term and press Enter to preview', 'replace-input');
    this.replaceBox = h('div', { class: 'monaco-inputbox replace-inputbox' }, this.replaceInput, h('div', { class: 'controls' }, this.preserveToggle));
    const replaceAllTitle = `Replace All (${keybindingLabel('Mod+Alt+Enter')})`;
    this.replaceAllBtn = h('a', { class: 'action-label codicon codicon-replace-all', role: 'button', tabindex: '0', title: replaceAllTitle, 'aria-label': replaceAllTitle });
    this.replaceAllBtn.addEventListener('click', () => this.replaceAll());
    this.toggleReplaceBtn = h('div', { class: 'toggle-replace-button codicon', role: 'button', tabindex: '0', title: 'Toggle Replace', 'aria-label': 'Toggle Replace' });
    this.toggleReplaceBtn.addEventListener('click', () => this.setReplaceVisible(!this.state.replaceVisible, true));
    this.replaceContainer = h('div', { class: 'replace-container' }, this.replaceBox, h('div', { class: 'monaco-action-bar replace-actions' }, this.replaceAllBtn));

    this.includeInput = this.input('e.g. *.ts, src/**/include', 'Search Include Patterns', 'include-input');
    this.excludeInput = this.input('e.g. *.ts, src/**/exclude', 'Search Exclude Patterns', 'exclude-input');
    this.detailsBtn = h('div', { class: 'more codicon codicon-ellipsis', role: 'button', tabindex: '0', title: `Toggle Search Details (${keybindingLabel('Mod+Shift+J')})`, 'aria-label': 'Toggle Search Details' });
    this.detailsBtn.addEventListener('click', () => this.setDetailsVisible(!this.state.detailsVisible, true));
    this.details = h('div', { class: 'query-details' }, this.detailsBtn,
      h('div', { class: 'file-types includes' }, h('h4', {}, 'files to include'),
        h('div', { class: 'monaco-inputbox' }, this.includeInput, h('div', { class: 'controls' }, this.openEditorsToggle))),
      h('div', { class: 'file-types excludes' }, h('h4', {}, 'files to exclude'),
        h('div', { class: 'monaco-inputbox' }, this.excludeInput, h('div', { class: 'controls' }, this.excludeToggle))));

    this.progress = h('div', { class: 'monaco-progress-container' }, h('div', { class: 'progress-bit' }));
    this.widget = h('div', { class: 'search-widgets-container' },
      h('div', { class: 'search-widget' },
        this.toggleReplaceBtn,
        h('div', { class: 'search-container input-box' }, this.searchBox, this.searchMessage),
        this.replaceContainer),
      this.details);
    this.el.append(this.progress, this.widget);

    // input behaviour
    this.searchInput.addEventListener('input', () => {
      this.state.query = this.searchInput.value; this.persist(); this.historyIndex = -1;
      if (this.validate()) this.search(); // invalid regex: clear stale results right away
      else if (settings.get('search.searchOnType', true)) this.searchSoon(); else if (!this.state.query) this.clearResults();
    });
    this.replaceInput.addEventListener('input', () => { this.state.replace = this.replaceInput.value; this.persist(); this.render(); });
    const onPattern = key => e => { this.state[key] = e.target.value; this.persist(); if (settings.get('search.searchOnType', true)) this.searchSoon(); };
    this.includeInput.addEventListener('input', onPattern('include'));
    this.excludeInput.addEventListener('input', onPattern('exclude'));
    const keys = e => {
      if (e.isComposing) return;
      const altKey = e.altKey && !e.metaKey && !e.ctrlKey;
      if (altKey && e.code === 'KeyC') { e.preventDefault(); this.caseToggle.flip(); }
      else if (altKey && e.code === 'KeyW') { e.preventDefault(); this.wordToggle.flip(); }
      else if (altKey && e.code === 'KeyR') { e.preventDefault(); this.regexToggle.flip(); }
      else if (altKey && e.code === 'KeyP') { e.preventDefault(); this.preserveToggle.flip(); }
      else if (e.key === 'Enter' && (isApple ? e.metaKey : e.ctrlKey) && e.altKey) { e.preventDefault(); this.replaceAll(); }
      else if (e.key === 'Enter') {
        e.preventDefault(); this.searchSoon.cancel(); this.search({ addHistory: true });
        if (layout.isPhone) e.target.blur();
      } else if (e.target === this.searchInput && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && this.state.history.length) {
        e.preventDefault(); this.navigateHistory(e.key === 'ArrowUp' ? 1 : -1);
      } else if (e.key === 'ArrowDown' && e.target !== this.searchInput && this.list.rows.length) { e.preventDefault(); this.moveSelection(1); this.list.scroller.focus(); }
      else if ((isApple ? e.metaKey : e.ctrlKey) && e.shiftKey && e.code === 'KeyJ') { e.preventDefault(); this.setDetailsVisible(!this.state.detailsVisible, true); }
      else return;
      e.stopPropagation();
    };
    for (const i of [this.searchInput, this.replaceInput, this.includeInput, this.excludeInput]) i.addEventListener('keydown', keys);
    for (const b of [this.toggleReplaceBtn, this.detailsBtn, this.replaceAllBtn]) b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click(); } });
  }

  applyState() {
    this.searchInput.value = this.state.query;
    this.replaceInput.value = this.state.replace;
    this.includeInput.value = this.state.include;
    this.excludeInput.value = this.state.exclude;
    for (const t of [this.caseToggle, this.wordToggle, this.regexToggle, this.preserveToggle, this.excludeToggle, this.openEditorsToggle]) t.sync();
    this.setReplaceVisible(this.state.replaceVisible);
    this.setDetailsVisible(this.state.detailsVisible);
    this.validate();
  }

  setReplaceVisible(v, focus = false) {
    this.state.replaceVisible = !!v; this.persist();
    this.widget.classList.toggle('replace-visible', this.state.replaceVisible);
    this.toggleReplaceBtn.classList.toggle('codicon-chevron-down', this.state.replaceVisible);
    this.toggleReplaceBtn.classList.toggle('codicon-chevron-right', !this.state.replaceVisible);
    this.toggleReplaceBtn.setAttribute('aria-expanded', String(this.state.replaceVisible));
    this.render();
    if (focus && this.state.replaceVisible) this.replaceInput.focus();
  }

  setDetailsVisible(v, focus = false) {
    this.state.detailsVisible = !!v; this.persist();
    this.details.classList.toggle('expanded', this.state.detailsVisible);
    this.detailsBtn.setAttribute('aria-expanded', String(this.state.detailsVisible));
    if (focus && this.state.detailsVisible) this.includeInput.focus();
  }

  validate() {
    const err = this.state.isRegex ? validateQuery(this.state) : null;
    this.searchBox.classList.toggle('error', !!err);
    this.searchMessage.className = `monaco-inputbox-message ${err ? 'error' : 'hidden'}`;
    this.searchMessage.textContent = err || '';
    return err;
  }

  navigateHistory(dir) {
    const hist = this.state.history;
    this.historyIndex = Math.max(-1, Math.min(hist.length - 1, this.historyIndex + dir));
    this.searchInput.value = this.historyIndex < 0 ? '' : hist[this.historyIndex];
    this.state.query = this.searchInput.value; this.persist();
    this.searchSoon();
  }

  /** Sets fields from VS Code's workbench.action.findInFiles arguments. */
  setQuery(args = {}) {
    const map = { query: 'query', replace: 'replace', filesToInclude: 'include', filesToExclude: 'exclude', isRegex: 'isRegex', isCaseSensitive: 'caseSensitive', matchWholeWord: 'wholeWord', preserveCase: 'preserveCase', useExcludeSettingsAndIgnoreFiles: 'useExcludeSettings', onlyOpenEditors: 'onlyOpenEditors' };
    for (const [from, to] of Object.entries(map)) if (args[from] !== undefined) this.state[to] = typeof DEFAULT_STATE[to] === 'boolean' ? !!args[from] : String(args[from]);
    if (args.replace !== undefined) this.state.replaceVisible = true;
    if (args.showIncludesExcludes || args.filesToInclude || args.filesToExclude) this.state.detailsVisible = true;
    this.persist();
    this.applyState();
  }

  focusSearch({ select = true } = {}) {
    this.searchInput.focus({ preventScroll: true });
    if (select) this.searchInput.select();
  }
  focusReplace() { this.replaceInput.focus({ preventScroll: true }); this.replaceInput.select(); }

  // ---------------- searching ----------------
  query() {
    const s = this.state;
    return { query: s.query, replace: s.replace, isRegex: s.isRegex, caseSensitive: s.caseSensitive, wholeWord: s.wholeWord, preserveCase: s.preserveCase, include: s.include, exclude: s.exclude, useExcludeSettings: s.useExcludeSettings, onlyOpenEditors: s.onlyOpenEditors };
  }

  replaceActive() { return this.state.replaceVisible; }

  search({ keepView = false, addHistory = false } = {}) {
    this.searchSoon?.cancel?.();
    const q = this.query();
    if (this.validate()) { this.result = { files: [], total: 0, limitHit: false, error: this.validate(), q }; this.render(); return this.result; }
    if (!q.query) { this.clearResults(); return null; }
    this.progress.classList.add('active');
    let res;
    try {
      res = runSearch(q, undefined, this.dirtyBuffers());
      if (q.onlyOpenEditors) {
        const open = new Set(editors.list().map(e => e.input?.path).filter(Boolean));
        res.files = res.files.filter(f => open.has(f.path));
        res.total = res.files.reduce((n, f) => n + f.matches.length, 0);
      }
    } finally { this.progress.classList.remove('active'); }
    if (!keepView) { this.collapsed.clear(); this.selectedKey = null; }
    this.result = { ...res, q };
    if (addHistory || res.total) this.addHistory(q.query);
    this.render();
    return this.result;
  }

  /** Unsaved editor contents (searched instead of the saved files, like VS Code). */
  dirtyBuffers() {
    const out = new Map();
    for (const e of editors.list()) {
      if (e.dirty && e.input?.type === 'file' && typeof e.instance?.getText === 'function') {
        try { out.set(e.input.path, e.instance.getText()); } catch {}
      }
    }
    return out;
  }

  addHistory(query) {
    if (!query) return;
    const hist = this.state.history.filter(h => h !== query);
    hist.unshift(query);
    this.state.history = hist.slice(0, 30);
    this.persist();
  }

  clearResults() {
    this.result = null; this.collapsed.clear(); this.selectedKey = null;
    this.render();
  }

  clear() {
    this.state.query = ''; this.state.replace = '';
    this.searchInput.value = ''; this.replaceInput.value = '';
    this.persist(); this.validate();
    this.clearResults();
    if (!layout.isPhone) this.focusSearch();
  }

  // ---------------- rows ----------------
  rows() {
    const res = this.result;
    if (!res?.files?.length) return [];
    const rows = [];
    if (this.state.viewMode === 'tree') {
      const root = { children: new Map(), files: [], path: '' };
      for (const f of res.files) {
        let node = root;
        for (const part of posix.dirname(f.path).split('/').filter(Boolean)) {
          const path = node.path ? `${node.path}/${part}` : part;
          if (!node.children.has(part)) node.children.set(part, { children: new Map(), files: [], path, name: part });
          node = node.children.get(part);
        }
        node.files.push(f);
      }
      const count = n => n.files.reduce((s, f) => s + f.matches.length, 0) + [...n.children.values()].reduce((s, c) => s + count(c), 0);
      const visit = (node, depth) => {
        const folders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
        for (const c of folders) {
          const key = `d:${c.path}`;
          rows.push({ kind: 'folder', key, path: c.path, name: c.name, depth, count: count(c) });
          if (!this.collapsed.has(key)) visit(c, depth + 1);
        }
        for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) this.pushFile(rows, f, depth);
      };
      visit(root, 1);
    } else {
      for (const f of res.files) this.pushFile(rows, f, 1);
    }
    return rows;
  }

  pushFile(rows, f, depth) {
    const key = `f:${f.path}`;
    rows.push({ kind: 'file', key, path: f.path, file: f, depth, count: f.matches.length });
    if (!this.collapsed.has(key)) for (const m of f.matches) rows.push({ kind: 'match', key: `m:${f.path}:${m.id}`, path: f.path, match: m, file: f, depth: depth + 1 });
  }

  rowSig(r) {
    const rep = this.replaceActive();
    const repText = rep ? this.state.replace : '';
    if (r.kind === 'match') return `m|${r.depth}|${r.match.preview}|${r.match.col}|${rep}|${repText}|${this.state.preserveCase}|${this.state.isRegex}|${layout.isPhone}`;
    if (r.kind === 'file') return `f|${r.depth}|${r.count}|${rep}|${this.state.viewMode}`;
    return `d|${r.depth}|${r.count}`;
  }

  indentPad(depth) { return 8 + (depth - 1) * (Number(settings.get('workbench.tree.indent', 8)) || 8); }

  actionBtn(icon, title, run) {
    const b = h('a', { class: `action-label codicon codicon-${icon}`, role: 'button', title, 'aria-label': title });
    b.addEventListener('click', e => { e.stopPropagation(); run(); });
    return b;
  }

  renderRow(r) {
    const el = h('div', { class: ['monaco-list-row', 'search-row', r.kind], role: 'treeitem', 'aria-level': String(r.depth), 'data-key': r.key });
    const twistie = h('div', { class: ['monaco-tl-twistie', r.kind !== 'match' && 'collapsible'], style: `padding-left:${this.indentPad(r.depth)}px` });
    const contents = h('div', { class: 'monaco-tl-contents' });
    el.append(twistie, contents);
    const rep = this.replaceActive();
    if (r.kind === 'folder') {
      contents.append(
        h('div', { class: 'monaco-icon-label folder' }, h('span', { class: 'label-name' }, r.name)),
        h('span', { class: 'monaco-count-badge' }, String(r.count)));
      el.title = r.path;
      el.setAttribute('aria-label', `Folder ${r.path}, ${plural(r.count, 'result')}`);
    } else if (r.kind === 'file') {
      const dir = posix.dirname(r.path);
      const actions = h('div', { class: 'monaco-action-bar search-row-actions' },
        rep ? this.actionBtn('replace-all', `Replace All (${keybindingLabel('Mod+Alt+Shift+1')})`, () => this.replaceFile(r.path)) : null,
        this.actionBtn('close', 'Dismiss', () => this.dismissFile(r.path)));
      contents.append(
        h('div', { class: 'monaco-icon-label filematch-label' },
          h('span', { class: 'explorer-file-icon', html: fileIconHtml(r.path) }),
          h('span', { class: 'label-name' }, posix.basename(r.path)),
          this.state.viewMode !== 'tree' && dir ? h('span', { class: 'label-description' }, dir) : null),
        actions,
        h('span', { class: 'monaco-count-badge', title: plural(r.count, 'match', 'matches') }, String(r.count)));
      el.title = r.path;
      el.setAttribute('aria-label', `${plural(r.count, 'match', 'matches')} in file ${posix.basename(r.path)} of folder ${dir || workspace.name}`);
    } else {
      const m = r.match;
      const c0 = m.col - 1;
      const pre = m.preview;
      // VS Code keeps ~26 characters before the match; the phone side bar is narrower, so keep fewer.
      const before = lcut(pre.slice(0, c0), layout.isPhone ? 12 : 26);
      const inside = pre.substr(c0, m.length);
      const after = pre.slice(c0 + m.length, c0 + m.length + 250);
      const replacement = rep && this.state.replace ? replacementAt(pre, c0, this.query()) : null;
      const text = h('div', { class: ['search-match', replacement && 'changedOrRemoved'] },
        h('span', { class: 'before' }, before),
        h('span', { class: ['findInFileMatch', replacement && 'replace-strike'] }, inside),
        replacement ? h('span', { class: 'replaceMatch' }, replacement.text) : null,
        h('span', { class: 'after' }, after));
      const actions = h('div', { class: 'monaco-action-bar search-row-actions' },
        rep ? this.actionBtn('replace', `Replace (${keybindingLabel('Mod+Shift+1')})`, () => this.replaceMatch(r.path, m)) : null,
        this.actionBtn('close', 'Dismiss', () => this.dismissMatch(r.path, m)));
      contents.append(text, actions);
      el.title = `${pre.trim().slice(0, 200)}\nLine ${m.line}, Column ${m.col}`;
      el.setAttribute('aria-label', `'${inside}' at column ${m.col} found ${pre.trim().slice(0, 80)}`);
    }
    return el;
  }

  updateRow(el, r) {
    const selected = r.key === this.selectedKey;
    el.classList.toggle('selected', selected);
    el.classList.toggle('focused', selected);
    el.setAttribute('aria-selected', String(selected));
    if (r.kind !== 'match') {
      const expanded = !this.collapsed.has(r.key);
      el.firstChild.classList.toggle('expanded', expanded);
      el.setAttribute('aria-expanded', String(expanded));
    }
  }

  render() {
    const res = this.result;
    this.list.setRows(this.rows());
    this.renderMessage();
    this.replaceAllBtn.classList.toggle('disabled', !res?.total);
    this.el.classList.toggle('has-results', !!res?.total);
    try { views.refreshActions(SEARCH_VIEW); } catch {}
  }

  renderMessage() {
    const res = this.result;
    const msg = this.messages;
    msg.replaceChildren();
    if (!res || !res.q?.query || res.error) return;
    const inc = res.q.include?.trim(), exc = res.q.exclude?.trim();
    if (!res.total) {
      const text = inc && exc ? `No results found in '${inc}' excluding '${exc}' - `
        : inc ? `No results found in '${inc}' - `
        : exc ? `No results found excluding '${exc}' - `
        : 'No results found. Review your settings for configured exclusions - ';
      const link = h('a', { class: 'message-link', role: 'button', tabindex: '0' }, 'Open Settings');
      link.addEventListener('click', () => commands.execute('workbench.action.openSettings', 'search.exclude').catch(() => {}));
      msg.append(h('p', { class: 'message' }, text, link));
      return;
    }
    const files = res.files.length;
    msg.append(h('p', { class: 'message' }, `${plural(res.total, 'result')} in ${plural(files, 'file')}`));
    if (res.limitHit) msg.append(h('p', { class: 'message warning' }, 'The result set only contains a subset of all matches. Be more specific in your search to narrow down the results.'));
  }

  // ---------------- results interaction ----------------
  bindResults() {
    const s = this.list.scroller;
    s.addEventListener('click', e => {
      const el = e.target.closest('.search-row');
      if (!el || e.target.closest('.search-row-actions')) return;
      const r = this.list.rows[Number(el.dataset.index)];
      if (!r) return;
      this.selectedKey = r.key; this.list.update();
      if (r.kind === 'match') this.openMatch(r, { pinned: e.detail > 1 });
      else this.toggleCollapsed(r.key);
    });
    s.addEventListener('dblclick', e => {
      const el = e.target.closest('.search-row.match');
      const r = el && this.list.rows[Number(el.dataset.index)];
      if (r?.kind === 'match') this.openMatch(r, { pinned: true, focus: true });
    });
    s.addEventListener('keydown', e => {
      const r = this.list.rows.find(x => x.key === this.selectedKey);
      if (e.key === 'ArrowDown') { e.preventDefault(); this.moveSelection(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (this.list.rows.indexOf(r) <= 0) this.focusSearch(); else this.moveSelection(-1); }
      else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (r?.kind === 'match') this.openMatch(r, { pinned: e.key === 'Enter', focus: e.key === 'Enter' });
        else if (r) this.toggleCollapsed(r.key);
      } else if (e.key === 'ArrowRight' && r && r.kind !== 'match') { e.preventDefault(); if (this.collapsed.has(r.key)) this.toggleCollapsed(r.key); }
      else if (e.key === 'ArrowLeft' && r && r.kind !== 'match') { e.preventDefault(); if (!this.collapsed.has(r.key)) this.toggleCollapsed(r.key); }
      else if ((e.key === 'Delete' || (e.key === 'Backspace' && (isApple ? e.metaKey : e.ctrlKey))) && r) {
        e.preventDefault(); if (r.kind === 'match') this.dismissMatch(r.path, r.match); else if (r.kind === 'file') this.dismissFile(r.path);
      } else if (e.key === '1' && (isApple ? e.metaKey : e.ctrlKey) && e.shiftKey && r && this.replaceActive()) {
        e.preventDefault(); if (r.kind === 'match') this.replaceMatch(r.path, r.match); else if (r.kind === 'file') this.replaceFile(r.path);
      } else return;
      e.stopPropagation();
    });
    this.store.add(onContextMenu(s, (x, y, e) => {
      const el = e?.target?.closest?.('.search-row');
      const r = el && this.list.rows[Number(el.dataset.index)];
      if (!r) return;
      this.selectedKey = r.key; this.list.update();
      showContextMenu(this.rowMenu(r), { x, y });
    }));
  }

  moveSelection(dir) {
    const rows = this.list.rows;
    if (!rows.length) return;
    let i = rows.findIndex(r => r.key === this.selectedKey);
    i = Math.max(0, Math.min(rows.length - 1, i + dir));
    this.selectedKey = rows[i].key;
    this.list.update();
    this.list.reveal(i);
  }

  toggleCollapsed(key) {
    if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key);
    this.list.setRows(this.rows());
    try { views.refreshActions(SEARCH_VIEW); } catch {}
  }

  allCollapsed() {
    const res = this.result;
    if (!res?.files?.length) return false;
    return res.files.every(f => this.collapsed.has(`f:${f.path}`));
  }
  collapseAll() {
    for (const r of this.rows()) if (r.kind !== 'match') this.collapsed.add(r.key);
    if (this.result) for (const f of this.result.files) this.collapsed.add(`f:${f.path}`);
    this.render();
  }
  expandAll() { this.collapsed.clear(); this.render(); }
  toggleCollapseAll() { if (this.allCollapsed()) this.expandAll(); else this.collapseAll(); }
  setViewMode(mode) { this.state.viewMode = mode; this.persist(); this.render(); }

  async openMatch(r, { pinned = false, focus } = {}) {
    const m = r.match;
    if (this.replaceActive() && this.state.replace) { await this.openReplacePreview(r.path, pinned); return; }
    try {
      await editors.open({ type: 'file', path: r.path }, {
        pinned, focus: focus ?? layout.isPhone,
        reveal: { line: m.line, col: m.col, endLine: m.line, endCol: m.col + m.length, select: true }
      });
    } catch (err) { notify.error(`Could not open '${posix.basename(r.path)}': ${err.message}`, { source: 'Search' }); }
  }

  async openReplacePreview(path) {
    const file = this.result?.files.find(f => f.path === path);
    if (!file) return;
    const name = posix.basename(path);
    try {
      const original = this.dirtyBuffers().get(path) ?? await workspace.fs.readText(path);
      const { text: modified } = applyReplacements(original, file.matches, this.query());
      await codeEditor.openDiff({
        id: `search-replace:${path}`, title: `${name} ↔ ${name} (Replace Preview)`, path, original, modified, readOnly: true,
        actions: [{ label: 'Replace All in File', icon: 'replace-all', run: () => this.replaceFile(path) }]
      });
    } catch (err) {
      const m = file.matches[0];
      editors.open({ type: 'file', path }, { reveal: m ? { line: m.line, col: m.col, endLine: m.line, endCol: m.col + m.length, select: true } : undefined }).catch(() => {});
      if (!/No editor/.test(err.message)) notify.error(`Could not open the replace preview: ${err.message}`, { source: 'Search' });
    }
  }

  rowMenu(r) {
    const rep = this.replaceActive();
    const items = [];
    if (r.kind === 'match') {
      items.push({ label: 'Open File', run: () => this.openMatch(r, { pinned: true, focus: true }) });
      if (rep) items.push({ label: 'Replace', keybinding: keybindingLabel('Mod+Shift+1'), run: () => this.replaceMatch(r.path, r.match) });
      items.push({ separator: true },
        { label: 'Copy', keybinding: keybindingLabel('Mod+C'), run: () => copyText(`  ${r.match.line},${r.match.col}: ${r.match.preview.trim()}`) },
        { label: 'Copy Path', keybinding: keybindingLabel('Mod+Alt+C'), run: () => commands.execute('copyFilePath', { path: r.path }) },
        { label: 'Copy All', run: () => copyText(this.resultsText()) },
        { separator: true },
        { label: 'Dismiss', keybinding: keybindingLabel(isApple ? 'Mod+Backspace' : 'Delete'), run: () => this.dismissMatch(r.path, r.match) });
    } else if (r.kind === 'file') {
      items.push({ label: 'Open File', run: () => editors.open({ type: 'file', path: r.path }, { pinned: true }).catch(() => {}) });
      if (rep) items.push({ label: 'Replace All', keybinding: keybindingLabel('Mod+Alt+Shift+1'), run: () => this.replaceFile(r.path) });
      items.push({ separator: true },
        { label: 'Copy Path', keybinding: keybindingLabel('Mod+Alt+C'), run: () => commands.execute('copyFilePath', { path: r.path }) },
        { label: 'Copy All', run: () => copyText(this.resultsText()) },
        { label: 'Reveal in Explorer View', run: () => commands.execute('workbench.files.action.showActiveFileInExplorer', { path: r.path }) },
        { separator: true },
        { label: 'Dismiss', run: () => this.dismissFile(r.path) });
    } else {
      items.push({ label: 'Copy Path', run: () => commands.execute('copyFilePath', { path: r.path }) },
        { label: 'Copy All', run: () => copyText(this.resultsText()) },
        { label: 'Reveal in Explorer View', run: () => commands.execute('workbench.files.action.showActiveFileInExplorer', { path: r.path }) });
    }
    return items;
  }

  resultsText() {
    return (this.result?.files || []).map(f => [f.path, ...f.matches.map(m => `  ${m.line},${m.col}: ${m.preview.trim()}`)].join('\n')).join('\n\n');
  }

  // ---------------- dismiss / replace ----------------
  dismissMatch(path, m) {
    const f = this.result?.files.find(x => x.path === path);
    if (!f) return;
    f.matches = f.matches.filter(x => x !== m);
    if (!f.matches.length) this.result.files = this.result.files.filter(x => x !== f);
    this.result.total = this.result.files.reduce((n, x) => n + x.matches.length, 0);
    this.render();
  }

  dismissFile(path) {
    if (!this.result) return;
    this.result.files = this.result.files.filter(x => x.path !== path);
    this.result.total = this.result.files.reduce((n, x) => n + x.matches.length, 0);
    this.render();
  }

  /** Writes replacements for `matches` of one file (into a dirty editor's buffer when one is open). */
  async writeReplacements(path, matches, q) {
    const fs = workspace.fs;
    const dirty = editors.findByPath(path).find(e => e.input?.type === 'file' && e.dirty);
    const view = dirty?.instance?.view;
    if (dirty && view?.state?.doc && typeof view.dispatch === 'function') {
      // The editor has unsaved changes (its buffer was searched): replace in the buffer, like VS Code,
      // so nothing is lost. Each match is re-verified at its position before it is replaced.
      const text = view.state.doc.toString();
      const { text: next, replaced, skipped } = applyReplacements(text, matches, q);
      if (replaced) {
        let from = 0; while (from < text.length && text[from] === next[from]) from++;
        let endA = text.length, endB = next.length;
        while (endA > from && endB > from && text[endA - 1] === next[endB - 1]) { endA--; endB--; }
        view.dispatch({ changes: { from, to: endA, insert: next.slice(from, endB) }, userEvent: 'input.replace' });
      }
      return { replaced, skipped };
    }
    if (!fs.isFile(path) || fs.isBinary(path)) return { replaced: 0, skipped: matches.length };
    const text = await fs.readText(path);
    const { text: next, replaced, skipped } = applyReplacements(text, matches, q);
    if (replaced && next !== text) await fs.writeText(path, next, { source: 'search' });
    return { replaced, skipped };
  }

  async replaceMatch(path, m) {
    const q = this.query();
    try { await this.writeReplacements(path, [m], q); }
    catch (err) { notify.error(`Could not replace in '${posix.basename(path)}': ${err.message}`, { source: 'Search' }); }
    this.search({ keepView: true });
  }

  async replaceFile(path) {
    const f = this.result?.files.find(x => x.path === path);
    if (!f) return;
    const q = this.query();
    try { await this.writeReplacements(path, f.matches, q); }
    catch (err) { notify.error(`Could not replace in '${posix.basename(path)}': ${err.message}`, { source: 'Search' }); }
    this.search({ keepView: true });
  }

  async replaceAll({ confirm = true } = {}) {
    const res = this.result;
    if (!res?.total) return { replaced: 0, files: 0 };
    const q = this.query();
    const n = res.total, files = res.files.length;
    const withText = q.replace ? ` with '${q.replace}'` : '';
    if (confirm) {
      const ok = await dialogs.confirm({ message: `Replace ${plural(n, 'occurrence')} across ${plural(files, 'file')}${withText}?`, primary: 'Replace', type: 'warning' });
      if (!ok) return { replaced: 0, files: 0 };
    }
    let replaced = 0, changedFiles = 0, skipped = 0;
    this.progress.classList.add('active');
    try {
      for (const f of [...res.files]) {
        try {
          const r = await this.writeReplacements(f.path, f.matches, q);
          replaced += r.replaced; skipped += r.skipped;
          if (r.replaced) changedFiles++;
        } catch (err) { skipped += f.matches.length; notify.error(`Could not replace in '${posix.basename(f.path)}': ${err.message}`, { source: 'Search' }); }
      }
    } finally { this.progress.classList.remove('active'); }
    notify.info(`Replaced ${plural(replaced, 'occurrence')} across ${plural(changedFiles, 'file')}${withText}.${skipped ? ` ${plural(skipped, 'match', 'matches')} changed since the search and ${skipped === 1 ? 'was' : 'were'} skipped.` : ''}`, { source: 'Search' });
    this.search({ keepView: true });
    return { replaced, files: changedFiles, skipped };
  }

  // ---------------- view lifecycle ----------------
  actions() {
    const tree = this.state.viewMode === 'tree';
    const collapsed = this.allCollapsed();
    return [
      { icon: 'refresh', title: 'Refresh', command: 'search.action.refreshSearchResults', run: () => this.search({ keepView: true }) },
      { icon: 'clear-all', title: 'Clear Search Results', command: 'search.action.clearSearchResults', run: () => this.clear() },
      { icon: tree ? 'list-flat' : 'list-tree', title: tree ? 'View as List' : 'View as Tree', run: () => this.setViewMode(tree ? 'list' : 'tree') },
      { icon: collapsed ? 'expand-all' : 'collapse-all', title: collapsed ? 'Expand All' : 'Collapse All', command: 'search.action.collapseSearchResults', run: () => this.toggleCollapseAll() }
    ];
  }

  onShow() { this.list.measure(); this.list.render(); }
  focus() { if (!layout.isPhone || !isTouch()) this.focusSearch(); }
  dispose() { this.store.dispose(); this.list.dispose(); this.el.remove(); }
}

