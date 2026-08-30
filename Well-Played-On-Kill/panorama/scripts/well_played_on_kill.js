// Well Played On Kill
// Auto-sends a chat line the instant the damage-impact HUD flags a kill (not a kill assist).
//
// Kill detection: hud_damage_impact.css distinguishes .killed (KILL) from .assist (KILL ASSIST)
// on each .damageImpactInstance panel. We poll #damageImpactInfo children for `killed && !assist`.
//
// Chat sending: there is no scriptable "say" API, so we drive the stock chat panel --
// open it with a console command, write into #ChatInput, dispatch CitadelChatInputSubmitted,
// then blur. Same trick works in other mods; the timing hacks below are why it is not a one-liner.

(() => {
    'use strict';

    const CONFIG = {
        MESSAGE: 'Well Played!',

        // How often we look for a fresh kill. $.Schedule is frame-bound, so a callback cannot run
        // more than once per frame -- this is "every frame", not 100 scans per second, and the
        // ceiling is the frame rate rather than this number. Idle cost is three calls across the
        // JS/C++ boundary: #damageImpactInfo is cached, and it has zero children unless you are
        // actively hitting a hero, so the scan loop does not execute at all most of the time.
        POLL_RATE: 0.01,
        // Poll rate while #damageImpactInfo cannot be resolved (menus, loading, hideout).
        POLL_RATE_IDLE: 1.0,

        // Console commands that open the ALL chat, tried in order until one produces an ALL
        // target. The winner is cached for the rest of the session. `say_chat_team` is the
        // confirmed team-chat command; the ALL variant is inferred from the ChatTeam/Chat
        // keybind pair in popup_settings.xml, so it may need a manual fix after testing.
        OPEN_COMMANDS: ['say_chat', 'say_chat_all', 'chat_all'],

        // Delays before each submit attempt, in seconds. First one is next-frame.
        RETRY_DELAYS: [0, 0.016, 0.033, 0.05, 0.1, 0.2],
        // Extra ticks the chat target must stay ready before we submit. The chat label goes
        // live one tick before the input actually accepts a submit, so 0 drops messages.
        CONFIRM_TICKS: 1,

        // Refuse to submit unless the chat target really is ALL. Set false to send into
        // whatever channel happens to be open (useful to isolate a broken OPEN_COMMANDS list).
        REQUIRE_ALL_TARGET: true,

        // Kills within this window of the last accepted one send nothing. A double kill is one
        // "Well Played!", not two. Measured from when the kill is detected, so a burst of kills
        // never queues up behind the send -- extras are dropped outright.
        COOLDOWN_MS: 3000,

        DEBUG: false,
    };

    const IDS = {
        info: 'damageImpactInfo',
        chatInput: 'ChatInput',
        chatTargetLabel: 'ChatTargetLabel',
    };

    const FIRED_FLAG = '__wellPlayedFired';
    const STORE_KEY = 'WellPlayedOnKill';

    const CTX = $.GetContextPanel();

    const State = {
        info: null,
        chatInput: null,
        chatTargetLabel: null,
        primed: false,
        sending: false,
        lastAcceptedMs: 0,
        attempt: 0,
        readyStreak: 0,
        cmdIndex: 0,
        cmdLocked: false,
    };

    function log(message) {
        if (!CONFIG.DEBUG) return;
        try {
            $.Msg('[WellPlayed] ' + message);
        } catch (e) {}
    }

    function isValid(panel) {
        return !!(panel && (!panel.IsValid || panel.IsValid()));
    }

    function hasClass(panel, className) {
        if (!isValid(panel) || typeof panel.BHasClass !== 'function') return false;
        try {
            return panel.BHasClass(className);
        } catch (e) {
            return false;
        }
    }

    function findChild(root, id) {
        if (!isValid(root) || typeof root.FindChildTraverse !== 'function') return null;
        try {
            const found = root.FindChildTraverse(id);
            return isValid(found) ? found : null;
        } catch (e) {
            return null;
        }
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

    // The layout that hosts this script is instantiated once per HUD load -- the kill panels
    // are snippet children, and snippets do not re-run layout scripts. But a HUD reload (or a
    // second copy of the mod) would leave two poll loops racing, so each instance stamps a
    // generation into the shared store and older loops retire on their next tick.
    function getStore() {
        try {
            if (typeof GameUI !== 'undefined' && GameUI.CustomUIConfig) return GameUI.CustomUIConfig();
        } catch (e) {}
        try {
            globalThis.__WellPlayedFallbackStore = globalThis.__WellPlayedFallbackStore || {};
            return globalThis.__WellPlayedFallbackStore;
        } catch (e) {
            return {};
        }
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

        // The text is localized, so checking for "(ALL)" breaks on non-English clients.
        // The root chat panel has a class indicating the current target, e.g. "ChatTarget_GameAll".
        let cursor = State.chatTargetLabel;
        let guard = 0;
        while (cursor && guard < 20) {
            if (hasClass(cursor, 'ChatTarget_GameAll')) return true;
            if (hasClass(cursor, 'ChatTarget_Team') || hasClass(cursor, 'ChatTarget_Party')) return false;
            try {
                if (typeof cursor.GetParent === 'function') {
                    cursor = cursor.GetParent();
                } else {
                    break;
                }
            } catch (e) {
                break;
            }
            guard += 1;
        }

        // Fallback for safety
        let text = '';
        try {
            text = String(State.chatTargetLabel.text || '').trim();
        } catch (e) {
            return false;
        }
        if (!text) return false;

        // Unlocalized token, or the resolved "[ALL]" / "To (ALL):" forms. The closing bracket
        // keeps these from matching the ALLIES channel.
        return text === '#citadel_chat_placeholder' || text.indexOf('(ALL)') !== -1 || text.indexOf('[ALL]') !== -1;
    }

    function openChat() {
        const command = CONFIG.OPEN_COMMANDS[State.cmdIndex];
        try {
            $.DispatchEvent('CitadelConCommand', command);
        } catch (e) {}
        log('open chat via ' + command);
    }

    function closeChat(input) {
        try {
            $.DispatchEvent('CitadelChatInputBlur', input);
        } catch (e) {}
        try {
            $.DispatchEvent('DropInputFocus', input);
        } catch (e) {}
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
            // Seen ready once; give the input the extra tick it needs before submitting.
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

        // This open command never produced a usable ALL target -- try the next candidate.
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

    function onKill() {
        const now = Date.now();

        // Stamped on the accepted kill rather than on the completed send, so kills landing in the
        // same instant as the first one are rejected here instead of stacking behind it.
        if (State.lastAcceptedMs && now - State.lastAcceptedMs < CONFIG.COOLDOWN_MS) {
            log('kill within ' + CONFIG.COOLDOWN_MS + 'ms cooldown, ignored');
            return;
        }
        // Redundant while the cooldown outlasts a send, but guarantees we never overwrite the
        // text of a submit that is still in flight.
        if (State.sending) {
            log('send in flight, kill ignored');
            return;
        }

        State.lastAcceptedMs = now;
        log('kill detected, sending');
        beginSend();
    }

    // ---------------------------------------------------------------- kill detection

    function resolveInfo() {
        if (isValid(State.info)) return State.info;
        State.info = findChild(CTX, IDS.info) || findChild(getRoot(), IDS.info);
        return State.info;
    }

    function scan() {
        if (isRetired()) {
            log('retired, stopping poll loop');
            return;
        }

        const info = resolveInfo();
        if (!info) {
            State.info = null;
            $.Schedule(CONFIG.POLL_RATE_IDLE, scan);
            return;
        }

        let count = 0;
        try {
            count = info.GetChildCount() || 0;
        } catch (e) {
            State.info = null;
            $.Schedule(CONFIG.POLL_RATE_IDLE, scan);
            return;
        }

        for (let i = 0; i < count; i += 1) {
            let panel = null;
            try {
                panel = info.GetChild(i);
            } catch (e) {}
            if (!isValid(panel)) continue;

            if (!hasClass(panel, 'killed') || hasClass(panel, 'assist')) {
                // Panels can be pooled and reused for the next damage instance, which always
                // starts without `killed` -- clearing here lets a reused panel fire again.
                panel[FIRED_FLAG] = false;
                continue;
            }
            if (panel[FIRED_FLAG]) continue;

            panel[FIRED_FLAG] = true;
            // First scan may see kills that landed before the script started (HUD reload).
            if (State.primed) onKill();
        }

        State.primed = true;
        $.Schedule(CONFIG.POLL_RATE, scan);
    }

    log('loaded (generation ' + GENERATION + ')');
    scan();
})();
