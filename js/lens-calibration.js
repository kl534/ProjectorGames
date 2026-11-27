// Measuring a camera's lens from pictures of a flat checkerboard (Zhang's method): each view of the
// board, its corners where the board says they are and where the camera saw them, gives a homography;
// together they give the focal length, and then every view's pose and the lens's distortion are fitted
// to all the corners at once. Also solving where a measured camera is from points it sees whose places
// are known (the IR markers on the wall, rig.js). Works on numbers only (no browser code), so it is unit
// tested; finding the corners in a picture is separate.

import { fitHomography } from './homography.js';
import { leastSquares } from './least-squares.js';
import {
  fovOf, lensPacking, plainLens, poseFromParams, poseToParams, projectWithLens, rayFor, toCamera,
} from './lens.js';

/**
 * @typedef {import('./lens.js').Lens} Lens
 * @typedef {import('./lens.js').Pose} Pose
 * @typedef {import('./lens.js').Vec} Vec
 * @typedef {{points: Vec[], seen: {x:number, y:number}[]}} View known points (any units, the board's own
 *   frame: z = 0 on a board) and where the camera saw each (normalised picture coords)
 */

/** The inner corners of a checkerboard with `cols` × `rows` of them, `square` apart, in its own plane. */
export function boardCorners(cols, rows, square) {
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ x: c * square, y: r * square, z: 0 });
  return out;
}

/**
 * How well a set of views covers the picture: a `cols` × `rows` grid over it, and in each cell how many of
 * the views' corners fell there. A small board must be moved over the whole picture, its corners included,
 * for the lens's distortion to be known everywhere; this says where it still has to go.
 * @param {View[]} views
 * @param {number} [cols] @param {number} [rows]
 * @returns {{counts:number[][], covered:number}} counts[row][col]; covered: the fraction of cells with any
 */
export function coverage(views, cols = 8, rows = 5) {
  const counts = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (const v of views) {
    for (const p of v.seen) {
      const c = Math.min(cols - 1, Math.max(0, Math.floor(p.x * cols)));
      const r = Math.min(rows - 1, Math.max(0, Math.floor(p.y * rows)));
      counts[r][c]++;
    }
  }
  const covered = counts.flat().filter((n) => n > 0).length / (cols * rows);
  return { counts, covered };
}

/**
 * Measures a lens from several views of a flat board.
 * @param {object} args
 * @param {View[]} args.views at least three, the board turned differently in each; with a board that fits
 *   on letter paper, about 50, together covering the whole picture (coverage)
 * @param {number} args.imageAspect picture height / width
 * @param {number} [args.imageWidth] in pixels, for the result's rmsPixels
 * @param {'brown'|'fisheye'} [args.model]
 * @param {object} [args.free] what to fit (lensPacking's): default square pixels, the centre, two radial terms
 *   (four for a fisheye) and no tangential ones
 * @returns {{lens: Lens, fovDeg: number, rms: number, rmsPixels: number|null, poses: Pose[],
 *   viewRms: number[], sigma: number[]}|null} rms in picture widths; sigma: one standard deviation of each
 *   fitted lens number, in lensPacking's order
 */
export function calibrateLens({ views, imageAspect, imageWidth = null, model = 'brown', free = {} }) {
  const usable = views.filter((v) => v.points.length >= 4 && v.points.length === v.seen.length);
  if (usable.length < 3) return null;
  const start = startingLens(usable, imageAspect, model);
  if (!start) return null;
  const poses = usable.map((v) => planarPose(start, v.points, v.seen));
  if (poses.some((p) => !p)) return null;
  const packing = lensPacking(start, { radial: model === 'fisheye' ? 4 : 2, ...free });
  const x0 = [...packing.pack(start), ...poses.flatMap(poseToParams)];
  const residuals = (q) => {
    const lens = packing.unpack(q);
    const out = [];
    usable.forEach((v, i) => {
      const pose = poseFromParams(q, packing.size + 6 * i);
      for (let j = 0; j < v.points.length; j++) pushOff(out, lens, toCamera(pose, v.points[j]), v.seen[j]);
    });
    return out;
  };
  // Each view's pose moves only that view's corners.
  const starts = [];
  let count = 0;
  for (const v of usable) { starts.push(count); count += 2 * v.points.length; }
  const partial = (q, j) => {
    if (j < packing.size) return { from: 0, values: residuals(q) };
    const i = Math.floor((j - packing.size) / 6);
    const lens = packing.unpack(q);
    const pose = poseFromParams(q, packing.size + 6 * i);
    const values = [];
    for (let k = 0; k < usable[i].points.length; k++) pushOff(values, lens, toCamera(pose, usable[i].points[k]), usable[i].seen[k]);
    return { from: starts[i], values };
  };
  const fit = leastSquares(residuals, x0, { maxIterations: 200, partial });
  const lens = packing.unpack(fit.x);
  const fitted = usable.map((_, i) => poseFromParams(fit.x, packing.size + 6 * i));
  const viewRms = usable.map((v, i) => {
    const out = [];
    for (let j = 0; j < v.points.length; j++) pushOff(out, lens, toCamera(fitted[i], v.points[j]), v.seen[j]);
    return Math.sqrt(out.reduce((s, d) => s + d * d, 0) / out.length);
  });
  return {
    lens,
    fovDeg: fovOf(lens),
    rms: fit.rms,
    rmsPixels: imageWidth ? fit.rms * imageWidth : null,
    poses: fitted,
    viewRms,
    sigma: packing.pack(lens).map((_, i) => Math.sqrt(fit.covariance?.[i]?.[i] ?? NaN)),
  };
}

/**
 * Where a camera with a known lens is, from points it sees whose places are known: at least four on one
 * plane (z = 0) to start from, then refined with all of them.
 * @param {Lens} lens
 * @param {Vec[]} points
 * @param {{x:number, y:number}[]} seen normalised picture coords
 * @param {Pose|null} [guess] start from this instead
 * @returns {{pose: Pose, rms: number, covariance: number[][]|null}|null} rms in picture widths;
 *   covariance of poseToParams' six numbers
 */
export function solvePose(lens, points, seen, guess = null) {
  const onPlane = points.map((p, i) => i).filter((i) => Math.abs(points[i].z) < 1e-9);
  const start = guess ?? (onPlane.length >= 4
    ? planarPose(lens, onPlane.map((i) => points[i]), onPlane.map((i) => seen[i]))
    : null);
  if (!start) return null;
  const residuals = (q) => {
    const pose = poseFromParams(q);
    const out = [];
    for (let j = 0; j < points.length; j++) pushOff(out, lens, toCamera(pose, points[j]), seen[j]);
    return out;
  };
  const fit = leastSquares(residuals, poseToParams(start));
  return { pose: poseFromParams(fit.x), rms: fit.rms, covariance: fit.covariance };
}

/** How far a camera-frame point lands from where it was seen, across and down, in picture widths. */
export function pushOff(out, lens, c, seen) {
  const p = projectWithLens(lens, c);
  if (!p) { out.push(1, 1); return; }
  out.push(p.x - seen.x, (p.y - seen.y) * lens.imageAspect);
}

/**
 * The pose of a plane of points (z = 0) from where a camera saw them: the homography from the plane to
 * the straightened picture is the pose's first two axes and its translation, up to scale.
 * @param {Lens} lens @param {Vec[]} points @param {{x:number, y:number}[]} seen
 * @returns {Pose|null}
 */
export function planarPose(lens, points, seen) {
  const ideal = seen.map((p) => rayFor(lens, p));
  const H = fitHomography(points.map((p) => ({ x: p.x, y: p.y })), ideal.map((r) => ({ x: r.x, y: r.y })));
  if (!H) return null;
  const col = (k) => ({ x: H[k], y: H[3 + k], z: H[6 + k] });
  const [h1, h2, h3] = [col(0), col(1), col(2)];
  let scale = 2 / (len(h1) + len(h2));
  if (h3.z * scale < 0) scale = -scale;
  const r1 = norm(mul(h1, scale));
  const r2raw = mul(h2, scale);
  const r2 = norm(sub(r2raw, mul(r1, dot(r1, r2raw))));
  const r3 = cross(r1, r2);
  return {
    rotation: [r1.x, r2.x, r3.x, r1.y, r2.y, r3.y, r1.z, r2.z, r3.z],
    translation: mul(h3, scale),
  };
}

/**
 * A first guess at the lens: centred, square pixels, no distortion, and the focal length for which every
 * view's board comes out with square corners (the homography's first two columns at right angles and the
 * same length), in least squares over the views.
 */
function startingLens(views, imageAspect, model) {
  const cx = 0.5;
  const cy = imageAspect / 2;
  const guesses = [];
  for (const v of views) {
    const H = fitHomography(v.points.map((p) => ({ x: p.x, y: p.y })), v.seen.map((p) => ({ x: p.x, y: p.y * imageAspect })));
    if (!H) continue;
    const col = (k) => ({ x: H[k], y: H[3 + k], z: H[6 + k] });
    const [g1, g2] = [col(0), col(1)];
    const a = { x: g1.x - cx * g1.z, y: g1.y - cy * g1.z };
    const b = { x: g2.x - cx * g2.z, y: g2.y - cy * g2.z };
    // w = 1/f²: (a·b) w + g1z g2z = 0, and (|a|² − |b|²) w + g1z² − g2z² = 0. A board almost square on
    // to the camera says little (both near 0 = 0), so the median of the views' answers is taken.
    for (const [p, q] of [[a.x * b.x + a.y * b.y, g1.z * g2.z], [a.x * a.x + a.y * a.y - b.x * b.x - b.y * b.y, g1.z * g1.z - g2.z * g2.z]]) {
      const w = -q / p;
      if (w > 0 && Number.isFinite(w)) guesses.push(1 / Math.sqrt(w));
    }
  }
  guesses.sort((a, b) => a - b);
  const f = guesses.length ? guesses[Math.floor(guesses.length / 2)] : 0.5 / Math.tan((65 * Math.PI) / 360);
  const lens = plainLens(90, imageAspect, model);
  return { ...lens, fx: f, fy: f, cx, cy };
}

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const mul = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (a) => Math.sqrt(dot(a, a));
const norm = (a) => mul(a, 1 / len(a));
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
