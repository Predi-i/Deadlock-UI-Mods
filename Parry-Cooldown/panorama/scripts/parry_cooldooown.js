(function() {
    const BASE_PARRY_COOLDOWN = 4.5;
    const REBUTTAL_PARRY_COOLDOWN = 2.75;

    var State = {
        cachedRoot: null,
        cachedGunData: null,
        cachedInventory: null,
        cachedBuffModifiers: null,
        customParryLabel: null,
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
            State.cachedInventory = $.ModHudLookup.find("StatsAndModsContainer");
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
            State.cachedBuffModifiers = $.ModHudLookup.find("BuffModifiers");
        }
        if (!State.cachedBuffModifiers) return false;
        
        var idolBuffs = State.cachedBuffModifiers.FindChildrenWithClassTraverse("MODIFIER_STATE_HOLDING_IDOL");
        return idolBuffs && idolBuffs.length > 0;
    }

    const context = $.GetContextPanel();
    if (context.__parryTimerCleanup) context.__parryTimerCleanup();
    let stopped = false;
    let job = null;
    let border = null;
    let holder = null;
    let lastAngle = null;
    let lastSample = 0;
    let secondsPerDegree = null;
    const child = (panel, id) => panel && panel.IsValid()
        ? panel.Children().find(node => node.id === id) : null;

    // Native C++ writes the radial clip on this border; the icon is static.
    function readAngle(panel) {
        const clip = String(panel.style.clip || '');
        if (!/^radial\s*\(/i.test(clip)) return null;
        const degrees = clip.match(/[-+]?(?:\d+\.?\d*|\.\d+)\s*deg/gi);
        if (!degrees || degrees.length !== 2) return null;
        const sweep = Math.abs(parseFloat(degrees[1]) - parseFloat(degrees[0]));
        return Number.isFinite(sweep) ? Math.min(360, sweep) : null;
    }

    function update() {
        if (stopped || !context.IsValid()) return;
        let delay = 0.1;
        try {
            let gun = State.cachedGunData;
            if (!gun || !gun.IsValid()) {
                gun = $.ModHudLookup.find('gun_data');
                State.cachedGunData = gun;
            }
            const nextHolder = child(gun, 'parry_unavailable');
            if (nextHolder !== holder || !border || !border.IsValid()) {
                holder = nextHolder;
                border = child(holder, 'ParryCooldownBorder');
                lastAngle = null;
                secondsPerDegree = null;
                State.customParryLabel = null;
            }
            if (!holder || !border) return;
            let label = State.customParryLabel;
            if (!label || !label.IsValid()) {
                label = child(holder, 'CustomParryTimerText') || $.CreatePanel('Label', holder, 'CustomParryTimerText');
                // The label follows the native icon's own x/y, rather than a
                // percentage of the much wider gun_data panel.
                label.style.horizontalAlign = 'center';
                label.style.verticalAlign = 'top';
                label.style.y = '42px';
                label.style.width = '100%';
                label.style.textAlign = 'center';
                label.style.fontSize = '18px';
                label.style.fontWeight = 'bold';
                label.style.color = '#e75b5b';
                label.style.textShadow = '0px 0px 4px #000000, 0px 1px 3px #000000';
                label.style.visibility = 'collapse';
                State.customParryLabel = label;
            }
            const gunElement = gun.GetParent();
            const active = gunElement && gunElement.BHasClass('parry_on_cooldown');
            const angle = active ? readAngle(border) : null;
            const now = Date.now();
            if (!active || angle === null || angle <= 0 || IsCarryingUrn(GetUIRoot())) {
                label.style.visibility = 'collapse';
                lastAngle = null;
                secondsPerDegree = null;
                return;
            }
            delay = 0.03;
            if (lastAngle === null || angle > lastAngle + 2) {
                secondsPerDegree = (HasRebuttal(GetUIRoot()) ? REBUTTAL_PARRY_COOLDOWN : BASE_PARRY_COOLDOWN) / 360;
            } else if (lastAngle - angle > 0.01 && now > lastSample) {
                // Calibrate from native angular speed. This handles observing a
                // cooldown halfway through and changes in its actual duration.
                secondsPerDegree = (now - lastSample) / 1000 / (lastAngle - angle);
            }
            lastAngle = angle;
            lastSample = now;
            const text = Math.max(0.1, angle * secondsPerDegree).toFixed(1);
            if (label.text !== text) label.text = text;
            label.style.visibility = 'visible';
        } finally {
            if (!stopped && context.IsValid()) job = $.Schedule(delay, update);
        }
    }
    context.__parryTimerCleanup = () => {
        stopped = true;
        if (job !== null) $.CancelScheduled(job);
        if (State.customParryLabel && State.customParryLabel.IsValid()) State.customParryLabel.DeleteAsync(0);
    };
    update();
})();
