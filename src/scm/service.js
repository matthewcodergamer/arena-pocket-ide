// Source Control service: owns the Repository of the open project and implements the git operations
// against GitHub — clone, pull (merge remote changes into the working tree), local commits, push (with
// automatic rebase when the remote moved and different files changed), sync, publish, connect,
// branches, fetch, discard, stage/unstage and undo last commit. Operations run one at a time (queued).
//
// Algorithms (no git binary; GitHub's Git Data API is the remote):
//   HEAD (gitbase rows) = last commit (remote base + unpushed local commits); working tree = ProjectFS.
//   Pull/integrate compares, per path, the remote tree (R), the remote version our HEAD derives from (O)
//   and the working tree (W): remote-only changes are applied, local-only changes are kept, and paths
//   changed on both sides with different content are conflicts (overwrite prompt; push stops instead).
//   Push creates blobs → trees (base_tree = remote head tree) → commits (parent = remote head) for each
//   local commit, then fast-forwards the branch ref. An empty repository gets its first commit through
//   the Contents API (the Git Data API refuses to work until one exists) which is then replaced.

import { bus, Emitter } from '../core/events.js';
import { workspace } from '../core/workspace.js';
import { settings } from '../core/settings.js';
import { ProjectFS } from '../core/fs.js';
import { posix, mimeFromPath, validatePath } from '../core/path.js';
import { debounce, uid } from '../core/dom.js';
import { notify } from '../platform/notifications.js';
import { dialogs } from '../platform/dialogs.js';
import { editors } from '../workbench/editors.js';
import { GitHubClient, GitHubError, gitLog } from './github.js';
import { auth } from './auth.js';
import { Repository, emptyGit, writeRows, readRow, COMMIT_PREFIX, ORIGIN_PREFIX } from './model.js';
import { toStored, storedBytes, sha256Hex, pool, unifiedDiff, decodeText } from './util.js';

export const MAX_FILES = 3000;
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** Expected, user-facing failure (shown as a notification without a stack). */
export class GitError extends Error {
  constructor(message, { code = '', files = [], severity = 'error', actions = [] } = {}) { super(message); this.name = 'GitError'; this.code = code; this.files = files; this.severity = severity; this.actions = actions; }
}
/** The user cancelled (no notification). */
export class Cancelled extends Error { constructor(message = 'Cancelled') { super(message); this.name = 'Cancelled'; } }

export const scmEvents = new Emitter(); // 'changed' (repo) · 'busy' ({label} | null) · 'history' (repo) · 'message' (text)
export const gh = new GitHubClient(() => auth.token());

let current = null;
let ready = Promise.resolve();
let queue = Promise.resolve();
let busy = null;

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const listFiles = (paths, max = 8) => paths.slice(0, max).join('\n') + (paths.length > max ? `\n…and ${paths.length - max} more` : '');

// ---------------------------------------------------------------- repository lifecycle

async function openRepository() {
  if (!workspace.project || !workspace.fs) { current = null; return; }
  const repo = new Repository(workspace.project, workspace.fs);
  current = repo;
  ready = (async () => {
    try { await repo.load(); await repo.loadStaged(); }
    catch (err) { gitLog.error('Could not load Source Control data', err); }
    await refresh();
  })();
  scmEvents.emit('changed', repo);
  return ready;
}

/** Recomputes changes of the open repository and notifies views (bus 'git:changed'). */
let lastSignature = '';
export async function refresh() {
  const repo = current;
  if (!repo) return [];
  try { await repo.compute(); } catch (err) { gitLog.error('Computing changes failed', err); }
  if (repo !== current) return [];
  scmEvents.emit('changed', repo);
  const changes = repo.changes.map(c => ({ path: c.path, status: c.status, staged: repo.staged.has(c.path) }));
  const signature = `${repo.id}|${repo.git.repo}|${JSON.stringify(changes)}`;
  if (signature !== lastSignature) { lastSignature = signature; bus.emit('git:changed', { changes }); }
  return repo.changes;
}
const refreshSoon = debounce(() => { refresh(); }, 300);

export function initService() {
  bus.on('project:opened', () => { openRepository(); });
  bus.on('project:renamed', p => { if (current && p?.id === current.id) { p.git = current.git; current.project = p; } });
  bus.on('fs:changed', () => { if (current) refreshSoon(); });
  auth.onChange(() => scmEvents.emit('changed', current));
  if (workspace.project && workspace.fs) openRepository();
}

export const scm = {
  get repo() { return current; },
  get busy() { return busy; },
  ready: () => ready,
  refresh,
  /** Runs operations one at a time (like VS Code's git operation queue). */
  exclusive(label, fn) {
    const run = queue.then(async () => {
      busy = { label }; scmEvents.emit('busy', busy);
      try { return await fn(); }
      finally { busy = null; scmEvents.emit('busy', null); }
    });
    queue = run.catch(() => {});
    return run;
  }
};

// ---------------------------------------------------------------- remote access

/** Head commit + tree SHA of a branch. { head, treeSha, empty, missingBranch } */
export async function remoteHead(owner, name, branch) {
  let head;
  try { head = await gh.headOf(owner, name, branch); }
  catch (err) {
    if (err instanceof GitHubError && err.status === 409) return { empty: true, head: null, treeSha: null };
    if (err instanceof GitHubError && err.status === 404) {
      await gh.repo(owner, name); // throws a friendly 404 when the repository itself is missing or private
      return { missingBranch: true, head: null, treeSha: null };
    }
    throw err;
  }
  const commit = await gh.commit(owner, name, head);
  return { head, treeSha: commit?.tree?.sha || null, message: commit?.message || '' };
}

/** Loads the recursive tree of a remote head into { entries: Map(path → {sha, mode, size}), skipped, skippedSet }. */
export async function loadTree(owner, name, remote) {
  remote.entries = new Map(); remote.skipped = []; remote.skippedSet = new Set();
  if (!remote.treeSha) return remote;
  const t = await gh.tree(owner, name, remote.treeSha);
  if (t?.truncated) throw new GitError(`${owner}/${name} is too large for X Coder: GitHub truncated its file list.`);
  const items = Array.isArray(t?.tree) ? t.tree : [];
  const blobs = items.filter(e => e.type === 'blob');
  if (blobs.length > MAX_FILES) throw new GitError(`${owner}/${name} has ${blobs.length.toLocaleString()} files. X Coder works with repositories of up to ${MAX_FILES.toLocaleString()} files on a phone.`);
  for (const e of items) {
    if (e.type === 'commit') { remote.skipped.push({ path: e.path, reason: 'submodule' }); remote.skippedSet.add(e.path); continue; }
    if (e.type !== 'blob') continue;
    if ((e.size || 0) > MAX_FILE_SIZE) { remote.skipped.push({ path: e.path, size: e.size, reason: 'larger than 5 MB' }); remote.skippedSet.add(e.path); continue; }
    try { validatePath(e.path); } catch { remote.skipped.push({ path: e.path, reason: 'unsupported file name' }); remote.skippedSet.add(e.path); continue; }
    remote.entries.set(e.path, { sha: e.sha, mode: e.mode || '100644', size: e.size || 0 });
  }
  return remote;
}

async function fetchRemote(owner, name, branch) {
  const remote = await remoteHead(owner, name, branch);
  if (remote.head) await loadTree(owner, name, remote);
  else Object.assign(remote, { entries: new Map(), skipped: [], skippedSet: new Set() });
  return remote;
}

/** Downloads blobs (6 at a time, de-duplicated by SHA). Returns Map(path → {content|blob, sha, mode, bytes}). */
async function downloadAll(owner, name, list, onProgress) {
  const bySha = new Map();
  const out = new Map();
  let done = 0;
  const unique = [];
  for (const e of list) if (!bySha.has(e.sha)) { bySha.set(e.sha, null); unique.push(e.sha); }
  await pool(unique, 6, async sha => {
    bySha.set(sha, await gh.blobBytes(owner, name, sha));
    done++; onProgress?.(done, unique.length);
  });
  for (const e of list) {
    const bytes = bySha.get(e.sha);
    out.set(e.path, { ...toStored(e.path, bytes, mimeFromPath(e.path)), sha: e.sha, mode: e.mode || '100644', bytes });
  }
  return out;
}

function storedOf(rec) { return rec?.binary instanceof Blob ? { blob: rec.binary } : { content: rec?.content ?? '' }; }
function rowValue(row) { return row?.blob instanceof Blob ? { blob: row.blob } : { content: row?.content ?? '' }; }

function closeEditorsFor(paths) {
  for (const p of paths) for (const e of editors.findByPath(p)) editors.close(e.key, { force: true }).catch(() => {});
}

/** Removes folders left empty after files were deleted. */
async function pruneEmptyFolders(fs, deletedPaths) {
  const candidates = new Set();
  for (const p of deletedPaths) { let d = posix.dirname(p); while (d) { candidates.add(d); d = posix.dirname(d); } }
  const sorted = [...candidates].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const d of sorted) if (fs.isFolder(d) && !fs.list(d).length) await fs.remove(d, { source: 'git' }).catch(() => {});
}

/** Removes paths from unpushed local commits (after the remote version won). */
async function dropFromOutgoing(repo, paths) {
  const git = repo.git, set = new Set(paths), deletes = [];
  for (const c of git.outgoing) {
    for (const ch of c.changes) if (set.has(ch.path)) deletes.push(COMMIT_PREFIX + c.id + '/' + ch.path);
    c.changes = c.changes.filter(ch => !set.has(ch.path));
  }
  git.outgoing = git.outgoing.filter(c => c.changes.length);
  for (const p of set) { if (own(git.outgoingBase, p)) delete git.outgoingBase[p]; deletes.push(ORIGIN_PREFIX + p); }
  await writeRows(repo.id, [], deletes);
}

/**
 * Merges a remote tree into the working tree and HEAD.
 * mode 'pull' → conflicts prompt "Overwrite Local Changes"; mode 'push' → conflicts with local commits stop the push.
 * force → remote wins everywhere (clone / checkout).
 */
export async function integrate(repo, remote, { mode = 'pull', force = false, onProgress } = {}) {
  await repo.compute();
  const fs = repo.fs, git = repo.git;
  const { owner, name } = repo;
  const R = remote.entries || new Map();
  const skipped = remote.skippedSet || new Set();
  const legacy = git.snapshot || {};
  const ob = git.outgoingBase || (git.outgoingBase = {});
  const work = repo.status;
  const all = new Set([...R.keys(), ...repo.base.keys(), ...Object.keys(legacy), ...Object.keys(ob)]);
  const writes = [], deletes = [], adopt = [], baseDrop = [], legacyChecks = [], conflicts = [], resolvedOut = [];

  for (const p of all) {
    if (skipped.has(p)) continue;
    const r = R.get(p) || null;
    const rsha = r ? r.sha : null;
    const rec = fs.get(p);
    if (rec && rec.type !== 'file') { if (r) writes.push({ path: p, sha: rsha, mode: r.mode, replaceFolder: true }); continue; }
    const w = rec ? await repo.shaOf(rec) : null;
    const inOut = own(ob, p);
    const tracked = repo.base.has(p) || !!legacy[p];
    const locallyChanged = !force && (inOut || work.has(p) || (w !== null && !tracked));
    if (rsha === w) {
      // a local commit changed this path to something else than the remote (the working tree matches the
      // remote again): both sides changed it — resolve like any other conflict with a local commit
      if (inOut && !force && repo.headSha(p) !== w) { conflicts.push({ path: p, outgoing: true }); continue; }
      if (w !== null) { if (repo.headSha(p) !== w || legacy[p]) adopt.push({ path: p, sha: w, mode: r.mode }); }
      else if (repo.base.has(p)) baseDrop.push(p);
      if (inOut) resolvedOut.push({ path: p, sha: rsha });
      continue;
    }
    if (!locallyChanged) {
      if (r) writes.push({ path: p, sha: rsha, mode: r.mode });
      else deletes.push(p);
      if (inOut) resolvedOut.push({ path: p, sha: rsha, drop: true });
      continue;
    }
    // changed locally and different from the remote: did the remote change it too?
    let o = null, known = true;
    if (inOut) { o = ob[p]; if (typeof o === 'string' && o.startsWith('sha256:')) known = false; }
    else if (repo.base.has(p)) o = repo.headSha(p);
    else if (legacy[p]) known = false;
    if (known) {
      if (rsha === o) continue; // only we changed it → keep ours
      conflicts.push({ path: p, outgoing: inOut });
      continue;
    }
    if (!r) { conflicts.push({ path: p, outgoing: inOut }); continue; }
    legacyChecks.push({ path: p, sha: rsha, mode: r.mode, hash: inOut ? ob[p].slice(7) : legacy[p], inOut });
  }

  // X Coder 5 projects: the remote is unchanged when its bytes hash to the stored SHA-256
  let legacyDownloads = new Map();
  if (legacyChecks.length) {
    legacyDownloads = await downloadAll(owner, name, legacyChecks);
    for (const c of legacyChecks) {
      const d = legacyDownloads.get(c.path);
      if ((await sha256Hex(d.bytes)) !== c.hash) conflicts.push({ path: c.path, outgoing: c.inOut });
      else c.keep = true;
    }
  }

  if (conflicts.length) {
    const outgoingConflicts = conflicts.filter(c => c.outgoing).map(c => c.path);
    if (mode === 'push' && outgoingConflicts.length) {
      throw new GitError(`Can't push: the remote has new commits that also change ${plural(outgoingConflicts.length, 'file')} in your commits:\n${listFiles(outgoingConflicts)}\n\nPull to get the remote version (your changes to these files will be replaced), then make your edits again and commit.`, { code: 'conflict', files: outgoingConflicts, actions: [{ label: 'Pull', command: 'git.pull' }] });
    }
    const paths = conflicts.map(c => c.path);
    const choice = await dialogs.show({
      type: 'warning',
      message: `Your local changes to ${plural(paths.length, 'file')} would be overwritten by the incoming changes from origin/${repo.branch}.`,
      detail: `${listFiles(paths)}\n\nCommit & push or discard these changes first — or overwrite them with the remote version.`,
      buttons: ['Overwrite Local Changes', 'Cancel'], defaultId: 1, cancelId: 1
    });
    if (choice !== 0) throw new Cancelled('Pull cancelled because of conflicting local changes.');
    for (const c of conflicts) {
      const r = R.get(c.path);
      if (r) writes.push({ path: c.path, sha: r.sha, mode: r.mode }); else deletes.push(c.path);
      if (c.outgoing) resolvedOut.push({ path: c.path, sha: r?.sha ?? null, drop: true });
    }
  }

  // download and apply
  const downloads = writes.length ? await downloadAll(owner, name, writes, onProgress) : new Map();
  const items = [];
  for (const wr of writes) {
    const d = downloads.get(wr.path);
    if (wr.replaceFolder || fs.isFolder(wr.path)) await fs.remove(wr.path, { source: 'git' });
    // a remote file inside a path that is a local file ("a" file vs "a/b"): the file must go
    let parent = posix.dirname(wr.path);
    while (parent) { if (fs.isFile(parent)) await fs.remove(parent, { source: 'git' }); parent = posix.dirname(parent); }
    items.push(d.blob ? { path: wr.path, blob: d.blob, mime: mimeFromPath(wr.path) } : { path: wr.path, content: d.content });
  }
  if (items.length) await fs.writeMany(items, { source: 'git' });
  const removed = [];
  for (const p of deletes) if (fs.exists(p)) { await fs.remove(p, { source: 'git' }); removed.push(p); }
  if (removed.length) { closeEditorsFor(removed); await pruneEmptyFolders(fs, removed); }

  // HEAD
  const headRows = [], originRows = [], rowDeletes = [...deletes, ...baseDrop];
  for (const wr of writes) { const d = downloads.get(wr.path); headRows.push({ path: wr.path, sha: wr.sha, mode: wr.mode, ...rowValue(d) }); }
  for (const a of adopt) headRows.push({ path: a.path, sha: a.sha, mode: a.mode, ...storedOf(fs.get(a.path)) });
  for (const c of legacyChecks) {
    if (!c.keep) continue;
    const d = legacyDownloads.get(c.path);
    if (c.inOut) { ob[c.path] = c.sha; originRows.push({ path: ORIGIN_PREFIX + c.path, sha: c.sha, mode: c.mode, ...rowValue(d) }); }
    else headRows.push({ path: c.path, sha: c.sha, mode: c.mode, ...rowValue(d) });
  }
  const dropPaths = [];
  for (const ro of resolvedOut) {
    if (ro.drop) { dropPaths.push(ro.path); continue; }
    ob[ro.path] = ro.sha;
    if (ro.sha === null) rowDeletes.push(ORIGIN_PREFIX + ro.path);
    else originRows.push({ path: ORIGIN_PREFIX + ro.path, sha: ro.sha, mode: R.get(ro.path)?.mode, ...storedOf(fs.get(ro.path)) });
  }
  await writeRows(repo.id, [...headRows, ...originRows], rowDeletes);
  for (const p of rowDeletes) repo.base.delete(p);
  for (const r of headRows) repo.base.set(r.path, { sha: r.sha, mode: r.mode || '100644', binary: r.blob instanceof Blob });
  if (dropPaths.length) await dropFromOutgoing(repo, dropPaths);

  git.lastSyncSha = remote.head || null;
  git.lastSyncAt = Date.now();
  git.snapshot = {};
  repo.behind = 0;
  await repo.save();
  await repo.compute();
  return { updated: writes.length, deleted: removed.length, skipped: remote.skipped || [], overwritten: conflicts.length };
}

// ---------------------------------------------------------------- helpers for commands

export function requireRepo(repo = current) {
  if (!repo) throw new GitError('Open a project first.');
  if (!repo.connected) {
    throw new GitError('This project has no GitHub repository connected.', {
      severity: 'info',
      actions: [{ label: 'Publish to GitHub', command: 'git.publish' }, { label: 'Clone Repository', command: 'git.clone' }, { label: 'Connect Repository…', command: 'git.addRemote' }]
    });
  }
  return repo;
}

export async function requireAuth(reason = 'to push to GitHub') {
  if (auth.isSignedIn()) return auth.user;
  const choice = await dialogs.show({ type: 'info', message: `Sign in with GitHub ${reason}.`, detail: 'X Coder uses your GitHub account through the GitHub API. You can use a personal access token or sign in in the browser.', buttons: ['Sign in with GitHub', 'Cancel'], cancelId: 1 });
  if (choice !== 0) throw new Cancelled();
  const user = await auth.signIn();
  if (!user) throw new Cancelled();
  return user;
}

/** Unsaved editors among `paths` (or all changed files): asks like VS Code's git.promptToSaveFilesBeforeCommit. */
async function promptToSave(paths) {
  const set = paths ? new Set(paths) : null;
  const dirty = editors.list().filter(e => e.dirty && e.input?.path && (!set || set.has(e.input.path)));
  if (!dirty.length) return;
  const names = dirty.map(e => posix.basename(e.input.path));
  const choice = await dialogs.show({
    type: 'warning',
    message: dirty.length === 1 ? `The following file has unsaved changes which won't be included in the commit if you proceed: ${names[0]}.\n\nWould you like to save it before committing?` : `There are ${dirty.length} unsaved files.\n\nWould you like to save them before committing?`,
    buttons: [dirty.length === 1 ? 'Save & Commit Changes' : 'Save All & Commit Changes', 'Commit Changes', 'Cancel'], defaultId: 0, cancelId: 2
  });
  if (choice === 2) throw new Cancelled();
  if (choice === 0) { for (const e of dirty) await editors.save(e.key); await new Promise(r => setTimeout(r, 30)); }
}

// ---------------------------------------------------------------- operations

/** Creates a local commit of the staged changes (or `paths`, or all changes). */
export async function commitLocal(repo, message, { paths = null, all = false, skipSavePrompt = false } = {}) {
  requireRepo(repo);
  const msg = String(message || '').trim();
  if (!msg) throw new GitError('Please provide a commit message.', { severity: 'info' });
  if (!skipSavePrompt) await promptToSave(paths);
  await repo.compute();
  let selected;
  if (paths?.length) { const set = new Set(paths); selected = repo.changes.filter(c => set.has(c.path)); }
  else if (!all && repo.staged.size) selected = repo.changes.filter(c => repo.staged.has(c.path));
  else selected = repo.changes;
  if (!selected.length) throw new GitError('There are no changes to commit.', { severity: 'info' });
  const git = repo.git, ob = git.outgoingBase, legacy = git.snapshot;
  const id = uid('c').replace(/[^\w]/g, '');
  const rows = [], deletes = [], changes = [];
  for (const c of selected) {
    const p = c.path;
    const prev = repo.base.get(p);
    if (!own(ob, p)) {
      if (prev) {
        ob[p] = prev.sha;
        const row = await readRow(repo.id, p);
        if (row) rows.push({ path: ORIGIN_PREFIX + p, sha: row.sha, mode: row.mode, ...rowValue(row) });
      } else if (legacy[p]) ob[p] = `sha256:${legacy[p]}`;
      else ob[p] = null;
    }
    const mode = prev?.mode || '100644';
    if (c.status === 'D') { deletes.push(p); changes.push({ path: p, status: 'D', mode }); }
    else {
      const rec = repo.fs.get(p);
      const sha = await repo.shaOf(rec);
      const value = storedOf(rec);
      rows.push({ path: COMMIT_PREFIX + id + '/' + p, sha, mode, ...value });
      rows.push({ path: p, sha, mode, ...value });
      changes.push({ path: p, status: prev || legacy[p] ? 'M' : 'A', sha, mode });
    }
    delete legacy[p];
  }
  await writeRows(repo.id, rows, deletes);
  for (const p of deletes) repo.base.delete(p);
  for (const r of rows) if (r.path.charCodeAt(0) !== 1) repo.base.set(r.path, { sha: r.sha, mode: r.mode, binary: r.blob instanceof Blob });
  const commit = { id, message: msg, time: Date.now(), author: auth.user?.login || null, changes };
  git.outgoing.push(commit);
  for (const c of selected) repo.staged.delete(c.path);
  repo.saveStaged();
  await repo.save();
  gitLog.info(`> git commit -m "${msg.split('\n')[0]}" (${plural(changes.length, 'file')}, local commit ${id})`);
  if (repo === current) { await refresh(); scmEvents.emit('history', repo); }
  return commit;
}

/** Undoes the last unpushed local commit (its changes return to the working tree). Returns the commit. */
export async function undoLastCommit(repo) {
  requireRepo(repo);
  const git = repo.git;
  const c = git.outgoing.at(-1);
  if (!c) throw new GitError('There are no local commits to undo. Commits already pushed to GitHub cannot be undone here.', { severity: 'info' });
  const rows = [], deletes = [];
  for (const ch of c.changes) {
    const p = ch.path;
    let prevRow = null, found = false;
    for (let i = git.outgoing.length - 2; i >= 0; i--) {
      const e = git.outgoing[i].changes.find(x => x.path === p);
      if (e) { found = true; if (e.status !== 'D') prevRow = await readRow(repo.id, COMMIT_PREFIX + git.outgoing[i].id + '/' + p); break; }
    }
    if (!found) {
      const o = git.outgoingBase[p];
      if (typeof o === 'string' && o.startsWith('sha256:')) git.snapshot[p] = o.slice(7);
      else if (o) prevRow = await readRow(repo.id, ORIGIN_PREFIX + p);
      delete git.outgoingBase[p];
      deletes.push(ORIGIN_PREFIX + p);
    }
    if (prevRow) rows.push({ path: p, sha: prevRow.sha, mode: prevRow.mode, ...rowValue(prevRow) });
    else deletes.push(p);
    deletes.push(COMMIT_PREFIX + c.id + '/' + p);
  }
  await writeRows(repo.id, rows, deletes);
  for (const p of deletes) if (p.charCodeAt(0) !== 1) repo.base.delete(p);
  for (const r of rows) repo.base.set(r.path, { sha: r.sha, mode: r.mode || '100644', binary: r.blob instanceof Blob });
  git.outgoing.pop();
  await repo.save();
  gitLog.info(`> git reset --soft HEAD~1 (undid "${c.message.split('\n')[0]}")`);
  if (repo === current) { await refresh(); scmEvents.emit('history', repo); }
  return c;
}

/** Pushes unpushed local commits. Returns { pushed, sha }. */
export async function pushOutgoing(repo, { onProgress } = {}) {
  requireRepo(repo);
  const git = repo.git, { owner, name } = repo, branch = repo.branch;
  if (!git.outgoing.length) return { pushed: 0, sha: git.lastSyncSha };
  if (!auth.isSignedIn()) await requireAuth('to push your commits');
  const count = git.outgoing.length;
  gitLog.info(`> git push origin ${branch} (${plural(count, 'commit')})`);
  for (let attempt = 0; attempt < 2; attempt++) {
    let remote = await remoteHead(owner, name, branch);
    if (remote.missingBranch) {
      let from = git.lastSyncSha;
      if (!from) { const info = await gh.repo(owner, name); from = await gh.headOf(owner, name, info.default_branch); }
      gitLog.info(`Publishing branch ${branch}`);
      await gh.createRef(owner, name, branch, from);
      remote = await remoteHead(owner, name, branch);
    }
    let parent = remote.head, parentTree = remote.treeSha, force = false;
    // what exists at the parent (for deletions): remote tree when we fetched it, else the recorded remote versions
    let exists;
    if (remote.empty) {
      const first = git.outgoing[0];
      const file = first.changes.find(ch => ch.status !== 'D');
      if (!file) throw new GitError('Nothing to push: the first commit only deletes files.');
      const row = await readRow(repo.id, COMMIT_PREFIX + first.id + '/' + file.path);
      gitLog.info(`The repository is empty — creating its first commit with the Contents API (${file.path})`);
      await gh.putContents(owner, name, file.path, { message: first.message, bytes: await storedBytes(row), branch });
      parent = null; parentTree = null; force = true;
      exists = () => false;
    } else if (remote.head !== git.lastSyncSha) {
      gitLog.info(`origin/${branch} has new commits — integrating them before pushing`);
      await loadTree(owner, name, remote);
      await integrate(repo, remote, { mode: 'push', onProgress });
      parent = remote.head; parentTree = remote.treeSha;
      exists = p => remote.entries.has(p) || remote.skippedSet.has(p);
    } else {
      exists = p => (own(git.outgoingBase, p) ? git.outgoingBase[p] !== null : repo.base.has(p));
    }
    const present = new Map();
    const isPresent = p => (present.has(p) ? present.get(p) : exists(p));
    let lastSha = parent, lastTree = parentTree, uploaded = 0;
    const total = git.outgoing.reduce((n, c) => n + c.changes.filter(ch => ch.status !== 'D').length, 0);
    for (const c of git.outgoing) {
      const uploads = c.changes.filter(ch => ch.status !== 'D');
      const shas = new Map();
      await pool(uploads, 4, async ch => {
        const row = await readRow(repo.id, COMMIT_PREFIX + c.id + '/' + ch.path);
        if (!row) throw new GitError(`The content of ${ch.path} in the commit "${c.message}" is missing. Undo that commit and commit again.`);
        const sha = await gh.createBlob(owner, name, await storedBytes(row));
        if (ch.sha && sha !== ch.sha) gitLog.warn(`GitHub stored ${ch.path} as ${sha} (expected ${ch.sha})`);
        shas.set(ch.path, sha);
        uploaded++; onProgress?.(uploaded, total);
      });
      const entries = [];
      for (const ch of c.changes) {
        if (ch.status === 'D') { if (lastTree && isPresent(ch.path)) entries.push({ path: ch.path, mode: ch.mode || '100644', type: 'blob', sha: null }); present.set(ch.path, false); }
        else { entries.push({ path: ch.path, mode: ch.mode || '100644', type: 'blob', sha: shas.get(ch.path) }); present.set(ch.path, true); }
      }
      const tree = entries.length || !lastTree ? await gh.createTree(owner, name, { base_tree: lastTree || undefined, tree: entries }) : { sha: lastTree };
      const commit = await gh.createCommit(owner, name, { message: c.message, tree: tree.sha, parents: lastSha ? [lastSha] : [] });
      lastSha = commit.sha; lastTree = tree.sha;
    }
    try { await gh.updateRef(owner, name, branch, lastSha, force); }
    catch (err) {
      if (err instanceof GitHubError && err.status === 422 && attempt === 0 && !force) { gitLog.info('The remote changed during the push — retrying'); continue; }
      throw err;
    }
    git.lastSyncSha = lastSha;
    git.lastSyncAt = Date.now();
    git.outgoing = [];
    git.outgoingBase = {};
    repo.behind = 0;
    await repo.clearOutgoingRows();
    await repo.save();
    gitLog.info(`Pushed ${plural(count, 'commit')} to ${owner}/${name}@${branch} (${lastSha.slice(0, 7)})`);
    if (repo === current) { await refresh(); scmEvents.emit('history', repo); }
    return { pushed: count, sha: lastSha };
  }
  throw new GitError('The remote has new commits. Pull first.');
}

/** Pulls origin/<branch> into the working tree. Returns the integrate summary, or { upToDate: true }. */
export async function pull(repo, { onProgress } = {}) {
  requireRepo(repo);
  const { owner, name } = repo, branch = repo.branch, git = repo.git;
  gitLog.info(`> git pull origin ${branch}`);
  const remote = await remoteHead(owner, name, branch);
  if (remote.empty) { repo.behind = 0; return { upToDate: true, empty: true }; }
  if (remote.missingBranch) throw new GitError(`Branch '${branch}' doesn't exist on GitHub yet. Push to publish it, or check out another branch.`, { severity: 'warning' });
  if (remote.head === git.lastSyncSha && !repo.isLegacy) {
    repo.behind = 0;
    git.lastSyncAt = Date.now();
    await repo.save();
    if (repo === current) scmEvents.emit('changed', repo);
    return { upToDate: true };
  }
  await loadTree(owner, name, remote);
  const res = await integrate(repo, remote, { mode: 'pull', onProgress });
  gitLog.info(`Pulled ${owner}/${name}@${branch} (${remote.head.slice(0, 7)}): ${res.updated} updated, ${res.deleted} deleted`);
  if (repo === current) { await refresh(); scmEvents.emit('history', repo); }
  return res;
}

/** Checks GitHub for new commits (updates repo.behind). */
export async function fetchRemoteState(repo) {
  requireRepo(repo);
  const { owner, name } = repo, git = repo.git;
  const remote = await remoteHead(owner, name, repo.branch);
  let behind = 0, files = [], commits = [];
  if (remote.head && remote.head !== git.lastSyncSha) {
    if (git.lastSyncSha) {
      try {
        const cmp = await gh.compare(owner, name, git.lastSyncSha, remote.head);
        behind = cmp?.ahead_by ?? cmp?.total_commits ?? 1;
        files = (cmp?.files || []).map(f => ({ path: f.filename, status: f.status }));
        commits = cmp?.commits || [];
      } catch { behind = 1; }
    } else behind = null;
  }
  repo.behind = behind;
  if (repo === current) scmEvents.emit('changed', repo);
  return { head: remote.head, behind, files, commits, empty: !!remote.empty, missingBranch: !!remote.missingBranch };
}

/** Discards working tree changes (restores HEAD content, deletes untracked files). */
export async function discard(repo, paths) {
  requireRepo(repo);
  await repo.compute();
  const fs = repo.fs;
  const restores = [], removes = [], unavailable = [];
  for (const p of paths) {
    const status = repo.status.get(p);
    if (!status) continue;
    if (status === 'U') { removes.push(p); continue; }
    const base = await repo.baseContent(p);
    if (!base) { unavailable.push(p); continue; }
    restores.push(base.blob ? { path: p, blob: base.blob, mime: mimeFromPath(p) } : { path: p, content: base.content });
  }
  if (restores.length) await fs.writeMany(restores, { source: 'git' });
  for (const p of removes) await fs.remove(p, { source: 'git' });
  if (removes.length) { closeEditorsFor(removes); await pruneEmptyFolders(fs, removes); }
  for (const p of paths) repo.staged.delete(p);
  repo.saveStaged();
  gitLog.info(`> git restore ${paths.length === 1 ? paths[0] : `(${paths.length} files)`}`);
  if (repo === current) await refresh();
  if (unavailable.length) throw new GitError(`Base content unavailable — pull to refresh. ${plural(unavailable.length, 'file')} from an X Coder 5 project could not be restored:\n${listFiles(unavailable)}`, { severity: 'warning', actions: [{ label: 'Pull', command: 'git.pull' }] });
  return { restored: restores.length, deleted: removes.length };
}

/** Clones owner/repo into a new project and opens it. */
export async function cloneRepository(parsed, { branch: branchArg, onProgress, open = true } = {}) {
  gitLog.info(`> git clone https://github.com/${parsed.full}.git`);
  const info = await gh.repo(parsed.owner, parsed.repo);
  const full = info.full_name || parsed.full;
  const [owner, name] = full.split('/');
  const branch = branchArg || parsed.branch || info.default_branch || settings.get('git.defaultBranch', 'main') || 'main';
  const remote = await remoteHead(owner, name, branch);
  if (remote.missingBranch) throw new GitError(`Branch '${branch}' was not found in ${full}.`);
  if (remote.head) await loadTree(owner, name, remote);
  else Object.assign(remote, { entries: new Map(), skipped: [], skippedSet: new Set() });
  let project = null;
  try {
    project = await workspace.createProject(info.name || name, { files: {}, activate: false });
    project.git = emptyGit({ repo: full, branch });
    const fs = new ProjectFS(project.id);
    await fs.load();
    const repo = new Repository(project, fs);
    await repo.load();
    const res = await integrate(repo, remote, { force: true, onProgress });
    gitLog.info(`Cloned ${full}@${branch}: ${res.updated} files${res.skipped.length ? `, ${res.skipped.length} skipped` : ''}`);
    if (open) await workspace.openProject(project.id);
    return { project, files: res.updated, skipped: res.skipped, branch, full, empty: !!remote.empty };
  } catch (err) {
    if (project && workspace.project?.id !== project.id) await workspace.deleteProject(project.id).catch(() => {});
    throw err;
  }
}

/** Connects the open project to an existing GitHub repository and merges its files. */
export async function connectRepository(repo, parsed) {
  const info = await gh.repo(parsed.owner, parsed.repo);
  const full = info.full_name || parsed.full;
  const branch = parsed.branch || info.default_branch || settings.get('git.defaultBranch', 'main') || 'main';
  gitLog.info(`> git remote add origin https://github.com/${full}.git`);
  await repo.clearAll();
  repo.staged.clear(); repo.saveStaged();
  Object.assign(repo.git, emptyGit({ repo: full, branch }));
  await repo.save();
  if (repo === current) await refresh();
  const [owner, name] = full.split('/');
  const remote = await remoteHead(owner, name, branch);
  if (!remote.head) return { full, branch, empty: !!remote.empty, merged: false };
  await loadTree(owner, name, remote);
  try {
    const res = await integrate(repo, remote, { mode: 'pull' });
    return { full, branch, merged: true, ...res };
  } finally { if (repo === current) { await refresh(); scmEvents.emit('history', repo); } }
}

/** Disconnects the repository (files stay; Source Control data is removed). */
export async function disconnectRepository(repo) {
  const was = repo.git.repo;
  await repo.clearAll();
  repo.staged.clear(); repo.saveStaged();
  Object.assign(repo.git, emptyGit({ branch: settings.get('git.defaultBranch', 'main') || 'main' }));
  repo.behind = null;
  await repo.save();
  gitLog.info(`> git remote remove origin (${was})`);
  if (repo === current) { await refresh(); scmEvents.emit('history', repo); }
}

/** Creates a GitHub repository and publishes the chosen files as the first commit. */
export async function publishRepository(repo, { name, isPrivate, paths }) {
  const created = await gh.createRepo({ name, private: isPrivate, description: '' });
  gitLog.info(`Created ${created.private ? 'private' : 'public'} repository ${created.full_name}`);
  await repo.clearAll();
  const branch = settings.get('git.defaultBranch', 'main') || created.default_branch || 'main';
  Object.assign(repo.git, emptyGit({ repo: created.full_name, branch }));
  await repo.save();
  await repo.compute();
  await commitLocal(repo, 'first commit', { paths, skipSavePrompt: true });
  await pushOutgoing(repo);
  return created;
}

/**
 * Switches to another branch: the target tree replaces tracked files (uncommitted changes and unpushed
 * commits are dropped — callers confirm first). discardUntracked also deletes untracked files, but only
 * after the target branch was downloaded successfully.
 */
export async function checkoutBranch(repo, branch, { onProgress, discardUntracked = false } = {}) {
  requireRepo(repo);
  const { owner, name } = repo;
  gitLog.info(`> git checkout ${branch}`);
  const remote = await remoteHead(owner, name, branch);
  if (remote.missingBranch) throw new GitError(`Branch '${branch}' doesn't exist on GitHub.`);
  if (remote.head) await loadTree(owner, name, remote);
  else Object.assign(remote, { entries: new Map(), skipped: [], skippedSet: new Set() });
  if (discardUntracked) {
    await repo.compute();
    const untracked = repo.changes.filter(c => c.status === 'U').map(c => c.path);
    if (untracked.length) await discard(repo, untracked);
  }
  repo.git.outgoing = []; repo.git.outgoingBase = {};
  await repo.clearOutgoingRows();
  await integrate(repo, remote, { force: true, onProgress });
  repo.git.branch = branch;
  repo.staged.clear(); repo.saveStaged();
  await repo.save();
  if (repo === current) { await refresh(); scmEvents.emit('history', repo); }
}

/** Creates a branch at the current remote base (keeps local changes and commits) or from another branch. */
export async function createBranch(repo, branch, { from = null, discardUntracked = false } = {}) {
  requireRepo(repo);
  const { owner, name } = repo;
  if (from) {
    const head = await gh.headOf(owner, name, from);
    gitLog.info(`> git branch ${branch} origin/${from}`);
    await gh.createRef(owner, name, branch, head);
    await checkoutBranch(repo, branch, { discardUntracked });
    return;
  }
  gitLog.info(`> git checkout -b ${branch}`);
  if (repo.git.lastSyncSha) await gh.createRef(owner, name, branch, repo.git.lastSyncSha);
  repo.git.branch = branch;
  repo.behind = 0;
  await repo.save();
  if (repo === current) { await refresh(); scmEvents.emit('history', repo); }
}

// ---------------------------------------------------------------- diffs

/** Text of the HEAD version (null when untracked, binary or unavailable). */
export async function baseText(repo, path) {
  const b = await repo.baseContent(path);
  if (!b) return null;
  if (b.blob) { const t = decodeText(new Uint8Array(await b.blob.arrayBuffer())); return t; }
  return b.content;
}

/** Unified diff of one path or all changes (working tree vs HEAD). */
export async function diffText(repo, path) {
  await repo.compute();
  const list = path ? repo.changes.filter(c => c.path === path) : repo.changes;
  const parts = [];
  for (const c of list) {
    const rec = repo.fs.get(c.path);
    if (c.legacy) { parts.push(`diff --git a/${c.path} b/${c.path}\n# Base content unavailable — pull to refresh (project from X Coder 5).\n`); continue; }
    if (rec?.binary instanceof Blob || repo.base.get(c.path)?.binary) { parts.push(`diff --git a/${c.path} b/${c.path}\nBinary files differ\n`); continue; }
    const before = c.status === 'U' ? null : await baseText(repo, c.path);
    const after = c.status === 'D' ? null : (rec?.content ?? '');
    parts.push(unifiedDiff(c.path, before, after));
  }
  return parts.join('');
}
