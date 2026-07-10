"use strict";

/*
 * mg_durak.js — "Durak" (Podkidnoy durak) for the Deadlock Minigames mod.
 *
 * Stage 1 (this file, for now): OFFLINE play vs bot(s). No server calls at all — the
 * whole deck/deal/rules run locally, exactly like the other games' bot mode. Online
 * 2-4 player play (worker as authoritative dealer + per-seat private deal channel) is
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

    // ── durak: pure rules ──────────────────────────────────────────────────────────
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

    // table queries
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

    // mutators
    function applyAttack(st, seat, card) {
        removeCard(st.hands[seat], card);
        st.table.push({ a: card, d: -1 });
        st.phase = "defend";
    }
    function applyDefend(st, pairIndex, card) {
        removeCard(st.hands[st.defender], card);
        st.table[pairIndex].d = card;
        if (uncoveredCount(st) === 0) st.phase = "attack"; // hand back to the attacker (add or Bito)
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
    // is "beaten" (Bito) and discarded. Then refill and rotate roles.
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

    // bot
    // Trumps sort far above non-trumps so the bot spends its cheapest, non-trump cards first.
    function cardValue(id, trump) { return rankOf(id) + (suitOf(id) === trump ? 100 : 0); }
    function sortByValue(arr, trump) {
        arr.sort(function (a, b) { return cardValue(a, trump) - cardValue(b, trump); });
        return arr;
    }
    // Returns the card to attack/throw-in with, or -1 to end the bout (Bito).
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

    // ── durak controller ───────────────────────────────────────────────────────────
    // Panorama rendering, input and the offline bot loop. NONE of this is verifiable from
    // a shell — it only runs inside Deadlock after a VPK repack. Reasoned from the game's
    // CSS idioms + the other controllers in mg_games.js, not confirmed in-game.

    var DECK_DIR = "s2r://panorama/images/deck/";
    function cardFaceUrl(id) { return DECK_DIR + SUIT_CHARS[suitOf(id)] + RANK_CHARS[rankOf(id)] + ".vtex"; }
    // Always build the CSS url() string ourselves. NEVER read it back off style.backgroundImage:
    // Panorama returns it UNQUOTED (`url( s2r://... )`), and re-assigning that throws
    // "Invalid value for property 'background-image'" — which used to abort DragStart and leak
    // orphaned "phantom" ghost cards. We stash the quoted string on the panel (`_dkFace`).
    function faceCss(id) { return "url('" + cardFaceUrl(id) + "')"; }

    // Where each opponent sits on MY screen, given their offset from me around the table.
    // Everyone renders themselves at the bottom; opponents are placed by relative seat, so
    // "left" for one player is "right" for another. 3/4-player layouts are only exercised
    // online (Stage 2).
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
    var CARD_W = 100, CARD_H = 140;
    var STAGE_W = 680, STAGE_H = 500;

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

        // EVERYTHING — the opponents' avatar tiles, the deck+trump, the attack/defense pairs
        // and MY hand — lives on ONE flow-children:none felt STAGE (fixed size), so a card can
        // slide anywhere across it and the players sit ON the felt. The stage never resizes, so
        // playing a card can't make the modal "jump".
        var stage = $.CreatePanel("Panel", root, "MG_DkStage"); stage.AddClass("mg-durak-stage");
        var decorLayer = $.CreatePanel("Panel", stage, "MG_DkDecor"); decorLayer.AddClass("mg-dk-decor");
        var cardLayer = $.CreatePanel("Panel", stage, "MG_DkCards"); cardLayer.AddClass("mg-dk-cards");
        // Controls sit in their OWN fixed-height row below the stage (.mg-durak-controls reserves
        // the button height whether or not a button is showing) so toggling Take/Done never
        // reflows the modal.
        var controlsZone = $.CreatePanel("Panel", root, "MG_DkControls"); controlsZone.AddClass("mg-durak-controls");

        var cardEls = {}; // card id -> persistent face panel on the stage

        function actionActor() { return st.phase === "defend" ? st.defender : st.attacker; }
        function myTurn() { return !destroyed && st.phase !== "over" && actionActor() === mySeat; }

        // slot geometry (stage coords)
        function xform(x, y, rot) {
            var t = "translate3d(" + Math.round(x) + "px, " + Math.round(y) + "px, 0px)";
            return rot ? (t + " rotateZ(" + rot + "deg)") : t;
        }
        // Deck stack on the LEFT, at the table row's height. The trump card sits UPRIGHT just
        // to the RIGHT of the stack and MOSTLY visible (only its left edge tucked under the
        // deck), so its suit reads clearly. NO rotation — rotateZ was the source of the "300%
        // scale" trump glitch and sometimes culled the card off-screen entirely.
        var DECK_X = 32, DECK_Y = 150;
        function deckSlot() { return { x: DECK_X, y: DECK_Y }; }
        // Trump lies HORIZONTAL (rotateZ 90) UNDER the deck via a wrapper (translate) + inner
        // card (rotateZ only in CSS .mg-dk-trump). NEVER translate3d+rotateZ in one inline
        // string: that mix was the "300% scale" + off-screen-cull glitch (scale3d trap family).
        function trumpSlot() { return { x: DECK_X + 46, y: DECK_Y + 20 }; }
        // Big deck-count number centred BELOW the stack (not cramped against its side).
        function deckCountSlot() { return { x: DECK_X + 30, y: DECK_Y + CARD_H + 10 }; }
        // A card an opponent PLAYS glides in from the top-centre (where they sit); a drawn HAND
        // card glides from the deck.
        function oppOriginSlot() { return { x: STAGE_W / 2 - CARD_W / 2, y: 60 }; }
        // Hand: a clean FLAT row (no arc, no tilt), CENTRED on the stage centre (STAGE_W/2).
        function handSlot(j, n) {
            var step = n > 1 ? Math.min(64, 380 / (n - 1)) : 0;
            var totalW = CARD_W + step * (n - 1);
            var x0 = STAGE_W / 2 - totalW / 2;
            var y0 = STAGE_H - CARD_H - 16;
            return { x: x0 + j * step, y: y0, rot: 0 };
        }
        // Attack/defense pairs centred in the felt's middle band (centre x = STAGE_W/2), clear
        // of the deck/trump column on the left and well below the top opponent tile.
        var TABLE_CX = STAGE_W / 2, TABLE_ATK_Y = 178;
        function tableAtkSlot(i, m) {
            var pairStep = Math.min(CARD_W + 30, (460 - CARD_W) / Math.max(m - 1, 1));
            var totalW = CARD_W + pairStep * (m - 1);
            var x0 = TABLE_CX - totalW / 2;
            return { x: x0 + i * pairStep, y: TABLE_ATK_Y };
        }
        function tableDefSlot(i, m) { var s = tableAtkSlot(i, m); return { x: s.x + 18, y: s.y + 34 }; }

        // decor + opponents (non-animated, rebuilt each refresh)
        function buildDecor() {
            decorLayer.RemoveAndDeleteChildren();
            if (st.deck.length > 0) {
                // trump first so the stack paints OVER its left edge → it reads as coming out
                // from under the deck
                var ts = trumpSlot();
                var twrap = $.CreatePanel("Panel", decorLayer, "");
                twrap.AddClass("mg-dk-trump-wrap");
                twrap.style.transform = xform(ts.x, ts.y, 0);
                var tc = $.CreatePanel("Panel", twrap, "");
                tc.AddClass("mg-dk-card"); tc.AddClass("mg-dk-trump");
                tc.style.backgroundImage = faceCss(st.trumpCard);
                var backs = Math.min(st.deck.length, 6);
                for (var i = 0; i < backs; i++) {
                    var b = $.CreatePanel("Panel", decorLayer, "");
                    b.AddClass("mg-dk-card"); b.AddClass("mg-dk-cardback");
                    b.style.transform = xform(deckSlot().x + i * 2, deckSlot().y - i * 2, 0);
                }
                // Big remaining-deck count below the stack.
                var dc = deckCountSlot();
                var lbl = $.CreatePanel("Label", decorLayer, "");
                lbl.AddClass("mg-dk-deckcount");
                lbl.style.transform = xform(dc.x, dc.y, 0);
                lbl.text = String(st.deck.length);
            }

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

        // Avatar tiles sit ON the felt: a rounded tile with the player's initial, a role RING
        // (red = attacker, blue = defender), a hand-COUNT badge, and a NEAT little stack of card
        // backs behind opponents. My own tile is bottom-LEFT (balancing the top opponent and
        // clear of my centred hand); opponents by relative seat.
        var AV = 64;
        function avatarCenter(zone) {
            if (zone === "left") return { x: 66, y: STAGE_H * 0.44 };
            if (zone === "right") return { x: STAGE_W - 66, y: STAGE_H * 0.44 };
            return { x: STAGE_W / 2, y: 46 };               // top
        }
        // A neat, tightly-overlapped stack of backs behind a tile (gentle 3° fan, not scattered).
        function buildBackBunch(center, count) {
            var shown = Math.min(count, 4);
            if (shown <= 0) return;
            var mid = (shown - 1) / 2;
            for (var i = 0; i < shown; i++) {
                var d = i - mid;
                var bk = $.CreatePanel("Panel", decorLayer, "");
                bk.AddClass("mg-dk-card"); bk.AddClass("mg-opp-back");
                bk.style.transform = xform(center.x - 27 + d * 7, center.y - 22, Math.round(d * 3));
            }
        }
        function buildTile(seat, center) {
            var isMe = seat === mySeat;
            var tile = $.CreatePanel("Panel", decorLayer, "");
            tile.AddClass("mg-opp-tile");
            if (isMe) tile.AddClass("mg-opp-me");
            if (seat === st.attacker) tile.AddClass("mg-opp-atk");
            if (seat === st.defender) tile.AddClass("mg-opp-def");
            tile.style.transform = xform(center.x - AV / 2, center.y - AV / 2, 0);
            var av = $.CreatePanel("Panel", tile, "");
            av.AddClass("mg-opp-avatar");
            var ini = $.CreatePanel("Label", av, "");
            ini.AddClass("mg-opp-initial");
            ini.text = isMe ? "You" : (isBot ? "B" + seat : "P" + (seat + 1));
            var name = $.CreatePanel("Label", tile, "");
            name.AddClass("mg-opp-name");
            name.text = nameOf(seat);
            var badge = $.CreatePanel("Panel", tile, "");
            badge.AddClass("mg-opp-badge");
            var bl = $.CreatePanel("Label", badge, "");
            bl.AddClass("mg-opp-badgenum");
            bl.text = String(st.hands[seat].length);
        }
        function buildOpponents() {
            for (var seat = 0; seat < numPlayers; seat++) {
                var center;
                if (seat === mySeat) {
                    // Bottom-left corner: well away from the centred hand and mirrors the top
                    // opponent tile so the table reads symmetrically.
                    center = { x: 60, y: STAGE_H - 54 };
                } else {
                    var rel = (seat - mySeat + numPlayers) % numPlayers;
                    center = avatarCenter(seatZone(rel, numPlayers));
                    buildBackBunch(center, st.hands[seat].length);   // opponents' hands are hidden
                }
                buildTile(seat, center);
            }
        }

        // persistent card reconcile (the slide machinery)
        function computeWanted() {
            var wanted = [];
            var m = st.table.length, i;
            for (i = 0; i < m; i++) {
                var a = tableAtkSlot(i, m);
                wanted.push({ id: st.table[i].a, x: a.x, y: a.y, rot: 0, z: 40 + i * 2, playable: false, table: true });
                if (st.table[i].d >= 0) {
                    var dd = tableDefSlot(i, m);
                    wanted.push({ id: st.table[i].d, x: dd.x, y: dd.y, rot: 0, z: 41 + i * 2, playable: false, table: true });
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
                el._dkFace = faceCss(w.id);                 // stash the QUOTED url for the ghost
                el.style.backgroundImage = el._dkFace;
                el.style.zIndex = String(w.z);
                // A brand-new TABLE card was just played by an opponent → glide it in from the
                // top-centre. A new HAND card is one I drew → glide from the deck.
                var start = w.table ? oppOriginSlot() : deckSlot();
                el.style.transform = xform(start.x, start.y, 0);
                cardEls[w.id] = el;
                bindCardDrag(el, w.id);
                (function (elem, tgt) {
                    $.Schedule(0.0, function () {
                        if (elem && elem.IsValid && elem.IsValid()) { elem.AddClass("mg-dk-anim"); elem.style.transform = tgt; }
                    });
                })(el, target);
            } else {
                el.style.zIndex = String(w.z);
                el.style.transform = target;            // slides (already has .mg-dk-anim)
            }
            el._dkCard = w.id;
            el._dkPlayable = !!w.playable;
            try { el.SetDraggable(!!w.playable); } catch (e) {}
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

        // drag-and-drop (pick a hand card up, drop it on the table)
        // Reuses the proven QOLLOCK/checkers recipe: drag a throwaway GHOST (not the real
        // card), then on release read the ghost's absolute WINDOW position (the only channel
        // that survives the engine culling the ghost out of layout — see ARCHITECTURE §7) and
        // map it into stage coords to decide the drop target. Click-to-play still works.
        function winPos(panel) {
            if (!panel || !panel.GetPositionWithinWindow) return null;
            var r; try { r = panel.GetPositionWithinWindow(); } catch (e) { return null; }
            if (!r) return null;
            var x = (typeof r.x === "number") ? r.x : (typeof r[0] === "number" ? r[0] : null);
            var y = (typeof r.y === "number") ? r.y : (typeof r[1] === "number" ? r[1] : null);
            if (x === null || y === null || !isFinite(x) || !isFinite(y)) return null;
            if (Math.abs(x) > 100000 || Math.abs(y) > 100000) return null; // FLT_MAX sentinel
            return { x: x, y: y };
        }
        function stagePointFromGhost(ghost) {
            var lp = winPos(cardLayer), gp = winPos(ghost);
            if (!lp || !gp) return null;
            var layerW = (cardLayer && isFinite(cardLayer.actuallayoutwidth) && cardLayer.actuallayoutwidth > 0)
                ? cardLayer.actuallayoutwidth : STAGE_W;
            var scale = layerW / STAGE_W;
            var gw = (ghost && isFinite(ghost.actuallayoutwidth) && ghost.actuallayoutwidth > 0
                      && ghost.actuallayoutwidth < 100000) ? ghost.actuallayoutwidth : CARD_W * scale;
            var gh = (ghost && isFinite(ghost.actuallayoutheight) && ghost.actuallayoutheight > 0
                      && ghost.actuallayoutheight < 100000) ? ghost.actuallayoutheight : CARD_H * scale;
            var cx = gp.x + gw / 2, cy = gp.y + gh / 2;
            return { x: (cx - lp.x) / scale, y: (cy - lp.y) / scale };
        }
        // The felt "drop zone" is everything ABOVE the hand row. A release BELOW this line means
        // "I changed my mind" (or a fat-fingered miss) → the card just snaps back to the hand and
        // NO move is committed. This is exactly the "return to hand on miss/cancel" behaviour that
        // was missing: previously a defend was applied no matter where you let go.
        var DROP_ZONE_MAX_Y = STAGE_H - CARD_H - 30;
        function commitDrop(card, ghost) {
            if (!myTurn()) return;
            var pt = stagePointFromGhost(ghost);
            if (!pt) return;                            // can't read the drop -> snap back
            if (pt.y >= DROP_ZONE_MAX_Y) return;        // dropped back over the hand -> cancel, snap back
            if (st.phase === "defend" && st.defender === mySeat) {
                // Cover the nearest UNCOVERED pair this card can beat, but ONLY if the drop
                // actually landed near that pair (within ~1.4 card widths). A miss snaps back.
                var m = st.table.length, best = -1, bestDx = 1e9;
                for (var t = 0; t < m; t++) {
                    if (st.table[t].d >= 0 || !canDefendPair(st, t, card)) continue;
                    var sx = tableAtkSlot(t, m).x + CARD_W / 2;
                    var dx = Math.abs(pt.x - sx);
                    if (dx < bestDx) { bestDx = dx; best = t; }
                }
                if (best >= 0 && bestDx <= CARD_W * 1.4) { applyDefend(st, best, card); afterAction(); }
                // else: no reachable pair under the drop -> snap back silently (a miss shouldn't nag)
                return;
            }
            if (st.phase === "attack" && st.attacker === mySeat) {
                if (canAttackWith(st, mySeat, card)) { applyAttack(st, mySeat, card); afterAction(); }
                // else: illegal card dropped on the felt -> snap back silently
                return;
            }
        }
        function bindCardDrag(el, cid) {
            $.RegisterEventHandler("DragStart", el, function (_p, dragEvent) {
                if (!el._dkPlayable || !myTurn()) return;
                var ghost = $.CreatePanel("Panel", cardLayer, "");
                ghost.AddClass("mg-dk-card"); ghost.AddClass("mg-dk-dragging");
                ghost.style.backgroundImage = el._dkFace;   // reuse the stashed quoted url (never read it back off style)
                ghost.style.zIndex = "900";
                try { ghost.SetAttributeString("hittest", "false"); } catch (e) {}
                dragEvent.displayPanel = ghost;
                dragEvent.removePositionBeforeDrop = false;
                ghost.style.align = "left top";         // engine positions the ghost under the cursor
                el._dkGhost = ghost;
                el.AddClass("mg-dk-drag-source");
            });
            $.RegisterEventHandler("DragEnd", el, function () {
                var ghost = el._dkGhost;
                try { commitDrop(el._dkCard, ghost); } catch (e) {}
                if (ghost) { try { ghost.DeleteAsync(0); } catch (e2) {} }
                el._dkGhost = null;
                el.RemoveClass("mg-dk-drag-source");
            });
        }

        function buildControls() {
            controlsZone.RemoveAndDeleteChildren();
            var canAct = myTurn();
            if (canAct && st.phase === "attack" && st.attacker === mySeat && st.table.length > 0) {
                mkButton(controlsZone, "Bito (Pass)", function () { if (myTurn()) { endBout(st, false); afterAction(); } });
            }
            if (canAct && st.phase === "defend" && st.defender === mySeat && st.table.length > 0) {
                mkButton(controlsZone, "Take", function () { if (myTurn()) { endBout(st, true); afterAction(); } });
            }
        }

        function mkButton(parent, text, onClick) {
            var b = $.CreatePanel("Button", parent, "");
            b.AddClass("mg-btn"); b.AddClass("mg-btn-primary"); b.AddClass("mg-dk-action");
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

        // input
        function onHandCardClick(card) {
            if (!myTurn()) return;
            if (st.phase === "defend" && st.defender === mySeat) {
                for (var t = 0; t < st.table.length; t++) {
                    if (st.table[t].d < 0 && canDefendPair(st, t, card)) { applyDefend(st, t, card); afterAction(); return; }
                }
                status("That card can't beat an open attack. Cover it or take.");
                return;
            }
            if (st.phase === "attack" && st.attacker === mySeat) {
                if (canAttackWith(st, mySeat, card)) { applyAttack(st, mySeat, card); afterAction(); return; }
                status(st.table.length === 0 ? "Play a card to attack." : "Only a matching rank can be added.");
                return;
            }
        }

        // turn loop
        function promptFor() {
            if (st.phase === "defend" && st.defender === mySeat)
                return "Your defense. Cover the attacks or take.";
            if (st.attacker === mySeat && st.table.length === 0) return "Your turn. Attack.";
            if (st.attacker === mySeat) return "Add a matching-rank card, or press Bito.";
            return "Waiting.";
        }

        function afterAction() {
            if (destroyed) return;
            render();
            if (checkOver(st)) { finishGame(); return; }
            var actor = actionActor();
            if (actor === mySeat) { status(promptFor()); return; }
            if (isBot) { status(nameOf(actor) + " is thinking..."); $.Schedule(0.55, botTurn); return; }
            // Stage 2 (online): poll the public log here.
            status(nameOf(actor) + "'s turn...");
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
            if (st.loser < 0) status("Draw.");
            else if (st.loser === mySeat) status("You lose.");
            else status("You win.");
        }

        // boot
        render();
        if (myTurn()) status(promptFor());
        else if (isBot) { status(nameOf(actionActor()) + " is thinking..."); $.Schedule(0.55, botTurn); }
        else status(nameOf(actionActor()) + "'s turn...");

        return {
            destroy: function () { destroyed = true; try { root.DeleteAsync(0); } catch (e) {} }
        };
    }

    if (MG.Games && MG.Games.register) {
        MG.Games.register({ id: 3, enabled: true, create: createDurak });
    }
})();
