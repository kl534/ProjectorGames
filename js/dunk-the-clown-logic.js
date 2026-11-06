// Dunk the Clown rules, kept free of the browser so they can be unit-tested:
// where the clowns sit, which clown a throw hit, scoring (bullseyes and
// streaks), and how the round speeds up.
//
// Positions are normalised screen coordinates (0–1 across and down). Sizes are
// fractions of the shorter screen side, so shapes look the same on any screen.

/**
 * @typedef {{x:number, y:number}} Point
 * @typedef {{width:number, height:number}} View screen size in pixels
 * @typedef {{x:number, y:number, r:number}} Seat the bullseye's centre and radius (shorter-side fraction)
 */

export const DUNK_THE_CLOWN_RULES = {
  roundMs: 60_000,
  // Where the clowns' bullseyes are. Each clown sits on a seat above its bullseye,
  // over a tank of water. The seats never move.
  seatXs: [0.14, 0.38, 0.62, 0.86],
  seatY: 0.66,
  radius: 0.1,
  // A throw this far outside the bullseye (fraction of the radius) still counts.
  graceRatio: 0.2,
  // A throw within this fraction of the radius from the centre is a bull.
  bullRatio: 0.35,
  points: { hit: 25, bull: 25, streakStep: 5, streakMax: 5 },
  // How the round speeds up, from its start to its end.
  maxUp: { start: 2, end: 3 },
  upMs: { start: 4200, end: 2200 },
  // Pause before a clown climbs onto a seat that was just emptied.
  respawnMs: { start: [500, 1100], end: [250, 700] },
};

/** Where the clowns' seats are. @returns {Seat[]} */
export function seats(rules = DUNK_THE_CLOWN_RULES) {
  return rules.seatXs.map((x) => ({ x, y: rules.seatY, r: rules.radius }));
}

/** Distance from a bullseye's centre, in radii. */
export function distanceInRadii(seat, point, view) {
  const unit = seat.r * Math.min(view.width, view.height);
  return Math.hypot((point.x - seat.x) * view.width, (point.y - seat.y) * view.height) / unit;
}

/**
 * The clown a throw hit, if any. Only the bullseye counts. When two are close, the nearest wins.
 * @template {Seat} T
 * @param {T[]} clowns clowns that are up
 * @returns {{clown: T, bull: boolean}|null}
 */
export function findHit(clowns, point, view, rules = DUNK_THE_CLOWN_RULES) {
  let best = null;
  let bestDistance = Infinity;
  for (const clown of clowns) {
    const d = distanceInRadii(clown, point, view);
    if (d <= 1 + rules.graceRatio && d < bestDistance) {
      best = { clown, bull: d <= rules.bullRatio };
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Points for a hit.
 * @param {number} streak hits in a row before this one
 * @param {boolean} bull
 */
export function hitPoints(streak, bull, rules = DUNK_THE_CLOWN_RULES) {
  const { hit, bull: bullBonus, streakStep, streakMax } = rules.points;
  return hit + Math.min(streak, streakMax) * streakStep + (bull ? bullBonus : 0);
}

/**
 * How hard the game is at a point in the round.
 * @param {number} progress 0 at the start of the round, 1 at its end
 */
export function difficulty(progress, rules = DUNK_THE_CLOWN_RULES) {
  const p = Math.min(1, Math.max(0, progress));
  const lerp = (a, b) => a + (b - a) * p;
  return {
    // One more clown joins a third of the way in.
    maxUp: Math.round(rules.maxUp.start + (rules.maxUp.end - rules.maxUp.start) * Math.min(1, p * 1.5)),
    upMs: lerp(rules.upMs.start, rules.upMs.end),
    respawnMs: {
      min: lerp(rules.respawnMs.start[0], rules.respawnMs.end[0]),
      max: lerp(rules.respawnMs.start[1], rules.respawnMs.end[1]),
    },
  };
}

/**
 * A seat for the next clown: a random one of those that are empty. Null if none is.
 * @template T
 * @param {T[]} empty
 * @param {() => number} [random]
 * @returns {T|null}
 */
export function pickSeat(empty, random = Math.random) {
  if (empty.length === 0) return null;
  return empty[Math.min(empty.length - 1, Math.floor(random() * empty.length))];
}
