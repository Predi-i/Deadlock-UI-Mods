# Minigames — architecture & Panorama field notes (for AI sessions)

This file is the memory we don't want to lose. It explains **how the mod is wired**,
**why** each non-obvious decision was made, and the **Panorama gotchas** that cost real
debugging time. Read this before touching the code — several "obvious" fixes here are
wrong and are documented as traps below.

Nothing in this mod can be verified by rendering from a shell. Panorama only runs inside
Deadlock, and testing requires a **VPK repack + launch**. So `npm run lint` + `npm test`
(`tools/`) are the only automated safety net; everything visual is
"confirmed in-game by the maintainer" or "unverified, reasoned from the game's own CSS".
When you change layout/animation/input, say honestly which of the two it is.

---

## 1. What this mod is

Online mini-games played **inside Deadlock's pause (Esc) menu**, without leaving the
match. **Checkers** (Russian draughts), **Tic-Tac-Toe**, **Chess** and **Connect Four**
support online play and bots. **Durak** (§8.6) and **Poker** (No-Limit Texas Hold'em,
§8.8) support 2–4-player bot games and private 2–4-seat online tables through the
worker-as-dealer transport; public Durak matchmaking remains heads-up. Those online
dealer paths are built + Node-tested but not yet in-game verified. **Pixel Battle** is
one persistent public canvas backed by the Worker (§8.9). **Wordle** is a fully offline
single-player game (§8.10). **GeoGuesser** is a five-round game for Quick Match, private
rooms or server-backed Play Solo: the VPS owns the targets, guesses, reveal gate and score,
and proxies fixed open-licensed equirectangular panoramas (§8.11).

Shared UI features across the games: a **per-turn countdown timer** (§9.1) in durak / poker /
TTT / Connect Four, **server-authoritative side clocks** (time-control matchmaking) in chess /
checkers, **move history + local review** (chess / checkers), a **Play Again / rematch**
handshake, a header **UI-scale dropdown** (trap 20) and a **volume control** (`mg_sound.js`).


Picker cards show a custom **`.vtex` image** (drawn by the maintainer, compiled from PNG),
drawn by a child `<Image>` via `setFace()` in `renderMenu` (trap 14) — `s2r://panorama/
images/cards/<key>.vtex`. Missing art falls back to a plain dark card.

Ways to play (see `mg_ui.js`):
- **Quick Match** — public matchmaking; server pairs you with anyone else who pressed it.
- **Quick Match → Select Multiple** — one search may offer game ids 1–5 and pairs on set
  intersection. A Durak result always resolves to a two-seat dealer room and auto-starts.
- **Create / Join** — private match via a shared 4-digit code.
- **Play vs Bot** — fully offline, no server, no network calls at all.
- **Play Solo** — GeoGuesser-only authoritative session; the VPS fills the second seat so reveal
  and Next happen immediately after the player's action.

---

## 2. The big constraint: Panorama has no networking

Panorama UI has **no `fetch`, no `$.AsyncWebRequest`, no websockets**, and `<HTML>`
panels can't reach external sites. The **only** channel that gets data back from a server
is the intrinsic pixel size of an `<Image>`:

1. Set an `<Image>` `src` — request data rides out in the URL query string (unlimited).
2. The server answers with a tiny PNG whose **width × height encode two integers**.
3. Read them back via `img.actuallayoutwidth` / `img.actuallayoutheight`.

This is the whole transport, and its **asymmetry** is the key: the **uplink (URL query) is
unlimited**, the **downlink (2 ints) is tiny**. That's what lets the server be
**authoritative** — a seat-identifying token and full move data ride up freely, while the
answer stays two small numbers (accept, or a `(9,x)` rejection code). The client keeps a
local rules engine as an **instant-feedback predictor**, but the **server owns the board
and validates every move** (§5.1). Full protocol lives in `server/worker.js`'s header and §5.

> **Single source of rules.** The pure engines live in `panorama/scripts/rules/*.js`. The
> client `<include>`s them; `tools/build_worker.js` concatenates the SAME bytes into the
> deployed `server/worker.js`. So predictor and authority can't drift — `mg_parity_test.js`
> proves it. Edit `rules/*.js` or `server/worker.core.js`, never the generated `worker.js`.

---

## 3. File map & load order

```
panorama/
  layout/base_hud.xml      HUD override; <include>s the scripts + styles. LOAD ORDER MATTERS (actual
                           include order): mg_net → mg_sound → rules/* (checkers, ttt, chess,
                           connectfour, durak, poker) → mg_games ($.MG.Games + $.MG.Widgets) →
                           mg_checkers → mg_ttt → mg_chess → mg_durak → mg_connectfour → mg_poker
                           → mg_pixelbattle → mg_wordle → mg_geoguesser → mg_ui. Rule modules load before the controllers that alias them;
                           mg_wordle_words.generated loads immediately before mg_wordle;
                           mg_games loads before the per-game controllers (they need MG.Widgets +
                           MG.Games); mg_ui loads last (it drives all views).
  styles/mg.css            all styling. Note the Panorama-specific idioms (§6).
  scripts/
    mg_net.js              image side-channel transport + typed protocol ($.MG.Net, $.MG.Api, $.MG.Session)
    mg_sound.js            $.MG.Sound facade: play(name) + volume/mute. Names: MoveSelf/MoveOpp,
                           Check, Promote, Illegal, Premove, GameStart, TenSeconds (§9.2).
    rules/checkers.js      SHARED pure checkers engine (client predictor + server authority)
    rules/ttt.js           SHARED pure tic-tac-toe engine
    rules/chess.js         SHARED pure chess engine
    rules/connectfour.js   SHARED pure connect-four engine
    rules/durak.js         SHARED pure durak engine (offline bot + online dealer)
    rules/poker.js         SHARED pure No-Limit Hold'em engine (offline bot + online dealer)
    mg_games.js            SHARED INFRASTRUCTURE ONLY: createClock (two-side game clock, used by
                           checkers + chess), createTurnTimer (per-turn countdown, used by ttt +
                           durak + poker + c4), createStub (placeholder), MG.Games registry, and
                           MG.Widgets exports. No game controllers live here any more.
    mg_checkers.js         Checkers CONTROLLER (render, input, net); self-registers game id 1.
    mg_ttt.js              Tic-Tac-Toe CONTROLLER; self-registers game id 2.
    mg_chess.js            Chess CONTROLLER; self-registers game id 4.
    mg_connectfour.js      Connect Four CONTROLLER; self-registers game id 5 (§8.7).
    mg_durak.js            Durak CONTROLLER (render + click/drag + bot + online); self-registers game id 3.
    mg_poker.js            Poker CONTROLLER (render + betting UI + bot + online); self-registers game id 6 (§8.8).
    mg_pixelbattle_palette.generated.js
                            Generated paint + terrain swatches; built from the shared JSON source.
    mg_pixelbattle.js       Persistent Pixel Battle controller (zoom/editor/batching/sync);
                            self-registers game id 7 (§8.9).
    mg_wordle_words.generated.js
                            Offline five-letter answer/guess dictionaries generated from the
                            pinned MIT-licensed ayaanhossain/weldor wordbase.
    mg_wordle.js            Offline Wordle controller + pure duplicate-letter scoring;
                            self-registers game id 8 (§8.10), never touches the Worker.
    mg_geoguesser.js        Five-round online panorama/map controller; native sliders update
                            heading/pitch continuously and image drag applies on release;
                            self-registers game id 9 (§8.11).
    mg_ui.js               Esc-menu button injection + full-screen lobby overlay ($.MG.UI); header
                           UI-scale + volume dropdowns; seat/time-control/variant pickers.

server/                    Authoritative backend sources + Node/SQLite VPS runtime
  admin_panel.js           Browser admin HTML/CSS/JS assets (no credentials; GitHub-authenticated).
  worker.core.js           AUTHORED relay + validators + PNG encoder (edit this)
  worker.js                GENERATED (rules/*.js + worker.core.js via tools/build_worker.js) — deploy artifact
  node_server.js           Node HTTP adapter; serialized Hub execution + trusted client-IP injection
  node_storage.js          Durable-Object-compatible SQLite storage adapter
  package.json             ESM boundary + production Node version requirement
  deploy/                  systemd, Nginx, backup, TLS-renewal and host-hardening configuration
  wrangler.jsonc, README.md
tools/                     dev-only Node test harnesses + build helpers (NOT packed)
  build_worker.js          concatenate the 6 rules/*.js + worker.core.js → server/worker.js
                           (`--check` verifies the committed worker.js is in sync; first step of `npm test`)
  mg_geo_live_smoke.js     disposable two-seat production GeoGuesser smoke over HTTPS
  build_geoguesser_map.js  rasterize the dedicated Natural Earth country map
  build_ne_raster.js       one-off: downsample Natural Earth II's natural-colour GeoTIFF into
                           the committed assets/ne2_natural_2048.png the map builder samples
  build_pixelbattle_map.js generate the Pixel Battle land mask from the source map image
  build_wordle_words.js    generate the Wordle answer + guess word lists
  gen_soundevents.js       generate the soundevents manifest consumed by mg_sound.js
  svg_to_deck.py           compile card SVGs → the deck/<S><R> art
  mg_rules_test.js         checkers rules: captures, flying kings, draws, full bot game
  mg_wordle_test.js        Wordle duplicate-letter scoring.
  mg_chess_test.js         chess rules: perft, castling, en passant, promotion, mate/stalemate
  mg_connectfour_test.js   connect-four rules + bot
  mg_durak_test.js         durak rules: deal, beats(), throw-in legality, 120 full bot games
  mg_poker_test.js         poker rules: hand ranking, betting rounds, showdown, bot
  mg_server_test.js        worker: matchmaking, seat tokens, per-move validation, concurrent lobbies
  mg_parity_test.js        client predictor vs server authority give identical legal moves
  mg_pixelbattle_palette_test.js  palette distance sanity
  mg_update_marker_test.js        update-marker image decoding
  mg_simulate_resolutions.js      side-channel decode across 720p–8K
  es6_codemod.js           one-shot: var -> const/let, and WHY each survivor stayed (§10.2)
  es6_arrows.js            one-shot: anonymous callbacks -> arrows, same reporting
  es6_templates.js         one-shot: concat -> template literals; only when the LEFTMOST
                           operand is a string literal (else the first `+` may be arithmetic)
  mg_es6_codemod_test.js   codemod safety fixtures: scope/TDZ/loop-capture hazards
  mg_es6_arrows_test.js    arrow safety fixtures: this/arguments/new + the leading-paren ASI rule
  mg_es6_templates_test.js template fixtures: arithmetic-vs-concat `+`, escaping, no reflow
  mg_es6_invariants_test.js STANDING guard on the shipped tree (§10.2), self-tested
  mg_load_smoke_test.js    evaluates all 23 shipped scripts under a fake $, checks registration
```

A Public (non-dev) build ships without comments. That is NOT a step in this repo: run
`tools/build_mod_strip_comments.ps1` (or the .bat) from the **Deadlock-UI-Mods** root — it copies
the mod to a `<Mod>-stripped` staging folder, strips comments from the copy, re-parses every
stripped .js and aborts if any of them broke, then hands the copy to `build_mod.ps1`. The working
tree is never modified. It replaced `Minigames/tools/strip_comments.js`, which had to be pointed
at an already-built tree by hand and silently corrupted a regex literal following a keyword.

The `<include>` order in `base_hud.xml` is net → **rules/checkers, rules/ttt, rules/chess**
→ games → durak → ui: the shared engines must populate `$.MG.Rules` before the controllers
alias them.

**Game registry.** `$.MG.Games` (defined at the bottom of `mg_games.js`) is a small
registry: `list` drives the picker, `register({id, create, enabled?})` attaches a mount
factory (and can flip a game's `enabled`), and `mount` dispatches to it (falling back to
the stub). This is why a new game can live in **its own file** — `mg_durak.js` just calls
`MG.Games.register(...)` after `mg_games.js` has loaded; no edit to the dispatch. The
`<include>` order in `base_hud.xml` is therefore net → rules/* → games → **durak** → ui.

Everything shared between the scripts hangs off **`$.MG`** — `$` is the single
object shared across all scripts loaded in the same panel context. Each script guards with
`if (MG.X) return;` so a double-include is a no-op.

`BASE_URL` at the top of `mg_net.js` must point at the deployed backend. Production is the
direct Aéza VPS endpoint `https://178.236.246.13`; no Cloudflare Worker or proxy is in the
request path. Until `BASE_URL` is set, the overlay opens but shows "server not configured".

**Production hosting (2026-07-30 migration).** Nginx terminates HTTPS directly on the public
IPv4 and proxies to one Node 24 process bound to `127.0.0.1:8787`. Let’s Encrypt's short-lived
IP certificate is renewed automatically by a twice-daily systemd timer. `node_server.js` calls
the same generated Worker entry point and presents one serialized local `HUB`, preserving the
single-consistency-domain behaviour of the old Durable Object. `node_storage.js` persists its
values in a WAL-mode SQLite database using V8 structured serialization, including typed Pixel
Battle tiles. Daily online SQLite backups are compressed and retained for 14 days. See
`server/README.md` for paths, units, smoke checks and recovery commands.
Nginx overwrites `X-Real-IP`; the loopback-bound Node adapter accepts that header only from its
local proxy and replaces `CF-Connecting-IP`, so IP rate limits see the actual public client.

---

## 4. Runtime architecture (where things live)

The mod loads through **`base_hud.xml`**, so all its panels live in the **HUD panel
context**, NOT inside the native Esc-menu's XML context. This one fact drives several
bugs and their fixes:

- **`mg.css` is loaded by `base_hud.xml`.** Panels created under the native `#EscapeMenu`
  (a different XML context) would render **unstyled**. So the overlay is built under
  `$.GetContextPanel()` (our HUD context), NOT under the escape menu. See `buildOverlay()`.

- **The overlay is separate from the Esc menu**, which means:
  - Closing the Esc menu does NOT auto-destroy our overlay. We **poll** the menu's open
    state (`watchEscape()` every 0.3s) and tear the overlay down when the menu is gone.
    (Bug #3 from the maintainer: "the panel doesn't close when the esc-menu closes".)
  - The menu's `#EscapeBackground` is a full-screen click-catcher whose `onactivate` calls
    `CitadelResumePlaying()`. A misclick over the game area used to close the whole menu.
    Fix: `setEscapeBackgroundActive(false)` disables its hit-testing while our modal is up,
    restored on hide. (Bug #2: "almost hit the button — the menu closed".)
  - Our backdrop (`#MG_Dim`) has a **no-op `onactivate`** so a click on it is explicitly
    consumed and can't fall through to `#EscapeBackground`.

- **The Esc-menu button** is injected by polling for the menu's anchor (`SubOptions`, else
  `Menu`) every 1.5s and appending a `nav_menu_item`-styled button (`ensureEscapeButton`).
  The menu is created lazily, so a one-shot inject would usually miss it.

---

## 5. The network protocol (mg_net.js ↔ worker.js)

All routes are GET and all protocol replies return a PNG. `/api/geoview` is the one payload
exception: it returns the proxied JPEG/PNG panorama itself. All client requests take
`&rnd=<random>` to defeat engine caching. Client appends `.png` to every path (Panorama's
loader only fetches URLs that look like images; the worker strips `.png` before routing).

**Downlink is level-quantised (2026-07-20 rewrite).** Every DATA response carries a small
*level* per dimension, not a raw pixel: `dim = level*STEP + BASE` (`STEP=9, BASE=15`). The old
`dim = int+1` scheme died on UI-scaled displays (the engine biases a small size up ~1px, so
value 1 rendered as 2 — corrupting corner squares, `(1,1)`, and code halves). The `(w, h)`
pairs in the table are those **levels** (what the client decodes back), safe range `0..63` per
dim. Only `/api/probe` stays **literal pixels** — it's the calibration reference, read raw.

| Route | Response (w, h) LEVELS |
|---|---|
| `/api/probe` | `(600, 1000)` LITERAL px — swap + scale calibration reference |
| `/api/ping` | `(1, 1)` |
| `/api/create?game=G&tok=T&tc=..&cv=..&solo=1` | `dCode(code, host=false)` — new private lobby; `solo=1` fills GeoGuesser seat 1 on the server |
| `/api/quick?game=G&tok=T&tc=..&cv=..` | `dCode(code, HOST\|JOINER)` — role is the code **band**, not `+100` |
| `/api/cancel?code=C` | `(1,1)` |
| `/api/join?code=C&tok=T` | `(G, tcIndex+1)` ok · `(20,1)` missing · `(21,1)` full · `(9,3)` bad-token |
| `/api/match?code=C` | `(game, tcIndex*2+variantBit+1)` — resolved game/bank/checkers-variant · `(9,1)` gone/undecided |
| `/api/status?code=C&tok=T` | `(players, game+1)` · `(9,1)` gone |
| `/api/move?code=C&from=F&to=T&end=E&tok=T` | `(1,1)` ok · `(9,1)` not-your-turn · `(9,2)` illegal · `(9,3)` bad-token · `(9,9)` gone |
| `/api/poll?code=C&since=S` | `(from, to)` RAW squares 0..63 · `(1,1)` nothing new |
| `/api/reset?code=C&game=G&tok=T` | `(1,1)` · `(9,3)` bad-token |
| `/api/clocks?code=C&seat=S` | `(30 + sec>>6, sec&63)` one seat · `(9,9)` gone · `(9,8)` untimed |
| `/api/pxpick?x=X&y=Y` | `(paletteIndex, 0)` eyedropper · `(2,63)` bad coordinate · `(5,63)` banned — data always sits at `h=0`; an unpainted pixel answers with the ocean/land swatch, and coordinates are validated exactly (no clamping, §8.9) |
| `/api/geostate?code=C&tok=T` | current round + authoritative guess/reveal/ready masks |
| `/api/geoview?code=C&tok=T` | current 2:1 equirectangular image (ordinary JPEG/PNG, not a dimension message) |
| `/api/geoguess?code=C&tok=T&cell=N` | `(1,1)` accepted · `(9,x)` rejected — `cell` is 0..131071 in the 512×256 authoritative grid (the uplink is unlimited, so precision is free here) |
| `/api/geonext?code=C&tok=T` | `(1,1)` ready; advances after both players, or immediately in a solo lobby |
| `/api/geotarget?axis=A`, `/api/geopick?seat=S&axis=A`, `/api/geoscore`, `/api/geoinfo`, `/api/geocredit` | reveal-only target, guesses, totals, place and contributor attribution. `geoinfo` returns a **place code** (`0..5` region only, else `6 + country*6 + continent`) and `geocredit` an **index** into the shipped credit table — one request each, both decoded from two base-63 levels with `h=63` as the error sentinel. **Trap:** a 512×256 point does not fit one downlink reply — two base-63 levels top out at 3968, so each point is read one axis per request (`axis=0` → x, `axis=1` → y) and the client needs 7 reveal reads solo / 10 online |

### 5.1 Server authority (seats, tokens, validation)

> **Two client-side contracts every `MG.Api` wrapper must honour** (both were violated in shipped
> code and fixed 2026-08-01; `mg_release_ui_regression_test.js` mutation-checks all six guards).
>
> 1. **Accept only the exact success reply; everything else trips `suspectDecode`.** `move` was the
>    lone exception — `else cb({ok:true})` read *any* non-9 width as accepted. On a stale UI scale
>    that meant a mis-decoded `(1,1)` still counted as success **and** a genuine `(9,2)` rejection
>    whose width mis-read as 8 or 10 was reported as accepted; since nothing tripped `suspectDecode`,
>    the bad scale was never repaired, so the client kept a prediction the server had refused and the
>    board desynced progressively — the "corrupted moves that eat pieces" failure this section warns
>    about, arriving through the one unguarded door. `rematch` had no guard at all and passed a raw
>    `h-1` to a consumer that restarts the board on `state === 2 || gen > baseGen`, so a corrupt
>    reply restarted one client unilaterally and latched a `gen` the server could never match again
>    (dead Play Again, presenting as "opponent rage-quit").
> 2. **Every terminal path must call `cb` *or* `err` — a bare `return` is a wedge.** Poll loops
>    re-arm only from their own callbacks. Three places broke this: `MG.Net.clearQueue` dropped
>    queued jobs silently (fatal for `MG.Api.clocks`, which issues seat 1 only from inside seat 0's
>    callback, and for GeoGuesser's chained panorama copies — `createClock`'s `resyncTick` is
>    re-armed *only* by its error path, so the clock froze while the server kept counting down and
>    you lost on time with minutes apparently left); and the `(9,9)` handlers in `poll`/`dlog`/`plog`
>    returned without a callback when `kickToMenu` **declined** the kick (it is conditional on
>    `view`), which for Durak/Poker is the table's only event stream — a permanently frozen game.
>    `geoState` had the same bug in `else if (err)` form, where kicking and reporting were mutually
>    exclusive. All now call `err("gone")` unconditionally after attempting the kick.
>
> 3. **Bound each DIMENSION, not just the value you assemble from them.** A level is `0..63` by
>    construction, so `h > 62` (63 is the error sentinel) is already proof of a stale scale.
>    `geoScore` and `geoPointAxis` tested only the assembled number, which leaves a gap whenever
>    the limit sits above `63*63`: `h=64,w=0` assembles to 4032 and `h=65,w=0` to exactly 4095 —
>    both slipped under the old `score > 4095` guard and were shown to the player as a real total.
>    That 4095 was doubly wrong: five rounds cap at 750 each = **3750**, and `floor(4095/63)` is 65,
>    a level that cannot be encoded at all.
> 4. **Decode with the same `±1` the worker encoded with.** `/api/join` sends
>    `d(game, tcIndex + 1)` — the `+1` keeps `h` clear of 0 — but the client read `tcFromIndex(h)`,
>    so every bank shifted one step **for the joiner only**: 60s→180s, 300s→600s, and both ends
>    wrapped across the timed/untimed boundary (an untimed lobby gave the joiner a 60s clock panel;
>    a 600s lobby gave them none). The banks are server-authoritative, so the numbers self-corrected
>    on the first `/api/clocks` resync — what was wrong was whether the clock UI existed at all.
>    `match` always decoded this correctly (`matchTcFromHeight` uses `h - 1`); `join` was the outlier.
>    Not found by the audit agents — surfaced by tabulating the codec end-to-end.
>
> Two coupled calibration rules, same origin:
> - **One owner per retry policy.** `probeOnce` runs `PROBE_ATTEMPTS`, and `drainQueue` retried the
>   same job again, so the two multiplied into `3 × 2 × REQ_TIMEOUT_MS` = **48s** of wedged FIFO
>   before `failCalib`. `request()` won't even enqueue while uncalibrated, so every game poll and
>   clock resync parked in `calibWaiters` for the whole window: an in-game freeze with no status
>   change, then everything erroring at once. The probe now sets `noRetry`.
> - **`isLevelEncodedSize` fails CLOSED.** It returned `false` ("definitely a real image") while
>   uncalibrated — the one answer it cannot justify, since telling a 582px-max level PNG from a
>   host-clamped photograph is exactly what the scale is for. `suspectDecode` clears `calibrated`
>   before re-probing, so the window is reachable in normal play, and in it a `d(6,63)` busy
>   sentinel from `/api/geoview` was accepted as a panorama: GeoGuesser stretched a ~15×582px error
>   PNG across the 2880×1440 stage, camera live, timer running. Returning `true` costs a 1.5s retry
>   on the caller's existing path.

- **Seat token.** Each client mints one random `tok` per online game (`MG.Session.newToken`)
  and sends it up on create/quick/join/move/reset — **never downward**, so it can't leak
  through the 2-int response or be guessed. The server binds the first token it sees on a
  seat; afterwards only that token may act for it. A stranger's token → `(9,3)`.
- **Owned state.** The lobby holds `{ seats:[{tok},{tok}], turn, state }`. `state` is the
  authoritative board, initialised per game (checkers/ttt/chess) from the shared rules.
  Seat 0 = host = white/X/+1 (moves first); seat 1 = joiner.
- **Validation.** `/api/move` runs the shared rules engine: it checks the token → seat, that
  it's that seat's turn (checkers honours an in-progress multi-jump `chainSq`), and that
  `{from,to}` is in the generated legal set (forced capture, self-check, castling, ep — all
  enforced). The **server** computes the `end` flag and appends `{f,t,e}` to `moves`;
  a rejected move never enters the log, so a poller never sees it.
- **Client resync.** On any `(9,x)`, the controller discards its optimistic prediction,
  rebuilds the board from the accepted `moves` log (`replayAccepted`), and resumes polling.
  Honest desyncs self-heal; a cheat's illegal move simply never lands.

Key encoding tricks and **why** (current codec is STEP=9 level-quantisation, 2026-07-20):
- **Level codec, not raw pixels.** Every DATA response dimension is a small *level* 0..63,
  emitted as `dim = level*9 + 15` (`d()` / `STEP=9, BASE=15`). The old `dim = int+1` scheme
  died on UI-scaled displays (the engine biases small sizes up ~1px, so `1` rendered as `2`
  and corrupted corner squares, the `(1,1)` marker and every code half). 9 logical px between
  levels survives a ±2px engine error even when a sub-1080p display downscales. Proven 720p–8K
  by `tools/mg_simulate_resolutions.js`. Only `/api/probe` stays literal pixels (600×1000).
- **Codes rebased to 0..1023** (was 4-digit 1000..9999) so a code half fits one level.
  `dCode` splits `code = hi<<6 | lo`: width = `BAND + hi`, height = `lo`. The width **band**
  encodes the role — joiner/create = 24..39, host = 40..55 — so the fragile `+100` host flag
  is gone. `validCode()` canonicalises the client's decimal code to the int storage key.
- **`end` flag is NOT transmitted.** `from+to+end` is 13 bits > the 12 the codec allows, so
  poll sends only RAW squares `(from,to)` and the client DERIVES `end` by replaying the SAME
  shared rules engine on the SAME board (a mid-chain capture with more jumps keeps the turn;
  else it hands off). Server stays authoritative on move *legality*; `end` is pure segmentation.
- **`from != to` always** in a real move, so `(1,1)` is a safe "nothing new" marker.
- **Sentinel widths** `{1 ok · 9 err · 20 missing · 21 full · 22 started}` are kept clear of
  every band (codes 24..55, clocks 30..39, rooms 1..4/51..54) so a live reply is never misread
  as a sentinel. Hot game loops skip the generic request-frequency limiter because `(9,4)`
  could decode as a bogus move; the distinct-code scan guard returns route-specific non-terminal
  empty/retry/bad-token responses instead of a false lobby-gone.
- **Clocks are per-seat** (a bank is 0..600 = 10 bits, needs both dims): width `30 + (sec>>6)`,
  height `sec&63`; caller passes `&seat=0|1` and reads both. Both clients read the SAME server
  clock, so flag-fall is server-decided with no drift.
- **State is one serialized Hub backed by SQLite** → strongly consistent, no cross-process or
  eventually-consistent cache lag between players. The Node adapter deliberately processes Hub
  requests one at a time, matching the old single Durable Object's ordering.

### Soft abuse controls and lobby lifetime

- There are no automatic IP bans. One IP may touch sixteen distinct lobby codes per minute;
  repeated reads of the same real code remain free. Formation floods retain the wider
  60-requests/10-second burst. On the distinct-code abuse path, hot poll/log routes return
  non-terminal “nothing new”, clocks retry, and cancel/leave remain available for cleanup.
- `status`, `room`, `droom`, and `proom` include the caller's seat token. A valid seated client
  refreshes a waiting lobby timestamp at most once per five minutes, so a real room can wait
  beyond the 30-minute sweep while anonymous code probes cannot pin guessed lobbies.

### Calibration (the subtle part)

Image dimensions come back **multiplied by the UI scale** and possibly **width/height
swapped**. So on boot-ish (lazily; see trap below) the client fetches `/api/probe`
(a known 600×1000), derives `swap`, `scaleX`, `scaleY`, and applies them to every decode.

- Probe is deliberately **large** so the derived scale is precise → small values decode
  without rounding drift.
- **Distortion detector**: Panorama scales the whole UI by ONE uniform factor, so a
  faithful probe gives `scaleX ≈ scaleY`. If they diverge >15%, the probe was clamped to a
  wrong-aspect container (the classic failure: a too-small host clamps the 600×1000 probe
  and latches a bogus scale that corrupts every later decode). Reject & retry.
- **Never fall back to scale=1** on a scaled UI — that decodes garbage: wrong codes,
  phantom players, corrupted moves that eat pieces.
- **`suspectDecode`**: every decode is range-checked against what the protocol can produce.
  An impossible value ⇒ stale scale ⇒ recalibrate (throttled 5s). Each game passes a
  `validate(from,to)` guard (checkers: diagonal; TTT: cell 0..8 + marker `to==9`).

### Request discipline (learned the hard way)

- **One image load at a time.** Panorama's image loader wedges if several `<Image>` loads are
  in flight — pending loads stall at dims 0 until timeout. Dimension-encoded API traffic and
  ordinary remote images (the update marker and Pixel Battle viewport) therefore share the same
  strict FIFO (`reqQueue`, `reqActive`, `MG.Net.loadImage`); polls, actions and asset loads never
  overlap. A successful ordinary load transfers its already-loaded `<Image>` to the caller.
  ⚠ **NEVER hide the loading `<Image>` to stop it flashing.** Tried 2026-08-01 (`opacity: 0`,
  cleared after re-parenting) and it broke **all** image loading: a zero-opacity panel is skipped
  by the engine's loader — the same rule `ensureHost` already documents for the host itself — so
  `actuallayoutwidth` stayed 0 for the full 8s timeout on every request. The engine cheerfully
  logged `Slow image load - … (dimensions 2048x1024, took 27 msec)` while our poll saw nothing,
  the update marker timed out twice on boot, and GeoGuesser sat on "Loading panorama…" forever.
  The whole transport depends on the engine genuinely laying this image out.
  **The corner flash is a CALLER-side ordering bug, and that is where it is fixed**: the panel
  arrives laid out at the source's intrinsic size with no transform, so `SetParent` into the
  visible tree must come **after** the width/height/transform writes, never before. Pixel Battle
  and GeoGuesser both do it in that order now, and `mg_geoguesser_map_test.js` enforces both
  halves (no opacity on the loader; parent last).
- **A started request always runs to completion** (response or 8s timeout). There is
  deliberately **no abort**: a silent abort once left `calibrating` latched true forever,
  deadlocking all networking.
- **Flaky-load retry**: one silent re-queue at the front recovers most stalls. Mitigation,
  not a proven fix (can't verify without in-game runs).
- **The net host panel** (`MG_NetHost`) carrying the request images MUST be on-screen and
  larger than the biggest response (the probe) — a culled/clamped panel makes the engine
  skip the image load or mis-read dims. It renders at 2% opacity so it's invisible.

### 5.2 Request statistics (`/admin/stats`)

The relay counts its own traffic. The page lives at `/admin/stats`, behind the same signed
GitHub session that gates the Pixel Battle admin, and the two link to each other in the header.

**Where the counting happens is the whole design.** Counting inside `Hub` would put a SQLite
write on every `/api/poll` — the hottest route in the mod, about one per player per second. So
`node_server.js` accumulates counters **in memory** and flushes batched deltas every 30s through
the same serialized `hubTail` that lobby writes use (`serialHubTask`), keeping the persistence
ordering guarantee while the hot path stays read-only. `close()` flushes the final partial window,
so a deploy restart doesn't drop up to 30s of counters.

Per hour: totals, per-route counts, HTTP status counts, sentinel counts, summed + peak latency,
response bytes, peak unique IPs. 48 hourly buckets, rolled into daily totals kept 90 days.

- **No IP is ever persisted.** A bounded per-hour `Set` is kept only to size it; only the COUNT
  is stored. That separates "ten players" from "one script in a loop" without putting personal
  data in SQLite or the daily backups.
- **The key space is bounded by construction.** `statsRouteKey` folds any unrecognised path into
  `/api/*`, `/admin/*` or `other`, so a scanner hitting random paths can't mint storage keys.
- **Collection can never fail a request.** `stats.record` runs in a `finally` on every response
  and swallows everything — an exception there would turn a working route into a client error.

⚠ **TRAP — `(w, h)` alone CANNOT identify a sentinel, and classifying on the pair alone
manufactures errors out of normal play.** The downlink is 12 bits, so the protocol reuses the
same small-integer space for real data. Three collisions are reachable in ordinary play:

| Route | Encoder | Collides with |
|---|---|---|
| `/api/join` | `d(game, tcIndex+1)` | GeoGuesser is game 9 → a **successful** join is `(9,1)` |
| `/api/poll` | `d(from, to)` RAW | a legal move 9→1 is `(9,1)` |
| `/api/pdraw` | `d(card+2, 1)` | hole card 18 is `(20,1)` = "lobby missing" |

So `statsSentinelKey(route, w, h)` classifies **per route**, in four modes: `FULL` (width 9 is
unreachable as data), `GAME` (width *is* a game id, so only `h>=6` plus the 20/21/22 formation
widths are unambiguous — a game-9 lobby is untimed and never sends `h>2`), `H63` (only `h=63` is
reserved), and `RAW` (only `(1,1)` and `(9,9)` are safe, both because a real move has
`from != to`). The invariant is that **no real data reply is ever counted as an error**, and
`mg_vps_server_test.js` asserts each collision above directly. Found by re-reading the encoders
after writing the classifier, not by any test — a route-blind version passed the whole suite.

This table is the diagnostic worth watching: it makes the §5.1 failure modes visible per hour
instead of weeks later. Rising `(9,7)` = storage errors, `(9,4)` = the limiter is biting real
players, `(9,3)` = seat-token mismatches.

---

## 6. Panorama gotchas (⚠ TRAPS — several cost hours)

These are the mistakes to NOT repeat. Every one was confirmed against the game's own
`.css`/`.xml` under `G:\GameTracking-Deadlock` or against working code in `D:\GitHub2\QOLLOCK`.

1. **NO `position: absolute`.** Panorama silently ignores it. To overlap two panels, wrap
   them in a parent with **`flow-children: none`** (both children park at the parent's
   top-left and stack) and offset with `margin` / `align` / `transform`. This is exactly
   how the checkers board + pieces overlay are stacked (`.mg-board-wrap`). Confirmed idiom
   in the game (ability buttons, etc.).

2. **`transition` shorthand is NOT parsed for `transform`.** The game uses **longhand**
   everywhere (`transition-property` / `-duration` / `-timing-function`) — 293 longhand vs
   0 shorthand for transform. A shorthand `transition: transform 0.18s` is **silently
   dropped** → pieces snap with no animation. Use longhand only.

3. **Put the transition on the BASE class, not a toggled state class.** A transition
   established in the *same frame* the value changes can be skipped. The game's pattern
   (`element_gun.css`): transition lives on the persistent class, the animated value is
   changed later. So `.mg-piece` carries the transition; moving a piece just reassigns its
   `transform`. Initial deal doesn't animate because a panel's first committed value is its
   baseline (no slide-in from the corner).

4. **`hittest` / `hittestchildren` set at runtime: works for DISABLING input, don't rely on it to
   RE-ENABLE.** Confirmed in-game 2026-07-29: `setEscapeBackgroundActive` turns `hittest` off on
   the native `#EscapeBackground` while our modal is open, and closing the mod via Esc **and** via
   the X both work — so a runtime `SetAttributeString("hittest", "false")` does take effect. What it
   does **not** fix is a panel of ours sitting over the menu and eating hover: the net host still
   swallowed hover on every native setting with `hittest`/`hittestchildren` false at construction
   (Bug #1). That fix had to be structural — **don't have the panel exist over the menu**:
   calibration is lazy (trap 7) and the host is torn down as soon as the request queue drains
   (`releaseHost`). Treat runtime hit-test writes as a blunt on/off for a panel you own, not as a
   way to make an overlapping panel input-transparent.

5. **Scaling a small effect IN PLACE: use `pre-transform-scale2d`, NOT `scale3d` inside
   `transform`.** `transform: translate3d(x,y) scale3d(0.2…)` multiplies the translate offset,
   hurling the panel toward `(0,0)` — that was the captured-checker "flies up-left" artifact.
   `pre-transform-scale2d` applies **before** the translate, so it scales the panel in place.
   It's animatable; add it to the transition list. Game idiom (abilities CSS). **This is for tiny
   local effects only** — hover-lift on picker cards, shrink-fade of a captured checker. ⚠ Do
   **NOT** use it to scale the whole modal (the UI-scale control): as a TRANSFORM-family property it
   runs AFTER layout and stretches the already-rendered texture, so text and `.vtex` art turn to
   blurry bitmap above 100% (the "blurry raster mush" report). The modal uses layout `ui-scale` instead
   — see trap 20.

6. **Fonts lack `✕` and `◯` glyphs.** That's why TTT's X was invisible and O sat
   off-centre. Marks are **drawn with panels**: X = two bars crossed via `rotateZ`, O = a
   bordered circle with a transparent hole (see `drawMark` + `.mg-x-bar` / `.mg-o`).

7. **Do NOT calibrate at boot.** Calibration spawns the on-screen host; with trap 4, that
   host over the idle menu breaks hover until it's torn down. Calibration now runs lazily on
   the first real online request (Create/Join/Quick), which always fires from inside the
   overlay where the dim already covers the menu. Bot games make no requests → no host ever.

8. **Grid layout: explicit rows, not flow-wrap.** An 8×8 built with `flow-children: right`
   + wrap mis-wraps when a border shaves a pixel off the width. Build **8 explicit row
   panels** of 8 cells each (`.mg-board-row`, `flow-children: right`).

9. **A LONE `fill-parent-flow(1.0)` child underfills its row (~28px short).** The flex ratio
   only forces a child to the row's full width when there are **≥ 2** flex children sharing it
   (e.g. CREATE + JOIN each `fill-parent-flow(1.0)` → together they fill). A single such child
   (QUICK MATCH / PLAY VS BOT alone in a `.mg-btn-row`) lays out ~28px short on the right —
   **confirmed in-game** by the maintainer's screenshot. Fix: give a solo full-width button a
   plain `width: 100%` (deterministic, matches the 2-child row's right edge exactly), NOT
   `fill-parent-flow`. Two dead ends that look right but aren't: a negative `margin-right` hack
   to "stretch" it, and assuming one flex child behaves like `width:100%`. See `.mg-btn-solo`.

10. **`width: 100%` flush to the box edge clips a 1px right border — reserve column padding.**
   A right-column child at `width:100%` sits flush against the column's inner edge and Panorama
   shaves the button's 1px right border. Keep `.mg-col-right { padding-right: 5px }` (> 0) so the
   border always has room. This is the recurring "PLAY VS BOT has no right border" bug (point 4);
   `padding-right: 0` reintroduces it.

11. **The native `DropDown` widget drags in the game's base styling — avoid it for skinned popups.**
   `$.CreatePanel("DropDown", …)` + `AddOption` + `SetSelected` is the QOLLOCK Default-Hero recipe
   and it *does* open on click, BUT in our HUD/overlay context it inherits the game's base
   `DropDownMenu` look: a **paper-tile popup texture** (`textures/paper_tile_1k_01_psd.vtex`) that
   clashes with our palette, a **"…" placeholder** instead of the selected value, and it even
   **shoved the header close-X out of place**. QOLLOCK gets away with it because it runs inside
   `#SettingsWindow`, whose own CSS re-skins every `DropDownMenu`. We don't have that scope. Fix:
   build a **custom dropdown** — a button whose label shows the current value + a popup `Panel` list,
   toggled by a **class on the wrapper** (`.mg-scale-open`), the wrapper `flow-children:none` +
   `overflow:noclip` so the list overlaps the body (trap 1), the list `z-index`'d over the body. See
   `buildScaleControl` + `.mg-scale-*`.

12. **Toggle a popup's visibility with a SINGLE-CLASS state on the panel itself.** Two things
   proved unreliable here: (a) inline `panel.style.visibility = "visible"/"collapse"` from JS, and
   (b) a **child-combinator** rule `.mg-scale-open > .mg-scale-menu { visibility: visible }`. The
   robust pattern is a same-element class the CSS keys off: `.mg-scale-menu { visibility: collapse }`
   + `.mg-scale-menu.mg-open { visibility: visible }`, and JS just `AddClass/RemoveClass("mg-open")`
   on the menu panel. Same idiom the game uses (`ShowEscapeMenu`, `DropDownMenuVisible`).

12b. **A `fill-parent-flow(1.0)` left cluster pushes right-aligned siblings off the edge.**
   The header's left cluster (title + credit + support) had `width: fill-parent-flow(1.0)`, which
   ate the ENTIRE row — the scale control and the close X flowed past the modal's right edge and
   the X got clipped away (leaving only the dropdown visible where the X should be). Fix: make the
   left cluster `width: fit-children` and add a separate flexible `.mg-header-spacer`
   (`fill-parent-flow(1.0)`) between it and the right controls — exactly how the footer's
   status+spacer+tools row works. Then fixed-width right controls always stay on-screen.
   The waiting-room title is the widest state, so `setTitle` additionally applies
   `.mg-credit-hidden` to `by Predi_i` only while `view === "waiting"`; Support and Discord remain,
   and every other view restores the credit.


13. **A raw option/badge panel with no CSS parks at its parent's top-left and shows always.**
   An un-styled `.mg-card-tick` (a Label "x") on a `flow-children:none` card sat as a **stray cross
   at every card's top-left, in every mode** — it had no rule to hide/position it. Two lessons: any
   decorative child on a `flow:none` parent needs explicit `align` + a default `visibility:collapse`
   until it's meant to show; and prefer skinning the parent (`.mg-ticked` accent) over adding a
   separate badge the maintainer didn't ask for.

14. **A fixed-size texture must be drawn by an `<Image>` panel, NOT `Panel` + `background-image`.**
   A `<Panel>` with `style.backgroundImage` paints the `.vtex` at its NATIVE pixel size until the
   panel is next re-laid-out. A `.vtex` isn't decoded on the first layout pass, so a card face PNG
   367×512 in a 100×140 box, or a 250² chess sprite in a 56px box, reads as a ~300% zoom that only
   "snaps right" on hover (hover = restyle = relayout). This hit the trump card, picker cards,
   "scattered opponent backs" and chess pieces at once. **`background-size` does NOT fix it** — any
   value (`100% 100%`, `cover`, `contain`) is still a Panel background and still blows up on frame 1;
   an earlier revision of this trap claimed `100% 100%` worked, and it did not. **Fix: a child
   `<Image>` panel** created with `{ scaling: "stretch-to-fit-preserve-aspect" }`, sized to its CSS
   box (`.mg-face-img { width:100%; height:100% }`), image set via `img.SetImage("s2r://…")` (the
   BARE url, never a `url('…')` wrapper). An `<Image>` sizes to its box from frame 1 — the game's own
   idiom (`hud_ability_icon.xml`, QOLLOCK `ArcadeFlappyBird`, `ModIconImage`). The container keeps all
   its state (transform slide, `.mg-dk-anim`, `.mg-dk-trump` rotateZ, drag-source dim, playable
   frame); the `<Image>` is `hittest:false` so drag hit-testing still lands on the card/piece panel.
   Helper `setFace(container, url)` lives (copied, not shared) in `mg_ui.js`, `mg_durak.js`,
   `mg_games.js`. NOT a rotation bug — an old comment blamed `rotateZ`; the rotated trump is correct.
   (This also retired the `_dkFace` crutch in `mg_durak.js`, which existed only to re-feed
   `background-image`.)

15. **The UI-scale header control is a NATIVE `DropDown` and it WORKS — do not revert it.** After
   several failed custom button+popup attempts (trap 11/12), the native `DropDown` (`buildScaleControl`
   in `mg_ui.js`, skinned via `.mg-scale-dd` + `#MG_ScaleDropDownMenu` in `mg.css`) finally opens
   reliably. Do NOT swap it back to a custom popup to "fix the X" — that trade reintroduces the
   popup-won't-open bug.

15b. **Right-header controls: push right with a flexible spacer, box the DropDown in a fixed 80px
   wrapper, and give the X a higher z-index.** Three separate facts had to line up; missing any one
   made the close X vanish or land in the wrong place:
   - **`horizontal-align: right` is IGNORED on a child of a `flow-children: right` parent.** The
     scale dropdown + X just flow in a row stuck against the left cluster. To move them to the far
     right, a `fill-parent-flow(1.0)` spacer (`.mg-header-spacer`) eats the row's slack — the same
     idiom as the footer's status+spacer+tools row. (An earlier attempt that relied on
     `horizontal-align:right` left both controls floating mid-row, ~124px short of the edge.)
   - **Phantom width.** The native `DropDown` reports the game's base `width: 352px`
     (`citadel_base_styles.css:2839`) as its PREFERRED size even though `.mg-scale-dd` renders at 80px.
     As a direct flow child that 352 advanced the cursor and shoved the trailing X off the modal's
     clipped edge. Boxing the DropDown in a `min/max-width: 80px` wrapper (`.mg-scale-wrap`) pins its
     flow footprint to 80px, so the X flows right after it and stays on-screen.
   - **z-index.** The X gets a higher `z-index` (12) than the dropdown (10); otherwise the native
     widget paints OVER the X and it's invisible behind the dropdown (the "dropdown where the X should be"
     symptom). QOLLOCK's `#SettingsHeader #CloseBtn` carries `z-index: 12` for the same reason.
   Order: spacer → scale wrap → close X, so the X is the rightmost control. The DropDown's arrow is
   its own `background-image` (`:2832`, `background-size: 32px 32px`), so it can't be removed but CAN
   be resized — `.mg-scale-dd { background-size: 19px 19px }` shrinks it to ~60%. If the X ever still
   clips, the documented fallback is `.mg-modal { overflow: noclip }` — NOT applied by default,
   because global noclip would let board/ghost overlays paint outside the modal.

16. **Drag cleanup must not live only in the piece's `DragEnd` handler.** `DragEnd` is bound to the
   PIECE panel (checkers `setupPieceInput`, chess likewise). If the opponent captures the piece you
   are mid-drag on — a polled hop → `animateHop` (checkers) / `applyChessMove` (chess) deletes that
   panel ~220ms later — the panel and its `DragEnd` handler are gone. The engine does NOT synthesise
   `DragEnd` on a deleted panel, so releasing the mouse fires nothing, and the ghost + `dragActive`
   (a sibling of the piece in `piecesLayer`, so the capture doesn't cascade to it) leak forever.
   **Fix: a `clearDrag()` in each controller** (own closure — the drag state is per-controller, not
   shared) called from `DragEnd`, the START of `animateHop`/`applyChessMove` (covers any capture or
   polled move while a piece is held — the key path), `layoutPieces` (full rebuild), and `destroy`.
   It deletes the ghost, resets `dragActive`/`dragOverSq`, and un-dims the source via a tracked
   `dragSourcePiece` ref (the original panel may already be deleted). Idempotent, so own/click moves
   make it a no-op. TTT has no drag; durak drags only your own hand cards (the opponent can't capture
   from your hand mid-drag), so neither needs it.

17. **`@keyframes` (and `animation-*`) in a HUD `.vcss` bricks the WHOLE stylesheet — silently.**
   This one cost a full debugging session. `resourcecompiler.exe` accepts `@keyframes` without a
   warning (`OK: 1 compiled, 0 failed`), so the build looks clean and the `.vcss_c` ships. But the
   runtime CSS parser in the HUD context **rejects the entire compiled stylesheet** when it hits the
   unsupported `@keyframes` at-rule — not just the one rule. `base_hud.xml` `<include>`s `mg.vcss_c`,
   so a dead stylesheet takes the whole layout down: **`Unable to load layout file panorama/layout/base_hud.xml`**,
   a black/blank HUD, and every mod panel gone. The failure looks like a layout/XML problem, which
   sends you hunting in the wrong file for hours.
   - **Not all `@`-rules are equal.** `@import` and `@define` (the `oracle`/`radiance` font aliases,
     see the top of `mg.css`) ARE supported and are used throughout. Only `@keyframes` was fatal.
     An unsupported *property* (e.g. a typo'd `animation-foo`) is merely skipped with a warning; an
     unsupported *at-rule* nukes the file. Big difference.
   - **Diagnosis that worked:** git-bisect the BUILD, not just the source. `Bridge-Buff-Reminder`
     (a working mod) kept loading because it ships no `@keyframes`; bisecting Minigames commits
     narrowed it to `mg.css`, then diffing every new CSS construct against the last-known-good
     `mg.css` surfaced `@keyframes`/`animation-*` as the only brand-new at-rule (radial `gradient()`,
     `fit-children`, `brightness` were all already in use and safe).
   - **Fix / rule going forward:** animate with a **`transition` on a JS-toggled class** instead.
     The forced-capture flash (`.mg-cell.mg-mustcap`, checkers) is `background-color` + a
     `transition`; `flashMustCapture()` in `mg_games.js` does `AddClass` then `RemoveClass` on a
     `$.Schedule` timer. No `@keyframes` anywhere in the mod. If you ever *must* have a keyframed
     animation, it has to live in a stylesheet the game itself loads, never in a modded HUD `.vcss`.
   - **Also watch:** a mixed (`--mixed`, the default) `git reset` moves the branch pointer but leaves
     new files in the working tree, so "I rolled back and it STILL crashes" can be a false signal —
     you're still building the new code. Verify with `git status` / `git diff <commit>` before trusting a rollback.

18. **A synchronous bot search freezes the whole HUD — and silently kills premoves.** Panorama JS is
   single-threaded. The offline bots run a deep search (`chooseBotMove` = depth-5 minimax, checkers;
   `chessBotMove` = depth-3 alpha-beta, up to 120k nodes) and the old code called it in ONE blocking
   invocation inside `botTurn`. That call holds the JS thread for its whole duration, so the entire
   HUD stops painting and accepting input until it returns — the maintainer's "lag when the bot makes
   a move". Two knock-on effects made it worse than "just laggy":
   - **It ate the premove window.** A premove can only be grabbed while it's NOT your turn (during the
     bot's think). But the only live moment was the ~0.45s `$.Schedule` delay BEFORE the search; once
     `botTurn` fired, the frame locked for the search's full length, so you physically could not pick
     up a piece. Premoves "don't work against the bot" was a symptom of the freeze, not of the premove
     code.
   - **Fix = step the search across frames.** Each rules module exposes a resumable driver next to the
     one-shot fn: `chooseBotMovePrep(b,color)` (checkers) / `chessBotMovePrep(b,st,color)` (chess),
     returning `{ done(), step(), result() }`. `step()` evaluates ONE root move (its full subtree is
     still synchronous, but one root's subtree is cheap); the controller loops `if(!done){step();
     $.Schedule(0, drive)}` so a frame is yielded between roots. Same depth, same node budget (shared
     across steps for chess), so **playing strength is byte-for-byte identical** — only the scheduling
     changed. The bot tests (`mg_rules_test.js`, `mg_chess_test.js`) still call the one-shot fns and
     pass unchanged.
   - **Rule going forward:** never call a multi-hundred-ms compute synchronously in a controller. If a
     search/eval can exceed a frame, expose it as a step driver and yield with `$.Schedule(0, …)`. If
     one root's subtree is itself too heavy (deeper future bots), the same pattern nests one level down
     (yield inside `negamax`/`minimax` at the root ply). The rules modules stay shared byte-for-byte
     with the worker, so run `node tools/build_worker.js` after touching `rules/*.js` — the new prep
     fns get embedded too (harmless server-side; it never calls them).

19. **Premove must hook the DRAG path, not just clicks — and both the online-poll AND bot-completion
   turn-handoffs.** The pieces are primarily moved by native drag (trap 16), so a premove that only
   listens on `onCellClick` is dead on arrival: grabbing a piece during the opponent's turn goes
   through `DragStart`/`DragEnd`, and `commitDropMultimethod` bails on `!myTurn()` → the piece snaps
   back and nothing is queued. The working design (checkers + chess, `mg_games.js`):
   - `dragFromSq` is recorded in `DragStart` **regardless of whose turn it is** (the piece is
     `SetDraggable(true)` once at creation, so it stays grabbable during the opponent's turn).
   - `DragEnd` branches: if `!myTurn() && canPremove()`, resolve the drop square via `dropSquare()`
     (the same window-geometry channels as `commitDropMultimethod` but WITHOUT the legal-target filter
     — a premove is validated later, against the post-opponent board) and store `premove = {from,to}`.
   - The queued move is replayed by `tryPremove()`, which must be called from **every** path that
     hands the turn back to me: the online poll (`pollOnce`, at `end=1`) AND the bot-completion paths
     (`applyBotSeq` end, checkers; `botApply`, chess). Miss one and premoves work online but not vs
     bot, or vice-versa. `tryPremove` re-derives legality on the NEW board via `targetsFor` and either
     plays it or silently drops it.
   - `canPremove()` deliberately does NOT exclude bot games — the bot has a think window too (now that
     it doesn't freeze, trap 18), so premoves are testable offline.
   - Highlight: `.mg-premove` (orange wash) is a distinct class from `.mg-sel` (live selection) and the
     green `.mg-target` dots, cleared/rebuilt in `refreshHighlights`.

20. **The UI-scale control uses layout `ui-scale`, and it MUST be viewport-clamped.** The header
   dropdown (100/125/150/175/200%) scales the WHOLE modal — picker, boards, Durak felt, cards — via
   `modalPanel.style.uiScale` in `applyUiScale` (`mg_ui.js`), NOT `pre-transform-scale2d` (trap 5).
   `ui-scale` is a **layout-level** scale: the modal is re-laid-out at the new size and fonts / vectors
   / `.vtex` are re-rasterised crisply, so text stays sharp at 200% (the game's own idiom —
   `CitadelButton.Large/Medium/Small/XSmall` are just `ui-scale` 125/100/80/65% in
   `citadel_base_styles.css`; QOLLOCK sets it from JS the same way). Two facts had to line up:
   - **Blur** (the reason for the switch, commit `d5a7433`): the earlier `pre-transform-scale2d` on the
     modal is a transform-family prop that runs AFTER layout and stretches the rendered texture → blurry
     bitmap above 100%. `ui-scale` re-lays-out instead. **Do not revert to a raster scale.**
   - **Clipping** (2026-07-20, the maintainer's 200% screenshot with "PLAY WITH A FRIEND" cut off;
     revisited 2026-07-29 when 125% ate poker's LEAVE button):
     `ui-scale` grows the modal's LAYOUT box by the factor, and the modal is `vertical-align: center`
     in the full-screen overlay, so once `natural_height × scale` exceeds the viewport height the top
     AND bottom clip off-screen. Width never overflows (900px even ×2 is < the 1920 canvas), so only
     height is at risk.
     **There must be only ONE ceiling.** A percentage CSS `max-height` resolves in the SCALED
     space — the real ceiling is `maxHeight × viewport / scale`. At 92% that meant
     `0.92·1080/1.25 = 795px` at 125%, against a poker view needing ~838px, and the engine simply
     **truncated** the modal: no scrollbar, no warning, just a missing footer. Even a 99% backstop
     clipped the first menu→Poker switch at 150–200% before JS could observe Poker's full natural
     height. `.mg-modal` therefore has no CSS `max-height`; the JS clamp (`FIT_MARGIN` 0.98) is the
     sole authority. `mg_uiscale_test.js` reads production CSS and fails if that cap returns.
     `measureNaturalH` reads `modalPanel.actuallayoutheight` (window px) and divides the applied
     scale back out, so it works at ANY current scale — the old version only read at exactly 100%,
     so a player whose saved scale was already >100% never got a measurement and never got a clamp.
     It runs on every view switch (`clearBody` schedules it a frame later, once the incoming view is
     laid out) and keeps the **tallest** height seen: the poker felt is ~200px taller than the menu,
     and clamping against the menu is precisely what let 125% clip. This is NOT the old per-view
     re-fit that caused button jitter — that one forced the scale to 100% for a frame to take a clean
     reading; this one just divides, so nothing moves unless a genuinely taller view appears.
     It never clamps below 100%. Consequence, not a bug: on 1080p the poker view can't exceed ~126%,
     so 150/175/200% all land there; the menu goes higher. On 1440p+ the steps open up.
     ⚠ The clamp maths are covered by `tools/mg_uiscale_test.js` using heights measured off real
     1080p screenshots, but the RENDERED result still needs a VPK repack to confirm on ultrawide.

21. **The update check is one-shot on the first DL Arcade open, and marker shapes are
    fail-closed.** Panorama cannot read a JSON/version response, so `mg_ui.js` loads the current
    release's tiny PNG directly from the public `main` branch and reads only its rendered
    dimensions. A square marker means current; the deliberately 8:1 marker means outdated.
    Classification uses orientation-independent aspect ratio because UI scale multiplies both
    axes and some setups swap them. Only two distant bands are accepted (`<=1.35` current,
    `>=4.0` outdated); the gap is an error, never a false update. The automatic request runs once
    per loaded HUD session when the player first presses DL Arcade. The footer button remains a
    manual retry. An outdated result opens a same-class-state popup with no auto-close timer.
    `tools/mg_update_marker_test.js` simulates 50–400% UI scale, swapped axes and ±2px errors.

22. **De-glowing a NATIVE widget needs the game's own selector prefix — and `box-shadow: none`.**
    The house style has **no outer glow anywhere**, but Deadlock's base stylesheet puts one on every
    native widget it ships. Two separate facts made the first de-glow pass silently ineffective on
    the GeoGuesser camera sliders:
    - **Specificity.** The glow lives on `#SliderThumb { box-shadow: fill brandGreen&11 0px 0px 16px
      1px }` (green) and `Slider.HorizontalSlider #SliderTrackProgress { box-shadow: offWhite&33 0px
      0px 8px 0px }` (white) in `citadel_base_styles.css:3506/3540`. A sensible-looking override
      `.mg-geo-camera-controls #SliderThumb` is **one class + one id = 110**, while the game's rule is
      **type + class + id = 111** — the game WINS and the glow stays. Our rules must repeat the game's
      own `Slider.HorizontalSlider` prefix to reach 1111. This binds only while the controller keeps
      calling `AddClass("HorizontalSlider")`.
    - **`none`, not a transparent zero.** `box-shadow: 0px 0px 0px 0px #00000000` does not reliably
      clear a shadow declared with the **`fill` keyword**. The game's own cancel idiom is
      `box-shadow: none` (`ClientUIDialogPanel #SliderThumb`, `:3516`) — use that.
    - Also override **`:hover` and `:active`** separately: they are distinct game rules that swap in a
      brighter radial gradient plus `brightness: 1.5`, so without them the thumb still flares on grab.
    Other native widgets carry the same glow and are **not yet cleaned**: `DropDown` (`:2836`),
    `DropDownMenu` (`:2950`), `ToggleButton:selected .TickBox` (`:3151`), `RadioButton .RadioBox`
    (`:3197`/`:3255`), `.ButtonBevel` (`:3604`), `TextEntryAutocomplete` (`:2450`). The scale/volume
    dropdowns and Wordle's hidden `TextEntry` are the panels this could still surface on.
    `mg_release_ui_regression_test.js` now enforces both halves: the four winning slider selectors,
    and a **repo-wide scan that fails on any zero-offset blurred `box-shadow`** in `mg.css`. The scan
    tokenises the lengths (a `fill`/colour prefix otherwise shifts the match and reads the SPREAD as
    the blur), so an offset drop shadow and a zero-blur ring like `.mg-cf-win-disc`'s
    `0px 0px 0px 3px` both stay legal — only a real halo fails.

23. **Every image load goes through the FIFO — a bare `SetImage` beside it wedges the loader.**
    §5's "one image load at a time" is not advisory. GeoGuesser's three-copy panorama built its two
    SIDE copies with its own `$.CreatePanel("Image", …)` + `copy.SetImage(url)`, fired from
    `$.Schedule` at 0.06s and 0.12s. Those two loads overlapped each other **and** the running
    poll traffic, which is exactly the documented wedge: the pending loads stall at **dims 0** and
    never paint. In-game (maintainer's 2026-07-31 screenshots) that read as a **mostly BLACK
    viewport** with one visible strip, and a nearly empty frame once heading walked onto a copy that
    did not exist — trivially misdiagnosed as "broken perspective" or a bad seam. It was neither:
    the seam maths (`PANO_STEP = PANO_W - 2`) were already right, the neighbours were simply absent.
    **Fix:** route the copies through `MG.Net.loadImage` (same FIFO; the URL is identical so the
    engine serves them from cache) and **chain** them — left copy, then right copy, then set
    `panoramaReady` and reveal. The old fixed 0.18s timer declared readiness on faith, with no way
    to know whether either load had finished. A failed neighbour degrades to "no wrap at that edge"
    and stays playable rather than erroring.
    ⚠ Still unfixed by this and NOT a bug: the equirectangular strip is **stretched, not
    reprojected**. Panorama exposes no shader to this mod, so straight lines still bow near the
    frame edges. Narrowing the crop (720px of a 2880px strip ≈ 90° instead of 120°) reduces it; only
    a real rectilinear projection would remove it.

24. **An unknown `<Image>` `scaling` token silently falls back to NATIVE SIZE, centred.** It does
    not warn and does not error, so the panel keeps the size you gave it while the bitmap paints
    small in the middle of it. GeoGuesser passed `scaling: "stretch-to-fit"` — a token this engine
    does **not** have. Every `<Image>` in `G:\GameTracking-Deadlock` uses only
    `stretch-to-fit-preserve-aspect` (31), `cover` (4), `stretch-to-fit-y-preserve-aspect` (3),
    `stretch-to-cover-preserve-aspect` (2) or `contain` (2). (`stretch` exists but only on
    `MoviePanel`.) With a 2048×1024 Panoramax SD source in the 2880×1440 strip, the fallback left
    **(2880−2048)/2 = 416px** of dead panel each side and **(1440−1024)/2 = 208px** top and bottom.
    - **How it presented:** a black-framed viewport, and only roughly **95°–270°** of heading
      looking correct — everything else black or a thin sliver. That reads like "broken perspective"
      or "bad seam" and is neither. The maintainer's measured window is what pinned it: content
      began at stage x ≈ 3290 while the strip was positioned at 2878, and 2878 + 416 = **3294**.
      Arithmetic identified the cause before any code was changed.
    - **Fix:** `cover`. The yaw/pitch maths assume the strip is exactly `PANO_W × PANO_H`, and
      `cover` always fills the box. For a 2:1 source it is a pixel-exact fill with no cropping,
      whereas any `*-preserve-aspect` token silently letterboxes again the moment a source is not
      exactly 2:1.
    - `mg_release_ui_regression_test.js` whitelists the valid tokens across every shipped script,
      because this failure mode is invisible to `node --check`, to lint and to the rules tests.

25. **A protocol change is TWO deploys, and the tests cannot see the second one.** Every check in
    this repo reads the working tree: `npm test` proves the client and `server/worker.js` agree with
    each other, and `build_worker --check` proves `worker.js` matches its sources. **Nothing proves
    the VPS is running that `worker.js`.** So a reveal-protocol change that is green locally can be
    live-broken, because the client speaks the new codec to a server still speaking the old one.
    - **How it presented (2026-08-01):** GeoGuesser named a country that was never right — a Canadian
      road labelled `Oceania · Belgium`, a New Zealand park `Africa · Benin`, a Berlin street
      `Asia · Belgium` — while the map dot landed correctly. That split is the tell: **points were
      fine, labels were garbage**, because only the label routes had changed codec.
    - **The arithmetic pinned it before any code was touched.** The old `/api/geoinfo` answered
      `d(region + 1, 1)`; the new client decodes `place = h*63 + w`, i.e. `63 + region + 1`. Region 1
      → 65 → `Oceania · Belgium`; region 5 → 69 → `Africa · Benin`; region 0 → 64 → `Asia · Belgium`.
      Three of three, exactly as screenshotted. The credit line broke the same way: the old route
      with no `&i=` took its `Number(null) === 0` branch and returned `d(text.length, 0)`, so the
      client used a **string length** as a table index — which is why plausible-looking but wrong
      contributors appeared. Confirmed on the box: the deployed `worker.js` still contained
      `region + 1, 1` and no `geoPlaceCode`, dated a day before the commit that changed it.
    - **Rule going forward:** when a route's encoding changes, redeploy (`server/README.md`) and
      verify against the running server, not the working tree —
      `node tools/mg_geo_live_smoke.js https://<host>` prints the real `placeCode`/`creditCode`, and
      decoding one of them by hand is the only check that covers this gap. A green `npm test` says
      nothing about it.

---

## 7. Checkers internals (mg_checkers.js)

- **Board model**: flat `Array(64)`, canonical orientation. Values: `0` empty, `1` white
  man, `2` white king, `3` black man, `4` black king. **White = host = player 0**, starts
  rows 5-7, moves UP, moves first. **Black = joiner**, rows 0-2, moves DOWN.
- **Rules** (Russian draughts): men move forward only but **capture in any diagonal
  direction**; **flying kings** slide any distance; **forced capture**; **multi-jump
  chains**. Pure helpers (`simpleMoves`, `captureMoves`, `applyHop`, `legalSequences`) are
  UI-free, and since the split into `rules/*.js` the tests `require`/eval the module directly —
  `tools/mg_rules_test.js` reads the file, no source slicing.
- **Two variants** (2026-07-23). `rules/checkers.js` builds both engines from one
  `makeRules(simpleMovesFor, captureMovesFor, promotionEndsTurn)` factory: `R.checkers`
  (Russian — flying kings, men capture any direction) and `R.checkersEnglish` (English
  draughts — kings step **one** square, men jump **forward only**). Board encoding, promotion,
  `applyHop` and the depth-5 bot driver are shared; the variants differ in their simple/capture
  generators **and in what a mid-capture promotion does** (2026-07-24): Russian
  (`promotionEndsTurn=false`) — a man crowned DURING a capture keeps capturing **as a flying
  king** if it can (canon rule); English (`promotionEndsTurn=true`) — promotion ends the turn
  immediately. The **variant is matched like
  time control**: server pools quick/multi seekers by `(game, tc-bucket, variant-bucket)` into
  `pubq:q:<g>:<tc>:<cv>` / `pubq:m:…` queues; `preferencesMatch` gates a join and
  `resolveMatchOptions` settles the pair (a concrete pick beats "Any"; two "Any"s fall to
  Russian). The 2-int join/quick reply can't carry the resolved variant, so a checkers client
  reads it back from **`/api/match`** before mounting (`mountOnlineGame` in `mg_ui.js`); the
  controller shadows its checkers helpers with the chosen engine (`createCheckers`, `session.variant`).
  The picker (`renderCheckersVariant`, `mg_ui.js`) defaults to **Any** — as does time control now.
- **`applyHop(b, from, to)`** walks the diagonal and clears whatever it passes, so the net
  protocol only needs `{from, to, end}` — the captured square is derived, not transmitted.
  A bounded guard (max 8 steps) makes a corrupt/desynced hop fail safe instead of looping.
- **Bot AI**: alpha-beta `minimax` (depth 5) over full turn sequences, with a tiny random
  tie-break so it isn't perfectly repetitive. `evalBoard` weights kings ≫ men and rewards
  advancement.

### Rendering & the pieces overlay

- `boardWrap` (`flow-children: none`) stacks two siblings: `boardPanel` (the 8×8 grid of
  cells) and `piecesLayer` (the pieces). **Pieces are a sibling of the board, not a child**
  — a child of the `flow-children: down` board would be pushed below the rows.
- **Pixel geometry** (must match `mg.css`): cell `SQ=60`, piece `PIECE_SZ=46`,
  `INSET=(60-46)/2=7`. Wrap is `486 = 8*60 + 2*3` (board border). `piecesLayer` has
  `margin:3px` to sit inside that border, so a piece's `translate3d(dc*60+7, dr*60+7)`
  lands centered in its cell. (Pixel-accuracy unverified without in-game render.)
- **`pieceEls`**: `realSquare → piece panel`. Each piece stores `_sq` (its live square),
  kept in sync on every slide — click/drag read `_sq`, so a stale value would report the
  wrong square.
- **`animateHop`**: slides the moving piece (reassign `transform`), shrink-fades a captured
  piece in place (`.mg-captured` + `pre-transform-scale2d`), crowns on promotion. Has a
  desync guard: if the moving panel is gone, it rebuilds from the model.

### Input: click AND drag (both, by user request)

The pieces layer is `hittest:false` (clicks on empty squares fall through to the cells,
which own destination clicks + `.mg-target` highlighting). `hittestchildren` is left
**default (true)** so the **pieces themselves receive input** — needed for both styles.
Because the click now lands on the piece (not the cell beneath), each piece forwards it.

- **Click-to-move**: `onactivate` on a piece → `onCellClick(piece._sq)` (select, or play a
  hop if the piece is a legal target). Same handler the cells use.
- **Drag-and-drop** (native Panorama drag, recipe proven in QOLLOCK — see
  `ql_settings.js` / `ql_hero_testing.js` / `hud_quickbuy_total_summary.js`):
  - Only my own pieces get `SetDraggable(true)`.
  - `DragStart` on the piece: build a throwaway **ghost** panel (`.mg-dragging`), set
    `dragEvent.displayPanel = ghost` so the engine drags the ghost, NOT the real piece;
    `removePositionBeforeDrop = false` keeps it under the cursor; `align = "left top"`. The
    real piece is dimmed via `.mg-drag-source`. The piece's legal targets are lit up as
    drop hints (by calling `onCellClick` to select it), guarded to my turn / chaining piece.
    The ghost is `hittest:false` so it doesn't intercept its own drop.
  - **⚠ PROVEN in-game (2026-07-07 `DRAG_DEBUG` run): native drag reports the drop location
    through NOTHING.** A real drop logged: `panel=noid` (DragEnd's 2nd arg is the DRAGGED
    ghost, not the target cell — and QOLLOCK uses it the same way), `over=-1(0e)` (**zero
    `DragEnter`/`onmouseover` events** — the engine suppresses all pointer events on other
    panels during a drag), `sx=null sy=null` (`removePositionBeforeDrop=false` did NOT
    populate the ghost's `style.x/y`), and `actualxoffset = 3.4028e38 = FLT_MAX` (the ghost
    is culled out of layout, so its layout offset is the "invalid" sentinel). So DragDrop /
    DragEnter / droppedPanel / style.x/y / actualxoffset are ALL dead ends. Don't retry them.
  - **Commit on `DragEnd`, primary channel = `squareFromWindow()`.** `GetPositionWithinWindow()`
    is a real engine method (confirmed in `panorama_strings.txt`) that computes absolute
    window pixels from the RENDER tree, so it stays valid even when the ghost is culled from
    layout (unlike `actualxoffset`). `squareFromWindow` reads the ghost's window position and
    the pieces-layer's window position; the delta ÷ (layer rendered width / 8) gives the
    display col/row → real square. UI scale cancels (everything is window px). Read these
    BEFORE `squareFromGhost()` runs, since its reparent invalidates the window reading.
    `commitDropMultimethod` still tries the dead channels after it (harmless, and the debug
    line reports each), committing the FIRST that is a legal target (`isLegalTarget`).
  - A garbage candidate is simply not in `legalTargets`, so it's skipped; if none match,
    the piece snaps back. **A false move is impossible, and nothing here touches the
    server** — the same `doLocalHop` path a click uses.
  - ⚠ **`GameUI.GetCursorPosition` is CONFIRMED ABSENT in Deadlock** (QOLLOCK
    `ql_settings.js` / `ql_core.js`). Do NOT reintroduce a cursor-reading drop method — it
    silently returns nothing. Panel-signal methods only.
  - **First deal doesn't slide in.** The base `.mg-piece` has NO transition; the animating
    `.mg-anim` class is added one frame later (`$.Schedule(0.0)`), after the start transform
    is committed — so pieces snap onto their squares at start but every later move animates.
  - 🔎 **`DRAG_DEBUG` diagnostic (now OFF — drag confirmed in-game 2026-07-20).**
    `commitDropMultimethod` writes what every channel produced to the on-screen status line on each
    `DragEnd`: `DROP OK via win->37` or
    `DROP MISS | win=<sq> g(<gx,gy>) L(<lx,ly>) lw=<layerWidth> | panel=.. over=..(<n>e)
    ghost=.. | targets=[..]`. The `win=`/`g(..)`/`L(..)`/`lw=` fields are the window-position
    channel; if `win` still misses, `g`/`L`/`lw` show whether `GetPositionWithinWindow`
    returned usable numbers and let us fix the arithmetic. Once drag works, set
    `DRAG_DEBUG=false` and delete the dead channels + their helpers.
- **Bot color alternates** each `Play vs Bot` (`botGamesStarted % 2`) so you don't always
  open as white. When you're black/O, the boot path calls the bot to open (offline has no
  server to poll).

---

## 8. Tic-Tac-Toe internals

Reuses the checkers move transport: a placement in cell `0..8` is sent as
`move(code, cell, 9, end=1)`. `to=9` is a fixed non-cell marker so `from != to` always
holds and validation is trivial (`from∈0..8 && to==9`). Board is `Array(9)` (0 empty,
1 = X, 2 = O). Host plays X and moves first. Bot is win > block > center > corner > side —
strong but deliberately beatable (not full minimax). Marks are panel-drawn (trap 6).

---

## 8.5 Chess internals (mg_chess.js)

Chess deliberately mirrors checkers so the two share the board geometry, the click+drag
input recipe, and the move/poll transport.

- **Self-contained engine.** The `// ── chess: pure rules` … `// ── chess controller`
  section has NO dependency on the checkers helpers (it defines its own `cSq/cRow/cCol/
  cSign/cType`), so `tools/mg_chess_test.js` loads `rules/chess.js` and runs it standalone. Perft from the start position (20 / 400 / 8902) is the correctness
  anchor; targeted tests cover castling, en passant, promotion, checkmate, stalemate.
- **Board model** differs from checkers: `Array(64)`, `0` empty, **sign = colour** (white
  `> 0`, black `< 0`), **abs = type** (1 P, 2 N, 3 B, 4 R, 5 Q, 6 K). "Colour" in chess code
  is `+1`/`-1` (the piece's sign), NOT the checkers `WHITE`/`BLACK` strings. White = host,
  starts on the bottom rows (6-7) and moves first; black = joiner, top rows (0-1).
- **`makeMove(b, st, from, to)` derives every special move** from the board + state
  (`st` = castling rights + en-passant target): a king moving two files ⇒ move the rook; a
  pawn stepping diagonally onto an empty square ⇒ en passant (remove the passed pawn); a pawn
  reaching the last rank ⇒ **auto-queen** (MVP: no under-promotion). Same "derive, don't
  transmit" idiom as checkers `applyHop` — so **from/to alone travels the wire**. Promotion,
  castling and en passant need NO protocol change.
- **Pieces are `.vtex` sprites**, not drawn shapes: a `.mg-chess-piece` container whose sprite
  (`<Colour><Piece>.vtex`, e.g. `WhiteKnight.vtex`) is drawn by a child `<Image>` via
  `setFace()` in `makePiece` (trap 14 — NOT `background-image`, which zooms on frame 1). It
  reuses `.mg-piece` for the slide transition + drag classes, overriding only the disc look.
  The 12 source PNGs live in `panorama/images/`; the maintainer compiles them to `.vtex`.
- **A turn is ONE move** (no multi-jump chains), so every move is `end = 1`; after applying
  a polled move the turn always hands straight back. Poll `validate` = `0..63, from != to`.
- **Check** highlights the king's square (`.mg-cell.mg-check`); `chessResult` ends the game
  on checkmate (win/lose) or stalemate (draw).
- **Bot** = alpha-beta negamax (`chessBotMove`, depth 3, node-budget capped, captures-first
  ordering, material + light central eval, tiny random tie-break). Colour alternates per
  `Play vs Bot` like checkers. ⚠ Depth/budget are a **perf guess** for Panorama — if the bot
  hitches noticeably in-game, drop `DEPTH` to 2 or lower `budget.max`.

⚠ **Poll decode range.** Checkers/chess both send RAW squares `0..63`, so `poll` returns
`(from, to)` as levels 0..63 → `dim = level*9 + 15`, at most **582 × 582 px** (level 63).
That's within the 600×1000 probe envelope, so calibration covers it — still worth a sanity
check on the first in-game chess sync. The `end` flag is NOT transmitted (it wouldn't fit
the codec); the client derives it by replaying the shared rules on the same board.

---

## 8.6 Durak internals (mg_durak.js)

Durak is the first game that does NOT fit the 2-player, "a move is two small ints"
transport. It ships both offline-vs-bot and authoritative online play for 2–4 players;
the pure rules are shared by both paths.

- **Two-section file, like chess.** `// ── durak: pure rules ──` … `// ── durak
  controller ──`. The pure section is self-contained (no `$`, no `MG`) so
  `tools/mg_durak_test.js` loads `rules/durak.js` and runs it under Node. (Historic note: the tests
  used to SLICE the pure section out of one combined file by banner comment, which made those
  banners load-bearing. Since the rules moved into their own modules that is gone — mg_wordle_test
  is the last slicer, because Wordle has no separate rules module.)
- **Card model.** id `0..35` = `suit*9 + rank`. suit `0..3` = S,H,D,C; rank `0..8` =
  6,7,8,9,T,J,Q,K,A (**higher rank index = stronger**). Trump = suit of the deck's bottom
  card. Art is a compiled `.vtex` per card, `deck/<S><R>.vtex` (e.g. `SA.vtex`), backs via
  `deck/BACK.vtex`. Faces/backs are drawn by a child `<Image>` (`setFace`/`setBack`, trap 14),
  same idiom as chess sprites — the container keeps its slide/rotate/playable state.
- **Deterministic deal.** `makeRng(seed)` (mulberry32) → `freshDeck` → `deal`. A seed fully
  determines the game (the test relies on it; online the **server** will own the seed). Deck
  is drawn from the FRONT; the bottom card (trump) is drawn last. Lowest-trump holder opens.
- **State** `st = {numPlayers, trump, trumpCard, deck, hands[], table:[{a,d}], attacker,
  defender, phase, discard, out[], loser}`. `phase` ∈ `attack|defend|over`. `beats(att,def,
  trump)`: same-suit-higher, or a trump over a non-trump. Bout resolution (`endBout(st,
  took)`) collects/discards the table, refills (attacker first, defender last), rotates
  roles (successful defender attacks next; a taker is skipped), then `checkOver` (last player
  holding cards is the **durak**). The full-game test asserts card conservation (=36) and
  termination across 120 games (2/3/4 players).
- **Bot** is intentionally basic: defend with the minimal beating card (trumps sorted far
  above non-trumps) or take; attack/throw-in with the lowest card, only throwing in genuinely
  cheap non-trumps. Tune later if it plays too passively.
- **Rendering & seating.** Opponents sit in **zones** (TOP, plus LEFT/RIGHT for 3–4);
  everyone renders themselves at the bottom, so an opponent's screen side is `seatZone((seat
  - mySeat + N) % N, N)` — "left" for one viewer is "right" for another (the relativity the
  design calls for). The deck+trump, the attack/defense pairs and MY hand all live on one
  fixed-size **STAGE** (`flow-children:none`, CARD 100×140 / STAGE 680×470 — the JS px math and
  the CSS sizes MUST agree), where **each card is positioned by `transform:translate3d`** (no
  `position:absolute`, trap §6.1). A card panel **persists across refreshes keyed by its id**
  (`cardEls`), so reassigning its transform makes it **SLIDE** — exactly the checkers
  `.mg-piece`/`.mg-anim` idiom (base class has no transition; `.mg-dk-anim` armed one frame
  after creation). So playing a card glides hand→table and a "take" glides the table cards into
  my hand. **New-card entry origin is source-aware**: a freshly created TABLE card was just
  played by an opponent, so it glides in from their seat (`oppOriginSlot`, top-centre); a fresh
  HAND card is one I drew, so it glides from the deck. The deck is a real **stack** of
  overlapped backs with the **trump laid horizontally UNDER it, rotated 90°**, its right half
  poking clear of the stack (drawn before the stack so it paints under) — this replaces the old
  "· Trump X" text on the deck label, which now shows only the count. `render()` reconciles
  `cardEls` against `computeWanted()` each turn. Input is **click + drag**: click a hand card to
  attack / auto-cover; or **drag** it onto the table (the checkers/QOLLOCK ghost recipe §7 —
  `SetDraggable` + a throwaway ghost as `displayPanel`, drop resolved from the ghost's
  `GetPositionWithinWindow` mapped into stage coords). While defending, the drop targets the
  **nearest uncovered pair the card can beat**, so you choose *which* attack to cover; a bad
  drop just snaps back (drag can only ever produce a legal move). ⚠ All pixel geometry + the
  drag drop-mapping are unverified from a shell — tune in-game.
- **⚠ Stage-1 simplifications** (documented, not bugs): only the **primary attacker** throws
  in during the attack phase (other attackers don't pile on — matters only at 3–4 players);
  throw-ins are allowed only while the table is fully covered. Full podkidnoy throw-in from
  all attackers is a Stage-2 concern.
- **Stage 2 transport (BUILT — 2–4-player online).** The public move log can't hide hands, so the
  **worker is an authoritative dealer**: it owns the deck/hands/seed, deals privately per seat
  via an indexed `/api/ddraw` channel (gated by the seat token, so a caller can only read its
  OWN cards → a foreign token gets `(9,3)`, closing `trust_refactor_plan §1 T3`), and relays
  public actions through an indexed `/api/dlog`. Event encoding (TRUMP/OPEN/PLAY/COVER/TAKE/
  BITO/DRAW/OVER) and the full route set (`room/start/dact/dlog/ddraw`) live in
  `server/README.md`; private cards use `card+2` so id 0 can't collide with the `(1,1)`
  "nothing new" marker. **Client (`createDurak`, online branch):** it holds NO authority —
  it rebuilds `st` from `dlog` (opponent hands are placeholder *counts*, the deck is a count,
  the table is public), pulls its own card identities from `ddraw`, and sends its own actions
  via `dact` **without** optimistic local mutation (the echoed event is the single source of
  truth, so a rejected action simply never lands — no rollback). Roles rotate deterministically
  after each bout (2-player: Bito swaps attacker/defender, Take keeps them). Private 2–4-seat
  rooms auto-start when their declared cap is filled; the host may still start early once at
  least two live seats exist. Public quick/multi-quick is always heads-up and auto-starts as
  soon as its second player is matched. The online buttons
  are enabled in `mg_ui.js`: public Quick enters a 2-seat room, while private Create/Join uses
  the dedicated `dcreate`/`djoin`/`droom` routes and a host-selected 2–4-seat room. The host
  may start the dealer early once at least two seats are present; unfilled seats become
  inactive holes.
  The offline bot branch is unchanged.
  Verified in Node: server routes/privacy/encoding (`mg_server_test`), client↔server rule parity
  (`mg_parity_test`). Reasoned only (needs in-game repack): the online render/slide/sync itself.


## 8.7 Connect Four internals (mg_connectfour.js)

Connect Four is full-information 2-player, so it rides the **existing 2-int authoritative
transport unchanged**: a move is a COLUMN `0..6` sent as `move(code, col, 7, end=1)`. The
fixed marker `to=7` keeps `from != to` (like TTT's `to=9`), and the **server derives the
gravity landing row** and validates. Pure engine `rules/connectfour.js` is shared byte-for-byte
with the worker (`initialBoard/dropRow/drop/winner/winningLine/isFull/legalCols/cfBotMove`).

- **Board model**: `Array(42)`, `idx = row*7+col`, **row 0 = TOP**. `0` empty, `1` host
  (red, seat 0, moves first), `2` joiner (yellow). Self-registers game id 5 (`enabled:true`)
  like durak.
- **Two stacked layers** under a `flow-children:none` wrap (`.mg-cf-wrap`, trap §6.1),
  painted back→front by CREATION order:
  1. `boardPanel` (`.mg-cf-board`) — the solid blue plate; each cell holds a dark round
     `.mg-cf-hole` (the empty socket) + owns the column's click + hover tint.
  2. `piecesLayer` (`.mg-cf-pieces`) — discs, positioned by `translate3d(col*60+INSET,
     row*60+INSET)`. `hittest:false` so clicks fall through to the cells. A disc sits inside
     its hole and reads fine as-is. ⚠ A previous attempt at a THIRD "front rim" layer of blue
     rings over the discs (to fake seating them behind the plate) drew stray rings around every
     hole in-game and was reverted — the plain two-layer stack is correct.
- **Fall animation** (`.mg-cf-anim`): a fresh disc starts one cell above the top edge and
  slides to its landing cell. ⚠ The timing-function matters — a plain `ease-in` over 0.42s
  hung in the last frames right before landing (its velocity peaks at the very end and
  Panorama's long-transform interpolation stutters there, point 7). Use a symmetric
  `cubic-bezier(0.45,0.05,0.55,0.95)` over ~0.36s: accelerate, then ease cleanly INTO the
  floor with no end-of-curve spike. Arm the class one frame after the start transform is
  committed (`$.Schedule(0.0)`), the checkers `.mg-anim` idiom.
- **Winning four**: `winningLine` returns the 4 cell indices; the discs get `.mg-cf-win-disc`
  (white ring + `brightness` lift).
- **Bot** (`cfBotMove`): win-in-1 > block-opponent's-win > centre-weighted shallow search.
  Perf is a guess for Panorama — tune depth in-game if it hitches.
- Verified in Node: rules + bot (`mg_connectfour_test`), client↔server parity
  (`mg_parity_test`), server validation (`mg_server_test`). Reasoned only: render / seating /
  fall animation / online sync — needs a VPK repack.

---

## 8.8 Poker internals (mg_poker.js)

No-Limit Texas Hold'em, 2–4 players. Like durak it does NOT fit the 2-int transport, so online
uses the **worker-as-dealer** model (§8.6): the worker owns the deck/hole cards/seed and relays
public actions; each seat pulls only its OWN hole cards through a token-gated private channel.
Registers **game id 6** (`enabled:true`). Offline vs bot runs in Node — though note the test
played only 40 hands per table, which is why a hand that froze whenever a blind put the opening
seat all-in survived it (fixed 2026-07-29; the suite now stresses 400 hands × 1200 tables). Online
is built but **not yet in-game verified**.

> ⚠ **TRAP — a terminal street has NO successor, and walking off the end of `STREETS` is an
> infinite loop that wedges the ENTIRE relay.** `finish()`/`showdown()` set `street = "over"`, but
> `STREETS` maps only `preflop→flop→turn→river→showdown`. `runout()`'s old
> `while (street !== "showdown")` therefore read `STREETS["over"] === undefined`, assigned it, and
> spun forever. The door in was `leaveSeat`'s `canActCount <= 1 && roundOver` branch, which a
> resolved all-in hand satisfies — so ONE player pressing Leave on a finished hand pinned a core at
> 100% and stopped every game for five hours (2026-08-02). It cost that long because nothing
> detected it: the process never died, so `Restart=always` never fired and systemd still called it
> `active`. `durak.js` had guarded this since day one (`if (st.out[seat] || st.phase === "over")
> return;`) — poker was the outlier. Both `runout` and `leaveSeat` now return on a terminal street,
> `server/README.md` documents the health watchdog that bounds any future wedge to ~1 minute, and
> `mg_poker_test.js` asserts termination in a **child process with a timeout** (a plain call would
> hang the suite instead of failing it). Diagnosed on the live process with `kill -USR1 <pid>` plus
> the V8 inspector — that stack (`runout ← leaveSeat ← pokerLeave`) is the whole diagnosis, so
> reach for it first when the relay is up but silent.

- **Two-section file** like chess/durak: `// ── poker: pure rules ──` … `// ── poker controller
  ──`. The pure section (`rules/poker.js`, shared byte-for-byte with the worker) is self-contained
  so `tools/mg_poker_test.js` loads it and runs it under Node.
- **Card model.** id `0..51`; `suitOf = id/13`, `rankOf = id%13`, `cardVal = rank+2` (2..14, ace
  high). Note this is a DIFFERENT encoding from durak's `suit*9+rank` — poker uses the full
  52-card deck. Art: `deck/<S><R>.vtex` (reuses the durak deck), faces/backs drawn by a child
  `<Image>` (`setFace`/`setBack`, trap 14).
- **Hand evaluation** (`score`) returns a comparable `[category, tiebreak…]` array (8 = straight
  flush … 0 = high card), best 5 of 5–7 cards; `compareScores` orders them lexicographically.
- **Betting** is No-Limit: fold / check / call / raise-to. **Side pots** are built from each
  player's total committed chips at showdown, so an all-in short stack can only win what it
  matched. Blinds rotate with the button each hand; offline carries stacks over tournament-style.
- **Rendering.** A `flow-children:none` STAGE bigger than durak's (needs room for the 4-seat felt),
  cards positioned by `translate3d` and persisted by id so they SLIDE (the `.mg-piece`/`.mg-anim`
  idiom). I always sit at the bottom; opponents fill `left/top/right` by relative seat offset
  (`seatZone`), their hole cards drawn as small face-down backs. Betting controls sit below my
  hand: a raise **stepper** row (`−`/`+`/`Pot`/`Max`, only when a raise is legal) above one centred
  action row (Fold / Check / Call <amt> / Bet-or-Raise-to <target>).
- **Online (worker-as-dealer).** Routes mirror durak: `pcreate/pjoin/proom/pstart/pact/plog` plus a
  token-gated private deal channel. A poker lobby carries `cap` (2–4, chosen at create), grows via
  `pjoin` up to cap, auto-deals when the declared cap is filled, and also lets the host fire
  `pstart` (`pokerStart`) early once at least two live seats exist; a mid-match leave folds the
  seat out (`pokerLeave`). The client (`createPoker`, online branch) holds NO authority — it
  rebuilds state from `plog` and pulls its own hole cards from the private channel, sending actions
  via `pact` without optimistic mutation (the echoed event is the single source of truth).
- **Bot** (`rules/poker.js` `botAction`, driven from the controller): `preflopStrength` /
  `madeStrength` heuristics decide fold/check/call/raise; tune later.
- **⚠ The room's seat token must be CAPTURED, not read from the global at Deal-time.** `pcreate`
  is async (~1.5s image load). The old Deal handler read the module-global `currentTok` when the
  button fired; if the user launched another create/join during that window, `currentTok` pointed
  at the OTHER lobby, so `pstart` sent a token seat 0 never bound → server `seatOf` miss → `(9,3)`,
  surfaced as a silent "couldn't deal" (the maintainer's 4-digit-code DEAL report — the 4-digit
  code was a coincidence; the server deals fine for every code 0..1023, proven by `mg_server_test`).
  Fix: `startCreate`/`doJoin` capture the token at the call site and thread it into
  `renderPokerRoom(…, tok)` / `renderDurakRoom(…, tok)`, which re-establish it as `currentTok` and
  use a closure `roomTok` for the Deal/Start `pstart`/`start` call — so the shown room is always
  self-consistent regardless of global churn. Same pattern for durak's private table.
- Verified in Node: rules + bot + showdown (`mg_poker_test`), server routes/privacy
  (`mg_server_test`). Reasoned only (needs a VPK repack): the render/betting UI + online sync + the
  room-token binding above (the `(9,3)` was never reproduced server-side — the fix is a reasoned
  hardening of the most plausible client-side cause).

---

## 8.9 Pixel Battle (mg_pixelbattle.js)

- Anti-abuse is deliberately tolerant of households/NATs: one IP can spend six fresh 100-pixel
  banks immediately, then refills 120 changed pixels/minute. This keeps rotating the
  client-reported Steam32 from resetting the economy without banning the address. Expensive
  uncached 768x384 viewport renders allow a burst of twelve and one new frame/second; cache hits
  are free and the client retries the busy-image sentinel.
- Audit actions are append-only for 180 days. Cleanup removes expired action and per-user-index
  records in bounded 512-action batches; while catching up, every new action runs another batch,
  then it returns to a daily cadence. **512 is cleanup batch size, not a player/game/action quota.**
  Pixel colours remain; pixels whose ownership action expired become unattributed in the admin inspector.

- Pixel Battle is one public 512×256 canvas on a real two-colour Natural Earth world-map PNG,
  with no room creation, join code, or matchmaking.
- The immutable `panorama/images/pixelbattle/world_map.png` base is generated from the public-domain
  Natural Earth 1:110m land polygons directly at 512×256. One source texel is one placeable canvas
  pixel, so coastlines cannot contain filtered subpixels inside an editable cell.
- The **64×32** input grid is reused at every zoom. Overview clicks drill into a region; at **8×**
  (the max) each input cell maps to exactly one canvas pixel. The grid doubled from 32×16 in
  2026-08-01 precisely so that drawing is reachable at 8× — the old grid only reached one-cell-per-
  pixel at 16×. ⚠ **The viewport must divide EXACTLY by the grid**: 768/64 = 384/32 = 12px per cell.
  That is why the frame is 768×384 and not the old 800×400 — 800/64 is 12.5, and a fractional cell
  reproduces the GeoGuesser off-by-one (§8.11), where the engine rounds the laid-out cell while the
  click arithmetic does not and the selection drifts further the further right you click.
  `VIEW_W/VIEW_H` (client), `PX_VIEW_W/H` (worker) and `.mg-px-grid` (CSS) are one number in three
  places; `mg_release_ui_regression_test.js` fails if they disagree or stop dividing evenly.
  At every zoom the Worker composites the base and
  shared paint into a compressed native 768×384 viewport using nearest-neighbour boundaries,
  bypassing Panorama texture filtering in previews as well as the editor. Navigation stores an
  integer top-left pixel rather than a fractional centre, so server pixels and pending client
  pixels share the exact same boundaries. Arrow/reset/zoom controls provide navigation without
  relying on `GameUI.GetCursorPosition`, which Deadlock does not expose.
- Terrain, the regular paint colours, and the ocean/land swatches have one source of truth in
  `tools/assets/pixelbattle_palette.json`. The map builder emits both client and Worker constants;
  `mg_pixelbattle_palette_test.js` enforces uniqueness and minimum CIE L*a*b* distances between
  paint/terrain colours so a swatch cannot silently become indistinguishable from ocean or land.
- **The palette IS the official wplace set (2026-08-04, v1.2): its 63 colours plus our ocean/land,
  65 swatches over 75 storage indices.** It started as r/place's 16, grew to 49 hand-picked
  colours, and then moved wholesale onto wplace's because the hand-picked set was measurably
  mis-tuned — our `red` was `#ff4500`, which is CSS **OrangeRed**, and read as orange in-game, with
  a ΔE-50 hole between it and `orange`. The official values were extracted from the Blue Marble
  userscript bundle (`SwingTheVine/Wplace-BlueMarble`), which carries them as `{id, premium, name,
  rgb}` records — not retyped from a blog, and not from wplace.org itself, which sits behind a
  Cloudflare challenge. Five things about this are load-bearing:
  - ⚠ **An index may never CHANGE MEANING, but its HEX may be retuned in place.** A pixel is
    persisted as its 1-based index, so inserting or reordering before the end recolours the live
    canvas. Retuning is different and is what this migration did: the pixel keeps its index and
    simply renders in the new shade. Median shift to existing art was **ΔE 8.3**, max 21.4 — the
    world stayed recognisable. `mg_pixelbattle_palette_test.js` therefore pins **positions**
    (`FROZEN_ROLES`), not colours.
  - **Two indices may legitimately share a hex.** Retuning collapsed 10 older indices onto a shade
    another index already had. They stay in storage so pre-retune art still renders; `displayOrder`
    lists each **distinct shade** once, so the picker shows 65 rather than 75. The client folds a
    duplicate index onto the drawn one (`canonColor`) — without it, the eyedropper could report a
    hidden index and highlight no swatch at all.
  - **The terrain ΔE floor is gone, and that is a design change, not a relaxation.** Ocean and land
    used to be "the background you must not disappear into", so paint had to stay ΔE 19 away from
    them. They are now two ordinary swatches in the set, so proximity to them is just proximity to
    two more colours. The pair floor dropped to 5 for the same reason: **wplace's own set is denser
    than our old floors allowed** — it ships deliberate shade ramps (Dark Slate/Dark Gray ΔE 6.0,
    Stone/Tan 8.1, 17 pairs under 15), so a floor of 15 would have rejected the real palette. What
    still protects the player is the assertion that no two *shown* swatches are identical.
  - **Custom hex is impossible by construction**, and worth knowing before it is proposed again:
    tiles are `Uint8Array` of palette **indices** and `/pxview` returns an **indexed** PNG
    (colour type 3 + PLTE), so the wire carries colour *numbers*. The ceiling is 256 entries
    (0 = eraser), leaving room for ~180 more colours.
  - The admin panel's colour names used to be a hand-written array in `worker.core.js` parallel to
    the generated palette. It is generated now (`PX_COLOR_NAMES`); the old copy would have rendered
    every added colour as `color 19`, `color 20`… in the audit log and the pixel inspector with
    nothing failing.
- **The eyedropper (`/api/pxpick`) has to be a server round-trip.** Panorama cannot sample a colour
  out of the viewport bitmap it is already displaying — the only channel back from an `<Image>` is
  its two dimensions (§2) — so the pixel is *named* by the Worker: one request answers
  `d(paletteIndex, 0)`. Data always sits at `h=0`, which keeps the `h=63` error band unambiguous.
  Two deliberate choices: an **unpainted** pixel answers with the terrain swatch under it rather
  than the eraser (the player asked "what colour is this?", and for bare map the honest answer is
  the ocean/land swatch they can actually select — those indices come from the generated palette,
  never a hard-coded 17/18); and the route validates coordinates with `pixelCoord`, **not** the
  `clampInt` that `/api/pxview` uses. Clamping is right for a viewport origin and wrong here —
  `x=512` would slide to 511 and return a confident colour for a pixel the client never asked
  about, which the client has no way to detect. It is armed only at 8× (one hit cell = one canvas
  pixel, so a pick is never ambiguous) and disarms on the sample and on any zoom change, since a
  mode left armed below max zoom would silently eat the next click.
- ⚠ **The control strip is an exact width/height budget, not a flexible row.** Navigation 208 +
  palette 368 + actions 192 = **768**; a swatch is 14px + 2px margin so 23 × 16 = 368 across and
  3 × 16 = 48 down (inside the 62px strip, so the palette grew from 34 to 65 swatches without
  growing the modal), and the four tools wrap as 2 × (91 + 5) across by 2 × (28 + 3) = 62 down.
  Panorama's `right-wrap` has no fractional slack: a size that does not divide the row evenly
  spills an extra row, which grows the modal into the ui-scale viewport clamp (trap 20) and can
  drop UPLOAD out of the clipped strip with no error anywhere. The current-colour readout lives in
  the **topbar** for this reason — a 62px-tall chip in the actions row pushes a button out of it.
  Change the swatch count and this arithmetic together.
- The server-authoritative bank is 100 pixels, regenerating 1 per 30 seconds and keyed by the
  Steam32 account id discovered through the local party avatar panel.
- Eraser batches use colour index 0: the Worker removes stored paint to reveal the immutable map,
  deletes a sparse tile when it becomes empty, and charges only pixels that actually changed.
  On the client, erasing a still-local paint cancels that queued change instead, immediately
  returning its reserved pixel. Navigation uses a fixed two-row zoom group plus keyboard-style
  arrow D-pad so adding controls cannot push a direction button onto a third row.
- **UPLOAD is the only thing that commits paint.** A placed pixel stays local until the player
  presses it. `MIN_BATCH` / `PX_MIN_BATCH` are **1** (they must stay equal, or the server rejects
  the client's smallest real batch as malformed) so a single-pixel UPLOAD is legal; the old
  10-pixel floor existed to keep request count down on Cloudflare's shared 100k/day bucket, and
  the VPS is not metered per request. ⚠ **Do not reintroduce the auto-flush.** A debounced
  self-upload shipped on 2026-08-01 and was reverted the same day: it took away the player's last
  chance to change their mind, and in-game it read as *pixels placing themselves without UPLOAD
  ever being pressed*. `mg_release_ui_regression_test.js` now fails if `AUTO_FLUSH_S` /
  `scheduleAutoFlush` come back, or if `placePixel` calls `uploadPending`.
- Uploads contain 1–128 unique pixels. The client checks and batches first; the Worker deduplicates,
  validates the bank again, rate-limits uploads, and persists modified 32×32 tiles. The shared
  per-IP budget described above prevents Steam32 rotation from resetting this protection. Player
  uploads and admin paint/undo commit tiles/version, audit, and ownership in one storage transaction
  (player uploads include the bank debit in that same transaction).
- Clients poll only the 12-bit canvas version, every **20 seconds** flat, and download the 512×256
  shared PNG only when that version changes. The old 8→15→30s idle backoff ladder existed to protect
  the Cloudflare request bucket; without that constraint a steady cadence is simpler.
- ⚠ **Never blank the viewport while its replacement loads.** `scheduleCrispView` /
  `refreshCrispView` used to set `crispImage.style.visibility = "collapse"` the moment a refresh was
  scheduled, but the new frame is a 0.12s debounce **plus** a full FIFO round-trip away — so the map
  went black for roughly half a second on every pan, zoom and version poll (the maintainer's
  "картинка пропадает во время обновления" report, 2026-08-01). The swap at the end of
  `refreshCrispView` is already atomic (size → parent the new panel → delete the old), so leaving
  the loaded frame up costs nothing. **This is not the hiding trap 23 forbids**: that one is about
  the *incoming* panel being loaded — a zero-opacity `<Image>` is never loaded at all — whereas this
  is the *outgoing*, already-loaded one, which the engine's loader never looks at again. `crispReady`
  still drops to false, so grid clicks stay blocked until the visible frame actually matches the
  requested rectangle.
- ⚠ **Because the stale frame now stays up, a failed viewport load is INVISIBLE** — the map looks
  perfectly normal while `crispReady` is false and every click is refused with "Map view is still
  loading." Before the blanking was removed the player at least saw a black viewport and knew
  something had gone wrong. Both failure paths (the display exception and `loadImage`'s error
  callback) therefore arm `scheduleCrispRetry`; only the busy-sentinel path ever retried on its own.
- ⚠ **`v` on `/api/pxview` is a CLIENT cache key, not a server parameter.** The Worker routes on
  `x/y/z` and always renders the canvas's current version — it never reads `v`. It exists only to
  stop Panorama serving a cached bitmap for an unchanged URL, so it must track the **server's**
  version and nothing else. An optimistic `+1` after an accepted upload lied twice: the server skips
  the version bump entirely when a batch changes nothing (`changed.length === 0` — e.g. erasing an
  already-blank pixel), and the client wrapped at 4096 against the server's `PX_VERSION_MOD` of
  `63*64 = 4032`, so after a server wrap the two sat permanently 64 apart. Once ahead, the poll saw
  a real difference and fired a refresh, but that refresh requested the client's inflated `v` —
  possibly already cached from the bogus bump — and Panorama served the stale bitmap, so another
  player's paint silently never appeared until you panned. The upload path now leaves
  `knownVersion` alone and, when the queue drains, re-reads the authoritative version instead of
  refreshing blind (refreshing with the pre-upload number would re-serve the pre-upload frame and
  hide the player's *own* paint).

- Every accepted player batch is also stored as an append-only retained audit action containing
  Steam32, timestamp, and exact per-pixel `before → after` deltas. The browser admin at `/admin` can search
  this log by Steam32, paint without using a player's bank, and undo an action. Safe undo skips
  coordinates changed by somebody later; force undo is explicit and overwrites those conflicts.
- `/admin*` fails closed unless GitHub OAuth is configured with `GITHUB_CLIENT_ID`,
  `GITHUB_CLIENT_SECRET`, the owner's stable numeric `ADMIN_GITHUB_ID`, and a random
  `ADMIN_SESSION_SECRET`. Login uses OAuth state + PKCE, calls GitHub's authenticated-user API,
  compares the exact numeric ID, discards the OAuth token, and issues an eight-hour
  HttpOnly/Secure HMAC-signed cookie. None of these values are source constants. The Durable
  Object is private and receives only the outer-Worker-verified GitHub login through an injected
  header; mutation routes additionally require same-origin + a custom CSRF header.
- Admin ban/unban state is stored by Steam32 and audited alongside paint actions. The normal
  client performs one `/pxbank` access preflight before loading the canvas: a ban renders a red
  `YOU ARE BANNED` button and sends no Pixel Battle view/version requests. `/pxput`, `/pxbank`,
  `/pxview`, and identified `/pxversion` all reject banned IDs; an already-open client sees the
  marker on its next poll and stops. Unban requires a client reload because a banned client
  intentionally does not poll.
- The browser editor is not constrained by Panorama: its canvas has cursor-centred wheel zoom
  from fit to 3200%, `−`/`+`/Fit controls, a persistent Pan mode, Shift/middle-button panning,
  live logical pixel coordinates, and interpolated drag painting. The map lives in a bounded
  scroll workspace so high zoom does not push the audit log thousands of pixels down the page.
  It loads a protected native 512×256 composite from `/admin/api/canvas`; it must never reuse
  Panorama's 768×384 `/pxview`, because that route has already rasterised 512 logical columns
  into a non-integer display width and cannot be losslessly downsampled back for editing.
- Every current pixel is attributed through a compact `px:o:<tile>` ownership record: one
  deduplicated action-id dictionary plus a `Uint16Array(1024)` per touched 32×32 tile. An
  accepted paint reuses the ownership read that captures its previous owners, then performs
  one ownership write per touched tile; it creates no additional client request. Undo restores
  both the previous colour and previous owner. For pre-index actions, Inspect scans the existing
  retained audit log once for that coordinate and caches the answer in the ownership tile.
- Action lists contain summaries only. Preview fetches one full action on demand, computes each
  pixel's current colour and whether safe undo would still apply, renders the exact post-undo
  colours, marks conflicts red, and zooms to the action bounds. Inspect makes one on-demand admin
  request per clicked coordinate and exposes the owning Steam32, action, user log, and ban path.
  ⚠ **That route is `/admin/api/owner`, and the name is load-bearing — it must never contain
  `pixel`, `track`, `analytics` or `telemetry`.** Unlike everything else in this mod, the admin
  panel is an ORDINARY BROWSER PAGE, so every request it makes passes through the operator's
  ad/tracker blocker before it reaches the network. EasyPrivacy ships **generic** filters — no
  domain anchor, matched on path substring alone — and one of them is literally `/api/pixel?`.
  The eyedropper originally lived at `/admin/api/pixel` and uBlock Origin killed it in the
  browser (2026-08-04).
  - **How it presented:** `NetworkError when attempting to fetch resource` on Inspect only, while
    undo, ban, preview, canvas and stats all worked — because none of those paths carry a
    blocklisted token. That split is the tell.
  - **What pinned it:** `zgrep 'admin/api/pixel' /var/log/nginx/access.log*` returned **zero**
    matches across all retained logs, while `/admin/api/action` and `/admin/api/state` were there
    from the same session and the same second. A request that never reaches Nginx was never sent,
    so the fault is client-side by elimination — no server code can be responsible. Reproduced by
    downloading EasyPrivacy and matching the URL against its generic rules.
  - **Do not diagnose this as a server bug.** The server logs will be silent, `curl` will answer
    normally (401/200 as appropriate), and the route will look perfectly healthy from a shell.
  - `mg_vps_server_test.js` now checks every admin URL the browser requests against a hard-coded
    list of ad-blocker path tokens. It is offline on purpose — fetching live blocklists would make
    the suite depend on the network and someone else's release cadence. Add new admin routes to
    `ADMIN_BROWSER_URLS`.
- Steam32 is client-reported, not a cryptographic Steam authentication ticket. A modified client
  can spoof an unbanned ID, and server-side rejection happens only after the VPS has received
  the request. The ban is therefore authoritative for normal clients and all requests using the
  banned ID, but it cannot be an edge-level request-cost firewall without a separate identity
  service or verifiable Steam ticket.

---

## 8.10 Wordle (mg_wordle.js)

- Wordle is fully offline: no Worker route, account id, lobby, bot, or polling.
- `mg_wordle_words.generated.js` contains 3,158 possible answers and 11,697 additional accepted
  guesses from the pinned MIT-licensed `ayaanhossain/weldor` wordbase. It loads immediately before
  the controller and is checked into the VPK sources, so gameplay performs no dictionary request.
  `tools/build_wordle_words.js` validates five-letter ASCII words, duplicates, and list overlap
  before regenerating the file.
- The controller self-registers game id 8 and is mounted directly from its picker detail view.
  The existing local Play Again path remounts it with another answer.
- Six explicit rows of five tiles and three explicit keyboard rows avoid Panorama wrap/layout
  ambiguity. Input arrives BOTH ways: a hidden `TextEntry` overlapping the board captures the
  physical keyboard (`ontextentrychange` per keystroke, `oninputsubmit` on Enter — the game's own
  idiom), and the on-screen keyboard rows remain clickable. The physical path is the primary one.
- `scoreGuess(answer, guess)` uses two passes: exact matches consume first, then remaining answer
  letter counts are consumed by present matches. This prevents duplicate letters in a guess from
  receiving more yellow/green marks than the answer actually contains; `mg_wordle_test.js` covers it.
- Visual layout is reasoned from the existing Panorama CSS patterns and still needs a VPK repack
  and in-game verification.

---

## 8.11 GeoGuesser (mg_geoguesser.js)

- GeoGuesser (game id 9) uses the existing two-seat Quick Match/private-room lifecycle and a
  server-backed Play Solo variant. A match has five rounds. The server selects five non-repeating
  locations from a **prebuilt worldwide pool**, accepts one map-cell guess per human seat,
  calculates distance scores, and hides all reveal data until the round is complete. In solo it owns
  an opaque synthetic seat, fills that seat's guess/ready state, and therefore reveals and advances
  without a second client.
- The pool ships with the server (`server/geo_pool.generated.js`, compiled from
  `server/geo_pool.json`), so **forming a lobby makes zero catalog requests** — a match starts
  instantly instead of waiting on a cold sweep. It mixes two CC-BY-SA 4.0 sources, Panoramax and
  Mapillary, under an equal per-region quota with a 500 m minimum separation, and the five rounds
  prefer distinct regions. There is still no manually curated location list, no Google API key and
  no billing dependency.
- **Trap: the world cannot be swept live, for two different reasons.** Panoramax returns frames in
  sequence/upload order, so a wide bbox drains one densely-mapped route before reaching anywhere
  else — measured 2026-07-31, `bbox=-10,35,30,60` (all of Europe) returned exactly **one** sequence
  even at `limit=1000`, which reads like "no coverage there" and is wrong. Mapillary refuses the
  opposite way: its bbox is capped at **0.010 square degrees everywhere**, even over empty desert,
  putting a thorough worldwide sweep at ~2.5 M cells. Sub-celling Panoramax fixed the spread but a
  live sweep still could not be both quick and varied, so the pool moved offline
  (`tools/build_geo_pool.js`, harvesting Mapillary's z6 coverage **tiles** rather than bboxes).
  Two routes that do **not** work and should not be re-tried: a bigger Panoramax `limit`
  (40 → 1000 kept Europe at one sequence), and the two-step `/api/collections` →
  `search?collections=` (collections **ignores** the bbox — an Oceania cell came back with German
  coordinates — and returns nothing for `field_of_view`).
- **Trap: a Mapillary coverage tile's geometry is not its image's position.** A z6 tile feature is
  a whole sequence (a LineString of a full drive) carrying one `image_id`. Taking any point off
  that line puts the target somewhere the photo was never shot: measured over 24 pooled rows, the
  sequence midpoint sat a median **427 m** and up to **18.9 km** away, and a full re-resolve of
  2400 rows corrected a median 511 m with a worst case of 111 km. In a guessing game that is not a
  rounding error — the panorama shows one town while the reveal marks another. Every pooled id is
  therefore resolved against `/images/{id}` at build time and stored with its own
  `computed_geometry`, which also supplies the creator credit and drops the ~4% of tile ids that
  404. Verified after the fix: worst delta 0.1 m.
- **Trap: `camera_type` is usually `spherical`, not `equirectangular`.** Both mean a true 2:1
  strip. Filtering on `equirectangular` alone reported **zero** 360° coverage in all 14 sampled
  metros, which looks exactly like "Mapillary has nothing here".
- **Trap: a catalog claiming 360° does not guarantee a 2:1 image.** The field of view describes the
  camera, not the derivative that gets served. Measured 2026-08-01: 11 of 58 pooled Panoramax rows
  delivered partial panoramas, ratios from 0.87 to 7.67 (e.g. 2048×267), which the wrap engine
  renders as a smear. `tools/build_geo_pool.js --verify-images` measures the delivered bytes and
  drops them.
- Mapillary is optional and server-side only. `MG_MAPILLARY_TOKEN` lives in
  `/etc/deadlock-minigames.env` and never reaches a client: `thumb_2048_url` is signed and expires,
  so it is resolved per reveal and never cached or stored in the pool. Without a token the game
  runs on the pool's Panoramax rows. Coverage is genuinely complementary — of 14 sampled metros,
  Panoramax was empty in 8 and Mapillary in 4; together they cover 12. Mapillary alone rescues
  Seoul, Bangkok, Sydney, Delhi, Nairobi and Melbourne, while Panoramax alone covers Tokyo and
  Berlin.
- `/api/geoview` is authenticated with the lobby seat token and proxies the current panorama
  through the VPS. Panoramax URLs are constructed from a validated UUID; resolved Mapillary URLs
  are accepted only from `*.fbcdn.net`. Either way an upstream response cannot point the proxy at
  an arbitrary host. A bounded 12-image LRU protects memory, keyed by `source:id`. The picture id,
  exact coordinates and producer never reach the client before reveal.
- **Trap: `*.fbcdn.net` is blocked on some networks**, including the maintainer's workstation
  (measured 2026-07-31: it resolved to 127.0.0.1 there, while the VPS fetched the same image fine).
  `graph.mapillary.com` keeps answering, so the failure looks like a black round rather than a
  network fault. `tools/mg_geo_source_check.js` samples the live pool and must be run **on the
  VPS**. The same interception hits `tiles.mapillary.com`, which answers 200 with an HTML login
  page; the pool builder treats that as a hard error rather than an empty tile, because swallowing
  it once silently wrote a degraded pool over a good one.
- `MG.Net.loadImage` reports the request panel's **layout** dimensions, not necessarily the source
  image's intrinsic dimensions. Its 640px request host can clamp the remote image before
  reporting dimensions, so GeoGuesser must not aspect-check those values.
  `MG.Net.isLevelEncodedSize` instead detects the calibrated 0..63 Worker error-PNG range; every
  successful panorama lies outside it.
- Panorama has no projection shader available to this mod. The client therefore displays a clipped
  2:1 equirectangular strip three times side by side and translates the strip to wrap heading at
  360 degrees. The 2048×1024 sources fill a fixed 2880×1440 stage (`scaling: "cover"` — an unknown
  token such as the old `"stretch-to-fit"` silently paints the source at native size, centred, see
  trap 24), so the 860px viewport is roughly a 107-degree crop. Copies use a shared 2878px step
  (2px overlap), which removes the old 240px black seam, and all three load through the shared FIFO
  (trap 23). This is still not a rectilinear lens projection: straight lines bow near the edges.
- Yaw wrap must not animate. Normalising 359°→0° re-centres the strip by a whole 2878px step, and
  the 0.04s transition turns that into a fast full spin, so the transition lives on a toggled
  `.mg-geo-anim` class that `applyCamera` removes for the wrap frame only.
- All four stacked rows (stats, viewport, camera bar, map row) are **860px** wide. They were 720
  and centred above an 860 map row, which made the panel read as ragged. The reveal labels are
  `fit-children` plus a flexible spacer, so an empty place/credit collapses instead of reserving
  88px of blank column above the action button.
- Pitch is `PANO_H / 180` = 8px per degree; drag is 1:1 (`360 / PANO_W` degrees per pixel) so the
  grabbed point stays under the cursor.
- The map zooms on **double-click** and resets on **triple-click**. The engine exposes no
  `ondblclick`, so a click run is measured by `Date.now()` timestamps within 400ms; the run is
  keyed on time only, not on cell identity, because zooming re-centres the clicked cell and a
  cell-keyed run could never reach three. Only the wrapper grows (real layout width/height, not a
  raster `pre-transform-scale2d`), so the map `.vtex` stays crisp. The first click still selects
  immediately — zoom never debounces the guess. A new round resets to 1×.
- **Zoom is what buys precision, and that only works because the hit grid does NOT scale.** The
  grid is 64×32 real `Button` panels — a global 512×256 grid would be 131k panels and destroy
  layout — so it is a **sibling** of the zoom wrapper, pinned over the 512×256 window. At zoom Z
  it spans 1/Z of the world, giving an addressable 64Z × 32Z; at the 8× cap that is exactly the
  authoritative 512×256, i.e. ~78km per cell instead of the old flat 64×32's ~626km. When the grid
  lived *inside* the wrapper it scaled with the map, so zooming only made the same coarse cells
  bigger. `FULL_W/FULL_H` (client) must equal `GEO_GRID_W/H` (worker) and `GRID_* × MAP_ZOOM_MAX`.
- **The map window must divide EXACTLY by the hit grid, or every guess lands left of the cursor.**
  The window was 500×250 against a 64×32 grid, i.e. **7.8125px** per cell — and Panorama lays
  panels out on whole pixels, so the engine rounded each `.mg-geo-cell` to 8px while `clickCell`'s
  arithmetic still believed 7.8125. The two agree only at the left edge and drift apart across the
  map: they first disagree at x=47 and the error reaches **two cells** at the right edge. That was
  the maintainer's "always selects one cell to the left" report (2026-08-01) — genuinely left of
  the cursor, and worse the further right you clicked. Fix: **512×256** (512/64 and 256/32 are both
  exactly 8), with the right column 342→330 so the row still totals 860. `mg_geoguesser_map_test.js`
  now asserts the DIVISIBILITY rather than a magic number, and that the CSS window matches `MAP_W/H`
  — a resize stays free as long as it stays exact. ⚠ The same trap applies to any future hit grid:
  a fractional cell size is silently rounded, and the resulting drift looks like an input bug.
- **The reveal target is bigger than the guess dots AND painted last.** Panorama paints siblings in
  creation order and `showReveal` reads the target first, so the guess dot — created later — covered
  it. At 1× the whole world is one map wide, so an accurate guess is sub-pixel away: a 743/750 round
  (~23km) put the two 9px dots **0.29px** apart and the violet answer vanished completely (the
  maintainer's round-1 screenshot showed no target at all). Both halves are load-bearing — the size
  difference (`TARGET_SZ` 15 vs `MARKER_SZ` 9) keeps a ring visible on a dead-on guess, and
  `raiseTargetMarkers` re-parents the target to the front so it is not simply hidden.
- **The reveal auto-advances after 10s**, counting down in the button's own label
  (`NEXT ROUND (9)`) rather than adding a second widget; clicking still works and just runs the same
  idempotent `readyNext`. ⚠ It needs its own `$.Schedule` generation counter (the `createTurnTimer`
  `gen` lesson): `beginRound`, `finishGame`, `readyNext` and `destroy` all cancel it, or a stale tick
  fires `readyNext` during the NEXT round.
- **The LOOK/TILT slider row is hidden, not deleted**, and the round timer takes its slot as a
  horizontal bar. The sliders are kept as the working reference for the next slider we add —
  including the de-glow specificity fight in trap 22, which only documents anything while real
  panels carry those selectors. They stay wired (`applyCamera` still writes their values); the row
  is just `visible = false`, which collapses it so the timer occupies the space.
- **Pacing is deliberately "both, then both": nobody is rushed and nobody is skipped.** A round
  reveals only once **both** seats have guessed, and advances only once **both** press next — so a
  player who solves it in 15s waits on the reveal screen for one who takes a minute, and the slow
  player is never cut off mid-thought. The 60s round timer is what bounds that wait (an expiry
  submits the selected cell, or cell 0), and the reveal's own 10s countdown bounds the second half.
  A seat cannot change a locked guess (`(9,1)`), cannot advance before the reveal (`(9,2)`) and
  cannot read the target early (`(1,63)`) — all verified against the running Hub.
- **Leaving is ASYMMETRIC around the final round, and both halves were real bugs.** Mid-match a
  departure genuinely ends the lobby: the reveal is gated on both guesses, so a one-sided game
  cannot continue, and the remaining client reads `(9,9)` and returns to the menu. **After** the
  fifth round both players sit on the scoreboard with reveal reads possibly still in flight, and
  deleting the lobby there kicked the reader off their own results with "Opponent left." A finished
  lobby therefore **survives** one seat leaving — the seat is nulled, `geoLobbyAccess` exempts a
  completed match from its two-seat check (nothing in it is secret to its own seats any more, and
  it stays token-gated against strangers), and the remaining client keeps reading the `(6,40)` done
  reply until it leaves on its own. The 30-minute sweep still collects it. Covered by
  `mg_server_test.js` on both sides.
- Panoramax reports exact coordinates and the server keeps them exact — `geoRoundScore` measures
  from the true lat/lon, never from a quantised cell. Only the player's guess is quantised, which
  is why raising its resolution costs nothing on the scoring side.
- Reveal markers are **world-anchored panels** in the zoom layer, not tinted grid buttons: a
  button points at a different place the moment the window pans. The label and marker layers are
  `hittest: false` so the grid above still receives every click.
- The map is a 2048×1024 Natural Earth composite (`tools/build_geoguesser_map.js`, pure Node +
  zlib — no `sharp`/`canvas` in this repo): 1:50m countries/land/lakes/rivers, 1:110m state lines,
  and 243 populated places as dots. All public domain, no attribution required.
  **OSM was rejected deliberately**: tiles are ODbL and the tile usage policy forbids proxying or
  embedding them in an application. Antarctica correctly fills the bottom band — its polygon
  reaches −89.999° and equirectangular stretches the pole across the full width.
- **Land colour is sampled from Natural Earth II's natural-colour raster**
  (`tools/assets/ne2_natural_2048.png`, produced by `build_ne_raster.js` from a 40 MiB public-domain
  GeoTIFF; only the downsample is committed, so a clone needs neither the source nor a network).
  The country polygons act purely as a mask, and water is painted separately because that raster
  renders the ocean flat white. Two FLAT palettes were shipped and rejected — grey, then dark brown
  — before the real cause was accepted: the problem was never the hue, it is that a single fill
  cannot show a continent's variety. Amazon green, Sahara sand and Greenland ice now read as
  themselves.
- City *names* are Panorama `Label`s fed by the generated `mg_geoguesser_cities.generated.js`
  rather than baked pixels, because that PNG encoder has no font renderer. Two gates keep them
  readable and **both are load-bearing**: a `SCALERANK` limit per zoom (1x shows only the 27 rank-0
  capitals — `rank<=1` put 68 names on a 500px map) and a greedy overlap rejection that drops any
  label whose box touches one already placed. Rank alone can never separate Ljubljana from Zagreb
  at 30px apart, which is what made the Balkans an unreadable pile. Off-window labels are culled
  *before* the overlap test, or at zoom an invisible name steals a slot from a visible one.
- Because the map is light, the label ink is dark on a white halo and the markers are saturated
  fills with a white ring. The previous muted set (`#7199ba` blue, `#a9b88a` olive) was tuned
  against a dark grey map and vanished on cyan sea and green land; the reveal pin is violet
  precisely because nothing on a natural-colour map is purple.
- A round is on a **60 s** timer (`MG.Widgets.createTurnTimer` with a per-call override; the shared
  default is 25 s, which is barely enough to spin the panorama once). It attaches to `container`
  (`.mg-game-host`, `flow-children: none`) rather than the `.mg-geo` column, because the widget
  positions itself with `vertical-align` and inside a `flow-children: down` parent it would push the
  panorama down instead. Expiry submits the selected cell, or cell 0 when nothing is selected: the
  server reveals only once **both** seats have guessed, so a silent timeout would strand the
  opponent.
- Direct image drag reuses the chess/checkers `DragStart`/`DragEnd` + `MG.Widgets.winPos` pattern.
  Some Panorama builds expose the drag ghost position only at release, so two native `Slider`
  controls are the continuous path: `onvaluechanged` updates heading and pitch while the thumb moves.
  Arrow buttons remain an accessible fallback. The sliders are de-glowed by repeating the game's own
  `Slider.HorizontalSlider` selector prefix (trap 22).
- The guess itself never sends latitude/longitude: the client resolves its click to a linear cell
  in the shared 512×256 space and the server converts that back to coordinates, so the hidden
  location stays server-authoritative. Height 63 remains the point-error sentinel.
- After reveal the answer is named as `continent · country` (e.g. `Oceania · Australia`). Both the
  country and the contributor credit are **indices into tables that ship with the mod**
  (`panorama/scripts/mg_geo_credits.generated.js`), not text on the wire. They are decided offline
  at pool build time: `tools/lib/country.js` resolves each location against a vendored Natural Earth
  set (public domain), and `tools/build_geo_credit_tables.js` emits the server and client tables
  from the same source so their indices cannot drift.
  **Trap:** the credit used to be transported as text, two characters per request — a 49-character
  line was 26 chained round-trips, and `showReveal` held the button on `LOADING RESULT…` until the
  last one landed. That was the whole cause of the long post-guess wait; nothing about the string
  was ever dynamic. The continent travels with the country because a country does not imply one:
  Russia, Turkey, Kazakhstan, Egypt and Indonesia straddle a divide and are resolved per point.
- Server authority and protocol codecs are covered by `mg_server_test.js`; registry/load order and
  the native-input guards are covered by the release UI regression test. Projection, layout and
  drag feel still require an in-game VPK check.

---

## 9. Turn/sync model (the 2-int games)

**Server-authoritative predict-and-confirm.** Each player applies a move locally FIRST for
instant feedback (the local rules act as a predictor), then relays it with the seat token
(`sendHops` / `sendMove` / `sendChessMove`). The server validates it (§5.1) and either
appends it to the shared log (accept) or returns `(9,x)`. On accept, the other side **polls**
(`pollOnce`) with `since = appliedSeq` and applies returned moves; `end=1` marks the
turn-ending hop and hands the turn back. On reject, the mover's `rejectAndResync` discards the
prediction, rebuilds the board from the accepted log (`replayAccepted`), and resumes polling —
so an honest desync self-heals and a cheat's illegal move never enters the log for the
opponent to see. Poll tokens (`pollToken`) invalidate stale loops after a view change. In
**bot/offline** mode there is no server: after your move the bot is scheduled directly;
nothing is polled and no token is used.

Disconnect signals: `status` returning `(9,1)` while a host waits, or `poll` returning
`(9,9)`, route to `MG.UI.kickToMenu(reason)`.

**Adaptive poll cadence (load and latency control).** The direct VPS has no 100k requests/day
quota—the Cloudflare limit that forced the migration is gone. Polling still dominates active
traffic, so bounding it protects latency on the single shared vCPU and avoids wasting bandwidth.
The NLs-1 load test sustained roughly 1,000 empty polls/s; after native-zlib compression of the
dimension PNGs it sustained roughly 872 clock reads/s (a clock response fell from ~81 KiB to
~449 bytes). Expected traffic from 200–300 clients is well below both. The two distinct cadences
remain defined once in `mg_net.js`:

- **`MG.Net.pollDelay(misses)` — IN-GAME opponent polling** (`/api/poll`, `/api/dlog`, `/api/plog`),
  the dominant cost of an *active* match. `misses < 6` → **0.5s**, `< 18` → **0.9s**, else →
  **1.5s**. `misses` counts consecutive empty ("nothing new") polls this turn and is reset to 0 on
  each real move (and in `startPolling`), so a quick opponent reply normally appears within roughly
  half a second plus network/PNG-loader latency. The long-think tier still caps 300 continuously
  active clients near 200 empty polls/s instead of consuming most of the measured ~1,000 polls/s.
  Every game keeps a local `let pollMisses = 0` and passes `pollMisses++` to
  `pollDelay` in both the "nothing new" and transport-error branches.
- **`MG.Net.waitDelay(misses)` — WAITING-ROOM polling** (lobby/room fill, rematch accept, quick /
  multi matchmaking). Totally different cost profile: nobody's mid-move, latency is irrelevant (a
  chess lobby, not a shooter), and these screens can sit open for MINUTES — so a fixed ~1s poll was
  pure waste that scaled with idle players, not games played. Ramps HARD and monotonically (a
  waiting room has no "real move" to reset on): steps `[1.5, 1.5, 3.0, 3.0, 4.0, 5.0]`s, clamped at
  5s. Each waiting loop keeps its own `let misses = 0` and passes `misses++` in both branches. The
  four loops on it: shared `pollLobbyRoom`, `waitForJoiner`, `waitForMultiMatch`, and the rematch
  `tick` (`mg_ui.js`).

⚠ There is **no `Net` alias** in the controllers — call both fully qualified as `MG.Net.pollDelay`
/ `MG.Net.waitDelay` (a bare `Net.pollDelay` throws `ReferenceError` and, like the TTT `sfx` crash,
would only surface in-game — the test harnesses don't execute controller code).

### 9.1 Shared clocks & the per-turn timer (`MG.Widgets`, mg_games.js)

Two DIFFERENT time widgets, both built in `mg_games.js` and exposed on `MG.Widgets`:

- **Server side clocks** — the time-control matchmaking (1/3/5/10 min / Any) in **chess &
  checkers**. Each side's remaining time is server-owned; the picker lives in `renderTimeControl`
  (`mg_ui.js`) and the concrete/"Any"(−1)→5min mapping is described there.
  - **My clock is always the BOTTOM row.** `createClock` takes a `mySeat` arg (the caller passes
    `clockSeatFor(myColor)`); it builds the two rows top→bottom as `[opponentSeat, mySeat]` so my
    clock sits under the board I play from (my colour is always the bottom side — see `toDisplay`).
    The `rows[]` array stays SEAT-indexed, so `paint`/`setTurn`/`fireFlag` are unchanged — only the
    visual creation order flips. `mySeat = -1` (unknown) keeps the legacy white-top/black-bottom order.
  - **10-second warning.** `interpTick` fires `MG.Sound.play("TenSeconds")` ONCE when MY running bank
    (`sec[mySeat]`) drops to ≤10s. A chess/checkers bank only counts down, so it's at most one beep
    per game; `mySeat = -1` skips it. (The soundevent was always registered — the bug was that
    nothing ever *called* `play("TenSeconds")`; the per-turn timer's `tick()` fires the same sfx for
    durak/poker/TTT/C4, guarded by `curSecs > 10` so durak's 10s Bito window doesn't beep on open.)
  - **Display is locally interpolated, resync is rare.** The clock does NOT poll the server once a
    second. `createClock` runs a ~4×/s LOCAL interpolation (`interpTick`) that drains the running
    seat's bank between authoritative reads, and only resyncs against `/api/clocks` every
    `RESYNC_S = 8` s (`resyncTick`), which snaps the banks to the server values and applies flag-fall.
    The server stays authoritative (flag-fall is server-decided; a locally-interpolated 0 just PINS
    at 0 until a resync confirms it). This was a real bug fix, not a cosmetic tweak: the old
    once-a-second poll issued **2 requests/second for the whole game**, which (a) swamped the strictly
    one-at-a-time image queue in `mg_net.js` and stalled the move-poll so an opponent's move surfaced
    many seconds late (the "20s to see a move" / "his clock ticks on my turn" desync), and (b) burned
    backend load — ~2 short games ran up ~1200 requests almost entirely from this
    loop. Local interpolation keeps the display live for ~free; the 8s resync corrects drift.
- **Per-turn countdown timer** (`createTurnTimer`) — a `TURN_SECS = 25` budget per turn in
  **durak, poker, TTT & Connect Four**, and a 60s round timer in **GeoGuesser**. The controller calls
  `start(onExpire)` when the LOCAL human
  is put on the clock and `stop()` the instant they act (or a bot / online opponent takes over). If
  the bar empties, `onExpire()` fires exactly once — the controller turns that into a forfeit /
  elimination (offline decided locally, online sent as a forfeit). Key constraints, all already
  fought out in the code + trap 17:
  - **No `@keyframes`** — a stray keyframes rule silently BRICKS the whole modded HUD stylesheet
    (trap 17). The drain is ONE `transform: translate3d(0, H, 0)` write with a `TURN_SECS`-long
    LINEAR transition on `.mg-tt-anim` (the `.mg-piece` "set the value, let CSS tween it" idiom).
    A ~200ms `$.Schedule` loop only refreshes the seconds label + swaps low/crit colour classes and
    arms expiry; the motion is pure CSS.
  - **Never `visibility:collapse`** — the wrap is always laid out so the empty channel reserves its
    footprint permanently and the **modal never jumps height** when a turn changes hands. `TRACK_H`
    (280, must match `.mg-tt-track` height) is kept shorter than the shortest board so the flow host
    measures its height from the board, not the bar.
  - **`opts.boardW`** attaches the bar to that board's LEFT EDGE (TTT/C4 pass it — narrow centred
    boards; durak/poker omit it and keep the wide-felt gutter placement).
  - **`opts.horizontal`** lays the same widget out as a WIDE row instead of a tall column
    (GeoGuesser). Its stack is 860 wide and its camera row only 38 tall, so a 280px column does not
    fit beside a 360px viewport and the gutter placement has nowhere to sit. In this mode the bar is
    a plain flow child of the game's own column — no `boardW` shove, no `VNUDGE` (that offset
    corrects a `flow-children:down` wrap, which this is not) — and the fill drains by
    **negative** `TRACK_W`, i.e. it leaves through the LEFT edge so the remaining time stays
    anchored left and shrinks right→left like any depleting bar. (A positive slide parks the green
    block against the RIGHT edge and reads backwards — in-game, 2026-08-01.) ⚠ `TRACK_W` (792) must
    match `.mg-tt-horiz .mg-tt-track`'s CSS width exactly as `TRACK_H` must match the vertical
    track's height: it IS the drain distance, so a CSS-only edit empties the bar to the wrong place
    with nothing failing. The seconds label sits BESIDE the bar at **40px** — at 26 the engine
    ellipsised a two-digit count to `6…` while one digit was fine, and `text-overflow: clip` only
    trades the ellipsis for a chopped glyph.
  - **An authoritative action in flight parks the timer.** Durak/Poker set `pendingAct` and call
    `refreshTimer()` before entering the network FIFO, so an expiry callback cannot forfeit a move
    that the server is already processing. A rejection or transport failure clears `pendingAct`
    and starts a fresh local countdown; an accepted action stays parked until its echoed event
    changes the authoritative turn.

### 9.2 Sound (`MG.Sound`, mg_sound.js)

Panorama can only play a **registered soundevent by NAME** — no file path, no volume argument.
So volume is faked the **QOLLOCK way**: `tools/gen_soundevents.js` pre-generates one soundevent per
(sound, volume-step) — `MG.MoveSelf_V0 .. MG.MoveSelf_V20`, 21 steps of 0.05 — and `MG.Sound.play(name)`
picks the variant matching the current volume (silent when muted or vol ≤ 0). The header volume
dropdown (`buildSoundControl`, mg_ui.js) drives `setVol`/`setMuted`. Logical names used by the
games: `MoveSelf`/`MoveOpp`, `Check`, `Promote`, `Illegal`, `Premove`, `GameStart`, `TenSeconds`
(the last fired by the per-turn timer at the 10s mark). ⚠ If you add a sound, add it to
`gen_soundevents.js` and regenerate the manifest, or `play()` silently no-ops on the missing name.

---

## 10. How to work on this safely

Before committing, always:
```
npm run lint                                   # ESLint net: no-undef catches a call to a name not
                                               # defined in scope (the class of bug that ships green
                                               # past node --check: `sfx`/`Net` used where the
                                               # controller never declared them), plus
                                               # operator-linebreak, which keeps a shipped line from
                                               # starting with a binary operator (the Valve minifier
                                               # inserts a `;` there). See §10.1.
npm test                                       # the whole harness suite, in one command:
                                               #   build_worker --check   committed worker.js is in
                                               #                          sync with rules + core
                                               #   chess / rules / c4 / durak / poker  pure engines
                                               #   wordle / pixelbattle palette / widgets
                                               #   server                 worker protocol + lobbies
                                               #   parity                 client predictor ==
                                               #                          server authority
                                               #   update marker          release-marker decoding
                                               #   es6 codemod / es6 arrows
                                               #                          the two refactor tools'
                                               #                          hazard fixtures (§10.2)
```
If `build_worker --check` reports the worker is stale, run `npm run build:worker` and commit the
regenerated `server/worker.js` with your change — the Node VPS imports this deploy artifact.

A Public build additionally goes through `../tools/build_mod_strip_comments.ps1` (see §3), which
strips comments from a throwaway copy and refuses to build if stripping broke any script.

Then say plainly what is **verified** (syntax, pure rules, server protocol) vs what is
**only reasoned** (anything visual/animated/drag/hover — needs a VPK repack + in-game run
by the maintainer). Don't present unrendered layout or input behavior as confirmed.

### 10.1 The lint net (why it exists, what it does NOT cover)

The Panorama **controllers** (`mg_checkers`, `mg_ttt`, `mg_chess`, `mg_connectfour`, `mg_durak`,
`mg_poker`, `mg_pixelbattle`, `mg_wordle`, `mg_geoguesser`, `mg_ui`) have **almost no automated coverage**: they call
`$.CreatePanel` / `$.Schedule` /
`$.RegisterEventHandler`, so they can't run outside the game. `node --check` only parses
syntax; the `tools/*_test.js` harnesses exercise the pure engines (`rules/*.js`) + the worker,
never the controllers. That gap shipped two live `ReferenceError`s in one week (`sfx` used in the
TTT controller that never declared one; a bare `Net.pollDelay` where no `Net` alias exists) — both
crash only when their branch runs in-game, both invisible to every check we had.

The one exception: state-free helpers hoisted onto `MG.Widgets` (mg_games.js) CAN be tested, and
`tools/mg_widgets_test.js` does that for `winPos` / `parsePx` / `squareFromPanel` / `makeNavBtn` /
`setNavState`. Anything that reads a controller's closure (board, cells, history) still can't be
read directly — but it CAN be driven and observed through the panels, which is what
`mg_checkers_play_test.js` does for checkers (§10.1.1). Every other controller remains uncovered.
It is also possible to drive a whole view under a fake `$` — the lobby-room refactor was verified
that way — but that is a per-change harness, not standing coverage.

`npm run lint` (ESLint 9 flat config, `eslint.config.js`) is the cheap guard for exactly that
class. It is deliberately **narrow — a bug net, not a style linter**: `no-undef` (the one that
catches the above) plus a handful of always-safe correctness rules (`no-unreachable`,
`no-dupe-keys`, `no-duplicate-case`, `use-isnan`, `valid-typeof`, …). No stylistic rules, so the
output is signal, not noise, and it stays green on the working, in-game-verified code. The config
declares the Panorama globals (`$`, `Game`, `GameUI`, …) as read-only so real engine bridges don't
false-positive; the `server/` block is `sourceType: module` (Worker-compatible core plus the Node
VPS adapter), tools are CommonJS.

#### 10.1.2 Never blame the relay by guess (`MG.Net.diagnosis`)

Every network failure used to reach the player as **"Check the server"**. On 2026-08-03 that was the
wrong guess: a player reported the relay as down (ping, create, quick match, GeoGuesser and Pixel
Battle all timing out) while the VPS was serving `/api/ping.png` normally — verified HTTP 200 with a
valid cert. His console showed `dims stayed 0 for 8000ms` on all six probe attempts: **the engine
never loaded the image at all**, so there was nothing to decode and nothing the server could have
done. Because our message pointed at the server, the report pointed at the server too.

The discriminator costs nothing, because the mod already talks to **two unrelated hosts**: the relay
(a raw IP — no DNS, Let's Encrypt short-lived IP cert) and `raw.githubusercontent.com` for the
update check (needs DNS, completely different chain). A dead relay cannot stop a GitHub PNG from
loading. So *nothing loaded from either host* ⇒ outbound image loading is blocked locally (firewall,
proxy, AV, another mod) and we say so; the update check already runs automatically on the first
DL Arcade open, so the evidence exists by the time the player presses Create.

⚠ **The claim is gated on two DISTINCT hosts having failed, not on a failure count.** A count is too
eager and would make the message a lie: one update check against a hiccuping GitHub records **two**
failed loads (`drainQueue` silently re-queues a non-probe job once) and one calibration burst records
**three** (`PROBE_ATTEMPTS`), so any usefully-low count fires when only ONE host was ever
contacted — exactly the evidence that *cannot* separate "the relay is down" from "nothing loads
here". `loadsOk > 0` cancels the claim outright: if anything has ever loaded, the channel works and
the relay is a fair suspect again. GeoGuesser panoramas and Pixel Battle tiles are **proxied through
our own VPS**, so GitHub really is the only second host. `tools/mg_net_diagnosis_test.js` pins all of
it, including that no network error path calls `setStatus` with a hard-coded "Check the server"
(which could not be corrected at runtime — that is how the wrong blame shipped).

**How the engine actually fetches these images.** The loader dispatches on URL scheme into
`CLoadFileURLTask`, whose completion is a Steamworks `HTTPRequestCompleted_t` callback
(`game/bin/win64/panorama_strings.txt:413,493`) — i.e. remote images ride **Steam's HTTP stack**,
not a socket the mod controls. The engine also knows an **`ImageFailedLoad`** panel event
(`:3135`), but no shipped Deadlock layout or script listens for it, so `mg_net` subscribes to it
**opportunistically**: when it fires we fail in milliseconds instead of `REQ_TIMEOUT_MS`, and when
it never fires the polling timeout is still the authority and nothing changes. Both properties are
pinned by `mg_net_diagnosis_test.js`. This matters for a blocked machine: the failure used to take
3 probe attempts × 8 s of total silence before anything appeared on screen. Related failure strings
worth knowing: `Image '%s' size too large (... image load failing)` (`:4728`, a compiled-in cap with
no convar) and `Failed to load image data from %s` (`:2895`).

⚠ There is **no convar, setting or allowlist** that enables/disables remote image loading — checked
against all 13k lines of `DumpSource2/convars.txt`. So "tell the player to flip a setting" is not an
available answer; the diagnosis message deliberately points at firewall/proxy/AV/another mod.

**It still can't render.** Lint proves every referenced name exists and a few structural invariants
hold; it says NOTHING about layout, animation, drag/drop, timing, or whether a move looks right.
Those remain "in-game verified by the maintainer or unverified". `node_modules/` + `package-lock.json`
are gitignored and dev-only — nothing here is packed into the VPK.

When in doubt about a Panorama capability, **grep the game's own files**
(`G:\GameTracking-Deadlock\game\citadel\pak01_dir\panorama\`) or the maintainer's working
mod (`D:\GitHub2\QOLLOCK\panorama`) for a proven pattern — do not invent CSS/JS API.

#### 10.1.1 Driving a controller with clicks (`mg_checkers_play_test.js`)

`mg_load_smoke_test.js` proves each controller **evaluates**; it stubs `$.Schedule` to never fire,
so nothing in a controller's *behaviour* is covered. `tools/mg_checkers_play_test.js` closes that
for checkers: a fake `$` with a **real virtual scheduler** (timestamp-ordered, single-steppable)
plays full vs-bot games by firing the cells' own `onactivate` handlers, then judges the result from
the **piece panels** — inverting `translate3d` + `mg-white`/`mg-black`/`mg-king` back into a board.
So it asserts what is *on screen*, which is the only thing a player can actually report. Both
variants, both seats, seeded RNG (a failure prints a reproducing seed).

Three things it covers that nothing else could:
- **Softlock**: the player had a legal move, clicked exactly it, and the visible board didn't change.
- **Promotion is acknowledged**: random play loses in ~20 turns and never promotes, so the test
  plays the engine's own search and also starts from a crafted near-promotion position.
- **Impatient clicking**: the offline bot is *not* instant (stepped depth-5 search + 0.35 s per
  animated hop), so a real player clicks during its think — landing in the premove path. The
  harness single-steps the scheduler and clicks between steps to be genuinely mid-think.

⚠ **Trap: review mode at the live position.** Found this way (player report 2026-08-03,
"its not letting me move any other checkers either. im softlocked"). The move list is clickable and
the **newest row is the highlighted "you are here" row** — the most natural one to click.
`gotoReview(last)` used to call `setReview(last)`, rendering `history[last].boardAfter`, which *is*
the live position: nothing changed on screen, the status still read "Your turn.", but `reviewIndex`
was now set and `onCellClick` / `onCellDrop` / `DragStart` all bail on `reviewIndex !== null`. The
board went dead while looking and claiming to be live. Two aggravating factors, both fixed:
`setNavState` only *painted* buttons disabled (`.mg-nav-disabled`) while leaving them clickable — it
now sets `enabled` too — and a click during a real review was swallowed in silence, so there was no
symptom to report; it now says "Reviewing an earlier move. Press Live to play on." Reviewing the
live position is meaningless in every case, so `gotoReview(last)` routes to `navLive()`.
mg_chess.js had the identical three defects and got the identical fix.

### 10.2 ES6 in the shipped scripts (and the `var`s that must stay)

The Panorama JS runtime accepts `const`/`let`, arrow functions and template literals — not a
guess: QOLLOCK ships all three into the live HUD (`ql_core.js` uses `const` throughout,
`ql_hero_testing.js` has `` Cmd(`giveitem ${item}`) `` and `$.Schedule(0.25, () => {…})`).
Declarations here are `const` by default, `let` when reassigned; anonymous callbacks are arrows;
string building uses template literals where the leading operand is a string literal.

**Three things are deliberately NOT uniform, and every one is load-bearing:**

1. **33 surviving `var`s** (25 in `panorama/`, 8 in `tools/`). Each one would change behaviour
   if converted, because `var` is function-scoped and `let` is block-scoped: 21 are captured by
   a closure inside a loop (`let` would hand each iteration a fresh binding, changing what the
   handler sees), and 12 are used outside the block that would now scope them. If you touch
   one, you are changing semantics, not style. `tools/es6_codemod.js` reports the reason per
   site. (The loop-capture count is low because this code already used the pre-ES6 IIFE
   capture idiom — `((square) => { … })(i)` — so handlers close over a parameter, not the
   loop binding.)

2. **253 surviving `function` expressions.** An arrow has no own `this`/`arguments`, no
   `[[Construct]]`, no self-name for recursion, and ignores a `.bind()` receiver. Panorama
   calls some handlers with the panel as the receiver, so object-literal method values and
   anything reading `this` stay `function`. `tools/es6_arrows.js` reports why per site.

3. **862 surviving `+` concatenations.** 775 because the leftmost operand is not a string
   literal, and that is not fussiness: `a + b + "px"` with numbers sums FIRST ("3px"), while
   `${a}${b}px` concatenates ("12px"). A template is only equivalent when a leading string
   literal forces every `+` in the chain to be concatenation. The other 87 span lines, and
   re-flowing them risks the ASI rule below. `tools/es6_templates.js` reports per site.


⚠ **The minifier rule now extends to a leading `(`.** `operator-linebreak` (§10.1) keeps a
shipped line from starting with `+ - /`, but an arrow conversion can make a line start with
`(` — `function (a, b) {` at the head of a line becomes `(a, b) => {`. That is in the Valve
minifier's naive-ASI trigger set (`( [ + - /`), which is what broke a public build at
mg_games.js:665. ESLint does not cover the paren case, so the codemod does: it skips any
candidate that opens its line and refuses the file if any line would newly start with one of
those characters. **If you hand-write a callback, keep the `(` off the start of a line.**

Both codemods are one-shot tools kept for re-runs and for the reasons they record. Their
harnesses (`mg_es6_codemod_test.js`, `mg_es6_arrows_test.js`) run in `npm test` and are the
real specification: each executes a hazard fixture before and after and requires identical
output. They are not decoration — the `var` harness caught a generated
`for (const i = 0; i < 3; i++)` (instant "Assignment to constant variable") that came from
eslint-scope leaving top-level references unresolved under `sourceType: "script"`.

⚠ Those harnesses test the **tools**, not the shipped code — they would stay green if someone
hand-wrote an arrow reading `this`. Two further tests cover the code itself:

- **`mg_es6_invariants_test.js`** enforces the four properties above on the shipped tree: no
  arrow reads `this` or `arguments`, no `new` on an arrow, and no line newly starts with
  `( [ + - /` (delta against a recorded baseline of 62, since IIFE openers legitimately do).
  Its detectors **self-test against injected faults first** — the original version silently
  passed an arrow using `this` because it looked for the first non-arrow "binder" in the
  enclosing chain, which always finds the controller IIFE. The right question is whether
  `chain[0]` is an arrow.
- **`mg_load_smoke_test.js`** evaluates all 23 shipped scripts under a fake `$` in the real
  `base_hud.xml` order, and asserts each publishes its entry points (the six engines,
  `Net`/`Api`/`Sound`/`Widgets`, and a real `create()` for all 9 enabled games rather than a
  silent `createStub()`). This is the first execution coverage the controllers have ever had;
  it catches "throws on load", which `node --check` cannot see. It still does not render.

Not adopted: `block-scoped-var` and `no-use-before-define` as ESLint errors. They flag 82
pre-existing benign sites (module-level consts read inside functions that run later, plus the
25 deliberately-kept `var`s in shipped code), so the noise outweighs the signal.


