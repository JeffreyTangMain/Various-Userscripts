// ==UserScript==
// @name         Auto Twitch Queuer
// @namespace    https://github.com/
// @version      1.9.1
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
GM_registerMenuCommand("Campaign Manager", openCampaignManager);

var currentDate = new Date();
var currentDateString = currentDate.toLocaleDateString("en-CA");
var scheduleList = [];
var joiner = ",";
var scheduleTimeout;
var inventoryCheckInterval;
var currentFarmingGame = null;
var currentFarmingCampaign = null;
var inventoryIframe = null;
var campaignsIframe = null;

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

function getInventoryIframe() {
    if (inventoryIframe && inventoryIframe.parentNode) return inventoryIframe;
    inventoryIframe = createHiddenIframe('https://www.twitch.tv/drops/inventory');
    return inventoryIframe;
}

function getCampaignsIframe() {
    if (campaignsIframe && campaignsIframe.parentNode) return campaignsIframe;
    campaignsIframe = createHiddenIframe('https://www.twitch.tv/drops/campaigns');
    return campaignsIframe;
}

function checkForHigherPriorityCampaign() {
    return new Promise(function(resolve) {
        var farmingIdx = parseInt(sessionStorage.getItem("farmingGameIdx") || "-1");
        if (farmingIdx <= 0) { resolve(false); return; }
        var list = getDropList();
        var higherPriorityGames = list.slice(0, farmingIdx);
        var higherPriorityNames = higherPriorityGames.map(function(g) { return g.name; });
        if (higherPriorityNames.length === 0) { resolve(false); return; }
        var iframe = getCampaignsIframe();
        function cleanup() {
            if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
            campaignsIframe = null;
        }
        function doCheck() {
            try {
                var doc = iframe.contentDocument || iframe.contentWindow.document;
                if (!doc || !doc.body) { cleanup(); resolve(false); return; }
                var accordionBtns = doc.querySelectorAll('button[aria-expanded]');
                var tracker = getDropsTracker();
                var found = Array.from(accordionBtns).some(function(btn) {
                    var pEl = btn.querySelector('p');
                    if (!pEl) return false;
                    var gameName = pEl.textContent.trim();
                    if (!higherPriorityNames.includes(gameName)) return false;
                    var trackedCampaigns = tracker[gameName];
                    var allCompleted = trackedCampaigns && trackedCampaigns.length > 0 && trackedCampaigns.every(function(c) { return c.completed; });
                    return !allCompleted;
                });
                cleanup();
                resolve(found);
            } catch(e) {
                cleanup();
                resolve(false);
            }
        }
        var timeout = setTimeout(function() {
            cleanup();
            resolve(false);
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
        var iframe = getInventoryIframe();
        function cleanup() {
            if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
            inventoryIframe = null;
        }
        function doCheck() {
            try {
                var doc = iframe.contentDocument || iframe.contentWindow.document;
                if (!doc || !doc.body) {
                    cleanup();
                    resolve({ exists: true, progress: null });
                    return;
                }
                var inventoryItems = doc.querySelectorAll('.inventory-campaign-info');
                if (inventoryItems.length === 0) {
                    cleanup();
                    resolve({ exists: true, progress: null });
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
                cleanup();
                resolve({ exists: found, progress: progress });
            } catch(e) {
                cleanup();
                resolve({ exists: true, progress: null });
            }
        }
        var timeout = setTimeout(function() {
            cleanup();
            resolve({ exists: true, progress: null });
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
            .atq-settings { background:#0e0e10; border:1px solid #2a2a35; border-radius:6px; padding:9px 12px; margin-bottom:10px; display:flex; flex-direction:column; gap:7px; }
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

    var settingsDiv = document.createElement('div');
    settingsDiv.className = 'atq-settings';

    var checkInput = mkInput('number', settings.checkIntervalMinutes || 10, 'atq-input-num');
    var r1 = document.createElement('div');
    r1.className = 'atq-row';
    r1.appendChild(mkLabel('Drop Check Minutes:')); r1.appendChild(checkInput);

    var fallbackInput = mkInput('text', settings.fallbackChannel || '', 'atq-input-url');
    fallbackInput.placeholder = 'Fallback channel URL';
    var fallbackMinInput = mkInput('number', settings.fallbackMinutes || 30, 'atq-input-num');
    var r2 = document.createElement('div');
    r2.className = 'atq-row';
    r2.appendChild(mkLabel('Fallback')); r2.appendChild(fallbackInput);
    r2.appendChild(mkLabel('for')); r2.appendChild(fallbackMinInput); r2.appendChild(mkLabel('min'));

    settingsDiv.appendChild(r1);
    settingsDiv.appendChild(r2);
    outer.appendChild(settingsDiv);

    var tabsDiv = document.createElement('div');
    tabsDiv.className = 'atq-tabs';
    var priorityTabBtn = mkBtn('Priority', function() { setTab('priority'); }, 'atq-tab');
    var trackerTabBtn = mkBtn('Tracker', function() { setTab('tracker'); }, 'atq-tab');
    tabsDiv.appendChild(priorityTabBtn);
    tabsDiv.appendChild(trackerTabBtn);
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
            fallbackChannel: fallbackInput.value.trim(),
            fallbackMinutes: parseInt(fallbackMinInput.value) || 30
        });
        popupText('Settings saved');
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

    function renderTracker() {
        contentArea.innerHTML = '';
        var tracker = getDropsTracker();
        if (!tracker || typeof tracker !== 'object') { tracker = {}; setDropsTracker(tracker); }
        var gameNames = Object.keys(tracker).sort();
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
            var campaigns = tracker[gameName];
            if (!Array.isArray(campaigns)) { tracker[gameName] = []; campaigns = []; }
            campaigns.forEach(function(campaign) {
                var item = document.createElement('div');
                item.className = 'atq-item';
                var lbl = document.createElement('span');
                lbl.className = 'atq-item-label' + (campaign.completed ? ' done' : '');
                lbl.textContent = campaign.name + '  —  ends ' + campaign.endDate;
                item.appendChild(mkBtn(campaign.completed ? 'Unmark' : 'Mark Done', function() {
                    var newState = !campaign.completed;
                    markCampaignCompleted(gameName, campaign.name, newState);
                    popupText((newState ? 'Completed: ' : 'Unmarked: ') + campaign.name);
                    renderTracker();
                }, 'atq-btn atq-btn-sm'));
                item.appendChild(lbl);
                item.appendChild(mkBtn('✕', function() {
                    var name = campaign.name;
                    deleteCampaignFromTracker(gameName, name);
                    popupText('Deleted: ' + name);
                    renderTracker();
                }, 'atq-btn atq-btn-icon atq-btn-danger'));
                contentArea.appendChild(item);
            });
        });
    }

    function setTab(tab) {
        priorityTabBtn.classList.toggle('atq-active', tab === 'priority');
        trackerTabBtn.classList.toggle('atq-active', tab === 'tracker');
        footer.innerHTML = '';
        if (tab === 'priority') {
            renderPriority();
            footer.appendChild(mkBtn('Save Settings', saveSettings, 'atq-btn atq-btn-primary'));
        } else {
            renderTracker();
            footer.appendChild(mkBtn('Delete Expired', function() {
                var before = Object.values(getDropsTracker()).reduce(function(s, a) { return s + a.length; }, 0);
                deleteExpiredFromTracker();
                var after = Object.values(getDropsTracker()).reduce(function(s, a) { return s + a.length; }, 0);
                var n = before - after;
                renderTracker();
                popupText(n > 0 ? 'Deleted ' + n + ' expired campaign' + (n !== 1 ? 's' : '') + '.' : 'No expired campaigns to delete');
            }, 'atq-btn atq-btn-sm'));
            footer.appendChild(mkBtn('Delete All', function() {
                if (confirm('Delete all tracked campaigns?')) {
                    deleteAllFromTracker();
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

function injectDropButtons() {
    var observer = new MutationObserver(function() {
        var header = Array.from(document.querySelectorAll('h4')).find(el => el.textContent.trim() === "Open Drop Campaigns");
        if(!header) return;
        var campaignContainer = findCampaignContainer(header);
        if(!campaignContainer) return;
        observer.disconnect();
        renderDropButtons(campaignContainer);
        if(sessionStorage.getItem("AutoTwitchQueuerAutoFarmCampaigns") == "true" && window.location.pathname === "/drops/campaigns") {
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
        var header = row.querySelector('.accordion-header, [role="heading"]');
        if(!header) return;
        var btn = document.createElement('button');
        btn.className = 'atq-drop-btn';
        btn.style.cssText = "position:absolute; left:6px; top:50%; transform:translateY(-50%); z-index:9999; width:22px; height:22px; border:none; border-radius:4px; font-size:15px; font-weight:700; line-height:1; cursor:pointer; transition:background 0.12s, color 0.12s; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; display:flex; align-items:center; justify-content:center;";
        updateDropBtn(btn, gameName);
        btn.addEventListener('mouseenter', function() { btn.style.background = '#9147ff'; btn.style.color = '#fff'; });
        btn.addEventListener('mouseleave', function() { updateDropBtn(btn, gameName); });
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleDropGame(gameName);
            updateDropBtn(btn, gameName);
        });
        header.style.position = 'relative';
        var accordionToggle = header.querySelector('button');
        if(accordionToggle) accordionToggle.style.paddingLeft = '2.5rem';
        header.appendChild(btn);
    });
}

function updateDropBtn(btn, gameName) {
    var inList = getDropList().some(g => g.name === gameName);
    btn.textContent = inList ? '−' : '+';
    btn.style.background = inList ? '#1a0a2e' : '#2a2a35';
    btn.style.color = inList ? '#9147ff' : '#adadb8';
}

function getDropList() {
    return GM_getValue('dropGameList', []);
}

function getDropSettings() {
    return GM_getValue('dropSettings', { checkIntervalMinutes: 10, fallbackChannel: '', fallbackMinutes: 30 });
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
    var fallback = getDropSettings().fallbackChannel;
    if (fallback) {
        queueFallbackChannel(fallback);
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
        window.location.assign("https://www.twitch.tv/drops/campaigns");
    }
}

function autoFarmCampaigns() {
    stopInventoryChecking();
    sessionStorage.removeItem("inventoryCheckElapsedMinutes");
    if(window.location.pathname !== "/drops/campaigns") {
        popupText("Returning to Campaigns page to farm");
        window.location.assign("https://www.twitch.tv/drops/campaigns");
        return;
    }
    var list = getDropList();
    if(list.length === 0) {
        useFallbackOr("No campaigns in priority list");
        return;
    }
    var stallSameGame = sessionStorage.getItem("farmingStallSameGame");
    var stallNextIdx = sessionStorage.getItem("farmingStallNextIdx");
    if (stallSameGame !== null) {
        sessionStorage.removeItem("farmingStallSameGame");
        farmNextPriority(list, parseInt(stallSameGame));
    } else if (stallNextIdx !== null) {
        sessionStorage.removeItem("farmingStallNextIdx");
        sessionStorage.removeItem("farmingSkipCampaigns");
        sessionStorage.setItem("farmingIsStallFallback", "true");
        farmNextPriority(list, parseInt(stallNextIdx));
    } else {
        sessionStorage.removeItem("farmingIsStallFallback");
        sessionStorage.removeItem("farmingSkipCampaigns");
        farmNextPriority(list, 0);
    }
}

function farmNextPriority(list, idx) {
    if(idx >= list.length) {
        currentFarmingGame = null;
        currentFarmingCampaign = null;
        stopInventoryChecking();
        useFallbackOr("All priority games completed");
        return;
    }
    var game = list[idx];
    currentFarmingGame = game.name;
    var header = Array.from(document.querySelectorAll('h4')).find(el => el.textContent.trim() === "Open Drop Campaigns");
    if(!header) {
        popupText("Could not find campaigns list");
        return;
    }
    var campaignContainer = findCampaignContainer(header);
    if(!campaignContainer) {
        popupText("Could not find campaigns list");
        return;
    }
    var rows = Array.from(campaignContainer.children);
    var matchingRows = rows.filter(function(row) {
        var nameEl = row.querySelector('p');
        return nameEl && nameEl.textContent.trim() === game.name;
    });
    if(matchingRows.length === 0) {
        popupText("Campaign not found on page: " + game.name);
        farmNextPriority(list, idx + 1);
        return;
    }
    var toLoad = matchingRows.filter(function(r) {
        return !r.querySelector('.drop-details__label');
    });
    if(toLoad.length === 0) {
        parseAllCampaignsAndQueue(game, matchingRows, list, idx);
        return;
    }
    var loadedCount = 0;
    toLoad.forEach(function(r) {
        var parseTimer = null;
        var accordionBtn = r.querySelector('button');
        var isExpanded = accordionBtn && accordionBtn.getAttribute('aria-expanded') === 'true';
        var detailObserver = new MutationObserver(function() {
            if(!r.querySelector('.drop-details__label')) return;
            clearTimeout(parseTimer);
            parseTimer = setTimeout(function() {
                detailObserver.disconnect();
                loadedCount++;
                if(loadedCount >= toLoad.length) {
                    parseAllCampaignsAndQueue(game, matchingRows, list, idx);
                }
            }, 500);
        });
        detailObserver.observe(r, { childList: true, subtree: true });
        if(!isExpanded && accordionBtn) {
            accordionBtn.click();
        }
    });
}

function parseAllCampaignsAndQueue(game, matchingRows, list, idx) {
    var campaigns = parseCampaignsFromRow(matchingRows);
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
    if (uncompleted.length === 0) {
        popupText("All campaigns completed for: " + game.name + ", moving to next");
        sessionStorage.removeItem("farmingSkipCampaigns");
        farmNextPriority(list, idx + 1);
        return;
    }
    var skipList = JSON.parse(sessionStorage.getItem("farmingSkipCampaigns") || "[]");
    var farmable = uncompleted.filter(function(c) { return !skipList.includes(c.name); });
    if (farmable.length === 0) {
        sessionStorage.removeItem("farmingSkipCampaigns");
        sessionStorage.setItem("farmingStallNextIdx", String(idx + 1));
        sessionStorage.setItem("farmingIsStallFallback", "true");
        popupText("All campaign links stalled for " + game.name + ". Trying lower priority game");
        window.location.assign("https://www.twitch.tv/drops/campaigns");
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
    currentFarmingCampaign = farmableCampaign;
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

function queueCampaignStream(game, matchingRows, campaign, list, idx) {
    var rows = Array.isArray(matchingRows) ? matchingRows : [matchingRows];
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
    var targetBlock = null;
    if (matchingStrong) {
        var el = matchingStrong.parentElement;
        while (el && el !== campaignRow) {
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
    var firstLi = items[0];
    var links = Array.from(firstLi.querySelectorAll('a'));
    var streamHref = links.length > 0 ? links[links.length - 1].getAttribute('href') : null;
    if(!streamHref) {
        popupText("No stream link found for: " + campaign.name);
        return;
    }
    sessionStorage.setItem("farmingAllLinks", JSON.stringify(links.map(function(l) { return l.getAttribute('href'); })));
    sessionStorage.setItem("farmingLinkIndex", String(links.length - 1));
    sessionStorage.removeItem("farmingLastProgress");
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
    sessionStorage.removeItem("farmingIsStallFallback");
    sessionStorage.removeItem("farmingStallNextIdx");
    sessionStorage.removeItem("farmingSkipCampaigns");
    sessionStorage.removeItem("farmingStallSameGame");
}

function queueFallbackChannel(channelUrl) {
    var settings = getDropSettings();
    var watchMinutes = settings.fallbackMinutes || 30;
    clearFarmingSessionState();
    queueStreamFor(normalizeTwitchUrl(channelUrl), watchMinutes);
    popupText("No drops available. Going to fallback for " + watchMinutes + " min");
    processSchedule();
}

function tryNextAvailableLink(gameName, campaignName) {
    var allLinks = JSON.parse(sessionStorage.getItem("farmingAllLinks") || "[]");
    var linkIndex = parseInt(sessionStorage.getItem("farmingLinkIndex") || "-1");
    var nextIndex = linkIndex - 1;
    while (nextIndex >= 0 && allLinks[nextIndex] && allLinks[nextIndex].includes("/directory/category")) {
        nextIndex--;
    }
    if (nextIndex >= 0 && allLinks[nextIndex]) {
        var nextHref = allLinks[nextIndex];
        var nextUrl = nextHref.startsWith('http') ? nextHref : "https://www.twitch.tv" + nextHref;
        sessionStorage.setItem("farmingLinkIndex", String(nextIndex));
        sessionStorage.removeItem("farmingLastProgress");
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
        sessionStorage.removeItem("farmingAllLinks");
        sessionStorage.removeItem("farmingLinkIndex");
        popupText("All links stalled for " + campaignName + ". Trying next campaign");
        window.location.assign("https://www.twitch.tv/drops/campaigns");
    }
}

function stopInventoryChecking() {
    clearTimeout(inventoryCheckInterval);
    inventoryCheckInterval = null;
}

function startInventoryChecking() {
    stopInventoryChecking();
    var settings = getDropSettings();
    var checkIntervalMinutes = settings.checkIntervalMinutes || 10;
    var gameName = sessionStorage.getItem("farmingGameName");
    var campaignName = sessionStorage.getItem("farmingCampaignName");
    if (!gameName || !campaignName) return;
    popupText("Starting inventory checks every " + checkIntervalMinutes + " min");

    function runInventoryCheck() {
        var campaign = getDropsTracker()[gameName]?.find(c => c.name === campaignName);
        if (!campaign) {
            stopInventoryChecking();
            return;
        }
        checkInventoryForCampaign(campaignName, campaign.endDate).then(function(result) {
            if (!result.exists) {
                markCampaignCompleted(gameName, campaignName, true);
                stopInventoryChecking();
                popupText("Campaign completed: " + campaignName + ". Returning to campaigns");
                window.location.assign("https://www.twitch.tv/drops/campaigns");
            } else {
                checkForHigherPriorityCampaign().then(function(higherFound) {
                    if (higherFound && sessionStorage.getItem("farmingIsStallFallback") !== "true") {
                        stopInventoryChecking();
                        popupText("Higher priority campaign available. Returning to campaigns");
                        window.location.assign("https://www.twitch.tv/drops/campaigns");
                    } else {
                        var currentProgress = result.progress;
                        var lastProgress = sessionStorage.getItem("farmingLastProgress");
                        if (currentProgress !== null) {
                            sessionStorage.setItem("farmingLastProgress", currentProgress);
                            if (lastProgress !== null && currentProgress === lastProgress) {
                                var storedLinks = JSON.parse(sessionStorage.getItem("farmingAllLinks") || "[]");
                                var isCategory = storedLinks.length > 0 && storedLinks[storedLinks.length - 1].includes("/directory/category");
                                if (!isCategory) {
                                    stopInventoryChecking();
                                    tryNextAvailableLink(gameName, campaignName);
                                }
                            }
                        }
                    }
                });
            }
        });
    }

    function tick() {
        var elapsed = parseInt(sessionStorage.getItem("inventoryCheckElapsedMinutes") || "0") + 1;
        if (elapsed >= checkIntervalMinutes) {
            sessionStorage.setItem("inventoryCheckElapsedMinutes", "0");
            runInventoryCheck();
        } else {
            sessionStorage.setItem("inventoryCheckElapsedMinutes", String(elapsed));
        }
        if (inventoryCheckInterval !== null) {
            inventoryCheckInterval = setTimeout(tick, 60000);
        }
    }

    inventoryCheckInterval = setTimeout(tick, 60000);
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

function duplicateLine() {
    scheduleList = getScheduleInput();
    if(scheduleList.length < 2) return null;
    scheduleList.push(...scheduleList.slice(-2));
    setScheduleInput(scheduleList);
}

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
        scheduleTimeout = setTimeout(processSchedule, timeDiff + 100);
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
    window.location.assign(nextWebsite);
}

function cancelQueue() {
    clearTimeout(scheduleTimeout);
    stopInventoryChecking();
    if (inventoryIframe && inventoryIframe.parentNode) {
        inventoryIframe.parentNode.removeChild(inventoryIframe);
        inventoryIframe = null;
    }
    if (campaignsIframe && campaignsIframe.parentNode) {
        campaignsIframe.parentNode.removeChild(campaignsIframe);
        campaignsIframe = null;
    }
    document.getElementById("TwitchScheduleOuterWrapper")?.remove();
    sessionStorage.removeItem("scheduleStorage");
    clearFarmingSessionState();
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
