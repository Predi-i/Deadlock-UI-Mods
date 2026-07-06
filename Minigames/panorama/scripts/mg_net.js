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
    var BASE_URL = "https://deadlock-minigames.CHANGEME.workers.dev";
    // ─────────────────────────────────────────────────────────────────────────

    var REQ_TIMEOUT_MS = 8000;
    var POLL_STEP = 0.05;   // seconds between dimension checks

    function log(msg) { try { $.Msg("[MG.Net] " + msg); } catch (e) {} }

    // Off-screen host that still participates in layout, so image dims resolve.
    // (A collapsed/hidden panel would report size 0 and break everything.)
    var host = null;
    function ensureHost() {
        if (host && host.IsValid && host.IsValid()) return host;
        var ctx = $.GetContextPanel();
        host = $.CreatePanel("Panel", ctx, "MG_NetHost");
        host.style.position = "9000px 9000px 0px"; // pushed off any real screen
        host.style.width = "400px";
        host.style.height = "400px";
        host.style.opacity = "0.01";
        host.style.zIndex = "-1";
        try { host.SetAttributeString("hittest", "false"); } catch (e) {}
        return host;
    }

    var reqCounter = 0;

    // Fire one request; call onDone(rawW, rawH) with the image's pixel dimensions.
    function rawRequest(path, params, onDone, onError) {
        var h = ensureHost();
        var img = $.CreatePanel("Image", h, "mgreq_" + (reqCounter++));
        try { img.SetAttributeString("scaling", "none"); } catch (e) {}
        img.style.width = "auto";
        img.style.height = "auto";
        img.style.position = "0px 0px 0px";

        var qs = "rnd=" + Math.random() + "x" + reqCounter;
        if (params) {
            for (var k in params) {
                if (params.hasOwnProperty(k)) {
                    qs += "&" + k + "=" + encodeURIComponent(params[k]);
                }
            }
        }
        img.SetImage(BASE_URL + path + "?" + qs);

        var elapsed = 0;
        var finished = false;
        function cleanup() { try { img.DeleteAsync(0); } catch (e) {} }
        function check() {
            if (finished) return;
            var w = img.actuallayoutwidth;
            var hh = img.actuallayoutheight;
            if (w > 0 && hh > 0) {
                finished = true;
                cleanup();
                onDone(w, hh);
                return;
            }
            elapsed += POLL_STEP * 1000;
            if (elapsed >= REQ_TIMEOUT_MS) {
                finished = true;
                cleanup();
                log("timeout on " + path);
                if (onError) onError("timeout");
                return;
            }
            $.Schedule(POLL_STEP, check);
        }
        $.Schedule(POLL_STEP, check);
    }

    // Calibration from /api/probe, which returns a known (4, 8) image. This tells us
    // whether the engine reports width/height swapped, and the UI scale factor.
    var swap = false, scaleX = 1, scaleY = 1, calibrated = false, calibrating = false;
    var calibWaiters = [];

    function finishCalib() {
        calibrated = true;
        calibrating = false;
        var ws = calibWaiters; calibWaiters = [];
        for (var i = 0; i < ws.length; i++) { try { ws[i](); } catch (e) {} }
    }

    function calibrate(cb) {
        if (cb) calibWaiters.push(cb);
        if (calibrating) return;
        calibrating = true;
        rawRequest("/api/probe", null, function (w, hh) {
            // Unswapped ~ (4s, 8s); swapped ~ (8s, 4s). 4 < 8, so width>height => swapped.
            if (w > hh) { swap = true; var t = w; w = hh; hh = t; }
            scaleX = w / 4; scaleY = hh / 8;
            if (!(scaleX > 0.1)) scaleX = 1;
            if (!(scaleY > 0.1)) scaleY = 1;
            log("calibrated swap=" + swap + " scaleX=" + scaleX.toFixed(3) + " scaleY=" + scaleY.toFixed(3));
            finishCalib();
        }, function () {
            log("probe failed; assuming swap=false scale=1");
            finishCalib();
        });
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
        if (calibrated) go(); else calibrate(go);
    }

    MG.Net = {
        request: request,
        recalibrate: function (cb) { calibrated = false; calibrate(cb); },
        isConfigured: function () { return BASE_URL.indexOf("CHANGEME") < 0; },
        getBaseUrl: function () { return BASE_URL; }
    };

    // ── Typed protocol layer ────────────────────────────────────────────────
    MG.Api = {
        create: function (game, cb, err) {
            request("/api/create", { game: game }, function (w, h) {
                cb(w * 100 + (h - 1)); // CODE = hi*100 + lo
            }, err);
        },

        join: function (code, cb, err) {
            request("/api/join", { code: code }, function (w, h) {
                if (w >= 1 && w <= 9) cb({ ok: true, game: w });
                else if (w === 20) cb({ ok: false, reason: "missing" });
                else if (w === 21) cb({ ok: false, reason: "full" });
                else cb({ ok: false, reason: "error" });
            }, err);
        },

        status: function (code, cb, err) {
            request("/api/status", { code: code }, function (w, h) {
                if (w === 9) cb({ gone: true, players: 0 });
                else cb({ gone: false, players: w });
            }, err);
        },

        move: function (code, from, to, end, cb, err) {
            request("/api/move", { code: code, from: from, to: to, end: end ? 1 : 0 },
                function (w, h) { if (cb) cb(w < 9); }, err);
        },

        poll: function (code, since, cb, err) {
            request("/api/poll", { code: code, since: since }, function (w, h) {
                var end = w > 100 ? 1 : 0;
                var from = (end ? w - 100 : w) - 1;
                var to = h - 1;
                if (from === to) { cb(null); return; }   // (1,1) => nothing new
                cb({ from: from, to: to, end: end, seq: since + 1 });
            }, err);
        },

        reset: function (code, game, cb, err) {
            request("/api/reset", { code: code, game: game },
                function (w, h) { if (cb) cb(w < 9); }, err);
        }
    };

    log("loaded (configured=" + MG.Net.isConfigured() + ")");
})();
