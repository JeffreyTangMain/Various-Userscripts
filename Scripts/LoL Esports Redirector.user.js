// ==UserScript==
// @name         LoL Esports Redirector
// @namespace    https://lolesports.com/
// @version      4.4.5
// @description  Redirects the schedule to the livestream so you're always watching when it's available.
// @author       Main
// @match        https://lolesports.com/schedule*
// @match        https://lolesports.com/live/*
// @match        https://www.youtube.com/embed/*lolesports.com*
// @match        *://*.afreecatv.com/player/*/embed*
// @grant GM_setValue
// @grant GM_getValue
// @run-at        document-start
// @require http://code.jquery.com/jquery-3.4.1.min.js
// @require https://cdn.jsdelivr.net/gh/CoeJoder/waitForKeyElements.js@v1.2/waitForKeyElements.js
// ==/UserScript==
// Documenting globals for JSHint to not throw an error for JQuery's $ function
/* globals $ waitForKeyElements */

var heartbeatStoppedReload = null;

if(window.location.toString().indexOf('youtube.com/embed') != -1) {
    // Handling for the YouTube embed autopausing
    waitForKeyElements("button.ytp-play-button", autoplayEmbed, false);

    function autoplayEmbed(){
        if($("button.ytp-play-button").attr("data-title-no-tooltip") != "Pause"){
            $("button.ytp-large-play-button").click();
        }
        return true;
    }
} else if (window.location.toString().indexOf('afreecatv.com') != -1) {
    // Handling for the Afreecatv embed autopausing
    waitForKeyElements("#afreecatv_player", autoplayEmbed, false);

    function autoplayEmbed(){
        if($(".nextvideo").length != 0) {
            $(".nextvideo").click();
        }
        if($("button.play").not(".prev, .next").length != 0) {
            $("button.play").not(".prev, .next").click();
        }
        return true;
    }
} else {
    var redirectPathCheck = '/live';
    var containerLoaded = false;
    var tempString = '';
    var delayRefreshTimer = 300000;
    var heartbeatStopCounter = 0;

    var oldLog = unsafeWindow.console.log;

    unsafeWindow.console.log = function(msg) {
        try {
            // arguments[2] refers to the text before the -> in the console
            if(arguments[2].includes('RewardsStatusInformer') && arguments[4].includes('stopped')){
                // arguments[4] includes the heartbeater status update
                // Refreshes after a delay if the RewardsStatusInformer's heartbeat has stopped
                // Note: heartbeater stops if the embed is muted and in the background, make sure you don't mute it in the embed
                if(heartbeatStopCounter < 2) {
                    // Tracks the number of stopped heartbeats, refreshes if heartbeat is dead for some minutes
                    heartbeatStopCounter++;

                    // Will also refresh if too much time has passed ever since receiving a heartbeat stop
                    if(heartbeatStoppedReload == null) {
                        console.log("LOLER: heartbeatStoppedReload = setTimeout(returnToLive, 300000);");
                        heartbeatStoppedReload = resetTimeout(heartbeatStoppedReload);
                        heartbeatStoppedReload = setTimeout(returnToLive, 300000);
                    }
                } else {
                    console.log("LOLER: arguments[2].includes('RewardsStatusInformer') && arguments[4].includes('stopped')");
                    return returnToLive();
                }
            } else if(arguments[2].includes('RewardsStatusInformer') && arguments[4].includes('heartbeating') && heartbeatStoppedReload != null){
                console.log("LOLER: heartbeatStoppedReload = resetTimeout(heartbeatStoppedReload);");
                heartbeatStoppedReload = resetTimeout(heartbeatStoppedReload);
                heartbeatStopCounter = 0;
            }
            else if(arguments[2].includes('RewardsStatusInformer') && !(arguments[5].includes('mission=on') || arguments[5].includes('drop=on'))){
                // Checks if any rewards are enabled
                if(GM_getValue("liveLinkNumber", 0) < GM_getValue("liveGameCount", 1)) {
                    console.log("LOLER: GM_getValue('liveLinkNumber', 0) < GM_getValue('liveGameCount', 1)");
                    return returnToLive();
                } else if((Date.now() - GM_getValue("currentMinute", 0)) > delayRefreshTimer){
                    console.log('LOLER: (Date.now() - GM_getValue("currentMinute", 0)) > delayRefreshTimer');
                    return returnToLive();
                }
            }
            // Checks if the video player has ended, which indicates a VOD
            else if(arguments[2].includes('VideoPlayer') && arguments[5].includes('ended')){
                console.log("LOLER: arguments[2].includes('VideoPlayer') && arguments[5].includes('ended')");
                return returnToLive();
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
                console.log("LOLER: arguments[2].includes('WatchLive') && arguments[4].length == undefined");
                return returnToLive();
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
        liveClicker(function(){setTimeout(function(){
            console.log("LOLER: mainMethod liveClicker");
            return returnToLive();
        }, delayRefreshTimer)});
    }

    function liveClicker(method, loop){
        // Finds and clicks all leagues that aren't currently enabled
        var clickedLeagues = $('button.button.league')
        clickedLeagues.filter(":not('.selected')").each(function() {
            this.click();
        })
        // Loops through all the live buttons in order, and resets back to the start of the list once it reaches the end
        var liveButton = $('a.live');
        // ---------------------------------------
        // This chunk of code manages the userscript's memory of having gone through all the current live links
        if(window.location.toString().indexOf('/schedule') != -1){
            var liveGameList = $('a.live');
            var liveGameLinks = "";
            liveGameList.each(function() {
                liveGameLinks = liveGameLinks + this.href;
            });
            if(GM_getValue("liveGameLinks", '') != liveGameLinks) {
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
                    liveClicker(function(){
                        console.log("LOLER: window.location.toString().indexOf(redirectPathCheck) == -1");
                        return returnToLive();
                    }, rewardCheck);
                } else if((rewardsEnabled == true && rewardsIcon != '#5ABBD4') || (manualTimer > timerThreshold && (containerLoaded == false || rewardsEnabled == false))){
                    // The first check is if rewards were enabled at some point in the past and aren't enabled currently
                    // The second check is a backup wait for some seconds that will refresh the page if the video still hasn't loaded
                    // #5ABBD4 is the fill color when rewards are working, #DE2F2F is the fill color when rewards aren't
                    console.log("LOLER: (rewardsEnabled == true && rewardsIcon != '#5ABBD4') || (manualTimer > timerThreshold && (containerLoaded == false || rewardsEnabled == false))");
                    return returnToLive();
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
}

function resetTimeout(timer) {
    // Clears a timer, returns null for that timer to be reset to null
    clearTimeout(timer);
    return null;
}

function returnToLive() {
    // Return to stream list of saved streamer
    window.location.assign('https://lolesports.com/schedule');
    return undefined;
}
