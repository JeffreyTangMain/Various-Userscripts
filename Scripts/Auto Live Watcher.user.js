// ==UserScript==
// @name         Auto Live Watcher
// @namespace    https://github.com/
// @version      3.7.5
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
var watchedStream = window.location.href;
// Sets variable so drop clicker can refresh page after timeouts are done
var dropClickerChecks = 0;
// Checks if YouTube live stream has been clicked
var clickChecker = false;
// Toggle to enable category watching mode
var categoryWatching = false;
var infoLoaded = false;
var tagCount = null;
// Timer variable to wait a certain amount of seconds before clicking on the live button on a stream to prevent redirects, which will unload the script
var twitchLiveTimer = 0;
// Sets up boolean and timers for the connected drops check in youTubeMethod
var timeoutCreated = false;
var noDropsReload = null;
var reloadStreams = null;
var firstViewing = null;
var noDropStreamsAvailable = null;
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
    'max-width: 400px;' +
    'z-index: 999999;' +
    '}'
);

detectSite();

async function detectSite() {
    if (window.location.toString().indexOf('youtube.com') != -1 && window.location.toString().indexOf('/streams') != -1 ) {
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
            const elm = await waitForElm('div[class*="ChannelStatusTextIndicator"] [class^="CoreText"]');
            scriptConfirmLaunch("ALWU: await div[class*='ChannelStatusTextIndicator'] [class^='CoreText']");
            createLoopingInterval(twitchMethod, 1000);
        } else if (window.location.toString().indexOf('?filter=drops&sort=VIEWER_COUNT') != -1) {
            scriptConfirmLaunch("ALWU: Twitch ?filter=drops&sort=VIEWER_COUNT detected");
            const elm = await waitForElm(".directory-header-new__description");
            scriptConfirmLaunch("ALWU: await .directory-header-new__description");
            createLoopingInterval(twitchMethod, 1000);
        } else if(sessionStorage.getItem('twitchStartingChannel') != null) {
            scriptConfirmLaunch("ALWU: sessionStorage.getItem('twitchStartingChannel') != null");
            startingChannel = sessionStorage.getItem('twitchStartingChannel');
            return returnToLive();
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
        if(reloadStreams != null) {
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
        var connectedDrops = $("ytd-account-link-button-renderer:contains('Connected')");
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
        if (liveButton.length == 0 && reloadStreams == null) {
            // If the button does not exist, wait some time before refreshing the stream page
            // Note: clicking into a live stream continues to render the streams page, making this not work if any other live streams are available
            scriptConfirmLaunch("YouTube: reloadStreams = setTimeout(returnToLive, 300000);");
            reloadStreams = resetTimeout(reloadStreams);
            reloadStreams = setTimeout(returnToLive, 300000);
        } else if (liveButton.length != 0) {
            // Click button if on the live stream page
            liveButton[0].click();
        }
    }

    if (window.location.href != watchedStream && window.location.href != startingChannel && clickChecker == true) {
        // Return to stream if you move away
        scriptConfirmLaunch("YouTube: window.location.href != watchedStream && window.location.href != startingChannel && clickChecker == true");
        return returnToLive();
    }
}

function twitchMethod() {
    // Check for live icon below channel profile picture
    var liveIcon = $('div[class*="ChannelStatusTextIndicator"] [class^="CoreText"]');
    // Will only click the live icon as long as there's no viewer count, because the viewer count only shows up when the stream is in focus
    var viewerCount = $('[data-a-target="animated-channel-viewers-count"]');
    var offlineText = $('[data-test-selector="follow-panel-overlay"] [class^="CoreText"]');
    var pauseButton = $('[data-a-target="player-play-pause-button"]');
    var matureAcceptanceButton = $('[data-a-target="player-overlay-mature-accept"]');
    var contentWarningButton = $('[data-a-target="content-classification-gate-overlay-start-watching-button"]');
    var reloadPlayerButton = $("div[data-a-target='tw-core-button-label-text']:contains('Click Here to Reload Player')");
    var raidPopup = $("[data-test-selector='raid-banner']");

    if (window.location.toString().indexOf('/about') != -1) {
        // Blank the category variable if you aren't using the specific button
        // If on the about page to start, save the URL to return to later
        startingChannel = window.location.href;
        sessionStorage.setItem('twitchStartingChannel', startingChannel);
    } else if (window.location.toString().indexOf('?filter=drops&sort=VIEWER_COUNT') != -1) {
        // Go through live streams with drops and click the first one available
        categoryWatching = true;
        startingChannel = window.location.href;
        sessionStorage.setItem('twitchStartingChannel', startingChannel);
        var liveStreamList = $('.preview-card-image-link');

        if(liveStreamList.length == 0 && noDropStreamsAvailable == null) {
            scriptConfirmLaunch("Twitch: noDropStreamsAvailable = setTimeout(returnToLive, 300000);");
            noDropStreamsAvailable = setTimeout(returnToLive, 300000);
        } else if (liveStreamList.length != 0) {
            if(noDropStreamsAvailable != null) {
                scriptConfirmLaunch("Twitch: resetTimeout(noDropStreamsAvailable);");
                resetTimeout(noDropStreamsAvailable);
            }
            for (var i = 0; i < liveStreamList.length; i++) {
                if (typeof liveStreamList[i] != 'undefined') {
                    watchedStream = "https://www.twitch.tv" + liveStreamList.eq(i).attr('href');
                    liveStreamList.eq(i).children().click();
                    break;
                }
            }
        }
    } else {
        if (typeof offlineText != 'undefined' && offlineText.text().includes('Follow and get notified when')) {
            // If not live, go back to the about page
            scriptConfirmLaunch("Twitch: typeof offlineText != 'undefined' && offlineText.text().includes('Follow and get notified when')");
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
        }
    }

    if (typeof liveIcon != 'undefined' && liveIcon.text().includes("LIVE")) {
        if (twitchLiveTimer >= 60 && viewerCount.length == 0) {
            if(sessionStorage.getItem('twitchFirstViewing') != startingChannel) {
                // On the first time a stream goes live, refresh the page after some seconds to make sure the stream doesn't redirect
                scriptConfirmLaunch("Twitch: sessionStorage.getItem('twitchFirstViewing') != startingChannel");
                sessionStorage.setItem('twitchFirstViewing', startingChannel);
                return returnToLive();
            } else if (twitchLiveTimer % 5 == 0) {
                // Only goes into this check if the sessionStorage says the stream has been seen before, so the player must've refreshed
                // If live, click the live icon to join stream
                liveIcon.click();
            }
            twitchLiveTimer++;
        } else if (viewerCount.length != 0) {
            // If the live button exists and the viewerCount is != 0, then we must be watching a stream, so the first viewing storage must be reset for the stream ending or redirects
            sessionStorage.setItem("twitchFirstViewing", "");
        } else {
            // Before everything, the live timer needs to be incremented for some seconds in a row before the above code can run
            twitchLiveTimer++;
        }
    } else {
        // If the live button disappears for any reason, the timer will reset
        twitchLiveTimer = 0;
    }

    if (categoryWatching == false) {
        // Variable and check for leaving the channel so you can return to the about page
        watchedStream = startingChannel.replace('/about', '');
    } else {
        // If script is watching a category, check for the right game; if not present, return to stream list
        var currentGame = $("[data-a-target='stream-game-link']").prop("href") + "?filter=drops&sort=VIEWER_COUNT";
        var currentTagCount = $('[aria-label^="Tag"]').length;

        if(currentGame != "undefined?filter=drops&sort=VIEWER_COUNT" && infoLoaded == false) {
            // Checks for the drops enabled tag to be loaded in the first place
            infoLoaded = true;
        } else if (infoLoaded == true) {
            if(tagCount == null) {
                tagCount = currentTagCount;
            } else if(tagCount != currentTagCount) {
                // If the amount of tags change, maybe it's a channel with no more drops, so return to the drops list
                scriptConfirmLaunch("Twitch: tagCount != currentTagCount");
                return returnToLive();
            } else if(currentGame != startingChannel) {
                // If the current game is not the game you started with, go back to the game list
                scriptConfirmLaunch("Twitch: currentGame != startingChannel");
                return returnToLive();
            }
        }
    }

    if (window.location.toString() != startingChannel && window.location.toString() != watchedStream) {
        scriptConfirmLaunch("Twitch: window.location.toString() != startingChannel && window.location.toString() != watchedStream");
        return returnToLive();
    } else if (raidPopup.length > 0) {
        scriptConfirmLaunch("Twitch: raidPopup.length > 0");
        return returnToLive();
    }
}

function dropClicker() {
    // Clicks every claim now button
    $("[data-a-target='tw-core-button-label-text']:contains('Claim Now')").each(
        function() {
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
    if (typeof loopingInterval == 'undefined') {
        clearInterval(loopingInterval);
        var loopingInterval = setInterval(method, timer);
    }
}

function resetTimeout(timer) {
    // Clears a timer, returns null for that timer to be reset to null
    clearTimeout(timer);
    return null;
}

function returnToLive() {
    // Return to stream list of saved streamer
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
    var box = document.createElement('div');
    box.id = 'ALWUBoxConfirm';
    box.textContent = string + " | " + current.getHours() + ":" + current.getMinutes() + ", v" + GM_info.script.version;
    document.body.appendChild(box);
    box.addEventListener('click', function () {
        box.parentNode.removeChild(box);
    }, true);
}

function removeConfirmPopup() {
    if($("#ALWUBoxConfirm").length != 0) {
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
