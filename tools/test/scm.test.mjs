// Source Control end-to-end against an in-memory fake GitHub (api.github.com is routed with page.route):
// sign-in (token flow UI), clone into a new project, M/U/D changes with VS Code colors, diff editor,
// staging + commit & push of staged files (tree/commit verified in the fake), commit & push of the rest,
// pull of a remote change, automatic rebase when the remote moved (different files), pull conflict
// prompt (Cancel / Overwrite), discard, undo last commit, sync counts in the status bar, the git
// terminal command, publish (empty repository bootstrap), Accounts menu, light/dark screenshots and desktop.
//
//   node tools/test/scm.test.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { launch } from './harness.mjs';

const log = (...a) => console.log('  ·', ...a);
const TOKEN = 'ghp_testToken123';
let failed = false;

// ---------------------------------------------------------------- fake GitHub

const sha1 = buf => createHash('sha1').update(buf).digest('hex');
const blobSha = bytes => sha1(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));

class FakeGitHub {
  constructor() {
    this.blobs = new Map();   // sha → Buffer
    this.trees = new Map();   // sha → Map(path → {mode, sha})
    this.commits = new Map(); // sha → {tree, parents, message, author, date}
    this.repos = new Map();   // 'owner/name' (lower) → {owner, name, private, default_branch, refs: Map}
    this.requests = [];
    this.clock = Date.parse('2026-09-01T10:00:00Z');
  }
  addBlob(bytes) { const b = Buffer.from(bytes); const s = blobSha(b); this.blobs.set(s, b); return s; }
  addTree(map) {
    const sorted = [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const s = sha1(Buffer.from('tree ' + JSON.stringify(sorted)));
    this.trees.set(s, new Map(sorted));
    return s;
  }
  addCommit({ tree, parents = [], message, author = 'octo' }) {
    this.clock += 60000;
    const c = { tree, parents, message, author, date: new Date(this.clock).toISOString() };
    const s = sha1(Buffer.from('commit ' + JSON.stringify(c) + Math.random()));
    this.commits.set(s, c);
    return s;
  }
  repo(full) { return this.repos.get(full.toLowerCase()); }
  createRepo(owner, name, { isPrivate = false, files = null, branch = 'main' } = {}) {
    const r = { owner, name, private: isPrivate, default_branch: branch, refs: new Map() };
    this.repos.set(`${owner}/${name}`.toLowerCase(), r);
    if (files) this.commitFiles(`${owner}/${name}`, files, 'Initial commit', branch);
    return r;
  }
  /** Commits file changes directly on the remote (like another collaborator). files: {path: string|Buffer|null} */
  commitFiles(full, files, message, branch = 'main', author = 'hubot') {
    const r = this.repo(full);
    const head = r.refs.get(branch);
    const base = head ? new Map(this.trees.get(this.commits.get(head).tree)) : new Map();
    for (const [p, v] of Object.entries(files)) {
      if (v === null) base.delete(p);
      else base.set(p, { mode: '100644', sha: this.addBlob(typeof v === 'string' ? Buffer.from(v) : v) });
    }
    const c = this.addCommit({ tree: this.addTree(base), parents: head ? [head] : [], message, author });
    r.refs.set(branch, c);
    return c;
  }
  headTree(full, branch = 'main') { const r = this.repo(full); const h = r.refs.get(branch); return h ? this.trees.get(this.commits.get(h).tree) : new Map(); }
  fileText(full, path, branch = 'main') { const e = this.headTree(full, branch).get(path); return e ? this.blobs.get(e.sha).toString('utf8') : null; }
  isAncestor(anc, sha) {
    const seen = new Set(); const stack = [sha];
    while (stack.length) { const s = stack.pop(); if (s === anc) return true; if (seen.has(s)) continue; seen.add(s); stack.push(...(this.commits.get(s)?.parents || [])); }
    return false;
  }

  async handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const auth = req.headers()['authorization'] || '';
    const authed = auth === `Bearer ${TOKEN}`;
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch {}
    this.requests.push({ method, path: url.pathname, body, authed });
    const send = (status, data, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers: { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600), ...headers }, body: data === undefined ? '' : JSON.stringify(data) });
    if (auth && !authed) return send(401, { message: 'Bad credentials' });
    const p = decodeURIComponent(url.pathname);
    let m;
    if (p === '/user') return authed ? send(200, { login: 'octo', name: 'The Octocat', avatar_url: '', html_url: 'https://github.com/octo' }) : send(401, { message: 'Requires authentication' });
    if (p === '/user/repos' && method === 'GET') return authed ? send(200, [...this.repos.values()].map(r => this.repoJson(r))) : send(401, { message: 'Requires authentication' });
    if (p === '/user/repos' && method === 'POST') {
      if (!authed) return send(401, { message: 'Requires authentication' });
      if (this.repo(`octo/${body.name}`)) return send(422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] });
      const r = this.createRepo('octo', body.name, { isPrivate: body.private });
      return send(201, this.repoJson(r));
    }
    if (!(m = p.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/))) return send(404, { message: 'Not Found' });
    const r = this.repo(`${m[1]}/${m[2]}`);
    const rest = m[3] || '';
    if (!r || (r.private && !authed)) return send(404, { message: 'Not Found' });
    const write = method !== 'GET';
    if (write && !authed) return send(401, { message: 'Requires authentication' });
    const empty = r.refs.size === 0;
    if (!rest) return send(200, this.repoJson(r));
    if (rest === '/branches') return send(200, [...r.refs.entries()].map(([name, sha]) => ({ name, commit: { sha } })));
    if ((m = rest.match(/^\/git\/ref\/heads\/(.+)$/))) {
      if (empty) return send(409, { message: 'Git Repository is empty.' });
      const sha = r.refs.get(m[1]);
      return sha ? send(200, { ref: `refs/heads/${m[1]}`, object: { sha, type: 'commit' } }) : send(404, { message: 'Not Found' });
    }
    if (rest === '/git/refs' && method === 'POST') {
      const name = body.ref.replace(/^refs\/heads\//, '');
      if (r.refs.has(name)) return send(422, { message: 'Reference already exists' });
      if (!this.commits.has(body.sha)) return send(422, { message: 'Object does not exist' });
      r.refs.set(name, body.sha);
      return send(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if ((m = rest.match(/^\/git\/refs\/heads\/(.+)$/)) && method === 'PATCH') {
      const cur = r.refs.get(m[1]);
      if (!cur) return send(422, { message: 'Reference does not exist' });
      if (!this.commits.has(body.sha)) return send(422, { message: 'Object does not exist' });
      if (!body.force && !this.isAncestor(cur, body.sha)) return send(422, { message: 'Update is not a fast forward' });
      r.refs.set(m[1], body.sha);
      return send(200, { ref: `refs/heads/${m[1]}`, object: { sha: body.sha } });
    }
    if ((m = rest.match(/^\/git\/commits\/([0-9a-f]{40})$/))) {
      const c = this.commits.get(m[1]);
      return c ? send(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map(s => ({ sha: s })), message: c.message }) : send(404, { message: 'Not Found' });
    }
    if ((m = rest.match(/^\/git\/trees\/([0-9a-f]{40})$/))) {
      const t = this.trees.get(m[1]);
      if (!t) return send(404, { message: 'Not Found' });
      const dirs = new Set();
      for (const path of t.keys()) { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
      const tree = [...[...dirs].map(d => ({ path: d, mode: '040000', type: 'tree', sha: sha1(Buffer.from(d)) })), ...[...t.entries()].map(([path, e]) => ({ path, mode: e.mode, type: 'blob', sha: e.sha, size: this.blobs.get(e.sha).length }))];
      return send(200, { sha: m[1], tree, truncated: false });
    }
    if ((m = rest.match(/^\/git\/blobs\/([0-9a-f]{40})$/))) {
      const b = this.blobs.get(m[1]);
      return b ? send(200, { sha: m[1], size: b.length, encoding: 'base64', content: b.toString('base64').replace(/(.{60})/g, '$1\n') }) : send(404, { message: 'Not Found' });
    }
    if (empty && /^\/git\/(blobs|trees|commits)$/.test(rest)) return send(409, { message: 'Git Repository is empty.' });
    if (rest === '/git/blobs' && method === 'POST') return send(201, { sha: this.addBlob(Buffer.from(body.content, 'base64')) });
    if (rest === '/git/trees' && method === 'POST') {
      const base = body.base_tree ? this.trees.get(body.base_tree) : new Map();
      if (!base) return send(422, { message: 'base_tree is invalid' });
      const next = new Map(base);
      for (const e of body.tree) {
        if (e.sha === null) { if (!next.has(e.path)) return send(422, { message: `GitRPC::BadObjectState: ${e.path} does not exist` }); next.delete(e.path); }
        else { if (!this.blobs.has(e.sha)) return send(422, { message: 'Invalid tree info' }); next.set(e.path, { mode: e.mode, sha: e.sha }); }
      }
      return send(201, { sha: this.addTree(next) });
    }
    if (rest === '/git/commits' && method === 'POST') {
      if (!this.trees.has(body.tree)) return send(422, { message: 'Tree SHA does not exist' });
      return send(201, { sha: this.addCommit({ tree: body.tree, parents: body.parents || [], message: body.message, author: 'octo' }) });
    }
    if ((m = rest.match(/^\/contents\/(.+)$/)) && method === 'PUT') {
      const c = this.commitFiles(`${r.owner}/${r.name}`, { [m[1]]: Buffer.from(body.content, 'base64') }, body.message, body.branch || r.default_branch, 'octo');
      return send(201, { content: { path: m[1] }, commit: { sha: c } });
    }
    if (rest === '/commits') {
      const branch = url.searchParams.get('sha') || r.default_branch;
      let s = r.refs.get(branch);
      if (!s) return send(409, { message: 'Git Repository is empty.' });
      const out = [];
      while (s && out.length < Number(url.searchParams.get('per_page') || 30)) {
        const c = this.commits.get(s);
        out.push({ sha: s, html_url: `https://github.com/${r.owner}/${r.name}/commit/${s}`, commit: { message: c.message, author: { name: c.author, email: `${c.author}@example.com`, date: c.date } }, author: { login: c.author } });
        s = c.parents[0];
      }
      return send(200, out);
    }
    if ((m = rest.match(/^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/))) {
      const commits = [];
      let s = m[2];
      while (s && s !== m[1]) { const c = this.commits.get(s); commits.unshift({ sha: s, commit: { message: c.message } }); s = c.parents[0]; }
      const a = this.trees.get(this.commits.get(m[1]).tree), b = this.trees.get(this.commits.get(m[2]).tree);
      const files = [];
      for (const [path, e] of b) if (!a.has(path)) files.push({ filename: path, status: 'added' }); else if (a.get(path).sha !== e.sha) files.push({ filename: path, status: 'modified' });
      for (const path of a.keys()) if (!b.has(path)) files.push({ filename: path, status: 'removed' });
      return send(200, { ahead_by: commits.length, total_commits: commits.length, commits, files });
    }
    return send(404, { message: `Not Found (fake: ${method} ${rest})` });
  }
  repoJson(r) { return { name: r.name, full_name: `${r.owner}/${r.name}`, private: r.private, default_branch: r.default_branch, html_url: `https://github.com/${r.owner}/${r.name}`, description: '' }; }
}

// ---------------------------------------------------------------- helpers

async function waitFor(page, fn, arg, timeout = 8000, label = '') {
  const start = Date.now();
  for (;;) {
    const v = await page.evaluate(fn, arg).catch(() => false);
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label || fn.toString().slice(0, 160)}`);
    await page.waitForTimeout(60);
  }
}
/** Waits for a condition on the Node side (the fake GitHub). */
async function waitNode(page, fn, label, timeout = 10000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await page.waitForTimeout(60);
  }
}
const clearToasts = page => page.evaluate(async () => { (await import('/src/platform/notifications.js')).notify.clearAll(); });
const fsWrite = (page, path, content) => page.evaluate(async ([p, c]) => { const { workspace } = await import('/src/core/workspace.js'); await workspace.fs.writeText(p, c); }, [path, content]);
const fsRemove = (page, path) => page.evaluate(async p => { const { workspace } = await import('/src/core/workspace.js'); await workspace.fs.remove(p); }, path);
const fsRead = (page, path) => page.evaluate(async p => { const { workspace } = await import('/src/core/workspace.js'); return workspace.fs.exists(p) ? workspace.fs.readText(p) : null; }, path);
const changes = page => page.evaluate(async () => { const { git } = await import('/src/scm/api.js'); return (await git.getChanges()).map(c => `${c.status} ${c.path}`).sort(); });
const repoState = page => page.evaluate(async () => { const { scm } = await import('/src/scm/service.js'); const r = scm.repo; return r ? { repo: r.git.repo, branch: r.branch, last: r.git.lastSyncSha, ahead: r.ahead, behind: r.behind, busy: !!scm.busy } : null; });
const idle = page => waitFor(page, async () => { const { scm } = await import('/src/scm/service.js'); return !scm.busy; }, null, 15000, 'SCM idle');
const rowSel = path => `.scm-list .scm-resource[data-path="${path}"]`;
async function waitRows(page, expected) {
  await waitFor(page, exp => {
    const rows = [...document.querySelectorAll('.scm-list .scm-resource')].map(r => `${r.querySelector('.scm-letter').textContent} ${r.dataset.path}`).sort();
    return JSON.stringify(rows) === JSON.stringify([...exp].sort());
  }, expected, 8000, `SCM rows ${expected.join(', ')}`);
}
async function openScm(page) {
  const shown = await page.evaluate(async () => (await import('/src/workbench/views.js')).views.isVisible('workbench.view.scm'));
  if (!shown) await page.tap('#activitybar [data-container="workbench.view.scm"]');
  await page.waitForSelector('.scm-view', { state: 'visible' });
}
async function dialogButton(page, label) {
  const btn = page.locator('.monaco-dialog-box .dialog-buttons button', { hasText: label }).first();
  await btn.waitFor({ state: 'visible', timeout: 8000 });
  await btn.click();
}
async function quickPick(page, text, { waitLabel } = {}) {
  const input = page.locator('.quick-input-widget:not(.hidden) input.input');
  await input.waitFor({ state: 'visible' });
  if (text != null) await input.fill(text);
  if (waitLabel) await page.locator('.quick-input-widget .quick-input-list-entry', { hasText: waitLabel }).first().waitFor({ timeout: 8000 });
  else await page.waitForTimeout(250);
  await input.press('Enter');
}
async function typeCommitMessage(page, msg) {
  const box = page.locator('.scm-editor .scm-input');
  await box.fill(msg);
}
async function cssVar(page, name) { return page.evaluate(n => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name); }
function rgb(hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6);
  return `rgb(${parseInt(n.slice(0, 2), 16)}, ${parseInt(n.slice(2, 4), 16)}, ${parseInt(n.slice(4, 6), 16)})`;
}
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

function seedRepo(gh) {
  gh.createRepo('octo', 'hello', {
    files: {
      'index.html': '<!doctype html>\n<h1>Hello</h1>\n<script src="src/app.js"></script>\n',
      'src/app.js': "console.log('hello');\n",
      'README.md': '# hello\n\nA test repository.\n',
      'docs/old.txt': 'obsolete\n',
      'img/logo.png': PNG,
      '.gitignore': 'node_modules/\n*.log\n'
    }
  });
  gh.createRepo('octo', 'secret', { isPrivate: true, files: { 'a.txt': 'private\n' } });
}

// ---------------------------------------------------------------- phone

async function phoneTests() {
  const gh = new FakeGitHub();
  seedRepo(gh);
  const t = await launch({ device: 'iPhone 13', settings: { 'git.confirmSync': false, 'git.autofetch': false } });
  const { page } = t;
  await page.route('https://api.github.com/**', route => gh.handle(route));
  try {
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.project !== null);

    // --- welcome when no repository is connected
    await openScm(page);
    await page.waitForSelector('.scm-welcome:not(.hidden)');
    const welcome = await page.locator('.scm-welcome').textContent();
    assert.match(welcome, /doesn't have a GitHub repository connected/);
    for (const b of ['Publish to GitHub', 'Clone Repository', 'Connect Existing Repository...']) assert.equal(await page.locator('.scm-welcome button', { hasText: b }).count(), 1, `welcome button ${b}`);
    assert.match(welcome, /require signing in to GitHub/);
    await t.shot('scm-phone-welcome');
    log('welcome view');

    // --- Accounts menu → Sign in with GitHub → token flow
    await page.tap('#activitybar .actions-container.global .action-item[title="Accounts"]');
    await page.locator('.context-view-layer .action-item', { hasText: 'Sign in with GitHub to use Source Control' }).waitFor();
    assert.equal(await page.locator('.context-view-layer .action-item', { hasText: 'Sign in to X Coder Cloud (Puter)...' }).count(), 1, 'cloud sign-in entry in Accounts');
    await page.waitForTimeout(200);
    await t.shot('scm-phone-accounts');
    await page.locator('.context-view-layer .action-item', { hasText: 'Sign in with GitHub to use Source Control' }).click();
    const tokenEntry = page.locator('.quick-input-list-entry', { hasText: 'Sign in with a Personal Access Token' });
    await tokenEntry.waitFor();
    assert.equal(await page.locator('.quick-input-list-entry.disabled', { hasText: 'in the Browser' }).count(), 1, 'device flow disabled without worker support');
    await t.shot('scm-phone-signin-pick');
    await tokenEntry.click();
    await page.locator('.monaco-dialog-box', { hasText: 'Contents: Read and write' }).waitFor();
    await page.waitForTimeout(250);
    await t.shot('scm-phone-token-help');
    await dialogButton(page, 'Enter Token');
    const tokenInput = page.locator('.quick-input-widget:not(.hidden) input.input');
    await tokenInput.waitFor();
    assert.equal(await tokenInput.getAttribute('type'), 'password');
    await tokenInput.fill(TOKEN);
    await tokenInput.press('Enter');
    await waitFor(page, async () => (await import('/src/scm/auth.js')).auth.user?.login === 'octo', null, 8000, 'signed in');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('githubToken')), TOKEN, 'token in sessionStorage (git.rememberToken off)');
    assert.equal(await page.evaluate(() => localStorage.getItem('xcoder.github.token')), null);
    assert.ok(!(await page.evaluate(() => localStorage.getItem('xcoder.settings.v6') || '')).includes(TOKEN), 'token not in settings');
    const gitOut = await page.evaluate(async () => (await import('/src/core/output.js')).output.channel('Git').text());
    assert.ok(!gitOut.includes(TOKEN), 'token never logged');
    log('signed in with a personal access token');

    // --- clone through the quick pick (lists your repositories)
    await clearToasts(page);
    await page.locator('.scm-welcome button', { hasText: 'Clone Repository' }).click();
    await page.locator('.quick-input-list-entry', { hasText: 'octo/secret' }).waitFor();
    await quickPick(page, 'octo/hello', { waitLabel: 'octo/hello' });
    await waitFor(page, async () => { const { workspace } = await import('/src/core/workspace.js'); return workspace.project?.name === 'hello' && workspace.fs.exists('src/app.js'); }, null, 15000, 'cloned project opened');
    await idle(page);
    assert.equal(await fsRead(page, 'README.md'), '# hello\n\nA test repository.\n');
    const png = await page.evaluate(async () => { const { workspace } = await import('/src/core/workspace.js'); const b = await workspace.fs.readBlob('img/logo.png'); return { binary: workspace.fs.isBinary('img/logo.png'), size: b.size }; });
    assert.deepEqual(png, { binary: true, size: PNG.length }, 'binary file cloned as binary');
    let st = await repoState(page);
    assert.equal(st.repo, 'octo/hello'); assert.equal(st.branch, 'main');
    assert.equal(st.last, gh.repo('octo/hello').refs.get('main'), 'lastSyncSha = remote head');
    assert.deepEqual(await changes(page), [], 'clean after clone');
    await openScm(page);
    await page.waitForSelector('.scm-editor-container:not(.hidden)');
    assert.equal(await page.locator('.scm-input').getAttribute('placeholder'), "Message (⌘Enter to commit on 'main')");
    assert.match(await page.locator('.scm-primary').textContent(), /Commit & Push/);
    assert.equal(await page.locator('.scm-primary').isDisabled(), true, 'button disabled without changes');
    await waitFor(page, () => document.querySelector('#statusbar [data-id="status.scm.branch"]')?.textContent.trim() === 'main', null, 4000, 'branch status item');
    log('cloned octo/hello into a new project');

    // --- M / U / D + colors
    await fsWrite(page, 'src/app.js', "console.log('hello, world');\n");
    await fsWrite(page, 'src/new.js', 'export const n = 1;\n');
    await fsWrite(page, 'debug.log', 'ignored by .gitignore\n');
    await fsRemove(page, 'docs/old.txt');
    await waitRows(page, ['M src/app.js', 'U src/new.js', 'D docs/old.txt']);
    assert.equal(await page.locator('.scm-group[data-group="changes"] .monaco-count-badge').textContent(), '3');
    const colors = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.scm-resource')].map(r => [r.dataset.path, { letter: getComputedStyle(r.querySelector('.scm-letter')).color, deco: getComputedStyle(r.querySelector('.scm-name')).textDecorationLine }])));
    assert.equal(colors['src/app.js'].letter, rgb(await cssVar(page, '--vscode-gitDecoration-modifiedResourceForeground')), 'M color');
    assert.equal(colors['src/new.js'].letter, rgb(await cssVar(page, '--vscode-gitDecoration-untrackedResourceForeground')), 'U color');
    assert.equal(colors['docs/old.txt'].letter, rgb(await cssVar(page, '--vscode-gitDecoration-deletedResourceForeground')), 'D color');
    assert.equal(colors['docs/old.txt'].deco, 'line-through', 'deleted is struck through');
    assert.equal(await page.locator(`${rowSel('src/app.js')} .scm-actions .codicon-discard`).isVisible(), true, 'row actions visible on touch');
    await waitFor(page, () => document.querySelector('#activitybar [data-container="workbench.view.scm"] .badge-content')?.textContent === '3', null, 4000, 'activity badge');
    await waitFor(page, () => document.querySelector('#statusbar [data-id="status.scm.branch"]')?.textContent.trim() === 'main*', null, 4000, 'dirty branch');
    assert.equal(await page.evaluate(async () => (await import('/src/scm/api.js')).git.statusOf('src/new.js')), 'U');
    const diff = await page.evaluate(async () => (await import('/src/scm/api.js')).git.getDiff('src/app.js'));
    assert.match(diff, /-console\.log\('hello'\);\n\+console\.log\('hello, world'\);/);
    await clearToasts(page);
    await t.shot('scm-phone-changes');
    log('M/U/D rows with VS Code decoration colors, .gitignore respected');

    // --- tap → diff editor
    await page.tap(`${rowSel('src/app.js')} .scm-name`);
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.activeInput?.id === 'scm:src/app.js', null, 6000, 'diff opened');
    await page.waitForSelector('.tab.active', { timeout: 4000 }).catch(() => {});
    assert.match(await page.evaluate(() => document.querySelector('.tabs-container .tab.active')?.textContent || ''), /app\.js \(Working Tree\)/);
    await clearToasts(page);
    await page.waitForTimeout(400);
    await t.shot('scm-phone-diff');
    log('diff editor opens from the row');

    // --- stage new.js (row action) → commit & push only the staged file
    await openScm(page);
    await page.tap(`${rowSel('src/new.js')} .scm-actions .codicon-add`);
    await waitFor(page, () => !!document.querySelector('.scm-group[data-group="staged"]') && document.querySelector('.scm-resource[data-path="src/new.js"] .scm-letter')?.textContent === 'A', null, 4000, 'staged group');
    await clearToasts(page);
    await t.shot('scm-phone-staged');
    await typeCommitMessage(page, 'Add new.js');
    const headBefore = gh.repo('octo/hello').refs.get('main');
    await page.tap('.scm-primary');
    await waitNode(page, () => gh.repo('octo/hello').refs.get('main') !== headBefore, 'push of the staged file');
    await idle(page);
    const head1 = gh.repo('octo/hello').refs.get('main');
    assert.notEqual(head1, headBefore, 'remote head moved');
    const c1 = gh.commits.get(head1);
    assert.equal(c1.message, 'Add new.js');
    assert.deepEqual(c1.parents, [headBefore], 'parent = previous remote head');
    assert.equal(gh.fileText('octo/hello', 'src/new.js'), 'export const n = 1;\n', 'staged file pushed');
    assert.equal(gh.fileText('octo/hello', 'src/app.js'), "console.log('hello');\n", 'unstaged change not pushed');
    assert.ok(gh.headTree('octo/hello').has('docs/old.txt'), 'unstaged deletion not pushed');
    assert.equal(await page.locator('.scm-input').inputValue(), '', 'message cleared');
    await waitRows(page, ['M src/app.js', 'D docs/old.txt']);
    assert.equal((await repoState(page)).last, head1);
    const blobPosts = gh.requests.filter(r => r.method === 'POST' && r.path.endsWith('/git/blobs')).length;
    assert.equal(blobPosts, 1, 'only the changed file was uploaded as a blob');
    log('staged file committed & pushed (fake verified tree + parent)');

    // --- commit & push the rest (modification + deletion)
    await typeCommitMessage(page, 'Update app, remove old docs');
    await page.tap('.scm-primary');
    await waitFor(page, () => !document.querySelector('.scm-list .scm-resource'), null, 10000, 'no more changes');
    await idle(page);
    const head2 = gh.repo('octo/hello').refs.get('main');
    assert.equal(gh.commits.get(head2).message, 'Update app, remove old docs');
    assert.deepEqual(gh.commits.get(head2).parents, [head1]);
    assert.equal(gh.fileText('octo/hello', 'src/app.js'), "console.log('hello, world');\n");
    assert.equal(gh.headTree('octo/hello').has('docs/old.txt'), false, 'deletion pushed');
    assert.equal(gh.headTree('octo/hello').has('debug.log'), false, 'ignored file not pushed');
    log('modification + deletion pushed');

    // --- pull a remote change
    gh.commitFiles('octo/hello', { 'README.md': '# hello\n\nEdited on GitHub.\n', 'lib/util.js': 'export const u = 2;\n', 'img/logo.png': null }, 'Remote edit');
    await clearToasts(page);
    await t.command('git.pull');
    await waitFor(page, async () => { const { workspace } = await import('/src/core/workspace.js'); return workspace.fs.exists('lib/util.js'); }, null, 10000, 'pulled file');
    await idle(page);
    assert.equal(await fsRead(page, 'README.md'), '# hello\n\nEdited on GitHub.\n');
    assert.equal(await page.evaluate(async () => { const { workspace } = await import('/src/core/workspace.js'); return workspace.fs.exists('img/logo.png') || workspace.fs.exists('img'); }), false, 'file deleted on GitHub is removed (and its empty folder)');
    assert.deepEqual(await changes(page), [], 'clean after pull');
    assert.equal((await repoState(page)).last, gh.repo('octo/hello').refs.get('main'));
    log('pull applied remote changes');

    // --- remote moved + local commit on different files → automatic rebase on push
    gh.commitFiles('octo/hello', { 'README.md': '# hello\n\nEdited twice on GitHub.\n' }, 'Another remote edit');
    const remoteHead = gh.repo('octo/hello').refs.get('main');
    await fsWrite(page, 'index.html', '<!doctype html>\n<h1>Hello from X Coder</h1>\n<script src="src/app.js"></script>\n');
    await waitRows(page, ['M index.html']);
    await typeCommitMessage(page, 'Edit title');
    await page.tap('.scm-primary');
    await waitNode(page, () => gh.commits.get(gh.repo('octo/hello').refs.get('main'))?.message === 'Edit title', 'rebased push');
    await idle(page);
    const head3 = gh.repo('octo/hello').refs.get('main');
    assert.deepEqual(gh.commits.get(head3).parents, [remoteHead], 'commit rebased on top of the new remote head');
    assert.equal(gh.fileText('octo/hello', 'README.md'), '# hello\n\nEdited twice on GitHub.\n', 'remote change kept');
    assert.match(gh.fileText('octo/hello', 'index.html'), /Hello from X Coder/);
    assert.equal(await fsRead(page, 'README.md'), '# hello\n\nEdited twice on GitHub.\n', 'remote-only change pulled locally');
    assert.deepEqual(await changes(page), []);
    log('push rebased onto remote changes to other files');

    // --- conflict: same file changed locally (uncommitted) and remotely → Cancel, then Overwrite
    gh.commitFiles('octo/hello', { 'src/app.js': "console.log('remote');\n" }, 'Remote app change');
    await fsWrite(page, 'src/app.js', "console.log('local');\n");
    await waitRows(page, ['M src/app.js']);
    await clearToasts(page);
    await t.command('git.pull');
    await page.locator('.monaco-dialog-box', { hasText: 'would be overwritten' }).waitFor();
    assert.match(await page.locator('.monaco-dialog-box').textContent(), /src\/app\.js/);
    await page.waitForTimeout(250);
    await t.shot('scm-phone-conflict');
    await dialogButton(page, 'Cancel');
    await idle(page);
    assert.equal(await fsRead(page, 'src/app.js'), "console.log('local');\n", 'cancel keeps local');
    await t.command('git.pull');
    await dialogButton(page, 'Overwrite Local Changes');
    await waitFor(page, async () => { const { workspace } = await import('/src/core/workspace.js'); return workspace.fs.peekText('src/app.js') === "console.log('remote');\n"; }, null, 10000, 'overwritten');
    await idle(page);
    assert.deepEqual(await changes(page), []);
    log('pull conflict prompt: Cancel keeps local, Overwrite takes remote');

    // --- local commit on a file the remote also changed → push stops with a conflict message
    await page.evaluate(async () => (await import('/src/core/settings.js')).settings.set('git.postCommitCommand', 'none'));
    await fsWrite(page, 'src/app.js', "console.log('mine');\n");
    await waitRows(page, ['M src/app.js']);
    await typeCommitMessage(page, 'My app change');
    await waitFor(page, () => /^Commit$/.test(document.querySelector('.scm-primary')?.textContent.trim()), null, 3000, 'button label follows git.postCommitCommand');
    await page.tap('.scm-primary');
    await waitFor(page, async () => (await import('/src/scm/service.js')).scm.repo?.ahead === 1, null, 6000, 'local commit');
    await waitFor(page, () => /0↓ 1↑/.test(document.querySelector('#statusbar [data-id="status.scm.sync"]')?.textContent || ''), null, 4000, 'status bar 0↓ 1↑');
    await waitFor(page, () => /Sync Changes 1↑/.test(document.querySelector('.scm-primary')?.textContent || ''), null, 4000, 'Sync Changes button');
    await clearToasts(page);
    await t.shot('scm-phone-ahead');
    gh.commitFiles('octo/hello', { 'src/app.js': "console.log('theirs');\n" }, 'Their app change');
    const theirs = gh.repo('octo/hello').refs.get('main');
    await clearToasts(page);
    await t.command('git.push');
    await page.locator('.notification-toast', { hasText: "Can't push" }).waitFor({ timeout: 10000 });
    assert.equal(gh.repo('octo/hello').refs.get('main'), theirs, 'remote untouched on conflict');
    assert.equal((await repoState(page)).ahead, 1, 'local commit kept');
    // undo the local commit → change back in the working tree, then discard it
    await t.command('git.undoCommit');
    await waitFor(page, async () => (await import('/src/scm/service.js')).scm.repo?.ahead === 0, null, 6000, 'undo');
    await waitRows(page, ['M src/app.js']);
    assert.equal(await page.locator('.scm-input').inputValue(), 'My app change', 'message restored after undo');
    await page.tap(`${rowSel('src/app.js')} .scm-actions .codicon-discard`);
    await page.locator('.monaco-dialog-box', { hasText: "discard changes in 'app.js'" }).waitFor();
    await dialogButton(page, 'Discard File');
    await waitFor(page, () => !document.querySelector('.scm-list .scm-resource'), null, 6000, 'discarded');
    assert.equal(await fsRead(page, 'src/app.js'), "console.log('remote');\n", 'discard restored the base content');
    await t.command('git.pull');
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.fs.peekText('src/app.js') === "console.log('theirs');\n", null, 10000, 'pull theirs');
    await idle(page);
    await page.evaluate(async () => (await import('/src/core/settings.js')).settings.set('git.postCommitCommand', 'push'));
    await page.locator('.scm-input').fill('');
    log('push conflict stops, undo last commit, discard');

    // --- discard an untracked file (delete)
    await fsWrite(page, 'tmp.txt', 'scratch\n');
    await waitRows(page, ['U tmp.txt']);
    await t.command('git.clean', 'tmp.txt');
    await page.locator('.monaco-dialog-box', { hasText: "DELETE 'tmp.txt'" }).waitFor();
    await dialogButton(page, 'Delete File');
    await waitFor(page, async () => !(await import('/src/core/workspace.js')).workspace.fs.exists('tmp.txt'), null, 5000, 'untracked deleted');
    log('discard of an untracked file deletes it');

    // --- git in the terminal
    const term = await page.evaluate(async () => {
      const { terminal } = await import('/src/panel/api.js');
      const { workspace } = await import('/src/core/workspace.js');
      await workspace.fs.writeText('term.txt', 'from terminal\n');
      await new Promise(r => setTimeout(r, 400));
      const a = await terminal.run('git status');
      const b = await terminal.run('git add term.txt');
      const c = await terminal.run('git status --short');
      const d = await terminal.run('git commit -m "Terminal commit"');
      const e = await terminal.run('git log --oneline -n 2');
      const f = await terminal.run('git remote -v');
      return { status: a.output, short: c.output, commit: d.output, commitCode: d.exitCode, log: e.output, remote: f.output, add: b.exitCode };
    }).catch(err => ({ error: String(err) }));
    if (term.error) throw new Error(`terminal: ${term.error}`);
    assert.match(term.status, /On branch main/);
    assert.match(term.status, /Untracked files:[\s\S]*term\.txt/);
    assert.equal(term.add, 0);
    assert.match(term.short, /A {2}term\.txt/);
    assert.match(term.commit, /\[main [^\]]+\] Terminal commit/);
    assert.equal(term.commitCode, 0, `git commit exit code: ${term.commit}`);
    assert.equal(gh.fileText('octo/hello', 'term.txt'), 'from terminal\n', 'terminal commit pushed');
    assert.match(term.log, /Terminal commit/);
    assert.match(term.remote, /origin\thttps:\/\/github\.com\/octo\/hello\.git \(fetch\)/);
    log('git status/add/commit/log/remote in the terminal');

    // --- Commits view
    await openScm(page);
    await t.command('git.refresh');
    await waitFor(page, () => [...document.querySelectorAll('.scm-commit .scm-commit-message')].some(e => e.textContent === 'Terminal commit'), null, 8000, 'commits view');
    await clearToasts(page);
    await t.shot('scm-phone-commits');
    log('Commits view lists GitHub commits');

    // --- branches: create + checkout
    await t.command('git.branch', 'feature/x');
    await waitFor(page, async () => (await import('/src/scm/service.js')).scm.repo?.branch === 'feature/x', null, 8000, 'new branch');
    await idle(page);
    assert.ok(gh.repo('octo/hello').refs.has('feature/x'), 'branch created on GitHub');
    await page.tap('#statusbar [data-id="status.scm.branch"] .statusbar-item-label');
    await page.locator('.quick-input-list-entry', { hasText: 'Create new branch from...' }).waitFor();
    await page.locator('.quick-input-list-entry', { hasText: 'main' }).first().waitFor();
    const branchItems = await page.locator('.quick-input-widget .quick-input-list-entry .label-name').allTextContents();
    assert.deepEqual(branchItems.slice(0, 2), ['Create new branch...', 'Create new branch from...']);
    assert.ok(branchItems.includes('feature/x') && branchItems.includes('main'), `branches listed: ${branchItems}`);
    await page.waitForTimeout(150);
    await t.shot('scm-phone-branches');
    // switching with local changes asks first
    await fsWrite(page, 'wip.txt', 'work in progress\n');
    await waitRows(page, ['U wip.txt']);
    await page.locator('.quick-input-widget .quick-input-list-entry', { hasText: /^main/ }).first().click();
    await page.locator('.monaco-dialog-box', { hasText: '1 uncommitted change' }).waitFor();
    await dialogButton(page, 'Discard Changes & Continue');
    await waitFor(page, async () => (await import('/src/scm/service.js')).scm.repo?.branch === 'main', null, 8000, 'checkout main');
    await idle(page);
    assert.equal(await fsRead(page, 'wip.txt'), null, 'untracked file discarded on switch');
    log('branch picker from the status bar, create branch + checkout with confirmation');

    // --- light theme screenshot with changes
    await fsWrite(page, 'src/app.js', "console.log('light');\n");
    await fsWrite(page, 'notes.md', '# notes\n');
    await waitRows(page, ['M src/app.js', 'U notes.md']);
    await page.evaluate(async () => (await import('/src/core/settings.js')).settings.set('workbench.colorTheme', 'light-plus'));
    await page.waitForTimeout(400);
    await openScm(page);
    const lightColor = await page.evaluate(() => getComputedStyle(document.querySelector('.scm-resource[data-path="src/app.js"] .scm-letter')).color);
    assert.equal(lightColor, rgb(await cssVar(page, '--vscode-gitDecoration-modifiedResourceForeground')), 'light theme M color');
    await clearToasts(page);
    await t.shot('scm-phone-light');
    await page.evaluate(async () => (await import('/src/core/settings.js')).settings.set('workbench.colorTheme', 'dark-plus'));
    log('light theme');
    await t.command('git.cleanAll');
    await page.locator('.monaco-dialog-box', { hasText: 'discard ALL changes in 2 files' }).waitFor();
    await dialogButton(page, 'Discard All 2 Files');
    await waitFor(page, () => !document.querySelector('.scm-list .scm-resource'), null, 6000, 'all discarded');
    assert.equal(await fsRead(page, 'notes.md'), null);
    assert.equal(await fsRead(page, 'src/app.js'), "console.log('theirs');\n");
    log('Discard All Changes');

    // --- publish a new project (empty repository bootstrap through the Contents API)
    await page.evaluate(async () => { const { workspace } = await import('/src/core/workspace.js'); await workspace.createProject('Pub Test', { files: { 'index.html': '<h1>pub</h1>\n', 'css/site.css': 'body{}\n', 'app.log': 'ignored\n', '.gitignore': '*.log\n' } }); });
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.project?.name === 'Pub Test', null, 6000, 'pub project');
    await openScm(page);
    await page.locator('.scm-welcome button', { hasText: 'Publish to GitHub' }).click();
    await page.locator('.quick-input-list-entry', { hasText: 'Publish to GitHub private repository' }).waitFor();
    assert.equal(await page.locator('.quick-input-widget input.input').inputValue(), 'Pub-Test');
    await quickPick(page, null);
    await page.locator('.quick-input-widget:not(.hidden) .quick-input-list-entry.multi').first().waitFor();
    const pickLabels = await page.locator('.quick-input-widget .quick-input-list-entry .label-name').allTextContents();
    assert.ok(!pickLabels.includes('app.log'), 'ignored files are not offered');
    await clearToasts(page);
    assert.equal(await page.locator('.quick-input-widget .quick-input-checkbox:checked').count(), 3, 'all files pre-selected');
    await t.shot('scm-phone-publish-files');
    await page.locator('.quick-input-widget input.input').press('Enter');
    await waitFor(page, async () => (await import('/src/scm/service.js')).scm.repo?.git.repo === 'octo/Pub-Test' && (await import('/src/scm/service.js')).scm.repo?.ahead === 0 && !!(await import('/src/scm/service.js')).scm.repo?.git.lastSyncSha, null, 12000, 'published');
    await idle(page);
    const pub = gh.repo('octo/Pub-Test');
    assert.equal(pub.private, true, 'private by default');
    const pubHead = gh.commits.get(pub.refs.get('main'));
    assert.equal(pubHead.message, 'first commit');
    assert.deepEqual(pubHead.parents, [], 'bootstrap commit replaced by a root commit');
    assert.deepEqual([...gh.headTree('octo/Pub-Test').keys()].sort(), ['.gitignore', 'css/site.css', 'index.html']);
    assert.deepEqual(await changes(page), []);
    log('publish to a new private repository');

    // --- sign out from the Accounts menu
    await page.tap('#activitybar .actions-container.global .action-item[title="Accounts"]');
    await page.locator('.context-view-layer .action-item', { hasText: 'octo (GitHub)' }).click();
    await page.locator('.context-view-layer .action-item', { hasText: 'Sign Out' }).click();
    await dialogButton(page, 'Sign Out');
    await waitFor(page, async () => !(await import('/src/scm/auth.js')).auth.isSignedIn(), null, 4000, 'signed out');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('githubToken')), null);
    log('sign out');

    // --- install help + cloud without Puter
    await t.command('xcoder.showInstallHelp');
    await page.locator('.monaco-dialog-box', { hasText: 'Install X Coder on your iPhone or iPad' }).waitFor();
    assert.match(await page.locator('.monaco-dialog-box').textContent(), /Add to Home Screen/);
    await page.waitForTimeout(200);
    await t.shot('scm-phone-install-help');
    await dialogButton(page, 'OK');
    await clearToasts(page);
    await t.command('xcoder.cloud.syncProject');
    await page.locator('.notification-toast', { hasText: 'X Coder Cloud needs a connection to js.puter.com.' }).waitFor({ timeout: 20000 });
    log('install help and offline cloud message');

    t.assertNoErrors();
  } catch (err) {
    failed = true;
    console.error('✗ phone:', err);
    await t.shot('scm-phone-failure').catch(() => {});
  } finally { await t.close(); }
}

// ---------------------------------------------------------------- desktop

/** In-memory stand-in for Puter (js.puter.com is blocked in the sandbox): auth, fs and kv. */
function installFakePuter() {
  const files = new Map(); // path → Blob
  const notFound = path => Object.assign(new Error(`${path} does not exist`), { code: 'subject_does_not_exist' });
  const kvStore = new Map();
  window.__fakePuter = { files, kvStore };
  window.puter = {
    auth: {
      signed: false,
      isSignedIn() { return this.signed; },
      async signIn() { await new Promise(r => setTimeout(r, 50)); this.signed = true; return true; },
      async getUser() { if (!this.signed) throw new Error('not signed in'); return { username: 'tester' }; },
      signOut() { this.signed = false; }
    },
    fs: {
      async write(path, data, opts) {
        if (!opts?.createMissingParents) throw new Error('parents missing');
        files.set(path, data instanceof Blob ? data : new Blob([String(data)]));
        return { path };
      },
      async read(path) { if (!files.has(path)) throw notFound(path); return files.get(path); },
      async readdir(path) {
        const out = new Map();
        for (const p of files.keys()) if (p.startsWith(path + '/')) { const name = p.slice(path.length + 1).split('/')[0]; const isDir = p.slice(path.length + 1).includes('/'); out.set(name, { name, path: `${path}/${name}`, is_dir: isDir }); }
        if (!out.size) throw notFound(path);
        return [...out.values()];
      },
      async delete(path, opts = {}) {
        let n = 0;
        for (const p of [...files.keys()]) if (p === path || (opts.recursive && p.startsWith(path + '/'))) { files.delete(p); n++; }
        if (!n) throw notFound(path);
      }
    },
    kv: {
      async get(k) { return kvStore.has(k) ? JSON.parse(kvStore.get(k)) : null; },
      async set(k, v) { kvStore.set(k, JSON.stringify(v)); return true; },
      async del(k) { kvStore.delete(k); return true; },
      async list(pattern, returnValues) {
        const prefix = String(pattern).replace(/\*$/, '');
        const keys = [...kvStore.keys()].filter(k => k.startsWith(prefix));
        return returnValues ? keys.map(key => ({ key, value: JSON.parse(kvStore.get(key)) })) : keys;
      }
    }
  };
}

async function desktopTests() {
  const gh = new FakeGitHub();
  seedRepo(gh);
  const t = await launch({ device: 'Desktop Chrome', viewport: { width: 1280, height: 800 }, settings: { 'git.autofetch': false } });
  const { page } = t;
  await page.route('https://api.github.com/**', route => gh.handle(route));
  // X Coder Worker with the GitHub Device Flow
  let polls = 0;
  await page.route(/\/mock-worker\/(health|github\/device\/(code|token))$/, async route => {
    const path = new URL(route.request().url()).pathname;
    const reply = data => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(data) });
    if (path.endsWith('/health')) return reply({ ok: true, product: 'X Coder', mode: 'mock', providers: [], capabilities: { streaming: true, githubDeviceFlow: true } });
    if (path.endsWith('/device/code')) return reply({ device_code: 'dev-code-1', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.device_code !== 'dev-code-1') return reply({ error: 'bad_verification_code' });
    return reply(++polls < 2 ? { error: 'authorization_pending' } : { access_token: TOKEN, token_type: 'bearer', scope: 'repo' });
  });
  try {
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.project !== null);
    await page.evaluate(() => { window.__opened = []; window.open = (url) => { window.__opened.push(url); return null; }; });

    // --- device flow sign-in
    await t.command('github.signIn');
    const deviceEntry = page.locator('.quick-input-list-entry:not(.disabled)', { hasText: 'Sign in with GitHub in the Browser' });
    await deviceEntry.waitFor();
    await deviceEntry.click();
    await page.locator('.scm-device-code', { hasText: 'WDJB-MJHT' }).waitFor();
    await page.waitForTimeout(200);
    await t.shot('scm-desktop-device-code');
    await page.locator('.monaco-dialog-box button', { hasText: 'Copy Code & Open GitHub' }).click();
    await waitFor(page, async () => (await import('/src/scm/auth.js')).auth.user?.login === 'octo', null, 10000, 'device flow signed in');
    assert.deepEqual(await page.evaluate(() => window.__opened), ['https://github.com/login/device']);
    assert.equal(await page.locator('.scm-device-code').count(), 0, 'device dialog closed');
    log('device flow sign-in through the X Coder Worker');
    await page.evaluate(async () => (await import('/src/core/settings.js')).settings.set('git.rememberToken', true));
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem('xcoder.github.token'), sessionStorage.getItem('githubToken')]), [TOKEN, null], 'git.rememberToken moves the token to localStorage');
    await page.evaluate(async () => (await import('/src/core/settings.js')).settings.set('git.rememberToken', false));
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem('xcoder.github.token'), sessionStorage.getItem('githubToken')]), [null, TOKEN]);

    // --- connect the default project to an existing repository (conflicting file → overwrite prompt)
    await page.evaluate(async () => { const { workspace } = await import('/src/core/workspace.js'); await workspace.fs.writeText('README.md', '# my local readme\n'); await workspace.fs.writeText('mine.txt', 'only here\n'); });
    await t.command('git.addRemote');
    await quickPick(page, 'octo/hello', { waitLabel: 'octo/hello' });
    await page.locator('.monaco-dialog-box', { hasText: 'would be overwritten' }).waitFor({ timeout: 10000 });
    assert.match(await page.locator('.monaco-dialog-box').textContent(), /README\.md/);
    await dialogButton(page, 'Overwrite Local Changes');
    await waitFor(page, async () => (await import('/src/scm/service.js')).scm.repo?.git.lastSyncSha, null, 10000, 'connected + merged');
    await idle(page);
    assert.equal(await fsRead(page, 'README.md'), '# hello\n\nA test repository.\n', 'remote README after overwrite');
    assert.ok(await fsRead(page, 'src/app.js'), 'remote files merged in');
    assert.equal(await fsRead(page, 'mine.txt'), 'only here\n', 'local-only files kept');
    assert.ok((await changes(page)).includes('U mine.txt'), 'local-only files are untracked');
    // API: commitAndPush + pull
    const apiRes = await page.evaluate(async () => (await import('/src/scm/api.js')).git.commitAndPush('Add mine.txt via API', { paths: ['mine.txt'] }));
    assert.equal(apiRes.pushed, 1);
    assert.equal(gh.fileText('octo/hello', 'mine.txt'), 'only here\n');
    gh.commitFiles('octo/hello', { 'api.txt': 'pulled by the API\n' }, 'For the API pull');
    const pulled = await page.evaluate(async () => (await import('/src/scm/api.js')).git.pull());
    assert.equal(pulled.updated, 1);
    assert.equal(await fsRead(page, 'api.txt'), 'pulled by the API\n');
    await t.command('git.removeRemote');
    await dialogButton(page, 'Remove Remote');
    await waitFor(page, async () => !(await import('/src/scm/api.js')).git.isConnected(), null, 6000, 'remote removed');
    assert.ok(await fsRead(page, 'api.txt'), 'files kept after removing the remote');
    log('connect existing repository (overwrite prompt), git API commitAndPush/pull, remove remote');

    // --- clone by URL argument
    await t.command('git.clone', 'https://github.com/octo/hello.git');
    await waitFor(page, async () => { const { workspace } = await import('/src/core/workspace.js'); return workspace.project?.name === 'hello' && workspace.fs.exists('index.html'); }, null, 15000, 'desktop clone');
    await idle(page);
    await t.command('workbench.view.scm');
    await fsWrite(page, 'src/app.js', "console.log('desktop');\nconsole.log('two');\n");
    await fsWrite(page, 'src/extra.js', '// extra\n');
    await waitRows(page, ['M src/app.js', 'U src/extra.js']);
    await page.locator(rowSel('src/app.js')).click();
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.activeInput?.id === 'scm:src/app.js', null, 6000, 'desktop diff');
    await clearToasts(page);
    await page.waitForTimeout(500);
    await t.shot('scm-desktop-diff');

    // --- keyboard: Ctrl/Cmd+Enter in the message box commits & pushes (git.postCommitCommand = push)
    await page.locator('.scm-input').fill('Desktop commit');
    await page.locator('.scm-input').press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await waitNode(page, () => gh.commits.get(gh.repo('octo/hello').refs.get('main'))?.message === 'Desktop commit', 'desktop commit pushed');
    await idle(page);
    assert.equal(gh.fileText('octo/hello', 'src/extra.js'), '// extra\n');
    log('Ctrl+Enter commit & push');

    // --- auto-push AI edits
    await page.evaluate(async () => (await import('/src/core/settings.js')).settings.set('git.autoPushAIEdits', true));
    await page.evaluate(async () => {
      const { workspace } = await import('/src/core/workspace.js');
      const { bus } = await import('/src/core/events.js');
      await workspace.fs.writeText('src/feature.js', 'export const feature = true;\n', { source: 'ai' });
      await workspace.fs.writeText('notes.txt', 'not part of the AI edit\n');
      bus.emit('ai:editsApplied', { summary: 'Add feature flag', paths: ['src/feature.js'], projectId: workspace.id });
    });
    await waitNode(page, () => gh.commits.get(gh.repo('octo/hello').refs.get('main'))?.message === 'X Coder AI: Add feature flag', 'AI auto-push');
    await idle(page);
    assert.equal(gh.fileText('octo/hello', 'src/feature.js'), 'export const feature = true;\n');
    assert.equal(gh.fileText('octo/hello', 'notes.txt'), null, 'only the AI-edited paths are pushed');
    await waitRows(page, ['U notes.txt']);
    await page.evaluate(async () => (await import('/src/core/settings.js')).settings.set('git.autoPushAIEdits', false));
    log('AI edits auto-pushed with "X Coder AI: <summary>"');

    // --- dropdown menu
    await fsWrite(page, 'README.md', '# hello desktop\n');
    await waitRows(page, ['M README.md', 'U notes.txt']);
    await page.locator('.scm-dropdown').click();
    await page.locator('.context-view-layer .action-item', { hasText: 'Commit & Sync' }).waitFor();
    await clearToasts(page);
    await page.waitForTimeout(250);
    await t.shot('scm-desktop');
    await page.keyboard.press('Escape');
    log('desktop dropdown');

    // --- X Coder 5 project (legacy snapshot hashes) → banner, "Base content unavailable", pull refreshes
    const remoteReadme = gh.fileText('octo/hello', 'README.md');
    await page.evaluate(async ([readme]) => {
      const { workspace } = await import('/src/core/workspace.js');
      const { idbPut } = await import('/src/core/db.js');
      const hex = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
      const p = await workspace.createProject('Legacy', { files: { 'README.md': readme + 'local legacy edit\n', 'index.html': '<!doctype html>\n<h1>Hello from X Coder</h1>\n<script src="src/app.js"></script>\n' }, activate: false });
      p.git = { repo: 'octo/hello', branch: 'main', snapshot: { 'README.md': await hex(readme), 'index.html': await hex('<!doctype html>\n<h1>Hello from X Coder</h1>\n<script src="src/app.js"></script>\n') } };
      await idbPut('projects', p);
      await workspace.openProject(p.id);
    }, [remoteReadme]);
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.project?.name === 'Legacy', null, 6000, 'legacy project');
    await waitRows(page, ['M README.md']);
    await page.waitForSelector('.scm-banner:not(.hidden)');
    assert.match(await page.locator('.scm-banner').textContent(), /base content unavailable — pull to refresh/i);
    await page.locator(rowSel('README.md')).click();
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.activeInput?.id === 'scm:README.md', null, 6000, 'legacy diff');
    assert.match(await page.evaluate(async () => (await import('/src/workbench/editors.js')).editors.activeInput.original), /Base content unavailable — pull to refresh/);
    await t.command('git.pull');
    await waitFor(page, async () => { const { scm } = await import('/src/scm/service.js'); return !scm.repo.isLegacy && !!scm.repo.git.lastSyncSha; }, null, 12000, 'legacy pull');
    await idle(page);
    assert.equal(await fsRead(page, 'README.md'), remoteReadme + 'local legacy edit\n', 'local edit kept (remote unchanged since the snapshot)');
    assert.ok(await fsRead(page, 'src/app.js'), 'files missing locally were pulled');
    await waitFor(page, () => !document.querySelector('.scm-banner:not(.hidden)'), null, 4000, 'banner hidden');
    const base = await page.evaluate(async () => (await import('/src/scm/api.js')).git.getBaseText('README.md'));
    assert.equal(base, remoteReadme, 'real base content after pull');
    await waitFor(page, async ([b]) => (await import('/src/workbench/editors.js')).editors.activeInput?.original === b, [remoteReadme], 6000, 'open diff refreshed after pull');
    await waitRows(page, ['M README.md']);
    log('X Coder 5 project: legacy hashes, banner, pull refreshes the base');

    // --- X Coder Cloud with a stand-in Puter
    await page.evaluate(installFakePuter);
    await page.evaluate(async () => {
      const kv = window.puter.kv;
      await kv.set('xcoder:v1:project:old-1', { id: 'old-1', name: 'Old Cloud Project', updatedAt: Date.now() - 86400000, files: ['index.html', 'logo.png'] });
      await kv.set('xcoder:v1:file:old-1:index.html', { binary: false, mime: 'text/html', content: '<h1>from X Coder 5</h1>\n' });
      await kv.set('xcoder:v1:file:old-1:logo.png', { binary: true, mime: 'image/png', data: btoa(String.fromCharCode(137, 80, 78, 71)) });
    });
    await t.command('xcoder.cloud.signIn');
    await page.locator('.monaco-dialog-box', { hasText: 'Sign-in and storage are provided by' }).waitFor();
    await page.waitForTimeout(200);
    await t.shot('scm-desktop-cloud-signin');
    await page.locator('.monaco-dialog-box button', { hasText: 'Sign in with Puter' }).click();
    await waitFor(page, () => /tester \(X Coder Cloud\)|Not synced/.test(document.querySelector('#statusbar [data-id="status.cloud"]')?.textContent || 'Not synced') && !!window.puter.auth.signed, null, 6000, 'cloud signed in');
    await waitFor(page, () => /Not synced/.test(document.querySelector('#statusbar [data-id="status.cloud"]')?.textContent || ''), null, 4000, 'cloud status item');
    await clearToasts(page);
    await t.command('xcoder.cloud.syncProject');
    await waitFor(page, () => /Synced just now/.test(document.querySelector('#statusbar [data-id="status.cloud"]')?.textContent || ''), null, 8000, 'synced status');
    const cloud = await page.evaluate(async () => {
      const { workspace } = await import('/src/core/workspace.js');
      const id = workspace.project.cloud.id;
      const manifest = JSON.parse(await window.__fakePuter.files.get(`XCoder/projects/${id}/manifest.json`).text());
      const readme = await window.__fakePuter.files.get(`XCoder/projects/${id}/files/README.md`).text();
      return { id, name: manifest.name, count: Object.keys(manifest.files).length, readme, local: workspace.fs.files().length };
    });
    assert.equal(cloud.name, 'Legacy');
    assert.equal(cloud.count, cloud.local, 'every file uploaded');
    assert.match(cloud.readme, /local legacy edit/);
    // accounts menu shows the Puter user
    await page.locator('#activitybar .actions-container.global .action-item[title="Accounts"]').click();
    await page.locator('.context-view-layer .action-item', { hasText: 'tester (X Coder Cloud)' }).waitFor();
    assert.equal(await page.locator('.context-view-layer .action-item', { hasText: 'octo (GitHub)' }).count(), 1);
    await page.keyboard.press('Escape');
    // open the X Coder 5 cloud project
    await t.command('xcoder.cloud.openProject');
    await page.locator('.quick-input-list-entry', { hasText: 'Old Cloud Project' }).waitFor();
    assert.equal(await page.locator('.quick-input-list-entry', { hasText: 'Legacy' }).count(), 1, 'new-format project listed');
    await t.shot('scm-desktop-cloud-open');
    await page.locator('.quick-input-list-entry', { hasText: 'Old Cloud Project' }).click();
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.project?.name === 'Old Cloud Project', null, 8000, 'cloud project opened');
    assert.equal(await fsRead(page, 'index.html'), '<h1>from X Coder 5</h1>\n');
    assert.equal(await page.evaluate(async () => (await import('/src/core/workspace.js')).workspace.fs.isBinary('logo.png')), true);
    // delete the new-format cloud project
    await t.command('xcoder.cloud.deleteProject');
    await page.locator('.quick-input-list-entry', { hasText: 'Legacy' }).click();
    await dialogButton(page, 'Delete from Cloud');
    await waitFor(page, id => ![...window.__fakePuter.files.keys()].some(k => k.startsWith(`XCoder/projects/${id}/`)), cloud.id, 6000, 'cloud project deleted');
    log('X Coder Cloud: Puter sign-in, sync, open (X Coder 5 KV format), delete');

    t.assertNoErrors();
  } catch (err) {
    failed = true;
    console.error('✗ desktop:', err);
    await t.shot('scm-desktop-failure').catch(() => {});
  } finally { await t.close(); }
}

console.log('Source Control (iPhone 13)');
await phoneTests();
console.log('Source Control (desktop)');
await desktopTests();
if (failed) { console.error('scm tests FAILED'); process.exit(1); }
console.log('scm tests passed');
