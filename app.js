/* Chicago Streetlamp Safe-Route Map
 *
 * Lamps are rendered via a custom canvas layer (no DOM/CSS animation cost):
 *   - Each lamp's tier (and size) is derived from its proximity density:
 *     count of other lamps within 600 m (precomputed in preprocess.py).
 *   - All 2,000 lamps are drawn at every zoom; the count never changes.
 *   - At zoom >= 15, back-facing edges of nearby building polygons cast
 *     real shadow quads that are punched out of the lamp's illumination via
 *     globalCompositeOperation='destination-out'.
 *   - A second canvas animates only the lamp dots (cheap per-frame work).
 *
 * Live data: recent open lamp SRs are pulled directly from the Socrata
 * v6vf-nfxy dataset on page load (filtered to created_date >= 2026-05-23
 * Chicago local time). No Python fetch step.
 */

const CHICAGO_CENTER = [41.8781, -87.6298];
const CHICAGO_BOUNDS = L.latLngBounds([41.60, -87.96], [42.05, -87.50]);
const OSRM_BASE = "https://router.project-osrm.org/route/v1/foot";
const EXPOSURE_RADIUS_M = 80;
const SHADE_RADIUS_M = 40;        // trees within 40 m of route contribute shade
const TREE_LIVE_REFERENCE = new Date("2026-05-27T00:00:00Z");
const TREE_PALETTE = [
  null,
  { canopy: "#9fcc8a", leaf: "#7cb069", trunk: "#5a3a1a" }, // tier 1 - just trimmed
  { canopy: "#6cb55a", leaf: "#4f9b3f", trunk: "#5a3a1a" }, // tier 2
  { canopy: "#4ea03d", leaf: "#358528", trunk: "#5a3a1a" }, // tier 3
  { canopy: "#318020", leaf: "#1f6510", trunk: "#5a3a1a" }, // tier 4 - full canopy
];
const TREE_LEAVES_PER_TIER = [0, 1, 3, 5, 7];

// Strips are drawn as actual line segments between aligned lamp neighbours.
// Each segment carries a linear gradient bright at both endpoints (the lamps)
// and dimmer at the midpoint, with the dimming depending on segment length -
// so closely-spaced lamps produce continuously bright streets and far-apart
// lamps produce a visible flare/dim/rise pattern between them.
const LAMP_RGB = [255, 226, 138];
const TREE_SHADE_RGB = [15, 35, 18];
// PCA on the K nearest neighbours within AXIS_MAX_DIST_M gives each cell's
// local street axis; cells below AXIS_ANISOTROPY_MIN are considered to be at
// intersections or noise and produce no edges.
const AXIS_K_NEIGHBOURS = 4;
const AXIS_MAX_DIST_M = 90;
const AXIS_ANISOTROPY_MIN = 0.45;
const STRIP_MAX_EDGE_M = 130;
const STRIP_MIN_EDGE_M = 18;
const STRIP_PERP_RATIO = 0.30;     // ~ ±17deg cone
const STRIP_PERP_MAX_M = 14;
// Cross-section is feathered by stroking the same big path multiple times
// at decreasing width and increasing alpha (additive blend).
const LAMP_HALO_PASSES = [
  { width: 44, alpha: 0.04 },
  { width: 24, alpha: 0.08 },
  { width: 12, alpha: 0.13 },
];
const LAMP_CORE_WIDTH = 5.2;        // per-edge linear-gradient core stroke
const LAMP_CORE_ENDPOINT_ALPHA = 0.55;  // brightness at the lamp itself
const LAMP_CORE_DIM_BASE = 0.50;        // mid-edge alpha at minimum length
const LAMP_CORE_DIM_FALLOFF = 0.005;    // alpha lost per metre past minimum
const LAMP_CORE_DIM_MIN = 0.04;
const TREE_HALO_PASSES = [
  { width: 36, alpha: 0.06 },
  { width: 20, alpha: 0.12 },
  { width: 10, alpha: 0.18 },
];
const TREE_CORE_WIDTH = 5.2;
const TREE_CORE_ENDPOINT_ALPHA = 0.48;
const TREE_CORE_DIM_BASE = 0.42;
const TREE_CORE_DIM_FALLOFF = 0.005;
const TREE_CORE_DIM_MIN = 0.05;

const lampsData = (window.__LAMPS__ || { points: [] }).points; // [[lat, lon, density], ...]
const grid = window.__LAMP_GRID__ || { cells: [], cell_deg: 0.0005, summary: {} };
const treesData = (window.__TREES__ || { points: [] }).points; // [[lat, lon, tier, daysSinceTrim], ...]
const treeGrid = window.__TREE_GRID__ || { cells: [], cell_deg: 0.0005, summary: {} };
const chicago = window.__CHICAGO__ || null;
const bldgManifest = window.__BLDG_MANIFEST__ || null;

const loaderText = document.getElementById("loader-text");
const loaderBar = document.getElementById("loader-bar");
function setLoading(text, pct) {
  if (loaderText && text != null) loaderText.textContent = text;
  if (loaderBar && pct != null) loaderBar.style.width = Math.max(0, Math.min(100, pct)) + "%";
}
function hideLoading() {
  const overlay = document.getElementById("loading-overlay");
  if (!overlay) return;
  overlay.classList.add("done");
  setTimeout(() => overlay.remove(), 320);
}
setLoading("Initialising map…", 25);

const map = L.map("map", {
  zoomControl: true,
  minZoom: 11,
  maxZoom: 18,
  maxBounds: CHICAGO_BOUNDS,
  maxBoundsViscosity: 1.0,
  worldCopyJump: false,
}).setView(CHICAGO_CENTER, 11);

map.createPane("tree-shade");
map.getPane("tree-shade").style.zIndex = 405;
map.createPane("lamp-glow");
map.getPane("lamp-glow").style.zIndex = 408;
map.createPane("buildings");
map.getPane("buildings").style.zIndex = 420;
map.createPane("lamp-dot");
map.getPane("lamp-dot").style.zIndex = 425;
map.createPane("routes");
map.getPane("routes").style.zIndex = 430;
const buildingsRenderer = L.canvas({ pane: "buildings", padding: 0.5 });
const routeRenderer = L.canvas({ pane: "routes", padding: 0.5 });

/* ---------- basemap (day/night, driven by which data is active) ---------- */
/*
   Day basemap = CARTO positron (light) - used when only the tree layer is
     active (we're scoring shade for a daytime walk).
   Night basemap = CARTO dark_matter - used whenever the lamp layer is
     active. If trees are also on, the lamp layer treats each tree canopy
     as a light occluder (see _ensureShadows / _drawGlow).
*/
const BASEMAP_TILES = {
  day:   "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  night: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
};
const basemapCommon = {
  maxZoom: 19, minZoom: 11, subdomains: "abcd", bounds: CHICAGO_BOUNDS,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
    '&copy; <a href="https://carto.com/attributions">CARTO</a>',
};
let currentBasemap = null;
let currentMode = null;
function setBasemap(mode) {
  if (currentMode === mode) return;
  currentMode = mode;
  const next = L.tileLayer(BASEMAP_TILES[mode], basemapCommon).addTo(map);
  if (currentBasemap) {
    // Fade out the old layer once the new one's first tile has loaded so
    // the swap doesn't flash.
    const old = currentBasemap;
    next.once("load", () => map.removeLayer(old));
    setTimeout(() => { if (map.hasLayer(old)) map.removeLayer(old); }, 1500);
  }
  currentBasemap = next;
  document.body.dataset.mapMode = mode;
}
setBasemap("night");

/* ---------- Chicago boundary ---------- */

let boundaryLayer = null;
if (chicago) {
  boundaryLayer = L.geoJSON(chicago, {
    style: { color: "#00f0ff", weight: 1.2, opacity: 0.5, fill: false, dashArray: "4 3" },
    interactive: false,
  }).addTo(map);
  try { map.fitBounds(boundaryLayer.getBounds(), { padding: [20, 20] }); } catch (e) {}
}
bindToggle("lyr-boundary", boundaryLayer);

/* ---------- point-in-Chicago test (rings cached from MultiPolygon) ---------- */

const chicagoRings = (function () {
  const rings = [];
  if (!chicago || !chicago.features) return rings;
  for (const f of chicago.features) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === "MultiPolygon" ? g.coordinates
                : g.type === "Polygon"      ? [g.coordinates]
                : [];
    for (const poly of polys) {
      for (const ring of poly) {
        rings.push(ring); // ring is [[lon, lat], ...]
      }
    }
  }
  return rings;
})();
function pointInChicago(lat, lon) {
  if (!chicagoRings.length) return true; // no boundary loaded -> permissive
  let inside = false;
  for (const ring of chicagoRings) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) &&
          (lon < (xj - xi) * (lat - yi) / (yj - yi || 1e-12) + xi)) {
        c = !c;
      }
    }
    if (c) inside = !inside; // outer rings flip in; holes flip out
  }
  return inside;
}

/* ---------- per-cell street axis (PCA on nearest neighbours) ---------- */

const STREET_M_PER_DEGLAT = 111320;
function computeStreetAxes(points) {
  if (!points || !points.length) return [];
  const CELL = 0.001;
  const idx = new Map();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const key = Math.floor(p[0] / CELL) + "|" + Math.floor(p[1] / CELL);
    let arr = idx.get(key);
    if (!arr) { arr = []; idx.set(key, arr); }
    arr.push(i);
  }
  const cosL = Math.cos(((points[0][0]) * Math.PI) / 180);
  const M_PER_DEGLON = STREET_M_PER_DEGLAT * cosL;
  const maxD2 = AXIS_MAX_DIST_M * AXIS_MAX_DIST_M;
  const out = new Array(points.length);
  const cands = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const ci = Math.floor(p[0] / CELL), cj = Math.floor(p[1] / CELL);
    cands.length = 0;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const arr = idx.get((ci + di) + "|" + (cj + dj));
        if (!arr) continue;
        for (const k of arr) {
          if (k === i) continue;
          const q = points[k];
          const dE = (q[1] - p[1]) * M_PER_DEGLON;
          const dN = (q[0] - p[0]) * STREET_M_PER_DEGLAT;
          const d2 = dE * dE + dN * dN;
          if (d2 > maxD2) continue;
          cands.push(d2, dE, dN);
        }
      }
    }
    if (cands.length < 6) { out[i] = { e: 1, n: 0, k: 0 }; continue; }
    const groups = [];
    for (let g = 0; g < cands.length; g += 3) groups.push([cands[g], cands[g+1], cands[g+2]]);
    groups.sort((a, b) => a[0] - b[0]);
    const take = Math.min(AXIS_K_NEIGHBOURS, groups.length);
    let sxx = 0, sxy = 0, syy = 0;
    for (let g = 0; g < take; g++) {
      const dE = groups[g][1], dN = groups[g][2];
      sxx += dE * dE; sxy += dE * dN; syy += dN * dN;
    }
    const trace = sxx + syy;
    const det = sxx * syy - sxy * sxy;
    const disc = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
    const lam1 = trace / 2 + disc;
    const lam2 = trace / 2 - disc;
    let vx, vy;
    if (Math.abs(sxy) > 1e-9) { vx = sxy; vy = lam1 - sxx; }
    else if (sxx >= syy) { vx = 1; vy = 0; }
    else { vx = 0; vy = 1; }
    const vlen = Math.sqrt(vx * vx + vy * vy) || 1;
    const aniso = lam1 > 0 ? (1 - lam2 / lam1) : 0;
    out[i] = { e: vx / vlen, n: vy / vlen, k: Math.max(0, Math.min(1, aniso)) };
  }
  return out;
}

/* ---------- edge graph: mutual nearest aligned neighbours ---------- */

function buildStripEdges(points, axes) {
  if (!points || points.length < 2) return [];
  const CELL = 0.001;
  const idx = new Map();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const key = Math.floor(p[0] / CELL) + "|" + Math.floor(p[1] / CELL);
    let arr = idx.get(key);
    if (!arr) { arr = []; idx.set(key, arr); }
    arr.push(i);
  }
  const cosL = Math.cos(((points[0][0]) * Math.PI) / 180);
  const M_PER_DEGLON = STREET_M_PER_DEGLAT * cosL;
  const maxCellSpan = Math.max(1, Math.ceil(STRIP_MAX_EDGE_M / 111));
  const fwd = new Int32Array(points.length).fill(-1);
  const bwd = new Int32Array(points.length).fill(-1);
  const fwdLen = new Float32Array(points.length);
  const bwdLen = new Float32Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const ax = axes[i];
    if (!ax || ax.k < AXIS_ANISOTROPY_MIN) continue;
    const p = points[i];
    const ci = Math.floor(p[0] / CELL), cj = Math.floor(p[1] / CELL);
    let bestFwd = -1, bestBwd = -1, dFwd = Infinity, dBwd = Infinity;
    for (let di = -maxCellSpan; di <= maxCellSpan; di++) {
      for (let dj = -maxCellSpan; dj <= maxCellSpan; dj++) {
        const arr = idx.get((ci + di) + "|" + (cj + dj));
        if (!arr) continue;
        for (const k of arr) {
          if (k === i) continue;
          const q = points[k];
          const dE = (q[1] - p[1]) * M_PER_DEGLON;
          const dN = (q[0] - p[0]) * STREET_M_PER_DEGLAT;
          const proj = dE * ax.e + dN * ax.n;
          const perp = Math.abs(dE * (-ax.n) + dN * ax.e);
          const absProj = Math.abs(proj);
          if (absProj < STRIP_MIN_EDGE_M || absProj > STRIP_MAX_EDGE_M) continue;
          if (perp > STRIP_PERP_MAX_M) continue;
          if (perp > absProj * STRIP_PERP_RATIO) continue;
          if (proj > 0) { if (absProj < dFwd) { dFwd = absProj; bestFwd = k; } }
          else          { if (absProj < dBwd) { dBwd = absProj; bestBwd = k; } }
        }
      }
    }
    fwd[i] = bestFwd; fwdLen[i] = dFwd === Infinity ? 0 : dFwd;
    bwd[i] = bestBwd; bwdLen[i] = dBwd === Infinity ? 0 : dBwd;
  }
  // Mutual nearest: only keep edges where both ends picked each other.
  const edges = new Map();  // canonical "a:b" -> length
  const consider = (a, b, len) => {
    if (b < 0) return;
    const matched = bwd[b] === a || fwd[b] === a;
    if (!matched) return;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const key = lo + ":" + hi;
    if (!edges.has(key)) edges.set(key, len);
  };
  for (let i = 0; i < points.length; i++) {
    consider(i, fwd[i], fwdLen[i]);
    consider(i, bwd[i], bwdLen[i]);
  }
  const out = new Array(edges.size);
  let n = 0;
  for (const [key, len] of edges) {
    const [a, b] = key.split(":");
    out[n++] = [+a, +b, len];
  }
  return out;
}

// Strip data sources: the 55 m density grids carry ~75k lamp cells and tens
// of thousands of tree cells - the raw deduped lamp/tree footprint at road
// resolution. Edges between aligned neighbours become the road strips.
const lampStripPoints = grid.cells.slice();
const treeStripPoints = treeGrid.cells ? treeGrid.cells.slice() : [];
let lampAxes = computeStreetAxes(lampStripPoints);
let lampStripEdges = buildStripEdges(lampStripPoints, lampAxes);
let treePoints = [];  // live tree-trim SRs; filled by loadRecentTreeTrims().

/* ---------- routing-grid spatial index (safe-route scoring) ---------- */

const SP_BUCKET = 0.01;
const sp = new Map();
for (const c of grid.cells) {
  const key = Math.floor(c[0] / SP_BUCKET) + "|" + Math.floor(c[1] / SP_BUCKET);
  let arr = sp.get(key);
  if (!arr) { arr = []; sp.set(key, arr); }
  arr.push(c);
}
function cellsInBBox(minLat, maxLat, minLon, maxLon) {
  const minI = Math.floor(minLat / SP_BUCKET), maxI = Math.floor(maxLat / SP_BUCKET);
  const minJ = Math.floor(minLon / SP_BUCKET), maxJ = Math.floor(maxLon / SP_BUCKET);
  const out = [];
  for (let i = minI; i <= maxI; i++) {
    for (let j = minJ; j <= maxJ; j++) {
      const list = sp.get(i + "|" + j);
      if (!list) continue;
      for (const c of list) {
        if (c[0] >= minLat && c[0] <= maxLat && c[1] >= minLon && c[1] <= maxLon) out.push(c);
      }
    }
  }
  return out;
}

const treeSp = new Map();
for (const c of treeGrid.cells) {
  const key = Math.floor(c[0] / SP_BUCKET) + "|" + Math.floor(c[1] / SP_BUCKET);
  let arr = treeSp.get(key);
  if (!arr) { arr = []; treeSp.set(key, arr); }
  arr.push(c);
}
function treeCellsInBBox(minLat, maxLat, minLon, maxLon) {
  const minI = Math.floor(minLat / SP_BUCKET), maxI = Math.floor(maxLat / SP_BUCKET);
  const minJ = Math.floor(minLon / SP_BUCKET), maxJ = Math.floor(maxLon / SP_BUCKET);
  const out = [];
  for (let i = minI; i <= maxI; i++) {
    for (let j = minJ; j <= maxJ; j++) {
      const list = treeSp.get(i + "|" + j);
      if (!list) continue;
      for (const c of list) {
        if (c[0] >= minLat && c[0] <= maxLat && c[1] >= minLon && c[1] <= maxLon) out.push(c);
      }
    }
  }
  return out;
}

/* ---------- buildings: local tile loader ---------- */

const buildingsShadowLayer = L.layerGroup().addTo(map);
const buildingsRoofLayer = L.layerGroup().addTo(map);
const tileCache = new Map();
const tilesInflight = new Set();
let buildingsEnabled = true;
const BUILDINGS_MIN_ZOOM = 15;

function tilesForBounds(b) {
  if (!bldgManifest) return [];
  const out = [];
  for (const [id, info] of Object.entries(bldgManifest.tiles)) {
    const [s, w, n, e] = info.bbox;
    if (n < b.getSouth() || s > b.getNorth() || e < b.getWest() || w > b.getEast()) continue;
    out.push(id);
  }
  return out;
}

async function loadTile(tileId) {
  if (tileCache.has(tileId)) return tileCache.get(tileId);
  if (tilesInflight.has(tileId)) return null;
  tilesInflight.add(tileId);
  try {
    const file = bldgManifest.tiles[tileId].file;
    const resp = await fetch(`data/buildings/${file}`);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    tileCache.set(tileId, data);
    return data;
  } catch (err) {
    console.warn("Tile load failed", tileId, err);
    return null;
  } finally {
    tilesInflight.delete(tileId);
  }
}

const renderedBuildings = new Map();

function renderTileBuildings(tileId, data) {
  if (renderedBuildings.has(tileId)) return;
  const dLat = -0.00005;
  const dLon =  0.00006;
  const shadows = [], roofs = [];
  for (const flat of data.polygons) {
    const coords = [];
    for (let i = 0; i < flat.length; i += 2) coords.push([flat[i], flat[i + 1]]);
    if (coords.length < 3) continue;
    const shadowCoords = coords.map(([la, lo]) => [la + dLat, lo + dLon]);
    shadows.push(L.polygon(shadowCoords, {
      renderer: buildingsRenderer,
      stroke: false, fillColor: "#05080d", fillOpacity: 0.95,
      interactive: false, smoothFactor: 0.5,
    }).addTo(buildingsShadowLayer));
    roofs.push(L.polygon(coords, {
      renderer: buildingsRenderer,
      color: "#3a4456", weight: 0.5, opacity: 0.55,
      fillColor: "#161c28", fillOpacity: 0.96,
      interactive: false, smoothFactor: 0.5,
    }).addTo(buildingsRoofLayer));
  }
  renderedBuildings.set(tileId, { shadows, roofs });
}

function removeTileBuildings(tileId) {
  const refs = renderedBuildings.get(tileId);
  if (!refs) return;
  for (const p of refs.shadows) buildingsShadowLayer.removeLayer(p);
  for (const p of refs.roofs) buildingsRoofLayer.removeLayer(p);
  renderedBuildings.delete(tileId);
}

function clearAllBuildings() {
  for (const id of [...renderedBuildings.keys()]) removeTileBuildings(id);
}

async function refreshBuildings() {
  if (!buildingsEnabled || !bldgManifest) return;
  if (map.getZoom() < BUILDINGS_MIN_ZOOM) {
    clearAllBuildings();
    return;
  }
  const needed = new Set(tilesForBounds(map.getBounds()));
  for (const id of [...renderedBuildings.keys()]) {
    if (!needed.has(id)) removeTileBuildings(id);
  }
  for (const id of needed) {
    if (renderedBuildings.has(id)) continue;
    const data = tileCache.get(id) || await loadTile(id);
    if (data && needed.has(id) && buildingsEnabled && map.getZoom() >= BUILDINGS_MIN_ZOOM) {
      renderTileBuildings(id, data);
    }
  }
  // Buildings affect lamp shadows - rebuild glow with new tiles.
  lampLayer && lampLayer.requestShadowRebuild();
}

bindCheckbox("lyr-buildings", (on) => {
  buildingsEnabled = on;
  if (on) {
    buildingsShadowLayer.addTo(map);
    buildingsRoofLayer.addTo(map);
    refreshBuildings();
  } else {
    map.removeLayer(buildingsShadowLayer);
    map.removeLayer(buildingsRoofLayer);
    lampLayer && lampLayer.requestShadowRebuild();
  }
});

// Convenience: read polygons of currently loaded building tiles that overlap a bbox.
function buildingPolygonsInBBox(b) {
  const out = [];
  for (const [tileId, _refs] of renderedBuildings) {
    const data = tileCache.get(tileId);
    if (!data) continue;
    for (const flat of data.polygons) {
      // bbox of polygon
      let mnLat = Infinity, mxLat = -Infinity, mnLon = Infinity, mxLon = -Infinity;
      for (let i = 0; i < flat.length; i += 2) {
        const la = flat[i], lo = flat[i + 1];
        if (la < mnLat) mnLat = la; if (la > mxLat) mxLat = la;
        if (lo < mnLon) mnLon = lo; if (lo > mxLon) mxLon = lo;
      }
      if (mxLat < b.getSouth() || mnLat > b.getNorth() ||
          mxLon < b.getWest()  || mnLon > b.getEast()) continue;
      out.push(flat);
    }
  }
  return out;
}

/* ---------- custom canvas lamp layer ---------- */
/*
   Two stacked canvases:
     - glow canvas (pane: lamp-glow, z=408): static per-moveend illumination
       discs with shadows punched out.
     - dot canvas (pane: lamp-dot, z=425): the pulsing bright dot at each lamp;
       redrawn each animation frame.
*/

const LampLayer = L.Layer.extend({
  initialize(lamps) {
    this._lamps = lamps;
    this._edges = lampStripEdges;
    this._positions = null;
  },

  setLamps(arr) {
    this._lamps = arr;
    const axes = computeStreetAxes(arr);
    this._edges = buildStripEdges(arr, axes);
    lampAxes = axes;
    lampStripEdges = this._edges;
    if (this._map) {
      this._buildLampPx();
      this._drawGlow();
    }
  },

  onAdd(map) {
    this._map = map;
    this._glow = L.DomUtil.create("canvas", "lamp-glow-canvas");
    this._dot  = L.DomUtil.create("canvas", "lamp-dot-canvas");
    map.getPane("lamp-glow").appendChild(this._glow);
    map.getPane("lamp-dot").appendChild(this._dot);
    for (const c of [this._glow, this._dot]) {
      c.style.position = "absolute";
      c.style.left = "0";
      c.style.top = "0";
      c.style.pointerEvents = "none";
      c.style.transition = "opacity 90ms linear";
    }
    // During a pan or zoom animation, Leaflet translates the panes via CSS.
    // The canvas content stays anchored as long as we do NOT touch its
    // position. So: never call setPosition during 'move' / 'zoom' - only on
    // movestart (to hide stale content) and moveend (to redraw + show).
    // Pan stays anchored automatically via pane translation, no dim needed.
    // Zoom does need a dim because the canvas content doesn't reflect the
    // new zoom until zoomend fires.
    map.on("zoomstart", this._beginViewChange, this);
    map.on("moveend zoomend resize viewreset", this._update, this);
    this._update();
    // Dot animation is disabled: with ~75k grid cells the per-frame redraw is
    // unaffordable, and the strip canvas already conveys lamp placement.
    return this;
  },

  onRemove(map) {
    map.off("zoomstart", this._beginViewChange, this);
    map.off("moveend zoomend resize viewreset", this._update, this);
    L.DomUtil.remove(this._glow);
    L.DomUtil.remove(this._dot);
  },

  _beginViewChange() {
    // For long throws, the canvas extent will move out from under the user.
    // Drop opacity slightly so the visual lag is less jarring; we restore
    // it after the redraw in _update.
    if (this._glow) {
      this._glow.style.opacity = "0.55";
      this._dot.style.opacity = "0.55";
    }
  },

  setVisible(v) {
    if (!this._glow) return;
    const d = v ? "" : "none";
    this._glow.style.display = d;
    this._dot.style.display = d;
  },

  requestShadowRebuild() {
    // Strip-based renderer no longer casts per-lamp building shadows; buildings
    // are drawn in their own pane above the lamp canvas so they occlude
    // strips visually without any per-edge geometry. Kept as a no-op so the
    // building loader can still call it.
  },

  _update() {
    if (!this._glow) return;
    // Canvas is sized larger than the viewport so that small pans still have
    // valid coverage near the edges without an immediate redraw.
    const PAD = 0.35; // 35% extra on each side
    const size = this._map.getSize();
    const padX = Math.round(size.x * PAD);
    const padY = Math.round(size.y * PAD);
    const w = size.x + 2 * padX;
    const h = size.y + 2 * padY;
    const dpr = window.devicePixelRatio || 1;

    // Anchor the canvas in layer-pixel coords. Done only at moveend / zoomend
    // so that during a pan the pane's CSS transform carries the canvas
    // naturally; the drawn lamps stay anchored to their lat/lngs.
    const tl = this._map.containerPointToLayerPoint([-padX, -padY]);
    L.DomUtil.setPosition(this._glow, tl);
    L.DomUtil.setPosition(this._dot, tl);

    for (const c of [this._glow, this._dot]) {
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
      c.style.width = w + "px";
      c.style.height = h + "px";
    }
    this._padX = padX;
    this._padY = padY;
    this._buildLampPx();
    this._drawGlow();
    this._glow.style.opacity = "1";
    this._dot.style.opacity = "1";
  },

  _buildLampPx() {
    const map = this._map;
    const dpr = window.devicePixelRatio || 1;
    const padX = this._padX || 0, padY = this._padY || 0;
    // Include the canvas padding when filtering visible lamps.
    const padDegLat = padY / 111320 + 0.001;
    const cosL = Math.cos(map.getCenter().lat * Math.PI / 180);
    const padDegLon = padX / (111320 * cosL) + 0.001;
    const bounds = map.getBounds();
    const minLat = bounds.getSouth() - padDegLat, maxLat = bounds.getNorth() + padDegLat;
    const minLon = bounds.getWest()  - padDegLon, maxLon = bounds.getEast()  + padDegLon;

    const c = map.getCenter();
    const p1 = map.latLngToContainerPoint(c);
    const p2 = map.latLngToContainerPoint([c.lat + 100 / 111320, c.lng]);
    const pxPerMetre = Math.abs(p2.y - p1.y) / 100;
    this._pxPerMetre = pxPerMetre;
    this._dpr = dpr;

    // Pixel position per lamp index, only for lamps inside the expanded canvas.
    // Edges then reference these via their two endpoint indices.
    const positions = new Map();
    for (let i = 0; i < this._lamps.length; i++) {
      const ll = this._lamps[i];
      if (ll[0] < minLat || ll[0] > maxLat || ll[1] < minLon || ll[1] > maxLon) continue;
      const pt = map.latLngToContainerPoint([ll[0], ll[1]]);
      positions.set(i, { x: pt.x + padX, y: pt.y + padY });
    }
    this._positions = positions;
  },

  _drawGlow() {
    if (!this._positions || !this._edges) return;
    const ctx = this._glow.getContext("2d");
    const dpr = this._dpr || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this._glow.width, this._glow.height);
    ctx.scale(dpr, dpr);
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const positions = this._positions;
    const edges = this._edges;
    const [R, G, B] = LAMP_RGB;

    // Pass 1: batched wide halo strokes (one big path, multiple stroke calls
    // at decreasing width). Gives the perpendicular feather across the road.
    ctx.beginPath();
    let any = false;
    for (let n = 0; n < edges.length; n++) {
      const e = edges[n];
      const pa = positions.get(e[0]);
      if (!pa) continue;
      const pb = positions.get(e[1]);
      if (!pb) continue;
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      any = true;
    }
    if (!any) { ctx.globalCompositeOperation = "source-over"; return; }
    for (const pass of LAMP_HALO_PASSES) {
      ctx.lineWidth = pass.width;
      ctx.strokeStyle = `rgba(${R},${G},${B},${pass.alpha})`;
      ctx.stroke();
    }

    // Pass 2: per-edge core stroke with a linear gradient bright at both
    // endpoints (the lamps) and dim at the midpoint. The midpoint dimness
    // grows with edge length, so closely-spaced lamps stay continuously
    // lit while far-apart lamps show a clear flare-off-rise pattern.
    ctx.lineWidth = LAMP_CORE_WIDTH;
    for (let n = 0; n < edges.length; n++) {
      const e = edges[n];
      const pa = positions.get(e[0]);
      if (!pa) continue;
      const pb = positions.get(e[1]);
      if (!pb) continue;
      const lenM = e[2];
      const midAlpha = Math.max(LAMP_CORE_DIM_MIN,
        LAMP_CORE_DIM_BASE - Math.max(0, lenM - STRIP_MIN_EDGE_M) * LAMP_CORE_DIM_FALLOFF);
      const g = ctx.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
      g.addColorStop(0,    `rgba(${R},${G},${B},${LAMP_CORE_ENDPOINT_ALPHA})`);
      g.addColorStop(0.5,  `rgba(${R},${G},${B},${midAlpha})`);
      g.addColorStop(1,    `rgba(${R},${G},${B},${LAMP_CORE_ENDPOINT_ALPHA})`);
      ctx.strokeStyle = g;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  },
});

const lampLayer = new LampLayer(lampStripPoints).addTo(map);

/* ---------- tree shade strip layer (day mode) ---------- */
/*
   Companion to the lamp glow: in day mode (trees on, lamps off), each tree
   contributes a soft dark ellipse stretched along its local street axis, so
   tree-lined streets show up as continuous shade strips on the light basemap.
   Live tree-trim SRs (treePoints) are merged in via refresh().
*/

const TreeShadeLayer = L.Layer.extend({
  initialize() {
    this._trees = [];
    this._edges = [];
    this._positions = null;
  },

  refresh() {
    const pts = [];
    for (const c of treeStripPoints) pts.push([c[0], c[1]]);
    for (const r of treePoints) pts.push([r.lat, r.lon]);
    this._trees = pts;
    const axes = computeStreetAxes(pts);
    this._edges = buildStripEdges(pts, axes);
    if (this._map) {
      this._buildTreePx();
      this._draw();
    }
  },

  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create("canvas", "tree-shade-canvas");
    map.getPane("tree-shade").appendChild(this._canvas);
    this._canvas.style.position = "absolute";
    this._canvas.style.left = "0";
    this._canvas.style.top = "0";
    this._canvas.style.pointerEvents = "none";
    if (!this._trees.length) this.refresh();
    map.on("moveend zoomend resize viewreset", this._update, this);
    this._update();
  },

  onRemove(map) {
    map.off("moveend zoomend resize viewreset", this._update, this);
    L.DomUtil.remove(this._canvas);
    this._canvas = null;
  },

  _update() {
    if (!this._canvas) return;
    const PAD = 0.35;
    const size = this._map.getSize();
    const padX = Math.round(size.x * PAD);
    const padY = Math.round(size.y * PAD);
    const w = size.x + 2 * padX;
    const h = size.y + 2 * padY;
    const dpr = window.devicePixelRatio || 1;
    const tl = this._map.containerPointToLayerPoint([-padX, -padY]);
    L.DomUtil.setPosition(this._canvas, tl);
    this._canvas.width = Math.max(1, Math.round(w * dpr));
    this._canvas.height = Math.max(1, Math.round(h * dpr));
    this._canvas.style.width = w + "px";
    this._canvas.style.height = h + "px";
    this._padX = padX;
    this._padY = padY;
    this._dpr = dpr;
    this._buildTreePx();
    this._draw();
  },

  _buildTreePx() {
    const map = this._map;
    if (!map) return;
    const padX = this._padX || 0, padY = this._padY || 0;
    const padDegLat = padY / 111320 + 0.001;
    const cosL = Math.cos(map.getCenter().lat * Math.PI / 180);
    const padDegLon = padX / (111320 * cosL) + 0.001;
    const bounds = map.getBounds();
    const minLat = bounds.getSouth() - padDegLat, maxLat = bounds.getNorth() + padDegLat;
    const minLon = bounds.getWest()  - padDegLon, maxLon = bounds.getEast()  + padDegLon;

    const c = map.getCenter();
    const p1 = map.latLngToContainerPoint(c);
    const p2 = map.latLngToContainerPoint([c.lat + 100 / 111320, c.lng]);
    this._pxPerMetre = Math.abs(p2.y - p1.y) / 100;

    const positions = new Map();
    for (let i = 0; i < this._trees.length; i++) {
      const p = this._trees[i];
      if (p[0] < minLat || p[0] > maxLat || p[1] < minLon || p[1] > maxLon) continue;
      const pt = map.latLngToContainerPoint([p[0], p[1]]);
      positions.set(i, { x: pt.x + padX, y: pt.y + padY });
    }
    this._positions = positions;
  },

  _draw() {
    if (!this._canvas || !this._positions || !this._edges) return;
    const ctx = this._canvas.getContext("2d");
    const dpr = this._dpr || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    ctx.scale(dpr, dpr);
    // Day mode: source-over accumulation on the light positron basemap.
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const positions = this._positions;
    const edges = this._edges;
    const [R, G, B] = TREE_SHADE_RGB;

    ctx.beginPath();
    let any = false;
    for (let n = 0; n < edges.length; n++) {
      const e = edges[n];
      const pa = positions.get(e[0]);
      if (!pa) continue;
      const pb = positions.get(e[1]);
      if (!pb) continue;
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      any = true;
    }
    if (!any) return;
    for (const pass of TREE_HALO_PASSES) {
      ctx.lineWidth = pass.width;
      ctx.strokeStyle = `rgba(${R},${G},${B},${pass.alpha})`;
      ctx.stroke();
    }

    ctx.lineWidth = TREE_CORE_WIDTH;
    for (let n = 0; n < edges.length; n++) {
      const e = edges[n];
      const pa = positions.get(e[0]);
      if (!pa) continue;
      const pb = positions.get(e[1]);
      if (!pb) continue;
      const lenM = e[2];
      const midAlpha = Math.max(TREE_CORE_DIM_MIN,
        TREE_CORE_DIM_BASE - Math.max(0, lenM - STRIP_MIN_EDGE_M) * TREE_CORE_DIM_FALLOFF);
      const g = ctx.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
      g.addColorStop(0,   `rgba(${R},${G},${B},${TREE_CORE_ENDPOINT_ALPHA})`);
      g.addColorStop(0.5, `rgba(${R},${G},${B},${midAlpha})`);
      g.addColorStop(1,   `rgba(${R},${G},${B},${TREE_CORE_ENDPOINT_ALPHA})`);
      ctx.strokeStyle = g;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
  },
});

const treeShadeLayer = new TreeShadeLayer();
treeShadeLayer.refresh();

function applyLampsState(on) {
  lampLayer.setVisible(on);
  if (on) recentLayer.addTo(map);
  else map.removeLayer(recentLayer);
}
bindCheckbox("lyr-lamps", (on) => {
  if (on) {
    const treesEl = document.getElementById("lyr-trees");
    if (treesEl && treesEl.checked) { treesEl.checked = false; applyTreesState(false); }
  }
  applyLampsState(on);
  updateMapMode();
});
bindCheckbox("lyr-sr-open", (on) => {
  srOpenEnabled = on;
  rebuildRecentVisuals();
});
bindCheckbox("lyr-sr-resolved", (on) => {
  srResolvedEnabled = on;
  rebuildRecentVisuals();
});
// Sync mode + occlusion to the initial toggle state once the layer exists.
queueMicrotask(updateMapMode);

function updateMapMode() {
  const lampsEl = document.getElementById("lyr-lamps");
  const treesEl = document.getElementById("lyr-trees");
  const lampsOn = lampsEl ? lampsEl.checked : true;
  const treesOn = treesEl ? treesEl.checked : true;
  // Day only when trees are on (lamps are forced off in day mode by the
  // mutual-exclusion toggle). Default = night.
  const mode = treesOn && !lampsOn ? "day" : "night";
  setBasemap(mode);
}

/* ---------- recent SR fetcher (live Socrata) ---------- */
/*
   Pulls all "Street Light Out Complaint" SRs from the unified 311 dataset
   v6vf-nfxy with created_date > 2026-05-23 00:00 Chicago local time. Socrata
   stores created_date as a floating timestamp tied to the dataset's locale
   (Chicago), so we pass the local date directly without UTC adjustment.
*/

const SOCRATA_DATASET = "v6vf-nfxy";
const RECENT_SINCE_CHICAGO = "2026-05-23T00:00:00.000";

const recentRenderer = L.canvas({ padding: 0.4 });
const recentLayer = L.layerGroup();
let recentPoints = [];

function setLayerProgress(id, on) {
  const el = document.getElementById(id);
  if (el) el.hidden = !on;
}

async function loadRecentSRs() {
  setLoading("Pulling latest 311 lamp reports…", 60);
  setLayerProgress("prog-lamps", true);
  try {
    return await _loadRecentSRsInner();
  } finally {
    setLayerProgress("prog-lamps", false);
  }
}

async function _loadRecentSRsInner() {
  const where = `sr_type='Street Light Out Complaint' AND created_date > '${RECENT_SINCE_CHICAGO}'`;
  const all = [];
  let offset = 0;
  const PAGE = 50000;
  while (true) {
    const params = new URLSearchParams({
      "$where": where,
      "$order": ":id",
      "$limit": String(PAGE),
      "$offset": String(offset),
      "$select": "sr_number,status,created_date,street_address,latitude,longitude",
    });
    const url = `https://data.cityofchicago.org/resource/${SOCRATA_DATASET}.json?` + params;
    let rows;
    try {
      const resp = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      rows = await resp.json();
    } catch (err) {
      console.warn("Socrata fetch failed:", err);
      break;
    }
    for (const r of rows) {
      const lat = parseFloat(r.latitude);
      const lon = parseFloat(r.longitude);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      all.push({
        lat, lon,
        d: (r.created_date || "").split("T")[0],
        s: r.status || "",
        a: r.street_address || "",
        sr: r.sr_number || "",
      });
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  recentPoints = all;
  rebuildRecentVisuals();
  fillStats();
}

let srOpenEnabled = true;
let srResolvedEnabled = true;
const isOpenSR = (r) => (r.s || "").startsWith("Open");

function rebuildRecentVisuals() {
  recentLayer.clearLayers();
  const filtered = recentPoints.filter((r) =>
    isOpenSR(r) ? srOpenEnabled : srResolvedEnabled);
  for (const r of filtered) {
    const isOpen = isOpenSR(r);
    const m = L.circleMarker([r.lat, r.lon], {
      renderer: recentRenderer,
      radius: isOpen ? 5 : 3,
      color: isOpen ? "#ff3a3a" : "#445",
      weight: 1.2,
      fillColor: isOpen ? "#ff3a3a" : "#667",
      fillOpacity: isOpen ? 0.8 : 0.35,
    });
    m.bindPopup(
      `<div class="addr">${escapeHtml(r.a || "Unknown address")}</div>` +
        `<div>Status: ${escapeHtml(r.s)}</div>` +
        `<div>Opened ${r.d || "?"}</div>` +
        `<div class="sr">SR ${escapeHtml(r.sr)}</div>`
    );
    recentLayer.addLayer(m);
  }
  // Both open and resolved complaints prove a physical lamp exists there;
  // toggling either filter changes which positions feed the strip canvas.
  if (typeof lampLayer !== "undefined" && lampLayer.setLamps) {
    const merged = lampStripPoints.slice();
    for (const r of filtered) merged.push([r.lat, r.lon]);
    lampLayer.setLamps(merged);
  }
}

// Live lamp SRs piggyback on the "Lamps & illumination" toggle - they are
// part of that layer's story, not a separate switch. Added to the map by
// default; the lyr-lamps handler below adds/removes them with the glow.
recentLayer.addTo(map);

/* ---------- tree icon factory ---------- */
/*
   Tree SVG with a variable number of "leaf clusters" around a central canopy.
   The tier (1..4) maps to leaf count + green saturation: tier 1 = just
   trimmed (sparse), tier 4 = long-overgrown / awaiting trim (full canopy).
*/

const TREE_ICON_SIZE = 28;
const treeIconCache = new Map();
function treeIcon(tier) {
  tier = Math.max(1, Math.min(4, tier | 0));
  const cached = treeIconCache.get(tier);
  if (cached) return cached;
  const pal = TREE_PALETTE[tier];
  const leafCount = TREE_LEAVES_PER_TIER[tier];
  const leaves = [];
  for (let i = 0; i < leafCount; i++) {
    const angle = (i / leafCount) * Math.PI * 2 - Math.PI / 2;
    const x = 14 + Math.cos(angle) * 7;
    const y = 12 + Math.sin(angle) * 7;
    leaves.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.4" fill="${pal.leaf}" stroke="#1c2a14" stroke-width="0.6"/>`
    );
  }
  const html =
    `<svg width="${TREE_ICON_SIZE}" height="${TREE_ICON_SIZE}" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="12.5" y="18" width="3" height="7" rx="1" fill="${pal.trunk}"/>` +
      `<circle cx="14" cy="12" r="5.2" fill="${pal.canopy}" stroke="#1c2a14" stroke-width="0.7"/>` +
      leaves.join("") +
    `</svg>`;
  const icon = L.divIcon({
    className: "tree-icon",
    html,
    iconSize: [TREE_ICON_SIZE, TREE_ICON_SIZE],
    iconAnchor: [TREE_ICON_SIZE / 2, TREE_ICON_SIZE - 4],
  });
  treeIconCache.set(tier, icon);
  return icon;
}

function tierLabel(tier) {
  return ["", "Just trimmed", "Regrowing", "Mostly regrown", "Full canopy"][Math.max(1, Math.min(4, tier))];
}

function treeIconSvgHtml(tier, size) {
  const t = Math.max(1, Math.min(4, tier));
  const pal = TREE_PALETTE[t];
  const leafCount = TREE_LEAVES_PER_TIER[t];
  const leaves = [];
  for (let i = 0; i < leafCount; i++) {
    const angle = (i / leafCount) * Math.PI * 2 - Math.PI / 2;
    const x = 14 + Math.cos(angle) * 7;
    const y = 12 + Math.sin(angle) * 7;
    leaves.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.4" fill="${pal.leaf}" stroke="#1c2a14" stroke-width="0.6"/>`);
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="12.5" y="18" width="3" height="7" rx="1" fill="${pal.trunk}"/>` +
    `<circle cx="14" cy="12" r="5.2" fill="${pal.canopy}" stroke="#1c2a14" stroke-width="0.7"/>` +
    leaves.join("") +
  `</svg>`;
}

function renderLegend() {
  const host = document.getElementById("legend-body");
  if (!host) return;
  const lampSwatch = (label) => {
    const [r, g, b] = LAMP_RGB;
    return `<div class="legend-row">` +
      `<span class="legend-swatch legend-lamp" style="background:linear-gradient(90deg, rgba(${r},${g},${b},0) 0%, rgba(${r},${g},${b},0.85) 50%, rgba(${r},${g},${b},0) 100%);"></span>` +
      `<span class="legend-label">${label}</span>` +
    `</div>`;
  };
  const dotSwatch = (color, label, alpha) => {
    return `<div class="legend-row">` +
      `<span class="legend-swatch legend-dot" style="background:${color};opacity:${alpha != null ? alpha : 1};"></span>` +
      `<span class="legend-label">${label}</span>` +
    `</div>`;
  };
  const treeSwatch = (tier) => {
    return `<div class="legend-row">` +
      `<span class="legend-swatch legend-tree">${treeIconSvgHtml(tier, 24)}</span>` +
      `<span class="legend-label">Tier ${tier} &middot; ${tierLabel(tier)}</span>` +
    `</div>`;
  };
  const lineSwatch = (color, dashed, label) => {
    const stroke = dashed
      ? `repeating-linear-gradient(90deg, ${color} 0 6px, transparent 6px 10px)`
      : color;
    return `<div class="legend-row">` +
      `<span class="legend-swatch legend-line" style="background:${stroke};"></span>` +
      `<span class="legend-label">${label}</span>` +
    `</div>`;
  };

  host.innerHTML =
    `<div class="legend-group"><div class="legend-title">Lamps</div>` +
      lampSwatch(`Light strip along the street axis (brightness = strips overlapping)`) +
    `</div>` +
    `<div class="legend-group"><div class="legend-title">Live lamp 311 (since 23 May 2026)</div>` +
      dotSwatch("#ff3a3a", "Open complaint", 0.85) +
      dotSwatch("#667",    "Resolved",       0.55) +
    `</div>` +
    `<div class="legend-group"><div class="legend-title">Trees</div>` +
      `<div class="legend-row"><span class="legend-swatch" style="background:radial-gradient(circle, rgba(15,35,18,0.55) 0%, rgba(15,35,18,0) 80%);"></span>` +
        `<span class="legend-label">Shade strip (day mode)</span></div>` +
    `</div>` +
    `<div class="legend-group"><div class="legend-title">Routes</div>` +
      lineSwatch("#4dffb6", false, "Brightest") +
      lineSwatch("#8a5cff", true,  "Alternative") +
    `</div>` +
    `<div class="legend-note muted x-small">` +
      `Lamps and trees are mutually exclusive: lamps render light strips along streets at night; trees render shade strips along streets in the day.` +
    `</div>`;
}
renderLegend();

/* ---------- tree layer state ---------- */
/*
   Tree icon markers were removed in favour of the shade-strip canvas; the
   strip canvas already conveys position + density, so the icons added visual
   clutter without new information.
*/

function applyTreesState(on) {
  if (on) treeShadeLayer.addTo(map);
  else map.removeLayer(treeShadeLayer);
}
bindCheckbox("lyr-trees", (on) => {
  if (on) {
    const lampsEl = document.getElementById("lyr-lamps");
    if (lampsEl && lampsEl.checked) { lampsEl.checked = false; applyLampsState(false); }
  }
  applyTreesState(on);
  updateMapMode();
});

/* ---------- recent tree-trim fetcher (live Socrata) ---------- */
/*
   Pulls 311 Tree Trim SRs from snkf-esnw with creation_date > 2026-05-27.
   snkf-esnw uses the legacy schema (Title Case columns at rest, snake_case
   in the API), and is the source bundled as tree-current.csv. If the
   dataset is still frozen at the 2018-12-19 cutoff this will return zero
   rows, which is the expected "no updates yet" state.
*/

const TREE_DATASET = "snkf-esnw";
const TREE_SINCE_CHICAGO = "2026-05-27T00:00:00.000";

async function loadRecentTreeTrims() {
  setLoading("Pulling latest 311 tree-trim reports…", 70);
  setLayerProgress("prog-trees", true);
  try {
    return await _loadRecentTreeTrimsInner();
  } finally {
    setLayerProgress("prog-trees", false);
  }
}

async function _loadRecentTreeTrimsInner() {
  const where = `creation_date > '${TREE_SINCE_CHICAGO}'`;
  const all = [];
  let offset = 0;
  const PAGE = 50000;
  while (true) {
    const params = new URLSearchParams({
      "$where": where,
      "$order": ":id",
      "$limit": String(PAGE),
      "$offset": String(offset),
      "$select": "service_request_number,status,creation_date,completion_date,street_address,location_of_trees,latitude,longitude",
    });
    const url = `https://data.cityofchicago.org/resource/${TREE_DATASET}.json?` + params;
    let rows;
    try {
      const resp = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      rows = await resp.json();
    } catch (err) {
      console.warn("Socrata tree-trim fetch failed:", err);
      break;
    }
    for (const r of rows) {
      const lat = parseFloat(r.latitude);
      const lon = parseFloat(r.longitude);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      all.push({
        lat, lon,
        d: (r.creation_date || "").split("T")[0],
        cd: (r.completion_date || "").split("T")[0],
        s: r.status || "",
        a: r.street_address || "",
        loc: r.location_of_trees || "",
        sr: r.service_request_number || "",
      });
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  treePoints = all;
  fillStats();
  if (typeof treeShadeLayer !== "undefined" && treeShadeLayer.refresh) {
    treeShadeLayer.refresh();
  }
}

function liveTreeTier(status, completionIso) {
  if ((status || "").toLowerCase().startsWith("open")) return 4;
  if (!completionIso) return 3;
  const d = new Date(completionIso + "T00:00:00Z");
  if (isNaN(d)) return 3;
  const days = Math.floor((TREE_LIVE_REFERENCE - d) / 86400000);
  if (days < 90) return 1;
  if (days < 365) return 2;
  if (days < 1095) return 3;
  return 4;
}

// Live tree-trim SRs piggyback on the "Trees & shade" toggle alongside the
// historical canopy layer; not auto-added (mutually exclusive with lamps).

function bindToggle(id, layer, after) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", () => {
    if (!layer) return;
    if (el.checked) layer.addTo(map);
    else map.removeLayer(layer);
    if (after) after();
  });
}
function bindCheckbox(id, fn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", () => fn(el.checked));
}

/* ---------- stats ---------- */

function fillStats() {
  const s = grid.summary || {};
  const uniqueLamps = s.unique_lamps || 0;
  const gridCells = (grid.cells || []).length;
  const bldgs = bldgManifest ? Object.values(bldgManifest.tiles).reduce((a, t) => a + (t.count || 0), 0) : 0;
  const openLive = recentPoints.filter((r) => (r.s || "").startsWith("Open")).length;
  document.getElementById("stats").innerHTML =
    `<strong>${gridCells.toLocaleString()}</strong> lamp grid cells (~55 m, drawn as illumination strips along the local street axis) from <strong>${uniqueLamps.toLocaleString()}</strong> deduplicated lamp positions. ` +
    (bldgs ? `${bldgs.toLocaleString()} local building footprints in ${Object.keys(bldgManifest.tiles).length} tiles. ` : "") +
    `${recentPoints.length.toLocaleString()} live lamp SRs since 2026-05-23 (${openLive} open). ` +
    `${(treeGrid.cells || []).length.toLocaleString()} tree shade-grid cells drawn as shade strips; ${treesData.length.toLocaleString()} tree icons (historical 311 trim SRs); ` +
    `${treePoints.length.toLocaleString()} live tree-trim SRs since 2026-05-27.`;
}
fillStats();

/* ---------- route picker ---------- */

const startIcon = L.divIcon({ className: "", html: '<div class="pin start"></div>', iconSize: [22,22], iconAnchor: [11,11] });
const endIcon = L.divIcon({ className: "", html: '<div class="pin end"></div>', iconSize: [22,22], iconAnchor: [11,11] });

let startMarker = null;
let endMarker = null;
let routeLayers = [];

map.on("click", onMapTap);

function onMapTap(e) {
  if (!pointInChicago(e.latlng.lat, e.latlng.lng)) {
    setStatus("Pick a point inside Chicago");
    return;
  }
  if (!startMarker) {
    startMarker = L.marker(e.latlng, { icon: startIcon, draggable: true }).addTo(map);
    startMarker.on("dragend", onMarkerDragEnd);
    setHelp("Now tap to set the destination.");
    setStatus("Start set - tap to choose destination");
  } else if (!endMarker) {
    endMarker = L.marker(e.latlng, { icon: endIcon, draggable: true }).addTo(map);
    endMarker.on("dragend", onMarkerDragEnd);
    document.getElementById("route-actions").hidden = false;
    setHelp("");
    openPanel();
    recomputeRoutes();
  }
}

function onMarkerDragEnd(ev) {
  const m = ev.target;
  const prev = m._lastValidLatLng || m.getLatLng();
  const ll = m.getLatLng();
  if (!pointInChicago(ll.lat, ll.lng)) {
    m.setLatLng(prev);
    setStatus("Drag point back inside Chicago");
    return;
  }
  m._lastValidLatLng = ll;
  recomputeRoutes();
}

document.getElementById("btn-route-clear").addEventListener("click", clearRoute);

function clearRoute() {
  if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
  if (endMarker) { map.removeLayer(endMarker); endMarker = null; }
  clearRouteLayers();
  setHelp("Tap the map to drop a start, then tap again for the destination. Routes are scored by lamp density within 80 m.");
  document.getElementById("route-actions").hidden = true;
  document.getElementById("route-results").innerHTML = "";
  panel.classList.remove("has-route");
  setStatus("Tap two points for a brightly-lit route");
}

function setStatus(text) {
  const el = document.getElementById("topbar-sub");
  if (el) el.textContent = text;
}
function setHelp(text) {
  const el = document.getElementById("route-help");
  el.textContent = text;
  el.style.display = text ? "block" : "none";
}
function clearRouteLayers() {
  for (const r of routeLayers) map.removeLayer(r.layer);
  routeLayers = [];
}

async function recomputeRoutes() {
  if (!startMarker || !endMarker) return;
  clearRouteLayers();
  const a = startMarker.getLatLng();
  const b = endMarker.getLatLng();
  const url =
    `${OSRM_BASE}/${a.lng},${a.lat};${b.lng},${b.lat}` +
    `?alternatives=true&overview=full&geometries=geojson&steps=false`;

  document.getElementById("route-results").innerHTML =
    `<p class="muted small">Finding pedestrian routes…</p>`;

  let data;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`OSRM HTTP ${resp.status}`);
    data = await resp.json();
  } catch (err) {
    document.getElementById("route-results").innerHTML =
      `<p class="muted small">Routing failed: ${escapeHtml(String(err))}. The public OSRM demo may be rate-limited - try again shortly.</p>`;
    return;
  }
  if (!data.routes || !data.routes.length) {
    document.getElementById("route-results").innerHTML =
      `<p class="muted small">No routes found between those points.</p>`;
    return;
  }

  const scored = data.routes.map((r) => {
    const coords = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    return { coords, distance: r.distance, duration: r.duration, score: scoreRoute(coords) };
  });
  scored.sort((x, y) => y.score.perKm - x.score.perKm);

  scored.forEach((s, rank) => {
    const color = rank === 0 ? "#4dffb6" : "#8a5cff";
    const weight = rank === 0 ? 5 : 3;
    const opacity = rank === 0 ? 0.95 : 0.5;
    const layer = L.polyline(s.coords, {
      renderer: routeRenderer, color, weight, opacity,
      dashArray: rank === 0 ? null : "6 4",
    }).addTo(map);
    routeLayers.push({ layer, rank, route: s });
  });

  const bounds = L.latLngBounds([]);
  for (const r of routeLayers) bounds.extend(r.layer.getBounds());
  map.fitBounds(bounds, { padding: [50, 50] });

  renderRouteCards(scored);
  setActiveRoute(0);
  panel.classList.add("has-route");
  const best = scored[0];
  setStatus(`Brightest route: ${best.score.perKm.toFixed(0)} lamps/km, ${best.score.shadePerKm.toFixed(0)} leaves/km`);
}

function setActiveRoute(idx) {
  routeLayers.forEach((r, i) => {
    r.layer.setStyle({
      weight: i === idx ? 7 : 4,
      opacity: i === idx ? 1.0 : 0.45,
    });
  });
  document.querySelectorAll(".route-card").forEach((el, i) => {
    el.classList.toggle("active", i === idx);
  });
}

function renderRouteCards(scored) {
  const host = document.getElementById("route-results");
  host.innerHTML = "";
  scored.forEach((s, rank) => {
    const km = (s.distance / 1000).toFixed(2);
    const min = Math.round(s.duration / 60);
    const tier = brightnessTier(s.score.perKm);
    const shade = shadeTier(s.score.shadePerKm);
    const card = document.createElement("div");
    card.className = "route-card" + (rank === 0 ? " brightest" : "");
    const label = rank === 0 ? "Brightest" : "Alternative " + (rank + 1);
    card.innerHTML =
      `<div class="name">${label} &middot; ${km} km, ${min} min</div>` +
      `<div class="meta">~${Math.round(s.score.lamps)} lamps within ${EXPOSURE_RADIUS_M} m, ` +
      `~${Math.round(s.score.shade)} leaf-weighted trees within ${SHADE_RADIUS_M} m</div>` +
      `<div class="score-bar">` +
      `<span class="pill ${tier.cls}">${tier.label}</span>` +
      `<span class="pill">${s.score.perKm.toFixed(0)} lamps/km</span>` +
      `<span class="pill ${shade.cls}">${shade.label}</span>` +
      `<span class="pill">${s.score.shadePerKm.toFixed(0)} leaves/km</span>` +
      `</div>`;
    card.addEventListener("click", () => setActiveRoute(rank));
    host.appendChild(card);
  });
}

function brightnessTier(perKm) {
  if (perKm >= 80) return { label: "Brightly lit", cls: "bright" };
  if (perKm >= 35) return { label: "Moderately lit", cls: "medium" };
  return { label: "Sparsely lit", cls: "dim" };
}

function shadeTier(perKm) {
  if (perKm >= 300) return { label: "Deep shade", cls: "shade-deep" };
  if (perKm >= 120) return { label: "Some shade", cls: "shade-some" };
  return { label: "Exposed", cls: "shade-none" };
}

function scoreRoute(coords) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [lat, lon] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  const lampPad = (EXPOSURE_RADIUS_M + 30) / 111000;
  const lampCells = cellsInBBox(
    minLat - lampPad, maxLat + lampPad,
    minLon - lampPad, maxLon + lampPad
  );
  let lamps = 0;
  for (const c of lampCells) {
    if (minDistanceToPolyline(c[0], c[1], coords) <= EXPOSURE_RADIUS_M) lamps += c[2];
  }

  const shadePad = (SHADE_RADIUS_M + 30) / 111000;
  const shadeCells = treeCellsInBBox(
    minLat - shadePad, maxLat + shadePad,
    minLon - shadePad, maxLon + shadePad
  );
  let shade = 0;
  for (const c of shadeCells) {
    if (minDistanceToPolyline(c[0], c[1], coords) <= SHADE_RADIUS_M) shade += c[2];
  }

  const km = Math.max(coordsLengthMeters(coords) / 1000, 0.05);
  return { lamps, perKm: lamps / km, shade, shadePerKm: shade / km };
}

const COS_LAT = Math.cos((41.85 * Math.PI) / 180);
const M_PER_DEG_LAT = 111320;
function coordsLengthMeters(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const dx = (coords[i][1] - coords[i-1][1]) * COS_LAT * M_PER_DEG_LAT;
    const dy = (coords[i][0] - coords[i-1][0]) * M_PER_DEG_LAT;
    total += Math.sqrt(dx*dx + dy*dy);
  }
  return total;
}
function minDistanceToPolyline(plat, plon, coords) {
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const d = pointToSegmentMeters(plat, plon, coords[i - 1], coords[i]);
    if (d < best) best = d;
  }
  return best;
}
function pointToSegmentMeters(plat, plon, a, b) {
  const bx = (b[1] - a[1]) * COS_LAT * M_PER_DEG_LAT;
  const by = (b[0] - a[0]) * M_PER_DEG_LAT;
  const px = (plon - a[1]) * COS_LAT * M_PER_DEG_LAT;
  const py = (plat - a[0]) * M_PER_DEG_LAT;
  const len2 = bx*bx + by*by;
  let t = 0;
  if (len2 > 0) t = (px*bx + py*by) / len2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = t * bx, cy = t * by;
  const ex = px - cx, ey = py - cy;
  return Math.sqrt(ex*ex + ey*ey);
}

/* ---------- panel + locate ---------- */

const panel = document.getElementById("panel");
const grab = document.getElementById("grab");
const btnPanel = document.getElementById("btn-panel");
function openPanel() { panel.classList.add("open"); panel.classList.remove("collapsed"); }
function closePanel() { panel.classList.remove("open"); panel.classList.add("collapsed"); }
function togglePanel() { panel.classList.contains("open") ? closePanel() : openPanel(); }
btnPanel.addEventListener("click", togglePanel);
grab.addEventListener("click", togglePanel);

let dragStartY = null;
function dragStart(e) { dragStartY = (e.touches ? e.touches[0].clientY : e.clientY); }
function dragEnd(e) {
  if (dragStartY == null) return;
  const endY = (e.changedTouches ? e.changedTouches[0].clientY : e.clientY);
  const delta = endY - dragStartY;
  if (delta < -30) openPanel();
  else if (delta > 30) closePanel();
  dragStartY = null;
}
grab.addEventListener("touchstart", dragStart, { passive: true });
grab.addEventListener("touchend", dragEnd);
grab.addEventListener("mousedown", dragStart);
grab.addEventListener("mouseup", dragEnd);

const btnLocate = document.getElementById("btn-locate");
btnLocate.addEventListener("click", () => {
  if (!navigator.geolocation) { alert("Geolocation isn't available."); return; }
  btnLocate.classList.add("active");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btnLocate.classList.remove("active");
      const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
      if (!CHICAGO_BOUNDS.contains(ll)) {
        alert("Your location is outside Chicago - this map is locked to the city.");
        return;
      }
      map.setView(ll, 16);
      if (startMarker && endMarker) clearRoute();
      onMapTap({ latlng: ll });
    },
    (err) => {
      btnLocate.classList.remove("active");
      alert("Couldn't get location: " + err.message);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

/* ---------- viewport-change hooks ---------- */

let viewportTimer = null;
map.on("moveend zoomend", () => {
  clearTimeout(viewportTimer);
  viewportTimer = setTimeout(refreshBuildings, 80);
});

/* ---------- startup ---------- */

setLoading("Ready", 95);
setTimeout(hideLoading, 250);

// Live SR fetches run in the background; don't block initial render.
Promise.all([loadRecentSRs(), loadRecentTreeTrims()])
  .then(() => setLoading("Up to date", 100));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
