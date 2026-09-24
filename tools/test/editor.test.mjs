// Editor feature end-to-end test (iPhone 13 + Desktop Chrome).
// Run: node tools/test/editor.test.mjs   → screenshots in tools/test/out/editor-*.png
import assert from 'node:assert/strict';
import { launch } from './harness.mjs';

const steps = [];
function step(name) { steps.push(name); console.log(`• ${name}`); }

/** Runs `fn` in the page with the app's modules loaded: fn(mods, arg). */
async function app(page, fn, arg) {
  return page.evaluate(async ([src, arg]) => {
    const mods = {
      editors: (await import('/src/workbench/editors.js')).editors,
      workspace: (await import('/src/core/workspace.js')).workspace,
      settings: (await import('/src/core/settings.js')).settings,
      diagnostics: (await import('/src/core/diagnostics.js')).diagnostics,
      commands: (await import('/src/core/commands.js')).commands,
      codeEditor: (await import('/src/editor/api.js')).codeEditor
    };
    // eslint-disable-next-line no-new-func
    const f = new Function('mods', 'arg', `return (${src})(mods, arg);`);
    return f(mods, arg);
  }, [fn.toString(), arg]);
}
const text = page => app(page, ({ codeEditor }) => codeEditor.getActive()?.getText() ?? null);
const statusText = page => page.$$eval('#statusbar .statusbar-item', els => els.filter(e => e.offsetParent).map(e => e.textContent.trim()).join(' | '));
async function waitFor(page, fn, arg, { timeout = 5000, message = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await app(page, fn, arg).catch(() => false);
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${message}`);
    await page.waitForTimeout(100);
  }
}
async function open(page, path) {
  await app(page, async ({ editors }, p) => { await editors.open({ type: 'file', path: p }, { pinned: true }); }, path);
  await page.waitForTimeout(400);
}

async function phone() {
  const t = await launch({ device: 'iPhone 13', settings: { 'files.autoSave': 'afterDelay', 'files.autoSaveDelay': 600 } });
  const { page } = t;
  try {
    step('open main.js: CodeMirror editor, breadcrumbs, VS Code status bar items');
    await open(page, 'main.js');
    await page.waitForSelector('.xc-code-editor .cm-editor .cm-content');
    assert.ok(await page.$('.breadcrumbs-below-tabs .monaco-breadcrumb-item.file-item'), 'breadcrumbs file item');
    let status = await statusText(page);
    assert.match(status, /Ln 1, Col 1/);
    assert.match(status, /Spaces: 2/);
    assert.match(status, /JavaScript/);
    assert.ok(await page.$('.cm-editor .tok-function'), 'syntax highlighting applied');
    assert.ok(await page.$('.cm-editor .cm-bracket-1'), 'bracket pair colorization');

    step('tap into the editor → accessory bar above the keyboard');
    const lastLine = await page.$$('.cm-content .cm-line');
    await lastLine[lastLine.length - 1].tap();
    await page.waitForSelector('#editor-accessory-bar:not(.hidden)', { timeout: 3000 });
    await page.keyboard.press('Meta+ArrowDown');

    step('typing marks the tab dirty, auto save (afterDelay) saves it');
    await page.keyboard.type('\nconst answer = 42;');
    await page.waitForSelector('.tab.active.dirty', { timeout: 2000 });
    await waitFor(page, ({ workspace }) => workspace.fs.peekText('main.js').includes('const answer = 42;'), null, { message: 'auto save' });
    await page.waitForSelector('.tab.active:not(.dirty)', { timeout: 3000 });
    await t.shot('editor-typing');

    step('accessory bar keys type through CodeMirror (auto-closing brackets)');
    await page.tap('#editor-accessory-bar [data-key="sym-("]');
    let doc = await text(page);
    assert.ok(doc.includes('42;()'), 'accessory "(" inserted "()"');
    await page.tap('#editor-accessory-bar [data-key="undo"]');
    doc = await text(page);
    assert.ok(!doc.includes('42;()'), 'accessory undo');

    step('files.autoSave off + ⌘S saves');
    await app(page, ({ settings }) => settings.set('files.autoSave', 'off'));
    await page.keyboard.type('\n// saved with cmd-s');
    await page.waitForTimeout(900);
    assert.ok(await page.$('.tab.active.dirty'), 'still dirty with auto save off');
    await page.keyboard.press('Meta+s');
    await waitFor(page, ({ workspace }) => workspace.fs.peekText('main.js').includes('saved with cmd-s'), null, { message: 'Mod+S save' });
    await page.waitForSelector('.tab.active:not(.dirty)', { timeout: 2000 });

    step('find widget: count, next, replace all');
    await page.keyboard.press('Meta+f');
    await page.waitForSelector('.find-widget');
    const find = await page.$('.find-widget .find-part input');
    await find.fill('console');
    await page.waitForTimeout(150);
    let count = await page.textContent('.find-widget .matchesCount');
    assert.match(count, /^\d+ of 2$/, `matches count "${count}"`);
    await find.press('Enter');
    await page.waitForTimeout(100);
    count = await page.textContent('.find-widget .matchesCount');
    assert.match(count, /of 2$/);
    await t.shot('editor-find');
    await page.click('.find-widget .button.toggle');
    await page.waitForSelector('.find-widget.replaceToggled');
    await page.fill('.find-widget .replace-part input', 'logger');
    await page.click('.find-widget .codicon-replace-all');
    await page.waitForTimeout(150);
    doc = await text(page);
    assert.ok(!doc.includes('console') && doc.includes('logger.log'), 'replace all');
    assert.equal((await page.textContent('.find-widget .matchesCount')).trim(), 'No results');
    await t.shot('editor-replace');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.find-widget', { state: 'detached' });
    await page.keyboard.press('Meta+z');
    doc = await text(page);
    assert.ok(doc.includes('console'), 'undo replace all');

    step('go to line (":") with VS Code wording');
    await t.command('workbench.action.gotoLine');
    await page.waitForSelector('#quick-input-widget:not(.hidden) .quick-input-list-entry');
    const label = await page.textContent('#quick-input-widget .quick-input-list-entry');
    assert.match(label, /^Current Line: \d+, Character: \d+\. Type a line number between 1 and \d+ to navigate to\.$/);
    await page.keyboard.type('3');
    await page.waitForTimeout(150);
    assert.equal((await page.textContent('#quick-input-widget .quick-input-list-entry')).trim(), 'Go to line 3.');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    assert.match(await statusText(page), /Ln 3, Col 1/);

    step('go to symbol ("@") + outline data');
    await app(page, ({ workspace }) => workspace.fs.writeText('src/app.js', [
      'export function greet(name) {', '  return `Hello ${name}`;', '}', '',
      'class Counter {', '  constructor() { this.n = 0; }', '  increment() {', '    this.n++;', '  }', '}', '',
      'const MAX = 10;', 'const helper = () => MAX;', ''
    ].join('\n')));
    await open(page, 'src/app.js');
    await t.command('workbench.action.gotoSymbol');
    await page.waitForSelector('#quick-input-widget:not(.hidden) .quick-input-list-entry');
    const symbols = await page.$$eval('#quick-input-widget .quick-input-list-entry .label-name', els => els.map(e => e.textContent));
    for (const s of ['greet', 'Counter', 'constructor', 'increment', 'MAX', 'helper']) assert.ok(symbols.includes(s), `symbol ${s} in ${symbols}`);
    await page.keyboard.type('incr');
    await page.waitForTimeout(150);
    await t.shot('editor-symbols');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    assert.match(await statusText(page), /Ln 7,/);
    const crumbs = await page.$$eval('.breadcrumbs-below-tabs .monaco-breadcrumb-item', els => els.map(e => e.textContent.trim()));
    assert.deepEqual(crumbs.slice(-3), ['app.js', 'Counter', 'increment'], `breadcrumbs ${crumbs}`);

    step('outline view (Explorer) shows the symbol tree and follows the cursor');
    await page.evaluate(async () => {
      const { views } = await import('/src/workbench/views.js');
      // The Explorer container is contributed by the Explorer feature; register a stand-in if it isn't loaded.
      if (!views.container('workbench.view.explorer')) views.registerContainer({ id: 'workbench.view.explorer', title: 'Explorer', icon: 'files', order: 1 });
      views.revealView('outline');
    });
    await page.waitForSelector('.outline-tree .outline-row');
    const outline = await page.$$eval('.outline-tree .outline-row', els => els.map(e => e.textContent.trim()));
    assert.deepEqual(outline, ['greet', 'Counter', 'constructor', 'increment', 'MAX', 'helper']);
    assert.equal(await page.textContent('.outline-tree .outline-row.selected'), 'increment');
    await t.shot('editor-outline');
    await page.tap('.outline-tree .outline-row >> text=greet');
    await page.waitForTimeout(300);
    assert.match(await statusText(page), /Ln 1,/);

    step('go back / go forward across locations');
    await t.command('workbench.action.navigateBack');
    await page.waitForTimeout(400);
    assert.equal(await app(page, ({ editors }) => editors.activePath), 'main.js');
    assert.match(await statusText(page), /Ln 3,/);
    await t.command('workbench.action.navigateForward');
    await page.waitForTimeout(400);
    assert.equal(await app(page, ({ editors }) => editors.activePath), 'src/app.js');
    assert.match(await statusText(page), /Ln 1,/);

    step('diagnostics: JS syntax error (acorn) + JSON (trailing comma) project-wide');
    await app(page, async ({ workspace }) => {
      await workspace.fs.writeText('broken.js', 'const ok = 1;\nconst x = ;\n', { source: 'ai' });
      await workspace.fs.writeText('data.json', '{\n  "a": 1,\n}\n', { source: 'ai' });
    });
    await waitFor(page, ({ diagnostics }) => diagnostics.forFile('broken.js').length && diagnostics.forFile('data.json').length, null, { message: 'background diagnostics' });
    const counts = await app(page, ({ diagnostics }) => diagnostics.counts());
    assert.ok(counts.errors >= 2, `errors ${JSON.stringify(counts)}`);
    const jsMarker = await app(page, ({ diagnostics }) => diagnostics.forFile('broken.js')[0]);
    assert.equal(jsMarker.line, 2);
    assert.equal(jsMarker.col, 11);
    const jsonMarker = await app(page, ({ diagnostics }) => diagnostics.forFile('data.json')[0]);
    assert.equal(jsonMarker.message, 'Trailing comma');
    await open(page, 'broken.js');
    await page.waitForSelector('.cm-lintRange-error');
    await t.command('editor.action.marker.next');
    await page.waitForSelector('.marker-widget');
    assert.match(await page.textContent('.marker-widget'), /Unexpected token/);
    await t.shot('editor-problem');
    await page.keyboard.press('Escape');

    step('external change reloads a clean editor in place');
    await app(page, ({ workspace }) => workspace.fs.writeText('broken.js', 'const fixed = 1;\n', { source: 'ai' }));
    await page.waitForTimeout(300);
    assert.equal(await text(page), 'const fixed = 1;\n');
    await waitFor(page, ({ diagnostics }) => diagnostics.forFile('broken.js').length === 0, null, { message: 'diagnostics cleared after fix' });

    step('external change while dirty → Compare / Keep Mine / Load From Disk');
    await app(page, ({ codeEditor }) => { const a = codeEditor.getActive(); a.view.dispatch({ selection: { anchor: a.view.state.doc.length } }); a.focus(); });
    await page.keyboard.type('// my unsaved edit');
    await page.waitForSelector('.tab.active.dirty');
    await app(page, ({ workspace }) => workspace.fs.writeText('broken.js', 'const fromDisk = 2;\n', { source: 'git' }));
    await page.waitForSelector('.notification-toast:has-text("was changed on disk") button:has-text("Compare")');
    assert.ok((await text(page)).includes('my unsaved edit'), 'dirty editor keeps its content');
    await page.click('.notification-toast:has-text("was changed on disk") button:has-text("Load From Disk")');
    await page.waitForTimeout(200);
    assert.equal(await text(page), 'const fromDisk = 2;\n');
    await page.waitForSelector('.tab.active:not(.dirty)');

    step('format document (offline → built-in formatter)');
    await app(page, ({ workspace }) => workspace.fs.writeText('fmt.json', '{"a":1,"b":[1,2]}'));
    await open(page, 'fmt.json');
    await app(page, ({ commands }) => commands.execute('editor.action.formatDocument'));
    await page.waitForTimeout(200);
    assert.equal(await text(page), '{\n    "a": 1,\n    "b": [\n        1,\n        2\n    ]\n}');

    step('change language mode');
    await t.command('workbench.action.editor.changeLanguageMode');
    await page.waitForSelector('#quick-input-widget:not(.hidden) .quick-input-list-entry');
    await page.keyboard.type('Python');
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    assert.match(await statusText(page), /Python/);

    step('diff editor (inline on phones)');
    await app(page, ({ codeEditor }) => codeEditor.openDiff({ id: 'test-diff', title: 'main.js (Working Tree)', path: 'main.js', original: 'one\ntwo\nthree\n', modified: 'one\nTWO\nthree\nfour\n', readOnly: true, actions: [{ label: 'Stage', icon: 'add', run: () => { window.__staged = true; } }] }));
    await page.waitForSelector('.xc-diff-root .cm-deletedChunk');
    assert.ok(await page.$('.xc-diff-root .cm-changedLine'), 'inserted lines highlighted');
    await page.click('.xc-diff-root .diff-action');
    assert.equal(await page.evaluate(() => window.__staged), true);
    await t.shot('editor-diff');

    step('markdown preview with live updates');
    await open(page, 'README.md');
    await t.command('markdown.showPreviewToSide');
    await page.waitForSelector('.markdown-body h1');
    await open(page, 'README.md');
    await app(page, ({ codeEditor }) => { const a = codeEditor.getActive(); a.view.dispatch({ selection: { anchor: a.view.state.doc.length } }); a.focus(); });
    await page.keyboard.type('\n\n## Live Heading\n\n```js\nconst x = 1;\n```\n');
    await app(page, async ({ editors }) => { await editors.open({ type: 'markdown-preview', path: 'README.md' }); });
    await page.waitForFunction(() => [...document.querySelectorAll('.markdown-body h2')].some(h => h.textContent === 'Live Heading'), null, { timeout: 3000 });
    assert.ok(await page.$('.markdown-body pre code .tok-keyword'), 'code block highlighted');
    await t.shot('editor-markdown-preview');

    step('image viewer (PNG) with status bar info + zoom');
    await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 48;
      const g = c.getContext('2d'); g.fillStyle = '#007acc'; g.fillRect(0, 0, 64, 48); g.fillStyle = '#fff'; g.fillRect(8, 8, 20, 20);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const { workspace } = await import('/src/core/workspace.js');
      await workspace.fs.writeBinary('images/logo.png', blob);
    });
    await open(page, 'images/logo.png');
    await page.waitForSelector('.image-preview .image-preview-img');
    await page.waitForFunction(() => document.querySelector('.image-preview-img')?.naturalWidth === 64);
    await page.waitForTimeout(200);
    status = await statusText(page);
    assert.match(status, /64x48/);
    assert.match(status, /Whole Image/);
    await page.tap('.image-preview');
    await page.waitForTimeout(200);
    assert.match(await statusText(page), /\d+%/);
    await t.shot('editor-image');

    step('binary file placeholder');
    await page.evaluate(async () => {
      const { workspace } = await import('/src/core/workspace.js');
      await workspace.fs.writeBinary('data.bin', new Blob([new Uint8Array([0, 1, 2, 0, 255, 0])], { type: 'application/octet-stream' }));
    });
    await open(page, 'data.bin');
    await page.waitForSelector('.binary-editor');
    assert.match(await page.textContent('.binary-editor'), /The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding\./);

    step('light theme');
    await open(page, 'src/app.js');
    await app(page, ({ settings }) => settings.set('workbench.colorTheme', 'light-plus'));
    await page.waitForTimeout(400);
    const bg = await page.$eval('.xc-code-editor .cm-editor', el => getComputedStyle(el).backgroundColor);
    assert.equal(bg, 'rgb(255, 255, 255)');
    await t.shot('editor-light');

    t.assertNoErrors();
  } finally { await t.close(); }
}

async function desktop() {
  const t = await launch({ device: 'Desktop Chrome', viewport: { width: 1280, height: 800 } });
  const { page } = t;
  try {
    step('desktop: minimap, context menu, side-by-side diff');
    await open(page, 'main.js');
    await page.waitForSelector('.cm-editor .cm-minimap-gutter', { timeout: 5000 });
    await page.click('.cm-content .cm-line >> nth=2', { button: 'right' });
    await page.waitForSelector('.monaco-menu');
    const items = await page.$$eval('.monaco-menu .action-item', els => els.map(e => e.textContent));
    assert.ok(items.some(i => i.includes('Format Document')), `context menu ${items}`);
    assert.ok(items.some(i => i.includes('Command Palette')), 'command palette entry');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    await t.shot('editor-desktop');
    await app(page, ({ codeEditor }) => codeEditor.openDiff({ id: 'desk-diff', title: 'main.js ↔ main.js (modified)', path: 'main.js', original: 'a\nb\nc\n', modified: 'a\nB\nc\nd\n', readOnly: false }));
    await page.waitForSelector('.xc-diff-root .cm-mergeView');
    await t.shot('editor-desktop-diff');
    t.assertNoErrors();
  } finally { await t.close(); }
}

try {
  await phone();
  await desktop();
  console.log(`\neditor.test: ${steps.length} steps passed`);
} catch (err) {
  console.error(`\neditor.test FAILED at step "${steps[steps.length - 1]}":\n`, err);
  process.exitCode = 1;
}
