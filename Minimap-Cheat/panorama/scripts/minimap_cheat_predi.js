(function() {
    "use strict";

    // Configuration
    const POLL_INTERVAL = 0.2;
    const WAVE_COUNT = 2;
    const CLICK_DELAY = 3;
    const WAVE_DELAY = 3.0;
    const TRIGGER_WORDS = ["missing"];
    const CHAT_PANELS = ["Team1Chat", "Team2Chat", "ChatMessages"];

    // State and Cache
    const State = {
        chatCounts: {},
        isPinging: false
    };
    
    const Cache = {
        rootPanel: null,
        chatContainers: {}
    };

    // Cache UI root panel to prevent repetitive tree traversal
    function GetUIRoot() {
        if (Cache.rootPanel && Cache.rootPanel.IsValid && Cache.rootPanel.IsValid()) {
            return Cache.rootPanel;
        }

        let root = $.GetContextPanel();
        let guard = 0;
        while (root && root.GetParent && root.GetParent() && guard < 50) {
            root = root.GetParent();
            guard++;
        }
        
        Cache.rootPanel = root;
        return root;
    }

    function PerformClick(btn, root) {
        const minimap = root ? (root.FindChildTraverse("hud_minimap") || root.FindChildTraverse("minimap_container")) : null;
        const hoverPanel = btn.FindChildTraverse("HoverPanel") || btn.FindChildTraverse("hover_panel") || btn;

        if (minimap) minimap.AddClass("gScoreboardOpen");
        btn.AddClass("gScoreboardOpen");

        try { minimap.hittest = true; minimap.hittestchildren = true; } catch(e) {}
        try { btn.hittest = true; btn.hittestchildren = true; } catch(e) {}
        try { hoverPanel.hittest = true; hoverPanel.hittestchildren = true; } catch(e) {}

        try { $.DispatchEvent("Activated", hoverPanel, "mouse"); } catch(e) {}

        $.Schedule(0.02, () => {
            if (minimap && minimap.IsValid()) minimap.RemoveClass("gScoreboardOpen");
            if (btn && btn.IsValid()) btn.RemoveClass("gScoreboardOpen");
        });
    }

    function FirePingWave(waveIndex) {
        if (waveIndex >= WAVE_COUNT) {
            State.isPinging = false;
            return;
        }

        const root = GetUIRoot();
        const enemies = [];
        
        if (root) {
            const buttons = root.FindChildrenWithClassTraverse("map_button") || [];
            for (let i = 0; i < buttons.length; i++) {
                const btn = buttons[i];
                if (btn && btn.IsValid() && btn.BHasClass("enemy") && btn.BHasClass("player")) {
                    enemies.push(btn);
                }
            }
        }

        function ClickNextEnemy(enemyIndex) {
            if (enemyIndex >= enemies.length) {
                $.Schedule(WAVE_DELAY, () => FirePingWave(waveIndex + 1));
                return;
            }

            const targetBtn = enemies[enemyIndex];
            if (targetBtn && targetBtn.IsValid()) {
                PerformClick(targetBtn, root);
            }

            $.Schedule(CLICK_DELAY, () => ClickNextEnemy(enemyIndex + 1));
        }

        ClickNextEnemy(0);
    }

    function ProcessChatMessage(msgPanel) {
        if (!msgPanel || !msgPanel.IsValid()) return;
        
        const msgTextLabel = msgPanel.FindChildTraverse("MessageText");
        if (!msgTextLabel || !msgTextLabel.text) return;
        
        const text = String(msgTextLabel.text).toLowerCase();
        const isTriggered = TRIGGER_WORDS.some(word => text.includes(word));

        if (!isTriggered || State.isPinging) return;

        State.isPinging = true;
        FirePingWave(0);
    }

    function GetMessagesContainer(panelId) {
        let container = Cache.chatContainers[panelId];
        
        if (container && container.IsValid && container.IsValid()) {
            return container;
        }

        const root = GetUIRoot();
        if (!root) return null;

        const chatPanel = root.FindChildTraverse(panelId);
        if (chatPanel && chatPanel.IsValid()) {
            container = chatPanel.FindChildTraverse("Messages");
            if (container && container.IsValid()) {
                Cache.chatContainers[panelId] = container;
                return container;
            }
        }
        return null;
    }

    function AutoPingLoop() {
        try {
            for (let i = 0; i < CHAT_PANELS.length; i++) {
                const panelId = CHAT_PANELS[i];
                const messagesContainer = GetMessagesContainer(panelId);
                
                if (!messagesContainer) continue;

                const currentCount = messagesContainer.GetChildCount();
                let lastCount = State.chatCounts[panelId] || 0;

                // Handle chat clearing (e.g., player reconnects)
                if (currentCount < lastCount) lastCount = 0;

                if (currentCount > lastCount) {
                    for (let j = lastCount; j < currentCount; j++) {
                        ProcessChatMessage(messagesContainer.GetChild(j));
                    }
                    State.chatCounts[panelId] = currentCount;
                }
            }
        } catch (e) {
        } finally {
            $.Schedule(POLL_INTERVAL, AutoPingLoop);
        }
    }

    $.Schedule(2.0, AutoPingLoop);
})();