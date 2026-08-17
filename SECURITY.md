# Security Notes

- Never place `GEMINI_API_KEY` in frontend files, GitHub Pages variables that are bundled into JavaScript, or project source.
- The Worker rejects origins not listed in `ALLOWED_ORIGIN` / `ALLOWED_ORIGINS`.
- Arena Free Only mode requires an explicit allowlist of model IDs verified by the deployer.
- Project previews run in a sandboxed iframe without `allow-same-origin`.
- GitHub token storage is session-only.
- AI operations are path validated and denied for common secret paths and `.aiignore` patterns.
