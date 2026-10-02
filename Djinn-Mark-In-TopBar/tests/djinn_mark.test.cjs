"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const scripts = path.join(__dirname, "../panorama/scripts");
let now = 1000;
let nextId = 0;
let consumed = 0;
let relayed = 0;
const delayed = process.argv.includes("--delayed-layout");
const oldLayout = process.argv.includes("--old-layout");
const modernLayout = process.argv.includes("--modern-layout");
const wrappedEffects = process.argv.includes("--wrapped-effects");
const jobs = new Map();
const listeners = new Map();
const logs = [];
function schedule(seconds, fn) {
  const id = ++nextId;
  jobs.set(id, { at: now + seconds * 1000, fn });
  return id;
}
class Panel {
  constructor(id, text = "", classes = [], type = "Panel") {
    this.id = id; this.text = text; this.classes = new Set(classes); this.type = type;
    this.children = []; this.alive = true; this.visible = true;
    this.attributes = new Map(); this.parent = null; this.events = {};
    this.style = {};
  }
  add(child) { child.parent = this; this.children.push(child); return child; }
  IsValid() { return this.alive; }
  GetParent() { return this.parent; }
  Children() { return this.children.filter(child => child.alive); }
  SetAttributeString(key, value) { this.attributes.set(key, value); }
  GetAttributeString(key, fallback) { return this.attributes.has(key) ? this.attributes.get(key) : fallback; }
  FindChildTraverse(id) {
    for (const child of this.children) {
      if (!child.alive) continue;
      if (child.id === id) return child;
      const found = child.FindChildTraverse(id);
      if (found) return found;
    }
    return null;
  }
  FindChildrenWithClassTraverse(cls) {
    return this.children.filter(child => child.alive).flatMap(child =>
      [...(child.classes.has(cls) ? [child] : []), ...child.FindChildrenWithClassTraverse(cls)]);
  }
  BHasClass(cls) { return this.classes.has(cls); }
  AddClass(cls) { this.classes.add(cls); }
  SetHasClass(cls, enabled) { enabled ? this.classes.add(cls) : this.classes.delete(cls); }
  SetPanelEvent(event, fn) { this.events[event] = fn; }
  DeleteAsync() { this.alive = false; }
  BLoadLayout(url) {
    assert.equal(url, "file://{resources}/layout/djinn_mark_relay.xml");
    const load = () => context(this, ["djinn_mark_relay.js"]);
    if (delayed) schedule(0.05, load);
    else load();
    return true;
  }
}
function advance(ms) {
  const end = now + ms;
  for (;;) {
    const pending = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!pending) break;
    const [id, job] = pending;
    jobs.delete(id); now = job.at; job.fn();
  }
  now = end;
}
function emit(message) { for (const fn of [...listeners.values()]) fn(message); }
function context(root, files) {
  const $ = {
    GetContextPanel: () => root, Localize: value => value, Msg: value => logs.push(value),
    Schedule: schedule,
    RegisterForUnhandledEvent: (event, fn) => { const id = ++nextId; listeners.set(id, fn); return id; },
    UnregisterForUnhandledEvent: (event, id) => listeners.delete(id),
    CreatePanel: (type, parent, id) => parent.add(new Panel(id, "", [], type)),
    DispatchEvent(event, ...args) {
      if (event === "Activated") { const target = args[0]; if (target.events.onactivate) target.events.onactivate(); return; }
      assert.equal(event, "ClientUI_FireOutput");
      // The actual missing condition: world ClientUIDialogPanel consumes FireOutput.
      for (let panel = root; panel; panel = panel.parent) {
        if (panel.type === "ClientUIDialogPanel") { consumed++; return; }
      }
      relayed++; emit(args[0]);
    }
  };
  const ctx = vm.createContext({ $, Date: { now: () => now } }); // No GameUI, separate globals.
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(scripts, file), "utf8"), ctx);
  return $;
}
const hud = new Panel("CitadelHudRoot");
function card(name) {
  const root = hud.add(new Panel("TopBarPlayer" + hud.children.length));
  const hero = root.add(new Panel("HeroName", name));
  const badge = root.add(new Panel("TopbarDjinnMark"));
  const label = root.add(new Panel("DjinnMarkStacks"));
  const border = root.add(new Panel("DjinnMarkBorder"));
  root.add(new Panel("PlayerName", "Some Player"));
  context(root, ["djinn_mark_common.js", "djinn_mark_topbar.js"]);
  return { root, hero, badge, label, border };
}
const first = card("{s:hero_name}");
const other = card("Seven");
const world = new Panel("panorama_world_panel_31");
const hp = world.add(new Panel("overlay", "", [], "ClientUIDialogPanel"));
const unit = oldLayout || modernLayout ? hp.add(new Panel("UnitStatus")) : hp;
const names = oldLayout ? unit.add(new Panel("NameVoiceContainer")) : hp;
const name = names.add(new Panel("name", "INFERNUS"));
const effects = unit.add(new Panel("StatusEffects"));
const effectParent = wrappedEffects ? effects.add(new Panel("engine_wrapper")) : effects;
const mark = effectParent.add(new Panel("status_mirage_sand_phantom", "", ["sand_phantom_passive_victim"]));
const count = mark.add(new Panel("stacks", "1"));
const markContainer = mark.add(new Panel("", "", ["statusEffectContainer"]));
const markBorder = markContainer.add(new Panel("StatusEffectsBorder"));
markBorder.style.clip = "radial(50% 50%, 0deg, -180deg)";
const direct = context(hp, []);
direct.DispatchEvent("ClientUI_FireOutput", JSON.stringify({ magic_word: "DJINN_MARK_UPDATE", version: 2,
  key: "infernus", stacks: 8, updated_at: now, expires_at: now + 3000 }));
assert.equal(consumed, 1);
assert.equal(relayed, 0, "direct world dispatch cannot reach HUD");
context(hp, ["djinn_mark_common.js", "djinn_mark_relay.js", "djinn_mark_healthbar.js"]);
advance(600);
assert.equal(first.label.text, "");
const relay = world.FindChildTraverse("DjinnMarkEventRelay");
assert.ok(relay && relay.parent === world && relay.parent !== hp, "relay must be a sibling, not a child of dialog");
assert.ok(relayed > 0, "own-layout relay must reach another native root");
first.hero.text = "Infernus"; advance(600);
assert.equal(first.label.text, "1");
assert.equal(first.border.style.clip, "radial(50% 50%, 0deg, -180deg)");
assert.equal(other.label.text, "");
count.text = "2"; advance(600); assert.equal(first.label.text, "2");
markBorder.alive = false;
const newBorder = markContainer.add(new Panel("StatusEffectsBorder"));
newBorder.style.clip = "radial(50% 50%, 0deg, -90deg)";
advance(100);
assert.equal(first.border.style.clip, "radial(50% 50%, 0deg, -90deg)", "replaced masks must invalidate the cache");
assert.ok(first.badge.BHasClass("TopbarDjinnMarkVisible"));
const jobCount = jobs.size;
for (let i = 0; i < 20; i++) direct.DispatchEvent("Activated", relay, "mouse");
assert.equal(jobs.size, jobCount, "events must not multiply polling");
effects.children = []; advance(600); assert.equal(first.label.text, "");
effects.add(mark); count.text = "0"; advance(600); assert.equal(first.label.text, "");
count.text = "4"; advance(600); assert.equal(first.label.text, "4");
first.hero.text = "Seven"; advance(600); assert.equal(first.label.text, "");
first.hero.text = "Infernus"; advance(600);
first.root.classes.add("Dead"); advance(600); assert.equal(first.label.text, "");
first.root.classes.delete("Dead");
const late = card("Infernus"); advance(600); assert.equal(late.label.text, "4");
name.text = "Seven"; advance(600);
assert.equal(first.label.text, "", "reused world panel must clear previous hero");
assert.equal(other.label.text, "4");
context(hp, ["djinn_mark_common.js", "djinn_mark_relay.js", "djinn_mark_healthbar.js"]);
advance(600);
assert.equal(world.children.filter(p => p.alive && p.id === "DjinnMarkEventRelay").length, 1);
hp.alive = false; advance(3500);
assert.equal(other.label.text, "");
assert.equal(world.children.filter(p => p.alive && p.id === "DjinnMarkEventRelay").length, 0);
emit("not json"); emit('{"magic_word":"unrelated"}');
const listenerCount = listeners.size;
context(late.root, ["djinn_mark_common.js", "djinn_mark_topbar.js"]);
assert.equal(listeners.size, listenerCount);
late.root.alive = false; advance(600); assert.equal(listeners.size, listenerCount - 1);
assert.equal(logs.filter(line => line.startsWith("[DjinnMark:Relay]")).length, 0, logs.join("\n"));
console.log("PASS: direct world dispatch consumed; sibling relay across separate roots; " +
  (delayed ? "delayed" : "immediate") + " layout; identity, stacks, clearing, expiry, reuse, reload, cleanup.");
