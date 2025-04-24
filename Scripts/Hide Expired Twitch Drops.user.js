// ==UserScript==
// @name         Hide Expired Twitch Drops
// @namespace    https://www.twitch.tv/drops/
// @version      1.0
// @description  Hide Expired Twitch Drops
// @author       Main
// @match        https://www.twitch.tv/drops/inventory
// @icon         https://www.google.com/s2/favicons?sz=64&domain=twitch.tv
// @require      http://code.jquery.com/jquery-3.4.1.min.js
// @grant        GM_addStyle
// ==/UserScript==
/* globals $ */

GM_addStyle(
    '.DropsHideExpired {' +
    'display: none !important;' +
    '}'
);

main();
async function main() {
    const elm = await waitForElm(".inventory-max-width");
    var expiredDrops = $(".inventory-max-width").children("*:contains('This reward is no longer available')");
    expiredDrops.addClass("DropsHideExpired");
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
