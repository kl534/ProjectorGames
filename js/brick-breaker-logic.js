// Brick Breaker rules, kept free of the browser so they can be unit-tested:
// the walls, where each brick is, which brick a throw hits, damage, cracks,
// explosions, and points.
//
// Positions are normalised screen coordinates (0–1 across and down). The
// mortar gap between bricks is a fraction of the shorter screen side, so it
// looks the same on any screen.
//
// A wall is a grid of bricks. A throw smashes the brick nearest where it
// landed and cracks the four bricks touching that one. Broken bricks score;
// explosive bricks blow up their neighbours.

/**
 * @typedef {{x:number, y:number}} Point
 * @typedef {{x0:number, y0:number, x1:number, y1:number}} Rect
 * @typedef {{width:number, height:number}} View screen size in pixels
 * @typedef {'normal'|'tough'|'explosive'|'gold'} Kind
 * @typedef {object} Brick
 * @property {number} id
 * @property {number} row 0 is the top row
 * @property {number} col 0 is the left column
 * @property {Kind} kind
 * @property {number} hp what it has left. At 0 or below, it breaks.
 * @property {number} maxHp what it started with, so the damage taken is `maxHp - hp`
 * @typedef {object} Level
 * @property {number} n
 * @property {string} name
 * @property {number} timeMs
 * @property {string[]} rows the wall, one string per row: . empty, b normal,
 *   t tough, x explosive, g gold
 * @property {number} toughHp
 * @typedef {object} Result what a hit or an explosion did. Bricks are not
 *   removed from the list: the game does that for the ones in `broken`.
 * @property {{brick: Brick, cracks: number}[]} cracked bricks damaged but still standing
 * @property {Brick[]} broken
 * @property {Brick[]} explosions the explosive bricks among `broken`: they blow up too
 */

export const BRICK_BREAKER_RULES = {
  // The wall area: x from `left` to `right`, rows of `rowHeight` from `top` down
  // (fractions of the screen). Seven rows end at 0.654, leaving the lower third
  // free for falling pieces and for aiming. The score and buttons sit above `top`.
  columns: 10,
  maxRows: 7,
  left: 0.05,
  right: 0.95,
  top: 0.15,
  rowHeight: 0.072,
  // Each brick is its cell less this gap on every side (fraction of the shorter side).
  mortar: 0.006,
  // Damage dealt to the brick a throw hits…
  directDamage: 2,
  // …to each of the four bricks next to it (up, down, left, right)…
  splashDamage: 1,
  // …and by an explosion to the eight bricks around it.
  explosionDamage: 2,
  // Hit points to start with. Tough bricks take two direct hits, or three once the walls repeat.
  hp: { normal: 2, tough: 4, explosive: 2, gold: 2 },
  repeatToughHp: 6,
  // An explosive brick blows up this long after it breaks, so chains can be seen.
  explodeDelayMs: 150,
  // Points for breaking a brick. Cracking one scores nothing.
  points: { normal: 10, tough: 30, explosive: 20, gold: 100 },
  // Clearing a wall: points for each second left on the clock.
  timeBonusPerSecond: 10,
  // A throw this far from the nearest brick (fraction of a brick's height) still hits it:
  // forgiving for small players and camera wobble.
  graceRatio: 0.6,
  // After the six designed walls they repeat. Each time round, there is less
  // time (but never less than `minTimeMs`) and more normal bricks turn tough.
  repeatTimeRatio: 0.85,
  minTimeMs: 35_000,
  repeatToughChance: 0.15,
  maxToughChance: 0.5,
};

/**
 * The six designed walls. Rows are written the way they look:
 * . empty, b normal, t tough, x explosive (blows up its neighbours), g gold.
 */
export const LEVELS = [
  {
    name: 'Warm-up',
    timeMs: 75_000,
    rows: ['bbbbbbbbbb', 'bbbbbbbbbb', 'bbbbxbbbbb', 'bbbbbbbbbb'],
  },
  {
    name: 'Pyramid',
    timeMs: 75_000,
    rows: ['....bb....', '...bbbb...', '..bbxxbb..', '.bbbbbbbb.', 'tbbbbbbbbt'],
  },
  {
    name: 'Heart',
    timeMs: 80_000,
    rows: ['.bb....bb.', 'bbbb..bbbb', 'bbbbbbbbbb', '.bbbgbbbb.', '..bbbbbb..', '...bbbb...', '....bb....'],
  },
  {
    name: 'Checkerboard',
    timeMs: 80_000,
    rows: ['tbtbtbtbtb', 'btbtbxbtbt', 'tbtbtbtbtb', 'btbtbtbtbt'],
  },
  {
    name: 'Fortress',
    timeMs: 85_000,
    rows: ['t.t.tt.t.t', 'tttttttttt', 'tbbxbbxbbt', 'tbbbggbbbt', 'tttttttttt'],
  },
  {
    name: 'Fireworks',
    timeMs: 85_000,
    rows: ['x.b.x.b.x.', '.bbbbbbbb.', 'bbxbbbbxbb', '.bbbbbbbb.', 'b.x.bb.x.b'],
  },
];

const KINDS = { b: 'normal', t: 'tough', x: 'explosive', g: 'gold' };

/** A repeatable stream of numbers from 0 up to (not including) 1, for a given seed. */
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The wall for level `n` (1 is the first). Past the sixth level the designed
 * walls repeat: with less time, tougher bricks, and some normal bricks
 * swapped for tough ones. Which ones is decided by `n` alone, so the same
 * level is always the same wall.
 * @returns {Level}
 */
export function levelFor(n, rules = BRICK_BREAKER_RULES) {
  n = Math.max(1, Math.floor(n));
  const base = LEVELS[(n - 1) % LEVELS.length];
  const cycle = Math.floor((n - 1) / LEVELS.length);
  if (cycle === 0) return { n, name: base.name, timeMs: base.timeMs, rows: [...base.rows], toughHp: rules.hp.tough };

  const chance = Math.min(rules.maxToughChance, rules.repeatToughChance * cycle);
  const random = seededRandom(n);
  return {
    n,
    name: base.name,
    timeMs: Math.max(rules.minTimeMs, Math.round(base.timeMs * rules.repeatTimeRatio ** cycle)),
    rows: base.rows.map((row) => [...row].map((c) => (c === 'b' && random() < chance ? 't' : c)).join('')),
    toughHp: rules.repeatToughHp,
  };
}

/**
 * The bricks of a level, row by row from the top left. Ids are unique.
 * @returns {Brick[]}
 */
export function buildWall(level, rules = BRICK_BREAKER_RULES) {
  const bricks = [];
  level.rows.forEach((pattern, row) => {
    [...pattern].forEach((c, col) => {
      const kind = KINDS[c];
      if (!kind) return;
      const hp = kind === 'tough' ? level.toughHp : rules.hp[kind];
      bricks.push({ id: row * rules.columns + col, row, col, kind, hp, maxHp: hp });
    });
  });
  return bricks;
}

/** The area a wall of `rowCount` rows covers (its bricks and the mortar between them). */
export function wallArea(rowCount, rules = BRICK_BREAKER_RULES) {
  return { x0: rules.left, y0: rules.top, x1: rules.right, y1: rules.top + rowCount * rules.rowHeight };
}

/** The area of one grid cell, mortar included. */
export function cellRect(row, col, rules = BRICK_BREAKER_RULES) {
  const width = (rules.right - rules.left) / rules.columns;
  return {
    x0: rules.left + col * width,
    y0: rules.top + row * rules.rowHeight,
    x1: rules.left + (col + 1) * width,
    y1: rules.top + (row + 1) * rules.rowHeight,
  };
}

/** Where a brick is drawn: its cell, less the mortar gap on every side. */
export function brickRect(brick, view, rules = BRICK_BREAKER_RULES) {
  const cell = cellRect(brick.row, brick.col, rules);
  const gap = rules.mortar * Math.min(view.width, view.height);
  const gx = gap / view.width;
  const gy = gap / view.height;
  return { x0: cell.x0 + gx, y0: cell.y0 + gy, x1: cell.x1 - gx, y1: cell.y1 - gy };
}

/** How far `point` is from a rectangle, in pixels (0 when inside). */
export function distanceToRect(rect, point, view) {
  const dx = Math.max(rect.x0 - point.x, 0, point.x - rect.x1) * view.width;
  const dy = Math.max(rect.y0 - point.y, 0, point.y - rect.y1) * view.height;
  return Math.hypot(dx, dy);
}

/**
 * Is `point` on a rectangle, or close enough to count? As close as a throw may
 * be to a brick, in terms of the rectangle's height.
 */
export function isNear(rect, point, view, rules = BRICK_BREAKER_RULES) {
  return distanceToRect(rect, point, view) <= rules.graceRatio * (rect.y1 - rect.y0) * view.height;
}

/**
 * The brick a throw hits: the nearest one, if it is close enough. Throws into
 * the mortar between bricks hit the nearest brick. Bricks equally near: the first.
 * @template {Brick} B
 * @param {B[]} bricks
 * @returns {B|null}
 */
export function findTarget(bricks, point, view, rules = BRICK_BREAKER_RULES) {
  let best = null;
  let bestDistance = Infinity;
  for (const brick of bricks) {
    const d = distanceToRect(brickRect(brick, view, rules), point, view);
    if (d < bestDistance) {
      best = brick;
      bestDistance = d;
    }
  }
  if (!best) return null;
  const rect = brickRect(best, view, rules);
  return isNear(rect, point, view, rules) ? best : null;
}

/** Takes `amount` of damage off a brick, and says in `result` what became of it. */
function damage(brick, amount, result) {
  if (brick.hp <= 0) return;
  brick.hp -= amount;
  if (brick.hp > 0) {
    result.cracked.push({ brick, cracks: brick.maxHp - brick.hp });
  } else {
    result.broken.push(brick);
    if (brick.kind === 'explosive') result.explosions.push(brick);
  }
}

/** The bricks at these offsets from a brick's cell. */
function around(bricks, brick, offsets) {
  return offsets.map(([dr, dc]) => bricks.find((b) => b.row === brick.row + dr && b.col === brick.col + dc)).filter(Boolean);
}

const NEXT_TO = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const ALL_AROUND = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

/**
 * A throw hit `target`: it takes the direct damage and the four bricks next to
 * it take the splash. Changes the bricks' `hp`.
 * @param {Brick[]} bricks the bricks still standing
 * @returns {Result}
 */
export function resolveHit(bricks, target, rules = BRICK_BREAKER_RULES) {
  const result = { cracked: [], broken: [], explosions: [] };
  damage(target, rules.directDamage, result);
  for (const brick of around(bricks, target, NEXT_TO)) damage(brick, rules.splashDamage, result);
  return result;
}

/**
 * An explosive brick blows up: the eight bricks around it take the explosion
 * damage. Changes their `hp`. The explosive itself is no longer in `bricks`.
 * Bricks it breaks don't splash.
 * @param {Brick[]} bricks the bricks still standing
 * @returns {Result}
 */
export function explode(bricks, explosive, rules = BRICK_BREAKER_RULES) {
  const result = { cracked: [], broken: [], explosions: [] };
  for (const brick of around(bricks, explosive, ALL_AROUND)) damage(brick, rules.explosionDamage, result);
  return result;
}

/** Points for breaking a brick. */
export function pointsFor(brick, rules = BRICK_BREAKER_RULES) {
  return rules.points[brick.kind];
}

/**
 * Points for clearing a wall with `msLeft` on the clock: for each second the
 * clock shows (it rounds up, so 12.3 s left shows 13).
 */
export function timeBonus(msLeft, rules = BRICK_BREAKER_RULES) {
  return Math.ceil(Math.max(0, msLeft) / 1000) * rules.timeBonusPerSecond;
}
