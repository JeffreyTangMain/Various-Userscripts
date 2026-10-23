// ==UserScript==
// @name         Keep Tab Awake
// @description  Generate a near-silent tone to prevent Firefox throttling background tabs
// @version      1.2.0
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
  const OFF = { awake: false, mute: false, webAudio: false };
  let gainValue = GM_getValue('gain', 0.0004);
  let ctx = null, gainNode = null, shownIds = [];
  // Settings from the most specific level that applies to this page, refreshed by sync()
  let current = OFF;
  // Page media volumes from before muting, restored on unmute
  const savedVolumes = new Map();
  // One GainNode per page AudioContext, sitting in front of its destination
  const pageGains = new Map();
  let pagePatched = false;
  let panel = null;

  const pick = p => ({ awake: !!p.awake, mute: !!p.mute, webAudio: !!p.webAudio });

  function migrate() {
    // Earlier versions stored `true` per site/link with separate mute:/webaudio: keys
    const keys = GM_listValues();
    keys.filter(key => /^(site|link):/.test(key) && GM_getValue(key) === true).forEach(key => {
      GM_setValue(key, {
        awake: true,
        mute: GM_getValue('mute:' + key, false),
        webAudio: GM_getValue('webaudio:' + key, false),
      });
    });
    keys.filter(key => /^(mute|webaudio):/.test(key)).forEach(key => GM_deleteValue(key));
  }

  const loadRules = () => GM_getValue('regexes', []);

  function compile(pattern) {
    try { return new RegExp(pattern); } catch { return null; }
  }

  function firstMatch(rules, url) {
    return rules.findIndex(rule => compile(rule.pattern)?.test(url));
  }

  // Most specific level first: link > regex > site
  function active() {
    const link = GM_getValue(LINK_KEY, null);
    if (link) return { kind: 'link', profile: link, save: p => GM_setValue(LINK_KEY, p) };
    const rules = loadRules();
    const i = firstMatch(rules, location.href);
    if (i >= 0) {
      return {
        kind: 'regex',
        profile: rules[i],
        save: p => {
          const fresh = loadRules();
          fresh[i] = { ...fresh[i], ...p };
          GM_setValue('regexes', fresh);
        },
      };
    }
    const site = GM_getValue(SITE_KEY, null);
    if (site) return { kind: 'site', profile: site, save: p => GM_setValue(SITE_KEY, p) };
    return null;
  }

  // A new level starts as a copy of what the page already does, so nothing changes until edited
  function newProfile() {
    const a = active();
    return a ? pick(a.profile) : { awake: true, mute: false, webAudio: false };
  }

  const muted = () => current.mute;
  const webAudioMuted = () => current.mute && current.webAudio;

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
    const a = active();
    current = a ? pick(a.profile) : OFF;
    if (current.awake && !ctx) start();
    else if (!current.awake) stop();
    if (webAudioMuted()) patchPage();
    applyAll();
    buildMenu();
  }

  function toggleLink() {
    if (GM_getValue(LINK_KEY, null)) GM_deleteValue(LINK_KEY);
    else GM_setValue(LINK_KEY, newProfile());
    sync();
  }

  function toggleSite() {
    if (GM_getValue(SITE_KEY, null)) {
      GM_deleteValue(SITE_KEY);
    } else {
      GM_setValue(SITE_KEY, newProfile());
      // Link levels on this site become redundant; the trailing / stops example.com matching example.com.au
      const prefix = 'link:' + HOST + '/';
      GM_listValues().filter(key => key.startsWith(prefix)).forEach(key => GM_deleteValue(key));
    }
    sync();
  }

  function toggleSetting(field) {
    const a = active();
    if (!a) return;
    a.save({ ...pick(a.profile), [field]: !a.profile[field] });
    sync();
    if (panel && a.kind === 'regex') panel.reload();
  }

  function setGain(factor) {
    gainValue = Math.min(0.1, Math.max(0.0001, gainValue * factor));
    GM_setValue('gain', gainValue);
    if (gainNode) gainNode.gain.value = gainValue;
    applyAll();
    buildMenu();
  }

  const onOff = on => on ? 'ON' : 'OFF';

  function awakeLabel(level) {
    const label = `☕ Keep awake (${level}): ${onOff(current.awake)}`;
    return current.awake && ctx && ctx.state !== 'running' ? label + ' ⏳ click page to start' : label;
  }

  function buildMenu() {
    const a = active();
    const rules = loadRules();
    const ruleIndex = firstMatch(rules, location.href);
    const entries = [];
    entries.push(['link', `🔗 This link: ${onOff(GM_getValue(LINK_KEY, null))}`, toggleLink]);
    if (ruleIndex >= 0) {
      const pattern = rules[ruleIndex].pattern;
      const short = pattern.length > 40 ? pattern.slice(0, 39) + '…' : pattern;
      entries.push(['regex', `🧩 Regex /${short}/`, openPanel]);
    }
    entries.push(['site', `🌐 This site: ${onOff(GM_getValue(SITE_KEY, null))}`, toggleSite]);
    if (a) {
      entries.push(['awake', awakeLabel(a.kind), () => toggleSetting('awake')]);
      entries.push(['mute', `🔇 Mute audio (${a.kind}): ${onOff(current.mute)}`, () => toggleSetting('mute')]);
      if (current.mute) {
        entries.push(['webaudio', `🎛 Also mute Web Audio (${a.kind}): ${onOff(current.webAudio)}`, () => toggleSetting('webAudio')]);
      }
    }
    entries.push(['rules', '🧩 Regex rules…', openPanel]);
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

  const PANEL_CSS = `
    :host { all: initial; }
    .panel {
      --bg: #ffffff; --fg: #1d1d1f; --muted: #6b6b70; --line: #d8d8dc; --field: #f4f4f6;
      --ok: #1a7f37; --bad: #b42318; --accent: #2f6fdb;
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto;
      box-sizing: border-box; padding: 14px 16px;
      background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 10px;
      box-shadow: 0 8px 30px rgba(0, 0, 0, .25);
      font: 13px/1.4 system-ui, sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      .panel {
        --bg: #1e1e21; --fg: #ececf0; --muted: #9a9aa2; --line: #3a3a40; --field: #2a2a2f;
        --ok: #4ac26b; --bad: #ff7b72; --accent: #6d9eff;
      }
    }
    .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    h2 { margin: 0; font-size: 15px; font-weight: 600; }
    label.test { display: block; color: var(--muted); margin-bottom: 4px; }
    input[type=text] {
      width: 100%; box-sizing: border-box; padding: 6px 8px;
      background: var(--field); color: var(--fg); border: 1px solid var(--line); border-radius: 6px;
      font: 12px ui-monospace, monospace;
    }
    .rule { border-top: 1px solid var(--line); padding: 10px 0; }
    .row { display: flex; gap: 8px; align-items: center; }
    .row input[type=text] { flex: 1; }
    .opts { display: flex; gap: 14px; margin-top: 6px; color: var(--muted); }
    .opts label { display: flex; gap: 4px; align-items: center; cursor: pointer; }
    .badge { min-width: 62px; text-align: right; font-size: 12px; color: var(--muted); }
    .badge.ok { color: var(--ok); } .badge.bad { color: var(--bad); }
    button {
      padding: 5px 10px; border: 1px solid var(--line); border-radius: 6px;
      background: var(--field); color: var(--fg); font: inherit; cursor: pointer;
    }
    button.add { margin-top: 10px; color: var(--accent); }
    .hint { margin: 10px 0 0; color: var(--muted); font-size: 12px; }
    .tests { margin-bottom: 4px; }
  `;

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el[k] = v;
    });
    children.forEach(c => el.append(c));
    return el;
  }

  const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function openPanel() {
    if (panel) return;
    const host = h('div');
    const root = host.attachShadow({ mode: 'closed' });
    let rules = loadRules();
    const list = h('div');
    const testInput = h('input', { type: 'text', value: location.href, oninput: refreshBadges });
    const badges = [];

    function save() {
      GM_setValue('regexes', rules);
      refreshBadges();
      sync();
    }

    function refreshBadges() {
      let applied = false;
      badges.forEach((badge, i) => {
        if (!rules[i]) return;
        const re = compile(rules[i].pattern);
        if (!re) {
          badge.textContent = 'invalid';
          badge.className = 'badge bad';
        } else if (re.test(testInput.value)) {
          badge.textContent = applied ? '✓ match' : '✓ applies';
          badge.className = 'badge ok';
          applied = true;
        } else {
          badge.textContent = '✗';
          badge.className = 'badge';
        }
      });
    }

    function render() {
      list.replaceChildren();
      badges.length = 0;
      rules.forEach((rule, i) => {
        const badge = h('span', { class: 'badge' });
        badges.push(badge);
        const check = (field, text) => h('label', {},
          h('input', { type: 'checkbox', checked: !!rule[field], onchange: e => { rule[field] = e.target.checked; save(); } }),
          text);
        list.append(h('div', { class: 'rule' },
          h('div', { class: 'row' },
            h('input', { type: 'text', value: rule.pattern, spellcheck: false, oninput: e => { rule.pattern = e.target.value; save(); } }),
            badge,
            h('button', { title: 'Delete rule', onclick: () => { rules.splice(i, 1); render(); save(); } }, '🗑')),
          h('div', { class: 'opts' }, check('awake', 'Keep awake'), check('mute', 'Mute audio'), check('webAudio', 'Mute Web Audio'))));
      });
      refreshBadges();
    }

    function close() {
      host.remove();
      window.removeEventListener('keydown', onEscape, true);
      panel = null;
    }

    function onEscape(e) {
      if (e.key === 'Escape') close();
    }

    const style = h('style');
    style.textContent = PANEL_CSS;
    const box = h('div', { class: 'panel' },
      h('div', { class: 'head' }, h('h2', {}, 'Regex rules'), h('button', { title: 'Close', onclick: close }, '✕')),
      h('div', { class: 'tests' }, h('label', { class: 'test' }, 'Test URL'), testInput),
      list,
      h('button', {
        class: 'add',
        onclick: () => {
          rules.push({ pattern: escapeRegex(HOST), awake: true, mute: false, webAudio: false });
          render();
          save();
          list.lastChild.querySelector('input').focus();
        },
      }, '+ Add rule'),
      h('p', { class: 'hint' }, 'Rules match the full URL. The first matching rule applies. This link overrides rules, rules override this site.'));
    // Keep typing in the panel from triggering the page's keyboard shortcuts
    ['keydown', 'keyup', 'keypress'].forEach(type => box.addEventListener(type, e => e.stopPropagation()));
    root.append(style, box);
    document.documentElement.append(host);
    window.addEventListener('keydown', onEscape, true);
    render();
    panel = { reload: () => { rules = loadRules(); render(); } };
  }

  migrate();
  sync();
})();
