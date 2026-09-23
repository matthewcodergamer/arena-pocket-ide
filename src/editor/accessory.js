// Mobile coding accessory bar: a VS Code–styled key strip directly above the iOS keyboard while a code
// editor has focus (Tab, Shift+Tab, arrows, symbols, Undo, Redo, Find, Toggle Comment, Format,
// Command Palette, Hide Keyboard). Buttons never take focus, so the keyboard stays up.

import { view as V, commands as C, state as S } from './cm.js';
import { h, codicon, isTouch } from '../core/dom.js';
import { settings } from '../core/settings.js';
import { bus } from '../core/events.js';
import { commands as workbench } from '../core/commands.js';
import { openFind } from './findWidget.js';

const { EditorView, runScopeHandlers } = V;
const { EditorSelection } = S;

const SYMBOLS = ['{', '}', '(', ')', '[', ']', '<', '>', '=', ';', ':', '"', "'", '`', '/', '\\', '|', '&', '!', '?', '$', '_', '-', '+', '*', '#', '%'];

function focusedEditor() {
  const el = document.activeElement;
  const root = el?.closest?.('#editor-container .cm-editor');
  if (!root) return null;
  const view = EditorView.findFromDOM(root);
  return view ? { view, input: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el : null } : null;
}

function key(view, keyName, shift = false) {
  const ev = new KeyboardEvent('keydown', { key: keyName, code: keyName, shiftKey: shift, bubbles: true, cancelable: true });
  return runScopeHandlers(view, ev, 'editor');
}

/** Types text the way the keyboard would (closeBrackets, auto-closing tags and completion all see it). */
function typeInto(view, text) {
  if (view.state.readOnly) return;
  const { from, to } = view.state.selection.main;
  const insert = () => view.state.update({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length), userEvent: 'input.type', scrollIntoView: true });
  for (const handler of view.state.facet(EditorView.inputHandler)) {
    try { if (handler(view, from, to, text, insert)) return; } catch {}
  }
  view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.type', scrollIntoView: true });
}

function typeIntoInput(input, text) {
  const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
  input.setRangeText(text, start, end, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function moveInInput(input, dir) {
  const pos = Math.max(0, Math.min(input.value.length, (dir < 0 ? input.selectionStart : input.selectionEnd) + dir));
  input.setSelectionRange(pos, pos);
}

const ACTIONS = [
  { id: 'tab', label: 'Tab', title: 'Tab (indent)', run: t => t.input ? null : (key(t.view, 'Tab') || C.indentMore(t.view)) },
  { id: 'outdent', label: '⇤', title: 'Shift+Tab (outdent)', run: t => t.input ? null : (key(t.view, 'Tab', true) || C.indentLess(t.view)) },
  { id: 'left', icon: 'arrow-left', title: 'Left', run: t => t.input ? moveInInput(t.input, -1) : key(t.view, 'ArrowLeft') },
  { id: 'up', icon: 'arrow-up', title: 'Up', run: t => t.input ? null : key(t.view, 'ArrowUp') },
  { id: 'down', icon: 'arrow-down', title: 'Down', run: t => t.input ? null : key(t.view, 'ArrowDown') },
  { id: 'right', icon: 'arrow-right', title: 'Right', run: t => t.input ? moveInInput(t.input, 1) : key(t.view, 'ArrowRight') },
  { sep: true },
  ...SYMBOLS.map(ch => ({ id: `sym-${ch}`, label: ch, title: `Type ${ch}`, symbol: true, run: t => t.input ? typeIntoInput(t.input, ch) : typeInto(t.view, ch) })),
  { sep: true },
  { id: 'undo', icon: 'discard', title: 'Undo', run: t => C.undo(t.view) },
  { id: 'redo', icon: 'redo', title: 'Redo', run: t => C.redo(t.view) },
  { id: 'find', icon: 'search', title: 'Find', run: t => openFind(t.view) },
  { id: 'comment', icon: 'comment', title: 'Toggle Line Comment', run: t => C.toggleComment(t.view) },
  { id: 'format', icon: 'wand', title: 'Format Document', run: () => workbench.execute('editor.action.formatDocument').catch(() => {}) },
  { id: 'palette', icon: 'terminal-cmd', title: 'Command Palette', run: () => workbench.execute('workbench.action.showCommands').catch(() => {}) },
  { id: 'hide', icon: 'chevron-down', title: 'Hide Keyboard', run: () => document.activeElement?.blur?.() }
];

let bar = null;
let hideTimer = 0;

function build() {
  const scroller = h('div', { class: 'accessory-scroller' });
  for (const a of ACTIONS) {
    if (a.sep) { scroller.append(h('span', { class: 'accessory-separator', 'aria-hidden': 'true' })); continue; }
    const b = h('button', { class: ['accessory-key', a.symbol && 'symbol', a.icon && 'icon-key'], type: 'button', tabindex: '-1', title: a.title, 'aria-label': a.title, 'data-key': a.id },
      a.icon ? codicon(a.icon) : a.label);
    let startX = 0, moved = false;
    b.addEventListener('pointerdown', e => { e.preventDefault(); startX = e.clientX; moved = false; b.classList.add('pressed'); });
    b.addEventListener('pointermove', e => { if (Math.abs(e.clientX - startX) > 8) { moved = true; b.classList.remove('pressed'); } });
    b.addEventListener('pointerleave', () => b.classList.remove('pressed'));
    b.addEventListener('pointercancel', () => b.classList.remove('pressed'));
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', e => {
      e.preventDefault();
      b.classList.remove('pressed');
      if (moved) return;
      const target = focusedEditor() || lastTarget;
      if (!target || target.view.destroyed) return;
      try { a.run(target); } catch (err) { console.error(err); }
      if (!target.input && a.id !== 'hide' && a.id !== 'palette' && a.id !== 'find') target.view.focus();
    });
    scroller.append(b);
  }
  bar = h('div', { id: 'editor-accessory-bar', class: 'accessory-bar hidden', role: 'toolbar', 'aria-label': 'Coding keys' }, scroller);
  const workbenchEl = document.getElementById('workbench');
  const status = document.getElementById('statusbar');
  if (workbenchEl && status) workbenchEl.insertBefore(bar, status); else (workbenchEl || document.body).append(bar);
}

let lastTarget = null;
function enabled() { return settings.get('editor.accessoryBar', isTouch()) !== false && isTouch(); }

function update() {
  clearTimeout(hideTimer);
  const t = focusedEditor();
  if (t) lastTarget = t;
  const overlay = document.getElementById('workbench')?.classList.contains('overlay-open');
  const show = !!t && enabled() && !overlay;
  if (show) { bar.classList.remove('hidden'); document.body.classList.add('accessory-bar-visible'); }
  else hideTimer = setTimeout(() => {
    if (focusedEditor() && enabled() && !document.getElementById('workbench')?.classList.contains('overlay-open')) return;
    bar.classList.add('hidden');
    document.body.classList.remove('accessory-bar-visible');
  }, 120);
}

export function initAccessoryBar() {
  if (bar) return;
  build();
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', () => setTimeout(update, 0));
  settings.onChange('editor.accessoryBar', update);
  bus.on('editor:activeChanged', () => setTimeout(update, 0));
  bus.on('layout:changed', () => setTimeout(update, 0));
}
export function isAccessoryBarVisible() { return !!bar && !bar.classList.contains('hidden'); }
