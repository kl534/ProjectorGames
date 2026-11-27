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
/** The stands: how far back and up they go (feet), in rows of seats `seat` feet wide, with an aisle at the start of each stretch. */
export const STANDS = { depth: 85, rise: 50, rows: 28, seat: 2, aisle: 4 };
/** How many rows of seats a dugout's roof takes from the front of the stands over it. */
const DUGOUT_ROWS = 3;
export const TOWERS = [{ x: -330, y: 360 }, { x: 330, y: 360 }, { x: -260, y: -60 }, { x: 260, y: -60 }];
export const TOWER_HEIGHT = 130;
/** Where on the field each tower's lamps are aimed (the middle of its pool of light): over half way to the middle of the park. */
export const TOWER_AIMS = TOWERS.map((t) => ({ x: t.x + (PARK_CENTRE.x - t.x) * 0.55, y: t.y + (PARK_CENTRE.y - t.y) * 0.55 }));
/** The middle of each tower's bank of lamps, which light the field (and cast the players' shadows). */
export const LAMPS = TOWERS.map((t) => {
  const d = Math.hypot(PARK_CENTRE.x - t.x, PARK_CENTRE.y - t.y);
  return { x: t.x + ((PARK_CENTRE.x - t.x) / d) * 2.5, y: t.y + ((PARK_CENTRE.y - t.y) / d) * 2.5, z: TOWER_HEIGHT + 8 };
});
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
  seats: '#1d3442',
  concrete: '#4b4d55',
  roof: '#22252d',
  glass: '#2b3a4a',
  net: '#2a2c33',
  beyond: '#151820',
  crowdSkin: ['#c9946b', '#8d5a3b', '#e0b48f', '#6e4630'],
  crowdPants: ['#2b3140', '#3d3a36', '#24262c', '#4a4a50', '#2f3a52'],
  crowd: ['#7b3b3b', '#3d5a80', '#7a6a3a', '#4f6b45', '#6a4a7a', '#8a5a3a', '#38424f', '#7d6f62', '#a0663a', '#4a6f86', '#24427a', '#3b3b40', '#5a2e2e', '#2e3b2e'],
};

// Made-up advertisers along the outfield fence: [panel colour, text].
export const ADS = [
  ['#7a2f2f', 'HOT DOGS $2'], ['#2f5a7a', 'HARBOR BANK'], ['#6b5a2a', 'LAMPLIGHT DINER'], ['#3d6b45', 'GO LAMPS!'],
  ['#5a3d6b', 'BOB’S TIRES'], ['#7a5a2f', 'SUNSET MILK'], ['#2f6b6b', 'PIER 9 PIZZA'], ['#7a2f4f', 'ICE COLD LEMONADE'],
  ['#2f4f7a', 'HIT IT HERE!'], ['#6b4a2a', 'DOCKSIDE HARDWARE'],
];

/**
 * What each piece of the ballpark is made of, for the shader: lit solids,
 * things that glow (the lamps), flat paint, the ground's patterns, and
 * metal (rails, poles) that catches the lamps, and the see-through net behind home.
 */
export const MATERIAL = { lit: 0, glow: 1, flat: 2, grass: 3, infieldGrass: 4, dirt: 5, sign: 6, metal: 7, net: 8 };

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
  pole(at, r, z0, z1, colour, sides = 10, material = MATERIAL.lit) {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * TAU;
      const a1 = ((i + 1) / sides) * TAU;
      const p = (a, z) => ({ x: at.x + Math.cos(a) * r, y: at.y + Math.sin(a) * r, z });
      const n0 = { x: Math.cos(a0), y: Math.sin(a0), z: 0 };
      const n1 = { x: Math.cos(a1), y: Math.sin(a1), z: 0 };
      const verts = [[p(a0, z0), n0], [p(a1, z0), n1], [p(a1, z1), n1], [p(a0, z0), n0], [p(a1, z1), n1], [p(a0, z1), n0]];
      for (const [v, n] of verts) this.vertex(v, n, colour, [0, 0], material);
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
    mesh.pole(p, 0.6, 0, FIELD.pole, rgb(COLOURS.pole), 10, MATERIAL.metal);
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

/**
 * One stretch: the wall (padded, with a yellow line along its top and, on the
 * foul side, a railing along it), then rows of seats rising behind it, with
 * the steps of an aisle at its start, and a wall along the back. Behind home
 * plate a roof hangs over the top rows, with the press box's windows under it.
 */
function buildStretch(mesh, s) {
  const { a, b, na, nb, wallA, wallB } = s;
  const { depth, rise, rows, aisle } = STANDS;
  const wallColour = rgb(s.kind === 'outfield' ? COLOURS.pad : COLOURS.wall);
  const along = (t, z) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z });
  const wallAt = (t) => wallA + (wallB - wallA) * t;
  const wallPiece = (t0, t1, z0) => {
    mesh.quad(along(t1, z0), along(t0, z0), along(t0, wallAt(t0) - 0.5), along(t1, wallAt(t1) - 0.5), wallColour);
  };
  if (s.dugout) {
    wallPiece(0, 0.2, 0);
    wallPiece(0.8, 1, 0);
  } else {
    wallPiece(0, 1, 0);
  }
  mesh.quad({ ...b, z: wallB - 0.5 }, { ...a, z: wallA - 0.5 }, { ...a, z: wallA }, { ...b, z: wallB }, rgb(COLOURS.wallTop));
  if (s.kind === 'outfield') {
    // The padding's seams.
    for (const t of [0.25, 0.5, 0.75]) {
      const n = scale3(outwards(along(t, 0)), -0.04);
      mesh.quad(add3(along(t + 0.004, 0.3), n), add3(along(t - 0.004, 0.3), n), add3(along(t - 0.004, wallAt(t) - 0.6), n), add3(along(t + 0.004, wallAt(t) - 0.6), n),
        rgb(COLOURS.pad).map((v, k) => (k < 3 ? v * 0.7 : v)));
    }
  }
  // A point in the stands: a share `t` along the stretch, `v` of the way back, `z` feet above the wall.
  const at = (t, v, z) => {
    const n = { x: na.x + (nb.x - na.x) * t, y: na.y + (nb.y - na.y) * t };
    return { x: a.x + (b.x - a.x) * t + n.x * depth * v, y: a.y + (b.y - a.y) * t + n.y * depth * v, z: wallAt(t) + z };
  };
  const colour = s.batterEye ? rgb(COLOURS.batterEye) : rgb(COLOURS.concrete);
  const riser = s.batterEye ? colour : rgb(COLOURS.aisle);
  const stepColour = rgb(COLOURS.concrete).map((v, k) => (k < 3 ? v * 1.18 : v));
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const aisleT = s.batterEye ? 0 : Math.min(0.3, aisle / length);
  for (let row = 0; row < rows; row++) {
    const v0 = row / rows;
    const v1 = (row + 1) / rows;
    const z0 = (rise * row) / rows;
    const z1 = (rise * (row + 1)) / rows;
    // Over a dugout, its roof takes the front rows.
    const spans = s.dugout && row < DUGOUT_ROWS ? [[0, 0.2], [0.8, 1]] : [[0, 1]];
    for (const [t0, t1] of spans) {
      // The riser up to this row, then the row's floor; the aisle's steps (two to a row) are a lighter concrete.
      const seats0 = Math.max(t0, aisleT);
      if (seats0 < t1) {
        mesh.quad(at(t1, v0, z0), at(seats0, v0, z0), at(seats0, v0, z1), at(t1, v0, z1), riser);
        mesh.quad(at(t1, v0, z1), at(seats0, v0, z1), at(seats0, v1, z1), at(t1, v1, z1), colour);
      }
      if (t0 < aisleT) {
        const zm = (z0 + z1) / 2;
        const vm = (v0 + v1) / 2;
        mesh.quad(at(aisleT, v0, z0), at(t0, v0, z0), at(t0, v0, zm), at(aisleT, v0, zm), riser);
        mesh.quad(at(aisleT, v0, zm), at(t0, v0, zm), at(t0, vm, zm), at(aisleT, vm, zm), stepColour);
        mesh.quad(at(aisleT, vm, zm), at(t0, vm, zm), at(t0, vm, z1), at(aisleT, vm, z1), riser);
        mesh.quad(at(aisleT, vm, z1), at(t0, vm, z1), at(t0, v1, z1), at(aisleT, v1, z1), stepColour);
      }
    }
  }
  // A wall along the back, a little above the top row.
  mesh.quad(at(1, 1, rise), at(0, 1, rise), at(0, 1, rise + 7), at(1, 1, rise + 7), rgb(COLOURS.standsShade));
  if (s.kind === 'foul') {
    // A railing along the top of the wall in front of the seats.
    const rail = rgb(COLOURS.rail);
    const z = (t) => wallAt(t) + 3;
    const inset = (t, h) => add3(along(t, h), scale3(outwards(along(t, 0)), 0.6));
    for (let t = 0; t < 1; t += 6 / length) {
      if (s.dugout && t > 0.2 && t < 0.8) continue;
      mesh.pole(inset(t, 0), 0.07, wallAt(t), z(t), rail, 5, MATERIAL.metal);
    }
    mesh.quad(inset(1, z(1) - 0.08), inset(0, z(0) - 0.08), inset(0, z(0) + 0.08), inset(1, z(1) + 0.08), rail, MATERIAL.metal);
  }
  if (s.dugout) buildDugout(mesh, s, at);
  if (s.kind === 'foul' && Math.abs((a.x + b.x) / 2) < 100 && (a.y + b.y) / 2 < 30) buildPressBox(mesh, s, at);
}

/**
 * A dugout sunk into the front of the stands: steps down to its floor, a back
 * wall and ends, a bench along the back (the players on it are in the crowd,
 * see crowdSeats), a roof with the team's colours along its front, and a
 * railing along the edge of the field.
 */
function buildDugout(mesh, s, at) {
  const { a, b } = s;
  const team = TEAMS[s.dugout];
  const { depth, rise, rows } = STANDS;
  const back = (DUGOUT_ROWS / rows); // as a share of the stands' depth
  const roofZ = (rise * DUGOUT_ROWS) / rows; // above the wall: the front of the first row left
  const dark = rgb(COLOURS.dugout);
  const inside = rgb(COLOURS.concrete).map((v, k) => (k < 3 ? v * 0.55 : v));
  const floor = -2.5;
  const wall = (t) => s.wallA + (s.wallB - s.wallA) * t;
  const p = (t, v, z) => ({ ...at(t, v, 0), z }); // z measured from the field
  // The floor, the back wall, and the ends.
  mesh.quad(p(0.8, 0, floor), p(0.2, 0, floor), p(0.2, back, floor), p(0.8, back, floor), dark);
  mesh.quad(p(0.8, back, floor), p(0.2, back, floor), p(0.2, back, 3.3), p(0.8, back, 3.3), inside);
  mesh.quad(p(0.2, back, floor), p(0.2, 0, floor), p(0.2, 0, 3.3), p(0.2, back, 3.3), inside);
  mesh.quad(p(0.8, 0, floor), p(0.8, back, floor), p(0.8, back, 3.3), p(0.8, 0, 3.3), inside);
  // The bench along the back wall.
  mesh.box(add3(p(0.5, back * 0.82, floor + 1.45), { x: 0, y: 0, z: 0 }), [unit3({ ...sub3(b, a), z: 0 }), { ...unit3({ x: -(b.y - a.y), y: b.x - a.x, z: 0 }) }, UP],
    [Math.hypot(b.x - a.x, b.y - a.y) * 0.29, 0.7, 0.1], rgb('#3a2e24'));
  // The roof: its underside, top and front (the team's colours), and the face of the first row of seats above it.
  mesh.quad(p(0.2, 0, 3.3), p(0.8, 0, 3.3), p(0.8, back, 3.3), p(0.2, back, 3.3), dark);
  mesh.quad(p(0.8, 0, 4.4), p(0.2, 0, 4.4), p(0.2, back, 4.4), p(0.8, back, 4.4), rgb(COLOURS.concrete));
  const n = scale3(outwards({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), -0.08);
  const front = (t, z, inset = 0) => add3(p(t, 0, z), scale3(n, 1 + inset));
  mesh.quad(front(0.82, 3.3, 1), front(0.18, 3.3, 1), front(0.18, 4.4, 1), front(0.82, 4.4, 1), rgb(team.jersey));
  mesh.quad(front(0.82, 3.3, 2), front(0.18, 3.3, 2), front(0.18, 3.5, 2), front(0.82, 3.5, 2), rgb(team.trim));
  const top = (t) => wall(t) + roofZ;
  mesh.quad(p(0.8, back, 4.4), p(0.2, back, 4.4), p(0.2, back, top(0.2)), p(0.8, back, top(0.8)), rgb(COLOURS.aisle));
  // The railing along the edge of the field.
  for (let t = 0.22; t < 0.8; t += 0.06) mesh.pole(front(t, 0, 14), 0.06, 0, 2.6, rgb(COLOURS.rail), 6, MATERIAL.metal);
  const r0 = front(0.2, 2.6, 14);
  const r1 = front(0.8, 2.6, 14);
  mesh.quad({ ...r1, z: 2.5 }, { ...r0, z: 2.5 }, { ...r0, z: 2.7 }, { ...r1, z: 2.7 }, rgb(COLOURS.rail), MATERIAL.metal);
}

/** Behind home plate: a roof over the top rows on columns, with the press box's lit windows along the back under it. */
function buildPressBox(mesh, s, at) {
  const { rise } = STANDS;
  const roof = rgb(COLOURS.roof);
  const v0 = 0.62;
  const z = rise + 22;
  mesh.quad(at(1, v0, z), at(0, v0, z), at(0, 1.02, z + 4), at(1, 1.02, z + 4), roof);
  mesh.quad(at(0, v0, z), at(1, v0, z), at(1, v0, z - 2), at(0, v0, z - 2), roof);
  for (const t of [0.1, 0.9]) mesh.pole(at(t, v0 + 0.04, 0), 0.7, at(t, v0 + 0.04, 0).z + (rise * 0.66), at(t, v0, z).z - 2, roof, 6);
  // The press box: a band of windows along the back wall, dimly lit from inside.
  mesh.quad(at(1, 0.995, rise + 9), at(0, 0.995, rise + 9), at(0, 0.995, rise + 16), at(1, 0.995, rise + 16), rgb(COLOURS.roof));
  const length = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
  const panes = Math.max(2, Math.round(length / 9));
  for (let k = 0; k < panes; k++) {
    const t0 = (k + 0.12) / panes;
    const t1 = (k + 0.88) / panes;
    mesh.quad(at(t1, 0.99, rise + 10), at(t0, 0.99, rise + 10), at(t0, 0.99, rise + 15), at(t1, 0.99, rise + 15), rgb('#433f31'), MATERIAL.glow);
  }
  // Lamps under the roof's edge.
  for (let k = 0; k < panes; k++) {
    const t = (k + 0.5) / panes;
    const c = at(t, v0 + 0.01, z - 2.05);
    mesh.quad(add3(c, { x: 0.8, y: 0, z: 0 }), add3(c, { x: -0.8, y: 0, z: 0 }), add3(c, { x: -0.8, y: 0.8, z: 0 }), add3(c, { x: 0.8, y: 0.8, z: 0 }), rgb('#8a7a52'), MATERIAL.glow);
  }
}

/**
 * The net behind home plate, from the top of the wall up to keep foul balls
 * out of the seats there: a thin mesh, see-through (MATERIAL.net), drawn
 * over the stands behind it.
 */
export function buildNet() {
  const mesh = new Mesh();
  for (const st of STRETCHES) {
    if (st.kind !== 'foul') continue;
    const { a, b } = st;
    if (Math.abs(a.x) > 75 || Math.abs(b.x) > 75) continue;
    const n = scale3(outwards({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), 0.3);
    const p = (q, z) => ({ x: q.x + n.x, y: q.y + n.y, z });
    mesh.quad(p(b, st.wallB), p(a, st.wallA), p(a, st.wallA + 28), p(b, st.wallB + 28), rgb(COLOURS.net), MATERIAL.net);
  }
  return mesh;
}

/**
 * A light tower: a tapering pole with a ladder of rungs up it, a frame on top
 * tipped towards the field, and rows of lamps on it (they glow), each in a
 * housing.
 */
function buildTower(mesh, t) {
  const steel = rgb(COLOURS.tower);
  mesh.pole(t, 2.2, 0, TOWER_HEIGHT * 0.5, steel, 10, MATERIAL.metal);
  mesh.pole(t, 1.5, TOWER_HEIGHT * 0.5, TOWER_HEIGHT + 2, steel, 10, MATERIAL.metal);
  const toward = unit3({ x: PARK_CENTRE.x - t.x, y: PARK_CENTRE.y - t.y, z: 0 });
  const across = { x: -toward.y, y: toward.x, z: 0 };
  const tilt = unit3({ x: toward.x * 0.35, y: toward.y * 0.35, z: 1 });
  const back = unit3(cross3(across, tilt));
  const centre = { x: t.x, y: t.y, z: TOWER_HEIGHT + 8 };
  // The frame: rails across, with uprights at the ends.
  for (const k of [-1, 0, 1]) mesh.box(add3(centre, scale3(tilt, k * 6.5), scale3(back, 1.2)), [across, back, tilt], [16, 0.5, 0.45], steel, MATERIAL.metal, { bottom: true });
  for (const k of [-1, 1]) mesh.box(add3(centre, scale3(across, k * 16), scale3(back, 1.2)), [across, back, tilt], [0.45, 0.5, 7.5], steel, MATERIAL.metal, { bottom: true });
  // Three rows of six lamps, each a housing with a glowing face towards the field.
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 6; col++) {
      const c = add3(centre, scale3(across, -12.5 + col * 5), scale3(tilt, 6.5 - row * 6.5));
      mesh.box(add3(c, scale3(back, 0.4)), [across, back, tilt], [2.1, 1.1, 2.1], rgb('#2b2e36'), MATERIAL.metal, { bottom: true });
      const face = sub3(c, scale3(back, 0.75));
      const p = (i, j) => add3(face, scale3(across, i * 1.8), scale3(tilt, j * 1.8));
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
 * Every seat in the stands, the same every time: who sits there (most are
 * full, a few empty), facing the field, and the players on each dugout's
 * bench. `hash` picks their clothes, hair or cap and how they react.
 * @returns {{x:number, y:number, z:number, facing: Point, stretch: number, kind: 'fan'|'empty'|'player', shirt: string, skin: string,
 *   hat: string, cap: boolean, pants: string, hash: number}[]}
 */
export function crowdSeats() {
  const people = [];
  const { depth, rise, rows, seat, aisle } = STANDS;
  for (const s of STRETCHES) {
    if (s.batterEye) continue;
    const { a, b, na, nb, wallA, wallB, index } = s;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    for (let row = 0; row < rows; row++) {
      const v = (row + 0.5) / rows;
      // Each row is longer than the one in front (the stands fan out); seats start after the aisle.
      const p0 = { x: a.x + na.x * depth * v, y: a.y + na.y * depth * v };
      const p1 = { x: b.x + nb.x * depth * v, y: b.y + nb.y * depth * v };
      const rowLength = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const start = Math.min(0.3, aisle / length);
      const seats = Math.max(0, Math.floor((rowLength * (1 - start)) / seat));
      for (let k = 0; k < seats; k++) {
        const u = start + ((k + 0.5) / seats) * (1 - start);
        if (s.dugout && row < DUGOUT_ROWS && u > 0.2 && u < 0.8) continue;
        const hash = ((index * 7919 + row * 104729 + k * 1299709) >>> 0) % 997;
        const n = { x: na.x + (nb.x - na.x) * u, y: na.y + (nb.y - na.y) * u };
        const wall = wallA + (wallB - wallA) * u;
        people.push({
          x: a.x + (b.x - a.x) * u + n.x * depth * v,
          y: a.y + (b.y - a.y) * u + n.y * depth * v,
          z: wall + (rise * (row + 1)) / rows,
          facing: { x: -n.x, y: -n.y },
          stretch: index,
          ...fanOf(hash),
        });
      }
    }
    if (s.dugout) {
      // The players on the bench at the back of the dugout.
      const team = TEAMS[s.dugout];
      const n = { x: (na.x + nb.x) / 2, y: (na.y + nb.y) / 2 };
      const back = (depth * DUGOUT_ROWS) / rows * 0.82;
      for (let k = 0; k < 9; k++) {
        const hash = ((index * 7919 + k * 104729) >>> 0) % 997;
        if ((k * 7 + index) % 5 === 0) continue; // a gap on the bench
        const u = 0.24 + (k / 8) * 0.52;
        people.push({
          x: a.x + (b.x - a.x) * u + n.x * back, y: a.y + (b.y - a.y) * u + n.y * back, z: -2.5,
          facing: { x: -n.x, y: -n.y }, stretch: index, kind: 'player',
          shirt: team.jersey, skin: SKIN[hash % SKIN.length], hat: team.cap, cap: true, pants: team.pants, hash,
        });
      }
    }
  }
  return people;
}

/** A fan's clothes from their hash: more of them in the home team's navy (some in its caps), the rest in all sorts. */
function fanOf(hash) {
  const home = TEAMS.home;
  const shirt = hash % 9 === 0 ? home.jersey : COLOURS.crowd[hash % COLOURS.crowd.length];
  const cap = hash % 3 === 0;
  return {
    kind: hash % 6 === 0 ? 'empty' : 'fan',
    shirt,
    skin: COLOURS.crowdSkin[(hash >> 3) % COLOURS.crowdSkin.length],
    hat: cap ? (hash % 2 ? home.cap : COLOURS.crowd[(hash >> 2) % COLOURS.crowd.length]) : HAIR[(hash >> 4) % HAIR.length],
    cap,
    pants: COLOURS.crowdPants[(hash >> 5) % COLOURS.crowdPants.length],
    hash,
  };
}

/** Floats for each seat in the crowd's instances: where (and which way it faces), and the colours of who sits there. */
export const CROWD_STRIDE = 20;
/** What each piece of a person in the crowd is, for the shader (CROWD_PART in the renderer). */
export const CROWD_PART = { shirt: 0, skin: 1, hair: 2, arms: 3, pants: 4, chair: 5, armsUp: 6, brim: 7, shoes: 8, hands: 9, handsUp: 10 };
const KIND = { empty: 0, fan: 1, player: 2 };

/**
 * The crowd, for drawing instanced: each seat as CROWD_STRIDE floats (where
 * it is and the way it faces, as an angle; shirt colour and hash; skin and
 * who sits there, 0 empty, 1 a fan, 2 a player on a bench; hair or cap colour
 * and whether it is a cap; trousers colour), in parts, one to a stretch of the
 * stands (`parts`: the first seat, how many, and the box they fit in, a
 * little bigger for a jump), so the stands out of sight needn't be drawn.
 * @returns {{data: Float32Array, count: number, parts: {first:number, count:number, min:Point3, max:Point3, centre:Point3}[]}}
 */
export function buildCrowd() {
  const seats = crowdSeats();
  const data = new Float32Array(seats.length * CROWD_STRIDE);
  const parts = [];
  let part = null;
  seats.forEach((p, i) => {
    if (!part || part.stretch !== p.stretch) {
      part = { stretch: p.stretch, first: i, count: 0, min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
      parts.push(part);
    }
    part.count++;
    for (const k of ['x', 'y', 'z']) {
      part.min[k] = Math.min(part.min[k], p[k] - 2);
      part.max[k] = Math.max(part.max[k], p[k] + (k === 'z' ? 7 : 2));
    }
    const shirt = rgb(p.shirt);
    const skin = rgb(p.skin);
    const hat = rgb(p.hat);
    const pants = rgb(p.pants);
    data.set([p.x, p.y, p.z, Math.atan2(p.facing.x, p.facing.y), shirt[0], shirt[1], shirt[2], p.hash, skin[0], skin[1], skin[2], KIND[p.kind],
      hat[0], hat[1], hat[2], p.cap ? 1 : 0, pants[0], pants[1], pants[2], 0], i * CROWD_STRIDE);
  });
  for (const pt of parts) pt.centre = { x: (pt.min.x + pt.max.x) / 2, y: (pt.min.y + pt.max.y) / 2, z: (pt.min.z + pt.max.z) / 2 };
  return { data, count: seats.length, parts };
}

/**
 * One seat in the stands and the person in it, made once and drawn for every
 * seat: [x, y, z, nx, ny, nz, part] for each vertex, in feet, facing +y, on
 * the floor of their row under the middle of the seat. Near, a folding seat
 * with a back, and a person sitting in it: shoes and shins, thighs on the
 * seat, a body narrowing to the waist, a neck and a head, hair or a cap with
 * a brim, and arms resting in the lap (another pair raised, for a cheer). Far,
 * the seat's back, a body and a head; farthest, only their fronts.
 * @param {'near'|'far'|'farthest'} detail
 * @returns {Float32Array}
 */
export function crowdTemplate(detail) {
  const near = detail === 'near';
  const out = [];
  const P = CROWD_PART;
  // A four-cornered face, wound anticlockwise as seen from the side its normal `n` points to.
  const face = (corners, n, part) => {
    const [p0, p1, p2, p3] = corners;
    const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const v = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const facing = (u[1] * v[2] - u[2] * v[1]) * n[0] + (u[2] * v[0] - u[0] * v[2]) * n[1] + (u[0] * v[1] - u[1] * v[0]) * n[2];
    const order = facing >= 0 ? [p0, p1, p2, p0, p2, p3] : [p0, p2, p1, p0, p3, p2];
    for (const q of order) out.push(q[0], q[1], q[2], n[0], n[1], n[2], part);
  };
  // A box with its bottom and top `half0` and `half1` across and deep (a taper), from z0 to z1, centred at (x, y),
  // without its back (`back: false`: nobody sees the crowd from behind), and with its top a part of its own.
  const box = (x, y, z0, z1, half0, half1, part, { bottom = false, back = true, top = part } = {}) => {
    const c = (sx, sy, up) => {
      const h = up ? half1 : half0;
      return [x + sx * h[0], y + sy * h[1], up ? z1 : z0];
    };
    const side = (a, b, n) => face([c(...a, false), c(...b, false), c(...b, true), c(...a, true)], n, part);
    side([-1, 1], [1, 1], [0, 1, 0]);
    side([1, 1], [1, -1], [1, 0, 0]);
    if (back) side([1, -1], [-1, -1], [0, -1, 0]);
    side([-1, -1], [-1, 1], [-1, 0, 0]);
    face([c(-1, -1, true), c(1, -1, true), c(1, 1, true), c(-1, 1, true)], [0, 0, 1], top);
    if (bottom) face([c(-1, 1, false), c(1, 1, false), c(1, -1, false), c(-1, -1, false)], [0, 0, -1], part);
  };
  // A box from one point to another (an arm), `r` thick.
  const bar = (a, b, r, part) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L = Math.hypot(...d);
    const u = d.map((x) => x / L);
    let p = Math.abs(u[2]) < 0.9 ? [u[1], -u[0], 0] : [1, 0, 0];
    const pl = Math.hypot(...p);
    p = p.map((x) => x / pl);
    const q = [u[1] * p[2] - u[2] * p[1], u[2] * p[0] - u[0] * p[2], u[0] * p[1] - u[1] * p[0]];
    const at = (end, sp, sq) => [0, 1, 2].map((k) => end[k] + (p[k] * sp + q[k] * sq) * r);
    for (const [s1, s2, t1, t2] of [[1, 1, -1, 1], [-1, 1, -1, -1], [-1, -1, 1, -1], [1, -1, 1, 1]]) {
      const n = [0, 1, 2].map((k) => (p[k] * (s1 + t2) + q[k] * (s2 + t1)) / 2);
      const nl = Math.hypot(...n) || 1;
      face([at(a, s1, s2), at(a, t1, t2), at(b, t1, t2), at(b, s1, s2)], n.map((x) => x / nl), part);
    }
    face([at(b, 1, 1), at(b, 1, -1), at(b, -1, -1), at(b, -1, 1)], u, part);
  };
  // A rounded head (a low sphere), or the top of one (hair, a cap's crown).
  const ball = (c, r, part, segs, rings, from = 0, to = rings) => {
    const v = (i, j) => {
      const th = (j / rings) * Math.PI;
      const ph = (i / segs) * 2 * Math.PI;
      const n = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
      return { p: [c[0] + n[0] * r[0], c[1] + n[1] * r[1], c[2] + n[2] * r[2]], n };
    };
    for (let j = from; j < to; j++) {
      for (let i = 0; i < segs; i++) {
        const q = [v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)];
        for (const k of [0, 2, 1, 0, 3, 2]) out.push(...q[k].p, ...q[k].n, part);
      }
    }
  };
  // The seat and its back (far off, just its back).
  if (near) box(0, 0.05, 1.32, 1.46, [0.78, 0.72], [0.78, 0.72], P.chair, { bottom: true });
  box(0, -0.72, 1.4, 2.9, [0.78, 0.07], [0.74, 0.07], P.chair, { back: near });
  if (detail === 'farthest') {
    // A long way off, the fronts of the seat's back, the body and the head (with the hair on top) are all that show.
    face([[-0.74, -0.65, 1.4], [0.74, -0.65, 1.4], [0.74, -0.65, 2.9], [-0.74, -0.65, 2.9]], [0, 1, 0], P.chair);
    face([[-0.58, 0.4, 1.46], [0.58, 0.4, 1.46], [0.6, 0.35, 3.5], [-0.6, 0.35, 3.5]], [0, 1, 0], P.shirt);
    face([[-0.27, 0.27, 3.65], [0.27, 0.27, 3.65], [0.26, 0.25, 4.5], [-0.26, 0.25, 4.5]], [0, 1, 0], P.skin);
    face([[-0.26, 0.25, 4.5], [0.26, 0.25, 4.5], [0.26, -0.35, 4.5], [-0.26, -0.35, 4.5]], [0, 0, 1], P.hair);
    return new Float32Array(out);
  }
  if (!near) {
    // Far off a person is a few pixels: a body with the knees in front, and a head with hair or a cap on top.
    box(0, 0.05, 1.46, 3.5, [0.55, 0.36], [0.62, 0.32], P.shirt, { back: false });
    box(0, 0.6, 1.46, 1.8, [0.5, 0.5], [0.5, 0.5], P.pants, { back: false });
    box(0, -0.05, 3.65, 4.5, [0.28, 0.32], [0.26, 0.3], P.skin, { back: false, top: P.hair });
    return new Float32Array(out);
  }
  box(0, 1.2, 0, 0.22, [0.48, 0.34], [0.46, 0.3], P.shoes);
  box(0, 0.98, 0.22, 1.5, [0.42, 0.18], [0.46, 0.2], P.pants);
  box(0, 0.42, 1.46, 1.84, [0.52, 0.66], [0.5, 0.62], P.pants);
  box(0, -0.12, 1.46, 2.7, [0.56, 0.36], [0.52, 0.34], P.shirt);
  box(0, -0.14, 2.7, 3.55, [0.52, 0.34], [0.66, 0.3], P.shirt);
  box(0, -0.12, 3.55, 3.85, [0.15, 0.14], [0.14, 0.13], P.skin);
  ball([0, -0.08, 4.12], [0.3, 0.33, 0.38], P.skin, 6, 5);
  ball([0, -0.11, 4.16], [0.32, 0.35, 0.36], P.hair, 6, 4, 0, 2);
  box(0, 0.32, 4.28, 4.32, [0.26, 0.22], [0.26, 0.22], P.brim, { bottom: true });
  for (const sx of [-1, 1]) {
    bar([sx * 0.66, -0.15, 3.42], [sx * 0.7, -0.05, 2.62], 0.14, P.arms);
    bar([sx * 0.7, -0.05, 2.62], [sx * 0.38, 0.72, 2.12], 0.12, P.arms);
    box(sx * 0.36, 0.86, 2.0, 2.2, [0.1, 0.13], [0.1, 0.13], P.hands, { bottom: true });
    bar([sx * 0.66, -0.15, 3.42], [sx * 0.86, -0.02, 5.0], 0.14, P.armsUp);
    box(sx * 0.88, -0.02, 5.0, 5.35, [0.11, 0.1], [0.1, 0.09], P.handsUp);
  }
  return new Float32Array(out);
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
 * @param {typeof BODY} [body] the body's sizes (Golden Boot's keeper is a cartoon's)
 * @returns {Record<string, {r:number, u:number, f:number}>} the joints, and the shoulders and hips (lShoulder, rHip, …)
 */
export function liftPose(pose, body = BODY) {
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
    const shoulder = { x: neck.x - s.x * body.shoulderDrop, y: neck.y - s.y * body.shoulderDrop };
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
    const shoulder = { x: neck.x + across.x * body.shoulderHalf * k - s.x * body.shoulderDrop, y: neck.y + across.y * body.shoulderHalf * k - s.y * body.shoulderDrop };
    const hipJ = { x: hip.x + across.x * 0.42 * k, y: hip.y + across.y * 0.42 * k };
    const elbow = J(`${side}Elbow`);
    const hand = J(`${side}Hand`);
    const knee = J(`${side}Knee`);
    const elbowF = lean + 0.35 * depth(shoulder, elbow, body.upperArm);
    out[`${side}Shoulder`] = at(shoulder, lean);
    out[`${side}Hip`] = at(hipJ, 0);
    out[`${side}Elbow`] = at(elbow, elbowF);
    out[`${side}Hand`] = at(hand, elbowF + depth(elbow, hand, body.forearm));
    out[`${side}Knee`] = at(knee, Math.min(1.1, 0.8 * depth(hipJ, knee, body.thigh)));
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
const LEATHER = rgb('#7d4a22');
const LEATHER_SHADE = rgb('#5e3517');
const LEATHER_DARK = rgb('#3f230e');
const LACE = rgb('#2c1a0c');
const CLEAT = rgb('#17181d');
const SOLE = rgb('#2a2b31');
const SCLERA = rgb('#a39b8c');
const IRIS = rgb('#2a1d14');
const BALL = rgb('#e4dfd2');
const BAT = rgb('#a87c47');
const BUCKLE = rgb('#6d6f75');
const MASK = rgb('#25272d');
const PAD = rgb('#3a2f28');
// Hair, darkest to lightest; each skin tone has its own (see SKIN).
const HAIR = ['#2a1e16', '#1d1611', '#120e0c', '#4a3322', '#21170f', '#0f0c0b'];

/** Which picture in the glyph sheet (see fielders-choice-art.js) a letter or digit is. */
export const GLYPHS = '0123456789LR';
/** The cells after the glyphs: each team's name across the chest, in script. */
export const WORDMARKS = { home: GLYPHS.length, away: GLYPHS.length + 1 };
/** How much wider than high a wordmark is painted (and stretched back out on the jersey). */
export const WORDMARK_ASPECT = 4.2;

/**
 * @typedef {object} Shape one solid piece of a player, for the renderer
 * @property {'sphere'|'dome'|'cyl'|'box'|'quad'} mesh the unit shape it is made from
 * @property {Float32Array|number[]} m column-major matrix from the unit shape to the field
 * @property {number[]} colour
 * @property {number} [taper] a cylinder's far end, as a fraction of its near end
 * @property {number} [glyph] for a quad: the letter or digit painted on it
 * @property {'cloth'|'skin'|'leather'|'gloss'|'rubber'|'wood'|'ball'|'matt'} [finish] what it is made of (default cloth)
 * @property {boolean} [cast] whether it casts shadows from the lamps (default true)
 * @property {boolean} [outline] a dark outline round it, if the renderer is asked for outlines (default true)
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
function limb(out, a, b, r1, r2, colour, hint = UP, extra = {}) {
  const d = sub3(b, a);
  const L = Math.hypot(d.x, d.y, d.z);
  if (L > 1e-4) {
    const [p, q] = across(scale3(d, 1 / L), hint);
    out.push(shape('cyl', a, scale3(p, r1), scale3(q, r1), d, colour, { taper: r2 / r1, ...extra }));
  }
  // The rounded ends (the cylinder alone casts the limb's shadow).
  out.push(sphere(a, r1, colour, { ...extra, cast: false }), sphere(b, r2, colour, { ...extra, cast: false }));
}

/**
 * A limb with flesh on it: tapered from a to b, with a muscle's swell (an
 * ellipsoid `bulge` times the limb's radius there) a share `at` of the way
 * along, pushed a little towards `side` (the front of a thigh, the back of a calf).
 */
function muscle(out, a, b, r1, r2, colour, { at = 0.4, bulge = 1.2, side = null, hint = UP, extra = {} } = {}) {
  limb(out, a, b, r1, r2, colour, hint, extra);
  const d = sub3(b, a);
  const L = Math.hypot(d.x, d.y, d.z);
  if (L < 1e-4) return;
  const dir = scale3(d, 1 / L);
  const r = (r1 + (r2 - r1) * at) * bulge;
  const [p, q] = across(dir, side ?? hint);
  const c = add3(lerp3(a, b, at), side ? scale3(p, r * 0.12) : { x: 0, y: 0, z: 0 });
  out.push(ellipsoid(c, [p, q, dir], [r, r * 0.94, L * 0.36], colour, 'sphere', { ...extra, cast: false }));
}

/** A short band round a limb (a sleeve's edge, a sock's stirrup), from a to b. */
function band(out, a, b, r, colour, extra = {}) {
  const d = sub3(b, a);
  const L = Math.hypot(d.x, d.y, d.z) || 1;
  const [p, q] = across(scale3(d, 1 / L), UP);
  out.push(shape('cyl', a, scale3(p, r), scale3(q, r), d, colour, { taper: 1, outline: false, cast: false, ...extra }));
}

/** A letter or digit painted on a flat square `size` feet high at `c`, facing `n`, upright along `up`. */
function glyph(c, n, up, size, ch, colour) {
  const i = GLYPHS.indexOf(ch);
  if (i < 0) return null;
  const right = unit3(cross3(up, n));
  return shape('quad', c, scale3(right, size * 0.36), scale3(up, size / 2), n, colour, { glyph: i, outline: false, cast: false });
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

/** The team's name across the chest, `width` feet wide. */
function wordmark(c, n, up, width, team, colour) {
  const right = unit3(cross3(up, n));
  return shape('quad', c, scale3(right, width / 2), scale3(up, width / WORDMARK_ASPECT / 2), n, colour, { glyph: WORDMARKS[team], outline: false, cast: false });
}

/**
 * How a player is built, from who they are: a share wider or narrower than
 * the usual (`w`), their hair, and whether they wear a beard. The bones are
 * the same for everyone (the poses set them); only the flesh on them differs.
 */
function buildOf(player) {
  const n = (player.number ?? 0) + (player.skin ?? 0) * 17;
  return {
    w: 0.93 + ((n * 37) % 13) / 12 * 0.15,
    hair: rgb(HAIR[(player.skin ?? 0) % HAIR.length]),
    beard: n % 4 === 1 && !player.youth,
  };
}

const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k, c[3]];
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, 1];

/**
 * Everything a player is made of, posed and placed on the field, built as a
 * real ballplayer is: hips and a chest that widens to the shoulders, a back,
 * arms and legs with muscle on them, a neck and a head with a face (eyes,
 * brows, nose, lips, ears, hair, maybe a beard) under a cap, a batting helmet
 * or a mask. The uniform: a jersey with a buttoned front, piping, the team's
 * name across the chest and numbers front and back, sleeves over an
 * undershirt, a belt with a buckle, pants to below the knee, high socks with
 * stirrups, and cleats. A glove or a bare hand, and a bat if they hold one.
 * Each piece has a finish (cloth, skin, leather…) for the lighting. A soft
 * dark spot goes on the ground under them; the renderer casts their shadows
 * from the lamps.
 * @param {{at: {x:number, y:number, z?:number}, player: import('./fielders-choice-players.js').Player, facing?: Point|null, lookAt?: Point|null}} thing
 * @returns {Shape[]}
 */
export function playerShapes(thing) {
  const shapes = playerShapesAtSize(thing);
  const k = thing.player.scale ?? 1;
  return k === 1 ? shapes : scaleShapes(shapes, thing.at, k);
}

/**
 * Shapes made `k` times the size, about the point on the ground under `at`: each shape's axes (its sizes) and its
 * distance from that point are `k` times as much, so a whole figure, flesh and bones, is uniformly smaller or bigger.
 * @param {Shape[]} shapes
 */
export function scaleShapes(shapes, at, k) {
  const gz = at.z ?? groundHeight(at.x, at.y);
  return shapes.map((sh) => {
    const m = sh.m.slice();
    for (let i = 0; i < 12; i++) m[i] *= k;
    m[12] = at.x + (m[12] - at.x) * k;
    m[13] = at.y + (m[13] - at.y) * k;
    m[14] = gz + (m[14] - gz) * k;
    return { ...sh, m };
  });
}

function playerShapesAtSize({ at, player, facing, lookAt = null }) {
  const pose = player.pose;
  const team = TEAMS[player.team];
  const skin = rgb(SKIN[(player.skin ?? 0) % SKIN.length]);
  const build = buildOf(player);
  const W = build.w;
  const frame = figureFrame(facing ?? { x: 0, y: -1 });
  const ground = { x: at.x, y: at.y, z: at.z ?? groundHeight(at.x, at.y) };
  const j3 = liftPose(pose);
  const P = (name) => figurePoint(ground, frame, j3[name]);
  const out = [];
  const c = (hex) => rgb(hex);
  const umpire = player.team === 'umpire';
  const SKIN_F = { finish: 'skin' };
  const jersey = c(team.jersey);
  const pants = c(team.pants);
  const trim = c(team.trim);
  const under = umpire ? jersey : c(team.undershirt);

  // A soft dark spot on the ground under them (fainter the higher they are).
  const lift = pose.lift ?? 0;
  const fade = Math.max(0.3, 1 - lift / 4);
  const spread = pose.turn ? 2.2 : 1;
  out.push(shape('quad', { x: ground.x, y: ground.y, z: ground.z + 0.03 }, scale3(frame.right, SHADOW.across * spread), scale3(frame.forward, SHADOW.along), UP,
    [0, 0, 0, 0.42 * fade], { shadow: true, outline: false }));

  // The body's own directions: up the spine, to their right, and forward.
  const hip = P('hip');
  const neck = P('neck');
  const spineV = sub3(neck, hip);
  const len = Math.hypot(spineV.x, spineV.y, spineV.z) || 1;
  const spine = scale3(spineV, 1 / len);
  const [side, front] = across(spine, frame.right);
  const back = scale3(front, -1);
  const along = (u) => add3(hip, scale3(spine, u));
  const on = (u, s, f) => add3(along(u), scale3(side, s), scale3(front, f));
  const body = [side, front, spine];
  // How far in front of the spine the jersey is, a share `u` of the way up it (where things go on its front).
  const surface = (u) => {
    const chest = 0.38 * Math.sqrt(Math.max(0, 1 - ((u - len * 0.64) / (len * 0.4)) ** 2));
    const waist = u >= 0.12 && u <= 0.12 + len * 0.5 ? 0.33 * (1 + 0.12 * (u - 0.12) / (len * 0.5)) : 0;
    return Math.max(chest, waist);
  };

  // Hips and seat (the pants), then the waist and a chest that widens to the shoulders (the jersey), and the back.
  out.push(ellipsoid(on(0.02, 0, -0.02), body, [0.54 * W, 0.37, 0.34], pants));
  for (const s of [-1, 1]) out.push(ellipsoid(on(-0.04, s * 0.22 * W, -0.12), body, [0.27 * W, 0.25, 0.3], pants, 'sphere', { cast: false }));
  out.push(shape('cyl', along(0.12), scale3(side, 0.49 * W), scale3(front, 0.33), scale3(spine, len * 0.5), jersey, { taper: 1.12 }));
  out.push(ellipsoid(on(len * 0.64, 0, 0.0), body, [0.6 * W, 0.38, len * 0.4], jersey));
  // The belt and its buckle, at the top of the pants.
  out.push(shape('cyl', along(0.16), scale3(side, 0.515 * W), scale3(front, 0.355), scale3(spine, 0.12), umpire ? c('#15161b') : c('#17181c'),
    { taper: 1, finish: 'leather', cast: false }));
  out.push(shape('box', on(0.22, 0, 0.36), scale3(side, 0.07), scale3(front, 0.015), scale3(spine, 0.045), BUCKLE, { finish: 'gloss', cast: false }));
  if (!umpire) {
    // The buttoned front with piping either side, the name across the chest, the number under it and big on the back.
    // The front, in short pieces that follow the jersey's curve.
    for (let k = 0; k < 6; k++) {
      const u0 = len * (0.12 + k * 0.13);
      const u1 = u0 + len * 0.13;
      const a = on(u0, 0, surface(u0) - 0.004);
      const b = on(u1, 0, surface(u1) - 0.004);
      const mid = lerp3(a, b, 0.5);
      const d = scale3(sub3(b, a), 0.5);
      const n = unit3(cross3(side, d));
      out.push(shape('box', mid, scale3(side, 0.04), scale3(n, 0.01), d, shade(jersey, 0.86), { cast: false }));
      for (const s of [-1, 1]) out.push(shape('box', add3(mid, scale3(side, s * 0.045)), scale3(side, 0.01), scale3(n, 0.013), d, trim, { cast: false }));
      out.push(sphere(add3(on(u0 + len * 0.065, 0, surface(u0 + len * 0.065))), 0.014, shade(trim, 0.9), { cast: false }));
    }
    const chestU = len * 0.68;
    out.push(wordmark(on(chestU, 0, surface(chestU) + 0.02), unit3(add3(front, scale3(spine, -0.1))), spine, 0.82 * W, player.team, trim));
    if (player.number !== undefined) {
      const u = len * 0.42;
      number(out, on(u, -0.24 * W, surface(u) + 0.015), front, spine, 0.24, player.number, trim);
      number(out, on(len * 0.58, 0, -0.335), back, spine, 0.62, player.number, trim);
    }
  } else {
    // The plate umpire's chest protector under the shirt, and the shirt's pocket flaps.
    out.push(ellipsoid(on(len * 0.62, 0, 0.12), body, [0.5 * W, 0.34, len * 0.32], shade(jersey, 0.95)));
    for (const s of [-1, 1]) out.push(shape('box', on(len * 0.68, s * 0.24, 0.47), scale3(side, 0.11), scale3(front, 0.01), scale3(spine, 0.03), shade(jersey, 0.8), { cast: false }));
  }

  // Legs: the pants over the thighs and knees to below the knee, then the socks over the calves, and cleats.
  for (const s of ['l', 'r']) {
    const hipJ = P(`${s}Hip`);
    const knee = P(`${s}Knee`);
    const foot = P(`${s}Foot`);
    const ankle = lerp3(knee, foot, 0.88);
    const hem = lerp3(knee, foot, 0.22);
    muscle(out, hipJ, knee, 0.29 * W, 0.2 * W, pants, { at: 0.35, bulge: 1.05, side: frame.forward, hint: frame.forward });
    limb(out, knee, hem, 0.2 * W, 0.19 * W, pants, frame.forward);
    band(out, lerp3(knee, foot, 0.2), lerp3(knee, foot, 0.24), 0.195 * W, shade(pants, 0.9));
    // A calf swells at the back of the shin.
    muscle(out, hem, ankle, 0.165 * W, 0.1 * W, c(team.socks), { at: 0.25, bulge: 1.06, side: scale3(frame.forward, -1), hint: frame.forward });
    band(out, lerp3(knee, foot, 0.5), lerp3(knee, foot, 0.58), 0.15 * W, trim);
    // The shoe: an upper over a sole, its toe forward of the ankle.
    const toe = frame.forward;
    const shoe = add3(foot, scale3(toe, 0.2), { x: 0, y: 0, z: 0.1 });
    out.push(ellipsoid(shoe, [frame.right, toe, UP], [0.15, 0.4, 0.13], CLEAT, 'sphere', { finish: 'rubber' }));
    out.push(ellipsoid(add3(foot, scale3(toe, 0.2), { x: 0, y: 0, z: 0.03 }), [frame.right, toe, UP], [0.16, 0.44, 0.04], SOLE, 'sphere', { finish: 'rubber', cast: false }));
    out.push(sphere(ankle, 0.1 * W, c(team.socks), { cast: false }));
  }

  // Arms: a deltoid at the shoulder and a short sleeve, then the undershirt's sleeve over the upper arm and forearm.
  for (const s of ['l', 'r']) {
    const shoulder = P(`${s}Shoulder`);
    const elbow = P(`${s}Elbow`);
    const hand = P(`${s}Hand`);
    const wrist = lerp3(elbow, hand, 0.86);
    const sleeve = lerp3(shoulder, elbow, 0.5);
    limb(out, shoulder, sleeve, 0.19 * W, 0.17 * W, jersey);
    if (!umpire) band(out, lerp3(shoulder, elbow, 0.46), lerp3(shoulder, elbow, 0.52), 0.172 * W, trim);
    muscle(out, sleeve, elbow, 0.14 * W, 0.11 * W, under, { at: 0.2, bulge: 1.05 });
    muscle(out, elbow, wrist, 0.12 * W, 0.08, umpire ? jersey : under, { at: 0.25, bulge: 1.06 });
    if (player.glove === s) glove(out, hand, unit3(sub3(hand, elbow)), frame.forward, player.holdsBall);
    else bareHand(out, wrist, hand, frame, skin);
  }
  if (j3.batTip) {
    const grip = lerp3(P('lHand'), P('rHand'), 0.5);
    const tipRaw = P('batTip');
    const dir = unit3(sub3(tipRaw, grip));
    const knob = sub3(grip, scale3(dir, 0.3));
    limb(out, knob, add3(grip, scale3(dir, 0.6)), 0.045, 0.05, BAT, UP, { finish: 'wood' });
    limb(out, add3(grip, scale3(dir, 0.6)), add3(grip, scale3(dir, 2.5)), 0.05, 0.11, BAT, UP, { finish: 'wood' });
    out.push(ellipsoid(knob, across(dir, UP).concat([dir]), [0.07, 0.07, 0.03], BAT, 'sphere', { finish: 'wood' }));
  }

  // The neck, with the slope of the shoulders running down to it, and the head, turned to look at `lookAt`.
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
  limb(out, add3(neck, scale3(spine, -0.1)), add3(head, scale3(hUp, -0.24), scale3(hFront, -0.05)), 0.17 * W, 0.145 * W, skin, UP, SKIN_F);
  // The slope of the shoulders up to the neck (the trapezius), and the jersey's collar round it.
  for (const s of [-1, 1]) out.push(ellipsoid(on(len * 0.9, s * 0.28 * W, -0.05), body, [0.32 * W, 0.2, 0.22], jersey, 'sphere', { cast: false }));
  out.push(shape('cyl', on(len * 0.96, 0, -0.01), scale3(side, 0.2 * W), scale3(front, 0.18), scale3(spine, 0.07), shade(jersey, 0.9), { taper: 0.95, cast: false }));
  headShapes(out, pose, player, team, skin, build, head, hUp, hFront, hRight);
  return out.filter(Boolean);
}

function lerp3(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/** A bare hand from the wrist: the palm, the fingers together and curled a little, and the thumb. */
function bareHand(out, wrist, hand, frame, skin) {
  const dir = unit3(sub3(hand, wrist));
  const [palmFace, width] = across(dir, frame.forward);
  const extra = { finish: 'skin' };
  out.push(ellipsoid(lerp3(wrist, hand, 0.55), [width, palmFace, dir], [0.09, 0.045, 0.12], skin, 'sphere', extra));
  out.push(ellipsoid(add3(hand, scale3(dir, 0.1), scale3(palmFace, 0.025)), [width, palmFace, dir], [0.085, 0.045, 0.1], skin, 'sphere', extra));
  limb(out, add3(lerp3(wrist, hand, 0.5), scale3(width, 0.07)), add3(hand, scale3(width, 0.1), scale3(palmFace, 0.06)), 0.03, 0.026, skin, UP, extra);
}

/**
 * A head built as a real one is: the skull and jaw, chin and cheekbones, a
 * nose, a brow, eyes with dark irises and lids, eyebrows, lips, ears, hair
 * at the back and sides (and a beard on some), under a cap with a crown,
 * button and curved brim, or a shiny batting helmet with an ear flap, maybe
 * behind a mask.
 */
function headShapes(out, pose, player, team, skin, build, h, U, F, R) {
  const at = (x, y, z) => add3(h, scale3(R, x), scale3(U, y), scale3(F, z));
  // Only the skull and jaw cast a shadow; the face's small pieces would be lost in it.
  const S = { finish: 'skin', cast: false };
  const M = { finish: 'matt', cast: false };
  const skinShade = shade(skin, 0.85);
  const lips = mix(skin, rgb('#6a2f2c'), 0.35);
  const hair = build.hair;
  const axes = [R, U, F];
  // Skull, then the face over the front of it: jaw, chin and cheekbones.
  out.push(ellipsoid(at(0, 0.03, -0.03), axes, [0.25, 0.28, 0.29], skin, 'sphere', { finish: 'skin' }));
  out.push(ellipsoid(at(0, -0.12, 0.07), axes, [0.2, 0.21, 0.21], skin, 'sphere', { finish: 'skin' }));
  out.push(ellipsoid(at(0, -0.27, 0.15), axes, [0.08, 0.07, 0.07], skin, 'sphere', S));
  for (const s of [-1, 1]) out.push(ellipsoid(at(s * 0.12, -0.04, 0.18), axes, [0.06, 0.04, 0.05], skin, 'sphere', S));
  // The brow over the eyes, and the nose.
  out.push(ellipsoid(at(0, 0.065, 0.22), axes, [0.17, 0.035, 0.055], skin, 'sphere', S));
  out.push(shape('sphere', at(0, -0.05, 0.27), scale3(R, 0.04), scale3(unit3(add3(U, scale3(F, -0.35))), 0.09), scale3(F, 0.05), skin, S));
  out.push(sphere(at(0, -0.11, 0.3), 0.034, skin, S));
  for (const s of [-1, 1]) out.push(sphere(at(s * 0.033, -0.12, 0.285), 0.022, skinShade, S));

  const face = pose.face ?? 'neutral';
  const lookJ = pose.look ?? { x: 0, y: 0 };
  const glance = pose.view === 'front' ? -lookJ.x : 0;
  const tilt = { focus: -0.06, yell: -0.08, oops: 0.07, happy: 0.02, neutral: 0 }[face] ?? 0;
  for (const s of [-1, 1]) {
    // An eye set in under the brow: the white, the iris looking where they look, and the lid over the top of it.
    const eye = at(s * 0.085, 0.01, 0.215);
    out.push(ellipsoid(eye, axes, [0.04, face === 'yell' ? 0.03 : 0.024, 0.028], SCLERA, 'sphere', M));
    out.push(sphere(add3(eye, scale3(R, glance * 0.012), scale3(U, lookJ.y * 0.008), scale3(F, 0.018)), 0.018, IRIS, M));
    out.push(ellipsoid(add3(eye, scale3(U, face === 'yell' ? 0.02 : 0.014)), axes, [0.038, 0.016, 0.03], skinShade, 'sphere', S));
    // An eyebrow: down and in when focused or yelling, up when worried.
    const slope = unit3(add3(R, scale3(U, s * tilt * -3)));
    out.push(shape('box', at(s * 0.09, 0.07 + tilt * 0.3, 0.255), scale3(slope, 0.05), scale3(U, 0.012), scale3(F, 0.015), hair, M));
    // An ear.
    out.push(ellipsoid(at(s * 0.245, -0.03, -0.01), axes, [0.025, 0.075, 0.045], skin, 'sphere', S));
  }
  // The mouth: open in a yell, a smile, a grimace, or set.
  const mouth = at(0, -0.19, 0.245);
  if (face === 'yell') {
    out.push(ellipsoid(mouth, axes, [0.055, 0.04, 0.03], rgb('#3a1515'), 'sphere', M));
    out.push(ellipsoid(add3(mouth, scale3(U, 0.04)), axes, [0.06, 0.014, 0.03], lips, 'sphere', S));
  } else {
    const curve = face === 'happy' ? 0.012 : face === 'oops' ? -0.01 : 0;
    out.push(ellipsoid(add3(mouth, scale3(U, 0.008)), axes, [0.055, 0.012, 0.025], lips, 'sphere', S));
    out.push(ellipsoid(add3(mouth, scale3(U, -0.012 + curve)), axes, [0.05, 0.015, 0.025], lips, 'sphere', S));
  }
  // Hair round the back and sides under the cap, sideburns, and a beard on some.
  out.push(ellipsoid(at(0, 0.0, -0.07), axes, [0.258, 0.25, 0.26], hair, 'sphere', M));
  for (const s of [-1, 1]) out.push(ellipsoid(at(s * 0.236, 0.0, 0.07), axes, [0.02, 0.07, 0.035], hair, 'sphere', M));
  if (build.beard) {
    out.push(ellipsoid(at(0, -0.2, 0.08), axes, [0.205, 0.14, 0.2], mix(hair, skin, 0.25), 'sphere', M));
    out.push(ellipsoid(at(0, -0.155, 0.255), axes, [0.06, 0.014, 0.02], hair, 'sphere', M));
  }

  const r = BODY.headRadius;
  if (player.helmet) {
    // A batting helmet: a shiny shell over the head, a short brim, and a flap over the ear facing the pitcher.
    const G = { finish: 'gloss' };
    out.push(ellipsoid(at(0, 0.02, -0.04), [R, F, U], [0.3, 0.34, 0.34], rgb(team.cap), 'dome', G));
    out.push(ellipsoid(at(0, -0.04, -0.12), axes, [0.29, 0.2, 0.25], rgb(team.cap), 'sphere', G));
    out.push(ellipsoid(at(-0.26, -0.1, 0.0), axes, [0.06, 0.17, 0.16], rgb(team.cap), 'sphere', G));
    out.push(ellipsoid(at(0, 0.04, 0.27), [R, F, U], [0.24, 0.14, 0.022], rgb(team.capShade), 'cyl', G));
    if (team.letter) out.push(glyph(at(0, 0.2, 0.27), unit3(add3(F, scale3(U, 0.6))), unit3(add3(U, scale3(F, -0.6))), 0.17, team.letter, rgb(team.logo)));
  } else {
    // A ball cap: the crown, a button on top, and the brim, curved down at its sides.
    out.push(ellipsoid(at(0, 0.05, -0.03), [R, F, U], [0.27, 0.31, 0.28], rgb(team.cap), 'dome'));
    out.push(sphere(at(0, 0.325, -0.03), 0.022, rgb(team.capShade)));
    // The brim, tipped down a little.
    const tip = unit3(add3(F, scale3(U, -0.22)));
    out.push(shape('cyl', at(0, 0.085, 0.2), scale3(R, 0.2), scale3(tip, 0.2), scale3(U, 0.022), rgb(team.capShade), { taper: 1 }));
    if (team.letter) out.push(glyph(at(0, 0.18, 0.26), unit3(add3(F, scale3(U, 0.5))), unit3(add3(U, scale3(F, -0.5))), 0.16, team.letter, rgb(team.logo)));
  }
  if (player.mask) {
    // A catcher's or umpire's mask: padding round the face behind a frame of bars, and a throat guard.
    out.push(ellipsoid(at(0, -0.06, 0.2), axes, [0.22, 0.27, 0.1], PAD, 'sphere', { finish: 'leather' }));
    const bar = { finish: 'gloss' };
    for (const y of [0.04, -0.07, -0.18, -0.29]) out.push(shape('box', at(0, y, 0.31), scale3(R, 0.17), scale3(U, 0.014), scale3(F, 0.014), MASK, bar));
    for (const x of [-0.17, -0.06, 0.06, 0.17]) out.push(shape('box', at(x, -0.12, 0.3), scale3(R, 0.014), scale3(U, 0.18), scale3(F, 0.014), MASK, bar));
    out.push(shape('box', at(0, -0.36, 0.26), scale3(R, 0.09), scale3(unit3(add3(U, scale3(F, 0.6))), 0.08), scale3(F, 0.012), MASK, bar));
  }
}

/**
 * A fielder's glove on the hand at `at`, its fingers pointing `dir`, its
 * pocket turned towards `toward`: the heel and a deep pocket, four long
 * fingers and a thumb in leather laced at the tips, the web between, and the
 * ball in the pocket if it holds one.
 */
function glove(out, at, dir, toward, holdsBall) {
  const [facing] = across(dir, toward);
  const side = cross3(facing, dir);
  const p = (x, y, z = 0) => add3(at, scale3(side, x), scale3(dir, y), scale3(facing, z));
  const L = { finish: 'leather' };
  out.push(ellipsoid(p(0, 0.08, -0.02), [side, dir, facing], [0.3, 0.34, 0.12], LEATHER, 'sphere', L));
  out.push(ellipsoid(p(0.02, -0.16, -0.02), [side, dir, facing], [0.22, 0.1, 0.1], LEATHER_SHADE, 'sphere', L));
  for (const [x, rot] of [[-0.2, 0.16], [-0.07, 0.05], [0.07, -0.05], [0.19, -0.15]]) {
    const base = p(x, 0.28);
    const tip = add3(base, scale3(unit3(add3(dir, scale3(side, -rot), scale3(facing, 0.12))), 0.4));
    limb(out, base, tip, 0.075, 0.065, LEATHER, facing, L);
    out.push(sphere(add3(tip, scale3(dir, 0.04)), 0.03, LACE, { finish: 'leather', cast: false }));
  }
  limb(out, p(-0.27, -0.02), p(-0.42, 0.32, 0.06), 0.085, 0.07, LEATHER, facing, L);
  out.push(ellipsoid(p(-0.24, 0.38, 0.03), [side, dir, facing], [0.1, 0.16, 0.03], LEATHER_DARK, 'sphere', L));
  for (const k of [0.3, 0.38, 0.46]) out.push(shape('box', p(-0.24, k, 0.06), scale3(side, 0.09), scale3(dir, 0.008), scale3(facing, 0.008), LACE, { cast: false }));
  out.push(ellipsoid(p(0.02, 0.12, 0.08), [side, dir, facing], [0.2, 0.22, 0.06], LEATHER_SHADE, 'sphere', L));
  if (holdsBall) out.push(...baseballShapes(p(0.02, 0.14, 0.17), 0.13, [side, dir, facing]));
}

/** A baseball at `at` (on the field), `r` feet across the middle, plain: for its trail. */
export function ballShape(at, r) {
  return sphere(at, r, BALL, { finish: 'ball' });
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
  const out = [sphere(at, r, BALL, { finish: 'ball' })];
  for (const p of SEAM_POINTS) {
    const dir = add3(scale3(turn[0], p.x), scale3(turn[1], p.y), scale3(turn[2], p.z));
    out.push(sphere(add3(at, scale3(dir, r * 0.985)), r * 0.06, SEAM, { outline: false, cast: false, finish: 'ball' }));
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
  limb(out, a, b, 0.05, 0.11, BAT, UP, { finish: 'wood' });
  return out;
}

// The soft shadow on the ground under a player: feet out to each side and to front and back.
const SHADOW = { across: 1.3, along: 1.0 };

/** Where a joint of a player is on the field (as playerShapes puts it). */
export function jointAt(thing, name) {
  const frame = figureFrame(thing.facing ?? { x: 0, y: -1 });
  const at = thing.at;
  const ground = { x: at.x, y: at.y, z: at.z ?? groundHeight(at.x, at.y) };
  return figurePoint(ground, frame, liftPose(thing.player.pose)[name]);
}

/**
 * How far a figure standing at the origin, facing `facing`, reaches in a view's picture through all of `poses`
 * (the pictures of a run): feet across (the view's right) and up from their feet, each joint padded by `pad` feet
 * for the body round it, and their shadow. What a camera must leave alone around a runner, and no more.
 * @returns {{x0:number, x1:number, y0:number, y1:number}}
 */
export function figureReach(facing, view, poses, pad = 0) {
  const { right, up } = viewAxes(view);
  const out = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  const add = (p, margin) => {
    const x = p.x * right.x + p.y * right.y + p.z * right.z;
    const y = p.x * up.x + p.y * up.y + p.z * up.z;
    out.x0 = Math.min(out.x0, x - margin);
    out.x1 = Math.max(out.x1, x + margin);
    out.y0 = Math.min(out.y0, y - margin);
    out.y1 = Math.max(out.y1, y + margin);
  };
  const at = { x: 0, y: 0, z: 0 };
  for (const pose of poses) {
    const thing = { at, facing, player: { pose } };
    for (const name of Object.keys(liftPose(pose))) add(jointAt(thing, name), pad);
  }
  // Their shadow, on the ground round their feet (as playerShapes draws it for someone running).
  const { right: across, forward } = figureFrame(facing);
  for (const a of [-SHADOW.across, SHADOW.across]) {
    for (const f of [-SHADOW.along, SHADOW.along]) {
      add({ x: across.x * a + forward.x * f, y: across.y * a + forward.y * f, z: 0 }, 0);
    }
  }
  return out;
}
