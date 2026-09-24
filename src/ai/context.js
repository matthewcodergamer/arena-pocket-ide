// X Coder AI context: what the model sees about the project on the first message of a turn.
//
//   budgetFor(route) → { context, maxTokens, promptTokens, promptChars }
//   estimateTokens(textOrMessages)
//   buildEnvironment({ prompt, mode, attachments, envChars, fs }) → { text, images: [{name, url}], files: [paths], notes }
//   fileTree(fs, { maxEntries })          indented tree with sizes, folders collapsed past the limit
//   rankFiles(fs, prompt, { activePath, openPaths, codebase }) → [{ path, score, size }]   relevance scoring
//   projectProfile(fs) → ['Stack: …', 'Entry points: …', 'Note: …']   stack facts for the environment block
//   projectInstructions(fs)               AGENTS.md, .github/copilot-instructions.md, .xcoder/instructions.md, CLAUDE.md
//   prepareImage(dataUrl)                  downscales very large photos before upload
//
// Budget: tokens ≈ chars / 3.6; prompts are capped at ~70% of the model's context with max_tokens reserved.

import { workspace } from '../core/workspace.js';
import { posix, isImagePath } from '../core/path.js';
import { diagnostics } from '../core/diagnostics.js';
import { formatBytes } from '../core/dom.js';
import { isDenied, liveText } from './edits.js';
import { numbered } from './engine-match.js';

export const CHARS_PER_TOKEN = 3.6;
const MAX_PROMPT_TOKENS = 160000; // keep requests reasonable for phones even on 1M-token models
const IMAGE_TOKENS = 1100;

export function estimateTokens(x) {
  if (x == null) return 0;
  if (typeof x === 'string') return Math.ceil(x.length / CHARS_PER_TOKEN);
  if (Array.isArray(x)) return x.reduce((n, m) => n + estimateTokens(m), 0);
  if (typeof x === 'object') {
    if (x.type === 'text') return estimateTokens(x.text);
    if (x.type === 'image_url') return IMAGE_TOKENS;
    if ('content' in x) return 4 + estimateTokens(x.content);
  }
  return 0;
}

export function budgetFor(route) {
  const context = Math.max(4096, Number(route?.context) || 32000);
  let maxTokens = context >= 100000 ? 16384 : 8192;
  maxTokens = Math.min(maxTokens, Math.floor(context * 0.35));
  const promptTokens = Math.max(2000, Math.min(Math.floor(context * 0.7), context - maxTokens, MAX_PROMPT_TOKENS));
  return { context, maxTokens, promptTokens, promptChars: Math.floor(promptTokens * CHARS_PER_TOKEN) };
}

// ------------------------------------------------------------------ lazy cross-feature APIs

const lazy = {};
function load(name, loader) {
  if (!(name in lazy)) lazy[name] = loader().catch(() => null);
  return lazy[name];
}
export const apis = {
  editor: () => load('editor', () => import('../editor/api.js').then(m => m.codeEditor)),
  editors: () => load('editors', () => import('../workbench/editors.js').then(m => m.editors)),
  preview: () => load('preview', () => import('../preview/api.js').then(m => m.preview)),
  terminal: () => load('terminal', () => import('../panel/api.js').then(m => m.terminal)),
  git: () => load('git', () => import('../scm/api.js').then(m => m.git))
};

// ------------------------------------------------------------------ tree

const HIDDEN_DIRS = /(^|\/)(\.git|node_modules|\.cache|__pycache__|\.next|\.DS_Store)(\/|$)/;

export function visibleEntries(fs) {
  return fs.entries().filter(r => !HIDDEN_DIRS.test(r.path) && !isDenied(r.path, fs));
}

export function fileTree(fs, { maxEntries = 400, root = '', depth = Infinity } = {}) {
  const all = visibleEntries(fs).filter(r => posix.isInside(r.path, root) && r.path !== root);
  const baseDepth = root ? root.split('/').length : 0;
  const depthOf = p => p.split('/').length - 1 - baseDepth;
  const counts = new Map(); // folder → number of files below
  for (const r of all) if (r.type === 'file') {
    let d = posix.dirname(r.path);
    while (d && d !== root) { counts.set(d, (counts.get(d) || 0) + 1); d = posix.dirname(d); }
  }
  let limitDepth = Math.min(depth, 64);
  while (limitDepth > 0 && all.filter(r => depthOf(r.path) <= limitDepth).length > maxEntries) limitDepth--;
  const shown = all.filter(r => depthOf(r.path) <= limitDepth);
  // children sorted: folders first, then files (like the Explorer)
  const byParent = new Map();
  for (const r of shown) {
    const parent = posix.dirname(r.path);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(r);
  }
  for (const list of byParent.values()) list.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }) : a.type === 'folder' ? -1 : 1));
  const lines = [];
  let budget = maxEntries;
  const walk = (dir, indent) => {
    const kids = byParent.get(dir) || [];
    for (let i = 0; i < kids.length; i++) {
      if (budget <= 0) { lines.push(`${indent}… ${kids.length - i} more`); return; }
      const r = kids[i];
      budget--;
      const name = posix.basename(r.path);
      if (r.type === 'folder') {
        const n = counts.get(r.path) || 0;
        const collapsed = depthOf(r.path) >= limitDepth && n > 0;
        lines.push(`${indent}${name}/${collapsed ? ` (${n} file${n === 1 ? '' : 's'} inside)` : n ? '' : ' (empty)'}`);
        if (!collapsed) walk(r.path, indent + '  ');
      } else {
        lines.push(`${indent}${name} (${formatBytes(fs.size(r.path))})`);
      }
    }
  };
  walk(root, '');
  return lines.join('\n');
}

// ------------------------------------------------------------------ relevance

const STOP = new Set(('the and for with this that from into have has was are were can could should would will make made add fix change update use using please file files code project app page just like want need them they its not you your our what when where which how why who there here then than also some any all more most very really about into onto over under able been being does did done doing get got let lets put see seem want wants give show tell write create build new old same other each every much many make sure only still even well way thing things it\'s i\'m don\'t can\'t work working works').split(/\s+/));

export function promptTerms(prompt = '') {
  const text = String(prompt);
  const files = new Set((text.match(/[\w@./-]+\.[a-z0-9]{1,8}\b/gi) || []).map(s => s.replace(/^\.?\//, '').toLowerCase()));
  const idents = new Set((text.match(/\b[A-Za-z_$][\w$]*[A-Z_][\w$]*\b|\b[a-z]+(?:[A-Z][a-z0-9]+)+\b|#[\w-]{2,}|\.[a-z][\w-]{2,}\b/g) || []).map(s => s.replace(/^[#.]/, '')).filter(s => s.length >= 3));
  const words = new Set((text.toLowerCase().match(/[a-z0-9_$-]{3,}/g) || []).filter(w => !STOP.has(w) && !/^\d+$/.test(w)));
  for (const i of idents) words.delete(i.toLowerCase());
  return { files, idents, words };
}

const IMPORT_RES = [
  /\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /<(?:script|img|source|audio|video)\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<link\b[^>]*\bhref=["']([^"']+)["']/gi,
  /@import\s+(?:url\()?["']([^"']+)["']/g,
  /\burl\(\s*["']?([^"')]+)["']?\s*\)/g,
  /^\s*from\s+([\w.]+)\s+import\b/gm,
  /^\s*import\s+([\w.]+)\s*$/gm
];
const RESOLVE_EXT = ['', '.js', '.mjs', '.jsx', '.ts', '.tsx', '.json', '.css', '/index.js', '/index.ts', '/index.jsx', '/index.tsx', '.py', '/__init__.py'];

/** Project paths referenced by a file's imports/includes. */
export function importsOf(fs, path, text) {
  const out = new Set();
  if (!text) return out;
  for (const re of IMPORT_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      let spec = m[1];
      if (!spec || /^(https?:|data:|blob:|#|mailto:)/i.test(spec)) continue;
      if (/\.py$/.test(path) && !spec.includes('/') && !spec.startsWith('.')) spec = spec.replace(/\./g, '/');
      else if (!spec.startsWith('.') && !spec.startsWith('/')) continue; // bare package import
      const base = posix.resolve(path, spec);
      for (const ext of RESOLVE_EXT) { const p = base + ext; if (fs.isFile(p)) { out.add(p); break; } }
    }
  }
  return out;
}

const NOISE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock)$|\.min\.(js|css)$|\.map$/i;

/**
 * Scores every text file for relevance to the prompt.
 * Signals: files/identifiers/words mentioned in the prompt (path + content), the active file and its imports,
 * open editors, recently edited files, entry points, how many files import it (import graph) and, for
 * whole-codebase requests, README/manifests; lock files/minified/build output are penalized.
 */
export function rankFiles(fs, prompt, { activePath = null, activeText = null, openPaths = [], extraTerms = '', codebase = false } = {}) {
  const terms = promptTerms(`${prompt}\n${extraTerms}`);
  const files = visibleEntries(fs).filter(r => r.type === 'file' && !(r.binary instanceof Blob));
  const imports = activePath ? importsOf(fs, activePath, activeText ?? fs.peekText(activePath)) : new Set();
  const recent = new Set([...files].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 5).map(r => r.path));
  const open = new Set(openPaths);
  // import graph: files many others depend on are central to the project
  const importedBy = new Map();
  if (files.length <= 500) {
    for (const r of files) {
      if (!/\.(html?|m?js|cjs|jsx|tsx?|css|scss|py|vue|svelte)$/i.test(r.path) || !r.content || r.content.length > 300000) continue;
      for (const dep of importsOf(fs, r.path, r.content)) if (dep !== r.path) importedBy.set(dep, (importedBy.get(dep) || 0) + 1);
    }
  }
  const out = [];
  for (const r of files) {
    const path = r.path;
    const lower = path.toLowerCase();
    const base = posix.basename(lower);
    const content = r.content || '';
    const size = content.length;
    let score = 0;
    for (const f of terms.files) if (lower === f || lower.endsWith('/' + f) || base === posix.basename(f)) score += 30;
    for (const w of terms.words) {
      if (base.includes(w)) score += 6; else if (lower.includes(w)) score += 3;
    }
    if (size && size < 400000) {
      const lc = content.toLowerCase();
      for (const id of terms.idents) {
        let n = 0, i = content.indexOf(id);
        while (i >= 0 && n < 3) { n++; i = content.indexOf(id, i + id.length); }
        score += n * 4;
        if (n && new RegExp(`(function|class|const|let|var|def|id=["']|\\.)\\s*${id.replace(/[$]/g, '\\$')}\\b`).test(content)) score += 6;
      }
      for (const w of terms.words) {
        if (w.length < 4) continue;
        let n = 0, i = lc.indexOf(w);
        while (i >= 0 && n < 2) { n++; i = lc.indexOf(w, i + w.length); }
        score += n;
      }
    }
    if (path === activePath) score += 12;
    if (imports.has(path)) score += 8;
    if (open.has(path)) score += 5;
    if (recent.has(path)) score += 3;
    if (/^(index\.html?|main\.\w+|app\.\w+|package\.json|readme\.md|style\.css|styles\.css|script\.js)$/i.test(path)) score += 2;
    if (codebase && /^(readme\.md|package\.json|requirements\.txt|pyproject\.toml|agents\.md)$/i.test(path)) score += 8;
    score += Math.min(8, 2 * (importedBy.get(path) || 0));
    if (NOISE.test(path)) score -= 40;
    if (/(^|\/)(dist|build|out|coverage|vendor)\//.test(path)) score -= 10;
    if (size > 60000) score -= 5;
    out.push({ path, score, size });
  }
  return out.sort((a, b) => b.score - a.score || a.size - b.size);
}

// ------------------------------------------------------------------ project profile

const LANGS = [
  [/\.(jsx|tsx)$/i, 'JSX/TSX'], [/\.(ts|mts|cts)$/i, 'TypeScript'], [/\.(m?js|cjs)$/i, 'JavaScript'], [/\.html?$/i, 'HTML'],
  [/\.(css|scss|sass|less)$/i, 'CSS'], [/\.py$/i, 'Python'], [/\.(md|mdx)$/i, 'Markdown'], [/\.json$/i, 'JSON'],
  [/\.vue$/i, 'Vue'], [/\.svelte$/i, 'Svelte'], [/\.(java|kt)$/i, 'Java/Kotlin'], [/\.(c|h|cpp|hpp|cc)$/i, 'C/C++'],
  [/\.cs$/i, 'C#'], [/\.go$/i, 'Go'], [/\.rs$/i, 'Rust'], [/\.swift$/i, 'Swift'], [/\.php$/i, 'PHP'], [/\.rb$/i, 'Ruby'],
  [/\.(sh|bash|zsh)$/i, 'Shell'], [/\.sql$/i, 'SQL'], [/\.dart$/i, 'Dart'], [/\.lua$/i, 'Lua']
];
const FRAMEWORKS = [
  ['react', 'React'], ['preact', 'Preact'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['solid-js', 'Solid'], ['lit', 'Lit'],
  ['three', 'Three.js'], ['@react-three/fiber', 'React Three Fiber'], ['phaser', 'Phaser'], ['pixi.js', 'PixiJS'], ['p5', 'p5.js'],
  ['chart.js', 'Chart.js'], ['d3', 'D3'], ['jquery', 'jQuery'], ['alpinejs', 'Alpine.js'], ['tailwindcss', 'Tailwind CSS'],
  ['bootstrap', 'Bootstrap'], ['firebase', 'Firebase'], ['@supabase/supabase-js', 'Supabase'], ['next', 'Next.js'],
  ['vite', 'Vite'], ['express', 'Express'], ['fastify', 'Fastify'], ['koa', 'Koa'], ['@nestjs/core', 'NestJS'],
  ['typescript', 'TypeScript'], ['electron', 'Electron'], ['react-native', 'React Native'], ['expo', 'Expo']
];
const SERVER_ONLY = new Set(['Next.js', 'Express', 'Fastify', 'Koa', 'NestJS', 'Electron', 'React Native', 'Expo']);
const PY_SERVER = /^(flask|django|fastapi|uvicorn|tornado|aiohttp)\b/im;

/**
 * Stack facts for the environment block: languages, frameworks (package.json, requirements.txt, imports/CDN tags),
 * entry points and warnings about things that cannot run in the browser. → string lines
 */
export function projectProfile(fs) {
  const files = visibleEntries(fs).filter(r => r.type === 'file');
  if (!files.length) return [];
  const langCount = new Map();
  for (const r of files) {
    const hit = LANGS.find(([re]) => re.test(r.path));
    if (hit) langCount.set(hit[1], (langCount.get(hit[1]) || 0) + 1);
  }
  const langs = [...langCount.entries()].filter(([l]) => !['Markdown', 'JSON'].includes(l) || langCount.size <= 2)
    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, n]) => `${l} (${n})`);
  const found = new Set();
  const notes = [];
  let scripts = [];
  const pkg = files.find(r => r.path === 'package.json') || files.find(r => /(^|\/)package\.json$/.test(r.path) && !/node_modules/.test(r.path));
  if (pkg && !(pkg.binary instanceof Blob)) {
    try {
      const j = JSON.parse(pkg.content || '{}');
      const deps = { ...(j.dependencies || {}), ...(j.devDependencies || {}), ...(j.peerDependencies || {}) };
      for (const [name, label] of FRAMEWORKS) if (deps[name]) found.add(label);
      scripts = Object.keys(j.scripts || {}).slice(0, 8);
    } catch { notes.push(`${pkg.path} is not valid JSON.`); }
  }
  // imports / CDN tags in the sources (projects without package.json)
  let scanned = 0;
  for (const r of files) {
    if (scanned >= 60 || r.binary instanceof Blob || !/\.(html?|m?js|jsx|tsx?|vue|svelte)$/i.test(r.path)) continue;
    scanned++;
    const head = (r.content || '').slice(0, 6000);
    for (const [name, label] of FRAMEWORKS) {
      if (found.has(label)) continue;
      const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      if (new RegExp(`from\\s+["']${esc}(?:/[^"']*)?["']|import\\(\\s*["']${esc}["']|require\\(\\s*["']${esc}["']\\)|https?://[^"'\\s]*/${esc}(?:@[\\w.^~-]+)?(?:[/"'?]|\\.min\\.js|\\.js)`, 'i').test(head)) found.add(label);
    }
  }
  const req = files.find(r => /(^|\/)requirements\.txt$/.test(r.path));
  if (req && PY_SERVER.test(req.content || '')) notes.push(`${req.path} lists a Python web server framework — servers cannot run in the browser; only the pure-Python logic can be executed with Pyodide.`);
  const entries = files.map(r => r.path).filter(p => /^(index\.html?|main\.py|app\.py|main\.m?js|index\.m?js|src\/main\.(jsx?|tsx?)|src\/index\.(jsx?|tsx?)|src\/App\.(jsx|tsx))$/i.test(p)).slice(0, 6);
  const server = [...found].filter(f => SERVER_ONLY.has(f));
  if (server.length) notes.push(`${server.join(', ')} code needs a real Node.js server or build, which X Coder cannot run; the preview can only run the browser-side parts.`);
  if (scripts.length) notes.push(`package.json scripts (${scripts.join(', ')}) cannot run here — there is no npm; the preview runs the sources directly.`);
  const lines = [];
  if (langs.length) lines.push(`Stack: ${langs.join(', ')}${found.size ? ` · ${[...found].join(', ')}` : ''}`);
  if (entries.length) lines.push(`Entry points: ${entries.join(', ')}`);
  for (const n of notes) lines.push(`Note: ${n}`);
  return lines;
}

// ------------------------------------------------------------------ instructions

const INSTRUCTION_FILES = ['AGENTS.md', '.github/copilot-instructions.md', '.xcoder/instructions.md', 'CLAUDE.md'];
export function projectInstructions(fs = workspace.fs, maxChars = 8000) {
  if (!fs) return [];
  const out = [];
  let used = 0;
  for (const want of INSTRUCTION_FILES) {
    const rec = fs.files().find(r => r.path.toLowerCase() === want.toLowerCase());
    if (!rec || rec.binary instanceof Blob) continue;
    let text = (rec.content || '').trim();
    if (!text) continue;
    if (used + text.length > maxChars) text = text.slice(0, Math.max(0, maxChars - used)) + '\n…(truncated)';
    used += text.length;
    out.push({ path: rec.path, text });
    if (used >= maxChars) break;
  }
  return out;
}

// ------------------------------------------------------------------ images

function blobToDataURL(blob) {
  return blob.arrayBuffer().then(buf => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
  });
}

/** Downscales large images (≥ ~1.1 MB or > 2048 px) to ≤ 1600 px JPEG so uploads stay fast on phones;
 *  formats models cannot read (HEIC/HEIF, BMP, TIFF…) are converted to JPEG. */
export async function prepareImage(dataUrl, { maxSide = 1600, maxChars = 1_500_000 } = {}) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return dataUrl;
  if (/^data:image\/(svg|gif)/.test(dataUrl)) return dataUrl;
  try {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return dataUrl;
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const big = Math.max(bmp.width, bmp.height);
    // models accept PNG/JPEG/GIF/WebP only — iPhone HEIC/HEIF (and anything else) is always converted
    const standard = /^data:image\/(png|jpe?g|webp)[;,]/i.test(dataUrl);
    if (standard && dataUrl.length <= maxChars && big <= 2048) { bmp.close?.(); return dataUrl; }
    const scale = Math.min(1, maxSide / big);
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
    return await blobToDataURL(out);
  } catch { return dataUrl; }
}
export { blobToDataURL };

function svgSource(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma), data = dataUrl.slice(comma + 1);
  try {
    if (/;base64/i.test(meta)) return new TextDecoder().decode(Uint8Array.from(atob(data), c => c.charCodeAt(0)));
    return decodeURIComponent(data);
  } catch { return '(the SVG could not be decoded)'; }
}

// ------------------------------------------------------------------ environment

function deviceLine() {
  try {
    const ua = navigator.userAgent || '';
    const w = Math.round(window.innerWidth || 0), h = Math.round(window.innerHeight || 0);
    const kind = /iPhone/.test(ua) ? 'iPhone' : /iPad|Macintosh.*Mobile/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
      : /Android.*Mobile/.test(ua) ? 'Android phone' : /Android/.test(ua) ? 'Android tablet' : 'desktop browser';
    const standalone = matchMedia?.('(display-mode: standalone)')?.matches || navigator.standalone === true;
    return `${kind}${w ? ` (${w}×${h} viewport)` : ''}${standalone ? ', Home Screen app' : ''}`;
  } catch { return 'browser'; }
}

function fileBlock(path, text, { maxChars, maxLines = 1500, focusLine = null } = {}) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  let start = 1, end = total;
  let body = numbered(lines, 1);
  if (total > maxLines || body.length > maxChars) {
    const avgLine = body.length / Math.max(1, total);
    const fit = Math.max(20, Math.min(maxLines, Math.floor(maxChars / Math.max(8, avgLine))));
    if (focusLine && focusLine > fit / 2) start = Math.max(1, Math.min(total - fit + 1, focusLine - Math.floor(fit / 2)));
    end = Math.min(total, start + fit - 1);
    body = numbered(lines.slice(start - 1, end), start);
    if (body.length > maxChars) body = body.slice(0, maxChars) + '\n…';
  }
  const partial = start !== 1 || end !== total;
  return `<file path="${path}" lines="${start}-${end} of ${total}"${partial ? ' partial="true"' : ''}>\n${body}\n</file>${partial ? `\n(Only lines ${start}-${end} are shown — use read_file with start_line/end_line for the rest.)` : ''}`;
}

const CASUAL = /^\s*(hi|hello|hey|yo|sup|thanks|thank you|thx|ok|okay|cool|nice|great|good (morning|afternoon|evening|night)|how are you|who are you|what can you do)\b[\s!.?,]*$/i;
export const isCasualPrompt = prompt => CASUAL.test(prompt || '') && String(prompt).length < 40;

/**
 * Builds the <environment> block for the first message of a turn.
 * envChars = characters available for it; sections are added by priority and trimmed to fit.
 */
export async function buildEnvironment({ prompt = '', mode = 'agent', attachments = [], envChars = 60000, fs = workspace.fs, project = workspace.project, includeOpenEditors = true } = {}) {
  const images = [], included = [], notes = [];
  if (!fs) return { text: '<environment>\nNo project is open.\n</environment>', images, files: included, notes };
  const casual = isCasualPrompt(prompt);
  const sections = [];
  let used = 0;
  const add = (text, cap = Infinity) => {
    if (!text) return 0;
    let t = text;
    const room = Math.min(cap, envChars - used);
    if (room <= 200) return 0;
    if (t.length > room) t = t.slice(0, room - 20) + '\n…(truncated)';
    sections.push(t);
    used += t.length + 2;
    return t.length;
  };

  const files = visibleEntries(fs).filter(r => r.type === 'file');
  const totalBytes = files.reduce((n, r) => n + fs.size(r.path), 0);
  const [editorApi, editorsApi, previewApi] = await Promise.all([apis.editor(), apis.editors(), apis.preview()]);
  let entry = '';
  try { entry = previewApi?.resolveEntry?.() || ''; } catch {}
  const date = new Date();
  add([
    `Project: ${project?.name || 'Untitled'} — ${files.length} file${files.length === 1 ? '' : 's'}, ${formatBytes(totalBytes)} (stored locally in the browser)`,
    `Date: ${date.toISOString().slice(0, 10)} (${date.toLocaleDateString('en-US', { weekday: 'long' })})`,
    `Mode: ${mode}`,
    `Device: ${deviceLine()}`,
    ...(() => { try { return projectProfile(fs); } catch { return []; } })(),
    entry && fs.exists(entry) ? `Preview entry: ${entry}` : ''
  ].filter(Boolean).join('\n'));

  // file tree
  const treeEntries = envChars < 30000 ? 150 : envChars < 80000 ? 300 : 400;
  const tree = fileTree(fs, { maxEntries: treeEntries });
  add(`Files:\n${tree || '(empty project)'}`, Math.max(2000, envChars * 0.25));

  // open editors + active file
  let activePath = null, activeText = null, openPaths = [];
  if (includeOpenEditors) try {
    const list = editorsApi?.list?.() || [];
    openPaths = list.map(e => e.input?.path).filter(p => p && fs.isFile(p));
  } catch {}
  let active = null;
  if (includeOpenEditors) try { active = editorApi?.getActive?.() || null; } catch {}
  if (active?.path && fs.isFile(active.path) && !isDenied(active.path, fs)) {
    activePath = active.path;
    try { activeText = active.getText(); } catch { activeText = fs.peekText(activePath); }
  }
  if (openPaths.length) {
    const dirty = p => { try { return editorApi?.isDirty?.(p); } catch { return false; } };
    add(`Open editors: ${openPaths.slice(0, 20).map(p => `${p}${p === activePath ? ' (active)' : ''}${dirty(p) ? ' (unsaved changes)' : ''}`).join(', ')}`);
  }
  if (activePath && activeText != null) {
    let cursor = '';
    let focusLine = null;
    try {
      const sel = active.getSelection();
      focusLine = sel.startLine;
      cursor = sel.text ? `selection lines ${sel.startLine}-${sel.endLine}` : `cursor at line ${sel.startLine}, column ${sel.startCol}`;
    } catch {}
    const cap = casual ? 3000 : Math.max(3000, envChars * 0.3);
    add(`Active file: ${activePath}${cursor ? ` — ${cursor}` : ''}\n${fileBlock(activePath, activeText, { maxChars: cap - 300, focusLine })}`, cap);
    included.push(activePath);
  }

  // problems
  const counts = diagnostics.counts();
  if (counts.errors || counts.warnings) {
    add(`Problems (${counts.errors} error${counts.errors === 1 ? '' : 's'}, ${counts.warnings} warning${counts.warnings === 1 ? '' : 's'}):\n${diagnostics.summary(40)}`, 4000);
  }

  // source control
  try {
    const git = await apis.git();
    if (git?.isConnected?.()) {
      const remote = git.remote?.();
      const changes = await Promise.race([git.getChanges(), new Promise(r => setTimeout(() => r(null), 1500))]);
      if (Array.isArray(changes)) {
        add(`Source control: GitHub ${remote?.repo || ''}${remote?.branch ? `@${remote.branch}` : ''} — ${changes.length ? `${changes.length} changed file(s): ${changes.slice(0, 30).map(c => `${c.status} ${c.path}`).join(', ')}` : 'no changes since the last pull/push'}`, 2500);
      }
    }
  } catch {}

  // attachments (explicit context from the user — high priority)
  let wantCodebase = false;
  const attachParts = [];
  for (const a of attachments || []) {
    try {
      if (a.type === 'image' && /^data:image\/svg/i.test(a.dataUrl || '')) {
        // vector images are sent as their source (models only accept raster images)
        const svg = svgSource(a.dataUrl);
        attachParts.push(`<attachment type="svg" name="${a.name || 'image.svg'}">\n${svg.slice(0, 40000)}\n</attachment>`);
      } else if (a.type === 'image' && a.dataUrl) { images.push({ name: a.name || 'image', url: await prepareImage(a.dataUrl) }); attachParts.push(`<attachment type="image" name="${a.name || 'image'}"/> (shown below)`); }
      else if (a.type === 'file' && a.path) {
        const p = posix.clean(a.path);
        if (isDenied(p, fs)) { notes.push(`${p} is protected and was not attached.`); continue; }
        if (!fs.isFile(p)) { attachParts.push(`<attachment type="file" path="${p}">(file not found)</attachment>`); continue; }
        if (isImagePath(p) && !p.endsWith('.svg')) { images.push({ name: p, url: await prepareImage(await fs.readDataURL(p)) }); attachParts.push(`<attachment type="image" path="${p}"/> (shown below)`); continue; }
        if (fs.isBinary(p)) { attachParts.push(`<attachment type="file" path="${p}">(binary file, ${formatBytes(fs.size(p))})</attachment>`); continue; }
        const text = await liveText(fs, p);
        attachParts.push(fileBlock(p, text, { maxChars: Math.max(4000, envChars * 0.35) }).replace('<file ', '<attachment type="file" ').replace(/<\/file>/, '</attachment>'));
        included.push(p);
      } else if (a.type === 'text') {
        attachParts.push(`<attachment type="text" name="${a.name || 'text'}">\n${String(a.text || '').slice(0, Math.max(4000, envChars * 0.35))}\n</attachment>`);
      } else if (a.type === 'selection') {
        const lines = String(a.text || '').replace(/\r\n?/g, '\n').split('\n');
        attachParts.push(`<attachment type="selection" path="${a.path || ''}" lines="${a.startLine || 1}-${a.endLine || (a.startLine || 1) + lines.length - 1}">\n${numbered(lines, a.startLine || 1)}\n</attachment>`);
      } else if (a.type === 'problems') {
        attachParts.push(`<attachment type="problems">\n${diagnostics.summary(300) || 'No problems reported.'}\n</attachment>`);
      } else if (a.type === 'terminal') {
        const term = await apis.terminal();
        const out = term?.recentOutput?.(150) || '';
        attachParts.push(`<attachment type="terminal">\n${out.slice(-12000) || '(the terminal has no output yet)'}\n</attachment>`);
      } else if (a.type === 'git') {
        const git = await apis.git();
        const d = git?.isConnected?.() ? await git.getDiff() : '';
        attachParts.push(`<attachment type="git-diff">\n${String(d || '(no GitHub repository connected, or no changes)').slice(0, 20000)}\n</attachment>`);
      } else if (a.type === 'codebase') wantCodebase = true;
    } catch (err) { notes.push(`Attachment could not be read: ${err.message}`); }
  }
  if (wantCodebase) attachParts.push('<attachment type="codebase"/> (the user wants you to consider the whole codebase: as many files as fit are included below; read others with read_file)');
  if (attachParts.length) add(`Attachments from the user:\n${attachParts.join('\n')}`, Math.max(4000, envChars * 0.5));

  // relevant files
  if (!casual) {
    const ranked = rankFiles(fs, prompt, { activePath, activeText, openPaths, codebase: wantCodebase });
    const remaining = envChars - used - 400;
    const projectText = ranked.reduce((n, r) => n + r.size, 0);
    const smallProject = projectText * 1.15 < remaining * 0.8 && ranked.length <= 40;
    const share = wantCodebase || smallProject ? remaining : Math.min(remaining, envChars * 0.4);
    const maxFiles = wantCodebase || smallProject ? 400 : 8;
    const blocks = [];
    let spent = 0, weak = 0;
    for (const r of ranked) {
      if (blocks.length >= maxFiles || spent >= share - 500) break;
      if (included.includes(r.path)) continue;
      // weakly related files (entry points, recently edited…) are still useful starting points — but only a couple
      if (!wantCodebase && !smallProject && r.score <= 2 && (r.score <= 0 || ++weak > 2)) break;
      if (r.score < -20) continue;
      const text = await liveText(fs, r.path).catch(() => null);
      if (text == null) continue;
      const cap = Math.min(share - spent, wantCodebase || smallProject ? 60000 : 24000);
      if (cap < 800) break;
      const block = fileBlock(r.path, text, { maxChars: cap, maxLines: 1200 });
      blocks.push(block);
      spent += block.length + 1;
      included.push(r.path);
    }
    if (blocks.length) {
      const heading = smallProject && !wantCodebase ? 'Project files (the project is small, so all of its files are included):'
        : wantCodebase ? 'Codebase files (most relevant first):' : 'Relevant files (selected automatically; read_file others as needed):';
      add(`${heading}\n${blocks.join('\n')}`);
    }
  }
  if (notes.length) add(`Notes: ${notes.join(' ')}`);
  return { text: `<environment>\n${sections.join('\n\n')}\n</environment>`, images, files: included, notes };
}
