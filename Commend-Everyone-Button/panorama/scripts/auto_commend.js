var g_lastMatchId = "";

var Utils = {
    getRoot: function() {
        var pnl = $.GetContextPanel();
        var guard = 0;
        while (pnl && pnl.GetParent && pnl.GetParent() && guard < 50) {
            pnl = pnl.GetParent();
            guard++;
        }
        return pnl || null;
    },

    clickPanel: function(panel) {
        var events;
        var i;

        if (!panel || !panel.IsValid || !panel.IsValid()) return false;
        
        events = [
            function() { $.DispatchEvent("MouseActivate", panel, "mouse"); },
            function() { $.DispatchEvent("Activated", panel, "mouse"); },
            function() { $.DispatchEvent("onactivate", panel); }
        ];
        
        for (i = 0; i < events.length; i++) {
            try {
                events[i]();
                return true;
            } catch (e) {}
        }
        return false;
    },

    toggleCustomButtons: function(root, isVisible) {
        var btns = root.FindChildrenWithClassTraverse("AutoCommendStyle") || [];
        var i;
        var btn;
        for (i = 0; i < btns.length; i++) {
            btn = btns[i];
            if (!btn) continue;
            btn.style.opacity = isVisible ? "1" : "0";
            btn.style.visibility = isVisible ? "visible" : "collapse";
        }
    },

    getPlayAgainButton: function(root) {
        var btn = root ? root.FindChildTraverse("PlayAgainButton") : null;
        return btn && btn.IsValid && btn.IsValid() ? btn : null;
    },

    hasLiveRequeueState: function(root) {
        var playAgainButton = Utils.getPlayAgainButton(root);
        var buttonContent;
        var parentScreen;

        if (!playAgainButton) {
            return false;
        }

        buttonContent = playAgainButton.FindChildTraverse("buttonContent");
        if (!buttonContent || !buttonContent.IsValid || !buttonContent.IsValid()) {
            return false;
        }

        parentScreen = playAgainButton.GetParent ? playAgainButton.GetParent() : null;
        if (!parentScreen || !parentScreen.IsValid || !parentScreen.IsValid()) {
            return false;
        }

        return playAgainButton.visible && buttonContent.visible && parentScreen.visible;
    },

    syncButtonVisibility: function(root) {
        var autoButtons;
        var mvpButton;
        var playAgainButton;
        var isLiveRequeue;
        var i;

        if (!root) {
            return;
        }

        autoButtons = root.FindChildrenWithClassTraverse("AutoCommendStyle") || [];
        mvpButton = root.FindChildTraverse("AutoCommendMVP");
        playAgainButton = Utils.getPlayAgainButton(root);
        isLiveRequeue = Utils.hasLiveRequeueState(root);

        if (!isLiveRequeue) {
            for (i = 0; i < autoButtons.length; i++) {
                if (autoButtons[i]) {
                    autoButtons[i].style.visibility = "visible";
                    autoButtons[i].style.opacity = "1";
                }
            }
            return;
        }

        if (playAgainButton) {
            if (mvpButton && mvpButton.IsValid && mvpButton.IsValid() && mvpButton.visible) {
                playAgainButton.style.visibility = "collapse";
                playAgainButton.style.opacity = "0";
            } else {
                playAgainButton.style.visibility = "visible";
                playAgainButton.style.opacity = "1";
            }
        }

        for (i = 0; i < autoButtons.length; i++) {
            if (!autoButtons[i]) continue;
            if (mvpButton && autoButtons[i] === mvpButton) {
                autoButtons[i].style.visibility = "visible";
                autoButtons[i].style.opacity = "1";
            } else {
                autoButtons[i].style.visibility = "collapse";
                autoButtons[i].style.opacity = "0";
            }
        }
    }
};

function ResetCommendState(root) {
    var actionContainers;
    var i;
    var container;
    var btn;

    actionContainers = root.FindChildrenWithClassTraverse("PlayerActionContainer") || [];
    for (i = 0; i < actionContainers.length; i++) {
        container = actionContainers[i];
        btn = container ? container.FindChildTraverse("CommendPlayerButton") : null;
        if (btn) {
            btn.RemoveClass("ac_done");
        }
    }
}

function CheckForNewMatch() {
    var root = Utils.getRoot();
    var matchIdLabel;
    var currentMatchId;
    
    if (root) {
        matchIdLabel = root.FindChildTraverse("MatchID");
        currentMatchId = matchIdLabel ? matchIdLabel.text : "";
        
        if (currentMatchId && currentMatchId !== g_lastMatchId) {
            g_lastMatchId = currentMatchId;
            Utils.toggleCustomButtons(root, true);
            ResetCommendState(root);
        }

        Utils.syncButtonVisibility(root);
    }
    
    $.Schedule(0.25, CheckForNewMatch);
}

function CommendAll() {
    var root = Utils.getRoot();
    var actionContainers;
    var CLICK_DELAY = 0.05;
    var delayMultiplier = 0;
    var i;
    var container;
    var btn;

    if (!root) return;

    actionContainers = root.FindChildrenWithClassTraverse("PlayerActionContainer") || [];

    for (i = 0; i < actionContainers.length; i++) {
        container = actionContainers[i];
        btn = container ? container.FindChildTraverse("CommendPlayerButton") : null;
        
        if (btn && btn.IsValid && btn.IsValid() && btn.visible && !btn.BHasClass("ac_done")) {
            (function(targetBtn, delay) {
                $.Schedule(delay, function() {
                    Utils.clickPanel(targetBtn);
                    if (targetBtn && targetBtn.IsValid && targetBtn.IsValid()) {
                        targetBtn.AddClass("ac_done");
                    }
                });
            })(btn, delayMultiplier * CLICK_DELAY);
            
            delayMultiplier++;
        }
    }

    Utils.toggleCustomButtons(root, false);
    Utils.syncButtonVisibility(root);
}

CheckForNewMatch();
