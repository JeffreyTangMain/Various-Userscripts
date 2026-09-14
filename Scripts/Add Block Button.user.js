// ==UserScript==
// @name         Add Block button
// @namespace    https://github.com/
// @version      1.3
// @description  Adds block button to comments and posts
// @author       Main
// @match        https://*.reddit.com/*
// @exclude      https://*.reddit.com/user/*
// @exclude      https://*.reddit.com/message/inbox/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=reddit.com
// @grant        none
// ==/UserScript==
// Documenting globals for JSHint to not throw an error for JQuery's $ function
/* globals $ */
// @require      http://code.jquery.com/jquery-3.4.1.min.js

setInterval(addBlocks,2000);
//addBlocks();

function addBlocks() {
    $(".tagline .author").each(function(index){
        let entry = this.closest(".entry");
        if(!entry) return;
        let buttons = entry.getElementsByClassName("flat-list")[0];
        if(buttons && !buttons.querySelector(".userscript-block-button")){
            let idClass = this.className.split(" ").find((element) => element.startsWith("id-t2_"));
            if(!idClass) return;
            let id = idClass.replace("id-","");
            buttons.insertAdjacentHTML("beforeend",'<li class="userscript-block-button"><form class="toggle block_user-button " action="#" method="get"><input type="hidden" name="executed" value="blocked"><input type="hidden" name="account_id" value="'+id+'"><span class="option main active"><a href="#" class="togglebutton access-required" onclick="return toggle(this)">block '+id+'</a></span><span class="option error">are you sure?  <a href="javascript:void(0)" class="yes" onclick="change_state(this, &quot;block_user&quot;, null, undefined, null)">yes</a> / <a href="javascript:void(0)" class="no" onclick="return toggle(this)">no</a></span></form></li>');
        }
    });
}
