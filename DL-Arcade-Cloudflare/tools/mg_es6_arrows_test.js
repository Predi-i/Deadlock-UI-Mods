"use strict";

/*
 * mg_es6_arrows_test.js - DEV-ONLY. Proves tools/es6_arrows.js is SAFE before it is allowed
 * near the shipped scripts.
 *
 * An arrow is not a shorter `function`: it has no own `this`, no `arguments`, no
 * [[Construct]], and no self-name for recursion, and it ignores a `.bind()` receiver. Each
 * fixture below is a pattern that MUST keep `function` because converting it changes an
 * observable result, plus the plain-callback cases that MUST convert so the tool isn't a
 * no-op. Runnable fixtures are EXECUTED before and after; the output must match.
 *
 * The Panorama-specific one is `this`: the engine invokes some handlers with the panel as
 * the receiver, and those controllers cannot run outside the game, so a silent `this` change
 * would only surface live.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CODEMOD = path.join(ROOT, "tools", "es6_arrows.js");

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; console.log("  ok   " + msg); }
    else { fail++; console.log("  FAIL " + msg); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mg-arrow-"));
const scratchDir = path.join(tmpRoot, "tools");
fs.mkdirSync(scratchDir, { recursive: true });

// Run the codemod from the REPO (so require("espree") resolves) but point it at the scratch
// tree with --root.
function runCodemod(filename, source) {
    const target = path.join(scratchDir, filename);
    fs.writeFileSync(target, source);
    let out = "";
    try {
        out = execFileSync(process.execPath, [CODEMOD, "--root", tmpRoot, "--write", "--only", filename, "--verbose"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { out = (e.stdout || "") + (e.stderr || ""); }
    const result = fs.readFileSync(target, "utf8");
    fs.unlinkSync(target);
    return { out, result };
}

function run(source) {
    const f = path.join(scratchDir, "_run.js");
    fs.writeFileSync(f, source);
    try {
        const out = execFileSync(process.execPath, [f], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        fs.unlinkSync(f);
        return { ok: true, out: out.trim() };
    } catch (e) {
        try { fs.unlinkSync(f); } catch (_) {}
        return { ok: false, out: ((e.stdout || "") + (e.stderr || "")).trim() };
    }
}

console.log("\n=== MUST NOT CONVERT (an arrow would change behaviour) ===\n");

// 1. `this` from the call site - the Panorama handler pattern.
{
    const src = [
        '"use strict";',
        "const panel = { id: 'MG_Root', onActivate: null };",
        "panel.onActivate = function () { return this.id; };",
        "console.log(panel.onActivate());",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("a_this.js", src);
    const after = run(result);
    ok(/function \(\) \{ return this\.id; \}/.test(result), "a function using `this` keeps `function`");
    ok(before.ok && after.ok && before.out === after.out, `\`this\` fixture output unchanged (${before.out})`);
}

// 2. `arguments` - an arrow has none, so it would throw or capture an outer one.
{
    const src = [
        '"use strict";',
        "const sum = function () { let t = 0; for (let i = 0; i < arguments.length; i++) t += arguments[i]; return t; };",
        "console.log(sum(1, 2, 3));",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("a_args.js", src);
    const after = run(result);
    ok(/function \(\) \{ let t = 0;/.test(result), "a function using `arguments` keeps `function`");
    ok(before.ok && after.ok && before.out === after.out, `\`arguments\` fixture output unchanged (${before.out})`);
}

// 3. An object-literal method value: called as obj.m(), so it needs its own `this`.
//    Kept even when the body does not currently read `this` - the position is the risk.
{
    const src = [
        '"use strict";',
        "const api = {",
        "    base: 10,",
        "    scale: function (n) { return n * this.base; }",
        "};",
        "console.log(api.scale(4));",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("a_method.js", src);
    const after = run(result);
    ok(/scale: function \(n\)/.test(result), "an object-literal method value keeps `function`");
    ok(before.ok && after.ok && before.out === after.out, `method fixture output unchanged (${before.out})`);
}

// 4. `new` on a function expression: an arrow has no [[Construct]].
{
    const src = [
        '"use strict";',
        "const Thing = function (v) { this.v = v; };",
        "const t = new Thing(7);",
        "console.log(t.v);",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("a_new.js", src);
    const after = run(result);
    ok(/function \(v\) \{ this\.v = v; \}/.test(result), "a constructor-style function keeps `function`");
    ok(before.ok && after.ok && before.out === after.out, `\`new\` fixture output unchanged (${before.out})`);
}

// 5. A NAMED function expression recursing through its own name.
{
    const src = [
        '"use strict";',
        "const fact = function f(n) { return n < 2 ? 1 : n * f(n - 1); };",
        "console.log(fact(5));",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("a_named.js", src);
    const after = run(result);
    ok(/function f\(n\)/.test(result), "a named function expression keeps its name");
    ok(before.ok && after.ok && before.out === after.out, `named-FE fixture output unchanged (${before.out})`);
}

// 6. THE MINIFIER RULE. `function (a, b) {` at the start of a line would become `(a, b) => {`,
//    and Valve's naive-ASI minifier inserts a `;` before a line starting with ( [ + - /.
//    That already broke a public build once (ARCHITECTURE 10.1), so such a candidate is
//    skipped even though the conversion is otherwise semantically safe.
{
    const src = [
        '"use strict";',
        "function apply2(f, a, b) { return f(a, b); }",
        "const out = apply2(",
        "    function (x, y) { return x + y; },",
        "    3, 4);",
        "console.log(out);",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("a_asi.js", src);
    const after = run(result);
    ok(/^    function \(x, y\)/m.test(result), "a function starting its own line is NOT converted (ASI hazard)");
    const lines = result.split("\n").filter((l) => l.trim().length);
    ok(!lines.some((l) => "([+-/".includes(l.trimStart()[0])), "no line in the result starts with an ASI trigger char");
    ok(before.ok && after.ok && before.out === after.out, `ASI fixture output unchanged (${before.out})`);
}

console.log("\n=== MUST CONVERT (otherwise the codemod is a no-op) ===\n");

// 7. Plain inline callbacks, mid-line - the common case in this codebase.
{
    const src = [
        '"use strict";',
        "const xs = [3, 1, 2];",
        "const doubled = xs.map(function (n) { return n * 2; });",
        "const sorted = xs.slice().sort(function (a, b) { return a - b; });",
        "console.log(doubled.join(',') + '|' + sorted.join(','));",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("a_cb.js", src);
    const after = run(result);
    ok(/\.map\(\(n\) => \{ return n \* 2; \}\)/.test(result), "a plain map callback becomes an arrow");
    ok(/\.sort\(\(a, b\) => \{ return a - b; \}\)/.test(result), "a two-param sort callback becomes an arrow");
    ok(before.ok && after.ok && before.out === after.out, `callback fixture output unchanged (${before.out})`);
}

// 8. A zero-param callback keeps its empty parens (never `_ =>`).
{
    const src = [
        '"use strict";',
        "function later(f) { return f(); }",
        "console.log(later(function () { return 'ran'; }));",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("a_zero.js", src);
    const after = run(result);
    ok(/later\(\(\) => \{ return 'ran'; \}\)/.test(result), "a zero-param callback becomes `() =>`");
    ok(before.ok && after.ok && before.out === after.out, `zero-param fixture output unchanged (${before.out})`);
}

// 9. A nested `this` DEEPER inside a non-arrow function must not veto the outer conversion,
//    and must keep meaning what it meant.
{
    const src = [
        '"use strict";',
        "const obj = { v: 5, get: null };",
        "const wrap = function (o) { return { read: function () { return this.v; } }; };",
        "obj.get = wrap(obj).read;",
        "console.log(wrap({ v: 9 }).read.call({ v: 42 }));",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("a_nested.js", src);
    const after = run(result);
    ok(/read: function \(\) \{ return this\.v; \}/.test(result), "the inner `this` method still keeps `function`");
    ok(before.ok && after.ok && before.out === after.out, `nested-this fixture output unchanged (${before.out})`);
}

console.log("\n=== STRUCTURAL GUARANTEES ===\n");

// 10. No reflow, no body edits, comments intact, concise bodies never introduced.
{
    const src = [
        '"use strict";',
        "// a comment mentioning function (x) { }",
        "const s = 'function (y) { }';",
        "const f = [1].map(function (n) {   // trailing note",
        "    return n + 1;",
        "});",
        "console.log(f[0] + s.length);",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("a_struct.js", src);
    const after = run(result);
    ok(/\/\/ a comment mentioning function \(x\) \{ \}/.test(result), "comments are untouched");
    ok(/const s = 'function \(y\) \{ \}';/.test(result), "`function` inside a string literal is untouched");
    ok(/\/\/ trailing note/.test(result), "a trailing comment after the header survives");
    ok(src.split("\n").length === result.split("\n").length, "line count is identical (no reflow)");
    ok(/=> \{/.test(result) && !/=> return/.test(result), "braces are kept - no concise body is introduced");
    ok(before.ok && after.ok && before.out === after.out, `structural fixture output unchanged (${before.out})`);
}

// 11. An unparseable file is reported and left byte-identical.
{
    const src = '"use strict";\nconst f = function ( {\n';
    const { out, result } = runCodemod("a_broken.js", src);
    ok(/parse failed/.test(out), "an unparseable file is reported, not silently skipped");
    ok(result === src, "an unparseable file is left byte-identical");
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "ALL ES6 ARROW SAFETY CHECKS PASSED" : "ES6 ARROW SAFETY CHECKS FAILED"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
