// Voice for X Coder AI: text-to-speech (Read Aloud) and dictation (voice input).
//
// Speech engines (setting xcoder.voice.engine):
//   'auto'   natural Puter voices when signed in to X Coder Cloud, otherwise the device voice
//   'puter'  puter.ai.txt2speech(text, { provider, voice })
//   'device' speechSynthesis with a voice matching xcoder.voice.style ('female' | 'male' | 'auto')
// xcoder.voice.voice pins a voice: 'puter|<provider>|<id>' or 'device|Device|<voiceURI>' ('' = automatic).
//
//   await voice.speak(text)     voice.stop()     voice.speaking     voice.events.on('change', fn)
//   voice.dictationSupported()  → 'speech' | 'puter' | null
//   const d = voice.startDictation({ onText(finalText, interim), onEnd(err?) });  d.stop()
//   await voice.configure()     quick pick hub: engine, style, voice (with preview), rate, auto speak

import { settings } from '../core/settings.js';
import { Emitter } from '../core/events.js';
import { getPuter, puterSignedIn } from '../core/puter.js';
import { output } from '../core/output.js';
import { speechText } from './markdown.js';

const log = output.channel('X Coder AI');
const CATEGORY = 'Extensions/Voice';
const FEMALE = /samantha|victoria|karen|moira|tessa|serena|ava|allison|susan|zira|fiona|kate|joanna|salli|kimberly|ivy|emma|amy|nicole|ara|eve|nova|shimmer|female|woman|aria|jenny|sonia|libby|natasha|siri.*female/;
const MALE = /daniel|alex|fred|tom|aaron|arthur|lee|rishi|david|mark|george|matthew|brian|joey|justin|rex|leo|onyx|ash|echo|male|guy|ryan|thomas|oliver|gordon/;

export function registerVoiceSettings() {
  settings.register([
    { key: 'xcoder.voice.engine', type: 'enum', default: 'auto', title: 'Engine', category: CATEGORY, order: 1,
      enum: ['auto', 'puter', 'device'], enumLabels: ['Automatic', 'Natural Voices (Puter)', 'Device Voice'],
      enumDescriptions: ['Natural Puter voices when you are signed in to X Coder Cloud, otherwise the device voice.', 'Always use natural Puter voices (requires X Coder Cloud sign-in).', 'Always use the voices built into this device.'],
      description: 'Which speech engine reads X Coder AI answers aloud.' },
    { key: 'xcoder.voice.style', type: 'enum', default: 'female', title: 'Style', category: CATEGORY, order: 2,
      enum: ['female', 'male', 'auto'], enumLabels: ['Female', 'Male', 'Automatic'], description: 'Preferred voice style when no specific voice is selected.' },
    { key: 'xcoder.voice.voice', type: 'string', default: '', title: 'Voice', category: CATEGORY, order: 3,
      description: 'A specific voice ("puter|<provider>|<id>" or "device|Device|<voice>"). Leave empty to choose automatically. Use "Voice: Configure Voice" to pick one with a preview.' },
    { key: 'xcoder.voice.autoSpeak', type: 'boolean', default: false, title: 'Auto Speak', category: CATEGORY, order: 4,
      description: 'Read every X Coder AI answer aloud when it finishes.' },
    { key: 'xcoder.voice.rate', type: 'number', default: 1, min: 0.5, max: 2, title: 'Rate', category: CATEGORY, order: 5,
      description: 'Speaking rate of the device voice (0.5 – 2).' }
  ]);
}

const cfg = () => {
  let engine = settings.get('xcoder.voice.engine', 'auto');
  if (engine === 'browser') engine = 'device'; // X Coder 5 value
  return {
    engine: ['auto', 'puter', 'device'].includes(engine) ? engine : 'auto',
    style: settings.get('xcoder.voice.style', 'female'),
    voice: String(settings.get('xcoder.voice.voice', '') || '').replace(/^browser\|/, 'device|'),
    rate: Math.min(2, Math.max(0.5, Number(settings.get('xcoder.voice.rate', 1)) || 1)),
    autoSpeak: !!settings.get('xcoder.voice.autoSpeak', false)
  };
};

export function guessGender(v = {}) {
  const n = `${v.name || ''} ${v.voiceURI || ''} ${v.id || ''} ${v.gender || ''}`.toLowerCase();
  if (/\bfemale\b/.test(n) || FEMALE.test(n)) return 'female';
  if (/\bmale\b/.test(n) || MALE.test(n)) return 'male';
  return 'auto';
}

function deviceVoices() {
  try { return window.speechSynthesis?.getVoices?.() || []; } catch { return []; }
}

// ------------------------------------------------------------------ speaking

const state = { speaking: false, audio: null, token: 0, voices: [] };
const events = new Emitter(); // 'change' ({ speaking, listening })
function setSpeaking(v) { if (state.speaking !== v) { state.speaking = v; events.emit('change', { speaking: v, listening: dict.active }); } }

function pickDeviceVoice(c) {
  const rows = deviceVoices();
  if (c.voice.startsWith('device|')) {
    const id = decodeURIComponent(c.voice.split('|').slice(2).join('|'));
    const exact = rows.find(v => (v.voiceURI || v.name) === id);
    if (exact) return exact;
  }
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  const local = rows.filter(v => !v.lang || v.lang.toLowerCase().startsWith(lang));
  const pool = local.length ? local : rows.filter(v => /^en/i.test(v.lang || ''));
  const styled = pool.filter(v => c.style === 'auto' || guessGender(v) === c.style);
  const list = styled.length ? styled : pool;
  return list.find(v => v.localService && /enhanced|premium|natural/i.test(v.name)) || list.find(v => v.localService) || list[0] || rows[0] || null;
}

function chunks(text, max = 220) {
  const out = [];
  const sentences = String(text).match(/[^.!?。！？]+[.!?。！？]*\s*/g) || [text];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > max && cur) { out.push(cur.trim()); cur = ''; }
    if (s.length > max) { for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max)); continue; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function speakDevice(text, c, token) {
  const synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') throw new Error('Speech is not available in this browser.');
  synth.cancel();
  const voiceObj = pickDeviceVoice(c);
  for (const part of chunks(text)) {
    if (token !== state.token) return;
    await new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(part);
      if (voiceObj) { u.voice = voiceObj; u.lang = voiceObj.lang; }
      u.rate = c.rate;
      u.pitch = c.style === 'female' ? 1.03 : c.style === 'male' ? 0.96 : 1;
      let started = false;
      // some browsers never report anything for a voice they cannot use: don't wait forever
      const watchdog = setTimeout(() => { if (!started && !synth.speaking) resolve(); }, 5000);
      u.onstart = () => { started = true; };
      u.onend = () => { clearTimeout(watchdog); resolve(); };
      u.onerror = e => { clearTimeout(watchdog); if (e.error === 'interrupted' || e.error === 'canceled') resolve(); else reject(new Error(e.error === 'not-allowed' ? 'Tap Read Aloud again to allow speech on this device.' : `Speech failed: ${e.error || 'unknown error'}`)); };
      synth.speak(u);
    });
  }
}

async function listPuterVoices(puter) {
  try {
    const rows = await puter.ai.txt2speech.listVoices?.({ provider: 'all' });
    return (Array.isArray(rows) ? rows : [])
      .map(v => ({ kind: 'puter', id: String(v.id || v.name || ''), name: String(v.name || v.id || 'Voice'), provider: String(v.provider || ''), lang: v.language?.code || v.lang || '', gender: guessGender(v) }))
      .filter(v => v.id);
  } catch (err) { log.warn('Puter voices unavailable', err); return []; }
}

async function speakPuter(text, c, token) {
  if (!puterSignedIn()) throw new Error('Sign in to X Coder Cloud (Accounts) to use natural voices.');
  const puter = await getPuter(8000);
  if (!puter?.ai?.txt2speech) throw new Error('Natural voices could not load (offline or blocked).');
  let provider = '', voiceId = '';
  if (c.voice.startsWith('puter|')) { const p = c.voice.split('|'); provider = p[1] || ''; voiceId = decodeURIComponent(p.slice(2).join('|')); }
  if (!voiceId) {
    if (!state.voices.some(v => v.kind === 'puter')) state.voices.push(...await listPuterVoices(puter));
    const rows = state.voices.filter(v => v.kind === 'puter' && (c.style === 'auto' || v.gender === c.style));
    const names = c.style === 'male' ? ['Rex', 'Leo', 'Onyx', 'Ash', 'Echo'] : c.style === 'female' ? ['Ara', 'Eve', 'Nova', 'Shimmer', 'Alloy'] : ['Sal', 'Alloy'];
    const pick = names.map(n => rows.find(v => v.name.toLowerCase() === n.toLowerCase() || v.id.toLowerCase() === n.toLowerCase())).find(Boolean) || rows[0];
    if (pick) { provider = pick.provider; voiceId = pick.id; }
  }
  const opts = {};
  if (provider) opts.provider = provider;
  if (voiceId) opts.voice = voiceId;
  const audio = await puter.ai.txt2speech(text.slice(0, 2900), opts);
  if (token !== state.token) return;
  state.audio = audio;
  await new Promise((resolve, reject) => {
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error('The natural voice could not be played.'));
    audio.onpause = () => { if (token !== state.token) resolve(); };
    audio.play().catch(reject);
  });
}

export const voice = {
  events,
  get speaking() { return state.speaking; },
  get listening() { return dict.active; },
  config: cfg,

  /** Reads text aloud (markdown and code blocks are stripped). Resolves when finished or stopped. */
  async speak(text) {
    const clean = speechText(text);
    if (!clean) return;
    this.stop();
    const token = ++state.token;
    const c = cfg();
    const usePuter = c.engine === 'puter' || (c.engine === 'auto' && puterSignedIn());
    setSpeaking(true);
    try {
      if (usePuter) {
        try { await speakPuter(clean, c, token); }
        catch (err) {
          if (c.engine === 'puter' || token !== state.token) throw err;
          log.warn(`Natural voice unavailable, using the device voice: ${err.message}`);
          await speakDevice(clean, c, token);
        }
      } else await speakDevice(clean, c, token);
    } finally { if (token === state.token) setSpeaking(false); }
  },

  stop() {
    state.token++;
    try { state.audio?.pause?.(); if (state.audio) state.audio.currentTime = 0; } catch {}
    state.audio = null;
    try { window.speechSynthesis?.cancel(); } catch {}
    setSpeaking(false);
  },

  /** Available voices for the picker: [{ kind, id, name, provider, gender, lang }]. */
  async listVoices() {
    const c = cfg();
    const list = [];
    if (c.engine !== 'device' && puterSignedIn()) {
      const puter = await getPuter(6000);
      if (puter?.ai?.txt2speech) list.push(...await listPuterVoices(puter));
    }
    if (c.engine !== 'puter') {
      let rows = deviceVoices();
      if (!rows.length && window.speechSynthesis) {
        await new Promise(r => { const t = setTimeout(r, 900); window.speechSynthesis.addEventListener?.('voiceschanged', () => { clearTimeout(t); r(); }, { once: true }); });
        rows = deviceVoices();
      }
      list.push(...rows.map(v => ({ kind: 'device', id: v.voiceURI || v.name, name: v.name, provider: 'Device', lang: v.lang || '', gender: guessGender(v), local: v.localService })));
    }
    state.voices = list;
    return list;
  },

  dictationSupported() {
    if (window.SpeechRecognition || window.webkitSpeechRecognition) return 'speech';
    if (window.MediaRecorder && navigator.mediaDevices?.getUserMedia && puterSignedIn()) return 'puter';
    return null;
  },

  startDictation(opts) { return startDictation(opts); },

  configure: () => configure()
};

// ------------------------------------------------------------------ dictation

const dict = { active: false, session: null };
function setListening(v) { dict.active = v; events.emit('change', { speaking: state.speaking, listening: v }); }

function recognitionError(code) {
  return ({
    'not-allowed': 'Microphone access was denied. Allow the microphone for this site in your browser settings (on iPhone: Settings → Safari → Microphone).',
    'service-not-allowed': 'Speech recognition is turned off. On iPhone enable Siri & Dictation in Settings, or type your message.',
    'audio-capture': 'No microphone was found.',
    network: 'Speech recognition needs a network connection.',
    'language-not-supported': 'Speech recognition does not support your language setting.'
  })[code] || `Voice input stopped: ${code}`;
}

/**
 * Starts dictation. opts: { onText(finalText, interimText), onEnd(error|null), lang }.
 * Web Speech API when available (interim results, stops after ~2.5 s of silence); otherwise records with
 * MediaRecorder and transcribes with Puter (X Coder Cloud). Returns { stop() }.
 */
function startDictation({ onText = () => {}, onEnd = () => {}, lang = navigator.language || 'en-US' } = {}) {
  dict.session?.stop();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) return startSpeechRecognition(SR, { onText, onEnd, lang });
  if (window.MediaRecorder && navigator.mediaDevices?.getUserMedia && puterSignedIn()) return startRecorder({ onText, onEnd });
  const err = new Error(window.MediaRecorder
    ? 'This browser has no built-in speech recognition. Sign in to X Coder Cloud (Accounts) to transcribe voice with Puter, or use the keyboard\'s dictation key.'
    : 'Voice input is not supported in this browser. Use the dictation key on your keyboard instead.');
  queueMicrotask(() => onEnd(err));
  return { stop() {} };
}

function startSpeechRecognition(SR, { onText, onEnd, lang }) {
  const rec = new SR();
  rec.lang = lang; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
  let finalText = '', ended = false, heard = false, silence = 0, hardStop = 0;
  const armSilence = () => { clearTimeout(silence); silence = setTimeout(() => { try { rec.stop(); } catch {} }, heard ? 2500 : 8000); };
  const finish = err => {
    if (ended) return; ended = true;
    clearTimeout(silence); clearTimeout(hardStop);
    if (dict.session === session) { dict.session = null; setListening(false); }
    onEnd(err || null);
  };
  rec.onresult = e => {
    let interim = '';
    finalText = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    heard = true;
    onText(finalText, interim);
    armSilence();
  };
  rec.onerror = e => { if (e.error === 'no-speech' || e.error === 'aborted') finish(null); else finish(new Error(recognitionError(e.error))); };
  rec.onend = () => finish(null);
  const session = { stop() { clearTimeout(silence); try { rec.stop(); } catch { finish(null); } }, kind: 'speech' };
  dict.session = session;
  try { rec.start(); } catch (err) { queueMicrotask(() => finish(err)); return session; }
  setListening(true);
  armSilence();
  hardStop = setTimeout(() => { try { rec.stop(); } catch {} }, 120000);
  return session;
}

function startRecorder({ onText, onEnd }) {
  let stopped = false, recorder = null, stream = null, ctx = null, raf = 0, maxTimer = 0;
  const chunksList = [];
  const cleanup = () => {
    cancelAnimationFrame(raf); clearTimeout(maxTimer);
    try { stream?.getTracks().forEach(t => t.stop()); } catch {}
    try { ctx?.close(); } catch {}
  };
  const session = {
    kind: 'puter',
    stop() { if (stopped) return; stopped = true; try { if (recorder?.state === 'recording') recorder.stop(); else { cleanup(); done(null); } } catch { cleanup(); done(null); } }
  };
  let ended = false;
  const done = err => { if (ended) return; ended = true; if (dict.session === session) { dict.session = null; setListening(false); } onEnd(err || null); };
  dict.session = session;
  setListening(true);
  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (stopped) { cleanup(); done(null); return; }
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = e => { if (e.data?.size) chunksList.push(e.data); };
      recorder.onstop = async () => {
        cleanup();
        try {
          const blob = new Blob(chunksList, { type: recorder.mimeType || 'audio/webm' });
          if (blob.size < 800) { done(null); return; }
          onText('', 'Transcribing…');
          const puter = await getPuter(8000);
          if (!puter?.ai?.speech2txt) throw new Error('Puter transcription is not available right now.');
          const res = await puter.ai.speech2txt(blob);
          const text = typeof res === 'string' ? res : res?.text || '';
          onText(text.trim(), '');
          done(null);
        } catch (err) { onText('', ''); done(new Error(`Transcription failed: ${err.message}`)); }
      };
      recorder.start(250);
      // stop after ~2 s of silence once speech was heard (or after 60 s)
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        let heard = false, quietSince = performance.now();
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
          const now = performance.now();
          if (peak > 12) { heard = true; quietSince = now; }
          if ((heard && now - quietSince > 2000) || (!heard && now - quietSince > 9000)) { session.stop(); return; }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {}
      maxTimer = setTimeout(() => session.stop(), 60000);
    } catch (err) {
      cleanup();
      done(new Error(err?.name === 'NotAllowedError' ? recognitionError('not-allowed') : `Could not start recording: ${err.message}`));
    }
  })();
  return session;
}

// ------------------------------------------------------------------ configure (quick pick hub)

const ENGINE_LABELS = { auto: 'Automatic', puter: 'Natural Voices (Puter)', device: 'Device Voice' };
const STYLE_LABELS = { female: 'Female', male: 'Male', auto: 'Automatic' };

async function configure() {
  const { quickInput } = await import('../platform/quickinput.js');
  const { commands } = await import('../core/commands.js');
  const voiceLabel = c => {
    if (!c.voice) return 'Automatic';
    const [, provider, ...rest] = c.voice.split('|');
    const id = decodeURIComponent(rest.join('|'));
    return `${state.voices.find(v => v.id === id)?.name || id}${provider && provider !== 'Device' ? ` · ${provider}` : ''}`;
  };
  const preview = () => voice.speak('Hi, I am X Coder. This is a preview of the selected voice.').catch(err => notifyWarn(err.message));
  for (;;) {
    const c = cfg();
    const signed = puterSignedIn();
    const pick = await quickInput.pick([
      { id: 'engine', label: 'Speech Engine', description: ENGINE_LABELS[c.engine], detail: c.engine === 'device' ? 'Voices built into this device' : signed ? 'Natural Puter voices are available' : 'Natural voices need an X Coder Cloud sign-in — the device voice is used until then', icon: 'settings' },
      { id: 'style', label: 'Voice Style', description: STYLE_LABELS[c.style] || c.style, icon: 'person' },
      { id: 'voice', label: 'Voice', description: voiceLabel(c), icon: 'unmute' },
      { id: 'rate', label: 'Speaking Rate', description: `${c.rate.toFixed(2).replace(/0$/, '')}×`, icon: 'dashboard' },
      { id: 'auto', label: 'Read Answers Aloud Automatically', description: c.autoSpeak ? 'On' : 'Off', icon: c.autoSpeak ? 'check' : 'circle-large-outline' },
      { kind: 'separator', label: '' },
      { id: 'preview', label: 'Preview Voice', icon: 'play' },
      { id: 'stop', label: 'Stop Speaking', icon: 'debug-stop' },
      { id: 'settings', label: 'Open Voice Settings', icon: 'gear' }
    ], { title: 'Voice Settings', placeholder: 'Choose a setting to change' });
    if (!pick) return;
    if (pick.id === 'engine') {
      const e = await quickInput.pick(Object.entries(ENGINE_LABELS).map(([id, label]) => ({ id, label, description: id === c.engine ? 'Current' : '', icon: id === c.engine ? 'check' : 'blank' })), { title: 'Speech Engine' });
      if (e) { settings.set('xcoder.voice.engine', e.id); settings.set('xcoder.voice.voice', ''); }
    } else if (pick.id === 'style') {
      const s = await quickInput.pick(Object.entries(STYLE_LABELS).map(([id, label]) => ({ id, label, description: id === c.style ? 'Current' : '', icon: id === c.style ? 'check' : 'blank' })), { title: 'Voice Style' });
      if (s) { settings.set('xcoder.voice.style', s.id); settings.set('xcoder.voice.voice', ''); }
    } else if (pick.id === 'voice') {
      const list = await voice.listVoices();
      const rows = list.filter(v => c.style === 'auto' || v.gender === c.style || v.gender === 'auto');
      const toValue = v => `${v.kind}|${v.provider || (v.kind === 'device' ? 'Device' : '')}|${encodeURIComponent(v.id)}`;
      const items = [
        { value: '', label: 'Automatic', description: `Best ${STYLE_LABELS[c.style]?.toLowerCase() || ''} voice`, icon: !c.voice ? 'check' : 'blank' },
        ...rows.map(v => ({ value: toValue(v), label: v.name, description: `${v.kind === 'puter' ? `Natural · ${v.provider}` : 'Device'}${v.lang ? ` · ${v.lang}` : ''}`, icon: c.voice === toValue(v) ? 'check' : 'blank',
          buttons: [{ icon: 'play', tooltip: 'Preview', run: item => { const prev = settings.get('xcoder.voice.voice', ''); settings.set('xcoder.voice.voice', item.value); voice.speak('This is how I sound.').catch(err => notifyWarn(err.message)).finally(() => settings.set('xcoder.voice.voice', prev)); } }] }))
      ];
      const v = await quickInput.pick(items, { title: 'Voice', placeholder: rows.length ? 'Select a voice (tap ▶ to preview)' : 'No voices were found — Automatic uses the device default' });
      if (v) { settings.set('xcoder.voice.voice', v.value); preview(); }
    } else if (pick.id === 'rate') {
      const rates = [0.75, 0.9, 1, 1.1, 1.25, 1.5];
      const r = await quickInput.pick(rates.map(x => ({ value: x, label: `${x}×`, description: x === 1 ? 'Normal' : '', icon: Math.abs(x - c.rate) < 0.01 ? 'check' : 'blank' })), { title: 'Speaking Rate' });
      if (r) settings.set('xcoder.voice.rate', r.value);
    } else if (pick.id === 'auto') settings.set('xcoder.voice.autoSpeak', !c.autoSpeak);
    else if (pick.id === 'preview') preview();
    else if (pick.id === 'stop') voice.stop();
    else if (pick.id === 'settings') { commands.execute('workbench.action.openSettings', 'xcoder.voice'); return; }
  }
}

async function notifyWarn(msg) {
  try { const { notify } = await import('../platform/notifications.js'); notify.warn(msg, { source: 'Voice' }); } catch {}
}
