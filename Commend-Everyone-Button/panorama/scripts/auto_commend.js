var g_lastMatchId = "";
var g_lastObservedScreen = "";
var g_isFreshPostMatch = false;
var g_hasClickedCurrentMatch = false;

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

    getPostGameRoot: function(root) {
        if (!root || !root.FindChildTraverse) {
            return null;
        }
        return root.FindChildTraverse("CitadelPostGameNew");
    },

    hasClass: function(panel, className) {
        return !!(panel && panel.IsValid && panel.IsValid() && panel.BHasClass && panel.BHasClass(className));
    },

    setClass: function(panel, className, shouldHaveClass) {
        if (!panel || !panel.IsValid || !panel.IsValid()) return;
        if (shouldHaveClass) {
            panel.AddClass(className);
        } else {
            panel.RemoveClass(className);
        }
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

    setPanelState: function(panel, isVisible) {
        if (!panel || !panel.IsValid || !panel.IsValid()) return;
        panel.style.opacity = isVisible ? "1" : "0";
        panel.style.visibility = isVisible ? "visible" : "collapse";
        panel.enabled = isVisible;
        panel.hittest = !!isVisible;
    },

    toggleCustomButtons: function(root, isVisible) {
        var btns = root.FindChildrenWithClassTraverse("AutoCommendStyle") || [];
        var i;
        for (i = 0; i < btns.length; i++) {
            Utils.setPanelState(btns[i], isVisible);
        }
    },

    isPanelVisible: function(panel) {
        if (!panel || !panel.IsValid || !panel.IsValid() || !panel.visible) {
            return false;
        }

        if (panel.style) {
            if (panel.style.visibility === "collapse") {
                return false;
            }
            if (panel.style.opacity === "0") {
                return false;
            }
        }

        return true;
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

    hasPlayAgainButton: function(root) {
        var playAgainButton = root ? root.FindChildTraverse("PlayAgainButton") : null;
        return !!(playAgainButton && playAgainButton.IsValid && playAgainButton.IsValid());
    },

    getCurrentScreen: function(root) {
        var postGameRoot = Utils.getPostGameRoot(root);

        if (Utils.hasClass(postGameRoot, "SelectedScreen_MVP")) {
            return "MVP";
        }

        if (Utils.hasClass(postGameRoot, "SelectedScreen_Team1")) {
            return "Team1";
        }

        if (Utils.hasClass(postGameRoot, "SelectedScreen_Team2")) {
            return "Team2";
        }

        if (Utils.hasClass(postGameRoot, "SelectedScreen_Scoreboard")) {
            return "Scoreboard";
        }

        if (Utils.hasClass(postGameRoot, "SelectedScreen_Graphs")) {
            return "Graphs";
        }

        return "";
    },

    getButtonScreen: function(button) {
        if (!button) return "";
        if (button.id === "AutoCommendMVP") return "MVP";
        if (button.id === "AutoCommendTeam1") return "Team1";
        if (button.id === "AutoCommendTeam2") return "Team2";
        if (button.id === "AutoCommendScoreboard") return "Scoreboard";
        return "";
    },

    syncButtonVisibility: function(root) {
        var autoButtons;
        var playAgainButton;
        var currentScreen;
        var i;
        var button;
        var buttonScreen;
        var shouldShowPlayAgain;
        var shouldShowCommend;

        if (!root) return;

        autoButtons = root.FindChildrenWithClassTraverse("AutoCommendStyle") || [];
        playAgainButton = root.FindChildTraverse("PlayAgainButton");
        currentScreen = Utils.getCurrentScreen(root);

        if (g_hasClickedCurrentMatch || Utils.hasClass(Utils.getPostGameRoot(root), "AutoCommendCompleted")) {
            g_hasClickedCurrentMatch = true;
            Utils.toggleCustomButtons(root, false);
            if (Utils.hasPlayAgainButton(root)) {
                Utils.setPanelState(playAgainButton, !!g_isFreshPostMatch);
            }
            return;
        }

        shouldShowPlayAgain = false;
        if (g_isFreshPostMatch) {
            shouldShowPlayAgain = currentScreen !== "MVP";
        }

        for (i = 0; i < autoButtons.length; i++) {
            button = autoButtons[i];
            buttonScreen = Utils.getButtonScreen(button);

            if (g_isFreshPostMatch) {
                shouldShowCommend = currentScreen === "MVP" && buttonScreen === "MVP";
            } else {
                shouldShowCommend = currentScreen === buttonScreen;
            }

            Utils.setPanelState(button, shouldShowCommend);
        }

        if (Utils.hasPlayAgainButton(root)) {
            Utils.setPanelState(playAgainButton, shouldShowPlayAgain);
        }
    }
};

function ResetCommendState(root) {
    var actionContainers;
    var autoButtons;
    var i;
    var container;
    var btn;

    g_hasClickedCurrentMatch = false;
    Utils.setClass(Utils.getPostGameRoot(root), "AutoCommendCompleted", false);

    actionContainers = root.FindChildrenWithClassTraverse("PlayerActionContainer") || [];
    for (i = 0; i < actionContainers.length; i++) {
        container = actionContainers[i];
        btn = container ? container.FindChildTraverse("CommendPlayerButton") : null;
        if (btn) {
            btn.RemoveClass("ac_done");
        }
    }

    autoButtons = root.FindChildrenWithClassTraverse("AutoCommendStyle") || [];
    for (i = 0; i < autoButtons.length; i++) {
        if (autoButtons[i]) {
            autoButtons[i].RemoveClass("ac_done");
        }
    }
}

function CheckForNewMatch() {
    var root = Utils.getRoot();
    var matchIdLabel;
    var currentMatchId;
    var currentScreen;

    if (root) {
        matchIdLabel = root.FindChildTraverse("MatchID");
        currentMatchId = matchIdLabel ? matchIdLabel.text : "";
        currentScreen = Utils.getCurrentScreen(root);

        if (currentMatchId && currentMatchId !== g_lastMatchId) {
            g_lastMatchId = currentMatchId;
            g_lastObservedScreen = currentScreen;
            g_isFreshPostMatch = currentScreen === "MVP";
            Utils.toggleCustomButtons(root, true);
            ResetCommendState(root);
        } else if (currentScreen && currentScreen !== g_lastObservedScreen) {
            g_lastObservedScreen = currentScreen;
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
    var playAgainButton;

    if (!root) return;

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

    g_hasClickedCurrentMatch = true;
    Utils.setClass(Utils.getPostGameRoot(root), "AutoCommendCompleted", true);
    Utils.toggleCustomButtons(root, false);

    playAgainButton = root.FindChildTraverse("PlayAgainButton");
    if (Utils.hasPlayAgainButton(root)) {
        Utils.setPanelState(playAgainButton, !!g_isFreshPostMatch);
    }
}

CheckForNewMatch();
