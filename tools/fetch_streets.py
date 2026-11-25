"""
Fetch real street details from OpenStreetMap (Overpass API) for Chicago and save
them by z14 tile, so the 3D city paints actual lane lines and crossings offline.

  python tools/fetch_streets.py          # download into data/streets/

What it keeps (all else is dropped):
  ways:     [id, class, lanes, lanes_forward, lanes_backward, oneway, [lng, lat, ...], bridge, layer, first_node, last_node, link]
  crossings:[lng, lat, heading_deg, class, marking]   marking: zebra | ladder | lines | marked | signals
  signals:  [lng, lat]
  rails:    [id, kind, [lng, lat, ...], bridge, tunnel, layer, first_node, last_node, embankment, cutting]

Crossings come from OSM crossing nodes on car streets; unmarked ones are dropped.
Heading is the street's direction at the crossing, so the zebra is laid across it.
Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "data", "streets")
APIS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
CACHE = os.path.join(HERE, ".overpass-cache")     # raw answers per area, so a failed run resumes (not committed)
UA = {"User-Agent": "chicago-lamp-street-fetch/1.0"}
ROADS = "motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link"
CLASS = {"motorway": "motorway", "motorway_link": "motorway", "trunk": "trunk", "trunk_link": "trunk",
         "primary": "primary", "primary_link": "primary", "secondary": "secondary", "secondary_link": "secondary",
         "tertiary": "tertiary", "tertiary_link": "tertiary", "residential": "minor", "unclassified": "minor",
         "living_street": "minor"}

sys.path.insert(0, HERE)
from fetch_tiles import tile_x, tile_y, tile_bounds, city_rings, point_in_rings  # noqa: E402


def num(v):
    try:
        return int(str(v).split(";")[0])
    except (TypeError, ValueError):
        return 0


def marking(tags):
    m = tags.get("crossing:markings")
    c = tags.get("crossing", "")
    if m in ("no",) or c in ("unmarked", "no"):
        return None
    if m in ("zebra", "ladder", "lines", "dashes", "dots", "surface", "ladder:skewed"):
        return "ladder" if m.startswith("ladder") else ("zebra" if m == "zebra" else "lines")
    if c in ("zebra", "marked") or m == "yes":
        return "zebra"
    if c == "traffic_signals":
        return "signals"           # usually painted in Chicago; drawn as parallel lines
    if c == "uncontrolled":
        return "zebra"
    return None


def query(s, w, n, e, key, tries=6):
    cached = os.path.join(CACHE, key + ".json")
    if os.path.exists(cached):
        return json.load(open(cached, encoding="utf-8"))
    q = f"""[out:json][timeout:180];
way["highway"~"^({ROADS})$"]["tunnel"!~"yes|building_passage"]({s},{w},{n},{e})->.roads;
node(w.roads)["highway"~"^(crossing|traffic_signals)$"]->.pts;
way["railway"~"^(rail|subway|light_rail)$"]({s},{w},{n},{e})->.rails;
.roads out body geom qt;
.pts out body qt;
.rails out body geom qt;"""
    data = urllib.parse.urlencode({"data": q}).encode()
    for attempt in range(tries):
        api = APIS[attempt % len(APIS)]
        try:
            req = urllib.request.Request(api, data=data, headers=UA)
            d = json.load(urllib.request.urlopen(req, timeout=240))
            if "elements" not in d or (d.get("remark") and "error" in d["remark"].lower()):
                raise ValueError(d.get("remark", "no elements"))
            os.makedirs(CACHE, exist_ok=True)
            with open(cached, "w", encoding="utf-8") as f:
                json.dump(d, f, separators=(",", ":"))
            return d
        except Exception as ex:  # noqa: BLE001
            print(f"  retry {attempt + 1} ({api.split('/')[2]}): {ex}", file=sys.stderr)
            time.sleep(5 + 5 * (attempt // len(APIS)))
    return None


def main():
    rings = city_rings()
    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    bbox = (min(xs) - 0.01, min(ys) - 0.01, max(xs) + 0.01, max(ys) + 0.01)
    Z = 12
    big = [(x, y) for x in range(tile_x(bbox[0], Z), tile_x(bbox[2], Z) + 1)
           for y in range(tile_y(bbox[3], Z), tile_y(bbox[1], Z) + 1)]
    print(f"{len(big)} Overpass areas (z{Z} tiles over the city)")
    missing = []
    per_tile = {}          # (x14, y14) -> {"ways": {id: row}, "cross": [], "signals": []}

    def bucket(x, y):
        return per_tile.setdefault((x, y), {"ways": {}, "cross": [], "signals": []})

    for k, (bx, by) in enumerate(big):
        w, s, e, n = tile_bounds(bx, by, Z)
        # skip areas with no city in them
        if not any(point_in_rings(rings, w + (e - w) * i / 6, s + (n - s) * j / 6) for i in range(7) for j in range(7)):
            continue
        t0 = time.time()
        d = query(round(s, 5), round(w, 5), round(n, 5), round(e, 5), f"{Z}-{bx}-{by}")
        if d is None:
            # a busy server gives up on big areas: ask for the four quarters instead and merge them
            parts = []
            for qx in (0, 1):
                for qy in (0, 1):
                    qw, qs, qe, qn = tile_bounds(bx * 2 + qx, by * 2 + qy, Z + 1)
                    parts.append(query(round(qs, 5), round(qw, 5), round(qn, 5), round(qe, 5),
                                       f"{Z + 1}-{bx * 2 + qx}-{by * 2 + qy}", tries=10))
            if all(parts):
                seen_el = {}
                for part in parts:
                    for el in part["elements"]:
                        seen_el[(el["type"], el["id"])] = el
                d = {"elements": list(seen_el.values())}
        if d is None:
            missing.append((bx, by))
            print(f"  [{k + 1}/{len(big)}] FAILED, skipped (run again to fill it in)")
            continue
        ways = [el for el in d["elements"] if el["type"] == "way" and "highway" in el.get("tags", {})]
        rails = [el for el in d["elements"] if el["type"] == "way" and "railway" in el.get("tags", {})]
        for rw in rails:
            tags = rw.get("tags", {})
            if "geometry" not in rw:
                continue
            flat = []
            for p in rw["geometry"]:
                flat += [round(p["lon"], 6), round(p["lat"], 6)]
            nds = rw.get("nodes", [])
            row = [rw["id"], tags.get("railway"), flat, 1 if tags.get("bridge") not in (None, "no") else 0,
                   1 if tags.get("tunnel") not in (None, "no") else 0, num(tags.get("layer")),
                   nds[0] if nds else 0, nds[-1] if nds else 0, 1 if tags.get("embankment") == "yes" else 0,
                   1 if tags.get("cutting") in ("yes", "both", "left", "right") else 0]
            for t in {(tile_x(p["lon"], 14), tile_y(p["lat"], 14)) for p in rw["geometry"]}:
                bucket(*t).setdefault("rails", {})[rw["id"]] = row
        nodes = {el["id"]: el for el in d["elements"] if el["type"] == "node"}
        node_way = {}
        for wy in ways:
            tags = wy.get("tags", {})
            cls = CLASS.get(tags.get("highway"))
            if not cls or "geometry" not in wy:
                continue
            geom = wy["geometry"]
            flat = []
            for p in geom:
                flat += [round(p["lon"], 6), round(p["lat"], 6)]
            ow = tags.get("oneway")
            oneway = 1 if ow in ("yes", "1", "true") else -1 if ow == "-1" else 0
            if tags.get("junction") == "roundabout" or cls == "motorway":
                oneway = oneway or 1
            bridge = 1 if tags.get("bridge") not in (None, "no") else 0
            nds = wy.get("nodes", [])
            row = [wy["id"], cls, num(tags.get("lanes")), num(tags.get("lanes:forward")),
                   num(tags.get("lanes:backward")), oneway, flat, bridge, num(tags.get("layer")),
                   nds[0] if nds else 0, nds[-1] if nds else 0, 1 if tags.get("highway", "").endswith("_link") else 0]
            touched = {(tile_x(p["lon"], 14), tile_y(p["lat"], 14)) for p in geom}
            for t in touched:
                bucket(*t)["ways"][wy["id"]] = row
            for i, nid in enumerate(wy.get("nodes", [])):
                if nid in nodes and nid not in node_way:
                    a = geom[max(0, i - 1)]
                    b = geom[min(len(geom) - 1, i + 1)]
                    dx = (b["lon"] - a["lon"]) * math.cos(math.radians(a["lat"]))
                    dy = b["lat"] - a["lat"]
                    node_way[nid] = (round(math.degrees(math.atan2(dx, dy)), 1), cls)
        nc = ns = 0
        for nid, nd in nodes.items():
            tags = nd.get("tags", {})
            t = (tile_x(nd["lon"], 14), tile_y(nd["lat"], 14))
            if tags.get("highway") == "traffic_signals":
                bucket(*t)["signals"].append([round(nd["lon"], 6), round(nd["lat"], 6)])
                ns += 1
            if tags.get("highway") == "crossing" and nid in node_way:
                m = marking(tags)
                if m:
                    h, cls = node_way[nid]
                    bucket(*t)["cross"].append([round(nd["lon"], 6), round(nd["lat"], 6), h, cls, m])
                    nc += 1
        print(f"  [{k + 1}/{len(big)}] {len(ways)} ways, {nc} marked crossings, {ns} signals  ({time.time() - t0:.0f}s)")
        if time.time() - t0 > 1:
            time.sleep(2)          # be gentle with the public Overpass servers

    total = 0
    for (x, y), b in per_tile.items():
        path = os.path.join(OUT, "14", str(x), f"{y}.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # de-duplicate signals/crossings that two areas both returned
        cross = {(c[0], c[1]): c for c in b["cross"]}
        sig = {(p[0], p[1]): p for p in b["signals"]}
        body = json.dumps({"ways": list(b["ways"].values()), "cross": list(cross.values()), "signals": list(sig.values()),
                           "rails": list(b.get("rails", {}).values())},
                          separators=(",", ":"))
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
        total += len(body)
    json.dump({"source": "OpenStreetMap via Overpass", "fetched": time.strftime("%Y-%m-%d"), "tiles": len(per_tile)},
              open(os.path.join(OUT, "manifest.json"), "w"), indent=2)
    print(f"wrote {len(per_tile)} tiles, {total / 1024 / 1024:.1f} MB")
    if missing:
        print(f"{len(missing)} areas failed: run again to fetch just those (the rest are cached)")


if __name__ == "__main__":
    main()
