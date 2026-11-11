#!/usr/bin/env python3
"""
Jednorázový nástroj: z obrázků draka (assets-src/dragon/walk.jpg a attack.jpg) vyrobí atlasy
(public/assets/dragon/*.png + atlas.json) ve formátu, který čte public/game.js (viz CLASSES.md).

Zdrojové obrázky jsou JPEG s bílým pozadím (bez průhlednosti) a s nadpisy, takže skript:
1. odstraní bílé pozadí – jen bílou spojenou s okrajem obrázku (bílé oči a odlesky uvnitř obrysu zůstanou),
2. vybere snímky podle obdélníků níže (ze sheetu útoků vynechá nadpisy a osamělé ohnivé koule),
3. každý snímek zarovná podle chodidel (spodek zelených pixelů) do buňky stejné velikosti,
4. spočítá měřítko tak, aby byl drak ve hře ~20 px vysoký v chůzi i v útoku (sheety mají jinak velké postavy).

Použití (z kořene repozitáře):   python3 tools/build_dragon_atlas.py
Potřebuje: Pillow, numpy, scipy  (pip3 install pillow numpy scipy)
"""
import json
import os

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets-src", "dragon")
OUT = os.path.join(ROOT, "public", "assets", "dragon")
TARGET_HEIGHT = 20  # výška draka ve hře (px mapy)
MARGIN = 4

# Řádky výstupu: dolů, vlevo, vpravo, nahoru. Obdélník = (x0, y0, x1, y1) ve zdrojovém obrázku.
WALK = [  # walk.jpg (6 × 4); dopředu a dozadu jsou ve zdroji jen 2 snímky
    [(20, 36, 149, 231), (184, 36, 323, 231)],
    [(25, 282, 159, 482), (194, 282, 328, 482), (363, 282, 497, 482), (532, 282, 671, 482), (706, 282, 840, 482), (865, 282, 1009, 482)],
    [(15, 538, 149, 738), (184, 538, 318, 738), (353, 538, 487, 738), (527, 538, 661, 738), (696, 538, 830, 738), (865, 538, 999, 738)],
    [(522, 794, 656, 994), (865, 794, 999, 994)],
]
CLAW = [  # attack.jpg, první 4 snímky každé řady (úder drápy)
    [(15, 135, 136, 265), (140, 135, 262, 270), (262, 135, 380, 272), (380, 135, 505, 275)],
    [(5, 370, 145, 495), (146, 370, 261, 495), (262, 370, 381, 495), (390, 370, 500, 495)],
    [(20, 605, 136, 735), (140, 605, 263, 735), (264, 605, 383, 735), (385, 605, 520, 735)],
    [(15, 840, 142, 1003), (142, 840, 262, 1003), (262, 835, 383, 1003), (383, 840, 510, 1003)],
]
BREATH = [  # attack.jpg, ohnivý dech: nádech, oheň, doznění
    [(530, 100, 640, 250), (643, 100, 767, 300), (767, 95, 886, 310)],
    [(855, 370, 1005, 495), (608, 370, 760, 495), (855, 370, 1005, 495)],
    [(645, 605, 756, 735), (755, 605, 925, 735), (530, 605, 641, 735)],
    [(520, 870, 631, 1005), (634, 815, 767, 1005), (755, 790, 890, 1005)],
]


def load_rgba(path):
    """JPEG -> RGBA: bílé pozadí spojené s okrajem obrázku je průhledné."""
    a = np.array(Image.open(path).convert("RGB")).astype(int)
    mn, mx = a.min(-1), a.max(-1)
    light = (mn > 215) & ((mx - mn) < 30)
    lab, _ = ndimage.label(light)
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    bg = np.isin(lab, list(border))
    # světlý okraj kolem obrysu (JPEG šum) taky pryč
    fringe = (mn > 185) & ((mx - mn) < 45)
    for _ in range(2):
        bg |= ndimage.binary_dilation(bg) & fringe
    rgba = np.zeros(a.shape[:2] + (4,), np.uint8)
    rgba[..., :3] = a
    rgba[..., 3] = np.where(bg, 0, 255)
    return rgba


def components(rgba):
    lab, n = ndimage.label(ndimage.binary_dilation(rgba[..., 3] > 0, iterations=2))
    return lab, n


def cut(rgba, lab, rect):
    """Pixely snímku: komponenty, které do obdélníku patří (těžištěm nebo aspoň 40 % plochy)."""
    x0, y0, x1, y1 = rect
    alpha = rgba[..., 3] > 0
    inside = np.zeros(alpha.shape, bool)
    inside[y0:y1, x0:x1] = True
    keep = np.zeros(alpha.shape, bool)
    for i in np.unique(lab[inside & alpha]):
        comp = (lab == i) & alpha
        ys, xs = np.where(comp)
        cx, cy = xs.mean(), ys.mean()
        share = (comp & inside).sum() / comp.sum()
        if (x0 <= cx < x1 and y0 <= cy < y1) or share >= 0.4:
            keep |= comp & inside
    ys, xs = np.where(keep)
    bx0, bx1, by0, by1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    img = np.where(keep[by0:by1, bx0:bx1, None], rgba[by0:by1, bx0:bx1], 0).astype(np.uint8)
    # kotva: chodidla = spodek zelených pixelů těla (oheň pod drakem se nepočítá), střed nohou
    r, g, b = (img[..., i].astype(int) for i in range(3))
    green = (img[..., 3] > 0) & (g > r + 20) & (g > b + 20)
    gy, gx = np.where(green)
    bottom = gy.max()
    feet = gx[gy >= bottom - 12]
    ax, ay = int(np.median(feet)), int(bottom) + 2
    height = bottom - gy.min()
    return {"img": img, "ax": ax, "ay": ay, "height": int(height)}


def build(name, rgba, lab, rows):
    frames = [[cut(rgba, lab, r) for r in row] for row in rows]
    flat = [f for row in frames for f in row]
    half = max(max(f["ax"], f["img"].shape[1] - f["ax"]) for f in flat) + MARGIN
    up = max(f["ay"] for f in flat) + MARGIN
    down = max(f["img"].shape[0] - f["ay"] for f in flat) + MARGIN
    cell_w, cell_h = 2 * half, up + down
    cols = max(len(r) for r in frames)
    atlas = np.zeros((cell_h * 4, cell_w * cols, 4), np.uint8)
    for r, row in enumerate(frames):
        for c, f in enumerate(row):
            h, w = f["img"].shape[:2]
            dy, dx = r * cell_h + up - f["ay"], c * cell_w + half - f["ax"]
            region = atlas[dy:dy + h, dx:dx + w]
            np.copyto(region, f["img"], where=f["img"][..., 3:4] > 0)
    file = name + ".png"
    Image.fromarray(atlas).save(os.path.join(OUT, file), optimize=True)
    body = float(np.median([f["height"] for f in flat]))
    scale = round(TARGET_HEIGHT / body, 4)
    print(f"{name:12s} buňka {cell_w}x{cell_h}, kotva ({half}, {up}), drak ~{body:.0f} px -> měřítko {scale}")
    sheet = {"file": file, "cols": cols, "rows": 4, "cellW": int(cell_w), "cellH": int(cell_h),
             "anchorX": int(half), "anchorY": int(up), "scale": scale}
    if any(len(r) != cols for r in frames):
        sheet["counts"] = [len(r) for r in frames]
    return sheet


def main():
    os.makedirs(OUT, exist_ok=True)
    walk = load_rgba(os.path.join(SRC, "walk.jpg"))
    attack = load_rgba(os.path.join(SRC, "attack.jpg"))
    wl, al = components(walk)[0], components(attack)[0]
    sheets = {
        "walk": build("walk", walk, wl, WALK),
        "claw": build("claw", attack, al, CLAW),
        "fire_breath": build("fire_breath", attack, al, BREATH),
    }
    # oba útoky jsou ze stejného obrázku -> stejné měřítko (drak při přepnutí útoků nezmění velikost)
    sheets["fire_breath"]["scale"] = sheets["claw"]["scale"]
    with open(os.path.join(OUT, "atlas.json"), "w") as f:
        json.dump({"sheets": sheets}, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
