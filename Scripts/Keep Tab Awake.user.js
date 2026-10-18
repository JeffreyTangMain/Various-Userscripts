// ==UserScript==
// @name         Keep Tab Awake
// @description  Generate a near-silent tone to prevent Firefox throttling background tabs
// @version      1.0.2
// @match        *://*/*
// @noframes
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// ==/UserScript==

(() => {
  const FREQ = 1;
  // GM storage is shared by every site, so keys include the host
  const SITE_KEY = 'site:' + location.host;
  const LINK_KEY = 'link:' + location.host + location.pathname + location.search;
  let gainValue = GM_getValue('gain', 0.0004);
  let ctx = null, gainNode = null;

  function isOn(key) {
    return GM_getValue(key, false);
  }

  function setOn(key, on) {
    // Delete rather than store false so turned-off pages don't pile up
    on ? GM_setValue(key, true) : GM_deleteValue(key);
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

  function sync() {
    const want = isOn(SITE_KEY) || isOn(LINK_KEY);
    if (want && !ctx) start();
    else if (!want) stop();
    buildMenu();
  }

  function toggle(key) {
    setOn(key, !isOn(key));
    sync();
  }

  function setGain(factor) {
    gainValue = Math.min(0.1, Math.max(0.0001, gainValue * factor));
    GM_setValue('gain', gainValue);
    if (gainNode) gainNode.gain.value = gainValue;
    buildMenu();
  }

  function toggleLabel(icon, name, key) {
    if (!isOn(key)) return `${icon} ${name}: OFF`;
    if (ctx && ctx.state !== 'running') return `${icon} ${name}: ON ⏳ click page to start`;
    return `${icon} ${name}: ON`;
  }

  function buildMenu() {
    // Fixed ids make re-registering update each entry in place, so the order never shifts
    GM_registerMenuCommand(toggleLabel('🔗', 'This link', LINK_KEY), () => toggle(LINK_KEY), { id: 'link' });
    GM_registerMenuCommand(toggleLabel('🌐', 'This site', SITE_KEY), () => toggle(SITE_KEY), { id: 'site' });
    GM_registerMenuCommand(`🔊 Louder (gain ${gainValue.toFixed(4)})`, () => setGain(2), { id: 'louder' });
    GM_registerMenuCommand('🔉 Quieter', () => setGain(0.5), { id: 'quieter' });
  }

  sync();
})();
