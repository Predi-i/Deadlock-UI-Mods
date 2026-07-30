#!/usr/bin/env node
"use strict";

const origin = String(process.argv[2] || "https://178.236.246.13").replace(/\/+$/, "");
let nonce = Date.now();
const hostToken = "liveGeoHost" + nonce;
const joinToken = "liveGeoJoin" + nonce;
const soloToken = "liveGeoSolo" + nonce;
let lobbyCode = "";
let soloCode = "";

async function get(path, query) {
  const url = new URL(path + ".png", origin);
  for (const [key, value] of Object.entries({ ...query, rnd: nonce++ })) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(path + " returned HTTP " + response.status);
  return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
}

function levels(result, name) {
  const bytes = result.bytes;
  if (bytes.length < 24 || bytes[0] !== 137 || bytes[1] !== 80) {
    throw new Error(name + " did not return a PNG protocol message");
  }
  const physicalWidth = (bytes[16] * 16777216 + bytes[17] * 65536 +
    bytes[18] * 256 + bytes[19]) >>> 0;
  const physicalHeight = (bytes[20] * 16777216 + bytes[21] * 65536 +
    bytes[22] * 256 + bytes[23]) >>> 0;
  if ((physicalWidth - 15) % 9 || (physicalHeight - 15) % 9) {
    throw new Error(name + " returned invalid dimensions " +
      physicalWidth + "x" + physicalHeight);
  }
  return { w: (physicalWidth - 15) / 9, h: (physicalHeight - 15) / 9 };
}

async function main() {
try {
  const created = levels(await get("/api/create", { game: 9, tok: hostToken }), "create");
  if (created.w < 24 || created.w > 39) throw new Error("unexpected create role band");
  lobbyCode = String((created.w - 24) * 64 + created.h).padStart(4, "0");

  const joined = levels(await get("/api/join", { code: lobbyCode, tok: joinToken }), "join");
  if (joined.w !== 9) throw new Error("join resolved game " + joined.w + ", expected 9");

  const initial = levels(await get("/api/geostate", {
    code: lobbyCode, tok: hostToken
  }), "initial state");
  if (initial.w !== 1 || initial.h !== 1) throw new Error("unexpected initial Geo state");

  const panorama = await get("/api/geoview", {
    code: lobbyCode, tok: hostToken, round: 0
  });
  const panoramaType = panorama.response.headers.get("content-type") || "";
  if (!/^image\/(jpeg|png)/.test(panoramaType) || panorama.bytes.length < 10000) {
    throw new Error("invalid panorama payload: " + panoramaType + ", " +
      panorama.bytes.length + " bytes");
  }

  const hostGuess = levels(await get("/api/geoguess", {
    code: lobbyCode, tok: hostToken, cell: 0
  }), "host guess");
  const joinGuess = levels(await get("/api/geoguess", {
    code: lobbyCode, tok: joinToken, cell: 511
  }), "joiner guess");
  if (hostGuess.w !== 1 || joinGuess.w !== 1) throw new Error("a guess was rejected");

  const reveal = levels(await get("/api/geostate", {
    code: lobbyCode, tok: hostToken
  }), "reveal state");
  if (reveal.w !== 1 || reveal.h < 16) throw new Error("reveal gate did not open");

  const target = levels(await get("/api/geotarget", {
    code: lobbyCode, tok: hostToken
  }), "target");
  const score = levels(await get("/api/geoscore", {
    code: lobbyCode, tok: hostToken, seat: 0
  }), "score");
  console.log("LIVE GEO OK code=" + lobbyCode +
    " panorama=" + panoramaType + "/" + panorama.bytes.length +
    " target=" + (target.w - 20) + "," + target.h +
    " hostScore=" + (score.h * 63 + score.w));

  const soloCreated = levels(await get("/api/create", {
    game: 9, tok: soloToken, solo: 1
  }), "solo create");
  soloCode = String((soloCreated.w - 24) * 64 + soloCreated.h).padStart(4, "0");
  const soloInitial = levels(await get("/api/geostate", {
    code: soloCode, tok: soloToken
  }), "solo initial state");
  if (soloInitial.w !== 1 || soloInitial.h !== 1) {
    throw new Error("unexpected initial solo Geo state");
  }
  const soloGuess = levels(await get("/api/geoguess", {
    code: soloCode, tok: soloToken, cell: 256
  }), "solo guess");
  if (soloGuess.w !== 1) throw new Error("solo guess was rejected");
  const soloReveal = levels(await get("/api/geostate", {
    code: soloCode, tok: soloToken
  }), "solo reveal state");
  if (soloReveal.w !== 1 || soloReveal.h !== 28) {
    throw new Error("solo reveal did not open automatically");
  }
  const soloNext = levels(await get("/api/geonext", {
    code: soloCode, tok: soloToken
  }), "solo next");
  const soloRoundTwo = levels(await get("/api/geostate", {
    code: soloCode, tok: soloToken
  }), "solo round 2");
  if (soloNext.w !== 1 || soloRoundTwo.w !== 2 || soloRoundTwo.h !== 1) {
    throw new Error("solo round did not advance automatically");
  }
  console.log("LIVE GEO SOLO OK code=" + soloCode);
} finally {
  if (lobbyCode) {
    try {
      await get("/api/leave", { code: lobbyCode, tok: hostToken });
    } catch (_error) {
      // The live assertion above remains the primary result; a stale smoke lobby expires normally.
    }
  }
  if (soloCode) {
    try {
      await get("/api/leave", { code: soloCode, tok: soloToken });
    } catch (_error) {
      // Same best-effort cleanup as the two-seat smoke lobby.
    }
  }
}
}

main().catch(function (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
