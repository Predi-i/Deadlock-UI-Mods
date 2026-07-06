"use strict";
// Server-logic test for worker.js. Run: node tools/mg_server_test.js
//
// worker.js is a Cloudflare ESM module. To avoid adding package.json / wrangler to the
// deploy path, we load it by stripping the two `export` keywords and evaluating it (same
// trick mg_rules_test.js uses for the client). Then we drive the Hub class directly with a
// fake storage, calling hub.fetch() and decoding the PNG's (width, height) — exactly what
// the real client reads back over the image side-channel.
const fs = require("fs");
const path = require("path");

let src = fs.readFileSync(path.join(__dirname, "..", "server", "worker.js"), "utf8");
src = src.replace("export default", "const __workerDefault =").replace("export class Hub", "class Hub");
src += "\n;return { Hub };";
const { Hub } = new Function(src)();

// Minimal Durable-Object storage stand-in.
class FakeStorage {
    constructor() { this.m = new Map(); }
    async get(k) { return this.m.has(k) ? this.m.get(k) : undefined; }
    async put(k, v) { this.m.set(k, v); }
    async delete(k) { this.m.delete(k); }
    async list(opts) {
        var prefix = (opts && opts.prefix) || "";
        var out = new Map();
        for (var e of this.m) if (String(e[0]).startsWith(prefix)) out.set(e[0], e[1]);
        return out;
    }
}

async function dims(res) {
    var b = new Uint8Array(await res.arrayBuffer());
    var rd = function (o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; };
    return { w: rd(16), h: rd(20) }; // IHDR width @16, height @20 (big-endian)
}
async function req(hub, pathAndQuery) {
    var res = await hub.fetch(new Request("https://mg.test" + pathAndQuery));
    return await dims(res);
}

var passed = 0;
function ok(cond, msg) {
    if (!cond) { console.error("  ✗ " + msg); process.exitCode = 1; throw new Error("FAIL: " + msg); }
    console.log("  ✓ " + msg); passed++;
}

async function main() {
    var d, hub = new Hub({ storage: new FakeStorage() });

    // ── calibration + private lobby round-trip ──
    d = await req(hub, "/api/probe.png");
    ok(d.w === 600 && d.h === 1000, "probe = (600,1000)");

    d = await req(hub, "/api/create.png?game=1");
    var code = d.w * 100 + (d.h - 1);
    ok(code >= 1000 && code <= 9999, "create returns a 4-digit code (" + code + ")");

    d = await req(hub, "/api/status.png?code=" + code);
    ok(d.w === 1, "status players=1 after create");

    d = await req(hub, "/api/join.png?code=" + code);
    ok(d.w === 1, "join ok returns game id 1");

    d = await req(hub, "/api/status.png?code=" + code);
    ok(d.w === 2, "status players=2 after join");

    d = await req(hub, "/api/move.png?code=" + code + "&from=10&to=20&end=1");
    ok(d.w === 1 && d.h === 1, "move accepted");

    d = await req(hub, "/api/poll.png?code=" + code + "&since=0");
    var end = d.w > 100 ? 1 : 0, from = (end ? d.w - 100 : d.w) - 1, to = d.h - 1;
    ok(end === 1 && from === 10 && to === 20, "poll round-trips {from:10,to:20,end:1}");

    d = await req(hub, "/api/join.png?code=" + code);
    ok(d.w === 21, "join a full lobby returns 21");

    d = await req(hub, "/api/join.png?code=1"); // no such lobby
    ok(d.w === 20, "join a missing lobby returns 20");

    // ── public quickmatch: pairs two callers into one lobby ──
    var h2 = new Hub({ storage: new FakeStorage() });
    var q1 = await req(h2, "/api/quick.png?game=1");
    ok(q1.w >= 100, "quick #1 becomes HOST (w>=100 role flag)");
    var c1 = (q1.w - 100) * 100 + (q1.h - 1);
    ok(c1 >= 1000 && c1 <= 9999, "host code valid (" + c1 + ")");

    var q2 = await req(h2, "/api/quick.png?game=1");
    ok(q2.w < 100, "quick #2 becomes JOINER (w<100)");
    var c2 = q2.w * 100 + (q2.h - 1);
    ok(c2 === c1, "joiner is paired into the host's lobby (same code)");
    d = await req(h2, "/api/status.png?code=" + c1);
    ok(d.w === 2, "paired lobby has 2 players");

    // ── concurrency: more players form a SECOND independent lobby ──
    var q3 = await req(h2, "/api/quick.png?game=1");
    ok(q3.w >= 100, "quick #3 hosts a new lobby (waiting slot was consumed)");
    var c3 = (q3.w - 100) * 100 + (q3.h - 1);
    ok(c3 !== c1, "second lobby has a different code (" + c3 + ")");
    var q4 = await req(h2, "/api/quick.png?game=1");
    var c4 = q4.w * 100 + (q4.h - 1);
    ok(q4.w < 100 && c4 === c3, "quick #4 joins the second lobby");

    await req(h2, "/api/move.png?code=" + c1 + "&from=5&to=14&end=1");
    d = await req(h2, "/api/poll.png?code=" + c3 + "&since=0");
    ok(d.w === 1 && d.h === 1, "second lobby has no moves (independent of first)");
    d = await req(h2, "/api/poll.png?code=" + c1 + "&since=0");
    ok(!(d.w === 1 && d.h === 1), "first lobby carries its own move (two concurrent games)");

    // ── per-game queues don't cross-pair ──
    var h4 = new Hub({ storage: new FakeStorage() });
    await req(h4, "/api/quick.png?game=1");                 // host waiting on game 1
    var g2 = await req(h4, "/api/quick.png?game=2");        // different game
    ok(g2.w >= 100, "quick for a different game hosts its own lobby (per-game queue)");

    // ── cancel frees the waiting slot ──
    var h3 = new Hub({ storage: new FakeStorage() });
    var qc = await req(h3, "/api/quick.png?game=1");
    var cc = (qc.w - 100) * 100 + (qc.h - 1);
    await req(h3, "/api/cancel.png?code=" + cc);
    var qc2 = await req(h3, "/api/quick.png?game=1");
    ok(qc2.w >= 100, "after cancel, next quick hosts fresh (slot freed)");
    d = await req(h3, "/api/status.png?code=" + cc);
    ok(d.w === 9, "cancelled lobby is gone");

    console.log("\nALL SERVER TESTS PASSED (" + passed + " checks)");
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
