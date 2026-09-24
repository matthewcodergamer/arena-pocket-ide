// Editor commands (VS Code ids), editor title menus and the "Change Language Mode" picker.

import { commands as C, language as L, search as SR } from './cm.js';
import { commands, keybindingLabel } from '../core/commands.js';
import { menus } from '../core/menus.js';
import { settings } from '../core/settings.js';
import { workspace } from '../core/workspace.js';
import { posix } from '../core/path.js';
import { isApple, isTouch, isEditableTarget, copyText } from '../core/dom.js';
import { notify } from '../platform/notifications.js';
import { quickInput } from '../platform/quickinput.js';
import { editors } from '../workbench/editors.js';
import { openFind } from './findWidget.js';
import { selectHighlights, changeAll, duplicateSelection, convertIndentation, trimTrailingWhitespace } from './ops.js';
import { allLanguages, detectLanguage } from './languages.js';
import { languageOverride, setLanguageOverride, activeInner, activeHost, activeCode, activeView } from './registry.js';
import { gotoMarker } from './markerWidget.js';
import { navigateBack, navigateForward, canGoBack, canGoForward } from './navigation.js';
import { getFontZoom, setFontZoom } from './codeEditor.js';
import { formatText } from './format.js';
import { lintAndPublish } from './lint.js';

/** Editor keybindings fire from the workbench only when focus isn't in some other text field. */
function focusOk() {
  const el = document.activeElement;
  if (!el || el === document.body || el.closest?.('.cm-editor')) return true;
  if (!isEditableTarget(el)) return true;
  // While a key is being dispatched, never take keys away from other text fields (quick input, chat, terminal…).
  if (window.event?.type === 'keydown') return false;
  // The Command Palette and menus still list editor commands while their own input has focus.
  return !!el.closest?.('#quick-input-widget, .context-view-layer');
}
const hasView = () => !!activeView();
const kbWhen = () => hasView() && focusOk();
const withView = fn => (...args) => {
  const v = activeView();
  if (!v) return false;
  const r = fn(v, ...args);
  const el = document.activeElement;
  if (!v.dom.contains(el) && !el?.closest?.('#quick-input-widget')) v.focus();
  return r;
};

function selectedText(view) {
  const { state } = view;
  const ranges = state.selection.ranges;
  if (ranges.every(r => r.empty)) {
    // VS Code: copying with an empty selection copies the whole line(s).
    const seen = new Set(); const lines = [];
    for (const r of ranges) { const l = state.doc.lineAt(r.head); if (!seen.has(l.number)) { seen.add(l.number); lines.push(l); } }
    return { text: lines.map(l => l.text).join(state.lineBreak) + state.lineBreak, linewise: true, lines };
  }
  return { text: ranges.filter(r => !r.empty).map(r => state.sliceDoc(r.from, r.to)).join(state.lineBreak), linewise: false };
}

async function clipboardCopy(cut) {
  const view = activeView();
  if (!view) return false;
  const sel = selectedText(view);
  const ok = await copyText(sel.text);
  if (!ok) { notify.info(`Copying is blocked by the browser here. Use ${keybindingLabel(cut ? 'Mod+X' : 'Mod+C')}, or touch and hold the selection and choose ${cut ? 'Cut' : 'Copy'}.`, { source: 'Editor' }); return false; }
  if (cut && !view.state.readOnly) {
    if (sel.linewise) {
      const changes = sel.lines.map(l => ({ from: l.from, to: Math.min(view.state.doc.length, l.to + 1) }));
      view.dispatch({ changes, userEvent: 'delete.cut', scrollIntoView: true });
    } else view.dispatch(view.state.replaceSelection(''), { userEvent: 'delete.cut', scrollIntoView: true });
  }
  view.focus();
  return true;
}

async function clipboardPaste() {
  const view = activeView();
  if (!view || view.state.readOnly) return false;
  let text = null;
  try { text = await navigator.clipboard.readText(); } catch {}
  if (text == null) {
    notify.info(`Paste is blocked by the browser here. Use ${keybindingLabel('Mod+V')}, or touch and hold in the editor and choose Paste.`, { source: 'Editor' });
    return false;
  }
  view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true });
  view.focus();
  return true;
}

async function formatDocument(arg) {
  const path = typeof arg === 'string' ? arg : arg?.path;
  const ed = activeCode();
  if (ed && (!path || path === ed.path)) {
    try { await ed.format(); } catch {}
    return true;
  }
  const target = path || editors.activePath;
  if (!target || !workspace.fs?.isFile(target)) { notify.info('Open a text file to format it.', { source: 'Formatter' }); return false; }
  const text = await workspace.fs.readText(target);
  const lang = detectLanguage(target, text, languageOverride(target));
  try {
    const { text: out } = await formatText(text, lang, { tabSize: Number(settings.get('editor.tabSize')) || 4, insertSpaces: settings.get('editor.insertSpaces') !== false, path: target });
    if (out !== text) await workspace.fs.writeText(target, out, { source: 'format' });
    return true;
  } catch (err) {
    notify.warn(`Format Document failed for '${posix.basename(target)}': ${err.message}`, { source: 'Formatter' });
    return false;
  }
}

async function changeLanguageMode() {
  const ed = activeCode();
  if (!ed) { notify.info('Open a text editor to change its language mode.', { source: 'Editor' }); return; }
  const current = ed.lang;
  const override = languageOverride(ed.path);
  const items = [];
  items.push({ label: 'Auto Detect', description: override ? '' : '(current)', auto: true });
  items.push({ kind: 'separator', label: 'languages (identifier)' });
  for (const lang of allLanguages()) {
    items.push({ label: lang.name, description: `(${lang.id})${lang === current ? ' - Configured Language' : ''}`, lang, id: lang.id });
  }
  const picked = await quickInput.pick(items, { placeholder: 'Select Language Mode', matchOnDescription: true, activeItem: items.find(i => i.lang === current) });
  if (!picked) return;
  if (picked.auto) {
    await setLanguageOverride(ed.path, null);
    ed.setLanguage(detectLanguage(ed.path, ed.view.state.doc.sliceString(0, 200)));
  } else {
    await setLanguageOverride(ed.path, picked.lang.id);
    ed.setLanguage(picked.lang);
  }
  lintAndPublish(ed.path, ed.view.state.doc.toString(), ed.lang);
}

async function showMarkdownPreview(arg, toSide) {
  let path = typeof arg === 'string' ? arg : arg?.path;
  if (!path) {
    const input = editors.activeInput;
    path = input?.path;
    if (input?.type === 'markdown-preview') return true;
  }
  if (!path || !/\.(md|markdown|mdown|mkd|mdx)$/i.test(path)) {
    const ed = activeCode();
    if (!(ed && ed.lang.id === 'markdown' && (!path || path === ed.path))) { notify.info('Open a Markdown file to preview it.', { source: 'Markdown' }); return false; }
    path = ed.path;
  }
  await editors.open({ type: 'markdown-preview', path }, { pinned: true, focus: !toSide });
  return true;
}

function toggleSetting(key, a, b) { settings.set(key, settings.get(key) === a ? b : a); }

export function registerEditorCommands() {
  const def = (id, title, run, extra = {}) => ({ id, title, run, ...extra });
  commands.registerAll([
    def('undo', 'Undo', withView(C.undo), { keybinding: 'Mod+Z', when: kbWhen, icon: 'discard' }),
    def('redo', 'Redo', withView(C.redo), { keybinding: isApple ? 'Mod+Shift+Z' : ['Mod+Y', 'Mod+Shift+Z'], when: kbWhen, icon: 'redo' }),
    def('editor.action.clipboardCutAction', 'Cut', () => clipboardCopy(true), { when: hasView }),
    def('editor.action.clipboardCopyAction', 'Copy', () => clipboardCopy(false), { when: hasView }),
    def('editor.action.clipboardPasteAction', 'Paste', () => clipboardPaste(), { when: hasView }),
    def('editor.action.selectAll', 'Select All', withView(C.selectAll), { when: hasView }),
    def('actions.find', 'Find', withView(v => openFind(v)), { keybinding: 'Mod+F', when: kbWhen, icon: 'search' }),
    def('editor.action.startFindReplaceAction', 'Replace', withView(v => openFind(v, { replace: true })), { keybinding: isApple ? 'Mod+Alt+F' : 'Mod+H', when: kbWhen, icon: 'replace' }),
    def('editor.action.commentLine', 'Toggle Line Comment', withView(C.toggleComment), { keybinding: 'Mod+/', when: kbWhen }),
    def('editor.action.blockComment', 'Toggle Block Comment', withView(C.toggleBlockComment), { keybinding: 'Shift+Alt+A', when: kbWhen }),
    def('editor.action.formatDocument', 'Format Document', arg => formatDocument(arg), { keybinding: 'Shift+Alt+F', when: () => focusOk() && (!!activeCode() || !!editors.activePath), icon: 'wand' }),
    def('editor.action.addSelectionToNextFindMatch', 'Add Selection To Next Find Match', withView(SR.selectNextOccurrence), { keybinding: 'Mod+D', when: kbWhen }),
    def('editor.action.selectHighlights', 'Select All Occurrences of Find Match', withView(selectHighlights), { keybinding: 'Mod+Shift+L', when: kbWhen }),
    def('editor.action.changeAll', 'Change All Occurrences', withView(changeAll), { keybinding: 'Mod+F2', when: kbWhen }),
    def('editor.action.copyLinesUpAction', 'Copy Line Up', withView(C.copyLineUp), { keybinding: 'Shift+Alt+ArrowUp', when: kbWhen }),
    def('editor.action.copyLinesDownAction', 'Copy Line Down', withView(C.copyLineDown), { keybinding: 'Shift+Alt+ArrowDown', when: kbWhen }),
    def('editor.action.moveLinesUpAction', 'Move Line Up', withView(C.moveLineUp), { keybinding: 'Alt+ArrowUp', when: kbWhen }),
    def('editor.action.moveLinesDownAction', 'Move Line Down', withView(C.moveLineDown), { keybinding: 'Alt+ArrowDown', when: kbWhen }),
    def('editor.action.duplicateSelection', 'Duplicate Selection', withView(duplicateSelection), { when: hasView }),
    def('editor.action.insertCursorAbove', 'Add Cursor Above', withView(C.addCursorAbove), { keybinding: 'Mod+Alt+ArrowUp', when: kbWhen }),
    def('editor.action.insertCursorBelow', 'Add Cursor Below', withView(C.addCursorBelow), { keybinding: 'Mod+Alt+ArrowDown', when: kbWhen }),
    def('editor.action.deleteLines', 'Delete Line', withView(C.deleteLine), { keybinding: 'Mod+Shift+K', when: kbWhen }),
    def('editor.action.toggleWordWrap', 'Toggle Word Wrap', () => toggleSetting('editor.wordWrap', 'on', 'off'), { category: 'View', keybinding: 'Alt+Z', when: focusOk }),
    def('editor.action.toggleMinimap', 'Toggle Minimap', () => settings.set('editor.minimap.enabled', !settings.get('editor.minimap.enabled')), { category: 'View' }),
    def('editor.action.fontZoomIn', 'Editor Font Zoom In', () => setFontZoom(getFontZoom() + 1), { category: 'View' }),
    def('editor.action.fontZoomOut', 'Editor Font Zoom Out', () => setFontZoom(getFontZoom() - 1), { category: 'View' }),
    def('editor.action.fontZoomReset', 'Editor Font Zoom Reset', () => setFontZoom(0), { category: 'View' }),
    def('editor.fold', 'Fold', withView(L.foldCode), { keybinding: isApple ? 'Mod+Alt+[' : 'Mod+Shift+[', when: kbWhen }),
    def('editor.unfold', 'Unfold', withView(L.unfoldCode), { keybinding: isApple ? 'Mod+Alt+]' : 'Mod+Shift+]', when: kbWhen }),
    def('editor.foldAll', 'Fold All', withView(L.foldAll), { when: hasView }),
    def('editor.unfoldAll', 'Unfold All', withView(L.unfoldAll), { when: hasView }),
    def('workbench.action.editor.changeLanguageMode', 'Change Language Mode', () => changeLanguageMode(), { when: () => !!activeCode() }),
    def('editor.action.marker.next', 'Go to Next Problem (Error, Warning, Info)', () => gotoMarker(1), { keybinding: 'F8', when: focusOk }),
    def('editor.action.marker.prev', 'Go to Previous Problem (Error, Warning, Info)', () => gotoMarker(-1), { keybinding: 'Shift+F8', when: focusOk }),
    def('editor.action.trimTrailingWhitespace', 'Trim Trailing Whitespace', withView(trimTrailingWhitespace), { when: hasView }),
    def('editor.action.indentationToSpaces', 'Convert Indentation to Spaces', () => { const ed = activeCode(); if (!ed) return false; convertIndentation(ed.view, true); ed.setIndentation({ insertSpaces: true }); return true; }, { when: () => !!activeCode() }),
    def('editor.action.indentationToTabs', 'Convert Indentation to Tabs', () => { const ed = activeCode(); if (!ed) return false; convertIndentation(ed.view, false); ed.setIndentation({ insertSpaces: false }); return true; }, { when: () => !!activeCode() }),
    def('markdown.showPreview', 'Open Preview', arg => showMarkdownPreview(arg, false), { category: 'Markdown', keybinding: 'Mod+Shift+V', when: focusOk, icon: 'open-preview' }),
    def('markdown.showPreviewToSide', 'Open Preview to the Side', arg => showMarkdownPreview(arg, true), { category: 'Markdown', icon: 'open-preview' }),
    def('workbench.action.files.revert', 'Revert File', () => { const ed = activeCode(); return ed ? ed.revert() : false; }, { category: 'File', when: () => !!activeCode() }),
    def('editor.emmet.action.expandAbbreviation', 'Expand Abbreviation', async () => {
      const v = activeView(); if (!v) return false;
      const emmet = await import('../../vendor/cm-emmet.js').catch(() => null);
      if (!emmet) { notify.warn('Emmet could not be loaded.', { source: 'Emmet' }); return false; }
      const ok = emmet.expandAbbreviation(v);
      v.focus();
      return ok;
    }, { category: 'Emmet', when: hasView }),
    def('workbench.action.navigateBack', 'Go Back', () => navigateBack(), { keybinding: isApple ? 'Ctrl+-' : 'Alt+ArrowLeft', when: () => focusOk() && canGoBack(), icon: 'arrow-left' }),
    def('workbench.action.navigateForward', 'Go Forward', () => navigateForward(), { keybinding: isApple ? 'Ctrl+Shift+-' : 'Alt+ArrowRight', when: () => focusOk() && canGoForward(), icon: 'arrow-right' })
  ]);
  registerMenus();
}

const isFileInput = ctx => ctx?.type === 'file' && !!ctx.path;
const isMarkdownPath = p => /\.(md|markdown|mdown|mkd|mdx)$/i.test(p || '');
const codeActive = ctx => isFileInput(ctx) && activeInner()?.kind === 'code';

function registerMenus() {
  // Editor title (icons in the tab bar)
  menus.append('editor/title', { command: 'markdown.showPreviewToSide', title: 'Open Preview to the Side', icon: 'open-preview', group: 'navigation', order: 10, when: ctx => isFileInput(ctx) && isMarkdownPath(ctx.path) && activeInner()?.kind === 'code' });
  menus.append('editor/title', { title: 'Open Source', icon: 'go-to-file', group: 'navigation', order: 10, when: ctx => ctx?.type === 'markdown-preview', run: ctx => editors.open({ type: 'file', path: ctx.path }, { pinned: true }) });
  menus.append('editor/title', { title: 'Open as Text', icon: 'go-to-file', group: 'navigation', order: 11, when: ctx => isFileInput(ctx) && posix.ext(ctx.path) === '.svg' && activeHost()?.mode === 'image', run: () => activeHost()?.openAs('text') });
  menus.append('editor/title', { title: 'Open Preview', icon: 'open-preview', group: 'navigation', order: 11, when: ctx => isFileInput(ctx) && posix.ext(ctx.path) === '.svg' && activeHost()?.mode === 'text', run: () => activeHost()?.openAs('image') });
  menus.append('editor/title', { title: 'Previous Change', icon: 'arrow-up', group: 'navigation', order: 1, when: ctx => ctx?.type === 'diff', run: () => activeInner()?.previousChange?.() });
  menus.append('editor/title', { title: 'Next Change', icon: 'arrow-down', group: 'navigation', order: 2, when: ctx => ctx?.type === 'diff', run: () => activeInner()?.nextChange?.() });

  // Editor title "…" menu
  const more = [
    { command: 'actions.find', group: '1_find', order: 1, when: codeActive },
    { command: 'editor.action.startFindReplaceAction', group: '1_find', order: 2, when: codeActive },
    { command: 'workbench.action.gotoLine', title: 'Go to Line/Column…', group: '1_find', order: 3, when: codeActive },
    { command: 'workbench.action.gotoSymbol', title: 'Go to Symbol in Editor…', group: '1_find', order: 4, when: ctx => codeActive(ctx) && isTouch() },
    { command: 'editor.action.clipboardCutAction', group: '2_clipboard', order: 1, when: ctx => codeActive(ctx) && isTouch() },
    { command: 'editor.action.clipboardCopyAction', group: '2_clipboard', order: 2, when: ctx => codeActive(ctx) && isTouch() },
    { command: 'editor.action.clipboardPasteAction', group: '2_clipboard', order: 3, when: ctx => codeActive(ctx) && isTouch() },
    { command: 'editor.action.selectAll', group: '2_clipboard', order: 4, when: ctx => codeActive(ctx) && isTouch() },
    { command: 'editor.action.changeAll', group: '2_clipboard', order: 5, when: ctx => codeActive(ctx) && isTouch() },
    { command: 'editor.action.formatDocument', group: '3_format', order: 1, when: codeActive },
    { command: 'editor.action.commentLine', group: '3_format', order: 2, when: ctx => codeActive(ctx) && isTouch() },
    { command: 'editor.action.toggleWordWrap', title: 'Toggle Word Wrap', group: '4_view', order: 1, when: codeActive, checked: () => settings.get('editor.wordWrap') === 'on' },
    { command: 'editor.action.toggleMinimap', title: 'Toggle Minimap', group: '4_view', order: 2, when: codeActive, checked: () => settings.get('editor.minimap.enabled') === true },
    { command: 'workbench.action.editor.changeLanguageMode', title: 'Change Language Mode', group: '4_view', order: 3, when: codeActive },
    { command: 'markdown.showPreview', group: '4_view', order: 4, when: ctx => codeActive(ctx) && isMarkdownPath(ctx.path) },
    { command: 'workbench.files.action.showActiveFileInExplorer', title: 'Reveal in Explorer View', group: '5_file', order: 1, when: isFileInput },
    { command: 'copyFilePath', title: 'Copy Path', group: '5_file', order: 2, when: isFileInput },
    { command: 'workbench.action.files.revert', title: 'Revert File', group: '5_file', order: 3, when: codeActive },
    { command: 'workbench.action.showCommands', title: 'Command Palette…', group: '6_palette', order: 1, when: ctx => codeActive(ctx) && isTouch() },
    { title: 'Toggle Inline View', group: '1_diff', order: 1, when: ctx => ctx?.type === 'diff', checked: () => !!activeInner()?.inline, run: () => activeInner()?.toggleInline?.() },
    { title: 'Next Change', group: '1_diff', order: 2, when: ctx => ctx?.type === 'diff', run: () => activeInner()?.nextChange?.() },
    { title: 'Previous Change', group: '1_diff', order: 3, when: ctx => ctx?.type === 'diff', run: () => activeInner()?.previousChange?.() },
    { title: 'Zoom In', group: '1_image', order: 1, when: () => activeInner()?.kind === 'image', run: () => activeInner()?.zoomStep(1) },
    { title: 'Zoom Out', group: '1_image', order: 2, when: () => activeInner()?.kind === 'image', run: () => activeInner()?.zoomStep(-1) },
    { title: 'Whole Image', group: '1_image', order: 3, when: () => activeInner()?.kind === 'image', run: () => activeInner()?.setScale('fit') }
  ];
  for (const item of more) menus.append('editor/title/more', item);
}

