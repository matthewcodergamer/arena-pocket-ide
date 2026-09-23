// Command registry + keybindings (VS Code model).
//
//   commands.register({
//     id: 'workbench.action.files.save', title: 'Save', category: 'File', icon: 'save',
//     keybinding: 'Mod+S',            // Mod = ⌘ on Apple devices, Ctrl elsewhere. Multiple: ['F1', 'Mod+Shift+P']
//     when: () => boolean,            // optional precondition (hidden from palette + keybinding ignored when false)
//     palette: true,                  // show in the Command Palette (default true)
//     allowInInput: false,            // fire the keybinding even while typing in an <input>/<textarea>
//     run: async (...args) => {}
//   })
//   commands.execute('workbench.action.files.save')
//
// Editor-owned keys (Mod+Z, Mod+F, Tab…) are handled inside CodeMirror; workbench keybindings
// only fire when the key isn't consumed there (CodeMirror calls preventDefault on handled keys).

import { isApple, isEditableTarget } from './dom.js';
import { bus } from './events.js';

const registry = new Map();
const keymap = new Map(); // normalized key → [commandId]
const recent = [];

function normalizeKey(spec) {
  const parts = spec.split('+').map(p => p.trim()).filter(Boolean);
  const key = parts.pop();
  const mods = new Set(parts.map(p => p.toLowerCase()));
  const out = [];
  const mod = mods.has('mod');
  if (mods.has('ctrl') || (mod && !isApple)) out.push('ctrl');
  if (mods.has('meta') || mods.has('cmd') || (mod && isApple)) out.push('meta');
  if (mods.has('alt') || mods.has('option')) out.push('alt');
  if (mods.has('shift')) out.push('shift');
  out.push(normalizeKeyName(key));
  return out.join('+');
}
function normalizeKeyName(key = '') {
  const k = key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  const aliases = { esc: 'escape', del: 'delete', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', space: ' ', plus: '+', backquote: '`', comma: ',', period: '.', slash: '/' };
  return aliases[k] || k;
}
function eventKey(e) {
  const out = [];
  if (e.ctrlKey) out.push('ctrl');
  if (e.metaKey) out.push('meta');
  if (e.altKey) out.push('alt');
  if (e.shiftKey) out.push('shift');
  let key = e.key;
  // With Alt on macOS, e.key is a special character; use the physical code instead.
  if (e.code?.startsWith('Key')) key = e.code.slice(3);
  else if (e.code?.startsWith('Digit')) key = e.code.slice(5);
  else if (e.code === 'Backquote') key = '`';
  else if (e.code === 'Comma') key = ',';
  else if (e.code === 'Period') key = '.';
  else if (e.code === 'Slash') key = '/';
  else if (e.code === 'Backslash') key = '\\';
  else if (e.code === 'BracketLeft') key = '[';
  else if (e.code === 'BracketRight') key = ']';
  else if (e.code === 'Equal') key = '=';
  else if (e.code === 'Minus') key = '-';
  out.push(normalizeKeyName(key));
  return out.join('+');
}

/** Human label for a keybinding spec: 'Mod+Shift+P' → '⇧⌘P' (Apple) / 'Ctrl+Shift+P'. */
export function keybindingLabel(spec) {
  if (!spec) return '';
  const first = Array.isArray(spec) ? spec[0] : spec;
  const parts = first.split('+').map(p => p.trim());
  const key = parts.pop();
  const mods = parts.map(p => p.toLowerCase());
  const keyName = ({ escape: 'Esc', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', enter: isApple ? '↩' : 'Enter', backspace: isApple ? '⌫' : 'Backspace', delete: isApple ? '⌦' : 'Delete', ' ': 'Space', '`': '`' })[key.toLowerCase()] || (key.length === 1 ? key.toUpperCase() : key);
  if (isApple) {
    let s = '';
    if (mods.includes('ctrl')) s += '⌃';
    if (mods.includes('alt') || mods.includes('option')) s += '⌥';
    if (mods.includes('shift')) s += '⇧';
    if (mods.includes('mod') || mods.includes('cmd') || mods.includes('meta')) s += '⌘';
    return s + keyName;
  }
  const names = [];
  if (mods.includes('mod') || mods.includes('ctrl')) names.push('Ctrl');
  if (mods.includes('meta')) names.push('Win');
  if (mods.includes('alt')) names.push('Alt');
  if (mods.includes('shift')) names.push('Shift');
  return [...names, keyName].join('+');
}

export const commands = {
  register(def) {
    if (!def?.id || typeof def.run !== 'function') throw new Error('Command needs id and run()');
    const cmd = { palette: true, ...def };
    registry.set(def.id, cmd);
    for (const kb of [def.keybinding].flat().filter(Boolean)) {
      const k = normalizeKey(kb);
      if (!keymap.has(k)) keymap.set(k, []);
      keymap.get(k).unshift(def.id);
    }
    return () => {
      registry.delete(def.id);
      for (const kb of [def.keybinding].flat().filter(Boolean)) {
        const list = keymap.get(normalizeKey(kb)); if (list) keymap.set(normalizeKey(kb), list.filter(id => id !== def.id));
      }
    };
  },
  /** Register many at once. Returns a combined disposer. */
  registerAll(defs) { const ds = defs.map(d => this.register(d)); return () => ds.forEach(d => d()); },
  get(id) { return registry.get(id); },
  has(id) { return registry.has(id); },
  all() { return [...registry.values()]; },
  isEnabled(id) { const c = registry.get(id); if (!c) return false; try { return !c.when || !!c.when(); } catch { return false; } },
  /** Commands shown in the palette (enabled, palette !== false), most recently used first. */
  paletteCommands() {
    const list = this.all().filter(c => c.palette !== false && c.title && this.isEnabled(c.id));
    return list.sort((a, b) => {
      const ra = recent.indexOf(a.id), rb = recent.indexOf(b.id);
      if (ra !== rb) return (ra < 0 ? 1e9 : ra) - (rb < 0 ? 1e9 : rb);
      return fullTitle(a).localeCompare(fullTitle(b));
    });
  },
  recentIds() { return [...recent]; },
  async execute(id, ...args) {
    const c = registry.get(id);
    if (!c) { console.warn(`[X Coder] command not found: ${id}`); return undefined; }
    if (c.title && c.palette !== false) {
      const i = recent.indexOf(id); if (i >= 0) recent.splice(i, 1);
      recent.unshift(id); if (recent.length > 30) recent.pop();
    }
    try { return await c.run(...args); }
    catch (err) {
      console.error(`[X Coder] command ${id} failed`, err);
      bus.emit('command:error', { id, error: err });
      throw err;
    }
  },
  keybindingFor(id) { return registry.get(id)?.keybinding || null; },
  keybindingLabel(id) { return keybindingLabel(this.keybindingFor(id)); }
};

export function fullTitle(cmd) { return cmd.category ? `${cmd.category}: ${cmd.title}` : cmd.title; }

let installed = false;
/** Global keydown dispatcher. Call once at startup. */
export function installKeybindings() {
  if (installed) return; installed = true;
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.isComposing) return;
    const ids = keymap.get(eventKey(e));
    if (!ids?.length) return;
    const typing = isEditableTarget(e.target);
    const inEditor = !!e.target?.closest?.('.cm-editor');
    for (const id of ids) {
      const c = registry.get(id);
      if (!c) continue;
      const hasMod = e.ctrlKey || e.metaKey || e.altKey || /^f\d+$/i.test(e.key) || e.key === 'Escape';
      if (typing && !inEditor && !c.allowInInput && !hasMod) continue;
      if (typing && !hasMod && !c.allowInInput) continue;
      if (!commands.isEnabled(id)) continue;
      e.preventDefault(); e.stopPropagation();
      commands.execute(id).catch(() => {});
      return;
    }
  }, false);
}
