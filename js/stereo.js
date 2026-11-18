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
// camera gives a point, twice as many points as one camera alone. The ball's
// speed and direction as it arrives are fitted to the sight lines themselves,
// each at its own camera's frame time, so nothing in them is interpolated.
//
// The start of a flight (how a ball left the bat) is found the same way as its
// end: the earliest stretch of both cameras' sight lines that is one flight to
// the wall is fitted over its first moments (launchFit). A toss both cameras saw
// is a flight of its own, and where the two flights meet (meetingOf) is where
// the bat met the ball. The same fits say how wide each camera's lens sees
// (refineLenses): the pair of lenses with which real flights fit best.
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
// Points whose two sight lines pass further apart than this many times the throw's median (and at least
// MIN_GAP_LIMIT screen widths) aren't the ball in both cameras.
const GAP_OUTLIER = 4;
const MIN_GAP_LIMIT = 0.01;
// Nor is a point further behind the wall than this (screen widths).
const BEHIND_WALL = 0.05;
// Points further off the fitted flight than this many times the fit's RMS (and MIN_RESIDUAL screen widths)
// are dropped and it is fitted again, if there are at least this many points.
const RESIDUAL_OUTLIER = 3;
const MIN_RESIDUAL = 0.005;
const MIN_REFIT_POINTS = 6;
// A hit the cameras put further in front of the wall than this (screen widths) wasn't at the wall: a real one is
// at most about one frame's flight from it, a person walking across the room is half a screen width or more away.
// Only if their sight lines met that well (screen widths apart at the closest), else the point is too uncertain.
export const OFF_WALL_MAX = 0.3;
export const OFF_WALL_MAX_GAP = 0.1;
// The ball's place at a hit is looked for among the path's points this close to it in time (ms).
const HIT_POINT_MS = 60;
// The flight is followed on to the wall from the end of the fit, or back to it, at most this far (ms);
// further, and it is taken as it was at the end of the fit.
const MAX_TO_WALL_MS = 60;

/**
 * @typedef {{x:number, y:number, z:number}} Vec
 * @typedef {{x:number, y:number, t:number}} TimedPoint normalised camera coords, time (ms)
 * @typedef {object} CameraModel where a camera is and how it sees
 * @property {Vec} centre in room coordinates
 * @property {Vec[]} axes the camera's right, down and forward directions, in room coordinates
 * @property {number} focal focal length, in picture widths
 * @property {'wall'|'assumed'|'refined'} focalFrom worked out from the wall's tilt, a typical webcam's, or
 *   refined from real flights (refineLenses)
 * @property {boolean} mirrored the camera's picture is mirrored
 * @property {number} imageAspect picture height / width
 * @property {number} fovDeg how wide it sees (degrees)
 * @property {number} distance from the wall, in screen widths
 * @property {number} angleDeg between its view and square on to the wall (degrees)
 * @typedef {{x:number, y:number, z:number, t:number, gap:number}} RoomPoint gap: how far apart the two
 *   rays passed (screen widths), a measure of how well the cameras agree
 * @typedef {{origin: Vec, dir: Vec, t: number, camera: number}} SightLine the ray from a camera through the
 *   ball in one of its frames, at that frame's time
 */

/**
 * Works out where a calibrated camera is and how it sees.
 * @param {object} args
 * @param {number[]} args.cameraToScreen the calibration's homography (normalised camera -> normalised screen)
 * @param {number} args.imageAspect camera picture height / width
 * @param {number} args.screenAspect projected screen height / width
 * @param {number|null} [args.fovDeg] how wide its lens sees (degrees), if known (refined from real
 *   flights); else worked out from the wall's tilt, or a typical webcam's
 * @returns {CameraModel|null}
 */
export function cameraModel({ cameraToScreen, imageAspect, screenAspect, fovDeg = null }) {
  const screenToCamera = invertHomography(cameraToScreen);
  if (!screenToCamera) return null;
  for (const mirrored of [false, true]) {
    let model;
    if (fovDeg) {
      // A lens found from real flights (refineLenses): used as it is.
      model = modelFrom(screenToCamera, imageAspect, screenAspect, mirrored, focalForFov(fovDeg));
      if (model) model.focalFrom = 'refined';
    } else {
      model = modelFrom(screenToCamera, imageAspect, screenAspect, mirrored, null);
      // Square on to the wall, or a focal length that can't be right: use a typical webcam's.
      if (!model || model.angleDeg < MIN_TILT_DEG || model.fovDeg < MIN_FOV_DEG || model.fovDeg > MAX_FOV_DEG) {
        model = modelFrom(screenToCamera, imageAspect, screenAspect, mirrored, focalForFov(ASSUMED_FOV_DEG));
      }
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
 * Where the ball was in the room at the moment of a hit, from two cameras that both saw it: the point of their
 * paths nearest that moment, or, if the paths never overlapped there, where the sight lines through the two
 * spots they put the hit at meet.
 * @param {CameraModel} modelA
 * @param {CameraModel} modelB
 * @param {TimedPoint[]} pathA what the first followed, in time order, on the same clock as `t`
 * @param {TimedPoint[]} pathB
 * @param {number} t when it hit (ms)
 * @param {{x:number, y:number}|null} [seenA] where the first camera saw it hit (normalised camera coords)
 * @param {{x:number, y:number}|null} [seenB] (with only one of the two spots, it is met with the other camera's path)
 * @returns {{point: Vec, gap: number}|null} gap: how far apart the sight lines passed (screen widths)
 */
export function pointAtHit(modelA, modelB, pathA, pathB, t, seenA = null, seenB = null) {
  let nearest = null;
  for (const p of roomPath(modelA, modelB, pathA, pathB)) {
    if (Math.abs(p.t - t) <= HIT_POINT_MS && (!nearest || Math.abs(p.t - t) < Math.abs(nearest.t - t))) nearest = p;
  }
  if (nearest) return { point: { x: nearest.x, y: nearest.y, z: nearest.z }, gap: nearest.gap };
  if (seenA && seenB) return triangulate(rayThrough(modelA, seenA), rayThrough(modelB, seenB));
  // Only one camera's spot is known: meet it with where the other's path was then (or nearly).
  const near = (path) => pointAt(path, t) ?? path.filter((p) => Math.abs(p.t - t) <= HIT_POINT_MS)
    .sort((p, q) => Math.abs(p.t - t) - Math.abs(q.t - t))[0] ?? null;
  const other = seenA ? near(pathB) : seenB ? near(pathA) : null;
  if (!other) return null;
  return seenA ? triangulate(rayThrough(modelA, seenA), rayThrough(modelB, other))
    : triangulate(rayThrough(modelA, other), rayThrough(modelB, seenB));
}

// A ball is taken to be at the wall if the sight lines met this well (screen widths apart at the closest) and the
// point was no further than this (screen widths) in front of it or behind it. Tighter than OFF_WALL_MAX: two
// cameras at about the same height see the same row of their pictures for anything, so a person's piece can
// seem to meet a ball's sight line by chance.
export const AT_WALL_MAX_GAP = 0.06;
export const AT_WALL_MAX_Z = 0.15;

/** Whether where the cameras put a hit (pointAtHit) is at the wall: their sight lines met well, close to it. */
export function isAtWall(found) {
  return Boolean(found) && found.gap <= AT_WALL_MAX_GAP && Math.abs(found.point.z) <= AT_WALL_MAX_Z;
}

/** Whether where the cameras put a hit (pointAtHit) is well in front of the wall: not a ball hitting it. */
export function isOffWall(found) {
  return Boolean(found) && found.gap <= OFF_WALL_MAX_GAP && found.point.z < -OFF_WALL_MAX;
}

/**
 * Each camera's sight lines through a path it followed.
 * @param {CameraModel} model
 * @param {TimedPoint[]} points
 * @param {number} camera which camera, so a fit can tell that both are in it
 * @returns {SightLine[]}
 */
export function sightLines(model, points, camera) {
  return points.map((p) => ({ ...rayThrough(model, p), t: p.t, camera }));
}

/**
 * What a ball's path through the room says about the throw.
 *
 * Only points where the two cameras' sight lines nearly meet are used (others are where one camera saw
 * something else, or its path was interpolated across the bounce), and none far behind the wall. Given the
 * moment the ball hit (`until`), nothing after it is used: after that it is coming back off the wall. Its
 * speed and direction are fitted over the last APPROACH_MS before then, with gravity if it is known (the
 * screen's width in feet gives it in screen widths), so they are its speed and direction as it arrived, not
 * an average over the approach. Given both cameras' sight lines (`lines`), the flight is fitted to them,
 * each at its own frame's time; otherwise to the path's points. Either way, those far off the fitted flight
 * are dropped and it is fitted again.
 * @param {RoomPoint[]} path in time order
 * @param {number} screenAspect projected screen height / width
 * @param {{until?: number|null, gravity?: number, lines?: SightLine[]|null}} [opts] until: when it hit
 *   (ms, the path's clock); gravity: screen widths a second², down the screen; lines: each camera's sight
 *   lines (sightLines), on the path's clock
 * @returns {{closest: RoomPoint, speed: number|null, towardWall: number|null,
 *   velocity: {x:number, y:number, z:number}|null,
 *   hit: {x:number, y:number}|null, meanGap: number, points: number, arriving: number}|null} speeds in screen widths a
 *   second (speed: along its path; towardWall: straight at the wall; velocity: the same path as
 *   X across, Y down, Z into the wall). hit: where the path arriving meets the wall, in normalised
 *   screen coords. points: how many points of the path were used; arriving: how many of them up to the moment
 *   it was closest to the wall (or hit), its speed and direction are measured from
 */
export function analyseFlight(path, screenAspect, { until = null, gravity = 0, lines = null } = {}) {
  if (!path.length) return null;
  const meanGap = path.reduce((sum, p) => sum + p.gap, 0) / path.length;
  const gapLimit = Math.max(MIN_GAP_LIMIT, GAP_OUTLIER * median(path.map((p) => p.gap)));
  let usable = path.filter((p) => p.gap <= gapLimit && p.z <= BEHIND_WALL && (until === null || p.t <= until));
  if (!usable.length) usable = path;
  let closest = usable[0];
  for (const p of usable) if (p.z > closest.z) closest = p;
  const end = until === null ? closest.t : Math.min(until, closest.t);
  const approach = usable.filter((p) => p.t <= end && p.t >= end - APPROACH_MS);
  const result = {
    closest, speed: null, towardWall: null, velocity: null, hit: null, meanGap, points: usable.length,
    arriving: approach.length,
  };
  const onScreen = (p) => ({ x: p.x, y: p.y / screenAspect });
  const g = gravity / 1e6; // per ms²
  const arriving = (lines ?? []).filter((l) => l.t <= end && l.t >= end - APPROACH_MS);
  const fit = fitToLines(arriving, g, end) ?? refit(approach, (pts) => fitFlight(pts, g), (p, f) => length(minus(p, f.position(p.t))));
  if (!fit) {
    result.hit = onScreen(closest);
    return result;
  }
  // Its speed and direction as it reached the wall (Z = 0), where the fitted flight does, and where; if it
  // wasn't heading for the wall, at the end of the fit and where it was closest.
  // A ball the fit ends far from the wall (it bounced off the floor, or flew out of sight) is taken as it
  // was then, and where it was heading on the wall is straight on from there.
  let velocity = fit.velocity;
  result.hit = onScreen(closest);
  if (velocity.z > 1e-6) {
    const dt = -fit.at.z / velocity.z;
    if (Math.abs(dt) <= MAX_TO_WALL_MS) {
      velocity = { ...velocity, y: velocity.y + g * dt };
      result.hit = onScreen(fit.position(end + dt));
    } else {
      result.hit = onScreen(plus(fit.at, times(velocity, dt)));
    }
  }
  result.speed = length(velocity) * 1000;
  result.towardWall = velocity.z * 1000;
  result.velocity = times(velocity, 1000);
  return result;
}

/**
 * Fits, then fits again without the items far off the first fit (a stray blob, a bad match), if there are
 * enough of them. `fitOf` makes a fit of items, or null; `offBy` is how far an item is off a fit.
 */
function refit(items, fitOf, offBy) {
  const fit = fitOf(items);
  if (!fit || items.length < MIN_REFIT_POINTS) return fit;
  const off = items.map((item) => offBy(item, fit));
  const rms = Math.sqrt(off.reduce((s, d) => s + d * d, 0) / off.length);
  const limit = Math.max(MIN_RESIDUAL, RESIDUAL_OUTLIER * rms);
  const kept = items.filter((_, i) => off[i] <= limit);
  if (kept.length === items.length || kept.length < MIN_REFIT_POINTS / 2) return fit;
  return fitOf(kept) ?? fit;
}

/**
 * The flight that passes nearest to every sight line at its own time (least squares): where it is at
 * `tEnd` and its velocity then (per ms), bent by gravity `g` (per ms², down Y). Null unless both cameras
 * have at least two sight lines in it, which is what fixes how far along each the ball was.
 * @param {SightLine[]} lines
 */
function fitToLines(lines, g, tEnd) {
  const perCamera = new Map();
  for (const l of lines) perCamera.set(l.camera, (perCamera.get(l.camera) ?? 0) + 1);
  if (perCamera.size < 2 || [...perCamera.values()].some((n) => n < 2)) return null;
  const fitOf = (some) => {
    // Unknowns: where it is at tEnd (3) and its velocity (3). Each line pulls the flight's point at its
    // time, p + v τ + ½ g τ² down, towards itself: only across the line, (I − d dᵀ).
    const M = Array.from({ length: 6 }, () => new Array(6).fill(0));
    const rhs = new Array(6).fill(0);
    for (const { origin, dir, t } of some) {
      const tau = t - tEnd;
      const d = [dir.x, dir.y, dir.z];
      const b = [origin.x, origin.y - 0.5 * g * tau * tau, origin.z];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const P = (r === c ? 1 : 0) - d[r] * d[c];
          M[r][c] += P;
          M[r][c + 3] += P * tau;
          M[r + 3][c] += P * tau;
          M[r + 3][c + 3] += P * tau * tau;
          rhs[r] += P * b[c];
          rhs[r + 3] += P * tau * b[c];
        }
      }
    }
    const x = solve(M, rhs);
    if (!x) return null;
    const at = { x: x[0], y: x[1], z: x[2] };
    const velocity = { x: x[3], y: x[4], z: x[5] };
    const position = (t) => {
      const tau = t - tEnd;
      return { x: at.x + velocity.x * tau, y: at.y + velocity.y * tau + 0.5 * g * tau * tau, z: at.z + velocity.z * tau };
    };
    return { at, velocity, position };
  };
  // How far a sight line passes from where the flight had the ball at its time.
  const offBy = (l, fit) => {
    const w = minus(fit.position(l.t), l.origin);
    return length(minus(w, times(l.dir, dot(w, l.dir))));
  };
  return refit(lines, fitOf, offBy);
}

// ---- The start of a flight: how the ball left the bat, and where the toss met it ----

// A flight both cameras saw is one flight if its sight lines fit one within this (screen widths, RMS)…
const FLIGHT_MAX_RMS = 0.02;
// …and its first lines are no further off it than this, or three times the RMS if that is more…
const START_MIN_OFF = 0.012;
// …and it has at least this many lines in all (two from each camera at least).
const FLIGHT_MIN_LINES = 6;
// How a ball left is fitted over its first this long (ms): the shortest that has three lines from each camera.
const LAUNCH_WINDOWS_MS = [150, 250, 400, Infinity];

/** How far a sight line passes from a point. */
function offLine(line, point) {
  const w = minus(point, line.origin);
  return length(minus(w, times(line.dir, dot(w, line.dir))));
}

/** Whether both cameras (at least two) have at least `n` of these lines each. */
function bothHave(lines, n) {
  const count = new Map();
  for (const l of lines) count.set(l.camera, (count.get(l.camera) ?? 0) + 1);
  return count.size >= 2 && [...count.values()].every((c) => c >= n);
}

/**
 * The flight nearest to every sight line at its own time: where it is at `tRef`, its velocity then
 * (per ms), bent by gravity `g` (per ms², down Y). Null unless both cameras have two lines.
 * @returns {{tRef:number, at:Vec, velocity:Vec, position:(t:number)=>Vec, velocityAt:(t:number)=>Vec,
 *   rms:number, count:number, off:number[]}|null} off: how far each line is from it, in the lines' order
 */
function fitOnce(lines, g, tRef) {
  if (!bothHave(lines, 2)) return null;
  const M = Array.from({ length: 6 }, () => new Array(6).fill(0));
  const rhs = new Array(6).fill(0);
  for (const { origin, dir, t } of lines) {
    const tau = t - tRef;
    const d = [dir.x, dir.y, dir.z];
    const b = [origin.x, origin.y - 0.5 * g * tau * tau, origin.z];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const P = (r === c ? 1 : 0) - d[r] * d[c];
        M[r][c] += P;
        M[r][c + 3] += P * tau;
        M[r + 3][c] += P * tau;
        M[r + 3][c + 3] += P * tau * tau;
        rhs[r] += P * b[c];
        rhs[r + 3] += P * tau * b[c];
      }
    }
  }
  const x = solve(M, rhs);
  if (!x) return null;
  const at = { x: x[0], y: x[1], z: x[2] };
  const velocity = { x: x[3], y: x[4], z: x[5] };
  const position = (t) => {
    const tau = t - tRef;
    return { x: at.x + velocity.x * tau, y: at.y + velocity.y * tau + 0.5 * g * tau * tau, z: at.z + velocity.z * tau };
  };
  const velocityAt = (t) => ({ x: velocity.x, y: velocity.y + g * (t - tRef), z: velocity.z });
  const off = lines.map((l) => offLine(l, position(l.t)));
  const rms = Math.sqrt(off.reduce((s, d) => s + d * d, 0) / lines.length);
  return { tRef, at, velocity, position, velocityAt, rms, count: lines.length, off };
}

/**
 * fitOnce, then once more without the lines far off the first fit (a stray blob), as analyseFlight does.
 * @param {SightLine[]} lines @param {number} g gravity per ms² @param {number} tRef
 */
export function fitBallistic(lines, g, tRef) {
  const fit = fitOnce(lines, g, tRef);
  if (!fit || lines.length < MIN_REFIT_POINTS) return fit;
  const limit = Math.max(MIN_RESIDUAL, RESIDUAL_OUTLIER * fit.rms);
  const kept = lines.filter((_, i) => fit.off[i] <= limit);
  if (kept.length === lines.length || !bothHave(kept, 2)) return fit;
  return fitOnce(kept, g, tRef) ?? fit;
}

/**
 * The lines of the one flight that ends at `until`: from the earliest line from which everything up to `until`
 * fits one flight. A path that began before the bat met the ball (it wasn't split there) is trimmed to the
 * flight off the bat. One camera may have had the ball much longer than the other (the other saw only its
 * last few frames): all of it is kept, as the other's few lines say how far away it was, and the flight
 * itself does the rest. Null if there is no such flight, with at least two lines from each of two cameras.
 * @param {SightLine[]} lines both cameras' @param {number} g gravity per ms² @param {number} until
 * @returns {SightLine[]|null} in time order
 */
export function flightLines(lines, g, until) {
  let rest = lines.filter((l) => l.t <= until).sort((a, b) => a.t - b.t);
  const cameras = [...new Set(rest.map((l) => l.camera))];
  if (cameras.length < 2) return null;
  while (bothHave(rest, 2) && rest.length >= FLIGHT_MIN_LINES) {
    // No outlier pass here: a few lines of another flight at the start barely move the fit, but are far off it.
    const fit = fitOnce(rest, g, until);
    if (!fit) return null;
    const firstOff = Math.max(...fit.off.slice(0, 4));
    if (fit.rms <= FLIGHT_MAX_RMS && firstOff <= Math.max(START_MIN_OFF, 3 * fit.rms)) return withoutBounce(rest, g, until);
    rest = rest.slice(1);
  }
  return null;
}

/**
 * The lines of a flight without either camera's last line if that was seen after the bounce: the turn a
 * camera saw is its frame nearest the bounce, which may be just after it, on the way back, far off the flight
 * (a 90 mph ball moves a tenth of a screen width between frames). One such line pulls the fit towards it
 * enough to pass as one of the flight's, so each is judged against the flight the others make.
 * @param {SightLine[]} lines in time order @param {number} g @param {number} until
 */
function withoutBounce(lines, g, until) {
  let rest = lines;
  for (const camera of new Set(lines.map((l) => l.camera))) {
    const last = rest.findLast((l) => l.camera === camera);
    const others = rest.filter((l) => l !== last);
    if (!bothHave(others, 2) || others.length < FLIGHT_MIN_LINES) continue;
    const fit = fitOnce(others, g, until);
    if (fit && offLine(last, fit.position(last.t)) > Math.max(START_MIN_OFF, 3 * fit.rms)) rest = others;
  }
  return rest;
}

/**
 * How the flight that ends at `until` began: fitted over its first lines, at the time of the first
 * (the fit's tRef). Null if the lines aren't one flight both cameras saw.
 * @param {SightLine[]} lines @param {number} g gravity per ms² @param {number} until
 */
export function launchFit(lines, g, until) {
  const flight = flightLines(lines, g, until);
  if (!flight) return null;
  const t0 = flight[0].t;
  for (const ms of LAUNCH_WINDOWS_MS) {
    const some = flight.filter((l) => l.t <= t0 + ms);
    if (!bothHave(some, 3)) continue;
    const fit = fitBallistic(some, g, t0);
    if (fit) return fit;
  }
  return null;
}

/**
 * When two flights (fitBallistic's, under the same gravity) were closest, between tMin and tMax, and how
 * close (screen widths). Under the same gravity the gap between them changes in a straight line, so there is
 * one such moment.
 * @returns {{t:number, gap:number}}
 */
export function meetingOf(a, b, tMin, tMax) {
  const dp = minus(a.position(tMin), b.position(tMin));
  const dv = minus(a.velocityAt(tMin), b.velocityAt(tMin));
  const vv = dot(dv, dv);
  let t = vv > 0 ? tMin - dot(dp, dv) / vv : tMin;
  t = Math.min(tMax, Math.max(tMin, t));
  return { t, gap: length(minus(a.position(t), b.position(t))) };
}

/**
 * A flight's speed and direction at time t, as a game wants them.
 * @returns {{speed:number, velocity:Vec, elevation:number, azimuth:number, point:Vec}} speed and velocity in
 *   screen widths a second; elevation degrees above level; azimuth degrees to the right of straight at the
 *   wall (negative: to the left); point: where it was then
 */
export function launchAt(fit, t) {
  const velocity = times(fit.velocityAt(t), 1000);
  return {
    speed: length(velocity),
    velocity,
    elevation: (Math.atan2(-velocity.y, Math.hypot(velocity.x, velocity.z)) * 180) / Math.PI,
    azimuth: (Math.atan2(velocity.x, velocity.z) * 180) / Math.PI,
    point: fit.position(t),
  };
}

// ---- Lenses refined from real flights ----

// Lenses tried when refining them (degrees across), every this many degrees.
const REFINE_FOV = { min: 40, max: 120, step: 2.5 };

/**
 * The two cameras' lenses (how wide each sees) that make real flights fit best: every pair is tried, each
 * camera placed in the room by its calibration with that lens, and the pair kept for which the flights'
 * sight lines pass nearest to ballistic flights.
 * @param {object} args
 * @param {{cameraToScreen:number[], imageAspect:number}[]} args.cameras the main camera's, then the second's
 * @param {number} args.screenAspect
 * @param {{points: TimedPoint[][], from:number, until:number}[]} args.flights Launch.legs of several throws
 * @param {number} [args.gravity] screen widths a second²
 * @param {(number|null)[]} [args.current] the lens each camera has now (fovDeg), or null for the one
 *   cameraModel works out by itself
 * @returns {{fovDeg: number[], rms: number, before: number, lines: number}|null} the lenses, how well the
 *   flights fit with them and with the lenses as they are now (screen widths, RMS), and how many sight lines
 */
export function refineLenses({ cameras, screenAspect, flights, gravity = 0, current = [null, null] }) {
  const g = gravity / 1e6;
  const modelFor = (camera, fovDeg) => cameraModel({ ...camera, screenAspect, fovDeg });
  const cost = (models) => {
    if (models.some((m) => !m)) return null;
    let sum = 0;
    let lines = 0;
    for (const { points, until } of flights) {
      const fit = fitOnce([...sightLines(models[0], points[0], 0), ...sightLines(models[1], points[1], 1)], g, until);
      if (!fit) continue;
      sum += fit.rms ** 2 * fit.count;
      lines += fit.count;
    }
    return lines ? { rms: Math.sqrt(sum / lines), lines } : null;
  };
  const before = cost(cameras.map((camera, i) => modelFor(camera, current[i])));
  if (!before) return null;
  let best = null;
  const tried = [];
  for (let fov = REFINE_FOV.min; fov <= REFINE_FOV.max; fov += REFINE_FOV.step) tried.push(fov);
  const modelsA = tried.map((fov) => modelFor(cameras[0], fov));
  const modelsB = tried.map((fov) => modelFor(cameras[1], fov));
  tried.forEach((fovA, i) => tried.forEach((fovB, j) => {
    const c = cost([modelsA[i], modelsB[j]]);
    if (c && (!best || c.rms < best.rms)) best = { fovDeg: [fovA, fovB], rms: c.rms, lines: c.lines };
  }));
  return best && { ...best, before: before.rms };
}

/** Solves M x = rhs (Gaussian elimination with partial pivoting); null if M is (nearly) singular. */
function solve(M, rhs) {
  const n = rhs.length;
  const a = M.map((row, i) => [...row, rhs[i]]);
  const scale = Math.max(...M.map((row) => Math.max(...row.map(Math.abs))));
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (!(Math.abs(a[pivot][c]) > scale * 1e-12)) return null;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = a[r][c] / a[c][c];
      for (let j = c; j <= n; j++) a[r][j] -= k * a[c][j];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

/**
 * The flight through timed points (least squares): a straight line, bent by gravity `g` (per ms², down Y).
 * Gives where it is and its velocity (per ms) at the last point's time, and where it is at any time.
 */
function fitFlight(points, g) {
  if (points.length < 2) return null;
  const tEnd = points[points.length - 1].t;
  const n = points.length;
  const mt = points.reduce((s, p) => s + p.t, 0) / n;
  const stt = points.reduce((s, p) => s + (p.t - mt) ** 2, 0);
  if (stt <= 0) return null;
  const axis = (k, bend) => {
    const lifted = (p) => p[k] - 0.5 * bend * (p.t - mt) ** 2;
    const m = points.reduce((s, p) => s + lifted(p), 0) / n;
    const slope = points.reduce((s, p) => s + (p.t - mt) * (lifted(p) - m), 0) / stt;
    const at = (t) => m + slope * (t - mt) + 0.5 * bend * (t - mt) ** 2;
    return { at, slope: slope + bend * (tEnd - mt) };
  };
  const [x, y, z] = [axis('x', 0), axis('y', g), axis('z', 0)];
  const position = (t) => ({ x: x.at(t), y: y.at(t), z: z.at(t) });
  return { at: position(tEnd), velocity: { x: x.slope, y: y.slope, z: z.slope }, position };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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
