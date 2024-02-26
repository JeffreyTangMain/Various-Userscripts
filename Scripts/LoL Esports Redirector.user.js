// ==UserScript==
// @name         LoL Esports Redirector
// @namespace    https://github.com/
// @version      4.5.2
// @description  Redirects the schedule to the livestream so you're always watching when it's available.
// @author       Main
// @match        https://lolesports.com/schedule*
// @match        https://lolesports.com/live/*
// @match        https://www.youtube.com/embed/*lolesports.com*
// @match        *://*.afreecatv.com/player/*/embed*
// @match        https://player.twitch.tv/*parent=lolesports*
// @grant        GM_addStyle
// @require      http://code.jquery.com/jquery-3.4.1.min.js
// ==/UserScript==
// Documenting globals for JSHint to not throw an error for JQuery's $ function
/* globals $ */

var heartbeatStoppedReload = null;
var loopingInterval = null;

// Style for the popup
GM_addStyle(
    '#LOLERPopup {' +
    'background: black;' +
    'color: white;' +
    'font-size: max(1em, 18px);' +
    'border: 1px solid red;' +
    'padding: 4px;' +
    'position: fixed;' +
    'top: 8px; left: 8px;' +
    'max-width: 400px;' +
    'z-index: 999999;' +
    '}'
);

scriptConfirmLaunch("LOLER: Script Running");

if(window.location.toString().indexOf('youtube.com/embed') != -1) {
    youtubeEmbedScript();
} else if (window.location.toString().indexOf('afreecatv.com') != -1) {
    afreecatvEmbedScript();
} else if (window.location.toString().indexOf('player.twitch.tv') != -1) {
    twitchEmbedScript();
} else {
    lolEsportsScript();
}

async function youtubeEmbedScript() {
    // Handling for the YouTube embed autopausing
    const elm = await waitForElm("button.ytp-play-button");
    scriptConfirmLaunch("LOLER: YouTube Embed Loaded");
    createLoopingInterval(autoplayEmbed, 5000);

    function autoplayEmbed(){
        var liveStatus = $(".ytp-live-badge:not(:disabled)");
        var pauseButton = $(".ytp-play-button[data-title-no-tooltip='Play']");

        if (liveStatus.length != 0) {
            // Click the live indicator when paused or behind
            liveStatus.click();
        }
        if(pauseButton.length != 0){
            pauseButton.click();
        }

        return true;
    }
}

async function afreecatvEmbedScript() {
    // Handling for the Afreecatv embed autopausing
    const elm = await waitForElm("#afreecatv_player");
    scriptConfirmLaunch("LOLER: Afreecatv Embed Loaded");
    createLoopingInterval(autoplayEmbed, 5000);

    function autoplayEmbed(){
        if($(".nextvideo").length != 0) {
            $(".nextvideo").click();
        }
        if($("button.play").not(".prev, .next").length != 0) {
            $("button.play").not(".prev, .next").click();
        }

        return true;
    }
}

async function twitchEmbedScript() {
    const elm = await waitForElm("button[aria-label*='Watch on Twitch']");
    scriptConfirmLaunch("LOLER: Twitch Embed Loaded");
    createLoopingInterval(autoplayEmbed, 5000);

    function autoplayEmbed(){
        var muteOnScreen = $(".click-to-unmute__container");
        var pauseButton = $("button[data-a-player-state='paused']");
        var muteVolumeButton = $("button[aria-label*='Unmute (m)']");

        if (muteOnScreen.length != 0) {
            // Big on screen unmute button
            muteOnScreen.click();
        }
        if(pauseButton.length != 0){
            // Pause button bottom left of screen
            pauseButton.click();
        }
        if(muteVolumeButton.length != 0){
            // Mute button bottom left of screen
            muteVolumeButton.click();
        }

        return true;
    }
}

async function lolEsportsScript() {
    scriptConfirmLaunch("LOLER: Primary Script Loaded");
    var redirectPathCheck = '/live';
    var containerLoaded = false;
    var tempString = '';
    var delayRefreshTimer = 300000;
    var heartbeatStopCounter = 0;
    var loadingScreenCounter = 0;

    var oldLog = unsafeWindow.console.log;

    unsafeWindow.console.log = function(msg) {
        try {
            if(arguments.length <= 1 || arguments == undefined || arguments == null){
                null;
            }
            // arguments[2] refers to the text before the -> in the console
            else if(arguments[2].includes('RewardsStatusInformer') && arguments[4].includes('stopped')){
                // arguments[4] includes the heartbeater status update
                // Refreshes after a delay if the RewardsStatusInformer's heartbeat has stopped
                // Note: heartbeater stops if the embed is muted and in the background, make sure you don't mute it in the embed
                if(heartbeatStopCounter < 2) {
                    // Tracks the number of stopped heartbeats, refreshes if heartbeat is dead for some minutes
                    heartbeatStopCounter++;

                    // Will also refresh if too much time has passed ever since receiving a heartbeat stop
                    if(heartbeatStoppedReload == null) {
                        scriptConfirmLaunch("LOLER: heartbeatStoppedReload = setTimeout(returnToLive, 300000);");
                        heartbeatStoppedReload = resetTimeout(heartbeatStoppedReload);
                        heartbeatStoppedReload = setTimeout(returnToLive, 300000);
                    }
                } else {
                    scriptConfirmLaunch("LOLER: arguments[2].includes('RewardsStatusInformer') && arguments[4].includes('stopped')");
                    return returnToLive();
                }
            } else if(arguments[2].includes('RewardsStatusInformer') && arguments[4].includes('heartbeating') && heartbeatStoppedReload != null){
                scriptConfirmLaunch("LOLER: heartbeatStoppedReload = resetTimeout(heartbeatStoppedReload);");
                heartbeatStoppedReload = resetTimeout(heartbeatStoppedReload);
                heartbeatStopCounter = 0;
            }
            else if(arguments[2].includes('RewardsStatusInformer') && !(arguments[5].includes('mission=on') || arguments[5].includes('drop=on'))){
                // Checks if any rewards are enabled
                if(sessionStorageDefault("liveLinkNumber", 0) < sessionStorageDefault("liveGameCount", 1)) {
                    scriptConfirmLaunch('LOLER: sessionStorageDefault("liveLinkNumber", 0) < sessionStorageDefault("liveGameCount", 1)');
                    return returnToLive();
                } else if((Date.now() - sessionStorageDefault("currentMinute", 0)) > delayRefreshTimer){
                    scriptConfirmLaunch('LOLER: (Date.now() - sessionStorageDefault("currentMinute", 0)) > delayRefreshTimer');
                    return returnToLive();
                }
            }
            // Checks if the video player has ended, which indicates a VOD
            else if(arguments[2].includes('VideoPlayer') && arguments[5].includes('ended')){
                scriptConfirmLaunch("LOLER: arguments[2].includes('VideoPlayer') && arguments[5].includes('ended')");
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
                scriptConfirmLaunch("LOLER: arguments[2].includes('WatchLive') && arguments[4].length == undefined");
                return returnToLive();
            }
        } catch (error) {
            scriptConfirmLaunch("LOLER: " + error);
        }
        oldLog.apply(null, arguments);
    }

    if(window.location.toString().indexOf('/schedule') != -1){
        const elm = await waitForElm(".Event");
        mainMethod();
    } else {
        window.onload = mainMethod;
    }

    function mainMethod(){
        // A refresh function that runs when the live button is undefined and the page is not at the live section
        // This should refresh when there are no live games to check for new ones every refresh
        liveClicker(function(){setTimeout(function(){
            scriptConfirmLaunch("LOLER: mainMethod liveClicker");
            return returnToLive();
        }, delayRefreshTimer)});
    }

    function liveClicker(method, loop){
        if($(".InformLoading").length != 0) {
            if((Date.now() - sessionStorageDefault("loadingCurrentMinute", 0)) > 30000) {
                sessionStorage.setItem("loadingCurrentMinute", Date.now());
                loadingScreenCounter++;
            }

            if(loadingScreenCounter >= 5) {
                return returnToLive();
            }
        } else {
            loadingScreenCounter = 0;
        }

        scriptConfirmLaunch("LOLER: liveClicker Loop");
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
            if(sessionStorageDefault("liveGameLinks", "") != liveGameLinks) {
                sessionStorage.setItem("liveGameCount", liveGameList.length);
                sessionStorage.setItem("liveGameLinks", liveGameLinks);
                sessionStorage.setItem("liveLinkNumber", 0);
            }
        }
        // ---------------------------------------
        var liveLinkNumber = sessionStorageDefault("liveLinkNumber", 0);
        liveButton = liveButton[liveLinkNumber];
        if(liveButton == undefined){
            sessionStorage.setItem("liveLinkNumber", 0);
            liveButton = $('a.live');
            liveButton = liveButton[0];
        }
        liveLinkNumber = sessionStorageDefault("liveLinkNumber", 0);
        sessionStorage.setItem("liveLinkNumber", liveLinkNumber + 1);

        //Prepares the timer when the page is loaded to refresh if there are no rewards.
        sessionStorage.setItem("currentMinute", Date.now());

        if(liveButton == undefined && window.location.toString().indexOf(redirectPathCheck) == -1){
            return method();
        } else{
            if(liveButton != undefined){
                liveButton.click();
            }
            if(loop != null){
                loop = resetInterval(loop);
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
                        scriptConfirmLaunch("LOLER: window.location.toString().indexOf(redirectPathCheck) == -1");
                        return returnToLive();
                    }, rewardCheck);
                } else if((rewardsEnabled == true && rewardsIcon != '#5ABBD4') || (manualTimer > timerThreshold && (containerLoaded == false || rewardsEnabled == false))){
                    // The first check is if rewards were enabled at some point in the past and aren't enabled currently
                    // The second check is a backup wait for some seconds that will refresh the page if the video still hasn't loaded
                    // #5ABBD4 is the fill color when rewards are working, #DE2F2F is the fill color when rewards aren't
                    scriptConfirmLaunch("LOLER: (rewardsEnabled == true && rewardsIcon != '#5ABBD4') || (manualTimer > timerThreshold && (containerLoaded == false || rewardsEnabled == false))");
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

function sessionStorageDefault(key, storeDefault) {
    var returnStorage = sessionStorage.getItem(key);
    if(returnStorage == null){
        returnStorage = storeDefault;
    }

    if(parseInt(returnStorage) != NaN) {
        return parseInt(returnStorage);
    }

    return returnStorage;
}

function createLoopingInterval(method, timer) {
    // Attempts to stop multiple loops from existing at once
    if (loopingInterval == null) {
        loopingInterval = setInterval(method, timer);
    }
}

function resetTimeout(timer) {
    // Clears a timer, returns null for that timer to be reset to null
    clearTimeout(timer);
    return null;
}

function resetInterval(timer) {
    // Clears an interval, returns null for that interval to be reset to null
    clearInterval(timer);
    return null;
}

function returnToLive() {
    // Return to stream list
    heartbeatStoppedReload = resetTimeout(heartbeatStoppedReload);
    window.location.assign('https://lolesports.com/schedule');
    return undefined;
}

function waitForElm(selector) {
    return new Promise(resolve => {
        if (document.querySelector(selector)) {
            return resolve(document.querySelector(selector));
        }

        const observer = new MutationObserver(mutations => {
            if (document.querySelector(selector)) {
                resolve(document.querySelector(selector));
                observer.disconnect();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    });
}

function scriptConfirmLaunch(string) {
    var current = new Date();
    // Removes any existing boxes, creates a new box with the requested text in the top left corner that can be removed with a click
    removeConfirmPopup();
    console.log(string);

    // Permanently adds these things to session storage as a log in between refreshes for debugging
    var detailedString = string + " | " + current.getHours() + ":" + current.getMinutes() + ", v" + GM_info.script.version;
    var currentLogHistory = sessionStorageDefault('LOLERPermaLog', "") + " /// " + detailedString;
    sessionStorage.setItem('LOLERPermaLog', currentLogHistory);

    var box = document.createElement('div');
    box.id = 'LOLERPopup';
    box.textContent = detailedString;
    document.body.appendChild(box);
    box.addEventListener('click', function () {
        box.parentNode.removeChild(box);
    }, true);
}

function removeConfirmPopup() {
    if($("#LOLERPopup").length != 0) {
        $("#LOLERPopup").remove();
    }
}
