// Settings editor model: category tree (TOC), display labels ("Editor: Font Size") and search.

import { settings } from '../../core/settings.js';

export const COMMONLY_USED = 'Commonly Used';
const TOP_ORDER = [COMMONLY_USED, 'Text Editor', 'Workbench', 'Window', 'Features', 'Application', 'Security', 'Extensions'];
const SEGMENT_NAMES = {
  xcoder: 'X Coder', ai: 'AI', scm: 'SCM', html: 'HTML', css: 'CSS', json: 'JSON', url: 'URL', api: 'API', tts: 'TTS',
  github: 'GitHub', javascript: 'JavaScript', typescript: 'TypeScript', eol: 'EOL', ui: 'UI'
};

export function humanize(segment = '') {
  if (SEGMENT_NAMES[segment.toLowerCase()]) return SEGMENT_NAMES[segment.toLowerCase()];
  const words = segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .split(' ').filter(Boolean)
    .map(w => SEGMENT_NAMES[w.toLowerCase()] || (w[0].toUpperCase() + w.slice(1)));
  return words.join(' ');
}

/** VS Code-style label: { category: 'Editor › Minimap', title: 'Enabled' } derived from the key. */
export function settingLabel(schema) {
  const segs = schema.key.split('.');
  const last = segs.pop();
  let title = schema.title || humanize(last);
  const cats = segs.map(humanize);
  // A title like "Minimap: Enabled" already names its group → "Editor › Minimap: Enabled".
  const colon = title.lastIndexOf(': ');
  if (colon > 0) {
    const group = title.slice(0, colon);
    title = title.slice(colon + 2);
    if (!cats.length || cats.at(-1).toLowerCase() !== group.toLowerCase()) cats.push(group);
  } else if (cats.length > 1) {
    // "editor.guides.indentation" titled "Indentation Guides" reads better as "Editor: Indentation Guides".
    const lastCat = cats.at(-1).toLowerCase();
    if (title.toLowerCase().split(/\s+/).some(w => w === lastCat || lastCat.split(' ').every(p => title.toLowerCase().includes(p)))) cats.pop();
  }
  return { category: cats.join(' › '), title };
}

function topRank(name) { const i = TOP_ORDER.indexOf(name); return i < 0 ? TOP_ORDER.length - 1 : i; }

/**
 * Builds the TOC tree:
 * [{ id, label, level: 1, settings: [schema], children: [{ id, label, level: 2, settings }] }]
 */
export function buildTree(schemas = settings.all()) {
  const tops = new Map();
  const ensureTop = name => {
    if (!tops.has(name)) tops.set(name, { id: `toc:${name}`, label: name, level: 1, settings: [], children: new Map() });
    return tops.get(name);
  };
  const common = schemas.filter(s => s.common).sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.key.localeCompare(b.key));
  if (common.length) ensureTop(COMMONLY_USED).settings.push(...common);
  for (const s of schemas) {
    const parts = String(s.category || 'Workbench').split('/').map(p => p.trim()).filter(Boolean);
    const top = ensureTop(parts[0] || 'Workbench');
    if (parts.length < 2) { top.settings.push(s); continue; }
    const subName = parts.slice(1).join(' › ');
    if (!top.children.has(subName)) top.children.set(subName, { id: `toc:${parts[0]}/${subName}`, label: subName, level: 2, settings: [], parent: top });
    top.children.get(subName).settings.push(s);
  }
  const bySort = (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.key.localeCompare(b.key);
  const out = [...tops.values()].map(t => {
    if (t.label !== COMMONLY_USED) t.settings.sort(bySort);
    const children = [...t.children.values()].sort((a, b) => a.label.localeCompare(b.label));
    for (const c of children) c.settings.sort(bySort);
    return { ...t, children };
  });
  out.sort((a, b) => topRank(a.label) - topRank(b.label) || a.label.localeCompare(b.label));
  return out;
}

/** Top-level + second-level section that a setting belongs to (not Commonly Used). */
export function sectionOf(schema) {
  const parts = String(schema.category || 'Workbench').split('/').map(p => p.trim()).filter(Boolean);
  return { top: parts[0] || 'Workbench', sub: parts.length > 1 ? parts.slice(1).join(' › ') : null };
}

/**
 * Parses a Settings search query: plain words (AND, case-insensitive) plus filters
 * `@modified` and `@id:key1,key2`.
 */
export function parseQuery(query = '') {
  const out = { words: [], modified: false, ids: null, raw: query.trim() };
  for (const token of query.trim().split(/\s+/).filter(Boolean)) {
    if (token.toLowerCase() === '@modified') out.modified = true;
    else if (/^@id:/i.test(token)) { const ids = token.slice(4).split(',').map(s => s.trim()).filter(Boolean); if (ids.length) out.ids = ids; }
    else out.words.push(token.toLowerCase());
  }
  return out;
}
export function isSearching(q) { return !!(q.words.length || q.modified || q.ids); }

/** Score of a setting for a query (-1 = no match). Higher scores sort first. */
export function scoreSetting(schema, q) {
  if (q.modified && !settings.isModified(schema.key)) return -1;
  if (q.ids && !q.ids.some(id => schema.key === id || schema.key.startsWith(id.endsWith('.') ? id : id + '.'))) return -1;
  if (!q.words.length) return 1;
  const { category, title } = settingLabel(schema);
  const key = schema.key.toLowerCase();
  const label = `${category} ${title}`.toLowerCase();
  const compactLabel = label.replace(/\s+/g, '');
  const desc = String(schema.description || '').toLowerCase();
  const extra = [...(schema.enum || []), ...(schema.enumLabels || []), schema.category || ''].join(' ').toLowerCase();
  let score = 0;
  for (const w of q.words) {
    if (key === w) score += 1000;
    else if (title.toLowerCase().includes(w)) score += 60;
    else if (key.includes(w) || compactLabel.includes(w)) score += 40;
    else if (label.includes(w)) score += 30;
    else if (desc.includes(w)) score += 10;
    else if (extra.includes(w)) score += 5;
    else return -1;
  }
  const phrase = q.words.join(' ');
  if (title.toLowerCase() === phrase) score += 200;
  else if (title.toLowerCase().includes(phrase)) score += 100;
  return score;
}

/** Search results sorted by score (stable within equal scores by tree order). */
export function search(schemas, q) {
  return schemas
    .map((s, i) => ({ s, i, score: scoreSetting(s, q) }))
    .filter(r => r.score >= 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(r => r.s);
}

/** Default value of a schema (defaults may be functions). */
export function defaultOf(schema) { return typeof schema.default === 'function' ? schema.default() : schema.default; }
