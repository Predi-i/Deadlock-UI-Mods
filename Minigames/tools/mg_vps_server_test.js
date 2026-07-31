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
        origin: "http://127.0.0.1:" + address.port,
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

        console.log("VPS runtime tests passed (HTTP adapter + SQLite restart persistence)");
    } finally {
        if (live) await live.runtime.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
