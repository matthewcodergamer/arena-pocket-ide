// Git repository model for one project (no git binary: the GitHub REST API is the remote).
//
// Project record: project.git = {
//   repo: 'owner/name' | '',  branch: 'main',
//   lastSyncSha,  lastSyncAt,          // remote commit the local HEAD is based on ("origin/<branch>")
//   snapshot: { path: sha256 },        // X Coder ≤5 base hashes (legacy; cleared by the next pull)
//   outgoing: [{ id, message, time, author, changes: [{ path, status: 'A'|'M'|'D', sha, mode }] }],   // local commits
//   outgoingBase: { path: sha1 | null | 'sha256:<hex>' },   // remote version of paths touched by local commits
//   format: 6 }
//
// IndexedDB store 'gitbase' ({projectId, path} key):
//   HEAD rows  { path, sha, mode, content | blob }       base (last commit) content, sha = git blob SHA-1
//   '\u0001c/<commitId>/<path>'  content of a file in an unpushed local commit
//   '\u0001o/<path>'             remote (origin) content of a path changed by unpushed local commits
// Control characters can never appear in project paths (validatePath), so the prefixes cannot collide.
//
// Changes = working tree (ProjectFS) vs HEAD: 'M' modified, 'U' untracked (new; honours .gitignore), 'D' deleted.

import { openDB, idbGet, idbGetAllByIndex, idbPut } from '../core/db.js';
import { workspace } from '../core/workspace.js';
import { recordBytes, gitBlobSha, sha256Hex, IgnoreMatcher } from './util.js';

export const STORE = 'gitbase';
export const COMMIT_PREFIX = '\u0001c/';
export const ORIGIN_PREFIX = '\u0001o/';

export function emptyGit(extra = {}) {
  return { repo: '', branch: 'main', lastSyncSha: null, lastSyncAt: null, snapshot: {}, outgoing: [], outgoingBase: {}, format: 6, ...extra };
}

export function normalizeGit(git) {
  const g = git && typeof git === 'object' ? git : {};
  return Object.assign(g, {
    repo: typeof g.repo === 'string' ? g.repo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '') : '',
    branch: typeof g.branch === 'string' && g.branch.trim() ? g.branch.trim() : 'main',
    lastSyncSha: g.lastSyncSha || null,
    lastSyncAt: g.lastSyncAt || null,
    snapshot: g.snapshot && typeof g.snapshot === 'object' ? g.snapshot : {},
    outgoing: Array.isArray(g.outgoing) ? g.outgoing : [],
    outgoingBase: g.outgoingBase && typeof g.outgoingBase === 'object' ? g.outgoingBase : {},
    format: 6
  });
}

/** Writes/deletes gitbase rows for a project in one transaction. rows: [{path, sha, mode, content?|blob?}] */
export async function writeRows(projectId, rows = [], deletes = []) {
  if (!rows.length && !deletes.length) return;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const s = t.objectStore(STORE);
    for (const p of deletes) s.delete([projectId, p]);
    for (const r of rows) {
      const rec = { projectId, path: r.path, sha: r.sha, mode: r.mode || '100644' };
      if (r.blob instanceof Blob) rec.blob = r.blob; else rec.content = String(r.content ?? '');
      s.put(rec);
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Saving Source Control data failed (storage may be full)'));
  });
}

export async function readRow(projectId, path) { return (await idbGet(STORE, [projectId, path])) || null; }

export class Repository {
  constructor(project, fs) {
    this.project = project;
    this.fs = fs;
    this.project.git = normalizeGit(this.project.git);
    this.base = new Map();          // path → { sha, mode, binary }
    this.changes = [];              // [{ path, status }]
    this.status = new Map();        // path → status
    this.staged = new Set();
    this.shaCache = new WeakMap();  // fs record → git sha
    this.hashCache = new WeakMap(); // fs record → sha256
    this.generation = 0;
    this.loaded = false;
    this.behind = null;             // incoming commits on origin/<branch> (from the last fetch), null = unknown
  }

  get id() { return this.project.id; }
  get git() { return this.project.git; }
  get connected() { return !!this.git.repo; }
  get owner() { return this.git.repo.split('/')[0] || ''; }
  get name() { return this.git.repo.split('/')[1] || ''; }
  get branch() { return this.git.branch || 'main'; }
  get ahead() { return this.git.outgoing.length; }
  get isLegacy() { return Object.keys(this.git.snapshot || {}).length > 0; }

  async load() {
    this.base.clear();
    const rows = await idbGetAllByIndex(STORE, 'projectId', this.id);
    for (const r of rows) {
      if (r.path.charCodeAt(0) === 1) continue;
      this.base.set(r.path, { sha: r.sha, mode: r.mode || '100644', binary: r.blob instanceof Blob });
    }
    this.loaded = true;
    return this;
  }

  /** Persists project.git (through the workspace for the open project so the in-memory record stays in sync). */
  async save() {
    if (workspace.project?.id === this.id) {
      if (workspace.project !== this.project) { workspace.project.git = this.git; this.project = workspace.project; }
      await workspace.updateProject({ git: this.git });
    } else {
      this.project.updatedAt = Date.now();
      await idbPut('projects', this.project);
    }
  }

  async shaOf(rec) {
    if (!rec || rec.type !== 'file') return null;
    let s = this.shaCache.get(rec);
    if (!s) { s = await gitBlobSha(await recordBytes(rec)); this.shaCache.set(rec, s); }
    return s;
  }
  async sha256Of(rec) {
    if (!rec || rec.type !== 'file') return null;
    let s = this.hashCache.get(rec);
    if (!s) { s = await sha256Hex(await recordBytes(rec)); this.hashCache.set(rec, s); }
    return s;
  }
  /** Current git sha of a path in the working tree (null when missing). */
  async workSha(path) { return this.shaOf(this.fs.get(path)); }

  headSha(path) { return this.base.get(path)?.sha ?? null; }

  /** Recomputes working tree changes vs HEAD. Returns the changes list (latest computation wins). */
  async compute() {
    const gen = ++this.generation;
    if (!this.connected) {
      this.changes = []; this.status = new Map();
      return this.changes;
    }
    if (!this.loaded) return this.changes; // HEAD not read yet — everything would look untracked
    const files = this.fs.files();
    const legacy = this.git.snapshot || {};
    const ignore = IgnoreMatcher.fromFS(this.fs);
    const out = [];
    const seen = new Set();
    const tasks = files.map(rec => async () => {
      const p = rec.path;
      seen.add(p);
      const b = this.base.get(p);
      if (b) { if ((await this.shaOf(rec)) !== b.sha) out.push({ path: p, status: 'M' }); return; }
      if (legacy[p]) { const hash = await this.sha256Of(rec); if (hash !== legacy[p]) out.push({ path: p, status: 'M', legacy: true }); return; }
      if (!ignore.ignores(p)) out.push({ path: p, status: 'U' });
    });
    for (let i = 0; i < tasks.length; i += 64) {
      await Promise.all(tasks.slice(i, i + 64).map(t => t()));
      if (gen !== this.generation) return this.changes;
    }
    for (const p of this.base.keys()) if (!seen.has(p)) out.push({ path: p, status: 'D' });
    for (const p of Object.keys(legacy)) if (!seen.has(p) && !this.base.has(p)) out.push({ path: p, status: 'D', legacy: true });
    out.sort((a, b) => a.path.localeCompare(b.path));
    if (gen !== this.generation) return this.changes;
    this.changes = out;
    this.status = new Map(out.map(c => [c.path, c.status]));
    for (const p of [...this.staged]) if (!this.status.has(p)) this.staged.delete(p);
    return out;
  }

  /** Base (HEAD) content { content } | { blob } of a path, or null (untracked, or legacy without content). */
  async baseContent(path) {
    if (!this.base.has(path)) return null;
    const row = await readRow(this.id, path);
    if (!row) return null;
    return row.blob instanceof Blob ? { blob: row.blob, sha: row.sha, mode: row.mode } : { content: row.content ?? '', sha: row.sha, mode: row.mode };
  }

  /** Updates HEAD rows (and the in-memory base map). */
  async setBase(rows = [], deletes = []) {
    await writeRows(this.id, rows, deletes);
    for (const p of deletes) this.base.delete(p);
    for (const r of rows) this.base.set(r.path, { sha: r.sha, mode: r.mode || '100644', binary: r.blob instanceof Blob });
  }

  /** Deletes every gitbase row of the project (HEAD, commit and origin rows). */
  async clearAll() {
    const rows = await idbGetAllByIndex(STORE, 'projectId', this.id);
    await writeRows(this.id, [], rows.map(r => r.path));
    this.base.clear();
  }

  /** Deletes the local-commit and origin rows (after a successful push). */
  async clearOutgoingRows() {
    const rows = await idbGetAllByIndex(STORE, 'projectId', this.id);
    await writeRows(this.id, [], rows.filter(r => r.path.charCodeAt(0) === 1).map(r => r.path));
  }

  async loadStaged() {
    try { this.staged = new Set((await workspace.sessionGet('scm.staged', [])) || []); } catch { this.staged = new Set(); }
  }
  saveStaged() { if (workspace.project?.id === this.id) workspace.sessionSet('scm.staged', [...this.staged]).catch(() => {}); }
}
