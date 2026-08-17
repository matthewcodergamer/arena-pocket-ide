# Arena Pocket IDE

A real mobile-first browser IDE designed around the supplied iPhone reference UI. The frontend is static and can be hosted directly on GitHub Pages. Projects are persisted in IndexedDB. The Arena.ai API key is never placed in the browser; AI requests go through the included Cloudflare Worker.

## What is implemented

- Mobile iPhone-style full-screen workspaces and persistent bottom navigation
- Desktop activity rail + persistent Explorer + optional right utility pane
- Project filesystem persisted in IndexedDB
- Nested folders and file Explorer
- Create, rename, delete, import, download and ZIP export/import
- CodeMirror 6 editor loaded lazily
- HTML, CSS, JavaScript/TypeScript, JSX/TSX, JSON and Markdown language modes
- Autosave and workspace restore
- Mobile coding accessory row
- Static live preview in a sandboxed iframe
- Local CSS, scripts, images and binary assets in preview
- Relative browser module rewriting for local JS modules
- Preview console bridge for log/info/warn/error, errors and unhandled rejections
- Browser terminal with real project filesystem commands
- Honest capability message for Node/npm when unavailable in the static browser tier
- Arena.ai repository-aware agent through a secure Worker
- Multi-round AI read/search requests before edit proposals
- `.aiignore` + default secret/path exclusions
- Structured AI operations only; prose cannot directly mutate files
- Review-before-apply proposal UI
- Source-hash conflict detection
- Local AI checkpoints + Undo AI Changes
- GitHub repository pull/import through the Git Data API
- GitHub status against the last sync snapshot
- GitHub commit/push through blobs -> tree -> commit -> ref update
- GitHub token kept in sessionStorage only, not project persistence
- PWA manifest, icons, offline shell and service worker
- GitHub Pages deployment workflow
- Diagnostics panel
- iOS Visual Viewport keyboard handling

## Important capability boundaries

This build does **not** fake a Node runtime. The terminal operates on the real local project filesystem and supports commands including `ls`, `tree`, `cat`, `touch`, `mkdir`, `rm`, `mv`, `open`, `run` and `git status`. `node`, `npm` and `npx` report that they are unavailable in the static browser tier instead of pretending to execute.

The live preview is intended for static browser projects. It handles linked local CSS, ordinary local scripts, many local ES-module relationships and uploaded local assets. A Vite/Node project that requires dependency installation needs a browser Node runtime adapter or a remote runtime service as a later capability tier.

## Files

```text
arena-pocket-ide-final/
├── index.html
├── styles.css
├── app.js
├── manifest.webmanifest
├── sw.js
├── 404.html
├── .nojekyll
├── icons/
│   ├── icon-192.png
│   ├── icon-512.png
│   └── apple-touch-icon.png
├── .github/
│   └── workflows/
│       └── pages.yml
└── worker/
    ├── package.json
    ├── wrangler.toml
    ├── .dev.vars.example
    └── src/
        └── index.js
```

# 1. Run the frontend locally

Any static HTTPS-capable server works. For a quick computer test:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

CodeMirror and JSZip are loaded lazily from `esm.sh`. After the editor dependencies have been fetched, normal browser caching helps subsequent launches. The IDE shell and local project data do not depend on Arena.

# 2. Deploy frontend to GitHub Pages

1. Create a GitHub repository.
2. Put the contents of this folder at the repository root.
3. Commit and push to `main`.
4. In GitHub repository settings, choose **Pages -> GitHub Actions** as the source if it is not already selected.
5. The included `.github/workflows/pages.yml` deploys the static site.

The frontend uses relative asset URLs, so project-site hosting such as `https://username.github.io/repository/` works.

# 3. Deploy the Arena.ai proxy

The Worker keeps the Arena key off the frontend.

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put ARENA_API_KEY
```

Then edit `worker/wrangler.toml`.

Set the exact frontend origin:

```toml
ALLOWED_ORIGIN = "https://YOUR-USERNAME.github.io"
```

For a custom domain, use that exact origin instead, or set a comma-separated list through the Worker environment.

## Free Only policy

The Worker defaults to:

```toml
ARENA_FREE_ONLY = "true"
```

It intentionally refuses to guess which Arena models are free. Put only Arena model IDs that you have personally verified as free for your account/API access into:

```toml
ARENA_FREE_MODELS = "verified-free-model-id,another-verified-free-model-id"
```

Choose a default from that allowlist:

```toml
ARENA_MODEL = "verified-free-model-id"
```

If `ARENA_FREE_ONLY=true` and `ARENA_FREE_MODELS` is empty, AI requests are rejected instead of risking paid usage.

Deploy:

```bash
npm run deploy
```

Copy the resulting Worker URL.

# 4. Connect Arena inside the IDE

Open:

```text
Settings -> Arena.ai
```

Enter the Worker URL, for example:

```text
https://arena-pocket-ide-proxy.YOUR-SUBDOMAIN.workers.dev
```

The browser stores only this endpoint and an optional model ID. It never receives `ARENA_API_KEY`.

The Worker uses the Arena preview API base:

```text
https://api.preview.arena.ai
```

and forwards to:

```text
POST /v1/messages
```

using `x-api-key` plus the Anthropic-version request header. These details came from Arena's official API preview documentation surfaced in August 2026. If Arena changes its preview API, change `ARENA_API_BASE` and/or the Worker adapter rather than putting credentials into the frontend.

# 5. How the AI agent works

The AI composer is not wired directly to file writes.

Flow:

```text
user request
-> local project context selection
-> Arena request through Worker
-> optional structured read/search requests
-> IDE executes only allowed read tools
-> Arena returns structured file operations
-> IDE validates paths and secret exclusions
-> IDE records source hashes
-> reviewable proposal appears
-> user selects changes
-> checkpoint created
-> hashes checked again
-> selected operations applied
-> IndexedDB project updated
-> editor/explorer/preview updated
-> Undo AI Changes can restore checkpoint
```

Supported proposed operations:

```text
create_file
replace_file
patch_file
rename_path
move_path
delete_file
create_folder
```

Supported read/context requests include:

```text
read_file
search_files
get_project_tree
get_diagnostics
get_preview_console
get_git_diff
```

The agent receives an explicit instruction that source files, README files, comments, logs and repository contents are untrusted data and cannot override agent permissions.

## `.aiignore`

Create a `.aiignore` file at project root. Each non-comment line is treated as an additional path pattern excluded from AI context/actions.

Default exclusions include common environment files, key files, `.git/` and `node_modules/`.

# 6. GitHub integration

Open the Git screen and enter:

```text
owner/repository
branch
GitHub token (for private repos or pushing)
```

The token is stored only in `sessionStorage`; closing the browser session removes it.

### Pull / Import

The IDE resolves the branch ref, reads the repository tree and downloads blobs into the real IndexedDB project filesystem.

For mobile safety this build refuses repositories above its current file-count and per-file import safety limits rather than freezing the page.

### Commit & Push

The IDE:

1. reads the current branch ref
2. creates Git blobs for local files
3. creates a new Git tree using the remote tree as base
4. records deletions for remote files no longer present locally
5. creates one commit with the entered commit message
6. fast-forwards the branch ref without force-pushing

It is GitHub API-backed Git synchronization, not fake terminal output.

# 7. iPhone installation

After the GitHub Pages site is live over HTTPS:

1. Open it in Safari.
2. Share.
3. Choose **Add to Home Screen**.
4. Launch the new icon.

The manifest uses standalone display mode and the layout uses safe-area environment variables for the status area and Home indicator.

# 8. Local project safety

Project files are stored in IndexedDB, not only `localStorage`.

Autosave is debounced rather than writing every keystroke. Session metadata records open tabs, active file and expanded Explorer folders. The page also attempts to flush the active file and session metadata when hidden.

For important work, use **Export ZIP** and/or GitHub regularly. Browser storage can still be lost if the user clears Safari website data.

# 9. Preview security

Project output is rendered in a separate sandboxed iframe. The iframe intentionally does not receive `allow-same-origin`, so project code does not share the IDE shell's origin privileges.

The console bridge communicates with `postMessage`. Preview code cannot receive Arena or GitHub secrets because those credentials are not injected into preview HTML.

# 10. Production notes

- Set an exact `ALLOWED_ORIGIN` on the Worker.
- Keep `ARENA_API_KEY` only as a Wrangler secret.
- Keep `ARENA_FREE_ONLY=true` unless you intentionally choose otherwise.
- Populate `ARENA_FREE_MODELS` only from models you verified through your own Arena access.
- Do not commit `.dev.vars`.
- The in-memory rate limiter is lightweight abuse protection, not a global durable rate limiter. For a public high-traffic deployment, add Cloudflare Rate Limiting, Durable Objects or another durable control.
- GitHub writes require a token with appropriate repository permissions.

# 11. Development targets for a later runtime tier

The architecture intentionally leaves Node/npm as a capability boundary. A later version can add a runtime adapter (for example a compatible browser container on supported Chromium devices or a remote sandbox/runtime service) without changing the IndexedDB filesystem, Explorer, editor, Arena agent or GitHub model.

The iPhone path remains useful without that tier: editing, static preview, console, local terminal filesystem commands, AI agent, GitHub sync, ZIP import/export, offline shell and project persistence all remain available.
