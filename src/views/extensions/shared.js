// Shared helpers for the Extensions view and the extension editor.

import { h, codicon, copyText } from '../../core/dom.js';
import { settings } from '../../core/settings.js';
import { commands } from '../../core/commands.js';
import { notify } from '../../platform/notifications.js';
import { editors } from '../../workbench/editors.js';

export function openExtension(id, opts = {}) { return editors.open({ type: 'extension', id }, opts); }

/** { enabled, toggleable } — capabilities without a toggle setting are always enabled. */
export function extensionState(ext) {
  if (!ext.toggle) return { enabled: true, toggleable: false };
  const v = settings.get(ext.toggle);
  return { enabled: v === undefined ? true : !!v, toggleable: true };
}

export function setExtensionEnabled(ext, enabled) {
  if (!ext.toggle) return;
  settings.set(ext.toggle, !!enabled);
}

const matchesPrefix = (id, prefixes) => prefixes.some(p => (p.endsWith('.') ? id.startsWith(p) : id === p || id.startsWith(`${p}.`)));

export function extensionSettings(ext) { return settings.all().filter(s => matchesPrefix(s.key, ext.settings || [])); }
export function extensionCommands(ext) {
  return commands.all().filter(c => c.title && matchesPrefix(c.id, ext.commands || []))
    .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.title.localeCompare(b.title));
}

export function settingsQuery(ext) { return `@id:${(ext.settings || []).join(',')}`; }
export function openExtensionSettings(ext) { return commands.execute('workbench.action.openSettings', settingsQuery(ext)); }

/** The tinted square icon (VS Code shows the extension's logo here). */
export function iconTile(ext, size = 'small') {
  return h('div', { class: `extension-icon-tile ${size}`, style: { '--ext-tint': `var(--tok-${ext.tint || 'keyword'})` }, 'aria-hidden': 'true' }, codicon(ext.icon || 'extensions'));
}

export function manageMenu(ext, { fromEditor = false } = {}) {
  const state = extensionState(ext);
  const items = [];
  if (state.toggleable) items.push({ label: state.enabled ? 'Disable' : 'Enable', run: () => setExtensionEnabled(ext, !state.enabled) });
  else items.push({ label: 'Disable', disabled: true, tooltip: 'This capability is part of X Coder and cannot be disabled.' });
  items.push({ separator: true });
  if (!fromEditor) items.push({ label: 'Show Extension Details', run: () => openExtension(ext.id, { pinned: true }) });
  if (ext.settings?.length && extensionSettings(ext).length) items.push({ label: 'Settings', run: () => openExtensionSettings(ext) });
  if (extensionCommands(ext).some(c => c.keybinding)) items.push({ label: 'Keyboard Shortcuts', run: () => commands.execute('workbench.action.openGlobalKeybindings', ext.commands[0] || ext.name) });
  items.push({ separator: true });
  items.push({ label: 'Copy', run: async () => { if (await copyText(`Name: ${ext.name}\nId: ${ext.id}\nDescription: ${ext.description}\nVersion: ${document.documentElement.dataset.xcoderVersion || '6.0.0'}\nPublisher: X Coder (built-in)`)) notify.info('Copied extension information.', { source: 'Extensions' }); } });
  items.push({ label: 'Copy Extension ID', run: async () => { if (await copyText(ext.id)) notify.info(`Copied “${ext.id}”.`, { source: 'Extensions' }); } });
  return items;
}
