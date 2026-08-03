"use strict";

/*
 * mg_checkers_play_test.js - DEV-ONLY. Plays FULL vs-bot checkers games through the real
 * mg_checkers.js CONTROLLER, by clicking cells, and judges the result from the panels the
 * player would actually SEE.
 *
 * WHY THIS EXISTS (2026-08-03 player report, Summxr):
 *   "when you king pieces on your side it doesnt acknowledge it so your checkers get stuck in
 *    the back rank unable to move ... and its not letting me move any other checkers either.
 *    im softlocked"
 *
 * Every check we had was blind to this. rules/*.js harnesses exercise the PURE engine (which is
 * self-consistent - proven separately), and mg_load_smoke_test.js only proves each controller
 * EVALUATES. Nothing ever drove input into a controller, so "the engine is right but the
 * controller wedges" was an entire invisible failure class - exactly where a softlock lives.
 *
 * The harness is deliberately BLACK-BOX about state: it never reads the controller's closure.
 * It reconstructs the board from the piece panels (class mg-white/mg-black/mg-king + the
 * translate3d transform that positions them), which is precisely the information on screen. So
 * "the crown is not acknowledged" is a claim this test can actually settle, and a move that the
 * model made but never rendered fails here instead of confusing a player.
 *
 * NOT covered (in-game only): real drag-and-drop, CSS, animation timing, the pointer.
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

// ── deterministic RNG ─────────────────────────────────────────────────────────
// The bot mixes Math.random() into its move scores, and a softlock report we cannot re-run is
// worthless. Seed it so a failure prints a seed that reproduces the exact game.
let rngState = 1;
function seedRng(s) { rngState = s >>> 0 || 1; }
function rng() {
    // xorshift32: tiny, dependency-free, and good enough to shuffle bot preferences.
    rngState ^= rngState << 13; rngState >>>= 0;
    rngState ^= rngState >>> 17;
    rngState ^= rngState << 5; rngState >>>= 0;
    return rngState / 4294967296;
}

// ── a Panorama fake with a REAL scheduler and REAL panel events ───────────────
// mg_load_smoke_test.js stubs Schedule to never fire (it is only a load probe). Here the whole
// point is that time passes: the bot thinks via $.Schedule chains, hops animate via $.Schedule,
// and a turn only completes after those callbacks run. So Schedule pushes into a virtual clock
// that the driver drains in timestamp order.
function makeHarness() {
    let now = 0;
    let seq = 0;
    const timers = [];

    function makePanel(type, parent, id) {
        const p = {
            type, id, parent: parent || null, children: [], style: {},
            classes: new Set(), events: {},
            actuallayoutwidth: 0, actuallayoutheight: 0, visible: true, checked: false, text: "",
            contentwidth: 0, contentheight: 0, scrolloffset_y: 0, enabled: true,
            IsValid() { return !this._deleted; },
            AddClass(c) { this.classes.add(c); },
            RemoveClass(c) { this.classes.delete(c); },
            ToggleClass(c) { this.classes.has(c) ? this.classes.delete(c) : this.classes.add(c); },
            BHasClass(c) { return this.classes.has(c); },
            SetHasClass(c, on) { on ? this.classes.add(c) : this.classes.delete(c); },
            SetImage() {}, SetScaling() {},
            SetPanelEvent(name, fn) { this.events[name] = fn; },
            ClearPanelEvent(name) { delete this.events[name]; },
            SetAttributeString() {}, GetAttributeString: (_k, d) => d,
            SetAttributeInt() {}, GetAttributeInt: (_k, d) => d,
            SetDialogVariable() {}, SetDialogVariableInt() {},
            SetFocus() {}, SetReadyForDisplay() {}, SetDraggable() {},
            DeleteAsync() {
                this._deleted = true;
                const kids = this.parent && this.parent.children;
                if (kids) { const i = kids.indexOf(this); if (i >= 0) kids.splice(i, 1); }
            },
            RemoveAndDeleteChildren() {
                for (const c of this.children.slice()) { c._deleted = true; }
                this.children.length = 0;
            },
            FindChildTraverse: () => null, FindChild: () => null, FindChildInLayoutFile: () => null,
            Children() { return this.children; },
            GetChildCount() { return this.children.length; },
            GetChild(i) { return this.children[i] || null; },
            MoveChildBefore() {}, MoveChildAfter() {},
            SetParent(n) {
                const kids = this.parent && this.parent.children;
                if (kids) { const i = kids.indexOf(this); if (i >= 0) kids.splice(i, 1); }
                this.parent = n; if (n && n.children) n.children.push(this);
            },
            ScrollToTop() {}, ScrollToBottom() {}, ScrollParentToMakePanelFit() {},
            BLoadLayoutSnippet: () => true, BCreateChildren: () => true,
            GetPositionWithinWindow: () => null,
            rememberchildfocus: false, hittest: true,
        };
        if (parent && parent.children) parent.children.push(p);
        return p;
    }

    const context = makePanel("Panel", null, "ctx");
    const $ = {
        MG: {},
        GetContextPanel: () => context,
        CreatePanel: (t, p, i) => makePanel(t, p, i),
        CreatePanelWithProperties: (t, p, i) => makePanel(t, p, i),
        Schedule(delay, fn) {
            const t = { at: now + (Number(delay) || 0), seq: seq++, fn };
            timers.push(t);
            return t;
        },
        CancelScheduled(h) { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
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

    // Run exactly ONE scheduled callback (the earliest). Stepping matters: the offline bot thinks
    // across a $.Schedule chain, so single-stepping is the only way to be INSIDE the bot's think
    // and click the board there - which is where a real player's impatient clicks land.
    function step() {
        if (!timers.length) return false;
        let best = 0;
        for (let i = 1; i < timers.length; i++) {
            if (timers[i].at < timers[best].at ||
                (timers[i].at === timers[best].at && timers[i].seq < timers[best].seq)) best = i;
        }
        const t = timers.splice(best, 1)[0];
        now = Math.max(now, t.at);
        t.fn();
        return true;
    }

    // Drain the virtual clock until it is empty (or a sane step budget is spent - a runaway
    // reschedule loop must fail the test, not hang it).
    function pump(budget) {
        let steps = 0;
        const cap = budget || 200000;
        while (timers.length && steps < cap) { step(); steps++; }
        return steps < cap;
    }

    function pending() { return timers.length; }

    return { $, context, pump, step, pending, findPanel };

    function findPanel(id, root) {
        const start = root || context;
        if (start.id === id) return start;
        for (const c of start.children) {
            const r = findPanel(id, c);
            if (r) return r;
        }
        return null;
    }
}

// ── load the shipped scripts in the real base_hud.xml order ──────────────────
const ORDER = [
    "rules/ttt.js", "rules/checkers.js", "rules/chess.js",
    "rules/connectfour.js", "rules/durak.js", "rules/poker.js",
    "mg_wordle_words.generated.js", "mg_pixelbattle_palette.generated.js",
    "mg_geoguesser_cities.generated.js", "mg_geo_credits.generated.js",
    "mg_sound.js", "mg_net.js", "mg_games.js",
    "mg_checkers.js",
];
function loadMod($) {
    for (const rel of ORDER) {
        const src = fs.readFileSync(path.join(SCRIPTS, rel), "utf8");
        new Function("$", src)($);
    }
}

// ── read the board the PLAYER sees, out of the piece panels ──────────────────
// mg_checkers positions every piece by `transform: translate3d(<x>px, <y>px, 0px)` where
// x = displayCol*SQ + INSET and y = displayRow*SQ + INSET, and marks it mg-white / mg-black
// (+ mg-king once crowned). Inverting that is exactly "what is on screen", which is the claim
// the player made. myColor decides whether display == real or display == 63 - real.
const SQ = 60, PIECE_SZ = 46, INSET = (SQ - PIECE_SZ) / 2;
function visibleBoard(harness, myColorIsWhite) {
    const layer = harness.findPanel("MG_PiecesLayer");
    if (!layer) return null;
    const b = new Array(64).fill(0);
    for (const p of layer.children) {
        if (p._deleted) continue;
        if (!p.classes.has("mg-piece")) continue;
        if (p.classes.has("mg-dragging")) continue;   // the drag ghost is not a board piece
        if (p.classes.has("mg-captured")) continue;   // mid fade-out, already off the model
        const m = /translate3d\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(p.style.transform || "");
        if (!m) continue;
        const dc = Math.round((Number(m[1]) - INSET) / SQ);
        const dr = Math.round((Number(m[2]) - INSET) / SQ);
        if (dc < 0 || dc > 7 || dr < 0 || dr > 7) continue;
        const d = dr * 8 + dc;
        const real = myColorIsWhite ? d : 63 - d;
        const white = p.classes.has("mg-white");
        const king = p.classes.has("mg-king");
        b[real] = white ? (king ? 2 : 1) : (king ? 4 : 3);
    }
    return b;
}

function boardStr(b) {
    let s = "";
    for (let r = 0; r < 8; r++) {
        let line = "";
        for (let c = 0; c < 8; c++) line += ".wWbB"[b[r * 8 + c]];
        s += "  " + (8 - r) + " " + line + "\n";
    }
    return s + "    abcdefgh\n";
}
function sameBoard(a, b) {
    for (let i = 0; i < 64; i++) if (a[i] !== b[i]) return false;
    return true;
}
function sqName(i) { return String.fromCharCode(97 + (i % 8)) + (8 - ((i / 8) | 0)); }

// ── one full game, driven by clicks ──────────────────────────────────────────
// Returns { outcome, turns, softlock, promotions } - softlock is a diagnostic object when the
// player was left on the move with a legal move available that the UI refused to play.
//
// `opts.startBoard` replaces the opening position (the controller calls RCv.initialBoard() once
// at mount, so patching that entry point is how a crafted endgame gets in without reaching into
// the closure). `opts.strong` makes the harness play the engine's own search instead of a random
// legal move: random play loses in ~20 turns and NEVER promotes, which is exactly why the old
// coverage could not see a promotion bug at all.
function playGame(variant, playerIsHost, seed, opts) {
    opts = opts || {};
    seedRng(seed);
    const harness = makeHarness();
    const $ = harness.$;
    // Deterministic bot: patch Math.random for the whole game so a failure is reproducible.
    const realRandom = Math.random;
    Math.random = rng;
    try {
        loadMod($);
        const MG = $.MG;
        const R = variant === "english" ? MG.Rules.checkersEnglish : MG.Rules.checkers;
        const myColor = playerIsHost ? R.WHITE : R.BLACK;
        const myColorIsWhite = myColor === R.WHITE;
        const myMan = myColorIsWhite ? 1 : 3, myKing = myColorIsWhite ? 2 : 4;
        const crownRow = myColorIsWhite ? 0 : 7;
        if (opts.startBoard) {
            const snap = opts.startBoard.slice();
            R.initialBoard = () => snap.slice();
        }

        let lastStatus = "";
        let over = null;
        const host = $.CreatePanel("Panel", harness.context, "host");
        const game = MG.Games.mount(1, host, {
            code: 0, isHost: playerIsHost, bot: true, variant,
            timeControl: 0,
            onStatus: (t) => { lastStatus = String(t); },
            onGameOver: (r) => { if (!over) over = r; },
        });
        ok(!!game, `${variant}/${playerIsHost ? "white" : "black"} seed ${seed}: controller mounted`);

        harness.pump();   // let the boot (and the bot's opening move, when we are black) settle

        const cells = [];
        for (let i = 0; i < 64; i++) cells[i] = harness.findPanel(`cell_${i}`);

        function click(i, drain) {
            const c = cells[i];
            if (!c || !c.events.onactivate) return false;
            c.events.onactivate();
            if (drain !== false) harness.pump();
            return true;
        }

        // Impatient clicking. The offline bot is NOT instant (a stepped depth-5 search yielding one
        // root move per frame, plus 0.35s per animated hop), so a real player clicks the board while
        // it "thinks" - which lands in the PREMOVE path, not the move path. This single-steps the
        // scheduler and clicks BETWEEN steps, i.e. genuinely mid-think, the way a player drumming on
        // their own pieces does.
        function clickDuringBotThink() {
            let guard = 0;
            while (harness.pending() && guard++ < 4000) {
                harness.step();
                if (guard % 7 === 0) {
                    const sq = (rng() * 64) | 0;
                    const c = cells[sq];
                    if (c && c.events.onactivate) c.events.onactivate();
                }
            }
        }

        let turns = 0, promotions = 0, crownMisses = [];
        // 300 player turns is far beyond any real game (the draw rules fire long before), so
        // hitting it means the position is not progressing.
        // `over` is written by the onGameOver callback the controller fires from inside a
        // scheduled tick, so the loop condition reads it via a getter - a bare `!over` reads to
        // static analysis as a condition the loop never modifies.
        const gameEnded = () => over !== null;
        for (; turns < 300 && !gameEnded(); turns++) {
            const before = visibleBoard(harness, myColorIsWhite);
            if (!before) return { outcome: "no-board", turns, softlock: null, promotions, crownMisses };

            // Is it even our move? The controller drives the bot itself; if the position shows
            // no legal move for us, the game must have ended (checkEnd), not sat there.
            const seqs = R.legalSequences(before, myColor);
            if (seqs.length === 0) break;   // terminal for us: expect onGameOver below

            // Choose this turn. Strong play keeps games alive long enough to reach promotions
            // and king endgames - the part of the state space the player was actually in.
            let seqPick = null;
            if (opts.strong) seqPick = R.chooseBotMove(before, myColor);
            if (!seqPick) seqPick = seqs[(rng() * seqs.length) | 0];

            // Will this turn crown one of our men? Then the piece left standing on the landing
            // square must READ as a king on screen ("it doesnt acknowledge it").
            const landing = seqPick[seqPick.length - 1].to;
            const willCrown = before[seqPick[0].from] === myMan && ((landing / 8) | 0) === crownRow;

            // Play one full turn by clicking: source, then each landing square in the chain.
            click(seqPick[0].from);
            for (const hop of seqPick) click(hop.to);
            // Now the bot is thinking. An impatient player keeps clicking through that window.
            if (opts.impatient) clickDuringBotThink();

            const after = visibleBoard(harness, myColorIsWhite);
            if (sameBoard(before, after)) {
                // The player had a legal move, clicked it exactly, and the board they can see
                // did not change. That is the softlock, captured with everything needed to fix it.
                return {
                    outcome: "softlock", turns, promotions, crownMisses, softlock: {
                        variant, playerIsHost, seed, status: lastStatus,
                        board: before,
                        attempted: seqPick.map((h) => `${sqName(h.from)}->${sqName(h.to)}`).join(" "),
                        legal: seqs.length,
                    }
                };
            }
            if (willCrown) {
                // The bot answers within the same pump, so only judge the square while OUR piece
                // is still the thing standing on it.
                if (after[landing] === myKing) promotions++;
                else if (after[landing] === myMan) {
                    promotions++;
                    crownMisses.push({ variant, playerIsHost, seed, at: sqName(landing), board: after });
                }
            }
        }
        return {
            outcome: over || (turns >= 300 ? "move-cap" : "ended-no-callback"),
            turns, softlock: null, promotions, crownMisses,
        };
    } finally {
        Math.random = realRandom;
    }
}

// Craft a position where the player is ONE step from crowning, with the enemy far away so the
// step is quiet (no forced capture) and the game does not end on the spot.
// `playerIsWhite` decides which men are ours; white crowns at row 0, black at row 7.
function nearPromotionBoard(playerIsWhite) {
    const b = new Array(64).fill(0);
    const at = (r, c, v) => { b[r * 8 + c] = v; };
    if (playerIsWhite) {
        at(1, 2, 1);            // our man, one quiet step from row 0
        at(5, 1, 1);            // a spare man so a lost king is not instantly terminal
        at(6, 4, 3); at(7, 3, 3);   // enemy men, out of contact
    } else {
        at(6, 5, 3);            // our man, one quiet step from row 7
        at(2, 6, 3);
        at(1, 3, 1); at(0, 4, 1);
    }
    return b;
}

// ── run ──────────────────────────────────────────────────────────────────────
const softlocks = [];
const crownMisses = [];

function runGame(label, variant, playerIsHost, seed, opts) {
    let r;
    try {
        r = playGame(variant, playerIsHost, seed, opts);
    } catch (e) {
        ok(false, `${label} seed ${seed}: threw ${e && e.constructor ? e.constructor.name : "?"}: ` +
            `${e && e.message}`);
        return null;
    }
    if (r.outcome === "softlock") softlocks.push(r.softlock);
    for (const m of r.crownMisses || []) crownMisses.push(m);
    ok(r.outcome !== "softlock",
        `${label} seed ${seed}: no softlock (${r.outcome} after ${r.turns} turns, ` +
        `${r.promotions} promotion${r.promotions === 1 ? "" : "s"})`);
    return r;
}

console.log("\n=== the checkers CONTROLLER must never softlock a vs-bot game ===\n");

const GAMES = Number(process.env.MG_PLAY_GAMES || 4);
for (const variant of ["russian", "english"]) {
    for (const playerIsHost of [true, false]) {
        const label = `${variant}/${playerIsHost ? "white" : "black"}`;
        for (let g = 0; g < GAMES; g++) {
            const seed = 1000 * (variant === "english" ? 2 : 1) + (playerIsHost ? 0 : 500) + g + 1;
            runGame(label, variant, playerIsHost, seed, { strong: true });
        }
    }
}

console.log("\n=== a crowned man must be ACKNOWLEDGED, and keep playing, from the crowning row ===\n");
// Random play loses in ~20 turns and never promotes at all, so a crafted near-promotion start is
// the only reliable way to exercise the crowning path. From there the game continues normally:
// if the fresh king cannot move (the player's "stuck in the back rank") the very next turn shows
// up as a softlock, and if the crown is not drawn it shows up as a crown miss.
let totalPromotions = 0;
for (const variant of ["russian", "english"]) {
    for (const playerIsHost of [true, false]) {
        const label = `${variant}/${playerIsHost ? "white" : "black"} (near-promotion start)`;
        const r = runGame(label, variant, playerIsHost, 4242, {
            strong: true, startBoard: nearPromotionBoard(playerIsHost),
        });
        if (r) {
            totalPromotions += r.promotions;
            ok(r.promotions > 0, `${label}: the player actually reached a promotion`);
        }
    }
}
ok(totalPromotions > 0, `promotions were exercised at all (${totalPromotions} total)`);
ok(crownMisses.length === 0,
    `every promoted man rendered as a king (${crownMisses.length} silent crown${crownMisses.length === 1 ? "" : "s"})`);

console.log("\n=== clicking while the offline bot thinks must not wedge the board ===\n");
// The offline bot is not instant, so a player WILL click during its think. Those clicks reach
// premoveClick() (canPremove() only tests "not my turn"), which queues a premove that is then
// replayed by tryPremove the moment the turn flips. If that path can leave the board unplayable,
// this is where it shows: the very next turn fails the softlock assertion above.
for (const variant of ["russian", "english"]) {
    for (const playerIsHost of [true, false]) {
        const label = `${variant}/${playerIsHost ? "white" : "black"} (impatient clicking)`;
        for (let g = 0; g < GAMES; g++) {
            const seed = 7000 + 1000 * (variant === "english" ? 2 : 1) + (playerIsHost ? 0 : 500) + g + 1;
            runGame(label, variant, playerIsHost, seed, { strong: true, impatient: true });
        }
    }
}

// ── the review trap: a dead board that looks exactly like a live one ─────────
// The move list is clickable, and the row for the position you are ALREADY looking at is the
// highlighted one - so it is the most natural row to click. Clicking it calls gotoReview(last),
// which sets reviewIndex and renders history[last].boardAfter: byte-for-byte the live position.
// Nothing on screen changes, the status line still reads "Your turn.", and yet every board click
// now hits `if (reviewIndex !== null) return` and is swallowed. That is a softlock the player
// cannot even see, and it matches the report exactly: "its not letting me move any other checkers
// either. im softlocked".
function reviewTrap(variant, playerIsHost) {
    const harness = makeHarness();
    const $ = harness.$;
    const realRandom = Math.random;
    Math.random = rng; seedRng(31);
    const label = `${variant}/${playerIsHost ? "white" : "black"}`;
    try {
        loadMod($);
        const MG = $.MG;
        const R = variant === "english" ? MG.Rules.checkersEnglish : MG.Rules.checkers;
        const myColor = playerIsHost ? R.WHITE : R.BLACK;
        const myColorIsWhite = myColor === R.WHITE;
        let lastStatus = "";
        const host = $.CreatePanel("Panel", harness.context, "host");
        MG.Games.mount(1, host, {
            code: 0, isHost: playerIsHost, bot: true, variant, timeControl: 0,
            onStatus: (t) => { lastStatus = String(t); }, onGameOver: () => {},
        });
        harness.pump();

        const cells = [];
        for (let i = 0; i < 64; i++) cells[i] = harness.findPanel(`cell_${i}`);
        const clickCell = (i) => {
            const c = cells[i];
            if (c && c.events.onactivate) { c.events.onactivate(); harness.pump(); }
        };

        // Play one normal turn so the move list has rows (ours + the bot's reply).
        const b0 = visibleBoard(harness, myColorIsWhite);
        const first = R.chooseBotMove(b0, myColor) || R.legalSequences(b0, myColor)[0];
        clickCell(first[0].from);
        for (const hop of first) clickCell(hop.to);

        const rowsPanel = harness.findPanel("MG_CheckersMoves");
        let rows = [];
        (function collect(p) {
            for (const c of p.children) {
                if (!c._deleted && c.classes.has("mg-move-row")) rows.push(c);
                collect(c);
            }
        })(rowsPanel || harness.context);
        if (rows.length === 0) { ok(false, `${label}: the move list rendered clickable rows`); return; }

        // Click the LAST row - the highlighted "you are here" row.
        const last = rows[rows.length - 1];
        const beforeClick = visibleBoard(harness, myColorIsWhite);
        last.events.onactivate();
        harness.pump();
        const afterClick = visibleBoard(harness, myColorIsWhite);

        // It is invisible: the rendered position is unchanged.
        const looksIdentical = sameBoard(beforeClick, afterClick);

        // Now try to play a legal move, exactly as the player would.
        const seqs = R.legalSequences(afterClick, myColor);
        if (seqs.length === 0) { ok(false, `${label}: a legal move existed to attempt`); return; }
        const pick = seqs[0];
        clickCell(pick[0].from);
        for (const hop of pick) clickCell(hop.to);
        const afterMove = visibleBoard(harness, myColorIsWhite);
        const boardIsDead = sameBoard(afterClick, afterMove);

        ok(!(looksIdentical && boardIsDead),
            `${label}: clicking the current move row does not silently kill the board ` +
            `(identical=${looksIdentical}, dead=${boardIsDead}, status="${lastStatus}")`);

        // A REAL review (an earlier row) is legitimately read-only - but it must SAY so, not
        // swallow the click. A dead board with no explanation is what made this unreportable.
        if (rows.length >= 2) {
            rows[0].events.onactivate();
            harness.pump();
            const inReview = visibleBoard(harness, myColorIsWhite);
            lastStatus = "";
            const anySeq = R.legalSequences(inReview, myColor)[0] ||
                R.legalSequences(afterMove, myColor)[0];
            if (anySeq) {
                clickCell(anySeq[0].from);
                ok(/review/i.test(lastStatus),
                    `${label}: a click while reviewing an earlier move explains itself ` +
                    `(status="${lastStatus}")`);
            }

            // Live must hand the board back. Re-collect the rows: renderMoveList rebuilt them.
            const navPanel = harness.findPanel("MG_CheckersMoves");
            let liveBtn = null;
            (function findLive(p) {
                for (const c of p.children) {
                    if (c._deleted) continue;
                    if (c.classes.has("mg-nav-btn")) {
                        for (const l of c.children) if (l.text === "Live") liveBtn = c;
                    }
                    findLive(c);
                }
            })(navPanel || harness.context);
            if (liveBtn && liveBtn.events.onactivate) {
                liveBtn.events.onactivate();
                harness.pump();
                const back = visibleBoard(harness, myColorIsWhite);
                const seqs2 = R.legalSequences(back, myColor);
                if (seqs2.length) {
                    const p2 = seqs2[0];
                    clickCell(p2[0].from);
                    for (const hop of p2) clickCell(hop.to);
                    ok(!sameBoard(back, visibleBoard(harness, myColorIsWhite)),
                        `${label}: pressing Live restores a playable board`);
                }
            }
        }
    } finally {
        Math.random = realRandom;
    }
}

console.log("\n=== clicking the move list must never leave an unplayable board ===\n");
for (const variant of ["russian", "english"]) {
    for (const playerIsHost of [true, false]) reviewTrap(variant, playerIsHost);
}

if (softlocks.length) {
    console.log("\n--- SOFTLOCK DETAIL ---");
    for (const s of softlocks.slice(0, 4)) {
        console.log(`\n${s.variant}, player=${s.playerIsHost ? "white/host" : "black/joiner"}, seed=${s.seed}`);
        console.log(`status line: "${s.status}"`);
        console.log(`clicked: ${s.attempted}   (${s.legal} legal sequences existed)`);
        console.log(boardStr(s.board));
    }
}
if (crownMisses.length) {
    console.log("\n--- CROWN NOT RENDERED ---");
    for (const m of crownMisses.slice(0, 4)) {
        console.log(`\n${m.variant}, player=${m.playerIsHost ? "white/host" : "black/joiner"}, ` +
            `seed=${m.seed}: promoted at ${m.at} but the panel still reads as a man`);
        console.log(boardStr(m.board));
    }
}

console.log(`\n${fail === 0 ? "ALL CHECKERS PLAY CHECKS PASSED" : "CHECKERS PLAY CHECKS FAILED"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
