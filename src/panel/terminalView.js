// TERMINAL panel tab: hosts the active TerminalInstance, the '1: xsh' switcher, New Terminal (+),
// Kill (trash), Clear and the ••• menu (copy / paste / select all / run active file / run selection).

import { h, codicon, copyText } from '../core/dom.js';
import { commands } from '../core/commands.js';
import { layout } from '../workbench/layout.js';
import { panel } from '../workbench/panel.js';
import { showContextMenu } from '../platform/contextmenu.js';
import { notify } from '../platform/notifications.js';
import { terminals } from './terminal.js';

let container = null;
let emptyEl = null;

function selectionInTerminal() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !terminals.active?.el.contains(sel.anchorNode)) return '';
  return sel.toString();
}

async function pasteInto(inst) {
  if (!inst) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) { inst.focus(); inst.insertText(text); }
  } catch (err) {
    notify.warn(`The browser did not allow reading the clipboard (${err?.message || 'permission denied'}). Paste with the keyboard instead (⌘V / Ctrl+V).`, { source: 'Terminal' });
  }
}

function selectAll(inst) {
  if (!inst) return;
  const range = document.createRange();
  range.selectNodeContents(inst.rowsEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Items shared by the right-click menu and the panel's ••• menu. */
function menuItems(inst) {
  const selected = selectionInTerminal();
  return [
    { label: 'Copy', icon: 'copy', disabled: !selected, keybinding: 'Mod+C', run: () => copyText(selected) },
    { label: 'Paste', icon: 'clippy', disabled: !inst, keybinding: 'Mod+V', run: () => pasteInto(inst) },
    { label: 'Select All', disabled: !inst, run: () => selectAll(inst) },
    { separator: true },
    { label: 'Clear Terminal', run: () => commands.execute('workbench.action.terminal.clear') },
    { label: 'New Terminal', keybinding: 'Ctrl+Shift+`', run: () => commands.execute('workbench.action.terminal.new') },
    { label: 'Kill Terminal', disabled: !inst, run: () => commands.execute('workbench.action.terminal.kill') },
    { separator: true },
    { label: 'Run Active File', run: () => commands.execute('workbench.action.terminal.runActiveFile') },
    { label: 'Run Selected Text', run: () => commands.execute('workbench.action.terminal.runSelectedText') }
  ];
}

terminals.showContextMenu = (inst, pos) => showContextMenu(menuItems(inst), pos);

function mountActive() {
  if (!container) return;
  const inst = terminals.active;
  for (const el of [...container.children]) if (el !== emptyEl && el !== inst?.el) el.remove();
  if (inst) {
    if (inst.el.parentNode !== container) container.append(inst.el);
    emptyEl.classList.add('hidden');
    inst.onShow();
  } else emptyEl.classList.remove('hidden');
}

/** Switcher: a native <select> on desktop (VS Code look); a tappable label + menu on phones. */
function switcher() {
  if (!layout.isPhone) {
    const sel = h('select', { class: 'xc-select terminal-switcher', title: 'Open Terminals', 'aria-label': 'Open Terminals' });
    for (const t of terminals.list) sel.append(h('option', { value: String(t.id), selected: t === terminals.active }, terminals.labelOf(t)));
    sel.addEventListener('change', () => {
      const t = terminals.list.find(x => String(x.id) === sel.value);
      if (t) { terminals.setActive(t); t.focus(); }
    });
    return sel;
  }
  const label = terminals.active ? terminals.labelOf(terminals.active) : 'Terminal';
  const btn = h('a', { class: 'terminal-switcher-button', role: 'button', tabindex: '0', title: 'Open Terminals', 'aria-label': `Open Terminals: ${label}` },
    h('span', { class: 'label' }, label), codicon('chevron-down'));
  btn.addEventListener('click', () => {
    showContextMenu([
      ...terminals.list.map(t => ({ label: terminals.labelOf(t), checked: t === terminals.active, run: () => { terminals.setActive(t); t.focus({ gesture: true }); } })),
      { separator: true },
      { label: 'New Terminal', icon: 'add', run: () => commands.execute('workbench.action.terminal.new') }
    ], { anchor: btn, align: 'right' });
  });
  return btn;
}

export const terminalTab = {
  id: 'terminal',
  title: 'Terminal',
  order: 4,
  keybinding: 'Ctrl+`',
  render(host) {
    host.classList.add('terminal-panel');
    emptyEl = h('div', { class: 'terminal-empty view-message' },
      h('p', {}, 'No terminal is open.'),
      h('button', { class: 'monaco-button', type: 'button', onclick: () => commands.execute('workbench.action.terminal.new') }, codicon('add'), 'New Terminal'));
    container = h('div', { class: 'terminal-outer-container' }, emptyEl);
    host.append(container);
    terminals.ensure();
    mountActive();
    return {
      onShow: () => { if (!terminals.list.length) terminals.ensure(); else mountActive(); },
      onHide: () => {},
      focus: () => terminals.active?.focus()
    };
  },
  actions() {
    const list = [];
    if (terminals.list.length) list.push({ element: switcher() });
    list.push({ icon: 'add', title: 'New Terminal (Ctrl+Shift+`)', run: () => commands.execute('workbench.action.terminal.new') });
    if (!layout.isPhone) list.push({ icon: 'clear-all', title: 'Clear Terminal', run: () => commands.execute('workbench.action.terminal.clear') });
    list.push({ icon: 'trash', title: 'Kill Terminal', run: () => commands.execute('workbench.action.terminal.kill') });
    return list;
  },
  moreActions() { return menuItems(terminals.active); }
};

terminals.events.on('changed', ({ killed } = {}) => {
  mountActive();
  // Like VS Code: when the last terminal exits (exit / Kill), the panel hides.
  if (killed && !terminals.list.length && panel.isVisible('terminal')) { panel.close(); return; }
  if (panel.activeId === 'terminal') panel.refreshActions();
});
