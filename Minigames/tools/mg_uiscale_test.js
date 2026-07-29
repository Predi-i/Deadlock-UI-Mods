"use strict";
// mg_uiscale_test.js — the ui-scale clamp must keep the TALLEST view on screen.
//
// Regression guard for a bug the maintainer hit in-game: at 125% the poker LEAVE button was
// simply gone. Two separate ceilings existed and were the wrong way round:
//   * .mg-modal max-height was 92%, and a percentage resolves in the SCALED space, so the real
//     ceiling was 0.92*1080/1.25 = 795px against a poker view needing ~838px. The engine
//     truncated the modal with no scrollbar and no warning — the footer just vanished.
//   * the JS clamp used FIT_MARGIN 0.96, LOOSER than the CSS 0.92, so CSS always clipped first,
//     and it measured the modal height ONCE (from the ~640px menu) rather than per view, so it
//     never knew the ~838px poker felt existed.
// Now CSS is the looser backstop (99%) and the JS clamp (0.98, re-measured per view, keeping the
// tallest reading) is what decides.
//
// The heights below are measured off the maintainer's 1080p screenshots, so this test asserts
// against the real geometry rather than a guess. Run: node tools/mg_uiscale_test.js
// Reimplement fittedScalePct/measureNaturalH exactly as mg_ui.js has them, then feed the real
// heights measured off the maintainer's screenshots.
const FIT_MARGIN = 0.98, CSS_MAX = 0.99, VP = 1080;
let naturalModalH = 0;
function fitted(pct){
  if (pct <= 100 || !naturalModalH) return pct;
  const maxPct = Math.floor((VP * FIT_MARGIN / naturalModalH) * 100);
  return (maxPct >= 100 && pct > maxPct) ? maxPct : pct;
}
function measure(trueNaturalH, pctWanted){
  const applied = fitted(pctWanted)/100;
  const windowH = trueNaturalH * applied;          // what actuallayoutheight reports
  const natural = windowH / applied;               // divided back out
  if (natural > naturalModalH + 1) naturalModalH = natural;
}
const MENU = 640, POKER = 838;
let fails = 0;
function ok(c,m){ console.log((c?"  ok   ":"  FAIL ")+m); if(!c) fails++; }
console.log("scale 125%, menu -> poker (the reported bug):");
naturalModalH = 0;
measure(MENU, 125);
ok(fitted(125) === 125, "menu at 125% is not clamped (it fits)");
measure(POKER, 125);                                  // switching into poker re-measures
const p = fitted(125);
ok(naturalModalH >= POKER - 1, "poker's taller height was picked up (got "+Math.round(naturalModalH)+")");
ok(p * POKER / 100 <= VP * CSS_MAX, "clamped scale "+p+"% keeps poker inside the CSS ceiling -> LEAVE visible");
ok(p <= 125, "clamp only ever reduces (got "+p+"%)");
console.log("\nhigher steps on 1080p poker:");
for (const want of [150,175,200]) {
  const g = fitted(want);
  ok(g*POKER/100 <= VP*CSS_MAX, want+"% -> "+g+"%, fits");
}
console.log("\ngoing back to the menu must NOT loosen the clamp below what poker needs:");
measure(MENU, 125);
ok(naturalModalH >= POKER - 1, "tallest-seen is retained (got "+Math.round(naturalModalH)+")");
console.log("\n100% is never touched:");
naturalModalH = 0; measure(POKER, 100);
ok(fitted(100) === 100, "100% passes through unclamped");
ok(POKER <= VP*CSS_MAX, "and poker at 100% genuinely fits the CSS ceiling");
console.log(fails ? "\n"+fails+" FAILURES" : "\nALL CLAMP CHECKS PASSED");
process.exitCode = fails ? 1 : 0;
