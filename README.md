# Deadlock UI/UX & QoL Mods

A collection of custom User Interface modifications and Quality of Life scripts for Valve's **Deadlock** (Source 2). 

These mods are built using the Panorama API (XML/CSS/JS) to improve overall player experience.

## 🛠️ Included Mods

* **[Match History Cards Redesign](https://gamebanana.com/mods/674856)** 
  A complete front-end overhaul of the match history screen. Rebuilt CSS to match a cleaner, more modern design concept. (Collaborative project).
* **[Bridge Buff Reminder](https://gamebanana.com/mods/645941)**
  An audio-utility script that reads server time and triggers an alert 10 seconds before the bridge buff spawns.
* **[Commend Everyone Button](https://gamebanana.com/mods/670840)** 
  Adds a native-looking button to the post-game screen that automatically finds and clicks all available commend buttons instantly.
* **[Show Nicknames Above Heroes](https://gamebanana.com/mods/656352) / [In Top Bar](https://gamebanana.com/mods/656390)**
  Creates a permanent overlay with player nicknames. Designed specifically to improve UX for tournament broadcasters and viewers.
* **[Smaller Commend Notification](https://gamebanana.com/mods/648719)**
  Reduces the size of commend notifications to eliminate UI clutter.
* **[Old Abilities Progress Bars](https://gamebanana.com/mods/658996)**
  Restores the classic, more readable ability progress UI.

## ⚙️ Build & Installation

This repository contains the raw source code. To use these mods in-game, you need to compile them into `.vpk` format. I have included an automated build script to make this easy!

**Prerequisites:**
You must have [Reduced CSDK 12](https://deadlockmodding.pages.dev/modding-tools/csdk-12) extracted to `C:\Reduced_CSDK_12` on your computer.

**How to build:**
1. Download or clone this repository to your PC.
2. Navigate to the `tools` folder and run `build_mod.bat`.
3. The script will show a list of available mods. Type the number of the mod you want to build and press Enter.
4. The script will automatically compile and pack the mod.
5. Grab your finished `.vpk` file from the newly created `builds/` folder!

**Deployment:**
Add your compiled `.vpk` file to [Deadlock Mod Manager](https://gamebanana.com/tools/20646) or [Grimoire Mod Manager](https://gamebanana.com/tools/22583) and enable it.

## 📜 License & Usage

All work is licensed under **CC BY-NC-SA 4.0**. 
Feel free to remix my mods however you like. Make sure you provide credit and do not use my work to generate profit (ad-revenue, locked content, etc.).
