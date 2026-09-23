// Search end-to-end: search-as-you-type, Match Case / Whole Word / Regex toggles, inline regex errors,
// files to include/exclude globs (search.exclude default), results tree, tap → open + select,
// replace preview, Replace All with Preserve Case, dismiss, Find in Files args, tree view; desktop keyboard.
//
//   node tools/test/search.test.mjs

import assert from 'node:assert/strict';
import { launch } from './harness.mjs';

const log = (...a) => console.log('  ·', ...a);
let failed = false;

async function waitFor(page, fn, arg, timeout = 6000) {
  const start = Date.now();
  for (;;) {
    const v = await page.evaluate(fn, arg).catch(() => false);
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${fn.toString().slice(0, 160)}`);
    await page.waitForTimeout(60);
  }
}
async function settle(page, ms = 250) {
  await page.evaluate(async () => { (await import('/src/platform/notifications.js')).notify.clearAll?.(); }).catch(() => {});
  await page.waitForTimeout(ms);
}
const message = page => page.evaluate(() => document.querySelector('.search-messages')?.textContent || '');
const waitMessage = (page, re) => waitFor(page, src => new RegExp(src).test(document.querySelector('.search-messages')?.textContent || ''), re.source);
const fileRow = (page, path) => page.locator(`.search-row.file[data-key="f:${path}"]`);
const fileCount = (page, path) => fileRow(page, path).locator('.monaco-count-badge').textContent();
const read = (page, path) => page.evaluate(async p => (await import('/src/core/workspace.js')).workspace.fs.readText(p), path);

const seed = page => page.evaluate(async () => {
  const { workspace } = await import('/src/core/workspace.js');
  await workspace.fs.clear();
  await workspace.fs.writeMany([
    { path: 'src/a.js', content: 'const foo = 1;\nfoo();\nconsole.log(Foo);\n' },
    { path: 'src/b.ts', content: 'let fooBar = foo;\n' },
    { path: 'docs/readme.md', content: 'foo in the docs\n' },
    { path: 'node_modules/lib/index.js', content: 'module.exports = foo;\n' },
    { path: 'img.png', blob: new Blob([new Uint8Array([137, 80, 78, 71, 0, 0, 102, 111, 111])], { type: 'image/png' }) }
  ]);
});

async function phoneTests() {
  const t = await launch({ device: 'iPhone 13' });
  const { page } = t;
  try {
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.project !== null);
    await seed(page);

    // ---------- open Search from the Activity Bar ----------
    await page.tap('#activitybar [data-container="workbench.view.search"]');
    await page.waitForSelector('.search-view .search-input', { state: 'visible' });
    const input = page.locator('.search-view .search-input');
    assert.equal(await input.getAttribute('autocapitalize'), 'off');
    assert.equal(await input.getAttribute('placeholder'), 'Search');

    // ---------- search as you type (debounced), node_modules excluded by default, binary skipped ----------
    await input.fill('foo');
    await waitMessage(page, /^6 results in 3 files$/);
    assert.equal(await fileCount(page, 'src/a.js'), '3');
    assert.equal(await fileCount(page, 'src/b.ts'), '2');
    assert.equal(await fileRow(page, 'node_modules/lib/index.js').count(), 0, 'node_modules excluded (search.exclude)');
    assert.equal(await fileRow(page, 'img.png').count(), 0, 'binary files skipped');
    const hl = await page.locator('.search-row.match .findInFileMatch').first().textContent();
    assert.equal(hl.toLowerCase(), 'foo', 'match highlighted');
    await settle(page);
    await t.shot('search-phone-results');
    log('search-as-you-type: 6 results in 3 files');

    // ---------- toggles ----------
    await page.tap('.search-view .codicon-case-sensitive');
    await waitMessage(page, /^5 results in 3 files$/);
    assert.equal(await fileCount(page, 'src/a.js'), '2', 'Match Case');
    await page.tap('.search-view .codicon-whole-word');
    await waitMessage(page, /^4 results in 3 files$/);
    assert.equal(await fileCount(page, 'src/b.ts'), '1', 'Match Whole Word excludes fooBar');
    await page.tap('.search-view .codicon-whole-word');
    await page.tap('.search-view .codicon-case-sensitive');
    log('Match Case / Whole Word ok');

    // ---------- regex + inline error ----------
    await page.tap('.search-view .codicon-regex');
    await input.fill('fo+\\(');
    await waitMessage(page, /^1 result in 1 file$/);
    await input.fill('foo(');
    await page.waitForSelector('.search-view .search-container .monaco-inputbox-message.error');
    assert.match(await page.textContent('.search-view .search-container .monaco-inputbox-message'), /Unterminated group/i);
    await settle(page);
    await t.shot('search-phone-regex-error');
    await page.tap('.search-view .codicon-regex');
    await page.waitForSelector('.search-view .search-container .monaco-inputbox-message.error', { state: 'detached' }).catch(() => {});
    await page.waitForFunction(() => document.querySelector('.search-view .search-container .monaco-inputbox-message')?.classList.contains('hidden'));
    log('regex search + inline error ok');

    // ---------- include / exclude globs ----------
    await input.fill('foo');
    await waitMessage(page, /^6 results in 3 files$/);
    await page.tap('.search-view .query-details .more');
    await page.waitForSelector('.search-view .include-input', { state: 'visible' });
    await page.fill('.search-view .include-input', '*.ts');
    await waitMessage(page, /^2 results in 1 file$/);
    await page.fill('.search-view .include-input', './docs');
    await waitMessage(page, /^1 result in 1 file$/);
    await page.fill('.search-view .include-input', '');
    await page.fill('.search-view .exclude-input', 'docs, *.ts');
    await waitMessage(page, /^3 results in 1 file$/);
    await page.fill('.search-view .exclude-input', '');
    await page.tap('.search-view .codicon-exclude'); // Use Exclude Settings off → node_modules included
    await waitMessage(page, /^7 results in 4 files$/);
    await page.tap('.search-view .codicon-exclude');
    await waitMessage(page, /^6 results in 3 files$/);
    await page.fill('.search-view .include-input', 'src/**/*.{js,ts}');
    await waitMessage(page, /^5 results in 2 files$/);
    await settle(page);
    await t.shot('search-phone-include');
    await page.fill('.search-view .include-input', '');
    await waitMessage(page, /^6 results in 3 files$/);
    log('files to include / exclude globs ok');

    // ---------- tap a match → opens file with the match selected ----------
    await page.locator('.search-row.match[data-key^="m:src/b.ts:"]').last().tap();
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.activePath === 'src/b.ts');
    const selText = await waitFor(page, async () => (await import('/src/editor/api.js')).codeEditor.getActive()?.getSelectionText() || false);
    assert.equal(selText, 'foo', 'the match is selected in the editor');
    const selection = await page.evaluate(async () => (await import('/src/editor/api.js')).codeEditor.getActive().getSelection());
    assert.deepEqual([selection.startLine, selection.startCol], [1, 14], 'second match on line 1 selected');
    log('tap match → editor with selection');

    // ---------- dismiss ----------
    await page.tap('#activitybar [data-container="workbench.view.search"]');
    await page.waitForSelector('.search-view .search-input', { state: 'visible' });
    await page.locator('.search-row.file[data-key="f:docs/readme.md"] .codicon-close').tap();
    await waitMessage(page, /^5 results in 2 files$/);
    log('dismiss file ok');

    // ---------- replace preview + Replace All with Preserve Case ----------
    await page.tap('.search-view .toggle-replace-button');
    await page.waitForSelector('.search-view .replace-input', { state: 'visible' });
    await page.fill('.search-view .replace-input', 'bar');
    await page.waitForSelector('.search-row.match .replaceMatch');
    await page.tap('.search-view .codicon-preserve-case');
    const preview = await page.locator('.search-row.match', { hasText: 'console.log' }).locator('.replaceMatch').textContent();
    assert.equal(preview, 'Bar', 'Preserve Case preview: Foo → Bar');
    assert.ok(await page.locator('.search-row.match .findInFileMatch.replace-strike').count(), 'matches struck through');
    await settle(page);
    await t.shot('search-phone-replace');
    await page.tap('.search-view .replace-actions .codicon-replace-all');
    await page.waitForSelector('.monaco-dialog-box');
    assert.equal(await page.textContent('.monaco-dialog-box .dialog-message'), "Replace 5 occurrences across 2 files with 'bar'?");
    await page.locator('.monaco-dialog-box .monaco-button', { hasText: 'Replace' }).tap();
    await waitFor(page, async () => (await (await import('/src/core/workspace.js')).workspace.fs.readText('src/a.js')).includes('Bar'));
    assert.equal(await read(page, 'src/a.js'), 'const bar = 1;\nbar();\nconsole.log(Bar);\n');
    assert.equal(await read(page, 'src/b.ts'), 'let barBar = bar;\n');
    assert.equal(await read(page, 'docs/readme.md'), 'foo in the docs\n', 'dismissed file untouched');
    await page.waitForSelector('.notification-toast', { hasText: "Replaced 5 occurrences across 2 files with 'bar'." });
    await waitMessage(page, /^1 result in 1 file$/);
    log('Replace All with Preserve Case ok');

    // ---------- per-match replace ----------
    await page.fill('.search-view .replace-input', 'qux');
    await page.tap('.search-view .codicon-preserve-case');
    await page.locator('.search-row.match .codicon-replace').first().tap();
    await waitFor(page, async () => (await (await import('/src/core/workspace.js')).workspace.fs.readText('docs/readme.md')) === 'qux in the docs\n');
    await waitMessage(page, /No results found/);
    assert.match(await message(page), /Open Settings/);
    log('single match replace ok');

    // ---------- Find in Files with VS Code args + tree view ----------
    await page.tap('.search-view .toggle-replace-button');
    await t.command('workbench.action.findInFiles', { query: 'bar', filesToInclude: './src', triggerSearch: true });
    await waitMessage(page, /^6 results in 2 files$/);
    assert.equal(await page.inputValue('.search-view .include-input'), './src');
    await page.evaluate(async () => { const { commands } = await import('/src/core/commands.js'); await commands.execute('search.action.collapseSearchResults'); });
    assert.equal(await page.locator('.search-row.match').count(), 0, 'collapse all');
    await page.tap('.composite.title .codicon-list-tree');
    await page.waitForSelector('.search-row.folder');
    assert.ok(await page.locator('.composite.title .codicon-list-flat').count(), 'View as List action now shown');
    await page.tap('.composite.title .codicon-expand-all');
    await page.waitForSelector('.search-row.match');
    await settle(page);
    await t.shot('search-phone-tree');
    await page.tap('.composite.title .codicon-list-flat');
    await page.tap('.composite.title .codicon-clear-all');
    await page.waitForFunction(() => !document.querySelector('.search-row'));
    assert.equal(await page.inputValue('.search-view .search-input'), '');
    log('findInFiles args, collapse, tree/list, clear ok');

    // state persisted
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('xcoder.search.v6')));
    assert.equal(saved.include, './src');
    t.assertNoErrors();
  } finally { await t.close(); }
}

async function desktopTests() {
  const t = await launch({ device: 'Desktop Chrome', viewport: { width: 1280, height: 800 } });
  const { page } = t;
  try {
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.project !== null);
    await seed(page);
    // Find in Files seeds from the editor selection
    await page.evaluate(async () => { const { editors } = await import('/src/workbench/editors.js'); await editors.open({ type: 'file', path: 'src/a.js' }, { pinned: true }); });
    await waitFor(page, async () => !!(await import('/src/editor/api.js')).codeEditor.getActive());
    await page.evaluate(async () => {
      const ed = (await import('/src/editor/api.js')).codeEditor.getActive();
      ed.view.dispatch({ selection: { anchor: 6, head: 9 } });
    });
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+F`);
    await page.waitForSelector('.search-view .search-input', { state: 'visible' });
    assert.equal(await page.inputValue('.search-view .search-input'), 'foo', 'seeded from the selection');
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('search-input')), 'search input focused');
    await waitMessage(page, /^6 results in 3 files$/);
    const h = await page.locator('.search-row.match').first().evaluate(el => el.getBoundingClientRect().height);
    assert.equal(h, 22, 'desktop rows are 22px');

    // keyboard: type + Enter, arrow down into results, Enter opens
    await page.fill('.search-view .search-input', 'console');
    await page.keyboard.press('Enter');
    await waitMessage(page, /^1 result in 1 file$/);
    await page.locator('.search-row.match').first().click();
    await waitFor(page, async () => (await import('/src/editor/api.js')).codeEditor.getActive()?.getSelectionText() === 'console');
    await page.locator('.search-row.match').first().hover();
    assert.ok(await page.locator('.search-row.match').first().locator('.search-row-actions').isVisible(), 'row actions on hover');
    log('desktop keyboard + click ok');

    // search.smartCase: an upper-case query becomes case-sensitive
    await page.evaluate(async () => (await import('/src/core/settings.js')).settings.set('search.smartCase', true));
    await page.fill('.search-view .search-input', 'Foo');
    await page.keyboard.press('Enter');
    await waitMessage(page, /^1 result in 1 file$/);
    await page.evaluate(async () => (await import('/src/core/settings.js')).settings.set('search.smartCase', false));

    // result limit (2000) message
    await page.evaluate(async () => {
      const { workspace } = await import('/src/core/workspace.js');
      await workspace.fs.writeText('big.txt', Array.from({ length: 2100 }, (_, i) => `needle ${i}`).join('\n'));
    });
    await page.fill('.search-view .search-input', 'needle');
    await page.keyboard.press('Enter');
    await waitMessage(page, /^2000 results in 1 file.*subset of all matches/);
    assert.ok(await page.evaluate(() => document.querySelectorAll('.search-row').length < 200), 'results list is virtualized');
    await page.evaluate(async () => { const { workspace } = await import('/src/core/workspace.js'); await workspace.fs.remove('big.txt'); });
    log('smart case + 2000 result limit message ok');

    // Replace in Files (Mod+Shift+H) + replace preview diff
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+H`);
    await page.waitForSelector('.search-view .replace-input', { state: 'visible' });
    await page.fill('.search-view .replace-input', 'print');
    await page.locator('.search-row.match').first().click();
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.active?.input?.type === 'diff');
    log('replace preview diff opens');

    // Replace All into an editor with unsaved changes edits its buffer (nothing is lost)
    await page.evaluate(async () => (await import('/src/core/settings.js')).settings.set('files.autoSave', 'off'));
    await page.evaluate(async () => { const { editors } = await import('/src/workbench/editors.js'); await editors.open({ type: 'file', path: 'src/b.ts' }, { pinned: true }); });
    await waitFor(page, async () => (await import('/src/editor/api.js')).codeEditor.getActive()?.path === 'src/b.ts');
    await page.evaluate(async () => { const ed = (await import('/src/editor/api.js')).codeEditor.getActive(); ed.view.dispatch({ changes: { from: 0, insert: '// foo unsaved\n' } }); });
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.isDirty('file:src/b.ts'));
    await page.fill('.search-view .search-input', 'foo');
    await page.keyboard.press('Enter');
    await waitMessage(page, /^7 results in 3 files$/); // the unsaved line in b.ts is searched too
    await page.fill('.search-view .replace-input', 'qux');
    await page.click('.search-view .replace-actions .codicon-replace-all');
    await page.locator('.monaco-dialog-box .monaco-button', { hasText: 'Replace' }).click();
    await waitFor(page, async () => (await (await import('/src/core/workspace.js')).workspace.fs.readText('src/a.js')).includes('qux'));
    assert.equal(await read(page, 'src/b.ts'), 'let fooBar = foo;\n', 'dirty file not overwritten on disk');
    const buffer = await page.evaluate(async () => { const { editors } = await import('/src/workbench/editors.js'); const e = editors.findByPath('src/b.ts')[0]; return { text: e.instance.getText(), dirty: e.dirty }; });
    assert.deepEqual(buffer, { text: '// qux unsaved\nlet quxBar = qux;\n', dirty: true }, 'replaced in the unsaved buffer');
    log('Replace All respects unsaved editor buffers');
    await settle(page);
    await t.shot('search-desktop');
    t.assertNoErrors();
  } finally { await t.close(); }
}

for (const [name, fn] of [['iPhone', phoneTests], ['Desktop', desktopTests]]) {
  try { console.log(name); await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed = true; console.error(`  ✗ ${name}:`, err); }
}
process.exit(failed ? 1 : 0);
