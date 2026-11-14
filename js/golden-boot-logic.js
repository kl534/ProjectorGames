// Golden Boot rules, kept free of the browser so they can be unit-tested: where
// a ball that hit the screen went on the plane of the goal, what the goalposts
// and crossbar do to it, whether the keeper can get to it, and how the keeper
// gets better.
//
// Positions on the goal are in metres, on the plane of the goal mouth: x across
// (0 in the middle, + to the right as the kicker sees it) and y up from the
// grass. The goal is the real size, 7.32 m wide inside the posts and 2.44 m high
// inside the bar. Screen positions are turned into these by the camera in
// golden-boot-models.js (`shotPoint`). A ball that comes down on the grass in
// front of the goal bounces and carries on to the goal line (`bounceShot`).
//
// Every number that sets how hard the keeper is, or how forgiving the posts are,
// is in GOLDEN_BOOT_RULES.

/**
 * @typedef {{x:number, y:number}} Point
 * @typedef {{x:number, y:number, land?: {x:number, z:number}|null}} Shot where the ball hit the plane of the goal (metres),
 *   and, for one below the grass, where it came down on it (`z` metres out from the goal line; see `groundPoint`)
 * @typedef {{reach:number, up:number, down:number, speed:number}} KeeperLevel how the keeper can move
 * @typedef {'wide'|'over'|'short'|'post'|'bar'} Miss
 * @typedef {'catch'|'parry'|'tip'} SaveKind
 * @typedef {object} ShotResult
 * @property {'goal'|'saved'|'miss'} kind
 * @property {Miss|null} miss why it missed (a miss only)
 * @property {SaveKind|null} save how it was saved (a save only)
 * @property {'post'|'bar'|null} wood woodwork the ball hit (a miss off it, or a shot that went in off it)
 * @property {Point} shot where the ball reached the plane of the goal (after its bounce, for one that bounced)
 * @property {{x:number, z:number}|null} bounce where it bounced on the grass in front of the goal, or null
 * @property {number} flightMs how long it took to reach the goal (a bounce slows it)
 * @property {Point} point where it crosses the goal line, after the woodwork has had its say
 * @property {number} metric how far the keeper had to go: 1 is the edge of his reach
 * @property {number} chance how likely the keeper was to save it (0–1)
 * @property {Point|null} dive where the keeper goes, or null if he stays put
 * @property {number} level the keeper's level when the ball was hit
 */

export const GOLDEN_BOOT_RULES = {
  kicks: 10,
  // The penalty spot is this far from the goal line (the camera sits behind it).
  spotDistance: 11,
  ballRadius: 0.11,
  goal: {
    halfWidth: 3.66, // half the distance between the posts, measured inside them
    height: 2.44, // the ground to the underside of the bar
    post: 0.12, // posts and bar are this thick
    // A ball this much beyond the woodwork still hits it.
    grace: 0.06,
    // A ball this far below the grass (the screen shows the pitch in front of the goal) came down on it in
    // front of the goal and bounces (see `bounce`); less far, it is a ball along the grass.
    groundSlack: 0.4,
  },
  // A ball that comes down on the grass in front of the goal bounces up and carries on to the goal line, across it
  // where the screen showed (the point of the plane of the goal behind the spot it hit). It crosses the goal line `rise` m up if it came down `over` m or more out, lower nearer the line, and it
  // loses pace: it takes `slower` times as long to get there, which gives the keeper longer. One that comes down
  // within `minCarry` m of the spot (or behind it) dribbles away: short.
  bounce: { rise: 0.55, over: 4, slower: 1.25, minCarry: 2 },
  // The ball takes this long to reach the goal when it is kicked at the average speed of the kicks measured so
  // far (and when its speed isn't measured at all)…
  flightMs: 600,
  // …and a faster or slower kick takes less or more in proportion to its speed, but never less or more than this (ms).
  flightLimits: { min: 300, max: 1000 },
  // The average is over the last this many measured kicks.
  averageKicks: 20,
  keeper: {
    // Standing, his hands are about here (m up from the grass); his reach is measured from it.
    centre: 1.0,
    reactionMs: 150,
    // How far he reaches without moving his feet (m).
    grab: 0.8,
    // A shot at his body (this far either side of the middle, this high) is always saved.
    body: { halfWidth: 0.55, top: 1.95 },
    // Reach is a distance on an ellipse (see `reachMetric`). This close to the edge of it
    // (either side of 1), a save is a matter of chance: a fingertip or a goal.
    band: 0.1,
    // Within this, he catches it; further out, he parries it.
    catchBelow: 0.5,
    // A save this high (m) that he can't catch is tipped over the bar.
    tipAbove: 1.9,
    startLevel: 0,
    // From easy to the cap (the last). `reach`: how far to either side he can get (m),
    // `up` and `down`: how far above and below `centre` (m), `speed`: his dive (m a second).
    // He gets as far as the smaller of `reach` and what his speed carries him in the time
    // the ball takes. At the cap he still cannot reach a well-placed top corner.
    levels: [
      { reach: 1.9, up: 0.75, down: 1.1, speed: 2.4 },
      { reach: 2.2, up: 0.85, down: 1.15, speed: 3.0 },
      { reach: 2.5, up: 1.0, down: 1.2, speed: 3.8 },
      { reach: 2.8, up: 1.1, down: 1.25, speed: 4.6 },
      { reach: 3.1, up: 1.2, down: 1.3, speed: 5.4 },
      { reach: 3.4, up: 1.35, down: 1.35, speed: 6.4 },
    ],
  },
};

/** The highest level the keeper reaches. */
export function topLevel(rules = GOLDEN_BOOT_RULES) {
  return rules.keeper.levels.length - 1;
}

/**
 * The keeper's level after a kick: one better after each goal, up to the cap.
 * Saves and misses leave it as it was: it never eases back.
 * @param {number} level
 * @param {'goal'|'saved'|'miss'} kind
 */
export function nextLevel(level, kind, rules = GOLDEN_BOOT_RULES) {
  return kind === 'goal' ? Math.min(topLevel(rules), level + 1) : level;
}

// ---- The posts and the bar ----

/**
 * How a value across the goal's width (or up its height) sits against the woodwork
 * there: inside it, on its inner half, on its outer half, or beyond it.
 * @param {number} v distance from the middle (across) or from the grass (up)
 * @param {number} inner where the inner edge of the woodwork is
 */
function against(v, inner, { post, grace }) {
  if (v < inner - grace) return 'in';
  if (v < inner + post / 2) return 'wood-in';
  if (v <= inner + post + grace) return 'wood-out';
  return 'out';
}

/**
 * Where a ball that hit the plane of the goal went: in the frame, off the woodwork, or
 * missed. A ball on the inner half of a post or the bar goes in off it, and counts as a
 * shot at the inner edge (`point`), which the keeper may still save. On the outer half
 * it goes out.
 * @param {Point} shot metres
 * @returns {{point: Point, wood: 'post'|'bar'|null, miss: Miss|null}}
 */
export function classifyShot(shot, rules = GOLDEN_BOOT_RULES) {
  const { goal, ballRadius } = rules;
  const across = Math.abs(shot.x);
  const side = shot.x < 0 ? -1 : 1;
  const sx = against(across, goal.halfWidth, goal);
  const sy = shot.y < 0 ? (shot.y < -goal.groundSlack ? 'short' : 'in') : against(shot.y, goal.height, goal);
  const none = (miss, wood = null) => ({ point: shot, wood, miss });

  if (sx === 'out' && sy === 'out') {
    const beyondX = across - (goal.halfWidth + goal.post + goal.grace);
    const beyondY = shot.y - (goal.height + goal.post + goal.grace);
    return none(beyondX >= beyondY ? 'wide' : 'over');
  }
  if (sx === 'out') return none('wide');
  if (sy === 'out') return none('over');
  if (sy === 'short') return none('short');
  if (sx === 'wood-out') return none('post', 'post');
  if (sy === 'wood-out') return none('bar', 'bar');

  let { x, y } = shot;
  let wood = null;
  if (sx === 'wood-in') {
    x = side * (goal.halfWidth - ballRadius);
    wood = 'post';
  }
  if (sy === 'wood-in') {
    y = goal.height - ballRadius;
    wood ??= 'bar';
  }
  // A low shot along the grass is a ball's radius up.
  y = Math.max(y, ballRadius);
  return { point: { x, y }, wood, miss: null };
}

/**
 * Where a ball that came down on the grass in front of the goal crosses the goal line, after bouncing: as far
 * across as the point of the plane of the goal it lined up with on the screen (so one under the goal mouth goes
 * in, and one under the side netting or further out is wide), a little way up. Null if it isn't such a ball: above the
 * grass, just under it (a ball along the grass, see `classifyShot`), with no landing place, or one that
 * came down too near the spot to carry to the goal (short).
 * @param {Shot} shot
 * @returns {Point|null}
 */
export function bounceShot(shot, rules = GOLDEN_BOOT_RULES) {
  const { goal, ballRadius, spotDistance, bounce } = rules;
  const land = shot.land;
  if (!(shot.y < -goal.groundSlack) || !land) return null;
  const carry = spotDistance - land.z;
  if (!(carry >= bounce.minCarry) || land.z < 0) return null;
  return {
    x: shot.x,
    y: ballRadius + (bounce.rise - ballRadius) * Math.min(1, land.z / bounce.over),
  };
}

// ---- The keeper ----

/**
 * How far to either side, up and down the keeper can get in the time the ball takes (`flightMs`).
 * @returns {{reach: number, up: number, down: number}}
 */
export function keeperReach(level, rules = GOLDEN_BOOT_RULES, flightMs = rules.flightMs) {
  const { levels, grab, reactionMs } = rules.keeper;
  const l = levels[Math.min(levels.length - 1, Math.max(0, level))];
  const moving = Math.max(0, flightMs - reactionMs) / 1000;
  return { reach: Math.min(l.reach, grab + l.speed * moving), up: l.up, down: l.down };
}

/** The keeper's speed (m a second) at a level. */
export function keeperSpeed(level, rules = GOLDEN_BOOT_RULES) {
  const { levels } = rules.keeper;
  return levels[Math.min(levels.length - 1, Math.max(0, level))].speed;
}

/** Is the ball coming straight at his body? */
export function atBody(point, rules = GOLDEN_BOOT_RULES) {
  const { body } = rules.keeper;
  return Math.abs(point.x) <= body.halfWidth && point.y <= body.top;
}

/**
 * How far the keeper has to go for a shot: 0 at his hands, 1 at the edge of his reach,
 * more beyond it. His reach is an ellipse, wide and short: the posts, the bar and above all
 * the top corners are the hardest places. A shot at his body is 0 whatever the level.
 * @param {Point} point on the goal line
 * @param {number} level
 * @param {object} [rules]
 * @param {number} [flightMs] how long the ball takes to get there
 */
export function reachMetric(point, level, rules = GOLDEN_BOOT_RULES, flightMs = rules.flightMs) {
  if (atBody(point, rules)) return 0;
  const { reach, up, down } = keeperReach(level, rules, flightMs);
  const dy = point.y - rules.keeper.centre;
  return Math.hypot(point.x / reach, dy / (dy >= 0 ? up : down));
}

/** How likely a save is for a metric: certain well inside his reach, impossible well outside, a chance between. */
export function saveChance(metric, rules = GOLDEN_BOOT_RULES) {
  const { band } = rules.keeper;
  if (metric <= 1 - band) return 1;
  if (metric >= 1 + band) return 0;
  return (1 + band - metric) / (2 * band);
}

/** How a save is made: a catch near his body, a tip over the bar for a high one, a parry otherwise. */
export function saveKind(point, metric, rules = GOLDEN_BOOT_RULES) {
  const { catchBelow, tipAbove } = rules.keeper;
  if (metric <= catchBelow) return 'catch';
  return point.y > tipAbove ? 'tip' : 'parry';
}

/**
 * Where the keeper goes for a shot: at the ball if he can reach it, otherwise as far as he
 * can along the way (the edge of his reach).
 * @returns {Point}
 */
export function diveTarget(point, metric, rules = GOLDEN_BOOT_RULES) {
  const centre = rules.keeper.centre;
  if (metric <= 1) return point;
  return { x: point.x / metric, y: centre + (point.y - centre) / metric };
}

// ---- How fast it was kicked ----

/** The mean of the speeds learned so far, or null if there are none. */
export function averageSpeed(speeds) {
  return speeds.length ? speeds.reduce((sum, v) => sum + v, 0) / speeds.length : null;
}

/**
 * The speeds learned so far with one more measured kick. Only the last `averageKicks` are kept; a speed
 * that isn't a positive number (a kick whose speed wasn't measured) changes nothing.
 * @param {number[]} speeds oldest first (screen widths a second)
 * @param {number|null|undefined} speed
 */
export function learnSpeed(speeds, speed, rules = GOLDEN_BOOT_RULES) {
  if (!(Number.isFinite(speed) && speed > 0)) return speeds;
  return [...speeds, speed].slice(-rules.averageKicks);
}

/**
 * How long a kick takes to reach the goal (ms): `flightMs` at the average speed of the kicks learned so
 * far, in proportion to it otherwise (twice as fast, half the time), and between the limits. A kick
 * with no measured speed takes `flightMs`; so does the first measured one, as there is no average yet
 * to compare it with.
 * @param {number|null|undefined} speed screen widths a second
 * @param {number[]} speeds those learned before this kick
 */
export function flightMsFor(speed, speeds, rules = GOLDEN_BOOT_RULES) {
  if (!(Number.isFinite(speed) && speed > 0)) return rules.flightMs;
  const average = averageSpeed(speeds) ?? speed;
  const { min, max } = rules.flightLimits;
  return Math.min(max, Math.max(min, (rules.flightMs * average) / speed));
}

// ---- A kick ----

// Beaten, the keeper's hands are at least this far short of the ball (as a share of the way there).
const FALLS_SHORT = 1.12;

/** The nearest place just inside the frame to a shot that hit the woodwork. */
function innerEdge(shot, rules) {
  const { goal, ballRadius } = rules;
  const side = shot.x < 0 ? -1 : 1;
  const x = Math.min(Math.abs(shot.x), goal.halfWidth - ballRadius) * side;
  const y = Math.max(ballRadius, Math.min(shot.y, goal.height - ballRadius));
  return { x, y };
}

/**
 * What happens to a ball that hit the plane of the goal. One that came down on the grass in front of it
 * bounces on to the goal line (`bounceShot`), more slowly, and is a shot where it crosses: wide, off the
 * post, in, or saved, like any other.
 * @param {Shot} shot metres (see `shotPoint` and `groundPoint` in golden-boot-models.js)
 * @param {number} level the keeper's level
 * @param {() => number} random 0 up to (not including) 1: decides the chance saves
 * @param {object} [rules]
 * @param {number} [flightMs] how long the ball takes to get there (see `flightMsFor`): a quicker ball gives the keeper less time
 * @returns {ShotResult}
 */
export function decideShot(shot, level, random = Math.random, rules = GOLDEN_BOOT_RULES, flightMs = rules.flightMs) {
  const crossing = bounceShot(shot, rules);
  const bounce = crossing ? { x: shot.land.x, z: shot.land.z } : null;
  if (crossing) {
    shot = crossing;
    flightMs *= rules.bounce.slower;
  } else {
    shot = { x: shot.x, y: shot.y };
  }
  const { point, wood, miss } = classifyShot(shot, rules);
  const base = {
    miss, save: null, wood, shot, point, bounce, flightMs, metric: Infinity, chance: 0, dive: null, level,
  };
  if (miss) {
    // Off the woodwork, he dives for it anyway; a ball that is plainly wide or over, he lets go.
    if (wood) {
      const inner = innerEdge(shot, rules);
      const metric = reachMetric(inner, level, rules, flightMs);
      return { ...base, kind: 'miss', metric, dive: diveTarget(inner, metric, rules) };
    }
    return { ...base, kind: 'miss' };
  }
  const metric = reachMetric(point, level, rules, flightMs);
  const chance = saveChance(metric, rules);
  const saved = random() < chance;
  return {
    ...base,
    kind: saved ? 'saved' : 'goal',
    save: saved ? saveKind(point, metric, rules) : null,
    metric,
    chance,
    // He gets to a save; a goal beats him, and he falls a little short even of a fingertip one.
    dive: diveTarget(point, saved ? Math.min(metric, 1) : Math.max(metric, FALLS_SHORT), rules),
  };
}

/** The big word for a result. */
export function resultWord(result) {
  if (result.kind === 'goal') return 'GOAL!';
  if (result.kind === 'saved') return 'SAVED!';
  return {
    wide: 'WIDE!', over: 'OVER!', short: 'SHORT!', post: 'OFF THE POST!', bar: 'OFF THE BAR!',
  }[result.miss];
}

/** Goals in a list of results ('goal', 'saved' or 'miss' each). */
export function goalsIn(results) {
  return results.filter((kind) => kind === 'goal').length;
}

/** A start target is hit when a throw lands within its radius (plus a little). */
export function onTarget(target, point, view, grace = 0.2) {
  const unit = target.r * Math.min(view.width, view.height);
  return Math.hypot((point.x - target.x) * view.width, (point.y - target.y) * view.height) / unit <= 1 + grace;
}
