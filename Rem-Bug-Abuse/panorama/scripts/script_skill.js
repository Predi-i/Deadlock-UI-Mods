(function() {
    // Settings
    var Config = {
        castHoldTime: 0.1,
        delayAfterCast1: 0.4,
        delayAfterUpgrade: 0.4,
        loopInterval: 0.05,
        toggleKey: "key_h",
        holdTimeout: 0.5
    };

    var State = {
        lastPressedTime: 0,
        cachedRoot: null,
        isExecutingCombo: false,
        comboStep: 0 
    };

    function GetUIRoot() {
        if (State.cachedRoot && State.cachedRoot.IsValid()) {
            return State.cachedRoot;
        }
        var root = $.GetContextPanel();
        while (root && root.GetParent && root.GetParent()) {
            root = root.GetParent();
        }
        State.cachedRoot = root || null;
        return State.cachedRoot;
    }

    function SafeClick(panel) {
        if (!panel || !panel.IsValid()) return false;
        var attempts = [
            function() { $.DispatchEvent("Activated", panel, "mouse"); },
            function() { $.DispatchEvent("Activated", panel); }
        ];
        for (var i = 0; i < attempts.length; i++) {
            try {
                attempts[i]();
                return true;
            } catch (e) {}
        }
        return false;
    }

    function ResetCombo() {
        State.isExecutingCombo = false;
        State.comboStep = 0;
    }

    function ExecuteComboStep() {
        var root = GetUIRoot();
        if (!root) {
            ResetCombo();
            return;
        }

        var slot3 = root.FindChildTraverse("slot_signature_3");
        if (!slot3) {
            ResetCombo();
            return;
        }

        var tier1Pip = slot3.FindChildTraverse("AbilityUnlock1");
        if (!tier1Pip || !tier1Pip.IsValid()) {
            ResetCombo();
            return;
        }

        switch (State.comboStep) {
            case 1:
                $.DispatchEvent("CitadelConCommand", "+in_ability3");
                $.Schedule(Config.castHoldTime, function() {
                    $.DispatchEvent("CitadelConCommand", "-in_ability3");
                    State.comboStep = 2;
                    $.Schedule(Config.delayAfterCast1, ExecuteComboStep);
                });
                break;

            case 2:
                if (tier1Pip.BHasClass("canAffordUpgrade")) {
                    SafeClick(tier1Pip);
                    State.comboStep = 3;
                    $.Schedule(Config.delayAfterUpgrade, ExecuteComboStep);
                } else {
                    ResetCombo();
                }
                break;

            case 3:
                if (tier1Pip.BHasClass("canUndo")) {
                    SafeClick(tier1Pip);
                } else {
                    SafeClick(tier1Pip);
                }
                ResetCombo();
                break;

            default:
                ResetCombo();
                break;
        }
    }

    function AutoUpgradeCycle() {
        try {
            var root = GetUIRoot();
            if (!root) return;

            var slot3 = root.FindChildTraverse("slot_signature_3");
            if (!slot3) return;

            var tier2Pip = slot3.FindChildTraverse("AbilityUnlock2");
            if (tier2Pip && tier2Pip.IsValid() && tier2Pip.BHasClass("canUndo")) {
                SafeClick(tier2Pip);
            }

            if (State.isExecutingCombo) return;

            var tier1Pip = slot3.FindChildTraverse("AbilityUnlock1");
            if (!tier1Pip || !tier1Pip.IsValid()) return;

            var timeSinceLastPress = (Date.now() - State.lastPressedTime) / 1000;
            var isKeyHeld = timeSinceLastPress < Config.holdTimeout;

            if (isKeyHeld && tier1Pip.BHasClass("canAffordUpgrade")) {
                State.isExecutingCombo = true;
                State.comboStep = 1;
                ExecuteComboStep();
            }
        } catch (e) {
            ResetCombo();
        } finally {
            $.Schedule(Config.loopInterval, AutoUpgradeCycle);
        }
    }

    var panel = $.GetContextPanel();
    function OnKeyPress() {
        State.lastPressedTime = Date.now();
    }

    $.RegisterKeyBind(panel, Config.toggleKey, OnKeyPress);
    $.RegisterKeyBind("", Config.toggleKey, OnKeyPress);

    $.Schedule(1.0, AutoUpgradeCycle);
})();