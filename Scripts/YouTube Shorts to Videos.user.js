// ==UserScript==
// @name         YouTube Shorts to Videos
// @namespace    https://github.com/
// @version      1.0.0
// @description  Changes a YouTube short to a video link when opened in another tab
// @author       Main
// @match        https://www.youtube.com/shorts/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @run-at       document-start
// ==/UserScript==

var url = window.location.href.split('/');
window.location.assign("https://www.youtube.com/watch?v=" + url[4]);
