// ==UserScript==
// @name         Keep Tab Awake
// @description  Generate a near-silent tone to prevent Firefox throttling background tabs
// @version      1.1.0
// @match        *://*/*
// @noframes
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  const FREQ = 1;
  // GM storage is shared by every site, so keys include the host
  const HOST = location.host;
  const SITE_KEY = 'site:' + HOST;
  const LINK_KEY = 'link:' + HOST + location.pathname + location.search;
  const muteKey = scope => 'mute:' + scope;
  const webAudioKey = scope => 'webaudio:' + scope;
  let gainValue = GM_getValue('gain', 0.0004);
  let ctx = null, gainNode = null, shownIds = [];
  // Page media volumes from before muting, restored on unmute
  const savedVolumes = new Map();
  // One GainNode per page AudioContext, sitting in front of its destination
  const pageGains = new Map();
  let pagePatched = false;

  function isOn(key) {
    return GM_getValue(key, false);
  }

  function setOn(key, on) {
    // Delete rather than store false so turned-off pages don't pile up
    on ? GM_setValue(key, true) : GM_deleteValue(key);
  }

  function scope() {
    if (isOn(SITE_KEY)) return SITE_KEY;
    if (isOn(LINK_KEY)) return LINK_KEY;
    return null;
  }

  function muted() {
    const s = scope();
    return !!s && isOn(muteKey(s));
  }

  function webAudioMuted() {
    return muted() && isOn(webAudioKey(scope()));
  }

  function unlockOnInteraction() {
    // Firefox blocks audio until the page gets a click or key press
    const resume = () => {
      if (ctx) ctx.resume();
      window.removeEventListener('pointerdown', resume, true);
      window.removeEventListener('keydown', resume, true);
    };
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
  }

  function start() {
    ctx = new AudioContext();
    const osc = ctx.createOscillator();
    gainNode = ctx.createGain();
    osc.frequency.value = FREQ;
    gainNode.gain.value = gainValue;
    osc.connect(gainNode).connect(ctx.destination);
    osc.start();
    if (ctx.state === 'suspended') {
      unlockOnInteraction();
      ctx.onstatechange = buildMenu;
    }
  }

  function stop() {
    if (!ctx) return;
    ctx.close();
    ctx = gainNode = null;
  }

  function applyMedia(el) {
    if (muted()) {
      if (Math.abs(el.volume - gainValue) < 1e-9) return;
      // Anything else is the page's own choice, so it becomes the volume to restore
      savedVolumes.set(el, el.volume);
      el.volume = gainValue;
    } else if (savedVolumes.has(el)) {
      const volume = savedVolumes.get(el);
      savedVolumes.delete(el);
      el.volume = volume;
    }
  }

  function applyAll() {
    const els = new Set([...document.querySelectorAll('audio, video'), ...savedVolumes.keys()]);
    els.forEach(applyMedia);
    const value = webAudioMuted() ? gainValue : 1;
    pageGains.forEach(gain => { gain.gain.value = value; });
  }

  function onMediaEvent(e) {
    if (e.target instanceof HTMLMediaElement) applyMedia(e.target);
  }

  ['play', 'volumechange', 'loadedmetadata'].forEach(type => window.addEventListener(type, onMediaEvent, true));

  function patchPage() {
    if (pagePatched) return;
    pagePatched = true;
    const pageWin = unsafeWindow.wrappedJSObject || unsafeWindow;
    // Tampermonkey's Firefox sandbox needs functions exported to the page; page-mode managers don't
    const exp = fn => typeof exportFunction === 'function' ? exportFunction(fn, pageWin) : fn;
    const nodeProto = pageWin.AudioNode.prototype;
    const mediaProto = pageWin.HTMLMediaElement.prototype;
    const origConnect = nodeProto.connect;
    const origDisconnect = nodeProto.disconnect;
    const origPlay = mediaProto.play;

    function gainFor(context) {
      let gain = pageGains.get(context);
      if (!gain) {
        gain = context.createGain();
        gain.gain.value = webAudioMuted() ? gainValue : 1;
        origConnect.call(gain, context.destination);
        pageGains.set(context, gain);
      }
      return gain;
    }

    const routed = (node, dest) => dest && node.context !== ctx && dest === node.context.destination;

    nodeProto.connect = exp(function (dest, ...rest) {
      if (!routed(this, dest)) return origConnect.call(this, dest, ...rest);
      origConnect.call(this, gainFor(this.context), ...rest);
      return dest;
    });
    nodeProto.disconnect = exp(function (dest, ...rest) {
      if (!routed(this, dest)) return origDisconnect.call(this, dest, ...rest);
      return origDisconnect.call(this, gainFor(this.context), ...rest);
    });
    // Catches new Audio() objects that never join the page, so window listeners miss them
    mediaProto.play = exp(function (...args) {
      applyMedia(this);
      return origPlay.apply(this, args);
    });
  }

  function sync() {
    const want = !!scope();
    if (want && !ctx) start();
    else if (!want) stop();
    if (webAudioMuted()) patchPage();
    applyAll();
    buildMenu();
  }

  function clearMute(s) {
    setOn(muteKey(s), false);
    setOn(webAudioKey(s), false);
  }

  function toggleLink() {
    if (isOn(LINK_KEY)) {
      setOn(LINK_KEY, false);
      clearMute(LINK_KEY);
    } else {
      setOn(LINK_KEY, true);
    }
    sync();
  }

  function toggleSite() {
    if (isOn(SITE_KEY)) {
      setOn(SITE_KEY, false);
      clearMute(SITE_KEY);
    } else {
      setOn(SITE_KEY, true);
      // Carry this page's mute settings over so it doesn't suddenly get loud
      if (isOn(muteKey(LINK_KEY))) setOn(muteKey(SITE_KEY), true);
      if (isOn(webAudioKey(LINK_KEY))) setOn(webAudioKey(SITE_KEY), true);
      // The site toggle makes link toggles redundant; the trailing / stops example.com matching example.com.au
      const prefixes = ['link:', 'mute:link:', 'webaudio:link:'].map(p => p + HOST + '/');
      GM_listValues()
        .filter(key => prefixes.some(p => key.startsWith(p)))
        .forEach(key => GM_deleteValue(key));
    }
    sync();
  }

  function toggleScoped(keyFor) {
    const s = scope();
    if (!s) return;
    setOn(keyFor(s), !isOn(keyFor(s)));
    sync();
  }

  function setGain(factor) {
    gainValue = Math.min(0.1, Math.max(0.0001, gainValue * factor));
    GM_setValue('gain', gainValue);
    if (gainNode) gainNode.gain.value = gainValue;
    applyAll();
    buildMenu();
  }

  function toggleLabel(icon, name, key) {
    if (!isOn(key)) return `${icon} ${name}: OFF`;
    if (ctx && ctx.state !== 'running') return `${icon} ${name}: ON ⏳ click page to start`;
    return `${icon} ${name}: ON`;
  }

  const onOff = on => on ? 'ON' : 'OFF';

  function buildMenu() {
    const s = scope();
    const entries = [];
    if (s !== SITE_KEY) entries.push(['link', toggleLabel('🔗', 'This link', LINK_KEY), toggleLink]);
    entries.push(['site', toggleLabel('🌐', 'This site', SITE_KEY), toggleSite]);
    if (s) entries.push(['mute', `🔇 Mute audio: ${onOff(muted())}`, () => toggleScoped(muteKey)]);
    if (muted()) entries.push(['webaudio', `🎛 Also mute Web Audio: ${onOff(webAudioMuted())}`, () => toggleScoped(webAudioKey)]);
    entries.push(['louder', `🔊 Louder (gain ${gainValue.toFixed(4)})`, () => setGain(2)]);
    entries.push(['quieter', '🔉 Quieter', () => setGain(0.5)]);

    // Fixed ids update entries in place. When an entry appears or disappears, everything
    // from that point down is removed and re-added in order, since new entries go to the bottom.
    let same = 0;
    while (same < shownIds.length && same < entries.length && shownIds[same] === entries[same][0]) same++;
    shownIds.slice(same).forEach(id => GM_unregisterMenuCommand(id));
    entries.forEach(([id, label, fn]) => GM_registerMenuCommand(label, fn, { id }));
    shownIds = entries.map(([id]) => id);
  }

  sync();
})();
