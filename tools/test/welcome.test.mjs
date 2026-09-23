// Welcome page: classic VS Code / code-server layout on iPhone + desktop, plus its linked pages.
import { launch } from './harness.mjs';
import assert from 'node:assert/strict';

let t;
try {
  t = await launch({ device: 'iPhone 13' });
  const { page } = t;
  await page.waitForSelector('.welcomePage', { timeout: 10000 });
  const text = await page.textContent('.welcomePage');
  for (const s of ['Start', 'Recent', 'Customize', 'Learn', 'Help', 'New file', 'Open folder...', 'Color theme', 'Interface overview', 'Show welcome page on startup']) assert.ok(text.includes(s), `welcome contains ${s}`);
  assert.equal(await page.textContent('.tab.active .label-name'), 'Welcome');
  // Two columns side by side on the phone, like code-server
  const [a, b] = await page.$$eval('.welcomePage .row > div', els => els.map(e => e.getBoundingClientRect().left));
  assert.ok(b > a + 100, 'splash and commands columns are side by side');
  await t.shot('welcome-iphone');

  // Show on startup checkbox toggles the setting
  await page.click('#welcomeShowOnStartup');
  assert.equal(await page.evaluate(async () => (await import('/src/core/settings.js')).settings.get('workbench.startupEditor')), 'none');
  await page.click('#welcomeShowOnStartup');

  // Interface overview overlay
  await page.click('.welcomePage .item.showInterfaceOverview button');
  await page.waitForSelector('.welcomeOverlay');
  await t.shot('welcome-overview');
  await page.mouse.click(200, 400);
  assert.equal(await page.$('.welcomeOverlay'), null);

  // Interactive playground with live editors
  await page.click('.welcomePage .item.showInteractivePlayground button');
  await page.waitForSelector('.playground .cm-editor', { timeout: 10000 });
  assert.ok((await page.$$('.playground .cm-editor')).length >= 5);
  await t.shot('welcome-playground');

  // Keyboard cheatsheet
  await t.command('workbench.action.keybindingsReference');
  await page.waitForSelector('.cheatsheet table');
  await t.shot('welcome-cheatsheet');

  // Light theme
  await page.evaluate(async () => (await import('/src/core/settings.js')).settings.set('workbench.colorTheme', 'light-plus'));
  await t.command('workbench.action.showWelcomePage');
  await page.waitForTimeout(300);
  await t.shot('welcome-iphone-light');
  t.assertNoErrors();
  await t.close();

  t = await launch({ device: 'Desktop Chrome', viewport: { width: 1280, height: 800 } });
  await t.page.waitForSelector('.welcomePage');
  await t.shot('welcome-desktop');
  t.assertNoErrors();
  await t.close();
  console.log('welcome tests passed');
} catch (err) {
  console.error(err);
  await t?.close().catch(() => {});
  process.exit(1);
}
