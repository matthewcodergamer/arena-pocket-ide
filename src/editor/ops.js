// Editor operations shared by the VS Code keymap, the workbench commands and the accessory bar.

import { commands as C, state as S, search as SR, language as L } from './cm.js';

const { EditorSelection, countColumn } = S;
const { getIndentUnit } = L;

/** Tab: indent selected lines, otherwise insert spaces (or a tab) up to the next tab stop — VS Code behavior. */
export function insertIndent(view) {
  const { state } = view;
  if (state.readOnly) return false;
  if (state.selection.ranges.some(r => !r.empty && state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to).number)) return C.indentMore(view);
  const unit = getIndentUnit(state);
  const useTabs = state.facet(L.indentUnit).includes('\t');
  const changes = state.changeByRange(range => {
    const line = state.doc.lineAt(range.from);
    let insert;
    if (useTabs) insert = '\t';
    else {
      const col = countColumn(line.text.slice(0, range.from - line.from), state.tabSize);
      insert = ' '.repeat(unit - (col % unit) || unit);
    }
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.indent' }));
  return true;
}
export const outdent = view => C.indentLess(view);

/** Ctrl/Cmd+Shift+Enter: insert a line above the cursor line(s). */
export function insertLineAbove(view) {
  const { state } = view;
  if (state.readOnly) return false;
  const changes = state.changeByRange(range => {
    const line = state.doc.lineAt(range.head);
    const indent = /^[ \t]*/.exec(line.text)[0];
    return { changes: { from: line.from, insert: indent + state.lineBreak }, range: EditorSelection.cursor(line.from + indent.length) };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }));
  return true;
}

/** Duplicate Selection: duplicates selected text, or the line when the selection is empty. */
export function duplicateSelection(view) {
  const { state } = view;
  if (state.readOnly) return false;
  if (state.selection.ranges.every(r => r.empty)) return C.copyLineDown(view);
  const changes = state.changeByRange(range => {
    if (range.empty) return { range };
    const text = state.sliceDoc(range.from, range.to);
    return { changes: { from: range.to, insert: text }, range: EditorSelection.range(range.to, range.to + text.length) };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.copyline' }));
  return true;
}

/** Select All Occurrences (Mod+Shift+L) — uses the word at the cursor when nothing is selected. */
export function selectHighlights(view) {
  const { state } = view;
  const main = state.selection.main;
  if (main.empty) {
    const word = state.wordAt(main.head);
    if (!word) return false;
    view.dispatch({ selection: EditorSelection.single(word.from, word.to) });
  }
  return SR.selectSelectionMatches(view);
}
export const changeAll = selectHighlights;
export const addNextOccurrence = view => SR.selectNextOccurrence(view);

/** Converts leading indentation to spaces or tabs. */
export function convertIndentation(view, toSpaces) {
  const { state } = view;
  const tab = state.tabSize;
  const changes = [];
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    const ws = /^[ \t]*/.exec(line.text)[0];
    if (!ws) continue;
    const width = countColumn(ws, tab);
    const next = toSpaces ? ' '.repeat(width) : '\t'.repeat(Math.floor(width / tab)) + ' '.repeat(width % tab);
    if (next !== ws) changes.push({ from: line.from, to: line.from + ws.length, insert: next });
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'input.indent' });
  return true;
}

export function trimTrailingWhitespace(view) { return C.deleteTrailingWhitespace(view); }

/** 1-based line/column → document offset (clamped). */
export function posOf(doc, line, col = 1) {
  const l = doc.line(Math.max(1, Math.min(doc.lines, Math.floor(Number(line) || 1))));
  return l.from + Math.max(0, Math.min(l.length, Math.floor(Number(col) || 1) - 1));
}
