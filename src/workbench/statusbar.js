// Status Bar items (VS Code API shape).
//
//   const item = statusbar.add({ id: 'editor.selection', alignment: 'right', priority: 100,
//     text: 'Ln 1, Col 1', tooltip: 'Go to Line/Column', command: 'workbench.action.gotoLine',
//     kind: undefined | 'remote' | 'error' | 'warning' | 'prominent', hideOnPhone: false })
//   item.update({ text: '$(sync~spin) Syncing…' })  item.hide()  item.show()  item.dispose()
// Text supports $(codicon) syntax. Higher priority = further left (both sides), like VS Code.

import { $, h, renderLabelWithIcons } from '../core/dom.js';
import { commands } from '../core/commands.js';

const items = new Map();
let scheduled = false;

export const statusbar = {
  add(def) {
    const item = { alignment: 'left', priority: 0, visible: true, ...def };
    const api = {
      id: item.id,
      update(patch) { Object.assign(item, patch); schedule(); return api; },
      show() { item.visible = true; schedule(); return api; },
      hide() { item.visible = false; schedule(); return api; },
      dispose() { items.delete(item.id); schedule(); },
      get element() { return $(`#statusbar [data-id="${CSS.escape(item.id)}"]`); }
    };
    items.set(item.id, item);
    schedule();
    return api;
  },
  get(id) { return items.get(id); }
};

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; render(); });
}

function render() {
  const bar = $('#statusbar');
  if (!bar) return;
  const left = h('div', { class: 'left-items items-container' });
  const right = h('div', { class: 'right-items items-container' });
  const list = [...items.values()].filter(i => i.visible && (i.text || i.icon)).sort((a, b) => b.priority - a.priority);
  for (const it of list) {
    const cls = ['statusbar-item', it.kind && `${it.kind}-kind`, it.hideOnPhone && 'hide-on-phone', it.className, (it.command || it.run) && 'has-command'];
    const label = h('a', { class: 'statusbar-item-label', role: it.command || it.run ? 'button' : null, tabindex: it.command || it.run ? '0' : '-1', 'aria-label': it.ariaLabel || stripIcons(it.text), html: renderLabelWithIcons(it.text || '') });
    const el = h('div', { class: cls, 'data-id': it.id, title: it.tooltip || '' }, label);
    if (it.command || it.run) {
      const invoke = () => {
        if (it.run) it.run(el);
        else if (typeof it.command === 'string') commands.execute(it.command);
        else if (it.command?.id) commands.execute(it.command.id, ...(it.command.args || []));
      };
      label.addEventListener('click', invoke);
      label.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); invoke(); } });
    }
    (it.alignment === 'right' ? right : left).append(el);
  }
  bar.replaceChildren(left, right);
}

function stripIcons(text = '') { return String(text).replace(/\$\([^)]+\)/g, '').trim(); }
