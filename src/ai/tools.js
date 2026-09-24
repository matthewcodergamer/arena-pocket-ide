// X Coder agent tools. Every tool call parsed from the model's reply is executed here.
//
//   runTool(call, ctx) → { ok, content, label, detail, images?: [{name, url}], edit?, project?, stop? }
//   ctx = { turn, mode: 'ask'|'edit'|'agent', signal, vision: boolean, routerUrl, resultCap, capabilities, status(text) }
//   toolLabel(call, phase) → human label for the chat UI ('Reading src/app.js', 'Read src/app.js, lines 1 to 80')
//
// Read-only tools run against the live project (Edit-mode staged content is visible to reads in the same turn);
// edit tools go through edits.js (path safety, SEARCH/REPLACE matching, staging or checkpointed writes).

import { workspace } from '../core/workspace.js';
import { posix, isImagePath, isTextPath } from '../core/path.js';
import { diagnostics } from '../core/diagnostics.js';
import { formatBytes } from '../core/dom.js';
import { TEMPLATES } from '../core/templates.js';
import { numbered, includeMatcher, toLf } from './engine-match.js';
import { runShell } from './engine-shell.js';
import { fileTree, apis, prepareImage, blobToDataURL } from './context.js';
import { puterImage, cleanRouterUrl } from './providers.js';
import {
  checkPath, isDenied, suggestPaths, readInTurn, existsInTurn, switchTurnProject,
  writeFileTool, editFileTool, deleteFileTool, renameFileTool, createFolderTool, writeBinaryTool
} from './edits.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const abortError = () => Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' });

function truncate(text, cap, hint = '') {
  const s = String(text ?? '');
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n… [truncated: ${s.length - cap} more characters${hint ? ` — ${hint}` : ''}]`;
}

const short = (s, n = 48) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Chat UI labels, VS Code Copilot style. */
export function toolLabel(call, phase = 'running', info = {}) {
  const a = call.attrs || {};
  const done = phase !== 'running';
  switch (call.name) {
    case 'read_file': {
      const range = info.range || (a.start_line ? `lines ${a.start_line} to ${a.end_line || 'end'}` : '');
      return done ? `Read ${a.path}${range ? `, ${range}` : ''}` : `Reading ${a.path}`;
    }
    case 'list_files': return done ? `Listed files in ${a.path || 'the project'}` : `Listing files in ${a.path || 'the project'}`;
    case 'search_files': return done ? `Searched for "${short(a.query, 40)}"${info.count != null ? `, ${plural(info.count, 'result')}` : ''}` : `Searching for "${short(a.query, 40)}"`;
    case 'get_problems': return done ? 'Checked problems' : 'Checking problems';
    case 'run_preview': return done ? `Ran preview of ${a.entry || info.entry || 'the project'}` : `Running preview of ${a.entry || 'the project'}`;
    case 'run_script': return done ? `Ran ${a.path}` : `Running ${a.path}`;
    case 'get_terminal_output': return done ? 'Read terminal output' : 'Reading terminal output';
    case 'git_diff': return done ? `Read changes${a.path ? ` in ${a.path}` : ''}` : `Reading changes${a.path ? ` in ${a.path}` : ''}`;
    case 'view_image': return done ? `Viewed ${a.path}` : `Viewing ${a.path}`;
    case 'fetch_url': { let host = a.url; try { host = new URL(a.url).host; } catch {} return done ? `Fetched ${host}` : `Fetching ${host}`; }
    case 'run_command': return done ? `Ran \`${short(a.command, 40)}\`` : `Running \`${short(a.command, 40)}\``;
    case 'write_file': return done ? `Wrote ${a.path}` : `Writing ${a.path}`;
    case 'edit_file': return done ? `Edited ${a.path}` : `Editing ${a.path}`;
    case 'delete_file': return done ? `Deleted ${a.path}` : `Deleting ${a.path}`;
    case 'rename_file': return done ? `Renamed ${a.from} → ${a.to}` : `Renaming ${a.from}`;
    case 'create_folder': return done ? `Created folder ${a.path}` : `Creating folder ${a.path}`;
    case 'create_project': return done ? `Created project “${a.name}”` : `Creating project “${a.name}”`;
    case 'generate_image': return done ? `Generated ${a.path || 'an image'}` : `Generating ${a.path || 'an image'}`;
    default: return done ? `Ran ${call.name}` : `Running ${call.name}`;
  }
}

// ------------------------------------------------------------------ syntax validation after edits

let acornPromise = null;
const acorn = () => (acornPromise ||= import('../../vendor/acorn.js').catch(() => null));

function acornError(mod, code, lineOffset = 0) {
  const opts = { ecmaVersion: 'latest', allowHashBang: true, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: false, locations: true };
  try { mod.parse(code, { ...opts, sourceType: 'module' }); return null; }
  catch (errModule) {
    try { mod.parse(code, { ...opts, sourceType: 'script' }); return null; }
    catch { return `line ${(errModule.loc?.line || 1) + lineOffset}: ${errModule.message.replace(/\s*\(\d+:\d+\)$/, '')}`; }
  }
}

/** JSX/TSX-like markup in a .js file or inline script (transpiled by the preview, so acorn would mis-report it). */
const looksLikeJsx = code => /\bReact\b|from\s+['"](react|preact|solid-js)['"/]|return\s*\(?\s*<[A-Za-z>]|=>\s*\(?\s*<[A-Za-z>]|^\s*<[A-Z][\w.]*[\s/>]|@jsx/m.test(code);

/** Returns a warning string when new content has an obvious syntax error (JS, JSON, inline <script>, CSS braces). */
export async function syntaxProblems(path, text) {
  const ext = posix.ext(path);
  try {
    if (ext === '.json' || ext === '.webmanifest') {
      if (!text.trim()) return null;
      try { JSON.parse(text); return null; } catch (err) { return `JSON syntax error: ${err.message}`; }
    }
    if (['.js', '.mjs', '.cjs'].includes(ext)) {
      if (looksLikeJsx(text)) return null;
      const mod = await acorn();
      if (!mod?.parse) return null;
      const e = acornError(mod, text);
      return e ? `JavaScript syntax error at ${e}` : null;
    }
    if (ext === '.html' || ext === '.htm') {
      const mod = await acorn();
      if (!mod?.parse) return null;
      const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
      let m;
      while ((m = re.exec(text))) {
        const attrs = m[1];
        if (/\bsrc\s*=/.test(attrs)) continue;
        const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1]?.toLowerCase() || '';
        if (type && !/^(module|text\/javascript|application\/javascript)$/.test(type)) {
          if (type === 'importmap' || type === 'application/json') {
            try { JSON.parse(m[2]); } catch (err) { return `Invalid JSON in <script type="${type}">: ${err.message}`; }
          }
          continue;
        }
        if (looksLikeJsx(m[2])) continue;
        const lineOffset = text.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length - 1;
        const e = acornError(mod, m[2], lineOffset);
        if (e) return `JavaScript syntax error in inline <script> at ${e}`;
      }
      return null;
    }
    if (ext === '.css') {
      const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
      let depth = 0, line = 1;
      for (const ch of stripped) {
        if (ch === '\n') line++;
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth < 0) return `CSS error: unexpected "}" at line ${line}`; }
      }
      return depth > 0 ? `CSS error: ${depth} unclosed "{" block(s)` : null;
    }
  } catch { return null; }
  return null;
}

// ------------------------------------------------------------------ read-only tools

async function readFile(call, ctx) {
  const fs = workspace.fs;
  const chk = checkPath(call.attrs.path, fs);
  if (!chk.ok) return { ok: false, content: chk.error };
  const path = chk.path;
  if (!existsInTurn(ctx.turn, fs, path)) {
    const near = suggestPaths(path, fs);
    return { ok: false, content: `File not found: ${path}.${near.length ? ` Similar paths: ${near.join(', ')}.` : ''} Use list_files to see the project.` };
  }
  if (fs.isFolder(path) && !ctx.turn?.staged.has(path)) {
    return { ok: true, content: `"${path}" is a folder:\n${fileTree(fs, { root: path, depth: 2, maxEntries: 200 }) || '(empty)'}`, info: { range: 'folder' } };
  }
  if (fs.isBinary(path) && !ctx.turn?.staged.has(path)) {
    const size = formatBytes(fs.size(path));
    if (isImagePath(path)) return { ok: true, content: `${path} is an image (${size}). Use <view_image path="${path}"/> to look at it.` };
    return { ok: true, content: `${path} is a binary file (${size}, ${fs.get(path)?.mime || 'unknown type'}); it cannot be shown as text.` };
  }
  const text = await readInTurn(ctx.turn, fs, path);
  const lines = toLf(text ?? '').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = text ? lines.length : 0;
  if (!total) return { ok: true, content: `${path} is empty.`, info: { range: 'empty' } };
  let start = Math.max(1, parseInt(call.attrs.start_line, 10) || 1);
  let end = Math.min(total, parseInt(call.attrs.end_line, 10) || total);
  if (start > total) return { ok: false, content: `${path} has only ${total} lines (start_line ${start} is past the end).` };
  if (end < start) end = Math.min(total, start + 199);
  const cap = ctx.resultCap;
  const maxLines = cap >= 30000 ? 2000 : 800;
  let body = numbered(lines.slice(start - 1, end), start, { width: String(total).length });
  let truncated = false;
  if (end - start + 1 > maxLines || body.length > cap) {
    const avg = body.length / (end - start + 1);
    const fit = Math.max(40, Math.min(maxLines, Math.floor((cap - 400) / Math.max(10, avg))));
    end = Math.min(total, start + fit - 1);
    body = numbered(lines.slice(start - 1, end), start, { width: String(total).length });
    truncated = true;
  }
  const staged = ctx.turn?.staged.has(path) ? ' (includes your staged edits)' : '';
  const header = `${path} — ${total} line${total === 1 ? '' : 's'}${start !== 1 || end !== total ? `, showing ${start}-${end}` : ''}${staged}`;
  const more = truncated || end < total ? `\n(Lines ${end + 1}-${total} not shown — read them with start_line="${end + 1}".)` : '';
  return { ok: true, content: `${header}\n${body}${more}`, info: { range: start === 1 && end === total ? `${total} lines` : `lines ${start} to ${end}` } };
}

async function listFiles(call, ctx) {
  const fs = workspace.fs;
  const raw = call.attrs.path ?? '';
  const chk = raw && raw !== '.' && raw !== '/' ? checkPath(raw, fs) : { ok: true, path: '' };
  if (!chk.ok) return { ok: false, content: chk.error };
  if (chk.path && !fs.isFolder(chk.path)) {
    if (fs.isFile(chk.path)) return { ok: true, content: `${chk.path} is a file (${formatBytes(fs.size(chk.path))}).` };
    return { ok: false, content: `Folder not found: ${chk.path}.` };
  }
  const depth = Math.max(1, Math.min(20, parseInt(call.attrs.depth, 10) || 4));
  const tree = fileTree(fs, { root: chk.path, depth: depth - 1, maxEntries: 500 });
  return { ok: true, content: `${chk.path || 'Project root'}:\n${tree || '(empty)'}` };
}

async function searchFiles(call, ctx) {
  const fs = workspace.fs;
  const query = String(call.attrs.query ?? '').trim();
  if (!query) return { ok: false, content: 'search_files needs a query.' };
  const regex = /^(true|1|yes)$/i.test(call.attrs.regex || '');
  const caseSensitive = /^(true|1|yes)$/i.test(call.attrs.case_sensitive || call.attrs.casesensitive || '');
  const folder = call.attrs.path && call.attrs.path !== '.' ? checkPath(call.attrs.path, fs) : { ok: true, path: '' };
  if (!folder.ok) return { ok: false, content: folder.error };
  const inc = includeMatcher(call.attrs.include);
  let results;
  try {
    results = fs.search(query, { regex, caseSensitive, limit: 600, include: p => posix.isInside(p, folder.path) && !isDenied(p, fs) && (!inc || inc(p)) });
  } catch (err) { return { ok: false, content: err.message }; }
  if (!results.length) return { ok: true, content: `No matches for "${query}"${folder.path ? ` in ${folder.path}` : ''}${call.attrs.include ? ` (include ${call.attrs.include})` : ''}.`, info: { count: 0 } };
  const byFile = new Map();
  for (const r of results) {
    if (!byFile.has(r.path)) byFile.set(r.path, []);
    const list = byFile.get(r.path);
    if (list.length && list[list.length - 1].line === r.line) continue; // several matches on one line → one row
    list.push(r);
  }
  const lines = [`${results.length}${results.length >= 600 ? '+' : ''} match${results.length === 1 ? '' : 'es'} in ${plural(byFile.size, 'file')}:`];
  let shown = 0;
  for (const [path, list] of byFile) {
    lines.push(`${path}`);
    for (const r of list.slice(0, 30)) { lines.push(`  ${r.line}: ${r.preview.trim().slice(0, 220)}`); shown++; }
    if (list.length > 30) lines.push(`  … ${list.length - 30} more in this file`);
    if (shown > 250) { lines.push('… more matches omitted — narrow the search with path or include.'); break; }
  }
  return { ok: true, content: lines.join('\n'), info: { count: results.length } };
}

async function getProblems(call, ctx) {
  if (ctx.turn?.edits.length) await sleep(700); // let the linters catch up with the files just written
  const c = diagnostics.counts();
  const summary = diagnostics.summary(200);
  const touched = [...new Set((ctx.turn?.edits || []).filter(e => ['applied', 'pending'].includes(e.state) && e.kind !== 'delete').map(e => e.to || e.path))];
  const extra = [];
  for (const p of touched.slice(0, 20)) {
    const text = await readInTurn(ctx.turn, workspace.fs, p).catch(() => null);
    if (text == null) continue;
    const problem = await syntaxProblems(p, text);
    if (problem) extra.push(`${p}: ${problem}`);
  }
  const parts = [];
  parts.push(c.errors || c.warnings ? `${plural(c.errors, 'error')}, ${plural(c.warnings, 'warning')}:\n${summary}` : 'No problems reported by the editor.');
  if (extra.length) parts.push(`Syntax check of files changed in this turn:\n${extra.join('\n')}`);
  else if (touched.length) parts.push(`Syntax check of the ${plural(touched.length, 'file')} changed in this turn: OK.`);
  return { ok: true, content: parts.join('\n\n'), detail: `${plural(c.errors + extra.length, 'error')}, ${plural(c.warnings, 'warning')}` };
}

function formatLogs(logs = [], limit = 120) {
  return logs.slice(-limit).map(l => `[${l.level || 'log'}] ${String(l.text ?? '').slice(0, 1000)}`).join('\n');
}

async function runPreview(call, ctx) {
  const preview = await apis.preview();
  if (!preview?.captureRun) return { ok: false, content: 'The preview runner is not available in this build.' };
  let entry = call.attrs.entry ? checkPath(call.attrs.entry, workspace.fs) : null;
  if (entry && !entry.ok) return { ok: false, content: entry.error };
  let target = entry?.path;
  if (!target) { try { target = preview.resolveEntry?.() || 'index.html'; } catch { target = 'index.html'; } }
  if (!workspace.fs.exists(target)) return { ok: false, content: `Preview entry "${target}" does not exist. Create it or pass entry="…".` };
  ctx.status?.(`Running preview of ${target}…`);
  let res;
  try { res = await preview.captureRun({ entry: target, timeoutMs: 5000 }); }
  catch (err) { return { ok: false, content: `The preview could not run: ${err.message}` }; }
  if (ctx.signal?.aborted) throw abortError();
  const logs = res?.logs || [];
  const errors = res?.errors || [];
  const out = [`Ran ${res?.entry || target} for ${Math.round((res?.durationMs || 0) / 100) / 10} s.`];
  if (ctx.mode === 'edit' && ctx.turn?.staged.size) out.push('Note: your staged (not yet kept) edits are NOT part of this run.');
  out.push(logs.length ? `Console (${logs.length}):\n${formatLogs(logs)}` : 'Console: (no output)');
  out.push(errors.length ? `Errors (${errors.length}):\n${errors.slice(0, 30).map(e => `- ${String(e).slice(0, 1200)}`).join('\n')}` : 'Errors: none');
  // runtime errors are findings (the tool worked); only an unavailable runner is a failed call
  return { ok: !(errors.length && !logs.length && /not available/i.test(String(errors[0]))), content: out.join('\n\n'), detail: `${plural(logs.length, 'console message')}, ${plural(errors.length, 'error')}`, info: { entry: target } };
}

async function runScript(call, ctx, argv = []) {
  const preview = await apis.preview();
  const chk = checkPath(call.attrs.path, workspace.fs);
  if (!chk.ok) return { ok: false, content: chk.error };
  if (!workspace.fs.isFile(chk.path)) return { ok: false, content: `Script not found: ${chk.path}.` };
  if (!preview?.runScript) return { ok: false, content: 'The script runner is not available in this build.' };
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let output = '', exitCode = null, timedOut = false;
  ctx.status?.(`Running ${chk.path}…`);
  try {
    const args = argv.length ? argv : String(call.attrs.args || '').split(/\s+/).filter(Boolean);
    const res = await preview.runScript(chk.path, {
      args, signal: ctrl.signal,
      onOutput: (stream, text) => { if (output.length < 60000) output += stream === 'stderr' ? String(text).replace(/^/gm, '[stderr] ') : String(text); }
    });
    exitCode = res?.exitCode ?? 0;
  } catch (err) {
    if (ctx.signal?.aborted) throw abortError();
    if (ctrl.signal.aborted) timedOut = true;
    else output += `\n[error] ${err.message}`;
    exitCode = exitCode ?? 1;
  } finally { clearTimeout(timer); ctx.signal?.removeEventListener('abort', onAbort); }
  const head = timedOut ? `${chk.path} was stopped after 20 s (time limit).` : `${chk.path} exited with code ${exitCode}.`;
  return { ok: !timedOut && exitCode === 0, content: `${head}\nOutput:\n${truncate(output.trim() || '(no output)', ctx.resultCap)}`, detail: timedOut ? 'timed out' : `exit code ${exitCode}` };
}

async function terminalOutput() {
  const term = await apis.terminal();
  const out = term?.recentOutput?.(150) || '';
  return { ok: true, content: out.trim() ? out.slice(-12000) : 'The terminal has no output yet.' };
}

async function gitDiff(call, ctx) {
  const git = await apis.git();
  if (!git?.isConnected?.()) return { ok: true, content: 'No GitHub repository is connected to this project, so there is no diff. (Source Control → Clone or Publish.)' };
  let path = '';
  if (call.attrs.path) { const chk = checkPath(call.attrs.path, workspace.fs); if (!chk.ok) return { ok: false, content: chk.error }; path = chk.path; }
  const d = await git.getDiff(path || undefined);
  return { ok: true, content: truncate(d || `No changes${path ? ` in ${path}` : ''} since the last pull/push.`, ctx.resultCap, 'pass a path to narrow the diff') };
}

async function viewImage(call, ctx) {
  const fs = workspace.fs;
  const chk = checkPath(call.attrs.path, fs);
  if (!chk.ok) return { ok: false, content: chk.error };
  const path = chk.path;
  if (!fs.isFile(path)) { const near = suggestPaths(path, fs); return { ok: false, content: `Image not found: ${path}.${near.length ? ` Similar: ${near.join(', ')}` : ''}` }; }
  if (!isImagePath(path)) return { ok: false, content: `${path} is not an image. Use read_file for text files.` };
  if (path.endsWith('.svg')) {
    const text = fs.peekText(path) ?? '';
    return { ok: true, content: `${path} is an SVG (vector) image; its source:\n${truncate(text, ctx.resultCap)}` };
  }
  if (!ctx.vision) return { ok: false, content: `The current AI model cannot view images, so ${path} could not be shown. Describe what you need, or ask the user to pick a vision-capable model.` };
  const url = await prepareImage(await fs.readDataURL(path));
  return { ok: true, content: `The image ${path} (${formatBytes(fs.size(path))}) is attached below.`, images: [{ name: path, url }] };
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/pre)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

async function fetchUrl(call, ctx) {
  let url;
  try { url = new URL(String(call.attrs.url || '').trim()); } catch { return { ok: false, content: 'fetch_url needs a full http(s) URL.' }; }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, content: 'Only http and https URLs can be fetched.' };
  // Never probe the user's device/LAN, and refuse URLs that could smuggle project data out in the query string.
  if (/^(localhost|0\.0\.0\.0|\[::1?\]|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname) || /\.local$/i.test(url.hostname)) {
    return { ok: false, content: `Fetching local or private network addresses (${url.hostname}) is not allowed.` };
  }
  if (url.search.length > 600 || /[A-Za-z0-9+/_-]{200,}/.test(url.search)) {
    return { ok: false, content: 'This URL carries a very long query string; fetch_url only retrieves public pages and APIs with short queries.' };
  }
  const cap = Math.min(ctx.resultCap, 16000);
  const router = cleanRouterUrl(ctx.routerUrl);
  const attempts = [];
  const tryFetch = async (target, viaRouter) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const onAbort = () => ctrl.abort();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(target, { signal: ctrl.signal, headers: { accept: 'text/html,application/json,text/plain,*/*' } });
      if (viaRouter) {
        if (!res.ok) throw new Error(`router HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const type = data.contentType || '';
        const text = /html/i.test(type) ? htmlToText(data.text || '') : String(data.text ?? '');
        return { status: data.status || 200, type, text };
      }
      const type = res.headers.get('content-type') || '';
      if (!/text|json|xml|javascript|csv|markdown/i.test(type) && type) return { status: res.status, type, text: `(binary content: ${type})` };
      const raw = await res.text();
      return { status: res.status, type, text: /html/i.test(type) ? htmlToText(raw) : raw };
    } finally { clearTimeout(timer); ctx.signal?.removeEventListener('abort', onAbort); }
  };
  const order = ctx.capabilities?.fetch && router ? ['router', 'direct'] : ['direct', ...(router ? ['router'] : [])];
  for (const how of order) {
    try {
      const r = how === 'router' ? await tryFetch(`${router}/fetch?url=${encodeURIComponent(url.href)}`, true) : await tryFetch(url.href, false);
      if (ctx.signal?.aborted) throw abortError();
      return { ok: r.status < 400, content: `${url.href} → HTTP ${r.status}${r.type ? ` (${r.type.split(';')[0]})` : ''}\n${truncate(r.text.trim(), cap, 'the page was cut')}`, detail: `HTTP ${r.status}` };
    } catch (err) {
      if (err.name === 'AbortError' && ctx.signal?.aborted) throw abortError();
      attempts.push(`${how === 'router' ? 'via the X Coder router' : 'directly'}: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
    }
  }
  return { ok: false, content: `Could not fetch ${url.href} (${attempts.join('; ')}). Browsers block cross-origin requests to sites without CORS; the X Coder router fetch endpoint may not be deployed.` };
}

async function runCommand(call, ctx) {
  const command = String(call.attrs.command || '').trim();
  if (!command) return { ok: false, content: 'run_command needs a command.' };
  const res = runShell(command, { fs: workspace.fs, isDenied: p => isDenied(p, workspace.fs) });
  if (res.runScript) {
    const r = await runScript({ name: 'run_script', attrs: { path: res.runScript.path } }, ctx, res.runScript.args);
    return { ...r, content: `${res.output ? `${res.output}\n` : ''}$ ${command}\n${r.content}` };
  }
  return { ok: res.ok, content: `$ ${command}\n${truncate(res.output, ctx.resultCap)}` };
}

// ------------------------------------------------------------------ project / media tools

async function createProject(call, ctx) {
  if (ctx.mode !== 'agent') return { ok: false, content: 'Creating projects is only available in Agent mode. Ask the user to switch to Agent mode, or build the app in the current project.' };
  const name = String(call.attrs.name || '').trim().slice(0, 80) || 'New Project';
  let template = String(call.attrs.template || 'blank').toLowerCase();
  if (!TEMPLATES.some(t => t.id === template)) template = 'blank';
  const project = await workspace.createProject(name, { template, activate: true });
  switchTurnProject(ctx.turn, project.id);
  const files = workspace.fs.files().map(r => r.path);
  return {
    ok: true, project: { id: project.id, name: project.name },
    content: `Created the project "${project.name}" from the "${template}" template and switched to it. All following file operations apply to this new project. Its files: ${files.length ? files.join(', ') : '(none)'}.`
  };
}

async function generateImage(call, ctx) {
  if (ctx.mode !== 'agent') return { ok: false, content: 'Image generation writes a file, which is only available in Agent mode.' };
  const prompt = String(call.attrs.prompt || '').trim();
  if (!prompt) return { ok: false, content: 'generate_image needs a prompt.' };
  let path = call.attrs.path || `assets/image-${Date.now().toString(36)}.png`;
  const chk = checkPath(path, workspace.fs);
  if (!chk.ok) return { ok: false, content: chk.error };
  path = chk.path;
  if (!isImagePath(path) || path.endsWith('.svg')) path = path.replace(/\.[^./]*$/, '') + '.png';
  let blob;
  try { blob = await puterImage(prompt, { signal: ctx.signal }); }
  catch (err) { if (ctx.signal?.aborted) throw abortError(); return { ok: false, content: `Image generation failed: ${err.message}` }; }
  const edit = await writeBinaryTool(ctx.turn, workspace.fs, path, blob, { signal: ctx.signal });
  if (edit.state === 'failed') return { ok: false, content: `Could not save ${path}: ${edit.error}`, edit };
  const out = { ok: true, content: `Generated ${path} (${formatBytes(blob.size)}).`, edit };
  if (ctx.vision) { try { out.images = [{ name: path, url: await prepareImage(await blobToDataURL(blob)) }]; out.content += ' It is attached below so you can check it.'; } catch {} }
  return out;
}

// ------------------------------------------------------------------ dispatcher

const READ_TOOLS = {
  read_file: readFile, list_files: listFiles, search_files: searchFiles, get_problems: getProblems,
  run_preview: runPreview, run_script: (c, ctx) => runScript(c, ctx), get_terminal_output: terminalOutput,
  git_diff: gitDiff, view_image: viewImage, fetch_url: fetchUrl, run_command: runCommand
};
const EDIT_TOOLS = {
  write_file: (t, fs, c, o) => writeFileTool(t, fs, c, o),
  edit_file: (t, fs, c, o) => editFileTool(t, fs, c, o),
  delete_file: (t, fs, c, o) => deleteFileTool(t, fs, c, o),
  rename_file: (t, fs, c, o) => renameFileTool(t, fs, c, o),
  create_folder: (t, fs, c, o) => createFolderTool(t, fs, c, o)
};

export async function runTool(call, ctx) {
  if (ctx.signal?.aborted) throw abortError();
  if (!workspace.fs) return { ok: false, content: 'No project is open.' };
  try {
    if (READ_TOOLS[call.name]) {
      const r = await READ_TOOLS[call.name](call, ctx);
      if (r.content && r.content.length > ctx.resultCap + 2000) r.content = truncate(r.content, ctx.resultCap, 'request a smaller range');
      return r;
    }
    if (EDIT_TOOLS[call.name] || call.name === 'create_project' || call.name === 'generate_image') {
      if (ctx.mode === 'ask') {
        return { ok: false, disabled: true, content: `Edits are disabled in Ask mode, so ${call.name} was not run. Show the proposed code to the user in fenced code blocks (with file paths) instead, and mention they can switch to Agent mode to have it applied.` };
      }
      if (call.name === 'create_project') return await createProject(call, ctx);
      if (call.name === 'generate_image') return await generateImage(call, ctx);
      const r = await EDIT_TOOLS[call.name](ctx.turn, workspace.fs, call, { signal: ctx.signal });
      // Agent mode: catch obvious syntax errors right away so the model can fix them in the next round.
      if (r.ok !== false && r.edit && ctx.mode === 'agent' && ['write_file', 'edit_file'].includes(call.name) && r.path && isTextPath(r.path)) {
        const text = workspace.fs.peekText(r.path);
        const problem = text != null ? await syntaxProblems(r.path, text) : null;
        if (problem) { r.content += `\n\n⚠ ${problem}. Fix it before continuing.`; r.warning = problem; }
      }
      return r;
    }
    return { ok: false, content: `Unknown tool "${call.name}". Available tools: read_file, list_files, search_files, get_problems, run_preview, run_script, get_terminal_output, git_diff, view_image, fetch_url, run_command, write_file, edit_file, delete_file, rename_file, create_project, generate_image.` };
  } catch (err) {
    if (err?.name === 'AbortError' || ctx.signal?.aborted) throw abortError();
    return { ok: false, content: `${call.name} failed: ${err?.message || err}` };
  }
}
