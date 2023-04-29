// ==UserScript==
// @name         Auto Live Watcher
// @namespace    https://www.youtube.com/
// @version      3.3.0
// @description  Watches YouTube or Twitch live streams automatically as they appear. Also picks up Twitch Drops automatically.
// @author       Main
// @match        https://www.youtube.com/*/streams
// @match        https://www.twitch.tv/*/about
// @match        https://www.twitch.tv/drops/inventory
// @run-at        document-start
// @require http://code.jquery.com/jquery-3.4.1.min.js
// @require https://cdn.jsdelivr.net/gh/CoeJoder/waitForKeyElements.js@v1.2/waitForKeyElements.js
// ==/UserScript==
// Documenting globals for JSHint to not throw an error for JQuery's $ function
/* globals $ waitForKeyElements */

// Saves where you start this script so you can jump back to it later
var startingChannel = window.location.href;
// Checks for the website you're currently on and runs the appropriate check
if (window.location.toString().indexOf('youtube.com') != -1) {
    waitForKeyElements(".ytd-two-column-browse-results-renderer", createLoopingInterval(youTubeMethod, 1000));
} else if (window.location.toString().indexOf('drops/inventory') != -1) {
    waitForKeyElements("[data-test-selector=drops-list__wrapper]", dropClicker);
} else if (window.location.toString().indexOf('twitch.tv') != -1) {
    waitForKeyElements(".channel-info-content", createLoopingInterval(twitchMethod, 1000));
}

function createLoopingInterval(method, timer) {
    // Attempts to stop multiple loops from existing at once
    if (typeof loopingInterval == 'undefined') {
        clearInterval(loopingInterval);
        var loopingInterval = setInterval(method, timer);
    }
}

function youTubeMethod() {
    // Absurd selector for the live icon in the stream list
    var liveButton = $("ytd-thumbnail-overlay-time-status-renderer.style-scope.ytd-thumbnail[overlay-style='LIVE']");
    // Selects the recommendation screen when a stream ends
    var streamEnd = $("div.html5-endscreen[style='']");
    // Click the live icon just in case the video becomes paused or falls behind
    var liveStatus = $(".ytp-live-badge:not(:disabled)");

    if (window.location.toString().indexOf('/watch') != -1) {
        clearTimeout(reloadStreams);
        if (streamEnd.length != 0) {
            // If the recommendation screen is showing, return to the stream list
            returnToLive();
        } else if (liveStatus.length != 0) {
            // Click the live indicator when paused or behind
            liveStatus.click();
        }
    } else if (window.location.toString().indexOf('/streams') != -1) {
        startingChannel = window.location.href;
        if (liveButton.length == 0 && typeof reloadStreams == 'undefined') {
            // If the button does not exist, wait some time before refreshing the stream page
            // Note: clicking into a live stream continues to render the streams page, making this not work if any other live streams are available
            clearTimeout(reloadStreams);
            var reloadStreams = setTimeout(returnToLive, 300000);
        } else if (liveButton.length != 0) {
            // Click button if on the live stream page
            liveButton[0].click();
        }
    } else if (window.location.toString().indexOf('/watch') == -1 && window.location.toString().indexOf('/streams') == -1) {
        // Return to stream list if you move away
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

    if (window.location.toString().indexOf('/about') != -1) {
        // If on the about page to start, save the URL to return to later
        startingChannel = window.location.href;
        if (typeof liveIcon != 'undefined' && liveIcon.text() == "LIVE") {
            // If live, click the live icon to join stream
            liveIcon.click();
        }
    }

    if (typeof offlineText != 'undefined' && offlineText.text().includes("Follow and get notified when")) {
        // If not live, go back to the about page
        returnToLive();
    } else if (typeof pauseButton[0] != 'undefined' && pauseButton.attr("data-a-player-state") == "paused") {
        // Unpauses the video
        pauseButton[0].click();
    }
}

function dropClicker() {
    // Selector for claim button
    var dropClaimButton = $('[data-test-selector="DropsCampaignInProgressRewardPresentation-claim-button"]');

    for (var i = 0; i < dropClaimButton.length; i++) {
        // Click every claim button if they exist
        if (typeof dropClaimButton[i] != 'undefined') {
            dropClaimButton[i].click();
        }
    }

    // Refresh after the timeout goes through and after clicking all the drop claims
    var reloadStreams = setTimeout(returnToLive, 300000);
}
