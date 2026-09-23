// The text editor: CodeMirror 6 configured and styled like VS Code's Monaco editor.
// One instance per open text file (editor input { type: 'file', path }).

import CM, { state as S, view as V, language as L, search as SR, autocomplete as AC, lint as LI, indentationMarkers } from './cm.js';
import { h } from '../core/dom.js';
import { bus } from '../core/events.js';
import { settings } from '../core/settings.js';
import { workspace } from '../core/workspace.js';
import { diagnostics } from '../core/diagnostics.js';
import { log } from '../core/output.js';
import { posix } from '../core/path.js';
import { notify } from '../platform/notifications.js';
import { showContextMenu } from '../platform/contextmenu.js';
import { menus } from '../core/menus.js';
import { commands as workbench, keybindingLabel } from '../core/commands.js';
import { editors } from '../workbench/editors.js';
import { detectLanguage, loadSupport, languageLabel, emmetSyntaxFor, HTML_LIKE } from './languages.js';
import { xcHighlighter, cssHighlighter } from './highlight.js';
import { vscodeTheme, fontTheme, currentLineHighlight, bracketPairColorization, renderWhitespace, relativeLineNumbers, foldMarker, foldPlaceholder, wrappedLineIndent } from './look.js';
import { createFindPanel, findExtensions } from './findWidget.js';
import { completionExtensions } from './completion.js';
import { vscodeKeymap, baseKeymap, tabKeymap, acceptSuggestionWithTab } from './keymap.js';
import { fontMetrics } from './settings.js';
import { lintAndPublish, queueBackgroundLint } from './lint.js';
import { textEditors, editorEvents, languageOverride, overridesReady } from './registry.js';
import { documentSymbols, symbolPathAt } from './symbols.js';
import { Breadcrumbs } from './breadcrumbs.js';
import { formatText, applyMinimalChange } from './format.js';
import { trimTrailingWhitespace, posOf } from './ops.js';
import { markerExtensions, clearMarkerWidget } from './markerWidget.js';
import { recordLocation } from './navigation.js';

const { EditorState, Compartment, Prec, StateEffect, StateField, EditorSelection, Text } = S;
const { EditorView, Decoration, lineNumbers, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, scrollPastEnd, tooltips } = V;
const { syntaxHighlighting, bracketMatching, foldGutter, codeFolding, indentOnInput, indentUnit } = L;

export const LARGE_FILE = 2 * 1024 * 1024;
let fontZoom = 0;
try { fontZoom = Number(localStorage.getItem('xcoder.editor.fontZoom') || 0) || 0; } catch {}
export function getFontZoom() { return fontZoom; }
export function setFontZoom(z) {
  fontZoom = Math.max(-8, Math.min(24, z));
  try { localStorage.setItem('xcoder.editor.fontZoom', String(fontZoom)); } catch {}
  for (const ed of allCodeEditors()) ed.applySetting('editor.fontSize');
}

const liveEditors = new Set();
export function allCodeEditors() { return [...liveEditors]; }

let emmetModule = null;
let emmetLoading = null;
function loadEmmet() {
  if (emmetModule) return Promise.resolve(emmetModule);
  return emmetLoading || (emmetLoading = import('../../vendor/cm-emmet.js').then(m => (emmetModule = m)).catch(err => { emmetLoading = null; log.warn('Emmet failed to load', err); return null; }));
}
let minimapModule = null;
function loadMinimap() { return minimapModule ? Promise.resolve(minimapModule) : import('../../vendor/cm-minimap.js').then(m => (minimapModule = m)); }

// Brief highlight of a revealed range (Go to Line / Symbol), like VS Code's rangeHighlight.
const flashEffect = StateEffect.define();
const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(flashEffect)) deco = e.value ? Decoration.set([Decoration.line({ class: 'cm-xc-lineFlash' }).range(e.value)]) : Decoration.none;
    return deco;
  },
  provide: f => EditorView.decorations.from(f)
});

/** VS Code's indentation guesser (subset): tabs vs spaces and the most common indent step. */
export function detectIndentation(text, defaults) {
  let tabs = 0, spaces = 0, prev = 0;
  const deltas = new Map();
  const lines = text.split('\n', 5000);
  for (const line of lines) {
    if (!line.trim()) continue;
    const ws = /^[ \t]*/.exec(line)[0];
    if (ws.startsWith('\t')) { tabs++; prev = 0; continue; }
    const n = ws.length;
    if (n) spaces++;
    const d = Math.abs(n - prev);
    if (d >= 2 && d <= 8) deltas.set(d, (deltas.get(d) || 0) + 1);
    prev = n;
  }
  if (tabs > spaces) return { insertSpaces: false, tabSize: defaults.tabSize };
  if (!spaces) return defaults;
  let best = defaults.tabSize, count = 0;
  for (const [d, c] of deltas) if (c > count || (c === count && d < best)) { best = d; count = c; }
  return { insertSpaces: true, tabSize: count ? best : defaults.tabSize };
}

function isDarkTheme() { return document.documentElement.dataset.themeType !== 'light'; }

export class CodeEditor {
  constructor({ path, container, api, text, large = false, readOnly = false }) {
    this.kind = 'code';
    this.readOnly = readOnly;
    this.path = path;
    this.api = api;
    this.container = container;
    this.large = large;
    this.forceFeatures = false;
    this.disposed = false;
    this.dirty = false;
    this.eol = /\r\n/.test(text.slice(0, 100000)) ? 'CRLF' : 'LF';
    this.savedEol = this.eol;
    this.lang = detectLanguage(path, text, languageOverride(path));
    const defaults = { tabSize: Number(settings.get('editor.tabSize')) || 4, insertSpaces: settings.get('editor.insertSpaces') !== false };
    this.indent = settings.get('editor.detectIndentation') !== false ? detectIndentation(text, defaults) : defaults;
    this.c = {};
    for (const k of ['lang', 'lineNumbers', 'folding', 'wrap', 'indent', 'eol', 'font', 'minimap', 'whitespace', 'guides', 'brackets', 'closeBrackets', 'cursor', 'dark', 'completion', 'scrollPast', 'lint']) this.c[k] = new Compartment();

    container.classList.add('xc-editor-root');
    this.host = h('div', { class: 'xc-code-editor', 'data-path': path });
    if (readOnly) container.append(h('div', { class: 'editor-readonly-notice', role: 'note' }, 'This file is binary or uses an unsupported encoding. It is shown read-only so saving can\'t corrupt it.'));
    container.append(this.host);
    this.breadcrumbs = new Breadcrumbs(container, this);

    const state = EditorState.create({ doc: text, extensions: this.extensions() });
    this.view = new EditorView({ state, parent: this.host });
    this.savedDoc = this.view.state.doc;
    this.host.dataset.language = this.lang.id;
    this.view.dom.classList.add(`cm-lang-${this.lang.id}`);
    liveEditors.add(this);
    textEditors.set(path, this);
    this.loadLanguage();
    this.applySetting('editor.minimap.enabled');
    this.scheduleLint(0);
    if (large) this.showLargeFileNotice(text.length);
  }

  static async create(input, container, api, { readOnly = false } = {}) {
    const fs = workspace.fs;
    const text = await fs.readText(input.path);
    await overridesReady();
    return new CodeEditor({ path: input.path, container, api, text, large: text.length > LARGE_FILE, readOnly });
  }

  get features() { return !this.large || this.forceFeatures; }

  // ---------------- configuration ----------------
  extensions() {
    const c = this.c;
    return [
      c.lang.of([]),
      this.readOnly ? EditorState.readOnly.of(true) : [],
      c.lineNumbers.of(this.lineNumbersExt()),
      c.folding.of(this.foldingExt()),
      highlightActiveLineGutter(),
      CM.commands.history(),
      c.cursor.of(this.cursorExt()),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(xcHighlighter),
      syntaxHighlighting(cssHighlighter),
      bracketMatching(),
      c.closeBrackets.of(settings.get('editor.autoClosingBrackets') === 'never' ? [] : AC.closeBrackets()),
      c.completion.of(completionExtensions()),
      rectangularSelection(),
      crosshairCursor(),
      currentLineHighlight,
      SR.highlightSelectionMatches({ highlightWordAroundCursor: true, minSelectionLength: 1, maxMatches: 400 }),
      SR.search({ top: true, createPanel: createFindPanel, scrollToMatch: range => EditorView.scrollIntoView(range, { y: 'center' }) }),
      findExtensions,
      c.lint.of(this.features ? LI.linter(null, { delay: 0, autoPanel: false }) : []),
      markerExtensions,
      flashField,
      c.wrap.of(this.wrapExt()),
      c.indent.of(this.indentExt()),
      c.eol.of(this.eol === 'CRLF' ? EditorState.lineSeparator.of('\r\n') : []),
      c.font.of(fontTheme(fontMetrics(fontZoom))),
      c.minimap.of([]),
      c.whitespace.of(this.features ? renderWhitespace(settings.get('editor.renderWhitespace')) : []),
      c.guides.of(this.guidesExt()),
      c.brackets.of(this.features && settings.get('editor.bracketPairColorization.enabled') !== false ? bracketPairColorization : []),
      c.scrollPast.of(settings.get('editor.scrollBeyondLastLine') !== false ? scrollPastEnd() : []),
      c.dark.of(EditorView.darkTheme.of(isDarkTheme())),
      vscodeTheme,
      vscodeKeymap(),
      acceptSuggestionWithTab,
      baseKeymap(),
      tabKeymap,
      EditorView.contentAttributes.of({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off', 'aria-label': `Editor content — ${posix.basename(this.path)}` }),
      EditorView.editorAttributes.of({ class: 'monaco-editor' }),
      tooltips({ tooltipSpace: view => { const r = view.dom.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom }; } }),
      EditorView.updateListener.of(u => this.onUpdate(u)),
      EditorView.domEventHandlers({ contextmenu: (e, view) => this.onContextMenu(e, view) })
    ];
  }

  lineNumbersExt() {
    const mode = settings.get('editor.lineNumbers');
    if (mode === 'off') return [];
    if (mode === 'relative') return relativeLineNumbers();
    return lineNumbers();
  }
  wrapExt() { return settings.get('editor.wordWrap') === 'on' ? [EditorView.lineWrapping, wrappedLineIndent] : []; }
  foldingExt() {
    if (!this.features || settings.get('editor.folding') === false) return [];
    return [foldGutter({ markerDOM: foldMarker }), codeFolding({ placeholderDOM: foldPlaceholder })];
  }
  cursorExt() {
    const style = settings.get('editor.cursorBlinking') || 'blink';
    return [drawSelection({ cursorBlinkRate: style === 'solid' ? 0 : 1200 }), EditorView.editorAttributes.of({ class: `cursor-${style}` })];
  }
  indentExt() {
    const { tabSize, insertSpaces } = this.indent;
    return [indentUnit.of(insertSpaces ? ' '.repeat(tabSize) : '\t'), EditorState.tabSize.of(tabSize)];
  }
  guidesExt() {
    if (!this.features || settings.get('editor.guides.indentation') === false) return [];
    return indentationMarkers({
      highlightActiveBlock: true, markerType: 'fullScope', thickness: 1, activeThickness: 1,
      colors: { light: 'var(--vscode-editorIndentGuide-background)', dark: 'var(--vscode-editorIndentGuide-background)', activeLight: 'var(--vscode-editorIndentGuide-activeBackground)', activeDark: 'var(--vscode-editorIndentGuide-activeBackground)' }
    });
  }

  async langExt() {
    if (!this.features) return [];
    const lang = this.lang;
    const support = await loadSupport(lang);
    const ext = [support || []];
    const syntax = emmetSyntaxFor(lang);
    if (syntax && settings.get('emmet.enabled') !== false) {
      const emmet = await loadEmmet();
      if (emmet) ext.push(Prec.highest(emmet.abbreviationTracker({ syntax, mark: true, preview: {} })));
    }
    if (HTML_LIKE.has(lang.id) && settings.get('html.autoClosingTags') === false) {
      ext.push(Prec.highest(EditorView.inputHandler.of((view, from, to, text) => {
        if (text !== '>' && text !== '/') return false;
        view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.type' });
        return true;
      })));
    }
    return ext;
  }

  async loadLanguage() {
    const lang = this.lang;
    try {
      const ext = await this.langExt();
      if (this.disposed || lang !== this.lang) return;
      this.view.dispatch({ effects: this.c.lang.reconfigure(ext) });
      this.breadcrumbs?.render(true);
      editorEvents.emit('language', this.path, this.lang);
    } catch (err) { log.warn(`Language support for ${this.path} failed`, err); }
  }

  setLanguage(lang) {
    if (!lang || lang === this.lang) return;
    this.view.dom.classList.remove(`cm-lang-${this.lang.id}`);
    this.lang = lang;
    this.host.dataset.language = lang.id;
    this.view.dom.classList.add(`cm-lang-${lang.id}`);
    this.loadLanguage();
    this.scheduleLint(0);
    this.refreshStatus();
  }

  setIndentation({ tabSize = this.indent.tabSize, insertSpaces = this.indent.insertSpaces } = {}) {
    this.indent = { tabSize, insertSpaces };
    this.view.dispatch({ effects: this.c.indent.reconfigure(this.indentExt()) });
    this.refreshStatus();
  }

  setEol(eol) {
    if (eol === this.eol) return;
    this.eol = eol;
    this.view.dispatch({ effects: this.c.eol.reconfigure(eol === 'CRLF' ? EditorState.lineSeparator.of('\r\n') : []) });
    this.updateDirty();
    this.scheduleAutoSave();
    this.refreshStatus();
  }

  /** Re-applies one setting (called on 'settings:changed'). */
  applySetting(key) {
    if (this.disposed) return;
    const c = this.c, v = this.view;
    const eff = [];
    switch (key) {
      case 'editor.fontSize': case 'editor.fontFamily': case 'editor.lineHeight': eff.push(c.font.reconfigure(fontTheme(fontMetrics(fontZoom)))); break;
      case 'editor.lineNumbers': eff.push(c.lineNumbers.reconfigure(this.lineNumbersExt())); break;
      case 'editor.folding': eff.push(c.folding.reconfigure(this.foldingExt())); break;
      case 'editor.wordWrap': eff.push(c.wrap.reconfigure(this.wrapExt())); break;
      case 'editor.renderWhitespace': eff.push(c.whitespace.reconfigure(this.features ? renderWhitespace(settings.get('editor.renderWhitespace')) : [])); break;
      case 'editor.guides.indentation': eff.push(c.guides.reconfigure(this.guidesExt())); break;
      case 'editor.bracketPairColorization.enabled': eff.push(c.brackets.reconfigure(this.features && settings.get(key) !== false ? bracketPairColorization : [])); break;
      case 'editor.autoClosingBrackets': eff.push(c.closeBrackets.reconfigure(settings.get(key) === 'never' ? [] : AC.closeBrackets())); break;
      case 'editor.cursorBlinking': eff.push(c.cursor.reconfigure(this.cursorExt())); break;
      case 'editor.scrollBeyondLastLine': eff.push(c.scrollPast.reconfigure(settings.get(key) !== false ? scrollPastEnd() : [])); break;
      case 'editor.quickSuggestions': case 'editor.acceptSuggestionOnEnter': case 'editor.wordBasedSuggestions': eff.push(c.completion.reconfigure(completionExtensions())); break;
      case 'editor.tabSize': case 'editor.insertSpaces': case 'editor.detectIndentation': {
        const defaults = { tabSize: Number(settings.get('editor.tabSize')) || 4, insertSpaces: settings.get('editor.insertSpaces') !== false };
        this.indent = settings.get('editor.detectIndentation') !== false ? detectIndentation(v.state.doc.toString(), defaults) : defaults;
        eff.push(c.indent.reconfigure(this.indentExt()));
        this.refreshStatus();
        break;
      }
      case 'emmet.enabled': case 'html.autoClosingTags': this.loadLanguage(); break;
      case 'editor.minimap.enabled': case 'editor.minimap.renderCharacters': this.updateMinimap(); break;
      case 'theme': eff.push(c.dark.reconfigure(EditorView.darkTheme.of(isDarkTheme()))); break;
      default: break;
    }
    if (eff.length) v.dispatch({ effects: eff });
  }

  async updateMinimap() {
    const enabled = settings.get('editor.minimap.enabled') === true && this.features;
    if (!enabled) {
      if (this.minimapOn) { this.minimapOn = false; this.view.dispatch({ effects: this.c.minimap.reconfigure([]) }); }
      return;
    }
    try {
      const { showMinimap } = await loadMinimap();
      if (this.disposed) return;
      const displayText = settings.get('editor.minimap.renderCharacters') === false ? 'blocks' : 'characters';
      this.minimapOn = true;
      this.view.dispatch({ effects: this.c.minimap.reconfigure(showMinimap.of({ create: () => ({ dom: h('div', { class: 'minimap-host' }) }), displayText, showOverlay: 'mouse-over' })) });
      // The minimap draws on its next update; trigger one once it is mounted.
      requestAnimationFrame(() => { if (!this.disposed && this.minimapOn) this.view.dispatch({}); });
    } catch (err) { log.warn('Minimap failed to load', err); }
  }

  forceEnableFeatures() {
    if (this.forceFeatures) return;
    this.forceFeatures = true;
    const c = this.c;
    this.view.dispatch({ effects: [
      c.folding.reconfigure(this.foldingExt()), c.guides.reconfigure(this.guidesExt()), c.lint.reconfigure(LI.linter(null, { delay: 0, autoPanel: false })),
      c.whitespace.reconfigure(renderWhitespace(settings.get('editor.renderWhitespace'))),
      c.brackets.reconfigure(settings.get('editor.bracketPairColorization.enabled') !== false ? bracketPairColorization : [])
    ] });
    this.loadLanguage();
    this.updateMinimap();
    this.scheduleLint(0);
  }

  showLargeFileNotice(size) {
    const name = posix.basename(this.path);
    notify.info(`${name}: syntax highlighting, folding, bracket colorization, diagnostics and the minimap have been turned off for this large file (${(size / 1024 / 1024).toFixed(1)} MB) to keep X Coder responsive.`, {
      source: 'Editor', actions: [{ label: 'Forcefully Enable Features', run: () => this.forceEnableFeatures() }]
    });
  }

  // ---------------- updates ----------------
  onUpdate(u) {
    if (this.disposed) return;
    if (u.docChanged) {
      if (!this.applyingExternal) { this.updateDirty(); this.scheduleAutoSave(); }
      clearMarkerWidget(u.view);
      this.scheduleLint();
      editorEvents.emit('change', this.path, this);
    }
    if (u.docChanged || u.selectionSet) {
      if (this.isActive()) { this.refreshStatus(); this.emitCursor(); }
      this.scheduleBreadcrumbs();
      if (u.selectionSet && u.transactions.some(tr => tr.isUserEvent('select.pointer'))) this.trackLocation();
    }
    if (u.focusChanged) {
      editorEvents.emit('focus', this, u.view.hasFocus);
      if (!u.view.hasFocus && this.dirty && settings.get('files.autoSave') === 'onFocusChange') this.save({ auto: true }).catch(() => {});
    }
  }

  isActive() { const a = editors.active?.instance; return !!a && (a === this || a.inner === this); }

  updateDirty() {
    const dirty = !this.view.state.doc.eq(this.savedDoc) || this.eol !== this.savedEol;
    if (dirty !== this.dirty) { this.dirty = dirty; this.api.setDirty(dirty); }
  }

  scheduleAutoSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    if (!this.dirty || settings.get('files.autoSave') !== 'afterDelay') return;
    this.saveTimer = setTimeout(() => { this.saveTimer = 0; this.save({ auto: true }).catch(() => {}); }, Math.max(100, Number(settings.get('files.autoSaveDelay')) || 1000));
  }
  /** Saves immediately if an auto-save is pending (page hidden / window blur). */
  flushAutoSave() {
    if (this.saveTimer || (this.dirty && ['afterDelay', 'onWindowChange', 'onFocusChange'].includes(settings.get('files.autoSave')))) {
      clearTimeout(this.saveTimer); this.saveTimer = 0;
      return this.save({ auto: true }).catch(() => {});
    }
  }

  scheduleLint(delay = 400) {
    clearTimeout(this.lintTimer);
    if (!this.features) return;
    this.lintTimer = setTimeout(() => {
      if (this.disposed) return;
      lintAndPublish(this.path, this.view.state.doc.toString(), this.lang);
    }, delay);
  }

  scheduleBreadcrumbs() {
    clearTimeout(this.crumbTimer);
    this.crumbTimer = setTimeout(() => { if (!this.disposed) { this.breadcrumbs.render(); editorEvents.emit('cursor', this); } }, 120);
  }

  /** Pushes markers from the diagnostics service into CodeMirror's lint state (squiggles + hovers). */
  syncDiagnostics() {
    if (this.disposed || !this.features) return;
    const markers = diagnostics.forFile(this.path);
    const sig = JSON.stringify(markers.map(m => [m.line, m.col, m.endLine, m.endCol, m.severity, m.message]));
    if (sig === this.diagSig) return;
    this.diagSig = sig;
    const doc = this.view.state.doc;
    const list = markers.map(m => {
      const from = posOf(doc, m.line, m.col);
      let to = m.endLine ? posOf(doc, m.endLine, m.endCol || m.col + 1) : from + 1;
      if (to <= from) to = Math.min(doc.length, from + 1);
      const severity = m.severity === 'warning' ? 'warning' : m.severity === 'error' ? 'error' : 'info';
      return { from, to: Math.min(to, doc.length), severity, message: m.message, source: m.source || m.owner };
    }).filter(d => d.from <= doc.length);
    try { this.view.dispatch(LI.setDiagnostics(this.view.state, list)); } catch (err) { log.warn('Could not show diagnostics', err); }
  }

  // ---------------- status / cursor ----------------
  statusInfo() {
    const state = this.view.state;
    const sel = state.selection.main;
    const line = state.doc.lineAt(sel.head);
    let selected = 0;
    for (const r of state.selection.ranges) selected += r.to - r.from;
    const col = CM.state.countColumn(line.text.slice(0, sel.head - line.from), state.tabSize) + 1;
    return {
      line: line.number, col, selected, cursors: state.selection.ranges.length, lines: state.doc.lines,
      tabSize: this.indent.tabSize, insertSpaces: this.indent.insertSpaces, eol: this.eol,
      language: languageLabel(this.path, this.lang), languageId: this.lang.id
    };
  }
  refreshStatus() { if (this.isActive()) editorEvents.emit('status', this); }
  emitCursor() {
    const i = this.statusInfo();
    bus.emit('editor:cursor', { path: this.path, line: i.line, col: i.col, selectionLength: i.selected, lines: i.lines });
  }
  trackLocation() {
    const i = this.statusInfo();
    recordLocation(this.path, i.line, i.col);
  }

  // ---------------- symbols ----------------
  symbols() { return this.features ? documentSymbols(this.view.state, this.lang.id) : []; }
  symbolPath() { return this.features ? symbolPathAt(this.symbols(), this.view.state.selection.main.head) : []; }

  // ---------------- editor instance API (workbench) ----------------
  focus() { this.view.focus(); }
  onShow() {
    this.view.requestMeasure();
    this.syncDiagnostics();
    this.refreshStatus();
    this.emitCursor();
  }
  onHide() { clearMarkerWidget(this.view); }
  isDirty() { return this.dirty; }

  reveal({ line, col = 1, endLine, endCol, select = false, flash = false } = {}) {
    const doc = this.view.state.doc;
    const from = posOf(doc, line || 1, col);
    const to = endLine ? posOf(doc, endLine, endCol || 1) : from;
    this.view.dispatch({
      selection: select && to !== from ? EditorSelection.single(from, to) : EditorSelection.cursor(from),
      effects: [EditorView.scrollIntoView(from, { y: 'center' }), ...(flash ? [flashEffect.of(doc.lineAt(from).from)] : [])],
      userEvent: 'select.reveal'
    });
    if (flash) { clearTimeout(this.flashTimer); this.flashTimer = setTimeout(() => { if (!this.disposed) this.view.dispatch({ effects: flashEffect.of(null) }); }, 1400); }
    recordLocation(this.path, line || 1, col);
  }
  /** Temporary highlight for quick access previews (null clears). */
  flashLine(pos) {
    if (this.disposed) return;
    this.view.dispatch({ effects: [flashEffect.of(pos == null ? null : this.view.state.doc.lineAt(pos).from), ...(pos == null ? [] : [EditorView.scrollIntoView(pos, { y: 'center' })])] });
  }

  getState() {
    return { selection: this.view.state.selection.toJSON(), scrollTop: this.view.scrollDOM.scrollTop, scrollLeft: this.view.scrollDOM.scrollLeft };
  }
  setState(s) {
    if (!s) return;
    try {
      const len = this.view.state.doc.length;
      const sel = EditorSelection.fromJSON(s.selection);
      if (sel.ranges.every(r => r.to <= len)) this.view.dispatch({ selection: sel });
    } catch {}
    requestAnimationFrame(() => { if (!this.disposed) { this.view.scrollDOM.scrollTop = s.scrollTop || 0; this.view.scrollDOM.scrollLeft = s.scrollLeft || 0; } });
  }

  setInput(input) {
    const old = this.path;
    if (input.path === old) return;
    textEditors.delete(old);
    this.path = input.path;
    this.host.dataset.path = input.path;
    textEditors.set(this.path, this);
    const lang = detectLanguage(this.path, this.view.state.doc.sliceString(0, 200), languageOverride(this.path));
    if (lang !== this.lang) this.setLanguage(lang);
    this.breadcrumbs.render(true);
    this.scheduleLint(0);
    this.refreshStatus();
  }

  getText() { return this.view.state.sliceDoc(); }

  async save({ auto = false } = {}) {
    if (this.disposed) return false;
    clearTimeout(this.saveTimer); this.saveTimer = 0;
    const view = this.view;
    const participants = !(auto && settings.get('files.autoSave') === 'afterDelay');
    if (participants && !view.state.readOnly) {
      if (settings.get('editor.formatOnSave') === true && this.features) {
        try { await this.format({ quiet: true }); } catch (err) { log.warn('Format on save failed', err); }
      }
      if (settings.get('files.trimTrailingWhitespace') === true) trimTrailingWhitespace(view);
      if (settings.get('files.insertFinalNewline') === true) {
        const doc = view.state.doc;
        if (doc.length && doc.line(doc.lines).length) view.dispatch({ changes: { from: doc.length, insert: view.state.lineBreak }, userEvent: 'input' });
      }
    }
    if (!this.dirty) return true;
    const doc = view.state.doc;
    const eol = this.eol;
    const text = view.state.sliceDoc();
    this.savingText = text;
    try {
      await workspace.fs.writeText(this.path, text, { source: 'editor' });
    } catch (err) {
      notify.error(`Failed to save '${posix.basename(this.path)}': ${err.message || err}`, { source: 'Editor' });
      return false;
    } finally { this.savingText = null; }
    if (this.disposed) return true;
    this.savedDoc = doc;
    this.savedEol = eol;
    this.updateDirty();
    bus.emit('editor:saved', { path: this.path });
    return true;
  }

  /** Replaces the content with `text` without marking the editor dirty (disk reloads). */
  replaceFromDisk(text) {
    this.applyingExternal = true;
    try {
      const eol = /\r\n/.test(text.slice(0, 100000)) ? 'CRLF' : 'LF';
      if (eol !== this.eol) { this.eol = eol; this.view.dispatch({ effects: this.c.eol.reconfigure(eol === 'CRLF' ? EditorState.lineSeparator.of('\r\n') : []) }); }
      applyMinimalChange(this.view, text, 'external');
    } finally { this.applyingExternal = false; }
    this.savedDoc = this.view.state.doc;
    this.savedEol = this.eol;
    this.updateDirty();
  }

  /** Called when the file changed on disk from another source (AI, git, search replace, terminal…). */
  onDiskChanged() {
    if (this.disposed) return;
    const disk = workspace.fs?.peekText(this.path);
    if (disk == null) return;
    if (disk === this.savingText) return;
    const saved = this.savedDoc.toString();
    const savedText = this.savedEol === 'CRLF' ? saved.replace(/\n/g, '\r\n') : saved;
    if (disk === savedText) return;
    if (!this.dirty) { this.replaceFromDisk(disk); return; }
    if (this.conflictNotice) this.conflictNotice.close?.();
    const name = posix.basename(this.path);
    this.conflictNotice = notify.warn(`'${name}' was changed on disk while you have unsaved changes in the editor.`, {
      source: 'Editor', sticky: true,
      actions: [
        { label: 'Compare', run: () => this.compareWithDisk() },
        { label: 'Keep Mine', run: () => this.keepMine() },
        { label: 'Load From Disk', run: () => this.revert() }
      ]
    });
  }
  keepMine() {
    const disk = workspace.fs?.peekText(this.path);
    if (disk != null) this.savedDoc = Text.of(disk.replace(/\r\n/g, '\n').split('\n'));
    this.updateDirty();
    this.scheduleAutoSave();
  }
  async compareWithDisk() {
    const disk = workspace.fs?.peekText(this.path) ?? '';
    const name = posix.basename(this.path);
    await editors.open({
      type: 'diff', id: `conflict:${this.path}`, path: this.path, title: `${name} (on disk) ↔ ${name} (in editor)`,
      original: disk, modified: this.getText(), readOnly: true,
      actions: [
        { label: 'Keep Mine', icon: 'check', run: () => { this.keepMine(); editors.close(`diff:conflict:${this.path}`, { force: true }); } },
        { label: 'Load From Disk', icon: 'discard', run: () => { this.revert(); editors.close(`diff:conflict:${this.path}`, { force: true }); } }
      ]
    }, { pinned: true });
  }
  /** File: Revert File — discard changes and reload from disk. */
  revert() {
    const disk = workspace.fs?.peekText(this.path);
    if (disk == null) return false;
    this.conflictNotice?.close?.();
    this.replaceFromDisk(disk);
    return true;
  }

  async format({ quiet = false } = {}) {
    const view = this.view;
    if (view.state.readOnly) return false;
    const before = view.state.doc;
    try {
      const { text, formatter } = await formatText(view.state.doc.toString(), this.lang, { ...this.indent, path: this.path });
      if (this.disposed || !view.state.doc.eq(before)) return false;
      const changed = applyMinimalChange(view, text);
      log.info(`Formatted ${this.path} with ${formatter === 'Prettier' ? 'Prettier' : 'the built-in formatter'}${changed ? '' : ' (no changes)'}`);
      return true;
    } catch (err) {
      if (!quiet) notify.warn(`Format Document failed for '${posix.basename(this.path)}': ${err.message}`, { source: 'Formatter' });
      throw err;
    }
  }

  // ---------------- context menu (desktop right-click; touch keeps the native iOS callout) ----------------
  onContextMenu(e, view) {
    if (matchMedia('(hover: none)').matches && e.pointerType !== 'mouse') return false;
    e.preventDefault();
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos != null && !view.state.selection.ranges.some(r => r.from <= pos && pos <= r.to)) view.dispatch({ selection: { anchor: pos } });
    showContextMenu(editorContextMenu(this), { x: e.clientX, y: e.clientY });
    return true;
  }

  dispose() {
    if (this.disposed) return;
    const wasDirty = this.dirty;
    this.disposed = true;
    clearTimeout(this.saveTimer); clearTimeout(this.lintTimer); clearTimeout(this.crumbTimer); clearTimeout(this.flashTimer);
    this.conflictNotice?.close?.();
    liveEditors.delete(this);
    if (textEditors.get(this.path) === this) textEditors.delete(this.path);
    this.breadcrumbs.dispose();
    this.view.destroy();
    editorEvents.emit('disposed', this);
    // Unsaved edits were discarded: diagnostics go back to what is on disk.
    if (wasDirty && workspace.fs?.exists(this.path)) queueBackgroundLint([this.path]);
  }
}

export function editorContextMenu(ed) {
  const kb = id => workbench.keybindingLabel(id);
  const items = [
    { label: 'Go to Symbol…', keybinding: kb('workbench.action.gotoSymbol'), run: () => workbench.execute('workbench.action.gotoSymbol') },
    { label: 'Change All Occurrences', keybinding: kb('editor.action.changeAll'), run: () => workbench.execute('editor.action.changeAll') },
    { label: 'Format Document', keybinding: kb('editor.action.formatDocument'), run: () => workbench.execute('editor.action.formatDocument') },
    { separator: true },
    { label: 'Cut', keybinding: keybindingLabel('Mod+X'), disabled: ed.view.state.readOnly, run: () => workbench.execute('editor.action.clipboardCutAction') },
    { label: 'Copy', keybinding: keybindingLabel('Mod+C'), run: () => workbench.execute('editor.action.clipboardCopyAction') },
    { label: 'Paste', keybinding: keybindingLabel('Mod+V'), disabled: ed.view.state.readOnly, run: () => workbench.execute('editor.action.clipboardPasteAction') }
  ];
  const extra = menus.resolve('editor/context', { path: ed.path });
  if (extra.length) items.push({ separator: true }, ...extra);
  items.push({ separator: true }, { label: 'Command Palette…', keybinding: kb('workbench.action.showCommands'), run: () => workbench.execute('workbench.action.showCommands') });
  return items;
}

// Keep editors in sync with theme / settings / diagnostics.
bus.on('theme:changed', () => { for (const ed of liveEditors) ed.applySetting('theme'); });
bus.on('settings:changed', ({ key }) => { for (const ed of liveEditors) ed.applySetting(key); });
bus.on('diagnostics:changed', () => { for (const ed of liveEditors) ed.syncDiagnostics(); });
