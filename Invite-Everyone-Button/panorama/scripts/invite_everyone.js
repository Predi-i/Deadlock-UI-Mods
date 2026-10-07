// Loaded once by the native HUD combat-log layout, which QOLLOCK does not override.
(() => {
    'use strict';
    const owner = $.GetContextPanel();
    // Includes can execute before a custom C++ panel has loaded/attached its
    // layout. Root onload alone does not cover that lifecycle. Reuse one bounded
    // bootstrap even when the engine evaluates this include more than once.
    if (owner && owner.__inviteEveryoneBootstrap) {
        $.InviteEveryoneInit = owner.__inviteEveryoneBootstrap.kick;
        $.InviteEveryoneInit();
        return;
    }
    const valid = panel => !!(panel && panel.IsValid());
    const child = (panel, id) => valid(panel) ? panel.FindChild(id) : null;
    const byClass = (panel, name) => valid(panel)
        ? panel.Children().find(node => valid(node) && node.BHasClass(name)) || null : null;
    const path = (panel, ids) => ids.reduce(child, panel);

    let waitingFor = 'HUD host context';
    const initialize = () => {
        if (!valid(owner)) { waitingFor = 'valid HUD host context'; return false; }
        let escape = owner;
        for (let i = 0; valid(escape) && escape.id !== 'EscapeMenu' &&
            escape.paneltype !== 'CitadelHudEscapeMenu' && escape.id !== 'Hud' && i < 50; i++) {
            escape = escape.GetParent();
        }
        // Some native layout includes inherit the HUD/WindowRoot script context.
        // These direct routes are present in hud.xml/base_hud.xml, not a root DFS.
        if (owner.id === 'Hud') escape = child(owner, 'EscapeMenu');
        else if (owner.BHasClass('WindowRoot')) escape = child(child(owner, 'Hud'), 'EscapeMenu');
        else if (valid(escape) && escape.id === 'Hud' &&
            (owner.id === 'CitadelHudCombatLog' || owner.paneltype === 'CitadelHudCombatLog')) {
            escape = child(escape, 'EscapeMenu');
        }
        // Other friends-list instances (e.g. dashboard) do no work.
        if (valid(escape) && escape.id === 'Hud') {
            waitingFor = 'sidebar outside EscapeMenu'; return true;
        }
        if (!valid(escape) || (escape.id !== 'EscapeMenu' && escape.paneltype !== 'CitadelHudEscapeMenu')) {
            waitingFor = 'HUD host attachment to EscapeMenu'; return false;
        }
        // onload/repeated script evaluation must not allocate a second controller.
        if (escape.__inviteEveryoneController) {
            const previous = escape.__inviteEveryoneController;
            if (valid(previous.owner)) { waitingFor = 'SubOptions'; return previous.ensureButton(); }
            // A destroyed script context cannot own future scheduled work.
            previous.dispose();
        }
        const hud = escape.GetParent();
        if (!valid(hud) || hud.id !== 'Hud') { waitingFor = 'EscapeMenu parent Hud'; return false; }
        let button = null;
        const ensureButton = () => {
            if (valid(button)) return true;
            const anchor = path(escape, ['LeftStripe', 'Menu', 'SubOptions']);
            if (!valid(anchor)) return false;
            button = child(anchor, 'InviteEveryone');
            if (!valid(button)) {
                button = $.CreatePanel('Button', anchor, 'InviteEveryone');
                button.AddClass('nav_menu_item');
                button.AddClass('minor');
                const label = $.CreatePanel('Label', button, '');
                label.AddClass('menuButtonLabel');
                label.text = 'Invite';
                const settings = byClass(anchor, 'SettingsRow');
                if (valid(settings)) anchor.MoveChildBefore(button, settings);
            }
            button.SetPanelEvent('onactivate', start);
            return true;
        };

        // Work limits, not persisted settings. A single continuation yields
        // between batches; no per-friend timers and no idle watchdog.
        const batchSize = 8;
        const waitStep = 0.05;
        const waitLimit = 100;
        const responseStep = 0.01;
        const responseTimeout = 5000;
        let job = null;
        let busy = false;
        let disposed = false;
        let popup = null;
        let menu = null;
        let list = null;
        let queue = [];
        let cursor = 0;
        let attempts = 0;
        let waits = 0;
        let manager = null;
        let baseline = new Set();
        let closing = new Set();
        let pending = 0;
        let deadline = 0;
        let results = 0;
        let rejected = 0;
        let startedAt = 0;
        let texts = new Map();
        const resultTokens = ['Success', 'GenericFailure', 'InvalidFriend',
            'NotFriendsLongEnough', 'AlreadyHasGame', 'LimitedUser'];
        const token = name => '#Citadel_PlaytestUser_' + name;
        const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
        const matches = (text, name) => {
            const value = normalize(text);
            return value === token(name) || value === texts.get(name);
        };
        const active = () => !disposed && valid(owner) && valid(escape) && valid(hud) &&
            hud.BHasClass('ShowEscapeMenu');
        const popupOpen = () => active() && valid(popup) &&
            !popup.BHasClass('Hidden') && popup.visible !== false;
        const listIn = menu => path(menu, [
            'FriendPanelMainAreaContainer', 'FriendPanelFriendsList', 'FriendsCanInvite', 'FriendList'
        ]);
        const finish = (reason, closePopup = false) => {
            // Native popup_playtest_user.xml and the debugger capture place this
            // button directly in MainBody. Never look up EscapeButton in the HUD.
            const close = closePopup && popupOpen()
                ? child(byClass(popup, 'MainBody'), 'EscapeButton') : null;
            if (job !== null) $.CancelScheduled(job);
            job = null;
            busy = false;
            queue = [];
            popup = menu = list = null;
            manager = null;
            baseline.clear();
            closing.clear();
            pending = 0;
            if (valid(button)) button.enabled = true;
            if (closePopup) {
                let closeStatus = 'unavailable';
                // Retire this run before native close can destroy/rebuild panels.
                if (valid(close) && close.enabled !== false && close.visible !== false) {
                    try { $.DispatchEvent('Activated', close, 'mouse'); closeStatus = 'activated'; }
                    catch (error) { closeStatus = 'failed: ' + error; }
                }
                $.Msg('[InviteEveryone] Done: requests=' + attempts + '; success=' + (results - rejected) +
                    '; rejected=' + rejected + '; ' + (Date.now() - startedAt) + 'ms; popup-close=' + closeStatus + '.');
                return;
            }
            $.Msg('[InviteEveryone] ' + reason + '; native activation requests: ' + attempts +
                '; result dialogs: ' + results + '; rejected: ' + rejected +
                '. Dispatch is not a server acknowledgement.');
        };
        const schedule = (delay, callback) => {
            job = $.Schedule(delay, () => {
                job = null;
                try { callback(); }
                catch (error) { finish('Stopped: ' + error); }
            });
        };
        const listStillOwned = () => {
            if (!valid(list) || list.visible === false || !valid(menu) ||
                menu.visible === false || menu.BHasClass('Hidden')) return false;
            // Parent crumbs also reject a valid handle moved to another popup.
            const category = list.GetParent();
            const friends = valid(category) ? category.GetParent() : null;
            const main = valid(friends) ? friends.GetParent() : null;
            const currentMenu = valid(main) ? main.GetParent() : null;
            let popupAncestor = menu;
            for (let i = 0; valid(popupAncestor) && popupAncestor !== popup && i < 4; i++) {
                popupAncestor = popupAncestor.GetParent();
            }
            return valid(category) && category.id === 'FriendsCanInvite' &&
                valid(friends) && friends.id === 'FriendPanelFriendsList' &&
                valid(main) && main.id === 'FriendPanelMainAreaContainer' &&
                currentMenu === menu && popupAncestor === popup &&
                child(category, 'FriendList') === list;
        };
        const collectResults = () => {
            if (!valid(manager) || manager !== child(hud, 'PopupManager')) {
                finish('Cancelled: popup manager replaced'); return false;
            }
            let blocked = false;
            for (const dialog of closing) {
                if (!valid(dialog) || dialog.BHasClass('Hidden') || dialog.visible === false) closing.delete(dialog);
                else blocked = true; // native OK was already clicked; never click it twice
            }
            // Process the top of the native popup stack first. Do not touch old
            // dialogs or unrelated new UI. ConfirmUseTool/Button0/isAutoConfirm
            // come from the maintainer's actual result-dialog debugger capture.
            for (const dialog of manager.Children().reverse()) {
                if (!valid(dialog) || dialog === popup || baseline.has(dialog) || closing.has(dialog) ||
                    !dialog.BHasClass('PopupPanel') || dialog.BHasClass('Hidden') || dialog.visible === false) continue;
                if (dialog.paneltype !== 'PopupGeneric') { blocked = true; continue; }
                const title = child(dialog, 'TitleLabel');
                const message = child(byClass(dialog, 'MessagePanel'), 'MessageLabel');
                if (valid(title) && valid(message) && matches(title.text, 'SubmitProcessingTitle') &&
                    matches(message.text, 'SubmitProcessing')) continue; // allow bounded overlapping requests
                if (dialog.id !== 'ConfirmUseTool') { blocked = true; continue; }
                const kind = valid(message) ? resultTokens.find(name => matches(message.text, 'Result_' + name)) : null;
                if (!kind || !valid(title) || !matches(title.text,
                    'Result_' + (kind === 'Success' ? 'SuccessTitle' : 'GenericFailureTitle'))) {
                    blocked = true; continue; // loading or unrecognized message: wait, do not acknowledge
                }
                const buttons = child(dialog, 'ButtonContainer');
                const ok = child(buttons, 'Button0');
                if (!valid(ok) || ok.enabled === false || !ok.BHasClass('PopupButton') ||
                    !ok.BHasClass('isAutoConfirm') || buttons.GetChildCount() !== 1) { blocked = true; continue; }
                closing.add(dialog);
                baseline.add(dialog); // retain identity after native hide; never acknowledge it twice
                // A native result ends one outstanding request. The content is
                // counted separately so a rejection never becomes a success.
                pending = Math.max(0, pending - 1);
                results++;
                if (kind !== 'Success') rejected++;
                deadline = Date.now() + responseTimeout;
                $.DispatchEvent('Activated', ok, 'mouse');
                if (!busy || !popupOpen()) return false;
                if (!valid(dialog) || dialog.BHasClass('Hidden') || dialog.visible === false) closing.delete(dialog);
                else blocked = true;
            }
            return !blocked;
        };
        const batch = () => {
            if (!popupOpen() || !listStillOwned()) { finish('Cancelled: menu/list closed or replaced'); return; }
            let canSend = collectResults();
            if (!busy) return;
            let processed = 0;
            while (canSend && cursor < queue.length && pending < batchSize && processed++ < batchSize) {
                if (!popupOpen() || !valid(list) || !valid(menu) || menu.BHasClass('Hidden')) {
                    finish('Cancelled: popup closed'); return;
                }
                const entry = queue[cursor++];
                if (!valid(entry) || entry.GetParent() !== list || entry.enabled === false ||
                    entry.visible === false || !entry.BHasClass('Visible')) continue;
                // The debugger capture shows one native CitadelFriend directly
                // inside each CitadelFriendElementContainer. No card-body walk.
                const friend = entry.Children().find(node => valid(node) && node.paneltype === 'CitadelFriend');
                if (!valid(friend) || friend.enabled === false || friend.visible === false ||
                    !friend.BHasClass('CanInvite') || !friend.BHasClass('FriendMenu')) continue;
                attempts++;
                pending++;
                deadline = Date.now() + responseTimeout;
                $.DispatchEvent('Activated', friend, 'mouse');
                if (!busy) return;
                canSend = collectResults();
                if (!busy) return;
            }
            if (cursor >= queue.length && pending === 0 && closing.size === 0 && canSend) {
                finish('Finished loaded eligible list', true); return;
            }
            if (Date.now() >= deadline) { finish('Stopped: native result/OK timeout; no further invitations queued'); return; }
            schedule(canSend && cursor < queue.length && pending < batchSize ? 0.001 : responseStep, batch);
        };
        const waitForList = () => {
            if (!active()) { finish('Cancelled: escape menu closed'); return; }
            manager = child(hud, 'PopupManager');
            const next = valid(manager) ? manager.Children().find(node => valid(node) &&
                node.paneltype === 'PopupPlaytestUser' && !node.BHasClass('Hidden') && node.visible !== false) : null;
            // Once bound, never redirect an in-flight operation to a new popup.
            if (popup && (!popupOpen() || next !== popup)) { finish('Cancelled: popup replaced or closed'); return; }
            if (next) {
                popup = next;
                // The only descendant lookup is scoped to this small native popup.
                menu = popup.FindChildTraverse('FriendMenu');
                list = listIn(menu);
                if (valid(menu) && !menu.BHasClass('Hidden') && valid(list)) {
                    queue = list.Children();
                    if (queue.length) {
                        baseline = new Set(manager.Children());
                        cursor = 0;
                        deadline = Date.now() + responseTimeout;
                        schedule(0.001, batch); return;
                    }
                }
            }
            if (++waits >= waitLimit) { finish('No loaded eligible list within 5 seconds; reopen and retry if still loading'); return; }
            schedule(waitStep, waitForList);
        };
        const start = () => {
            if (busy || !active()) return;
            // Native friends_list.xml owns CitadelSubmitPlaytestUser. Activate
            // that existing button in its own context instead of guessing an API.
            // FriendsOrPlayersContents is a class, not an ID in native XML.
            const contents = byClass(child(escape, 'RightSide'), 'FriendsOrPlayersContents');
            const sidebar = path(contents, ['FriendsTabContents', 'FriendsList']);
            const recommend = byClass(byClass(byClass(sidebar, 'Footer'), 'RecommendSection'), 'RecommendButton');
            if (!valid(recommend) || recommend.enabled === false) {
                $.Msg('[InviteEveryone] Native RecommendButton unavailable.');
                return;
            }
            busy = true;
            startedAt = Date.now();
            attempts = waits = cursor = 0;
            results = rejected = pending = 0;
            texts = new Map(resultTokens.map(name => 'Result_' + name)
                .concat(['Result_SuccessTitle', 'Result_GenericFailureTitle', 'SubmitProcessingTitle', 'SubmitProcessing'])
                .map(name => [name, normalize($.Localize(token(name)))]));
            button.enabled = false;
            try {
                $.DispatchEvent('Activated', recommend, 'mouse');
                // Native activation can synchronously rebuild our script owner.
                // Do not resurrect a disposed controller after it returns.
                if (!active()) { finish('Cancelled while opening popup'); return; }
                schedule(waitStep, waitForList);
            } catch (error) { finish('Could not open invite popup: ' + error); }
        };
        escape.__inviteEveryoneController = {
            owner, ensureButton,
            dispose() { disposed = true; if (busy) finish('Controller disposed'); }
        };
        waitingFor = 'SubOptions';
        return ensureButton();
    };

    let bootstrapJob = null;
    let bootstrapAttempts = 0;
    let initialized = false;
    let seenValid = false;
    const bootstrap = () => {
        bootstrapJob = null;
        if (seenValid && !valid(owner)) return; // destroyed, not still constructing
        seenValid = seenValid || valid(owner);
        try {
            if (initialize()) {
                initialized = true;
                $.Msg(waitingFor === 'sidebar outside EscapeMenu'
                    ? '[InviteEveryone] Sidebar outside EscapeMenu; injection skipped.'
                    : '[InviteEveryone] Ready: Invite button at EscapeMenu/LeftStripe/Menu/SubOptions.');
                return;
            }
        } catch (error) { waitingFor = String(error); }
        if (++bootstrapAttempts >= 100) {
            $.Msg('[InviteEveryone] Button initialization timed out: ' + waitingFor +
                '. Check that citadel_hud_combat_log.xml and invite_everyone.js from this mod are loaded.');
            return;
        }
        bootstrapJob = $.Schedule(0.05, bootstrap);
    };
    const kick = () => {
        if (bootstrapJob !== null) return;
        if (initialized && valid(owner) && initialize()) return;
        bootstrapAttempts = 0;
        initialized = false;
        bootstrapJob = $.Schedule(0, bootstrap);
    };
    if (owner) owner.__inviteEveryoneBootstrap = { kick };
    $.InviteEveryoneInit = kick;
    kick(); // Do not depend on a C++ root onload callback to insert the button.
})();
