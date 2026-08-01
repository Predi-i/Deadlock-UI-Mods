"use strict";

/*
 * es6_arrows.js - DEV-ONLY. Converts anonymous `function (a, b) { ... }` EXPRESSIONS to
 * arrow functions, where that is provably behaviour-preserving.
 *
 * An arrow is NOT a shorter `function`. It differs in five observable ways, and this
 * codebase hits four of them, so every one is a hard disqualifier:
 *
 *   `this`        an arrow inherits `this` lexically. Panorama calls handlers with the
 *                 panel as `this` in places, so ANY use of `this` in the function's own
 *                 scope keeps `function`.
 *   `arguments`   an arrow has no `arguments` object; it would silently resolve to an
 *                 outer one or throw.
 *   construction  an arrow has no [[Construct]]: `new f()` throws.
 *   `.call/.apply/.bind` still work, but a bound `this` is IGNORED by an arrow, which is
 *                 a silent behaviour change rather than an error.
 *   named FE      `function fact(n){ return n<2?1:fact(n-1); }` binds its own name for
 *                 recursion; an arrow does not.
 *
 * Also skipped: generators/async (no arrow form here), object-literal method VALUES and
 * anything in a `prototype`/method position (they are conventionally `function` and are
 * routinely called with a receiver), and getters/setters.
 *
 * WHAT IT EMITS: `function (a, b) {` -> `(a, b) => {`. The body is NEVER touched, braces
 * are NEVER dropped, and a single-expression body is NEVER collapsed to a concise body -
 * that would reflow lines and put us near the Valve minifier's ASI pass. Only the header
 * bytes from `function` through the `)` before the body are rewritten, so line count and
 * every body byte are preserved exactly.
 *
 * VERIFICATION: the result must re-parse, and an AST SHAPE COMPARISON walks the before and
 * after trees in lockstep - every node type must match except at the converted functions,
 * where FunctionExpression must have become ArrowFunctionExpression with an identical
 * params/body subtree. Anything else refuses the write.
 *
 * Usage:
 *   node tools/es6_arrows.js                 # dry run
 *   node tools/es6_arrows.js --write         # apply
 *   node tools/es6_arrows.js --only mg_ttt   # restrict to matching paths
 *   node tools/es6_arrows.js --root <dir>    # operate on another tree (test harness)
 *   node tools/es6_arrows.js --verbose       # list every skipped function + reason
 */

const fs = require("fs");
const path = require("path");
const espree = require("espree");

const rootArgIdx = process.argv.indexOf("--root");
const ROOT = rootArgIdx !== -1 && process.argv[rootArgIdx + 1]
    ? path.resolve(process.argv[rootArgIdx + 1])
    : path.resolve(__dirname, "..");

// Parser capability only; this codemod's OUTPUT is ES6 arrow syntax. 2023 is needed to
// parse the two dev tools that begin with a `#!` hashbang line.
const ECMA = 2023;

const SKIP = new Set([path.join("server", "worker.js")]);
const MODULE_FILES = new Set([
    path.join("server", "worker.core.js"),
    path.join("server", "admin_panel.js"),
    path.join("server", "node_server.js"),
    path.join("server", "node_storage.js"),
]);

// admin_panel.js is hand-minified browser code shipped as a string; leave it alone.
const SKIP_CONVERT = new Set([path.join("server", "admin_panel.js")]);

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
    return out
        .map((f) => path.relative(ROOT, f))
        .filter((rel) => !SKIP.has(rel) && !SKIP_CONVERT.has(rel))
        .filter((rel) => rel !== path.join("tools", "es6_arrows.js"))
        .filter((rel) => rel !== path.join("tools", "es6_codemod.js"))
        .filter((rel) => rel !== path.join("tools", "mg_es6_codemod_test.js"))
        .filter((rel) => rel !== path.join("tools", "mg_es6_arrows_test.js"))
        .sort();
}

function parse(code, sourceType) {
    return espree.parse(code, { ecmaVersion: ECMA, sourceType, range: true, loc: true, tokens: true, comment: true });
}

function indexAst(ast) {
    const parents = new Map(); const all = [];
    (function visit(node, parent) {
        if (!node || typeof node.type !== "string") return;
        parents.set(node, parent); all.push(node);
        for (const key of Object.keys(node)) {
            if (key === "range" || key === "loc") continue;
            const val = node[key];
            if (Array.isArray(val)) { for (const c of val) if (c && typeof c.type === "string") visit(c, node); }
            else if (val && typeof val.type === "string") visit(val, node);
        }
    })(ast, null);
    return { parents, all };
}

/** `this` / `arguments` / new.target used in THIS function's own scope (arrows are transparent). */
function ownScopeBindings(fn) {
    let usesThis = false, usesArguments = false, usesNewTarget = false;
    (function scan(node) {
        if (!node || typeof node.type !== "string") return;
        // A nested non-arrow function rebinds all three, so stop there.
        if (node !== fn && (node.type === "FunctionExpression" || node.type === "FunctionDeclaration")) return;
        if (node.type === "ThisExpression") usesThis = true;
        else if (node.type === "Identifier" && node.name === "arguments") usesArguments = true;
        else if (node.type === "MetaProperty") usesNewTarget = true;
        for (const key of Object.keys(node)) {
            if (key === "range" || key === "loc") continue;
            const val = node[key];
            if (Array.isArray(val)) { for (const c of val) if (c && typeof c.type === "string") scan(c); }
            else if (val && typeof val.type === "string") scan(val);
        }
    })(fn);
    return { usesThis, usesArguments, usesNewTarget };
}

/** @returns {string|null} reason to skip, or null when the conversion is safe. */
function skipReason(fn, parents) {
    if (fn.type !== "FunctionExpression") return "not a function expression";
    if (fn.generator) return "generator";
    if (fn.async) return "async function expression";
    if (fn.id) return "named function expression (its name is bound for recursion)";

    const b = ownScopeBindings(fn);
    if (b.usesThis) return "uses `this` (an arrow would inherit the outer one)";
    if (b.usesArguments) return "uses `arguments` (an arrow has none)";
    if (b.usesNewTarget) return "uses new.target";

    // A default/rest param is fine, but a destructuring param with defaults can need parens
    // we are not going to reason about; the header rewrite keeps the original param text
    // verbatim, so this is actually safe. Kept simple: no restriction here.

    const p = parents.get(fn);
    if (!p) return "no parent";

    // Object-literal method value / class method: conventionally a method, usually receives a
    // receiver. `{ foo: function () {} }` called as obj.foo() would lose `this`.
    if (p.type === "Property" && p.value === fn) return "object-literal method value";
    if (p.type === "MethodDefinition" || p.type === "PropertyDefinition") return "class member";

    // `new (function(){})` and `(function(){}).call(...)`: construction / explicit receiver.
    if (p.type === "NewExpression") return "used with `new`";
    if (p.type === "MemberExpression" && p.object === fn) return "receiver position (.call/.apply/.bind)";

    // Assigned onto a prototype or an object property: same method concern.
    if (p.type === "AssignmentExpression" && p.right === fn && p.left.type === "MemberExpression") {
        return "assigned to an object/prototype property (method position)";
    }

    return null;
}

/**
 * Rewrite ONLY the header: `function` .. `)` before the body becomes `(params) =>`.
 * Body bytes and line count are preserved exactly.
 */
function headerEdit(fn, src, tokens) {
    const bodyStart = fn.body.range[0];
    // The last `)` strictly before the body is the end of the parameter list.
    let close = -1;
    for (const t of tokens) {
        if (t.range[1] > bodyStart) break;
        if (t.type === "Punctuator" && t.value === ")" && t.range[0] >= fn.range[0]) close = t.range[1];
    }
    if (close === -1) return null;

    // Parameter list text, verbatim, including any comments inside it.
    let open = -1;
    for (const t of tokens) {
        if (t.range[0] < fn.range[0]) continue;
        if (t.range[1] > close) break;
        if (t.type === "Punctuator" && t.value === "(") { open = t.range[0]; break; }
    }
    if (open === -1) return null;

    const params = src.slice(open, close);          // "(a, b)" verbatim
    const between = src.slice(close, bodyStart);    // usually " "
    // Keep whatever whitespace sat between `)` and `{`, then insert the arrow.
    const replacement = `${params} =>${between.length ? between : " "}`;
    return { start: fn.range[0], end: bodyStart, text: replacement };
}

/** Structural proof: same tree, except converted nodes flipped FunctionExpression->Arrow. */
function verifyShape(beforeAst, afterAst, expectedConversions) {
    let converted = 0;
    const problems = [];

    (function walk(a, b, pathStr) {
        if (problems.length) return;
        if (!a || !b) { if (a !== b) problems.push(`node presence differs at ${pathStr}`); return; }

        if (a.type !== b.type) {
            if (a.type === "FunctionExpression" && b.type === "ArrowFunctionExpression") converted++;
            else { problems.push(`${pathStr}: ${a.type} -> ${b.type}`); return; }
        }
        // Literal values and identifier names must be identical everywhere.
        if (a.type === "Identifier" && a.name !== b.name) { problems.push(`${pathStr}: identifier ${a.name} -> ${b.name}`); return; }
        if (a.type === "Literal" && String(a.raw) !== String(b.raw)) { problems.push(`${pathStr}: literal ${a.raw} -> ${b.raw}`); return; }

        // Excluded from the STRUCTURAL comparison:
        //   type            compared above; may legitimately flip FunctionExpression -> Arrow
        //   range/loc/..    byte positions shift by design (`function ` -> `` and ` =>` added)
        //   tokens/comments lexical streams hanging off Program, not tree structure. The
        //                   `function` Keyword genuinely becomes a `(` Punctuator, so walking
        //                   them here would reject every intended conversion.
        const SKIP_KEYS = new Set(["range", "loc", "start", "end", "type", "tokens", "comments"]);
        const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => !SKIP_KEYS.has(k)));
        for (const k of keys) {
            const av = a[k], bv = b[k];
            const aNode = av && typeof av.type === "string", bNode = bv && typeof bv.type === "string";
            if (Array.isArray(av) || Array.isArray(bv)) {
                const aa = Array.isArray(av) ? av : [], ba = Array.isArray(bv) ? bv : [];
                if (aa.length !== ba.length) { problems.push(`${pathStr}.${k}: length ${aa.length} -> ${ba.length}`); return; }
                for (let i = 0; i < aa.length; i++) {
                    if (aa[i] && typeof aa[i].type === "string") walk(aa[i], ba[i], `${pathStr}.${k}[${i}]`);
                }
            } else if (aNode || bNode) {
                walk(aNode ? av : null, bNode ? bv : null, `${pathStr}.${k}`);
            } else if (k !== "id" && typeof av !== "object" && typeof bv !== "object" && av !== bv) {
                // scalar flags: generator/async/computed/kind/operator...
                // `expression` legitimately differs on arrows (concise body) - we never emit one.
                if (k !== "expression") { problems.push(`${pathStr}.${k}: ${av} -> ${bv}`); return; }
            }
        }
    })(beforeAst, afterAst, "Program");

    if (problems.length) return problems[0];
    if (converted !== expectedConversions) return `expected ${expectedConversions} conversions, tree shows ${converted}`;
    return null;
}

function processFile(rel, opts) {
    const abs = path.join(ROOT, rel);
    const sourceType = MODULE_FILES.has(rel) ? "module" : "script";
    const original = fs.readFileSync(abs, "utf8");

    let ast;
    try { ast = parse(original, sourceType); }
    catch (e) { return { rel, error: `parse failed: ${e.message}` }; }

    const { parents, all } = indexAst(ast);
    const edits = [];
    const skipped = [];

    // Byte offset of the start of each line, to test "is this function the first thing on
    // its line?" without re-splitting the source per candidate.
    const lineStarts = [0];
    for (let i = 0; i < original.length; i++) if (original[i] === "\n") lineStarts.push(i + 1);

    for (const node of all) {
        if (node.type !== "FunctionExpression") continue;
        const reason = skipReason(node, parents);
        if (reason) { skipped.push({ line: node.loc.start.line, reason }); continue; }

        // MINIFIER HAZARD, per candidate: if `function` is the first token on its line, the
        // arrow form makes that line start with `(` - the Valve minifier's ASI trigger. Skip
        // just this one conversion rather than refusing the whole file.
        const lineStart = lineStarts[node.loc.start.line - 1];
        if (typeof lineStart === "number" && original.slice(lineStart, node.range[0]).trim() === "") {
            skipped.push({ line: node.loc.start.line, reason: "would start its line with `(` (Valve minifier ASI hazard)" });
            continue;
        }

        const edit = headerEdit(node, original, ast.tokens);
        if (!edit) { skipped.push({ line: node.loc.start.line, reason: "could not locate the parameter list" }); continue; }
        edits.push(edit);
    }

    if (!edits.length) return { rel, converted: 0, skipped };

    edits.sort((a, b) => b.start - a.start);
    let out = original;
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

    let afterAst;
    try { afterAst = parse(out, sourceType); }
    catch (e) { return { rel, error: `result does not parse: ${e.message}` }; }

    const shapeError = verifyShape(ast, afterAst, edits.length);
    if (shapeError) return { rel, error: `SHAPE GATE REFUSED: ${shapeError}` };

    const beforeLines = original.split("\n").length, afterLines = out.split("\n").length;
    if (beforeLines !== afterLines) return { rel, error: `line count changed ${beforeLines} -> ${afterLines}` };

    // THE MINIFIER GUARD. `function () {` becomes `() => {`, so a line whose first non-space
    // character used to be `f` can now start with `(` - which is exactly the Valve Panorama
    // minifier's naive-ASI trigger set. It inserts a `;` before such a line and silently
    // breaks the build (this already happened once: mg_games.js:665, ARCHITECTURE 10.1, and
    // it is why `operator-linebreak` is an ESLint error). ESLint's rule does not cover a
    // leading `(`, so check it here: no line may NEWLY begin with one of ( [ + - /
    const TRIGGER = new Set(["(", "[", "+", "-", "/"]);
    const beforeArr = original.split("\n"), afterArr = out.split("\n");
    for (let i = 0; i < afterArr.length; i++) {
        const a = afterArr[i].trimStart(), b = beforeArr[i].trimStart();
        if (!a.length) continue;
        if (TRIGGER.has(a[0]) && !TRIGGER.has(b[0] || "")) {
            return { rel, error: `line ${i + 1} would newly start with '${a[0]}' (Valve minifier ASI hazard): ${a.slice(0, 60)}` };
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
        for (const s of r.skipped) byReason.set(s.reason, (byReason.get(s.reason) || 0) + 1);
        if (r.converted) console.log(`  ${rel}: ${r.converted} arrow(s), ${r.skipped.length} kept`);
        if (opts.verbose) for (const s of r.skipped) console.log(`       L${s.line} ${s.reason}`);
    }

    console.log(`\n── totals ──`);
    console.log(`  -> arrows : ${total}`);
    console.log(`  kept fn   : ${totalSkipped}`);
    if (byReason.size) {
        console.log("\n  why `function` was kept:");
        for (const [r, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${r}`);
    }
    if (errors.length) { console.log(`\n  ${errors.length} FILE(S) REFUSED:`); for (const e of errors) console.log(`    ${e}`); process.exitCode = 1; }
}

main();
