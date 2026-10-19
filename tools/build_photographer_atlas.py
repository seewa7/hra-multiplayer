#!/usr/bin/env python3
"""
Jednorázový nástroj: rozřeže spritesheety fotografa (assets-src/photographer/*.png)
a poskládá je do pravidelných atlasů (public/assets/photographer/*.png + atlas.json).

Proč to není prosté řezání po mřížce 256×256 / 512×256:
sheety od generátoru neodpovídají mřížce (postavy jsou po buňkách posunuté a
efekty útoků přetékají do sousedních buněk). Skript proto každý snímek najde
podle průhlednosti (alfa kanálu), určí u něj kotvu (střed + chodidla postavy)
a vloží ho do buňky tak, aby kotva byla ve všech snímcích na stejném místě.
Díky tomu postava při přepnutí z chůze na útok neposkočí.

Kopírují se jen pixely (žádné vyhlazování, změna barev ani rozlišení).

Použití (z kořene repozitáře):
    python3 tools/build_photographer_atlas.py
Potřebuje: Pillow, numpy, scipy  (pip3 install pillow numpy scipy)
"""
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets-src", "photographer")
OUT = os.path.join(ROOT, "public", "assets", "photographer")

# název -> počet snímků na řádek. Řady jsou vždy: 0 dolů, 1 vlevo, 2 vpravo, 3 nahoru
SHEETS = {"walk": 6, "snapshot": 3, "strong_flash": 3, "perfect_shot": 3}
DIRS = ["down", "left", "right", "up"]

ALPHA_SOLID = 40  # od téhle průhlednosti je pixel "opravdu vidět"
BODY_MERGE_TRY = (0, 2, 4, 6, 8, 10, 12)  # o kolik px se kousky těla dilatují


def effect_mask(rgba):
    """Pixely efektů (žlutý/bílý záblesk, rámeček, průsvitný kužel/paprsek) – postava takovou barvu nemá."""
    r, g, b, al = (rgba[..., i].astype(int) for i in range(4))
    bright = (r >= 200) & (g >= 205)  # žlutá, krémová, bílá (kůže má G ~ 175)
    faint = (al < 200) & (r > 170) & (g > 140)  # průsvitný světelný kužel
    return bright | faint


def find_frames(name, cols):
    img = Image.open(os.path.join(SRC, name + ".png")).convert("RGBA")
    a = np.array(img)
    alpha = a[..., 3]
    solid = alpha > ALPHA_SOLID
    body = solid & ~effect_mask(a)  # jen postava, bez záblesků a paprsků

    # 1) najdi postavy (shluky "těla")
    # (kousky jedné postavy spojujeme dilatací; zkoušíme od malé, dokud nevyjde správný počet)
    expected = cols * 4
    for merge in BODY_MERGE_TRY:
        grown = ndimage.binary_dilation(body, structure=np.ones((2 * merge + 1,) * 2, bool))
        labels, n = ndimage.label(grown)
        keep = [i for i in range(1, n + 1) if (body & (labels == i)).sum() >= 400]
        if len(keep) == expected:
            break
    else:
        sys.exit(f"{name}: nalezeno {len(keep)} postav, čekal jsem {expected}")

    seeds = np.zeros(labels.shape, np.int32)
    for new_id, i in enumerate(keep, 1):
        seeds[body & (labels == i)] = new_id

    # 2) efekty (záblesk, rámeček, paprsek) patří postavě, ke které celý kousek efektu nejblíž přiléhá.
    #    Přiřazujeme po celých souvislých kusech, ne po pixelech, aby se paprsek nerozdělil mezi dva snímky.
    dist, (iy, ix) = ndimage.distance_transform_edt(seeds == 0, return_indices=True)
    owner = seeds[iy, ix]
    effects = solid & (seeds == 0)
    clump, n_clumps = ndimage.label(ndimage.binary_dilation(effects, structure=np.ones((11, 11), bool)) & effects
                                    | ndimage.binary_dilation(effects, structure=np.ones((11, 11), bool)))
    owner_solid = seeds.copy()
    for k in range(1, n_clumps + 1):
        px = effects & (clump == k)
        if not px.any():
            continue
        ys_k, xs_k = np.where(px)
        closest = np.argmin(dist[ys_k, xs_k])
        owner_solid[ys_k, xs_k] = owner[ys_k[closest], xs_k[closest]]
    owner_solid = np.where(solid, owner_solid, 0)
    # slabý lem (alfa 1–40) bereme jen těsně u viditelných pixelů téhož snímku
    frames = []
    for new_id in range(1, expected + 1):
        mine = owner_solid == new_id
        near = ndimage.binary_dilation(mine, structure=np.ones((13, 13), bool)) & (alpha > 0) & (owner == new_id)
        region = mine | near
        ys, xs = np.where(seeds == new_id)
        frames.append(
            {
                "region": region,
                "cx": float(xs.mean()),
                "cy": float(ys.mean()),
                "ax": int(np.median(xs)),  # střed postavy
                "ay": int(ys.max()),  # chodidla
            }
        )

    # seřadit: řady podle y (dolů/vlevo/vpravo/nahoru), uvnitř řady zleva doprava
    frames.sort(key=lambda f: f["cy"])
    return a, [sorted(frames[r * cols : (r + 1) * cols], key=lambda f: f["cx"]) for r in range(4)]


def build(name, cols):
    a, grid = find_frames(name, cols)

    # největší rozsahy snímků okolo kotvy -> velikost jednotné buňky
    left = right = up = down = 0
    for row in grid:
        for f in row:
            ys, xs = np.where(f["region"])
            left = max(left, f["ax"] - xs.min())
            right = max(right, xs.max() - f["ax"])
            up = max(up, f["ay"] - ys.min())
            down = max(down, ys.max() - f["ay"])
    half = int(max(left, right)) + 4
    cell_w = 2 * half
    pad_up, pad_down = int(up) + 4, int(down) + 4
    cell_h = pad_up + pad_down
    anchor_x, anchor_y = half, pad_up

    atlas = np.zeros((cell_h * 4, cell_w * cols, 4), np.uint8)
    for r, row in enumerate(grid):
        for c, f in enumerate(row):
            ys, xs = np.where(f["region"])
            y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
            # jen pixely tohoto snímku (sousední snímky se nesmí prolínat)
            crop = np.where(f["region"][y0:y1, x0:x1, None], a[y0:y1, x0:x1], 0).astype(np.uint8)
            dy = r * cell_h + anchor_y - (f["ay"] - y0)
            dx = c * cell_w + anchor_x - (f["ax"] - x0)
            atlas[dy : dy + crop.shape[0], dx : dx + crop.shape[1]] = crop

    Image.fromarray(atlas).save(os.path.join(OUT, name + ".png"), optimize=True)
    print(f"{name:13s} {cols}x4 buněk {cell_w}x{cell_h}, kotva ({anchor_x},{anchor_y}), "
          f"rozsah od kotvy: vlevo {left} vpravo {right} nahoru {up} dolů {down}")
    return {
        "file": name + ".png",
        "cols": cols,
        "rows": 4,
        "cellW": int(cell_w),
        "cellH": cell_h,
        "anchorX": anchor_x,
        "anchorY": anchor_y,
    }


def main():
    os.makedirs(OUT, exist_ok=True)
    atlas = {"dirs": DIRS, "sheets": {n: build(n, c) for n, c in SHEETS.items()}}
    with open(os.path.join(OUT, "atlas.json"), "w") as f:
        json.dump(atlas, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
