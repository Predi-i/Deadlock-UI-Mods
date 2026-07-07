"use strict";

/*
 * mg_net.js — image side-channel network facade for the Deadlock Minigames mod.
 *
 * Panorama UI has no fetch / AsyncWebRequest / websockets. The only way to read data
 * back from a server is the intrinsic pixel size of an <Image>: we set the image src
 * (sending data via URL params — unlimited) and poll actuallayoutwidth/height to read
 * the response, which the server encoded as the image's (width, height).
 *
 * Everything shared across the mod's scripts hangs off $.MG (the $ object is the one
 * global shared between all scripts loaded in the same panel — see tengu.js's
 * $.HeroWinLose pattern).
 *
 * Public API:
 *   $.MG.Net.isConfigured()                     -> false until BASE_URL is set
 *   $.MG.Net.request(path, params, onDone, onErr)  raw (w,h) after swap+scale decode
 *   $.MG.Api.create(game, cb(code), err)
 *   $.MG.Api.quick(game, cb({role,code}), err)   role = "host" | "joiner"
 *   $.MG.Api.cancel(code, cb(ok), err)
 *   $.MG.Api.join(code, cb({ok,game,reason}), err)
 *   $.MG.Api.status(code, cb({gone,players}), err)
 *   $.MG.Api.move(code, from, to, end, cb(ok), err)
 *   $.MG.Api.poll(code, since, cb(move|null), err)      move = {from,to,end,seq}
 *   $.MG.Api.reset(code, game, cb(ok), err)
 */

(function () {
    var MG = ($.MG = $.MG || {});
    if (MG.Net) return; // already initialised

    // ─────────────────────────────────────────────────────────────────────────
    // CONFIG: after `npx wrangler deploy`, paste your workers.dev URL here.
    // e.g. "https://deadlock-minigames.yourname.workers.dev"
    var BASE_URL = "https://deadlock-minigames.predi.workers.dev";
    // ─────────────────────────────────────────────────────────────────────────

    var REQ_TIMEOUT_MS = 8000;
    var POLL_STEP = 0.05;   // seconds between dimension checks

    // Debug logging. Ships OFF. When toggled on (overlay tools → Debug Log) every step is
    // written to Deadlock's dev CONSOLE via $.Msg — no on-screen panel. When OFF, nothing
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
                $.Msg("[MG] debug ON — recent history:");
                for (var i = 0; i < dbgLines.length; i++) $.Msg("[MG] " + dbgLines[i]);
            } catch (e) {}
        }
    }

    // Routine internal log: goes to the console ONLY in debug mode (via debug()).
    function log(msg) { debug(msg); }
    MG.debug = debug; // shared: mg_ui.js routes its logs here too

    // Host that carries the request images. It MUST be on-screen and not culled —
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
            host.style.width = "640px";
            host.style.height = "1020px";
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
    // so dropping it costs nothing — the next request recreates it via ensureHost.
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
    // ONE AT A TIME through a FIFO queue — the poll loop + user actions can never overlap.
    var reqQueue = [];
    var reqActive = false;

    function rawRequest(path, params, onDone, onError) {
        reqQueue.push({ path: path, params: params, onDone: onDone, onError: onError });
        drainQueue();
    }
    function drainQueue() {
        if (reqActive) return;
        var job = reqQueue.shift();
        if (!job) { releaseHost(); return; } // idle: drop the host so it stops covering the menu
        reqActive = true;
        rawRequestNow(job.path, job.params, function (w, h) {
            reqActive = false;
            // Schedule gives the engine 1 frame to release memory before the next load
            try { if (job.onDone) job.onDone(w, h); } finally { $.Schedule(0.05, drainQueue); }
        }, function (e) {
            reqActive = false;
            // The Panorama image loader is intermittently flaky (a URL that loads
            // instantly in a browser sometimes stalls to a timeout here). One silent
            // re-queue at the front of the line recovers most of those. This is a
            // mitigation, not a proven fix — it can't be verified without in-game runs.
            job.tries = (job.tries || 0) + 1;
            if (job.tries < 2) {
                log("↻ retry " + job.path + " (attempt " + (job.tries + 1) + ")");
                reqQueue.unshift(job);
                $.Schedule(0.05, drainQueue);
                return;
            }
            try { if (job.onError) job.onError(e); } finally { $.Schedule(0.05, drainQueue); }
        });
    }

    // Fire one request; call onDone(rawW, rawH) with the image's pixel dimensions.
    // Once started, a request ALWAYS runs to completion (response or timeout) — there
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
            // NOTE: Panorama's image loader keys off the URL extension — it will
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
    // scaled UI that decodes garbage — wrong lobby codes, phantom second players,
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
            // image was squeezed to fit a container of a different aspect ratio — the
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
    // is stale — bad probe or a resolution change — so re-run it, throttled so a
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

    function decode(w, hh) {
        if (swap) { var t = w; w = hh; hh = t; }
        return { w: Math.round(w / scaleX), h: Math.round(hh / scaleY) };
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
        clearQueue: function () {
            // Drop pending UI traffic (stale status/poll ticks from a view we just
            // left) — their callers are token-guarded, so silence is fine. Two things
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
        setDebug: setDebug,
        isDebug: function () { return DEBUG; },
        isConfigured: function () { return BASE_URL.indexOf("CHANGEME") < 0; },
        getBaseUrl: function () { return BASE_URL; }
    };

    // ── Typed protocol layer ────────────────────────────────────────────────
    // Every decode is range-checked against what the protocol can actually produce.
    // An impossible value means the scale calibration is stale — reject it, trigger
    // a recalibration, and let the caller's normal error/retry path handle it.
    // Acting on a garbage decode is what caused phantom opponents and eaten pieces.
    MG.Api = {
        // Round-trip latency check. The FIRST request after boot pays for the
        // engine's cold image-loader start (and calibration) — many seconds that
        // say nothing about the server. Warm up with one request, time the second.
        ping: function (cb, err) {
            request("/api/ping", null, function () {
                var start = Date.now();
                request("/api/ping", null, function () {
                    cb(Date.now() - start);
                }, err);
            }, err);
        },

        create: function (game, cb, err) {
            request("/api/create", { game: game }, function (w, h) {
                var code = w * 100 + (h - 1); // CODE = hi*100 + lo
                log("create decoded w=" + w + " h=" + h + " => code=" + code);
                if (code < 1000 || code > 9999) {
                    suspectDecode("create w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                cb(code);
            }, err);
        },

        // Public quickmatch. Server either seats us into a waiting lobby (JOINER, we play
        // black) or hosts a fresh public lobby and waits (HOST, +100 on the width flags it).
        quick: function (game, cb, err) {
            request("/api/quick", { game: game }, function (w, h) {
                var isHost = w >= 100;
                var code = (isHost ? w - 100 : w) * 100 + (h - 1);
                if (code < 1000 || code > 9999) {
                    suspectDecode("quick w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                cb({ role: isHost ? "host" : "joiner", code: code });
            }, err);
        },

        // Drop a lobby we created but nobody joined yet (host pressed Cancel).
        cancel: function (code, cb, err) {
            request("/api/cancel", { code: code }, function (w, h) { if (cb) cb(true); }, err);
        },

        join: function (code, cb, err) {
            request("/api/join", { code: code }, function (w, h) {
                log("join decoded w=" + w + " h=" + h);
                if (w >= 1 && w <= 9) cb({ ok: true, game: w });
                else if (w === 20) cb({ ok: false, reason: "missing" });
                else if (w === 21) cb({ ok: false, reason: "full" });
                else {
                    suspectDecode("join w=" + w + " h=" + h);
                    cb({ ok: false, reason: "error" });
                }
            }, err);
        },

        status: function (code, cb, err) {
            request("/api/status", { code: code }, function (w, h) {
                log("status(" + code + ") decoded w=" + w + " h=" + h);
                if (w === 9) {
                    // status is only polled while a host waits for a joiner, so a
                    // "gone" here means the lobby was swept/closed, not that an
                    // opponent dropped (nobody had joined yet).
                    if (MG.UI && MG.UI.kickToMenu) MG.UI.kickToMenu("Lobby closed.");
                    cb({ gone: true, players: 0 });
                    return;
                }
                if (w !== 1 && w !== 2) {
                    suspectDecode("status w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                cb({ gone: false, players: w });
            }, err);
        },

        move: function (code, from, to, end, cb, err) {
            request("/api/move", { code: code, from: from, to: to, end: end ? 1 : 0 },
                function (w, h) { if (cb) cb(w < 9); }, err);
        },

        // `validate(from,to)` is an optional game-specific sanity check on the decoded
        // move. It exists because a mis-scaled read yields plausible-but-wrong squares
        // that, acted upon, corrupt the board (phantom moves that eat pieces). Each game
        // knows what a legal (from,to) looks like — checkers passes a diagonal test,
        // tic-tac-toe passes its cell-placement shape — so the transport stays generic
        // and every caller keeps its own guard. Omitting it applies only the 0..63 range
        // check. A failed check trips suspectDecode (stale scale → recalibrate).
        poll: function (code, since, cb, err, validate) {
            request("/api/poll", { code: code, since: since }, function (w, h) {
                if (w === 9 && h === 9) {
                    log("opponent disconnected (9x9 received)");
                    if (MG.UI && MG.UI.kickToMenu) MG.UI.kickToMenu("Opponent disconnected.");
                    return;
                }
                var end = w > 100 ? 1 : 0;
                var from = (end ? w - 100 : w) - 1;
                var to = h - 1;
                if (from === to) { cb(null); return; }   // (1,1) => nothing new
                var inRange = from >= 0 && from <= 63 && to >= 0 && to <= 63;
                if (!inRange || (validate && !validate(from, to))) {
                    suspectDecode("poll w=" + w + " h=" + h);
                    if (err) err("decode");
                    return;
                }
                cb({ from: from, to: to, end: end, seq: since + 1 });
            }, err);
        },

        reset: function (code, game, cb, err) {
            request("/api/reset", { code: code, game: game },
                function (w, h) { if (cb) cb(w < 9); }, err);
        }
    };

    // We deliberately DO NOT calibrate at boot. Calibration spawns the on-screen host
    // panel, and runtime hittest=false does NOT actually pass input through (hittest is
    // an XML-construction attribute, not a live style), so a host sitting over the bare
    // escape menu swallows hover on every native setting until it's torn down. Instead
    // calibration runs lazily on the first real online request (Create/Join/Quick) —
    // which always fires from inside our overlay, where the full-screen dim already
    // covers the menu. Bot games make no requests at all, so they never spawn a host.
    // Cost: the first online action pays the engine's cold image-load once, spent under
    // the "waiting for opponent" view — a fair trade for never breaking menu hover.

    log("loaded (configured=" + MG.Net.isConfigured() + ")");
})();
