# Press-M-To-Play-Google-Snake

Deadlock Panorama UI mod that embeds **Google Snake** into the game overlay via Deadlock's internal CEF browser (`CitadelHTMLPanel`).

Press **M** at any time during gameplay or hero testing to open a centered 1:1 Google Snake window. Mouse cursor release is fully automated via engine convars.

---

## Features

- **One-key toggle**: Press `M` to show or hide the game at any moment.
- **Natural cursor unlocking**: Automatically sets `hud_free_cursor 1` on open (releasing the mouse from camera look) and restores `hud_free_cursor -1` (engine default) on close.
- **Native CEF panel**: Uses Deadlock's built-in `CitadelHTMLPanel` to run Google Snake.
- **Centered 1:1 square modal**: 600x600 px strictly square modal with clean border and zero compositor clipping lag.
- **Conflict-free entry point**: Injected via [`hud_hints.xml`](file:///D:/GitHub2/deadlock-ui-mods/Press-M-To-Play-Google-Snake/panorama/layout/hud_hints.xml) (`hintsPanel` inside `CitadelHud`), leaving `base_hud.xml` untouched for other mods.
- **Clean close methods**:
  - Press `M` again
  - Press `Escape` (when focused)
  - Click outside the window on the dark backdrop
- **Zero performance overhead**:
  - Completely event-driven (no polling loops or recurring timers).
  - Lazy-loads DOM and browser on first activation.
  - Automatically receives keyboard focus for arrow/WASD controls.

---

## Architecture & How It Works

1. **Injection via `hud_hints.xml`**:
   The mod overrides [`panorama/layout/hud_hints.xml`](file:///D:/GitHub2/deadlock-ui-mods/Press-M-To-Play-Google-Snake/panorama/layout/hud_hints.xml). The hints panel (`<CitadelHudHints id="hintsPanel" />`) is an always-instantiated core HUD widget located in `hud.xml:135`. It is practically never modified by other mods, avoiding VPK file conflicts.
2. **Keybind Registration**:
   Uses Source 2 Panorama's `$.RegisterKeyBind` on `key_m` (bound to both local panel and unhandled global scope).
3. **Cursor Control**:
   Uses `$.DispatchEvent('CitadelConCommand', 'hud_free_cursor 1')` to free the cursor, and `hud_free_cursor -1` to re-engage crosshair camera tracking.
4. **CEF Browser**:
   Created dynamically via `$.CreatePanel('CitadelHTMLPanel', win, 'GoogleSnakeCEF')` and points to Google Snake arcade (`https://www.google.com/fbx?fbx=snake_arcade`).
5. **Universal Root Hooking**:
   The script traverses up the parent tree (`getUIRoot`) to mount to the root HUD container (`WindowRoot` / `CitadelHud`), displaying a centered fullscreen backdrop modal regardless of the host XML layout.
