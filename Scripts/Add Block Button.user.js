// ==UserScript==
// @name         Add Block button
// @namespace    https://github.com/
// @version      1.2
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
        if(this.closest("div").getElementsByClassName("flat-list").length != 0 && $(this).closest("div").find(".flat-list").find("#userscript-block-button").length <= 0){
            let id = this.className.split(" ").find((element) => element.includes("id-")).replace("id-","");
            this.closest("div").getElementsByClassName("flat-list")[0].insertAdjacentHTML("beforeend",'<li id="userscript-block-button"><form class="toggle block_user-button " action="#" method="get"><input type="hidden" name="executed" value="blocked"><input type="hidden" name="account_id" value="'+id+'"><span class="option main active"><a href="#" class="togglebutton access-required" onclick="return toggle(this)">block '+id+'</a></span><span class="option error">are you sure?  <a href="javascript:void(0)" class="yes" onclick="change_state(this, &quot;block_user&quot;, null, undefined, null)">yes</a> / <a href="javascript:void(0)" class="no" onclick="return toggle(this)">no</a></span></form></li>');
        }
    });
}
