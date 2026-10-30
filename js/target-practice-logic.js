// Target Practice rules, kept free of the browser so they can be unit-tested:
// scoring a throw, how the game speeds up during a round, and where new
// targets may appear.
//
// Positions are normalised screen coordinates (0–1 across and down). Sizes are
// fractions of the shorter screen side, so targets are round on any screen.

/**
 * @typedef {{x:number, y:number}} Point
 * @typedef {{x0:number, y0:number, x1:number, y1:number}} Rect
 * @typedef {{width:number, height:number}} View screen size in pixels
 * @typedef {{x:number, y:number, r:number}} Target r: radius, fraction of the shorter screen side
 */

export const TARGET_PRACTICE_RULES = {
  roundMs: 60_000,
  // Points for each ring, from the centre out. The rings are equally wide.
  rings: [50, 25, 10],
  // A throw this far outside the outer ring (fraction of the radius) still
  // scores the outer ring: forgiving for small players and camera wobble.
  graceRatio: 0.2,
  // How the round speeds up, from its start to its end.
  maxTargets: { start: 2, end: 3 },
  radius: { start: 0.12, end: 0.08 },
  lifetimeMs: { start: 6000, end: 3500 },
  // Pause before a target replaces one that was hit or timed out.
  respawnMs: { min: 350, max: 900 },
  // Space kept between targets, and between targets and the screen edge (fraction of the shorter side).
  gap: 0.04,
};

/** Distance from a target's centre, in target radii. */
export function distanceInRadii(target, point, view) {
  const unit = target.r * Math.min(view.width, view.height);
  return Math.hypot((point.x - target.x) * view.width, (point.y - target.y) * view.height) / unit;
}

/** Points for a throw at `point`, or 0 if it missed the target. */
export function ringPoints(target, point, view, rules = TARGET_PRACTICE_RULES) {
  const d = distanceInRadii(target, point, view);
  const { rings } = rules;
  if (d > 1 + rules.graceRatio) return 0;
  const ring = Math.min(rings.length - 1, Math.floor(d * rings.length));
  return rings[ring];
}

/**
 * The target a throw hit, if any. When targets are close, the nearest one wins.
 * @template {Target} T
 * @param {T[]} targets
 * @returns {{target: T, points: number}|null}
 */
export function findHit(targets, point, view, rules = TARGET_PRACTICE_RULES) {
  let best = null;
  let bestDistance = Infinity;
  for (const target of targets) {
    const points = ringPoints(target, point, view, rules);
    const d = distanceInRadii(target, point, view);
    if (points > 0 && d < bestDistance) {
      best = { target, points };
      bestDistance = d;
    }
  }
  return best;
}

/**
 * How hard the game is at a point in the round.
 * @param {number} progress 0 at the start of the round, 1 at its end
 */
export function difficulty(progress, rules = TARGET_PRACTICE_RULES) {
  const p = Math.min(1, Math.max(0, progress));
  const lerp = ({ start, end }) => start + (end - start) * p;
  return {
    // One more target joins a third of the way in.
    maxTargets: Math.round(rules.maxTargets.start + (rules.maxTargets.end - rules.maxTargets.start) * Math.min(1, p * 1.5)),
    radius: lerp(rules.radius),
    lifetimeMs: lerp(rules.lifetimeMs),
  };
}

/**
 * A free spot for a new target, away from the screen edges, the other targets
 * and the areas to avoid (score display, buttons). Null if none was found.
 * @param {object} args
 * @param {number} args.radius the new target's radius
 * @param {Target[]} args.targets targets already on screen
 * @param {Rect[]} args.avoid
 * @param {View} args.view
 * @param {() => number} [args.random]
 */
export function pickSpot({ radius, targets, avoid, view, random = Math.random }, rules = TARGET_PRACTICE_RULES) {
  const unit = Math.min(view.width, view.height);
  // Radius plus gap, in fractions of the screen width and height.
  const padX = ((radius + rules.gap) * unit) / view.width;
  const padY = ((radius + rules.gap) * unit) / view.height;
  if (padX >= 0.5 || padY >= 0.5) return null;

  for (let attempt = 0; attempt < 60; attempt++) {
    const spot = {
      x: padX + random() * (1 - 2 * padX),
      y: padY + random() * (1 - 2 * padY),
    };
    const clear = targets.every((t) => {
      const apart = Math.hypot((spot.x - t.x) * view.width, (spot.y - t.y) * view.height) / unit;
      return apart >= radius + t.r + rules.gap;
    }) && avoid.every((a) => spot.x + padX <= a.x0 || spot.x - padX >= a.x1
      || spot.y + padY <= a.y0 || spot.y - padY >= a.y1);
    if (clear) return spot;
  }
  return null;
}
