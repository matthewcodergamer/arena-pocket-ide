// Format Document: Prettier 3 (lazy-loaded from jsDelivr, per-parser plugins) with a built-in fallback
// (JSON pretty-printing, otherwise re-indentation with the language's indentation rules + trimming
// trailing whitespace) so Format Document always does something useful — also offline.

import { state as S, language as L } from './cm.js';
import { workspace } from '../core/workspace.js';
import { output } from '../core/output.js';
import { notify } from '../platform/notifications.js';
import { loadSupport } from './languages.js';

const { EditorState } = S;
const { indentRange, indentUnit } = L;
const channel = () => output.channel('Formatter');

const CDN = 'https://cdn.jsdelivr.net/npm/prettier@3';
const PARSER = {
  javascript: ['babel', ['babel', 'estree']], javascriptreact: ['babel', ['babel', 'estree']],
  typescript: ['typescript', ['typescript', 'estree']], typescriptreact: ['typescript', ['typescript', 'estree']],
  json: ['json', ['babel', 'estree']], jsonc: ['jsonc', ['babel', 'estree']],
  css: ['css', ['postcss']], scss: ['scss', ['postcss']], less: ['less', ['postcss']],
  html: ['html', ['html', 'babel', 'estree', 'postcss']], vue: ['vue', ['html', 'babel', 'estree', 'postcss']],
  markdown: ['markdown', ['markdown', 'babel', 'estree']], yaml: ['yaml', ['yaml']]
};

let prettierCore = null;
const pluginCache = new Map();
let lastFailure = 0;
let offlineNotified = false;

function withTimeout(promise, ms, what) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out loading ${what}`)), ms))]);
}
async function loadPrettier(pluginNames) {
  if (Date.now() - lastFailure < 60_000) throw new Error('Prettier is unavailable (network)');
  try {
    if (!prettierCore) prettierCore = withTimeout(import(/* @vite-ignore */ `${CDN}/standalone.mjs`), 15000, 'Prettier').then(m => m.default || m);
    const core = await prettierCore;
    const plugins = await Promise.all(pluginNames.map(name => {
      if (!pluginCache.has(name)) pluginCache.set(name, withTimeout(import(/* @vite-ignore */ `${CDN}/plugins/${name}.mjs`), 15000, `Prettier ${name} plugin`).then(m => m.default || m));
      return pluginCache.get(name);
    }));
    return { prettier: core, plugins };
  } catch (err) {
    prettierCore = null;
    for (const name of pluginNames) pluginCache.delete(name);
    lastFailure = Date.now();
    throw err;
  }
}

function projectPrettierConfig() {
  const fs = workspace.fs;
  if (!fs) return {};
  for (const name of ['.prettierrc', '.prettierrc.json']) {
    const text = fs.peekText(name);
    if (text == null) continue;
    try { const cfg = JSON.parse(text); if (cfg && typeof cfg === 'object') return cfg; } catch {}
  }
  try { const pkg = JSON.parse(fs.peekText('package.json') || '{}'); if (pkg.prettier && typeof pkg.prettier === 'object') return pkg.prettier; } catch {}
  return {};
}

/** Built-in formatter: JSON pretty-print, otherwise re-indent every line + trim trailing whitespace. */
export async function builtinFormat(text, lang, { tabSize = 4, insertSpaces = true } = {}) {
  const unit = insertSpaces ? ' '.repeat(tabSize) : '\t';
  if (lang?.id === 'json') {
    try { return JSON.stringify(JSON.parse(text), null, unit) + (text.endsWith('\n') ? '\n' : ''); } catch {}
  }
  const support = await loadSupport(lang);
  let state = EditorState.create({ doc: text, extensions: [support || [], indentUnit.of(unit), EditorState.tabSize.of(tabSize)] });
  let out = text;
  if (support) {
    try {
      L.ensureSyntaxTree(state, state.doc.length, 2000);
      const changes = indentRange(state, 0, state.doc.length);
      out = changes.apply(state.doc).toString();
    } catch (err) { channel().warn('Re-indentation failed', err); }
  }
  return out.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n');
}

/**
 * Formats text for a language. Returns { text, formatter: 'Prettier' | 'built-in' }.
 * Throws when Prettier reports a syntax error (the document is left unchanged).
 */
export async function formatText(text, lang, opts = {}) {
  const entry = PARSER[lang?.id];
  if (entry) {
    let loaded = null;
    try { loaded = await loadPrettier(entry[1]); }
    catch (err) {
      channel().warn(`Prettier could not be loaded: ${err.message || err}`);
      if (!offlineNotified) {
        offlineNotified = true;
        notify.info('Prettier could not be downloaded (you may be offline). Format Document used the built-in formatter (re-indentation) instead.', { source: 'Formatter' });
      }
    }
    if (loaded) {
      const options = { parser: entry[0], plugins: loaded.plugins, tabWidth: opts.tabSize ?? 4, useTabs: opts.insertSpaces === false, printWidth: 80, endOfLine: 'lf', ...projectPrettierConfig(), filepath: opts.path };
      try {
        const formatted = await loaded.prettier.format(text, options);
        return { text: formatted, formatter: 'Prettier' };
      } catch (err) {
        channel().error(`Prettier failed for ${opts.path || lang.name}:`, String(err?.message || err));
        const e = new Error(String(err?.message || err).split('\n')[0]);
        e.syntax = true;
        throw e;
      }
    }
  }
  return { text: await builtinFormat(text, lang, opts), formatter: 'built-in' };
}

function minimalChange(a, b, offset = 0) {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) { endA--; endB--; }
  if (start === endA && start === endB) return null;
  return { from: offset + start, to: offset + endA, insert: b.slice(start, endB) };
}

/** Replaces the view's content with `next` using minimal per-line changes so cursors and folds stay put. */
export function applyMinimalChange(view, next, userEvent = 'format') {
  const lb = view.state.lineBreak;
  const cur = view.state.sliceDoc();
  next = String(next).replace(/\r\n|\r|\n/g, lb);
  if (cur === next) return false;
  const a = cur.split(lb), b = next.split(lb);
  const changes = [];
  if (a.length === b.length) {
    let offset = 0;
    for (let i = 0; i < a.length; i++) {
      const c = minimalChange(a[i], b[i], offset);
      if (c) changes.push(c);
      offset += a[i].length + 1;
    }
  } else {
    // Offsets are document positions: line breaks count as one position whatever their text form.
    const docA = a.join('\n'), docB = b.join('\n');
    const c = minimalChange(docA, docB, 0);
    if (c) changes.push({ ...c, insert: c.insert.split('\n').join(lb) });
  }
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent });
  return true;
}
