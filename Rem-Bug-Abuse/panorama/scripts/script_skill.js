(function() {
    // Settings
    var Config = {
        castHoldTime: 0.1,
        delayAfterCast1: 0.4,
        delayAfterUpgrade: 0.4,
        toggleKey: "key_h"
    };

    var State = {
        cachedRoot: null,
        isExecutingCombo: false,
        comboStep: 0,
        isRich: false
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

        var targetPip = State.isRich 
            ? slot3.FindChildTraverse("AbilityUnlock3") 
            : slot3.FindChildTraverse("AbilityUnlock1");

        if (!targetPip || !targetPip.IsValid()) {
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
                if (targetPip.BHasClass("canAffordUpgrade")) {
                    SafeClick(targetPip);
                    State.comboStep = 3;
                    $.Schedule(Config.delayAfterUpgrade, ExecuteComboStep);
                } else {
                    ResetCombo();
                }
                break;

            case 3:
                if (targetPip.BHasClass("canUndo")) {
                    SafeClick(targetPip);
                } else {
                    SafeClick(targetPip);
                }
                ResetCombo();
                break;

            default:
                ResetCombo();
                break;
        }
    }

    var panel = $.GetContextPanel();
    function OnKeyPress() {
        if (State.isExecutingCombo) return;

        var root = GetUIRoot();
        if (!root) return;

        var slot3 = root.FindChildTraverse("slot_signature_3");
        if (!slot3) return;

        var tier1Pip = slot3.FindChildTraverse("AbilityUnlock1");
        var tier3Pip = slot3.FindChildTraverse("AbilityUnlock3");

        if (tier3Pip && tier3Pip.IsValid() && tier3Pip.BHasClass("canAffordUpgrade")) {
            State.isRich = true;
            State.isExecutingCombo = true;
            State.comboStep = 1;
            ExecuteComboStep();
        } else if (tier1Pip && tier1Pip.IsValid() && tier1Pip.BHasClass("canAffordUpgrade")) {
            State.isRich = false;
            State.isExecutingCombo = true;
            State.comboStep = 1;
            ExecuteComboStep();
        }
    }

    $.RegisterKeyBind(panel, Config.toggleKey, OnKeyPress);
    $.RegisterKeyBind("", Config.toggleKey, OnKeyPress);
})();