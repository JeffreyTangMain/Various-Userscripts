// ==UserScript==
// @name         Pick'ems Guesser
// @namespace    https://pickem.overwatchleague.com/
// @version      2.0.0
// @description  Automatically guesses Pick'ems for you based on the fan favorites.
// @author       Main
// @match        https://pickem.overwatchleague.com/*
// @grant        GM_registerMenuCommand
// @require http://code.jquery.com/jquery-3.4.1.min.js
// ==/UserScript==
// Documenting globals for JSHint to not throw an error for JQuery's $ function
/* globals $ */

GM.registerMenuCommand("Do Pick'ems", doPickems);

var checkingStats = true;
var teamOffset = 0;
var i = 0;
var teamList = new Array();
var totalPredictions = 0;

async function doPickems() {
    totalPredictions = $("button:contains('Save Predictions'):disabled").length;
    var plusIcons = $(".plus");
    checkingStats = true;
    teamOffset = 0;
    i = 0;

    for (i = 0; i < plusIcons.length; i += 2) {
        $(".plus").eq(i).parents(".matchup").find(".stats-wrapper").click();
        const elm = await waitForElm('.team-logo');

        const stats = await checkStats();

        teamOffset = 0;
        checkingStats = true;
    }

    var crystalBallLeagues = $(".region");
    var highestTeamScore = 0;
    var highestTeamIndex = 0;
    var secondHighestTeamIndex = 0;

    for (var h = 0; h < crystalBallLeagues.length; h++) {
        for (i = 0; i < crystalBallLeagues.eq(h).find(".name").length; i++) {
            for (var j = 0; j < teamList.length; j += 2) {
                if (crystalBallLeagues.eq(h).find(".name").eq(i).text() == teamList[j]) {
                    if (highestTeamScore < teamList[j + 1]) {
                        highestTeamScore = teamList[j + 1];
                        secondHighestTeamIndex = highestTeamIndex;
                        highestTeamIndex = i;
                    } else if (teamList[secondHighestTeamIndex + 1] < teamList[j + 1]) {
                        secondHighestTeamIndex = i;
                    }
                }
            }
        }

        crystalBallLeagues.eq(h).find(".name").eq(highestTeamIndex).click();
        crystalBallLeagues.eq(h).find(".name").eq(secondHighestTeamIndex).click();
        highestTeamScore = 0;
        highestTeamIndex = 0;
        secondHighestTeamIndex = 0;
    }

    const waitFor = delay => new Promise(resolve => setTimeout(resolve, delay));

    await waitFor(1000);

    await savePredictions();
}

async function checkStats() {
    const waitFor = delay => new Promise(resolve => setTimeout(resolve, delay));
    await waitFor(100);
    var stats = $("p.tw-font-display.tw-font-semibold.tw-text-2xl.tw-ml-auto");
    var plusIcons = $(".plus");
    var team1Name = $(".team-logo").eq(0).attr("alt").split(/(?=[A-Z])/);
    var team2Name = $(".team-logo").eq(1).attr("alt").split(/(?=[A-Z])/);

    if (!teamList.includes(team1Name[team1Name.length - 2]) && !team1Name[0].includes("Contenders")) {
        teamList.push(team1Name[team1Name.length - 2]);
        teamList.push(0);
    }
    if (!teamList.includes(team2Name[team2Name.length - 2]) && !team2Name[0].includes("Contenders")) {
        teamList.push(team2Name[team2Name.length - 2]);
        teamList.push(0);
    }

    for (var j = 0; j < teamList.length; j += 2) {
        if (teamList[j] == team1Name[team1Name.length - 2]) {
            teamList[j + 1] = teamList[j + 1] + parseInt(stats.eq(0).text());
        } else if (teamList[j] == team2Name[team2Name.length - 2]) {
            teamList[j + 1] = teamList[j + 1] + parseInt(stats.eq(1).text());
        }
    }

    if ($("p.tw-font-display.tw-font-semibold.tw-text-2xl.tw-ml-auto").eq(0).text() < $("p.tw-font-display.tw-font-semibold.tw-text-2xl.tw-ml-auto").eq(1).text()) {
        teamOffset = 1;
    }

    $(".dismiss").click();
    await waitFor(100);

    teamOffset += i;

    var currentPlus = $("button.plus:disabled").length;
    await clickUntilPlusLimit(teamOffset, plusIcons, currentPlus);
    checkingStats = false;

    await savePredictions();

    let myPromise = new Promise(function(myResolve, myReject) {
        if (checkingStats == false) {
            myResolve("OK");
        } else {
            myReject("Error");
        }
    });

    return myPromise;
}

async function savePredictions() {
    const waitFor = delay => new Promise(resolve => setTimeout(resolve, delay));
    var savePredictions = $("button:contains('Save Predictions')");
    var currentSaved = $("button:contains('Save Predictions'):disabled").length;

    for (var v = 0; v < savePredictions.length; v++) {
        savePredictions.eq(v).click();
    }

    while (currentSaved != totalPredictions) {
        currentSaved = $("button:contains('Save Predictions'):disabled").length;
        await waitFor(1000);
    }

    let myPromise = new Promise(function(myResolve, myReject) {
        if (currentSaved == totalPredictions) {
            myResolve("OK");
        } else {
            myReject("Error");
        }
    });

    return myPromise;
}

function clickPlus(i, jQuery) {
    jQuery.eq(i).click();
}

async function clickUntilPlusLimit(i, jQuery, currentPlus) {
    const waitFor = delay => new Promise(resolve => setTimeout(resolve, delay));
    var clickTracker = 10;
    var updatedPlus = $("button.plus:disabled").length;
    while (updatedPlus == currentPlus && clickTracker > 0) {
        clickPlus(i, jQuery);
        await waitFor(100);
        clickTracker--;
        updatedPlus = $("button.plus:disabled").length;
    }

    let myPromise = new Promise(function(myResolve, myReject) {
        if (updatedPlus != currentPlus || clickTracker <= 0) {
            myResolve("OK");
        } else {
            myReject("Error");
        }
    });

    return myPromise;
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
