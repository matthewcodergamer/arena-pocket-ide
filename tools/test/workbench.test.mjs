// Workbench contributions end-to-end: application menus (☰ drill-down), Manage menu, Color Theme picker
// with live preview, Settings editor, settings.json, Keyboard Shortcuts, Extensions view + editor,
// projects (new / switch / rename / delete), About, Release Notes; plus the desktop title bar menubar.
//
//   node tools/test/workbench.test.mjs

import assert from 'node:assert/strict';
import { launch } from './harness.mjs';

const log = (...a) => console.log('  ·', ...a);
let failed = false;

async function evalApp(page, fn, arg) { return page.evaluate(fn, arg); }
const setting = (page, key) => evalApp(page, async key => (await import('/src/core/settings.js')).settings.get(key), key);
const projectName = page => evalApp(page, async () => (await import('/src/core/workspace.js')).workspace.name);
async function waitFor(page, fn, arg, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    const v = await page.evaluate(fn, arg).catch(() => false);
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${fn.toString().slice(0, 120)}`);
    await page.waitForTimeout(80);
  }
}
const menuRow = (page, label) => page.locator('.context-view-layer .monaco-menu .action-item', { has: page.locator('.action-label', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first();
const menuLabels = page => page.$$eval('.context-view-layer .monaco-menu:not([style*="display: none"]) .action-item .action-label', els => els.map(e => e.textContent));
/** Top-level menus that have at least one visible entry (menus whose commands are all missing are hidden). */
const expectedMenubar = page => page.evaluate(async () => {
  const { menus } = await import('/src/core/menus.js');
  const names = [['menubar/file', 'File'], ['menubar/edit', 'Edit'], ['menubar/selection', 'Selection'], ['menubar/view', 'View'], ['menubar/go', 'Go'], ['menubar/run', 'Run'], ['menubar/terminal', 'Terminal'], ['menubar/help', 'Help']];
  return names.filter(([id]) => menus.resolve(id).length).map(([, n]) => n);
});
/** Lets menu fade-ins / side bar slide-ins finish and clears toasts so screenshots show the settled UI. */
async function settle(page, ms = 250) {
  await page.evaluate(async () => { (await import('/src/platform/notifications.js')).notify.clearAll?.(); }).catch(() => {});
  await page.waitForTimeout(ms);
}
const pickRow = (page, label) => page.locator('#quick-input-widget .quick-input-list-entry', { has: page.locator('.label-name', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first();

async function phoneTests() {
  const t = await launch({ device: 'iPhone 13' });
  const { page } = t;
  try {
    await page.waitForSelector('#activitybar .menubar-toggle', { timeout: 10000 });
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.project !== null);

    // ---------- ☰ application menu → File submenu drill-down ----------
    await page.tap('#activitybar .menubar-toggle');
    await page.waitForSelector('.context-view-layer .monaco-menu');
    const top = await menuLabels(page);
    const expectedTop = await expectedMenubar(page);
    for (const m of ['File', 'View', 'Go', 'Help']) assert.ok(expectedTop.includes(m), `${m} menu always has entries`);
    for (const m of expectedTop) assert.ok(top.includes(m), `app menu has ${m} (got ${top.join(', ')})`);
    log(`menubar: ${expectedTop.join(' ')}`);
    await settle(page);
    await t.shot('workbench-appmenu');
    await menuRow(page, 'File').tap();
    await page.waitForSelector('.context-view-layer .menu-back');
    const file = await menuLabels(page);
    for (const m of ['New Text File', 'New File…', 'New Project…', 'Open Project…', 'Open Recent', 'Save', 'Auto Save', 'Preferences', 'Rename Project…', 'Delete Project…']) {
      if (['New Text File', 'New File…'].includes(m) && !file.includes(m)) { log(`note: "${m}" hidden (its command is not registered in this build)`); continue; }
      assert.ok(file.includes(m), `File menu has ${m} (got ${file.join(', ')})`);
    }
    await settle(page);
    await t.shot('workbench-appmenu-file');
    // Preferences submenu drills down further
    await menuRow(page, 'Preferences').tap();
    const prefs = await menuLabels(page);
    assert.ok(prefs.includes('Settings') && prefs.includes('Color Theme') && prefs.includes('Keyboard Shortcuts'), `Preferences submenu: ${prefs}`);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    if (await page.$('.context-view-layer')) await page.mouse.click(380, 400);
    // Help menu wording
    await page.tap('#activitybar .menubar-toggle');
    await menuRow(page, 'Help').tap();
    const help = await menuLabels(page);
    for (const m of ['Show All Commands', 'Documentation', 'Release Notes', 'Report Issue', 'Check for Updates…', 'Toggle Developer Tools', 'About']) assert.ok(help.includes(m), `Help has ${m} (${help})`);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    log('application menus ok');

    // ---------- Manage (gear) menu ----------
    await page.tap('#activitybar .actions-container.global li[aria-label="Manage"]');
    await page.waitForSelector('.context-view-layer .monaco-menu');
    const manage = await menuLabels(page);
    for (const m of ['Command Palette…', 'Settings', 'Extensions', 'Keyboard Shortcuts', 'Themes', 'Check for Updates…', 'About']) assert.ok(manage.includes(m), `Manage has ${m} (${manage})`);
    await settle(page);
    await t.shot('workbench-manage-menu');
    await menuRow(page, 'Themes').tap();
    await menuRow(page, 'Color Theme').tap();
    log('manage menu ok');

    // ---------- Color Theme picker: live preview, Escape restores ----------
    await page.waitForSelector('#quick-input-widget:not(.hidden) .quick-input-list-entry');
    const labels = await page.$$eval('#quick-input-widget .quick-input-list-entry .label-name', els => els.map(e => e.textContent));
    assert.deepEqual([...labels].sort(), ['Dark High Contrast', 'Dark Modern', 'Dark+', 'Light Modern', 'Light+'].sort());
    // Move the active item to Light+ with the keyboard → previewed immediately.
    const idx = labels.indexOf('Light+');
    const cur = labels.indexOf('Dark+');
    for (let i = 0; i < Math.abs(cur - idx); i++) await page.keyboard.press(idx < cur ? 'ArrowUp' : 'ArrowDown');
    await waitFor(page, () => document.documentElement.dataset.theme === 'light-plus');
    assert.equal(await setting(page, 'workbench.colorTheme'), 'dark-plus', 'preview does not change the setting');
    await t.shot('workbench-theme-preview-light');
    await page.keyboard.press('Escape');
    await waitFor(page, () => document.documentElement.dataset.theme === 'dark-plus');
    // Accept Light+ by tapping, then go back to Dark+.
    await t.command('workbench.action.selectTheme');
    await pickRow(page, 'Light+').tap();
    await waitFor(page, async () => (await import('/src/core/settings.js')).settings.get('workbench.colorTheme') === 'light-plus');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light-plus');
    await t.command('workbench.action.selectTheme');
    await pickRow(page, 'Dark+').tap();
    await waitFor(page, () => document.documentElement.dataset.theme === 'dark-plus');
    log('theme picker ok');

    // ---------- Settings editor ----------
    await page.evaluate(async () => {
      const { settings } = await import('/src/core/settings.js');
      if (!settings.schema('editor.fontSize')) settings.register({ key: 'editor.fontSize', type: 'number', default: 14, min: 6, max: 100, integer: true, title: 'Font Size', description: 'Controls the font size in pixels.', category: 'Text Editor/Font', common: true });
    });
    await t.command('workbench.action.openSettings');
    await page.waitForSelector('.settings-editor .setting-item');
    assert.ok(await page.$eval('.settings-editor', el => el.classList.contains('narrow')), 'TOC is replaced by chips on the phone');
    assert.ok((await page.$$('.settings-toc-chip')).length >= 2, 'category chips');
    await t.shot('workbench-settings');
    await page.tap('.settings-search-container input');
    await page.fill('.settings-search-container input', 'font size');
    await page.waitForFunction(() => /Settings? Found/.test(document.querySelector('.settings-count-widget')?.textContent || ''));
    const row = page.locator('.setting-item[data-key="editor.fontSize"]').first();
    await row.waitFor();
    const numberInput = row.locator('input[type="number"]');
    await numberInput.fill('18');
    await waitFor(page, async () => (await import('/src/core/settings.js')).settings.get('editor.fontSize') === 18);
    assert.ok(await row.evaluate(el => el.classList.contains('is-configured')), 'modified indicator shown');
    await page.locator('.settings-search-container input').blur();
    await settle(page, 100);
    await t.shot('workbench-settings-search');
    await numberInput.fill('2');
    await page.waitForSelector('.setting-item[data-key="editor.fontSize"] .setting-item-validation-message:not(.hidden)');
    assert.equal(await setting(page, 'editor.fontSize'), 18, 'invalid value is not applied');
    await numberInput.fill('18');
    await page.waitForSelector('.setting-item[data-key="editor.fontSize"] .setting-item-validation-message.hidden', { state: 'attached' });
    // @modified filter
    await page.fill('.settings-search-container input', '@modified');
    await page.waitForFunction(() => document.querySelectorAll('.settings-tree-container .setting-item').length >= 1 && [...document.querySelectorAll('.settings-tree-container .setting-item')].every(r => r.classList.contains('is-configured')));
    // gear → Reset Setting
    await page.fill('.settings-search-container input', 'font size');
    await page.locator('.setting-item[data-key="editor.fontSize"] .setting-toolbar-container .action-label').first().tap();
    await menuRow(page, 'Reset Setting').tap();
    await waitFor(page, async () => { const { settings } = await import('/src/core/settings.js'); return !settings.isModified('editor.fontSize'); });
    // enum + boolean controls update settings
    await page.fill('.settings-search-container input', 'startup editor');
    await page.selectOption('.setting-item[data-key="workbench.startupEditor"] select', { label: 'None' });
    await waitFor(page, async () => (await import('/src/core/settings.js')).settings.get('workbench.startupEditor') === 'none');
    await page.fill('.settings-search-container input', 'auto detect color');
    await page.locator('.setting-item[data-key="window.autoDetectColorScheme"] input[type="checkbox"]').tap();
    await waitFor(page, async () => (await import('/src/core/settings.js')).settings.get('window.autoDetectColorScheme') === true);
    await page.locator('.setting-item[data-key="window.autoDetectColorScheme"] input[type="checkbox"]').tap();
    await waitFor(page, async () => (await import('/src/core/settings.js')).settings.get('window.autoDetectColorScheme') === false);
    // deep link prefill (tab already open: key() hand-off)
    await page.evaluate(async () => { const { editors } = await import('/src/workbench/editors.js'); await editors.open({ type: 'settings', query: 'color theme' }); });
    await waitFor(page, () => document.querySelector('.settings-search-container input')?.value === 'color theme');
    log('settings editor ok');

    // ---------- settings.json ----------
    await page.locator('#editor-actions .codicon-go-to-file').tap(); // "Open Settings (JSON)" title action
    await page.waitForSelector('.settings-json-editor .cm-content');
    const setDoc = text => page.evaluate(async text => {
      const { view } = await import('/vendor/codemirror.js');
      const v = view.EditorView.findFromDOM(document.querySelector('.editor-instance:not(.hidden) .settings-json-editor .cm-editor'));
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    }, text);
    const original = await page.evaluate(async () => { const v = (await import('/src/core/settings.js')).settings.userValues(); delete v['editor.fontSize']; delete v['workbench.startupEditor']; return v; });
    const body = Object.entries(original).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`).join('');
    await setDoc(`{\n  // comments and trailing commas are allowed\n${body}  "editor.fontSize": 20,\n  "workbench.startupEditor": "welcomePage",\n}\n`);
    assert.ok(await page.evaluate(async () => (await import('/src/workbench/editors.js')).editors.active?.dirty), 'settings.json is dirty after an edit');
    await t.command('workbench.action.files.save');
    await waitFor(page, async () => (await import('/src/core/settings.js')).settings.get('editor.fontSize') === 20);
    assert.equal(await setting(page, 'workbench.startupEditor'), 'welcomePage');
    await t.shot('workbench-settings-json');
    await setDoc('{\n  "editor.fontSize": ,\n}\n');
    await t.command('workbench.action.files.save');
    await page.waitForSelector('.settings-json-banner:not(.hidden)');
    assert.match(await page.textContent('.settings-json-banner'), /line 2/);
    assert.equal(await setting(page, 'editor.fontSize'), 20, 'invalid JSON is not applied');
    await t.shot('workbench-settings-json-error');
    await setDoc(`${JSON.stringify(original, null, 2)}\n`);
    await t.command('workbench.action.files.save');
    await waitFor(page, async () => { const { settings } = await import('/src/core/settings.js'); return !settings.isModified('editor.fontSize'); });
    assert.equal(await setting(page, 'xcoder.ai.routerUrl'), original['xcoder.ai.routerUrl'], 'other user settings survive the round trip');
    log('settings.json ok');

    // ---------- Keyboard Shortcuts ----------
    await t.command('workbench.action.openGlobalKeybindings');
    await page.waitForSelector('.keybindings-editor .keybindings-row');
    await page.fill('.keybindings-search-container input', 'save all');
    await page.waitForSelector('.keybindings-row[data-command="workbench.action.files.saveAll"]');
    await page.fill('.keybindings-search-container input', 'settings');
    await page.waitForSelector('.keybindings-row[data-command="workbench.action.openSettings"] .monaco-keybinding-key');
    await settle(page, 100);
    await t.shot('workbench-keybindings');
    log('keyboard shortcuts ok');

    // ---------- Extensions view + details ----------
    await page.tap('#activitybar li[data-container="workbench.view.extensions"]');
    await page.waitForSelector('.extensions-viewlet .extension-list-item');
    const sections = await page.$$eval('.extensions-section-header .title', els => els.map(e => e.textContent));
    assert.deepEqual(sections, ['INSTALLED', 'BUILT-IN FEATURES']);
    await settle(page, 450);
    await t.shot('workbench-extensions');
    await page.fill('.extensions-search-box input', 'emmet');
    await page.waitForFunction(() => document.querySelectorAll('.extension-list-item').length === 1);
    await page.tap('.extension-list-item[data-extension="xcoder.emmet"]');
    await page.waitForSelector('.extension-editor .title .name');
    assert.equal(await page.textContent('.editor-instance:not(.hidden) .extension-editor .title .name'), 'Emmet');
    await settle(page, 100);
    await t.shot('workbench-extension-details');
    await page.locator('.editor-instance:not(.hidden) .extension-editor .navbar-item[data-tab="features"]').tap();
    await page.waitForSelector('.editor-instance:not(.hidden) .extension-features h3');
    const before = await setting(page, 'emmet.enabled');
    await page.locator('.editor-instance:not(.hidden) .extension-editor .header .actions .monaco-button').tap();
    await waitFor(page, async v => (await import('/src/core/settings.js')).settings.get('emmet.enabled') === !(v ?? true), before);
    await page.waitForFunction(() => document.querySelector('.editor-instance:not(.hidden) .extension-editor .header .actions .monaco-button')?.textContent === 'Enable');
    await t.shot('workbench-extension-features');
    await page.locator('.editor-instance:not(.hidden) .extension-editor .header .actions .monaco-button').tap();
    await waitFor(page, async () => (await import('/src/core/settings.js')).settings.get('emmet.enabled') === true);
    log('extensions ok');

    // ---------- Projects: new from template, switch, rename, delete ----------
    const firstName = await projectName(page);
    await t.command('xcoder.project.new');
    await pickRow(page, 'Empty Project').tap();
    await page.waitForSelector('#quick-input-widget.input-only:not(.hidden) input');
    await page.fill('#quick-input-widget input', 'Workbench Test');
    await page.keyboard.press('Enter');
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.name === 'Workbench Test');
    assert.ok(await page.evaluate(async () => (await import('/src/core/workspace.js')).workspace.fs.exists('README.md')), 'template files written');
    await t.command('workbench.action.openRecent');
    await page.waitForSelector('#quick-input-widget:not(.hidden) .xc-project-entry');
    await settle(page, 100);
    await t.shot('workbench-projects-picker');
    const detail = await page.textContent('#quick-input-widget .xc-project-entry .label-detail');
    assert.match(detail, /Current project · 1 file · opened/);
    await pickRow(page, firstName).tap();
    await waitFor(page, async n => (await import('/src/core/workspace.js')).workspace.name === n, firstName);
    const testId = await page.evaluate(async () => (await (await import('/src/core/workspace.js')).workspace.listProjects()).find(p => p.name === 'Workbench Test').id);
    await t.command('xcoder.project.rename', testId);
    await page.waitForSelector('#quick-input-widget.input-only:not(.hidden) input');
    await page.fill('#quick-input-widget input', 'Renamed Project');
    await page.keyboard.press('Enter');
    await waitFor(page, async id => (await (await import('/src/core/workspace.js')).workspace.getProject(id))?.name === 'Renamed Project', testId);
    // File > Open Recent lists it
    await page.tap('#activitybar .menubar-toggle');
    await menuRow(page, 'File').tap();
    await menuRow(page, 'Open Recent').tap();
    assert.ok((await menuLabels(page)).includes('Renamed Project'), 'Open Recent lists the other project');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    // Deleting the open project offers to switch first (cancel it)
    await t.command('xcoder.project.delete');
    await page.waitForSelector('.monaco-dialog-box');
    assert.match(await page.textContent('.monaco-dialog-box .dialog-message'), /is the open project/);
    await page.locator('.monaco-dialog-box .dialog-buttons .monaco-button', { hasText: 'Cancel' }).tap();
    // Delete the other project with confirmation
    await t.command('xcoder.project.delete', testId);
    await page.waitForSelector('.monaco-dialog-box');
    await t.shot('workbench-project-delete-confirm');
    await page.locator('.monaco-dialog-box .dialog-buttons .monaco-button', { hasText: 'Delete' }).tap();
    await waitFor(page, async id => !(await (await import('/src/core/workspace.js')).workspace.getProject(id)), testId);
    log('projects ok');

    // ---------- About, Release Notes, Open View ----------
    await t.command('workbench.action.showAboutDialog');
    await page.waitForSelector('.monaco-dialog-box .dialog-message-detail');
    assert.match(await page.textContent('.monaco-dialog-box .dialog-message-detail'), /Version: 6\.\d+\.\d+/);
    await settle(page, 100);
    await t.shot('workbench-about');
    await page.locator('.monaco-dialog-box .dialog-buttons .monaco-button', { hasText: 'OK' }).tap();
    await t.command('update.showCurrentReleaseNotes');
    await page.waitForSelector('.release-notes-body h1');
    assert.match(await page.textContent('.release-notes-body h1'), /X Coder 6/);
    await settle(page, 100);
    await t.shot('workbench-release-notes');
    await t.command('workbench.action.openView');
    await page.waitForSelector('#quick-input-widget:not(.hidden) .quick-input-list-entry');
    await pickRow(page, 'Extensions').tap();
    await page.waitForSelector('#sidebar .extensions-viewlet', { state: 'visible' });
    const autoSaveBefore = await setting(page, 'files.autoSave');
    await t.command('workbench.action.toggleAutoSave');
    assert.equal(await setting(page, 'files.autoSave'), autoSaveBefore === 'off' ? 'afterDelay' : 'off');
    await t.command('workbench.action.toggleAutoSave');
    assert.equal(await setting(page, 'files.autoSave'), autoSaveBefore === 'off' ? 'off' : 'afterDelay');
    log('about / release notes / open view / auto save ok');

    t.assertNoErrors();
  } finally {
    await t.close();
  }
}

async function desktopTests() {
  const t = await launch({ device: 'Desktop Chrome', viewport: { width: 1280, height: 800 } });
  const { page } = t;
  try {
    await page.waitForSelector('#titlebar .menubar-menu-button', { timeout: 10000 });
    const titles = await page.$$eval('#titlebar .menubar-menu-button', els => els.map(e => e.textContent));
    assert.deepEqual(titles, await expectedMenubar(page));
    assert.ok(await page.$('#titlebar .command-center-center'), 'command center');
    await t.shot('workbench-desktop-titlebar');
    await page.click('#titlebar .menubar-menu-button:has-text("File")');
    await page.waitForSelector('.context-view-layer .monaco-menu');
    await menuRow(page, 'Open Recent').hover();
    await page.waitForTimeout(400);
    await settle(page);
    await t.shot('workbench-desktop-file-menu');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await t.command('workbench.action.openSettings');
    await page.waitForSelector('.settings-editor .settings-toc-entry');
    assert.ok(!(await page.$eval('.settings-editor', el => el.classList.contains('narrow'))), 'TOC visible on desktop');
    await page.click('.settings-toc-entry[data-toc="toc:Workbench"]');
    await t.shot('workbench-desktop-settings');
    await t.command('workbench.view.extensions');
    await page.waitForSelector('.extensions-viewlet .extension-list-item');
    await page.click('.extension-list-item[data-extension="xcoder.ai"]');
    await page.waitForSelector('.editor-instance:not(.hidden) .extension-editor .xc-markdown h1');
    await t.shot('workbench-desktop-extension');
    t.assertNoErrors();
  } finally {
    await t.close();
  }
}

const started = Date.now();
for (const [name, fn] of [['iPhone 13', phoneTests], ['Desktop', desktopTests]]) {
  try { console.log(`workbench: ${name}`); await fn(); }
  catch (err) { failed = true; console.error(`FAIL workbench (${name}):`, err); }
}
console.log(`workbench tests ${failed ? 'FAILED' : 'passed'} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(failed ? 1 : 0);
