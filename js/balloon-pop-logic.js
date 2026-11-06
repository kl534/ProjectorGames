// Balloon Pop rules, kept free of the browser so they can be unit-tested:
// how balloons move, hitting one, how the game speeds up, and where new
// balloons may rise.
//
// Positions are normalised screen coordinates (0–1 across and down). Sizes are
// fractions of the shorter screen side, so balloons have the same shape on any
// screen.
//
// A balloon rises steadily up its own column from below the screen, swaying
// gently from side to side, and floats away off the top.

/**
 * @typedef {{x:number, y:number}} Point
 * @typedef {{x0:number, y0:number, x1:number, y1:number}} Rect
 * @typedef {{width:number, height:number}} View screen size in pixels
 * @typedef {{x:number, y:number, r:number}} Balloon x, y: centre of the body;
 *   r: half its width, fraction of the shorter screen side
 * @typedef {object} Flight how a balloon moves
 * @property {number} x0 centre of its column
 * @property {number} y0 height at time t0
 * @property {number} t0 ms
 * @property {number} speed screen heights per ms, upwards
 * @property {number} phase where in its sway it started (radians)
 */

export const BALLOON_POP_RULES = {
  // Balloons that may float away before the game ends.
  lives: 5,
  points: { normal: 10, gold: 30 },
  // Chance that a new balloon is a gold one: worth more, but it rises faster.
  goldChance: 0.12,
  goldSpeedRatio: 1.5,
  // Body height / width.
  aspect: 1.2,
  // A throw this far outside the balloon (fraction of its size) still pops it:
  // forgiving for small players and camera wobble.
  graceRatio: 0.25,
  // Sideways sway: how far either side of its column (fraction of the shorter
  // side), and how long one sway there and back takes.
  sway: 0.015,
  swayMs: 4000,
  // How the game speeds up, from the start until `rampMs` into the game.
  rampMs: 120_000,
  maxBalloons: { start: 2, end: 5 },
  radius: { start: 0.1, end: 0.075 },
  // Time for a balloon to rise the height of the screen.
  riseMs: { start: 9000, end: 5000 },
  // Pause before a balloon replaces one that was popped or got away.
  spawnMs: { min: 400, max: 1200 },
  // Space kept between balloon columns, and between balloons and the screen
  // edge (fraction of the shorter side).
  gap: 0.03,
  // Score displays and buttons above this height may overlap the balloons'
  // columns: balloons only pass behind them on their way out.
  topClear: 0.15,
};

/** Where a balloon is at `time` (normalised screen coordinates). */
export function positionAt(flight, time, view, rules = BALLOON_POP_RULES) {
  const unit = Math.min(view.width, view.height);
  const elapsed = time - flight.t0;
  return {
    x: flight.x0 + ((rules.sway * unit) / view.width) * Math.sin(flight.phase + (2 * Math.PI * elapsed) / rules.swayMs),
    y: flight.y0 - flight.speed * elapsed,
  };
}

/** Distance from a balloon's centre, in balloon sizes (1 = on its outline). */
export function distanceInSizes(balloon, point, view, rules = BALLOON_POP_RULES) {
  const unit = balloon.r * Math.min(view.width, view.height);
  const dx = ((point.x - balloon.x) * view.width) / unit;
  const dy = ((point.y - balloon.y) * view.height) / (unit * rules.aspect);
  return Math.hypot(dx, dy);
}

/** Did a throw at `point` pop this balloon? */
export function isHit(balloon, point, view, rules = BALLOON_POP_RULES) {
  return distanceInSizes(balloon, point, view, rules) <= 1 + rules.graceRatio;
}

/**
 * The balloon a throw popped, if any. When balloons are close, the nearest one wins.
 * @template {Balloon} B
 * @param {B[]} balloons
 * @returns {B|null}
 */
export function findHit(balloons, point, view, rules = BALLOON_POP_RULES) {
  let best = null;
  let bestDistance = Infinity;
  for (const balloon of balloons) {
    const d = distanceInSizes(balloon, point, view, rules);
    if (d <= 1 + rules.graceRatio && d < bestDistance) {
      best = balloon;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * How hard the game is after playing for `elapsedMs`.
 * @returns {{maxBalloons: number, radius: number, riseMs: number}}
 */
export function difficulty(elapsedMs, rules = BALLOON_POP_RULES) {
  const p = Math.min(1, Math.max(0, elapsedMs / rules.rampMs));
  const lerp = ({ start, end }) => start + (end - start) * p;
  return {
    // Balloons join at even steps; the last one when the ramp is three quarters done.
    maxBalloons: rules.maxBalloons.start
      + Math.floor((rules.maxBalloons.end - rules.maxBalloons.start) * Math.min(1, p / 0.75)),
    radius: lerp(rules.radius),
    riseMs: lerp(rules.riseMs),
  };
}

/**
 * The area a balloon covers on its way up, swaying (from below the screen to
 * `topClear`), in normalised screen coordinates.
 */
export function pathRect(x, radius, view, rules = BALLOON_POP_RULES) {
  const unit = Math.min(view.width, view.height);
  const halfWidth = ((radius + rules.sway) * unit) / view.width;
  return { x0: x - halfWidth, y0: rules.topClear, x1: x + halfWidth, y1: 1 };
}

/**
 * A free column for a new balloon: inside the screen, away from the other
 * balloons' columns (so balloons never bump into each other, even swaying)
 * and from the areas to avoid (camera view, buttons). Returns its x, or null
 * if none was found.
 * @param {object} args
 * @param {number} args.radius the new balloon's radius
 * @param {Balloon[]} args.balloons balloons already on screen (x: their column)
 * @param {Rect[]} args.avoid
 * @param {View} args.view
 * @param {() => number} [args.random]
 */
export function pickColumn({ radius, balloons, avoid, view, random = Math.random }, rules = BALLOON_POP_RULES) {
  const unit = Math.min(view.width, view.height);
  const padX = ((radius + rules.sway + rules.gap) * unit) / view.width;
  if (padX >= 0.5) return null;

  for (let attempt = 0; attempt < 60; attempt++) {
    const x = padX + random() * (1 - 2 * padX);
    const clear = balloons.every((b) => (Math.abs(x - b.x) * view.width) / unit >= radius + b.r + 2 * rules.sway + rules.gap);
    if (!clear) continue;
    const path = pathRect(x, radius + rules.gap, view, rules);
    if (avoid.every((a) => path.x1 <= a.x0 || path.x0 >= a.x1 || path.y1 <= a.y0 || path.y0 >= a.y1)) return x;
  }
  return null;
}
