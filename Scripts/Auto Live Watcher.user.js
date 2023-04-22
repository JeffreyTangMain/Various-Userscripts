// ==UserScript==
// @name         Auto Live Watcher
// @namespace    https://www.youtube.com/
// @version      2.0.1
// @description  Watches YouTube or Twitch live streams automatically as they appear.
// @author       Main
// @match        https://www.youtube.com/*/streams
// @match        https://www.twitch.tv/*/about
// @run-at        document-start
// @require http://code.jquery.com/jquery-3.4.1.min.js
// @require https://cdn.jsdelivr.net/gh/CoeJoder/waitForKeyElements.js@v1.2/waitForKeyElements.js
// ==/UserScript==
// Documenting globals for JSHint to not throw an error for JQuery's $ function
/* globals $ waitForKeyElements */

// Saves where you start this script so you can jump back to it later
var startingChannel = window.location.href;
// Checks for the website you're currently on and runs the appropriate check
if(window.location.toString().indexOf('youtube.com') != -1) {
    waitForKeyElements(".ytd-two-column-browse-results-renderer", youTubeMethod, false, 3000);
} else if(window.location.toString().indexOf('twitch.tv') != -1) {
    waitForKeyElements(".channel-info-content", twitchMethod, false, 3000);
}

function youTubeMethod() {
    // Absurd selector for the live icon in the stream list
    var liveButton = $("ytd-thumbnail-overlay-time-status-renderer.style-scope.ytd-thumbnail[overlay-style='LIVE']");
    // Selects the recommendation screen when a stream ends
    var streamEnd = $("div.html5-endscreen[style='']");

    if(window.location.toString().indexOf('/watch') != -1 && streamEnd.length != 0) {
        // If the recommendation screen is showing, return to the stream list
        returnToLive();
    } else if(window.location.toString().indexOf('/streams') != -1) {
        startingChannel = window.location.href;
        if(liveButton.length == 0 && reloadStreams == undefined) {
            // If the button does not exist, wait some time before refreshing the stream page
            // Note: clicking into a live stream continues to render the streams page, making this not work if any other live streams are available
            var reloadStreams = setInterval(function() {
                returnToLive();
            }, 300000);
        } else if (liveButton.length != 0) {
            // Click button if on the live stream page and remove the reload interval if it exists
            if(reloadStreams != undefined) {
                clearInterval(reloadStreams);
            }
            liveButton[0].click();
        }
    } else if(window.location.toString().indexOf('/watch') == -1 && window.location.toString().indexOf('/streams') == -1) {
        // Return to stream list if you move away
        returnToLive();
    }

    // Makes waitForKeyElements keep running
    return true;
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

    if(window.location.toString().indexOf('/about') != -1) {
        // If on the about page to start, save the URL to return to later
        startingChannel = window.location.href;
    }

    if(liveIcon != undefined && liveIcon.text() == "LIVE") {
        if(offlineText != undefined && offlineText.text().includes("Follow and get notified when")) {
            // If not live, go back to the about page
            returnToLive();
        } else if(pauseButton[0] != undefined && pauseButton.attr("data-a-player-state") == "playing") {
            // Unpauses the video
            pauseButton.click();
        }
        // If live, click the live icon to join stream
        liveIcon.click();
    }

    // Makes waitForKeyElements keep running
    return true;
}
