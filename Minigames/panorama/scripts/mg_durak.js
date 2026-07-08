"use strict";

/*
 * mg_durak.js — "Durak" (Подкидной дурак) for the Deadlock Minigames mod.
 *
 * Stage 1 (this file, for now): OFFLINE play vs bot(s). No server calls at all — the
 * whole deck/deal/rules run locally, exactly like the other games' bot mode. Online
 * 2–4 player play (worker as authoritative dealer + per-seat private deal channel) is
 * Stage 2 and will reuse the pure rules below unchanged.
 *
 * The file is split into two clearly marked sections (see the banner comments below):
 *   "pure rules"  — self-contained, UI-free, no $ / no MG. tools/mg_durak_test.js slices
 *                   exactly this section and runs it under Node (same trick as the
 *                   chess/checkers pure sections in mg_games.js).
 *   "controller"  — Panorama rendering + input + bot loop. Not sliceable.
 *
 * Card model: id 0..35 = suit*9 + rank. suit 0..3 = S,H,D,C. rank 0..8 = 6,7,8,9,T,J,Q,K,A
 * (higher rank index = stronger). Trump = suit of the deck's bottom card.
 *
 * Registers itself into the shared registry: MG.Games.register({ id:3, enabled:true, create }).
 */

(function () {
    var MG = ($.MG = $.MG || {});
    if (MG._durakLoaded) return;
    MG._durakLoaded = true;

    // ── durak: pure rules ─────────────────────────────────────────────────────
    // NOTHING below this line up to the controller banner may reference $ or MG: it is
    // sliced out and run standalone by tools/mg_durak_test.js.

    var SUIT_CHARS = ["S", "H", "D", "C"];
    var RANK_CHARS = ["6", "7", "8", "9", "T", "J", "Q", "K", "A"];
    var DECK_SIZE = 36;

    function suitOf(id) { return (id / 9) | 0; }
    function rankOf(id) { return id % 9; }

    // Deterministic PRNG (mulberry32) so a given seed always deals the same game — the
    // test relies on this, and online (Stage 2) the server owns the seed.
    function makeRng(seed) {
        var s = seed | 0;
        return function () {
            s = (s + 0x6D2B79F5) | 0;
            var t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function freshDeck(rng) {
        var d = [];
        for (var i = 0; i < DECK_SIZE; i++) d.push(i);
        for (var j = DECK_SIZE - 1; j > 0; j--) {
            var k = (rng() * (j + 1)) | 0;
            var t = d[j]; d[j] = d[k]; d[k] = t;
        }
        return d;
    }

    // Draw from the FRONT (index 0 = top). The bottom card (last index) is the trump card,
    // drawn last, so it stays put until the deck is nearly empty.
    function deal(deck, numPlayers) {
        var hands = [];
        for (var s = 0; s < numPlayers; s++) hands.push([]);
        var dk = deck.slice();
        for (var n = 0; n < 6; n++)
            for (var p = 0; p < numPlayers; p++) hands[p].push(dk.shift());
        var trumpCard = dk[dk.length - 1];
        return { hands: hands, deck: dk, trumpCard: trumpCard, trump: suitOf(trumpCard) };
    }

    // A `def` card beats an `att` card if: same suit and higher rank, OR it is a trump
    // covering a non-trump. Trump-vs-trump is decided by rank (same-suit branch).
    function beats(att, def, trump) {
        var sa = suitOf(att), sd = suitOf(def);
        if (sd === sa) return rankOf(def) > rankOf(att);
        if (sd === trump && sa !== trump) return true;
        return false;
    }

    function removeCard(hand, id) { var k = hand.indexOf(id); if (k >= 0) hand.splice(k, 1); }

    // Lowest trump holder opens the very first attack (classic rule); seat 0 if nobody
    // holds a trump.
    function firstAttacker(st) {
        var best = -1, bestRank = 99;
        for (var s = 0; s < st.numPlayers; s++) {
            var h = st.hands[s];
            for (var k = 0; k < h.length; k++) {
                if (suitOf(h[k]) === st.trump && rankOf(h[k]) < bestRank) { bestRank = rankOf(h[k]); best = s; }
            }
        }
        return best < 0 ? 0 : best;
    }

    function nextInPlay(st, seat) {
        for (var k = 1; k <= st.numPlayers; k++) {
            var s = (seat + k) % st.numPlayers;
            if (!st.out[s]) return s;
        }
        return seat;
    }
    function firstInPlayFrom(st, seat) { return st.out[seat] ? nextInPlay(st, seat) : seat; }

    function newGame(numPlayers, seed) {
        var dealt = deal(freshDeck(makeRng(seed)), numPlayers);
        var st = {
            numPlayers: numPlayers,
            trump: dealt.trump,
            trumpCard: dealt.trumpCard,
            deck: dealt.deck,
            hands: dealt.hands,
            table: [],          // [{ a: attackId, d: defenseId | -1 }]
            attacker: 0,
            defender: 0,
            phase: "attack",   // "attack" | "defend" | "over"
            discard: 0,
            out: [],
            loser: -1
        };
        for (var s = 0; s < numPlayers; s++) st.out.push(false);
        st.attacker = firstAttacker(st);
        st.defender = nextInPlay(st, st.attacker);
        return st;
    }

    // ── table queries ──
    function tableRankSet(st) {
        var set = {};
        for (var i = 0; i < st.table.length; i++) {
            set[rankOf(st.table[i].a)] = 1;
            if (st.table[i].d >= 0) set[rankOf(st.table[i].d)] = 1;
        }
        return set;
    }
    function uncoveredCount(st) {
        var n = 0;
        for (var i = 0; i < st.table.length; i++) if (st.table[i].d < 0) n++;
        return n;
    }
    function firstUncovered(st) {
        for (var i = 0; i < st.table.length; i++) if (st.table[i].d < 0) return i;
        return -1;
    }

    // Can `seat` play `card` as an attack right now?
    //  - opener (empty table): only the attacker, any card.
    //  - throw-in (non-empty, all currently covered in our simplified flow): rank must
    //    already be on the table, table capped at 6 cards, and never more uncovered
    //    attacks than the defender can still cover.
    function canAttackWith(st, seat, card) {
        if (st.out[seat]) return false;
        if (seat === st.defender) return false;
        if (st.hands[seat].indexOf(card) < 0) return false;
        if (st.table.length === 0) return seat === st.attacker;
        if (st.table.length >= 6) return false;
        if (uncoveredCount(st) + 1 > st.hands[st.defender].length) return false;
        return !!tableRankSet(st)[rankOf(card)];
    }
    function legalAttacks(st, seat) {
        var out = [], h = st.hands[seat];
        for (var i = 0; i < h.length; i++) if (canAttackWith(st, seat, h[i])) out.push(h[i]);
        return out;
    }
    function canDefendPair(st, pairIndex, card) {
        var p = st.table[pairIndex];
        if (!p || p.d >= 0) return false;
        if (st.hands[st.defender].indexOf(card) < 0) return false;
        return beats(p.a, card, st.trump);
    }
    function legalDefends(st, pairIndex) {
        var out = [], h = st.hands[st.defender];
        for (var i = 0; i < h.length; i++) if (canDefendPair(st, pairIndex, h[i])) out.push(h[i]);
        return out;
    }

    // ── mutators ──
    function applyAttack(st, seat, card) {
        removeCard(st.hands[seat], card);
        st.table.push({ a: card, d: -1 });
        st.phase = "defend";
    }
    function applyDefend(st, pairIndex, card) {
        removeCard(st.hands[st.defender], card);
        st.table[pairIndex].d = card;
        if (uncoveredCount(st) === 0) st.phase = "attack"; // hand back to the attacker (add or Бито)
    }

    function updateOut(st) {
        var deckEmpty = st.deck.length === 0;
        for (var s = 0; s < st.numPlayers; s++) {
            if (!st.out[s] && st.hands[s].length === 0 && deckEmpty) st.out[s] = true;
        }
    }
    function inPlayCount(st) {
        var n = 0;
        for (var s = 0; s < st.numPlayers; s++) if (!st.out[s]) n++;
        return n;
    }
    // Refill hands to 6, attacker(s) first in turn order, defender LAST (standard).
    function refill(st) {
        var order = [];
        for (var k = 0; k < st.numPlayers; k++) {
            var s = (st.attacker + k) % st.numPlayers;
            if (s === st.defender || st.out[s]) continue;
            order.push(s);
        }
        if (!st.out[st.defender]) order.push(st.defender);
        for (var i = 0; i < order.length; i++) {
            var seat = order[i];
            while (st.hands[seat].length < 6 && st.deck.length > 0) st.hands[seat].push(st.deck.shift());
        }
    }
    // End the current bout. took=true → defender picks up the whole table; else the table
    // is "beaten" (Бито) and discarded. Then refill and rotate roles.
    function endBout(st, took) {
        var oldDef = st.defender, i;
        if (took) {
            for (i = 0; i < st.table.length; i++) {
                st.hands[oldDef].push(st.table[i].a);
                if (st.table[i].d >= 0) st.hands[oldDef].push(st.table[i].d);
            }
        } else {
            for (i = 0; i < st.table.length; i++) { st.discard++; if (st.table[i].d >= 0) st.discard++; }
        }
        st.table = [];
        refill(st);
        updateOut(st);
        // Successful defense → the defender attacks next. Took → the taker is skipped.
        var base = firstInPlayFrom(st, took ? nextInPlay(st, oldDef) : oldDef);
        st.attacker = base;
        st.defender = nextInPlay(st, base);
        st.phase = "attack";
        checkOver(st);
    }
    // Game ends when one or zero players are still holding cards. That last player is the
    // fool (durak); zero means a rare simultaneous-empty draw.
    function checkOver(st) {
        if (st.phase === "over") return true;
        updateOut(st);
        if (inPlayCount(st) <= 1) {
            st.phase = "over";
            st.loser = -1;
            for (var s = 0; s < st.numPlayers; s++) if (!st.out[s]) st.loser = s;
            return true;
        }
        return false;
    }

    // ── bot ──
    // Trumps sort far above non-trumps so the bot spends its cheapest, non-trump cards first.
    function cardValue(id, trump) { return rankOf(id) + (suitOf(id) === trump ? 100 : 0); }
    function sortByValue(arr, trump) {
        arr.sort(function (a, b) { return cardValue(a, trump) - cardValue(b, trump); });
        return arr;
    }
    // Returns the card to attack/throw-in with, or -1 to end the bout (Бито).
    function durakBotAttack(st, seat) {
        var la = sortByValue(legalAttacks(st, seat), st.trump);
        if (la.length === 0) return -1;
        if (st.table.length === 0) return la[0];            // opener must play its lowest
        var lowest = la[0];
        // Throw in only a genuinely cheap non-trump (6/7/8); otherwise stop.
        if (suitOf(lowest) !== st.trump && rankOf(lowest) <= 2) return lowest;
        return -1;
    }
    // Returns { pair, card } to cover the first open attack, or null to take.
    function durakBotDefend(st, seat) {
        var i = firstUncovered(st);
        if (i < 0) return null;
        var ld = sortByValue(legalDefends(st, i), st.trump);
        if (ld.length === 0) return null;                   // can't beat it → must take
        return { pair: i, card: ld[0] };
    }

    // ── durak controller ──────────────────────────────────────────────────────
    // Panorama rendering, input and the offline bot loop. NONE of this is verifiable from
    // a shell — it only runs inside Deadlock after a VPK repack. Reasoned from the game's
    // CSS idioms + the other controllers in mg_games.js, not confirmed in-game.

    var DECK_DIR = "s2r://panorama/images/deck/";
    function cardFaceUrl(id) { return DECK_DIR + SUIT_CHARS[suitOf(id)] + RANK_CHARS[rankOf(id)] + ".vtex"; }
    function cardBackUrl() { return DECK_DIR + "BACK.vtex"; }

    // Where each opponent sits on MY screen, given their offset from me around the table.
    // Everyone renders themselves at the bottom; opponents are placed by relative seat, so
    // "left" for one player is "right" for another (exactly the relativity the design calls
    // for). Zone map is easy to tweak; 3/4-player layouts are only exercised online (Stage 2).
    function seatZone(rel, N) {
        if (N <= 2) return "top";
        if (N === 3) return rel === 1 ? "left" : "right";
        return rel === 1 ? "left" : (rel === 2 ? "top" : "right"); // N === 4
    }

    // Stage geometry (px, in the stage's own coordinate space). Cards are positioned by
    // transform:translate3d — Panorama has no position:absolute — inside a flow-children:none
    // stage, exactly like the checkers pieces overlay. Because a card PANEL persists across
    // refreshes (keyed by card id), reassigning its transform makes it SLIDE (the .mg-dk-anim
    // transition), so playing a card glides from hand → table and a draw glides from the deck.
    var CARD_W = 78, CARD_H = 110;
    var STAGE_W = 640, STAGE_H = 410;

    function createDurak(container, session) {
        var numPlayers = session.numPlayers || 2;
        var mySeat = (session.seat != null) ? session.seat : 0;
        var isBot = !!session.bot;
        var seed = (session.seed != null) ? session.seed : ((Math.random() * 0x7fffffff) | 0);
        var st = newGame(numPlayers, seed);
        var destroyed = false;

        function status(t) { if (session.onStatus) session.onStatus(t); }
        function nameOf(seat) {
            if (seat === mySeat) return "You";
            return isBot ? ("Bot " + seat) : ("Player " + (seat + 1));
        }

        var root = $.CreatePanel("Panel", container, "MG_DurakRoot");
        root.AddClass("mg-durak");

        // Opponents sit in zones (top / left / right); the deck, table and my own hand all
        // live on one flow-children:none STAGE so cards can slide anywhere across it.
        var topZone = $.CreatePanel("Panel", root, "MG_DkTop"); topZone.AddClass("mg-durak-top");
        var midRow = $.CreatePanel("Panel", root, "MG_DkMid"); midRow.AddClass("mg-durak-mid");
        var leftZone = $.CreatePanel("Panel", midRow, "MG_DkLeft"); leftZone.AddClass("mg-durak-left");
        var stage = $.CreatePanel("Panel", midRow, "MG_DkStage"); stage.AddClass("mg-durak-stage");
        var rightZone = $.CreatePanel("Panel", midRow, "MG_DkRight"); rightZone.AddClass("mg-durak-right");
        // decor (deck stack, rotated trump, labels, open-slot hints) is rebuilt each refresh
        // and sits BEHIND the persistent card layer.
        var decorLayer = $.CreatePanel("Panel", stage, "MG_DkDecor"); decorLayer.AddClass("mg-dk-decor");
        var cardLayer = $.CreatePanel("Panel", stage, "MG_DkCards"); cardLayer.AddClass("mg-dk-cards");
        var controlsZone = $.CreatePanel("Panel", root, "MG_DkControls"); controlsZone.AddClass("mg-durak-controls");
        var zones = { top: topZone, left: leftZone, right: rightZone };

        var cardEls = {}; // card id -> persistent face panel on the stage

        function actionActor() { return st.phase === "defend" ? st.defender : st.attacker; }
        function myTurn() { return !destroyed && st.phase !== "over" && actionActor() === mySeat; }

        // ── slot geometry (stage coords) ──
        function xform(x, y, rot) {
            var t = "translate3d(" + Math.round(x) + "px, " + Math.round(y) + "px, 0px)";
            return rot ? (t + " rotateZ(" + rot + "deg)") : t;
        }
        function deckSlot() { return { x: 10, y: 84 }; }
        function trumpSlot() { return { x: 2, y: 108, rot: 90 }; } // rotated, poking out from under the stack
        // Hand fans across the bottom, centred in the stage (the deck is top-left, so no
        // horizontal conflict). Gentle upward bow + tiny per-card rotation reads as a hand.
        function handSlot(j, n) {
            var step = n > 1 ? Math.min(CARD_W * 0.66, (STAGE_W - 40 - CARD_W) / (n - 1)) : 0;
            var totalW = CARD_W + step * (n - 1);
            var x0 = (STAGE_W - totalW) / 2;
            var y0 = STAGE_H - CARD_H - 6;
            var mid = (n - 1) / 2, d = j - mid;
            var arc = Math.round((mid * mid - d * d) * 1.1);
            return { x: x0 + j * step, y: y0 - arc, rot: Math.round(d * 3) };
        }
        // Attack/defense pairs centred in the stage's upper-middle band.
        function tableAtkSlot(i, m) {
            var pairStep = CARD_W + 30;
            var totalW = CARD_W + pairStep * (m - 1);
            var x0 = (STAGE_W - totalW) / 2;
            return { x: x0 + i * pairStep, y: 92 };
        }
        function tableDefSlot(i, m) { var s = tableAtkSlot(i, m); return { x: s.x + 16, y: s.y + 26 }; }

        // ── decor + opponents (non-animated, rebuilt each refresh) ──
        function buildDecor() {
            decorLayer.RemoveAndDeleteChildren();
            if (st.deck.length > 0) {
                // trump first so the stack paints OVER it → it reads as tucked under the deck
                var ts = trumpSlot();
                var tc = $.CreatePanel("Panel", decorLayer, "");
                tc.AddClass("mg-dk-card"); tc.AddClass("mg-dk-trump");
                tc.style.backgroundImage = "url('" + cardFaceUrl(st.trumpCard) + "')";
                tc.style.transform = xform(ts.x, ts.y, ts.rot);
                var backs = Math.min(st.deck.length, 6);
                for (var i = 0; i < backs; i++) {
                    var b = $.CreatePanel("Panel", decorLayer, "");
                    b.AddClass("mg-dk-card"); b.AddClass("mg-dk-cardback");
                    b.style.transform = xform(deckSlot().x + i * 3, deckSlot().y - i * 3, 0);
                }
            }
            var lbl = $.CreatePanel("Label", decorLayer, "");
            lbl.AddClass("mg-dk-decklabel");
            lbl.style.transform = xform(6, deckSlot().y + CARD_H + 14, 0);
            lbl.text = "Deck " + st.deck.length + " · Trump " + SUIT_CHARS[st.trump];

            // open-slot hint behind each uncovered attack while I'm defending
            if (st.defender === mySeat && st.phase === "defend") {
                for (var t = 0; t < st.table.length; t++) {
                    if (st.table[t].d >= 0) continue;
                    var s = tableAtkSlot(t, st.table.length);
                    var hint = $.CreatePanel("Panel", decorLayer, "");
                    hint.AddClass("mg-dk-openslot");
                    hint.style.transform = xform(s.x - 4, s.y - 4, 0);
                }
            }
        }

        function buildOpponents() {
            topZone.RemoveAndDeleteChildren();
            leftZone.RemoveAndDeleteChildren();
            rightZone.RemoveAndDeleteChildren();
            for (var seat = 0; seat < numPlayers; seat++) {
                if (seat === mySeat) continue;
                var rel = (seat - mySeat + numPlayers) % numPlayers;
                var zone = zones[seatZone(rel, numPlayers)] || topZone;
                var opp = $.CreatePanel("Panel", zone, "");
                opp.AddClass("mg-opp");
                if (seat === st.attacker) opp.AddClass("mg-opp-atk");
                if (seat === st.defender) opp.AddClass("mg-opp-def");
                var lbl = $.CreatePanel("Label", opp, "");
                lbl.AddClass("mg-opp-label");
                var roleTag = seat === st.attacker ? " · ATK" : (seat === st.defender ? " · DEF" : "");
                lbl.text = nameOf(seat) + " (" + st.hands[seat].length + ")" + roleTag;
                var fan = $.CreatePanel("Panel", opp, "");
                fan.AddClass("mg-oppfan");
                var shown = Math.min(st.hands[seat].length, 8);
                for (var i = 0; i < shown; i++) {
                    var bk = $.CreatePanel("Panel", fan, "");
                    bk.AddClass("mg-opp-back");
                }
            }
        }

        // ── persistent card reconcile (the slide machinery) ──
        // Compute where every card I can SEE (my hand + everything on the table) should be,
        // then move existing panels to their new slot and create/destroy as needed.
        function computeWanted() {
            var wanted = [];
            var m = st.table.length, i;
            for (i = 0; i < m; i++) {
                var a = tableAtkSlot(i, m);
                wanted.push({ id: st.table[i].a, x: a.x, y: a.y, rot: 0, z: 40 + i * 2, playable: false });
                if (st.table[i].d >= 0) {
                    var dd = tableDefSlot(i, m);
                    wanted.push({ id: st.table[i].d, x: dd.x, y: dd.y, rot: 0, z: 41 + i * 2, playable: false });
                }
            }
            var myHand = st.hands[mySeat].slice();
            sortByValue(myHand, st.trump);
            var n = myHand.length;
            var canAct = myTurn(), play = {};
            if (canAct && st.phase === "attack" && st.attacker === mySeat) {
                var la = legalAttacks(st, mySeat);
                for (i = 0; i < la.length; i++) play[la[i]] = 1;
            }
            if (canAct && st.phase === "defend" && st.defender === mySeat) {
                for (i = 0; i < n; i++)
                    for (var t = 0; t < st.table.length; t++)
                        if (st.table[t].d < 0 && canDefendPair(st, t, myHand[i])) { play[myHand[i]] = 1; break; }
            }
            for (i = 0; i < n; i++) {
                var s = handSlot(i, n);
                wanted.push({ id: myHand[i], x: s.x, y: s.y, rot: s.rot, z: 100 + i, playable: !!play[myHand[i]] });
            }
            return wanted;
        }

        function ensureCard(w) {
            var el = cardEls[w.id];
            var target = xform(w.x, w.y, w.rot);
            if (!el) {
                el = $.CreatePanel("Panel", cardLayer, "");
                el.AddClass("mg-dk-card");
                el.style.backgroundImage = "url('" + cardFaceUrl(w.id) + "')";
                el.style.zIndex = String(w.z);
                var start = deckSlot();                 // new cards fly in from the deck
                el.style.transform = xform(start.x, start.y, 0);
                cardEls[w.id] = el;
                (function (elem, tgt) {
                    $.Schedule(0.0, function () {
                        if (elem && elem.IsValid && elem.IsValid()) { elem.AddClass("mg-dk-anim"); elem.style.transform = tgt; }
                    });
                })(el, target);
            } else {
                el.style.zIndex = String(w.z);
                el.style.transform = target;            // slides (already has .mg-dk-anim)
            }
            el.RemoveClass("mg-dk-playable");
            if (w.playable) {
                el.AddClass("mg-dk-playable");
                (function (cid) { el.SetPanelEvent("onactivate", function () { onHandCardClick(cid); }); })(w.id);
            } else {
                el.SetPanelEvent("onactivate", function () { });
            }
        }

        function animateOut(el) {
            try {
                el.AddClass("mg-dk-anim");
                el.style.opacity = "0.0";
                el.style.transform = xform(deckSlot().x, deckSlot().y, 0);
            } catch (e) { }
            try { el.DeleteAsync(0.25); } catch (e) { }
        }

        function buildControls() {
            controlsZone.RemoveAndDeleteChildren();
            var canAct = myTurn();
            if (canAct && st.phase === "attack" && st.attacker === mySeat && st.table.length > 0) {
                mkButton(controlsZone, "Бито (Done)", function () { if (myTurn()) { endBout(st, false); afterAction(); } });
            }
            if (canAct && st.phase === "defend" && st.defender === mySeat && st.table.length > 0) {
                mkButton(controlsZone, "Take (Беру)", function () { if (myTurn()) { endBout(st, true); afterAction(); } });
            }
        }

        function mkButton(parent, text, onClick) {
            var b = $.CreatePanel("Button", parent, "");
            b.AddClass("mg-btn");
            var l = $.CreatePanel("Label", b, ""); l.text = text;
            b.SetPanelEvent("onactivate", onClick);
            return b;
        }

        function render() {
            buildDecor();
            buildOpponents();
            var wanted = computeWanted();
            var wid = {};
            for (var k = 0; k < wanted.length; k++) wid[wanted[k].id] = 1;
            for (var id in cardEls) {
                if (cardEls.hasOwnProperty(id) && !wid[id]) { animateOut(cardEls[id]); delete cardEls[id]; }
            }
            for (var i = 0; i < wanted.length; i++) ensureCard(wanted[i]);
            buildControls();
        }

        // ── input ──
        function onHandCardClick(card) {
            if (!myTurn()) return;
            if (st.phase === "defend" && st.defender === mySeat) {
                // Cover the first open attack this card can beat (walk all open pairs).
                for (var t = 0; t < st.table.length; t++) {
                    if (st.table[t].d < 0 && canDefendPair(st, t, card)) { applyDefend(st, t, card); afterAction(); return; }
                }
                status("That card can't beat an open attack. Cover it or Take.");
                return;
            }
            if (st.phase === "attack" && st.attacker === mySeat) {
                if (canAttackWith(st, mySeat, card)) { applyAttack(st, mySeat, card); afterAction(); return; }
                status(st.table.length === 0 ? "Play a card to attack." : "Only a matching rank can be added.");
                return;
            }
        }

        // ── turn loop ──
        function promptFor() {
            if (st.phase === "defend" && st.defender === mySeat)
                return "Your defense — cover the attack(s) or Take.";
            if (st.attacker === mySeat && st.table.length === 0) return "Your turn — attack.";
            if (st.attacker === mySeat) return "Add a matching-rank card, or press Бито.";
            return "Waiting…";
        }

        function afterAction() {
            if (destroyed) return;
            render();
            if (checkOver(st)) { finishGame(); return; }
            var actor = actionActor();
            if (actor === mySeat) { status(promptFor()); return; }
            if (isBot) { status(nameOf(actor) + " is thinking…"); $.Schedule(0.55, botTurn); return; }
            // Stage 2 (online): poll the public log here.
            status(nameOf(actor) + "'s turn…");
        }

        function botTurn() {
            if (destroyed || st.phase === "over") return;
            var actor = actionActor();
            if (actor === mySeat) { afterAction(); return; }
            if (!isBot) return;
            if (st.phase === "defend") {
                var d = durakBotDefend(st, st.defender);
                if (d) applyDefend(st, d.pair, d.card);
                else endBout(st, true);
            } else {
                var c = durakBotAttack(st, st.attacker);
                if (c >= 0) applyAttack(st, st.attacker, c);
                else if (st.table.length > 0) endBout(st, false);
                else { /* opener always has a legal card; nothing to do */ }
            }
            afterAction();
        }

        function finishGame() {
            render();
            if (st.loser < 0) status("Draw — nobody is the fool!");
            else if (st.loser === mySeat) status("You are the fool (durak). 🙃");
            else status(nameOf(st.loser) + " is the fool! 🏆");
        }

        // ── boot ──
        render();
        if (myTurn()) status(promptFor());
        else if (isBot) { status(nameOf(actionActor()) + " is thinking…"); $.Schedule(0.55, botTurn); }
        else status(nameOf(actionActor()) + "'s turn…");

        return {
            destroy: function () { destroyed = true; try { root.DeleteAsync(0); } catch (e) {} }
        };
    }

    if (MG.Games && MG.Games.register) {
        MG.Games.register({ id: 3, enabled: true, create: createDurak });
    }
})();
