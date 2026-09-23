// Explorer tree model: builds a folder tree from ProjectFS records, sorts it like VS Code
// (explorer.sortOrder) and flattens the expanded part into rows, merging single-child folder
// chains into one row ("src/components") when explorer.compactFolders is on.

import { posix } from '../../core/path.js';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function cmpName(a, b) { return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); }
function extOf(node) { const i = node.name.lastIndexOf('.'); return i > 0 ? node.name.slice(i + 1).toLowerCase() : ''; }

export function comparator(sortOrder = 'default') {
  const foldersFirst = (a, b) => (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1);
  switch (sortOrder) {
    case 'mixed': return cmpName;
    case 'filesFirst': return (a, b) => (a.type === b.type ? cmpName(a, b) : a.type === 'file' ? -1 : 1);
    case 'type': return (a, b) => foldersFirst(a, b) || (a.type === 'file' ? collator.compare(extOf(a), extOf(b)) : 0) || cmpName(a, b);
    case 'modified': return (a, b) => foldersFirst(a, b) || (b.mtime - a.mtime) || cmpName(a, b);
    default: return (a, b) => foldersFirst(a, b) || cmpName(a, b);
  }
}

/** Builds { root, nodes } from fs records. Missing parent folders (legacy data) are synthesized. */
export function buildTree(entries, sortOrder = 'default') {
  const root = { path: '', name: '', type: 'folder', children: [], parent: null, mtime: 0 };
  const nodes = new Map([['', root]]);
  const ensureFolder = (path, rec) => {
    let node = nodes.get(path);
    if (node) { if (rec) node.mtime = rec.updatedAt || node.mtime; return node; }
    const parentPath = posix.dirname(path);
    const parent = ensureFolder(parentPath);
    node = { path, name: posix.basename(path), type: 'folder', children: [], parent, mtime: rec?.updatedAt || 0 };
    nodes.set(path, node);
    parent.children.push(node);
    return node;
  };
  for (const r of entries) {
    if (!r?.path) continue;
    if (r.type === 'folder') { ensureFolder(r.path, r); continue; }
    if (nodes.has(r.path)) continue;
    const parent = ensureFolder(posix.dirname(r.path));
    const node = { path: r.path, name: posix.basename(r.path), type: 'file', parent, mtime: r.updatedAt || 0, binary: r.binary instanceof Blob };
    nodes.set(r.path, node);
    parent.children.push(node);
  }
  const cmp = comparator(sortOrder);
  const sortRec = node => { node.children.sort(cmp); for (const c of node.children) if (c.type === 'folder') sortRec(c); };
  sortRec(root);
  return { root, nodes };
}

/**
 * Flattens expanded folders into rows.
 *   row = { kind: 'node', key, node, chain:[nodes], depth, parents:[row keys] }
 *       | { kind: 'input', key: '__input__', depth, parents, pinned: true }
 * opts: { expanded:Set, compact:bool, noCompact:Set, input:{ mode, parent, path }, sortOrder }
 */
export function flatten(root, { expanded, compact = true, noCompact = new Set(), input = null, sortOrder = 'default' } = {}) {
  const rows = [];
  const visit = (folder, depth, parents) => {
    const kids = folder.children;
    let inputAt = -1;
    if (input && input.mode !== 'rename' && input.parent === folder.path) {
      if (input.mode === 'newFolder' || sortOrder === 'mixed' || sortOrder === 'filesFirst') inputAt = 0;
      else { inputAt = kids.findIndex(k => k.type === 'file'); if (inputAt < 0) inputAt = kids.length; }
    }
    for (let i = 0; i <= kids.length; i++) {
      if (i === inputAt) rows.push({ kind: 'input', key: '__input__', depth, parents, pinned: true, mode: input.mode });
      const child = kids[i];
      if (!child) continue;
      if (child.type === 'folder') {
        const chain = [child];
        let end = child;
        if (compact) {
          while (!noCompact.has(end.path) && end.children.length === 1 && end.children[0].type === 'folder' && !noCompact.has(end.children[0].path)) {
            end = end.children[0];
            chain.push(end);
          }
        }
        const editing = input?.mode === 'rename' && input.path === end.path;
        rows.push({ kind: 'node', key: end.path, node: end, chain, depth, parents, editing, pinned: editing });
        if (expanded.has(end.path)) visit(end, depth + 1, [...parents, end.path]);
      } else {
        const editing = input?.mode === 'rename' && input.path === child.path;
        rows.push({ kind: 'node', key: child.path, node: child, chain: [child], depth, parents, editing, pinned: editing });
      }
    }
  };
  visit(root, 1, []);
  return rows;
}

/** Ancestor folder paths of `path` (excluding ''), outermost first. */
export function ancestorsOf(path) {
  const out = [];
  let dir = posix.dirname(path);
  while (dir) { out.unshift(dir); dir = posix.dirname(dir); }
  return out;
}

/** Removes paths nested inside other paths of the list (deleting "a" already deletes "a/b"). */
export function topLevelPaths(paths) {
  const sorted = [...new Set(paths)].filter(p => p !== '' && p != null).sort((a, b) => a.length - b.length);
  const out = [];
  for (const p of sorted) if (!out.some(o => p === o || p.startsWith(o + '/'))) out.push(p);
  return out;
}
