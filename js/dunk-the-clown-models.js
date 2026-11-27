// The maths and shapes behind Dunk the Clown's 3D picture, kept free of the
// browser so they can be unit-tested: 4×4 matrices, the camera, the solid
// shapes everything is built from, and how a clown falls and the water splashes.
//
// The world is measured in "vmin": 1 is the shorter side of the screen. The
// camera looks straight at the plane z = 0 from `EYE_DISTANCE` away, and is set
// so that plane fills the screen exactly. Anything on it (the bullseyes) lands
// on the screen at the same place the game's rules (dunk-the-clown-logic.js)
// say it is; things nearer the camera look bigger, things behind it smaller.
// X is to the right, Y up, Z towards the player.

/** @typedef {Float32Array} Mat4 column-major, like WebGL wants it */
/** @typedef {{positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint16Array}} MeshData */

export const EYE_DISTANCE = 2.4;

// ---- Matrices ----

export function identity() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** a × b (b is applied first). */
export function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/** Several matrices multiplied in the order written: chain(a, b, c) = a × b × c. */
export function chain(...matrices) {
  return matrices.reduce((acc, m) => multiply(acc, m));
}

export function translation(x, y, z) {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

export function scaling(x, y = x, z = x) {
  const m = identity();
  m[0] = x; m[5] = y; m[10] = z;
  return m;
}

export function rotationX(angle) {
  const m = identity();
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
  return m;
}

export function rotationZ(angle) {
  const m = identity();
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
  return m;
}

export function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

/** A point through a matrix: [x, y, z, w]. */
export function transform(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

/**
 * A matrix that stretches a shape along Y (the way cylinders and cones point)
 * into a limb from `a` to `b`, `radius` thick. The shape is centred on Y = 0
 * and 1 long, so it ends up centred between the two points.
 */
export function limb(a, b, radius) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const length = Math.hypot(...d) || 1e-6;
  const y = d.map((v) => v / length);
  // Any direction not parallel to y, to build the other two axes from.
  const helper = Math.abs(y[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const x = normalise(cross(helper, y));
  const z = cross(x, y);
  const m = identity();
  // Columns: x axis (thickness), y axis (length), z axis (thickness).
  m[0] = x[0] * radius; m[1] = x[1] * radius; m[2] = x[2] * radius;
  m[4] = y[0] * length; m[5] = y[1] * length; m[6] = y[2] * length;
  m[8] = z[0] * radius; m[9] = z[1] * radius; m[10] = z[2] * radius;
  m[12] = (a[0] + b[0]) / 2; m[13] = (a[1] + b[1]) / 2; m[14] = (a[2] + b[2]) / 2;
  return m;
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalise(v) {
  const length = Math.hypot(...v) || 1;
  return v.map((c) => c / length);
}

// ---- Camera ----

/**
 * The camera for a screen.
 * @param {{width: number, height: number}} view screen size in pixels
 */
export function makeCamera(view) {
  const vmin = Math.min(view.width, view.height);
  // How much of the plane z = 0 the screen shows, in vmin.
  const width = view.width / vmin;
  const height = view.height / vmin;
  const fovY = 2 * Math.atan(height / 2 / EYE_DISTANCE);
  const proj = perspective(fovY, view.width / view.height, 0.3, 14);
  const viewMatrix = translation(0, 0, -EYE_DISTANCE);
  return {
    width, height, proj, view: viewMatrix, viewProj: multiply(proj, viewMatrix), eye: [0, 0, EYE_DISTANCE],
  };
}

/** How much bigger something at depth `z` looks than the same thing at z = 0. */
export function scaleAt(z) {
  return EYE_DISTANCE / (EYE_DISTANCE - z);
}

/** Where a world point is on the screen (normalised, 0–1 across and down). */
export function project(camera, point) {
  const [x, y, , w] = transform(camera.viewProj, point);
  return { x: (x / w + 1) / 2, y: (1 - y / w) / 2 };
}

/**
 * Where to put something at depth `z` so it appears at a spot on the screen,
 * and the size to give it so it appears the same size as it would at z = 0.
 * @param {{width: number, height: number}} camera
 * @returns {{position: number[], scale: number}}
 */
export function anchor(camera, x, y, z = 0) {
  const k = scaleAt(z);
  return { position: [((x - 0.5) * camera.width) / k, ((0.5 - y) * camera.height) / k, z], scale: 1 / k };
}

// ---- Shapes ----

// Every shape is built facing outwards, whichever way round it was written.
function finish(positions, normals, uvs, indices) {
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
    const p = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const [pa, pb, pc] = [p(a), p(b), p(c)];
    const face = cross(pb.map((v, i) => v - pa[i]), pc.map((v, i) => v - pa[i]));
    const n = [0, 1, 2].map((i) => normals[a * 3 + i] + normals[b * 3 + i] + normals[c * 3 + i]);
    if (face[0] * n[0] + face[1] * n[1] + face[2] * n[2] < 0) {
      indices[t + 1] = c;
      indices[t + 2] = b;
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

/** A ball of radius 1 round the origin. */
export function sphereMesh(lon = 28, lat = 16) {
  const positions = []; const normals = []; const uvs = []; const indices = [];
  for (let i = 0; i <= lat; i++) {
    const theta = (Math.PI * i) / lat;
    for (let j = 0; j <= lon; j++) {
      const phi = (2 * Math.PI * j) / lon;
      const n = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
      positions.push(...n); normals.push(...n); uvs.push(j / lon, i / lat);
    }
  }
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      const a = i * (lon + 1) + j;
      const b = a + lon + 1;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  return finish(positions, normals, uvs, indices);
}

/** A can of radius 1 and height 1 standing on the origin's Y axis, capped at both ends. */
export function cylinderMesh(segments = 28) {
  const positions = []; const normals = []; const uvs = []; const indices = [];
  for (let j = 0; j <= segments; j++) {
    const a = (2 * Math.PI * j) / segments;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    positions.push(c, -0.5, s, c, 0.5, s);
    normals.push(c, 0, s, c, 0, s);
    uvs.push(j / segments, 0, j / segments, 1);
  }
  for (let j = 0; j < segments; j++) {
    const a = j * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  for (const y of [-0.5, 0.5]) {
    const centre = positions.length / 3;
    positions.push(0, y, 0); normals.push(0, Math.sign(y), 0); uvs.push(0.5, 0.5);
    for (let j = 0; j <= segments; j++) {
      const a = (2 * Math.PI * j) / segments;
      positions.push(Math.cos(a), y, Math.sin(a)); normals.push(0, Math.sign(y), 0); uvs.push(0, 0);
    }
    for (let j = 0; j < segments; j++) indices.push(centre, centre + 1 + j, centre + 2 + j);
  }
  return finish(positions, normals, uvs, indices);
}

/** A cone of base radius 1 and height 1: base on y = -0.5, point at y = 0.5. */
export function coneMesh(segments = 28) {
  const positions = []; const normals = []; const uvs = []; const indices = [];
  for (let j = 0; j <= segments; j++) {
    const a = (2 * Math.PI * j) / segments;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    const n = normalise([c, 1, s]);
    positions.push(c, -0.5, s, 0, 0.5, 0);
    normals.push(...n, ...n);
    uvs.push(j / segments, 0, j / segments, 1);
  }
  for (let j = 0; j < segments; j++) {
    const a = j * 2;
    indices.push(a, a + 2, a + 1);
  }
  const centre = positions.length / 3;
  positions.push(0, -0.5, 0); normals.push(0, -1, 0); uvs.push(0.5, 0.5);
  for (let j = 0; j <= segments; j++) {
    const a = (2 * Math.PI * j) / segments;
    positions.push(Math.cos(a), -0.5, Math.sin(a)); normals.push(0, -1, 0); uvs.push(0, 0);
  }
  for (let j = 0; j < segments; j++) indices.push(centre, centre + 1 + j, centre + 2 + j);
  return finish(positions, normals, uvs, indices);
}

/** A cube 1 across, centred on the origin. */
export function boxMesh() {
  const positions = []; const normals = []; const uvs = []; const indices = [];
  const faces = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  ];
  for (const [n, u, v] of faces) {
    const base = positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(...[0, 1, 2].map((i) => 0.5 * n[i] + 0.5 * su * u[i] + 0.5 * sv * v[i]));
      normals.push(...n);
      uvs.push((su + 1) / 2, (sv + 1) / 2);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return finish(positions, normals, uvs, indices);
}

/** A ring in the XZ plane: its middle line has radius 1, its tube `tube` thick (radius). */
export function torusMesh(tube = 0.08, ringSegments = 36, tubeSegments = 10) {
  const positions = []; const normals = []; const uvs = []; const indices = [];
  for (let i = 0; i <= ringSegments; i++) {
    const a = (2 * Math.PI * i) / ringSegments;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    for (let j = 0; j <= tubeSegments; j++) {
      const b = (2 * Math.PI * j) / tubeSegments;
      const n = [Math.cos(b) * c, Math.sin(b), Math.cos(b) * s];
      positions.push(c + tube * n[0], tube * n[1], s + tube * n[2]);
      normals.push(...n);
      uvs.push(i / ringSegments, j / tubeSegments);
    }
  }
  for (let i = 0; i < ringSegments; i++) {
    for (let j = 0; j < tubeSegments; j++) {
      const a = i * (tubeSegments + 1) + j;
      const b = a + tubeSegments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return finish(positions, normals, uvs, indices);
}

/** A flat square 1 across in the XY plane, facing +Z, with texture coordinates (for signs). */
export function quadMesh() {
  return finish(
    [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
    [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    [0, 0, 1, 0, 1, 1, 0, 1],
    [0, 1, 2, 0, 2, 3],
  );
}

export const MESHES = {
  sphere: sphereMesh, cylinder: cylinderMesh, cone: coneMesh, box: boxMesh, torus: torusMesh, quad: quadMesh,
};

// ---- Motion ----

/** A small repeatable random number generator, so a splash can be tested. */
export function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export const MOTION = {
  gravity: 34, // clown-radii (a bullseye's radius) a second squared
  // The seat gives way at once; the clown starts to fall this long after the hit.
  fallDelayS: 0.1,
  // Underwater he sinks this fast in the end, and the water slows him this quickly.
  sinkSpeed: 2.2,
  waterDrag: 6,
  // How long he stays in the tank before fading away.
  fadeStartS: 1.1,
  fadeS: 0.25,
};

/**
 * Where a clown is, a time after the seat gave way. Heights are in bullseye
 * radii, measured up from the plank's top, so the clown starts at 0.
 * @param {number} t seconds since the hit
 * @param {{water: number, floor: number}} tank heights of the water's surface and the tank's bottom (negative: below the plank)
 * @returns {{y: number, tilt: number, topple: number, flail: number, submerged: boolean, splashAt: number|null, alpha: number}}
 *   splashAt: the time (s) he reaches the water, once he has; flail: 0–1, how wildly his arms wave
 */
export function fall(t, tank) {
  const { gravity, fallDelayS, sinkSpeed, waterDrag, fadeStartS, fadeS } = MOTION;
  // His bottom is this far above his root (the plank), so he touches the water when it is this high.
  const seatDepth = 0.2;
  const dropToWater = seatDepth - tank.water;
  const tFall = Math.sqrt((2 * dropToWater) / gravity);
  const tHit = fallDelayS + tFall;
  let y;
  if (t < fallDelayS) {
    y = 0;
  } else if (t < tHit) {
    const d = t - fallDelayS;
    y = -0.5 * gravity * d * d;
  } else {
    // In the water: his speed fades from the speed he hit it at to a slow sink.
    const d = t - tHit;
    const v0 = gravity * tFall;
    const extra = ((v0 - sinkSpeed) * (1 - Math.exp(-waterDrag * d))) / waterDrag;
    y = -dropToWater - extra - sinkSpeed * d;
  }
  // He cannot go through the bottom of the tank.
  y = Math.max(y, tank.floor + 0.6);
  const alpha = t < fadeStartS ? 1 : Math.max(0, 1 - (t - fadeStartS) / fadeS);
  return {
    y,
    // He tips a little sideways and topples over backwards, away from the player, so he stays inside the tank's width.
    tilt: -0.4 * (1 - Math.exp(-2.4 * Math.max(0, t - fallDelayS))),
    topple: -1.35 * (1 - Math.exp(-2.4 * Math.max(0, t - fallDelayS))),
    flail: Math.min(1, t / 0.12),
    submerged: t >= tHit,
    splashAt: t >= tHit ? tHit : null,
    alpha,
  };
}

/** The time (s) after a hit that a clown reaches the water. */
export function timeToWater(water) {
  return MOTION.fallDelayS + Math.sqrt((2 * (0.2 - water)) / MOTION.gravity);
}

/**
 * The drops of a splash. Positions and speeds are in bullseye radii, relative
 * to where he went in; the splash stays over the tank.
 * @param {() => number} random
 * @param {number} [count]
 * @returns {{x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number}[]}
 */
export function splashDrops(random, count = 110) {
  const drops = [];
  for (let i = 0; i < count; i++) {
    const angle = random() * Math.PI * 2;
    // A few big drops fly high and in the middle, a ring of small ones goes out sideways.
    const crown = i % 3 === 0;
    const out = crown ? 0.3 + random() * 1.1 : 1.0 + random() * 1.9;
    drops.push({
      x: Math.cos(angle) * 0.25,
      y: 0,
      z: Math.sin(angle) * 0.25,
      vx: Math.cos(angle) * out,
      vy: crown ? 8.5 + random() * 2.5 : 4.5 + random() * 4,
      vz: Math.sin(angle) * out * 0.6,
      size: crown ? 0.07 + random() * 0.05 : 0.035 + random() * 0.035,
    });
  }
  return drops;
}

/** How far a drop has got after `t` seconds, from where it started: [x, y, z] in radii. */
export function dropAt(drop, t) {
  return [drop.x + drop.vx * t, drop.y + drop.vy * t - 0.5 * MOTION.gravity * t * t, drop.z + drop.vz * t];
}

/** The time (s) a drop is back down at the water. */
export function dropLandsAt(drop) {
  return (2 * drop.vy) / MOTION.gravity;
}

/** Slows to a stop at the end, overshooting a little at the start: for things popping up. */
export function easeOutBack(t) {
  const c = 1.9;
  const x = Math.min(1, Math.max(0, t)) - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
}
