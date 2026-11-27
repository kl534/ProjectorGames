// Castle Crash drawing, on one canvas, as seen from just behind the players
// (the camera in castle-crash-logic.js): mountains and a far castle on the
// horizon, the grassy field running away to them, the trodden earth under each
// wall, the forts' blocks as solid, lit boxes (planks and crates of wood, cut
// stone, clear ice, TNT crates, cracking as they are hurt), the goblins, the
// boulder, their shadows, and the effects of a shot (splinters, chips and
// shards, dust, a goblin's puff, a blast, the points). Everything is placed in
// the world (metres) and projected; the faces of a block that look at the
// camera are drawn, far things first.
//
// Each block's look, each goblin and the field are painted once into a canvas
// of their own and only copied after that (`textureFor`, `goblinSprite`,
// `backdropFor`), so a frame costs a few milliseconds however much detail
// there is. The light comes from above, to the left.
//
// Nothing here moves while players aim; the effects only play inside a shot,
// and the game tells the camera where each will be drawn first (`effectArea`).
// The colours are mid to dark, never white, so a light ball stands out.

import { CASTLE_CRASH_RULES, boxCorners3d, horizonY, project } from './castle-crash-logic.js';

/**
 * @typedef {import('./castle-crash-logic.js').View} View
 * @typedef {import('./castle-crash-logic.js').Pose} Pose
 * @typedef {import('./castle-crash-logic.js').Pad} Pad
 * @typedef {import('./castle-crash-logic.js').PlayEvent} PlayEvent
 */

// Each material's colours: its body, its dark edge, and its dust and chips when it breaks.
const MATERIAL_LOOK = {
  wood: { fill: '#9b6a3c', edge: '#4a2f17', light: '#b5824e', dark: '#6d4522', dust: 'rgba(150, 112, 70,' },
  ice: { fill: '#5d9fc2', edge: '#24597a', light: '#8cc6df', dark: '#3a7ea6', dust: 'rgba(150, 200, 222,' },
  stone: { fill: '#7a7e86', edge: '#3a3d43', light: '#9a9ea5', dark: '#5a5e66', dust: 'rgba(128, 126, 122,' },
  tnt: { fill: '#b3261e', edge: '#4e110d', light: '#cf4a3a', dark: '#7e1913', dust: 'rgba(70, 60, 55,' },
};
// How much each face of a block is lit, besides its front: the light is above and to the left.
const FACE_LIGHT = { top: 0.16, bottom: -0.5, left: -0.18, right: -0.38, back: -0.4, front: 0 };

// How long each effect lasts (ms): splinters and puffs, the points rising, a blast.
export const EFFECT_MS = { pieces: 900, points: 1100, boom: 1000, poof: 400 };

// Pixels a metre in the painted textures and sprites (they are scaled down to the screen).
const TEXTURE_PPM = 160;
const MAX_TEXTURE = 2048;

/** A canvas off the page. */
function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  return canvas;
}

// ---- The field ------------------------------------------------------------------

let backdropCache = { key: '', canvas: null };

/**
 * Clears the canvas and draws what stays still: mountains and a far castle on the
 * horizon, the field and its grass running away from the players, rocks by the
 * sides, and the trodden earth under each wall. It is painted once for a screen
 * size and set of walls, then copied.
 * @param {Pad[]} [pads]
 */
export function drawBackdrop(ctx, view, pads = []) {
  const ratio = ctx.getTransform().a || 1;
  const key = `${view.width}x${view.height}@${ratio}:${JSON.stringify(pads)}`;
  if (backdropCache.key !== key) {
    const canvas = makeCanvas(view.width * ratio, view.height * ratio);
    const bctx = canvas.getContext('2d');
    bctx.scale(ratio, ratio);
    paintBackdrop(bctx, view, pads);
    backdropCache = { key, canvas };
  }
  // Copied pixel for pixel: no scaling, no smoothing, and nothing under it to clear.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(backdropCache.canvas, 0, 0);
  ctx.restore();
}

function paintBackdrop(ctx, view, pads) {
  const { width, height } = view;
  const horizon = horizonY(view);
  const random = seeded(17);
  // Mountains, far to near: each a ridge of peaks, hazier the farther it is.
  const ridges = [
    { colour: '#545079', top: 0.19, rough: 0.6, seed: 3 },
    { colour: '#3e4462', top: 0.1, rough: 0.8, seed: 8 },
  ];
  ridges.forEach((ridge, i) => {
    const line = ridgeLine(width, horizon, ridge.top * height, ridge.rough, ridge.seed);
    fillRidge(ctx, line, width, horizon, ridge.colour);
    if (i === 0) {
      // Snow, dim, only on the highest peaks: above a ragged snowline.
      ctx.save();
      ctx.clip(ridgePath(line, width, horizon));
      ctx.fillStyle = 'rgba(150, 146, 178, 0.4)';
      ctx.beginPath();
      ctx.moveTo(-10, 0);
      for (let x = -10; x <= width + 10; x += 8) {
        ctx.lineTo(x, horizon - ridge.top * height * (0.72 + 0.06 * Math.sin(x * 0.09) + 0.04 * Math.sin(x * 0.23)));
      }
      ctx.lineTo(width + 10, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    if (i === 1) drawFarCastle(ctx, line, width, height);
  });
  // Near hills with dark pines along them, low and rolling.
  const hills = ridgeLine(width, horizon, height * 0.04, 0.15, 21);
  fillRidge(ctx, hills, width, horizon, '#33473b');
  ctx.fillStyle = '#26382c';
  for (let x = 0; x < width; x += width / 140) {
    if (Math.abs(x - width / 2) < width * 0.22 && random() < 0.7) continue;
    const base = yOnLine(hills, x) + 1;
    const h = height * (0.012 + random() * 0.022);
    const w = h * 0.42;
    ctx.beginPath();
    ctx.moveTo(x - w, base);
    ctx.lineTo(x, base - h);
    ctx.lineTo(x + w, base);
    ctx.closePath();
    ctx.fill();
  }
  // The field: hazy far away, deep green near.
  const field = ctx.createLinearGradient(0, horizon, 0, height);
  field.addColorStop(0, '#556e48');
  field.addColorStop(0.12, '#3f6233');
  field.addColorStop(0.5, '#365a2b');
  field.addColorStop(1, '#2b4822');
  ctx.fillStyle = field;
  ctx.fillRect(0, horizon, width, height - horizon);
  // Mown stripes 3 m deep, from the players to far beyond the forts.
  for (let z = 1, i = 0; z < 140; z += 3, i++) {
    ctx.fillStyle = i % 2 ? 'rgba(0, 20, 0, 0.07)' : 'rgba(170, 210, 120, 0.05)';
    groundQuad(ctx, view, [[-90, z], [90, z], [90, z + 3], [-90, z + 3]]);
  }
  // Patches of darker and lighter grass.
  for (let k = 0; k < 70; k++) {
    const z = 3 + random() ** 1.5 * 70;
    const x = (random() - 0.5) * (14 + z * 1.6);
    const r = 1 + random() * 3;
    ctx.fillStyle = random() < 0.5 ? 'rgba(20, 40, 10, 0.12)' : 'rgba(140, 170, 80, 0.07)';
    groundEllipse(ctx, view, x, z, r * 1.6, r);
  }
  drawGrass(ctx, view, random, 0.6);
  drawRocks(ctx, view, random);
  for (const pad of pads) drawPad(ctx, view, pad);
  // Tufts round the edges of the trodden earth.
  for (const pad of pads) {
    for (let k = 0; k < 40; k++) {
      const onX = random() < 0.5;
      const x = onX ? pad.x0 + random() * (pad.x1 - pad.x0) : random() < 0.5 ? pad.x0 : pad.x1;
      const z = onX ? (random() < 0.5 ? pad.z0 : pad.z1) : pad.z0 + random() * (pad.z1 - pad.z0);
      drawTuft(ctx, view, x + (random() - 0.5) * 0.3, z + (random() - 0.5) * 0.3, 0.3, random);
    }
  }
  // Haze where the field meets the hills, and the corners a little darker.
  const haze = ctx.createLinearGradient(0, horizon - height * 0.05, 0, horizon + height * 0.1);
  haze.addColorStop(0, 'rgba(120, 104, 128, 0)');
  haze.addColorStop(0.35, 'rgba(120, 104, 128, 0.45)');
  haze.addColorStop(1, 'rgba(120, 104, 128, 0)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, horizon - height * 0.05, width, height * 0.15);
  const vignette = ctx.createRadialGradient(width / 2, height * 0.45, height * 0.35, width / 2, height * 0.45, Math.hypot(width, height) * 0.62);
  vignette.addColorStop(0, 'rgba(8, 10, 20, 0)');
  vignette.addColorStop(1, 'rgba(8, 10, 20, 0.45)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
}

/** A ridge's outline across the screen: points every few pixels, `top` its highest above the horizon. */
function ridgeLine(width, horizon, top, rough, seed) {
  const random = seeded(seed);
  const waves = Array.from({ length: 7 }, (_, i) => ({ k: 2.5 * 1.9 ** i * (0.8 + random() * 0.4), phase: random() * 6.3, amp: 1 / 1.8 ** (i * (1.2 - rough * 0.5)) }));
  const total = waves.reduce((sum, w) => sum + w.amp, 0);
  const line = [];
  for (let x = -10; x <= width + 10; x += 6) {
    const u = x / width;
    let v = 0;
    // Ridged: each wave folded at its peaks, so the peaks are sharp and the valleys round.
    for (const w of waves) v += w.amp * (1 - Math.abs(Math.sin(u * w.k * Math.PI + w.phase))) ** 2;
    const n = v / total;
    line.push({ x, y: horizon - top * (0.2 + 0.8 * Math.min(1, n * 1.5) ** 1.3) - (random() - 0.5) * top * 0.03 * rough });
  }
  return line;
}

function ridgePath(line, width, horizon) {
  const path = new Path2D();
  path.moveTo(-10, horizon + 2);
  for (const p of line) path.lineTo(p.x, p.y);
  path.lineTo(width + 10, horizon + 2);
  path.closePath();
  return path;
}

function fillRidge(ctx, line, width, horizon, colour) {
  const top = Math.min(...line.map((p) => p.y));
  const gradient = ctx.createLinearGradient(0, top, 0, horizon);
  gradient.addColorStop(0, shade(colour, 0.08));
  gradient.addColorStop(1, shade(colour, -0.12));
  ctx.fillStyle = gradient;
  ctx.fill(ridgePath(line, width, horizon));
}

function yOnLine(line, x) {
  const i = Math.max(0, Math.min(line.length - 2, Math.floor((x + 10) / 6)));
  const a = line[i];
  const b = line[i + 1];
  return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
}

/** The goblins' own castle, dark against the sky on a far ridge to the left, a few windows lit. */
function drawFarCastle(ctx, line, width, height) {
  const cx = width * 0.17;
  const base = yOnLine(line, cx) + height * 0.006;
  const u = height * 0.012;
  ctx.fillStyle = '#353a50';
  const towers = [[-5, 3.2, 1.6], [-2.2, 4.6, 1.4], [0, 6.2, 1.8], [2.4, 4, 1.4], [5, 2.8, 1.6]];
  ctx.fillRect(cx - 5 * u, base - 2.4 * u, 10 * u, 2.4 * u);
  for (const [dx, h, w] of towers) {
    const x = cx + dx * u;
    ctx.fillRect(x - (w / 2) * u, base - h * u, w * u, h * u);
    // A pointed roof.
    ctx.beginPath();
    ctx.moveTo(x - (w / 2 + 0.2) * u, base - h * u);
    ctx.lineTo(x, base - (h + w * 1.1) * u);
    ctx.lineTo(x + (w / 2 + 0.2) * u, base - h * u);
    ctx.closePath();
    ctx.fill();
  }
  // Battlements on the wall.
  for (let k = -4.5; k <= 4.5; k += 1) ctx.fillRect(cx + (k - 0.25) * u, base - 2.85 * u, 0.5 * u, 0.5 * u);
  ctx.fillStyle = 'rgba(200, 130, 60, 0.75)';
  for (const [dx, dy] of [[-2.2, 3.4], [0, 4.8], [0.1, 3.2], [2.4, 2.8], [-5, 2]]) {
    ctx.fillRect(cx + (dx - 0.15) * u, base - dy * u, 0.3 * u, 0.5 * u);
  }
}

/** Tufts of grass over the field, fewer and smaller far away. */
function drawGrass(ctx, view, random, density) {
  for (let z = 4; z < 60; z += 0.5) {
    const count = Math.round((density * 90) / (1 + z * 0.06));
    for (let k = 0; k < count; k++) {
      const x = (random() - 0.5) * (12 + z * 1.5);
      drawTuft(ctx, view, x, z + random() * 0.5, (0.1 + random() * 0.12) * Math.min(1, z / 9), random);
    }
  }
  // A few flowers, dim.
  for (let k = 0; k < 160; k++) {
    const z = 8 + random() * 36;
    const x = (random() - 0.5) * (12 + z * 1.4);
    const p = project(view, x, 0.05, z);
    if (p.depth <= 0.5) continue;
    const r = (0.05 * view.f) / p.depth;
    if (r < 0.5) continue;
    ctx.fillStyle = ['rgba(190, 168, 70, 0.8)', 'rgba(150, 110, 170, 0.8)', 'rgba(180, 120, 110, 0.75)'][k % 3];
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTuft(ctx, view, x, z, size, random) {
  const p = project(view, x, 0, z);
  if (p.depth <= 0.5) return;
  const s = (size * view.f) / p.depth;
  if (s < 1) return;
  const light = random();
  ctx.strokeStyle = light < 0.35 ? 'rgba(120, 160, 70, 0.55)' : light < 0.7 ? 'rgba(40, 72, 28, 0.6)' : 'rgba(80, 118, 50, 0.55)';
  ctx.lineWidth = Math.max(0.6, s * 0.09);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let b = 0; b < 3; b++) {
    const lean = (b - 1) * 0.35 + (random() - 0.5) * 0.3;
    const bx = p.x + (b - 1) * s * 0.12;
    ctx.moveTo(bx, p.y);
    ctx.quadraticCurveTo(bx + lean * s * 0.3, p.y - s * 0.6, bx + lean * s * 0.7, p.y - s * (0.8 + random() * 0.3));
  }
  ctx.stroke();
}

/** Rocks lying in the grass, away from the forts. */
function drawRocks(ctx, view, random) {
  for (let k = 0; k < 26; k++) {
    const side = k % 2 ? 1 : -1;
    const z = 5 + random() * 40;
    const x = side * (9 + random() * (6 + z * 0.4));
    const r = 0.25 + random() * 0.55;
    const pts = [];
    for (let i = 0; i < 7; i++) {
      const a = Math.PI + (i / 6) * Math.PI;
      const rr = r * (0.75 + random() * 0.35);
      pts.push(project(view, x + Math.cos(a) * rr, -Math.sin(a) * rr * 0.75, z));
    }
    const ground = project(view, x, 0, z);
    if (ground.depth < 1) continue;
    const s = view.f / ground.depth;
    ctx.fillStyle = 'rgba(10, 18, 8, 0.35)';
    ctx.beginPath();
    ctx.ellipse(ground.x + r * s * 0.15, ground.y, r * s * 1.15, r * s * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    const top = Math.min(...pts.map((p) => p.y));
    const gradient = ctx.createLinearGradient(ground.x - r * s, top, ground.x + r * s, ground.y);
    gradient.addColorStop(0, '#7d7a72');
    gradient.addColorStop(1, '#45433f');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();
  }
}

/** The trodden earth under a wall: ragged at the edges, with pebbles and scuffs. */
function drawPad(ctx, view, pad) {
  const random = seeded(Math.round(pad.x0 * 100 + pad.z0 * 1000));
  const outline = [];
  const edge = (x0, z0, x1, z1, n) => {
    for (let i = 0; i < n; i++) {
      const t = i / n;
      outline.push([x0 + (x1 - x0) * t + (random() - 0.5) * 0.25, z0 + (z1 - z0) * t + (random() - 0.5) * 0.25]);
    }
  };
  const nx = Math.max(4, Math.round((pad.x1 - pad.x0) * 2));
  const nz = Math.max(3, Math.round((pad.z1 - pad.z0) * 2));
  edge(pad.x0, pad.z0, pad.x1, pad.z0, nx);
  edge(pad.x1, pad.z0, pad.x1, pad.z1, nz);
  edge(pad.x1, pad.z1, pad.x0, pad.z1, nx);
  edge(pad.x0, pad.z1, pad.x0, pad.z0, nz);
  // A darker fringe where the grass is worn, then the earth.
  const grown = outline.map(([x, z]) => {
    const mx = (pad.x0 + pad.x1) / 2;
    const mz = (pad.z0 + pad.z1) / 2;
    return [x + Math.sign(x - mx) * 0.25, z + Math.sign(z - mz) * 0.2];
  });
  ctx.fillStyle = 'rgba(52, 44, 26, 0.55)';
  groundQuad(ctx, view, grown);
  const near = project(view, 0, 0, pad.z0);
  const far = project(view, 0, 0, pad.z1);
  const earth = ctx.createLinearGradient(0, far.y, 0, near.y);
  earth.addColorStop(0, '#5c4732');
  earth.addColorStop(1, '#6b5238');
  ctx.fillStyle = earth;
  groundQuad(ctx, view, outline);
  // Scuffs, then pebbles.
  for (let k = 0; k < (pad.x1 - pad.x0) * 6; k++) {
    const x = pad.x0 + 0.2 + random() * (pad.x1 - pad.x0 - 0.4);
    const z = pad.z0 + 0.15 + random() * (pad.z1 - pad.z0 - 0.3);
    ctx.fillStyle = random() < 0.5 ? 'rgba(40, 28, 16, 0.25)' : 'rgba(130, 104, 72, 0.22)';
    groundEllipse(ctx, view, x, z, 0.15 + random() * 0.35, 0.08 + random() * 0.15);
  }
  for (let k = 0; k < (pad.x1 - pad.x0) * 10; k++) {
    const x = pad.x0 + 0.1 + random() * (pad.x1 - pad.x0 - 0.2);
    const z = pad.z0 + 0.1 + random() * (pad.z1 - pad.z0 - 0.2);
    const p = project(view, x, 0, z);
    const r = ((0.03 + random() * 0.05) * view.f) / p.depth;
    ctx.fillStyle = random() < 0.5 ? '#827462' : '#4a3d2e';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r, r * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A flat patch of ground, from its corners' (x, z). */
function groundQuad(ctx, view, corners) {
  ctx.beginPath();
  corners.forEach(([x, z], i) => {
    const p = project(view, x, 0, z);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.fill();
}

/** A flat ellipse on the ground, `rx` across and `rz` deep (metres). */
function groundEllipse(ctx, view, x, z, rx, rz) {
  const c = project(view, x, 0, z);
  if (c.depth <= 0.5) return;
  const a = project(view, x + rx, 0, z);
  const b = project(view, x, 0, z + rz);
  const f = project(view, x, 0, z - rz);
  ctx.beginPath();
  ctx.ellipse(c.x, (b.y + f.y) / 2, Math.abs(a.x - c.x), Math.max(0.5, Math.abs(f.y - b.y) / 2), 0, 0, Math.PI * 2);
  ctx.fill();
}

// ---- The fort ---------------------------------------------------------------------

/**
 * Every body in `poses`, far ones first. The pieces of one wall standing in it are
 * drawn together: their shadows, the sides and tops of all of them, then their
 * fronts, then the goblins.
 * @param {Pose[]} poses
 */
export function drawPoses(ctx, view, poses) {
  const sorted = [...poses].sort((p, q) => q.z - p.z);
  for (let i = 0; i < sorted.length;) {
    const first = sorted[i];
    let j = i + 1;
    if (first.tilt === 0) {
      while (j < sorted.length && sorted[j].tilt === 0 && Math.abs(sorted[j].z - first.z) < 1e-3) j++;
    }
    drawGroup(ctx, view, sorted.slice(i, j));
    i = j;
  }
}

function drawGroup(ctx, view, poses) {
  const boxes = poses.filter((p) => p.body.kind === 'block').map((pose) => ({ pose, faces: visibleFaces(view, pose) }));
  for (const { pose } of boxes) drawBoxShadow(ctx, view, pose);
  for (const pose of poses) if (pose.body.kind === 'goblin' && pose.y - pose.body.r < 0.08) drawGroundShadow(ctx, view, pose.x, pose.z, pose.body.r * 0.95, pose.body.r * 0.6, 0.4);
  for (const { pose, faces } of boxes) for (const face of faces) if (face.name !== 'front') drawFace(ctx, pose, face);
  for (const { pose, faces } of boxes) for (const face of faces) if (face.name === 'front') drawFace(ctx, pose, face);
  for (const pose of poses) {
    if (pose.body.kind === 'goblin') drawGoblinAt(ctx, view, pose);
    else if (pose.body.kind === 'boulder') drawBoulderAt(ctx, view, pose);
  }
}

// The faces of a box, by its corners (see boxCorners3d: the front four, then the back four,
// each anticlockwise from bottom left as seen from the front). Each face's corners are listed
// bottom left, bottom right, top right, top left as its texture is laid on it.
const FACES = [
  { name: 'front', corners: [0, 1, 2, 3] },
  { name: 'back', corners: [5, 4, 7, 6] },
  { name: 'top', corners: [3, 2, 6, 7] },
  { name: 'bottom', corners: [4, 5, 1, 0] },
  { name: 'left', corners: [4, 0, 3, 7] },
  { name: 'right', corners: [1, 5, 6, 2] },
];

/** The faces of a block that look toward the camera, projected, farthest first. */
function visibleFaces(view, pose) {
  const world = boxCorners3d(pose.body, pose.x, pose.y, pose.z, pose.a, pose.tilt);
  const screen = world.map((c) => project(view, c.x, c.y, c.z));
  if (screen.some((p) => p.depth <= 0.1)) return [];
  const faces = [];
  for (const face of FACES) {
    const pts = face.corners.map((k) => screen[k]);
    // Facing the camera if its corners go round anticlockwise on the screen (y down: negative area).
    let area = 0;
    for (let k = 0; k < 4; k++) {
      const p = pts[k];
      const q = pts[(k + 1) % 4];
      area += p.x * q.y - q.x * p.y;
    }
    if (area >= 0) continue;
    const depth = face.corners.reduce((sum, k) => sum + screen[k].depth, 0) / 4;
    faces.push({ name: face.name, pts, depth });
  }
  return faces.sort((p, q) => q.depth - p.depth);
}

/**
 * One face of a block: the block's painted look laid on it (exactly, on a front
 * facing the players; near enough on the rest). The sides and top have their
 * own plainer look, already shaded, filled as a pattern so no clipping is needed.
 */
function drawFace(ctx, pose, face) {
  const { body } = pose;
  const cracks = crackLevel(pose.health);
  const [p0, p1, p2, p3] = face.pts;
  const front = face.name === 'front';
  const texture = textureFor(body, cracks, front ? '' : face.name);
  // The texture's top left on the face's top left, its width along the top, its height down the side.
  const w = texture.width;
  const h = texture.height;
  const m = [(p2.x - p3.x) / w, (p2.y - p3.y) / w, (p0.x - p3.x) / h, (p0.y - p3.y) / h, p3.x, p3.y];
  if (front) {
    ctx.save();
    ctx.transform(...m);
    ctx.drawImage(texture, 0, 0);
    ctx.restore();
    return;
  }
  let pattern = patterns.get(texture);
  if (!pattern) {
    pattern = ctx.createPattern(texture, 'repeat');
    patterns.set(texture, pattern);
  }
  pattern.setTransform(new DOMMatrix(m));
  ctx.fillStyle = pattern;
  ctx.strokeStyle = MATERIAL_LOOK[body.material].edge;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.lineTo(p3.x, p3.y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

/** How cracked a piece looks at a health (0–1): 0 to 3. */
function crackLevel(health) {
  return health > 0.75 ? 0 : health > 0.45 ? 1 : health > 0.2 ? 2 : 3;
}

/** A colour (#rrggbb) made lighter (amount > 0) or darker (< 0). */
function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const channel = (c) => Math.round(amount >= 0 ? c + (255 - c) * amount * 0.6 : c * (1 + amount));
  const r = channel((n >> 16) & 255);
  const g = channel((n >> 8) & 255);
  const b = channel(n & 255);
  return `rgb(${r}, ${g}, ${b})`;
}

/** A soft shadow on the ground round a box's footprint, fainter the higher it is. */
function drawBoxShadow(ctx, view, pose) {
  const corners = boxCorners3d(pose.body, pose.x, pose.y, pose.z, pose.a, pose.tilt);
  const low = Math.min(...corners.map((c) => c.y));
  const fade = Math.max(0, 1 - low / 5);
  if (fade <= 0) return;
  const xs = corners.map((c) => c.x);
  const zs = corners.map((c) => c.z);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const z0 = Math.min(...zs);
  const z1 = Math.max(...zs);
  // A few layers, each wider and fainter: a soft edge without blurring.
  for (const [grow, alpha] of [[0.32, 0.07], [0.18, 0.1], [0.06, 0.16]]) {
    ctx.fillStyle = `rgba(12, 14, 8, ${alpha * fade})`;
    groundQuad(ctx, view, [[x0 - grow, z0 - grow], [x1 + grow, z0 - grow], [x1 + grow, z1 + grow], [x0 - grow, z1 + grow]]);
  }
}

/** A soft round shadow on the ground. */
function drawGroundShadow(ctx, view, x, z, rx, rz, alpha) {
  for (const [grow, a] of [[1.25, 0.35], [1, 0.4], [0.7, 0.5]]) {
    ctx.fillStyle = `rgba(12, 14, 8, ${alpha * a})`;
    groundEllipse(ctx, view, x, z, rx * grow, rz * grow);
  }
}

// ---- Block textures ------------------------------------------------------------------

const textures = new Map();
/** @type {WeakMap<HTMLCanvasElement, CanvasPattern>} */
const patterns = new WeakMap();

/**
 * A block's front, painted once (for its size, material and how cracked it is)
 * and kept: a canvas `TEXTURE_PPM` pixels a metre, or fewer for a very long one.
 * A `side` (top, left, right, bottom, back) is the same material plainer (boards
 * without a crate's frame, a crate without its label), coarser, and shaded as
 * that face is lit.
 */
function textureFor(body, cracks, side = '') {
  const key = `${body.id}|${body.material}|${body.w}|${body.h}|${cracks}|${side}`;
  let canvas = textures.get(key);
  if (canvas) return canvas;
  if (textures.size > 800) textures.clear();
  const ppm = Math.min(side ? TEXTURE_PPM / 2 : TEXTURE_PPM, MAX_TEXTURE / Math.max(body.w, body.h));
  canvas = makeCanvas(body.w * ppm, body.h * ppm);
  const ctx = canvas.getContext('2d');
  ctx.scale(canvas.width / body.w, canvas.height / body.h);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const random = seeded(body.id * 31 + Math.round(body.w * 7 + body.h * 13));
  const paint = { wood: paintWood, ice: paintIce, stone: paintStone, tnt: paintTnt }[body.material];
  paint(ctx, body.w, body.h, random, Boolean(side));
  paintCracks(ctx, body, cracks);
  if (side) {
    const light = FACE_LIGHT[side];
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = light > 0 ? `rgba(255, 222, 180, ${light * 0.7})` : `rgba(8, 6, 12, ${-light})`;
    ctx.fillRect(0, 0, body.w, body.h);
  }
  textures.set(key, canvas);
  // A piece may crack mid-shot: paint how it will look then while there is time, not in that frame.
  if (!cracks) for (let level = 1; level <= 3; level++) warmLater(() => textureFor(body, level, side));
  return canvas;
}

const warmQueue = [];

/** Runs `paint` when the browser is idle (a few at a time, so no frame waits for them). */
function warmLater(paint) {
  warmQueue.push(paint);
  if (warmQueue.length === 1) whenIdle(warmSome);
}

function whenIdle(run) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 50);
}

function warmSome(deadline) {
  do warmQueue.shift()();
  while (warmQueue.length && deadline?.timeRemaining && deadline.timeRemaining() > 6);
  if (warmQueue.length) whenIdle(warmSome);
}

/** Light along the top and left edges, shadow along the bottom and right: a bevelled edge. */
function bevel(ctx, w, h, size, light, dark) {
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(0, 0);
  ctx.lineTo(w, 0);
  ctx.lineTo(w - size, size);
  ctx.lineTo(size, size);
  ctx.lineTo(size, h - size);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(w, 0);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.lineTo(size, h - size);
  ctx.lineTo(w - size, h - size);
  ctx.lineTo(w - size, size);
  ctx.closePath();
  ctx.fill();
}

/** Wood grain along a board from (x0, y0) to (x1, y1), `across` wide: wavy lines and a knot or two. */
function grain(ctx, x0, y0, x1, y1, across, random) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  const nx = -uy;
  const ny = ux;
  const knots = [];
  for (let k = 0; k < Math.floor(len / 1.4 + random() * 1.2); k++) knots.push({ t: 0.15 + random() * 0.7, o: (random() - 0.5) * across * 0.5 });
  const lines = Math.max(4, Math.round(across * 22));
  for (let i = 0; i < lines; i++) {
    const o0 = -across / 2 + (across * (i + 0.5)) / lines;
    const phase = random() * 6;
    ctx.strokeStyle = `rgba(${random() < 0.3 ? '175, 125, 75' : '55, 30, 12'}, ${0.12 + random() * 0.25})`;
    ctx.lineWidth = 0.006 + random() * 0.014;
    ctx.beginPath();
    for (let s = 0; s <= len + 0.001; s += 0.06) {
      let o = o0 + Math.sin(s * 2.2 + phase) * across * 0.025;
      // Lines bend round a knot.
      for (const knot of knots) {
        const d = s - knot.t * len;
        o += Math.sign(o0 - knot.o || 1) * across * 0.12 * Math.exp(-(d * d) / 0.02) * Math.exp(-((o0 - knot.o) ** 2) / (across * across * 0.05));
      }
      const x = x0 + ux * s + nx * o;
      const y = y0 + uy * s + ny * o;
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  for (const knot of knots) {
    const x = x0 + ux * knot.t * len + nx * knot.o;
    const y = y0 + uy * knot.t * len + ny * knot.o;
    const r = across * (0.06 + random() * 0.05);
    const angle = Math.atan2(uy, ux);
    ctx.fillStyle = 'rgba(70, 40, 18, 0.7)';
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.8, r, angle, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(55, 30, 12, 0.45)';
    ctx.lineWidth = 0.008;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 2.6, r * 1.5, angle, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** A nail head. */
function nail(ctx, x, y, r = 0.025) {
  ctx.fillStyle = '#2c2622';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(190, 180, 165, 0.55)';
  ctx.beginPath();
  ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.4, 0, Math.PI * 2);
  ctx.fill();
}

/** One board: its colour, grain, bevel and nails. `vertical` boards run up and down. */
function board(ctx, x, y, w, h, vertical, random, tone = 0) {
  const base = ['#a06c3b', '#97633a', '#a8743f', '#8f5d33'][Math.floor(random() * 4)];
  const gradient = ctx.createLinearGradient(x, y, x + w, y + h);
  gradient.addColorStop(0, shade(base, 0.12 + tone));
  gradient.addColorStop(1, shade(base, -0.12 + tone));
  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, w, h);
  if (vertical) grain(ctx, x + w / 2, y, x + w / 2, y + h, w, random);
  else grain(ctx, x, y + h / 2, x + w, y + h / 2, h, random);
  ctx.save();
  ctx.translate(x, y);
  bevel(ctx, w, h, Math.min(0.035, Math.min(w, h) * 0.12), 'rgba(235, 190, 130, 0.28)', 'rgba(35, 18, 6, 0.45)');
  ctx.restore();
}

function paintWood(ctx, w, h, random, sides) {
  ctx.fillStyle = '#4a2f17';
  ctx.fillRect(0, 0, w, h);
  if (w >= 0.9 && h >= 0.9 && !sides) {
    // A crate: planks behind a frame and a diagonal brace.
    const planks = Math.max(2, Math.round(w / 0.25));
    for (let i = 0; i < planks; i++) board(ctx, (w * i) / planks, 0, w / planks, h, true, random, -0.12);
    ctx.fillStyle = 'rgba(25, 12, 4, 0.35)';
    ctx.fillRect(0, 0, w, h);
    const f = Math.min(0.16, Math.min(w, h) * 0.16);
    const angle = Math.atan2(h - 2 * f, w - 2 * f);
    const len = Math.hypot(w - 2 * f, h - 2 * f);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-angle);
    ctx.fillStyle = 'rgba(20, 10, 3, 0.45)';
    ctx.fillRect(-len / 2, -f / 2 + 0.03, len, f);
    board(ctx, -len / 2, -f / 2, len, f, false, random);
    ctx.restore();
    board(ctx, 0, 0, w, f, false, random, 0.04);
    board(ctx, 0, h - f, w, f, false, random, -0.04);
    board(ctx, 0, f, f, h - 2 * f, true, random);
    board(ctx, w - f, f, f, h - 2 * f, true, random);
    for (const [x, y] of [[f / 2, f / 2], [w - f / 2, f / 2], [f / 2, h - f / 2], [w - f / 2, h - f / 2]]) nail(ctx, x, y);
  } else {
    // A plank or a post: boards along its length.
    const vertical = h > w;
    const across = vertical ? w : h;
    const n = Math.max(1, Math.round(across / 0.5));
    for (let i = 0; i < n; i++) {
      if (vertical) board(ctx, (w * i) / n, 0, w / n, h, true, random);
      else board(ctx, 0, (h * i) / n, w, h / n, false, random);
    }
    const len = vertical ? h : w;
    const spots = len > 3 ? [0.12, 0.5, 0.88] : [0.14, 0.86];
    for (const t of spots) {
      for (let i = 0; i < n; i++) {
        for (const side of [0.3, 0.7]) {
          const a = (i + side) / n;
          if (vertical) nail(ctx, w * a, h * t);
          else nail(ctx, w * t, h * a);
        }
      }
    }
  }
  ctx.strokeStyle = '#3a240f';
  ctx.lineWidth = 0.03;
  ctx.strokeRect(0.015, 0.015, w - 0.03, h - 0.03);
}

function paintStone(ctx, w, h, random) {
  const tint = ['#7c8088', '#80807e', '#767c86', '#848279'][Math.floor(random() * 4)];
  const gradient = ctx.createLinearGradient(0, 0, w * 0.6, h);
  gradient.addColorStop(0, shade(tint, 0.02));
  gradient.addColorStop(1, shade(tint, -0.25));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
  // Mottling, then grit.
  for (let k = 0; k < w * h * 10; k++) {
    const x = random() * w;
    const y = random() * h;
    const r = 0.08 + random() * 0.25;
    const blotch = ctx.createRadialGradient(x, y, 0, x, y, r);
    const colour = random() < 0.5 ? '40, 42, 48' : random() < 0.5 ? '150, 140, 120' : '120, 130, 150';
    blotch.addColorStop(0, `rgba(${colour}, 0.14)`);
    blotch.addColorStop(1, `rgba(${colour}, 0)`);
    ctx.fillStyle = blotch;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let k = 0; k < w * h * 500; k++) {
    ctx.fillStyle = random() < 0.55 ? 'rgba(30, 30, 34, 0.28)' : 'rgba(185, 185, 180, 0.14)';
    const s = 0.008 + random() * 0.016;
    ctx.fillRect(random() * w, random() * h, s, s);
  }
  // Pits, each with a lit lower lip.
  for (let k = 0; k < w * h * 9; k++) {
    const x = 0.08 + random() * (w - 0.16);
    const y = 0.08 + random() * (h - 0.16);
    const r = 0.012 + random() * 0.03;
    ctx.fillStyle = 'rgba(35, 36, 40, 0.6)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(190, 190, 185, 0.3)';
    ctx.lineWidth = 0.008;
    ctx.beginPath();
    ctx.arc(x, y, r, 0.2, Math.PI - 0.2);
    ctx.stroke();
  }
  // Chisel marks on a dressed face: faint strokes across it.
  ctx.strokeStyle = 'rgba(40, 40, 44, 0.12)';
  ctx.lineWidth = 0.01;
  for (let k = 0; k < w * h * 14; k++) {
    const x = random() * w;
    const y = random() * h;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.05 + random() * 0.06, y + 0.12);
    ctx.stroke();
  }
  const size = Math.min(0.09, Math.min(w, h) * 0.18);
  bevel(ctx, w, h, size, 'rgba(205, 205, 200, 0.25)', 'rgba(20, 20, 26, 0.5)');
  // Chipped corners.
  ctx.fillStyle = 'rgba(30, 30, 36, 0.55)';
  for (const [cx, cy, sx, sy] of [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]]) {
    if (random() < 0.5) continue;
    const c = 0.03 + random() * 0.06;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + sx * c * (1 + random()), cy);
    ctx.lineTo(cx, cy + sy * c * (1 + random()));
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = '#33363b';
  ctx.lineWidth = 0.03;
  ctx.strokeRect(0.015, 0.015, w - 0.03, h - 0.03);
}

function paintIce(ctx, w, h, random) {
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, '#79bad6');
  gradient.addColorStop(0.45, '#4f93ba');
  gradient.addColorStop(1, '#2f6f96');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
  // Depth: a darker core, lighter toward the edges, as light gathers in the rim.
  const core = ctx.createRadialGradient(w * 0.55, h * 0.6, 0, w * 0.55, h * 0.6, Math.max(w, h) * 0.7);
  core.addColorStop(0, 'rgba(25, 70, 105, 0.35)');
  core.addColorStop(1, 'rgba(25, 70, 105, 0)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, w, h);
  // Bands of light through it, slanting.
  for (let k = 0; k < 2 + Math.floor(random() * 2); k++) {
    const x = (0.1 + random() * 0.8) * (w + h) - h;
    const b = (0.06 + random() * 0.14) * Math.min(w, h, 1);
    ctx.fillStyle = `rgba(175, 222, 240, ${0.1 + random() * 0.12})`;
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x + h, 0);
    ctx.lineTo(x + h + b, 0);
    ctx.lineTo(x + b, h);
    ctx.closePath();
    ctx.fill();
  }
  // Frozen-in bubbles and fine cracks.
  for (let k = 0; k < w * h * 22; k++) {
    const x = 0.06 + random() * (w - 0.12);
    const y = 0.06 + random() * (h - 0.12);
    const r = 0.008 + random() * 0.02;
    ctx.strokeStyle = 'rgba(195, 232, 246, 0.4)';
    ctx.lineWidth = 0.006;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(185, 228, 244, 0.22)';
  ctx.lineWidth = 0.008;
  for (let k = 0; k < w * h * 4; k++) {
    let x = random() * w;
    let y = random() * h;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 3; s++) {
      x += (random() - 0.5) * 0.25;
      y += (random() - 0.5) * 0.25;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // A frosted rim, and a sharp glint on the top left.
  const rim = Math.min(0.07, Math.min(w, h) * 0.14);
  ctx.strokeStyle = 'rgba(170, 220, 240, 0.45)';
  ctx.lineWidth = rim;
  ctx.strokeRect(rim / 2, rim / 2, w - rim, h - rim);
  bevel(ctx, w, h, rim * 0.6, 'rgba(205, 238, 250, 0.35)', 'rgba(15, 50, 80, 0.45)');
  ctx.strokeStyle = 'rgba(200, 232, 245, 0.6)';
  ctx.lineWidth = 0.025;
  const g = Math.min(w, h) * 0.32;
  ctx.beginPath();
  ctx.moveTo(rim * 1.6, rim * 1.6 + g);
  ctx.lineTo(rim * 1.6 + g, rim * 1.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(rim * 1.6, rim * 1.6 + g * 1.5);
  ctx.lineTo(rim * 1.6 + g * 0.25, rim * 1.6 + g * 1.25);
  ctx.stroke();
  ctx.strokeStyle = '#21506d';
  ctx.lineWidth = 0.025;
  ctx.strokeRect(0.0125, 0.0125, w - 0.025, h - 0.025);
}

function paintTnt(ctx, w, h, random, sides) {
  // A red crate of slats.
  const slats = Math.max(3, Math.round(w / 0.2));
  for (let i = 0; i < slats; i++) {
    const x = (w * i) / slats;
    const gradient = ctx.createLinearGradient(x, 0, x + w / slats, h);
    const base = i % 2 ? '#b42a20' : '#a8241c';
    gradient.addColorStop(0, shade(base, 0.12));
    gradient.addColorStop(1, shade(base, -0.25));
    ctx.fillStyle = gradient;
    ctx.fillRect(x, 0, w / slats, h);
    ctx.fillStyle = 'rgba(40, 6, 4, 0.5)';
    ctx.fillRect(x, 0, 0.012, h);
  }
  for (let k = 0; k < w * h * 60; k++) {
    ctx.fillStyle = 'rgba(30, 5, 3, 0.18)';
    ctx.fillRect(random() * w, random() * h, 0.04 + random() * 0.1, 0.006);
  }
  // Iron bands top and bottom, riveted.
  const band = h * 0.12;
  for (const y of [h * 0.06, h - h * 0.06 - band]) {
    const gradient = ctx.createLinearGradient(0, y, 0, y + band);
    gradient.addColorStop(0, '#5a5550');
    gradient.addColorStop(1, '#2a2622');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, y, w, band);
    for (const x of [w * 0.12, w * 0.5, w * 0.88]) nail(ctx, x, y + band / 2, band * 0.22);
  }
  if (sides) {
    bevel(ctx, w, h, Math.min(0.04, w * 0.06), 'rgba(250, 170, 140, 0.25)', 'rgba(30, 4, 2, 0.5)');
    return;
  }
  // The label: a dark yellow plate, the letters stencilled on it.
  const lw = w * 0.74;
  const lh = h * 0.36;
  ctx.fillStyle = '#2a0e0a';
  roundRect(ctx, (w - lw) / 2 - 0.02, (h - lh) / 2 - 0.02, lw + 0.04, lh + 0.04, 0.05);
  ctx.fill();
  const plate = ctx.createLinearGradient(0, (h - lh) / 2, 0, (h + lh) / 2);
  plate.addColorStop(0, '#d8a83a');
  plate.addColorStop(1, '#a87a1e');
  ctx.fillStyle = plate;
  roundRect(ctx, (w - lw) / 2, (h - lh) / 2, lw, lh, 0.04);
  ctx.fill();
  // Text this small (in metres) draws badly: draw it 100 times larger, scaled down.
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(0.01, 0.01);
  ctx.fillStyle = '#3a110c';
  ctx.font = `900 ${lh * 82}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('TNT', 0, lh * 6);
  ctx.restore();
  bevel(ctx, w, h, Math.min(0.04, w * 0.06), 'rgba(250, 170, 140, 0.25)', 'rgba(30, 4, 2, 0.5)');
  ctx.strokeStyle = '#3a0c08';
  ctx.lineWidth = 0.025;
  ctx.strokeRect(0.0125, 0.0125, w - 0.025, h - 0.025);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Cracks, more the more it is hurt: jagged, branching, each with a lit edge; at
 * the worst, chips gone from its corners.
 */
function paintCracks(ctx, body, cracks) {
  if (!cracks) return;
  const { w, h } = body;
  const random = seeded(body.id * 7 + 3);
  const ice = body.material === 'ice';
  const scale = Math.min(1, Math.max(w, h) / 1.5) * Math.min(w, h, 1) ** 0.3;
  const draw = (x, y, angle, length, width, depth) => {
    const points = [[x, y]];
    for (let s = 0; s < 5; s++) {
      angle += (random() - 0.5) * 1.1;
      x += Math.cos(angle) * length / 5;
      y += Math.sin(angle) * length / 5;
      points.push([x, y]);
      if (depth < 2 && random() < 0.3) draw(x, y, angle + (random() < 0.5 ? 0.9 : -0.9), length * 0.45, width * 0.6, depth + 1);
    }
    const path = (dx, dy) => {
      ctx.beginPath();
      points.forEach(([px, py], i) => (i ? ctx.lineTo(px + dx, py + dy) : ctx.moveTo(px + dx, py + dy)));
      ctx.stroke();
    };
    ctx.lineWidth = width;
    ctx.strokeStyle = ice ? 'rgba(200, 236, 248, 0.6)' : 'rgba(225, 205, 175, 0.25)';
    path(width * 0.6, width * 0.6);
    ctx.strokeStyle = ice ? 'rgba(15, 45, 70, 0.7)' : 'rgba(18, 12, 8, 0.85)';
    path(0, 0);
  };
  for (let c = 0; c < cracks * 2 - 1; c++) {
    // From an edge, inward.
    const side = Math.floor(random() * 4);
    const t = 0.15 + random() * 0.7;
    const [x, y, angle] = [[t * w, 0, Math.PI / 2], [w, t * h, Math.PI], [t * w, h, -Math.PI / 2], [0, t * h, 0]][side];
    draw(x, y, angle + (random() - 0.5) * 0.8, (0.35 + random() * 0.4) * Math.min(Math.max(w, h), 1.6) * (0.6 + 0.4 * scale), 0.03, 0);
  }
  if (cracks < 3) return;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  for (const [cx, cy, sx, sy] of [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]]) {
    if (random() < 0.55) continue;
    const c = Math.min(w, h) * (0.12 + random() * 0.12);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + sx * c * (0.8 + random() * 0.6), cy);
    ctx.lineTo(cx + sx * c * 0.4 * random(), cy + sy * c * 0.4 * random());
    ctx.lineTo(cx, cy + sy * c * (0.8 + random() * 0.6));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// ---- Goblins and the boulder ------------------------------------------------------

const sprites = new Map();

/** A goblin, painted once for its kind, size and whether it is hurt; the canvas and the size it covers (metres). */
function goblinSprite(body, hurt) {
  const key = `${body.goblin}|${body.r}|${hurt}`;
  let sprite = sprites.get(key);
  if (sprite) return sprite;
  const r = body.r;
  const half = r * 1.6; // across, ears and all
  const up = r * (body.goblin === 'king' ? 1.8 : 1.4);
  const down = r * 1.05;
  const canvas = makeCanvas(half * 2 * TEXTURE_PPM, (up + down) * TEXTURE_PPM);
  const ctx = canvas.getContext('2d');
  ctx.scale(TEXTURE_PPM, TEXTURE_PPM);
  ctx.translate(half, up);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  paintGoblin(ctx, body, hurt);
  sprite = { canvas, x: -half, y: -up, w: half * 2, h: up + down };
  sprites.set(key, sprite);
  if (!hurt) warmLater(() => goblinSprite(body, true));
  return sprite;
}

function drawGoblinAt(ctx, view, pose) {
  const at = project(view, pose.x, pose.y, pose.z);
  if (at.depth <= 0.1) return;
  const scale = view.f / at.depth;
  const sprite = goblinSprite(pose.body, pose.health < 0.5);
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.rotate(-pose.a);
  ctx.scale(scale, scale);
  ctx.drawImage(sprite.canvas, sprite.x, sprite.y, sprite.w, sprite.h);
  ctx.restore();
}

// Drawn in metres about the goblin's centre, y down.
function paintGoblin(ctx, body, hurt) {
  const r = body.r;
  const outline = '#1f3d12';
  // Long pointed ears, a little drooping, pink inside.
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * r * 0.7, -r * 0.4);
    ctx.quadraticCurveTo(side * r * 1.25, -r * 0.55, side * r * 1.55, -r * 0.42);
    ctx.quadraticCurveTo(side * r * 1.2, -r * 0.05, side * r * 0.8, r * 0.22);
    ctx.closePath();
    const ear = ctx.createLinearGradient(side * r * 0.7, -r * 0.5, side * r * 1.5, r * 0.1);
    ear.addColorStop(0, '#5c9e36');
    ear.addColorStop(1, '#3c7224');
    ctx.fillStyle = ear;
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.lineWidth = r * 0.07;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(side * r * 0.82, -r * 0.3);
    ctx.quadraticCurveTo(side * r * 1.2, -r * 0.42, side * r * 1.38, -r * 0.38);
    ctx.quadraticCurveTo(side * r * 1.1, -r * 0.1, side * r * 0.86, r * 0.08);
    ctx.closePath();
    ctx.fillStyle = '#a2675a';
    ctx.fill();
  }
  // The head, lit from above left.
  const head = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r * 1.05);
  head.addColorStop(0, '#8cc457');
  head.addColorStop(0.55, '#5c9e36');
  head.addColorStop(1, '#335f1e');
  ctx.fillStyle = head;
  ctx.beginPath();
  ctx.ellipse(0, r * 0.02, r * 0.97, r * 0.95, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = r * 0.07;
  ctx.stroke();
  // Warts.
  ctx.fillStyle = 'rgba(40, 80, 22, 0.75)';
  for (const [x, y, s] of [[0.55, -0.55, 0.07], [-0.62, 0.3, 0.06], [0.68, 0.22, 0.05]]) {
    ctx.beginPath();
    ctx.arc(x * r, y * r, s * r, 0, Math.PI * 2);
    ctx.fill();
  }
  // A heavy brow's shadow over the eyes.
  ctx.fillStyle = 'rgba(30, 60, 15, 0.35)';
  ctx.beginPath();
  ctx.ellipse(0, -r * 0.2, r * 0.75, r * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  // Eyes: yellow, glaring; half shut and sore once hurt.
  for (const side of [-1, 1]) {
    const shut = hurt ? (side < 0 ? 0.35 : 0.6) : 1;
    const ex = side * r * 0.36;
    const ey = -r * 0.1;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(ex, ey, r * 0.22, r * 0.25 * shut, side * -0.15, 0, Math.PI * 2);
    ctx.clip();
    const eye = ctx.createRadialGradient(ex - r * 0.05, ey - r * 0.08, 0, ex, ey, r * 0.28);
    eye.addColorStop(0, '#f0dc6a');
    eye.addColorStop(1, '#c49a2a');
    ctx.fillStyle = hurt ? '#d6b04a' : eye;
    ctx.fillRect(ex - r * 0.3, ey - r * 0.3, r * 0.6, r * 0.6);
    ctx.fillStyle = '#7a2a12';
    ctx.beginPath();
    ctx.arc(ex - side * r * 0.04, ey + r * 0.02, r * 0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#140c08';
    ctx.beginPath();
    ctx.arc(ex - side * r * 0.04, ey + r * 0.02, r * 0.065, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(215, 210, 190, 0.85)';
    ctx.beginPath();
    ctx.arc(ex - side * r * 0.04 - r * 0.04, ey - r * 0.03, r * 0.03, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = outline;
    ctx.lineWidth = r * 0.04;
    ctx.beginPath();
    ctx.ellipse(ex, ey, r * 0.22, r * 0.25 * shut, side * -0.15, 0, Math.PI * 2);
    ctx.stroke();
    // A thick scowling brow.
    ctx.strokeStyle = '#24440f';
    ctx.lineWidth = r * 0.12;
    ctx.beginPath();
    ctx.moveTo(side * r * 0.66, -r * (hurt ? 0.36 : 0.46));
    ctx.quadraticCurveTo(side * r * 0.4, -r * 0.42, side * r * 0.1, -r * (hurt ? 0.36 : 0.27));
    ctx.stroke();
  }
  // A long nose with a lit tip.
  const nose = ctx.createRadialGradient(-r * 0.05, r * 0.08, 0, 0, r * 0.15, r * 0.22);
  nose.addColorStop(0, '#8fc75a');
  nose.addColorStop(1, '#3f7a24');
  ctx.fillStyle = nose;
  ctx.beginPath();
  ctx.moveTo(-r * 0.08, -r * 0.08);
  ctx.quadraticCurveTo(-r * 0.2, r * 0.22, -r * 0.05, r * 0.28);
  ctx.quadraticCurveTo(r * 0.16, r * 0.3, r * 0.12, r * 0.1);
  ctx.quadraticCurveTo(r * 0.06, -r * 0.05, -r * 0.08, -r * 0.08);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(31, 61, 18, 0.7)';
  ctx.lineWidth = r * 0.035;
  ctx.stroke();
  // A wide grin, two tusks up from the lower jaw.
  ctx.fillStyle = '#3a1410';
  ctx.beginPath();
  ctx.moveTo(-r * 0.46, r * 0.36);
  ctx.quadraticCurveTo(0, r * (hurt ? 0.5 : 0.82), r * 0.46, r * 0.36);
  ctx.quadraticCurveTo(0, r * 0.5, -r * 0.46, r * 0.36);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = r * 0.045;
  ctx.stroke();
  for (const side of [-1, 1]) {
    ctx.fillStyle = '#d8cb98';
    ctx.beginPath();
    ctx.moveTo(side * r * 0.3, r * 0.6);
    ctx.lineTo(side * r * 0.18, r * 0.6);
    ctx.lineTo(side * r * 0.26, r * 0.33);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(80, 60, 30, 0.6)';
    ctx.lineWidth = r * 0.02;
    ctx.stroke();
  }
  if (hurt) {
    // A sticking plaster across the forehead.
    ctx.save();
    ctx.translate(r * 0.3, -r * 0.62);
    ctx.rotate(-0.5);
    ctx.fillStyle = '#c4a27a';
    ctx.fillRect(-r * 0.28, -r * 0.07, r * 0.56, r * 0.14);
    ctx.rotate(1.1);
    ctx.fillRect(-r * 0.28, -r * 0.07, r * 0.56, r * 0.14);
    ctx.restore();
  }
  if (body.goblin === 'helmet' || body.goblin === 'king') paintHelmet(ctx, r);
  if (body.goblin === 'king') paintCrown(ctx, r);
}

function paintHelmet(ctx, r) {
  // A dented iron pot over the top of the head, a riveted rim, a little spike.
  const iron = ctx.createLinearGradient(-r, -r, r * 0.6, -r * 0.2);
  iron.addColorStop(0, '#a3a8af');
  iron.addColorStop(0.5, '#767b83');
  iron.addColorStop(1, '#4b4f56');
  ctx.fillStyle = '#3a3d42';
  ctx.beginPath();
  ctx.moveTo(-r * 0.12, -r * 1.02);
  ctx.lineTo(0, -r * 1.28);
  ctx.lineTo(r * 0.12, -r * 1.02);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = iron;
  ctx.beginPath();
  ctx.arc(0, -r * 0.2, r * 0.98, Math.PI * 1.06, Math.PI * 1.94);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#2e3135';
  ctx.lineWidth = r * 0.05;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(210, 214, 220, 0.4)';
  ctx.lineWidth = r * 0.07;
  ctx.beginPath();
  ctx.arc(0, -r * 0.2, r * 0.78, Math.PI * 1.22, Math.PI * 1.45);
  ctx.stroke();
  ctx.fillStyle = 'rgba(40, 42, 46, 0.45)';
  ctx.beginPath();
  ctx.ellipse(r * 0.38, -r * 0.72, r * 0.12, r * 0.07, 0.4, 0, Math.PI * 2);
  ctx.fill();
  const rim = ctx.createLinearGradient(0, -r * 0.46, 0, -r * 0.28);
  rim.addColorStop(0, '#8d929a');
  rim.addColorStop(1, '#4a4e55');
  ctx.fillStyle = rim;
  roundRect(ctx, -r * 1.02, -r * 0.46, r * 2.04, r * 0.17, r * 0.06);
  ctx.fill();
  ctx.strokeStyle = '#2e3135';
  ctx.lineWidth = r * 0.04;
  ctx.stroke();
  for (let k = -3; k <= 3; k++) {
    ctx.fillStyle = '#c0c4ca';
    ctx.beginPath();
    ctx.arc(k * r * 0.27, -r * 0.375, r * 0.03, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintCrown(ctx, r) {
  const top = -r * 1.0;
  const gold = ctx.createLinearGradient(-r * 0.6, top - r * 0.7, r * 0.6, top);
  gold.addColorStop(0, '#f0c040');
  gold.addColorStop(0.5, '#c9921a');
  gold.addColorStop(1, '#8a5e0c');
  ctx.fillStyle = gold;
  ctx.strokeStyle = '#5a3b06';
  ctx.lineWidth = r * 0.045;
  ctx.beginPath();
  ctx.moveTo(-r * 0.58, top);
  ctx.lineTo(-r * 0.66, top - r * 0.56);
  ctx.lineTo(-r * 0.32, top - r * 0.28);
  ctx.lineTo(0, top - r * 0.72);
  ctx.lineTo(r * 0.32, top - r * 0.28);
  ctx.lineTo(r * 0.66, top - r * 0.56);
  ctx.lineTo(r * 0.58, top);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Balls on its points, a band of jewels.
  for (const [x, y] of [[-0.66, -0.56], [0, -0.72], [0.66, -0.56]]) {
    ctx.fillStyle = '#e8b830';
    ctx.beginPath();
    ctx.arc(x * r, top + y * r, r * 0.07, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(90, 59, 6, 0.6)';
  ctx.fillRect(-r * 0.58, top - r * 0.18, r * 1.16, r * 0.04);
  for (const [x, colour] of [[-0.34, '#b0242a'], [0, '#2a5fb0'], [0.34, '#b0242a']]) {
    const jewel = ctx.createRadialGradient(x * r - r * 0.03, top - r * 0.12, 0, x * r, top - r * 0.09, r * 0.09);
    jewel.addColorStop(0, shade(colour, 0.6));
    jewel.addColorStop(1, colour);
    ctx.fillStyle = jewel;
    ctx.beginPath();
    ctx.arc(x * r, top - r * 0.09, r * 0.08, 0, Math.PI * 2);
    ctx.fill();
  }
}

let rockSprite = null;

/** The boulder's rock, painted once: a lumpy outline, cracks and lichen (without its light, which stays still as it turns). */
function boulderRock(r) {
  if (rockSprite && rockSprite.r === r) return rockSprite;
  const random = seeded(99);
  const outline = Array.from({ length: 11 }, (_, i) => {
    const a = (i / 11) * Math.PI * 2;
    const rr = r * (0.88 + random() * 0.14);
    return [Math.cos(a) * rr, Math.sin(a) * rr];
  });
  const size = r * 2 * TEXTURE_PPM;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.scale(TEXTURE_PPM, TEXTURE_PPM);
  ctx.translate(r, r);
  const path = new Path2D();
  outline.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
  path.closePath();
  ctx.save();
  ctx.clip(path);
  ctx.fillStyle = '#6a6058';
  ctx.fillRect(-r, -r, r * 2, r * 2);
  for (let k = 0; k < 40; k++) {
    const x = (random() - 0.5) * r * 2;
    const y = (random() - 0.5) * r * 2;
    const s = r * (0.08 + random() * 0.25);
    const blotch = ctx.createRadialGradient(x, y, 0, x, y, s);
    const colour = random() < 0.6 ? '40, 34, 30' : random() < 0.5 ? '130, 120, 100' : '85, 100, 60';
    blotch.addColorStop(0, `rgba(${colour}, 0.35)`);
    blotch.addColorStop(1, `rgba(${colour}, 0)`);
    ctx.fillStyle = blotch;
    ctx.fillRect(x - s, y - s, s * 2, s * 2);
  }
  for (let k = 0; k < 400; k++) {
    ctx.fillStyle = random() < 0.5 ? 'rgba(25, 20, 18, 0.35)' : 'rgba(170, 160, 145, 0.25)';
    ctx.fillRect((random() - 0.5) * r * 2, (random() - 0.5) * r * 2, r * 0.03, r * 0.03);
  }
  ctx.strokeStyle = 'rgba(28, 22, 18, 0.6)';
  ctx.lineWidth = r * 0.04;
  for (let k = 0; k < 4; k++) {
    let x = (random() - 0.5) * r;
    let y = (random() - 0.5) * r;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 4; s++) {
      x += (random() - 0.5) * r * 0.5;
      y += (random() - 0.5) * r * 0.5;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
  rockSprite = { r, canvas, path };
  return rockSprite;
}

/** The boulder, turning, lit from above left, with its shadow on the ground beneath it. */
function drawBoulderAt(ctx, view, pose) {
  const at = project(view, pose.x, pose.y, pose.z);
  if (at.depth < CASTLE_CRASH_RULES.boulder.shownFrom) return;
  const r = pose.body.r;
  const lift = Math.max(0, 1 - pose.y / 8);
  if (lift > 0) drawGroundShadow(ctx, view, pose.x, pose.z, r * 1.1, r * 0.7, 0.5 * lift);
  const rock = boulderRock(r);
  const scale = view.f / at.depth;
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.scale(scale, scale);
  ctx.save();
  ctx.rotate(-pose.a);
  ctx.drawImage(rock.canvas, -r, -r, r * 2, r * 2);
  ctx.clip(rock.path);
  ctx.rotate(pose.a);
  const light = ctx.createRadialGradient(-r * 0.4, -r * 0.45, r * 0.05, 0, 0, r * 1.05);
  light.addColorStop(0, 'rgba(225, 205, 175, 0.35)');
  light.addColorStop(0.45, 'rgba(0, 0, 0, 0)');
  light.addColorStop(1, 'rgba(8, 6, 4, 0.7)');
  ctx.fillStyle = light;
  ctx.fillRect(-r * 1.1, -r * 1.1, r * 2.2, r * 2.2);
  ctx.restore();
  ctx.rotate(-pose.a);
  ctx.strokeStyle = '#231d19';
  ctx.lineWidth = r * 0.05;
  ctx.stroke(rock.path);
  ctx.restore();
}

// ---- Effects ------------------------------------------------------------------

/**
 * Draws what a shot's events set off, `ms` into it: splinters, chips or shards
 * and a cloud of dust where a block broke, a green puff and dizzy stars where a
 * goblin was beaten, a blast's fireball, smoke and sparks, and the points rising.
 * @param {PlayEvent[]} events
 * @param {Map<number, import('./castle-crash-physics.js').Body>} bodies
 */
export function drawEffects(ctx, view, events, bodies, ms) {
  // Twice: the soft things (dust, smoke, fire, puffs) onto a coarse layer, which is then laid over
  // the picture at once, then the sharp ones (pieces, sparks, stars, points) on top, at full detail.
  // Each event's randomness is drawn the same both times, so the two halves agree.
  softLayer(view);
  for (const pass of ['soft', 'sharp']) {
    effectPass = pass;
    for (const event of events) {
      const age = ms - event.ms;
      if (age < 0) break;
      const body = bodies.get(event.id);
      if (event.type === 'boom') drawBoom(ctx, view, event, age);
      else if (event.type === 'poof') drawPuff(ctx, view, event, age, [120, 105, 90], false);
      else if (event.type === 'goblin' || (event.type === 'gone' && body?.kind === 'goblin')) {
        drawPuff(ctx, view, event, age, [95, 150, 58], true);
      } else if ((event.type === 'break' || event.type === 'shatter') && body) drawPieces(ctx, view, event, body, age);
      if (event.points && pass === 'sharp') drawPoints(ctx, view, event, age);
    }
    if (pass === 'soft') layOnSoft(ctx);
  }
}

// Soft effects are drawn this many layer pixels to a screen pixel (CSS): they look the same coarse,
// and cost a fraction as much to fill.
const SOFT_SCALE = 0.35;
let effectPass = 'sharp';
let soft = null;

/** The coarse layer, cleared, the size of the screen. */
function softLayer(view) {
  const w = Math.ceil(view.width * SOFT_SCALE);
  const h = Math.ceil(view.height * SOFT_SCALE);
  if (!soft || soft.canvas.width !== w || soft.canvas.height !== h) {
    const canvas = makeCanvas(w, h);
    soft = { canvas, ctx: canvas.getContext('2d'), box: null };
  }
  if (soft.box) {
    soft.ctx.setTransform(1, 0, 0, 1, 0, 0);
    soft.ctx.clearRect(soft.box.x0, soft.box.y0, soft.box.x1 - soft.box.x0, soft.box.y1 - soft.box.y0);
  }
  soft.ctx.setTransform(SOFT_SCALE, 0, 0, SOFT_SCALE, 0, 0);
  soft.box = null;
}

/** Lays what was drawn on the coarse layer over the picture. */
function layOnSoft(ctx) {
  const box = soft.box;
  if (!box) return;
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  if (w <= 0 || h <= 0) return;
  ctx.drawImage(soft.canvas, box.x0, box.y0, w, h, box.x0 / SOFT_SCALE, box.y0 / SOFT_SCALE, w / SOFT_SCALE, h / SOFT_SCALE);
}

/** How long after the last event the effects are still moving (ms). */
export function effectsEndAt(events) {
  let end = 0;
  for (const e of events) end = Math.max(end, e.ms + effectMs(e));
  return end;
}

/** How long an event's effect lasts (ms). */
export function effectMs(event) {
  return event.points ? EFFECT_MS.points : event.type === 'boom' ? EFFECT_MS.boom : EFFECT_MS.pieces;
}

/**
 * The rectangle (normalised screen coordinates) an event's effect is drawn in
 * over its whole life: where its pieces fly and its dust spreads, its puff
 * spreads, its blast burns and its points rise.
 * @param {View} view
 * @param {PlayEvent} event
 * @param {import('./castle-crash-physics.js').Body} [body]
 */
export function effectArea(view, event, body) {
  const { x, y, z } = event;
  const w = body?.w || 1;
  const h = body?.h || 1;
  // A box in the world round all of it (metres): across, up and down, near and far.
  let box;
  if (event.type === 'boom') {
    const r = CASTLE_CRASH_RULES.tnt.radius;
    box = { x0: x - r, x1: x + r, y0: y - r, y1: y + r, z0: z - r, z1: z + r };
  } else if ((event.type === 'break' || event.type === 'shatter') && body?.kind === 'block') {
    // Pieces: thrown up and out, and back (or forward) with the push; dust round it (drawPieces).
    const fly = 1.5 * (EFFECT_MS.pieces / 1000) * (event.push ?? 0);
    box = {
      x0: x - w / 2 - 3.3, x1: x + w / 2 + 3.3, y0: 0, y1: y + h / 2 + 1.8,
      z0: z - 1.5 + Math.min(0, fly), z1: z + 1.5 + Math.max(0, fly),
    };
  } else {
    // A puff where it stands, its stars round it (drawPuff), or nothing but the points.
    const r = 1.9 * (body?.shape === 'circle' ? Math.max(1, body.r / 0.55) : 1);
    box = { x0: x - r, x1: x + r, y0: y - r, y1: y + r, z0: z, z1: z };
  }
  if (event.points) {
    box.x0 = Math.min(box.x0, x - 2);
    box.x1 = Math.max(box.x1, x + 2);
    box.y1 = Math.max(box.y1, y + 3.2);
  }
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const px of [box.x0, box.x1]) {
    for (const py of [Math.max(0, box.y0), box.y1]) {
      for (const pz of [box.z0, box.z1]) {
        const p = project(view, px, py, Math.max(pz, 1));
        if (p.depth <= 0.1) continue;
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      }
    }
  }
  return { x0: x0 / view.width, y0: y0 / view.height, x1: x1 / view.width, y1: y1 / view.height };
}

const blobSprites = new Map();
const BLOB_PX = 64;

/**
 * A soft round blob of colour (`rgb` a list of three, each rounded to a step of 8),
 * fading to nothing at its edge (soft pass only). `fire` blobs are yellow inside,
 * `rgb` halfway out and dark red at the rim.
 */
function blob(x, y, r, rgb, alpha, fire = false) {
  if (effectPass !== 'soft' || r <= 0.5 || alpha <= 0.005) return;
  const c = rgb.map((v) => Math.min(255, Math.round(v / 8) * 8));
  const key = `${c.join(',')}|${fire}`;
  let sprite = blobSprites.get(key);
  if (!sprite) {
    sprite = makeCanvas(BLOB_PX, BLOB_PX);
    const sctx = sprite.getContext('2d');
    const h = BLOB_PX / 2;
    const gradient = sctx.createRadialGradient(h, h, 0, h, h, h);
    const colour = `${c[0]}, ${c[1]}, ${c[2]}`;
    if (fire) {
      gradient.addColorStop(0, 'rgba(250, 190, 70, 0.9)');
      gradient.addColorStop(0.5, `rgba(${colour}, 0.75)`);
      gradient.addColorStop(0.85, 'rgba(150, 40, 20, 0.4)');
      gradient.addColorStop(1, 'rgba(120, 30, 15, 0)');
    } else {
      gradient.addColorStop(0, `rgba(${colour}, 1)`);
      gradient.addColorStop(0.6, `rgba(${colour}, 0.55)`);
      gradient.addColorStop(1, `rgba(${colour}, 0)`);
    }
    sctx.fillStyle = gradient;
    sctx.fillRect(0, 0, BLOB_PX, BLOB_PX);
    blobSprites.set(key, sprite);
  }
  const ctx = soft.ctx;
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(sprite, x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = 1;
  const w = soft.canvas.width;
  const h = soft.canvas.height;
  const x0 = Math.max(0, Math.floor((x - r) * SOFT_SCALE) - 1);
  const y0 = Math.max(0, Math.floor((y - r) * SOFT_SCALE) - 1);
  const x1 = Math.min(w, Math.ceil((x + r) * SOFT_SCALE) + 1);
  const y1 = Math.min(h, Math.ceil((y + r) * SOFT_SCALE) + 1);
  const box = soft.box;
  soft.box = box ? { x0: Math.min(box.x0, x0), y0: Math.min(box.y0, y0), x1: Math.max(box.x1, x1), y1: Math.max(box.y1, y1) } : { x0, y0, x1, y1 };
}

// Each material's pieces: how long against wide, how many corners, and their colours.
const PIECE_LOOK = {
  wood: { long: 3.2, corners: 4, colours: ['#a8743f', '#7c5129', '#c28a52', '#5a3a1d'] },
  stone: { long: 1.2, corners: 5, colours: ['#8a8e95', '#6a6e75', '#9fa3a9', '#4c4f55'] },
  ice: { long: 1.8, corners: 3, colours: ['#79bad6', '#9fd2e6', '#4f93ba', '#b3dcec'] },
  tnt: { long: 1.6, corners: 4, colours: ['#b3261e', '#3a2a24', '#7e1913', '#2a2420'] },
};
const DUST_RGB = { wood: [150, 112, 70], stone: [128, 126, 122], ice: [150, 200, 222], tnt: [70, 60, 55] };

function drawPieces(ctx, view, event, body, age) {
  const t = age / 1000;
  const life = age / EFFECT_MS.pieces;
  if (life >= 1) return;
  const look = PIECE_LOOK[body.material];
  const random = seeded(event.id * 13 + 1);
  const g = CASTLE_CRASH_RULES.gravity;
  const push = event.push ?? 0;
  // Dust first, behind the pieces: a few clouds that swell and thin out.
  const rgb = DUST_RGB[body.material];
  for (let i = 0; i < 6; i++) {
    const dx = (random() - 0.5) * (body.w + 0.6);
    const dy = (random() - 0.5) * body.h + life * 0.5;
    const p = project(view, event.x + dx * (1 + life), Math.max(0.1, event.y + dy), event.z + push * 0.2 * t);
    if (p.depth <= 0.1) continue;
    const r = ((0.35 + random() * 0.45) * (0.5 + life) * view.f) / p.depth;
    blob(p.x, p.y, r, rgb, 0.5 * (1 - life) * (body.material === 'ice' ? 0.7 : 1));
  }
  if (effectPass !== 'sharp') return;
  const count = Math.min(18, 7 + Math.round(body.w * body.h * 5));
  ctx.save();
  ctx.globalAlpha = 1 - life * life;
  for (let i = 0; i < count; i++) {
    const vx = (random() - 0.5) * 7;
    const vy = 1 + random() * 5;
    const vz = push * (0.5 + random()) + (random() - 0.5) * 3;
    const x0 = event.x + (random() - 0.5) * body.w;
    const y0 = event.y + (random() - 0.5) * body.h;
    const y = Math.max(0.05, y0 + vy * t - 0.5 * g * t * t);
    const p = project(view, x0 + vx * t, y, event.z + vz * t);
    const size = 0.1 + random() * 0.2;
    const spin = random() * 6 + t * (random() - 0.5) * 14;
    const colour = look.colours[Math.floor(random() * look.colours.length)];
    const shape = Array.from({ length: look.corners }, (_, k) => {
      const a = (k / look.corners) * Math.PI * 2 + random() * 0.6;
      return [Math.cos(a) * look.long * (0.7 + random() * 0.5), Math.sin(a) * (0.7 + random() * 0.5)];
    });
    if (p.depth <= 0.1) continue;
    const s = (size * view.f) / p.depth / look.long;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(spin);
    ctx.scale(s, s);
    ctx.beginPath();
    shape.forEach(([sx, sy], k) => (k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy)));
    ctx.closePath();
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.lineWidth = 0.25;
    ctx.strokeStyle = body.material === 'ice' ? 'rgba(200, 235, 248, 0.7)' : 'rgba(20, 14, 10, 0.6)';
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function drawPuff(ctx, view, event, age, rgb, stars) {
  const life = age / EFFECT_MS.pieces;
  if (life >= 1) return;
  const random = seeded(event.id * 5 + 2);
  const p = project(view, event.x, event.y, event.z);
  if (p.depth <= 0.1) return;
  const s = view.f / p.depth;
  const ease = 1 - (1 - life) ** 2;
  // (All within effectArea's 1.9 m of it.)
  for (let i = 0; i < 9; i++) {
    const angle = random() * Math.PI * 2;
    const reach = (0.2 + random() * 0.5) * ease * s;
    const r = (0.35 + 0.35 * ease + random() * 0.15) * s;
    const tone = 0.8 + random() * 0.4;
    blob(p.x + Math.cos(angle) * reach, p.y + Math.sin(angle) * reach - life * 0.25 * s, r,
      rgb.map((c) => Math.min(200, Math.round(c * tone))), 0.75 * (1 - life));
  }
  if (!stars || effectPass !== 'sharp') return;
  // Dizzy stars spinning out and up.
  ctx.save();
  ctx.globalAlpha = life < 0.6 ? 1 : 1 - (life - 0.6) / 0.4;
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 + life * 5;
    const reach = (0.5 + ease * 0.7) * s;
    const x = p.x + Math.cos(angle) * reach;
    const y = p.y - (0.4 + life * 0.6) * s + Math.sin(angle) * reach * 0.35;
    star(ctx, x, y, 0.16 * s, angle * 2);
  }
  ctx.restore();
}

function star(ctx, x, y, r, turn) {
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = turn + (k / 10) * Math.PI * 2;
    const rr = k % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = '#e8b830';
  ctx.fill();
  ctx.strokeStyle = '#6a4a08';
  ctx.lineWidth = Math.max(1, r * 0.15);
  ctx.stroke();
}

function drawBoom(ctx, view, event, age) {
  const life = age / EFFECT_MS.boom;
  if (life >= 1) return;
  const p = project(view, event.x, event.y, event.z);
  if (p.depth <= 0.1) return;
  const s = view.f / p.depth;
  const R = CASTLE_CRASH_RULES.tnt.radius;
  const random = seeded(event.id * 11 + 5);
  const ease = 1 - (1 - life) ** 3;
  // A ring of air thrown out along the ground.
  const ground = project(view, event.x, 0, event.z);
  if (effectPass === 'sharp' && ground.depth > 0.1 && life < 0.6) {
    const gr = R * ease * 1.05;
    const a = project(view, event.x + gr, 0, event.z);
    const b = project(view, event.x, 0, event.z + gr);
    const c = project(view, event.x, 0, event.z - Math.min(gr, event.z - 1));
    ctx.strokeStyle = `rgba(220, 160, 90, ${0.5 * (1 - life / 0.6)})`;
    ctx.lineWidth = Math.max(1, 0.12 * s);
    ctx.beginPath();
    ctx.ellipse(ground.x, (b.y + c.y) / 2, Math.abs(a.x - ground.x), Math.max(1, Math.abs(c.y - b.y) / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Smoke, dark, swelling and rising behind the fire, lingering after it. (Everything here stays
  // within the blast's radius of where it went off: effectArea.)
  const smoke = Math.min(1, life * 4) * (1 - life) ** 1.2;
  for (let i = 0; i < 11; i++) {
    const angle = random() * Math.PI * 2;
    const reach = (0.4 + random() * 1.0) * ease * s;
    const r = (0.8 + random() * 0.6) * (0.45 + ease * 0.55) * s;
    const tone = 70 + Math.round(random() * 30);
    blob(p.x + Math.cos(angle) * reach, p.y + Math.sin(angle) * reach * 0.6 - life * 0.8 * s, r, [tone + 8, tone, tone - 4], 0.85 * smoke);
  }
  // The fireball: a hot core in billows of flame, yellow inside and red at the edges, gone quickly.
  const fire = Math.max(0, 1 - life * 2);
  if (fire > 0) {
    for (let i = 0; i < 9; i++) {
      const angle = random() * Math.PI * 2;
      const reach = random() * R * 0.45 * ease * s;
      const r = (1.0 + random() * 0.8) * (0.5 + ease * 0.5) * s;
      blob(p.x + Math.cos(angle) * reach, p.y + Math.sin(angle) * reach, r, [225, 100, 30], fire, true);
    }
    blob(p.x, p.y, R * (0.2 + 0.25 * ease) * s, [255, 210, 110], 0.85 * fire * fire);
  }
  // Sparks and embers flying out, slowing.
  if (effectPass !== 'sharp') return;
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < 18; i++) {
    const angle = random() * Math.PI * 2;
    const speed = 0.45 + random() * 0.5;
    const d0 = R * speed * ease;
    const d1 = R * speed * Math.max(0, ease - 0.1);
    const ax = Math.cos(angle);
    const ay = Math.sin(angle);
    ctx.strokeStyle = `rgba(250, ${140 + Math.round(random() * 90)}, 60, ${Math.max(0, 1 - life * 1.4)})`;
    ctx.lineWidth = Math.max(1, 0.07 * s);
    ctx.beginPath();
    ctx.moveTo(p.x + ax * d1 * s, p.y + ay * d1 * s);
    ctx.lineTo(p.x + ax * d0 * s, p.y + ay * d0 * s);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPoints(ctx, view, event, age) {
  const life = age / EFFECT_MS.points;
  if (life >= 1) return;
  const p = project(view, event.x, event.y + 0.9 + life * 1.6, event.z);
  if (p.depth <= 0.1) return;
  const s = view.f / p.depth;
  const big = event.points >= 5000;
  const pop = life < 0.12 ? 0.6 + (life / 0.12) * 0.55 : life < 0.2 ? 1.15 - ((life - 0.12) / 0.08) * 0.15 : 1;
  const size = (big ? 1.0 : 0.65) * s * pop;
  ctx.save();
  ctx.globalAlpha = life < 0.7 ? 1 : 1 - (life - 0.7) / 0.3;
  ctx.font = `900 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const text = `+${event.points}`;
  ctx.lineWidth = 0.2 * size;
  ctx.strokeStyle = '#1a120a';
  ctx.strokeText(text, p.x, p.y + size * 0.06);
  const fill = ctx.createLinearGradient(0, p.y - size / 2, 0, p.y + size / 2);
  if (big) {
    fill.addColorStop(0, '#ffd85a');
    fill.addColorStop(1, '#d88a10');
  } else {
    fill.addColorStop(0, '#f2b45a');
    fill.addColorStop(1, '#b8661e');
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, p.x, p.y);
  ctx.restore();
}

/** Repeatable random numbers 0–1 from a seed, so each body's look and pieces never change. */
function seeded(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
