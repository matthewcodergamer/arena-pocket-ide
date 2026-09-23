// Puter.js loader. Puter provides the optional X Coder Cloud account (sign-in, cloud sync)
// and browser-side AI models/voices. The script loads asynchronously so a slow or blocked
// network never delays the IDE; call `getPuter()` whenever you need it.

let pending = null;

/** Resolves with window.puter, or null if it cannot load within `timeoutMs`. */
export function getPuter(timeoutMs = 12000) {
  if (window.puter) return Promise.resolve(window.puter);
  if (pending) return pending;
  pending = new Promise(resolve => {
    let script = document.getElementById('puter-js');
    if (!script) {
      script = document.createElement('script');
      script.id = 'puter-js';
      script.src = 'https://js.puter.com/v2/';
      script.async = true;
      document.head.append(script);
    }
    const done = () => { clearTimeout(timer); clearInterval(poll); resolve(window.puter || null); };
    const timer = setTimeout(done, timeoutMs);
    const poll = setInterval(() => { if (window.puter) done(); }, 200);
    script.addEventListener('load', () => setTimeout(done, 0), { once: true });
    script.addEventListener('error', done, { once: true });
  }).then(p => { if (!p) pending = null; return p; });
  return pending;
}

export function puterSignedIn() {
  try { return !!window.puter?.auth?.isSignedIn?.(); } catch { return false; }
}
