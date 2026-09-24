// DEBUG CONSOLE panel tab (VS Code's REPL): console output of the running preview (bus 'preview:console'),
// repeated messages grouped with a count badge, a filter ('text, !exclude'), Clear Console, and the
// evaluation input at the bottom (Enter evaluates through preview.evaluate(), ↑/↓ history).

import { h, codicon, clear, copyText, onContextMenu } from '../core/dom.js';
import { bus } from '../core/events.js';
import { layout } from '../workbench/layout.js';
import { panel } from '../workbench/panel.js';
import { showContextMenu } from '../platform/contextmenu.js';
import { undoSmartPunctuation } from './terminal.js';

const MAX_ENTRIES = 2000;
const HISTORY_STORE = 'xcoder.debugConsole.history';
export const FILTER_PLACEHOLDER = 'Filter (e.g. text, !exclude)';

/** entries: { kind: 'log' | 'input' | 'result', level: 'log'|'info'|'warning'|'error'|'debug', text, source, time, count } */
const model = { entries: [], filter: '', history: [] };
try { model.history = JSON.parse(localStorage.getItem(HISTORY_STORE) || '[]').filter(s => typeof s === 'string').slice(-100); } catch {}

export function normalizeLevel(level) {
  const l = String(level || 'log').toLowerCase();
  if (l === 'warn' || l === 'warning') return 'warning';
  if (l === 'error' || l === 'exception' || l === 'assert') return 'error';
  if (l === 'info') return 'info';
  if (l === 'debug' || l === 'trace') return 'debug';
  return 'log';
}

function textOf(e) { return typeof e?.text === 'string' ? e.text : e?.text == null ? '' : String(e.text); }

function addEntry(entry) {
  const last = model.entries[model.entries.length - 1];
  if (last && entry.kind === 'log' && last.kind === 'log' && last.level === entry.level && last.text === entry.text && last.source === entry.source) {
    last.count++;
    last.time = entry.time;
    view?.updateLast(last);
    return;
  }
  model.entries.push({ count: 1, ...entry });
  if (model.entries.length > MAX_ENTRIES) { model.entries.splice(0, model.entries.length - MAX_ENTRIES); view?.render(); return; }
  view?.appendEntry(model.entries[model.entries.length - 1]);
}

export function clearConsole() { model.entries = []; view?.render(); }

function parseFilter(text) {
  const inc = [], exc = [];
  for (let p of String(text || '').split(',')) {
    p = p.trim().toLowerCase();
    if (!p) continue;
    if (p.startsWith('!')) { if (p.length > 1) exc.push(p.slice(1)); } else inc.push(p);
  }
  return { inc, exc };
}
function visible(entry, f) {
  const hay = `${entry.text} ${entry.source || ''}`.toLowerCase();
  if (f.inc.length && !f.inc.some(w => hay.includes(w))) return false;
  if (f.exc.some(w => hay.includes(w))) return false;
  return true;
}

const LEVEL_ICON = { error: 'error', warning: 'warning', info: 'info' };

let view = null;

class DebugConsoleView {
  constructor(host) {
    host.classList.add('repl');
    this.filterRow = h('div', { class: 'panel-filter-row hidden' });
    this.tree = h('div', { class: 'repl-tree monaco-list', tabindex: '0', role: 'log', 'aria-label': 'Debug Console' });
    this.buildFilter();
    this.buildInput();
    host.append(this.filterRow, this.tree, this.inputWrapper);
    this.atBottom = true;
    this.tree.addEventListener('scroll', () => { this.atBottom = this.tree.scrollHeight - this.tree.scrollTop - this.tree.clientHeight < 12; }, { passive: true });
    this.render();
  }

  buildFilter() {
    this.filterInput = h('input', {
      type: 'text', class: 'repl-filter-input', placeholder: FILTER_PLACEHOLDER, 'aria-label': FILTER_PLACEHOLDER,
      autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off', enterkeyhint: 'search'
    });
    this.filterInput.value = model.filter;
    this.filterInput.addEventListener('input', () => { model.filter = this.filterInput.value; this.render(); });
    this.filterInput.addEventListener('keydown', e => { if (e.key === 'Escape' && this.filterInput.value) { e.stopPropagation(); this.filterInput.value = ''; model.filter = ''; this.render(); } });
    this.filterCount = h('span', { class: 'filter-count monaco-count-badge hidden' });
    this.filterBox = h('div', { class: 'monaco-inputbox repl-filter' }, this.filterInput, h('div', { class: 'controls' }, this.filterCount));
  }

  /** Phones: the filter row is toggled from the title's filter icon; desktop: the filter lives in the title. */
  placeFilter() {
    if (layout.isPhone) {
      if (this.filterBox.parentNode !== this.filterRow) this.filterRow.append(this.filterBox);
      this.filterRow.classList.toggle('hidden', !this.filterOpen && !model.filter);
    } else this.filterRow.classList.add('hidden');
  }

  toggleFilterRow() {
    this.filterOpen = !(this.filterOpen || model.filter);
    if (!this.filterOpen && model.filter) { model.filter = ''; this.filterInput.value = ''; this.render(); }
    this.placeFilter();
    if (this.filterOpen) this.filterInput.focus();
  }

  buildInput() {
    this.input = h('textarea', {
      class: 'repl-input', rows: '1', 'aria-label': 'Debug Console input', placeholder: 'Evaluate in the preview',
      autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'send'
    });
    this.historyIndex = -1;
    this.draft = '';
    this.input.addEventListener('keydown', e => this.onKey(e));
    this.input.addEventListener('input', e => { if (e.inputType !== 'insertFromPaste') undoSmartPunctuation(this.input); this.autosize(); });
    this.inputWrapper = h('div', { class: 'repl-input-wrapper' }, codicon('chevron-right', 'repl-input-icon'), this.input);
    this.inputWrapper.addEventListener('click', e => { if (e.target !== this.input) this.input.focus(); });
  }

  autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(120, this.input.scrollHeight)}px`;
  }

  onKey(e) {
    if (e.isComposing) return;
    const v = this.input.value;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.evaluate(); return; }
    const onFirstLine = !v.slice(0, this.input.selectionStart).includes('\n');
    const onLastLine = !v.slice(this.input.selectionEnd).includes('\n');
    if (e.key === 'ArrowUp' && onFirstLine && model.history.length) {
      e.preventDefault();
      if (this.historyIndex === -1) { this.draft = v; this.historyIndex = model.history.length - 1; }
      else this.historyIndex = Math.max(0, this.historyIndex - 1);
      this.setValue(model.history[this.historyIndex]);
    } else if (e.key === 'ArrowDown' && onLastLine && this.historyIndex !== -1) {
      e.preventDefault();
      this.historyIndex++;
      if (this.historyIndex >= model.history.length) { this.historyIndex = -1; this.setValue(this.draft); }
      else this.setValue(model.history[this.historyIndex]);
    } else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); clearConsole(); }
  }

  setValue(v) { this.input.value = v; this.input.setSelectionRange(v.length, v.length); this.autosize(); }

  async evaluate() {
    const expr = this.input.value;
    if (!expr.trim()) return;
    this.setValue('');
    this.historyIndex = -1;
    if (model.history[model.history.length - 1] !== expr) model.history.push(expr);
    if (model.history.length > 100) model.history.splice(0, model.history.length - 100);
    try { localStorage.setItem(HISTORY_STORE, JSON.stringify(model.history)); } catch {}
    this.atBottom = true;
    addEntry({ kind: 'input', level: 'log', text: expr, time: Date.now() });
    let result;
    try {
      const { preview } = await import('../preview/api.js');
      result = await preview.evaluate(expr);
    } catch (err) {
      result = { ok: false, text: err?.message || String(err) };
    }
    const text = typeof result === 'string' ? result : textOf(result);
    addEntry({ kind: 'result', level: result?.ok === false ? 'error' : 'log', text: text || (result?.ok === false ? 'Evaluation failed' : 'undefined'), time: Date.now() });
  }

  renderEntry(e) {
    const cls = ['repl-row', `kind-${e.kind}`, `level-${e.level}`];
    const icon = e.kind === 'input' ? codicon('chevron-right', 'repl-icon input-icon')
      : e.kind === 'result' ? codicon(e.level === 'error' ? 'error' : 'chevron-left', `repl-icon result-icon ${e.level}`)
        : LEVEL_ICON[e.level] ? codicon(LEVEL_ICON[e.level], `repl-icon ${e.level}`) : null;
    const badge = h('span', { class: ['monaco-count-badge', 'repl-count', e.count > 1 ? null : 'hidden'] }, String(e.count));
    const src = e.source ? h('span', { class: 'repl-source', title: e.source }, e.source) : null;
    const row = h('div', { class: cls, role: 'listitem', 'data-kind': e.kind, 'data-level': e.level },
      badge, icon, h('span', { class: 'repl-value' }, e.text), src);
    onContextMenu(row, (x, y) => showContextMenu([
      { label: 'Copy', icon: 'copy', run: () => copyText(e.text) },
      { label: 'Copy All', run: () => copyText(model.entries.map(x => (x.kind === 'input' ? `> ${x.text}` : x.text)).join('\n')) },
      { separator: true },
      { label: 'Clear Console', icon: 'clear-all', run: clearConsole }
    ], { x, y }));
    e.el = row;
    e.badge = badge;
    return row;
  }

  render() {
    clear(this.tree);
    const f = parseFilter(model.filter);
    const frag = document.createDocumentFragment();
    let shown = 0;
    for (const e of model.entries) { if (visible(e, f)) { frag.append(this.renderEntry(e)); shown++; } else e.el = null; }
    this.tree.append(frag);
    const filtering = !!(f.inc.length || f.exc.length);
    this.filterCount.classList.toggle('hidden', !filtering);
    this.filterCount.textContent = `Showing ${shown} of ${model.entries.length}`;
    this.scroll(true);
  }

  appendEntry(e) {
    const f = parseFilter(model.filter);
    if (!visible(e, f)) return;
    this.tree.append(this.renderEntry(e));
    this.scroll();
  }

  updateLast(e) {
    if (!e.badge) return;
    e.badge.textContent = String(e.count);
    e.badge.classList.remove('hidden');
    this.scroll();
  }

  scroll(force = false) {
    if (!force && !this.atBottom) return;
    requestAnimationFrame(() => { this.tree.scrollTop = this.tree.scrollHeight; this.atBottom = true; });
  }
}

export const debugConsoleTab = {
  id: 'debug',
  title: 'Debug Console',
  order: 3,
  keybinding: 'Mod+Shift+Y',
  render(host) {
    view = new DebugConsoleView(host);
    view.placeFilter();
    return {
      onShow: () => view?.placeFilter(),
      focus: () => view?.input.focus({ preventScroll: true }),
      dispose: () => { view = null; }
    };
  },
  actions() {
    const list = [];
    if (view && !layout.isPhone) list.push({ element: view.filterBox });
    else list.push({ icon: 'filter', title: 'Filter', checked: !!(view?.filterOpen || model.filter), run: () => { view?.toggleFilterRow(); panel.refreshActions(); } });
    list.push({ icon: 'clear-all', title: 'Clear Console', run: clearConsole });
    return list;
  }
};

/** Appends a console entry (from the preview). */
export function logToConsole({ level, text, source, time } = {}) {
  addEntry({ kind: 'log', level: normalizeLevel(level), text: textOf({ text }), source: source ? String(source) : '', time: time || Date.now() });
}

bus.on('preview:console', e => { try { logToConsole(e || {}); } catch (err) { console.error(err); } });
bus.on('layout:changed', () => view?.placeFilter());
