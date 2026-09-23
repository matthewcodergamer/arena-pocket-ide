// Editor feature entry: registers the 'file', 'diff' and 'markdown-preview' editor providers, settings,
// commands, menus, quick access (':' and '@'), the Outline view, the status bar items, diagnostics,
// the mobile accessory bar, auto save and external-change handling.

import { bus } from '../core/events.js';
import { settings } from '../core/settings.js';
import { workspace } from '../core/workspace.js';
import { posix } from '../core/path.js';
import { codiconHtml } from '../core/dom.js';
import { log } from '../core/output.js';
import { editors } from '../workbench/editors.js';
import { fileIconHtml } from '../workbench/icons.js';
import { registerEditorSettings } from './settings.js';
import { createFileEditor } from './fileEditor.js';
import { createDiffEditor } from './diffEditor.js';
import { createMarkdownPreview } from './markdownPreview.js';
import { registerEditorCommands } from './commands.js';
import { registerQuickAccess } from './quickaccess.js';
import { registerOutline } from './outline.js';
import { initEditorStatus } from './status.js';
import { initAccessoryBar } from './accessory.js';
import { startBackgroundDiagnostics } from './lint.js';
import { textEditors, initRegistry } from './registry.js';
import { allCodeEditors } from './codeEditor.js';
import { recordLocation } from './navigation.js';
import { view as V } from './cm.js';

const { EditorView } = V;

function registerProviders() {
  editors.registerProvider('file', {
    title: input => posix.basename(input.path),
    tooltip: input => input.path,
    icon: input => fileIconHtml(input.path),
    serialize: input => ({ type: 'file', path: input.path, ...(input.as ? { as: input.as } : {}) }),
    deserialize: data => (data?.path ? { type: 'file', path: data.path, ...(data.as ? { as: data.as } : {}) } : null),
    exists: input => !!workspace.fs?.isFile(input.path),
    create: (input, container, api) => createFileEditor(input, container, api)
  });
  editors.registerProvider('diff', {
    pinnedByDefault: true,
    key: input => `diff:${input.id ?? input.path ?? ''}`,
    title: input => input.title || `${posix.basename(input.path || '') || 'Untitled'} (Diff)`,
    description: () => '',
    tooltip: input => input.title || input.path || 'Diff',
    icon: input => (input.path ? fileIconHtml(input.path) : codiconHtml('diff')),
    serialize: () => null,
    create: (input, container, api) => createDiffEditor(input, container, api)
  });
  editors.registerProvider('markdown-preview', {
    title: input => `Preview ${posix.basename(input.path)}`,
    tooltip: input => `Preview ${input.path}`,
    icon: () => codiconHtml('open-preview'),
    serialize: input => ({ type: 'markdown-preview', path: input.path }),
    deserialize: data => (data?.path ? { type: 'markdown-preview', path: data.path } : null),
    exists: input => !!workspace.fs?.isFile(input.path),
    create: (input, container) => createMarkdownPreview(input, container)
  });
}

/** Files changed on disk by other features (AI, git pull, search replace, terminal) → reload open editors. */
function watchFileSystem() {
  bus.on('fs:changed', ev => {
    try {
      if (ev.type === 'write' || ev.type === 'create') {
        textEditors.get(ev.path)?.onDiskChanged();
        reloadImages(p => p === ev.path);
      } else if (ev.type === 'reset') {
        for (const ed of textEditors.values()) ed.onDiskChanged();
        reloadImages(() => true);
      }
    } catch (err) { log.warn('Editor reload after file change failed', err); }
  });
}
function reloadImages(match) {
  for (const e of editors.list()) {
    const inner = e.instance?.inner;
    if (inner?.kind === 'image' && match(inner.path) && workspace.fs?.exists(inner.path)) inner.reload().catch(() => {});
  }
}

/** Auto save: onWindowChange + never lose typing when iOS suspends the page. */
function watchWindow() {
  const flushAll = () => { for (const ed of allCodeEditors()) ed.flushAutoSave(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });
  window.addEventListener('pagehide', flushAll);
  window.addEventListener('blur', () => {
    if (settings.get('files.autoSave') === 'onWindowChange') for (const ed of allCodeEditors()) if (ed.dirty) ed.save({ auto: true }).catch(() => {});
  });
  // When the on-screen keyboard opens, keep the cursor of the focused editor visible above it.
  bus.on('keyboard:changed', ({ open }) => {
    if (!open) return;
    for (const ed of allCodeEditors()) {
      if (ed.view.hasFocus) setTimeout(() => { if (!ed.disposed) ed.view.dispatch({ effects: EditorView.scrollIntoView(ed.view.state.selection.main.head, { y: 'nearest', yMargin: 48 }) }); }, 60);
    }
  });
  bus.on('editor:activeChanged', entry => {
    const inner = entry?.instance?.inner ?? entry?.instance;
    if (inner?.kind === 'code' && !inner.disposed) { const i = inner.statusInfo(); recordLocation(inner.path, i.line, i.col); }
    if (settings.get('files.autoSave') === 'onFocusChange') for (const ed of allCodeEditors()) if (ed.dirty && ed !== inner) ed.save({ auto: true }).catch(() => {});
  });
}

export async function activate() {
  registerEditorSettings();
  registerProviders();
  registerEditorCommands();
  registerQuickAccess();
  registerOutline();
  initEditorStatus();
  initAccessoryBar();
  watchFileSystem();
  watchWindow();
  await initRegistry();
  startBackgroundDiagnostics();
}
