// Active Stats for Deadlock
// Dynamically mirrors active hero combat buffs and debuffs (fire rate, slow, resists, lifesteal, spirit power, etc.)
// from the bottom-left player stats container into a sleek tactical readout beside the crosshair.

(() => {
    'use strict';

    const CONFIG = {
        // Active polling rate during combat when modifiers are present (seconds)
        POLL_RATE: 0.15,

        // Idle polling rate when no modifiers are active (saves CPU cycles)
        IDLE_POLL_RATE: 0.25,

        BASE_X: 135,
        BASE_Y: 0,

        // Visual scale and opacity
        SCALE: 100,  // UI scale percentage (50 to 200)
        OPACITY: 1.0,// Opacity multiplier (0.0 to 1.0)

        // Visibility filters
        SHOW_BUFFS: true,
        SHOW_DEBUFFS: true,

        // Diagnostic console logging
        DEBUG: false,
    };

    const IDS = {
        overlay: 'ActiveStatsCrosshairOverlay',
        rowPrefix: 'ActiveStatsRow_',
        source: 'hudActivePlayerStats',
        gameplayHud: 'gameplay_hud',
    };

    const VALUE_BFS_LIMIT = 200;
    const DISCOVERY_RETRY_MS = 800;
    const STORE_KEY = 'ActiveStats';
    const CTX = $.GetContextPanel();

    function log(msg) {
        if (!CONFIG.DEBUG) return;
        try { $.Msg('[ActiveStats] ' + msg); } catch (e) {}
    }

    // ---------------------------------------------------------------- panel helpers
    function isValid(panel) {
        try { return !!(panel && typeof panel.IsValid === 'function' && panel.IsValid()); }
        catch (_) { return false; }
    }

    function isDirectChild(panel, parent) {
        if (!isValid(panel) || !isValid(parent)) return false;
        try { return panel.GetParent() === parent; } catch (_) { return false; }
    }

    function hasClass(panel, className) {
        if (!isValid(panel) || typeof panel.BHasClass !== 'function') return false;
        try { return panel.BHasClass(className); } catch (e) { return false; }
    }

    function findChild(root, id) {
        if (!isValid(root)) return null;
        try {
            if (typeof root.FindChild === 'function') return root.FindChild(id);
            if (typeof root.Children !== 'function') return null;
            return (root.Children() || []).find(child => isValid(child) && child.id === id) || null;
        } catch (e) { return null; }
    }

    function ancestor(id) {
        let panel = CTX;
        for (let i = 0; isValid(panel) && i < 50; i++) {
            if (panel.id === id) return panel;
            panel = panel.GetParent ? panel.GetParent() : null;
        }
        return null;
    }

    function getRoot() {
        let cursor = CTX;
        let guard = 0;
        while (cursor && cursor.GetParent && cursor.GetParent() && guard < 50) {
            cursor = cursor.GetParent();
            guard += 1;
        }
        return cursor || CTX;
    }

    // ---------------------------------------------------------------- instance guard & single-instance lifecycle
    function getStore() {
        try { if (typeof GameUI !== 'undefined' && GameUI.CustomUIConfig) return GameUI.CustomUIConfig(); } catch (e) {}
        try {
            const root = getRoot();
            if (root) {
                root.__ActiveStatsFallbackStore = root.__ActiveStatsFallbackStore || {};
                return root.__ActiveStatsFallbackStore;
            }
        } catch (e) {}
        try {
            globalThis.__ActiveStatsFallbackStore = globalThis.__ActiveStatsFallbackStore || {};
            return globalThis.__ActiveStatsFallbackStore;
        } catch (e) { return {}; }
    }

    const store = getStore();
    const previous = store[STORE_KEY];
    if (previous && typeof previous.cleanup === 'function') {
        try { previous.cleanup(); } catch (e) {}
    }
    const GENERATION = ((previous && previous.generation) || 0) + 1;

    function isRetired() {
        if (!isValid(CTX)) return true;
        const current = store[STORE_KEY];
        return !current || current.generation !== GENERATION;
    }

    // ---------------------------------------------------------------- stat definitions
    const STAT_DEFS = [
        { id: 'fireRateContainer',        key: 'fireRate',         iconClass: 'FireRate',              svg: 's2r://panorama/images/icons/properties/fire_rate.vsvg' },
        { id: 'speedDisplayContainer',    key: 'moveSpeed',        iconClass: 'MoveSpeed',             svg: 's2r://panorama/images/icons/properties/move_speed.vsvg' },
        { id: 'healingAmpContainer',      key: 'healAmp',          iconClass: 'HealAmplifcation',      svg: 's2r://panorama/images/icons/properties/damage_crit.vsvg' },
        { id: 'bulletResistContainer',    key: 'bulletResist',     iconClass: 'ResistBullet',          svg: 's2r://panorama/images/icons/properties/armor_bullet.vsvg' },
        { id: 'techResistContainer',      key: 'techResist',       iconClass: 'ResistSpirit',          svg: 's2r://panorama/images/icons/properties/armor_spirit.vsvg' },
        { id: 'bulletLifeStealContainer', key: 'bulletLifesteal',  iconClass: 'HealthStealingBullets', svg: 's2r://panorama/images/icons/properties/health_stealing_bullets.vsvg' },
        { id: 'techLifeStealContainer',   key: 'techLifesteal',    iconClass: 'HealthStealingSpirit',  svg: 's2r://panorama/images/icons/properties/health_stealing_spirit.vsvg' },
        { id: 'weaponPowerContainer',     key: 'weaponPower',      iconClass: 'DamageWeapon',          svg: 's2r://panorama/images/icons/properties/damage_bullet.vsvg' },
        { id: 'spiritContainer',          key: 'spirit',           iconClass: 'Spirit',                svg: 's2r://panorama/images/icons/properties/spirit.vsvg' },
        { id: 'abilityRangeContainer',    key: 'range',            iconClass: 'Range',                 svg: 's2r://panorama/images/icons/properties/range.vsvg' },
        { id: 'abilityDurationContainer', key: 'duration',         iconClass: 'Duration',              svg: 's2r://panorama/images/icons/properties/duration.vsvg' },
        { id: 'clipSizeContainer',        key: 'clipSize',         iconClass: 'AmmoClipSize',          svg: 's2r://panorama/images/icons/properties/ammo_clip_size.vsvg' },
        { id: 'regenPerSecondContainer',  key: 'regen',            iconClass: 'HealthRegen',           svg: 's2r://panorama/images/icons/properties/health_regen.vsvg' },
    ];

    // ---------------------------------------------------------------- state
    const State = {
        overlay: null,
        hudPanel: null,
        gameplayHud: null,
        nativeGameplayHud: null,
        nextHudSearchMs: 0,
        nextCoreSearchMs: 0,
        nextGameplaySearchMs: 0,
        nextSourceSearchMs: 0,
        isHudSuppressed: false,
        sourcePanel: null,
        rowPanels: new Map(),
        rowValues: new Map(),
        rowIcons: new Map(),
        sourceContainers: new Map(),
        sourceScopes: new Map(),
        scopeParents: new Map(),
        scopeSearchNextMs: new Map(),
        rowSearchNextMs: new Map(),
        valuePanels: new Map(),
        lastLayoutSig: '',
        lastContentSig: '',
        lastVisibleCount: -1,
        isScoreboardSuppressed: false,
        scoreboardEventVisible: false,
        scheduledTick: null,
    };
    let scoreboardListener = null;

    const STAT_PATHS = {
        fireRate: ['StatList', 'WeaponColumn'], clipSize: ['StatList', 'WeaponColumn'],
        bulletLifesteal: ['StatList', 'WeaponColumn'],
        range: ['StatList', 'SpiritColumn'], duration: ['StatList', 'SpiritColumn'],
        techLifesteal: ['StatList', 'SpiritColumn'],
        weaponPower: ['HudStatBlock', 'CoreStats', 'Weapon'], spirit: ['HudStatBlock', 'CoreStats', 'Spirit'],
        moveSpeed: ['StatList', 'VitalityColumn'], healAmp: ['StatList', 'VitalityColumn'],
        bulletResist: ['StatList', 'VitalityColumn'], techResist: ['StatList', 'VitalityColumn'],
        regen: ['StatList', 'VitalityColumn'],
    };

    function resetDiscoveryDeadlines() {
        State.nextHudSearchMs = State.nextCoreSearchMs = State.nextGameplaySearchMs = State.nextSourceSearchMs = 0;
        State.scopeSearchNextMs.clear();
        State.rowSearchNextMs.clear();
    }

    function clearSourceCache() {
        State.sourcePanel = null;
        State.sourceContainers.clear();
        State.sourceScopes.clear();
        State.scopeParents.clear();
        State.scopeSearchNextMs.clear();
        State.rowSearchNextMs.clear();
        State.valuePanels.clear();
        State.lastContentSig = '';
        State.nextSourceSearchMs = 0;
    }

    function resolveHud() {
        const root = getRoot();
        if (isDirectChild(State.hudPanel, root)) return State.hudPanel;
        if (State.hudPanel) State.nextHudSearchMs = 0;
        if (Date.now() < State.nextHudSearchMs) return null;
        State.nextHudSearchMs = Date.now() + DISCOVERY_RETRY_MS;
        const candidate = ancestor('Hud');
        const hud = isDirectChild(candidate, root) ? candidate : findChild(root, 'Hud');
        if (hud !== State.hudPanel) {
            State.gameplayHud = State.nativeGameplayHud = null;
            State.nextCoreSearchMs = State.nextGameplaySearchMs = 0;
            clearSourceCache();
        }
        State.hudPanel = hud;
        return hud;
    }

    // ---------------------------------------------------------------- value extraction & classification
    function stripHtml(s) {
        if (!s) return '';
        let out = '', inTag = false;
        for (let i = 0; i < s.length; i++) {
            const ch = s.charAt(i);
            if (ch === '<') { inTag = true; continue; }
            if (ch === '>') { inTag = false; continue; }
            if (!inTag) out += ch;
        }
        out = out.split('&nbsp;').join(' ').split('&amp;').join('&');
        const parts = out.split(/\s+/), clean = [];
        for (let p = 0; p < parts.length; p++) {
            if (parts[p]) clean.push(parts[p]);
        }
        return clean.join(' ');
    }

    function readBfs(root) {
        if (!isValid(root)) return '';
        let queue = [];
        try { if (root.Children) queue = (root.Children() || []).slice(); } catch (e) { return ''; }
        let guard = 0;
        while (guard < queue.length && guard < VALUE_BFS_LIMIT) {
            const node = queue[guard];
            guard++;
            if (!node) continue;
            try { if (node.id === 'casterList') continue; } catch (e) {}
            try {
                if (typeof node.text === 'string') {
                    const t = node.text;
                    if (t && t.length && t.charAt(0) !== '#') return t;
                }
            } catch (e) {}
            try {
                if (node.Children) {
                    const kids = node.Children() || [];
                    for (let i = 0; i < kids.length; i++) queue.push(kids[i]);
                }
            } catch (e) {}
        }
        return '';
    }

    function readModifierValue(container, def) {
        if (!isValid(container)) return '';
        let labels = State.valuePanels.get(container);
        const deltaStat = def.key === 'weaponPower' || def.key === 'spirit';
        if (!labels || !isDirectChild(labels.core, container) || !isDirectChild(labels.value, labels.valueParent) ||
            (labels.valueParent !== labels.core && !isDirectChild(labels.valueParent, labels.core)) ||
            (labels.postfix && !isDirectChild(labels.postfix, labels.valueParent)) ||
            (deltaStat && !isDirectChild(labels.delta, labels.core))) {
            // The core has a CLASS, not an ID. Native labels are now split into
            // statNumber + statPostfix, with core stats wrapped once more.
            const core = (container.Children() || []).find(child => hasClass(child, 'miniModifierCore'));
            if (!core) return readBfs(container);
            const children = core.Children() || [];
            const wrapper = children.find(child => hasClass(child, 'statWithPostfix'));
            const candidates = wrapper ? wrapper.Children() || [] : children;
            labels = {
                core,
                valueParent: wrapper || core,
                value: candidates.find(child => hasClass(child, 'statNumber')),
                postfix: candidates.find(child => hasClass(child, 'statPostfix')),
                delta: children.find(child => hasClass(child, 'statNumberDelta')),
            };
            if (!isValid(labels.value)) return readBfs(core);
            State.valuePanels.set(container, labels);
        }
        if (def.key === 'weaponPower' || def.key === 'spirit') {
            // The engine retains stale delta text after clearing has_delta.
            if (!hasClass(container, 'has_delta') || !isValid(labels.delta)) return '';
            const delta = stripHtml(labels.delta.text || '');
            if (!delta || delta.charAt(0) === '#' || delta.indexOf('{') !== -1) return '';
            if (def.key === 'weaponPower') return delta.endsWith('%') ? delta : delta + '%';
            return /^[+\-\u2212]/.test(delta) ? delta : '+' + delta;
        }
        // Read rendered native labels. Localizing the postfix again can expand a
        // token containing the entire number and duplicate it in the overlay.
        const value = stripHtml(labels.value.text || '');
        const postfix = isValid(labels.postfix) ? stripHtml(labels.postfix.text || '') : '';
        if (!value || value.charAt(0) === '#' || value.indexOf('{') !== -1) return '';
        return value + (postfix.charAt(0) === '#' || postfix.indexOf('{') !== -1 ? '' : postfix);
    }

    function classifyBySign(txt) {
        if (!txt) return 0;
        for (let i = 0; i < txt.length; i++) {
            const ch = txt.charAt(i);
            if (ch === '-' || ch === '\u2212') return -1;
            if (ch === '+') return 1;
            if (ch >= '0' && ch <= '9') return 0;
        }
        return 0;
    }

    function classifyByGameClass(container) {
        if (!isValid(container)) return 0;
        try {
            if (container.BHasClass('isNegative') || container.BHasClass('IsNegative')) return -1;
            if (container.BHasClass('isPositive') || container.BHasClass('IsPositive')) return 1;
        } catch (e) {}
        return 0;
    }

    function isScoreboardOpen(root) {
        if (State.scoreboardEventVisible) return true;
        if (!isValid(root)) return false;
        if (hasClass(root, 'gScoreboardOpen') || hasClass(root, 'ScoreboardOpen') || hasClass(root, 'wants_scoreboard')) {
            return true;
        }
        const hud = ancestor('Hud') || root;
        return hasClass(hud, 'gScoreboardOpen') || hasClass(hud, 'ScoreboardOpen') || hasClass(hud, 'wants_scoreboard');
    }

    function onScoreboardToggle(data) {
        if (isRetired()) return;
        const isVisible = !!(data && data.visible);
        State.scoreboardEventVisible = isVisible;
        State.isScoreboardSuppressed = isVisible;
        if (isValid(State.overlay)) {
            State.overlay.style.visibility = !isVisible && isGameplayHudShown() && State.lastVisibleCount > 0 ? 'visible' : 'collapse';
        }
        if (!isVisible) {
            State.lastContentSig = '';
            // Immediately wake up and refresh with 0ms latency when closing scoreboard
            if (State.scheduledTick !== null) {
                try { $.CancelScheduled(State.scheduledTick); } catch (e) {}
                State.scheduledTick = null;
            }
            tick();
        }
    }

    if (typeof $.RegisterForUnhandledEvent === 'function') {
        scoreboardListener = $.RegisterForUnhandledEvent('CitadelScoreboardToggle', onScoreboardToggle);
    }

    // ---------------------------------------------------------------- DOM & overlay creation
    function isGameplayHudShown() {
        const hud = resolveHud();
        if (!isValid(hud)) return false;
        const ancestors = [];
        let panel = hud;
        for (let i = 0; isValid(panel) && i < 50; i++) {
            ancestors.push(panel);
            panel = panel.GetParent ? panel.GetParent() : null;
        }
        if (panel) return false;
        // These are the game's own hud.css gates. No stat containers or
        // labels need to be touched while the gameplay HUD is hidden.
        if (!ancestors.some(panel => hasClass(panel, 'joined_team'))) return false;
        for (const panel of ancestors) {
            if (!isValid(panel) || panel.visible === false || hasClass(panel, 'HudHiddenPanel') ||
                hasClass(panel, 'ShowEscapeMenu') || hasClass(panel, 'HudTakeoverEnabled') ||
                hasClass(panel, 'inPostGame') || hasClass(panel, 'GameStatePostGame') ||
                hasClass(panel, 'InHideout')) return false;
        }
        const core = resolveGameplayHud();
        if (!isValid(core) || core.visible === false || hasClass(core, 'HudHiddenPanel')) return false;
        if (!isDirectChild(State.nativeGameplayHud, core)) {
            if (State.nativeGameplayHud) State.nextGameplaySearchMs = 0;
            State.nativeGameplayHud = null;
            if (Date.now() >= State.nextGameplaySearchMs) {
                State.nativeGameplayHud = findChild(core, IDS.gameplayHud);
                State.nextGameplaySearchMs = Date.now() + DISCOVERY_RETRY_MS;
            }
        }
        const gameplay = State.nativeGameplayHud;
        return isValid(gameplay) && gameplay.visible !== false && !hasClass(gameplay, 'gShopOpen') &&
            !hasClass(gameplay, 'HudHiddenPanel') && gameplay.style.visibility !== 'collapse' &&
            gameplay.style.opacity !== '0' && gameplay.style.opacity !== '0.0';
    }

    function resolveGameplayHud() {
        const hud = resolveHud();
        if (isDirectChild(State.gameplayHud, hud) && hasClass(State.gameplayHud, 'HudCore')) return State.gameplayHud;
        if (State.gameplayHud) State.nextCoreSearchMs = 0;
        if (Date.now() < State.nextCoreSearchMs) return null;
        State.nextCoreSearchMs = Date.now() + DISCOVERY_RETRY_MS;
        const core = isValid(hud) ? (hud.Children() || []).find(child => hasClass(child, 'HudCore')) || null : null;
        if (core !== State.gameplayHud) {
            State.nativeGameplayHud = null;
            State.nextGameplaySearchMs = 0;
            clearSourceCache();
        }
        State.gameplayHud = core;
        return core;
    }

    function resolveSourcePanel() {
        const core = resolveGameplayHud();
        if (isDirectChild(State.sourcePanel, core)) return State.sourcePanel;
        if (State.sourcePanel) clearSourceCache();
        if (Date.now() < State.nextSourceSearchMs) return null;
        State.nextSourceSearchMs = Date.now() + DISCOVERY_RETRY_MS;
        const candidate = ancestor(IDS.source);
        State.sourcePanel = isDirectChild(candidate, core) ? candidate : findChild(core, IDS.source);
        return State.sourcePanel;
    }

    function getSourceContainer(source, def) {
        const now = Date.now();
        let scope = source;
        for (const id of STAT_PATHS[def.key]) {
            const previous = State.sourceScopes.get(id);
            let next = previous;
            if (!isDirectChild(next, scope)) {
                if (previous || State.scopeParents.get(id) !== scope) State.scopeSearchNextMs.set(id, 0);
                next = null;
                if (now >= (State.scopeSearchNextMs.get(id) || 0)) {
                    next = findChild(scope, id);
                    State.scopeSearchNextMs.set(id, now + DISCOVERY_RETRY_MS);
                }
            }
            if (previous !== next) {
                State.sourceContainers.clear(); State.valuePanels.clear(); State.rowSearchNextMs.clear();
                State.lastContentSig = '';
            }
            State.sourceScopes.set(id, next);
            State.scopeParents.set(id, scope);
            scope = next;
        }
        let container = State.sourceContainers.get(def.key);
        if (isDirectChild(container, scope)) return container;
        if (container) {
            State.valuePanels.delete(container);
            State.rowSearchNextMs.set(def.key, 0);
        }
        if (now < (State.rowSearchNextMs.get(def.key) || 0)) return null;
        State.rowSearchNextMs.set(def.key, now + DISCOVERY_RETRY_MS);
        container = findChild(scope, def.id);
        State.sourceContainers.set(def.key, container);
        return container;
    }

    function ensureOverlay() {
        const parent = resolveGameplayHud();
        if (!isValid(parent)) return null;
        if (isDirectChild(State.overlay, parent)) return State.overlay;
        if (isValid(State.overlay)) State.overlay.DeleteAsync(0);

        let overlay = findChild(parent, IDS.overlay);
        if (!isValid(overlay)) {
            overlay = $.CreatePanel('Panel', parent, IDS.overlay, { hittest: 'false', hittestchildren: 'false' });
        }

        // Base container layout
        overlay.style.horizontalAlign = 'center';
        overlay.style.verticalAlign = 'center';
        overlay.style.width = 'fit-children';
        overlay.style.height = 'fit-children';
        overlay.style.flowChildren = 'down';
        overlay.style.padding = '2px 0px';
        overlay.style.visibility = 'collapse';

        // Pre-build rows for the supported native stats.
        State.rowPanels.clear();
        State.rowIcons.clear();
        State.rowValues.clear();

        for (let s = 0; s < STAT_DEFS.length; s++) {
            const def = STAT_DEFS[s];
            const rowId = IDS.rowPrefix + def.key;

            let row = findChild(overlay, rowId);
            if (!isValid(row)) {
                row = $.CreatePanel('Panel', overlay, rowId);
                row.AddClass('ActiveStatsRow');
                row.style.flowChildren = 'right';
                row.style.verticalAlign = 'center';
                row.style.width = 'fit-children';
                row.style.margin = '2px 0px';
                row.style.padding = '2px 7px 2px 5px';
                row.style.borderRadius = '3px';
                row.style.borderLeft = '2px solid #ffffff30';
                row.style.backgroundColor = '#000000a6';
                row.style.transitionProperty = 'background-color';
                row.style.transitionDuration = '0.15s';
                row.style.visibility = 'collapse';

                const icon = $.CreatePanel('Panel', row, rowId + '_icon');
                icon.AddClass('ActiveStatsIcon');
                icon.AddClass('statIcon');
                icon.AddClass('PropertiesIcon');
                icon.AddClass(def.iconClass);
                icon.style.width = '17px';
                icon.style.height = '17px';
                icon.style.verticalAlign = 'center';
                icon.style.marginRight = '6px';
                icon.style.backgroundSize = 'contain';
                icon.style.backgroundRepeat = 'no-repeat';
                icon.style.backgroundImage = 'url("' + def.svg + '")';
                icon.style.washColor = '#FFEFD7';

                const val = $.CreatePanel('Label', row, rowId + '_val');
                val.AddClass('ActiveStatsValue');
                val.style.fontSize = '14px';
                val.style.fontWeight = 'bold';
                val.style.fontFamily = 'sansMono';
                val.style.textShadow = '0px 1px 3px 2.0 #000000';
                val.style.color = '#FFEFD7';
                val.style.verticalAlign = 'center';
                val.text = '';
            }

            State.rowPanels.set(def.key, row);
            State.rowIcons.set(def.key, findChild(row, rowId + '_icon'));
            State.rowValues.set(def.key, findChild(row, rowId + '_val'));
        }

        State.overlay = overlay;
        State.lastLayoutSig = '';
        State.lastContentSig = '';
        State.lastVisibleCount = -1;
        return overlay;
    }

    function removeOverlay() {
        if (scoreboardListener !== null && typeof $.UnregisterForUnhandledEvent === 'function') {
            try { $.UnregisterForUnhandledEvent('CitadelScoreboardToggle', scoreboardListener); } catch (e) {}
            scoreboardListener = null;
        }
        if (State.scheduledTick !== null) {
            try { $.CancelScheduled(State.scheduledTick); } catch (e) {}
            State.scheduledTick = null;
        }
        if (isValid(State.overlay)) {
            try { State.overlay.DeleteAsync(0); } catch (e) {}
        }
        State.overlay = null;
        State.gameplayHud = null;
        State.nativeGameplayHud = null;
        State.hudPanel = null;
        clearSourceCache();
        resetDiscoveryDeadlines();
        State.rowPanels.clear();
        State.rowIcons.clear();
        State.rowValues.clear();
        State.sourceContainers.clear();
        State.sourceScopes.clear();
        State.valuePanels.clear();
        State.lastLayoutSig = '';
        State.lastContentSig = '';
        State.lastVisibleCount = -1;
    }

    function updateRow(def, part) {
        const row = State.rowPanels.get(def.key);
        const icon = State.rowIcons.get(def.key);
        const val = State.rowValues.get(def.key);
        if (!isValid(row) || !isValid(val)) return;

        if (!part) {
            if (row.SetHasClass) {
                row.SetHasClass('isBuff', false);
                row.SetHasClass('isDebuff', false);
            }
            row.style.visibility = 'collapse';
            return;
        }

        const isNeg = (part.indexOf(def.key + '-') === 0);
        const text = part.substring((def.key + '-').length);

        if (row.SetHasClass) {
            row.SetHasClass('isBuff', !isNeg);
            row.SetHasClass('isDebuff', isNeg);
        }

        row.style.borderLeftColor = isNeg ? '#ff6e6e' : '#7ae66e';

        if (isValid(icon)) {
            icon.style.washColor = '#FFEFD7';
        }

        val.style.color = isNeg ? '#ff6e6e' : '#7ae66e';
        if (val.text !== text) {
            val.text = text;
        }

        row.style.visibility = 'visible';
    }

    // ---------------------------------------------------------------- main tick
    function tick() {
        if (isRetired()) {
            removeOverlay();
            return;
        }

        try {
            if (!isGameplayHudShown()) {
                if (isValid(State.overlay) && !State.isHudSuppressed) State.overlay.style.visibility = 'collapse';
                State.isHudSuppressed = true;
                // Reuse the existing idle interval: only check HUD state, never
                // resolve/read modifiers or repaint rows while hidden.
                State.scheduledTick = $.Schedule(CONFIG.IDLE_POLL_RATE, tick);
                return;
            }
            if (State.isHudSuppressed) {
                State.isHudSuppressed = false;
                State.lastContentSig = '';
                State.lastVisibleCount = -1;
                resetDiscoveryDeadlines();
            }
            const root = getRoot();
            if (!isValid(root)) {
                State.scheduledTick = $.Schedule(CONFIG.IDLE_POLL_RATE, tick);
                return;
            }

            // Suppress overlay while Scoreboard is open
            if (isScoreboardOpen(root)) {
                if (isValid(State.overlay)) {
                    State.overlay.style.visibility = 'collapse';
                }
                State.isScoreboardSuppressed = true;
                State.lastVisibleCount = -1;
                // Sleep longer during scoreboard view; CitadelScoreboardToggle will wake us up instantly on close
                State.scheduledTick = $.Schedule(0.5, tick);
                return;
            }

            // If scoreboard was previously open, force refresh on close
            if (State.isScoreboardSuppressed) {
                State.isScoreboardSuppressed = false;
                State.lastContentSig = '';
            }

            const overlay = ensureOverlay();
            if (!isValid(overlay)) {
                State.scheduledTick = $.Schedule(CONFIG.IDLE_POLL_RATE, tick);
                return;
            }

            const source = resolveSourcePanel();
            if (!isValid(source)) {
                if (State.lastVisibleCount !== 0) {
                    overlay.style.visibility = 'collapse';
                    State.lastVisibleCount = 0;
                }
                State.scheduledTick = $.Schedule(CONFIG.IDLE_POLL_RATE, tick);
                return;
            }

            const contentParts = [];
            let visibleCount = 0;

            for (let s = 0; s < STAT_DEFS.length; s++) {
                const def = STAT_DEFS[s];
                const container = getSourceContainer(source, def);

                let active = false;
                if (isValid(container)) {
                    try { active = container.BHasClass('shouldShow'); } catch (e) { active = false; }
                }

                if (!active) {
                    contentParts.push('');
                    continue;
                }

                const displayValue = readModifierValue(container, def);
                if (!displayValue) {
                    contentParts.push('');
                    continue;
                }
                // Native classes describe the net effect; individual casters may
                // disagree and must not overwrite the game's classification.
                const cls = classifyByGameClass(container) || classifyBySign(displayValue);

                const isNeg = (cls < 0);
                if (isNeg ? !CONFIG.SHOW_DEBUFFS : !CONFIG.SHOW_BUFFS) {
                    contentParts.push('');
                    continue;
                }

                visibleCount++;
                contentParts.push(def.key + (isNeg ? '-' : '+') + displayValue);
            }

            const dynamicMarginTop = CONFIG.BASE_Y - Math.round(Math.max(0, visibleCount - 1) * 12.5);
            const layoutSig = CONFIG.BASE_X + '|' + dynamicMarginTop + '|' + CONFIG.SCALE + '|' + CONFIG.OPACITY;
            if (layoutSig !== State.lastLayoutSig) {
                overlay.style.marginLeft = CONFIG.BASE_X + 'px';
                overlay.style.marginTop = dynamicMarginTop + 'px';
                overlay.style.uiScale = CONFIG.SCALE + '%';
                overlay.style.opacity = String(CONFIG.OPACITY);
                State.lastLayoutSig = layoutSig;
            }

            const contentSig = contentParts.join('|');
            if (contentSig !== State.lastContentSig) {
                for (let r = 0; r < STAT_DEFS.length; r++) {
                    updateRow(STAT_DEFS[r], contentParts[r]);
                }
                State.lastContentSig = contentSig;
            }

            if (visibleCount !== State.lastVisibleCount) {
                overlay.style.visibility = (visibleCount > 0) ? 'visible' : 'collapse';
                State.lastVisibleCount = visibleCount;
            }
        } catch (e) {
            log('tick error: ' + (e && e.message ? e.message : e));
        }

        const nextDelay = State.isScoreboardSuppressed
            ? 0.5
            : (State.lastVisibleCount > 0 ? CONFIG.POLL_RATE : CONFIG.IDLE_POLL_RATE);
        State.scheduledTick = $.Schedule(nextDelay, tick);
    }

    // Register cleanup hook in global store for hot-reloads and transitions
    store[STORE_KEY] = {
        generation: GENERATION,
        cleanup: removeOverlay,
    };

    log('Loaded Active-Stats (generation ' + GENERATION + ')');
    State.scheduledTick = $.Schedule(CONFIG.POLL_RATE, tick);
})();
