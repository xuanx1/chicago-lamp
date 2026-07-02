# Chicago Lamp Map

A browser-based viewer for Chicago streetlight and tree-trim 311 service
requests. Streetlight SRs are treated as positional evidence to build a
unique-lamp inventory and a density grid for route lighting scores;
tree-trim SRs are treated as positional evidence of mature trees and used
to score routes for daytime shade. Building footprints (OSM Overpass) and
the city boundary are also bundled as local tiles so the viewer runs
without external map data.

## Data sources

All sources are public datasets on the
[Chicago Data Portal](https://data.cityofchicago.org/) (Socrata).

| Key       | Dataset                                   | ID          | Status                          | Local CSV          |
|-----------|-------------------------------------------|-------------|---------------------------------|--------------------|
| `all`     | 311 Street Lights - All Out (legacy)      | `zuxi-7xem` | Frozen 2018-12-19               | `all-out.csv`      |
| `one`     | 311 Street Light - 1/Out (legacy)         | `3aav-uy2v` | Frozen 2018-12-19               | `one-out-part1.csv`, `one-out-part2.csv` |
| `current` | 311 Street Light Out Complaint (unified)  | `v6vf-nfxy` | Active (filter `sr_type=Street Light Out Complaint`) | `current.csv` |
| tree base | 311 Service Requests - Tree Trims (legacy)| `snkf-esnw` | Base snapshot; live deltas fetched in-browser on page load (no python step) | `tree-current.csv` |

Direct API endpoints:

- https://data.cityofchicago.org/resource/zuxi-7xem.json
- https://data.cityofchicago.org/resource/3aav-uy2v.json
- https://data.cityofchicago.org/resource/v6vf-nfxy.json
- https://data.cityofchicago.org/resource/snkf-esnw.json

The three legacy datasets stopped accepting new rows on 19 Dec 2018 when
Chicago migrated all streetlight and tree-trim 311 requests into the unified
`v6vf-nfxy` feed. `current.csv` is filtered to `Street Light Out Complaint`;
the equivalent active feed for tree trims is the same dataset filtered to
`Tree Trim`, should an active tree layer be needed later.

Auxiliary local data (committed for offline use):

- `data/chicago.geojson` / `data/chicago_boundary.js` — city boundary
  (`qqq8-j68g` on the portal).
- `data/buildings/` — OSM building footprints, tiled 5×5 over the Chicago
  bounding box, simplified with Ramer–Douglas–Peucker (~4.4 m tolerance).
- `data/lamps.js`, `data/lamp_grid.js` — preprocess outputs.
- `data/trees.js` — clustered tree-trim display sample (≤800 markers),
  each carrying a 1–4 leafiness tier derived from the most recent trim.
- `data/tree_grid.js` — leaf-weighted ~55 m density grid driving the
  route shade score.
- `data/state.json` — per-source cursors (`max_creation_date`, `row_count`).

## Day / night map skin

The basemap and lamp rendering switch based on which data layers are
active in the side panel:

| Lamps | Trees | Map skin | Lamp glow             | Tree occlusion |
|-------|-------|----------|-----------------------|----------------|
| off   | on    | **Day** (CARTO Positron, light)  | hidden | n/a |
| on    | off   | **Night** (CARTO Dark Matter)    | full   | off |
| on    | on    | **Night** (CARTO Dark Matter)    | full   | **on** &mdash; canopies punch dark discs into nearby lamp glow |
| off   | off   | Night (default)                  | hidden | off |

When both layers are on, every visible tree canopy (sized by leafiness
tier &mdash; see below) acts like a small building above zoom 14: a soft
radial gradient is composited into the lamp glow canvas with
`destination-out`, dimming the pavement immediately under the canopy. A
fuller canopy blocks more light, so tier-4 trees over a sparsely-lit
street are exactly the "less illuminated, less safe at night" pattern
the viewer is meant to surface.

Canopy footprints used for occlusion (radii in metres):

| Tier | Canopy radius |
|------|---------------|
| 1    | 1.5 m         |
| 2    | 2.5 m         |
| 3    | 4.0 m         |
| 4    | 5.5 m         |

## Trees & shade scoring

Each row in `tree-current.csv` is a historical 311 tree-trim request;
`preprocess.py` deduplicates them by ~1 m position and keeps the most recent
completion date per position. From that single "days since last trim" value
(plus the SR's status if it's still open) each tree gets a **leafiness
tier** 1–4:

| Tier | Meaning                                | Leaf clusters | Used for                |
|------|----------------------------------------|---------------|-------------------------|
| 1    | Just trimmed (< 90 days)               | 1             | Sparse canopy, no shade |
| 2    | Regrowing (90 – 365 days)              | 3             | Light shade             |
| 3    | Mostly regrown (1 – 3 years)           | 5             | Moderate shade          |
| 4    | Full canopy (> 3 years, or open SR)    | 7             | Deep shade              |

The viewer renders each tree as an inline SVG (`L.divIcon`) with that many
leaf clusters around the canopy. The "Live 311 tree-trim reports" layer
uses the same tier function but on each live SR's `status` /
`completion_date`. The shade route score sums the leaf-weighted grid cells
within `SHADE_RADIUS_M` (40 m) of the route polyline and reports
`leaves/km` alongside `lamps/km` on each route card.

The reference "today" used to compute days-since-trim is fixed at
`2026-05-27` in `preprocess.py` (override with `TREE_REFERENCE_DATE=YYYY-MM-DD`
in the environment) so re-running the preprocessor is deterministic.

> Note: the bundled historical CSV ends in Dec 2018, so all 800 displayed
> trees currently land at tier 4 (full canopy). Variation appears once
> live `snkf-esnw` SRs start arriving after 27 May 2026.

## File layout

```
.
├── index.html, app.js, style.css       Browser viewer
├── all-out.csv,                        Legacy streetlight CSVs (base data)
│   one-out-part{1,2}.csv                one-out is split in two to keep each under 100 MB
├── current.csv                         Active unified streetlight CSV
├── tree-current.csv                    Tree Trim base data (snkf-esnw)
├── serve.py                            Dev server: auto-rebuilds tree outputs on load
├── preprocess.py                       Builds data/ outputs from the CSVs
├── fetch_updates.py                    Pulls Socrata deltas, appends to CSVs
└── data/
    ├── state.json                      Per-source cursors and metadata
    ├── chicago.geojson, *_boundary.js
    ├── buildings/                      Building tiles + manifest
    ├── lamps.js, lamp_grid.js          Lamp viewer payloads
    ├── trees.js, tree_grid.js          Tree display sample + shade grid
    └── buildings_manifest.js
```

## Updating data

### Live 311 data — folded into the parent layers

Both live feeds (lamp-out SRs from `v6vf-nfxy`, tree-trim SRs from
`snkf-esnw`) are fetched on page load and merged into their parent layers
in the side panel — there is no separate "live" toggle:

- Live lamp-out reports render alongside the lamp glow under
  **"Lamps & illumination"**.
- Live tree-trim reports render alongside the historical canopy under
  **"Trees & shade"** and, when both layers are on, contribute their
  canopy to lamp occlusion just like historical trees do.

A small cyan progress bar appears next to each layer's label while its
Socrata fetch is in flight; it disappears when the response is parsed and
the markers are drawn. If the request errors, the bar still clears (the
console keeps the failure for inspection).

### Tree trims — automatic, in the browser

`tree-current.csv` is the historical snapshot. New rows are fetched **live
from Socrata when the viewer loads** — no python step. The viewer calls:

```
GET https://data.cityofchicago.org/resource/snkf-esnw.json
    ?$where=creation_date > '2026-05-27T00:00:00.000'
    &$order=:id
    &$limit=50000
    &$offset=…
    &$select=service_request_number,status,creation_date,
             street_address,location_of_trees,latitude,longitude
```

Results render under the **"Live 311 tree-trim reports"** layer toggle in
the side panel. Paging follows
[Socrata's "How to query more than 1000 rows of a dataset"](https://support.socrata.com/hc/en-us/articles/202949268-How-to-query-more-than-1000-rows-of-a-dataset)
(`$limit=50000`, `$order=:id`, `$offset` increment). Refresh the page to
re-pull. If `snkf-esnw` is still frozen at the 2018-12-19 cutoff this
returns zero rows — the expected "no updates yet" state.
