// ==UserScript==
// @name         Faceit Watcher
// @namespace    https://github.com/
// @version      1.0.5
// @description  Watches Faceit streams for drops automatically.
// @author       Main
// @match        https://www.faceit.com/en/watch*
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_info
// @icon         https://www.google.com/s2/favicons?sz=64&domain=faceit.com
// @require      http://code.jquery.com/jquery-3.4.1.min.js
// @noframes
// ==/UserScript==
// Documenting globals for JSHint to not throw an error for JQuery"s $ function
/* globals $ */

var popupPrefix = "FW: ";
popupMessage("Faceit Watcher Userscript Loaded");

var startingChannel = window.location.href;
if (sessionStorage.getItem("startingChannel") != null) {
    startingChannel = sessionStorage.getItem("startingChannel");
}
var loopingInterval = undefined;
var timeout = undefined;
var clickTimeout1 = undefined;
var clickTimeout2 = undefined;
var firstTimeClick = true;

GM_addStyle(
    "#FWBoxConfirm {" +
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

setTimeout(detectSite,5000);

async function detectSite() {
    if (window.location.toString().indexOf("faceit.com") != -1 &&
        window.location.toString().indexOf("/watch") != -1 &&
        window.location.toString().indexOf("/matches") == -1) {
        sessionStorage.setItem("startingChannel", window.location.href);
        popupMessage("Waiting for element");
        timeout = setTimeout(startPage,300000);
        const elm = await waitForElm("div[class^='WatchHeroCarousel']");
        popupMessage("Element detected, running script");
        createLoopingInterval(gotoStream,1000);
    } else if(sessionStorage.getItem("startingChannel") != null) {
        popupMessage("Starting channel detected");
        timeout = setTimeout(startPage,3600000);
        createLoopingInterval(gotoStream,1000);
    }
}

function gotoStream() {
    var liveIcon = $("div[class^='WatchHeroCarousel'] span:contains('Live')[class^='Text']");
    var mainLiveIcon = $("div[class^='WatchHeroCarousel'] div[style*='user-select:'] span:contains('Live')[class^='Text']");
    var claimNow = $("button:contains('Claim now')");
    var closeDropClaim = $("button:contains('Close')");
    if(jqueryClick(liveIcon) && jqueryClick(mainLiveIcon) && firstTimeClick) {
        firstTimeClick = false;
        timeout = clearTimeout(timeout);
        timeout = setTimeout(startPage,3600000);
    }
    checkDisruptions();
    if ((jqueryExist(claimNow) || jqueryExist(closeDropClaim)) && clickTimeout1 == undefined && clickTimeout2 == undefined) {
        claimDrop();
    }
}

function claimDrop() {
    var claimNow = $("button:contains('Claim now')");
    var closeDropClaim = $("button:contains('Close')");
    clickTimeout1 = setTimeout(jqueryClick,10000,claimNow);
    clickTimeout2 = setTimeout(jqueryClick,15000,closeDropClaim);
    setTimeout(resetDropTimeouts,20000);
}

function resetDropTimeouts() {
    clickTimeout1 = clearTimeout(clickTimeout1);
    clickTimeout2 = clearTimeout(clickTimeout2);
}

function checkDisruptions() {
    //var unmuteTaskbar = $("aria-label='Unmute'");
    var videosTab = $("span[class^='Primary']:contains('Videos')");

    if (window.location.href != startingChannel && (window.location.toString().indexOf("faceit.com") == -1 || window.location.toString().indexOf("/watch/matches") == -1)) {
        popupMessage("Disruption 1");
        startPage();
    }
    if(jqueryExist(videosTab)) {
        popupMessage("Disruption 2");
        startPage();
    }
}

function startPage() {
    gotoPage(startingChannel);
}

function gotoPage(page) {
    loopingInterval = clearInterval(loopingInterval);
    timeout = clearTimeout(timeout);
    window.location.assign(page);
}

function jqueryClick(element) {
    if (jqueryExist(element)) {
        element[0].click();
        return true;
    } else {
        return false;
    }
}

function jqueryClickSpecific(element, num) {
    if (jqueryExist(element)) {
        element[num].click();
        return true;
    } else {
        return false;
    }
}

function jqueryExist(element) {
    if (typeof element != "undefined" && element.length > 0) {
        return true;
    }
    return false;
}

function createLoopingInterval(method, timer) {
    // Attempts to stop multiple loops from existing at once
    if (loopingInterval == undefined) {
        loopingInterval = setInterval(method, timer);
    } else {
        popupMessage("Duplicate looping interval detected");
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

function popupMessage(string) {
    string = popupPrefix + string;
    var current = new Date();
    // Removes any existing boxes, creates a new box with the requested text in the top left corner that can be removed with a click
    hidePopup();
    console.log(string);

    // Permanently adds these things to session storage as a log in between refreshes for debugging
    var mins = ("0" + current.getMinutes()).slice(-2);
    var detailedString = string + " | " + current.getHours() + ":" + mins + ", v" + GM_info.script.version;
    var pastLogHistory = sessionStorage.getItem("FWPermaLog") == null ? "" : sessionStorage.getItem("FWPermaLog") + " /// ";
    var currentLogHistory = pastLogHistory + detailedString;
    sessionStorage.setItem("FWPermaLog", currentLogHistory);

    var box = document.createElement("div");
    box.id = "FWBoxConfirm";
    box.textContent = detailedString;
    document.body.appendChild(box);
    box.addEventListener("click", function () {
        box.parentNode.removeChild(box);
    }, true);
}

function hidePopup() {
    if ($("#FWBoxConfirm").length != 0) {
        $("#FWBoxConfirm").remove();
    }
}
