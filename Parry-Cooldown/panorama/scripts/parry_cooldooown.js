(function() {
    $.Msg('[ParryTimer] Loaded angle timer v4; waiting for layout');
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
    let boundsConfigured = false;
    let lastAngle = null;
    let sampleAngle = null;
    let sampleTime = 0;
    let secondsPerDegree = null;
    let lastFailure = '';
    let lastException = '';
    let wasActive = false;
    const diagnose = message => {
        if (message !== lastFailure) $.Msg('[ParryTimer] ' + message);
        lastFailure = message;
    };
    const child = (panel, id) => panel && panel.IsValid()
        ? panel.Children().find(node => node.id === id) : null;

    // Native C++ writes the radial clip on this border; the icon is static.
    function readAngle(panel) {
        let clip = String(panel.style.clip || '').trim();
        // The native inline style can be exposed through the style attribute
        // instead of the JS style getter (also handled by QOLLOCK's reader).
        if (!clip && panel.GetAttributeString) {
            const match = /clip\s*:\s*([^;]+)/i.exec(panel.GetAttributeString('style', ''));
            if (match) clip = match[1].trim();
        }
        if (!/^radial\s*\(/i.test(clip)) return null;
        const degrees = clip.match(/[-+]?(?:\d+\.?\d*|\.\d+)\s*deg/gi);
        if (!degrees || degrees.length !== 2) return null;
        const sweep = Math.abs(parseFloat(degrees[1]) - parseFloat(degrees[0]));
        return Number.isFinite(sweep) ? Math.min(360, sweep) : null;
    }

    function update() {
        if (stopped) return;
        if (!context.IsValid()) {
            diagnose('Layout was deleted; timer stopped');
            return;
        }
        let delay = 0.1;
        let phase = 'resolve native panels';
        try {
            let gun = State.cachedGunData;
            if (!gun || !gun.IsValid()) {
                gun = child(context, 'gun_data') || $.ModHudLookup.find('gun_data');
                State.cachedGunData = gun;
            }
            const nextHolder = child(gun, 'parry_unavailable');
            if (nextHolder !== holder || !border || !border.IsValid()) {
                holder = nextHolder;
                border = child(holder, 'ParryCooldownBorder');
                lastAngle = null;
                secondsPerDegree = null;
                State.customParryLabel = null;
                boundsConfigured = false;
            }
            if (!holder || !border) {
                diagnose('Waiting for gun_data/parry_unavailable/ParryCooldownBorder');
                return;
            }
            // Native: 40px high, vertically centered, y=55px. Reserve 26px
            // below it for the label. Raising y by half the added height keeps
            // the icon's top at precisely the same screen position:
            // -40/2 + 55 == -66/2 + 68. No child extends outside this container.
            phase = 'reserve timer bounds';
            if (!boundsConfigured) {
                holder.style.height = '66px';
                holder.style.y = '68px';
                const image = child(holder, 'ParryImage');
                if (image) image.style.height = '40px';
                border.style.height = '40px';
                boundsConfigured = true;
            }
            phase = 'create/configure timer label';
            let label = State.customParryLabel;
            if (!label || !label.IsValid()) {
                label = child(holder, 'CustomParryTimerText') || $.CreatePanel('Label', holder, 'CustomParryTimerText');
                // The label follows the native icon's own x/y, rather than a
                // percentage of the much wider gun_data panel.
                label.style.horizontalAlign = 'center';
                label.style.verticalAlign = 'top';
                label.style.y = '42px';
                label.style.width = '100%';
                label.style.height = '24px';
                label.style.textAlign = 'center';
                label.style.fontSize = '18px';
                label.style.fontWeight = 'bold';
                label.style.color = '#e75b5b';
                label.style.textShadow = '0px 0px 4px #000000, 0px 1px 3px #000000';
                label.style.zIndex = '100';
                label.style.visibility = 'collapse';
                State.customParryLabel = label;
            }
            const gunElement = gun.GetParent();
            phase = 'read native cooldown class and radial clip';
            const active = gunElement && gunElement.BHasClass('parry_on_cooldown');
            if (active && !wasActive) $.Msg('[ParryTimer] Native cooldown detected');
            wasActive = !!active;
            const angle = active ? readAngle(border) : null;
            if (active && angle === null) diagnose('Native radial clip is unreadable: ' + String(border.style.clip).slice(0, 160));
            const now = Date.now();
            phase = 'check urn modifier';
            const carryingUrn = active && angle !== null && angle > 0 && IsCarryingUrn(GetUIRoot());
            if (carryingUrn) diagnose('Timer hidden: holding urn');
            if (active && angle === 0) diagnose('Timer hidden: native radial sweep is zero');
            if (!active || angle === null || angle <= 0 || carryingUrn) {
                label.style.visibility = 'collapse';
                lastAngle = null;
                secondsPerDegree = null;
                return;
            }
            delay = 0.03;
            phase = 'calculate remaining time';
            if (lastAngle === null || angle > lastAngle + 2) {
                secondsPerDegree = (HasRebuttal(GetUIRoot()) ? REBUTTAL_PARRY_COOLDOWN : BASE_PARRY_COOLDOWN) / 360;
                sampleAngle = angle;
                sampleTime = now;
            } else if (lastAngle - angle > 0.01 && now > sampleTime) {
                // Measure from the cycle's first sample. Native clip updates
                // can be slower than polling; unchanged ticks must not reset
                // the time baseline and make the remaining time approach 0.1.
                secondsPerDegree = (now - sampleTime) / 1000 / (sampleAngle - angle);
            }
            lastAngle = angle;
            const text = Math.max(0.1, angle * secondsPerDegree).toFixed(1);
            if (label.text !== text) label.text = text;
            label.style.visibility = 'visible';
            lastFailure = '';
            lastException = '';
        } catch (error) {
            const message = phase + ': ' + String(error);
            if (message !== lastException) $.Msg('[ParryTimer] Runtime failure — ' + message);
            lastException = message;
        } finally {
            if (!stopped && context.IsValid()) job = $.Schedule(delay, update);
        }
    }
    context.__parryTimerCleanup = () => {
        stopped = true;
        if (job !== null) $.CancelScheduled(job);
        if (State.customParryLabel && State.customParryLabel.IsValid()) State.customParryLabel.DeleteAsync(0);
    };
    // Includes run while the XML is being constructed. Keep the original
    // deferred startup: an immediate IsValid() exit never schedules a retry.
    job = $.Schedule(1.0, update);
})();
