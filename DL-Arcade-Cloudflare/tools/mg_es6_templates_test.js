"use strict";

/*
 * mg_es6_templates_test.js - DEV-ONLY. Proves tools/es6_templates.js is SAFE.
 *
 * `+` is overloaded, so this codemod is the most dangerous of the three: converting a chain
 * whose first `+` is ARITHMETIC silently changes a computed string. The fixtures below are
 * the cases that must NOT convert, plus the plain ones that must.
 *
 * The parenthesized-operand fixture is not hypothetical. The first version of the codemod
 * flattened `"translate3d(" + (dc * SQ + INSET) + "px"` through the parens and emitted
 * `${dc * SQ}${INSET}px`, turning "0px" into "00px" - a broken CSS transform on every piece.
 * Espree does not model parentheses as AST nodes, so the tree is identical to the unbracketed
 * form; only the source bytes distinguish them. The runtime probe is what caught it.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CODEMOD = path.join(ROOT, "tools", "es6_templates.js");

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) { pass++; console.log("  ok   " + msg); }
    else { fail++; console.log("  FAIL " + msg); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mg-tmpl-"));
const scratchDir = path.join(tmpRoot, "tools");
fs.mkdirSync(scratchDir, { recursive: true });

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

console.log("\n=== ARITHMETIC MUST NEVER BECOME CONCATENATION ===\n");

// 1. THE REGRESSION: a parenthesized arithmetic operand inside a string chain.
{
    const src = [
        '"use strict";',
        "const dc = 0, SQ = 64, INSET = 0;",
        'const t = "translate3d(" + (dc * SQ + INSET) + "px, 0px)";',
        "console.log(t);",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("t_paren.js", src);
    const after = run(result);
    ok(before.out === "translate3d(0px, 0px)", "baseline: the paren sum is arithmetic (0px, not 00px)");
    ok(before.ok && after.ok && before.out === after.out, `parenthesized arithmetic is preserved (${after.out})`);
    ok(!/\$\{dc \* SQ\}\$\{INSET\}/.test(result), "the paren operand was NOT split into two interpolations");
}

// 2. `"Player " + (seat + 1)` - the same shape, seen in mg_poker/mg_durak.
{
    const src = [
        '"use strict";',
        "const seat = 0;",
        'const label = "Player " + (seat + 1);',
        "console.log(label);",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("t_seat.js", src);
    const after = run(result);
    ok(before.out === "Player 1", "baseline: (seat + 1) increments (Player 1)");
    ok(before.ok && after.ok && before.out === after.out, `seat arithmetic is preserved (${after.out})`);
}

// 3. A chain whose LEFTMOST operand is a number: the first `+` is arithmetic.
{
    const src = [
        '"use strict";',
        "const a = 1, b = 2;",
        'const s = a + b + "px";',
        "console.log(s);",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("t_leftnum.js", src);
    const after = run(result);
    ok(before.out === "3px", "baseline: a + b + \"px\" sums first (3px)");
    ok(/const s = a \+ b \+ "px";/.test(result), "a chain starting with a non-string keeps `+`");
    ok(before.ok && after.ok && before.out === after.out, `leading-arithmetic chain preserved (${after.out})`);
}

console.log("\n=== MUST CONVERT ===\n");

// 4. Leftmost string literal: every `+` after it is concatenation.
{
    const src = [
        '"use strict";',
        "const n = 5, who = 'you';",
        'const msg = "hello " + who + ", n=" + n;',
        "console.log(msg);",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("t_ok.js", src);
    const after = run(result);
    ok(/`hello \$\{who\}, n=\$\{n\}`/.test(result), "a leftmost-string chain becomes a template literal");
    ok(before.ok && after.ok && before.out === after.out, `converted chain preserves output (${after.out})`);
}

// 5. Even with arithmetic LATER in the chain, a leading string keeps left-to-right meaning.
{
    const src = [
        '"use strict";',
        "const a = 1, b = 2;",
        'const s = "v=" + a + b;',
        "console.log(s);",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("t_trailing.js", src);
    const after = run(result);
    ok(before.out === "v=12", "baseline: after a leading string, + is concatenation (v=12)");
    ok(before.ok && after.ok && before.out === after.out, `trailing operands keep their order (${after.out})`);
}

console.log("\n=== ESCAPING AND STRUCTURE ===\n");

// 6. A backtick or ${ in the original text is inert in a quoted string but ACTIVE in a
//    template, so both must be escaped.
{
    const src = [
        '"use strict";',
        "const v = 9;",
        // The literal `${...}` text IS the fixture: it must stay inert after conversion.
        // eslint-disable-next-line no-template-curly-in-string
        'const s = "tick ` and ${notReal} " + v;',
        "console.log(s);",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("t_escape.js", src);
    const after = run(result);
    ok(before.ok && after.ok && before.out === after.out, `backtick/dollar text survives verbatim (${after.out})`);
    ok(!/[^\\]`[^;]*`/.test(result.split("\n")[2].replace(/^const s = /, "")) || after.out === before.out,
        "an embedded backtick did not terminate the template");
}

// 7. Existing escapes stay byte-identical (raw text is reused, not re-encoded).
{
    const src = [
        '"use strict";',
        "const v = 1;",
        'const s = "a\\tb\\n" + v;',
        "console.log(JSON.stringify(s));",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("t_raw.js", src);
    const after = run(result);
    ok(/a\\tb\\n/.test(result), "existing \\t and \\n escapes are preserved as written");
    ok(before.ok && after.ok && before.out === after.out, `escape sequences evaluate identically (${after.out})`);
}

// 8. No reflow, and a multi-line chain is skipped outright.
{
    const src = [
        '"use strict";',
        "const a = 1, b = 2;",
        'const s = "x" + a +',
        '    "y" + b;',
        "console.log(s);",
    ].join("\n");
    const before = run(src);
    const { result } = runCodemod("t_multi.js", src);
    const after = run(result);
    ok(src.split("\n").length === result.split("\n").length, "line count unchanged");
    ok(/"x" \+ a \+/.test(result), "a multi-line concatenation is left alone (would reflow)");
    ok(before.ok && after.ok && before.out === after.out, `multi-line fixture output unchanged (${after.out})`);
}

// 9. Comments and string contents mentioning `+` are untouched.
{
    const src = [
        '"use strict";',
        '// concat like "a" + b happens here',
        "const lit = 'x\" + y';",
        "const n = 3;",
        'const s = "n=" + n;',
        "console.log(s + lit.length);",
    ].join("\n");
    const { result } = runCodemod("t_comment.js", src);
    ok(/\/\/ concat like "a" \+ b happens here/.test(result), "comments are untouched");
    ok(/const lit = 'x" \+ y';/.test(result), "a `+` inside a string literal is untouched");
}

// 10. An unparseable file is reported and left byte-identical.
{
    const src = '"use strict";\nconst s = "a" + ;\n';
    const { out, result } = runCodemod("t_broken.js", src);
    ok(/parse failed/.test(out), "an unparseable file is reported");
    ok(result === src, "an unparseable file is left byte-identical");
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "ALL ES6 TEMPLATE SAFETY CHECKS PASSED" : "ES6 TEMPLATE SAFETY CHECKS FAILED"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
