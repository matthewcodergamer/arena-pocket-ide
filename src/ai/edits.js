// AI file edits: path safety, SEARCH/REPLACE + full-file writes, Edit-mode staging and Agent-mode
// checkpointed application, plus keep / undo / diff for the chat UI.
//
// Modes:  'ask'   edit tools are refused (the model is told edits are disabled)
//         'edit'  edits are validated and staged as 'pending' (computed new contents, nothing written);
//                 keep() writes them (conflict check), undo() discards them
//         'agent' edits are written immediately after snapshotting the originals into a checkpoint;
//                 keep() marks them accepted, undo() restores the exact pre-turn content
//
// Edit records: { id, turnId, projectId, path, to?, kind: 'create'|'modify'|'delete'|'rename', added, removed,
//                 state: 'pending'|'applied'|'failed'|'kept'|'undone'|'discarded', error?, original, modified }

import { workspace } from '../core/workspace.js';
import { ProjectFS } from '../core/fs.js';
import { posix, validatePath, isTextPath } from '../core/path.js';
import { bus, Emitter } from '../core/events.js';
import { uid } from '../core/dom.js';
import { checkpoints } from './checkpoints.js';
import { applyBlocks, lineDiffStats, compileIgnore, findPlaceholder, numbered, toLf, detectEol, withEol } from './engine-match.js';

export const editEvents = new Emitter(); // 'changed' ({ turnId, edits })

const turns = new Map(); // turnId → turn
const MAX_TURNS = 60;

// ---------------------------------------------------------------- path safety

const DENY = [
  [/(^|\/)\.env(\.[^/]*)?$/i, 'environment files can contain secrets'],
  [/\.(pem|key|p12|pfx|keystore|jks)$/i, 'key/certificate files can contain secrets'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, 'SSH keys are secrets'],
  [/(^|\/)\.(npmrc|netrc|pypirc)$/i, 'credential files can contain secrets'],
  [/(^|\/)\.git(\/|$)/, '.git is managed by Source Control'],
  [/(^|\/)node_modules(\/|$)/, 'node_modules is not part of the project sources']
];
let ignoreCache = { text: null, fn: () => false };

function aiIgnore(fs) {
  const text = fs?.peekText?.('.aiignore') ?? '';
  if (text !== ignoreCache.text) ignoreCache = { text, fn: compileIgnore(text) };
  return ignoreCache.fn;
}

/** Why the AI may not touch `path` (null when allowed). */
export function deniedReason(path, fs = workspace.fs) {
  for (const [re, why] of DENY) if (re.test(path)) return why;
  try { if (aiIgnore(fs)(path)) return 'it matches a pattern in .aiignore'; } catch {}
  return null;
}
export const isDenied = (path, fs = workspace.fs) => !!deniedReason(path, fs);

/** Normalizes a model-supplied path → { ok, path } | { ok: false, error }. */
export function checkPath(raw, fs = workspace.fs, { allowRoot = false } = {}) {
  let p = String(raw ?? '').trim().replace(/^["'`]|["'`]$/g, '').replace(/\\/g, '/');
  p = p.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (/^(workspace|project)\//i.test(p) && fs && !fs.exists(p)) p = p.replace(/^[^/]+\//, '');
  p = posix.clean(p);
  if (!p) return allowRoot ? { ok: true, path: '' } : { ok: false, error: 'A path is required.' };
  try { validatePath(p); } catch (err) { return { ok: false, error: `Invalid path "${raw}": ${err.message}.` }; }
  const why = deniedReason(p, fs);
  if (why) return { ok: false, error: `Access to "${p}" is blocked (${why}).` };
  return { ok: true, path: p };
}

/** Closest existing file paths for a missing path (helps the model recover). */
export function suggestPaths(path, fs = workspace.fs, limit = 5) {
  if (!fs) return [];
  const base = posix.basename(path).toLowerCase();
  const stem = posix.stem(path).toLowerCase();
  const scored = [];
  for (const r of fs.files()) {
    const b = posix.basename(r.path).toLowerCase();
    let s = 0;
    if (b === base) s += 10;
    else if (posix.stem(r.path).toLowerCase() === stem) s += 6;
    else if (b.includes(stem) || stem.includes(posix.stem(r.path).toLowerCase())) s += 3;
    if (r.path.toLowerCase().endsWith(path.toLowerCase())) s += 5;
    if (s) scored.push([s, r.path]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(x => x[1]);
}

// ---------------------------------------------------------------- live text

let editorApi = null;
async function editorApiLoaded() {
  if (editorApi === null) editorApi = import('../editor/api.js').then(m => m.codeEditor).catch(() => false);
  return editorApi;
}
/** Current text of a file as the user sees it (unsaved editor changes included). */
export async function liveText(fs, path) {
  if (fs === workspace.fs) {
    try {
      const ed = await editorApiLoaded();
      if (ed && ed.isDirty?.(path)) { const t = ed.getText(path); if (t != null) return t; }
    } catch {}
  }
  return fs.readText(path);
}

// ---------------------------------------------------------------- turns

export function createTurn({ turnId = uid('turn'), mode = 'agent', projectId = workspace.id } = {}) {
  const turn = { id: turnId, mode, projectId, firstProjectId: projectId, edits: [], staged: new Map(), cps: new Map(), createdAt: Date.now() };
  turns.set(turnId, turn);
  if (turns.size > MAX_TURNS) turns.delete(turns.keys().next().value);
  return turn;
}
export const getTurn = id => turns.get(id) || null;

/** The agent created/switched to another project: later edits go there (with their own checkpoint). */
export function switchTurnProject(turn, projectId) {
  turn.projectId = projectId;
  turn.staged.clear();
}

async function fsForProject(projectId) {
  if (!projectId || projectId === workspace.id) return workspace.fs;
  const fs = new ProjectFS(projectId);
  await fs.load();
  return fs;
}

/** Text content of `path` within a turn (Edit-mode staged content wins). null = does not exist. */
export async function readInTurn(turn, fs, path) {
  if (turn?.staged.has(path)) return turn.staged.get(path);
  if (!fs.isFile(path)) return null;
  return liveText(fs, path);
}
export function existsInTurn(turn, fs, path) {
  if (turn?.staged.has(path)) return turn.staged.get(path) != null;
  return fs.exists(path);
}

export const publicEdit = e => ({ id: e.id, turnId: e.turnId, path: e.path, to: e.to, kind: e.kind, added: e.added, removed: e.removed, state: e.state, error: e.error, projectId: e.projectId });

function notifyChanged(turn) {
  editEvents.emit('changed', { turnId: turn.id, edits: turn.edits.map(publicEdit) });
  for (const [pid, cp] of turn.cps) {
    cp.edits = turn.edits.filter(e => e.projectId === pid).map(e => ({ ...publicEdit(e), strategy: e.strategy }));
    checkpoints.save(cp).catch(() => {});
  }
}

async function ensureCheckpoint(turn, projectId = turn.projectId) {
  let cp = turn.cps.get(projectId);
  if (!cp) {
    cp = await checkpoints.open({ projectId, turnId: turn.id, mode: turn.mode, suffix: projectId === turn.firstProjectId ? '' : projectId });
    turn.cps.set(projectId, cp);
  }
  return cp;
}
/** The first checkpoint id of a turn (for the runTurn result). */
export const turnCheckpointId = turn => [...turn.cps.values()][0]?.id || null;

function newEdit(turn, fields) {
  const edit = { id: uid('edit'), turnId: turn.id, projectId: turn.projectId, added: 0, removed: 0, state: 'pending', ...fields };
  turn.edits.push(edit);
  return edit;
}

/** Performs one change on disk (agent mode / keep). */
async function writeChange(fs, change) {
  const opts = { source: 'ai' };
  switch (change.kind) {
    case 'create':
    case 'modify':
      if (change.binary instanceof Blob) await fs.writeBinary(change.path, change.binary, opts);
      else await fs.writeText(change.path, change.modified ?? '', opts);
      break;
    case 'delete': await fs.remove(change.path, opts); break;
    case 'rename': await fs.rename(change.path, change.to, opts); break;
    case 'folder': await fs.mkdir(change.path, opts); break;
    default: throw new Error(`Unknown change ${change.kind}`);
  }
}

/**
 * Records a computed change in the turn: Agent mode snapshots + writes it now, Edit mode stages it.
 * change = { kind, path, to?, original, modified, binary? }  → edit record
 */
export async function commitChange(turn, fs, change, { signal } = {}) {
  if (signal?.aborted) throw abortError();
  const stats = change.binary ? { added: 0, removed: 0 } : lineDiffStats(change.original ?? '', change.modified ?? '');
  const edit = newEdit(turn, { ...change, ...stats, state: 'pending' });
  if (turn.mode === 'agent') {
    try {
      const cp = await ensureCheckpoint(turn);
      await checkpoints.snapshot(cp, fs, change.path);
      if (change.kind === 'rename') await checkpoints.snapshot(cp, fs, change.to);
      await writeChange(fs, change);
      edit.state = 'applied';
    } catch (err) {
      edit.state = 'failed';
      edit.error = err.message;
    }
  } else {
    // Edit mode: stage (nothing is written until keep)
    if (change.kind === 'delete') turn.staged.set(change.path, null);
    else if (change.kind === 'rename') { turn.staged.set(change.to, change.original); turn.staged.set(change.path, null); }
    else if (change.kind !== 'folder' && !change.binary) turn.staged.set(change.path, change.modified);
    edit.state = 'pending';
  }
  notifyChanged(turn);
  return edit;
}

export function recordFailure(turn, { kind = 'modify', path, to, error }) {
  const edit = newEdit(turn, { kind, path, to, state: 'failed', error, original: null, modified: null });
  notifyChanged(turn);
  return edit;
}

function abortError() { return Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' }); }

// ---------------------------------------------------------------- edit tools

/** Snippet of the changed region (for the model to verify its edit). */
function regionSnippet(text, startLine, endLine, context = 2, maxLines = 24) {
  const lines = toLf(text).split('\n');
  const a = Math.max(1, startLine - context), b = Math.min(lines.length, Math.max(endLine, startLine) + context);
  const slice = lines.slice(a - 1, Math.min(b, a - 1 + maxLines));
  return numbered(slice, a) + (b - a + 1 > maxLines ? `\n… (${b - a + 1 - maxLines} more lines)` : '');
}

/** write_file */
export async function writeFileTool(turn, fs, call, opts) {
  const chk = checkPath(call.attrs.path, fs);
  if (!chk.ok) return { ok: false, content: chk.error };
  const path = chk.path;
  if (fs.isFolder(path) && !turn.staged.has(path)) return { ok: false, content: `"${path}" is a folder.` };
  if (!isTextPath(path)) return { ok: false, content: `"${path}" is a binary file type; write_file only writes text. Use generate_image for images.` };
  const body = call.body ?? '';
  const original = existsInTurn(turn, fs, path) ? await readInTurn(turn, fs, path) : null;
  const hole = findPlaceholder(body, path);
  if (hole) {
    const msg = `Rejected: line ${hole.line} of the new content is a placeholder ("${hole.text}"). write_file ${original != null ? 'replaces the whole file' : 'creates the file'}, so it must contain the complete, final content — nothing elided. ${original != null ? 'For a partial change use edit_file with SEARCH/REPLACE blocks, or resend the complete file.' : 'Resend the complete file.'}`;
    const edit = recordFailure(turn, { kind: original == null ? 'create' : 'modify', path, error: `Placeholder at line ${hole.line}` });
    return { ok: false, content: msg, edit };
  }
  if (original != null && original.trim() && !body.trim()) {
    return { ok: false, content: `Rejected: write_file with empty content would erase "${path}". Use delete_file to delete it, or send the complete content.` };
  }
  let modified = body;
  if (original != null) {
    const eol = detectEol(original);
    modified = withEol(toLf(body), eol);
    if (original.endsWith('\n') && !modified.endsWith('\n') && modified) modified += eol;
  } else if (modified && !modified.endsWith('\n')) modified += '\n';
  if (original === modified) return { ok: true, content: `No changes: "${path}" already has exactly this content.`, unchanged: true };
  const edit = await commitChange(turn, fs, { kind: original == null ? 'create' : 'modify', path, original, modified }, opts);
  if (edit.state === 'failed') return { ok: false, content: `Could not write "${path}": ${edit.error}`, edit };
  const lines = toLf(modified).split('\n').length - (modified.endsWith('\n') ? 1 : 0);
  const verb = turn.mode === 'agent' ? (original == null ? 'Created' : 'Rewrote') : (original == null ? 'Staged new file' : 'Staged rewrite of');
  return { ok: true, content: `${verb} ${path} (${lines} lines, +${edit.added} −${edit.removed}).`, edit, path };
}

/** edit_file (SEARCH/REPLACE) */
export async function editFileTool(turn, fs, call, opts) {
  const chk = checkPath(call.attrs.path, fs);
  if (!chk.ok) return { ok: false, content: chk.error };
  const path = chk.path;
  const blocks = call.blocks || [];
  if (!blocks.length) return { ok: false, content: `edit_file ${path}: ${(call.blockErrors || ['no SEARCH/REPLACE blocks found']).join(' ')}` };
  const exists = existsInTurn(turn, fs, path);
  if (!exists) {
    if (blocks.every(b => !String(b.search || '').trim())) {
      return writeFileTool(turn, fs, { ...call, name: 'write_file', body: blocks.map(b => b.replace).join('\n') }, opts);
    }
    const near = suggestPaths(path, fs);
    return { ok: false, content: `edit_file: "${path}" does not exist.${near.length ? ` Did you mean: ${near.join(', ')}?` : ''} Use write_file to create a new file.` };
  }
  if (fs.isFolder(path) && !turn.staged.has(path)) return { ok: false, content: `"${path}" is a folder.` };
  if (fs.isBinary(path) && !turn.staged.has(path)) return { ok: false, content: `"${path}" is a binary file and cannot be edited as text.` };
  const original = await readInTurn(turn, fs, path);

  // Reject blocks whose REPLACE elides code with placeholders the SEARCH did not have.
  const usable = [], rejected = [];
  blocks.forEach((b, index) => {
    const hole = findPlaceholder(b.replace, path);
    if (hole && !findPlaceholder(b.search, path)) rejected.push({ index, error: `REPLACE contains a placeholder ("${hole.text}"). Write the complete replacement code — the REPLACE section replaces the SEARCH lines exactly.` });
    else usable.push({ ...b, index });
  });
  const res = applyBlocks(original, usable, { path });
  const failed = [
    ...res.failed.map(f => ({ ...f, index: usable[f.index].index })),
    ...rejected
  ].sort((a, b) => a.index - b.index);
  const applied = res.applied.map(a => ({ ...a, index: usable[a.index].index }));
  const total = blocks.length;
  const report = [];
  if (call.blockErrors?.length) report.push(`Format problems: ${call.blockErrors.join(' ')}`);

  if (!applied.length) {
    const edit = recordFailure(turn, { kind: 'modify', path, error: failed[0]?.error?.split('\n')[0] || 'No block matched' });
    report.unshift(`edit_file ${path}: none of the ${total} block(s) could be applied — the file is unchanged.`);
    for (const f of failed) report.push(`Block ${f.index + 1}: ${f.error}`);
    return { ok: false, content: report.join('\n\n'), edit };
  }
  if (!res.changed) return { ok: true, content: `edit_file ${path}: the REPLACE text equals the SEARCH text — nothing changed.`, unchanged: true };

  const edit = await commitChange(turn, fs, { kind: 'modify', path, original, modified: res.content }, opts);
  if (edit.state === 'failed') return { ok: false, content: `Could not write "${path}": ${edit.error}`, edit };
  edit.strategy = applied.map(a => a.strategy).join(',');
  const verb = turn.mode === 'agent' ? 'Edited' : 'Staged edit of';
  report.unshift(`${verb} ${path}: applied ${applied.length} of ${total} block(s) (+${edit.added} −${edit.removed}).`);
  const lfNew = toLf(res.content);
  for (const a of applied) {
    const how = a.strategy === 'exact' || a.strategy === 'eol' ? '' : ` (matched ${a.strategy === 'fuzzy' ? 'approximately' : `ignoring ${a.strategy}`})`;
    report.push(`Block ${a.index + 1}${how} — lines ${a.startLine}-${Math.max(a.startLine, a.endLine)} now read:\n${regionSnippet(lfNew, a.startLine, a.endLine)}`);
  }
  if (failed.length) {
    report.push(`${failed.length} block(s) were NOT applied (the successful blocks above are already in the file, so do not resend them):`);
    for (const f of failed) report.push(`Block ${f.index + 1}: ${f.error}`);
  }
  return { ok: !failed.length, partial: failed.length > 0, content: report.join('\n\n'), edit, path };
}

/** delete_file */
export async function deleteFileTool(turn, fs, call, opts) {
  const chk = checkPath(call.attrs.path, fs);
  if (!chk.ok) return { ok: false, content: chk.error };
  const path = chk.path;
  if (!existsInTurn(turn, fs, path)) return { ok: false, content: `"${path}" does not exist.` };
  const isFolder = fs.isFolder(path) && !turn.staged.has(path);
  const original = isFolder || fs.isBinary(path) ? null : await readInTurn(turn, fs, path);
  const edit = await commitChange(turn, fs, { kind: 'delete', path, original, modified: null, folder: isFolder }, opts);
  if (edit.state === 'failed') return { ok: false, content: `Could not delete "${path}": ${edit.error}`, edit };
  return { ok: true, content: `${turn.mode === 'agent' ? 'Deleted' : 'Staged deletion of'} ${path}${isFolder ? ' (folder)' : ''}.`, edit, path };
}

/** rename_file */
export async function renameFileTool(turn, fs, call, opts) {
  const a = checkPath(call.attrs.from, fs);
  let b = checkPath(call.attrs.to, fs);
  if (!a.ok) return { ok: false, content: a.error };
  if (!b.ok) return { ok: false, content: b.error };
  // "move into folder": rename_file from="a.js" to="src" (or "src/")
  if ((fs.isFolder(b.path) || /\/$/.test(String(call.attrs.to || '').trim())) && b.path !== a.path && !b.path.startsWith(a.path + '/')) {
    b = checkPath(`${b.path}/${posix.basename(a.path)}`, fs);
    if (!b.ok) return { ok: false, content: b.error };
  }
  if (!existsInTurn(turn, fs, a.path)) return { ok: false, content: `"${a.path}" does not exist.` };
  if (existsInTurn(turn, fs, b.path)) return { ok: false, content: `"${b.path}" already exists. Delete it first or choose another name.` };
  if (turn.mode !== 'agent' && fs.isFolder(a.path)) return { ok: false, content: 'Renaming folders is only available in Agent mode.' };
  const original = fs.isFolder(a.path) || fs.isBinary(a.path) ? null : await readInTurn(turn, fs, a.path);
  const edit = await commitChange(turn, fs, { kind: 'rename', path: a.path, to: b.path, original, modified: original }, opts);
  if (edit.state === 'failed') return { ok: false, content: `Could not rename: ${edit.error}`, edit };
  return { ok: true, content: `${turn.mode === 'agent' ? 'Renamed' : 'Staged rename of'} ${a.path} → ${b.path}. Update any references to the old path.`, edit, path: b.path };
}

/** create_folder (legacy protocol) */
export async function createFolderTool(turn, fs, call, opts) {
  const chk = checkPath(call.attrs.path, fs);
  if (!chk.ok) return { ok: false, content: chk.error };
  if (fs.exists(chk.path)) return { ok: true, content: `"${chk.path}" already exists.` };
  if (turn.mode !== 'agent') return { ok: true, content: `Folders are created automatically when files are written into them.` };
  const edit = await commitChange(turn, fs, { kind: 'folder', path: chk.path, original: null, modified: null }, opts);
  edit.kind = 'create';
  return { ok: edit.state !== 'failed', content: edit.state === 'failed' ? edit.error : `Created folder ${chk.path}.`, edit };
}

/** Writes a binary file produced by a tool (generate_image). */
export async function writeBinaryTool(turn, fs, path, blob, opts) {
  const edit = await commitChange(turn, fs, { kind: fs.exists(path) ? 'modify' : 'create', path, original: null, modified: null, binary: blob }, opts);
  return edit;
}

// ---------------------------------------------------------------- keep / undo / diff

async function loadTurn(turnId) {
  let turn = turns.get(turnId);
  if (turn) return turn;
  const cp = await checkpoints.forTurn(turnId);
  if (!cp) return null;
  // Rebuilt from the checkpoint after a reload (Agent mode, or Edit-mode edits that were kept).
  turn = { id: turnId, mode: cp.mode || 'agent', projectId: cp.projectId, firstProjectId: cp.projectId, edits: (cp.edits || []).map(e => ({ ...e, projectId: e.projectId || cp.projectId })), staged: new Map(), cps: new Map([[cp.projectId, cp]]), createdAt: cp.createdAt, restored: true };
  turns.set(turnId, turn);
  return turn;
}

function relatedEdits(turn, editId) {
  if (!editId) return turn.edits;
  const target = turn.edits.find(e => e.id === editId);
  if (!target) return [];
  const paths = new Set([target.path, target.to].filter(Boolean));
  // include every edit of the turn that touches the same file(s), transitively through renames
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of turn.edits) {
      if ((paths.has(e.path) || (e.to && paths.has(e.to))) && !(paths.has(e.path) && (!e.to || paths.has(e.to)))) {
        paths.add(e.path); if (e.to) paths.add(e.to); grew = true;
      }
    }
  }
  return turn.edits.filter(e => paths.has(e.path) || (e.to && paths.has(e.to)));
}

/**
 * Keep: Edit mode writes the pending edits (checking the files did not change since staging);
 * Agent mode marks applied edits as accepted. → { edits, written, errors }
 */
export async function keep(turnId, editId) {
  const turn = await loadTurn(turnId);
  if (!turn) throw new Error('These edits are no longer available.');
  const targets = relatedEdits(turn, editId);
  const written = [], errors = [];
  const fsCache = new Map();
  for (const e of targets) {
    if (e.state === 'applied') { e.state = 'kept'; continue; }
    if (e.state !== 'pending') continue;
    const pid = e.projectId || turn.projectId;
    if (!fsCache.has(pid)) fsCache.set(pid, await fsForProject(pid));
    const fs = fsCache.get(pid);
    try {
      // conflict check: the file must still be what the edit was computed from
      const opaque = e.binary || e.kind === 'folder' || e.folder || ((e.kind === 'delete' || e.kind === 'rename') && e.original == null);
      if (!opaque) {
        const current = fs.isFile(e.path) ? await liveText(fs, e.path) : (fs.exists(e.path) ? '' : null);
        const expected = e.original ?? null;
        if (current !== expected) throw new Error(`"${e.path}" changed since the edit was proposed. Ask X Coder to redo it.`);
      }
      const cp = await ensureCheckpoint(turn, pid);
      await checkpoints.snapshot(cp, fs, e.path);
      if (e.kind === 'rename') await checkpoints.snapshot(cp, fs, e.to);
      await writeChange(fs, e);
      e.state = 'kept';
      written.push(e.to || e.path);
    } catch (err) {
      e.state = 'failed'; e.error = err.message;
      errors.push(err.message);
    }
    turn.staged.delete(e.path); if (e.to) turn.staged.delete(e.to);
  }
  notifyChanged(turn);
  if (written.length) {
    bus.emit('ai:editsApplied', { summary: summarize(targets.filter(e => e.state === 'kept')), paths: written, turnId, projectId: turn.projectId });
  }
  return { edits: turn.edits.map(publicEdit), written, errors };
}

/**
 * Undo: Edit mode discards pending edits; Agent mode (and kept Edit-mode edits) restores the exact
 * pre-turn content from the checkpoint (all files, or the file(s) of one edit). → { edits, restored, errors }
 */
export async function undo(turnId, editId) {
  const turn = await loadTurn(turnId);
  if (!turn) throw new Error('These edits can no longer be undone (the checkpoint was not found).');
  const targets = relatedEdits(turn, editId);
  const byProject = new Map(); // projectId → Set(paths)
  for (const e of targets) {
    if (e.state === 'pending') { e.state = 'discarded'; turn.staged.delete(e.path); if (e.to) turn.staged.delete(e.to); }
    else if (e.state === 'applied' || e.state === 'kept') {
      const pid = e.projectId || turn.projectId;
      if (!byProject.has(pid)) byProject.set(pid, new Set());
      byProject.get(pid).add(e.path); if (e.to) byProject.get(pid).add(e.to);
    }
  }
  const restored = [], errors = [];
  for (const [pid, paths] of byProject) {
    const cp = turn.cps.get(pid) || await checkpoints.forTurn(turn.id, pid === turn.firstProjectId ? '' : pid);
    if (!cp) { errors.push('The checkpoint for these edits was not found.'); continue; }
    turn.cps.set(pid, cp);
    const fs = await fsForProject(pid);
    const res = await checkpoints.restore(cp, fs, [...paths]);
    restored.push(...res.restored);
    errors.push(...res.skipped.map(s => `${s.path}: ${s.reason}`));
    for (const e of targets) if ((e.projectId || turn.projectId) === pid && (e.state === 'applied' || e.state === 'kept') && paths.has(e.path)) e.state = 'undone';
    if (turn.edits.filter(e => (e.projectId || turn.projectId) === pid).every(e => !['applied', 'kept'].includes(e.state))) cp.undone = true;
  }
  notifyChanged(turn);
  return { edits: turn.edits.map(publicEdit), restored, errors };
}

/** → { path, original, modified, title } for the diff editor (null when unavailable). */
export async function diff(turnId, editId) {
  const turn = await loadTurn(turnId);
  const e = turn?.edits.find(x => x.id === editId) || (editId ? null : turn?.edits[0]);
  if (!e) return null;
  if (e.original === undefined && e.modified === undefined) {
    // restored from a checkpoint without contents: diff pre-turn snapshot vs current file
    const fs = await fsForProject(e.projectId || turn.projectId);
    const rec = turn.cps.get(e.projectId || turn.projectId)?.records.find(r => r.path === e.path)?.record;
    const original = rec && rec.content != null ? rec.content : '';
    const current = fs.isFile(e.to || e.path) ? (fs.peekText(e.to || e.path) ?? '') : '';
    return { path: e.to || e.path, original, modified: current, title: diffTitle(e) };
  }
  return { path: e.to || e.path, original: e.original ?? '', modified: e.kind === 'delete' ? '' : (e.modified ?? ''), title: diffTitle(e) };
}
function diffTitle(e) {
  const name = posix.basename(e.to || e.path);
  const what = { create: 'Created', modify: 'Modified', delete: 'Deleted', rename: 'Renamed' }[e.kind] || 'Changed';
  return `${name} (X Coder: ${what})`;
}

export function listTurnEdits(turnId) { return (turns.get(turnId)?.edits || []).map(publicEdit); }

/** Newest turn (this session or a stored checkpoint) with applied edits in the current project. */
export async function latestUndoableTurn(projectId = workspace.id) {
  const mem = [...turns.values()].reverse().find(t => t.projectId === projectId && t.edits.some(e => e.state === 'applied' || e.state === 'kept'));
  if (mem) return mem.id;
  const cp = await checkpoints.latest(projectId);
  return cp?.turnId || null;
}

export function summarize(edits) {
  const ok = edits.filter(e => ['applied', 'kept', 'pending'].includes(e.state));
  if (!ok.length) return 'No file changes';
  const parts = ok.slice(0, 4).map(e => `${{ create: 'Create', modify: 'Update', delete: 'Delete', rename: 'Rename' }[e.kind] || 'Update'} ${e.to ? `${e.path} → ${e.to}` : e.path}`);
  return parts.join(', ') + (ok.length > 4 ? ` and ${ok.length - 4} more` : '');
}
