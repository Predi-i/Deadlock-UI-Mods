# Deadlock UI/UX & QoL Mods

Source for **Predi_i**'s custom User Interface, quality-of-life and cosmetic mods for Valve's
**Deadlock** (Source 2). The mods use Panorama XML, CSS and JavaScript.

Published releases are available from [my GameBanana profile](https://gamebanana.com/members/5107678).

## Released mods

| Mod | What it does |
| --- | --- |
| [DL Arcade](https://gamebanana.com/mods/699538) | Online mini-games in Deadlock's pause menu: board games, cards, Pixel Battle, Wordle and GeoGuesser. |
| [Old Minimap Player Icon](https://gamebanana.com/mods/684302) | Restores the previous player icon on the minimap. |
| [Parry Cooldown Timer](https://gamebanana.com/mods/682538) | Displays the parry cooldown. |
| [Blind Draft for Street Brawl](https://gamebanana.com/mods/677142) | Hides Street Brawl draft information until it should be revealed. |
| [Match History Cards Redesign](https://gamebanana.com/mods/674856) | A cleaner redesign of the match-history cards. Collaborative project. |
| [Commend Everyone Button](https://gamebanana.com/mods/670840) | Adds a button that commends all eligible players after a match. |
| [Old Abilities Progress Bars](https://gamebanana.com/mods/658996) | Restores the classic ability-progress UI. |
| [Show Nicknames in Top Bar](https://gamebanana.com/mods/656390) | Shows player nicknames in the top HUD bar. |
| [Show Nicknames Above Heroes](https://gamebanana.com/mods/656352) | Shows player nicknames above heroes; useful for broadcasts and spectators. |
| [Bloody Mina Gloat Icon](https://gamebanana.com/mods/655050) | Cosmetic Mina gloat icon. |
| [Meowl Soul Container](https://gamebanana.com/mods/652905) | Cat-themed soul-container replacement. |
| [Remove Incoming Damage From HUD](https://gamebanana.com/mods/648923) | Removes incoming-damage notifications from the HUD. |
| [Smaller Commend Notification](https://gamebanana.com/mods/648719) | Reduces the commend notification footprint. |
| [Bridge Buff Reminder](https://gamebanana.com/mods/645941) | Alerts shortly before the bridge buff spawns. |

## Build and installation

This repository contains source code. Build a mod into a `.vpk` before installing it.

### Prerequisite

Install [Reduced CSDK 12](https://deadlockmodding.pages.dev/modding-tools/csdk-12) to
`C:\Reduced_CSDK_12`.

### Build

1. Clone or download this repository.
2. Run `tools\build_mod.bat`.
3. Select the mod from the menu.
4. Find the generated `.vpk` in `tools\builds`.

For a public release build with source comments removed, use `tools\build_mod_strip_comments.bat`
instead. It creates a temporary `*-stripped` folder and leaves the source tree unchanged.

### Install

Add the resulting `.vpk` to [Deadlock Mod Manager](https://gamebanana.com/tools/20646) or
[Grimoire Mod Manager](https://gamebanana.com/tools/22583), then enable it.

## License

Unless a file says otherwise (for example, bundled third-party assets), this repository is licensed
under the [Apache License 2.0](LICENSE).
