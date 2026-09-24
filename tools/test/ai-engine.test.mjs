// X Coder AI engine end-to-end tests (browser, iPhone 13 + desktop) against the mock AI Worker.
// Covers: streaming chat, the agent loop (read → edit → preview → summary) with checkpoint undo, Edit-mode
// staging + keep/diff/conflicts, image attachments (vision), the legacy JSON protocol, SEARCH failure → retry,
// SSE and JSON router replies, Puter routing with automatic failover, and the engine commands.
// Run: node tools/test/ai-engine.test.mjs
import { launch } from './harness.mjs';
import assert from 'node:assert/strict';

const RED_DOT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP8z4AATEhsSmUBAGkCAQ8K0mEAAAAASUVORK5CYII=';

function lastUserText(body) {
  const m = [...body.messages].reverse().find(x => x.role === 'user');
  if (!m) return '';
  return typeof m.content === 'string' ? m.content : m.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
}

async function setup(t) {
  const { page } = t;
  await page.waitForFunction(async () => {
    const { workspace } = await import('/src/core/workspace.js');
    return !!workspace.fs && workspace.fs.exists('index.html');
  }, null, { timeout: 15000 });
  await page.evaluate(async () => {
    const eng = await import('/src/ai/engine.js');
    const providers = await import('/src/ai/providers.js');
    const { workspace } = await import('/src/core/workspace.js');
    const { bus } = await import('/src/core/events.js');
    const { settings } = await import('/src/core/settings.js');
    window.__xc = { eng, providers, workspace, settings, applied: [] };
    bus.on('ai:editsApplied', e => window.__xc.applied.push(e));
    window.__turn = async req => {
      const events = [];
      try {
        const res = await eng.runTurn({ ...req, onEvent: e => events.push(e) });
        return { res, events };
      } catch (err) { return { error: err.message, name: err.name, events, partial: { turnId: err.turnId, edits: err.edits } }; }
    };
    window.__read = p => window.__xc.workspace.fs.peekText(p);
    await eng.catalog.refresh({ force: true });
  });
}
const turn = (page, req) => page.evaluate(r => window.__turn(r), req);
const read = (page, p) => page.evaluate(p => window.__read(p), p);

async function engineScenarios(t) {
  const { page, mock } = t;
  const problems = [];
  const expect = (cond, msg) => { if (!cond) problems.push(msg); };

  // --- catalog + status
  const status = await page.evaluate(() => window.__xc.eng.catalog.status());
  assert.equal(status.worker, 'ready', 'mock router is ready');
  const list = await page.evaluate(() => window.__xc.eng.catalog.list());
  assert.ok(list.some(x => x.id === 'auto') && list.some(x => x.id === 'worker:mock:mock-coder-large'), 'catalog lists auto + router models');
  // legacy X Coder 5 selection ids are migrated
  const migrated = await page.evaluate(() => { window.__xc.settings.set('xcoder.ai.model', 'worker|mock|mock-fast'); const v = window.__xc.eng.catalog.current(); window.__xc.settings.set('xcoder.ai.model', 'auto'); return v; });
  assert.equal(migrated, 'worker:mock:mock-fast');

  // --- (1) Ask mode: streamed chat reply
  const hello = 'Hello! I am X Coder, your coding assistant. What would you like to build today?';
  mock.enqueue(body => {
    expect(body.stream === true, 'ask: stream requested');
    expect(/You are X Coder/.test(body.system) && /# Mode: Ask/.test(body.system), 'ask: system prompt has identity + Ask mode');
    expect(/<environment>[\s\S]*Project: [\s\S]*<user_request>\nhi\n<\/user_request>/.test(lastUserText(body)), 'ask: environment + request');
    expect(/\nStack: HTML \(1\), JavaScript \(1\), CSS \(1\)|\nStack: [^\n]*HTML/.test(lastUserText(body)), 'ask: project profile in environment');
    expect(body.max_tokens === 8192 || body.max_tokens === 16384, 'ask: max_tokens');
    return hello;
  });
  let r = await turn(page, { prompt: 'hi', mode: 'ask', history: [] });
  assert.ok(!r.error, r.error);
  assert.equal(r.res.text, hello);
  const deltas = r.events.filter(e => e.type === 'text');
  assert.ok(deltas.length >= 2, `streamed in several deltas (${deltas.length})`);
  assert.equal(deltas.map(d => d.delta).join(''), hello);
  assert.ok(r.events.some(e => e.type === 'route' && e.provider === 'Mock Provider'), 'route event');
  assert.equal(r.res.rounds, 1);
  assert.ok(r.res.usage.total > 0, 'usage recorded');

  // --- (2) Agent mode: read → edit → preview/problems → summary, then checkpoint undo
  const originalIndex = await read(page, 'index.html');
  mock.enqueue(body => {
    expect(/# Mode: Agent/.test(body.system), 'agent: Agent mode prompt');
    return "I'll check the page first.\n<read_file path=\"index.html\"/>";
  });
  mock.enqueue(body => {
    const u = lastUserText(body);
    expect(/<tool_result name="read_file" path="index.html" status="ok">/.test(u), 'agent: read_file result sent back');
    expect(/\d+ \|\s+<h1>Built in X Coder<\/h1>/.test(u), 'agent: numbered file content in result');
    expect(body.messages.some(m => m.role === 'assistant' && /<read_file path="index.html"\/>/.test(m.content)), 'agent: assistant message keeps its tool call');
    return 'Updating the heading now.\n<edit_file path="index.html">\n<<<<<<< SEARCH\n    <h1>Built in X Coder</h1>\n=======\n    <h1>Hello from the agent</h1>\n>>>>>>> REPLACE\n</edit_file>\n<run_preview/>\n<get_problems/>';
  });
  mock.enqueue(body => {
    const u = lastUserText(body);
    expect(/<tool_result name="edit_file" path="index.html" status="ok">\nEdited index.html: applied 1 of 1 block/.test(u), 'agent: edit result');
    expect(/Hello from the agent/.test(u), 'agent: edit result shows the new lines');
    expect(/<tool_result name="run_preview"[^>]*>/.test(u), 'agent: run_preview result');
    expect(/<tool_result name="get_problems"[^>]*status="ok">/.test(u), 'agent: get_problems result');
    return 'Done — the heading now says **Hello from the agent**. Tap ▶ Run to see it.';
  });
  r = await turn(page, { prompt: 'Change the heading to "Hello from the agent"', mode: 'agent' });
  assert.ok(!r.error, r.error);
  assert.equal(r.res.rounds, 3);
  assert.match(r.res.text, /I'll check the page first\.\n\nUpdating the heading now\.\n\nDone/);
  assert.ok(!/<read_file|<edit_file|SEARCH/.test(r.events.filter(e => e.type === 'text').map(e => e.delta).join('')), 'no raw tags streamed');
  assert.deepEqual(r.events.filter(e => e.type === 'round').map(e => e.index), [1, 2, 3]);
  const toolEvents = r.events.filter(e => e.type === 'tool');
  assert.ok(toolEvents.some(e => e.name === 'read_file' && e.state === 'running' && e.label === 'Reading index.html'));
  assert.ok(toolEvents.some(e => e.name === 'read_file' && e.state === 'done' && /^Read index.html/.test(e.label)));
  assert.ok(toolEvents.some(e => e.name === 'run_preview'));
  const editEv = r.events.find(e => e.type === 'edit');
  assert.equal(editEv.path, 'index.html'); assert.equal(editEv.kind, 'modify'); assert.equal(editEv.state, 'applied');
  assert.equal(editEv.added, 1); assert.equal(editEv.removed, 1);
  assert.equal(r.res.edits.length, 1);
  assert.ok(r.res.checkpointId, 'checkpoint id');
  assert.ok((await read(page, 'index.html')).includes('<h1>Hello from the agent</h1>'), 'file changed');
  const applied = await page.evaluate(() => window.__xc.applied.at(-1));
  assert.equal(applied?.turnId, r.res.turnId, 'ai:editsApplied emitted');
  const cp = await page.evaluate(async id => { const { idbGet } = await import('/src/core/db.js'); const c = await idbGet('checkpoints', id); return c && { n: c.records.length, path: c.records[0].path }; }, r.res.checkpointId);
  assert.deepEqual(cp, { n: 1, path: 'index.html' }, 'checkpoint stored in IndexedDB');
  const diff = await page.evaluate(([t, e]) => window.__xc.eng.edits.diff(t, e), [r.res.turnId, editEv.id]);
  assert.ok(diff.original.includes('Built in X Coder') && diff.modified.includes('Hello from the agent'));
  const undone = await page.evaluate(t => window.__xc.eng.edits.undo(t), r.res.turnId);
  assert.deepEqual(undone.restored, ['index.html']);
  assert.equal(undone.edits[0].state, 'undone');
  assert.equal(await read(page, 'index.html'), originalIndex, 'undo restores the exact original');

  // --- (3) Edit mode: staged pending edits, keep writes them, conflicts are detected
  const originalCss = await read(page, 'style.css');
  mock.enqueue(body => {
    expect(/# Mode: Edit/.test(body.system), 'edit: Edit mode prompt');
    return 'Proposed changes:\n<write_file path="notes/todo.md">\n# Todo\n\n- ship it\n</write_file>\n<edit_file path="style.css">\n<<<<<<< SEARCH\n  background: #101014;\n=======\n  background: #000;\n>>>>>>> REPLACE\n</edit_file>';
  });
  const before = mock.requests.length;
  r = await turn(page, { prompt: 'Add a todo file and make the background black', mode: 'edit' });
  assert.ok(!r.error, r.error);
  assert.equal(mock.requests.length - before, 1, 'edit mode ends after the edit batch');
  assert.deepEqual(r.res.edits.map(e => [e.path, e.kind, e.state]), [['notes/todo.md', 'create', 'pending'], ['style.css', 'modify', 'pending']]);
  assert.equal(await page.evaluate(() => window.__xc.workspace.fs.exists('notes/todo.md')), false, 'nothing written before keep');
  assert.equal(await read(page, 'style.css'), originalCss);
  const pendDiff = await page.evaluate(([t, e]) => window.__xc.eng.edits.diff(t, e), [r.res.turnId, r.res.edits[1].id]);
  assert.ok(pendDiff.modified.includes('background: #000;') && pendDiff.original.includes('#101014'));
  const kept = await page.evaluate(t => window.__xc.eng.edits.keep(t), r.res.turnId);
  assert.deepEqual(kept.written.sort(), ['notes/todo.md', 'style.css']);
  assert.equal(await read(page, 'notes/todo.md'), '# Todo\n\n- ship it\n');
  assert.ok((await read(page, 'style.css')).includes('background: #000;'));
  // kept Edit-mode edits can still be undone from the checkpoint
  const undo2 = await page.evaluate(t => window.__xc.eng.edits.undo(t), r.res.turnId);
  assert.equal(undo2.errors.length, 0);
  assert.equal(await read(page, 'style.css'), originalCss);
  assert.equal(await page.evaluate(() => window.__xc.workspace.fs.exists('notes/todo.md')), false);
  // conflict: the file changes between staging and keep
  mock.enqueue('Here you go.\n<edit_file path="main.js">\n<<<<<<< SEARCH\nconsole.log(\'Preview connected\');\n=======\nconsole.log(\'Preview ready\');\n>>>>>>> REPLACE\n</edit_file>');
  r = await turn(page, { prompt: 'change the log', mode: 'edit' });
  await page.evaluate(() => window.__xc.workspace.fs.writeText('main.js', window.__read('main.js') + '\n// user edit\n'));
  const conflict = await page.evaluate(t => window.__xc.eng.edits.keep(t), r.res.turnId);
  assert.equal(conflict.written.length, 0);
  assert.match(conflict.errors[0], /changed since the edit was proposed/);

  // --- (4) Image attachment → image_url part + vision:true
  mock.enqueue(body => {
    const user = body.messages.at(-1);
    expect(body.vision === true, 'vision flag');
    expect(Array.isArray(user.content) && user.content.some(p => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')), 'image_url part');
    expect(Array.isArray(user.content) && /<attachment type="image" name="dot.png"\/>/.test(user.content[0].text), 'image attachment listed');
    return 'I see a small red square.';
  });
  r = await turn(page, { prompt: 'What is in this image?', mode: 'ask', attachments: [{ type: 'image', name: 'dot.png', dataUrl: RED_DOT, mime: 'image/png' }] });
  assert.ok(!r.error, r.error);
  assert.equal(r.res.text, 'I see a small red square.');

  // --- (5) Legacy X Coder 5 JSON protocol
  mock.enqueue(JSON.stringify({ message: 'Created the file.', operations: [{ type: 'create_file', path: 'legacy.txt', content: 'legacy ok' }] }));
  mock.enqueue(body => {
    expect(/<tool_result name="write_file" path="legacy.txt" status="ok">\nCreated legacy.txt/.test(lastUserText(body)), 'legacy: write result');
    return JSON.stringify({ message: 'All set — legacy.txt is ready.' });
  });
  r = await turn(page, { prompt: 'create legacy.txt', mode: 'agent' });
  assert.ok(!r.error, r.error);
  assert.equal(await read(page, 'legacy.txt'), 'legacy ok\n');
  assert.equal(r.res.text, 'Created the file.\n\nAll set — legacy.txt is ready.');
  assert.ok(!r.events.filter(e => e.type === 'text').map(e => e.delta).join('').includes('{'), 'raw JSON never streamed');

  // --- (6) Failing SEARCH → precise error → retry succeeds
  await page.evaluate(() => window.__xc.workspace.fs.writeText('app.js', 'function total(items) {\n  let sum = 0;\n  for (const item of items) sum += item.price;\n  return sum;\n}\n'));
  mock.enqueue('<edit_file path="app.js">\n<<<<<<< SEARCH\nfunction total(list) {\n  let s = 0;\n  for (const x of list) s += x.cost;\n=======\nfunction total(items) {\n  let sum = 0;\n  for (const item of items) sum += item.price * item.qty;\n>>>>>>> REPLACE\n</edit_file>');
  mock.enqueue(body => {
    const u = lastUserText(body);
    expect(/<tool_result name="edit_file" path="app.js" status="error">/.test(u), 'retry: error status');
    expect(/not found/.test(u) && /closest match/.test(u) && /1 \| function total\(items\) \{/.test(u), 'retry: closest candidate with line numbers');
    expect(/Some tool calls failed/.test(u), 'retry: failure note');
    return '<edit_file path="app.js">\n<<<<<<< SEARCH\n  for (const item of items) sum += item.price;\n=======\n  for (const item of items) sum += item.price * item.qty;\n>>>>>>> REPLACE\n</edit_file>';
  });
  mock.enqueue('Fixed: totals now include quantities.');
  r = await turn(page, { prompt: 'include quantity in total', mode: 'agent' });
  assert.ok(!r.error, r.error);
  assert.ok((await read(page, 'app.js')).includes('item.price * item.qty'));
  assert.deepEqual(r.res.edits.map(e => e.state), ['failed', 'applied']);

  // --- (7) JSON (non-stream) router replies
  await page.evaluate(() => { window.__xc.providers.providerConfig.stream = false; });
  mock.enqueue(body => { expect(body.stream === false, 'json: stream disabled'); return 'Plain JSON reply works.'; });
  r = await turn(page, { prompt: 'ping', mode: 'ask' });
  await page.evaluate(() => { window.__xc.providers.providerConfig.stream = true; });
  assert.ok(!r.error, r.error);
  assert.equal(r.res.text, 'Plain JSON reply works.');
  assert.equal(r.res.provider, 'Mock Provider');

  // --- (8) History is sent as alternating messages
  mock.enqueue(body => {
    expect(body.messages.length === 3 && body.messages[0].role === 'user' && body.messages[1].role === 'assistant', 'history messages');
    return 'Yes, I remember.';
  });
  r = await turn(page, { prompt: 'Do you remember?', mode: 'ask', history: [{ role: 'user', text: 'My name is Sam.' }, { role: 'assistant', text: 'Nice to meet you, Sam!' }] });
  assert.equal(r.res.text, 'Yes, I remember.');

  // --- (8b) Output cut off inside write_file → the model is asked to resend; loop protection stops no-progress repeats
  mock.enqueue('Writing it.\n<write_file path="long.js">\nconst a = 1;\nconst b =');
  mock.enqueue(body => {
    const u = lastUserText(body);
    expect(/was cut off \(output limit\) while writing "long\.js"/.test(u), 'truncation: continue note');
    return '<write_file path="long.js">\nconst a = 1;\nconst b = 2;\n</write_file>';
  });
  mock.enqueue('long.js is complete.');
  r = await turn(page, { prompt: 'write long.js', mode: 'agent' });
  assert.ok(!r.error, r.error);
  assert.equal(await read(page, 'long.js'), 'const a = 1;\nconst b = 2;\n');
  for (let i = 0; i < 3; i++) mock.enqueue('Let me check again.\n<read_file path="README.md"/>');
  r = await turn(page, { prompt: 'loop', mode: 'agent' });
  assert.ok(!r.error, r.error);
  assert.equal(r.res.rounds, 3);
  assert.match(r.res.stopped, /repeating the same action/);
  assert.match(r.res.text, /> I stopped because I kept repeating/);

  // --- (9) Puter routing: Auto prefers the strongest Puter model and fails over to the router when it is busy
  await page.evaluate(async () => {
    window.__puterCalls = [];
    window.__puterMode = 'fail';
    window.puter = {
      auth: { isSignedIn: () => true },
      ai: {
        listModels: async () => [{ id: 'gpt-5', provider: 'openai' }, { id: 'claude-sonnet-4-5', provider: 'anthropic' }, { id: 'text-embedding-3-small', provider: 'openai' }, { id: 'gemini-2.5-flash', provider: 'google' }],
        chat: async (msgs, opts) => {
          window.__puterCalls.push({ system: msgs[0], opts, n: msgs.length });
          if (window.__puterMode === 'fail') throw new Error('The model is overloaded. Please try again later.');
          return (async function* () { yield { type: 'reasoning', reasoning: 'thinking' }; yield { type: 'text', text: 'Hello ' }; yield { type: 'text', text: 'from Puter.' }; })();
        }
      }
    };
    await window.__xc.eng.catalog.refresh({ force: true });
  });
  const pList = await page.evaluate(() => window.__xc.eng.catalog.list().filter(x => x.source === 'puter').map(x => x.id));
  assert.ok(pList.includes('puter:claude-sonnet-4-5') && pList.includes('puter:gpt-5') && !pList.some(x => x.includes('embedding')), `puter models: ${pList}`);
  const routes = await page.evaluate(() => window.__xc.eng.catalog.resolveRoutes('auto').map(x => x.id));
  assert.equal(routes[0], 'puter:claude-sonnet-4-5', `best model first: ${routes}`);
  assert.equal(routes.at(-1), 'worker:auto');
  mock.enqueue('Router answered after Puter was busy.');
  r = await turn(page, { prompt: 'hello there', mode: 'ask' });
  assert.ok(!r.error, r.error);
  assert.equal(r.res.text, 'Router answered after Puter was busy.');
  assert.ok(r.events.some(e => e.type === 'status' && /Claude is busy — continuing with GPT/.test(e.text)), `failover status: ${r.events.filter(e => e.type === 'status').map(e => e.text)}`);
  // explicit Puter model, reasoning effort, system message first
  await page.evaluate(() => { window.__puterMode = 'ok'; window.__puterCalls = []; });
  r = await turn(page, { prompt: 'hi', mode: 'ask', model: 'puter:gpt-5' });
  assert.ok(!r.error, r.error);
  assert.equal(r.res.text, 'Hello from Puter.');
  assert.ok(r.events.some(e => e.type === 'reasoning'));
  const call = await page.evaluate(() => window.__puterCalls[0]);
  assert.equal(call.opts.model, 'gpt-5'); assert.equal(call.opts.stream, true); assert.equal(call.opts.reasoning_effort, 'high');
  assert.equal(call.system.role, 'system');
  await page.evaluate(async () => { delete window.puter; await window.__xc.eng.catalog.refresh({ force: true }); });

  // --- (10) Protected paths are refused; Ask mode refuses edits
  mock.enqueue('<read_file path=".env"/>\n<write_file path="x.txt">x</write_file>');
  mock.enqueue(body => {
    const u = lastUserText(body);
    expect(/Access to ".env" is blocked/.test(u), 'protected .env');
    expect(/Edits are disabled in Ask mode/.test(u), 'ask mode refuses edits');
    return 'Understood.';
  });
  r = await turn(page, { prompt: 'read env', mode: 'ask' });
  assert.equal(r.res.text, 'Understood.');
  assert.equal(await page.evaluate(() => window.__xc.workspace.fs.exists('x.txt')), false);

  // --- (12) Agent auto-check: a syntax error + a missing referenced file are fed back after the final answer
  mock.enqueue('<write_file path="calc.js">\nexport function add(a, b) {\n  return a + b;\n\n</write_file>\n<edit_file path="index.html">\n<<<<<<< SEARCH\n  <script src="main.js"></script>\n=======\n  <script src="main.js"></script>\n  <script type="module" src="widgets/chart.js"></script>\n>>>>>>> REPLACE\n</edit_file>');
  mock.enqueue(body => {
    const u = lastUserText(body);
    expect(/JavaScript syntax error/.test(u), 'agent: immediate syntax warning after write_file');
    return 'Added the calculator module and the chart widget.';
  });
  mock.enqueue(body => {
    const u = lastUserText(body);
    expect(/<tool_result name="auto_check" status="error">/.test(u), 'auto-check: result block');
    expect(/calc\.js: JavaScript syntax error/.test(u), 'auto-check: syntax problem');
    expect(/index\.html:\d+: references "widgets\/chart\.js", but widgets\/chart\.js does not exist/.test(u), 'auto-check: missing reference');
    return '<write_file path="calc.js">\nexport function add(a, b) {\n  return a + b;\n}\n</write_file>\n<write_file path="widgets/chart.js">\nexport const chart = true;\n</write_file>';
  });
  mock.enqueue('Fixed the syntax error and created widgets/chart.js.');
  r = await turn(page, { prompt: 'add a calculator module and a chart widget', mode: 'agent' });
  assert.ok(!r.error, r.error);
  assert.equal(r.res.rounds, 4, `auto-check rounds (${r.res.rounds})`);
  const checks = r.events.filter(e => e.type === 'tool' && e.name === 'auto_check');
  assert.ok(checks.some(e => e.state === 'error' && /2 problems/.test(e.detail)), `auto-check error event: ${JSON.stringify(checks)}`);
  assert.ok(checks.some(e => e.state === 'done' && /No problems/.test(e.detail)), 'second auto-check passes');
  assert.equal(await read(page, 'calc.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  assert.match(r.res.text, /Fixed the syntax error/);
  await page.evaluate(t => window.__xc.eng.edits.undo(t), r.res.turnId);
  assert.equal(await page.evaluate(() => window.__xc.workspace.fs.exists('calc.js')), false, 'auto-check turn undone');
  assert.equal(await page.evaluate(() => window.__xc.workspace.fs.exists('widgets')), false, 'folders created by the turn are removed by undo');

  // --- (13) Edit mode: a failed block is sent back once; the retry is staged next to the good edit
  mock.enqueue('<edit_file path="style.css">\n<<<<<<< SEARCH\n  background: #101014;\n=======\n  background: #222;\n>>>>>>> REPLACE\n</edit_file>\n<edit_file path="main.js">\n<<<<<<< SEARCH\nconsole.log("this line does not exist anywhere");\n=======\nconsole.log("x");\n>>>>>>> REPLACE\n</edit_file>');
  mock.enqueue(body => {
    const u = lastUserText(body);
    expect(/<tool_result name="edit_file" path="style.css" status="ok">\nStaged edit of style.css/.test(u), 'edit retry: good edit staged');
    expect(/<tool_result name="edit_file" path="main.js" status="error">/.test(u), 'edit retry: failed edit reported');
    expect(/Resend corrected versions of ONLY the failed edits/.test(u), 'edit retry: note');
    return 'Corrected:\n<edit_file path="main.js">\n<<<<<<< SEARCH\nconsole.log(\'Preview connected\');\n=======\nconsole.log(\'Preview ready\');\n>>>>>>> REPLACE\n</edit_file>';
  });
  const beforeRetry = mock.requests.length;
  r = await turn(page, { prompt: 'darker background and a new log line', mode: 'edit' });
  assert.ok(!r.error, r.error);
  assert.equal(mock.requests.length - beforeRetry, 2, 'edit mode: one retry round');
  assert.deepEqual(r.res.edits.map(e => [e.path, e.state]), [['style.css', 'pending'], ['main.js', 'failed'], ['main.js', 'pending']]);
  await page.evaluate(t => window.__xc.eng.edits.undo(t), r.res.turnId);

  // --- (14) Agent mode: a pasted code dump for a change request is applied instead
  mock.enqueue('Here is the file:\n```js\n// greet.js\nexport function greet(name) {\n  const n = String(name || "world");\n  const msg = `Hello, ${n}!`;\n  console.log(msg);\n  return msg;\n}\nexport default greet;\n```');
  mock.enqueue(body => {
    expect(/did not apply it/.test(lastUserText(body)), 'nudge: unapplied code note');
    return '<write_file path="greet.js">\nexport function greet(name) {\n  return `Hello, ${name}!`;\n}\n</write_file>';
  });
  mock.enqueue('Created greet.js.');
  r = await turn(page, { prompt: 'create a greet.js module that greets someone', mode: 'agent' });
  assert.ok(!r.error, r.error);
  assert.ok(await page.evaluate(() => window.__xc.workspace.fs.exists('greet.js')), 'nudge: file applied');
  await page.evaluate(t => window.__xc.eng.edits.undo(t), r.res.turnId);

  // --- (15) Long agent runs stay under the router's message limit; project profile + reference checker
  const capped = await page.evaluate(async () => {
    const { fitMessages } = await import('/src/ai/agent.js');
    const msgs = [{ role: 'user', content: 'old question', kind: 'history' }, { role: 'assistant', content: 'old answer', kind: 'history' },
      { role: 'user', content: '<environment>\nx\n</environment>\n\n<user_request>\ndo it\n</user_request>', kind: 'env' }];
    for (let i = 0; i < 40; i++) {
      msgs.push({ role: 'assistant', content: `<read_file path="f${i}.js"/>`, kind: 'assistant' });
      msgs.push({ role: 'user', content: `<tool_result name="read_file" path="f${i}.js" status="ok">\nbody ${i}\n</tool_result>`, kind: 'results' });
    }
    const out = fitMessages(msgs, 1e6);
    const alternates = out.every((m, i) => m.role === (i % 2 ? 'assistant' : 'user'));
    return { n: out.length, first: out[0].content, alternates, last: out.at(-1).content };
  });
  assert.ok(capped.n <= 44, `message cap (${capped.n})`);
  assert.ok(capped.alternates, 'roles alternate after the cap');
  assert.match(capped.first, /<user_request>\ndo it\n<\/user_request>\n\n<earlier_steps>\n\d+ earlier round\(s\)[\s\S]*read_file f0\.js \(ok\)/);
  assert.match(capped.last, /f39\.js/);
  const profile = await page.evaluate(async () => {
    const { projectProfile } = await import('/src/ai/context.js');
    const { missingReferences } = await import('/src/ai/engine-verify.js');
    const fs = window.__xc.workspace.fs;
    return {
      profile: projectProfile(fs),
      refs: missingReferences(fs, 'index.html', '<link rel="stylesheet" href="style.css">\n<!-- <script src="gone.js"></script> -->\n<script src="https://cdn.x/y.js"></script>\n<img src="img/missing.png">\n<script type="module">import { a } from "./lib/a.js"; import b from "lodash";</script>')
    };
  });
  assert.ok(profile.profile.some(l => /^Stack: .*JavaScript/.test(l)), `profile: ${profile.profile}`);
  assert.ok(profile.profile.some(l => /^Entry points: .*index\.html/.test(l)), `entry points: ${profile.profile}`);
  assert.deepEqual(profile.refs.map(x => x.ref), ['img/missing.png', './lib/a.js']);

  // --- (11) Cancelling aborts immediately
  mock.enqueue(async () => { await new Promise(res => setTimeout(res, 1500)); return 'too late'; });
  const aborted = await page.evaluate(async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 200);
    const t0 = performance.now();
    try { await window.__xc.eng.runTurn({ prompt: 'slow', mode: 'ask', signal: ctrl.signal, onEvent() {} }); return { ok: true }; }
    catch (err) { return { name: err.name, ms: performance.now() - t0 }; }
  });
  assert.equal(aborted.name, 'AbortError');
  assert.ok(aborted.ms < 1200, `aborted quickly (${aborted.ms} ms)`);

  if (problems.length) throw new Error(`Request assertions failed:\n- ${problems.join('\n- ')}`);
}

let t;
try {
  t = await launch({ device: 'iPhone 13' });
  const { page } = t;
  await setup(t);
  await engineScenarios(t);
  await page.waitForTimeout(1600); // let the aborted request settle on the mock server

  // --- commands
  const summary = await t.commandResult('xcoder.ai.testProviders', { silent: true });
  assert.equal(summary.worker, 'ready');
  assert.equal(summary.providers.find(p => p.id === 'mock')?.status, 'ready');
  const cfg = await t.commandResult('xcoder.ai.configureRouter', `${t.origin}/mock-worker/`);
  assert.deepEqual(cfg, { url: `${t.origin}/mock-worker`, ok: true });
  const models = await t.commandResult('xcoder.ai.refreshModels');
  assert.equal(models.worker, 2);
  // an agent edit, then "Undo Last AI Edits"
  t.mock.enqueue('<write_file path="main.js">\nconsole.log(\'replaced\');\n</write_file>');
  t.mock.enqueue('Replaced main.js.');
  const mainBefore = await read(page, 'main.js');
  const rr = await turn(page, { prompt: 'replace main.js', mode: 'agent' });
  assert.ok(!rr.error, rr.error);
  assert.equal(await read(page, 'main.js'), "console.log('replaced');\n");
  const undoRes = await t.commandResult('xcoder.ai.undoLastEdits', { confirm: false });
  assert.deepEqual(undoRes.restored, ['main.js']);
  assert.equal(await read(page, 'main.js'), mainBefore);

  // --- create_project: a new project is created, later edits go there, and undo works per project
  const firstProject = await page.evaluate(() => window.__xc.workspace.id);
  t.mock.enqueue('Creating a separate app.\n<create_project name="Todo App" template="blank"/>\n<write_file path="index.html">\n<!doctype html>\n<title>Todo</title>\n<h1>Todo</h1>\n</write_file>');
  t.mock.enqueue(body => { assert.match(lastUserText(body), /Created the project "Todo App"/); return 'Your Todo App project is ready.'; });
  const cp = await turn(page, { prompt: 'build a todo app as a new project', mode: 'agent' });
  assert.ok(!cp.error, cp.error);
  assert.ok(cp.events.some(e => e.type === 'project' && e.name === 'Todo App'), 'project event');
  const proj = await page.evaluate(() => ({ id: window.__xc.workspace.id, name: window.__xc.workspace.project.name, files: window.__xc.workspace.fs.files().map(f => f.path).sort() }));
  assert.notEqual(proj.id, firstProject);
  assert.equal(proj.name, 'Todo App');
  assert.deepEqual(proj.files, ['README.md', 'index.html']);
  assert.equal(cp.res.edits[0].projectId, proj.id);
  const cpUndo = await page.evaluate(t => window.__xc.eng.edits.undo(t), cp.res.turnId);
  assert.deepEqual(cpUndo.restored, ['index.html']);
  assert.equal(await page.evaluate(() => window.__xc.workspace.fs.exists('index.html')), false);

  // --- visual checks on the iPhone: provider summary quick pick, output channel, settings
  await t.command('xcoder.ai.testProviders');
  await page.waitForSelector('#quick-input-widget:not(.hidden) .quick-input-list', { timeout: 10000 });
  await page.waitForTimeout(300);
  const qpText = await page.textContent('#quick-input-widget');
  assert.ok(/Router/.test(qpText) && /Mock Provider/.test(qpText) && /Puter AI/.test(qpText), 'provider quick pick content');
  await t.shot('engine-providers-iphone');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.evaluate(async () => (await import('/src/ai/agent.js')).aiLog.show());
  await page.waitForTimeout(500);
  await t.shot('engine-output-iphone');
  await t.command('workbench.action.openSettings', 'xcoder.ai');
  await page.waitForTimeout(800);
  await t.shot('engine-settings-iphone');
  // Configure Router input box (validation message for an http:// URL)
  await t.command('xcoder.ai.configureRouter');
  await page.waitForSelector('#quick-input-widget:not(.hidden) input', { timeout: 5000 });
  await page.fill('#quick-input-widget input', 'http://example.com/router');
  await page.waitForTimeout(300);
  const qiText = await page.textContent('#quick-input-widget');
  assert.match(qiText, /must use https/, 'router URL validation shown');
  await t.shot('engine-configure-router-iphone');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  // Undo Last AI Edits asks for confirmation and lists the files
  t.mock.enqueue('<write_file path="notes.md">\n# Notes\n</write_file>');
  t.mock.enqueue('Added notes.md.');
  assert.ok(!(await turn(page, { prompt: 'add notes', mode: 'agent' })).error);
  await t.command('xcoder.ai.undoLastEdits');
  await page.waitForTimeout(500);
  const dialogText = await page.evaluate(() => document.body.innerText);
  assert.match(dialogText, /Undo the last X Coder AI edits\?/, 'undo confirmation dialog');
  assert.match(dialogText, /notes\.md/, 'undo dialog lists the file');
  await t.shot('engine-undo-confirm-iphone');
  const undoBtn = page.getByRole('button', { name: 'Undo Edits' });
  await undoBtn.click();
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__xc.workspace.fs.exists('notes.md')), false, 'undo via the dialog');
  await t.shot('engine-undo-done-iphone');
  // edits.diff feeds the diff editor (what the chat UI opens for "View changes")
  await page.evaluate(() => window.__xc.workspace.fs.writeText('app.css', 'body {\n  margin: 0;\n  color: #333;\n}\n'));
  t.mock.enqueue('<edit_file path="app.css">\n<<<<<<< SEARCH\n  color: #333;\n=======\n  color: #222;\n  font-family: system-ui, sans-serif;\n>>>>>>> REPLACE\n</edit_file>');
  t.mock.enqueue('Updated the body text style.');
  const dt = await turn(page, { prompt: 'darker text and system font', mode: 'agent' });
  assert.ok(!dt.error, dt.error);
  await page.evaluate(async ([tid, eid]) => {
    const d = await window.__xc.eng.edits.diff(tid, eid);
    const { editors } = await import('/src/workbench/editors.js');
    await editors.open({ type: 'diff', id: `ai:${eid}`, title: d.title, path: d.path, original: d.original, modified: d.modified, readOnly: true }, { pinned: true });
  }, [dt.res.turnId, dt.res.edits[0].id]);
  await page.waitForTimeout(700);
  const diffText = await page.evaluate(() => document.querySelector('.editor-group, #editor-part, main')?.innerText || document.body.innerText);
  assert.match(diffText, /font-family: system-ui/, 'diff editor shows the AI change');
  await t.shot('engine-diff-iphone');

  t.assertNoErrors();
  await t.close();

  // --- desktop: a full agent turn
  t = await launch({ device: 'Desktop Chrome', viewport: { width: 1280, height: 800 } });
  await setup(t);
  t.mock.enqueue('<read_file path="style.css"/>');
  t.mock.enqueue('<edit_file path="style.css">\n<<<<<<< SEARCH\n  color: #f4f4f6;\n=======\n  color: #ffffff;\n>>>>>>> REPLACE\n</edit_file>');
  t.mock.enqueue('Text color is now pure white.');
  const d = await turn(t.page, { prompt: 'make the text white', mode: 'agent' });
  assert.ok(!d.error, d.error);
  assert.ok((await read(t.page, 'style.css')).includes('color: #ffffff;'));
  assert.equal(d.res.rounds, 3);
  // unsaved editor text: the agent edits what the user sees, and undo brings back exactly that text
  const unsaved = await t.page.evaluate(async () => {
    const { editors } = await import('/src/workbench/editors.js');
    const { codeEditor } = await import('/src/editor/api.js');
    await editors.open({ type: 'file', path: 'main.js' }, { pinned: true });
    await new Promise(r => setTimeout(r, 300));
    codeEditor.getActive()?.insertText('// unsaved note\n');
    await new Promise(r => setTimeout(r, 100));
    return { dirty: codeEditor.isDirty('main.js'), text: codeEditor.getText('main.js') };
  });
  if (unsaved.dirty) {
    t.mock.enqueue("<edit_file path=\"main.js\">\n<<<<<<< SEARCH\n// unsaved note\n=======\n// unsaved note (seen by the AI)\n>>>>>>> REPLACE\n</edit_file>");
    t.mock.enqueue('Updated the note.');
    const u = await turn(t.page, { prompt: 'update the note in main.js', mode: 'agent' });
    assert.ok(!u.error, u.error);
    assert.equal(u.res.edits[0].state, 'applied', 'edit applied against the unsaved editor text');
    await t.page.waitForTimeout(300);
    const ed = await t.page.evaluate(async () => { const { codeEditor } = await import('/src/editor/api.js'); return { dirty: codeEditor.isDirty('main.js'), text: codeEditor.getText('main.js'), disk: window.__read('main.js'), body: document.body.innerText }; });
    assert.equal(ed.dirty, false, 'the editor reloads the AI result (no unsaved-changes conflict)');
    assert.equal(ed.text, ed.disk);
    assert.ok(ed.text.startsWith('// unsaved note (seen by the AI)\n'), 'AI result contains the unsaved text');
    assert.ok(!/was changed on disk while you have unsaved changes/.test(ed.body), 'no conflict notification');
    const rec = await t.page.evaluate(async id => { const { idbGet } = await import('/src/core/db.js'); return (await idbGet('checkpoints', id)).records[0].record.content; }, u.res.checkpointId);
    assert.equal(rec, unsaved.text, 'checkpoint holds the live (unsaved) text');
    await t.page.evaluate(tid => window.__xc.eng.edits.undo(tid), u.res.turnId);
    assert.equal(await read(t.page, 'main.js'), unsaved.text, 'undo restores the text the AI started from');
  } else console.warn('  (editor did not report unsaved changes — unsaved-text scenario skipped)');
  await t.command('xcoder.ai.testProviders');
  await t.page.waitForSelector('#quick-input-widget:not(.hidden) .quick-input-list', { timeout: 10000 });
  await t.page.waitForTimeout(300);
  await t.shot('engine-providers-desktop');
  t.assertNoErrors();
  await t.close();
  console.log('ai-engine tests passed');
} catch (err) {
  console.error(err);
  await t?.close().catch(() => {});
  process.exit(1);
}
