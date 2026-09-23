// IndexedDB access. The database name predates the X Coder rename; keeping it means
// every project created by earlier versions (Arena Pocket IDE, X Coder 3–5) opens unchanged.

export const DB_NAME = 'arena-pocket-ide-v1';
export const DB_VERSION = 3;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) {
        const s = db.createObjectStore('files', { keyPath: ['projectId', 'path'] });
        s.createIndex('projectId', 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains('checkpoints')) {
        const s = db.createObjectStore('checkpoints', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      // v3: base file contents from the last GitHub pull/push (for SCM diffs + discard)
      if (!db.objectStoreNames.contains('gitbase')) {
        const s = db.createObjectStore('gitbase', { keyPath: ['projectId', 'path'] });
        s.createIndex('projectId', 'projectId', { unique: false });
      }
      // v3: AI chat sessions
      if (!db.objectStoreNames.contains('chats')) {
        const s = db.createObjectStore('chats', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error || new Error('IndexedDB could not be opened')); };
    req.onblocked = () => console.warn('[X Coder] database upgrade is waiting for another open tab to close');
  });
  return dbPromise;
}

/**
 * Runs fn(store, tx) inside a transaction and resolves when it commits.
 * If fn returns an IDBRequest, resolves with its result; otherwise with fn's return value.
 * `stores` can be a name or an array of names (then fn receives the transaction's stores object map).
 */
export async function tx(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    try {
      out = Array.isArray(stores)
        ? fn(Object.fromEntries(stores.map(n => [n, t.objectStore(n)])), t)
        : fn(t.objectStore(stores), t);
    } catch (err) { try { t.abort(); } catch {} reject(err); return; }
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Database transaction aborted'));
  });
}

export const idbGet = (store, key) => tx(store, 'readonly', s => s.get(key));
export const idbGetAll = store => tx(store, 'readonly', s => s.getAll());
export const idbPut = (store, value) => tx(store, 'readwrite', s => s.put(value));
export const idbDelete = (store, key) => tx(store, 'readwrite', s => s.delete(key));

export async function idbGetAllByIndex(store, index, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).index(index).getAll(key);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** Deletes every record of `store` whose `projectId` index equals projectId. */
export async function idbDeleteByIndex(store, index, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const req = t.objectStore(store).index(index).openKeyCursor(IDBKeyRange.only(key));
    req.onsuccess = () => { const c = req.result; if (c) { t.objectStore(store).delete(c.primaryKey); c.continue(); } };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/** Key/value storage in the `settings` object store (used for per-project session state). */
export async function kvGet(key, fallback = null) {
  try { const rec = await idbGet('settings', key); return rec?.value ?? fallback; } catch { return fallback; }
}
export function kvSet(key, value) { return idbPut('settings', { key, value }); }
export function kvDelete(key) { return idbDelete('settings', key); }

/** Ask the browser not to evict local projects (best effort; Home Screen apps on iOS are already exempt from the 7-day cap). */
export async function requestPersistentStorage() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) return await navigator.storage.persist(); } catch {}
  return false;
}
