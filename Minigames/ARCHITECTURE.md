# Minigames — architecture & Panorama field notes (for AI sessions)

This file is the memory we don't want to lose. It explains **how the mod is wired**,
**why** each non-obvious decision was made, and the **Panorama gotchas** that cost real
debugging time. Read this before touching the code — several "obvious" fixes here are
wrong and are documented as traps below.

Nothing in this mod can be verified by rendering from a shell. Panorama only runs inside
Deadlock, and testing requires a **VPK repack + launch**. So: `node --check` + the two
test harnesses (`tools/`) are the only automated safety net; everything visual is
"confirmed in-game by the maintainer" or "unverified, reasoned from the game's own CSS".
When you change layout/animation/input, say honestly which of the two it is.

---

## 1. What this mod is

Online mini-games played **inside Deadlock's pause (Esc) menu**, without leaving the
match. Shipping games (all online + vs bot): **Checkers** (Russian draughts),
**Tic-Tac-Toe**, **Chess** and **Connect Four**. **Durak** plays vs bot for 2–4 players
and **online for 2 players** (worker-as-dealer, §8.6); 3–4-seat online is deferred. **Poker**
(No-Limit Texas Hold'em, §8.8) plays vs bot and **online for 2–4 players** (worker-as-dealer,
same private-deal channel as durak) — the online path is built + Node-tested but not yet
in-game verified.

Shared UI features across the games: a **per-turn countdown timer** (§9.1) in durak / poker /
TTT / Connect Four, **server-authoritative side clocks** (time-control matchmaking) in chess /
checkers, **move history + local review** (chess / checkers), a **Play Again / rematch**
handshake, a header **UI-scale dropdown** (trap 20) and a **volume control** (`mg_sound.js`).


Picker cards show a custom **`.vtex` image** (drawn by the maintainer, compiled from PNG),
drawn by a child `<Image>` via `setFace()` in `renderMenu` (trap 14) — `s2r://panorama/
images/cards/<key>.vtex`. Missing art falls back to a plain dark card.

Three ways to play (see `mg_ui.js`):
- **Quick Match** — public matchmaking; server pairs you with anyone else who pressed it.
- **Create / Join** — private match via a shared 4-digit code.
- **Play vs Bot** — fully offline, no server, no network calls at all.

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
                           connectfour, durak, poker) → mg_games ($.MG.Games) → mg_durak →
                           mg_connectfour → mg_poker → mg_ui. Rule modules load before the
                           controllers that alias them; mg_ui loads last (it drives all views).
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
    mg_games.js            checkers + TTT + chess CONTROLLERS (render, input, net); aliases MG.Rules.*
                           and owns the $.MG.Games registry (list + register + mount). Also hosts the
                           shared side-clock + per-turn timer widgets ($.MG.Widgets) and move history.
    mg_connectfour.js      Connect Four CONTROLLER; self-registers game id 5 (§8.7).
    mg_durak.js            Durak CONTROLLER (render + click/drag + bot + online); self-registers game id 3.
    mg_poker.js            Poker CONTROLLER (render + betting UI + bot + online); self-registers game id 6 (§8.8).
    mg_ui.js               Esc-menu button injection + full-screen lobby overlay ($.MG.UI); header
                           UI-scale + volume dropdowns; seat/time-control pickers.

server/                    Cloudflare Worker (dev-only, NOT packed into the VPK)
  worker.core.js           AUTHORED relay + validators + PNG encoder (edit this)
  worker.js                GENERATED (rules/*.js + worker.core.js via tools/build_worker.js) — deploy artifact
  wrangler.jsonc, README.md
tools/                     dev-only Node test harnesses + build helpers (NOT packed)
  build_worker.js          concatenate the 6 rules/*.js + worker.core.js → server/worker.js
  gen_soundevents.js       generate the soundevents manifest consumed by mg_sound.js
  strip_comments.js        strip comments from scripts for a Public (non-dev) build
  svg_to_deck.py           compile card SVGs → the deck/<S><R> art
  mg_rules_test.js         checkers rules: captures, flying kings, full bot game
  mg_chess_test.js         chess rules: perft, castling, en passant, promotion, mate/stalemate
  mg_connectfour_test.js   connect-four rules + bot
  mg_durak_test.js         durak rules: deal, beats(), throw-in legality, 120 full bot games
  mg_poker_test.js         poker rules: hand ranking, betting rounds, showdown, bot
  mg_server_test.js        worker: matchmaking, seat tokens, per-move validation, concurrent lobbies
  mg_parity_test.js        client predictor vs server authority give identical legal moves
```

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

`BASE_URL` at the top of `mg_net.js` must point at the deployed worker. Until it's set the
overlay opens but shows "server not configured".

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

All routes are GET, all return a PNG, all take `&rnd=<random>` to defeat engine caching.
Client appends `.png` to every path (Panorama's loader only fetches URLs that look like
images; the worker strips `.png` before routing).

| Route | Response (w, h) encodes |
|---|---|
| `/api/probe` | `(600, 1000)` — swap + scale calibration reference |
| `/api/ping` | `(1, 1)` |
| `/api/create?game=G&tok=T` | `(CODE_HI, CODE_LO+1)` — new private lobby, host = seat 0 |
| `/api/quick?game=G&tok=T` | JOINER `(CODE_HI, CODE_LO+1)` · HOST `(CODE_HI+100, CODE_LO+1)` |
| `/api/cancel?code=C` | `(1,1)` |
| `/api/join?code=C&tok=T` | `(G,1)` ok · `(20,1)` missing · `(21,1)` full |
| `/api/status?code=C` | `(players,1)` · `(9,1)` gone |
| `/api/move?code=C&from=F&to=T&end=E&tok=T` | `(1,1)` ok · `(9,1)` not-your-turn · `(9,2)` illegal · `(9,3)` bad-token · `(9,9)` gone |
| `/api/poll?code=C&since=S` | `(from+1 [+100 if end], to+1)` · `(1,1)` nothing new |
| `/api/reset?code=C&game=G&tok=T` | `(1,1)` · `(9,3)` bad-token |

### 5.1 Server authority (seats, tokens, validation)

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

Key encoding tricks and **why**:
- **Code split across both dims** (`hi = code/100`, `lo = code%100 + 1`) keeps both numbers
  small (≤ ~128px) so the engine never lays out a huge image.
- **`+1` on the low half** and on squares (`from+1`, `to+1`) — image dims are always ≥ 1
  (the PNG encoder clamps), so a raw 0 can never be read back. Every sentinel is non-zero.
- **`end` flag is `+100`, not a low bit** — a low bit would be eaten by ±1 rounding from
  UI scaling; a whole hundreds-range gap survives it.
- **`from != to` always** in a real move, so `(1,1)` is a safe "nothing new" marker.
- **State is one Durable Object** ("hub") → strongly consistent, no KV lag between players.

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

- **One request at a time.** Panorama's image loader wedges if several `<Image>` loads are
  in flight — pending loads stall at dims 0 until timeout. So requests run through a strict
  FIFO queue (`reqQueue`, `reqActive`); the poll loop and user actions never overlap.
- **A started request always runs to completion** (response or 8s timeout). There is
  deliberately **no abort**: a silent abort once left `calibrating` latched true forever,
  deadlocking all networking.
- **Flaky-load retry**: one silent re-queue at the front recovers most stalls. Mitigation,
  not a proven fix (can't verify without in-game runs).
- **The net host panel** (`MG_NetHost`) carrying the request images MUST be on-screen and
  larger than the biggest response (the probe) — a culled/clamped panel makes the engine
  skip the image load or mis-read dims. It renders at 2% opacity so it's invisible.

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

4. **`hittest` / `hittestchildren` are XML-construction attributes, NOT live styles.**
   Setting them at runtime with `SetAttributeString` does **not** reliably pass input
   through. This is why the net host, sitting invisibly over the bare Esc menu, **ate hover
   on every native setting** (Bug #1). The real fix was structural: **don't have the panel
   exist over the menu** — calibration is now lazy (see trap 7), and the host is torn down
   the moment the request queue drains (`releaseHost`).

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
   - **Clipping** (2026-07-20, the maintainer's 200% screenshot with "PLAY WITH A FRIEND" cut off):
     `ui-scale` grows the modal's LAYOUT box by the factor, and the modal is `vertical-align: center`
     in the full-screen overlay, so once `natural_height × scale` exceeds the viewport height the top
     AND bottom clip off-screen. **`max-height: 92%` on `.mg-modal` can NOT stop this** — that cap is
     in logical px, evaluated BEFORE `ui-scale` multiplies. Width never overflows (900px even ×2 is
     < the 1920 canvas), so only height is at risk. Fix: `applyUiScale` measures the modal's natural
     height (forcing `ui-scale:100%` for one frame first, so the reading is unambiguously unscaled and
     the clamp can't spiral) against `overlay.actuallayoutheight` (the ui-scale-free full-screen
     sibling = the viewport height, same layout units), and caps the applied scale to the largest whole
     % that fits with a `FIT_MARGIN` (0.96) — **never below 100%** (the natural modal always fits under
     the 92% cap). `clearBody` re-runs it on every view switch because a game board is taller than the
     menu and fits a smaller max scale. ⚠ The clamp maths are reasoned + measured, not renderable from
     a shell — needs a VPK repack to confirm the exact cap at 200% on 16:9 / ultrawide.

---

## 7. Checkers internals (mg_games.js)

- **Board model**: flat `Array(64)`, canonical orientation. Values: `0` empty, `1` white
  man, `2` white king, `3` black man, `4` black king. **White = host = player 0**, starts
  rows 5-7, moves UP, moves first. **Black = joiner**, rows 0-2, moves DOWN.
- **Rules** (Russian draughts): men move forward only but **capture in any diagonal
  direction**; **flying kings** slide any distance; **forced capture**; **multi-jump
  chains**. Pure helpers (`simpleMoves`, `captureMoves`, `applyHop`, `legalSequences`) are
  UI-free so `tools/mg_rules_test.js` can slice them.
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

## 8.5 Chess internals (mg_games.js)

Chess deliberately mirrors checkers so the two share the board geometry, the click+drag
input recipe, and the move/poll transport.

- **Self-contained engine.** The `// ── chess: pure rules` … `// ── chess controller`
  section has NO dependency on the checkers helpers (it defines its own `cSq/cRow/cCol/
  cSign/cType`), so `tools/mg_chess_test.js` can slice and run it standalone — same trick as
  `mg_rules_test.js`. Perft from the start position (20 / 400 / 8902) is the correctness
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

⚠ **Poll decode range.** Checkers/chess both send squares `0..63`, so `poll` encodes
`(from + 1 [+100 if end], to + 1)` → up to **164 × 64 px**. That's larger than checkers'
usual reads but well within the 600×1000 probe, so calibration covers it — still worth a
sanity check on the first in-game chess sync.

---

## 8.6 Durak internals (mg_durak.js)

Durak is the first game that does NOT fit the 2-player, "a move is two small ints"
transport, so it is being built in **stages**. Stage 1 (shipping) is **offline vs bot
only** — no server touched at all, exactly like the other games' bot mode. Online 2–4
player play is Stage 2 and needs a different transport (see below); the pure rules are
written once and reused by both.

- **Two-section file, like chess.** `// ── durak: pure rules ──` … `// ── durak
  controller ──`. The pure section is self-contained (no `$`, no `MG`) so
  `tools/mg_durak_test.js` slices and runs it under Node — same trick as `mg_rules_test.js`.
  ⚠ The banner strings are the slice markers, so prose comments must NOT contain the literal
  `// ── durak controller` (an early draft did and the test sliced an empty body).
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
- **Stage 2 transport (BUILT — 2-player online).** The public move log can't hide hands, so the
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
  after each bout (2-player: Bito swaps attacker/defender, Take keeps them). The online buttons
  (Quick/Create/Join) are enabled in `mg_ui.js`, entering a 2-seat **room** view with a host
  **Start**; the offline bot branch is unchanged. **⚠ 2 players only** — 3–4-seat online
  seating/throw-in is deliberately deferred (the pure rules + offline bot already handle 2/3/4).
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
Registers **game id 6** (`enabled:true`). Offline vs bot is proven in Node; online is built but
**not yet in-game verified**.

- **Two-section file** like chess/durak: `// ── poker: pure rules ──` … `// ── poker controller
  ──`. The pure section (`rules/poker.js`, shared byte-for-byte with the worker) is self-contained
  so `tools/mg_poker_test.js` slices and runs it under Node.
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
  `pjoin` up to cap, and the host fires `pstart` (`pokerStart`) when ready; a mid-match leave folds
  the seat out (`pokerLeave`). The client (`createPoker`, online branch) holds NO authority — it
  rebuilds state from `plog` and pulls its own hole cards from the private channel, sending actions
  via `pact` without optimistic mutation (the echoed event is the single source of truth).
- **Bot** (`rules/poker.js` `botAction`, driven from the controller): `preflopStrength` /
  `madeStrength` heuristics decide fold/check/call/raise; tune later.
- Verified in Node: rules + bot + showdown (`mg_poker_test`), server routes/privacy
  (`mg_server_test`). Reasoned only (needs a VPK repack): the render/betting UI + online sync.

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

### 9.1 Shared clocks & the per-turn timer (`MG.Widgets`, mg_games.js)

Two DIFFERENT time widgets, both built in `mg_games.js` and exposed on `MG.Widgets`:

- **Server side clocks** — the time-control matchmaking (1/3/5/10 min / Any) in **chess &
  checkers**. Each side's remaining time is server-owned; the picker lives in `renderTimeControl`
  (`mg_ui.js`) and the concrete/"Any"(−1)→5min mapping is described there.
- **Per-turn countdown timer** (`createTurnTimer`) — a `TURN_SECS = 25` budget per turn in
  **durak, poker, TTT & Connect Four**. The controller calls `start(onExpire)` when the LOCAL human
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
node tools/build_worker.js                     # regenerate server/worker.js from core + rules
node --check panorama/scripts/rules/checkers.js
node --check panorama/scripts/rules/ttt.js
node --check panorama/scripts/rules/chess.js
node --check panorama/scripts/rules/connectfour.js
node --check panorama/scripts/rules/durak.js
node --check panorama/scripts/rules/poker.js
node --check panorama/scripts/mg_games.js
node --check panorama/scripts/mg_connectfour.js
node --check panorama/scripts/mg_durak.js
node --check panorama/scripts/mg_poker.js
node --check panorama/scripts/mg_sound.js
node --check panorama/scripts/mg_ui.js
node --check panorama/scripts/mg_net.js
node --check server/worker.js
node tools/mg_rules_test.js
node tools/mg_chess_test.js
node tools/mg_connectfour_test.js
node tools/mg_durak_test.js
node tools/mg_poker_test.js
node tools/mg_server_test.js
node tools/mg_parity_test.js                    # client predictor == server authority

```

Then say plainly what is **verified** (syntax, pure rules, server protocol) vs what is
**only reasoned** (anything visual/animated/drag/hover — needs a VPK repack + in-game run
by the maintainer). Don't present unrendered layout or input behavior as confirmed.

When in doubt about a Panorama capability, **grep the game's own files**
(`G:\GameTracking-Deadlock\game\citadel\pak01_dir\panorama\`) or the maintainer's working
mod (`D:\GitHub2\QOLLOCK\panorama`) for a proven pattern — do not invent CSS/JS API.
