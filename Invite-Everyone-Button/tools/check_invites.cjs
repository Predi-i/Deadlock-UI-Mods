'use strict';
// Development-only regression/performance harness using QOLLOCK's real probes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flag = process.argv.indexOf('--qollock');
if (flag < 0 || !process.argv[flag + 1]) throw new Error('Usage: node check_invites.cjs --qollock <QOLLOCK checkout>');
const simulator = path.resolve(process.argv[flag + 1], 'scripts/simulator');
const { Clock } = require(path.join(simulator, 'clock.js'));
const { Document, Panel } = require(path.join(simulator, 'panel.js'));
const { Sandbox } = require(path.join(simulator, 'sandbox.js'));
const { install } = require(path.join(simulator, 'perf/instrument.js'));
const { installScheduleProbe } = require(path.join(simulator, 'perf/schedules.js'));
const counters = install();
const sourcePath = path.resolve(__dirname, '../panorama/scripts/invite_everyone.js');
const source = fs.readFileSync(sourcePath, 'utf8');
let passed = 0;
let enumeration = { calls: 0, nodes: 0 };
const children = Panel.prototype.Children;
Panel.prototype.Children = function () {
    const result = children.call(this);
    if (counters.enabled) { enumeration.calls++; enumeration.nodes += result.length; }
    return result;
};
function test(name, callback) {
    counters.enabled = false;
    callback();
    passed++;
    console.log('PASS ' + name);
}
function fixture(count = 15, { noise = 0, acknowledge = true, attached = true,
    contextValid = true, anchorReady = true, contextSource = 'host', result = 'Success',
    responseDelay = 0, closeDelay = 0, dismiss = true, processing = false } = {}) {
    counters.enabled = false;
    const clock = new Clock();
    const doc = new Document(clock);
    const add = (parent, type = 'Panel', id = '', classes = []) => parent.addChild(doc.create(type, { id, classes }));
    const hud = doc.root;
    hud.AddClass('ShowEscapeMenu');
    const irrelevant = add(hud, 'Panel', 'HudCore');
    for (let i = 0; i < noise; i++) add(irrelevant, 'Panel', 'unrelated_' + i);
    const escape = add(hud, 'CitadelHudEscapeMenu', 'EscapeMenu');
    const escapeClose = add(escape, 'Button', 'EscapeButton');
    const escapeMenuBody = add(add(escape, 'Panel', 'LeftStripe'), 'Panel', 'Menu');
    const anchor = add(escapeMenuBody, 'Panel', 'SubOptions');
    const settings = add(anchor, 'Panel', '', ['SettingsRow']);
    const contents = add(add(escape, 'Panel', 'RightSide'), 'Panel', '', ['FriendsOrPlayersContents']);
    const tab = add(contents, 'TabContents', 'FriendsTabContents');
    const sidebar = add(tab, 'CitadelFriendsList', 'FriendsList');
    let owner = add(hud, 'CitadelHudCombatLog', 'CitadelHudCombatLog', ['Closed']);
    const makeRecommend = sidebar => add(add(add(sidebar, 'Panel', '', ['Footer']), 'Panel', '', ['RecommendSection']),
        'Button', '', ['RecommendButton']);
    const recommend = makeRecommend(sidebar);
    // The simulator's SetParent(null) is a no-op; model native pre-attachment
    // explicitly rather than accidentally testing an already mounted sidebar.
    const detach = panel => {
        const parent = panel.GetParent();
        if (parent) parent._children.splice(parent._children.indexOf(panel), 1);
        panel._parent = null;
    };
    if (!attached) detach(owner);
    if (!contextValid) owner._valid = false;
    if (!anchorReady) detach(anchor);
    const manager = add(hud, 'PopupManager', 'PopupManager');
    // Only these small native subtrees are captured by the provided screenshots.
    let popup, menu, list, invited, popupClose, friends = [];
    const popupClosures = [];
    function makePopup(size = count) {
        popup = add(manager, 'PopupPlaytestUser', '', ['PopupPanel']);
        const body = add(popup, 'Panel', '', ['MainBody']);
        const left = add(add(body, 'Panel', '', ['formContents']), 'Panel', '', ['LeftSide']);
        popupClose = add(body, 'Button', 'EscapeButton');
        menu = add(left, 'CitadelInviteFriendMenu', 'FriendMenu');
        const main = add(menu, 'Panel', 'FriendPanelMainAreaContainer');
        const area = add(main, 'Panel', 'FriendPanelFriendsList');
        list = add(add(area, 'Panel', 'FriendsCanInvite'), 'Panel', 'FriendList');
        invited = add(add(area, 'Panel', 'FriendsInvited'), 'Panel', 'FriendList');
        const already = add(add(area, 'Panel', 'FriendsAlreadyOwned'), 'Panel', 'FriendList');
        add(add(already, 'CitadelFriendElementContainer', '', ['Visible']), 'CitadelFriend', '', ['CanInvite', 'FriendMenu']);
        friends = [];
        for (let i = 0; i < size; i++) {
            const entry = add(list, 'CitadelFriendElementContainer', '', ['Visible', 'FriendMenu']);
            const friend = add(entry, 'CitadelFriend', '', ['SoloFriend', 'CanInvite', 'FriendMenu']);
            add(friend, 'Panel', 'FriendDetails');
            friends.push(friend);
        }
        return popup;
    }
    const sandbox = new Sandbox({ clock, doc });
    const $ = sandbox.global.$;
    if (contextSource === 'window') doc.absRoot.AddClass('WindowRoot');
    $.GetContextPanel = () => contextSource === 'hud' ? hud : contextSource === 'window' ? doc.absRoot : owner;
    const probe = installScheduleProbe(sandbox);
    const requests = [];
    const confirmations = [];
    const resultDialogs = [];
    let inFlight = 0;
    let peakInFlight = 0;
    function makeResult(kind = 'Success', { id = 'ConfirmUseTool', raw = true } = {}) {
        const dialog = add(manager, 'PopupGeneric', id, ['PopupPanel']);
        const title = add(dialog, 'Label', 'TitleLabel');
        const message = add(add(dialog, 'Panel', '', ['MessagePanel']), 'Label', 'MessageLabel');
        const prefix = '#Citadel_PlaytestUser_Result_';
        title.text = raw ? prefix + (kind === 'Success' ? 'SuccessTitle' : 'GenericFailureTitle') :
            $.Localize(prefix + (kind === 'Success' ? 'SuccessTitle' : 'GenericFailureTitle'));
        message.text = raw ? prefix + kind : $.Localize(prefix + kind);
        const ok = add(add(dialog, 'Panel', 'ButtonContainer'), 'Button', 'Button0', ['PopupButton', 'isAutoConfirm']);
        resultDialogs.push({ dialog, ok, kind });
        return { dialog, ok, kind };
    }
    let openCalls = 0;
    let open = () => { if (!popup || !popup.IsValid()) makePopup(); };
    let onFriend = () => {};
    $.DispatchEvent = (event, target, from) => {
        assert.equal(event, 'Activated'); assert.equal(from, 'mouse');
        if (target === recommend) { openCalls++; open(); return; }
        if (target.id === 'EscapeButton') {
            assert.notEqual(target, escapeClose, 'never close the Esc menu');
            assert.equal(target, popupClose, 'close only the captured invitation popup');
            assert.ok(!popupClosures.some(row => row.target === target), 'close once per run');
            assert.ok(resultDialogs.every(row => !row.dialog.IsValid()), 'await all native result dismissals');
            popupClosures.push({ target, at: clock.now() });
            const enabled = counters.enabled; counters.enabled = false;
            try { popup._destroy(); } finally { counters.enabled = enabled; }
            return;
        }
        if (target.id === 'Button0') {
            const row = resultDialogs.find(item => item.ok === target);
            assert.ok(row, 'must activate a captured native result OK button');
            assert.ok(!confirmations.includes(target), 'never activate the same OK twice');
            confirmations.push(target);
            const enabled = counters.enabled; counters.enabled = false;
            try {
                if (dismiss) {
                    if (closeDelay) clock.schedule(closeDelay, () => row.dialog._destroy());
                    else row.dialog._destroy();
                }
            } finally { counters.enabled = enabled; }
            return;
        }
        assert.equal(target.paneltype, 'CitadelFriend');
        assert.equal(target.GetParent().GetParent(), list, 'must target CanInvite, never another category');
        requests.push({ target, at: clock.now() });
        inFlight++; peakInFlight = Math.max(peakInFlight, inFlight);
        // Exclude native engine reaction from script-operation counters.
        const enabled = counters.enabled; counters.enabled = false;
        try {
            if (acknowledge) { target.RemoveClass('CanInvite'); target.GetParent().SetParent(invited); }
            let loading = null;
            if (processing) {
                loading = makeResult('Success').dialog;
                loading.FindChild('TitleLabel').text = '#Citadel_PlaytestUser_SubmitProcessingTitle';
                loading.FindChildTraverse('MessageLabel').text = '#Citadel_PlaytestUser_SubmitProcessing';
            }
            if (result) {
                const reply = () => {
                    if (loading && loading.IsValid()) loading._destroy();
                    makeResult(result); inFlight--;
                };
                if (responseDelay) clock.schedule(responseDelay, reply);
                else reply();
            }
            onFriend(target);
        } finally { counters.enabled = enabled; }
    };
    const load = () => vm.runInContext(source, sandbox.context, { filename: sourcePath });
    // Execute the actual include and its deferred boot. Do not synthesize XML
    // onload or call the initializer manually: that hid the original defect.
    const init = () => { load(); clock.advance(0); };
    const reset = () => { counters.reset(); enumeration = { calls: 0, nodes: 0 }; probe.resetWindow(); counters.enabled = true; };
    init();
    return {
        clock, doc, sandbox, probe, hud, escape, anchor, escapeMenuBody, settings, tab, add,
        requests, confirmations, resultDialogs, popupClosures, manager, init, load, reset, makePopup, makeResult,
        get popupClose() { return popupClose; },
        get owner() { return owner; }, get popup() { return popup; }, get menu() { return menu; },
        get list() { return list; }, get friends() { return friends; }, get openCalls() { return openCalls; },
        get peakInFlight() { return peakInFlight; },
        get button() { return anchor.FindChild('InviteEveryone'); },
        setOpen(fn) { open = fn; }, setOnFriend(fn) { onFriend = fn; },
        replaceOwner() { owner._destroy(); owner = add(hud, 'CitadelHudCombatLog', 'CitadelHudCombatLog', ['Closed']); init(); },
        start() { this.button.activate(); },
        checkErrors() { assert.deepEqual(clock.errors, []); assert.deepEqual(doc.eventErrors, []); }
    };
}
test('single controller/button, native insertion and 60 seconds with zero idle schedules/operations', () => {
    const r = fixture();
    const controller = r.escape.__inviteEveryoneController;
    const button = r.button;
    for (let i = 0; i < 20; i++) r.init();
    assert.equal(r.escape.__inviteEveryoneController, controller);
    assert.equal(r.anchor.Children().filter(p => p.id === 'InviteEveryone').length, 1);
    assert.ok(r.anchor.Children().indexOf(button) < r.anchor.Children().indexOf(r.settings));
    r.reset(); r.clock.advance(60000);
    assert.equal(r.clock.pendingCount(), 0);
    assert.equal(counters.snapshot(60).total.costUnits, 0);
    assert.deepEqual(enumeration, { calls: 0, nodes: 0 });
    assert.ok(r.probe.snapshot().every(row => row.scheduled === 0 && row.fired === 0 && row.pending === 0));
});
test('include alone inserts the button without an XML onload callback', () => {
    const r = fixture();
    assert.ok(r.button && r.button.IsValid());
    assert.equal(r.button.Children()[0].text, 'Invite');
    assert.equal(r.clock.pendingCount(), 0);
    r.checkErrors();
});
test('HUD/WindowRoot inherited script contexts resolve the native Esc route directly', () => {
    for (const contextSource of ['hud', 'window']) {
        const r = fixture(15, { contextSource });
        assert.ok(r.button && r.button.IsValid());
        assert.equal(r.clock.pendingCount(), 0);
        r.start(); r.clock.advance(1000);
        assert.equal(r.requests.length, 15); r.checkErrors();
    }
});
test('detached/initially invalid HUD host and missing anchor retry once per tick then stop', () => {
    for (const state of [{ attached: false }, { contextValid: false }, { anchorReady: false }]) {
        const r = fixture(15, state);
        assert.ok(r.button === null);
        assert.equal(r.clock.pendingCount(), 1);
        for (let i = 0; i < 20; i++) r.load();
        assert.equal(r.clock.pendingCount(), 1, 'repeat includes must reuse the pending bootstrap');
        r.clock.advance(100);
        r.owner._valid = true;
        if (state.attached === false) r.owner.SetParent(r.hud);
        if (state.anchorReady === false) r.anchor.SetParent(r.escapeMenuBody);
        r.clock.advance(100);
        assert.ok(r.button && r.button.IsValid());
        assert.equal(r.clock.pendingCount(), 0);
        assert.equal(r.anchor.Children().filter(panel => panel.id === 'InviteEveryone').length, 1);
        r.reset(); r.clock.advance(60000);
        assert.equal(counters.snapshot(60).total.costUnits, 0);
        assert.equal(r.clock.pendingCount(), 0); r.checkErrors();
    }
});
test('bootstrap times out with a specific diagnostic; no perpetual injection loop', () => {
    const r = fixture(15, { attached: false });
    r.clock.advance(6000);
    assert.equal(r.button, null); assert.equal(r.clock.pendingCount(), 0);
    assert.ok(r.sandbox.messages.some(line => line.includes('Button initialization timed out: HUD host attachment')));
    r.checkErrors();
});
test('destroyed HUD host stops a pending bootstrap', () => {
    const r = fixture(15, { attached: false });
    r.owner._destroy(); r.clock.advance(100);
    assert.equal(r.button, null); assert.equal(r.clock.pendingCount(), 0); r.checkErrors();
});
test('1000 friends: bounded batches, one pending continuation, only popup-scoped traversal', () => {
    const r = fixture(1000, { noise: 5000 });
    r.makePopup();
    r.reset();
    const traversalScopes = [];
    counters.onTraverse = event => traversalScopes.push(event.rootPanel);
    r.start(); r.start();
    r.clock.advance(1000);
    assert.equal(r.openCalls, 1);
    assert.equal(r.requests.length, 1000);
    assert.equal(new Set(r.requests.map(row => row.target)).size, 1000);
    const bursts = new Map();
    for (const row of r.requests) bursts.set(row.at, (bursts.get(row.at) || 0) + 1);
    assert.equal(Math.max(...bursts.values()), 8);
    assert.ok(traversalScopes.every(scope => scope === r.popup));
    assert.equal(traversalScopes.length, 1, 'cache the popup menu before batching');
    const schedules = r.probe.snapshot();
    assert.equal(schedules.reduce((n, row) => n + row.scheduled, 0), 126);
    assert.ok(schedules.every(row => row.peak <= 1 && row.pending === 0 && row.errors === 0));
    assert.equal(r.clock.pendingCount(), 0);
    assert.equal(r.button.enabled, true);
    r.checkErrors();
    console.log(JSON.stringify({ fixtureFriends: 1000, unrelatedPanels: 5000,
        operations: counters.snapshot(1).total, childEnumeration: enumeration, schedules }, null, 2));
    counters.onTraverse = null;
    r.reset(); r.clock.advance(60000);
    assert.equal(counters.snapshot(60).total.costUnits, 0);
    assert.equal(r.clock.pendingCount(), 0);
});
test('skip disabled, destroyed, hidden and ineligible cards; do not traverse card bodies', () => {
    const r = fixture(15); r.makePopup();
    r.friends[0].enabled = false;
    r.friends[1].RemoveClass('CanInvite');
    r.friends[2].GetParent().RemoveClass('Visible');
    r.friends[3]._destroy();
    r.friends[4].visible = false;
    r.start(); r.clock.advance(1000);
    assert.equal(r.requests.length, 10); r.checkErrors();
});
test('no acknowledgement never produces duplicate activation inside one run', () => {
    const r = fixture(25, { acknowledge: false });
    r.start(); r.clock.advance(1000);
    assert.equal(r.requests.length, 25);
    assert.equal(r.clock.pendingCount(), 0);
    assert.ok(r.sandbox.messages.some(line => line.includes('Done: requests=25; success=25; rejected=0;')));
    r.checkErrors();
});
test('wait for asynchronous native popup population', () => {
    const r = fixture(15);
    r.setOpen(() => r.clock.schedule(0.4, () => r.makePopup()));
    r.start(); r.clock.advance(1000);
    assert.equal(r.requests.length, 15); r.checkErrors();
});
test('empty/missing popup waits are bounded and restore the button', () => {
    for (const emptyPopup of [false, true]) {
        const r = fixture(0); r.setOpen(() => { if (emptyPopup) r.makePopup(); });
        r.start(); r.clock.advance(6000);
        assert.equal(r.requests.length, 0); assert.equal(r.clock.pendingCount(), 0);
        assert.equal(r.button.enabled, true); r.checkErrors();
    }
});
test('close escape menu/popup or destroy owner/HUD midway: stop and drain', () => {
    for (const action of [r => r.hud.RemoveClass('ShowEscapeMenu'), r => r.popup.AddClass('Hidden'),
        r => r.menu.AddClass('Hidden'), r => { r.list.visible = false; },
        r => r.owner._destroy(), r => r.hud._destroy(), r => r.popup._destroy()]) {
        const r = fixture(100); r.start(); r.clock.advance(51);
        assert.equal(r.requests.length, 8);
        action(r); r.clock.advance(1000);
        assert.equal(r.requests.length, 8); assert.equal(r.clock.pendingCount(), 0); r.checkErrors();
    }
});
test('synchronous popup closure during an activation prevents the rest of that batch', () => {
    const r = fixture(100); r.setOnFriend(() => r.popup.AddClass('Hidden'));
    r.start(); r.clock.advance(1000);
    assert.equal(r.requests.length, 1); assert.equal(r.clock.pendingCount(), 0); r.checkErrors();
});
test('valid old list replaced in popup must not receive more activations', () => {
    const r = fixture(100); r.start(); r.clock.advance(51);
    const category = r.list.GetParent();
    r.list.SetParent(r.hud); r.add(category, 'Panel', 'FriendList');
    r.clock.advance(1000);
    assert.equal(r.requests.length, 8); assert.equal(r.clock.pendingCount(), 0); r.checkErrors();
});
test('owner replacement cancels old work and rebinds the existing button', () => {
    const r = fixture(100); const button = r.button;
    r.start(); r.clock.advance(51);
    r.replaceOwner();
    assert.equal(r.button, button); assert.equal(r.clock.pendingCount(), 0);
    r.start(); r.clock.advance(1000);
    assert.equal(r.requests.length, 100); assert.equal(r.openCalls, 2); r.checkErrors();
});
test('button replacement reattaches only on host layout init', () => {
    const r = fixture(); r.button._destroy(); r.init();
    assert.ok(r.button.IsValid()); assert.equal(r.clock.pendingCount(), 0);
});
test('native opening failure/reentrant owner replacement leaves no retired schedules', () => {
    for (const replace of [false, true]) {
        const r = fixture();
        r.setOpen(() => { if (replace) r.replaceOwner(); else throw new Error('native failure'); });
        r.start(); assert.equal(r.clock.pendingCount(), 0); assert.equal(r.button.enabled, true); r.checkErrors();
    }
});
test('captured limited-Steam failures close through native OK without piling up', () => {
    const r = fixture(100, { result: 'LimitedUser', acknowledge: false });
    r.start(); r.clock.advance(1000);
    assert.equal(r.requests.length, 100); assert.equal(r.confirmations.length, 100);
    assert.ok(r.resultDialogs.every(row => !row.dialog.IsValid()));
    assert.ok(r.sandbox.messages.some(line => line.includes('rejected=100')));
    assert.equal(r.clock.pendingCount(), 0); r.checkErrors();
});
test('delayed native replies overlap with a maximum of eight in flight', () => {
    for (const processing of [false, true]) {
        const r = fixture(40, { result: 'LimitedUser', responseDelay: 0.2, processing });
        r.start(); r.clock.advance(100);
        assert.equal(r.requests.length, 8); assert.equal(r.confirmations.length, 0);
        r.clock.advance(2000);
        assert.equal(r.requests.length, 40); assert.equal(r.confirmations.length, 40);
        assert.equal(r.peakInFlight, 8);
        assert.equal(r.clock.pendingCount(), 0);
        assert.ok(r.probe.snapshot().every(row => row.peak <= 1 && row.pending === 0));
        r.checkErrors();
    }
});
test('last asynchronous replies are closed even after the friend snapshot was exhausted', () => {
    const r = fixture(5, { responseDelay: 0.4 });
    r.start(); r.clock.advance(100);
    assert.equal(r.requests.length, 5); assert.equal(r.confirmations.length, 0);
    assert.equal(r.button.enabled, false);
    r.clock.advance(1000);
    assert.equal(r.confirmations.length, 5); assert.equal(r.button.enabled, true);
    assert.equal(r.clock.pendingCount(), 0); r.checkErrors();
});
test('unanswered native requests stop at eight and time out without endless schedules', () => {
    const r = fixture(100, { result: null });
    r.start(); r.clock.advance(6000);
    assert.equal(r.requests.length, 8); assert.equal(r.confirmations.length, 0);
    assert.equal(r.clock.pendingCount(), 0); assert.equal(r.button.enabled, true);
    assert.ok(r.sandbox.messages.some(line => line.includes('native result/OK timeout')));
    r.reset(); r.clock.advance(60000);
    assert.equal(counters.snapshot(60).total.costUnits, 0); r.checkErrors();
});
test('pre-existing result dialogs and unrelated new dialogs are never acknowledged', () => {
    const r = fixture(20); r.makePopup();
    const old = r.makeResult('LimitedUser');
    let unrelated;
    r.setOnFriend(() => { unrelated = r.makeResult('Unknown'); });
    r.start(); r.clock.advance(6000);
    assert.equal(r.requests.length, 1);
    assert.equal(r.confirmations.length, 1, 'close only the new recognized invitation result');
    assert.ok(old.dialog.IsValid()); assert.ok(unrelated.dialog.IsValid());
    assert.ok(!r.confirmations.includes(old.ok) && !r.confirmations.includes(unrelated.ok));
    assert.equal(r.clock.pendingCount(), 0); r.checkErrors();
});
test('result close failure never clicks OK repeatedly or creates additional dialogs', () => {
    const r = fixture(100, { dismiss: false });
    r.start(); r.clock.advance(6000);
    assert.equal(r.requests.length, 1); assert.equal(r.confirmations.length, 1);
    assert.equal(r.clock.pendingCount(), 0); assert.equal(r.button.enabled, true); r.checkErrors();
});
test('asynchronous native dismissal is awaited without duplicate OK activation', () => {
    const r = fixture(20, { closeDelay: 0.03 });
    r.start(); r.clock.advance(2000);
    assert.equal(r.requests.length, 20); assert.equal(r.confirmations.length, 20);
    assert.equal(r.clock.pendingCount(), 0); r.checkErrors();
});
test('a dialog without the captured single auto-confirm button is preserved', () => {
    const r = fixture(100);
    r.setOnFriend(() => r.resultDialogs.at(-1).ok.RemoveClass('isAutoConfirm'));
    r.start(); r.clock.advance(6000);
    assert.equal(r.requests.length, 1); assert.equal(r.confirmations.length, 0);
    assert.equal(r.clock.pendingCount(), 0); r.checkErrors();
});
test('localized native title/body matching handles rejected users', () => {
    const r = fixture(20, { result: 'LimitedUser' });
    Object.assign(r.sandbox.localization, {
        Citadel_PlaytestUser_Result_GenericFailureTitle: 'Отправить не удалось',
        Citadel_PlaytestUser_Result_LimitedUser: 'У этого пользователя ограниченный аккаунт Steam.'
    });
    r.setOnFriend(() => {
        const dialog = r.resultDialogs.at(-1).dialog;
        const title = dialog.FindChild('TitleLabel');
        const message = dialog.FindChildTraverse('MessageLabel');
        title.text = r.sandbox.global.$.Localize(title.text);
        message.text = r.sandbox.global.$.Localize(message.text);
    });
    r.start(); r.clock.advance(1000);
    assert.equal(r.requests.length, 20); assert.equal(r.confirmations.length, 20);
    assert.ok(r.sandbox.messages.some(line => line.includes('rejected=20'))); r.checkErrors();
});

test('completion closes the invitation popup once after delayed replies and OK dismissal; logs a short result', () => {
    const r = fixture(5, { responseDelay: 0.4, closeDelay: 0.03 });
    r.start(); r.clock.advance(460);
    assert.equal(r.confirmations.length, 5);
    assert.equal(r.popupClosures.length, 0, 'do not close under a dismissing result dialog');
    r.clock.advance(1000);
    assert.equal(r.popupClosures.length, 1); assert.equal(r.popup.IsValid(), false);
    assert.ok(r.hud.BHasClass('ShowEscapeMenu'));
    const done = r.sandbox.messages.filter(line => line.includes('Done:'));
    assert.equal(done.length, 1);
    assert.match(done[0], /Done: requests=5; success=5; rejected=0; \d+ms; popup-close=activated\./);
    assert.equal(r.clock.pendingCount(), 0); r.checkErrors();
});

test('cancellation, unanswered requests and unknown dialogs preserve the invitation popup', () => {
    for (const state of ['cancel', 'timeout', 'unknown']) {
        const r = fixture(100, { result: state === 'timeout' ? null : state === 'unknown' ? 'Unknown' : 'Success' });
        r.start(); r.clock.advance(51);
        if (state === 'cancel') r.hud.RemoveClass('ShowEscapeMenu');
        r.clock.advance(6000);
        assert.equal(r.popupClosures.length, 0); assert.ok(r.popup.IsValid());
        assert.ok(!r.sandbox.messages.some(line => line.includes('Done:')));
        assert.equal(r.clock.pendingCount(), 0); r.checkErrors();
    }
});

test('missing or disabled native Close ends cleanly with a diagnostic and no idle work', () => {
    for (const missing of [false, true]) {
        const r = fixture(5); r.makePopup();
        if (missing) r.popupClose._destroy(); else r.popupClose.enabled = false;
        r.start(); r.clock.advance(1000);
        assert.equal(r.requests.length, 5); assert.equal(r.popupClosures.length, 0);
        assert.ok(r.popup.IsValid()); assert.equal(r.button.enabled, true);
        assert.ok(r.sandbox.messages.some(line => line.includes('Done:') && line.includes('popup-close=unavailable')));
        assert.equal(r.clock.pendingCount(), 0); r.checkErrors();
    }
});
test('the shipped loader avoids all current QOLLOCK/Minigames XML overrides', () => {
    const layoutDir = path.resolve(__dirname, '../panorama/layout');
    const xml = fs.readFileSync(path.join(layoutDir, 'citadel_hud_combat_log.xml'), 'utf8');
    assert.ok(xml.includes('s2r://panorama/scripts/invite_everyone.vjs_c'));
    assert.ok(!fs.existsSync(path.join(layoutDir, 'friends_list.xml')));
    assert.ok(!fs.existsSync(path.join(layoutDir, 'hud_escape_menu.xml')));
    const qollock = path.resolve(process.argv[flag + 1]);
    assert.ok(fs.readFileSync(path.join(qollock, 'panorama/layout/friends_list.xml'), 'utf8').includes('FriendSearchInput'));
    assert.ok(fs.readFileSync(path.join(qollock, 'panorama/layout/hud.xml'), 'utf8')
        .includes('<CitadelHudCombatLog id="CitadelHudCombatLog"'));
    for (const name of fs.readdirSync(layoutDir)) {
        assert.ok(!fs.existsSync(path.join(qollock, 'panorama/layout', name)));
        assert.ok(!fs.existsSync(path.resolve(__dirname, '../../Minigames/panorama/layout', name)));
    }
});
console.log(`${passed} focused regressions passed. Model operations/schedules only; no engine FPS or server acceptance measured.`);
