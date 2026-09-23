// Go Back / Go Forward (workbench.action.navigateBack / navigateForward): a cursor-location history
// across files. Locations are recorded on editor switches, reveals (Go to Line/Symbol/Problem, search
// results) and pointer jumps; nearby moves update the current entry instead of adding new ones.

import { editors } from '../workbench/editors.js';
import { workspace } from '../core/workspace.js';
import { bus } from '../core/events.js';

const MAX = 60;
let stack = [];
let index = -1;
let navigating = false;

export function recordLocation(path, line = 1, col = 1) {
  if (navigating || !path) return;
  const loc = { path, line, col };
  const cur = stack[index];
  if (cur && cur.path === path && Math.abs(cur.line - line) < 10) { stack[index] = loc; return; }
  stack = stack.slice(0, index + 1);
  stack.push(loc);
  if (stack.length > MAX) stack.shift();
  index = stack.length - 1;
  bus.emit('navigation:changed', { canGoBack: canGoBack(), canGoForward: canGoForward() });
}

export function canGoBack() { return index > 0; }
export function canGoForward() { return index >= 0 && index < stack.length - 1; }

async function go(to) {
  const loc = stack[to];
  if (!loc) return false;
  if (!workspace.fs?.exists(loc.path)) { stack.splice(to, 1); if (index >= stack.length) index = stack.length - 1; return false; }
  index = to;
  navigating = true;
  try { await editors.open({ type: 'file', path: loc.path }, { pinned: false, reveal: { line: loc.line, col: loc.col } }); }
  finally { navigating = false; }
  bus.emit('navigation:changed', { canGoBack: canGoBack(), canGoForward: canGoForward() });
  return true;
}
export function navigateBack() { return canGoBack() ? go(index - 1) : Promise.resolve(false); }
export function navigateForward() { return canGoForward() ? go(index + 1) : Promise.resolve(false); }

bus.on('project:opened', () => { stack = []; index = -1; });
bus.on('fs:changed', ev => {
  if (ev.type === 'rename') stack = stack.map(l => (l.path === ev.path || l.path.startsWith(ev.path + '/')) ? { ...l, path: ev.to + l.path.slice(ev.path.length) } : l);
});
