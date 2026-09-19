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
        source: 'hudPlayerStats',
        gameplayHud: 'gameplay_hud',
    };

    const VALUE_BFS_LIMIT = 200;
    const STORE_KEY = 'ActiveStats';
    const CTX = $.GetContextPanel();

    function log(msg) {
        if (!CONFIG.DEBUG) return;
        try { $.Msg('[ActiveStats] ' + msg); } catch (e) {}
    }

    // ---------------------------------------------------------------- panel helpers
    function isValid(panel) {
        return !!(panel && (!panel.IsValid || panel.IsValid()));
    }

    function hasClass(panel, className) {
        if (!isValid(panel) || typeof panel.BHasClass !== 'function') return false;
        try { return panel.BHasClass(className); } catch (e) { return false; }
    }

    function findChild(root, id) {
        if (!isValid(root) || typeof root.FindChildTraverse !== 'function') return null;
        try {
            const found = root.FindChildTraverse(id);
            return isValid(found) ? found : null;
        } catch (e) { return null; }
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
        { id: 'damageAmpContainer',       key: 'damageAmp',        iconClass: 'DamageWeapon',          svg: 's2r://panorama/images/icons/properties/damage_bullet.vsvg' },
        { id: 'clipSizeContainer',        key: 'clipSize',         iconClass: 'AmmoClipSize',          svg: 's2r://panorama/images/icons/properties/ammo_clip_size.vsvg' },
        { id: 'regenPerSecondContainer',  key: 'regen',            iconClass: 'HealthRegen',           svg: 's2r://panorama/images/icons/properties/health_regen.vsvg' },
        { id: 'bulletEvasionContainer',   key: 'bulletEvasion',    iconClass: 'MoveDodge',             svg: 's2r://panorama/images/icons/properties/move_dodge.vsvg' },
    ];

    // ---------------------------------------------------------------- state
    const State = {
        overlay: null,
        gameplayHud: null,
        sourcePanel: null,
        rowPanels: new Map(),
        rowValues: new Map(),
        rowIcons: new Map(),
        sourceContainers: new Map(),
        lastLayoutSig: '',
        lastContentSig: '',
        lastVisibleCount: -1,
        isScoreboardSuppressed: false,
        scheduledTick: null,
    };

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
        while (queue.length && guard < VALUE_BFS_LIMIT) {
            const node = queue.shift();
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

    function readModifierValue(container) {
        if (!isValid(container)) return '';
        let core = null;
        try { core = container.FindChildTraverse('miniModifierCore'); } catch (e) {}
        if (!isValid(core)) return readBfs(container);
        return readBfs(core);
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

    function classifyByCasterConsensus(container) {
        if (!isValid(container)) return 0;
        let list = null;
        try { list = container.FindChildTraverse('casterList'); } catch (e) {}
        if (!isValid(list)) return 0;
        let queue = [];
        try { if (list.Children) queue = (list.Children() || []).slice(); } catch (e) { return 0; }
        let guard = 0, enemy = 0, friend = 0;
        while (queue.length && guard < VALUE_BFS_LIMIT) {
            const node = queue.shift();
            guard++;
            if (!node) continue;
            try {
                if (node.BHasClass && node.BHasClass('casterAndModifiers')) {
                    if (node.BHasClass('enemy')) enemy++;
                    else if (node.BHasClass('friend')) friend++;
                }
            } catch (e) {}
            try {
                if (node.Children) {
                    const kids = node.Children() || [];
                    for (let i = 0; i < kids.length; i++) queue.push(kids[i]);
                }
            } catch (e) {}
        }
        if (enemy > 0 && friend === 0) return -1;
        if (friend > 0 && enemy === 0) return 1;
        return 0;
    }

    function applySign(txt, isNeg) {
        if (!txt) return txt;
        let i = 0;
        while (i < txt.length) {
            const ch = txt.charAt(i);
            if (ch === ' ' || ch === '+' || ch === '-' || ch === '\u2212') {
                i++;
                continue;
            }
            break;
        }
        return (isNeg ? '\u2212' : '+') + txt.substring(i);
    }

    function isScoreboardOpen(root) {
        if (State.isScoreboardSuppressed) return true;
        if (!isValid(root)) return false;
        if (hasClass(root, 'gScoreboardOpen') || hasClass(root, 'ScoreboardOpen') || hasClass(root, 'wants_scoreboard')) {
            return true;
        }
        const hud = findChild(root, 'Hud') || root;
        return hasClass(hud, 'gScoreboardOpen') || hasClass(hud, 'ScoreboardOpen') || hasClass(hud, 'wants_scoreboard');
    }

    function onScoreboardToggle(data) {
        if (isRetired()) return;
        const isVisible = !!(data && data.visible);
        State.isScoreboardSuppressed = isVisible;
        if (isValid(State.overlay)) {
            State.overlay.style.visibility = isVisible ? 'collapse' : (State.lastVisibleCount > 0 ? 'visible' : 'collapse');
        }
        if (!isVisible) {
            State.lastContentSig = '';
            // Immediately wake up and refresh with 0ms latency when closing scoreboard
            if (State.scheduledTick) {
                try { $.CancelScheduled(State.scheduledTick); } catch (e) {}
                State.scheduledTick = null;
            }
            tick();
        }
    }

    if (typeof $.RegisterForUnhandledEvent === 'function') {
        $.RegisterForUnhandledEvent('CitadelScoreboardToggle', onScoreboardToggle);
    }

    // ---------------------------------------------------------------- DOM & overlay creation
    function resolveGameplayHud() {
        if (isValid(State.gameplayHud)) {
            if (State.gameplayHud.id !== IDS.gameplayHud) {
                const root = getRoot();
                const gh = findChild(root, IDS.gameplayHud);
                if (isValid(gh)) State.gameplayHud = gh;
            }
            return State.gameplayHud;
        }
        const root = getRoot();
        const gh = findChild(root, IDS.gameplayHud);
        if (isValid(gh)) {
            State.gameplayHud = gh;
            return State.gameplayHud;
        }
        const hud = findChild(root, 'Hud');
        State.gameplayHud = isValid(hud) ? hud : root;
        return State.gameplayHud;
    }

    function resolveSourcePanel() {
        if (isValid(State.sourcePanel)) return State.sourcePanel;
        State.sourceContainers.clear();
        if (isValid(CTX) && CTX.id === IDS.source) {
            State.sourcePanel = CTX;
            return State.sourcePanel;
        }
        const root = getRoot();
        const found = findChild(root, IDS.source);
        if (isValid(found)) {
            State.sourcePanel = found;
            return State.sourcePanel;
        }
        if (isValid(CTX) && CTX.FindChildTraverse) {
            State.sourcePanel = CTX;
            return State.sourcePanel;
        }
        return null;
    }

    function getSourceContainer(source, def) {
        let container = State.sourceContainers.get(def.key);
        if (isValid(container)) return container;
        container = (isValid(source) && source.FindChildTraverse) ? source.FindChildTraverse(def.id) : null;
        if (isValid(container)) {
            State.sourceContainers.set(def.key, container);
            return container;
        }
        return null;
    }

    function ensureOverlay() {
        if (isValid(State.overlay)) return State.overlay;

        const parent = resolveGameplayHud();
        if (!isValid(parent)) return null;

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

        // Pre-build row panels for all 15 stats
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
        if (State.scheduledTick) {
            try { $.CancelScheduled(State.scheduledTick); } catch (e) {}
            State.scheduledTick = null;
        }
        if (isValid(State.overlay)) {
            try { State.overlay.DeleteAsync(0); } catch (e) {}
        }
        State.overlay = null;
        State.gameplayHud = null;
        State.sourcePanel = null;
        State.rowPanels.clear();
        State.rowIcons.clear();
        State.rowValues.clear();
        State.sourceContainers.clear();
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

                const valueText = stripHtml(readModifierValue(container));
                const consensus = classifyByCasterConsensus(container);
                let cls = 0;
                let displayValue = valueText;

                if (consensus < 0) {
                    cls = -1;
                    displayValue = applySign(valueText, true);
                } else {
                    cls = classifyByGameClass(container);
                    if (cls === 0) cls = classifyBySign(valueText);
                }

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
