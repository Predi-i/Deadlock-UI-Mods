'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const corePath = path.resolve(__dirname, '../panorama/scripts/hud_dump_core.js');
const adapterPath = path.resolve(__dirname, '../panorama/scripts/hud_dumper.js');
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
function engine(root, eventThrows = false) {
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
        CreatePanel() { throw new Error('capture must not create native UI'); },
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
    return { tasks, packets, messages, bindings, tick, key: () => bindings[0].cb(), elapse: ms => { now += ms; } };
}

test('captures labels and actual GetClasses data, without style/whitelist reads', () => {
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
        { input: JSON.stringify(packets), encoding: 'utf8' });
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
