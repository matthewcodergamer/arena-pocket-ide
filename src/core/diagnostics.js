// Diagnostics service (Problems). Providers publish per-file markers under an owner name:
//   diagnostics.set('javascript', 'src/app.js', [{ line: 3, col: 5, endLine: 3, endCol: 9,
//                     severity: 'error'|'warning'|'info', message: 'Unexpected token', source: 'acorn', code? }])
//   diagnostics.clear('javascript', 'src/app.js')   // or clear(owner) for everything from that owner
//   diagnostics.forFile(path) → markers[]   diagnostics.all() → [{path, markers}]
//   diagnostics.counts() → {errors, warnings, infos}
// Lines/cols are 1-based. Emits bus 'diagnostics:changed'.

import { bus } from './events.js';

const store = new Map(); // owner → Map(path → markers[])
let scheduled = false;

function changed() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; bus.emit('diagnostics:changed', diagnostics.counts()); });
}

export const diagnostics = {
  set(owner, path, markers) {
    if (!store.has(owner)) store.set(owner, new Map());
    const byPath = store.get(owner);
    if (!markers?.length) byPath.delete(path);
    else byPath.set(path, markers.map(m => ({ severity: 'error', ...m, owner, path })));
    changed();
  },
  clear(owner, path) {
    if (!store.has(owner)) return;
    if (path == null) store.delete(owner); else store.get(owner).delete(path);
    changed();
  },
  /** Remove markers for a deleted path (all owners) or rename them. */
  removePath(path) {
    for (const byPath of store.values()) for (const p of [...byPath.keys()]) if (p === path || p.startsWith(path + '/')) byPath.delete(p);
    changed();
  },
  renamePath(from, to) {
    for (const byPath of store.values()) for (const [p, markers] of [...byPath.entries()]) {
      if (p === from || p.startsWith(from + '/')) {
        const np = to + p.slice(from.length);
        byPath.delete(p); byPath.set(np, markers.map(m => ({ ...m, path: np })));
      }
    }
    changed();
  },
  forFile(path) {
    const out = [];
    for (const byPath of store.values()) out.push(...(byPath.get(path) || []));
    return out.sort((a, b) => a.line - b.line || a.col - b.col);
  },
  all() {
    const byFile = new Map();
    for (const byPath of store.values()) for (const [p, markers] of byPath) {
      if (!byFile.has(p)) byFile.set(p, []);
      byFile.get(p).push(...markers);
    }
    return [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([path, markers]) => ({ path, markers: markers.sort((a, b) => sev(a) - sev(b) || a.line - b.line) }));
  },
  counts() {
    let errors = 0, warnings = 0, infos = 0;
    for (const byPath of store.values()) for (const markers of byPath.values()) for (const m of markers) {
      if (m.severity === 'error') errors++; else if (m.severity === 'warning') warnings++; else infos++;
    }
    return { errors, warnings, infos };
  },
  /** Plain-text summary for the AI agent. */
  summary(limit = 80) {
    const lines = [];
    for (const { path, markers } of this.all()) for (const m of markers) {
      lines.push(`${path}:${m.line}:${m.col} ${m.severity}: ${m.message}${m.source ? ` (${m.source})` : ''}`);
      if (lines.length >= limit) return lines.join('\n') + '\n…';
    }
    return lines.join('\n');
  }
};
function sev(m) { return m.severity === 'error' ? 0 : m.severity === 'warning' ? 1 : 2; }
