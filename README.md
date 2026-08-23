# X Coder v4.7

This build improves X Coder AI conversation behavior, progress/status UX, mobile AI layout, proposal visibility, and Undo/Redo clarity. X Coder can now chat normally about off-topic subjects while remaining project-focused when coding work is requested.

# X Coder

X Coder is a mobile-first browser IDE with a local IndexedDB filesystem, CodeMirror editor, live browser preview, GitHub sync, and a multi-provider coding agent.

## X Coder 3.0 AI architecture

```text
X Coder
   ├─ Puter.js (browser/user account)
   └─ existing Cloudflare Worker
        ├─ Groq
        ├─ OpenRouter
        ├─ Mistral
        ├─ SambaNova
        ├─ Google Gemini
        ├─ Cloudflare Workers AI binding
        └─ Runway status/media capability
```

The Worker service is intentionally still named `arena-pocket-ide-proxy` so the existing workers.dev URL does not change. The X Coder product name is independent from that deployment identifier.

## Cloudflare secrets

Add whichever providers you have to the existing Worker as encrypted Secrets:

```text
GEMINI_API_KEY
GROQ_API_KEY
OPENROUTER_API_KEY
MISTRAL_API_KEY
SAMBANOVA_API_KEY
RUNWAY_API_KEY
```

A missing key simply marks that provider as not configured; it does not stop the other routes.

Never put these values in `wrangler.toml`, `app.js`, GitHub Pages, source maps, or the public repository.

## Public provider URLs

The public base URLs live in `worker/wrangler.toml`; they are not secrets. The Worker uses OpenAI-compatible Chat Completions adapters for Groq, OpenRouter, Mistral, and SambaNova and a dedicated adapter for Gemini.

## Cloudflare Workers AI

`worker/wrangler.toml` includes:

```toml
[ai]
binding = "AI"
```

That exposes Workers AI to the Worker as `env.AI` without another API key.

## Puter

The frontend loads:

```html
<script src="https://js.puter.com/v2/"></script>
```

Puter is intentionally not stored in Cloudflare Secrets. The user signs into Puter from X Coder Settings. X Coder can then discover Puter chat models dynamically and use them manually or as a fallback.

## Agent safety and continuity

The AI never directly mutates project files. It returns structured operations such as create, replace, patch, rename, move, delete, and create-folder. X Coder validates them, shows a review/diff, checks source hashes for conflicts, applies only selected operations, and creates an undo checkpoint.

The active agent conversation is stored per project in IndexedDB. If one provider runs out of quota or becomes busy, another provider receives the same current conversation, project context, and tool results rather than restarting the task.

## Runtime features

- HTML/CSS/JavaScript live preview
- JavaScript module and Three.js preview support
- Python preview with Pyodide
- Java source editing/preview (full JVM execution still requires a Java runtime service)
- Local browser terminal commands
- GitHub pull/status/commit/push
- PWA / Add to Home Screen

## X Coder 4.0 appearance and BazaarLink

X Coder 4.0 adds a complete visual refresh based on the supplied mobile references. Appearance can be switched between **System**, **Dark**, and **Light** in Settings. The editor theme follows the selected appearance.

The Cloudflare Worker can now use BazaarLink as another AI route. Add the secret in Cloudflare:

```bash
cd worker
npx wrangler secret put BAZAARLINK_API_KEY
```

The included Worker configuration uses:

```toml
BAZAARLINK_API_BASE = "https://api.bazaarlink.ai/v1"
BAZAARLINK_MODEL = "auto:free"
```

Never put `BAZAARLINK_API_KEY` in frontend JavaScript, GitHub Pages variables that are embedded into the site, or any committed file. It belongs only in the Worker secret store.


# X Coder 4.1 update

- Uses the selected minimalist sledgehammer artwork for all PWA/iOS icons.
- Mobile editor defaults to **no word wrap** so each logical source line keeps one gutter line number, matching the supplied reference design.
- The programming accessory strip only appears while the software keyboard is open in the editor.
- Safari/PWA layout follows `visualViewport` height/offset to remove dead space under the bottom navigation.
- Added more compact Apple-style UI spacing and subtle workspace/menu/modal transitions.
- BazaarLink `auto:free` and OpenRouter free routing are prioritized before single-provider fallbacks when configured.
- Provider settings show specific discovery/error information instead of a vague global failure.

## iPhone install note

To get the app-like standalone layout, open the deployed site in **Safari**, use **Share → Add to Home Screen**, then launch X Coder from the new Home Screen icon. A normal Safari tab will still show Safari's address/navigation UI; a web page cannot remove that browser chrome by itself.

## Cloudflare secret

Keep `BAZAARLINK_API_KEY` as a Cloudflare **Secret**, never a Text variable or frontend value. The frontend only needs the Worker URL.


## X Coder 4.2 editor/UI update

- Interface glyphs use a consistent iOS/SF-Symbols-inspired geometry and weight. Apple SF Symbols themselves are not redistributed in this web project; the web UI uses original SVG glyphs shaped to the same platform conventions.
- Supported source files show technology/language logos from Devicon in the editor title, Explorer, and open-tabs list (HTML, CSS, JavaScript, TypeScript, React JSX/TSX, Python, Java, and Git where applicable).
- Editor syntax color presets: VS Code Dark+, VS Code Light+, GitHub Dark, Dracula, and X Coder.
- The Browser preview now includes Eruda mobile developer tools. The Web Console button opens an interactive console/DOM/network/resources/source inspector inside the running preview. The separate Captured Logs button keeps X Coder's bounded log stream for AI error context.
- A webpage cannot programmatically open Apple's native Safari Web Inspector. On Apple devices the true Safari Web Inspector is attached externally from Safari on a Mac. Eruda is therefore the in-app developer-console implementation.


## X Coder 4.5 icon system

Interface symbols load from the `andrewtavis/sf-symbols-online` GitHub repository at runtime. The app automatically chooses `glyphs_white` in dark mode and `glyphs` in light mode. To add another icon, add an internal-name → SF-Symbol-name entry to `SF_SYMBOLS` in `app.js`, or use `sfSymbolIcon("symbol.name")` directly. If the remote PNG fails, X Coder tries `sf-symbols/<symbol>.svg`, then its built-in SVG fallback.

Programming-language/tool logos use Devicon v2.17.0 and are intentionally rendered at 16px like a compact VS Code file badge. `package.json` and package lockfiles use Node.js identity; Three.js-named source files use the Three.js logo.


# X Coder 4.6 additions

- Fixed Safari CodeMirror startup crash by loading `HighlightStyle`/`syntaxHighlighting` from `@codemirror/language`.
- Added a full Projects workspace so unrelated apps stay separated.
- Added X Coder Cloud sync powered by Puter account authentication and per-user Puter KV storage. The sign-in UI must clearly disclose that Puter provides authentication; X Coder does not impersonate Apple/Google sign-in itself.
- Added a unified IDE Console for Preview, IDE, AI and Cloud messages. The Browser preview still has Eruda for interactive Console/Elements/Network/Resources/Sources.
- AI may request a new project using `project_action:create_project` instead of mixing an unrelated app into the current project.
- AI proposal review is now a full-height mobile sheet so Apply/Reject and diffs remain reachable.
