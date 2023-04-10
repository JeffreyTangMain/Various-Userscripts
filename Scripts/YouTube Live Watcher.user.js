// ==UserScript==
// @name         YouTube Live Watcher
// @namespace    https://www.youtube.com/
// @version      1.0.0
// @description  Watches YouTube live streams automatically as they appear.
// @author       Main
// @match        https://www.youtube.com/*/streams
// @run-at        document-start
// @require http://code.jquery.com/jquery-3.4.1.min.js
// @require https://cdn.jsdelivr.net/gh/CoeJoder/waitForKeyElements.js@v1.2/waitForKeyElements.js
// ==/UserScript==
// Documenting globals for JSHint to not throw an error for JQuery's $ function
/* globals $ waitForKeyElements */

// Saves where you start this script so you can jump back to it later
var startingChannel = window.location.href;
// Waits for streams to load
waitForKeyElements(".ytd-two-column-browse-results-renderer", mainMethod, false, 3000);

function mainMethod() {
    // Absurd selector for the live icon in the stream list
    var liveButton = $("ytd-thumbnail-overlay-time-status-renderer.style-scope.ytd-thumbnail[overlay-style='LIVE']");
    // Selects the recommendation screen when a stream ends
    var streamEnd = $("div.html5-endscreen[style='']");

    if(window.location.toString().indexOf('/watch') != -1 && streamEnd.length != 0) {
        // If the recommendation screen is showing, return to the stream list
        returnToLive();
    } else if(window.location.toString().indexOf('/streams') != -1) {
        startingChannel = window.location.href;
        if(liveButton.length == 0) {
            // If the button does not exist, wait some time before refreshing the stream page
            // Note: clicking into a live stream continues to render the streams page, making this not work if any other live streams are available
            var reloadStreams = setInterval(function() {
                returnToLive();
            }, 300000);
        } else{
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
    window.location.href = startingChannel;
}
