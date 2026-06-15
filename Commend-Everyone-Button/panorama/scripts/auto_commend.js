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

    setPlayAgainVisible: function(root, isVisible) {
        var playAgainButton = root ? root.FindChildTraverse("PlayAgainButton") : null;
        if (!playAgainButton) return;
        playAgainButton.style.visibility = isVisible ? "visible" : "collapse";
        playAgainButton.style.opacity = isVisible ? "1" : "0";
    },

    syncMvpViewState: function(root) {
        var mvpScreen = root ? root.FindChildTraverse("AutoCommendMVP") : null;
        var isMvpVisible = !!(mvpScreen && mvpScreen.IsValid && mvpScreen.IsValid() && mvpScreen.visible);
        Utils.setPlayAgainVisible(root, !isMvpVisible);
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

        Utils.syncMvpViewState(root);
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
    Utils.syncMvpViewState(root);
}

CheckForNewMatch();
