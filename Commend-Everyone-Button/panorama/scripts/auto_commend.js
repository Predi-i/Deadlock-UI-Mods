let g_lastMatchId = "";

// 1. Utils
const Utils = {
    getRoot: function() {
        let pnl = $.GetContextPanel();
        while (pnl?.GetParent?.()) {
            pnl = pnl.GetParent();
        }
        return pnl;
    },

    clickPanel: function(panel) {
        if (!panel) return false;
        
        const events = [
            () => $.DispatchEvent("MouseActivate", panel, "mouse"),
            () => $.DispatchEvent("Activated", panel, "mouse"),
            () => $.DispatchEvent("onactivate", panel)
        ];
        
        for (const trigger of events) {
            try { trigger(); return true; } catch (e) {}
        }
        return false;
    },

    toggleCustomButtons: function(root, isVisible) {
        const btns = root.FindChildrenWithClassTraverse("AutoCommendStyle") || [];
        for (const btn of btns) {
            if (!btn) continue;
            btn.style.opacity = isVisible ? "1" : "0";
            btn.style.visibility = isVisible ? "visible" : "collapse";
        }
    }
};

// 2. Background Tracker
function CheckForNewMatch() {
    const root = Utils.getRoot();
    
    if (root) {
        const matchIdLabel = root.FindChildTraverse("MatchID");
        const currentMatchId = matchIdLabel ? matchIdLabel.text : "";
        
        if (currentMatchId && currentMatchId !== g_lastMatchId) {
            g_lastMatchId = currentMatchId;
            Utils.toggleCustomButtons(root, true);
            
            const actionContainers = root.FindChildrenWithClassTraverse("PlayerActionContainer") || [];
            for (const container of actionContainers) {
                const btn = container.FindChildTraverse("CommendPlayerButton");
                if (btn) {
                    btn.RemoveClass("ac_done");
                }
            }
        }
    }
    
    $.Schedule(2.0, CheckForNewMatch);
}

// 3. Main Action
function CommendAll() {
    const root = Utils.getRoot();
    if (!root) return;

    const actionContainers = root.FindChildrenWithClassTraverse("PlayerActionContainer") || [];
    const CLICK_DELAY = 0.05; // Delay
    let delayMultiplier = 0;

    for (const container of actionContainers) {
        const btn = container.FindChildTraverse("CommendPlayerButton");
        
        if (btn && btn.IsValid() && btn.visible && !btn.BHasClass("ac_done")) {
            $.Schedule(delayMultiplier * CLICK_DELAY, () => {
                Utils.clickPanel(btn);
                btn.AddClass("ac_done");
            });
            
            delayMultiplier++;
        }
    }

    Utils.toggleCustomButtons(root, false);
}

CheckForNewMatch();