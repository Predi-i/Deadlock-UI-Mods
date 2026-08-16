"use strict";

/*
 * mg_es6_codemod_test.js - DEV-ONLY. Proves tools/es6_codemod.js is SAFE before it is
 * allowed near the shipped scripts.
 *
 * The codemod's whole value is that it refuses the unsafe cases. So this harness is
 * mostly a list of `var` patterns that MUST survive untouched, each of which would
 * change behaviour (or hard-crash) if naively rewritten to let/const:
 *
 *   redeclaration      -> `let` twice in one scope is a SyntaxError
 *   TDZ                -> `var` reads undefined; `let` throws ReferenceError
 *   block escape       -> the name is used after the block that would now scope it
 *   loop capture       -> `let` gives a fresh binding per iteration (different output)
 *   switch fallthrough -> a case can be entered without the declaration running
 *
 * And a smaller list that MUST convert, so the codemod isn't trivially "safe by
 * doing nothing". Each fixture is also EXECUTED before and after where it is
 * runnable, and the observable result must match.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CODEMOD = path.join(ROOT, "tools", "es6_codemod.js");

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; console.log("  ok   " + msg); }
    else { fail++; console.log("  FAIL " + msg); }
}

// Run the codemod over a scratch dir laid out like the real tree, so --only can target it.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mg-es6-"));
const scratchDir = path.join(tmpRoot, "tools");
fs.mkdirSync(scratchDir, { recursive: true });

function runCodemod(filename, source) {
    // Run the codemod from the REPO (so its `require("espree")` resolves against
    // node_modules) but point it at the scratch tree via --root.
    const target = path.join(scratchDir, filename);
    fs.writeFileSync(target, source);
    let out = "";
    try {
        out = execFileSync(
            process.execPath,
            [CODEMOD, "--root", tmpRoot, "--write", "--only", filename, "--verbose"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        );
    } catch (e) {
        out = (e.stdout || "") + (e.stderr || "");
    }
    const result = fs.readFileSync(target, "utf8");
    fs.unlinkSync(target);
    return { out, result };
}

function evalToJson(source) {
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

console.log("\n=== MUST NOT CONVERT (converting changes behaviour or crashes) ===\n");

// 1. Redeclaration in the same function scope. `let x` twice = SyntaxError.
{
    const src = [
        '"use strict";',
        "function f(flag) {",
        "    var x = 1;",
        "    if (flag) { }",
        "    var x = 2;",
        "    return x;",
        "}",
        "console.log(f(true));",
    ].join("\n");
    const { result } = runCodemod("t_redecl.js", src);
    ok(/var x = 1;/.test(result) && /var x = 2;/.test(result), "redeclared var is left alone (let would SyntaxError)");
    ok(evalToJson(result).ok, "redeclaration fixture still runs after the codemod");
}

// 2. TDZ: read textually before the declaration. var -> undefined, let -> throw.
{
    const src = [
        '"use strict";',
        "function f() {",
        "    var seen = typeof later;",
        "    var later = 5;",
        "    return seen + ':' + later;",
        "}",
        "console.log(f());",
    ].join("\n");
    const before = evalToJson(src);
    const { result } = runCodemod("t_tdz.js", src);
    const after = evalToJson(result);
    ok(/var later = 5;/.test(result), "var read before its declaration keeps `var` (TDZ)");
    ok(before.ok && after.ok && before.out === after.out, `TDZ fixture output unchanged (${before.out})`);
}

// 3. TDZ via a function that RUNS before the declaration line.
{
    const src = [
        '"use strict";',
        "function f() {",
        "    function peek() { return cache; }",
        "    var first = peek();",
        "    var cache = {};",
        "    return String(first) + ':' + (typeof cache);",
        "}",
        "console.log(f());",
    ].join("\n");
    const before = evalToJson(src);
    const { result } = runCodemod("t_tdz_fn.js", src);
    const after = evalToJson(result);
    ok(/var cache = \{\};/.test(result), "var read by an already-executed function keeps `var`");
    ok(before.ok && after.ok && before.out === after.out, `early-call TDZ output unchanged (${before.out})`);
}

// 4. Block escape: declared in a block, used after it.
{
    const src = [
        '"use strict";',
        "function f(n) {",
        "    if (n > 0) { var msg = 'pos'; }",
        "    else { var msg = 'neg'; }",
        "    return msg;",
        "}",
        "console.log(f(1) + ',' + f(-1));",
    ].join("\n");
    const before = evalToJson(src);
    const { result } = runCodemod("t_escape.js", src);
    const after = evalToJson(result);
    ok(!/(let|const) msg/.test(result), "var used outside its block keeps `var` (block escape)");
    ok(before.ok && after.ok && before.out === after.out, `block-escape output unchanged (${before.out})`);
}

// 5. Loop capture. THE big one for this codebase: panel handlers created in a loop.
//    `var` shares one binding (all closures see the final value); `let` gives each
//    iteration its own. Different observable output -> must not change silently.
{
    const src = [
        '"use strict";',
        "var handlers = [];",
        "for (var i = 0; i < 3; i++) {",
        "    handlers.push(function () { return i; });",
        "}",
        "console.log(handlers.map(function (h) { return h(); }).join(','));",
    ].join("\n");
    const before = evalToJson(src);
    const { result } = runCodemod("t_loopcap.js", src);
    const after = evalToJson(result);
    ok(/for \(var i = 0/.test(result), "loop var captured by a closure keeps `var`");
    // After the loop the single shared binding holds the exit value 3 - that is exactly the
    // trap `let` would silently "fix" into 0,1,2.
    ok(before.out === "3,3,3", "baseline confirms var-capture semantics (3,3,3)");
    ok(before.ok && after.ok && before.out === after.out, `loop-capture output unchanged (${after.out})`);
}

// 6. Switch fallthrough: declared in one case, read in another.
{
    const src = [
        '"use strict";',
        "function f(k) {",
        "    switch (k) {",
        "        case 1:",
        "            var tag = 'one';",
        "        case 2:",
        "            return 'k=' + k + ' tag=' + tag;",
        "        default:",
        "            return 'none';",
        "    }",
        "}",
        "console.log(f(1) + '|' + f(2));",
    ].join("\n");
    const before = evalToJson(src);
    const { result } = runCodemod("t_switch.js", src);
    const after = evalToJson(result);
    ok(/var tag = 'one';/.test(result), "var spanning switch-cases keeps `var` (TDZ on fallthrough)");
    ok(before.ok && after.ok && before.out === after.out, `switch fixture output unchanged (${before.out})`);
}

console.log("\n=== MUST CONVERT (otherwise the codemod is a no-op) ===\n");

// 7. Plain never-reassigned local -> const.
{
    const src = [
        '"use strict";',
        "function area(w, h) {",
        "    var scale = 2;",
        "    var out = w * h * scale;",
        "    return out;",
        "}",
        "console.log(area(3, 4));",
    ].join("\n");
    const before = evalToJson(src);
    const { result } = runCodemod("t_const.js", src);
    const after = evalToJson(result);
    ok(/const scale = 2;/.test(result), "never-reassigned initialised var -> const");
    ok(/const out = w \* h \* scale;/.test(result), "second never-reassigned var -> const");
    ok(before.out === after.out && after.ok, `const conversion preserves output (${after.out})`);
}

// 8. Reassigned -> let, not const.
{
    const src = [
        '"use strict";',
        "function count(n) {",
        "    var total = 0;",
        "    for (var i = 0; i < n; i++) { total += i; }",
        "    return total;",
        "}",
        "console.log(count(4));",
    ].join("\n");
    const before = evalToJson(src);
    const { result } = runCodemod("t_let.js", src);
    const after = evalToJson(result);
    ok(/let total = 0;/.test(result), "reassigned var -> let");
    ok(/(let|var) i = 0/.test(result), "loop counter with no closure is converted or safely kept");
    ok(!/const total/.test(result), "reassigned var never becomes const");
    ok(before.out === after.out && after.ok, `let conversion preserves output (${after.out})`);
}

// 9. Uninitialised declaration -> let (const would be a SyntaxError).
{
    const src = [
        '"use strict";',
        "function pick(flag) {",
        "    var chosen;",
        "    if (flag) { chosen = 'a'; } else { chosen = 'b'; }",
        "    return chosen;",
        "}",
        "console.log(pick(true) + pick(false));",
    ].join("\n");
    const before = evalToJson(src);
    const { result } = runCodemod("t_uninit.js", src);
    const after = evalToJson(result);
    ok(/let chosen;/.test(result), "uninitialised var -> let");
    ok(!/const chosen;/.test(result), "uninitialised var never becomes const (would not parse)");
    ok(before.out === after.out && after.ok, `uninitialised conversion preserves output (${after.out})`);
}

console.log("\n=== STRUCTURAL GUARANTEES ===\n");

// 10. The token gate: only the keyword may differ, and nothing may reflow.
{
    const src = [
        '"use strict";',
        "// a comment with the word var in it",
        "function f() {",
        "    var a = 1;   // trailing comment",
        "    var s = 'var b = 2';",
        "    return a + s.length;",
        "}",
        "console.log(f());",
    ].join("\n");
    const { result } = runCodemod("t_tokens.js", src);
    ok(/\/\/ a comment with the word var in it/.test(result), "comments are untouched (no AST reprint)");
    ok(/var b = 2/.test(result), "the word `var` inside a string literal is untouched");
    ok(/\/\/ trailing comment/.test(result), "trailing comments survive");
    const srcLines = src.split("\n").length, outLines = result.split("\n").length;
    ok(srcLines === outLines, `line count is identical (${srcLines}) - no reflow, so no minifier ASI risk`);
    ok(/    const a = 1;   \/\/ trailing comment/.test(result), "inline spacing is byte-preserved around the edit");
}

// 11. A parse failure must be reported, never written past.
{
    const src = '"use strict";\nfunction broken( {\n';
    const { out, result } = runCodemod("t_broken.js", src);
    ok(/parse failed/.test(out), "an unparseable file is reported, not silently skipped");
    ok(result === src, "an unparseable file is left byte-identical");
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "ALL ES6 CODEMOD SAFETY CHECKS PASSED" : "ES6 CODEMOD SAFETY CHECKS FAILED"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
