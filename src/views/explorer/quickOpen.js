// Quick Open "Go to File" provider (prefix '' in the ⌘P box): recently opened files first, fuzzy
// matching on the relative path with highlights, Seti icons, and "file.js:12:4" to jump to a position.

import { fuzzyMatch } from '../../core/dom.js';
import { bus } from '../../core/events.js';
import { workspace } from '../../core/workspace.js';
import { posix } from '../../core/path.js';
import { quickInput } from '../../platform/quickinput.js';
import { notify } from '../../platform/notifications.js';
import { editors } from '../../workbench/editors.js';
import { fileIconHtml } from '../../workbench/icons.js';

const HISTORY_KEY = 'quickOpen.history';
const MAX_HISTORY = 50;
const MAX_RESULTS = 200;
let history = [];
let saveTimer = 0;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => workspace.sessionSet(HISTORY_KEY, history).catch(() => {}), 500);
}
export function recordOpened(path) {
  if (!path) return;
  history = [path, ...history.filter(p => p !== path)].slice(0, MAX_HISTORY);
  persist();
}
export function recentFiles() { return history.filter(p => workspace.fs?.isFile(p)); }

/** Splits "src/app.js:12:4" into { query, line, col }. */
export function parseQuery(value) {
  const m = String(value || '').trim().match(/^(.*?)(?::(\d+))?(?::(\d+))?$/);
  if (!m) return { query: String(value || '').trim(), line: 0, col: 0 };
  return { query: m[1].trim(), line: Number(m[2] || 0), col: Number(m[3] || 0) };
}

/** Scores a path: basename matches beat path matches (like VS Code). → { score, labelMatches } | null */
export function scorePath(query, path) {
  const q = query.replace(/\s+/g, '');
  if (!q) return { score: 0, labelMatches: [] };
  const base = posix.basename(path);
  const dirLen = path.length - base.length;
  const onLabel = q.includes('/') ? null : fuzzyMatch(q, base);
  if (onLabel) return { score: 1000 + onLabel.score - (base.length - q.length) * 0.5, labelMatches: onLabel.matches };
  const onPath = fuzzyMatch(q, path);
  if (!onPath) return null;
  return { score: onPath.score, labelMatches: onPath.matches.filter(i => i >= dirLen).map(i => i - dirLen) };
}

function itemFor(path, { recent = false, labelMatches, line, col } = {}) {
  const dir = posix.dirname(path);
  return {
    id: path, path, label: posix.basename(path), description: dir, iconHtml: fileIconHtml(path),
    highlights: labelMatches?.length ? labelMatches : undefined, line, col,
    buttons: recent ? [{ icon: 'close', tooltip: 'Remove from Recently Opened', run: item => { history = history.filter(p => p !== item.path); persist(); return 'refresh'; } }] : undefined
  };
}

export const fileProvider = {
  placeholder: 'Search files by name (append : to go to line or @ to go to symbol)',
  helpText: 'Go to File',
  filter: false,
  provide(filter) {
    const fs = workspace.fs;
    if (!fs) return [{ label: 'Open a project to search its files.', disabled: true }];
    const { query, line, col } = parseQuery(filter);
    const recent = recentFiles();
    if (!query) {
      const items = [];
      if (recent.length) items.push({ kind: 'separator', label: 'recently opened' }, ...recent.map(p => itemFor(p, { recent: true, line, col })));
      const recentSet = new Set(recent);
      const rest = fs.files().map(r => r.path).filter(p => !recentSet.has(p)).slice(0, MAX_RESULTS);
      if (rest.length) { if (recent.length) items.push({ kind: 'separator', label: 'files' }); items.push(...rest.map(p => itemFor(p, { line, col }))); }
      if (!items.length) return [{ label: 'This project has no files yet.', disabled: true }];
      return items;
    }
    const recentRank = new Map(recent.map((p, i) => [p, i]));
    const scored = [];
    for (const r of fs.files()) {
      const s = scorePath(query, r.path);
      if (!s) continue;
      const rank = recentRank.get(r.path);
      scored.push({ path: r.path, score: s.score + (rank != null ? 60 - rank : 0), labelMatches: s.labelMatches, recent: rank != null });
    }
    scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
    const top = scored.slice(0, MAX_RESULTS);
    const recentHits = top.filter(s => s.recent);
    const others = top.filter(s => !s.recent);
    const items = [];
    if (recentHits.length) items.push({ kind: 'separator', label: 'recently opened' }, ...recentHits.map(s => itemFor(s.path, { recent: true, labelMatches: s.labelMatches, line, col })));
    if (others.length) { if (recentHits.length) items.push({ kind: 'separator', label: 'file results' }); items.push(...others.map(s => itemFor(s.path, { labelMatches: s.labelMatches, line, col }))); }
    return items;
  },
  async accept(item) {
    if (!item?.path) return;
    try {
      const reveal = item.line ? { line: item.line, col: item.col || 1, select: false } : undefined;
      await editors.open({ type: 'file', path: item.path }, { pinned: true, reveal });
    } catch (err) { notify.error(`Could not open '${item.label}': ${err.message}`); }
  }
};

export function registerQuickOpen() {
  quickInput.registerProvider('', fileProvider);
  const track = e => { if (e?.input?.type === 'file') recordOpened(e.input.path); };
  bus.on('editor:opened', track);
  bus.on('editor:activeChanged', track);
  bus.on('project:opened', async () => {
    history = [];
    try { const saved = await workspace.sessionGet(HISTORY_KEY, []); if (Array.isArray(saved)) history = [...history, ...saved.filter(p => !history.includes(p))].slice(0, MAX_HISTORY); } catch {}
  });
  bus.on('fs:changed', ev => {
    if (ev?.type === 'rename' && ev.to) {
      let changed = false;
      history = history.map(p => (p === ev.path || p.startsWith(ev.path + '/') ? (changed = true, ev.to + p.slice(ev.path.length)) : p));
      if (changed) persist();
    }
  });
}
