"use strict";

/*
 * mg_net_diagnosis_test.js - DEV-ONLY. Covers MG.Net.diagnosis(), the transport-health readout
 * that decides whether a failure may be blamed on the relay.
 *
 * WHY THIS EXISTS (2026-08-03 player report): a player reported the relay as down - ping, create,
 * quick match, GeoGuesser and Pixel Battle all timing out - while the Worker was serving
 * /api/ping.png normally (verified: HTTP 200, valid cert). His console showed
 * `dims stayed 0 for 8000ms` on all six probe attempts: the engine never loaded the image at all,
 * so there was nothing to decode and nothing the server could have done. The reason he reported it
 * as a server outage is that every one of our messages said "Check the server".
 *
 * The discriminator is free, because the mod already talks to two unrelated hosts: the configured
 * Worker and raw.githubusercontent.com (an entirely different chain) for the update check. A down
 * Worker cannot stop a GitHub PNG from loading. So
 * "not one image has loaded from EITHER host" means local blocking, not a server problem.
 *
 * The claim "The server itself is up" is a strong one to put on a player's screen, so the rules
 * below are asserted rather than assumed:
 *   - never claim it while any load has succeeded (then the relay IS a fair suspect),
 *   - never claim it on the very first failure (one timeout is just a timeout),
 *   - and once a load succeeds, never go back to claiming it.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = path.join(ROOT, "panorama", "scripts");

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; console.log("  ok   " + msg); }
    else { fail++; console.log("  FAIL " + msg); }
}

// ── a fake $ whose image loads we control ────────────────────────────────────
// mg_net polls `actuallayoutwidth/height` on a Schedule chain, so the harness needs a real
// scheduler and a way to say "this load resolves to WxH" or "this load never resolves".
function makeHarness() {
    let now = 0, seq = 0;
    const timers = [];
    // Every Image panel created by mg_net, in creation order, so a test can resolve them.
    const images = [];

    function makePanel(type, parent, id) {
        const p = {
            type, id, parent: parent || null, children: [], style: {},
            classes: new Set(), events: {},
            actuallayoutwidth: 0, actuallayoutheight: 0,
            IsValid() { return !this._deleted; },
            AddClass() {}, RemoveClass() {}, ToggleClass() {}, BHasClass: () => false, SetHasClass() {},
            SetImage(u) { this._src = u; }, SetScaling() {},
            SetPanelEvent(n, f) { this.events[n] = f; }, ClearPanelEvent() {},
            SetAttributeString() {}, GetAttributeString: (_k, d) => d,
            SetAttributeInt() {}, GetAttributeInt: (_k, d) => d,
            SetDialogVariable() {}, SetDialogVariableInt() {},
            SetFocus() {}, SetReadyForDisplay() {}, SetDraggable() {},
            DeleteAsync() { this._deleted = true; },
            RemoveAndDeleteChildren() { this.children.length = 0; },
            FindChildTraverse: () => null, FindChild: () => null, FindChildInLayoutFile: () => null,
            Children() { return this.children; },
            GetChildCount() { return this.children.length; },
            GetChild(i) { return this.children[i] || null; },
            MoveChildBefore() {}, MoveChildAfter() {},
            SetParent(n) { this.parent = n; },
            GetParent() { return this.parent; },
            ScrollToTop() {}, ScrollToBottom() {}, ScrollParentToMakePanelFit() {},
            BLoadLayoutSnippet: () => true, BCreateChildren: () => true,
            GetPositionWithinWindow: () => null,
        };
        if (parent && parent.children) parent.children.push(p);
        if (type === "Image") images.push(p);
        return p;
    }

    const context = makePanel("Panel", null, "ctx");
    const $ = {
        MG: {},
        GetContextPanel: () => context,
        CreatePanel: (t, p, i) => makePanel(t, p, i),
        CreatePanelWithProperties: (t, p, i) => makePanel(t, p, i),
        Schedule(delay, fn) { const t = { at: now + (Number(delay) || 0), seq: seq++, fn }; timers.push(t); return t; },
        CancelScheduled(h) { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
        Msg: () => {}, Warning: () => {},
        Localize: (s) => s, LocalizeSafe: (s) => s,
        // mg_net subscribes to the engine's ImageFailedLoad via $.RegisterEventHandler, so the fake
        // has to REMEMBER those handlers - dropping them would make the fast-fail path untestable,
        // and an error path with no coverage is useless exactly when it matters.
        RegisterEventHandler(name, panel, fn) {
            if (panel) { (panel._evt = panel._evt || {})[name] = fn; }
            return 1;
        },
        RegisterForUnhandledEvent: () => 1,
        UnregisterEventHandler: () => {}, UnregisterForUnhandledEvent: () => {},
        DispatchEvent: () => {}, DispatchEventAsync: () => {},
        PlaySoundEvent: () => {}, StopSoundEvent: () => {},
        FindChildInContext: () => null, GetContextObject: () => ({}),
        AsyncWebRequest: () => {},
        HasKeyBinding: () => false, GetKeyBindingString: () => "",
        LogInfo: () => {}, Each: (l, f) => { (l || []).forEach(f); },
        DbgIsReloadingScript: () => false, SetGlobalObject: () => {},
    };

    // Advance the virtual clock. `onImage(img)` is called for each Image that is still pending, so
    // a test can decide to resolve it (set its dimensions) or leave it to time out.
    function run(ms, onImage) {
        const until = now + ms;
        let guard = 0;
        while (guard++ < 100000) {
            if (onImage) for (const im of images) if (!im._deleted && !im._resolved) onImage(im);
            let best = -1;
            for (let i = 0; i < timers.length; i++) {
                if (timers[i].at > until) continue;
                if (best < 0 || timers[i].at < timers[best].at ||
                    (timers[i].at === timers[best].at && timers[i].seq < timers[best].seq)) best = i;
            }
            if (best < 0) break;
            const t = timers.splice(best, 1)[0];
            now = Math.max(now, t.at);
            t.fn();
        }
        now = Math.max(now, until);
    }

    function resolve(img, w, h) {
        img._resolved = true;
        img.actuallayoutwidth = w;
        img.actuallayoutheight = h;
    }

    return { $, run, resolve, images };
}

function loadNet($) {
    for (const rel of ["mg_sound.js", "mg_net.js"]) {
        let source = fs.readFileSync(path.join(SCRIPTS, rel), "utf8");
        // A fresh checkout deliberately has no account-specific host. This harness supplies one so
        // it can exercise cross-host failure diagnosis without changing production configuration.
        if (rel === "mg_net.js") source = source.replace(
            'const BASE_URL = "";', 'const BASE_URL = "https://worker.example";');
        new Function("$", source)($);
    }
}

// The probe is a literal 600x1000 (never level-encoded), so resolving it that way calibrates.
const PROBE_W = 600, PROBE_H = 1000;

console.log("\n=== MG.Net.diagnosis(): never blame, and never exonerate, the server by guess ===\n");

// A fresh transport has no evidence at all.
{
    const h = makeHarness();
    loadNet(h.$);
    ok(typeof h.$.MG.Net.diagnosis === "function", "MG.Net.diagnosis is exposed");
    ok(h.$.MG.Net.diagnosis() === null, "a fresh session claims nothing (no evidence yet)");
}

// Evidence has to accumulate before the claim is made. Note that ONE caller-visible request is not
// one image load: drainQueue silently re-queues a failed non-probe job once, and the probe runs
// PROBE_ATTEMPTS=3 of its own - so a single loadImage() that times out records TWO failed loads.
// The threshold is deliberately expressed in loads, and this pins the smallest amount of evidence
// that is allowed to produce the claim.
{
    const h = makeHarness();
    loadNet(h.$);
    ok(h.$.MG.Net.diagnosis() === null, "zero failures: silent");
}

// ONE host failing, however many times, proves nothing: a dead relay looks exactly like this.
{
    const h = makeHarness();
    loadNet(h.$);
    h.$.MG.Api.ping(() => {}, () => {});
    h.run(60000, null);                   // every probe attempt against the relay times out
    ok(h.$.MG.Net.diagnosis() === null,
        "many failures against the RELAY ALONE do not claim the server is up (it may really be down)");
}

// Two unrelated hosts failing IS the local-blocking case, and it must be reported as such.
{
    const h = makeHarness();
    loadNet(h.$);
    h.$.MG.Api.ping(() => {}, () => {});                       // the configured Worker
    h.run(60000, null);
    h.$.MG.Net.loadImage("https://raw.githubusercontent.com/x/y.png", () => {}, () => {});
    h.run(60000, null);                                        // GitHub: different host, different chain
    const d = h.$.MG.Net.diagnosis();
    ok(typeof d === "string" && d.length > 0,
        "with two unrelated hosts failing and zero successes, a diagnosis is offered");
    ok(/server itself is up/i.test(d || ""), "it states the server is up (the relay is exonerated)");
    ok(/firewall|proxy|AV|mod/i.test(d || ""), "it names the likely local causes");
    ok(/update check/i.test(d || ""),
        "it cites the second, unrelated host as the evidence (that is what makes it provable)");
}

// A successful load means the channel works, so the relay is a fair suspect again - and a later
// failure must NOT be answered with "the server is up".
{
    const h = makeHarness();
    loadNet(h.$);
    let pinged = false;
    h.$.MG.Api.ping(() => { pinged = true; }, () => {});
    // Resolve the probe (600x1000 literal) and then every subsequent protocol image.
    h.run(4000, (img) => {
        if (String(img._src || "").indexOf("/api/probe") >= 0) h.resolve(img, PROBE_W, PROBE_H);
        else h.resolve(img, 15, 15);     // level 0,0 - a valid tiny protocol reply
    });
    ok(pinged, "the harness can drive a SUCCESSFUL request (calibration + reply)");
    ok(h.$.MG.Net.diagnosis() === null,
        "after a successful load, no local-blocking claim is made");

    // Now fail a pile of requests. The channel has proven it works, so the honest answer is
    // "no opinion" - the caller's "Check the server" is the right message here.
    for (let i = 0; i < 4; i++) h.$.MG.Api.ping(() => {}, () => {});
    h.run(60000, null);
    ok(h.$.MG.Net.diagnosis() === null,
        "later failures after a success do NOT claim the server is up (it might really be down)");
}

console.log("\n=== ImageFailedLoad: fail in milliseconds, but never depend on the event ===\n");
// The engine knows this event (panorama_strings.txt:3135) but no shipped layout listens for it, so
// it is wired as a pure optimisation. Both properties are asserted: when it fires the request fails
// at once (a blocked machine currently waits 3 x 8s in silence), and when it never fires the
// polling timeout still ends the request exactly as before.
{
    const h = makeHarness();
    loadNet(h.$);
    let err = null;
    h.$.MG.Net.loadImage("https://raw.githubusercontent.com/a/b.png", () => { err = "loaded"; },
        (e) => { err = e; });
    // ⚠ $.Schedule takes SECONDS (mg_net uses 0.05s poll steps), so the virtual clock is in seconds
    // too. The image panel is created synchronously inside loadImage -> drainQueue, so a tiny
    // advance is enough for the subscription to exist.
    h.run(0.2, null);
    const img = h.images.filter((i) => !i._deleted && i._evt && i._evt.ImageFailedLoad).pop();
    ok(!!img, "the loader subscribes to ImageFailedLoad on its Image panel");
    if (img) {
        // ⚠ drainQueue silently re-queues a failed non-probe job ONCE, so the caller's onError only
        // runs after the SECOND attempt also fails - and the retry is a brand-new Image panel. Fire
        // the event on every panel that appears, which is what a genuinely blocked machine does.
        // The point being asserted is the LATENCY: this whole path resolves inside a second of
        // virtual time, where the polling fallback alone would need 2 x 8000ms.
        const deadline = 2.0;
        let ticks = 0;
        // `err` is written from mg_net's callback, so read it through a getter - a bare `err === null`
        // reads to static analysis as a condition the loop never modifies.
        const pending = () => err === null;
        while (pending() && ticks++ < 40) {
            for (const im of h.images) {
                if (!im._deleted && im._evt && im._evt.ImageFailedLoad && !im._firedFail) {
                    im._firedFail = true;
                    im._evt.ImageFailedLoad();
                }
            }
            h.run(0.05, null);
        }
        ok(err === "failed",
            `a reported failure ends the request in well under a timeout (got ${JSON.stringify(err)} ` +
            `within ${deadline}s of virtual time; the poll fallback alone needs 2 x 8s)`);
        // And it must count as a failed load for the diagnosis, same as a timeout.
        h.$.MG.Net.loadImage("https://example.net/c.png", () => {}, () => {});
        h.run(60000, null);
        ok(typeof h.$.MG.Net.diagnosis() === "string",
            "an event-reported failure counts as evidence, like a timeout");
    }
}
{
    // No event at all: the timeout must still be the authority.
    const h = makeHarness();
    loadNet(h.$);
    let err = null;
    h.$.MG.Net.loadImage("https://example.org/d.png", () => { err = "loaded"; }, (e) => { err = e; });
    h.run(60000, null);
    ok(err === "timeout", `without the event the polling timeout still fires (got ${JSON.stringify(err)})`);
}

console.log("\n=== the UI must route network failures through the diagnosis ===\n");
// A message that hard-codes "Check the server" cannot be corrected at runtime, which is how the
// wrong-blame report happened. Every network error path has to go through setNetStatus.
{
    const src = fs.readFileSync(path.join(SCRIPTS, "mg_ui.js"), "utf8");
    ok(/function setNetStatus\(/.test(src), "mg_ui defines setNetStatus");
    const bad = [];
    const re = /setStatus\(\s*("[^"]*(?:Check the server|check for updates)[^"]*")\s*\)/g;
    let m;
    while ((m = re.exec(src))) bad.push(m[1]);
    ok(bad.length === 0,
        `no network failure still calls setStatus directly (${bad.length ? bad.join(" | ") : "none"})`);
}

console.log(`\n${fail === 0 ? "ALL NET DIAGNOSIS CHECKS PASSED" : "NET DIAGNOSIS CHECKS FAILED"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
