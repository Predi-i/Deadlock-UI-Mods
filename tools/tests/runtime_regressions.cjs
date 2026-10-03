'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
class Panel {
    constructor(id = '', classes = [], type = 'Panel') {
        this.id = id; this.classes = new Set(classes); this.paneltype = type;
        this.children = []; this.style = {}; this.alive = true; this.enabled = true; this.text = '';
    }
    add(panel) { panel.parent = this; this.children.push(panel); return panel; }
    Children() { return this.children.filter(p => p.alive); }
    GetParent() { return this.parent || null; }
    IsValid() { return this.alive; }
    BHasClass(name) { return this.classes.has(name); }
    AddClass(name) { this.classes.add(name); }
    RemoveClass(name) { this.classes.delete(name); }
    SetAttributeString() {}
    DeleteAsync() { this.alive = false; }
    FindChildTraverse(id) {
        for (const child of this.Children()) {
            if (child.id === id) return child;
            const found = child.FindChildTraverse(id); if (found) return found;
        }
        return null;
    }
    FindChildrenWithClassTraverse(name) {
        return this.Children().flatMap(child => [ ...(child.BHasClass(name) ? [child] : []), ...child.FindChildrenWithClassTraverse(name)]);
    }
}
function runtime(context, extra = {}) {
    let next = 0;
    const jobs = new Map();
    const events = [];
    const $ = {
        GetContextPanel: () => context,
        Schedule: (delay, fn) => { const id = ++next; jobs.set(id, {delay, fn}); return id; },
        CancelScheduled: id => jobs.delete(id),
        CreatePanel: (type, parent, id) => parent.add(new Panel(id, [], type)),
        DispatchEvent: (...args) => events.push(args), Msg() {}, ...extra
    };
    const sandbox = vm.createContext({$, console});
    const run = file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox);
    const advance = () => { const [id, job] = jobs.entries().next().value; jobs.delete(id); job.fn(); return job.delay; };
    return {$, jobs, events, sandbox, run, advance};
}
// Parry starts halfway through a native cooldown; it must not invent a new one.
{
    const context = new Panel('element_gun');
    const gun = context.add(new Panel('gun_data'));
    const holder = gun.add(new Panel('parry_unavailable'));
    const border = holder.add(new Panel('ParryCooldownBorder'));
    const inventory = new Panel('StatsAndModsContainer');
    const buffs = new Panel('BuffModifiers');
    const r = runtime(context, {ModHudLookup: {find: id => ({gun_data: gun, StatsAndModsContainer: inventory, BuffModifiers: buffs})[id]}});
    let now = 0; r.sandbox.Date = {now: () => now};
    context.AddClass('parry_on_cooldown'); border.style.clip = 'radial(50% 50%, 0deg, -180deg)';
    r.run('Parry-Cooldown/panorama/scripts/parry_cooldooown.js');
    const label = holder.FindChildTraverse('CustomParryTimerText');
    assert.equal(label.parent, holder); assert.equal(label.style.textAlign, 'center');
    assert.equal(label.text, '2.3');
    now = 1000; border.style.clip = 'radial(50% 50%, 0deg, -100deg)'; r.advance();
    assert.equal(label.text, '1.3');
    border.style.clip = ''; r.advance(); assert.equal(label.style.visibility, 'collapse');
    r.run('Parry-Cooldown/panorama/scripts/parry_cooldooown.js'); assert.equal(r.jobs.size, 1);
    context.alive = false; r.advance(); assert.equal(r.jobs.size, 0);
}
// The MVP include must not start a second poller or reset match completion.
{
    const page = new Panel('CitadelPostGameNew', ['PageVisible', 'CanCommendPlayers', 'SelectedScreen_Scoreboard'], 'CitadelPostGameNew');
    const carousel = page.add(new Panel('ScreensCarousel'));
    const screen = carousel.add(new Panel('ScoreboardScreen'));
    const match = screen.add(new Panel('MatchID')); match.text = 'Match 123';
    const scoreboard = screen.add(new Panel('Scoreboard'));
    const team = scoreboard.add(new Panel('TeamPlayers'));
    const player = team.add(new Panel('', ['Player']));
    const button = player.add(new Panel('CommendPlayerButton'));
    const local = team.add(new Panel('', ['Player', 'IsLocalPlayer'])); local.add(new Panel('CommendPlayerButton'));
    const done = team.add(new Panel('', ['Player', 'CommendedPlayer'])); done.add(new Panel('CommendPlayerButton'));
    screen.add(new Panel('AutoCommendScoreboard', ['AutoCommendStyle']));
    page.add(new Panel('PlayAgainButton'));
    const r = runtime(page);
    const file = 'Commend-Everyone-Button/panorama/scripts/auto_commend.js';
    r.run(file); assert.equal(r.jobs.size, 1);
    const mvp = carousel.add(new Panel('MVPScreen', [], 'CitadelPostGameProgressMVP'));
    r.$.GetContextPanel = () => mvp; r.run(file); assert.equal(r.jobs.size, 1);
    r.sandbox.CommendAll();
    // Tick first, then the single pending native activation.
    r.advance(); r.advance();
    assert.equal(r.events.length, 1); assert.equal(r.events[0][1], button);
    assert.equal(page.BHasClass('AutoCommendCompleted'), false, 'dispatch alone is not success');
    page.RemoveClass('PageVisible');
    let searches = 0; const search = page.FindChildTraverse.bind(page);
    page.FindChildTraverse = id => { searches++; return search(id); };
    r.advance(); assert.equal(searches, 0, 'hidden page must not search descendants');
    r.$.GetContextPanel = () => page; r.run(file); assert.equal(r.jobs.size, 1);
    page.alive = false; r.advance(); assert.equal(r.jobs.size, 0);
}
async function bridgeTest() {
    const source = fs.readFileSync(path.join(root, 'Anti-Toxic-Chat/worker/src/bridge.js'), 'utf8');
    const module = vm.createContext({}); vm.runInContext(source.replace('export const BRIDGE_HTML', 'globalThis.html'), module);
    const script = module.html.match(/<script>([\s\S]*)<\/script>/)[1];
    const titles = []; let hashChange; let requests = 0;
    const location = {href: 'https://example.test/bridge', hash: '#' + encodeURIComponent(JSON.stringify({op: 'hello', id: 0, session: 's'}))};
    const document = {}; Object.defineProperty(document, 'title', {set: text => titles.push(JSON.parse(text.slice(4)))});
    const browser = vm.createContext({location, document, AbortController, setTimeout, clearTimeout,
        window: {addEventListener: (event, fn) => { hashChange = fn; }},
        fetch: async (url, options) => { requests++; assert.equal(url, '/api/transform'); assert.equal(JSON.parse(options.body).text, 'тест'); return {ok: true, json: async () => ({text: 'ответ'})}; }});
    vm.runInContext(script, browser);
    assert.equal(titles[0].op, 'ready'); assert.equal(titles[0].version, 2);
    location.hash = '#' + encodeURIComponent(JSON.stringify({op: 'transform', id: 1, session: 's', text: 'тест'}));
    await hashChange(); await hashChange();
    assert.equal(requests, 1); assert.equal(titles[1].text, 'ответ');
}
// Panorama handshakes before sending; concurrent submissions are serialized and
// a reply cannot choose a different chat channel from the recorded request.
{
    const chat = new Panel('Chat', ['ChatTarget_GameAll']);
    const input = chat.add(new Panel('ChatInput'));
    const target = chat.add(new Panel('ChatTargetLabel'));
    const navigations = []; let onTitle;
    const r = runtime(chat, {
        ModHudLookup: {find: id => ({Chat: chat, ChatInput: input, ChatTargetLabel: target})[id]},
        RegisterEventHandler: (event, panel, fn) => { onTitle = fn; },
        CreatePanel: (type, parent, id) => {
            const panel = parent.add(new Panel(id, [], type));
            panel.SetURL = url => { assert.ok(url.startsWith('https://')); navigations.push(url); };
            return panel;
        }
    });
    r.run('Anti-Toxic-Chat/panorama/scripts/anti_toxic_chat.js');
    const parse = url => JSON.parse(decodeURIComponent(url.slice(url.indexOf('#') + 1)));
    const hello = parse(navigations[0]);
    input.text = 'one'; r.sandbox.OnAntiToxicSubmit();
    input.text = 'two'; r.sandbox.OnAntiToxicSubmit();
    assert.equal(navigations.length, 1, 'must wait for ready');
    onTitle('AT2:' + JSON.stringify({op: 'ready', id: 0, session: hello.session, version: 2, href: navigations[0].split('#')[0]}));
    assert.equal(navigations.length, 2); assert.equal(parse(navigations[1]).text, 'one');
    onTitle('AT2:' + JSON.stringify({op: 'result', id: 1, session: 'wrong', text: 'ignored'}));
    assert.equal(navigations.length, 2);
    onTitle('AT2:' + JSON.stringify({op: 'result', id: 1, session: hello.session, text: 'reply'}));
    assert.equal(navigations.length, 3); assert.equal(parse(navigations[2]).text, 'two');
}
bridgeTest().then(() => console.log('PASS: native parry angle/anchor, commend lifecycle/targets, HTTPS bridge hash round-trip.'))
    .catch(error => { console.error(error); process.exitCode = 1; });
