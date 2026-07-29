"use strict";

/*
 * mg_games.js - shared infrastructure for the Deadlock Minigames mod.
 *
 * Contains ONLY the shared widgets and the game registry. Individual game controllers
 * live in their own files and self-register via MG.Games.register:
 *   mg_checkers.js  - Checkers (Russian + English draughts), game id 1
 *   mg_ttt.js       - Tic-Tac-Toe, game id 2
 *   mg_chess.js     - Chess, game id 4
 *   mg_durak.js     - Durak, game id 3
 *   mg_connectfour.js - Connect Four, game id 5
 *   mg_poker.js     - Poker, game id 6
 *
 * Load order (base_hud.xml): rules/* → mg_games → mg_checkers → mg_ttt → mg_chess
 *   → mg_durak → mg_connectfour → mg_poker → mg_ui
 *
 * Public: $.MG.Games.list  and  $.MG.Games.mount(gameId, container, session) -> {destroy}
 *   session = { code, isHost, onStatus(text) }
 */

(function () {
    var MG = ($.MG = $.MG || {});
    if (MG.Games) return;

    // The per-game rule aliases (checkers/ttt) that used to live here moved WITH their
    // controllers into mg_checkers.js / mg_ttt.js / mg_chess.js. This file keeps only the
    // shared widgets below (clock + per-turn timer + stub) and the game registry.

    // ── shared game clock (chess & checkers) ─────────────────────────────────
    // Two side clocks rendered above/below the board. There are two backing modes:
    //   ONLINE  - the SERVER owns the banks and even the CHOICE of whether there's a clock at
    //             all (Quick Match resolves the time control only once a joiner arrives). So the
    //             online clock is fully POLL-DISCOVERED: we build a hidden shell, poll
    //             /api/clocks ~1/s, reveal it on the first timed reply and render verbatim, or
    //             tear it down if the server says the lobby is untimed. `secs` is IGNORED online.
    //   OFFLINE (bot) - no server, so we tick locally from `secs`: the side to move drains, and
    //             when it hits 0 that side flags. secs=0 offline → no clock (a no-op stub).
    // onFlag(seat) fires once when a side runs out. seatNames labels each clock.
    function createClock(parent, secs, online, code, onFlag, seatNames, mySeat) {
        if (!online && !secs) return { el: null, setTurn: function () {}, stop: function () {}, isTimed: false };
        var flagged = -1, running = -1, stopped = false, revealed = false;
        var warned10 = false;          // TenSeconds sfx fires once when MY bank crosses 10s
        if (typeof mySeat !== "number") mySeat = -1;   // -1 = unknown → never beep (safe default)
        // Seconds banks (floats). OFFLINE: seeded from `secs`. ONLINE: null until the first
        // server resync fills them; from then on the display is driven by LOCAL interpolation
        // between resyncs (see interpTick), NOT by a per-second server poll.
        var sec = online ? [null, null] : [secs, secs];
        var lastTick = 0;              // Date.now() of the last local interpolation step
        var lastResync = 0;            // Date.now() of the last authoritative server read (online)

        var wrap = $.CreatePanel("Panel", parent, "");
        wrap.AddClass("mg-clocks");
        if (online) wrap.style.visibility = "collapse";   // hidden until the first timed poll reveals it
        var rows = [];
        // Build the two rows TOP→BOTTOM with MY seat at the bottom, so my clock sits under the
        // board I'm playing from (my colour is always the bottom side - see toDisplay). The `rows`
        // array stays SEAT-indexed (paint/setTurn/fireFlag are unchanged); only the visual creation
        // order changes. mySeat unknown (-1) keeps the legacy white-top/black-bottom order.
        var rowOrder = (mySeat === 0 || mySeat === 1) ? [1 - mySeat, mySeat] : [0, 1];
        for (var oi = 0; oi < 2; oi++) {
            var s = rowOrder[oi];
            var row = $.CreatePanel("Panel", wrap, "");
            row.AddClass("mg-clock-row");
            var name = $.CreatePanel("Label", row, ""); name.AddClass("mg-clock-name");
            name.text = (seatNames && seatNames[s]) || ("Seat " + (s + 1));
            var time = $.CreatePanel("Label", row, ""); time.AddClass("mg-clock-time");
            rows[s] = { row: row, time: time };
        }

        function fmt(sec) {
            sec = Math.max(0, Math.ceil(sec));
            var m = Math.floor(sec / 60), s = sec % 60;
            return m + ":" + (s < 10 ? "0" + s : s);
        }
        function paint(secArr) {
            for (var s = 0; s < 2; s++) {
                if (!rows[s].time.IsValid()) continue;
                rows[s].time.text = fmt(secArr[s]);
                rows[s].row.SetHasClass("mg-clock-active", s === running && flagged < 0);
                rows[s].row.SetHasClass("mg-clock-low", secArr[s] <= 10 && flagged < 0);
                rows[s].row.SetHasClass("mg-clock-flagged", s === flagged);
            }
        }
        function fireFlag(seat) {
            if (flagged >= 0) return;
            flagged = seat;
            if (onFlag) onFlag(seat);
        }

        // Interpolate the running seat's bank DOWN locally, ~4×/s. Drives the display in BOTH
        // modes: offline it's the sole authority (flags locally at 0); online it runs BETWEEN the
        // infrequent server resyncs so the seconds tick smoothly every frame without a network hit.
        // Online the SERVER owns flag-fall, so a locally-interpolated 0 just PINS at 0 (no local
        // fireFlag) until the next resync confirms it - interpolation drift must never mis-flag.
        function interpTick() {
            if (stopped || flagged >= 0) return;
            if (online && sec[0] === null) { $.Schedule(0.25, interpTick); return; } // await first resync
            var now = Date.now();
            if (running >= 0 && lastTick) {
                sec[running] = Math.max(0, sec[running] - (now - lastTick) / 1000);
                if (sec[running] === 0 && !online) fireFlag(running);
            }
            // Warn once when MY bank drops into the final 10s while it's running. A chess/checkers
            // bank only counts down, so this fires at most once per game. mySeat = -1 (unknown) skips.
            if (!warned10 && mySeat >= 0 && running === mySeat && sec[mySeat] !== null && sec[mySeat] <= 10) {
                warned10 = true;
                if (MG.Sound) MG.Sound.play("TenSeconds");
            }
            lastTick = now;
            paint(sec);
            if (!stopped && flagged < 0) $.Schedule(0.25, interpTick);
        }

        // ONLINE resync: fetch the authoritative banks and SNAP the local banks to them, correcting
        // any interpolation drift and applying the server's flag-fall. Deliberately INFREQUENT
        // (RESYNC_S): the clock is the only thing that used to poll continuously, and at 2 requests
        // per read it (a) swamped the strictly one-at-a-time image queue - stalling the move-poll so
        // an opponent's move surfaced many seconds late, the "20s to see a move" desync - and (b)
        // burned the daily request budget (2 short games ≈ 1200 requests came almost entirely from
        // this loop). Interpolating locally between rare resyncs keeps the display live for ~free.
        // Reveals the shell on the first timed reply; tears it down if the lobby is untimed.
        var RESYNC_S = 8;
        function resyncTick() {
            if (stopped) return;
            MG.Api.clocks(code, function (r) {
                if (stopped) return;
                if (r) {
                    if (!revealed && wrap.IsValid()) { wrap.style.visibility = "visible"; revealed = true; }
                    sec = [r.sec[0], r.sec[1]];        // snap to authoritative values
                    lastTick = Date.now();
                    if (r.flag >= 0) { running = -1; paint(sec); fireFlag(r.flag); return; }
                    paint(sec);
                    $.Schedule(RESYNC_S, resyncTick);
                } else {
                    // Server says this lobby has no clock - remove the empty shell and stop polling.
                    stopped = true;
                    if (!revealed) { try { wrap.DeleteAsync(0); } catch (e) {} }
                }
                // Before the first reveal a transport hiccup should retry soon (don't leave the
                // clock invisible for 8s); once revealed, resume the slow authoritative cadence.
            }, function () { if (!stopped) $.Schedule(revealed ? RESYNC_S : 1.2, resyncTick); });
        }

        lastTick = Date.now();
        interpTick();
        if (online) resyncTick();

        return {
            el: wrap,
            isTimed: true,
            // Set which seat's clock is running (the side to move). Banks the elapsed time to the
            // seat that was running, then switches. Works identically online and offline now - the
            // local interpolation is accurate at turn granularity, and the ~8s resync corrects any
            // drift against the authoritative server banks.
            setTurn: function (seat) {
                if (running >= 0 && lastTick && sec[running] !== null) {
                    sec[running] = Math.max(0, sec[running] - (Date.now() - lastTick) / 1000);
                }
                running = seat; lastTick = Date.now();
            },
            stop: function () { stopped = true; }
        };
    }

    // ── shared per-turn countdown timer (durak / poker / connect-four / tic-tac-toe) ──
    // A slim VERTICAL bar to the LEFT of the board that drains top→bottom over TURN_SECS,
    // with the whole-seconds remaining shown beneath it. Unlike the chess/checkers side
    // clocks (two banks, server-authoritative), this is a SINGLE bar that runs ONLY while
    // it's the LOCAL player's turn: the controller calls start(onExpire) when the human is
    // put on the clock and stop() the instant they act (or a bot / online opponent takes
    // over). If the bar empties, onExpire() fires exactly once - the controller turns that
    // into a forfeit / elimination (offline it decides locally; online it sends a forfeit).
    //
    // NO @keyframes (ARCHITECTURE §17 - a stray @keyframes rule silently BRICKS the whole
    // modded HUD stylesheet). The drain is ONE `transform: translate3d(0, H, 0)` write with
    // a TURN_SECS-long LINEAR transition that lives on the .mg-tt-anim class (the
    // .mg-piece "set the value, let CSS tween it" idiom): a single assignment starts a smooth
    // slide with zero per-frame JS. A ~200ms $.Schedule loop only refreshes the seconds
    // label + swaps the low/crit colour classes and arms the expiry - the motion is pure CSS.
    //
    // The wrap is ALWAYS laid out (never visibility:collapse) so the empty channel reserves its
    // footprint permanently - the widget never pops in/out and the modal never jumps height when
    // a turn changes hands. Only the FILL + the seconds label toggle (opacity/text) between "my
    // turn" (draining) and idle (blank channel). TRACK_H is kept shorter than the shortest board
    // (TTT ≈336px) so the flow:none host always measures its height from the board, not the bar.
    //
    // opts.boardW (px): attach the bar to that board's LEFT EDGE (centre-align + translateX left
    // by half the board + a gap) instead of the modal's far-left gutter. TTT/C4 pass it (their
    // boards are narrow and centred, so the gutter looked detached); durak/poker omit it and keep
    // the wide-felt gutter placement the maintainer already signed off on.
    var TURN_SECS = 25;                    // per-turn budget; matches .mg-tt-anim transition-duration in mg.css
    function createTurnTimer(parent, opts) {
        var TRACK_H = 280;                 // px; MUST match .mg-tt-track height in mg.css (drain distance)
        var wrap = $.CreatePanel("Panel", parent, "");
        wrap.AddClass("mg-turn-timer");
        // Position the wrap with ONE inline transform (inline beats any CSS transform):
        //  • Y: the wrap is vertical-align:center in the flow:none host, but it's flow-children:down
        //    (track 280 + 6 gap + 22 num = 308 tall), so the TRACK's centre sits half the below-track
        //    stack - (6+22)/2 = 14px - ABOVE the wrap centre, i.e. 14px above the board centre. Nudge
        //    the whole wrap DOWN 14px so the BAR (not the wrap box) is centred on the board. (Was the
        //    "timer sits above the board centre" report, 2026-07-20.)
        //  • X: with opts.boardW, pin the bar to that board's LEFT EDGE (centre-align via
        //    .mg-tt-attached, then shove left by half the board + a gap). TTT/C4 pass it (narrow
        //    centred boards - the far-left gutter looked detached). Poker/durak omit it: their felts
        //    are wide (760/680) so a board-edge shove would push the bar off the modal's left margin,
        //    and the left gutter already sits right at the felt's edge - keep the gutter placement.
        var VNUDGE = 14;                   // (num margin-top 6 + num height 22) / 2 - see mg.css .mg-tt-num
        var vx = 0;
        if (opts && opts.boardW) {
            // .mg-tt-attached centres the wrap in the 844px inner zone; shove it left so its RIGHT
            // edge sits GAP px before the board's left edge. Wide felts (poker 760) leave < 48px of
            // margin, so clamp the shove: the wrap's LEFT edge never crosses EDGE px from the modal's
            // left (else the bar clips off-screen). Centre = INNER_W/2; wrapLeft = Centre + vx - W/2.
            var GAP = 14, TIMER_W = 34, INNER_W = 844, EDGE = 4;
            wrap.AddClass("mg-tt-attached");
            vx = -(opts.boardW / 2 + GAP + TIMER_W / 2);
            var minVx = EDGE + TIMER_W / 2 - INNER_W / 2;   // keeps wrapLeft >= EDGE
            if (vx < minVx) vx = minVx;
        }
        wrap.style.transform = "translate3d(" + vx + "px, " + VNUDGE + "px, 0px)";
        var track = $.CreatePanel("Panel", wrap, "");
        track.AddClass("mg-tt-track");
        var fill = $.CreatePanel("Panel", track, "");
        fill.AddClass("mg-tt-fill");
        fill.style.opacity = "0.0";           // idle: only the empty channel shows (footprint reserved)
        var num = $.CreatePanel("Label", wrap, "");
        num.AddClass("mg-tt-num");

        var gen = 0;                       // bumps on every start/stop/destroy → stale ticks bail
        var dead = false, running = false, deadline = 0, expireCb = null;
        var curSecs = TURN_SECS;           // budget for the CURRENT run (start may override per call)
        var warned10 = false;              // TenSeconds sfx fires once per turn as the bar crosses 10s

        // Snap the fill FULL (no transition) so a fresh turn starts from a full bar; the arm()
        // below then flips on the animated class and pushes it to empty, tweening over TURN_SECS.
        function snapFull() {
            // Kill the transition duration FIRST, then drop the classes. arm() leaves an inline
            // "<secs>s, 0.3s" list behind, and once .mg-tt-anim is off, the effective
            // transition-property is the base rule's single `background-color` - which consumes that
            // list's FIRST entry. So removing the red class with the stale list still in place gave
            // the colour 25 SECONDS: it crawled from red back to green, and the next turn opened red
            // (maintainer, in-game: "wait for red, move, and the new turn is red too").
            // "0s" rather than "0.3s" because this is a SNAP - a fresh turn must start green with no
            // visible fade, and a zero duration cannot crawl no matter how the lists line up.
            // (transition-duration: 0s is standard in the game's own CSS.)
            fill.style.transitionDuration = "0s";
            fill.RemoveClass("mg-tt-anim");
            fill.RemoveClass("mg-tt-low");
            fill.RemoveClass("mg-tt-crit");
            fill.style.transform = "translate3d(0px, 0px, 0px)";
            fill.style.opacity = "1.0";       // reveal the drain for my turn
        }
        function arm() {
            fill.AddClass("mg-tt-anim");
            // The drain duration lives in CSS (.mg-tt-fill.mg-tt-anim = 25s) but callers may pass a
            // shorter budget (durak's 10s Bito window). Override the transform leg inline so the slide
            // matches curSecs; the colour leg keeps its quick cross-fade. Order MUST match the CSS
            // transition-property list (transform, background-color). This also restores a real
            // duration after snapFull zeroed it, so the low/crit recolours during the turn still fade.
            fill.style.transitionDuration = curSecs + "s, 0.3s";
            fill.style.transform = "translate3d(0px, " + TRACK_H + "px, 0px)";   // drain top→bottom over curSecs
        }

        function tick(myGen) {
            if (dead || myGen !== gen || !running) return;
            var remain = (deadline - Date.now()) / 1000;
            if (remain <= 0) {
                running = false;
                if (num.IsValid()) num.text = "0";
                var cb = expireCb; expireCb = null;
                if (cb) cb();
                return;
            }
            if (num.IsValid()) num.text = String(Math.ceil(remain));
            fill.SetHasClass("mg-tt-low", remain <= 10);
            fill.SetHasClass("mg-tt-crit", remain <= 5);
            // Warn ONCE as the clock crosses into the final 10s (only if the turn had more than
            // 10s to begin with - durak's 10s Bito window would otherwise beep the instant it opens).
            if (!warned10 && remain <= 10 && curSecs > 10) {
                warned10 = true;
                if (MG.Sound) MG.Sound.play("TenSeconds");
            }
            $.Schedule(0.2, function () { tick(myGen); });
        }

        return {
            el: wrap,
            // Put the human on the clock. onExpire fires once if the bar empties first. `secs`
            // optionally overrides the default TURN_SECS budget (0/undefined → TURN_SECS); durak's
            // optional Bito window passes 10.
            start: function (onExpire, secs) {
                if (dead) return;
                gen++;
                var myGen = gen;
                running = true;
                curSecs = (secs && secs > 0) ? secs : TURN_SECS;
                warned10 = false;
                expireCb = onExpire || null;
                deadline = Date.now() + curSecs * 1000;
                snapFull();               // reveals the fill (opacity) - the wrap is always laid out
                num.text = String(curSecs);
                // Arm the CSS drain one frame later (the .mg-piece/.mg-anim arming trick): the
                // full-snap must commit first, or the browser coalesces both writes and the bar
                // jumps straight to empty with no slide.
                $.Schedule(0.0, function () { if (!dead && gen === myGen && running) arm(); });
                $.Schedule(0.2, function () { tick(myGen); });
            },
            // Take the human off the clock (they acted, or it's someone else's turn). Fades the
            // fill + blanks the seconds (the empty channel stays, keeping the footprint) and
            // cancels the pending expiry so a slow action can't fire a stale timeout.
            stop: function () {
                gen++;                     // invalidate any in-flight tick + arm
                running = false;
                expireCb = null;
                fill.style.transitionDuration = "0s";      // BEFORE the classes - see snapFull
                fill.RemoveClass("mg-tt-anim");
                fill.RemoveClass("mg-tt-low");
                fill.RemoveClass("mg-tt-crit");
                fill.style.transform = "translate3d(0px, 0px, 0px)";
                fill.style.opacity = "0.0";   // idle: only the empty channel shows
                if (num.IsValid()) num.text = "";
            },
            destroy: function () {
                dead = true; gen++; running = false; expireCb = null;
                try { wrap.DeleteAsync(0); } catch (e) {}
            }
        };
    }


    // ── placeholder for not-yet-built games ─────────────────────────────────
    function createStub(container, session, name) {
        var root = $.CreatePanel("Panel", container, "MG_Stub");
        root.AddClass("mg-stub");
        var l = $.CreatePanel("Label", root, "");
        l.AddClass("mg-stub-label");
        l.text = (name || "This game") + ": coming soon.";
        return { destroy: function () { try { root.DeleteAsync(0); } catch (e) {} } };
    }

    // ── game registry ────────────────────────────────────────────────────────
    // The picker reads `list` (id/key/name/enabled); `mount` dispatches to a factory
    // registered under the game's id. Games self-register their factory via
    // `register(...)` so a new game (e.g. Durak in mg_durak.js) can live in its own
    // file: it just calls MG.Games.register(...) after this script has run - no edit
    // to the dispatch here. A game with no registered factory falls back to the stub.
    MG.Games = {
        list: [
            { id: 1, key: "checkers", name: "Checkers", enabled: true },
            // `short` is the compact label for the game-screen HEADER only (setTitle); the picker
            // card keeps the full `name`. TTT / Connect 4 are long enough to want a shorter header.
            { id: 2, key: "tictactoe", name: "Tic-Tac-Toe", short: "TTT", enabled: true },
            { id: 3, key: "durak", name: "Durak", enabled: false },
            { id: 4, key: "chess", name: "Chess", enabled: true },
            { id: 5, key: "connectfour", name: "Connect Four", short: "Connect 4", enabled: false },
            { id: 6, key: "poker", name: "Poker", short: "Hold'em", enabled: true },
            { id: 7, key: "pixelbattle", name: "Pixel Battle", enabled: false },
            { id: 8, key: "wordle", name: "Wordle", enabled: false },
            { id: 9, key: "soon4", name: "Coming Soon", enabled: false },
            { id: 10, key: "soon5", name: "Coming Soon", enabled: false },
            { id: 11, key: "soon6", name: "Coming Soon", enabled: false },
            { id: 12, key: "soon7", name: "Coming Soon", enabled: false }
        ],
        _factories: {},
        byId: function (id) {
            var l = this.list;
            for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
            return null;
        },
        // opts = { id, create, enabled? }. Registers the mount factory for a game and
        // optionally flips its `enabled` flag (so a game file can enable itself only
        // once its factory is actually present).
        register: function (opts) {
            if (!opts || opts.id == null || typeof opts.create !== "function") return;
            this._factories[opts.id] = opts.create;
            if (typeof opts.enabled === "boolean") {
                var g = this.byId(opts.id);
                if (g) g.enabled = opts.enabled;
            }
        },
        mount: function (gameId, container, session) {
            var f = this._factories[gameId];
            if (f) return f(container, session);
            var g = this.byId(gameId);
            return createStub(container, session, g ? g.name : null);
        }
    };

    // Draw an image INSIDE `container` (creating the child <Image> on first use and caching it on
    // the panel), rather than setting container.style.backgroundImage. A Panel background paints
    // the .vtex at its native pixel size until the panel is re-laid-out, which is the ~300%
    // first-frame zoom this codebase kept hitting; a child <Image> sizes to its CSS box from frame
    // one. Used for card faces/backs (durak, poker), chess pieces and the picker card art - four
    // byte-identical copies of this lived in mg_chess/mg_durak/mg_poker/mg_ui.
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

    // ── board-widget helpers shared by chess and checkers ────────────────────
    // Only genuinely STATE-FREE helpers live here. The rest of those two files' drag/review
    // stacks (squareFromWindow, dropSquare, renderReview, tryPremove, …) read the controller's
    // own closure - board, cells, piecesLayer, history, myColor - so they are not extractable
    // without inventing a context object, and several that LOOK identical are not: sqName uses
    // colOf vs cCol, clockNames compares myColor against WHITE vs 1. Moving those on the
    // assumption that they matched would have silently broken one of the two games.

    // A panel's window-space position, or null. GetPositionWithinWindow returns either {x,y} or
    // an array depending on build, and can hand back an FLT_MAX sentinel for a panel that has not
    // been laid out yet - both are normalised here so callers only see a usable point or null.
    function winPos(panel) {
        if (!panel || !panel.GetPositionWithinWindow) return null;
        var r;
        try { r = panel.GetPositionWithinWindow(); } catch (e) { return null; }
        if (!r) return null;
        var x = (typeof r.x === "number") ? r.x : (typeof r[0] === "number" ? r[0] : null);
        var y = (typeof r.y === "number") ? r.y : (typeof r[1] === "number" ? r[1] : null);
        if (x === null || y === null || !isFinite(x) || !isFinite(y)) return null;
        if (Math.abs(x) > 100000 || Math.abs(y) > 100000) return null; // FLT_MAX sentinel
        return { x: x, y: y };
    }

    // First number out of a CSS length string ("60px", "-12.5px" → 60, -12.5), or null.
    function parsePx(v) {
        if (typeof v !== "string" || !v.length) return null;
        var m = v.match(/-?\d+(\.\d+)?/);
        return m ? parseFloat(m[0]) : null;
    }

    // Walk up from `panel` looking for a board cell id ("cell_<0..63>"), so a drop that landed on
    // a child (a piece image, a highlight) still resolves to its square. -1 if none within 6 hops.
    function squareFromPanel(p) {
        for (var hops = 0; p && hops < 6; hops++) {
            var id = null;
            try { id = p.id; } catch (e) {}
            if (id && id.indexOf("cell_") === 0) {
                var n = parseInt(id.substring(5), 10);
                if (isFinite(n) && n >= 0 && n < 64) return n;
            }
            try { p = p.GetParent ? p.GetParent() : null; } catch (e2) { p = null; }
        }
        return -1;
    }

    // Move-list navigation buttons (◀ ▶ live).
    function makeNavBtn(parent, text, onClick) {
        var b = $.CreatePanel("Button", parent, "");
        b.AddClass("mg-nav-btn");
        var l = $.CreatePanel("Label", b, ""); l.text = text;
        b.SetPanelEvent("onactivate", onClick);
        return b;
    }
    function setNavState(btn, enabled) {
        if (!btn) return;
        if (enabled) btn.RemoveClass("mg-nav-disabled"); else btn.AddClass("mg-nav-disabled");
    }

    // Shared widget factories reused by the separate game files via MG.Widgets - they can't
    // see this file's closure otherwise. createTurnTimer: durak / poker / connect-four / ttt.
    // createClock: checkers / chess (the two-side game clock). createStub: the picker fallback.
    MG.Widgets = MG.Widgets || {};
    MG.Widgets.createTurnTimer = createTurnTimer;
    MG.Widgets.createClock = createClock;
    MG.Widgets.createStub = createStub;
    MG.Widgets.setFace = setFace;
    MG.Widgets.winPos = winPos;
    MG.Widgets.parsePx = parsePx;
    MG.Widgets.squareFromPanel = squareFromPanel;
    MG.Widgets.makeNavBtn = makeNavBtn;
    MG.Widgets.setNavState = setNavState;
    MG.Widgets.TURN_SECS = TURN_SECS;

    // Built-in game controllers now live in their OWN files (mg_checkers / mg_ttt / mg_chess),
    // loaded after this one in base_hud.xml; each self-registers via MG.Games.register(...),
    // exactly like mg_durak / mg_connectfour / mg_poker.
})();
