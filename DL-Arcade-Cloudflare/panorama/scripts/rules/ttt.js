"use strict";

/*
 * rules/ttt.js - pure Tic-Tac-Toe rules, shared by client predictor + server authority.
 * See rules/checkers.js header for the shared-namespace mechanism.
 *
 * Board is a flat length-9 array: 0 empty, 1 = X, 2 = O. Cells index left→right,
 * top→bottom (0..8). Host plays X and moves first.
 */

(function () {
    let R;
    if (typeof $ !== "undefined" && $) {
        const MG = ($.MG = $.MG || {});
        R = (MG.Rules = MG.Rules || {});
    } else if (typeof globalThis !== "undefined") {
        R = (globalThis.MGRules = globalThis.MGRules || {});
    } else {
        R = (this.MGRules = this.MGRules || {});
    }

    const TTT_LINES = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],   // rows
        [0, 3, 6], [1, 4, 7], [2, 5, 8],   // cols
        [0, 4, 8], [2, 4, 6]               // diagonals
    ];

    // Returns { mark, line } for the first completed line, or null.
    function tttWinner(b) {
        for (let i = 0; i < TTT_LINES.length; i++) {
            const L = TTT_LINES[i], v = b[L[0]];
            if (v && v === b[L[1]] && v === b[L[2]]) return { mark: v, line: L };
        }
        return null;
    }

    function tttFull(b) {
        for (let i = 0; i < 9; i++) if (!b[i]) return false;
        return true;
    }

    // If `mark` has a one-move win available, return that cell; else -1.
    function tttFindWin(b, mark) {
        for (let i = 0; i < 9; i++) {
            if (b[i]) continue;
            b[i] = mark;
            const w = tttWinner(b);
            b[i] = 0;                      // restore - this must not mutate the board
            if (w && w.mark === mark) return i;
        }
        return -1;
    }

    // Heuristic bot: win > block > center > corner > side. Strong but not a full
    // minimax, so a sharp human can still fork it - deliberately beatable.
    function tttBotMove(b, mark) {
        const opp = mark === 1 ? 2 : 1;
        let pick = tttFindWin(b, mark); if (pick >= 0) return pick;   // 1) take the win
        pick = tttFindWin(b, opp);      if (pick >= 0) return pick;   // 2) block theirs
        if (!b[4]) return 4;                                          // 3) center
        const corners = [0, 2, 6, 8];
        for (let i = 0; i < 4; i++) if (!b[corners[i]]) return corners[i]; // 4) corner
        const sides = [1, 3, 5, 7];
        for (let j = 0; j < 4; j++) if (!b[sides[j]]) return sides[j];     // 5) side
        return -1;                                                    // board full
    }

    R.ttt = {
        TTT_LINES: TTT_LINES,
        tttWinner: tttWinner, tttFull: tttFull, tttBotMove: tttBotMove
    };
})();
