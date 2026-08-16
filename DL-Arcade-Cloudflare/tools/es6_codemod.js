"use strict";

/*
 * es6_codemod.js - DEV-ONLY. Converts `var` -> `const`/`let` across the project.
 *
 * WHY THIS IS A CODEMOD AND NOT A REGEX: `var` is function-scoped, `let`/`const` are
 * block-scoped. A blind swap silently changes behaviour in at least five ways (redeclaration,
 * TDZ, block escape, per-iteration loop bindings, switch-case fallthrough). The Panorama
 * controllers have almost no automated coverage and cannot run outside the game, so a
 * behaviour change here ships green and breaks live. See ARCHITECTURE §10.1.
 *
 * SAFETY MODEL - two independent guarantees:
 *
 *  1. SCOPE ANALYSIS decides *whether* a declaration may convert. Every hazard below keeps
 *     `var` untouched and is reported, rather than being converted optimistically:
 *       - redeclaration        `var x` twice in one function scope (let would SyntaxError)
 *       - TDZ (straight-line)  the name is read textually before its declaration
 *       - TDZ (early-executed) the name is read inside a function that RUNS before the
 *                              declaration (IIFE, or a function called above it - computed
 *                              transitively), where let would throw instead of giving undefined
 *       - block escape         the name is used outside the block that would now scope it
 *       - switch fallthrough   declared in one `case`, used in another (a case can be entered
 *                              without running the declaration -> TDZ)
 *       - loop capture         a closure inside a loop captures the loop variable; `let` would
 *                              give it a fresh per-iteration binding. That is usually a BUGFIX,
 *                              but it is still a behaviour change, so we do not make it here.
 *
 *  2. TOKEN EQUIVALENCE proves *what* changed. The file is re-tokenised after editing and
 *     compared token-by-token against the original. The ONLY permitted difference is a
 *     `var` Keyword token becoming `let`/`const` at an expected offset. Any other drift
 *     refuses the write. This is why the transform edits the keyword's byte range in place
 *     and never re-prints the AST: no reflow means no exposure to the Valve Panorama
 *     minifier's naive ASI pass (a shipped line must never START with a binary operator -
 *     ARCHITECTURE §10.1 / trap on mg_games.js:665).
 *
 * `const` is chosen only when THREE independent checks all agree the binding is never
 * rewritten: eslint-scope write-references, a structural scan of every assignment target in
 * the file (`collectWrittenNames` - survives unresolved references), and the syntactic
 * position (a for-init counter is always `let`). One missed write here is a hard runtime
 * crash, so no single check is trusted alone.
 *
 * Usage:
 *   node tools/es6_codemod.js                 # dry run, prints the report
 *   node tools/es6_codemod.js --write         # apply
 *   node tools/es6_codemod.js --only mg_ttt   # restrict to matching paths
 *   node tools/es6_codemod.js --verbose       # list every kept `var` with its reason
 *   node tools/es6_codemod.js --root <dir>    # operate on another tree (the test harness)
 */

const fs = require("fs");
const path = require("path");
const espree = require("espree");
const eslintScope = require("eslint-scope");

// --root lets the safety harness point the codemod at a scratch tree while the script
// itself still runs from the repo, so `require("espree")` keeps resolving.
const rootArgIdx = process.argv.indexOf("--root");
const ROOT = rootArgIdx !== -1 && process.argv[rootArgIdx + 1]
    ? path.resolve(process.argv[rootArgIdx + 1])
    : path.resolve(__dirname, "..");
// PARSER capability only, NOT an output target: this codemod never emits new syntax, it
// only swaps a `var` keyword for `let`/`const`. 2023 is required because two dev-only tools
// start with `#!/usr/bin/env node`, and hashbang comments are only legal from ES2023 (espree
// has no `allowHashBang` option - that is an old esprima flag and is silently ignored).
const ECMA = 2023;

// server/worker.js is a GENERATED deploy artifact (tools/build_worker.js concatenates
// worker.core.js + rules/*.js). Converting it directly would be overwritten and would break
// `build_worker --check`; it gets regenerated from the converted sources instead.
const SKIP = new Set([path.join("server", "worker.js")]);

// The authored worker sources are ES modules (`export default {}`); everything else is script
// (Panorama scripts, CommonJS tools).
const MODULE_FILES = new Set([
    path.join("server", "worker.core.js"),
    path.join("server", "admin_panel.js"),
]);

const LOOP_TYPES = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const FUNC_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const BLOCK_SCOPE_TYPES = new Set([
    "BlockStatement", "SwitchStatement", "Program", "StaticBlock",
    "ForStatement", "ForInStatement", "ForOfStatement",
]);

// ── file discovery ────────────────────────────────────────────────────────────

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
    for (const sub of ["panorama", "server", "tools", "update-markers"]) {
        walkDir(path.join(ROOT, sub), out);
    }
    return out
        .map((f) => path.relative(ROOT, f))
        .filter((rel) => !SKIP.has(rel))
        // don't rewrite this codemod itself mid-run
        .filter((rel) => rel !== path.join("tools", "es6_codemod.js"))
        .sort();
}

// ── AST helpers ───────────────────────────────────────────────────────────────

// Hashbang support comes from ECMA (see the ECMA constant), not from a parser flag.
const PARSE_OPTS = {
    ecmaVersion: ECMA,
    range: true,
    loc: true,
    tokens: true,
    comment: true,
};

function parse(code, sourceType) {
    return espree.parse(code, Object.assign({}, PARSE_OPTS, { sourceType }));
}

/**
 * Scope analysis, with `nodejsScope` for scripts.
 *
 * WHY THIS FLAG IS LOAD-BEARING: with a plain `sourceType:"script"` analysis, eslint-scope
 * leaves TOP-LEVEL references UNRESOLVED - they land in `scope.through` and `variable.references`
 * comes back EMPTY. A "never reassigned -> const" test then passes vacuously, and the codemod
 * emits `for (const i = 0; i < 3; i++)`, which throws "Assignment to constant variable" on the
 * first iteration. Caught by mg_es6_codemod_test.js; do not remove this flag or the mutation
 * checks below without re-running that harness.
 */
function analyzeScopes(ast, sourceType) {
    return eslintScope.analyze(ast, {
        ecmaVersion: ECMA,
        sourceType,
        ignoreEval: true,
        nodejsScope: sourceType === "script",
    });
}

/**
 * LAYER 2 (independent of eslint-scope): every name the file ever WRITES, found structurally.
 * Covers `x = 1`, `x += 1`, `x++`, and destructuring assignment targets. Used as a veto on
 * `const` so a resolution gap can never again produce a const that is later assigned.
 */
function collectWrittenNames(all) {
    const written = new Set();
    const addPattern = (node) => {
        if (!node || typeof node.type !== "string") return;
        switch (node.type) {
            case "Identifier": written.add(node.name); break;
            case "ObjectPattern":
                for (const p of node.properties) addPattern(p.type === "Property" ? p.value : p.argument);
                break;
            case "ArrayPattern":
                for (const el of node.elements) addPattern(el);
                break;
            case "AssignmentPattern": addPattern(node.left); break;
            case "RestElement": addPattern(node.argument); break;
            case "MemberExpression": break; // obj.x = 1 mutates the object, not the binding
            default: break;
        }
    };
    for (const n of all) {
        if (n.type === "AssignmentExpression") addPattern(n.left);
        else if (n.type === "UpdateExpression") addPattern(n.argument);
        else if (n.type === "ForInStatement" || n.type === "ForOfStatement") {
            if (n.left && n.left.type !== "VariableDeclaration") addPattern(n.left);
        }
    }
    return written;
}

/** Attach parent pointers and collect every node, in source order. */
function indexAst(ast) {
    const parents = new Map();
    const all = [];
    (function visit(node, parent) {
        if (!node || typeof node.type !== "string") return;
        parents.set(node, parent);
        all.push(node);
        for (const key of Object.keys(node)) {
            if (key === "range" || key === "loc" || key === "parent") continue;
            const val = node[key];
            if (Array.isArray(val)) {
                for (const child of val) if (child && typeof child.type === "string") visit(child, node);
            } else if (val && typeof val.type === "string") {
                visit(val, node);
            }
        }
    })(ast, null);
    return { parents, all };
}

function ancestorsOf(node, parents) {
    const out = [];
    let cur = parents.get(node);
    while (cur) { out.push(cur); cur = parents.get(cur); }
    return out;
}

/** Nearest ancestor (inclusive of `node` itself) that would scope a `let`. */
function blockScopeNodeFor(node, parents) {
    let cur = node;
    while (cur) {
        if (BLOCK_SCOPE_TYPES.has(cur.type)) return cur;
        cur = parents.get(cur);
    }
    return null;
}

function enclosingFunctionOrProgram(node, parents) {
    let cur = parents.get(node);
    while (cur) {
        if (FUNC_TYPES.has(cur.type) || cur.type === "Program") return cur;
        cur = parents.get(cur);
    }
    return null;
}

function contains(outer, inner) {
    return outer.range[0] <= inner.range[0] && inner.range[1] <= outer.range[1];
}

/**
 * Function bodies that are guaranteed to have executed BEFORE `declNode`:
 * IIFEs appearing above it, plus locally-named functions called above it, expanded
 * transitively through those functions' own bodies. A `let` read from any of these
 * would hit the temporal dead zone where `var` merely yielded undefined.
 */
function earlyExecutedFunctions(declNode, all, parents) {
    const fnByName = new Map();
    for (const n of all) {
        if (n.type === "FunctionDeclaration" && n.id) fnByName.set(n.id.name, n);
        else if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && n.init && FUNC_TYPES.has(n.init.type)) {
            fnByName.set(n.id.name, n.init);
        }
    }

    // Straight-line = not nested inside some other function relative to `host`.
    function straightLineCalleesWithin(host, beforeOffset) {
        const names = [];
        const iifes = [];
        for (const n of all) {
            if (n.type !== "CallExpression" && n.type !== "NewExpression") continue;
            if (!contains(host, n)) continue;
            if (beforeOffset !== null && n.range[0] >= beforeOffset) continue;
            // reject if a function boundary sits between the call and `host`
            let cur = parents.get(n), nested = false;
            while (cur && cur !== host) {
                if (FUNC_TYPES.has(cur.type)) { nested = true; break; }
                cur = parents.get(cur);
            }
            if (nested) continue;
            if (n.callee.type === "Identifier") names.push(n.callee.name);
            else if (FUNC_TYPES.has(n.callee.type)) iifes.push(n.callee);
        }
        return { names, iifes };
    }

    const host = enclosingFunctionOrProgram(declNode, parents) || all[0];
    const seedHost = host.type === "Program" ? host : (host.body || host);
    const seed = straightLineCalleesWithin(seedHost.type ? seedHost : host, declNode.range[0]);

    const early = new Set(seed.iifes);
    const queue = [...seed.names];
    const seenNames = new Set();
    while (queue.length) {
        const name = queue.pop();
        if (seenNames.has(name)) continue;
        seenNames.add(name);
        const fn = fnByName.get(name);
        if (!fn) continue;
        early.add(fn);
        const inner = straightLineCalleesWithin(fn, null);
        for (const nm of inner.names) if (!seenNames.has(nm)) queue.push(nm);
        for (const f of inner.iifes) early.add(f);
    }
    return early;
}

// ── the decision ──────────────────────────────────────────────────────────────

/** @returns {{kind:'const'|'let'|null, reason:string}} */
function decide(declNode, vars, ctx) {
    const { parents, all, writtenNames } = ctx;

    // Never touch a `var` that is redeclared: `let` would be a hard SyntaxError.
    for (const v of vars) {
        if (v.defs.length > 1) return { kind: null, reason: "redeclared in the same scope" };
        for (const ref of v.references) {
            if (ref.from && ref.from.type === "with") return { kind: null, reason: "referenced inside a with-block" };
        }
    }

    // LAYER 3: a name declared in a for-init and mutated by that loop's update/test can never
    // be const, independently of how references resolved. `for (var i = 0; ...; i++)`.
    const parentOfDecl = parents.get(declNode);
    const isForInit = parentOfDecl && parentOfDecl.type === "ForStatement" && parentOfDecl.init === declNode;
    const isForInOfLeft =
        parentOfDecl &&
        (parentOfDecl.type === "ForInStatement" || parentOfDecl.type === "ForOfStatement") &&
        parentOfDecl.left === declNode;

    const blockNode = blockScopeNodeFor(declNode, parents);
    if (!blockNode) return { kind: null, reason: "no resolvable block scope" };

    const declCase = ancestorsOf(declNode, parents).find((a) => a.type === "SwitchCase");

    for (const v of vars) {
        for (const ref of v.references) {
            const id = ref.identifier;

            // Block escape: used outside the block that would now scope it.
            if (!contains(blockNode, id)) return { kind: null, reason: "used outside its would-be block scope" };

            // Straight-line read before the declaration -> definitely runs first.
            if (id.range[0] < declNode.range[0]) {
                const fnBetween = ancestorsOf(id, parents).some(
                    (a) => FUNC_TYPES.has(a.type) && contains(blockNode, a)
                );
                if (!fnBetween) return { kind: null, reason: "read before its declaration (TDZ)" };
            }

            // Declared in one switch-case, used in another: that case can be entered
            // without the declaration having run.
            if (declCase) {
                const refCase = ancestorsOf(id, parents).find((a) => a.type === "SwitchCase");
                if (refCase && refCase !== declCase) {
                    return { kind: null, reason: "spans switch-cases (TDZ on fallthrough)" };
                }
            }
        }
    }

    // A closure inside a loop capturing the loop variable: `let` gives a fresh binding per
    // iteration. Often the fix people want, but it IS a behaviour change - not tonight.
    //
    // The capture scan must also work when references did not resolve (see analyzeScopes):
    // fall back to matching identifiers by NAME inside the loop when v.references is empty.
    const loopNode = ancestorsOf(declNode, parents).find((a) => LOOP_TYPES.has(a.type));
    if (loopNode) {
        const declaredNames = new Set(vars.map((v) => v.name));
        const candidates = [];
        for (const v of vars) for (const ref of v.references) candidates.push(ref.identifier);
        if (!candidates.length) {
            for (const n of all) {
                if (n.type === "Identifier" && declaredNames.has(n.name) && contains(loopNode, n)) candidates.push(n);
            }
        }
        for (const id of candidates) {
            let cur = parents.get(id), crossed = false;
            while (cur && cur !== loopNode) {
                if (FUNC_TYPES.has(cur.type)) { crossed = true; break; }
                cur = parents.get(cur);
            }
            if (crossed) return { kind: null, reason: "captured by a closure inside a loop" };
        }
    }

    // A function that already ran above this line would now read a TDZ binding.
    const early = earlyExecutedFunctions(declNode, all, parents);
    if (early.size) {
        for (const v of vars) {
            for (const ref of v.references) {
                for (const fn of early) {
                    if (contains(fn, ref.identifier) && !contains(fn, declNode)) {
                        return { kind: null, reason: "read by a function that executes before the declaration (TDZ)" };
                    }
                }
            }
        }
    }

    // const iff every declarator is initialised and NOTHING ever rewrites the binding.
    // Three independent vetoes, because a single miss here ships a runtime crash:
    //   (a) eslint-scope write references
    //   (b) the structural written-names set (survives unresolved references)
    //   (c) the for-init / for-in-of-left position
    const allInitialised = declNode.declarations.every((d) => d.init !== null && d.init !== undefined);
    let extraWrites = 0;
    for (const v of vars) for (const ref of v.references) if (ref.isWrite() && !ref.init) extraWrites++;
    const destructures = declNode.declarations.some((d) => d.id.type !== "Identifier");
    const structurallyWritten = vars.some((v) => writtenNames.has(v.name));

    // `for (const x of xs)` / `for (const k in o)` are legal and idiomatic, but only when the
    // body never assigns to the name. A for-INIT (`for (;;)`) is a mutation position by nature.
    if (isForInit) {
        return { kind: "let", reason: "for-init counter (mutated by the loop update)" };
    }
    if (isForInOfLeft) {
        if (structurallyWritten || extraWrites > 0) {
            return { kind: "let", reason: "for-in/of binding is assigned in the body" };
        }
        return { kind: "const", reason: "for-in/of binding, never assigned" };
    }

    if (allInitialised && extraWrites === 0 && !structurallyWritten && !destructures) {
        return { kind: "const", reason: "never reassigned" };
    }
    if (!allInitialised) return { kind: "let", reason: "not initialised at declaration" };
    if (destructures) return { kind: "let", reason: "destructuring declaration" };
    return { kind: "let", reason: "reassigned" };
}

// ── token equivalence gate ────────────────────────────────────────────────────

/**
 * Re-tokenise and prove the only differences are the keywords we meant to change.
 * @returns {string|null} error message, or null when equivalent.
 */
function verifyTokens(before, after, sourceType, expectedCount) {
    let a, b;
    try {
        a = espree.tokenize(before, { ecmaVersion: ECMA, sourceType, range: true });
        b = espree.tokenize(after, { ecmaVersion: ECMA, sourceType, range: true });
    } catch (e) {
        return "re-tokenise failed: " + e.message;
    }
    if (a.length !== b.length) return `token count changed ${a.length} -> ${b.length}`;
    let changed = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i].type === b[i].type && a[i].value === b[i].value) continue;
        const ok = a[i].type === "Keyword" && a[i].value === "var" &&
                   b[i].type === "Keyword" && (b[i].value === "let" || b[i].value === "const");
        if (!ok) return `token ${i} changed unexpectedly: ${a[i].type}:${a[i].value} -> ${b[i].type}:${b[i].value}`;
        changed++;
    }
    if (changed !== expectedCount) return `expected ${expectedCount} keyword edits, token diff shows ${changed}`;
    return null;
}

// ── per-file transform ────────────────────────────────────────────────────────

function processFile(rel, opts) {
    const abs = path.join(ROOT, rel);
    const sourceType = MODULE_FILES.has(rel) ? "module" : "script";
    const original = fs.readFileSync(abs, "utf8");

    let ast;
    try {
        ast = parse(original, sourceType);
    } catch (e) {
        return { rel, error: `parse failed: ${e.message}` };
    }

    const scopeManager = analyzeScopes(ast, sourceType);

    const ctx = indexAst(ast);
    ctx.writtenNames = collectWrittenNames(ctx.all);

    // Group every var-declared variable by its VariableDeclaration node.
    const byDecl = new Map();
    for (const scope of scopeManager.scopes) {
        for (const v of scope.variables) {
            for (const def of v.defs) {
                if (def.type !== "Variable") continue;
                const parent = def.parent;
                if (!parent || parent.type !== "VariableDeclaration" || parent.kind !== "var") continue;
                if (!byDecl.has(parent)) byDecl.set(parent, new Set());
                byDecl.get(parent).add(v);
            }
        }
    }

    const edits = [];
    const kept = [];
    let nConst = 0, nLet = 0;

    for (const [declNode, varSet] of byDecl) {
        const vars = [...varSet];
        const { kind, reason } = decide(declNode, vars, ctx);
        const line = declNode.loc.start.line;
        if (!kind) {
            kept.push({ line, names: vars.map((v) => v.name).join(", "), reason });
            continue;
        }
        const tok = ast.tokens.find(
            (t) => t.type === "Keyword" && t.value === "var" &&
                   t.range[0] >= declNode.range[0] && t.range[1] <= declNode.range[1]
        );
        if (!tok) {
            kept.push({ line, names: vars.map((v) => v.name).join(", "), reason: "could not locate the `var` token" });
            continue;
        }
        edits.push({ start: tok.range[0], end: tok.range[1], text: kind });
        if (kind === "const") nConst++; else nLet++;
    }

    if (!edits.length) return { rel, nConst: 0, nLet: 0, kept, unchanged: true };

    // Apply back-to-front so earlier offsets stay valid.
    edits.sort((x, y) => y.start - x.start);
    let out = original;
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

    const tokenError = verifyTokens(original, out, sourceType, edits.length);
    if (tokenError) return { rel, error: `TOKEN GATE REFUSED: ${tokenError}` };

    try {
        parse(out, sourceType);
    } catch (e) {
        return { rel, error: `result does not parse: ${e.message}` };
    }

    if (opts.write) fs.writeFileSync(abs, out);
    return { rel, nConst, nLet, kept };
}

// ── main ──────────────────────────────────────────────────────────────────────

function main() {
    const argv = process.argv.slice(2);
    const opts = {
        write: argv.includes("--write"),
        verbose: argv.includes("--verbose"),
        only: null,
    };
    const onlyIdx = argv.indexOf("--only");
    if (onlyIdx !== -1 && argv[onlyIdx + 1]) opts.only = argv[onlyIdx + 1];

    let files = targetFiles();
    if (opts.only) files = files.filter((f) => f.includes(opts.only));

    console.log(`${opts.write ? "APPLYING" : "DRY RUN"} - ${files.length} files, ecmaVersion ${ECMA}\n`);

    let totConst = 0, totLet = 0, totKept = 0;
    const errors = [];
    const keptByReason = new Map();

    for (const rel of files) {
        const r = processFile(rel, opts);
        if (r.error) {
            errors.push(`${rel}: ${r.error}`);
            console.log(`  !! ${rel}: ${r.error}`);
            continue;
        }
        totConst += r.nConst;
        totLet += r.nLet;
        totKept += r.kept.length;
        for (const k of r.kept) {
            keptByReason.set(k.reason, (keptByReason.get(k.reason) || 0) + 1);
        }
        if (r.nConst || r.nLet || r.kept.length) {
            console.log(`  ${rel}: const=${r.nConst} let=${r.nLet} kept-var=${r.kept.length}`);
            if (opts.verbose) {
                for (const k of r.kept) console.log(`       L${k.line} [${k.names}] ${k.reason}`);
            }
        }
    }

    console.log(`\n── totals ──`);
    console.log(`  -> const : ${totConst}`);
    console.log(`  -> let   : ${totLet}`);
    console.log(`  kept var : ${totKept}`);
    if (keptByReason.size) {
        console.log(`\n  why var was kept:`);
        for (const [reason, n] of [...keptByReason].sort((a, b) => b[1] - a[1])) {
            console.log(`    ${String(n).padStart(4)}  ${reason}`);
        }
    }
    if (errors.length) {
        console.log(`\n  ${errors.length} FILE(S) REFUSED:`);
        for (const e of errors) console.log(`    ${e}`);
        process.exitCode = 1;
    }
}

main();
