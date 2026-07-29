# Deadlock Minigames

Online mini-games played inside Deadlock's pause (Esc) menu. **Checkers** (Russian
draughts), **Tic-Tac-Toe**, **Chess** and **Connect Four** support online play and bots.
**Durak** and **Poker** support 2–4-player bot games and private online tables backed by
an authoritative dealer; full private tables auto-start, while public Durak matchmaking
remains heads-up. **Pixel Battle** is
a persistent shared canvas, while **Wordle** is fully offline.

Four ways to play:

- **Quick Match** — public matchmaking: the server pairs you with anyone else online
  who pressed Quick Match. No code needed.
- **Quick Match → Select Multiple** — tick several eligible games at once; the server pairs
  you with anyone whose ticked set overlaps yours and fixes the shared lobby to a matched
  game. Durak participates as a heads-up-only option and auto-starts after matching; Poker
  remains private-table only.
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
npm install       # once — ESLint only
npm run lint      # no-undef net over every shipped script + the worker source
npm test          # the whole harness suite: pure rules for all six games, the worker
                  # protocol, client/server rule parity, and a staleness check on the
                  # generated server/worker.js
```

`tools/` and `server/` are dev-only — only `panorama/` is packed into the VPK. A Public build
goes through `../tools/build_mod_strip_comments.ps1`, which ships the VPK without comments
(the working tree keeps them).

## Networking note

The image side-channel decodes integers from an `<Image>`'s pixel size, so it depends
on the UI scale. The client calibrates from a large `/api/probe` image (600×1000) which
makes the scale precise enough that small values (lobby codes, board squares) decode
exactly on 1080p and up. To debug reads in-engine, flip `DEBUG = true` in `mg_net.js`.
