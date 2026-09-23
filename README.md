# X Coder 6

**X Coder is Visual Studio Code for your iPhone** — a 1:1 VS Code–style IDE that runs entirely in the
browser (Safari or a Home Screen app), plus iPad and desktop. Projects live on your device, the editor is
CodeMirror 6 themed exactly like VS Code, and **X Coder AI** is a multi-model coding agent that can build
whole projects, analyze projects and photos you upload, run your code, and fix what it finds.

Live app: <https://matthewcodergamer.github.io/arena-pocket-ide/>

## Highlights

| Area | What you get |
|---|---|
| Workbench | VS Code layout on iPhone (code-server style): Activity Bar with ☰ application menu, side bar views, tabs with preview/dirty states, breadcrumbs, bottom panel, blue status bar, Command Palette (⇧⌘P), Quick Open (⌘P), Go to Line/Symbol, notifications, context menus (long-press), title bar + command center on iPad/desktop |
| Themes | Dark+ (default), Dark Modern, Light+, Light Modern, High Contrast · auto light/dark · VS Code syntax colors · Seti file icons · codicons |
| Editor | CodeMirror 6 styled like Monaco: ~150 languages, bracket pair colorization, indent guides, minimap, folding, multi-cursor, VS Code keybindings and find/replace widget, autocomplete, Emmet, format document, live problems (JS/JSON/syntax), diff editor, Markdown preview, image viewer, iPhone coding key bar |
| Explorer & Search | File tree with git/problem decorations, inline create/rename, drag & drop, import files/folders/ZIP, export ZIP, Open Editors, Outline, workspace search & replace with regex and globs |
| Source Control | GitHub clone/pull/commit & push/sync, staging, diffs, discard, branches, publish a project to a new repo, commit history — sign in with a token (or GitHub device flow through the Worker) |
| Run | Live preview (HTML/CSS/JS with ES modules and npm packages via esm.sh, TypeScript/JSX, Python via Pyodide, Markdown), DevTools, Run and Debug view with launch configurations |
| Panel | Terminal (`xsh`: ls/cd/cat/grep/find/mkdir/rm/mv/cp/echo > file, pipes, `node file.js`, `python file.py`, `git …`, `curl`), Problems, Output, Debug Console with REPL |
| X Coder AI | Chat view like VS Code Chat · **Ask / Edit / Agent** modes · agent reads files, searches, edits, runs the preview and fixes errors · **photo & screenshot analysis** (vision) · upload a ZIP/folder and it analyzes the project · voice input and natural read-aloud · Auto model routing across Claude/GPT/Gemini/Grok (via Puter) and free providers (via the X Coder Worker) · every change is reviewable with Keep/Undo |
| Accounts | GitHub, X Coder Cloud sync (Puter) |
| PWA | Works offline after the first visit, installs to the Home Screen, updates in the background |

## Install on iPhone

1. Open the live app in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Launch **X Coder** from the Home Screen for the full-screen VS Code layout.

Your projects, settings and chats from earlier X Coder versions are kept.

## Set up X Coder AI

X Coder AI works with either (or both):

- **Puter** — tap **Accounts → Sign in to X Coder Cloud (Puter)**. This unlocks frontier models (Claude,
  GPT, Gemini, Grok, DeepSeek…), natural voices and cloud sync. Auto mode prefers the strongest model.
- **The X Coder Worker** (`worker/`) — a Cloudflare Worker that routes to free/cheap providers with your
  own API keys kept as Cloudflare secrets (Groq, OpenRouter, Gemini, Mistral, SambaNova, BazaarLink,
  Workers AI). See [worker/README.md](worker/README.md). Set its URL in **Settings → X Coder AI → Router Url**.

API keys never touch the browser or this repository.

## Development

```bash
npm install            # dev tooling only (esbuild, CodeMirror sources, Playwright)
npm run serve          # http://localhost:8080
npm test               # Playwright tests (iPhone + desktop emulation) and unit tests
npm run build:vendor   # rebuild vendor/ after upgrading a library
node tools/gen-sw.mjs  # refresh the service worker precache list (CI does this on deploy)
```

The site has **no build step**: `index.html` loads native ES modules from `src/`. Third-party code is
pre-bundled into `vendor/` and committed so the app works offline. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map and APIs.

## Security

- Project code runs only in sandboxed iframes without same-origin access to X Coder's storage.
- AI output is rendered through DOMPurify; the agent refuses to read `.env`, keys and `.aiignore` paths.
- The GitHub token is kept in session storage unless you enable **Git: Remember Token**.
- The Worker enforces an origin allowlist, rate limits, and an SSRF-safe `/fetch`.

## License & credits

VS Code look-and-feel reproduced for familiarity; X Coder is not affiliated with Microsoft.
Codicons (CC BY 4.0) and Seti UI file icons (MIT) are used under their licenses. CodeMirror (MIT),
marked (MIT), DOMPurify (Apache-2.0/MPL-2.0), JSZip (MIT), acorn (MIT), Emmet (MIT).
