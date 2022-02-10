// ==UserScript==
// @name         Close Tab on Invalid Invite
// @namespace    https://discord.com/invite/
// @version      1
// @description  Closes Chrome Tab when a Discord Invite is Invalid
// @author       Main
// @match        https://discord.com/invite/*
// @require http://code.jquery.com/jquery-3.4.1.min.js
// @grant        none
// ==/UserScript==
 
(function() {
    'use strict';
 
    var checkExist = setInterval(function() {
        if ($('.image-2dZWJQ').length) {
            window.close();
        }
    }, 100);
})();
