/* MapLibre style: OpenFreeMap (OpenMapTiles schema) drawn in a painterly
 * night / day palette. Colours are swapped in place on mode change so the
 * 3D layer and loaded tiles survive. */

export const PALETTES = {
  night: {
    ground: "#18202b", park: "#1a2827", wood: "#172524", water: "#0b1520",
    sidewalk: "#222b37", road: "#2a3341", roadMajor: "#313b4b", rail: "#2c3440",
    bldgLow: "#28313f", bldgHigh: "#3d4960", bldgOutline: "#10151d",
    label: "#a9b2c1", labelHalo: "#121922", place: "#d9dde6",
    boundary: "#f2efe8", mask: "#070a0f", maskOpacity: 0.62,
    route: "#9fd4ff", routeGlow: "#4fa3ff", routeAlt: "#7d8796",
    srOpen: "#ff6a55", srResolved: "#6f7682",
    sky: { "sky-color": "#0a1120", "horizon-color": "#2c2c48", "fog-color": "#151c29",
           "sky-horizon-blend": 0.55, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.35, "atmosphere-blend": 0 },
    light: { color: "#9fb2d6", intensity: 0.32 },
  },
  day: {
    ground: "#ebe1ca", park: "#cdd6a2", wood: "#bccb92", water: "#9cc4c6",
    sidewalk: "#f5eddc", road: "#fbf6eb", roadMajor: "#fffaf1", rail: "#d6ccb6",
    bldgLow: "#eadbb9", bldgHigh: "#d3b98c", bldgOutline: "#b89f78",
    label: "#5b4b39", labelHalo: "#f3ead8", place: "#3c3125",
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
const M_PER_PX_Z12 = 14.22, M_PER_PX_Z20 = 0.0556;
const metres = (m, min = 0.4) => ["interpolate", ["exponential", 2], ["zoom"],
  12, Math.max(min, m / M_PER_PX_Z12), 20, m / M_PER_PX_Z20];

export const ROAD_WIDTH_M = {
  motorway: 26, trunk: 22, primary: 17, secondary: 15, tertiary: 13,
  minor: 10, service: 5.5, track: 3, path: 2.2,
};
const widthExpr = (extra) => ["interpolate", ["exponential", 2], ["zoom"],
  12, ["*", ["match", ["get", "class"],
    "motorway", 26, "trunk", 22, "primary", 17, "secondary", 15, "tertiary", 13,
    "minor", 10, "service", 5.5, 3], 1 / M_PER_PX_Z12],
  20, ["*", ["+", ["match", ["get", "class"],
    "motorway", 26, "trunk", 22, "primary", 17, "secondary", 15, "tertiary", 13,
    "minor", 10, "service", 5.5, 3], extra], 1 / M_PER_PX_Z20]];

const ROAD_FILTER = ["all",
  ["==", ["geometry-type"], "LineString"],
  ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service"], true, false],
  ["!=", ["get", "brunnel"], "tunnel"]];
const PATH_FILTER = ["all", ["==", ["geometry-type"], "LineString"],
  ["match", ["get", "class"], ["path", "track"], true, false]];

const FONT = ["Noto Sans Regular"];
const FONT_BOLD = ["Noto Sans Bold"];

export function buildStyle(mode) {
  const P = PALETTES[mode];
  const empty = { type: "geojson", data: { type: "FeatureCollection", features: [] } };
  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      ofm: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
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
      { id: "ground", type: "background", paint: { "background-color": P.ground } },
      { id: "wood", type: "fill", source: "ofm", "source-layer": "landcover",
        filter: ["match", ["get", "class"], ["wood", "grass"], true, false],
        paint: { "fill-color": P.wood, "fill-opacity": 0.8 } },
      { id: "park", type: "fill", source: "ofm", "source-layer": "park", paint: { "fill-color": P.park } },
      { id: "water", type: "fill", source: "ofm", "source-layer": "water", paint: { "fill-color": P.water } },
      { id: "rail", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 13,
        filter: ["match", ["get", "class"], ["rail", "transit"], true, false],
        paint: { "line-color": P.rail, "line-width": metres(2.5, 0.6), "line-dasharray": [3, 2] } },
      { id: "sidewalk", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 14,
        filter: ["all", ROAD_FILTER, ["!=", ["get", "class"], "service"]],
        layout: { "line-cap": "butt", "line-join": "round" },
        paint: { "line-color": P.sidewalk, "line-width": widthExpr(7) } },
      { id: "path", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 15,
        filter: PATH_FILTER, layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.sidewalk, "line-width": metres(2.2, 0.6) } },
      { id: "road", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 10,
        filter: ["all", ROAD_FILTER, ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary"], false, true]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.road, "line-width": widthExpr(0) } },
      { id: "road-major", type: "line", source: "ofm", "source-layer": "transportation", minzoom: 8,
        filter: ["all", ROAD_FILTER, ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary"], true, false]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.roadMajor, "line-width": widthExpr(0) } },

      // City-scale light: a heatmap of every known lamp. Fades out as the
      // street-level 3D lamps take over.
      { id: "lamp-heat", type: "heatmap", source: "lampHeat", maxzoom: 16.5,
        layout: { visibility: mode === "night" ? "visible" : "none" },
        paint: {
          "heatmap-weight": ["min", 1, ["/", ["get", "n"], 6]],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 10, 0.55, 15, 1.4],
          "heatmap-radius": ["interpolate", ["exponential", 2], ["zoom"], 10, 2.2, 13, 7, 15, 22, 16.5, 46],
          "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(255,170,60,0)", 0.15, "rgba(255,160,55,0.28)", 0.4, "rgba(255,186,90,0.62)",
            0.7, "rgba(255,215,140,0.85)", 1, "rgba(255,240,205,0.95)"],
          "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 14.6, 0.95, 16, 0],
        } },
      { id: "tree-heat", type: "heatmap", source: "treeHeat", maxzoom: 16.5,
        layout: { visibility: mode === "day" ? "visible" : "none" },
        paint: {
          "heatmap-weight": ["min", 1, ["/", ["get", "n"], 10]],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 15, 1.2],
          "heatmap-radius": ["interpolate", ["exponential", 2], ["zoom"], 10, 2, 13, 6, 15, 20, 16.5, 40],
          "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(54,96,62,0)", 0.3, "rgba(70,112,70,0.25)", 0.7, "rgba(52,95,60,0.45)", 1, "rgba(38,78,50,0.6)"],
          "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 14.6, 1, 16, 0],
        } },

      { id: "route-alt", type: "line", source: "routes", filter: ["!=", ["get", "active"], true],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.routeAlt, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 18, 6],
                 "line-dasharray": [0.6, 1.8], "line-opacity": 0.95 } },
      { id: "route-glow", type: "line", source: "routes", filter: ["==", ["get", "active"], true],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.routeGlow, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 10, 18, 34, 20, 90],
                 "line-blur": ["interpolate", ["linear"], ["zoom"], 12, 6, 18, 20, 20, 50], "line-opacity": 0.45 } },
      { id: "route-core", type: "line", source: "routes", filter: ["==", ["get", "active"], true],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": P.route, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3.5, 18, 8, 20, 22] } },

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

      { id: "building-3d", type: "fill-extrusion", source: "ofm", "source-layer": "building", minzoom: 13,
        paint: {
          "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 8],
            0, P.bldgLow, 60, P.bldgHigh, 200, P.bldgHigh],
          "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, ["coalesce", ["get", "render_height"], 8]],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-vertical-gradient": true,
          "fill-extrusion-opacity": 1,
        } },
      // the three.js world is inserted here (after buildings so it shares their depth)
      { id: "road-label", type: "symbol", source: "ofm", "source-layer": "transportation_name", minzoom: 15,
        filter: ["match", ["get", "class"], ["primary", "secondary", "tertiary", "minor", "trunk"], true, false],
        layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
                  "text-font": FONT, "text-size": ["interpolate", ["linear"], ["zoom"], 15, 10.5, 19, 14],
                  "text-letter-spacing": 0.04, "text-max-angle": 30, "symbol-spacing": 400 },
        paint: { "text-color": P.label, "text-halo-color": P.labelHalo, "text-halo-width": 1.6 } },
      { id: "place-label", type: "symbol", source: "ofm", "source-layer": "place", maxzoom: 15.5,
        filter: ["match", ["get", "class"], ["city", "town", "suburb", "neighbourhood", "quarter"], true, false],
        layout: { "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-font": FONT_BOLD,
                  "text-size": ["match", ["get", "class"], "city", 15, "town", 13, 11.5],
                  "text-transform": "uppercase", "text-letter-spacing": 0.14, "text-max-width": 8 },
        paint: { "text-color": P.place, "text-halo-color": P.labelHalo, "text-halo-width": 1.4, "text-opacity": 0.85 } },
    ],
  };
}

/** Recolours an existing style in place. */
export function applyPalette(map, mode) {
  const P = PALETTES[mode];
  const set = (id, prop, v) => { if (map.getLayer(id)) map.setPaintProperty(id, prop, v); };
  map.setPaintProperty("ground", "background-color", P.ground);
  set("wood", "fill-color", P.wood);
  set("park", "fill-color", P.park);
  set("water", "fill-color", P.water);
  set("rail", "line-color", P.rail);
  set("sidewalk", "line-color", P.sidewalk);
  set("path", "line-color", P.sidewalk);
  set("road", "line-color", P.road);
  set("road-major", "line-color", P.roadMajor);
  set("route-alt", "line-color", P.routeAlt);
  set("route-glow", "line-color", P.routeGlow);
  set("route-core", "line-color", P.route);
  set("reports-resolved", "circle-color", P.srResolved);
  for (const k of [0, 1, 2]) set("reports-open-" + k, "circle-color", P.srOpen);
  set("outside-mask", "fill-color", P.mask);
  set("outside-mask", "fill-opacity", P.maskOpacity);
  set("boundary", "line-color", P.boundary);
  set("building-3d", "fill-extrusion-color", ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 8],
    0, P.bldgLow, 60, P.bldgHigh, 200, P.bldgHigh]);
  for (const id of ["road-label"]) { set(id, "text-color", P.label); set(id, "text-halo-color", P.labelHalo); }
  set("place-label", "text-color", P.place);
  set("place-label", "text-halo-color", P.labelHalo);
  map.setLayoutProperty("lamp-heat", "visibility", mode === "night" ? "visible" : "none");
  map.setLayoutProperty("tree-heat", "visibility", mode === "day" ? "visible" : "none");
  map.setSky(P.sky);
}

export function setSunLight(map, mode, sun) {
  const P = PALETTES[mode];
  // position: [radial, azimuthal (deg, clockwise from north), polar (deg from zenith)]
  const az = mode === "day" && sun ? sun.bearing : 200;
  const polar = mode === "day" && sun ? Math.min(80, Math.max(20, 90 - (sun.altitude * 180) / Math.PI)) : 50;
  map.setLight({ anchor: "map", position: [1.2, az, polar], color: P.light.color, intensity: P.light.intensity });
}
