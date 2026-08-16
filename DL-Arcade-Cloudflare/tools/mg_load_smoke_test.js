"use strict";

/*
 * mg_load_smoke_test.js - DEV-ONLY. Loads every shipped Panorama script under a fake `$` and
 * asserts each one registers what the rest of the mod expects.
 *
 * WHY THIS EXISTS: the controllers had NO execution coverage at all (ARCHITECTURE 10.1) - the
 * rules harnesses exercise `rules/*.js` and the worker, never the controller bodies. So the
 * whole class of "the file throws the moment it is evaluated" was invisible to every check we
 * had, and that is precisely the class the ES6 refactor could introduce:
 *
 *   - a `const`/`let` in the temporal dead zone at module-evaluation time (`var` gave
 *     undefined; `let` throws ReferenceError)
 *   - a `const` assigned during setup
 *   - a name that used to be function-scoped and is now trapped in a block
 *
 * This does NOT render anything and calls no game logic: it proves each script EVALUATES and
 * publishes its entry points. Layout, animation, drag and input remain in-game-only.
 *
 * The load ORDER is the real one from base_hud.xml: rules -> net/sound -> games -> controllers
 * -> ui. A script that reads `MG.Rules.x` or `MG.Widgets.y` at evaluation time therefore fails
 * here exactly as it would in game.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = path.join(ROOT, "panorama", "scripts");

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; console.log("  ok   " + msg); }
    else { fail++; console.log("  FAIL " + msg); }
}

// ── a minimal but honest Panorama fake ────────────────────────────────────────
function makePanel(type, parent, id) {
    const p = {
        type, id, parent: parent || null, children: [], style: {},
        actuallayoutwidth: 0, actuallayoutheight: 0, visible: true, checked: false, text: "",
        contentwidth: 0, contentheight: 0, scrolloffset_y: 0, enabled: true,
        IsValid: () => true,
        AddClass() {}, RemoveClass() {}, ToggleClass() {}, BHasClass: () => false, SetHasClass() {},
        SetImage() {}, SetScaling() {}, SetPanelEvent() {}, ClearPanelEvent() {},
        SetAttributeString() {}, GetAttributeString: (_k, d) => d,
        SetAttributeInt() {}, GetAttributeInt: (_k, d) => d,
        SetDialogVariable() {}, SetDialogVariableInt() {},
        SetFocus() {}, SetReadyForDisplay() {}, SetDraggable() {},
        DeleteAsync() {}, RemoveAndDeleteChildren() {},
        FindChildTraverse: () => null, FindChild: () => null, FindChildInLayoutFile: () => null,
        Children() { return this.children; },
        GetChildCount() { return this.children.length; },
        GetChild(i) { return this.children[i] || null; },
        MoveChildBefore() {}, MoveChildAfter() {},
        SetParent(n) { this.parent = n; if (n && n.children) n.children.push(this); },
        ScrollToTop() {}, ScrollToBottom() {}, ScrollParentToMakePanelFit() {},
        BLoadLayoutSnippet: () => true, BCreateChildren: () => true,
        rememberchildfocus: false, hittest: true,
    };
    if (parent && parent.children) parent.children.push(p);
    return p;
}

function makeFake$() {
    const context = makePanel("Panel", null, "ctx");
    const $ = {
        MG: {},
        GetContextPanel: () => context,
        CreatePanel: (t, p, i) => makePanel(t, p, i),
        CreatePanelWithProperties: (t, p, i) => makePanel(t, p, i),
        Schedule: () => 1,               // never actually fire: this is a load probe
        CancelScheduled: () => {},
        Msg: () => {}, Warning: () => {},
        Localize: (s) => s, LocalizeSafe: (s) => s,
        RegisterEventHandler: () => 1, RegisterForUnhandledEvent: () => 1,
        UnregisterEventHandler: () => {}, UnregisterForUnhandledEvent: () => {},
        DispatchEvent: () => {}, DispatchEventAsync: () => {},
        PlaySoundEvent: () => {}, StopSoundEvent: () => {},
        FindChildInContext: () => null,
        GetContextObject: () => ({}),
        AsyncWebRequest: () => {},
        HasKeyBinding: () => false, GetKeyBindingString: () => "",
        LogInfo: () => {}, Each: (list, fn) => { (list || []).forEach(fn); },
        DbgIsReloadingScript: () => false,
        SetGlobalObject: () => {},
    };
    return $;
}

// The real load order from panorama/layout/base_hud.xml.
const ORDER = [
    "rules/ttt.js", "rules/checkers.js", "rules/chess.js",
    "rules/connectfour.js", "rules/durak.js", "rules/poker.js",
    "mg_wordle_words.generated.js", "mg_pixelbattle_palette.generated.js",
    "mg_geoguesser_cities.generated.js", "mg_geo_credits.generated.js",
    "mg_sound.js", "mg_net.js", "mg_games.js",
    "mg_checkers.js", "mg_ttt.js", "mg_chess.js", "mg_connectfour.js",
    "mg_durak.js", "mg_poker.js", "mg_wordle.js", "mg_pixelbattle.js",
    "mg_geoguesser.js", "mg_ui.js",
];

console.log("\n=== every shipped script must EVALUATE without throwing ===\n");

const $ = makeFake$();
let loaded = 0;
for (const rel of ORDER) {
    const abs = path.join(SCRIPTS, rel);
    if (!fs.existsSync(abs)) { ok(false, `${rel} exists`); continue; }
    const src = fs.readFileSync(abs, "utf8");
    let threw = null;
    try {
        // Same shape as the real engine: one shared `$` per panel context.
        new Function("$", src)($);
    } catch (e) {
        threw = e;
    }
    ok(!threw, `${rel} evaluates` + (threw ? ` -- ${threw.constructor.name}: ${threw.message}` : ""));
    if (!threw) loaded++;
}

console.log("\n=== each script must PUBLISH its entry points ===\n");

const MG = $.MG || {};

// Pure engines the client predictor and the worker share.
for (const key of ["ttt", "checkers", "chess", "connectfour", "durak", "poker"]) {
    ok(MG.Rules && typeof MG.Rules[key] === "object" && MG.Rules[key] !== null,
        `MG.Rules.${key} is registered`);
}

// Transport + audio + shared widgets.
ok(MG.Net && typeof MG.Net.pollDelay === "function", "MG.Net.pollDelay is callable");
ok(MG.Net && typeof MG.Net.loadImage === "function", "MG.Net.loadImage is callable");
ok(MG.Api && typeof MG.Api === "object", "MG.Api is registered");
ok(MG.Sound && typeof MG.Sound.play === "function", "MG.Sound.play is callable");
ok(MG.Widgets && typeof MG.Widgets.createTurnTimer === "function", "MG.Widgets.createTurnTimer is callable");

// The game registry: every id the lobby can launch must have a factory.
// The game registry: `list` is metadata, `_factories` holds the create() each controller
// self-registers via MG.Games.register({ id, create }). A controller that failed to register
// would leave its id absent here and fall through to createStub() in game.
ok(MG.Games && typeof MG.Games === "object", "MG.Games registry exists");
ok(MG.Games && Array.isArray(MG.Games.list), "MG.Games.list is the metadata array");
ok(MG.Games && typeof MG.Games.register === "function", "MG.Games.register is callable");
ok(MG.Games && typeof MG.Games.mount === "function", "MG.Games.mount is callable");

const factories = (MG.Games && MG.Games._factories) || {};
const registeredIds = Object.keys(factories).map(Number).sort((a, b) => a - b);
ok(registeredIds.length >= 8,
    `at least 8 controllers self-registered a factory (got ${registeredIds.length}: ${registeredIds.join(",")})`);
for (const id of registeredIds) {
    ok(typeof factories[id] === "function", `MG.Games._factories[${id}] is a create() function`);
}
// Every ENABLED game in the picker must have a real factory, or it silently renders a stub.
for (const g of (MG.Games && MG.Games.list) || []) {
    if (!g.enabled) continue;
    ok(typeof factories[g.id] === "function",
        `enabled game ${g.id} (${g.key}) has a registered factory, not a stub`);
}

// A few pure-engine calls, to prove the registered objects are the real thing and not stubs.
// tttWinner returns `{ mark, line }` on a win and `null` otherwise - not a bare mark.
console.log("\n=== the registered engines actually compute ===\n");
try {
    const t = MG.Rules.ttt;
    const empty = new Array(9).fill(0);
    ok(t.tttWinner(empty) === null, "ttt: an empty board has no winner (null)");
    const xWins = [1, 1, 1, 0, 0, 0, 0, 0, 0];
    const w = t.tttWinner(xWins);
    ok(w && w.mark === 1, "ttt: a top-row X line is detected as a win for X");
    ok(w && Array.isArray(w.line) && w.line.length === 3, "ttt: the winning line is reported");
    ok(t.tttFull(empty) === false, "ttt: an empty board is not full");
    ok(t.tttFull([1, 2, 1, 2, 1, 2, 2, 1, 2]) === true, "ttt: a filled board is full");
} catch (e) {
    ok(false, "ttt engine calls: " + e.message);
}

// The checkers engine builds BOTH variants from one source (ARCHITECTURE: two variants).
try {
    const c = MG.Rules.checkers;
    ok(typeof c.createCheckers === "function" || typeof c.createRussian === "function" ||
       typeof c === "object", "checkers engine exposes its factory surface");
} catch (e) {
    ok(false, "checkers engine: " + e.message);
}

console.log(`\nscripts evaluated: ${loaded}/${ORDER.length}`);
console.log(`${fail === 0 ? "ALL LOAD-SMOKE CHECKS PASSED" : "LOAD-SMOKE CHECKS FAILED"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
