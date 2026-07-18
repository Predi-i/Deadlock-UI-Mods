"use strict";

/*
 * rules/durak.js — pure "Durak" (Podkidnoy) rules, shared by the client (predictor + bot)
 * and the authoritative server dealer (same shared-namespace mechanism as rules/ttt.js).
 *
 * Card model: id 0..35 = suit*9 + rank. suit 0..3 = S,H,D,C. rank 0..8 = 6,7,8,9,T,J,Q,K,A
 * (higher rank index = stronger). Trump = suit of the deck's bottom card. A given seed fully
 * determines a deal (mulberry32), and online the SERVER owns that seed — so the client never
 * sees the deck, it rebuilds its view from the public event log + its own private cards.
 *
 * Scope note: the mod ships 2-player online Durak for now; 3–4-player online seating/plumbing
 * is deferred (see mg_ui.js). These rules already generalise to numPlayers 2..4 and the
 * offline bot exercises 2/3/4, so nothing here blocks a later expansion.
 */

(function () {
    var R;
    if (typeof $ !== "undefined" && $) {
        var MG = ($.MG = $.MG || {});
        R = (MG.Rules = MG.Rules || {});
    } else if (typeof globalThis !== "undefined") {
        R = (globalThis.MGRules = globalThis.MGRules || {});
    } else {
        R = (this.MGRules = this.MGRules || {});
    }

    var SUIT_CHARS = ["S", "H", "D", "C"];
    var RANK_CHARS = ["6", "7", "8", "9", "T", "J", "Q", "K", "A"];
    var DECK_SIZE = 36;

    function suitOf(id) { return (id / 9) | 0; }
    function rankOf(id) { return id % 9; }

    // Deterministic PRNG (mulberry32) so a given seed always deals the same game — the test
    // relies on this, and online the server owns the seed.
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
    //  - throw-in (non-empty): rank must already be on the table, table capped at 6 cards,
    //    and never more uncovered attacks than the defender can still cover.
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

    R.durak = {
        SUIT_CHARS: SUIT_CHARS, RANK_CHARS: RANK_CHARS, DECK_SIZE: DECK_SIZE,
        suitOf: suitOf, rankOf: rankOf, makeRng: makeRng, freshDeck: freshDeck, deal: deal,
        beats: beats, removeCard: removeCard, firstAttacker: firstAttacker, nextInPlay: nextInPlay,
        firstInPlayFrom: firstInPlayFrom, newGame: newGame, tableRankSet: tableRankSet,
        uncoveredCount: uncoveredCount, firstUncovered: firstUncovered, canAttackWith: canAttackWith,
        legalAttacks: legalAttacks, canDefendPair: canDefendPair, legalDefends: legalDefends,
        applyAttack: applyAttack, applyDefend: applyDefend, updateOut: updateOut,
        inPlayCount: inPlayCount, refill: refill, endBout: endBout, checkOver: checkOver,
        cardValue: cardValue, sortByValue: sortByValue,
        durakBotAttack: durakBotAttack, durakBotDefend: durakBotDefend
    };
})();
