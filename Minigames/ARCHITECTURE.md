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
match. Shipping games: **Checkers** (Russian draughts) and **Tic-Tac-Toe**. Durak /
Chess / Connect Four are disabled placeholders in the picker.

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

This is the whole transport. It dictates everything else: the server is a **dumb relay**,
clients are **authoritative** on game rules, and every response is squeezed into two small
numbers. Full protocol lives in `server/worker.js`'s header comment and §5 below.

---

## 3. File map & load order

```
panorama/
  layout/base_hud.xml      HUD override; <include>s the scripts + styles. LOAD ORDER MATTERS:
                           mg_net (defines $.MG.Net/$.MG.Api) → mg_games ($.MG.Games) → mg_ui.
  styles/mg.css            all styling. Note the Panorama-specific idioms (§6).
  scripts/
    mg_net.js              image side-channel transport + typed protocol ($.MG.Net, $.MG.Api)
    mg_games.js            checkers + TTT engines, rendering, bot AI, drag/click input ($.MG.Games)
    mg_ui.js               Esc-menu button injection + full-screen lobby overlay ($.MG.UI)
server/                    Cloudflare Worker (dev-only, NOT packed into the VPK)
  worker.js                Durable-Object lobby store + PNG encoder
  wrangler.jsonc, README.md
tools/                     dev-only Node test harnesses (NOT packed)
  mg_rules_test.js         checkers rules: captures, flying kings, full bot game
  mg_server_test.js        worker: matchmaking, code round-trip, concurrent lobbies
```

Everything shared between the three scripts hangs off **`$.MG`** — `$` is the single
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
    (Bug #3 from the maintainer: "плашка не закрывается при закрытии esc-меню".)
  - The menu's `#EscapeBackground` is a full-screen click-catcher whose `onactivate` calls
    `CitadelResumePlaying()`. A misclick over the game area used to close the whole menu.
    Fix: `setEscapeBackgroundActive(false)` disables its hit-testing while our modal is up,
    restored on hide. (Bug #2: "чуть не попал по кнопке — закрылось меню".)
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
| `/api/create?game=G` | `(CODE_HI, CODE_LO+1)` — new private lobby, host = player 0 |
| `/api/quick?game=G` | JOINER `(CODE_HI, CODE_LO+1)` · HOST `(CODE_HI+100, CODE_LO+1)` |
| `/api/cancel?code=C` | `(1,1)` |
| `/api/join?code=C` | `(G,1)` ok · `(20,1)` missing · `(21,1)` full |
| `/api/status?code=C` | `(players,1)` · `(9,1)` gone |
| `/api/move?code=C&from=F&to=T&end=E` | `(1,1)` ok · `(9,9)` fail |
| `/api/poll?code=C&since=S` | `(from+1 [+100 if end], to+1)` · `(1,1)` nothing new |
| `/api/reset?code=C&game=G` | `(1,1)` |

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

5. **Scaling in place: use `pre-transform-scale2d`, NOT `scale3d` inside `transform`.**
   `transform: translate3d(x,y) scale3d(0.2…)` multiplies the translate offset, hurling the
   panel toward `(0,0)` — that was the captured-checker "flies up-left" artifact.
   `pre-transform-scale2d` applies **before** the translate, so it scales the panel in place.
   It's animatable; add it to the transition list. Game idiom (abilities CSS).

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
   border always has room. This is the recurring "PLAY VS BOT has no right border" bug (п4);
   `padding-right: 0` reintroduces it.

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
  - 🔎 **`DRAG_DEBUG` diagnostic (currently ON).** `commitDropMultimethod` writes what every
    channel produced to the on-screen status line on each `DragEnd`: `DROP OK via win->37` or
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

## 9. Turn/sync model (both games)

Client-authoritative: each player validates + applies moves locally, then relays each hop
(`sendHops` / `sendMove`). The other side **polls** (`pollOnce`) with `since = appliedSeq`
and applies returned hops. `end=1` marks the turn-ending hop and hands the turn back.
Poll tokens (`pollToken`) invalidate stale loops after a view change. In **bot/offline**
mode there is no server: after your move the bot is scheduled directly; nothing is polled.

Disconnect signals: `status` returning `(9,1)` while a host waits, or `poll` returning
`(9,9)`, route to `MG.UI.kickToMenu(reason)`.

---

## 10. How to work on this safely

Before committing, always:
```
node --check panorama/scripts/mg_games.js
node --check panorama/scripts/mg_ui.js
node --check panorama/scripts/mg_net.js
node tools/mg_rules_test.js
node tools/mg_server_test.js
```
Then say plainly what is **verified** (syntax, pure rules, server protocol) vs what is
**only reasoned** (anything visual/animated/drag/hover — needs a VPK repack + in-game run
by the maintainer). Don't present unrendered layout or input behavior as confirmed.

When in doubt about a Panorama capability, **grep the game's own files**
(`G:\GameTracking-Deadlock\game\citadel\pak01_dir\panorama\`) or the maintainer's working
mod (`D:\GitHub2\QOLLOCK\panorama`) for a proven pattern — do not invent CSS/JS API.
