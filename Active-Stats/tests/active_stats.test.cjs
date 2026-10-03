'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../panorama/scripts/active_stats.js'), 'utf8');

function fixture({missingSource = false, missingGameplay = false} = {}) {
    let now = 1000, serial = 0;
    const jobs = new Map(), listeners = new Map(), reads = [];
    class Panel {
        constructor(id = '', classes = [], text = '') {
            this.id = id; this.classes = new Set(classes); this.text = text;
            this.children = []; this.parent = null; this.alive = true; this.visible = true; this.style = {};
        }
        add(panel) { panel.SetParent(this); return panel; }
        SetParent(parent) {
            if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
            this.parent = parent; parent.children.push(this);
        }
        IsValid() { return this.alive; }
        GetParent() { return this.parent; }
        Children() { reads.push({id: this.id, at: now}); return this.children.filter(child => child.alive); }
        FindChild(id) {
            reads.push({id: this.id, target: id, at: now});
            return this.children.find(child => child.alive && child.id === id) || null;
        }
        BHasClass(cls) { return this.classes.has(cls); }
        AddClass(cls) { this.classes.add(cls); }
        SetHasClass(cls, active) { active ? this.classes.add(cls) : this.classes.delete(cls); }
        DeleteAsync() { this.alive = false; for (const child of this.children) child.DeleteAsync(); }
    }
    const create = (parent, id = '', classes = [], text = '') => parent.add(new Panel(id, classes, text));
    const root = new Panel('CitadelHudRoot');
    const hud = create(root, 'Hud', ['joined_team', 'connectedToHideout']);
    const core = create(hud, '', ['HudCore']);
    const gameplay = missingGameplay ? null : create(core, 'gameplay_hud');
    // Paths agree with extracted native XML and the Debugger capture; values
    // and transitions are synthetic. Keep context alive during replacements.
    const source = missingSource ? null : create(core, 'hudActivePlayerStats');
    const owners = source ? makeOwners(source) : null;
    function makeOwners(parent) {
        const list = create(parent, 'StatList');
        const weapon = create(list, 'WeaponColumn'), spirit = create(list, 'SpiritColumn'), vitality = create(list, 'VitalityColumn');
        const block = create(parent, 'HudStatBlock'), coreStats = create(block, 'CoreStats');
        return {list, weapon, spirit, vitality, weaponCore: create(coreStats, 'Weapon'), spiritCore: create(coreStats, 'Spirit')};
    }
    function modifier(parent, id, number, {postfix = '%', delta} = {}) {
        const row = create(parent, id, ['shouldShow', 'isPositive']);
        const miniCore = create(row, '', ['miniModifierCore']);
        const value = create(miniCore, '', ['statNumber'], number);
        create(miniCore, '', ['statPostfix'], postfix);
        if (delta !== undefined) { row.AddClass('has_delta'); create(miniCore, '', ['statNumberDelta'], delta); }
        create(row, 'casterList');
        return {row, miniCore, value};
    }
    const $ = {
        GetContextPanel: () => hud,
        CreatePanel: (type, parent, id) => create(parent, id),
        Schedule: (delay, fn) => { const id = serial++; jobs.set(id, {at: now + delay * 1000, fn}); return id; },
        CancelScheduled: id => jobs.delete(id),
        RegisterForUnhandledEvent: (name, fn) => { listeners.set(name, fn); return fn; },
        UnregisterForUnhandledEvent: name => listeners.delete(name),
        Msg: () => {},
    };
    const VirtualDate = class extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    };
    const sandbox = vm.createContext({$, Date: VirtualDate});
    const load = () => vm.runInContext(code, sandbox);
    const advance = ms => {
        const end = now + ms;
        for (;;) {
            const next = [...jobs.entries()].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            jobs.delete(next[0]); now = next[1].at; next[1].fn();
        }
        now = end;
    };
    const find = id => {
        const stack = [root];
        while (stack.length) { const panel = stack.pop(); if (!panel.alive) continue; if (panel.id === id) return panel; stack.push(...panel.children); }
        return null;
    };
    return {hud, root, core, gameplay, source, owners, create, makeOwners, modifier, load, advance, find, reads, jobs, listeners};
}

test('missing rows are searched at most once per discovery interval while cached values remain responsive', () => {
    const f = fixture();
    const fire = f.modifier(f.owners.weapon, 'fireRateContainer', '10');
    f.load(); f.advance(300);
    f.reads.length = 0;
    f.advance(2400);
    const checks = f.reads.filter(read => read.id === 'WeaponColumn' && read.target === 'clipSizeContainer').map(read => read.at);
    assert.ok(checks.length >= 2 && checks.length <= 3, JSON.stringify(checks));
    assert.ok(checks.every((at, index) => index === 0 || at - checks[index - 1] >= 800));
    f.modifier(f.owners.weapon, 'clipSizeContainer', '8', {postfix: ''});
    fire.value.text = '11'; f.advance(150);
    assert.equal(f.find('ActiveStatsRow_fireRate_val').text, '11%');
    f.advance(800); assert.equal(f.find('ActiveStatsRow_clipSize_val').text, '8');
});

test('live old rows, columns, sources and core owners cannot retain stale values', () => {
    const f = fixture(); const retired = f.create(f.root, 'RetiredTestPanels');
    let fire = f.modifier(f.owners.weapon, 'fireRateContainer', '10');
    f.load(); f.advance(300);
    const read = () => f.find('ActiveStatsRow_fireRate_val').text;
    assert.equal(read(), '10%');
    fire.row.SetParent(retired);
    fire = f.modifier(f.owners.weapon, 'fireRateContainer', '20');
    f.advance(150); assert.equal(read(), '20%');
    f.owners.weapon.SetParent(f.source);
    const weapon = f.create(f.owners.list, 'WeaponColumn');
    f.modifier(weapon, 'fireRateContainer', '30');
    f.advance(150); assert.equal(read(), '30%');
    f.source.SetParent(retired);
    const source = f.create(f.core, 'hudActivePlayerStats');
    f.modifier(f.makeOwners(source).weapon, 'fireRateContainer', '40');
    f.advance(150); assert.equal(read(), '40%');
    const oldOverlay = f.find('ActiveStatsCrosshairOverlay');
    f.core.SetParent(retired);
    const core = f.create(f.hud, '', ['HudCore']);
    f.create(core, 'gameplay_hud');
    f.modifier(f.makeOwners(f.create(core, 'hudActivePlayerStats')).weapon, 'fireRateContainer', '50');
    f.advance(150); assert.equal(read(), '50%'); assert.equal(oldOverlay.IsValid(), false);
});

test('late sources and gameplay panels are retried without preventing hidden-HUD suspension', () => {
    for (const missing of ['missingSource', 'missingGameplay']) {
        const f = fixture({[missing]: true}); f.load(); f.advance(300);
        if (missing === 'missingSource') {
            const source = f.create(f.core, 'hudActivePlayerStats');
            f.modifier(f.makeOwners(source).weapon, 'fireRateContainer', '10');
        } else {
            f.create(f.core, 'gameplay_hud'); f.modifier(f.owners.weapon, 'fireRateContainer', '10');
        }
        f.advance(1000); assert.equal(f.find('ActiveStatsRow_fireRate_val').text, '10%');
        const overlay = f.find('ActiveStatsCrosshairOverlay');
        f.hud.AddClass('InHideout'); f.reads.length = 0;
        f.advance(2000); assert.equal(overlay.style.visibility, 'collapse'); assert.deepEqual(f.reads, []);
        f.hud.SetHasClass('InHideout', false); f.advance(250);
        assert.equal(overlay.style.visibility, 'visible', 'combat room keeps connectedToHideout');
    }
});

test('native gameplay replacement is rebound even while its old panel remains alive', () => {
    const f = fixture(); f.modifier(f.owners.weapon, 'fireRateContainer', '10');
    f.load(); f.advance(300);
    f.gameplay.SetParent(f.create(f.root, 'RetiredTestPanels'));
    const replacement = f.create(f.core, 'gameplay_hud'); replacement.visible = false;
    f.advance(150); assert.equal(f.find('ActiveStatsCrosshairOverlay').style.visibility, 'collapse');
    replacement.visible = true; f.advance(250);
    assert.equal(f.find('ActiveStatsCrosshairOverlay').style.visibility, 'visible');
});

test('replaced delta/core labels are rediscovered and reload cancels a zero-valued schedule handle', () => {
    const f = fixture();
    const weapon = f.modifier(f.owners.weaponCore, 'weaponPowerContainer', '140', {delta: '+17'});
    f.load(); f.load(); assert.equal(f.jobs.size, 1); assert.equal(f.listeners.size, 1);
    f.advance(300); assert.equal(f.find('ActiveStatsRow_weaponPower_val').text, '+17%');
    const oldDelta = weapon.miniCore.children.find(panel => panel.BHasClass('statNumberDelta'));
    oldDelta.SetParent(f.create(f.root, 'RetiredTestPanels'));
    f.create(weapon.miniCore, '', ['statNumberDelta'], '-7');
    f.advance(150); assert.equal(f.find('ActiveStatsRow_weaponPower_val').text, '-7%');
    weapon.row.SetHasClass('has_delta', false); f.advance(150);
    assert.equal(f.find('ActiveStatsRow_weaponPower').style.visibility, 'collapse');
    weapon.miniCore.SetParent(f.create(f.root, 'RetiredValueCore'));
    const newCore = f.create(weapon.row, '', ['miniModifierCore']);
    const wrapper = f.create(newCore, '', ['statWithPostfix']);
    f.create(wrapper, '', ['statNumber'], '145'); f.create(wrapper, '', ['statPostfix'], '%');
    f.create(newCore, '', ['statNumberDelta'], '+9'); weapon.row.AddClass('has_delta');
    f.advance(250); assert.equal(f.find('ActiveStatsRow_weaponPower_val').text, '+9%');
});
