// ==UserScript==
// @name         YouTube Shorts to Videos
// @namespace    https://github.com/
// @version      2.0.0
// @description  Opens YouTube Shorts as normal watch pages
// @author       Main
// @match        https://www.youtube.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const toWatch = (url) => {
    const u = new URL(url, location.origin);
    const m = u.pathname.match(/^\/shorts\/([\w-]{6,})/);
    if (!m) return null;
    u.searchParams.delete('feature');
    const extra = u.searchParams.toString();
    return `https://www.youtube.com/watch?v=${m[1]}${extra ? '&' + extra : ''}`;
  };

  // 1. Direct load (new tab, pasted link): cancel and replace ASAP.
  const direct = toWatch(location.href);
  if (direct) {
    window.stop();
    location.replace(direct);
    return;
  }

  // 2. In-app clicks: intercept before YouTube's router sees them.
  document.addEventListener('click', (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return; // let new-tab clicks hit case 1
    const a = e.target.closest && e.target.closest('a[href*="/shorts/"]');
    const target = a && toWatch(a.href);
    if (!target) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    location.assign(target);
  }, true);

  // 3. Fallback for SPA navigations not triggered by a link click.
  document.addEventListener('yt-navigate-start', (e) => {
    const url = e.detail && e.detail.url;
    const target = url && toWatch(url);
    if (target) location.replace(target);
  });
})();
