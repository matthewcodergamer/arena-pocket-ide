// VS Code Find / Replace widget for CodeMirror (used as the search panel: search({ top: true, createPanel })).
// Floating at the top-right like Monaco's find widget (full width on phones): toggle-replace chevron,
// find input with Match Case / Match Whole Word / Use Regular Expression, "1 of 5" / "No results",
// previous / next / find in selection / close, and the replace row with Preserve Case, Replace, Replace All.

import { search as SR, state as S, view as V } from './cm.js';
import { h, isApple } from '../core/dom.js';
import { keybindingLabel } from '../core/commands.js';

const { SearchQuery, setSearchQuery, getSearchQuery, closeSearchPanel, openSearchPanel, searchPanelOpen, selectMatches } = SR;
const { StateEffect, StateField, EditorSelection } = S;
const { EditorView, Decoration, getPanel, runScopeHandlers } = V;

const MATCHES_LIMIT = 19999;
const panels = new WeakMap(); // view → FindWidget

// ---------------- find scope ("Find in Selection") ----------------
const setFindScope = StateEffect.define();
const scopeMark = Decoration.mark({ class: 'cm-xc-findScope' });
const outsideMark = Decoration.mark({ class: 'cm-xc-outsideScope' });
export const findScopeField = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFindScope)) value = e.value;
    if (value && tr.docChanged) value = { from: tr.changes.mapPos(value.from, -1), to: tr.changes.mapPos(value.to, 1) };
    return value;
  },
  provide: f => EditorView.decorations.from(f, scope => {
    if (!scope || scope.from >= scope.to) return Decoration.none;
    return Decoration.set([scopeMark.range(scope.from, scope.to)]);
  })
});
const outsideScope = EditorView.decorations.compute([findScopeField, 'doc'], state => {
  const scope = state.field(findScopeField, false);
  if (!scope || scope.from >= scope.to) return Decoration.none;
  const ranges = [];
  if (scope.from > 0) ranges.push(outsideMark.range(0, scope.from));
  if (scope.to < state.doc.length) ranges.push(outsideMark.range(scope.to, state.doc.length));
  return Decoration.set(ranges);
});

/** Extensions to add next to search(): the find scope field + its decorations. */
export const findExtensions = [findScopeField, outsideScope];

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function expandReplacement(replace, match, regexp) {
  if (!regexp || !match) return replace;
  return replace.replace(/\$(\$|&|\d{1,2})|\\(n|t|r|\\)/g, (all, dollar, esc) => {
    if (esc) return esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : '\\';
    if (dollar === '$') return '$';
    if (dollar === '&' || dollar === '0') return match[0];
    const idx = Number(dollar);
    return idx < match.length ? (match[idx] ?? '') : all;
  });
}
function preserveCase(original, replacement) {
  if (!replacement || !/[a-z]/i.test(original)) return replacement;
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original === original.toLowerCase()) return replacement;
  if (original[0] === original[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

const kb = spec => keybindingLabel(spec);
const toggleKey = letter => (isApple ? `Mod+Alt+${letter}` : `Alt+${letter}`);

class FindWidget {
  constructor(view) {
    this.view = view;
    this.top = true;
    const q = getSearchQuery(view.state);
    this.caseSensitive = q.caseSensitive;
    this.regexp = q.regexp;
    this.wholeWord = q.wholeWord;
    this.preserve = false;
    this.replaceVisible = false;
    this.searchStart = view.state.selection.main.from;
    this.countTimer = 0;
    this.build(q);
    panels.set(view, this);
  }

  build(q) {
    const prevent = e => { e.preventDefault(); };
    const button = (icon, title, run, extra = {}) => {
      const b = h('div', { class: ['button', 'codicon', `codicon-${icon}`, extra.class], role: extra.role || 'button', title, 'aria-label': title, tabindex: '0' });
      b.addEventListener('pointerdown', prevent);
      b.addEventListener('click', e => { e.preventDefault(); if (!b.classList.contains('disabled')) run(); });
      b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(); } });
      return b;
    };
    const toggle = (icon, title, get, set) => {
      const t = h('div', { class: ['monaco-custom-toggle', 'codicon', `codicon-${icon}`], role: 'checkbox', title, 'aria-label': title, 'aria-checked': 'false', tabindex: '0' });
      const sync = () => { t.classList.toggle('checked', !!get()); t.setAttribute('aria-checked', String(!!get())); };
      t.addEventListener('pointerdown', prevent);
      t.addEventListener('click', e => { e.preventDefault(); set(!get()); sync(); this.commit(true); });
      t.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); set(!get()); sync(); this.commit(true); } });
      t.sync = sync; sync();
      return t;
    };
    const inputAttrs = { class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search' };
    this.findInput = h('input', { ...inputAttrs, placeholder: 'Find', 'aria-label': 'Find', 'main-field': 'true', value: q.search });
    this.replaceInput = h('input', { ...inputAttrs, placeholder: 'Replace', 'aria-label': 'Replace', enterkeyhint: 'done', value: q.replace });
    this.caseToggle = toggle('case-sensitive', `Match Case (${kb(toggleKey('C'))})`, () => this.caseSensitive, v => { this.caseSensitive = v; });
    this.wordToggle = toggle('whole-word', `Match Whole Word (${kb(toggleKey('W'))})`, () => this.wholeWord, v => { this.wholeWord = v; });
    this.regexToggle = toggle('regex', `Use Regular Expression (${kb(toggleKey('R'))})`, () => this.regexp, v => { this.regexp = v; });
    this.preserveToggle = toggle('preserve-case', `Preserve Case (${kb(toggleKey('P'))})`, () => this.preserve, v => { this.preserve = v; });
    this.count = h('div', { class: 'matchesCount', 'aria-live': 'polite' }, 'No results');
    this.prevBtn = button('arrow-up', `Previous Match (${kb('Shift+Enter')})`, () => this.navigate(-1));
    this.nextBtn = button('arrow-down', `Next Match (${kb('Enter')})`, () => this.navigate(1));
    this.scopeBtn = button('selection', `Find in Selection (${kb(toggleKey('L'))})`, () => this.toggleScope(), { role: 'checkbox' });
    this.closeBtn = button('close', 'Close (Escape)', () => this.close());
    this.replaceBtn = button('replace', `Replace (${kb('Enter')})`, () => this.replaceOne());
    this.replaceAllBtn = button('replace-all', `Replace All (${kb(isApple ? 'Mod+Enter' : 'Ctrl+Alt+Enter')})`, () => this.replaceAll());
    this.toggleReplaceBtn = button('chevron-right', 'Toggle Replace', () => this.setReplaceVisible(!this.replaceVisible, true), { class: 'toggle left' });

    this.findBox = h('div', { class: 'monaco-inputbox idle' }, this.findInput, h('div', { class: 'controls' }, this.caseToggle, this.wordToggle, this.regexToggle));
    this.dom = h('div', { class: 'editor-widget find-widget', role: 'dialog', 'aria-label': 'Find / Replace' },
      this.toggleReplaceBtn,
      h('div', { class: 'find-part' },
        h('div', { class: 'monaco-findInput' }, this.findBox),
        h('div', { class: 'find-actions' }, this.count, this.prevBtn, this.nextBtn, this.scopeBtn, this.closeBtn)),
      h('div', { class: 'replace-part' },
        h('div', { class: 'monaco-findInput' }, h('div', { class: 'monaco-inputbox idle' }, this.replaceInput, h('div', { class: 'controls' }, this.preserveToggle))),
        h('div', { class: 'replace-actions' }, this.replaceBtn, this.replaceAllBtn)));
    this.dom.addEventListener('pointerdown', e => e.stopPropagation());

    this.findInput.addEventListener('input', () => this.commit(true));
    this.replaceInput.addEventListener('input', () => this.commit(false));
    this.findInput.addEventListener('keydown', e => this.onKey(e, 'find'));
    this.replaceInput.addEventListener('keydown', e => this.onKey(e, 'replace'));
    this.dom.addEventListener('keydown', e => { if (e.target === this.findInput || e.target === this.replaceInput) return; if (e.key === 'Escape') { e.preventDefault(); this.close(); } });
  }

  onKey(e, which) {
    if (e.isComposing) return;
    const mod = isApple ? e.metaKey : e.ctrlKey;
    const alt = e.altKey;
    const letter = e.code?.startsWith('Key') ? e.code.slice(3) : '';
    const optionToggle = isApple ? (mod && alt) : (alt && !e.ctrlKey && !e.metaKey);
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
    if (optionToggle && letter) {
      const map = { C: this.caseToggle, W: this.wordToggle, R: this.regexToggle, P: this.preserveToggle };
      if (map[letter]) { e.preventDefault(); map[letter].click(); return; }
      if (letter === 'L') { e.preventDefault(); this.toggleScope(); return; }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (which === 'find') {
        if (alt && !mod) { this.selectAll(); return; }
        this.navigate(e.shiftKey ? -1 : 1);
      } else if (mod || (e.ctrlKey && alt)) this.replaceAll();
      else this.replaceOne();
      return;
    }
    if (e.key === 'F3') { e.preventDefault(); this.navigate(e.shiftKey ? -1 : 1); return; }
    if (mod && letter === 'F' && !alt) { e.preventDefault(); this.findInput.focus(); this.findInput.select(); return; }
    if ((mod && letter === 'H' && !isApple) || (mod && alt && letter === 'F' && isApple)) { e.preventDefault(); this.setReplaceVisible(true, true); return; }
    if (runScopeHandlers(this.view, e, 'search-panel')) e.preventDefault();
  }

  get query() {
    return new SearchQuery({ search: this.findInput.value, caseSensitive: this.caseSensitive, regexp: this.regexp, wholeWord: this.wholeWord, replace: this.replaceInput.value, literal: !this.regexp });
  }

  /** Pushes the widget state into CodeMirror's search query. `seek` moves the selection to the nearest match (find-as-you-type). */
  commit(seek) {
    const q = this.query;
    const cur = getSearchQuery(this.view.state);
    if (!q.eq(cur)) this.view.dispatch({ effects: setSearchQuery.of(q) });
    this.findBox.classList.toggle('invalid', !!this.findInput.value && !q.valid);
    if (seek && q.valid && q.search) {
      const matches = this.matches();
      const scope = this.scope();
      const start = Math.max(this.searchStart, scope ? scope.from : 0);
      const m = matches.find(x => x.from >= start) || matches[0];
      if (m) this.select(m, false);
    }
    this.updateCount();
  }

  scope() { return this.view.state.field(findScopeField, false) || null; }

  matches(state = this.view.state) {
    const q = this.query;
    if (!q.valid || !q.search) return [];
    const scope = this.scope();
    const out = [];
    try {
      const cursor = q.getCursor(state, scope?.from ?? 0, scope?.to ?? state.doc.length);
      for (let r = cursor.next(); !r.done; r = cursor.next()) {
        out.push(r.value);
        if (out.length > MATCHES_LIMIT) break;
      }
    } catch (err) { console.warn('[X Coder] find failed', err); }
    return out;
  }

  select(m, focusEditor) {
    this.view.dispatch({
      selection: EditorSelection.single(m.from, m.to),
      effects: EditorView.scrollIntoView(m.from, { y: 'center' }),
      userEvent: 'select.search'
    });
    if (focusEditor) this.view.focus();
  }

  navigate(dir) {
    this.commit(false);
    const matches = this.matches();
    if (!matches.length) return;
    const sel = this.view.state.selection.main;
    let m;
    if (dir > 0) m = matches.find(x => x.from >= sel.to && !(x.from === sel.from && x.to === sel.to)) || matches[0];
    else m = [...matches].reverse().find(x => x.to <= sel.from && !(x.from === sel.from && x.to === sel.to)) || matches[matches.length - 1];
    this.searchStart = m.from;
    this.select(m, false);
    this.updateCount();
  }

  selectAll() {
    const matches = this.matches();
    if (!matches.length) return;
    this.view.dispatch({ selection: EditorSelection.create(matches.map(m => EditorSelection.range(m.from, m.to))), userEvent: 'select.search.matches' });
    this.view.focus();
  }

  replacementFor(m) {
    const text = this.view.state.sliceDoc(m.from, m.to);
    const r = expandReplacement(this.replaceInput.value, m.match, this.regexp);
    return this.preserve ? preserveCase(text, r) : r;
  }

  replaceOne() {
    if (this.view.state.readOnly) return;
    this.commit(false);
    const matches = this.matches();
    if (!matches.length) return;
    const sel = this.view.state.selection.main;
    const current = matches.find(m => m.from === sel.from && m.to === sel.to);
    if (!current) { this.navigate(1); return; }
    const insert = this.replacementFor(current);
    this.view.dispatch({ changes: { from: current.from, to: current.to, insert }, selection: EditorSelection.cursor(current.from + insert.length), userEvent: 'input.replace' });
    const next = this.matches().find(m => m.from >= current.from + insert.length) || this.matches()[0];
    if (next) this.select(next, false);
    this.updateCount();
  }

  replaceAll() {
    if (this.view.state.readOnly) return;
    this.commit(false);
    const matches = this.matches();
    if (!matches.length) return;
    const changes = matches.map(m => ({ from: m.from, to: m.to, insert: this.replacementFor(m) }));
    this.view.dispatch({ changes, userEvent: 'input.replace.all' });
    this.updateCount();
  }

  toggleScope(force) {
    const state = this.view.state;
    const current = this.scope();
    const on = force ?? !current;
    let value = null;
    if (on) {
      const sel = state.selection.main;
      if (sel.empty) { const line = state.doc.lineAt(sel.head); value = { from: line.from, to: line.to }; }
      else {
        let to = sel.to;
        const endLine = state.doc.lineAt(to);
        if (to === endLine.from && to > sel.from) to = Math.max(sel.from, to - 1);
        value = { from: sel.from, to };
      }
    }
    this.view.dispatch({ effects: setFindScope.of(value) });
    this.scopeBtn.classList.toggle('checked', !!value);
    this.scopeBtn.setAttribute('aria-checked', String(!!value));
    this.updateCount();
  }

  setReplaceVisible(visible, focus) {
    this.replaceVisible = !!visible;
    this.dom.classList.toggle('replaceToggled', this.replaceVisible);
    this.toggleReplaceBtn.classList.toggle('codicon-chevron-down', this.replaceVisible);
    this.toggleReplaceBtn.classList.toggle('codicon-chevron-right', !this.replaceVisible);
    this.toggleReplaceBtn.setAttribute('aria-expanded', String(this.replaceVisible));
    if (focus) (this.replaceVisible ? this.replaceInput : this.findInput).focus();
    this.syncSpace();
  }

  updateCount() {
    cancelAnimationFrame(this.countTimer);
    this.countTimer = requestAnimationFrame(() => {
      const matches = this.matches();
      const n = matches.length;
      const sel = this.view.state.selection.main;
      const idx = matches.findIndex(m => m.from === sel.from && m.to === sel.to);
      let label;
      if (!n) label = 'No results';
      else if (n > MATCHES_LIMIT) label = `${idx >= 0 ? idx + 1 : '?'} of ${MATCHES_LIMIT}+`;
      else label = `${idx >= 0 ? idx + 1 : '?'} of ${n}`;
      this.count.textContent = label;
      this.count.classList.toggle('no-results', !n && !!this.findInput.value);
      this.dom.classList.toggle('no-results', !n && !!this.findInput.value);
      for (const b of [this.prevBtn, this.nextBtn]) b.classList.toggle('disabled', !n);
      for (const b of [this.replaceBtn, this.replaceAllBtn]) b.classList.toggle('disabled', !n || this.view.state.readOnly);
    });
  }

  close() {
    closeSearchPanel(this.view);
    this.view.focus();
  }

  /** VS Code's "add extra space on top": the document can scroll below the widget so line 1 stays visible. */
  syncSpace() {
    if (!this.dom.isConnected) return;
    const height = Math.ceil(this.dom.getBoundingClientRect().height);
    if (height === this.space) return;
    this.space = height;
    // CodeMirror owns the editor element's class attribute, so the flag lives on its parent.
    const host = this.view.dom.parentElement;
    host?.style.setProperty('--xc-find-space', `${height}px`);
    host?.classList.add('xc-find-open');
    this.view.requestMeasure();
  }

  mount() {
    this.findInput.focus();
    this.findInput.select();
    this.setReplaceVisible(this.replaceVisible, false);
    this.updateCount();
    this.syncSpace();
    if (typeof ResizeObserver === 'function') { this.resizeObserver = new ResizeObserver(() => this.syncSpace()); this.resizeObserver.observe(this.dom); }
  }

  update(update) {
    for (const tr of update.transactions) for (const e of tr.effects) {
      if (e.is(setSearchQuery) && !e.value.eq(this.query)) {
        const q = e.value;
        this.findInput.value = q.search;
        this.replaceInput.value = q.replace;
        this.caseSensitive = q.caseSensitive; this.regexp = q.regexp; this.wholeWord = q.wholeWord;
        for (const t of [this.caseToggle, this.wordToggle, this.regexToggle]) t.sync();
      }
    }
    if (update.docChanged || update.selectionSet || update.transactions.some(tr => tr.effects.length)) this.updateCount();
    if (update.selectionSet && !update.transactions.some(tr => tr.isUserEvent('select.search'))) this.searchStart = update.state.selection.main.from;
  }

  destroy() {
    cancelAnimationFrame(this.countTimer);
    this.resizeObserver?.disconnect();
    this.view.dom.parentElement?.classList.remove('xc-find-open');
    this.view.dom.parentElement?.style.removeProperty('--xc-find-space');
    this.view.requestMeasure();
    if (this.scope()) queueMicrotask(() => { try { this.view.dispatch({ effects: setFindScope.of(null) }); } catch {} });
    panels.delete(this.view);
  }
}

export function createFindPanel(view) { return new FindWidget(view); }

/** Opens the find widget (seeding from the selection or the word at the cursor, like VS Code). */
export function openFind(view, { replace = false } = {}) {
  const { state } = view;
  const sel = state.selection.main;
  let seed = '';
  if (!sel.empty) { const text = state.sliceDoc(sel.from, sel.to); if (!text.includes('\n') && text.length < 500) seed = text; }
  else { const word = state.wordAt(sel.head); if (word) seed = state.sliceDoc(word.from, word.to); }
  const prev = getSearchQuery(state);
  if (seed) {
    const q = new SearchQuery({ search: prev.regexp ? escapeRegExp(seed) : seed, caseSensitive: prev.caseSensitive, regexp: prev.regexp, wholeWord: prev.wholeWord, replace: prev.replace, literal: !prev.regexp });
    view.dispatch({ effects: setSearchQuery.of(q) });
  }
  openSearchPanel(view);
  const panel = panels.get(view);
  if (panel) {
    if (seed && panel.findInput.value !== (prev.regexp ? escapeRegExp(seed) : seed)) panel.findInput.value = prev.regexp ? escapeRegExp(seed) : seed;
    if (replace) panel.setReplaceVisible(true, true);
    else { panel.findInput.focus(); panel.findInput.select(); }
    panel.updateCount();
  }
  return true;
}

export function findWidgetFor(view) { return panels.get(view) || null; }
export function isFindOpen(view) { return searchPanelOpen(view.state); }
export function findNextMatch(view, dir = 1) {
  let panel = panels.get(view);
  if (!panel) { openFind(view); panel = panels.get(view); }
  panel?.navigate(dir);
  return true;
}
export { selectMatches, getPanel };
