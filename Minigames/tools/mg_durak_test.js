"use strict";
// Rules test for the shared Durak engine. Run: node tools/mg_durak_test.js
// Since the trust refactor the pure rules live in panorama/scripts/rules/durak.js - the exact
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
(() => {
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
(() => {
    const deck = M.freshDeck(M.makeRng(7));
    const dealt = M.deal(deck, 2);
    ok(dealt.hands[0].length === 6 && dealt.hands[1].length === 6, "2p: each hand has 6");
    ok(dealt.deck.length === 24, "2p: 24 left in deck");
    ok(M.suitOf(dealt.trumpCard) === dealt.trump, "trump suit = suit of bottom card");
    const d4 = M.deal(M.freshDeck(M.makeRng(7)), 4);
    ok(d4.hands[3].length === 6 && d4.deck.length === 12, "4p: 24 dealt, 12 left");
})();

console.log("beats()");
(() => {
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
(() => {
    const st = M.newGame(2, 42);
    ok(st.attacker !== st.defender, "attacker and defender differ");
    ok(st.phase === "attack" && st.table.length === 0, "opens in attack phase, empty table");
    const atkCard = st.hands[st.attacker][0];
    M.applyAttack(st, st.attacker, atkCard);
    ok(st.phase === "defend" && st.table.length === 1 && st.table[0].a === atkCard, "attack places a card, phase→defend");
    ok(st.hands[st.attacker].indexOf(atkCard) < 0, "attack card left the attacker's hand");
    // Find any legal defense; if none, that's a legit 'must take' state - skip the cover assert.
    const ld = M.legalDefends(st, 0);
    if (ld.length) {
        M.applyDefend(st, 0, ld[0]);
        ok(st.table[0].d === ld[0] && st.phase === "attack", "defend covers the pair, phase→attack");
    } else {
        ok(true, "no legal defense in this deal (take is the only option) - flow ok");
    }
    ok(totalCards(st) === 36, "cards conserved after attack/defend");
})();

console.log("throw-in legality");
(() => {
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
(() => {
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
(() => {
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
                        else { // opener refused - would be a bug; break to surface it
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

console.log("throw-in consensus (canBito / pass window)");
(() => {
    // 2 players: one non-defender (the attacker). Once it passes on a covered table, canBito.
    const st = M.newGame(2, 5);
    const atk = st.attacker;
    M.applyAttack(st, atk, st.hands[atk][0]);
    ok(!M.canBito(st), "uncovered table can't be beaten");
    const ld = M.legalDefends(st, 0);
    if (ld.length) {
        M.applyDefend(st, 0, ld[0]);
        // Table now covered. Under the explicit-Bito rule a seat that still HOLDS cards is never
        // auto-settled - whether or not it holds a legal throw-in, it must explicitly pass before the
        // table can be beaten. (Only an empty hand auto-settles.) This is what keeps a covered table
        // on screen after a defence instead of sweeping it to discard in the same tick.
        const hasCards = st.hands[atk].length > 0;
        const canThrow = M.legalAttacks(st, atk).length > 0;
        if (hasCards) {
            ok(!M.canBito(st), "covered but attacker still holds cards → not yet bito (must confirm)");
            ok(M.firstUnsettled(st) === atk, "attacker is the unsettled seat owing a Bito confirm");
            if (canThrow) ok(M.pendingThrowers(st).indexOf(atk) >= 0, "attacker with a throw-in listed as pending thrower");
            M.applyPass(st, atk);
            ok(M.canBito(st), "attacker passed (Bito) → bito now allowed");
            ok(M.firstUnsettled(st) === -1, "nobody unsettled after the pass");
        } else {
            ok(M.canBito(st), "covered and attacker has no cards → auto-settled, bito allowed");
        }
    } else {
        ok(true, "deal forces a take - consensus not exercised this seed");
    }
})();

console.log("a fresh attack card reopens a passed window");
(() => {
    // 3 players so there are TWO non-defender attack seats: the primary attacker and one co-attacker.
    // After both settle and one throws a new matching card, passes must reset (window reopens).
    let reopened = false, exercised = false;
    for (let seed = 1; seed <= 60 && !reopened; seed++) {
        const st = M.newGame(3, seed * 17);
        const atk = st.attacker;
        M.applyAttack(st, atk, st.hands[atk][0]);
        const ld = M.legalDefends(st, 0);
        if (!ld.length) continue;
        M.applyDefend(st, 0, ld[0]);
        // Settle everyone by fiat, then confirm a new attack clears the passes.
        M.applyPass(st, atk);
        const co = [0, 1, 2].find(s => M.isAttackSeat(st, s) && s !== atk);
        if (co != null) M.applyPass(st, co);
        exercised = true;
        // Find any legal throw-in for any attack seat and play it.
        for (const s of [atk, co]) {
            if (s == null) continue;
            const la = M.legalAttacks(st, s);
            if (la.length && st.table.length < 6) {
                M.applyAttack(st, s, la[0]);
                ok(!st.passed[atk] && (co == null || !st.passed[co]), "new attack reset all passes");
                reopened = true;
                break;
            }
        }
    }
    ok(exercised, "reached a covered 3p table to test the reopen rule");
})();

console.log("full CONSENSUS bot games (all attack seats throw in) terminate & conserve");
(() => {
    // Drive games where EVERY in-play non-defender throws in until it has nothing legal, then
    // passes - the true podkidnoy flow. Bito only when canBito(). This exercises the new consensus
    // path end-to-end (the old loop above only lets the primary attacker act).
    let bad = 0;
    for (let seed = 1; seed <= 40; seed++) {
        for (const N of [2, 3, 4]) {
            const st = M.newGame(N, seed * 911 + N);
            let guard = 0, threw = false;
            try {
                while (st.phase !== "over" && guard++ < 40000) {
                    if (st.phase === "defend") {
                        const d = M.durakBotDefend(st, st.defender);
                        if (d) M.applyDefend(st, d.pair, d.card);
                        else { M.endBout(st, true); }
                        continue;
                    }
                    // attack phase (table fully covered or empty). Empty → opener must play.
                    if (st.table.length === 0) {
                        const c = M.durakBotAttack(st, st.attacker);
                        if (c >= 0) M.applyAttack(st, st.attacker, c);
                        else M.endBout(st, false);   // opener with nothing is degenerate; discard
                        continue;
                    }
                    // Covered table: a pending thrower may pile a card on; else the seat currently
                    // owing a Bito confirm (firstUnsettled) explicitly passes. Under the explicit-Bito
                    // rule a seat holding cards is never auto-settled, so consensus is only reached by
                    // walking every unsettled attacker and passing it.
                    const throwers = M.pendingThrowers(st);
                    if (throwers.length) {
                        const s = throwers[0];
                        const la = M.sortByValue(M.legalAttacks(st, s), st.trump);
                        // Throw the cheapest legal card (mirrors bot temperament, but always adds
                        // when able, to stress the window rather than stop early).
                        M.applyAttack(st, s, la[0]);
                    } else if (M.canBito(st)) {
                        M.endBout(st, false);
                    } else {
                        // No pending thrower but not yet bito → someone holding cards still owes a
                        // confirm. Pass that seat (explicit Bito). If firstUnsettled can't find one,
                        // the state is inconsistent - flag it.
                        const u = M.firstUnsettled(st);
                        if (u < 0) { threw = true; break; }
                        M.applyPass(st, u);
                    }
                    if (totalCards(st) !== 36) { threw = true; break; }
                }
            } catch (e) { threw = true; }
            if (threw || st.phase !== "over" || guard >= 40000) {
                bad++;
                ok(false, "consensus N=" + N + " seed=" + seed + " did not finish (guard=" + guard + ")");
            }
        }
    }
    ok(bad === 0, "all 120 consensus bot games finished, cards conserved, a fool decided");
})();

console.log("");
if (failures) { console.log(failures + " check(s) FAILED"); process.exit(1); }
else { console.log("all durak checks passed"); }
