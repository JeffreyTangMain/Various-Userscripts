// ==UserScript==
// @name         Auto Live Watcher
// @namespace    https://github.com/
// @version      3.10.1
// @description  Watches YouTube or Twitch live streams automatically as they appear. Also picks up Twitch Drops automatically.
// @author       Main
// @match        https://www.youtube.com/*/streams
// @match        https://www.twitch.tv/*
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_info
// @require      http://code.jquery.com/jquery-3.4.1.min.js
// ==/UserScript==
// Documenting globals for JSHint to not throw an error for JQuery's $ function
/* globals $ */

// Saves where you start this script so you can jump back to it later
var resetToLocation = window.location.href;
var currentTargetLocation = resetToLocation;
// Set by /about, YouTube, and twitchCategoryWatcher as the second check for what is being watched
if (sessionStorage.getItem("storedCurrentTarget") != null) {
    currentTargetLocation = sessionStorage.getItem("storedCurrentTarget");
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

popupText("ALWU: Auto Live Watcher Userscript Loaded");
removeConfirmPopup();

// Style for the popup
GM_addStyle(
    "#ALWUBoxConfirm {" +
    "background: black;" +
    "color: white;" +
    "font-size: max(1em, 18px);" +
    "border: 1px solid red;" +
    "padding: 4px;" +
    "position: absolute;" +
    "top: 8px; left: 8px;" +
    "max-width: 1000px;" +
    "word-wrap: break-word;" +
    "z-index: 999999;" +
    "}"
);

// Checks for the website you're currently on and runs the appropriate check
setTimeout(detectSite, 60000);

async function detectSite() {
    if (locationContains("youtube.com") && locationContains("/streams")) {
        popupText("ALWU: 1 - YouTube /streams detected");
        const elm = await waitForElm(".ytd-two-column-browse-results-renderer");
        createLoopingInterval(youTubeMethod, 1000);
    } else if (locationContains("twitch.tv")) {
        if (locationContains("drops/inventory")) {
            // Self contained loop, leads back to itself
            popupText("ALWU: 2 - Twitch drops/inventory detected");
            const elm = await waitForElm(".inventory-page");

            dropClicker();

            createLoopingInterval(dropClicker, 60000);
        } else if (locationContains("/about")) {
            // Loop leads to 6 then back if disruption is found
            popupText("ALWU: 3 - Twitch /about detected");

            // twitchAboutLocation lets the script go into the main disruption checking loop
            // storedCurrentTarget is used inside that disruption checking loop to check if the page changed 
            sessionStorage.setItem("twitchAboutLocation", window.location.href);
            sessionStorage.setItem("storedCurrentTarget", window.location.href.replace("/about", ""));

            setTimeout(resetLocation, 60000);
            createLoopingInterval(twitchAboutMethod, 1000);
        } else if (locationContains("?filter=drops&sort=VIEWER_COUNT")) {
            // Loop leads to 5 then back if disruption is found
            popupText("ALWU: 4 - Twitch Category Watcher detected");
            const elm = await waitForElm(".directory-header-new__description");
            createLoopingInterval(twitchCategoryWatcher, 1000);
        } else if (sessionStorage.getItem("twitchWatchedCategory") != null) {
            // Loop continuation from 4
            popupText("ALWU: 5 - Continuing from Twitch Category Watcher");

            resetToLocation = sessionStorage.getItem("twitchWatchedCategory");

            setTimeout(resetLocation, 3600000);
            createLoopingInterval(twitchCategoryChannelWatcher, 1000);
        } else if (sessionStorage.getItem("twitchAboutLocation") != null) {
            // Loop continuation from 3
            popupText("ALWU: 6 - Continuing from twitchAboutLocation");

            resetToLocation = sessionStorage.getItem("twitchAboutLocation");

            setTimeout(resetLocation, 3600000);
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

    if (locationContains("/watch")) {
        if (reloadStreams != null) {
            popupText("YouTube: resetTimeout(reloadStreams);");
            reloadStreams = resetTimeout(reloadStreams);
        }
        clickChecker = true;
        // Creates timer to reload stream if drops are not found
        if (timeoutCreated == false && noDropsReload == null) {
            popupText("YouTube: noDropsReload = setTimeout(resetLocation, 300000);");
            noDropsReload = resetTimeout(noDropsReload);
            noDropsReload = setTimeout(resetLocation, 300000);
            timeoutCreated = true;
        }
        // Checks for drops to be connected
        var connectedDrops = $("account-link-button-view-model:contains('Connected')");
        if (noDropsReload != null && connectedDrops.length != 0) {
            popupText("YouTube: resetTimeout(noDropsReload);");
            noDropsReload = resetTimeout(noDropsReload);
        }
        if (sessionStorage.getItem("storedCurrentTarget") != window.location.href) {
            // Refreshes the page after a delay to stop watching VODs
            popupText("YouTube: firstViewing = setTimeout(resetLocation, 600000);");
            firstViewing = setTimeout(resetLocation, 600000);
            sessionStorage.setItem("storedCurrentTarget", window.location.href);
            currentTargetLocation = window.location.href;
        }
        if (streamEnd.length != 0) {
            // If the recommendation screen is showing, return to the stream list
            popupText("YouTube: streamEnd.length != 0");
            return resetLocation();
        } else if (liveStatus.length != 0) {
            // Click the live indicator when paused or behind
            liveStatus.click();
        } else if (pauseButton.length != 0) {
            // Unpauses the video and starts the video if it didn't autoplay
            pauseButton.click();
        }
    } else if (locationContains("/streams")) {
        resetToLocation = window.location.href;
        currentTargetLocation = sessionStorage.getItem("storedCurrentTarget");
        timeoutCreated = false;
        if (reloadStreams == null) {
            // Set up timer to reload for the button to show up or if the button fails to click the first time around
            popupText("YouTube: reloadStreams = setTimeout(resetLocation, 300000);");
            reloadStreams = resetTimeout(reloadStreams);
            reloadStreams = setTimeout(resetLocation, 300000);
        }
        if (liveButton.length != 0) {
            // Click button if it exists on the stream page
            liveButton[0].click();
        }
    }

    if (window.location.href != currentTargetLocation && window.location.href != resetToLocation && clickChecker == true) {
        // Return to stream if you move away
        popupText("YouTube: window.location.href != currentTargetLocation && window.location.href != resetToLocation && clickChecker == true");
        return resetLocation();
    }
}

function twitchAboutMethod() {
    var aboutPage = sessionStorage.getItem("twitchAboutLocation");

    var liveIcon = $('.channel-status-info--live [class^="CoreText"]');
    if (typeof liveIcon != "undefined" && liveIcon.text().includes("Live")) {
        resetToLocation = aboutPage.replace("/about", "");
        popupText("Twitch: Stream is live, going to stream");
        return resetLocation();
    }
}

function twitchCheckDisruptions() {
    var offlineText = $('.channel-root__player--offline .home-offline-hero .tw-title:contains("Check out")');
    var followPanelOverlay = $(".follow-panel-overlay:contains('Follow and get notified when')");
    var currentlyLive = $('.home-carousel-info--live .channel-status-info--live:contains("Live Now")');
    var pauseButton = $('[data-a-target="player-play-pause-button"]');
    var matureAcceptanceButton = $('[data-a-target="player-overlay-mature-accept"]');
    var contentWarningButton = $('[data-a-target="content-classification-gate-overlay-start-watching-button"]');
    var reloadPlayerButton = $("div[data-a-target='tw-core-button-label-text']:contains('Reload Player')");
    //var raidPopup = $("[data-test-selector='raid-banner']");
    var viewerCount = $('[data-a-target="animated-channel-viewers-count"]');

    var startingChannelAboutRemover = resetToLocation.replace("/about", "");

    if(viewerCountLoaded == false && !(typeof viewerCount == "undefined" || viewerCount.length == 0)) {
        viewerCountLoaded = true;
    }

    if (typeof offlineText != "undefined" && offlineText.length > 0) {
        // If not live, go back to the about page
        popupText("Twitch: typeof offlineText != 'undefined'");
        return resetLocation();
    } else if (typeof followPanelOverlay != "undefined" && followPanelOverlay.length > 0) {
        popupText("Twitch: Offline stream, follow panel overlay found");
        return resetLocation();
    } else if (typeof matureAcceptanceButton[0] != "undefined") {
        // Clicks the mature acceptance button
        matureAcceptanceButton[0].click();
    } else if (typeof contentWarningButton[0] != "undefined") {
        // Clicks the content warning start watching button
        contentWarningButton[0].click();
    } else if (typeof reloadPlayerButton[0] != "undefined") {
        // Reloads the player if it gets bugged
        reloadPlayerButton[0].click();
    } else if (typeof pauseButton[0] != "undefined" && pauseButton.attr("data-a-player-state") == "paused") {
        // Unpauses the video
        pauseButton[0].click();
    } /*else if (raidPopup.length > 0) {
        // If there's a raid popup on stream, return to live
        popupText("Twitch: raidPopup.length > 0");
        return resetLocation();
    } */else if (viewerCountLoaded == true && (typeof viewerCount == "undefined" || viewerCount.length == 0)) {
        popupText("Twitch: Viewer Counter Disappeared");
        return resetLocation();
    } else if(typeof currentlyLive[0] != "undefined" && currentlyLive.length > 0) {
        // This check should only trigger from the /about page
        popupText("Twitch: Stream live but wrong live page");
        resetToLocation = currentTargetLocation;
        return resetLocation();
    } else if (
        window.location.toString().indexOf(startingChannelAboutRemover) == -1
        && window.location.toString().indexOf(currentTargetLocation) == -1) {
        popupText("Twitch: Moved away from stream page");
        return resetLocation();
    }
}

function twitchCategoryWatcher() {
    // Go through live streams with drops and click the first one available
    resetToLocation = window.location.href;
    sessionStorage.setItem("twitchWatchedCategory", resetToLocation);
    var liveStreamList = $(".preview-card-image-link");

    if (liveStreamList.length == 0 && noDropStreamsAvailable == null) {
        popupText("Twitch: noDropStreamsAvailable = setTimeout(resetLocation, 300000);");
        noDropStreamsAvailable = setTimeout(resetLocation, 300000);
    } else if (liveStreamList.length != 0) {
        if (noDropStreamsAvailable != null) {
            popupText("Twitch: resetTimeout(noDropStreamsAvailable);");
            noDropStreamsAvailable = resetTimeout(noDropStreamsAvailable);
        }
        for (var i = 0; i < liveStreamList.length; i++) {
            if (typeof liveStreamList[i] != "undefined") {
                // twitchCheckDisruptions uses storedCurrentTarget here to check for leaving the target stream after refresh 
                currentTargetLocation = "https://www.twitch.tv" + liveStreamList.eq(i).attr("href");
                sessionStorage.setItem("storedCurrentTarget", currentTargetLocation);
                resetToLocation = currentTargetLocation;
                popupText("Twitch: Found stream with drops, going to stream");
                return resetLocation();
            }
        }
    }
}

function twitchCategoryChannelWatcher() {
    // If script is watching a category, check for the right game; if not present, return to stream list
    var currentGame = resetToLocation.replace("https://www.twitch.tv/","").replace("?filter=drops&sort=VIEWER_COUNT","");
    currentGame = $("[href*='"+currentGame+"']").prop("href") + "?filter=drops&sort=VIEWER_COUNT";
    var currentTagCount = $('[aria-label^="Tag"]').length;

    if (currentGame != "undefined?filter=drops&sort=VIEWER_COUNT" && infoLoaded == false) {
        // Checks for the drops enabled tag to be loaded in the first place
        infoLoaded = true;
    } else if (infoLoaded == true) {
        if (tagCount == null) {
            tagCount = currentTagCount;
        } else if (tagCount != currentTagCount) {
            // If the amount of tags change, maybe it's a channel with no more drops, so return to the drops list
            popupText("Twitch: tagCount != currentTagCount");
            return resetLocation();
        } else if (currentGame != resetToLocation) {
            // If the current game is not the game you started with, go back to the game list
            popupText("Twitch: currentGame != resetToLocation");
            return resetLocation();
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
        popupText("Twitch: dropClickerChecks >= 3");
        return resetLocation();
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

function resetLocation() {
    // Resets all timers to stop any timeouts from triggering or lingering
    resetTimeout(noDropsReload);
    resetTimeout(reloadStreams);
    resetTimeout(firstViewing);
    resetTimeout(noDropStreamsAvailable);
    resetInterval(loopingInterval);
    window.location.assign(resetToLocation);
    return undefined;
}

function locationContains(string) {
    return window.location.toString().indexOf(string) != -1;
}

function waitForElm(selector) {
    popupText("ALWU: awaiting " + selector);
    return new Promise(resolve => {
        if (document.querySelector(selector)) {
            popupText("ALWU: await complete " + selector);
            return resolve(document.querySelector(selector));
        }

        const observer = new MutationObserver(mutations => {
            if (document.querySelector(selector)) {
                popupText("ALWU: await complete " + selector);
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

function popupText(string) {
    var current = new Date();
    // Removes any existing boxes, creates a new box with the requested text in the top left corner that can be removed with a click
    removeConfirmPopup();
    console.log(string);

    // Permanently adds these things to session storage as a log in between refreshes for debugging
    var mins = ("0"+current.getMinutes()).slice(-2);
    var detailedString = string + " | " + current.getHours() + ":" + mins + ", v" + GM_info.script.version;
    var pastLogHistory = sessionStorage.getItem("ALWUPermaLog") == null ? "" : sessionStorage.getItem("ALWUPermaLog") + " /// ";
    var currentLogHistory = pastLogHistory + detailedString;
    sessionStorage.setItem("ALWUPermaLog", currentLogHistory);

    var box = document.createElement("div");
    box.id = "ALWUBoxConfirm";
    box.textContent = detailedString;
    document.body.appendChild(box);
    box.addEventListener("click", function () {
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
    if (dropsEnabledURL.indexOf("?") != -1) {
        dropsEnabledURL = dropsEnabledURL.substring(0, dropsEnabledURL.indexOf("?"));
    }
    dropsEnabledURL = dropsEnabledURL + "?filter=drops&sort=VIEWER_COUNT";

    // Immediately refresh page to get script running
    window.location.assign(dropsEnabledURL);
});
