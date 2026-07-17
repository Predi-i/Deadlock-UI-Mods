(function() {
    const BASE_PARRY_COOLDOWN = 4.5;
    const REBUTTAL_PARRY_COOLDOWN = 2.75;

    var State = {
        cachedRoot: null,
        cachedGunData: null,
        cachedGunElement: null,
        cachedInventory: null,
        cachedBuffModifiers: null,
        customParryLabel: null,
        parryEndTime: 0,
        parryIsActive: false,
        ignoreCurrentCycle: false,
        lastText: "",
        lastVis: ""
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

    function HasRebuttal(root) {
        if (!State.cachedInventory || !State.cachedInventory.IsValid()) {
            State.cachedInventory = root.FindChildTraverse("StatsAndModsContainer");
        }
        if (!State.cachedInventory) return false;
        
        var rebuttals = State.cachedInventory.FindChildrenWithClassTraverse("parryRebuttal");
        if (!rebuttals || rebuttals.length === 0) return false;

        for (var i = 0; i < rebuttals.length; i++) {
            var el = rebuttals[i];

            if (el.BHasClass("recentPurchase") || el.BHasClass("QuickbuyItem")) {
                continue;
            }

            var isValid = true;
            // The game reuses the "parryRebuttal" CSS class for both Rebuttal
            // (Tier 1) and Counterspell (Tier 3), but only Rebuttal reduces the
            // parry cooldown. The owning CitadelModIcon carries an isTierN class
            // (isTierN maps 1:1 to EModTier_N), so require Tier 1 to exclude
            // Counterspell and any future higher-tier parry items.
            var isTier1 = false;
            var curr = el.GetParent();
            while (curr && curr.IsValid() && curr !== State.cachedInventory) {
                var pid = curr.id;
                if (pid === "CitadelHudQuickbuy" || pid === "QuickBuyQueueContainer" || pid === "Shop" || pid === "RecentPurchasesPanel") {
                    isValid = false;
                    break;
                }
                if (curr.BHasClass("isTier1")) {
                    isTier1 = true;
                }
                curr = curr.GetParent();
            }

            if (isValid && isTier1) return true;
        }
        return false;
    }

    function IsCarryingUrn(root) {
        if (!State.cachedBuffModifiers || !State.cachedBuffModifiers.IsValid()) {
            State.cachedBuffModifiers = root.FindChildTraverse("BuffModifiers");
        }
        if (!State.cachedBuffModifiers) return false;
        
        var idolBuffs = State.cachedBuffModifiers.FindChildrenWithClassTraverse("MODIFIER_STATE_HOLDING_IDOL");
        return idolBuffs && idolBuffs.length > 0;
    }

    function UpdateParryTimer() {
        var nextDelay = 0.0;
        try {
            var root = GetUIRoot();
            if (!root) {
                nextDelay = 1.0;
                return;
            }

            var gunData = State.cachedGunData;
            if (!gunData || !gunData.IsValid()) {
                gunData = root.FindChildTraverse("gun_data");
                State.cachedGunData = gunData || null;
                if (gunData) {
                    State.cachedGunElement = gunData.GetParent();
                }
            }

            if (!gunData) {
                nextDelay = 1.0;
                return;
            }

            var label = State.customParryLabel;
            if (!label || !label.IsValid()) {
                label = $.CreatePanel("Label", gunData, "CustomParryTimerText");
                label.style.verticalAlign = "center";
                label.style.horizontalAlign = "left";
                label.style.x = "55%";
                label.style.y = "82px";
                label.style.marginLeft = "1px";
                label.style.width = "40px";
                label.style.textAlign = "left";
                label.style.fontSize = "18px";
                label.style.fontWeight = "bold";
                label.style.color = "#e75b5b";
                label.style.textShadow = "0px 0px 4px #000000, 0px 1px 3px #000000";
                label.style.visibility = "collapse";
                label.style.zIndex = "100";
                State.customParryLabel = label;
            }

            var hasCooldown = false;
            if (State.cachedGunElement && State.cachedGunElement.IsValid()) {
                hasCooldown = State.cachedGunElement.BHasClass("parry_on_cooldown");
            }
            
            var now = Date.now();

            if (hasCooldown) {
                nextDelay = 0.0;
                var maxCd = HasRebuttal(root) ? REBUTTAL_PARRY_COOLDOWN : BASE_PARRY_COOLDOWN;

                if (!State.parryIsActive) {
                    State.parryIsActive = true;
                    State.ignoreCurrentCycle = false;
                    State.parryEndTime = now + (maxCd * 1000);
                } else if (now >= State.parryEndTime) {
                    if ((now - State.parryEndTime) > 150) {
                        State.parryEndTime = State.parryEndTime + (maxCd * 1000);
                    }
                }

                if (IsCarryingUrn(root)) {
                    State.ignoreCurrentCycle = true;
                }

                var timeLeft = (State.parryEndTime - now) / 1000.0;
                
                if (timeLeft <= 0 || State.ignoreCurrentCycle) {
                    if (State.lastVis !== "collapse") {
                        label.style.visibility = "collapse";
                        State.lastVis = "collapse";
                    }
                } else {
                    var displayTime = timeLeft.toFixed(1);
                    if (displayTime === "0.0" && timeLeft > 0) displayTime = "0.1";

                    if (State.lastText !== displayTime) {
                        label.text = displayTime;
                        State.lastText = displayTime;
                    }

                    if (State.lastVis !== "visible") {
                        label.style.visibility = "visible";
                        State.lastVis = "visible";
                    }
                }
            } else {
                nextDelay = 0.03;
                if (State.parryIsActive) {
                    State.parryIsActive = false;
                }

                if (State.lastVis !== "collapse") {
                    label.style.visibility = "collapse";
                    State.lastVis = "collapse";
                }
            }
        } catch (e) {
        } finally {
            $.Schedule(nextDelay, UpdateParryTimer);
        }
    }

    $.Schedule(1.0, UpdateParryTimer);
})();