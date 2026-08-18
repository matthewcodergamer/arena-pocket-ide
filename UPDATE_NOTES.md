# X Coder 3.0 — Multi-AI Router

This release upgrades X Coder from a Gemini-only coding agent into a multi-provider AI system with automatic fallback and Puter integration.

## AI router

The existing Cloudflare Worker service name remains `arena-pocket-ide-proxy` so the current workers.dev URL keeps working. The Worker now supports these encrypted secrets when present:

- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `OPENROUTER_API_KEY`
- `MISTRAL_API_KEY`
- `SAMBANOVA_API_KEY`
- `RUNWAY_API_KEY` (recognized as a media provider; not used for coding-chat fallback)

The Worker also declares a native Cloudflare Workers AI binding named `AI`, which requires no separate API key.

## Routing behavior

- `GET /health` reports the router and configured providers without exposing secrets.
- `GET /providers?probe=1` refreshes provider/model-catalog health.
- `GET /models?refresh=1` builds the current model catalog.
- `POST /agent` and `POST /chat` can use Auto Router or a requested provider/model.
- Auto Router keeps the same request/context while moving to another provider after quota, credit, rate-limit, high-demand, timeout, or service errors.
- Provider failures use short cooldowns so a provider that just failed is not hammered repeatedly.
- OpenRouter Auto mode prefers free models / `openrouter/free` while `FREE_ONLY=true`.

## Puter

Puter.js is loaded directly in the X Coder frontend. It requires no Cloudflare API secret. A user can sign in from Settings and X Coder then discovers the models currently exposed by `puter.ai.listModels()`.

Puter can be selected manually or used as a final fallback if all Worker-backed text routes fail. Project context and tool results are preserved during the handoff.

## Frontend improvements

- Compact model picker in the AI status bar.
- Auto Router, Worker models, Puter Auto, and Puter models are available from one selector.
- Provider status dashboard in Settings.
- Background provider refresh every five minutes while the app is online.
- Persistent AI conversation per project in IndexedDB, so provider switching or reloading does not wipe the working conversation.
- Friendly working-status messages while a request is in progress.
- Assistant messages record which provider/model completed the request.
- AI file operations still require review before apply and retain conflict-hash protection.
- Undo + Redo for the latest reviewed AI change set.

## PWA

Service-worker cache version is now `xcoder-v3.0.0` so iOS installs update the new JavaScript and UI.

## Deployment helper

See `DEPLOY_X_CODER_3.md` for the exact Worker/frontend deployment order and health-test URLs.

# X Coder 4.0 — UI/UX + BazaarLink update

- Rebuilt the visual layer around the supplied iPhone references: flatter Apple-like surfaces, denser VS Code-style information hierarchy, compact toolbars, consistent outline SVG icons, smaller file rows, and a more full-screen editor.
- Added System / Dark / Light appearance modes with live editor theme updates.
- Reworked the AI screen into a cleaner assistant conversation layout with a centered empty state, starter actions, subtle thinking animation, compact context chips, and safer/more useful error messages.
- Added a persistent network status indicator and improved online/offline behavior.
- Added a short polished boot animation instead of flashing partially initialized UI.
- Preserved project storage, preview, terminal, Git/GitHub, AI proposals, diffs, checkpoints, and PWA behavior.
- Added BazaarLink as a Worker AI provider using `BAZAARLINK_API_KEY`, `BAZAARLINK_API_BASE`, and `BAZAARLINK_MODEL`.
- Defaults BazaarLink to `auto:free`. When `FREE_ONLY=true`, X Coder also sends `X-Free-Fallback: false` so a free-route request does not intentionally fall through to paid balance.
- Increased automatic provider route attempts to 8 so the new provider can participate without removing existing fallbacks.
- Bumped the service-worker cache to `xcoder-v4.0.0` so deployed devices pick up the redesign instead of staying on the cached v3 shell.
