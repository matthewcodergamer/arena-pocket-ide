// Editor API used by other features (chat, search, SCM…). Implemented by the Editor feature (src/editor/).
// STUB — replaced by the editor implementation. Keep every export name and signature.
import { escapeHtml } from '../core/dom.js';
import { languageNameFor } from '../workbench/icons.js';
import { editors } from '../workbench/editors.js';

export const codeEditor = {
  /** Active code editor wrapper or null:
   *  { path, view, getText(), getSelectionText(), getSelection() → {from,to,startLine,startCol,endLine,endCol,text},
   *    insertText(text), replaceSelection(text), revealLine(line, col?), focus() } */
  getActive() { return null; },
  /** Static syntax highlighting → HTML using tok-* classes. `lang` is a language name, alias or file path. */
  async highlightCode(code, lang = '') { return escapeHtml(code); },
  languageLabel(path) { return languageNameFor(path); },
  /** Formats the active (or given) file. */
  async formatDocument(path) { throw new Error('Formatting is not available'); },
  /** Opens a side-by-side/inline diff editor. opts: { id, title, path, original, modified, readOnly, actions:[{label, icon, run}] } */
  openDiff(opts) { return editors.open({ type: 'diff', ...opts }, { pinned: true }); }
};
