// The maths behind Golden Boot's 3D picture, kept free of the browser so it can
// be unit-tested: the camera behind the penalty spot, how a point on the screen
// becomes a point on the goal and back, how the ball and the net move, and how a
// crowd of hundreds of small shapes is baked into one for drawing.
//
// The world is measured in metres. X is across the goal (to the right as the
// kicker sees it), Y is up from the grass and Z is towards the kicker: the goal
// line is z = 0, the penalty spot z = 11. The camera is behind the spot, above
// head height, looking at the goal, which fills half the width of the screen. Matrices and the solid shapes are
// the ones Dunk the Clown uses (dunk-the-clown-models.js).

import {
  boxMesh, coneMesh, cylinderMesh, identity, multiply, perspective, project, quadMesh, sphereMesh, torusMesh,
} from './dunk-the-clown-models.js';
import { GOLDEN_BOOT_RULES } from './golden-boot-logic.js';

export { project, seededRandom } from './dunk-the-clown-models.js';

/** @typedef {{positions: Float32Array, normals: Float32Array, colours: Float32Array, indices: Uint32Array}} BakedMesh */

/**
 * Where the camera is and where it looks (metres): the spot is 11 m out and the eye 8 m behind it, as a
 * camera behind the kicker sees a penalty. How wide it sees is set by the screen's shape, so that the
 * goal (from the outside of one post to the outside of the other) is `goalShare` of the screen's width;
 * but it never sees less than `minFovDeg` from top to bottom, so on a very wide screen the ball on the
 * spot is still in the picture (and the goal a little smaller).
 */
export const CAMERA = {
  eye: [0, 2.2, 19],
  lookY: 0.4,
  goalShare: 0.5,
  minFovDeg: 22,
  near: 0.5,
  far: 300,
};

// ---- Camera ----

/**
 * The camera for a screen: it looks at the goal from behind the spot, and the
 * goal fills the middle half of the screen's width, with the pitch and the stands round it.
 * @param {{width: number, height: number}} view screen size in pixels
 */
export function makeCamera(view) {
  const { eye, lookY, goalShare, minFovDeg, near, far } = CAMERA;
  const aspect = view.width / view.height;
  const f = unit([0 - eye[0], lookY - eye[1], 0 - eye[2]]);
  const right = unit(cross(f, [0, 1, 0]));
  const up = cross(right, f);
  // The outside of a post, halfway up: as far across the screen as `goalShare` puts it.
  const { halfWidth, post, height } = GOLDEN_BOOT_RULES.goal;
  const toPost = [halfWidth + post - eye[0], height / 2 - eye[1], -eye[2]];
  const tanY = Math.max(dot(toPost, right) / dot(toPost, f) / (goalShare * aspect), Math.tan((minFovDeg * Math.PI) / 360));
  const fovY = 2 * Math.atan(tanY);
  const viewMatrix = new Float32Array([
    right[0], up[0], -f[0], 0,
    right[1], up[1], -f[1], 0,
    right[2], up[2], -f[2], 0,
    -dot(right, eye), -dot(up, eye), dot(f, eye), 1,
  ]);
  const proj = perspective(fovY, aspect, near, far);
  return {
    width: view.width, height: view.height, aspect, fovY, tanY,
    eye: [...eye], forward: f, right, up,
    proj, view: viewMatrix, viewProj: multiply(proj, viewMatrix),
  };
}

/**
 * Where a spot on the screen is on the plane of the goal mouth (or another plane
 * z = `z`): the camera's ray through the point, met with the plane. The inverse of `project`.
 * @param {ReturnType<typeof makeCamera>} camera
 * @param {{x: number, y: number}} screen normalised, 0–1 across and down
 * @returns {{x: number, y: number}} metres
 */
export function shotPoint(camera, screen, z = 0) {
  const dir = rayThrough(camera, screen);
  const t = (z - camera.eye[2]) / dir[2];
  return { x: camera.eye[0] + dir[0] * t, y: camera.eye[1] + dir[1] * t };
}

/**
 * Where the camera's ray through a spot on the screen meets the grass (y = 0): `x` across and `z` out from
 * the goal line (metres). Null if the ray never comes down to it.
 * @returns {{x: number, z: number}|null}
 */
export function groundPoint(camera, screen) {
  const dir = rayThrough(camera, screen);
  if (!(dir[1] < 0)) return null;
  const t = -camera.eye[1] / dir[1];
  return { x: camera.eye[0] + dir[0] * t, z: camera.eye[2] + dir[2] * t };
}

/** The direction (not unit) of the camera's ray through a point of the screen. */
function rayThrough(camera, screen) {
  const nx = screen.x * 2 - 1;
  const ny = 1 - screen.y * 2;
  const { forward: f, right: r, up: u, tanY, aspect } = camera;
  return [0, 1, 2].map((i) => f[i] + r[i] * nx * tanY * aspect + u[i] * ny * tanY);
}

/**
 * Where to put a flat picture (a Start target) so that it faces the camera, `depth` metres
 * in front of it along the line of sight, and appears at a spot on the screen. `unit` is how
 * many metres one vmin (the shorter side of the screen) is at that depth, so a radius given in
 * vmin times `unit` looks that size on the screen.
 * @returns {{m: Float32Array, unit: number}} m turns a shape facing +z into one facing the camera, at that spot
 */
export function billboard(camera, screen, depth) {
  const nx = screen.x * 2 - 1;
  const ny = 1 - screen.y * 2;
  const { forward: f, right: r, up: u, tanY, aspect, eye } = camera;
  const p = [0, 1, 2].map((i) => eye[i] + f[i] * depth + r[i] * nx * tanY * aspect * depth + u[i] * ny * tanY * depth);
  const m = identity();
  m[0] = r[0]; m[1] = r[1]; m[2] = r[2];
  m[4] = u[0]; m[5] = u[1]; m[6] = u[2];
  m[8] = -f[0]; m[9] = -f[1]; m[10] = -f[2];
  m[12] = p[0]; m[13] = p[1]; m[14] = p[2];
  const vmin = Math.min(camera.width, camera.height);
  return { m, unit: (2 * depth * tanY * vmin) / camera.height };
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(v) {
  const l = Math.hypot(...v) || 1;
  return v.map((c) => c / l);
}

// ---- Motion ----

/** Eases in and out, 0 to 1. */
export function smooth(u) {
  const t = Math.min(1, Math.max(0, u));
  return t * t * (3 - 2 * t);
}

/** A point `u` (0–1) of the way along a flight from one point to another, lifted by `arc` metres at the middle. */
export function flightPoint(from, to, u, arc = 0) {
  const k = Math.min(1, Math.max(0, u));
  return [
    from[0] + (to[0] - from[0]) * k,
    from[1] + (to[1] - from[1]) * k + arc * 4 * k * (1 - k),
    from[2] + (to[2] - from[2]) * k,
  ];
}

/**
 * How far a ball falling under gravity and bouncing has got: height above the grass `t` seconds after
 * being at `y0` with the upward speed `vy`, bouncing with a bit of energy left each time.
 * @param {number} radius the height of its middle when it rests on the grass
 */
export function bouncingHeight(y0, vy, t, radius, { gravity = 9.8, keep = 0.45 } = {}) {
  let y = y0;
  let v = vy;
  let left = t;
  for (let i = 0; i < 12; i++) {
    // Time until it next reaches the grass.
    const disc = v * v + 2 * gravity * (y - radius);
    const tHit = (v + Math.sqrt(Math.max(0, disc))) / gravity;
    if (left <= tHit) return Math.max(radius, y + v * left - 0.5 * gravity * left * left);
    left -= tHit;
    v = (gravity * tHit - v) * keep;
    y = radius;
    if (v < 0.4) return radius;
  }
  return radius;
}

/**
 * How far the net is pushed back (m) at a point of it, when a ball hit it at `hit` (x, y), `age`
 * seconds ago: a quick swell round the ball that rings and dies down.
 * @param {{x:number, y:number}} at
 * @param {{x:number, y:number}} hit
 * @param {number} [amount] how hard it was hit
 */
export function netPush(at, hit, age, amount = 0.6, spread = 1.0) {
  if (age < 0) return 0;
  const d = Math.hypot(at.x - hit.x, at.y - hit.y);
  const swell = Math.exp(-((d / spread) ** 2));
  const rise = 0.1;
  const envelope = age < rise ? age / rise : Math.exp(-2.6 * (age - rise)) * Math.cos(10 * (age - rise));
  return amount * swell * envelope;
}

// ---- Baking ----

/** Shapes at a low detail, for the many small things (people) that are baked into one. */
export const BAKE_SHAPES = {
  sphere: () => sphereMesh(8, 5),
  cylinder: () => cylinderMesh(8),
  cone: () => coneMesh(10),
  box: boxMesh,
  torus: () => torusMesh(0.08, 16, 6),
  quad: quadMesh,
};

/**
 * Joins many drawables (a shape name, a matrix and a colour each) into a single mesh with a
 * colour at each corner, so thousands of them are drawn in one go. Matrices must not mirror a
 * shape (a negative scale).
 * @param {{mesh: string, m: ArrayLike<number>, colour: number[]}[]} parts
 * @returns {BakedMesh}
 */
export function bakeParts(parts, shapes = BAKE_SHAPES) {
  const cache = new Map();
  const shape = (name) => {
    if (!cache.has(name)) cache.set(name, shapes[name]());
    return cache.get(name);
  };
  let vertices = 0;
  let indices = 0;
  for (const part of parts) {
    const mesh = shape(part.mesh);
    vertices += mesh.positions.length / 3;
    indices += mesh.indices.length;
  }
  const out = {
    positions: new Float32Array(vertices * 3),
    normals: new Float32Array(vertices * 3),
    colours: new Float32Array(vertices * 3),
    indices: new Uint32Array(indices),
  };
  let v = 0;
  let i = 0;
  for (const { mesh: name, m, colour } of parts) {
    const mesh = shape(name);
    const n = mesh.positions.length / 3;
    const normal = normalMatrix(m);
    for (let k = 0; k < n; k++) {
      const x = mesh.positions[k * 3];
      const y = mesh.positions[k * 3 + 1];
      const z = mesh.positions[k * 3 + 2];
      const o = (v + k) * 3;
      out.positions[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
      out.positions[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      out.positions[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      const nx = mesh.normals[k * 3];
      const ny = mesh.normals[k * 3 + 1];
      const nz = mesh.normals[k * 3 + 2];
      const tx = normal[0] * nx + normal[1] * ny + normal[2] * nz;
      const ty = normal[3] * nx + normal[4] * ny + normal[5] * nz;
      const tz = normal[6] * nx + normal[7] * ny + normal[8] * nz;
      const l = Math.hypot(tx, ty, tz) || 1;
      out.normals[o] = tx / l;
      out.normals[o + 1] = ty / l;
      out.normals[o + 2] = tz / l;
      out.colours[o] = colour[0];
      out.colours[o + 1] = colour[1];
      out.colours[o + 2] = colour[2];
    }
    for (let k = 0; k < mesh.indices.length; k++) out.indices[i + k] = mesh.indices[k] + v;
    v += n;
    i += mesh.indices.length;
  }
  return out;
}

/** The matrix that turns a normal (row by row): the inverse transpose of the matrix's top left 3×3, which is its cofactors over its determinant. */
function normalMatrix(m) {
  const [a, b, c, d, e, f, g, h, k] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]; // its rows
  const cof = [
    e * k - f * h, f * g - d * k, d * h - e * g,
    c * h - b * k, a * k - c * g, b * g - a * h,
    b * f - c * e, c * d - a * f, a * e - b * d,
  ];
  const det = a * cof[0] + b * cof[1] + c * cof[2];
  const s = Math.abs(det) < 1e-12 ? 1 : 1 / det;
  return cof.map((x) => x * s);
}
