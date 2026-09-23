// Boots X Coder in headless Chromium with iPhone emulation and captures errors + a screenshot.
import { chromium, devices } from 'playwright';
import { createStaticServer } from '../dev-server.mjs';

const out = process.argv[2] || '/tmp/xcoder-smoke.png';
const server = createStaticServer();
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) errors.push(`[console.${m.type()}] ${m.text()}`); });
page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`));
page.on('requestfailed', r => { if (!/puter|jsdelivr|esm\.sh/.test(r.url())) errors.push(`[requestfailed] ${r.url()}`); });
await page.route(/^https:\/\/(js\.puter\.com|cdn\.jsdelivr\.net|esm\.sh)\//, r => r.abort());
await page.goto(`http://localhost:${port}/`);
await page.waitForTimeout(2500);
await page.screenshot({ path: out });
console.log(errors.join('\n') || 'no errors');
await browser.close();
server.close();
