// Editor status bar items (VS Code): Ln/Col (+ selection), indentation, encoding, end of line,
// language mode — and Image Preview's dimensions / size / zoom while an image is active.

import { statusbar } from '../workbench/statusbar.js';
import { bus } from '../core/events.js';
import { quickInput } from '../platform/quickinput.js';
import { notify } from '../platform/notifications.js';
import { editorEvents, activeInner, activeCode } from './registry.js';

let items = null;

function ensureItems() {
  if (items) return items;
  items = {
    selection: statusbar.add({ id: 'editor.selection', alignment: 'right', priority: 1000, text: '', tooltip: 'Go to Line/Column', command: 'workbench.action.gotoLine' }),
    indentation: statusbar.add({ id: 'editor.indentation', alignment: 'right', priority: 900, text: '', tooltip: 'Select Indentation', run: () => pickIndentation() }),
    encoding: statusbar.add({ id: 'editor.encoding', alignment: 'right', priority: 800, text: '', tooltip: 'Select Encoding', hideOnPhone: true, run: () => pickEncoding() }),
    eol: statusbar.add({ id: 'editor.eol', alignment: 'right', priority: 700, text: '', tooltip: 'Select End of Line Sequence', hideOnPhone: true, run: () => pickEol() }),
    mode: statusbar.add({ id: 'editor.mode', alignment: 'right', priority: 600, text: '', tooltip: 'Select Language Mode', command: 'workbench.action.editor.changeLanguageMode' }),
    imageDimensions: statusbar.add({ id: 'imagePreview.size', alignment: 'right', priority: 1000, text: '', tooltip: 'Image Size' }),
    imageSize: statusbar.add({ id: 'imagePreview.binarySize', alignment: 'right', priority: 990, text: '', tooltip: 'Image Binary Size', hideOnPhone: true }),
    imageZoom: statusbar.add({ id: 'imagePreview.zoom', alignment: 'right', priority: 980, text: '', tooltip: 'Select zoom level', run: () => activeInner()?.pickZoom?.() })
  };
  for (const it of Object.values(items)) it.hide();
  return items;
}

export function updateEditorStatus() {
  const it = ensureItems();
  const inner = activeInner();
  const code = inner?.kind === 'code' && !inner.disposed ? inner : null;
  const image = inner?.kind === 'image' ? inner : null;
  if (code) {
    const i = code.statusInfo();
    const sel = i.selected ? ` (${i.selected} selected)` : i.cursors > 1 ? ` (${i.cursors} selections)` : '';
    it.selection.update({ text: `Ln ${i.line}, Col ${i.col}${sel}` }).show();
    it.indentation.update({ text: i.insertSpaces ? `Spaces: ${i.tabSize}` : `Tab Size: ${i.tabSize}` }).show();
    it.encoding.update({ text: 'UTF-8' }).show();
    it.eol.update({ text: i.eol }).show();
    it.mode.update({ text: i.language, tooltip: 'Select Language Mode' }).show();
  } else {
    for (const k of ['selection', 'indentation', 'encoding', 'eol', 'mode']) it[k].hide();
  }
  if (image) {
    const i = image.statusInfo();
    it.imageDimensions.update({ text: i.dimensions }).show();
    it.imageSize.update({ text: i.size }).show();
    it.imageZoom.update({ text: i.zoom }).show();
  } else {
    for (const k of ['imageDimensions', 'imageSize', 'imageZoom']) it[k].hide();
  }
}

async function pickIndentation() {
  const ed = activeCode();
  if (!ed) return;
  const items = [
    { label: 'Indent Using Spaces', description: 'change view', id: 'spaces' },
    { label: 'Indent Using Tabs', description: 'change view', id: 'tabs' },
    { label: 'Change Tab Display Size', description: 'change view', id: 'size' },
    { label: 'Detect Indentation from Content', description: 'change view', id: 'detect' },
    { kind: 'separator', label: 'convert file' },
    { label: 'Convert Indentation to Spaces', description: 'convert file', id: 'toSpaces' },
    { label: 'Convert Indentation to Tabs', description: 'convert file', id: 'toTabs' }
  ];
  const picked = await quickInput.pick(items, { placeholder: 'Select Action' });
  if (!picked) return;
  const { convertIndentation } = await import('./ops.js');
  if (picked.id === 'spaces' || picked.id === 'tabs' || picked.id === 'size') {
    const size = await pickTabSize(ed.indent.tabSize, 'Select Tab Size for the Current File');
    if (size == null) return;
    ed.setIndentation({ tabSize: size, insertSpaces: picked.id === 'size' ? ed.indent.insertSpaces : picked.id === 'spaces' });
  } else if (picked.id === 'detect') {
    const { detectIndentation } = await import('./codeEditor.js');
    const { settings } = await import('../core/settings.js');
    ed.setIndentation(detectIndentation(ed.view.state.doc.toString(), { tabSize: Number(settings.get('editor.tabSize')) || 4, insertSpaces: settings.get('editor.insertSpaces') !== false }));
  } else if (picked.id === 'toSpaces') { convertIndentation(ed.view, true); ed.setIndentation({ insertSpaces: true }); }
  else if (picked.id === 'toTabs') { convertIndentation(ed.view, false); ed.setIndentation({ insertSpaces: false }); }
}

async function pickTabSize(current, title) {
  const items = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ label: String(n), description: n === current ? 'Configured Tab Size' : '', value: n }));
  const picked = await quickInput.pick(items, { placeholder: title, activeItem: items.find(i => i.value === current) });
  return picked?.value ?? null;
}

async function pickEncoding() {
  const picked = await quickInput.pick([
    { label: 'Reopen with Encoding', id: 'reopen' },
    { label: 'Save with Encoding', id: 'save' }
  ], { placeholder: 'Select Action' });
  if (!picked) return;
  const choice = await quickInput.pick([{ label: 'UTF-8', description: 'utf8 — current encoding' }], { placeholder: picked.id === 'reopen' ? 'Select File Encoding to Reopen File' : 'Select File Encoding to Save with' });
  if (choice) notify.info('X Coder stores every text file as UTF-8, so UTF-8 is the only available encoding.', { source: 'Editor' });
}

async function pickEol() {
  const ed = activeCode();
  if (!ed) return;
  const items = [{ label: 'LF', value: 'LF' }, { label: 'CRLF', value: 'CRLF' }];
  const picked = await quickInput.pick(items, { placeholder: 'Select End of Line Sequence', activeItem: items.find(i => i.value === ed.eol) });
  if (picked) ed.setEol(picked.value);
}

export function initEditorStatus() {
  ensureItems();
  bus.on('editor:activeChanged', () => updateEditorStatus());
  editorEvents.on('status', () => updateEditorStatus());
  editorEvents.on('language', () => updateEditorStatus());
  updateEditorStatus();
}
