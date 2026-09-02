// Good Game After Death
// Auto-sends a chat line when the player dies, detected via the respawn timer.
// Ported from Well-Played-On-Kill logic.

(() => {
    'use strict';

    const CONFIG = {
        MESSAGE: 'Good Game!',

        // How often we check for death. Polling at 0.3s is sufficient for death detection.
        POLL_RATE: 0.3,

        // Console commands that open the ALL chat, tried in order until one produces an ALL target.
        OPEN_COMMANDS: ['say_chat', 'say_chat_all', 'chat_all'],

        // Delays before each submit attempt, in seconds. First one is next-frame.
        RETRY_DELAYS: [0, 0.016, 0.033, 0.05, 0.1, 0.2],
        // Extra ticks the chat target must stay ready before we submit.
        CONFIRM_TICKS: 1,

        // Refuse to submit unless the chat target really is ALL.
        REQUIRE_ALL_TARGET: true,

        // Cooldown between messages to prevent spam if death logic flakes.
        COOLDOWN_MS: 3000,

        DEBUG: false,
    };

    const IDS = {
        chatInput: 'ChatInput',
        chatTargetLabel: 'ChatTargetLabel',
    };

    const STORE_KEY = 'GoodGameAfterDeath';
    const CTX = $.GetContextPanel();

    const State = {
        chatInput: null,
        chatTargetLabel: null,
        sending: false,
        lastAcceptedMs: 0,
        attempt: 0,
        readyStreak: 0,
        cmdIndex: 0,
        cmdLocked: false,
        wasDead: false,
    };

    function log(message) {
        if (!CONFIG.DEBUG) return;
        try { $.Msg('[GoodGame] ' + message); } catch (e) {}
    }

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

    // ---------------------------------------------------------------- instance guard

    function getStore() {
        try { if (typeof GameUI !== 'undefined' && GameUI.CustomUIConfig) return GameUI.CustomUIConfig(); } catch (e) {}
        try {
            const root = getRoot();
            if (root) {
                root.__GoodGameFallbackStore = root.__GoodGameFallbackStore || {};
                return root.__GoodGameFallbackStore;
            }
        } catch (e) {}
        
        try {
            globalThis.__GoodGameFallbackStore = globalThis.__GoodGameFallbackStore || {};
            return globalThis.__GoodGameFallbackStore;
        } catch (e) { return {}; }
    }

    const store = getStore();
    const previous = store[STORE_KEY];
    const GENERATION = ((previous && previous.generation) || 0) + 1;
    store[STORE_KEY] = { generation: GENERATION };

    function isRetired() {
        if (!isValid(CTX)) return true;
        const current = store[STORE_KEY];
        return !current || current.generation !== GENERATION;
    }

    // ---------------------------------------------------------------- chat sending

    function resolveChatPanels() {
        if (isValid(State.chatInput) && isValid(State.chatTargetLabel)) return true;
        const root = getRoot();
        State.chatInput = findChild(root, IDS.chatInput);
        State.chatTargetLabel = findChild(root, IDS.chatTargetLabel);
        return !!(State.chatInput && State.chatTargetLabel);
    }

    function isAllChatTarget() {
        if (!CONFIG.REQUIRE_ALL_TARGET) return true;
        if (!isValid(State.chatTargetLabel)) return false;

        let cursor = State.chatTargetLabel;
        let guard = 0;
        while (cursor && guard < 20) {
            if (hasClass(cursor, 'ChatTarget_GameAll')) return true;
            if (hasClass(cursor, 'ChatTarget_Team') || hasClass(cursor, 'ChatTarget_Party')) return false;
            try {
                if (typeof cursor.GetParent === 'function') cursor = cursor.GetParent();
                else break;
            } catch (e) { break; }
            guard += 1;
        }

        let text = '';
        try { text = String(State.chatTargetLabel.text || '').trim(); } catch (e) { return false; }
        if (!text) return false;

        return text === '#citadel_chat_placeholder' || text.indexOf('(ALL)') !== -1 || text.indexOf('[ALL]') !== -1;
    }

    function openChat() {
        const command = CONFIG.OPEN_COMMANDS[State.cmdIndex];
        try { $.DispatchEvent('CitadelConCommand', command); } catch (e) {}
        log('open chat via ' + command);
    }

    function closeChat(input) {
        try { $.DispatchEvent('CitadelChatInputBlur', input); } catch (e) {}
        try { $.DispatchEvent('DropInputFocus', input); } catch (e) {}
    }

    function submit(input) {
        try {
            input.text = CONFIG.MESSAGE;
            $.DispatchEvent('CitadelChatInputSubmitted', input);
            input.text = '';
        } catch (e) {
            log('submit threw, aborting');
            State.sending = false;
            return;
        }
        closeChat(input);
        State.cmdLocked = true;
        log('sent "' + CONFIG.MESSAGE + '" via ' + CONFIG.OPEN_COMMANDS[State.cmdIndex]);
        State.sending = false;
    }

    function trySubmit() {
        if (isRetired()) return;

        if (resolveChatPanels() && isAllChatTarget()) {
            if (State.readyStreak >= CONFIG.CONFIRM_TICKS) {
                submit(State.chatInput);
                return;
            }
            State.readyStreak += 1;
        } else {
            State.readyStreak = 0;
        }

        State.attempt += 1;
        if (State.attempt < CONFIG.RETRY_DELAYS.length) {
            $.Schedule(CONFIG.RETRY_DELAYS[State.attempt], trySubmit);
            return;
        }

        if (!State.cmdLocked && State.cmdIndex < CONFIG.OPEN_COMMANDS.length - 1) {
            State.cmdIndex += 1;
            State.attempt = 0;
            State.readyStreak = 0;
            openChat();
            $.Schedule(CONFIG.RETRY_DELAYS[0], trySubmit);
            return;
        }

        log('gave up: no usable ALL chat target');
        if (isValid(State.chatInput)) closeChat(State.chatInput);
        State.sending = false;
    }

    function beginSend() {
        State.sending = true;
        State.attempt = 0;
        State.readyStreak = 0;
        openChat();
        $.Schedule(CONFIG.RETRY_DELAYS[0], trySubmit);
    }

    function onDeath() {
        const now = Date.now();
        if (State.lastAcceptedMs && now - State.lastAcceptedMs < CONFIG.COOLDOWN_MS) {
            log('death within cooldown, ignored');
            return;
        }
        if (State.sending) {
            log('send in flight, ignored');
            return;
        }
        State.lastAcceptedMs = now;
        log('death detected, sending');
        beginSend();
    }

    // ---------------------------------------------------------------- death detection

    function isPanelVisible(panel) {
        try { return panel && panel.visible; } catch(e) { return false; }
    }

    function getRespawnTimerSeconds(root) {
        if (!isValid(root)) return -1;
        let timerPanel = null;
        
        let localRespawnRoot = null;
        try { localRespawnRoot = root.FindChildTraverse("respawn_timer"); } catch (e) {}
        
        if (localRespawnRoot && localRespawnRoot.FindChildrenWithClassTraverse) {
            let localLabels = [];
            try { localLabels = localRespawnRoot.FindChildrenWithClassTraverse("respawn_number") || []; } catch (e) {}
            for (let i = 0; i < localLabels.length; i++) {
                if (isValid(localLabels[i]) && isPanelVisible(localLabels[i])) {
                    timerPanel = localLabels[i];
                    break;
                }
            }
        }

        if (!timerPanel && root.FindChildrenWithClassTraverse) {
            let labels = [];
            try { labels = root.FindChildrenWithClassTraverse("RespawnTimer") || []; } catch (e) {}
            for (let i = 0; i < labels.length; i++) {
                if (isValid(labels[i]) && isPanelVisible(labels[i])) {
                    timerPanel = labels[i];
                    break;
                }
            }
        }

        if (!isValid(timerPanel) || !isPanelVisible(timerPanel)) return -1;

        let text = "";
        try { text = String(timerPanel.text || ""); } catch (e) {}
        text = text.trim();
        if (!text) return -1;
        
        const match = text.match(/-?\d+(?:[.,]\d+)?/);
        if (!match || !match[0]) return -1;
        
        const parsed = Number(match[0].replace(",", "."));
        if (!isFinite(parsed)) return -1;
        return parsed;
    }

    function scan() {
        if (isRetired()) {
            log('retired, stopping poll loop');
            return;
        }

        const timerSeconds = getRespawnTimerSeconds(getRoot());
        const isDead = isFinite(timerSeconds) && timerSeconds > 0;

        if (isDead && !State.wasDead) {
            onDeath();
        }

        State.wasDead = isDead;

        $.Schedule(CONFIG.POLL_RATE, scan);
    }

    log('loaded (generation ' + GENERATION + ')');
    scan();
})();
