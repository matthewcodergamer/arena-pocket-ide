// Diff editor (input { type: 'diff', id, title, path, original, modified, readOnly, actions }):
// @codemirror/merge side-by-side on wide screens, inline (unified) on phones, VS Code diff colors,
// next/previous change, custom action buttons, and saving the modified side when editable.

import { state as S, view as V, language as L, merge as M, commands as C, search as SR } from './cm.js';
import { h, codicon, isPhone } from '../core/dom.js';
import { settings } from '../core/settings.js';
import { workspace } from '../core/workspace.js';
import { posix } from '../core/path.js';
import { bus } from '../core/events.js';
import { notify } from '../platform/notifications.js';
import { detectLanguage, loadSupport } from './languages.js';
import { xcHighlighter, cssHighlighter } from './highlight.js';
import { vscodeTheme, fontTheme, themeBoth } from './look.js';
import { fontMetrics } from './settings.js';
import { vscodeKeymap, baseKeymap, tabKeymap } from './keymap.js';
import { createFindPanel, findExtensions } from './findWidget.js';
import { getFontZoom } from './codeEditor.js';
import { queueBackgroundLint } from './lint.js';
import { languageOverride } from './registry.js';

const { EditorState, Compartment } = S;
const { EditorView, lineNumbers, drawSelection, highlightActiveLineGutter } = V;
const { syntaxHighlighting, bracketMatching } = L;
const { MergeView, unifiedMergeView, goToNextChunk, goToPreviousChunk, getChunks } = M;

const diffTheme = EditorView.theme(themeBoth({
  '.cm-changedLine': { backgroundColor: 'var(--vscode-diffEditor-insertedLineBackground)' },
  '.cm-inlineChangedLine': { backgroundColor: 'var(--vscode-diffEditor-insertedLineBackground)' },
  '&.cm-merge-a .cm-changedLine': { backgroundColor: 'var(--vscode-diffEditor-removedLineBackground)' },
  '.cm-changedText': { background: 'var(--vscode-diffEditor-insertedTextBackground)' },
  '&.cm-merge-b .cm-changedText': { background: 'var(--vscode-diffEditor-insertedTextBackground)' },
  '&.cm-merge-a .cm-changedText': { background: 'var(--vscode-diffEditor-removedTextBackground)' },
  '.cm-deletedChunk': { backgroundColor: 'var(--vscode-diffEditor-removedLineBackground)', paddingLeft: '4px' },
  '.cm-deletedChunk .cm-deletedText': { background: 'var(--vscode-diffEditor-removedTextBackground)' },
  '&.cm-merge-b .cm-deletedText': { background: 'var(--vscode-diffEditor-removedTextBackground)' },
  '.cm-deletedLine, .cm-insertedLine, .cm-deletedLine del': { textDecoration: 'none' },
  '.cm-changeGutter': { width: '4px', paddingLeft: '0' },
  '.cm-changedLineGutter': { background: 'var(--vscode-editorGutter-addedBackground)' },
  '&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter': { background: 'var(--vscode-editorGutter-deletedBackground)' },
  '.cm-collapsedLines': { color: 'var(--vscode-descriptionForeground)', background: 'var(--vscode-editorWidget-background)', padding: '2px 8px', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: '12px' }
}));

function isDarkTheme() { return document.documentElement.dataset.themeType !== 'light'; }

class DiffEditor {
  constructor(input, container, api) {
    this.kind = 'diff';
    this.input = input;
    this.api = api;
    this.container = container;
    this.path = input.path || null;
    this.editable = !input.readOnly && !!input.path;
    this.dirty = false;
    this.inline = isPhone() || (document.getElementById('editor-container')?.clientWidth || window.innerWidth) < 760;
    this.lang = detectLanguage(input.path || input.title || '', String(input.modified ?? '').slice(0, 200), input.path ? languageOverride(input.path) : null);
    this.langComp = new Compartment();
    this.darkComp = new Compartment();
    this.fontComp = new Compartment();
    this.wrapComp = new Compartment();
    container.classList.add('xc-diff-root');
    this.toolbar = h('div', { class: 'diff-toolbar' });
    this.body = h('div', { class: 'diff-body' });
    container.append(this.toolbar, this.body);
    this.renderToolbar();
    this.build(String(input.original ?? ''), String(input.modified ?? ''));
    this.savedDoc = this.modifiedView.state.doc;
    this.offs = [
      bus.on('theme:changed', () => this.reconfigureAll(this.darkComp, EditorView.darkTheme.of(isDarkTheme()))),
      bus.on('settings:changed', ({ key }) => {
        if (key.startsWith('editor.font') || key === 'editor.lineHeight') this.reconfigureAll(this.fontComp, fontTheme(fontMetrics(getFontZoom())));
        if (key === 'editor.wordWrap') this.reconfigureAll(this.wrapComp, settings.get('editor.wordWrap') === 'on' ? EditorView.lineWrapping : []);
      })
    ];
    loadSupport(this.lang).then(support => { if (support && !this.disposed) this.reconfigureAll(this.langComp, support); });
  }

  views() { return this.merge ? [this.merge.a, this.merge.b] : this.unified ? [this.unified] : []; }
  get modifiedView() { return this.merge ? this.merge.b : this.unified; }
  get view() { return this.modifiedView; }
  reconfigureAll(comp, ext) { for (const v of this.views()) v.dispatch({ effects: comp.reconfigure(ext) }); }

  shared(readOnly) {
    return [
      this.langComp.of([]),
      lineNumbers(), highlightActiveLineGutter(), drawSelection(), bracketMatching(),
      syntaxHighlighting(xcHighlighter), syntaxHighlighting(cssHighlighter),
      C.history(),
      SR.search({ top: true, createPanel: createFindPanel }), findExtensions,
      this.darkComp.of(EditorView.darkTheme.of(isDarkTheme())),
      this.fontComp.of(fontTheme(fontMetrics(getFontZoom()))),
      this.wrapComp.of(settings.get('editor.wordWrap') === 'on' ? EditorView.lineWrapping : []),
      vscodeTheme, diffTheme,
      vscodeKeymap(), baseKeymap(), tabKeymap,
      EditorState.readOnly.of(readOnly),
      EditorView.contentAttributes.of({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
      EditorView.editorAttributes.of({ class: 'monaco-editor monaco-diff-editor' })
    ];
  }

  build(original, modified) {
    const onChange = EditorView.updateListener.of(u => { if (u.docChanged) this.updateDirty(); });
    this.body.replaceChildren();
    this.merge?.destroy(); this.unified?.destroy();
    this.merge = null; this.unified = null;
    if (this.inline) {
      this.unified = new EditorView({
        parent: this.body,
        state: EditorState.create({ doc: modified, extensions: [this.shared(!this.editable), onChange, unifiedMergeView({ original, highlightChanges: true, gutter: true, mergeControls: false, syntaxHighlightDeletions: true, allowInlineDiffs: false })] })
      });
    } else {
      this.merge = new MergeView({
        parent: this.body,
        a: { doc: original, extensions: [this.shared(true)] },
        b: { doc: modified, extensions: [this.shared(!this.editable), onChange] },
        highlightChanges: true, gutter: true, revertControls: undefined
      });
    }
    this.body.classList.toggle('inline', this.inline);
    this.container.classList.toggle('diff-inline', this.inline);
  }

  renderToolbar() {
    this.toolbar.replaceChildren();
    const actions = Array.isArray(this.input.actions) ? this.input.actions : [];
    const label = h('span', { class: 'diff-title' }, this.input.title || posix.basename(this.path || '') || 'Diff');
    const btns = actions.map(a => {
      const b = h('button', { class: 'monaco-button secondary diff-action', type: 'button', title: a.label }, a.icon ? codicon(a.icon) : null, h('span', {}, a.label));
      b.addEventListener('click', async () => { try { await a.run?.(this); } catch (err) { notify.error(String(err?.message || err), { source: 'Diff' }); } });
      return b;
    });
    this.toolbar.append(label, h('span', { class: 'diff-spacer' }), ...btns);
    this.toolbar.classList.toggle('hidden', !btns.length && !this.editable);
    if (this.editable) this.toolbar.append(h('span', { class: 'diff-hint' }, 'Edits to the right side are saved to the file'));
  }

  updateDirty() {
    if (!this.editable) return;
    const d = !this.modifiedView.state.doc.eq(this.savedDoc);
    if (d !== this.dirty) { this.dirty = d; this.api.setDirty(d); }
  }

  get changeCount() { try { return getChunks(this.modifiedView.state)?.chunks.length || 0; } catch { return 0; } }
  nextChange() { const v = this.modifiedView; if (v) { goToNextChunk(v); v.focus(); } }
  previousChange() { const v = this.modifiedView; if (v) { goToPreviousChunk(v); v.focus(); } }
  toggleInline() {
    const mod = this.modifiedView.state.doc.toString();
    const orig = this.merge ? this.merge.a.state.doc.toString() : String(this.input.original ?? '');
    this.inline = !this.inline;
    this.build(orig, mod);
    this.updateDirty();
    loadSupport(this.lang).then(s => { if (s && !this.disposed) this.reconfigureAll(this.langComp, s); });
  }

  isDirty() { return this.dirty; }
  async save() {
    if (!this.editable || !this.dirty) return true;
    const doc = this.modifiedView.state.doc;
    try { await workspace.fs.writeText(this.path, doc.toString(), { source: 'editor' }); }
    catch (err) { notify.error(`Failed to save '${posix.basename(this.path)}': ${err.message || err}`, { source: 'Diff' }); return false; }
    this.savedDoc = doc;
    this.updateDirty();
    queueBackgroundLint([this.path]);
    bus.emit('editor:saved', { path: this.path });
    return true;
  }
  focus() { this.modifiedView?.focus(); }
  onShow() { for (const v of this.views()) v.requestMeasure(); }
  getText() { return this.modifiedView.state.doc.toString(); }
  setInput(input) { this.input = { ...this.input, ...input }; this.path = input.path || this.path; this.renderToolbar(); }
  dispose() {
    this.disposed = true;
    for (const off of this.offs) off();
    this.merge?.destroy(); this.unified?.destroy();
  }
}

export function createDiffEditor(input, container, api) { return new DiffEditor(input, container, api); }
