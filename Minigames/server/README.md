# Deadlock Minigames — relay server (Cloudflare Workers)

This is the tiny backend that lets two Deadlock clients talk to each other.
It stores lobby state and answers every request with a **PNG image whose width ×
height encode the response** — because Panorama UI can only read data back through
an image's pixel size (no fetch, no websockets).

The whole thing runs on the **free** Cloudflare Workers plan (Durable Objects with
the SQLite backend are included for free).

---

## One-time deploy (≈3 minutes)

You need Node.js installed.

```bash
# 0. Build the deploy artifact (server/worker.js) from its sources. This concatenates
#    the SHARED rule engines (panorama/scripts/rules/*.js — the exact files the client
#    runs) in front of the authored core (server/worker.core.js), so the server validates
#    every move with byte-for-byte the same rules the client predicts with. Re-run this
#    whenever you edit worker.core.js OR any rules/*.js file.
node tools/build_worker.js

cd Minigames/server

# 1. Log in to Cloudflare (opens a browser). Free account is fine.
npx wrangler login

# 2. Deploy.
npx wrangler deploy
```

> **Sources vs artifact.** Edit `server/worker.core.js` (the relay + PNG encoder) and
> `panorama/scripts/rules/*.js` (the shared game rules). `server/worker.js` is a
> GENERATED file (it carries a "DO NOT EDIT" banner) — never hand-edit it; run the build.


After deploy, wrangler prints your URL, e.g.:

```
https://deadlock-minigames.<your-subdomain>.workers.dev
```

**Copy that URL.** Then open `Minigames/panorama/scripts/mg_net.js` and paste it into
the `BASE_URL` constant at the top:

```js
var BASE_URL = "https://deadlock-minigames.YOURNAME.workers.dev";
```

That's it. Redeploys later are just `npx wrangler deploy` again.

---

## Verify it works (in a normal browser)

- `<URL>/api/probe` → a **600×1000** pixel PNG (the client uses it to calibrate swap+scale).
- `<URL>/api/create?game=1` → a small PNG like **45×92** — that encodes lobby code
  `4591` (`width*100 + (height-1)` = `45*100 + 91`).
- `<URL>/api/status?code=4591` → **1×1** (1 player so far).

If you can see those images with the right dimensions, the server is good.

---

## Protocol reference

All routes are GET, all return a PNG. Always append `&rnd=<random>` to defeat the
engine's image cache. Responses are read as `(width, height)`:

Every online route now carries a per-seat **token** (`&tok=<tok>`) that flows only
upward (in the query) and never in a response, so the server can bind each seat to a
caller and reject spoofed actions. See §5.1 of `ARCHITECTURE.md`.

### Full-information games (checkers 1, tic-tac-toe 2, chess 4, connect four 5)

| Route | Response `(w, h)` |
|---|---|
| `/api/probe` | `(600, 1000)` — used once on startup to detect swap + UI scale factor |
| `/api/create?game=G&tok=T` | `(CODE_HI, CODE_LO+1)` — new lobby; caller is host / seat 0 |
| `/api/quick?game=G&tok=T` | JOINER `(CODE_HI, CODE_LO+1)` · HOST `(CODE_HI+100, CODE_LO+1)` |
| `/api/join?code=C&tok=T` | `(G, 1)` joined · `(20, 1)` not found · `(21, 1)` full |
| `/api/status?code=C` | `(players, 1)` · `(9, 1)` gone — host polls until players == 2 |
| `/api/move?code=C&from=F&to=T&end=E&tok=T` | `(1,1)` ok · `(9,1)` not-your-turn · `(9,2)` illegal · `(9,3)` bad-token · `(9,9)` gone |
| `/api/poll?code=C&since=S` | `(from+1 [+100 if end], to+1)` · `(1, 1)` nothing new |
| `/api/reset?code=C&game=G&tok=T` | `(1, 1)` · `(9,3)` bad-token — restart the same lobby |

- **Connect four** encodes a column drop as `from = col (0..6)`, `to = COL_MARKER = 7`;
  the server computes the landing row, validates the column isn't full, and stores it.
  `from != to` always holds, so `(1,1)` stays a safe "nothing new" marker.
- The **server is authoritative**: `/api/move` runs the shared rules engine
  (`rules/*.js`, the same bytes the client predicts with) and only appends a *validated*
  move to the log. A cheat's illegal move returns `(9,x)` and never reaches the opponent.

### Durak (game 3) — authoritative dealer + private deal

Durak doesn't fit "a move is two ints" (it has hidden hands), so the worker OWNS the
deck/hands/seed and uses a **separate route set**. Clients rebuild the table, trump,
turn, roles and every player's card *count* from a public event log, and learn only
their OWN card identities from a private per-seat channel. **2 players only for now.**

| Route | Response `(w, h)` |
|---|---|
| `/api/room?code=C` | `(players, started?2:1)` · `(9, 1)` gone |
| `/api/start?code=C&tok=T` | host seat 0 deals: `(1,1)` ok · `(9,1)` not-host · `(9,2)` too-few-players · `(9,3)` bad-token |
| `/api/dact?code=C&tok=T&a=A&p=P&c=CARD` | `(1,1)` ok · `(9,1)` not-your-role/turn · `(9,2)` illegal · `(9,3)` bad-token · `(9,9)` gone |
| `/api/dlog?code=C&since=S` | next public event (see table) · `(1, 1)` nothing new |
| `/api/ddraw?code=C&tok=T&i=I` | `(card+2, 1)` my i-th private card · `(1,1)` none yet · `(9,3)` not my seat |

`dact` action codes: `a = 1` attack/throw-in (with `c`), `2` cover pair `p` (with `c`),
`3` take, `4` bito (beat). Public event encoding (both dims ≤ ~63, none is `(1,1)`):

| Event | `w` | `h` |
|---|---|---|
| TRUMP | `2` | `trumpCard+1` |
| OPEN (first attacker seat s) | `3` | `s+1` |
| PLAY seat s, card c | `10+s` | `c+1` |
| COVER pair p, card c | `20+p` | `c+1` |
| TAKE seat s | `30+s` | `1` |
| BITO | `40` | `1` |
| DRAW seat s, count n | `50+s` | `n+1` |
| OVER loser L | `60` | `L+2` (`1`=draw) |

Private cards use `card+2` (2..37), **not** `card+1`, so card id 0 never collides with
the universal `(1,1)` "nothing new". `ddraw` is gated by the seat token — a caller can
only read its OWN seat's private cards (a foreign token → `(9,3)`), which closes the
"read a neighbour's hand" hole.

- Image dimensions are always ≥ 1, so 0 can never be read back — every sentinel is non-zero.
- `CODE = CODE_HI*100 + CODE_LO` (4-digit). Client decodes `width*100 + (height-1)`.
- Squares are `0..63` (full 8×8 grid). The client polls with `since = last applied seq`;
  the returned move/event is implicitly `seq = since+1`, so seq is not echoed.
- `END = 1` means "turn passes to the other player" (multi-jumps send `END=0` per hop).
- Every dimension stays ≤ ~128 px, so each returned image is only a few hundred bytes.


---

## Data & limits

- Lobbies live in one Durable Object. They are not garbage-collected yet; codes are
  reused only when free. For a small friend group this is irrelevant. (A TTL sweep
  can be added later if needed.)
- Free plan: 100k requests/day. Polling every ~1.5s uses ~2.4k requests/hour per
  active pair — comfortably within free limits.
