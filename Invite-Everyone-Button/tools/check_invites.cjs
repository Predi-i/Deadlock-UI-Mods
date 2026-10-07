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
    contextValid = true, anchorReady = true, contextSource = 'sidebar' } = {}) {
    counters.enabled = false;
    const clock = new Clock();
    const doc = new Document(clock);
    const add = (parent, type = 'Panel', id = '', classes = []) => parent.addChild(doc.create(type, { id, classes }));
    const hud = doc.root;
    hud.AddClass('ShowEscapeMenu');
    const irrelevant = add(hud, 'Panel', 'HudCore');
    for (let i = 0; i < noise; i++) add(irrelevant, 'Panel', 'unrelated_' + i);
    const escape = add(hud, 'CitadelHudEscapeMenu', 'EscapeMenu');
    const escapeMenuBody = add(add(escape, 'Panel', 'LeftStripe'), 'Panel', 'Menu');
    const anchor = add(escapeMenuBody, 'Panel', 'SubOptions');
    const settings = add(anchor, 'Panel', '', ['SettingsRow']);
    const contents = add(add(escape, 'Panel', 'RightSide'), 'Panel', '', ['FriendsOrPlayersContents']);
    const tab = add(contents, 'TabContents', 'FriendsTabContents');
    let owner = add(tab, 'CitadelFriendsList', 'FriendsList');
    const makeRecommend = sidebar => add(add(add(sidebar, 'Panel', '', ['Footer']), 'Panel', '', ['RecommendSection']),
        'Button', '', ['RecommendButton']);
    let recommend = makeRecommend(owner);
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
    let popup, menu, list, invited, friends = [];
    function makePopup(size = count) {
        popup = add(manager, 'PopupPlaytestUser', '', ['PopupPanel']);
        const left = add(add(add(popup, 'Panel', '', ['MainBody']), 'Panel', '', ['formContents']), 'Panel', '', ['LeftSide']);
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
    let openCalls = 0;
    let open = () => { if (!popup || !popup.IsValid()) makePopup(); };
    let onFriend = () => {};
    $.DispatchEvent = (event, target, from) => {
        assert.equal(event, 'Activated'); assert.equal(from, 'mouse');
        if (target === recommend) { openCalls++; open(); return; }
        assert.equal(target.paneltype, 'CitadelFriend');
        assert.equal(target.GetParent().GetParent(), list, 'must target CanInvite, never another category');
        requests.push({ target, at: clock.now() });
        // Exclude native engine reaction from script-operation counters.
        const enabled = counters.enabled; counters.enabled = false;
        if (acknowledge) { target.RemoveClass('CanInvite'); target.GetParent().SetParent(invited); }
        onFriend(target);
        counters.enabled = enabled;
    };
    const load = () => vm.runInContext(source, sandbox.context, { filename: sourcePath });
    // Execute the actual include and its deferred boot. Do not synthesize XML
    // onload or call the initializer manually: that hid the original defect.
    const init = () => { load(); clock.advance(0); };
    const reset = () => { counters.reset(); enumeration = { calls: 0, nodes: 0 }; probe.resetWindow(); counters.enabled = true; };
    init();
    return {
        clock, doc, sandbox, probe, hud, escape, anchor, escapeMenuBody, settings, tab, add,
        requests, init, load, reset, makePopup,
        get owner() { return owner; }, get popup() { return popup; }, get menu() { return menu; },
        get list() { return list; }, get friends() { return friends; }, get openCalls() { return openCalls; },
        get button() { return anchor.FindChild('InviteEveryone'); },
        setOpen(fn) { open = fn; }, setOnFriend(fn) { onFriend = fn; },
        replaceOwner() { owner._destroy(); owner = add(tab, 'CitadelFriendsList', 'FriendsList'); recommend = makeRecommend(owner); init(); },
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
test('detached/initially invalid sidebar and missing anchor retry once per tick then stop', () => {
    for (const state of [{ attached: false }, { contextValid: false }, { anchorReady: false }]) {
        const r = fixture(15, state);
        assert.ok(r.button === null);
        assert.equal(r.clock.pendingCount(), 1);
        for (let i = 0; i < 20; i++) r.load();
        assert.equal(r.clock.pendingCount(), 1, 'repeat includes must reuse the pending bootstrap');
        r.clock.advance(100);
        r.owner._valid = true;
        if (state.attached === false) r.owner.SetParent(r.tab);
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
    assert.ok(r.sandbox.messages.some(line => line.includes('Button initialization timed out: sidebar attachment')));
    r.checkErrors();
});
test('destroyed sidebar stops a pending bootstrap', () => {
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
    assert.ok(r.sandbox.messages.some(line => line.includes('not a server acknowledgement')));
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
test('button replacement reattaches only on layout init; dashboard lists create no controller', () => {
    const r = fixture(); r.button._destroy(); r.init();
    assert.ok(r.button.IsValid()); assert.equal(r.clock.pendingCount(), 0);
    r.owner.SetParent(r.hud);
    delete r.escape.__inviteEveryoneController;
    r.init(); assert.equal(r.escape.__inviteEveryoneController, undefined);
});
test('native opening failure/reentrant owner replacement leaves no retired schedules', () => {
    for (const replace of [false, true]) {
        const r = fixture();
        r.setOpen(() => { if (replace) r.replaceOwner(); else throw new Error('native failure'); });
        r.start(); assert.equal(r.clock.pendingCount(), 0); assert.equal(r.button.enabled, true); r.checkErrors();
    }
});
console.log(`${passed} focused regressions passed. Model operations/schedules only; no engine FPS or server acceptance measured.`);
