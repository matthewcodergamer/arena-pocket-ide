// Welcome page — the classic VS Code / code-server Welcome editor (Start · Recent · Help ·
// Customize · Learn), plus the pages it links to: Interface Overview (overlay), Interactive
// Playground (live CodeMirror examples) and the printable Keyboard Shortcuts Reference.

import { h, clear, codicon, relativeTime, isApple } from '../core/dom.js';
import { bus } from '../core/events.js';
import { commands, keybindingLabel } from '../core/commands.js';
import { settings } from '../core/settings.js';
import { workspace } from '../core/workspace.js';
import { notify } from '../platform/notifications.js';
import { editors } from '../workbench/editors.js';
import { layout } from '../workbench/layout.js';

const REPO = 'https://github.com/matthewcodergamer/arena-pocket-ide';
const VERSION = () => document.documentElement.dataset.xcoderVersion || '6.0.0';
const APP_ICON = '<img class="welcome-tab-icon" src="./icons/app-icon.svg" alt="" width="16" height="16" draggable="false">';

function run(id, ...args) {
  if (!commands.has(id)) { notify.info(`"${id}" is not available yet.`); return; }
  commands.execute(id, ...args).catch(err => notify.error(err?.message || String(err)));
}
function openUrl(url) { window.open(url, '_blank', 'noopener'); }
function link(label, action, extra = null) {
  const a = h('a', { href: '#', role: 'button' }, label);
  a.addEventListener('click', e => { e.preventDefault(); action(); });
  return extra ? [a, extra] : a;
}
function cmdLink(label, id, ...args) { return link(label, () => run(id, ...args)); }
function kb(id) { const l = commands.keybindingLabel(id); return l ? `(${l})` : ''; }

// ---------------------------------------------------------------- Welcome editor

function createWelcome(input, container) {
  const root = h('div', { class: 'welcomePageContainer scroll-region', tabindex: '-1' });
  container.append(root);
  const disposers = [];

  let renderToken = 0;
  async function render() {
    const my = ++renderToken;
    const projects = await workspace.listProjects().catch(() => []);
    if (my !== renderToken) return; // a newer render started while we were loading
    const others = projects.filter(p => p.id !== workspace.id);
    const recent = (others.length ? others : projects).slice(0, 5);

    const recentList = h('ul', { class: 'list' },
      ...recent.map(p => h('li', {},
        link(p.name, () => workspace.openProject(p.id).catch(err => notify.error(err.message))),
        h('span', { class: 'path detail', title: p.lastOpenedAt ? `Opened ${relativeTime(p.lastOpenedAt)}` : '' }, p.git?.repo ? `github.com/${p.git.repo.split('/')[0]}` : '~/projects'))),
      h('li', { class: 'moreRecent' }, cmdLink('More...', 'workbench.action.openRecent'), h('span', { class: 'path detail' }, kb('workbench.action.openRecent'))));

    const showOnStartup = h('input', { type: 'checkbox', id: 'welcomeShowOnStartup', class: 'checkbox xc-checkbox' });
    showOnStartup.checked = settings.get('workbench.startupEditor', 'welcomePage') === 'welcomePage';
    showOnStartup.addEventListener('change', () => settings.set('workbench.startupEditor', showOnStartup.checked ? 'welcomePage' : 'none'));

    const tile = (cls, title, detail, action) => {
      const b = h('button', { type: 'button' }, h('h3', { class: 'caption' }, title), h('span', { class: 'detail' }, detail));
      b.addEventListener('click', action);
      return h('div', { class: `item ${cls}` }, b);
    };

    const page = h('div', { class: ['welcomePage', !recent.length && 'emptyRecent'] },
      h('div', { class: 'title' },
        h('h1', { class: 'caption' }, `X Coder v${VERSION()}`),
        h('p', { class: 'subtitle detail' }, 'VS Code for iPhone')),
      h('div', { class: 'row' },
        h('div', { class: 'splash' },
          h('div', { class: 'section start' },
            h('h2', { class: 'caption' }, 'Start'),
            h('ul', {},
              h('li', {}, cmdLink('New file', 'workbench.action.files.newUntitledFile')),
              h('li', {}, cmdLink('Open folder...', 'workbench.action.openRecent')),
              h('li', {}, cmdLink('Clone repository...', 'git.clone')),
              h('li', {}, cmdLink('Import project...', 'xcoder.files.importZip')))),
          h('div', { class: 'section recent' },
            h('h2', { class: 'caption' }, 'Recent'),
            recentList,
            h('p', { class: 'none detail' }, 'No recent folders')),
          h('div', { class: 'section help xcoder-help' },
            h('h2', { class: 'caption' }, 'X Coder Help'),
            h('ul', {},
              h('li', {}, link('GitHub Repository', () => openUrl(REPO))),
              h('li', {}, link('Release Notes', () => commands.has('update.showCurrentReleaseNotes') ? run('update.showCurrentReleaseNotes') : openUrl(`${REPO}/blob/main/docs/RELEASE_NOTES.md`))),
              h('li', {}, link('Issue Tracker', () => openUrl(`${REPO}/issues`))),
              h('li', {}, link('Install on iPhone', () => commands.has('xcoder.showInstallHelp') ? run('xcoder.showInstallHelp') : showInstallTips())),
              h('li', {}, link('AI Setup Guide', () => openUrl(`${REPO}/blob/main/worker/README.md`))),
              h('li', {}, link('Docs', () => openUrl(`${REPO}#readme`))),
              h('li', {}, link('Discussions', () => openUrl(`${REPO}/discussions`))))),
          h('div', { class: 'section help' },
            h('h2', { class: 'caption' }, 'Help'),
            h('ul', {},
              h('li', {}, cmdLink('Printable keyboard cheatsheet', 'workbench.action.keybindingsReference')),
              h('li', {}, cmdLink('Interface overview', 'welcome.showInterfaceOverview')),
              h('li', {}, cmdLink('Tips and Tricks', 'welcome.showInteractivePlayground')),
              h('li', {}, link('Product documentation', () => openUrl(`${REPO}#readme`))),
              h('li', {}, link('GitHub repository', () => openUrl(REPO))))),
          h('p', { class: 'showOnStartup' }, showOnStartup, ' ', h('label', { class: 'caption', for: 'welcomeShowOnStartup' }, 'Show welcome page on startup'))),
        h('div', { class: 'commands' },
          h('div', { class: 'section customize' },
            h('h2', { class: 'caption' }, 'Customize'),
            h('div', { class: 'list' },
              tile('showLanguageExtensions', 'Tools and languages', 'Enable support for JavaScript, Python, HTML, CSS, Emmet and more', () => run('workbench.view.extensions')),
              tile('showRecommendedKeymapExtensions', 'Settings and keybindings', 'Customize settings and keyboard shortcuts to fit the way you work', () => run('workbench.action.openSettings')),
              tile('selectTheme', 'Color theme', 'Make the editor and your code look the way you love', () => run('workbench.action.selectTheme')))),
          h('div', { class: 'section learn' },
            h('h2', { class: 'caption' }, 'Learn'),
            h('div', { class: 'list' },
              tile('showCommands', 'Find and run all commands', `Rapidly access and search commands from the Command Palette ${kb('workbench.action.showCommands')}`, () => run('workbench.action.showCommands')),
              tile('showInterfaceOverview', 'Interface overview', 'Get a visual overlay highlighting the major components of the UI', () => run('welcome.showInterfaceOverview')),
              tile('showInteractivePlayground', 'Interactive playground', 'Try out essential editor features in a short walkthrough', () => run('welcome.showInteractivePlayground')),
              tile('askAI', 'Ask X Coder AI', 'Build projects, fix bugs, analyze photos and uploaded projects', () => run('workbench.action.chat.open')))))));
    const scrollTop = root.scrollTop;
    clear(root);
    root.append(page);
    root.scrollTop = scrollTop;
  }

  render();
  for (const ev of ['projects:changed', 'project:opened', 'project:renamed']) disposers.push(bus.on(ev, () => render()));
  disposers.push(settings.onChange('workbench.startupEditor', () => { const c = root.querySelector('#welcomeShowOnStartup'); if (c) c.checked = settings.get('workbench.startupEditor') === 'welcomePage'; }));
  return {
    focus: () => root.focus({ preventScroll: true }),
    onShow: () => render(),
    dispose: () => disposers.forEach(d => d())
  };
}

function showInstallTips() {
  import('../platform/dialogs.js').then(({ dialogs }) => dialogs.alert({
    message: 'Install X Coder on your iPhone',
    detail: 'Open X Coder in Safari, tap the Share button, choose "Add to Home Screen", then launch X Coder from your Home Screen for the full-screen VS Code layout.'
  }));
}

// ---------------------------------------------------------------- Interface overview

let overviewEl = null;
function hideInterfaceOverview() {
  overviewEl?.remove(); overviewEl = null;
  document.removeEventListener('keydown', onOverviewKey, true);
}
function onOverviewKey(e) { if (e.key === 'Escape') { e.preventDefault(); hideInterfaceOverview(); } }

function showInterfaceOverview() {
  hideInterfaceOverview();
  const targets = [
    { sel: '#activitybar .menubar-toggle', label: 'Application Menu', side: 'right', offsetY: 40 },
    { sel: '#activitybar [data-container="workbench.view.explorer"]', label: 'Explorer', command: 'workbench.view.explorer', side: 'right' },
    { sel: '#activitybar [data-container="workbench.view.search"]', label: 'Search', command: 'workbench.view.search', side: 'right' },
    { sel: '#activitybar [data-container="workbench.view.scm"]', label: 'Source Control', command: 'workbench.view.scm', side: 'right' },
    { sel: '#activitybar [data-container="workbench.view.debug"]', label: 'Run and Debug', command: 'workbench.view.debug', side: 'right' },
    { sel: '#activitybar [data-container="workbench.view.extensions"]', label: 'Extensions', command: 'workbench.view.extensions', side: 'right' },
    { sel: '#activitybar [data-container="workbench.view.chat"]', label: 'X Coder AI Chat', command: 'workbench.view.chat', side: 'right' },
    { sel: '#activitybar .global .action-item:first-child', label: 'Accounts', side: 'right' },
    { sel: '#activitybar .global .action-item:last-child', label: 'Manage & Settings', command: 'workbench.action.openSettings', side: 'right' },
    { sel: '#tabs-container', label: 'Open editors (tabs)', side: 'below' },
    { sel: '#editor-actions', label: 'Run, preview & more', side: 'below', alignRight: true },
    { sel: '#statusbar [data-id="status.host"]', label: 'Connection & project', side: 'above' },
    { sel: '#statusbar [data-id="status.problems"], #statusbar [data-id="problems"]', label: 'Problems', command: 'workbench.actions.view.problems', side: 'above' },
    { sel: '#statusbar [data-id="status.notifications"]', label: 'Notifications', side: 'above', alignRight: true }
  ];
  overviewEl = h('div', { class: 'welcomeOverlay', role: 'dialog', 'aria-label': 'Interface Overview' });
  const center = h('div', { class: 'welcomeOverlay-center' },
    h('div', { class: 'welcomeOverlay-key' }, 'Command Palette', h('span', { class: 'shortcut' }, keybindingLabel(commands.keybindingFor('workbench.action.showCommands') || 'Mod+Shift+P'))),
    h('div', { class: 'welcomeOverlay-key' }, 'Go to File', h('span', { class: 'shortcut' }, keybindingLabel(commands.keybindingFor('workbench.action.quickOpen') || 'Mod+P'))),
    h('div', { class: 'welcomeOverlay-hint' }, 'Tap anywhere to close'));
  overviewEl.append(center);
  const vw = window.innerWidth, vh = window.innerHeight;
  for (const t of targets) {
    const el = document.querySelector(t.sel);
    if (!el || !el.offsetParent) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    overviewEl.append(h('div', { class: 'welcomeOverlay-box', style: { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` } }));
    const kbText = t.command ? commands.keybindingLabel(t.command) : '';
    const label = h('div', { class: `welcomeOverlay-label ${t.side}` }, t.label, kbText ? h('span', { class: 'shortcut' }, ` ${kbText}`) : null);
    if (t.side === 'right') { label.style.left = `${r.right + 6}px`; label.style.top = `${r.top + r.height / 2 + (t.offsetY || 0)}px`; }
    else if (t.side === 'below') { label.style.top = `${r.bottom + 6}px`; if (t.alignRight) label.style.right = `${Math.max(4, vw - r.right)}px`; else label.style.left = `${Math.max(4, r.left + 8)}px`; }
    else { label.style.bottom = `${Math.max(4, vh - r.top + 6)}px`; if (t.alignRight) label.style.right = `${Math.max(4, vw - r.right)}px`; else label.style.left = `${Math.max(4, r.left)}px`; }
    overviewEl.append(label);
  }
  overviewEl.addEventListener('pointerdown', e => { e.preventDefault(); hideInterfaceOverview(); });
  document.addEventListener('keydown', onOverviewKey, true);
  document.body.append(overviewEl);
}

// ---------------------------------------------------------------- Interactive playground

const PLAYGROUND = [
  {
    title: 'Multi-cursor Editing',
    text: [['Add the next match of the selection to the cursors', 'editor.action.addSelectionToNextFindMatch', 'Mod+D'], ['Select all occurrences of the selection', 'editor.action.selectHighlights', 'Mod+Shift+L'], ['Add a cursor above / below', 'editor.action.insertCursorBelow', 'Mod+Alt+ArrowDown']],
    note: 'Try it: select “#5d5d5d” and press the shortcut repeatedly, then type a new color. On iPhone, double-tap a word and use Edit → Add Next Occurrence from the ☰ menu.',
    lang: 'CSS', code: `#p1 {background-color: #ff0000;}                /* red in HEX format */\n#p2 {background-color: hsl(120, 100%, 50%);}   /* green in HSL format */\n#p3 {background-color: rgba(0, 4, 255, 0.733);} /* blue with alpha */\n#p4 {color: #5d5d5d;}\n#p5 {border-color: #5d5d5d;}\n#p6 {outline-color: #5d5d5d;}`
  },
  {
    title: 'IntelliSense',
    text: [['Trigger suggestions', null, 'Ctrl+Space']],
    note: 'Type “Math.” or “document.q” inside the function below and pick a suggestion. Suggestions appear automatically while you type.',
    lang: 'JavaScript', code: `function makeCircle(radius) {\n  const area = Math.PI * radius ** 2;\n  // Try typing: Math.  or  document.q\n  \n  return { radius, area };\n}\n\nconsole.log(makeCircle(3));`
  },
  {
    title: 'Line Actions',
    text: [['Copy line down', 'editor.action.copyLinesDownAction', 'Shift+Alt+ArrowDown'], ['Move line up / down', 'editor.action.moveLinesUpAction', 'Alt+ArrowUp'], ['Delete line', 'editor.action.deleteLines', 'Mod+Shift+K'], ['Toggle line comment', 'editor.action.commentLine', 'Mod+/']],
    note: 'Put the cursor on a line and try each action. On iPhone use the coding key bar above the keyboard or Selection in the ☰ menu.',
    lang: 'JSON', code: `{\n  "name": "John",\n  "age": 31,\n  "city": "New York"\n}`
  },
  {
    title: 'Formatting & Folding',
    text: [['Format Document', 'editor.action.formatDocument', 'Shift+Alt+F'], ['Fold / unfold region', 'editor.fold', 'Mod+Alt+['], ['Jump to matching bracket', null, 'Mod+Shift+\\']],
    note: 'Folding arrows appear in the gutter next to line numbers; tap them to collapse a block.',
    lang: 'JavaScript', code: `const users = [{name:'Ada',langs:['js','py']},{name:'Linus',langs:['c']}];\nfunction describe(u){\nif(u.langs.length>1){return u.name+' is polyglot';}\nelse{return u.name+' writes '+u.langs[0];}\n}\nusers.map(describe).forEach(line=>console.log(line));`
  },
  {
    title: 'Emmet',
    text: [['Expand abbreviation', 'editor.emmet.action.expandAbbreviation', 'Tab']],
    note: 'In an HTML file, type an abbreviation such as ul>li.item*3 and press Tab (the Tab key is on the coding key bar on iPhone).',
    lang: 'HTML', code: `<!-- In a real .html file, type the abbreviation below and press Tab -->\nul>li.item*3\n\n<!-- becomes -->\n<ul>\n  <li class="item"></li>\n  <li class="item"></li>\n  <li class="item"></li>\n</ul>`
  },
  {
    title: 'Errors and Warnings',
    text: [['Go to next problem', 'editor.action.marker.next', 'F8'], ['Show the Problems panel', 'workbench.actions.view.problems', 'Mod+Shift+M']],
    note: 'X Coder checks your JavaScript, JSON, HTML, CSS and Python as you type. Problems appear as squiggles and in the Problems panel; tap the ⊗ 0 ⚠ 0 counter in the status bar to open it.',
    lang: 'JavaScript', code: `function greet(name) {\n  return \`Hello, \${name}!\`\n}\n\nconsole.log(greet('X Coder')))  // ← an extra parenthesis`
  },
  {
    title: 'X Coder AI',
    text: [['Open Chat', 'workbench.action.chat.open', 'Ctrl+Mod+I']],
    note: 'Ask X Coder to explain, fix or build anything. In Agent mode it edits files, runs your project and fixes errors on its own; attach photos or screenshots and it can analyze them or recreate a design. Every change can be kept or undone.',
    lang: 'Markdown', code: `# Try asking X Coder\n\n- "Build a to-do app with local storage and dark mode"\n- "Why does my canvas stay blank?"\n- "Make this page look like the attached screenshot"\n- "Write tests for utils.js"`
  }
];

const TAGS = [
  ['controlKeyword', 'tok-control'], ['moduleKeyword', 'tok-control'], ['keyword', 'tok-keyword'], ['definitionKeyword', 'tok-keyword'],
  ['modifier', 'tok-keyword'], ['operatorKeyword', 'tok-keyword'], ['self', 'tok-keyword'], ['bool', 'tok-constant'], ['null', 'tok-constant'], ['atom', 'tok-constant'],
  ['string', 'tok-string'], ['regexp', 'tok-regexp'], ['escape', 'tok-escape'], ['number', 'tok-number'], ['comment', 'tok-comment'],
  ['typeName', 'tok-type'], ['className', 'tok-type'], ['namespace', 'tok-type'], ['tagName', 'tok-tag'], ['angleBracket', 'tok-tag-bracket'],
  ['attributeName', 'tok-attribute'], ['propertyName', 'tok-property'], ['variableName', 'tok-variable'], ['operator', 'tok-operator'],
  ['punctuation', 'tok-punctuation'], ['heading', 'tok-heading'], ['link', 'tok-link'], ['url', 'tok-link'], ['meta', 'tok-meta'], ['invalid', 'tok-invalid']
];

async function makeMiniEditor(host, code, langName) {
  const CM = await import('../../vendor/codemirror.js');
  const { state, view, commands: cmds, language, autocomplete, highlight, search } = CM;
  const t = highlight.tags;
  const specs = [];
  for (const [name, cls] of TAGS) if (t[name]) specs.push({ tag: t[name], class: cls });
  specs.push({ tag: t.function(t.variableName), class: 'tok-function' }, { tag: t.function(t.propertyName), class: 'tok-function' }, { tag: t.definition(t.variableName), class: 'tok-variable' });
  const exts = [
    view.lineNumbers(), view.highlightActiveLineGutter(), view.highlightActiveLine(), view.drawSelection(),
    cmds.history(), language.foldGutter(), language.indentOnInput(), language.bracketMatching(),
    autocomplete.closeBrackets(), autocomplete.autocompletion(), search.highlightSelectionMatches(),
    language.syntaxHighlighting(highlight.tagHighlighter(specs)),
    view.keymap.of([...autocomplete.closeBracketsKeymap, ...cmds.defaultKeymap, ...cmds.historyKeymap, ...language.foldKeymap, ...autocomplete.completionKeymap, ...search.searchKeymap, cmds.indentWithTab]),
    view.EditorView.contentAttributes.of({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' })
  ];
  const desc = CM.languages.find(l => l.name === langName);
  if (desc) { try { exts.push(await desc.load()); } catch {} }
  return new view.EditorView({ state: state.EditorState.create({ doc: code, extensions: exts }), parent: host });
}

function createPlayground(input, container) {
  const root = h('div', { class: 'welcome-doc playground scroll-region' });
  container.append(root);
  const views = [];
  root.append(
    h('h1', {}, 'Interactive Editor Playground'),
    h('p', { class: 'detail' }, 'The editor in X Coder is fast, touch-friendly and speaks VS Code. Each example below is a live editor — try the features right here; nothing is saved.'));
  for (const s of PLAYGROUND) {
    const keys = h('ul', { class: 'playground-keys' }, ...s.text.map(([label, id, fallback]) => {
      const spec = (id && commands.keybindingFor(id)) || fallback;
      return h('li', {}, h('span', {}, label), spec ? h('span', { class: 'monaco-keybinding' }, h('span', { class: 'monaco-keybinding-key' }, keybindingLabel(spec))) : null);
    }));
    const host = h('div', { class: 'playground-editor' });
    root.append(h('section', {}, h('h2', {}, s.title), keys, h('p', { class: 'detail' }, s.note), host));
    makeMiniEditor(host, s.code, s.lang).then(v => views.push(v)).catch(err => { host.textContent = s.code; host.classList.add('fallback'); console.warn(err); });
  }
  root.append(h('p', { class: 'detail playground-footer' }, 'Want more? Open the Command Palette (', keybindingLabel('Mod+Shift+P'), ') and type “help”, or read the ', link('keyboard cheatsheet', () => run('workbench.action.keybindingsReference')), '.'));
  return { dispose: () => views.forEach(v => v.destroy()), onShow: () => views.forEach(v => v.requestMeasure()) };
}

// ---------------------------------------------------------------- Keyboard shortcuts reference

const CHEATSHEET = [
  ['General', [['Show Command Palette', 'workbench.action.showCommands', 'Mod+Shift+P'], ['Quick Open, Go to File…', 'workbench.action.quickOpen', 'Mod+P'], ['User Settings', 'workbench.action.openSettings', 'Mod+,'], ['Keyboard Shortcuts', 'workbench.action.openGlobalKeybindings', null], ['Close editor', 'workbench.action.closeActiveEditor', 'Mod+W']]],
  ['Basic editing', [['Cut line (empty selection)', 'editor.action.clipboardCutAction', 'Mod+X'], ['Copy line (empty selection)', 'editor.action.clipboardCopyAction', 'Mod+C'], ['Move line up/down', 'editor.action.moveLinesDownAction', 'Alt+ArrowDown'], ['Copy line up/down', 'editor.action.copyLinesDownAction', 'Shift+Alt+ArrowDown'], ['Delete line', 'editor.action.deleteLines', 'Mod+Shift+K'], ['Insert line below', null, 'Mod+Enter'], ['Insert line above', null, 'Mod+Shift+Enter'], ['Jump to matching bracket', null, 'Mod+Shift+\\'], ['Indent/outdent line', null, 'Mod+]'], ['Toggle line comment', 'editor.action.commentLine', 'Mod+/'], ['Toggle block comment', 'editor.action.blockComment', 'Shift+Alt+A'], ['Toggle word wrap', 'editor.action.toggleWordWrap', 'Alt+Z']]],
  ['Navigation', [['Go to Line…', 'workbench.action.gotoLine', 'Ctrl+G'], ['Go to Symbol…', 'workbench.action.gotoSymbol', 'Mod+Shift+O'], ['Show Problems panel', 'workbench.actions.view.problems', 'Mod+Shift+M'], ['Go to next/previous problem', 'editor.action.marker.next', 'F8'], ['Go back / forward', 'workbench.action.navigateBack', null], ['Next / previous editor', 'workbench.action.nextEditor', 'Ctrl+PageDown']]],
  ['Search and replace', [['Find', 'actions.find', 'Mod+F'], ['Replace', 'editor.action.startFindReplaceAction', 'Mod+Alt+F'], ['Find in files', 'workbench.action.findInFiles', 'Mod+Shift+F'], ['Replace in files', 'workbench.action.replaceInFiles', 'Mod+Shift+H'], ['Add selection to next find match', 'editor.action.addSelectionToNextFindMatch', 'Mod+D'], ['Select all occurrences', 'editor.action.selectHighlights', 'Mod+Shift+L']]],
  ['Multi-cursor and selection', [['Insert cursor above / below', 'editor.action.insertCursorBelow', 'Mod+Alt+ArrowDown'], ['Select current line', null, 'Mod+L'], ['Select all', 'editor.action.selectAll', 'Mod+A'], ['Change all occurrences', 'editor.action.changeAll', 'Mod+F2']]],
  ['Rich languages editing', [['Trigger suggestion', null, 'Ctrl+Space'], ['Format document', 'editor.action.formatDocument', 'Shift+Alt+F'], ['Emmet: expand abbreviation', 'editor.emmet.action.expandAbbreviation', 'Tab'], ['Fold / unfold region', 'editor.fold', null], ['Trim trailing whitespace', 'editor.action.trimTrailingWhitespace', null], ['Change language mode', 'workbench.action.editor.changeLanguageMode', null]]],
  ['File management', [['New file', 'workbench.action.files.newUntitledFile', 'Mod+N'], ['New file…', 'workbench.action.files.newFile', 'Mod+Alt+N'], ['Save', 'workbench.action.files.save', 'Mod+S'], ['Save all', 'workbench.action.files.saveAll', 'Mod+Alt+S'], ['Reveal active file in Explorer', 'workbench.files.action.showActiveFileInExplorer', null]]],
  ['Display', [['Toggle side bar', 'workbench.action.toggleSidebarVisibility', 'Mod+B'], ['Show Explorer', 'workbench.view.explorer', 'Mod+Shift+E'], ['Show Search', 'workbench.view.search', 'Mod+Shift+F'], ['Show Source Control', 'workbench.view.scm', 'Ctrl+Shift+G'], ['Show Run and Debug', 'workbench.view.debug', 'Mod+Shift+D'], ['Show Extensions', 'workbench.view.extensions', 'Mod+Shift+X'], ['Show X Coder AI Chat', 'workbench.view.chat', 'Ctrl+Mod+I'], ['Toggle panel', 'workbench.action.togglePanel', 'Mod+J'], ['Show Output', 'workbench.action.output.toggleOutput', 'Mod+Shift+U']]],
  ['Run and debug', [['Start / continue', 'workbench.action.debug.start', 'F5'], ['Run without debugging', 'workbench.action.debug.run', 'Ctrl+F5'], ['Stop', 'workbench.action.debug.stop', 'Shift+F5'], ['Show Debug Console', 'workbench.debug.action.toggleRepl', 'Mod+Shift+Y']]],
  ['Integrated terminal', [['Show integrated terminal', 'workbench.action.terminal.toggleTerminal', 'Ctrl+`'], ['Create new terminal', 'workbench.action.terminal.new', 'Ctrl+Shift+`'], ['Run active file', 'workbench.action.terminal.runActiveFile', null], ['Clear terminal', 'workbench.action.terminal.clear', null]]]
];

function createKeyboardReference(input, container) {
  const root = h('div', { class: 'welcome-doc cheatsheet scroll-region' });
  container.append(root);
  const render = () => {
    clear(root);
    root.append(
      h('div', { class: 'cheatsheet-header' },
        h('h1', {}, 'X Coder'), h('p', { class: 'detail' }, `Keyboard shortcuts for ${isApple ? 'iPad, iPhone and macOS keyboards' : 'Windows, Linux and ChromeOS'}`),
        h('button', { class: 'monaco-button secondary', type: 'button', onclick: () => window.print() }, codicon('file-pdf'), 'Print')),
      h('div', { class: 'cheatsheet-grid' }, ...CHEATSHEET.map(([title, rows]) => h('section', {},
        h('h2', {}, title),
        h('table', {}, ...rows.map(([label, id, fallback]) => {
          const spec = (id && commands.keybindingFor(id)) || fallback;
          return h('tr', { class: id && !commands.has(id) ? 'unavailable' : '' },
            h('td', { class: 'keys' }, spec ? keybindingLabel(spec) : '—'),
            h('td', {}, label));
        }))))),
      h('p', { class: 'detail' }, 'On iPhone without a keyboard, every command is available from the ☰ menu, the Command Palette, and the coding key bar that appears above the keyboard.'));
  };
  render();
  return { dispose() {} };
}

// ---------------------------------------------------------------- activation

export async function activate() {
  editors.registerProvider('welcome', {
    title: () => 'Welcome',
    icon: () => APP_ICON,
    tooltip: () => 'Welcome',
    key: () => 'welcome:',
    pinnedByDefault: true,
    serialize: () => ({ type: 'welcome' }),
    deserialize: () => ({ type: 'welcome' }),
    create: createWelcome
  });
  editors.registerProvider('playground', {
    title: () => 'Interactive Playground',
    icon: () => APP_ICON,
    key: () => 'playground:',
    pinnedByDefault: true,
    serialize: () => ({ type: 'playground' }),
    deserialize: () => ({ type: 'playground' }),
    create: createPlayground
  });
  editors.registerProvider('keyboard-reference', {
    title: () => 'Keyboard Shortcuts Reference',
    icon: () => '<span class="codicon codicon-keyboard" aria-hidden="true"></span>',
    key: () => 'keyboard-reference:',
    pinnedByDefault: true,
    serialize: () => ({ type: 'keyboard-reference' }),
    deserialize: () => ({ type: 'keyboard-reference' }),
    create: createKeyboardReference
  });

  commands.registerAll([
    { id: 'workbench.action.showWelcomePage', title: 'Welcome', category: 'Help', icon: 'home', run: () => editors.open({ type: 'welcome' }, { pinned: true }) },
    { id: 'welcome.showInterfaceOverview', title: 'Interface Overview', category: 'Help', run: () => { layout.dismissOverlays(); setTimeout(showInterfaceOverview, 60); } },
    { id: 'welcome.showInteractivePlayground', title: 'Editor Playground', category: 'Help', run: () => editors.open({ type: 'playground' }, { pinned: true }) },
    { id: 'workbench.action.keybindingsReference', title: 'Keyboard Shortcuts Reference', category: 'Help', run: () => editors.open({ type: 'keyboard-reference' }, { pinned: true }) }
  ]);
}

export { showInterfaceOverview };
