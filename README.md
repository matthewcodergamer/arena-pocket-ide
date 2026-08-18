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
