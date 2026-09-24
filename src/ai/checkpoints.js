// AI checkpoints: snapshots of files taken right before the agent changes them, so every agent turn can be
// undone exactly (all files, or one file) — even after a reload.
//
// IndexedDB store 'checkpoints' (shared with X Coder ≤5): { id, projectId, turnId, createdAt, records: [{path, record|null}],
//   edits: [...edit summaries], mode }. `record` is the file record before the turn (null = the file did not exist).
//
//   const cp = await checkpoints.open({ projectId, turnId, mode })   create (or load) the checkpoint of a turn
//   await checkpoints.snapshot(cp, fs, path, { content? })            first-touch snapshot of one path (content = live text)
//   await checkpoints.restore(cp, fs, paths?)                        restore all / some paths → restored paths
//   await checkpoints.forTurn(turnId, suffix?) / latest(projectId) / list(projectId)
//   (a turn that creates a new project gets one checkpoint per project: cp_<turn>, cp_<turn>~<projectId>)
//   await checkpoints.save(cp)

import { idbGet, idbPut, idbDelete, idbGetAllByIndex } from '../core/db.js';

const KEEP_PER_PROJECT = 40;
const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;

export const checkpointId = (turnId, suffix = '') => `cp_${turnId}${suffix ? `~${suffix}` : ''}`;

function cloneRecord(rec) {
  if (!rec) return null;
  if (rec.type === 'folder') return { type: 'folder', path: rec.path };
  return {
    type: 'file', path: rec.path,
    content: rec.binary instanceof Blob ? null : (rec.content ?? ''),
    binary: rec.binary instanceof Blob ? rec.binary : null,
    mime: rec.mime || '', createdAt: rec.createdAt || Date.now(), updatedAt: rec.updatedAt || Date.now()
  };
}

async function persist(cp) {
  try { await idbPut('checkpoints', cp); }
  catch (err) {
    // Storage may be full: keep the in-memory checkpoint so undo still works in this session.
    console.warn('[X Coder AI] checkpoint could not be saved', err);
  }
}

export const checkpoints = {
  async open({ projectId, turnId, mode = 'agent', suffix = '' }) {
    const id = checkpointId(turnId, suffix);
    let cp = null;
    try { cp = await idbGet('checkpoints', id); } catch {}
    if (cp && cp.projectId === projectId) return cp;
    cp = { id, projectId, turnId, mode, createdAt: Date.now(), records: [], edits: [], label: '' };
    await persist(cp);
    this.prune(projectId).catch(() => {});
    return cp;
  },

  has(cp, path) { return cp.records.some(r => r.path === path); },

  /** Records the current state of `path` unless it was already recorded in this checkpoint. */
  async snapshot(cp, fs, path, { content } = {}) {
    if (!cp || this.has(cp, path)) return false;
    const rec = fs.get(path);
    let copy = cloneRecord(rec);
    // the text the AI actually changed (an open editor's unsaved text) is what undo must bring back
    if (copy && copy.type === 'file' && !copy.binary && typeof content === 'string') copy.content = content;
    if (copy?.binary && copy.binary.size > MAX_SNAPSHOT_BYTES) copy = { ...copy, binary: null, content: null, tooLarge: true };
    cp.records.push({ path, record: copy });
    // a new file may implicitly create its parent folders: record them so undo can remove them (when empty)
    if (!rec) {
      for (let dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''; dir; dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') {
        if (fs.exists(dir) || this.has(cp, dir)) break;
        cp.records.push({ path: dir, record: null, folder: true });
      }
    }
    // snapshot everything inside a folder that is about to be deleted/renamed
    if (rec?.type === 'folder') {
      for (const r of fs.entries()) if (r.path.startsWith(path + '/') && !this.has(cp, r.path)) cp.records.push({ path: r.path, record: cloneRecord(r) });
    }
    await persist(cp);
    return true;
  },

  async save(cp) { if (cp) await persist(cp); },

  /**
   * Restores recorded paths (all when `paths` is empty). Paths that did not exist are removed.
   * → { restored: [path], skipped: [{path, reason}] }
   */
  async restore(cp, fs, paths = null) {
    const want = paths?.length ? new Set(paths) : null;
    const records = cp.records.filter(r => !want || want.has(r.path) || [...want].some(p => r.path.startsWith(p + '/') || (r.folder && p.startsWith(r.path + '/'))));
    const restored = [], skipped = [];
    // 1) remove paths that were created by the turn (deepest first)
    for (const { path, record, folder } of [...records].sort((a, b) => b.path.length - a.path.length)) {
      if (record) continue;
      try {
        if (folder) {
          // implicitly created parent folder: remove it only if nothing else was put into it
          if (fs.isFolder(path) && !fs.list(path).length) await fs.remove(path, { source: 'ai' });
          continue;
        }
        if (fs.exists(path)) await fs.remove(path, { source: 'ai' });
        restored.push(path);
      } catch (err) { skipped.push({ path, reason: err.message }); }
    }
    // 2) put back the original content
    for (const { path, record } of records) {
      if (!record) continue;
      try {
        if (record.type === 'folder') { if (!fs.exists(path)) await fs.mkdir(path, { source: 'ai' }); continue; }
        if (record.tooLarge) { skipped.push({ path, reason: 'file was too large to snapshot' }); continue; }
        if (fs.isFolder(path)) await fs.remove(path, { source: 'ai' });
        if (record.binary instanceof Blob) await fs.writeBinary(path, record.binary, { source: 'ai', mime: record.mime });
        else {
          const current = fs.peekText(path);
          if (current !== record.content) await fs.writeText(path, record.content ?? '', { source: 'ai', mime: record.mime || undefined });
        }
        restored.push(path);
      } catch (err) { skipped.push({ path, reason: err.message }); }
    }
    return { restored: [...new Set(restored)], skipped };
  },

  async forTurn(turnId, suffix = '') {
    try { return (await idbGet('checkpoints', checkpointId(turnId, suffix))) || null; } catch { return null; }
  },

  async list(projectId) {
    try {
      const all = await idbGetAllByIndex('checkpoints', 'projectId', projectId);
      return all.filter(c => c && Array.isArray(c.records)).sort((a, b) => b.createdAt - a.createdAt);
    } catch { return []; }
  },

  /** Newest checkpoint of the project that still has something to undo. */
  async latest(projectId) {
    const list = await this.list(projectId);
    return list.find(c => c.records.length && !c.undone && (c.edits || []).some(e => e.state === 'applied' || e.state === 'kept')) || null;
  },

  async remove(id) { try { await idbDelete('checkpoints', id); } catch {} },

  async prune(projectId, keep = KEEP_PER_PROJECT) {
    const list = await this.list(projectId);
    for (const cp of list.slice(keep)) await this.remove(cp.id);
  }
};
