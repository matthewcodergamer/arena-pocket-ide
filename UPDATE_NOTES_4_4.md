# X Coder 4.4 — Apple-platform design pass

This release rebuilds the visual language around the Apple Developer / SF Symbols references supplied by the user.

## Main changes
- System-style black/white surfaces and semantic iOS label colors
- Apple system-blue active/action color instead of the previous purple-first chrome
- Material header, tab bar, drawer, console, and modal surfaces with restrained blur
- Cleaner edge-to-edge Explorer rows with thin separators and no unnecessary icon cards
- iOS-style bottom tab bar: no floating pills, system-blue selected item
- Settings converted to grouped-list hierarchy rather than dashboard cards
- AI chat flattened so assistant responses read as content while user prompts remain compact bubbles
- Browser and terminal chrome updated to match the same material language
- More deliberate native-feeling motion for view, drawer, and modal transitions
- Light mode receives matching iOS grouped surfaces and system blue
- Desktop keeps professional IDE density while sharing the same design tokens
- Existing SF Symbols adapter and functional IDE systems are preserved

No Apple-owned symbol files are redistributed in this package. Exported SF Symbol SVGs can still be placed in `sf-symbols/` and X Coder will use them automatically.
