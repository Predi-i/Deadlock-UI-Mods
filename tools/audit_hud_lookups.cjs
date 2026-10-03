// Offline traversal audit on a maintainer Panorama Debugger capture.
// Models JS lookups and counts visited nodes, not native CPU time or FPS.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const captureFile = process.argv[2];
if (!captureFile) throw new Error('Usage: node tools/audit_hud_lookups.cjs <capture.json>');
const capture = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
if (!capture.domTree) throw new Error('A full domTree is required; aggregate captures cannot measure ancestry.');
let visits = 0;
let scans = 0;
let broad = 0;
let childReads = 0;
class Panel {
    constructor(data = {}) {
        this.id = data.id || '';
        this.paneltype = data.type || 'Panel';
        this.classes = new Set(data.classes || []);
        this.text = data.text || '';
        this.children = [];
        this.parent = null;
        this.alive = true;
        this.visible = data.visible !== false;
        this.style = {};
        for (const child of data.children || []) this.add(new Panel(child));
    }
    add(panel) { panel.parent = this; this.children.push(panel); return panel; }
    IsValid() { return this.alive; }
    GetParent() { return this.parent; }
    Children() { childReads++; return this.children.filter(child => child.alive); }
    BHasClass(name) { return this.classes.has(name); }
    AddClass(name) { this.classes.add(name); }
    SetHasClass(name, enabled) { enabled ? this.classes.add(name) : this.classes.delete(name); }
    DeleteAsync() { this.alive = false; for (const child of this.children) child.DeleteAsync(); }
    FindChildTraverse(id) {
        scans++;
        if (this.id === 'Hud' || this.id === 'CitadelHudRoot' || this.BHasClass('HudCore')) broad++;
        const stack = [...this.children].reverse();
        while (stack.length) {
            const node = stack.pop();
            if (!node.alive) continue;
            visits++;
            if (node.id === id) return node;
            stack.push(...[...node.children].reverse());
        }
        return null;
    }
}
const metrics = () => ({ scans, visitedPanels: visits, wholeHudScans: broad, childReads });
const reset = () => { scans = visits = broad = childReads = 0; };
const load = (file, context) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, {filename: file});
const tree = new Panel(capture.domTree);
const hud = tree.FindChildTraverse('Hud');
assert.ok(hud);
const context = vm.createContext({$: {GetContextPanel: () => tree}});
load('tools/hud_lookup.js', context);
const ids = ['GameTime', 'Chat', 'ChatInput', 'ChatTargetLabel', 'damageImpactInfo', 'respawn_timer',
    'StatsAndModsContainer', 'BuffModifiers', 'gun_data', 'slot_signature_3', 'hud_minimap', 'minimap_container',
    'EscapeMenu', 'EscapeBackground', 'Menu', 'SubOptions', 'CitadelPartyContainer'];
const expected = new Map(ids.map(id => [id, tree.FindChildTraverse(id)]));
reset();
for (let tick = 0; tick < 60; tick++) {
    for (const id of ids) {
        assert.ok(expected.get(id), `capture has no ${id}`);
        assert.equal(context.$.ModHudLookup.find(id), expected.get(id), `scope selected a different ${id}`);
    }
}
const scoped = metrics();
assert.equal(scoped.wholeHudScans, 0);
const old = expected.get('gun_data');
old.DeleteAsync();
const replacement = old.parent.add(new Panel({id: 'gun_data'}));
assert.equal(context.$.ModHudLookup.find('gun_data'), replacement, 'destroyed cache entry must resolve its replacement');
reset();
for (let tick = 0; tick < 60; tick++) for (const id of ids) tree.FindChildTraverse(id);
const unscoped = metrics();

function activeStats(sourceCode) {
    const root = new Panel(capture.domTree);
    const source = root.FindChildTraverse('hudActivePlayerStats');
    assert.ok(source);
    const fire = source.FindChildTraverse('fireRateContainer');
    fire.classes.add('shouldShow');
    fire.classes.add('isPositive');
    const core = fire.children[0];
    core.classes.add('miniModifierCore');
    core.children = [];
    core.add(new Panel({type: 'Label', classes: ['statNumber'], text: '20'}));
    core.add(new Panel({type: 'Label', classes: ['statPostfix'], text: '%'}));
    const jobs = new Map();
    const listeners = new Map();
    let serial = 0;
    const $ = {
        GetContextPanel: () => source,
        CreatePanel: (type, parent, id) => parent.add(new Panel({type, id})),
        Schedule: (delay, fn) => { const id = ++serial; jobs.set(id, fn); return id; },
        CancelScheduled: id => jobs.delete(id),
        RegisterForUnhandledEvent: (name, fn) => { listeners.set(name, fn); return fn; },
        UnregisterForUnhandledEvent: name => listeners.delete(name),
        Localize: token => token, Msg: () => {},
    };
    const sandbox = vm.createContext({$, console});
    reset();
    vm.runInContext(sourceCode, sandbox);
    const advance = count => {
        for (let i = 0; i < count; i++) {
            const entry = jobs.entries().next().value;
            assert.ok(entry, 'poller stopped');
            jobs.delete(entry[0]); entry[1]();
        }
    };
    advance(60);
    const measured = metrics();
    // Find output outside the measured window.
    const value = root.FindChildTraverse('ActiveStatsRow_fireRate_val');
    const shown = value?.text;
    return {root, source, fire, core, value, shown, measured, $, sandbox, listeners, jobs, advance};
}
const baselineRef = process.argv[3];
const oldStats = baselineRef ? activeStats(cp.execFileSync('git', ['show', baselineRef + ':Active-Stats/panorama/scripts/active_stats.js'],
    {cwd: ROOT, encoding: 'utf8'})) : null;
const currentCode = fs.readFileSync(path.join(ROOT, 'Active-Stats/panorama/scripts/active_stats.js'), 'utf8');
const current = activeStats(currentCode);
assert.equal(current.shown, '20%');
assert.equal(current.measured.wholeHudScans, 0);
assert.equal(current.measured.scans, 0);
current.fire.classes.delete('isPositive');
current.fire.classes.add('isNegative');
current.core.children[0].text = '-10';
current.advance(1);
assert.equal(current.value.text, '-10%');
// Core stats report active deltas, never the absolute investment value.
const weapon = current.source.FindChildTraverse('weaponPowerContainer');
weapon.classes.add('shouldShow');
weapon.classes.add('has_delta');
weapon.classes.add('isPositive');
const weaponCore = weapon.children[0];
weaponCore.classes.add('miniModifierCore');
weaponCore.children = [];
const wrapper = weaponCore.add(new Panel({classes: ['statWithPostfix']}));
wrapper.add(new Panel({type: 'Label', classes: ['statNumber'], text: '140'}));
wrapper.add(new Panel({type: 'Label', classes: ['statPostfix'], text: '%'}));
const delta = weaponCore.add(new Panel({type: 'Label', classes: ['statNumberDelta'], text: '+17'}));
current.advance(1);
const weaponValue = current.root.FindChildTraverse('ActiveStatsRow_weaponPower_val');
assert.equal(weaponValue.text, '+17%');
weapon.classes.delete('has_delta');
current.advance(1);
assert.equal(weaponValue.parent.style.visibility, 'collapse', 'stale delta must not paint');
weapon.classes.add('has_delta'); delta.text = '-7';
weapon.classes.delete('isPositive'); weapon.classes.add('isNegative');
current.advance(1);
assert.equal(weaponValue.text, '-7%');
const overlay = current.root.FindChildTraverse('ActiveStatsCrosshairOverlay');
const currentHud = current.root.FindChildTraverse('Hud');
currentHud.classes.add('gScoreboardOpen'); current.advance(1);
assert.equal(overlay.style.visibility, 'collapse');
currentHud.classes.delete('gScoreboardOpen'); current.advance(1);
assert.equal(overlay.style.visibility, 'visible', 'class-only scoreboard close must recover');
current.listeners.get('CitadelScoreboardToggle')({visible: true}); current.advance(1);
assert.equal(overlay.style.visibility, 'collapse');
current.listeners.get('CitadelScoreboardToggle')({visible: false});
assert.equal(overlay.style.visibility, 'visible');
vm.runInContext(currentCode, current.sandbox);
assert.equal(current.listeners.size, 1, 'reload must retire the old event handler');
assert.equal(current.jobs.size, 1, 'reload must retire the old tick');
current.advance(1);
assert.equal(current.root.FindChildTraverse('ActiveStatsRow_fireRate_val').text, '-10%');
console.log(JSON.stringify({capture: capture.timestampUtc, panels: capture.summary.totalPanels,
    scopedHud: scoped, equivalentUnscoped: unscoped,
    activeStatsBefore: oldStats ? {...oldStats.measured, displayedFireRate: oldStats.shown} : null,
    activeStatsAfter: {...current.measured, displayedFireRate: current.shown}}, null, 2));
console.log('PASS: scoped paths preserve captured targets; replacement, Active Stats values, scoreboard and reload. Offline traversal counts only.');
