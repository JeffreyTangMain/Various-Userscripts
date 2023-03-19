// ==UserScript==
// @name         Auto-Expand Description
// @namespace    https://www.youtube.com/
// @version      2.2
// @description  Clicks "Show More" on the description of videos on page load.
// @author       Main
// @match        https://www.youtube.com/*
// @require http://code.jquery.com/jquery-3.4.1.min.js
// @require https://cdn.jsdelivr.net/gh/CoeJoder/waitForKeyElements.js@v1.2/waitForKeyElements.js
// ==/UserScript==
// Documenting globals for JSHint to not throw an error
/* globals waitForKeyElements $ */

waitForKeyElements("tp-yt-paper-button.ytd-text-inline-expander#expand", descClicker, false);

function descClicker(){
    if($("tp-yt-paper-button.ytd-text-inline-expander#expand").is(":visible")){
        $("tp-yt-paper-button.ytd-text-inline-expander#expand:visible").click();
    }
    return true;
}
