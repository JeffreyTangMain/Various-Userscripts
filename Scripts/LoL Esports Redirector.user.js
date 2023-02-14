// ==UserScript==
// @name         LoL Esports Redirector
// @namespace    https://lolesports.com/
// @version      4.1
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
        tempString = arguments[5];
        // arguments[2] refers to the text before the -> in the console
        // Checks if any rewards are enabled
        if(tempString != undefined && arguments[2].includes('RewardsStatusInformer') && !(tempString.includes('mission=on') || tempString.includes('drop=on'))){
            if(GM_getValue("firstWatching", true) == true) {
                window.location.href = 'https://lolesports.com/schedule';
            } else if(GM_getValue("firstWatching", true) == false && GM_getValue("liveLinkNumber", 0) < GM_getValue("liveGameCount", 1)) {
                GM_setValue("currentHour", new Date().getHours());
                window.location.href = 'https://lolesports.com/schedule';
            } else if(GM_getValue("firstWatching", true) == false && GM_getValue("currentHour", 0) != new Date().getHours()){
                GM_setValue("currentHour", new Date().getHours());
                window.location.href = 'https://lolesports.com/schedule';
            }
        }
        // If there are rewards, reset the first watching value to reset if the rewards disappear
        else if(tempString != undefined && arguments[2].includes('RewardsStatusInformer') && (tempString.includes('mission=on') || tempString.includes('drop=on'))){
            GM_setValue("firstWatching", true);
        }
        // Checks if the video player is playing
        else if(tempString != undefined && arguments[2].includes('VideoPlayer') && tempString.toLowerCase().includes('playing')){
            containerLoaded = true;
        }
        else if(tempString != undefined && arguments[2].includes('VideoPlayerYouTube') && arguments[4].toLowerCase().includes('playing')){
            // This is a check specifically for YouTube because it has a different format for the log
            containerLoaded = true;
        }
        else if(tempString != undefined && arguments[2].includes('WatchLive') && arguments[4].length == undefined){
            // Check for an erroring WatchLive, which is another indicator of the stream ending
            window.location.href = 'https://lolesports.com/schedule';
        }
        // Checks if the video player has ended, which indicates a VOD
        else if(tempString != undefined && arguments[2].includes('VideoPlayer') && tempString.includes('ended')){
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
    liveClicker(function(){setTimeout(function(){window.location.href = 'https://lolesports.com/schedule'}, 60000)});
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
        // Rewatch everything even if the links are the same but an hour has gone by since the last time watched
        if((currentTime - storedTime) > 3600000 && (GM_getValue("liveGameLinks", '') == liveGameLinks)){
            GM_setValue("storedTime", currentTime);
            GM_setValue("firstWatching", true);
            GM_setValue("liveLinkNumber", 0);
        } else if(GM_getValue("liveGameLinks", '') != liveGameLinks) {
            GM_setValue("storedTime", currentTime);
            GM_setValue("liveGameCount", liveGameList.length);
            GM_setValue("liveGameLinks", liveGameLinks);
            GM_setValue("firstWatching", true);
            GM_setValue("liveLinkNumber", 0);
        }
    }
    // ---------------------------------------
    var liveLinkNumber = GM_getValue("liveLinkNumber", 0);
    liveButton = liveButton[liveLinkNumber];
    if(liveButton == undefined){
        GM_setValue("firstWatching", false);
        GM_setValue("liveLinkNumber", 0);
        liveButton = $('a.live');
        liveButton = liveButton[0];
    }
    liveLinkNumber = GM_getValue("liveLinkNumber", 0);
    GM_setValue("liveLinkNumber", liveLinkNumber + 1);

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
        var timerThreshold = 30;
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
                // The live link number needs to be deincremented by 1 to make sure it doesn't start skipping forwards in streams just by clicking away
                liveLinkNumber = GM_getValue("liveLinkNumber", 0);
                if(liveLinkNumber - 1 >= 0){
                    liveLinkNumber = liveLinkNumber - 1;
                } else{
                    liveLinkNumber = 0;
                }
                GM_setValue("liveLinkNumber", liveLinkNumber);
                liveClicker(function(){window.location.href = 'https://lolesports.com/schedule'}, rewardCheck);
            } else if((rewardsEnabled == true && rewardsIcon != '#5ABBD4') || (manualTimer > timerThreshold && containerLoaded == false)){
                // The first check is if rewards were enabled at some point in the past and aren't enabled currently
                // The second check is a backup wait for some seconds that will refresh the page if the video still hasn't loaded
                // #5ABBD4 is the fill color when rewards are working, #DE2F2F is the fill color when rewards aren't
                // Live link number is deincremented by 1 to let the script double check any links that happen to not load because of a bad video player
                liveLinkNumber = GM_getValue("liveLinkNumber", 0);
                if(liveLinkNumber - 1 >= 0){
                    liveLinkNumber = liveLinkNumber - 1;
                } else{
                    liveLinkNumber = 0;
                }
                GM_setValue("liveLinkNumber", liveLinkNumber);
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
