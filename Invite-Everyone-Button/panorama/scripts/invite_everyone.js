// Loaded by friends_list.xml, never by individual friend cards or popups.
(() => {
    'use strict';
    const valid = panel => !!(panel && panel.IsValid());
    const child = (panel, id) => valid(panel) ? panel.FindChild(id) : null;
    const byClass = (panel, name) => valid(panel)
        ? panel.Children().find(node => valid(node) && node.BHasClass(name)) || null : null;
    const path = (panel, ids) => ids.reduce(child, panel);

    $.InviteEveryoneInit = () => {
        const owner = $.GetContextPanel();
        let escape = owner;
        for (let i = 0; valid(escape) && escape.paneltype !== 'CitadelHudEscapeMenu' && i < 12; i++) {
            escape = escape.GetParent();
        }
        // Other friends-list instances (e.g. dashboard) do no work.
        if (!valid(escape) || escape.paneltype !== 'CitadelHudEscapeMenu') return;
        // onload/repeated script evaluation must not allocate a second controller.
        if (escape.__inviteEveryoneController) {
            const previous = escape.__inviteEveryoneController;
            if (valid(previous.owner)) { previous.ensureButton(); return; }
            // A destroyed script context cannot own future scheduled work.
            previous.dispose();
        }
        const hud = escape.GetParent();
        if (!valid(hud) || hud.id !== 'Hud') return;
        let button = null;
        const ensureButton = () => {
            if (valid(button)) return;
            const anchor = path(escape, ['LeftStripe', 'Menu', 'SubOptions']);
            if (!valid(anchor)) { $.Msg('[InviteEveryone] Native SubOptions unavailable.'); return; }
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
        };

        // Work limits, not persisted settings. A single continuation yields
        // between batches; no per-friend timers and no idle watchdog.
        const batchSize = 8;
        const waitStep = 0.05;
        const waitLimit = 100;
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
        const active = () => !disposed && valid(owner) && valid(escape) && valid(hud) &&
            hud.BHasClass('ShowEscapeMenu');
        const popupOpen = () => active() && valid(popup) &&
            !popup.BHasClass('Hidden') && popup.visible !== false;
        const listIn = menu => path(menu, [
            'FriendPanelMainAreaContainer', 'FriendPanelFriendsList', 'FriendsCanInvite', 'FriendList'
        ]);
        const finish = reason => {
            if (job !== null) $.CancelScheduled(job);
            job = null;
            busy = false;
            queue = [];
            popup = menu = list = null;
            if (valid(button)) button.enabled = true;
            $.Msg('[InviteEveryone] ' + reason + '; native activation requests: ' + attempts +
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
        const batch = () => {
            if (!popupOpen() || !listStillOwned()) { finish('Cancelled: menu/list closed or replaced'); return; }
            const end = Math.min(cursor + batchSize, queue.length);
            for (; cursor < end; cursor++) {
                if (!popupOpen() || !valid(list) || !valid(menu) || menu.BHasClass('Hidden')) {
                    finish('Cancelled: popup closed'); return;
                }
                const entry = queue[cursor];
                if (!valid(entry) || entry.GetParent() !== list || entry.enabled === false ||
                    entry.visible === false || !entry.BHasClass('Visible')) continue;
                // The debugger capture shows one native CitadelFriend directly
                // inside each CitadelFriendElementContainer. No card-body walk.
                const friend = entry.Children().find(node => valid(node) && node.paneltype === 'CitadelFriend');
                if (!valid(friend) || friend.enabled === false || friend.visible === false ||
                    !friend.BHasClass('CanInvite') || !friend.BHasClass('FriendMenu')) continue;
                $.DispatchEvent('Activated', friend, 'mouse');
                attempts++;
            }
            if (cursor < queue.length) schedule(0.001, batch);
            else finish('Finished loaded eligible list');
        };
        const waitForList = () => {
            if (!active()) { finish('Cancelled: escape menu closed'); return; }
            const manager = child(hud, 'PopupManager');
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
                    if (queue.length) { cursor = 0; schedule(0.001, batch); return; }
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
            attempts = waits = cursor = 0;
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
        ensureButton();
    };
})();
