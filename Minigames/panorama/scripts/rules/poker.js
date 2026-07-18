"use strict";

/*
 * rules/poker.js — pure No-Limit Texas Hold'em rules, shared by the client (predictor +
 * bot) and the authoritative server dealer (same shared-namespace mechanism as the other
 * rules/*.js). Nothing here touches Panorama; it is fully unit-testable in Node.
 *
 * Card model: id 0..51 = suit*13 + rank. suit 0..3 = S,H,D,C. rank 0..12 = 2,3,4,5,6,7,8,9,
 * T,J,Q,K,A (higher rank index = stronger). This matches the deck art filenames
 * (SUIT_CHARS[suit] + RANK_CHARS[rank] + ".vtex" → e.g. "SA", "H2", "DT"). A given seed
 * fully determines a deal (mulberry32); online the SERVER owns that seed so the client
 * never sees the deck or a foreign hole card — it rebuilds its view from the public event
 * log + its own private cards.
 *
 * Hand evaluation returns a comparable SCORE ARRAY [category, k1, k2, ...] where category
 * 8=straight flush … 0=high card and the k's are tie-break ranks, high-to-low. Compare two
 * scores lexicographically with compareScores(): >0 means the first hand wins.
 *
 * Betting is No-Limit: fold / check / call / raise-to. Side pots are built from each
 * player's total committed chips at showdown, so an all-in short stack can only win the
 * portion it matched. Deterministic bot (seeded rng) so mg_poker_test.js reproduces games.
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
    var RANK_CHARS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
    var DECK_SIZE = 52;

    function suitOf(id) { return (id / 13) | 0; }
    function rankOf(id) { return id % 13; }
    function cardVal(id) { return rankOf(id) + 2; }   // 2..14 (ace high)

    // Deterministic PRNG (mulberry32) — identical to the other engines so seeds line up.
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

    // ── hand evaluation ─────────────────────────────────────────────────────────
    // High card of the best straight in `vals` (array of card values 2..14, dups ok), or 0.
    // Handles the wheel (A-2-3-4-5) by letting the ace also count as 1.
    function straightHigh(vals) {
        var present = {};
        for (var i = 0; i < vals.length; i++) present[vals[i]] = 1;
        if (present[14]) present[1] = 1;               // ace plays low for the wheel
        var run = 0;
        for (var v = 14; v >= 1; v--) {
            if (present[v]) { run++; if (run >= 5) return v + 4; } else run = 0;
        }
        return 0;
    }

    // Score the best 5-card hand out of 5..7 cards. Returns [category, tiebreak…].
    function score(cards) {
        var byVal = {}, bySuit = [[], [], [], []], i, v, s;
        for (i = 0; i < cards.length; i++) {
            v = cardVal(cards[i]); s = suitOf(cards[i]);
            byVal[v] = (byVal[v] || 0) + 1;
            bySuit[s].push(v);
        }
        // flush / straight flush
        var flushVals = null;
        for (s = 0; s < 4; s++) if (bySuit[s].length >= 5) flushVals = bySuit[s];
        if (flushVals) {
            var sfHigh = straightHigh(flushVals);
            if (sfHigh) return [8, sfHigh];
        }
        // grouped by count then value, high to low
        var groups = [];
        for (var key in byVal) if (byVal.hasOwnProperty(key)) groups.push([byVal[key], parseInt(key, 10)]);
        groups.sort(function (a, b) { return b[0] - a[0] || b[1] - a[1]; });
        // ordered distinct values high→low (kickers)
        var vals = [];
        for (i = 0; i < groups.length; i++) vals.push(groups[i][1]);

        var c0 = groups[0], c1 = groups[1];
        if (c0[0] === 4) return [7, c0[1], firstOther(vals, c0[1])];
        if (c0[0] === 3 && c1 && c1[0] >= 2) return [6, c0[1], c1[1]];
        if (flushVals) { flushVals = flushVals.slice().sort(desc); return [5, flushVals[0], flushVals[1], flushVals[2], flushVals[3], flushVals[4]]; }
        var st = straightHigh(allVals(cards));
        if (st) return [4, st];
        if (c0[0] === 3) return [3, c0[1], vals[1], vals[2]];
        if (c0[0] === 2 && c1 && c1[0] === 2) return [2, c0[1], c1[1], firstOtherPair(vals, c0[1], c1[1])];
        if (c0[0] === 2) return [1, c0[1], vals[1], vals[2], vals[3]];
        var hv = allVals(cards).sort(desc);
        return [0, hv[0], hv[1], hv[2], hv[3], hv[4]];
    }
    function desc(a, b) { return b - a; }
    function allVals(cards) { var o = []; for (var i = 0; i < cards.length; i++) o.push(cardVal(cards[i])); return o; }
    function firstOther(vals, exclude) { for (var i = 0; i < vals.length; i++) if (vals[i] !== exclude) return vals[i]; return 0; }
    function firstOtherPair(vals, a, b) { for (var i = 0; i < vals.length; i++) if (vals[i] !== a && vals[i] !== b) return vals[i]; return 0; }

    function compareScores(a, b) {
        var n = Math.max(a.length, b.length);
        for (var i = 0; i < n; i++) {
            var x = a[i] || 0, y = b[i] || 0;
            if (x !== y) return x - y;
        }
        return 0;
    }
    // Best score for a seat given its 2 hole cards + the community board.
    function evalSeat(hole, board) { return score(hole.concat(board)); }

    // ── seating helpers ─────────────────────────────────────────────────────────
    function nextSeat(st, seat) { return (seat + 1) % st.numPlayers; }
    // Next seat that can still voluntarily act (in the hand, not folded, not all-in, has chips).
    function nextToAct(st, seat) {
        for (var k = 1; k <= st.numPlayers; k++) {
            var s = (seat + k) % st.numPlayers;
            if (st.inHand[s] && !st.folded[s] && !st.allIn[s] && st.stacks[s] > 0) return s;
        }
        return -1;
    }
    // First seat left of the button that is still in the hand (used to open postflop streets).
    function firstLeftOfButton(st) {
        for (var k = 1; k <= st.numPlayers; k++) {
            var s = (st.button + k) % st.numPlayers;
            if (st.inHand[s] && !st.folded[s]) return s;
        }
        return -1;
    }
    function activeCount(st) { var n = 0; for (var s = 0; s < st.numPlayers; s++) if (st.inHand[s] && !st.folded[s]) n++; return n; }
    function canActCount(st) { var n = 0; for (var s = 0; s < st.numPlayers; s++) if (st.inHand[s] && !st.folded[s] && !st.allIn[s] && st.stacks[s] > 0) n++; return n; }

    // ── hand lifecycle ────────────────────────────────────────────────────────────
    // Move `amt` chips from a seat's stack into the pot; caps at the stack (all-in) and
    // tracks both this-street bet and the hand-total committed (for side pots).
    function putIn(st, seat, amt) {
        var pay = Math.min(amt, st.stacks[seat]);
        st.stacks[seat] -= pay;
        st.bet[seat] += pay;
        st.committed[seat] += pay;
        if (st.stacks[seat] === 0) st.allIn[seat] = true;
        return pay;
    }

    // Start a fresh hand. `stacks` is per-seat chips; seats with 0 chips sit out (not inHand).
    // Blinds are posted, hole cards dealt, action set to the correct opener.
    //
    // ONLINE: pass seed=null. The deck stays EMPTY (the server owns it), no hole cards are
    // dealt, and dealBoard/showdown/finish become no-ops (see st.online guards) — the client
    // fills board/hole/winners from the server's public event log instead. Everything else
    // (blinds, currentBet, whose turn) is CARD-INDEPENDENT, so the client's replay of the
    // betting is byte-identical to the server's authority with no deck knowledge at all.
    function newHand(numPlayers, button, stacks, sb, bb, seed) {
        var online = (seed == null);
        var deck = online ? [] : freshDeck(makeRng(seed));
        var st = {
            numPlayers: numPlayers, button: button, sb: sb, bb: bb, online: online,
            deck: deck, hole: [], board: [],
            stacks: stacks.slice(),
            bet: [], committed: [], folded: [], allIn: [], inHand: [], acted: [],
            street: "preflop", currentBet: 0, minRaise: bb,
            toAct: -1, lastAggressor: -1,
            pots: [], result: null
        };
        for (var s = 0; s < numPlayers; s++) {
            st.bet.push(0); st.committed.push(0); st.folded.push(false);
            st.allIn.push(false); st.acted.push(false);
            st.inHand.push(stacks[s] > 0);
            st.hole.push([]);
        }
        // The button MUST sit on an occupied seat: a tournament caller rotates the button
        // blindly and it can land on a busted (0-chip) seat, which would otherwise post a
        // blind on an empty seat (heads-up branch) and hang the hand. Normalise it here.
        if (!st.inHand[button]) button = nextOccupied(st, button);
        st.button = button;
        // deal 2 hole cards to each in-hand seat (button+1 first, like a real deal). Online the
        // deck is empty and hole cards arrive privately per seat, so skip the deal.
        if (!online) for (var round = 0; round < 2; round++) {
            for (var k = 1; k <= numPlayers; k++) {
                var seat = (button + k) % numPlayers;
                if (st.inHand[seat]) st.hole[seat].push(st.deck.shift());
            }
        }
        // blinds. Heads-up: button posts the small blind and acts first preflop.
        var sbSeat, bbSeat;
        if (activeSeatCount(st) === 2) {
            sbSeat = button; bbSeat = nextOccupied(st, button);
        } else {
            sbSeat = nextOccupied(st, button); bbSeat = nextOccupied(st, sbSeat);
        }
        putIn(st, sbSeat, sb);
        putIn(st, bbSeat, bb);
        st.currentBet = bb;
        st.minRaise = bb;
        st.bbSeat = bbSeat;
        // preflop opener = seat left of the big blind (UTG); heads-up = the SB/button.
        st.toAct = (activeSeatCount(st) === 2) ? sbSeat : nextToAct(st, bbSeat);
        return st;
    }
    function activeSeatCount(st) { var n = 0; for (var s = 0; s < st.numPlayers; s++) if (st.inHand[s]) n++; return n; }
    function nextOccupied(st, seat) {
        for (var k = 1; k <= st.numPlayers; k++) { var s = (seat + k) % st.numPlayers; if (st.inHand[s]) return s; }
        return seat;
    }

    // What can `seat` legally do right now?
    function legalActions(st, seat) {
        var out = { canFold: false, canCheck: false, canCall: false, callAmount: 0,
                    canRaise: false, minRaiseTo: 0, maxRaiseTo: 0 };
        if (st.street === "over" || st.street === "showdown") return out;
        if (seat !== st.toAct || !st.inHand[seat] || st.folded[seat] || st.allIn[seat]) return out;
        var toCall = st.currentBet - st.bet[seat];
        out.canFold = true;
        if (toCall <= 0) out.canCheck = true;
        else { out.canCall = true; out.callAmount = Math.min(toCall, st.stacks[seat]); }
        // A raise needs chips beyond the call. Min raise-to = currentBet + last raise size,
        // capped by the stack (a short stack can shove for less as an all-in).
        var maxTo = st.bet[seat] + st.stacks[seat];
        if (maxTo > st.currentBet) {
            out.canRaise = true;
            out.minRaiseTo = Math.min(maxTo, st.currentBet + st.minRaise);
            out.maxRaiseTo = maxTo;
        }
        return out;
    }

    // Apply an action for the seat to act. action = {type:"fold"|"check"|"call"|"raise", to?}.
    // Returns true on success. Advances the turn, closes the street, and runs showdown as
    // needed. Illegal actions are rejected (return false) so the server can validate.
    function applyAction(st, seat, action) {
        var la = legalActions(st, seat);
        var t = action.type;
        if (t === "fold") {
            if (!la.canFold) return false;
            st.folded[seat] = true;
        } else if (t === "check") {
            if (!la.canCheck) return false;
        } else if (t === "call") {
            if (!la.canCall) return false;
            putIn(st, seat, st.currentBet - st.bet[seat]);
        } else if (t === "raise" || t === "bet") {
            if (!la.canRaise) return false;
            var to = action.to | 0;
            // clamp: at least minRaiseTo (unless it's an all-in shove), at most the whole stack
            if (to > la.maxRaiseTo) return false;
            if (to < la.minRaiseTo && to !== la.maxRaiseTo) return false;
            var raiseSize = to - st.currentBet;
            putIn(st, seat, to - st.bet[seat]);
            // A full-size raise reopens the action; a short all-in that doesn't reach the
            // min-raise does NOT (matched players don't get to re-raise). Standard NLHE.
            if (raiseSize >= st.minRaise) st.minRaise = raiseSize;
            st.currentBet = Math.max(st.currentBet, st.bet[seat]);
            st.lastAggressor = seat;
            resetActedExcept(st, seat);
        } else {
            return false;
        }
        st.acted[seat] = true;
        advance(st);
        return true;
    }
    function resetActedExcept(st, seat) {
        for (var s = 0; s < st.numPlayers; s++) if (s !== seat) st.acted[s] = false;
    }

    // Is the current betting round complete?
    function roundOver(st) {
        for (var s = 0; s < st.numPlayers; s++) {
            if (!st.inHand[s] || st.folded[s] || st.allIn[s]) continue;
            if (!st.acted[s]) return false;
            if (st.bet[s] !== st.currentBet) return false;
        }
        return true;
    }

    function advance(st) {
        // everyone but one folded → that player wins the whole pot immediately
        if (activeCount(st) <= 1) { finish(st); return; }
        // at most one player can still act → no more betting; run out the board
        if (canActCount(st) <= 1 && roundOver(st)) { runout(st); return; }
        if (roundOver(st)) { nextStreet(st); return; }
        var nxt = nextToAct(st, st.toAct);
        st.toAct = nxt;
    }

    var STREETS = { preflop: "flop", flop: "turn", turn: "river", river: "showdown" };
    // Online the deck is empty and the board is filled from the server's BOARD events, so
    // dealing is a no-op here — betting never reads st.board, only the display does.
    function dealBoard(st, n) { if (st.online) return; for (var i = 0; i < n; i++) st.board.push(st.deck.shift()); }

    function nextStreet(st) {
        // clear the street's bets (committed already holds them for side pots)
        for (var s = 0; s < st.numPlayers; s++) { st.bet[s] = 0; st.acted[s] = false; }
        st.currentBet = 0; st.minRaise = st.bb; st.lastAggressor = -1;
        var nx = STREETS[st.street];
        if (nx === "flop") dealBoard(st, 3);
        else if (nx === "turn" || nx === "river") dealBoard(st, 1);
        st.street = nx;
        if (nx === "showdown") { showdown(st); return; }
        // if nobody can voluntarily act anymore, run the rest of the board out
        if (canActCount(st) <= 1) { runout(st); return; }
        st.toAct = firstLeftOfButton(st);
        if (st.toAct >= 0 && (st.folded[st.toAct] || st.allIn[st.toAct] || st.stacks[st.toAct] === 0))
            st.toAct = nextToAct(st, st.toAct);
    }

    // All betting is done but the board isn't complete (players all-in) → deal remaining
    // community cards and go to showdown.
    function runout(st) {
        while (st.street !== "showdown") {
            var nx = STREETS[st.street];
            if (nx === "flop") dealBoard(st, 3);
            else if (nx === "turn" || nx === "river") dealBoard(st, 1);
            st.street = nx;
        }
        showdown(st);
    }

    // Single player left (all others folded): they take the pot uncontested, no cards shown.
    function finish(st) {
        var winner = -1;
        for (var s = 0; s < st.numPlayers; s++) if (st.inHand[s] && !st.folded[s]) { winner = s; break; }
        var total = 0;
        for (s = 0; s < st.numPlayers; s++) total += st.committed[s];
        if (winner >= 0) st.stacks[winner] += total;
        st.pots = [{ amount: total, winners: winner >= 0 ? [winner] : [] }];
        st.result = { winners: winner >= 0 ? [winner] : [], uncontested: true };
        st.street = "over";
        st.toAct = -1;
    }

    // Build side pots from committed[], then award each pot to the best eligible hand(s).
    // ONLINE the hole cards aren't known during the betting replay (they arrive later as SHOW
    // events), so defer: freeze the hand at "showdown" with no result and let the client call
    // resolveShowdown(st) once it has populated st.hole from the events. Side pots are built
    // from committed[] (card-independent) so the deferred resolution is identical to the server.
    function showdown(st) {
        if (st.online && !st._resolving) { st.street = "showdown"; st.toAct = -1; return; }
        var contribs = st.committed.slice();
        var pots = [];
        while (true) {
            var min = Infinity, any = false, s;
            for (s = 0; s < st.numPlayers; s++) if (contribs[s] > 0) { any = true; if (contribs[s] < min) min = contribs[s]; }
            if (!any) break;
            var amount = 0, eligible = [];
            for (s = 0; s < st.numPlayers; s++) {
                if (contribs[s] > 0) {
                    amount += min; contribs[s] -= min;
                    if (!st.folded[s]) eligible.push(s);   // folded chips are dead money
                }
            }
            pots.push({ amount: amount, eligible: eligible });
        }
        // evaluate every contender once
        var scores = {};
        for (var i = 0; i < st.numPlayers; i++)
            if (st.inHand[i] && !st.folded[i]) scores[i] = evalSeat(st.hole[i], st.board);

        var resultPots = [];
        for (i = 0; i < pots.length; i++) {
            var p = pots[i];
            var best = null, winners = [];
            for (var j = 0; j < p.eligible.length; j++) {
                var seat = p.eligible[j], sc = scores[seat];
                if (!best || compareScores(sc, best) > 0) { best = sc; winners = [seat]; }
                else if (compareScores(sc, best) === 0) winners.push(seat);
            }
            distribute(st, p.amount, winners);
            resultPots.push({ amount: p.amount, winners: winners.slice() });
        }
        st.pots = resultPots;
        st.result = { winners: mergeWinners(resultPots), scores: scores, uncontested: false };
        st.street = "over";
        st.toAct = -1;
    }
    // Split a pot among winners; odd chips go to the first winner left of the button.
    function distribute(st, amount, winners) {
        if (winners.length === 0) return;
        var each = Math.floor(amount / winners.length);
        var rem = amount - each * winners.length;
        var ordered = winners.slice().sort(function (a, b) {
            return seatOrderFromButton(st, a) - seatOrderFromButton(st, b);
        });
        for (var i = 0; i < ordered.length; i++) st.stacks[ordered[i]] += each;
        for (i = 0; i < rem; i++) st.stacks[ordered[i]] += 1;
    }
    function seatOrderFromButton(st, seat) { return (seat - st.button + st.numPlayers) % st.numPlayers; }
    function mergeWinners(pots) {
        var set = {}, out = [];
        for (var i = 0; i < pots.length; i++) for (var j = 0; j < pots[i].winners.length; j++) set[pots[i].winners[j]] = 1;
        for (var k in set) if (set.hasOwnProperty(k)) out.push(parseInt(k, 10));
        return out;
    }
    function totalPot(st) { var t = 0; for (var s = 0; s < st.numPlayers; s++) t += st.committed[s]; return t; }

    // ONLINE showdown resolver: the client calls this after filling st.hole (from SHOW events)
    // and st.board (from BOARD events) for a hand that reached "showdown" via the deferred path
    // above. Runs the SAME side-pot + eval logic and awards the pots, so the online result is
    // identical to the server's without the client ever seeing the deck.
    function resolveShowdown(st) {
        if (st.street !== "showdown") return;
        st._resolving = true;
        showdown(st);
        st._resolving = false;
    }

    // ── bot ─────────────────────────────────────────────────────────────────────
    // A deterministic, honest-but-cautious bot. Preflop it rates its two cards; postflop it
    // rates its made hand's category. It calls small bets, raises with strength, and folds
    // weak hands to real pressure — plenty for a friendly table, no bluff modelling.
    function preflopStrength(hole) {
        var a = cardVal(hole[0]), b = cardVal(hole[1]);
        var hi = Math.max(a, b), lo = Math.min(a, b);
        var pair = a === b, suited = suitOf(hole[0]) === suitOf(hole[1]);
        var gap = hi - lo;
        var s = 0;
        if (pair) s = 0.5 + hi / 28;                       // 0.57 (22) … 1.0 (AA)
        else {
            s = (hi + lo) / 40;                            // high-card weight
            if (suited) s += 0.08;
            if (gap === 1) s += 0.06; else if (gap === 2) s += 0.03;
            if (hi === 14) s += 0.05;
        }
        return s;
    }
    function madeStrength(st, seat) {
        var sc = evalSeat(st.hole[seat], st.board);
        return sc[0] / 8 + (sc[1] || 0) / 200;             // category dominates, top rank breaks ties
    }
    function botAction(st, seat, rng) {
        var la = legalActions(st, seat);
        if (!la.canFold && !la.canCheck) return { type: "check" };
        var r = rng ? rng() : 0.5;
        var strength = (st.street === "preflop") ? preflopStrength(st.hole[seat]) : madeStrength(st, seat);
        var toCall = la.canCall ? la.callAmount : 0;
        var pot = totalPot(st);
        var potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;

        // strong hand → raise sometimes
        if (la.canRaise && strength > 0.6 && r < 0.6) {
            var target = st.currentBet + Math.max(st.minRaise, Math.floor(pot * (0.5 + strength * 0.5)));
            target = Math.min(target, la.maxRaiseTo);
            target = Math.max(target, la.minRaiseTo);
            return { type: "raise", to: target };
        }
        if (la.canCheck) {
            if (la.canRaise && strength > 0.72 && r < 0.5) {
                var t2 = Math.min(la.maxRaiseTo, Math.max(la.minRaiseTo, st.bb * 3));
                return { type: "raise", to: t2 };
            }
            return { type: "check" };
        }
        // facing a bet: call when the hand beats the pot odds (plus a margin), else fold
        if (la.canCall && strength >= potOdds + 0.15) return { type: "call" };
        if (la.canCall && toCall <= st.bb && strength > 0.25) return { type: "call" };  // cheap peek
        return { type: "fold" };
    }

    R.poker = {
        SUIT_CHARS: SUIT_CHARS, RANK_CHARS: RANK_CHARS, DECK_SIZE: DECK_SIZE,
        suitOf: suitOf, rankOf: rankOf, cardVal: cardVal, makeRng: makeRng, freshDeck: freshDeck,
        straightHigh: straightHigh, score: score, compareScores: compareScores, evalSeat: evalSeat,
        nextSeat: nextSeat, nextToAct: nextToAct, firstLeftOfButton: firstLeftOfButton,
        activeCount: activeCount, canActCount: canActCount, totalPot: totalPot,
        newHand: newHand, legalActions: legalActions, applyAction: applyAction,
        roundOver: roundOver, showdown: showdown, resolveShowdown: resolveShowdown,
        nextOccupied: nextOccupied, activeSeatCount: activeSeatCount,
        preflopStrength: preflopStrength, madeStrength: madeStrength, botAction: botAction
    };
})();
