# X Coder 4.1

## UI / UX
- Replaced all app icons with the user-selected minimalist builder/sledgehammer icon.
- Fixed mobile visible-viewport sizing for Safari and installed PWA mode.
- Removed permanent coding accessory strip; it now appears only with the software keyboard.
- Disabled word wrap by default and added a one-time migration to fix logical line-number alignment.
- Tightened Explorer, AI, Settings, headers, and bottom navigation to match the supplied Apple/VS Code references.
- Added subtle professional transitions with reduced-motion support.
- Preserved dark/light/system themes.

## AI
- BazaarLink remains a first-class OpenAI-compatible provider using `BAZAARLINK_API_KEY`.
- Auto routing now tries BazaarLink `auto:free` and OpenRouter `openrouter/free` early when configured.
- Provider-level Auto choices are available even when model catalog discovery is incomplete.
- Provider rows show specific configuration/catalog errors.
- Final route errors include sanitized attempted-route information.

## PWA
- Manifest supports standalone mode with fullscreen enhancement where supported.
- Service-worker cache bumped to 4.1.0.


## 4.2.0
- Refined all navigation/action glyphs toward iOS system-symbol proportions and interaction behavior.
- Added real programming-language/tool logos in Editor header, Explorer, and Tabs.
- Added five selectable CodeMirror syntax palettes including VS Code Dark+ and VS Code Light+.
- Added Eruda mobile Web Console for interactive Console, Elements, Network, Resources, and Sources inspection inside project preview.
- Kept captured preview logs separately for AI diagnostics and error-to-AI workflows.
- Improved line-number visual alignment and editor gutter typography.


## 4.3.0 — SF Symbols integration
- Added a dedicated Apple SF Symbols asset adapter for all primary IDE controls.
- Mapped navigation, editor, explorer, browser, AI, terminal, Git, settings, and action icons to SF Symbol names.
- Added graceful built-in icon fallback when an exported Apple symbol is absent.
- Added `sf-symbols/README.md` with the exact exported SVG filenames expected by the browser build.
