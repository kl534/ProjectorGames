// Two cameras: where the ball is in the room, not just where it seems to be on
// the wall. Works on numbers only (no browser code), so it is unit tested.
//
// Each camera's calibration maps the wall to its picture (a homography). With a
// guess of the camera's lens (its focal length, worked out from how the wall
// is tilted in the picture, or a typical webcam's if the camera faces the wall
// almost square on), that homography also says where the camera is and which
// way it looks. Then every spot in its picture is a ray into the room, and
// where the rays of two cameras meet is the ball.
//
// The cameras don't take their pictures at the same moments, so each camera's
// path is interpolated to the other's frame times: every frame of either
// camera gives a point, twice as many points as one camera alone.
//
// Room coordinates are measured in screen widths, from the screen's top-left
// corner: X across, Y down, and Z into the wall, so the room in front of the
// wall has Z < 0. A point on the screen at normalised (x, y) is (x, y × screenAspect, 0).

import { invertHomography } from './homography.js';

// A typical webcam sees about this wide (degrees), used when the focal length can't be worked out.
export const ASSUMED_FOV_DEG = 65;
// Focal lengths outside these views (degrees across) are taken to be wrong.
const MIN_FOV_DEG = 25;
const MAX_FOV_DEG = 130;
// A camera turned less than this (degrees) from square on to the wall can't tell its focal length.
const MIN_TILT_DEG = 12;
// One camera's points further apart than this (ms) aren't interpolated between.
const MAX_INTERPOLATE_MS = 70;
// A ball's speed as it arrives is measured over the last this long (ms) before it is closest to the wall.
const APPROACH_MS = 150;

/**
 * @typedef {{x:number, y:number, z:number}} Vec
 * @typedef {{x:number, y:number, t:number}} TimedPoint normalised camera coords, time (ms)
 * @typedef {object} CameraModel where a camera is and how it sees
 * @property {Vec} centre in room coordinates
 * @property {Vec[]} axes the camera's right, down and forward directions, in room coordinates
 * @property {number} focal focal length, in picture widths
 * @property {'wall'|'assumed'} focalFrom worked out from the wall's tilt, or a typical webcam's
 * @property {boolean} mirrored the camera's picture is mirrored
 * @property {number} imageAspect picture height / width
 * @property {number} fovDeg how wide it sees (degrees)
 * @property {number} distance from the wall, in screen widths
 * @property {number} angleDeg between its view and square on to the wall (degrees)
 * @typedef {{x:number, y:number, z:number, t:number, gap:number}} RoomPoint gap: how far apart the two
 *   rays passed (screen widths), a measure of how well the cameras agree
 */

/**
 * Works out where a calibrated camera is and how it sees.
 * @param {object} args
 * @param {number[]} args.cameraToScreen the calibration's homography (normalised camera -> normalised screen)
 * @param {number} args.imageAspect camera picture height / width
 * @param {number} args.screenAspect projected screen height / width
 * @returns {CameraModel|null}
 */
export function cameraModel({ cameraToScreen, imageAspect, screenAspect }) {
  const screenToCamera = invertHomography(cameraToScreen);
  if (!screenToCamera) return null;
  for (const mirrored of [false, true]) {
    let model = modelFrom(screenToCamera, imageAspect, screenAspect, mirrored, null);
    // Square on to the wall, or a focal length that can't be right: use a typical webcam's.
    if (!model || model.angleDeg < MIN_TILT_DEG || model.fovDeg < MIN_FOV_DEG || model.fovDeg > MAX_FOV_DEG) {
      model = modelFrom(screenToCamera, imageAspect, screenAspect, mirrored, focalForFov(ASSUMED_FOV_DEG));
    }
    // The wrong way round, the camera comes out behind the wall.
    if (model && model.centre.z < 0) return model;
  }
  return null;
}

/** The focal length (picture widths) of a camera that sees `fovDeg` across. */
export function focalForFov(fovDeg) {
  return 0.5 / Math.tan((fovDeg * Math.PI) / 360);
}

function modelFrom(screenToCamera, imageAspect, screenAspect, mirrored, focal) {
  // Room (X, Y, 1) on the wall -> picture (x, y, 1), the picture measured in picture widths.
  const toPicture = [mirrored ? -1 : 1, 0, mirrored ? 1 : 0, 0, imageAspect, 0, 0, 0, 1];
  const fromRoom = [1, 0, 0, 0, 1 / screenAspect, 0, 0, 0, 1];
  const G = multiply(multiply(toPicture, screenToCamera), fromRoom);
  const cx = 0.5;
  const cy = imageAspect / 2;
  const col = (k) => ({ x: G[k], y: G[3 + k], z: G[6 + k] });
  const [g1, g2, g3] = [col(0), col(1), col(2)];
  let f = focal;
  if (f === null) {
    // The wall's across and down directions are at right angles and the same length:
    // two equations in 1/f², solved together.
    const a = { x: g1.x - cx * g1.z, y: g1.y - cy * g1.z };
    const b = { x: g2.x - cx * g2.z, y: g2.y - cy * g2.z };
    const p1 = a.x * b.x + a.y * b.y;
    const q1 = g1.z * g2.z;
    const p2 = a.x * a.x + a.y * a.y - b.x * b.x - b.y * b.y;
    const q2 = g1.z * g1.z - g2.z * g2.z;
    const denom = p1 * p1 + p2 * p2;
    const w = denom > 0 ? -(p1 * q1 + p2 * q2) / denom : 0;
    if (!(w > 0)) return null;
    f = 1 / Math.sqrt(w);
  }
  const unproject = (g) => ({ x: (g.x - cx * g.z) / f, y: (g.y - cy * g.z) / f, z: g.z });
  const m1 = unproject(g1);
  const m2 = unproject(g2);
  const m3 = unproject(g3);
  let scale = 2 / (length(m1) + length(m2));
  // The wall is in front of the camera.
  if (m3.z * scale < 0) scale = -scale;
  const r1 = normalise(times(m1, scale));
  const r2 = normalise(minus(times(m2, scale), times(r1, dot(r1, times(m2, scale)))));
  const r3 = cross(r1, r2);
  const t = times(m3, scale);
  // The camera's axes in room coordinates are the rows of R = [r1 r2 r3].
  const axes = [
    { x: r1.x, y: r2.x, z: r3.x },
    { x: r1.y, y: r2.y, z: r3.y },
    { x: r1.z, y: r2.z, z: r3.z },
  ];
  const centre = { x: -dot(r1, t), y: -dot(r2, t), z: -dot(r3, t) };
  const forward = axes[2];
  return {
    centre,
    axes,
    focal: f,
    focalFrom: focal === null ? 'wall' : 'assumed',
    mirrored,
    imageAspect,
    fovDeg: (2 * Math.atan(0.5 / f) * 180) / Math.PI,
    distance: -centre.z,
    angleDeg: (Math.acos(Math.min(1, Math.abs(forward.z))) * 180) / Math.PI,
  };
}

/**
 * The ray from a camera through a spot in its picture.
 * @param {CameraModel} model
 * @param {{x:number, y:number}} p normalised camera coords
 * @returns {{origin: Vec, dir: Vec}}
 */
export function rayThrough(model, p) {
  const px = model.mirrored ? 1 - p.x : p.x;
  const c = { x: (px - 0.5) / model.focal, y: (p.y - 0.5) * model.imageAspect / model.focal, z: 1 };
  const [right, down, forward] = model.axes;
  const dir = normalise({
    x: right.x * c.x + down.x * c.y + forward.x * c.z,
    y: right.y * c.x + down.y * c.y + forward.y * c.z,
    z: right.z * c.x + down.z * c.y + forward.z * c.z,
  });
  return { origin: model.centre, dir };
}

/** Where a room point appears in a camera's picture (normalised camera coords), or null if behind it. */
export function projectToCamera(model, point) {
  const d = minus(point, model.centre);
  const [right, down, forward] = model.axes;
  const z = dot(forward, d);
  if (z <= 0) return null;
  const x = 0.5 + (model.focal * dot(right, d)) / z;
  return {
    x: model.mirrored ? 1 - x : x,
    y: 0.5 + (model.focal * dot(down, d)) / z / model.imageAspect,
  };
}

/**
 * The point nearest to both rays, and how far apart they pass. Null if they are (nearly) parallel.
 * @returns {{point: Vec, gap: number}|null}
 */
export function triangulate(a, b) {
  const w0 = minus(a.origin, b.origin);
  const aa = dot(a.dir, a.dir);
  const ab = dot(a.dir, b.dir);
  const bb = dot(b.dir, b.dir);
  const d = dot(a.dir, w0);
  const e = dot(b.dir, w0);
  const denom = aa * bb - ab * ab;
  if (denom < 1e-9) return null;
  const s = (ab * e - bb * d) / denom;
  const u = (aa * e - ab * d) / denom;
  const pa = plus(a.origin, times(a.dir, s));
  const pb = plus(b.origin, times(b.dir, u));
  return { point: times(plus(pa, pb), 0.5), gap: length(minus(pa, pb)) };
}

/**
 * Where a camera's path was at time t, interpolated between the frames either side; null if it
 * wasn't seen around then.
 * @param {TimedPoint[]} points in time order
 */
export function pointAt(points, t) {
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1];
    const q = points[i];
    if (t < p.t || t > q.t) continue;
    if (q.t - p.t > MAX_INTERPOLATE_MS) return null;
    const k = q.t > p.t ? (t - p.t) / (q.t - p.t) : 0;
    return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
  }
  return null;
}

/**
 * The ball's path through the room, from two cameras' paths. Their times must be on the same
 * clock (each camera's frame times less its delay). Every frame of either camera seen while the
 * other camera saw the ball too gives a point.
 * @param {CameraModel} modelA
 * @param {CameraModel} modelB
 * @param {TimedPoint[]} pathA in time order
 * @param {TimedPoint[]} pathB in time order
 * @returns {RoomPoint[]} in time order
 */
export function roomPath(modelA, modelB, pathA, pathB) {
  const out = [];
  const add = (t, pa, pb) => {
    if (!pa || !pb) return;
    const met = triangulate(rayThrough(modelA, pa), rayThrough(modelB, pb));
    if (met) out.push({ ...met.point, t, gap: met.gap });
  };
  for (const p of pathA) add(p.t, p, pointAt(pathB, p.t));
  for (const p of pathB) add(p.t, pointAt(pathA, p.t), p);
  return out.sort((p, q) => p.t - q.t);
}

/**
 * What a ball's path through the room says about the throw.
 * @param {RoomPoint[]} path in time order
 * @param {number} screenAspect projected screen height / width
 * @returns {{closest: RoomPoint, speed: number|null, towardWall: number|null,
 *   velocity: {x:number, y:number, z:number}|null,
 *   hit: {x:number, y:number}|null, meanGap: number, points: number}|null} speeds in screen widths a
 *   second (speed: along its path; towardWall: straight at the wall; velocity: the same path as
 *   X across, Y down, Z into the wall). hit: where the path arriving meets the wall, in normalised
 *   screen coords
 */
export function analyseFlight(path, screenAspect) {
  if (!path.length) return null;
  let closest = path[0];
  for (const p of path) if (p.z > closest.z) closest = p;
  const meanGap = path.reduce((sum, p) => sum + p.gap, 0) / path.length;
  const approach = path.filter((p) => p.t <= closest.t && p.t >= closest.t - APPROACH_MS);
  const result = {
    closest, speed: null, towardWall: null, velocity: null, hit: null, meanGap, points: path.length,
  };
  const onScreen = (p) => ({ x: p.x, y: p.y / screenAspect });
  const fit = fitLine(approach);
  if (!fit) {
    result.hit = onScreen(closest);
    return result;
  }
  const { at, velocity } = fit;
  result.speed = length(velocity) * 1000;
  result.towardWall = velocity.z * 1000;
  result.velocity = times(velocity, 1000);
  // Where it reaches the wall (Z = 0), going the way it arrived; if it wasn't heading for the wall, where it was closest.
  if (velocity.z > 1e-6) {
    const dt = -at.z / velocity.z;
    result.hit = onScreen(plus(at, times(velocity, dt)));
  } else {
    result.hit = onScreen(closest);
  }
  return result;
}

/** A straight line through timed points (least squares): where it is at the last point's time, and its velocity per ms. */
function fitLine(points) {
  if (points.length < 2) return null;
  const tEnd = points[points.length - 1].t;
  const n = points.length;
  const mt = points.reduce((s, p) => s + p.t, 0) / n;
  const stt = points.reduce((s, p) => s + (p.t - mt) ** 2, 0);
  if (stt <= 0) return null;
  const axis = (k) => {
    const m = points.reduce((s, p) => s + p[k], 0) / n;
    const slope = points.reduce((s, p) => s + (p.t - mt) * (p[k] - m), 0) / stt;
    return { slope, at: m + slope * (tEnd - mt) };
  };
  const [x, y, z] = ['x', 'y', 'z'].map(axis);
  return { at: { x: x.at, y: y.at, z: z.at }, velocity: { x: x.slope, y: y.slope, z: z.slope } };
}

// ---- Small vector and matrix helpers ----

/** 3 × 3 matrices, row by row. */
function multiply(a, b) {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return out;
}
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const plus = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const minus = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const times = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const length = (a) => Math.sqrt(dot(a, a));
const normalise = (a) => times(a, 1 / (length(a) || 1));
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
