// ==UserScript==
// @name         Auto Twitch Queuer
// @namespace    https://github.com/
// @version      2.1.2
// @description  Queue a list of streams to open at specific times with automatic campaign farming. Also watch streams automatically.
// @author       Main
// @match        https://www.youtube.com/*/streams
// @match        *://www.twitch.tv/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_info
// @require      http://code.jquery.com/jquery-3.4.1.min.js
// @noframes
// ==/UserScript==
// Documenting globals for JSHint to not throw an error for JQuery's $ function
/* globals $ */

var debug = false;

GM_registerMenuCommand("Open Schedule", grabSchedule);
GM_registerMenuCommand("Next In Queue", nextinQueue);
GM_registerMenuCommand("Cancel Schedule", cancelQueue);
GM_registerMenuCommand("Auto Farm Campaigns", autoFarmCampaignsToggle);
GM_registerMenuCommand("Campaign Manager", openCampaignManager);
if (debug) {
    GM_registerMenuCommand("Debug: Run Inventory Check", runInventoryCheck);
    GM_registerMenuCommand("Debug: Run Offline Check", runOfflineCheck);
    GM_registerMenuCommand("Debug: Run Priority Check", runPriorityCheck);
    GM_registerMenuCommand("Debug: Cull Iframes", debugCullIframes);
}

window.addEventListener('pagehide', function() {
    stopInventoryChecking();
    killIframes();
});

var currentDate = new Date();
var currentDateString = currentDate.toLocaleDateString("en-CA");
var scheduleList = [];
var joiner = ",";
var scheduleTimeout;
var inventoryCheckInterval;
var offlineCheckInterval;
var inventoryIframe = null;
var campaignsIframe = null;
var iframeKillTimeout = null;
var iframeCheckGen = 0;
var streamViewerCountSeen = false;

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

function createHiddenIframe(src) {
    var f = document.createElement('iframe');
    f.style.display = 'none';
    f.src = src;
    document.body.appendChild(f);
    return f;
}

function teardownIframe(frame) {
    frame.onload = null;
    frame.onerror = null;
    try {
        if (frame.contentWindow) {
            frame.contentWindow.location.replace('about:blank');
        }
    } catch (e) {}
    try {
        frame.src = 'about:blank';
    } catch (e) {}
    if (frame.parentNode) {
        frame.parentNode.removeChild(frame);
    }
}

function killIframes() {
    clearTimeout(iframeKillTimeout);
    iframeKillTimeout = null;
    iframeCheckGen++;
    var killed = [];
    if (inventoryIframe) {
        teardownIframe(inventoryIframe);
        inventoryIframe = null;
        killed.push("inventory");
    }
    if (campaignsIframe) {
        teardownIframe(campaignsIframe);
        campaignsIframe = null;
        killed.push("campaigns");
    }
    if (killed.length > 0) popupText("Debug: Killed iframes: " + killed.join(", "));
    else popupText("Debug: killIframes called but nothing to remove");
}

function scheduleIframeKill() {
    clearTimeout(iframeKillTimeout);
    var minutes = getDropSettings().fallbackMinutes || 30;
    iframeKillTimeout = setTimeout(killIframes, minutes * 60000);
    popupText("Debug: Iframe kill scheduled in " + minutes + " min");
}

function getInventoryIframe() {
    if (!inventoryIframe || !inventoryIframe.parentNode) {
        inventoryIframe = createHiddenIframe('https://www.twitch.tv/drops/inventory');
        popupText("Debug: Created inventoryIframe");
    } else {
        popupText("Debug: Reusing inventoryIframe");
    }
    scheduleIframeKill();
    return inventoryIframe;
}

function getCampaignsIframe() {
    if (!campaignsIframe || !campaignsIframe.parentNode) {
        campaignsIframe = createHiddenIframe('https://www.twitch.tv/drops/campaigns');
        popupText("Debug: Created campaignsIframe");
    } else {
        popupText("Debug: Reusing campaignsIframe");
    }
    scheduleIframeKill();
    return campaignsIframe;
}

function expandRowsSequentially(rowsToExpand, onDone) {
    if (rowsToExpand.length === 0) { onDone(); return; }
    var r = rowsToExpand[0];
    var rest = rowsToExpand.slice(1);
    if (r.querySelector('.drop-details__label')) {
        expandRowsSequentially(rest, onDone);
        return;
    }
    try { r.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch(e) {}
    setTimeout(function() {
        var accordionBtn = r.querySelector('button[aria-expanded]');
        var parseTimer = null;
        var detailObserver = new MutationObserver(function() {
            if (!r.querySelector('.drop-details__label')) return;
            clearTimeout(parseTimer);
            clearTimeout(detailObserverTimeout);
            parseTimer = setTimeout(function() {
                detailObserver.disconnect();
                expandRowsSequentially(rest, onDone);
            }, 500);
        });
        detailObserver.observe(r, { childList: true, subtree: true });
        var detailObserverTimeout = setTimeout(function() {
            clearTimeout(parseTimer);
            detailObserver.disconnect();
            expandRowsSequentially(rest, onDone);
        }, 10000);
        if (accordionBtn && accordionBtn.getAttribute('aria-expanded') !== 'true') {
            accordionBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
    }, 500);
}

function checkForHigherPriorityCampaign() {
    return new Promise(function(resolve) {
        var farmingIdx = parseInt(sessionStorage.getItem("farmingGameIdx") || "-1");
        popupText("Debug: Priority check - farmingIdx=" + farmingIdx);
        if (farmingIdx <= 0) { popupText("Debug: farmingIdx<=0, skipping priority check"); resolve(false); return; }
        var list = getDropList();
        var higherPriorityGames = list.slice(0, farmingIdx);
        var stalledGames = JSON.parse(sessionStorage.getItem("farmingStallGameNames") || "[]");
        var higherPriorityNames = higherPriorityGames.map(function(g) { return g.name; });
        popupText("Debug: Higher priority names: [" + higherPriorityNames.join(", ") + "] (stalled: [" + stalledGames.filter(function(g) { return higherPriorityNames.includes(g); }).join(", ") + "])");
        var myGen = iframeCheckGen;
        function aborted() { return myGen !== iframeCheckGen; }
        var iframe = getCampaignsIframe();
        function done(result) { killIframes(); resolve(result); }
        function doCheck() {
            if (aborted()) { return; }
            try {
                var doc = iframe.contentDocument || iframe.contentWindow.document;
                if (!doc || !doc.body) { resolve(false); return; }
                var tracker = getDropsTracker();
                var triggeringGame = null;

                var dropSearchRoot = doc;
                var openHeader = Array.from(doc.querySelectorAll('h4')).find(function(el) {
                    return el.textContent.trim() === "Open Drop Campaigns";
                });
                if (openHeader) {
                    var el = openHeader;
                    while (el && el !== doc.body) {
                        var sib = el.nextElementSibling;
                        if (sib && sib.querySelector('button[aria-expanded]')) { dropSearchRoot = sib; break; }
                        el = el.parentElement;
                    }
                }
                popupText("Debug: Priority check scope=" + (dropSearchRoot === doc ? "full page" : "open drop campaigns only"));

                var allVisibleGames = Array.from(dropSearchRoot.children).map(function(row) {
                    var pEl = row.querySelector('p');
                    return pEl ? pEl.textContent.trim() : null;
                }).filter(Boolean);
                var rewardPriorityNames = [];
                var rewardDebugHeader = Array.from(doc.querySelectorAll('h4')).find(function(el) { return el.textContent.trim() === "Open Reward Campaigns"; });
                if (rewardDebugHeader) {
                    var rdEl = rewardDebugHeader;
                    while (rdEl && rdEl !== doc.body) {
                        var rdSib = rdEl.nextElementSibling;
                        while (rdSib) {
                            if (rdSib.querySelector('button[aria-expanded]')) {
                                Array.from(rdSib.querySelectorAll('img.partner-thumbnail')).forEach(function(img) {
                                    if (img.alt) {
                                        allVisibleGames.push(img.alt + " (reward)");
                                        if (higherPriorityNames.includes(img.alt)) rewardPriorityNames.push(img.alt + " (reward)");
                                    }
                                });
                                break;
                            }
                            rdSib = rdSib.nextElementSibling;
                        }
                        if (rdSib && rdSib.querySelector('button[aria-expanded]')) break;
                        rdEl = rdEl.parentElement;
                    }
                }
                popupText("Debug: Games visible in iframe (" + allVisibleGames.length + "): [" + allVisibleGames.join(", ") + "]");

                var allPriorityDropRows = Array.from(dropSearchRoot.children).filter(function(row) {
                    var pEl = row.querySelector('p');
                    return pEl && higherPriorityNames.includes(pEl.textContent.trim());
                });
                var allPriorityLabels = allPriorityDropRows.filter(function(r) { return !r.querySelector('.drop-details__label'); }).map(function(r) { var p = r.querySelector('p'); return p ? p.textContent.trim() : '?'; }).concat(rewardPriorityNames);
                popupText("Debug: Priority rows needing expansion (" + allPriorityLabels.length + "): [" + allPriorityLabels.join(", ") + "]");

                function checkDropRowsSequentially(rows, rowIdx, onDone) {
                    if (aborted()) { return; }
                    if (rowIdx >= rows.length) { onDone(false); return; }
                    var row = rows[rowIdx];
                    var pEl = row.querySelector('p');
                    var gameName = pEl ? pEl.textContent.trim() : null;
                    if (!gameName) { checkDropRowsSequentially(rows, rowIdx + 1, onDone); return; }
                    function afterExpand() {
                        if (aborted()) { return; }
                        var trackedCampaigns = tracker[gameName];
                        var isStalled = stalledGames.includes(gameName);
                        var pageCampaigns = parseCampaignsFromRow(row);
                        if (isStalled) {
                            var hasNew = pageCampaigns.some(function(c) {
                                return !trackedCampaigns || !trackedCampaigns.find(function(t) { return t.name === c.name; });
                            });
                            var stalledSummary = pageCampaigns.length > 0
                                ? pageCampaigns.map(function(c) {
                                    var t = trackedCampaigns && trackedCampaigns.find(function(t) { return t.name === c.name; });
                                    return c.name + (t ? (t.completed ? " [done]" : " [stalled]") : " [NEW]");
                                }).join(", ")
                                : "no campaigns read";
                            popupText("Debug: Checking stalled " + gameName + " - " + stalledSummary);
                            if (hasNew) { triggeringGame = gameName; onDone(true); return; }
                        } else {
                            var allCompleted = trackedCampaigns && trackedCampaigns.length > 0 && trackedCampaigns.every(function(c) { return c.completed; });
                            var pageSummary = pageCampaigns.length > 0
                                ? pageCampaigns.map(function(c) {
                                    var t = trackedCampaigns && trackedCampaigns.find(function(t) { return t.name === c.name; });
                                    return c.name + (t ? (t.completed ? " [done]" : " [pending]") : " [untracked]");
                                }).join(", ")
                                : "not expanded";
                            popupText("Debug: Checking " + gameName + " - " + pageSummary);
                            if (!allCompleted) { triggeringGame = gameName; onDone(true); return; }
                        }
                        checkDropRowsSequentially(rows, rowIdx + 1, onDone);
                    }
                    if (row.querySelector('.drop-details__label')) { afterExpand(); return; }
                    try { row.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch(e) {}
                    setTimeout(function() {
                        var accordionBtn = row.querySelector('button[aria-expanded]');
                        var parseTimer = null;
                        var detailObserver = new MutationObserver(function() {
                            if (!row.querySelector('.drop-details__label')) return;
                            clearTimeout(parseTimer);
                            clearTimeout(detailObserverTimeout);
                            parseTimer = setTimeout(function() {
                                detailObserver.disconnect();
                                afterExpand();
                            }, 500);
                        });
                        detailObserver.observe(row, { childList: true, subtree: true });
                        var detailObserverTimeout = setTimeout(function() {
                            clearTimeout(parseTimer);
                            detailObserver.disconnect();
                            afterExpand();
                        }, 10000);
                        if (accordionBtn && accordionBtn.getAttribute('aria-expanded') !== 'true') {
                            accordionBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                        }
                    }, 500);
                }

                var allPriorityRewardRows = [];
                var rewardContainerForCheck = null;
                var rewardHeaderForCheck = Array.from(doc.querySelectorAll('h4')).find(function(el) {
                    return el.textContent.trim() === "Open Reward Campaigns";
                });
                if (rewardHeaderForCheck) {
                    var rfcEl = rewardHeaderForCheck;
                    while (rfcEl && rfcEl !== doc.body) {
                        var rfcSib = rfcEl.nextElementSibling;
                        while (rfcSib) {
                            if (rfcSib.querySelector('button[aria-expanded]')) { rewardContainerForCheck = rfcSib; break; }
                            rfcSib = rfcSib.nextElementSibling;
                        }
                        if (rewardContainerForCheck) break;
                        rfcEl = rfcEl.parentElement;
                    }
                    if (rewardContainerForCheck) {
                        var seenRew = [];
                        allPriorityRewardRows = Array.from(rewardContainerForCheck.querySelectorAll('.accordion-header')).map(function(h) {
                            return h.parentElement;
                        }).filter(function(row) {
                            if (seenRew.indexOf(row) !== -1) return false;
                            seenRew.push(row);
                            var imgEl = row.querySelector('img.partner-thumbnail');
                            return imgEl && imgEl.alt && higherPriorityNames.includes(imgEl.alt);
                        });
                    }
                }

                function checkRewardRowsSequentially(rows, rowIdx, onDone) {
                    if (aborted()) { return; }
                    if (rowIdx >= rows.length) { onDone(false); return; }
                    var row = rows[rowIdx];
                    var imgEl = row.querySelector('img.partner-thumbnail');
                    if (!imgEl || !imgEl.alt) { checkRewardRowsSequentially(rows, rowIdx + 1, onDone); return; }
                    var gameName = imgEl.alt;
                    function afterExpand() {
                        if (aborted()) { return; }
                        var trackedCampaigns = tracker[gameName];
                        // Same parser as the farming side, so the campaign identity matches
                        // what gets registered in the tracker (one campaign per accordion,
                        // named after its first reward)
                        var pageCampaigns = [parseRewardCampaignFromRow({ name: gameName }, row)];
                        // Fallback contract: while farming a lower priority stream because this game stalled,
                        // only return to it for a campaign we have never tracked (a genuinely new one),
                        // never for the stalled campaigns we fell back from; otherwise the fallback
                        // stream runs until its Fallback Duration time limit expires.
                        var isStalled = stalledGames.includes(gameName);
                        if (isStalled) {
                            var hasNew = pageCampaigns.some(function(c) {
                                return !trackedCampaigns || !trackedCampaigns.find(function(t) { return t.name === c.name; });
                            });
                            var stalledSummary = pageCampaigns.map(function(c) {
                                var t = trackedCampaigns && trackedCampaigns.find(function(t) { return t.name === c.name; });
                                return c.name + (t ? (t.completed ? " [done]" : " [stalled]") : " [NEW]");
                            }).join(", ");
                            popupText("Debug: Checking stalled reward " + gameName + " - " + stalledSummary);
                            if (hasNew) { triggeringGame = gameName; onDone(true); return; }
                        } else {
                            var allCompleted = trackedCampaigns && trackedCampaigns.length > 0 && pageCampaigns.every(function(c) {
                                var t = trackedCampaigns.find(function(t) { return t.name === c.name; });
                                return t && t.completed;
                            });
                            var pageSummary = pageCampaigns.map(function(c) {
                                var t = trackedCampaigns && trackedCampaigns.find(function(t) { return t.name === c.name; });
                                return c.name + (t ? (t.completed ? " [done]" : " [pending]") : " [untracked]");
                            }).join(", ");
                            popupText("Debug: Checking reward " + gameName + " - " + pageSummary);
                            if (!allCompleted) { triggeringGame = gameName; onDone(true); return; }
                        }
                        checkRewardRowsSequentially(rows, rowIdx + 1, onDone);
                    }
                    if (row.querySelector('.drop-details__label')) { afterExpand(); return; }
                    try { row.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch(e) {}
                    setTimeout(function() {
                        var accordionBtn = row.querySelector('button[aria-expanded]');
                        var parseTimer = null;
                        var detailObserver = new MutationObserver(function() {
                            if (!row.querySelector('.drop-details__label')) return;
                            clearTimeout(parseTimer);
                            clearTimeout(detailObserverTimeout);
                            parseTimer = setTimeout(function() {
                                detailObserver.disconnect();
                                afterExpand();
                            }, 500);
                        });
                        detailObserver.observe(row, { childList: true, subtree: true });
                        var detailObserverTimeout = setTimeout(function() {
                            clearTimeout(parseTimer);
                            detailObserver.disconnect();
                            afterExpand();
                        }, 10000);
                        if (accordionBtn && accordionBtn.getAttribute('aria-expanded') !== 'true') {
                            accordionBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                        }
                    }, 500);
                }

                checkDropRowsSequentially(allPriorityDropRows, 0, function(dropFound) {
                    if (dropFound) {
                        popupText("Debug: Priority check result=true" + (triggeringGame ? " triggered by: " + triggeringGame : ""));
                        done(true);
                        return;
                    }
                    checkRewardRowsSequentially(allPriorityRewardRows, 0, function(rewardFound) {
                        popupText("Debug: Priority check result=" + rewardFound + (triggeringGame ? " triggered by: " + triggeringGame : ""));
                        done(rewardFound);
                    });
                });
            } catch(e) {
                done(false);
            }
        }
        var timeout = setTimeout(function() {
            done(false);
        }, 20000);
        iframe.onload = function() {
            clearTimeout(timeout);
            setTimeout(doCheck, 3000);
        };
        iframe.src = 'https://www.twitch.tv/drops/campaigns';
    });
}

function checkInventoryForCampaign(campaignName, endDate) {
    return new Promise(function(resolve) {
        var myGen = iframeCheckGen;
        function aborted() { return myGen !== iframeCheckGen; }
        var iframe = getInventoryIframe();
        function done(result) { killIframes(); resolve(result); }
        function doCheck() {
            if (aborted()) { return; }
            try {
                var doc = iframe.contentDocument || iframe.contentWindow.document;
                if (!doc || !doc.body) {
                    done({ exists: true, progress: null });
                    return;
                }
                var inventoryItems = doc.querySelectorAll('.inventory-campaign-info');
                if (inventoryItems.length === 0) {
                    // No in-progress campaigns can mean two things: the page hasn't loaded yet,
                    // or the last campaign just completed and the In Progress section is gone.
                    // If the page shell and the Claimed section's drops are rendered, the
                    // inventory genuinely loaded empty, so the campaign no longer exists.
                    var pageLoaded = doc.querySelector('.inventory-page') && doc.querySelector('.inventory-drop-image');
                    done({ exists: !pageLoaded, progress: null, found: false });
                    return;
                }
                var found = false;
                inventoryItems.forEach(function(item) {
                    var nameLink = item.querySelector('a.tw-link');
                    if (nameLink && nameLink.textContent.trim() === campaignName) {
                        found = true;
                    }
                });
                var fills = doc.querySelectorAll('[data-a-target="tw-progress-bar-animation"]');
                var progressValues = [];
                fills.forEach(function(fill) {
                    var bar = fill.parentElement;
                    var val = bar ? bar.getAttribute('aria-valuenow') : null;
                    if (val !== null) progressValues.push(val);
                });
                var progress = progressValues.length > 0 ? progressValues.join(",") : null;
                popupText("Current Progress: " + progress);
                done({ exists: found, progress: progress, found: found });
            } catch(e) {
                done({ exists: true, progress: null });
            }
        }
        var timeout = setTimeout(function() {
            done({ exists: true, progress: null });
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

function parseCampaignsFromRow(rowOrRows) {
    var rowList = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
    var campaigns = [];
    rowList.forEach(function(row) {
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
    });
    return campaigns;
}

function parseRewardCampaignFromRow(game, row) {
    // Reward campaign accordions have no per-drop <strong> names or dates like drop campaign
    // rows do, so the whole accordion becomes one campaign named after its first reward,
    // matching how it registers in the inventory page
    var dateEl = row.querySelector('[class*="caYeGJ"]');
    var endDateRaw = dateEl ? dateEl.textContent.trim() : null;
    var endDate = endDateRaw ? parseEndDateFromRange(endDateRaw) : null;
    var rewardNames = [];
    row.querySelectorAll('.drop-benefit__image-container img').forEach(function(img) {
        if (img.alt) rewardNames.push(img.alt);
    });
    if (rewardNames.length === 0) {
        var rewardsLabel = Array.from(row.querySelectorAll('.drop-details__label')).find(function(l) {
            return l.textContent.trim() === 'Rewards';
        });
        if (rewardsLabel) {
            rewardsLabel.parentElement.querySelectorAll('p').forEach(function(p) {
                var t = p.textContent.trim();
                if (t) rewardNames.push(t);
            });
        }
    }
    var name = rewardNames.length > 0 ? rewardNames[0] : (game.name + " Reward");
    return { name: name, endDate: endDate, endDateRaw: endDateRaw, rewardRow: row };
}

function parseEndDateToMs(endDateString) {
    if (!endDateString) return Infinity;
    var parts = endDateString.match(/(\w+),\s+(\w+)\s+(\d+),\s+(\d+):(\d+)\s+(AM|PM)/i);
    if (!parts) return Infinity;
    var months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
    var month = months[parts[2].substr(0,3)];
    var day = parseInt(parts[3]);
    var hour = parseInt(parts[4]);
    var minute = parseInt(parts[5]);
    var ampm = parts[6].toUpperCase();
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    var now = Date.now();
    var currentYear = new Date().getFullYear();
    var d = new Date(currentYear, month, day, hour, minute, 0);
    if (d.getTime() < now - (180 * 24 * 60 * 60 * 1000)) {
        d = new Date(currentYear + 1, month, day, hour, minute, 0);
    }
    return d.getTime();
}

function calculateTimeRemaining(endDateString) {
    if (!endDateString) return 0;
    var ms = parseEndDateToMs(endDateString);
    if (ms === Infinity) return 1440;
    return Math.floor((ms - Date.now()) / 60000);
}

function openCampaignManager() {
    if(document.getElementById("CampaignManagerWrapper")) {
        document.getElementById("CampaignManagerWrapper").remove();
        return;
    }

    if (!document.getElementById('atq-cm-style')) {
        var style = document.createElement('style');
        style.id = 'atq-cm-style';
        style.textContent = `
            #CampaignManagerWrapper, #CampaignManagerWrapper * { box-sizing: border-box; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
            #CampaignManagerWrapper { position:fixed; width:60rem; max-height:calc(100vh - 3rem); left:50%; top:50%; transform:translate(-50%,-50%); z-index:99999; display:flex; flex-direction:column; background:#18181b; padding:16px; border-radius:10px; box-shadow:0 12px 48px rgba(0,0,0,0.8); color:#efeff1; }
            .atq-titlebar { display:flex; align-items:center; margin-bottom:12px; }
            .atq-title { font-size:1.05rem; font-weight:700; color:#efeff1; letter-spacing:0.04em; text-transform:uppercase; flex:1; }
            .atq-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
            .atq-label { font-size:0.88rem; font-weight:500; color:#adadb8; white-space:nowrap; }
            .atq-input { background:#18181b; border:1px solid #3a3a4a; border-radius:4px; color:#efeff1; font-size:0.92rem; padding:4px 7px; outline:none; transition:border-color 0.15s; }
            .atq-input:focus { border-color:#9147ff; }
            .atq-input-num { width:5.5rem; text-align:center; }
            .atq-input-url { flex:1; min-width:0; }
            .atq-tabs { display:flex; border-bottom:1px solid #2a2a35; margin-bottom:8px; gap:2px; }
            .atq-tab { padding:6px 16px; cursor:pointer; font-size:0.88rem; font-weight:700; color:#adadb8; border:none; background:none; border-bottom:2px solid transparent; margin-bottom:-1px; transition:color 0.15s, border-color 0.15s; letter-spacing:0.06em; text-transform:uppercase; }
            .atq-tab:hover { color:#efeff1; }
            .atq-tab.atq-active { color:#9147ff; border-bottom-color:#9147ff; }
            .atq-content { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:3px; margin-bottom:8px; }
            .atq-content::-webkit-scrollbar { width:4px; }
            .atq-content::-webkit-scrollbar-track { background:transparent; }
            .atq-content::-webkit-scrollbar-thumb { background:#3a3a4a; border-radius:2px; }
            .atq-empty { color:#adadb8; font-size:0.92rem; text-align:center; padding:2rem 1rem; }
            .atq-item { display:flex; align-items:center; gap:6px; background:#0e0e10; padding:7px 10px; border-radius:6px; border:1px solid transparent; transition:border-color 0.1s; }
            .atq-item:hover { border-color:#2a2a35; }
            .atq-game-header { font-size:0.78rem; font-weight:700; color:#9147ff; text-transform:uppercase; letter-spacing:0.1em; padding:10px 4px 3px; }
            .atq-item-label { flex:1; font-size:0.92rem; color:#efeff1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .atq-item-label.done { color:#5a5a6e; text-decoration:line-through; }
            .atq-btn { cursor:pointer; border:none; border-radius:4px; font-size:0.88rem; font-weight:700; padding:5px 12px; transition:background 0.12s, color 0.12s; white-space:nowrap; letter-spacing:0.03em; background:#2a2a35; color:#adadb8; }
            .atq-btn:hover { background:#3a3a4a; color:#efeff1; }
            .atq-btn-primary { background:#9147ff; color:#fff; }
            .atq-btn-primary:hover { background:#7d2cf5; color:#fff; }
            .atq-btn-danger { background:#2a1010; color:#e06060; }
            .atq-btn-danger:hover { background:#8b2020; color:#fff; }
            .atq-btn-ghost { background:transparent; color:#adadb8; padding:3px 8px; font-size:1rem; }
            .atq-btn-ghost:hover { background:#2a2a35; color:#efeff1; }
            .atq-btn-sm { padding:4px 9px; font-size:0.82rem; }
            .atq-btn-icon { padding:4px 8px; font-size:0.82rem; min-width:28px; display:inline-flex; align-items:center; justify-content:center; }
            .atq-footer { display:flex; align-items:center; gap:6px; padding-top:10px; border-top:1px solid #2a2a35; }
        `;
        document.head.appendChild(style);
    }

    function mkBtn(text, onClick, cls) {
        var b = document.createElement('button');
        b.textContent = text;
        b.className = cls !== undefined ? cls : 'atq-btn';
        b.addEventListener('click', onClick);
        return b;
    }
    function mkInput(type, value, extraCls) {
        var i = document.createElement('input');
        i.type = type;
        i.value = value;
        i.className = 'atq-input' + (extraCls ? ' ' + extraCls : '');
        return i;
    }
    function mkLabel(text) {
        var s = document.createElement('span');
        s.className = 'atq-label';
        s.textContent = text;
        return s;
    }

    var list = getDropList();
    var settings = getDropSettings();
    var fallbackChannels = (settings.fallbackChannels || []).slice();
    var localTracker = JSON.parse(JSON.stringify(getDropsTracker()));

    var outer = document.createElement('div');
    outer.id = 'CampaignManagerWrapper';

    var titlebar = document.createElement('div');
    titlebar.className = 'atq-titlebar';
    var titleEl = document.createElement('span');
    titleEl.className = 'atq-title';
    titleEl.textContent = 'Campaign Manager';
    titlebar.appendChild(titleEl);
    titlebar.appendChild(mkBtn('✕', function() { outer.remove(); }, 'atq-btn atq-btn-ghost'));
    outer.appendChild(titlebar);

    var checkInput = mkInput('number', settings.checkIntervalMinutes || 10, 'atq-input-num');
    var offlineCheckInput = mkInput('number', settings.offlineCheckMinutes || 1, 'atq-input-num');
    var fallbackMinInput = mkInput('number', settings.fallbackMinutes || 30, 'atq-input-num');
    var noProgressInput = mkInput('number', settings.noProgressCheckLimit || 2, 'atq-input-num');

    var tabsDiv = document.createElement('div');
    tabsDiv.className = 'atq-tabs';
    var priorityTabBtn = mkBtn('Priority', function() { setTab('priority'); }, 'atq-tab');
    var fallbackTabBtn = mkBtn('Fallback', function() { setTab('fallback'); }, 'atq-tab');
    var trackerTabBtn = mkBtn('Tracker', function() { setTab('tracker'); }, 'atq-tab');
    var settingsTabBtn = mkBtn('Settings', function() { setTab('settings'); }, 'atq-tab');
    tabsDiv.appendChild(priorityTabBtn);
    tabsDiv.appendChild(fallbackTabBtn);
    tabsDiv.appendChild(trackerTabBtn);
    tabsDiv.appendChild(settingsTabBtn);
    outer.appendChild(tabsDiv);

    var contentArea = document.createElement('div');
    contentArea.className = 'atq-content';
    outer.appendChild(contentArea);

    var footer = document.createElement('div');
    footer.className = 'atq-footer';
    outer.appendChild(footer);

    function saveSettings() {
        GM_setValue('dropGameList', list);
        GM_setValue('dropSettings', {
            checkIntervalMinutes: parseInt(checkInput.value) || 10,
            offlineCheckMinutes: parseInt(offlineCheckInput.value) || 1,
            fallbackChannels: fallbackChannels,
            fallbackMinutes: parseInt(fallbackMinInput.value) || 30,
            noProgressCheckLimit: parseInt(noProgressInput.value) || 2
        });
        setDropsTracker(localTracker);
        popupText('Settings saved');
        refreshAllDropBtns();
    }

    function renderPriority() {
        contentArea.innerHTML = '';
        if (list.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'atq-empty';
            empty.textContent = 'No games in priority list. Use the + buttons on the Drops Campaigns page to add games.';
            contentArea.appendChild(empty);
            return;
        }
        list.forEach(function(game, idx) {
            var item = document.createElement('div');
            item.className = 'atq-item';
            item.appendChild(mkBtn('▲', function() {
                if(idx === 0) return;
                var tmp = list[idx - 1]; list[idx - 1] = list[idx]; list[idx] = tmp;
                renderPriority();
            }, 'atq-btn atq-btn-icon'));
            item.appendChild(mkBtn('▼', function() {
                if(idx === list.length - 1) return;
                var tmp = list[idx + 1]; list[idx + 1] = list[idx]; list[idx] = tmp;
                renderPriority();
            }, 'atq-btn atq-btn-icon'));
            var lbl = document.createElement('span');
            lbl.className = 'atq-item-label';
            lbl.textContent = (idx + 1) + '. ' + game.name;
            item.appendChild(lbl);
            item.appendChild(mkBtn('✕', function() {
                var name = game.name;
                list.splice(idx, 1);
                renderPriority();
                popupText('Removed: ' + name);
            }, 'atq-btn atq-btn-icon atq-btn-danger'));
            contentArea.appendChild(item);
        });
    }

    function renderFallback() {
        contentArea.innerHTML = '';
        var addRow = document.createElement('div');
        addRow.className = 'atq-row';
        addRow.style.marginBottom = '4px';
        var addInput = mkInput('text', '', 'atq-input-url');
        addInput.placeholder = 'https://www.twitch.tv/channelname';
        function doAdd() {
            var val = addInput.value.trim();
            if (!val) return;
            if (!isValidHttpUrl(val)) { popupText('Invalid URL'); return; }
            fallbackChannels.push(val);
            addInput.value = '';
            renderFallback();
        }
        addInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') doAdd(); });
        addRow.appendChild(mkLabel('Add:'));
        addRow.appendChild(addInput);
        addRow.appendChild(mkBtn('Add', doAdd, 'atq-btn atq-btn-primary atq-btn-sm'));
        contentArea.appendChild(addRow);
        if (fallbackChannels.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'atq-empty';
            empty.textContent = 'No fallback channels. Add one above.';
            contentArea.appendChild(empty);
            return;
        }
        fallbackChannels.forEach(function(channel, idx) {
            var item = document.createElement('div');
            item.className = 'atq-item';
            item.appendChild(mkBtn('▲', function() {
                if (idx === 0) return;
                var tmp = fallbackChannels[idx - 1]; fallbackChannels[idx - 1] = fallbackChannels[idx]; fallbackChannels[idx] = tmp;
                renderFallback();
            }, 'atq-btn atq-btn-icon'));
            item.appendChild(mkBtn('▼', function() {
                if (idx === fallbackChannels.length - 1) return;
                var tmp = fallbackChannels[idx + 1]; fallbackChannels[idx + 1] = fallbackChannels[idx]; fallbackChannels[idx] = tmp;
                renderFallback();
            }, 'atq-btn atq-btn-icon'));
            var lbl = document.createElement('span');
            lbl.className = 'atq-item-label';
            var displayName = channel;
            try { displayName = new URL(channel).pathname.replace(/^\//, '') || channel; } catch(e) {}
            lbl.textContent = (idx + 1) + '. ' + displayName;
            lbl.title = channel;
            item.appendChild(lbl);
            item.appendChild(mkBtn('✕', function() {
                fallbackChannels.splice(idx, 1);
                renderFallback();
            }, 'atq-btn atq-btn-icon atq-btn-danger'));
            contentArea.appendChild(item);
        });
    }

    function renderTracker() {
        contentArea.innerHTML = '';
        if (!localTracker || typeof localTracker !== 'object') { localTracker = {}; }
        var gameNames = Object.keys(localTracker).sort();
        if (gameNames.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'atq-empty';
            empty.textContent = 'No campaigns tracked yet. Start auto-farming to populate.';
            contentArea.appendChild(empty);
            return;
        }
        gameNames.forEach(function(gameName) {
            var gh = document.createElement('div');
            gh.className = 'atq-game-header';
            gh.textContent = gameName;
            contentArea.appendChild(gh);
            var campaigns = localTracker[gameName];
            if (!Array.isArray(campaigns)) { localTracker[gameName] = []; campaigns = []; }
            campaigns.forEach(function(campaign) {
                var item = document.createElement('div');
                item.className = 'atq-item';
                var lbl = document.createElement('span');
                lbl.className = 'atq-item-label' + (campaign.completed ? ' done' : '');
                lbl.textContent = campaign.name + '  -  ends ' + campaign.endDate;
                item.appendChild(mkBtn(campaign.completed ? 'Unmark' : 'Mark Done', function() {
                    campaign.completed = !campaign.completed;
                    popupText((campaign.completed ? 'Completed: ' : 'Unmarked: ') + campaign.name);
                    renderTracker();
                }, 'atq-btn atq-btn-sm'));
                item.appendChild(lbl);
                item.appendChild(mkBtn('✕', function() {
                    var name = campaign.name;
                    localTracker[gameName] = localTracker[gameName].filter(function(c) { return c.name !== name; });
                    if (localTracker[gameName].length === 0) delete localTracker[gameName];
                    popupText('Deleted: ' + name);
                    renderTracker();
                }, 'atq-btn atq-btn-icon atq-btn-danger'));
                contentArea.appendChild(item);
            });
        });
    }

    function renderSettings() {
        contentArea.innerHTML = '';
        function settingRow(labelText, input, suffix) {
            var row = document.createElement('div');
            row.className = 'atq-row';
            row.appendChild(mkLabel(labelText));
            row.appendChild(input);
            if (suffix) row.appendChild(mkLabel(suffix));
            contentArea.appendChild(row);
        }
        settingRow('Drop Check Minutes:', checkInput);
        settingRow('Offline Check Minutes:', offlineCheckInput);
        settingRow('Fallback Duration:', fallbackMinInput, 'min');
        settingRow('No Progress Check Limit:', noProgressInput, 'checks');
    }

    function setTab(tab) {
        priorityTabBtn.classList.toggle('atq-active', tab === 'priority');
        fallbackTabBtn.classList.toggle('atq-active', tab === 'fallback');
        trackerTabBtn.classList.toggle('atq-active', tab === 'tracker');
        settingsTabBtn.classList.toggle('atq-active', tab === 'settings');
        footer.innerHTML = '';
        if (tab === 'priority') {
            renderPriority();
            footer.appendChild(mkBtn('Save Settings', saveSettings, 'atq-btn atq-btn-primary'));
        } else if (tab === 'fallback') {
            renderFallback();
            footer.appendChild(mkBtn('Save Settings', saveSettings, 'atq-btn atq-btn-primary'));
        } else if (tab === 'settings') {
            renderSettings();
            footer.appendChild(mkBtn('Save Settings', saveSettings, 'atq-btn atq-btn-primary'));
        } else {
            renderTracker();
            footer.appendChild(mkBtn('Save Settings', saveSettings, 'atq-btn atq-btn-primary'));
            footer.appendChild(mkBtn('Delete Expired', function() {
                var before = Object.values(localTracker).reduce(function(s, a) { return s + a.length; }, 0);
                Object.keys(localTracker).forEach(function(gn) {
                    localTracker[gn] = localTracker[gn].filter(function(c) { return calculateTimeRemaining(c.endDate) >= -60; });
                    if (localTracker[gn].length === 0) delete localTracker[gn];
                });
                var after = Object.values(localTracker).reduce(function(s, a) { return s + a.length; }, 0);
                var n = before - after;
                renderTracker();
                popupText(n > 0 ? 'Deleted ' + n + ' expired campaign' + (n !== 1 ? 's' : '') + '.' : 'No expired campaigns to delete');
            }, 'atq-btn atq-btn-sm'));
            footer.appendChild(mkBtn('Delete All', function() {
                if (confirm('Delete all tracked campaigns?')) {
                    localTracker = {};
                    renderTracker();
                    popupText('All campaigns deleted');
                }
            }, 'atq-btn atq-btn-sm atq-btn-danger'));
        }
        footer.appendChild(mkBtn('Close', function() { outer.remove(); }, 'atq-btn'));
    }

    setTab('priority');
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

function findCampaignContainerAllSiblings(header) {
    var el = header;
    while (el && el !== document.body) {
        var sib = el.nextElementSibling;
        while (sib) {
            if (sib.querySelector('button[aria-expanded]')) return sib;
            sib = sib.nextElementSibling;
        }
        el = el.parentElement;
    }
    return null;
}

function injectDropButtons() {
    var observer = new MutationObserver(function() {
        var dropHeader = Array.from(document.querySelectorAll('h4')).find(el => el.textContent.trim() === "Open Drop Campaigns");
        if(!dropHeader) return;
        var campaignContainer = findCampaignContainer(dropHeader);
        if(!campaignContainer) return;
        observer.disconnect();
        var rewardHeader = Array.from(document.querySelectorAll('h4')).find(el => el.textContent.trim() === "Open Reward Campaigns");
        if (rewardHeader) {
            var rewardContainer = findCampaignContainerAllSiblings(rewardHeader);
            if (rewardContainer) renderRewardButtons(rewardContainer);
        }
        renderDropButtons(campaignContainer);
        renderClosedDropButtons();
        var closedObserver = new MutationObserver(function() {
            if (renderClosedDropButtons()) { clearTimeout(closedObserverTimeout); closedObserver.disconnect(); }
        });
        closedObserver.observe(document.body, { childList: true, subtree: true });
        var closedObserverTimeout = setTimeout(function() { closedObserver.disconnect(); }, 15000);
        if(sessionStorage.getItem("AutoTwitchQueuerAutoFarmCampaigns") == "true" && window.location.pathname === "/drops/campaigns") {
            autoFarmCampaigns();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

function renderClosedDropButtons() {
    var closedHeader = Array.from(document.querySelectorAll('h4')).find(el => el.textContent.trim() === "Closed Drop Campaigns");
    if (!closedHeader) return false;
    var closedContainer = findCampaignContainerAllSiblings(closedHeader);
    if (!closedContainer) return false;
    renderDropButtons(closedContainer);
    return true;
}

function renderDropButtons(campaignContainer) {
    Array.from(campaignContainer.children).forEach(function(row) {
        if(row.querySelector('.atq-drop-btn')) return;
        var nameEl = row.querySelector('p');
        if(!nameEl) return;
        var gameName = nameEl.textContent.trim();
        var header = row.querySelector('.accordion-header, [role="heading"]');
        if(!header) return;
        var btn = document.createElement('button');
        btn.className = 'atq-drop-btn';
        btn.dataset.atqGame = gameName;
        btn.style.cssText = "position:absolute; left:6px; top:50%; transform:translateY(-50%); z-index:9999; width:22px; height:22px; border:none; border-radius:4px; font-size:15px; font-weight:700; line-height:1; cursor:pointer; transition:background 0.12s, color 0.12s; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; display:flex; align-items:center; justify-content:center;";
        updateDropBtn(btn, gameName);
        btn.addEventListener('mouseenter', function() { btn.style.background = '#9147ff'; btn.style.color = '#fff'; });
        btn.addEventListener('mouseleave', function() { updateDropBtn(btn, gameName); });
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleDropGame(gameName);
            refreshAllDropBtns();
        });
        header.style.position = 'relative';
        var accordionToggle = header.querySelector('button');
        if(accordionToggle) accordionToggle.style.paddingLeft = '2.5rem';
        header.appendChild(btn);
    });
}

function refreshAllDropBtns() {
    document.querySelectorAll('.atq-drop-btn[data-atq-game]').forEach(function(btn) {
        updateDropBtn(btn, btn.dataset.atqGame);
    });
}

function updateDropBtn(btn, gameName) {
    var inList = getDropList().some(g => g.name === gameName);
    btn.textContent = inList ? '−' : '+';
    btn.style.background = inList ? '#1a0a2e' : '#2a2a35';
    btn.style.color = inList ? '#9147ff' : '#adadb8';
}

function getRewardRows(rewardContainer) {
    var seen = [];
    return Array.from(rewardContainer.querySelectorAll('.accordion-header')).map(function(h) {
        return h.parentElement;
    }).filter(function(row) {
        if (seen.indexOf(row) !== -1) return false;
        seen.push(row);
        return true;
    });
}

function renderRewardButtons(rewardContainer) {
    getRewardRows(rewardContainer).forEach(function(row) {
        if (row.querySelector('.atq-drop-btn')) return;
        var imgEl = row.querySelector('img.partner-thumbnail');
        if (!imgEl || !imgEl.alt) return;
        var gameName = imgEl.alt;
        var header = row.querySelector('.accordion-header, [role="heading"]');
        if (!header) return;
        var btn = document.createElement('button');
        btn.className = 'atq-drop-btn';
        btn.dataset.atqGame = gameName;
        btn.style.cssText = "position:absolute; left:6px; top:50%; transform:translateY(-50%); z-index:9999; width:22px; height:22px; border:none; border-radius:4px; font-size:15px; font-weight:700; line-height:1; cursor:pointer; transition:background 0.12s, color 0.12s; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; display:flex; align-items:center; justify-content:center;";
        updateDropBtn(btn, gameName);
        btn.addEventListener('mouseenter', function() { btn.style.background = '#9147ff'; btn.style.color = '#fff'; });
        btn.addEventListener('mouseleave', function() { updateDropBtn(btn, gameName); });
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleDropGame(gameName);
            refreshAllDropBtns();
        });
        header.style.position = 'relative';
        var accordionToggle = header.querySelector('button');
        if (accordionToggle) accordionToggle.style.paddingLeft = '2.5rem';
        header.appendChild(btn);
    });
}

function getDropList() {
    return GM_getValue('dropGameList', []);
}

function getDropSettings() {
    var s = GM_getValue('dropSettings', {});
    if (!s.fallbackChannels) {
        s.fallbackChannels = s.fallbackChannel ? [s.fallbackChannel] : [];
    }
    return {
        checkIntervalMinutes: s.checkIntervalMinutes || 10,
        offlineCheckMinutes: s.offlineCheckMinutes || 1,
        fallbackChannels: s.fallbackChannels,
        fallbackMinutes: s.fallbackMinutes || 30,
        noProgressCheckLimit: s.noProgressCheckLimit || 2
    };
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

function useFallbackOr(message) {
    var channels = getDropSettings().fallbackChannels;
    if (channels && channels.length > 0) {
        queueFallbackChannel(0);
    } else {
        popupText(message);
    }
}

function autoFarmCampaignsToggle() {
    if(sessionStorage.getItem("AutoTwitchQueuerAutoFarmCampaigns") != "true") {
        sessionStorage.setItem("AutoTwitchQueuerAutoFarmCampaigns","true");
        autoFarmCampaigns();
    } else {
        popupText("Disabling Auto Farm Campaigns");
        sessionStorage.setItem("AutoTwitchQueuerAutoFarmCampaigns","false");
        stopInventoryChecking();
        cancelQueue();
        cleanRedirect("https://www.twitch.tv/drops/campaigns");
    }
}

function autoFarmCampaigns() {
    stopInventoryChecking();
    sessionStorage.removeItem("inventoryCheckElapsedMinutes");
    sessionStorage.removeItem("farmingMissingChecks");
    if(window.location.pathname !== "/drops/campaigns") {
        popupText("Returning to Campaigns page to farm");
        cleanRedirect("https://www.twitch.tv/drops/campaigns");
        return;
    }
    var list = getDropList();
    if(list.length === 0) {
        useFallbackOr("No campaigns in priority list");
        return;
    }
    var stallSameGame = sessionStorage.getItem("farmingStallSameGame");
    if (stallSameGame !== null) {
        sessionStorage.removeItem("farmingStallSameGame");
        farmNextPriority(list, parseInt(stallSameGame));
    } else {
        sessionStorage.removeItem("farmingIsStallFallback");
        sessionStorage.removeItem("farmingSkipCampaigns");
        sessionStorage.removeItem("farmingStallGameNames");
        farmNextPriority(list, 0);
    }
}

function farmNextPriority(list, idx) {
    if(idx >= list.length) {
        stopInventoryChecking();
        useFallbackOr("All priority games completed");
        return;
    }
    var game = list[idx];
    // Reward campaign accordions and drop campaign rows are formatted differently, but both
    // get collected here and merged into one campaign list per game
    var rewardRows = [];
    var rewardHeader = Array.from(document.querySelectorAll('h4')).find(el => el.textContent.trim() === "Open Reward Campaigns");
    if (rewardHeader) {
        var rewardContainer = findCampaignContainerAllSiblings(rewardHeader);
        if (rewardContainer) {
            rewardRows = getRewardRows(rewardContainer).filter(function(row) {
                var imgEl = row.querySelector('img.partner-thumbnail');
                return imgEl && imgEl.alt === game.name;
            });
        }
    }
    var matchingRows = [];
    var header = Array.from(document.querySelectorAll('h4')).find(el => el.textContent.trim() === "Open Drop Campaigns");
    var campaignContainer = header ? findCampaignContainer(header) : null;
    if (campaignContainer) {
        matchingRows = Array.from(campaignContainer.children).filter(function(row) {
            var nameEl = row.querySelector('p');
            return nameEl && nameEl.textContent.trim() === game.name;
        });
    }
    if (!campaignContainer && rewardRows.length === 0) {
        popupText("Could not find campaigns list");
        return;
    }
    popupText("Debug: Found " + matchingRows.length + " drop row(s) and " + rewardRows.length + " reward row(s) for " + game.name);
    if (matchingRows.length === 0 && rewardRows.length === 0) {
        popupText("Campaign not found on page: " + game.name);
        farmNextPriority(list, idx + 1);
        return;
    }
    var toLoad = rewardRows.concat(matchingRows).filter(function(r) {
        return !r.querySelector('.drop-details__label');
    });
    expandRowsSequentially(toLoad, function() {
        parseAllCampaignsAndQueue(game, matchingRows, rewardRows, list, idx);
    });
}

function parseAllCampaignsAndQueue(game, matchingRows, rewardRows, list, idx) {
    var campaigns = parseCampaignsFromRow(matchingRows);
    rewardRows.forEach(function(row) {
        campaigns.push(parseRewardCampaignFromRow(game, row));
    });
    popupText("Debug: Parsed " + campaigns.length + " campaign(s) for " + game.name + ": [" + campaigns.map(function(c) { return c.name; }).join(", ") + "]");
    if (campaigns.length === 0) {
        popupText("No campaigns found for: " + game.name + ", skipping");
        farmNextPriority(list, idx + 1);
        return;
    }
    campaigns.forEach(function(campaign) {
        addCampaignToTracker(game.name, campaign.name, campaign.endDate);
    });
    var tracker = getDropsTracker();
    var uncompleted = campaigns.filter(function(c) {
        var tracked = tracker[game.name] && tracker[game.name].find(function(t) { return t.name === c.name; });
        return !tracked || !tracked.completed;
    });
    popupText("Debug: " + uncompleted.length + " uncompleted: [" + uncompleted.map(function(c) { return c.name; }).join(", ") + "]");
    if (uncompleted.length === 0) {
        popupText("All campaigns completed for: " + game.name + ", moving to next");
        sessionStorage.removeItem("farmingSkipCampaigns");
        farmNextPriority(list, idx + 1);
        return;
    }
    var skipList = JSON.parse(sessionStorage.getItem("farmingSkipCampaigns") || "[]");
    var farmable = uncompleted.filter(function(c) { return !skipList.includes(c.name); });
    popupText("Debug: " + farmable.length + " farmable (skip list: [" + skipList.join(", ") + "]): [" + farmable.map(function(c) { return c.name; }).join(", ") + "]");
    if (farmable.length === 0) {
        sessionStorage.removeItem("farmingSkipCampaigns");
        sessionStorage.setItem("farmingIsStallFallback", "true");
        var stalledGames = JSON.parse(sessionStorage.getItem("farmingStallGameNames") || "[]");
        if (!stalledGames.includes(game.name)) stalledGames.push(game.name);
        sessionStorage.setItem("farmingStallGameNames", JSON.stringify(stalledGames));
        popupText("All campaign links stalled for " + game.name + ". Trying next priority game");
        farmNextPriority(list, idx + 1);
        return;
    }
    findNextFarmableCampaign(game, matchingRows, list, idx, farmable);
}

function findNextFarmableCampaign(game, matchingRows, list, idx, uncompleted) {
    var farmableCampaign = null;
    uncompleted = uncompleted.slice().sort(function(a, b) {
        return parseEndDateToMs(a.endDate) - parseEndDateToMs(b.endDate);
    });
    for (var i = 0; i < uncompleted.length; i++) {
        var campaign = uncompleted[i];
        var remainingMinutes = calculateTimeRemaining(campaign.endDate);
        if (remainingMinutes > 0) {
            farmableCampaign = campaign;
            break;
        } else {
            if (remainingMinutes < -60) {
                markCampaignCompleted(game.name, campaign.name, true);
            } else {
                farmableCampaign = campaign;
                break;
            }
        }
    }
    if (!farmableCampaign) {
        if (areAllCampaignsCompleted(game.name)) {
            popupText("All campaigns completed for: " + game.name + ", moving to next");
            farmNextPriority(list, idx + 1);
            return;
        }
        var stillUncompleted = getUncompletedCampaigns(game.name);
        if (stillUncompleted.length > 0) {
            findNextFarmableCampaign(game, matchingRows, list, idx, stillUncompleted);
        }
        return;
    }
    queueCampaignStream(game, matchingRows, farmableCampaign, list, idx);
}

function normalizeTwitchUrl(url) {
    if (url.includes("twitch.tv/directory/category") && !url.includes("?filter=drops&sort=VIEWER_COUNT")) {
        return url.split("?")[0] + "?filter=drops&sort=VIEWER_COUNT";
    }
    if (!url.includes("/directory/category") && !url.includes("/about") && !url.includes("?filter=drops&sort=VIEWER_COUNT")) {
        return url + "/about";
    }
    return url;
}

function queueStreamFor(url, watchMinutes) {
    var now = new Date();
    var returnTime = new Date(now.getTime() + watchMinutes * 60 * 1000);
    var nowString = now.toLocaleDateString("en-CA") + " " + now.toLocaleTimeString("en");
    var returnString = returnTime.toLocaleDateString("en-CA") + " " + returnTime.toLocaleTimeString("en");
    scheduleList = [url, nowString, "https://www.twitch.tv/drops/campaigns", returnString];
    sessionStorage.setItem("scheduleStorage", scheduleString());
}

function skipCampaignAndContinue(game, campaign, list, idx) {
    // Dead-ending on a queue failure would freeze the farming loop entirely, so mark the
    // campaign as skipped for this session and re-scan the game from scratch. The re-scan
    // also picks up fresh DOM nodes in case the failure was a stale row after a re-render,
    // and the skip list guarantees termination (all skipped -> stall path -> next game).
    var skipList = JSON.parse(sessionStorage.getItem("farmingSkipCampaigns") || "[]");
    if (!skipList.includes(campaign.name)) skipList.push(campaign.name);
    sessionStorage.setItem("farmingSkipCampaigns", JSON.stringify(skipList));
    farmNextPriority(list, idx);
}

function queueCampaignStream(game, matchingRows, campaign, list, idx) {
    var rows = Array.isArray(matchingRows) ? matchingRows : [matchingRows];
    var targetBlock = null;
    if (campaign.rewardRow) {
        // Reward campaigns carry their accordion row directly since they have no
        // per-campaign <strong> name to locate inside the drop campaign rows
        targetBlock = campaign.rewardRow;
    } else {
        var matchingStrong = null;
        var campaignRow = null;
        for (var r = 0; r < rows.length; r++) {
            var s = Array.from(rows[r].querySelectorAll('strong')).find(function(el) {
                return !el.closest('.drop-details__label') && el.textContent.trim() === campaign.name;
            });
            if (s) {
                matchingStrong = s;
                campaignRow = rows[r];
                break;
            }
        }
        if (matchingStrong) {
            var el = matchingStrong.parentElement;
            while (el && el !== campaignRow) {
                var hasEarnLabel = Array.from(el.querySelectorAll('.drop-details__label'))
                    .some(function(lbl) { return /how to earn/i.test(lbl.textContent); });
                if (hasEarnLabel) { targetBlock = el; break; }
                el = el.parentElement;
            }
        }
    }
    if (!targetBlock) {
        popupText("Could not find campaign block for: " + campaign.name + ", skipping");
        skipCampaignAndContinue(game, campaign, list, idx);
        return;
    }
    // Matches "How to Earn the Drop" (drop campaigns) and "How To Earn The Reward" (reward campaigns)
    var earnLabel = Array.from(targetBlock.querySelectorAll('.drop-details__label'))
        .find(el => /how to earn/i.test(el.textContent));
    if(!earnLabel) {
        popupText("Could not read drop details for: " + campaign.name + ", skipping");
        skipCampaignAndContinue(game, campaign, list, idx);
        return;
    }
    var ul = earnLabel.parentElement.querySelector('ul');
    if(!ul) {
        popupText("Could not read drop details for: " + campaign.name + ", skipping");
        skipCampaignAndContinue(game, campaign, list, idx);
        return;
    }
    var items = Array.from(ul.querySelectorAll('li'));
    // Matches "Watch for 20 minutes" (drop campaigns) and "Watch 20 minutes" (reward campaigns);
    // campaigns earned another way (e.g. subscriptions) have no watch item and get skipped
    var watchItems = items.filter(li => /watch\s+(for\s+)?\d+/i.test(li.textContent));
    if(watchItems.length === 0) {
        popupText("No watchable drops for: " + campaign.name + ", marking complete");
        markCampaignCompleted(game.name, campaign.name, true);
        var uncompleted = getUncompletedCampaigns(game.name);
        if (uncompleted.length > 0) {
            findNextFarmableCampaign(game, matchingRows, list, idx, uncompleted);
        } else if (areAllCampaignsCompleted(game.name)) {
            farmNextPriority(list, idx + 1);
        }
        return;
    }
    // Prefer links inside the watch-time item (so a reward's "visit your Drops Inventory"
    // item can't contribute its link), but some drop campaigns put the channel/category
    // links in a different list item than the watch-time one, so fall back to the first
    // item that actually has links
    function watchableLinks(li) {
        return Array.from(li.querySelectorAll('a')).filter(function(a) {
            var href = a.getAttribute('href') || '';
            return href && !href.includes('/drops/inventory');
        });
    }
    var linkLi = watchItems.find(function(li) { return watchableLinks(li).length > 0; })
        || items.find(function(li) { return watchableLinks(li).length > 0; });
    var links = linkLi ? watchableLinks(linkLi) : [];
    var streamHref = links.length > 0 ? links[links.length - 1].getAttribute('href') : null;
    if(!streamHref) {
        popupText("No stream link found for: " + campaign.name + ", skipping");
        skipCampaignAndContinue(game, campaign, list, idx);
        return;
    }
    sessionStorage.setItem("farmingAllLinks", JSON.stringify(links.map(function(l) { return l.getAttribute('href'); })));
    sessionStorage.setItem("farmingLinkIndex", String(links.length - 1));
    sessionStorage.removeItem("farmingLastProgress");
    sessionStorage.removeItem("farmingStalledChecks");
    sessionStorage.removeItem("farmingNoProgressChecks");
    sessionStorage.removeItem("farmingMissingChecks");
    var streamUrl = streamHref.startsWith('http') ? streamHref : "https://www.twitch.tv" + streamHref;
    var settings = getDropSettings();
    var remainingMinutes = calculateTimeRemaining(campaign.endDate);
    var isStallFallback = sessionStorage.getItem("farmingIsStallFallback") === "true";
    var watchMinutes = isStallFallback ? (settings.fallbackMinutes || 30) : remainingMinutes;
    queueStreamFor(normalizeTwitchUrl(streamUrl), watchMinutes);
    sessionStorage.setItem("farmingGameIdx", idx.toString());
    sessionStorage.setItem("farmingGameName", game.name);
    sessionStorage.setItem("farmingCampaignName", campaign.name);
    popupText("Queued: " + campaign.name + " for " + watchMinutes + " min");
    processSchedule();
}

function clearFarmingSessionState() {
    sessionStorage.removeItem("farmingGameName");
    sessionStorage.removeItem("farmingCampaignName");
    sessionStorage.removeItem("farmingGameIdx");
    sessionStorage.removeItem("farmingAllLinks");
    sessionStorage.removeItem("farmingLinkIndex");
    sessionStorage.removeItem("farmingLastProgress");
    sessionStorage.removeItem("farmingSeenInInventory");
    sessionStorage.removeItem("farmingNoProgressChecks");
    sessionStorage.removeItem("farmingStalledChecks");
    sessionStorage.removeItem("farmingMissingChecks");
    sessionStorage.removeItem("farmingIsStallFallback");
    sessionStorage.removeItem("farmingSkipCampaigns");
    sessionStorage.removeItem("farmingStallSameGame");
    sessionStorage.removeItem("fallbackChannelIndex");
}

function queueFallbackChannel(idx) {
    var settings = getDropSettings();
    var channels = settings.fallbackChannels || [];
    if (!channels.length) return;
    var channelUrl = channels[Math.min(idx, channels.length - 1)];
    var watchMinutes = settings.fallbackMinutes || 30;
    clearFarmingSessionState();
    var list = getDropList();
    sessionStorage.setItem("farmingGameName", "__fallback__");
    sessionStorage.setItem("farmingCampaignName", "__fallback__");
    sessionStorage.setItem("farmingGameIdx", String(list.length));
    sessionStorage.setItem("fallbackChannelIndex", String(idx));
    sessionStorage.setItem("farmingIsStallFallback", "true");
    queueStreamFor(normalizeTwitchUrl(channelUrl), watchMinutes);
    popupText("No drops available. Trying fallback " + (idx + 1) + " for " + watchMinutes + " min");
    processSchedule();
}

function tryNextFallbackChannel() {
    var channels = getDropSettings().fallbackChannels || [];
    var idx = parseInt(sessionStorage.getItem("fallbackChannelIndex") || "0");
    var nextIdx = idx + 1;
    if (nextIdx < channels.length) {
        popupText("Fallback " + (idx + 1) + " offline. Trying fallback " + (nextIdx + 1));
        queueFallbackChannel(nextIdx);
    } else {
        popupText("All fallback channels offline. Waiting.");
    }
}

function tryNextAvailableLink(gameName, campaignName) {
    var allLinks = JSON.parse(sessionStorage.getItem("farmingAllLinks") || "[]");
    var linkIndex = parseInt(sessionStorage.getItem("farmingLinkIndex") || "-1");
    // A category link is always the last link, so it's always the initial pick when present.
    // If the list has a category link and we stalled on it, there's no point falling back to
    // the specific channels (they stream the same category), so treat the campaign as stalled.
    // Channel links are only iterated for campaigns that have no category link at all.
    var hasCategoryLink = allLinks.some(function(l) { return l && l.includes("/directory/category"); });
    var nextIndex = hasCategoryLink ? -1 : linkIndex - 1;
    if (nextIndex >= 0 && allLinks[nextIndex]) {
        var nextHref = allLinks[nextIndex];
        var nextUrl = nextHref.startsWith('http') ? nextHref : "https://www.twitch.tv" + nextHref;
        sessionStorage.setItem("farmingLinkIndex", String(nextIndex));
        sessionStorage.removeItem("farmingLastProgress");
        sessionStorage.removeItem("farmingStalledChecks");
        sessionStorage.removeItem("farmingNoProgressChecks");
        sessionStorage.removeItem("farmingMissingChecks");
        var tracker = getDropsTracker();
        var campaign = tracker[gameName] && tracker[gameName].find(function(c) { return c.name === campaignName; });
        var settings = getDropSettings();
        var remainingMinutes = campaign ? calculateTimeRemaining(campaign.endDate) : (settings.fallbackMinutes || 30);
        queueStreamFor(normalizeTwitchUrl(nextUrl), remainingMinutes);
        popupText("Stream stalled. Trying backup link: " + nextHref);
        processSchedule();
    } else {
        var gameIdx = parseInt(sessionStorage.getItem("farmingGameIdx") || "0");
        var skipped = JSON.parse(sessionStorage.getItem("farmingSkipCampaigns") || "[]");
        if (!skipped.includes(campaignName)) skipped.push(campaignName);
        sessionStorage.setItem("farmingSkipCampaigns", JSON.stringify(skipped));
        sessionStorage.setItem("farmingStallSameGame", String(gameIdx));
        sessionStorage.removeItem("farmingLastProgress");
        sessionStorage.removeItem("farmingStalledChecks");
        sessionStorage.removeItem("farmingNoProgressChecks");
        sessionStorage.removeItem("farmingMissingChecks");
        sessionStorage.removeItem("farmingAllLinks");
        sessionStorage.removeItem("farmingLinkIndex");
        popupText("All links stalled for " + campaignName + ". Trying next campaign");
        cleanRedirect("https://www.twitch.tv/drops/campaigns");
    }
}

function stopInventoryChecking() {
    clearTimeout(inventoryCheckInterval);
    inventoryCheckInterval = null;
    clearTimeout(offlineCheckInterval);
    offlineCheckInterval = null;
}

function checkCurrentStreamAlive() {
    if (document.querySelector('.channel-root__player--offline')) return false;

    var followOverlay = document.querySelector('.follow-panel-overlay');
    if (followOverlay && followOverlay.textContent.includes('Follow and get notified when')) return false;

    if (window.location.pathname.endsWith('/about')) {
        var liveEl = document.querySelector('.channel-status-info--live');
        if (!liveEl) return null;
        return Array.from(liveEl.querySelectorAll('[class*="CoreText"]'))
            .some(function(el) { return el.textContent.includes('Live'); });
    }

    var viewerCount = document.querySelector('[data-a-target="animated-channel-viewers-count"]');
    if (viewerCount) {
        streamViewerCountSeen = true;
    } else if (streamViewerCountSeen) {
        return false;
    }

    return true;
}

function runOfflineCheck() {
    var gn = sessionStorage.getItem("farmingGameName");
    var cn = sessionStorage.getItem("farmingCampaignName");
    if (!gn || !cn) { popupText("Debug: No active farming session"); return; }
    var streamAlive = checkCurrentStreamAlive();
    if (streamAlive === false) {
        stopInventoryChecking();
        if (gn === "__fallback__") {
            tryNextFallbackChannel();
        } else {
            popupText("Stream offline, trying next link");
            tryNextAvailableLink(gn, cn);
        }
    } else if (streamAlive === null) {
        popupText("Debug: Stream status inconclusive");
    } else {
        popupText("Debug: Stream appears online");
    }
}

function runPriorityCheck() {
    var gameName = sessionStorage.getItem("farmingGameName");
    if (!gameName) { popupText("Debug: No active farming session"); return; }
    popupText("Debug: Checking for higher priority campaigns");
    checkForHigherPriorityCampaign().then(function(higherFound) {
        if (higherFound) {
            stopInventoryChecking();
            popupText("Higher priority campaign available. Returning to campaigns");
            cleanRedirect("https://www.twitch.tv/drops/campaigns");
        } else {
            popupText("Debug: No higher priority campaigns found");
        }
    });
}

function debugCullIframes() {
    var invStatus = inventoryIframe ? (inventoryIframe.parentNode ? "alive" : "detached") : "null";
    var campStatus = campaignsIframe ? (campaignsIframe.parentNode ? "alive" : "detached") : "null";
    popupText("Iframe status: inv=" + invStatus + " camp=" + campStatus);
    killIframes();
}

function runInventoryCheck() {
    var gameName = sessionStorage.getItem("farmingGameName");
    var campaignName = sessionStorage.getItem("farmingCampaignName");
    if (!gameName || !campaignName) {
        popupText("Debug: No active farming session");
        return;
    }

    if (gameName === "__fallback__") {
        checkForHigherPriorityCampaign().then(function(higherFound) {
            if (higherFound) {
                stopInventoryChecking();
                popupText("Higher priority campaign available. Returning to campaigns");
                cleanRedirect("https://www.twitch.tv/drops/campaigns");
            }
        });
        return;
    }

    popupText("Debug: Running inventory check for " + campaignName);
    var campaign = getDropsTracker()[gameName]?.find(c => c.name === campaignName);
    if (!campaign) {
        stopInventoryChecking();
        return;
    }
    checkInventoryForCampaign(campaignName, campaign.endDate).then(function(result) {
        var noProgressCheckLimit = getDropSettings().noProgressCheckLimit;
        var seenCampaign = sessionStorage.getItem("farmingSeenInInventory");
        if (result.found) {
            sessionStorage.setItem("farmingSeenInInventory", campaignName);
        }

        if (seenCampaign !== campaignName && !result.found) {
            var missCount = parseInt(sessionStorage.getItem("farmingNoProgressChecks") || "0") + 1;
            if (missCount >= noProgressCheckLimit) {
                sessionStorage.removeItem("farmingNoProgressChecks");
                stopInventoryChecking();
                popupText(campaignName + " never registered in inventory. Treating as stalled, trying next link");
                tryNextAvailableLink(gameName, campaignName);
                return;
            }
            sessionStorage.setItem("farmingNoProgressChecks", String(missCount));
            popupText("Debug: " + campaignName + " not yet in inventory (" + missCount + "/" + noProgressCheckLimit + "), continuing to watch");
            checkForHigherPriorityCampaign().then(function(higherFound) {
                if (higherFound) {
                    stopInventoryChecking();
                    popupText("Higher priority campaign available. Returning to campaigns");
                    cleanRedirect("https://www.twitch.tv/drops/campaigns");
                }
            });
            return;
        }

        sessionStorage.removeItem("farmingNoProgressChecks");

        if (!result.exists) {
            // Same multiple-strike rule as the stall/no-progress counters: the campaign must be
            // missing from the inventory on consecutive checks before it's considered completed,
            // so one flaky iframe render can't prematurely mark a campaign done.
            var missingCount = parseInt(sessionStorage.getItem("farmingMissingChecks") || "0") + 1;
            if (missingCount >= noProgressCheckLimit) {
                sessionStorage.removeItem("farmingMissingChecks");
                markCampaignCompleted(gameName, campaignName, true);
                stopInventoryChecking();
                popupText("Campaign completed: " + campaignName + ". Returning to campaigns");
                cleanRedirect("https://www.twitch.tv/drops/campaigns");
                return;
            }
            sessionStorage.setItem("farmingMissingChecks", String(missingCount));
            popupText("Debug: " + campaignName + " missing from inventory (" + missingCount + "/" + noProgressCheckLimit + "), continuing to watch");
            checkForHigherPriorityCampaign().then(function(higherFound) {
                if (higherFound) {
                    stopInventoryChecking();
                    popupText("Higher priority campaign available. Returning to campaigns");
                    cleanRedirect("https://www.twitch.tv/drops/campaigns");
                }
            });
            return;
        }

        if (result.found) {
            sessionStorage.removeItem("farmingMissingChecks");
        }

        checkForHigherPriorityCampaign().then(function(higherFound) {
            if (higherFound) {
                stopInventoryChecking();
                popupText("Higher priority campaign available. Returning to campaigns");
                cleanRedirect("https://www.twitch.tv/drops/campaigns");
            } else {
                var currentProgress = result.progress;
                var lastProgress = sessionStorage.getItem("farmingLastProgress");
                if (currentProgress !== null) {
                    sessionStorage.setItem("farmingLastProgress", currentProgress);
                    if (lastProgress !== null && currentProgress === lastProgress) {
                        var stallCount = parseInt(sessionStorage.getItem("farmingStalledChecks") || "0") + 1;
                        if (stallCount >= noProgressCheckLimit) {
                            sessionStorage.removeItem("farmingStalledChecks");
                            stopInventoryChecking();
                            tryNextAvailableLink(gameName, campaignName);
                        } else {
                            sessionStorage.setItem("farmingStalledChecks", String(stallCount));
                            popupText("Debug: " + campaignName + " progress unchanged (" + stallCount + "/" + noProgressCheckLimit + "), continuing to watch");
                        }
                    } else {
                        sessionStorage.removeItem("farmingStalledChecks");
                    }
                }
            }
        });
    });
}

function startInventoryChecking() {
    stopInventoryChecking();
    streamViewerCountSeen = false;
    var settings = getDropSettings();
    var checkIntervalMinutes = settings.checkIntervalMinutes || 10;
    var offlineCheckMinutes = settings.offlineCheckMinutes || 1;
    var gameName = sessionStorage.getItem("farmingGameName");
    var campaignName = sessionStorage.getItem("farmingCampaignName");
    if (!gameName || !campaignName) return;
    popupText("Starting checks - offline: " + offlineCheckMinutes + " min, inventory: " + checkIntervalMinutes + " min");

    function offlineTick() {
        runOfflineCheck();
        if (offlineCheckInterval !== null) {
            offlineCheckInterval = setTimeout(offlineTick, offlineCheckMinutes * 60000);
        }
    }

    function iframeTick() {
        var elapsed = parseInt(sessionStorage.getItem("inventoryCheckElapsedMinutes") || "0") + 1;
        if (elapsed >= checkIntervalMinutes) {
            sessionStorage.setItem("inventoryCheckElapsedMinutes", "0");
            runInventoryCheck();
        } else {
            sessionStorage.setItem("inventoryCheckElapsedMinutes", String(elapsed));
        }
        if (inventoryCheckInterval !== null) {
            inventoryCheckInterval = setTimeout(iframeTick, 60000);
        }
    }

    offlineCheckInterval = setTimeout(offlineTick, offlineCheckMinutes * 60000);
    inventoryCheckInterval = setTimeout(iframeTick, 60000);
}

function getScheduleInput() {
    return document.getElementById('TwitchScheduleGrabber').value.split("\n");
}

function setScheduleInput(list) {
    document.getElementById('TwitchScheduleGrabber').value = list.join("\n");
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
    scheduleList = getScheduleInput();
    var scheduleEntryTime = new Date(scheduleList[scheduleList.length - 1]);
    scheduleEntryTime.setSeconds(scheduleEntryTime.getSeconds() + seconds);
    scheduleEntryTime.setMinutes(scheduleEntryTime.getMinutes() + minutes);
    scheduleEntryTime.setHours(scheduleEntryTime.getHours() + hours);
    var scheduleEntryTimeParsed = scheduleEntryTime.toLocaleDateString("en-CA") + " " + scheduleEntryTime.toLocaleTimeString("en");
    scheduleList.splice(scheduleList.length - 1, 1, scheduleEntryTimeParsed);
    setScheduleInput(scheduleList);
}

function parseLink() {
    scheduleList = getScheduleInput();
    if(scheduleList.length < 2) return null;
    var nearestLink = normalizeTwitchUrl(scheduleList.at(-2));
    scheduleList.splice(-2, 1, nearestLink);
    setScheduleInput(scheduleList);
}

/* Currently unused, preserving for potential use in the future
function duplicateLine() {
    scheduleList = getScheduleInput();
    if(scheduleList.length < 2) return null;
    scheduleList.push(...scheduleList.slice(-2));
    setScheduleInput(scheduleList);
}
*/

function returnToPrevious() {
    scheduleList = getScheduleInput();
    if(scheduleList.length < 4) return null;
    var previousTime = scheduleList.at(-1).split(" ");
    previousTime = " " + previousTime.at(-2) + " " + previousTime.at(-1);
    var defaultLink = scheduleList.at(-4);
    scheduleList.push(...[defaultLink, currentDateString + previousTime]);
    setScheduleInput(scheduleList);
}

function addCurrentPage() {
    scheduleList = getScheduleInput();
    var defaultLink = window.location.href;
    if(scheduleList.length < 2) {
        scheduleList = [defaultLink, currentDateString + currentTimeString("roundup")];
    } else {
        var previousTime = scheduleList.at(-1).split(" ");
        previousTime = " " + previousTime.at(-2) + " " + previousTime.at(-1);
        scheduleList.push(...[defaultLink, currentDateString + previousTime]);
    }
    setScheduleInput(scheduleList);
}

function addEntry() {
    scheduleList = getScheduleInput();
    var previousTime;
    if(scheduleList.at(-1).split(" ").length < 2) {
        previousTime = currentTimeString("roundup");
    } else {
        var parts = scheduleList.at(-1).split(" ");
        previousTime = " " + parts.at(-2) + " " + parts.at(-1);
    }
    var defaultLink = window.location.href;
    navigator.clipboard.readText().then(text => {
        if(isValidHttpUrl(text) && !text.includes('\n')) {
            defaultLink = text;
        }
        if(scheduleList.length < 2) {
            scheduleList = [defaultLink, currentDateString + previousTime];
        } else {
            scheduleList.push(...[defaultLink, currentDateString + previousTime]);
        }
        setScheduleInput(scheduleList);
    });
}

function removeEntry() {
    scheduleList = getScheduleInput();
    scheduleList.splice(scheduleList.length - 2, 2);
    setScheduleInput(scheduleList);
}

function toggleAMPM() {
    scheduleList = getScheduleInput();
    if(scheduleList.length < 2) return null;
    var scheduleEntry = scheduleList[scheduleList.length - 1].split(" ");
    scheduleEntry[scheduleEntry.length - 1] = scheduleEntry[scheduleEntry.length - 1].includes("AM") ? "PM" : "AM";
    scheduleList.splice(scheduleList.length - 1, 1, scheduleEntry.join(" "));
    setScheduleInput(scheduleList);
}

function readSchedule() {
    scheduleList = getScheduleInput();
    if(scheduleList.length % 2 != 0) {
        popupText("Odd Queue Count? Possible Malformed Queue");
        return;
    }
    clearTimeout(scheduleTimeout);
    document.getElementById("TwitchScheduleOuterWrapper").remove();
    sessionStorage.setItem("scheduleStorage", scheduleString());
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
        var MAX_TIMEOUT_DELAY = 2147483647;
        var nextDelay = Math.min(timeDiff + 100, MAX_TIMEOUT_DELAY);
        scheduleTimeout = setTimeout(processSchedule, nextDelay);
    } else {
        gotoNextWebsite();
    }
}

function gotoNextWebsite() {
    clearTimeout(scheduleTimeout);
    var nextWebsite = scheduleList[0];
    scheduleList.splice(0, 2);
    sessionStorage.setItem("scheduleStorage", scheduleString());
    popupText("Moving to next website: " + nextWebsite);
    cleanRedirect(nextWebsite);
}

function cancelQueue() {
    clearTimeout(scheduleTimeout);
    stopInventoryChecking();
    killIframes();
    document.getElementById("TwitchScheduleOuterWrapper")?.remove();
    sessionStorage.removeItem("scheduleStorage");
    clearFarmingSessionState();
    sessionStorage.removeItem("farmingStallGameNames");
    scheduleList = [];
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
    if (string.startsWith("Debug:") && !debug) { return; }
    var current = new Date();
    var mins = ("0"+current.getMinutes()).slice(-2);
    var detailedString = string + " | " + current.getHours() + ":" + mins + ", v" + GM_info.script.version;
    var pastLogHistory = sessionStorage.getItem("ATQPermaLog") == null ? "" : sessionStorage.getItem("ATQPermaLog") + " /// ";
    var currentLogHistory = pastLogHistory + detailedString;
    sessionStorage.setItem("ATQPermaLog", currentLogHistory);
    removeConfirmPopup();
    var box = document.createElement("div");
    box.id = "userscriptPopupWindow";
    box.textContent = string;
    box.style.cssText = "position:fixed; top:16px; left:16px; z-index:999991; max-width:300px; padding:10px 14px; background-color:#333; color:#fff; border-radius:6px; font-size:13px; line-height:1.5; word-wrap:break-word; white-space:normal; cursor:pointer; transform:translateX(calc(-100% - 16px)); transition:transform 0.35s ease; box-sizing:border-box;";
    document.body.appendChild(box);
    console.log("[ATQLogs] " + string);
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
        existing.parentNode.removeChild(existing);
    }
}

// ----------------------------------
// AutoLiveWatcher.user.js Below
// ----------------------------------

// Saves where you start this script so you can jump back to it later
var resetToLocation = window.location.href;
var currentTargetLocation = resetToLocation;
// Set by /about, YouTube, and twitchCategoryWatcher as the second check for what is being watched
if (sessionStorage.getItem("storedCurrentTarget") != null) {
    currentTargetLocation = sessionStorage.getItem("storedCurrentTarget");
}

// Sets variable so drop clicker can refresh page after timeouts are done
var dropClickerChecks = 0;
// Checks if YouTube live stream has been clicked
var clickChecker = false;
// Toggle to enable category watching mode
var infoLoaded = false;
var viewerCountLoaded = false;
var tagCount = null;
// Sets up boolean and timers for YouTube and Twitch to be null so they can see if they exist or not
var timeoutCreated = false;
var noDropsReload = null;
var reloadStreams = null;
var firstViewing = null;
var noDropStreamsAvailable = null;
var loopingInterval = null;

popupText("ALWU: Auto Live Watcher Userscript Loaded");
removeConfirmPopup();

// Checks for the website you're currently on and runs the appropriate check
setTimeout(detectSite, 30000);

async function detectSite() {
    if (locationContains("youtube.com") && locationContains("/streams")) {
        popupText("ALWU: 1 - YouTube /streams detected");
        const elm = await waitForElm(".ytd-two-column-browse-results-renderer");
        createLoopingInterval(youTubeMethod, 1000);
    } else if (locationContains("twitch.tv")) {
        if (locationContains("drops/inventory")) {
            // Self contained loop, leads back to itself
            popupText("ALWU: 2 - Twitch drops/inventory detected");
            const elm = await waitForElm(".inventory-page");

            dropClicker();

            createLoopingInterval(dropClicker, 60000);
        } else if (locationContains("/about")) {
            // Loop leads to 6 then back if disruption is found
            popupText("ALWU: 3 - Twitch /about detected");

            // twitchAboutLocation lets the script go into the main disruption checking loop
            // storedCurrentTarget is used inside that disruption checking loop to check if the page changed
            sessionStorage.setItem("twitchAboutLocation", window.location.href);
            sessionStorage.setItem("storedCurrentTarget", window.location.href.replace("/about", ""));
            sessionStorage.removeItem("twitchWatchedCategory");

            setTimeout(resetLocation, 180000);
            createLoopingInterval(twitchAboutMethod, 1000);
        } else if (locationContains("?filter=drops&sort=VIEWER_COUNT")) {
            // Loop leads to 5 then back if disruption is found
            popupText("ALWU: 4 - Twitch Category Watcher detected");
            const elm = await waitForElm(".directory-header-new__info");

            sessionStorage.removeItem("twitchAboutLocation");

            createLoopingInterval(twitchCategoryWatcher, 1000);
        } else if (sessionStorage.getItem("twitchWatchedCategory") != null) {
            // Loop continuation from 4
            popupText("ALWU: 5 - Continuing from Twitch Category Watcher");

            resetToLocation = sessionStorage.getItem("twitchWatchedCategory");

            setTimeout(resetLocation, 3600000);
            createLoopingInterval(twitchCategoryChannelWatcher, 1000);
        } else if (sessionStorage.getItem("twitchAboutLocation") != null) {
            // Loop continuation from 3
            popupText("ALWU: 6 - Continuing from twitchAboutLocation");

            resetToLocation = sessionStorage.getItem("twitchAboutLocation");

            setTimeout(resetLocation, 3600000);
            createLoopingInterval(twitchCheckDisruptions, 1000);
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

    if (locationContains("/watch")) {
        if (reloadStreams != null) {
            popupText("YouTube: resetTimeout(reloadStreams);");
            reloadStreams = resetTimeout(reloadStreams);
        }
        clickChecker = true;
        // Creates timer to reload stream if drops are not found
        if (timeoutCreated == false && noDropsReload == null) {
            popupText("YouTube: noDropsReload = setTimeout(resetLocation, 300000);");
            noDropsReload = resetTimeout(noDropsReload);
            noDropsReload = setTimeout(resetLocation, 300000);
            timeoutCreated = true;
        }
        // Checks for drops to be connected
        var connectedDrops = $("account-link-button-view-model:contains('Connected')");
        if (noDropsReload != null && connectedDrops.length != 0) {
            popupText("YouTube: resetTimeout(noDropsReload);");
            noDropsReload = resetTimeout(noDropsReload);
        }
        if (sessionStorage.getItem("storedCurrentTarget") != window.location.href) {
            // Refreshes the page after a delay to stop watching VODs
            popupText("YouTube: firstViewing = setTimeout(resetLocation, 600000);");
            firstViewing = setTimeout(resetLocation, 600000);
            sessionStorage.setItem("storedCurrentTarget", window.location.href);
            currentTargetLocation = window.location.href;
        }
        if (streamEnd.length != 0) {
            // If the recommendation screen is showing, return to the stream list
            popupText("YouTube: streamEnd.length != 0");
            return resetLocation();
        } else if (liveStatus.length != 0) {
            // Click the live indicator when paused or behind
            liveStatus.click();
        } else if (pauseButton.length != 0) {
            // Unpauses the video and starts the video if it didn't autoplay
            pauseButton.click();
        }
    } else if (locationContains("/streams")) {
        resetToLocation = window.location.href;
        currentTargetLocation = sessionStorage.getItem("storedCurrentTarget");
        timeoutCreated = false;
        if (reloadStreams == null) {
            // Set up timer to reload for the button to show up or if the button fails to click the first time around
            popupText("YouTube: reloadStreams = setTimeout(resetLocation, 300000);");
            reloadStreams = resetTimeout(reloadStreams);
            reloadStreams = setTimeout(resetLocation, 300000);
        }
        if (liveButton.length != 0) {
            // Click button if it exists on the stream page
            liveButton[0].click();
        }
    }

    if (window.location.href != currentTargetLocation && window.location.href != resetToLocation && clickChecker == true) {
        // Return to stream if you move away
        popupText("YouTube: window.location.href != currentTargetLocation && window.location.href != resetToLocation && clickChecker == true");
        return resetLocation();
    }
}

function twitchAboutMethod() {
    var aboutPage = sessionStorage.getItem("twitchAboutLocation");

    var liveIcon = $('.channel-status-info--live [class^="CoreText"]');
    if (typeof liveIcon != "undefined" && liveIcon.text().includes("Live")) {
        resetToLocation = aboutPage.replace("/about", "");
        popupText("Twitch: Stream is live, going to stream");
        return resetLocation();
    }
}

function twitchCheckDisruptions() {
    var offlineText = $('.channel-root__player--offline .home-offline-hero .tw-title:contains("Check out")');
    var followPanelOverlay = $(".follow-panel-overlay:contains('Follow and get notified when')");
    var currentlyLive = $('.home-carousel-info--live .channel-status-info--live:contains("Live Now")');
    var pauseButton = $('[data-a-target="player-play-pause-button"]');
    var matureAcceptanceButton = $('[data-a-target="player-overlay-mature-accept"]');
    var contentWarningButton = $('[data-a-target="content-classification-gate-overlay-start-watching-button"]');
    var reloadPlayerButton = $("div[data-a-target='tw-core-button-label-text']:contains('Reload Player')");
    //var raidPopup = $("[data-test-selector='raid-banner']");
    var viewerCount = $('[data-a-target="animated-channel-viewers-count"]');

    var startingChannelAboutRemover = resetToLocation.replace("/about", "");

    if(viewerCountLoaded == false && !(typeof viewerCount == "undefined" || viewerCount.length == 0)) {
        viewerCountLoaded = true;
    }

    if (typeof offlineText != "undefined" && offlineText.length > 0) {
        // If not live, go back to the about page
        popupText("Twitch: typeof offlineText != 'undefined'");
        return resetLocation();
    } else if (typeof followPanelOverlay != "undefined" && followPanelOverlay.length > 0) {
        popupText("Twitch: Offline stream, follow panel overlay found");
        return resetLocation();
    } else if (typeof matureAcceptanceButton[0] != "undefined") {
        // Clicks the mature acceptance button
        matureAcceptanceButton[0].click();
    } else if (typeof contentWarningButton[0] != "undefined") {
        // Clicks the content warning start watching button
        contentWarningButton[0].click();
    } else if (typeof reloadPlayerButton[0] != "undefined") {
        // Reloads the player if it gets bugged
        reloadPlayerButton[0].click();
    } else if (typeof pauseButton[0] != "undefined" && pauseButton.attr("data-a-player-state") == "paused") {
        // Unpauses the video
        pauseButton[0].click();
    } /*else if (raidPopup.length > 0) {
        // If there's a raid popup on stream, return to live
        popupText("Twitch: raidPopup.length > 0");
        return resetLocation();
    } */else if (viewerCountLoaded == true && (typeof viewerCount == "undefined" || viewerCount.length == 0)) {
        popupText("Twitch: Viewer Counter Disappeared");
        return resetLocation();
    } else if(typeof currentlyLive[0] != "undefined" && currentlyLive.length > 0) {
        // This check should only trigger from the /about page
        popupText("Twitch: Stream live but wrong live page");
        resetToLocation = currentTargetLocation;
        return resetLocation();
    } else if (
        !locationContains(startingChannelAboutRemover) && 
        !locationContains(currentTargetLocation)) {
        popupText("Twitch: Moved away from stream page");
        return resetLocation();
    }
}

function twitchCategoryWatcher() {
    // Go through live streams with drops and click the first one available
    resetToLocation = window.location.href;
    sessionStorage.setItem("twitchWatchedCategory", resetToLocation);
    var liveStreamList = $(".preview-card-image-link");

    if (liveStreamList.length == 0 && noDropStreamsAvailable == null) {
        popupText("Twitch: noDropStreamsAvailable = setTimeout(resetLocation, 300000);");
        noDropStreamsAvailable = setTimeout(resetLocation, 300000);
    } else if (liveStreamList.length != 0) {
        if (noDropStreamsAvailable != null) {
            popupText("Twitch: resetTimeout(noDropStreamsAvailable);");
            noDropStreamsAvailable = resetTimeout(noDropStreamsAvailable);
        }
        for (var i = 0; i < liveStreamList.length; i++) {
            if (typeof liveStreamList[i] != "undefined") {
                // twitchCheckDisruptions uses storedCurrentTarget here to check for leaving the target stream after refresh 
                currentTargetLocation = "https://www.twitch.tv" + liveStreamList.eq(i).attr("href");
                sessionStorage.setItem("storedCurrentTarget", currentTargetLocation);
                resetToLocation = currentTargetLocation;
                popupText("Twitch: Found stream with drops, going to stream");
                return resetLocation();
            }
        }
    }
}

function twitchCategoryChannelWatcher() {
    // If script is watching a category, check for the right game; if not present, return to stream list
    var currentGame = resetToLocation.replace("https://www.twitch.tv/","").replace("?filter=drops&sort=VIEWER_COUNT","");
    currentGame = $("[href*='"+currentGame+"']").prop("href") + "?filter=drops&sort=VIEWER_COUNT";
    var currentTagCount = $('[aria-label^="Tag"]').length;

    if (currentGame != "undefined?filter=drops&sort=VIEWER_COUNT" && infoLoaded == false) {
        // Checks for the drops enabled tag to be loaded in the first place
        infoLoaded = true;
    } else if (infoLoaded == true) {
        if (tagCount == null) {
            tagCount = currentTagCount;
        } else if (tagCount != currentTagCount) {
            // If the amount of tags change, maybe it's a channel with no more drops, so return to the drops list
            popupText("Twitch: tagCount != currentTagCount");
            return resetLocation();
        } else if (currentGame != resetToLocation) {
            // If the current game is not the game you started with, go back to the game list
            popupText("Twitch: currentGame != resetToLocation");
            return resetLocation();
        }
    }

    twitchCheckDisruptions();
}

function dropClicker() {
    // Clicks every claim now button
    $("[data-a-target='tw-core-button-label-text']:contains('Claim Now')").each(
        function () {
            $(this).click();
        }
    );

    if (dropClickerChecks >= 3) {
        // Refresh after the timeout goes through and after clicking all the drop claims
        popupText("Twitch: dropClickerChecks >= 3");
        return resetLocation();
    } else {
        dropClickerChecks++;
    }
}

function createLoopingInterval(method, timer) {
    // Attempts to stop multiple loops from existing at once
    if (loopingInterval == null) {
        loopingInterval = setInterval(method, timer);
    }
}

function resetTimeout(timer) {
    // Clears a timer, returns null for that timer to be reset to null
    clearTimeout(timer);
    return null;
}

function resetInterval(timer) {
    // Clears an interval, returns null for that interval to be reset to null
    clearInterval(timer);
    return null;
}

function resetAllTimers() {
    // Resets all timers to stop any timeouts from triggering or lingering
    resetTimeout(noDropsReload);
    resetTimeout(reloadStreams);
    resetTimeout(firstViewing);
    resetTimeout(noDropStreamsAvailable);
    resetInterval(loopingInterval);
}

function resetLocation() {
    cleanRedirect(resetToLocation);
    return undefined;
}

function cleanRedirect(goalurl) {
    resetAllTimers();
    window.location.assign(goalurl);
}

function locationContains(string) {
    return window.location.toString().indexOf(string) != -1;
}

function waitForElm(selector) {
    popupText("ALWU: awaiting " + selector);
    return new Promise(resolve => {
        if (document.querySelector(selector)) {
            popupText("ALWU: await complete " + selector);
            return resolve(document.querySelector(selector));
        }

        const observer = new MutationObserver(mutations => {
            if (document.querySelector(selector)) {
                popupText("ALWU: await complete " + selector);
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

GM_registerMenuCommand("Watch Category", () => {
    // Only watches streams with drops enabled
    var dropsEnabledURL = window.location.href;
    if (dropsEnabledURL.indexOf("?") != -1) {
        dropsEnabledURL = dropsEnabledURL.substring(0, dropsEnabledURL.indexOf("?"));
    }
    dropsEnabledURL = dropsEnabledURL + "?filter=drops&sort=VIEWER_COUNT";

    // Immediately refresh page to get script running
    cleanRedirect(dropsEnabledURL);
});

