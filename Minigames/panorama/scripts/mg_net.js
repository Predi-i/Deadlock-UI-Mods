"use strict";

/*
 * mg_net.js - image side-channel network facade for the Deadlock Minigames mod.
 *
 * Panorama UI has no fetch / AsyncWebRequest / websockets. The only way to read data
 * back from a server is the intrinsic pixel size of an <Image>: we set the image src
 * (sending data via URL params - unlimited) and poll actuallayoutwidth/height to read
 * the response, which the server encoded as the image's (width, height).
 *
 * Everything shared across the mod's scripts hangs off $.MG (the $ object is the one
 * global shared between all scripts loaded in the same panel - see tengu.js's
 * $.HeroWinLose pattern).
 *
 * Public API:
 *   $.MG.Net.isConfigured()                     -> false until BASE_URL is set
 *   $.MG.Net.request(path, params, onDone, onErr)  raw (w,h) after swap+scale decode
 *   $.MG.Net.loadImage(url, onDone, onErr, attrs)  ordinary image through the same FIFO
 *   $.MG.Session.newToken()                     -> a fresh high-entropy seat token
 *   $.MG.Api.create(game, tok, cb(code), err)
 *   $.MG.Api.quick(game, tok, cb({role,code}), err)   role = "host" | "joiner"
 *   $.MG.Api.mquick(games[], tok, cb({role,code}), err)   multi-select; game learned via status
 *   $.MG.Api.cancel(code, cb(ok), err)
 *   $.MG.Api.join(code, tok, cb({ok,game,reason}), err)
 *   $.MG.Api.status(code, tok, cb({gone,players,game}), err) game = fixed game (0 while undecided)
 *   $.MG.Api.move(code, from, to, end, tok, cb({ok,reason}), err)   reason: turn|illegal|token|gone
 *   $.MG.Api.poll(code, since, cb(move|null), err)      move = {from,to,end,seq}
 *   $.MG.Api.reset(code, game, tok, cb(ok), err)
 *   $.MG.Api.room(code, tok, cb({gone,players,started}), err)       Durak online room state
 *   $.MG.Api.start(code, tok, cb({ok,reason}), err)                 Durak host starts/deals
 *   $.MG.Api.dact(code, tok, a, pair, card, cb({ok,reason}), err)   Durak public action
 *   $.MG.Api.dlog(code, since, cb(event|null), err)                 Durak public event log
 *   $.MG.Api.ddraw(code, tok, index, cb(card|null), err)            Durak private draw log
 *   $.MG.Api.pcreate(cap, tok, cb({code,cap}), err)                 Poker private lobby (2-4 seats)
 *   $.MG.Api.pjoin(code, tok, cb({ok,seat,cap,reason}), err)        Poker join (learns own seat)
 *   $.MG.Api.proom(code, tok, cb({gone,players,cap,started}), err)  Poker room state
 *   $.MG.Api.pstart(code, tok, cb({ok,reason}), err)                Poker host starts/deals
 *   $.MG.Api.pact(code, tok, a, to, cb({ok,reason}), err)           Poker betting action (0f/1chk/2call/3raise)
 *   $.MG.Api.pnext(code, tok, cb({ok,reason}), err)                 Poker deal next hand
 *   $.MG.Api.plog(code, since, cb(event|null), err)                 Poker public event log
 *   $.MG.Api.pdraw(code, tok, index, cb(card|null), err)            Poker private hole-card draw
 *   $.MG.Api.geoState(code, tok, cb(state), err)                    GeoGuesser round/reveal state
 *   $.MG.Api.geoGuess(code, tok, cell, cb(result), err)             authoritative map guess
 *   $.MG.Api.geoNext(code, tok, cb(result), err)                    next-round ready handshake
 *   $.MG.Api.geoTarget/geoPick/geoScore/geoInfo(...)                reveal-only round data
 *
 * The seat token (tok) is the identity that makes the server authoritative: it flows
 * ONLY upward (query param), never in a response, so it can't leak through the 2-int
 * downlink and can't be guessed. See $.MG.Session below.
 */

(function () {
    var MG = ($.MG = $.MG || {});
    if (MG.Net) return; // already initialised

    // ─────────────────────────────────────────────────────────────────────────
    // Production backend: direct HTTPS to the Aéza VPS (no Cloudflare Worker/proxy).
    var BASE_URL = "https://178.236.246.13";
    // ─────────────────────────────────────────────────────────────────────────

    var REQ_TIMEOUT_MS = 8000;
    var POLL_STEP = 0.05;   // seconds between dimension checks

    // ── shared opponent-poll cadence (single source of truth for all games) ──
    // Every online game polls /api/poll to learn the opponent's move. Polling is the
    // dominant request cost of a match, so the cadence is tuned here once and reused by
    // every online game. The direct VPS lets the active tiers be much quicker than the old
    // Worker-budget cadence, but the idle tier still backs off: on the shared 1-vCPU plan,
    // 300 clients at an unbounded 3-4 req/s would consume the whole measured throughput.
    //   misses 0..(FAST_POLLS-1) → POLL_FAST_S ; then POLL_SLOW_S ; a long think → POLL_IDLE_S
    // `misses` = consecutive empty ("nothing new") polls this turn; reset to 0 on each real
    // move so the next wait starts fast again. Transport errors reuse the same schedule.
    var POLL_FAST_S = 0.5, POLL_SLOW_S = 0.9, POLL_IDLE_S = 1.5, FAST_POLLS = 6, SLOW_POLLS = 18;
    function pollDelay(misses) {
        if (misses < FAST_POLLS) return POLL_FAST_S;   // first ~3s: rapid replies surface quickly
        if (misses < SLOW_POLLS) return POLL_SLOW_S;   // steady through the rest of a normal turn
        return POLL_IDLE_S;                            // long think: retain capacity for 200-300 users
    }

    // ── shared WAITING-ROOM cadence (lobbies, rematch, matchmaking) ──────────
    // A completely different cost profile from in-game polling: nobody's mid-move, we're just
    // waiting for a friend to type a code / click Join / accept a rematch. Latency here is
    // irrelevant (a chess lobby, not a shooter - 1s vs 5s to notice a join is unnoticeable), and
    // these screens can sit OPEN for minutes, so a fixed ~1s poll is pure waste that scales with
    // idle players, not games played. Ramp HARD: a couple of quick checks, then settle to 5s.
    //   misses:  0    1    2    3    4    5+
    //   delay:  1.5  1.5  3.0  3.0  4.0  5.0   (seconds)
    // Monotonic - a waiting room has no "real move" to reset on; it just resolves when it fills.
    var WAIT_STEPS = [1.5, 1.5, 3.0, 3.0, 4.0, 5.0];
    function waitDelay(misses) {
        var i = misses < 0 ? 0 : (misses < WAIT_STEPS.length ? misses : WAIT_STEPS.length - 1);
        return WAIT_STEPS[i];
    }

    // ── Downlink level encoding - MUST match worker.core.js `d()` exactly ──
    // A response dimension carries a small "level", not a raw int: dim = level*STEP + BASE.
    // The old dim=int+1 scheme died on UI-scaled displays (the engine biases small sizes
    // up ~1px, so value 1 rendered as 2 - corrupting corner-square moves, the (1,1) marker,
    // and every code half). STEP=9 spaces adjacent levels 9 logical px apart so a ±2px
    // engine error can't cross a boundary even when a sub-1080p display downscales. Safe
    // range is levels 0..63 (63*9+15 = 582px < the 600px probe envelope, so the host panel
    // is never clamped). Proven 720p–8K by tools/mg_simulate_resolutions.js. The probe is
    // NOT level-encoded - it stays a literal 600x1000 and is read via rawRequest, bypassing
    // decode(). See github2/IMAGE_SIDECHANNEL_1PX_BUG.md.
    var STEP = 9, BASE = 15;

    // Host panel styled size (layout units). Parsed by the resolution simulator's drift
    // guard, so the two stay in lockstep. Response images (all <= 582px) never exceed it.
    var HOST_W = 640, HOST_H = 1020;

    // Debug logging. Ships OFF. When toggled on (overlay tools → Debug Log) every step is
    // written to Deadlock's dev CONSOLE via $.Msg - no on-screen panel. When OFF, nothing
    // is emitted at all (not even the routine step logs). Lines are still buffered so a
    // later toggle-on can dump recent history to the console.
    var DEBUG = false;
    var dbgLines = [];
    function debug(msg) {
        dbgLines.push(msg);
        if (dbgLines.length > 40) dbgLines.shift();
        if (DEBUG) { try { $.Msg("[MG] " + msg); } catch (e) {} }
    }

    function setDebug(on) {
        DEBUG = !!on;
        if (DEBUG) {
            // Dump buffered history so turning it on shows what already happened.
            try {
                $.Msg("[MG] debug ON - recent history:");
                for (var i = 0; i < dbgLines.length; i++) $.Msg("[MG] " + dbgLines[i]);
            } catch (e) {}
        }
    }

    // Routine internal log: goes to the console ONLY in debug mode (via debug()).
    function log(msg) { debug(msg); }
    MG.debug = debug; // shared: mg_ui.js routes its logs here too

    // Host that carries the request images. It MUST be on-screen and not culled -
    // an off-screen / zero-opacity / occluded panel makes Panorama skip the image
    // load entirely (which is why nothing reached the server before). It also MUST
    // be larger than the biggest response image (the 600x1000 probe): Panorama
    // clamps a child image to the parent's bounds, and a clamped probe reads as the
    // host's size, mis-calibrating the scale and corrupting every decode after it.
    // The panel itself has no background and images render at 2% opacity, so the
    // large footprint stays invisible.
    var host = null;
    function ensureHost() {
        if (host && host.IsValid && host.IsValid()) return host;
        var ctx = $.GetContextPanel();
        host = $.CreatePanel("Panel", ctx, "MG_NetHost");
        try {
            host.style.position = "2px 2px 0px";
            host.style.width = HOST_W + "px";
            host.style.height = HOST_H + "px";
            host.style.opacity = "0.02";
            host.style.zIndex = "99999";
        } catch (e) { log("✗ host style exc: " + (e && e.message ? e.message : e)); }
        // hittest=false alone still lets the child <Image> panels intercept hover,
        // which broke every escape-menu setting's hover once the host grew to
        // 640x1020 and sat over the menu. hittestchildren=false makes the whole
        // subtree transparent to input so hover passes through to the menu below.
        try { host.SetAttributeString("hittest", "false"); } catch (e) {}
        try { host.SetAttributeString("hittestchildren", "false"); } catch (e) {}
        return host;
    }

    // Tear the host down whenever no request needs it. Left alive, its 640x1020
    // invisible footprint lingered over the escape menu and killed hover on every
    // setting. Calibration state (swap/scaleX/scaleY) lives in vars, not the panel,
    // so dropping it costs nothing - the next request recreates it via ensureHost.
    function releaseHost() {
        if (!host) return;
        try { host.DeleteAsync(0); } catch (e) {}
        host = null;
    }

    var reqCounter = 0;

    // ── request serialization ───────────────────────────────────────────────
    // Panorama's image loader wedges when several <Image> loads are in flight at once
    // (the connections from prior requests don't free up before new ones fire, and every
    // pending load then stalls at dims 0 until it times out). So we run requests strictly
    // ONE AT A TIME through a FIFO queue - the poll loop + user actions can never overlap.
    var reqQueue = [];
    var reqActive = false;

    function rawRequest(path, params, onDone, onError) {
        reqQueue.push({ kind: "protocol", path: path, params: params, onDone: onDone, onError: onError });
        drainQueue();
    }

    // Load a normal image through the SAME FIFO as the dimension-encoded API. On
    // success ownership of the already-loaded <Image> passes to the caller, which
    // may re-parent it into the visible UI or delete it after inspecting its
    // intrinsic dimensions. This is the only safe way for update markers and
    // Pixel Battle frames to coexist with protocol traffic: Panorama can wedge
    // every image when two independent SetImage loads overlap.
    function loadImage(url, onDone, onError, attributes) {
        reqQueue.push({
            kind: "image", url: url, onDone: onDone, onError: onError,
            attributes: attributes || null
        });
        drainQueue();
    }
    function drainQueue() {
        if (reqActive) return;
        var job = reqQueue.shift();
        if (!job) { releaseHost(); return; } // idle: drop the host so it stops covering the menu
        reqActive = true;
        var success = function (a, b, c) {
            // Keep reqActive latched through the callback and release frame. Callbacks
            // commonly enqueue their next poll synchronously; clearing it here would let
            // that request bypass the intended gap and start inside this callback.
            try {
                if (job.onDone) {
                    if (job.kind === "image") job.onDone(a, b, c);
                    else job.onDone(a, b);
                }
            } finally {
                $.Schedule(0.05, function () { reqActive = false; drainQueue(); });
            }
        };
        var failure = function (e) {
            // The Panorama image loader is intermittently flaky (a URL that loads
            // instantly in a browser sometimes stalls to a timeout here). One silent
            // re-queue at the front of the line recovers most of those. This is a
            // mitigation, not a proven fix - it can't be verified without in-game runs.
            job.tries = (job.tries || 0) + 1;
            if (job.tries < 2) {
                log("↻ retry " + (job.path || job.url) + " (attempt " + (job.tries + 1) + ")");
                reqQueue.unshift(job);
                $.Schedule(0.05, function () { reqActive = false; drainQueue(); });
                return;
            }
            try {
                if (job.onError) job.onError(e);
            } finally {
                $.Schedule(0.05, function () { reqActive = false; drainQueue(); });
            }
        };
        if (job.kind === "image") imageRequestNow(job.url, job.attributes, success, failure);
        else rawRequestNow(job.path, job.params, success, failure);
    }

    // Load an ordinary PNG into an intrinsic-size panel. Unlike rawRequestNow,
    // success does NOT clear/delete the image: the caller receives the loaded
    // panel and owns its remaining lifetime.
    function imageRequestNow(url, attributes, onDone, onError) {
        var img;
        try {
            var h = ensureHost();
            img = $.CreatePanel("Image", h, "mgimg_" + (reqCounter++), attributes || {});
            img.style.position = "0px 0px 0px";
            log("→ IMG " + url);
            img.SetImage(url);
        } catch (e) {
            log("✗ EXC loading image: " + (e && e.message ? e.message : e));
            if (img) {
                try { img.SetImage(""); } catch (e2) {}
                try { img.DeleteAsync(0); } catch (e3) {}
            }
            if (onError) onError("exception");
            return;
        }

        var elapsed = 0;
        var finished = false;
        function discard() {
            try { img.SetImage(""); } catch (e) {}
            try { img.DeleteAsync(0); } catch (e2) {}
        }
        function check() {
            if (finished) return;
            var w = Number(img.actuallayoutwidth);
            var hh = Number(img.actuallayoutheight);
            if (w > 0 && hh > 0) {
                finished = true;
                log("← IMG = " + w + "x" + hh + " (" + Math.round(elapsed) + "ms)");
                onDone(img, w, hh);
                return;
            }
            elapsed += POLL_STEP * 1000;
            if (elapsed >= REQ_TIMEOUT_MS) {
                finished = true;
                discard();
                log("✗ IMAGE TIMEOUT (dims stayed 0 for " + REQ_TIMEOUT_MS + "ms)");
                if (onError) onError("timeout");
                return;
            }
            $.Schedule(POLL_STEP, check);
        }
        $.Schedule(POLL_STEP, check);
    }

    // Fire one request; call onDone(rawW, rawH) with the image's pixel dimensions.
    // Once started, a request ALWAYS runs to completion (response or timeout) - there
    // is deliberately no abort. Aborting an in-flight request silently (without firing
    // a callback) once left `calibrating` latched true forever, deadlocking all
    // networking. Requests are short, so the worst case is one 8s timeout; stale
    // responses are discarded by the callers' poll tokens.
    function rawRequestNow(path, params, onDone, onError) {
        var img;
        try {
            var h = ensureHost();
            img = $.CreatePanel("Image", h, "mgreq_" + (reqCounter++));
            // Do NOT set width/height/scaling: Panorama rejects width:auto and any
            // explicit size would override the intrinsic pixel size we need to read.
            // Left unset, the Image lays out at the PNG's real dimensions (proven by
            // the dummyimage test that reported 123x456 correctly).
            img.style.position = "0px 0px 0px";

            var qs = "rnd=" + Math.random() + "x" + reqCounter;
            if (params) {
                for (var k in params) {
                    if (params.hasOwnProperty(k)) {
                        qs += "&" + k + "=" + encodeURIComponent(params[k]);
                    }
                }
            }
            // NOTE: Panorama's image loader keys off the URL extension - it will
            // silently refuse a URL that doesn't look like an image, so paths end ".png".
            var fullUrl = BASE_URL + path + ".png?" + qs;
            log("→ GET " + path + ".png");
            img.SetImage(fullUrl);
        } catch (e) {
            log("✗ EXC sending " + path + ": " + (e && e.message ? e.message : e));
            if (onError) onError("exception");
            return;
        }

        var elapsed = 0;
        var finished = false;
        // Clear the src before deleting so the engine releases the load/connection
        // promptly instead of holding it until the panel is garbage-collected.
        function cleanup() {
            try { img.SetImage(""); } catch (e) {}
            try { img.DeleteAsync(0); } catch (e) {}
        }
        function check() {
            if (finished) return;
            var w = img.actuallayoutwidth;
            var hh = img.actuallayoutheight;
            if (w > 0 && hh > 0) {
                finished = true;
                cleanup();
                log("← " + path + " = " + w + "x" + hh + " (" + Math.round(elapsed) + "ms)");
                onDone(w, hh);
                return;
            }
            elapsed += POLL_STEP * 1000;
            if (elapsed >= REQ_TIMEOUT_MS) {
                finished = true;
                cleanup();
                log("✗ TIMEOUT " + path + " (dims stayed 0 for " + REQ_TIMEOUT_MS + "ms)");
                if (onError) onError("timeout");
                return;
            }
            $.Schedule(POLL_STEP, check);
        }
        $.Schedule(POLL_STEP, check);
    }

    // Calibration from /api/probe, which returns a known (600, 1000) image. A LARGE
    // reference makes the derived scale precise, so small returned values (code halves,
    // squares 0..63) decode without rounding drift. This also tells us whether the
    // engine reports width/height swapped.
    var PROBE_W = 600, PROBE_H = 1000;
    var swap = false, scaleX = 1, scaleY = 1, calibrated = false, calibrating = false;
    var calibWaiters = [];

    function finishCalib() {
        calibrated = true;
        calibrating = false;
        var ws = calibWaiters; calibWaiters = [];
        for (var i = 0; i < ws.length; i++) { try { ws[i].go(); } catch (e) {} }
    }

    function failCalib() {
        calibrating = false;
        var ws = calibWaiters; calibWaiters = [];
        for (var i = 0; i < ws.length; i++) {
            try { if (ws[i].fail) ws[i].fail("calibration"); } catch (e) {}
        }
    }

    // The engine's very first image load can take longer than one request timeout
    // (~9s cold has been observed), so a single probe attempt isn't enough. Retry a
    // few times; only if ALL attempts fail is the server treated as unreachable and
    // pending requests get their error callback. NEVER fall back to scale=1: on a
    // scaled UI that decodes garbage - wrong lobby codes, phantom second players,
    // corrupted moves that eat pieces.
    var PROBE_ATTEMPTS = 3;

    function calibrate(cb, fail) {
        if (cb) calibWaiters.push({ go: cb, fail: fail });
        if (calibrating) return;
        calibrating = true;
        probeOnce(1);
    }

    function probeOnce(attempt) {
        function retryOrFail(why) {
            if (attempt < PROBE_ATTEMPTS) {
                log("probe attempt " + attempt + " " + why + "; retrying");
                probeOnce(attempt + 1);
                return;
            }
            log("✗ probe " + why + " " + PROBE_ATTEMPTS + " times; giving up");
            failCalib();
        }
        rawRequest("/api/probe", null, function (w, hh) {
            // Unswapped ~ (600s, 1000s); swapped ~ (1000s, 600s). 600 < 1000, so
            // width > height means the engine swapped the two dimensions.
            var sw = false;
            if (w > hh) { sw = true; var t = w; w = hh; hh = t; }
            var sx = w / PROBE_W, sy = hh / PROBE_H;
            // Clamp detector. Panorama scales the whole UI by ONE uniform factor, so a
            // faithfully-read probe always yields sx ≈ sy. If they diverge, the probe
            // image was squeezed to fit a container of a different aspect ratio - the
            // exact failure that read a 600x1000 probe as a 200x200 host and latched a
            // bogus scale (sx=0.333, sy=0.200) that corrupted every later decode. Reject
            // it and retry rather than calibrate to garbage. (A too-small host is the
            // usual cause; the host is sized > probe precisely to prevent this.)
            var lo = Math.min(sx, sy), hi = Math.max(sx, sy);
            if (!(lo > 0.05) || (hi - lo) / hi > 0.15) {
                log("⚠ probe distorted: raw " + w + "x" + hh + " => sx=" + sx.toFixed(3) + " sy=" + sy.toFixed(3));
                retryOrFail("distorted");
                return;
            }
            swap = sw; scaleX = sx; scaleY = sy;
            log("calibrated swap=" + swap + " scaleX=" + scaleX.toFixed(3) + " scaleY=" + scaleY.toFixed(3));
            finishCalib();
        }, function () {
            retryOrFail("failed");
        });
    }

    // Called when a response decodes to something the protocol can never produce
    // (out-of-range code, >2 players, a non-diagonal "move"). That means the scale
    // is stale - bad probe or a resolution change - so re-run it, throttled so a
    // burst of bad reads doesn't stack recalibrations.
    var lastSuspect = 0;
    function suspectDecode(why) {
        log("⚠ suspicious decode: " + why);
        var now = Date.now();
        if (now - lastSuspect < 5000) return;
        lastSuspect = now;
        calibrated = false;
        calibrate();
    }

    // Decode a raw (w,h) image back to the two protocol LEVELS the worker encoded.
    // Mirrors worker.core.js d(): dim = level*STEP + BASE, so level = (dim/scale - BASE)/STEP.
    // The scale-correction (÷scale) is done WITHOUT rounding and the single Math.round happens
    // here at the end - a value is never rounded twice (double-rounding is what tipped a level
    // across a boundary on scaled displays). Callers get the same small ints as the old
    // dim=int+1 scheme did, so every decoder downstream is unchanged.
    function decodeLevel(dim, scale) { return Math.round((dim / scale - BASE) / STEP); }
    function decode(w, hh) {
        if (swap) { var t = w; w = hh; hh = t; }
        return { w: decodeLevel(w, scaleX), h: decodeLevel(hh, scaleY) };
    }

    function request(path, params, onDone, onError) {
        function go() {
            rawRequest(path, params, function (w, hh) {
                var d = decode(w, hh);
                onDone(d.w, d.h);
            }, onError);
        }
        if (calibrated) go(); else calibrate(go, onError);
    }

    MG.Net = {
        request: request,
        loadImage: loadImage,
        clearQueue: function () {
            // Drop pending UI traffic (stale status/poll ticks from a view we just
            // left) - their callers are token-guarded, so silence is fine. Two things
            // are deliberately NOT touched:
            //  - the calibration probe: dropping it would strand `calibrating` at
            //    true and deadlock every future request;
            //  - the active in-flight request: it finishes naturally (see
            //    rawRequestNow), keeping loads strictly one-at-a-time.
            var kept = [];
            for (var i = 0; i < reqQueue.length; i++) {
                if (reqQueue[i].path === "/api/probe") kept.push(reqQueue[i]);
            }
            reqQueue = kept;
        },
        recalibrate: function (cb) { calibrated = false; calibrate(cb); },
        pollDelay: pollDelay,
        waitDelay: waitDelay,
        setDebug: setDebug,
        isDebug: function () { return DEBUG; },
        isConfigured: function () { return BASE_URL.indexOf("CHANGEME") < 0; },
        getBaseUrl: function () { return BASE_URL; }
    };

    // ── seat identity (the trust anchor) ────────────────────────────────────
    // A seat token is generated ONCE per game on the client and flows ONLY upward
    // (as a query param) into create/quick/join/move/reset. It is never rendered and
    // never returned in a response, so the 2-int downlink limit doesn't constrain it
    // and an observer can neither read nor guess it. The server binds the first token
    // it sees on a seat to that seat; afterwards only that token may act for the seat.
    MG.Session = {
        newToken: function () {
            // Prefer a crypto-grade source when the engine exposes one: 24 random bytes
            // → 48 hex chars, matching validTok's [a-z0-9]{8,64}. crypto is feature-DETECTED,
            // not assumed - Panorama's JS runtime may not expose it, and calling an absent
            // API unguarded would throw and break every online seat. When it's missing we
            // fall back to the original Math.random mix, which is still far beyond guessable
            // for a friendly relay and never travels downward where it could leak.
            try {
                var c = (typeof crypto !== "undefined" && crypto) ||
                    (typeof globalThis !== "undefined" && globalThis.crypto) || null;
                if (c && c.getRandomValues) {
                    var buf = new Uint8Array(24);
                    c.getRandomValues(buf);
                    var hex = "";
                    for (var b = 0; b < buf.length; b++) hex += (buf[b] + 256).toString(16).slice(1);
                    return hex;
                }
            } catch (e) { /* fall through to the Math.random mix */ }
            var s = "";
            for (var i = 0; i < 5; i++) s += Math.random().toString(36).slice(2, 12);
            return (s + Date.now().toString(36)).slice(0, 48);
        }
    };

    // ── code / tc helpers (mirror worker.core.js dCode + tcIndex) ────────────
    // A lobby code rides the downlink as width = BAND + (code>>6), height = code&63.
    // The BAND both keeps the width clear of every sentinel (1 ok · 9 err · 20/21/22
    // formation) AND encodes the role: 24..39 = joiner/create, 40..55 = host. Returns
    // { code, host } or null if the width isn't in either code band (a stale-scale read).
    var CODE_BAND_JOIN = 24, CODE_BAND_HOST = 40, CODE_MAX = 1023;
    function decodeCode(w, h) {
        var band = null;
        if (w >= CODE_BAND_JOIN && w <= CODE_BAND_JOIN + 15) band = { off: CODE_BAND_JOIN, host: false };
        else if (w >= CODE_BAND_HOST && w <= CODE_BAND_HOST + 15) band = { off: CODE_BAND_HOST, host: true };
        if (!band || h < 0 || h > 63) return null;
        var code = ((w - band.off) << 6) + h;
        if (code < 0 || code > CODE_MAX) return null;
        return { code: code, host: band.host };
    }
    // Client displays / re-sends a code as a plain decimal string. The server canonicalises
    // (validCode) so zero-padding is irrelevant, but we pad to 4 for a stable on-screen code.
    function codeStr(code) { var s = "" + code; while (s.length < 4) s = "0" + s; return s; }
    // tc index (join height) -> seconds. Mirrors worker tcFromIndex: 0 none · 1..4 = the menu.
    var TC_SECONDS = [0, 60, 180, 300, 600];
    function tcFromIndex(i) { return (i >= 0 && i < TC_SECONDS.length) ? TC_SECONDS[i] : 0; }
    // /api/match height codec (mirrors worker): height = tcIndex*2 + variantBit + 1, variantBit
    // english=1 else 0. Recover the bank (seconds) and checkers variant from one height value.
    function matchTcFromHeight(h) { var v = h - 1; return v >= 0 ? tcFromIndex(v >> 1) : 0; }
    function matchVariantFromHeight(h) { var v = h - 1; return v >= 0 && (v & 1) ? "english" : "russian"; }

    // ── Typed protocol layer ────────────────────────────────────────────────
    // Every decode is range-checked against what the protocol can actually produce.
    // An impossible value means the scale calibration is stale - reject it, trigger
    // a recalibration, and let the caller's normal error/retry path handle it.
    // Acting on a garbage decode is what caused phantom opponents and eaten pieces.
    MG.Api = {
        // Round-trip latency check. The FIRST request after boot pays for the
        // engine's cold image-loader start (and calibration) - many seconds that
        // say nothing about the server. Warm up with one request, time the second.
        ping: function (cb, err) {
            request("/api/ping", null, function () {
                var start = Date.now();
                request("/api/ping", null, function () {
                    cb(Date.now() - start);
                }, err);
            }, err);
        },

        // tc = time control in SECONDS (chess/checkers only; server rejects off-menu / other
        // games → untimed). Omit or 0 for an untimed lobby. The joiner learns tc from join().
        create: function (game, tok, cb, err, tc, cv) {
            var params = { game: game, tok: tok, tc: tc || 0 };
            if (cv) params.cv = cv;                       // "russian"/"english"; checkers only. Joiner learns it via match()
            request("/api/create", params, function (w, h) {
                if (w === 9 && h === 4) { if (err) err("busy"); return; } // rate-limited, don't recalibrate
                var dc = decodeCode(w, h);
                log("create decoded w=" + w + " h=" + h + " => code=" + (dc ? dc.code : "?"));
                if (!dc) {
                    suspectDecode("create w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                cb(dc.code);
            }, err);
        },

        // Public quickmatch. Server either seats us into a waiting lobby (JOINER, we play
        // black) or hosts a fresh public lobby and waits (HOST, +100 on the width flags it).
        // tc = time-control choice (chess/checkers only): concrete SECONDS (60/180/300/600),
        // the literal "any" (wildcard - pairs with any waiter, else 5 min), or omitted/0 for a
        // non-clock game. The server pools waiters by (game, tc) so banks never force-mismatch;
        // the resolved bank is discovered by both clients from the authoritative /api/clocks.
        quick: function (game, tok, cb, err, tc, cv) {
            var params = { game: game, tok: tok };
            if (tc != null && tc !== 0) params.tc = tc;   // "any" or concrete secs; omit for untimed
            if (cv) params.cv = cv;                       // "any"/"russian"/"english"; checkers only
            request("/api/quick", params, function (w, h) {
                if (w === 9 && h === 4) { if (err) err("busy"); return; } // rate-limited
                var dc = decodeCode(w, h);
                if (!dc) {
                    suspectDecode("quick w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                cb({ role: dc.host ? "host" : "joiner", code: dc.code });
            }, err);
        },

        // Multi-select quick match: the caller offers a SET of games (games[] → "1,2,4,5").
        // Same role/code encoding as quick (HOST flagged by +100 on the width). A JOINER is
        // paired into a waiting host whose game (or undecided candidate set) intersects ours,
        // and the server FIXES the shared lobby to the matched game - but the 2-int response
        // can't also carry which game was chosen, so BOTH sides read it from status() (whose
        // height now carries game+1). The caller resolves the game before mounting.
        mquick: function (games, tok, cb, err, tc, cv) {
            var list = (games || []).join(",");
            var params = { games: list, tok: tok };
            if (tc != null && tc !== 0) params.tc = tc;   // "any" or concrete secs (chess/checkers in the set)
            if (cv) params.cv = cv;                       // "any"/"russian"/"english" (checkers in the set)
            request("/api/mquick", params, function (w, h) {
                if (w === 9 && h === 4) { if (err) err("busy"); return; } // rate-limited
                if (w === 9) {                                   // (9,6) no valid ids · (9,3) bad token
                    suspectDecode("mquick w=" + w + " h=" + h);
                    if (err) err(h === 6 ? "games" : h === 3 ? "token" : "error");
                    return;
                }
                var dc = decodeCode(w, h);
                if (!dc) {
                    suspectDecode("mquick w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                cb({ role: dc.host ? "host" : "joiner", code: dc.code });
            }, err);
        },

        // Drop a lobby we created but nobody joined yet (host pressed Cancel). Carries the
        // seat token: the server only honours a cancel from a SEATED player while the lobby is
        // still waiting, so a 4-digit-code guesser can't nuke someone else's active match.
        cancel: function (code, tok, cb, err) {
            request("/api/cancel", { code: code, tok: tok || "" }, function (w, h) { if (cb) cb(true); }, err);
        },

        // Leave a game already in progress. Unlike cancel (which only works while a lobby waits),
        // this reaches the server mid-match so the opponent learns at once: a pair game is torn
        // down (their next poll returns (9,9) → "Opponent left."), while a 3–4-seat durak/poker
        // table folds this seat out and plays on. Fire-and-forget - the caller is leaving anyway.
        leave: function (code, tok, cb, err) {
            request("/api/leave", { code: code, tok: tok || "" }, function (w, h) { if (cb) cb(true); }, err);
        },


        join: function (code, tok, cb, err) {
            request("/api/join", { code: code, tok: tok }, function (w, h) {
                log("join decoded w=" + w + " h=" + h);
                // h carries the host's time control as a small INDEX (0=untimed,1=60,2=180,
                // 3=300,4=600), not raw seconds - 600 would overflow a level. tcFromIndex maps
                // it back. join's width is the game id (1..9); tc rides the height.
                if (w === 9 && h === 4) { cb({ ok: false, reason: "busy" }); return; } // rate-limited
                if (w >= 1 && w <= 9) cb({ ok: true, game: w, tc: tcFromIndex(h) });
                else if (w === 20) cb({ ok: false, reason: "missing" });
                else if (w === 21) cb({ ok: false, reason: "full" });
                else {
                    suspectDecode("join w=" + w + " h=" + h);
                    cb({ ok: false, reason: "error" });
                }
            }, err);
        },

        status: function (code, tok, cb, err) {
            request("/api/status", { code: code, tok: tok || "" }, function (w, h) {
                log("status(" + code + ") decoded w=" + w + " h=" + h);
                if (w === 9 && h === 4) { if (err) err("busy"); return; } // rate-limited: caller retries
                if (w === 9 && h === 1) {
                    // status is only polled while a host waits for a joiner, so a
                    // "gone" here means the lobby was swept/closed, not that an
                    // opponent dropped (nobody had joined yet).
                    cb({ gone: true, players: 0 });
                    return;
                }
                if (w === 9) { if (err) err("transient"); return; }
                if (w !== 1 && w !== 2) {
                    suspectDecode("status w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                // h carries game+1 (1 = still-undecided multi lobby, game 0). Single-game
                // callers ignore `game`; the multi-select flow reads it to learn which game a
                // joiner picked once the lobby fixes (players === 2, game > 0).
                cb({ gone: false, players: w, game: h - 1 });
            }, err);
        },

        // Resolved-options readout for a settled lobby. The 2-int join/quick replies carry only
        // role+code, so the CHOSEN checkers variant (and the exact bank a resolved "Any" landed on)
        // need their own channel. width = game (1..9); height = tcIndex*2 + variantBit + 1.
        // Returns { gone } for a swept / still-undecided lobby, else { game, tc, variant }.
        match: function (code, cb, err) {
            request("/api/match", { code: code }, function (w, h) {
                if (w === 9 && h === 4) { if (err) err("busy"); return; } // rate-limited: caller retries
                if (w === 9 && h === 1) { cb({ gone: true }); return; }    // gone/undecided
                if (w === 9) { if (err) err("transient"); return; }
                if (w < 1 || w > 9) {
                    suspectDecode("match w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                cb({ gone: false, game: w, tc: matchTcFromHeight(h), variant: matchVariantFromHeight(h) });
            }, err);
        },

        // The seat token authorises this move. The server validates it against its own
        // board and returns (1,1) on accept or (9,x) on reject - the client maps x to a
        // reason so the controller can roll back its prediction and resync:
        //   (9,1) turn · (9,2) illegal · (9,3) token · (9,9) gone.
        move: function (code, from, to, end, tok, cb, err) {
            request("/api/move", { code: code, from: from, to: to, end: end ? 1 : 0, tok: tok },
                function (w, h) {
                    if (!cb) return;
                    if (w === 9) {
                        var reason = h === 1 ? "turn" : h === 2 ? "illegal" : h === 3 ? "token" : "gone";
                        cb({ ok: false, reason: reason });
                    } else {
                        cb({ ok: true });
                    }
                }, err);
        },

        // `validate(from,to)` is an optional game-specific sanity check on the decoded move
        // (a mis-scaled read yields plausible-but-wrong squares that corrupt the board). Each
        // game knows what a legal (from,to) looks like - checkers passes a diagonal test,
        // tic-tac-toe passes its cell-placement shape - so the transport stays generic and
        // every caller keeps its own guard. Omitting it applies only the 0..63 range check.
        // A failed check trips suspectDecode (stale scale → recalibrate). The
        // move's turn-hand-off flag `end` is NO LONGER sent down - it didn't fit the level
        // codec and is derivable: `deriveEnd(from,to)` (optional) recomputes it from the SAME
        // shared rules engine the server used, applied to the caller's board. When omitted,
        // end defaults to 1 (every TTT/chess/C4 move ends the turn; only checkers chains).
        poll: function (code, since, cb, err, validate, deriveEnd) {
            request("/api/poll", { code: code, since: since }, function (w, h) {
                if (w === 9 && h === 9) {
                    log("opponent left (9x9 received)");
                    if (MG.UI && MG.UI.kickToMenu) MG.UI.kickToMenu("Opponent left.");
                    return;
                }
                var from = w, to = h;   // RAW squares 0..63 now (worker dropped the +1 / +100)
                if (from === to) { cb(null); return; }   // (1,1)/(0,0) => nothing new
                var inRange = from >= 0 && from <= 63 && to >= 0 && to <= 63;
                if (!inRange || (validate && !validate(from, to))) {
                    suspectDecode("poll w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                var end = deriveEnd ? (deriveEnd(from, to) ? 1 : 0) : 1;
                cb({ from: from, to: to, end: end, seq: since + 1 });
            }, err);
        },

        // ── GeoGuesser (authoritative target, guesses, score and reveal gate) ──
        geoState: function (code, tok, cb, err) {
            request("/api/geostate", { code: code, tok: tok }, function (w, h) {
                if (w === 9) {
                    if (h === 9 && MG.UI && MG.UI.kickToMenu) MG.UI.kickToMenu("Opponent left.");
                    else if (err) err(h === 3 ? "token" : "state");
                    return;
                }
                if (w === 6 && h === 40) {
                    cb({ done: true, round: 5, reveal: false, guessMask: 3, readyMask: 3 });
                    return;
                }
                if (w < 1 || w > 5) {
                    suspectDecode("geostate w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                if (h >= 16 && h <= 31) {
                    var packed = h - 16;
                    cb({
                        done: false,
                        round: w - 1,
                        reveal: true,
                        guessMask: packed >> 2,
                        readyMask: packed & 3
                    });
                    return;
                }
                if (h >= 1 && h <= 4) {
                    cb({ done: false, round: w - 1, reveal: false, guessMask: h - 1, readyMask: 0 });
                    return;
                }
                suspectDecode("geostate w=" + w + " h=" + h);
                if (err) err("decode");
            }, err);
        },

        geoGuess: function (code, tok, cell, cb, err) {
            request("/api/geoguess", { code: code, tok: tok, cell: cell }, function (w, h) {
                if (!cb) return;
                cb({ ok: w === 1 && h === 1, reason: w === 9 ? h : 0 });
            }, err);
        },

        geoNext: function (code, tok, cb, err) {
            request("/api/geonext", { code: code, tok: tok }, function (w, h) {
                if (!cb) return;
                cb({ ok: w === 1 && h === 1, reason: w === 9 ? h : 0 });
            }, err);
        },

        geoTarget: function (code, tok, cb, err) {
            request("/api/geotarget", { code: code, tok: tok }, function (w, h) {
                if (w === 9) { if (err) err(h); return; }
                var x = w - 20;
                if (x < 0 || x >= 32 || h < 0 || h >= 16) {
                    suspectDecode("geotarget w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                cb({ x: x, y: h });
            }, err);
        },

        geoPick: function (code, tok, seat, cb, err) {
            request("/api/geopick", { code: code, tok: tok, seat: seat }, function (w, h) {
                if (w === 9) { if (err) err(h); return; }
                var x = w - 20;
                if (x < 0 || x >= 32 || h < 0 || h >= 16) {
                    suspectDecode("geopick w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                cb({ x: x, y: h });
            }, err);
        },

        geoScore: function (code, tok, seat, cb, err) {
            request("/api/geoscore", { code: code, tok: tok, seat: seat }, function (w, h) {
                if (h === 63) { if (err) err(w); return; }
                var score = h * 63 + w;
                if (w < 0 || w >= 63 || score < 0 || score > 4095) {
                    suspectDecode("geoscore w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                cb(score);
            }, err);
        },

        geoInfo: function (code, tok, cb, err) {
            request("/api/geoinfo", { code: code, tok: tok }, function (w, h) {
                if (w === 9) { if (err) err(h); return; }
                if (w < 1 || w > 7 || h !== 1) {
                    suspectDecode("geoinfo w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                cb(w - 1);
            }, err);
        },

        reset: function (code, game, tok, cb, err) {
            request("/api/reset", { code: code, game: game, tok: tok },
                function (w, h) { if (cb) cb(w < 9); }, err);
        },

        // Authoritative clocks. The server holds each seat's time bank and decides flag-fall,
        // so both players read the SAME remaining seconds and can never drift apart. A bank is
        // 0..600 s = 10 bits, which needs BOTH image dimensions under the level codec, so the
        // route now returns ONE seat per read (&seat=S) as (CLK_BASE+hi, lo), sec = hi*64+lo.
        // We fetch seat 0 then seat 1 and stitch them back into the same {sec:[s0,s1], flag}
        // shape callers already consume - the two reads are ~1 frame apart, far tighter than
        // the ~1 s poll cadence, so no visible drift. Sentinels: (9,9) gone · (9,8) untimed.
        // cb({ sec:[s0,s1], flag }) - flag is the seat that ran out of time, or -1.
        clocks: function (code, cb, err) {
            function fail(reason) { if (err) err(reason); }
            function readSeat(seat, next) {
                request("/api/clocks", { code: code, seat: seat }, function (w, h) {
                    // Only the explicit (9,8) sentinel means "this lobby is untimed". A gone,
                    // server-error or transport failure must take the error path so createClock
                    // retries instead of permanently deleting/freezing a real timed clock.
                    if (w === 9 && h === 8) { next(null); return; }
                    if (w === 9) { fail(h === 9 ? "gone" : "server"); return; }
                    // Real reading: width is the CLK band (30..39 = 30+hi), height is lo (0..63).
                    var sec = (w - 30) * 64 + h;
                    if (w < 30 || w > 39 || sec < 0 || sec > 600) {
                        suspectDecode("clocks seat=" + seat + " w=" + w + " h=" + h);
                        fail("decode");
                        return;
                    }
                    next(sec);
                }, fail);
            }
            readSeat(0, function (s0) {
                if (s0 === null) { if (cb) cb(null); return; } // authoritative untimed sentinel
                readSeat(1, function (s1) {
                    if (s1 === null) { if (cb) cb(null); return; }
                    // The running seat that hits 0 is the flag-fall loser; the server floors it
                    // at 0 and never lets the other tick past it, so at most one seat reads 0.
                    var flag = s0 === 0 ? 0 : (s1 === 0 ? 1 : -1);
                    if (cb) cb({ sec: [s0, s1], flag: flag });
                });
            });
        },

        // Rematch handshake. Poll this from the game-over screen with your CURRENT gen
        // (0 for a fresh lobby, then the last gen the server reported). The server arms this
        // seat's rematch flag only when gen matches (so a stale detect-poll can't re-arm after
        // a restart), and once every present seat is armed it resets/redeals and bumps gen.
        //   cb({ state, gen }): state 1 = armed, waiting · 2 = consensus reached (reset done)
        //                       9 = lobby gone / bad token (gen carries 3=bad-token, 9=gone)
        //   gen = the lobby's current generation (grows by 1 each rematch).
        rematch: function (code, tok, gen, cb, err) {
            request("/api/rematch", { code: code, tok: tok, gen: gen || 0 },
                function (w, h) { if (cb) cb({ state: w, gen: h - 1 }); }, err);
        },

        // ── Durak online (authoritative dealer, 2–4 seats) ──────────────────
        // These routes use the same image side-channel but a separate indexed public
        // event log (`dlog`) plus a private per-seat draw stream (`ddraw`). All writes and
        // private reads are authorised by the seat token. Event dimensions deliberately stay
        // small (<= ~63) and no real event is (1,1), so (1,1) remains "nothing new".
        room: function (code, tok, cb, err) {
            request("/api/room", { code: code, tok: tok || "" }, function (w, h) {
                // ONLY (9,1) means the lobby is truly gone (swept/closed). Any OTHER 9,x - an
                // unknown route on a stale-deployed worker (9,8), a server error (9,7), etc. - is
                // treated as a TRANSIENT error so the poll retries instead of instantly kicking the
                // host out of a freshly-created room (the "durak lobby closes immediately" bug).
                if (w === 9 && h === 1) { cb({ gone: true, players: 0, started: false }); return; }
                if (w === 9) { if (err) err("transient"); return; }
                if (w < 1 || w > 2 || (h !== 1 && h !== 2)) {
                    suspectDecode("room w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                cb({ gone: false, players: w, started: h === 2 });
            }, err);
        },


        start: function (code, tok, cb, err) {
            request("/api/start", { code: code, tok: tok }, function (w, h) {
                if (!cb) return;
                if (w === 1 && h === 1) { cb({ ok: true }); return; }
                if (w === 9) {
                    var reason = h === 1 ? "host" : h === 2 ? "players" : h === 3 ? "token" : "gone";
                    cb({ ok: false, reason: reason });
                    return;
                }
                suspectDecode("start w=" + w + " h=" + h);
                cb({ ok: false, reason: "decode" });
            }, err);
        },

        dact: function (code, tok, a, pair, card, cb, err) {
            request("/api/dact", { code: code, tok: tok, a: a, p: pair || 0, c: card || 0 }, function (w, h) {
                if (!cb) return;
                if (w === 1 && h === 1) { cb({ ok: true }); return; }
                if (w === 9) {
                    var reason = h === 1 ? "turn" : h === 2 ? "illegal" : h === 3 ? "token" : "gone";
                    cb({ ok: false, reason: reason });
                    return;
                }
                suspectDecode("dact w=" + w + " h=" + h);
                cb({ ok: false, reason: "decode" });
            }, err);
        },

        dlog: function (code, since, cb, err) {
            request("/api/dlog", { code: code, since: since }, function (w, h) {
                if (w === 1 && h === 1) { cb(null); return; }
                if (w === 9 && h === 9) {
                    if (MG.UI && MG.UI.kickToMenu) MG.UI.kickToMenu("Opponent left.");
                    return;
                }
                // Seat ranges span 0..3 (2–4 players). ROLES(4, a*4+d+1) is the server-owned
                // post-bout rotation; OVER's loser range widens to 0..3 (h = loser+2 → 1..5).
                var ev = null;
                if (w === 2 && h >= 1 && h <= 36) ev = { type: "trump", card: h - 1 };
                else if (w === 3 && h >= 1 && h <= 4) ev = { type: "open", seat: h - 1 };
                else if (w === 4 && h >= 1 && h <= 16) ev = { type: "roles", attacker: ((h - 1) / 4) | 0, defender: (h - 1) % 4 };
                else if (w >= 10 && w <= 13 && h >= 1 && h <= 36) ev = { type: "play", seat: w - 10, card: h - 1 };
                else if (w >= 20 && w <= 25 && h >= 1 && h <= 36) ev = { type: "cover", pair: w - 20, card: h - 1 };
                else if (w >= 30 && w <= 33 && h === 1) ev = { type: "take", seat: w - 30 };
                else if (w === 40 && h === 1) ev = { type: "bito" };
                else if (w >= 41 && w <= 44 && h === 1) ev = { type: "pass", seat: w - 41 };
                else if (w >= 45 && w <= 48 && h === 1) ev = { type: "left", seat: w - 45 };
                else if (w >= 50 && w <= 53 && h >= 1 && h <= 7) ev = { type: "draw", seat: w - 50, count: h - 1 };
                else if (w === 60 && h >= 1 && h <= 5) ev = { type: "over", loser: h - 2 };
                if (!ev) {
                    suspectDecode("dlog w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                ev.seq = since + 1;
                cb(ev);
            }, err);
        },

        ddraw: function (code, tok, index, cb, err) {
            request("/api/ddraw", { code: code, tok: tok, i: index }, function (w, h) {
                if (w === 1 && h === 1) { cb(null); return; }
                if (w === 9 && h === 3) { if (err) err("token"); return; }
                if (w === 9 && h === 9) { if (err) err("gone"); return; }
                // Private card ids use card+2 (2..37), not card+1, so card 0 never
                // collides with the universal (1,1) "nothing new" marker.
                if (w >= 2 && w <= 37 && h === 1) { cb(w - 2); return; }
                suspectDecode("ddraw w=" + w + " h=" + h);
                if (err) err("decode");
            }, err);
        },

        // ── Durak N-seat private lobby (2–4 seats) ──────────────────────────────
        // Private tables of every size use this create/join/room set (same shape as poker's
        // pcreate/pjoin/proom); only public heads-up Quick uses the generic room. Once the host
        // deals via /api/start, play runs through dact/dlog/ddraw above - seat-count agnostic.
        dcreate: function (cap, tok, cb, err) {
            request("/api/dcreate", { n: cap, tok: tok }, function (w, h) {
                if (w === 9 && h === 4) { if (err) err("busy"); return; }   // rate-limited
                if (w === 9 && h === 3) { if (err) err("token"); return; }
                var dc = decodeCode(w, h);   // host/joiner flag folded into the width band
                if (!dc) {
                    suspectDecode("dcreate w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                cb({ code: dc.code });
            }, err);
        },

        djoin: function (code, tok, cb, err) {
            request("/api/djoin", { code: code, tok: tok }, function (w, h) {
                if (w === 9 && h === 4) { cb({ ok: false, reason: "busy" }); return; }   // rate-limited
                if (w === 9 && h === 3) { cb({ ok: false, reason: "token" }); return; }
                if (w === 20) { cb({ ok: false, reason: "missing" }); return; }
                if (w === 21) { cb({ ok: false, reason: "full" }); return; }
                if (w === 22) { cb({ ok: false, reason: "started" }); return; }
                // width = seat cap (2..4), height = the joiner's seat index +1 (players count).
                if (w >= 2 && w <= 4 && h >= 1 && h <= 4) { cb({ ok: true, cap: w, seat: h - 1 }); return; }
                suspectDecode("djoin w=" + w + " h=" + h);
                cb({ ok: false, reason: "decode" });
            }, err);
        },

        droom: function (code, tok, cb, err) {
            request("/api/droom", { code: code, tok: tok || "" }, function (w, h) {
                // Same transient-vs-gone discipline as room(): only (9,1) is truly gone.
                if (w === 9 && h === 1) { cb({ gone: true, players: 0, cap: 0, started: false }); return; }
                if (w === 9) { if (err) err("transient"); return; }
                // "started" is folded into the WIDTH as a band offset (was +100, overflows a
                // level): waiting → players 1..4, started → 51..54. Mirror worker ROOM_STARTED=50.
                var started = w >= 50;
                var players = started ? w - 50 : w;
                if (players < 1 || players > 4 || h < 2 || h > 4) {
                    suspectDecode("droom w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                cb({ gone: false, players: players, cap: h, started: started });
            }, err);
        },

        // ── Poker (worker-as-dealer, 2–4 seats, own route set) ──────────────────
        // Like Durak the worker owns the deck/seed/button and deals hole cards privately
        // (pdraw), relaying only PUBLIC facts through an indexed log (plog). The client
        // replays the shared betting engine (card-independent → parity) and fills board /
        // revealed hole cards / winners from the log. Codes stay small; no real value is (1,1).
        pcreate: function (cap, tok, cb, err) {
            request("/api/pcreate", { n: cap, tok: tok }, function (w, h) {
                if (w === 9 && h === 4) { if (err) err("busy"); return; }   // rate-limited
                if (w === 9 && h === 3) { if (err) err("token"); return; }
                var dc = decodeCode(w, h);   // host/joiner flag folded into the width band
                if (!dc) {
                    suspectDecode("pcreate w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                cb({ code: dc.code });
            }, err);
        },

        pjoin: function (code, tok, cb, err) {
            request("/api/pjoin", { code: code, tok: tok }, function (w, h) {
                if (w === 9 && h === 4) { cb({ ok: false, reason: "busy" }); return; }   // rate-limited
                if (w === 9 && h === 3) { cb({ ok: false, reason: "token" }); return; }
                if (w === 20) { cb({ ok: false, reason: "missing" }); return; }
                if (w === 21) { cb({ ok: false, reason: "full" }); return; }
                if (w === 22) { cb({ ok: false, reason: "started" }); return; }
                // width = seat cap (2..4), height = the joiner's seat index +1 (players count).
                if (w >= 2 && w <= 4 && h >= 1 && h <= 4) { cb({ ok: true, cap: w, seat: h - 1 }); return; }
                suspectDecode("pjoin w=" + w + " h=" + h);
                cb({ ok: false, reason: "decode" });
            }, err);
        },

        proom: function (code, tok, cb, err) {
            request("/api/proom", { code: code, tok: tok || "" }, function (w, h) {
                // Same transient-vs-gone discipline as room(): only (9,1) is truly gone.
                if (w === 9 && h === 1) { cb({ gone: true, players: 0, cap: 0, started: false }); return; }
                if (w === 9) { if (err) err("transient"); return; }
                // "started" folded into the WIDTH as a band offset (was +100): waiting →
                // players 1..4, started → 51..54. Mirror worker ROOM_STARTED=50. · height = cap.
                var started = w >= 50;
                var players = started ? w - 50 : w;
                if (players < 1 || players > 4 || h < 2 || h > 4) {
                    suspectDecode("proom w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                cb({ gone: false, players: players, cap: h, started: started });
            }, err);
        },

        pstart: function (code, tok, cb, err) {
            request("/api/pstart", { code: code, tok: tok }, function (w, h) {
                if (!cb) return;
                if (w === 1 && h === 1) { cb({ ok: true }); return; }
                if (w === 9) {
                    var reason = h === 1 ? "host" : h === 2 ? "players" : h === 3 ? "token" : "gone";
                    cb({ ok: false, reason: reason });
                    return;
                }
                suspectDecode("pstart w=" + w + " h=" + h);
                cb({ ok: false, reason: "decode" });
            }, err);
        },

        // a: 0 fold · 1 check · 2 call · 3 raise (to = raise-to amount for a raise).
        pact: function (code, tok, a, to, cb, err) {
            request("/api/pact", { code: code, tok: tok, a: a, to: to || 0 }, function (w, h) {
                if (!cb) return;
                if (w === 1 && h === 1) { cb({ ok: true }); return; }
                if (w === 9) {
                    var reason = h === 1 ? "turn" : h === 2 ? "illegal" : h === 3 ? "token" : "gone";
                    cb({ ok: false, reason: reason });
                    return;
                }
                suspectDecode("pact w=" + w + " h=" + h);
                cb({ ok: false, reason: "decode" });
            }, err);
        },

        pnext: function (code, tok, cb, err) {
            request("/api/pnext", { code: code, tok: tok }, function (w, h) {
                if (!cb) return;
                if (w === 1 && h === 1) { cb({ ok: true }); return; }
                if (w === 9) { cb({ ok: false, reason: h === 3 ? "token" : "wait" }); return; }
                suspectDecode("pnext w=" + w + " h=" + h);
                cb({ ok: false, reason: "decode" });
            }, err);
        },

        plog: function (code, since, cb, err) {
            request("/api/plog", { code: code, since: since }, function (w, h) {
                if (w === 1 && h === 1) { cb(null); return; }        // nothing new
                if (w === 9 && h === 9) {
                    if (MG.UI && MG.UI.kickToMenu) MG.UI.kickToMenu("Opponent left.");
                    return;
                }
                var ev = null;
                // HAND(2, button+1) · BOARD(5, card+1) · WIN(7,1) · OVER(8,1)
                if (w === 2 && h >= 1 && h <= 4) ev = { type: "hand", button: h - 1 };
                else if (w === 5 && h >= 1 && h <= 52) ev = { type: "board", card: h - 1 };
                else if (w === 7 && h === 1) ev = { type: "win" };
                else if (w === 8 && h === 1) ev = { type: "over" };
                // FOLD(10+seat,1) · CHECK(20+seat,1) · CALL(30+seat,1)
                else if (w >= 10 && w <= 13 && h === 1) ev = { type: "fold", seat: w - 10 };
                else if (w >= 20 && w <= 23 && h === 1) ev = { type: "check", seat: w - 20 };
                else if (w >= 30 && w <= 33 && h === 1) ev = { type: "call", seat: w - 30 };
                // RAISE is TWO events: the raise-to amount (0..800) exceeds one level, so the
                // worker splits it into a low 6-bit half RAISE(40+seat, to&63) immediately
                // followed by RAISEHI(44+seat, to>>6). Both carry RAW 6-bit values (no +1):
                // width 40..47 can never read as (1,1). The controller stitches to = hi*64+lo.
                else if (w >= 40 && w <= 43 && h >= 0) ev = { type: "raiselo", seat: w - 40, lo: h };
                else if (w >= 44 && w <= 47 && h >= 0) ev = { type: "raisehi", seat: w - 44, hi: h };
                // LEFT(50+seat, 1) - a seat abandoned the table; replayed as a fold + chip forfeit
                else if (w >= 50 && w <= 53 && h === 1) ev = { type: "left", seat: w - 50 };
                // SHOW(60+seat, card+1)
                else if (w >= 60 && w <= 63 && h >= 1 && h <= 52) ev = { type: "show", seat: w - 60, card: h - 1 };
                if (!ev) {
                    suspectDecode("plog w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                ev.seq = since + 1;
                cb(ev);
            }, err);
        },

        pdraw: function (code, tok, index, cb, err) {
            request("/api/pdraw", { code: code, tok: tok, i: index }, function (w, h) {
                if (w === 1 && h === 1) { cb(null); return; }        // not dealt yet
                if (w === 9 && h === 3) { if (err) err("token"); return; }
                if (w === 9 && h === 9) { if (err) err("gone"); return; }
                // Private card ids use card+2 (2..53) so card 0 never collides with (1,1).
                if (w >= 2 && w <= 53 && h === 1) { cb(w - 2); return; }
                suspectDecode("pdraw w=" + w + " h=" + h);
                if (err) err("decode");
            }, err);
        }
    };

    // We deliberately DO NOT calibrate at boot. Calibration spawns the on-screen host
    // panel, and runtime hittest=false does NOT actually pass input through (hittest is
    // an XML-construction attribute, not a live style), so a host sitting over the bare
    // escape menu swallows hover on every native setting until it's torn down. Instead
    // calibration runs lazily on the first real online request (Create/Join/Quick) -
    // which always fires from inside our overlay, where the full-screen dim already
    // covers the menu. Bot games make no requests at all, so they never spawn a host.
    // Cost: the first online action pays the engine's cold image-load once, spent under
    // the "waiting for opponent" view - a fair trade for never breaking menu hover.

    log("loaded (configured=" + MG.Net.isConfigured() + ")");
})();
