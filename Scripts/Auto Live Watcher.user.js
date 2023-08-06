// ==UserScript==
// @name         Auto Live Watcher
// @namespace    https://github.com/
// @version      3.5.2
// @description  Watches YouTube or Twitch live streams automatically as they appear. Also picks up Twitch Drops automatically.
// @author       Main
// @match        https://www.youtube.com/*/streams
// @match        https://www.twitch.tv/*/about
// @match        https://www.twitch.tv/drops/inventory
// @match        https://www.twitch.tv/directory/game/*
// @match        https://www.twitch.tv/directory/game/*?tl=DropsEnabled
// @grant         GM_registerMenuCommand
// @require http://code.jquery.com/jquery-3.4.1.min.js
// ==/UserScript==
// Documenting globals for JSHint to not throw an error for JQuery's $ function
/* globals $ */

// Saves where you start this script so you can jump back to it later
var startingChannel = window.location.href;
var watchedStream = window.location.href;
// Sets variable so drop clicker can refresh page after timeouts are done
var dropClickerChecks = 0;
// Only grab the stream URL once for redirect purposes
var gotStreamLink = false;
// Toggle to enable category watching mode
var categoryWatching = false;
var dropIconLoaded = false;
// Checks for the website you're currently on and runs the appropriate check
detectSite();

async function detectSite() {
    if (window.location.toString().indexOf('youtube.com') != -1) {
        const elm = await waitForElm(".ytd-two-column-browse-results-renderer");
        createLoopingInterval(youTubeMethod, 1000);
    } else if (window.location.toString().indexOf('drops/inventory') != -1) {
        const elm = await waitForElm(".inventory-page");
        dropClicker();
        createLoopingInterval(dropClicker, 60000);
    } else if (window.location.toString().indexOf('/about') != -1) {
        const elm = await waitForElm(".channel-info-content");
        createLoopingInterval(twitchMethod, 1000);
    } else if (window.location.toString().indexOf('?tl=DropsEnabled') != -1) {
        const elm = await waitForElm("[data-test-selector=direectory-grid-grid-layout]");
        createLoopingInterval(twitchMethod, 1000);
    }
}

function createLoopingInterval(method, timer) {
    // Attempts to stop multiple loops from existing at once
    if (typeof loopingInterval == 'undefined') {
        clearInterval(loopingInterval);
        var loopingInterval = setInterval(method, timer);
    }
}

// Sets up boolean and timers for the connected drops check in youTubeMethod
var timeoutCreated = false;
var noDropsReload = undefined;

function youTubeMethod() {
    // Absurd selector for the live icon in the stream list
    var liveButton = $("ytd-thumbnail-overlay-time-status-renderer.style-scope.ytd-thumbnail[overlay-style='LIVE']");
    // Selects the recommendation screen when a stream ends
    var streamEnd = $("div.html5-endscreen[style='']");
    // Click the live icon just in case the video becomes paused or falls behind
    var liveStatus = $(".ytp-live-badge:not(:disabled)");
    // Click the full player play button in case the video doesn't start
    var largePlayButton = $(".ytp-cued-thumbnail-overlay").not("[style*='display: none']").children(".ytp-large-play-button[aria-label='Play']");

    if (window.location.toString().indexOf('/watch') != -1) {
        clearTimeout(reloadStreams);
        // Creates timer to reload stream if drops are not found
        if (timeoutCreated == false) {
            clearTimeout(noDropsReload);
            noDropsReload = setTimeout(returnToLive, 300000);
            timeoutCreated = true;
        }
        // Checks for drops to be connected
        var connectedDrops = $("ytd-account-link-button-renderer:contains('Connected')");
        if (connectedDrops.length != 0) {
            clearTimeout(noDropsReload);
        }
        if (watchedStream != window.location.href && gotStreamLink == false) {
            gotStreamLink = true;
            var firstViewing = setTimeout(returnToLive, 600000);
            watchedStream = window.location.href;
        } else {
            gotStreamLink = true;
        }
        if (streamEnd.length != 0) {
            // If the recommendation screen is showing, return to the stream list
            returnToLive();
        } else if (liveStatus.length != 0) {
            // Click the live indicator when paused or behind
            liveStatus.click();
        } else if (largePlayButton.length != 0) {
            largePlayButton.click();
        }
    } else if (window.location.toString().indexOf('/streams') != -1) {
        startingChannel = window.location.href;
        gotStreamLink = false;
        timeoutCreated = false;
        if (liveButton.length == 0 && typeof reloadStreams == 'undefined') {
            // If the button does not exist, wait some time before refreshing the stream page
            // Note: clicking into a live stream continues to render the streams page, making this not work if any other live streams are available
            clearTimeout(reloadStreams);
            var reloadStreams = setTimeout(returnToLive, 300000);
        } else if (liveButton.length != 0) {
            // Click button if on the live stream page
            liveButton[0].click();
        }
    }

    if (window.location.toString() != watchedStream && window.location.toString() != startingChannel && gotStreamLink == true) {
        // Return to stream if you move away
        returnToLive();
    }
}

function returnToLive() {
    // Return to stream list of saved streamer
    window.location.assign(startingChannel);
}

function twitchMethod() {
    // Check for live icon below channel profile picture
    var liveIcon = $('div[class*="ChannelStatusTextIndicator"] [class^="CoreText"]');
    var offlineText = $('[data-test-selector="follow-panel-overlay"] [class^="CoreText"]');
    var pauseButton = $('[data-a-target="player-play-pause-button"]');
    var matureAcceptanceButton = $('[data-a-target="player-overlay-mature-accept"]');
    var reloadPlayerButton = $("div[data-a-target='tw-core-button-label-text']:contains('Click Here to Reload Player')");
    var oneClick = false;

    if (window.location.toString().indexOf('/about') != -1) {
        // Blank the category variable if you aren't using the specific button
        // If on the about page to start, save the URL to return to later
        startingChannel = window.location.href;
        if (typeof liveIcon != 'undefined' && liveIcon.text() == "LIVE" && oneClick == false) {
            // Toggle the oneClick variable to only click once in case the redirect takes too much time
            oneClick = true;
            // If live, click the live icon to join stream
            liveIcon.click();
        }
    } else if (window.location.toString().indexOf('?tl=DropsEnabled') != -1) {
        // Go through live streams with drops and click the first one available
        categoryWatching = true;
        startingChannel = window.location.href;
        var liveStreamList = $('.preview-card-image-link');
        for (var i = 0; i < liveStreamList.length; i++) {
            if (typeof liveStreamList[i] != 'undefined') {
                watchedStream = "https://www.twitch.tv" + liveStreamList.eq(i).attr('href');
                liveStreamList.eq(i).children().click();
                break;
            }
        }
    } else {
        // Reset the oneClick variable to work if you return to the about page or leave for any reason
        oneClick = false;
        if (typeof offlineText != 'undefined' && offlineText.text().includes("Follow and get notified when")) {
            // If not live, go back to the about page
            returnToLive();
        } else if (typeof matureAcceptanceButton[0] != 'undefined') {
            // Clicks the mature acceptance button
            matureAcceptanceButton[0].click();
        } else if (typeof reloadPlayerButton[0] != 'undefined') {
            // Reloads the player if it gets bugged
            reloadPlayerButton[0].click();
        } else if (typeof pauseButton[0] != 'undefined' && pauseButton.attr("data-a-player-state") == "paused") {
            // Unpauses the video
            pauseButton[0].click();
        }
    }

    if (categoryWatching == false) {
        // Variable and check for leaving the channel so you can return to the about page
        watchedStream = startingChannel.replace('/about', '');
    } else {
        // If script is watching a category, check for the drops enabled tag; if not present, return to stream list
        var dropIcon = $("[data-a-target='DropsEnabled']");
        if(dropIcon.length != 0) {
            // Checks for the drops enabled tag to be loaded in the first place
            dropIconLoaded = true;
        } else if(dropIcon.length == 0 && dropIconLoaded == true) {
            // After it's been loaded, if it disappears, reload the player
            returnToLive();
        }
    }

    if (window.location.toString() != startingChannel && window.location.toString() != watchedStream) {
        returnToLive();
    }

}

function dropClicker() {
    // Selector for claim button
    var dropClaimButton = $("[data-a-target='tw-core-button-label-text']:contains('Claim Now')");

    for (var i = 0; i < dropClaimButton.length; i++) {
        // Click every claim button if they exist
        if (typeof dropClaimButton[i] != 'undefined') {
            dropClaimButton[i].click();
        }
    }

    if (dropClickerChecks >= 5) {
        // Refresh after the timeout goes through and after clicking all the drop claims
        returnToLive();
    } else {
        dropClickerChecks++;
    }
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

GM_registerMenuCommand("Watch Category", () => {
    // Only watches streams with drops enabled
    var dropsEnabledURL = window.location.href;
    if (dropsEnabledURL.indexOf('?') != -1) {
        dropsEnabledURL = dropsEnabledURL.substring(0, dropsEnabledURL.indexOf('?'));
    }
    dropsEnabledURL = dropsEnabledURL + "?tl=DropsEnabled";

    // Immediately refresh page to get script running
    window.location.assign(dropsEnabledURL);
});
