#!/usr/bin/env node
/*
 * mg_simulate_resolutions.js - offline monitor-resolution tester for the Deadlock
 * Minigames image side-channel. Proves the encode/decode survives a given display
 * WITHOUT shipping a repack to a tester every time. Ported from QOLLOCK's
 * scripts/simulate_resolutions.js (same engine model), but minigames has a very
 * different downlink: not one byte stream, but ~30 bespoke routes each packing TWO
 * independent integers into (width,height). So this tool validates the LEVEL
 * transport across the full value range AND replays every route's real value set to
 * prove no data value collides with that route's own (9,x)/(20,x)/(21,x) sentinels.
 *
 * Background: Panorama has no fetch. The worker answers each request with a tiny PNG
 * whose (width,height) encode data; the client reads actuallayoutwidth/height. The
 * engine ROUNDS that layout size, and on a UI-scaled display it also biases SMALL
 * sizes upward by ~1-2px. The OLD encoding (dim = int+1, STEP=1) dies there: value 1
 * renders indistinguishable from 2, corrupting corner-square moves, the (1,1)
 * sentinel, and every code half. See github2/IMAGE_SIDECHANNEL_1PX_BUG.md.
 *
 * THE FIX (this scheme): one small "level" per dimension, widely spaced:
 *   dim = level*STEP + BASE      (STEP=9, BASE=15)
 * Adjacent levels sit 9 logical px apart, so a +/-2px engine error can't cross a
 * boundary even when a sub-1080p display DOWNSCALES (downscale amplifies an absolute
 * px error by 1/uiScale). Safe range is levels 0..LEVEL_MAX per dimension; every value
 * the minigames protocol emits fits in it.
 *
 * WHAT IT MODELS (faithfully mirrors worker.core.js enc + mg_net.js decode):
 *   server:  dim = level*STEP + BASE          (enc2)
 *   engine:  actualPx = round(dim*uiScale) + bias, clamped to host*uiScale
 *            uiScale = verticalResolution / 1080   (Source2 Panorama reference)
 *            bias    = the small-size upward error; we sweep a worst-case RANGE
 *                      and require EVERY value in it to decode right
 *   client:  probe(600px) -> scale = probeActualPx / 600
 *            decodeWH: px / scale                (NO rounding)
 *            decodeLevel: round((px/scale - BASE)/STEP)   (the single rounding step)
 *
 * DRIFT GUARD: STEP/BASE are parsed out of the real source files (worker.core.js and
 * mg_net.js) and asserted to match each other and this tool's constants, so a future
 * tuning can't make the simulator silently lie.
 *
 * Usage:
 *   node tools/mg_simulate_resolutions.js            # full matrix, summary table
 *   node tools/mg_simulate_resolutions.js --verbose  # also list every failure
 *   node tools/mg_simulate_resolutions.js --bias N   # max upward small-size bias px (default 2)
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ── Encoding constants (mirrored from source; verified against it below) ──
const STEP = 9;
const BASE = 15;

// Highest level any single dimension carries. dim = LEVEL_MAX*STEP+BASE must stay
// UNDER the probe envelope (600px) so a response image is never clamped to the host
// panel. 63*9+15 = 582px < 600. All protocol values fit in 0..63.
const LEVEL_MAX = 63;

// Host panel styled size (layout units) - from mg_net.js host style. Response images
// are clamped to host*uiScale; we model that to catch any clamp regression.
const HOST_W = 640, HOST_H = 1020;
const PROBE_W = 600, PROBE_H = 1000;

// ── Drift guard: parse the real files and confirm nothing has diverged ──
function parseConst(file, name) {
  const src = fs.readFileSync(file, "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "");
  const m = code.match(new RegExp("(?:const|var|let)[^;\\n]*\\b" + name + "\\s*=\\s*(\\d+)"));
  if (!m) throw new Error("could not find `" + name + "` in " + path.basename(file));
  return parseInt(m[1], 10);
}
function verifySourcesMatch() {
  const root = path.resolve(__dirname, "..");
  const worker = path.join(root, "server", "worker.core.js");
  const client = path.join(root, "panorama", "scripts", "mg_net.js");
  const pairs = [
    ["worker.core.js STEP", parseConst(worker, "STEP"), STEP],
    ["worker.core.js BASE", parseConst(worker, "BASE"), BASE],
    ["mg_net.js STEP", parseConst(client, "STEP"), STEP],
    ["mg_net.js BASE", parseConst(client, "BASE"), BASE],
    ["mg_net.js HOST_W", parseConst(client, "HOST_W"), HOST_W],
    ["mg_net.js HOST_H", parseConst(client, "HOST_H"), HOST_H],
  ];
  const bad = pairs.filter(([, got, want]) => got !== want);
  if (bad.length) {
    console.error("DRIFT: simulator constants no longer match source:");
    for (const [what, got, want] of bad) console.error("  " + what + " source=" + got + " sim=" + want);
    console.error("Update mg_simulate_resolutions.js (or the source) so they agree, then re-run.");
    process.exit(2);
  }
}

// ── Protocol math (mirrors worker.core.js enc + mg_net.js decode) ──
const enc = (level) => level * STEP + BASE;
const decodeLevel = (px, scale) => Math.round((px / scale - BASE) / STEP);

// Engine: render an intrinsic PNG dim to the actuallayout px the client reads.
function render(intrinsicPx, uiScale, bias, hostLimitPx) {
  let px = Math.round(intrinsicPx * uiScale) + bias;
  if (px > hostLimitPx) px = hostLimitPx;   // host clamp
  if (px < 1) px = 1;                        // never below 1px
  return px;
}

// ── Resolution matrix. uiScale = height/1080 (Source2 Panorama reference). ──
const RESOLUTIONS = [
  { name: "1280x720  (720p)",       w: 1280, h: 720 },
  { name: "1366x768  (laptop)",     w: 1366, h: 768 },
  { name: "1600x900  (900p)",       w: 1600, h: 900 },
  { name: "1920x1080 (1080p)",      w: 1920, h: 1080 },
  { name: "1920x1200 (16:10)",      w: 1920, h: 1200 },
  { name: "2560x1080 (UW 1080)",    w: 2560, h: 1080 },
  { name: "2560x1440 (1440p)",      w: 2560, h: 1440 },
  { name: "3440x1440 (UW 1440)",    w: 3440, h: 1440 },
  { name: "2560x1600 (16:10 QHD+)", w: 2560, h: 1600 },
  { name: "3840x1600 (UW 1600)",    w: 3840, h: 1600 },
  { name: "3840x2160 (4K)",         w: 3840, h: 2160 },
  { name: "5120x2160 (5K2K)",       w: 5120, h: 2160 },
  { name: "7680x4320 (8K)",         w: 7680, h: 4320 },
];

// ── The value sets every route actually emits (width axis, height axis) ──
// Each entry stresses the REAL integers a route can return, so a decode that lands on
// a sentinel or out of range is caught. Values must all be levels 0..LEVEL_MAX.
function protocolValues() {
  const cases = [];
  const push = (route, w, h) => cases.push({ route, w, h });

  // Universal sentinels shared by many routes.
  push("sentinel ok", 1, 1);
  push("sentinel gone(9,9)", 9, 9);
  for (let hh = 1; hh <= 9; hh++) push("sentinel err(9,h)", 9, hh);
  push("sentinel busy(9,4)", 9, 4);
  push("sentinel missing(20,1)", 20, 1);
  push("sentinel full(21,1)", 21, 1);
  push("sentinel started(22,1)", 22, 1);

  // Codes rebased to 0..1023, split hi=code>>5 (0..31), lo=code&31 (0..31), host flag
  // adds 32 to the LO axis. Stress the extremes + the host-flag variants.
  const codes = [0, 1, 31, 32, 1023, 777, 500];
  for (const c of codes) {
    const hi = (c >> 5) & 31, lo = c & 31;
    push("code join", hi, lo);
    push("code host", hi, lo + 32);
  }

  // Moves: from/to are raw squares 0..63 (no +1). from==to only for "nothing new".
  push("poll empty", 0, 0);
  push("poll move 0->28", 0, 28);
  push("poll move 63->36", 63, 36);
  push("poll move 12->21", 12, 21);
  push("pollend flags", 1, 1); // end-bit read is its own (1,1)/(2,1)
  push("pollend flags", 2, 1);

  // Clocks: one seat per read, seconds 0..600 as hi=sec>>6 (0..9), lo=sec&63.
  for (const s of [0, 1, 60, 180, 300, 599, 600]) push("clock seat", (s >> 6) & 63, s & 63);

  // status/join/room: players 1..4, game 1..9, cap 2..4, tc 0..600(as 2 levels via clock path)
  for (let p = 1; p <= 4; p++) push("status players", p, 1);
  for (let g = 1; g <= 9; g++) push("status game+1", 2, g);
  for (let c = 2; c <= 4; c++) push("djoin cap/seat", c, c);

  // Durak dlog events (w, h) - full documented ranges.
  push("dlog trump", 2, 36);
  push("dlog open", 3, 4);
  push("dlog roles", 4, 16);
  for (let s = 0; s <= 3; s++) push("dlog play", 10 + s, 36);
  for (let s = 0; s <= 5; s++) push("dlog cover", 20 + s, 36);
  for (let s = 0; s <= 3; s++) push("dlog take", 30 + s, 1);
  push("dlog bito", 40, 1);
  for (let s = 0; s <= 3; s++) push("dlog pass", 41 + s, 1);
  for (let s = 0; s <= 3; s++) push("dlog left", 45 + s, 1);
  for (let s = 0; s <= 3; s++) push("dlog draw", 50 + s, 7);
  push("dlog over", 60, 5);
  for (let card = 0; card <= 35; card++) push("ddraw card", card + 2, 1);

  // Poker plog events.
  push("plog hand", 2, 4);
  push("plog board", 5, 52);
  push("plog win", 7, 1);
  push("plog over", 8, 1);
  for (let s = 0; s <= 3; s++) push("plog fold", 10 + s, 1);
  for (let s = 0; s <= 3; s++) push("plog check", 20 + s, 1);
  for (let s = 0; s <= 3; s++) push("plog call", 30 + s, 1);
  // Raise split into two events: RAISE(40+seat, lo) then RAISEHI(44+seat, hi),
  // to = hi*64 + lo, max 800 -> hi 0..12, lo 0..63. No +1 offset: width is 40..47
  // (never 1), so height 0 can't collide with the (1,1) "nothing new" marker, and
  // (lo&63)+1 would otherwise overflow LEVEL_MAX when the low 6 bits are all set.
  for (const to of [0, 10, 63, 64, 200, 799, 800]) {
    for (let s = 0; s <= 3; s++) {
      push("plog raise lo", 40 + s, to & 63);
      push("plog raise hi", 44 + s, (to >> 6) & 63);
    }
  }
  for (let s = 0; s <= 3; s++) push("plog left", 50 + s, 1);
  for (let s = 0; s <= 3; s++) push("plog show", 60 + s, 52);
  for (let card = 0; card <= 51; card++) push("pdraw card", card + 2, 1);

  return cases;
}

// Run the full round trip for one display, requiring EVERY bias in [0..maxBias]
// (per dimension) to decode back to the exact levels the server sent.
function testResolution(res, maxBias, verbose) {
  const uiScale = res.h / 1080;
  const hostLimitW = Math.round(HOST_W * uiScale);
  const hostLimitH = Math.round(HOST_H * uiScale);

  // Probe calibration: the 600x1000 reference. Large, so no small-size bias - the
  // client recovers scale from it exactly the way the game does.
  const probeActualW = render(PROBE_W, uiScale, 0, hostLimitW);
  const probeActualH = render(PROBE_H, uiScale, 0, hostLimitH);
  const scaleX = probeActualW / PROBE_W;
  const scaleY = probeActualH / PROBE_H;

  const cases = protocolValues();
  const failures = [];

  for (const c of cases) {
    if (c.w > LEVEL_MAX || c.h > LEVEL_MAX || c.w < 0 || c.h < 0) {
      failures.push({ ...c, reason: "value out of level range 0.." + LEVEL_MAX });
      continue;
    }
    // Stress each axis across the full bias range independently.
    for (let bw = 0; bw <= maxBias; bw++) {
      for (let bh = 0; bh <= maxBias; bh++) {
        const pxW = render(enc(c.w), uiScale, bw, hostLimitW);
        const pxH = render(enc(c.h), uiScale, bh, hostLimitH);
        const dw = decodeLevel(pxW, scaleX);
        const dh = decodeLevel(pxH, scaleY);
        if (dw !== c.w || dh !== c.h) {
          failures.push({ ...c, reason: "sent (" + c.w + "," + c.h + ") biasW=" + bw + " biasH=" + bh +
            " -> px (" + pxW + "," + pxH + ") -> decoded (" + dw + "," + dh + ")" });
        }
      }
    }
  }
  return { uiScale, total: cases.length, failures };
}

function main() {
  // --no-drift-check lets the scheme be validated BEFORE the source files declare
  // STEP/BASE (i.e. before the worker/client patches land). Once they're in, the
  // guard runs by default and fails loudly on any divergence.
  if (!process.argv.includes("--no-drift-check")) verifySourcesMatch();

  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  let maxBias = 2;
  const bi = args.indexOf("--bias");
  if (bi >= 0 && args[bi + 1]) maxBias = parseInt(args[bi + 1], 10) || 2;

  console.log("Deadlock Minigames resolution simulator - STEP=" + STEP + " BASE=" + BASE +
    " LEVEL_MAX=" + LEVEL_MAX + ", worst-case engine bias 0.." + maxBias + "px");
  console.log("(uiScale = height/1080; every route value stressed across the full bias range)\n");
  console.log("  resolution              uiScale  values  result");
  console.log("  ----------------------  -------  ------  ------");

  let allPass = true;
  const allFailures = [];
  for (const res of RESOLUTIONS) {
    const r = testResolution(res, maxBias, verbose);
    const ok = r.failures.length === 0;
    if (!ok) { allPass = false; allFailures.push({ res, failures: r.failures }); }
    console.log("  " + res.name.padEnd(22) + "  " + r.uiScale.toFixed(3).padStart(6) +
      "  " + String(r.total).padStart(6) + "  " + (ok ? "PASS" : "FAIL (" + r.failures.length + ")"));
  }

  console.log("");
  if (allPass) {
    console.log("ALL RESOLUTIONS PASS - every route value survives encode/decode on every modelled display.");
    process.exit(0);
  } else {
    console.log("FAILURES DETECTED.");
    if (verbose) {
      for (const { res, failures } of allFailures) {
        console.log("\n" + res.name + ":");
        for (const f of failures.slice(0, 40)) console.log("  [" + f.route + "] " + f.reason);
        if (failures.length > 40) console.log("  ... +" + (failures.length - 40) + " more");
      }
    } else {
      console.log("Re-run with --verbose to list every failing value.");
    }
    process.exit(1);
  }
}

main();
