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

    // ── durak: shared pure rules (single source of truth: rules/durak.js) ──────────
    // The engine now lives in rules/durak.js (loaded before this file and shared
    // byte-for-byte with the authoritative server dealer). Here we just bind local names
    // identical to the old inline copies so the controller below is untouched.
    // tools/mg_durak_test.js now tests rules/durak.js directly (no more slicing this file).
    var D = MG.Rules.durak;
    var SUIT_CHARS = D.SUIT_CHARS, RANK_CHARS = D.RANK_CHARS, DECK_SIZE = D.DECK_SIZE;
    var suitOf = D.suitOf, rankOf = D.rankOf, makeRng = D.makeRng, freshDeck = D.freshDeck, deal = D.deal;
    var beats = D.beats, newGame = D.newGame, nextInPlay = D.nextInPlay;
    var uncoveredCount = D.uncoveredCount, firstUncovered = D.firstUncovered;
    var canAttackWith = D.canAttackWith, legalAttacks = D.legalAttacks;
    var canDefendPair = D.canDefendPair, legalDefends = D.legalDefends;
    var applyAttack = D.applyAttack, applyDefend = D.applyDefend, endBout = D.endBout, checkOver = D.checkOver;
    var sortByValue = D.sortByValue, cardValue = D.cardValue;
    var durakBotAttack = D.durakBotAttack, durakBotDefend = D.durakBotDefend;

    // ── durak controller ───────────────────────────────────────────────────────────
    // Panorama rendering, input and the offline bot loop. NONE of this is verifiable from
    // a shell — it only runs inside Deadlock after a VPK repack. Reasoned from the game's
    // CSS idioms + the other controllers in mg_games.js, not confirmed in-game.

    var DECK_DIR = "s2r://panorama/images/deck/";
    function cardFaceUrl(id) { return DECK_DIR + SUIT_CHARS[suitOf(id)] + RANK_CHARS[rankOf(id)] + ".vtex"; }
    var BACK_URL = DECK_DIR + "BACK.vtex";
    // Draw a card face/back with a CHILD <Image> (SetImage + scaling), NOT the container's
    // style.backgroundImage. A Panel background paints the .vtex at its NATIVE pixel size
    // (367×512) until the panel is re-laid-out, which is the ~300% first-frame zoom on the
    // trump / hand / opponent backs. An <Image> fills its CSS box from frame 1 (game idiom:
    // hud_ability_icon.xml, QOLLOCK ArcadeFlappyBird). SetImage takes the BARE s2r:// url.
    // The container keeps ALL of its state (transform slide, .mg-dk-anim, .mg-dk-trump
    // rotateZ, playable frame); the Image just fills it and is transparent to input, so drag
    // hit-testing still lands on the card panel.
    function setFace(container, url) {
        var img = container._faceImg;
        if (!img) {
            img = $.CreatePanel("Image", container, "", { scaling: "stretch-to-fit-preserve-aspect" });
            img.AddClass("mg-face-img");
            try { img.SetAttributeString("hittest", "false"); } catch (e) {}
            container._faceImg = img;
        }
        img.SetImage(url);
    }
    function setBack(container) { setFace(container, BACK_URL); }

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
        // Online (worker-as-dealer) vs offline (local deck+bot). Online, the server OWNS the
        // deck/hands/seed: this client learns the table/trump/roles/counts from the public
        // /api/dlog event stream and its OWN card identities from the private /api/ddraw
        // channel. It never sees the deck or a foreign hand. Offline, everything runs locally
        // exactly as before.
        var online = !isBot && !!session.code && !!(MG.Api && MG.Api.dlog);
        var seed = (session.seed != null) ? session.seed : ((Math.random() * 0x7fffffff) | 0);
        var st = online ? emptyOnlineState(numPlayers) : newGame(numPlayers, seed);
        var destroyed = false;

        // ── online sync state ──────────────────────────────────────────────────────
        // logSeq = next public event index to fetch; drawCursor[seat] = next private card
        // index already pulled for a seat (only MY cursor pulls real ids via ddraw, opponents
        // just get placeholder count). pendingAct blocks input between send and the echo.
        var logSeq = 0, drawCursor = [], pendingAct = false, pendingDraws = 0, gameOver = false;
        // Poll GENERATION guard (same idiom as checkers/chess pollToken). Every pollLoop chain
        // captures the current pollGen; a stale chain bails the moment pollGen moves. Without it
        // a `sendAct` success that kicks pollLoop() while a prior `$.Schedule(0.6, pollLoop)` is
        // still pending gives TWO concurrent loops sharing logSeq — they double-apply one event
        // and skip the next (an opponent's card silently vanishes; dealing corrupts the state).
        var pollGen = 0;
        var deckRemaining = DECK_SIZE;   // 36 minus every card drawn (client can't see the deck, only count it)
        for (var _s = 0; _s < numPlayers; _s++) drawCursor.push(0);


        // A fresh online state: unknown trump/deck yet, empty hands (opponents get placeholder
        // sentinels so their COUNT badges + back-bunches render; my hand fills from ddraw).
        function emptyOnlineState(N) {
            var s = { numPlayers: N, trump: -1, trumpCard: -1, deck: [], hands: [], table: [],
                      attacker: 0, defender: 1 % N, phase: "attack", discard: 0, out: [], loser: -1 };
            for (var i = 0; i < N; i++) { s.hands.push([]); s.out.push(false); }
            return s;
        }
        // The client can't see the real deck, but it can COUNT it: 36 cards minus every card
        // drawn (DRAW events) that isn't the face-up trump. We keep a placeholder array so the
        // deck stack + count render; length is all render() ever reads.
        function setDeckCount(n) {
            var arr = [];
            for (var i = 0; i < n; i++) arr.push(-1);
            st.deck = arr;
        }
        // Placeholder id for a hidden opponent card (never rendered as a face — opponents only
        // show back-bunches + a count badge).
        var HIDDEN = -1;


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

        // One-shot hint for the NEXT render's animateOut: when a bout ends by TAKE, the table cards
        // don't just leave — they go into the TAKER's hand. render() is a stateless reconcile, so
        // without this it would fling every de-"wanted" card to the deck and delete it, and a bot's
        // (or online opponent's) taken cards LOOK like they vanish (they're actually in the hidden
        // hand — the count badge grows). boutTakeSeat routes those cards to that seat's hand origin
        // instead. Cleared after each render. -1 = normal (fly to deck: draws leaving, Bito discard).
        var boutTakeSeat = -1;

        function actionActor() { return st.phase === "defend" ? st.defender : st.attacker; }
        function myTurn() { return !destroyed && st.phase !== "over" && actionActor() === mySeat; }
        // Can I initiate an ATTACK / THROW-IN via input right now?
        //  • offline (always 2p heads-up here): only when it's my turn as the primary attacker —
        //    identical to the pre-4-player behaviour, so no heads-up regression.
        //  • online (2–4 seats): ANY in-play non-defender may throw in a legal card at any time
        //    (the defining podkidnoy mechanic). The server serialises simultaneous throw-ins and
        //    rejects a now-illegal one, which sendAct() surfaces gracefully. legalAttacks() gates
        //    which cards actually qualify; this only governs whether input is live at all.
        function canAttackInput() {
            if (destroyed || pendingAct || st.phase === "over") return false;
            if (online) return mySeat !== st.defender;
            return myTurn() && st.phase === "attack" && st.attacker === mySeat;
        }
        function canDefendInput() {
            return myTurn() && st.phase === "defend" && st.defender === mySeat && !pendingAct;
        }

        // slot geometry (stage coords)
        function xform(x, y, rot) {
            var t = "translate3d(" + Math.round(x) + "px, " + Math.round(y) + "px, 0px)";
            return rot ? (t + " rotateZ(" + rot + "deg)") : t;
        }
        // Deck stack on the LEFT, at the table row's height. The trump card lies UNDER the deck,
        // rotated 90° (see trumpSlot + .mg-dk-trump), with its right half poking clear so the suit
        // reads. ⚠ The old "300% scale" trump glitch was NOT the rotation — it was a Panel
        // background painting the undecoded .vtex at native px on frame 1. Fixed by drawing the
        // face with a child <Image> (setFace) that sizes to its CSS box. The rotation is correct
        // and stays (it's on the container; the Image fills it).
        var DECK_X = 32, DECK_Y = 150;
        function deckSlot() { return { x: DECK_X, y: DECK_Y }; }
        // Trump lies HORIZONTAL (rotateZ 90) UNDER the deck via a wrapper (translate) + inner
        // card (rotateZ only in CSS .mg-dk-trump). NEVER translate3d+rotateZ in one inline
        // string: mixing them multiplies the translate offset and hurls the card off-screen
        // (the scale3d trap family). Keep the translate on the wrapper, the rotate on the inner.
        function trumpSlot() { return { x: DECK_X + 46, y: DECK_Y + 20 }; }
        // Big deck-count number centred BELOW the stack (not cramped against its side).
        function deckCountSlot() { return { x: DECK_X + 30, y: DECK_Y + CARD_H + 10 }; }
        // A card an opponent PLAYS glides in from the top-centre (where they sit); a drawn HAND
        // card glides from the deck.
        function oppOriginSlot() { return { x: STAGE_W / 2 - CARD_W / 2, y: 60 }; }
        // Where a given seat's HAND lives on the felt — the point taken cards should fly TO when
        // that seat picks up the table. Mirrors buildOpponents' placement (me bottom-centre, top
        // opponent top-centre, side opponents at their avatar). Card-corner coords (top-left), so
        // it lines up with the card transforms in ensureCard/animateOut.
        function seatHandSlot(seat) {
            if (seat === mySeat) return { x: STAGE_W / 2 - CARD_W / 2, y: STAGE_H - CARD_H - 16 };
            var rel = (seat - mySeat + numPlayers) % numPlayers;
            var zone = seatZone(rel, numPlayers);
            if (zone === "top") return { x: STAGE_W / 2 - CARD_W / 2, y: 60 - CARD_H / 2 };
            var c = avatarCenter(zone);
            return { x: c.x - CARD_W / 2, y: c.y - CARD_H / 2 };
        }
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
        // ⚠ TABLE_ATK_Y math (STAGE_H 500, CARD_H 140): a defence card sits at atk+34, so its
        // BOTTOM = TABLE_ATK_Y + 34 + 140. My hand top = 500 − 140 − 16 = 344. At the old 178 the
        // defence bottom was 352 → it overlapped my hand by ~8px ("карты в середине лезут на мои").
        // 150 → defence bottom 324 (20px gap above the hand) while the attack top still clears the
        // top opponent tile (~110) by 40px.
        var TABLE_CX = STAGE_W / 2, TABLE_ATK_Y = 150;
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
                setFace(tc, cardFaceUrl(st.trumpCard));
                var backs = Math.min(st.deck.length, 6);
                for (var i = 0; i < backs; i++) {
                    var b = $.CreatePanel("Panel", decorLayer, "");
                    b.AddClass("mg-dk-card"); b.AddClass("mg-dk-cardback");
                    setBack(b);
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
        // A FLAT horizontal row of backs behind an opponent tile — mirrors MY hand (handSlot:
        // rot 0, a plain left-to-right row), per the maintainer. The old version stepped only 7px
        // (cards 54px wide → heavy overlap) AND rotateZ'd each by 3°, so the backs read as a
        // tilted VERTICAL pile instead of a hand.
        // Show EVERY card, not a cap of 6 — a defender who takes the table can hold 10+, and the old
        // 6-cap made the backs disagree with the count badge (maintainer 2026-07-18: "bot only ever
        // draws 6"). Like the real hand (handSlot), the step COMPRESSES as the count grows so the row
        // stays within a bounded width instead of running off the felt.
        function buildBackBunch(center, count) {
            if (count <= 0) return;
            var BK_W = 54;
            var MAX_ROW = 170;                  // widest the back row is allowed to get
            // Same shape as handSlot's spacing: cap the per-card step, but shrink it to fit MAX_ROW
            // once there are enough cards that the natural 30px step would overflow.
            var step = count > 1 ? Math.min(30, (MAX_ROW - BK_W) / (count - 1)) : 0;
            var totalW = BK_W + step * (count - 1);
            var x0 = center.x - totalW / 2;
            var y = center.y - 76 / 2;          // vertically centred on the tile
            for (var i = 0; i < count; i++) {
                var bk = $.CreatePanel("Panel", decorLayer, "");
                bk.AddClass("mg-opp-back");
                bk.style.zIndex = String(i);    // later cards paint on top → clean left-to-right fan
                setBack(bk);
                bk.style.transform = xform(x0 + i * step, y, 0);   // flat row, no tilt
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
                if (seat === mySeat) {
                    // Bottom-left corner: well away from the centred hand and mirrors the top
                    // opponent tile so the table reads symmetrically.
                    buildTile(seat, { x: 60, y: STAGE_H - 54 });
                    continue;
                }
                var rel = (seat - mySeat + numPlayers) % numPlayers;
                var zone = seatZone(rel, numPlayers);
                if (zone === "top") {
                    // Mirror MY side: the hand (a flat centred row of backs) at the top-centre,
                    // the avatar TILE off to the top-LEFT so it never sits over the middle of the
                    // row (exactly how "You" is bottom-left with my hand centred). The old code put
                    // the tile AND the pile at the same top-centre point, so the avatar landed on
                    // the backs and the tightly-tilted pile read as a vertical stack.
                    buildBackBunch({ x: STAGE_W / 2, y: 60 }, st.hands[seat].length);
                    buildTile(seat, { x: 60, y: 54 });
                } else {
                    var center = avatarCenter(zone);
                    buildBackBunch(center, st.hands[seat].length);   // opponents' hands are hidden
                    buildTile(seat, center);
                }
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
            var play = {};
            // Attacks / throw-ins: ANY in-play non-defender can play a legal attack card — the
            // opener when the table's empty, or a matching-rank throw-in otherwise (the heart of
            // 3–4-player podkidnoy). legalAttacks() encodes every rule (rank on table, table not
            // full, never more uncovered than the defender can cover), so we needn't re-gate on
            // "am I the attacker". In a 2-player game the only non-defender IS the attacker, so
            // this collapses to the old behaviour (no regression to heads-up play).
            if (st.phase !== "over" && mySeat !== st.defender) {
                var la = legalAttacks(st, mySeat);
                for (i = 0; i < la.length; i++) play[la[i]] = 1;
            }
            if (st.phase === "defend" && st.defender === mySeat) {
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
                setFace(el, cardFaceUrl(w.id));
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

        // A card leaving the "wanted" set flies away and is deleted. Destination: normally the deck
        // (a Bito discard, or the odd stale card), but when the bout ended by TAKE it flies to the
        // TAKER's hand instead (boutTakeSeat) so a pickup reads as "these cards go to that player",
        // not "into the void". Table cards only — a hand card that merely re-slots keeps its element.
        function animateOut(el, toTake) {
            var dst = (toTake && boutTakeSeat >= 0) ? seatHandSlot(boutTakeSeat) : deckSlot();
            try {
                el.AddClass("mg-dk-anim");
                el.style.opacity = "0.0";
                el.style.transform = xform(dst.x, dst.y, 0);
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
            if (pendingAct || st.phase === "over") return;
            var pt = stagePointFromGhost(ghost);
            if (!pt) return;                            // can't read the drop -> snap back
            if (pt.y >= DROP_ZONE_MAX_Y) return;        // dropped back over the hand -> cancel, snap back
            if (canDefendInput()) {
                // Cover the nearest UNCOVERED pair this card can beat, but ONLY if the drop
                // actually landed near that pair (within ~1.4 card widths). A miss snaps back.
                var m = st.table.length, best = -1, bestDx = 1e9;
                for (var t = 0; t < m; t++) {
                    if (st.table[t].d >= 0 || !canDefendPair(st, t, card)) continue;
                    var sx = tableAtkSlot(t, m).x + CARD_W / 2;
                    var dx = Math.abs(pt.x - sx);
                    if (dx < bestDx) { bestDx = dx; best = t; }
                }
                if (best >= 0 && bestDx <= CARD_W * 1.4) {
                    if (online) { sendAct(2, best, card); return; }
                    applyDefend(st, best, card); afterAction();
                }
                // else: no reachable pair under the drop -> snap back silently (a miss shouldn't nag)
                return;
            }
            if (canAttackInput()) {
                if (canAttackWith(st, mySeat, card)) {
                    if (online) { sendAct(1, 0, card); return; }
                    applyAttack(st, mySeat, card); afterAction();
                }
                // else: illegal card dropped on the felt -> snap back silently
                return;
            }
        }

        function bindCardDrag(el, cid) {
            $.RegisterEventHandler("DragStart", el, function (_p, dragEvent) {
                // _dkPlayable already reflects throw-in eligibility (computeWanted marks any legal
                // non-defender attack card playable, not just the primary attacker's), so we no
                // longer gate the drag on myTurn(); commitDrop re-checks via can*Input().
                if (!el._dkPlayable) return;
                var ghost = $.CreatePanel("Panel", cardLayer, "");
                ghost.AddClass("mg-dk-card"); ghost.AddClass("mg-dk-dragging");
                setFace(ghost, cardFaceUrl(cid));           // ghost gets its own child <Image>
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
            var canAct = myTurn() && !pendingAct;
            if (canAct && st.phase === "attack" && st.attacker === mySeat && st.table.length > 0) {
                mkButton(controlsZone, "Pass", function () {
                    if (!myTurn() || pendingAct) return;
                    if (online) { sendAct(4, 0, 0); return; }         // 4 = bito (beat)
                    endBout(st, false); afterAction();
                });
            }
            if (canAct && st.phase === "defend" && st.defender === mySeat && st.table.length > 0) {
                mkButton(controlsZone, "Take", function () {
                    if (!myTurn() || pendingAct) return;
                    if (online) { sendAct(3, 0, 0); return; }         // 3 = take
                    boutTakeSeat = st.defender; endBout(st, true); afterAction();
                });
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
            // Cards present last frame but no longer wanted are leaving. On a TAKE bout they were
            // the table cards being picked up → route them to the taker's hand (boutTakeSeat).
            for (var id in cardEls) {
                if (cardEls.hasOwnProperty(id) && !wid[id]) { animateOut(cardEls[id], true); delete cardEls[id]; }
            }
            for (var i = 0; i < wanted.length; i++) ensureCard(wanted[i]);
            buildControls();
            boutTakeSeat = -1;   // one-shot: consumed by this render's animateOut
        }

        // input
        function onHandCardClick(card) {
            if (pendingAct || st.phase === "over") return;
            if (canDefendInput()) {
                for (var t = 0; t < st.table.length; t++) {
                    if (st.table[t].d < 0 && canDefendPair(st, t, card)) {
                        if (online) { sendAct(2, t, card); return; }   // server applies + echoes
                        applyDefend(st, t, card); afterAction(); return;
                    }
                }
                status("That card can't beat an open attack. Cover it or take.");
                return;
            }
            if (canAttackInput()) {
                if (canAttackWith(st, mySeat, card)) {
                    if (online) { sendAct(1, 0, card); return; }
                    applyAttack(st, mySeat, card); afterAction(); return;
                }
                status(st.table.length === 0 ? "Play a card to attack." : "Only a matching rank can be added.");
                return;
            }
        }


        // turn loop
        function promptFor() {
            if (st.phase === "defend" && st.defender === mySeat)
                return "Your defense. Cover the attacks or take.";
            if (st.attacker === mySeat && st.table.length === 0) return "Your turn. Attack.";
            if (st.attacker === mySeat) return "Add a matching-rank card, or press Pass.";
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
                else { boutTakeSeat = st.defender; endBout(st, true); }
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
            if (session.onGameOver) session.onGameOver(st.loser < 0 ? "draw" : (st.loser === mySeat ? "lose" : "win"));
        }

        // ── online sync (worker-as-dealer) ───────────────────────────────────────────
        // The client holds NO authority: it applies the public /api/dlog event stream to a
        // local `st` (opponent hands are placeholder counts, table cards are public, my own
        // cards come from /api/ddraw) and sends its own actions via /api/dact — never mutating
        // `st` optimistically. The server's echoed event is the single source of truth, so a
        // rejected action simply never lands (no rollback needed). Post-bout roles are NOT derived
        // locally — the server emits an authoritative ROLES event after each bout (see applyEvent),
        // which is the only way to get 3–4-player rotation right (it depends on refill + who's out).
        var myDrawExpected = 0;   // total cards the server has told me I hold (from DRAW events)

        function addToHand(seat, id) { st.hands[seat].push(seat === mySeat ? id : HIDDEN); }
        function removeFromHand(seat, card) {
            var h = st.hands[seat];
            if (seat === mySeat) { var i = h.indexOf(card); if (i >= 0) h.splice(i, 1); }
            else if (h.length) h.pop();     // opponents are counts only
        }
        // Post-bout roles are NOT computed locally — for 3–4 players the rotation depends on
        // refill order and who ran out of cards (state the client can't see). The server owns it
        // and sends a ROLES event right after each TAKE/BITO (+ the DRAW refills); we just clear
        // the felt here and wait for ROLES to set attacker/defender. (A 2-player game gets the
        // same ROLES event, so there's a single code path.)
        function applyEvent(ev) {
            if (ev.type === "trump") { st.trumpCard = ev.card; st.trump = suitOf(ev.card); }
            else if (ev.type === "open") { st.attacker = ev.seat; st.defender = nextInPlay(st, ev.seat); st.phase = "attack"; }
            else if (ev.type === "roles") { st.attacker = ev.attacker; st.defender = ev.defender; st.phase = "attack"; }
            else if (ev.type === "play") { st.table.push({ a: ev.card, d: -1 }); st.phase = "defend"; removeFromHand(ev.seat, ev.card); }
            else if (ev.type === "cover") {
                if (st.table[ev.pair]) st.table[ev.pair].d = ev.card;
                removeFromHand(st.defender, ev.card);
                if (uncoveredCount(st) === 0) st.phase = "attack";
            }
            else if (ev.type === "take") {
                for (var i = 0; i < st.table.length; i++) { addToHand(ev.seat, st.table[i].a); if (st.table[i].d >= 0) addToHand(ev.seat, st.table[i].d); }
                st.table = [];   // ROLES will set the next attacker/defender
                boutTakeSeat = ev.seat;   // next render flies the picked-up cards to the taker, not the deck
            }
            else if (ev.type === "bito") { st.table = []; }   // ROLES follows
            else if (ev.type === "draw") {
                deckRemaining = Math.max(0, deckRemaining - ev.count);
                setDeckCount(deckRemaining);
                if (ev.seat === mySeat) myDrawExpected += ev.count;      // real ids pulled via ddraw
                else for (var k = 0; k < ev.count; k++) addToHand(ev.seat, HIDDEN);
            }
            else if (ev.type === "over") { st.phase = "over"; st.loser = ev.loser; gameOver = true; }
        }
        // Pull my newly-dealt private cards one index at a time (FIFO-safe), then continue.
        function pullDraws(done) {
            if (destroyed) return;
            if (drawCursor[mySeat] >= myDrawExpected) { done(); return; }
            MG.Api.ddraw(session.code, session.tok, drawCursor[mySeat], function (card) {
                if (destroyed) return;
                if (card == null) { done(); return; }       // nothing at that index yet — try later
                st.hands[mySeat].push(card);
                drawCursor[mySeat]++;
                pullDraws(done);
            }, function () { if (!destroyed) $.Schedule(0.5, function () { pullDraws(done); }); });
        }
        function onlineStatus() {
            if (gameOver) return;
            if (myTurn()) { status(promptFor()); return; }
            // A non-defender who can throw in during a live attack isn't "on turn", but it CAN act.
            // Nudge it rather than showing a bare "X's turn…" (only when it actually holds a legal
            // throw-in — legalAttacks() is empty otherwise, e.g. nothing on the table matches).
            if (canAttackInput() && legalAttacks(st, mySeat).length > 0) { status("You can throw in a matching card."); return; }
            status(nameOf(actionActor()) + "'s turn…");
        }
        // Start (or restart) the single authoritative poll chain. Bumping pollGen kills any
        // in-flight chain so we never run two at once (see pollGen above).
        function startPolling() { pollGen++; pollLoop(pollGen); }
        function pollLoop(gen) {
            if (destroyed || gameOver || gen !== pollGen) return;
            MG.Api.dlog(session.code, logSeq, function (ev) {
                if (destroyed || gen !== pollGen) return;
                if (!ev) { $.Schedule(0.6, function () { pollLoop(gen); }); return; }   // nothing new
                logSeq++;
                applyEvent(ev);
                if (ev.type === "draw" && ev.seat === mySeat) {
                    pullDraws(function () {
                        if (gen !== pollGen) return;
                        render(); onlineStatus();
                        if (gameOver) finishGame(); else pollLoop(gen);
                    });
                    return;
                }
                render();
                onlineStatus();
                if (gameOver) { finishGame(); return; }
                pollLoop(gen);                                       // drain any burst immediately
            }, function () { if (!destroyed && gen === pollGen) $.Schedule(1.0, function () { pollLoop(gen); }); });
        }
        // Send one action; the server validates and (on success) appends the event we'll read
        // back on the next poll. We do NOT mutate `st` here — the echo is authoritative.
        function sendAct(a, pair, card) {
            if (destroyed || pendingAct) return;
            pendingAct = true;
            MG.Api.dact(session.code, session.tok, a, pair || 0, card || 0, function (r) {
                pendingAct = false;
                if (r && r.ok) { startPolling(); return; }           // pull the echo promptly (single chain)
                var why = r && r.reason;
                if (why === "turn") status("Not your turn.");
                else if (why === "illegal") status("That move isn't legal.");
                else if (why === "gone") { if (MG.UI && MG.UI.kickToMenu) MG.UI.kickToMenu("Lobby closed."); }
                else status("Move rejected.");
            }, function () { pendingAct = false; status("Server unavailable."); });
        }

        // boot
        render();
        if (online) {
            status("Dealing…");
            startPolling();
        } else if (myTurn()) status(promptFor());
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
