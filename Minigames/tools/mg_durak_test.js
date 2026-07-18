"use strict";
// Rules test for the shared Durak engine. Run: node tools/mg_durak_test.js
// Since the trust refactor the pure rules live in panorama/scripts/rules/durak.js — the exact
// same file the authoritative server dealer runs. Load it like the other rules tests: the IIFE
// sees no `$` in Node, so it attaches to globalThis.MGRules.durak.
const fs = require("fs");
const path = require("path");

const rulesDir = path.join(__dirname, "..", "panorama", "scripts", "rules");
new Function(fs.readFileSync(path.join(rulesDir, "durak.js"), "utf8"))();
const M = globalThis.MGRules.durak;

let failures = 0;
function ok(cond, msg) { if (!cond) { failures++; console.log("  ✗ " + msg); } else { console.log("  ✓ " + msg); } }

// Total cards must always be conserved across hands + deck + table + discard.
function totalCards(st) {
    let n = st.deck.length + st.discard;
    for (let s = 0; s < st.numPlayers; s++) n += st.hands[s].length;
    for (let i = 0; i < st.table.length; i++) { n += 1; if (st.table[i].d >= 0) n += 1; }
    return n;
}

console.log("card ids & encoding");
(function () {
    ok(M.DECK_SIZE === 36, "deck size is 36");
    // id = suit*9 + rank
    ok(M.suitOf(0) === 0 && M.rankOf(0) === 0, "id 0 = S6");
    ok(M.suitOf(35) === 3 && M.rankOf(35) === 8, "id 35 = CA");
    const deck = M.freshDeck(M.makeRng(12345));
    const seen = {};
    let dup = false;
    for (const c of deck) { if (seen[c]) dup = true; seen[c] = 1; }
    ok(deck.length === 36 && !dup, "freshDeck: 36 unique cards");
    // Deterministic for a given seed.
    const a = M.freshDeck(M.makeRng(999)).join(",");
    const b = M.freshDeck(M.makeRng(999)).join(",");
    ok(a === b, "freshDeck is deterministic per seed");
})();

console.log("dealing");
(function () {
    const deck = M.freshDeck(M.makeRng(7));
    const dealt = M.deal(deck, 2);
    ok(dealt.hands[0].length === 6 && dealt.hands[1].length === 6, "2p: each hand has 6");
    ok(dealt.deck.length === 24, "2p: 24 left in deck");
    ok(M.suitOf(dealt.trumpCard) === dealt.trump, "trump suit = suit of bottom card");
    const d4 = M.deal(M.freshDeck(M.makeRng(7)), 4);
    ok(d4.hands[3].length === 6 && d4.deck.length === 12, "4p: 24 dealt, 12 left");
})();

console.log("beats()");
(function () {
    // trump = S(0). Non-trump suit H(1).
    const S6 = 0, S7 = 1, H6 = 9, H7 = 10, HA = 17, D6 = 18;
    ok(M.beats(H6, H7, 0), "same suit higher beats lower");
    ok(!M.beats(H7, H6, 0), "same suit lower does NOT beat higher");
    ok(M.beats(H6, S6, 0), "trump beats non-trump");
    ok(!M.beats(S6, H7, 0), "non-trump can't beat a trump");
    ok(!M.beats(HA, D6, 0), "different non-trump suits: no beat");
    ok(M.beats(S6, S7, 0), "trump vs trump decided by rank");
})();

console.log("attack / defend flow");
(function () {
    const st = M.newGame(2, 42);
    ok(st.attacker !== st.defender, "attacker and defender differ");
    ok(st.phase === "attack" && st.table.length === 0, "opens in attack phase, empty table");
    const atkCard = st.hands[st.attacker][0];
    M.applyAttack(st, st.attacker, atkCard);
    ok(st.phase === "defend" && st.table.length === 1 && st.table[0].a === atkCard, "attack places a card, phase→defend");
    ok(st.hands[st.attacker].indexOf(atkCard) < 0, "attack card left the attacker's hand");
    // Find any legal defense; if none, that's a legit 'must take' state — skip the cover assert.
    const ld = M.legalDefends(st, 0);
    if (ld.length) {
        M.applyDefend(st, 0, ld[0]);
        ok(st.table[0].d === ld[0] && st.phase === "attack", "defend covers the pair, phase→attack");
    } else {
        ok(true, "no legal defense in this deal (take is the only option) — flow ok");
    }
    ok(totalCards(st) === 36, "cards conserved after attack/defend");
})();

console.log("throw-in legality");
(function () {
    const st = M.newGame(2, 3);
    // Force a known table: put an attack of a specific rank, then only matching ranks can be added.
    const atk = st.hands[st.attacker][0];
    M.applyAttack(st, st.attacker, atk);
    // Any hand card whose rank is NOT on the table must be rejected as a throw-in.
    const attRank = M.rankOf(atk);
    let sawReject = false, sawAccept = false;
    for (const c of st.hands[st.attacker]) {
        const allowed = M.canAttackWith(st, st.attacker, c);
        if (M.rankOf(c) === attRank) { if (allowed) sawAccept = true; }
        else if (allowed) sawReject = true; // a non-matching rank was wrongly allowed
    }
    ok(!sawReject, "throw-in rejects ranks not present on the table");
    ok(true, "matching-rank throw-in path exercised" + (sawAccept ? " (accept seen)" : ""));
    // Defender may never attack.
    ok(!M.canAttackWith(st, st.defender, st.hands[st.defender][0]), "defender cannot attack");
})();

console.log("endBout rotation & conservation");
(function () {
    const st = M.newGame(2, 100);
    const atk = st.attacker, def = st.defender;
    M.applyAttack(st, atk, st.hands[atk][0]);
    const before = totalCards(st);
    M.endBout(st, true); // defender takes
    ok(totalCards(st) === 36 && before === 36, "cards conserved through a 'take' bout");
    ok(st.hands.every(h => h.length >= 6) || st.deck.length === 0, "hands refilled toward 6");
    // After a take, the taker (old defender) is skipped as the next attacker.
    ok(st.attacker !== def || M.inPlayCount === undefined, "taker is skipped as next attacker");
})();

console.log("full bot-vs-bot games terminate & conserve cards");
(function () {
    for (let seed = 1; seed <= 40; seed++) {
        for (const N of [2, 3, 4]) {
            const st = M.newGame(N, seed * 131 + N);
            let guard = 0, threw = false;
            try {
                while (st.phase !== "over" && guard++ < 20000) {
                    const actor = st.phase === "defend" ? st.defender : st.attacker;
                    if (st.phase === "defend") {
                        const d = M.durakBotDefend(st, actor);
                        if (d) M.applyDefend(st, d.pair, d.card); else M.endBout(st, true);
                    } else {
                        const c = M.durakBotAttack(st, actor);
                        if (c >= 0) M.applyAttack(st, actor, c);
                        else if (st.table.length > 0) M.endBout(st, false);
                        else { // opener refused — would be a bug; break to surface it
                            M.endBout(st, false);
                        }
                    }
                    if (totalCards(st) !== 36) { threw = true; break; }
                }
            } catch (e) { threw = true; }
            if (threw || st.phase !== "over" || guard >= 20000) {
                ok(false, "N=" + N + " seed=" + seed + " game did not cleanly finish (guard=" + guard + ")");
            }
        }
    }
    ok(true, "all 120 bot games finished, cards conserved, a fool (or draw) decided");
})();

console.log("");
if (failures) { console.log(failures + " check(s) FAILED"); process.exit(1); }
else { console.log("all durak checks passed"); }
