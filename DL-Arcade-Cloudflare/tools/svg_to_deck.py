#!/usr/bin/env python3
# One-off: rasterize the Vector Cards SVG faces into the mod's deck PNGs.
#
# The SVGs carry a PHYSICAL size (~69x93mm => ~261x355px @96dpi), so pointing
# Chrome straight at the .svg renders it at native px in the top-left corner of
# the window, leaving transparent margins on the right/bottom (the broken first
# attempt). Fix: wrap each SVG in a tiny HTML page where an <img object-fit:fill>
# stretches it to fill the whole viewport, then screenshot the viewport sized to
# the target. Chrome scales the vector cleanly; Pillow guarantees the final size.
#
# Output: <SUIT><RANK>.png  suit S/H/D/C, rank 2..9,T,J,Q,K,A (367x512, matches
# the existing deck art CA.png/D6.png/BACK.png). Jokers skipped.
import os, subprocess, tempfile
from PIL import Image

SRC = r"C:\Users\Administrator\Desktop\Vector Cards (Version 3.2)\FACES (PRINTABLE)\STANDARD (PRINTABLE)\Single Cards (One Per FIle)"
OUT = r"D:\GitHub2\Deadlock-UI-Mods\Minigames\panorama\images\deck"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
W, H, SCALE = 367, 512, 2

SUIT = {"CLUB": "C", "DIAMOND": "D", "HEART": "H", "SPADE": "S"}
RANK = {"1": "A", "10": "T", "11": "J", "12": "Q", "13": "K"}
for n in range(2, 10):
    RANK[str(n)] = str(n)

HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;padding:0;width:{w}px;height:{h}px;overflow:hidden;background:transparent}}
img{{display:block;width:{w}px;height:{h}px;object-fit:fill}}
</style></head><body><img src="file:///{svg}"></body></html>"""

def parse(fname):
    base = fname[:-4]  # drop .svg
    if base.startswith("JOKER"):
        return None
    parts = base.split("-")
    suit = SUIT.get(parts[0])
    rank = RANK.get(parts[1])
    if not suit or not rank:
        return None
    return suit + rank

def render(svg_path, png_path):
    with tempfile.TemporaryDirectory() as td:
        shot = os.path.join(td, "shot.png")
        page = os.path.join(td, "page.html")
        svg_url = svg_path.replace("\\", "/")
        with open(page, "w", encoding="utf-8") as fh:
            fh.write(HTML.format(w=W, h=H, svg=svg_url))
        subprocess.run([
            CHROME, "--headless", "--disable-gpu", "--no-sandbox",
            "--force-device-scale-factor=%d" % SCALE,
            "--default-background-color=00000000",
            "--hide-scrollbars",
            "--screenshot=" + shot,
            "--window-size=%d,%d" % (W, H),
            "file:///" + page.replace("\\", "/"),
        ], check=True, capture_output=True)
        img = Image.open(shot).convert("RGBA")
        if img.size != (W, H):
            img = img.resize((W, H), Image.LANCZOS)
        img.save(png_path)

def main():
    # Optional CLI ranks filter: `python svg_to_deck.py 2 3 4 5` only writes
    # those ranks (leaves the existing 36-card short deck used by Durak alone).
    import sys
    only = set(sys.argv[1:]) or None
    done = 0
    for f in sorted(os.listdir(SRC)):
        if not f.lower().endswith(".svg"):
            continue
        name = parse(f)
        if not name:
            continue
        if only is not None and name[1:] not in only:
            continue
        out = os.path.join(OUT, name + ".png")
        render(os.path.join(SRC, f), out)
        done += 1
        print("%s -> %s.png" % (f, name))
    print("done: %d cards" % done)

if __name__ == "__main__":
    main()
