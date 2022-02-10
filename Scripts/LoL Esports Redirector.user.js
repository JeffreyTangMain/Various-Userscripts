// ==UserScript==
// @name         LoL Esports Redirector
// @namespace    https://lolesports.com/
// @version      3.14
// @description  Redirects the schedule to the livestream so you're always watching when it's available.
// @author       Main
// @match        https://lolesports.com/schedule*
// @match        https://lolesports.com/live/*
// @require http://code.jquery.com/jquery-3.4.1.min.js
// @require https://cdn.jsdelivr.net/gh/CoeJoder/waitForKeyElements.js@v1.2/waitForKeyElements.js
// ==/UserScript==
// Documenting globals for JSHint to not throw an error for JQuery's $ function
/* globals $ waitForKeyElements */

var redirectPathCheck = '/live';

if(window.location.toString().indexOf('/schedule') != -1){
    waitForKeyElements('.Event', mainMethod);
} else{
    window.onload = mainMethod;
}

function mainMethod(){
    liveClicker(function(){setTimeout(function(){window.location.href = 'https://lolesports.com/schedule'}, 600000)});
}

function liveClicker(method, loop){
    var liveButton = document.querySelector (
        'a.live'
    );
    if(liveButton == undefined && window.location.toString().indexOf(redirectPathCheck) == -1){
        return method();
    } else{
        if(liveButton != undefined){
            liveButton.click();
        }
        if(loop != undefined){
            clearInterval(loop);
        }
        var manualTimer = 0;
        var rewardCheck = setInterval(function() {
            manualTimer > 10 ? null : manualTimer++;
            var rewardsIcon = $('.RewardsStatusInformer .status-summary svg path').attr('d');
            if(window.location.toString().indexOf(redirectPathCheck) == -1){
                liveClicker(function(){window.location.href = 'https://lolesports.com/schedule'}, rewardCheck);
            } else if(rewardsIcon != 'M14.75,8.5 L10.25,13 L8.5,11.25 L7,12.75 L10.25,16 L16.25,10 L14.75,8.5 Z M12,19 C8.14,19 5,15.859 5,12 C5,8.14 8.14,5 12,5 C15.859,5 19,8.14 19,12 C19,15.859 15.859,19 12,19 Z M12,3 C7.029,3 3,7.029 3,12 C3,16.971 7.029,21 12,21 C16.971,21 21,16.971 21,12 C21,7.029 16.971,3 12,3 Z' &&
                      manualTimer > 10){
                window.location.href = 'https://lolesports.com/schedule';
            } else if(document.readyState == 'complete'){
                if($('.drops-fulfilled').length){
                    var closeReward = document.querySelector (
                        '.drops-fulfilled .actions .close'
                    );
                    closeReward.click();
                }
            }
        }, 1000);
    }
}
