/* Geometry, sun and scoring helpers shared by the map, the 3D world and routing. */

export const M_PER_DEG_LAT = 111320;
export const CHICAGO_LAT = 41.88;
export const COS_LAT = Math.cos((CHICAGO_LAT * Math.PI) / 180);
export const CELL_DEG = 0.0005;            // lamp / tree grid: cells centred on multiples of this

/* ---------------------------------------------------------------- mercator / local frame */

export function mercX(lng) { return (180 + lng) / 360; }
export function mercY(lat) {
  return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
}
function lngFromMercX(x) { return x * 360 - 180; }
function latFromMercY(y) {
  const y2 = 180 - y * 360;
  return (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90;
}

/** Metric east/north frame anchored at a lng/lat, exactly consistent with web mercator. */
export class LocalFrame {
  constructor(lng, lat) {
    this.lng = lng;
    this.lat = lat;
    this.mx = mercX(lng);
    this.my = mercY(lat);
    // mercator units per metre at the anchor latitude
    this.s = 1 / (40075016.68557849 * Math.cos((lat * Math.PI) / 180));
  }
  toLocal(lng, lat) {
    return [(mercX(lng) - this.mx) / this.s, -(mercY(lat) - this.my) / this.s];
  }
  toLngLat(x, y) {
    return [lngFromMercX(this.mx + x * this.s), latFromMercY(this.my - y * this.s)];
  }
}

export function metersBetween(a, b) {
  const dx = (b[0] - a[0]) * COS_LAT * M_PER_DEG_LAT;
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/* ---------------------------------------------------------------- sun (after SunCalc, V. Agafonkin, BSD) */

const RAD = Math.PI / 180;
const J1970 = 2440588, J2000 = 2451545, DAY_MS = 864e5, OBLIQ = RAD * 23.4397;

export function sunPosition(date, lat, lng) {
  const d = date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(OBLIQ) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(OBLIQ), Math.cos(L));
  const H = RAD * (280.16 + 360.9856235 * d) - RAD * -lng - ra;
  const phi = RAD * lat;
  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  // SunCalc azimuth is from south, clockwise; convert to a compass bearing.
  return { altitude, bearing: ((az / RAD + 180) % 360 + 360) % 360 };
}

const CHI = [-87.6298, 41.8781];
const DAY_ALTITUDE = -4 * RAD;      // between civil twilight and sunset: streetlights are on below this

export function isDaylight(date = new Date()) {
  return sunPosition(date, CHI[1], CHI[0]).altitude > DAY_ALTITUDE;
}

/** Next time the day/night state flips, scanning forward in 5-minute steps. */
export function nextTransition(date = new Date()) {
  const now = isDaylight(date);
  for (let m = 5; m <= 26 * 60; m += 5) {
    const t = new Date(date.valueOf() + m * 60000);
    if (isDaylight(t) !== now) return { at: t, toDay: !now };
  }
  return null;
}

export function chicagoClock(date = new Date()) {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
}

/* ---------------------------------------------------------------- city boundary */

export function boundaryRings(geojson) {
  const rings = [];
  for (const f of (geojson && geojson.features) || []) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === "MultiPolygon" ? g.coordinates : g.type === "Polygon" ? [g.coordinates] : [];
    for (const poly of polys) for (const ring of poly) rings.push(ring);
  }
  return rings;
}

export function pointInRings(rings, lng, lat) {
  if (!rings.length) return true;
  let inside = false;
  for (const ring of rings) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi) c = !c;
    }
    if (c) inside = !inside;
  }
  return inside;
}

export function pointInPoly(pts, x, y) {
  // pts: flat [x0,y0,x1,y1,...]
  let c = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i], yi = pts[2 * i + 1], xj = pts[2 * j], yj = pts[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) c = !c;
  }
  return c;
}

/* ---------------------------------------------------------------- grid index (lamp / tree cells) */

/** Buckets [lat, lon, value] cells into 0.01° tiles for fast bbox queries. */
export class CellIndex {
  constructor(cells) {
    this.B = 0.01;
    this.map = new Map();
    for (const c of cells || []) {
      const k = Math.floor(c[0] / this.B) + "|" + Math.floor(c[1] / this.B);
      let a = this.map.get(k);
      if (!a) this.map.set(k, (a = []));
      a.push(c);
    }
  }
  query(minLat, maxLat, minLon, maxLon) {
    const out = [];
    const B = this.B;
    for (let i = Math.floor(minLat / B); i <= Math.floor(maxLat / B); i++) {
      for (let j = Math.floor(minLon / B); j <= Math.floor(maxLon / B); j++) {
        const list = this.map.get(i + "|" + j);
        if (!list) continue;
        for (const c of list) if (c[0] >= minLat && c[0] <= maxLat && c[1] >= minLon && c[1] <= maxLon) out.push(c);
      }
    }
    return out;
  }
}

export function cellKey(lat, lng) {
  return Math.round(lat / CELL_DEG) + "|" + Math.round(lng / CELL_DEG);
}

/* ---------------------------------------------------------------- route scoring */

function pointToSegmentM(plat, plon, a, b) {
  const k = COS_LAT * M_PER_DEG_LAT;
  const bx = (b[0] - a[0]) * k, by = (b[1] - a[1]) * M_PER_DEG_LAT;
  const px = (plon - a[0]) * k, py = (plat - a[1]) * M_PER_DEG_LAT;
  const len2 = bx * bx + by * by;
  let t = len2 > 0 ? (px * bx + py * by) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - t * bx, py - t * by);
}

export function distanceToLine(lng, lat, coords) {
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const d = pointToSegmentM(lat, lng, coords[i - 1], coords[i]);
    if (d < best) best = d;
  }
  return best;
}

export function lineLength(coords) {
  let t = 0;
  for (let i = 1; i < coords.length; i++) t += metersBetween(coords[i - 1], coords[i]);
  return t;
}

/** coords: [[lng, lat], ...]. Sums grid values within radius of the path, per km. */
export function scoreRoute(coords, lampIndex, treeIndex, lampR = 80, shadeR = 40) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [lon, lat] of coords) {
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
  }
  const sum = (index, r) => {
    const pad = (r + 30) / 111000;
    let s = 0;
    for (const c of index.query(minLat - pad, maxLat + pad, minLon - pad, maxLon + pad)) {
      if (distanceToLine(c[1], c[0], coords) <= r) s += c[2];
    }
    return s;
  };
  const lamps = sum(lampIndex, lampR);
  const shade = sum(treeIndex, shadeR);
  const km = Math.max(lineLength(coords) / 1000, 0.05);
  return { lamps, perKm: lamps / km, shade, shadePerKm: shade / km };
}
