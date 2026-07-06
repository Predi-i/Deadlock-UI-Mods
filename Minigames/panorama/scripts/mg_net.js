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

    // On-screen debug console. Ships OFF so players don't see an orange log box,
    // but it can be toggled at runtime from the overlay (tools → Debug Log). Log
    // lines are collected either way, so turning it on shows recent history too.
    var DEBUG = false;

    // ── on-screen debug console ─────────────────────────────────────────────
    // Deadlock's dev console isn't visible to us and Cloudflare shows nothing when
    // the engine never fires the request, so we surface every step on screen.
    var dbgPanel = null, dbgLabel = null, dbgLines = [];
    function ensureDebug() {
        if (!DEBUG) return;
        if (dbgPanel && dbgPanel.IsValid && dbgPanel.IsValid()) return;
        var ctx = $.GetContextPanel();
        dbgPanel = $.CreatePanel("Panel", ctx, "MG_Debug");
        dbgPanel.style.position = "20px 20px 0px";
        dbgPanel.style.width = "760px";
        dbgPanel.style.height = "420px";
        dbgPanel.style.backgroundColor = "#000000dd";
        dbgPanel.style.border = "2px solid #ffaa00";
        dbgPanel.style.padding = "10px";
        dbgPanel.style.zIndex = "100000";
        try { dbgPanel.SetAttributeString("hittest", "false"); } catch (e) {}
        dbgLabel = $.CreatePanel("Label", dbgPanel, "");
        dbgLabel.style.color = "#00ff66";
        dbgLabel.style.fontSize = "17px";
        dbgLabel.style.fontFamily = "monospace";
        dbgLabel.text = "MG debug ready";
    }
    function debug(msg) {
        dbgLines.push(msg);
        if (dbgLines.length > 20) dbgLines.shift();
        ensureDebug();
        if (dbgLabel) dbgLabel.text = dbgLines.join("\n");
    }

    function setDebug(on) {
        DEBUG = !!on;
        if (DEBUG) {
            ensureDebug();
            if (dbgLabel) dbgLabel.text = dbgLines.join("\n");
        } else if (dbgPanel) {
            try { dbgPanel.DeleteAsync(0); } catch (e) {}
            dbgPanel = null;
            dbgLabel = null;
        }
    }

    function log(msg) {
        try { $.Msg("[MG.Net] " + msg); } catch (e) {}
        debug(msg);
    }
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
        try { host.SetAttributeString("hittest", "false"); } catch (e) {}
        return host;
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
        if (!job) return;
        reqActive = true;
        rawRequestNow(job.path, job.params, function (w, h) {
            reqActive = false;
            // Schedule gives the engine 1 frame to release memory before the next load
            try { if (job.onDone) job.onDone(w, h); } finally { $.Schedule(0.05, drainQueue); }
        }, function (e) {
            reqActive = false;
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

        poll: function (code, since, cb, err) {
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
                // A real hop is always a diagonal between two board squares. Anything
                // else (server error markers, mis-scaled reads) must never reach
                // applyHop — it would clear pieces along an arbitrary line.
                var fr = (from / 8) | 0, fc = from % 8, tr = (to / 8) | 0, tc = to % 8;
                if (from < 0 || from > 63 || to < 0 || to > 63 ||
                    Math.abs(tr - fr) !== Math.abs(tc - fc)) {
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

    // Kick calibration off early: it absorbs the engine's slow first image load and
    // the probe round-trip while the player is still in menus, instead of adding
    // seconds (or a mis-calibration) to their first Create/Join/Quick click.
    if (MG.Net.isConfigured()) {
        $.Schedule(5.0, function () { if (!calibrated && !calibrating) calibrate(); });
    }

    log("loaded (configured=" + MG.Net.isConfigured() + ")");
})();
