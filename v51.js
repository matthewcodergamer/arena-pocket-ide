/* X Coder 5.1 visual/runtime presentation layer.
 * Keeps the working 5.0 IDE core intact while refining the iPhone/desktop experience.
 */
if (!window.__XCODER_V51__) {
  window.__XCODER_V51__ = true;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const iconSvg = {
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/></svg>',
    folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l2-2h3.2l1.8 2H20.5v11H3.5z"/></svg>',
  };

  function injectBranding() {
    const mark = $('.drawer-brand .xcoder-mark');
    if (mark && !$('.drawer-brand .drawer-app-icon')) {
      const img = document.createElement('img');
      img.className = 'drawer-app-icon';
      img.src = './icons/apple-touch-icon.png';
      img.alt = '';
      mark.replaceWith(img);
    }

    const send = $('#aiSendBtn');
    if (send && send.dataset.v51Icon !== '1') {
      send.dataset.v51Icon = '1';
      const caret = send.querySelector('.model-hold-caret');
      send.innerHTML = iconSvg.up;
      if (caret) send.append(caret);
      else send.insertAdjacentHTML('beforeend', '<span class="model-hold-caret" aria-hidden="true"></span>');
    }

    const projectIcon = $('#appDrawer [data-drawer-action="projects"] [data-icon]');
    if (projectIcon && projectIcon.dataset.v51Icon !== '1') {
      projectIcon.dataset.v51Icon = '1';
      projectIcon.innerHTML = iconSvg.folder;
    }
  }

  const badgeMeta = {
    html5:['5','#e34f26','#fff'], css3:['#','#1572b6','#fff'], javascript:['JS','#f7df1e','#161616'],
    typescript:['TS','#3178c6','#fff'], react:['⚛','#20232a','#61dafb'], python:['Py','#3776ab','#fff'],
    java:['J','#e76f00','#fff'], git:['◆','#f05032','#fff'], nodejs:['N','#5fa04e','#fff'],
    threejs:['3','#ededed','#111'], json:['{}','#777','#fff'], markdown:['M','#6d6d72','#fff'],
    vitejs:['V','#646cff','#fff'], npm:['npm','#cb3837','#fff']
  };
  function inferLanguageKey(img) {
    const src = (img.getAttribute('src') || '').toLowerCase();
    return Object.keys(badgeMeta).find(k => src.includes('/' + k + '/')) || '';
  }
  function badge(key) {
    const m = badgeMeta[key] || ['•','#777','#fff'];
    const size = String(m[0]).length > 2 ? 4.5 : 6.2;
    return `<svg class="language-badge v51-language-fallback" viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="2.8" fill="${m[1]}"/><text x="8" y="10.7" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Arial" font-size="${size}" font-weight="800" fill="${m[2]}">${m[0]}</text></svg>`;
  }
  function ensureLanguageFallbacks(root = document) {
    $$('.language-icon-shell', root).forEach(shell => {
      const img = shell.querySelector('img');
      if (!img || shell.querySelector('.v51-language-fallback')) return;
      const key = inferLanguageKey(img);
      if (!key) return;
      shell.insertAdjacentHTML('afterbegin', badge(key));
      const fb = shell.querySelector('.v51-language-fallback');
      const reveal = () => { if (img.complete && img.naturalWidth > 0 && fb) fb.style.visibility = 'hidden'; };
      img.addEventListener('load', reveal, { once:true });
      img.addEventListener('error', () => img.remove(), { once:true });
      reveal();
    });
  }

  function rewriteAIWelcome() {
    const welcome = $('.ai-welcome');
    if (!welcome || welcome.dataset.v51 === '1') return;
    welcome.dataset.v51 = '1';
    const h = welcome.querySelector('h2');
    const p = welcome.querySelector('p');
    if (h) h.textContent = 'What would you like to build?';
    if (p) p.textContent = 'Start a project, fix code, ask a question, or just talk. X Coder keeps the tools close without getting in the way.';
  }

  async function enhanceCodeMirror() {
    const dom = $('.cm-editor');
    if (!dom || dom.dataset.v51Theme === '1') return;
    dom.dataset.v51Theme = '1';
    try {
      const [{EditorView}, {StateEffect, Prec}, {HighlightStyle, syntaxHighlighting}, {tags}] = await Promise.all([
        import('https://esm.sh/@codemirror/view@6.38.1'),
        import('https://esm.sh/@codemirror/state@6.5.2'),
        import('https://esm.sh/@codemirror/language@6.11.3'),
        import('https://esm.sh/@lezer/highlight@1.2.1')
      ]);
      const view = EditorView.findFromDOM(dom);
      if (!view) return;
      const style = HighlightStyle.define([
        {tag:[tags.controlKeyword,tags.definitionKeyword,tags.moduleKeyword],color:'#c586c0'},
        {tag:[tags.keyword,tags.modifier,tags.operatorKeyword],color:'#569cd6'},
        {tag:[tags.function(tags.variableName),tags.function(tags.propertyName)],color:'#dcdcaa'},
        {tag:[tags.propertyName,tags.variableName,tags.definition(tags.variableName)],color:'#9cdcfe'},
        {tag:[tags.typeName,tags.className,tags.namespace],color:'#4ec9b0'},
        {tag:[tags.string,tags.special(tags.string)],color:'#ce9178'},
        {tag:[tags.number,tags.integer,tags.float],color:'#b5cea8'},
        {tag:[tags.comment,tags.lineComment,tags.blockComment],color:'#6a9955',fontStyle:'italic'},
        {tag:[tags.regexp,tags.escape],color:'#d16969'},
        {tag:[tags.tagName,tags.heading],color:'#569cd6'},
        {tag:[tags.attributeName],color:'#9cdcfe'},
        {tag:[tags.bool,tags.null],color:'#569cd6'},
        {tag:[tags.operator,tags.punctuation,tags.bracket],color:'#d4d4d4'}
      ]);
      view.dispatch({ effects: StateEffect.appendConfig.of(Prec.high(syntaxHighlighting(style))) });
    } catch (e) {
      console.warn('[X Coder 5.1] Enhanced syntax theme unavailable:', e);
    }
  }

  function tuneStatus() {
    document.documentElement.dataset.xcoderVersion = '5.1.0';
    const statusLang = $('#statusLanguage');
    if (statusLang) statusLang.title = 'Language mode';
  }

  let raf = 0;
  function refresh() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      injectBranding();
      ensureLanguageFallbacks();
      rewriteAIWelcome();
      enhanceCodeMirror();
      tuneStatus();
    });
  }

  function init() {
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, {childList:true, subtree:true});
    window.addEventListener('pageshow', refresh, {passive:true});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
}
