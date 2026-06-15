(function() {
    'use strict';

    var CTX = $.GetContextPanel();

    var CONFIG = {
        FIRST_ALERT: 290, // 4:50
        INTERVAL: 300, // 5 min
        ALERT_WINDOW: 3,
        POLL_RATE: 0.1,
        POLL_RATE_IDLE: 1.0,
        SOUND_NAME: "BuffReminder.Alarm"
    };

    var State = {
        rootPanel: null,
        clockPanel: null,
        lastAlertTime: -1
    };

    function isValidPanel(panel) {
        return !!(panel && panel.IsValid && panel.IsValid());
    }

    function getRoot() {
        var top = CTX;
        var guard = 0;

        if (isValidPanel(State.rootPanel)) {
            return State.rootPanel;
        }

        while (top && top.GetParent && top.GetParent() && guard < 50) {
            top = top.GetParent();
            guard++;
        }

        if (!top) {
            State.rootPanel = null;
            return null;
        }

        State.rootPanel = top.FindChildTraverse ? (top.FindChildTraverse("Hud") || top) : top;
        return State.rootPanel;
    }

    function isModeIgnored(root) {
        if (!root || !root.BHasClass) return false;
        
        if (root.BHasClass("connectedToHideout") || root.BHasClass("InHideout") || root.BHasClass("connectedToHeroTesting")) return true;
        if (root.BHasClass("gamemode_streetbrawl")) return true;
        
        return false;
    }

    function getCurrentTime(root) {
        if (!root) return null;

        if (!isValidPanel(State.clockPanel)) {
            State.clockPanel = root.FindChildTraverse ? root.FindChildTraverse("GameTime") : null;
            if (!State.clockPanel) return null;
        }

        var text = State.clockPanel.text;
        if (!text) return null;

        var parts = text.split(':');
        var isNegative = text.charAt(0) === '-';
        
        var hours = 0, mins = 0, secs = 0;

        if (parts.length === 3) {
            hours = Math.abs(parseInt(parts[0], 10));
            mins = parseInt(parts[1], 10);
            secs = parseInt(parts[2], 10);
        } else if (parts.length === 2) {
            mins = Math.abs(parseInt(parts[0], 10));
            secs = parseInt(parts[1], 10);
        } else {
            return null;
        }

        if (isNaN(hours) || isNaN(mins) || isNaN(secs)) return null;

        var totalSeconds = (hours * 3600) + (mins * 60) + secs;
        return isNegative ? -totalSeconds : totalSeconds;
    }

    function loop() {
        if (!CTX || !CTX.IsValid()) return; 

        var root = getRoot();

        if (isModeIgnored(root)) {
            State.lastAlertTime = -1;
            $.Schedule(CONFIG.POLL_RATE_IDLE, loop);
            return;
        }

        var currentTime = getCurrentTime(root);

        if (currentTime === null) {
             $.Schedule(CONFIG.POLL_RATE_IDLE, loop);
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