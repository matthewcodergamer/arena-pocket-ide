// Document symbols from the syntax tree (Outline view, "@" Go to Symbol, breadcrumbs).
//
//   documentSymbols(state, langId) → [{ name, kind, detail, from, to, selFrom, selTo, children: [] }]
//   symbolPathAt(symbols, pos) → [outer … inner]
//   flattenSymbols(symbols) → [{ ...symbol, depth, container }]
//   SYMBOL_ICON[kind], SYMBOL_GROUP[kind]
//
// Kinds follow VS Code's SymbolKind names. Languages without a lezer grammar fall back to a
// keyword scan (def/func/fun/function/class/struct/…).

import { language as L } from './cm.js';

const { syntaxTree, ensureSyntaxTree } = L;

export const SYMBOL_ICON = {
  file: 'symbol-file', module: 'symbol-module', namespace: 'symbol-namespace', package: 'symbol-package', class: 'symbol-class',
  method: 'symbol-method', property: 'symbol-property', field: 'symbol-field', constructor: 'symbol-constructor', enum: 'symbol-enum',
  interface: 'symbol-interface', function: 'symbol-function', variable: 'symbol-variable', constant: 'symbol-constant',
  string: 'symbol-string', number: 'symbol-number', boolean: 'symbol-boolean', array: 'symbol-array', object: 'symbol-object',
  key: 'symbol-key', null: 'symbol-null', enumMember: 'symbol-enum-member', struct: 'symbol-struct', event: 'symbol-event',
  operator: 'symbol-operator', typeParameter: 'symbol-type-parameter'
};
export const SYMBOL_GROUP = {
  file: 'files', module: 'modules', namespace: 'namespaces', package: 'packages', class: 'classes', method: 'methods',
  property: 'properties', field: 'fields', constructor: 'constructors', enum: 'enumerations', interface: 'interfaces',
  function: 'functions', variable: 'variables', constant: 'constants', string: 'strings', number: 'numbers', boolean: 'booleans',
  array: 'arrays', object: 'objects', key: 'keys', null: 'null', enumMember: 'enumeration members', struct: 'structs',
  event: 'events', operator: 'operators', typeParameter: 'type parameters'
};

const MAX_SYMBOLS = 5000;
const DEF_NAME = /^(VariableDefinition|Definition|DefName|BoundIdentifier|TypeDefinition|PropertyDefinition|PrivatePropertyDefinition)$/;
const OTHER_NAME = /^(VariableName|Identifier|Name|TypeIdentifier|FieldIdentifier|FieldName|PropertyName|TypeName|QualifiedIdentifier|ScopedIdentifier|DestructorName|OperatorName)$/;
const NAME_NODE = new RegExp(`${DEF_NAME.source}|${OTHER_NAME.source}`);

const DECL_KIND = [
  [/^(FunctionDeclaration|FunctionDefinition|FunctionDecl|FunctionItem|FunctionSignature)$/, 'function'],
  [/^(MethodDeclaration|MethodDefinition|MethodDecl|MethodSignature)$/, 'method'],
  [/^ConstructorDeclaration$/, 'constructor'],
  [/^(ClassDeclaration|ClassDefinition|ClassSpecifier|ClassExpression|RecordDeclaration|ObjectDeclaration)$/, 'class'],
  [/^(StructItem|StructSpecifier|UnionSpecifier|UnionItem)$/, 'struct'],
  [/^(InterfaceDeclaration|TraitItem|TraitDeclaration|ProtocolDeclaration)$/, 'interface'],
  [/^(EnumDeclaration|EnumItem|EnumSpecifier)$/, 'enum'],
  [/^(NamespaceDeclaration|NamespaceDefinition|ModuleDeclaration|ModItem|PackageClause)$/, 'namespace'],
  [/^(TypeAliasDeclaration|TypeItem|TypeSpec|TypeDecl)$/, 'typeParameter'],
  [/^ImplItem$/, 'class'],
  [/^(MacroDefinition|MacroRulesDefinition)$/, 'function'],
  [/^(ConstItem|StaticItem)$/, 'constant']
];
function declKind(name) { for (const [re, kind] of DECL_KIND) if (re.test(name)) return kind; return null; }

function text(state, node) { return state.sliceDoc(node.from, node.to); }

/** Finds the declared name node: definitions first, then declarators (C/C++), then plain identifiers. */
function findName(node, depth = 0) {
  for (let c = node.firstChild; c; c = c.nextSibling) if (DEF_NAME.test(c.name)) return c;
  if (depth < 3) {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (/Declarator|Signature|Spec$/.test(c.name)) { const n = findName(c, depth + 1); if (n) return n; }
    }
  }
  for (let c = node.firstChild; c; c = c.nextSibling) if (OTHER_NAME.test(c.name)) return c;
  return null;
}

function sym(name, kind, node, nameNode, detail = '') {
  return { name: String(name).replace(/\s+/g, ' ').trim() || '(anonymous)', kind, detail, from: node.from, to: node.to, selFrom: nameNode ? nameNode.from : node.from, selTo: nameNode ? nameNode.to : node.from, children: [] };
}

function valueKindJS(valueNode) {
  if (!valueNode) return null;
  if (/^(ArrowFunction|FunctionExpression)$/.test(valueNode.name)) return 'function';
  if (valueNode.name === 'ClassExpression') return 'class';
  return null;
}

/** Generic lezer walker (JS/TS/JSX, Python, Java, C/C++, Rust, Go, PHP, …). */
function genericSymbols(state, tree, langId) {
  const out = [];
  let count = 0;
  const walk = (node, parentSym, scope) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (count > MAX_SYMBOLS) return;
      const name = c.name;
      let kind = declKind(name);
      if (kind) {
        const nameNode = findName(c);
        let label = nameNode ? text(state, nameNode) : (name === 'ImplItem' ? '' : '');
        if (name === 'ImplItem') {
          const types = []; for (let t = c.firstChild; t; t = t.nextSibling) if (/TypeIdentifier|GenericType|ScopedTypeIdentifier/.test(t.name)) types.push(text(state, t));
          label = `impl ${types.join(' for ')}`;
        }
        if (!label && name === 'ClassExpression') { walk(c, parentSym, scope); continue; }
        if ((kind === 'function') && (scope === 'class')) kind = 'method';
        if (kind === 'method' && label === 'constructor') kind = 'constructor';
        const s = sym(label, kind, c, nameNode);
        count++;
        (parentSym ? parentSym.children : out).push(s);
        walk(c, s, kind === 'class' || kind === 'struct' || kind === 'interface' || kind === 'enum' ? 'class' : 'function');
        continue;
      }
      // JS/TS variables: `const a = …` (functions/classes anywhere, plain values at top/class level)
      if (name === 'VariableDeclaration' || name === 'LexicalDeclaration') {
        const isConst = /^\s*const\b/.test(state.sliceDoc(c.from, Math.min(c.to, c.from + 6)));
        for (let d = c.firstChild; d; d = d.nextSibling) {
          if (d.name !== 'VariableDefinition') continue;
          let value = d.nextSibling; if (value?.name === 'Equals') value = value.nextSibling;
          if (value?.name === 'TypeAnnotation') { value = value.nextSibling; if (value?.name === 'Equals') value = value.nextSibling; }
          const vk = valueKindJS(value);
          if (!vk && scope === 'function') continue;
          const s = sym(text(state, d), vk || (isConst ? 'constant' : 'variable'), { from: d.from, to: value ? value.to : d.to }, d);
          count++;
          (parentSym ? parentSym.children : out).push(s);
          if (value) walk(value, s, vk === 'class' ? 'class' : vk ? 'function' : 'object');
        }
        continue;
      }
      // JS object literal members (only inside a named symbol)
      if (name === 'Property' && parentSym && scope === 'object') {
        const nameNode = c.firstChild && /PropertyDefinition|PropertyName|String/.test(c.firstChild.name) ? c.firstChild : null;
        if (nameNode) {
          let value = nameNode.nextSibling; if (value?.name === ':') value = value.nextSibling;
          const isMethod = !!c.getChild('ParamList') || valueKindJS(value) === 'function';
          const s = sym(text(state, nameNode).replace(/^['"]|['"]$/g, ''), isMethod ? 'method' : 'property', c, nameNode);
          count++; parentSym.children.push(s);
          if (value && value.name === 'ObjectExpression') walk(value, s, 'object');
          continue;
        }
      }
      // class fields (JS/TS/Java)
      if ((name === 'PropertyDeclaration' || name === 'FieldDeclaration') && parentSym && scope === 'class') {
        const nameNode = findName(c) || c.getChild('VariableDeclarator')?.getChild('Definition');
        if (nameNode) { parentSym.children.push(sym(text(state, nameNode), name === 'FieldDeclaration' ? 'field' : 'property', c, nameNode)); count++; }
        continue;
      }
      if (name === 'EnumBody' || name === 'EnumMemberList') {
        for (let m = c.firstChild; m; m = m.nextSibling) {
          const n = NAME_NODE.test(m.name) ? m : findName(m);
          if (n && parentSym && m.name !== '{' && m.name !== '}') { parentSym.children.push(sym(text(state, n), 'enumMember', m, n)); count++; }
        }
        continue;
      }
      // Python top-level assignments
      if (name === 'AssignStatement' && scope === 'top' && langId === 'python') {
        const target = c.firstChild;
        if (target?.name === 'VariableName') { const nm = text(state, target); out.push(sym(nm, /^[A-Z_][A-Z0-9_]*$/.test(nm) ? 'constant' : 'variable', c, target)); count++; }
        continue;
      }
      if (c.firstChild) walk(c, parentSym, /^(ArrowFunction|FunctionExpression|Lambda|LambdaExpression|ClosureExpression)$/.test(name) ? 'function' : scope);
    }
  };
  walk(tree.topNode, null, 'top');
  return out;
}

function cssSymbols(state, tree) {
  const out = [];
  const walk = (node, parent) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.name === 'RuleSet') {
        const block = c.getChild('Block');
        const label = state.sliceDoc(c.from, block ? block.from : c.to).trim();
        const s = { name: label.replace(/\s+/g, ' '), kind: 'class', detail: '', from: c.from, to: c.to, selFrom: c.from, selTo: c.from + label.length, children: [] };
        (parent ? parent.children : out).push(s);
        if (block) walk(block, s);
      } else if (/^(MediaStatement|KeyframesStatement|SupportsStatement|AtRule|ContainerStatement|LayerStatement)$/.test(c.name)) {
        const block = c.getChild('Block') || c.getChild('KeyframeList');
        const label = state.sliceDoc(c.from, block ? block.from : Math.min(c.to, c.from + 80)).trim().replace(/;$/, '');
        const s = { name: label.replace(/\s+/g, ' '), kind: 'module', detail: '', from: c.from, to: c.to, selFrom: c.from, selTo: c.from + label.length, children: [] };
        (parent ? parent.children : out).push(s);
        if (block) walk(block, s);
      } else if (c.firstChild && c.name !== 'Declaration') walk(c, parent);
    }
  };
  walk(tree.topNode, null);
  return out;
}

function htmlSymbols(state, tree) {
  const out = [];
  let count = 0;
  const walk = (node, parent) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (count > 3000) return;
      if (/^(Element|ScriptElement|StyleElement|TextareaElement)$/.test(c.name) || c.name === 'SelfClosingTag') {
        const open = c.name === 'SelfClosingTag' ? c : (c.getChild('OpenTag') || c.getChild('SelfClosingTag'));
        const tagNode = open?.getChild('TagName');
        if (!tagNode) { walk(c, parent); continue; }
        let label = text(state, tagNode);
        let id = '', cls = '';
        for (let a = open.firstChild; a; a = a.nextSibling) {
          if (a.name !== 'Attribute') continue;
          const an = a.getChild('AttributeName'); const av = a.getChild('AttributeValue') || a.getChild('UnquotedAttributeValue');
          if (!an || !av) continue;
          const key = text(state, an).toLowerCase(); const val = text(state, av).replace(/^['"]|['"]$/g, '').trim();
          if (key === 'id' && val) id = `#${val}`;
          if (key === 'class' && val) cls = '.' + val.split(/\s+/).join('.');
        }
        label += id + cls;
        const s = { name: label, kind: 'field', detail: '', from: c.from, to: c.to, selFrom: tagNode.from, selTo: tagNode.to, children: [] };
        count++;
        (parent ? parent.children : out).push(s);
        if (c.name !== 'SelfClosingTag') walk(c, s);
      } else if (c.firstChild && !/^(OpenTag|CloseTag|Attribute|Text|Comment|ScriptText|StyleText)$/.test(c.name)) walk(c, parent);
    }
  };
  walk(tree.topNode, null);
  return out;
}

function markdownSymbols(state, tree) {
  const out = [];
  const stack = [];
  for (let c = tree.topNode.firstChild; c; c = c.nextSibling) {
    const m = /^(ATXHeading|SetextHeading)(\d)$/.exec(c.name);
    if (!m) continue;
    const level = Number(m[2]);
    const raw = state.sliceDoc(c.from, c.to);
    const label = m[1] === 'ATXHeading' ? raw.replace(/^#+\s*/, '').replace(/\s+#+\s*$/, '') : raw.split('\n')[0];
    const s = { name: label.trim() || '(empty heading)', kind: 'string', detail: '', from: c.from, to: c.to, selFrom: c.from, selTo: c.to, children: [], level };
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(s); else out.push(s);
    stack.push(s);
  }
  // Extend each heading's range to the next heading of the same or a higher level.
  const extend = (list, end) => list.forEach((s, i) => { s.to = i + 1 < list.length ? list[i + 1].from - 1 : end; extend(s.children, s.to); });
  extend(out, state.doc.length);
  return out;
}

function jsonSymbols(state, tree) {
  const out = [];
  let count = 0;
  const kindOf = v => ({ Object: 'module', Array: 'array', String: 'string', Number: 'number', True: 'boolean', False: 'boolean', Null: 'null' }[v?.name] || 'key');
  const walkObject = (obj, parent) => {
    for (let p = obj.firstChild; p; p = p.nextSibling) {
      if (count > MAX_SYMBOLS) return;
      if (p.name !== 'Property') continue;
      const nameNode = p.getChild('PropertyName');
      if (!nameNode) continue;
      let value = nameNode.nextSibling; while (value && (value.name === ':' || value.type.isError)) value = value.nextSibling;
      const s = { name: text(state, nameNode).replace(/^"|"$/g, ''), kind: kindOf(value), detail: '', from: p.from, to: p.to, selFrom: nameNode.from, selTo: nameNode.to, children: [] };
      count++;
      (parent ? parent.children : out).push(s);
      if (value?.name === 'Object') walkObject(value, s);
      else if (value?.name === 'Array') {
        let i = 0;
        for (let item = value.firstChild; item; item = item.nextSibling) {
          if (item.name === 'Object') { const child = { name: String(i), kind: 'module', detail: '', from: item.from, to: item.to, selFrom: item.from, selTo: item.from + 1, children: [] }; s.children.push(child); count++; walkObject(item, child); }
          if (!/^[[\],]$/.test(item.name)) i++;
        }
      }
    }
  };
  const top = tree.topNode.firstChild;
  if (top?.name === 'Object') walkObject(top, null);
  return out;
}

const REGEX_DECL = /^([ \t]*)(?:export\s+|pub(?:\([^)]*\))?\s+)?(?:(?:public|private|protected|internal|static|async|override|open|final|abstract|inline|sealed|data|suspend|virtual|extern|unsafe|local|def\s+self\.)\s+)*(def|func|fun|function|fn|sub|proc|procedure|class|struct|interface|enum|trait|impl|module|namespace|object|protocol|extension|type|macro|defmodule|defp?)\s+([A-Za-z_$][\w$.!?:<>]*)/;
function regexSymbols(state) {
  const out = [];
  const stack = [];
  const doc = state.doc;
  const max = Math.min(doc.lines, 20000);
  for (let i = 1; i <= max && out.length < MAX_SYMBOLS; i++) {
    const line = doc.line(i);
    const m = REGEX_DECL.exec(line.text);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '    ').length;
    const kw = m[2];
    const kind = /^(class|object|impl|type)$/.test(kw) ? 'class' : /^(struct)$/.test(kw) ? 'struct' : /^(interface|trait|protocol)$/.test(kw) ? 'interface' : kw === 'enum' ? 'enum' : /^(module|namespace|defmodule|extension)$/.test(kw) ? 'module' : 'function';
    const nameStart = line.from + line.text.indexOf(m[3], m[1].length);
    const s = { name: m[3], kind, detail: '', from: line.from, to: line.to, selFrom: nameStart, selTo: nameStart + m[3].length, children: [], indent };
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) { if (s.kind === 'function' && /class|struct|interface|module/.test(parent.kind)) s.kind = 'method'; parent.children.push(s); } else out.push(s);
    stack.push(s);
  }
  // Extend ranges to the line before the next sibling (so "symbol at cursor" works).
  const extend = (list, end) => list.forEach((s, i) => { s.to = i + 1 < list.length ? Math.max(s.to, list[i + 1].from - 1) : Math.max(s.to, end); extend(s.children, s.to); });
  extend(out, doc.length);
  return out;
}

const cache = new WeakMap();
/** Symbols for an editor state. `full` forces parsing the whole document (up to a time budget). */
export function documentSymbols(state, langId = '', { full = true } = {}) {
  let tree = full ? (ensureSyntaxTree(state, state.doc.length, 300) || syntaxTree(state)) : syntaxTree(state);
  const hit = cache.get(tree);
  if (hit && hit.lang === langId) return hit.symbols;
  let symbols = [];
  try {
    const top = tree.topNode?.name;
    if (langId === 'markdown') symbols = markdownSymbols(state, tree);
    else if (langId === 'json' || langId === 'jsonc') symbols = jsonSymbols(state, tree);
    else if (top === 'StyleSheet') symbols = cssSymbols(state, tree);
    else if (top === 'Document' && /html|vue|php|xml|ng-template|liquid|jinja/.test(langId)) symbols = htmlSymbols(state, tree);
    else if (langId !== 'plaintext') symbols = genericSymbols(state, tree, langId);
    if (!symbols.length && !['markdown', 'json', 'jsonc', 'plaintext', 'css', 'scss', 'less', 'html', 'xml'].includes(langId)) symbols = regexSymbols(state);
  } catch (err) {
    console.warn('[X Coder] symbol extraction failed', err);
    symbols = [];
  }
  cache.set(tree, { lang: langId, symbols });
  return symbols;
}

/** Innermost chain of symbols containing `pos`. */
export function symbolPathAt(symbols, pos) {
  const path = [];
  let list = symbols;
  while (list?.length) {
    const s = list.find(x => x.from <= pos && pos <= x.to);
    if (!s) break;
    path.push(s);
    list = s.children;
  }
  return path;
}

export function flattenSymbols(symbols, depth = 0, container = '', out = []) {
  for (const s of symbols) {
    out.push({ ...s, depth, container });
    if (s.children?.length) flattenSymbols(s.children, depth + 1, s.name, out);
  }
  return out;
}

export function symbolIcon(kind) { return SYMBOL_ICON[kind] || 'symbol-misc'; }
