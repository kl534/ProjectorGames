// The measured camera rig: IR cameras on the ceiling behind the players, which can't see the projected
// picture (an 850 nm filter), placed in the room from what they can see, and the picture placed on the
// wall by a third camera that sees both. Works on numbers only (no browser code), so it is unit tested.
//
// Each IR camera's lens is measured first (lens-calibration.js). It is placed from IR markers (LEDs or
// reflective dots) fixed on the wall, whose places are measured once by hand (placeCamera). A wand, a stick
// with a marker at each end whose length is measured, waved through the room where the ball flies, then
// refines both cameras together (refineRig): every place both cameras saw an end must be one point, and the
// two ends the wand's length apart, which pins down where the cameras are relative to each other far better
// than four markers on the wall can. The projected picture can move between sessions, so it is placed on
// the wall afresh each time (placeScreen) by a camera without the filter, which sees the IR markers (an
// unfiltered sensor sees 850 nm) and the projector's own calibration markers in one picture.
//
// The wall frame is in metres, as the markers were measured: X along the wall to the right (as the players
// see it), Y down, Z into the wall, from wherever the measuring started (say the top-left marker). The rest
// of the code works in room coordinates (stereo.js): screen widths from the picture's top-left corner, X
// across, Y down, Z into the wall; rigCameraModel turns a placed camera into one of those.

import { modelMap } from './camera-map.js';
import { applyHomography, computeHomography, fitHomography, invertHomography } from './homography.js';
import { leastSquares } from './least-squares.js';
import { pushOff, solvePose } from './lens-calibration.js';
import {
  centreOf, fovOf, lensPacking, poseFromParams, poseToParams, rayFor, toCamera, toWorldDirection,
} from './lens.js';

/**
 * @typedef {import('./lens.js').Lens} Lens
 * @typedef {import('./lens.js').Pose} Pose
 * @typedef {import('./lens.js').Vec} Vec
 * @typedef {{x:number, y:number}} Spot normalised picture coords
 * @typedef {{id:string, at:Vec}} Marker a marker's place in the wall frame (metres)
 * @typedef {object} RigCamera
 * @property {Lens} lens
 * @property {Pose} pose wall frame → camera
 * @property {number} [rms] how far the markers land from where they were seen (picture widths)
 * @typedef {object} ScreenPlacement where the projected picture is on the wall (wall frame, metres)
 * @property {Vec} origin its top-left corner
 * @property {Vec} across top-left to top-right
 * @property {Vec} down top-left to bottom-left
 * @property {Vec[]} axes unit vectors: across, down (square to across), into the wall
 * @property {number} width metres
 * @property {number} height metres
 * @property {number} aspect height / width
 * @property {number} skew how far the corners are from a true rectangle at worst (metres)
 */

// Picture noise assumed when weighing a wand's length against where it was seen: a blob's centre is good
// to about a third of a pixel at 640 across.
const SPOT_SIGMA = 0.3 / 640;
// The wand's length is known to about this (metres).
const WAND_LENGTH_SIGMA = 0.001;
// Matching spots to markers by trying every way round is done for at most this many markers.
const MAX_MATCHED_MARKERS = 7;
// A wand moment is only used where pairing its ends one way round fits better than the other by this (metres).
const PAIRING_CLEAR_M = 0.05;
const GRAVITY = 9.80665; // m/s²

/**
 * Places a measured camera from the markers it sees. `spots` are where it saw them: either in the
 * markers' order (null for one it didn't see), or, with `match`, in any order, and every way of pairing
 * them with the markers is tried for the one that fits best with the camera upright and in front of the wall.
 * @param {Lens} lens
 * @param {Marker[]} markers at least four on the wall itself (z = 0)
 * @param {(Spot|null)[]} spots
 * @param {{match?: boolean}} [opts]
 * @returns {(RigCamera & {centre: Vec, centreSigma: number|null, matched: (number|null)[]})|null}
 *   centreSigma: one standard deviation of where it is (metres, the largest direction's); matched: for
 *   each spot, which marker it is
 */
export function placeCamera(lens, markers, spots, { match = false } = {}) {
  const tries = match ? assignments(spots.length, markers.length) : [spots.map((_, i) => i)];
  let best = null;
  for (const which of tries) {
    const pairs = which.map((m, i) => (m === null || !spots[i] ? null : { marker: markers[m], spot: spots[i] })).filter(Boolean);
    if (pairs.filter((p) => Math.abs(p.marker.at.z) < 1e-9).length < 4) continue;
    const found = solvePose(lens, pairs.map((p) => p.marker.at), pairs.map((p) => p.spot));
    if (!found || !upright(found.pose)) continue;
    if (!best || found.rms < best.found.rms) best = { found, which };
  }
  if (!best) return null;
  const { pose, rms, covariance } = best.found;
  return {
    lens, pose, rms, centre: centreOf(pose), centreSigma: centreSigmaOf(pose, covariance), matched: best.which,
  };
}

/**
 * Which spot is which marker, when a camera's picture has spots that aren't markers (a light, a reflection)
 * and markers it can't see (behind something). The markers are on the wall, so for any four of them and four
 * spots there is one homography from the wall to the picture: each such pairing is tried (only those turned
 * the same way round, as a camera in front of the wall sees them), every other marker is put through it, and
 * the pairing that lands the most markers on spots wins (then the smallest misses). Spots are straightened
 * first, by the camera's lens if it was measured.
 * @param {Marker[]} markers
 * @param {Spot[]} spots
 * @param {object} [opts]
 * @param {Lens|null} [opts.lens] the camera's measured lens
 * @param {number} [opts.imageAspect] picture height / width, without a lens
 * @param {number} [opts.tolerance] how far a marker may land from its spot, as a fraction of the picture's width
 * @returns {{matched: (Spot|null)[], found: number, rms: number}|null} matched: each marker's spot (null: not
 *   seen), in the markers' order; found: how many; rms: how far they landed from them (picture widths); null if
 *   fewer than four could be matched
 */
export function matchMarkers(markers, spots, { lens = null, imageAspect = 0.75, tolerance = 0.006 } = {}) {
  const onWall = markers.map((m, i) => i).filter((i) => Math.abs(markers[i].at.z) < 1e-9);
  // The brightest few (findSpots gives them brightest first): enough for every marker and some strays.
  spots = spots.slice(0, Math.max(onWall.length + 4, 10));
  if (onWall.length < 4 || spots.length < 4) return null;
  // Straightened, and in the same units across and down; the tolerance with them.
  const flat = spots.map((p) => (lens ? rayFor(lens, p) : { x: p.x, y: p.y * imageAspect }));
  const tol = lens ? tolerance / lens.fx : tolerance;
  const wall = markers.map((m) => ({ x: m.at.x, y: m.at.y }));
  const turn = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  const sameWay = (ms, ss) => [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]
    .every(([i, j, k]) => turn(ms[i], ms[j], ms[k]) === turn(ss[i], ss[j], ss[k]));
  let best = null;
  const quads = combinations(onWall, 4);
  const tuples = orderedTuples(spots.length, 4);
  for (const quad of quads) {
    const ms = quad.map((i) => wall[i]);
    for (const tuple of tuples) {
      const ss = tuple.map((j) => flat[j]);
      if (!sameWay(ms, ss)) continue;
      const H = computeHomography(ms, ss);
      if (!H) continue;
      // Every marker through it, each to its nearest spot not yet taken.
      const taken = new Set();
      const which = new Array(markers.length).fill(-1);
      let sum = 0;
      let found = 0;
      for (const i of onWall) {
        const q = applyHomography(H, wall[i]);
        let bestJ = -1;
        let bestD = tol;
        for (let j = 0; j < flat.length; j++) {
          if (taken.has(j)) continue;
          const d = Math.hypot(flat[j].x - q.x, flat[j].y - q.y);
          if (d <= bestD) { bestD = d; bestJ = j; }
        }
        if (bestJ < 0) continue;
        taken.add(bestJ);
        which[i] = bestJ;
        sum += bestD * bestD;
        found++;
      }
      const rms = Math.sqrt(sum / Math.max(1, found));
      if (found >= 4 && (!best || found > best.found || (found === best.found && rms < best.rms))) best = { which, found, rms };
    }
    if (best && best.found === onWall.length && best.rms < tol / 5) break;
  }
  if (!best) return null;
  return {
    matched: best.which.map((j) => (j < 0 ? null : spots[j])),
    found: best.found,
    rms: best.rms * (lens ? lens.fx : 1),
  };
}

/** Every way of choosing k of the items (in their order). */
function combinations(items, k) {
  const out = [];
  const pick = (from, chosen) => {
    if (chosen.length === k) { out.push([...chosen]); return; }
    for (let i = from; i < items.length; i++) { chosen.push(items[i]); pick(i + 1, chosen); chosen.pop(); }
  };
  pick(0, []);
  return out;
}

/** Every ordered choice of k different indices below n. */
function orderedTuples(n, k) {
  const out = [];
  const used = new Array(n).fill(false);
  const pick = (chosen) => {
    if (chosen.length === k) { out.push([...chosen]); return; }
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      used[j] = true; chosen.push(j); pick(chosen); chosen.pop(); used[j] = false;
    }
  };
  pick([]);
  return out;
}

/**
 * Whether markers on the wall are spread enough to place a camera from: some four of them with no three nearly
 * in a line (every triangle of the four at least a fiftieth of the square on their widest gap). Four markers with
 * three in a line say nothing certain about where the camera is.
 * @param {Marker[]} seen the markers a camera matched
 */
export function wellSpread(seen) {
  const pts = seen.filter((m) => Math.abs(m.at.z) < 1e-9).map((m) => m.at);
  if (pts.length < 4) return false;
  let widest = 0;
  for (const p of pts) for (const q of pts) widest = Math.max(widest, Math.hypot(p.x - q.x, p.y - q.y));
  const area = (a, b, c) => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  const least = (widest * widest) / 50;
  return combinations(pts, 4).some(([a, b, c, d]) => [[a, b, c], [a, b, d], [a, c, d], [b, c, d]].every(([p, q, t]) => area(p, q, t) >= least));
}

/** The camera is in front of the wall (Z < 0), facing it, and not upside down (its down is the room's). */
function upright(pose) {
  const c = centreOf(pose);
  const down = toWorldDirection(pose, { x: 0, y: 1, z: 0 });
  const forward = toWorldDirection(pose, { x: 0, y: 0, z: 1 });
  return c.z < 0 && forward.z > 0 && down.y > 0;
}

/** Every way of giving each of `n` spots a different marker of `m` (all spots used if n ≤ m). */
function assignments(n, m) {
  if (m > MAX_MATCHED_MARKERS || n > m) return [];
  const out = [];
  const used = new Array(m).fill(false);
  const pick = [];
  const go = () => {
    if (pick.length === n) { out.push([...pick]); return; }
    for (let j = 0; j < m; j++) {
      if (used[j]) continue;
      used[j] = true;
      pick.push(j);
      go();
      pick.pop();
      used[j] = false;
    }
  };
  go();
  return out;
}

/**
 * Where the camera is, as a standard deviation (metres) in its least certain direction, from its pose's
 * covariance (rotation vector, translation): the centre is −Rᵀ t, so that is carried through numerically.
 */
function centreSigmaOf(pose, covariance) {
  if (!covariance) return null;
  const q = poseToParams(pose);
  const c0 = centreOf(pose);
  const J = [[], [], []];
  for (let j = 0; j < 6; j++) {
    const h = 1e-7;
    const qh = [...q];
    qh[j] += h;
    const c = centreOf(poseFromParams(qh));
    J[0][j] = (c.x - c0.x) / h;
    J[1][j] = (c.y - c0.y) / h;
    J[2][j] = (c.z - c0.z) / h;
  }
  let worst = 0;
  // The largest diagonal of J C Jᵀ is a fair stand-in for its largest direction.
  for (let r = 0; r < 3; r++) {
    let v = 0;
    for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) v += J[r][a] * covariance[a][b] * J[r][b];
    worst = Math.max(worst, v);
  }
  return Math.sqrt(worst);
}

/**
 * Places the projected picture on the wall from a camera that sees both the IR markers and the projector's
 * calibration (its homography from its picture to the screen). The wall is flat, so where the markers are in
 * its picture gives the homography from the wall to its picture, and the picture's corners go through both.
 * With the camera's lens measured, its spots are straightened first; without, a webcam's mild distortion is
 * left in.
 * @param {object} args
 * @param {Marker[]} args.markers
 * @param {(Spot|null)[]} args.spots where that camera saw each marker (null: not seen), at least four on the wall
 * @param {number[]} args.cameraToScreen its calibration homography (normalised camera → normalised screen)
 * @param {Lens|null} [args.lens]
 * @returns {ScreenPlacement|null}
 */
export function placeScreen({ markers, spots, cameraToScreen, lens = null }) {
  const straight = (p) => (lens ? rayFor(lens, p) : p);
  const pairs = markers.map((m, i) => ({ m, s: spots[i] })).filter((p) => p.s && Math.abs(p.m.at.z) < 1e-9);
  if (pairs.length < 4) return null;
  const wallToPicture = fitHomography(pairs.map((p) => ({ x: p.m.at.x, y: p.m.at.y })), pairs.map((p) => straight(p.s)));
  const pictureToWall = wallToPicture && invertHomography(wallToPicture);
  const screenToCamera = invertHomography(cameraToScreen);
  if (!pictureToWall || !screenToCamera) return null;
  const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }].map((c) => {
    const w = applyHomography(pictureToWall, straight(applyHomography(screenToCamera, c)));
    return { x: w.x, y: w.y, z: 0 };
  });
  return screenFromCorners(corners);
}

/**
 * The picture's placement from its four corners on the wall (wall frame, metres), clockwise from the top-left,
 * as placeScreen finds them or as measured by hand.
 * @param {Vec[]} corners
 * @returns {ScreenPlacement}
 */
export function screenFromCorners([tl, tr, br, bl]) {
  // Across and down averaged over both edges, so a slightly keystoned picture is taken at its middle.
  const across = times(plus(minus(tr, tl), minus(br, bl)), 0.5);
  const down = times(plus(minus(bl, tl), minus(br, tr)), 0.5);
  const ex = normalise(across);
  const ey = normalise(minus(down, times(ex, dot(ex, down))));
  const ez = cross(ex, ey);
  const width = length(across);
  const height = dot(down, ey);
  const ideal = [tl, plus(tl, times(ex, width)), plus(tl, plus(times(ex, width), times(ey, height))), plus(tl, times(ey, height))];
  const skew = Math.max(...[tl, tr, br, bl].map((c, i) => length(minus(c, ideal[i]))));
  return { origin: tl, across, down, axes: [ex, ey, ez], width, height, aspect: height / width, skew };
}

/** A wall-frame point (metres) in room coordinates (screen widths from the picture's top-left). */
export function roomFromWall(screen, p) {
  const rel = minus(p, screen.origin);
  const [ex, ey, ez] = screen.axes;
  return { x: dot(rel, ex) / screen.width, y: dot(rel, ey) / screen.width, z: dot(rel, ez) / screen.width };
}

/** A room point (screen widths) in the wall frame (metres). */
export function wallFromRoom(screen, p) {
  const [ex, ey, ez] = screen.axes;
  const w = screen.width;
  return plus(screen.origin, plus(times(ex, p.x * w), plus(times(ey, p.y * w), times(ez, p.z * w))));
}

/** Gravity in screen widths a second², down the screen, for the picture's measured width. */
export function gravityFor(screen) {
  return GRAVITY / screen.width;
}

/**
 * A placed camera as stereo.js's CameraModel, in room coordinates, carrying its lens so its sight lines are
 * straightened (rayThrough, projectToCamera).
 * @param {RigCamera} camera
 * @param {ScreenPlacement} screen
 * @returns {import('./stereo.js').CameraModel}
 */
export function rigCameraModel(camera, screen) {
  const [ex, ey, ez] = screen.axes;
  const inRoom = (d) => ({ x: dot(d, ex), y: dot(d, ey), z: dot(d, ez) });
  const axes = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }].map((e) => inRoom(toWorldDirection(camera.pose, e)));
  const centre = roomFromWall(screen, centreOf(camera.pose));
  return {
    centre,
    axes,
    focal: camera.lens.fx,
    focalFrom: 'measured',
    mirrored: false,
    imageAspect: camera.lens.imageAspect,
    fovDeg: fovOf(camera.lens),
    distance: -centre.z,
    angleDeg: (Math.acos(Math.min(1, Math.abs(axes[2].z))) * 180) / Math.PI,
    lens: camera.lens,
  };
}

// ---- A calibration from the rig ----

/**
 * One measured camera of a rig as a calibration the games can use (storage.js's CameraCalibration): its lens
 * and pose (`measured`), and, worked out from them, what a calibration from the flashing corners would have
 * had: where it sees the picture's corners, and the nearest homography from its picture to the screen. Those
 * are only for what needs them roughly (the outline drawn in Setup and the debug view, Ball Test's lens
 * refining); the detector and tracker use `measured` (camera-map.js's modelMap).
 * @param {object} args
 * @param {RigCamera} args.camera
 * @param {ScreenPlacement} args.screen
 * @param {string|null} args.cameraId @param {string} args.cameraLabel
 * @param {number} args.videoWidth @param {number} args.videoHeight
 * @param {number} [args.latencyMs] @param {import('./camera.js').CameraMode} [args.cameraMode]
 * @returns {import('./storage.js').CameraCalibration}
 */
export function rigCameraCalibration({ camera, screen, cameraId, cameraLabel, videoWidth, videoHeight, latencyMs, cameraMode }) {
  const map = modelMap(rigCameraModel(camera, screen), screen.aspect);
  const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  // A corner behind the camera's view (it can't be, for a camera facing the wall) is put where the homography
  // puts it: these are only drawn.
  const back = invertHomography(map.cameraToScreen);
  const seen = corners.map((c) => map.toCamera(c) ?? applyHomography(back, c));
  return {
    cameraId,
    cameraLabel,
    videoWidth,
    videoHeight,
    markersCamera: seen,
    markersScreen: corners,
    screenCornersCamera: seen,
    cameraToScreen: map.cameraToScreen,
    frameClock: 'stream',
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(cameraMode ? { cameraMode } : {}),
    measured: { lens: camera.lens, pose: camera.pose },
  };
}

/**
 * A whole rig as the calibration the games are given: the first camera's, the second's (`second`), and where
 * the picture is on the wall (`wall`: its corners in the wall frame, metres), from which its shape and width
 * come too.
 * @param {object} args
 * @param {Parameters<typeof rigCameraCalibration>[0][]} args.cameras one or two, without `screen`
 * @param {ScreenPlacement} args.screen
 * @param {string} [args.createdAt]
 * @returns {import('./storage.js').Calibration}
 */
export function rigCalibration({ cameras, screen, createdAt = new Date().toISOString() }) {
  const [main, second] = cameras.map((c) => rigCameraCalibration({ ...c, screen }));
  return {
    createdAt,
    screenAspect: screen.aspect,
    wall: { corners: wallCorners(screen) },
    ...main,
    ...(second ? { second } : {}),
  };
}

/** The picture's four corners on the wall (metres), clockwise from the top-left. */
export function wallCorners(screen) {
  return [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: screen.aspect }, { x: 0, y: screen.aspect }]
    .map((p) => wallFromRoom(screen, { ...p, z: 0 }));
}

// ---- The wand ----

/**
 * @typedef {{t:number, ends:Spot[]}} WandFrame one camera's picture of the wand: its two ends' spots, at
 *   that frame's time (ms)
 * @typedef {{a:Spot[], b:Spot[]}} WandSample both ends as each of two cameras saw them at one moment, each
 *   camera's either way round (refineRig pairs them)
 */

/**
 * Pairs two cameras' pictures of a wand moved slowly through the room. Their frames aren't taken at the
 * same moments, so the second camera's ends are interpolated to the first's frame times (where it has frames
 * either side within `maxGapMs`), each end of the later frame matched to the nearer end of the earlier. Which of
 * the second camera's ends is which of the first's isn't decided here: an end hidden for a moment can swap the
 * order a camera lists them in, so refineRig decides it afresh for every moment, by where the sight lines meet.
 * @param {WandFrame[]} first @param {WandFrame[]} second in time order
 * @param {number} [maxGapMs]
 * @returns {WandSample[]}
 */
export function wandSamples(first, second, maxGapMs = 40) {
  const a = first.filter((f) => f.ends.length === 2);
  const b = second.filter((f) => f.ends.length === 2);
  const out = [];
  let j = 0;
  for (const fa of a) {
    while (j + 1 < b.length && b[j + 1].t <= fa.t) j++;
    const p = b[j];
    const q = b[j + 1];
    if (!p || !q || p.t > fa.t || q.t - p.t > maxGapMs) continue;
    const k = (fa.t - p.t) / (q.t - p.t);
    const later = spotGap(q.ends[1], p.ends[0]) + spotGap(q.ends[0], p.ends[1]) < spotGap(q.ends[0], p.ends[0]) + spotGap(q.ends[1], p.ends[1])
      ? [q.ends[1], q.ends[0]] : q.ends;
    out.push({ a: fa.ends, b: p.ends.map((e, i) => ({ x: e.x + (later[i].x - e.x) * k, y: e.y + (later[i].y - e.y) * k })) });
  }
  return out;
}

const spotGap = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

/**
 * Refines two placed cameras together from the markers and a wand. Each wand end both cameras saw is put
 * where their sight lines meet, and the cameras are moved (and their lenses, if `freeLens`) until every
 * marker and every end lands where it was seen and every wand is its measured length. The markers keep the
 * cameras in the wall frame; the wand is what fixes them to each other, all through the space the ball flies in.
 * @param {object} args
 * @param {RigCamera[]} args.cameras two, placed (placeCamera)
 * @param {Marker[]} args.markers
 * @param {(Spot|null)[][]} args.markerSpots for each camera, where it saw each marker (null: not seen)
 * @param {{length:number, samples:WandSample[]}} args.wand length in metres
 * @param {object|false} [args.freeLens] lensPacking's options for what of each lens to refine; false: keep them
 * @param {number} [args.spotSigma] how good a wand end's spot is in one frame (picture widths)
 * @param {number} [args.markerSigma] how good a marker's spot is (picture widths): averaged over many frames it
 *   is much better than one, but the marker's measured place is only good to a few millimetres too
 * @param {boolean} [args.freeLength] leave the wand's length out of it, so the markers alone say how big the
 *   room is (and `lengths` then says how long they make the wand)
 * @returns {{cameras: RigCamera[], markerRms: number, wandRms: number, lengthRms: number,
 *   lengths: number[], centreSigma: number[], swapped: boolean}|null} swapped: the second camera listed the ends
 *   the other way round at most moments; rms in picture widths; lengthRms in
 *   metres; lengths: each sample's wand length as the refined rig sees it; centreSigma: each camera's (metres)
 */
export function refineRig({
  cameras, markers, markerSpots, wand, freeLens = false, spotSigma = SPOT_SIGMA, markerSigma = SPOT_SIGMA, freeLength = false,
}) {
  if (cameras.length !== 2 || !wand.samples.length) return null;
  const packings = cameras.map((c) => (freeLens ? lensPacking(c.lens, freeLens) : null));
  const sizes = packings.map((p) => 6 + (p?.size ?? 0));
  const unpack = (q) => {
    let at = 0;
    return cameras.map((c, i) => {
      const pose = poseFromParams(q, at);
      const lens = packings[i] ? packings[i].unpack(q, at + 6) : c.lens;
      at += sizes[i];
      return { lens, pose };
    });
  };
  const x0 = cameras.flatMap((c, i) => [...poseToParams(c.pose), ...(packings[i]?.pack(c.lens) ?? [])]);
  // Which of the second camera's ends is which of the first's, for each moment (a camera can list them either
  // way round from one moment to the next): the way round whose sight lines meet and make a wand of its length.
  // Where the two ways come out much the same (the wand lying along the line between the cameras), the moment
  // is left out.
  const flips = [];
  const samples = [];
  for (const smp of wand.samples) {
    const straight = pairingMiss(cameras, smp, false, wand.length);
    const crossed = pairingMiss(cameras, smp, true, wand.length);
    if (Math.abs(straight - crossed) < PAIRING_CLEAR_M) continue;
    flips.push(crossed < straight);
    samples.push({ a: smp.a, b: crossed < straight ? [smp.b[1], smp.b[0]] : smp.b });
  }
  if (!samples.length) return null;
  const swapped = flips.filter(Boolean).length > flips.length / 2;
  const parts = (q) => {
    const rig = unpack(q);
    const markerOff = [];
    rig.forEach((c, i) => markers.forEach((m, j) => {
      const s = markerSpots[i][j];
      if (s) pushOff(markerOff, c.lens, toCamera(c.pose, m.at), s);
    }));
    const wandOff = [];
    const lengthOff = [];
    for (const s of samples) {
      const ends = [0, 1].map((e) => meet(rig, s.a[e], s.b[e]));
      if (ends.some((e) => !e)) { wandOff.push(1, 1, 1, 1, 1, 1, 1, 1); lengthOff.push(1); continue; }
      ends.forEach((p, e) => {
        pushOff(wandOff, rig[0].lens, toCamera(rig[0].pose, p), s.a[e]);
        pushOff(wandOff, rig[1].lens, toCamera(rig[1].pose, p), s.b[e]);
      });
      lengthOff.push(length(minus(ends[0], ends[1])) - wand.length);
    }
    return { markerOff, wandOff, lengthOff };
  };
  // Every kind of measurement counts by how good it is. Each wand end is put where its two sight lines meet
  // rather than fitted, so its length scatters by as much as a frame's noise moves those (millimetres, 5 m
  // away), not just by how well the wand was measured: that scatter is taken from a first fit, then refitted.
  // Left free: so loose that it pulls on nothing.
  let lengthSigma = freeLength ? 1e3 : WAND_LENGTH_SIGMA;
  let fit = null;
  let x = x0;
  for (let pass = 0; pass < 2; pass++) {
    const sigma = lengthSigma;
    fit = leastSquares((q) => {
      const { markerOff, wandOff, lengthOff } = parts(q);
      return [...markerOff.map((d) => d / markerSigma), ...wandOff.map((d) => d / spotSigma), ...lengthOff.map((d) => d / sigma)];
    }, x, { maxIterations: 60 });
    x = fit.x;
    const { lengthOff } = parts(x);
    if (!freeLength) lengthSigma = Math.max(WAND_LENGTH_SIGMA, Math.sqrt(lengthOff.reduce((a, d) => a + d * d, 0) / lengthOff.length));
  }
  const rig = unpack(fit.x);
  const { markerOff, wandOff, lengthOff } = parts(fit.x);
  const rms = (v) => Math.sqrt(v.reduce((a, d) => a + d * d, 0) / Math.max(1, v.length));
  // The fit's covariance is in units of its residuals, which are in sigmas: as they should be if the sigmas
  // are right, so it is used as it is, not scaled by the fit's own scatter.
  const scale = 1 / (fit.sigma * fit.sigma);
  let at = 0;
  const centreSigma = rig.map((c, i) => {
    const block = fit.covariance?.slice(at, at + 6).map((row) => row.slice(at, at + 6).map((v) => v * scale)) ?? null;
    at += sizes[i];
    return centreSigmaOf(c.pose, block);
  });
  return {
    cameras: rig.map((c, i) => ({ ...cameras[i], ...c })),
    markerRms: rms(markerOff),
    wandRms: rms(wandOff),
    lengthRms: rms(lengthOff),
    lengths: lengthOff.map((d) => d + wand.length),
    centreSigma,
    swapped,
  };
}

/** Where two placed cameras' sight lines through these spots meet (wall frame), or null if they don't. */
export function meet(rig, spotA, spotB) {
  const rays = [[rig[0], spotA], [rig[1], spotB]].map(([c, s]) => ({
    origin: centreOf(c.pose), dir: normalise(toWorldDirection(c.pose, rayFor(c.lens, s))),
  }));
  const met = closest(rays[0], rays[1]);
  return met?.point ?? null;
}

/**
 * How badly a moment's ends fit, paired one way round: how far apart the two cameras' sight lines through each
 * end pass, and how far the wand they make is from its length (metres, summed).
 */
function pairingMiss(cameras, sample, swapped, wandLength) {
  let miss = 0;
  const ends = [];
  for (let e = 0; e < 2; e++) {
    const rays = [[cameras[0], sample.a[e]], [cameras[1], sample.b[swapped ? 1 - e : e]]].map(([c, p]) => ({
      origin: centreOf(c.pose), dir: normalise(toWorldDirection(c.pose, rayFor(c.lens, p))),
    }));
    const met = closest(rays[0], rays[1]);
    if (!met) return Infinity;
    miss += met.gap;
    ends.push(met.point);
  }
  return miss + Math.abs(length(minus(ends[0], ends[1])) - wandLength);
}

/** The point nearest to both rays, and how far apart they pass. Null if they are (nearly) parallel. */
function closest(a, b) {
  const w0 = minus(a.origin, b.origin);
  const ab = dot(a.dir, b.dir);
  const d = dot(a.dir, w0);
  const e = dot(b.dir, w0);
  const denom = 1 - ab * ab;
  if (denom < 1e-9) return null;
  const s = (ab * e - d) / denom;
  const u = (e - ab * d) / denom;
  const pa = plus(a.origin, times(a.dir, s));
  const pb = plus(b.origin, times(b.dir, u));
  return { point: times(plus(pa, pb), 0.5), gap: length(minus(pa, pb)) };
}

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const plus = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const minus = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const times = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const length = (a) => Math.sqrt(dot(a, a));
const normalise = (a) => times(a, 1 / length(a));
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
