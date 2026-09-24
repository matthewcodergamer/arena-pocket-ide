// Shared editor-feature state: open text editors by path, the active code editor, per-file language
// overrides (persisted per project) and content-change events (markdown preview live updates).

import { Emitter, bus } from '../core/events.js';
import { workspace } from '../core/workspace.js';
import { editors } from '../workbench/editors.js';

/** path → text editor instance (CodeEditor) */
export const textEditors = new Map();
/** 'change' (path, instance) · 'language' (path, lang) · 'active' (instance|null) */
export const editorEvents = new Emitter();

export function isOpenInEditor(path) { return textEditors.has(path); }
export function textEditorFor(path) { return textEditors.get(path) || null; }

/** The file host wrapping the active 'file' editor (switches image ↔ text), or null. */
export function activeHost() {
  const inst = editors.active?.instance;
  return inst && inst.inner !== undefined && typeof inst.openAs === 'function' ? inst : null;
}
/** The active editor's own instance (code editor, image viewer, diff, markdown preview…), unwrapping the file host. */
export function activeInner() {
  const inst = editors.active?.instance;
  if (!inst) return null;
  return inst.inner !== undefined && typeof inst.openAs === 'function' ? inst.inner : inst;
}
/** The active text (CodeMirror) editor, or null. */
export function activeCode() { const i = activeInner(); return i?.kind === 'code' && !i.disposed ? i : null; }
/** The active CodeMirror view (text or diff editor), or null. */
export function activeView() { const v = activeInner()?.view; return v && !v.destroyed ? v : null; }

// ---------------- language overrides ("Change Language Mode") ----------------
const OVERRIDES_KEY = 'editor.languageOverrides';
let overrides = new Map();
let ready = Promise.resolve();
/** Resolves once the current project's overrides are loaded. */
export function overridesReady() { return ready; }
export function languageOverride(path) { return overrides.get(path) || null; }
export async function setLanguageOverride(path, id) {
  if (id) overrides.set(path, id); else overrides.delete(path);
  try { await workspace.sessionSet(OVERRIDES_KEY, Object.fromEntries(overrides)); } catch {}
}
async function loadOverrides() {
  try { overrides = new Map(Object.entries((await workspace.sessionGet(OVERRIDES_KEY, {})) || {})); } catch { overrides = new Map(); }
}
bus.on('project:opened', () => { ready = loadOverrides(); });
bus.on('fs:changed', ev => {
  if (ev.type === 'rename') {
    let changed = false;
    for (const [p, id] of [...overrides]) {
      if (p === ev.path || p.startsWith(ev.path + '/')) { overrides.delete(p); overrides.set(ev.to + p.slice(ev.path.length), id); changed = true; }
    }
    if (changed) workspace.sessionSet(OVERRIDES_KEY, Object.fromEntries(overrides)).catch(() => {});
  } else if (ev.type === 'delete') {
    let changed = false;
    for (const p of [...overrides.keys()]) if (p === ev.path || p.startsWith(ev.path + '/')) { overrides.delete(p); changed = true; }
    if (changed) workspace.sessionSet(OVERRIDES_KEY, Object.fromEntries(overrides)).catch(() => {});
  }
});
export async function initRegistry() { if (workspace.project) { ready = loadOverrides(); await ready; } }
