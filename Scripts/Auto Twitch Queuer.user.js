// ==UserScript==
// @name         Auto Twitch Queuer
// @namespace    https://github.com/
// @version      1.2.0
// @description  Queue a list of streams to open at specific times.
// @author       Main
// @match        *://www.twitch.tv/*
// @grant        GM_registerMenuCommand
// ==/UserScript==
// Should work on any website that it's enabled to work on using @match.

GM_registerMenuCommand("Grab Schedule", grabSchedule);
GM_registerMenuCommand("Read Schedule", readSchedule);
GM_registerMenuCommand("Next In Queue", nextinQueue);

var currentDate = new Date();
// getMonth is zero-indexed, so +1 to get the real month
// en-CA has YYYY-MM-DD as their format for date, en has H:MM:SS AM/PM as their format for time
var currentDateString = currentDate.toLocaleDateString("en-CA");
// Date.parse format: 2025-10-03T11:00:00 (12 hour format impossible)
// Date.getTime format: 2025-10-03 2:00:00 PM (24 hour format possible)
var scheduleList = ["https://www.twitch.tv/twitch/about",currentDateString + " 1:00:00 PM"];
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
    // Toggle away the input box if this option is clicked again
    if(document.getElementById("TwitchScheduleGrabber")) {
        document.getElementById("TwitchScheduleGrabber").remove();
        return;
    }

    var outer = document.createElement('div');
    outer.style = "position:fixed; height:40rem; width:80rem; left:12%; top:15%; transform:translate(-12%,-15%); z-index:2147483647; display:inline-block;";

    var box = document.createElement('textarea');
    box.type = 'text';
    // This'll get updated by processSchedule if you've run the script earlier
    // Showing you what channels you've scheduled already
    box.value = scheduleList.join("\n");
    box.style = "height:40rem; width:80rem; display:block; resize:both; box-sizing: border-box; padding: 2em";
    box.id = 'TwitchScheduleGrabber';

    outer.appendChild(buttonAdder("Duplicate Final Lines", duplicateLine));
    outer.appendChild(buttonAdder("Add Entry", addEntry));
    outer.appendChild(buttonAdder("Remove Entry", removeEntry));
    outer.appendChild(buttonAdder("Toggle AM/PM", toggleAMPM));
    outer.appendChild(buttonAdder("+1 Hour", () => timeAdder(1,0,0)));
    outer.appendChild(buttonAdder("+30 Minutes", () => timeAdder(0,30,0)));
    outer.appendChild(buttonAdder("-1 Hour", () => timeAdder(-1,0,0)));
    outer.appendChild(buttonAdder("-30 Minutes", () => timeAdder(0,-30,0)));
    //outer.appendChild(buttonAdder("Debug", debug));
    outer.appendChild(box);
    document.body.prepend(outer);
}

function debug() {
    return false;
}

function buttonAdder(label, fn) {
    var btn = document.createElement('button');
    btn.textContent = label;
    btn.style = "display:inline-block; cursor:pointer; border-radius:4px; background:#e0e0e0; border:2px outset #999; font-size:1rem; color:black; padding: 0 0.5rem;";
    btn.addEventListener('click', fn);
    return btn;
}

function timeAdder(hours, minutes, seconds) {
    scheduleList = document.getElementById('TwitchScheduleGrabber').value.split("\n");
    var scheduleEntryTime = new Date(scheduleList[scheduleList.length - 1]);
    scheduleEntryTime.setSeconds(scheduleEntryTime.getSeconds() + seconds);
    scheduleEntryTime.setMinutes(scheduleEntryTime.getMinutes() + minutes);
    scheduleEntryTime.setHours(scheduleEntryTime.getHours() + hours);
    var scheduleEntryTimeParsed = scheduleEntryTime.toLocaleDateString("en-CA") + " " + scheduleEntryTime.toLocaleTimeString("en");
    scheduleList.splice(scheduleList.length - 1,1,scheduleEntryTimeParsed);
    document.getElementById('TwitchScheduleGrabber').value = scheduleList.join("\n");
}

function duplicateLine() {
    scheduleList = document.getElementById('TwitchScheduleGrabber').value.split("\n");
    scheduleList.push(...scheduleList.slice(-2));
    document.getElementById('TwitchScheduleGrabber').value = scheduleList.join("\n");
}

function addEntry() {
    scheduleList = document.getElementById('TwitchScheduleGrabber').value.split("\n");
    var defaultLink = "https://www.twitch.tv/twitch/about";
    navigator.clipboard.readText().then(text => {
        if(isValidHttpUrl(text) && !text.includes('\n')) {
            defaultLink = text;
        }
        if(scheduleList.length < 2) {
            scheduleList = [defaultLink,currentDateString + " 1:00:00 PM"];
        } else {
            scheduleList.push(...[defaultLink,currentDateString + " 1:00:00 PM"]);
        }
        document.getElementById('TwitchScheduleGrabber').value = scheduleList.join("\n");
    })
}

function removeEntry() {
    scheduleList = document.getElementById('TwitchScheduleGrabber').value.split("\n");
    scheduleList.splice(scheduleList.length - 2,2);
    document.getElementById('TwitchScheduleGrabber').value = scheduleList.join("\n");
}

function toggleAMPM() {
    // Grabs the final element, which should have a time
    // Then makes another list out of that to get the AM/PM ending
    scheduleList = document.getElementById('TwitchScheduleGrabber').value.split("\n");
    var scheduleEntry = scheduleList[scheduleList.length - 1].split(" ");
    if(scheduleEntry[scheduleEntry.length - 1].includes("AM")) {
        scheduleEntry[scheduleEntry.length - 1] = "PM";
    } else {
        scheduleEntry[scheduleEntry.length - 1] = "AM";
    }
    scheduleList.splice(scheduleList.length - 1,1,scheduleEntry.join(" "));
    document.getElementById('TwitchScheduleGrabber').value = scheduleList.join("\n");
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

function nextinQueue() {
    scheduleList = sessionStorage.getItem('scheduleStorage').split(",");
    // This could probably also break if the length has an odd count, but that's user error too
    if(scheduleList.length > 0) {
        gotoNextWebsite();
    }
}

function scheduleString() {
    return scheduleList.join(joiner);
}

function processSchedule() {
    // This is either just set by readSchedule or from a previous run, so shouldn't need a check for null
    scheduleList = sessionStorage.getItem('scheduleStorage').split(",");
    var dateParser = new Date(scheduleList[1]).getTime();
    var timeDiff = dateParser - Date.now();
    if(timeDiff > 0) {
        // +100ms is a tiny amount of buffer time to possibly wait for any page changes before going there
        scheduleTimeout = setTimeout(processSchedule, timeDiff + 100);
    } else {
        gotoNextWebsite();
    }
}

function gotoNextWebsite() {
    // It's possible this entire section is vulnerable to the page refreshing from another script
    // Difficult to test, just keep in mind for future debugging
    var nextWebsite = scheduleList[0];
    scheduleList.splice(0,2);
    sessionStorage.setItem("scheduleStorage",scheduleString());
    window.location.assign(nextWebsite);
}

function isValidHttpUrl(string) {
    let url;

    try {
        url = new URL(string);
    } catch (_) {
        return false;
    }

    return url.protocol === "http:" || url.protocol === "https:";
}
