// ==UserScript==
// @name         Auto Twitch Queuer
// @namespace    https://github.com/
// @version      3.3.0
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

// Menu registration runs first so nothing below can stop the menu from appearing
GM_registerMenuCommand("Open Schedule", grabSchedule);
GM_registerMenuCommand("Next In Queue", nextinQueue);
GM_registerMenuCommand("Cancel Schedule", cancelQueue);
GM_registerMenuCommand("Auto Farm Campaigns", autoFarmCampaignsToggle);
GM_registerMenuCommand("Campaign Manager", openCampaignManager);
GM_registerMenuCommand("Progress Manager", openProgressManager);

// Only gates whether "Debug:" lines are shown; debug actions are in the Progress Manager
var debug = false;
try {
    debug = GM_getValue('debugLogging', false);
} catch (e) {
    console.error("[ATQ] Could not read debugLogging", e);
}

function setDebugLogging(on) {
    debug = !!on;
    try { GM_setValue('debugLogging', debug); } catch (e) { console.error("[ATQ] Could not save debugLogging", e); }
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
// Detects a player that mounted but never plays, since drops only accrue while it plays
var playbackWatchdogTimer = null;
var playbackLastTime = null;
var playbackLastAdvanceAt = 0;
var playbackRecoveryStep = 0;
var playbackWatchdogStartedAt = 0;
// Sampling has to be frequent enough to tell a brief buffer apart from a real freeze
var PLAYBACK_TICK_MS = 15000;
var PLAYBACK_GRACE_MS = 30000;
var iframeHost = null;
var progressPanelTimer = null;
var progressPanelRAF = null;
var launcherPollTimer = null;
var campaignsPageInventory = null;
// Started as soon as the campaigns page renders so the inventory loads while rows expand
var campaignsInventoryPromise = null;
var campaignsWatchdogTimer = null;
var campaignsRetryPending = false;

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

// Cosmetic, so it swallows its own errors and can't block the auto-farm resume below
try {
    if (document.body) {
        createProgressLauncher();
    } else {
        document.addEventListener('DOMContentLoaded', function() {
            try { createProgressLauncher(); } catch (e) { console.error("[ATQ] launcher failed", e); }
        });
    }
} catch (e) {
    console.error("[ATQ] launcher failed", e);
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

// One host for both iframes, never reparented, since moving an iframe reloads it
function getIframeHost() {
    if (iframeHost && iframeHost.parentNode) return iframeHost;
    injectAtqStyles();
    iframeHost = document.createElement('div');
    iframeHost.id = 'ATQIframeHost';
    iframeHost.className = 'atq-iframe-host atq-host-stashed';
    document.body.appendChild(iframeHost);
    return iframeHost;
}

function createHiddenIframe(src) {
    var f = document.createElement('iframe');
    f.className = 'atq-frame';
    f.src = src;
    getIframeHost().appendChild(f);
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

// A fresh frame is already navigating, so src is only reassigned on reuse
function navigateIframe(frame, src) {
    if (frame.atqFresh) { frame.atqFresh = false; return; }
    frame.src = src;
}

function getInventoryIframe() {
    if (!inventoryIframe || !inventoryIframe.parentNode) {
        inventoryIframe = createHiddenIframe('https://www.twitch.tv/drops/inventory');
        inventoryIframe.atqFresh = true;
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
        campaignsIframe.atqFresh = true;
        popupText("Debug: Created campaignsIframe");
    } else {
        popupText("Debug: Reusing campaignsIframe");
    }
    scheduleIframeKill();
    return campaignsIframe;
}

// onDone(failures): rows whose details never rendered, e.g. in a hidden tab
function expandRowsSequentially(rowsToExpand, onDone, failures) {
    failures = failures || 0;
    if (rowsToExpand.length === 0) { onDone(failures); return; }
    var r = rowsToExpand[0];
    var rest = rowsToExpand.slice(1);
    if (r.querySelector('.drop-details__label')) {
        expandRowsSequentially(rest, onDone, failures);
        return;
    }
    expandRowAndWait(r, function(ok) { expandRowsSequentially(rest, onDone, failures + (ok ? 0 : 1)); });
}

// Expands one accordion and waits for its details; polls too, for background tabs. onDone(ok)
function expandRowAndWait(row, onDone) {
    var finished = false;
    var settleTimer = null;
    var capTimer = null;
    var startedAt = Date.now();
    function finish(ok) {
        if (finished) return;
        finished = true;
        clearTimeout(settleTimer);
        clearTimeout(capTimer);
        var p = row.querySelector('p');
        popupText("Debug: Row expand " + (ok ? "ok" : "TIMEOUT") + " in " + (Date.now() - startedAt) + "ms (" + (p ? p.textContent.trim() : "?") + ", " + document.visibilityState + ")");
        onDone(ok);
    }
    if (row.querySelector('.drop-details__label')) { finished = true; onDone(true); return; }
    try { row.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch(e) {}
    setTimeout(function() {
        var accordionBtn = row.querySelector('button[aria-expanded]');
        if (accordionBtn && accordionBtn.getAttribute('aria-expanded') !== 'true') {
            accordionBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        waitForCondition(row, function(fromMutation) {
            if (finished) return true;
            if (!row.querySelector('.drop-details__label')) return false;
            // Settle 500ms after the last mutation; poll ticks don't reset it or it never fires in background tabs
            if (settleTimer === null || fromMutation) {
                clearTimeout(settleTimer);
                settleTimer = setTimeout(function() { finish(true); }, 500);
            }
            // A row that keeps re-rendering would otherwise hold the settle open until the timeout
            if (capTimer === null) capTimer = setTimeout(function() { finish(true); }, 1500);
            return false;
        }, { timeoutMs: 10000, onTimeout: function() { finish(!!row.querySelector('.drop-details__label')); } });
    }, 100);
}

// Resolves true when a higher priority game has work, "unlisted" when the campaign being farmed has
// ended or is no longer listed under its game, and false otherwise
function checkForHigherPriorityCampaign() {
    return new Promise(function(resolve) {
        var farmingIdx = parseInt(sessionStorage.getItem("farmingGameIdx") || "-1");
        var currentGame = sessionStorage.getItem("farmingGameName");
        var currentCampaign = sessionStorage.getItem("farmingCampaignName");
        var currentKey = sessionStorage.getItem("farmingCampaignKey");
        var verifyCurrent = !!(currentGame && currentCampaign && currentGame !== "__fallback__");
        popupText("Debug: Priority check - farmingIdx=" + farmingIdx);
        if (farmingIdx <= 0 && !verifyCurrent) { popupText("Debug: farmingIdx<=0, skipping priority check"); resolve(false); return; }
        var list = getDropList();
        var higherPriorityGames = farmingIdx > 0 ? list.slice(0, farmingIdx) : [];
        var stalledGames = JSON.parse(sessionStorage.getItem("farmingStallGameNames") || "[]");
        var stalledCampaigns = JSON.parse(sessionStorage.getItem("farmingStallCampaigns") || "{}");
        var higherPriorityNames = higherPriorityGames.map(function(g) { return g.name; });
        popupText("Debug: Higher priority names: [" + higherPriorityNames.join(", ") + "] (stalled: [" + stalledGames.filter(function(g) { return higherPriorityNames.includes(g); }).join(", ") + "])");
        var myGen = iframeCheckGen;
        function aborted() { return myGen !== iframeCheckGen; }
        var iframe = getCampaignsIframe();
        var checkSettled = false;
        function done(result) {
            if (checkSettled) return;
            checkSettled = true;
            clearTimeout(timeout);
            clearTimeout(watchdog);
            killIframes();
            resolve(result);
        }
        function doCheck() {
            if (aborted()) { return; }
            try {
                var doc = iframe.contentDocument || iframe.contentWindow.document;
                if (!doc || !doc.body) { done(false); return; }
                sweepExpiredCampaigns();
                var tracker = getDropsTracker();
                var triggeringGame = null;

                var dropSearchRoot = findCampaignContainer(getOpenDropHeader(doc), doc) || doc;
                popupText("Debug: Priority check scope=" + (dropSearchRoot === doc ? "full page" : "open drop campaigns only"));

                function rowGameName(row) {
                    var pEl = row.querySelector('p');
                    return pEl ? pEl.textContent.trim() : null;
                }
                var allRewardRows = getRewardRows(doc);
                var allPriorityDropRows = Array.from(dropSearchRoot.children).filter(function(row) {
                    return higherPriorityNames.includes(rowGameName(row));
                });
                var allPriorityRewardRows = allRewardRows.filter(function(row) {
                    return higherPriorityNames.includes(rewardRowGameName(row));
                });
                if (debug) {
                    var allVisibleGames = Array.from(dropSearchRoot.children).map(rowGameName).filter(Boolean);
                    var rewardPriorityNames = [];
                    allRewardRows.forEach(function(row) {
                        var rewardGame = rewardRowGameName(row);
                        if (!rewardGame) return;
                        allVisibleGames.push(rewardGame + " (reward)");
                        if (higherPriorityNames.includes(rewardGame)) rewardPriorityNames.push(rewardGame + " (reward)");
                    });
                    popupText("Debug: Games visible in iframe (" + allVisibleGames.length + "): [" + allVisibleGames.join(", ") + "]");
                    var allPriorityLabels = allPriorityDropRows.filter(function(r) { return !r.querySelector('.drop-details__label'); })
                        .map(function(r) { return rowGameName(r) || '?'; }).concat(rewardPriorityNames);
                    popupText("Debug: Priority rows needing expansion (" + allPriorityLabels.length + "): [" + allPriorityLabels.join(", ") + "]");
                }

                function summarize(pageCampaigns, trackedCampaigns, trackedLabel, emptyText) {
                    if (pageCampaigns.length === 0) return emptyText;
                    return pageCampaigns.map(function(c) {
                        var t = findTracked(trackedCampaigns, c);
                        var state = t ? (t.completed ? " [done]" : " [" + trackedLabel + "]") : (trackedLabel === "stalled" ? " [NEW]" : " [untracked]");
                        return c.name + state + (isCampaignActive(c) ? "" : " [not live]");
                    }).join(", ");
                }

                // Drop and reward rows differ only in name source and parser
                function checkRowsSequentially(rows, rowIdx, getName, parse, kind, onDone) {
                    if (aborted()) { return; }
                    if (rowIdx >= rows.length) { onDone(false); return; }
                    var row = rows[rowIdx];
                    var gameName = getName(row);
                    if (!gameName) { checkRowsSequentially(rows, rowIdx + 1, getName, parse, kind, onDone); return; }
                    expandRowAndWait(row, function() {
                        if (aborted()) { return; }
                        var trackedCampaigns = tracker[gameName];
                        var pageCampaigns = parse(row, gameName);
                        // A stalled game only pulls us back for a live campaign other than the ones that stalled
                        if (stalledGames.includes(gameName)) {
                            var stalledNames = stalledCampaigns[gameName] || [];
                            var hasNew = pageCampaigns.some(function(c) {
                                if (!isCampaignActive(c) || stalledNames.indexOf(c.name) !== -1) return false;
                                var t = findTracked(trackedCampaigns, c);
                                return !t || !t.completed;
                            });
                            popupText("Debug: Checking stalled " + kind + gameName + " - " + summarize(pageCampaigns, trackedCampaigns, "stalled", "no campaigns read"));
                            if (hasNew) { triggeringGame = gameName; onDone(true); return; }
                        } else {
                            var hasWork = pageCampaignsHaveWork(trackedCampaigns, pageCampaigns);
                            popupText("Debug: Checking " + kind + gameName + " - " + summarize(pageCampaigns, trackedCampaigns, "pending", "not expanded"));
                            if (hasWork) { triggeringGame = gameName; onDone(true); return; }
                        }
                        checkRowsSequentially(rows, rowIdx + 1, getName, parse, kind, onDone);
                    });
                }

                function parseDropRow(row) { return parseCampaignsFromRow(row); }
                function parseRewardRow(row, gameName) { return [parseRewardCampaignFromRow({ name: gameName }, row)]; }

                // The campaign being farmed must still be listed under its game; nothing else notices
                // when it closes or was queued under the wrong game. Rows that never rendered prove
                // nothing, and a late-rendering second campaign gets two re-reads before giving up.
                function verifyCurrentCampaign(attempt, onDone) {
                    if (aborted()) { return; }
                    var root = findCampaignContainer(getOpenDropHeader(doc), doc);
                    var rows = (root ? Array.from(root.children) : []).filter(function(r) { return rowGameName(r) === currentGame; })
                        .map(function(r) { return { row: r, parse: parseDropRow }; })
                        .concat(getRewardRows(doc).filter(function(r) { return rewardRowGameName(r) === currentGame; })
                            .map(function(r) { return { row: r, parse: parseRewardRow }; }));
                    if (rows.length === 0 && !getOpenDropHeader(doc)) { onDone(true); return; }
                    var parsed = [];
                    var renderFailed = false;
                    (function next(i) {
                        if (aborted()) { return; }
                        if (i >= rows.length) {
                            var match = parsed.find(function(c) { return currentKey ? c.key === currentKey : c.name === currentCampaign; });
                            var state = match ? (isCampaignActive(match) ? "listed" : "ended") : renderFailed ? "unreadable" : "missing";
                            popupText("Debug: Current campaign check - " + currentCampaign + " under " + currentGame + ": " + state + " (attempt " + (attempt + 1) + ")");
                            if (state === "listed" || state === "unreadable") { onDone(true); return; }
                            if (state === "ended") { onDone(false, "has ended"); return; }
                            if (attempt < 2) { setTimeout(function() { verifyCurrentCampaign(attempt + 1, onDone); }, 2000); return; }
                            onDone(false, "is no longer listed under " + currentGame);
                            return;
                        }
                        expandRowAndWait(rows[i].row, function(ok) {
                            if (!ok) renderFailed = true;
                            rows[i].parse(rows[i].row, currentGame).forEach(function(c) { parsed.push(c); });
                            next(i + 1);
                        });
                    })(0);
                }

                function checkHigherPriority() {
                    checkRowsSequentially(allPriorityDropRows, 0, rowGameName, parseDropRow, "", function(dropFound) {
                        if (dropFound) {
                            popupText("Debug: Priority check result=true" + (triggeringGame ? " triggered by: " + triggeringGame : ""));
                            done(true);
                            return;
                        }
                        checkRowsSequentially(allPriorityRewardRows, 0, rewardRowGameName, parseRewardRow, "reward ", function(rewardFound) {
                            popupText("Debug: Priority check result=" + rewardFound + (triggeringGame ? " triggered by: " + triggeringGame : ""));
                            done(rewardFound);
                        });
                    });
                }

                if (!verifyCurrent) { checkHigherPriority(); return; }
                verifyCurrentCampaign(0, function(stillListed, reason) {
                    if (!stillListed) {
                        popupText(currentCampaign + " " + reason + ". Returning to campaigns");
                        done("unlisted");
                        return;
                    }
                    checkHigherPriority();
                });
            } catch(e) {
                done(false);
            }
        }
        var timeout = setTimeout(function() {
            done(false);
        }, 20000);
        // Never cleared by onload, so a stuck row walk can't pin the farming loop
        var watchdog = setTimeout(function() {
            if (aborted()) return;
            popupText("Debug: Priority check watchdog fired, treating as no higher priority");
            done(false);
        }, 300000);
        iframe.onload = function() {
            clearTimeout(timeout);
            var doc = null;
            try { doc = iframe.contentDocument || iframe.contentWindow.document; } catch(e) {}
            if (!doc || !doc.body) { doCheck(); return; }
            // Start as soon as the campaign list has rendered instead of after a fixed delay
            waitForCondition(doc.body, function() {
                if (aborted()) return true;
                var header = getOpenDropHeader(doc);
                if (!header) return false;
                var hasRows = !!findCampaignContainer(header, doc);
                if (!hasRows && !/no Drops campaigns available/i.test(doc.body.textContent)) return false;
                setTimeout(doCheck, 500);
                return true;
            }, { pollMs: 250, timeoutMs: 15000, onTimeout: doCheck });
        };
        navigateIframe(iframe, 'https://www.twitch.tv/drops/campaigns');
    });
}

// Progress bars are siblings of .inventory-campaign-info, so they're scoped to its parent
function readInventorySnapshot(doc) {
    var campaigns = [];
    doc.querySelectorAll('.inventory-campaign-info').forEach(function(info) {
        var nameLink = info.querySelector('a.tw-link');
        if (!nameLink) return;
        var endDate = null;
        var spans = info.querySelectorAll('span');
        for (var i = 0; i < spans.length - 1; i++) {
            if (spans[i].textContent.indexOf('End Date') !== -1) {
                endDate = spans[i + 1].textContent.trim();
                break;
            }
        }
        var drops = [];
        info.parentElement.querySelectorAll('[role="progressbar"]').forEach(function(bar) {
            // Walk out to the drop tile so the bar can be paired with its reward name
            var tile = bar;
            while (tile && !tile.querySelector('img.inventory-drop-image')) tile = tile.parentElement;
            var texts = [];
            if (tile) {
                tile.querySelectorAll('p').forEach(function(p) {
                    var t = p.textContent.trim();
                    if (t) texts.push(t);
                });
            }
            var requirement = null;
            var dropName = null;
            texts.forEach(function(t) {
                if (/%\s*of\s/.test(t)) { if (!requirement) requirement = t; }
                else if (!dropName) { dropName = t; }
            });
            drops.push({
                name: dropName || 'Unnamed drop',
                percent: bar.getAttribute('aria-valuenow'),
                requirement: requirement
            });
        });
        campaigns.push({
            name: nameLink.textContent.trim(),
            endDate: endDate,
            drops: drops
        });
    });
    return campaigns;
}

// Claimed tiles are found by position between the section headings; only the first page is read
function readClaimedAndRewards(doc) {
    var headings = Array.from(doc.querySelectorAll('h4,h5'));
    var claimedHeading = headings.find(function(h) { return h.textContent.trim() === 'Claimed'; });
    var rewardsHeading = headings.find(function(h) { return h.textContent.trim() === 'Rewards'; });
    function follows(a, b) { return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); }
    var claimed = [];
    if (claimedHeading) {
        doc.querySelectorAll('img.inventory-drop-image').forEach(function(img) {
            if (!follows(claimedHeading, img)) return;
            if (rewardsHeading && !follows(img, rewardsHeading)) return;
            var tile = img;
            while (tile && tile.querySelectorAll('p').length < 2) tile = tile.parentElement;
            var texts = tile ? Array.from(tile.querySelectorAll('p')).map(function(p) { return p.textContent.trim(); }).filter(Boolean) : [];
            var name = (img.alt || '').replace(/^Drop image for\s+/i, '').trim() || texts[texts.length - 1];
            if (!name) return;
            var ageDays = null;
            for (var i = 0; i < texts.length && ageDays === null; i++) ageDays = parseClaimAgeDays(texts[i]);
            claimed.push({ name: name, ageDays: ageDays });
        });
    }
    var rewards = [];
    doc.querySelectorAll('.reward_tile').forEach(function(tile) {
        var p = tile.querySelector('p');
        var img = tile.querySelector('img');
        var name = (p && p.textContent.trim()) || (img ? (img.alt || '').replace(/^Reward image for\s+/i, '').trim() : '');
        if (name) rewards.push(name);
    });
    return { claimed: claimed, rewards: rewards };
}

// Claimed tiles only carry a relative time ("yesterday", "4 days ago"), so this is coarse by design
function parseClaimAgeDays(text) {
    var t = text.toLowerCase().trim();
    if (/^(today|just now|\d+\s+(second|minute|hour)s?\s+ago|an?\s+(minute|hour)\s+ago)$/.test(t)) return 0;
    if (t === 'yesterday') return 1;
    var m = t.match(/^(\d+)\s+(day|week|month|year)s?\s+ago$/);
    if (m) return parseInt(m[1]) * { day: 1, week: 7, month: 30, year: 365 }[m[2]];
    m = t.match(/^(last|a|an)\s+(week|month|year)(\s+ago)?$/);
    if (m) return { week: 7, month: 30, year: 365 }[m[2]];
    return null;
}

// Farming only sees the inventory in the iframe, so earned drops are claimed here
function claimEarnedDrops(doc) {
    var buttons = [];
    doc.querySelectorAll('[data-a-target="tw-core-button-label-text"]').forEach(function(label) {
        if (label.textContent.trim() !== 'Claim Now') return;
        var btn = label.closest('button');
        if (btn && buttons.indexOf(btn) === -1) buttons.push(btn);
    });
    buttons.forEach(function(btn) { btn.click(); });
    if (buttons.length > 0) popupText("Claimed " + buttons.length + " drop(s)");
    return buttons.length;
}

// Reads /drops/inventory in the iframe. ok:false means the read failed, not that a campaign did
function loadInventoryPage() {
    return new Promise(function(resolve) {
        var myGen = iframeCheckGen;
        function aborted() { return myGen !== iframeCheckGen; }
        var iframe = getInventoryIframe();
        var startedAt = Date.now();
        var settled = false;
        function done(result) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            popupText("Debug: Inventory read " + (result.ok ? "ok" : "FAILED") + " in " + (Date.now() - startedAt) + "ms (" + document.visibilityState + ")");
            // Once another check has taken over the iframe it is no longer ours to remove
            if (!aborted()) killIframes();
            resolve(result);
        }
        var failed = { ok: false, campaigns: [], claimed: [], rewards: [] };
        // Section headings always render, unlike Claimed tiles on an empty account
        function isInventoryLoaded(doc) {
            return !!doc.querySelector('.inventory-page') &&
                Array.from(doc.querySelectorAll('h3,h4,h5')).some(function(h) {
                    var t = h.textContent.trim();
                    return t === 'Drops' || t === 'Claimed';
                });
        }
        function doCheck() {
            if (settled) return;
            // Another check took over the iframe; still settle so no caller is left waiting
            if (aborted()) { done(failed); return; }
            try {
                var doc = iframe.contentDocument || iframe.contentWindow.document;
                if (!doc || !doc.body) { done(failed); return; }
                claimEarnedDrops(doc);
                var pageLoaded = isInventoryLoaded(doc);
                var campaigns = readInventorySnapshot(doc);
                if (!pageLoaded && campaigns.length === 0) { done(failed); return; }
                var extra = readClaimedAndRewards(doc);
                saveInventorySnapshot(campaigns, extra.claimed, extra.rewards);
                done({ ok: true, campaigns: campaigns, claimed: extra.claimed, rewards: extra.rewards });
            } catch(e) {
                done(failed);
            }
        }
        // Covers the iframe never loading at all; the readiness wait below has its own bound
        var timeout = setTimeout(function() { done(failed); }, 20000);
        iframe.onload = function() {
            clearTimeout(timeout);
            var doc = null;
            try { doc = iframe.contentDocument || iframe.contentWindow.document; } catch(e) {}
            if (!doc || !doc.body) { doCheck(); return; }
            // In Progress tiles can trail the headings, so allow a short settle
            waitForCondition(doc.body, function() {
                if (settled) return true;
                if (aborted()) { doCheck(); return true; }
                if (!isInventoryLoaded(doc)) return false;
                setTimeout(doCheck, 750);
                return true;
            }, { pollMs: 250, timeoutMs: 15000, onTimeout: doCheck });
        };
        navigateIframe(iframe, 'https://www.twitch.tv/drops/inventory');
    });
}

// Campaign finished: every In Progress bar at 100%, or every watch drop under Claimed/Rewards (claimed after the campaign started)
function applyInventoryToTracker(inv) {
    if (!inv || !inv.ok) return [];
    var tracker = getDropsTracker();
    var completed = [];
    var changed = false;
    Object.keys(tracker).forEach(function(gameName) {
        if (!Array.isArray(tracker[gameName])) return;
        tracker[gameName].forEach(function(c) {
            if (c.completed) return;
            // Non-watch drops (e.g. sub drops) don't hold a campaign open
            var nonWatch = Array.isArray(c.nonWatchDrops) ? c.nonWatchDrops : [];
            function isWatchDrop(n) { return nonWatch.indexOf(n) === -1; }
            var live = inv.campaigns.find(function(ic) { return ic.name === c.name && sameEndDate(ic.endDate, c.endDate); });
            if (live) {
                var liveDrops = live.drops.filter(function(d) { return isWatchDrop(d.name); });
                var liveNames = liveDrops.map(function(d) { return d.name; }).filter(function(n) { return n && n !== 'Unnamed drop'; });
                var merged = mergeDropNames(c.drops, liveNames);
                if (merged.length !== (c.drops || []).length) { c.drops = merged; changed = true; }
                var allEarned = liveDrops.length > 0 && liveDrops.every(function(d) { return parseInt(d.percent) >= 100; });
                if (allEarned) { c.completed = true; completed.push(gameName + " / " + c.name); changed = true; }
                return;
            }
            var watchDrops = Array.isArray(c.drops) ? c.drops.filter(isWatchDrop) : [];
            if (watchDrops.length === 0) return;
            var earliestClaimMs = c.startMs ? c.startMs - 2 * 24 * 60 * 60 * 1000 : null;
            var allClaimed = watchDrops.every(function(dropName) {
                if (inv.rewards.indexOf(dropName) !== -1) return true;
                // Claimed tiles carry only the reward name, so a name shared with another campaign
                // running in the same period can't say which campaign it was claimed from
                if (dropNameShared(tracker, c, dropName, earliestClaimMs)) return false;
                return inv.claimed.some(function(cl) {
                    if (cl.name !== dropName) return false;
                    if (cl.ageDays === null || earliestClaimMs === null) return true;
                    return Date.now() - cl.ageDays * 24 * 60 * 60 * 1000 >= earliestClaimMs;
                });
            });
            if (allClaimed) { c.completed = true; completed.push(gameName + " / " + c.name); changed = true; }
        });
    });
    if (changed) setDropsTracker(tracker);
    if (completed.length > 0) popupText("Already claimed, marked completed: " + completed.join(", "));
    return completed;
}

// Inventory end dates and campaigns page end dates are the same text; differing parses mean a different run
function sameEndDate(a, b) {
    if (!a || !b) return true;
    var am = parseEndDateToMs(a), bm = parseEndDateToMs(b);
    if (am === Infinity || bm === Infinity) return true;
    return Math.abs(am - bm) < 2 * 60000;
}

// True when another tracked campaign with a time window overlapping this one awards the same name
function dropNameShared(tracker, campaign, dropName, sinceMs) {
    var from = sinceMs || 0;
    return Object.keys(tracker).some(function(gameName) {
        if (!Array.isArray(tracker[gameName])) return false;
        return tracker[gameName].some(function(o) {
            if (o === campaign) return false;
            var names = (o.drops || []).concat(o.nonWatchDrops || []);
            if (names.indexOf(dropName) === -1) return false;
            var oEnd = parseEndDateToMs(o.endDate);
            var oStart = o.startMs || 0;
            return (oEnd === Infinity || oEnd >= from) && oStart <= Date.now();
        });
    });
}

function mergeDropNames(existing, incoming) {
    var out = Array.isArray(existing) ? existing.slice() : [];
    (incoming || []).forEach(function(n) { if (n && out.indexOf(n) === -1) out.push(n); });
    return out;
}

function saveInventorySnapshot(campaigns, claimed, rewards) {
    GM_setValue('dropProgressSnapshot', {
        takenAt: Date.now(),
        campaigns: campaigns,
        claimed: claimed || [],
        rewards: rewards || []
    });
}

function getInventorySnapshot() {
    var s = GM_getValue('dropProgressSnapshot', null);
    if (!s || typeof s !== 'object' || !Array.isArray(s.campaigns)) return null;
    return s;
}

// Fingerprint of this campaign's bars only
function campaignProgressFingerprint(liveCampaign) {
    var values = liveCampaign.drops.map(function(d) { return d.percent; })
        .filter(function(v) { return v !== null && v !== undefined; });
    return values.length > 0 ? values.join(",") : null;
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

// Names recur across runs (weekly creator campaigns, new esports seasons), so a campaign is identified
// by its name, time window and rewards
function campaignKey(c) {
    var rewards = mergeDropNames(c.drops, c.nonWatchDrops).slice().sort();
    return [c.name, c.startMs || "", c.endDate || "", rewards.join("+")].join("|");
}

// Keyed entries match by key. Entries saved before keys existed match by name, unless their start
// time says they are an earlier run.
function sameCampaign(t, c) {
    if (t.key && c.key) return t.key === c.key;
    if (t.name !== c.name) return false;
    if (t.startMs && c.startMs && t.startMs !== c.startMs) return false;
    return sameEndDate(t.endDate, c.endDate);
}

function findTracked(list, c) {
    return Array.isArray(list) ? list.find(function(t) { return sameCampaign(t, c); }) : undefined;
}

// Started and not yet ended
function isCampaignActive(c) {
    if (c.startMs && c.startMs > Date.now()) return false;
    return calculateTimeRemaining(c.endDate) > 0;
}

// The campaign being farmed: by its key when the session has one, else by name, preferring an unfinished entry
function getFarmedCampaign(gameName, campaignName) {
    var list = getDropsTracker()[gameName];
    if (!Array.isArray(list)) return undefined;
    var key = sessionStorage.getItem("farmingCampaignKey");
    if (key) {
        var byKey = list.find(function(t) { return t.key === key; });
        if (byKey) return byKey;
    }
    return list.find(function(t) { return t.name === campaignName && !t.completed; })
        || list.find(function(t) { return t.name === campaignName; });
}

// extra: drop names, start time and key, used by the completion check
function addCampaignToTracker(gameName, campaignName, endDate, extra) {
    extra = extra || {};
    var tracker = getDropsTracker();
    if (!tracker[gameName]) {
        tracker[gameName] = [];
    }
    var existing = findTracked(tracker[gameName], { name: campaignName, key: extra.key, startMs: extra.startMs });
    if (!existing) {
        existing = {
            name: campaignName,
            endDate: endDate,
            completed: false,
            addedAt: Date.now()
        };
        tracker[gameName].push(existing);
    } else {
        existing.endDate = endDate;
        if (!existing.addedAt) existing.addedAt = Date.now();
    }
    if (extra.key && !existing.key) existing.key = extra.key;
    if (extra.drops && extra.drops.length > 0) existing.drops = mergeDropNames(existing.drops, extra.drops);
    if (extra.nonWatchDrops && extra.nonWatchDrops.length > 0) {
        existing.nonWatchDrops = mergeDropNames(existing.nonWatchDrops, extra.nonWatchDrops);
        // Entries recorded before drops were classified may still list the non-watch ones
        if (Array.isArray(existing.drops)) {
            existing.drops = existing.drops.filter(function(n) { return existing.nonWatchDrops.indexOf(n) === -1; });
        }
    }
    if (extra.startMs && extra.startMs !== Infinity) existing.startMs = extra.startMs;
    // Reward campaigns never appear In Progress on the inventory page
    if (extra.reward) existing.reward = true;
    setDropsTracker(tracker);
}

function markCampaignCompleted(gameName, pageCampaign, completed) {
    var tracker = getDropsTracker();
    if (tracker[gameName]) {
        var campaign = findTracked(tracker[gameName], pageCampaign);
        if (campaign) {
            campaign.completed = completed;
            setDropsTracker(tracker);
        }
    }
}

// Expired campaigns leave the page and would stay uncompleted forever, so age them out
function sweepExpiredCampaigns() {
    var tracker = getDropsTracker();
    var swept = [];
    Object.keys(tracker).forEach(function(gameName) {
        if (!Array.isArray(tracker[gameName])) return;
        tracker[gameName].forEach(function(c) {
            if (c.completed) return;
            // Dates have no year, so very old entries are aged out by when they were added
            var stale = c.addedAt && (Date.now() - c.addedAt) > 120 * 24 * 60 * 60 * 1000;
            if (stale || calculateTimeRemaining(c.endDate) < -60) {
                c.completed = true;
                swept.push(gameName + " / " + c.name);
            }
        });
    });
    if (swept.length > 0) {
        setDropsTracker(tracker);
        popupText("Debug: Expired, marked completed: " + swept.join(", "));
    }
    return swept.length;
}

// Shared by the campaigns pass and the priority check; only live campaigns on the page count
function pageCampaignsHaveWork(trackedCampaigns, pageCampaigns) {
    return pageCampaigns.some(function(c) {
        if (!isCampaignActive(c)) return false;
        var t = findTracked(trackedCampaigns, c);
        return !t || !t.completed;
    });
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
                var block = findDropCampaignBlock([row], campaignName);
                var classified = block ? classifyCampaignDrops(block) : { watch: [], other: [] };
                var parsed = {
                    name: campaignName, endDate: endDate, endDateRaw: endDateRaw,
                    drops: classified.watch,
                    nonWatchDrops: classified.other,
                    startMs: parseRangeStartMs(endDateRaw)
                };
                parsed.key = campaignKey(parsed);
                campaigns.push(parsed);
            }
        }
    });
    return campaigns;
}

// Nearest ancestor of the campaign name holding its How to Earn label
function findDropCampaignBlock(rows, campaignName) {
    for (var r = 0; r < rows.length; r++) {
        var nameEl = Array.from(rows[r].querySelectorAll('strong')).find(function(el) {
            return !el.closest('.drop-details__label') && el.textContent.trim() === campaignName;
        });
        if (!nameEl) continue;
        var el = nameEl.parentElement;
        while (el && el !== rows[r]) {
            var hasEarnLabel = Array.from(el.querySelectorAll('.drop-details__label'))
                .some(function(lbl) { return /how to earn/i.test(lbl.textContent); });
            if (hasEarnLabel) return el;
            el = el.parentElement;
        }
        return null;
    }
    return null;
}

function benefitNamesIn(el) {
    var names = [];
    el.querySelectorAll('.drop-benefit__image-container img').forEach(function(img) {
        if (img.alt && names.indexOf(img.alt) === -1) names.push(img.alt);
    });
    return names;
}

// Splits rewards into watch and non-watch, e.g. "Watch for 1 hour and claim the reward <span>Name</span>"
function classifyCampaignDrops(block) {
    var watch = [];
    var other = [];
    var earnLabel = Array.from(block.querySelectorAll('.drop-details__label'))
        .find(function(lbl) { return /how to earn/i.test(lbl.textContent); });
    var ul = earnLabel ? earnLabel.parentElement.querySelector('ul') : null;
    if (ul) {
        ul.querySelectorAll('li').forEach(function(li) {
            if (!/claim the reward/i.test(li.textContent)) return;
            var spans = li.querySelectorAll('span');
            var name = spans.length > 0 ? spans[spans.length - 1].textContent.trim() : '';
            if (!name) return;
            var list = /\bwatch\b/i.test(li.textContent) ? watch : other;
            if (list.indexOf(name) === -1) list.push(name);
        });
    }
    // Unknown layout: fall back to treating every reward as watch-earned
    if (watch.length === 0 && other.length === 0) watch = benefitNamesIn(block);
    return { watch: watch, other: other };
}

function parseRangeStartMs(rangeString) {
    if (!rangeString || rangeString.indexOf(' - ') === -1) return null;
    var ms = parseEndDateToMs(rangeString.split(' - ')[0].trim());
    if (ms === Infinity) return null;
    // Undo parseEndDateToMs's next-year roll for long-running campaigns
    if (ms > Date.now() + 30 * 24 * 60 * 60 * 1000) ms = new Date(ms).setFullYear(new Date(ms).getFullYear() - 1);
    return ms;
}

function findRewardDateEl(row) {
    // Match the date leaf by its "<start> - <end>" shape, since class names churn
    var candidates = row.querySelectorAll('div,p');
    for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (el.children.length > 0) continue;
        var t = el.textContent.trim();
        if (t.indexOf(' - ') !== -1 && /\d{1,2}:\d{2}\s*(AM|PM)/i.test(t)) return el;
    }
    return null;
}

function parseRewardCampaignFromRow(game, row) {
    // A reward accordion is one campaign, named after its first reward
    var dateEl = findRewardDateEl(row);
    var endDateRaw = dateEl ? dateEl.textContent.trim() : null;
    var endDate = endDateRaw ? parseEndDateFromRange(endDateRaw) : null;
    var rewardNames = benefitNamesIn(row);
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
    var parsed = { name: name, endDate: endDate, endDateRaw: endDateRaw, rewardRow: row,
        drops: rewardNames, startMs: parseRangeStartMs(endDateRaw), reward: true };
    parsed.key = campaignKey(parsed);
    return parsed;
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

function injectAtqStyles() {
    if (document.getElementById('atq-cm-style')) return;
    var style = document.createElement('style');
    style.id = 'atq-cm-style';
    style.textContent = `
            #CampaignManagerWrapper, #CampaignManagerWrapper *, #ProgressManagerWrapper, #ProgressManagerWrapper * { box-sizing: border-box; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
            #CampaignManagerWrapper { position:fixed; width:60rem; max-height:calc(100vh - 3rem); left:50%; top:50%; transform:translate(-50%,-50%); z-index:99999; display:flex; flex-direction:column; background:#18181b; padding:16px; border-radius:10px; box-shadow:0 12px 48px rgba(0,0,0,0.8); color:#efeff1; }

            /* Progress Manager. Width AND height are both fixed so the panel never resizes
               when an iframe loads, unloads, or renders at a different intrinsic size. */
            #ProgressManagerWrapper { position:fixed; width:72rem; height:44rem; max-width:calc(100vw - 3rem); max-height:calc(100vh - 3rem); left:50%; top:50%; transform:translate(-50%,-50%); z-index:99999; display:flex; flex-direction:column; background:#18181b; padding:16px; border-radius:10px; box-shadow:0 12px 48px rgba(0,0,0,0.8); color:#efeff1; }
            #ProgressManagerWrapper .atq-content { min-height:0; }

            /* Launcher button: square with rounded corners, pinned top-left */
            #ATQProgressLauncher { position:fixed; top:16px; left:16px; z-index:999990; width:38px; height:38px; border-radius:9px; border:1px solid #3a3a4a; background:#18181b; color:#9147ff; font-size:18px; font-weight:700; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow:0 2px 10px rgba(0,0,0,0.6); transition:background 0.12s, color 0.12s, border-color 0.12s; padding:0; }
            #ATQProgressLauncher:hover { background:#2a2a35; color:#efeff1; border-color:#9147ff; }

            /* Iframe host. Kept at a fixed size in both states so the pages inside always
               lay out identically, and stashed off-screen rather than display:none so that
               Twitch's virtualised towers keep rendering rows while hidden. */
            .atq-iframe-host { position:fixed; width:1000px; height:560px; z-index:99998; border-radius:6px; overflow:hidden; background:#0e0e10; }
            .atq-iframe-host.atq-host-stashed { left:-20000px !important; top:0 !important; visibility:hidden; pointer-events:none; }
            .atq-frame { position:absolute; left:0; top:0; width:100%; height:100%; border:0; background:#0e0e10; visibility:hidden; }
            .atq-frame.atq-frame-active { visibility:visible; }

            .atq-framepane { position:relative; flex:1; min-height:0; background:#0e0e10; border-radius:6px; border:1px solid #2a2a35; overflow:hidden; }
            .atq-framepane-msg { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; text-align:center; padding:1rem; color:#adadb8; font-size:0.92rem; }
            .atq-countdown { font-size:2rem; font-weight:700; color:#9147ff; font-variant-numeric:tabular-nums; letter-spacing:0.02em; }
            .atq-sub { font-size:0.82rem; color:#7a7a8c; }

            .atq-bar { position:relative; height:6px; border-radius:3px; background:#2a2a35; overflow:hidden; margin-top:5px; }
            .atq-bar-fill { position:absolute; left:0; top:0; height:100%; border-radius:3px; background:#9147ff; }
            .atq-bar-fill.done { background:#00b37e; }
            .atq-drop { display:block; background:#0e0e10; padding:7px 10px; border-radius:6px; border:1px solid transparent; }
            .atq-drop-top { display:flex; align-items:baseline; gap:8px; }
            .atq-drop-name { flex:1; font-size:0.92rem; color:#efeff1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .atq-drop-pct { font-size:0.88rem; font-weight:700; color:#9147ff; font-variant-numeric:tabular-nums; }
            .atq-drop-pct.done { color:#00b37e; }
            .atq-drop-req { font-size:0.78rem; color:#7a7a8c; }
            .atq-kv { display:flex; gap:10px; background:#0e0e10; padding:5px 10px; border-radius:5px; align-items:baseline; }
            .atq-kv-key { flex:0 0 17rem; font-size:0.8rem; color:#adadb8; font-family:ui-monospace,Consolas,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .atq-kv-val { flex:1; font-size:0.82rem; color:#efeff1; font-family:ui-monospace,Consolas,monospace; word-break:break-all; }
            .atq-kv-val.unset { color:#5a5a6e; font-style:italic; }
            .atq-log { background:#0e0e10; border:1px solid #2a2a35; border-radius:6px; padding:8px 10px; font-family:ui-monospace,Consolas,monospace; font-size:0.76rem; color:#adadb8; white-space:pre-wrap; word-break:break-word; line-height:1.5; }
            .atq-note { font-size:0.8rem; color:#7a7a8c; padding:2px 4px 8px; }

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
            /* scrollbar-width/color is the Firefox form; the ::-webkit- rules below are
               ignored there and cover Chromium instead. */
            .atq-content { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:3px; margin-bottom:8px; scrollbar-width:thin; scrollbar-color:#3a3a4a transparent; }
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

function atqBtn(text, onClick, cls) {
    var b = document.createElement('button');
    b.textContent = text;
    b.className = cls !== undefined ? cls : 'atq-btn';
    b.addEventListener('click', onClick);
    return b;
}

function atqLabel(text) {
    var s = document.createElement('span');
    s.className = 'atq-label';
    s.textContent = text;
    return s;
}

function openCampaignManager() {
    if(document.getElementById("CampaignManagerWrapper")) {
        document.getElementById("CampaignManagerWrapper").remove();
        return;
    }

    injectAtqStyles();

    function mkInput(type, value, extraCls) {
        var i = document.createElement('input');
        i.type = type;
        i.value = value;
        i.className = 'atq-input' + (extraCls ? ' ' + extraCls : '');
        return i;
    }

    var list = getDropList();
    var settings = getDropSettings();
    var fallbackChannels = (settings.fallbackChannels || []).slice();
    // localTracker is display only; save replays the edits onto a fresh tracker so farming writes aren't undone
    var localTracker = JSON.parse(JSON.stringify(getDropsTracker()));
    var trackerEdits = [];

    var outer = document.createElement('div');
    outer.id = 'CampaignManagerWrapper';

    var titlebar = document.createElement('div');
    titlebar.className = 'atq-titlebar';
    var titleEl = document.createElement('span');
    titleEl.className = 'atq-title';
    titleEl.textContent = 'Campaign Manager';
    titlebar.appendChild(titleEl);
    titlebar.appendChild(atqBtn('✕', function() { outer.remove(); }, 'atq-btn atq-btn-ghost'));
    outer.appendChild(titlebar);

    var checkInput = mkInput('number', settings.checkIntervalMinutes || 10, 'atq-input-num');
    var offlineCheckInput = mkInput('number', settings.offlineCheckMinutes || 1, 'atq-input-num');
    var fallbackMinInput = mkInput('number', settings.fallbackMinutes || 30, 'atq-input-num');
    var noProgressInput = mkInput('number', settings.noProgressCheckLimit || 2, 'atq-input-num');
    var playbackStallInput = mkInput('number', settings.playbackStallSeconds, 'atq-input-num');
    var playbackReloadInput = mkInput('number', settings.playbackReloadLimit, 'atq-input-num');

    var tabsDiv = document.createElement('div');
    tabsDiv.className = 'atq-tabs';
    var priorityTabBtn = atqBtn('Priority', function() { setTab('priority'); }, 'atq-tab');
    var fallbackTabBtn = atqBtn('Fallback', function() { setTab('fallback'); }, 'atq-tab');
    var trackerTabBtn = atqBtn('Tracker', function() { setTab('tracker'); }, 'atq-tab');
    var settingsTabBtn = atqBtn('Settings', function() { setTab('settings'); }, 'atq-tab');
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
            noProgressCheckLimit: parseInt(noProgressInput.value) || 2,
            playbackStallSeconds: parseInt(playbackStallInput.value) || 45,
            playbackReloadLimit: isNaN(parseInt(playbackReloadInput.value)) ? 2 : parseInt(playbackReloadInput.value)
        });
        var tracker = applyTrackerEdits(getDropsTracker(), trackerEdits);
        setDropsTracker(tracker);
        trackerEdits = [];
        localTracker = JSON.parse(JSON.stringify(tracker));
        if (trackerTabBtn.classList.contains('atq-active')) renderTracker();
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
            item.appendChild(atqBtn('▲', function() {
                if(idx === 0) return;
                var tmp = list[idx - 1]; list[idx - 1] = list[idx]; list[idx] = tmp;
                renderPriority();
            }, 'atq-btn atq-btn-icon'));
            item.appendChild(atqBtn('▼', function() {
                if(idx === list.length - 1) return;
                var tmp = list[idx + 1]; list[idx + 1] = list[idx]; list[idx] = tmp;
                renderPriority();
            }, 'atq-btn atq-btn-icon'));
            var lbl = document.createElement('span');
            lbl.className = 'atq-item-label';
            lbl.textContent = (idx + 1) + '. ' + game.name;
            item.appendChild(lbl);
            item.appendChild(atqBtn('✕', function() {
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
        addRow.appendChild(atqLabel('Add:'));
        addRow.appendChild(addInput);
        addRow.appendChild(atqBtn('Add', doAdd, 'atq-btn atq-btn-primary atq-btn-sm'));
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
            item.appendChild(atqBtn('▲', function() {
                if (idx === 0) return;
                var tmp = fallbackChannels[idx - 1]; fallbackChannels[idx - 1] = fallbackChannels[idx]; fallbackChannels[idx] = tmp;
                renderFallback();
            }, 'atq-btn atq-btn-icon'));
            item.appendChild(atqBtn('▼', function() {
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
            item.appendChild(atqBtn('✕', function() {
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
                item.appendChild(atqBtn(campaign.completed ? 'Unmark' : 'Mark Done', function() {
                    campaign.completed = !campaign.completed;
                    trackerEdits.push({ type: 'toggle', game: gameName, name: campaign.name, key: campaign.key, completed: campaign.completed });
                    popupText((campaign.completed ? 'Completed: ' : 'Unmarked: ') + campaign.name);
                    renderTracker();
                }, 'atq-btn atq-btn-sm'));
                item.appendChild(lbl);
                item.appendChild(atqBtn('✕', function() {
                    var name = campaign.name;
                    trackerEdits.push({ type: 'delete', game: gameName, name: name, key: campaign.key });
                    localTracker[gameName] = localTracker[gameName].filter(function(c) { return c !== campaign; });
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
            row.appendChild(atqLabel(labelText));
            row.appendChild(input);
            if (suffix) row.appendChild(atqLabel(suffix));
            contentArea.appendChild(row);
        }
        settingRow('Drop Check Minutes:', checkInput);
        settingRow('Offline Check Minutes:', offlineCheckInput);
        settingRow('Fallback Duration:', fallbackMinInput, 'min');
        settingRow('No Progress Check Limit:', noProgressInput, 'checks');
        settingRow('Playback Stall Seconds:', playbackStallInput, 'sec');
        settingRow('Playback Reload Limit:', playbackReloadInput, 'reloads');
    }

    function setTab(tab) {
        priorityTabBtn.classList.toggle('atq-active', tab === 'priority');
        fallbackTabBtn.classList.toggle('atq-active', tab === 'fallback');
        trackerTabBtn.classList.toggle('atq-active', tab === 'tracker');
        settingsTabBtn.classList.toggle('atq-active', tab === 'settings');
        footer.innerHTML = '';
        if (tab === 'priority') {
            renderPriority();
            footer.appendChild(atqBtn('Save Settings', saveSettings, 'atq-btn atq-btn-primary'));
        } else if (tab === 'fallback') {
            renderFallback();
            footer.appendChild(atqBtn('Save Settings', saveSettings, 'atq-btn atq-btn-primary'));
        } else if (tab === 'settings') {
            renderSettings();
            footer.appendChild(atqBtn('Save Settings', saveSettings, 'atq-btn atq-btn-primary'));
        } else {
            renderTracker();
            footer.appendChild(atqBtn('Save Settings', saveSettings, 'atq-btn atq-btn-primary'));
            footer.appendChild(atqBtn('Delete Expired', function() {
                var before = Object.values(localTracker).reduce(function(s, a) { return s + a.length; }, 0);
                trackerEdits.push({ type: 'deleteExpired' });
                Object.keys(localTracker).forEach(function(gn) {
                    localTracker[gn] = localTracker[gn].filter(function(c) { return calculateTimeRemaining(c.endDate) >= -60; });
                    if (localTracker[gn].length === 0) delete localTracker[gn];
                });
                var after = Object.values(localTracker).reduce(function(s, a) { return s + a.length; }, 0);
                var n = before - after;
                renderTracker();
                popupText(n > 0 ? 'Deleted ' + n + ' expired campaign' + (n !== 1 ? 's' : '') + '.' : 'No expired campaigns to delete');
            }, 'atq-btn atq-btn-sm'));
            footer.appendChild(atqBtn('Delete All', function() {
                if (confirm('Delete all tracked campaigns?')) {
                    localTracker = {};
                    trackerEdits.push({ type: 'deleteAll' });
                    renderTracker();
                    popupText('All campaigns deleted');
                }
            }, 'atq-btn atq-btn-sm atq-btn-danger'));
        }
        // Discards unsaved edits like Close, so it sits beside Close
        footer.appendChild(atqBtn('Progress Manager', function() {
            outer.remove();
            openProgressManager();
        }, 'atq-btn atq-btn-sm'));
        footer.appendChild(atqBtn('Close', function() { outer.remove(); }, 'atq-btn'));
    }

    setTab('priority');
    document.body.prepend(outer);
}

function applyTrackerEdits(tracker, edits) {
    edits.forEach(function(e) {
        if (e.type === 'deleteAll') {
            tracker = {};
        } else if (e.type === 'deleteExpired') {
            Object.keys(tracker).forEach(function(gn) {
                if (!Array.isArray(tracker[gn])) return;
                tracker[gn] = tracker[gn].filter(function(c) { return calculateTimeRemaining(c.endDate) >= -60; });
                if (tracker[gn].length === 0) delete tracker[gn];
            });
        } else if (Array.isArray(tracker[e.game])) {
            // Same-named runs are told apart by key; entries saved before keys existed go by name
            var isTarget = function(c) { return e.key ? c.key === e.key : c.name === e.name; };
            if (e.type === 'toggle') {
                var c = tracker[e.game].find(isTarget);
                if (c) c.completed = e.completed;
            } else if (e.type === 'delete') {
                tracker[e.game] = tracker[e.game].filter(function(c) { return !isTarget(c); });
                if (tracker[e.game].length === 0) delete tracker[e.game];
            }
        }
    });
    return tracker;
}

function formatCountdown(ms) {
    if (ms === null || isNaN(ms)) return "--:--";
    if (ms < 0) ms = 0;
    var total = Math.round(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ":" + ("0" + s).slice(-2);
}

function atqRelativeTime(ms) {
    var secs = Math.round((Date.now() - ms) / 1000);
    if (secs < 60) return secs + "s ago";
    if (secs < 3600) return Math.floor(secs / 60) + "m ago";
    return Math.floor(secs / 3600) + "h " + (Math.floor(secs / 60) % 60) + "m ago";
}

function openProgressManager() {
    var existing = document.getElementById("ProgressManagerWrapper");
    if (existing) { closeProgressManager(); return; }

    injectAtqStyles();
    getIframeHost();

    var outer = document.createElement('div');
    outer.id = 'ProgressManagerWrapper';

    var titlebar = document.createElement('div');
    titlebar.className = 'atq-titlebar';
    var titleEl = document.createElement('span');
    titleEl.className = 'atq-title';
    titleEl.textContent = 'Progress Manager';
    titlebar.appendChild(titleEl);
    titlebar.appendChild(atqBtn('✕', closeProgressManager, 'atq-btn atq-btn-ghost'));
    outer.appendChild(titlebar);

    var tabsDiv = document.createElement('div');
    tabsDiv.className = 'atq-tabs';
    var tabDefs = [
        { id: 'drops', label: 'Drops' },
        { id: 'inventory', label: 'Inventory' },
        { id: 'campaigns', label: 'Campaigns' },
        { id: 'state', label: 'State' },
        { id: 'debug', label: 'Debug' }
    ];
    var tabBtns = {};
    tabDefs.forEach(function(t) {
        tabBtns[t.id] = atqBtn(t.label, function() { setTab(t.id); }, 'atq-tab');
        tabsDiv.appendChild(tabBtns[t.id]);
    });
    outer.appendChild(tabsDiv);

    var contentArea = document.createElement('div');
    contentArea.className = 'atq-content';
    outer.appendChild(contentArea);

    var footer = document.createElement('div');
    footer.className = 'atq-footer';
    outer.appendChild(footer);

    var activeTab = 'drops';
    var framePane = null;

    function mkMsgPane(bigText, subLines) {
        var pane = document.createElement('div');
        pane.className = 'atq-framepane';
        var msg = document.createElement('div');
        msg.className = 'atq-framepane-msg';
        var big = document.createElement('div');
        big.className = 'atq-countdown';
        big.textContent = bigText;
        msg.appendChild(big);
        (subLines || []).forEach(function(line) {
            var s = document.createElement('div');
            s.className = 'atq-sub';
            s.textContent = line;
            msg.appendChild(s);
        });
        pane.appendChild(msg);
        return pane;
    }

    function renderDrops() {
        var snap = getInventorySnapshot();
        var farming = sessionStorage.getItem("farmingCampaignName");
        var untilCheck = msUntilCheck("atqNextInventoryCheckAt");

        var header = document.createElement('div');
        header.className = 'atq-note';
        if (untilCheck !== null) {
            header.textContent = 'Next inventory check in ' + formatCountdown(untilCheck) +
                (farming ? '  ·  farming: ' + farming : '');
        } else {
            header.textContent = 'No inventory check scheduled (auto-farm is not watching a stream).';
        }
        contentArea.appendChild(header);

        // Reward campaign progress is only visible here, never in the inventory snapshot
        var watch = GM_getValue('watchDropsSnapshot', null);
        if (watch && Array.isArray(watch.items) && watch.items.length > 0) {
            var wh = document.createElement('div');
            wh.className = 'atq-game-header';
            wh.textContent = 'Current stream (Watch Drops)';
            contentArea.appendChild(wh);
            var wn = document.createElement('div');
            wn.className = 'atq-note';
            wn.textContent = watch.channel + ', read ' + atqRelativeTime(watch.takenAt) + '.';
            contentArea.appendChild(wn);
            watch.items.forEach(function(d) {
                appendDropRow(d.name + (d.game ? '  ·  ' + d.game : ''), d.percent,
                    [d.requirement, d.left].filter(Boolean).join(', '));
            });
        }

        if (!snap || snap.campaigns.length === 0) {
            // Nothing captured yet: show when the data will arrive
            contentArea.appendChild(mkMsgPane(
                untilCheck !== null ? formatCountdown(untilCheck) : '--:--',
                snap
                    ? ['Inventory last read ' + atqRelativeTime(snap.takenAt) + ' with no drops in progress.']
                    : ['No drop progress recorded yet.',
                       untilCheck !== null ? 'Waiting for the next inventory check.' : 'Start auto-farming to populate this.']
            ));
            return;
        }

        var stamp = document.createElement('div');
        stamp.className = 'atq-note';
        stamp.textContent = 'Snapshot taken ' + atqRelativeTime(snap.takenAt) + '.';
        contentArea.appendChild(stamp);

        snap.campaigns.forEach(function(c) {
            var gh = document.createElement('div');
            gh.className = 'atq-game-header';
            gh.textContent = c.name + (c.name === farming ? '  (farming)' : '');
            contentArea.appendChild(gh);

            if (c.endDate) {
                var ed = document.createElement('div');
                ed.className = 'atq-note';
                ed.textContent = 'Ends ' + c.endDate;
                contentArea.appendChild(ed);
            }

            c.drops.forEach(function(d) {
                appendDropRow(d.name, d.percent, d.requirement);
            });
        });
    }

    function appendDropRow(name, percent, requirement) {
        var pct = parseFloat(percent);
        if (isNaN(pct)) pct = 0;
        var complete = pct >= 100;

        var item = document.createElement('div');
        item.className = 'atq-drop';

        var top = document.createElement('div');
        top.className = 'atq-drop-top';
        var nm = document.createElement('span');
        nm.className = 'atq-drop-name';
        nm.textContent = name;
        var pc = document.createElement('span');
        pc.className = 'atq-drop-pct' + (complete ? ' done' : '');
        pc.textContent = (Math.round(pct * 10) / 10) + '%';
        top.appendChild(nm);
        top.appendChild(pc);
        item.appendChild(top);

        if (requirement) {
            var req = document.createElement('div');
            req.className = 'atq-drop-req';
            req.textContent = requirement;
            item.appendChild(req);
        }

        var bar = document.createElement('div');
        bar.className = 'atq-bar';
        var fill = document.createElement('div');
        fill.className = 'atq-bar-fill' + (complete ? ' done' : '');
        fill.style.width = Math.min(100, pct) + '%';
        bar.appendChild(fill);
        item.appendChild(bar);

        contentArea.appendChild(item);
    }

    function renderFrameTab(which) {
        var frame = which === 'inventory' ? inventoryIframe : campaignsIframe;
        var alive = !!(frame && frame.parentNode);
        // Both frames run off the inventory tick, so they share one countdown
        var untilCheck = msUntilCheck("atqNextInventoryCheckAt");

        if (alive) {
            // Placeholder; the real iframe stays in the host and is positioned over it
            framePane = document.createElement('div');
            framePane.className = 'atq-framepane';
            contentArea.appendChild(framePane);
        } else {
            framePane = null;
            contentArea.appendChild(mkMsgPane(
                untilCheck !== null ? formatCountdown(untilCheck) : '--:--',
                untilCheck !== null
                    ? ['The ' + which + ' page is loaded only while a check runs.',
                       'It will appear here when the timer reaches zero.']
                    : ['No check scheduled. Auto-farm is not watching a stream.',
                       'Use "Load Now" to open the page here manually.']
            ));
        }
        syncHost();
    }

    function renderState() {
        var note = document.createElement('div');
        note.className = 'atq-note';
        note.textContent = 'Live view of every value the script drives itself from. Read-only.';
        contentArea.appendChild(note);

        function section(title) {
            var h = document.createElement('div');
            h.className = 'atq-game-header';
            h.textContent = title;
            contentArea.appendChild(h);
        }
        function kv(key, value) {
            var row = document.createElement('div');
            row.className = 'atq-kv';
            var k = document.createElement('span');
            k.className = 'atq-kv-key';
            k.textContent = key;
            var v = document.createElement('span');
            var unset = value === null || value === undefined || value === '';
            v.className = 'atq-kv-val' + (unset ? ' unset' : '');
            v.textContent = unset ? '(not set)' : String(value);
            row.appendChild(k);
            row.appendChild(v);
            contentArea.appendChild(row);
        }

        section('Farming session (sessionStorage)');
        [
            'AutoTwitchQueuerAutoFarmCampaigns', 'farmingGameName', 'farmingCampaignName',
            'farmingGameIdx', 'farmingLinkIndex', 'farmingAllLinks',
            'farmingLastProgress', 'farmingLastPanelProgress', 'farmingPanelChangedAt',
            'farmingNoProgressChecks', 'farmingStalledChecks',
            'farmingIsStallFallback', 'farmingSkipCampaigns',
            'farmingStallGameNames', 'farmingStallCampaigns', 'farmingStallSameGame', 'fallbackChannelIndex', 'farmingCampaignKey',
            'farmingSkipChannels', 'atqInconclusiveChecks'
        ].forEach(function(k) { kv(k, sessionStorage.getItem(k)); });

        section('Timers');
        kv('inventoryCheckElapsedMinutes', sessionStorage.getItem('inventoryCheckElapsedMinutes'));
        var invMs = msUntilCheck('atqNextInventoryCheckAt');
        var offMs = msUntilCheck('atqNextOfflineCheckAt');
        kv('next inventory check', invMs === null ? null : formatCountdown(invMs));
        kv('next offline check', offMs === null ? null : formatCountdown(offMs));
        var playMs = msUntilCheck('atqNextPlaybackCheckAt');
        kv('next playback check', playMs === null ? null : formatCountdown(playMs));
        kv('inventoryCheckInterval active', inventoryCheckInterval ? 'yes' : 'no');
        kv('offlineCheckInterval active', offlineCheckInterval ? 'yes' : 'no');
        kv('playbackWatchdogTimer active', playbackWatchdogTimer ? 'yes' : 'no');

        section('Playback');
        var pv = getPlayerVideo();
        kv('playback state', getPlaybackState());
        kv('data-a-player-state', getPlayerStateAttr());
        kv('video element', pv ? 'found' : null);
        kv('video source', pv && (pv.currentSrc || pv.src) ? 'attached' : 'none');
        kv('currentTime', pv ? pv.currentTime.toFixed(1) : null);
        kv('since last advance', playbackLastAdvanceAt ? Math.round((Date.now() - playbackLastAdvanceAt) / 1000) + 's' : null);
        kv('playbackRecoveryStep', playbackRecoveryStep);
        kv('reloads used', playbackReloadsUsed() + ' / ' + getDropSettings().playbackReloadLimit);

        section('Scheduler');
        kv('scheduleStorage', sessionStorage.getItem('scheduleStorage'));
        kv('storedCurrentTarget', sessionStorage.getItem('storedCurrentTarget'));
        kv('twitchAboutLocation', sessionStorage.getItem('twitchAboutLocation'));
        kv('twitchWatchedCategory', sessionStorage.getItem('twitchWatchedCategory'));

        section('Iframes');
        kv('inventoryIframe', inventoryIframe ? (inventoryIframe.parentNode ? 'alive' : 'detached') : 'null');
        kv('campaignsIframe', campaignsIframe ? (campaignsIframe.parentNode ? 'alive' : 'detached') : 'null');
        kv('iframeCheckGen', iframeCheckGen);
        kv('iframeKillTimeout set', iframeKillTimeout ? 'yes' : 'no');
        kv('streamViewerCountSeen', String(streamViewerCountSeen));

        section('Stored settings (GM)');
        var settings = getDropSettings();
        Object.keys(settings).forEach(function(k) {
            kv(k, Array.isArray(settings[k]) ? JSON.stringify(settings[k]) : settings[k]);
        });
        kv('debugLogging', String(debug));

        section('Tracker (GM)');
        var tracker = getDropsTracker();
        var gameNames = Object.keys(tracker);
        if (gameNames.length === 0) {
            kv('dropsTracker', null);
        } else {
            gameNames.forEach(function(g) {
                var done = tracker[g].filter(function(c) { return c.completed; }).length;
                kv(g, done + ' / ' + tracker[g].length + ' completed');
            });
        }
        var snap = getInventorySnapshot();
        kv('dropProgressSnapshot', snap ? (snap.campaigns.length + ' campaign(s), ' + (snap.claimed || []).length + ' claimed, ' +
            (snap.rewards || []).length + ' reward(s), ' + atqRelativeTime(snap.takenAt)) : null);
        var watchSnap = GM_getValue('watchDropsSnapshot', null);
        kv('watchDropsSnapshot', watchSnap && Array.isArray(watchSnap.items)
            ? watchSnap.items.length + ' item(s) on ' + watchSnap.channel + ', ' + atqRelativeTime(watchSnap.takenAt) : null);
        kv('dropGameList', getDropList().map(function(g) { return g.name; }).join(', '));
    }

    function renderDebug() {
        var note = document.createElement('div');
        note.className = 'atq-note';
        note.textContent = 'Debug logging only controls whether "Debug:" messages are shown and logged. The actions below are always available.';
        contentArea.appendChild(note);

        var toggleRow = document.createElement('div');
        toggleRow.className = 'atq-row';
        toggleRow.appendChild(atqLabel('Debug logging:'));
        var toggleBtn = atqBtn(debug ? 'ON' : 'OFF', function() {
            setDebugLogging(!debug);
            render();
        }, 'atq-btn ' + (debug ? 'atq-btn-primary' : ''));
        toggleRow.appendChild(toggleBtn);
        contentArea.appendChild(toggleRow);

        var actions = document.createElement('div');
        actions.className = 'atq-row';
        actions.style.marginTop = '8px';
        [
            ['Run Inventory Check', runInventoryCheck],
            ['Run Offline Check', runOfflineCheck],
            ['Run Priority Check', runPriorityCheck],
            ['Read Watch Drops', function() {
                readWatchDropsPanel().then(function(panel) {
                    popupText(panel.ok
                        ? 'Watch Drops: ' + (panel.items.map(function(d) { return d.name + ' ' + (Math.round(d.percent * 10) / 10) + '%'; }).join(', ') || 'no items')
                        : 'Watch Drops: could not read the panel');
                });
            }],
            ['Check Playback', function() { popupText('Playback: ' + getPlaybackState()); }],
            ['Force Playback Recovery', attemptPlaybackRecovery],
            ['Cull Iframes', function() { debugCullIframes(); render(); }],
            ['Sweep Expired', function() {
                var n = sweepExpiredCampaigns();
                popupText(n > 0 ? 'Marked ' + n + ' expired campaign(s) completed' : 'No expired campaigns found');
            }]
        ].forEach(function(pair) {
            actions.appendChild(atqBtn(pair[0], pair[1], 'atq-btn atq-btn-sm'));
        });
        contentArea.appendChild(actions);

        var logHeader = document.createElement('div');
        logHeader.className = 'atq-game-header';
        logHeader.textContent = 'Session log';
        contentArea.appendChild(logHeader);

        var log = document.createElement('div');
        log.className = 'atq-log';
        var raw = sessionStorage.getItem('ATQPermaLog');
        log.textContent = raw ? raw.split(' /// ').reverse().join('\n') : 'Nothing logged this session.';
        contentArea.appendChild(log);
    }

    // Keep the host over the placeholder, or stashed when no frame tab is showing
    function syncHost() {
        var host = getIframeHost();
        var showing = null;
        if (activeTab === 'inventory' && inventoryIframe && inventoryIframe.parentNode) showing = inventoryIframe;
        if (activeTab === 'campaigns' && campaignsIframe && campaignsIframe.parentNode) showing = campaignsIframe;

        Array.from(host.children).forEach(function(f) {
            f.classList.toggle('atq-frame-active', f === showing);
        });

        if (!showing || !framePane || !document.getElementById('ProgressManagerWrapper')) {
            host.classList.add('atq-host-stashed');
            return;
        }
        var r = framePane.getBoundingClientRect();
        host.classList.remove('atq-host-stashed');
        host.style.left = r.left + 'px';
        host.style.top = r.top + 'px';
        host.style.width = r.width + 'px';
        host.style.height = r.height + 'px';
    }

    function render() {
        var scroll = contentArea.scrollTop;
        contentArea.innerHTML = '';
        framePane = null;
        footer.innerHTML = '';

        if (activeTab === 'drops') {
            renderDrops();
        } else if (activeTab === 'inventory' || activeTab === 'campaigns') {
            renderFrameTab(activeTab);
            footer.appendChild(atqBtn('Load Now', function() {
                var f = activeTab === 'inventory' ? getInventoryIframe() : getCampaignsIframe();
                navigateIframe(f, activeTab === 'inventory'
                    ? 'https://www.twitch.tv/drops/inventory'
                    : 'https://www.twitch.tv/drops/campaigns');
                render();
            }, 'atq-btn atq-btn-sm'));
            footer.appendChild(atqBtn('Unload', function() { killIframes(); render(); }, 'atq-btn atq-btn-sm'));
        } else if (activeTab === 'state') {
            renderState();
        } else {
            renderDebug();
        }

        footer.appendChild(atqBtn('Campaign Manager', function() {
            closeProgressManager();
            openCampaignManager();
        }, 'atq-btn atq-btn-sm'));
        footer.appendChild(atqBtn('Close', closeProgressManager, 'atq-btn'));

        contentArea.scrollTop = scroll;
        syncHost();
    }

    function setTab(tab) {
        activeTab = tab;
        Object.keys(tabBtns).forEach(function(id) {
            tabBtns[id].classList.toggle('atq-active', id === tab);
        });
        render();
    }

    document.body.prepend(outer);
    setTab('drops');

    // 1s refresh for countdowns; re-rendering never rebuilds the iframe
    progressPanelTimer = setInterval(function() {
        if (!document.getElementById('ProgressManagerWrapper')) { closeProgressManager(); return; }
        render();
    }, 1000);

    // Track geometry every frame so the overlay follows layout shifts
    (function trackGeometry() {
        if (!document.getElementById('ProgressManagerWrapper')) return;
        syncHost();
        progressPanelRAF = requestAnimationFrame(trackGeometry);
    })();
}

function closeProgressManager() {
    if (progressPanelTimer !== null) { clearInterval(progressPanelTimer); progressPanelTimer = null; }
    if (progressPanelRAF !== null) { cancelAnimationFrame(progressPanelRAF); progressPanelRAF = null; }
    var panel = document.getElementById('ProgressManagerWrapper');
    if (panel) panel.remove();
    if (iframeHost && iframeHost.parentNode) {
        iframeHost.classList.add('atq-host-stashed');
        Array.from(iframeHost.children).forEach(function(f) { f.classList.remove('atq-frame-active'); });
    }
}

// True while the script drives the page. Intervals are checked for truthiness since they start undefined
function isScriptActive() {
    // Auto farm campaigns
    if (sessionStorage.getItem("AutoTwitchQueuerAutoFarmCampaigns") === "true") return true;
    // A queue is scheduled or mid-run
    if (sessionStorage.getItem("scheduleStorage") !== null) return true;
    // Category watching (4/5) and the /about disruption loop (3/6)
    if (sessionStorage.getItem("twitchWatchedCategory") !== null) return true;
    if (sessionStorage.getItem("twitchAboutLocation") !== null) return true;
    if (locationContains("?filter=drops&sort=VIEWER_COUNT")) return true;
    // Farming checks running on a watched stream
    if (inventoryCheckInterval || offlineCheckInterval) return true;
    // Any AutoLiveWatcher loop that detectSite started
    if (loopingInterval) return true;
    return false;
}

// Polled because detectSite's loops start 30s in and auto-farm can toggle anytime
function syncProgressLauncher() {
    var btn = document.getElementById('ATQProgressLauncher');
    var wanted = isScriptActive() || !!document.getElementById('ProgressManagerWrapper');

    if (!wanted) {
        if (btn) btn.remove();
        return;
    }
    if (btn) return;

    injectAtqStyles();
    btn = document.createElement('button');
    btn.id = 'ATQProgressLauncher';
    btn.type = 'button';
    btn.textContent = '◧';
    btn.title = 'Progress Manager';
    btn.addEventListener('click', openProgressManager);
    document.body.appendChild(btn);
}

function createProgressLauncher() {
    if (launcherPollTimer === null) {
        launcherPollTimer = setInterval(function() {
            try { syncProgressLauncher(); } catch (e) { console.error("[ATQ] launcher sync failed", e); }
        }, 2000);
    }
    syncProgressLauncher();
}

function getOpenDropHeader(doc) {
    return Array.from(doc.querySelectorAll('h4')).find(function(el) { return el.textContent.trim() === "Open Drop Campaigns"; }) || null;
}

// doc defaults to the page; the priority check passes the campaigns iframe's document
function findCampaignContainer(header, doc) {
    var el = header;
    var body = (doc || document).body;
    while (el && el !== body) {
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

// Entry point for campaigns page work; polls so a background tab can't stall it
function injectDropButtons() {
    var injected = false;
    function tryInject() {
        if (injected) return true;
        var dropHeader = getOpenDropHeader(document);
        if(!dropHeader) return false;
        // An empty drop section still counts as loaded, or reward-only farming would never start
        var dropsEmpty = /no Drops campaigns available/i.test(document.body.textContent);
        if(!findCampaignContainer(dropHeader) && !dropsEmpty) return false;
        // Commit first: autoFarmCampaigns must not run twice
        injected = true;
        renderAllCampaignButtons();
        if(sessionStorage.getItem("AutoTwitchQueuerAutoFarmCampaigns") == "true" && window.location.pathname === "/drops/campaigns") {
            popupText("Debug: Campaigns page rendered (" + document.visibilityState + "), prefetching inventory");
            campaignsInventoryPromise = loadInventoryPage();
            autoFarmCampaigns();
        }
        return true;
    }
    function start() {
        // Buttons render independently of the farming gate below, as soon as each row exists
        keepCampaignButtonsRendered();
        armCampaignsWatchdog();
        waitForCondition(document.body, tryInject, {
            timeoutMs: 300000,
            onTimeout: function() {
                popupText("Debug: Campaign list never rendered, gave up injecting drop buttons");
                if (sessionStorage.getItem("AutoTwitchQueuerAutoFarmCampaigns") == "true") {
                    retryCampaignsPage("campaign list never rendered");
                }
            }
        });
    }
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
}

// Every renderer skips rows that already carry a button, so this is safe to run repeatedly
function renderAllCampaignButtons() {
    renderRewardButtons();
    var dropHeader = getOpenDropHeader(document);
    var dropContainer = dropHeader ? findCampaignContainer(dropHeader) : null;
    if (dropContainer) renderDropButtons(dropContainer);
    renderClosedDropButtons();
}

// Rows render in stages and get replaced, so buttons are re-applied on mutations and a poll
function keepCampaignButtonsRendered() {
    var debounce = null;
    function pass() {
        debounce = null;
        if (window.location.pathname !== "/drops/campaigns") return;
        try { renderAllCampaignButtons(); } catch (e) { console.error("[ATQ] campaign button render failed", e); }
    }
    new MutationObserver(function() {
        if (debounce === null) debounce = setTimeout(pass, 250);
    }).observe(document.body, { childList: true, subtree: true });
    setInterval(pass, 2000);
    pass();
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
        addDropButton(row, nameEl.textContent.trim());
    });
}

// The +/− toggle on a campaign row's header, shared by drop and reward rows
function addDropButton(row, gameName) {
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

// Reward rows are every accordion between the Open Reward Campaigns h4 and the next h4; always re-queried
function getRewardRows(doc) {
    var headers = Array.from(doc.querySelectorAll('h4'));
    var rewardHeader = headers.find(function(el) { return el.textContent.trim() === "Open Reward Campaigns"; });
    if (!rewardHeader) return [];
    var nextHeader = headers.find(function(el) {
        return el !== rewardHeader && (rewardHeader.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    var seen = [];
    Array.from(doc.querySelectorAll('.accordion-header')).forEach(function(h) {
        if (!(rewardHeader.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
        if (nextHeader && !(h.compareDocumentPosition(nextHeader) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
        var row = h.parentElement;
        if (row && seen.indexOf(row) === -1) seen.push(row);
    });
    return seen;
}

function rewardRowGameName(row) {
    var imgEl = row.querySelector('img.partner-thumbnail');
    return imgEl && imgEl.alt ? imgEl.alt : null;
}

function renderRewardButtons() {
    getRewardRows(document).forEach(function(row) {
        if (row.querySelector('.atq-drop-btn')) return;
        var gameName = rewardRowGameName(row);
        if (!gameName) return;
        addDropButton(row, gameName);
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
        noProgressCheckLimit: s.noProgressCheckLimit || 2,
        playbackStallSeconds: s.playbackStallSeconds || 45,
        playbackReloadLimit: s.playbackReloadLimit === 0 ? 0 : (s.playbackReloadLimit || 2)
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
        scheduleCampaignsRescan();
    }
}

// Nothing to farm: disarm the watchdog and re-scan later
function scheduleCampaignsRescan() {
    if (window.location.pathname !== "/drops/campaigns") return;
    if (sessionStorage.getItem("AutoTwitchQueuerAutoFarmCampaigns") != "true") return;
    clearTimeout(campaignsWatchdogTimer);
    var minutes = getDropSettings().checkIntervalMinutes;
    popupText("Debug: Nothing to farm, re-scanning campaigns in " + minutes + " min");
    campaignsWatchdogTimer = setTimeout(function() {
        retryCampaignsPage("scheduled re-scan");
    }, minutes * 60000);
}

// Still on the campaigns page after this long means something stalled
function armCampaignsWatchdog() {
    if (window.location.pathname !== "/drops/campaigns") return;
    if (sessionStorage.getItem("AutoTwitchQueuerAutoFarmCampaigns") != "true") return;
    clearTimeout(campaignsWatchdogTimer);
    campaignsWatchdogTimer = setTimeout(function() {
        retryCampaignsPage("campaigns page watchdog");
    }, 300000);
}

// Reloads the campaigns page, waiting up to 2 min for the tab to be visible
function retryCampaignsPage(reason) {
    if (campaignsRetryPending) return;
    if (sessionStorage.getItem("AutoTwitchQueuerAutoFarmCampaigns") != "true") return;
    campaignsRetryPending = true;
    clearTimeout(campaignsWatchdogTimer);
    popupText("Debug: Retrying campaigns page (" + reason + ", " + document.visibilityState + ")");
    function go() {
        document.removeEventListener('visibilitychange', onVisible);
        cleanRedirect("https://www.twitch.tv/drops/campaigns");
    }
    function onVisible() { if (document.visibilityState === 'visible') go(); }
    if (document.visibilityState === 'visible') { go(); return; }
    document.addEventListener('visibilitychange', onVisible);
    setTimeout(go, 120000);
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
    if(window.location.pathname !== "/drops/campaigns") {
        popupText("Returning to Campaigns page to farm");
        cleanRedirect("https://www.twitch.tv/drops/campaigns");
        return;
    }
    armCampaignsWatchdog();
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
        sessionStorage.removeItem("farmingStallCampaigns");
        farmNextPriority(list, 0);
    }
}

function farmNextPriority(list, idx, retries) {
    retries = retries || 0;
    if(idx >= list.length) {
        stopInventoryChecking();
        useFallbackOr("All priority games completed");
        return;
    }
    var game = list[idx];
    // Drop and reward rows are merged into one campaign list per game
    var rewardRows = getRewardRows(document).filter(function(row) {
        return rewardRowGameName(row) === game.name;
    });
    var matchingRows = [];
    var header = getOpenDropHeader(document);
    var campaignContainer = header ? findCampaignContainer(header) : null;
    if (campaignContainer) {
        matchingRows = Array.from(campaignContainer.children).filter(function(row) {
            var nameEl = row.querySelector('p');
            return nameEl && nameEl.textContent.trim() === game.name;
        });
    }
    if (!campaignContainer && rewardRows.length === 0) {
        popupText("Could not find campaigns list");
        retryCampaignsPage("campaigns list missing");
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
    expandRowsSequentially(toLoad, function(failures) {
        parseAllCampaignsAndQueue(game, matchingRows, rewardRows, list, idx, failures, retries);
    });
}

function parseAllCampaignsAndQueue(game, matchingRows, rewardRows, list, idx, expandFailures, retries) {
    // Rows are held across async expansion and inventory waits, and Twitch can re-render one with
    // another game's campaigns in it, so confirm each row still belongs to this game
    var changed = matchingRows.some(function(r) { var p = r.querySelector('p'); return !p || p.textContent.trim() !== game.name; })
        || rewardRows.some(function(r) { return rewardRowGameName(r) !== game.name; });
    if (changed) {
        if ((retries || 0) < 3) {
            popupText("Row for " + game.name + " changed while reading, re-scanning");
            setTimeout(function() { farmNextPriority(list, idx, (retries || 0) + 1); }, 2000);
            return;
        }
        matchingRows = matchingRows.filter(function(r) { var p = r.querySelector('p'); return p && p.textContent.trim() === game.name; });
        rewardRows = rewardRows.filter(function(r) { return rewardRowGameName(r) === game.name; });
    }
    sweepExpiredCampaigns();
    var campaigns = parseCampaignsFromRow(matchingRows);
    rewardRows.forEach(function(row) {
        campaigns.push(parseRewardCampaignFromRow(game, row));
    });
    popupText("Debug: Parsed " + campaigns.length + " campaign(s) for " + game.name + ": [" + campaigns.map(function(c) { return c.name; }).join(", ") + "]");
    if (expandFailures > 0 && (campaigns.length === 0 || document.visibilityState === 'hidden')) {
        // Details never rendered (usually a hidden tab), which says nothing about the game, so retry
        retryCampaignsPage("details never rendered for " + game.name);
        return;
    }
    // Campaigns in a row can render one at a time; re-read before deciding a tracked one is gone
    var parsedNames = campaigns.map(function(c) { return c.name; });
    var missing = (getDropsTracker()[game.name] || []).filter(function(t) {
        return !t.completed && calculateTimeRemaining(t.endDate) > 0 && parsedNames.indexOf(t.name) === -1;
    }).map(function(t) { return t.name; });
    if (missing.length > 0 && (retries || 0) < 3) {
        popupText("Debug: Missing [" + missing.join(", ") + "] for " + game.name + ", re-reading row");
        setTimeout(function() { farmNextPriority(list, idx, (retries || 0) + 1); }, 2000);
        return;
    }
    if (campaigns.length === 0) {
        popupText("No campaigns found for: " + game.name + ", skipping");
        farmNextPriority(list, idx + 1);
        return;
    }
    campaigns.forEach(function(campaign) {
        addCampaignToTracker(game.name, campaign.name, campaign.endDate, {
            drops: campaign.drops, nonWatchDrops: campaign.nonWatchDrops, startMs: campaign.startMs,
            reward: campaign.reward, key: campaign.key
        });
    });
    var tracker = getDropsTracker();
    var needsInventory = campaigns.some(function(c) {
        var tracked = findTracked(tracker[game.name], c);
        return tracked && !tracked.completed;
    });
    if (needsInventory && !campaignsPageInventory) {
        // Check Claimed/Rewards once per visit so already-finished campaigns aren't queued
        popupText("Debug: " + (campaignsInventoryPromise ? "Waiting on prefetched inventory" : "Reading inventory for already claimed campaigns"));
        if (!campaignsInventoryPromise) campaignsInventoryPromise = loadInventoryPage();
        campaignsInventoryPromise.then(function(inv) {
            campaignsPageInventory = inv;
            if (!inv.ok) popupText("Debug: Inventory read failed, continuing without claimed check");
            parseAllCampaignsAndQueue(game, matchingRows, rewardRows, list, idx, expandFailures, retries);
        });
        return;
    }
    if (needsInventory) {
        applyInventoryToTracker(campaignsPageInventory);
        tracker = getDropsTracker();
    }
    var uncompleted = campaigns.filter(function(c) {
        var tracked = findTracked(tracker[game.name], c);
        return !tracked || !tracked.completed;
    });
    popupText("Debug: " + uncompleted.length + " uncompleted: [" + uncompleted.map(function(c) { return c.name; }).join(", ") + "]");
    if (uncompleted.length === 0) {
        popupText("All campaigns completed for: " + game.name + " [" + parsedNames.join(", ") + "], moving to next");
        sessionStorage.removeItem("farmingSkipCampaigns");
        farmNextPriority(list, idx + 1);
        return;
    }
    // Rows list campaigns that haven't started yet, and keep ones that just ended
    var active = uncompleted.filter(isCampaignActive);
    if (active.length === 0) {
        var upcoming = uncompleted.filter(function(c) { return c.startMs && c.startMs > Date.now(); })
            .sort(function(a, b) { return a.startMs - b.startMs; });
        popupText("No " + game.name + " campaign is live now" + (upcoming.length > 0 ? " (next: " + upcoming[0].name + " at " + new Date(upcoming[0].startMs).toLocaleTimeString("en") + ")" : "") + ", moving to next");
        farmNextPriority(list, idx + 1);
        return;
    }
    var skipList = JSON.parse(sessionStorage.getItem("farmingSkipCampaigns") || "[]");
    var farmable = active.filter(function(c) { return !skipList.includes(c.name); });
    popupText("Debug: " + farmable.length + " farmable (skip list: [" + skipList.join(", ") + "]): [" + farmable.map(function(c) { return c.name; }).join(", ") + "]");
    if (farmable.length === 0) {
        sessionStorage.removeItem("farmingSkipCampaigns");
        sessionStorage.setItem("farmingIsStallFallback", "true");
        var stalledGames = JSON.parse(sessionStorage.getItem("farmingStallGameNames") || "[]");
        if (!stalledGames.includes(game.name)) stalledGames.push(game.name);
        sessionStorage.setItem("farmingStallGameNames", JSON.stringify(stalledGames));
        // Which campaigns stalled, so one starting later still pulls us back from the fallback
        var stalledCampaigns = JSON.parse(sessionStorage.getItem("farmingStallCampaigns") || "{}");
        stalledCampaigns[game.name] = mergeDropNames(stalledCampaigns[game.name], active.map(function(c) { return c.name; }));
        sessionStorage.setItem("farmingStallCampaigns", JSON.stringify(stalledCampaigns));
        popupText("All campaign links stalled for " + game.name + ". Trying next priority game");
        farmNextPriority(list, idx + 1);
        return;
    }
    findNextFarmableCampaign(game, matchingRows, list, idx, farmable);
}

// Every campaign passed in is live and unfinished; farm the one that ends first
function findNextFarmableCampaign(game, matchingRows, list, idx, active) {
    var sorted = active.slice().sort(function(a, b) {
        return parseEndDateToMs(a.endDate) - parseEndDateToMs(b.endDate);
    });
    queueCampaignStream(game, matchingRows, sorted[0], list, idx);
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
    // Skip the campaign for this session and re-scan; the skip list guarantees termination
    var skipList = JSON.parse(sessionStorage.getItem("farmingSkipCampaigns") || "[]");
    if (!skipList.includes(campaign.name)) skipList.push(campaign.name);
    sessionStorage.setItem("farmingSkipCampaigns", JSON.stringify(skipList));
    farmNextPriority(list, idx);
}

function queueCampaignStream(game, matchingRows, campaign, list, idx) {
    var rows = Array.isArray(matchingRows) ? matchingRows : [matchingRows];
    var targetBlock = null;
    if (campaign.rewardRow) {
        // Reward campaigns carry their accordion row
        targetBlock = campaign.rewardRow;
    } else {
        targetBlock = findDropCampaignBlock(rows, campaign.name);
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
    // Matches "Watch for 20 minutes" and "Watch 20 minutes"; sub-only campaigns have neither
    var watchItems = items.filter(li => /watch\s+(for\s+)?\d+/i.test(li.textContent));
    if(watchItems.length === 0) {
        popupText("No watchable drops for: " + campaign.name + ", marking complete");
        markCampaignCompleted(game.name, campaign, true);
        skipCampaignAndContinue(game, campaign, list, idx);
        return;
    }
    // Prefer links in the watch item, else the first item with links; only Twitch channel/category links count
    function watchableLinks(li) {
        return Array.from(li.querySelectorAll('a')).filter(function(a) {
            var href = a.getAttribute('href') || '';
            var isTwitchPage = (href.startsWith('/') && !href.startsWith('//')) || /^https?:\/\/(www\.)?twitch\.tv\//i.test(href);
            return isTwitchPage && !href.includes('/drops/');
        });
    }
    var linkLi = watchItems.find(function(li) { return watchableLinks(li).length > 0; })
        || items.find(function(li) { return watchableLinks(li).length > 0; });
    var links = linkLi ? watchableLinks(linkLi) : [];
    // A category link is tried first; channel-only lists go in listed order, main channel first
    var hrefs = links.map(function(l) { return l.getAttribute('href'); });
    var startIndex = hrefs.findIndex(function(h) { return h.includes("/directory/category"); });
    if (startIndex === -1) startIndex = 0;
    var streamHref = hrefs.length > 0 ? hrefs[startIndex] : null;
    if(!streamHref) {
        popupText("No stream link found for: " + campaign.name + ", skipping");
        skipCampaignAndContinue(game, campaign, list, idx);
        return;
    }
    sessionStorage.setItem("farmingAllLinks", JSON.stringify(hrefs));
    sessionStorage.setItem("farmingLinkIndex", String(startIndex));
    sessionStorage.removeItem("farmingSkipChannels");
    sessionStorage.removeItem("atqInconclusiveChecks");
    sessionStorage.removeItem("farmingLastProgress");
    sessionStorage.removeItem("farmingLastPanelProgress");
    sessionStorage.setItem("farmingPanelChangedAt", String(Date.now()));
    sessionStorage.removeItem("farmingStalledChecks");
    sessionStorage.removeItem("farmingNoProgressChecks");
    var streamUrl = streamHref.startsWith('http') ? streamHref : "https://www.twitch.tv" + streamHref;
    var settings = getDropSettings();
    var remainingMinutes = calculateTimeRemaining(campaign.endDate);
    var isStallFallback = sessionStorage.getItem("farmingIsStallFallback") === "true";
    var watchMinutes = isStallFallback ? (settings.fallbackMinutes || 30) : remainingMinutes;
    queueStreamFor(normalizeTwitchUrl(streamUrl), watchMinutes);
    sessionStorage.setItem("farmingGameIdx", idx.toString());
    sessionStorage.setItem("farmingGameName", game.name);
    sessionStorage.setItem("farmingCampaignName", campaign.name);
    sessionStorage.setItem("farmingCampaignKey", campaign.key || "");
    popupText("Queued: " + campaign.name + " (" + game.name + ") for " + watchMinutes + " min");
    processSchedule();
}

function clearFarmingSessionState() {
    sessionStorage.removeItem("farmingGameName");
    sessionStorage.removeItem("farmingCampaignName");
    sessionStorage.removeItem("farmingCampaignKey");
    sessionStorage.removeItem("farmingSkipChannels");
    sessionStorage.removeItem("atqInconclusiveChecks");
    sessionStorage.removeItem("farmingGameIdx");
    sessionStorage.removeItem("farmingAllLinks");
    sessionStorage.removeItem("farmingLinkIndex");
    sessionStorage.removeItem("farmingLastProgress");
    sessionStorage.removeItem("farmingLastPanelProgress");
    sessionStorage.removeItem("farmingPanelChangedAt");
    sessionStorage.removeItem("farmingNoProgressChecks");
    sessionStorage.removeItem("farmingStalledChecks");
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
        return true;
    }
    popupText("All fallback channels offline. Waiting.");
    return false;
}

// The link currently being watched, absolute, or null when not farming a campaign link
function currentFarmingLink() {
    var allLinks = JSON.parse(sessionStorage.getItem("farmingAllLinks") || "[]");
    var href = allLinks[parseInt(sessionStorage.getItem("farmingLinkIndex") || "-1")];
    if (!href) return null;
    return href.startsWith('http') ? href : "https://www.twitch.tv" + href;
}

// Minutes until the queued return to the campaigns page, or null when nothing is queued
function minutesUntilQueueReturn() {
    var queued = (sessionStorage.getItem("scheduleStorage") || "").split(",");
    if (queued.length < 2) return null;
    var at = new Date(queued[1]).getTime();
    return isNaN(at) ? null : Math.floor((at - Date.now()) / 60000);
}

// Lowercase channel login from a twitch.tv URL, or null for directory/drops pages
function channelLogin(url) {
    try {
        var seg = new URL(url, "https://www.twitch.tv").pathname.split('/').filter(Boolean)[0];
        if (!seg || seg === 'directory' || seg === 'drops') return null;
        return seg.toLowerCase();
    } catch (e) {
        return null;
    }
}

function tryNextAvailableLink(gameName, campaignName) {
    var allLinks = JSON.parse(sessionStorage.getItem("farmingAllLinks") || "[]");
    var linkIndex = parseInt(sessionStorage.getItem("farmingLinkIndex") || "-1");
    // A category link is tried first; its channels won't help if the category stalls, so channel links
    // are only walked (in listed order) when there is no category link
    var hasCategoryLink = allLinks.some(function(l) { return l && l.includes("/directory/category"); });
    var nextIndex = hasCategoryLink ? -1 : linkIndex + 1;
    var campaign = getFarmedCampaign(gameName, campaignName);
    var remainingMinutes = campaign ? calculateTimeRemaining(campaign.endDate) : (getDropSettings().fallbackMinutes || 30);
    // A stall-fallback stream keeps the return time it was queued with
    if (sessionStorage.getItem("farmingIsStallFallback") === "true") {
        var queueLeft = minutesUntilQueueReturn();
        if (queueLeft !== null) remainingMinutes = Math.min(remainingMinutes, queueLeft);
    }
    var currentLink = currentFarmingLink();
    var skippedChannels = JSON.parse(sessionStorage.getItem("farmingSkipChannels") || "[]");
    // Only a stream being watched right now can be skipped; from the category page itself there is
    // no new stream to rule out, so the campaign stalls
    var channel = channelLogin(window.location.href);
    // One stream in a category says nothing about the rest, so try a couple more before giving up
    if (currentLink && currentLink.includes("/directory/category") && remainingMinutes > 0 &&
        channel && skippedChannels.indexOf(channel) === -1 && skippedChannels.length < 2) {
        skippedChannels.push(channel);
        sessionStorage.setItem("farmingSkipChannels", JSON.stringify(skippedChannels));
        sessionStorage.removeItem("farmingLastProgress");
        sessionStorage.removeItem("farmingLastPanelProgress");
        sessionStorage.setItem("farmingPanelChangedAt", String(Date.now()));
        sessionStorage.removeItem("farmingStalledChecks");
        sessionStorage.removeItem("farmingNoProgressChecks");
        popupText("No progress on " + channel + ", trying another stream in the category");
        cleanRedirect(normalizeTwitchUrl(currentLink));
        return;
    }
    // A campaign with no time left is not worth a backup link; queueing it would bounce straight back
    if (nextIndex >= 0 && nextIndex < allLinks.length && allLinks[nextIndex] && remainingMinutes > 0) {
        var nextHref = allLinks[nextIndex];
        var nextUrl = nextHref.startsWith('http') ? nextHref : "https://www.twitch.tv" + nextHref;
        sessionStorage.setItem("farmingLinkIndex", String(nextIndex));
        sessionStorage.removeItem("farmingLastProgress");
        sessionStorage.removeItem("farmingLastPanelProgress");
        sessionStorage.setItem("farmingPanelChangedAt", String(Date.now()));
        sessionStorage.removeItem("farmingStalledChecks");
        sessionStorage.removeItem("farmingNoProgressChecks");
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
        sessionStorage.removeItem("farmingLastPanelProgress");
        sessionStorage.removeItem("farmingPanelChangedAt");
        sessionStorage.removeItem("farmingStalledChecks");
        sessionStorage.removeItem("farmingNoProgressChecks");
        sessionStorage.removeItem("farmingAllLinks");
        sessionStorage.removeItem("farmingLinkIndex");
        popupText("All links stalled for " + campaignName + ". Trying next campaign");
        cleanRedirect("https://www.twitch.tv/drops/campaigns");
    }
}

function stopInventoryChecking() {
    stopPlaybackWatchdog();
    clearTimeout(inventoryCheckInterval);
    inventoryCheckInterval = null;
    clearTimeout(offlineCheckInterval);
    offlineCheckInterval = null;
    sessionStorage.removeItem("atqNextInventoryCheckAt");
    sessionStorage.removeItem("atqNextOfflineCheckAt");
}

// Wall-clock times of the next checks, for the Progress Manager countdowns
function markNextCheck(key, msFromNow) {
    sessionStorage.setItem(key, String(Date.now() + msFromNow));
}

function msUntilCheck(key) {
    var at = parseInt(sessionStorage.getItem(key) || "0");
    if (!at) return null;
    return at - Date.now();
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

// The stream player, not a clip or ad <video>
function getPlayerVideo() {
    return document.querySelector('[data-a-target="video-player"] video')
        || document.querySelector('.persistent-player video');
}

function getPlayerStateAttr() {
    var btn = document.querySelector('[data-a-target="player-play-pause-button"]');
    return btn ? btn.getAttribute('data-a-player-state') : null;
}

// "playing" | "stalled" | "unknown"; unknown (player not mounted) is never acted on
function getPlaybackState() {
    var video = getPlayerVideo();
    if (!video) return "unknown";

    // No source attached: the frozen-player signature
    if (!video.currentSrc && !video.src) return "stalled";

    if (video.paused || getPlayerStateAttr() === "paused") return "stalled";

    // Playing but frozen shows only as currentTime not advancing
    var now = Date.now();
    var t = video.currentTime;
    if (playbackLastTime === null || t !== playbackLastTime) {
        playbackLastTime = t;
        playbackLastAdvanceAt = now;
        return "playing";
    }
    var stallMs = (getDropSettings().playbackStallSeconds || 45) * 1000;
    if (now - playbackLastAdvanceAt >= stallMs) return "stalled";
    return "playing";
}

function playbackReloadsUsed() {
    if (sessionStorage.getItem("atqPlaybackReloadUrl") !== window.location.href) return 0;
    return parseInt(sessionStorage.getItem("atqPlaybackReloads") || "0");
}

function clearPlaybackReloads() {
    sessionStorage.removeItem("atqPlaybackReloads");
    sessionStorage.removeItem("atqPlaybackReloadUrl");
}

// One escalating rung per tick. Synthetic clicks may do nothing in Firefox, hence the reload rung
function attemptPlaybackRecovery() {
    var settings = getDropSettings();
    var step = playbackRecoveryStep;
    playbackRecoveryStep++;

    if (step === 0) {
        var gate = document.querySelector('[data-a-target="content-classification-gate-overlay-start-watching-button"]')
            || document.querySelector('[data-a-target="player-overlay-mature-accept"]');
        if (gate) {
            popupText("Playback: clicking content gate");
            gate.click();
            return;
        }
        step = 1;
        playbackRecoveryStep = 2;
    }

    if (step === 1) {
        var reloadPlayer = $("div[data-a-target='tw-core-button-label-text']:contains('Reload Player')");
        if (reloadPlayer.length > 0) {
            popupText("Playback: clicking Reload Player");
            reloadPlayer[0].click();
            return;
        }
        step = 2;
        playbackRecoveryStep = 3;
    }

    if (step === 2) {
        popupText("Playback: stalled, trying to start the player");
        var video = getPlayerVideo();
        if (video && (video.currentSrc || video.src)) {
            try {
                var played = video.play();
                if (played && played.catch) played.catch(function() {});
            } catch (e) {
                console.error("[ATQ] video.play() failed", e);
            }
        }
        var playBtn = document.querySelector('[data-a-target="player-play-pause-button"][data-a-player-state="paused"]');
        if (playBtn) playBtn.click();
        return;
    }

    if (step === 3) {
        // The overlay is a different code path from the control bar button
        var overlay = document.querySelector('[data-a-target="player-overlay-click-handler"]');
        if (overlay) {
            popupText("Playback: clicking the player overlay");
            overlay.click();
        }
        return;
    }

    var used = playbackReloadsUsed();
    if (used < settings.playbackReloadLimit) {
        sessionStorage.setItem("atqPlaybackReloadUrl", window.location.href);
        sessionStorage.setItem("atqPlaybackReloads", String(used + 1));
        popupText("Playback: player never started, reloading page (" + (used + 1) + "/" + settings.playbackReloadLimit + ")");
        cleanRedirect(window.location.href);
        return;
    }

    // Out of options on this page, so treat it exactly like an offline stream.
    var gn = sessionStorage.getItem("farmingGameName");
    var cn = sessionStorage.getItem("farmingCampaignName");
    clearPlaybackReloads();
    stopInventoryChecking();
    if (!gn || !cn) {
        popupText("Playback: player never started and no farming session to advance");
        return;
    }
    if (gn === "__fallback__") {
        popupText("Playback: player never started, trying next fallback");
        tryNextFallbackChannel();
    } else {
        popupText("Playback: player never started, trying next link");
        tryNextAvailableLink(gn, cn);
    }
}

function startPlaybackWatchdog() {
    stopPlaybackWatchdog();
    playbackLastTime = null;
    playbackLastAdvanceAt = Date.now();
    playbackRecoveryStep = 0;
    playbackWatchdogStartedAt = Date.now();

    function tick() {
        var state = getPlaybackState();
        // Grace period for a slow-mounting player
        if (Date.now() - playbackWatchdogStartedAt < PLAYBACK_GRACE_MS) {
            state = "unknown";
        }
        if (state === "playing") {
            playbackRecoveryStep = 0;
            clearPlaybackReloads();
        } else if (state === "stalled") {
            attemptPlaybackRecovery();
        }
        if (playbackWatchdogTimer !== null) {
            markNextCheck("atqNextPlaybackCheckAt", PLAYBACK_TICK_MS);
            playbackWatchdogTimer = setTimeout(tick, PLAYBACK_TICK_MS);
        }
    }

    markNextCheck("atqNextPlaybackCheckAt", PLAYBACK_TICK_MS);
    playbackWatchdogTimer = setTimeout(tick, PLAYBACK_TICK_MS);
}

function stopPlaybackWatchdog() {
    clearTimeout(playbackWatchdogTimer);
    playbackWatchdogTimer = null;
    sessionStorage.removeItem("atqNextPlaybackCheckAt");
}

var watchDropsReadPending = false;

// A bare channel page ("/name"), not /about
function isChannelPage() {
    var parts = window.location.pathname.split('/').filter(Boolean);
    return parts.length === 1 && parts[0] !== 'directory' && parts[0] !== 'drops';
}

function getWatchDropsDialog() {
    return document.querySelector('[role="dialog"][aria-label="Drops & More"]');
}

function watchDropsDialogTitle(dialog) {
    var t = dialog && dialog.querySelector('p.tw-title');
    return t ? t.textContent.trim() : null;
}

// Each bar's tile holds titled <p>s (reward, game) and untitled ones (requirement, time left)
function parseWatchDropsItems(dialog) {
    var items = [];
    dialog.querySelectorAll('[role="progressbar"]').forEach(function(bar) {
        var tile = bar.parentElement;
        while (tile && tile !== dialog && !tile.querySelector('p[title]')) tile = tile.parentElement;
        if (!tile || tile === dialog) return;
        var titled = tile.querySelectorAll('p[title]');
        var plain = Array.from(tile.querySelectorAll('p:not([title])'))
            .map(function(p) { return p.textContent.trim(); }).filter(Boolean);
        var percent = parseFloat(bar.getAttribute('aria-valuenow'));
        if (isNaN(percent)) return;
        items.push({
            name: titled[0].textContent.trim(),
            game: titled[1] ? titled[1].textContent.trim() : null,
            percent: percent,
            requirement: plain[0] || null,
            left: plain[1] || null
        });
    });
    return items;
}

// Reads Drops & More > Watch Drops, then restores the panel and chat state. ok:false = unreadable
function readWatchDropsPanel() {
    return new Promise(function(resolve) {
        var failed = { ok: false, items: [] };
        if (watchDropsReadPending || !isChannelPage() || !document.querySelector('[data-a-target="drops-button"]')) {
            resolve(failed);
            return;
        }
        watchDropsReadPending = true;
        var settled = false;
        var openedPanel = false;
        var expandedChat = false;
        var startedAt = Date.now();

        function finish(result) {
            if (settled) return;
            settled = true;
            clearTimeout(cap);
            var dialog = getWatchDropsDialog();
            if (openedPanel && dialog) {
                var close = dialog.querySelector('button[aria-label="Close"]');
                if (close) close.click();
            }
            if (expandedChat) {
                var toggle = document.querySelector('[data-a-target="right-column__toggle-collapse-btn"]');
                if (toggle && toggle.getAttribute('aria-label') === 'Collapse Chat') toggle.click();
            }
            watchDropsReadPending = false;
            if (result.ok) {
                GM_setValue('watchDropsSnapshot', { takenAt: Date.now(), channel: window.location.pathname, items: result.items });
            }
            popupText("Debug: Watch Drops read " + (result.ok ? "ok (" + result.items.length + " items)" : "FAILED") + " in " + (Date.now() - startedAt) + "ms");
            resolve(result);
        }
        var cap = setTimeout(function() { finish(failed); }, 15000);

        // Items can trail the view switch, so wait for a bar; a view with none is still a valid read
        function readWatchView() {
            waitForCondition(document.body, function() {
                if (settled) return true;
                var dialog = getWatchDropsDialog();
                if (!dialog || watchDropsDialogTitle(dialog) !== 'Watch Drops') return false;
                if (!dialog.querySelector('[role="progressbar"]')) return false;
                finish({ ok: true, items: parseWatchDropsItems(dialog) });
                return true;
            }, { pollMs: 250, timeoutMs: 5000, onTimeout: function() {
                var dialog = getWatchDropsDialog();
                if (dialog && watchDropsDialogTitle(dialog) === 'Watch Drops') finish({ ok: true, items: [] });
                else finish(failed);
            } });
        }

        function openWatchView() {
            var clickedHeader = false;
            waitForCondition(document.body, function() {
                if (settled) return true;
                var dialog = getWatchDropsDialog();
                if (!dialog) return false;
                if (watchDropsDialogTitle(dialog) === 'Watch Drops') { readWatchView(); return true; }
                if (clickedHeader) return false;
                var header = Array.from(dialog.querySelectorAll('[role="button"]')).find(function(h) {
                    return h.textContent.trim() === 'Watch Drops';
                });
                if (!header) return false;
                header.click();
                clickedHeader = true;
                return false;
            }, { pollMs: 250, timeoutMs: 5000, onTimeout: function() { finish(failed); } });
        }

        if (getWatchDropsDialog()) { openWatchView(); return; }

        var rightColumn = document.querySelector('.right-column');
        var chatToggle = document.querySelector('[data-a-target="right-column__toggle-collapse-btn"]');
        if (rightColumn && rightColumn.classList.contains('right-column--collapsed') && chatToggle) {
            chatToggle.click();
            expandedChat = true;
        }
        var clickedButton = false;
        waitForCondition(document.body, function() {
            if (settled) return true;
            if (getWatchDropsDialog()) { openWatchView(); return true; }
            if (!clickedButton) {
                var btn = document.querySelector('[data-a-target="drops-button"]');
                if (btn) { btn.click(); clickedButton = true; openedPanel = true; }
            }
            return false;
        }, { pollMs: 250, timeoutMs: 5000, onTimeout: function() { finish(failed); } });
    });
}

// The panel lists rewards, not campaigns, so match by drop name. Without names there is no telling
// this campaign's items from another campaign of the same game, so the inventory decides instead.
function watchDropsForCampaign(items, campaign) {
    var names = (campaign.drops || []).concat(campaign.nonWatchDrops || []);
    return items.filter(function(d) { return names.indexOf(d.name) !== -1; });
}

function runOfflineCheck() {
    var gn = sessionStorage.getItem("farmingGameName");
    var cn = sessionStorage.getItem("farmingCampaignName");
    if (!gn || !cn) { popupText("Debug: No active farming session"); return; }
    var streamAlive = checkCurrentStreamAlive();
    if (streamAlive === null) {
        // A page that never shows live or offline would otherwise be watched until the campaign ends
        var inconclusive = parseInt(sessionStorage.getItem("atqInconclusiveChecks") || "0") + 1;
        sessionStorage.setItem("atqInconclusiveChecks", String(inconclusive));
        popupText("Debug: Stream status inconclusive (" + inconclusive + "/3)");
        if (inconclusive >= 3) streamAlive = false;
    }
    if (streamAlive !== null) sessionStorage.removeItem("atqInconclusiveChecks");
    if (streamAlive === false) {
        stopInventoryChecking();
        var link = currentFarmingLink();
        if (gn === "__fallback__") {
            // Waiting on offline fallbacks still has to notice new campaigns
            if (!tryNextFallbackChannel()) runPriorityCheck();
        } else if (link && link.includes("/directory/category")) {
            // One offline streamer says nothing about the category, so pick another stream
            var skippedChannels = JSON.parse(sessionStorage.getItem("farmingSkipChannels") || "[]");
            var channel = channelLogin(window.location.href);
            if (channel && skippedChannels.indexOf(channel) === -1) {
                skippedChannels.push(channel);
                sessionStorage.setItem("farmingSkipChannels", JSON.stringify(skippedChannels));
            }
            popupText("Stream offline, picking another stream from the category");
            cleanRedirect(normalizeTwitchUrl(link));
        } else {
            popupText("Stream offline, trying next link");
            tryNextAvailableLink(gn, cn);
        }
    } else if (streamAlive) {
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
            if (higherFound === true) popupText("Higher priority campaign available. Returning to campaigns");
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

    function returnIfHigherPriority(onNone) {
        checkForHigherPriorityCampaign().then(function(higherFound) {
            if (higherFound) {
                stopInventoryChecking();
                if (higherFound === true) popupText("Higher priority campaign available. Returning to campaigns");
                cleanRedirect("https://www.twitch.tv/drops/campaigns");
            } else if (onNone) {
                onNone();
            }
        });
    }

    if (gameName === "__fallback__") {
        // Inventory first, so already-claimed higher priority campaigns can't pull us off the fallback
        loadInventoryPage().then(function(inv) {
            applyInventoryToTracker(inv);
            returnIfHigherPriority(null);
        });
        return;
    }

    popupText("Debug: Running inventory check for " + campaignName);
    var campaign = getFarmedCampaign(gameName, campaignName);
    if (!campaign) {
        stopInventoryChecking();
        popupText(campaignName + " is no longer tracked. Returning to campaigns");
        cleanRedirect("https://www.twitch.tv/drops/campaigns");
        return;
    }
    var noProgressCheckLimit = getDropSettings().noProgressCheckLimit;

    function evaluateProgress(currentProgress) {
        popupText("Current Progress: " + currentProgress);
        returnIfHigherPriority(function() {
            if (currentProgress === null) return;
            var lastProgress = sessionStorage.getItem("farmingLastProgress");
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
        });
    }

    // The Watch Drops panel shows reward progress too; the inventory decides what it can't
    readWatchDropsPanel().then(function(panel) {
        var items = panel.ok ? watchDropsForCampaign(panel.items, campaign) : [];
        if (items.length > 0 && items.some(function(d) { return d.percent < 100; })) {
            // The panel often stops updating after the first read, so only a change counts
            var panelProgress = "panel:" + items.map(function(d) { return d.percent; }).join(",");
            if (sessionStorage.getItem("farmingLastPanelProgress") !== panelProgress) {
                sessionStorage.setItem("farmingLastPanelProgress", panelProgress);
                sessionStorage.setItem("farmingPanelChangedAt", String(Date.now()));
                sessionStorage.removeItem("farmingStalledChecks");
                sessionStorage.removeItem("farmingNoProgressChecks");
                popupText("Current Progress: " + panelProgress);
                returnIfHigherPriority(null);
                return;
            }
            if (campaign.reward) {
                // The inventory never lists reward campaigns, so the panel is the only judge
                var changedAt = parseInt(sessionStorage.getItem("farmingPanelChangedAt") || "0");
                if (changedAt && Date.now() - changedAt > 30 * 60000) {
                    stopInventoryChecking();
                    popupText(campaignName + " Watch Drops unchanged for 30 min. Treating as stalled, trying next link");
                    tryNextAvailableLink(gameName, campaignName);
                    return;
                }
                popupText("Debug: " + campaignName + " Watch Drops unchanged, continuing to watch");
                returnIfHigherPriority(null);
                return;
            }
            popupText("Debug: " + campaignName + " Watch Drops unchanged, checking inventory");
            runInventoryFallback();
            return;
        }
        popupText("Debug: " + (panel.ok ? "No unfinished " + campaignName + " drops in Watch Drops" : "Watch Drops unreadable") + ", using inventory");
        runInventoryFallback();
    });

    function runInventoryFallback() {
        loadInventoryPage().then(function(inv) {
            if (!inv.ok) {
                // A failed read says nothing about the campaign; retry next tick
                popupText("Debug: Inventory check failed to read the page, skipping this tick");
                return;
            }
            applyInventoryToTracker(inv);
            var tracked = getFarmedCampaign(gameName, campaignName);
            if (!tracked || tracked.completed) {
                stopInventoryChecking();
                popupText("Campaign completed: " + campaignName + ". Returning to campaigns");
                cleanRedirect("https://www.twitch.tv/drops/campaigns");
                return;
            }

            var live = inv.campaigns.find(function(c) { return c.name === campaignName && sameEndDate(c.endDate, tracked.endDate); });
            if (!live && tracked.reward) {
                // Reward campaigns are never In Progress, so absence isn't a miss. Without a readable
                // Watch Drops panel there is no progress to see, so the same 30 minute limit applies.
                var since = parseInt(sessionStorage.getItem("farmingPanelChangedAt") || "0");
                if (since && Date.now() - since > 30 * 60000) {
                    stopInventoryChecking();
                    popupText(campaignName + " shows no progress for 30 min. Treating as stalled, trying next link");
                    tryNextAvailableLink(gameName, campaignName);
                    return;
                }
                popupText("Debug: " + campaignName + " is a reward campaign, not in Rewards yet, continuing to watch");
                returnIfHigherPriority(null);
                return;
            }
            if (!live) {
                // Not In Progress or claimed; needs consecutive strikes before giving up
                var missCount = parseInt(sessionStorage.getItem("farmingNoProgressChecks") || "0") + 1;
                if (missCount >= noProgressCheckLimit) {
                    sessionStorage.removeItem("farmingNoProgressChecks");
                    stopInventoryChecking();
                    popupText(campaignName + " not in inventory and not claimed. Treating as stalled, trying next link");
                    tryNextAvailableLink(gameName, campaignName);
                    return;
                }
                sessionStorage.setItem("farmingNoProgressChecks", String(missCount));
                popupText("Debug: " + campaignName + " not in inventory (" + missCount + "/" + noProgressCheckLimit + "), continuing to watch");
                returnIfHigherPriority(null);
                return;
            }

            sessionStorage.removeItem("farmingNoProgressChecks");
            var fingerprint = campaignProgressFingerprint(live);
            // Prefixed so switching between the panel and the inventory never reads as a stall
            evaluateProgress(fingerprint === null ? null : "inv:" + fingerprint);
        });
    }
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
    // The about page has no stream to watch; on an offline one the watchdog would start the VOD preview
    if (!window.location.pathname.endsWith('/about')) startPlaybackWatchdog();

    function offlineTick() {
        runOfflineCheck();
        if (offlineCheckInterval !== null) {
            markNextCheck("atqNextOfflineCheckAt", offlineCheckMinutes * 60000);
            offlineCheckInterval = setTimeout(offlineTick, offlineCheckMinutes * 60000);
        }
    }

    function iframeTick() {
        var elapsed = parseInt(sessionStorage.getItem("inventoryCheckElapsedMinutes") || "0") + 1;
        if (elapsed >= checkIntervalMinutes) {
            sessionStorage.setItem("inventoryCheckElapsedMinutes", "0");
            elapsed = 0;
            runInventoryCheck();
        } else {
            sessionStorage.setItem("inventoryCheckElapsedMinutes", String(elapsed));
        }
        if (inventoryCheckInterval !== null) {
            markNextCheck("atqNextInventoryCheckAt", (checkIntervalMinutes - elapsed) * 60000);
            inventoryCheckInterval = setTimeout(iframeTick, 60000);
        }
    }

    var startElapsed = parseInt(sessionStorage.getItem("inventoryCheckElapsedMinutes") || "0");
    markNextCheck("atqNextOfflineCheckAt", offlineCheckMinutes * 60000);
    markNextCheck("atqNextInventoryCheckAt", Math.max(1, checkIntervalMinutes - startElapsed) * 60000);
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
    sessionStorage.removeItem("farmingStallCampaigns");
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
    // Capped: an unbounded log hits the storage quota and setItem throws mid-farming
    try {
        var past = sessionStorage.getItem("ATQPermaLog");
        var entries = past ? past.split(" /// ") : [];
        entries.push(detailedString);
        if (entries.length > 1500) entries = entries.slice(-1500);
        sessionStorage.setItem("ATQPermaLog", entries.join(" /// "));
    } catch (e) {
        console.error("[ATQ] Could not write ATQPermaLog", e);
    }
    removeConfirmPopup();
    var box = document.createElement("div");
    box.id = "userscriptPopupWindow";
    box.textContent = string;
    // Offset below the Progress Manager launcher so the two never overlap
    box.style.cssText = "position:fixed; top:64px; left:16px; z-index:999991; max-width:300px; padding:10px 14px; background-color:#333; color:#fff; border-radius:6px; font-size:13px; line-height:1.5; word-wrap:break-word; white-space:normal; cursor:pointer; transform:translateX(calc(-100% - 16px)); transition:transform 0.35s ease; box-sizing:border-box;";
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
        } else if (locationContains("/drops/campaigns")) {
            // Those keys outlive their stream; without this the campaigns page is sent back to it after 30s
            removeConfirmPopup();
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
    // Any offline player, not just the "Check out this stream" variant shown when a recent VOD exists
    var offlineText = $('.channel-root__player--offline');
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
    } else if (!isOnChannel(startingChannelAboutRemover) && !isOnChannel(currentTargetLocation)) {
        popupText("Twitch: Moved away from stream page");
        return resetLocation();
    }
}

// Same channel as url, ignoring case, subpages and query strings
function isOnChannel(url) {
    var here = channelLogin(window.location.href);
    return !!here && here === channelLogin(url);
}

function twitchCategoryWatcher() {
    // Go through live streams with drops and click the first one available
    resetToLocation = window.location.href;
    sessionStorage.setItem("twitchWatchedCategory", resetToLocation);
    var liveStreamList = $(".preview-card-image-link");

    if (liveStreamList.length == 0 && noDropStreamsAvailable == null) {
        popupText("Twitch: noDropStreamsAvailable = setTimeout(categoryEmpty, 300000);");
        noDropStreamsAvailable = setTimeout(categoryEmpty, 300000);
    } else if (liveStreamList.length != 0) {
        if (noDropStreamsAvailable != null) {
            popupText("Twitch: resetTimeout(noDropStreamsAvailable);");
            noDropStreamsAvailable = resetTimeout(noDropStreamsAvailable);
        }
        // Streams that already failed for this campaign are passed over
        var skippedChannels = JSON.parse(sessionStorage.getItem("farmingSkipChannels") || "[]");
        for (var i = 0; i < liveStreamList.length; i++) {
            if (typeof liveStreamList[i] != "undefined" && skippedChannels.indexOf(channelLogin(liveStreamList.eq(i).attr("href"))) === -1) {
                // twitchCheckDisruptions uses storedCurrentTarget here to check for leaving the target stream after refresh 
                currentTargetLocation = "https://www.twitch.tv" + liveStreamList.eq(i).attr("href");
                sessionStorage.setItem("storedCurrentTarget", currentTargetLocation);
                resetToLocation = currentTargetLocation;
                popupText("Twitch: Found stream with drops, going to stream");
                return resetLocation();
            }
        }
        if (skippedChannels.length > 0) {
            popupText("Every stream in the category has already failed");
            loopingInterval = resetInterval(loopingInterval);
            categoryEmpty();
        }
    }
}

// While farming, treat an empty category like an offline stream instead of reloading it
function categoryEmpty() {
    var gn = sessionStorage.getItem("farmingGameName");
    var cn = sessionStorage.getItem("farmingCampaignName");
    if (sessionStorage.getItem("AutoTwitchQueuerAutoFarmCampaigns") == "true" && gn && cn) {
        if (gn === "__fallback__") {
            if (tryNextFallbackChannel()) return;
        } else {
            popupText("No live drop streams in category, trying next link");
            tryNextAvailableLink(gn, cn);
            return;
        }
    }
    resetLocation();
}

function twitchCategoryChannelWatcher() {
    // If script is watching a category, check for the right game; if not present, return to stream list
    var currentGame = resetToLocation.replace("https://www.twitch.tv/","").replace("?filter=drops&sort=VIEWER_COUNT","");
    currentGame = $("[href*='"+currentGame+"']").prop("href") + "?filter=drops&sort=VIEWER_COUNT";
    if (currentGame != "undefined?filter=drops&sort=VIEWER_COUNT" && infoLoaded == false) {
        // Waits for the stream's game link to load in the first place
        infoLoaded = true;
    } else if (infoLoaded == true && currentGame != resetToLocation) {
        // If the current game is not the game you started with, go back to the game list
        popupText("Twitch: currentGame != resetToLocation");
        return resetLocation();
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

// Waits until predicate() returns true. Polls as well as observing, since a hidden tab stops mutating; settled lets only one trigger win
function waitForCondition(root, predicate, options) {
    options = options || {};
    var pollMs = options.pollMs || 1000;
    var timeoutMs = options.timeoutMs || 0;
    var onTimeout = options.onTimeout || null;
    var settled = false;
    var observer = null;
    var pollTimer = null;
    var deadline = null;

    function cleanup() {
        if (observer) { observer.disconnect(); observer = null; }
        if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
        if (deadline !== null) { clearTimeout(deadline); deadline = null; }
    }

    // fromMutation lets debouncing predicates ignore poll ticks
    function attempt(fromMutation) {
        if (settled) return true;
        var done = false;
        try {
            done = predicate(!!fromMutation);
        } catch (e) {
            console.error("[ATQ] waitForCondition predicate failed", e);
        }
        if (done) { settled = true; cleanup(); }
        return settled;
    }

    if (attempt(false)) return;

    observer = new MutationObserver(function() { attempt(true); });
    observer.observe(root, { childList: true, subtree: true });
    pollTimer = setInterval(function() { attempt(false); }, pollMs);
    if (timeoutMs > 0) {
        deadline = setTimeout(function() {
            if (settled) return;
            settled = true;
            cleanup();
            if (onTimeout) onTimeout();
        }, timeoutMs);
    }
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
