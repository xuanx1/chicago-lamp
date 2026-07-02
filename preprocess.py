"""
Build viewer data files from the Chicago street-lamp 311 CSVs.

Each row in the source datasets is treated as evidence of a lamp at that point
(not as a hazard). The pipeline deduplicates all geocoded rows into a single
inventory of unique lamp positions, then derives:

  data/lamp_grid.js  - density grid (~55m cells) used for both the heatmap and
                       route-safety scoring (sum of cells within radius of a
                       route segment is a fast proxy for "lamps near you").
                       Recent open SRs are fetched live by the viewer from
                       the Socrata v6vf-nfxy dataset (no local file).
  data/trees.js      - clustered tree-trim positions for display, each tagged
                       with a leafiness tier 1..4 derived from how long ago
                       the most recent trim happened (or whether the SR is
                       still open). Tier 4 = full canopy (long since trimmed
                       / awaiting trim), tier 1 = just trimmed.
  data/tree_grid.js  - leaf-weighted density grid used for route shade
                       scoring (same idea as lamp_grid but counts leaves).
  data/state.json    - per-source max-date cursors (refreshed)

Run:
  python preprocess.py
"""
import csv
import json
import math
import os
import random
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
STATE_PATH = os.path.join(DATA_DIR, "state.json")
os.makedirs(DATA_DIR, exist_ok=True)

# Dedupe lamp positions to 5 decimals (~1m at Chicago latitude).
LAMP_PRECISION = 5
# Routing grid cell (~55m).
HEAT_CELL = 0.0005
# Recent reports cutoff (days) for the optional overlay layer.
RECENT_DAYS = 365
# Display-side clustering: match the SG reference implementation exactly.
DISPLAY_CLUSTER_M = 50
DISPLAY_MAX_LAMPS = 2000
DISPLAY_SHUFFLE_SEED = 42  # deterministic geographically-spread sample
# Each lamp's "size tier" is set by how many other lamps live within this radius.
DISPLAY_DENSITY_RADIUS_M = 600

# Tree pipeline tuning (mirrors the lamp pipeline, smaller display cap).
TREE_CSV = "tree-current.csv"
TREE_PRECISION = 5         # ~1m dedupe
TREE_GRID_CELL = 0.0005    # ~55m, shared with lamp grid for consistency
TREE_DISPLAY_CLUSTER_M = 80
TREE_DISPLAY_MAX = 800
TREE_DISPLAY_SHUFFLE_SEED = 17
# "Today" used to compute days-since-trim. preprocess.py runs offline so an
# absolute reference keeps the output deterministic across re-runs in the
# same window. Override by setting TREE_REFERENCE_DATE env var (YYYY-MM-DD).
TREE_REFERENCE_DATE = os.environ.get("TREE_REFERENCE_DATE", "2026-05-27")

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))

DEFAULT_STATE = {
    "all": {
        "label": "Street Lights - All Out (legacy, frozen 2018-12-19)",
        "csvs": ["all-out.csv"],
        "dataset_id": "zuxi-7xem",
        "schema": "legacy",
        "frozen": True,
        "max_creation_date": None,
    },
    "one": {
        "label": "Street Light - 1/Out (legacy, frozen 2018-12-19)",
        "csvs": ["one-out-part1.csv", "one-out-part2.csv"],
        "dataset_id": "3aav-uy2v",
        "schema": "legacy",
        "frozen": True,
        "max_creation_date": None,
    },
    "current": {
        "label": "311 Street Light Out Complaint (active)",
        "csvs": ["current.csv"],
        "dataset_id": "v6vf-nfxy",
        "schema": "unified",
        "sr_type_filter": "Street Light Out Complaint",
        "max_creation_date": None,
    },
}

SCHEMAS = {
    "legacy": {
        "creation_date": "Creation Date",
        "status": "Status",
        "street_address": "Street Address",
        "service_request_number": "Service Request Number",
        "latitude": "Latitude",
        "longitude": "Longitude",
        "ward": "Ward",
    },
    "unified": {
        "creation_date": "created_date",
        "status": "status",
        "street_address": "street_address",
        "service_request_number": "sr_number",
        "latitude": "latitude",
        "longitude": "longitude",
        "ward": "ward",
    },
}


def load_or_init_state():
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH, encoding="utf-8") as f:
            state = json.load(f)
        for k, v in DEFAULT_STATE.items():
            state.setdefault(k, v)
        return state
    return dict(DEFAULT_STATE)


CHICAGO_BOUNDARY_URL = "https://data.cityofchicago.org/resource/qqq8-j68g.geojson"

# ---- Local building tile store ----
# OSM Overpass is queried once at preprocess time. The result is sliced into a
# tile grid covering Chicago and each tile is written to data/buildings/.
# The viewer loads tiles on demand from the local server.
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
BUILDINGS_BBOX = (41.60, -87.95, 42.05, -87.50)  # Chicago + a small margin
BUILDINGS_GRID = 5  # 5x5 tile grid
# Skip the easternmost column - it's almost entirely Lake Michigan.
BUILDINGS_SKIP_TILES = {(i, 4) for i in range(BUILDINGS_GRID)}
RDP_TOL_DEG = 0.00004  # ~4.4m simplification tolerance
MIN_AREA_DEG2 = 6.0e-9  # ~75 m^2 drop floor for tiny polygons
COORD_DECIMALS = 4  # ~10m precision; fine at zoom 15-17


def ensure_chicago_boundary():
    gj_path = os.path.join(DATA_DIR, "chicago.geojson")
    js_path = os.path.join(DATA_DIR, "chicago_boundary.js")
    if os.path.exists(gj_path) and os.path.exists(js_path):
        return
    print("  Downloading Chicago city boundary GeoJSON ...")
    req = urllib.request.Request(CHICAGO_BOUNDARY_URL, headers={"User-Agent": "chicago-lamp-map/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode("utf-8")
    gj = json.loads(raw)
    with open(gj_path, "w", encoding="utf-8") as f:
        json.dump(gj, f, separators=(",", ":"))
    with open(js_path, "w", encoding="utf-8") as f:
        f.write("window.__CHICAGO__ = ")
        json.dump(gj, f, separators=(",", ":"))
        f.write(";\n")
    print(f"  Wrote chicago.geojson and chicago_boundary.js")


def _rdp(pts, eps):
    """Ramer-Douglas-Peucker polyline simplification (iterative)."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        ax, ay = pts[i]
        bx, by = pts[j]
        dmax, idx = 0.0, -1
        dx, dy = bx - ax, by - ay
        denom = (dx * dx + dy * dy) ** 0.5 or 1e-12
        for k in range(i + 1, j):
            px, py = pts[k]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / denom
            if d > dmax:
                dmax, idx = d, k
        if dmax > eps:
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    return [pts[i] for i in range(len(pts)) if keep[i]]


def _signed_area(pts):
    s = 0.0
    n = len(pts)
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        s += a[1] * b[0] - b[1] * a[0]
    return 0.5 * s


def _tile_bbox(i, j):
    s_lat, w_lon, n_lat, e_lon = BUILDINGS_BBOX
    dlat = (n_lat - s_lat) / BUILDINGS_GRID
    dlon = (e_lon - w_lon) / BUILDINGS_GRID
    return (s_lat + i * dlat, w_lon + j * dlon,
            s_lat + (i + 1) * dlat, w_lon + (j + 1) * dlon)


def _fetch_overpass_tile(s, w, n, e, max_retries=2):
    import time
    q = f"[out:json][timeout:90];(way[\"building\"]({s},{w},{n},{e}););out geom;"
    body = urllib.parse.urlencode({"data": q}).encode("utf-8")
    last_err = None
    for attempt in range(max_retries + 1):
        try:
            req = urllib.request.Request(
                OVERPASS_URL, data=body,
                headers={
                    "User-Agent": "chicago-lamp-map/1.0",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            )
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read())
        except Exception as ex:
            last_err = ex
            time.sleep(5 + attempt * 5)
    raise RuntimeError(f"Overpass failed after retries: {last_err}")


def ensure_buildings():
    import time
    out_dir = os.path.join(DATA_DIR, "buildings")
    os.makedirs(out_dir, exist_ok=True)
    manifest_path = os.path.join(out_dir, "manifest.json")

    if os.path.exists(manifest_path):
        return  # delete data/buildings/manifest.json to force a re-fetch

    print(f"  Fetching Chicago building footprints from OSM Overpass into {out_dir}/")
    print(f"  Tiling {BUILDINGS_GRID}x{BUILDINGS_GRID}, skipping {len(BUILDINGS_SKIP_TILES)} mostly-water tiles")
    manifest = {"bbox": BUILDINGS_BBOX, "grid": BUILDINGS_GRID, "tiles": {}}
    total_in = 0
    total_out = 0

    for i in range(BUILDINGS_GRID):
        for j in range(BUILDINGS_GRID):
            if (i, j) in BUILDINGS_SKIP_TILES:
                continue
            s, w, n, e = _tile_bbox(i, j)
            tile_id = f"{i}_{j}"
            tile_path = os.path.join(out_dir, f"tile_{tile_id}.json")
            print(f"    tile {tile_id} ({s:.3f},{w:.3f}-{n:.3f},{e:.3f}) ...", end=" ", flush=True)
            t0 = time.time()
            try:
                data = _fetch_overpass_tile(s, w, n, e)
            except Exception as ex:
                print(f"FAIL: {ex}")
                continue
            elements = [el for el in data.get("elements", [])
                        if el.get("type") == "way" and isinstance(el.get("geometry"), list)
                        and len(el["geometry"]) >= 4]
            total_in += len(elements)

            polys = []
            for el in elements:
                pts = [(p["lat"], p["lon"]) for p in el["geometry"]]
                if pts[0] == pts[-1]:
                    pts = pts[:-1]
                pts = _rdp(pts, RDP_TOL_DEG)
                if len(pts) < 3:
                    continue
                if abs(_signed_area(pts)) < MIN_AREA_DEG2:
                    continue
                flat = []
                for lat, lon in pts:
                    flat.append(round(lat, COORD_DECIMALS))
                    flat.append(round(lon, COORD_DECIMALS))
                polys.append(flat)
            total_out += len(polys)
            tile_payload = {"bbox": [s, w, n, e], "polygons": polys}
            with open(tile_path, "w", encoding="utf-8") as f:
                json.dump(tile_payload, f, separators=(",", ":"))
            kb = os.path.getsize(tile_path) // 1024
            manifest["tiles"][tile_id] = {
                "bbox": [s, w, n, e],
                "count": len(polys),
                "file": f"tile_{tile_id}.json",
                "kb": kb,
            }
            print(f"{len(elements)} raw -> {len(polys)} kept ({kb} KB, {time.time()-t0:.1f}s)")
            time.sleep(3)  # be polite to Overpass

    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    # JS wrapper for the manifest so the viewer can know which tiles exist
    # without an extra fetch.
    with open(os.path.join(DATA_DIR, "buildings_manifest.js"), "w", encoding="utf-8") as f:
        f.write("window.__BLDG_MANIFEST__ = ")
        json.dump(manifest, f, separators=(",", ":"))
        f.write(";\n")
    print(f"  Buildings: {total_in:,} raw -> {total_out:,} kept across {len(manifest['tiles'])} tiles")


def leafiness_tier(days_since_trim, status):
    """Map a tree's trim-state into a 1..4 leafiness tier.

    Open SR = nobody has trimmed it yet -> tier 4 (overgrown canopy).
    Completed: leaves regrow over a few seasons; bucket by recency.
    """
    if status and status.strip().lower().startswith("open"):
        return 4
    if days_since_trim is None:
        return 3
    if days_since_trim < 90:
        return 1
    if days_since_trim < 365:
        return 2
    if days_since_trim < 1095:
        return 3
    return 4


def build_tree_outputs(reference_iso):
    csv_path = os.path.join(HERE, TREE_CSV)
    if not os.path.exists(csv_path):
        print(f"  [tree] {TREE_CSV} not present, skipping tree outputs")
        return
    ref_date = datetime.strptime(reference_iso, "%Y-%m-%d").date()

    positions = {}  # (lat_r, lon_r) -> {latest_completion: date|None, status, count}
    n_total = 0
    n_geocoded = 0
    with open(csv_path, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            n_total += 1
            lat_s = row.get("Latitude") or ""
            lon_s = row.get("Longitude") or ""
            try:
                lat = float(lat_s)
                lon = float(lon_s)
            except (ValueError, TypeError):
                continue
            if not (41.6 <= lat <= 42.05 and -88.0 <= lon <= -87.5):
                continue
            n_geocoded += 1
            key = (round(lat, TREE_PRECISION), round(lon, TREE_PRECISION))
            completed = parse_date_loose(row.get("Completion Date"))
            status = (row.get("Status") or "").strip()
            rec = positions.get(key)
            if rec is None:
                positions[key] = {"completion": completed, "status": status, "count": 1}
            else:
                rec["count"] += 1
                if completed and (not rec["completion"] or completed > rec["completion"]):
                    rec["completion"] = completed
                    rec["status"] = status
                elif not rec["completion"] and status.lower().startswith("open"):
                    rec["status"] = status

    if not positions:
        print(f"  [tree] {TREE_CSV} parsed but no geocoded rows")
        return

    # Density grid: each cell holds the sum of leafiness across trees in it.
    grid = defaultdict(int)
    for (lat, lon), rec in positions.items():
        days = None
        if rec["completion"]:
            try:
                d = datetime.strptime(rec["completion"], "%Y-%m-%d").date()
                days = (ref_date - d).days
            except ValueError:
                pass
        tier = leafiness_tier(days, rec["status"])
        cell = (round(lat / TREE_GRID_CELL) * TREE_GRID_CELL,
                round(lon / TREE_GRID_CELL) * TREE_GRID_CELL)
        grid[cell] += tier
    grid_cells = [[round(lat, 4), round(lon, 4), n] for (lat, lon), n in grid.items()]

    # Display sample: randomized walk with 80m cluster filter; cap at TREE_DISPLAY_MAX.
    cos_lat = math.cos(math.radians(41.85))
    bucket_deg = TREE_DISPLAY_CLUSTER_M / 111000.0
    kept = []
    kept_buckets = defaultdict(list)
    items = list(positions.keys())
    rng = random.Random(TREE_DISPLAY_SHUFFLE_SEED)
    rng.shuffle(items)
    for lat, lon in items:
        ci = int(lat / bucket_deg)
        cj = int(lon / bucket_deg)
        too_close = False
        for di in (-1, 0, 1):
            if too_close:
                break
            for dj in (-1, 0, 1):
                for la, lo in kept_buckets.get((ci + di, cj + dj), ()):
                    dy = (lat - la) * 111320
                    dx = (lon - lo) * cos_lat * 111320
                    if dx * dx + dy * dy < TREE_DISPLAY_CLUSTER_M * TREE_DISPLAY_CLUSTER_M:
                        too_close = True
                        break
                if too_close:
                    break
        if too_close:
            continue
        rec = positions[(lat, lon)]
        days = None
        if rec["completion"]:
            try:
                d = datetime.strptime(rec["completion"], "%Y-%m-%d").date()
                days = (ref_date - d).days
            except ValueError:
                pass
        tier = leafiness_tier(days, rec["status"])
        kept.append([round(lat, 6), round(lon, 6), tier,
                     days if days is not None else -1])
        kept_buckets[(ci, cj)].append((lat, lon))
        if len(kept) >= TREE_DISPLAY_MAX:
            break

    summary = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "reference_date": reference_iso,
        "source_csv": TREE_CSV,
        "source_rows": n_total,
        "geocoded_rows": n_geocoded,
        "unique_positions": len(positions),
        "display_trees": len(kept),
        "grid_cells": len(grid_cells),
        "cluster_distance_m": TREE_DISPLAY_CLUSTER_M,
    }

    with open(os.path.join(DATA_DIR, "trees.js"), "w", encoding="utf-8") as f:
        f.write("window.__TREES__ = ")
        json.dump({"summary": summary, "points": kept}, f, separators=(",", ":"))
        f.write(";\n")
    with open(os.path.join(DATA_DIR, "tree_grid.js"), "w", encoding="utf-8") as f:
        f.write("window.__TREE_GRID__ = ")
        json.dump({"summary": summary, "cell_deg": TREE_GRID_CELL, "cells": grid_cells},
                  f, separators=(",", ":"))
        f.write(";\n")
    print(f"  [tree] {n_total:,} rows -> {len(positions):,} positions, "
          f"{len(kept):,} display, {len(grid_cells):,} grid cells")


def parse_date_loose(s):
    if not s:
        return None
    s = s.strip()
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    if "T" in s:
        try:
            return datetime.fromisoformat(s.split(".")[0]).date().isoformat()
        except ValueError:
            pass
    return None


def main():
    ensure_chicago_boundary()
    if os.environ.get("SKIP_BUILDINGS") != "1":
        try:
            ensure_buildings()
        except Exception as ex:
            print(f"  ! buildings fetch error: {ex}; skipping (set SKIP_BUILDINGS=1 to silence)")
    state = load_or_init_state()
    lamp_set = set()
    totals = {}

    for key, info in state.items():
        csv_names = info["csvs"]
        csv_paths = [os.path.join(HERE, name) for name in csv_names]
        missing = [n for n, p in zip(csv_names, csv_paths) if not os.path.exists(p)]
        if missing:
            print(f"  [{key}] {', '.join(missing)} not present, skipping")
            continue
        schema = SCHEMAS[info["schema"]]
        n_total = 0
        n_geocoded = 0
        max_date = None
        for csv_path in csv_paths:
            with open(csv_path, encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    n_total += 1
                    lat_s = row.get(schema["latitude"]) or ""
                    lon_s = row.get(schema["longitude"]) or ""
                    try:
                        lat = float(lat_s)
                        lon = float(lon_s)
                    except (ValueError, TypeError):
                        continue
                    # Filter out coordinates outside Chicago metro (defensive).
                    if not (41.6 <= lat <= 42.05 and -88.0 <= lon <= -87.5):
                        continue
                    n_geocoded += 1
                    lamp_set.add((round(lat, LAMP_PRECISION), round(lon, LAMP_PRECISION)))

                    created = parse_date_loose(row.get(schema["creation_date"]))
                    if created and (max_date is None or created > max_date):
                        max_date = created

        if max_date is not None:
            info["max_creation_date"] = max_date
        info["row_count"] = n_total
        totals[key] = {"rows": n_total, "geocoded": n_geocoded}
        print(f"  [{key}] {'+'.join(csv_names)}: {n_total} rows, {n_geocoded} geocoded, latest {max_date}")

    # Density grid (used by route scoring).
    grid = defaultdict(int)
    for lat, lon in lamp_set:
        cell = (round(lat / HEAT_CELL) * HEAT_CELL, round(lon / HEAT_CELL) * HEAT_CELL)
        grid[cell] += 1
    grid_cells = [[round(lat, 4), round(lon, 4), n] for (lat, lon), n in grid.items()]

    # Display-side cluster filter, mirroring the SG reference:
    #   walk lamps in randomized order, keep one only if no kept lamp lies
    #   within DISPLAY_CLUSTER_M; stop once we hit DISPLAY_MAX_LAMPS.
    cos_lat = math.cos(math.radians(41.85))
    bucket_deg = DISPLAY_CLUSTER_M / 111000  # ~0.00045
    kept = []
    kept_buckets = defaultdict(list)
    items = sorted(lamp_set)
    rng = random.Random(DISPLAY_SHUFFLE_SEED)
    rng.shuffle(items)
    for lat, lon in items:
        ci = int(lat / bucket_deg)
        cj = int(lon / bucket_deg)
        too_close = False
        for di in (-1, 0, 1):
            if too_close: break
            for dj in (-1, 0, 1):
                for la, lo in kept_buckets.get((ci + di, cj + dj), ()):
                    dy = (lat - la) * 111320
                    dx = (lon - lo) * cos_lat * 111320
                    if dx * dx + dy * dy < DISPLAY_CLUSTER_M * DISPLAY_CLUSTER_M:
                        too_close = True
                        break
                if too_close: break
        if not too_close:
            kept.append([round(lat, 6), round(lon, 6)])
            kept_buckets[(ci, cj)].append((lat, lon))
            if len(kept) >= DISPLAY_MAX_LAMPS:
                break

    generated = datetime.now(timezone.utc).isoformat()
    summary = {
        "generated": generated,
        "unique_lamps": len(lamp_set),
        "display_lamps": len(kept),
        "grid_cells": len(grid_cells),
        "totals_per_source": totals,
    }

    with open(os.path.join(DATA_DIR, "lamp_grid.js"), "w", encoding="utf-8") as f:
        f.write("window.__LAMP_GRID__ = ")
        json.dump({"summary": summary, "cell_deg": HEAT_CELL, "cells": grid_cells}, f, separators=(",", ":"))
        f.write(";\n")

    # Density per kept lamp: count of OTHER kept lamps within DISPLAY_DENSITY_RADIUS_M.
    R = DISPLAY_DENSITY_RADIUS_M
    R2 = R * R
    db = R / 111000.0
    by_bucket = defaultdict(list)
    for i, (la, lo) in enumerate(kept):
        by_bucket[(int(la / db), int(lo / db))].append(i)
    densities = []
    for i, (la, lo) in enumerate(kept):
        ci, cj = int(la / db), int(lo / db)
        n = 0
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for j in by_bucket.get((ci + di, cj + dj), ()):
                    if j == i:
                        continue
                    ola, olo = kept[j]
                    dy = (ola - la) * 111320.0
                    dx = (olo - lo) * cos_lat * 111320.0
                    if dx * dx + dy * dy < R2:
                        n += 1
        densities.append(n)

    points_with_density = [[k[0], k[1], densities[i]] for i, k in enumerate(kept)]
    summary["display_density_radius_m"] = R
    summary["display_density_max"] = max(densities) if densities else 0
    summary["display_density_mean"] = round(sum(densities) / max(len(densities), 1), 2)

    with open(os.path.join(DATA_DIR, "lamps.js"), "w", encoding="utf-8") as f:
        f.write("window.__LAMPS__ = ")
        json.dump({
            "cluster_distance_m": DISPLAY_CLUSTER_M,
            "max_display": DISPLAY_MAX_LAMPS,
            "density_radius_m": R,
            "points": points_with_density,
        }, f, separators=(",", ":"))
        f.write(";\n")

    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)

    print(f"\n  {len(lamp_set):,} unique lamp positions")
    print(f"  Wrote {len(kept):,} display lamps (after {DISPLAY_CLUSTER_M}m cluster, cap {DISPLAY_MAX_LAMPS})")
    print(f"  Wrote {len(grid_cells):,} routing-grid cells ({HEAT_CELL} deg ~ 55m each)")
    print(f"  Density: max={summary['display_density_max']}, mean={summary['display_density_mean']}")

    build_tree_outputs(TREE_REFERENCE_DATE)


if __name__ == "__main__":
    main()
