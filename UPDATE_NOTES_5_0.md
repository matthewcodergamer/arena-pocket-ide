# X Coder 5.0

- Long-press the AI send button for a ChatGPT-style quick model switcher built only from models actually available in X Coder.
- Added natural text-to-speech with Puter TTS and device speech fallback, male/female/auto voice styles, per-reply Read Aloud, auto-speak, preview and stop controls.
- Puter chat calls request high reasoning effort when the selected model supports it.
- Added optional auto-push of approved AI edits using the repository and GitHub token configured in X Coder's Git screen.
- The v5 UI layer self-installs its controls so older GitHub Pages shells can upgrade safely.
- Service-worker cache updated to `xcoder-v5.0.0` and progressively layers v5 JS/CSS over the existing v4.9 shell.
