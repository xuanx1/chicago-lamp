"""
Build data/streets/ from a local OpenStreetMap extract instead of the Overpass API.
Same output as fetch_streets.py, but one file download and no busy query servers.

  curl -o tools/.osm/Chicago.osm.pbf https://download.bbbike.org/osm/bbbike/Chicago/Chicago.osm.pbf
  python tools/extract_streets.py [path/to/extract.osm.pbf]

Needs pyosmium (pip install osmium). Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import math
import os
import sys
import time

import osmium

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fetch_streets import CLASS, OUT, ROADS, marking, num  # noqa: E402
from fetch_tiles import city_rings, tile_x, tile_y  # noqa: E402

ROAD_SET = set(ROADS.split("|"))
RAIL_SET = {"rail", "subway", "light_rail"}
SKIP_SERVICE = {"yard", "siding", "spur", "crossover"}


def yes(v):
    return 1 if v not in (None, "no") else 0


class Streets(osmium.SimpleHandler):
    def __init__(self, bbox):
        super().__init__()
        self.bbox = bbox
        self.cand = {}         # crossing / signal nodes: id -> (lon, lat, tags)
        self.node_way = {}     # crossing node -> (heading, class) of the first street it is on
        self.ways = []         # (row, geometry)
        self.rails = []

    def inside(self, geom):
        w, s, e, n = self.bbox
        return any(w <= x <= e and s <= y <= n for x, y in geom)

    def node(self, n):
        hw = n.tags.get("highway")
        if hw in ("crossing", "traffic_signals"):
            self.cand[n.id] = (n.location.lon, n.location.lat, {t.k: t.v for t in n.tags})

    def way(self, w):
        t = w.tags
        hw, rw = t.get("highway"), t.get("railway")
        if hw in ROAD_SET:
            if t.get("tunnel") in ("yes", "building_passage"):
                return
        elif rw in RAIL_SET:
            pass                       # every track: main lines, yards, sidings, spurs and crossovers
        else:
            return
        try:
            geom = [(nd.lon, nd.lat) for nd in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(geom) < 2 or not self.inside(geom):
            return
        flat = []
        for x, y in geom:
            flat += [round(x, 6), round(y, 6)]
        refs = [nd.ref for nd in w.nodes]
        if rw in RAIL_SET:
            row = [w.id, rw, flat, yes(t.get("bridge")), yes(t.get("tunnel")), num(t.get("layer")),
                   refs[0], refs[-1], 1 if t.get("embankment") == "yes" else 0,
                   1 if t.get("cutting") in ("yes", "both", "left", "right") else 0]
            self.rails.append((row, geom))
            return
        cls = CLASS[hw]
        ow = t.get("oneway")
        oneway = 1 if ow in ("yes", "1", "true") else -1 if ow == "-1" else 0
        if t.get("junction") == "roundabout" or cls == "motorway":
            oneway = oneway or 1
        row = [w.id, cls, num(t.get("lanes")), num(t.get("lanes:forward")), num(t.get("lanes:backward")),
               oneway, flat, yes(t.get("bridge")), num(t.get("layer")), refs[0], refs[-1],
               1 if hw.endswith("_link") else 0]
        self.ways.append((row, geom))
        for i, ref in enumerate(refs):
            if ref in self.cand and ref not in self.node_way:
                a, b = geom[max(0, i - 1)], geom[min(len(geom) - 1, i + 1)]
                dx = (b[0] - a[0]) * math.cos(math.radians(a[1]))
                dy = b[1] - a[1]
                self.node_way[ref] = (round(math.degrees(math.atan2(dx, dy)), 1), cls)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, ".osm", "Chicago.osm.pbf")
    rings = city_rings()
    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    bbox = (min(xs) - 0.02, min(ys) - 0.02, max(xs) + 0.02, max(ys) + 0.02)
    t0 = time.time()
    h = Streets(bbox)
    h.apply_file(src, locations=True, idx="flex_mem")
    print(f"read {src}: {len(h.ways)} streets, {len(h.rails)} railway pieces, {len(h.cand)} crossing/signal nodes "
          f"({time.time() - t0:.0f}s)")

    per_tile = {}

    def bucket(x, y):
        return per_tile.setdefault((x, y), {"ways": [], "cross": [], "signals": [], "rails": []})

    def tiles_of(geom):
        return {(tile_x(x, 14), tile_y(y, 14)) for x, y in geom}

    for row, geom in h.ways:
        for t in tiles_of(geom):
            bucket(*t)["ways"].append(row)
    for row, geom in h.rails:
        for t in tiles_of(geom):
            bucket(*t)["rails"].append(row)
    nc = ns = 0
    for nid, (lon, lat, tags) in h.cand.items():
        w, s, e, n = bbox
        if not (w <= lon <= e and s <= lat <= n):
            continue
        t = (tile_x(lon, 14), tile_y(lat, 14))
        if tags.get("highway") == "traffic_signals":
            bucket(*t)["signals"].append([round(lon, 6), round(lat, 6)])
            ns += 1
        if tags.get("highway") == "crossing" and nid in h.node_way:
            m = marking(tags)
            if m:
                hd, cls = h.node_way[nid]
                bucket(*t)["cross"].append([round(lon, 6), round(lat, 6), hd, cls, m])
                nc += 1

    total = 0
    for (x, y), b in per_tile.items():
        path = os.path.join(OUT, "14", str(x), f"{y}.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        body = json.dumps(b, separators=(",", ":"))
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
        total += len(body)
    stamp = time.strftime("%Y-%m-%d", time.gmtime(os.path.getmtime(src)))
    json.dump({"source": "OpenStreetMap extract (" + os.path.basename(src) + ", " + stamp + ")",
               "fetched": time.strftime("%Y-%m-%d"), "tiles": len(per_tile)},
              open(os.path.join(OUT, "manifest.json"), "w"), indent=2)
    print(f"{nc} marked crossings, {ns} signals; wrote {len(per_tile)} tiles, {total / 1024 / 1024:.1f} MB "
          f"({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
