// ==UserScript==
// @name         Auto Twitch Queuer
// @namespace    https://github.com/
// @version      1.6.0
// @description  Queue a list of streams to open at specific times with automatic campaign farming.
// @author       Main
// @match        *://www.twitch.tv/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @noframes
// ==/UserScript==

GM_registerMenuCommand("Open Schedule", grabSchedule);
GM_registerMenuCommand("Next In Queue", nextinQueue);
GM_registerMenuCommand("Cancel Schedule", cancelQueue);
GM_registerMenuCommand("Auto Farm Campaigns", autoFarmCampaignsToggle);
GM_registerMenuCommand("Edit Campaigns Priority", editCampaignsPriority);
GM_registerMenuCommand("Drops Tracker", openDropsTracker);

var currentDate = new Date();
var currentDateString = currentDate.toLocaleDateString("en-CA");
var scheduleList = [];
var joiner = ",";
var scheduleTimeout;
var inventoryCheckInterval;
var currentFarmingGame = null;
var currentFarmingCampaign = null;
var inventoryIframe = null;

var sessionStorageNull = sessionStorage.getItem('scheduleStorage') == null;

if(!sessionStorageNull) {
    if(sessionStorage.getItem('scheduleStorage').split(",").length >= 2) {
        processSchedule();
    } else {
        sessionStorage.removeItem("scheduleStorage");
    }
}

if(window.location.pathname === "/drops/campaigns") {
    injectDropButtons();
}

if (sessionStorage.getItem("AutoTwitchQueuerAutoFarmCampaigns") == "true" &&
    window.location.pathname !== "/drops/campaigns" &&
    window.location.pathname !== "/drops/inventory" &&
    !window.location.pathname.startsWith("/directory") &&
    sessionStorage.getItem("farmingGameName")) {
    setTimeout(function() {
        startInventoryChecking();
    }, 3000);
}

function getInventoryIframe() {
    if (inventoryIframe && inventoryIframe.parentNode) {
        return inventoryIframe;
    }
    inventoryIframe = document.createElement('iframe');
    inventoryIframe.style.display = 'none';
    inventoryIframe.src = 'https://www.twitch.tv/drops/inventory';
    document.body.appendChild(inventoryIframe);
    return inventoryIframe;
}


function checkInventoryForCampaign(campaignName, endDate) {
    return new Promise(function(resolve) {
        var iframe = getInventoryIframe();
        function doCheck() {
            try {
                var doc = iframe.contentDocument || iframe.contentWindow.document;
                if (!doc || !doc.body) {
                    resolve(true);
                    return;
                }
                var inventoryItems = doc.querySelectorAll('.inventory-campaign-info');
                if (inventoryItems.length === 0) {
                    console.log("Inventory items not found in iframe — assuming still active");
                    resolve(true);
                    return;
                }
                var found = false;
                inventoryItems.forEach(function(item) {
                    var nameLink = item.querySelector('a.tw-link');
                    if (nameLink && nameLink.textContent.trim() === campaignName) {
                        found = true;
                    }
                });
                resolve(found);
            } catch(e) {
                console.log("Iframe access error:", e.message);
                resolve(true);
            }
        }
        var timeout = setTimeout(function() {
            console.log("Inventory iframe load timed out — assuming still active");
            resolve(true);
        }, 20000);
        iframe.onload = function() {
            clearTimeout(timeout);
            setTimeout(doCheck, 3000);
        };
        iframe.src = 'https://www.twitch.tv/drops/inventory';
    });
}

function getDropsTracker() {
    var tracker = GM_getValue('dropsTracker', {});
    if (!tracker || typeof tracker !== 'object' || Array.isArray(tracker)) {
        tracker = {};
        setDropsTracker(tracker);
    }
    return tracker;
}

function setDropsTracker(tracker) {
    GM_setValue('dropsTracker', tracker);
}

function addCampaignToTracker(gameName, campaignName, endDate) {
    var tracker = getDropsTracker();
    if (!tracker[gameName]) {
        tracker[gameName] = [];
    }
    var existing = tracker[gameName].find(c => c.name === campaignName);
    if (!existing) {
        tracker[gameName].push({
            name: campaignName,
            endDate: endDate,
            completed: false
        });
    } else {
        existing.endDate = endDate;
    }
    setDropsTracker(tracker);
}

function markCampaignCompleted(gameName, campaignName, completed) {
    var tracker = getDropsTracker();
    if (tracker[gameName]) {
        var campaign = tracker[gameName].find(c => c.name === campaignName);
        if (campaign) {
            campaign.completed = completed;
            setDropsTracker(tracker);
        }
    }
}

function deleteCampaignFromTracker(gameName, campaignName) {
    var tracker = getDropsTracker();
    if (tracker[gameName]) {
        tracker[gameName] = tracker[gameName].filter(c => c.name !== campaignName);
        if (tracker[gameName].length === 0) {
            delete tracker[gameName];
        }
        setDropsTracker(tracker);
    }
}

function deleteAllFromTracker() {
    GM_setValue('dropsTracker', {});
}

function deleteExpiredFromTracker() {
    var tracker = getDropsTracker();
    Object.keys(tracker).forEach(function(gameName) {
        tracker[gameName] = tracker[gameName].filter(function(campaign) {
            return calculateTimeRemaining(campaign.endDate) >= -60;
        });
        if (tracker[gameName].length === 0) {
            delete tracker[gameName];
        }
    });
    setDropsTracker(tracker);
}

function areAllCampaignsCompleted(gameName) {
    var tracker = getDropsTracker();
    if (!tracker || !tracker[gameName] || !Array.isArray(tracker[gameName]) || tracker[gameName].length === 0) {
        return true;
    }
    return tracker[gameName].every(c => c.completed);
}

function getUncompletedCampaigns(gameName) {
    var tracker = getDropsTracker();
    if (!tracker || !tracker[gameName] || !Array.isArray(tracker[gameName])) return [];
    return tracker[gameName].filter(c => !c.completed);
}

function parseEndDateFromRange(rangeString) {
    if (!rangeString) return null;
    var parts = rangeString.split(" - ");
    if (parts.length >= 2) {
        return parts[1].trim();
    }
    return rangeString.trim();
}

function parseCampaignsFromRow(row) {
    var campaigns = [];
    var nameEls = Array.from(row.querySelectorAll('strong')).filter(function(s) {
        return !s.closest('.drop-details__label');
    });
    var dateEls = Array.from(row.querySelectorAll('p')).filter(function(p) {
        return p.textContent.includes(' - ') && !p.closest('.drop-details__label');
    });
    var count = Math.min(nameEls.length, dateEls.length);
    for (var i = 0; i < count; i++) {
        var campaignName = nameEls[i].textContent.trim();
        var endDateRaw = dateEls[i].textContent.trim();
        var endDate = parseEndDateFromRange(endDateRaw);
        if (campaignName && endDate) {
            campaigns.push({ name: campaignName, endDate: endDate, endDateRaw: endDateRaw });
        }
    }
    return campaigns;
}

function calculateTimeRemaining(endDateString) {
    if (!endDateString) {
        console.log("calculateTimeRemaining: empty date string");
        return 0;
    }
    var cleanDate = endDateString.replace(/\s+(EDT|EST|PDT|PST|CDT|CST|MDT|MST|GMT|UTC)$/i, '');
    var endDate = new Date(cleanDate);
    var now = new Date();
    console.log("calculateTimeRemaining - raw: " + endDateString + ", cleaned: " + cleanDate + ", parsed: " + endDate + ", now: " + now);
    if (isNaN(endDate.getTime())) {
        console.log("Invalid date parsed, trying alternative parsing");
        var parts = endDateString.match(/(\w+),\s+(\w+)\s+(\d+),\s+(\d+):(\d+)\s+(AM|PM)/i);
        if (parts) {
            var months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
            var month = months[parts[2].substr(0,3)];
            var day = parseInt(parts[3]);
            var hour = parseInt(parts[4]);
            var minute = parseInt(parts[5]);
            var ampm = parts[6].toUpperCase();
            if (ampm === 'PM' && hour !== 12) hour += 12;
            if (ampm === 'AM' && hour === 12) hour = 0;
            var currentYear = new Date().getFullYear();
            endDate = new Date(currentYear, month, day, hour, minute, 0);
            if (endDate.getTime() < now.getTime() - (180 * 24 * 60 * 60 * 1000)) {
                endDate = new Date(currentYear + 1, month, day, hour, minute, 0);
            }
        } else {
            console.log("Could not parse date at all");
            return 1440;
        }
    }
    var diffMs = endDate.getTime() - now.getTime();
    var diffMinutes = Math.floor(diffMs / 60000);
    console.log("Time remaining in minutes: " + diffMinutes);
    return diffMinutes;
}

function openDropsTracker() {
    if(document.getElementById("DropsTrackerOuterWrapper")) {
        document.getElementById("DropsTrackerOuterWrapper").remove();
        return;
    }
    var outer = document.createElement('div');
    outer.style = "position:fixed; height:40rem; width:50rem; left:12%; top:15%; transform:translate(-12%,-15%); z-index:99999; display:flex; flex-direction:column; background:#222; padding:1rem; box-sizing:border-box; border-radius:6px;";
    outer.id = 'DropsTrackerOuterWrapper';
    var title = document.createElement('h2');
    title.textContent = 'Drops Tracker';
    title.style = "color:#fff; margin:0 0 0.5rem 0;";
    outer.appendChild(title);
    var itemsContainer = document.createElement('div');
    itemsContainer.style = "flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:0.5rem; margin-bottom:0.5rem;";
    function renderTrackerItems() {
        itemsContainer.innerHTML = '';
        var currentTracker = getDropsTracker();
        if (!currentTracker || typeof currentTracker !== 'object') {
            currentTracker = {};
            setDropsTracker(currentTracker);
        }
        var gameNames = Object.keys(currentTracker).sort();
        if (gameNames.length === 0) {
            var emptyMsg = document.createElement('div');
            emptyMsg.textContent = 'No campaigns tracked yet. Start auto-farming to populate.';
            emptyMsg.style = "color:#999; padding:1rem; text-align:center;";
            itemsContainer.appendChild(emptyMsg);
            return;
        }
        gameNames.forEach(function(gameName) {
            var gameHeader = document.createElement('div');
            gameHeader.style = "color:#fff; font-size:1.1rem; font-weight:bold; padding:0.25rem 0; margin-top:0.5rem;";
            gameHeader.textContent = gameName;
            itemsContainer.appendChild(gameHeader);
            var campaigns = currentTracker[gameName];
            if (!Array.isArray(campaigns)) {
                console.log("Warning: campaigns for " + gameName + " is not an array, resetting");
                currentTracker[gameName] = [];
                campaigns = [];
            }
            campaigns.forEach(function(campaign) {
                var row = document.createElement('div');
                row.style = "display:flex; align-items:center; gap:0.5rem; background:#333; padding:0.25rem 0.5rem; border-radius:4px; color:#fff; font-size:0.9rem;";
                var status = campaign.completed ? '✅' : '⏳';
                var label = document.createElement('span');
                label.textContent = status + ' ' + campaign.name + ' | End: ' + campaign.endDate;
                label.style = "flex:1;";
                var toggleBtn = buttonAdder(campaign.completed ? 'Unmark' : 'Mark Done', function() {
                    markCampaignCompleted(gameName, campaign.name, !campaign.completed);
                    renderTrackerItems();
                });
                var deleteBtn = buttonAdder('Delete', function() {
                    deleteCampaignFromTracker(gameName, campaign.name);
                    renderTrackerItems();
                });
                row.appendChild(label);
                row.appendChild(toggleBtn);
                row.appendChild(deleteBtn);
                itemsContainer.appendChild(row);
            });
        });
    }
    renderTrackerItems();
    var btnRow = document.createElement('div');
    btnRow.style = "display:flex; gap:0.5rem;";
    btnRow.appendChild(buttonAdder("Delete All", function() {
        if (confirm("Delete all tracked campaigns?")) {
            deleteAllFromTracker();
            renderTrackerItems();
        }
    }));
    btnRow.appendChild(buttonAdder("Delete Expired", function() {
        deleteExpiredFromTracker();
        renderTrackerItems();
    }));
    btnRow.appendChild(buttonAdder("Refresh", function() {
        renderTrackerItems();
    }));
    btnRow.appendChild(buttonAdder("Close", function() {
        outer.remove();
    }));
    var fallbackRow = document.createElement('div');
    fallbackRow.style = "display:flex; align-items:center; gap:0.5rem; margin-bottom:0.5rem; color:#fff; font-size:0.9rem;";
    var fallbackLabel = document.createElement('span');
    fallbackLabel.textContent = 'Fallback channel:';
    fallbackLabel.style = "white-space:nowrap;";
    var fallbackInput = document.createElement('input');
    fallbackInput.type = 'text';
    fallbackInput.value = getDropSettings().fallbackChannel || '';
    fallbackInput.placeholder = 'https://www.twitch.tv/channel';
    fallbackInput.style = "flex:1; font-size:0.9rem; background:#444; color:#fff; border:1px solid #666; border-radius:4px; padding:0 4px;";
    fallbackRow.appendChild(fallbackLabel);
    fallbackRow.appendChild(fallbackInput);
    fallbackRow.appendChild(buttonAdder("Set", function() {
        var settings = getDropSettings();
        settings.fallbackChannel = fallbackInput.value.trim();
        GM_setValue('dropSettings', settings);
        popupText("Fallback channel saved.");
    }));
    outer.appendChild(itemsContainer);
    outer.appendChild(fallbackRow);
    outer.appendChild(btnRow);
    document.body.prepend(outer);
}

function findCampaignContainer(header) {
    var el = header;
    while (el && el !== document.body) {
        var sibling = el.nextElementSibling;
        if (sibling && sibling.querySelector('button[aria-expanded]')) return sibling;
        el = el.parentElement;
    }
    return null;
}

function injectDropButtons() {
    var observer = new MutationObserver(function() {
        var header = Array.from(document.querySelectorAll('h4')).find(el => el.textContent.trim() === "Open Drop Campaigns");
        if(!header) return;
        var campaignContainer = findCampaignContainer(header);
        if(!campaignContainer) return;
        observer.disconnect();
        renderDropButtons(campaignContainer);
        if(sessionStorage.getItem("AutoTwitchQueuerAutoFarmCampaigns") == "true" && window.location.pathname === "/drops/campaigns") {
            console.log("Autostarting Farm");
            autoFarmCampaigns();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

function renderDropButtons(campaignContainer) {
    Array.from(campaignContainer.children).forEach(function(row) {
        if(row.querySelector('.atq-drop-btn')) return;
        var nameEl = row.querySelector('p');
        if(!nameEl) return;
        var gameName = nameEl.textContent.trim();
        var btn = buttonAdder(getDropList().map(g => g.name).includes(gameName) ? "-" : "+", function(e) {
            e.stopPropagation();
            toggleDropGame(gameName);
            updateDropBtn(btn, gameName);
        });
        btn.classList.add('atq-drop-btn');
        btn.style.cssText += "position:absolute; left:0; top:50%; transform:translateY(-50%); z-index:9999;";
        row.style.position = 'relative';
        var innerBtn = row.querySelector('button');
        if(innerBtn) innerBtn.style.paddingLeft = '2.5rem';
        row.appendChild(btn);
    });
}

function updateDropBtn(btn, gameName) {
    btn.textContent = getDropList().map(g => g.name).includes(gameName) ? "-" : "+";
}

function getDropList() {
    return GM_getValue('dropGameList', []);
}

function getDropSettings() {
    return GM_getValue('dropSettings', { defaultMinutes: 30, paddingMinutes: 2, checkIntervalMinutes: 10, fallbackChannel: '' });
}

function toggleDropGame(gameName) {
    var list = getDropList();
    var idx = list.findIndex(g => g.name === gameName);
    if(idx === -1) {
        list.push({ name: gameName });
    } else {
        list.splice(idx, 1);
    }
    GM_setValue('dropGameList', list);
}

function autoFarmCampaignsToggle() {
    if(sessionStorage.getItem("AutoTwitchQueuerAutoFarmCampaigns") != "true") {
        sessionStorage.setItem("AutoTwitchQueuerAutoFarmCampaigns","true");
        autoFarmCampaigns();
    } else {
        popupText("Disabling Auto Farm Campaigns");
        sessionStorage.setItem("AutoTwitchQueuerAutoFarmCampaigns","false");
        clearInterval(inventoryCheckInterval);
        cancelQueue();
        window.location.assign("https://www.twitch.tv/drops/campaigns");
    }
}

function autoFarmCampaigns() {
    if(window.location.pathname !== "/drops/campaigns") {
        window.location.assign("https://www.twitch.tv/drops/campaigns");
        return;
    }
    var list = getDropList();
    if(list.length === 0) {
        var fallback = getDropSettings().fallbackChannel;
        if (fallback) {
            queueFallbackChannel(fallback);
        } else {
            popupText("No campaigns in priority list.");
        }
        return;
    }
    farmNextPriority(list, 0);
}

function farmNextPriority(list, idx) {
    if(idx >= list.length) {
        currentFarmingGame = null;
        currentFarmingCampaign = null;
        clearInterval(inventoryCheckInterval);
        var fallback = getDropSettings().fallbackChannel;
        if (fallback) {
            queueFallbackChannel(fallback);
        } else {
            popupText("All priority games completed.");
        }
        return;
    }
    var game = list[idx];
    currentFarmingGame = game.name;
    var header = Array.from(document.querySelectorAll('h4')).find(el => el.textContent.trim() === "Open Drop Campaigns");
    if(!header) {
        popupText("Could not find campaigns list.");
        return;
    }
    var campaignContainer = findCampaignContainer(header);
    if(!campaignContainer) {
        popupText("Could not find campaigns list.");
        return;
    }
    var rows = Array.from(campaignContainer.children);
    var targetRow = rows.find(function(row) {
        var nameEl = row.querySelector('p');
        return nameEl && nameEl.textContent.trim() === game.name;
    });
    if(!targetRow) {
        popupText("Campaign not found on page: " + game.name);
        farmNextPriority(list, idx + 1);
        return;
    }
    var accordionBtn = targetRow.querySelector('button');
    var isExpanded = accordionBtn && accordionBtn.getAttribute('aria-expanded') === 'true';
    if(!isExpanded && accordionBtn) {
        accordionBtn.click();
    }
    var detailObserver = new MutationObserver(function() {
        var detailLabel = targetRow.querySelector('.drop-details__label');
        if(!detailLabel) return;
        detailObserver.disconnect();
        parseAllCampaignsAndQueue(game, targetRow, list, idx);
    });
    detailObserver.observe(targetRow, { childList: true, subtree: true });
    if(isExpanded) {
        var detailLabel = targetRow.querySelector('.drop-details__label');
        if(detailLabel) {
            detailObserver.disconnect();
            parseAllCampaignsAndQueue(game, targetRow, list, idx);
        }
    }
}

function parseAllCampaignsAndQueue(game, row, list, idx) {
    var campaigns = parseCampaignsFromRow(row);
    console.log("Parsed " + campaigns.length + " campaigns for " + game.name);
    campaigns.forEach(function(c) {
        console.log("  Campaign: " + c.name + ", endDate: " + c.endDate);
    });
    if (campaigns.length === 0) {
        popupText("No campaigns found for: " + game.name + ", skipping.");
        farmNextPriority(list, idx + 1);
        return;
    }
    campaigns.forEach(function(campaign) {
        addCampaignToTracker(game.name, campaign.name, campaign.endDate);
    });
    var uncompleted = getUncompletedCampaigns(game.name);
    console.log("Uncompleted campaigns: " + uncompleted.length);
    if (uncompleted.length === 0) {
        popupText("All campaigns completed for: " + game.name + ", moving to next.");
        farmNextPriority(list, idx + 1);
        return;
    }
    findNextFarmableCampaign(game, row, list, idx, uncompleted);
}

function findNextFarmableCampaign(game, row, list, idx, uncompleted) {
    var farmableCampaign = null;
    console.log("Finding next farmable campaign for " + game.name + ", uncompleted: " + uncompleted.length);
    for (var i = 0; i < uncompleted.length; i++) {
        var campaign = uncompleted[i];
        var remainingMinutes = calculateTimeRemaining(campaign.endDate);
        console.log("Campaign: " + campaign.name + ", endDate: " + campaign.endDate + ", remaining: " + remainingMinutes);
        if (remainingMinutes > 0) {
            farmableCampaign = campaign;
            break;
        } else {
            console.log("Campaign appears expired, but double-checking...");
            if (remainingMinutes < -60) {
                markCampaignCompleted(game.name, campaign.name, true);
                console.log("Campaign expired: " + campaign.name);
            } else {
                farmableCampaign = campaign;
                console.log("Time remaining unclear, attempting to farm: " + campaign.name);
                break;
            }
        }
    }
    if (!farmableCampaign) {
        if (areAllCampaignsCompleted(game.name)) {
            popupText("All campaigns completed for: " + game.name + ", moving to next.");
            farmNextPriority(list, idx + 1);
            return;
        }
        var stillUncompleted = getUncompletedCampaigns(game.name);
        if (stillUncompleted.length > 0) {
            findNextFarmableCampaign(game, row, list, idx, stillUncompleted);
        }
        return;
    }
    currentFarmingCampaign = farmableCampaign;
    queueCampaignStream(game, row, farmableCampaign, list, idx);
}

function queueCampaignStream(game, row, campaign, list, idx) {
    var matchingStrong = Array.from(row.querySelectorAll('strong')).find(function(s) {
        return !s.closest('.drop-details__label') && s.textContent.trim() === campaign.name;
    });
    var targetBlock = null;
    if (matchingStrong) {
        var el = matchingStrong.parentElement;
        while (el && el !== row) {
            var hasEarnLabel = Array.from(el.querySelectorAll('.drop-details__label'))
                .some(function(lbl) { return lbl.textContent.includes('How to Earn'); });
            if (hasEarnLabel) { targetBlock = el; break; }
            el = el.parentElement;
        }
    }
    if (!targetBlock) {
        popupText("Could not find campaign block for: " + campaign.name);
        return;
    }
    var earnLabel = Array.from(targetBlock.querySelectorAll('.drop-details__label'))
    .find(el => el.textContent.includes("How to Earn the Drop"));
    if(!earnLabel) {
        popupText("Could not read drop details for: " + campaign.name);
        return;
    }
    var ul = earnLabel.parentElement.querySelector('ul');
    if(!ul) {
        popupText("Could not read drop details for: " + campaign.name);
        return;
    }
    var items = Array.from(ul.querySelectorAll('li'));
    var watchItems = items.filter(li => /watch for/i.test(li.textContent));
    if(watchItems.length === 0) {
        popupText("No watchable drops for: " + campaign.name + ", marking complete.");
        markCampaignCompleted(game.name, campaign.name, true);
        var uncompleted = getUncompletedCampaigns(game.name);
        if (uncompleted.length > 0) {
            findNextFarmableCampaign(game, row, list, idx, uncompleted);
        } else if (areAllCampaignsCompleted(game.name)) {
            farmNextPriority(list, idx + 1);
        }
        return;
    }
    var firstLi = items[0];
    var links = Array.from(firstLi.querySelectorAll('a'));
    var streamHref = links.length > 0 ? links[links.length - 1].getAttribute('href') : null;
    if(!streamHref) {
        popupText("No stream link found for: " + campaign.name);
        return;
    }
    var streamUrl = streamHref.startsWith('http') ? streamHref : "https://www.twitch.tv" + streamHref;
    var settings = getDropSettings();
    var padding = settings.paddingMinutes;
    var remainingMinutes = calculateTimeRemaining(campaign.endDate);
    var watchMinutes = Math.min(settings.defaultMinutes, remainingMinutes) + padding;
    if (watchMinutes > remainingMinutes) {
        watchMinutes = remainingMinutes;
    }
    if(streamUrl.includes("twitch.tv/directory/category") && !streamUrl.includes("?filter=drops&sort=VIEWER_COUNT")) {
        streamUrl = streamUrl.split("?")[0] + "?filter=drops&sort=VIEWER_COUNT";
    } else if(!streamUrl.includes("/directory/category") && !streamUrl.includes("/about") && !streamUrl.includes("?filter=drops&sort=VIEWER_COUNT")) {
        streamUrl += "/about";
    }
    var now = new Date();
    var returnTime = new Date(now.getTime() + watchMinutes * 60 * 1000);
    var nowString = now.toLocaleDateString("en-CA") + " " + now.toLocaleTimeString("en");
    var returnString = returnTime.toLocaleDateString("en-CA") + " " + returnTime.toLocaleTimeString("en");
    scheduleList = [streamUrl, nowString, "https://www.twitch.tv/drops/campaigns", returnString];
    sessionStorage.setItem("scheduleStorage", scheduleString());
    sessionStorage.setItem("farmingGameIdx", idx.toString());
    sessionStorage.setItem("farmingGameName", game.name);
    sessionStorage.setItem("farmingCampaignName", campaign.name);
    popupText("Queued: " + campaign.name + " for " + watchMinutes + " min");
    processSchedule();
}

function queueFallbackChannel(channelUrl) {
    var settings = getDropSettings();
    var watchMinutes = (settings.defaultMinutes || 30) + (settings.paddingMinutes || 2);
    if(channelUrl.includes("twitch.tv/directory/category") && !channelUrl.includes("?filter=drops&sort=VIEWER_COUNT")) {
        channelUrl = channelUrl.split("?")[0] + "?filter=drops&sort=VIEWER_COUNT";
    } else if(!channelUrl.includes("/directory/category") && !channelUrl.includes("/about") && !channelUrl.includes("?filter=drops&sort=VIEWER_COUNT")) {
        channelUrl += "/about";
    }
    var now = new Date();
    var returnTime = new Date(now.getTime() + watchMinutes * 60 * 1000);
    var nowString = now.toLocaleDateString("en-CA") + " " + now.toLocaleTimeString("en");
    var returnString = returnTime.toLocaleDateString("en-CA") + " " + returnTime.toLocaleTimeString("en");
    scheduleList = [channelUrl, nowString, "https://www.twitch.tv/drops/campaigns", returnString];
    sessionStorage.setItem("scheduleStorage", scheduleString());
    sessionStorage.removeItem("farmingGameName");
    sessionStorage.removeItem("farmingCampaignName");
    sessionStorage.removeItem("farmingGameIdx");
    popupText("No drops available. Going to fallback for " + watchMinutes + " min");
    processSchedule();
}

function startInventoryChecking() {
    clearInterval(inventoryCheckInterval);
    var settings = getDropSettings();
    var checkIntervalMs = (settings.checkIntervalMinutes || 10) * 60 * 1000;
    var gameName = sessionStorage.getItem("farmingGameName");
    var campaignName = sessionStorage.getItem("farmingCampaignName");
    if (!gameName || !campaignName) return;
    popupText("Starting inventory checks every " + (settings.checkIntervalMinutes || 10) + " min");
    getInventoryIframe();
    inventoryCheckInterval = setInterval(function() {
        var campaign = getDropsTracker()[gameName]?.find(c => c.name === campaignName);
        if (!campaign) {
            clearInterval(inventoryCheckInterval);
            return;
        }
        checkInventoryForCampaign(campaignName, campaign.endDate).then(function(exists) {
            if (!exists) {
                console.log("Campaign no longer in inventory: " + campaignName);
                markCampaignCompleted(gameName, campaignName, true);
                clearInterval(inventoryCheckInterval);
                popupText("Campaign completed: " + campaignName + ". Returning to campaigns.");
                window.location.assign("https://www.twitch.tv/drops/campaigns");
            } else {
                console.log("Campaign still active: " + campaignName);
            }
        });
    }, checkIntervalMs);
}

function editCampaignsPriority() {
    if(document.getElementById("TwitchPriorityOuterWrapper")) {
        document.getElementById("TwitchPriorityOuterWrapper").remove();
        return;
    }
    var list = getDropList();
    var settings = getDropSettings();
    var outer = document.createElement('div');
    outer.style = "position:fixed; height:40rem; width:40rem; left:12%; top:15%; transform:translate(-12%,-15%); z-index:99999; display:flex; flex-direction:column; background:#222; padding:1rem; box-sizing:border-box; border-radius:6px;";
    outer.id = 'TwitchPriorityOuterWrapper';
    var globalRow = document.createElement('div');
    globalRow.style = "display:flex; align-items:center; gap:0.5rem; margin-bottom:0.5rem; color:#fff; font-size:0.9rem; flex-wrap:wrap;";
    var defaultLabel = document.createElement('span');
    defaultLabel.textContent = 'Default min:';
    var defaultInput = document.createElement('input');
    defaultInput.type = 'number';
    defaultInput.value = settings.defaultMinutes;
    defaultInput.style = "width:4rem; font-size:0.9rem;";
    var paddingLabel = document.createElement('span');
    paddingLabel.textContent = 'Padding min:';
    var paddingInput = document.createElement('input');
    paddingInput.type = 'number';
    paddingInput.value = settings.paddingMinutes;
    paddingInput.style = "width:4rem; font-size:0.9rem;";
    var checkLabel = document.createElement('span');
    checkLabel.textContent = 'Check interval min:';
    var checkInput = document.createElement('input');
    checkInput.type = 'number';
    checkInput.value = settings.checkIntervalMinutes || 10;
    checkInput.style = "width:4rem; font-size:0.9rem;";
    globalRow.appendChild(defaultLabel);
    globalRow.appendChild(defaultInput);
    globalRow.appendChild(paddingLabel);
    globalRow.appendChild(paddingInput);
    globalRow.appendChild(checkLabel);
    globalRow.appendChild(checkInput);
    var itemsContainer = document.createElement('div');
    itemsContainer.style = "flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:0.5rem; margin-bottom:0.5rem;";
    itemsContainer.id = 'TwitchPriorityItems';
    function renderItems() {
        itemsContainer.innerHTML = '';
        list.forEach(function(game, idx) {
            var row = document.createElement('div');
            row.style = "display:flex; align-items:center; gap:0.5rem; background:#333; padding:0.25rem 0.5rem; border-radius:4px; color:#fff; font-size:1rem;";
            var upBtn = buttonAdder("▲", function() {
                if(idx === 0) return;
                var tmp = list[idx - 1];
                list[idx - 1] = list[idx];
                list[idx] = tmp;
                renderItems();
            });
            var downBtn = buttonAdder("▼", function() {
                if(idx === list.length - 1) return;
                var tmp = list[idx + 1];
                list[idx + 1] = list[idx];
                list[idx] = tmp;
                renderItems();
            });
            var label = document.createElement('span');
            label.textContent = game.name;
            label.style = "flex:1;";
            var deleteBtn = buttonAdder("✕", function() {
                list.splice(idx, 1);
                renderItems();
            });
            row.appendChild(upBtn);
            row.appendChild(downBtn);
            row.appendChild(label);
            row.appendChild(deleteBtn);
            itemsContainer.appendChild(row);
        });
    }
    renderItems();
    var btnRow = document.createElement('div');
    btnRow.style = "display:flex; gap:0.5rem;";
    btnRow.appendChild(buttonAdder("Save", function() {
        GM_setValue('dropGameList', list);
        GM_setValue('dropSettings', {
            defaultMinutes: parseInt(defaultInput.value) || 30,
            paddingMinutes: parseInt(paddingInput.value) || 2,
            checkIntervalMinutes: parseInt(checkInput.value) || 10,
            fallbackChannel: getDropSettings().fallbackChannel || ''
        });
        outer.remove();
    }));
    btnRow.appendChild(buttonAdder("Close", function() {
        outer.remove();
    }));
    outer.appendChild(globalRow);
    outer.appendChild(itemsContainer);
    outer.appendChild(btnRow);
    document.body.prepend(outer);
}

function grabSchedule(string) {
    if(document.getElementById("TwitchScheduleOuterWrapper")) {
        document.getElementById("TwitchScheduleOuterWrapper").remove();
        return;
    }
    var outer = document.createElement('div');
    outer.style = "position:fixed; height:40rem; width:100rem; left:12%; top:15%; transform:translate(-12%,-15%); z-index:99999; display:inline-block;";
    outer.id = 'TwitchScheduleOuterWrapper';
    var box = document.createElement('textarea');
    box.type = 'text';
    box.value = scheduleList.join("\n");
    box.style = "height:40rem; width:100rem; display:block; resize:both; box-sizing: border-box; padding: 2em";
    box.id = 'TwitchScheduleGrabber';
    outer.appendChild(buttonAdder("Parse Link", parseLink));
    outer.appendChild(buttonAdder("Return to Previous", returnToPrevious));
    outer.appendChild(buttonAdder("Add Current Page", addCurrentPage));
    outer.appendChild(buttonAdder("Add Entry", addEntry));
    outer.appendChild(buttonAdder("Remove Entry", removeEntry));
    outer.appendChild(buttonAdder("Toggle AM/PM", toggleAMPM));
    outer.appendChild(buttonAdder("+1 Hour", () => timeAdder(1,0,0)));
    outer.appendChild(buttonAdder("+30 Minutes", () => timeAdder(0,30,0)));
    outer.appendChild(buttonAdder("-1 Hour", () => timeAdder(-1,0,0)));
    outer.appendChild(buttonAdder("-30 Minutes", () => timeAdder(0,-30,0)));
    outer.appendChild(buttonAdder("Run Queue", readSchedule));
    outer.appendChild(buttonAdder("Next Queued", nextinQueue));
    outer.appendChild(buttonAdder("Close", grabSchedule));
    outer.appendChild(box);
    document.body.prepend(outer);
    if(scheduleList.length < 2) {
        addEntry();
    }
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

function parseLink() {
    scheduleList = document.getElementById('TwitchScheduleGrabber').value.split("\n");
    if(scheduleList.length < 2) return null;
    var nearestLink = scheduleList.at(-2);
    if(nearestLink.includes("twitch.tv/directory/category") && !nearestLink.includes("?filter=drops&sort=VIEWER_COUNT")) {
        nearestLink = nearestLink.split("?")[0] + "?filter=drops&sort=VIEWER_COUNT";
    } else if(nearestLink.includes("twitch.tv/") && !nearestLink.includes("/about") && !nearestLink.includes("?filter=drops&sort=VIEWER_COUNT")) {
        nearestLink += "/about";
    }
    scheduleList.splice(-2,1,nearestLink);
    document.getElementById('TwitchScheduleGrabber').value = scheduleList.join("\n");
}

function duplicateLine() {
    scheduleList = document.getElementById('TwitchScheduleGrabber').value.split("\n");
    if(scheduleList.length < 2) return null;
    scheduleList.push(...scheduleList.slice(-2));
    document.getElementById('TwitchScheduleGrabber').value = scheduleList.join("\n");
}

function returnToPrevious() {
    scheduleList = document.getElementById('TwitchScheduleGrabber').value.split("\n");
    if(scheduleList.length < 4) return null;
    var previousTime = document.getElementById('TwitchScheduleGrabber').value.split("\n").at(-1).split(" ");
    previousTime = " " + previousTime.at(-2) + " " + previousTime.at(-1);
    var defaultLink = window.location.href;
    defaultLink = document.getElementById('TwitchScheduleGrabber').value.split("\n").at(-4);
    scheduleList.push(...[defaultLink,currentDateString + previousTime]);
    document.getElementById('TwitchScheduleGrabber').value = scheduleList.join("\n");
}

function addCurrentPage() {
    scheduleList = document.getElementById('TwitchScheduleGrabber').value.split("\n");
    var previousTime = document.getElementById('TwitchScheduleGrabber').value.split("\n").at(-1).split(" ");
    var defaultLink = window.location.href;
    if(scheduleList.length < 2) {
        previousTime = currentTimeString("roundup");
        scheduleList = [defaultLink,currentDateString + previousTime];
    } else {
        previousTime = " " + previousTime.at(-2) + " " + previousTime.at(-1);
        scheduleList.push(...[defaultLink,currentDateString + previousTime]);
    }
    document.getElementById('TwitchScheduleGrabber').value = scheduleList.join("\n");
}

function addEntry() {
    scheduleList = document.getElementById('TwitchScheduleGrabber').value.split("\n");
    var previousTime = document.getElementById('TwitchScheduleGrabber').value.split("\n").at(-1).split(" ");
    if(previousTime.length < 2) {
        previousTime = currentTimeString("roundup");
    } else {
        previousTime = " " + previousTime.at(-2) + " " + previousTime.at(-1);
    }
    var defaultLink = window.location.href;
    navigator.clipboard.readText().then(text => {
        if(isValidHttpUrl(text) && !text.includes('\n')) {
            defaultLink = text;
        }
        if(scheduleList.length < 2) {
            scheduleList = [defaultLink,currentDateString + previousTime];
        } else {
            scheduleList.push(...[defaultLink,currentDateString + previousTime]);
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
    scheduleList = document.getElementById('TwitchScheduleGrabber').value.split("\n");
    if(scheduleList.length < 2) return null;
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
    scheduleList = document.getElementById('TwitchScheduleGrabber').value.split("\n");
    if(scheduleList.length % 2 != 0) {
        popupText("Odd Queue Count? Possible Malformed Queue");
        return;
    }
    clearTimeout(scheduleTimeout);
    document.getElementById("TwitchScheduleOuterWrapper").remove();
    sessionStorage.setItem("scheduleStorage",scheduleString());
    processSchedule();
}

function nextinQueue() {
    scheduleList = sessionStorage.getItem('scheduleStorage').split(",");
    if(scheduleList.length > 0) {
        gotoNextWebsite();
    }
}

function scheduleString() {
    return scheduleList.join(joiner);
}

function processSchedule() {
    scheduleList = sessionStorage.getItem('scheduleStorage').split(",");
    var dateParser = new Date(scheduleList[1]).getTime();
    var timeDiff = dateParser - Date.now();
    if(timeDiff > 0) {
        var hours = timeDiff / 1000 / 60 / 60;
        hours = Math.round(hours * 100) / 100;
        popupText("Next in Queue: " + scheduleList[0] + " in ~" + hours + " hours");
        scheduleTimeout = setTimeout(processSchedule, timeDiff + 100);
    } else {
        gotoNextWebsite();
    }
}

function gotoNextWebsite() {
    clearTimeout(scheduleTimeout);
    var nextWebsite = scheduleList[0];
    scheduleList.splice(0,2);
    sessionStorage.setItem("scheduleStorage",scheduleString());
    window.location.assign(nextWebsite);
}

function cancelQueue() {
    clearTimeout(scheduleTimeout);
    clearInterval(inventoryCheckInterval);
    document.getElementById("TwitchScheduleOuterWrapper")?.remove();
    sessionStorage.removeItem("scheduleStorage");
    sessionStorage.removeItem("farmingGameName");
    sessionStorage.removeItem("farmingCampaignName");
    sessionStorage.removeItem("farmingGameIdx");
    scheduleList = [];
    currentFarmingGame = null;
    currentFarmingCampaign = null;
    popupText("Queue Canceled");
}

function currentTimeString(opts) {
    var newCurrentTime = new Date();
    var newCurrentTimeString = "";
    if(opts.includes('rounddown')) {
        newCurrentTimeString = " " + newCurrentTime.toLocaleTimeString("en").split(" ")[0].split(":")[0] + ":00:00 " + newCurrentTime.toLocaleTimeString("en").split(" ").at(-1);
    } else if(opts.includes('roundup')) {
        newCurrentTime.setHours(newCurrentTime.getHours() + 1);
        newCurrentTimeString = " " + newCurrentTime.toLocaleTimeString("en").split(" ")[0].split(":")[0] + ":00:00 " + newCurrentTime.toLocaleTimeString("en").split(" ").at(-1);
    } else if(opts.includes('round')) {
        if(newCurrentTime.getMinutes() >= 30) {
            newCurrentTime.setHours(newCurrentTime.getHours() + 1);
        }
        newCurrentTimeString = " " + newCurrentTime.toLocaleTimeString("en").split(" ")[0].split(":")[0] + ":00:00 " + newCurrentTime.toLocaleTimeString("en").split(" ").at(-1);
    } else {
        newCurrentTimeString = " " + newCurrentTime.toLocaleTimeString("en");
    }
    currentDate = newCurrentTime;
    currentDateString = currentDate.toLocaleDateString("en-CA");
    return newCurrentTimeString;
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

function popupText(string) {
    removeConfirmPopup();
    var box = document.createElement("div");
    box.id = "userscriptPopupWindow";
    box.textContent = string;
    box.style.cssText = "position:fixed; top:16px; left:16px; z-index:999991; max-width:300px; padding:10px 14px; background-color:#333; color:#fff; border-radius:6px; font-size:13px; line-height:1.5; word-wrap:break-word; white-space:normal; cursor:pointer; transform:translateX(calc(-100% - 16px)); transition:transform 0.35s ease; box-sizing:border-box;";
    document.body.appendChild(box);
    console.log(string);
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            box.style.transform = "translateX(0)";
        });
    });
    function slideOut() {
        box.style.transform = "translateX(calc(-100% - 16px))";
        box.addEventListener("transitionend", function () {
            if (box.parentNode) box.parentNode.removeChild(box);
        }, { once: true });
    }
    var autoRemove = setTimeout(slideOut, 4000);
    box.addEventListener("click", function () {
        clearTimeout(autoRemove);
        slideOut();
    }, { once: true });
}

function removeConfirmPopup() {
    var existing = document.getElementById("userscriptPopupWindow");
    if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing)
    }
}
