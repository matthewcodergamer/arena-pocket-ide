// X Coder Cloud storage on Puter (puter.fs, the signed-in user's Puter cloud drive).
//
// Layout (relative to the app's Puter folder):
//   XCoder/projects/<cloudId>/manifest.json   { format: 1, id, name, updatedAt, device, files: { path: { size, hash, binary, mime, mtime } } }
//   XCoder/projects/<cloudId>/files/<path>    file contents (text or binary)
// Projects synced by X Coder ≤5 live in Puter KV: 'xcoder:v1:project:<id>' (manifest {id, name, updatedAt, files: [paths]})
// and 'xcoder:v1:file:<id>:<encodedPath>' ({ binary, mime, content | data (base64) }) — still readable and deletable here.

import { mimeFromPath, isTextPath } from '../core/path.js';
import { gitBlobSha, recordBytes, pool, base64ToBytes, decodeText } from '../scm/util.js';

export const ROOT = 'XCoder/projects';
const LEGACY_PROJECT = 'xcoder:v1:project:';
const legacyFileKey = (id, path) => `xcoder:v1:file:${id}:${encodeURIComponent(path)}`;
export const MAX_CLOUD_FILE = 50 * 1024 * 1024;

const dirOf = id => `${ROOT}/${id}`;
const fileUrl = (id, path) => `${ROOT}/${id}/files/${path}`;

function isNotFound(err) {
  const code = err?.code || err?.error?.code || '';
  const msg = String(err?.message || err?.error?.message || err || '');
  return code === 'subject_does_not_exist' || code === 'not_found' || /not\s*found|does not exist|no such/i.test(msg);
}
export function errorText(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  return err.message || err.error?.message || err.msg || (err.code ? String(err.code) : '') || JSON.stringify(err).slice(0, 200);
}

async function readJSON(puter, path) {
  try {
    const blob = await puter.fs.read(path);
    return JSON.parse(await (blob instanceof Blob ? blob.text() : String(blob)));
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function write(puter, path, data) {
  return puter.fs.write(path, data, { overwrite: true, dedupeName: false, createMissingParents: true });
}

/** Uploads the project's files to the cloud (incremental by content hash). */
export async function syncProject(puter, { cloudId, name, fs, device = '', onProgress } = {}) {
  const dir = dirOf(cloudId);
  const previous = await readJSON(puter, `${dir}/manifest.json`);
  const prevFiles = previous?.files && typeof previous.files === 'object' ? previous.files : {};
  const files = {};
  const uploads = [];
  const skipped = [];
  for (const rec of fs.files()) {
    const bytes = await recordBytes(rec);
    if (bytes.length > MAX_CLOUD_FILE) { skipped.push(rec.path); continue; }
    const hash = await gitBlobSha(bytes);
    const binary = rec.binary instanceof Blob;
    files[rec.path] = { size: bytes.length, hash, binary, mime: rec.mime || mimeFromPath(rec.path), mtime: rec.updatedAt || null };
    if (prevFiles[rec.path]?.hash !== hash) uploads.push({ path: rec.path, data: binary ? rec.binary : (rec.content || '') });
  }
  const removed = Object.keys(prevFiles).filter(p => !files[p]);
  let done = 0;
  await pool(uploads, 4, async u => {
    await write(puter, fileUrl(cloudId, u.path), u.data);
    done++; onProgress?.(done, uploads.length);
  });
  await pool(removed, 4, async p => {
    try { await puter.fs.delete(fileUrl(cloudId, p)); } catch (err) { if (!isNotFound(err)) throw err; }
  });
  const manifest = { format: 1, id: cloudId, name, updatedAt: Date.now(), device, files };
  await write(puter, `${dir}/manifest.json`, JSON.stringify(manifest));
  return { uploaded: uploads.length, removed: removed.length, total: Object.keys(files).length, skipped, manifest };
}

/** Remote manifest of a cloud project (null when missing). */
export function readManifest(puter, cloudId) { return readJSON(puter, `${dirOf(cloudId)}/manifest.json`); }

/** Lists cloud projects: [{ id, name, updatedAt, fileCount, legacy }] newest first. */
export async function listProjects(puter) {
  const out = [];
  let entries = [];
  try { entries = await puter.fs.readdir(ROOT); } catch (err) { if (!isNotFound(err)) throw err; }
  const dirs = (entries || []).filter(e => e?.is_dir);
  await pool(dirs, 6, async d => {
    const m = await readJSON(puter, `${ROOT}/${d.name}/manifest.json`).catch(() => null);
    if (m) out.push({ id: m.id || d.name, name: m.name || d.name, updatedAt: m.updatedAt || 0, fileCount: Object.keys(m.files || {}).length, legacy: false });
  });
  // X Coder ≤5 (Puter KV)
  try {
    let pairs = await puter.kv.list(`${LEGACY_PROJECT}*`, true);
    if (!Array.isArray(pairs)) pairs = await puter.kv.list({ pattern: `${LEGACY_PROJECT}*`, returnValues: true });
    for (const p of Array.isArray(pairs) ? pairs : []) {
      const m = p?.value ?? p;
      const id = m?.id || String(p?.key || '').slice(LEGACY_PROJECT.length);
      if (!id || out.some(x => x.id === id)) continue;
      out.push({ id, name: m?.name || 'Cloud Project', updatedAt: m?.updatedAt || 0, fileCount: Array.isArray(m?.files) ? m.files.length : 0, legacy: true });
    }
  } catch { /* KV unavailable: only the new format is listed */ }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** Downloads a cloud project's files → { name, items: [{path, content}|{path, blob}], updatedAt }. */
export async function downloadProject(puter, entry, onProgress) {
  if (entry.legacy) {
    const m = await puter.kv.get(`${LEGACY_PROJECT}${entry.id}`);
    if (!m) throw new Error('The cloud project was not found.');
    const paths = Array.isArray(m.files) ? m.files : [];
    const items = [];
    let done = 0;
    await pool(paths, 6, async path => {
      const data = await puter.kv.get(legacyFileKey(entry.id, path));
      if (data) {
        if (data.binary) items.push({ path, blob: new Blob([base64ToBytes(data.data || '')], { type: data.mime || mimeFromPath(path) }) });
        else items.push({ path, content: data.content || '' });
      }
      done++; onProgress?.(done, paths.length);
    });
    return { name: m.name || entry.name, items, updatedAt: m.updatedAt || Date.now() };
  }
  const m = await readManifest(puter, entry.id);
  if (!m) throw new Error('The cloud project was not found.');
  const paths = Object.keys(m.files || {});
  const items = [];
  let done = 0;
  await pool(paths, 6, async path => {
    const meta = m.files[path] || {};
    const blob = await puter.fs.read(fileUrl(entry.id, path));
    const b = blob instanceof Blob ? blob : new Blob([blob]);
    if (!meta.binary && isTextPath(path)) {
      const text = decodeText(new Uint8Array(await b.arrayBuffer()));
      items.push(text !== null ? { path, content: text } : { path, blob: new Blob([b], { type: meta.mime || mimeFromPath(path) }) });
    } else items.push({ path, blob: new Blob([b], { type: meta.mime || mimeFromPath(path) }) });
    done++; onProgress?.(done, paths.length);
  });
  return { name: m.name || entry.name, items, updatedAt: m.updatedAt || Date.now() };
}

/** Deletes a cloud project (folder, or the X Coder ≤5 KV keys). */
export async function deleteProject(puter, entry) {
  if (entry.legacy) {
    const m = await puter.kv.get(`${LEGACY_PROJECT}${entry.id}`).catch(() => null);
    for (const path of Array.isArray(m?.files) ? m.files : []) await puter.kv.del(legacyFileKey(entry.id, path)).catch(() => {});
    await puter.kv.del(`${LEGACY_PROJECT}${entry.id}`);
    return;
  }
  try { await puter.fs.delete(dirOf(entry.id), { recursive: true }); }
  catch (err) { if (!isNotFound(err)) throw err; }
}
