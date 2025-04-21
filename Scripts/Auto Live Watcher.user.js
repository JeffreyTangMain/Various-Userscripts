// ==UserScript==
// @name         Auto Live Watcher
// @namespace    https://github.com/
// @version      3.8.7
// @description  Watches YouTube or Twitch live streams automatically as they appear. Also picks up Twitch Drops automatically.
// @author       Main
// @match        https://www.youtube.com/*/streams
// @match        https://www.twitch.tv/*
// @grant         GM_registerMenuCommand
// @grant         GM_addStyle
// @grant        GM_info
// @require http://code.jquery.com/jquery-3.4.1.min.js
// ==/UserScript==
// Documenting globals for JSHint to not throw an error for JQuery's $ function
/* globals $ */

// Saves where you start this script so you can jump back to it later
var startingChannel = window.location.href;
if (sessionStorage.getItem("twitchStartingChannel") != null) {
    startingChannel = sessionStorage.getItem('twitchStartingChannel');
}
var watchedStream = startingChannel;
if (sessionStorage.getItem("watchedStream") != null) {
    watchedStream = sessionStorage.getItem('watchedStream');
}

// Sets variable so drop clicker can refresh page after timeouts are done
var dropClickerChecks = 0;
// Checks if YouTube live stream has been clicked
var clickChecker = false;
// Toggle to enable category watching mode
var infoLoaded = false;
var viewerCountLoaded = false;
var tagCount = null;
// Sets up boolean and timers for YouTube and Twitch to be null so they can see if they exist or not
var timeoutCreated = false;
var noDropsReload = null;
var reloadStreams = null;
var firstViewing = null;
var noDropStreamsAvailable = null;
var loopingInterval = null;
// Checks for the website you're currently on and runs the appropriate check
scriptConfirmLaunch("ALWU: Auto Live Watcher Userscript Loaded");

// Style for the popup
GM_addStyle(
    '#ALWUBoxConfirm {' +
    'background: black;' +
    'color: white;' +
    'font-size: max(1em, 18px);' +
    'border: 1px solid red;' +
    'padding: 4px;' +
    'position: absolute;' +
    'top: 8px; left: 8px;' +
    'max-width: 1000px;' +
    'word-wrap: break-word;' +
    'z-index: 999999;' +
    '}'
);

setTimeout(detectSite, 60000);

async function detectSite() {
    if (window.location.toString().indexOf('youtube.com') != -1 && window.location.toString().indexOf('/streams') != -1) {
        scriptConfirmLaunch("ALWU: YouTube /streams detected");
        const elm = await waitForElm(".ytd-two-column-browse-results-renderer");
        scriptConfirmLaunch("ALWU: await .ytd-two-column-browse-results-renderer");
        createLoopingInterval(youTubeMethod, 1000);
    } else if (window.location.toString().indexOf('twitch.tv') != -1) {
        if (window.location.toString().indexOf('drops/inventory') != -1) {
            scriptConfirmLaunch("ALWU: Twitch drops/inventory detected");
            const elm = await waitForElm(".inventory-page");
            scriptConfirmLaunch("ALWU: await .inventory-page");
            dropClicker();
            createLoopingInterval(dropClicker, 60000);
        } else if (window.location.toString().indexOf('/about') != -1) {
            scriptConfirmLaunch("ALWU: Twitch /about detected");
            sessionStorage.setItem('twitchAbout', window.location.href);
            sessionStorage.setItem('watchedStream', startingChannel.replace('/about', ''));
            setTimeout(returnToLive, 60000);
            createLoopingInterval(twitchAboutMethod, 1000);
        } else if (window.location.toString().indexOf('?filter=drops&sort=VIEWER_COUNT') != -1) {
            scriptConfirmLaunch("ALWU: Twitch ?filter=drops&sort=VIEWER_COUNT detected");
            const elm = await waitForElm(".directory-header-new__description");
            scriptConfirmLaunch("ALWU: await .directory-header-new__description");
            createLoopingInterval(twitchCategoryWatcher, 1000);
        } else if (sessionStorage.getItem('twitchStartingChannel') != null) {
            scriptConfirmLaunch("ALWU: sessionStorage.getItem('twitchStartingChannel') != null");
            startingChannel = sessionStorage.getItem('twitchStartingChannel');
            setTimeout(returnToLive, 3600000);
            createLoopingInterval(twitchCategoryChannelWatcher, 1000);
        } else if (sessionStorage.getItem('twitchAbout') != null) {
            scriptConfirmLaunch("ALWU: Continuing from twitchAbout");
            startingChannel = sessionStorage.getItem('twitchAbout');
            setTimeout(returnToLive, 3600000);
            createLoopingInterval(twitchCheckDisruptions, 1000);
        } else {
            removeConfirmPopup();
        }
    }
}

function youTubeMethod() {
    // Absurd selector for the live icon in the stream list
    var liveButton = $("ytd-thumbnail-overlay-time-status-renderer.style-scope.ytd-thumbnail[overlay-style='LIVE']");
    // Selects the recommendation screen when a stream ends
    var streamEnd = $("div.html5-endscreen[style='']");
    // Click the live icon just in case the video becomes paused or falls behind
    var liveStatus = $(".ytp-live-badge:not(:disabled)");
    // Click the pause button in case the video doesn't start or is paused
    var pauseButton = $(".ytp-play-button[data-title-no-tooltip='Play']");

    if (window.location.toString().indexOf('/watch') != -1) {
        if (reloadStreams != null) {
            scriptConfirmLaunch("YouTube: resetTimeout(reloadStreams);");
            reloadStreams = resetTimeout(reloadStreams);
        }
        clickChecker = true;
        // Creates timer to reload stream if drops are not found
        if (timeoutCreated == false && noDropsReload == null) {
            scriptConfirmLaunch("YouTube: noDropsReload = setTimeout(returnToLive, 300000);");
            noDropsReload = resetTimeout(noDropsReload);
            noDropsReload = setTimeout(returnToLive, 300000);
            timeoutCreated = true;
        }
        // Checks for drops to be connected
        var connectedDrops = $("account-link-button-view-model:contains('Connected')");
        if (noDropsReload != null && connectedDrops.length != 0) {
            scriptConfirmLaunch("YouTube: resetTimeout(noDropsReload);");
            noDropsReload = resetTimeout(noDropsReload);
        }
        if (sessionStorage.getItem("watchedStream") != window.location.href) {
            // Refreshes the page after a delay to stop watching VODs
            scriptConfirmLaunch("YouTube: firstViewing = setTimeout(returnToLive, 600000);");
            firstViewing = setTimeout(returnToLive, 600000);
            sessionStorage.setItem("watchedStream", window.location.href);
            watchedStream = window.location.href;
        }
        if (streamEnd.length != 0) {
            // If the recommendation screen is showing, return to the stream list
            scriptConfirmLaunch("YouTube: streamEnd.length != 0");
            return returnToLive();
        } else if (liveStatus.length != 0) {
            // Click the live indicator when paused or behind
            liveStatus.click();
        } else if (pauseButton.length != 0) {
            // Unpauses the video and starts the video if it didn't autoplay
            pauseButton.click();
        }
    } else if (window.location.toString().indexOf('/streams') != -1) {
        startingChannel = window.location.href;
        watchedStream = sessionStorage.getItem("watchedStream");
        timeoutCreated = false;
        if (reloadStreams == null) {
            // Set up timer to reload for the button to show up or if the button fails to click the first time around
            scriptConfirmLaunch("YouTube: reloadStreams = setTimeout(returnToLive, 300000);");
            reloadStreams = resetTimeout(reloadStreams);
            reloadStreams = setTimeout(returnToLive, 300000);
        }
        if (liveButton.length != 0) {
            // Click button if it exists on the stream page
            liveButton[0].click();
        }
    }

    if (window.location.href != watchedStream && window.location.href != startingChannel && clickChecker == true) {
        // Return to stream if you move away
        scriptConfirmLaunch("YouTube: window.location.href != watchedStream && window.location.href != startingChannel && clickChecker == true");
        return returnToLive();
    }
}

function twitchAboutMethod() {
    var aboutPage = sessionStorage.getItem('twitchAbout');

    var liveIcon = $('.channel-status-info--live [class^="CoreText"]');
    if (typeof liveIcon != 'undefined' && liveIcon.text().includes("Live")) {
        startingChannel = aboutPage.replace('/about', '');
        return returnToLive();
    }
}

function twitchCheckDisruptions() {
    var offlineText = $('.channel-root__player--offline .home-offline-hero tw-title:contains("Check out")');
    var pauseButton = $('[data-a-target="player-play-pause-button"]');
    var matureAcceptanceButton = $('[data-a-target="player-overlay-mature-accept"]');
    var contentWarningButton = $('[data-a-target="content-classification-gate-overlay-start-watching-button"]');
    var reloadPlayerButton = $("div[data-a-target='tw-core-button-label-text']:contains('Reload Player')");
    var raidPopup = $("[data-test-selector='raid-banner']");
    var viewerCount = $('[data-a-target="animated-channel-viewers-count"]');

    var startingChannelAboutRemover = startingChannel.replace('/about', '');

    if(viewerCountLoaded == false && !(typeof viewerCount == 'undefined' || viewerCount.length == 0)) {
        viewerCountLoaded = true;
    }

    if (typeof offlineText != 'undefined' && offlineText.length > 0) {
        // If not live, go back to the about page
        scriptConfirmLaunch("Twitch: typeof offlineText != 'undefined'");
        return returnToLive();
    } else if (typeof matureAcceptanceButton[0] != 'undefined') {
        // Clicks the mature acceptance button
        matureAcceptanceButton[0].click();
    } else if (typeof contentWarningButton[0] != 'undefined') {
        // Clicks the content warning start watching button
        contentWarningButton[0].click();
    } else if (typeof reloadPlayerButton[0] != 'undefined') {
        // Reloads the player if it gets bugged
        reloadPlayerButton[0].click();
    } else if (typeof pauseButton[0] != 'undefined' && pauseButton.attr("data-a-player-state") == "paused") {
        // Unpauses the video
        pauseButton[0].click();
    } else if (raidPopup.length > 0) {
        // If there's a raid popup on stream, return to live
        scriptConfirmLaunch("Twitch: raidPopup.length > 0");
        return returnToLive();
    } else if (viewerCountLoaded == true && (typeof viewerCount == 'undefined' || viewerCount.length == 0)) {
        scriptConfirmLaunch("Twitch: Viewer Counter Disappeared");
        return returnToLive();
    } else if (
        window.location.toString().indexOf(startingChannelAboutRemover) == -1
        && window.location.toString().indexOf(watchedStream) == -1) {
        scriptConfirmLaunch("Twitch: Moved away from stream page");
        return returnToLive();
    }
}

function twitchCategoryWatcher() {
    // Go through live streams with drops and click the first one available
    startingChannel = window.location.href;
    sessionStorage.setItem('twitchStartingChannel', startingChannel);
    var liveStreamList = $('.preview-card-image-link');

    if (liveStreamList.length == 0 && noDropStreamsAvailable == null) {
        scriptConfirmLaunch("Twitch: noDropStreamsAvailable = setTimeout(returnToLive, 300000);");
        noDropStreamsAvailable = setTimeout(returnToLive, 300000);
    } else if (liveStreamList.length != 0) {
        if (noDropStreamsAvailable != null) {
            scriptConfirmLaunch("Twitch: resetTimeout(noDropStreamsAvailable);");
            noDropStreamsAvailable = resetTimeout(noDropStreamsAvailable);
        }
        for (var i = 0; i < liveStreamList.length; i++) {
            if (typeof liveStreamList[i] != 'undefined') {
                watchedStream = "https://www.twitch.tv" + liveStreamList.eq(i).attr('href');
                sessionStorage.setItem("watchedStream", watchedStream);
                startingChannel = watchedStream;
                return returnToLive();
            }
        }
    }
}

function twitchCategoryChannelWatcher() {
    // If script is watching a category, check for the right game; if not present, return to stream list
    var currentGame = $("[data-a-target='stream-game-link']").prop("href") + "?filter=drops&sort=VIEWER_COUNT";
    var currentTagCount = $('[aria-label^="Tag"]').length;

    if (currentGame != "undefined?filter=drops&sort=VIEWER_COUNT" && infoLoaded == false) {
        // Checks for the drops enabled tag to be loaded in the first place
        infoLoaded = true;
    } else if (infoLoaded == true) {
        if (tagCount == null) {
            tagCount = currentTagCount;
        } else if (tagCount != currentTagCount) {
            // If the amount of tags change, maybe it's a channel with no more drops, so return to the drops list
            scriptConfirmLaunch("Twitch: tagCount != currentTagCount");
            return returnToLive();
        } else if (currentGame != startingChannel) {
            // If the current game is not the game you started with, go back to the game list
            scriptConfirmLaunch("Twitch: currentGame != startingChannel");
            return returnToLive();
        }
    }

    twitchCheckDisruptions();
}

function dropClicker() {
    // Clicks every claim now button
    $("[data-a-target='tw-core-button-label-text']:contains('Claim Now')").each(
        function () {
            $(this).click();
        }
    );

    if (dropClickerChecks >= 3) {
        // Refresh after the timeout goes through and after clicking all the drop claims
        scriptConfirmLaunch("Twitch: dropClickerChecks >= 3");
        return returnToLive();
    } else {
        dropClickerChecks++;
    }
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
    // Return to stream list of saved streamer
    resetTimeout(noDropsReload);
    resetTimeout(reloadStreams);
    resetTimeout(firstViewing);
    resetTimeout(noDropStreamsAvailable);
    resetInterval(loopingInterval);
    window.location.assign(startingChannel);
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
    var currentLogHistory = sessionStorage.getItem('ALWUPermaLog') + " /// " + detailedString;
    sessionStorage.setItem('ALWUPermaLog', currentLogHistory);

    var box = document.createElement('div');
    box.id = 'ALWUBoxConfirm';
    box.textContent = detailedString;
    document.body.appendChild(box);
    box.addEventListener('click', function () {
        box.parentNode.removeChild(box);
    }, true);
}

function removeConfirmPopup() {
    if ($("#ALWUBoxConfirm").length != 0) {
        $("#ALWUBoxConfirm").remove();
    }
}

GM_registerMenuCommand("Watch Category", () => {
    // Only watches streams with drops enabled
    var dropsEnabledURL = window.location.href;
    if (dropsEnabledURL.indexOf('?') != -1) {
        dropsEnabledURL = dropsEnabledURL.substring(0, dropsEnabledURL.indexOf('?'));
    }
    dropsEnabledURL = dropsEnabledURL + "?filter=drops&sort=VIEWER_COUNT";

    // Immediately refresh page to get script running
    window.location.assign(dropsEnabledURL);
});
