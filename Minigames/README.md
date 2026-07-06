# Deadlock Minigames

Online mini-games played inside Deadlock's pause (Esc) menu. Ships with **online
Checkers** (Шашки); Tic-tac-toe and Durak are stubbed in the picker for later.

Two players connect with a short lobby code: one clicks **Создать игру** and reads out
a 4-digit code, the other clicks **Присоединиться** and types it in.

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
2. **Point the client at it** — paste your `workers.dev` URL into `BASE_URL` at the top
   of `panorama/scripts/mg_net.js`.
3. **Build the VPK** and launch. Press **Esc** in a match → **Мини-игры**.

> Until `BASE_URL` is set, the overlay opens but shows a "сервер не настроен" warning.

## Status

- Server, transport, and the full checkers rules engine are unit-tested locally
  (PNG validity, protocol round-trips, captures / promotion / multi-jump / forced
  capture). **In-engine behaviour is not yet verified** — the escape-menu injection
  point and image-size reads need a real game to confirm.
