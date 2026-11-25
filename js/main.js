/* Best-Lit Line, in Chicago. App shell: map, modes, live data, routing, walk. */

import { buildStyle, applyPalette, setSunLight } from "./style.js?v=20261125r";
import { World3D, BLDG_ZOOM } from "./world3d.js?v=20261125r";
import { Walker } from "./walk.js?v=20261125r";
import {
  CellIndex, boundaryRings, pointInRings, isDaylight, sunPosition, nextTransition,
  chicagoClock, scoreRoute, metersBetween,
} from "./geo.js?v=20261125r";

const lampGrid = window.__LAMP_GRID__ || { cells: [], summary: {} };
const treeGrid = window.__TREE_GRID__ || { cells: [], summary: {} };
const chicago = window.__CHICAGO__ || null;
const rings = boundaryRings(chicago);
const lampIndex = new CellIndex(lampGrid.cells);
const treeIndex = new CellIndex(treeGrid.cells);

const isTouch = matchMedia("(pointer: coarse)").matches;
const VERB = isTouch ? "Tap" : "Click";
const $ = (id) => document.getElementById(id);
document.body.classList.toggle("touch", isTouch);

const CLOUD_GATE = [-87.62333, 41.88266];        // Millennium Park
const CHI = [-87.6298, 41.8781];
const SOCRATA = "https://data.cityofchicago.org/resource/v6vf-nfxy.json";
const LIVE_SINCE = "2026-05-23T00:00:00.000";
const ROUTERS = [
  "https://routing.openstreetmap.de/routed-foot/route/v1/foot",   // true pedestrian profile
  "https://router.project-osrm.org/route/v1/foot",
];

/* ---------------------------------------------------------------- loader */

function setLoading(text, pct) {
  if (text != null) $("loader-text").textContent = text;
  if (pct != null) $("loader-bar").style.width = pct + "%";
}
function hideLoading() {
  const o = $("loading-overlay");
  if (!o || o.classList.contains("done")) return;
  o.classList.add("done");
  setTimeout(() => o.remove(), 700);
}
setLoading("Wiring the street grid", 20);

/* ---------------------------------------------------------------- day / night */

// Set once on "load". Not map.isStyleLoaded(): that is false whenever any tile is still loading.
let styleReady = false;
let modeAuto = true;
let mode = isDaylight() ? "day" : "night";
document.body.dataset.mapMode = mode;
$(mode === "day" ? "mode-day" : "mode-night").checked = true;

function sunNow() { return sunPosition(new Date(), CHI[1], CHI[0]); }

function setMode(next, { auto } = {}) {
  if (auto !== undefined) modeAuto = auto;
  mode = next;
  document.body.dataset.mapMode = mode;
  $(mode === "day" ? "mode-day" : "mode-night").checked = true;
  $("meta-theme").setAttribute("content", mode === "day" ? "#f3ebdb" : "#0e131a");
  if (styleReady) {
    applyPalette(map, mode);
    setSunLight(map, mode, sunNow());
  }
  world.setMode(mode, sunNow());
  renderClockNote();
  refreshLegendCopy();
}

function renderClockNote() {
  const el = $("clock-note");
  const t = nextTransition();
  const when = t ? `${t.toDay ? "sunrise" : "dusk"} ${chicagoClock(t.at)}` : "";
  if (modeAuto) {
    el.innerHTML = `<span class="live-dot"></span>Live: ${chicagoClock()} in Chicago${when ? ` · ${when}` : ""}`;
  } else {
    el.innerHTML = `Exploring ${mode === "day" ? "daytime" : "night"} · <button class="link-btn" id="btn-live">Back to live time</button>`;
    $("btn-live").addEventListener("click", () => setMode(isDaylight() ? "day" : "night", { auto: true }));
  }
}
for (const id of ["mode-night", "mode-day"]) {
  $(id).addEventListener("change", (e) => {
    const next = e.target.value;
    const live = isDaylight() ? "day" : "night";
    setMode(next, { auto: next === live && modeAuto });
    if (next !== live) { modeAuto = false; renderClockNote(); }
  });
}
setInterval(() => {
  if (modeAuto) {
    const live = isDaylight() ? "day" : "night";
    if (live !== mode) setMode(live, { auto: true });
    else { renderClockNote(); if (styleReady) setSunLight(map, mode, sunNow()); world.setMode(mode, sunNow()); }
  }
}, 60000);

/* ---------------------------------------------------------------- map */

// Keep the drawing buffer within a pixel budget: crisp on laptops, sane on 4K and phones.
const area = innerWidth * innerHeight;
const pixelRatio = Math.max(1, Math.min(window.devicePixelRatio || 1, isTouch ? 1.5 : 2, Math.sqrt(3.2e6 / area)));

// the folder this page lives in: tiles/ and vendor/ sit beside it (works locally and on GitHub Pages)
const BASE = new URL(".", location.href).href;

// ?cam=lng,lat,zoom,pitch,bearing opens on a given view (handy for sharing a spot, and for testing)
const CAM = (new URLSearchParams(location.search).get("cam") || "").split(",").map(Number);
const camOk = CAM.length === 5 && CAM.every(Number.isFinite);
const map = new maplibregl.Map({
  container: "map",
  style: buildStyle(mode, BASE),
  center: camOk ? [CAM[0], CAM[1]] : CLOUD_GATE,
  zoom: camOk ? CAM[2] : isTouch ? 16.6 : 17.05,
  pitch: camOk ? CAM[3] : 64,
  bearing: camOk ? CAM[4] : -96,                  // looking west over the bean to the Michigan Avenue wall
  maxPitch: 80,
  minZoom: 10,
  maxZoom: 20.5,
  maxBounds: [[-88.15, 41.55], [-87.3, 42.15]],
  pixelRatio,
  canvasContextAttributes: { antialias: !isTouch },
  attributionControl: false,
  fadeDuration: 150,
});
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> · ' +
    '<a href="https://www.openmaptiles.org/" target="_blank">© OpenMapTiles</a> · ' +
    '<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap</a>',
}), "bottom-right");
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

// Hold right mouse (or Ctrl/⌘ + left) to turn the camera like a game:
// move right and you look right, move up and you look toward the horizon.
// Replaces MapLibre's built-in rotate, which spins around the screen centre
// and reverses depending on where the cursor is.
map.dragRotate.disable();
{
  const el = map.getCanvasContainer();
  let drag = null;
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener("pointerdown", (e) => {
    if (walker || e.pointerType === "touch") return;
    if (e.button === 2 || (e.button === 0 && (e.ctrlKey || e.metaKey))) {
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      map.dragPan.disable();
      attract = false;
      e.preventDefault();
    }
  });
  addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    map.jumpTo({ bearing: map.getBearing() + dx * 0.45, pitch: Math.max(0, Math.min(80, map.getPitch() - dy * 0.35)) });
  });
  const end = (e) => { if (drag && e.pointerId === drag.id) { drag = null; if (!walker) map.dragPan.enable(); } };
  addEventListener("pointerup", end);
  addEventListener("pointercancel", end);
}

const world = new World3D(map, {
  lampIndex, treeIndex,
  onArea: () => fillStats(),
  onProgress: (label, f) => {
    if (label === "ready") { setLoading("Ready", 100); setTimeout(hideLoading, 200); return; }
    setLoading(label, 40 + f * 58);
  },
});
world.tileUrl = BASE + "tiles/{z}/{x}/{y}.pbf";      // the 3D city reads the same local tiles
world.streetsUrl = BASE + "data/streets/{z}/{x}/{y}.json";   // real lanes, crossings, signals, railways (OSM)
world.onSlow = (q) => {
  // second line of defence after thinning the crowd: fewer pixels
  if (q < 0.5 && map.getPixelRatio() > 1) map.setPixelRatio(Math.max(1, map.getPixelRatio() * 0.8));
};
world.setMode(mode, sunNow());

if (camOk) window.__map = map;                    // test views only: lets tooling inspect the map
map.on("load", () => {
  styleReady = true;
  // tilted views: keep full street detail further toward the horizon (default drops it sooner)
  if (map.setSourceTileLodParams) map.setSourceTileLodParams(12, 4, "ofm");
  setLoading("Lighting the lamps", 60);
  map.getSource("lampHeat").setData(cellsToPoints(lampGrid.cells));
  map.getSource("treeHeat").setData(cellsToPoints(treeGrid.cells));
  if (chicago) {
    map.getSource("boundary").setData(chicago);
    map.getSource("mask").setData(outsideMask(rings));
  }
  map.addLayer(world);                // on top: shares the depth buffer with everything below
  setSunLight(map, mode, sunNow());
  // the loader stays up until the first neighbourhood is built and its shaders have compiled
  map.once("idle", () => world.rebuild(false));
  setTimeout(hideLoading, 20000);
  loadLiveReports();
});
map.on("idle", () => world.maybeRebuild());
map.on("error", (e) => console.warn("Map error:", e && e.error && e.error.message));

function cellsToPoints(cells) {
  const features = new Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    features[i] = { type: "Feature", properties: { n: c[2] }, geometry: { type: "Point", coordinates: [c[1], c[0]] } };
  }
  return { type: "FeatureCollection", features };
}

function signedArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2;
}
function outsideMask(rs) {
  const outer = [[-89.5, 40.5], [-86, 40.5], [-86, 43.5], [-89.5, 43.5], [-89.5, 40.5]];
  const holes = [];
  const outerSign = Math.sign(signedArea(outer));
  // only the outer rings of each city polygon become holes, wound against the frame
  for (const f of chicago.features) {
    const g = f.geometry;
    const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
    for (const poly of polys) {
      const ring = poly[0].slice();
      if (Math.sign(signedArea(ring)) === outerSign) ring.reverse();
      holes.push(ring);
    }
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [outer, ...holes] } };
}

/* ---------------------------------------------------------------- frame loop */
/* Only asks MapLibre for frames while something is actually moving. */

let attract = !camOk;
let buildingsOn = true;
let basicShown = true;
let lastTick = performance.now();
let flickerT = 0;
for (const ev of ["mousedown", "touchstart", "wheel", "keydown"]) {
  map.getCanvasContainer().addEventListener(ev, () => { attract = false; }, { passive: true, once: true });
}
function tick(now) {
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  if (!document.hidden && styleReady) {
    if (attract && !world.walker && world.ready) map.setBearing(map.getBearing() + dt * 1.6);
    if (world.wantsFrames()) map.triggerRepaint();
    // MapLibre's plain extrusions only where our facades don't reach, so the two never fight
    const showBasic = buildingsOn && (map.getZoom() < BLDG_ZOOM || !world.coversView());
    if (showBasic !== basicShown) {
      basicShown = showBasic;
      map.setLayoutProperty("building-3d", "visibility", showBasic ? "visible" : "none");
    }
    // city-scale outage dots flicker in three unsynchronised groups
    flickerT += dt;
    if (flickerT > 0.11 && mode === "night" && map.getZoom() < 15.5 && liveReports.some((r) => r.open)) {
      flickerT = 0;
      const t = now / 1000;
      for (let k = 0; k < 3; k++) {
        const cyc = (t / (3.2 + k * 0.7) + k * 0.33) % 1;
        const v = cyc < 0.3 ? 0.12 : cyc < 0.55 ? (Math.random() > 0.45 ? 0.95 : 0.15) : 0.85;
        map.setPaintProperty("reports-open-" + k, "circle-opacity", v);
      }
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/* ---------------------------------------------------------------- live 311 */

let liveReports = [];
let liveState = "loading";

async function loadLiveReports() {
  $("prog-live").hidden = false;
  const where = `sr_type='Street Light Out Complaint' AND created_date > '${LIVE_SINCE}'`;
  const all = [];
  try {
    for (let offset = 0; ; offset += 50000) {
      const params = new URLSearchParams({
        $where: where, $order: ":id", $limit: "50000", $offset: String(offset),
        $select: "sr_number,status,created_date,street_address,latitude,longitude",
      });
      const resp = await fetch(`${SOCRATA}?${params}`, { headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const rows = await resp.json();
      for (const r of rows) {
        const lat = parseFloat(r.latitude), lng = parseFloat(r.longitude);
        if (!isFinite(lat) || !isFinite(lng)) continue;
        all.push({ lat, lng, open: (r.status || "").startsWith("Open"), addr: r.street_address || "", sr: r.sr_number || "",
                   d: (r.created_date || "").split("T")[0] });
      }
      if (rows.length < 50000) break;
    }
    liveState = "ok";
  } catch (err) {
    console.warn("311 feed unavailable:", err);
    liveState = "error";
  }
  liveReports = all;
  $("prog-live").hidden = true;
  applyReportFilter();
  fillStats();
}

function applyReportFilter() {
  const showOpen = $("lyr-sr-open").checked, showRes = $("lyr-sr-resolved").checked;
  const feats = [];
  liveReports.forEach((r, i) => {
    if (r.open ? !showOpen : !showRes) return;
    feats.push({ type: "Feature", properties: { open: r.open, g: i % 3 }, geometry: { type: "Point", coordinates: [r.lng, r.lat] } });
  });
  if (map.getSource("reports")) map.getSource("reports").setData({ type: "FeatureCollection", features: feats });
  world.reports = liveReports;
  world.setReportFilter(showOpen, showRes);
}

/* ---------------------------------------------------------------- layers */

$("lyr-sr-open").addEventListener("change", applyReportFilter);
$("lyr-sr-resolved").addEventListener("change", applyReportFilter);
$("lyr-agents").addEventListener("change", (e) => world.setAgents(e.target.checked));
$("lyr-buildings").addEventListener("change", (e) => { buildingsOn = e.target.checked; world.setBuildings(buildingsOn); });
$("lyr-boundary").addEventListener("change", (e) => {
  const v = e.target.checked ? "visible" : "none";
  map.setLayoutProperty("boundary", "visibility", v);
  map.setLayoutProperty("outside-mask", "visibility", v);
});

function refreshLegendCopy() { /* legend rows are scoped with .night-only / .day-only in CSS */ }

/* ---------------------------------------------------------------- stats */

function fillStats() {
  const s = lampGrid.summary || {};
  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n.toLocaleString());
  const item = (v, label, pending) => `<div${pending ? ' class="pending"' : ""}><dt>${label}</dt><dd>${v}</dd></div>`;
  const open = liveReports.filter((r) => r.open).length;
  const liveLabel = liveState === "ok" ? "lamps reported out since 23 May"
    : liveState === "error" ? "live 311 feed unavailable" : "checking 311 for outages…";
  $("stats").innerHTML =
    item(fmt(s.unique_lamps || lampGrid.cells.length), "known lamp positions") +
    item(liveState === "ok" ? fmt(open) : "–", liveLabel, liveState !== "ok") +
    item(world.lampPosts ? fmt(world.lampPosts.length) : "–", "lamps standing around you", !world.lampPosts) +
    item(world.people.length ? fmt(world.people.length + world.cars.length) : "–", "people and cars out", !world.people.length);
}
fillStats();

/* ---------------------------------------------------------------- status pill */

function setStatus(text, flash) {
  const el = $("topbar-sub");
  el.textContent = text;
  if (flash) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
}
setStatus(`${VERB} the map to set a start point`);
$("step-1-sub").textContent = `${VERB} a street anywhere in the city`;

/* ---------------------------------------------------------------- route picking */

let startMarker = null, endMarker = null, routes = [], activeRoute = 0, walker = null;

function pinEl(cls, letter) {
  const el = document.createElement("div");
  el.className = "pin-anchor";
  el.innerHTML = `<div class="pin ${cls}"><span>${letter}</span></div>`;
  return el;
}

map.on("click", (e) => {
  if (walker) return;
  attract = false;
  const { lng, lat } = e.lngLat;
  if (!pointInRings(rings, lng, lat)) { setStatus("That's outside city limits. Pick a point inside Chicago", true); return; }
  if (!startMarker) {
    startMarker = new maplibregl.Marker({ element: pinEl("start", "A"), anchor: "bottom", offset: [0, -6], draggable: true })
      .setLngLat([lng, lat]).addTo(map);
    startMarker.on("dragend", onDragEnd);
    setStep(2);
    setStatus(`${VERB} again to set a destination`);
    $("btn-route-clear").hidden = false;
  } else if (!endMarker) {
    endMarker = new maplibregl.Marker({ element: pinEl("end", "B"), anchor: "bottom", offset: [0, -6], draggable: true })
      .setLngLat([lng, lat]).addTo(map);
    endMarker.on("dragend", onDragEnd);
    setStep(0);
    recomputeRoutes({ autoWalk: true });
  }
});

function onDragEnd(ev) {
  const m = ev.target;
  const ll = m.getLngLat();
  if (!pointInRings(rings, ll.lng, ll.lat)) {
    m.setLngLat(m._last || ll);
    setStatus("Keep the pin inside Chicago", true);
    return;
  }
  m._last = ll;
  recomputeRoutes({ autoWalk: false });
}

$("btn-route-clear").addEventListener("click", clearRoute);
function clearRoute() {
  resumeState = null;
  if (walker) exitWalk(true);
  startMarker && startMarker.remove(); endMarker && endMarker.remove();
  startMarker = endMarker = null;
  routes = [];
  map.getSource("routes").setData({ type: "FeatureCollection", features: [] });
  setStep(1);
  $("btn-route-clear").hidden = true;
  $("route-results").innerHTML = "";
  $("panel").classList.remove("has-route");
  setStatus(`${VERB} the map to set a start point`);
}

function setStep(n) {
  const el = $("route-help");
  el.dataset.step = String(n);
  el.hidden = n === 0;
}

let routeReq = 0;
async function recomputeRoutes({ autoWalk }) {
  if (!startMarker || !endMarker) return;
  const req = ++routeReq;
  const a = startMarker.getLngLat(), b = endMarker.getLngLat();
  const host = $("route-results");
  host.innerHTML = `<p class="route-loading">Finding walking routes</p>`;
  setStatus("Finding walking routes…");
  let data = null;
  for (const base of ROUTERS) {
    try {
      const resp = await fetch(`${base}/${a.lng},${a.lat};${b.lng},${b.lat}?alternatives=true&overview=full&geometries=geojson&steps=false`);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      data = await resp.json();
      if (data.routes && data.routes.length) break;
    } catch (err) {
      console.warn("Router failed:", base, err);
    }
  }
  if (req !== routeReq || !startMarker || !endMarker) return;
  if (!data || !data.routes || !data.routes.length) {
    host.innerHTML = `<p class="route-msg">${data ? "No walking route connects those two points." :
      "The routing service didn't respond. It's a shared public server and is sometimes busy. Drag either pin to try again."}</p>`;
    setStatus(data ? "No route found" : "Routing unavailable. Try again shortly", true);
    return;
  }
  resumeState = null;                               // a new route starts from A
  routes = data.routes.map((r) => ({ coords: r.geometry.coordinates, distance: r.distance, duration: r.duration,
    score: scoreRoute(r.geometry.coordinates, lampIndex, treeIndex) }));
  routes.sort((x, y) => y.score.perKm - x.score.perKm);
  activeRoute = 0;
  drawRoutes();
  renderRouteCards();
  $("panel").classList.add("has-route");

  const bounds = new maplibregl.LngLatBounds();
  for (const r of routes) for (const c of r.coords) bounds.extend(c);
  const desktop = innerWidth >= 760;
  map.fitBounds(bounds, { padding: { top: 90, left: 60, right: 70, bottom: desktop ? 60 : Math.round(innerHeight * 0.5) },
    pitch: 48, bearing: map.getBearing(), duration: 1400, maxZoom: 17 });

  const best = routes[0];
  setStatus(routes.length > 1
    ? `Best lit of ${routes.length}: ${best.score.perKm.toFixed(0)} lamps per km`
    : `${best.score.perKm.toFixed(0)} lamps per km along this route`);
  if (autoWalk) setTimeout(() => { if (req === routeReq && !walker) startWalk(); }, 2300);
}

function drawRoutes() {
  map.getSource("routes").setData({
    type: "FeatureCollection",
    features: routes.map((r, i) => ({ type: "Feature", properties: { rank: i, active: i === activeRoute },
      geometry: { type: "LineString", coordinates: r.coords } })),
  });
}

function setActiveRoute(i) {
  activeRoute = i;
  drawRoutes();
  document.querySelectorAll(".route-card").forEach((el, k) => {
    el.classList.toggle("active", k === i);
    el.setAttribute("aria-pressed", k === i ? "true" : "false");
  });
}

function brightnessTier(v) {
  if (v >= 80) return { label: "Well lit", cls: "t-good" };
  if (v >= 35) return { label: "Patchy", cls: "t-mid" };
  return { label: "Dark stretches", cls: "t-poor" };
}
function shadeTier(v) {
  if (v >= 300) return { label: "Deep shade", cls: "t-good" };
  if (v >= 120) return { label: "Some shade", cls: "t-mid" };
  return { label: "Exposed", cls: "t-poor" };
}

function renderRouteCards() {
  const host = $("route-results");
  host.innerHTML = "";
  routes.forEach((s, rank) => {
    const km = s.distance / 1000;
    const dist = km < 1 ? `${Math.round(s.distance)} m` : `${km.toFixed(1)} km`;
    const min = Math.max(1, Math.round(s.duration / 60));
    const light = brightnessTier(s.score.perKm), shade = shadeTier(s.score.shadePerKm);
    const lightPct = Math.min(100, (s.score.perKm / 120) * 100), shadePct = Math.min(100, (s.score.shadePerKm / 400) * 100);
    const label = rank === 0 ? (routes.length > 1 ? "Best lit" : "Route") : `Alternative ${rank}`;
    const card = document.createElement("div");
    card.className = "route-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.innerHTML =
      `<div class="rc-head"><div class="rc-name"><span class="rc-key${rank ? " alt" : ""}"></span>${label}</div>` +
      `<div class="rc-trip">${dist} &middot; ${min} min</div></div>` +
      `<div class="rc-metrics">` +
        `<div class="metric"><div class="metric-value">${s.score.perKm.toFixed(0)}</div><div class="metric-unit">lamps per km</div>` +
        `<div class="meter"><span class="${light.cls}" style="width:${lightPct.toFixed(0)}%"></span></div>` +
        `<div class="metric-tier ${light.cls}">${light.label}</div></div>` +
        `<div class="metric"><div class="metric-value">${s.score.shadePerKm.toFixed(0)}</div><div class="metric-unit">canopy per km</div>` +
        `<div class="meter"><span class="${shade.cls}" style="width:${shadePct.toFixed(0)}%"></span></div>` +
        `<div class="metric-tier ${shade.cls}">${shade.label}</div></div>` +
      `</div>` +
      `<button class="walk-btn" type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="2"/><path d="m9 20 3-6 3 2v5M7 12l2-4 4 1 2 4 3 1"/></svg>${resumeState && resumeState.rank === rank ? "Continue walking the line" : "Walk this line"}</button>`;
    card.addEventListener("click", (e) => {
      setActiveRoute(rank);
      if (e.target.closest(".walk-btn")) startWalk();
    });
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActiveRoute(rank); } });
    host.appendChild(card);
  });
  setActiveRoute(activeRoute);
}

/* ---------------------------------------------------------------- the walk */

// where you were when you pressed Esc, so the walk can pick up again
let resumeState = null;

function startWalk() {
  if (walker || !routes.length) return;
  const route = routes[activeRoute].coords;
  const A = route[0], B = route[route.length - 1];
  const resume = resumeState && resumeState.rank === activeRoute ? resumeState : null;
  const from = resume ? [resume.lng, resume.lat] : A;
  attract = false;
  setStatus(resume ? "Back on the line where you left off" : "Someone near A is about to have a very different evening…");
  document.body.classList.add("walking");
  setTimeout(() => map.resize(), 360);
  // swoop down, let the street load, then step in
  map.flyTo({ center: from, zoom: 17.4, pitch: 60, bearing: map.getBearing(), duration: 1600, essential: true });
  map.once("moveend", () => map.once("idle", () => {
    world.rebuild(false, from);
    walker = new Walker(world, map, {
      route, end: B, resume,
      onDeath: () => {
        setStatus("Hit by a car", true);
        setTimeout(() => { if (walker && walker.dead) $("death").hidden = false; }, 900);
      },
      onReady: () => {
        $("walk-hud").hidden = false;
        setStatus("You're in control. Follow the line to B");
      },
      onUpdate: updateHud,
      onArrive: () => {
        setStatus("You made it to B along the best-lit line", true);
        $("hud-line").textContent = "Arrived";
        resumeState = null;
      },
    });
    walker.start();
    fillStats();
  }));
}

/** While walking, draw only what is left of the line: from your feet to B. */
let lastProgress = null;
function updateRouteProgress(pos) {
  const r = routes[activeRoute];
  if (!r) return;
  const c = r.coords, k = Math.cos((pos[1] * Math.PI) / 180);
  let best = Infinity, bi = 1, bt = 0;
  for (let i = 1; i < c.length; i++) {
    const ax = c[i - 1][0] * k, ay = c[i - 1][1], bx = c[i][0] * k, by = c[i][1];
    const px = pos[0] * k, py = pos[1], dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t)) * 111320;
    if (d < best) { best = d; bi = i; bt = t; }
  }
  if (best > 40) return;                         // wandered off: leave the line as it was
  const p = [c[bi - 1][0] + (c[bi][0] - c[bi - 1][0]) * bt, c[bi - 1][1] + (c[bi][1] - c[bi - 1][1]) * bt];
  if (lastProgress && Math.abs(lastProgress[0] - p[0]) < 1e-5 && Math.abs(lastProgress[1] - p[1]) < 1e-5) return;
  lastProgress = p;
  const remaining = [p, ...c.slice(bi)];
  map.getSource("routes").setData({ type: "FeatureCollection", features: remaining.length > 1 ? [
    { type: "Feature", properties: { rank: activeRoute, active: true }, geometry: { type: "LineString", coordinates: remaining } },
  ] : [] });
}

function updateHud({ toEnd, off, pos, arrow, running, lit, inTraffic }) {
  if (pos) updateRouteProgress(pos);
  $("hud-danger").hidden = !inTraffic || !!(walker && walker.dead);
  $("hud-dist").textContent = toEnd < 1000 ? `${Math.round(toEnd)} m to B` : `${(toEnd / 1000).toFixed(1)} km to B`;
  const onLine = off < 22;
  const line = $("hud-line");
  if (!walker || !walker.arrived) {
    line.textContent = onLine ? (mode === "night" ? (lit > 0.25 ? "On the line · under the lamps" : "On the line · dark stretch") : "On the line")
      : `Off the line · ${Math.round(off)} m away`;
  }
  line.classList.toggle("off", !onLine);
  $("hud-arrow").style.transform = `rotate(${arrow}deg)`;
  $("hud-pace").textContent = running ? "Running" : "Walking";
}

function exitWalk(silent) {
  if (!walker) return;
  // remember where you were, unless you arrived (or were hit: then you start the line afresh)
  const a = world.avatar;
  if (a && !walker.arrived && !walker.dead && world.frame) {
    const [lng, lat] = world.frame.toLngLat(a.x, a.y);
    resumeState = { rank: activeRoute, lng, lat, h: a.h,
      look: { skin: a.skin, shirt: a.shirt, pants: a.pants, hair: a.hair, coat: a.coat, scale: a.scale } };
  } else if (walker.arrived || walker.dead) resumeState = null;
  $("death").hidden = true;
  $("hud-danger").hidden = true;
  walker.stop();
  walker = null;
  lastProgress = null;
  if (routes.length) drawRoutes();                 // the full line (and alternatives) come back
  $("walk-hud").hidden = true;
  document.body.classList.remove("walking");
  setTimeout(() => map.resize(), 360);
  if (silent) return;
  const r = routes[activeRoute];
  if (r) {
    const bounds = new maplibregl.LngLatBounds();
    for (const c of r.coords) bounds.extend(c);
    setTimeout(() => map.fitBounds(bounds, { padding: 90, pitch: 50, bearing: map.getBearing(), duration: 1500, maxZoom: 17 }), 380);
  }
  renderRouteCards();
  setStatus(resumeState ? "Back above the city. Continue the line when you're ready" : "Back above the city. Drag a pin or walk it again");
}
$("death-retry").addEventListener("click", () => {
  if (!walker) return;
  walker.revive();
  $("death").hidden = true;
  setStatus("Back on your feet. Look both ways");
});
$("death-leave").addEventListener("click", () => exitWalk());
$("hud-exit").addEventListener("click", () => exitWalk());
addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !walker) return;
  if (document.pointerLockElement) { document.exitPointerLock(); return; }   // first Esc: free the mouse
  exitWalk();
});

/* ---------------------------------------------------------------- panel + locate */

const panel = $("panel");
const grab = $("grab");
const openPanel = () => { panel.classList.add("open"); panel.classList.remove("collapsed"); };
const closePanel = () => { panel.classList.remove("open"); panel.classList.add("collapsed"); };
grab.addEventListener("click", () => (panel.classList.contains("open") ? closePanel() : openPanel()));
let dragY = null;
grab.addEventListener("touchstart", (e) => { dragY = e.touches[0].clientY; }, { passive: true });
grab.addEventListener("touchend", (e) => {
  if (dragY == null) return;
  const d = e.changedTouches[0].clientY - dragY;
  if (d < -30) openPanel(); else if (d > 30) closePanel();
  dragY = null;
});

$("btn-locate").addEventListener("click", () => {
  const btn = $("btn-locate");
  if (!navigator.geolocation) { setStatus("Location isn't available in this browser", true); return; }
  btn.classList.add("active");
  setStatus("Finding you…");
  navigator.geolocation.getCurrentPosition((pos) => {
    btn.classList.remove("active");
    const ll = [pos.coords.longitude, pos.coords.latitude];
    if (!pointInRings(rings, ll[0], ll[1])) { setStatus("You're outside Chicago. This map covers the city only", true); return; }
    attract = false;
    map.flyTo({ center: ll, zoom: 17, pitch: 60, duration: 1600 });
    setStatus(`${VERB} a destination to find the best-lit line from here`);
  }, (err) => {
    btn.classList.remove("active");
    setStatus(err.code === 1 ? "Location permission was denied" : "Couldn't find your location", true);
  }, { enableHighAccuracy: true, timeout: 10000 });
});

renderClockNote();

// expose for debugging in the console
window.bestLit = { map, world, get walker() { return walker; }, metersBetween };
