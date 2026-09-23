// VS Code–style settings: a registry of schemas (rendered by the Settings editor)
// plus user values persisted in localStorage (read synchronously at boot so the
// theme is applied before first paint).
//
//   settings.register({ key: 'editor.fontSize', type: 'number', default: 13, title: 'Font Size',
//                       description: 'Controls the font size in pixels.', category: 'Text Editor', min: 8, max: 40 })
//   settings.get('editor.fontSize')        → 13
//   settings.set('editor.fontSize', 15)    → persists + emits 'settings:changed'
//   settings.onChange('editor.fontSize', v => …)  → disposer
//
// Types: boolean | number | string | enum (with `enum` + optional `enumLabels`/`enumDescriptions`) | text (multiline) | object | array
// Categories (Settings editor tree): 'Commonly Used' is derived from `common: true`.
//   Text Editor, Workbench, Window, Features/Explorer, Features/Search, Features/Terminal, Features/Preview,
//   Extensions/X Coder AI, Extensions/Git, Extensions/Emmet, Extensions/Voice, Extensions/Cloud

import { bus } from './events.js';

const STORAGE_KEY = 'xcoder.settings.v6';
const schemas = new Map();
let values = {};

function load() {
  try { values = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { values = {}; }
}
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(values)); } catch (err) { console.warn('[X Coder] settings not saved', err); }
}
load();

export const settings = {
  register(...defs) {
    for (const def of defs.flat()) {
      if (!def?.key) continue;
      schemas.set(def.key, { category: 'Workbench', order: 100, ...def });
    }
  },
  schema(key) { return schemas.get(key); },
  /** All registered schemas, sorted by category then order then key. */
  all() {
    return [...schemas.values()].sort((a, b) => a.category.localeCompare(b.category) || (a.order - b.order) || a.key.localeCompare(b.key));
  },
  has(key) { return Object.prototype.hasOwnProperty.call(values, key); },
  get(key, fallback) {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
    const s = schemas.get(key);
    if (s && 'default' in s) return typeof s.default === 'function' ? s.default() : s.default;
    return fallback;
  },
  set(key, value) {
    const s = schemas.get(key);
    if (s) value = coerce(s, value);
    const def = s ? (typeof s.default === 'function' ? s.default() : s.default) : undefined;
    const before = this.get(key);
    if (s && JSON.stringify(value) === JSON.stringify(def)) delete values[key];
    else values[key] = value;
    persist();
    if (JSON.stringify(before) !== JSON.stringify(value)) bus.emit('settings:changed', { key, value });
    return value;
  },
  reset(key) {
    if (!this.has(key)) return;
    delete values[key]; persist();
    bus.emit('settings:changed', { key, value: this.get(key) });
  },
  isModified(key) { return this.has(key); },
  onChange(key, fn) {
    return bus.on('settings:changed', e => {
      if (e.key === key || (key.endsWith('.*') && e.key.startsWith(key.slice(0, -1)))) fn(e.value, e.key);
    });
  },
  /** Raw user values (the contents of "settings.json"). */
  userValues() { return { ...values }; },
  /** Replace all user values (used by the settings.json editor). */
  replaceUserValues(next) {
    const before = { ...values };
    values = { ...(next || {}) };
    persist();
    const keys = new Set([...Object.keys(before), ...Object.keys(values)]);
    for (const key of keys) if (JSON.stringify(before[key]) !== JSON.stringify(values[key])) bus.emit('settings:changed', { key, value: this.get(key) });
  }
};

function coerce(schema, value) {
  switch (schema.type) {
    case 'boolean': return value === true || value === 'true';
    case 'number': {
      let n = Number(value);
      if (!Number.isFinite(n)) n = schema.default;
      if (schema.min != null) n = Math.max(schema.min, n);
      if (schema.max != null) n = Math.min(schema.max, n);
      return schema.integer ? Math.round(n) : n;
    }
    case 'enum': return schema.enum?.includes(value) ? value : schema.default;
    case 'string': case 'text': return value == null ? '' : String(value);
    default: return value;
  }
}

/** One-time migration from X Coder ≤5.1 localStorage keys. */
export function migrateLegacySettings() {
  if (localStorage.getItem('xcoder.settings.migrated.v6')) return;
  const legacy = {};
  const theme = localStorage.getItem('xcoderTheme');
  if (theme === 'light') legacy['workbench.colorTheme'] = 'light-plus';
  else if (theme === 'dark') legacy['workbench.colorTheme'] = 'dark-plus';
  else if (theme === 'system') legacy['window.autoDetectColorScheme'] = true;
  const proxy = localStorage.getItem('xcoderProxyUrl') || localStorage.getItem('arenaProxyUrl');
  if (proxy) legacy['xcoder.ai.routerUrl'] = proxy;
  const sel = localStorage.getItem('xcoderAISelection');
  if (sel) legacy['xcoder.ai.model'] = sel;
  if (localStorage.getItem('xcoderAutoPushAI') === '1') legacy['git.autoPushAIEdits'] = true;
  try {
    const tts = JSON.parse(localStorage.getItem('xcoderTTSv5') || 'null');
    if (tts) {
      if (tts.provider) legacy['xcoder.voice.engine'] = tts.provider;
      if (tts.gender) legacy['xcoder.voice.style'] = tts.gender;
      if (tts.voice) legacy['xcoder.voice.voice'] = tts.voice;
      if (tts.autoSpeak) legacy['xcoder.voice.autoSpeak'] = true;
    }
  } catch {}
  values = { ...legacy, ...values };
  persist();
  localStorage.setItem('xcoder.settings.migrated.v6', '1');
}

/** Migrates the IndexedDB `editorSettings` record from X Coder ≤5.1 (async, after DB opens). */
export async function migrateLegacyEditorSettings(kvGet) {
  if (localStorage.getItem('xcoder.settings.migratedEditor.v6')) return;
  try {
    const ed = await kvGet('editorSettings', null);
    if (ed) {
      if (typeof ed.fontSize === 'number') settings.set('editor.fontSize', ed.fontSize);
      if (typeof ed.wrap === 'boolean') settings.set('editor.wordWrap', ed.wrap ? 'on' : 'off');
      if (typeof ed.accessory === 'boolean') settings.set('editor.accessoryBar', ed.accessory);
      if (ed.extensions?.emmet === false) settings.set('emmet.enabled', false);
      if (ed.extensions?.autoCloseTags === false) settings.set('html.autoClosingTags', false);
    }
    const sort = await kvGet('explorerSort', null);
    if (sort === 'modified') settings.set('explorer.sortOrder', 'modified');
    else if (sort === 'type') settings.set('explorer.sortOrder', 'type');
  } catch {}
  localStorage.setItem('xcoder.settings.migratedEditor.v6', '1');
}
