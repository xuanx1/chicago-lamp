"""
Download the OpenFreeMap vector tiles and label glyphs the viewer needs, so it
runs without the tile server. Re-run to refresh (OpenFreeMap rebuilds weekly;
streets and buildings rarely change in ways that matter here).

  python tools/fetch_tiles.py --dry-run     # count tiles, estimate size
  python tools/fetch_tiles.py               # download into tiles/

Layout (served as static files, works on GitHub Pages):
  tiles/{z}/{x}/{y}.pbf                     raw Mapbox Vector Tiles
  tiles/glyphs/{fontstack}/{range}.pbf      label glyphs (Latin ranges)

Coverage: zooms 0-13 over the map's pan bounds; zoom 14 (street level, the
3D city) only for tiles touching the Chicago city limits plus a one-tile
margin. Map data (c) OpenStreetMap contributors, via OpenFreeMap / OpenMapTiles.
"""
import argparse
import concurrent.futures as cf
import json
import math
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "tiles")
TILEJSON = "https://tiles.openfreemap.org/planet"
GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf"
FONTS = ["Noto Sans Regular", "Noto Sans Bold"]
RANGES = ["0-255", "256-511", "512-767", "768-1023", "8192-8447", "8448-8703"]
UA = {"User-Agent": "chicago-lamp-tile-fetch/1.0"}

# map pan bounds (js/main.js maxBounds), lng/lat
PAN = (-88.15, 41.55, -87.30, 42.15)
MAX_Z = 14


def tile_x(lng, z):
    return int((lng + 180) / 360 * 2 ** z)


def tile_y(lat, z):
    r = math.radians(lat)
    return int((1 - math.asinh(math.tan(r)) / math.pi) / 2 * 2 ** z)


def tile_bounds(x, y, z):
    n = 2 ** z
    w = x / n * 360 - 180
    e = (x + 1) / n * 360 - 180
    nlat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    slat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return w, slat, e, nlat


def city_rings():
    path = os.path.join(ROOT, "data", "chicago.geojson")
    gj = json.load(open(path, encoding="utf-8"))
    rings = []
    for f in gj["features"]:
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polys:
            rings.append(poly[0])
    return rings


_BBOX = None


def city_bbox(rings):
    global _BBOX
    if _BBOX is None:
        xs = [p[0] for r in rings for p in r]
        ys = [p[1] for r in rings for p in r]
        _BBOX = (min(xs), min(ys), max(xs), max(ys))
    return _BBOX


def point_in_rings(rings, lng, lat):
    inside = False
    for ring in rings:
        c = False
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i][0], ring[i][1]
            xj, yj = ring[j][0], ring[j][1]
            if (yi > lat) != (yj > lat) and lng < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi:
                c = not c
            j = i
        if c:
            inside = not inside
    return inside


def tile_touches_city(rings, x, y, z):
    w, s, e, n = tile_bounds(x, y, z)
    # quick reject: outside the city's bounding box, no polygon test needed
    bb = city_bbox(rings)
    if e < bb[0] or w > bb[2] or n < bb[1] or s > bb[3]:
        return False
    # sample a 5x5 grid of points in the tile (tiles are ~1.8 km; the city is much bigger)
    for i in range(5):
        for j in range(5):
            if point_in_rings(rings, w + (e - w) * i / 4, s + (n - s) * j / 4):
                return True
    return False


def plan():
    rings = city_rings()
    jobs = []
    for z in range(0, MAX_Z + 1):
        x0, x1 = tile_x(PAN[0], z), tile_x(PAN[2], z)
        y0, y1 = tile_y(PAN[3], z), tile_y(PAN[1], z)
        if z < MAX_Z:
            jobs += [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
            continue
        # edge tiles hold boundary vertices; interior tiles have their centre inside the city
        city = {(tile_x(p[0], z), tile_y(p[1], z)) for r in rings for p in r}
        thin = [r[::8] + [r[0]] for r in rings]
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                if (x, y) in city:
                    continue
                w, s_, e, n = tile_bounds(x, y, z)
                if point_in_rings(thin, (w + e) / 2, (s_ + n) / 2):
                    city.add((x, y))
        grown = {(x + dx, y + dy) for (x, y) in city for dx in (-1, 0, 1) for dy in (-1, 0, 1)}
        jobs += [(z, x, y) for (x, y) in sorted(grown)]
    return jobs


def fetch(url, dest, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            data = urllib.request.urlopen(req, timeout=60).read()
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as f:
                f.write(data)
            return len(data)
        except Exception as ex:  # noqa: BLE001
            if attempt == retries - 1:
                print(f"  failed {url}: {ex}", file=sys.stderr)
                return 0
            time.sleep(1.5 * (attempt + 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    jobs = plan()
    by_z = {}
    for z, _, _ in jobs:
        by_z[z] = by_z.get(z, 0) + 1
    print("tiles per zoom:", ", ".join(f"z{z}:{n}" for z, n in sorted(by_z.items())), "| total", len(jobs))

    tj = json.load(urllib.request.urlopen(urllib.request.Request(TILEJSON, headers=UA)))
    template = tj["tiles"][0]
    if args.dry_run:
        sample = [j for j in jobs if j[0] == MAX_Z][:: max(1, by_z.get(MAX_Z, 1) // 12)][:12]
        sizes = []
        for z, x, y in sample:
            req = urllib.request.Request(template.format(z=z, x=x, y=y), headers=UA)
            sizes.append(len(urllib.request.urlopen(req, timeout=60).read()))
        avg = sum(sizes) / len(sizes)
        print(f"sampled {len(sizes)} z14 tiles: avg {avg / 1024:.0f} KB, max {max(sizes) / 1024:.0f} KB")
        print(f"estimate: ~{(avg * len(jobs)) / 1024 / 1024:.0f} MB (upper bound; low zooms are smaller)")
        return

    todo = []
    for z, x, y in jobs:
        dest = os.path.join(OUT, str(z), str(x), f"{y}.pbf")
        if not os.path.exists(dest):
            todo.append((template.format(z=z, x=x, y=y), dest))
    for font in FONTS:
        for rng in RANGES:
            dest = os.path.join(OUT, "glyphs", font, f"{rng}.pbf")
            if not os.path.exists(dest):
                todo.append((GLYPHS.format(fontstack=urllib.parse.quote(font), range=rng), dest))
    print(f"downloading {len(todo)} files ({len(jobs) + len(FONTS) * len(RANGES) - len(todo)} already present)")
    total, done = 0, 0
    with cf.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for n in pool.map(lambda t: fetch(*t), todo):
            total += n
            done += 1
            if done % 50 == 0:
                print(f"  {done}/{len(todo)}  {total / 1024 / 1024:.1f} MB")
    print(f"done: {done} files, {total / 1024 / 1024:.1f} MB")
    json.dump({"source": template, "fetched": time.strftime("%Y-%m-%d"), "pan_bounds": PAN, "max_zoom": MAX_Z},
              open(os.path.join(OUT, "manifest.json"), "w"), indent=2)


if __name__ == "__main__":
    import urllib.parse  # noqa: E402  (used for glyph font names)
    main()
