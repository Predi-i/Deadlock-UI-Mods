"use strict";

/*
 * mg_es6_invariants_test.js - standing guard on the SHIPPED tree (not on a codemod).
 *
 * WHY THIS EXISTS SEPARATELY FROM THE CODEMOD HARNESSES: mg_es6_codemod_test.js /
 * mg_es6_arrows_test.js / mg_es6_templates_test.js validate the TOOLS against fixtures.
 * They would all stay green if someone later hand-wrote an arrow that reads `this`, or
 * reassigned a `const`. Those harnesses check the transformer; this one checks the CODE.
 *
 * Each invariant below was verified by hand during the ES6 refactor (2026-08-01). This file
 * is what keeps them true afterwards. All four are RUNTIME-FATAL or SILENTLY-WRONG classes:
 *
 *  1. an arrow that reads `this`      - in Panorama a panel-event handler is invoked with the
 *                                      panel as receiver; an arrow inherits the enclosing
 *                                      `this` instead, so the handler silently targets the
 *                                      wrong object. 184 real `this` uses live in the mod,
 *                                      every one inside a `function` expression on purpose.
 *  2. an arrow that reads `arguments` - arrows have no `arguments` binding; it would resolve
 *                                      to the OUTER function's, or throw at top level.
 *  3. `new` applied to an arrow       - arrows have no [[Construct]]: instant TypeError.
 *  4. a line STARTING with ( [ + - /  - Valve's Panorama minifier does a naive ASI pass and
 *                                      inserts a `;` before such a line. This is a real
 *                                      shipped-build break (ARCHITECTURE §10.1, and it bit
 *                                      mg_games.js:665 once). The arrow codemod refuses 10
 *                                      conversions for exactly this reason; that refusal is
 *                                      only meaningful if nothing reintroduces the pattern.
 *                                      Checked as a DELTA against a recorded baseline, since
 *                                      the codebase legitimately opens IIFEs with `(`.
 */

const fs = require("fs");
const path = require("path");
const espree = require("espree");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = path.join(ROOT, "panorama", "scripts");

let passed = 0;
const failures = [];
function ok(condition, label) {
    if (condition) { passed++; console.log("  ok   " + label); }
    else { failures.push(label); console.log("  FAIL " + label); }
}

function shippedFiles() {
    const out = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith(".js")) out.push(full);
        }
    })(SCRIPTS);
    // The authored worker source ships to Cloudflare and shares rules/*.js, so hold it to the
    // same bar. worker.js is generated from these, so checking the sources covers it.
    out.push(path.join(ROOT, "server", "worker.core.js"));
    return out;
}

// ── walk helper: node + its enclosing-function chain ─────────────────────────

function eachNode(ast, visit) {
    (function walk(node, parent) {
        if (!node || typeof node.type !== "string") return;
        visit(node, parent);
        for (const key of Object.keys(node)) {
            if (key === "range" || key === "loc") continue;
            const val = node[key];
            if (Array.isArray(val)) {
                for (const c of val) if (c && typeof c.type === "string") walk(c, node);
            } else if (val && typeof val.type === "string") {
                walk(val, node);
            }
        }
    })(ast, null);
}

const FN_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/**
 * Does this `this` sit inside an arrow, with no intervening non-arrow function?
 *
 * chain[0] is the INNERMOST enclosing function. If that is an arrow, the `this` is not the
 * arrow's own - it leaks outward, which is the bug. Walking the chain for the first non-arrow
 * "binder" and testing THAT is wrong: it always finds the enclosing IIFE and reports clean,
 * which is exactly how the first version of this file passed a deliberately injected fault.
 */
function thisLeaksThroughArrow(chain) {
    return chain.length > 0 && chain[0].type === "ArrowFunctionExpression";
}

// ── self-test: prove the detectors actually FIRE ──────────────────────────────
//
// A guard that cannot fail is worse than no guard, because it reads as coverage. The first
// version of this file PASSED an arrow using `this` that was injected into mg_ttt.js by hand
// (the binder walk found the enclosing IIFE and declared it clean). So the detectors are run
// against deliberate faults here, in memory, before they are trusted on the real tree.

function detectInSource(code) {
    const ast = espree.parse(code, { ecmaVersion: 2023, sourceType: "script", range: true, loc: true });
    const hits = { arrowThis: 0, arrowArgs: 0, newArrow: 0 };
    (function walk(node, chain) {
        if (!node || typeof node.type !== "string") return;
        const nextChain = FN_TYPES.has(node.type) ? [node].concat(chain) : chain;
        if (node.type === "ThisExpression" && thisLeaksThroughArrow(chain)) hits.arrowThis++;
        if (node.type === "Identifier" && node.name === "arguments" &&
            chain.length && chain[0].type === "ArrowFunctionExpression") hits.arrowArgs++;
        if (node.type === "NewExpression" && node.callee &&
            node.callee.type === "ArrowFunctionExpression") hits.newArrow++;
        for (const key of Object.keys(node)) {
            if (key === "range" || key === "loc") continue;
            const val = node[key];
            if (Array.isArray(val)) { for (const c of val) if (c && typeof c.type === "string") walk(c, nextChain); }
            else if (val && typeof val.type === "string") walk(val, nextChain);
        }
    })(ast, []);
    return hits;
}

console.log("\n=== self-test: the detectors must fire on injected faults ===\n");

// The exact Panorama shape: a controller IIFE, with a handler that reads the receiver.
const FAULT_THIS = '(function () { const probe = () => this.id; return probe; })();';
ok(detectInSource(FAULT_THIS).arrowThis === 1,
    "an arrow reading `this` inside a controller IIFE IS detected");

// Nested one level deeper, past an intervening arrow (still leaks).
const FAULT_THIS_NESTED = '(function () { const a = () => { const b = () => this.x; return b; }; return a; })();';
ok(detectInSource(FAULT_THIS_NESTED).arrowThis === 1,
    "an arrow reading `this` through another arrow IS detected");

// The must-NOT-fire control: a `function` expression legitimately using its receiver.
const CLEAN_THIS = '(function () { const o = { id: 1, get: function () { return this.id; } }; return o; })();';
ok(detectInSource(CLEAN_THIS).arrowThis === 0,
    "a `function` using its own `this` is NOT flagged (no false positive)");

// An arrow INSIDE a method still binds to the method, so `this` there is fine to flag -
// it is the arrow's enclosing `this`, which is the method's. Confirm we flag it (correct:
// it is a receiver-dependent read living in an arrow, the pattern we banned).
ok(detectInSource('(function () { const o = { m: function () { return () => this.v; } }; return o; })();').arrowThis === 1,
    "an arrow reading the enclosing method's `this` IS flagged (banned by convention)");

ok(detectInSource('(function () { const f = () => arguments.length; return f; })();').arrowArgs === 1,
    "an arrow reading `arguments` IS detected");
ok(detectInSource('(function () { function g() { return arguments.length; } return g; })();').arrowArgs === 0,
    "a `function` reading `arguments` is NOT flagged (no false positive)");
ok(detectInSource('const x = new (() => {})();').newArrow === 1,
    "`new` on an arrow IS detected");

// ── the real tree ────────────────────────────────────────────────────────────

const problems = { arrowThis: [], arrowArgs: [], newArrow: [] };

for (const file of shippedFiles()) {
    const rel = path.relative(ROOT, file);
    const src = fs.readFileSync(file, "utf8");
    const sourceType = rel.includes("worker.core") ? "module" : "script";
    const ast = espree.parse(src, { ecmaVersion: 2023, sourceType, range: true, loc: true });

    (function walk(node, chain) {
        if (!node || typeof node.type !== "string") return;
        const nextChain = FN_TYPES.has(node.type) ? [node].concat(chain) : chain;

        if (node.type === "ThisExpression" && thisLeaksThroughArrow(chain)) {
            problems.arrowThis.push(`${rel}:${node.loc.start.line}`);
        }
        if (node.type === "Identifier" && node.name === "arguments" && chain.length &&
            chain[0].type === "ArrowFunctionExpression") {
            problems.arrowArgs.push(`${rel}:${node.loc.start.line}`);
        }
        if (node.type === "NewExpression" && node.callee &&
            node.callee.type === "ArrowFunctionExpression") {
            problems.newArrow.push(`${rel}:${node.loc.start.line}`);
        }

        for (const key of Object.keys(node)) {
            if (key === "range" || key === "loc") continue;
            const val = node[key];
            if (Array.isArray(val)) {
                for (const c of val) if (c && typeof c.type === "string") walk(c, nextChain);
            } else if (val && typeof val.type === "string") {
                walk(val, nextChain);
            }
        }
    })(ast, []);
}

console.log("\n=== arrows must never capture a receiver or arity binding ===\n");
ok(problems.arrowThis.length === 0,
    "no arrow reads `this` (found: " + (problems.arrowThis.join(", ") || "none") + ")");
ok(problems.arrowArgs.length === 0,
    "no arrow reads `arguments` (found: " + (problems.arrowArgs.join(", ") || "none") + ")");
ok(problems.newArrow.length === 0,
    "no arrow is used with `new` (found: " + (problems.newArrow.join(", ") || "none") + ")");

// A positive control: if the detector is broken, the counts above are vacuous. There MUST be
// real `this` in the mod, all of it inside `function` expressions.
let realThis = 0;
for (const file of shippedFiles()) {
    const src = fs.readFileSync(file, "utf8");
    const sourceType = file.includes("worker.core") ? "module" : "script";
    const ast = espree.parse(src, { ecmaVersion: 2023, sourceType, range: true, loc: true });
    eachNode(ast, (n) => { if (n.type === "ThisExpression") realThis++; });
}
ok(realThis > 100,
    "positive control: the tree really does use `this` (" + realThis + " sites), so the zero above is meaningful");

// ── Valve minifier ASI guard ─────────────────────────────────────────────────
//
// Recorded baseline of lines that legitimately start with a trigger char (IIFE openers and
// array-literal continuations that predate the ES6 pass). The guard is a DELTA: the count may
// go DOWN freely, but a new one is a shipped-build hazard and must be reviewed. If you
// intentionally add one, update this number and say why in the commit message.
const ASI_BASELINE = 62;

let asiCount = 0;
const asiLines = [];
for (const file of shippedFiles()) {
    if (!file.includes("panorama")) continue;   // the minifier only processes the VPK scripts
    const rel = path.relative(ROOT, file);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    let inBlockComment = false;
    lines.forEach((line, i) => {
        const t = line.trim();
        // Skip comment bodies: a `*` continuation or a commented-out example is not code.
        if (inBlockComment) { if (t.includes("*/")) inBlockComment = false; return; }
        if (t.startsWith("/*")) { if (!t.includes("*/")) inBlockComment = true; return; }
        if (t.startsWith("//") || t.startsWith("*")) return;
        if (/^[([+\-/]/.test(t)) { asiCount++; asiLines.push(`${rel}:${i + 1}  ${t.slice(0, 60)}`); }
    });
}
ok(asiCount <= ASI_BASELINE,
    `no NEW line starts with an ASI trigger char (${asiCount} <= baseline ${ASI_BASELINE})`);
if (asiCount > ASI_BASELINE) {
    console.log("\n  lines starting with ( [ + - / :");
    for (const l of asiLines) console.log("    " + l);
}

console.log("");
if (failures.length) {
    console.log(`ES6 INVARIANT CHECKS FAILED  (${passed} passed, ${failures.length} failed)`);
    process.exit(1);
}
console.log(`ALL ES6 INVARIANT CHECKS PASSED  (${passed} passed) - ${realThis} \`this\` sites, all in \`function\``);
