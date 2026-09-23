// Editor API used by other features (chat, search, SCM…). Implemented by the Editor feature (src/editor/).
import { editors } from '../workbench/editors.js';
import { workspace } from '../core/workspace.js';
import { detectLanguage, languageLabel as labelFor, languageByAlias } from './languages.js';
import { highlightCode as highlight } from './highlight.js';
import { languageOverride, textEditorFor, editorEvents, activeInner } from './registry.js';
import { posOf } from './ops.js';

function activeWithView() {
  const inner = activeInner();
  return inner?.view && !inner.view.destroyed ? inner : null;
}

function wrap(inner) {
  const view = inner.view;
  const selection = () => {
    const { state } = view;
    const r = state.selection.main;
    const a = state.doc.lineAt(r.from), b = state.doc.lineAt(r.to);
    return { from: r.from, to: r.to, startLine: a.number, startCol: r.from - a.from + 1, endLine: b.number, endCol: r.to - b.from + 1, text: state.sliceDoc(r.from, r.to) };
  };
  const replace = text => {
    if (view.state.readOnly) return false;
    view.dispatch(view.state.replaceSelection(String(text ?? '')), { userEvent: 'input', scrollIntoView: true });
    return true;
  };
  return {
    path: inner.path || null,
    view,
    language: inner.lang?.id || null,
    getText: () => (inner.getText ? inner.getText() : view.state.doc.toString()),
    getSelectionText: () => selection().text,
    getSelection: selection,
    insertText: replace,
    replaceSelection: replace,
    revealLine(line, col = 1) {
      if (inner.reveal) inner.reveal({ line, col, flash: true });
      else view.dispatch({ selection: { anchor: posOf(view.state.doc, line, col) }, scrollIntoView: true });
    },
    focus: () => view.focus()
  };
}

export const codeEditor = {
  /** Active code editor wrapper or null:
   *  { path, view, getText(), getSelectionText(), getSelection() → {from,to,startLine,startCol,endLine,endCol,text},
   *    insertText(text), replaceSelection(text), revealLine(line, col?), focus() } */
  getActive() {
    const inner = activeWithView();
    return inner ? wrap(inner) : null;
  },
  /** Static syntax highlighting → HTML using tok-* classes. `lang` is a language name, alias or file path. */
  async highlightCode(code, lang = '') { return highlight(code, lang); },
  languageLabel(path) {
    const text = workspace.fs?.peekText(path)?.slice(0, 200) ?? '';
    return labelFor(path, detectLanguage(path, text, languageOverride(path)));
  },
  /** Formats the active (or given) file. */
  async formatDocument(path) {
    const { commands } = await import('../core/commands.js');
    return commands.execute('editor.action.formatDocument', path ? { path } : undefined);
  },
  /** Opens a side-by-side/inline diff editor. opts: { id, title, path, original, modified, readOnly, actions:[{label, icon, run}] } */
  openDiff(opts) { return editors.open({ type: 'diff', ...opts }, { pinned: true }); },

  // ---- extras ----
  /** Current text of a file: the open editor's (possibly unsaved) content, else the stored file. */
  getText(path) { const ed = textEditorFor(path); return ed ? ed.getText() : (workspace.fs?.peekText(path) ?? null); },
  /** Whether a file has unsaved editor changes. */
  isDirty(path) { return !!textEditorFor(path)?.dirty; },
  /** VS Code language id for a path or fenced-code alias ('javascript', 'python', …). */
  languageId(pathOrAlias) { return (pathOrAlias?.includes?.('.') || pathOrAlias?.includes?.('/') ? detectLanguage(pathOrAlias, '', languageOverride(pathOrAlias)) : languageByAlias(pathOrAlias)).id; },
  /** Subscribe to live content changes of open editors: fn(path). Returns a disposer. */
  onDidChangeContent(fn) { return editorEvents.on('change', path => fn(path)); }
};
