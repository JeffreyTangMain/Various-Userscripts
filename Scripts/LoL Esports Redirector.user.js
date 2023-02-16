// ==UserScript==
// @name         LoL Esports Redirector
// @namespace    https://lolesports.com/
// @version      4.2.0
// @description  Redirects the schedule to the livestream so you're always watching when it's available.
// @author       Main
// @match        https://lolesports.com/schedule*
// @match        https://lolesports.com/live/*
// @grant GM_setValue
// @grant GM_getValue
// @run-at        document-start
// @require http://code.jquery.com/jquery-3.4.1.min.js
// @require https://cdn.jsdelivr.net/gh/CoeJoder/waitForKeyElements.js@v1.2/waitForKeyElements.js
// ==/UserScript==
// Documenting globals for JSHint to not throw an error for JQuery's $ function
/* globals $ waitForKeyElements */

var redirectPathCheck = '/live';
var containerLoaded = false;
var tempString = '';

var oldLog = unsafeWindow.console.log;

unsafeWindow.console.log = function(msg) {
    try {
        // arguments[2] refers to the text before the -> in the console
        // Checks if any rewards are enabled
        if(arguments[2].includes('RewardsStatusInformer') && !(arguments[5].includes('mission=on') || arguments[5].includes('drop=on'))){
            if(GM_getValue("liveLinkNumber", 0) < GM_getValue("liveGameCount", 1)) {
                window.location.href = 'https://lolesports.com/schedule';
            } else if((Date.now() - GM_getValue("currentMinute", 0)) > 300000){
                window.location.href = 'https://lolesports.com/schedule';
            }
        }
        // Checks if the video player has ended, which indicates a VOD
        else if(arguments[2].includes('VideoPlayer') && arguments[5].includes('ended')){
            window.location.href = 'https://lolesports.com/schedule';
        }
        // Checks if the video player is playing
        else if(arguments[2].includes('VideoPlayer') && arguments[5].toLowerCase().includes('playing')){
            containerLoaded = true;
        }
        // This is a check specifically for YouTube because it has a different format for the log
        else if(arguments[2].includes('VideoPlayerYouTube') && arguments[4].toLowerCase().includes('playing')){
            containerLoaded = true;
        }
        // Check for an erroring WatchLive, which is another indicator of the stream ending
        else if(arguments[2].includes('WatchLive') && arguments[4].length == undefined){
            window.location.href = 'https://lolesports.com/schedule';
        }
    } catch (error) {
        null;
    }
    oldLog.apply(null, arguments);
}

if(window.location.toString().indexOf('/schedule') != -1){
    waitForKeyElements('.Event', mainMethod);
} else{
    window.onload = mainMethod;
}

function mainMethod(){
    // A refresh function that runs when the live button is undefined and the page is not at the live section
    // This should refresh when there are no live games to check for new ones every refresh
    liveClicker(function(){setTimeout(function(){window.location.href = 'https://lolesports.com/schedule'}, 300000)});
}

function liveClicker(method, loop){
    // Loops through all the live buttons in order, and resets back to the start of the list once it reaches the end
    var liveButton = $('a.live');
    // ---------------------------------------
    // This chunk of code manages the userscript's memory of having gone through all the current live links, and to stop refreshing for new ones for 1 hour if they've all been watched
    if(window.location.toString().indexOf('/schedule') != -1){
        var liveGameList = $('a.live');
        var liveGameLinks = "";
        var currentTime = Date.now();
        var storedTime = GM_getValue("storedTime", 0);
        liveGameList.each(function() {
            liveGameLinks = liveGameLinks + this.href;
        });
        if(GM_getValue("liveGameLinks", '') != liveGameLinks) {
            GM_setValue("storedTime", currentTime);
            GM_setValue("liveGameCount", liveGameList.length);
            GM_setValue("liveGameLinks", liveGameLinks);
            GM_setValue("liveLinkNumber", 0);
        }
    }
    // ---------------------------------------
    var liveLinkNumber = GM_getValue("liveLinkNumber", 0);
    liveButton = liveButton[liveLinkNumber];
    if(liveButton == undefined){
        GM_setValue("liveLinkNumber", 0);
        liveButton = $('a.live');
        liveButton = liveButton[0];
    }
    liveLinkNumber = GM_getValue("liveLinkNumber", 0);
    GM_setValue("liveLinkNumber", liveLinkNumber + 1);

    //Prepares the timer when the page is loaded to refresh if there are no rewards.
    GM_setValue("currentMinute", Date.now());

    if(liveButton == undefined && window.location.toString().indexOf(redirectPathCheck) == -1){
        return method();
    } else{
        if(liveButton != undefined){
            liveButton.click();
        }
        if(loop != undefined){
            clearInterval(loop);
        }
        var manualTimer = 0;
        var timerThreshold = 60;
        var rewardsEnabled = false;
        var rewardCheck = setInterval(function() {
            manualTimer > timerThreshold ? null : manualTimer++;
            var rewardsIcon = $('.RewardsStatusInformer .status-summary svg path').attr('fill');
            if(rewardsIcon == '#5ABBD4'){
                rewardsEnabled = true;
            }
            if(window.location.toString().indexOf(redirectPathCheck) == -1){
                // Resolves issues if the live stream is clicked out of at any time
                // Will return to the schedule page if clicked into a page with no live button
                // If there is a live button, meaning you're on the schedule, it will click it, remove the old loop, and then continue normal operation
                liveClicker(function(){window.location.href = 'https://lolesports.com/schedule'}, rewardCheck);
            } else if((rewardsEnabled == true && rewardsIcon != '#5ABBD4') || (manualTimer > timerThreshold && (containerLoaded == false || rewardsEnabled == false))){
                // The first check is if rewards were enabled at some point in the past and aren't enabled currently
                // The second check is a backup wait for some seconds that will refresh the page if the video still hasn't loaded
                // #5ABBD4 is the fill color when rewards are working, #DE2F2F is the fill color when rewards aren't
                window.location.href = 'https://lolesports.com/schedule';
            } else if(document.readyState == 'complete'){
                // Should click the close button on any drop popups
                if($('.drops-fulfilled').length){
                    var closeReward = document.querySelector (
                        '.drops-fulfilled .actions .close'
                    );
                    closeReward.click();
                }
            }
        }, 1000);
    }
}
