"use strict";
// Integration checks for the production Node + SQLite runtime used on the VPS.
// The existing mg_server_test.js drives Hub with an in-memory Durable Object fake;
// this test crosses the real HTTP adapter and verifies state survives a restart.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const STEP = 9, BASE = 15;

function readU32(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

async function dims(response) {
    assert.strictEqual(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
        rawW: readU32(bytes, 16),
        rawH: readU32(bytes, 20),
        w: Math.round((readU32(bytes, 16) - BASE) / STEP),
        h: Math.round((readU32(bytes, 20) - BASE) / STEP),
    };
}

function decodeCode(value) {
    const band = value.w >= 40 ? 40 : 24;
    return (value.w - band) * 64 + value.h;
}

async function openRuntime(createMinigamesServer, databasePath) {
    const runtime = createMinigamesServer({ databasePath: databasePath });
    await new Promise(function (resolve, reject) {
        runtime.server.once("error", reject);
        runtime.server.listen(0, "127.0.0.1", resolve);
    });
    const address = runtime.server.address();
    return {
        runtime: runtime,
        origin: `http://127.0.0.1:${address.port}`,
    };
}

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-vps-test-"));
    const databasePath = path.join(tempDir, "minigames.sqlite");
    let live = null;
    try {
        const runtimeUrl = pathToFileURL(
            path.join(__dirname, "..", "server", "node_server.js")
        ).href;
        const runtimeModule = await import(runtimeUrl);

        live = await openRuntime(runtimeModule.createMinigamesServer, databasePath);
        await live.runtime.storage.put("test:list:a", { n: 1 });
        await live.runtime.storage.put("test:list:b", { n: 2 });
        await live.runtime.storage.put("test:list:c", { n: 3 });
        const reversed = await live.runtime.storage.list({
            prefix: "test:list:", reverse: true, limit: 2,
        });
        assert.deepStrictEqual(Array.from(reversed.keys()), ["test:list:c", "test:list:b"]);

        await live.runtime.storage.put("test:transaction", "before");
        await assert.rejects(live.runtime.storage.transaction(async function (transaction) {
            await transaction.put("test:transaction", "after");
            throw new Error("injected rollback");
        }));
        assert.strictEqual(await live.runtime.storage.get("test:transaction"), "before");

        let response = await fetch(live.origin + "/api/probe.png");
        let value = await dims(response);
        assert.deepStrictEqual([value.rawW, value.rawH], [600, 1000]);

        response = await fetch(live.origin + "/api/ping.png");
        const pingBytes = new Uint8Array(await response.arrayBuffer());
        assert(pingBytes.length < 300, "VPS dimension PNGs use native zlib compression");

        // Nginx overwrites X-Real-IP and is the only production peer of the loopback
        // listener. Prove the adapter uses it for per-IP abuse controls and discards a
        // caller-supplied Cloudflare header instead of collapsing everyone to 127.0.0.1.
        const scanHeaders = {
            "X-Real-IP": "203.0.113.10",
            "CF-Connecting-IP": "198.51.100.99",
        };
        for (let i = 0; i < 16; i++) {
            response = await fetch(live.origin + "/api/status.png?code=" + i, {
                headers: scanHeaders,
            });
            value = await dims(response);
            assert.deepStrictEqual([value.w, value.h], [9, 1]);
        }
        response = await fetch(live.origin + "/api/status.png?code=16", {
            headers: scanHeaders,
        });
        value = await dims(response);
        assert.deepStrictEqual([value.w, value.h], [9, 4]);
        response = await fetch(live.origin + "/api/status.png?code=16", {
            headers: { "X-Real-IP": "203.0.113.11" },
        });
        value = await dims(response);
        assert.deepStrictEqual([value.w, value.h], [9, 1]);

        const hostToken = "vpshosttoken";
        response = await fetch(live.origin + "/api/create.png?game=2&tok=" + hostToken);
        value = await dims(response);
        const code = decodeCode(value);
        assert(code >= 0 && code <= 1023);

        response = await fetch(live.origin + "/api/status.png?code=" + code +
            "&tok=" + hostToken);
        value = await dims(response);
        assert.deepStrictEqual([value.w, value.h], [1, 3]);

        const batch = [];
        for (let i = 0; i < 10; i++) batch.push(i + ",0,1");
        response = await fetch(live.origin + "/api/pxput.png?id=123456&b=" +
            encodeURIComponent(batch.join(";")));
        value = await dims(response);
        assert.deepStrictEqual([value.w, value.h], [26, 1]); // 90 pixels remain

        response = await fetch(live.origin + "/api/pxversion.png?id=123456");
        value = await dims(response);
        assert.deepStrictEqual([value.w, value.h], [1, 0]);

        response = await fetch(live.origin + "/admin");
        assert.strictEqual(response.status, 503, "admin must fail closed without OAuth secrets");

        // ── request statistics ────────────────────────────────────────────────────
        // Route folding is what bounds storage: an unknown path must never mint its own
        // key, or a scanner could grow the `st:` space without limit.
        const workerUrl = pathToFileURL(
            path.join(__dirname, "..", "server", "worker.js")
        ).href;
        const workerModule = await import(workerUrl);
        assert.strictEqual(workerModule.statsRouteKey("/api/poll.png"), "/api/poll",
            "the client's .png suffix must fold onto the real route");
        assert.strictEqual(workerModule.statsRouteKey("/api/definitely-not-a-route"), "/api/*");
        assert.strictEqual(workerModule.statsRouteKey("/admin/api/stats"), "/admin/*");
        assert.strictEqual(workerModule.statsRouteKey("/wp-login.php"), "other");

        // Sentinels are read back from raw PNG dimensions, so they must decode through the
        // same level codec the client uses - and ordinary payloads must not look like one.
        const level = (value) => value * 9 + 15;
        const sentinel = workerModule.statsSentinelKey;
        assert.strictEqual(sentinel("/api/move", level(1), level(1)), "1,1");
        assert.strictEqual(sentinel("/api/move", level(9), level(7)), "9,7");
        assert.strictEqual(sentinel("/api/join", level(20), level(1)), "20,1");
        assert.strictEqual(sentinel("/api/pxput", level(5), level(63)), "5,63");
        assert.strictEqual(sentinel("/api/probe", 600, 1000), "",
            "the probe is a literal-pixel image, not a sentinel");
        assert.strictEqual(sentinel("/api/geoview", 2048, 1024), "",
            "a real panorama must never register as a sentinel");

        // THE INVARIANT THAT MAKES THE NUMBERS TRUSTWORTHY: the 12-bit downlink reuses the
        // same integer space for real data, so a route-blind classifier reports errors that
        // never happened. Each of these is a SUCCESSFUL reply whose (w,h) collides with an
        // error sentinel, and none of them may be counted as one.
        assert.strictEqual(sentinel("/api/join", level(9), level(1)), "",
            "a successful GeoGuesser join is d(game 9, tcIndex+1) = (9,1), not an error");
        assert.strictEqual(sentinel("/api/poll", level(9), level(1)), "",
            "a legal move from square 9 to square 1 is (9,1), not an error");
        assert.strictEqual(sentinel("/api/pdraw", level(20), level(1)), "",
            "poker hole card 18 encodes as d(card+2, 1) = (20,1), not 'lobby missing'");
        assert.strictEqual(sentinel("/api/pxversion", level(9), level(4)), "",
            "a canvas version of 265 is (9,4), not a throttle sentinel");
        assert.strictEqual(sentinel("/api/geostate", level(9), level(2)), "",
            "round 9 state is not an illegal-move sentinel");
        // The genuinely unambiguous cases in those same modes must still be caught.
        assert.strictEqual(sentinel("/api/poll", level(9), level(9)), "9,9",
            "from == to is impossible in a real move, so (9,9) is a true 'lobby gone'");
        assert.strictEqual(sentinel("/api/join", level(9), level(9)), "9,9",
            "an untimed game-9 lobby never sends h=9, so this is a real sentinel");

        // Counters must reach storage and name the routes actually exercised above.
        await live.runtime.flushStats();
        let statsHours = await live.runtime.storage.list({ prefix: "st:h:" });
        assert(statsHours.size >= 1, "a flush must persist at least one hourly bucket");
        let bucket = Array.from(statsHours.values())[0];
        assert(bucket.total > 0, "the hourly bucket must count requests");
        assert(bucket.routes["/api/create"] >= 1, "per-route counters must be recorded");
        assert(bucket.routes["/api/probe"] >= 1);
        assert(bucket.statuses["200"] >= 1, "HTTP status counters must be recorded");
        assert(bucket.sentinels["1,1"] >= 1, "protocol sentinels must be counted");
        assert(bucket.ipPeak >= 1, "the unique-IP count must be recorded");
        assert.strictEqual(JSON.stringify(bucket).indexOf("203.0.113.11"), -1,
            "no IP address may ever be persisted");

        const beforeRestartTotal = bucket.total;

        await live.runtime.close();
        live = null;

        // The same SQLite file must restore both lobby and Pixel Battle state.
        live = await openRuntime(runtimeModule.createMinigamesServer, databasePath);
        response = await fetch(live.origin + "/api/status.png?code=" + code +
            "&tok=" + hostToken);
        value = await dims(response);
        assert.deepStrictEqual([value.w, value.h], [1, 3]);

        response = await fetch(live.origin + "/api/pxversion.png?id=123456");
        value = await dims(response);
        assert.deepStrictEqual([value.w, value.h], [1, 0]);

        // Counters accumulate across a restart rather than resetting, which also proves
        // close() flushed its final partial window instead of discarding it.
        await live.runtime.flushStats();
        statsHours = await live.runtime.storage.list({ prefix: "st:h:" });
        bucket = Array.from(statsHours.values())[0];
        assert(bucket.total > beforeRestartTotal,
            "counters must survive a restart and keep accumulating");

        const statsDays = await live.runtime.storage.list({ prefix: "st:d:" });
        assert.strictEqual(statsDays.size, 1, "one daily rollup per day");
        assert(Array.from(statsDays.values())[0].total >= bucket.total,
            "the daily rollup must include the hour");

        // Collection runs in a finally block on EVERY request, so a malformed entry has to
        // be swallowed rather than turned into a failed response on a route that worked.
        assert.doesNotThrow(function () {
            live.runtime.stats.record({});
            live.runtime.stats.record({ pathname: null, status: NaN, ms: NaN, bytes: NaN });
        }, "stats.record must never throw");

        console.log("VPS runtime tests passed (HTTP adapter + SQLite restart + stats)");
    } finally {
        if (live) await live.runtime.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
