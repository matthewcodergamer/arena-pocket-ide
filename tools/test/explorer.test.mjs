// Explorer end-to-end: Folders tree on iPhone (compact folders, decorations, inline New File / New Folder /
// Rename with validation, long-press context menu, Delete + Undo, preview tabs), ZIP import/export,
// Quick Open with :line, Open Editors; then desktop mouse/keyboard (double-click pin, F2, arrows,
// copy/paste, drag & drop move).
//
//   node tools/test/explorer.test.mjs

import assert from 'node:assert/strict';
import { launch } from './harness.mjs';

const log = (...a) => console.log('  ·', ...a);
let failed = false;

async function waitFor(page, fn, arg, timeout = 6000) {
  const start = Date.now();
  for (;;) {
    const v = await page.evaluate(fn, arg).catch(() => false);
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${fn.toString().slice(0, 140)}`);
    await page.waitForTimeout(60);
  }
}
const exists = (page, path) => page.evaluate(async p => (await import('/src/core/workspace.js')).workspace.fs.exists(p), path);
const row = (page, path) => page.locator(`.explorer-tree .explorer-row[data-path="${path}"]`);
const menuRow = (page, label) => page.locator('.context-view-layer .monaco-menu .action-item', { has: page.locator('.action-label', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first();
async function settle(page, ms = 250) {
  await page.evaluate(async () => { (await import('/src/platform/notifications.js')).notify.clearAll?.(); }).catch(() => {});
  await page.waitForTimeout(ms);
}
/** Touch long-press (pointerType touch) on the element → context menu. */
async function longPress(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box, `element for long-press: ${selector}`);
  const x = box.x + Math.min(60, box.width / 2), y = box.y + box.height / 2;
  await page.evaluate(({ selector, x, y }) => {
    const el = document.querySelector(selector);
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y, isPrimary: true }));
  }, { selector, x, y });
  await page.waitForTimeout(650);
  await page.evaluate(({ selector, x, y }) => {
    const el = document.querySelector(selector);
    el?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y, isPrimary: true }));
  }, { selector, x, y });
  await page.waitForSelector('.context-view-layer .monaco-menu');
}
async function openExplorer(page) {
  const visible = await page.evaluate(async () => (await import('/src/workbench/views.js')).views.isVisible('workbench.view.explorer'));
  if (!visible) await page.tap('#activitybar [data-container="workbench.view.explorer"]');
  await page.waitForSelector('.pane[data-view-id="workbench.explorer.fileView"] .pane-body', { state: 'visible' });
}
const seed = page => page.evaluate(async () => {
  const { workspace } = await import('/src/core/workspace.js');
  await workspace.fs.writeMany([
    { path: 'src/components/Button.jsx', content: 'export const Button = () => null;\n' },
    { path: 'src/components/Card.jsx', content: 'export const Card = 1;\n' },
    { path: 'src/app.js', content: 'console.log("hello");\nconst answer = 42;\nexport default answer;\n' },
    { path: 'lib/util/helpers.js', content: 'export const add = (a, b) => a + b;\n' },
    { path: 'docs/guide.md', content: '# Guide\n' },
    { path: 'package.json', content: '{ "name": "demo" }\n' }
  ]);
});

async function phoneTests() {
  const t = await launch({ device: 'iPhone 13' });
  const { page } = t;
  try {
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.project !== null);
    await seed(page);

    // ---------- open the Explorer from the Activity Bar ----------
    await openExplorer(page);
    const title = await page.textContent('.pane[data-view-id="workbench.explorer.fileView"] .pane-header .title');
    assert.equal(title, 'MY PROJECT', 'Folders view title is the project name');
    assert.equal(await page.locator('.pane[data-view-id="workbench.explorer.openEditorsView"]').getAttribute('class').then(c => c.includes('collapsed')), true, 'Open Editors collapsed by default');
    // No folder icons (Seti), twisties only; file rows have Seti icons.
    assert.equal(await row(page, 'src').locator('.explorer-file-icon').count(), 0, 'folders have no icon');
    assert.equal(await row(page, 'package.json').locator('.explorer-file-icon .file-icon').count(), 1, 'files have a Seti icon');
    const h = await row(page, 'src').evaluate(el => el.getBoundingClientRect().height);
    assert.ok(h >= 28, `touch row height >= 28 (got ${h})`);

    // ---------- compact folders: lib/util in one row ----------
    const compact = row(page, 'lib/util');
    await compact.waitFor();
    assert.equal((await compact.locator('.label-segment').allTextContents()).join('/'), 'lib/util', 'compact folder row shows lib/util');
    log('compact folders ok');

    // ---------- expand src, problem decorations ----------
    await row(page, 'src').tap();
    await row(page, 'src/app.js').waitFor();
    assert.equal(await row(page, 'src').getAttribute('aria-expanded'), 'true');
    await page.evaluate(async () => {
      const { diagnostics } = await import('/src/core/diagnostics.js');
      diagnostics.set('explorer-test', 'src/app.js', [{ line: 1, col: 1, severity: 'error', message: 'Test error' }, { line: 2, col: 1, severity: 'warning', message: 'Test warning' }]);
    });
    await waitFor(page, () => document.querySelector('.explorer-row[data-path="src/app.js"] .explorer-item.deco-error'));
    assert.equal(await row(page, 'src/app.js').locator('.decoration-badge').first().textContent(), '2', 'problem count badge');
    await waitFor(page, () => document.querySelector('.explorer-row[data-path="src"] .decoration-dot.deco-error'));
    log('problem decorations ok (file color + count, folder dot)');
    // git decorations (from the git:changed event payload; A → U like VS Code's untracked)
    await page.evaluate(async () => {
      const { bus } = await import('/src/core/events.js');
      bus.emit('git:changed', { changes: [{ path: 'docs/guide.md', status: 'M' }, { path: 'lib/util/helpers.js', status: 'A' }] });
    });
    await waitFor(page, () => document.querySelector('.explorer-row[data-path="docs"] .decoration-dot.deco-modified'));
    await row(page, 'docs').tap();
    await waitFor(page, () => document.querySelector('.explorer-row[data-path="docs/guide.md"] .explorer-item.deco-modified .label-name'));
    assert.equal(await row(page, 'docs/guide.md').locator('.decoration-badge').textContent(), 'M');
    await row(page, 'lib/util').tap();
    await waitFor(page, () => document.querySelector('.explorer-row[data-path="lib/util/helpers.js"] .decoration-badge.deco-untracked')?.textContent === 'U');
    await row(page, 'lib/util').tap();
    await page.waitForTimeout(600);
    await row(page, 'docs').tap();
    await page.waitForTimeout(600);
    await row(page, 'src').tap(); // collapse
    await page.waitForTimeout(600);
    await row(page, 'src').tap(); // expand again → src selected
    await row(page, 'src/app.js').waitFor();
    log('git decorations ok (M / U letters, colors, folder dot)');
    await settle(page);
    await t.shot('explorer-phone-tree');

    // ---------- inline New File with validation ----------
    await page.tap('.pane[data-view-id="workbench.explorer.fileView"] .pane-header .codicon-new-file');
    const input = page.locator('.explorer-row.editing input');
    await input.waitFor();
    assert.ok(await input.evaluate(el => document.activeElement === el), 'inline input focused');
    assert.equal(await input.getAttribute('autocapitalize'), 'off');
    await input.fill('app.js');
    await page.waitForSelector('.explorer-row.editing .monaco-inputbox-message.error');
    const msg = await page.textContent('.explorer-row.editing .monaco-inputbox-message');
    assert.match(msg, /A file or folder app\.js already exists at this location/, 'duplicate name message');
    await t.shot('explorer-phone-new-file-validation');
    await input.fill(' spaced.js');
    await page.waitForSelector('.explorer-row.editing .monaco-inputbox-message.warning');
    await input.fill('bad:name.js');
    await page.waitForSelector('.explorer-row.editing .monaco-inputbox-message.error');
    await input.press('Enter');
    assert.ok(await input.isVisible(), 'invalid name keeps the input open');
    await input.fill('utils/format.js');
    await input.press('Enter');
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.fs.isFile('src/utils/format.js'));
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.activePath === 'src/utils/format.js');
    log('new file src/utils/format.js created (intermediate folder) and opened');

    // ---------- Escape cancels ----------
    await openExplorer(page);
    await page.tap('.pane[data-view-id="workbench.explorer.fileView"] .pane-header .codicon-new-folder');
    await page.locator('.explorer-row.editing input').fill('never');
    await page.locator('.explorer-row.editing input').press('Escape');
    await page.waitForSelector('.explorer-row.editing', { state: 'detached' });
    assert.equal(await exists(page, 'src/utils/never'), false, 'Escape cancels');

    // ---------- long-press menu → New Folder… ----------
    await longPress(page, '.explorer-row[data-path="docs"]');
    const labels = await page.$$eval('.context-view-layer .monaco-menu .action-item .action-label', els => els.map(e => e.textContent));
    for (const l of ['New File…', 'New Folder…', 'Find in Folder…', 'Cut', 'Copy', 'Paste', 'Copy Path', 'Copy Relative Path', 'Rename…', 'Delete', 'Download…']) assert.ok(labels.includes(l), `folder menu has ${l}`);
    await settle(page, 150);
    await t.shot('explorer-phone-context-menu');
    await menuRow(page, 'New Folder…').tap();
    await page.locator('.explorer-row.editing input').fill('images');
    await page.locator('.explorer-row.editing input').press('Enter');
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.fs.isFolder('docs/images'));
    log('long-press → New Folder… created docs/images');

    // file context menu entries
    await longPress(page, '.explorer-row[data-path="src/app.js"]');
    const fileLabels = await page.$$eval('.context-view-layer .monaco-menu .action-item .action-label', els => els.map(e => e.textContent));
    for (const l of ['Open', 'Run', 'Duplicate', 'Add File to Chat', 'Rename…', 'Delete']) assert.ok(fileLabels.includes(l), `file menu has ${l} (got ${fileLabels.join(', ')})`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.context-view-layer', { state: 'detached' });

    // ---------- Rename via long-press ----------
    await longPress(page, '.explorer-row[data-path="package.json"]');
    await menuRow(page, 'Rename…').tap();
    const rin = page.locator('.explorer-row.editing input');
    await rin.waitFor();
    const sel = await rin.evaluate(el => [el.value, el.selectionStart, el.selectionEnd]);
    assert.deepEqual(sel, ['package.json', 0, 7], 'rename selects the name without extension');
    await rin.fill('pkg.json');
    await rin.press('Enter');
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.fs.isFile('pkg.json'));
    assert.equal(await exists(page, 'package.json'), false);
    await waitFor(page, () => document.querySelector('.explorer-row.selected[data-path="pkg.json"]'));
    log('rename package.json → pkg.json');

    // ---------- Delete (confirm) + Undo ----------
    await longPress(page, '.explorer-row[data-path="pkg.json"]');
    await menuRow(page, 'Delete').tap();
    await page.waitForSelector('.monaco-dialog-box');
    assert.equal(await page.textContent('.monaco-dialog-box .dialog-message'), 'Are you sure you want to delete "pkg.json"?');
    await t.shot('explorer-phone-delete-confirm');
    await page.locator('.monaco-dialog-box .monaco-button', { hasText: 'Delete' }).tap();
    await waitFor(page, async () => !(await import('/src/core/workspace.js')).workspace.fs.exists('pkg.json'));
    const undo = page.locator('.notification-toast .monaco-button', { hasText: 'Undo' });
    await undo.waitFor();
    await t.shot('explorer-phone-delete-undo');
    await undo.tap();
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.fs.readText('pkg.json').then(t => t.includes('demo')).catch(() => false));
    log('delete + Undo restored pkg.json with its content');

    // folder delete + undo restores the whole subtree
    await page.evaluate(async () => { (await import('/src/views/explorer/fileOps.js')); });
    await page.evaluate(async () => { const { settings } = await import('/src/core/settings.js'); settings.set('explorer.confirmDelete', false); });
    await page.evaluate(async () => { const { commands } = await import('/src/core/commands.js'); await commands.execute('deleteFile', { path: 'src/components' }); });
    assert.equal(await exists(page, 'src/components/Card.jsx'), false);
    await page.locator('.notification-toast .monaco-button', { hasText: 'Undo' }).last().tap();
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.fs.isFile('src/components/Card.jsx'));
    await page.evaluate(async () => { const { settings } = await import('/src/core/settings.js'); settings.set('explorer.confirmDelete', true); });
    log('folder delete + Undo ok');

    // ---------- tap file → preview (italic) tab ----------
    await settle(page);
    await openExplorer(page);
    await row(page, 'src/app.js').tap();
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.activePath === 'src/app.js');
    const tab = page.locator('.tab.active');
    assert.ok((await tab.getAttribute('class')).includes('preview'), 'single tap opens a preview tab');
    assert.equal(await tab.evaluate(el => getComputedStyle(el.querySelector('.label-name')).fontStyle), 'italic', 'preview tab is italic');
    assert.equal(await page.evaluate(async () => (await import('/src/workbench/layout.js')).layout.sidebarVisible), false, 'phone overlay dismissed after opening');
    log('tap opens italic preview tab and dismisses the overlay');

    // ---------- Open Editors view ----------
    await openExplorer(page);
    await page.tap('.pane[data-view-id="workbench.explorer.openEditorsView"] .pane-header');
    await page.waitForSelector('.open-editors-list .open-editor');
    const oe = await page.$$eval('.open-editors-list .open-editor .label-name', els => els.map(e => e.textContent));
    assert.ok(oe.includes('app.js') && oe.includes('format.js'), `open editors lists tabs (got ${oe.join(', ')})`);
    assert.ok(await page.locator('.open-editor.selected.preview', { hasText: 'app.js' }).count(), 'active preview editor highlighted + italic');
    await settle(page);
    await t.shot('explorer-phone-open-editors');
    await page.tap('.pane[data-view-id="workbench.explorer.openEditorsView"] .pane-header');

    // ---------- import a ZIP generated in the page ----------
    const imported = await page.evaluate(async () => {
      const JSZip = (await import('/vendor/jszip.js')).default;
      const zip = new JSZip();
      zip.file('myrepo-main/lib2/a.js', 'export const a = 1;\n');
      zip.file('myrepo-main/lib2/data.bin', new Uint8Array([0, 1, 2, 3, 0, 255]));
      zip.file('myrepo-main/README2.md', '# Zipped\n');
      zip.file('__MACOSX/myrepo-main/._README2.md', 'junk');
      zip.file('myrepo-main/.DS_Store', 'junk');
      const blob = await zip.generateAsync({ type: 'blob' });
      const file = new File([blob], 'myrepo-main.zip', { type: 'application/zip' });
      const { files } = await import('/src/views/files-api.js');
      const res = await files.importZip(file, { target: '' });
      const { workspace } = await import('/src/core/workspace.js');
      return { count: res.count, a: await workspace.fs.readText('lib2/a.js'), bin: workspace.fs.isBinary('lib2/data.bin'), mac: workspace.fs.exists('__MACOSX'), ds: workspace.fs.exists('.DS_Store'), root: workspace.fs.exists('myrepo-main') };
    });
    assert.equal(imported.count, 3, 'three files imported');
    assert.equal(imported.a, 'export const a = 1;\n');
    assert.equal(imported.bin, true, 'binary file stored as blob');
    assert.equal(imported.mac || imported.ds || imported.root, false, 'junk skipped and common root stripped');
    log('ZIP import: root stripped, __MACOSX/.DS_Store skipped, binary detected');

    // ---------- export ZIP (iOS share sheet path) ----------
    const exported = await page.evaluate(async () => {
      let shared = null;
      navigator.canShare = () => true;
      navigator.share = async data => { shared = data.files[0]; };
      const { files } = await import('/src/views/files-api.js');
      const res = await files.exportZip();
      const JSZip = (await import('/vendor/jszip.js')).default;
      const zip = await JSZip.loadAsync(shared);
      return { result: res.result, name: shared.name, entries: Object.keys(zip.files), app: await zip.file('src/app.js').async('string') };
    });
    assert.equal(exported.result, 'shared', 'iOS export uses the share sheet');
    assert.equal(exported.name, 'My Project.zip');
    assert.ok(exported.entries.includes('lib2/data.bin') && exported.entries.includes('docs/images/'), 'zip has files and empty folders');
    assert.match(exported.app, /answer = 42/);
    log('ZIP export via share sheet ok');

    // ---------- Quick Open with :line ----------
    await settle(page);
    await t.command('workbench.action.quickOpen');
    await page.waitForSelector('#quick-input-widget:not(.hidden) input');
    await page.fill('#quick-input-widget input', 'helpers');
    await page.waitForSelector('#quick-input-widget .quick-input-list-entry .label-name .highlight');
    const first = await page.textContent('#quick-input-widget .quick-input-list-entry.focused .label-name');
    assert.equal(first, 'helpers.js', 'fuzzy match finds helpers.js');
    await page.fill('#quick-input-widget input', 'app.js:2');
    await page.waitForFunction(() => document.querySelector('#quick-input-widget .quick-input-list-entry.focused .label-name')?.textContent === 'app.js');
    await t.shot('explorer-phone-quick-open');
    await page.keyboard.press('Enter');
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.activePath === 'src/app.js');
    const line = await waitFor(page, async () => {
      const ed = (await import('/src/editor/api.js')).codeEditor.getActive();
      return ed?.path === 'src/app.js' ? ed.getSelection().startLine : false;
    }, null, 4000);
    assert.equal(line, 2, 'cursor on line 2');
    assert.ok(await page.locator('.tab.active:not(.preview)').count(), 'quick open opens pinned');
    log('quick open app.js:2 ok');

    // ---------- reveal active file ----------
    await t.command('workbench.files.action.showActiveFileInExplorer');
    await page.waitForSelector('.explorer-row.selected[data-path="src/app.js"]');
    log('Reveal Active File in Explorer View ok');

    // ---------- 2000-file project stays virtualized ----------
    const perf = await page.evaluate(async () => {
      const { workspace } = await import('/src/core/workspace.js');
      const items = [];
      for (let d = 0; d < 40; d++) for (let f = 0; f < 50; f++) items.push({ path: `big/dir${d}/file${f}.js`, content: `export const v${f} = ${d};\n` });
      await workspace.fs.writeMany(items);
      const { files } = await import('/src/views/files-api.js');
      await new Promise(r => setTimeout(r, 100));
      const t0 = performance.now();
      files.reveal('big/dir39/file49.js');
      const revealMs = performance.now() - t0;
      for (let d = 0; d < 40; d++) files.reveal(`big/dir${d}/file0.js`);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { revealMs, rows: document.querySelectorAll('.explorer-tree .explorer-row').length, selected: document.querySelector('.explorer-row.selected')?.dataset.path };
    });
    assert.ok(perf.rows < 150, `only visible rows are in the DOM (got ${perf.rows})`);
    assert.ok(perf.revealMs < 250, `reveal in a 2000-file project is fast (${perf.revealMs.toFixed(1)} ms)`);
    assert.equal(perf.selected, 'big/dir39/file0.js');
    await page.evaluate(async () => { const { workspace } = await import('/src/core/workspace.js'); await workspace.fs.remove('big'); });
    log(`2000 files: ${perf.rows} DOM rows, reveal ${perf.revealMs.toFixed(1)} ms`);

    // ---------- empty project state + import as new project ----------
    const created = await page.evaluate(async () => {
      const JSZip = (await import('/vendor/jszip.js')).default;
      const zip = new JSZip(); zip.file('site/index.html', '<h1>Hi</h1>');
      const file = new File([await zip.generateAsync({ type: 'blob' })], 'Zipped Site.zip');
      const { files } = await import('/src/views/files-api.js');
      const project = await files.importZip(file, { newProject: true });
      const { workspace } = await import('/src/core/workspace.js');
      return { name: project.name, active: workspace.name, html: workspace.fs.exists('index.html') };
    });
    assert.deepEqual(created, { name: 'Zipped Site', active: 'Zipped Site', html: true }, 'ZIP imported as a new project');
    await page.evaluate(async () => {
      const { workspace } = await import('/src/core/workspace.js');
      await workspace.createProject('Empty One', { files: {} });
    });
    await openExplorer(page);
    await page.waitForSelector('.explorer-empty:not(.hidden)');
    const emptyText = await page.textContent('.explorer-empty');
    assert.match(emptyText, /The folder is empty\./);
    assert.ok(await page.locator('.explorer-empty .monaco-button', { hasText: 'New File' }).count());
    assert.ok(await page.locator('.explorer-empty .monaco-button', { hasText: 'Import Files' }).count());
    await settle(page);
    await t.shot('explorer-phone-empty');
    log('empty folder state ok');

    t.assertNoErrors();
  } finally { await t.close(); }
}

async function desktopTests() {
  const t = await launch({ device: 'Desktop Chrome', viewport: { width: 1280, height: 800 } });
  const { page } = t;
  try {
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.project !== null);
    await seed(page);
    await t.command('workbench.view.explorer');
    await page.waitForSelector('.explorer-tree .explorer-row[data-path="src"]');
    const h = await row(page, 'src').evaluate(el => el.getBoundingClientRect().height);
    assert.equal(h, 22, 'desktop rows are 22px');

    // click folder, click file → preview; double-click → pinned
    await row(page, 'src').click();
    await row(page, 'src/app.js').waitFor();
    await row(page, 'src/app.js').click();
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.activePath === 'src/app.js');
    assert.ok((await page.getAttribute('.tab.active', 'class')).includes('preview'));
    await row(page, 'src/app.js').dblclick();
    await waitFor(page, () => !document.querySelector('.tab.active')?.classList.contains('preview'));
    log('desktop click → preview, double-click → pinned');

    // keyboard: focus tree, arrows, F2 rename + Escape, Enter opens
    await row(page, 'src/components').click();
    await page.keyboard.press('ArrowDown');
    await page.waitForSelector('.explorer-row.selected.focused[data-path="src/components/Button.jsx"]');
    await page.keyboard.press('F2');
    await page.waitForSelector('.explorer-row.editing input');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.explorer-row.editing', { state: 'detached' });
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('explorer-tree')), 'focus returns to the tree');
    await page.keyboard.press('ArrowLeft'); // to parent folder
    await page.waitForSelector('.explorer-row.selected[data-path="src/components"]');
    await page.keyboard.press('ArrowLeft'); // collapse
    await waitFor(page, () => document.querySelector('.explorer-row[data-path="src/components"]')?.getAttribute('aria-expanded') === 'false');
    log('keyboard navigation ok');

    // copy + paste → "Button copy.jsx"
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+c`);
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+v`);
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.fs.isFile('src/components/Button copy.jsx'));
    log('copy/paste → Button copy.jsx');

    // type-to-select
    await page.keyboard.press('c');
    await page.waitForSelector('.explorer-row.selected[data-path="src/components/Card.jsx"]');

    // drag & drop move with confirm
    await row(page, 'docs').click();
    await row(page, 'docs/guide.md').waitFor();
    await row(page, 'docs/guide.md').dragTo(row(page, 'src'));
    await page.waitForSelector('.monaco-dialog-box');
    assert.match(await page.textContent('.monaco-dialog-box .dialog-message'), /move 'guide\.md' into 'src'/);
    await page.locator('.monaco-dialog-box .monaco-button', { hasText: 'Move' }).click();
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.fs.isFile('src/guide.md'));
    log('drag & drop move with confirmation ok');

    // like VS Code, a valid name is committed when the inline input loses focus
    await page.click('.pane[data-view-id="workbench.explorer.fileView"] .pane-header');
    await page.hover('.pane[data-view-id="workbench.explorer.fileView"]');
    await page.click('.pane[data-view-id="workbench.explorer.fileView"] .pane-header .codicon-new-file');
    await page.keyboard.type('blurred.js');
    await page.click('#editor-part', { position: { x: 400, y: 300 } });
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.fs.isFile('src/blurred.js') || (await import('/src/core/workspace.js')).workspace.fs.isFile('blurred.js'));
    log('inline input commits on blur');

    // File: New File… (quick input) and New Text File
    await t.command('workbench.action.files.newFile');
    await page.waitForSelector('#quick-input-widget:not(.hidden) input');
    assert.equal(await page.getAttribute('#quick-input-widget input', 'placeholder'), 'Enter file name');
    await page.fill('#quick-input-widget input', 'notes/today.md');
    await page.keyboard.press('Enter');
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.activePath === 'notes/today.md');
    assert.equal(await t.commandResult('workbench.action.files.newUntitledFile'), 'Untitled-1.txt');
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.activePath === 'Untitled-1.txt');
    log('New File… (quick input) and New Text File ok');

    // Download… (desktop → browser download)
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(async () => { const { commands } = await import('/src/core/commands.js'); await commands.execute('explorer.download', { path: 'src/app.js' }); })
    ]);
    assert.equal(download.suggestedFilename(), 'app.js');
    log('Download… ok');

    // dropping OS files onto a folder imports them there
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['dropped text\n'], 'dropped.txt', { type: 'text/plain' }));
      const target = document.querySelector('.explorer-row[data-path="src"]');
      const r = target.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 30, clientY: r.top + 5 };
      target.dispatchEvent(new DragEvent('dragover', opts));
      target.dispatchEvent(new DragEvent('drop', opts));
    });
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.fs.peekText('src/dropped.txt') === 'dropped text\n');
    log('OS file drop → src/dropped.txt');

    // right-click menu
    await row(page, 'src/app.js').click({ button: 'right' });
    await page.waitForSelector('.context-view-layer .monaco-menu');
    await settle(page, 150);
    await t.shot('explorer-desktop-context-menu');
    await page.keyboard.press('Escape');
    await settle(page);
    await t.shot('explorer-desktop');
    t.assertNoErrors();
  } finally { await t.close(); }
}

for (const [name, fn] of [['iPhone', phoneTests], ['Desktop', desktopTests]]) {
  try { console.log(name); await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed = true; console.error(`  ✗ ${name}:`, err); }
}
process.exit(failed ? 1 : 0);
