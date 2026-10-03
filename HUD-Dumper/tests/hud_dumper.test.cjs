'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const corePath = path.resolve(__dirname, '../panorama/scripts/hud_dump_core.js');
const adapterPath = path.resolve(__dirname, '../panorama/scripts/hud_dumper.js');
const probePath = path.resolve(__dirname, '../panorama/scripts/hud_api_probe.js');
const debuggerProbePath = path.resolve(__dirname, '../panorama/scripts/hud_debugger_probe.js');
const C = require(corePath);

class Panel {
    constructor(id, type = 'Panel', classes = '', text = '') {
        Object.assign(this, { id, paneltype: type, classes, text, children: [], valid: true,
            visible: true, enabled: true, layoutfile: 'fixture.xml', reads: 0 });
    }
    IsValid() { return this.valid; }
    GetClasses() { this.reads++; return this.classes; }
    GetChildCount() { return this.children.length; }
    GetChild(i) { return this.children[i]; }
    FindChild(id) { return this.children.find(c => c.id === id) || null; }
    FindChildTraverse(id) {
        for (const c of this.children) { const p = c.id === id ? c : c.FindChildTraverse(id); if (p) return p; }
        return null;
    }
    add(p) { this.children.push(p); return p; }
    get style() { throw new Error('native styles must never be read'); }
    BHasClass() { throw new Error('class whitelist scanning must never occur'); }
}
function drain(c, work = 32) {
    let slices = 0;
    while (!c.step(work, 3)) { if (++slices > 100000) throw new Error('collector stalled'); }
    return slices + 1;
}
function records(c) {
    const chunks = [];
    for (let i = 0; i < c.progress().chunks; i++) chunks.push(c.packet('test-1', i).split('|').slice(5).join('|'));
    return chunks.join('').trim().split('\n').map(line => JSON.parse(line));
}
function engine(root, eventThrows = false, probeFactory = null) {
    let now = 1000, next = 0;
    const tasks = new Map(), packets = [], messages = [], bindings = [];
    const sandbox = { $, Date: class extends Date { static now() { return now; } } };
    function $(selector) { throw new Error('unexpected UI selector: ' + selector); }
    Object.assign($, {
        GetContextPanel: () => root,
        Schedule(delay, cb) { const id = ++next; tasks.set(id, { at: now + delay * 1000, cb }); return id; },
        CancelScheduled(id) { tasks.delete(id); },
        Msg(message) { messages.push(message); },
        RegisterKeyBind(context, key, cb) { bindings.push({ context, key, cb }); },
        CreatePanel(...args) {
            if (probeFactory) return probeFactory(...args);
            throw new Error('capture must not create native UI');
        },
        DispatchEvent(name, text, repeat) {
            if (eventThrows) throw new Error('injected clipboard dispatch failure');
            assert.equal(name, 'CopyStringToClipboard'); assert.equal(text, repeat);
            assert.ok(text.length <= 8500); packets.push(text);
        },
    });
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(corePath, 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(adapterPath, 'utf8'), sandbox);
    function tick() {
        const entry = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) return false;
        tasks.delete(entry[0]); now = entry[1].at; entry[1].cb(); return true;
    }
    return { tasks, packets, messages, bindings, tick, key: () => bindings[0].cb(), elapse: ms => { now += ms; },
        now: () => now, runProbe: () => vm.runInContext(fs.readFileSync(probePath, 'utf8'), sandbox),
        runDebuggerProbe: () => vm.runInContext(fs.readFileSync(debuggerProbePath, 'utf8'), sandbox) };
}

test('captures labels and fixture getter data, without style/whitelist reads', () => {
    const root = new Panel('Hud');
    root.add(new Panel('', 'Label', 'currentHealthLabel statNumber', '🚀 123 | 你好'));
    const c = C.createCollector(root);
    drain(c);
    const r = records(c);
    assert.equal(r[2].node.text, '🚀 123 | 你好');
    assert.deepEqual(r[2].node.classes, ['currentHealthLabel', 'statNumber']);
    assert.equal(root.reads, 1);
    assert.equal(r.at(-1).meta.classCoverage, 'GetClasses-returned');
    assert.equal('computedMeasurements' in r[1].node, false);
});

test('wide 16511-panel trees require many bounded slices, not one recursive frame', () => {
    const root = new Panel('Hud');
    for (let i = 0; i < 16510; i++) root.add(new Panel('p' + i));
    const c = C.createCollector(root, { now: () => 0 });
    const count = drain(c, 32);
    assert.ok(count > 1000);
    assert.equal(c.progress().panels, 16511);
    assert.equal(records(c).at(-1).summary.totalPanels, 16511);
});

test('depth, size, destroyed children, cycles and unreadable fields are explicit', () => {
    const root = new Panel('Hud');
    const dead = root.add(new Panel('dead')); dead.valid = false;
    const label = root.add(new Panel('label', 'Label', '', 'x'.repeat(100)));
    label.GetClasses = () => { throw new Error('read failed'); };
    label.add(root);
    const c = C.createCollector(root, { limits: { maxText: 10 }, now: () => 0 });
    drain(c);
    const meta = records(c).at(-1).meta;
    assert.equal(meta.skippedDestroyed, 1);
    assert.equal(meta.repeatedPanels, 1);
    assert.equal(meta.textTruncated, 1);
    assert.equal(meta.classesIncomplete, 1);
    assert.equal(meta.readErrors.GetClasses, 1);
    const capped = C.createCollector(root, { limits: { maxPanels: 1 } }); drain(capped);
    assert.equal(records(capped).at(-1).meta.truncated, true);
    const clipped = C.createCollector(root, { limits: { maxDepth: 0 } }); drain(clipped);
    assert.equal(records(clipped).at(-1).meta.clipped, true);
    const oversized = C.createCollector(new Panel('Hud'), { limits: { maxChars: 300 } });
    assert.throws(() => drain(oversized), /budget exceeded/);
});

test('destroyed root aborts and cancelled collectors discard export buffers', () => {
    const root = new Panel('Hud'); const c = C.createCollector(root);
    root.valid = false; assert.throws(() => c.step(), /root was destroyed/);
    const full = C.createCollector(new Panel('Hud')); drain(full); full.cancel();
    assert.equal(full.progress().chunks, 0); assert.throws(() => full.packet('test-1', 0), /unavailable/);
});

test('oversized class strings and names report partial coverage', () => {
    const root = new Panel('Hud', 'Panel', 'known ' + 'x'.repeat(10000));
    const c = C.createCollector(root); drain(c);
    assert.deepEqual(records(c)[1].node.classes, ['known']);
    assert.equal(records(c).at(-1).meta.classCoverage, 'partial');
    const longName = C.createCollector(new Panel('Hud', 'Panel', 'x'.repeat(600)));
    drain(longName);
    assert.equal(records(longName)[1].node.classesStatus, 'truncated');
});

test('UTF-16 checksums and packet boundaries round-trip through the Python receiver', () => {
    const root = new Panel('Hud');
    root.add(new Panel('health', 'Label', 'miniModifierCore statNumber', '🚀'.repeat(2048)));
    root.add(new Panel('separators', 'Label', '', 'a\u2028b\u0085c\u2029d\nend'));
    const c = C.createCollector(root, { streaming: true, limits: { chunkChars: 137 } });
    const packets = [];
    while (true) {
        const done = c.step();
        let packet;
        while ((packet = c.takePacket('test-1'))) {
            const body = packet.split('|').slice(5).join('|');
            const last = body.charCodeAt(body.length - 1);
            assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'no split surrogate pairs');
            packets.push(packet);
        }
        if (done) break;
    }
    packets.push(c.endPacket('test-1'));
    const python = `import sys,json,importlib.util,tempfile
sys.stdin.reconfigure(encoding='utf-8')
spec=importlib.util.spec_from_file_location('receiver',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
spool=tempfile.TemporaryDirectory();r=m.Receiver(spool.name);result=None
for packet in reversed(json.load(sys.stdin)):
 result=r.accept(packet) or result
assert result[1]['domTree']['children'][0]['text']=='🚀'*2048
assert result[1]['domTree']['children'][1]['text']=='a'+chr(0x2028)+'b'+chr(0x85)+'c'+chr(0x2029)+'d'+chr(10)+'end'
assert result[1]['summary']['totalPanels']==3
r.close();spool.cleanup()
print('verified')`;
    const output = spawnSync('python', ['-c', python, path.resolve(__dirname, '../tools/save_dump.py')],
        { input: JSON.stringify(packets.map(p => p.replace(/\n/g, '\r\n'))), encoding: 'utf8' });
    assert.equal(output.status, 0, output.stderr); assert.match(output.stdout, /verified/);
});

test('adapter owns one binding and schedule; duplicate presses cannot start parallel exports', () => {
    const window = new Panel('CitadelHudRoot'); const hud = window.add(new Panel('Hud'));
    for (let i = 0; i < 100; i++) hud.add(new Panel('label' + i, 'Label', 'statNumber', '1'));
    const e = engine(window);
    assert.equal(e.bindings.length, 1); e.key(); e.key();
    let ticks = 0;
    while (e.tick()) {
        assert.ok(e.tasks.size <= 1); e.key();
        if (++ticks > 1000) throw new Error('adapter stalled');
    }
    const end = e.packets.find(p => p.split('|')[3] === 'end');
    assert.ok(end);
    const count = JSON.parse(end.split('|').slice(5).join('|')).chunks;
    assert.equal(e.packets.length, (count + 1) * 2);
    assert.ok(e.packets.every(p => p.startsWith('HUD_DUMP4|')));
    assert.equal(new Set(e.packets.map(p => p.split('|')[1])).size, 1);
    assert.ok(e.messages.some(m => m.includes('Only the Python receiver')));
});

test('adapter stops owned work after native dispatch failure or context destruction', () => {
    const e = engine(new Panel('Hud'), true); e.key();
    while (e.tick()) {}
    assert.equal(e.tasks.size, 0); assert.ok(e.messages.some(m => m.includes('injected clipboard')));
    const root = new Panel('Hud'); const dying = engine(root); dying.key(); root.valid = false; dying.tick();
    assert.equal(dying.tasks.size, 0); assert.equal(dying.packets.length, 0);
    const slow = engine(new Panel('Hud')); slow.key(); slow.elapse(1800001);
    // Simulate late callback delivery after the deadline.
    const callback = [...slow.tasks.values()][0].cb; callback();
    assert.ok(slow.messages.some(m => m.includes('deadline exceeded')));
});

test('full HUD streams past the old 8M cap while releasing each bounded batch', () => {
    const root = new Panel('Hud');
    for (let i = 0; i < 32000; i++) root.add(new Panel('p' + i, 'Label', 'statNumber', 'x'.repeat(256)));
    const c = C.createCollector(root, { streaming: true, now: () => 0 });
    let packets = 0, ticks = 0, sentBeforeDone = false;
    while (true) {
        c.step();
        const progress = c.progress();
        assert.ok(progress.bufferedChars < C.LIMITS.chunkChars * 3);
        let packet;
        while ((packet = c.takePacket('stream-1'))) {
            assert.equal(Number(packet.split('|')[2]), packets++);
            assert.ok(packet.length <= 8500);
            if (!progress.done) sentBeforeDone = true;
        }
        if (progress.done) break;
        if (++ticks > 100000) throw new Error('stream stalled');
    }
    assert.ok(sentBeforeDone);
    assert.ok(c.progress().chars > C.LIMITS.maxChars);
    assert.equal(c.progress().panels, 32001);
    assert.equal(c.progress().bufferedChars, 0);
    assert.equal(JSON.parse(c.endPacket('stream-1').split('|').slice(5).join('|')).chunks, packets);
});

test('adapter dispatches the first batch before finishing collection', () => {
    const window = new Panel('Hud');
    for (let i = 0; i < 1000; i++) window.add(new Panel('p' + i, 'Label', '', 'x'.repeat(256)));
    const e = engine(window); e.key();
    let ticks = 0;
    while (!e.packets.length && e.tick()) { if (++ticks > 100) throw new Error('first batch delayed'); }
    assert.ok(e.packets.length);
    assert.ok(!e.messages.some(m => m.includes('Collection complete')));
    assert.ok(window.children.at(-1).reads === 0);
    window.valid = false; e.tick(); assert.equal(e.tasks.size, 0);
});

test('API probe waits for startup, samples the ready HUD and never invokes unknown getters or discovered methods', () => {
    const window = new Panel('WindowRoot');
    let unknownReads = 0;
    Object.defineProperty(window, 'unknownAccessor', { get() { unknownReads++; throw new Error('must not read'); } });
    const e = engine(window); e.runProbe();
    assert.equal(e.tasks.size, 1);
    assert.equal([...e.tasks.values()][0].at, 21000);
    assert.ok(!e.messages.some(m => m.includes('BEGIN')));
    // Layout becomes available after the script was loaded.
    const hud = window.add(new Panel('Hud', 'CitadelHud'));
    const child = hud.add(new Panel('nativeChild'));
    e.tick();
    assert.equal(e.now(), 21000);
    let ticks = 0;
    while (e.tick()) {
        assert.ok(e.tasks.size <= 1);
        if (++ticks > 1000) throw new Error('probe stalled');
    }
    const text = e.messages.join('\n');
    assert.match(text, /id="Hud" type="CitadelHud"/);
    assert.match(text, /unknownAccessor:get/);
    assert.match(text, /GetChildCount:function/);
    assert.match(text, /GetClasses:function/);
    assert.match(text, /FINISHED/);
    assert.equal(unknownReads, 0);
    assert.equal(window.reads + hud.reads + child.reads, 0);
    assert.equal(e.packets.length, 0);
});

test('API probe cancels prior reload schedules and stops output when its context is destroyed', () => {
    const root = new Panel('Hud'); const e = engine(root);
    e.runProbe(); const oldHandle = [...e.tasks.keys()][0]; e.runProbe();
    assert.equal(e.tasks.size, 1);
    assert.ok(!e.tasks.has(oldHandle));
    e.tick(); root.valid = false; e.tick();
    assert.equal(e.tasks.size, 0);
    assert.ok(e.messages.some(m => m.includes('context destroyed')));
    assert.ok(!e.messages.some(m => m.includes('FINISHED')));
    const absent = new Panel('Hud'); const beforeStart = engine(absent);
    beforeStart.runProbe(); absent.valid = false; beforeStart.tick();
    assert.equal(beforeStart.tasks.size, 0);
    assert.ok(beforeStart.messages.some(m => m.includes('context unavailable')));
});

test('API probe reports missing fixture getter, reflection failures and truncated property lists', () => {
    const root = new Panel('Hud'); root.GetClasses = undefined;
    for (let i = 0; i < 600; i++) root['extra' + i] = i;
    root.add(new Proxy(new Panel('proxyChild'), { ownKeys() { throw new Error('native reflection unavailable'); } }));
    const e = engine(root); e.runProbe();
    while (e.tick()) {}
    const text = e.messages.join('\n');
    assert.match(text, /GetClasses:undefined/);
    assert.match(text, /TRUNCATED reflection limit/);
    assert.match(text, /ERROR own names: native reflection unavailable/);
    assert.match(text, /FINISHED/);
    assert.equal(e.packets.length, 0);
});

test('class-attribute probe distinguishes attribute storage from live classes and deletes its owned panel on failure', () => {
    for (const mode of ['separate', 'live', 'failure']) {
        const root = new Panel('Hud'); const existing = root.add(new Panel('existing'));
        let created;
        class ProbePanel extends Panel {
            constructor() { super(''); this.assigned = new Set(); this.deleted = false; }
            AddClass(name) { this.assigned.add(name); }
            RemoveClass(name) { this.assigned.delete(name); }
            BHasClass(name) { return this.assigned.has(name); }
            GetAttributeString(name, fallback) {
                assert.equal(name, 'class');
                if (mode === 'failure' && this.assigned.size) throw new Error('native read failure');
                return mode === 'live' ? [...this.assigned].join(' ') : fallback;
            }
            DeleteAsync(delay) { assert.equal(delay, 0); this.deleted = true; this.valid = false; }
        }
        const e = engine(root, false, (type, parent, id) => {
            assert.equal(type, 'Panel'); assert.equal(parent, root); assert.equal(id, '');
            created = new ProbePanel(); return created;
        });
        e.runProbe();
        while (e.tick()) {}
        assert.ok(created.deleted);
        assert.equal(created.visible, false);
        assert.equal(created.hittest, false);
        assert.equal(created.hittestchildren, false);
        assert.equal(root.visible, true); assert.equal(existing.visible, true);
        const output = e.messages.join('\n');
        assert.match(output, /CLASS-ATTRIBUTE cleanup requested/);
        if (mode === 'failure') assert.match(output, /CLASS-ATTRIBUTE ERROR native read failure/);
        else {
            const stage = e.messages.find(m => m.includes('CLASS-ATTRIBUTE removed-A '));
            const result = JSON.parse(stage.slice(stage.indexOf('{')));
            assert.deepEqual(result, { attribute: mode === 'live' ? 'HUDDumperProbeClassB' : '<missing>',
                hasA: false, hasB: true });
        }
        assert.equal(e.packets.length, 0);
    }
});

test('debugger probe samples raw inspector row text after delay without native class or style reads', () => {
    const root = new Panel('DebugLayout', 'DebugLayout');
    root.add(new Panel('DebugLayoutPanelOpen', 'Label', '',
        '&lt;Panel <span class="syntax">class="NativeClass UnknownClass"</span>&gt;'));
    root.add(new Panel('DebugLayoutPanelClose', 'Label', '', '</Panel>'));
    const e = engine(root); e.runDebuggerProbe();
    assert.equal([...e.tasks.values()][0].at, 21000);
    assert.ok(!e.messages.some(m => m.includes('[HUD-DEBUGGER-PROBE] BEGIN')));
    while (e.tick()) {}
    const rows = e.messages.filter(m => m.includes('[HUD-DEBUGGER-PROBE] ROW '))
        .map(m => JSON.parse(m.slice(m.indexOf('{'))));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].text, root.children[0].text);
    assert.equal(rows[1].text, '</Panel>');
    const summary = JSON.parse(e.messages.find(m => m.includes('[HUD-DEBUGGER-PROBE] FINISHED ')).split('FINISHED ')[1]);
    assert.equal(summary.openRows, 1); assert.equal(summary.closeRows, 1);
    assert.equal(summary.uiScanComplete, true); assert.equal(summary.fullHudCapture, false);
    assert.equal(root.reads + root.children.reduce((n, p) => n + p.reads, 0), 0);
    assert.equal(e.packets.length, 0);
});

test('debugger probe bounds wide scans and Unicode previews and cancels on reload or destruction', () => {
    const root = new Panel('DebugLayout', 'DebugLayout');
    for (let i = 0; i < 2000; i++) root.add(new Panel('DebugLayoutPanelOpen', 'Label', '', 'x'.repeat(2047) + '🚀'));
    const e = engine(root); e.runDebuggerProbe();
    const oldHandle = [...e.tasks.keys()][0]; e.runDebuggerProbe();
    assert.ok(!e.tasks.has(oldHandle)); assert.equal(e.tasks.size, 1);
    let ticks = 0;
    while (e.tick()) {
        assert.ok(e.tasks.size <= 1);
        if (++ticks > 500) throw new Error('debugger probe stalled');
    }
    assert.ok(ticks > 1);
    const rows = e.messages.filter(m => m.includes('[HUD-DEBUGGER-PROBE] ROW '))
        .map(m => JSON.parse(m.slice(m.indexOf('{'))));
    assert.equal(rows.length, 8);
    assert.equal(rows[0].text.length, 2047); assert.equal(rows[0].truncated, true);
    const summary = JSON.parse(e.messages.find(m => m.includes('[HUD-DEBUGGER-PROBE] FINISHED ')).split('FINISHED ')[1]);
    assert.equal(summary.visited, 1500); assert.equal(summary.limited, true);
    assert.equal(summary.uiScanComplete, false);
    const dyingRoot = new Panel('DebugLayout', 'DebugLayout');
    for (let i = 0; i < 50; i++) dyingRoot.add(new Panel('child' + i));
    const dying = engine(dyingRoot); dying.runDebuggerProbe(); dying.tick();
    dyingRoot.valid = false; dying.tick();
    assert.equal(dying.tasks.size, 0);
    assert.ok(dying.messages.some(m => m.includes('ABORTED debugger context destroyed')));
    assert.ok(!dying.messages.some(m => m.includes('[HUD-DEBUGGER-PROBE] FINISHED')));
});
