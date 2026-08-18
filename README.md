# X Coder icon overrides

X Coder 4.5 loads interface glyph PNGs directly from:

`https://github.com/andrewtavis/sf-symbols-online`

Dark mode uses `glyphs_white/<symbol>.png`; light mode uses `glyphs/<symbol>.png`.

## Add another icon

Open `app.js` and add one mapping to `SF_SYMBOLS`, for example:

```js
preview: 'eye'
```

Then use `svgIcon('preview')` anywhere in the interface.

For one-off symbols you can use `sfSymbolIcon('eye')` directly without adding a map entry.

## Optional local override

If the remote GitHub image is unavailable, X Coder next checks this folder for `<symbol-name>.svg`, then uses the built-in fallback SVG. This means adding icons never makes the app fragile.
