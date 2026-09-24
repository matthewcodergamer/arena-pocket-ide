// X Coder AI chat UI end-to-end, against the REAL engine (src/ai/engine.js) and the harness mock Worker:
// welcome state, streamed markdown + code block toolbar, mode/model pickers, hold-Send model switch,
// image attachment (sent as an image part), slash commands (/explain, /help), stop, edit review
// (Agent undo, Edit keep, diff), voice input (fake SpeechRecognition), drafts, ai.attach, history across
// reload, light theme and the desktop Secondary Side Bar.
//
//   node tools/test/chat.test.mjs

import assert from 'node:assert/strict';
import { launch } from './harness.mjs';

const log = (...a) => console.log('  ·', ...a);

async function waitFor(page, fn, arg, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    const v = await page.evaluate(fn, arg).catch(() => false);
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${fn.toString().slice(0, 160)}`);
    await page.waitForTimeout(60);
  }
}
const clearToasts = page => page.evaluate(async () => { (await import('/src/platform/notifications.js')).notify.clearAll?.(); }).catch(() => {});
const waitIdle = page => waitFor(page, async () => !(await import('/src/ai/chatSession.js')).chat.busy && !document.querySelector('.interactive-response.running'), null, 20000);
const lastResponse = page => page.locator('.interactive-response').last();
const setSetting = (page, key, value) => page.evaluate(async ([k, v]) => (await import('/src/core/settings.js')).settings.set(k, v), [key, value]);
const getSetting = (page, key) => page.evaluate(async k => (await import('/src/core/settings.js')).settings.get(k), key);
const lastRequestText = mock => JSON.stringify(mock.requests.at(-1) || {});

async function openChat(page) {
  if (await page.locator('.chat-view').isVisible().catch(() => false)) return;
  await page.tap('#activitybar [data-container="workbench.view.chat"]');
  await page.waitForSelector('.chat-view .chat-input-textarea', { state: 'visible' });
}

/** Types + sends a prompt and waits until the new request row exists (the response may still be running). */
async function send(page, text, { key = false } = {}) {
  const before = await page.locator('.interactive-request').count();
  await page.fill('.chat-input-textarea', text);
  if (key) await page.keyboard.press('Enter'); else await page.tap('.chat-send-button');
  await waitFor(page, n => document.querySelectorAll('.interactive-request').length > n, before);
}
async function tapSend(page) {
  const before = await page.locator('.interactive-request').count();
  await page.tap('.chat-send-button');
  await waitFor(page, n => document.querySelectorAll('.interactive-request').length > n, before);
}

async function pngBase64(page, w = 64, h = 48) {
  return page.evaluate(([w, h]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = '#e53935'; x.fillRect(0, 0, w / 2, h);
    x.fillStyle = '#1e88e5'; x.fillRect(w / 2, 0, w / 2, h);
    return c.toDataURL('image/png').split(',')[1];
  }, [w, h]);
}

async function phoneTests() {
  const t = await launch({ device: 'iPhone 13', settings: { 'workbench.colorTheme': 'dark-plus' } });
  const { page, mock } = t;
  try {
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.project !== null);
    // X Coder 5 conversation to migrate (stored before the chat loads it for the project)
    await page.evaluate(async () => {
      const { kvSet, kvDelete } = await import('/src/core/db.js');
      const { workspace } = await import('/src/core/workspace.js');
      await kvDelete(`aiSessionMigrated:${workspace.id}`);
      await kvSet(`aiSession:${workspace.id}`, [{ id: 'm1', role: 'user', text: 'Old question from X Coder 5', time: Date.now() - 86400000 }, { id: 'm2', role: 'assistant', text: 'Old **answer**', time: Date.now() - 86399000 }]);
    });

    // ---------- open the chat from the Activity Bar: welcome state ----------
    await openChat(page);
    await page.waitForSelector('.chat-welcome');
    const welcome = await page.locator('.chat-welcome').innerText();
    assert.match(welcome, /Ask X Coder/);
    assert.match(welcome, /X Coder is your AI pair programmer\. It can explain code, fix bugs, build whole projects, analyze uploaded projects and photos, and edit files for you\./);
    assert.match(welcome, /Agent mode/);
    const chips = await page.locator('.chat-welcome-suggestion').allInnerTexts();
    assert.deepEqual(chips.map(s => s.trim()), ['Build a to-do app', 'Explain this project', 'Fix the problems', 'Analyze a photo']);
    assert.equal(await page.locator('.chat-input-textarea').getAttribute('placeholder'), 'Ask X Coder… (/ for commands, # for context)');
    assert.equal(await page.locator('.chat-input-textarea').getAttribute('enterkeyhint'), 'send');
    assert.match(await page.locator('#statusbar [data-id="xcoder.ai.status"]').innerText(), /X Coder/);
    // implicit context chip is absent (no file editor is active: the Welcome page is)
    await page.waitForTimeout(300);
    await t.shot('chat-welcome');
    log('welcome state');

    // ---------- send: streamed markdown + code block toolbar (real engine → mock Worker) ----------
    mock.enqueue('Hello **world**\n\n```js\nconsole.log(1)\n```');
    await send(page, 'Say hello');
    await page.waitForSelector('.interactive-request .request-text');
    await waitIdle(page);
    const resp = lastResponse(page);
    assert.equal(await resp.locator('.rendered-markdown strong').innerText(), 'world');
    assert.match(await resp.locator('.header .detail').innerText(), /via Mock Coder Large/);
    const block = resp.locator('.interactive-result-code-block');
    assert.equal(await block.locator('.code-block-language').innerText(), 'javascript');
    assert.equal(await block.locator('code').innerText(), 'console.log(1)');
    const toolbarTitles = await block.locator('.code-block-toolbar .action-label').evaluateAll(els => els.map(e => e.title));
    assert.deepEqual(toolbarTitles, ['Copy', 'Insert at Cursor', 'Apply in Editor', 'Insert into New File']);
    await waitFor(page, () => !!document.querySelector('.interactive-response .code-block-code [class^="tok-"]'));
    assert.equal(await block.locator('.code-block-toolbar').evaluate(el => getComputedStyle(el).opacity), '1', 'toolbar always visible on touch');
    const footer = await resp.locator('.chat-footer-toolbar .action-label').evaluateAll(els => els.map(e => e.title));
    assert.deepEqual(footer, ['Copy', 'Read Aloud', 'Retry', 'Helpful', 'Unhelpful']);
    const sent = mock.requests.at(-1);
    assert.ok(JSON.stringify(sent.messages).includes('Say hello'), 'prompt reached the worker');
    await resp.locator('.chat-footer-toolbar [title="Read Aloud"]').tap(); // device voice (fails quietly without voices in CI)
    await resp.locator('.chat-footer-toolbar [title="Helpful"]').tap();
    assert.equal(await resp.locator('.chat-footer-toolbar .checked-vote').count(), 1);
    await t.shot('chat-answer');
    log('streamed markdown, code block toolbar, highlighting, footer');

    // ---------- code block: Insert into New File + Apply in Editor (diff with Keep) ----------
    await block.locator('[title="Insert into New File"]').tap();
    await page.waitForSelector('.quick-input-widget:not(.hidden) input');
    assert.equal(await page.locator('.quick-input-widget input').inputValue(), 'untitled.js');
    await page.fill('.quick-input-widget input', 'snippets/one.js');
    await page.keyboard.press('Enter');
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.fs.peekText('snippets/one.js') === 'console.log(1)\n');
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.activePath === 'snippets/one.js');
    await page.evaluate(async () => (await import('/src/core/workspace.js')).workspace.fs.writeText('snippets/one.js', 'let a = 0;\n'));
    await openChat(page);
    await lastResponse(page).locator('[title="Apply in Editor"]').tap();
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.active?.key?.startsWith('diff:apply'));
    await page.locator('.diff-toolbar .diff-action', { hasText: 'Keep' }).tap();
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.fs.peekText('snippets/one.js') === 'console.log(1)\n');
    log('code block New File + Apply → Keep');

    // ---------- implicit current-file chip with eye toggle ----------
    await openChat(page);
    await page.waitForSelector('.chat-attached-context-attachment.implicit');
    assert.match(await page.locator('.chat-attached-context-attachment.implicit').innerText(), /one\.js\s*Current file/);
    await page.locator('.chat-attached-context-attachment.implicit .chip-toggle').tap();
    await page.waitForSelector('.chat-attached-context-attachment.implicit.disabled');
    await page.locator('.chat-attached-context-attachment.implicit .chip-toggle').tap();
    await page.waitForSelector('.chat-attached-context-attachment.implicit:not(.disabled)');
    log('implicit current-file chip');

    // ---------- mode picker ----------
    await page.tap('.chat-mode-picker');
    await page.waitForSelector('.chat-mode-menu');
    const modes = await page.locator('.chat-mode-menu .chat-picker-item .action-label').allInnerTexts();
    assert.deepEqual(modes, ['Agent', 'Ask', 'Edit']);
    assert.match(await page.locator('.chat-mode-menu').innerText(), /Answers questions only/);
    await page.waitForTimeout(200);
    await t.shot('chat-mode-menu');
    await page.tap('.chat-mode-menu .chat-picker-item[data-id="ask"]');
    await waitFor(page, () => document.querySelector('.chat-mode-picker .pill-label')?.textContent === 'Ask');
    assert.equal(await getSetting(page, 'xcoder.ai.mode'), 'ask');
    await setSetting(page, 'xcoder.ai.mode', 'agent');
    log('mode picker');

    // ---------- model picker (quick pick grouped from catalog.list()) ----------
    await page.tap('.chat-model-picker');
    await page.waitForSelector('.quick-input-widget:not(.hidden) .quick-input-list-entry');
    const modelRows = await page.locator('.quick-input-list-entry .label-name').allInnerTexts();
    assert.ok(modelRows.includes('Auto') && modelRows.includes('Mock Coder Large') && modelRows.includes('Mock Fast'), `models listed: ${modelRows.join(', ')}`);
    await page.waitForTimeout(200);
    await t.shot('chat-model-picker');
    await page.locator('.quick-input-list-entry', { hasText: 'Mock Fast' }).first().tap();
    await waitFor(page, () => document.querySelector('.chat-model-picker .pill-label')?.textContent === 'Mock Fast');
    assert.equal(await getSetting(page, 'xcoder.ai.model'), 'worker:mock:mock-fast');
    log('model picker');

    // ---------- hold Send to switch model (X Coder 5 gesture) ----------
    const sendBox = await page.locator('.chat-send-button').boundingBox();
    await page.mouse.move(sendBox.x + sendBox.width / 2, sendBox.y + sendBox.height / 2);
    await page.mouse.down();
    await page.waitForSelector('.chat-quick-model-picker', { timeout: 3000 });
    await page.waitForTimeout(200);
    await t.shot('chat-hold-model');
    const autoRow = await page.locator('.chat-quick-model-picker .chat-picker-item', { hasText: 'Auto' }).first().boundingBox();
    await page.mouse.move(autoRow.x + autoRow.width / 2, autoRow.y + autoRow.height / 2, { steps: 4 });
    await page.mouse.up();
    await waitFor(page, async () => (await import('/src/core/settings.js')).settings.get('xcoder.ai.model') === 'auto');
    assert.equal(await page.locator('.chat-quick-model-picker').count(), 0);
    assert.equal(await page.locator('.interactive-request').count(), 1, 'the long press did not send');
    log('hold-to-switch model');
    await clearToasts(page);

    // ---------- attach an image (file chooser) → image part sent to the worker ----------
    const b64 = await pngBase64(page);
    await page.tap('.chat-attach-button');
    await page.waitForSelector('.context-view-layer .monaco-menu');
    const attachItems = await page.locator('.context-view-layer .monaco-menu .action-label').allInnerTexts();
    for (const label of ['Files…', 'Photos or Camera…', 'Take Photo', 'Folder…', 'Project ZIP…', 'Current File', 'Selection', 'Problems', 'Terminal Output', 'Git Changes', 'Project Files…']) assert.ok(attachItems.includes(label), `attach menu has ${label}`);
    await page.waitForTimeout(200);
    await t.shot('chat-attach-menu');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.context-view-layer .action-item', { hasText: 'Photos or Camera…' }).tap()]);
    await chooser.setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
    await page.waitForSelector('.interactive-input-part .chat-attached-context-attachment.image img');
    await page.locator('.interactive-input-part .chat-attached-context-attachment.image').tap();
    await page.waitForSelector('.chat-image-preview img');
    await page.waitForTimeout(200);
    await t.shot('chat-image-preview');
    await page.locator('.chat-image-preview .monaco-button', { hasText: 'Save to Project' }).tap();
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.fs.isFile('assets/photo.png'));
    await page.waitForSelector('.chat-image-preview', { state: 'detached' });
    mock.enqueue('I see a red and a blue rectangle.');
    await send(page, 'What is in this photo?');
    await waitIdle(page);
    const imgReq = mock.requests.at(-1);
    const parts = imgReq.messages.flatMap(m => (Array.isArray(m.content) ? m.content : []));
    assert.ok(parts.some(p => p.type === 'image_url' && /^data:image\/(png|jpeg)/.test(p.image_url?.url || '')), `image part sent to the worker: ${JSON.stringify(imgReq.messages.map(m => (Array.isArray(m.content) ? m.content.map(c => c.type) : typeof m.content)))} model=${imgReq.model} requests=${mock.requests.length}`);
    assert.ok(JSON.stringify(imgReq.messages).includes('Say hello'), 'earlier turns are sent as history');
    assert.equal(await page.locator('.interactive-request').last().locator('.chat-attached-context-attachment.image img').count(), 1);
    assert.equal(await page.locator('.interactive-input-part .chat-attached-context-attachment.image').count(), 0, 'chips cleared after sending');
    log('image attachment → image_url part');

    // ---------- big photos are downscaled; text files attach; PDFs explain why + offer Add to Project ----------
    const big = await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 3200; c.height = 2000;
      const x = c.getContext('2d'); x.fillStyle = '#3a7'; x.fillRect(0, 0, 3200, 2000);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const { readImageFile } = await import('/src/ai/attachments.js');
      const a = await readImageFile(new File([blob], 'big.png', { type: 'image/png' }));
      return { w: a.width, h: a.height, mime: a.mime, name: a.name, thumb: a.thumb.length > 100 && a.thumb.length < 40000 };
    });
    assert.deepEqual(big, { w: 1600, h: 1000, mime: 'image/jpeg', name: 'big.jpg', thumb: true });
    await clearToasts(page);
    await page.evaluate(async () => {
      const { handleFiles } = await import('/src/ai/chatInput.js');
      await handleFiles([new File(['hello notes'], 'notes.txt', { type: 'text/plain' }), new File([new Uint8Array([37, 80, 68, 70, 0, 1, 2, 3])], 'doc.pdf', { type: 'application/pdf' })]);
    });
    await page.waitForSelector('.interactive-input-part .chat-attached-context-attachment', { hasText: 'notes.txt' });
    const toast = page.locator('.notification-toast', { hasText: 'PDF documents cannot be read' });
    await toast.waitFor();
    await toast.locator('.monaco-button', { hasText: 'Add to Project' }).tap();
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.fs.exists('doc.pdf'));
    await page.locator('.interactive-input-part .chat-attached-context-attachment', { hasText: 'notes.txt' }).locator('.chip-remove').tap();
    await clearToasts(page);
    log('image downscale, text attachment, PDF → Add to Project');

    // ---------- "/" suggestions → /explain (attaches the current file) ----------
    await page.fill('.chat-input-textarea', '');
    await page.locator('.chat-input-textarea').pressSequentially('/ex');
    await page.waitForSelector('.chat-suggest-widget .chat-picker-item');
    assert.deepEqual(await page.locator('.chat-suggest-widget .action-label').allInnerTexts(), ['/explain']);
    await page.locator('.chat-input-textarea').press('Backspace');
    await page.locator('.chat-input-textarea').press('Backspace');
    await waitFor(page, () => document.querySelectorAll('.chat-suggest-widget .chat-picker-item').length === 9);
    await page.waitForTimeout(200);
    await t.shot('chat-slash-menu');
    await page.locator('.chat-suggest-widget .chat-picker-item', { hasText: '/explain' }).tap();
    assert.equal(await page.locator('.chat-input-textarea').inputValue(), '/explain ');
    mock.enqueue('This file logs `1` to the console.');
    await tapSend(page);
    await waitIdle(page);
    const explainReq = lastRequestText(mock);
    assert.ok(explainReq.includes('Explain how the selected code'), 'slash command expanded');
    assert.ok(explainReq.includes('snippets/one.js'), 'current file attached');
    assert.equal(await page.locator('.interactive-request').last().locator('.chat-slash-command').innerText(), '/explain');
    log('/explain');

    // ---------- "#" suggestions → #problems chip ----------
    await page.fill('.chat-input-textarea', '');
    await page.locator('.chat-input-textarea').pressSequentially('check #pro');
    await page.waitForSelector('.chat-suggest-widget .chat-picker-item');
    await page.locator('.chat-suggest-widget .chat-picker-item', { hasText: '#problems' }).tap();
    await page.waitForSelector('.interactive-input-part .chat-attached-context-attachment', { hasText: 'Problems' });
    assert.equal((await page.locator('.chat-input-textarea').inputValue()).trim(), 'check');
    await page.locator('.interactive-input-part .chat-attached-context-attachment', { hasText: 'Problems' }).locator('.chip-remove').tap();
    await page.fill('.chat-input-textarea', '');
    log('# context menu');

    // ---------- /help is answered locally ----------
    const before = mock.requests.length;
    await send(page, '/help');
    await page.waitForSelector('.interactive-response:last-child table');
    assert.equal(mock.requests.length, before, '/help does not call the model');
    log('/help');

    // ---------- Stop aborts a running request ----------
    mock.enqueue(async () => { await new Promise(r => setTimeout(r, 5000)); return 'too late'; });
    await send(page, 'Take your time');
    await page.waitForSelector('.chat-send-button.stop');
    await page.waitForSelector('.interactive-response.running .chat-response-status');
    await t.shot('chat-running');
    await page.tap('.chat-send-button');
    await waitIdle(page);
    assert.match(await lastResponse(page).locator('.chat-response-note').innerText(), /Stopped\. Your files were not changed\./);
    assert.equal(await page.locator('.chat-send-button.stop').count(), 0);
    await page.waitForTimeout(5200); // let the mock's delayed reply drain so it cannot answer the next request
    log('stop');

    // ---------- Agent edits: Changed N files → open diff → Undo ----------
    mock.enqueue('Creating the file.\n<write_file path="hello.txt">hi there\n</write_file>');
    mock.enqueue('Created hello.txt.');
    await send(page, 'Create hello.txt');
    await waitIdle(page);
    const edits = lastResponse(page).locator('.chat-edits');
    await edits.waitFor();
    assert.match(await edits.locator('.chat-edits-title').innerText(), /Changed 1 file/);
    const row = edits.locator('.chat-edit-row[data-path="hello.txt"]');
    assert.match(await row.innerText(), /hello\.txt[\s\S]*\+1[\s\S]*Applied/);
    assert.equal(await page.evaluate(async () => (await import('/src/core/workspace.js')).workspace.fs.peekText('hello.txt')), 'hi there\n');
    await t.shot('chat-edits');
    await row.locator('.edit-name').tap();
    await waitFor(page, async () => (await import('/src/workbench/editors.js')).editors.active?.key?.startsWith('diff:xcoder-edit-'));
    await openChat(page);
    await lastResponse(page).locator('.chat-edit-row[data-path="hello.txt"] [title^="Undo"]').tap();
    await waitFor(page, async () => !(await import('/src/core/workspace.js')).workspace.fs.exists('hello.txt'));
    await waitFor(page, () => /Undone/.test(document.querySelector('.interactive-response:last-child .chat-edit-row')?.textContent || ''));
    log('agent edits: diff + undo');

    // ---------- Edit mode: pending edits → Keep All writes ----------
    await setSetting(page, 'xcoder.ai.mode', 'edit');
    mock.enqueue('Proposed.\n<write_file path="notes.md"># Notes\n</write_file>');
    await send(page, 'Add notes.md');
    await waitIdle(page);
    const pend = lastResponse(page).locator('.chat-edits');
    assert.match(await pend.locator('.chat-edit-row').innerText(), /Pending/);
    assert.match(await pend.locator('.chat-edits-hint').innerText(), /Nothing is written until you keep it/);
    assert.equal(await page.evaluate(async () => (await import('/src/core/workspace.js')).workspace.fs.exists('notes.md')), false, 'nothing written before Keep');
    await pend.locator('.chat-keep-all').tap();
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.fs.peekText('notes.md') === '# Notes\n');
    await waitFor(page, () => /Kept/.test(document.querySelector('.interactive-response:last-child .chat-edit-row')?.textContent || ''));
    await setSetting(page, 'xcoder.ai.mode', 'agent');
    log('edit mode: keep all');

    // ---------- errors render as an error box; Retry re-sends (fake engine via setEngineForTesting) ----------
    mock.queue.length = 0;
    await page.evaluate(async () => {
      const view = await import('/src/ai/chatView.js');
      const real = await import('/src/ai/engine.js');
      view.setEngineForTesting({ ...real, runTurn: async req => { req.onEvent({ type: 'status', text: 'Connecting…' }); await new Promise(r => setTimeout(r, 50)); throw new Error('The X Coder AI router is unreachable (test).'); } });
    });
    await send(page, 'This will fail first');
    await waitIdle(page);
    const errBox = lastResponse(page).locator('.chat-error');
    assert.match(await errBox.innerText(), /router is unreachable \(test\)[\s\S]*Retry/);
    await page.waitForTimeout(150);
    await t.shot('chat-error');
    await page.evaluate(async () => (await import('/src/ai/chatView.js')).setEngineForTesting(null));
    mock.enqueue('<think>The user retried after an error.</think>Recovered after the retry.');
    await errBox.locator('.chat-error-retry').tap();
    await waitFor(page, () => /Recovered after the retry/.test(document.querySelector('.interactive-response:last-child .rendered-markdown')?.textContent || ''), null, 20000);
    await waitIdle(page);
    assert.equal(await lastResponse(page).locator('.chat-error:not(.hidden)').count(), 0);
    const thinkingHtml = await lastResponse(page).evaluate(el => el.outerHTML);
    assert.equal(await lastResponse(page).locator('.chat-thinking:not(.hidden) summary').innerText(), 'Thinking', thinkingHtml);
    log('error box, retry, reasoning disclosure');

    // ---------- voice input (fake SpeechRecognition: interim + final text flow into the textarea) ----------
    await page.evaluate(() => {
      class FakeSR {
        start() { setTimeout(() => this.emit([{ t: 'hello', f: false }]), 50); setTimeout(() => this.emit([{ t: 'hello from voice', f: true }]), 120); }
        stop() { setTimeout(() => this.onend?.(), 10); }
        emit(rows) { const results = rows.map(r => Object.assign([{ transcript: r.t }], { isFinal: r.f })); this.onresult?.({ results }); }
      }
      window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;
    });
    await page.fill('.chat-input-textarea', '');
    await page.tap('.chat-mic-button');
    await page.waitForSelector('.chat-mic-button.listening');
    await waitFor(page, () => document.querySelector('.chat-input-textarea').value === 'hello from voice');
    await page.tap('.chat-mic-button');
    await page.waitForSelector('.chat-mic-button:not(.listening)');
    log('voice input');

    // ---------- draft survives closing the chat; ai.attach adds a chip ----------
    await page.fill('.chat-input-textarea', 'draft text to keep');
    await page.waitForTimeout(350);
    await page.evaluate(async () => (await import('/src/ai/api.js')).ai.attach({ type: 'file', path: 'style.css' }));
    await page.waitForSelector('.interactive-input-part .chat-attached-context-attachment', { hasText: 'style.css' });
    await page.tap('#auxiliarybar .composite.title .codicon-close');
    await openChat(page);
    assert.equal(await page.locator('.chat-input-textarea').inputValue(), 'draft text to keep');
    log('draft + ai.attach');

    // ---------- Voice settings hub ----------
    await t.command('xcoder.voice.configure');
    await page.waitForSelector('.quick-input-widget:not(.hidden) .quick-input-title');
    assert.equal(await page.locator('.quick-input-title').innerText(), 'Voice Settings');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.quick-input-widget', { state: 'hidden' });

    // ---------- history persists across reload ----------
    await page.evaluate(async () => (await import('/src/ai/chatSession.js')).chat.saveNow());
    await page.reload();
    await page.waitForSelector('#boot-screen', { state: 'detached', timeout: 15000 }).catch(() => {});
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.project !== null);
    await openChat(page);
    await page.waitForSelector('.interactive-request');
    const texts = await page.locator('.interactive-request .request-text').allInnerTexts();
    assert.ok(texts.includes('Say hello') && texts.includes('What is in this photo?'), `restored: ${texts.join(' | ')}`);
    assert.equal(await page.locator('.interactive-request').filter({ hasText: 'What is in this photo?' }).locator('.chat-attached-context-attachment.image img').count(), 1, 'image thumbnail kept in history');
    assert.equal(await page.locator('.chat-input-textarea').inputValue(), 'draft text to keep', 'draft restored after reload');
    await page.waitForTimeout(250);
    await t.shot('chat-restored');
    // history quick pick lists the current chat and the migrated X Coder 5 conversation
    await t.command('workbench.action.chat.history');
    await page.waitForSelector('.quick-input-widget:not(.hidden) .quick-input-list-entry');
    const hist = await page.locator('.quick-input-list-entry .label-name').allInnerTexts();
    assert.ok(hist.includes('Say hello') && hist.includes('Previous conversation'), `history: ${hist.join(' | ')}`);
    await page.waitForTimeout(200);
    await t.shot('chat-history');
    await page.locator('.quick-input-list-entry', { hasText: 'Previous conversation' }).tap();
    await page.waitForSelector('.interactive-request .request-text >> text=Old question from X Coder 5');
    // New Chat → welcome
    await page.tap('#auxiliarybar .composite.title .codicon-plus');
    await page.waitForSelector('.chat-welcome');
    log('history across reload, legacy migration, new chat');

    // ---------- a project ZIP is imported as a new project and analyzed; switching back restores that chat ----------
    const firstProject = await page.evaluate(async () => (await import('/src/core/workspace.js')).workspace.id);
    mock.enqueue('This is a small calculator web app with an add() function.');
    await page.evaluate(async () => {
      const JSZip = (await import('/vendor/jszip.js')).default;
      const z = new JSZip();
      z.file('calc/index.html', '<!doctype html><h1>Calc</h1><script src="app.js"></script>');
      z.file('calc/app.js', 'function add(a, b) { return a + b; }\n');
      const blob = await z.generateAsync({ type: 'blob' });
      const { handleFiles } = await import('/src/ai/chatInput.js');
      handleFiles([new File([blob], 'calc.zip', { type: 'application/zip' })]);
    });
    await waitFor(page, async ([pid]) => { const { workspace } = await import('/src/core/workspace.js'); return workspace.id !== pid && workspace.fs.files().some(f => /app\.js$/.test(f.path)); }, [firstProject], 15000);
    await waitFor(page, () => /Analyze this project/.test(document.querySelector('.interactive-request .request-text')?.textContent || ''), null, 15000);
    await waitIdle(page);
    assert.ok(lastRequestText(mock).includes('Analyze this project: explain its purpose'), 'analyze prompt sent');
    assert.ok(lastRequestText(mock).includes('add(a, b)'), 'the imported code reached the model');
    assert.equal(await page.locator('.interactive-request').count(), 1, 'a fresh chat for the imported project');
    await page.evaluate(async pid => (await import('/src/core/workspace.js')).workspace.openProject(pid), firstProject);
    await openChat(page);
    await waitFor(page, () => [...document.querySelectorAll('.interactive-request .request-text')].some(e => e.textContent === 'Say hello'));
    log('ZIP import → new project → analyze; project switch restores the chat');

    // ---------- scroll-to-bottom button when the user scrolled up ----------
    await page.evaluate(() => { const l = document.querySelector('.interactive-list'); l.scrollTop = 0; l.dispatchEvent(new Event('scroll')); });
    await page.waitForSelector('.chat-scroll-down:not(.hidden)');
    await page.tap('.chat-scroll-down');
    await waitFor(page, () => { const l = document.querySelector('.interactive-list'); return l.scrollHeight - l.scrollTop - l.clientHeight < 40; });
    await page.waitForSelector('.chat-scroll-down.hidden', { state: 'attached' });
    log('scroll to bottom');

    // ---------- light theme ----------
    await setSetting(page, 'workbench.colorTheme', 'light-plus');
    await t.command('workbench.action.chat.history');
    await page.waitForSelector('.quick-input-list-entry');
    await page.locator('.quick-input-list-entry', { hasText: 'Say hello' }).tap();
    await page.waitForSelector('.interactive-result-code-block');
    await page.waitForTimeout(300);
    await t.shot('chat-light');
    await setSetting(page, 'workbench.colorTheme', 'hc-black');
    await page.waitForTimeout(200);
    await t.shot('chat-hc');
    await setSetting(page, 'workbench.colorTheme', 'dark-plus');
    log('light + high contrast themes');

    // ---------- delete a chat from the history quick pick ----------
    await t.command('workbench.action.chat.history');
    await page.waitForSelector('.quick-input-list-entry', { hasText: 'Previous conversation' });
    await page.locator('.quick-input-list-entry', { hasText: 'Previous conversation' }).locator('.codicon-trash').tap();
    await waitFor(page, () => ![...document.querySelectorAll('.quick-input-list-entry')].some(e => /Previous conversation/.test(e.textContent)));
    await page.keyboard.press('Escape');
    log('delete chat from history');

    await clearToasts(page);
    t.assertNoErrors();
  } catch (err) {
    await t.shot('chat-failure').catch(() => {});
    throw err;
  } finally {
    await t.close();
  }
}

async function desktopTests() {
  const t = await launch({ device: 'Desktop Chrome', viewport: { width: 1280, height: 800 } });
  const { page, mock } = t;
  try {
    await waitFor(page, async () => (await import('/src/core/workspace.js')).workspace.project !== null);
    await page.evaluate(async () => (await import('/src/workbench/editors.js')).editors.open({ type: 'file', path: 'main.js' }, { pinned: true }));
    await page.click('#activitybar [data-container="workbench.view.chat"]');
    await page.waitForSelector('#auxiliarybar .chat-view .chat-input-textarea');
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('chat-input-textarea')), 'input focused on desktop');
    await page.waitForSelector('.chat-attached-context-attachment.implicit');
    mock.enqueue('Here is a table:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n```bash\necho hi\n```\n\nSee `main.js` and [docs](https://example.com).\n\n<script>alert(1)</script><img src="https://tracker.example/x.png" onerror="alert(2)">');
    await send(page, 'Show me formatting', { key: true });
    await waitIdle(page);
    const md = page.locator('.interactive-response').last().locator('.rendered-markdown');
    assert.equal(await md.locator('table').count(), 1);
    assert.equal(await md.locator('input[type=checkbox][disabled]').count(), 2);
    assert.equal(await md.locator('script, img').count(), 0, 'scripts and remote images are sanitized');
    assert.equal(await md.locator('a[href="https://example.com"]').getAttribute('target'), '_blank');
    assert.equal(await md.locator('code.file-link').innerText(), 'main.js');
    const bashTitles = await md.locator('.interactive-result-code-block .code-block-toolbar .action-label').evaluateAll(els => els.map(e => e.title));
    assert.ok(bashTitles.includes('Run in Terminal'), 'shell blocks can run in the terminal');
    const req = JSON.stringify(mock.requests.at(-1));
    assert.ok(req.includes('main.js'), 'implicit current file attached');
    await md.locator('.interactive-result-code-block [title="Insert at Cursor"]').click();
    await waitFor(page, async () => ((await import('/src/editor/api.js')).codeEditor.getText('main.js') || '').includes('echo hi'));
    // drag & drop and paste attach files
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['dropped text'], 'dropped.md', { type: 'text/markdown' }));
      const root = document.querySelector('.chat-view');
      root.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      root.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const pasted = new DataTransfer();
      pasted.items.add(new File(['pasted'], 'pasted.txt', { type: 'text/plain' }));
      document.querySelector('.chat-input-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: pasted, bubbles: true, cancelable: true }));
    });
    await page.waitForSelector('.interactive-input-part .chat-attached-context-attachment', { hasText: 'dropped.md' });
    await page.waitForSelector('.interactive-input-part .chat-attached-context-attachment', { hasText: 'pasted.txt' });
    assert.ok(await page.locator('.chat-drop-overlay').evaluate(el => el.classList.contains('hidden')));
    await page.evaluate(async () => (await import('/src/ai/chatInput.js')).clearAttachments());
    // status bar item menu
    await page.click('#statusbar [data-id="xcoder.ai.status"] .statusbar-item-label');
    await page.waitForSelector('.context-view-layer .monaco-menu');
    const statusMenu = await page.locator('.context-view-layer .monaco-menu .action-label').allInnerTexts();
    for (const label of ['Open Chat', 'Model: Auto', 'Mode: Agent', 'Test AI Providers', 'AI Settings']) assert.ok(statusMenu.includes(label), `status menu has ${label}: ${statusMenu.join(', ')}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.context-view-layer', { state: 'detached' });
    // ↑ recalls the previous prompt, ↓ returns to the draft
    await page.fill('.chat-input-textarea', '');
    await page.focus('.chat-input-textarea');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.locator('.chat-input-textarea').inputValue(), 'Show me formatting');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.chat-input-textarea').inputValue(), '');
    // Shift+Enter inserts a newline, Enter sends
    await page.fill('.chat-input-textarea', 'line one');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('line two');
    assert.equal(await page.locator('.chat-input-textarea').inputValue(), 'line one\nline two');
    await page.fill('.chat-input-textarea', '');
    // Mod+L → New Chat while the chat has focus
    await page.focus('.chat-input-textarea');
    await page.keyboard.press('Control+KeyL');
    await page.waitForSelector('#auxiliarybar .chat-welcome');
    await page.waitForTimeout(250);
    await t.shot('chat-desktop');
    // editor context menu → X Coder submenu contains the chat commands
    const items = await page.evaluate(async () => {
      const { menus } = await import('/src/core/menus.js');
      return menus.resolve('editor/context/xcoder', { path: 'main.js' }).map(i => i.label);
    });
    assert.deepEqual(items, ['Explain', 'Fix', 'Generate Tests', 'Generate Docs', 'Review']);
    mock.enqueue('This file logs a message when the preview connects.');
    await t.command('xcoder.chat.explain', { path: 'main.js' });
    await waitFor(page, () => !!document.querySelector('.interactive-request .chat-slash-command'));
    await waitIdle(page);
    assert.ok(lastRequestText(mock).includes('Explain how the selected code'), 'Explain command sent /explain');
    assert.equal(await page.locator('.interactive-request .chat-slash-command').innerText(), '/explain');
    await page.waitForTimeout(200);
    await t.shot('chat-desktop-explain');
    t.assertNoErrors();
    log('desktop: secondary side bar, sanitizing, keyboard, editor commands');
  } catch (err) {
    await t.shot('chat-desktop-failure').catch(() => {});
    throw err;
  } finally {
    await t.close();
  }
}

let failed = false;
for (const [name, fn] of [['iPhone', phoneTests], ['Desktop', desktopTests]]) {
  const started = Date.now();
  try { console.log(`chat (${name})`); await fn(); console.log(`  ✓ ${name} passed in ${((Date.now() - started) / 1000).toFixed(1)} s`); }
  catch (err) { failed = true; console.error(`  ✗ ${name} failed:`, err); }
}
process.exit(failed ? 1 : 0);
