"use strict";
// Rules test for the shared No-Limit Hold'em engine. Run: node tools/mg_poker_test.js
// The pure rules live in panorama/scripts/rules/poker.js - the exact file the authoritative
// server dealer runs. Loaded like the other rules tests: the IIFE sees no `$` in Node, so it
// attaches to globalThis.MGRules.poker.
const fs = require("fs");
const path = require("path");

const rulesDir = path.join(__dirname, "..", "panorama", "scripts", "rules");
new Function(fs.readFileSync(path.join(rulesDir, "poker.js"), "utf8"))();
const M = globalThis.MGRules.poker;

let failures = 0;
function ok(cond, msg) { if (!cond) { failures++; console.log("  ✗ " + msg); } else { console.log("  ✓ " + msg); } }

// Build a card id from suit char + rank char, using the engine's own tables.
function card(s, r) {
    var suit = M.SUIT_CHARS.indexOf(s), rank = M.RANK_CHARS.indexOf(r);
    if (suit < 0 || rank < 0) throw new Error("bad card " + s + r);
    return suit * 13 + rank;
}
function hand() { var a = []; for (var i = 0; i < arguments.length; i++) a.push(card(arguments[i][0], arguments[i][1])); return a; }

console.log("card ids & encoding");
(function () {
    ok(M.DECK_SIZE === 52, "deck size is 52");
    ok(M.suitOf(0) === 0 && M.rankOf(0) === 0, "id 0 = S2");
    ok(M.suitOf(51) === 3 && M.rankOf(51) === 12, "id 51 = CA");
    ok(M.cardVal(card("S", "A")) === 14 && M.cardVal(card("S", "2")) === 2, "ace high = 14, deuce = 2");
    const deck = M.freshDeck(M.makeRng(12345));
    const seen = {}; let dup = false;
    for (const c of deck) { if (seen[c]) dup = true; seen[c] = 1; }
    ok(deck.length === 52 && !dup, "freshDeck: 52 unique cards");
    ok(M.freshDeck(M.makeRng(7)).join() === M.freshDeck(M.makeRng(7)).join(), "freshDeck deterministic per seed");
})();

console.log("hand categories (7-card best-5)");
(function () {
    // [category] indices: 8 SF, 7 quads, 6 full, 5 flush, 4 straight, 3 trips, 2 two-pair, 1 pair, 0 high
    function cat(cards) { return M.score(cards)[0]; }
    ok(cat(hand(["S","A"],["S","K"],["S","Q"],["S","J"],["S","T"],["H","2"],["D","3"])) === 8, "royal/straight flush");
    ok(cat(hand(["S","5"],["H","5"],["D","5"],["C","5"],["S","K"],["H","2"],["D","3"])) === 7, "four of a kind");
    ok(cat(hand(["S","5"],["H","5"],["D","5"],["C","K"],["S","K"],["H","2"],["D","3"])) === 6, "full house");
    ok(cat(hand(["S","A"],["S","9"],["S","7"],["S","4"],["S","2"],["H","K"],["D","Q"])) === 5, "flush");
    ok(cat(hand(["S","5"],["H","6"],["D","7"],["C","8"],["S","9"],["H","K"],["D","2"])) === 4, "straight");
    ok(cat(hand(["S","A"],["H","2"],["D","3"],["C","4"],["S","5"],["H","K"],["D","Q"])) === 4, "wheel A-2-3-4-5 is a straight");
    ok(cat(hand(["S","5"],["H","5"],["D","5"],["C","K"],["S","Q"],["H","2"],["D","3"])) === 3, "three of a kind");
    ok(cat(hand(["S","5"],["H","5"],["D","K"],["C","K"],["S","Q"],["H","2"],["D","3"])) === 2, "two pair");
    ok(cat(hand(["S","5"],["H","5"],["D","K"],["C","9"],["S","Q"],["H","2"],["D","3"])) === 1, "one pair");
    ok(cat(hand(["S","A"],["H","J"],["D","9"],["C","7"],["S","5"],["H","3"],["D","2"])) === 0, "high card");
})();

console.log("hand comparisons");
(function () {
    const c = M.compareScores;
    // higher full house beats lower full house
    const fhA = M.score(hand(["S","A"],["H","A"],["D","A"],["C","K"],["S","K"],["H","2"],["D","3"]));
    const fhB = M.score(hand(["S","Q"],["H","Q"],["D","Q"],["C","J"],["S","J"],["H","2"],["D","3"]));
    ok(c(fhA, fhB) > 0, "AAA-KK beats QQQ-JJ");
    // flush kicker
    const flA = M.score(hand(["S","A"],["S","Q"],["S","9"],["S","5"],["S","3"],["H","K"],["D","2"]));
    const flB = M.score(hand(["S","K"],["S","Q"],["S","9"],["S","5"],["S","3"],["H","A"],["D","2"]));
    ok(c(flA, flB) > 0, "ace-high flush beats king-high flush");
    // pair kicker
    const pA = M.score(hand(["S","K"],["H","K"],["D","A"],["C","7"],["S","5"],["H","2"],["D","3"]));
    const pB = M.score(hand(["S","K"],["H","K"],["D","Q"],["C","7"],["S","5"],["H","2"],["D","3"]));
    ok(c(pA, pB) > 0, "KK with ace kicker beats KK with queen kicker");
    // identical hands tie
    const tA = M.score(hand(["S","A"],["H","K"],["D","Q"],["C","J"],["S","T"],["H","2"],["D","3"]));
    const tB = M.score(hand(["C","A"],["D","K"],["H","Q"],["S","J"],["C","T"],["S","4"],["D","5"]));
    ok(c(tA, tB) === 0, "same straight ties regardless of suit");
})();

console.log("blinds & opener");
(function () {
    // 4 players, button=0, equal stacks. sb=1 (seat1), bb=2 (seat2), UTG opener = seat3.
    const st = M.newHand(4, 0, [100, 100, 100, 100], 5, 10, 42);
    ok(st.bet[1] === 5 && st.bet[2] === 10, "small blind seat1=5, big blind seat2=10");
    ok(st.currentBet === 10, "current bet = big blind");
    ok(st.toAct === 3, "UTG (seat3) acts first preflop");
    ok(st.hole[0].length === 2 && st.hole[3].length === 2, "each seat dealt 2 hole cards");
    ok(st.board.length === 0, "no community cards preflop");
    // heads-up: button posts SB and acts first
    const hu = M.newHand(2, 0, [100, 100], 5, 10, 42);
    ok(hu.bet[0] === 5 && hu.bet[1] === 10, "heads-up: button (seat0) posts SB");
    ok(hu.toAct === 0, "heads-up: button acts first preflop");
})();

console.log("legal actions");
(function () {
    const st = M.newHand(4, 0, [100, 100, 100, 100], 5, 10, 42);
    const la = M.legalActions(st, 3);   // UTG facing the big blind
    ok(la.canFold && la.canCall && !la.canCheck, "UTG can fold/call, cannot check facing a bet");
    ok(la.callAmount === 10, "call amount = 10");
    ok(la.canRaise && la.minRaiseTo === 20, "min raise-to = 20 (bet + big blind)");
    ok(la.maxRaiseTo === 100, "max raise-to = full stack");
    ok(!M.legalActions(st, 0).canFold, "a seat not to act has no legal actions");
})();

console.log("betting round → streets");
(function () {
    // Everyone calls/checks preflop → flop is dealt.
    const st = M.newHand(3, 0, [100, 100, 100], 5, 10, 7);
    // seats: button=0, sb=1, bb=2, opener=0 (UTG in 3-handed = button)
    ok(st.toAct === 0, "3-handed opener is the button");
    ok(M.applyAction(st, 0, { type: "call" }), "button calls");
    ok(M.applyAction(st, 1, { type: "call" }), "small blind completes");
    ok(M.applyAction(st, 2, { type: "check" }), "big blind checks");
    ok(st.street === "flop" && st.board.length === 3, "flop dealt after preflop closes");
    ok(st.currentBet === 0, "bets reset on the new street");
    ok(st.toAct === 1, "postflop opens left of button (seat1)");
})();

console.log("fold-to-one ends hand immediately");
(function () {
    const st = M.newHand(3, 0, [100, 100, 100], 5, 10, 7);
    M.applyAction(st, 0, { type: "raise", to: 30 });
    M.applyAction(st, 1, { type: "fold" });
    M.applyAction(st, 2, { type: "fold" });
    ok(st.street === "over", "hand over when all but one fold");
    ok(st.result.uncontested === true, "win flagged uncontested");
    ok(st.result.winners.length === 1 && st.result.winners[0] === 0, "raiser wins the pot");
    ok(st.stacks[0] === 115, "winner stack = 100 - 30 + (30+15+10... ) pot"); // 5+10 blinds + 30 raise; winner gets 45, net +15
})();

console.log("side pots (all-in short stack)");
(function () {
    // seat0 has 20, seats1&2 have 200. Everyone all-in preflop. Short stack can only win the
    // main pot (60), the rest is a side pot between the two big stacks.
    const st = M.newHand(3, 0, [20, 200, 200], 5, 10, 3);
    // force a full all-in scenario via raises
    // button=0 (20), sb=1, bb=2, opener=0
    M.applyAction(st, 0, { type: "raise", to: 20 });     // seat0 shoves 20 (all-in)
    M.applyAction(st, 1, { type: "raise", to: 200 });    // seat1 shoves 200
    M.applyAction(st, 2, { type: "call" });              // seat2 calls 200 (all-in)
    ok(st.street === "over", "all-in runout reaches showdown");
    ok(st.pots.length >= 2, "at least a main pot + one side pot built");
    // chip conservation: total chips always 420
    let total = 0; for (let s = 0; s < 3; s++) total += st.stacks[s];
    ok(total === 420, "chips conserved through side pots (=420)");
    // main pot is 3*20 = 60; seat0 eligible only there
    ok(st.pots[0].amount === 60, "main pot = 3 x 20 = 60");
})();

console.log("full bot games (chip conservation + termination)");
(function () {
    const NUM = 4, START = 200, SB = 5, BB = 10;
    let played = 0, allConserved = true, allTerminated = true;
    for (let g = 0; g < 200; g++) {
        const rng = M.makeRng(1000 + g);
        let stacks = [START, START, START, START];
        let button = g % NUM;
        // play up to 40 hands or until only one player has chips
        for (let h = 0; h < 40; h++) {
            const alive = stacks.filter(x => x > 0).length;
            if (alive < 2) break;
            const seed = (rng() * 0x7fffffff) | 0;
            const st = M.newHand(NUM, button, stacks, SB, BB, seed);
            let guard = 0;
            while (st.street !== "over" && guard++ < 1000) {
                const seat = st.toAct;
                if (seat < 0) break;
                const act = M.botAction(st, seat, rng);
                if (!M.applyAction(st, seat, act)) {
                    // illegal bot action - should never happen; force a fold to avoid a hang
                    allTerminated = false;
                    M.applyAction(st, seat, { type: M.legalActions(st, seat).canCheck ? "check" : "fold" });
                }
            }
            if (guard >= 1000) allTerminated = false;
            let total = 0; for (let s = 0; s < NUM; s++) total += st.stacks[s];
            if (total !== NUM * START) allConserved = false;
            stacks = st.stacks.slice();
            button = (button + 1) % NUM;
            played++;
        }
    }
    ok(played > 0, "bot games ran (" + played + " hands)");
    ok(allConserved, "chips conserved across every hand (=" + (NUM * START) + ")");
    ok(allTerminated, "every hand terminated with only legal bot actions");
})();

console.log("");
if (failures) { console.log(failures + " FAILURE(S)"); process.exit(1); }
else console.log("all poker rules tests passed");
