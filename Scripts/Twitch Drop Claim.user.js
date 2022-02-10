// ==UserScript==
// @name         Twitch Drop Claim
// @namespace    https://www.twitch.tv/
// @version      2.2
// @description  Clicks claim on drops.
// @author       Main
// @match        https://www.twitch.tv/*
// @require https://cdn.jsdelivr.net/gh/CoeJoder/waitForKeyElements.js@v1.2/waitForKeyElements.js
// ==/UserScript==
// Documenting globals for JSHint to not throw an error
/* globals waitForKeyElements */

waitForKeyElements('[data-test-selector=drops-list__wrapper]', liveClicker);

function liveClicker(){
    var liveButton = document.querySelector (
        '*[data-test-selector="DropsCampaignInProgressRewardPresentation-claim-button"]'
    );
    if(liveButton != undefined){
        liveButton.click();
    }
    setTimeout(function(){window.location.href = 'https://www.twitch.tv/drops/inventory'}, 600000);
}
