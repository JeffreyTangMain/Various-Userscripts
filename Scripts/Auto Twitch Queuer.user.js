// ==UserScript==
// @name         Auto Twitch Queuer
// @namespace    https://github.com/
// @version      1.0.0
// @description  Queue a list of streams to open at specific times.
// @author       Main
// @match        *://www.twitch.tv/*
// @grant        GM_registerMenuCommand
// ==/UserScript==
// Should work on any website that it's enabled to work on using @match.

GM_registerMenuCommand("Grab Schedule", grabSchedule);
GM_registerMenuCommand("Read Schedule", readSchedule);

var scheduleList = ["https://www.twitch.tv/directory/following","2025-10-03T11:00:00"];
var slicedSchedule;
var joiner = ",";
// This is set by processSchedule to be cleared by readSchedule if the schedule is ever updated
var scheduleTimeout;

var sessionStorageNull = sessionStorage.getItem('scheduleStorage') == null;

if(!sessionStorageNull) {
    if(sessionStorage.getItem('scheduleStorage').split(",").length >= 2) {
        // Only runs if you've started the script earlier
        // >= 2 because session storage with just "" checked this way returns length 1
        processSchedule();
    }
}

function grabSchedule(string) {
    var box = document.createElement('textarea');
    box.type = 'text';
    // This'll get updated by processSchedule if you've run the script earlier
    // Showing you what channels you've scheduled already
    box.value = scheduleList.join("\n");
    box.id = 'TwitchScheduleGrabber';
    document.body.prepend(box);
}

function readSchedule() {
    // It would be smarter to make sure there's no empty elements at the end
    // But it's also user error to include empty elements, so no fix is implemented at the moment
    scheduleList = document.getElementById('TwitchScheduleGrabber').value.split("\n");
    document.getElementById("TwitchScheduleGrabber").remove();
    sessionStorage.setItem("scheduleStorage",scheduleString());
    clearTimeout(scheduleTimeout);
    processSchedule();
}

function scheduleString() {
    return scheduleList.join(joiner);
}

function processSchedule() {
    // This is either just set by readSchedule or from a previous run, so shouldn't need a check for null
    scheduleList = sessionStorage.getItem('scheduleStorage').split(",");
    var timeDiff = Date.parse(scheduleList[1]) - Date.now();
    if(timeDiff > 0) {
        // +100ms is a tiny amount of buffer time to possibly wait for any page changes before going there
        scheduleTimeout = setTimeout(processSchedule, timeDiff + 100);
    } else {
        // It's possible this entire section is vulnerable to the page refreshing from another script
        // Difficult to test, just keep in mind for future debugging
        var nextWebsite = scheduleList[0];
        scheduleList.splice(0,2);
        sessionStorage.setItem("scheduleStorage",scheduleString());
        window.location.assign(nextWebsite);
    }
}
