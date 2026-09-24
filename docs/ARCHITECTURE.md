# X Coder 6 — Architecture

X Coder is a VS Code–style IDE that runs entirely in the browser and is designed first for iPhone
(Safari and Home Screen PWA), then iPad and desktop. There is **no build step** for the site: native ES
modules are served as-is by GitHub Pages. Third-party libraries are pre-bundled into `vendor/` by
`npm run build:vendor` (esbuild) and committed, so the app works offline and never depends on a CDN for
the editor.

```
index.html            workbench shell (parts), theme bootstrap, CSS links
sw.js                 service worker (offline cache, update flow)
css/                  theme.css (VS Code color tokens) · workbench.css (layout) · widgets.css (shared widgets)
                      + one stylesheet per feature (editor, explorer, search, scm, panel, preview, chat, welcome, settings, extensions)
vendor/               codemirror.js (+ lazy language chunks), cm-emmet.js, cm-minimap.js, jszip.js, acorn.js,
                      markdown.js (marked + DOMPurify), seti.js (file icons), codicons/ (VS Code icon font)
src/main.js           boot: core → feature activation (isolated) → open project → restore editors
src/core/             dom, events (bus), path, db (IndexedDB), fs (ProjectFS), workspace (projects),
                      settings, commands (+ keybindings), menus, output (channels), diagnostics, templates, puter
src/platform/         contextmenu, quickinput, notifications, dialogs
src/workbench/        layout, views (activity bar + side bars), editors (editor area + tabs), panel, statusbar,
                      titlebar, theme, icons, coreCommands, contributions (menus/manage/projects commands)
src/editor/           CodeMirror editor, diff editor, image viewer, markdown preview, languages, lint, format
src/views/            explorer, search, run (Run and Debug), extensions, welcome, settingsEditor
src/scm/              Source Control (GitHub), src/cloud/ X Coder Cloud (Puter) + Accounts
src/panel/            Terminal, Output, Problems, Debug Console
src/preview/          Live preview bundler, preview editor, headless capture runner
src/ai/               X Coder AI: chat view, agent loop, tools, providers (Worker router + Puter), vision, voice
worker/               Cloudflare Worker AI router (API keys stay server-side); root index.js mirrors worker/src/index.js
```

## Principles

1. **VS Code 1:1** — same parts, names, command IDs, keybindings, menus, colors (Dark+ default), codicons
   and Seti file icons. When unsure how something should look or behave, do what VS Code does.
2. **Phone-first** — every feature must be fully usable on a 390×844 iPhone with touch only:
   - tap targets ≥ 28px tall on touch (`--row-height` is 30px under `(pointer: coarse)`);
   - hover-only affordances must be visible on touch (`@media (hover: none)`);
   - right-click menus must also open on long-press (`onContextMenu(el, handler)` from `core/dom.js`);
   - never rely on keyboard shortcuts alone — every command is reachable from a menu, a view action,
     the ☰ application menu, or the Command Palette;
   - side bars are overlays on phones (`layout.isPhone`), dismissed after picking something
     (`layout.dismissOverlays()`; `editors.open` already does this);
   - the software keyboard: the workbench is pinned to the visual viewport (`--vvh`), `body.keyboard-open`
     is set while it is visible and `bus` emits `keyboard:changed`.
   - inputs: `autocapitalize="off" autocorrect="off" spellcheck="false"` for code/paths; use `enterkeyhint`.
3. **Isolation** — each feature exports `activate()`; failures are logged to Output → X Coder and do not
   break other features. Guard optional dependencies with try/catch.
4. **Data safety** — IndexedDB name/version are shared with X Coder ≤5 (projects survive upgrades).
   Never delete user data without a confirm dialog. Secrets (GitHub token) never go into project files,
   settings.json, logs, or AI prompts.
5. **Untrusted content** — project files, AI output and web content are untrusted: render markdown via
   DOMPurify, run project code only in sandboxed iframes **without** `allow-same-origin`.

## Core APIs (import from `src/…`)

| Module | Exports | Notes |
|---|---|---|
| `core/dom.js` | `$ $$ h clear append codicon codiconHtml renderLabelWithIcons escapeHtml debounce uid onLongPress onContextMenu copyText downloadBlob pickFiles fuzzyMatch highlightMatches isPhone isTouch isIOS isApple formatBytes relativeTime` | `h(tag, attrs, ...children)` hyperscript |
| `core/events.js` | `bus`, `Emitter`, `DisposableStore` | event list documented at top of file |
| `core/path.js` | `posix`, `validatePath`, `isTextPath`, `isImagePath`, `looksBinary`, `mimeFromPath` | project paths are relative (`src/app.js`) |
| `core/workspace.js` | `workspace` (`.project`, `.fs`, `listProjects/openProject/createProject/renameProject/duplicateProject/deleteProject/updateProject/sessionGet/sessionSet`) | |
| `core/fs.js` | `ProjectFS` (`entries files list get exists readText peekText readBlob readDataURL writeText writeBinary writeFileAuto writeMany mkdir remove rename copy clear search`) | every mutation emits `fs:changed` |
| `core/settings.js` | `settings.register/get/set/reset/onChange/all/userValues/replaceUserValues` | schema drives the Settings editor |
| `core/commands.js` | `commands.register/registerAll/execute/has/get/all/keybindingLabel`, `keybindingLabel(spec)` | keybinding `Mod` = ⌘ on Apple |
| `core/menus.js` | `menus.append(menuId, item)`, `menus.resolve(menuId, ctx)` | menu ids listed in file header |
| `core/output.js` | `output.channel(name)` → `.info/.warn/.error/.show()`, `log` (X Coder channel) | |
| `core/diagnostics.js` | `diagnostics.set(owner, path, markers)`, `.forFile`, `.all`, `.counts`, `.summary` | 1-based line/col |
| `core/db.js` | `openDB tx idbGet idbPut idbDelete idbGetAll idbGetAllByIndex kvGet kvSet` | stores: projects, files, checkpoints, settings, gitbase, chats |
| `core/puter.js` | `getPuter()`, `puterSignedIn()` | Puter loads async; never block on it |
| `platform/quickinput.js` | `quickInput.pick(items, opts)`, `.input(opts)`, `.open(prefix)`, `.registerProvider(prefix, provider)` | providers: `''` files, `>` commands, `:` line, `@` symbols, `?` help |
| `platform/contextmenu.js` | `showContextMenu(items, {x,y}|{anchor,align})` | submenus drill down on phones |
| `platform/notifications.js` | `notify.info/warn/error/progress`, `withProgress` | |
| `platform/dialogs.js` | `dialogs.confirm/show/alert` | |
| `workbench/layout.js` | `layout` (sidebar/panel/aux visibility, `isPhone`, `keyboardOpen`, `dismissOverlays`) | |
| `workbench/views.js` | `views.registerContainer/registerView/open/toggle/setBadge/setTitle/refreshActions/revealView`, `activityBar` | |
| `workbench/editors.js` | `editors.registerProvider/open/close/save/setDirty/active/activePath/list/findByPath/refresh` | |
| `workbench/panel.js` | `panel.registerTab/open/toggle/close/setBadge/refreshActions` | |
| `workbench/statusbar.js` | `statusbar.add({id, alignment, priority, text, tooltip, command|run, kind, hideOnPhone})` | `$(icon)` syntax |
| `workbench/icons.js` | `fileIconHtml(path)`, `languageNameFor(path)` | Seti icons |
| `workbench/theme.js` | `THEMES`, `applyTheme(previewId?)`, `currentTheme()` | |

Cross-feature APIs (the owning feature implements them; exports are stable). `codeEditor` extras: `getText(path)` (open editor's unsaved text, else the stored file), `isDirty(path)`, `languageId(pathOrAlias)`, `onDidChangeContent(fn)`; `editors.open({type:'file', path}, {reveal:{line, col, endLine, endCol, select:true}})` selects and centers a range.
`src/editor/api.js` (`codeEditor`), `src/preview/api.js` (`preview`), `src/panel/api.js` (`terminal`),
`src/scm/api.js` (`git`), `src/ai/api.js` (`ai`), `src/views/files-api.js` (`files`).

## Editor inputs (types)

| type | fields | provider owner |
|---|---|---|
| `file` | `path` | editor (text → CodeMirror, images → image viewer, other binary → info page) |
| `diff` | `id, title, path, original, modified, readOnly, actions` | editor |
| `markdown-preview` | `path` | editor |
| `preview` | `entry` | preview |
| `welcome` | — | welcome |
| `settings` | `query?` (supports `@modified`, `@id:key1,prefix.`) | settings editor |
| `settings-json` | `revealSetting?` | settings editor |
| `playground` | — | welcome |
| `keyboard-reference` | — | welcome |
| `keybindings` | `query?` | settings editor |
| `extension` | `id` | extensions |
| `release-notes` | — | welcome |

Keys default to `${type}:${path ?? id ?? ''}`.

## Command IDs (VS Code IDs where they exist)

Core (implemented): `workbench.action.showCommands` (⇧⌘P / F1), `workbench.action.quickOpen` (⌘P),
`workbench.action.gotoLine` (⌃G), `workbench.action.gotoSymbol` (⇧⌘O), `workbench.action.showApplicationMenu`,
`workbench.action.toggleSidebarVisibility` (⌘B), `workbench.action.togglePanel` (⌘J),
`workbench.action.toggleAuxiliaryBar` (⌥⌘B), `workbench.action.toggleMaximizedPanel`,
`workbench.action.files.save` (⌘S), `workbench.action.files.saveAll` (⌥⌘S), `workbench.action.closeActiveEditor` (⌘W),
`workbench.action.closeAllEditors`, `workbench.action.closeOtherEditors`, `workbench.action.nextEditor`,
`workbench.action.previousEditor`, `workbench.action.reloadWindow`, `notifications.toggleList`,
and one `workbench.view.<id>` command per view container (`workbench.view.explorer` ⇧⌘E, `workbench.view.search` ⇧⌘F,
`workbench.view.scm` ⌃⇧G, `workbench.view.debug` ⇧⌘D, `workbench.view.extensions` ⇧⌘X, `workbench.view.chat` ⌃⌘I).

## Settings keys

`workbench.colorTheme`, `window.autoDetectColorScheme`, `workbench.startupEditor`, `editor.fontSize`,
`editor.fontFamily`, `editor.tabSize`, `editor.insertSpaces`, `editor.wordWrap`, `editor.lineNumbers`,
`editor.minimap.enabled`, `editor.renderWhitespace`, `editor.bracketPairColorization.enabled`,
`editor.guides.indentation`, `editor.formatOnSave`, `editor.accessoryBar`, `files.autoSave`, `files.autoSaveDelay`,
`emmet.enabled`, `html.autoClosingTags`, `explorer.sortOrder`, `explorer.confirmDelete`, `search.*`,
`terminal.integrated.fontSize`, `preview.autoRefresh`, `git.autoPushAIEdits`, `git.rememberToken`,
`xcoder.ai.routerUrl`, `xcoder.ai.model`, `xcoder.ai.mode`, `xcoder.ai.maxSteps`, `xcoder.voice.*`, `xcoder.cloud.*`.

## CSS conventions

- Use only `var(--vscode-…)` tokens and `--tok-*` syntax tokens from `css/theme.css` — never hard-coded colors
  (so all five themes work).
- Reuse widget classes: `.monaco-button[.secondary]`, `.monaco-inputbox`, `.xc-input`, `.xc-select`,
  `.xc-checkbox`, `.monaco-list-row`, `.monaco-custom-toggle`, `.monaco-toolbar .action-label.codicon`,
  `.monaco-count-badge`, `.monaco-keybinding-key`, `.monaco-progress-container`, `.view-message`.
- Density variables: `--row-height`, `--tab-height`, `--pane-header-height`, `--menu-item-height`.
- Feature stylesheets are already linked from `index.html`: `css/<feature>.css`.
