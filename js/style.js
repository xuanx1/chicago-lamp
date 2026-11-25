/* MapLibre style: OpenFreeMap (OpenMapTiles schema) drawn in a painterly
 * night / day palette. Colours are swapped in place on mode change so the
 * 3D layer and loaded tiles survive. */

export const PALETTES = {
  night: {
    ground: "#18202b", groundNear: "#30363f", park: "#1a2827", wood: "#172524", water: "#0b1520",
    sidewalk: "#222b37", road: "#2a3341", roadMajor: "#313b4b", rail: "#2c3440",
    // street level (zoom 16+): asphalt, concrete, kerb, paint
    asphalt: "#1a1e25", pavement: "#3f4652", kerb: "#79818f", laneWhite: "#b9bec6", laneYellow: "#b89235",
    bldgLow: "#28313f", bldgHigh: "#3d4960", bldgMid: "#333d4f", bldgOutline: "#10151d",
    label: "#a9b2c1", labelHalo: "#121922", place: "#d9dde6", station: "#f2b04a",
    boundary: "#f2efe8", mask: "#070a0f", maskOpacity: 0.62,
    route: "#9fd4ff", routeGlow: "#4fa3ff", routeAlt: "#7d8796",
    srOpen: "#ff6a55", srResolved: "#6f7682",
    sky: { "sky-color": "#0a1120", "horizon-color": "#2c2c48", "fog-color": "#151c29",
           "sky-horizon-blend": 0.55, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.35, "atmosphere-blend": 0 },
    light: { color: "#9fb2d6", intensity: 0.32 },
  },
  day: {
    ground: "#ebe1ca", groundNear: "#e2d8c3", park: "#cdd6a2", wood: "#bccb92", water: "#9cc4c6",
    sidewalk: "#f5eddc", road: "#fbf6eb", roadMajor: "#fffaf1", rail: "#d6ccb6",
    asphalt: "#7a7772", pavement: "#c4bba9", kerb: "#8d8576", laneWhite: "#f6f3ec", laneYellow: "#e3b543",
    bldgLow: "#eadbb9", bldgHigh: "#d3b98c", bldgMid: "#dfcaa2", bldgOutline: "#b89f78",
    label: "#5b4b39", labelHalo: "#f3ead8", place: "#3c3125", station: "#8c2f22",
    boundary: "#3c3125", mask: "#f1e8d5", maskOpacity: 0.55,
    route: "#1f5ac8", routeGlow: "#6ea0ff", routeAlt: "#8b8170",
    srOpen: "#c24a36", srResolved: "#9a8f7c",
    sky: { "sky-color": "#8fc6d2", "horizon-color": "#f4e2bd", "fog-color": "#efe1c3",
           "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.7, "fog-ground-blend": 0.3, "atmosphere-blend": 0 },
    light: { color: "#fff0d2", intensity: 0.45 },
  },
};

// Real-world widths in metres, converted to pixels at Chicago's latitude so
// roads line up with the 3D street furniture placed beside them.
const M_PER_PX_Z12 = 14.22, M_PER_PX_Z20 = 0.0556, M_PER_PX_Z24 = 0.0556 / 16;
const metres = (m, min = 0.4) => ["interpolate", ["exponential", 2], ["zoom"],
  12, Math.max(min, m / M_PER_PX_Z12), 24, m / M_PER_PX_Z24];

export const ROAD_WIDTH_M = {
  motorway: 13, trunk: 12, primary: 17, secondary: 15, tertiary: 13,
  minor: 10, service: 5.5, track: 3, path: 2.2,
};
// one carriageway of a divided avenue (or a one-way arterial) is narrower than a two-way street
const ONEWAY_NARROW = new Set(["trunk", "primary", "secondary", "tertiary"]);
export const roadWidthM = (cls, oneway) => (ROAD_WIDTH_M[cls] || 10) * (oneway && ONEWAY_NARROW.has(cls) ? 0.8 : 1);
const CLASS_W = ["*",
  ["match", ["get", "class"], "motorway", 13, "trunk", 12, "primary", 17, "secondary", 15, "tertiary", 13, "minor", 10, "service", 5.5, 3],
  ["case", ["all", ["!=", ["coalesce", ["get", "oneway"], 0], 0],
    ["match", ["get", "class"], ["trunk", "primary", "secondary", "tertiary"], true, false]], 0.8, 1]];
// true metres from z14 up (exponential base 2 between real-metre stops is exact), so the
// streets, pavements and kerbs are the same shape at every zoom you look at them from
const M_PER_PX_Z14 = M_PER_PX_Z12 / 4;
const widthExpr = (extra) => ["interpolate", ["exponential", 2], ["zoom"],
  12, ["*", CLASS_W, 1 / M_PER_PX_Z12],
  14, ["*", ["+", CLASS_W, extra], 1 / M_PER_PX_Z14],
  24, ["*", ["+", CLASS_W, extra], 1 / M_PER_PX_Z24]];

const HW_BRIDGE = ["all", ["==", ["get", "brunnel"], "bridge"], ["match", ["get", "class"], ["motorway", "trunk"], true, false]];
const ROAD_FILTER = ["all",
  ["==", ["geometry-type"], "LineString"],
  ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service"], true, false],
  ["!=", ["get", "brunnel"], "tunnel"]];
const PATH_FILTER = ["all", ["==", ["geometry-type"], "LineString"],
  ["match", ["get", "class"], ["path", "track"], true, false]];

// elevated rapid transit (the L): drawn as 3D steelwork from street level, as a line only when zoomed out
const ELEVATED_L = ["all", ["==", ["get", "brunnel"], "bridge"],
  ["any", ["==", ["get", "class"], "transit"], ["match", ["get", "subclass"], ["subway", "light_rail"], true, false]]];

const FONT = ["Noto Sans Regular"];
const FONT_BOLD = ["Noto Sans Bold"];

const streetBlend = (far, near) => ["interpolate", ["linear"], ["zoom"], 13.5, far, 14.5, near];   // settled before 3D zooms

// Mode changes must only touch feature-constant paint values: MapLibre reloads and
// re-parses every tile when a data-driven paint value changes, or when a hidden
// layer is shown again. So both glows stay "visible" and fade by opacity, and
// buildings take one colour per mode.
const heatOpacity = (on, top) => ["interpolate", ["linear"], ["zoom"], 14.6, on ? top : 0, 16, 0];
const bldgColor = (P) => P.bldgMid;

// map pan bounds (keep in sync with tools/fetch_tiles.py PAN)
const TILE_BOUNDS = [-88.15, 41.55, -87.3, 42.15];

/** base: absolute URL of the folder holding tiles/ (MapLibre needs absolute tile URLs). */
export function buildStyle(mode, base) {
  const P = PALETTES[mode];
  const empty = { type: "geojson", data: { type: "FeatureCollection", features: [] } };
  return {
    version: 8,
    glyphs: base + "tiles/glyphs/{fontstack}/{range}.pbf",
    sources: {
      // OpenFreeMap tiles for Chicago, vendored by tools/fetch_tiles.py
      ofm: { type: "vector", tiles: [base + "tiles/{z}/{x}/{y}.pbf"], minzoom: 0, maxzoom: 14, bounds: TILE_BOUNDS },
      lampHeat: { ...empty },
      treeHeat: { ...empty },
      reports: { ...empty },
      boundary: { ...empty },
      mask: { ...empty },
      routes: { ...empty },
    },
    sky: P.sky,
    light: { anchor: "map", position: [1.2, 210, 40], ...P.light },
    layers: [
      // at street zoom the open ground is concrete: plazas and pavement up to the building line
      { id: "ground", type: "background", paint: { "background-color": streetBlend(P.ground, P.groundNear) } },
      { id: "wood", type: "fill", source: "ofm", "source-layer": "landcover",
        filter: ["match", ["get", "class"], ["wood", "grass"], true, false],
        paint: { "fill-color": P.wood, "fill-opacity": 0.8 } },
      { id: "park", type: "fill", source: "ofm", "source-layer": "park", paint: { "fill-color": P.park } },
      { id: "water", type: "fill", source: "ofm", "source-layer": "water", paint: { "fill-color": P.water } },
      // at-grade rail only: subways are underground, and the elevated L is drawn in 3D
      { id: "rail", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 13,
        filter: ["all", ["match", ["get", "class"], ["rail", "transit"], true, false],
                 ["!=", ["get", "brunnel"], "tunnel"], [">=", ["coalesce", ["get", "layer"], 0], 0], ["!", ELEVATED_L]],
        paint: { "line-color": P.rail, "line-width": metres(2.5, 0.6), "line-dasharray": [3, 2],
                 "line-opacity": ["interpolate", ["linear"], ["zoom"], 15, 1, 15.6, ["case", ["==", ["get", "brunnel"], "bridge"], 0, 1]] } },
      { id: "rail-l-overview", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 11, maxzoom: 14.3,
        filter: ELEVATED_L,
        paint: { "line-color": P.rail, "line-width": metres(4, 0.8), "line-opacity": 0.9 } },
      { id: "sidewalk", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 14,
        filter: ["all", ROAD_FILTER, ["match", ["get", "class"], ["service", "motorway", "trunk"], false, true]],
        layout: { "line-cap": "butt", "line-join": "round" },
        paint: { "line-color": streetBlend(P.sidewalk, P.pavement), "line-width": widthExpr(10) } },
      // kerb: a thin edge between pavement and carriageway
      { id: "kerb", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 15,
        filter: ["all", ROAD_FILTER, ["match", ["get", "class"], ["service", "motorway", "trunk"], false, true]],
        layout: { "line-cap": "butt", "line-join": "round" },
        paint: { "line-color": P.kerb, "line-width": widthExpr(0.9),
                 "line-opacity": ["interpolate", ["linear"], ["zoom"], 16, 0, 17, 1] } },
      { id: "path", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 15,
        filter: PATH_FILTER, layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": streetBlend(P.sidewalk, P.pavement), "line-width": metres(2.2, 0.6) } },
      { id: "road", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 10,
        filter: ["all", ROAD_FILTER, ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary"], false, true]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": streetBlend(P.road, P.asphalt), "line-width": widthExpr(0) } },
      { id: "road-major", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 8,
        filter: ["all", ROAD_FILTER, ["!", HW_BRIDGE], ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary"], true, false]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": streetBlend(P.roadMajor, P.asphalt), "line-width": widthExpr(0) } },
      { id: "road-hw-bridge", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 8, maxzoom: 15,
        filter: ["all", ROAD_FILTER, HW_BRIDGE],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.roadMajor, "line-width": widthExpr(0) } },

      // At street zoom the 3D decks carry the bridges; water drawn over the flat roads hides the ghost road on the river.
      { id: "water-over", type: "fill", source: "ofm", "source-layer": "water", minzoom: 14.8,
        filter: ["match", ["get", "class"], ["river", "lake", "ocean"], true, false],
        paint: { "fill-color": P.water } },
      // City-scale light: a heatmap of every known lamp. Fades out as the
      // street-level 3D lamps take over.
      { id: "lamp-heat", type: "heatmap", source: "lampHeat", maxzoom: 16.5,
        paint: {
          "heatmap-weight": ["min", 1, ["/", ["get", "n"], 6]],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 10, 0.55, 15, 1.4],
          "heatmap-radius": ["interpolate", ["exponential", 2], ["zoom"], 10, 2.2, 13, 7, 15, 22, 16.5, 46],
          "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(255,170,60,0)", 0.15, "rgba(255,160,55,0.28)", 0.4, "rgba(255,186,90,0.62)",
            0.7, "rgba(255,215,140,0.85)", 1, "rgba(255,240,205,0.95)"],
          "heatmap-opacity": heatOpacity(mode === "night", 0.95),
        } },
      { id: "tree-heat", type: "heatmap", source: "treeHeat", maxzoom: 16.5,
        paint: {
          "heatmap-weight": ["min", 1, ["/", ["get", "n"], 10]],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 15, 1.2],
          "heatmap-radius": ["interpolate", ["exponential", 2], ["zoom"], 10, 2, 13, 6, 15, 20, 16.5, 40],
          "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(54,96,62,0)", 0.3, "rgba(70,112,70,0.25)", 0.7, "rgba(52,95,60,0.45)", 1, "rgba(38,78,50,0.6)"],
          "heatmap-opacity": heatOpacity(mode === "day", 1),
        } },

      { id: "route-alt", type: "line", source: "routes", filter: ["!=", ["get", "active"], true],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.routeAlt, "line-width": ["interpolate", ["exponential", 2], ["zoom"], 12, 2.5, 17, 5, 24, 1.1 / M_PER_PX_Z24],
                 "line-dasharray": [0.6, 1.8], "line-opacity": 0.95 } },
      { id: "route-glow", type: "line", source: "routes", filter: ["==", ["get", "active"], true],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.routeGlow, "line-width": ["interpolate", ["exponential", 2], ["zoom"], 12, 10, 17, 26, 20, 80],
                 "line-blur": ["interpolate", ["exponential", 2], ["zoom"], 12, 6, 17, 14, 20, 36], "line-opacity": 0.45 } },
      { id: "route-core", type: "line", source: "routes", filter: ["==", ["get", "active"], true],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.route, "line-width": ["interpolate", ["exponential", 2], ["zoom"], 12, 3.5, 17, 7, 24, 1.6 / M_PER_PX_Z24] } },

      { id: "reports-resolved", type: "circle", source: "reports", maxzoom: 15.5,
        filter: ["!=", ["get", "open"], true],
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 1, 15, 3],
                 "circle-color": P.srResolved, "circle-opacity": 0.55 } },
      ...[0, 1, 2].map((k) => ({
        id: "reports-open-" + k, type: "circle", source: "reports", maxzoom: 15.5,
        filter: ["all", ["==", ["get", "open"], true], ["==", ["get", "g"], k]],
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 1.6, 15, 5],
                 "circle-color": P.srOpen, "circle-blur": 0.35, "circle-opacity": 0.9,
                 "circle-opacity-transition": { duration: 0 } },
      })),

      { id: "outside-mask", type: "fill", source: "mask",
        paint: { "fill-color": P.mask, "fill-opacity": P.maskOpacity } },
      { id: "boundary", type: "line", source: "boundary",
        paint: { "line-color": P.boundary, "line-opacity": 0.35, "line-width": 1.2, "line-dasharray": [1, 3] } },

      // labels sit beneath the buildings so nearer buildings hide them
      // names only for the zoomed-out overview: in the 3D city they are clutter
      { id: "road-label", type: "symbol", source: "ofm", "source-layer": "transportation_name", minzoom: 13.5, maxzoom: 15,
        filter: ["match", ["get", "class"], ["primary", "secondary", "tertiary", "minor", "trunk"], true, false],
        layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
                  "text-font": FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 15, 10.5, 19, 14],
                  "text-letter-spacing": 0.04, "text-max-angle": 30, "symbol-spacing": 400 },
        paint: { "text-color": P.label, "text-halo-color": P.labelHalo, "text-halo-width": 1.6 } },
      { id: "place-label", type: "symbol", source: "ofm", "source-layer": "place", maxzoom: 15,
        filter: ["match", ["get", "class"], ["city", "town", "suburb", "neighbourhood", "quarter"], true, false],
        layout: { "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-font": FONT_BOLD,
                  "text-size": ["match", ["get", "class"], "city", 15, "town", 13, 11.5],
                  "text-transform": "uppercase", "text-letter-spacing": 0.14, "text-max-width": 8 },
        paint: { "text-color": P.place, "text-halo-color": P.labelHalo, "text-halo-width": 1.4, "text-opacity": 0.85 } },
      { id: "building-3d", type: "fill-extrusion", source: "ofm", "source-layer": "building", minzoom: 13,
        // shown only where the three.js facades are not yet built (see main.js)
        paint: {
          "fill-extrusion-color": bldgColor(P),
          "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, ["coalesce", ["get", "render_height"], 8]],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-vertical-gradient": true,
          "fill-extrusion-opacity": 1,
        } },
    ],
  };
}

/** Recolours an existing style in place. */
export function applyPalette(map, mode) {
  const P = PALETTES[mode];
  const set = (id, prop, v) => { if (map.getLayer(id)) map.setPaintProperty(id, prop, v); };
  map.setPaintProperty("ground", "background-color", streetBlend(P.ground, P.groundNear));
  set("wood", "fill-color", P.wood);
  set("park", "fill-color", P.park);
  set("water", "fill-color", P.water);
  set("water-over", "fill-color", P.water);
  set("rail", "line-color", P.rail);
  set("rail-l-overview", "line-color", P.rail);
  set("sidewalk", "line-color", streetBlend(P.sidewalk, P.pavement));
  set("path", "line-color", streetBlend(P.sidewalk, P.pavement));
  set("road", "line-color", streetBlend(P.road, P.asphalt));
  set("road-major", "line-color", streetBlend(P.roadMajor, P.asphalt));
  set("road-hw-bridge", "line-color", P.roadMajor);
  set("kerb", "line-color", P.kerb);
  set("route-alt", "line-color", P.routeAlt);
  set("route-glow", "line-color", P.routeGlow);
  set("route-core", "line-color", P.route);
  set("reports-resolved", "circle-color", P.srResolved);
  for (const k of [0, 1, 2]) set("reports-open-" + k, "circle-color", P.srOpen);
  set("outside-mask", "fill-color", P.mask);
  set("outside-mask", "fill-opacity", P.maskOpacity);
  set("boundary", "line-color", P.boundary);
  set("building-3d", "fill-extrusion-color", bldgColor(P));
  for (const id of ["road-label"]) { set(id, "text-color", P.label); set(id, "text-halo-color", P.labelHalo); }
  set("place-label", "text-color", P.place);
  set("place-label", "text-halo-color", P.labelHalo);
  set("lamp-heat", "heatmap-opacity", heatOpacity(mode === "night", 0.95));
  set("tree-heat", "heatmap-opacity", heatOpacity(mode === "day", 1));
  map.setSky(P.sky);
}

export function setSunLight(map, mode, sun) {
  const P = PALETTES[mode];
  // position: [radial, azimuthal (deg, clockwise from north), polar (deg from zenith)]
  const az = mode === "day" && sun ? sun.bearing : 200;
  const polar = mode === "day" && sun ? Math.min(80, Math.max(20, 90 - (sun.altitude * 180) / Math.PI)) : 50;
  map.setLight({ anchor: "map", position: [1.2, az, polar], color: P.light.color, intensity: P.light.intensity });
}
