// Moving files between the device and the project: import files / folders / ZIP archives
// (into the open project or as a new project), drag & drop from the OS, and export as ZIP.

import { workspace } from '../../core/workspace.js';
import { posix, isTextPath, looksBinary, mimeFromPath, validatePath } from '../../core/path.js';
import { pickFiles, formatBytes } from '../../core/dom.js';
import { notify } from '../../platform/notifications.js';
import { dialogs } from '../../platform/dialogs.js';
import { explorerLog, saveBlob, safeFileName } from './fileOps.js';

export const MAX_ZIP_BYTES = 100 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
const JUNK = /(^|\/)(__MACOSX(\/|$)|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;
// Folders that are skipped when importing a whole folder/archive (huge, useless on a phone).
const HEAVY_DIRS = /(^|\/)(\.git|node_modules)(\/|$)/;

let JSZipPromise = null;
export function loadJSZip() {
  JSZipPromise ||= import('../../../vendor/jszip.js').then(m => m.default || m.JSZip).catch(err => { JSZipPromise = null; throw new Error(`The ZIP library could not be loaded (${err.message}).`); });
  return JSZipPromise;
}

/** Removes a single common top-level folder ("repo-main/…") shared by every path. */
export function stripCommonRoot(paths) {
  if (!paths.length) return { prefix: '', paths };
  const first = paths[0].split('/')[0];
  const nested = paths.some(p => p.includes('/'));
  if (!nested || !paths.every(p => p === first || p.startsWith(first + '/'))) return { prefix: '', paths };
  return { prefix: first, paths: paths.map(p => (p === first ? '' : p.slice(first.length + 1))) };
}

async function toItem(path, blob) {
  const text = isTextPath(path, blob.type) && !(await looksBinary(blob));
  if (text) return { path, content: await blob.text() };
  return { path, blob: blob.type ? blob : new Blob([blob], { type: mimeFromPath(path) }), mime: blob.type || mimeFromPath(path) };
}

/** Processes async work over items with bounded concurrency. */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

function cleanRelative(path) {
  const p = posix.clean(String(path || '').replace(/\\/g, '/')).replace(/^\/+/, '');
  try { validatePath(p); return p; } catch { return null; }
}

/**
 * Asks what to do when imported paths already exist. Returns 'replace' | 'skip' | 'cancel'.
 */
async function resolveConflicts(conflicts) {
  if (!conflicts.length) return 'replace';
  const single = conflicts.length === 1;
  const choice = await dialogs.show({
    type: 'warning',
    message: single
      ? `A file or folder with the name '${posix.basename(conflicts[0])}' already exists in the destination folder. Do you want to replace it?`
      : `${conflicts.length} files already exist in the destination folder. Do you want to replace them?`,
    detail: single ? 'This action is irreversible!' : conflicts.slice(0, 8).join('\n') + (conflicts.length > 8 ? `\n…and ${conflicts.length - 8} more` : ''),
    buttons: single ? ['Replace', 'Cancel'] : ['Replace All', 'Skip Existing', 'Cancel'],
    defaultId: 0, cancelId: single ? 1 : 2, danger: true
  });
  if (choice === 0) return 'replace';
  if (!single && choice === 1) return 'skip';
  return 'cancel';
}

/**
 * Core import: sources = [{ path (relative), blob }] (+ optional { path, folder: true }).
 * opts: { target (folder in the current project), newProject, name, label, stripRoot, skipHeavy }
 * → { project, count, skipped, paths }
 */
export async function importEntries(sources, { target = '', newProject = false, name = '', label = 'files', stripRoot = false, skipHeavy = false } = {}) {
  let list = sources.map(s => ({ ...s, path: cleanRelative(s.path) })).filter(s => s.path);
  let skipped = 0;
  list = list.filter(s => { if (JUNK.test(s.path) || (skipHeavy && HEAVY_DIRS.test(s.path))) { skipped++; return false; } return true; });
  if (stripRoot) {
    const { prefix, paths } = stripCommonRoot(list.map(s => s.path));
    if (prefix) { list = list.map((s, i) => ({ ...s, path: paths[i] })).filter(s => s.path); if (!name) name = prefix; }
  }
  if (!list.length) {
    notify.warn(skipped ? `Nothing to import: all ${skipped} item(s) were system or dependency files.` : 'Nothing to import.', { source: 'Explorer' });
    return { project: workspace.project, count: 0, skipped, paths: [] };
  }
  const total = list.reduce((n, s) => n + (s.blob?.size || 0), 0);
  if (total > MAX_IMPORT_BYTES) {
    notify.error(`This import is too large (${formatBytes(total)}). X Coder can import up to ${formatBytes(MAX_IMPORT_BYTES)} at a time on this device.`, { source: 'Explorer' });
    return { project: workspace.project, count: 0, skipped, paths: [] };
  }

  const dest = newProject ? '' : posix.clean(target || '');
  let items = list.map(s => ({ ...s, path: posix.join(dest, s.path) }));
  if (!newProject && workspace.fs) {
    const conflicts = items.filter(s => !s.folder && workspace.fs.exists(s.path)).map(s => s.path);
    const folderClash = items.find(s => { let d = posix.dirname(s.path); while (d) { if (workspace.fs.isFile(d)) return true; d = posix.dirname(d); } return false; });
    if (folderClash) { notify.error(`Cannot import '${folderClash.path}': a file is in the way of one of its folders.`, { source: 'Explorer' }); return { project: workspace.project, count: 0, skipped, paths: [] }; }
    const decision = await resolveConflicts(conflicts);
    if (decision === 'cancel') return { project: workspace.project, count: 0, skipped, paths: [] };
    if (decision === 'skip') { const set = new Set(conflicts); skipped += set.size; items = items.filter(s => !set.has(s.path)); }
  }

  const progress = items.length > 12 ? notify.progress(`Importing ${label}…`, { source: 'Explorer' }) : null;
  try {
    let done = 0;
    const prepared = await mapLimit(items, 8, async s => {
      const item = s.folder ? { path: s.path, folder: true } : await toItem(s.path, s.blob);
      done++;
      if (progress && (done % 25 === 0 || done === items.length)) progress.update(`Importing ${label}… (${done}/${items.length})`);
      return item;
    });
    let project = workspace.project;
    if (newProject) {
      const projectName = String(name || 'Imported Project').replace(/\.zip$/i, '').trim() || 'Imported Project';
      project = await workspace.createProject(projectName, { files: {} });
    }
    if (prepared.length) await workspace.fs.writeMany(prepared, { source: 'import' });
    const count = prepared.filter(i => !i.folder).length;
    explorerLog.info(`Imported ${count} file(s) from ${label}${newProject ? ` into new project "${project.name}"` : dest ? ` into ${dest}` : ''}${skipped ? `, skipped ${skipped}` : ''}`);
    const msg = `Imported ${count} file${count === 1 ? '' : 's'}${newProject ? ` into the new project “${project.name}”` : ''}.${skipped ? ` Skipped ${skipped} system/dependency or existing item${skipped === 1 ? '' : 's'}.` : ''}`;
    if (progress) progress.done(msg); else if (newProject || count > 1 || skipped) notify.info(msg, { source: 'Explorer' });
    return { project, count, skipped, paths: prepared.map(i => i.path) };
  } catch (err) {
    progress?.close();
    explorerLog.error('Import failed', err);
    const quota = /quota|storage|abort/i.test(err?.message || '') ? ' The device may be out of storage space for this site.' : '';
    notify.error(`Import failed: ${err.message}.${quota}`, { source: 'Explorer' });
    throw err;
  }
}

// ---------------- pickers ----------------
export async function importFiles({ newProject = false, target = '', name = '' } = {}) {
  const picked = await pickFiles({ multiple: true });
  if (!picked.length) return null;
  return importEntries(picked.map(f => ({ path: f.name, blob: f })), { target, newProject, name: name || (picked.length === 1 ? posix.stem(picked[0].name) : 'Imported Files'), label: picked.length === 1 ? picked[0].name : `${picked.length} files` });
}

/** Picks a folder (webkitdirectory). → File[] with webkitRelativePath */
export function pickFolder() { return pickFiles({ multiple: true, directory: true }); }

export async function importFolder({ newProject = false, target = '', name = '', picked = null } = {}) {
  picked ||= await pickFolder();
  if (!picked?.length) return null;
  const sources = picked.map(f => ({ path: f.webkitRelativePath || f.name, blob: f }));
  const top = (picked[0].webkitRelativePath || '').split('/')[0] || 'Folder';
  // Into the open project the folder is kept (like VS Code's upload); as a new project it becomes the root.
  return importEntries(sources, { target, newProject, name: name || top, label: `folder '${top}'`, stripRoot: newProject, skipHeavy: true });
}

/** Imports a ZIP (File/Blob, or picks one). opts: { newProject, name, target } → result | null */
/** Picks one ZIP file. → File | null */
export async function pickZip() {
  const picked = await pickFiles({ accept: '.zip,application/zip,application/x-zip-compressed', multiple: false });
  return picked[0] || null;
}

export async function importZip(file, { newProject = false, name = '', target = '' } = {}) {
  if (!(file instanceof Blob)) {
    file = await pickZip();
    if (!file) return null;
  }
  const fileName = file.name || name || 'archive.zip';
  if (file.size > MAX_ZIP_BYTES) {
    notify.error(`'${fileName}' is too large (${formatBytes(file.size)}). X Coder can import ZIP files up to 100 MB.`, { source: 'Explorer' });
    return null;
  }
  const progress = notify.progress(`Reading ${fileName}…`, { source: 'Explorer' });
  let zip;
  try {
    const JSZip = await loadJSZip();
    zip = await JSZip.loadAsync(file);
  } catch (err) {
    progress.close();
    explorerLog.error(`Could not read ${fileName}`, err);
    notify.error(`'${fileName}' is not a valid ZIP archive: ${err.message}`, { source: 'Explorer' });
    return null;
  }
  const sources = [];
  let unpacked = 0;
  try {
    for (const entry of Object.values(zip.files)) {
      const path = entry.name.replace(/\/+$/, '');
      if (!path) continue;
      if (entry.dir) { sources.push({ path, folder: true }); continue; }
      if (JUNK.test(path)) continue;
      unpacked += entry._data?.uncompressedSize || 0;
      if (unpacked > MAX_IMPORT_BYTES) throw new Error(`the archive expands to more than ${formatBytes(MAX_IMPORT_BYTES)}`);
      sources.push({ path, blob: await entry.async('blob') });
    }
  } catch (err) {
    progress.close();
    notify.error(`Could not extract '${fileName}': ${err.message}`, { source: 'Explorer' });
    return null;
  }
  progress.close();
  const projectName = name || fileName.replace(/\.zip$/i, '');
  return importEntries(sources, { target, newProject, name: projectName, label: fileName, stripRoot: true, skipHeavy: false });
}

// ---------------- drag & drop from the OS ----------------
function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () => reader.readEntries(batch => { if (!batch.length) resolve(all); else { all.push(...batch); next(); } }, reject);
    next();
  });
}
async function walkEntry(entry, prefix, out) {
  if (!entry) return;
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ path, blob: file });
  } else if (entry.isDirectory) {
    const children = await readAllEntries(entry.createReader());
    if (!children.length) out.push({ path, folder: true });
    for (const child of children) await walkEntry(child, path, out);
  }
}

/**
 * Collects dropped files synchronously from a drop event (entries must be grabbed during the event),
 * then walks folders asynchronously. Returns a promise of sources.
 */
export function collectDrop(dataTransfer) {
  const entries = [];
  const plain = [];
  for (const item of [...(dataTransfer?.items || [])]) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else { const f = item.getAsFile(); if (f) plain.push(f); }
  }
  if (!entries.length && !plain.length) for (const f of [...(dataTransfer?.files || [])]) plain.push(f);
  return (async () => {
    const out = plain.map(f => ({ path: f.name, blob: f }));
    for (const e of entries) await walkEntry(e, '', out);
    return out;
  })();
}

export async function importDrop(dataTransfer, target = '') {
  const pending = collectDrop(dataTransfer);
  const sources = await pending;
  if (!sources.length) return null;
  return importEntries(sources, { target, label: sources.length === 1 ? posix.basename(sources[0].path) : `${sources.length} items`, skipHeavy: true });
}

// ---------------- export ----------------
/** Builds a ZIP of the project (or of one folder). → Blob */
export async function buildZip(folder = '', onProgress) {
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const fs = workspace.fs;
  const base = folder ? folder + '/' : '';
  for (const r of fs.entries()) {
    if (folder && !(r.path === folder || r.path.startsWith(base))) continue;
    const rel = folder ? (r.path === folder ? '' : r.path.slice(base.length)) : r.path;
    if (!rel) continue;
    if (r.type === 'folder') zip.folder(rel);
    else if (r.binary instanceof Blob) zip.file(rel, r.binary, { binary: true });
    else zip.file(rel, r.content ?? '');
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/zip' },
    meta => onProgress?.(Math.round(meta.percent)));
}

/** Exports the current project (or a folder) as a ZIP. → { name, size, result } | null */
export async function exportZip({ folder = '' } = {}) {
  if (!workspace.fs) { notify.warn('Open a project first.', { source: 'Explorer' }); return null; }
  const baseName = safeFileName(folder ? posix.basename(folder) : workspace.name);
  const name = `${baseName}.zip`;
  const progress = notify.progress(`Compressing ${name}…`, { source: 'Explorer' });
  let blob;
  try {
    let last = -1;
    blob = await buildZip(folder, pct => { if (pct >= last + 10) { last = pct; progress.update(`Compressing ${name}… ${pct}%`); } });
  } catch (err) {
    progress.close();
    explorerLog.error('Export failed', err);
    notify.error(`Could not export the project: ${err.message}`, { source: 'Explorer' });
    return null;
  }
  progress.close();
  const result = await saveBlob(blob, name);
  explorerLog.info(`Exported ${name} (${formatBytes(blob.size)}) → ${result}`);
  return { name, size: blob.size, result };
}
