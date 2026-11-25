/* Street-level 3D world drawn with three.js inside MapLibre's GL context.
 *
 * Positions live in a local metric frame (x east, y north, z up) anchored near
 * the camera. When the camera wanders off, the whole neighbourhood is rebuilt
 * by a time-sliced job (a few ms per frame) into fresh buffers and swapped in
 * atomically, so panning never stutters.
 *
 *   buildings - real footprints and heights, with a procedural facade shader:
 *               floors, windows (lit at night), shopfronts, cornices, ink edges
 *   lamps     - one post per known lamp, spaced along the streets of its 55 m
 *               data cell; each casts an additive pool of light at night
 *   outages   - open 311 "light out" reports, as posts whose lamps flicker
 *   trees     - from the tree-trim grid; cast sun-directed shadows by day
 *   people / cars - a crowd that follows the camera, lit by the lamps they pass
 */

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { LocalFrame, cellKey, CELL_DEG, pointInPoly } from "./geo.js?v=20261125z";
import { ROAD_WIDTH_M, roadWidthM, PALETTES } from "./style.js?v=20261125z";

const AREA_R = 950;              // street furniture radius around the anchor, metres
const MARK_R = 1400;             // lane paint: as far as the 3D street surface goes
const BLDG_NEAR = 900;           // every building within this
const BLDG_FAR = 1800;           // only taller buildings out to this (the skyline)
const TILE_R = 1900;             // our own z14 tiles cover this far around the anchor
const PROP_R = 650;              // benches, bins and hydrants within this
const REBUILD_DIST = 420;        // rebuild when the view centre drifts this far
const LAMP_R = 19;               // illumination radius of a street lamp, metres
const LAMP_SPACING_MIN = 9;
const LIGHT_CELL = 4;            // metres per cell of the baked lamp-light grid
export const MIN_ZOOM = 14.2;
export const BLDG_ZOOM = 14.8;   // three.js buildings take over from MapLibre's here

const CLOUD_GATE = [-87.62333, 41.88266];
const LOOP_CORE = [-87.6278, 41.8819];        // State & Madison, the zero point of the street grid

const isTouch = matchMedia("(pointer: coarse)").matches;
const ARTERIAL_CLASSES = new Set(["trunk", "primary", "secondary", "tertiary"]);
// MapLibre's framebuffer is plain sRGB; keep three's colours unconverted so
// a hex in this file is exactly the hex on screen.
THREE.ColorManagement.enabled = false;

/* ------------------------------------------------------------------ shaders */

const TOON_COMMON = /* glsl */ `
uniform vec3 uLightDir;
uniform vec3 uLightCol;
uniform vec3 uAmbient;
uniform vec3 uLampCol;
uniform float uTime;
uniform float uNight;
float flicker(float t, float ph) {
  // a failing sodium lamp: long dark gaps, stuttering restarts, a dim hum
  float cyc = fract(t / 5.5 + ph);
  float k = floor(t * 14.0 + ph * 97.0);
  float r = fract(sin(k * 12.9898 + ph * 78.233) * 43758.5453);
  float stutter = r > 0.42 ? 1.0 : 0.08;
  return cyc < 0.38 ? 0.04 : (cyc < 0.62 ? stutter : 0.72 + 0.28 * r);
}
vec3 toon(vec3 base, vec3 n, float lit) {
  float d = dot(normalize(n), uLightDir);
  float band = d > 0.5 ? 1.0 : (d > 0.05 ? 0.74 : 0.52);
  vec3 c = base * (uAmbient + uLightCol * band);
  c += base * uLampCol * lit * (0.55 + 0.45 * max(n.z, 0.0));
  c += base * vec3(0.12, 0.14, 0.2) * uNight;            // moonlight lift: figures never vanish into the asphalt
  return c;
}
`;
const ROT_Z = /* glsl */ `
vec3 rotZ(vec3 p, float h) { float c = cos(h), s = sin(h); return vec3(p.x * c + p.y * s, -p.x * s + p.y * c, p.z); }
`;

function toonMaterial(vertexBody, uniforms, outline, fragmentBody = null, varyings = "") {
  return new THREE.ShaderMaterial({
    uniforms,
    side: outline ? THREE.BackSide : THREE.FrontSide,
    vertexShader: `${TOON_COMMON}${ROT_Z}
      uniform float uOutline;
      varying vec3 vN; varying vec3 vCol; varying float vLit; varying float vGlow; ${varyings}
      ${vertexBody}`,
    fragmentShader: `${TOON_COMMON}
      uniform vec3 uInk;
      varying vec3 vN; varying vec3 vCol; varying float vLit; varying float vGlow; ${varyings}
      void main() {
        ${outline ? "gl_FragColor = vec4(uInk, 1.0); return;" : ""}
        ${fragmentBody || `vec3 c = toon(vCol, vN, vLit);
        c = mix(c, vec3(1.0, 0.88, 0.64) * 1.6 * vCol, clamp(vGlow, 0.0, 1.0));
        gl_FragColor = vec4(c, 1.0);`}
      }`,
  });
}

/* people: slender cel-shaded figures; legs and arms swing about hip and shoulder */
const PERSON_VS = /* glsl */ `
attribute float aPart; attribute float aSwing; attribute float aPivot; attribute float aJoint;
attribute vec4 aState;     // x, y, heading, gait (0 still .. 1 walk .. 2 run)
attribute vec3 aShirt; attribute vec3 aPants; attribute vec3 aHair;
attribute vec3 aMisc;      // stride cycle (0..1, advanced by distance walked), lamp light, skin tone
attribute vec4 aStyle;     // coat (0/1), height scale, idle sway, ground height
void rotX(inout vec3 p, inout vec3 n, float pivot, float a) {
  float c = cos(a), s = sin(a), z = p.z - pivot;
  p = vec3(p.x, p.y * c - z * s, p.y * s + z * c + pivot);
  n = vec3(n.x, n.y * c - n.z * s, n.y * s + n.z * c);
}
void main() {
  vec3 p = position; vec3 n = normal;
  if (aPart > 4.5 && aStyle.x < 0.5) p = vec3(0.0, 0.0, 0.9);          // no coat: fold it away
  float g = max(aState.w, 0.0);
  float fall = clamp(-aState.w, 0.0, 1.0);                               // hit by a car: 0 standing .. 1 on the ground
  float walk = clamp(g, 0.0, 1.0), run = clamp(g - 1.0, 0.0, 1.0), stroll = walk * (1.0 - run);
  float ph = aMisc.x * 6.2831853, sn = sin(ph), cs = cos(ph);
  bool arm = aJoint < -0.01 || aPivot > 1.2;
  // knee / elbow first, in the limb's own frame
  if (abs(aJoint) > 0.01) {
    float bend;
    if (aJoint > 0.0) {
      // the knee folds while that leg swings through; a running heel kicks right up
      float through = max(0.0, aSwing * cs);
      bend = -((0.1 + 0.9 * through) * stroll + (0.35 + 1.55 * through) * run);
    } else {
      bend = 0.16 + 0.22 * stroll + 1.2 * run;                          // elbows: relaxed walking, pumped running
    }
    rotX(p, n, abs(aJoint), bend);
  }
  // hip / shoulder swing, opposite arm to leg
  if (abs(aSwing) > 0.01) {
    float A = arm ? (0.3 * stroll + 0.62 * run) : (0.42 * stroll + 0.75 * run);
    if (aPart > 4.5) A *= 0.25;                                          // coat tails follow the legs a little
    rotX(p, n, aPivot, aSwing * A * sn);
  }
  // whole body: lean into a run, bob twice a stride, a little hip sway; standing people shift their weight
  rotX(p, n, 0.0, -(0.04 * stroll + 0.17 * run));
  p.z += 0.028 * stroll * (0.5 - 0.5 * cos(2.0 * ph)) + 0.07 * run * abs(sn);
  p.x += 0.018 * stroll * sn * (p.z / 1.7);
  if (fall > 0.0) { rotX(p, n, 0.0, 1.5708 * fall * fall); p.z += 0.14 * fall; p.y -= 0.9 * fall; }
  float idle = (1.0 - walk) * aStyle.z;
  p.x += sin(uTime * 0.9 + aMisc.x * 9.0) * 0.025 * idle * (p.z / 1.7);
  p *= aStyle.y;
  p += n * uOutline;
  vec3 skin = mix(vec3(0.94, 0.78, 0.65), vec3(0.42, 0.28, 0.2), aMisc.z);
  vCol = aPart < 0.5 ? skin : (aPart < 1.5 ? aShirt : (aPart < 2.5 ? aPants :
         (aPart < 3.5 ? vec3(0.13, 0.11, 0.1) : (aPart < 4.5 ? aHair : aShirt * 0.8))));
  vN = rotZ(n, aState.z); vLit = aMisc.y; vGlow = 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(rotZ(p, aState.z) + vec3(aState.xy, aStyle.w), 1.0);
}`;

/* cars: one smooth body; glass, pillars and lamps are drawn per pixel from body coordinates */
const CAR_VARYINGS = "varying vec3 vObj; varying vec3 vObjN; varying float vPart;";
const CAR_VS = /* glsl */ `
attribute float aPart;
attribute vec4 aState;     // x, y, heading, scale (0 = hidden)
attribute vec3 aColor; attribute float aLit;
attribute vec3 aKind;      // taxi (0/1), height scale (SUVs ride taller), ground height (bridge decks)
void main() {
  vec3 p = position; vec3 n = normal;
  if (aPart > 5.5 && aPart < 6.5 && aKind.x < 0.5) p = vec3(0.0, 0.0, 1.0);   // roof sign: cabs only
  vObj = position; vObjN = normal; vPart = aPart;
  p *= vec3(1.0, aState.w, aKind.y);
  p += n * uOutline;
  vCol = aPart < 0.5 ? aColor : (aPart < 2.5 ? vec3(0.07, 0.07, 0.08) : (aPart < 6.5 ? vec3(0.98, 0.9, 0.55) : vec3(0.72, 0.74, 0.76)));
  vGlow = 0.0;
  vN = rotZ(n, aState.z); vLit = aLit;
  float sc = aState.w > 0.0 ? 1.0 : 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(rotZ(p * sc, aState.z) + vec3(aState.xy, aKind.z), 1.0);
}`;
const CAR_FS = /* glsl */ `
  vec3 c = toon(vCol, vN, vLit);
  if (vPart < 0.5) {
    vec3 o = vObj; vec3 on = normalize(vObjN);
    // glass: everything above the beltline that is not roof, minus the B-pillar
    float glass = step(0.99, o.z) * step(o.z, 1.37) * step(on.z, 0.86) * step(0.07, abs(o.y + 0.12));
    float sky = clamp((o.z - 0.99) / 0.4, 0.0, 1.0);
    vec3 g = mix(mix(vec3(0.2, 0.26, 0.32), vec3(0.55, 0.66, 0.72), sky * 0.8), vec3(0.05, 0.07, 0.1) + sky * 0.08, uNight);
    c = mix(c, g * (0.75 + 0.25 * max(on.z, 0.0)), glass);
    // a crisp highlight along the shoulder
    c += step(0.92, on.z) * step(0.8, o.z) * step(o.z, 0.98) * 0.06;
    float head = step(2.1, o.y) * step(0.56, o.z) * step(o.z, 0.78) * step(abs(abs(o.x) - 0.58), 0.2);
    float tail = step(o.y, -2.18) * step(0.62, o.z) * step(o.z, 0.84) * step(abs(abs(o.x) - 0.6), 0.22);
    c = mix(c, mix(vec3(0.9, 0.9, 0.85), vec3(1.6, 1.5, 1.2), uNight), head);
    c = mix(c, mix(vec3(0.62, 0.1, 0.08), vec3(1.3, 0.15, 0.1), uNight), tail);
  }
  if (vPart > 5.5 && vPart < 6.5) c = mix(c, vec3(1.4, 1.25, 0.7), uNight);
  gl_FragColor = vec4(c, 1.0);
`;

const LAMP_VS = /* glsl */ `
attribute float aPart;
attribute vec4 aState;     // x, y, heading, flicker phase (<0 = healthy)
void main() {
  vec3 p = position; vec3 n = normal;
  p += n * uOutline * (aPart < 0.5 ? 0.5 : 1.0);
  float f = aState.w < 0.0 ? 1.0 : flicker(uTime, aState.w);
  vCol = aPart < 0.5 ? vec3(0.2, 0.22, 0.24) : (aPart < 1.5 ? vec3(0.32, 0.34, 0.36) : vec3(0.85, 0.84, 0.78));
  vGlow = aPart > 1.5 ? uNight * f : 0.0;
  vN = rotZ(n, aState.z); vLit = 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(rotZ(p, aState.z) + vec3(aState.xy, 0.0), 1.0);
}`;

const TREE_VS = /* glsl */ `
attribute float aPart;
attribute vec4 aState;     // x, y, rotation, scale
attribute vec3 aTint; attribute float aLit;
void main() {
  vec3 p = position * aState.w; vec3 n = normal;
  p += n * uOutline;
  p.x += sin(uTime * 0.9 + aState.x * 0.13 + aState.y * 0.07) * 0.06 * max(p.z - 3.0, 0.0) / 4.0;
  vCol = aPart < 0.5 ? vec3(0.36, 0.25, 0.17) : aTint;
  vN = rotZ(n, aState.z); vLit = aLit; vGlow = 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(rotZ(p, aState.z) + vec3(aState.xy, 0.0), 1.0);
}`;

/* the L: steel viaduct pieces and train cars, all as stretched, rotated boxes */
const BEAM_VS = /* glsl */ `
attribute vec4 aBeam;      // x, y, heading, length
attribute vec4 aBeamB;     // z0, z1, width, kind (0 steel, 1 ties, 2 train body, 3 train windows, 4 cap beam)
attribute float aSlope;    // rise per metre along the beam (bridge ramps)
void main() {
  vec3 p = vec3(position.x * aBeamB.z, position.y * aBeam.w, aBeamB.x + position.z * (aBeamB.y - aBeamB.x));
  p.z += position.y * aBeam.w * aSlope;
  vec3 n = normal;
  p += n * uOutline;
  float k = aBeamB.w;
  // 0 steel, 1 ties, 2 train body, 3 train windows, 4 cap beam, 5 platform, 6 canopy, 7 light strip, 8 station brick,
  // 9 bridge girder, 10 bridge-house stone, 11 bridge railing
  // 12 asphalt deck, 13 sidewalk, 14 ballast, 15 concrete, 16 rail steel, 17 Metra locomotive, 18 its red stripe
  vec3 c = vec3(0.72, 0.2, 0.16);
  if (k < 0.5) c = vec3(0.44, 0.52, 0.44);
  else if (k < 1.5) c = vec3(0.24, 0.21, 0.18);
  else if (k < 2.5) c = vec3(0.84, 0.86, 0.88);
  else if (k < 3.5) c = vec3(0.16, 0.2, 0.26);
  else if (k < 4.5) c = vec3(0.5, 0.57, 0.48);
  else if (k < 5.5) c = vec3(0.7, 0.67, 0.62);
  else if (k < 6.5) c = vec3(0.6, 0.25, 0.2);
  else if (k < 7.5) c = vec3(0.95, 0.88, 0.7);
  else if (k < 8.5) c = vec3(0.64, 0.4, 0.31);
  else if (k < 9.5) c = vec3(0.5, 0.29, 0.23);
  else if (k < 10.5) c = vec3(0.8, 0.75, 0.64);
  else if (k < 11.5) c = vec3(0.3, 0.33, 0.3);
  else if (k < 12.5) c = vec3(0.56, 0.55, 0.52);
  else if (k < 13.5) c = vec3(0.6, 0.58, 0.54);
  else if (k < 14.5) c = vec3(0.46, 0.44, 0.41);
  else if (k < 15.5) c = vec3(0.62, 0.6, 0.56);
  else if (k < 16.5) c = vec3(0.58, 0.57, 0.55);
  else if (k < 17.5) c = vec3(0.2, 0.3, 0.5);
  else if (k > 18.5 && k < 19.5) c = vec3(0.35, 0.95, 0.55);
  else if (k > 19.5) c = vec3(1.0, 0.3, 0.22);
  vCol = c;
  vGlow = k > 18.5 ? 1.0 : ((k > 2.5 && k < 3.5) || (k > 6.5 && k < 7.5)) ? uNight : 0.0;
  vN = rotZ(n, aBeam.z);
  bool train = (k > 1.5 && k < 3.5) || k > 16.5;
  vLit = uNight * (train ? 0.2 : 0.55);   // streetlight catching the steelwork
  gl_Position = projectionMatrix * modelViewMatrix * vec4(rotZ(p, aBeam.z) + vec3(aBeam.xy, 0.0), 1.0);
}`;

/* boats: water taxis, tour boats and sailboats, bobbing on the swell */
const BOAT_VS = /* glsl */ `
attribute float aPart;
attribute vec4 aBoat;      // x, y, heading, length scale
attribute vec4 aBoatB;     // kind (0 taxi, 1 tour boat, 2 sailboat), bob phase, -, -
attribute vec3 aColor; attribute float aLit;
void main() {
  vec3 p = position; vec3 n = normal;
  float kind = aBoatB.x;
  bool sail = kind > 1.5;
  // sailboats lose the cabin and canopy; motor boats lose the mast and sail
  if ((sail && aPart > 0.5 && aPart < 2.5) || (sail && aPart > 4.5) || (!sail && aPart > 2.5 && aPart < 4.5)) p = vec3(0.0);
  if (kind < 0.5 && aPart > 1.5 && aPart < 2.5) p = vec3(0.0);            // water taxis: open deck, no canopy
  p.y *= aBoat.w; p.x *= sail ? 0.6 : 1.0; if (sail) p.y *= 0.55;
  float t = uTime * 1.2 + aBoatB.y * 6.283;
  p.z += sin(t) * 0.12;
  float roll = sin(t * 0.8) * (sail ? 0.06 : 0.025);
  p = vec3(p.x, p.y, p.z + p.x * roll);
  p += n * uOutline;
  vCol = aPart < 0.5 ? aColor : (aPart < 1.5 ? vec3(0.93, 0.92, 0.88) : (aPart < 2.5 ? vec3(0.17, 0.3, 0.46) :
         (aPart < 3.5 ? vec3(0.55, 0.52, 0.48) : (aPart < 4.5 ? vec3(0.96, 0.94, 0.88) : vec3(0.14, 0.18, 0.24)))));
  vGlow = aPart > 4.5 ? uNight * 0.9 : 0.0;
  vN = rotZ(n, aBoat.z); vLit = aLit;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(rotZ(p, aBoat.z) + vec3(aBoat.xy, 0.0), 1.0);
}`;

/* street furniture: hydrants, benches, bins (one geometry per kind, one material) */
const PROP_VS = /* glsl */ `
attribute float aPart;
attribute vec4 aState;     // x, y, heading, lamp light
void main() {
  vec3 p = position; vec3 n = normal;
  p += n * uOutline;
  vCol = aPart < 0.5 ? vec3(0.74, 0.17, 0.13) : (aPart < 1.5 ? vec3(0.8, 0.8, 0.76) : (aPart < 2.5 ? vec3(0.56, 0.37, 0.22) :
         (aPart < 3.5 ? vec3(0.17, 0.2, 0.19) : (aPart < 4.5 ? vec3(0.18, 0.33, 0.25) : vec3(0.1, 0.12, 0.12)))));
  vN = rotZ(n, aState.z); vLit = aState.w; vGlow = 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(rotZ(p, aState.z) + vec3(aState.xy, 0.0), 1.0);
}`;

/* road markings: true-scale painted strips on the ground, anti-aliased so thin paint fades
 * smoothly with distance instead of shimmering */
const MARK_VS = /* glsl */ `
attribute vec2 aAcross;    // -1..1 across the strip, colour (0 white, 1 yellow)
attribute vec2 aOff;       // world offset from the strip's centre line to this vertex
uniform vec2 uViewport;
varying float vAcross; varying float vYellow; varying float vCover;
void main() {
  vAcross = aAcross.x; vYellow = aAcross.y;
  vec3 c = position - vec3(aOff, 0.0);
  vec4 cc = projectionMatrix * modelViewMatrix * vec4(c, 1.0);
  vec4 co = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  float px = length((co.xy / co.w - cc.xy / cc.w) * uViewport * 0.5);
  // never thinner than ~1.4 px: a lane line stays a readable line at city zoom, true width up close
  float k = px < 1.1 ? 1.1 / max(px, 1e-4) : 1.0;
  vCover = 1.0 / k;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(c + vec3(aOff * k, 0.0), 1.0);
}`;
const MARK_FS = /* glsl */ `
uniform float uNight; uniform float uFade;
varying float vAcross; varying float vYellow; varying float vCover;
void main() {
  float a = (1.0 - smoothstep(0.6, 1.0, abs(vAcross))) * mix(0.5, 1.0, clamp(vCover * 2.0, 0.0, 1.0)) * uFade;
  if (a < 0.02) discard;
  vec3 white = mix(vec3(0.95, 0.94, 0.9), vec3(0.6, 0.62, 0.65), uNight);
  vec3 yellow = mix(vec3(0.9, 0.72, 0.26), vec3(0.62, 0.5, 0.2), uNight);
  gl_FragColor = vec4(mix(white, yellow, vYellow), a * 0.9);
}`;

/* ground openings: footprints of cuttings, written to the stencil buffer only */
const CUT_VS = /* glsl */ `
attribute vec4 aCut;       // x, y, heading, length
attribute float aCutW;     // width
${ROT_Z}
void main() {
  vec3 p = rotZ(vec3(position.x * aCutW * 0.5, position.y * aCut.w * 0.5, 0.0), aCut.z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p + vec3(aCut.xy, 0.0), 1.0);
}`;

/* zebra crossings, drawn as striped decals across each street at an intersection */
const CROSS_VS = /* glsl */ `
attribute vec4 aCross;     // x, y, heading (along the street), half width across the street
attribute float aCrossKind; // 0 zebra, 1 ladder, 2 parallel lines
uniform float uFade;
varying vec2 vXY; varying float vW; varying float vKind;
${ROT_Z}
void main() {
  vW = aCross.w; vKind = aCrossKind;
  vXY = vec2(position.x * aCross.w, position.y * 1.6);          // across, along (3.2 m deep)
  vec3 p = rotZ(vec3(vXY, 0.0), aCross.z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p + vec3(aCross.xy, 0.05), 1.0);
}`;
const CROSS_FS = /* glsl */ `
uniform float uNight; uniform float uFade;
varying vec2 vXY; varying float vW; varying float vKind;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float bars = step(0.45, fract(vXY.x / 1.1 + 0.25));            // 0.6 m bars, 0.5 m gaps
  float lines = step(1.42, abs(vXY.y));                            // two 0.18 m lines at the crossing's edges
  float stripe = vKind < 0.5 ? bars : (vKind < 1.5 ? max(bars, lines) : lines);
  float edge = step(abs(vXY.x), vW - 0.4);
  float wear = 0.75 + 0.25 * hash(floor(vXY * 3.0));
  float a = stripe * edge * wear * uFade * (1.0 - smoothstep(1.35, 1.6, abs(vXY.y)));
  if (a < 0.02) discard;
  gl_FragColor = vec4(mix(vec3(0.95, 0.94, 0.9), vec3(0.62, 0.64, 0.66), uNight), a * 0.9);
}`;

/* buildings: one merged mesh, facades drawn procedurally at true scale */
const BLDG_VS = /* glsl */ `
attribute vec4 aFacade;    // walls: perimeter u, height z, u along this wall, wall length | roofs: x, y, 0, -1
attribute vec3 aBld;       // seed, height, base height
uniform float uRise;
varying vec4 vF; varying vec3 vB; varying vec3 vN; varying float vW;
void main() {
  vec3 p = position;
  p.z = aBld.z + (p.z - aBld.z) * uRise;
  vF = aFacade; vB = aBld; vN = normal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  vW = gl_Position.w;
}`;
const BLDG_FS = /* glsl */ `
uniform vec3 uLightDir; uniform vec3 uLightCol; uniform vec3 uAmbient; uniform float uNight;
uniform vec3 uInk; uniform vec3 uFogCol; uniform vec2 uFog;
varying vec4 vF; varying vec3 vB; varying vec3 vN; varying float vW;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float band(float x, float a, float b, float w) { return smoothstep(a - w, a + w, x) * (1.0 - smoothstep(b - w, b + w, x)); }
vec3 palette(float s) {
  float k = fract(s * 7.31);
  if (k < 0.30) return vec3(0.69, 0.42, 0.32);   // Chicago common brick
  if (k < 0.52) return vec3(0.84, 0.77, 0.63);   // Indiana limestone
  if (k < 0.70) return vec3(0.78, 0.66, 0.51);   // sandstone
  if (k < 0.86) return vec3(0.63, 0.61, 0.57);   // concrete
  return vec3(0.63, 0.47, 0.37);                 // terracotta
}
void main() {
  vec3 n = normalize(vN);
  float seed = vB.x, H = vB.y, H0 = vB.z;
  bool tower = H > 70.0;
  vec3 wall = palette(seed);
  if (tower) wall = mix(wall, vec3(0.45, 0.54, 0.61), 0.6);
  float d = dot(n, uLightDir);
  float shade = d > 0.45 ? 1.0 : (d > 0.0 ? 0.8 : 0.62);
  vec3 lightCol = uAmbient + uLightCol * shade;
  vec3 col; vec3 emit = vec3(0.0);
  if (vF.w < 0.0) {
    vec3 roof = mix(wall, vec3(0.43, 0.42, 0.41), 0.55);
    roof *= 0.93 + 0.07 * hash(floor(vF.xy * 0.7));
    col = roof * (uAmbient + uLightCol);
  } else {
    float u = vF.x, z = vF.y, ul = vF.z, L = vF.w;
    float floorH = H > 14.0 ? 3.8 : 3.0;
    float colW = tower ? 1.7 : (H > 14.0 ? 3.0 : 2.6);
    float groundH = H > 11.0 ? 4.8 : 0.4;
    vec2 g = vec2(u / colW, (z - groundH) / floorH);
    vec2 cell = floor(g), f = fract(g);
    vec2 aa = fwidth(g) * 1.2;
    float wx0 = tower ? 0.08 : 0.2, wx1 = tower ? 0.92 : 0.8;
    float wy0 = tower ? 0.1 : 0.28, wy1 = tower ? 0.92 : 0.82;
    float inside = step(groundH + 0.2, z) * step(z, H - 1.1) * step(0.8, ul) * step(ul, L - 0.8) * step(H0 + 0.01, z)
                 * step(5.0, H - H0);                              // kiosks, sheds, tents: plain walls, no window grid
    float detail = 1.0 - smoothstep(0.3, 0.8, max(aa.x, aa.y));       // fade sub-pixel windows: no shimmer
    float win = band(f.x, wx0, wx1, aa.x) * band(f.y, wy0, wy1, aa.y) * inside;
    float r = hash(cell + vec2(seed * 91.7, seed * 13.3));
    float on = step(0.58, r) * uNight;
    vec3 glassDay = mix(vec3(0.24, 0.31, 0.37), vec3(0.6, 0.72, 0.77), clamp(z / max(H, 1.0), 0.0, 1.0) * 0.75 + 0.12 * r);
    vec3 glass = mix(glassDay, vec3(0.05, 0.07, 0.11), uNight) * lightCol * 1.1;
    vec3 warm = mix(vec3(1.0, 0.72, 0.4), vec3(1.0, 0.9, 0.72), fract(r * 7.0));

    vec3 w = wall * mix(0.7, 1.0, smoothstep(0.0, 9.0, z - H0));    // grounded base
    w = mix(w, wall * 0.58, smoothstep(H - 1.0, H - 0.85, z));      // cornice
    float lintel = groundH > 1.0 ? band(z, groundH - 0.4, groundH, fwidth(z)) : 0.0;
    w = mix(w, wall * 0.68, lintel);
    col = w * lightCol;

    float wm = win * detail;
    col = mix(col, glass, wm);
    emit += warm * on * wm * 0.95;
    float avg = (wx1 - wx0) * (wy1 - wy0) * inside * (1.0 - detail);
    col = mix(col, glass, avg * 0.55);
    emit += warm * uNight * avg * 0.17;

    // shopfronts: tall glass bays between piers, mostly lit after dark
    if (groundH > 1.0) {
      float bay = fract(u / 6.0);
      float shop = band(z, 0.5, groundH - 0.8, fwidth(z)) * band(bay, 0.07, 0.93, fwidth(u / 6.0) * 1.2)
                 * step(0.8, ul) * step(ul, L - 0.8);
      float shopOn = step(0.3, hash(vec2(floor(u / 6.0), seed * 51.0))) * uNight;
      col = mix(col, glass * 0.9, shop);
      emit += vec3(1.0, 0.8, 0.52) * shopOn * shop;
      // striped canvas awnings over about half the bays
      float bayId = floor(u / 6.0);
      float awn = band(z, groundH - 1.15, groundH - 0.6, fwidth(z)) * band(bay, 0.1, 0.9, fwidth(u / 6.0) * 1.2)
                * step(0.45, hash(vec2(bayId, seed * 37.0))) * step(0.8, ul) * step(ul, L - 0.8);
      float ai = hash(vec2(bayId, seed * 11.0));
      vec3 awnA = ai < 0.25 ? vec3(0.6, 0.16, 0.14) : (ai < 0.5 ? vec3(0.13, 0.36, 0.25) : (ai < 0.75 ? vec3(0.16, 0.22, 0.4) : vec3(0.75, 0.55, 0.16)));
      float stripe = step(0.5, fract(u * 1.4));
      vec3 awnCol = mix(awnA, vec3(0.93, 0.9, 0.84), stripe * 0.8) * lightCol * (0.85 + 0.15 * smoothstep(groundH - 1.15, groundH - 0.6, z));
      col = mix(col, awnCol, awn);
      emit *= 1.0 - awn;
    }
    // ink at the corners and along the roofline
    float edge = min(ul, L - ul);
    float ink = max(1.0 - smoothstep(0.0, 0.12 + fwidth(ul) * 1.5, edge),
                    1.0 - smoothstep(0.0, 0.1 + fwidth(z) * 1.5, H - z));
    col = mix(col, uInk, ink * 0.8);
    emit *= 1.0 - ink;
  }
  col += emit;
  col = mix(col, uFogCol, smoothstep(uFog.x, uFog.y, vW) * 0.9);
  gl_FragColor = vec4(col, 1.0);
}`;

/* Cloud Gate: a toon-chrome bean that mirrors sky and ground */
const BEAN_VS = /* glsl */ `
varying vec3 vN; varying vec3 vP;
void main() { vN = normal; vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BEAN_FS = /* glsl */ `
uniform vec3 uSky; uniform vec3 uGround; uniform vec3 uLightDir; uniform float uNight; uniform float uTime;
varying vec3 vN; varying vec3 vP;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 n = normalize(vN);
  float t = n.z;
  // toon chrome: sky above, the skyline's band at the horizon, plaza below
  vec3 sky = uSky * (1.35 + 0.3 * uNight) + 0.06;
  vec3 city = mix(vec3(0.74, 0.71, 0.64), vec3(0.34, 0.31, 0.35), uNight);
  vec3 c = t > 0.35 ? sky : (t > -0.05 ? city : uGround * 0.9 + 0.06);
  c = mix(c, sky * 1.3, step(0.82, t));
  float spec = pow(max(dot(reflect(-uLightDir, n), vec3(0.0, 0.0, 1.0)), 0.0), 18.0);
  c += step(0.5, spec) * 0.35;
  // at night the bean carries the city's lit windows in its skyline band
  vec2 q = floor(vec2(atan(n.y, n.x) * 26.0, n.z * 30.0));
  c += uNight * step(0.9, hash(q)) * vec3(1.0, 0.8, 0.5) * 0.9 * step(-0.05, t) * (1.0 - step(0.35, t));
  gl_FragColor = vec4(c, 1.0);
}`;

/* ground decals: additive light pools, and blob shadows */
const POOL_VS = /* glsl */ `
attribute vec4 aPool;      // x, y, radius, intensity
attribute vec4 aPoolB;     // flicker phase (<0 none), stretch, heading, kind (0 lamp, 1 headlight, 2 avatar ring)
uniform float uFade;
varying vec2 vUv; varying float vA; varying float vKind;
${TOON_COMMON}
${ROT_Z}
void main() {
  vUv = position.xy;
  float f = aPoolB.x < 0.0 ? 1.0 : flicker(uTime, aPoolB.x);
  vA = aPool.w * f * uFade; vKind = aPoolB.w;
  vec3 p = rotZ(vec3(position.x * aPool.z, position.y * aPool.z * aPoolB.y, 0.0), aPoolB.z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p + vec3(aPool.xy, 0.12 + aPoolB.w * 0.02), 1.0);
}`;
const POOL_FS = /* glsl */ `
varying vec2 vUv; varying float vA; varying float vKind;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  if (vKind > 1.5) {
    float ring = smoothstep(0.62, 0.78, r) * (1.0 - smoothstep(0.86, 1.0, r));
    gl_FragColor = vec4(vec3(0.62, 0.85, 1.0), ring * vA);
    return;
  }
  float a = pow(1.0 - r, 1.7) * vA;
  gl_FragColor = vec4(vKind > 0.5 ? vec3(1.0, 0.95, 0.82) : vec3(1.0, 0.7, 0.34), a);
}`;

const SHADOW_VS = /* glsl */ `
attribute vec4 aShadow;    // x, y, radius, height
uniform vec2 uSunOff;      // horizontal shadow length per metre of height (away from the sun)
uniform float uFade;
varying vec2 vUv; varying float vA;
void main() {
  vUv = position.xy;
  vec2 off = uSunOff * aShadow.w;
  float len = length(off);
  vec2 dir = len > 0.001 ? off / len : vec2(1.0, 0.0);
  vec2 p = dir * position.x * (aShadow.z + len * 0.5) + vec2(-dir.y, dir.x) * position.y * aShadow.z;
  vA = uFade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(aShadow.xy + off * 0.5 + p, 0.06, 1.0);
}`;
const SHADOW_FS = /* glsl */ `
uniform vec3 uShadowCol; uniform float uShadowA;
varying vec2 vUv; varying float vA;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  gl_FragColor = vec4(uShadowCol, (1.0 - smoothstep(0.45, 1.0, r)) * uShadowA * vA);
}`;

/* screen-facing halos around lit lamp heads */
const HALO_VS = /* glsl */ `
attribute vec4 aHalo;      // x, y, z, flicker phase
uniform vec2 uViewport; uniform float uFade;
varying vec2 vUv; varying float vA;
${TOON_COMMON}
void main() {
  vUv = position.xy;
  vec4 c = projectionMatrix * modelViewMatrix * vec4(aHalo.xyz, 1.0);
  vec4 cz = projectionMatrix * modelViewMatrix * vec4(aHalo.xyz + vec3(0.0, 0.0, 1.0), 1.0);
  vec4 cx = projectionMatrix * modelViewMatrix * vec4(aHalo.xyz + vec3(1.0, 0.0, 0.0), 1.0);
  vec2 sc = c.xy / c.w;
  float pxPerM = max(length((cz.xy / cz.w - sc) * uViewport * 0.5), length((cx.xy / cx.w - sc) * uViewport * 0.5));
  float sizePx = clamp(pxPerM * 2.6, 3.0, 160.0);
  vA = (aHalo.w < 0.0 ? 1.0 : flicker(uTime, aHalo.w)) * uFade;
  gl_Position = c + vec4(position.xy * sizePx * 2.0 / uViewport * c.w, 0.0, 0.0);
}`;
const HALO_FS = /* glsl */ `
varying vec2 vUv; varying float vA;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float a = (pow(1.0 - r, 3.0) * 0.9 + smoothstep(0.25, 0.0, r) * 0.6) * vA;
  gl_FragColor = vec4(1.0, 0.82, 0.55, a);
}`;

/* ------------------------------------------------------------------ geometry */

function part(geo, partId, extra = {}) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal") g.deleteAttribute(k);
  const n = g.attributes.position.count;
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(new Float32Array(n).fill(partId), 1));
  for (const [k, v] of Object.entries(extra)) g.setAttribute(k, new THREE.Float32BufferAttribute(new Float32Array(n).fill(v), 1));
  return g;
}
const box = (w, d, h, x, y, z) => new THREE.BoxGeometry(w, d, h).translate(x, y, z);
const cyl = (rt, rb, h, x, y, z, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg).rotateX(Math.PI / 2).translate(x, y, z);

// Z-up helpers for three's Y-up primitives
const up = (g) => g.rotateX(Math.PI / 2);
const lathe = (pts, seg = 9) => up(new THREE.LatheGeometry(pts.map(([r, z]) => new THREE.Vector2(r, z)), seg));
const ball = (r, w = 8, h = 6) => up(new THREE.SphereGeometry(r, w, h));

function personGeometry() {
  // parts: 0 skin, 1 top, 2 trousers, 3 shoes, 4 hair, 5 coat tails
  // aSwing: +-1 limb side (arms opposite legs), aPivot: hip / shoulder height, aJoint: knee (+) / elbow (-) height
  const P = (g, id, swing = 0, pivot = 0, joint = 0) => part(g, id, { aSwing: swing, aPivot: pivot, aJoint: joint });
  const HIP = 0.93, KNEE = 0.5, SHOULDER = 1.43, ELBOW = 1.14;
  const tube = (rt, rb, h, seg, x, z) => up(new THREE.CylinderGeometry(rt, rb, h, seg, 1, true)).translate(x, 0, z);
  const pieces = [];
  for (const sd of [-1, 1]) {
    const x = sd * 0.088, sw = sd < 0 ? 1 : -1;
    pieces.push(P(tube(0.074, 0.058, 0.46, 6, x, 0.71), 2, sw, HIP));                 // thigh
    pieces.push(P(ball(0.058, 6, 4).translate(x, 0, KNEE), 2, sw, HIP, KNEE));        // knee
    pieces.push(P(tube(0.056, 0.043, 0.45, 6, x, 0.28), 2, sw, HIP, KNEE));           // shin
    pieces.push(P(ball(1, 6, 4).scale(0.055, 0.115, 0.045).translate(x, 0.035, 0.05), 3, sw, HIP, KNEE));
    const ax = sd * 0.2;
    pieces.push(P(tube(0.043, 0.037, 0.31, 5, ax, 1.29), 1, -sw, SHOULDER));          // upper arm
    pieces.push(P(ball(0.037, 5, 3).translate(ax, 0, ELBOW), 1, -sw, SHOULDER, -ELBOW));
    pieces.push(P(tube(0.036, 0.03, 0.27, 5, ax, 1.0), 1, -sw, SHOULDER, -ELBOW));     // forearm
    pieces.push(P(ball(0.036, 5, 3).translate(ax, 0.01, 0.84), 0, -sw, SHOULDER, -ELBOW));
  }
  pieces.push(P(ball(1, 7, 4).scale(0.14, 0.095, 0.09).translate(0, 0, 0.95), 2));
  pieces.push(P(lathe([[0.001, 0.9], [0.118, 0.93], [0.122, 1.02], [0.105, 1.11], [0.13, 1.25],
                       [0.158, 1.37], [0.13, 1.45], [0.055, 1.5], [0.001, 1.515]]).scale(1.15, 0.76, 1), 1));
  pieces.push(P(lathe([[0.125, 1.0], [0.142, 0.86], [0.17, 0.68], [0.19, 0.52]]).scale(1.15, 0.84, 1), 5, 1, HIP));
  pieces.push(P(up(new THREE.CylinderGeometry(0.038, 0.042, 0.1, 5, 1, true)).translate(0, 0, 1.54), 0));
  pieces.push(P(ball(0.1, 9, 7).scale(0.94, 1.0, 1.16).translate(0, 0.006, 1.665), 0));
  pieces.push(P(up(new THREE.SphereGeometry(0.108, 9, 4, 0, Math.PI * 2, 0, Math.PI * 0.6)).scale(0.97, 1.04, 1.12).translate(0, -0.014, 1.68), 4));
  return mergeGeometries(pieces);
}
function carGeometry() {
  // side silhouette (length along x, height along y), extruded across the car and bevelled round
  const sh = new THREE.Shape();
  sh.moveTo(-2.15, 0.3);
  sh.lineTo(2.12, 0.3);
  sh.quadraticCurveTo(2.34, 0.33, 2.3, 0.6);       // nose
  sh.quadraticCurveTo(2.26, 0.8, 1.92, 0.85);      // hood leading edge
  sh.lineTo(1.18, 0.97);                           // hood
  sh.quadraticCurveTo(0.72, 1.37, 0.36, 1.42);     // windshield into roof
  sh.lineTo(-0.62, 1.41);                          // roof
  sh.quadraticCurveTo(-1.02, 1.37, -1.36, 1.0);    // rear window
  sh.lineTo(-1.92, 0.94);                          // boot
  sh.quadraticCurveTo(-2.28, 0.9, -2.28, 0.62);    // tail
  sh.quadraticCurveTo(-2.28, 0.34, -2.15, 0.3);
  const body = new THREE.ExtrudeGeometry(sh, { depth: 1.6, steps: 1, curveSegments: 5,
    bevelEnabled: true, bevelThickness: 0.11, bevelSize: 0.09, bevelSegments: 2 });
  body.translate(0, 0, -0.8);
  // shape x -> car length (y), shape y -> height (z), extrusion -> width (x)
  body.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
  const wheel = (x, y) => [
    part(new THREE.CylinderGeometry(0.34, 0.34, 0.26, 9).rotateZ(Math.PI / 2).translate(x, y, 0.34), 2),
    part(new THREE.CylinderGeometry(0.2, 0.2, 0.27, 6).rotateZ(Math.PI / 2).translate(x, y, 0.34), 7),
  ];
  return mergeGeometries([
    part(body, 0),
    ...wheel(-0.84, 1.42), ...wheel(0.84, 1.42), ...wheel(-0.84, -1.38), ...wheel(0.84, -1.38),
    part(box(0.56, 0.26, 0.18, 0, -0.12, 1.5), 6),                 // cab roof sign
  ]);
}
function propGeometries() {
  return {
    hydrant: mergeGeometries([
      part(cyl(0.17, 0.17, 0.06, 0, 0, 0.03, 8), 0),
      part(cyl(0.11, 0.13, 0.55, 0, 0, 0.32, 8), 0),
      part(ball(0.115, 8, 5).translate(0, 0, 0.6), 1),
      part(box(0.38, 0.09, 0.09, 0, 0, 0.44), 1),
      part(box(0.09, 0.16, 0.09, 0, 0.1, 0.4), 1),
    ]),
    bench: mergeGeometries([
      part(box(1.7, 0.42, 0.06, 0, 0, 0.46), 2),
      part(box(1.7, 0.05, 0.34, 0, -0.21, 0.73), 2),
      part(box(0.06, 0.44, 0.46, -0.72, 0, 0.23), 3),
      part(box(0.06, 0.44, 0.46, 0.72, 0, 0.23), 3),
      part(box(0.06, 0.06, 0.56, -0.72, -0.21, 0.62), 3),
      part(box(0.06, 0.06, 0.56, 0.72, -0.21, 0.62), 3),
    ]),
    bin: mergeGeometries([
      part(cyl(0.27, 0.24, 0.85, 0, 0, 0.425, 10), 4),
      part(cyl(0.29, 0.29, 0.07, 0, 0, 0.885, 10), 5),
    ]),
  };
}

function boatGeometry() {
  // top-view hull with a pointed bow (+Y), extruded upward and rounded
  const hull = new THREE.Shape();
  hull.moveTo(-2.1, -7.6);
  hull.lineTo(2.1, -7.6);
  hull.lineTo(2.2, 2.6);
  hull.quadraticCurveTo(1.9, 6.6, 0, 8.2);
  hull.quadraticCurveTo(-1.9, 6.6, -2.2, 2.6);
  hull.lineTo(-2.1, -7.6);
  const h = new THREE.ExtrudeGeometry(hull, { depth: 1.3, steps: 1, curveSegments: 6,
    bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.12, bevelSegments: 2 }).translate(0, 0, -0.5);
  const sail = new THREE.BufferGeometry();
  sail.setAttribute("position", new THREE.Float32BufferAttribute([0, 1.2, 1.2, 0, 1.2, 9.6, 0, -4.6, 1.4,
                                                                   0, 1.2, 1.2, 0, -4.6, 1.4, 0, 1.2, 9.6], 3));
  sail.computeVertexNormals();
  return mergeGeometries([
    part(h, 0),                                                     // hull (per-boat colour)
    part(box(3.5, 8.6, 1.9, 0, -1.2, 0.8), 1),                      // cabin
    part(box(4.0, 10.4, 0.16, 0, -1.0, 2.75), 2),                   // canopy (tour boats)
    part(cyl(0.07, 0.09, 9.2, 0, 1.2, 5.3, 6), 3),                  // mast (sailboats)
    part(sail, 4),                                                  // sail
    part(box(3.56, 8.0, 0.7, 0, -1.2, 1.55), 5),                    // cabin windows
  ]);
}

// Chicago "cobra head": tall pole, arm reaching over the street (+Y)
export const LAMP_HEAD = { y: 2.05, z: 8.3 };
function lampGeometry() {
  return mergeGeometries([
    part(cyl(0.2, 0.22, 0.5, 0, 0, 0.25), 0),
    part(cyl(0.07, 0.1, 8.6, 0, 0, 4.3, 7), 0),
    part(box(0.11, 2.0, 0.11, 0, 1.0, 8.52), 0),
    part(box(0.48, 0.95, 0.24, 0, 2.05, 8.46), 1),
    part(box(0.38, 0.72, 0.06, 0, 2.05, 8.32), 2),
  ]);
}
function treeGeometry() {
  const ico = (r, x, y, z) => new THREE.IcosahedronGeometry(r, 1).translate(x, y, z);
  return mergeGeometries([
    part(cyl(0.16, 0.24, 3.4, 0, 0, 1.7, 7), 0),
    part(ico(2.1, 0, 0, 4.7), 1),
    part(ico(1.55, 0.95, 0.45, 5.6), 1),
    part(ico(1.45, -0.85, -0.5, 5.35), 1),
    part(ico(1.3, 0.2, -0.9, 6.2), 1),
  ]);
}
function beanGeometry() {
  // 20 m long, 13 m wide, 10 m tall, with the arch you walk under
  const g = new THREE.SphereGeometry(1, 64, 40);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i) * 10, y = p.getY(i) * 6.5, z = p.getZ(i) * 5 + 5;
    const arch = 3.6 * Math.max(0, 1 - (x / 6.8) ** 2) * Math.max(0, 1 - (y / 6.5) ** 2 * 0.3);
    if (z < 5) z = Math.max(z, arch + (z) * 0.15);
    p.setXYZ(i, x, y, Math.max(0, z));
  }
  g.computeVertexNormals();
  return g;
}

const QUAD = new THREE.PlaneGeometry(2, 2);

function instanced(baseGeo, count, attrs) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = baseGeo.index;
  for (const [k, v] of Object.entries(baseGeo.attributes)) g.setAttribute(k, v);
  for (const [k, size] of Object.entries(attrs)) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, count) * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(k, a);
  }
  g.instanceCount = count;
  return g;
}

/* ------------------------------------------------------------------ palettes */

const SHIRTS = ["#c0533a", "#2f6f73", "#d9a441", "#6b4e71", "#e8dcc2", "#3b4a6b", "#8a9a5b", "#b5654a", "#c9c2b0", "#4d6a8a"];
const PANTS = ["#2d3142", "#4a3f35", "#5b6b7a", "#1f2a33", "#7a6a55", "#39434d", "#6b5a4a"];
const HAIR = ["#231914", "#3d2a1f", "#17171c", "#7a4f30", "#c4a06a", "#5e3326", "#cfc8bd", "#2b2420"];
const CAR_COLS = ["#b8483a", "#2f6f73", "#e9e1cf", "#3b4a6b", "#7c8b63", "#262b33", "#9a9fa6", "#8c3b3b", "#d6d2c8", "#4a5a6e", "#1f2a33"];
const TREE_TINTS = ["#4f7a3e", "#5e8a45", "#41683a", "#6b8f4a", "#58783d"];
const rgb = (hex) => new THREE.Color(hex);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

const LOOK = {
  night: { ambient: [0.25, 0.29, 0.4], light: [0.24, 0.28, 0.4], lamp: [1.25, 0.85, 0.45], ink: "#070a10",
           shadow: "#05070c", shadowA: 0.35, fog: "#151c29", sky: "#2a3550", ground: "#1b222d" },
  day:   { ambient: [0.58, 0.55, 0.5], light: [0.62, 0.56, 0.45], lamp: [0, 0, 0], ink: "#3b2a1d",
           shadow: "#4a3a2a", shadowA: 0.3, fog: "#efe1c3", sky: "#bfe0e6", ground: "#d9c9a6" },
};

/* ------------------------------------------------------------------ world */

export class World3D {
  constructor(map, { lampIndex, treeIndex, onArea, onProgress }) {
    this.map = map;
    this.lampIndex = lampIndex;
    this.treeIndex = treeIndex;
    this.onArea = onArea;
    this.onProgress = onProgress;
    this.reports = [];
    this.showOpen = true;
    this.showResolved = true;
    this.agentsOn = true;
    this.buildingsOn = true;
    this.mode = "night";
    this.sun = null;
    this.frame = null;
    this.state = null;           // the live, committed neighbourhood
    this.job = null;             // a neighbourhood being built in the background
    this.people = [];
    this.cars = [];
    this.trains = [];
    this.boats = [];
    this.avatar = null;
    this.walker = null;
    this.quality = isTouch ? 0.6 : 1;
    this.ready = false;
    this.time = 0;
    this.fade = 0;
    this.rise = 0;
    // our own z14 tiles, so the neighbourhood is complete at any zoom
    this.tileCache = new Map();
    this.tileUrl = null;        // set by the app: the local tiles/ folder (falls back to MapLibre's loaded tiles)
    this.id = "world3d";
    this.type = "custom";
    this.renderingMode = "3d";
  }

  /* ---------------- MapLibre custom layer interface */

  onAdd(map, gl) {
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.initScene();
  }

  /** Scene, geometry and materials: everything except the GL renderer. */
  initScene() {
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();
    // the street surface (pavement, kerb, asphalt) drawn as continuous shapes in its own layer,
    // under the route line: no tile seams, and the same at every zoom
    this.groundScene = new THREE.Scene();
    this.groundMeshes = {};
    const u = this.uniforms = {
      uLightDir: { value: new THREE.Vector3(0.4, -0.5, 0.75).normalize() },
      uLightCol: { value: new THREE.Color() }, uAmbient: { value: new THREE.Color() },
      uLampCol: { value: new THREE.Color() }, uInk: { value: new THREE.Color() },
      uTime: { value: 0 }, uNight: { value: 1 }, uOutline: { value: 0 }, uFade: { value: 0 },
      uViewport: { value: new THREE.Vector2(1, 1) }, uSunOff: { value: new THREE.Vector2(0, 0) },
      uShadowCol: { value: new THREE.Color() }, uShadowA: { value: 0.3 },
      uFogCol: { value: new THREE.Color() }, uFog: { value: new THREE.Vector2(1e6, 2e6) },
      uRise: { value: 0 }, uSky: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
    };
    const withOutline = (o) => ({ ...u, uOutline: { value: o } });
    this.geos = { person: personGeometry(), car: carGeometry(), lamp: lampGeometry(), tree: treeGeometry(),
                  beam: part(new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5), 0), boat: boatGeometry(), ...propGeometries() };
    const flat = (key) => new THREE.ShaderMaterial({
      uniforms: { uCol: { value: new THREE.Color(PALETTES.night[key]) } },
      vertexShader: "void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: "uniform vec3 uCol; void main() { gl_FragColor = vec4(uCol, 1.0); }",
      depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.groundMats = { pave: flat("pavement"), kerb: flat("kerb"), asph: flat("asphalt") };
    this.deckMat = new THREE.ShaderMaterial({ uniforms: this.groundMats.asph.uniforms,
      vertexShader: "void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: "uniform vec3 uCol; void main() { gl_FragColor = vec4(uCol, 1.0); }",
      side: THREE.DoubleSide });
    this.mats = {
      person: toonMaterial(PERSON_VS, u, false), personInk: toonMaterial(PERSON_VS, withOutline(0.03), true),
      car: toonMaterial(CAR_VS, u, false, CAR_FS, CAR_VARYINGS), carInk: toonMaterial(CAR_VS, withOutline(0.035), true, null, CAR_VARYINGS),
      lamp: toonMaterial(LAMP_VS, u, false), lampInk: toonMaterial(LAMP_VS, withOutline(0.03), true),
      tree: toonMaterial(TREE_VS, u, false), treeInk: toonMaterial(TREE_VS, withOutline(0.07), true),
      beam: toonMaterial(BEAM_VS, u, false), beamInk: toonMaterial(BEAM_VS, withOutline(0.06), true),
      boat: toonMaterial(BOAT_VS, u, false), boatInk: toonMaterial(BOAT_VS, withOutline(0.06), true),
      prop: toonMaterial(PROP_VS, u, false), propInk: toonMaterial(PROP_VS, withOutline(0.025), true),
      cross: new THREE.ShaderMaterial({ uniforms: u, vertexShader: CROSS_VS, fragmentShader: CROSS_FS,
        transparent: true, depthWrite: false, side: THREE.DoubleSide }),
      // the street surface is a flat map underneath the 3D, so it hides nothing: an invisible plane
      // writes ground depth (anything below street level is hidden), except over the cuttings,
      // whose footprints are stamped into the stencil buffer first
      cutMask: new THREE.ShaderMaterial({ vertexShader: CUT_VS, fragmentShader: "void main() { gl_FragColor = vec4(0.0); }",
        colorWrite: false, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
        stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc,
        stencilZPass: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilFail: THREE.ReplaceStencilOp }),
      groundDepth: new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
        stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc,
        stencilZPass: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilFail: THREE.KeepStencilOp }),
      mark: new THREE.ShaderMaterial({ uniforms: u, vertexShader: MARK_VS, fragmentShader: MARK_FS,
        transparent: true, depthWrite: false, side: THREE.DoubleSide }),   // paint has no back face to cull
      building: new THREE.ShaderMaterial({ uniforms: u, vertexShader: BLDG_VS, fragmentShader: BLDG_FS }),
      bean: new THREE.ShaderMaterial({ uniforms: u, vertexShader: BEAN_VS, fragmentShader: BEAN_FS }),
      pool: new THREE.ShaderMaterial({ uniforms: u, vertexShader: POOL_VS, fragmentShader: POOL_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      shadow: new THREE.ShaderMaterial({ uniforms: u, vertexShader: SHADOW_VS, fragmentShader: SHADOW_FS,
        transparent: true, depthWrite: false }),
      halo: new THREE.ShaderMaterial({ uniforms: u, vertexShader: HALO_VS, fragmentShader: HALO_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    };
    this.meshes = {};
    this.beanGeo = beanGeometry();
    this.setMode(this.mode, this.sun);
    this.lastT = performance.now();
  }

  render(gl, args) {
    const map = this.map;
    const zoom = map.getZoom();
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    this.time += dt;

    // background build work, inside a frame budget (bigger while the loader is up)
    if (this.job) this.stepJob(this.ready ? 6 : 40);

    const targetFade = zoom >= MIN_ZOOM + 0.4 ? 1 : 0;
    this.fade += (targetFade - this.fade) * Math.min(1, dt * 4);
    if (zoom < MIN_ZOOM || !this.frame) return;
    this.trackPerf(dt);
    this.rise = Math.min(1, this.rise + dt * 1.6);

    if (this.walker) this.walker.update(dt);
    this.updateAgents(dt);

    this.setCamera(args);

    const u = this.uniforms;
    u.uTime.value = this.time;
    u.uFade.value = this.fade;
    u.uRise.value = 1 - (1 - this.rise) ** 3;
    const c = map.getCanvas();
    u.uViewport.value.set(c.width, c.height);
    // fog in clip-space w (pixels): convert metres with the metres-per-pixel at the centre
    const mpp = (40075016.686 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / (512 * 2 ** zoom);
    u.uFog.value.set(780 / mpp, BLDG_FAR / mpp);
    // ink outlines are sub-pixel when zoomed out: skip their vertex work there
    const ink = zoom >= 17.3 || !!this.walker;
    for (const k of ["peopleInk", "carsInk", "treesInk", "lStructureInk", "trainsInk", "boatsInk", "parkedInk"]) {
      if (this.meshes[k]) this.meshes[k].visible = ink && (k.startsWith("people") || k.startsWith("cars") ? this.agentsOn : true);
    }
    const close = zoom >= 17.5 || !!this.walker;
    if (this.meshes.crossings) this.meshes.crossings.visible = zoom >= 15.5;
    if (this.meshes.markings) this.meshes.markings.visible = zoom >= 15.5;
    for (const kind of ["hydrant", "bench", "bin"]) {
      if (this.meshes["prop_" + kind]) { this.meshes["prop_" + kind].visible = close; this.meshes["prop_" + kind + "Ink"].visible = close; }
    }
    const bv = zoom >= BLDG_ZOOM && this.buildingsOn;
    if (this.meshes.buildings) this.meshes.buildings.visible = bv;
    if (this.meshes.bean) this.meshes.bean.visible = bv;

    this.renderer.resetState();
    this.renderer.clearStencil();                      // our own stencil use: the ground openings
    this.renderer.render(this.scene, this.camera);
    if (!this.ready && this.state && ++this._readyFrames > 2) { this.ready = true; this.onProgress && this.onProgress("ready", 1); }
  }

  /** Do our 3D buildings cover what the camera is looking at? */
  coversView() {
    if (!this.frame || !this.meshes.buildings || !this.buildingsOn) return false;
    const c = this.map.getCenter();
    const [x, y] = this.frame.toLocal(c.lng, c.lat);
    return Math.hypot(x, y) < BLDG_NEAR - 150;
  }

  /* ---------------- appearance */

  setMode(mode, sun) {
    this.mode = mode;
    this.sun = sun;
    if (this.groundMats) {
      const P = PALETTES[mode] || PALETTES.night;
      this.groundMats.pave.uniforms.uCol.value.set(P.pavement);
      this.groundMats.kerb.uniforms.uCol.value.set(P.kerb);
      this.groundMats.asph.uniforms.uCol.value.set(P.asphalt);
    }
    if (!this.uniforms) return;
    const L = LOOK[mode];
    const u = this.uniforms;
    u.uAmbient.value.setRGB(...L.ambient);
    u.uLightCol.value.setRGB(...L.light);
    u.uLampCol.value.setRGB(...L.lamp);
    u.uNight.value = mode === "night" ? 1 : 0;
    u.uShadowCol.value.set(L.shadow);
    u.uShadowA.value = L.shadowA;
    u.uInk.value.set(L.ink);
    u.uFogCol.value.set(L.fog);
    u.uSky.value.set(L.sky);
    u.uGround.value.set(L.ground);
    if (mode === "day" && sun && sun.altitude > 0.02) {
      const b = (sun.bearing * Math.PI) / 180, alt = sun.altitude;
      u.uLightDir.value.set(Math.sin(b) * Math.cos(alt), Math.cos(b) * Math.cos(alt), Math.sin(alt)).normalize();
      const len = Math.min(3, 1 / Math.tan(Math.max(alt, 0.18)));
      u.uSunOff.value.set(-Math.sin(b) * len, -Math.cos(b) * len);
    } else {
      u.uLightDir.value.set(-0.35, 0.45, 0.82).normalize();   // a high moon
      u.uSunOff.value.set(0, 0);
    }
    const night = mode === "night";
    if (this.meshes.pools) this.meshes.pools.visible = night;
    if (this.meshes.halos) this.meshes.halos.visible = night;
    if (this.meshes.carPools) this.meshes.carPools.visible = night && this.agentsOn;
    if (this.meshes.treeShadows) this.meshes.treeShadows.visible = !night;
    this.map.triggerRepaint();
  }

  setReports(reports) { this.reports = reports; this.rebuild(true); }
  setReportFilter(open, resolved) { this.showOpen = open; this.showResolved = resolved; this.rebuild(true); }
  setBuildings(on) { this.buildingsOn = on; this.map.triggerRepaint(); }
  setAgents(on) {
    this.agentsOn = on;
    for (const k of ["people", "peopleInk", "cars", "carsInk", "agentShadows"]) if (this.meshes[k]) this.meshes[k].visible = on;
    if (this.meshes.carPools) this.meshes.carPools.visible = on && this.mode === "night";
    this.map.triggerRepaint();
  }

  wantsFrames() {
    if (this.job) return true;
    const z = this.map.getZoom();
    if (!this.frame || z < MIN_ZOOM) return false;
    const fading = Math.abs(this.fade - (z >= MIN_ZOOM + 0.4 ? 1 : 0)) > 0.01 || this.rise < 1;
    return fading || !!this.walker || this.agentsOn || (this.mode === "night" && this.flickerCount > 0);
  }

  /* ---------------- adaptive quality: if frames get slow, thin the crowd and the pixels */

  trackPerf(dt) {
    const p = (this._perf = this._perf || { sum: 0, n: 0 });
    if (this.job) return;               // build work isn't the steady state
    p.sum += dt; p.n++;
    if (p.n < 120) return;
    const avg = p.sum / p.n;
    p.sum = 0; p.n = 0;
    if (avg > 1 / 40 && this.quality > 0.3) {
      this.quality = Math.max(0.3, this.quality * 0.65);
      this.trimAgents();
      if (this.onSlow) this.onSlow(this.quality);
    }
  }

  /* ---------------- neighbourhood build (time-sliced) */

  maybeRebuild() {
    if (this.job || this.loadingTiles || this.map.getZoom() < MIN_ZOOM - 0.3) return;
    const c = this.map.getCenter();
    if (this.frame) {
      const [x, y] = this.frame.toLocal(c.lng, c.lat);
      if (Math.hypot(x, y) < REBUILD_DIST) return;
    }
    this.rebuild(false, [c.lng, c.lat]);
  }

  rebuild(keepAnchor, center) {
    if (!this.uniforms) return;
    let anchor = center;
    if (keepAnchor || !anchor) {
      if (this.frame) anchor = [this.frame.lng, this.frame.lat];
      else { const c = this.map.getCenter(); anchor = [c.lng, c.lat]; }
    }
    const token = (this._buildToken = (this._buildToken || 0) + 1);
    const start = (tiles) => {
      if (token !== this._buildToken) return;
      this.loadingTiles = false;
      this.job = this.buildJob(anchor, tiles || null);
      this.map.triggerRepaint();
    };
    if (!this.tileUrl) { start(null); return; }      // until we know the tile URL, use MapLibre's tiles
    this.loadingTiles = true;
    this.loadTiles(anchor).then(start, () => start(null));
  }

  /** Fetch (or reuse) the z14 tiles covering the area around an anchor. */
  async loadTiles(anchor) {
    const Z = 14, n = 2 ** Z, lat0 = (anchor[1] * Math.PI) / 180;
    const dLat = TILE_R / 111320, dLng = TILE_R / (111320 * Math.cos(lat0));
    const tx = (lng) => Math.floor(((lng + 180) / 360) * n);
    const ty = (lat) => Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
    const x0 = tx(anchor[0] - dLng), x1 = tx(anchor[0] + dLng), y0 = ty(anchor[1] + dLat), y1 = ty(anchor[1] - dLat);
    const jobs = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = x + "/" + y;
      const hit = this.tileCache.get(key);
      if (hit) { jobs.push(Promise.resolve(hit)); continue; }
      const url = this.tileUrl.replace("{z}", Z).replace("{x}", x).replace("{y}", y);
      const surl = this.streetsUrl && this.streetsUrl.replace("{z}", Z).replace("{x}", x).replace("{y}", y);
      const streets = surl ? fetch(surl).then((r) => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null);
      jobs.push(Promise.all([fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status))), streets]).then(([buf, st]) => {
        const t = { x, y, vt: new VectorTile(new Pbf(new Uint8Array(buf))), streets: st };
        this.tileCache.set(key, t);
        if (this.tileCache.size > 30) this.tileCache.delete(this.tileCache.keys().next().value);
        return t;
      }).catch(() => null));                        // a missing tile (e.g. open lake) just isn't there
    }
    const tiles = (await Promise.all(jobs)).filter(Boolean);
    if (!tiles.length) throw new Error("no tiles");
    return tiles;
  }

  /** Features of one tile layer as GeoJSON (lng/lat), decoded inside the time budget. */
  *query(ctx, layer, keep) {
    if (!ctx.tiles) return this.map.querySourceFeatures("ofm", { sourceLayer: layer });
    const out = [];
    for (const t of ctx.tiles) {
      const L = t.vt.layers[layer];
      if (!L) continue;
      for (let i = 0; i < L.length; i++) {
        const f = L.feature(i);
        if (keep && !keep(f.properties)) continue;
        out.push({ id: f.id, properties: f.properties, geometry: f.toGeoJSON(t.x, t.y, 14).geometry });
        if ((i & 63) === 63 && this.late()) yield;
      }
    }
    return out;
  }

  stepJob(budgetMs) {
    const t0 = performance.now();
    this._deadline = t0 + budgetMs;
    try {
      while (performance.now() < this._deadline) {
        const r = this.job.next();
        if (r.done) { this.job = null; break; }
      }
    } catch (err) {
      console.warn("World build failed:", err);
      this.job = null;
    }
  }

  /** Inside build loops: time to hand the frame back? */
  late() { return performance.now() > this._deadline; }

  progress(label, f) { if (!this.ready && this.onProgress) this.onProgress(label, f); }

  *buildJob(anchor, tiles) {
    const frame = new LocalFrame(anchor[0], anchor[1]);
    const ctx = { frame, tiles };
    this.progress("Fetching the streets", 0.1);
    yield;
    yield* this.collectRoads(ctx);
    yield* this.buildOsm(ctx);
    if (!ctx.roads.length) return;               // tiles not loaded yet; idle will try again
    this.progress("Measuring the kerbs", 0.25);
    yield* this.buildSamples(ctx);
    this.progress("Finding the river", 0.34);
    yield* this.buildWater(ctx);
    this.progress("Planting the lamps", 0.4);
    yield* this.buildLamps(ctx);
    yield* this.buildTrees(ctx);
    yield* this.buildProps(ctx);
    yield* this.buildCrossings(ctx);
    yield* this.buildMarkings(ctx);
    this.progress("Raising the buildings", 0.55);
    yield* this.buildBuildings(ctx);
    this.progress("Bolting up the L", 0.78);
    yield* this.buildL(ctx);
    this.progress("Raising the bridges", 0.84);
    yield* this.buildBridges(ctx);
    yield* this.buildSignals(ctx);
    yield* this.buildParking(ctx);
    yield* this.buildObstacles(ctx);
    yield* this.buildGround(ctx);
    this.progress("Sending people out", 0.88);
    yield* this.prepareCrowd(ctx);
    yield* this.prepareMeshes(ctx);
    yield;
    this.commit(ctx);
  }

  *collectRoads(ctx) {
    const { frame } = ctx;
    const feats = yield* this.query(ctx, "transportation");
    yield;
    const roads = (ctx.roads = []);
    const rails = (ctx.rails = []);
    const R = AREA_R + 150, seenRoad = new Set();
    for (const f of feats) {
      if (this.late()) yield;
      const p = f.properties;
      const cls = p.class;
      // the L: elevated rapid-transit track
      if ((cls === "transit" || p.subclass === "subway" || p.subclass === "light_rail") && p.brunnel === "bridge") {
        const g = f.geometry;
        const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
        for (const line of lines) {
          const pts = [];
          let near = false;
          for (const [lng, lat] of line) {
            const [x, y] = frame.toLocal(lng, lat);
            pts.push(x, y);
            if (Math.abs(x) < BLDG_NEAR + 300 && Math.abs(y) < BLDG_NEAR + 300) near = true;
          }
          if (!near || pts.length < 4) continue;
          const cum = [0];
          for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
          if (cum[cum.length - 1] > 20) rails.push({ pts, cum, len: cum[cum.length - 1] });
        }
        continue;
      }
      if (cls === "ferry") {
        const g = f.geometry;
        const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
        for (const line of lines) {
          const r = toPath(line, frame, BLDG_NEAR + 600);
          if (r && r.len > 120) (ctx.waterRoutes = ctx.waterRoutes || []).push({ ...r, kind: 0 });
        }
        continue;
      }
      const w = ROAD_WIDTH_M[cls];
      if (!w || p.brunnel === "tunnel" || cls === "track") continue;
      const g = f.geometry;
      const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
      for (const line of lines) {
        const pts = [];
        let near = false;
        for (const [lng, lat] of line) {
          const [x, y] = frame.toLocal(lng, lat);
          pts.push(x, y);
          if (Math.abs(x) < R && Math.abs(y) < R) near = true;
        }
        if (!near || pts.length < 4) continue;
        const cum = [0];
        for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
        const len = cum[cum.length - 1];
        if (len < 6) continue;
        // neighbouring tiles repeat the same piece of street in their buffers: keep one copy
        const dk = cls + Math.round(pts[0]) + "," + Math.round(pts[1]) + "," + Math.round(pts[pts.length - 2]) + "," + Math.round(pts[pts.length - 1]);
        if (seenRoad.has(dk)) continue;
        seenRoad.add(dk);
        roads.push({ cls, service: p.service, half: roadWidthM(cls, +p.oneway || 0) / 2, pts, cum, len, oneway: +p.oneway || 0, bridge: p.brunnel === "bridge",
          highway: cls === "motorway" || cls === "trunk",
          cars: ["primary", "secondary", "tertiary", "minor", "trunk", "motorway"].includes(cls) });
      }
    }
  }

  /** Real OSM street data (lanes, crossings, signals, railways), merged across tiles, in the local frame. */
  *buildOsm(ctx) {
    ctx.osm = null;
    if (!ctx.tiles || !ctx.tiles.some((t) => t.streets)) return;
    const f = ctx.frame, R = AREA_R + 200;
    const ways = new Map(), rails = new Map(), cross = new Map(), signals = new Map();
    for (const t of ctx.tiles) {
      if (!t.streets) continue;
      for (const w of t.streets.ways || []) ways.set(w[0], w);
      for (const r of t.streets.rails || []) rails.set(r[0], r);
      for (const c of t.streets.cross || []) cross.set(c[0] + "," + c[1], c);
      for (const s of t.streets.signals || []) signals.set(s[0] + "," + s[1], s);
    }
    yield;
    const path = (flat) => {
      const pts = [];
      let near = false;
      for (let i = 0; i < flat.length; i += 2) {
        const [x, y] = f.toLocal(flat[i], flat[i + 1]);
        pts.push(x, y);
        if (Math.abs(x) < R && Math.abs(y) < R) near = true;
      }
      if (!near || pts.length < 4) return null;
      const cum = [0];
      for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
      return { pts, cum, len: cum[cum.length - 1] };
    };
    const osm = { ways: [], rails: [], cross: [], signals: [] };
    for (const w of ways.values()) {
      const p = path(w[6]);
      if (!p || p.len < 4) continue;
      // highways are as wide as their lanes (3.7 m each plus shoulders); a ramp is one lane unless
      // OSM says more, and never narrower than the 2D map draws it, so the two always line up
      const hwy = w[1] === "motorway" || w[1] === "trunk", link = !!w[11];
      const half = hwy ? Math.max(link ? ROAD_WIDTH_M[w[1]] * 0.45 : roadWidthM(w[1], w[5]),
                                  (w[2] || (link ? 1 : 0)) * 3.7 + (link ? 1.5 : 2.4)) / 2 : roadWidthM(w[1], w[5]) / 2;
      osm.ways.push({ ...p, id: w[0], cls: w[1], lanes: w[2], fwd: w[3], bwd: w[4], oneway: w[5],
        bridge: !!w[7], layer: w[8] || 0, n0: w[9], n1: w[10], half, link, highway: hwy });
      if (this.late()) yield;
    }
    for (const r of rails.values()) {
      const p = path(r[2]);
      if (!p || p.len < 3) continue;
      // tunnels (out of sight) and open cuttings below the street (layer < 0) stay in the line:
      // the track ramps down into a cutting and disappears into a tunnel mouth instead of just ending
      const under = r[4] ? 2 : (r[5] || 0) < 0 || r[9] ? 1 : 0;
      osm.rails.push({ ...p, id: r[0], kind: r[1], bridge: !r[4] && !!r[3], layer: r[5] || 0, n0: r[6], n1: r[7],
                       embankment: !!r[8], under });
    }
    for (const c of cross.values()) {
      const [x, y] = f.toLocal(c[0], c[1]);
      if (Math.abs(x) > AREA_R || Math.abs(y) > AREA_R) continue;
      osm.cross.push({ x, y, h: (c[2] * Math.PI) / 180, cls: c[3], kind: c[4] });
    }
    for (const s of signals.values()) {
      const [x, y] = f.toLocal(s[0], s[1]);
      if (Math.abs(x) < AREA_R && Math.abs(y) < AREA_R) osm.signals.push({ x, y });
    }
    yield;
    const bg = new Map(), BC = 10;
    for (const r of ctx.roads) {
      if (!r.bridge || r.highway) continue;
      for (let d = 0; d <= r.len; d += 2) {
        const q = pointAlong(r, d), k = Math.floor(q.x / BC) + "|" + Math.floor(q.y / BC);
        let a = bg.get(k);
        if (!a) bg.set(k, (a = []));
        a.push([q.x, q.y, r.half + 1.5]);
      }
    }
    ctx.overhead = (x, y) => {
      const gx = Math.floor(x / BC), gy = Math.floor(y / BC);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const [qx, qy, rr] of bg.get((gx + i) + "|" + (gy + j)) || []) if (Math.hypot(qx - x, qy - y) < rr) return true;
      }
      return false;
    };
    yield;
    osm.routes = chainRails(osm.rails, ctx.overhead);
    ctx.osm = osm;
    if (osm.ways.some((w) => w.highway)) {
      ctx.roads = ctx.roads.filter((r) => !r.highway);
      for (const w of osm.ways) {
        if (!w.highway) continue;
        w.road = { cls: w.cls, half: w.half, pts: w.pts, cum: w.cum, len: w.len, oneway: w.oneway || 1,
          bridge: w.bridge, layer: w.layer, n0: w.n0, n1: w.n1, highway: true, cars: true, osm: true, link: w.link };
        ctx.roads.push(w.road);
      }
    }
  }

  /** Samples every road every 3 m, grouped by 55 m data cell and by a 20 m search grid. */
  *buildSamples(ctx) {
    const { frame } = ctx;
    ctx.cellSamples = new Map();
    ctx.sampleGrid = new Map();
    const STEP = 3;
    let n = 0;
    for (const r of ctx.roads) {
      for (let d = STEP / 2; d < r.len; d += STEP) {
        const s = pointAlong(r, d);
        if (Math.abs(s.x) > AREA_R || Math.abs(s.y) > AREA_R) continue;
        const [lng, lat] = frame.toLngLat(s.x, s.y);
        const sample = { x: s.x, y: s.y, nx: -s.dy, ny: s.dx, half: r.half, road: r, d };
        if (r.cls !== "path") {
          const key = cellKey(lat, lng);
          let a = ctx.cellSamples.get(key);
          if (!a) ctx.cellSamples.set(key, (a = []));
          a.push(sample);
        }
        const gk = Math.floor(s.x / 20) + "|" + Math.floor(s.y / 20);
        let b = ctx.sampleGrid.get(gk);
        if (!b) ctx.sampleGrid.set(gk, (b = []));
        b.push(sample);
        if (this.late()) yield;
      }
    }
  }

  nearestSample(x, y, maxD = 40, grid = this.state && this.state.sampleGrid, filter) {
    if (!grid) return null;
    let best = null, bd = maxD;
    const gx = Math.floor(x / 20), gy = Math.floor(y / 20), span = Math.ceil(maxD / 20);
    for (let i = -span; i <= span; i++) for (let j = -span; j <= span; j++) {
      const list = grid.get((gx + i) + "|" + (gy + j));
      if (!list) continue;
      for (const s of list) {
        if (filter && !filter(s)) continue;
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < bd) { bd = d; best = s; }
      }
    }
    return best;
  }

  /** Is (x, y) inside the carriageway of any car road? Dual carriageways and
   *  crossing streets make a naive kerb offset land in traffic. */
  onRoadway(x, y, grid = this.state && this.state.sampleGrid) {
    if (!grid) return false;
    const gx = Math.floor(x / 20), gy = Math.floor(y / 20);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const list = grid.get((gx + i) + "|" + (gy + j));
      if (!list) continue;
      for (const s of list) {
        if (!s.road.cars && s.road.cls !== "service") continue;
        const dx = x - s.x, dy = y - s.y;
        if (dx * dx + dy * dy < (s.half - 0.4) * (s.half - 0.4) + 2.25) {
          // distance across the road (not along it) decides it
          const across = Math.abs(dx * s.nx + dy * s.ny);
          if (across < s.half - 0.4 && Math.abs(dx * s.ny - dy * s.nx) < 1.8) return true;
        }
      }
    }
    return false;
  }

  /** Which kerbs of a road can be walked without stepping into another carriageway (cached). */
  kerbOk(r, side, grid) {
    r.kerb = r.kerb || {};
    if (r.kerb[side] !== undefined) return r.kerb[side];
    const off = side * (r.cls === "path" ? 0.6 : r.half + 2.2);
    let bad = 0, n = 0;
    for (let d = 2; d < r.len; d += Math.max(4, r.len / 7)) {
      const q = pointAlong(r, d);
      n++;
      if (this.onRoadway(q.x - q.dy * off, q.y + q.dx * off, grid)) bad++;
    }
    return (r.kerb[side] = n === 0 || bad / n < 0.25);
  }

  areaCells(index, frame) {
    const [w, s] = frame.toLngLat(-AREA_R, -AREA_R);
    const [e, n] = frame.toLngLat(AREA_R, AREA_R);
    return index.query(s - CELL_DEG, n + CELL_DEG, w - CELL_DEG, e + CELL_DEG);
  }

  *buildLamps(ctx) {
    const posts = [];            // [x, y, heading, flickerPhase, headX, headY]
    const hash = new Map();
    const S = LAMP_SPACING_MIN;
    const tooClose = (x, y) => {
      const gx = Math.floor(x / S), gy = Math.floor(y / S);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const p of hash.get((gx + i) + "|" + (gy + j)) || []) if (Math.hypot(p[0] - x, p[1] - y) < S) return true;
      }
      return false;
    };
    const add = (s, side, phase) => {
      if (s.road.deck) return false;
      const off = s.half + 0.9;
      let x = s.x + s.nx * off * side, y = s.y + s.ny * off * side;
      if (this.onRoadway(x, y, ctx.sampleGrid)) {
        side = -side;
        x = s.x + s.nx * off * side; y = s.y + s.ny * off * side;
        if (this.onRoadway(x, y, ctx.sampleGrid)) return false;
      }
      if (tooClose(x, y)) return false;
      const heading = Math.atan2(-s.nx * side, -s.ny * side);   // arm reaches back over the road
      const p = [x, y, heading, phase, x + Math.sin(heading) * LAMP_HEAD.y, y + Math.cos(heading) * LAMP_HEAD.y];
      const k = Math.floor(x / S) + "|" + Math.floor(y / S);
      let a = hash.get(k);
      if (!a) hash.set(k, (a = []));
      a.push(p);
      posts.push(p);
      return true;
    };
    // outage reports first, so a flickering lamp wins its spot
    let flicker = 0;
    for (const r of this.reports) {
      if (this.late()) yield;
      if (r.open ? !this.showOpen : !this.showResolved) continue;
      const [x, y] = ctx.frame.toLocal(r.lng, r.lat);
      if (Math.abs(x) > AREA_R || Math.abs(y) > AREA_R) continue;
      const s = this.nearestSample(x, y, 35, ctx.sampleGrid, (q) => q.road.cls !== "path");
      if (!s) continue;
      const side = (x - s.x) * s.nx + (y - s.y) * s.ny >= 0 ? 1 : -1;
      if (add(s, side, r.open ? Math.random() : -1) && r.open) flicker++;
    }
    // each data cell gets as many posts as it has known lamps, along its streets, alternating kerbs
    for (const cell of this.areaCells(this.lampIndex, ctx.frame)) {
      if (this.late()) yield;
      const samples = ctx.cellSamples.get(cellKey(cell[0], cell[1]));
      if (!samples || !samples.length) continue;
      const n = Math.min(cell[2], 10);
      for (let i = 0; i < n; i++) add(samples[Math.floor(((i + 0.5) * samples.length) / n)], i % 2 ? 1 : -1, -1);
    }
    ctx.posts = posts;
    ctx.lampHash = hash;
    ctx.flickerCount = flicker;
    // paint every working lamp's light into a 4 m grid: lookups become one array read
    const C = LIGHT_CELL, n = Math.ceil((2 * AREA_R) / C) + 1;
    const grid = new Float32Array(n * n);
    const span = Math.ceil(LAMP_R / C);
    for (const p of posts) {
      if (p[3] >= 0) continue;                 // broken lamps light nothing
      const gx = Math.round((p[4] + AREA_R) / C), gy = Math.round((p[5] + AREA_R) / C);
      for (let j = Math.max(0, gy - span); j <= Math.min(n - 1, gy + span); j++) {
        for (let i = Math.max(0, gx - span); i <= Math.min(n - 1, gx + span); i++) {
          const d = Math.hypot(i * C - AREA_R - p[4], j * C - AREA_R - p[5]);
          if (d < LAMP_R) grid[j * n + i] += (1 - d / LAMP_R) ** 2;
        }
      }
      if (this.late()) yield;
    }
    ctx.light = { grid, n };
  }

  /** Warm light reaching a point from nearby working lamps (0..1). */
  lampLightAt(x, y, light = this.state && this.state.light) {
    if (!light) return 0;
    const i = Math.round((x + AREA_R) / LIGHT_CELL), j = Math.round((y + AREA_R) / LIGHT_CELL);
    if (i < 0 || j < 0 || i >= light.n || j >= light.n) return 0;
    return Math.min(1, light.grid[j * light.n + i]);
  }

  *buildTrees(ctx) {
    const trees = [];
    const taken = new Set();
    for (const cell of this.areaCells(this.treeIndex, ctx.frame)) {
      if (this.late()) yield;
      const samples = ctx.cellSamples.get(cellKey(cell[0], cell[1]));
      if (!samples || !samples.length) continue;
      const n = Math.max(1, Math.min(7, Math.round(cell[2] / 3)));
      for (let i = 0; i < n; i++) {
        const s = samples[Math.floor(((i + 0.37) * samples.length) / n)];
        const side = i % 2 ? -1 : 1;
        const off = s.half + 3.2;
        if (s.road.deck || s.road.highway) continue;
        const x = s.x + s.nx * off * side, y = s.y + s.ny * off * side;
        if (this.onRoadway(x, y, ctx.sampleGrid)) continue;
        const k = Math.round(x / 6) + "|" + Math.round(y / 6);
        if (taken.has(k)) continue;
        taken.add(k);
        trees.push([x, y, Math.random() * 6.283, 0.75 + Math.random() * 0.55]);
      }
    }
    ctx.trees = trees;
  }

  /** Zebra crossings: wherever two or more car streets meet, a crossing on each arm, set back from the junction. */
  *buildCrossings(ctx) {
    const nodes = new Map();
    for (const r of ctx.roads) {
      if (!r.cars || r.deck || r.highway) continue;
      const n = r.pts.length / 2;
      for (let i = 0; i < n; i++) {
        const x = r.pts[2 * i], y = r.pts[2 * i + 1];
        if (Math.abs(x) > AREA_R || Math.abs(y) > AREA_R) continue;
        const k = Math.round(x / 2) + "|" + Math.round(y / 2);
        let a = nodes.get(k);
        if (!a) nodes.set(k, (a = []));
        a.push([r, i]);
      }
      if (this.late()) yield;
    }
    const out = [], seen = new Set();
    const junctions = new Map();
    for (const arms of nodes.values()) {
      if (arms.length < 2) continue;
      // the directions leading out of this point, merging arms that point the same way: a street split
      // into pieces (or carried twice by neighbouring tiles) is one direction, not a junction
      const dirs = [];
      for (const [r, i] of arms) {
        for (const sg of [1, -1]) {
          const d0 = r.cum[i];
          if (sg > 0 ? d0 > r.len - 3 : d0 < 3) continue;          // the road ends here in that direction
          const q = pointAlong(r, d0 + sg * 3);
          const ang = Math.atan2(q.x - r.pts[2 * i], q.y - r.pts[2 * i + 1]);
          // how much street there is before the next junction-ish point: short stubs get no crossing
          const room = sg > 0 ? r.len - d0 : d0;
          const same = dirs.find((o) => Math.abs(Math.atan2(Math.sin(o.ang - ang), Math.cos(o.ang - ang))) < 0.35);
          if (same) { if (r.half > same.r.half) { same.r = r; same.i = i; same.sg = sg; } same.room = Math.max(same.room, room); }
          else dirs.push({ ang, r, i, sg, room });
        }
      }
      if (dirs.length < 3) continue;                              // a real intersection is a T or a cross, or more
      // Chicago paints zebras where an arterial is involved; quiet residential corners stay plain
      if (!dirs.some((o) => ARTERIAL_CLASSES.has(o.r.cls))) continue;
      const widest = Math.max(...dirs.map((o) => o.r.half));
      {
        const [r0, i0] = arms[0], jx = r0.pts[2 * i0], jy = r0.pts[2 * i0 + 1];
        const k = Math.floor(jx / 30) + "|" + Math.floor(jy / 30);
        let a = junctions.get(k);
        if (!a) junctions.set(k, (a = []));
        a.push([jx, jy, widest + 4.2]);                           // the box plus the crossing
      }
      const back = widest + 2.4;                                  // just outside the junction box
      for (const o of dirs) {
        if (o.room < back + 14) continue;                         // no zebra on a stub between two junctions
        // measured along the street itself: curved streets get the crossing on the road, square to it
        const d = o.r.cum[o.i] + o.sg * back;
        if (d < 1.6 || d > o.r.len - 1.6) continue;
        const sp = pointAlong(o.r, d);
        // square to the street's overall direction out of the junction (a 20 m chord), not a kink at one point
        const far = pointAlong(o.r, Math.max(0, Math.min(o.r.len, d + o.sg * 20)));
        const jx = o.r.pts[2 * o.i], jy = o.r.pts[2 * o.i + 1];
        const head = Math.atan2(far.x - jx, far.y - jy);
        const key = Math.round(sp.x / 6) + "|" + Math.round(sp.y / 6);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([sp.x, sp.y, head, o.r.half]);
      }
      if (this.late()) yield;
    }
    if (ctx.osm && ctx.osm.cross.length) {
      // real data: a crossing exactly where OSM maps a marked one, laid across the street it sits on
      out.length = 0;
      const KIND = { zebra: 0, ladder: 1, lines: 2, signals: 2, marked: 0 };
      for (const c of ctx.osm.cross) {
        if (c.cls === "motorway" || c.cls === "trunk") continue;
        out.push([c.x, c.y, c.h, (ROAD_WIDTH_M[c.cls] || 10) / 2, KIND[c.kind] || 0]);
      }
    }
    // a divided avenue is two one-way carriageways, each with its own junction: join their half-crossings
    // into one zebra that spans the whole road (parallel, side by side across the street, within ~24 m)
    const used = new Array(out.length).fill(false), merged = [];
    const real = !!(ctx.osm && ctx.osm.cross.length);        // real crossings are each their own; don't merge them
    for (let i = 0; i < out.length; i++) {
      if (real) { merged.push(out[i]); continue; }
      if ((i & 15) === 15 && this.late()) yield;
      if (used[i]) continue;
      let c = out[i].slice();
      for (let j = i + 1; j < out.length; j++) {
        if (used[j]) continue;
        const o = out[j];
        let dh = Math.abs(Math.atan2(Math.sin(o[2] - c[2]), Math.cos(o[2] - c[2])));
        dh = Math.min(dh, Math.PI - dh);
        if (dh > 0.26) continue;
        const rx = o[0] - c[0], ry = o[1] - c[1];
        const along = Math.abs(rx * Math.sin(c[2]) + ry * Math.cos(c[2]));
        const across = Math.abs(rx * Math.cos(c[2]) - ry * Math.sin(c[2]));
        if (along > 4 || across > 24 || across < 1) continue;
        // one crossing from the far kerb of one to the far kerb of the other
        c = [(c[0] + o[0]) / 2, (c[1] + o[1]) / 2, c[2], across / 2 + Math.max(c[3], o[3]), c[4] || 0];
        used[j] = true;
      }
      merged.push(c);
    }
    merged.sort((a, b) => b[3] - a[3]);
    const placed = [];
    const corners = (c) => {
      const ax = Math.cos(c[2]), ay = -Math.sin(c[2]), bx = Math.sin(c[2]), by = Math.cos(c[2]);   // across, along
      const hw = c[3] + 0.3, hd = 1.9;                                                             // + a small margin
      return [[c[0] + ax * hw + bx * hd, c[1] + ay * hw + by * hd], [c[0] - ax * hw + bx * hd, c[1] - ay * hw + by * hd],
              [c[0] - ax * hw - bx * hd, c[1] - ay * hw - by * hd], [c[0] + ax * hw - bx * hd, c[1] + ay * hw - by * hd]];
    };
    const overlap = (p, q) => {                       // separating-axis test for two rectangles
      for (const poly of [p, q]) for (let i = 0; i < 4; i++) {
        const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % 4], nx = y2 - y1, ny = x1 - x2;
        let pmin = Infinity, pmax = -Infinity, qmin = Infinity, qmax = -Infinity;
        for (const [x, y] of p) { const v = x * nx + y * ny; pmin = Math.min(pmin, v); pmax = Math.max(pmax, v); }
        for (const [x, y] of q) { const v = x * nx + y * ny; qmin = Math.min(qmin, v); qmax = Math.max(qmax, v); }
        if (pmax < qmin || qmax < pmin) return false;
      }
      return true;
    };
    for (let mi = 0; mi < merged.length; mi++) {
      const c = merged[mi];
      if ((mi & 15) === 15 && this.late()) yield;
      const box = corners(c);
      if (placed.some((o) => Math.abs(o.c[0] - c[0]) < 40 && Math.abs(o.c[1] - c[1]) < 40 && overlap(o.box, box))) continue;
      placed.push({ c, box });
    }
    ctx.crossings = placed.map((o) => o.c);
    ctx.junctions = junctions;
  }

  /** Painted lines: double yellow down two-way arterials, dashed white lane lines, a dashed line on one-ways. */
  *buildMarkings(ctx) {
    const pos = [], acr = [], offs = [];
    const inJunction = (x, y) => {
      const gx = Math.floor(x / 30), gy = Math.floor(y / 30);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const q of ctx.junctions.get((gx + i) + "|" + (gy + j)) || []) if (Math.hypot(q[0] - x, q[1] - y) < q[2]) return true;
      }
      return false;
    };
    // one painted quad from distance d0 to d1 along road r, offset sideways, w wide
    const painted = new Set();
    const strip = (r, d0, d1, off, w, yellow) => {
      const a = pointAlong(r, d0), b = pointAlong(r, d1);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      // highways run straight through: only street junction boxes stay unpainted
      if (Math.abs(mx) > MARK_R || Math.abs(my) > MARK_R || (!r.highway && inJunction(mx, my))) return;
      // the same paint from an overlapping copy of the street: once is enough
      const nx = -(a.dy + b.dy) / 2, ny = (a.dx + b.dx) / 2;
      const deckOf = r.zAt ? r : r.road && r.road.zAt ? r.road : null;   // a deck above is not a copy of the street below
      const pk = Math.round((mx + nx * off) * 1.5) + "," + Math.round((my + ny * off) * 1.5) + "," + yellow + "," +
                 (deckOf ? Math.round(deckOf.zAt((d0 + d1) / 2)) : 0);
      if (painted.has(pk)) return;
      painted.add(pk);
      const na = [-a.dy, a.dx], nb = [-b.dy, b.dx];
      const pa0 = [a.x + na[0] * (off - w / 2), a.y + na[1] * (off - w / 2)], pa1 = [a.x + na[0] * (off + w / 2), a.y + na[1] * (off + w / 2)];
      const pb0 = [b.x + nb[0] * (off - w / 2), b.y + nb[1] * (off - w / 2)], pb1 = [b.x + nb[0] * (off + w / 2), b.y + nb[1] * (off + w / 2)];
      const deck = r.zAt ? r : r.road && r.road.zAt ? r.road : null;
      const za = deck ? deck.zAt(d0) + 0.22 : 0.035, zb = deck ? deck.zAt(d1) + 0.22 : 0.035;   // clear of the deck surface
      // centre-line points for the offset (the strip's middle at a and b)
      const ca = [a.x + na[0] * off, a.y + na[1] * off], cb = [b.x + nb[0] * off, b.y + nb[1] * off];
      for (const [p, s, ctr, Z] of [[pa0, -1, ca, za], [pa1, 1, ca, za], [pb1, 1, cb, zb], [pa0, -1, ca, za], [pb1, 1, cb, zb], [pb0, -1, cb, zb]]) {
        pos.push(p[0], p[1], Z);
        acr.push(s, yellow);
        offs.push(p[0] - ctr[0], p[1] - ctr[1]);
      }
    };
    if (ctx.osm && ctx.osm.ways.length) {
      // real data: split each street's width into its mapped lanes; double yellow only between
      // opposing directions; quiet residential streets stay unpainted unless OSM says otherwise
      const DEF = { motorway: 3, trunk: 4, primary: 4, secondary: 4, tertiary: 2, minor: 2 };
      for (const w of ctx.osm.ways) {
        if (w.len < 8 || (w.bridge && !(w.road && w.road.deck))) continue;   // other bridges: no paint
        if (w.cls === "minor" && !(w.lanes >= 3) && !(w.oneway && w.lanes >= 2)) continue;
        if (this.late()) yield;
        const half = w.half, L = Math.max(1, w.lanes || (w.link ? 1 : DEF[w.cls] || 2));
        const dash = (off) => { for (let d = 2; d < w.len - 3; d += 12) strip(w, d, d + 3, off, 0.13, 0); };
        if (w.oneway) {
          const lw = (2 * half) / L;
          for (let k = 1; k < L; k++) dash(-half + k * lw);
          if (w.highway) {
            // freeway edge lines: solid white on the right, solid yellow on the left (US)
            const sg = w.oneway < 0 ? -1 : 1;
            // a ramp's edge lines stop short of where it merges into (or leaves) the through lanes
            const d0 = w.link ? Math.min(50, w.len * 0.3) : 0, d1 = w.link ? w.len - Math.min(50, w.len * 0.3) : w.len;
            for (let d = d0; d < d1; d += 6) {
              const e = Math.min(d1, d + 6.05);
              strip(w, d, e, sg * (-half + 0.35), 0.15, 0);
              strip(w, d, e, sg * (half - 0.35), 0.15, 1);
            }
          }
        } else {
          let F = w.fwd || Math.ceil(L / 2), B = w.bwd || Math.max(1, L - F);
          const lw = (2 * half) / (F + B), x0 = -half + F * lw;   // forward lanes on the right (US)
          for (let d = 0; d < w.len; d += 6) {
            const e = Math.min(w.len, d + 6.05);
            strip(w, d, e, x0 + 0.17, 0.12, 1);
            strip(w, d, e, x0 - 0.17, 0.12, 1);
          }
          for (let k = 1; k < F; k++) dash(-half + k * lw);
          for (let k = 1; k < B; k++) dash(x0 + k * lw);
        }
      }
    }
    const ARTERIAL = new Set(["trunk", "primary", "secondary", "tertiary"]);
    for (const r of (ctx.osm && ctx.osm.ways.length ? [] : ctx.roads)) {
      if (!r.cars || r.deck || r.len < 8) continue;
      if (this.late()) yield;
      const arterial = ARTERIAL.has(r.cls);
      if (arterial && !r.oneway) {
        // double yellow, continuous: one strip per ~6 m so it follows curves
        for (let d = 0; d < r.len; d += 6) {
          const e = Math.min(r.len, d + 6.05);
          strip(r, d, e, 0.17, 0.12, 1);
          strip(r, d, e, -0.17, 0.12, 1);
        }
      }
      if (arterial) {
        // dashed white lines between lanes (~3.4 m each, a parking lane at the kerb): 3 m paint, 9 m gap
        const side = r.oneway ? 2 * r.half : r.half, lanes = Math.max(1, Math.round((side - 2.4) / 3.4));
        const lw = (side - 2.4) / lanes, x0 = r.oneway ? -r.half + 1.2 : 0;
        for (let d = 2; d < r.len - 3; d += 12) {
          for (let k = 1; k < lanes; k++) {
            if (r.oneway) strip(r, d, d + 3, x0 + k * lw, 0.12, 0);
            else { strip(r, d, d + 3, k * lw, 0.12, 0); strip(r, d, d + 3, -k * lw, 0.12, 0); }
          }
        }
      } else if (r.highway && !r.deck) {
        for (let d = 2; d < r.len - 3; d += 12) {
          strip(r, d, d + 3, r.half / 3, 0.15, 0);
          strip(r, d, d + 3, -r.half / 3, 0.15, 0);
        }
      } else if (r.oneway && r.cls === "minor") {
        for (let d = 2; d < r.len - 3; d += 12) strip(r, d, d + 3, 0, 0.12, 0);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aAcross", new THREE.Float32BufferAttribute(acr, 2));
    g.setAttribute("aOff", new THREE.Float32BufferAttribute(offs, 2));
    ctx.markGeo = g;
  }

  /** Benches, bins and hydrants along the pavements near the anchor, clear of lamps, trees and traffic. */
  *buildProps(ctx) {
    const props = { hydrant: [], bench: [], bin: [] };
    const taken = [];
    for (const p of ctx.posts) taken.push([p[0], p[1]]);
    for (const t of ctx.trees) taken.push([t[0], t[1]]);
    const grid = new Map();
    const put = (x, y) => { const k = Math.floor(x / 10) + "|" + Math.floor(y / 10); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push([x, y]); };
    const near = (x, y, d) => {
      const gx = Math.floor(x / 10), gy = Math.floor(y / 10);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of grid.get((gx + i) + "|" + (gy + j)) || []) if (Math.hypot(q[0] - x, q[1] - y) < d) return true;
      return false;
    };
    taken.forEach(([x, y]) => put(x, y));
    for (const r of ctx.roads) {
      if (!r.cars || r.deck || r.highway || r.len < 20) continue;
      if (this.late()) yield;
      for (let d = 6 + Math.random() * 20; d < r.len - 4; d += 30 + Math.random() * 30) {
        const s = pointAlong(r, d);
        if (Math.hypot(s.x, s.y) > PROP_R) continue;
        const side = Math.random() < 0.5 ? 1 : -1, off = r.half + 2.4;
        const x = s.x - s.dy * off * side, y = s.y + s.dx * off * side;
        if (near(x, y, 3.5) || this.onRoadway(x, y, ctx.sampleGrid)) continue;
        put(x, y);
        const k = Math.random();
        const kind = k < 0.45 ? "hydrant" : k < 0.7 ? "bench" : "bin";
        // benches face the street; the rest just sit there
        const h = kind === "bench" ? Math.atan2(s.dy * side, -s.dx * side) : Math.random() * 6.283;
        props[kind].push([x, y, h]);
      }
    }
    ctx.props = props;
  }

  /** Footprints with real heights, extruded with facade coordinates; also a collision grid. */
  *buildBuildings(ctx) {
    const { frame } = ctx;
    const feats = yield* this.query(ctx, "building");
    yield;
    // de-duplicate the copies that neighbouring tiles carry in their buffers:
    // keep the largest piece per (feature id, polygon, base height)
    const byKey = new Map();
    const loose = [];
    let n = 0;
    for (const f of feats) {
      const p = f.properties;
      if (p.hide_3d) continue;
      const h = +p.render_height || 8, h0 = +p.render_min_height || 0;
      if (h - h0 < 2.5) continue;
      const g = f.geometry;
      const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
      for (let pi = 0; pi < polys.length; pi++) {
        const poly = polys[pi];
        if (this.late()) yield;
        const rings = poly.map((ring) => {
          const out = new Float64Array(ring.length * 2);
          ring.forEach(([lng, lat], i) => { const [x, y] = frame.toLocal(lng, lat); out[2 * i] = x; out[2 * i + 1] = y; });
          return out;
        });
        const outer = rings[0];
        let cx = 0, cy = 0;
        for (let i = 0; i < outer.length; i += 2) { cx += outer[i]; cy += outer[i + 1]; }
        cx /= outer.length / 2; cy /= outer.length / 2;
        const dist = Math.hypot(cx, cy);
        if (dist > BLDG_FAR || (dist > BLDG_NEAR && h < 14)) continue;
        const area = Math.abs(ringArea(outer));
        if (area < 12) continue;
        const b = { rings, h, h0, area, cx, cy, seed: hash01(f.id != null ? f.id : cx * 7.1 + cy * 3.3) };
        if (f.id != null) {
          const key = f.id + ":" + pi + ":" + h0;
          const prev = byKey.get(key);
          if (!prev || prev.area < area) byKey.set(key, b);
        } else loose.push(b);
      }
      if (this.late()) yield;
    }
    const list = [...byKey.values()];
    // id-less pieces: drop any whose centre falls inside an already accepted footprint of the same height
    if (loose.length) {
      const grid = new Map();
      const put = (b) => { const k = Math.floor(b.cx / 40) + "|" + Math.floor(b.cy / 40); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(b); };
      list.forEach(put);
      for (const b of loose) {
        const k = Math.floor(b.cx / 40), j = Math.floor(b.cy / 40);
        let dup = false;
        for (let di = -1; di <= 1 && !dup; di++) for (let dj = -1; dj <= 1 && !dup; dj++) {
          for (const o of grid.get((k + di) + "|" + (j + dj)) || []) {
            if (Math.abs(o.h - b.h) < 0.5 && pointInPoly(o.rings[0], b.cx, b.cy)) { dup = true; break; }
          }
        }
        if (!dup) { list.push(b); put(b); }
      }
    }
    yield;

    // count, allocate once, fill in slices
    let nv = 0, ni = 0;
    for (const b of list) {
      for (const r of b.rings) { const e = r.length / 2 - 1; nv += e * 4 + e + 1; ni += e * 6 + e * 3; }
    }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3);
    const fac = new Float32Array(nv * 4), bld = new Float32Array(nv * 3);
    const idx = new Uint32Array(ni);
    let v = 0, k = 0;
    const collide = new Map();
    const vert = (x, y, z, nx, ny, nz, f0, f1, f2, f3, b) => {
      pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
      nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz;
      fac[v * 4] = f0; fac[v * 4 + 1] = f1; fac[v * 4 + 2] = f2; fac[v * 4 + 3] = f3;
      bld[v * 3] = b.seed; bld[v * 3 + 1] = b.h; bld[v * 3 + 2] = b.h0;
      return v++;
    };
    n = 0;
    for (const b of list) {
      // walls: outer ring counter-clockwise, holes clockwise, so (dy, -dx) always faces out
      b.rings.forEach((ring, ri) => {
        const ccw = ringArea(ring) > 0;
        const flip = ri === 0 ? !ccw : ccw;
        const m = ring.length / 2 - 1;     // last point repeats the first
        let u = 0;
        for (let e = 0; e < m; e++) {
          const i0 = flip ? m - e : e, i1 = flip ? m - e - 1 : e + 1;
          const x0 = ring[2 * i0], y0 = ring[2 * i0 + 1], x1 = ring[2 * i1], y1 = ring[2 * i1 + 1];
          const L = Math.hypot(x1 - x0, y1 - y0) || 0.001;
          const nx = (y1 - y0) / L, ny = -(x1 - x0) / L;
          const a = vert(x0, y0, b.h0, nx, ny, 0, u, b.h0, 0, L, b);
          vert(x1, y1, b.h0, nx, ny, 0, u + L, b.h0, L, L, b);
          vert(x1, y1, b.h, nx, ny, 0, u + L, b.h, L, L, b);
          vert(x0, y0, b.h, nx, ny, 0, u, b.h, 0, L, b);
          idx[k++] = a; idx[k++] = a + 1; idx[k++] = a + 2; idx[k++] = a; idx[k++] = a + 2; idx[k++] = a + 3;
          u += L;
        }
      });
      // roof
      const contour = [], holes = [];
      b.rings.forEach((ring, ri) => {
        const pts = [];
        for (let i = 0; i < ring.length - 2; i += 2) pts.push(new THREE.Vector2(ring[i], ring[i + 1]));
        (ri === 0 ? contour : holes).push(...(ri === 0 ? pts : [pts]));
      });
      const all = contour.concat(...holes);
      const base = v;
      for (const p of all) vert(p.x, p.y, b.h, 0, 0, 1, p.x, p.y, 0, -1, b);
      try {
        for (const t of THREE.ShapeUtils.triangulateShape(contour, holes)) {
          if (k + 3 > idx.length) break;
          const p0 = all[t[0]], p1 = all[t[1]], p2 = all[t[2]];
          const up = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x) >= 0;   // face the sky
          idx[k++] = base + t[0]; idx[k++] = base + (up ? t[1] : t[2]); idx[k++] = base + (up ? t[2] : t[1]);
        }
      } catch (e) { /* a degenerate footprint: walls only */ }
      // collision grid (near buildings only)
      if (Math.hypot(b.cx, b.cy) < AREA_R && b.h0 < 2) {
        const r = b.rings[0];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < r.length; i += 2) {
          if (r[i] < minX) minX = r[i]; if (r[i] > maxX) maxX = r[i];
          if (r[i + 1] < minY) minY = r[i + 1]; if (r[i + 1] > maxY) maxY = r[i + 1];
        }
        const c = { pts: r, minX, minY, maxX, maxY };
        for (let i = Math.floor(minX / 25); i <= Math.floor(maxX / 25); i++) {
          for (let j = Math.floor(minY / 25); j <= Math.floor(maxY / 25); j++) {
            const key = i + "|" + j;
            let a = collide.get(key);
            if (!a) collide.set(key, (a = []));
            a.push(c);
          }
        }
      }
      if (this.late()) yield;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor.subarray(0, v * 3), 3));
    geo.setAttribute("aFacade", new THREE.BufferAttribute(fac.subarray(0, v * 4), 4));
    geo.setAttribute("aBld", new THREE.BufferAttribute(bld.subarray(0, v * 3), 3));
    geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, k), 1));
    ctx.buildingGeo = geo;
    ctx.collide = collide;
    ctx.buildingCount = list.length;
  }

  /** The L viaduct: deck girders, ties, columns and cap beams along each elevated track. */
  *buildL(ctx) {
    const beams = [];      // [x, y, heading, length, z0, z1, width, kind, slope]
    // real track (OSM) when we have it: every line, at its real height; otherwise the tiles' elevated L
    const real = !!(ctx.osm && ctx.osm.routes && ctx.osm.routes.length);
    const routes = real ? ctx.osm.routes : ctx.rails.map((r) => ({ ...r, L: true, zAt: () => 6.45, stAt: () => 1, mouths: [] }));
    ctx.railRoutes = routes;
    const PIECE = 10, COL = 16, NEAR = BLDG_NEAR + 300, RAILS_NEAR = 450;
    const cuts = (ctx.cuts = []);                         // footprints where the ground opens into a cutting
    // every street (bridged or not) within range, sampled every 3 m, for "is there a street over this?"
    const sg = new Map(), SC = 20, SNEAR = BLDG_NEAR + 340;
    let ns = 0;
    for (const r of ctx.roads) {
      if (r.deck) continue;
      for (let d = 1.5; d < r.len; d += 3) {
        const q = pointAlong(r, d);
        if (Math.abs(q.x) > SNEAR || Math.abs(q.y) > SNEAR) continue;
        const k = Math.floor(q.x / SC) + "|" + Math.floor(q.y / SC);
        let a = sg.get(k);
        if (!a) sg.set(k, (a = []));
        a.push([q.x, q.y, -q.dy, q.dx, r.cls === "path" ? 1.5 : r.half + 5.5]);   // + pavement + the cut wall
      }
      if ((++ns & 63) === 0 && this.late()) yield;
    }
    const underStreet = (x, y) => {
      const gx = Math.floor(x / SC), gy = Math.floor(y / SC);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const [qx, qy, nx, ny, wide] of sg.get((gx + i) + "|" + (gy + j)) || []) {
          const dx = x - qx, dy = y - qy;
          if (Math.abs(dx * nx + dy * ny) < wide && Math.abs(dx * ny - dy * nx) < 2.6) return true;
        }
      }
      return false;
    };
    const seen = new Set();
    for (const r of routes) {
      if (this.late()) yield;
      for (let d = 0; d < r.len; d += PIECE) {
        const l = Math.min(PIECE, r.len - d);
        if (l < 0.5) continue;
        const s = pointAlong(r, d + l / 2);
        if (Math.abs(s.x) > NEAR || Math.abs(s.y) > NEAR) continue;
        if (!real) {
          // neighbouring tiles carry duplicate copies of the same track: skip exact repeats
          const key = Math.round(s.x / 2) + "|" + Math.round(s.y / 2);
          if (seen.has(key)) continue;
          seen.add(key);
        }
        const h = Math.atan2(s.dx, s.dy), L = l + 0.25;
        const z = r.zAt(d + l / 2), st = r.stAt(d + l / 2), slope = (r.zAt(d + l) - r.zAt(d)) / l;
        if (st === 3) continue;                           // in the tunnel: nothing to see
        const street = st !== 4 && st !== 1 && underStreet(s.x, s.y);   // a street crosses here
        let top;
        if (st === 4) {
          // open cutting: ballast on the floor, retaining walls up to a parapet, and a hole in the ground
          beams.push([s.x, s.y, h, L, z - 0.05, z + 0.25, 3.4, 14, slope]);
          // under a street (bridged or not): the street is the roof, so no opening and no parapet there
          // walls and the ground opening in 2.5 m sections, each checked on its own, so they stop at the kerb
          for (let k = 0; k < 4; k++) {
            const dk = d + ((k + 0.5) * l) / 4, q = pointAlong(r, dk), hk = Math.atan2(q.dx, q.dy), zk = r.zAt(dk);
            const roofed = !!(ctx.overhead && ctx.overhead(q.x, q.y)) || underStreet(q.x, q.y)
              || underStreet(q.x + Math.cos(hk) * 2.75, q.y - Math.sin(hk) * 2.75) || underStreet(q.x - Math.cos(hk) * 2.75, q.y + Math.sin(hk) * 2.75);
            if (roofed) continue;                         // under a street: the street is the roof
            for (const sd of [-1, 1]) {
              beams.push([q.x + Math.cos(hk) * sd * 2.75, q.y - Math.sin(hk) * sd * 2.75, hk, l / 4 + 0.1, zk - 0.3, 1.25, 0.45, 15, slope]);
            }
            cuts.push([q.x, q.y, hk, l / 4 + 0.15, 5.1]);
          }
          top = z + 0.37;
        } else if ((st === 1 || street) && z > 2) {
          // viaduct: the L's green steel, or a concrete deck for the railroads (and wherever a street passes under an embankment: an open span, not a wall across the road)
          beams.push([s.x, s.y, h, L, z - 0.95, z, r.L ? 2.7 : 4.2, r.L ? 0 : 15, slope]);
          top = z + 0.2;
        } else if (street) {
          // level crossing: the street stays continuous, only the rails show, set flush into it
          for (const c of [-0.72, 0.72]) beams.push([s.x + Math.cos(h) * c, s.y - Math.sin(h) * c, h, L, 0.0, 0.09, 0.1, 16, 0]);
          continue;
        } else if (z > 0.3) {
          // embankment / incline: a solid wall up to the track bed
          beams.push([s.x, s.y, h, L, -0.4, z, r.L ? 3.4 : 4.6, 15, slope]);
          beams.push([s.x, s.y, h, L, z, z + 0.25, 3.2, 14, slope]);
          top = z + 0.37;
        } else {
          beams.push([s.x, s.y, h, L, -0.05, z + 0.25, 3.4, 14, slope]);     // ballast at street level
          top = z + 0.37;
        }
        beams.push([s.x, s.y, h, L, top - 0.15, top, 2.5, 1, slope]);        // sleepers
        if (Math.hypot(s.x, s.y) < RAILS_NEAR) {
          for (const c of [-0.72, 0.72]) beams.push([s.x + Math.cos(h) * c, s.y - Math.sin(h) * c, h, L, top, top + 0.14, 0.1, 16, slope]);
        }
      }
      // columns and cap beams under the viaduct
      for (let d = COL / 2; d < r.len; d += COL) {
        const z = r.zAt(d);
        if (r.stAt(d) !== 1 || z < 2.5) continue;
        const s = pointAlong(r, d);
        if (Math.abs(s.x) > NEAR || Math.abs(s.y) > NEAR) continue;
        if (!real) {
          const key = "c" + Math.round(s.x / 3) + "|" + Math.round(s.y / 3);
          if (seen.has(key)) continue;
          seen.add(key);
        }
        const h = Math.atan2(s.dx, s.dy), kind = r.L ? 0 : 15, cap = r.L ? 4 : 15;
        beams.push([s.x, s.y, h, r.L ? 0.55 : 1.0, 0, z - 0.95, r.L ? 0.55 : 1.0, kind]);
        beams.push([s.x, s.y, h + Math.PI / 2, r.L ? 3.6 : 4.6, z - 1.5, z - 0.95, 0.55, cap]);
      }
      // tunnel mouths: a concrete headwall across the cutting, with the dark opening facing it
      for (const m of r.mouths || []) {
        const s = pointAlong(r, m.d);
        if (Math.abs(s.x) > NEAR || Math.abs(s.y) > NEAR) continue;
        const h = Math.atan2(s.dx, s.dy), z = r.zAt(m.d), face = m.cutBefore ? -1 : 1;
        if (underStreet(s.x, s.y)) continue;              // a mouth under a street has no headwall above ground
        beams.push([s.x, s.y, h, 1.4, z - 0.5, 1.4, 6.4, 15]);
        beams.push([s.x + s.dx * face * 0.75, s.y + s.dy * face * 0.75, h, 0.12, z + 0.2, Math.min(z + 4.6, -0.3), 4.2, 1]);   // the dark opening
      }
    }

    // stations: railway POIs above ground, matched to the nearest elevated track
    const stations = [], lights = [], waiting = [];
    const pois = yield* this.query(ctx, "poi", (p) => p.class === "railway");
    yield;
    const named = new Set();
    for (const f of pois) {
      if (this.late()) yield;
      const p = f.properties;
      if (p.class !== "railway" || !["station", "subway", "halt"].includes(p.subclass)) continue;
      if (+p.level < 0 || !f.geometry || f.geometry.type !== "Point") continue;
      const [x, y] = ctx.frame.toLocal(f.geometry.coordinates[0], f.geometry.coordinates[1]);
      if (Math.hypot(x, y) > BLDG_NEAR + 250) continue;
      const key = (p.name || "") + "@" + Math.round(x / 80) + "|" + Math.round(y / 80);
      if (named.has(key)) continue;
      let best = null, bd = 45;
      for (const r of routes) {
        if (!r.L) continue;
        for (let d = 0; d <= r.len; d += 4) {
          const q = pointAlong(r, d);
          const dd = Math.hypot(q.x - x, q.y - y);
          if (dd < bd && r.stAt(d) === 1 && r.zAt(d) > 4) { bd = dd; best = q; best.z = r.zAt(d); }
        }
      }
      if (!best) continue;                       // at grade or underground: nothing to build up there
      named.add(key);
      // the station node usually sits between the tracks; fall back to the track if it's far off
      const cx = bd < 10 ? x : best.x, cy = bd < 10 ? y : best.y;
      const h = Math.atan2(best.dx, best.dy);
      stations.push({ x: cx, y: cy, h, name: p.name || "" });
      const dz = best.z - 6.45;                  // platforms sit at the track's real height
      const put = (a, c, len, z0, z1, w, kind, hh = h) => {
        beams.push([cx + Math.sin(h) * a + Math.cos(h) * c, cy + Math.cos(h) * a - Math.sin(h) * c, hh, len,
                    z0 > 0.01 ? z0 + dz : z0, z1 + dz, w, kind]);
      };
      put(0, 0, 100, 5.45, 6.4, 13, 5);                                  // platform deck
      for (const c of [-6.4, 6.4]) put(0, c, 100, 6.4, 7.45, 0.12, 0);   // railings
      for (const c of [-4.6, 4.6]) {
        put(0, c, 84, 9.3, 9.62, 3.6, 6);                                // canopy roof
        put(0, c, 80, 9.16, 9.3, 0.5, 7);                                // light strip
        for (let a = -40; a <= 40; a += 10) {
          put(a, c, 0.22, 6.4, 9.3, 0.22, 0);                            // canopy posts
          lights.push([cx + Math.sin(h) * a + Math.cos(h) * c, cy + Math.cos(h) * a - Math.sin(h) * c, 9.05 + dz]);
        }
      }
      for (const a of [-44, 44]) for (const c of [-8.8, 8.8]) {
        put(a, c, 8, 0, 6.4, 4.5, 8);                                    // stair / entrance tower
        put(a, c, 8.1, 2.2, 3.4, 4.6, 7);                                // its lit windows
        put(a, c, 8.6, 6.4, 6.75, 5.0, 6);                               // its roof
      }
      // people waiting on the platform
      const n = 8 + ((Math.random() * 10) | 0);
      for (let i = 0; i < n; i++) {
        const a = (Math.random() - 0.5) * 80, c = (Math.random() < 0.5 ? -1 : 1) * (3.6 + Math.random() * 2.2);
        waiting.push({ x: cx + Math.sin(h) * a + Math.cos(h) * c, y: cy + Math.cos(h) * a - Math.sin(h) * c, z: 6.4 + dz,
                       h: h + (c > 0 ? -Math.PI / 2 : Math.PI / 2) + (Math.random() - 0.5) * 0.8 });
      }
    }
    ctx.beams = beams;
    ctx.stations = stations;
    ctx.stationLights = lights;
    ctx.waiting = waiting;
  }

  /** Rivers, the lake, boat routes, and 3D steelwork for every road bridge over water. */
  *buildWater(ctx) {
    const f = ctx.frame;
    ctx.waterRoutes = ctx.waterRoutes || [];
    // water polygons, indexed for point-in-water tests
    const polys = [];
    const grid = new Map();
    const waters = yield* this.query(ctx, "water", (p) => p.class === "river" || p.class === "lake" || p.class === "ocean");
    for (const w of waters) {
      if (this.late()) yield;
      const cls = w.properties.class;
      if (cls !== "river" && cls !== "lake" && cls !== "ocean") continue;
      const g = w.geometry;
      const ps = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
      for (const poly of ps) {
        const ring = poly[0];
        const pts = new Float64Array(ring.length * 2);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < ring.length; i++) {
          const [x, y] = f.toLocal(ring[i][0], ring[i][1]);
          pts[2 * i] = x; pts[2 * i + 1] = y;
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
          if ((i & 511) === 511 && this.late()) yield;
        }
        if (maxX < -AREA_R * 1.6 || minX > AREA_R * 1.6 || maxY < -AREA_R * 1.6 || minY > AREA_R * 1.6) continue;
        const b = { pts, minX, minY, maxX, maxY, lake: cls !== "river" };
        polys.push(b);
        for (let i = Math.floor(Math.max(minX, -2000) / 100); i <= Math.floor(Math.min(maxX, 2000) / 100); i++) {
          for (let j = Math.floor(Math.max(minY, -2000) / 100); j <= Math.floor(Math.min(maxY, 2000) / 100); j++) {
            const k = i + "|" + j;
            let a = grid.get(k);
            if (!a) grid.set(k, (a = []));
            a.push(b);
          }
        }
      }
    }
    const inWater = (x, y) => {
      for (const b of grid.get(Math.floor(x / 100) + "|" + Math.floor(y / 100)) || []) {
        if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && pointInPoly(b.pts, x, y)) return b;
      }
      return null;
    };
    ctx.inWater = inWater;

    // the river itself: tour boats ply its centre lines
    const ways = yield* this.query(ctx, "waterway", (p) => p.class === "river" || p.class === "canal");
    for (const w of ways) {
      if (this.late()) yield;
      const p = w.properties;
      if ((p.class !== "river" && p.class !== "canal") || p.brunnel === "tunnel") continue;
      const g = w.geometry;
      const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
      for (const line of lines) {
        const r = toPath(line, f, BLDG_NEAR + 600);
        if (r && r.len > 200) ctx.waterRoutes.push({ ...r, kind: 1 });
      }
    }

    // highways: which bridge ways really pass over something (water, a street, a railway)?
    const passesOver = (r) => {
      for (let d = 2; d < r.len; d += 4) {
        const q = pointAlong(r, d);
        if (inWater(q.x, q.y)) return true;
        const gx = Math.floor(q.x / 20), gy = Math.floor(q.y / 20);
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
          for (const sm of ctx.sampleGrid.get((gx + i) + "|" + (gy + j)) || []) {
            if (sm.road === r || sm.road.bridge || sm.road.highway) continue;
            if (Math.hypot(sm.x - q.x, sm.y - q.y) > 3) continue;
            const cross = Math.abs(q.dx * sm.ny * -1 + q.dy * sm.nx);   // |sin| of the angle between them
            if (cross > 0.5) return true;                               // a real crossing, not a parallel road
          }
        }
      }
      for (const rl of (ctx.osm && ctx.osm.rails) || []) {
        if (rl.bridge || rl.under) continue;
        for (let d = 2; d < r.len; d += 6) {
          const q = pointAlong(r, d);
          for (let k = 0; k < rl.pts.length; k += 2) if (Math.abs(rl.pts[k] - q.x) < 4 && Math.abs(rl.pts[k + 1] - q.y) < 4) return true;
        }
      }
      return false;
    };
    const hwUp = new Set();
    for (const r of ctx.roads) if (r.highway && r.bridge && passesOver(r)) hwUp.add(r);
    yield;
    // whole viaducts: bridge ways connected end to end (by OSM node) to a raised one are raised too
    if (hwUp.size) {
      const byNode = new Map();
      for (const r of ctx.roads) {
        if (!(r.highway && r.bridge && r.osm)) continue;
        for (const n of [r.n0, r.n1]) { if (!n) continue; let a = byNode.get(n); if (!a) byNode.set(n, (a = [])); a.push(r); }
      }
      const queue = [...hwUp];
      while (queue.length) {
        const r = queue.pop();
        for (const n of [r.n0, r.n1]) for (const o of byNode.get(n) || []) if (!hwUp.has(o)) { hwUp.add(o); queue.push(o); }
      }
      // a short piece the map does not call a bridge, between two raised ones, is part of the viaduct
      const allHw = new Map();
      for (const r of ctx.roads) {
        if (!(r.highway && r.osm)) continue;
        for (const n of [r.n0, r.n1]) { if (!n) continue; let a = allHw.get(n); if (!a) allHw.set(n, (a = [])); a.push(r); }
      }
      for (let pass = 0; pass < 3; pass++) {
        for (const r of ctx.roads) {
          if (!(r.highway && r.osm) || hwUp.has(r) || r.len > 250 || !r.n0 || !r.n1) continue;
          const up = (n) => (allHw.get(n) || []).some((o) => o !== r && hwUp.has(o));
          if (up(r.n0) && up(r.n1)) hwUp.add(r);
        }
      }
      // a way's end ramps down only if no other raised bridge continues from it
      const raisedAt = new Map();
      for (const r of hwUp) for (const n of [r.n0, r.n1]) if (n) raisedAt.set(n, (raisedAt.get(n) || 0) + 1);
      for (const r of hwUp) {
        r.freeStart = !r.n0 || raisedAt.get(r.n0) < 2;
        r.freeEnd = !r.n1 || raisedAt.get(r.n1) < 2;
      }
      // where raised pieces meet, they meet at one height (the average of theirs): no steps between levels
      const hOf = (r) => 6.8 + Math.max(0, (r.layer || 1) - 1) * 6;
      const nodeH = new Map();
      for (const r of hwUp) {
        for (const n of [r.n0, r.n1]) {
          if (!n) continue;
          const a = nodeH.get(n) || [0, 0];
          a[0] += hOf(r); a[1]++;
          nodeH.set(n, a);
        }
      }
      const at = (n) => { const a = nodeH.get(n); return a ? a[0] / a[1] : 0; };
      for (const r of hwUp) {
        r.hStart = r.freeStart ? 0 : at(r.n0);
        r.hEnd = r.freeEnd ? 0 : at(r.n1);
      }
    }

    // bridge decks: road bridges over water, and highway viaducts over the city
    for (const r of ctx.roads) {
      if ((!r.bridge && !hwUp.has(r)) || r.cls === "service") continue;
      if (this.late()) yield;
      // a water bridge spans from land to land: paths along a pier (which sits in the lake) are not bridges
      let wet = false;
      if (!r.highway) {
        // over water somewhere along it, and reaching land just past each end (OSM bridge pieces stop
        // at the bank, which the water outline often overlaps): a path along a pier just runs on into lake
        let any = false;
        for (let d = 1; d < r.len && !any; d += 4) { const q = pointAlong(r, d); any = inWater(q.x, q.y); }
        if (any) {
          const landPast = (q, sx, sy) => {
            for (let e = 0; e <= 30; e += 3) if (!inWater(q.x + sx * e, q.y + sy * e)) return true;
            return false;
          };
          const a = pointAlong(r, 0), b = pointAlong(r, r.len);
          wet = landPast(a, -a.dx, -a.dy) && landPast(b, b.dx, b.dy);
        }
      }
      if (r.highway && !hwUp.has(r)) {
        // mapped as a bridge but nothing found under it: keep the carriageway, flat, with its barriers
        r.deck = true;
        r.zAt = () => 0.05;
        continue;
      }
      if (!r.highway && !wet) continue;                            // nothing underneath: no bridge
      const H = r.highway ? 6.8 + Math.max(0, (r.layer || 1) - 1) * 6 : r.cars ? 6.2 : 3.2, len = r.len;
      r.deck = true;
      if (r.highway) {
        // ramp only at the ends of the whole viaduct, never in the middle of it
        const R = Math.max(12, Math.min(90, len * 0.45)), fs = r.freeStart !== false, fe = r.freeEnd !== false;
        if (r.hStart === undefined) r.hStart = fs ? 0 : H;
        if (r.hEnd === undefined) r.hEnd = fe ? 0 : H;
        r.H = H;
        r.zAt = (d) => H + (r.hStart - H) * (1 - smooth(d / R)) + (r.hEnd - H) * (1 - smooth((len - d) / R));
      } else {
        const R = Math.max(6, Math.min(30, len * 0.42));
        r.zAt = (d) => { const t = Math.min(d, len - d) / R; return t >= 1 ? H : t <= 0 ? 0 : H * t * t * (3 - 2 * t); };
      }
    }

    // merges: a ramp usually joins a highway part-way along it, not at its end node. Any highway end
    // that touches another raised highway takes that road's height there, so ramps meet their
    // viaduct instead of diving under it (and a street-level ramp into a viaduct becomes a climb)
    {
      const decks = ctx.roads.filter((r) => r.highway && r.deck && r.zAt && r.H);
      const g = new Map(), C = 12;
      for (const o of decks) {
        for (let d = 0; d <= o.len; d += 3) {
          const q = pointAlong(o, d), k = Math.floor(q.x / C) + "|" + Math.floor(q.y / C);
          let a = g.get(k);
          if (!a) g.set(k, (a = []));
          a.push([q.x, q.y, o, d]);
        }
      }
      const meet = (r, x, y) => {
        let best = null, bd = 4;
        const gx = Math.floor(x / C), gy = Math.floor(y / C);
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
          for (const [qx, qy, o, d] of g.get((gx + i) + "|" + (gy + j)) || []) {
            if (o === r || d < 8 || d > o.len - 8) continue;      // end-to-end joins are handled by shared nodes
            const dd = Math.hypot(qx - x, qy - y);
            if (dd < bd) { bd = dd; best = [o, d]; }
          }
        }
        return best;
      };
      for (let pass = 0; pass < 2; pass++) {
        for (const r of ctx.roads) {
          if (!(r.highway && r.osm && r.link) || r.len < 20) continue;   // ramps only
          const a = meet(r, r.pts[0], r.pts[1]), b = meet(r, r.pts[r.pts.length - 2], r.pts[r.pts.length - 1]);
          if (!a && !b) continue;
          const za = a ? a[0].zAt(a[1]) : null, zb = b ? b[0].zAt(b[1]) : null;
          if (!r.deck) {
            // a street-level ramp running up into a viaduct: it becomes a deck that climbs to meet it
            if (Math.max(za || 0, zb || 0) < 1) continue;
            const len = r.len, R = Math.max(12, Math.min(90, len * 0.45)), H = Math.max(za || 0, zb || 0);
            r.deck = true;
            r.H = H;
            r.hStart = za !== null ? za : 0;
            r.hEnd = zb !== null ? zb : 0;
            r.zAt = (d) => r.H + (r.hStart - r.H) * (1 - smooth(d / R)) + (r.hEnd - r.H) * (1 - smooth((len - d) / R));
            hwUp.add(r);
            continue;
          }
          if (za !== null) r.hStart = za;
          if (zb !== null) r.hEnd = zb;
        }
      }
    }

    // lake: a few sailboats near the shore inside the area
    const lakeSpots = [];
    for (let tries = 0; tries < 400 && lakeSpots.length < 12; tries++) {
      if (this.late()) yield;
      const x = (Math.random() - 0.5) * 2 * (AREA_R + 500), y = (Math.random() - 0.5) * 2 * (AREA_R + 500);
      const b = inWater(x, y);
      if (b && b.lake) lakeSpots.push({ x, y });
    }
    ctx.lakeSpots = lakeSpots;
  }

  /** Solid bridges: roadway, sidewalks, fascia, railings, girders and tender houses, following each deck's arch. */
  *buildBridges(ctx) {
    const beams = ctx.beams, seen = new Set(), houses = [];
    const P = 4;
    // where two highway decks run side by side (a ramp merging), neither has a barrier on the other's lanes
    const hg = new Map(), HC = 12;
    for (const o of ctx.roads) {
      if (!o.highway) continue;                     // raised decks and highways at street level alike
      for (let d = 0; d <= o.len; d += 2) {
        const q = pointAlong(o, d), k = Math.floor(q.x / HC) + "|" + Math.floor(q.y / HC);
        let a = hg.get(k);
        if (!a) hg.set(k, (a = []));
        a.push([q.x, q.y, -q.dy, q.dx, o, d]);
      }
    }
    yield;
    const onOtherDeck = (r, x, y, z) => {
      const gx = Math.floor(x / HC), gy = Math.floor(y / HC);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const [qx, qy, nx, ny, o, d] of hg.get((gx + i) + "|" + (gy + j)) || []) {
          if (o === r) continue;
          const dx = x - qx, dy = y - qy;
          if (Math.abs(dx * ny - dy * nx) > 1.2 || Math.abs(dx * nx + dy * ny) > o.half - 0.2) continue;
          if (Math.abs((o.zAt ? o.zAt(d) : 0) - z) < 1.5) return true;
        }
      }
      return false;
    };
    for (const r of ctx.roads) {
      if (!r.deck) continue;
      if (this.late()) yield;
      const w = r.half;
      for (let d0 = 0; d0 < r.len; d0 += P) {
        const l = Math.min(P, r.len - d0);
        if (l < 0.4) continue;
        const s = pointAlong(r, d0 + l / 2);
        const key = Math.round(s.x / 2) + "|" + Math.round(s.y / 2);
        if (seen.has(key)) continue;                 // neighbouring tiles carry copies of the same bridge
        seen.add(key);
        const z = r.zAt(d0 + l / 2), slope = (r.zAt(d0 + l) - r.zAt(d0)) / l;
        const h = Math.atan2(s.dx, s.dy), L = l + 0.15;
        const at = (off) => [s.x + Math.cos(h) * off, s.y - Math.sin(h) * off];
        const put = (off, z0, z1, width, kind, sl) => {
          const [x, y] = at(off);
          const pier = z0 === 0;
          beams.push([x, y, h, pier ? 1.3 : L, z0, z1, width, kind, pier ? 0 : sl === undefined ? slope : sl]);
        };
        if (r.highway) {
          put(0, z - 0.9, z, 2 * w + 1.4, 12);                             // roadway slab
          for (const sd of [-1, 1]) {
            const [bx, by] = at(sd * (w + 0.55));
            if (!onOtherDeck(r, bx, by, z)) put(sd * (w + 0.55), z - 1.2, z + 0.85, 0.35, 10);   // concrete barrier
          }
          if (z > 2.5 && Math.floor((d0 + l / 2) / 25) !== Math.floor((d0 + l / 2 - P) / 25)) {
            for (const sd of [-1, 1]) put(sd * w * 0.45, 0, z - 0.9, 1.3, 10);           // a pier pair every 25 m
            put(0, z - 1.6, z - 0.9, 2 * w * 0.9, 10, slope);                            // pier cap
          }
          continue;
        }
        if (!r.cars) {
          // a footbridge: a slim deck and two railings, nothing more
          put(0, z - 0.45, z, 2 * w + 0.8, 13);
          for (const sd of [-1, 1]) put(sd * (w + 0.35), z, z + 1.1, 0.08, 11);
          continue;
        }
        put(0, z - 0.55, z, 2 * w, 12);                                    // roadway
        for (const sd of [-1, 1]) {
          put(sd * (w + 1.4), z - 0.55, z + 0.18, 2.8, 13);                // sidewalk
          put(sd * (w + 2.95), z - 1.15, z + 0.35, 0.3, 9);                // fascia: the solid side of the bridge
          put(sd * (w + 2.95), z + 0.35, z + 1.25, 0.12, 11);              // railing
        }
        // girders under the deck, kept clear of the boats (at least 3.2 m of headroom)
        if (z > 3.6) {
          const gz = Math.max(3.2, z - 1.9);
          for (const off of [-(w + 2.2), -w * 0.35, w * 0.35, w + 2.2]) put(off, gz, z - 0.55, 0.5, 9);
        }
      }
      // tender houses at the four corners of a real river road bridge (not highways, not footbridges)
      if (r.highway || !r.cars || r.len < 30) continue;
      for (const d of [5, r.len - 5]) {
        const e = pointAlong(r, d), h = Math.atan2(e.dx, e.dy);
        for (const sd of [-1, 1]) {
          const off = sd * (w + 6), x = e.x + Math.cos(h) * off, y = e.y - Math.sin(h) * off;
          if (houses.some((o) => Math.hypot(o[0] - x, o[1] - y) < 28)) continue;
          houses.push([x, y]);
          beams.push([x, y, h, 4.6, -0.3, 4.6, 3.6, 10]);
          beams.push([x, y, h, 5.1, 4.6, 5.1, 4.1, 9]);
          beams.push([x, y, h, 4.65, 2.0, 2.9, 3.65, 3]);
        }
      }
    }
  }

  /** Parked cars: nose-in bays down both sides of every parking aisle, about three quarters full. */
  *buildParking(ctx) {
    const out = [], near = new Map();
    const key = (x, y) => Math.floor(x / 6) + "|" + Math.floor(y / 6);
    const free = (x, y) => {
      const gx = Math.floor(x / 6), gy = Math.floor(y / 6);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const c of near.get((gx + i) + "|" + (gy + j)) || []) if (Math.hypot(c.x - x, c.y - y) < 2.45) return false;
      }
      return true;
    };
    const inBuilding = (x, y) => {
      for (const b of (ctx.collide && ctx.collide.get(Math.floor(x / 25) + "|" + Math.floor(y / 25))) || []) {
        if (x < b.minX - 1.5 || x > b.maxX + 1.5 || y < b.minY - 1.5 || y > b.maxY + 1.5) continue;
        if (pointInPoly(b.pts, x, y)) return true;
      }
      return false;
    };
    let n = 0;
    for (const r of ctx.roads) {
      if (r.service !== "parking_aisle") continue;
      if (++n % 12 === 0 && this.late()) yield;
      for (let d = 1.4; d < r.len - 1.4; d += 2.7) {
        const sp = pointAlong(r, d);
        if (Math.abs(sp.x) > AREA_R || Math.abs(sp.y) > AREA_R) continue;
        for (const side of [-1, 1]) {
          if (Math.random() > 0.78 || out.length >= 2500) continue;
          const off = side * (r.half + 2.4);
          const x = sp.x - sp.dy * off, y = sp.y + sp.dx * off;
          if (this.onRoadway(x, y, ctx.sampleGrid) || inBuilding(x, y) || (ctx.inWater && ctx.inWater(x, y)) || !free(x, y)) continue;
          const h = Math.atan2(sp.dy * side, -sp.dx * side) + (Math.random() - 0.5) * 0.1;   // nose toward the aisle
          const taxi = Math.random() < 0.04, tall = !taxi && Math.random() < 0.35 ? 1.16 + Math.random() * 0.08 : 1;
          const c = { x, y, h, taxi: taxi ? 1 : 0, tall, len: tall > 1 ? 1.06 : 0.94 + Math.random() * 0.12,
                      color: rgb(taxi ? "#f2c230" : pick(CAR_COLS)) };
          out.push(c);
          const k = key(x, y);
          let a = near.get(k);
          if (!a) near.set(k, (a = []));
          a.push(c);
        }
      }
    }
    ctx.parked = out;
  }

  /** Traffic signals where OSM maps them: a pole at the kerb on each side, a mast arm over the
   *  street, and a head showing green to the east-west street and red to the north-south one. */
  *buildSignals(ctx) {
    const sig = (ctx.osm && ctx.osm.signals) || [];
    const beams = ctx.beams, poles = [];
    let n = 0;
    for (const g of sig) {
      if (++n % 24 === 0 && this.late()) yield;
      const s = this.nearestSample(g.x, g.y, 14, ctx.sampleGrid, (sm) => sm.road.cars && !sm.road.deck && !sm.road.highway);
      if (!s) continue;
      const h = Math.atan2(s.ny, -s.nx);                    // the street direction at the signal
      const green = Math.abs(Math.sin(h)) > 0.7;
      for (const side of [-1, 1]) {
        const off = side * (s.half + 1.1);
        const px = s.x + s.nx * off, py = s.y + s.ny * off;
        if (poles.some(([x, y]) => Math.abs(x - px) < 9 && Math.abs(y - py) < 9)) continue;
        if (this.onRoadway(px, py, ctx.sampleGrid)) continue;
        poles.push([px, py]);
        beams.push([px, py, 0, 0.22, 0, 5.6, 0.22, 11]);                              // pole
        const reach = Math.min(9, s.half * 0.9), ax = -s.nx * side, ay = -s.ny * side;  // toward the middle
        beams.push([px + (ax * reach) / 2, py + (ay * reach) / 2, Math.atan2(ax, ay), reach, 5.35, 5.55, 0.14, 11]);
        const hx = px + ax * reach * 0.8, hy = py + ay * reach * 0.8;
        beams.push([hx, hy, h, 0.42, 4.3, 5.35, 0.42, 11]);                            // signal head
        for (const f of [-1, 1]) {                                                       // lit lamp on both faces
          beams.push([hx + Math.sin(h) * 0.23 * f, hy + Math.cos(h) * 0.23 * f, h, 0.05,
                      green ? 4.45 : 5.0, green ? 4.75 : 5.3, 0.26, green ? 19 : 20]);
        }
      }
    }
    ctx.signalCount = poles.length;
  }

  /** Everything solid at street level a person can walk into: columns, piers, walls, stair towers,
   *  tender houses, lamp posts, tree trunks, hydrants, benches and bins. Oriented boxes on an 8 m grid. */
  *buildObstacles(ctx) {
    const grid = new Map();
    const box = (x, y, h, len, wid, top) => {
      const o = { x, y, s: Math.sin(h), c: Math.cos(h), hl: len / 2, hw: wid / 2, top };
      const r = Math.hypot(o.hl, o.hw) + 0.5;
      for (let gx = Math.floor((x - r) / OB_C); gx <= Math.floor((x + r) / OB_C); gx++) {
        for (let gy = Math.floor((y - r) / OB_C); gy <= Math.floor((y + r) / OB_C); gy++) {
          const k = (gx + 2048) * 4096 + gy + 2048;
          let a = grid.get(k);
          if (!a) grid.set(k, (a = []));
          a.push(o);
        }
      }
    };
    let n = 0;
    for (const b of ctx.beams) {
      if (b[4] > 0.3 || b[5] < 1.2) continue;          // only what stands on the ground and is taller than a kerb
      box(b[0], b[1], b[2], b[3], b[6], b[5]);
      if ((++n & 511) === 0 && this.late()) yield;
    }
    for (const p of ctx.posts) box(p[0], p[1], 0, 0.3, 0.3, 8);
    for (const t of ctx.trees) box(t[0], t[1], 0, 0.5, 0.5, 3);
    const P = ctx.props || { hydrant: [], bench: [], bin: [] };
    for (const p of P.hydrant) box(p[0], p[1], 0, 0.45, 0.45, 0.9);
    for (const p of P.bin) box(p[0], p[1], 0, 0.55, 0.55, 1.0);
    for (const p of P.bench) box(p[0], p[1], p[2], 0.5, 1.75, 0.9);
    for (const c of ctx.parked || []) box(c.x, c.y, c.h, 4.4 * c.len, 1.85, 1.5);
    ctx.obstacles = grid;
  }

  /** Street surface ribbons: pavement (+5 m each side), kerb edge, asphalt; round joins and ends. */
  *buildGround(ctx) {
    const NEAR = 1400, SEG = 10;
    const out = { pave: [], kerb: [], asph: [] };
    const ribbon = (arr, r, hw) => {
      const p = r.pts, n = p.length / 2;
      const disc = (x, y) => {
        for (let k = 0; k < SEG; k++) {
          const a0 = (k / SEG) * 6.2832, a1 = ((k + 1) / SEG) * 6.2832;
          arr.push(x, y, 0, x + Math.cos(a0) * hw, y + Math.sin(a0) * hw, 0, x + Math.cos(a1) * hw, y + Math.sin(a1) * hw, 0);
        }
      };
      for (let i = 1; i < n; i++) {
        const ax = p[2 * i - 2], ay = p[2 * i - 1], bx = p[2 * i], by = p[2 * i + 1];
        const L = Math.hypot(bx - ax, by - ay);
        if (L < 1e-3) continue;
        const nx = (-(by - ay) / L) * hw, ny = ((bx - ax) / L) * hw;
        arr.push(ax + nx, ay + ny, 0, bx + nx, by + ny, 0, bx - nx, by - ny, 0,
                 ax + nx, ay + ny, 0, bx - nx, by - ny, 0, ax - nx, ay - ny, 0);
      }
      // round ends, and round joins wherever the street bends
      disc(p[0], p[1]);
      disc(p[2 * n - 2], p[2 * n - 1]);
      for (let i = 1; i < n - 1; i++) {
        const ux = p[2 * i] - p[2 * i - 2], uy = p[2 * i + 1] - p[2 * i - 1];
        const vx = p[2 * i + 2] - p[2 * i], vy = p[2 * i + 3] - p[2 * i + 1];
        const c = (ux * vx + uy * vy) / ((Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1);
        if (c < 0.995) disc(p[2 * i], p[2 * i + 1]);
      }
    };
    let k = 0;
    for (const r of ctx.roads) {
      if (++k % 25 === 0 && this.late()) yield;
      if (r.deck) continue;                                 // decks carry their own surface
      let near = false;
      for (let i = 0; i < r.pts.length && !near; i += 2) near = Math.abs(r.pts[i]) < NEAR && Math.abs(r.pts[i + 1]) < NEAR;
      if (!near) continue;
      if (r.cls === "path") { ribbon(out.pave, r, 1.1); continue; }
      const walkable = !["service", "motorway", "trunk"].includes(r.cls);
      if (walkable) { ribbon(out.pave, r, r.half + 5); ribbon(out.kerb, r, r.half + 0.45); }
      ribbon(out.asph, r, r.half);
    }
    // road surfaces on bridge decks and viaducts, at deck height, in the street asphalt colour
    const deck = [];
    for (const r of ctx.roads) {
      if (!r.deck || !r.cars || !r.zAt) continue;
      const p = r.pts, n = p.length / 2, hw = r.half, zz = (d) => r.zAt(d) + 0.1;     // clear of the slab top
      for (let i = 1; i < n; i++) {
        const ax = p[2 * i - 2], ay = p[2 * i - 1], bx = p[2 * i], by = p[2 * i + 1];
        const L = Math.hypot(bx - ax, by - ay);
        if (L < 1e-3) continue;
        // follow the deck profile in ~4 m steps along this segment
        const steps = Math.max(1, Math.ceil(L / 4)), nx = (-(by - ay) / L) * hw, ny = ((bx - ax) / L) * hw;
        for (let j = 0; j < steps; j++) {
          const t0 = j / steps, t1 = (j + 1) / steps;
          const x0 = ax + (bx - ax) * t0, y0 = ay + (by - ay) * t0, x1 = ax + (bx - ax) * t1, y1 = ay + (by - ay) * t1;
          const z0 = zz(r.cum[i - 1] + L * t0), z1 = zz(r.cum[i - 1] + L * t1);
          deck.push(x0 + nx, y0 + ny, z0, x1 + nx, y1 + ny, z1, x1 - nx, y1 - ny, z1,
                    x0 + nx, y0 + ny, z0, x1 - nx, y1 - ny, z1, x0 - nx, y0 - ny, z0);
        }
        if (i < n - 1) {
          const z = zz(r.cum[i]), x = bx, y = by;
          for (let k = 0; k < SEG; k++) {
            const a0 = (k / SEG) * 6.2832, a1 = ((k + 1) / SEG) * 6.2832;
            deck.push(x, y, z, x + Math.cos(a0) * hw, y + Math.sin(a0) * hw, z, x + Math.cos(a1) * hw, y + Math.sin(a1) * hw, z);
          }
        }
      }
      if (this.late()) yield;
    }
    out.deck = deck;
    yield;
    const geo = {};
    for (const [key, arr] of Object.entries(out)) {
      // copy into the GPU buffer in chunks, handing the frame back in between
      const f32 = new Float32Array(arr.length);
      for (let i = 0; i < arr.length; i += 60000) {
        f32.set(arr.slice(i, i + 60000), i);
        if (this.late()) yield;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(f32, 3));
      geo[key] = g;
    }
    ctx.groundGeo = geo;
  }

  /** The street surface layer: MapLibre calls this below the route line and the labels. */
  groundLayer() {
    const w = this;
    return { id: "ground-3d", type: "custom", renderingMode: "3d", render(gl, args) { w.renderGround(gl, args); } };
  }

  renderGround(gl, args) {
    if (!this.renderer || !this.frame || !this.groundMeshes.asph) return;
    if (this.map.getZoom() < 15) return;                // MapLibre draws the streets when zoomed out
    this.setCamera(args);
    this.renderer.resetState();
    this.renderer.render(this.groundScene, this.camera);
  }

  setCamera(args) {
    const f = this.frame;
    const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix);
    const l = new THREE.Matrix4().makeTranslation(f.mx, f.my, 0).scale(new THREE.Vector3(f.s, -f.s, f.s));
    this.camera.projectionMatrix = m.multiply(l);
  }

  /** Is (x, y) inside something solid, for someone standing at height z (default: the ground there)? */
  obstacleAt(x, y, m = 0.3, z) {
    const grid = this.state && this.state.obstacles;
    if (!grid) return false;
    const list = grid.get((Math.floor(x / OB_C) + 2048) * 4096 + Math.floor(y / OB_C) + 2048);
    if (!list) return false;
    for (const o of list) {
      const rx = x - o.x, ry = y - o.y;
      if (Math.abs(rx * o.s + ry * o.c) > o.hl + m || Math.abs(rx * o.c - ry * o.s) > o.hw + m) continue;
      if (z === undefined) z = this.groundZ(x, y);
      if (z < o.top - 0.6) return true;                // on a deck above it, it is not in the way
    }
    return false;
  }

  /** Height of the walking surface at (x, y): a bridge deck if one is there, otherwise the street. */
  groundZ(x, y) {
    const grid = this.state && this.state.sampleGrid;
    if (!grid) return 0;
    let z = 0;
    const gx = Math.floor(x / 20), gy = Math.floor(y / 20);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const s of grid.get((gx + i) + "|" + (gy + j)) || []) {
        if (!s.road.zAt) continue;
        const dx = x - s.x, dy = y - s.y;
        if (Math.abs(dx * s.nx + dy * s.ny) < s.road.half + 3.2 && Math.abs(dx * s.ny - dy * s.nx) < 2.2) z = Math.max(z, s.road.zAt(s.d));
      }
    }
    return z;
  }

  blocked(x, y) {
    const grid = this.state && this.state.collide;
    if (!grid) return false;
    if (this.state.inWater && this.state.inWater(x, y) && this.groundZ(x, y) < 0.5) return true;
    for (const b of grid.get(Math.floor(x / 25) + "|" + Math.floor(y / 25)) || []) {
      if (x < b.minX - 0.35 || x > b.maxX + 0.35 || y < b.minY - 0.35 || y > b.maxY + 0.35) continue;
      if (pointInPoly(b.pts, x, y)) return true;
    }
    return this.obstacleAt(x, y, 0.3);
  }

  /* ---------------- commit: swap a finished neighbourhood in, all in one frame */

  /** Fill the static instance buffers (lamps, pools, halos, trees, steelwork) inside the
   *  time budget, so the swap frame only hands finished geometry over. */
  *prepareMeshes(ctx) {
    const G = (ctx.geo = {});
    const posts = ctx.posts, N = posts.length, SL = ctx.stationLights.length;
    G.lamps = instanced(this.geos.lamp, N, { aState: 4 });
    G.pools = instanced(QUAD, N, { aPool: 4, aPoolB: 4 });
    G.halos = instanced(QUAD, N + SL, { aHalo: 4 });
    const st = G.lamps.attributes.aState.array, pa = G.pools.attributes.aPool.array;
    const pb = G.pools.attributes.aPoolB.array, ha = G.halos.attributes.aHalo.array;
    for (let i = 0; i < N; i++) {
      const p = posts[i], o = i * 4;
      st[o] = p[0]; st[o + 1] = p[1]; st[o + 2] = p[2]; st[o + 3] = p[3];
      pa[o] = p[4]; pa[o + 1] = p[5]; pa[o + 2] = LAMP_R; pa[o + 3] = 0.42;
      pb[o] = p[3]; pb[o + 1] = 1; pb[o + 2] = 0; pb[o + 3] = 0;
      ha[o] = p[4]; ha[o + 1] = p[5]; ha[o + 2] = LAMP_HEAD.z - 0.2; ha[o + 3] = p[3];
      if ((i & 255) === 255 && this.late()) yield;
    }
    for (let i = 0; i < SL; i++) {
      const l = ctx.stationLights[i], o = (N + i) * 4;
      ha[o] = l[0]; ha[o + 1] = l[1]; ha[o + 2] = l[2]; ha[o + 3] = -1;
    }
    yield;
    const trees = ctx.trees, T = trees.length;
    G.trees = instanced(this.geos.tree, T, { aState: 4, aTint: 3, aLit: 1 });
    G.treeShadows = instanced(QUAD, T, { aShadow: 4 });
    const tg = G.trees.attributes, sh = G.treeShadows.attributes.aShadow.array;
    for (let i = 0; i < T; i++) {
      const t = trees[i];
      tg.aState.array.set(t, i * 4);
      const c = rgb(pick(TREE_TINTS));
      tg.aTint.array[i * 3] = c.r; tg.aTint.array[i * 3 + 1] = c.g; tg.aTint.array[i * 3 + 2] = c.b;
      tg.aLit.array[i] = this.lampLightAt(t[0], t[1], ctx.light) * 0.6;
      sh[i * 4] = t[0]; sh[i * 4 + 1] = t[1]; sh[i * 4 + 2] = 2.6 * t[3]; sh[i * 4 + 3] = 6 * t[3];
    }
    G.cross = instanced(QUAD, ctx.crossings.length, { aCross: 4, aCrossKind: 1 });
    ctx.crossings.forEach((c, i) => { G.cross.attributes.aCross.array.set(c.slice(0, 4), i * 4); G.cross.attributes.aCrossKind.array[i] = c[4] || 0; });
    for (const kind of ["hydrant", "bench", "bin"]) {
      const list = ctx.props[kind], g = (G[kind] = instanced(this.geos[kind], list.length, { aState: 4 }));
      const a = g.attributes.aState.array;
      list.forEach((q, i) => { a[i * 4] = q[0]; a[i * 4 + 1] = q[1]; a[i * 4 + 2] = q[2]; a[i * 4 + 3] = this.lampLightAt(q[0], q[1], ctx.light) * 0.7; });
    }
    yield;
    const parked = ctx.parked || [];
    G.parked = instanced(this.geos.car, Math.max(1, parked.length), { aState: 4, aColor: 3, aLit: 1, aKind: 3 });
    {
      const A = G.parked.attributes;
      parked.forEach((c, i) => {
        A.aState.array.set([c.x, c.y, c.h, c.len], i * 4);
        A.aColor.array.set([c.color.r, c.color.g, c.color.b], i * 3);
        A.aLit.array[i] = this.lampLightAt(c.x, c.y, ctx.light);
        A.aKind.array.set([c.taxi, c.tall, 0], i * 3);
      });
      G.parked.instanceCount = parked.length;
    }
    yield;
    const cuts = ctx.cuts || [];
    G.cutMask = instanced(QUAD, Math.max(1, cuts.length), { aCut: 4, aCutW: 1 });
    cuts.forEach((c, i) => { G.cutMask.attributes.aCut.array.set(c.slice(0, 4), i * 4); G.cutMask.attributes.aCutW.array[i] = c[4]; });
    G.cutMask.instanceCount = cuts.length;
    const B = ctx.beams.length;
    G.beams = instanced(this.geos.beam, B, { aBeam: 4, aBeamB: 4, aSlope: 1 });
    const SLP = G.beams.attributes.aSlope.array;
    const A = G.beams.attributes.aBeam.array, Bb = G.beams.attributes.aBeamB.array;
    for (let i = 0; i < B; i++) {
      const b = ctx.beams[i], o = i * 4;
      A[o] = b[0]; A[o + 1] = b[1]; A[o + 2] = b[2]; A[o + 3] = b[3];
      Bb[o] = b[4]; Bb[o + 1] = b[5]; Bb[o + 2] = b[6]; Bb[o + 3] = b[7]; SLP[i] = b[8] || 0;
      if ((i & 1023) === 1023 && this.late()) yield;
    }
  }

  commit(ctx) {
    const old = this.frame;
    const oldState = this.state;
    this.frame = ctx.frame;
    this.state = ctx;
    this.flickerCount = ctx.flickerCount;
    this.lampPosts = ctx.posts;

    // static street furniture, filled during the job
    const G = ctx.geo;
    this.replaceMesh("lamps", G.lamps, this.mats.lamp);
    this.replaceMesh("pools", G.pools, this.mats.pool, 2);
    this.replaceMesh("halos", G.halos, this.mats.halo, 6);
    this.replaceMesh("trees", G.trees, this.mats.tree);
    this.replaceMesh("treesInk", G.trees, this.mats.treeInk);
    this.replaceMesh("treeShadows", G.treeShadows, this.mats.shadow, 1);
    this.replaceMesh("crossings", G.cross, this.mats.cross, 1);
    this.replaceMesh("markings", ctx.markGeo, this.mats.mark, 1);
    for (const kind of ["hydrant", "bench", "bin"]) {
      this.replaceMesh("prop_" + kind, G[kind], this.mats.prop);
      this.replaceMesh("prop_" + kind + "Ink", G[kind], this.mats.propInk);
    }
    if (ctx.groundGeo) {
      if (ctx.groundGeo.deck) this.replaceMesh("deckSurface", ctx.groundGeo.deck, this.deckMat, 0);
      [["pave", 0], ["kerb", 1], ["asph", 2]].forEach(([k, order]) => {
        const old = this.groundMeshes[k];
        if (old) { this.groundScene.remove(old); old.geometry.dispose(); }
        const gm = new THREE.Mesh(ctx.groundGeo[k], this.groundMats[k]);
        gm.frustumCulled = false;
        gm.renderOrder = order;
        this.groundScene.add(gm);
        this.groundMeshes[k] = gm;
      });
    }
    this.replaceMesh("parked", G.parked, this.mats.car);
    this.replaceMesh("parkedInk", G.parked, this.mats.carInk);
    this.replaceMesh("cutMask", G.cutMask, this.mats.cutMask, -100);
    if (!this.meshes.groundDepth) {
      const gd = this.replaceMesh("groundDepth", new THREE.PlaneGeometry(3400, 3400), this.mats.groundDepth, -99);
      gd.position.z = -0.15;
      gd.userData.keepGeometry = true;
    }
    this.replaceMesh("lStructure", G.beams, this.mats.beam);
    this.replaceMesh("lStructureInk", G.beams, this.mats.beamInk);

    // buildings (rise out of the ground the first time, appear in place after)
    this.replaceMesh("buildings", ctx.buildingGeo, this.mats.building);
    if (!oldState) this.rise = 0;
    const [bx, by] = ctx.frame.toLocal(CLOUD_GATE[0], CLOUD_GATE[1]);
    if (Math.hypot(bx, by) < BLDG_FAR) {
      const bean = this.replaceMesh("bean", this.beanGeo, this.mats.bean);
      bean.position.set(bx, by, 0);
      bean.rotation.z = (-4 * Math.PI) / 180;
      bean.updateMatrixWorld();
      bean.matrixAutoUpdate = false;
      bean.userData.keepGeometry = true;
    } else if (this.meshes.bean) { this.scene.remove(this.meshes.bean); delete this.meshes.bean; }

    // the avatar keeps walking: re-express it in the new frame
    if (this.avatar && old) {
      const [lng, lat] = old.toLngLat(this.avatar.x, this.avatar.y);
      [this.avatar.x, this.avatar.y] = ctx.frame.toLocal(lng, lat);
    }
    this.buildAgents(ctx);
    this._readyFrames = 0;
    this.setMode(this.mode, this.sun);
    this.setAgents(this.agentsOn);
    if (this.onArea) this.onArea(this);
    this.map.triggerRepaint();
  }

  /* ---------------- people and traffic: a crowd that follows the camera */

  viewCentre(frame = this.frame) {
    if (this.avatar) {
      if (frame === this.frame) return [this.avatar.x, this.avatar.y];
      const [lng, lat] = this.frame.toLngLat(this.avatar.x, this.avatar.y);
      return frame.toLocal(lng, lat);
    }
    const c = this.map.getCenter();
    return frame.toLocal(c.lng, c.lat);
  }
  /** Radius around the view centre the crowd should fill, from the zoom level. */
  crowdRadius() {
    if (this.avatar) return 170;
    const z = this.map.getZoom();
    const mpp = (40075016.686 * 0.745) / (512 * 2 ** z);
    return Math.max(110, Math.min(650, mpp * 1100));
  }
  /** Busier downtown: 1 out in the neighbourhoods, up to ~2.4 in the Loop. */
  densityAt(frame, x, y) {
    const [lng, lat] = frame.toLngLat(x, y);
    const d = Math.hypot((lng - LOOP_CORE[0]) * 82900, (lat - LOOP_CORE[1]) * 111320);
    return 1 + 1.4 * Math.exp(-d / 1600);
  }

  randomSampleNear(cx, cy, rMin, rMax, carsOnly, grid = this.state && this.state.sampleGrid) {
    for (let tries = 0; tries < 14; tries++) {
      const a = Math.random() * 6.283, r = rMin + Math.sqrt(Math.random()) * (rMax - rMin);
      const s = this.nearestSample(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 30, grid,
        carsOnly ? (q) => q.road.cars && q.road.len > 40 : (q) => q.road.cls !== "service" && !q.road.highway);
      if (s) return s;
    }
    return null;
  }

  dress(p) {
    p.phase = Math.random(); p.skin = Math.random();
    p.shirt = rgb(pick(SHIRTS)); p.pants = rgb(pick(PANTS)); p.hair = rgb(pick(HAIR));
    p.coat = Math.random() < 0.38 ? 1 : 0;
    p.scale = 0.92 + Math.random() * 0.16;
    return p;
  }
  newPerson(s, grid = this.state && this.state.sampleGrid) {
    const r = s.road;
    let side = Math.random() < 0.5 ? 1 : -1;
    if (r.cls !== "path" && !this.kerbOk(r, side, grid)) {
      side = -side;
      if (!this.kerbOk(r, side, grid)) return null;      // both kerbs are traffic: not a footway
    }
    return this.dress({
      road: r, d: s.d, dir: Math.random() < 0.5 ? 1 : -1,
      off: side * (r.cls === "path" ? 0.6 : r.half + 1.4 + Math.random() * 1.8),
      speed: 1.1 + Math.random() * 0.6, pause: 0, x: s.x, y: s.y, z: 0, h: 0, moving: 1, lit: 0,
    });
  }
  /** Someone standing still: chatting in a group, taking in the Bean, waiting for a train. */
  newStander(o, fixed) {
    return this.dress({ stand: true, fixed: !!fixed, x: o.x, y: o.y, z: o.z || 0, h: o.h, h0: o.h, moving: 0, lit: 0 });
  }
  newCar(s, grow) {
    const taxi = Math.random() < 0.14;
    const tall = !taxi && Math.random() < 0.32 ? 1.16 + Math.random() * 0.08 : 1;
    const r = s.road;
    // one-way streets (and each half of a divided avenue) run one direction across all lanes;
    // two-way streets keep to the right-hand half
    const dir = r.oneway ? (r.oneway > 0 ? 1 : -1) : (Math.random() < 0.5 ? 1 : -1);
    const lanes = Math.max(1, Math.floor((r.oneway ? 2 * r.half : r.half) / 3.2));
    const k = (Math.random() * lanes) | 0;
    const lane = r.oneway ? -r.half + 3.2 * (k + 0.5) + (2 * r.half - 3.2 * lanes) / 2 : 1.6 + 3.2 * k;
    const cruise = r.highway ? 20 + Math.random() * 8 : 7 + Math.random() * 6;
    return { road: r, d: s.d, dir, lane, cruise, v: grow ? cruise * 0.6 : cruise, stuck: 0, creep: 0,
      x: s.x, y: s.y, h: 0, scale: grow ? 0 : 1, lit: 0, taxi: taxi ? 1 : 0, tall,
      color: rgb(taxi ? "#f2c230" : pick(CAR_COLS)), len: tall > 1 ? 1.06 : 0.94 + Math.random() * 0.12 };
  }
  /** Is there already a car within 11 m of (x, y)? Used so cars never spawn on top of each other. */
  carNear(x, y, skip) {
    for (const c of this.cars) if (c !== skip && Math.abs(c.x - x) < 11 && Math.abs(c.y - y) < 11 && Math.hypot(c.x - x, c.y - y) < 11) return true;
    return false;
  }
  /** A knot of 3-8 people on the pavement beside sample s, facing each other. */
  groupAt(s, out, grid = this.state && this.state.sampleGrid) {
    let side = Math.random() < 0.5 ? 1 : -1;
    let gx = s.x + s.nx * (s.half + 2.6) * side, gy = s.y + s.ny * (s.half + 2.6) * side;
    if (this.onRoadway(gx, gy, grid)) {
      side = -side;
      gx = s.x + s.nx * (s.half + 2.6) * side; gy = s.y + s.ny * (s.half + 2.6) * side;
      if (this.onRoadway(gx, gy, grid)) return;          // nowhere safe to stand here
    }
    const n = 3 + ((Math.random() * 6) | 0);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.283 + Math.random() * 0.4, r = 0.75 + Math.random() * 0.55;
      const x = gx + Math.cos(a) * r, y = gy + Math.sin(a) * r;
      if (!this.onRoadway(x, y, grid)) out.push({ x, y, h: Math.atan2(gx - x, gy - y) });
    }
  }

  /** Decide where everyone starts, inside the build job's time budget. */
  *prepareCrowd(ctx) {
    const f = ctx.frame;
    const [cx, cy] = this.viewCentre(f);
    const R = this.crowdRadius();
    const dens = this.densityAt(f, cx, cy);
    const nWalk = Math.round((isTouch ? 90 : 190) * this.quality * dens);
    const nGroups = Math.round((isTouch ? 6 : 14) * this.quality * dens);
    const nCars = Math.round((isTouch ? 34 : 75) * this.quality * Math.min(dens, 1.6));
    const walkers = [], standers = [], cars = [];
    for (let i = 0; i < nWalk; i++) {
      const s = this.randomSampleNear(cx, cy, 0, R, false, ctx.sampleGrid);
      if (s) walkers.push(s);
      if (this.late()) yield;
    }
    for (let i = 0; i < nGroups; i++) {
      const s = this.randomSampleNear(cx, cy, 0, R * 0.85, false, ctx.sampleGrid);
      if (s) this.groupAt(s, standers, ctx.sampleGrid);
    }
    yield;
    for (let i = 0; i < nCars; i++) {
      const s = this.randomSampleNear(cx, cy, 0, R * 1.2, true, ctx.sampleGrid);
      if (s && !cars.some((o) => Math.hypot(o.x - s.x, o.y - s.y) < 14)) cars.push(s);
      if (this.late()) yield;
    }
    // tourists around Cloud Gate, looking at it
    const fixed = [];
    const [bx, by] = f.toLocal(CLOUD_GATE[0], CLOUD_GATE[1]);
    if (Math.hypot(bx, by) < AREA_R) {
      for (let i = 0; i < Math.round(36 * this.quality); i++) {
        const a = Math.random() * 6.283, r = 13 + Math.random() * 16;
        const x = bx + Math.cos(a) * r * 1.25, y = by + Math.sin(a) * r;
        fixed.push({ x, y, h: Math.atan2(bx - x, by - y) + (Math.random() - 0.5) * 0.6 });
      }
    }
    for (const w of ctx.waiting) fixed.push(w);
    const people = [];
    for (const s of walkers) { const w = this.newPerson(s, ctx.sampleGrid); if (w) people.push(w); if (this.late()) yield; }
    for (const o of standers) people.push(this.newStander(o, false));
    for (const o of fixed) people.push(this.newStander(o, true));
    ctx.crowd = { people, cars: cars.map((s) => this.newCar(s)) };
  }

  buildAgents(ctx) {
    this.people = ctx.crowd.people;
    this.cars = ctx.crowd.cars;
    const capP = this.people.length + 60;          // head-room for groups that form while recycling
    const nCars = this.cars.length;
    this.replaceMesh("people", instanced(this.geos.person, capP, { aState: 4, aShirt: 3, aPants: 3, aHair: 3, aMisc: 3, aStyle: 4 }), this.mats.person);
    this.replaceMesh("peopleInk", this.meshes.people.geometry, this.mats.personInk);
    this.replaceMesh("cars", instanced(this.geos.car, nCars, { aState: 4, aColor: 3, aLit: 1, aKind: 3 }), this.mats.car);
    this.replaceMesh("carsInk", this.meshes.cars.geometry, this.mats.carInk);
    this.replaceMesh("agentShadows", instanced(QUAD, capP + nCars + 1, { aShadow: 4 }), this.mats.shadow, 1);
    this.replaceMesh("carPools", instanced(QUAD, nCars + 1, { aPool: 4, aPoolB: 4 }), this.mats.pool, 3);
    this.peopleCap = capP;
    this.paintPeople();
    this.paintCars();

    // trains: four-car L consists on CTA track, six-unit double-deck Metra trains on the railroads,
    // each shuttling along the stretch of its route that is near the anchor
    const seen = new Set();
    this.trains = [];
    const TNEAR = BLDG_NEAR + 200;
    let nL = 0, nM = 0;
    // the stretch of each route near the anchor, and how much of it you can actually see (not in a tunnel):
    // trains go where they will be seen first
    const spans = [];
    for (const r of ctx.railRoutes || []) {
      let a = -1, b = -1, seen = 0;
      for (let d = 0; d <= r.len; d += 20) {
        const q = pointAlong(r, d);
        if (Math.abs(q.x) < TNEAR && Math.abs(q.y) < TNEAR) { if (a < 0) a = d; b = d; if (r.stAt(d) !== 3) seen += 20; }
      }
      if (a >= 0) spans.push({ r, a, b, seen });
    }
    spans.sort((p, q) => q.seen - p.seen);
    for (const { r, a, b, seen: vis } of spans) {
      const metra = !r.L;
      if (metra ? nM >= 8 : nL >= 14) continue;
      const tl = trainLength(metra);
      if (b - a < tl * 2.2 || vis < tl * 1.5) continue;
      const mid = pointAlong(r, (a + b) / 2);
      const key = Math.round(mid.x / 8) + "|" + Math.round(mid.y / 8);
      if (seen.has(key)) continue;
      seen.add(key);
      const n = Math.max(1, Math.min(metra ? 1 : 2, Math.round((b - a) / 900)));
      for (let i = 0; i < n; i++) {
        const dir = Math.random() < 0.5 ? 1 : -1;
        const d = a + tl + ((i + Math.random() * 0.6) / n) * Math.max(0, b - a - 2 * tl);
        this.trains.push({ rail: r, d, dir, lo: a + 4, hi: b - 4, metra, wait: 0, units: [],
                           speed: metra ? 13 + Math.random() * 5 : 11 + Math.random() * 5 });
        if (metra) nM++; else nL++;
      }
    }
    let slots = 0;
    for (const t of this.trains) { t.base = slots; slots += t.metra ? 18 : 8; }
    this.replaceMesh("trains", instanced(this.geos.beam, Math.max(1, slots), { aBeam: 4, aBeamB: 4, aSlope: 1 }), this.mats.beam);
    this.replaceMesh("trainsInk", this.meshes.trains.geometry, this.mats.beamInk);

    // boats: water taxis on ferry lines, tour boats on the river, sailboats on the lake
    this.boats = [];
    const routes = ctx.waterRoutes || [];
    const rkeys = new Set();
    for (const r of routes) {
      const mid = pointAlong(r, r.len / 2);
      const key = Math.round(mid.x / 10) + "|" + Math.round(mid.y / 10);
      if (rkeys.has(key)) continue;
      rkeys.add(key);
      const n = r.kind === 0 ? 1 : Math.max(1, Math.min(4, Math.round(r.len / 500)));
      for (let i = 0; i < n; i++) {
        this.boats.push({ route: r, d: ((i + Math.random() * 0.7) / n) * r.len, dir: Math.random() < 0.5 ? 1 : -1,
          v: 3 + Math.random() * 2.5, wait: 0, kind: r.kind === 0 ? 0 : (Math.random() < 0.7 ? 1 : 0),
          off: r.kind === 0 ? 0 : 5 + Math.random() * 4, phase: Math.random(), x: 0, y: 0, h: 0 });
      }
    }
    for (const sp of ctx.lakeSpots || []) {
      this.boats.push({ lake: true, cx: sp.x, cy: sp.y, a: Math.random() * 6.283, rad: 20 + Math.random() * 60,
        v: 0.6 + Math.random() * 0.8, kind: 2, phase: Math.random(), x: sp.x, y: sp.y, h: 0 });
    }
    this.boats.length = Math.min(this.boats.length, 40);
    const NB = this.boats.length;
    this.replaceMesh("boats", instanced(this.geos.boat, NB, { aBoat: 4, aBoatB: 4, aColor: 3, aLit: 1 }), this.mats.boat);
    this.replaceMesh("boatsInk", this.meshes.boats.geometry, this.mats.boatInk);
    this.replaceMesh("wakes", instanced(QUAD, NB, { aPool: 4, aPoolB: 4 }), this.mats.pool, 2);
    const bg = this.meshes.boats.geometry.attributes;
    const HULLS = { 0: ["#f2c230"], 1: ["#f4f2ec", "#1f3550", "#f4f2ec"], 2: ["#f4f2ec", "#2f5d7a", "#8c3b3b"] };
    this.boats.forEach((b, i) => {
      const c = rgb(pick(HULLS[b.kind]));
      bg.aColor.array.set([c.r, c.g, c.b], i * 3);
      bg.aBoatB.array.set([b.kind, b.phase, 0, 0], i * 4);
    });
    bg.aColor.needsUpdate = bg.aBoatB.needsUpdate = true;

    this.ensureAvatarMesh();
    this.litTick = 0;
    this.recycleT = 0;
  }

  updateBoats(dt) {
    const m = this.meshes.boats;
    if (!m || !this.boats || !this.boats.length) return;
    const A = m.geometry.attributes.aBoat.array, L = m.geometry.attributes.aLit.array;
    const W = this.meshes.wakes.geometry.attributes;
    const night = this.mode === "night";
    this.boats.forEach((b, i) => {
      let moving = 1;
      if (b.lake) {
        b.a += (b.v / b.rad) * dt;                         // slow circles out on the lake
        b.x = b.cx + Math.cos(b.a) * b.rad; b.y = b.cy + Math.sin(b.a) * b.rad;
        b.h = Math.atan2(-Math.sin(b.a), Math.cos(b.a));
      } else {
        const r = b.route;
        if (b.wait > 0) { b.wait -= dt; moving = 0; }
        else {
          b.d += b.dir * b.v * dt;
          if (b.d > r.len - 10 || b.d < 10) { b.d = Math.max(10, Math.min(r.len - 10, b.d)); b.dir = -b.dir; b.wait = 6 + Math.random() * 8; }
        }
        const s = pointAlong(r, b.d);
        // keep to the right of the channel
        b.x = s.x + s.dy * b.off * b.dir; b.y = s.y - s.dx * b.off * b.dir;
        const th = Math.atan2(s.dx * b.dir, s.dy * b.dir);
        b.h = b.wait > 0 ? b.h : th;
      }
      A[i * 4] = b.x; A[i * 4 + 1] = b.y; A[i * 4 + 2] = b.h; A[i * 4 + 3] = b.kind === 1 ? 1.45 : 1;
      L[i] = night ? this.lampLightAt(b.x, b.y) * 0.5 : 0;
      // a pale wake behind moving boats
      const fx = Math.sin(b.h), fy = Math.cos(b.h);
      W.aPool.array.set([b.x - fx * 11, b.y - fy * 11, 2.6, moving * (night ? 0.12 : 0.22)], i * 4);
      W.aPoolB.array.set([-1, 3.2, b.h, 1], i * 4);
    });
    m.geometry.attributes.aBoat.needsUpdate = m.geometry.attributes.aLit.needsUpdate = true;
    W.aPool.needsUpdate = W.aPoolB.needsUpdate = true;
  }

  updateTrains(dt) {
    const m = this.meshes.trains;
    if (!m || !this.trains.length) return;
    const g = m.geometry.attributes, A = g.aBeam.array, Bb = g.aBeamB.array, SL = g.aSlope.array;
    for (const t of this.trains) {
      const r = t.rail, units = t.metra ? METRA_UNITS : L_UNITS, total = trainLength(t.metra);
      if (t.wait > 0) t.wait -= dt;
      else {
        t.d += t.dir * t.speed * dt;
        if (t.d > t.hi || t.d < t.lo) {
          // end of the line in this neighbourhood: dwell, then run back (old tail becomes the front)
          t.d = Math.max(t.lo, Math.min(t.hi, t.d)) - t.dir * total;
          t.dir = -t.dir;
          t.wait = 4 + Math.random() * 4;
        }
      }
      let i = t.base, off = 0;
      t.units.length = 0;
      for (const u of units) {
        const dc = t.d - t.dir * (off + u.len / 2);
        off += u.len + 0.8;
        const s = pointAlong(r, dc), h = Math.atan2(s.dx, s.dy);
        const z = railTop(r, dc), slope = (railTop(r, dc + u.len / 2) - railTop(r, dc - u.len / 2)) / u.len;
        const gone = r.stAt(dc) === 3;                     // in the tunnel
        if (!gone) t.units.push({ x: s.x, y: s.y, h: t.dir > 0 ? h : h + Math.PI, len: u.len, z });
        for (const p of u.parts) {
          const fwd = (p.along || 0) * t.dir;       // parts at the front end (a locomotive cab)
          const px = s.x + s.dx * fwd, py = s.y + s.dy * fwd;
          A[i * 4] = px; A[i * 4 + 1] = py; A[i * 4 + 2] = h; A[i * 4 + 3] = gone ? 0 : p.len || u.len - (p.inset || 0);
          Bb[i * 4] = z + p.z0 + slope * fwd; Bb[i * 4 + 1] = z + p.z1 + slope * fwd; Bb[i * 4 + 2] = p.w; Bb[i * 4 + 3] = p.kind;
          SL[i] = slope;
          i++;
        }
      }
    }
    g.aBeam.needsUpdate = g.aBeamB.needsUpdate = g.aSlope.needsUpdate = true;
  }

  paintPeople() {
    const g = this.meshes.people.geometry.attributes;
    this.people.forEach((p, i) => {
      g.aShirt.array.set([p.shirt.r, p.shirt.g, p.shirt.b], i * 3);
      g.aPants.array.set([p.pants.r, p.pants.g, p.pants.b], i * 3);
      g.aHair.array.set([p.hair.r, p.hair.g, p.hair.b], i * 3);
      g.aStyle.array.set([p.coat, p.scale, p.stand ? 1 : 0, p.z || 0], i * 4);
    });
    g.aShirt.needsUpdate = g.aPants.needsUpdate = g.aHair.needsUpdate = g.aStyle.needsUpdate = true;
    this.meshes.people.geometry.instanceCount = this.people.length;
  }
  paintCars() {
    const cg = this.meshes.cars.geometry.attributes;
    this.cars.forEach((c, i) => { cg.aColor.array.set([c.color.r, c.color.g, c.color.b], i * 3); cg.aKind.array.set([c.taxi, c.tall, 0], i * 3); });
    cg.aColor.needsUpdate = cg.aKind.needsUpdate = true;
    this.meshes.cars.geometry.instanceCount = this.cars.length;
  }

  trimAgents() {
    this.people = this.people.filter((p, i) => p.fixed || i % 3 !== 0);
    this.cars.length = Math.min(this.cars.length, Math.max(10, Math.round(this.cars.length * 0.65)));
    if (this.meshes.people) { this.paintPeople(); this.meshes.cars.geometry.instanceCount = this.cars.length; }
  }

  /** People and cars that drift out of range reappear on streets near the camera;
   *  every so often a few of them arrive together and stop for a chat. */
  recycle() {
    if (!this.state) return;
    const [cx, cy] = this.viewCentre();
    const R = this.crowdRadius();
    let repaintP = false, repaintC = false, group = [];
    for (let i = 0; i < this.people.length; i++) {
      const p = this.people[i];
      if (p.fixed || Math.hypot(p.x - cx, p.y - cy) <= R * 1.15) continue;
      if (!group.length && Math.random() < 0.08) {
        const s = this.randomSampleNear(cx, cy, R * 0.5, R);
        if (s) this.groupAt(s, group);
      }
      if (group.length) { this.people[i] = this.newStander(group.pop(), false); repaintP = true; continue; }
      const s = this.randomSampleNear(cx, cy, R * 0.55, R);
      const np = s && this.newPerson(s);
      if (np) { this.people[i] = np; repaintP = true; }
    }
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      if (Math.hypot(c.x - cx, c.y - cy) <= R * 1.35) continue;
      const s = this.randomSampleNear(cx, cy, R * 0.6, R * 1.2, true);
      if (s && !this.carNear(s.x, s.y, c)) { this.cars[i] = this.newCar(s, true); repaintC = true; }
    }
    if (repaintP) this.paintPeople();
    if (repaintC) this.paintCars();
  }

  updateAgents(dt) {
    if (!this.meshes.people || !this.state) return;
    this.updateTrains(dt);
    this.updateBoats(dt);
    const night = this.mode === "night";
    const relight = true;
    this.recycleT += dt;
    if (this.recycleT > 0.4) { this.recycleT = 0; this.recycle(); }

    const ps = this.meshes.people.geometry.attributes.aState.array;
    const pm = this.meshes.people.geometry.attributes.aMisc.array;
    const pst = this.meshes.people.geometry.attributes.aStyle.array;
    let styleDirty = false;
    const sh = this.meshes.agentShadows.geometry.attributes.aShadow.array;
    let si = 0;
    for (let i = 0; i < this.people.length; i++) {
      const p = this.people[i];
      if (p.stand) {
        p.h = p.h0 + Math.sin(this.time * 0.35 + p.phase * 20) * 0.35;
        if (relight) p.lit = night ? this.lampLightAt(p.x, p.y) : 0;
        ps[i * 4] = p.x; ps[i * 4 + 1] = p.y; ps[i * 4 + 2] = p.h; ps[i * 4 + 3] = 0;
        pm[i * 3] = p.phase; pm[i * 3 + 1] = p.z > 1 ? (night ? 0.7 : 0) : p.lit; pm[i * 3 + 2] = p.skin;
        if (!p.z) { sh[si++] = p.x; sh[si++] = p.y; sh[si++] = 0.42; sh[si++] = 1.8; }
        continue;
      }
      if (p.pause > 0) { p.pause -= dt; p.moving = Math.max(0, p.moving - dt * 4); }
      else {
        p.moving = Math.min(1, p.moving + dt * 3);
        p.d += p.dir * p.speed * dt;
        p.cyc = ((p.cyc || p.phase) + (p.speed * dt) / 1.42) % 1;    // ~1.4 m per stride cycle: feet plant, no sliding
        if (p.d < 0 || p.d > p.road.len) {
          p.dir = -p.dir; p.d = Math.max(0, Math.min(p.road.len, p.d));
          p.pause = 0.6 + Math.random() * 2.5;
        } else if (Math.random() < dt * 0.02) p.pause = 1 + Math.random() * 4;
      }
      const s = pointAlong(p.road, p.d);
      // step around columns, posts, benches and the like, then drift back onto their line
      if (p.moving > 0.05) {
        const zz = p.z || 0, ahead = 1.4 * p.dir, bx = s.x + s.dx * ahead, by = s.y + s.dy * ahead;
        const free = (t) => !this.obstacleAt(bx - s.dy * (p.off + t), by + s.dx * (p.off + t), 0.35, zz);
        if (!free(p.dodgeT || 0)) {
          p.dodgeT = 0;
          for (const t of [0.9, -0.9, 1.7, -1.7]) if (free(t)) { p.dodgeT = t; break; }
          p.dodgeHold = 1.2;
        } else if (p.dodgeT && (p.dodgeHold -= dt) <= 0 && free(0)) p.dodgeT = 0;
        p.dodge = (p.dodge || 0) + ((p.dodgeT || 0) - (p.dodge || 0)) * Math.min(1, dt * 3);
      }
      const po = p.off + (p.dodge || 0);
      p.x = s.x - s.dy * po;
      p.y = s.y + s.dx * po;
      const pz = p.road.zAt ? p.road.zAt(p.d) : 0;
      if (pz !== p.z) { p.z = pz; pst[i * 4 + 3] = pz; styleDirty = true; }
      p.h = Math.atan2(s.dx * p.dir, s.dy * p.dir);
      if (relight) p.lit = night ? this.lampLightAt(p.x, p.y) : 0;
      ps[i * 4] = p.x; ps[i * 4 + 1] = p.y; ps[i * 4 + 2] = p.h; ps[i * 4 + 3] = p.moving;
      pm[i * 3] = p.cyc || p.phase; pm[i * 3 + 1] = p.lit; pm[i * 3 + 2] = p.skin;
      sh[si++] = p.x; sh[si++] = p.y; sh[si++] = 0.45; sh[si++] = 1.8;
    }

    // traffic: every car looks ahead (any road: duplicates, crossings, merges) and keeps its distance
    const cs = this.meshes.cars.geometry.attributes.aState.array;
    const cl = this.meshes.cars.geometry.attributes.aLit.array;
    const ck = this.meshes.cars.geometry.attributes.aKind.array;
    const cp = this.meshes.carPools.geometry.attributes.aPool.array;
    const cb = this.meshes.carPools.geometry.attributes.aPoolB.array;
    const [vx, vy] = this.viewCentre();
    const R = this.crowdRadius();
    let repaint = false;
    const CELL = 12, hash = new Map();
    for (const c of this.cars) {
      const k = Math.floor(c.x / CELL) * 73856 + Math.floor(c.y / CELL);
      let arr = hash.get(k);
      if (!arr) hash.set(k, (arr = []));
      arr.push(c);
    }
    for (let i = 0; i < this.cars.length; i++) {
      let c = this.cars[i];
      const fx = Math.sin(c.h), fy = Math.cos(c.h);
      // nearest obstacle ahead in our lane
      let gap = Infinity, leadV = c.cruise;
      if (c.creep <= 0) {
        const gx = Math.floor(c.x / CELL), gy = Math.floor(c.y / CELL);
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
          for (const o of hash.get((gx + di) * 73856 + gy + dj) || []) {
            if (o === c || o.scale < 0.3) continue;
            const rx = o.x - c.x, ry = o.y - c.y;
            const along = rx * fx + ry * fy;
            if (along <= 0 || along > 22) continue;
            const lateral = Math.abs(rx * fy - ry * fx);
            if (lateral > 2.2) continue;
            const same = Math.sin(o.h) * fx + Math.cos(o.h) * fy;
            if (same < -0.5) continue;                 // oncoming in the other lane
            if (along < gap) { gap = along; leadV = same > 0.5 ? o.v : 0; }
          }
        }
      }
      // gentle car-following: hold ~7 m at a standstill, more with speed
      const want = gap === Infinity ? c.cruise : Math.max(0, Math.min(c.cruise, leadV + (gap - 7 - c.v * 0.6) * 0.9));
      c.v += Math.max(-9 * dt, Math.min(3 * dt, want - c.v));
      if (gap < 5.5) c.v = 0;
      // stuck behind something that is not moving: after a few seconds, creep past it
      if (c.v < 0.2) { c.stuck += dt; if (c.stuck > 4) { c.creep = 1.8; c.stuck = 0; c.v = 2.5; } } else c.stuck = 0;
      if (c.creep > 0) c.creep -= dt;

      c.d += c.dir * c.v * dt;
      const toEnd = c.dir > 0 ? c.road.len - c.d : c.d;
      if (toEnd < 0) {
        const s = this.randomSampleNear(vx, vy, R * 0.5, R * 1.2, true);
        if (s && !this.carNear(s.x, s.y, c)) { this.cars[i] = c = this.newCar(s, true); repaint = true; }
        else { c.d = c.dir > 0 ? c.road.len : 0; c.scale = 0; continue; }
      }
      c.scale = Math.min(1, toEnd < 8 ? Math.max(0, toEnd) / 8 : c.scale + dt * 1.5);
      const s = pointAlong(c.road, c.d);
      // lane is measured to the right of the direction of travel
      c.x = s.x + s.dy * c.lane * c.dir;
      c.y = s.y - s.dx * c.lane * c.dir;
      c.h = Math.atan2(s.dx * c.dir, s.dy * c.dir);
      if (relight) c.lit = night ? this.lampLightAt(c.x, c.y) * 0.8 : 0;
      cs[i * 4] = c.x; cs[i * 4 + 1] = c.y; cs[i * 4 + 2] = c.h; cs[i * 4 + 3] = c.scale * c.len;
      cl[i] = c.lit;
      c.z = c.road.zAt ? c.road.zAt(c.d) : 0;
      ck[i * 3 + 2] = c.z;
      sh[si++] = c.x; sh[si++] = c.y; sh[si++] = c.z > 0.5 ? 0 : 2.4 * c.scale; sh[si++] = 1.4;
      const hx = Math.sin(c.h), hy = Math.cos(c.h);
      cp[i * 4] = c.x + hx * 9; cp[i * 4 + 1] = c.y + hy * 9; cp[i * 4 + 2] = 3.2; cp[i * 4 + 3] = c.z > 0.5 ? 0 : 0.5 * c.scale;
      cb[i * 4] = -1; cb[i * 4 + 1] = 2.3; cb[i * 4 + 2] = c.h; cb[i * 4 + 3] = 1;
    }
    if (repaint) this.paintCars();

    const a = this.avatar;
    if (a && this.meshes.avatar) {
      const at = this.meshes.avatar.geometry.attributes;
      at.aState.array.set([a.x, a.y, a.h, a.gait]);
      // stride length grows from a walk to a run, so the feet keep pace with the ground
      a.cyc = ((a.cyc || 0) + ((a.v || 0) * dt) / (a.gait > 1.2 ? 2.5 : 1.45)) % 1;
      at.aMisc.array.set([a.cyc, night ? this.lampLightAt(a.x, a.y) : 0, a.skin]);
      at.aShirt.array.set([a.shirt.r, a.shirt.g, a.shirt.b]);
      at.aPants.array.set([a.pants.r, a.pants.g, a.pants.b]);
      at.aHair.array.set([a.hair.r, a.hair.g, a.hair.b]);
      a.z = this.groundZ(a.x, a.y);
      at.aStyle.array.set([a.coat, a.scale, 0, a.z]);
      at.aState.needsUpdate = at.aMisc.needsUpdate = at.aShirt.needsUpdate = at.aPants.needsUpdate = true;
      at.aHair.needsUpdate = at.aStyle.needsUpdate = true;
      sh[si++] = a.x; sh[si++] = a.y; sh[si++] = 0.5; sh[si++] = 1.8;
      const n = this.cars.length;
      cp.set([a.x, a.y, 1.25, 0.9], n * 4);
      cb.set([-1, 1, 0, 2], n * 4);
    }
    if (this.meshes.avatar) { this.meshes.avatar.visible = !!a; this.meshes.avatarInk.visible = !!a; }

    const pg = this.meshes.people.geometry, cg = this.meshes.cars.geometry;
    pg.attributes.aState.needsUpdate = pg.attributes.aMisc.needsUpdate = true;
    if (styleDirty) pg.attributes.aStyle.needsUpdate = true;
    cg.attributes.aState.needsUpdate = cg.attributes.aLit.needsUpdate = cg.attributes.aKind.needsUpdate = true;
    const shg = this.meshes.agentShadows.geometry;
    shg.attributes.aShadow.needsUpdate = true;
    shg.instanceCount = si / 4;
    const cpg = this.meshes.carPools.geometry;
    cpg.attributes.aPool.needsUpdate = cpg.attributes.aPoolB.needsUpdate = true;
    cpg.instanceCount = this.cars.length + (a ? 1 : 0);
    if (this.meshes.carPools) this.meshes.carPools.visible = this.agentsOn && night || !!a;
  }

  ensureAvatarMesh() {
    if (this.meshes.avatar) return;
    const g = instanced(this.geos.person, 1, { aState: 4, aShirt: 3, aPants: 3, aHair: 3, aMisc: 3, aStyle: 4 });
    this.replaceMesh("avatar", g, this.mats.person).userData.keepGeometry = true;
    this.replaceMesh("avatarInk", g, this.mats.personInk);
    this.meshes.avatar.visible = this.meshes.avatarInk.visible = false;
  }

  /** Take over the passer-by nearest to a point (or a new one there). */
  possess(lng, lat) {
    const [x, y] = this.frame.toLocal(lng, lat);
    let best = -1, bd = 160;
    this.people.forEach((p, i) => {
      if (p.z) return;                       // not someone up on an L platform
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = i; }
    });
    let a;
    if (best >= 0) {
      const p = this.people[best];
      a = { x: p.x, y: p.y, h: p.h, gait: 0, skin: p.skin, shirt: p.shirt, pants: p.pants, hair: p.hair, coat: p.coat, scale: p.scale };
      this.people.splice(best, 1);           // they stop being part of the crowd
      this.paintPeople();
    } else {
      const s = this.nearestSample(x, y, 60);
      const px = s ? s.x + s.nx * (s.half + 2) : x, py = s ? s.y + s.ny * (s.half + 2) : y;
      a = this.dress({ x: px, y: py, h: 0, gait: 0 });
    }
    this.avatar = a;
    this.ensureAvatarMesh();
    return a;
  }

  /** Put the avatar back at a saved spot with a saved look. */
  spawnAvatar({ lng, lat, h, look }) {
    const [x, y] = this.frame.toLocal(lng, lat);
    const a = { x, y, h: h || 0, gait: 0, v: 0, ...look };
    if (!a.shirt) this.dress(a);
    this.avatar = a;
    this.ensureAvatarMesh();
    return a;
  }

  /** The nearest pavement spot to (x, y) that is not in a carriageway, building or water. */
  safeSpotNear(x, y) {
    const grid = this.state && this.state.sampleGrid;
    if (!grid) return [x, y];
    const cands = [];
    const gx = Math.floor(x / 20), gy = Math.floor(y / 20);
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
      for (const s of grid.get((gx + i) + "|" + (gy + j)) || []) {
        if (s.road.deck) continue;
        for (const side of [1, -1]) {
          const off = s.road.cls === "path" ? 0 : s.half + 2.2;
          const px = s.x + s.nx * off * side, py = s.y + s.ny * off * side;
          cands.push([Math.hypot(px - x, py - y), px, py]);
        }
      }
    }
    cands.sort((p, q) => p[0] - q[0]);
    for (const [, px, py] of cands) {
      if (!this.onRoadway(px, py) && !this.blocked(px, py)) return [px, py];
    }
    return [x, y];
  }

  /** The car (if any) whose body overlaps a person at (x, y, z) and is moving fast enough to hurt. */
  carHitting(x, y, z) {
    for (const c of this.cars) {
      if (c.scale < 0.5 || (c.v || 0) < 1.8 || Math.abs((c.z || 0) - (z || 0)) > 1.4) continue;
      const rx = x - c.x, ry = y - c.y;
      if (Math.abs(rx) > 4 || Math.abs(ry) > 4) continue;
      const fx = Math.sin(c.h), fy = Math.cos(c.h);
      const along = rx * fx + ry * fy, across = Math.abs(rx * fy - ry * fx);
      if (across < 1.15 && Math.abs(along) < 2.35 * c.len) return c;
    }
    for (const t of this.trains) {
      if (t.wait > 0) continue;
      for (const u of t.units || []) {
        if (Math.abs(u.z - (z || 0)) > 2) continue;              // only track you can actually walk onto
        const rx = x - u.x, ry = y - u.y;
        if (Math.abs(rx) > u.len || Math.abs(ry) > u.len) continue;
        const fx = Math.sin(u.h), fy = Math.cos(u.h);
        if (Math.abs(rx * fy - ry * fx) < 1.9 && Math.abs(rx * fx + ry * fy) < u.len / 2 + 0.5) return { h: u.h, v: t.speed };
      }
    }
    return null;
  }

  release() { this.avatar = null; this.walker = null; }

  /* ---------------- mesh bookkeeping */

  replaceMesh(key, geometry, material, renderOrder = 0) {
    const old = this.meshes[key];
    if (old) {
      this.scene.remove(old);
      // ink meshes share their owner's geometry; shared base geometry is kept
      if (!key.endsWith("Ink") && !old.userData.keepGeometry && old.geometry !== geometry) old.geometry.dispose();
    }
    const m = new THREE.Mesh(geometry, material);
    m.frustumCulled = false;
    m.renderOrder = renderOrder;
    this.meshes[key] = m;
    this.scene.add(m);
    return m;
  }
}

function toPath(line, frame, R) {
  const pts = [];
  let near = false;
  for (const [lng, lat] of line) {
    const [x, y] = frame.toLocal(lng, lat);
    pts.push(x, y);
    if (Math.abs(x) < R && Math.abs(y) < R) near = true;
  }
  if (!near || pts.length < 4) return null;
  const cum = [0];
  for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
  return { pts, cum, len: cum[cum.length - 1] };
}

/* position + unit direction at distance d along a road polyline */
const OB_C = 8;                    // obstacle grid cell, metres

/* ---------------- railways */

// train consists: units front to back; parts are boxes on each unit (z above the rail head)
const L_UNITS = Array.from({ length: 4 }, () => ({ len: 14.4, parts: [
  { z0: 0.1, z1: 3.35, w: 2.75, kind: 2 },                    // stainless body
  { z0: 1.45, z1: 2.65, w: 2.86, kind: 3, inset: 1.4 },       // window band
] }));
const METRA_UNITS = [
  { len: 20, parts: [
    { z0: 0.15, z1: 4.5, w: 3.0, kind: 17 },                  // locomotive
    { z0: 1.0, z1: 1.45, w: 3.04, kind: 18, inset: 0.4 },     // red stripe
    { z0: 3.0, z1: 3.75, w: 3.06, kind: 3, len: 2.4, along: 8.4 },   // cab windows, at the front
  ] },
  ...Array.from({ length: 5 }, () => ({ len: 25.9, parts: [
    { z0: 0.15, z1: 4.85, w: 3.05, kind: 2 },                 // bilevel gallery car
    { z0: 1.3, z1: 2.1, w: 3.1, kind: 3, inset: 4 },          // lower windows
    { z0: 2.95, z1: 3.7, w: 3.1, kind: 3, inset: 4 },         // upper windows
  ] })),
];
const trainLength = (metra) => (metra ? METRA_UNITS : L_UNITS).reduce((s, u) => s + u.len + 0.8, 0);
/** Height of the rail head at distance d along a route. */
const railTop = (r, d) => r.zAt(d) + (r.stAt(d) === 1 ? 0.2 : 0.37) + 0.14;

/**
 * OSM track pieces joined into continuous routes through their shared end nodes (straight on at
 * switches), each with a height profile: viaducts where OSM says bridge, embankments where it
 * says so, short dips between raised stretches filled in (Chicago lines stay up between the
 * street bridges), and real ramps (3.5%) down to grade. Tunnels and cuttings never get here.
 */
function chainRails(rails, overhead) {
  const isL = (w) => w.kind !== "rail";
  const ends = new Map();
  const add = (n, r) => { if (!n) return; let a = ends.get(n); if (!a) ends.set(n, (a = [])); a.push(r); };
  for (const r of rails) if (r.n0 !== r.n1) { add(r.n0, r); add(r.n1, r); }
  // direction pointing from a way end node into the way
  const dirAt = (w, atStart) => {
    const p = w.pts, n = p.length;
    const x0 = atStart ? p[0] : p[n - 2], y0 = atStart ? p[1] : p[n - 1];
    const x1 = atStart ? p[2] : p[n - 4], y1 = atStart ? p[3] : p[n - 3];
    const L = Math.hypot(x1 - x0, y1 - y0) || 1;
    return [(x1 - x0) / L, (y1 - y0) / L];
  };
  const used = new Set();
  const extend = (piece, node) => {
    const out = [];
    let cur = piece;
    for (let guard = 0; guard < 5000; guard++) {
      const a = ends.get(node);
      if (!a) break;
      const into = dirAt(cur, node === cur.n0);
      let best = null, bs = 0.9;                         // keep going straight-ish (within ~25 degrees)
      for (const o of a) {
        if (o === cur || used.has(o) || isL(o) !== isL(cur)) continue;
        const l = dirAt(o, o.n0 === node), sc = -(into[0] * l[0] + into[1] * l[1]);
        if (sc > bs) { bs = sc; best = o; }
      }
      if (!best) break;
      used.add(best);
      const startsHere = best.n0 === node;
      out.push([best, !startsHere]);
      node = startsHere ? best.n1 : best.n0;
      cur = best;
    }
    return out;
  };
  const routes = [];
  for (const r of rails) {
    if (used.has(r)) continue;
    used.add(r);
    const chain = [[r, false], ...extend(r, r.n1)];
    for (const [p, rev] of extend(r, r.n0)) chain.unshift([p, !rev]);
    const pts = [], segH = [], segB = [], segT = [];
    for (const [w, rev] of chain) {
      const n = w.pts.length / 2;
      const H = w.under === 2 ? -7.5 : w.under === 1 ? -6 :
        w.bridge ? (isL(w) ? 6.45 : 5.4) + Math.max(0, (w.layer || 1) - 1) * 5 : w.embankment ? 3.2 : 0;
      for (let i = 0; i < n; i++) {
        if (pts.length && i === 0) continue;              // the shared node
        const k = rev ? n - 1 - i : i;
        if (pts.length) { segH.push(H); segB.push(w.bridge ? 1 : 0); segT.push(w.under === 2 ? 1 : 0); }
        pts.push(w.pts[2 * k], w.pts[2 * k + 1]);
      }
    }
    const cum = [0];
    for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
    const len = cum[cum.length - 1];
    if (len < 8) continue;                               // short links at switches are track too
    // sample the profile every 5 m
    const STEP = 5, N = Math.ceil(len / STEP) + 1;
    const t = new Float32Array(N), br = new Uint8Array(N), tn = new Uint8Array(N);
    for (let i = 0, seg = 0; i < N; i++) {
      const d = Math.min(len, i * STEP);
      while (seg < segH.length - 1 && cum[seg + 1] < d) seg++;
      t[i] = segH[seg]; br[i] = segB[seg]; tn[i] = segT[seg];
    }
    if (overhead) {
      const path = { pts, cum, len };
      for (let i = 0; i < N; i++) {
        if (t[i] !== 0) continue;
        const q = pointAlong(path, Math.min(len, i * STEP));
        if (overhead(q.x, q.y)) t[i] = -6.5;
      }
    }
    // fill short dips between raised stretches: the line stays up
    const GAP = (isL(r) ? 300 : 420) / STEP;
    for (let i = 0; i < N; ) {
      if (t[i] !== 0) { i++; continue; }
      let j = i;
      while (j < N && t[j] === 0) j++;
      if (i > 0 && j < N && t[i - 1] > 0 && t[j] > 0 && j - i < GAP) {
        const h = Math.min(t[i - 1], t[j]);
        for (let k = i; k < j; k++) { t[k] = h; br[k] = isL(r) ? 1 : 0; }
      }
      i = j;
    }
    // ramps, never steeper than 3.5%: up onto a raised stretch on its low side, and down into a
    // cutting / tunnel on the street-level side (so the descent is an open cut you can see into)
    const st = new Uint8Array(N), z = new Float32Array(N), up = new Float32Array(N), dn = new Float32Array(N);
    for (let i = 0; i < N; i++) { up[i] = Math.max(0, t[i]); dn[i] = Math.min(0, t[i]); }
    const G = 0.035 * STEP;
    for (let i = 1; i < N; i++) { up[i] = Math.max(up[i], up[i - 1] - G); dn[i] = Math.min(dn[i], dn[i - 1] + G); }
    for (let i = N - 2; i >= 0; i--) { up[i] = Math.max(up[i], up[i + 1] - G); dn[i] = Math.min(dn[i], dn[i + 1] + G); }
    for (let i = 0; i < N; i++) z[i] = up[i] + dn[i];
    // a gentle vertical curve at the top and bottom of each ramp
    for (let pass = 0; pass < 2; pass++) {
      const c = Float32Array.from(z);
      for (let i = 1; i < N - 1; i++) z[i] = (c[i - 1] + c[i] * 2 + c[i + 1]) / 4;
    }
    // 0 street level, 1 viaduct, 2 embankment / incline, 3 tunnel (out of sight), 4 open cutting
    for (let i = 0; i < N; i++) st[i] = tn[i] ? 3 : t[i] > 0 ? (br[i] ? 1 : 2) : z[i] > 0.3 ? 2 : z[i] < -0.3 ? 4 : 0;
    const mouths = [];                                   // where a cutting meets its tunnel
    for (let i = 1; i < N; i++) {
      if ((st[i] === 3) !== (st[i - 1] === 3) && (st[i] === 4 || st[i - 1] === 4)) mouths.push({ d: i * STEP - STEP / 2, cutBefore: st[i - 1] === 4 });
    }
    const zAt = (d) => {
      if (N < 2) return z[0];
      const f = Math.max(0, Math.min(N - 1, d / STEP)), i = Math.min(N - 2, Math.floor(f));
      return z[i] + (z[i + 1] - z[i]) * (f - i);
    };
    const stAt = (d) => st[Math.max(0, Math.min(N - 1, Math.round(d / STEP)))];
    routes.push({ pts, cum, len, L: isL(r), kind: r.kind, zAt, stAt, mouths });
  }
  return routes;
}

const smooth = (t) => (t >= 1 ? 1 : t <= 0 ? 0 : t * t * (3 - 2 * t));

function pointAlong(r, d) {
  const cum = r.cum, pts = r.pts;
  d = Math.max(0, Math.min(r.len, d));
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
  const seg = cum[hi] - cum[lo] || 1;
  const t = (d - cum[lo]) / seg;
  const x0 = pts[lo * 2], y0 = pts[lo * 2 + 1], x1 = pts[hi * 2], y1 = pts[hi * 2 + 1];
  return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, dx: (x1 - x0) / seg, dy: (y1 - y0) / seg };
}

function ringArea(r) {
  let a = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += (r[2 * j] - r[2 * i]) * (r[2 * j + 1] + r[2 * i + 1]);
  return a / 2;     // > 0 for counter-clockwise (x east, y north)
}
function hash01(v) { const s = Math.sin(Number(v) * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); }
