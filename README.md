# [Best-Lit Line, in Chicago](https://xuanx1.github.io/chicago-lamp/)
<img width="1920" height="914" alt="Screenshot 2026-11-25 182555" src="https://github.com/user-attachments/assets/10c1b2da-c11e-4879-88b5-b847a1558295" />
A walkable 3D map of Chicago's streetlights. Pick two points and it finds
the walking route with the most streetlights along it. Then it hands you a
passer-by near the start, and you walk the line yourself in third person.

Chicago publishes no streetlight inventory, so lamp positions come from the
city's 311 complaints: every "light out" report on file marks a lamp that
exists. Tree-trim requests stand in for mature street trees, and score
routes for daytime shade.

## Running it

```
python serve.py          # http://localhost:8000/
python serve.py --port 8765 --no-open
```

`serve.py` sends `Cache-Control: no-store` for HTML, JS and CSS, so a reload
always picks up code changes. Module URLs also carry a `?v=` version tag.
Any static server works too, including GitHub Pages.

### What runs offline

Everything that rarely changes is vendored, so the map, the 3D city and the
fonts all load from the repo:

| Asset | Where | Refresh |
|---|---|---|
| MapLibre GL 5.24.1, three.js r170, `@mapbox/vector-tile`, `pbf` | `vendor/` | replace the files (pinned versions) |
| Instrument Serif, Inter, JetBrains Mono (Latin, woff2) | `vendor/fonts/` | as needed |
| OpenFreeMap vector tiles for Chicago, z0-14 (~2,000 files, ~108 MB) | `tiles/{z}/{x}/{y}.pbf` | `python tools/fetch_tiles.py` |
| Label glyphs (Noto Sans Regular/Bold, Latin ranges) | `tiles/glyphs/` | same script |
| OpenStreetMap street detail: lanes, one-ways, bridges, crossings, traffic signals, every railway track (~25 MB) | `data/streets/14/{x}/{y}.json` | `python tools/extract_streets.py` |

Every zoom, 0-14, covers the map's whole pan area. A tilted view sees
kilometres past the city limits, and a missing tile there would show as a
blank hole. Every file is well under GitHub's 100 MB limit.

The street detail comes from a downloaded OpenStreetMap extract, so building
it needs no busy query server. Download BBBike's Chicago extract (~100 MB)
into `tools/.osm/`, which git ignores, then run the script:

```
curl -o tools/.osm/Chicago.osm.pbf https://download.bbbike.org/osm/bbbike/Chicago/Chicago.osm.pbf
python tools/extract_streets.py          # needs pyosmium: pip install osmium
```

`tools/fetch_streets.py` produces the same files from the Overpass API instead.
It resumes where it left off, rotates between mirrors, and splits areas the
server can't handle. It's slow when Overpass is busy.

To open the map on a given view, add
`?cam=lng,lat,zoom,pitch,bearing` to the URL, for example
`?cam=-87.6455,41.8752,17.6,60,20` for the Circle Interchange.

Only two things stay online, because they change constantly: the live 311
outage feed (Socrata) and route-finding (OSRM). Without a connection the
city still loads; you just get no live outages and no new routes.

The pre-3D 2D version of the viewer is kept on the `backup/2d-redesign` branch.

## The viewer

MapLibre GL draws the base map from OpenFreeMap vector tiles (keyless). A
three.js layer shares MapLibre's GL context and depth buffer and draws
everything at street level. All of the 3D code is in `js/world3d.js`.

### Day and night

- Day and night follow the sun over Chicago at the device's current time
  (sun position in `js/geo.js`; "night" starts 4° below the horizon).
- The Night / Day switch overrides the clock for exploring. "Back to live
  time" returns to it.
- A switch only changes feature-constant paint values, so MapLibre never
  reloads tiles: both glow heatmaps stay loaded and fade by opacity, and
  buildings take one colour per mode.

### What's in the 3D city

- **Lamps.** Each ~55 m lamp-grid cell gets as many lamp posts as it has
  known lamps, spaced along its streets on alternating kerbs. Each post casts
  a ~19 m pool of light at night. Open 311 outage reports become posts whose
  lamps flicker.
- **Buildings.** Real footprints and heights within ~0.9 km of the camera,
  plus taller buildings out to ~1.8 km, drawn with a procedural facade
  shader: floors, windows lit at night, shopfronts, cornices and ink edges.
  Zoomed out, MapLibre's plain extrusions take over.
- **Railways.** Every OpenStreetMap track above ground is drawn: L, Metra,
  Amtrak and freight main lines, yard tracks, sidings, spurs and crossovers.
  Track pieces join through their shared OSM nodes, going straight on at
  switches, into continuous lines. Each line gets a height profile:
  - **Up:** viaducts where OSM says bridge (green steel for the L, concrete
    for the railroads), embankments with retaining walls, and short dips
    between raised stretches filled in.
  - **Down:** open cuttings, including where a street bridge crosses track
    that OSM leaves at ground level. Tunnels start at a concrete mouth and
    are never drawn.
  - **Ramps:** all transitions ramp at no more than 3.5%.
  - **Crossings with streets:** where a street crosses at ground level it's a
    level crossing, with rails set flush in the road. Where a street passes
    under an embankment, it gets an open span.
  - **Trains:** four-car L trains and six-unit Metra double-deckers
    (locomotive plus five gallery cars) follow each line's height, disappear
    into tunnels, and go where they'll be seen first.
  - **Stations:** an elevated L station is a railway POI matched to elevated
    track, with a platform at the track's real height, canopies, lights,
    entrance towers and people waiting.
- **Highways.** Expressways come from OSM ways. A highway bridge only stands
  up if it passes over something (water, a street, a railway). Connected
  bridge pieces form one viaduct, and short unmarked pieces between two
  raised ones are raised too. Where raised pieces meet, they share one
  height, so there are no steps between levels, and ramps come down only at
  the real ends. Decks sit on paired piers every 25 m, with concrete
  barriers. The road surface is the same asphalt as the streets it joins,
  painted with lane dashes plus a white right edge and a yellow left edge.
- **Bridges.** A river bridge spans from land to land, so paths along a pier
  are not bridges. Road bridges arch up to ~6 m over the water, with a
  roadway, sidewalks, a painted fascia, railings, girders (at least 3.2 m of
  headroom for boats) and a tender house at each corner. Footbridges are a
  slim deck with railings. At street zoom the river is drawn over MapLibre's
  flat bridge roads.
- **The river and the lake.** Water taxis run the ferry routes, tour boats
  ply the Chicago River and its branches, and sailboats circle on Lake
  Michigan. They bob, leave wakes, and light their cabins at night.
- **Cloud Gate.** A toon-chrome bean in Millennium Park, with tourists around
  it.
- **Trees.** Stylised street trees from the tree-trim grid. By day they cast
  shadows that follow the real sun.
- **Street level.** From zoom 15 the street surface (asphalt, kerb, 5 m
  pavements, footpaths) is drawn by its own 3D layer, out to ~1.4 km. It sits
  below water, the lamp glow and the route line.
  - **Why its own layer:** shapes are continuous with round joins, so there
    are no tile seams and they look the same at every zoom. MapLibre clips
    wide lines at tile edges.
  - **MapLibre's streets:** used for the overview and the far distance. From
    zoom 14 up they're true width in metres, so the two agree. One carriageway
    of a divided avenue is drawn at 80% width.
  - **Markings:** lane lines follow OSM lane counts. A double yellow line
    separates opposing directions, and dashed white lines separate lanes.
    Highways get edge lines. Lines are true width close up, and stay at least
    a thin visible line from afar.
  - **Crossings:** real OSM crossings: zebra, ladder or parallel lines, as
    mapped.
  - **Traffic signals:** a pole on each kerb, a mast arm and a lit head at
    every signal OSM maps.
  - **Close up:** within ~650 m there are fire hydrants, benches and bins on
    the pavements, and shop bays get striped awnings. These show once you're
    zoomed in close or walking. Kiosks and sheds under 5 m get plain walls.
  - **Below street level:** the flat map can't hide anything under it, so an
    invisible ground surface writes depth over the whole area. It skips only
    the cuttings' footprints, which are stamped into the stencil buffer
    first. Cuttings show through those openings; everything else below
    street level stays hidden.
- **People.** Slim cel-shaded figures with knees and elbows, hair, coats and
  varied heights. The stride cycle advances with distance walked, so feet
  plant instead of sliding.
- **Traffic.** Sedans, SUVs and yellow cabs. Cars follow OSM one-way
  directions across their lanes, keep their distance from the car ahead,
  yield at crossings, and never spawn on top of each other.
- **Crowds.** The crowd follows the camera and gets denser toward the Loop,
  with chatting groups on the pavements and riders on L platforms.
- **Placement.** No person, lamp or tree is placed inside a carriageway,
  including on divided avenues mapped as two one-way roads. Nothing is
  placed under a bridge deck.
- **Obstacles.** These are solid at street level:
  - columns and piers
  - embankment walls and cutting parapets
  - station stair towers and tender houses
  - signal and lamp poles, tree trunks, hydrants, benches and bins
  
  Pedestrians look ahead and step around them, then drift back. Being on a
  deck above a pier doesn't count.

People, cars, boats and trains are simulated. Lamps, outages, trees,
buildings, water, streets (lanes, crossings, signals), highways and railways
come from data.

### Labels

Street and district names show only in the zoomed-out overview (below
zoom 15). In the 3D city they're hidden.

### Routes and walk mode

- Click (or tap) a start and a destination inside the city. Routes come from
  OSRM's walking profile (routing.openstreetmap.de, falling back to the
  public OSRM demo). Each route is scored by lamps within 80 m and canopy
  within 40 m, per km, and the best-lit route is highlighted.
- A couple of seconds later the camera drops behind the passer-by nearest
  the start, and you're in control.
  - **Move:** W/S/A/D (or ↑/↓) relative to the camera. Shift runs. Walk
    speed is 2.2 m/s and run speed 6.2 m/s, with smooth speeding up and
    slowing down.
  - **Look:** move the mouse to look around. Click to lock the pointer for
    unlimited turning. Q/E or ←/→ also turn the camera. Scroll to zoom.
  - **Camera:** it sits about 6 m behind the character, and swings back
    behind you while you walk forward and leave the mouse alone.
  - **Esc:** the first press frees the mouse, the second leaves the walk.
  - **Bridges and water:** you can walk across bridges but not onto water.
  - **Obstacles:** you can't walk through columns, piers, walls, poles,
    trees or street furniture. You slide along them instead.
  - **Trains:** a train at street level is as deadly as a car.
  - **Traffic:** cars don't stop for you. A red "In traffic" warning shows
    while you're in the road, and if a car hits you, you're knocked down.
    You can get up on the nearest safe pavement or leave the walk.
    Streetlights help you see; they don't make crossing safe.
  - **Leaving early:** if you press Esc mid-walk, the route card offers
    "Continue walking the line", and you resume where you left off as the
    same person. A new route, or arriving at B, starts fresh.
  - **Touch screens** get a joystick.
- While you walk, only the part of the line from your feet to B is drawn.
  The HUD shows the distance to B, whether you're on the line, and whether
  you're under the lamps or in a dark stretch.
- On the map, hold the right mouse button (or Ctrl/⌘ + drag) to turn the
  camera: right looks right, up looks toward the horizon.

### Performance

- **Sliced rebuilds.** When the camera moves ~420 m, the neighbourhood is
  rebuilt by a generator job that yields on a ~6 ms deadline (40 ms while
  the loading screen is up). The job builds streets, lamps, trees, buildings,
  the L, bridges, water, the crowd and every instance buffer, then swaps the
  result in, all in one frame.
- **Loading screen.** It stays up until the first neighbourhood is built and
  its shaders have compiled.
- **Instancing.** Everything is drawn instanced, one draw call per kind of
  thing.
- **Lighting.** Lamp light is baked into a 4 m grid, so lighting a person is
  one array read.
- **Outlines.** Ink outlines are skipped when zoomed out.
- **Frames.** Frames are only requested while something is moving.
- **Adaptive quality.** The pixel ratio is budgeted to the screen size. If
  frames run slow, the crowd is thinned, then the resolution is lowered.

## Data sources

All 311 data is from the [Chicago Data Portal](https://data.cityofchicago.org/) (Socrata).

| Key       | Dataset                                   | ID          | Status                          | Local CSV          |
|-----------|-------------------------------------------|-------------|---------------------------------|--------------------|
| `all`     | 311 Street Lights - All Out (legacy)      | `zuxi-7xem` | Frozen 2018-12-19               | `all-out.csv`      |
| `one`     | 311 Street Light - 1/Out (legacy)         | `3aav-uy2v` | Frozen 2018-12-19               | `one-out-part1.csv`, `one-out-part2.csv` |
| `current` | 311 Street Light Out Complaint (unified)  | `v6vf-nfxy` | Active (filter `sr_type=Street Light Out Complaint`) | `current.csv` |
| tree base | 311 Service Requests - Tree Trims (legacy)| `snkf-esnw` | Base snapshot | `tree-current.csv` |

The three legacy datasets stopped accepting new rows on 19 Dec 2018, when
Chicago moved all streetlight and tree-trim 311 requests into the unified
`v6vf-nfxy` feed.

Map data: streets, buildings (with `render_height`), water, waterways, ferry
routes, rail and station POIs come from
[OpenFreeMap](https://openfreemap.org) (OpenMapTiles schema, © OpenStreetMap
contributors), vendored into `tiles/`. The 3D city decodes the same z14
tiles itself, so its detail doesn't depend on the zoom or on which tiles
MapLibre happens to have loaded.

Local data in `data/`:

- `chicago.geojson` / `chicago_boundary.js`: the city boundary (`qqq8-j68g`).
- `lamp_grid.js`: deduplicated lamp positions counted per 0.0005° (~55 m) cell.
- `tree_grid.js`: leaf-weighted tree-trim grid driving the shade score.
- `lamps.js`, `trees.js`, `buildings/`: outputs used by the 2D viewer (not
  loaded by the 3D one).
- `state.json`: per-source cursors (`max_creation_date`, `row_count`).

## Live 311 outages

On load the viewer fetches recent "Street Light Out Complaint" reports from
`v6vf-nfxy` in the browser (no Python step):

```
GET https://data.cityofchicago.org/resource/v6vf-nfxy.json
    ?$where=sr_type='Street Light Out Complaint' AND created_date > '2026-05-23T00:00:00.000'
    &$order=:id &$limit=50000 &$offset=…
```

Open reports flicker, both as red dots in the city overview and as broken
3D lamps on the street. Resolved reports become working lamps. If the feed
can't be reached, the panel says so instead of showing a count of zero.

## Trees & shade scoring

`preprocess.py` deduplicates tree-trim requests by ~1 m position and keeps
the most recent completion date per position. From "days since last trim"
(plus the request's status if it's still open), each position gets a
leafiness tier from 1 to 4:

| Tier | Meaning                                |
|------|----------------------------------------|
| 1    | Just trimmed (< 90 days)               |
| 2    | Regrowing (90 – 365 days)              |
| 3    | Mostly regrown (1 – 3 years)           |
| 4    | Full canopy (> 3 years, or open SR)    |

The grid sums tiers per cell. The shade score sums grid values within 40 m
of a route, per km. The reference "today" is fixed at `2026-05-27` in
`preprocess.py` (override with `TREE_REFERENCE_DATE=YYYY-MM-DD`), so
re-running it is deterministic. The bundled CSV ends in Dec 2018, so every
position currently lands at tier 4.

## File layout

```
.
├── index.html, style.css      Viewer shell: panel, loader, walk HUD, crash card
├── favicon.svg                A cobra-head streetlamp
├── js/
│   ├── main.js                App: map, day/night, live 311, routing, walk hand-off, HUD
│   ├── world3d.js             three.js layer: the whole street-level city, sliced rebuilds
│   ├── walk.js                Third-person controller and camera
│   ├── style.js               MapLibre style and the night/day palettes
│   └── geo.js                 Local metric frame, sun position, grid index, route scoring
├── vendor/                    MapLibre, three.js, tile decoder, self-hosted fonts
├── tiles/                     OpenFreeMap vector tiles + glyphs for Chicago
├── tools/
│   ├── fetch_tiles.py         Downloads / refreshes tiles/
│   ├── extract_streets.py     Builds data/streets/ from a local OSM extract (pyosmium)
│   └── fetch_streets.py       Same output from the Overpass API (resumable, mirrors)
├── serve.py                   Dev server (no-store caching; auto-rebuilds tree outputs)
├── preprocess.py              Builds data/ from the CSVs
├── fetch_updates.py           Pulls Socrata deltas and appends them to the CSVs
├── *.csv                      Base 311 data (one-out is split in two to stay under 100 MB)
└── data/                      Preprocessed grids, boundary, cursors
    └── streets/               OSM lanes, crossings, signals and railways per z14 tile
```

## Updating data

Run `python fetch_updates.py` to append new Socrata rows to the CSVs, then
`python preprocess.py` to rebuild `data/`. `serve.py` rebuilds the tree
outputs on its own when `tree-current.csv` is newer than them.
