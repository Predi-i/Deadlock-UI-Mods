(function() {
    'use strict';

    var CONFIG = {
        FIRST_ALERT: 290,       // 4:50
        INTERVAL: 300,          // 5 Min
        ALERT_WINDOW: 2,        
        POLL_RATE: 0.1,         
        POLL_RATE_IDLE: 1.0,    
        SOUND_NAME: "BuffReminder.Alarm"
    };

    var State = {
        clockPanel: null,
        lastAlertTime: -1
    };

    function getRoot() {
        var ctx = $.GetContextPanel();
        if (!ctx) return null;
        var top = ctx;
        while (top.GetParent()) { 
            top = top.GetParent(); 
        }
        return top.FindChildTraverse("Hud") || top;
    }

    function isModeIgnored(root) {
        if (!root || !root.BHasClass) return false;
        
        if (root.BHasClass("connectedToHideout") || root.BHasClass("InHideout")) return true;
        if (root.BHasClass("gamemode_streetbrawl")) return true;
        
        return false;
    }

    function getCurrentTime(root) {
        if (!State.clockPanel || !State.clockPanel.IsValid()) {
            State.clockPanel = root.FindChildTraverse("GameTime");
            if (!State.clockPanel) return 0;
        }

        var text = State.clockPanel.text;
        if (!text) return 0;

        var parts = text.split(':');
        if (parts.length !== 2) return 0;

        var min = parseInt(parts[0], 10);
        var sec = parseInt(parts[1], 10);

        if (isNaN(min) || isNaN(sec)) return 0;
        
        return (min * 60) + sec;
    }

    function loop() {
        var root = getRoot();

        if (isModeIgnored(root)) {
            State.lastAlertTime = -1;
            $.Schedule(CONFIG.POLL_RATE_IDLE, loop);
            return;
        }

        var currentTime = getCurrentTime(root);

        if (currentTime === 0) {
             $.Schedule(CONFIG.POLL_RATE, loop);
             return;
        }

        if (currentTime < State.lastAlertTime) {
            State.lastAlertTime = -1;
        }

        if (currentTime >= CONFIG.FIRST_ALERT) {
            var cycle = Math.floor((currentTime - CONFIG.FIRST_ALERT) / CONFIG.INTERVAL);
            var targetTime = CONFIG.FIRST_ALERT + (cycle * CONFIG.INTERVAL);

            if (currentTime >= targetTime && currentTime < (targetTime + CONFIG.ALERT_WINDOW)) {
                if (State.lastAlertTime < targetTime) {
                    $.DispatchEvent("PlaySoundEffect", CONFIG.SOUND_NAME);
                    State.lastAlertTime = targetTime; 
                }
            }
        }

        $.Schedule(CONFIG.POLL_RATE, loop);
    }

    $.Schedule(1.0, loop);
})();