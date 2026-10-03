// Anti-Toxic-Chat for Deadlock
// Intercepts in-game chat messages on Enter, closes the chat bar immediately,
// transforms insults/rage into wholesome compliments or friendly gamer banter via AI,
// and submits the converted message to the appropriate chat channel.

(() => {
    'use strict';

    const CONFIG = {
        WORKER_URL: 'https://anti-toxic-chat.predi.workers.dev/api/transform',

        // Commands for opening chat channels
        CMD_ALL: 'say_chat',
        CMD_TEAM: 'say_chat_team',
        CMD_PARTY: 'say_chat_party',

        // Max time to wait for AI response before dropping or submitting fallback (in seconds)
        TIMEOUT_SECS: 3.5,

        DEBUG: true,
    };

    const IDS = {
        chat: 'Chat',
        chatInput: 'ChatInput',
        chatTargetLabel: 'ChatTargetLabel',
        htmlPanel: 'AntiToxic_HTMLBridge',
    };

    const STORE_KEY = 'AntiToxicChat';
    const CTX = $.GetContextPanel();

    function log(msg) {
        if (!CONFIG.DEBUG) return;
        try { $.Msg('[AntiToxic] ' + msg); } catch (e) {}
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
            const found = $.ModHudLookup.find(id);
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
                root.__AntiToxicFallbackStore = root.__AntiToxicFallbackStore || {};
                return root.__AntiToxicFallbackStore;
            }
        } catch (e) {}
        try {
            globalThis.__AntiToxicFallbackStore = globalThis.__AntiToxicFallbackStore || {};
            return globalThis.__AntiToxicFallbackStore;
        } catch (e) { return {}; }
    }

    const store = getStore();
    const previous = store[STORE_KEY];
    if (previous && typeof previous.cleanup === 'function') previous.cleanup();
    const GENERATION = ((previous && previous.generation) || 0) + 1;
    store[STORE_KEY] = { generation: GENERATION };

    function isRetired() {
        if (!isValid(CTX)) return true;
        const current = store[STORE_KEY];
        return !current || current.generation !== GENERATION;
    }

    // ---------------------------------------------------------------- state
    const State = {
        chatInput: null,
        chatTargetLabel: null,
        chatRoot: null,
        htmlPanel: null,
        htmlLoaded: false,
        reqCounter: 0,

        ingressQueue: [],       // Early messages queued before CEF is AT_READY
        pendingMap: new Map(),  // reqId -> { id, cmd, raw, timestamp }
        outboxQueue: [],        // Ready messages waiting for safe submission: [{ cmd, text }]
        isPumpingOutbox: false, // Concurrency lock for outbox pump
    };

    function resolvePanels() {
        const root = getRoot();
        if (!isValid(State.chatRoot)) {
            State.chatRoot = findChild(root, IDS.chat) || CTX;
        }
        if (!isValid(State.chatInput)) {
            State.chatInput = findChild(root, IDS.chatInput) || findChild(CTX, IDS.chatInput);
        }
        if (!isValid(State.chatTargetLabel)) {
            State.chatTargetLabel = findChild(root, IDS.chatTargetLabel) || findChild(CTX, IDS.chatTargetLabel);
        }
        return !!(State.chatInput && State.chatTargetLabel);
    }

    function isUserTyping() {
        // If our own outbox pump is currently injecting text, do NOT treat it as user typing
        if (State.isPumpingOutbox) return false;

        resolvePanels();
        const input = State.chatInput;
        if (!isValid(input)) return false;

        const hasFocus = typeof input.BHasKeyFocus === 'function' && input.BHasKeyFocus();
        const isExpanded = isValid(State.chatRoot) && hasClass(State.chatRoot, 'ChatExpanded');
        const hasDraft = !!(input.text && String(input.text).trim().length > 0);

        return hasFocus || isExpanded || hasDraft;
    }

    function closeChat(input) {
        try { $.DispatchEvent('CitadelChatInputBlur', input); } catch (e) {}
        try { $.DispatchEvent('DropInputFocus', input); } catch (e) {}
    }

    function detectTargetCommand() {
        resolvePanels();

        // 1. Direct check on CitadelChat panel classes
        if (isValid(State.chatRoot)) {
            if (hasClass(State.chatRoot, 'ChatTarget_GameAll')) return CONFIG.CMD_ALL;
            if (hasClass(State.chatRoot, 'ChatTarget_GameAllies') || hasClass(State.chatRoot, 'ChatTarget_Team')) return CONFIG.CMD_TEAM;
            if (hasClass(State.chatRoot, 'ChatTarget_Party')) return CONFIG.CMD_PARTY;
        }

        // 2. Upward traversal from label / input
        let cursor = State.chatTargetLabel || State.chatInput;
        let guard = 0;
        while (cursor && guard < 20) {
            if (hasClass(cursor, 'ChatTarget_GameAll')) return CONFIG.CMD_ALL;
            if (hasClass(cursor, 'ChatTarget_GameAllies') || hasClass(cursor, 'ChatTarget_Team')) return CONFIG.CMD_TEAM;
            if (hasClass(cursor, 'ChatTarget_Party')) return CONFIG.CMD_PARTY;
            try {
                if (typeof cursor.GetParent === 'function') cursor = cursor.GetParent();
                else break;
            } catch (e) { break; }
            guard += 1;
        }

        return CONFIG.CMD_ALL;
    }

    // ---------------------------------------------------------------- CEF HTML Bridge
    const bridgeURL = CONFIG.WORKER_URL.replace(/\/api\/transform$/, '/bridge');
    const bridgeSession = String(Date.now()) + ':' + GENERATION;
    let bridgeBusy = null;
    function navigateBridge(message) {
        if (!isValid(State.htmlPanel)) return;
        State.htmlPanel.SetURL(bridgeURL + '#' + encodeURIComponent(JSON.stringify(message)));
    }
    function pumpBridge() {
        if (isRetired() || !State.htmlLoaded || bridgeBusy !== null) return;
        while (State.ingressQueue.length) {
            const item = State.ingressQueue.shift();
            if (!State.pendingMap.has(item.id)) continue;
            bridgeBusy = item.id;
            navigateBridge({op: 'transform', session: bridgeSession, id: item.id, text: item.raw});
            return;
        }
    }
    function sendToCEF(rawText, reqId, targetCmd) {
        State.ingressQueue.push({raw: rawText, id: reqId, cmd: targetCmd});
        pumpBridge();
    }
    function initHTMLBridge() {
        if (isValid(State.htmlPanel)) return;
        try {
            // Own the bridge under this layout so destruction does not leave a
            // Chromium panel attached to the global window root.
            State.htmlPanel = $.CreatePanel('CitadelHTMLPanel', CTX, IDS.htmlPanel);
            State.htmlPanel.style.width = '2px';
            State.htmlPanel.style.height = '2px';
            State.htmlPanel.style.opacity = '0.01';
            State.htmlPanel.SetAttributeString('hittest', 'false');
            State.htmlPanel.SetAttributeString('hittestchildren', 'false');
        } catch (e) { log('Failed to create CitadelHTMLPanel: ' + e); return; }
        $.RegisterEventHandler('HTMLTitle', State.htmlPanel, function (panelOrTitle, eventTitle) {
            if (isRetired()) return;
            const title = typeof eventTitle === 'string' ? eventTitle : panelOrTitle;
            if (typeof title !== 'string' || title.indexOf('AT2:') !== 0) return;
            let message;
            try { message = JSON.parse(title.substring(4)); } catch (_) { return; }
            if (message.session !== bridgeSession) return;
            if (message.op === 'ready' && message.id === 0 && message.version === 2 && message.href === bridgeURL) {
                State.htmlLoaded = true;
                log('HTTPS bridge ready');
                pumpBridge();
            } else if (message.op === 'result' && message.id === bridgeBusy && typeof message.text === 'string') {
                const item = State.pendingMap.get(message.id);
                if (item) onTransformComplete(item.id, item.cmd, message.text);
                bridgeBusy = null;
                pumpBridge();
            }
        });
        navigateBridge({op: 'hello', session: bridgeSession, id: 0});
        log('Initialized HTTPS bridge: ' + bridgeURL);
    }

    // ---------------------------------------------------------------- submission & outbox queue
    function enqueueOutbox(targetCmd, text) {
        State.outboxQueue.push({ cmd: targetCmd, text: text });
        pumpOutbox();
    }

    function pumpOutbox() {
        if (isRetired() || State.isPumpingOutbox || State.outboxQueue.length === 0) return;

        // If the player is currently typing or has chat open/focused, wait!
        if (isUserTyping()) {
            $.Schedule(0.08, () => {
                if (!isRetired()) pumpOutbox();
            });
            return;
        }

        State.isPumpingOutbox = true;
        const nextMsg = State.outboxQueue.shift();

        resolvePanels();
        if (!isValid(State.chatInput)) {
            State.isPumpingOutbox = false;
            return;
        }

        log('Pumping message to ' + nextMsg.cmd + ': "' + nextMsg.text + '"');

        const currentCmd = detectTargetCommand();
        const needsChannelSwitch = (nextMsg.cmd !== currentCmd);

        // Only switch via ConCommand if the channel differs
        if (needsChannelSwitch) {
            if (nextMsg.cmd === CONFIG.CMD_ALL) {
                try { $.DispatchEvent('CitadelConCommand', 'say_chat'); } catch (e) {}
            } else if (nextMsg.cmd === CONFIG.CMD_TEAM) {
                try { $.DispatchEvent('CitadelConCommand', 'say_chat_team'); } catch (e) {}
            }
        }

        // If we switched channels via concommand, allow 20ms for engine state update; otherwise submit immediately
        const submitDelay = needsChannelSwitch ? 0.020 : 0.001;

        $.Schedule(submitDelay, () => {
            if (isRetired()) {
                State.isPumpingOutbox = false;
                return;
            }
            resolvePanels();
            if (!isValid(State.chatInput)) {
                State.isPumpingOutbox = false;
                return;
            }

            try {
                State.chatInput.text = nextMsg.text;
                // Dispatch event to C++ engine (sends chat packet to current channel)
                $.DispatchEvent('CitadelChatInputSubmitted', State.chatInput);
            } catch (e) {
                log('Submit error: ' + e);
            } finally {
                // Immediately clear the input so the AI message is NEVER left in the player's draft!
                State.chatInput.text = '';
            }

            closeChat(State.chatInput);

            // Double check cleanup on next frame to guarantee no lingering text
            $.Schedule(0.016, () => {
                if (isValid(State.chatInput) && !isUserTyping()) {
                    State.chatInput.text = '';
                }
            });

            // Spacing before processing next message in outbox queue
            $.Schedule(0.12, () => {
                State.isPumpingOutbox = false;
                if (!isRetired()) pumpOutbox();
            });
        });
    }

    function onTransformComplete(reqId, cmd, text) {
        if (!State.pendingMap.has(reqId)) return;
        const item = State.pendingMap.get(reqId);
        State.pendingMap.delete(reqId);

        const latency = Date.now() - item.timestamp;
        log('Transformed #' + reqId + ' in ' + latency + 'ms: "' + text + '"');

        enqueueOutbox(cmd, text);
    }

    // ---------------------------------------------------------------- interception
    function onInputSubmit() {
        if (isRetired()) return;
        resolvePanels();

        const input = State.chatInput;
        if (!isValid(input)) return;

        const rawText = input.text ? String(input.text).trim() : '';

        // 1. Immediately clear input field so toxic text is instantly gone
        input.text = '';

        // 2. Immediately close chat window so player gameplay resumes
        closeChat(input);

        // Empty message - nothing to send
        if (!rawText) return;

        const targetCmd = detectTargetCommand();
        log('Intercepted: "' + rawText + '" -> [' + targetCmd + ']');

        // 3. Prepare AI request in multi-flight pending map
        const reqId = ++State.reqCounter;
        const reqItem = {
            id: reqId,
            cmd: targetCmd,
            raw: rawText,
            timestamp: Date.now(),
        };
        State.pendingMap.set(reqId, reqItem);

        // 4. Timeout fallback in case network drops: submit original text (NEVER "gg wp")
        $.Schedule(CONFIG.TIMEOUT_SECS, () => {
            if (!isRetired() && State.pendingMap.has(reqId)) {
                log('Request #' + reqId + ' timed out, falling back to original message');
                const timedOut = State.pendingMap.get(reqId);
                State.pendingMap.delete(reqId);
                enqueueOutbox(timedOut.cmd, timedOut.raw);
                if (bridgeBusy === reqId) bridgeBusy = null;
                pumpBridge();
            }
        });

        // 5. Send to CEF (or queue in ingressQueue if CEF is booting)
        if (State.htmlLoaded) {
            sendToCEF(rawText, reqId, targetCmd);
        } else {
            log('CEF bridge not ready, queued in ingress: #' + reqId);
            State.ingressQueue.push(reqItem);
        }

        // 6. Check if queued messages can be pumped now that chat is closed
        $.Schedule(0.04, () => {
            if (!isRetired()) pumpOutbox();
        });
    }

    // Export global handler so chat.xml's oninputsubmit can call it
    globalThis.OnAntiToxicSubmit = onInputSubmit;

    store[STORE_KEY].cleanup = () => {
        if (isValid(State.htmlPanel)) State.htmlPanel.DeleteAsync(0);
        State.pendingMap.clear();
        State.ingressQueue.length = 0;
        State.outboxQueue.length = 0;
    };

    // Initialize bridge on HUD load
    initHTMLBridge();
    log('Loaded Anti-Toxic-Chat (generation ' + GENERATION + ')');
})();
