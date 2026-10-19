#!/usr/bin/env python3
"""
Jednorázový nástroj: z dodaných spritesheetů bosse Adama (assets-src/adam/*.png) vyrobí atlasy
(public/assets/adam/*.png + atlas.json).

Proč se sheety neřežou po pevné mřížce 724 / 543 px:
postavy a efekty v nich přetékají přes hranice buněk (činka, prstenec shockwave, kabely), takže by se
při ořezu po mřížce uřízly. Skript proto snímky najde podle průhlednosti (hledá nejširší prázdné mezery
mezi snímky), každý snímek ořízne celý, zarovná ho podle kotvy (boss = střed mezi chodidly, VFX = střed efektu)
a vloží do buňky stejné velikosti tak, aby kotva byla ve všech snímcích stejná. Jen se kopírují pixely
(žádné vyhlazování ani změna barev).

Použití (z kořene repozitáře):
    python3 tools/build_adam_atlas.py
Potřebuje: Pillow, numpy, scipy  (pip3 install pillow numpy scipy)
"""
import json
import os

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets-src", "adam")
OUT = os.path.join(ROOT, "public", "assets", "adam")

# klíč v atlasu -> (soubor, počet snímků, typ kotvy)
SHEETS = {
    "neural": ("boss-neural.png", 3, "feet"),
    "barbell": ("boss-barbell.png", 3, "feet"),
    "overclock": ("boss-overclock.png", 3, "feet"),
    "vfxNeural": ("vfx-neural.png", 4, "center"),
    "vfxShock": ("vfx-shockwave.png", 4, "center"),
    "vfxOverclock": ("vfx-overclock.png", 4, "center"),
}
ALPHA = 20  # od téhle průhlednosti je pixel "vidět"
MARGIN = 6


def split_frames(alpha, n):
    """Hranice snímků: uprostřed (n-1) nejširších prázdných mezer mezi obsahem."""
    occupied = (alpha > ALPHA).any(axis=0)
    gaps, start = [], None
    for x, o in enumerate(occupied):
        if not o and start is None:
            start = x
        if o and start is not None:
            gaps.append((start, x - 1))
            start = None
    inner = [g for g in gaps if g[0] > 0 and g[1] < len(occupied) - 1]
    inner.sort(key=lambda g: g[1] - g[0], reverse=True)
    seps = sorted((g[0] + g[1]) // 2 for g in inner[: n - 1])
    if len(seps) != n - 1:
        raise SystemExit(f"nenašel jsem {n - 1} mezer mezi snímky")
    edges = [0] + [s + 1 for s in seps] + [len(occupied)]
    return list(zip(edges[:-1], edges[1:]))


def feet_anchor(rgba, x0, x1):
    """Střed mezi botami (bílé tenisky ve spodní části snímku) a spodek bot."""
    f = rgba[:, x0:x1]
    white = (f[..., 3] > 200) & (f[..., 0] > 195) & (f[..., 1] > 195) & (f[..., 2] > 195)
    white[:560] = False
    white[645:] = False
    lab, k = ndimage.label(ndimage.binary_dilation(white, iterations=3))
    blobs = []
    for i in range(1, k + 1):
        ys, xs = np.where((lab == i) & white)
        if len(xs) > 500:
            blobs.append((xs.min(), xs.max(), ys.max()))
    if not blobs:
        raise SystemExit("nenašel jsem boty")
    left = min(b[0] for b in blobs)
    right = max(b[1] for b in blobs)
    return (left + right) // 2 + x0, int(np.median([b[2] for b in blobs]))


def build(key, file, n, kind):
    rgba = np.array(Image.open(os.path.join(SRC, file)).convert("RGBA"))
    alpha = rgba[..., 3]
    frames = []
    for x0, x1 in split_frames(alpha, n):
        ys, xs = np.where(alpha[:, x0:x1] > ALPHA)
        bx0, bx1, by0, by1 = xs.min() + x0, xs.max() + x0, ys.min(), ys.max()
        if kind == "feet":
            ax, ay = feet_anchor(rgba, x0, x1)
        else:
            ax, ay = (bx0 + bx1) // 2, (by0 + by1) // 2
        frames.append({"x0": x0, "x1": x1, "ax": ax, "ay": ay,
                       "left": ax - x0, "right": x1 - ax, "up": ay, "down": rgba.shape[0] - ay})

    # buňka stejná pro všechny snímky, kotva uprostřed vodorovně
    half = max(max(f["left"], f["right"]) for f in frames) + MARGIN
    up = max(f["up"] for f in frames)
    down = max(f["down"] for f in frames)
    cell_w, cell_h = 2 * half, up + down
    atlas = np.zeros((cell_h, cell_w * n, 4), np.uint8)
    anchors = []
    for i, f in enumerate(frames):
        crop = rgba[:, f["x0"]:f["x1"]]
        dx = i * cell_w + half - f["left"]
        dy = up - f["up"]
        atlas[dy:dy + crop.shape[0], dx:dx + crop.shape[1]] = crop
        anchors.append([half, up])
    Image.fromarray(atlas).save(os.path.join(OUT, file), optimize=True)
    print(f"{key:13s} {n} snímků, buňka {cell_w}x{cell_h}, kotvy v buňce ({half}, {up}); "
          + ", ".join(f"[{f['x0']}-{f['x1']}]" for f in frames))
    return {"file": file, "cols": n, "cellW": int(cell_w), "cellH": int(cell_h), "anchors": [[int(a), int(b)] for a, b in anchors]}


def main():
    os.makedirs(OUT, exist_ok=True)
    atlas = {"sheets": {k: build(k, *v) for k, v in SHEETS.items()}}
    with open(os.path.join(OUT, "atlas.json"), "w") as f:
        json.dump(atlas, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
