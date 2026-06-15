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
            btn.enabled = isVisible;
            btn.hittest = !!isVisible;
        }
    },

    isPanelVisible: function(panel) {
        return !!(panel && panel.IsValid && panel.IsValid() && panel.visible);
    },

    getVisibleAutoButtons: function(root) {
        var btns = root.FindChildrenWithClassTraverse("AutoCommendStyle") || [];
        var visible = [];
        var i;
        for (i = 0; i < btns.length; i++) {
            if (Utils.isPanelVisible(btns[i])) {
                visible.push(btns[i]);
            }
        }
        return visible;
    },

    getVisiblePlayerActionContainers: function(root) {
        var containers = root.FindChildrenWithClassTraverse("PlayerActionContainer") || [];
        var visible = [];
        var i;
        for (i = 0; i < containers.length; i++) {
            if (Utils.isPanelVisible(containers[i])) {
                visible.push(containers[i]);
            }
        }
        return visible;
    },

    hasLiveRequeueState: function(root) {
        var playAgainButton = root ? root.FindChildTraverse("PlayAgainButton") : null;
        var buttonContent;
        var footerMid;

        if (!Utils.isPanelVisible(playAgainButton)) {
            return false;
        }

        buttonContent = playAgainButton.FindChildTraverse("buttonContent");
        footerMid = playAgainButton.GetParent ? playAgainButton.GetParent() : null;

        return Utils.isPanelVisible(buttonContent) && Utils.isPanelVisible(footerMid);
    },

    syncButtonVisibility: function(root) {
        var autoButtons;
        var playAgainButton;
        var isLiveRequeue;
        var i;
        var isMvpButton;

        if (!root) return;

        autoButtons = root.FindChildrenWithClassTraverse("AutoCommendStyle") || [];
        playAgainButton = root.FindChildTraverse("PlayAgainButton");
        isLiveRequeue = Utils.hasLiveRequeueState(root);

        if (!isLiveRequeue) {
            for (i = 0; i < autoButtons.length; i++) {
                if (!autoButtons[i]) continue;
                autoButtons[i].style.visibility = "visible";
                autoButtons[i].style.opacity = "1";
                autoButtons[i].enabled = true;
                autoButtons[i].hittest = true;
            }
            return;
        }

        for (i = 0; i < autoButtons.length; i++) {
            if (!autoButtons[i]) continue;
            isMvpButton = autoButtons[i].id === "AutoCommendMVP";
            autoButtons[i].style.visibility = isMvpButton ? "visible" : "collapse";
            autoButtons[i].style.opacity = isMvpButton ? "1" : "0";
            autoButtons[i].enabled = isMvpButton;
            autoButtons[i].hittest = isMvpButton;
        }

        if (playAgainButton && playAgainButton.IsValid && playAgainButton.IsValid()) {
            if (Utils.isPanelVisible(root.FindChildTraverse("AutoCommendMVP"))) {
                playAgainButton.style.visibility = "collapse";
                playAgainButton.style.opacity = "0";
            } else {
                playAgainButton.style.visibility = "visible";
                playAgainButton.style.opacity = "1";
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

    Utils.toggleCustomButtons(root, false);

    actionContainers = Utils.getVisiblePlayerActionContainers(root);

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
}

CheckForNewMatch();
