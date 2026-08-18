# X Coder 4.5

- UI icons now resolve directly from `andrewtavis/sf-symbols-online` on GitHub.
- Dark theme uses `glyphs_white`; light theme uses `glyphs`.
- Add a new mapped icon by adding one `SF_SYMBOLS` entry, or call `sfSymbolIcon("symbol.name")` directly.
- Optional local `sf-symbols/<name>.svg` assets remain a second fallback.
- Built-in SVGs remain the final fallback so missing network icons never break controls.
- Devicon URLs are pinned to v2.17.0 for Safari reliability instead of `@latest`.
- Language badges are 16px, closer to VS Code file-icon scale.
- Added Node.js icons for package files and Three.js icon detection for Three.js-named source files.
- Removed lazy loading from tiny language icons to avoid Safari delaying them in scroll/overflow containers.
