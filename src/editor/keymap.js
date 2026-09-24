// VS Code keyboard shortcuts for the CodeMirror editor (layered over CodeMirror's default keymaps).

import { commands as C, search as SR, language as L, autocomplete as AC, lint as LI, view as V, state as S } from './cm.js';
import { commands as workbench } from '../core/commands.js';
import { isApple } from '../core/dom.js';
import { openFind, findNextMatch, isFindOpen } from './findWidget.js';
import { insertIndent, outdent, insertLineAbove, selectHighlights, changeAll } from './ops.js';

const { keymap } = V;
const { Prec } = S;
const run = id => () => { workbench.execute(id).catch(() => {}); return true; };

/** High-precedence VS Code bindings (run before CodeMirror's defaults). */
export function vscodeKeymap() {
  const bindings = [
    { key: 'Mod-f', run: v => openFind(v), scope: 'editor search-panel', preventDefault: true },
    { key: isApple ? 'Mod-Alt-f' : 'Mod-h', run: v => openFind(v, { replace: true }), scope: 'editor search-panel', preventDefault: true },
    { key: 'F3', run: v => findNextMatch(v, 1), shift: v => findNextMatch(v, -1), scope: 'editor search-panel', preventDefault: true },
    ...(isApple ? [{ key: 'Mod-g', run: v => findNextMatch(v, 1), shift: v => findNextMatch(v, -1), scope: 'editor search-panel', preventDefault: true }] : []),
    { key: 'Escape', run: v => { if (isFindOpen(v)) { SR.closeSearchPanel(v); return true; } return false; } },
    { key: 'Mod-d', run: SR.selectNextOccurrence, preventDefault: true },
    { key: 'Mod-Shift-l', run: selectHighlights, preventDefault: true },
    { key: 'Mod-F2', run: changeAll, preventDefault: true },
    { key: 'Alt-ArrowUp', run: C.moveLineUp },
    { key: 'Alt-ArrowDown', run: C.moveLineDown },
    { key: 'Shift-Alt-ArrowUp', run: C.copyLineUp },
    { key: 'Shift-Alt-ArrowDown', run: C.copyLineDown },
    { key: 'Mod-/', run: C.toggleComment, preventDefault: true },
    { key: 'Shift-Alt-a', run: C.toggleBlockComment, preventDefault: true },
    { key: 'Mod-Shift-k', run: C.deleteLine, preventDefault: true },
    { key: 'Mod-Enter', run: C.insertBlankLine, preventDefault: true },
    { key: 'Mod-Shift-Enter', run: insertLineAbove, preventDefault: true },
    { key: 'Mod-]', run: C.indentMore, preventDefault: true },
    { key: 'Mod-[', run: C.indentLess, preventDefault: true },
    { key: 'Mod-Shift-\\', run: C.cursorMatchingBracket, shift: C.selectMatchingBracket, preventDefault: true },
    { key: 'Mod-l', run: C.selectLine, preventDefault: true },
    { key: 'Mod-i', run: AC.startCompletion, preventDefault: true },
    { key: 'Ctrl-Space', run: AC.startCompletion, preventDefault: true },
    { key: 'Mod-Alt-ArrowUp', run: C.addCursorAbove, preventDefault: true },
    { key: 'Mod-Alt-ArrowDown', run: C.addCursorBelow, preventDefault: true },
    { key: isApple ? 'Mod-Alt-[' : 'Mod-Shift-[', run: L.foldCode, preventDefault: true },
    { key: isApple ? 'Mod-Alt-]' : 'Mod-Shift-]', run: L.unfoldCode, preventDefault: true },
    { key: 'Alt-z', run: run('editor.action.toggleWordWrap'), preventDefault: true },
    { key: 'Shift-Alt-f', run: run('editor.action.formatDocument'), preventDefault: true },
    { key: 'F8', run: run('editor.action.marker.next'), preventDefault: true },
    { key: 'Shift-F8', run: run('editor.action.marker.prev'), preventDefault: true }
  ];
  return Prec.high(keymap.of(bindings));
}

/** Tab / Shift+Tab (lowest priority: completion, snippets and Emmet get Tab first). */
export const tabKeymap = keymap.of([
  { key: 'Tab', run: insertIndent, shift: outdent }
]);

/** Accept the focused suggestion with Tab (VS Code). */
export const acceptSuggestionWithTab = Prec.high(keymap.of([{ key: 'Tab', run: AC.acceptCompletion }]));

/** CodeMirror's standard keymaps, minus bindings VS Code doesn't have. */
export function baseKeymap() {
  return keymap.of([
    ...AC.closeBracketsKeymap,
    ...C.defaultKeymap.filter(b => !['Mod-i', 'Ctrl-m', 'Shift-Mod-m'].includes(b.key) && (isApple || !['Alt-ArrowLeft', 'Alt-ArrowRight'].includes(b.key))),
    ...C.historyKeymap,
    ...L.foldKeymap,
    ...AC.completionKeymap,
    ...LI.lintKeymap.filter(b => b.key !== 'F8' && b.key !== 'Mod-Shift-m')
  ]);
}
