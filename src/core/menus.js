// Menu contribution registry (VS Code "menus" model).
//
//   menus.append('menubar/file', { command: 'workbench.action.files.save', group: '4_save', order: 1 })
//   menus.append('menubar', { submenu: 'menubar/file', title: '&File', group: '1', order: 1 })
//   menus.append('editor/title', { command: 'xcoder.preview.run', group: 'navigation', order: 1, when: input => … })
//
// Item fields: command (id) | submenu (menu id) | run (fn) ; title (overrides command title), icon (codicon),
// group ('navigation' first, then sorted lexicographically; groups are separated), order, when(ctx) → bool,
// checked(ctx) → bool, args (array passed to the command).
//
// Menu ids used by X Coder:
//   menubar, menubar/file, menubar/edit, menubar/selection, menubar/view, menubar/go, menubar/run,
//   menubar/terminal, menubar/help, menubar/file/recent, menubar/view/appearance
//   accounts, manage (gear), editor/title (icons in the tab bar; ctx = active editor input),
//   editor/title/more, editor/tab/context (ctx = input), editor/context (ctx = {path}),
//   explorer/context (ctx = {path, type}), scm/title, view/title/<viewId>, chat/title, commandCenter

import { commands, keybindingLabel } from './commands.js';

const contributions = new Map();

export const menus = {
  append(menuId, item) {
    if (!contributions.has(menuId)) contributions.set(menuId, []);
    const entry = { group: 'z_other', order: 100, ...item };
    contributions.get(menuId).push(entry);
    return () => {
      const list = contributions.get(menuId);
      const i = list?.indexOf(entry); if (i >= 0) list.splice(i, 1);
    };
  },
  appendMany(menuId, items) { const ds = items.map(i => this.append(menuId, i)); return () => ds.forEach(d => d()); },
  raw(menuId) { return [...(contributions.get(menuId) || [])]; },

  /**
   * Resolves a menu to context-menu items: [{label, icon, keybinding, checked, disabled, run, submenu}, {separator:true}, …]
   * Hidden entries (when() false, missing command) are dropped.
   */
  resolve(menuId, ctx) {
    const items = (contributions.get(menuId) || []).filter(item => {
      try { if (item.when && !item.when(ctx)) return false; } catch { return false; }
      if (item.command && !commands.has(item.command)) return false;
      if (item.submenu && !this.resolve(item.submenu, ctx).length) return false;
      return true;
    });
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group).push(item);
    }
    const names = [...groups.keys()].sort((a, b) => (a === 'navigation' ? -1 : b === 'navigation' ? 1 : a.localeCompare(b)));
    const out = [];
    for (const name of names) {
      const list = groups.get(name).sort((a, b) => a.order - b.order);
      if (out.length) out.push({ separator: true });
      for (const item of list) out.push(this.toMenuItem(item, ctx));
    }
    return out;
  },

  toMenuItem(item, ctx) {
    const cmd = item.command ? commands.get(item.command) : null;
    const title = (item.title || cmd?.title || item.submenu || '').replace(/&(?=\w)/g, '');
    let checked = false;
    try { checked = item.checked ? !!item.checked(ctx) : false; } catch {}
    let disabled = false;
    try { disabled = item.enabled ? !item.enabled(ctx) : (cmd ? !commands.isEnabled(cmd.id) : false); } catch {}
    return {
      label: title,
      icon: item.icon || cmd?.icon || null,
      keybinding: cmd?.keybinding ? keybindingLabel(cmd.keybinding) : '',
      checked, disabled,
      submenu: item.submenu ? () => this.resolve(item.submenu, ctx) : null,
      run: item.run ? () => item.run(ctx) : (cmd ? () => commands.execute(cmd.id, ...(item.args || (ctx !== undefined ? [ctx] : []))) : null)
    };
  }
};
