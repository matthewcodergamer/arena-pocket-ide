// Automatic verification of the agent's changes (Agent mode). Runs after the model's final answer when it
// changed files since the last check, so obvious breakage is fed back to the model instead of the user:
//
//   verifyChanges(turn, { fs, runPreview, signal, preview }) → { checked, problems: [string], report, previewRan }
//     · syntax of every changed JS / JSON / HTML inline script / CSS file (acorn, JSON.parse, brace balance)
//     · local references that do not resolve (<script src>, <link href>, <img src>, relative imports, CSS url())
//       in changed files — and in any file that still points at a path this turn deleted or renamed
//     · optionally a short headless preview run (runtime errors, network/CDN failures ignored)
//   missingReferences(fs, path, text) → [{ ref, line, resolved }]   (pure, used by tests too)

import { posix } from '../core/path.js';
import { syntaxProblems } from './tools.js';

const WEB_SOURCE = /\.(html?|m?js|cjs|jsx|tsx?|css|scss|less|svelte|vue)$/i;
const SKIP_REF = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{\{|\$\{|<%|@)/i; // http:, data:, blob:, mailto:, //cdn, #anchor, templates
const MODULE_EXT = ['', '.js', '.mjs', '.jsx', '.ts', '.tsx', '.json', '.css', '/index.js', '/index.mjs', '/index.ts', '/index.jsx', '/index.tsx'];

const blankOut = s => s.replace(/[^\n]/g, ' ');
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

function referencesIn(path, text) {
  const refs = [];
  const ext = posix.ext(path).toLowerCase();
  const push = (spec, index, kind) => {
    const s = String(spec || '').trim();
    if (!s || SKIP_REF.test(s)) return;
    refs.push({ spec: s, line: lineAt(text, index), kind });
  };
  if (ext === '.html' || ext === '.htm') {
    const src = text.replace(/<!--[\s\S]*?-->/g, blankOut);
    const tagRe = /<(script|img|source|audio|video|link|iframe|embed)\b([^>]*)>/gi;
    let m;
    while ((m = tagRe.exec(src))) {
      const tag = m[1].toLowerCase(), attrs = m[2];
      if (tag === 'link') {
        const rel = (/\brel\s*=\s*["']?([^"'>]+)/i.exec(attrs) || [])[1]?.toLowerCase() || '';
        if (!/stylesheet|manifest|modulepreload/.test(rel)) continue; // missing icons degrade gracefully
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
        if (href) push(href[1] ?? href[2] ?? href[3], m.index, 'html');
      } else {
        const s = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
        if (s) push(s[1] ?? s[2] ?? s[3], m.index, 'html');
      }
    }
    // inline module scripts
    const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    while ((m = scriptRe.exec(src))) {
      if (/\bsrc\s*=/.test(m[1])) continue;
      const offset = m.index + m[0].indexOf('>') + 1;
      for (const r of jsImports(m[2])) refs.push({ spec: r.spec, line: lineAt(text, offset + r.index), kind: 'module' });
    }
  } else if (/^\.(m?js|cjs|jsx|tsx?)$/.test(ext)) {
    for (const r of jsImports(text)) refs.push({ spec: r.spec, line: lineAt(text, r.index), kind: 'module' });
  } else if (ext === '.css' || ext === '.scss' || ext === '.less') {
    const src = text.replace(/\/\*[\s\S]*?\*\//g, blankOut);
    const re = /@import\s+(?:url\()?\s*["']([^"']+)["']|\burl\(\s*["']?([^"')]+?)["']?\s*\)/g;
    let m;
    while ((m = re.exec(src))) push(m[1] ?? m[2], m.index, 'css');
  }
  return refs;
}

function jsImports(code) {
  const out = [];
  const src = code.replace(/\/\*[\s\S]*?\*\//g, blankOut).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (s, pre) => pre + blankOut(s.slice(pre.length)));
  const res = [
    /\bimport\s+(?:[\w$*{}\s,]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(src))) {
      const spec = m[1];
      if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) out.push({ spec, index: m.index });
    }
  }
  return out;
}

/** Local references of a file that do not resolve to a project file. */
export function missingReferences(fs, path, text) {
  const out = [];
  const seen = new Set();
  for (const r of referencesIn(path, String(text || ''))) {
    const clean = r.spec.split(/[?#]/)[0];
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    let decoded = clean;
    try { decoded = decodeURIComponent(clean); } catch {}
    const base = decoded.startsWith('/') ? posix.clean(decoded.slice(1)) : posix.resolve(path, decoded);
    if (!base) continue;
    const candidates = r.kind === 'module' ? MODULE_EXT.map(e => base + e) : [base, base.endsWith('/') || !posix.ext(base) ? `${base.replace(/\/$/, '')}/index.html` : null].filter(Boolean);
    if (candidates.some(p => fs.isFile(p))) continue;
    out.push({ ref: r.spec, line: r.line, resolved: base });
  }
  return out;
}

const NETWORK_NOISE = /failed to fetch|networkerror|net::|err_[a-z_]+|load failed|failed to load|esm\.sh|jsdelivr|unpkg|cdnjs|googleapis|importing a module script failed|dynamically imported module|cors|access-control|timed? ?out|not available/i;

/**
 * Checks the files changed by a turn. `preview` is the preview API (optional), used when runPreview is true.
 */
export async function verifyChanges(turn, { fs, runPreview = false, preview = null, signal } = {}) {
  const problems = [];
  if (!turn || !fs) return { checked: 0, problems, report: '', previewRan: false };
  const live = turn.edits.filter(e => (e.state === 'applied' || e.state === 'kept') && (e.projectId || turn.projectId) === turn.projectId);
  const touched = [...new Set(live.filter(e => e.kind !== 'delete').map(e => e.to || e.path))].filter(p => fs.isFile(p) && !fs.isBinary(p));
  const gone = new Set(live.filter(e => e.kind === 'delete' || e.kind === 'rename').map(e => e.path));
  for (const p of gone) if (fs.exists(p)) gone.delete(p);

  let checked = 0;
  for (const path of touched.slice(0, 40)) {
    if (signal?.aborted) break;
    const text = fs.peekText(path);
    if (text == null) continue;
    checked++;
    const syntax = await syntaxProblems(path, text);
    if (syntax) problems.push(`${path}: ${syntax}`);
    if (WEB_SOURCE.test(path)) {
      for (const m of missingReferences(fs, path, text).slice(0, 12)) {
        problems.push(`${path}:${m.line}: references "${m.ref}", but ${m.resolved} does not exist in the project`);
      }
    }
  }
  // files the turn did not touch that still point at deleted/renamed paths
  if (gone.size) {
    const touchedSet = new Set(touched);
    for (const r of fs.files()) {
      if (touchedSet.has(r.path) || !WEB_SOURCE.test(r.path) || r.binary instanceof Blob) continue;
      for (const m of missingReferences(fs, r.path, r.content || '')) {
        const target = [...gone].find(g => m.resolved === g || MODULE_EXT.some(e => m.resolved + e === g));
        if (target) problems.push(`${r.path}:${m.line}: still references "${m.ref}", but ${target} was ${live.find(e => e.path === target)?.kind === 'rename' ? `renamed to ${live.find(e => e.path === target).to}` : 'deleted'} in this task`);
      }
      if (problems.length > 60) break;
    }
  }

  let previewRan = false;
  if (runPreview && preview?.captureRun && !signal?.aborted && touched.some(p => WEB_SOURCE.test(p))) {
    let entry = '';
    try { entry = preview.resolveEntry?.() || ''; } catch {}
    if (!/\.html?$/i.test(entry) || !fs.isFile(entry)) entry = fs.isFile('index.html') ? 'index.html' : '';
    if (entry) {
      try {
        const res = await preview.captureRun({ entry, timeoutMs: 4000 });
        const errors = (res?.errors || []).map(String).filter(e => e.trim() && !NETWORK_NOISE.test(e));
        const unavailable = (res?.errors || []).some(e => /preview is not available/i.test(String(e)));
        previewRan = !unavailable;
        for (const e of errors.slice(0, 10)) problems.push(`Runtime error in the preview of ${entry}: ${e.slice(0, 600)}`);
      } catch { /* the preview runner failed — not the model's fault */ }
    }
  }
  const report = problems.length
    ? `Automatic check of the ${checked} file(s) you changed found ${problems.length} problem(s):\n${problems.map(p => `- ${p}`).join('\n')}`
    : `Automatic check of the ${checked} file(s) you changed: no problems found${previewRan ? ' (the preview also ran without errors)' : ''}.`;
  return { checked, problems, report, previewRan };
}
