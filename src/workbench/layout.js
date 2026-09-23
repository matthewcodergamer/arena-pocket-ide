// Workbench layout: part visibility, sizes (sashes), phone overlay mode, and the
// iOS visual-viewport handling that keeps the editor above the software keyboard.
//
//   layout.setSidebarVisible(true) / toggleSidebar()
//   layout.setPanelVisible(true)   / togglePanel() / togglePanelMaximized()
//   layout.setAuxVisible(true)     / toggleAux()
//   layout.isPhone                 → narrow overlay layout active
//   layout.keyboardOpen            → iOS/Android software keyboard visible
// Emits bus 'layout:changed' and 'keyboard:changed'.

import { $, clamp, isPhone, isIOS, isStandalone, debounce } from '../core/dom.js';
import { bus } from '../core/events.js';

const STORE = 'xcoder.layout.v6';
const defaults = { sidebarWidth: 280, panelHeight: 260, auxWidth: 380, sidebar: true, panel: false, aux: false, panelMaximized: false };

export const layout = {
  state: { ...defaults },
  isPhone: false,
  keyboardOpen: false,
  keyboardHeight: 0,
  el: null,

  init() {
    try { Object.assign(this.state, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch {}
    this.el = $('#workbench');
    this.isPhone = isPhone();
    // On a phone, never start with overlays covering the editor.
    if (this.isPhone) { this.state.sidebar = false; this.state.aux = false; }
    document.documentElement.classList.toggle('ios', isIOS);
    document.documentElement.classList.toggle('standalone', isStandalone());
    this.apply();
    this.setupSashes();
    this.setupViewport();
    const onResize = debounce(() => {
      const phone = isPhone();
      if (phone !== this.isPhone) {
        this.isPhone = phone;
        if (phone) { this.state.sidebar = false; this.state.aux = false; }
      }
      this.apply();
    }, 60);
    window.addEventListener('resize', onResize);
    $('#overlay-backdrop')?.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (this.state.aux) this.setAuxVisible(false); else this.setSidebarVisible(false);
    });
  },

  save() { try { localStorage.setItem(STORE, JSON.stringify(this.state)); } catch {} },

  apply() {
    const s = this.state, el = this.el;
    if (!el) return;
    el.classList.toggle('phone', this.isPhone);
    el.classList.toggle('desktop', !this.isPhone);
    el.classList.toggle('nosidebar', !s.sidebar);
    el.classList.toggle('nopanel', !s.panel);
    el.classList.toggle('noauxiliarybar', !s.aux);
    el.classList.toggle('panel-maximized', !!(s.panel && s.panelMaximized));
    el.classList.toggle('overlay-open', this.isPhone && (s.sidebar || s.aux));
    const vw = window.innerWidth;
    const side = clamp(s.sidebarWidth, 170, Math.max(200, vw * 0.6));
    const aux = clamp(s.auxWidth, 260, Math.max(300, vw * 0.6));
    el.style.setProperty('--sidebar-width', `${side}px`);
    el.style.setProperty('--aux-width', `${aux}px`);
    el.style.setProperty('--panel-height', `${clamp(s.panelHeight, 100, 2000)}px`);
    bus.emit('layout:changed', { sidebar: s.sidebar, panel: s.panel, aux: s.aux, phone: this.isPhone, maximized: s.panelMaximized });
  },

  get sidebarVisible() { return this.state.sidebar; },
  get panelVisible() { return this.state.panel; },
  get auxVisible() { return this.state.aux; },
  get panelMaximized() { return this.state.panelMaximized; },

  setSidebarVisible(v) {
    this.state.sidebar = !!v;
    if (v && this.isPhone) this.state.aux = false; // one overlay at a time on phones
    this.save(); this.apply();
  },
  toggleSidebar() { this.setSidebarVisible(!this.state.sidebar); },
  setPanelVisible(v) { this.state.panel = !!v; if (!v) this.state.panelMaximized = false; this.save(); this.apply(); },
  togglePanel() { this.setPanelVisible(!this.state.panel); },
  togglePanelMaximized(force) {
    this.state.panelMaximized = force ?? !this.state.panelMaximized;
    if (this.state.panelMaximized) this.state.panel = true;
    this.save(); this.apply();
  },
  setAuxVisible(v) {
    this.state.aux = !!v;
    if (v && this.isPhone) this.state.sidebar = false;
    this.save(); this.apply();
  },
  toggleAux() { this.setAuxVisible(!this.state.aux); },
  /** On phones the side bar is an overlay; close it after the user picks something. */
  dismissOverlays() { if (this.isPhone && (this.state.sidebar || this.state.aux)) { this.state.sidebar = false; this.state.aux = false; this.save(); this.apply(); } },

  setupSashes() {
    const drag = (sash, onMove) => {
      if (!sash) return;
      sash.addEventListener('pointerdown', e => {
        if (this.isPhone) return;
        e.preventDefault();
        sash.setPointerCapture(e.pointerId);
        sash.classList.add('active');
        document.body.classList.add('sash-dragging');
        const move = ev => onMove(ev);
        const up = () => {
          sash.classList.remove('active');
          document.body.classList.remove('sash-dragging');
          sash.removeEventListener('pointermove', move);
          sash.removeEventListener('pointerup', up);
          sash.removeEventListener('pointercancel', up);
          this.save();
        };
        sash.addEventListener('pointermove', move);
        sash.addEventListener('pointerup', up);
        sash.addEventListener('pointercancel', up);
      });
    };
    drag($('#sash-sidebar'), e => {
      const left = $('#activitybar').getBoundingClientRect().right;
      this.state.sidebarWidth = clamp(e.clientX - left, 170, window.innerWidth * 0.6);
      this.apply();
    });
    drag($('#sash-aux'), e => {
      this.state.auxWidth = clamp(window.innerWidth - e.clientX, 260, window.innerWidth * 0.6);
      this.apply();
    });
    drag($('#sash-panel'), e => {
      const col = $('#main-column').getBoundingClientRect();
      this.state.panelHeight = clamp(col.bottom - e.clientY, 100, col.height - 80);
      this.state.panelMaximized = false;
      this.apply();
    });
    for (const id of ['#sash-sidebar', '#sash-aux', '#sash-panel']) {
      $(id)?.addEventListener('dblclick', () => {
        if (id === '#sash-sidebar') this.state.sidebarWidth = defaults.sidebarWidth;
        if (id === '#sash-aux') this.state.auxWidth = defaults.auxWidth;
        if (id === '#sash-panel') this.state.panelHeight = defaults.panelHeight;
        this.save(); this.apply();
      });
    }
  },

  /**
   * iOS Safari does not shrink the layout viewport when the keyboard opens, it scrolls
   * the page instead. We pin the workbench to the *visual* viewport so the editor, the
   * coding accessory bar and chat input stay visible directly above the keyboard.
   */
  setupViewport() {
    const root = document.documentElement;
    const vv = window.visualViewport;
    const update = () => {
      const height = vv ? vv.height : window.innerHeight;
      const top = vv ? vv.offsetTop : 0;
      const keyboard = Math.max(0, window.innerHeight - height - top);
      const open = keyboard > 120;
      root.style.setProperty('--vvh', `${Math.round(height)}px`);
      root.style.setProperty('--vv-top', `${Math.round(top)}px`);
      root.style.setProperty('--keyboard-height', `${Math.round(keyboard)}px`);
      if (open !== this.keyboardOpen || Math.abs(keyboard - this.keyboardHeight) > 20) {
        this.keyboardOpen = open; this.keyboardHeight = keyboard;
        document.body.classList.toggle('keyboard-open', open);
        bus.emit('keyboard:changed', { open, height: keyboard });
      }
      // iOS scrolls the document when focusing inputs near the bottom; the workbench is
      // position:fixed and follows the visual viewport, so undo any document scroll.
      if (window.scrollY !== 0 && !vv) window.scrollTo(0, 0);
    };
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', () => setTimeout(update, 250));
    document.addEventListener('focusin', () => setTimeout(update, 50));
    document.addEventListener('focusout', () => setTimeout(update, 120));
    update();
  }
};
