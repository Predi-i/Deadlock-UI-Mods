"use strict";

/*
 * mg_poker.js - No-Limit Texas Hold'em controller for the Deadlock Minigames mod.
 *
 * Two modes share this controller. OFFLINE ("you + N bots") runs the whole hand locally off
 * the shared engine + a seeded bot. ONLINE (worker-as-dealer, 2–4 seats) holds NO authority:
 * it replays the SAME pure betting engine against the server's public event log (/api/plog),
 * pulls its own two hole cards privately (/api/pdraw), fills the board + revealed hands from
 * events, and resolves the pots locally at showdown - mirroring Durak Stage 2. The pure rules
 * live in rules/poker.js (shared byte-for-byte with the worker); here we render + take input.
 *
 * RENDERING follows the Durak idiom (ARCHITECTURE §8.6 + the traps): everything sits on ONE
 * flow-children:none felt STAGE, positioned by transform:translate3d (Panorama has NO
 * position:absolute). Cards draw their face/back with a CHILD <Image> (setFace), NOT a panel
 * background-image - a background paints the .vtex at its native 367×512 px on frame 1 (the
 * ~300% zoom bug). The felt is larger than Durak's (the maintainer said the 4-seat Durak table
 * is cramped): 760×520.
 *
 * NONE of the visuals are verifiable from a shell - reasoned from the game's CSS idioms + the
 * Durak/Connect Four controllers, confirmed only after a VPK repack.
 *
 * Card model matches rules/poker.js: id 0..51 = suit*13 + rank. suit 0..3 = S,H,D,C.
 * rank 0..12 = 2..9,T,J,Q,K,A. Face art = deck/<SUIT><RANK>.vtex (e.g. "SA", "H2", "DT").
 */

(function () {
    var MG = ($.MG = $.MG || {});
    if (MG._pokerLoaded) return;
    MG._pokerLoaded = true;

    var P = MG.Rules && MG.Rules.poker;   // shared pure engine (rules/poker.js)

    var SUIT_CHARS = P ? P.SUIT_CHARS : ["S", "H", "D", "C"];
    var RANK_CHARS = P ? P.RANK_CHARS : ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
    var DECK_DIR = "s2r://panorama/images/deck/";
    function cardFaceUrl(id) { return DECK_DIR + SUIT_CHARS[P.suitOf(id)] + RANK_CHARS[P.rankOf(id)] + ".vtex"; }
    var BACK_URL = DECK_DIR + "BACK.vtex";

    // Card faces/backs are drawn by a CHILD <Image>, not the container's background - see
    // MG.Widgets.setFace in mg_games.js for why (and for the copy durak/chess/the picker share).
    var setFace = MG.Widgets.setFace;
    function setBack(container) { setFace(container, BACK_URL); }

    // Where each opponent sits on MY screen, given their relative seat offset. I always sit at
    // the bottom; opponents fill left / top / right (4-handed uses all three).
    function seatZone(rel, N) {
        if (N <= 2) return "top";
        if (N === 3) return rel === 1 ? "left" : "right";
        return rel === 1 ? "left" : (rel === 2 ? "top" : "right"); // N === 4
    }

    // Stage geometry (px). Bigger than Durak's 680×500 - the 4-seat felt needs the room.
    var CARD_W = 76, CARD_H = 106;     // board card size
    var HERO_W = 106, HERO_H = 148;    // MY hole cards: ~1.4x the board so my hand reads clearly bottom-centre
    var OPP_CW = 42, OPP_CH = 59;      // opponents' small face-down backs (avoid the mushy overlap)
    var STAGE_W = 760, STAGE_H = 520;
    var START_STACK = 200, SB = 5, BB = 10;

    function createPoker(container, session) {
        var numPlayers = (session.numPlayers && session.numPlayers >= 2) ? session.numPlayers : 4;
        var mySeat = (session.seat != null) ? session.seat : 0;
        var isBot = !!session.bot;
        var online = !isBot && !!session.code && !!(MG.Api && MG.Api.plog);
        var destroyed = false;

        // Tournament-style chip carryover across hands (offline). Button rotates each hand.
        var stacks = [];
        for (var i = 0; i < numPlayers; i++) stacks.push(START_STACK);
        var button = (numPlayers - 1);        // so the first hand's button is seat 0 after rotate
        var handSeed = (session.seed != null) ? session.seed : ((Math.random() * 0x7fffffff) | 0);
        var st = null;
        var pendingBet = 0;                   // current raise-to target in the bet stepper
        var showdownReveal = false;           // reveal all live hands at showdown/over
        // One evolving rng for all bot decisions this session, so a seat doesn't replay the same
        // choice every time it acts (a fresh per-call seed would). Offline only.
        var botRng = P ? P.makeRng((handSeed ^ 0x9e3779b9) | 0) : null;

        // ── online sync state (worker-as-dealer) ──────────────────────────────────
        // logSeq = next public event index to fetch; pollGen guards against two concurrent
        // poll chains sharing logSeq (the exact bug that dropped Durak events - see mg_durak).
        // holeCursor = how many of MY 2 hole cards I've pulled via pdraw for the current hand;
        // pendingAct blocks input between send and the echoed event.
        var logSeq = 0, pollGen = 0, holeCursor = 0, pendingAct = false, gameOver = false;
        var pollMisses = 0;            // consecutive empty polls this turn (drives the adaptive cadence)
        var wantHole = false;                 // a HAND event landed → pull my hole cards before rendering
        var leftSeats = [];                   // online seats that abandoned the table (rendered as "left")
        var pendingRaiseLo = [0, 0, 0, 0];    // per-seat low 6 bits of a split raise-to, awaiting its hi half

        function status(t) { if (session.onStatus) session.onStatus(t); }
        function nameOf(seat) {
            if (seat === mySeat) return "You";
            var base = online ? ("Player " + (seat + 1)) : ("Bot " + (seat + 1));
            return (leftSeats.indexOf(seat) >= 0) ? (base + " (left)") : base;
        }
        function myTurn() { return !destroyed && st && st.toAct === mySeat && st.street !== "over" && st.street !== "showdown"; }

        var root = $.CreatePanel("Panel", container, "MG_PokerRoot");
        root.AddClass("mg-poker");

        var stage = $.CreatePanel("Panel", root, "MG_PkStage"); stage.AddClass("mg-poker-stage");
        var decorLayer = $.CreatePanel("Panel", stage, "MG_PkDecor"); decorLayer.AddClass("mg-pk-decor");
        var cardLayer = $.CreatePanel("Panel", stage, "MG_PkCards"); cardLayer.AddClass("mg-pk-cards");
        var controlsZone = $.CreatePanel("Panel", root, "MG_PkControls"); controlsZone.AddClass("mg-poker-controls");

        // Per-turn countdown, pinned to the felt's LEFT EDGE (boardW = STAGE_W 760). Parented on
        // `container` (the flow:none game host). Poker's action is ALWAYS optional-in-spirit but the
        // clock is mandatory: if it empties, the seat is timed out with a fold (or a check when
        // checking is free - never forfeit chips you didn't have to). Absent build (old mg_games) →
        // null; every call guarded. See refreshTimer/onTimerExpire below.
        var turnTimer = (MG.Widgets && MG.Widgets.createTurnTimer) ? MG.Widgets.createTurnTimer(container, { boardW: 760 }) : null;

        function xform(x, y, rot) {
            var t = "translate3d(" + Math.round(x) + "px, " + Math.round(y) + "px, 0px)";
            return rot ? (t + " rotateZ(" + rot + "deg)") : t;
        }

        // ── seat layout ─────────────────────────────────────────────────────────────
        // Avatar tile centres per zone (my tile bottom-centre; opponents around the felt).
        // Left/right pulled inward so a 120px tile + its card pair clear the 760px felt edge.
        function seatCenter(seat) {
            // My tile lives in the bottom-LEFT corner (durak idiom) so it never stacks on my
            // centred hole cards or the pot; opponents ring the top/sides.
            if (seat === mySeat) return { x: 84, y: STAGE_H - 46 };
            var rel = (seat - mySeat + numPlayers) % numPlayers;
            var zone = seatZone(rel, numPlayers);
            if (zone === "left") return { x: 96, y: STAGE_H * 0.40 };
            if (zone === "right") return { x: STAGE_W - 96, y: STAGE_H * 0.40 };
            return { x: STAGE_W / 2, y: 56 };   // top
        }
        // Where a seat's two cards sit. Mine are the big face-up hole cards, bottom-centre,
        // ABOVE my tile. Opponents get two SMALL backs, centred as a neat pair just below their
        // tile (a small gap, NOT the heavy 71% overlap that mushed the old full-size backs).
        function holeAnchor(seat) {
            var c = seatCenter(seat);
            if (seat === mySeat) {
                // Big face-up pair along the bottom edge, centred. Below the pot label, clear of
                // my corner tile - the felt's bottom-centre is otherwise empty. Uses HERO_* (larger
                // than the board cards) so my own hand is the easiest thing on the felt to read.
                return { x: STAGE_W / 2 - HERO_W - 4, y: STAGE_H - HERO_H - 14, spread: HERO_W + 8, w: HERO_W, h: HERO_H };
            }
            var pairW = OPP_CW * 2 + 6;                 // two small backs + a 6px gap
            return { x: c.x - pairW / 2, y: c.y + 36, spread: OPP_CW + 6, w: OPP_CW, h: OPP_CH };
        }
        // Board (up to 5 community cards) centred horizontally, mid felt.
        function boardSlot(i, n) {
            var step = CARD_W + 10;
            var totalW = step * 5 - 10;                 // always reserve 5 slots so pot stays centred
            var x0 = STAGE_W / 2 - totalW / 2;
            return { x: x0 + i * step, y: STAGE_H / 2 - CARD_H / 2 - 20 };
        }

        // ── render ────────────────────────────────────────────────────────────────────
        function render() {
            if (!st) return;   // online: nothing to draw until the first HAND event lands
            decorLayer.RemoveAndDeleteChildren();
            cardLayer.RemoveAndDeleteChildren();
            buildPot();
            buildBoard();
            buildSeats();
            buildControls();
            refreshTimer();
        }

        // ── per-turn countdown ───────────────────────────────────────────────────────
        // The clock runs ONLY while it's my turn to act (myTurn()). If it empties I'm timed out:
        // fold my hand - the maintainer's ruling - unless checking is free, in which case I check
        // (there's no reason to forfeit equity when staying in costs nothing). pendingAct parks the
        // action send, so a slow round-trip can't fire a bogus timeout. render() calls refreshTimer
        // after every state change; a mode change (my turn ↔ not) (re)arms or stops the 20s.
        var timerOn = false;
        function refreshTimer() {
            if (!turnTimer) return;
            var live = myTurn() && !pendingAct;
            if (live === timerOn) return;              // no change → keep the running (or stopped) clock
            timerOn = live;
            if (!live) { turnTimer.stop(); return; }
            turnTimer.start(onTimerExpire);
        }
        function onTimerExpire() {
            timerOn = false;
            if (destroyed || !st || !myTurn()) return;
            var la = P.legalActions(st, mySeat);
            var action = la.canCheck ? { type: "check" } : { type: "fold" };
            doAction(action);
        }

        function buildPot() {
            var pot = P.totalPot(st);
            var lbl = $.CreatePanel("Label", decorLayer, "");
            lbl.AddClass("mg-pk-pot");
            // X comes purely from .mg-pk-pot's horizontal-align:center - do NOT also translate X.
            // The old code did BOTH (align-centre + translateX of STAGE_W/2-100), and Panorama
            // stacks them, shoving the 200px label to the felt's right edge where it landed on the
            // right-hand seat's bet chip readout ("texts overlap", maintainer 2026-07-18). translateY
            // only for the vertical drop below the board; align keeps it horizontally centred.
            lbl.style.transform = xform(0, STAGE_H / 2 + CARD_H / 2 - 6, 0);
            lbl.text = "Pot: " + pot;
        }

        function buildBoard() {
            var n = st.board.length;
            for (var i = 0; i < 5; i++) {
                var s = boardSlot(i, n);
                if (i < n) {
                    var c = $.CreatePanel("Panel", cardLayer, "");
                    c.AddClass("mg-pk-card");
                    setFace(c, cardFaceUrl(st.board[i]));
                    c.style.transform = xform(s.x, s.y, 0);
                } else {
                    var slot = $.CreatePanel("Panel", decorLayer, "");
                    slot.AddClass("mg-pk-boardslot");
                    slot.style.transform = xform(s.x, s.y, 0);
                }
            }
        }

        function buildSeats() {
            for (var seat = 0; seat < numPlayers; seat++) buildSeat(seat);
        }

        function buildSeat(seat) {
            var c = seatCenter(seat);
            var isMe = seat === mySeat;
            var live = st.inHand[seat] && !st.folded[seat];

            // hole cards. Mine are big face-up cards; opponents get two small backs (the
            // per-seat w/h from holeAnchor, applied inline so one .mg-pk-card rule serves both).
            // Online, only MY two cards are known during the hand (pulled via pdraw); opponents'
            // hole arrays stay empty until SHOW events at showdown. So draw a face-DOWN pair for
            // any in-hand seat whose cards we don't hold yet, and face-UP once we have both.
            var ha = holeAnchor(seat);
            var known = st.hole[seat] && st.hole[seat].length === 2;
            if (st.inHand[seat]) {
                for (var k = 0; k < 2; k++) {
                    var card = $.CreatePanel("Panel", cardLayer, "");
                    card.AddClass("mg-pk-card");
                    card.style.width = ha.w + "px";
                    card.style.height = ha.h + "px";
                    if (isMe) card.AddClass("mg-pk-hole-me");
                    var reveal = known && (isMe || (showdownReveal && live));
                    if (reveal) setFace(card, cardFaceUrl(st.hole[seat][k]));
                    else setBack(card);
                    if (st.folded[seat]) card.AddClass("mg-pk-folded");
                    card.style.transform = xform(ha.x + k * ha.spread, ha.y, 0);
                }
            }

            // avatar tile
            var tile = $.CreatePanel("Panel", decorLayer, "");
            tile.AddClass("mg-pk-tile");
            if (isMe) tile.AddClass("mg-pk-me");
            if (seat === st.toAct && live) tile.AddClass("mg-pk-active");
            if (st.folded[seat]) tile.AddClass("mg-pk-out");
            tile.style.transform = xform(c.x - 60, c.y - 30, 0);

            var name = $.CreatePanel("Label", tile, "");
            name.AddClass("mg-pk-name");
            name.text = nameOf(seat);

            var stackLbl = $.CreatePanel("Label", tile, "");
            stackLbl.AddClass("mg-pk-stack");
            stackLbl.text = st.allIn[seat] ? "ALL-IN" : (st.stacks[seat] + " ch");

            // dealer / blind chips
            if (seat === st.button) badge(tile, "D", "mg-pk-dealer");
            if (typeof st.bbSeat === "number" && seat === st.bbSeat) { /* labelled by bet below */ }

            // current street bet, floated toward the pot (a chip readout between the seat and
            // the board). Mine sits just above my tile; opponents' below their card pair.
            if (st.bet[seat] > 0) {
                var betLbl = $.CreatePanel("Label", decorLayer, "");
                betLbl.AddClass("mg-pk-bet");
                var bx = c.x - 30, by = (seat === mySeat) ? (c.y - 62) : (c.y + 36 + ha.h + 6);
                betLbl.style.transform = xform(bx, by, 0);
                betLbl.text = String(st.bet[seat]) + " ch";
            }

            // folded / result tag
            if (st.folded[seat]) {
                var tag = $.CreatePanel("Label", tile, "");
                tag.AddClass("mg-pk-tag"); tag.text = "FOLD";
            }
        }

        function badge(tile, text, cls) {
            var b = $.CreatePanel("Panel", tile, "");
            b.AddClass("mg-pk-chip"); b.AddClass(cls);
            var l = $.CreatePanel("Label", b, ""); l.text = text;
        }

        // ── controls (bet stepper + action buttons) ─────────────────────────────────
        function buildControls() {
            controlsZone.RemoveAndDeleteChildren();
            if (st.street === "over") { buildNextHand(); return; }
            if (!myTurn()) return;
            var la = P.legalActions(st, mySeat);

            // Stepper row (only when a raise is possible) sits ABOVE the action buttons - the
            // standard poker layout. The action buttons (incl. Raise) all live on ONE centred
            // row so the Raise button inherits the row's flow-children:right + centre and can't
            // clip half-off the left edge (the "half-visible button" bug).
            if (la.canRaise) {
                if (pendingBet < la.minRaiseTo || pendingBet > la.maxRaiseTo) pendingBet = la.minRaiseTo;
                var stepRow = $.CreatePanel("Panel", controlsZone, ""); stepRow.AddClass("mg-pk-steprow");
                mkStep(stepRow, "-", function () { pendingBet = Math.max(la.minRaiseTo, pendingBet - BB); buildControls(); });
                var amt = $.CreatePanel("Label", stepRow, ""); amt.AddClass("mg-pk-betamt"); amt.text = String(pendingBet);
                mkStep(stepRow, "+", function () { pendingBet = Math.min(la.maxRaiseTo, pendingBet + BB); buildControls(); });
                mkStep(stepRow, "Pot", function () {
                    var pot = P.totalPot(st);
                    pendingBet = Math.min(la.maxRaiseTo, Math.max(la.minRaiseTo, st.currentBet + pot));
                    buildControls();
                });
                mkStep(stepRow, "Max", function () { pendingBet = la.maxRaiseTo; buildControls(); });
            }

            var row = $.CreatePanel("Panel", controlsZone, ""); row.AddClass("mg-pk-actionrow");
            if (la.canFold) mkButton(row, "Fold", "mg-btn", function () { doAction({ type: "fold" }); });
            if (la.canCheck) mkButton(row, "Check", "mg-btn-primary", function () { doAction({ type: "check" }); });
            if (la.canCall) mkButton(row, "Call " + la.callAmount, "mg-btn-primary", function () { doAction({ type: "call" }); });
            if (la.canRaise) {
                var raiseLabel = (st.currentBet === 0) ? "Bet " : "Raise to ";
                mkButton(row, raiseLabel + pendingBet, "mg-btn-primary", function () {
                    doAction({ type: "raise", to: pendingBet });
                });
            }
        }

        function buildNextHand() {
            var msg = $.CreatePanel("Label", controlsZone, ""); msg.AddClass("mg-pk-result");
            msg.text = resultText();
            var alive = 0, last = -1;
            for (var s = 0; s < numPlayers; s++) if (stacks[s] > 0) { alive++; last = s; }
            if (alive < 2) {
                var over = $.CreatePanel("Label", controlsZone, ""); over.AddClass("mg-pk-result");
                over.text = (last === mySeat) ? "You win the table!" : nameOf(last) + " wins the table.";
                if (session.onGameOver) session.onGameOver(last === mySeat ? "win" : "lose");
                return;
            }
            mkButton(controlsZone, "Next hand", "mg-btn-primary", function () {
                if (online) { requestNextHand(); return; }
                startHand();
            });
        }

        function resultText() {
            if (!st.result) return "";
            var w = st.result.winners || [];
            if (w.length === 0) return "Hand over.";
            var names = [];
            for (var i = 0; i < w.length; i++) names.push(nameOf(w[i]));
            var who = names.join(" & ");
            // Verb agrees with the SUBJECT, not the count: "You win" / "They win" take the bare
            // verb, only a single third-person winner ("Bot 2 wins") takes the -s. The old
            // `w.length === 1 ? "s"` produced "You wins" for a solo human winner.
            var verb = (w.length === 1 && w[0] !== mySeat) ? " wins" : " win";
            if (st.result.uncontested) return who + verb + " (everyone folded).";
            return who + verb + " at showdown.";
        }

        function mkButton(parent, text, kind, onClick) {
            var b = $.CreatePanel("Button", parent, "");
            b.AddClass("mg-btn"); if (kind === "mg-btn-primary") b.AddClass("mg-btn-primary");
            b.AddClass("mg-pk-action");
            var l = $.CreatePanel("Label", b, ""); l.text = text;
            b.SetPanelEvent("onactivate", onClick);
            return b;
        }
        function mkStep(parent, text, onClick) {
            var b = $.CreatePanel("Button", parent, "");
            b.AddClass("mg-btn"); b.AddClass("mg-pk-step");
            var l = $.CreatePanel("Label", b, ""); l.text = text;
            b.SetPanelEvent("onactivate", onClick);
            return b;
        }

        // ── flow ────────────────────────────────────────────────────────────────────
        function startHand() {
            if (destroyed) return;
            button = P ? nextOccupiedButton() : (button + 1) % numPlayers;
            handSeed = (handSeed * 1103515245 + 12345) & 0x7fffffff;
            st = P.newHand(numPlayers, button, stacks, SB, BB, handSeed);
            showdownReveal = false;
            pendingBet = 0;
            render();
            afterAdvance();
        }
        function nextOccupiedButton() {
            for (var k = 1; k <= numPlayers; k++) {
                var s = (button + k) % numPlayers;
                if (stacks[s] > 0) return s;
            }
            return button;
        }

        function doAction(action) {
            if (!myTurn()) return;
            if (online) { sendAct(action); return; }
            if (!P.applyAction(st, mySeat, action)) { status("Illegal move."); return; }
            pendingBet = 0;
            postApply();
        }

        // Runs after any action (mine or a bot's) resolves in the engine.
        function postApply() {
            if (destroyed) return;
            if (st.street === "over") {
                showdownReveal = !st.result || !st.result.uncontested;
                // absorb the new stacks back into the tournament carryover
                stacks = st.stacks.slice();
                render();
                // The result is shown ONCE, on the felt banner above "Next hand" (buildNextHand).
                // Don't ALSO push it to the footer status - that was the doubled "You win" report.
                status("");
                return;
            }
            render();
            afterAdvance();
        }

        // If it's a bot's turn, schedule it; otherwise prompt the human.
        function afterAdvance() {
            if (destroyed || !st || st.street === "over") return;
            var seat = st.toAct;
            if (seat < 0) return;
            if (seat === mySeat) { status(streetName() + ": your action."); return; }
            status(nameOf(seat) + " is thinking…");
            $.Schedule(0.6, function () { botStep(seat); });
        }

        function botStep(seat) {
            if (destroyed || !st || st.toAct !== seat || st.street === "over") return;
            var act = P.botAction(st, seat, botRng);
            if (!P.applyAction(st, seat, act)) P.applyAction(st, seat, { type: "fold" });
            postApply();
        }

        function streetName() {
            return { preflop: "Pre-flop", flop: "Flop", turn: "Turn", river: "River" }[st.street] || "";
        }

        // ── online sync (worker-as-dealer) ────────────────────────────────────────────
        // The client holds NO authority: it replays the SAME pure betting engine against the
        // public event log (fold/check/call/raise are card-independent, so the replay is
        // byte-identical to the server's), fills the board from BOARD events, its own two hole
        // cards privately from /api/pdraw, and every contender's cards from SHOW events at
        // showdown - then resolves the pots LOCALLY (resolveShowdown, same side-pot maths as the
        // server) so nobody's hole cards travel until the hand is decided. Actions are sent via
        // /api/pact WITHOUT optimistic mutation: the echoed event is the single source of truth.
        // (opponent names come from nameOf(), which already reads "Player N" online.)

        // A HAND event opens a new hand: build a fresh online shell (blinds/turn are
        // card-independent so they match the server), then pull my two hole cards before render.
        function beginOnlineHand(button) {
            button = Math.max(0, Math.min(button | 0, numPlayers - 1));
            st = P.newHand(numPlayers, button, stacks, SB, BB, null);  // online shell (empty deck)
            showdownReveal = false;
            pendingBet = 0;
            holeCursor = 0;
            wantHole = true;
        }

        function applyOnlineEvent(ev) {
            if (ev.type === "hand") { beginOnlineHand(ev.button); return; }
            if (ev.type === "board") { if (st) st.board.push(ev.card); return; }
            if (ev.type === "show") {
                // Reveal a contender's two hole cards at showdown. My OWN seat is skipped: I
                // already hold my real cards from pdraw, and the server SHOWs every contender
                // (me included) - pushing them again would give me a 4-card hand.
                if (st && ev.seat !== mySeat && st.hole[ev.seat] && st.hole[ev.seat].length < 2)
                    st.hole[ev.seat].push(ev.card);
                return;
            }
            if (ev.type === "win") {
                if (!st) return;
                // Contested showdown deferred to "showdown" with no result → resolve now that the
                // board + every contender's hole cards have arrived. Uncontested folds already
                // finished the hand locally (street "over"), so resolveShowdown is a safe no-op.
                P.resolveShowdown(st);
                showdownReveal = !st.result || !st.result.uncontested;
                stacks = st.stacks.slice();          // bank the tournament carryover
                return;
            }
            if (ev.type === "over") { gameOver = true; return; }
            if (ev.type === "left") {
                // A seat abandoned the table: replay it as a fold + chip forfeit through the shared
                // engine (card-independent → byte-identical to the server), then bank the stacks so
                // beginOnlineHand sits them out. The fold may itself have ended the hand; the server
                // also flushed the matching board/WIN events, so we let those arrive and resolve.
                if (st) { P.leaveSeat(st, ev.seat); stacks = st.stacks.slice(); }
                else if (stacks && stacks[ev.seat] != null) stacks[ev.seat] = 0;
                if (leftSeats.indexOf(ev.seat) < 0) leftSeats.push(ev.seat);
                return;
            }
            // betting actions - replayed through the shared engine (validated already server-side)
            // A raise-to amount (up to ~800, the whole stack) overflows one level dimension, so
            // the worker splits it into a raiselo (low 6 bits) immediately followed by a raisehi
            // (high bits). Stash lo, then drive the reducer once the hi half completes it -
            // to = hi*64 + lo. The pair is always adjacent + ordered in the log, so a per-seat
            // stash is enough (no seq bookkeeping).
            if (ev.type === "raiselo") { pendingRaiseLo[ev.seat] = ev.lo; return; }
            if (ev.type === "raisehi") {
                var to = ev.hi * 64 + (pendingRaiseLo[ev.seat] || 0);
                pendingRaiseLo[ev.seat] = 0;
                if (st && st.toAct === ev.seat) P.applyAction(st, ev.seat, { type: "raise", to: to });
                return;
            }
            var action = ev.type === "fold" ? { type: "fold" }
                : ev.type === "check" ? { type: "check" }
                : ev.type === "call" ? { type: "call" } : null;
            if (action && st && st.toAct === ev.seat) P.applyAction(st, ev.seat, action);
        }

        // Pull my 2 hole cards for the current hand, one index at a time (FIFO-safe), then render.
        function pullHole(done) {
            if (destroyed) return;
            if (holeCursor >= 2) { wantHole = false; done(); return; }
            MG.Api.pdraw(session.code, session.tok, holeCursor, function (card) {
                if (destroyed) return;
                if (card == null) { done(); return; }      // not dealt at that index yet - retry via poll
                if (st && st.hole[mySeat]) st.hole[mySeat][holeCursor] = card;
                holeCursor++;
                pullHole(done);
            }, function () { if (!destroyed) $.Schedule(0.4, function () { pullHole(done); }); });
        }

        function onlineStatus() {
            if (gameOver) return;
            if (!st) { status("Dealing…"); return; }
            // At hand-over the felt banner (buildNextHand) already shows the result - keep the
            // footer blank so it isn't printed twice (the doubled "You win" report).
            if (st.street === "over") { status(""); return; }
            if (myTurn()) { status(streetName() + ": your action."); return; }
            if (st.toAct >= 0) { status(nameOf(st.toAct) + " to act…"); return; }
            status(streetName());
        }

        // Single authoritative poll chain (pollGen guards it, exactly like mg_durak - two chains
        // sharing logSeq would double-apply one event and skip the next).
        function startPolling() { pollGen++; pollMisses = 0; pollLoop(pollGen); }
        function pollLoop(gen) {
            if (destroyed || gameOver || gen !== pollGen) return;
            MG.Api.plog(session.code, logSeq, function (ev) {
                if (destroyed || gen !== pollGen) return;
                // Nothing new: back off on the shared adaptive cadence (see MG.Net.pollDelay) so a
                // long think doesn't burn ~2 req/s. A real event resets the miss counter below.
                if (!ev) { $.Schedule(MG.Net.pollDelay(pollMisses++), function () { pollLoop(gen); }); return; }   // nothing new
                pollMisses = 0;
                logSeq++;
                applyOnlineEvent(ev);
                if (wantHole) {
                    pullHole(function () {
                        if (gen !== pollGen) return;
                        render(); onlineStatus(); pollLoop(gen);
                    });
                    return;
                }
                render();
                onlineStatus();
                if (gameOver) { finishOnline(); return; }
                pollLoop(gen);                                 // drain any burst immediately
            }, function () { if (!destroyed && gen === pollGen) $.Schedule(1.0, function () { pollLoop(gen); }); });
        }

        function finishOnline() {
            render();
            // whoever still holds chips won the table
            var last = -1;
            for (var s = 0; s < numPlayers; s++) if (stacks[s] > 0) last = s;
            status(last === mySeat ? "You win the table!" : nameOf(last) + " wins the table.");
            if (session.onGameOver) session.onGameOver(last === mySeat ? "win" : "lose");
        }

        // Send one betting action; the server validates and (on success) appends the echoed
        // event the poll reads back. No optimistic local mutation - a rejected action just
        // never lands. a: 0 fold · 1 check · 2 call · 3 raise (to).
        function sendAct(action) {
            if (destroyed || pendingAct) return;
            var a = action.type === "fold" ? 0 : action.type === "check" ? 1 : action.type === "call" ? 2 : 3;
            var to = (a === 3) ? (action.to | 0) : 0;
            pendingAct = true;
            status("Sending…");
            MG.Api.pact(session.code, session.tok, a, to, function (r) {
                pendingAct = false;
                if (r && r.ok) { startPolling(); return; }        // pull the echo promptly (single chain)
                if (r && r.reason === "turn") status("Not your turn.");
                else if (r && r.reason === "illegal") status("That move isn't legal.");
                else if (r && r.reason === "gone") { if (MG.UI && MG.UI.kickToMenu) MG.UI.kickToMenu("Lobby closed."); }
                else status("Move rejected.");
            }, function () { pendingAct = false; status("Server unavailable."); });
        }

        function requestNextHand() {
            if (destroyed) return;
            status("Dealing next hand…");
            MG.Api.pnext(session.code, session.tok, function (r) {
                // Success OR "wait" (someone else already dealt) - the poll will pick up the HAND
                // event either way. Only a token/gone failure is worth surfacing.
                if (r && !r.ok && r.reason === "gone" && MG.UI && MG.UI.kickToMenu) MG.UI.kickToMenu("Lobby closed.");
            }, function () { status("Server unavailable."); });
        }

        // ── deal watchdog ─────────────────────────────────────────────────────────────
        // Same pattern as mg_durak.js: if logSeq is still 0 after a few seconds, the poll
        // chain has likely stalled (mg_net FIFO wedge). Re-kick startPolling() to recover.
        function dealWatchdog(tries) {
            if (destroyed || gameOver || !online) return;
            if (logSeq > 0) return;
            if (tries >= 6) { status("Still dealing… check your connection or try again."); return; }
            $.Schedule(3.0, function () {
                if (destroyed || gameOver || logSeq > 0) return;
                startPolling();
                dealWatchdog(tries + 1);
            });
        }

        // ── boot ────────────────────────────────────────────────────────────────────
        if (!P) {
            status("Poker engine failed to load.");
        } else if (online) {
            status("Dealing…");
            startPolling();
            dealWatchdog(0);
        } else {
            startHand();
        }

        return {
            destroy: function () { destroyed = true; if (turnTimer) turnTimer.destroy(); try { root.DeleteAsync(0); } catch (e) {} }
        };
    }

    if (MG.Games && MG.Games.register) {
        MG.Games.register({ id: 6, enabled: true, create: createPoker });
    }
})();
