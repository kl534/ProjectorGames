// How a measured camera sees: its lens (focal length, centre and distortion) and where it is (its pose).
// Webcams aimed at the projected picture get by with a plain pinhole (stereo.js), but the ceiling IR
// cameras have wide, swappable M12 lenses whose barrel distortion bends a ball's path by many pixels
// near the edges, so each is measured (lens-calibration.js) and every spot in its picture is
// straightened before it becomes a sight line. Works on numbers only (no browser code), so it is unit tested.
//
// Two distortion models: 'brown' (radial k1–k3 and tangential p1, p2, as OpenCV's default) for ordinary
// lenses, and 'fisheye' (equidistant, k1–k4 on the angle, as OpenCV's fisheye) for 120° and wider.
//
// Picture coordinates are normalised as everywhere else (0–1 across and down). The lens itself is in
// picture widths: a spot (x, y) is (x, y × imageAspect) picture widths from the top-left, so a focal
// length or centre doesn't change when the camera's mode does (as long as it keeps its aspect).
// The camera's own axes: X right, Y down, Z forward (out of the lens).

/**
 * @typedef {object} Lens
 * @property {'brown'|'fisheye'} model
 * @property {number} fx focal length across, picture widths
 * @property {number} fy focal length down, picture widths (fx for square pixels)
 * @property {number} cx where the optical axis meets the picture, picture widths from the left
 * @property {number} cy the same, picture widths from the top
 * @property {number[]} k radial terms: brown k1–k3, fisheye k1–k4
 * @property {number[]} p tangential terms p1, p2 (brown only)
 * @property {number} imageAspect picture height / width
 * @typedef {{x:number, y:number, z:number}} Vec
 * @typedef {{rotation:number[], translation:Vec}} Pose world → camera: c = R X + t, R row-major 3×3
 */

/** A lens with no distortion (beyond a fisheye's own) that sees `fovDeg` across, centred: a starting guess. */
export function plainLens(fovDeg, imageAspect, model = 'brown') {
  const half = (fovDeg * Math.PI) / 360;
  // A fisheye's picture is even in angle: its edge is half the view's angle out.
  const f = model === 'fisheye' ? 0.5 / half : 0.5 / Math.tan(half);
  return {
    model, fx: f, fy: f, cx: 0.5, cy: imageAspect / 2,
    k: model === 'fisheye' ? [0, 0, 0, 0] : [0, 0, 0], p: [0, 0], imageAspect,
  };
}

/** How wide the lens sees across the picture (degrees), through its centre. */
export function fovOf(lens) {
  const left = rayFor(lens, { x: 0, y: lens.cy / lens.imageAspect });
  const right = rayFor(lens, { x: 1, y: lens.cy / lens.imageAspect });
  return ((Math.atan(-left.x) + Math.atan(right.x)) * 180) / Math.PI;
}

/** The ideal (pinhole) point (a, b) = (X/Z, Y/Z) moved where the lens really puts it. */
export function distort(lens, a, b) {
  if (lens.model === 'fisheye') {
    const r = Math.hypot(a, b);
    if (r < 1e-12) return [a, b];
    const th = Math.atan(r);
    const t2 = th * th;
    const [k1 = 0, k2 = 0, k3 = 0, k4 = 0] = lens.k;
    const thd = th * (1 + t2 * (k1 + t2 * (k2 + t2 * (k3 + t2 * k4))));
    return [(a * thd) / r, (b * thd) / r];
  }
  const [k1 = 0, k2 = 0, k3 = 0] = lens.k;
  const [p1 = 0, p2 = 0] = lens.p;
  const r2 = a * a + b * b;
  const radial = 1 + r2 * (k1 + r2 * (k2 + r2 * k3));
  return [
    a * radial + 2 * p1 * a * b + p2 * (r2 + 2 * a * a),
    b * radial + p1 * (r2 + 2 * b * b) + 2 * p2 * a * b,
  ];
}

/** The ideal point the lens moved to (ad, bd): distort undone, by Newton's method. */
export function undistort(lens, ad, bd) {
  let a = ad;
  let b = bd;
  if (lens.model === 'fisheye') {
    // Straight back through the angle: θd = θ(1 + k1θ² …) solved for θ.
    const rd = Math.hypot(ad, bd);
    if (rd < 1e-12) return [ad, bd];
    const [k1 = 0, k2 = 0, k3 = 0, k4 = 0] = lens.k;
    let th = rd;
    for (let i = 0; i < 20; i++) {
      const t2 = th * th;
      const f = th * (1 + t2 * (k1 + t2 * (k2 + t2 * (k3 + t2 * k4)))) - rd;
      const df = 1 + t2 * (3 * k1 + t2 * (5 * k2 + t2 * (7 * k3 + t2 * 9 * k4)));
      const step = f / df;
      th -= step;
      if (Math.abs(step) < 1e-13) break;
    }
    const r = Math.tan(Math.min(th, Math.PI / 2 - 1e-6));
    return [(ad * r) / rd, (bd * r) / rd];
  }
  for (let i = 0; i < 30; i++) {
    const [u, v] = distort(lens, a, b);
    const eu = u - ad;
    const ev = v - bd;
    if (Math.abs(eu) + Math.abs(ev) < 1e-14) break;
    const h = 1e-7;
    const [ua, va] = distort(lens, a + h, b);
    const [ub, vb] = distort(lens, a, b + h);
    const j11 = (ua - u) / h;
    const j21 = (va - v) / h;
    const j12 = (ub - u) / h;
    const j22 = (vb - v) / h;
    const det = j11 * j22 - j12 * j21;
    if (Math.abs(det) < 1e-12) break;
    a -= (j22 * eu - j12 * ev) / det;
    b -= (-j21 * eu + j11 * ev) / det;
  }
  return [a, b];
}

/**
 * Where a point in the camera's own frame appears in its picture (normalised), or null if behind it.
 * @param {Lens} lens @param {Vec} c
 * @returns {{x:number, y:number}|null}
 */
export function projectWithLens(lens, c) {
  if (!(c.z > 1e-9)) return null;
  const [ad, bd] = distort(lens, c.x / c.z, c.y / c.z);
  return { x: lens.cx + lens.fx * ad, y: (lens.cy + lens.fy * bd) / lens.imageAspect };
}

/**
 * The direction (camera frame, z = 1) of the sight line through a spot in the picture.
 * @param {Lens} lens @param {{x:number, y:number}} p normalised picture coords
 * @returns {Vec}
 */
export function rayFor(lens, p) {
  const [a, b] = undistort(lens, (p.x - lens.cx) / lens.fx, (p.y * lens.imageAspect - lens.cy) / lens.fy);
  return { x: a, y: b, z: 1 };
}

// ---- Poses: rotations as 3-vectors (axis × angle), so a fit can move them freely ----

/** The rotation matrix (row-major 3×3) that turns by |v| radians about v. */
export function rotationFromVector(v) {
  const th = Math.hypot(v[0], v[1], v[2]);
  if (th < 1e-12) return [1, -v[2], v[1], v[2], 1, -v[0], -v[1], v[0], 1];
  const [x, y, z] = [v[0] / th, v[1] / th, v[2] / th];
  const c = Math.cos(th);
  const s = Math.sin(th);
  const C = 1 - c;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}

/** The axis × angle vector of a rotation matrix (row-major 3×3). */
export function vectorFromRotation(R) {
  const cos = Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2));
  const th = Math.acos(cos);
  if (th < 1e-9) return [(R[7] - R[5]) / 2, (R[2] - R[6]) / 2, (R[3] - R[1]) / 2];
  if (Math.PI - th < 1e-6) {
    // Half a turn: the axis is the column of R + I that is longest.
    const cols = [0, 1, 2].map((j) => [R[j] + (j === 0 ? 1 : 0), R[3 + j] + (j === 1 ? 1 : 0), R[6 + j] + (j === 2 ? 1 : 0)]);
    const best = cols.reduce((m, c) => (Math.hypot(...c) > Math.hypot(...m) ? c : m));
    const l = Math.hypot(...best);
    return best.map((v) => (v / l) * th);
  }
  const k = th / (2 * Math.sin(th));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

/** A world point in a camera's frame: R X + t. */
export function toCamera(pose, X) {
  const R = pose.rotation;
  const t = pose.translation;
  return {
    x: R[0] * X.x + R[1] * X.y + R[2] * X.z + t.x,
    y: R[3] * X.x + R[4] * X.y + R[5] * X.z + t.y,
    z: R[6] * X.x + R[7] * X.y + R[8] * X.z + t.z,
  };
}

/** Where a camera with this pose is, in world coordinates: −Rᵀ t. */
export function centreOf(pose) {
  const R = pose.rotation;
  const t = pose.translation;
  return {
    x: -(R[0] * t.x + R[3] * t.y + R[6] * t.z),
    y: -(R[1] * t.x + R[4] * t.y + R[7] * t.z),
    z: -(R[2] * t.x + R[5] * t.y + R[8] * t.z),
  };
}

/** A camera-frame direction in world coordinates: Rᵀ d. */
export function toWorldDirection(pose, d) {
  const R = pose.rotation;
  return {
    x: R[0] * d.x + R[3] * d.y + R[6] * d.z,
    y: R[1] * d.x + R[4] * d.y + R[7] * d.z,
    z: R[2] * d.x + R[5] * d.y + R[8] * d.z,
  };
}

/** A pose as 6 numbers for a fit (rotation vector, translation), and back. */
export function poseToParams(pose) {
  const v = vectorFromRotation(pose.rotation);
  return [v[0], v[1], v[2], pose.translation.x, pose.translation.y, pose.translation.z];
}

export function poseFromParams(q, at = 0) {
  return {
    rotation: rotationFromVector([q[at], q[at + 1], q[at + 2]]),
    translation: { x: q[at + 3], y: q[at + 4], z: q[at + 5] },
  };
}

/**
 * Which of a lens's numbers a fit may move, and how to pack them: focal lengths (one, or two if
 * `squarePixels` is false), centre, radial terms (the first `radial`), tangential (brown, if `tangential`).
 * @param {Lens} lens
 * @param {{squarePixels?: boolean, centre?: boolean, radial?: number, tangential?: boolean}} [free]
 */
export function lensPacking(lens, { squarePixels = true, centre = true, radial = 2, tangential = false } = {}) {
  const nk = Math.min(radial, lens.k.length);
  const tan = tangential && lens.model === 'brown';
  const pack = (l) => [
    l.fx, ...(squarePixels ? [] : [l.fy]), ...(centre ? [l.cx, l.cy] : []),
    ...l.k.slice(0, nk), ...(tan ? l.p : []),
  ];
  const unpack = (q, at = 0) => {
    let i = at;
    const fx = q[i++];
    const fy = squarePixels ? fx : q[i++];
    const [cx, cy] = centre ? [q[i++], q[i++]] : [lens.cx, lens.cy];
    const k = [...lens.k];
    for (let j = 0; j < nk; j++) k[j] = q[i++];
    const p = tan ? [q[i++], q[i++]] : [...lens.p];
    return { ...lens, fx, fy, cx, cy, k, p };
  };
  return { pack, unpack, size: pack(lens).length };
}
