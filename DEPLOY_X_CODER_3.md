# Deploy X Coder 3.0 Multi-AI

This release keeps the existing Cloudflare Worker service name `arena-pocket-ide-proxy`, so the existing workers.dev URL can stay the same.

## Cloudflare Secrets

X Coder reads these only from the Worker environment. Do not put their values in the frontend or GitHub:

- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `OPENROUTER_API_KEY`
- `MISTRAL_API_KEY`
- `SAMBANOVA_API_KEY`
- `RUNWAY_API_KEY` (optional media provider; not part of coding-chat fallback)

A provider can be missing; Auto Router simply skips routes that are not configured.

## Public provider endpoints

They are already encoded in `worker/src/index.js` and `worker/wrangler.toml`. You do not need to create secrets for the URLs.

## Cloudflare Workers AI

`worker/wrangler.toml` declares:

```toml
[ai]
binding = "AI"
```

The Worker sees this as `env.AI`. The default coding model is currently `@cf/qwen/qwen2.5-coder-32b-instruct`.

## Deploy backend

Commit these exact paths to the repository connected to Cloudflare:

- `worker/src/index.js`
- `worker/wrangler.toml`

Cloudflare should run the existing `npx wrangler deploy` deployment. Existing encrypted secrets are not included in these files.

## Test backend

Open these URLs after deployment:

- `/health` — configured provider overview
- `/providers?probe=1` — actively probes provider catalogs
- `/models?refresh=1` — current text/coding model catalog

Then use **X Coder > Settings > X Coder AI Router > Test Providers**.

## Deploy frontend

Update the GitHub Pages files with the X Coder 3.0 frontend. `sw.js` uses cache version `xcoder-v3.0.0` so the PWA can replace older cached app files.

## Puter

Puter is intentionally not a Cloudflare secret. X Coder loads `https://js.puter.com/v2/` in the browser. Sign in from **Settings > Puter AI** and X Coder calls `puter.ai.listModels()` to populate the Puter model pool.

## Routing behavior

Auto Router:

1. Builds the currently available model catalog.
2. Prefers coding-capable routes.
3. Retries a provider once for temporary server/capacity failures.
4. Moves on immediately for quota, credit, authentication, or persistent availability failures.
5. Keeps the same request, project context, and tool results when switching models/providers.
6. Can hand the same task to Puter if all Worker-backed routes fail and Puter is signed in.

X Coder also stores recent AI conversation context per project, tracks reported token usage when providers return it, and preserves reviewed file changes through Undo/Redo checkpoints.
