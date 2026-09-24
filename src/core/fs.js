// Project file system backed by IndexedDB with an in-memory cache.
// Records: { projectId, path, type: 'file'|'folder', content: string|null, binary: Blob|null, mime, createdAt, updatedAt }
// Every mutation emits bus 'fs:changed' so explorer, editors, git, search and AI stay in sync.

import { openDB, idbGetAllByIndex } from './db.js';
import { posix, validatePath, mimeFromPath, isTextPath, looksBinary } from './path.js';
import { bus } from './events.js';

function putAll(projectId, records, deletes = []) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction('files', 'readwrite');
    const s = t.objectStore('files');
    for (const path of deletes) s.delete([projectId, path]);
    for (const r of records) s.put(r);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('File write aborted (storage may be full)'));
  }));
}

export class ProjectFS {
  constructor(projectId) { this.projectId = projectId; this.cache = new Map(); }

  async load() {
    this.cache.clear();
    const all = await idbGetAllByIndex('files', 'projectId', this.projectId);
    for (const r of all) this.cache.set(r.path, r);
    return this;
  }

  /** All records sorted by path. */
  entries() { return [...this.cache.values()].sort((a, b) => a.path.localeCompare(b.path)); }
  files() { return this.entries().filter(r => r.type === 'file'); }
  get(path) { return this.cache.get(posix.clean(path)); }
  exists(path) { return this.cache.has(posix.clean(path)); }
  isFile(path) { return this.get(path)?.type === 'file'; }
  isFolder(path) { return this.get(path)?.type === 'folder'; }
  isBinary(path) { return this.get(path)?.binary instanceof Blob; }
  size(path) { const r = this.get(path); if (!r || r.type !== 'file') return 0; return r.binary instanceof Blob ? r.binary.size : new Blob([r.content || '']).size; }

  /** Direct children of a folder ('' = root), folders first then files, alphabetical. */
  list(dir = '') {
    dir = posix.clean(dir);
    return this.entries()
      .filter(r => posix.dirname(r.path) === dir)
      .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path, undefined, { sensitivity: 'base', numeric: true }) : a.type === 'folder' ? -1 : 1));
  }

  async readText(path) {
    const rec = this.get(path);
    if (!rec) throw new Error(`File not found: ${path}`);
    if (rec.type !== 'file') throw new Error(`Not a file: ${path}`);
    if (rec.binary instanceof Blob) return await rec.binary.text();
    return rec.content || '';
  }
  /** Synchronous text for cached text files (null for binary/missing). */
  peekText(path) {
    const rec = this.get(path);
    if (!rec || rec.type !== 'file' || rec.binary instanceof Blob) return null;
    return rec.content || '';
  }
  async readBlob(path) {
    const rec = this.get(path);
    if (!rec || rec.type !== 'file') throw new Error(`File not found: ${path}`);
    if (rec.binary instanceof Blob) return rec.binary;
    return new Blob([rec.content || ''], { type: rec.mime || mimeFromPath(path) });
  }
  async readDataURL(path) {
    const blob = await this.readBlob(path);
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result); fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  _folderRecords(path) {
    const out = []; const parent = posix.dirname(path);
    if (!parent) return out;
    let acc = '';
    for (const part of parent.split('/')) {
      acc = acc ? `${acc}/${part}` : part;
      const existing = this.cache.get(acc);
      if (existing?.type === 'file') throw new Error(`"${acc}" is a file, not a folder`);
      if (!existing) out.push({ projectId: this.projectId, path: acc, type: 'folder', updatedAt: Date.now(), createdAt: Date.now() });
    }
    return out;
  }

  async writeText(path, content, { source = 'user', mime } = {}) {
    path = posix.clean(path); validatePath(path);
    const old = this.get(path);
    if (old?.type === 'folder') throw new Error(`"${path}" is a folder`);
    const folders = this._folderRecords(path);
    const rec = { projectId: this.projectId, path, type: 'file', content: String(content ?? ''), binary: null, mime: mime || old?.mime || mimeFromPath(path), updatedAt: Date.now(), createdAt: old?.createdAt || Date.now() };
    await putAll(this.projectId, [...folders, rec]);
    for (const f of folders) this.cache.set(f.path, f);
    this.cache.set(path, rec);
    for (const f of folders) bus.emit('fs:changed', { type: 'mkdir', path: f.path, source });
    bus.emit('fs:changed', { type: old ? 'write' : 'create', path, source });
    return rec;
  }

  async writeBinary(path, blob, { source = 'user', mime } = {}) {
    path = posix.clean(path); validatePath(path);
    const old = this.get(path);
    if (old?.type === 'folder') throw new Error(`"${path}" is a folder`);
    const folders = this._folderRecords(path);
    const rec = { projectId: this.projectId, path, type: 'file', content: null, binary: blob, mime: mime || blob.type || mimeFromPath(path), updatedAt: Date.now(), createdAt: old?.createdAt || Date.now() };
    await putAll(this.projectId, [...folders, rec]);
    for (const f of folders) this.cache.set(f.path, f);
    this.cache.set(path, rec);
    for (const f of folders) bus.emit('fs:changed', { type: 'mkdir', path: f.path, source });
    bus.emit('fs:changed', { type: old ? 'write' : 'create', path, source });
    return rec;
  }

  /** Writes a File/Blob, choosing text or binary storage by extension and content sniffing. */
  async writeFileAuto(path, blob, opts = {}) {
    const text = isTextPath(path, blob.type) && !(await looksBinary(blob));
    return text ? this.writeText(path, await blob.text(), opts) : this.writeBinary(path, blob, opts);
  }

  /**
   * Bulk write in one transaction (imports, git pull, cloud restore).
   * items: [{ path, content } | { path, blob } | { path, folder: true }]
   */
  async writeMany(items, { source = 'import' } = {}) {
    const records = new Map();
    const now = Date.now();
    for (const item of items) {
      const path = posix.clean(item.path); validatePath(path);
      let acc = '';
      for (const part of posix.dirname(path).split('/').filter(Boolean)) {
        acc = acc ? `${acc}/${part}` : part;
        if (!this.cache.has(acc) && !records.has(acc)) records.set(acc, { projectId: this.projectId, path: acc, type: 'folder', updatedAt: now, createdAt: now });
      }
      const old = this.cache.get(path);
      if (item.folder) { if (!old) records.set(path, { projectId: this.projectId, path, type: 'folder', updatedAt: now, createdAt: now }); continue; }
      const isBlob = item.blob instanceof Blob;
      records.set(path, {
        projectId: this.projectId, path, type: 'file',
        content: isBlob ? null : String(item.content ?? ''), binary: isBlob ? item.blob : null,
        mime: item.mime || (isBlob ? item.blob.type : '') || mimeFromPath(path), updatedAt: now, createdAt: old?.createdAt || now
      });
    }
    const list = [...records.values()];
    await putAll(this.projectId, list);
    for (const r of list) this.cache.set(r.path, r);
    bus.emit('fs:changed', { type: 'reset', path: '', source, count: list.length });
    return list.length;
  }

  async mkdir(path, { source = 'user' } = {}) {
    path = posix.clean(path); validatePath(path);
    if (this.exists(path)) { if (this.isFolder(path)) return this.get(path); throw new Error('A file with that name already exists'); }
    const folders = this._folderRecords(path);
    const rec = { projectId: this.projectId, path, type: 'folder', updatedAt: Date.now(), createdAt: Date.now() };
    await putAll(this.projectId, [...folders, rec]);
    for (const f of [...folders, rec]) { this.cache.set(f.path, f); bus.emit('fs:changed', { type: 'mkdir', path: f.path, source }); }
    return rec;
  }

  async remove(path, { source = 'user' } = {}) {
    path = posix.clean(path);
    const targets = this.entries().filter(r => r.path === path || r.path.startsWith(path + '/'));
    if (!targets.length) return 0;
    await putAll(this.projectId, [], targets.map(r => r.path));
    for (const r of targets) this.cache.delete(r.path);
    bus.emit('fs:changed', { type: 'delete', path, source, paths: targets.map(r => r.path) });
    return targets.length;
  }

  async rename(from, to, { source = 'user', overwrite = false } = {}) {
    from = posix.clean(from); to = posix.clean(to); validatePath(to);
    if (from === to) return;
    if (!this.exists(from)) throw new Error(`Not found: ${from}`);
    if (to.startsWith(from + '/')) throw new Error('Cannot move a folder into itself');
    if (this.exists(to) && !overwrite) throw new Error(`"${to}" already exists`);
    const targets = this.entries().filter(r => r.path === from || r.path.startsWith(from + '/'));
    const folders = this._folderRecords(to);
    const mapped = targets.map(r => ({ ...r, path: r.path === from ? to : to + r.path.slice(from.length), updatedAt: Date.now() }));
    const replaced = overwrite ? this.entries().filter(r => r.path === to || r.path.startsWith(to + '/')).map(r => r.path) : [];
    await putAll(this.projectId, [...folders, ...mapped], [...targets.map(r => r.path), ...replaced]);
    for (const p of replaced) this.cache.delete(p);
    for (const r of targets) this.cache.delete(r.path);
    for (const r of [...folders, ...mapped]) this.cache.set(r.path, r);
    bus.emit('fs:changed', { type: 'rename', path: from, to, source });
  }

  async copy(from, to, { source = 'user' } = {}) {
    from = posix.clean(from); to = posix.clean(to); validatePath(to);
    if (!this.exists(from)) throw new Error(`Not found: ${from}`);
    if (this.exists(to)) throw new Error(`"${to}" already exists`);
    const targets = this.entries().filter(r => r.path === from || r.path.startsWith(from + '/'));
    const items = targets.map(r => r.type === 'folder'
      ? { path: r.path === from ? to : to + r.path.slice(from.length), folder: true }
      : { path: r.path === from ? to : to + r.path.slice(from.length), content: r.content, blob: r.binary instanceof Blob ? r.binary : undefined, mime: r.mime });
    await this.writeMany(items, { source });
  }

  async clear({ source = 'user' } = {}) {
    const targets = this.entries().map(r => r.path);
    await putAll(this.projectId, [], targets);
    this.cache.clear();
    bus.emit('fs:changed', { type: 'reset', path: '', source });
  }

  /** Plain-text search across text files. Returns [{path, line, col, preview, match}]. */
  search(query, { regex = false, caseSensitive = false, wholeWord = false, limit = 2000, include = null } = {}) {
    if (!query) return [];
    let re;
    try {
      const src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(wholeWord ? `\\b(?:${src})\\b` : src, caseSensitive ? 'g' : 'gi');
    } catch (err) { throw new Error(`Invalid regular expression: ${err.message}`); }
    const out = [];
    for (const r of this.files()) {
      if (r.binary instanceof Blob) continue;
      if (include && !include(r.path)) continue;
      const lines = (r.content || '').split('\n');
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0; let m;
        while ((m = re.exec(lines[i]))) {
          out.push({ path: r.path, line: i + 1, col: m.index + 1, preview: lines[i].slice(0, 400), match: m[0], length: m[0].length });
          if (out.length >= limit) return out;
          if (!m[0].length) re.lastIndex++;
        }
      }
    }
    return out;
  }
}
