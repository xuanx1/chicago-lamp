/* Third-person walk along the best-lit line.
 *
 * Standard third-person controls: W/S and A/D move relative to the camera,
 * the character turns to face where it's going, and the mouse orbits the camera
 * (click to lock the pointer, or drag). The camera sits a few metres behind the
 * shoulder on a soft spring.
 */

import { distanceToLine, metersBetween } from "./geo.js?v=20261125z";

const WALK = 2.2, RUN = 6.2;     // m/s: a brisk walk and a proper run
const ACCEL = 6, BRAKE = 10;      // m/s^2
const TURN_RATE = 8;             // how fast the body swings round to the move direction
const CAM_YAW_KEYS = 110;        // deg/s for arrow / Q E camera turning
const DEG = 180 / Math.PI;

const KEYMAP = {
  KeyW: "f", ArrowUp: "f", KeyS: "b", ArrowDown: "b",
  KeyA: "l", KeyD: "r",
  ArrowLeft: "camL", KeyQ: "camL", ArrowRight: "camR", KeyE: "camR",
  ShiftLeft: "run", ShiftRight: "run",
};

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const angleLerp = (a, b, t) => a + wrapPi(b - a) * t;

export class Walker {
  constructor(world, map, { route, end, onUpdate, onArrive, onReady, onDeath, resume }) {
    this.onDeath = onDeath;
    this.resume = resume || null;
    this.dead = false;
    this.world = world;
    this.map = map;
    this.route = route;
    this.end = end;
    this.onUpdate = onUpdate;
    this.onArrive = onArrive;
    this.onReady = onReady;
    this.keys = {};
    this.joy = { x: 0, y: 0 };
    this.zoom = 23.05;
    this.pitch = 72;
    this.active = false;
    this.arrived = false;
    this.hudT = 0;
    this.rebuildT = 0;
    this._bind();
  }

  start() {
    const map = this.map, world = this.world;
    let a;
    if (this.resume) {
      a = world.spawnAvatar(this.resume);            // pick up exactly where you left off
    } else {
      a = world.possess(this.route[0][0], this.route[0][1]);
      // face along the first stretch of the line
      const ahead = this.route[Math.min(this.route.length - 1, 3)];
      const [ax, ay] = world.frame.toLocal(ahead[0], ahead[1]);
      a.h = Math.atan2(ax - a.x, ay - a.y);
    }
    this.yaw = a.h;                     // camera yaw (radians, compass)
    this.cam = { x: a.x, y: a.y };      // spring-followed camera target
    this.frameRef = world.frame;
    world.walker = this;

    for (const h of ["dragPan", "dragRotate", "scrollZoom", "keyboard", "doubleClickZoom", "touchZoomRotate", "touchPitch", "boxZoom"]) {
      map[h] && map[h].disable();
    }
    this._prevMaxZoom = map.getMaxZoom();
    map.setMaxZoom(24);
    if (map.setVerticalFieldOfView) { this._prevFov = map.getVerticalFieldOfView(); map.setVerticalFieldOfView(50); }
    const [lng, lat] = world.frame.toLngLat(a.x, a.y);
    map.flyTo({ center: [lng, lat], zoom: this.zoom, pitch: this.pitch, bearing: this.yaw * DEG,
      padding: this._padding(), duration: 2600, curve: 1.5, essential: true });
    map.once("moveend", () => { this.active = true; this.onReady && this.onReady(); });
  }

  stop() {
    this.active = false;
    this._unbind();
    if (document.pointerLockElement) document.exitPointerLock();
    this.world.release();
    const map = this.map;
    // dragRotate stays off: main.js provides its own right-drag rotate
    for (const h of ["dragPan", "scrollZoom", "keyboard", "doubleClickZoom", "touchZoomRotate", "touchPitch", "boxZoom"]) {
      map[h] && map[h].enable();
    }
    if (this._prevFov && map.setVerticalFieldOfView) map.setVerticalFieldOfView(this._prevFov);
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    map.jumpTo({ zoom: Math.min(map.getZoom(), 18.5), pitch: Math.min(map.getPitch(), 65) });
    map.setMaxZoom(this._prevMaxZoom || 20.5);
  }

  /** Back on your feet after a crash, on the nearest pavement out of traffic. */
  revive() {
    const w = this.world, a = w.avatar;
    if (!a) return;
    const [x, y] = w.safeSpotNear(a.x, a.y);
    a.x = x; a.y = y; a.gait = 0; a.v = 0; this.v = 0;
    this.dead = false;
  }

  _padding() {
    const h = this.map.getContainer().clientHeight;
    return { top: Math.round(h * 0.16), bottom: 0, left: 0, right: 0 };
  }

  update(dt) {
    const w = this.world, a = w.avatar;
    if (!a) return;
    if (this.frameRef !== w.frame) {
      // the world re-anchored: carry the camera target into the new frame
      const [lng, lat] = this.frameRef.toLngLat(this.cam.x, this.cam.y);
      [this.cam.x, this.cam.y] = w.frame.toLocal(lng, lat);
      this.frameRef = w.frame;
    }
    if (!this.active) { a.gait = 0; return; }
    if (this.dead) {
      // knocked down: fall, lie still, let the camera hold
      this.deadT += dt;
      a.gait = -Math.min(1, this.deadT * 3.5);
      a.v = 0; this.v = 0;
      return;
    }

    const k = this.keys;
    this.yaw += (((k.camR ? 1 : 0) - (k.camL ? 1 : 0)) * CAM_YAW_KEYS * dt) / DEG;

    // input in camera space -> the direction you want to go
    const ix = (k.r ? 1 : 0) - (k.l ? 1 : 0) + this.joy.x;
    const iy = (k.f ? 1 : 0) - (k.b ? 1 : 0) - this.joy.y;
    const mag = Math.min(1, Math.hypot(ix, iy));
    const running = k.run || Math.hypot(this.joy.x, this.joy.y) > 0.92;
    let target = 0;
    if (mag > 0.05) {
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw), l = Math.max(1e-6, Math.hypot(ix, iy));
      const mx = (ix * cy + iy * sy) / l, my = (-ix * sy + iy * cy) / l;
      // turn the body toward it; sharp reversals slow you down rather than moonwalking
      const want = Math.atan2(mx, my);
      a.h = angleLerp(a.h, want, Math.min(1, dt * TURN_RATE));
      const facing = Math.cos(wrapPi(want - a.h));
      target = (running ? RUN : WALK) * mag * Math.max(0.15, facing);
    }
    // people accelerate and slow down; they don't teleport between speeds
    const v0 = this.v || 0;
    this.v = v0 + Math.max(-BRAKE * dt, Math.min(ACCEL * dt, target - v0));
    let speed = this.v;
    if (speed > 0.02) {
      const tx = a.x + Math.sin(a.h) * speed * dt, ty = a.y + Math.cos(a.h) * speed * dt;
      // (someone handed control while standing in a column's footprint can still walk out)
      if (!w.blocked(tx, ty) || w.blocked(a.x, a.y)) { a.x = tx; a.y = ty; }
      else if (!w.blocked(tx, a.y)) a.x = tx;          // slide along the wall
      else if (!w.blocked(a.x, ty)) a.y = ty;
      else { speed = 0; this.v = 0; }
    }
    a.v = speed;
    // traffic does not stop for you
    const hit = w.carHitting(a.x, a.y, a.z || 0);
    if (hit) {
      this.dead = true; this.deadT = 0;
      const fx = Math.sin(hit.h), fy = Math.cos(hit.h);
      a.x += fx * 1.6; a.y += fy * 1.6;                // thrown along the car's path
      a.h = Math.atan2(fx, fy);
      hit.v = 0; hit.stuck = -3;                       // the driver stops
      this.keys = {};
      this.onDeath && this.onDeath();
      return;
    }
    const gaitTarget = speed < 0.05 ? 0 : speed <= WALK ? speed / WALK : 1 + (speed - WALK) / (RUN - WALK);
    a.gait += (gaitTarget - a.gait) * Math.min(1, dt * 6);

    // the camera swings back behind you while you move, once the mouse has been left alone for a moment
    this.t = (this.t || 0) + dt;
    // (only when heading forward: following while strafing or backing up would walk you in circles)
    const forward = iy > 0.3 && iy >= Math.abs(ix) * 0.6;
    if (forward && speed > 0.3 && this.t - (this.lookT || -10) > 1.0) {
      const follow = 1 - Math.exp(-dt * (0.9 + speed * 0.35));
      this.yaw = angleLerp(this.yaw, a.h, follow);
      this.pitch += (72 - this.pitch) * follow;
    }

    // spring-follow camera target, with a little lead in the direction of travel
    const lead = 0.9 * Math.min(1, speed / WALK);
    const tx = a.x + Math.sin(a.h) * lead, ty = a.y + Math.cos(a.h) * lead;
    const s = 1 - Math.exp(-dt * 9);
    this.cam.x += (tx - this.cam.x) * s;
    this.cam.y += (ty - this.cam.y) * s;

    const [lng, lat] = w.frame.toLngLat(this.cam.x, this.cam.y);
    const bearing = this.yaw * DEG, pitch = this.pitch, zoom = this.zoom, padding = this._padding();
    queueMicrotask(() => { if (this.active) this.map.jumpTo({ center: [lng, lat], bearing, pitch, zoom, padding }); });

    this.hudT += dt;
    if (this.hudT > 0.2) {
      this.hudT = 0;
      const [alng, alat] = w.frame.toLngLat(a.x, a.y);
      const toEnd = metersBetween([alng, alat], this.end);
      const off = distanceToLine(alng, alat, this.route);
      const bEnd = Math.atan2((this.end[0] - alng) * Math.cos((alat * Math.PI) / 180), this.end[1] - alat) * DEG;
      this.onUpdate && this.onUpdate({ toEnd, off, pos: [alng, alat], arrow: bEnd - bearing, running: running && speed > 0.1,
        lit: w.lampLightAt(a.x, a.y), inTraffic: (a.z || 0) < 0.5 && w.onRoadway(a.x, a.y) });
      if (!this.arrived && toEnd < 18) { this.arrived = true; this.onArrive && this.onArrive(); }
    }
    this.rebuildT += dt;
    if (this.rebuildT > 1.5) { this.rebuildT = 0; w.maybeRebuild(); }
  }

  /* ---------------- input */

  // Hold a mouse button and move: right looks right, up looks toward the
  // horizon (same rule as right-drag on the map).
  // mouse right -> look right, mouse up -> look toward the horizon
  _look(dx, dy) {
    this.yaw += (dx * 0.22) / DEG;
    this.pitch = Math.max(52, Math.min(80, this.pitch - dy * 0.12));
    this.lookT = this.t || 0;
  }

  _bind() {
    const canvas = this.map.getCanvasContainer();
    this._canvas = canvas;
    this._kd = (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      const k = KEYMAP[e.code];
      if (k) { this.keys[k] = true; e.preventDefault(); }
    };
    this._ku = (e) => { const k = KEYMAP[e.code]; if (k) this.keys[k] = false; };
    this._blur = () => { this.keys = {}; };
    this._ctx = (e) => e.preventDefault();
    this._pd = (e) => {
      if (e.pointerType === "touch") return;      // touch uses the joystick
      if (e.button !== 0 && e.button !== 2) return;
      e.preventDefault();
      // click to lock the pointer: unlimited mouse look, like a PC game (Esc releases it)
      if (e.button === 0 && !document.pointerLockElement && canvas.requestPointerLock) {
        try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (err) { /* drag still works */ }
      }
      this._drag = true;
    };
    this._pm = (e) => {
      if (e.pointerType === "touch") return;
      if (document.pointerLockElement === canvas || this._drag) { this._look(e.movementX || 0, e.movementY || 0); return; }
      // no button, no lock: moving the mouse over the scene still turns the camera, a little more gently
      if (e.target && e.target.tagName === "CANVAS") this._look((e.movementX || 0) * 0.6, (e.movementY || 0) * 0.6);
    };
    this._pu = () => { this._drag = false; };
    this._wh = (e) => {
      e.preventDefault();
      this.zoom = Math.max(22.1, Math.min(23.8, this.zoom - e.deltaY * 0.0015));
    };
    addEventListener("keydown", this._kd);
    addEventListener("keyup", this._ku);
    addEventListener("blur", this._blur);
    canvas.addEventListener("contextmenu", this._ctx);
    canvas.addEventListener("pointerdown", this._pd);
    addEventListener("pointermove", this._pm);
    addEventListener("pointerup", this._pu);
    canvas.addEventListener("wheel", this._wh, { passive: false });

    const joy = document.getElementById("joystick");
    if (joy) {
      const knob = joy.querySelector(".knob");
      let id = null, cx = 0, cy = 0;
      const R = 46;
      this._jm = (e) => {
        if (e.pointerId !== id) return;
        let dx = e.clientX - cx, dy = e.clientY - cy;
        const l = Math.hypot(dx, dy);
        if (l > R) { dx *= R / l; dy *= R / l; }
        this.joy = { x: dx / R, y: dy / R };
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
      };
      this._js = (e) => {
        id = e.pointerId;
        const r = joy.getBoundingClientRect();
        cx = r.left + r.width / 2; cy = r.top + r.height / 2;
        joy.setPointerCapture(id); this._jm(e);
      };
      this._je = (e) => { if (e.pointerId !== id) return; id = null; this.joy = { x: 0, y: 0 }; knob.style.transform = ""; };
      // one-finger drag elsewhere on the map orbits the camera
      this._tp = null;
      this._ts = (e) => { if (e.pointerType === "touch" && e.target === canvas.querySelector("canvas")) { this._tp = [e.pointerId, e.clientX, e.clientY]; } };
      this._tm = (e) => {
        if (!this._tp || e.pointerId !== this._tp[0]) return;
        this._look((e.clientX - this._tp[1]) * 1.4, e.clientY - this._tp[2]);
        this._tp[1] = e.clientX; this._tp[2] = e.clientY;
      };
      this._te = (e) => { if (this._tp && e.pointerId === this._tp[0]) this._tp = null; };
      joy.addEventListener("pointerdown", this._js);
      joy.addEventListener("pointermove", this._jm);
      joy.addEventListener("pointerup", this._je);
      joy.addEventListener("pointercancel", this._je);
      canvas.addEventListener("pointerdown", this._ts);
      addEventListener("pointermove", this._tm);
      addEventListener("pointerup", this._te);
      this._joy = joy;
    }
  }

  _unbind() {
    const canvas = this._canvas;
    removeEventListener("keydown", this._kd);
    removeEventListener("keyup", this._ku);
    removeEventListener("blur", this._blur);
    canvas.removeEventListener("contextmenu", this._ctx);
    canvas.removeEventListener("pointerdown", this._pd);
    removeEventListener("pointermove", this._pm);
    removeEventListener("pointerup", this._pu);
    canvas.removeEventListener("wheel", this._wh);
    if (this._joy) {
      this._joy.removeEventListener("pointerdown", this._js);
      this._joy.removeEventListener("pointermove", this._jm);
      this._joy.removeEventListener("pointerup", this._je);
      this._joy.removeEventListener("pointercancel", this._je);
      canvas.removeEventListener("pointerdown", this._ts);
      removeEventListener("pointermove", this._tm);
      removeEventListener("pointerup", this._te);
    }
  }
}
