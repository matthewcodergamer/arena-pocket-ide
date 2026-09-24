# X Coder 6.0

X Coder 6 is a ground-up rebuild: the workbench now looks and works like **Visual Studio Code** — the same
parts, menus, command names, keyboard shortcuts, icons and colors — and it is designed first for the iPhone
(Safari and the Home Screen app), then iPad and desktop browsers.

> Your projects and settings are kept. Everything you created with X Coder 5 or earlier opens unchanged.

## The VS Code workbench, on your phone

- **Activity Bar** with the ☰ application menu at the top (File, Edit, Selection, View, Go, Run, Terminal,
  Help), Explorer, Search, Source Control, Run and Debug, Extensions and Chat, plus **Accounts** and
  **Manage** at the bottom — exactly like VS Code in a phone browser.
- **Side bars as overlays** on phones: they slide over the editor and close when you pick something.
- **Editor tabs** with preview (italic) tabs, dirty dots, split and "…" actions, and the empty-editor watermark.
- **Status bar** in VS Code blue: remote indicator, branch and sync, problems, cursor position, indentation,
  language mode, live preview and notifications.
- **Command Palette** (⇧⌘P / F1), **Go to File** (⌘P), **Go to Line** (⌃G) and **Go to Symbol** (⇧⌘O).
- **Five color themes**: Dark+ (default), Dark Modern, Light+, Light Modern and Dark High Contrast — preview
  them live with **Preferences: Color Theme**, or follow the iOS appearance automatically.
- **Settings editor** with search, categories, modified indicators and a validated **settings.json**;
  a **Keyboard Shortcuts** editor listing every command.
- **Extensions view** showing X Coder's built-in capabilities (Emmet, Live Preview, Minimap, AI, Git…) with
  details, contributed commands and settings, and Enable/Disable where it applies.

## Editor

- CodeMirror 6 with VS Code keybindings: multi-cursor, Add Next Occurrence, move/copy lines, comments,
  folding, find and replace, bracket pair colors, indent guides, minimap and word wrap.
- Emmet abbreviations, auto-closing tags, Prettier formatting (Format Document / Format On Save).
- Problems from the built-in linters, Markdown preview, image viewer and diff editor.
- A coding keyboard bar above the iPhone keyboard with Tab, Esc, arrows and symbols.

## Explorer and Search

- VS Code file tree with Seti icons, inline rename, drag and drop, and long-press context menus.
- Import files, folders or ZIP archives; export the project as a ZIP.
- Search across files with regular expressions, match case, whole word, include/exclude and Replace All.

## Source Control

- Connect a project to GitHub: clone, see changes and diffs, commit, push and pull — no git binary needed.
- Branch and sync status in the status bar.

## Terminal, Run and Preview

- An integrated terminal with project commands, `node file.js` and `python file.py` (Python runs in the
  browser with Pyodide).
- **Run** opens a live preview of HTML, CSS and JavaScript that refreshes as you type; console output
  appears in the Debug Console and errors in Problems. Project code always runs in a sandbox.

## X Coder AI

- Chat in the Secondary Side Bar with **Ask**, **Edit** and **Agent** modes.
- The agent can read and write files, search the project, run the preview and the terminal, and fix what
  it breaks — every AI edit can be undone.
- Attach files, the selection, photos and screenshots: models with vision can analyze images.
- Voice: dictate messages and have answers read aloud.
- Analyze uploaded projects and generate tests, docs and reviews from the editor context menu.

## AI Router (Cloudflare Worker)

- The Worker now streams responses, accepts images for vision models, routes across multiple providers
  with automatic fallback, and reports provider status and available models.
- API keys stay in the Worker's secrets; they never reach the browser.

## Upgrading

- **Projects and settings are preserved.** X Coder 6 opens the same on-device database as earlier versions
  and migrates your theme, AI router URL, voice and editor preferences on first launch.
- **Redeploy the Cloudflare Worker** after updating to enable streaming and vision (the previous Worker
  keeps working for plain chat).
- Updates install in the background. When a new version is ready you'll see **Reload to Update**; you can
  also use **Help → Check for Updates…** or **Manage (⚙) → Check for Updates…**.

## Install on your Home Screen

1. Open X Coder in **Safari** on your iPhone or iPad.
2. Tap the **Share** button, then **Add to Home Screen**.
3. Launch X Coder from the new icon: it opens full screen, works offline and keeps your projects on the device.

## Known limitations

- Keyboard shortcuts can't be customized yet (the Keyboard Shortcuts editor is read-only).
- There is no extension marketplace: the Extensions view lists X Coder's built-in features.
- Some features download a library the first time you use them (Pyodide, Prettier, Eruda Developer Tools)
  and need a connection that time; they are cached afterwards.
