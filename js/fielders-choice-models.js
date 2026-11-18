// Fielder's Choice in 3D, kept free of the browser so it can be unit-tested:
// the ballpark built to a real field's measurements (the ground in layers, the
// mound, the bags and the chalk, the walls, the stands and the crowd in them,
// the light towers, foul poles, dugouts and scoreboards), the players as solid
// cartoon shapes posed from their skeletons (fielders-choice-players.js), and
// the matrices that turn a view (fielders-choice-logic.js) into the picture.
// fielders-choice-gl.js draws all of it with WebGL.
//
// Field positions are in feet, as in the logic file: home plate's back point
// at the origin, +y out to centre field, +x towards first base, z up.

import { BASES } from './fielders-choice-logic.js';
import { BODY, TEAMS, SKIN, placed } from './fielders-choice-players.js';

/** @typedef {{x:number, y:number}} Point */
/** @typedef {{x:number, y:number, z:number}} Point3 */

const TAU = 2 * Math.PI;
const D = 90 / Math.SQRT2;

// ---- The field's measurements -------------------------------------------------

/** The measurements the field is built to (feet), from the rule book. */
export const FIELD = {
  bag: 15 / 12, // the bases are 15 inches square…
  bagHeight: 0.25, // …and 3 inches high
  plate: { front: 17 / 12, side: 8.5 / 12 },
  line: 3 / 12, // every chalk line is 3 inches wide
  box: { width: 4, length: 6, gap: 6 / 12 }, // the batter's boxes, 6 inches off the plate
  catcherBox: { width: 43 / 12, length: 8 },
  rubber: { width: 2, depth: 0.5, front: 60.5 },
  mound: { centre: 59, radius: 9, height: 10 / 12, top: 2.5 },
  arc: 95, // the edge of the infield dirt, from the front of the rubber
  cutout: 13, // the dirt round home, first and third
  basePath: 3, // dirt either side of the lines from home to first and third
  runningLane: { from: 45, width: 3 },
  coachBox: { off: 15, along: [75, 95], depth: 10 },
  onDeck: { r: 2.5, at: [{ x: 37, y: -12 }, { x: -37, y: -12 }] },
  fence: { line: 330, centre: 400, height: 9, track: 15 },
  foulWall: 4,
  pole: 70,
};

export const FENCE = FIELD.fence;
export const MOUND_CENTRE = { x: 0, y: FIELD.mound.centre };
export const PARK_CENTRE = { x: 0, y: 150 };
export const STANDS = { depth: 85, rise: 50, rows: 14 };
export const TOWERS = [{ x: -330, y: 360 }, { x: 330, y: 360 }, { x: -260, y: -60 }, { x: 260, y: -60 }];
export const TOWER_HEIGHT = 130;
export const BULLPEN = { x: -205, y: 165 };
export const BOARDS = [
  { centre: { x: 0, y: 478 }, along: { x: 1, y: 0 }, w: 150, h: 52, z0: 60 },
  { centre: { x: 0, y: -158 }, along: { x: -1, y: 0 }, w: 100, h: 34, z0: 64 },
];

/** How far round the outfield the fence is at `deg` degrees from centre field (330 down the lines, 400 to centre). */
export function fenceDistance(deg) {
  return FENCE.centre - (FENCE.centre - FENCE.line) * (Math.min(45, Math.abs(deg)) / 45) ** 1.5;
}

/** The park's outline on the ground, all the way round: the outfield fence, then the foul-side walls. */
export const PARK = (() => {
  const points = [];
  for (let deg = -45; deg <= 45; deg += 5) {
    const r = fenceDistance(deg);
    const a = (deg * Math.PI) / 180;
    points.push({ x: r * Math.sin(a), y: r * Math.cos(a), wall: FENCE.height, kind: 'outfield', deg });
  }
  const foul = [{ x: 244, y: 180 }, { x: 138, y: 74 }, { x: 74, y: 10 }, { x: 50, y: -35 }, { x: 0, y: -60 }];
  for (const p of foul) points.push({ ...p, wall: FIELD.foulWall, kind: 'foul' });
  for (const p of foul.slice(0, -1).reverse()) points.push({ x: -p.x, y: p.y, wall: FIELD.foulWall, kind: 'foul' });
  return points;
})();

export const FENCE_POINTS = PARK.filter((p) => p.kind === 'outfield');

/** The way out of the park from a point on its edge. */
export function outwards(p) {
  const d = Math.hypot(p.x - PARK_CENTRE.x, p.y - PARK_CENTRE.y);
  return { x: (p.x - PARK_CENTRE.x) / d, y: (p.y - PARK_CENTRE.y) / d };
}

/** How high the ground is: level everywhere but the pitcher's mound. */
export function groundHeight(x, y) {
  const { centre, radius, height, top } = FIELD.mound;
  const r = Math.hypot(x, y - centre);
  if (r >= radius) return 0;
  const t = Math.max(0, (r - top) / (radius - top));
  return height * (1 - t * t * (3 - 2 * t));
}

/** Where the bag for a base sits: its middle, and its sides (unit vectors along and across the line). */
export function bagOf(base) {
  const p = BASES[base];
  const s = FIELD.bag / 2;
  if (base === 'second') return { centre: { ...p }, u: { x: Math.SQRT1_2, y: Math.SQRT1_2 }, v: { x: -Math.SQRT1_2, y: Math.SQRT1_2 } };
  // First and third sit inside the diamond, the back corner on the base itself.
  const toward = base === 'first' ? { x: -Math.SQRT1_2, y: -Math.SQRT1_2 } : { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
  const inward = base === 'first' ? { x: -Math.SQRT1_2, y: Math.SQRT1_2 } : { x: Math.SQRT1_2, y: Math.SQRT1_2 };
  return {
    centre: { x: p.x + (toward.x + inward.x) * s, y: p.y + (toward.y + inward.y) * s },
    u: toward,
    v: inward,
  };
}

/** Home plate: its back point on the origin, the 17-inch front edge facing the pitcher. */
export const PLATE = (() => {
  const { front, side } = FIELD.plate;
  const h = front / 2;
  return [{ x: 0, y: 0 }, { x: h, y: h }, { x: h, y: h + side }, { x: -h, y: h + side }, { x: -h, y: h }];
})();

// ---- Colours --------------------------------------------------------------------

/** '#rrggbb' as [r, g, b, a], 0–1. */
export function rgb(hex, alpha = 1) {
  const n = parseInt(hex.slice(1, 7), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
}

// Mid to dark (a night game), so a light-coloured ball stands out against all of it.
export const COLOURS = {
  skyTop: '#070b1d',
  skyLow: '#26335e',
  grass: '#2c5b31',
  stripe: '#34693a',
  grassDark: '#24502a',
  dirt: '#8a5a3a',
  dirtDark: '#6d4630',
  mound: '#94613f',
  chalk: '#cfcabb',
  base: '#b9b29f',
  baseEdge: '#4a4236',
  wall: '#1d4434',
  wallTop: '#d9a520',
  pad: '#1a3b2e',
  stands: '#2a2d3a',
  standsShade: '#1d2029',
  aisle: '#3a3e4c',
  batterEye: '#122019',
  pole: '#d9a520',
  tower: '#3b3f4a',
  light: '#f1d68a',
  board: '#132619',
  boardFrame: '#2b2f38',
  boardText: '#e8b64a',
  dugout: '#0e1117',
  rail: '#4a4f5c',
  beyond: '#151820',
  crowdSkin: ['#c9946b', '#8d5a3b', '#e0b48f', '#6e4630'],
  crowd: ['#7b3b3b', '#3d5a80', '#7a6a3a', '#4f6b45', '#6a4a7a', '#8a5a3a', '#38424f', '#7d6f62', '#a0663a', '#4a6f86', '#24427a', '#24427a'],
};

// Made-up advertisers along the outfield fence: [panel colour, text].
export const ADS = [
  ['#7a2f2f', 'HOT DOGS $2'], ['#2f5a7a', 'HARBOR BANK'], ['#6b5a2a', 'LAMPLIGHT DINER'], ['#3d6b45', 'GO LAMPS!'],
  ['#5a3d6b', 'BOB’S TIRES'], ['#7a5a2f', 'SUNSET MILK'], ['#2f6b6b', 'PIER 9 PIZZA'], ['#7a2f4f', 'ICE COLD LEMONADE'],
  ['#2f4f7a', 'HIT IT HERE!'], ['#6b4a2a', 'DOCKSIDE HARDWARE'],
];

/**
 * What each piece of the ballpark is made of, for the shader: lit solids,
 * things that glow (the lamps), flat paint, and the ground's patterns.
 */
export const MATERIAL = { lit: 0, glow: 1, flat: 2, grass: 3, infieldGrass: 4, dirt: 5, sign: 6 };

// ---- Meshes -----------------------------------------------------------------------

/** Floats for each vertex: position (3), normal (3), colour (4), texture position (2), material and animation (2). */
export const STRIDE = 14;

/** Triangles, built up a few at a time, every vertex with all of STRIDE. */
export class Mesh {
  constructor() {
    this.data = [];
  }

  get count() {
    return this.data.length / STRIDE;
  }

  vertex(p, n, colour, uv = [0, 0], material = MATERIAL.lit, anim = 0) {
    this.data.push(p.x, p.y, p.z ?? 0, n.x, n.y, n.z, colour[0], colour[1], colour[2], colour[3] ?? 1, uv[0], uv[1], material, anim);
  }

  /** A flat polygon (convex or not) of points on one plane, facing `normal`. */
  polygon(points, normal, colour, material = MATERIAL.lit, uvs = null) {
    for (const [i, j, k] of triangulate(points, normal)) {
      for (const v of [i, j, k]) this.vertex(points[v], normal, colour, uvs ? uvs[v] : [0, 0], material);
    }
  }

  /** A flat four-sided piece a, b, c, d (anticlockwise seen from the front), with texture corners. */
  quad(a, b, c, d, colour, material = MATERIAL.lit, uv = [[0, 1], [1, 1], [1, 0], [0, 0]], anim = 0) {
    const n = normalOf(a, b, c);
    for (const [p, t] of [[a, uv[0]], [b, uv[1]], [c, uv[2]], [a, uv[0]], [c, uv[2]], [d, uv[3]]]) this.vertex(p, n, colour, t, material, anim);
  }

  /**
   * A box with its corners at `c ± hx ± hy ± hz` (axes as unit vectors), its
   * bottom left off unless asked, and its back (the -y side) too if `back` is false.
   */
  box(c, axes, half, colour, material = MATERIAL.lit, { bottom = false, back = true, anim = 0 } = {}) {
    const [ax, ay, az] = axes;
    const at = (i, j, k) => add3(c, scale3(ax, i * half[0]), scale3(ay, j * half[1]), scale3(az, k * half[2]));
    const faces = [
      [at(-1, -1, 1), at(1, -1, 1), at(1, 1, 1), at(-1, 1, 1)],
      [at(-1, -1, -1), at(1, -1, -1), at(1, -1, 1), at(-1, -1, 1)],
      [at(1, 1, -1), at(-1, 1, -1), at(-1, 1, 1), at(1, 1, 1)],
      [at(-1, 1, -1), at(-1, -1, -1), at(-1, -1, 1), at(-1, 1, 1)],
      [at(1, -1, -1), at(1, 1, -1), at(1, 1, 1), at(1, -1, 1)],
    ];
    if (!back) faces.splice(1, 1);
    if (bottom) faces.push([at(-1, 1, -1), at(1, 1, -1), at(1, -1, -1), at(-1, -1, -1)]);
    for (const [a, b, cc, d] of faces) this.quad(a, b, cc, d, colour, material, undefined, anim);
  }

  /** An upright cylinder (a pole), from `z0` to `z1`. */
  pole(at, r, z0, z1, colour, sides = 10) {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * TAU;
      const a1 = ((i + 1) / sides) * TAU;
      const p = (a, z) => ({ x: at.x + Math.cos(a) * r, y: at.y + Math.sin(a) * r, z });
      const n0 = { x: Math.cos(a0), y: Math.sin(a0), z: 0 };
      const n1 = { x: Math.cos(a1), y: Math.sin(a1), z: 0 };
      const verts = [[p(a0, z0), n0], [p(a1, z0), n1], [p(a1, z1), n1], [p(a0, z0), n0], [p(a1, z1), n1], [p(a0, z1), n0]];
      for (const [v, n] of verts) this.vertex(v, n, colour);
    }
  }

  toArray() {
    return new Float32Array(this.data);
  }
}

function add3(...vs) {
  return vs.reduce((s, v) => ({ x: s.x + v.x, y: s.y + v.y, z: (s.z ?? 0) + (v.z ?? 0) }), { x: 0, y: 0, z: 0 });
}

function scale3(v, k) {
  return { x: v.x * k, y: v.y * k, z: (v.z ?? 0) * k };
}

function sub3(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
}

function cross3(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function dot3(a, b) {
  return a.x * b.x + a.y * b.y + (a.z ?? 0) * (b.z ?? 0);
}

function unit3(v) {
  const d = Math.hypot(v.x, v.y, v.z ?? 0) || 1;
  return { x: v.x / d, y: v.y / d, z: (v.z ?? 0) / d };
}

function normalOf(a, b, c) {
  return unit3(cross3(sub3(b, a), sub3(c, a)));
}

/**
 * Splits a simple polygon into triangles (ear clipping), seen from the side
 * `normal` points to (z up by default). Returns index triples, each anticlockwise from that side.
 * @param {{x:number, y:number, z?:number}[]} points
 * @returns {number[][]}
 */
export function triangulate(points, normal = { x: 0, y: 0, z: 1 }) {
  // Flatten onto the polygon's plane.
  const n = unit3(normal);
  const helper = Math.abs(n.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const u = unit3(cross3(helper, n));
  const v = cross3(n, u);
  const flat = points.map((p) => ({ x: dot3(p, u), y: dot3(p, v) }));
  let area = 0;
  for (let i = 0; i < flat.length; i++) {
    const a = flat[i];
    const b = flat[(i + 1) % flat.length];
    area += a.x * b.y - b.x * a.y;
  }
  const left = flat.map((_, i) => i);
  if (area < 0) left.reverse();
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  const out = [];
  let guard = 0;
  while (left.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < left.length; i++) {
      const ia = left[(i + left.length - 1) % left.length];
      const ib = left[i];
      const ic = left[(i + 1) % left.length];
      const a = flat[ia];
      const b = flat[ib];
      const c = flat[ic];
      if (cross(a, b, c) <= 1e-12) continue;
      let ear = true;
      for (const j of left) {
        if (j === ia || j === ib || j === ic) continue;
        const p = flat[j];
        if ((p.x === a.x && p.y === a.y) || (p.x === b.x && p.y === b.y) || (p.x === c.x && p.y === c.y)) continue;
        if (inside(p, a, b, c)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      out.push([ia, ib, ic]);
      left.splice(i, 1);
      clipped = true;
      break;
    }
    // Nothing left that is an ear (a degenerate outline): cut off a corner anyway.
    if (!clipped) out.push([left[0], left[1], left[2]]), left.splice(1, 1);
  }
  if (left.length === 3) out.push([left[0], left[1], left[2]]);
  return out;
}

/** Points round a circle (or an ellipse turned by `angle`) on the ground. */
export function circle(centre, r, steps = 32) {
  return ellipse(centre, r, r, 0, steps);
}

export function ellipse(centre, rx, ry, angle, steps = 32) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * TAU;
    const x = rx * Math.cos(a);
    const y = ry * Math.sin(a);
    return { x: centre.x + x * c - y * s, y: centre.y + x * s + y * c };
  });
}

/** A strip `width` wide on the ground from a to b (a chalk line, a base path). */
export function strip(a, b, width) {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  const n = { x: (-(b.y - a.y) / L) * (width / 2), y: ((b.x - a.x) / L) * (width / 2) };
  return [{ x: a.x - n.x, y: a.y - n.y }, { x: b.x - n.x, y: b.y - n.y }, { x: b.x + n.x, y: b.y + n.y }, { x: a.x + n.x, y: a.y + n.y }];
}

// ---- The ground -------------------------------------------------------------------

const UP = { x: 0, y: 0, z: 1 };

/**
 * The ground, in the order it is painted (each layer over the ones before):
 * the grass with its mowing pattern, the warning track, the infield skin and
 * grass, the cutouts, base paths and circles, then the chalk and home plate.
 * The mound, the bags and the rubber stand up from it (see buildSolids).
 */
export function buildGround() {
  const mesh = new Mesh();
  const lay = (points, colour, material = MATERIAL.flat) => mesh.polygon(points.map((p) => ({ x: p.x, y: p.y, z: 0 })), UP, rgb(colour), material);

  lay(circle({ x: 0, y: 150 }, 1600, 48), COLOURS.beyond);
  lay(PARK, COLOURS.grass, MATERIAL.grass);
  // The warning track along the fence.
  const inner = FENCE_POINTS.map((p) => {
    const d = Math.hypot(p.x, p.y);
    return { x: p.x * (1 - FENCE.track / d), y: p.y * (1 - FENCE.track / d) };
  });
  for (let i = 0; i + 1 < FENCE_POINTS.length; i++) {
    lay([FENCE_POINTS[i], FENCE_POINTS[i + 1], inner[i + 1], inner[i]], COLOURS.dirtDark, MATERIAL.dirt);
  }
  // The bullpen out by the left-field line, and its mound.
  lay(ellipse(BULLPEN, 16, 10, 0.8), COLOURS.dirtDark, MATERIAL.dirt);
  lay(circle({ x: BULLPEN.x + 3, y: BULLPEN.y + 2 }, 4), COLOURS.mound, MATERIAL.dirt);

  // The infield skin: out to the arc, then the darker lip of grass round it.
  const arc = infieldArc(FIELD.arc);
  lay(arcPolygon(infieldArc(FIELD.arc + 2)), COLOURS.grassDark, MATERIAL.grass);
  lay(arcPolygon(arc), COLOURS.dirt, MATERIAL.dirt);
  // The infield grass: a square, the base paths' width inside the lines.
  const k = FIELD.basePath * Math.SQRT2;
  lay([{ x: 0, y: k }, { x: D - k, y: D }, { x: 0, y: 2 * D - k }, { x: -(D - k), y: D }], COLOURS.grass, MATERIAL.infieldGrass);
  // The dirt along the lines from home to first and third, and the cutouts.
  for (const base of ['first', 'third']) {
    lay(strip(BASES.home, BASES[base], FIELD.basePath * 2), COLOURS.dirt, MATERIAL.dirt);
    lay(circle(BASES[base], FIELD.cutout), COLOURS.dirt, MATERIAL.dirt);
  }
  lay(circle({ x: 0, y: 0.7 }, FIELD.cutout), COLOURS.dirt, MATERIAL.dirt);
  lay(circle(MOUND_CENTRE, FIELD.mound.radius + 0.4), COLOURS.mound, MATERIAL.dirt);
  for (const c of FIELD.onDeck.at) {
    lay(circle(c, FIELD.onDeck.r), COLOURS.chalk);
    lay(circle(c, FIELD.onDeck.r - FIELD.line), COLOURS.dirtDark, MATERIAL.dirt);
  }

  for (const p of chalkLines()) lay(p, COLOURS.chalk);
  lay(PLATE.map((p) => ({ x: p.x * 1.12, y: (p.y - 0.7) * 1.12 + 0.7 })), COLOURS.baseEdge);
  lay(PLATE, COLOURS.base);
  return mesh;
}

/** The edge of the infield dirt: an arc round the front of the rubber, between the foul lines. */
function infieldArc(r) {
  const cy = FIELD.rubber.front;
  // Where the arc meets the foul lines (y = |x|): x² + (x - cy)² = r².
  const meetX = (cy + Math.sqrt(2 * r * r - cy * cy)) / 2;
  const meet = Math.atan2(meetX, meetX - cy);
  const points = [];
  for (let a = -meet; a <= meet + 1e-9; a += meet / 24) points.push({ x: r * Math.sin(a), y: cy + r * Math.cos(a) });
  return points;
}

/** The arc closed back down the lines to home. */
function arcPolygon(arc) {
  return [...arc, { x: FIELD.basePath, y: 0 }, { x: -FIELD.basePath, y: 0 }];
}

/**
 * Every chalk line, as strips on the ground: the foul lines out to the poles,
 * the batter's boxes, the catcher's box, the running lane up the first-base
 * line, and the coaches' boxes.
 */
export function chalkLines() {
  const w = FIELD.line;
  const lines = [];
  const far = FENCE.line / Math.SQRT2;
  const { width, length, gap } = FIELD.box;
  const plateHalf = FIELD.plate.front / 2;
  const mid = PLATE[2].y / 2; // the boxes are centred on the middle of the plate
  const x0 = plateHalf + gap;
  const x1 = x0 + width;
  const y0 = mid - length / 2;
  const y1 = mid + length / 2;
  for (const side of [1, -1]) {
    // A foul line starts where it leaves the batter's box.
    lines.push(strip({ x: side * x1, y: x1 }, { x: side * far, y: far }, w));
    lines.push(...rectangle({ x: side * x0, y: y0 }, { x: side * x1, y: y1 }, w));
    // The coach's box: a line 15 feet off the foul line, with one at each end going away from the field.
    const along = { x: side * Math.SQRT1_2, y: Math.SQRT1_2 };
    const out = { x: side * Math.SQRT1_2, y: -Math.SQRT1_2 };
    const at = (s, o) => ({ x: along.x * s + out.x * o, y: along.y * s + out.y * o });
    const { off, along: [s0, s1], depth } = FIELD.coachBox;
    lines.push(strip(at(s0, off), at(s1, off), w), strip(at(s0, off), at(s0, off + depth), w), strip(at(s1, off), at(s1, off + depth), w));
  }
  const { width: cw, length: cl } = FIELD.catcherBox;
  lines.push(strip({ x: -cw / 2, y: y0 }, { x: -cw / 2, y: y0 - cl }, w), strip({ x: cw / 2, y: y0 }, { x: cw / 2, y: y0 - cl }, w),
    strip({ x: -cw / 2, y: y0 - cl }, { x: cw / 2, y: y0 - cl }, w));
  // The running lane: 3 feet outside the first-base line, for the last half of the way to first.
  const u = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
  const o = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
  const { from, width: lane } = FIELD.runningLane;
  const p = (s, d) => ({ x: u.x * s + o.x * d, y: u.y * s + o.y * d });
  lines.push(strip(p(from, lane), p(90, lane), w), strip(p(from, 0), p(from, lane), w));
  return lines;
}

function rectangle(a, b, w) {
  const c = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
  return c.map((p, i) => strip(p, c[(i + 1) % 4], w));
}

// ---- The ballpark's solid parts ------------------------------------------------------

/** A stretch of wall and the stands behind it, from one point of PARK to the next. */
export const STRETCHES = PARK.map((a, index) => {
  const b = PARK[(index + 1) % PARK.length];
  const kind = a.kind === 'outfield' && b.kind === 'outfield' ? 'outfield' : 'foul';
  const wallA = a.wall;
  const wallB = kind === 'outfield' ? b.wall : FIELD.foulWall;
  const eye = kind === 'outfield' && Math.abs(a.deg) <= 10 && Math.abs(b.deg) <= 10;
  const dugout = kind === 'foul' && Math.abs(a.x) > 60 && Math.abs(b.x) > 60 && Math.abs(a.x) < 150 && Math.abs(b.x) < 150
    ? (a.x + b.x > 0 ? 'home' : 'away') : null;
  return { a, b, index, kind, wallA, wallB, na: outwards(a), nb: outwards(b), batterEye: eye, dugout, ad: kind === 'outfield' ? index % ADS.length : null };
});

/**
 * The parts of the ballpark that stand up: the mound, the bags and the
 * rubber, the walls and their padding, the stands in steps, the batter's eye,
 * the foul poles, the dugouts, the light towers (their lamps glow) and the
 * scoreboards' frames.
 */
export function buildSolids() {
  const mesh = new Mesh();
  buildMound(mesh);
  for (const base of ['first', 'second', 'third']) {
    const { centre, u, v } = bagOf(base);
    const h = FIELD.bagHeight / 2;
    mesh.box({ ...centre, z: h }, [{ ...u, z: 0 }, { ...v, z: 0 }, UP], [FIELD.bag / 2, FIELD.bag / 2, h], rgb(COLOURS.base));
  }
  const { width, depth, front } = FIELD.rubber;
  const top = groundHeight(0, front);
  mesh.box({ x: 0, y: front + depth / 2, z: top }, [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, UP], [width / 2, depth / 2, 0.06], rgb(COLOURS.chalk));

  for (const s of STRETCHES) buildStretch(mesh, s);
  for (const p of FENCE_POINTS) {
    if (Math.abs(Math.abs(p.deg) - 45) > 0.1) continue;
    // A foul pole, with its screen on the fair side.
    mesh.pole(p, 0.6, 0, FIELD.pole, rgb(COLOURS.pole));
    const toward = Math.sign(-p.x);
    mesh.box({ x: p.x + toward * 1.6, y: p.y, z: FIELD.pole * 0.62 }, [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, UP], [1.2, 0.08, FIELD.pole * 0.36], rgb(COLOURS.pole, 1));
  }
  for (const t of TOWERS) buildTower(mesh, t);
  for (const board of BOARDS) buildBoardFrame(mesh, board);
  return mesh;
}

function buildMound(mesh) {
  const { centre, radius } = FIELD.mound;
  const rings = 8;
  const sides = 36;
  const colour = rgb(COLOURS.mound);
  const at = (i, j) => {
    const r = (radius * i) / rings;
    const a = (j / sides) * TAU;
    const x = r * Math.cos(a);
    const y = centre + r * Math.sin(a);
    return { x, y, z: groundHeight(x, y) };
  };
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < sides; j++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      const n = normalOf(a, b, c);
      const up = n.z < 0 ? scale3(n, -1) : n;
      for (const p of [a, b, c, a, c, d]) mesh.vertex(p, up, colour, [0, 0], MATERIAL.dirt);
    }
  }
}

/** One stretch: the wall (padded, with a yellow line along its top), then rows of seats rising behind it. */
function buildStretch(mesh, s) {
  const { a, b, na, nb, wallA, wallB } = s;
  const { depth, rise, rows } = STANDS;
  const wallColour = rgb(s.kind === 'outfield' ? COLOURS.pad : COLOURS.wall);
  mesh.quad({ ...b, z: 0 }, { ...a, z: 0 }, { ...a, z: wallA - 0.5 }, { ...b, z: wallB - 0.5 }, wallColour);
  mesh.quad({ ...b, z: wallB - 0.5 }, { ...a, z: wallA - 0.5 }, { ...a, z: wallA }, { ...b, z: wallB }, rgb(COLOURS.wallTop));
  const step = (p, n, wall, v, z) => ({ x: p.x + n.x * depth * v, y: p.y + n.y * depth * v, z: wall + z });
  const colour = s.batterEye ? rgb(COLOURS.batterEye) : rgb(s.index % 2 ? COLOURS.stands : COLOURS.standsShade);
  const riser = s.batterEye ? colour : rgb(COLOURS.aisle);
  for (let row = 0; row < rows; row++) {
    const v0 = row / rows;
    const v1 = (row + 1) / rows;
    const z0 = (rise * row) / rows;
    const z1 = (rise * (row + 1)) / rows;
    // The riser up to this row, then the row's floor.
    mesh.quad(step(b, nb, wallB, v0, z0), step(a, na, wallA, v0, z0), step(a, na, wallA, v0, z1), step(b, nb, wallB, v0, z1), riser);
    mesh.quad(step(b, nb, wallB, v0, z1), step(a, na, wallA, v0, z1), step(a, na, wallA, v1, z1), step(b, nb, wallB, v1, z1), colour);
  }
  // A wall along the back, a little above the top row.
  mesh.quad(step(b, nb, wallB, 1, rise), step(a, na, wallA, 1, rise), step(a, na, wallA, 1, rise + 7), step(b, nb, wallB, 1, rise + 7), rgb(COLOURS.standsShade));
  if (s.dugout) buildDugout(mesh, s);
}

/** A dugout in the wall: a dark opening under a roof in the team's colours, with a railing along the front. */
function buildDugout(mesh, s) {
  const { a, b } = s;
  const team = TEAMS[s.dugout];
  const n = scale3(outwards({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), -0.08);
  const at = (t, z, inset = 0) => ({ x: a.x + (b.x - a.x) * t + n.x * (1 + inset), y: a.y + (b.y - a.y) * t + n.y * (1 + inset), z });
  mesh.quad(at(0.8, 0), at(0.2, 0), at(0.2, 3.3), at(0.8, 3.3), rgb(COLOURS.dugout));
  mesh.quad(at(0.82, 3.3, 1), at(0.18, 3.3, 1), at(0.18, 4.4, 1), at(0.82, 4.4, 1), rgb(team.jersey));
  mesh.quad(at(0.82, 3.3, 2), at(0.18, 3.3, 2), at(0.18, 3.5, 2), at(0.82, 3.5, 2), rgb(team.trim));
  for (let t = 0.22; t < 0.8; t += 0.06) mesh.pole(at(t, 0, 14), 0.06, 0, 2.6, rgb(COLOURS.rail), 6);
  const r0 = at(0.2, 2.6, 14);
  const r1 = at(0.8, 2.6, 14);
  mesh.quad({ ...r1, z: 2.5 }, { ...r0, z: 2.5 }, { ...r0, z: 2.7 }, { ...r1, z: 2.7 }, rgb(COLOURS.rail));
}

/** A light tower: a pole, and a bank of lamps on top facing the field. */
function buildTower(mesh, t) {
  mesh.pole(t, 1.6, 0, TOWER_HEIGHT, rgb(COLOURS.tower), 8);
  const toward = unit3({ x: PARK_CENTRE.x - t.x, y: PARK_CENTRE.y - t.y, z: 0 });
  const across = { x: -toward.y, y: toward.x, z: 0 };
  const tilt = unit3({ x: toward.x * 0.35, y: toward.y * 0.35, z: 1 });
  const back = unit3(cross3(across, tilt));
  const centre = { x: t.x, y: t.y, z: TOWER_HEIGHT + 8 };
  mesh.box(centre, [across, back, tilt], [14, 1.5, 8], rgb(COLOURS.tower), MATERIAL.lit, { bottom: true });
  // The lamps: two rows of four on the face towards the field.
  const face = sub3(centre, scale3(back, 1.6));
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      const c = add3(face, scale3(across, -10.5 + col * 7), scale3(tilt, 3.5 - row * 7));
      const p = (i, j) => add3(c, scale3(across, i * 2.6), scale3(tilt, j * 2.6));
      mesh.quad(p(1, -1), p(-1, -1), p(-1, 1), p(1, 1), rgb(COLOURS.light), MATERIAL.glow);
    }
  }
}

/** Where on a scoreboard's face its picture goes: corners top left, top right, bottom left. */
export function boardFace({ centre, along, w, h, z0 }) {
  const at = (u, z) => ({ x: centre.x + along.x * u, y: centre.y + along.y * u, z });
  return [at(-w / 2, z0 + h), at(w / 2, z0 + h), at(-w / 2, z0)];
}

function buildBoardFrame(mesh, board) {
  const { centre, along, w, h, z0 } = board;
  const toward = unit3({ x: PARK_CENTRE.x - centre.x, y: PARK_CENTRE.y - centre.y, z: 0 });
  const ax = { ...along, z: 0 };
  const frame = rgb(COLOURS.boardFrame);
  mesh.box({ x: centre.x - toward.x * 1.5, y: centre.y - toward.y * 1.5, z: z0 + h / 2 }, [ax, toward, UP], [w / 2 + 2, 1.4, h / 2 + 2], frame, MATERIAL.lit, { bottom: true });
  for (const u of [-w * 0.35, w * 0.35]) {
    mesh.box({ x: centre.x + along.x * u - toward.x * 1.5, y: centre.y + along.y * u - toward.y * 1.5, z: z0 / 2 }, [ax, toward, UP], [2, 1.2, z0 / 2], frame);
  }
}

/**
 * The signs, each a picture on a flat panel: the ads along the outfield
 * fence, the distances on it, the team names over the dugouts. `slot` says
 * which picture (see the art's sign sheet).
 * @returns {{corners: Point3[], slot: {kind: string, index?: number, text?: string}}[]}
 */
export function signPanels() {
  const panels = [];
  for (const s of STRETCHES) {
    const { a, b } = s;
    const n = scale3(outwards({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), -0.06);
    const at = (t, z) => ({ x: a.x + (b.x - a.x) * t + n.x, y: a.y + (b.y - a.y) * t + n.y, z });
    if (s.ad !== null && !s.batterEye) panels.push({ corners: [at(0.04, 7.6), at(0.96, 7.6), at(0.04, 1.2)], slot: { kind: 'ad', index: s.ad } });
    if (s.dugout) {
      const m = scale3(n, 3);
      const at2 = (t, z) => ({ x: a.x + (b.x - a.x) * t + m.x, y: a.y + (b.y - a.y) * t + m.y, z });
      panels.push({ corners: [at2(0.18, 4.4), at2(0.82, 4.4), at2(0.18, 3.5)], slot: { kind: 'dugout', text: s.dugout } });
    }
  }
  // The distances, painted big on the wall: down the lines, in the alleys, and to centre.
  for (const deg of [-45, -22.5, 0, 22.5, 45]) {
    const r = fenceDistance(deg) - 0.12;
    const a = (deg * Math.PI) / 180;
    const c = { x: r * Math.sin(a), y: r * Math.cos(a) };
    const across = { x: Math.cos(a), y: -Math.sin(a) };
    const half = 6;
    const inset = deg === 0 ? 0 : -Math.sign(deg) * 7; // clear of the foul poles
    const m = { x: c.x + across.x * inset, y: c.y + across.y * inset };
    panels.push({
      corners: [{ x: m.x - across.x * half, y: m.y - across.y * half, z: 8.2 }, { x: m.x + across.x * half, y: m.y + across.y * half, z: 8.2 },
        { x: m.x - across.x * half, y: m.y - across.y * half, z: 4.2 }],
      slot: { kind: 'distance', text: String(Math.round(fenceDistance(deg))) },
    });
  }
  return panels;
}

/**
 * The crowd: rows of people in the stands, the same ones every time, with a
 * few empty seats. Each sits facing the field; `hash` picks their clothes and
 * how they react.
 * @returns {{x:number, y:number, z:number, facing: Point, stretch: number, shirt: string, skin: string, hash: number}[]}
 */
export function crowdSeats() {
  const people = [];
  const { depth, rise, rows } = STANDS;
  const seat = 2.8;
  for (const s of STRETCHES) {
    if (s.batterEye) continue;
    const { a, b, na, nb, wallA, wallB, index } = s;
    const seats = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / seat));
    for (let row = 0; row < rows; row++) {
      const v = (row + 0.55) / rows;
      for (let k = 0; k < seats; k++) {
        const hash = ((index * 7919 + row * 104729 + k * 1299709) >>> 0) % 997;
        if (hash % 5 === 0) continue;
        const u = (k + (row % 2 ? 0.25 : 0.75)) / seats;
        const n = { x: na.x + (nb.x - na.x) * u, y: na.y + (nb.y - na.y) * u };
        people.push({
          x: a.x + (b.x - a.x) * u + n.x * depth * v,
          y: a.y + (b.y - a.y) * u + n.y * depth * v,
          z: wallA + (wallB - wallA) * u + (rise * (row + 1)) / rows,
          facing: { x: -n.x, y: -n.y },
          stretch: index,
          shirt: COLOURS.crowd[hash % COLOURS.crowd.length],
          skin: COLOURS.crowdSkin[(hash >> 3) % COLOURS.crowdSkin.length],
          hash,
        });
      }
    }
  }
  return people;
}

/**
 * The crowd as boxes: a body and a head each, and two arms. The animation
 * value says what moves when they react: 1 + hash/1000 for a body or head (it
 * bobs), 2 + hash/1000 for an arm (it goes up in a cheer, for some). Each
 * stretch of stands is a part of the mesh of its own (`parts`: its first
 * vertex, how many, and the box it fits in, a little bigger for a jump), so
 * the stands out of sight needn't be drawn.
 */
export function buildCrowd() {
  const mesh = new Mesh();
  mesh.parts = [];
  let part = null;
  for (const p of crowdSeats()) {
    if (!part || part.stretch !== p.stretch) {
      if (part) part.count = mesh.count - part.first;
      part = { stretch: p.stretch, first: mesh.count, count: 0, min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
      mesh.parts.push(part);
    }
    for (const k of ['x', 'y', 'z']) {
      part.min[k] = Math.min(part.min[k], p[k] - 2);
      part.max[k] = Math.max(part.max[k], p[k] + (k === 'z' ? 6 : 2));
    }
    const f = { x: p.facing.x, y: p.facing.y, z: 0 };
    const r = { x: f.y, y: -f.x, z: 0 };
    const axes = [r, f, UP];
    const body = rgb(p.shirt);
    const skin = rgb(p.skin);
    const bob = 1 + p.hash / 1000;
    // Only from the front: nobody sees their backs.
    mesh.box({ x: p.x, y: p.y, z: p.z + 1.1 }, axes, [0.75, 0.45, 1.1], body, MATERIAL.lit, { anim: bob, back: false });
    mesh.box({ x: p.x + f.x * 0.05, y: p.y + f.y * 0.05, z: p.z + 2.6 }, axes, [0.4, 0.4, 0.42], skin, MATERIAL.lit, { anim: bob, back: false });
    for (const side of [-1, 1]) {
      mesh.box({ x: p.x + r.x * side * 0.92, y: p.y + r.y * side * 0.92, z: p.z + 1.35 }, axes, [0.17, 0.2, 0.75], body, MATERIAL.lit, { anim: 2 + p.hash / 1000, back: false });
    }
  }
  if (part) part.count = mesh.count - part.first;
  return mesh;
}

/**
 * Whether any of a box (on the field, corners `min` and `max`) can be in a
 * picture, given the view and projection matrices: false only when it is
 * all off one side.
 */
export function boxInView(view, proj, min, max) {
  const out = [0, 0, 0, 0, 0];
  for (let i = 0; i < 8; i++) {
    const p = { x: i & 1 ? max.x : min.x, y: i & 2 ? max.y : min.y, z: i & 4 ? max.z : min.z };
    const [x, y, z] = transform(view, p);
    const [cx, cy, , cw] = transform(proj, { x, y, z });
    if (cx < -cw) out[0]++;
    if (cx > cw) out[1]++;
    if (cy < -cw) out[2]++;
    if (cy > cw) out[3]++;
    if (cw <= 0) out[4]++;
  }
  return out.every((n) => n < 8);
}

// ---- The camera --------------------------------------------------------------------

/** The axes a view looks along: right, up and ahead (unit vectors), as in makeCamera. */
export function viewAxes(view) {
  const { yaw, pitch } = view;
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  return {
    right: { x: cy, y: -sy, z: 0 },
    up: { x: -sp * sy, y: -sp * cy, z: cp },
    ahead: { x: sy * cp, y: cy * cp, z: sp },
  };
}

/**
 * The matrix (column-major, for WebGL) from the field to a view's camera:
 * x right, y up, z ahead, in feet from `origin` (the eye, unless given).
 */
export function viewMatrix(view, origin = view.eye) {
  const { right: r, up: u, ahead: a } = viewAxes(view);
  const e = { x: origin.x, y: origin.y, z: origin.z ?? 0 };
  return new Float32Array([
    r.x, u.x, a.x, 0,
    r.y, u.y, a.y, 0,
    r.z, u.z, a.z, 0,
    -dot3(r, e), -dot3(u, e), -dot3(a, e), 1,
  ]);
}

/**
 * The perspective that puts a point where makeCamera's `project` does, for a
 * screen `aspect` wide for each unit high: nothing nearer than `near` feet
 * or further than `far` is drawn.
 */
export function projectionMatrix(view, aspect, near = 1, far = 4000) {
  const { f, centreY } = view;
  return new Float32Array([
    (2 * f) / aspect, 0, 0, 0,
    0, 2 * f, 0, 0,
    0, 1 - 2 * centreY, (far + near) / (far - near), 1,
    0, 0, (-2 * far * near) / (far - near), 0,
  ]);
}

/**
 * A flat (orthographic) picture for drawing one player on their own: looking
 * the way `view` does, `px` pixels to a foot, with the point the camera is
 * centred on (see viewMatrix's origin) at (ax, ay) pixels on a w × h picture.
 */
export function spriteMatrix(px, w, h, ax, ay) {
  return new Float32Array([
    (2 * px) / w, 0, 0, 0,
    0, (2 * px) / h, 0, 0,
    0, 0, 1 / 40, 0,
    (2 * ax) / w - 1, 1 - (2 * ay) / h, 0, 1,
  ]);
}

/** A matrix (column-major) times a point: [x, y, z, w]. */
export function transform(m, p) {
  const x = p.x;
  const y = p.y;
  const z = p.z ?? 0;
  return [0, 1, 2, 3].map((i) => m[i] * x + m[4 + i] * y + m[8 + i] * z + m[12 + i]);
}

// ---- The players ---------------------------------------------------------------------

/**
 * A figure's own directions on the field, from the way they face (on the
 * ground): forward, their right, and up.
 */
export function figureFrame(facing) {
  const d = Math.hypot(facing.x, facing.y) || 1;
  const forward = { x: facing.x / d, y: facing.y / d, z: 0 };
  return { forward, right: { x: forward.y, y: -forward.x, z: 0 }, up: UP };
}

/** A point in a figure's own terms (feet: to their right, up, forward) on the field. */
export function figurePoint(at, frame, j) {
  return {
    x: at.x + frame.right.x * j.r + frame.forward.x * j.f,
    y: at.y + frame.right.y * j.r + frame.forward.y * j.f,
    z: (at.z ?? 0) + j.u,
  };
}

// How far to either side of the middle each joint is in a side-on pose.
const SIDE_WIDTH = { hip: 0.36, knee: 0.38, foot: 0.4, shoulder: 0.62, elbow: 0.72, hand: 0.55 };

/**
 * A pose (drawn flat, from the front or the side) stood up in three
 * dimensions: each joint as feet to the figure's right (`r`), up (`u`) and
 * forward (`f`). From the front, the drawing gives right and up, and how far
 * forward a knee, elbow or hand is comes from how short its bone looks; from
 * the side, the drawing gives forward and up, and the sides are a body's
 * width apart. The pose's turn and lift are included.
 * @param {import('./fielders-choice-players.js').Pose} pose
 * @returns {Record<string, {r:number, u:number, f:number}>} the joints, and the shoulders and hips (lShoulder, rHip, …)
 */
export function liftPose(pose) {
  const J = (name) => placed(pose, pose[name]);
  const hip = J('hip');
  const neck = J('neck');
  const s = unit2({ x: neck.x - hip.x, y: neck.y - hip.y });
  const across = { x: s.y, y: -s.x };
  const out = {};
  if (pose.view === 'side') {
    const w = SIDE_WIDTH;
    const bat = !!pose.batTip;
    const at = (p, r) => ({ r, u: p.y, f: p.x });
    const shoulder = { x: neck.x - s.x * 0.18, y: neck.y - s.y * 0.18 };
    for (const [side, k] of [['l', -1], ['r', 1]]) {
      out[`${side}Shoulder`] = at(shoulder, k * w.shoulder);
      out[`${side}Hip`] = at(hip, k * w.hip);
      out[`${side}Elbow`] = at(J(`${side}Elbow`), k * w.elbow);
      out[`${side}Hand`] = at(J(`${side}Hand`), k * (bat ? 0.12 : w.hand));
      out[`${side}Knee`] = at(J(`${side}Knee`), k * w.knee);
      out[`${side}Foot`] = at(J(`${side}Foot`), k * w.foot);
    }
    out.hip = at(hip, 0);
    out.neck = at(neck, 0);
    out.head = at(J('head'), 0);
    if (bat) {
      // The bat goes round the batter: up over the back shoulder, out over the plate, then round to the far side.
      const tip = placed(pose, pose.batTip);
      const r = 0.7 * clamp((tip.y - 4) / 2.5, 0, 1) - 1.3 * clamp(-tip.x / 1.6, 0, 1) * clamp(6 - tip.y, 0, 1);
      out.batTip = at(tip, r);
    }
    return out;
  }
  // From the front: the drawing's right is the figure's left.
  const at = (p, f) => ({ r: -p.x, u: p.y, f });
  const lean = pose.turn ? 0 : clamp((2.85 - hip.y) * 0.5, 0, 0.6);
  out.hip = at(hip, 0);
  out.neck = at(neck, lean);
  out.head = at(J('head'), lean + 0.12);
  const depth = (a, b, length) => Math.sqrt(Math.max(0, length * length - (a.x - b.x) ** 2 - (a.y - b.y) ** 2));
  for (const [side, k] of [['l', -1], ['r', 1]]) {
    const shoulder = { x: neck.x + across.x * BODY.shoulderHalf * k - s.x * 0.18, y: neck.y + across.y * BODY.shoulderHalf * k - s.y * 0.18 };
    const hipJ = { x: hip.x + across.x * 0.42 * k, y: hip.y + across.y * 0.42 * k };
    const elbow = J(`${side}Elbow`);
    const hand = J(`${side}Hand`);
    const knee = J(`${side}Knee`);
    const elbowF = lean + 0.35 * depth(shoulder, elbow, BODY.upperArm);
    out[`${side}Shoulder`] = at(shoulder, lean);
    out[`${side}Hip`] = at(hipJ, 0);
    out[`${side}Elbow`] = at(elbow, elbowF);
    out[`${side}Hand`] = at(hand, elbowF + depth(elbow, hand, BODY.forearm));
    out[`${side}Knee`] = at(knee, Math.min(1.1, 0.8 * depth(hipJ, knee, BODY.thigh)));
    out[`${side}Foot`] = at(J(`${side}Foot`), 0);
  }
  if (pose.batTip) out.batTip = at(placed(pose, pose.batTip), 0.5);
  return out;
}

function unit2(v) {
  const d = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / d, y: v.y / d };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

const OUTLINE = rgb('#15151c');
const LEATHER = rgb('#8a5226');
const LEATHER_SHADE = rgb('#6a3b18');
const LEATHER_DARK = rgb('#4e2b10');
const CLEAT = rgb('#1b1c22');
const EYE = rgb('#ece5d3');
const BALL = rgb('#e4dfd2');
const BAT = rgb('#b88b52');
const MOUTH = rgb('#5a1f1f');

/** Which picture in the glyph sheet (see fielders-choice-gl.js) a letter or digit is. */
export const GLYPHS = '0123456789LR';

/**
 * @typedef {object} Shape one solid piece of a player, for the renderer
 * @property {'sphere'|'dome'|'cyl'|'box'|'quad'} mesh the unit shape it is made from
 * @property {Float32Array|number[]} m column-major matrix from the unit shape to the field
 * @property {number[]} colour
 * @property {number} [taper] a cylinder's far end, as a fraction of its near end
 * @property {number} [glyph] for a quad: the letter or digit painted on it
 * @property {boolean} [outline] a dark outline round it (default true)
 * @property {boolean} [shadow] a soft shadow on the ground (a quad)
 */

/** A shape with its unit axes going along ax, ay, az (field vectors, their lengths the sizes) from `c`. */
function shape(mesh, c, ax, ay, az, colour, extra = {}) {
  return { mesh, m: [ax.x, ax.y, ax.z, 0, ay.x, ay.y, ay.z, 0, az.x, az.y, az.z, 0, c.x, c.y, c.z, 1], colour, ...extra };
}

/** Two unit vectors at right angles to `d` (a unit vector), the first as near to `hint` as it can be. */
function across(d, hint) {
  let p = sub3(hint, scale3(d, dot3(hint, d)));
  if (Math.hypot(p.x, p.y, p.z) < 1e-4) p = Math.abs(d.z) < 0.9 ? cross3(d, UP) : cross3(d, { x: 1, y: 0, z: 0 });
  p = unit3(p);
  return [p, cross3(d, p)];
}

function sphere(c, r, colour, extra) {
  return shape('sphere', c, { x: r, y: 0, z: 0 }, { x: 0, y: r, z: 0 }, { x: 0, y: 0, z: r }, colour, extra);
}

function ellipsoid(c, axes, radii, colour, mesh = 'sphere', extra) {
  return shape(mesh, c, scale3(axes[0], radii[0]), scale3(axes[1], radii[1]), scale3(axes[2], radii[2]), colour, extra);
}

/** A tapered round limb from a (radius r1) to b (r2), rounded at both ends. */
function limb(out, a, b, r1, r2, colour, hint = UP) {
  const d = sub3(b, a);
  const L = Math.hypot(d.x, d.y, d.z);
  if (L > 1e-4) {
    const [p, q] = across(scale3(d, 1 / L), hint);
    out.push(shape('cyl', a, scale3(p, r1), scale3(q, r1), d, colour, { taper: r2 / r1 }));
  }
  out.push(sphere(a, r1, colour), sphere(b, r2, colour));
}

/** A short band round a limb (a sleeve stripe, a sock's stirrup), from a to b. */
function band(out, a, b, r, colour) {
  const d = sub3(b, a);
  const L = Math.hypot(d.x, d.y, d.z) || 1;
  const [p, q] = across(scale3(d, 1 / L), UP);
  out.push(shape('cyl', a, scale3(p, r), scale3(q, r), d, colour, { taper: 1, outline: false }));
}

/** A letter or digit painted on a flat square `size` feet high at `c`, facing `n`, upright along `up`. */
function glyph(c, n, up, size, ch, colour) {
  const i = GLYPHS.indexOf(ch);
  if (i < 0) return null;
  const right = unit3(cross3(up, n));
  return shape('quad', c, scale3(right, size * 0.36), scale3(up, size / 2), n, colour, { glyph: i, outline: false });
}

/** A number of one or two digits. */
function number(out, c, n, up, size, value, colour) {
  const text = String(value);
  const right = unit3(cross3(up, n));
  const step = size * 0.6;
  [...text].forEach((ch, i) => {
    const g = glyph(add3(c, scale3(right, (i - (text.length - 1) / 2) * step)), n, up, size, ch, colour);
    if (g) out.push(g);
  });
}

/**
 * Everything a player is made of, posed and placed on the field: a body,
 * arms and legs of tapered limbs in the team's colours, a big round head
 * with a face (eyes, brows, nose, mouth, ears) under a cap, a batting helmet
 * or a mask, numbers front and back, a belt, stirrup socks and cleats, a
 * glove or a bare hand, and a bat if they hold one. A soft shadow goes on the ground.
 * @param {{at: {x:number, y:number, z?:number}, player: import('./fielders-choice-players.js').Player, facing?: Point|null, lookAt?: Point|null}} thing
 * @returns {Shape[]}
 */
export function playerShapes({ at, player, facing, lookAt = null }) {
  const pose = player.pose;
  const team = TEAMS[player.team];
  const skin = rgb(SKIN[(player.skin ?? 0) % SKIN.length]);
  const frame = figureFrame(facing ?? { x: 0, y: -1 });
  const ground = { x: at.x, y: at.y, z: at.z ?? groundHeight(at.x, at.y) };
  const j3 = liftPose(pose);
  const P = (name) => figurePoint(ground, frame, j3[name]);
  const out = [];
  const c = (hex) => rgb(hex);
  const umpire = player.team === 'umpire';

  // A soft shadow on the ground under them (fainter the higher they are).
  const lift = pose.lift ?? 0;
  const fade = Math.max(0.3, 1 - lift / 4);
  const spread = pose.turn ? 2.2 : 1;
  out.push(shape('quad', { x: ground.x, y: ground.y, z: ground.z + 0.03 }, scale3(frame.right, 1.7 * spread), scale3(frame.forward, 1.2), UP,
    [0, 0, 0, 0.38 * fade], { shadow: true, outline: false }));

  // The body: pants, then the jersey widening to the chest, with a belt.
  const hip = P('hip');
  const neck = P('neck');
  const spineV = sub3(neck, hip);
  const len = Math.hypot(spineV.x, spineV.y, spineV.z) || 1;
  const spine = scale3(spineV, 1 / len);
  const [side, front] = across(spine, frame.right);
  const along = (u) => add3(hip, scale3(spine, u));
  const torsoShape = (a, b, w1, d1, taper, colour) => out.push(shape('cyl', a, scale3(side, w1), scale3(front, -d1), sub3(b, a), colour, { taper }));
  torsoShape(along(-0.25), along(0.3), 0.62, 0.42, 0.98, c(team.pants));
  out.push(ellipsoid(along(-0.2), [side, front, spine], [0.62, 0.42, 0.3], c(team.pants)));
  torsoShape(along(0.25), along(len * 0.72), 0.6, 0.4, 1.38, c(team.jersey));
  out.push(ellipsoid(along(len * 0.74), [side, front, spine], [0.84, 0.54, len * 0.34], c(team.jersey)));
  out.push(shape('cyl', along(0.08), scale3(side, 0.635), scale3(front, -0.43), scale3(spine, 0.16), c('#1d1d22'), { taper: 1, outline: false }));
  if (!umpire) {
    // Piping down the front, and the number on the chest and (bigger) the back.
    out.push(shape('box', add3(along(len * 0.45), scale3(front, 0.47)), scale3(side, 0.035), scale3(front, 0.02), scale3(spine, len * 0.4), c(team.trim), { outline: false }));
    if (player.number !== undefined) {
      number(out, add3(along(len * 0.62), scale3(side, -0.42), scale3(front, 0.53)), front, spine, 0.42, player.number, c(team.trim));
      number(out, add3(along(len * 0.55), scale3(front, -0.57)), scale3(front, -1), spine, 0.7, player.number, c(team.trim));
    }
  }

  // Legs: pants to below the knee, then socks with a stirrup stripe, and cleats.
  for (const s of ['l', 'r']) {
    const hipJ = P(`${s}Hip`);
    const knee = P(`${s}Knee`);
    const foot = P(`${s}Foot`);
    const sock = lerp3(knee, foot, 0.42);
    limb(out, hipJ, knee, 0.33, 0.27, c(team.pants), frame.forward);
    limb(out, knee, sock, 0.27, 0.22, c(team.pants), frame.forward);
    limb(out, sock, foot, 0.2, 0.17, c(team.socks), frame.forward);
    band(out, lerp3(knee, foot, 0.55), lerp3(knee, foot, 0.63), 0.215, c(team.trim));
    const toe = frame.forward;
    out.push(ellipsoid(add3(foot, scale3(toe, 0.18), { x: 0, y: 0, z: -0.03 }), [frame.right, toe, UP], [0.2, 0.42, 0.17], CLEAT));
  }

  // Arms: a sleeve, then the undershirt to the hand, with a stripe on the sleeve.
  for (const s of ['l', 'r']) {
    const shoulder = P(`${s}Shoulder`);
    const elbow = P(`${s}Elbow`);
    const hand = P(`${s}Hand`);
    const sleeve = lerp3(shoulder, elbow, 0.55);
    const under = umpire ? c(team.jersey) : c(team.undershirt);
    limb(out, shoulder, sleeve, 0.3, 0.26, c(team.jersey));
    limb(out, sleeve, elbow, 0.22, 0.2, under);
    limb(out, elbow, hand, 0.2, 0.16, under);
    if (!umpire) band(out, lerp3(shoulder, elbow, 0.48), lerp3(shoulder, elbow, 0.56), 0.29, c(team.trim));
    if (player.glove === s) glove(out, hand, unit3(sub3(hand, elbow)), frame.forward, player.holdsBall);
    else out.push(sphere(hand, 0.21, skin));
  }
  if (j3.batTip) {
    const grip = lerp3(P('lHand'), P('rHand'), 0.5);
    const tipRaw = P('batTip');
    const dir = unit3(sub3(tipRaw, grip));
    const knob = sub3(grip, scale3(dir, 0.25));
    limb(out, knob, add3(grip, scale3(dir, 2.55)), 0.07, 0.14, BAT);
  }

  // The head, turned to look at `lookAt` if there is something to look at.
  const head = P('head');
  const hUp = unit3(sub3(head, neck));
  let look = frame.forward;
  if (lookAt) {
    const to = unit3({ x: lookAt.x - head.x, y: lookAt.y - head.y, z: 0 });
    if (dot3(to, frame.forward) > -0.2) look = to;
  }
  const [hRight0] = across(hUp, cross3(look, hUp));
  const hFront = unit3(cross3(hUp, hRight0));
  const hRight = cross3(hFront, hUp);
  headShapes(out, pose, player, team, skin, head, neck, hUp, hFront, hRight);
  return out;
}

function lerp3(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/** A face (eyes, brows, nose, mouth) and ears on a big round head, under a cap or a batting helmet, maybe behind a mask. */
function headShapes(out, pose, player, team, skin, h, neck, U, F, R) {
  const r = BODY.headRadius;
  const at = (x, y, z) => add3(h, scale3(R, x), scale3(U, y), scale3(F, z));
  const skinShade = skin.map((v, i) => (i < 3 ? v * 0.86 : v));
  limb(out, neck, at(0, -0.42, 0), 0.24, 0.24, skin);
  out.push(ellipsoid(h, [R, U, F], [r, r * 1.02, r * 0.96], skin));
  for (const s of [-1, 1]) out.push(ellipsoid(at(s * r * 0.95, -0.05, -0.05), [R, U, F], [0.1, 0.17, 0.13], skinShade));
  out.push(sphere(at(0, -0.15, r * 0.95), 0.11, skinShade, { outline: false }));

  const face = pose.face ?? 'neutral';
  const lookJ = pose.look ?? { x: 0, y: 0 };
  const glance = pose.view === 'front' ? -lookJ.x : 0;
  const tilt = { focus: -0.07, yell: -0.1, oops: 0.09, happy: 0.03, neutral: 0 }[face] ?? 0;
  for (const s of [-1, 1]) {
    const eye = at(s * 0.24, -0.02, r * 0.82);
    out.push(ellipsoid(eye, [R, U, F], [0.11, face === 'yell' ? 0.17 : 0.14, 0.08], EYE, 'sphere', { outline: false }));
    out.push(sphere(add3(eye, scale3(R, glance * 0.04), scale3(U, lookJ.y * 0.04), scale3(F, 0.07)), 0.065, OUTLINE, { outline: false }));
    // A brow: down and in when focused or yelling, up when worried.
    const brow = at(s * 0.24, 0.2 + tilt * 0.5, r * 0.86);
    const slope = unit3(add3(scale3(R, 1), scale3(U, s * tilt * -4)));
    out.push(shape('box', brow, scale3(slope, 0.12), scale3(U, 0.035), scale3(F, 0.04), OUTLINE, { outline: false }));
  }
  const mouth = at(0, -0.36, r * 0.86);
  if (face === 'yell') out.push(ellipsoid(mouth, [R, U, F], [0.13, 0.11, 0.06], MOUTH, 'sphere', { outline: false }));
  else if (face === 'happy') {
    for (const k of [-1, -0.5, 0, 0.5, 1]) out.push(sphere(at(k * 0.14, -0.33 - (1 - k * k) * 0.06, r * 0.87), 0.035, OUTLINE, { outline: false }));
  } else if (face === 'oops') {
    for (const k of [-1, 1]) out.push(shape('box', at(k * 0.07, -0.37 + k * 0.02, r * 0.86), scale3(unit3(add3(R, scale3(U, -k * 0.4))), 0.075), scale3(U, 0.025), scale3(F, 0.03), OUTLINE, { outline: false }));
  } else {
    out.push(shape('box', mouth, scale3(R, 0.12), scale3(U, 0.025), scale3(F, 0.03), OUTLINE, { outline: false }));
  }

  if (player.helmet) {
    out.push(ellipsoid(at(0, 0.12, -0.04), [R, F, U], [r * 1.12, r * 1.12, r * 0.92], rgb(team.cap), 'dome'));
    out.push(ellipsoid(at(-r * 0.93, -0.1, -0.04), [R, U, F], [0.08, 0.28, 0.24], rgb(team.cap)));
    out.push(ellipsoid(at(0, 0.14, r * 0.95), [R, F, U], [r * 0.85, 0.28, 0.05], rgb(team.capShade), 'cyl'));
    if (team.letter) out.push(glyph(at(0, 0.62, r * 0.72), unit3(add3(F, scale3(U, 0.9))), unit3(add3(U, scale3(F, -0.9))), 0.34, team.letter, rgb(team.logo)));
  } else {
    out.push(ellipsoid(at(0, 0.22, 0), [R, F, U], [r * 1.04, r * 1.04, r * 0.76], rgb(team.cap), 'dome'));
    out.push(shape('cyl', at(0, 0.22, r * 0.7), scale3(R, r * 0.95), scale3(F, 0.42), scale3(U, 0.06), rgb(team.capShade), { taper: 1 }));
    if (team.letter) out.push(glyph(at(0, 0.6, r * 0.78), unit3(add3(F, scale3(U, 0.75))), unit3(add3(U, scale3(F, -0.75))), 0.36, team.letter, rgb(team.logo)));
  }
  if (player.mask) {
    const bar = rgb('#30333b');
    for (const y of [0.05, -0.18, -0.4]) out.push(shape('box', at(0, y, r * 1.06), scale3(R, r * 0.7), scale3(U, 0.035), scale3(F, 0.035), bar, { outline: false }));
    out.push(shape('box', at(0, -0.18, r * 1.08), scale3(R, 0.035), scale3(U, 0.32), scale3(F, 0.035), bar, { outline: false }));
  }
}

/**
 * A fielder's glove on the hand at `at`, its fingers pointing `dir`, its
 * pocket turned towards `toward`: a palm, four fingers and a thumb in leather,
 * the web between, and the ball in the pocket if it holds one.
 */
function glove(out, at, dir, toward, holdsBall) {
  const [facing] = across(dir, toward);
  const side = cross3(facing, dir);
  const p = (x, y, z = 0) => add3(at, scale3(side, x), scale3(dir, y), scale3(facing, z));
  out.push(ellipsoid(p(0, 0.12), [side, dir, facing], [0.36, 0.36, 0.16], LEATHER));
  for (const [x, rot] of [[-0.24, 0.18], [-0.08, 0.05], [0.08, -0.05], [0.22, -0.18]]) {
    const base = p(x, 0.3);
    const tip = add3(base, scale3(unit3(add3(dir, scale3(side, -rot))), 0.36));
    limb(out, base, tip, 0.1, 0.09, LEATHER, facing);
  }
  limb(out, p(-0.3, 0), p(-0.44, 0.3), 0.11, 0.1, LEATHER, facing);
  out.push(ellipsoid(p(-0.28, 0.36, 0.02), [side, dir, facing], [0.1, 0.15, 0.05], LEATHER_DARK, 'sphere', { outline: false }));
  out.push(ellipsoid(p(0.02, 0.15, 0.1), [side, dir, facing], [0.22, 0.22, 0.08], LEATHER_SHADE, 'sphere', { outline: false }));
  if (holdsBall) out.push(...baseballShapes(p(0.02, 0.17, 0.2), 0.17, [side, dir, facing]));
}

/** A baseball at `at` (on the field), `r` feet across the middle, plain: for its trail. */
export function ballShape(at, r) {
  return sphere(at, r, BALL);
}

const SEAM = rgb('#b8352c');
const X_AXIS = { x: 1, y: 0, z: 0 };
const Y_AXIS = { x: 0, y: 1, z: 0 };

/** Points along a baseball's seam on a sphere of radius 1 (the usual two-lobed curve). */
export const SEAM_POINTS = (() => {
  const b = 0.4;
  const points = [];
  for (let k = 0; k < 64; k++) {
    const t = (k / 64) * 2 * Math.PI;
    const p = {
      x: (1 - b) * Math.cos(t) + b * Math.cos(3 * t),
      y: (1 - b) * Math.sin(t) - b * Math.sin(3 * t),
      z: 2 * Math.sqrt(b * (1 - b)) * Math.sin(2 * t),
    };
    points.push(unit3(p));
  }
  return points;
})();

/**
 * The three unit vectors a ball's own x, y and z axes point along once it has
 * turned `angle` radians about `axis` (a unit vector).
 */
export function turnAbout(axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [X_AXIS, Y_AXIS, UP].map((v) => add3(scale3(v, c), scale3(cross3(axis, v), s), scale3(axis, dot3(axis, v) * (1 - c))));
}

/**
 * A baseball in 3D: a ball `r` feet across the middle at `at` with its red
 * seam stitched round it as small beads, turned as `turn` (three unit
 * vectors, see turnAbout) says.
 * @returns {Shape[]}
 */
export function baseballShapes(at, r, turn = [X_AXIS, Y_AXIS, UP]) {
  const out = [sphere(at, r, BALL)];
  for (const p of SEAM_POINTS) {
    const dir = add3(scale3(turn[0], p.x), scale3(turn[1], p.y), scale3(turn[2], p.z));
    out.push(sphere(add3(at, scale3(dir, r * 0.985)), r * 0.06, SEAM, { outline: false }));
  }
  return out;
}

/**
 * The player's own glove, big, for the front of the screen: at the origin,
 * its fingers tipped `angle` radians from straight up (to the right, when
 * positive), the pocket towards the viewer (who looks along +y), with the
 * ball in it once `caught`.
 * @returns {Shape[]}
 */
export function bigGloveShapes(angle, caught) {
  const out = [];
  glove(out, { x: 0, y: 0, z: 0 }, { x: Math.sin(angle), y: 0, z: Math.cos(angle) }, { x: 0, y: -1, z: 0 }, caught);
  return out;
}

/** A bat lying on the ground at `at`, pointing `angle` radians across the field. */
export function droppedBat(at, angle) {
  const z = groundHeight(at.x, at.y) + 0.12;
  const out = [];
  const a = { x: at.x, y: at.y, z };
  const b = { x: at.x + Math.cos(angle) * 2.8, y: at.y + Math.sin(angle) * 2.8, z: z + 0.04 };
  limb(out, a, b, 0.07, 0.13, BAT);
  return out;
}

/** Where a joint of a player is on the field (as playerShapes puts it). */
export function jointAt(thing, name) {
  const frame = figureFrame(thing.facing ?? { x: 0, y: -1 });
  const at = thing.at;
  const ground = { x: at.x, y: at.y, z: at.z ?? groundHeight(at.x, at.y) };
  return figurePoint(ground, frame, liftPose(thing.player.pose)[name]);
}
