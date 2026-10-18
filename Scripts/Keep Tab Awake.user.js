// ==UserScript==
// @name         Keep Tab Awake
// @description  Generate a near-silent tone to prevent Firefox throttling background tabs
// @version      1.0.0
// @match        *://*/*
// @noframes
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
  const FREQ = 30;
  let gainValue = GM_getValue('gain', 0.001);
  let ctx = null, gainNode = null, menuIds = [];

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
    ctx.close();
    ctx = gainNode = null;
  }

  function setGain(factor) {
    gainValue = Math.min(0.1, Math.max(0.0001, gainValue * factor));
    GM_setValue('gain', gainValue);
    if (gainNode) gainNode.gain.value = gainValue;
    buildMenu();
  }

  function buildMenu() {
    menuIds.forEach(id => GM_unregisterMenuCommand(id));
    let label = '▶ Keep awake: OFF';
    if (ctx) label = ctx.state === 'running' ? '⏹ Keep awake: ON' : '⏳ Keep awake: click page to start';
    menuIds = [
      GM_registerMenuCommand(label, () => { ctx ? stop() : start(); buildMenu(); }),
      GM_registerMenuCommand(`🔊 Louder (gain ${gainValue.toFixed(4)})`, () => setGain(2)),
      GM_registerMenuCommand('🔉 Quieter', () => setGain(0.5)),
    ];
  }

  buildMenu();
})();
