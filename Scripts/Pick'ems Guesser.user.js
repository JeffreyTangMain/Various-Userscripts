// ==UserScript==
// @name         Pick'ems Guesser
// @namespace    https://pickem.overwatchleague.com//
// @version      1.0.0
// @description  Automatically guesses Pick'ems for you based on the fan favorites.
// @author       Main
// @match        https://pickem.overwatchleague.com/en-us/predictions/*
// @run-at        document-start
// @grant        GM_registerMenuCommand
// @require http://code.jquery.com/jquery-3.4.1.min.js
// @require https://cdn.jsdelivr.net/gh/CoeJoder/waitForKeyElements.js@v1.2/waitForKeyElements.js
// ==/UserScript==
// Documenting globals for JSHint to not throw an error for JQuery's $ function
/* globals $ waitForKeyElements */

GM.registerMenuCommand("Do Pick'ems", doPickems);

var checkingStats = true;
var teamOffset = 0;
var i = 0;
var teamList = new Array();

async function doPickems() {
    var plusIcons = $(".plus");
    checkingStats = true;
    teamOffset = 0;
    i = 0;

    for (i = 0; i < plusIcons.length; i += 2) {
        $(".plus").eq(i).parents(".matchup").find(".stats-wrapper").click();
        const elm = await waitForElm('p.tw-font-display.tw-font-semibold.tw-text-2xl.tw-ml-auto');

        const stats = await checkStats();

        teamOffset = 0;
        checkingStats = true;
    }

    var crystalBallLeagues = $(".region");
    var highestTeamScore = 0;
    var highestTeamIndex = 0;

    for (var h = 0; h < crystalBallLeagues.length; h++) {
        for (i = 0; i < crystalBallLeagues.eq(h).find(".name").length; i++) {
            for (var j = 0; j < teamList.length; j += 2) {
                if (crystalBallLeagues.eq(h).find(".name").eq(i).text() == teamList[j]) {
                    if (highestTeamScore < teamList[j + 1]) {
                        highestTeamScore = teamList[j + 1];
                        highestTeamIndex = i;
                    }
                }
            }
        }

        crystalBallLeagues.eq(h).find(".name").eq(highestTeamIndex).click();
        highestTeamScore = 0;
        highestTeamIndex = 0;
    }

    savePredictions();
}

async function checkStats() {
    var stats = $("p.tw-font-display.tw-font-semibold.tw-text-2xl.tw-ml-auto");
    var plusIcons = $(".plus");

    if (!teamList.includes($(".team-logo").eq(0).attr("alt").split(/(?=[A-Z])/)[1])) {
        teamList.push($(".team-logo").eq(0).attr("alt").split(/(?=[A-Z])/)[1]);
        teamList.push(0);
    }
    if (!teamList.includes($(".team-logo").eq(1).attr("alt").split(/(?=[A-Z])/)[1])) {
        teamList.push($(".team-logo").eq(1).attr("alt").split(/(?=[A-Z])/)[1]);
        teamList.push(0);
    }

    for (var j = 0; j < teamList.length; j += 2) {
        if (teamList[j] == $(".team-logo").eq(0).attr("alt").split(/(?=[A-Z])/)[1]) {
            teamList[j + 1] = teamList[j + 1] + parseInt($("p.tw-font-display.tw-font-semibold.tw-text-2xl.tw-ml-auto").eq(0).text());
        } else if (teamList[j] == $(".team-logo").eq(1).attr("alt").split(/(?=[A-Z])/)[1]) {
            teamList[j + 1] = teamList[j + 1] + parseInt($("p.tw-font-display.tw-font-semibold.tw-text-2xl.tw-ml-auto").eq(1).text());
        }
    }

    if ($("p.tw-font-display.tw-font-semibold.tw-text-2xl.tw-ml-auto").eq(0).text() < $("p.tw-font-display.tw-font-semibold.tw-text-2xl.tw-ml-auto").eq(1).text()) {
        teamOffset = 1;
    }

    $(".dismiss").click();

    teamOffset += i;

    var timeout1 = setTimeout(clickPlus, 500, teamOffset, plusIcons);
    var timeout2 = setTimeout(clickPlus, 1000, teamOffset, plusIcons);
    var timeout3 = setTimeout(clickPlus, 1500, teamOffset, plusIcons);
    var timeout4 = setTimeout(setFalse, 2000);

    const waitFor = delay => new Promise(resolve => setTimeout(resolve, delay));

    await waitFor(2500);

    savePredictions();

    let myPromise = new Promise(function(myResolve, myReject) {
        if (checkingStats == false) {
            myResolve("OK");
        } else {
            myReject("Error");
        }
    });

    return myPromise;
}

function savePredictions() {
    var savePredictions = $("button:contains('Save Predictions')");

    for (i = 0; i < savePredictions.length; i++) {
        savePredictions.eq(i).click();
    }
}

function clickPlus(i, jQuery) {
    jQuery.eq(i).click();
}

function setFalse() {
    checkingStats = false;
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
