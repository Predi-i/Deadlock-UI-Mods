"use strict";
// mg_uiscale_test.js - the ui-scale clamp must keep the TALLEST view on screen.
//
// Regression guard for a bug the maintainer hit in-game: at 125% the poker LEAVE button was
// simply gone. Two separate ceilings existed and were the wrong way round:
//   * .mg-modal max-height was 92%, and a percentage resolves in the SCALED space, so the real
//     ceiling was 0.92*1080/1.25 = 795px against a poker view needing ~838px. The engine
//     truncated the modal with no scrollbar and no warning - the footer just vanished.
//   * the JS clamp used FIT_MARGIN 0.96, LOOSER than the CSS 0.92, so CSS always clipped first,
//     and it measured the modal height ONCE (from the ~640px menu) rather than per view, so it
//     never knew the ~838px poker felt existed.
// A 99% CSS backstop still clipped the FIRST tall view at 150–200% before JS measured it. The modal
// now has no CSS max-height; JS (0.98, re-measured per view, keeping the tallest reading) is the
// single height authority.
//
// The heights below are measured off the maintainer's 1080p screenshots, so this test asserts
// against the real geometry rather than a guess. Run: node tools/mg_uiscale_test.js
// Reimplement fittedScalePct/measureNaturalH exactly as mg_ui.js has them, then feed the real
// heights measured off the maintainer's screenshots.
const fs = require("fs");
const path = require("path");
const FIT_MARGIN = 0.98, VP = 1080;
let naturalModalH = 0;
function fitted(pct){
  if (pct <= 100 || !naturalModalH) return pct;
  const maxPct = Math.floor((VP * FIT_MARGIN / naturalModalH) * 100);
  return (maxPct >= 100 && pct > maxPct) ? maxPct : pct;
}
function measure(trueNaturalH, pctWanted){
  const applied = fitted(pctWanted)/100;
  const windowH = trueNaturalH * applied;          // uncapped CSS exposes the full natural height
  const natural = windowH / applied;               // divided back out
  if (natural > naturalModalH + 1) naturalModalH = natural;
}
const MENU = 640, POKER = 838;
let fails = 0;
function ok(c,m){ console.log((c?"  ok   ":"  FAIL ")+m); if(!c) fails++; }
const css = fs.readFileSync(path.join(__dirname, "..", "panorama", "styles", "mg.css"), "utf8");
const modalRule = css.match(/\.mg-modal\s*\{([\s\S]*?)\}/);
ok(!!modalRule && !/\bmax-height\s*:/.test(modalRule[1]),
  "production .mg-modal has no CSS max-height that can pre-clip measurement");
console.log("scale 125%, menu -> poker (the reported bug):");
naturalModalH = 0;
measure(MENU, 125);
ok(fitted(125) === 125, "menu at 125% is not clamped (it fits)");
measure(POKER, 125);                                  // switching into poker re-measures
const p = fitted(125);
ok(naturalModalH >= POKER - 1, `poker's taller height was picked up (got ${Math.round(naturalModalH)})`);
ok(p * POKER / 100 <= VP * FIT_MARGIN, `clamped scale ${p}% keeps poker inside the JS ceiling -> LEAVE visible`);
ok(p <= 125, `clamp only ever reduces (got ${p}%)`);
console.log("\nfirst menu -> poker switch at every higher step:");
for (const want of [150,175,200]) {
  naturalModalH = 0;
  measure(MENU, want);
  const before = fitted(want);
  measure(POKER, want);
  const g = fitted(want);
  ok(before > 126, want+"% initially uses the shorter menu measurement ("+before+"%)");
  ok(naturalModalH >= POKER - 1, want+"% sees the full poker height (got "+Math.round(naturalModalH)+")");
  ok(g*POKER/100 <= VP*FIT_MARGIN, want+"% -> "+g+"%, fits");
}
console.log("\ngoing back to the menu must NOT loosen the clamp below what poker needs:");
measure(MENU, 125);
ok(naturalModalH >= POKER - 1, `tallest-seen is retained (got ${Math.round(naturalModalH)})`);
console.log("\n100% is never touched:");
naturalModalH = 0; measure(POKER, 100);
ok(fitted(100) === 100, "100% passes through unclamped");
ok(POKER <= VP*FIT_MARGIN, "and poker at 100% genuinely fits the JS ceiling");
console.log(fails ? `\n${fails} FAILURES` : "\nALL CLAMP CHECKS PASSED");
process.exitCode = fails ? 1 : 0;
