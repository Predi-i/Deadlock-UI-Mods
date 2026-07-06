# Deadlock Minigames

Online mini-games played inside Deadlock's pause (Esc) menu. Ships with **online
Checkers** (Russian draughts rules); Tic-Tac-Toe and Durak are stubbed in the picker
for later.

Three ways to play:

- **Quick Match** — public matchmaking: the server pairs you with anyone else online
  who pressed Quick Match. No code needed.
- **Create Game / Join** — private match with a friend: one player clicks **Create Game**
  and reads out the 4-digit code, the other clicks **Join** and types it in.
- **Play vs Bot** — offline, no server.

Many pairs can play at once — each match is its own lobby, so the mod scales to lots of
simultaneous 1-on-1 games.

## How it talks to a server without networking APIs

Panorama UI has no `fetch`, no `$.AsyncWebRequest`, no websockets, and `<HTML>` panels
can't reach external sites. The one channel that works: set an `<Image>` src (data goes
out in the URL) and read the returned image's **pixel dimensions** back
(`actuallayoutwidth` / `actuallayoutheight`). The server answers every request with a
tiny PNG whose width × height encode two integers. See `server/README.md` for the full
protocol and `panorama/scripts/mg_net.js` for the client facade.

## Files

```
server/                     Cloudflare Worker (the relay) + deploy guide
  worker.js                 lobby store + PNG responder
  wrangler.jsonc
  README.md                 ← deploy steps + protocol reference
panorama/
  layout/base_hud.xml       override that loads the scripts + styles
  styles/mg.css
  scripts/
    mg_net.js               image side-channel transport ($.MG.Net / $.MG.Api)
    mg_games.js             checkers engine + rendering ($.MG.Games)
    mg_ui.js                escape-menu button + lobby overlay ($.MG.UI)
```

## Setup

1. **Deploy the server** — follow `server/README.md` (≈3 min, free Cloudflare plan).
   Re-run `npx wrangler deploy` after any `server/worker.js` change (e.g. new routes).
2. **Point the client at it** — paste your `workers.dev` URL into `BASE_URL` at the top
   of `panorama/scripts/mg_net.js`.
3. **Build the VPK** and launch. Press **Esc** in a match → **Minigames**.

> Until `BASE_URL` is set, the overlay opens but shows a "server not configured" warning.

## Tests

```
node tools/mg_rules_test.js     # checkers rules (captures, flying kings, full bot game)
node tools/mg_server_test.js    # worker: matchmaking, code round-trip, concurrent lobbies
```

`tools/` and `server/` are dev-only — only `panorama/` is packed into the VPK.

## Networking note

The image side-channel decodes integers from an `<Image>`'s pixel size, so it depends
on the UI scale. The client calibrates from a large `/api/probe` image (600×1000) which
makes the scale precise enough that small values (lobby codes, board squares) decode
exactly on 1080p and up. To debug reads in-engine, flip `DEBUG = true` in `mg_net.js`.
