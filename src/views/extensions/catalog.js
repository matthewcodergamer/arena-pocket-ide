// X Coder's capabilities presented as built-in extensions (VS Code ships Emmet, Markdown, Git… the
// same way). Nothing here is downloaded from a marketplace: every entry is part of X Coder and is
// labeled "Built-in". Entries with `toggle` can be enabled/disabled through that setting.
//
// Fields: id, name, icon (codicon), tint (a --tok-* color used for the icon tile), description,
//         section: 'installed' | 'builtin', toggle?: setting key (boolean), settings: key prefixes,
//         commands: command id prefixes/ids, details (markdown), changelog (markdown)

export const EXTENSIONS = [
  {
    id: 'xcoder.ai', name: 'X Coder AI', icon: 'sparkle', tint: 'control', section: 'installed',
    description: 'AI chat, inline edits and an agent that builds, analyzes and fixes projects — with vision and voice.',
    settings: ['xcoder.ai.'], commands: ['workbench.action.chat.', 'xcoder.chat.', 'xcoder.ai.'],
    details: `# X Coder AI

Chat with an AI assistant that knows your project. Open it from the **Chat** icon in the Activity Bar
(or **View → Chat**).

## Modes
- **Ask** — questions about your code, explanations and reviews.
- **Edit** — changes to the attached files, shown as diffs you can keep or undo.
- **Agent** — plans and performs multi-step work: creates files, runs the project, reads the terminal and fixes errors.

## Attach context
Attach files, the current selection, photos or screenshots (the model can read images), or take a photo with the camera.

## Providers
Requests go through your X Coder AI Router (a Cloudflare Worker you deploy, so API keys never reach the browser) or
through Puter when you are signed in. Configure it in **Settings → Extensions → X Coder AI**.`,
    changelog: `## 6.0.0
- Rebuilt chat view in the Secondary Side Bar with Ask / Edit / Agent modes.
- Streaming responses, image understanding and photo capture.
- Agent tools: read/write files, search, run the preview and the terminal, undo last AI edits.`
  },
  {
    id: 'xcoder.emmet', name: 'Emmet', icon: 'symbol-snippet', tint: 'string', section: 'installed', toggle: 'emmet.enabled',
    description: 'Emmet abbreviations for HTML, CSS and JSX: type ul>li*3 and press Tab.',
    settings: ['emmet.', 'html.autoClosingTags'], commands: ['editor.emmet.'],
    details: `# Emmet

Expand abbreviations into full markup, like in VS Code.

| Type | Result |
| --- | --- |
| \`ul>li*3\` | a list with three items |
| \`div.card>h2+p\` | a div with class *card*, a heading and a paragraph |
| \`!\` | an HTML5 document skeleton |

Press **Tab** (or run **Emmet: Expand Abbreviation**) to expand. On iPhone the coding keyboard bar has a Tab key.`,
    changelog: '## 6.0.0\n- Emmet for HTML, CSS and JSX powered by the official Emmet CodeMirror plugin.'
  },
  {
    id: 'xcoder.livePreview', name: 'Live Preview', icon: 'open-preview', tint: 'type', section: 'installed', toggle: 'preview.autoRefresh',
    description: 'Runs HTML, CSS and JavaScript in a sandboxed preview that refreshes as you type.',
    settings: ['preview.'], commands: ['xcoder.preview.'],
    details: `# Live Preview

Press **▶ Run** (or **Run → Run Without Debugging**) to open the preview of \`index.html\` or the active file.

- Updates automatically while you edit (disable this extension to refresh manually with **Refresh**).
- \`console\` output from the page is shown in the **Debug Console**.
- Project code runs in a sandboxed frame without access to X Coder or your data.`,
    changelog: '## 6.0.0\n- New preview editor with automatic refresh and a console bridge to the Debug Console.'
  },
  {
    id: 'xcoder.formatter', name: 'Prettier Formatter', icon: 'wand', tint: 'function', section: 'installed',
    description: 'Formats JavaScript, TypeScript, HTML, CSS, JSON and Markdown with Prettier.',
    settings: ['editor.formatOnSave', 'editor.tabSize', 'editor.insertSpaces'], commands: ['editor.action.formatDocument'],
    details: `# Prettier Formatter

Run **Format Document** from the Command Palette or the editor context menu.
Turn on **Editor: Format On Save** to format every time you save.

Prettier is downloaded the first time you format and then cached for offline use.`,
    changelog: '## 6.0.0\n- Format Document and Format On Save.'
  },
  {
    id: 'xcoder.minimap', name: 'Minimap', icon: 'map', tint: 'keyword', section: 'installed', toggle: 'editor.minimap.enabled',
    description: 'A code overview on the right side of the editor.',
    settings: ['editor.minimap.'], commands: ['editor.action.toggleMinimap'],
    details: '# Minimap\n\nShows a zoomed-out overview of the file next to the scroll bar. Tap or drag it to jump. Also available as **View → Appearance → Minimap**.',
    changelog: '## 6.0.0\n- Minimap for the code editor.'
  },
  {
    id: 'xcoder.bracketPairs', name: 'Bracket Pair Colorization', icon: 'symbol-array', tint: 'number', section: 'installed', toggle: 'editor.bracketPairColorization.enabled',
    description: 'Colors matching brackets so nested code is easier to read.',
    settings: ['editor.bracketPairColorization.'], commands: [],
    details: '# Bracket Pair Colorization\n\nMatching `()`, `[]` and `{}` get the same color, like VS Code’s built-in bracket pair colorizer.',
    changelog: '## 6.0.0\n- Bracket pair colors for every language.'
  },
  {
    id: 'xcoder.indentGuides', name: 'Indent Guides', icon: 'list-tree', tint: 'comment', section: 'installed', toggle: 'editor.guides.indentation',
    description: 'Vertical guides that show indentation levels.',
    settings: ['editor.guides.'], commands: [],
    details: '# Indent Guides\n\nDraws thin vertical lines at each indentation level; the guide of the active block is highlighted.',
    changelog: '## 6.0.0\n- Indentation guides.'
  },
  {
    id: 'xcoder.accessoryBar', name: 'Coding Keyboard Bar', icon: 'keyboard', tint: 'variable', section: 'installed', toggle: 'editor.accessoryBar',
    description: 'Tab, arrows, brackets and symbols above the iPhone keyboard.',
    settings: ['editor.accessoryBar'], commands: [],
    details: '# Coding Keyboard Bar\n\nA row of keys the iOS keyboard does not have — **Tab**, **Esc**, the arrow keys, brackets and common code symbols — shown above the software keyboard while you edit code on a touch device.',
    changelog: '## 6.0.0\n- Accessory bar for touch devices.'
  },
  {
    id: 'xcoder.git', name: 'GitHub Source Control', icon: 'source-control', tint: 'regexp', section: 'installed',
    description: 'Clone, commit, push and pull GitHub repositories — no git binary needed.',
    settings: ['git.'], commands: ['git.', 'github.'],
    details: `# GitHub Source Control

Connect a project to a GitHub repository in the **Source Control** view.

- **Clone Repository…** imports a repo as a new project.
- Changes are listed like VS Code's Source Control view; open a change to see its diff.
- **Commit** and **Push** go through the GitHub API.
- Sign in to GitHub from the **Accounts** menu; the token stays on this device and is only sent to GitHub.`,
    changelog: '## 6.0.0\n- VS Code Source Control view, inline diffs and branch/sync status bar items.'
  },
  {
    id: 'xcoder.voice', name: 'Voice', icon: 'mic', tint: 'escape', section: 'installed',
    description: 'Dictate chat messages and have X Coder AI read answers aloud.',
    settings: ['xcoder.voice.'], commands: ['xcoder.voice.', 'xcoder.chat.startVoice', 'xcoder.chat.readAloud', 'xcoder.chat.stopSpeaking'],
    details: '# Voice\n\nTap the microphone in the chat input to dictate. **Read Aloud** speaks a response using the voice you choose in **Settings → Extensions → Voice**.',
    changelog: '## 6.0.0\n- Dictation and text-to-speech for chat.'
  },
  {
    id: 'xcoder.cloud', name: 'X Coder Cloud', icon: 'cloud', tint: 'link', section: 'installed',
    description: 'Back up and sync projects with your Puter account.',
    settings: ['xcoder.cloud.'], commands: ['xcoder.cloud.'],
    details: '# X Coder Cloud\n\nSign in with Puter from the **Accounts** menu to save projects to the cloud and open them on another device. Without an account, projects stay on this device.',
    changelog: '## 6.0.0\n- Cloud projects through Puter.'
  },
  {
    id: 'xcoder.python', name: 'Python in the Browser', icon: 'python', tint: 'type', section: 'builtin',
    description: 'Runs Python files with Pyodide (CPython compiled to WebAssembly).',
    settings: [], commands: ['workbench.action.terminal.runActiveFile'],
    details: '# Python in the Browser\n\nRun `python main.py` in the terminal or press ▶ on a `.py` file. Pyodide is downloaded on first use and cached for offline use. Packages that need native code outside Pyodide are not available.',
    changelog: '## 6.0.0\n- Python runs from the terminal and the Run button.'
  },
  {
    id: 'xcoder.markdown', name: 'Markdown Language Features', icon: 'markdown', tint: 'heading', section: 'builtin',
    description: 'Markdown preview (side by side or in a tab) with GitHub-flavored Markdown.',
    settings: ['markdown.'], commands: ['markdown.'],
    details: '# Markdown Language Features\n\nOpen a `.md` file and run **Markdown: Open Preview** or **Markdown: Open Preview to the Side** from the Command Palette or the editor title bar. GitHub-flavored Markdown (tables, task lists, fenced code) is supported and embedded HTML is sanitized.',
    changelog: '## 6.0.0\n- Markdown preview editor.'
  },
  {
    id: 'xcoder.seti', name: 'Seti File Icons', icon: 'file-code', tint: 'css-selector', section: 'builtin',
    description: 'The Seti file icon theme — VS Code’s default file icons.',
    settings: [], commands: [],
    details: '# Seti File Icons\n\nFile icons in the Explorer, tabs and Quick Open come from the Seti UI icon theme (MIT), the default in VS Code.',
    changelog: '## 6.0.0\n- Seti icons with light and dark variants.'
  },
  {
    id: 'xcoder.eruda', name: 'Eruda DevTools', icon: 'inspect', tint: 'deleted', section: 'builtin',
    description: 'A mobile web console for the preview and for X Coder itself.',
    settings: [], commands: ['xcoder.preview.toggleDevTools', 'workbench.action.toggleDevTools'],
    details: '# Eruda DevTools\n\nIn the preview, tap the **DevTools** action to inspect elements, the console and network requests. **Help → Toggle Developer Tools** opens Eruda for X Coder itself. Eruda is downloaded from cdn.jsdelivr.net the first time you open it.',
    changelog: '## 6.0.0\n- Eruda for the preview and the workbench.'
  }
];

export function extensionById(id) { return EXTENSIONS.find(e => e.id === id) || null; }
