// Pure Node unit tests for the X Coder agent protocol parser, SEARCH/REPLACE matcher, helpers, built-in shell
// and the router client (SSE/JSON parsing against a local HTTP server).
// Run: node tools/test/ai-protocol.test.mjs
import assert from 'node:assert/strict';
import { parseAgentOutput, createStreamFilter, parseEditBlocks, formatToolResult, callSignature, parseLegacyJSON } from '../../src/ai/protocol.js';
import { applyBlocks, applyBlock, lineDiffStats, compileIgnore, globToRegExp, findPlaceholder, includeMatcher, detectEol } from '../../src/ai/engine-match.js';
import { runShell } from '../../src/ai/engine-shell.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.stack?.split('\n').slice(0, 4).join('\n    ')}`); }
}
const names = r => r.calls.map(c => c.name);

/** Streams `raw` through the filter in chunks; asserts no raw tag ever leaks and the result equals the final text. */
function streamCheck(raw, chunk = 3) {
  const f = createStreamFilter({ minInterval: 0 });
  let shown = '';
  for (let i = 0; i < raw.length; i += chunk) {
    const d = f.push(raw.slice(i, i + chunk));
    assert.ok(!/<(read_file|write_file|edit_file|list_files|search_files|get_problems|run_preview|delete_file)\b/.test(d), `leaked a tool tag: ${JSON.stringify(d)}`);
    assert.ok(!/<\/?(r|re|rea|read|write|wr|edi|edit)$/.test(d), `leaked a partial tag: ${JSON.stringify(d)}`);
    shown += d;
  }
  const fin = f.finish();
  shown += fin.delta;
  assert.equal(shown, fin.result.text, 'streamed text must equal the final visible text');
  return fin.result;
}

console.log('protocol');
test('self-closing tags with double, single and unquoted attributes', () => {
  const r = parseAgentOutput(`Let me look.\n<read_file path="src/app.js" start_line="10" end_line="20"/>\n<list_files path='src' depth=2 />\n<get_problems/>`);
  assert.deepEqual(names(r), ['read_file', 'list_files', 'get_problems']);
  assert.deepEqual(r.calls[0].attrs, { path: 'src/app.js', start_line: '10', end_line: '20' });
  assert.deepEqual(r.calls[1].attrs, { path: 'src', depth: '2' });
  assert.equal(r.text, 'Let me look.');
  assert.equal(r.truncated, false);
});
test('attribute order, aliases and entity decoding', () => {
  const r = parseAgentOutput(`<create_file file="a.txt">hi</create_file><search_files include="*.js" pattern="a &quot;b&quot; &lt;c&gt;"/><rename_file to="b.js" path="a.js"/>`);
  assert.deepEqual(names(r), ['write_file', 'search_files', 'rename_file']);
  assert.equal(r.calls[0].attrs.path, 'a.txt');
  assert.equal(r.calls[0].body, 'hi');
  assert.equal(r.calls[1].attrs.query, 'a "b" <c>');
  assert.deepEqual(r.calls[2].attrs, { to: 'b.js', from: 'a.js' });
});
test('tags inside fenced code blocks are ignored; fences with only tool tags run', () => {
  const r = parseAgentOutput('Example:\n```xml\n<read_file path="x.js"/>\nand prose\n```\nReal:\n```xml\n<read_file path="y.js"/>\n```\n');
  assert.deepEqual(r.calls.map(c => c.attrs.path), ['y.js']);
  assert.ok(r.text.includes('<read_file path="x.js"/>'), 'example stays visible');
  assert.ok(!r.text.includes('y.js'), 'executed fence is hidden');
});
test('inline code mentioning a tag is not a call', () => {
  const r = parseAgentOutput('Use `<read_file path="a"/>` to read.');
  assert.equal(r.calls.length, 0);
});
test('write_file body wrapped in a single code fence is unwrapped', () => {
  const r = parseAgentOutput('<write_file path="main.js">\n```javascript\nconsole.log(1);\n```\n</write_file>');
  assert.equal(r.calls[0].body, 'console.log(1);');
});
test('write_file body keeps inner fences of a markdown file', () => {
  const r = parseAgentOutput('<write_file path="README.md">\n# Title\n\n```js\nx()\n```\n\nMore.\n</write_file>');
  assert.equal(r.calls[0].body, '# Title\n\n```js\nx()\n```\n\nMore.');
});
test('CRLF output is normalized', () => {
  const r = parseAgentOutput('Hi\r\n<write_file path="a.txt">\r\nline1\r\nline2\r\n</write_file>\r\nDone');
  assert.equal(r.calls[0].body, 'line1\nline2');
  assert.equal(r.text, 'Hi\n\nDone');
});
test('edit_file with multiple SEARCH/REPLACE blocks', () => {
  const r = parseAgentOutput(`<edit_file path="app.js">
<<<<<<< SEARCH
const a = 1;
=======
const a = 2;
>>>>>>> REPLACE
<<<<<<< SEARCH
function f() {
  return a;
}
=======
function f() {
  return a * 2;
}
>>>>>>> REPLACE
</edit_file>`);
  const c = r.calls[0];
  assert.equal(c.name, 'edit_file');
  assert.equal(c.blocks.length, 2);
  assert.deepEqual(c.blocks[0], { search: 'const a = 1;', replace: 'const a = 2;' });
  assert.equal(c.blocks[1].replace, 'function f() {\n  return a * 2;\n}');
  assert.deepEqual(c.blockErrors, []);
});
test('edit_file with an empty REPLACE (deletion)', () => {
  const r = parseAgentOutput('<edit_file path="a.js">\n<<<<<<< SEARCH\nconsole.log(1);\n=======\n>>>>>>> REPLACE\n</edit_file>');
  assert.deepEqual(r.calls[0].blocks, [{ search: 'console.log(1);', replace: '' }]);
});
test('unclosed write_file at the end marks the reply as truncated', () => {
  const r = parseAgentOutput('Creating it.\n<read_file path="a.js"/>\n<write_file path="big.js">\nconst x = 1;\nconst y =');
  assert.equal(r.truncated, true);
  assert.deepEqual(names(r), ['read_file']);
  assert.equal(r.truncatedCall.name, 'write_file');
  assert.equal(r.truncatedCall.attrs.path, 'big.js');
  assert.equal(r.text, 'Creating it.');
});
test('non-body tool with a closing tag uses the body as its primary argument', () => {
  const r = parseAgentOutput('<run_command>ls -la src</run_command>\n<get_problems></get_problems>\n<fetch_url>https://example.com</fetch_url>');
  assert.deepEqual(names(r), ['run_command', 'get_problems', 'fetch_url']);
  assert.equal(r.calls[0].attrs.command, 'ls -la src');
  assert.equal(r.calls[2].attrs.url, 'https://example.com');
});
test('open tag without closing tag is treated as self-closing', () => {
  const r = parseAgentOutput('<get_problems>\nThen I will fix them.');
  assert.deepEqual(names(r), ['get_problems']);
  assert.equal(r.text, 'Then I will fix them.');
});
test('<think> blocks become reasoning, not visible text', () => {
  const r = parseAgentOutput('<think>plan: read file</think>Answer here.');
  assert.equal(r.reasoning, 'plan: read file');
  assert.equal(r.text, 'Answer here.');
});
test('invented <tool_result> blocks cut off the rest of the reply', () => {
  const r = parseAgentOutput('<read_file path="a.js"/>\n<tool_result name="read_file">fake</tool_result>\n<write_file path="b.js">x</write_file>');
  assert.deepEqual(names(r), ['read_file']);
  assert.equal(r.hallucinated, true);
});
test('stray closing tags are removed from the visible text', () => {
  const r = parseAgentOutput('Hello</read_file> world');
  assert.equal(r.text, 'Hello world');
});
test('legacy X Coder 5 JSON protocol', () => {
  const raw = JSON.stringify({
    message: 'Updating the page.',
    requests: [{ tool: 'read_file', path: 'index.html' }, { tool: 'search', query: 'btn' }],
    operations: [
      { type: 'create_file', path: 'a.js', content: 'x\r\ny' },
      { type: 'patch_file', path: 'b.js', changes: [{ find: 'old', replace: 'new' }] },
      { type: 'rename_path', path: 'c.js', to: 'd.js' },
      { type: 'delete_file', path: 'e.js' },
      { type: 'create_folder', path: 'lib' }
    ],
    project_action: { type: 'create_project', name: 'Todo', template: 'web' },
    reasoning_summary: ['Checked files']
  });
  const r = parseAgentOutput('```json\n' + raw + '\n```');
  assert.equal(r.legacy, true);
  assert.equal(r.text, 'Updating the page.');
  assert.deepEqual(names(r), ['create_project', 'read_file', 'search_files', 'write_file', 'edit_file', 'rename_file', 'delete_file', 'create_folder']);
  assert.equal(r.calls[3].body, 'x\ny');
  assert.deepEqual(r.calls[4].blocks, [{ search: 'old', replace: 'new' }]);
  assert.deepEqual(r.calls[5].attrs, { from: 'c.js', to: 'd.js' });
  assert.equal(r.reasoning, 'Checked files');
});
test('forced-JSON reply with tool tags inside the message', () => {
  const r = parseAgentOutput('{"message": "Reading it. <read_file path=\\"index.html\\"/>"}');
  assert.equal(r.legacy, true);
  assert.equal(r.text, 'Reading it.');
  assert.deepEqual(r.calls.map(c => c.attrs.path), ['index.html']);
});
test('plain JSON that is not the legacy protocol stays visible', () => {
  assert.equal(parseLegacyJSON('{"name":"x","version":"1.0.0","dependencies":{}}'), null);
  const r = parseAgentOutput('{"name":"x","version":"1.0.0"}');
  assert.equal(r.legacy, false);
  assert.ok(r.text.includes('"version"'));
});
test('streaming never shows raw tags and ends with the final text', () => {
  const raw = `I'll check the files first.\n<read_file path="index.html"/>\n<list_files path="src"/>\nHere is an example:\n\`\`\`js\nconst a = 1 < 2;\n\`\`\`\n<edit_file path="a.js">\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n</edit_file>\nAll done — a < b and <div> stays.`;
  for (const size of [1, 2, 3, 5, 7, 11, 64]) {
    const r = streamCheck(raw, size);
    assert.deepEqual(names(r), ['read_file', 'list_files', 'edit_file']);
    assert.ok(r.text.endsWith('All done — a < b and <div> stays.'));
  }
});
test('streaming reports the file being written', () => {
  const seen = [];
  const f = createStreamFilter({ minInterval: 0, onPending: p => seen.push(p && `${p.name}:${p.attrs?.path || ''}`) });
  for (const ch of '<write_file path="src/app.js">\nconst a = 1;\n</write_file>\nDone') f.push(ch);
  f.finish();
  assert.ok(seen.includes('write_file:src/app.js'), JSON.stringify(seen));
});
test('streaming holds back legacy JSON until complete', () => {
  const f = createStreamFilter({ minInterval: 0 });
  let shown = '';
  const raw = '{"message":"Hello there","operations":[]}';
  for (const ch of raw) shown += f.push(ch);
  assert.equal(shown, '');
  const fin = f.finish();
  assert.equal(fin.delta, 'Hello there');
});
test('long write_file bodies stream without rescans and the text after the close tag still appears', () => {
  const body = Array.from({ length: 3000 }, (_, i) => `const v${i} = ${i}; // <div> ${i}`).join('\n');
  const raw = `Writing the module.\n<write_file path="big.js">\n${body}\n</write_file>\nThe module is ready.`;
  const t0 = Date.now();
  const r = streamCheck(raw, 17);
  assert.ok(Date.now() - t0 < 4000, `streaming a big body is fast (${Date.now() - t0} ms)`);
  assert.deepEqual(names(r), ['write_file']);
  assert.equal(r.calls[0].body, body);
  assert.equal(r.text, 'Writing the module.\n\nThe module is ready.');
  // the closing tag split across deltas, CRLF output and an alias tag name
  const crlf = streamCheck('A\r\n<create_file path="x.txt">\r\nhello\r\n</create_file>\r\nB', 1);
  assert.deepEqual(names(crlf), ['write_file']);
  assert.equal(crlf.calls[0].body, 'hello');
  assert.equal(crlf.text, 'A\n\nB');
});
test('several edit_file tags in one reply keep their own blocks', () => {
  const r = parseAgentOutput('<edit_file path="a.js">\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n</edit_file>\n<edit_file path="b.js">\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nc\n=======\n>>>>>>> REPLACE\n</edit_file>');
  assert.deepEqual(r.calls.map(c => [c.attrs.path, c.blocks.length]), [['a.js', 1], ['b.js', 2]]);
  assert.deepEqual(r.calls[1].blocks[1], { search: 'c', replace: '' });
});
test('tool-only fences are hidden while streaming', () => {
  const r = streamCheck('Reading:\n```xml\n<read_file path="a.js"/>\n```\nok', 2);
  assert.deepEqual(names(r), ['read_file']);
  assert.equal(r.text, 'Reading:\nok');
});
test('parseEditBlocks tolerates a missing REPLACE marker and reports broken blocks', () => {
  let p = parseEditBlocks('<<<<<<< SEARCH\na\n=======\nb\n');
  assert.deepEqual(p.blocks, [{ search: 'a', replace: 'b' }]);
  p = parseEditBlocks('<<<<<<< SEARCH\na\n>>>>>>> REPLACE');
  assert.equal(p.blocks.length, 0);
  assert.match(p.errors[0], /divider/);
  p = parseEditBlocks('just some text');
  assert.match(p.errors[0], /SEARCH/);
  p = parseEditBlocks('------- SEARCH\na\n=======\nb\n+++++++ REPLACE');
  assert.deepEqual(p.blocks, [{ search: 'a', replace: 'b' }]);
});
test('formatToolResult escapes attributes and nested closing tags; signatures are stable', () => {
  const s = formatToolResult({ name: 'read_file', attrs: { path: 'a"b.js' }, ok: false, content: 'x </tool_result> y' });
  assert.ok(s.startsWith('<tool_result name="read_file" path="a&quot;b.js" status="error">'));
  assert.ok(!s.slice(0, -14).includes('</tool_result>'));
  const a = parseAgentOutput('<read_file path="a" end_line="3"/>').calls[0];
  const b = parseAgentOutput('<read_file end_line="3" path="a"/>').calls[0];
  assert.equal(callSignature(a), callSignature(b));
});

console.log('matcher');
const file = `import { a } from './a.js';

function greet(name) {
  const msg = 'Hello, ' + name;
  console.log(msg);
  return msg;
}

export default greet;
`;
test('exact match', () => {
  const r = applyBlocks(file, [{ search: "  console.log(msg);", replace: "  console.info(msg);" }]);
  assert.equal(r.failed.length, 0);
  assert.equal(r.applied[0].strategy, 'exact');
  assert.ok(r.content.includes('console.info(msg)'));
});
test('CRLF files keep CRLF', () => {
  const crlf = file.replace(/\n/g, '\r\n');
  assert.equal(detectEol(crlf), '\r\n');
  const r = applyBlocks(crlf, [{ search: 'function greet(name) {\n  const msg', replace: 'function greet(name = "you") {\n  const msg' }]);
  assert.equal(r.failed.length, 0);
  assert.ok(r.content.includes('function greet(name = "you") {\r\n'));
  assert.ok(!/[^\r]\n/.test(r.content));
});
test('trailing whitespace differences', () => {
  const r = applyBlocks(file, [{ search: 'function greet(name) {   \n  const msg = \'Hello, \' + name;  ', replace: 'function greet(name) {\n  const msg = `Hi ${name}`;' }]);
  assert.equal(r.failed.length, 0);
  assert.equal(r.applied[0].strategy, 'whitespace');
  assert.ok(r.content.includes('const msg = `Hi ${name}`;'));
});
test('indentation-insensitive match re-indents the replacement', () => {
  const r = applyBlocks(file, [{ search: 'console.log(msg);\nreturn msg;', replace: 'if (msg) {\n  console.log(msg);\n}\nreturn msg;' }]);
  assert.equal(r.failed.length, 0);
  assert.equal(r.applied[0].strategy, 'indentation');
  assert.ok(r.content.includes('  if (msg) {\n    console.log(msg);\n  }\n  return msg;'), r.content);
});
test('fuzzy unique window (≥ 0.9 similar)', () => {
  const r = applyBlocks(file, [{ search: "function greet(name) {\n  const msg = 'Hello, ' + nam;\n  console.log(msg);\n  return msg;\n}", replace: "function greet(name) {\n  return 'Hi ' + name;\n}" }]);
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  assert.equal(r.applied[0].strategy, 'fuzzy');
  assert.ok(r.content.includes("return 'Hi ' + name;"));
  assert.ok(!r.content.includes('console.log'));
});
test('ambiguous SEARCH is rejected with line numbers', () => {
  const r = applyBlocks('a\nx = 1;\nb\nx = 1;\n', [{ search: 'x = 1;', replace: 'x = 2;' }]);
  assert.equal(r.applied.length, 0);
  assert.match(r.failed[0].error, /matches 2 places.*lines 2, 4/);
  assert.equal(r.changed, false);
});
test('missing SEARCH reports the closest candidate with line numbers', () => {
  const r = applyBlocks(file, [{ search: "function greet(person) {\n  const text = 'Hey, ' + person;\n  console.log(text);", replace: 'x' }]);
  assert.equal(r.applied.length, 0);
  const e = r.failed[0].error;
  assert.match(e, /not found/);
  assert.match(e, /lines 3-5/);
  assert.match(e, /\n3 \| function greet\(name\) \{/);
});
test('partial application: good blocks apply, failed ones are reported', () => {
  const r = applyBlocks(file, [
    { search: "import { a } from './a.js';", replace: "import { a, b } from './a.js';" },
    { search: 'does not exist anywhere', replace: 'y' },
    { search: 'export default greet;', replace: 'export { greet };' }
  ]);
  assert.deepEqual(r.applied.map(a => a.index), [0, 2]);
  assert.deepEqual(r.failed.map(f => f.index), [1]);
  assert.ok(r.content.includes('export { greet };'));
});
test('copied line-number prefixes are stripped', () => {
  const r = applyBlocks(file, [{ search: '5 | console.log(msg);\n6 | return msg;', replace: '5 | return msg;' }]);
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  assert.ok(!r.content.includes('console.log'));
  assert.ok(!r.content.includes('5 |'));
});
test('deleting whole lines leaves no blank line', () => {
  const r = applyBlocks('a\nb\nc\n', [{ search: 'b', replace: '' }]);
  assert.equal(r.content, 'a\nc\n');
});
test('empty SEARCH creates content only in an empty file', () => {
  assert.equal(applyBlock('', { search: '', replace: 'hello' }).text, 'hello\n');
  assert.equal(applyBlock('x', { search: '', replace: 'hello' }).ok, false);
});
test('SEARCH with "..." elision is never fuzzy-applied', () => {
  const r = applyBlocks(file, [{ search: "function greet(name) {\n  // ...\n  return msg;\n}", replace: 'x' }]);
  assert.equal(r.applied.length, 0);
  assert.match(r.failed[0].error, /elision/);
});
test('lineDiffStats counts real added/removed lines', () => {
  assert.deepEqual(lineDiffStats('a\nb\nc\n', 'a\nB\nc\nd\n'), { added: 2, removed: 1 });
  assert.deepEqual(lineDiffStats('', 'x\ny\n'), { added: 2, removed: 0 });
  assert.deepEqual(lineDiffStats('same', 'same'), { added: 0, removed: 0 });
});
test('globs and .aiignore', () => {
  const ig = compileIgnore('# secrets\nsecret/\n*.log\n!keep.log\n/build\ndocs/**/*.pdf');
  assert.equal(ig('secret/a.txt'), true);
  assert.equal(ig('x/secret/a.txt'), true);
  assert.equal(ig('err.log'), true);
  assert.equal(ig('keep.log'), false);
  assert.equal(ig('build/app.js'), true);
  assert.equal(ig('src/build/app.js'), false);
  assert.equal(ig('docs/a/b/c.pdf'), true);
  assert.equal(ig('src/app.js'), false);
  assert.ok(globToRegExp('*.{js,ts}').test('src/a.ts'));
  const inc = includeMatcher('*.css, src/**/*.js');
  assert.ok(inc('a/b.css') && inc('src/x/y.js') && !inc('lib/y.js'));
});
test('lazy placeholder detection', () => {
  assert.ok(findPlaceholder('a();\n// ... existing code ...\nb();', 'x.js'));
  assert.ok(findPlaceholder('<div>\n<!-- rest of the page -->\n</div>', 'x.html'));
  assert.ok(findPlaceholder('.a{}\n/* ... */\n', 'x.css'));
  assert.ok(findPlaceholder('x\n...\ny', 'a.js'));
  assert.equal(findPlaceholder('def f():\n    ...\n', 'a.py'), null);
  assert.equal(findPlaceholder('// Loop over the remaining items\nfor (;;) {}', 'a.js'), null);
  assert.equal(findPlaceholder('... rest of the story', 'notes.md'), null);
});

console.log('shell');
const files = new Map([
  ['index.html', '<h1>Hello</h1>\n<script src="main.js"></script>\n'],
  ['main.js', 'console.log("hi");\nconst x = 1;\nconsole.log(x);\n'],
  ['src/util.js', 'export const add = (a, b) => a + b;\n'],
  ['.env', 'SECRET=1\n']
]);
const fakeFs = {
  entries() { const out = [{ path: 'src', type: 'folder' }]; for (const p of files.keys()) out.push({ path: p, type: 'file', content: files.get(p) }); return out.sort((a, b) => a.path.localeCompare(b.path)); },
  files() { return this.entries().filter(r => r.type === 'file'); },
  list(dir) { return this.entries().filter(r => (r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : '') === dir).sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'folder' ? -1 : 1)); },
  isFile: p => files.has(p), isFolder: p => p === 'src', exists: p => files.has(p) || p === 'src',
  peekText: p => files.get(p) ?? null, size: p => (files.get(p) || '').length
};
const sh = cmd => runShell(cmd, { fs: fakeFs, isDenied: p => p === '.env' });
test('ls, cat, head, wc', () => {
  assert.equal(sh('ls').output, 'src/\nindex.html\nmain.js');
  assert.equal(sh('cat src/util.js').output, 'export const add = (a, b) => a + b;\n');
  assert.equal(sh('head -n 1 main.js').output, 'console.log("hi");');
  assert.equal(sh('head -1 main.js').output, 'console.log("hi");');
  assert.match(sh('wc -l main.js').output, /3 main\.js/);
});
test('grep -rn, pipes and chains', () => {
  assert.equal(sh('grep -rn console').output, 'main.js:1:console.log("hi");\nmain.js:3:console.log(x);');
  assert.equal(sh('cat main.js | grep console | wc -l').output.trim(), '2');
  assert.equal(sh('pwd && echo ok').output, '/ (project root)\nok');
  assert.equal(sh('find . -name "*.js"').output, './main.js\n./src/util.js');
});
test('protected paths, side effects and scripts', () => {
  assert.equal(sh('cat .env').ok, false);
  assert.match(sh('rm -rf src').output, /read-only/);
  assert.match(sh('npm install three').output, /not available/);
  assert.match(sh('echo x > a.txt').output, /Redirection/);
  assert.deepEqual(sh('node main.js --flag').runScript, { path: 'main.js', args: ['--flag'] });
});

// ---- providers: the X Coder router client against a local HTTP server (SSE edge cases, JSON, errors) ----
console.log('providers');
const { callWorker, fitWorkerBody, isTransientError } = await import('../../src/ai/providers.js');
const { createServer } = await import('node:http');
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.stack?.split('\n').slice(0, 4).join('\n    ')}`); }
}
const routes = new Map();
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const handler = routes.get(req.url);
  if (!handler) { res.writeHead(404).end('{"error":"not found"}'); return; }
  await handler(req, res, JSON.parse(Buffer.concat(chunks).toString() || '{}'));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const writeSplit = async (res, text, size) => { for (let i = 0; i < text.length; i += size) { res.write(text.slice(i, i + size)); await sleep(1); } };
let route = 0;
const serve = handler => { const path = `/r${++route}`; routes.set(`${path}/agent`, handler); return `${base}${path}`; };
try {
  await atest('SSE split mid-line with CRLF, keep-alives, multi-line data and usage', async () => {
    const url = serve(async (req, res, body) => {
      assert.equal(body.stream, true); assert.equal(body.allow_fallback, true); assert.equal(body.system, 'SYS');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        ': keep-alive', '',
        `data: ${JSON.stringify({ type: 'start', provider: 'Groq', providerId: 'groq', model: 'llama' })}`, '',
        `data: ${JSON.stringify({ type: 'delta', text: 'Hel' })}`, '',
        `data: ${JSON.stringify({ type: 'delta', text: 'lo <read_file path="a.js"/>' })}`, '',
        'data: {"type":"delta",', 'data: "text":" world"}', '',
        `data: ${JSON.stringify({ type: 'done', usage: { prompt_tokens: 7, completion_tokens: 3 }, finish_reason: 'stop', attempts: [{ provider: 'groq', ok: true }] })}`, ''
      ].join('\r\n') + '\r\n';
      await writeSplit(res, events, 7);
      res.end();
    });
    const deltas = [], metas = [];
    const r = await callWorker({ routerUrl: url, system: 'SYS', messages: [{ role: 'user', content: 'hi' }], onDelta: d => deltas.push(d), onMeta: m => metas.push(m) });
    assert.equal(r.text, 'Hello <read_file path="a.js"/> world');
    assert.equal(deltas.join(''), r.text);
    assert.equal(r.provider, 'Groq'); assert.equal(r.model, 'llama'); assert.equal(r.finishReason, 'stop');
    assert.deepEqual(r.usage, { prompt_tokens: 7, completion_tokens: 3 });
    assert.ok(metas.some(m => m.provider === 'Groq'));
  });
  await atest('OpenAI-style SSE chunks and [DONE]', async () => {
    const url = serve(async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      await writeSplit(res, `data: ${JSON.stringify({ choices: [{ delta: { content: 'A' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: 'B' }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`, 5);
      res.end();
    });
    const r = await callWorker({ routerUrl: url, system: '', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.text, 'AB'); assert.equal(r.finishReason, 'length');
  });
  await atest('error event before any text is transient; after text it is not', async () => {
    const early = serve(async (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ type: 'error', error: 'Model is overloaded', status: 503 })}\n\n`); });
    await assert.rejects(callWorker({ routerUrl: early, messages: [{ role: 'user', content: 'x' }] }), e => e.transient === true && /overloaded/.test(e.message) && isTransientError(e));
    const late = serve(async (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: {"type":"delta","text":"partial"}\n\ndata: {"type":"error","error":"bad request"}\n\n`); });
    await assert.rejects(callWorker({ routerUrl: late, messages: [{ role: 'user', content: 'x' }] }), e => e.streamed === true && e.transient === false);
  });
  await atest('plain JSON replies (older routers) and HTTP errors with attempts', async () => {
    const json = serve(async (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: 'hi there', provider: 'Gemini', providerId: 'gemini', model: 'g', stop_reason: 'MAX_TOKENS' })); });
    const deltas = [];
    const r = await callWorker({ routerUrl: json, messages: [{ role: 'user', content: 'x' }], onDelta: d => deltas.push(d) });
    assert.equal(r.text, 'hi there'); assert.equal(r.finishReason, 'MAX_TOKENS'); assert.deepEqual(deltas, ['hi there']);
    const busy = serve(async (req, res) => { res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Too many requests', attempts: [{ provider: 'groq', ok: false }] })); });
    await assert.rejects(callWorker({ routerUrl: busy, messages: [{ role: 'user', content: 'x' }] }), e => e.status === 429 && e.transient && e.attempts.length === 1);
    await assert.rejects(callWorker({ routerUrl: '', messages: [{ role: 'user', content: 'x' }] }), /router URL is not set/);
  });
  await atest('abort cancels a stalled stream immediately; the idle timeout fails over', async () => {
    const stall = serve(async (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"type":"delta","text":"a"}\n\n'); await sleep(3000); res.end(); });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const t0 = Date.now();
    await assert.rejects(callWorker({ routerUrl: stall, messages: [{ role: 'user', content: 'x' }], signal: ctrl.signal }), e => e.name === 'AbortError');
    assert.ok(Date.now() - t0 < 1000);
    await assert.rejects(callWorker({ routerUrl: stall, messages: [{ role: 'user', content: 'x' }], timeoutMs: 300 }), e => /stalled/.test(e.message) && e.status === 504);
  });
  await atest('images are dropped oldest-first when the body would exceed the router limit', async () => {
    const img = `data:image/png;base64,${'A'.repeat(800000)}`;
    const body = { system: '', messages: [
      { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'image_url', image_url: { url: img } }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: 'second' }, { type: 'image_url', image_url: { url: img } }, { type: 'image_url', image_url: { url: img } }] }
    ] };
    const json = fitWorkerBody(body);
    assert.ok(json.length < 1_900_000);
    assert.ok(!JSON.stringify(body.messages[0]).includes('image_url'), 'oldest image removed');
    assert.equal(body.messages[2].content.filter(p => p.type === 'image_url').length, 2, 'newest images kept');
  });
} finally { server.close(); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
