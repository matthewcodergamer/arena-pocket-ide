// Preferences editors (feature entry point): Settings (UI), settings.json and Keyboard Shortcuts.
//
//   editors.open({ type: 'settings', query: 'xcoder.ai' })   → Settings editor with the search prefilled
//   editors.open({ type: 'settings-json' })                  → settings.json (CodeMirror, validated on save)
//   editors.open({ type: 'keybindings' })                    → Keyboard Shortcuts table
// Commands: workbench.action.openSettings (⌘,), workbench.action.openSettingsJson,
//           workbench.action.openGlobalKeybindings.

import { codiconHtml } from '../core/dom.js';
import { commands } from '../core/commands.js';
import { editors } from '../workbench/editors.js';
import { fileIconHtml } from '../workbench/icons.js';
import { createSettingsEditor } from './settings/settingsUI.js';
import { createSettingsJsonEditor } from './settings/settingsJson.js';
import { createKeybindingsEditor } from './settings/keybindingsEditor.js';

// When editors.open() reuses the open Settings tab it does not hand us the new input unless the
// caller passed { inputUpdate: true }. key() sees every input, so it remembers a requested query.
let pendingQuery = null;
let pendingKeybindingsQuery = null;

export function openSettings(query) {
  const q = typeof query === 'string' ? query : typeof query?.query === 'string' ? query.query : undefined;
  return editors.open(q !== undefined ? { type: 'settings', query: q } : { type: 'settings' }, { pinned: true, inputUpdate: q !== undefined });
}

export async function activate() {
  editors.registerProvider('settings', {
    pinnedByDefault: true,
    key(input) { if (typeof input?.query === 'string') pendingQuery = input.query; return 'settings:'; },
    title: () => 'Settings',
    tooltip: () => 'User Settings',
    icon: () => codiconHtml('settings'),
    serialize: () => ({ type: 'settings' }),
    create(input, container) {
      pendingQuery = null;
      container.classList.add('settings-editor-container');
      const instance = createSettingsEditor(input, container);
      const onShow = instance.onShow;
      instance.onShow = () => {
        onShow();
        if (pendingQuery !== null) { instance.setQuery(pendingQuery); pendingQuery = null; }
      };
      instance.setInput = next => { if (typeof next?.query === 'string') instance.setQuery(next.query); pendingQuery = null; };
      return instance;
    }
  });

  editors.registerProvider('settings-json', {
    pinnedByDefault: true,
    key: () => 'settings-json:',
    title: () => 'settings.json',
    description: () => 'User',
    tooltip: () => 'User Settings (settings.json)',
    icon: () => fileIconHtml('settings.json'),
    serialize: () => ({ type: 'settings-json' }),
    create: (input, container, api) => createSettingsJsonEditor(input, container, api)
  });

  editors.registerProvider('keybindings', {
    pinnedByDefault: true,
    key(input) { if (typeof input?.query === 'string') pendingKeybindingsQuery = input.query; return 'keybindings:'; },
    title: () => 'Keyboard Shortcuts',
    tooltip: () => 'Keyboard Shortcuts',
    icon: () => codiconHtml('keyboard'),
    serialize: () => ({ type: 'keybindings' }),
    create(input, container) {
      pendingKeybindingsQuery = null;
      container.classList.add('keybindings-editor-container');
      const instance = createKeybindingsEditor(input, container);
      const onShow = instance.onShow;
      instance.onShow = () => {
        onShow();
        if (pendingKeybindingsQuery !== null) { instance.setQuery(pendingKeybindingsQuery); pendingKeybindingsQuery = null; }
      };
      return instance;
    }
  });

  commands.registerAll([
    { id: 'workbench.action.openSettings', title: 'Open Settings (UI)', category: 'Preferences', icon: 'settings-gear', keybinding: 'Mod+,', allowInInput: true, run: query => openSettings(query) },
    {
      id: 'workbench.action.openSettingsJson', title: 'Open User Settings (JSON)', category: 'Preferences', icon: 'json',
      run: arg => {
        const reveal = typeof arg?.revealSetting === 'string' ? arg.revealSetting : undefined;
        return editors.open(reveal ? { type: 'settings-json', revealSetting: reveal } : { type: 'settings-json' }, { pinned: true, inputUpdate: !!reveal });
      }
    },
    {
      id: 'workbench.action.openGlobalKeybindings', title: 'Open Keyboard Shortcuts', category: 'Preferences', icon: 'keyboard',
      run: query => editors.open(typeof query === 'string' ? { type: 'keybindings', query } : { type: 'keybindings' }, { pinned: true, inputUpdate: typeof query === 'string' })
    }
  ]);
}
