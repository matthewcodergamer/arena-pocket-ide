// Editor settings (VS Code keys, titles and descriptions). Values are read live by the editors,
// which reconfigure through Compartments on 'settings:changed' (no editor rebuild).

import { settings } from '../core/settings.js';
import { isPhone, isTouch, isApple } from '../core/dom.js';

export const DEFAULT_FONT_FAMILY = "Menlo, Monaco, 'Courier New', monospace";

export function registerEditorSettings() {
  const phone = isPhone();
  settings.register([
    // ---- Font ----
    { key: 'editor.fontSize', type: 'number', default: phone ? 13 : 14, min: 6, max: 100, integer: true, title: 'Font Size', description: 'Controls the font size in pixels.', category: 'Text Editor/Font', order: 1, common: true },
    { key: 'editor.fontFamily', type: 'string', default: DEFAULT_FONT_FAMILY, title: 'Font Family', description: 'Controls the font family.', category: 'Text Editor/Font', order: 2, common: true },
    { key: 'editor.lineHeight', type: 'number', default: 0, min: 0, max: 150, title: 'Line Height', description: 'Controls the line height. Use 0 to automatically compute the line height from the font size. Values between 0 and 8 will be used as a multiplier with the font size. Values greater than or equal to 8 will be used as effective values.', category: 'Text Editor/Font', order: 3 },
    // ---- Text Editor ----
    { key: 'editor.tabSize', type: 'number', default: 4, min: 1, max: 16, integer: true, title: 'Tab Size', description: 'The number of spaces a tab is equal to. This setting is overridden based on the file contents when "Editor: Detect Indentation" is on.', category: 'Text Editor', order: 1, common: true },
    { key: 'editor.insertSpaces', type: 'boolean', default: true, title: 'Insert Spaces', description: 'Insert spaces when pressing Tab. This setting is overridden based on the file contents when "Editor: Detect Indentation" is on.', category: 'Text Editor', order: 2 },
    { key: 'editor.detectIndentation', type: 'boolean', default: true, title: 'Detect Indentation', description: 'Controls whether "Editor: Tab Size" and "Editor: Insert Spaces" will be automatically detected when a file is opened based on the file contents.', category: 'Text Editor', order: 3 },
    { key: 'editor.wordWrap', type: 'enum', enum: ['off', 'on'], enumDescriptions: ['Lines will never wrap.', 'Lines will wrap at the viewport width.'], default: 'off', title: 'Word Wrap', description: 'Controls how lines should wrap. Like VS Code, lines do not wrap by default (each line keeps one line number); turn this on or press Alt+Z to wrap long lines.', category: 'Text Editor', order: 4, common: true },
    { key: 'editor.lineNumbers', type: 'enum', enum: ['on', 'off', 'relative'], enumDescriptions: ['Line numbers are rendered as absolute number.', 'Line numbers are not rendered.', 'Line numbers are rendered as distance in lines to cursor position.'], default: 'on', title: 'Line Numbers', description: 'Controls the display of line numbers.', category: 'Text Editor', order: 5 },
    { key: 'editor.renderWhitespace', type: 'enum', enum: ['none', 'boundary', 'selection', 'trailing', 'all'], enumDescriptions: ['', 'Render whitespace characters except for single spaces between words.', 'Render whitespace characters only on selected text.', 'Render only trailing whitespace characters.', ''], default: 'selection', title: 'Render Whitespace', description: 'Controls how the editor should render whitespace characters.', category: 'Text Editor', order: 6, common: true },
    { key: 'editor.bracketPairColorization.enabled', type: 'boolean', default: true, title: 'Bracket Pair Colorization', description: 'Controls whether bracket pair colorization is enabled or not.', category: 'Text Editor', order: 7 },
    { key: 'editor.guides.indentation', type: 'boolean', default: true, title: 'Indentation Guides', description: 'Controls whether the editor should render indent guides.', category: 'Text Editor', order: 8 },
    { key: 'editor.cursorBlinking', type: 'enum', enum: ['blink', 'smooth', 'phase', 'expand', 'solid'], default: 'blink', title: 'Cursor Blinking', description: 'Control the cursor animation style.', category: 'Text Editor', order: 9 },
    { key: 'editor.autoClosingBrackets', type: 'enum', enum: ['languageDefined', 'never'], enumDescriptions: ['Use language configurations to determine when to autoclose brackets and quotes.', 'Never autoclose brackets and quotes.'], default: 'languageDefined', title: 'Auto Closing Brackets', description: 'Controls whether the editor should automatically close brackets and quotes after the user adds an opening one.', category: 'Text Editor', order: 10 },
    { key: 'editor.folding', type: 'boolean', default: true, title: 'Folding', description: 'Controls whether the editor has code folding enabled.', category: 'Text Editor', order: 11 },
    { key: 'editor.scrollBeyondLastLine', type: 'boolean', default: true, title: 'Scroll Beyond Last Line', description: 'Controls whether the editor will scroll beyond the last line.', category: 'Text Editor', order: 12 },
    { key: 'editor.accessoryBar', type: 'boolean', default: isTouch(), title: 'Coding Accessory Bar', description: 'Show a row of coding keys (Tab, arrows, brackets, symbols, Undo, Find…) above the on-screen keyboard while a code editor has focus.', category: 'Text Editor', order: 13, common: true },
    { key: 'breadcrumbs.enabled', type: 'boolean', default: true, title: 'Breadcrumbs', description: 'Enable/disable navigation breadcrumbs.', category: 'Workbench', order: 40 },
    // ---- Minimap ----
    { key: 'editor.minimap.enabled', type: 'boolean', default: !phone, title: 'Minimap: Enabled', description: 'Controls whether the minimap is shown.', category: 'Text Editor/Minimap', order: 1 },
    { key: 'editor.minimap.renderCharacters', type: 'boolean', default: true, title: 'Minimap: Render Characters', description: 'Render the actual characters on a line as opposed to color blocks.', category: 'Text Editor/Minimap', order: 2 },
    // ---- Suggestions ----
    { key: 'editor.quickSuggestions', type: 'boolean', default: true, title: 'Quick Suggestions', description: 'Controls whether suggestions should automatically show up while typing.', category: 'Text Editor/Suggestions', order: 1 },
    { key: 'editor.acceptSuggestionOnEnter', type: 'enum', enum: ['on', 'off'], default: 'on', title: 'Accept Suggestion On Enter', description: 'Controls whether suggestions should be accepted on Enter, in addition to Tab.', category: 'Text Editor/Suggestions', order: 2 },
    { key: 'editor.wordBasedSuggestions', type: 'boolean', default: true, title: 'Word Based Suggestions', description: 'Controls whether completions should be computed based on words in the document.', category: 'Text Editor/Suggestions', order: 3 },
    // ---- Formatting ----
    { key: 'editor.formatOnSave', type: 'boolean', default: false, title: 'Format On Save', description: 'Format a file on save. Uses Prettier when it can be downloaded, otherwise the built-in formatter (JSON pretty-printing and re-indentation).', category: 'Text Editor/Formatting', order: 1 },
    // ---- Files ----
    { key: 'files.autoSave', type: 'enum', enum: ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'], enumDescriptions: ['An editor with changes is never automatically saved.', 'An editor with changes is automatically saved after the configured "Files: Auto Save Delay".', 'An editor with changes is automatically saved when the editor loses focus.', 'An editor with changes is automatically saved when the window loses focus.'], default: 'afterDelay', title: 'Auto Save', description: 'Controls auto save of editors that have unsaved changes.', category: 'Text Editor/Files', order: 1, common: true },
    { key: 'files.autoSaveDelay', type: 'number', default: 1000, min: 100, max: 60000, integer: true, title: 'Auto Save Delay', description: 'Controls the delay in milliseconds after which an editor with unsaved changes is saved automatically. Only applies when "Files: Auto Save" is set to "afterDelay".', category: 'Text Editor/Files', order: 2 },
    { key: 'files.trimTrailingWhitespace', type: 'boolean', default: false, title: 'Trim Trailing Whitespace', description: 'When enabled, will trim trailing whitespace when saving a file.', category: 'Text Editor/Files', order: 3 },
    { key: 'files.insertFinalNewline', type: 'boolean', default: false, title: 'Insert Final Newline', description: 'When enabled, insert a final new line at the end of the file when saving it.', category: 'Text Editor/Files', order: 4 },
    // ---- Emmet / HTML ----
    { key: 'emmet.enabled', type: 'boolean', default: true, title: 'Emmet: Enabled', description: 'Expand Emmet abbreviations (for example ul>li*3 or m10) with Tab in HTML, CSS, JSX and Vue files.', category: 'Extensions/Emmet', order: 1 },
    { key: 'html.autoClosingTags', type: 'boolean', default: true, title: 'Auto Closing Tags', description: 'Enable/disable autoclosing of HTML tags.', category: 'Extensions/HTML', order: 1 }
  ]);
}

/** Effective font metrics (VS Code's line-height rules). */
export function fontMetrics(zoom = 0) {
  const size = Math.max(6, Math.min(100, Number(settings.get('editor.fontSize')) + zoom));
  const family = String(settings.get('editor.fontFamily') || '').trim() || DEFAULT_FONT_FAMILY;
  const lh = Number(settings.get('editor.lineHeight')) || 0;
  let lineHeight;
  if (lh <= 0) lineHeight = Math.round(size * (isApple ? 1.5 : 1.35));
  else if (lh < 8) lineHeight = Math.round(size * lh);
  else lineHeight = Math.round(lh);
  return { size, family, lineHeight: Math.max(lineHeight, size) };
}
