/**
 * Deadlock Minigames relay — Cloudflare Worker.
 *
 * Panorama UI has no fetch / no AsyncWebRequest / no websockets. The ONLY channel
 * back to the client is the intrinsic pixel size of an <Image>: the client sets an
 * image src and reads actuallayoutwidth / actuallayoutheight. So every response here
 * is a tiny PNG whose (width, height) ENCODE two integers.
 *
 * Sending data TO the server is unlimited (URL query params). Only the RESPONSE is
 * squeezed into (width, height). Design accordingly: clients are authoritative on
 * game rules; the server is a dumb, strongly-consistent relay of moves.
 *
 * Transport is strongly consistent because all state lives in ONE Durable Object
 * instance ("hub"). No KV eventual-consistency lag between the two players.
 *
 * Every response keeps BOTH dimensions small (<= ~128 px) so the engine never has
 * to lay out a huge image. Big numbers (the 4-digit lobby code) are split across the
 * two dimensions. On startup the client calls /api/probe once to learn whether the
 * engine swaps width/height, then applies that correction to every read.
 *
 * NOTE: image dimensions are always >= 1 (png() clamps), so a raw 0 can never be read
 * back. Every sentinel below is therefore a non-zero value.
 *
 * Routes (all GET, all return a PNG; pass &rnd=<random> to defeat engine caching):
 *   /api/probe                             -> (600, 1000)               swap + scale calibration
 *   /api/create?game=G                     -> (CODE_HI, CODE_LO+1)      new PRIVATE lobby, host is player 0
 *   /api/quick?game=G                      -> JOINER (CODE_HI, CODE_LO+1) · HOST (CODE_HI+100, CODE_LO+1)
 *   /api/cancel?code=C                     -> (1,1)                     drop a still-waiting lobby
 *   /api/join?code=C                       -> (G,1) ok · (20,1) missing · (21,1) full
 *   /api/status?code=C                     -> (players,1) · (9,1) gone
 *   /api/move?code=C&from=F&to=T&end=E     -> (1,1) ok · (9,9) fail
 *   /api/poll?code=C&since=S               -> (from+1[+100 if end], to+1) · (1,1) nothing new
 *   /api/reset?code=C&game=G               -> (1,1)
 *
 * The probe returns a LARGE known image on purpose: the client derives the UI scale
 * from it, and a big reference makes that scale precise, so every small returned value
 * (code halves <=99, squares 0..63, the +100 flags) decodes without rounding drift.
 *
 * Public quickmatch keeps a single waiting slot per game under "pubq:<game>". A caller
 * either joins the waiting lobby (becomes player 1, black) or hosts a fresh public lobby
 * and waits. The +100 gap on the HOST width encodes the role, immune to +/-1 rounding.
 *
 * CODE = CODE_HI*100 + CODE_LO (4-digit). Squares are 0..63; from != to always, so a
 * real poll move can never decode to (1,1) — that's why (1,1) is a safe "nothing" marker.
 * The client polls with since = last applied seq; the returned move is seq = since+1.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return new Response("Deadlock Minigames relay OK", { status: 200 });
    }
    // All game state lives in a single strongly-consistent Durable Object.
    const id = env.HUB.idFromName("hub");
    const stub = env.HUB.get(id);
    return stub.fetch(request);
  },
};

export class Hub {
  constructor(state) {
    this.state = state;
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    // Panorama's <Image> loader only fetches URLs that look like an image, so the
    // client appends ".png" to every route. Strip it here before routing.
    const p = url.pathname.replace(/\.png$/, "");
    const q = url.searchParams;
    const code = q.get("code");

    try {
      if (p === "/api/probe") return png(600, 1000);

      if (p === "/api/create") {
        await this.maybeSweep();
        const game = clampInt(q.get("game"), 1, 1, 9);
        const newCode = await this.freshCode();
        const lobby = { game, players: 1, moves: [], pub: 0, t: nowSeq() };
        await this.storage.put("l:" + newCode, lobby);
        // Split the 4-digit code across both dimensions to keep them small.
        return png(Math.floor(newCode / 100), (newCode % 100) + 1);
      }

      if (p === "/api/quick") {
        await this.maybeSweep();
        const game = clampInt(q.get("game"), 1, 1, 9);
        const waitCode = await this.storage.get("pubq:" + game);
        if (waitCode) {
          const w = await this.storage.get("l:" + waitCode);
          if (w && w.pub && w.players < 2) {
            w.players = 2;
            await this.storage.put("l:" + waitCode, w);
            await this.storage.delete("pubq:" + game);
            return png(Math.floor(waitCode / 100), (waitCode % 100) + 1); // JOINER (black)
          }
          // stale/closed slot — fall through and host a fresh lobby.
        }
        const newCode = await this.freshCode();
        const lobby = { game, players: 1, moves: [], pub: 1, t: nowSeq() };
        await this.storage.put("l:" + newCode, lobby);
        await this.storage.put("pubq:" + game, newCode);
        // HOST (white): +100 on the width flags the role without a fragile extra value.
        return png(Math.floor(newCode / 100) + 100, (newCode % 100) + 1);
      }

      if (p === "/api/cancel") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (lobby && lobby.players < 2) {
          await this.storage.delete("l:" + code);
          const waitCode = await this.storage.get("pubq:" + lobby.game);
          if (waitCode != null && Number(waitCode) === Number(code)) {
            await this.storage.delete("pubq:" + lobby.game);
          }
        }
        return png(1, 1);
      }

      if (p === "/api/join") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(20, 1);             // missing
        if (lobby.players >= 2) return png(21, 1); // full
        lobby.players = 2;
        await this.storage.put("l:" + code, lobby);
        return png(lobby.game, 1);                 // ok: which game the host picked (1..9)
      }

      if (p === "/api/status") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(9, 1);              // gone
        return png(lobby.players, 1);              // 1 or 2
      }

      if (p === "/api/move") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(9, 9);              // fail
        const from = clampInt(q.get("from"), 0, 0, 63);
        const to = clampInt(q.get("to"), 0, 0, 63);
        const end = clampInt(q.get("end"), 0, 0, 1);
        lobby.moves.push({ f: from, t: to, e: end });
        await this.storage.put("l:" + code, lobby);
        return png(1, 1);                          // ok
      }

      if (p === "/api/poll") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(1, 1);              // treat gone as "nothing new"
        const since = clampInt(q.get("since"), 0, 0, 100000);
        const mv = lobby.moves[since]; // 0-based; this move is seq = since+1
        if (!mv) return png(1, 1);                 // nothing new
        // width = from+1 (+100 if this hop ends the turn); height = to+1.
        // Keeping `end` in a separate hundreds-range (not a low bit) makes it
        // immune to +/-1 rounding from UI scaling. from != to, so never (1,1).
        return png(mv.f + 1 + (mv.e ? 100 : 0), mv.t + 1);
      }

      if (p === "/api/reset") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(9, 9);
        lobby.game = clampInt(q.get("game"), lobby.game, 1, 9);
        lobby.moves = [];
        await this.storage.put("l:" + code, lobby);
        return png(1, 1);
      }

      return png(9, 8); // unknown route
    } catch (e) {
      return png(9, 7); // server error marker
    }
  }

  async freshCode() {
    // 4-digit lobby code (1000..9999), avoid collisions.
    for (let i = 0; i < 40; i++) {
      const c = 1000 + Math.floor(Math.random() * 9000);
      const existing = await this.storage.get("l:" + c);
      if (!existing) return c;
    }
    return 1000 + Math.floor(Math.random() * 9000);
  }

  // Opportunistic cleanup so a public relay's storage stays bounded. Runs at most
  // once a minute (guarded by a stored timestamp) and only off write paths
  // (create/quick), never on the hot poll loop. Drops lobbies idle for > 30 min.
  async maybeSweep() {
    const now = Date.now();
    const last = (await this.storage.get("lastSweep")) || 0;
    if (now - last < 60000) return;
    await this.storage.put("lastSweep", now);
    const all = await this.storage.list({ prefix: "l:" });
    for (const [key, lobby] of all) {
      if (lobby && lobby.t && now - lobby.t > 30 * 60000) {
        await this.storage.delete(key);
      }
    }
  }
}

function clampInt(v, dflt, lo, hi) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function nowSeq() {
  // Monotonic-ish tag for debugging; not used for logic.
  return Date.now();
}

/* ─────────────────────────── PNG encoder ───────────────────────────
 * Emits an 8-bit grayscale PNG of exactly W x H black pixels. Data is all
 * zeros, wrapped in zlib "stored" (uncompressed) deflate blocks — no real
 * compression needed. The client only cares about the dimensions.
 */
function png(w, h) {
  w = Math.max(1, Math.min(w | 0, 8000));
  h = Math.max(1, Math.min(h | 0, 8000));

  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = u32(w).concat(u32(h), [8, 0, 0, 0, 0]); // 8-bit, grayscale

  // Raw scanlines: each row = 1 filter byte (0) + W pixel bytes (0). All zeros.
  const rawLen = h * (1 + w);

  // zlib stream: header + stored deflate blocks + adler32.
  const zlib = [0x78, 0x01];
  let off = 0;
  do {
    const blockLen = Math.min(65535, rawLen - off);
    const final = off + blockLen >= rawLen ? 1 : 0;
    zlib.push(final, blockLen & 255, (blockLen >> 8) & 255,
      ~blockLen & 255, (~blockLen >> 8) & 255);
    for (let i = 0; i < blockLen; i++) zlib.push(0);
    off += blockLen;
  } while (off < rawLen);
  zlib.push(...u32(adler32Zeros(rawLen)));

  const bytes = sig
    .concat(chunk("IHDR", ihdr))
    .concat(chunk("IDAT", zlib))
    .concat(chunk("IEND", []));

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/png",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      "access-control-allow-origin": "*",
    },
  });
}

function u32(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function chunk(type, data) {
  const t = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
  const body = t.concat(data);
  return u32(data.length).concat(body, u32(crc32(body)));
}

// Adler32 of an all-zeros buffer of length n. a stays 1; b = (n * 1) mod 65521.
function adler32Zeros(n) {
  const MOD = 65521;
  const a = 1;
  const b = ((n % MOD) * 1) % MOD; // each step adds a(=1)
  return ((b << 16) | a) >>> 0;
}

let CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
