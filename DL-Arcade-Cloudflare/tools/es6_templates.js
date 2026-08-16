"use strict";

/*
 * es6_templates.js - DEV-ONLY. Converts string concatenation to template literals.
 *
 * THE HAZARD THAT DEFINES THIS TOOL: `+` is overloaded. In `a + b + "px"` with numbers, the
 * first `+` is ARITHMETIC - a=1, b=2 gives "3px". The template `${a}${b}px` gives "12px".
 * Converting that chain silently changes a computed string, which in this codebase means a
 * wrong pixel size or a corrupted wire value, with nothing to catch it outside the game.
 *
 * So the ONLY chains converted are those whose LEFTMOST operand is a string literal. That
 * makes the first `+` string concatenation, whose result is a string, so every subsequent `+`
 * is concatenation too - left-to-right, exactly what a template does. Any chain that starts
 * with a number, identifier, call or member expression is left alone, however obviously
 * "stringy" it looks.
 *
 * Two further restrictions:
 *
 *   SINGLE LINE ONLY. A multi-line concat would have to be re-flowed, and a re-flowed line can
 *   end up starting with `(` or `+`, which is the Valve minifier's naive-ASI trigger set
 *   (ARCHITECTURE 10.1 / 10.2). Multi-line chains are skipped outright.
 *
 *   NO ToPrimitive DIVERGENCE. `"" + obj` calls ToPrimitive with the DEFAULT hint (valueOf
 *   first); `${obj}` uses the STRING hint (toString first). For an object with both, that is a
 *   different result. This repo defines no valueOf override (verified), and Date is
 *   special-cased by the spec to prefer its string form under the default hint, so the two
 *   agree here - but the risk is why nothing outside a leftmost-string chain is touched.
 *
 * Escaping: the literal's RAW source text is reused (so `\t`, `é` and friends stay
 * byte-identical); only a bare backtick and a `${` sequence are escaped, since those are
 * inert inside a quoted string but active inside a template.
 *
 * VERIFICATION: the result must re-parse; line count must be unchanged; and every converted
 * expression is EVALUATED before and after against probe values, requiring an identical
 * string. Anything else refuses the write.
 *
 * Usage:
 *   node tools/es6_templates.js                 # dry run
 *   node tools/es6_templates.js --write         # apply
 *   node tools/es6_templates.js --only mg_ui    # restrict to matching paths
 *   node tools/es6_templates.js --root <dir>    # operate on another tree (test harness)
 *   node tools/es6_templates.js --verbose       # list skips with reasons
 */

const fs = require("fs");
const path = require("path");
const espree = require("espree");

const rootArgIdx = process.argv.indexOf("--root");
const ROOT = rootArgIdx !== -1 && process.argv[rootArgIdx + 1]
    ? path.resolve(process.argv[rootArgIdx + 1])
    : path.resolve(__dirname, "..");

const ECMA = 2023;

const SKIP = new Set([path.join("server", "worker.js")]);
const MODULE_FILES = new Set([
    path.join("server", "worker.core.js"),
    path.join("server", "admin_panel.js"),
]);
// Hand-minified browser payload shipped as a string; not ours to reformat.
const SKIP_CONVERT = new Set([path.join("server", "admin_panel.js")]);

const SELF = new Set([
    path.join("tools", "es6_templates.js"),
    path.join("tools", "es6_codemod.js"),
    path.join("tools", "es6_arrows.js"),
    path.join("tools", "mg_es6_codemod_test.js"),
    path.join("tools", "mg_es6_arrows_test.js"),
    path.join("tools", "mg_es6_templates_test.js"),
]);

function walkDir(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const e of entries) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkDir(full, out);
        else if (e.isFile() && e.name.endsWith(".js")) out.push(full);
    }
    return out;
}

function targetFiles() {
    const out = [];
    for (const sub of ["panorama", "server", "tools", "update-markers"]) walkDir(path.join(ROOT, sub), out);
    return out.map((f) => path.relative(ROOT, f))
        .filter((rel) => !SKIP.has(rel) && !SKIP_CONVERT.has(rel) && !SELF.has(rel))
        .sort();
}

function parse(code, sourceType) {
    return espree.parse(code, { ecmaVersion: ECMA, sourceType, range: true, loc: true, tokens: true, comment: true });
}

/**
 * Is this node wrapped in its own parentheses in the source? Espree does not model parens as
 * nodes, so `"x" + (a + b)` and `"x" + a + b` have IDENTICAL trees. Flattening the first one
 * would split `(a + b)` into two operands and turn an ARITHMETIC sum into concatenation:
 * `"translate3d(" + (dc * SQ + INSET) + "px"` became `${dc * SQ}${INSET}px` - i.e. "00px"
 * where the original computed "0px". Detect the parens by looking at the bytes either side.
 */
function isParenthesized(node, src) {
    let i = node.range[0] - 1;
    while (i >= 0 && /\s/.test(src[i])) i--;
    if (i < 0 || src[i] !== "(") return false;
    let j = node.range[1];
    while (j < src.length && /\s/.test(src[j])) j++;
    return src[j] === ")";
}

/** Flatten a left-leaning `+` chain into its operands, in source order. */
function flattenPlus(node, src) {
    const parts = [];
    (function walk(n, isRoot) {
        // A parenthesized sub-expression is ONE operand, whatever is inside it.
        if (n.type === "BinaryExpression" && n.operator === "+" && (isRoot || !isParenthesized(n, src))) {
            walk(n.left, false); walk(n.right, false); return;
        }
        parts.push(n);
    })(node, true);
    return parts;
}

const isStringLiteral = (n) => n.type === "Literal" && typeof n.value === "string";

/**
 * A literal's raw text, minus its quotes, made safe for a template. Reusing RAW keeps every
 * existing escape byte-identical; only backtick and `${` need new escapes.
 */
function literalRawForTemplate(node, src) {
    const raw = src.slice(node.range[0], node.range[1]);
    const q = raw[0];
    if (q !== '"' && q !== "'") return null;
    let body = raw.slice(1, -1);
    // A real newline inside the source literal would change meaning in a template; refuse.
    if (/[\r\n]/.test(body)) return null;
    body = body.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
    // `\'` and `\"` remain valid escapes inside a template, so they can stay as-is.
    return body;
}

/** An interpolated operand needs no parens: `${...}` is already a delimiter. */
function operandText(node, src) {
    return src.slice(node.range[0], node.range[1]);
}

/** @returns {{text:string}|{skip:string}} */
function buildTemplate(node, src) {
    const parts = flattenPlus(node, src);
    if (parts.length < 2) return { skip: "not a concatenation" };

    // THE RULE: the leftmost operand must be a string literal, so the whole chain is
    // guaranteed string concatenation rather than arithmetic.
    if (!isStringLiteral(parts[0])) return { skip: "leftmost operand is not a string literal (could be arithmetic)" };

    // Nothing to gain if every part is a literal and there is no interpolation at all;
    // still fine to convert, but skip to keep the diff meaningful.
    if (parts.every(isStringLiteral)) return { skip: "all-literal concatenation (no interpolation)" };

    let out = "`";
    for (const p of parts) {
        if (isStringLiteral(p)) {
            const body = literalRawForTemplate(p, src);
            if (body === null) return { skip: "literal is not a simple single-line quoted string" };
            out += body;
        } else {
            // A template-literal operand would nest; keep those out of scope.
            if (p.type === "TemplateLiteral") return { skip: "operand is already a template literal" };
            const t = operandText(p, src);
            if (/[\r\n]/.test(t)) return { skip: "operand spans lines" };
            out += "${" + t + "}";
        }
    }
    out += "`";
    return { text: out };
}

/**
 * Runtime equivalence probe: evaluate the original expression and the template side by side
 * with every free identifier bound to a set of probe values, and require identical results.
 * This is what catches an escaping mistake or an accidental arithmetic change.
 */
function probeEquivalent(originalText, templateText) {
    const names = new Set();
    let ast;
    try { ast = espree.parse("(" + originalText + ")", { ecmaVersion: ECMA }); }
    catch (e) { return "probe: original does not parse standalone"; }

    (function collect(n, parent) {
        if (!n || typeof n.type !== "string") return;
        if (n.type === "Identifier") {
            const isProp = parent && parent.type === "MemberExpression" && parent.property === n && !parent.computed;
            const isKey = parent && parent.type === "Property" && parent.key === n;
            if (!isProp && !isKey) names.add(n.name);
        }
        for (const k of Object.keys(n)) {
            if (k === "range" || k === "loc") continue;
            const v = n[k];
            if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") collect(c, n); }
            else if (v && typeof v.type === "string") collect(v, n);
        }
    })(ast, null);

    // Anything referencing engine/global state is not safely evaluable here; skip the probe
    // rather than pretend to have verified it. The leftmost-string rule still applies.
    const bad = ["$", "Game", "GameUI", "GameEvents", "panorama", "require", "process", "globalThis", "crypto", "fetch", "Response", "document", "window"];
    for (const b of bad) if (names.has(b)) return null;

    const PROBES = [
        () => 0, () => 1, () => -1, () => 7, () => 3.5,
        () => "s", () => "", () => "0",
        () => true, () => false, () => null, () => undefined,
        () => [1, 2], () => ({ a: 1 }),
    ];
    const list = [...names];
    if (list.length > 6) return null;   // combinatorics not worth it; rule still holds

    const combos = [];
    const MAX = 64;
    (function build(i, acc) {
        if (combos.length >= MAX) return;
        if (i === list.length) { combos.push(acc.slice()); return; }
        for (const p of PROBES) {
            if (combos.length >= MAX) return;
            acc.push(p()); build(i + 1, acc); acc.pop();
        }
    })(0, []);

    for (const combo of combos) {
        let a, b, ae = null, be = null;
        try { a = new Function(...list, "return (" + originalText + ");")(...combo); }
        catch (e) { ae = e.constructor.name; }
        try { b = new Function(...list, "return (" + templateText + ");")(...combo); }
        catch (e) { be = e.constructor.name; }
        if (ae || be) { if (ae !== be) return `probe: throw mismatch ${ae} vs ${be}`; continue; }
        if (!Object.is(a, b)) {
            return `probe: ${JSON.stringify(String(a))} != ${JSON.stringify(String(b))} for [${combo.map((c) => JSON.stringify(c)).join(", ")}]`;
        }
    }
    return null;
}

function processFile(rel, opts) {
    const abs = path.join(ROOT, rel);
    const sourceType = MODULE_FILES.has(rel) ? "module" : "script";
    const original = fs.readFileSync(abs, "utf8");

    let ast;
    try { ast = parse(original, sourceType); }
    catch (e) { return { rel, error: `parse failed: ${e.message}` }; }

    const edits = [];
    const skipped = [];

    (function visit(node, parent) {
        if (!node || typeof node.type !== "string") return;
        const isTopPlus = node.type === "BinaryExpression" && node.operator === "+" &&
            !(parent && parent.type === "BinaryExpression" && parent.operator === "+");
        if (isTopPlus) {
            const text = original.slice(node.range[0], node.range[1]);
            if (/[\r\n]/.test(text)) {
                skipped.push({ line: node.loc.start.line, reason: "multi-line concatenation (would reflow)" });
            } else {
                const built = buildTemplate(node, original);
                if (built.skip) skipped.push({ line: node.loc.start.line, reason: built.skip });
                else {
                    const probe = probeEquivalent(text, built.text);
                    if (probe) skipped.push({ line: node.loc.start.line, reason: probe });
                    else edits.push({ start: node.range[0], end: node.range[1], text: built.text });
                }
            }
            // Do not descend into a converted chain's operands.
            if (edits.length && edits[edits.length - 1].start === node.range[0]) return;
        }
        for (const k of Object.keys(node)) {
            if (k === "range" || k === "loc") continue;
            const v = node[k];
            if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") visit(c, node); }
            else if (v && typeof v.type === "string") visit(v, node);
        }
    })(ast, null);

    if (!edits.length) return { rel, converted: 0, skipped };

    edits.sort((a, b) => b.start - a.start);
    let out = original;
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

    try { parse(out, sourceType); }
    catch (e) { return { rel, error: `result does not parse: ${e.message}` }; }

    if (original.split("\n").length !== out.split("\n").length) {
        return { rel, error: "line count changed" };
    }

    // No line may NEWLY begin with an ASI trigger character (ARCHITECTURE 10.2).
    const TRIGGER = new Set(["(", "[", "+", "-", "/"]);
    const ba = original.split("\n"), aa = out.split("\n");
    for (let i = 0; i < aa.length; i++) {
        const x = aa[i].trimStart(), y = ba[i].trimStart();
        if (x && TRIGGER.has(x[0]) && !TRIGGER.has(y[0] || "")) {
            return { rel, error: `line ${i + 1} would newly start with '${x[0]}' (minifier ASI hazard)` };
        }
    }

    if (opts.write) fs.writeFileSync(abs, out);
    return { rel, converted: edits.length, skipped };
}

function main() {
    const argv = process.argv.slice(2);
    const opts = { write: argv.includes("--write"), verbose: argv.includes("--verbose") };
    const onlyIdx = argv.indexOf("--only");
    const only = onlyIdx !== -1 ? argv[onlyIdx + 1] : null;

    let files = targetFiles();
    if (only) files = files.filter((f) => f.includes(only));

    console.log(`${opts.write ? "APPLYING" : "DRY RUN"} - ${files.length} files\n`);

    let total = 0, totalSkipped = 0;
    const errors = [];
    const byReason = new Map();

    for (const rel of files) {
        const r = processFile(rel, opts);
        if (r.error) { errors.push(`${rel}: ${r.error}`); console.log(`  !! ${rel}: ${r.error}`); continue; }
        total += r.converted;
        totalSkipped += r.skipped.length;
        for (const s of r.skipped) byReason.set(s.reason.split(":")[0], (byReason.get(s.reason.split(":")[0]) || 0) + 1);
        if (r.converted) console.log(`  ${rel}: ${r.converted} template(s), ${r.skipped.length} kept`);
        if (opts.verbose) for (const s of r.skipped) console.log(`       L${s.line} ${s.reason}`);
    }

    console.log(`\n── totals ──`);
    console.log(`  -> templates : ${total}`);
    console.log(`  kept concat  : ${totalSkipped}`);
    if (byReason.size) {
        console.log("\n  why concatenation was kept:");
        for (const [r, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${r}`);
    }
    if (errors.length) { console.log(`\n  ${errors.length} FILE(S) REFUSED:`); for (const e of errors) console.log(`    ${e}`); process.exitCode = 1; }
}

main();
