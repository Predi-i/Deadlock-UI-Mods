Match History Cards Redesign — notes for modders

This mod reworks the match history cards (both the big and small ones) and draws a custom 3D (big and small one) hero image on top of the vanilla 2D portrait. If you want to add your own hero image, or make separate win/lose variants, you don't need to copy the whole mod. You can ship a small separate addon that just drops files into the right path and overrides only those.

The path you care about:
panorama/images/heroes

The game will pick the file up automatically as long as it's named correctly and placed there — you don't need to override any .js or .xml files for this.

File naming

Every hero has an internal name (not the name shown in-game, just the name used for the file itself). Here's the list:

Holliday — astro
Bebop — bebop
Abrams — bull
Mo & Krill — digger
The Doorman — doorman
Drifter — drifter
McGinnis — engineer
Rem — familiar
Apollo — fencer
Lady Geist — spectre
Haze — haze
Infernus — inferno
Kelvin — kelvin
Lash — lash
Sinclair — magician
Mina — vampirebat
Mirage — mirage
Calico — nano
Graves — necro
Paradox — chrono
Billy — punkgoat
Dynamo — sumo
Grey Talon — archer
Ivy — tengu
Warden — warden
Paige — bookworm
Seven — gigawatt
Shiv — shiv
Pocket — synth
Celeste — unicorn
Venator — priest
Victor — frank
Vindicta — hornet
Viscous — viscous
Vyper — kali
Wraith — wraith
Yamato — yamato
Silver — werewolf

Plain hero image (no win/lose variant)

For the big card:
panorama/images/heroes/<internal_name>_3d_psd.png

For the small card:
panorama/images/heroes/<internal_name>_4d_psd.png

For example, to replace Grey Talon's image on the big card, drop your file here:
panorama/images/heroes/archer_3d_psd.png

That's it, just a plain .png. Build the mod with https://github.com/Predi-i/Deadlock-Mod-Compiler and it automatically wraps your .png into a .vtex and compiles it into the .vtex_c the game actually loads — you never have to touch .vtex or .vtex_c yourself. If you're advanced and want custom compression/mip settings, you can still drop your own <internal_name>_3d_psd.vtex next to the .png and the compiler will use your file instead of generating one.

Separate win/lose images (optional)

If you want a hero to have a different image for a win and a different one for a loss, just add two more .png files next to the plain one, prefixed with win_ and lose_:

panorama/images/heroes/win_<internal_name>_3d_psd.png
panorama/images/heroes/lose_<internal_name>_3d_psd.png

and the same with the _4d_psd suffix if you also want versions for the small cards:

panorama/images/heroes/win_<internal_name>_4d_psd.png
panorama/images/heroes/lose_<internal_name>_4d_psd.png

For example, for Grey Talon:
panorama/images/heroes/win_archer_3d_psd.png
panorama/images/heroes/lose_archer_3d_psd.png

Just dropping the images isn't enough though — there's one single switch file per hero that you need to flip so the game actually looks for these images. You don't need to touch anything else in the scripts.

The file lives here:
panorama/scripts/hero_win_lose/<internal_name>.js

Inside it there's one line like this:
$.HeroWinLose["archer"] = false;

Change false to true and that's it — for that hero the game will now pick win_/lose_ images based on the match result. If you leave it as false, win_/lose_ images won't be used even if they exist, and nothing gets spammed in the console if those files don't actually exist.

Summary — what your addon needs to ship

Just a hero image (no win/lose):
panorama/images/heroes/<internal_name>_3d_psd.png and/or _4d_psd.png

Hero image + separate win/lose:
panorama/images/heroes/<internal_name>_3d_psd.png (and/or _4d_psd)
panorama/images/heroes/win_<internal_name>_3d_psd.png (and/or _4d_psd)
panorama/images/heroes/lose_<internal_name>_3d_psd.png (and/or _4d_psd)
panorama/scripts/hero_win_lose/<internal_name>.js — flip false to true here

Nothing else from this mod needs to be copied or touched.
