// Panel end-to-end: TERMINAL (xsh: ls, mkdir/echo/cat, pipes, cd/pwd, Tab completion, history, ANSI colours,
// node runner, Ctrl+C, key row, terminal API, multiple terminals), PROBLEMS (markers from diagnostics, status bar,
// badge, filter, tap opens the file), OUTPUT (log format, channel switching), DEBUG CONSOLE (preview:console events,
// grouping, REPL) on an iPhone 13 in Dark+ and Light+, then the terminal / problems on desktop.
//
//   node tools/test/panel.test.mjs

import assert from 'node:assert/strict';
import { launch } from './harness.mjs';

const log = (...a) => console.log('  ·', ...a);

async function waitFor(page, fn, arg, timeout = 6000) {
  const start = Date.now();
  for (;;) {
    const v = await page.evaluate(fn, arg).catch(() => false);
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${fn.toString().slice(0, 160)}`);
    await page.waitForTimeout(50);
  }
}

const idle = page => waitFor(page, async () => {
  const { terminals } = await import('/src/panel/terminal.js');
  const t = terminals.active;
  return !!t && !t.running && !t.queue.length;
}, null, 10000);

const screenText = page => page.evaluate(async () => (await import('/src/panel/api.js')).terminal.recentOutput(400));
const inputValue = page => page.$eval('.terminal-instance:not(.hidden) .xterm-helper-textarea', el => el.value);

/** Types a command in the focused terminal, presses Enter and returns the new output. */
async function run(page, line) {
  const before = (await screenText(page)).split('\n').length;
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(60);
  await idle(page);
  await page.waitForTimeout(40);
  const lines = (await screenText(page)).split('\n');
  return lines.slice(Math.max(0, before - 1)).join('\n');
}

async function phone() {
  const t = await launch({ device: 'iPhone 13' });
  const { page } = t;
  try {
    // ---------------------------------------------------------------- TERMINAL
    await t.command('workbench.action.terminal.toggleTerminal');
    await page.waitForSelector('#panel .terminal-instance .xterm-viewport', { state: 'visible' });
    assert.ok(await page.$eval('#panel .panel-switcher .action-item.checked', el => el.textContent.includes('TERMINAL')), 'terminal tab active');
    await page.evaluate(() => document.activeElement?.blur());
    await page.tap('#panel .xterm-viewport');
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')), 'tap focuses the terminal input');
    const attrs = await page.$eval('.xterm-helper-textarea', el => ({ cap: el.getAttribute('autocapitalize'), corr: el.getAttribute('autocorrect'), hint: el.getAttribute('enterkeyhint'), spell: el.getAttribute('spellcheck') }));
    assert.deepEqual(attrs, { cap: 'off', corr: 'off', hint: 'send', spell: 'false' });
    assert.ok(await page.isVisible('.terminal-instance.focused .terminal-keys'), 'touch key row visible while focused');
    assert.match(await page.textContent('.terminal-instance .xterm-live'), /user@xcoder:~\/my-project\$/);
    log('terminal opens, tap focuses input, prompt + key row');

    let out = await run(page, 'ls');
    assert.match(out, /index\.html/); assert.match(out, /main\.js/);
    out = await run(page, 'mkdir -p a/b && echo hi > a/b/x.txt && cat a/b/x.txt');
    assert.match(out, /^hi$/m);
    assert.equal(await page.evaluate(async () => (await import('/src/core/workspace.js')).workspace.fs.readText('a/b/x.txt')), 'hi\n');
    out = await run(page, 'ls | grep x');
    assert.match(out, /index\.html/); assert.doesNotMatch(out, /main\.js/);
    out = await run(page, 'cd a && pwd');
    assert.match(out, /^\/a$/m);
    assert.match(await page.textContent('.terminal-instance .xterm-live'), /~\/my-project\/a\$/);
    log('ls, mkdir/echo/cat with && and >, pipes, cd/pwd');

    // Tab completion: file paths, then commands
    await page.keyboard.type('cat b/x');
    await page.keyboard.press('Tab');
    assert.equal(await inputValue(page), 'cat b/x.txt ');
    await page.keyboard.press('Enter');
    await idle(page);
    assert.match(await screenText(page), /cat b\/x\.txt \nhi/);
    await page.keyboard.type('hist');
    await page.keyboard.press('Tab');
    assert.equal(await inputValue(page), 'history ');
    await page.keyboard.press('Escape');
    assert.equal(await inputValue(page), '');
    // History: ↑ recalls the previous command, ↓ returns to the draft
    await page.keyboard.press('ArrowUp');
    assert.equal(await inputValue(page), 'cat b/x.txt');
    await page.keyboard.press('ArrowUp');
    assert.equal(await inputValue(page), 'cd a && pwd');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await inputValue(page), '');
    out = await run(page, 'cd ~ && history 3');
    assert.match(out, /cat b\/x\.txt/);
    // Ctrl+R reverse-i-search, then !! history expansion
    await page.keyboard.press('Control+r');
    await page.keyboard.type('b/x');
    assert.match(await page.textContent('.terminal-instance .xterm-live'), /\(reverse-i-search\)`b\/x': cat b\/x\.txt/);
    await page.keyboard.press('Escape');
    assert.equal(await inputValue(page), 'cat b/x.txt');
    await page.keyboard.press('Control+u');
    out = await run(page, 'echo one && !!');
    assert.match(out, /echo one && cd ~ && history 3/);
    const saved = await waitFor(page, async () => {
      const { workspace } = await import('/src/core/workspace.js');
      const h = await workspace.sessionGet('terminal.history', []);
      return h.includes('cat b/x.txt') && h;
    });
    assert.ok(saved.length >= 5, 'history persisted per project');
    log('Tab completion (paths + commands), history ↑/↓, Ctrl+R, !!, persisted history');

    // ANSI colours, errors, exit codes
    await run(page, 'printf "\\e[31mred\\e[0m \\e[1;32mbold green\\e[0m \\e[38;5;208morange\\e[0m\\n"');
    assert.ok(await page.$('.xterm-rows .xterm-fg-1'), 'red run rendered');
    assert.ok(await page.$('.xterm-rows .xterm-bold'), 'bold run rendered');
    assert.ok(await page.$('.xterm-rows span[style*="rgb(255, 135, 0)"]'), '256-colour run rendered');
    out = await run(page, 'foo');
    assert.match(out, /xsh: command not found: foo/);
    out = await run(page, 'ls nope; echo "status $?"');
    assert.match(out, /ls: nope: No such file or directory/); assert.match(out, /status 1/);
    out = await run(page, 'rm -rf ~');
    assert.match(out, /refusing to remove the project root/);
    out = await run(page, 'seq 5 | sort -rn | head -n 2 | wc -l');
    assert.match(out, /^\s*2$/m);
    out = await run(page, 'X=world; echo "hello $X" | sed \'s/world/xsh/\'');
    assert.match(out, /^hello xsh$/m);
    // iOS Smart Punctuation (curly quotes, em dash) typed into the terminal is mapped back to ASCII
    await page.keyboard.insertText('echo \u201csmart\u201d \u2014version');
    assert.equal(await inputValue(page), 'echo "smart" --version');
    await page.keyboard.press('Control+u');
    out = await run(page, 'n=6; echo "answer $((n * 7))"');
    assert.match(out, /^answer 42$/m);
    log('ANSI 16/256 colours, errors, $?, refuses rm of the root, pipelines, sed, $VAR, $((…))');

    // Links: project paths with :line in output open the editor on tap
    out = await run(page, 'grep -Hn Preview main.js');
    const link = await page.waitForSelector('.xterm-rows .xterm-link[data-path="main.js"]');
    assert.equal(await link.getAttribute('data-line'), '1');
    await link.tap();
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.activePath === 'main.js');
    await page.tap('#panel .xterm-viewport');
    log('terminal file links open the editor');

    // node runner (depends on preview.runScript: real output or the graceful error)
    await run(page, 'echo \'console.log(6 * 7)\' > calc.js');
    out = await run(page, 'node calc.js; echo "exit=$?"');
    assert.ok(/^42$/m.test(out) || /node: .+/.test(out), `node output or graceful error:\n${out}`);
    assert.match(out, /exit=\d+/);
    out = await run(page, 'node main.js');
    assert.ok(!/xsh: command not found/.test(out), 'node is a command');
    log(`node runner: ${/^42$/m.test(out) ? 'script output' : 'graceful error'} → ${out.split('\n').filter(Boolean).slice(-1)[0]}`);

    // Ctrl+C cancels a running command
    await page.keyboard.type('sleep 5');
    await page.keyboard.press('Enter');
    await waitFor(page, async () => !!(await import('/src/panel/terminal.js')).terminals.active.running);
    const started = Date.now();
    await page.keyboard.press('Control+c');
    await idle(page);
    assert.ok(Date.now() - started < 2000, 'Ctrl+C interrupts immediately');
    out = await run(page, 'echo "code=$?"');
    assert.match(out, /code=130/);
    assert.match(await screenText(page), /\^C/);
    log('Ctrl+C aborts sleep (exit 130)');

    // Touch key row: ↑ recalls history, Tab completes
    await page.tap('.terminal-keys [data-key="arrow-up"]');
    assert.equal(await inputValue(page), 'echo "code=$?"');
    await page.tap('.terminal-keys [data-key="Esc"]');
    assert.equal(await inputValue(page), '');
    await page.keyboard.type('ls a/');
    await page.tap('.terminal-keys [data-key="Tab"]');
    assert.equal(await inputValue(page), 'ls a/b/');
    await page.tap('.terminal-keys [data-key="|"]');
    assert.equal(await inputValue(page), 'ls a/b/|');
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')), 'key row keeps focus in the terminal');
    await page.keyboard.press('Control+u');
    assert.equal(await inputValue(page), '');
    log('key row (↑, Esc, Tab, |) keeps the keyboard focus; Ctrl+U');

    await t.shot('panel-terminal-phone-dark');

    // Terminal API: run(), registerCommand(), recentOutput()
    const apiResult = await page.evaluate(async () => {
      const { terminal } = await import('/src/panel/api.js');
      const off = terminal.registerCommand('greet', { description: 'Say hello', usage: 'greet <name>', run(args, io) { io.print(`hello ${args[0]} from ${io.cwd || '/'}`, 'success'); return 0; } });
      const r = await terminal.run('greet bob');
      off();
      const r2 = await terminal.run('greet bob');
      return { r, r2, recent: terminal.recentOutput(5) };
    });
    assert.equal(apiResult.r.exitCode, 0);
    assert.match(apiResult.r.output, /hello bob from \//);
    assert.equal(apiResult.r2.exitCode, 127);
    assert.match(apiResult.recent, /command not found: greet/);
    out = await run(page, 'git status');
    assert.ok(/Source Control/.test(out) || !/command not found/.test(out), 'git registered by SCM or a hint');
    log('terminal.run / registerCommand / recentOutput; git hint');

    // Settings apply live
    await page.evaluate(async () => (await import('/src/core/settings.js')).settings.set('terminal.integrated.fontSize', 15));
    await waitFor(page, () => getComputedStyle(document.querySelector('.terminal-instance')).fontSize === '15px');
    await page.evaluate(async () => (await import('/src/core/settings.js')).settings.set('terminal.integrated.cursorStyle', 'underline'));
    await waitFor(page, () => document.querySelector('.terminal-instance').dataset.cursorStyle === 'underline');
    await page.evaluate(async () => { const { settings } = await import('/src/core/settings.js'); settings.reset('terminal.integrated.fontSize'); settings.reset('terminal.integrated.cursorStyle'); });

    // Ctrl+L clears; multiple terminals
    await page.keyboard.press('Control+l');
    await page.waitForTimeout(100);
    assert.ok((await screenText(page)).split('\n').length <= 2, 'Ctrl+L clears the screen');
    await t.command('workbench.action.terminal.new');
    await waitFor(page, async () => (await import('/src/panel/terminal.js')).terminals.list.length === 2);
    assert.match(await page.textContent('#panel .terminal-switcher-button'), /2: xsh/);
    await t.command('workbench.action.terminal.kill');
    await waitFor(page, async () => (await import('/src/panel/terminal.js')).terminals.list.length === 1);
    assert.match(await page.textContent('#panel .terminal-switcher-button'), /1: xsh/);
    log('Ctrl+L, New Terminal / Kill Terminal');

    // ---------------------------------------------------------------- PROBLEMS
    await page.evaluate(async () => {
      const { diagnostics } = await import('/src/core/diagnostics.js');
      diagnostics.set('panel-test', 'main.js', [
        { line: 3, col: 5, endLine: 3, endCol: 9, severity: 'error', message: "Unexpected token ')'", source: 'acorn', code: 'E1' },
        { line: 1, col: 1, severity: 'warning', message: "'answer' is assigned a value but never used.", source: 'eslint', code: 'no-unused-vars' }
      ]);
      diagnostics.set('panel-test', 'a/b/x.txt', [{ line: 1, col: 1, severity: 'info', message: 'Plain text file', source: 'test' }]);
    });
    await waitFor(page, () => (document.querySelector('#statusbar [data-id="status.problems"]')?.textContent || '').includes('1'));
    const status = await page.textContent('#statusbar [data-id="status.problems"]');
    assert.equal(status.replace(/\s+/g, ' ').trim(), '1 1', 'phone status bar: errors + warnings');
    assert.ok(await page.$('#statusbar [data-id="status.problems"] .codicon-error'), 'error codicon in the status bar');
    await page.tap('#statusbar [data-id="status.problems"] .statusbar-item-label');
    await page.waitForSelector('#panel .problems-tree .file-row', { state: 'visible' });
    assert.equal(await page.$$eval('#panel .problems-tree .file-row', r => r.length), 2);
    assert.equal(await page.$$eval('#panel .problems-tree .marker-row', r => r.length), 3);
    assert.equal(await page.textContent('#panel .panel-switcher .action-item.checked .badge-content'), '2');
    const markerText = await page.textContent('#panel .problems-tree .marker-row.severity-error');
    assert.match(markerText, /Unexpected token '\)'/); assert.match(markerText, /acorn\(E1\)/); assert.match(markerText, /\[Ln 3, Col 5\]/);
    assert.equal(await page.getAttribute('#panel .problems-filter input', 'placeholder'), 'Filter (e.g. text, **/*.ts, !**/node_modules/**)');
    await t.shot('panel-problems-phone-dark');
    await page.fill('#panel .problems-filter input', 'unused');
    assert.equal(await page.$$eval('#panel .problems-tree .marker-row', r => r.length), 1);
    await page.fill('#panel .problems-filter input', '!**/a/**');
    assert.equal(await page.$$eval('#panel .problems-tree .file-row', r => r.length), 1);
    await page.fill('#panel .problems-filter input', 'zzz-nothing');
    assert.match(await page.textContent('#panel .problems-message'), /No results found with provided filter criteria/);
    await page.fill('#panel .problems-filter input', '');
    await page.tap('#panel .problems-tree .marker-row.severity-error');
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.activePath === 'main.js');
    log('problems tree, status bar counts, badge, filter (text / !glob / empty state), tap opens file');
    await page.evaluate(async () => (await import('/src/core/diagnostics.js')).diagnostics.clear('panel-test'));
    await waitFor(page, () => !!document.querySelector('#panel .problems-message:not(.hidden)'));
    assert.match(await page.textContent('#panel .problems-message'), /No problems have been detected in the workspace\./);
    await page.evaluate(async () => {
      const { diagnostics } = await import('/src/core/diagnostics.js');
      diagnostics.set('panel-test', 'main.js', [
        { line: 3, col: 5, severity: 'error', message: "Unexpected token ')'", source: 'acorn', code: 'E1' },
        { line: 1, col: 1, severity: 'warning', message: "'answer' is assigned a value but never used.", source: 'eslint', code: 'no-unused-vars' }
      ]);
    });

    // ---------------------------------------------------------------- OUTPUT
    await page.evaluate(async () => {
      const { output } = await import('/src/core/output.js');
      const ch = output.channel('Panel Test');
      ch.info('hello output');
      ch.warn('careful: "quoted" value');
      ch.error('something failed');
      ch.show();
    });
    await page.waitForSelector('#panel .output-log .output-line', { state: 'visible' });
    assert.match(await page.textContent('#panel .output-channel-button'), /Panel Test/);
    const lines = await page.$$eval('#panel .output-log .output-line', r => r.map(x => x.textContent));
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[info\] hello output$/);
    assert.ok(await page.$('#panel .output-line.level-error .log-level'), 'level colour class');
    await t.shot('panel-output-phone-dark');
    await t.command('workbench.output.action.clearOutput');
    assert.equal(await page.$$eval('#panel .output-log .output-line', r => r.length), 0);
    await page.evaluate(async () => (await import('/src/core/output.js')).output.channel('Panel Test').info('after clear'));
    assert.equal(await page.$$eval('#panel .output-log .output-line', r => r.length), 1);
    log('output log format, channel switch via show(), clear');

    // ---------------------------------------------------------------- DEBUG CONSOLE
    await page.evaluate(async () => {
      const { bus } = await import('/src/core/events.js');
      bus.emit('preview:console', { level: 'log', text: 'Preview connected', time: Date.now(), source: 'main.js:1' });
      bus.emit('preview:console', { level: 'warn', text: 'Deprecated API', time: Date.now(), source: 'main.js:4' });
      bus.emit('preview:console', { level: 'error', text: 'Uncaught TypeError: x is not a function', time: Date.now(), source: 'main.js:9' });
      bus.emit('preview:console', { level: 'error', text: 'Uncaught TypeError: x is not a function', time: Date.now(), source: 'main.js:9' });
    });
    await t.command('workbench.debug.action.toggleRepl');
    await page.waitForSelector('#panel .repl-tree .repl-row', { state: 'visible' });
    assert.equal(await page.$$eval('#panel .repl-tree .repl-row', r => r.length), 3);
    assert.equal(await page.textContent('#panel .repl-row.level-error .repl-count'), '2');
    assert.ok(await page.$('#panel .repl-row.level-warning .codicon-warning'));
    await page.tap('#panel textarea.repl-input');
    await page.keyboard.type('1 + 1');
    await page.keyboard.press('Enter');
    await waitFor(page, () => document.querySelectorAll('#panel .repl-row.kind-result').length === 1);
    assert.equal(await page.textContent('#panel .repl-row.kind-input .repl-value'), '1 + 1');
    const result = await page.textContent('#panel .repl-row.kind-result .repl-value');
    assert.ok(result === '2' || /not running|not available/i.test(result), `REPL result: ${result}`);
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.$eval('#panel textarea.repl-input', el => el.value), '1 + 1');
    await page.keyboard.press('ArrowDown');
    await t.shot('panel-debug-phone-dark');
    log(`debug console entries, grouping badge, REPL (${result})`);

    // ---------------------------------------------------------------- LIGHT THEME
    await page.evaluate(async () => { (await import('/src/core/settings.js')).settings.set('workbench.colorTheme', 'light-plus'); document.activeElement?.blur(); });
    await page.waitForTimeout(200);
    await t.shot('panel-debug-phone-light');
    await t.command('workbench.action.output.toggleOutput');
    await t.shot('panel-output-phone-light');
    await t.command('workbench.actions.view.problems');
    await page.waitForSelector('#panel .problems-tree .marker-row', { state: 'visible' });
    await t.shot('panel-problems-phone-light');
    await t.command('workbench.action.terminal.focus');
    await page.waitForSelector('#panel .terminal-instance', { state: 'visible' });
    await run(page, 'ls -la');
    await run(page, 'printf "\\e[31mred \\e[32mgreen \\e[33myellow \\e[34mblue \\e[35mmagenta \\e[36mcyan\\e[0m\\n"');
    await t.shot('panel-terminal-phone-light');
    log('light theme screenshots');

    t.assertNoErrors();
  } finally {
    await t.close();
  }
}

async function desktop() {
  const t = await launch({ device: 'Desktop Chrome', viewport: { width: 1280, height: 800 } });
  const { page } = t;
  try {
    await page.keyboard.press('Control+Backquote');
    await page.waitForSelector('#panel .terminal-instance .xterm-viewport', { state: 'visible' });
    await waitFor(page, () => document.activeElement?.classList.contains('xterm-helper-textarea'));
    assert.ok(!(await page.isVisible('.terminal-keys')), 'no touch key row on desktop');
    assert.ok(await page.$('#panel .title-actions select.terminal-switcher'), 'desktop uses the native dropdown');
    await run(page, 'tree -L 2');
    await run(page, 'ls -la');
    await run(page, 'printf "\\e[1;34mbold blue\\e[0m \\e[4munderline\\e[0m \\e[7minverse\\e[0m \\e[38;2;255;100;0mtruecolor\\e[0m\\n"');
    await page.keyboard.type('echo partial');
    await t.shot('panel-terminal-desktop');
    // right-click → terminal context menu
    await page.click('#panel .xterm-viewport', { button: 'right' });
    await page.waitForSelector('.context-view-layer .monaco-menu');
    const items = await page.$$eval('.context-view-layer .monaco-menu .action-label', r => r.map(x => x.textContent.trim()));
    for (const label of ['Copy', 'Paste', 'Select All', 'Clear Terminal', 'Kill Terminal']) assert.ok(items.includes(label), `context menu has ${label}`);
    await page.keyboard.press('Escape');
    // Ctrl+` hides the panel from inside the terminal input
    await page.click('#panel .xterm-viewport');
    await page.keyboard.press('Control+Backquote');
    await waitFor(page, async () => !(await import('/src/workbench/layout.js')).layout.panelVisible);
    log('desktop terminal, context menu, Ctrl+` toggle');

    await page.evaluate(async () => {
      const { diagnostics } = await import('/src/core/diagnostics.js');
      diagnostics.set('panel-test', 'main.js', [
        { line: 3, col: 5, severity: 'error', message: "Unexpected token ')'", source: 'acorn', code: 'E1' },
        { line: 1, col: 1, severity: 'warning', message: "'answer' is assigned a value but never used.", source: 'eslint', code: 'no-unused-vars' }
      ]);
      diagnostics.set('panel-test', 'style.css', [{ line: 2, col: 3, severity: 'info', message: 'Unknown property', source: 'css' }]);
    });
    await page.keyboard.press('Control+Shift+M');
    await page.waitForSelector('#panel .title-actions .problems-filter input', { state: 'visible' });
    assert.equal((await page.textContent('#statusbar [data-id="status.problems"]')).replace(/\s+/g, ' ').trim(), '1 1 1', 'desktop status bar shows infos too');
    await page.focus('#panel .problems-tree');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.activePath === 'main.js');
    await t.command('workbench.actions.view.problems');
    await t.command('workbench.actions.view.problems');
    await page.waitForSelector('#panel .problems-tree .marker-row', { state: 'visible' });
    await t.shot('panel-problems-desktop');
    await t.command('workbench.action.output.toggleOutput');
    await page.waitForSelector('#panel .title-actions select.output-channel-select');
    await t.shot('panel-output-desktop');

    // Run Active File / Run Selected Text In Active Terminal
    await t.command('workbench.action.terminal.runActiveFile');
    await waitFor(page, async () => /\$ node main\.js/.test((await import('/src/panel/api.js')).terminal.recentOutput(20)));
    await page.evaluate(async () => {
      const { workspace } = await import('/src/core/workspace.js');
      await workspace.fs.writeText('cmds.sh', 'echo from-selection\n');
      const { editors } = await import('/src/workbench/editors.js');
      await editors.open({ type: 'file', path: 'cmds.sh' }, { pinned: true });
    });
    await waitFor(page, async () => !!(await import('/src/editor/api.js')).codeEditor.getActive()?.path?.endsWith('cmds.sh'));
    await page.evaluate(async () => {
      const ed = (await import('/src/editor/api.js')).codeEditor.getActive();
      ed.view.dispatch({ selection: { anchor: 0, head: ed.view.state.doc.length } });
    });
    await t.command('workbench.action.terminal.runSelectedText');
    await waitFor(page, async () => /^from-selection$/m.test((await import('/src/panel/api.js')).terminal.recentOutput(20)));
    const menu = await page.evaluate(async () => {
      const { menus } = await import('/src/core/menus.js');
      return { explorer: menus.resolve('explorer/context', { path: 'src', type: 'folder' }).map(i => i.label), editor: menus.resolve('editor/context', { path: 'cmds.sh' }).map(i => i.label) };
    });
    assert.ok(menu.explorer.includes('Open in Integrated Terminal'), 'explorer context: Open in Integrated Terminal');
    assert.ok(menu.editor.includes('Run Selected Text In Active Terminal'), 'editor context: Run Selected Text');
    log('Run Active File, Run Selected Text, contributed context menu items');
    log('desktop problems (keyboard navigation opens the file), output dropdown');
    t.assertNoErrors();
  } finally {
    await t.close();
  }
}

let failed = false;
for (const [name, fn] of [['iPhone 13', phone], ['Desktop', desktop]]) {
  console.log(`panel · ${name}`);
  try { await fn(); } catch (err) { failed = true; console.error(`  ✗ ${name}:`, err); }
}
if (failed) { console.error('panel test FAILED'); process.exit(1); }
console.log('panel test passed');
