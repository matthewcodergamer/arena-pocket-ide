// Color theme selection (Preferences: Color Theme).

import { settings } from '../core/settings.js';
import { bus } from '../core/events.js';
import { clearFileIconCache } from './icons.js';

export const THEMES = [
  { id: 'dark-plus', label: 'Dark+', description: 'Default Dark+ (classic)', type: 'dark' },
  { id: 'dark-modern', label: 'Dark Modern', description: 'Default Dark Modern', type: 'dark' },
  { id: 'light-plus', label: 'Light+', description: 'Default Light+ (classic)', type: 'light' },
  { id: 'light-modern', label: 'Light Modern', description: 'Default Light Modern', type: 'light' },
  { id: 'hc-black', label: 'Dark High Contrast', description: 'Default High Contrast', type: 'hc' }
];

settings.register([
  { key: 'workbench.colorTheme', type: 'enum', enum: THEMES.map(t => t.id), enumLabels: THEMES.map(t => t.label), default: 'dark-plus', title: 'Color Theme', description: 'Specifies the color theme used in the workbench.', category: 'Workbench/Appearance', common: true, order: 1 },
  { key: 'window.autoDetectColorScheme', type: 'boolean', default: false, title: 'Auto Detect Color Scheme', description: 'If set, automatically switch to the preferred color theme based on the OS appearance (iOS Light/Dark Mode).', category: 'Window', common: true, order: 2 },
  { key: 'workbench.preferredDarkColorTheme', type: 'enum', enum: THEMES.filter(t => t.type !== 'light').map(t => t.id), enumLabels: THEMES.filter(t => t.type !== 'light').map(t => t.label), default: 'dark-plus', title: 'Preferred Dark Color Theme', description: 'Specifies the preferred color theme for dark OS appearance when Auto Detect Color Scheme is enabled.', category: 'Workbench/Appearance', order: 3 },
  { key: 'workbench.preferredLightColorTheme', type: 'enum', enum: THEMES.filter(t => t.type === 'light').map(t => t.id), enumLabels: THEMES.filter(t => t.type === 'light').map(t => t.label), default: 'light-plus', title: 'Preferred Light Color Theme', description: 'Specifies the preferred color theme for light OS appearance when Auto Detect Color Scheme is enabled.', category: 'Workbench/Appearance', order: 4 }
]);

const media = matchMedia('(prefers-color-scheme: light)');

export function currentThemeId() {
  if (settings.get('window.autoDetectColorScheme')) {
    return media.matches ? settings.get('workbench.preferredLightColorTheme') : settings.get('workbench.preferredDarkColorTheme');
  }
  return settings.get('workbench.colorTheme');
}
export function currentTheme() { return THEMES.find(t => t.id === currentThemeId()) || THEMES[0]; }

let previewId = null;
/** Applies a theme; pass an id to preview it temporarily (quick pick live preview). */
export function applyTheme(preview = null) {
  previewId = preview;
  const theme = THEMES.find(t => t.id === (preview || currentThemeId())) || THEMES[0];
  const root = document.documentElement;
  const changed = root.dataset.theme !== theme.id;
  root.dataset.theme = theme.id;
  root.dataset.themeType = theme.type === 'light' ? 'light' : 'dark';
  root.classList.toggle('vs', theme.type === 'light');
  root.classList.toggle('vs-dark', theme.type === 'dark');
  root.classList.toggle('hc-black', theme.type === 'hc');
  root.style.colorScheme = theme.type === 'light' ? 'light' : 'dark';
  // Safari toolbar / iOS status bar tint follows the activity bar + title bar color.
  requestAnimationFrame(() => {
    const color = getComputedStyle(root).getPropertyValue('--vscode-titleBar-activeBackground').trim() || '#1e1e1e';
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', color));
  });
  if (changed) { clearFileIconCache(); bus.emit('theme:changed', { id: theme.id, type: theme.type }); }
  return theme;
}

export function initTheme() {
  applyTheme();
  media.addEventListener?.('change', () => { if (!previewId && settings.get('window.autoDetectColorScheme')) applyTheme(); });
  for (const key of ['workbench.colorTheme', 'window.autoDetectColorScheme', 'workbench.preferredDarkColorTheme', 'workbench.preferredLightColorTheme']) {
    settings.onChange(key, () => applyTheme());
  }
}
