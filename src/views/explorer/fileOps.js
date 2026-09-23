// Explorer file operations: name validation (VS Code messages), create / rename / move / copy /
// duplicate / delete with Undo, the Explorer's internal clipboard (Cut/Copy/Paste), path copying
// and saving files to the device (share sheet on iOS so users can "Save to Files").

import { workspace } from '../../core/workspace.js';
import { posix, mimeFromPath } from '../../core/path.js';
import { settings } from '../../core/settings.js';
import { copyText, downloadBlob, isIOS } from '../../core/dom.js';
import { output } from '../../core/output.js';
import { notify } from '../../platform/notifications.js';
import { dialogs } from '../../platform/dialogs.js';
import { topLevelPaths } from './model.js';

export const explorerLog = output.channel('Explorer');

// Characters that are invalid in file names on at least one major platform (kept out so ZIP
// exports and Git pushes work everywhere).
const INVALID_CHARS = /[\\:*?"<>|\u0000-\u001f]/;

/**
 * Validates a name typed into the Explorer's inline input (may contain "/" to create nested folders).
 * Returns null or { severity: 'error'|'warning', message } where **x** marks bold text.
 */
export function validateFileName(parent, name, { ignorePath = null } = {}) {
  const fs = workspace.fs;
  if (!name || !name.trim()) return { severity: 'error', message: 'A file or folder name must be provided.' };
  if (/^[/\\]/.test(name)) return { severity: 'error', message: 'A file or folder name cannot start with a slash.' };
  const trimmedSlash = name.replace(/\/+$/, '');
  const segments = trimmedSlash.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..' || INVALID_CHARS.test(seg) || /^\s+$/.test(seg)) {
      return { severity: 'error', message: `The name **${name}** is not valid as a file or folder name. Please choose a different name.` };
    }
    if (seg.length > 255) return { severity: 'error', message: `The name **${seg}** is too long. Please choose a shorter name.` };
  }
  const full = posix.join(parent, trimmedSlash);
  if (full.length > 512) return { severity: 'error', message: 'The path is too long. Please choose a shorter name.' };
  if (fs) {
    let acc = parent;
    for (let i = 0; i < segments.length - 1; i++) {
      acc = posix.join(acc, segments[i]);
      if (fs.isFile(acc)) return { severity: 'error', message: `**${segments[i]}** is a file, not a folder. Please choose a different name.` };
    }
    if (fs.exists(full) && full !== ignorePath) {
      return { severity: 'error', message: `A file or folder **${segments.at(-1)}** already exists at this location. Please choose a different name.` };
    }
  }
  if (/^\s|\s$/.test(name) || segments.some(s => /^\s|\s$/.test(s))) return { severity: 'warning', message: 'Leading or trailing whitespace detected in file or folder name.' };
  return null;
}

// ---------------- undo ----------------
const undoStack = [];
export function pushUndo(entry) { undoStack.push(entry); if (undoStack.length > 20) undoStack.shift(); }
export function canUndo() { return undoStack.length > 0; }
export async function undoLast() {
  const entry = undoStack.pop();
  if (!entry) return false;
  try { await entry.undo(); notify.info(`Undo: ${entry.label}`, { source: 'Explorer' }); return true; }
  catch (err) { notify.error(`Could not undo ${entry.label}: ${err.message}`, { source: 'Explorer' }); return false; }
}

// ---------------- create / rename / move ----------------
export async function createFile(path, content = '') {
  const rec = await workspace.fs.writeText(path, content, { source: 'user' });
  pushUndo({ label: `Create ${posix.basename(path)}`, undo: () => workspace.fs.remove(path, { source: 'user' }) });
  return rec;
}

export async function createFolder(path) {
  const existed = workspace.fs.exists(path);
  const rec = await workspace.fs.mkdir(path, { source: 'user' });
  if (!existed) pushUndo({ label: `Create ${posix.basename(path)}`, undo: () => workspace.fs.remove(path, { source: 'user' }) });
  return rec;
}

export async function renamePath(from, to, { overwrite = false, label } = {}) {
  await workspace.fs.rename(from, to, { source: 'user', overwrite });
  pushUndo({ label: label || `Rename ${posix.basename(from)}`, undo: () => workspace.fs.rename(to, from, { source: 'user' }) });
  explorerLog.info(`Renamed ${from} → ${to}`);
}

/** Moves paths into `folder`. Asks before replacing existing items. Returns the new paths. */
export async function movePaths(paths, folder) {
  const moved = [];
  for (const src of topLevelPaths(paths)) {
    if (!workspace.fs.exists(src)) continue;
    if (posix.dirname(src) === folder) continue;
    if (folder === src || folder.startsWith(src + '/')) {
      notify.error(`Cannot move '${posix.basename(src)}' into itself.`, { source: 'Explorer' });
      continue;
    }
    const target = posix.join(folder, posix.basename(src));
    let overwrite = false;
    if (workspace.fs.exists(target)) {
      const ok = await dialogs.confirm({
        message: `A file or folder with the name '${posix.basename(src)}' already exists in the destination folder. Do you want to replace it?`,
        detail: 'This action is irreversible!', primary: 'Replace', danger: true
      });
      if (!ok) continue;
      overwrite = true;
    }
    try {
      await renamePath(src, target, { overwrite, label: `Move ${posix.basename(src)}` });
      moved.push(target);
    } catch (err) { notify.error(`Could not move '${posix.basename(src)}': ${err.message}`, { source: 'Explorer' }); }
  }
  return moved;
}

/** VS Code "simple" incremental naming: "a.txt" → "a copy.txt" → "a copy 2.txt". */
export function incrementName(folder, name, isFolder = false) {
  const fs = workspace.fs;
  const dot = isFolder ? -1 : name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const m = stem.match(/^(.*?) copy(?: (\d+))?$/);
  const base = m ? m[1] : stem;
  let n = m ? (m[2] ? Number(m[2]) + 1 : 2) : 1;
  for (;;) {
    const candidate = `${base} copy${n > 1 ? ` ${n}` : ''}${ext}`;
    if (!fs.exists(posix.join(folder, candidate))) return candidate;
    n++;
  }
}

/** Copies paths into `folder` (name conflicts → "name copy.ext"). Returns the new paths. */
export async function copyPaths(paths, folder) {
  const created = [];
  for (const src of topLevelPaths(paths)) {
    if (!workspace.fs.exists(src)) continue;
    if (folder === src || folder.startsWith(src + '/')) {
      notify.error(`Cannot copy '${posix.basename(src)}' into itself.`, { source: 'Explorer' });
      continue;
    }
    const name = posix.basename(src);
    const isFolder = workspace.fs.isFolder(src);
    const targetName = workspace.fs.exists(posix.join(folder, name)) ? incrementName(folder, name, isFolder) : name;
    const target = posix.join(folder, targetName);
    try {
      await workspace.fs.copy(src, target, { source: 'user' });
      created.push(target);
      pushUndo({ label: `Copy ${name}`, undo: () => workspace.fs.remove(target, { source: 'user' }) });
    } catch (err) { notify.error(`Could not copy '${name}': ${err.message}`, { source: 'Explorer' }); }
  }
  return created;
}

export async function duplicatePath(path) {
  return (await copyPaths([path], posix.dirname(path)))[0] || null;
}

// ---------------- delete + undo ----------------
function snapshot(paths) {
  const out = [];
  for (const r of workspace.fs.entries()) {
    if (!paths.some(p => r.path === p || r.path.startsWith(p + '/'))) continue;
    out.push(r.type === 'folder'
      ? { path: r.path, folder: true }
      : (r.binary instanceof Blob ? { path: r.path, blob: r.binary, mime: r.mime } : { path: r.path, content: r.content ?? '', mime: r.mime }));
  }
  return out;
}

async function restore(items, projectId) {
  if (!items.length) return;
  if (workspace.id !== projectId) throw new Error('The project that contained these files is no longer open.');
  await workspace.fs.writeMany(items, { source: 'user' });
  explorerLog.info(`Restored ${items.length} item(s)`);
}

/**
 * Deletes paths after the explorer.confirmDelete dialog; shows an Undo notification.
 * Returns true when something was deleted.
 */
export async function deletePaths(paths, { confirm = settings.get('explorer.confirmDelete', true) } = {}) {
  const targets = topLevelPaths(paths).filter(p => workspace.fs.exists(p));
  if (!targets.length) return false;
  const single = targets.length === 1;
  const name = posix.basename(targets[0]);
  if (confirm) {
    const isFolder = single && workspace.fs.isFolder(targets[0]);
    const res = await dialogs.show({
      type: 'warning',
      message: single ? `Are you sure you want to delete "${name}"?` : `Are you sure you want to delete the following ${targets.length} files/directories and their contents?`,
      detail: (single ? '' : targets.map(p => posix.basename(p)).slice(0, 10).join('\n') + (targets.length > 10 ? `\n…and ${targets.length - 10} more` : '') + '\n\n')
        + `You can restore ${single ? (isFolder ? 'this folder' : 'this file') : 'them'} with Undo right after deleting.`,
      buttons: ['Delete', 'Cancel'], defaultId: 0, cancelId: 1, danger: true,
      checkbox: { label: 'Do not ask me again', checked: false }
    });
    if (res.index !== 0) return false;
    if (res.checked) settings.set('explorer.confirmDelete', false);
  }
  const items = snapshot(targets);
  const projectId = workspace.id;
  try {
    for (const p of targets) await workspace.fs.remove(p, { source: 'user' });
  } catch (err) {
    notify.error(`Could not delete: ${err.message}`, { source: 'Explorer' });
    return false;
  }
  explorerLog.info(`Deleted ${targets.join(', ')}`);
  const label = single ? `Delete ${name}` : `Delete ${targets.length} items`;
  const entry = { label, undo: () => restore(items, projectId) };
  pushUndo(entry);
  notify.info(single ? `Deleted "${name}".` : `Deleted ${targets.length} items.`, {
    source: 'Explorer',
    actions: [{ label: 'Undo', run: async () => {
      const i = undoStack.indexOf(entry); if (i >= 0) undoStack.splice(i, 1);
      try { await entry.undo(); } catch (err) { notify.error(`Could not restore: ${err.message}`, { source: 'Explorer' }); }
    } }]
  });
  return true;
}

// ---------------- clipboard ----------------
export const clipboard = {
  paths: [], cut: false,
  set(paths, cut) { this.paths = topLevelPaths(paths); this.cut = !!cut; },
  clear() { this.paths = []; this.cut = false; },
  has() { return this.paths.some(p => workspace.fs?.exists(p)); },
  isCut(path) { return this.cut && this.paths.some(p => path === p || path.startsWith(p + '/')); }
};

/** Pastes the clipboard into `folder`. Returns the new paths. */
export async function pasteInto(folder) {
  if (!clipboard.has()) return [];
  const paths = clipboard.paths.filter(p => workspace.fs.exists(p));
  if (clipboard.cut) {
    const moved = await movePaths(paths, folder);
    clipboard.clear();
    return moved;
  }
  return copyPaths(paths, folder);
}

// ---------------- paths ----------------
export function absolutePath(path) { return `/${path}`; }

export async function copyPathToClipboard(path, relative = false) {
  const text = relative ? path : absolutePath(path);
  const ok = await copyText(text);
  if (!ok) notify.warn('Could not access the clipboard.', { source: 'Explorer' });
  return ok ? text : null;
}

// ---------------- save to device ----------------
/**
 * Saves a blob to the device. On iOS the share sheet is preferred (so "Save to Files" works);
 * elsewhere the browser downloads it. Returns 'shared' | 'downloaded' | 'cancelled' | 'deferred'.
 */
export async function saveBlob(blob, name, { preferShare = isIOS } = {}) {
  const type = blob.type || mimeFromPath(name);
  if (preferShare && typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
    let file = null;
    try { file = new File([blob], name, { type }); } catch {}
    if (file && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return 'shared';
      } catch (err) {
        if (err?.name === 'AbortError') return 'cancelled';
        // The user gesture expired while the file was being prepared: offer buttons (a fresh tap).
        notify.info(`'${name}' is ready.`, {
          source: 'Explorer',
          actions: [
            { label: 'Save to Files…', run: () => navigator.share({ files: [file], title: name }).catch(e => { if (e?.name !== 'AbortError') downloadBlob(blob, name); }) },
            { label: 'Download', run: () => downloadBlob(blob, name) }
          ]
        });
        return 'deferred';
      }
    }
  }
  downloadBlob(blob, name);
  return 'downloaded';
}

/** Safe file name for downloads/exports. */
export function safeFileName(name, fallback = 'project') {
  const clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return clean || fallback;
}
