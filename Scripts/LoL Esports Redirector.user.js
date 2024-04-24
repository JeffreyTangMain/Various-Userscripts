// ==UserScript==
// @name         LoL Esports Redirector
// @namespace    https://github.com/
// @version      5.0.5
// @description  Redirects the schedule to the livestream so you're always watching when it's available.
// @author       Main
// @match        https://lolesports.com/*/schedule*
// @match        https://lolesports.com/schedule*
// @match        https://lolesports.com/live/*
// @match        https://www.youtube.com/embed/*lolesports.com*
// @match        https://play.afreecatv.com/*/direct?fromApi=1
// @match        https://player.twitch.tv/*parent=lolesports*
// @match        https://*.trovo.live/embed*
// @grant        GM_addStyle
// @require      http://code.jquery.com/jquery-3.4.1.min.js
// ==/UserScript==
// Documenting globals for JSHint to not throw an error for JQuery's $ function
/* globals $ */

var loopingInterval = null;
var nothingLoadingReload = null;
var containerLoaded = false;
var delayRefreshTimer = 300000;
var loadingScreenCounter = 0;

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
} else if (window.location.toString().indexOf('trovo.live') != -1) {
    trovoEmbedScript();
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
        if($(".nextvideo:visible").length != 0) {
            $(".nextvideo:visible").click();
            scriptConfirmLaunch("LOLER: Next Video Click");
        }
        if($("button.play").not(".prev, .next").length != 0) {
            $("button.play").not(".prev, .next").click();
            scriptConfirmLaunch("LOLER: Play Click");
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

async function trovoEmbedScript() {
    const elm = await waitForElm(".player-video");
    scriptConfirmLaunch("LOLER: Trovo Embed Loaded");
    createLoopingInterval(autoplayEmbed, 5000);

    function autoplayEmbed(){
        var unpauseButton = $(".vcp-controls-panel:not(.vcp-playing) .vcp-playtoggle");

        if(unpauseButton.length != 0) {
            unpauseButton.click();
        }
    }
}

async function lolEsportsScript() {
    scriptConfirmLaunch("LOLER: Primary Script Loaded");
    if(nothingLoadingReload == null) {
        // Timer to reload if heartbeating doesn't start and continue every couple minutes
        nothingLoadingReload = setTimeout(returnToLive, delayRefreshTimer);
    }
    var heartbeatStopCounter = 0;

    var oldLog = unsafeWindow.console.log;

    unsafeWindow.console.log = function(msg) {
        try {
            if(arguments.length <= 1 || arguments == undefined || arguments == null || arguments[0].includes('Apollo DevTools')){
                null;
            } else {
                // arguments[2] refers to the text before the -> in the console
                if(arguments[2].includes('RewardsStatusInformer')) {
                    if(arguments[4].includes('stopped')){
                        // arguments[4] includes the heartbeater status update
                        // Refreshes after a delay if the RewardsStatusInformer's heartbeat has stopped
                        // Note: heartbeater stops if the embed is muted and in the background, make sure you don't mute it in the embed
                        if(heartbeatStopCounter < 2) {
                            // Tracks the number of stopped heartbeats, refreshes if heartbeat is dead for some minutes
                            heartbeatStopCounter++;
                        } else {
                            scriptConfirmLaunch("LOLER: arguments[4].includes('stopped')");
                            return returnToLive();
                        }
                    } else if(arguments[4].includes('heartbeating')){
                        scriptConfirmLaunch("LOLER: nothingLoadingReload = resetTimeout(nothingLoadingReload);");
                        nothingLoadingReload = resetTimeout(nothingLoadingReload);
                        nothingLoadingReload = setTimeout(returnToLive, delayRefreshTimer);

                        heartbeatStopCounter = 0;
                    }
                    if(!(arguments[5].includes('mission=on') || arguments[5].includes('drop=on'))){
                        // Checks if there are no missions or drops
                        if(sessionStorageIntHandler("liveGameCurrentLinkNumber", 0) < sessionStorageIntHandler("liveGameAmount", 1) && sessionStorageDefault("liveGameFinalLink", "false") == "false") {
                            scriptConfirmLaunch('LOLER: sessionStorageIntHandler("liveGameCurrentLinkNumber", 0) < sessionStorageIntHandler("liveGameAmount", 1) && sessionStorageDefault("liveGameFinalLink", "false") == "false"');
                            return returnToLive();
                        } else if((Date.now() - sessionStorageIntHandler("currentMinute", 0)) > delayRefreshTimer){
                            scriptConfirmLaunch('LOLER: (Date.now() - sessionStorageIntHandler("currentMinute", 0)) > delayRefreshTimer');
                            return returnToLive();
                        }
                    }
                    else if((arguments[5].includes('mission=on') || arguments[5].includes('drop=on'))){
                        // If there are rewards or drops, set final link to sit on this link for drops
                        sessionStorage.setItem("liveGameFinalLink", "true");
                    }
                } else if(arguments[2].includes('VideoPlayer')) {
                    // Checks if the video player has ended, which indicates a VOD
                    if(arguments[5].includes('ended')){
                        scriptConfirmLaunch("LOLER: arguments[5].includes('ended')");
                        return returnToLive();
                    }
                    // Checks if the video player is playing
                    else if(arguments[5].toLowerCase().includes('playing')){
                        containerLoaded = true;
                    }
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
            }
        } catch (error) {
            scriptConfirmLaunch("LOLER: " + error);
        }
        oldLog.apply(null, arguments);
    }

    sessionStorage.setItem("currentMinute", Date.now());

    if(window.location.toString().indexOf('/schedule') != -1){
        const elm = await waitForElm('[data-test-id="virtuoso-item-list"]');
        scriptConfirmLaunch("LOLER: /schedule liveClicker Loop");
        createLoopingInterval(lolEsportsLoop, 1000);
    } else {
        scriptConfirmLaunch("LOLER: else liveClicker Loop");
        window.onload = createLoopingInterval(lolEsportsLoop, 1000);
    }
}

var noLiveGameReload = null;
var manualTimer = 0;
var timerThreshold = 60;
var rewardsEnabled = false;

function lolEsportsLoop() {
    checkInfiniteLoad();

    if(window.location.toString().indexOf("/schedule") != -1){
        // Functions if we're on the schedule page
        clickDisabledLeagues();

        var liveGameList = $('a[href^="/live/"]');
        if(liveGameList.length >= 1) {
            noLiveGameReload = resetTimeout(noLiveGameReload);
            // If there is a live game list, iterate through it
            var liveButton = iterateLiveGameList(liveGameList);
            if(liveButton != undefined) {
                liveButton.click();
            }
        } else if(liveGameList.length < 1) {
            // If there is no live game list, prepare a timer to reload the page
            if(noLiveGameReload == null) {
                noLiveGameReload = setTimeout(returnToLive, delayRefreshTimer);
            }
        }
    } else if(window.location.toString().indexOf("/live") != -1){
        // Functions if we're on the live page

        // If timer less than threshold, increment every loop of this function
        manualTimer < timerThreshold ? manualTimer++ : null;

        var rewardsIcon = $('.RewardsStatusInformer .status-summary svg path').attr('fill');
        if(rewardsIcon == '#5ABBD4'){
            rewardsEnabled = true;
        }

        var dropsFulfilled = $('.drops-fulfilled')
        if(dropsFulfilled.length > 0){
            var dropsFulfilledClose = $('.drops-fulfilled .actions .close');
            dropsFulfilledClose.click();
        }

        if((rewardsEnabled == true && rewardsIcon != '#5ABBD4') || (manualTimer > timerThreshold && (containerLoaded == false || rewardsEnabled == false))){
            // The first check is if rewards were enabled at some point in the past and aren't enabled currently
            // The second check is a backup wait for some seconds that will refresh the page if the video still hasn't loaded
            // #5ABBD4 is the fill color when rewards are working, #DE2F2F is the fill color when rewards aren't
            scriptConfirmLaunch("LOLER: (rewardsEnabled == true && rewardsIcon != '#5ABBD4') || (manualTimer > timerThreshold && (containerLoaded == false || rewardsEnabled == false))");
            return returnToLive();
        }
    } else {
        // Functions run if not on live or schedule page
        return returnToLive();
    }
}

function clickDisabledLeagues() {
    // Finds and clicks all leagues in the sidebar that aren't currently enabled
    var clickedLeagues = $('[data-filter="none"]');
    clickedLeagues.each(function() {
        this.click();
    });
}

function iterateLiveGameList(liveGameList) {
    // Goes through every currently available live game to check if there are drops
    // Grabs every live link and compares it to storage to make sure the list is the latest one
    var liveGameLinks = "";
    liveGameList.each(function() {
        liveGameLinks = liveGameLinks + this.href;
    });

    // Sets the current link number for iteration to 0 if the link list has changed from memory
    if(sessionStorageDefault("liveGameLinks", "") != liveGameLinks) {
        sessionStorage.setItem("liveGameAmount", liveGameList.length);
        sessionStorage.setItem("liveGameLinks", liveGameLinks);
        sessionStorage.setItem("liveGameCurrentLinkNumber", 0);
        sessionStorage.setItem("liveGameFinalLink", "false");
    }

    var liveGameCurrentLinkNumber = sessionStorageIntHandler("liveGameCurrentLinkNumber", 0);
    var liveGameFinalLink = sessionStorageDefault("liveGameFinalLink", "false");

    if(liveGameCurrentLinkNumber < liveGameList.length && liveGameFinalLink == "false") {
        sessionStorage.setItem("liveGameCurrentLinkNumber", liveGameCurrentLinkNumber + 1);
        var liveButton = liveGameList[liveGameCurrentLinkNumber];
        if(liveGameCurrentLinkNumber + 1 == liveGameList.length) {
            sessionStorage.setItem("liveGameFinalLink", "true");
        }
    } else {
        if(liveGameCurrentLinkNumber != 0) {
            liveGameCurrentLinkNumber = liveGameCurrentLinkNumber - 1;
        } else {
            sessionStorage.setItem("liveGameCurrentLinkNumber", 1);
        }
        liveButton = liveGameList[liveGameCurrentLinkNumber];
    }

    return liveButton;
}

function checkInfiniteLoad() {
    if($(".InformLoading").length != 0) {
        if((Date.now() - sessionStorageIntHandler("loadingCurrentMinute", 0)) > 30000) {
            sessionStorage.setItem("loadingCurrentMinute", Date.now());
            loadingScreenCounter++;
        }

        if(loadingScreenCounter >= 5) {
            return returnToLive();
        }
    } else {
        loadingScreenCounter = 0;
    }
}

function sessionStorageDefault(key, storeDefault) {
    var returnStorage = sessionStorage.getItem(key);
    if(returnStorage == null){
        returnStorage = storeDefault;
    }

    return returnStorage;
}

function sessionStorageIntHandler(key, storeDefault) {
    // Calls the above function for sessionStorage to be turned into an int
    var returnStorage = sessionStorageDefault(key, storeDefault);
    returnStorage = parseInt(returnStorage);

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
    nothingLoadingReload = resetTimeout(nothingLoadingReload);
    noLiveGameReload = resetTimeout(noLiveGameReload);
    loopingInterval = resetInterval(loopingInterval);
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
