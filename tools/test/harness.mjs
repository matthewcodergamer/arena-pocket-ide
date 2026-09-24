// Shared Playwright harness for X Coder feature tests.
//
//   import { launch } from './harness.mjs';
//   const t = await launch({ device: 'iPhone 13', settings: { 'workbench.colorTheme': 'dark-plus' } });
//   await t.page.click('…');
//   t.mock.enqueue('Hello from the mock model');            // next /agent response (plain text)
//   t.mock.enqueue(body => `echo: ${body.messages.at(-1).content}`);  // or computed from the request body
//   await t.shot('explorer');                                // screenshot → tools/test/out/<name>.png
//   t.assertNoErrors();                                      // throws if page errors / console errors were logged
//   await t.close();
//
// CDNs (Puter, jsDelivr, esm.sh) are blocked in CI sandboxes; they're aborted so the app's
// offline fallbacks are exercised. The mock AI Worker lives at <origin>/mock-worker.

import { chromium, devices } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../dev-server.mjs';

const OUT = join(fileURLToPath(new URL('.', import.meta.url)), 'out');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export function createMockWorker() {
  const queue = [];
  const requests = [];
  const models = [
    { id: 'mock-coder-large', provider: 'mock', name: 'Mock Coder Large', context: 128000, free: true, vision: true },
    { id: 'mock-fast', provider: 'mock', name: 'Mock Fast', context: 32000, free: true, vision: false }
  ];
  const providers = [{ id: 'mock', label: 'Mock Provider', configured: true, kind: 'openai', status: 'ready', modelCount: 2, capabilities: ['text', 'code', 'vision'] }];
  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
  }
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/mock-worker')) return false;
    const path = url.pathname.slice('/mock-worker'.length) || '/';
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return true; }
    if (path === '/health') { res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, product: 'X Coder', mode: 'mock', providers, capabilities: { streaming: true, vision: true, fetch: true } })); return true; }
    if (path === '/models' || path === '/providers') { res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ models, providers })); return true; }
    if (path === '/fetch') { res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ url: url.searchParams.get('url'), status: 200, contentType: 'text/plain', text: 'Mock fetched page text.' })); return true; }
    if (path === '/agent' || path === '/chat') {
      const body = await readBody(req);
      requests.push(body);
      const next = queue.shift();
      let text = typeof next === 'function' ? await next(body) : (next ?? 'Mock response: no scripted reply was queued.');
      const meta = { provider: 'Mock Provider', providerId: 'mock', model: body.model || 'mock-coder-large', usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, attempts: [{ provider: 'mock', model: 'mock-coder-large', ok: true }] };
      if (body.stream) {
        res.writeHead(200, { ...cors, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ type: 'start', ...meta })}\n\n`);
        for (let i = 0; i < text.length; i += 24) {
          res.write(`data: ${JSON.stringify({ type: 'delta', text: text.slice(i, i + 24) })}\n\n`);
          await new Promise(r => setTimeout(r, 5));
        }
        res.write(`data: ${JSON.stringify({ type: 'done', ...meta })}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ text, ...meta }));
      }
      return true;
    }
    res.writeHead(404, cors).end('{"error":"not found"}');
    return true;
  };
  return { handler, enqueue: (...items) => queue.push(...items), requests, queue, models, providers };
}

export async function launch({ device = 'iPhone 13', settings = {}, localStorage: extraLocal = {}, headless = true, viewport, clearStorage = true } = {}) {
  const mock = createMockWorker();
  const server = createStaticServer(mock.handler);
  await new Promise(r => server.listen(0, r));
  const origin = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch({ headless, executablePath: CHROME }).catch(() => chromium.launch({ headless }));
  const deviceOpts = devices[device] || {};
  const context = await browser.newContext({ ...deviceOpts, ...(viewport ? { viewport } : {}), serviceWorkers: 'block' });
  const allSettings = { 'xcoder.ai.routerUrl': `${origin}/mock-worker`, ...settings };
  await context.addInitScript(({ allSettings, extraLocal, clearStorage }) => {
    if (clearStorage && !sessionStorage.getItem('__xc_test_init')) {
      sessionStorage.setItem('__xc_test_init', '1');
      localStorage.clear();
      indexedDB.deleteDatabase('arena-pocket-ide-v1');
    }
    if (!localStorage.getItem('xcoder.settings.v6')) localStorage.setItem('xcoder.settings.v6', JSON.stringify(allSettings));
    localStorage.setItem('xcoder.settings.migrated.v6', '1');
    for (const [k, v] of Object.entries(extraLocal)) localStorage.setItem(k, v);
  }, { allSettings, extraLocal, clearStorage });
  const page = await context.newPage();
  const errors = [];
  page.on('console', m => {
    const text = m.text();
    if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::ERR|puter/i.test(text)) errors.push(`[console.error] ${text}`);
  });
  page.on('pageerror', e => errors.push(`[pageerror] ${e.message}\n${e.stack || ''}`));
  await page.route(/^https:\/\/(js\.puter\.com|api\.puter\.com|cdn\.jsdelivr\.net|esm\.sh|raw\.githubusercontent\.com|fonts\.googleapis\.com)\//, r => r.abort());
  await page.goto(`${origin}/`);
  await page.waitForSelector('#boot-screen', { state: 'detached', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
  await mkdir(OUT, { recursive: true });
  return {
    page, context, browser, origin, mock, errors,
    async shot(name, opts = {}) { const path = join(OUT, `${name}.png`); await page.screenshot({ path, ...opts }); return path; },
    assertNoErrors() { if (errors.length) throw new Error(`Page errors:\n${errors.join('\n')}`); },
    /** Starts a command by id through the app's command registry (does not wait for it to finish —
     *  many commands, like the Command Palette, resolve only when their UI closes). */
    async command(id, ...args) {
      await page.evaluate(async ([id, args]) => { const { commands } = await import('/src/core/commands.js'); commands.execute(id, ...args).catch(e => console.error(e)); }, [id, args]);
      await page.waitForTimeout(150);
    },
    /** Runs a command and waits for its result (only for commands that complete on their own). */
    async commandResult(id, ...args) { return page.evaluate(async ([id, args]) => { const { commands } = await import('/src/core/commands.js'); return commands.execute(id, ...args); }, [id, args]); },
    async close() { await browser.close(); server.close(); }
  };
}
