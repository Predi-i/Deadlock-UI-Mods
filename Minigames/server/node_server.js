import { createServer } from "node:http";
import { setDefaultResultOrder } from "node:dns";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import worker, { Hub } from "./worker.js";
import { SqliteStorage } from "./node_storage.js";

const DEFAULT_BODY_LIMIT = 512 * 1024;

// The production VPS has working IPv4 egress but no routed IPv6. Node's fetch can otherwise
// select upload.wikimedia.org's AAAA record first and fail GeoGuesser panorama proxying even
// though the same URL is reachable over IPv4.
setDefaultResultOrder("ipv4first");

// worker.core.js remains deployable to Cloudflare, where synchronous zlib does not
// exist. The VPS runtime supplies it explicitly for dimension-only PNG responses.
globalThis.MG_NODE_DEFLATE_SYNC = function (bytes) {
  return deflateSync(bytes, { level: 1 });
};

function envInteger(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function normaliseIp(value) {
  const ip = String(value || "");
  return ip.startsWith("::ffff:") ? ip.substring(7) : ip;
}

function trustedClientIp(request) {
  const peer = normaliseIp(request.socket.remoteAddress);
  const fromLoopback = peer === "127.0.0.1" || peer === "::1";
  const forwarded = String(request.headers["x-real-ip"] || "").trim();
  // Nginx is the only process that can reach the loopback-bound app in production
  // and overwrites X-Real-IP. Never trust a forwarding header from a direct peer.
  return fromLoopback && isIP(forwarded) ? forwarded : peer;
}

function readBody(request, limit) {
  return new Promise(function (resolveBody, rejectBody) {
    const chunks = [];
    let size = 0;
    request.on("data", function (chunk) {
      size += chunk.length;
      if (size > limit) {
        rejectBody(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", function () {
      resolveBody(chunks.length ? Buffer.concat(chunks) : null);
    });
    request.on("error", rejectBody);
  });
}

function copyResponseHeaders(response, outgoing) {
  const setCookies = typeof response.headers.getSetCookie === "function" ?
    response.headers.getSetCookie() : [];
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== "set-cookie") outgoing.setHeader(name, value);
  }
  if (setCookies.length) outgoing.setHeader("set-cookie", setCookies);
}

export function createMinigamesServer(options) {
  const opts = options || {};
  const databasePath = resolve(opts.databasePath ||
    process.env.MG_DATABASE_PATH || "./data/minigames.sqlite");
  const publicOrigin = String(opts.publicOrigin ||
    process.env.MG_PUBLIC_ORIGIN || "").replace(/\/+$/, "");
  const bodyLimit = envInteger("MG_BODY_LIMIT", DEFAULT_BODY_LIMIT, 1024, 4 * 1024 * 1024);
  const storage = new SqliteStorage(databasePath);
  // Second argument mirrors the Durable Object contract (state, env). GeoGuesser reads
  // MG_MAPILLARY_TOKEN from it; without one, its Mapillary rounds cannot resolve an image URL and
  // the game falls back to the pool's Panoramax rows.
  const hub = new Hub({ storage: storage }, process.env);

  // A Durable Object processes one request at a time. Preserve that property here so
  // read-modify-write lobby updates and SQLite transactions cannot interleave.
  let hubTail = Promise.resolve();
  function serialHubFetch(request) {
    const current = hubTail.then(
      function () { return hub.fetch(request); },
      function () { return hub.fetch(request); }
    );
    hubTail = current.catch(function () {});
    return current;
  }

  const workerEnv = Object.assign({}, process.env, {
    HUB: {
      idFromName: function () { return "hub"; },
      get: function () {
        return { fetch: serialHubFetch };
      }
    }
  });

  const server = createServer(async function (incoming, outgoing) {
    try {
      const host = incoming.headers.host || "127.0.0.1";
      const origin = publicOrigin || "http://" + host;
      const url = new URL(incoming.url || "/", origin);
      const headers = new Headers();
      for (const name of Object.keys(incoming.headers)) {
        const value = incoming.headers[name];
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) headers.append(name, value[i]);
        } else if (value !== undefined) {
          headers.set(name, value);
        }
      }

      // Never trust a caller-supplied Cloudflare header. Production Nginx reaches this
      // loopback-only service and overwrites X-Real-IP with its socket's remote address.
      headers.delete("CF-Connecting-IP");
      headers.set("CF-Connecting-IP", trustedClientIp(incoming));

      const method = incoming.method || "GET";
      const body = method === "GET" || method === "HEAD" ?
        null : await readBody(incoming, bodyLimit);
      const requestInit = { method: method, headers: headers };
      if (body) requestInit.body = body;
      const response = await worker.fetch(new Request(url, requestInit), workerEnv);
      const responseBody = Buffer.from(await response.arrayBuffer());

      outgoing.statusCode = response.status;
      copyResponseHeaders(response, outgoing);
      outgoing.setHeader("content-length", String(responseBody.length));
      outgoing.setHeader("x-content-type-options", "nosniff");
      outgoing.end(method === "HEAD" ? null : responseBody);
    } catch (error) {
      const status = error && error.statusCode ? error.statusCode : 500;
      const message = status === 413 ? "Request body too large" : "Internal server error";
      if (status >= 500) console.error("Request failed:", error);
      if (!outgoing.headersSent) {
        outgoing.statusCode = status;
        outgoing.setHeader("content-type", "text/plain; charset=utf-8");
        outgoing.setHeader("cache-control", "no-store");
      }
      outgoing.end(message);
    }
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 30000;
  server.on("clientError", function (error, socket) {
    if (!socket.writable) return;
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  return {
    server: server,
    storage: storage,
    close: function () {
      return new Promise(function (resolveClose, rejectClose) {
        server.close(function (error) {
          if (error) { rejectClose(error); return; }
          storage.close();
          resolveClose();
        });
      });
    }
  };
}

function isMainModule() {
  return process.argv[1] &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  const port = envInteger("PORT", 8787, 0, 65535);
  const host = process.env.HOST || "127.0.0.1";
  const runtime = createMinigamesServer();
  runtime.server.listen(port, host, function () {
    const address = runtime.server.address();
    console.log("deadlock-minigames listening on " + address.address + ":" + address.port);
  });

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log("received " + signal + ", shutting down");
    try {
      await runtime.close();
      process.exit(0);
    } catch (error) {
      console.error("shutdown failed:", error);
      process.exit(1);
    }
  }
  process.on("SIGTERM", function () { shutdown("SIGTERM"); });
  process.on("SIGINT", function () { shutdown("SIGINT"); });
}
