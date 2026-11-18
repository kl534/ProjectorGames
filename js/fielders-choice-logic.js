// Fielder's Choice rules, kept free of the browser so they can be unit-tested:
// the field and where each fielder stands, which throw each batter calls for,
// what happens to the runners when the throw is in time or not, the innings,
// and the fielder's-eye view (a simple pinhole camera) that lines the throw up.
//
// Field positions are in feet: home plate at the origin, +y out to centre
// field, +x towards first base, z up. Screen positions are normalised (0–1
// across and down); `aspect` is the screen's width over its height.

/**
 * @typedef {{x:number, y:number}} Point
 * @typedef {{x:number, y:number, z:number}} Point3
 * @typedef {{x0:number, y0:number, x1:number, y1:number}} Rect
 * @typedef {'first'|'second'|'third'|'home'} Base
 * @typedef {{first:boolean, second:boolean, third:boolean}} Bases which bases have a runner on
 */

export const FIELDERS_CHOICE_RULES = {
  inningsChoices: [1, 3, 9],
  outsPerInning: 3,
  // An inning also ends once this many runs have scored in it, so a run of
  // missed throws can't go on for ever.
  mercyRuns: 10,
  // How long the runner takes to reach the base once the view has turned to
  // it (and the camera has settled, `SETTLE_MS`, which counts too): a little
  // longer for a longer throw. Every play leaves about two seconds to throw.
  // On a base hit to the outfield it is always `hit`.
  runnerMs: { base: 800, perFoot: 3, hit: 1100 },
  // The view zooms (like a TV camera) so that the covering fielder stands
  // this tall on screen (fraction of the screen height), feet here. It zooms
  // in only as far as for a throw of `zoomUpTo` feet (a base path): on a
  // longer throw the fielder is smaller, and so is what they can reach, so the
  // throw has to be better. Second to first is full size; third to first, and
  // more so from the outfield, is smaller.
  fielderHeight: 6, // feet
  fielderOnScreen: 0.28,
  zoomUpTo: 90,
  feetAt: { x: 0.5, y: 0.8 },
  // What the covering fielder can reach, in feet: either side of their feet,
  // above the ground, and a short hop in front of them. A throw anywhere in it
  // is caught.
  reach: { side: 5.5, up: 8.5, down: 0.8 },
  // The batter's size on screen while the pitch comes in, the same way.
  batterOnScreen: 0.16,
  eyeHeight: 5.2,
  // How far either side of their usual spot a fielder gets to the ball.
  spread: { infield: 14, dinker: 9 },
  // A base hit goes into the gap: this many feet from the outfielder's spot,
  // towards centre for the corner outfielders, either way for centre, so they
  // run a little to get to it.
  gap: { min: 20, max: 42 },
  // Covering fielders stand this far beyond their base, as the thrower sees
  // it, so the bag shows at their feet.
  coverBehind: 1.5,
  // Runners slide into these bases on a close play: when the throw hasn't
  // come yet as they get there, or was caught less than this long before.
  slideBases: ['second', 'third', 'home'],
  closeMs: 500,
};

const D = 90 / Math.SQRT2; // a base path is 90 feet

/** @type {Record<Base, Point>} */
export const BASES = {
  home: { x: 0, y: 0 },
  first: { x: D, y: D },
  second: { x: 0, y: 2 * D },
  third: { x: -D, y: D },
};

export const MOUND = { x: 0, y: 60.5 };

/**
 * Every fielder: their name and where they stand. `infield` says which kind of
 * play the positions players can pick get.
 * @type {Record<string, {name: string, short: string, spot: Point, infield?: boolean}>}
 */
export const FIELDERS = {
  P: { name: 'pitcher', short: 'P', spot: { x: 0, y: 60.5 } },
  C: { name: 'catcher', short: 'C', spot: { x: 0, y: -3 } },
  '1B': { name: 'first baseman', short: '1B', spot: { x: 52, y: 80 } },
  '2B': { name: 'second baseman', short: '2B', spot: { x: 35, y: 122 }, infield: true },
  SS: { name: 'shortstop', short: 'SS', spot: { x: -35, y: 122 }, infield: true },
  '3B': { name: 'third baseman', short: '3B', spot: { x: -60, y: 78 }, infield: true },
  LF: { name: 'left fielder', short: 'LF', spot: { x: -150, y: 250 }, infield: false },
  CF: { name: 'centre fielder', short: 'CF', spot: { x: 0, y: 310 }, infield: false },
  RF: { name: 'right fielder', short: 'RF', spot: { x: 150, y: 250 }, infield: false },
};

/** The positions players can pick, as they appear on the field from left to right. */
export const PLAYABLE_POSITIONS = ['3B', 'SS', '2B', 'LF', 'CF', 'RF'];

// Where the third baseman charges a dinker (a slow roller up the line).
const DINKER_SPOT = { x: -30, y: 40 };

const NO_RUNNERS = Object.freeze({ first: false, second: false, third: false });

/** The base a runner leaves for this one ('home' for the batter running to first). */
export function previousBase(base) {
  return { first: 'home', second: 'first', third: 'second', home: 'third' }[base];
}

/**
 * The base the lead runner is forced to, or first base when nobody is forced
 * (the batter always is).
 * @param {Bases} bases
 * @returns {Base}
 */
export function forceTarget(bases) {
  if (!bases.first) return 'first';
  if (!bases.second) return 'second';
  if (!bases.third) return 'third';
  return 'home';
}

/** Who catches a throw to this base, given who threw it. */
export function coveringFielder(position, base) {
  if (base === 'first') return '1B';
  if (base === 'third') return '3B';
  if (base === 'home') return 'C';
  // Second base: the middle infielder who isn't fielding the ball. On a hit to
  // left, the shortstop has gone out towards the ball, so the second baseman covers.
  return ['SS', '3B', 'LF'].includes(position) ? '2B' : 'SS';
}

/**
 * @typedef {object} Play what the next batter does, and the throw it calls for
 * @property {'grounder'|'dinker'|'hit'} kind a grounder to an infielder, a slow roller the third baseman
 *   charges, or a base hit to an outfielder
 * @property {string} position who fields it
 * @property {Point} start where the fielder starts
 * @property {Point} fieldedAt where they get the ball, and throw from
 * @property {Base} target the base to throw to
 * @property {Base} runnerFrom where the runner the throw is for started ('home' for the batter)
 * @property {Base[]} runnerPath the bases that runner runs through, from start to target
 * @property {string} cover who catches the throw
 * @property {Point} coverAt where they stand
 * @property {number} throwFeet
 * @property {number} runnerMs from when the view has turned to the base until the runner gets there
 */

/**
 * The play the next batter makes, with these runners on base. Every batter
 * puts the ball in play to the player's position:
 * - an infielder fields a grounder and throws to the base the lead runner is
 *   forced to (home with the bases loaded), or to first when nobody is forced.
 *   When that would be the third baseman's own base, it is a dinker instead,
 *   and the only play is to first;
 * - an outfielder fields a base hit, and every runner tries for two bases: the
 *   throw is home for a runner who started on second, or else to second for the batter.
 * @param {string} position one of PLAYABLE_POSITIONS
 * @param {Bases} bases
 * @param {() => number} [random]
 * @returns {Play}
 */
export function planPlay(position, bases, random = Math.random, rules = FIELDERS_CHOICE_RULES) {
  const fielder = FIELDERS[position];
  if (!fielder || fielder.infield === undefined) throw new Error(`Can't play ${position}`);
  let kind;
  let target;
  let runnerPath;
  if (fielder.infield) {
    kind = 'grounder';
    target = forceTarget(bases);
    if (position === '3B' && target === 'third') {
      kind = 'dinker';
      target = 'first';
    }
    runnerPath = [previousBase(target), target];
  } else {
    kind = 'hit';
    target = bases.second ? 'home' : 'second';
    runnerPath = target === 'home' ? ['second', 'third', 'home'] : ['home', 'first', 'second'];
  }

  const start = kind === 'dinker' ? { ...fielder.spot } : fielder.spot;
  let fieldedAt;
  if (kind === 'dinker') {
    fieldedAt = sideways(DINKER_SPOT, (random() * 2 - 1) * rules.spread.dinker);
  } else if (fielder.infield) {
    fieldedAt = sideways(fielder.spot, (random() * 2 - 1) * rules.spread.infield);
  } else {
    // Into the gap: towards centre field, so towards the middle of the field (x = 0).
    const toCentre = Math.sign(-fielder.spot.x) || (random() < 0.5 ? -1 : 1);
    const feet = rules.gap.min + random() * (rules.gap.max - rules.gap.min);
    fieldedAt = sideways(fielder.spot, toCentre * Math.sign(fielder.spot.y) * feet);
  }

  const base = BASES[target];
  const throwFeet = Math.hypot(base.x - fieldedAt.x, base.y - fieldedAt.y);
  const along = { x: (base.x - fieldedAt.x) / throwFeet, y: (base.y - fieldedAt.y) / throwFeet };
  return {
    kind,
    position,
    start,
    fieldedAt,
    target,
    runnerFrom: runnerPath[0],
    runnerPath,
    cover: coveringFielder(position, target),
    coverAt: { x: base.x + along.x * rules.coverBehind, y: base.y + along.y * rules.coverBehind },
    throwFeet,
    runnerMs: kind === 'hit' ? rules.runnerMs.hit : Math.round(rules.runnerMs.base + rules.runnerMs.perFoot * throwFeet),
  };
}

/** A point moved sideways (across the line from home plate) by `feet`; + is towards first base. */
function sideways(p, feet) {
  const d = Math.hypot(p.x, p.y);
  return { x: p.x + (p.y / d) * feet, y: p.y - (p.x / d) * feet };
}

// ---- The game ---------------------------------------------------------------

/**
 * @typedef {object} GameState
 * @property {number} innings how many the game lasts
 * @property {number} inning the one being played, from 1
 * @property {number} outs in this inning
 * @property {number} runs allowed in the whole game
 * @property {number} inningRuns allowed in this inning
 * @property {Bases} bases
 * @property {number} batters faced
 * @property {boolean} over
 */

/** @returns {GameState} */
export function newGame(innings) {
  return { innings, inning: 1, outs: 0, runs: 0, inningRuns: 0, bases: { ...NO_RUNNERS }, batters: 0, over: false };
}

/**
 * What a play comes to. Nobody runs further on a bad throw: a runner who
 * isn't out ends up where they were running to.
 * - On the infield, every forced runner moves up one base and the others stay
 *   put. The batter reaches first unless the throw was to first and in time,
 *   and the runner the throw was for is out if it was in time. A forced runner
 *   from third scores.
 * - On a hit, every runner goes two bases: runners from second and third head
 *   home, a runner from first to third, and the batter to second. The runner the
 *   throw was for is out if it was in time; the rest are safe.
 * After the third out, or once the mercy rule's runs have scored, the inning
 * is over: the returned state is the start of the next one (or the game is over).
 * @param {GameState} state
 * @param {Play} play
 * @param {boolean} out the throw beat the runner
 * @returns {{state: GameState, runs: number, inningOver: boolean, mercy: boolean, gameOver: boolean}}
 */
export function playResult(state, play, out, rules = FIELDERS_CHOICE_RULES) {
  const b = state.bases;
  const bases = { ...NO_RUNNERS };
  let runs = 0;
  if (play.kind === 'hit') {
    if (b.third) runs++;
    if (b.second) runs++;
    bases.third = b.first;
    bases.second = true;
  } else {
    bases.first = true;
    if (b.first) bases.second = true;
    if (b.second) {
      if (b.first) bases.third = true;
      else bases.second = true;
    }
    if (b.third) {
      if (b.first && b.second) runs++;
      else bases.third = true;
    }
  }
  if (out) {
    if (play.target === 'home') runs--;
    else bases[play.target] = false;
  }

  const outs = state.outs + (out ? 1 : 0);
  const inningRuns = state.inningRuns + runs;
  const next = {
    ...state, outs, inningRuns, runs: state.runs + runs, bases, batters: state.batters + 1,
  };
  const mercy = outs < rules.outsPerInning && inningRuns >= rules.mercyRuns;
  const inningOver = outs >= rules.outsPerInning || mercy;
  const gameOver = inningOver && state.inning >= state.innings;
  if (gameOver) next.over = true;
  else if (inningOver) Object.assign(next, { inning: state.inning + 1, outs: 0, inningRuns: 0, bases: { ...NO_RUNNERS } });
  return { state: next, runs, inningOver, mercy, gameOver };
}

/** "Bases empty", "Runner on first", "Runners on first and third", "Bases loaded". */
export function describeBases(bases) {
  const on = ['first', 'second', 'third'].filter((base) => bases[base]);
  if (on.length === 0) return 'Bases empty';
  if (on.length === 3) return 'Bases loaded';
  if (on.length === 1) return `Runner on ${on[0]}`;
  return `Runners on ${on[0]} and ${on[1]}`;
}

/** 1st, 2nd, 3rd, 4th… */
export function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
}

// ---- Runners and the ball ---------------------------------------------------

/**
 * Where every runner goes on a play, as the bases they run through (a single
 * base for a runner who stays put). The batter is the runner from 'home'.
 * `thrownAt` marks the runner the throw is for.
 * @param {Play} play
 * @param {Bases} bases
 * @returns {{from: Base, path: Base[], thrownAt: boolean}[]}
 */
export function runnerMoves(play, bases) {
  const order = ['home', 'first', 'second', 'third', 'home'];
  const forced = { home: true, first: bases.first, second: bases.first && bases.second, third: bases.first && bases.second && bases.third };
  const moves = [];
  for (const from of ['home', 'first', 'second', 'third']) {
    if (from !== 'home' && !bases[from]) continue;
    const i = order.indexOf(from);
    let steps;
    if (play.kind === 'hit') steps = from === 'home' ? 2 : Math.min(2, 4 - i);
    else steps = forced[from] ? 1 : 0;
    const path = order.slice(i, i + steps + 1);
    moves.push({ from, path, thrownAt: from === play.runnerFrom });
  }
  return moves;
}

/**
 * Where a runner is, a fraction `u` (0–1) of the way along a path through
 * these bases (by distance, so they run at an even speed).
 * @param {Base[]} path
 */
export function alongPath(path, u) {
  const points = path.map((base) => BASES[base]);
  const legs = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let left = Math.min(1, Math.max(0, u)) * legs.reduce((a, b) => a + b, 0);
  for (let i = 0; i < legs.length; i++) {
    if (left <= legs[i] || i === legs.length - 1) {
      const t = legs[i] ? Math.min(1, left / legs[i]) : 1;
      return { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t };
    }
    left -= legs[i];
  }
  return { ...points[0] };
}

/**
 * Where the batted ball is, a fraction `u` (0–1) of the way from the bat to
 * the fielder's glove: a grounder skips along the ground, a dinker trickles,
 * and a base hit flies on a line, bounces and rolls.
 * @param {Play} play
 * @returns {Point3}
 */
export function battedBallAt(play, u) {
  const t = Math.min(1, Math.max(0, u));
  const to = play.fieldedAt;
  const glove = 1.5;
  let z;
  let k = t; // how far along the ground
  if (play.kind === 'hit') {
    const land = 0.75;
    if (t < land) {
      const s = t / land;
      z = 3 + (0 - 3) * s + 70 * s * (1 - s);
    } else {
      const s = (t - land) / (1 - land);
      z = 5 * Math.abs(Math.sin(Math.PI * s)) * (1 - s) + glove * s;
    }
    k = t < land ? (t / land) * 0.85 : 0.85 + ((t - land) / (1 - land)) * 0.15;
  } else {
    const hops = play.kind === 'dinker' ? 2 : 3;
    const height = play.kind === 'dinker' ? 2 : 5;
    z = height * (1 - t) * Math.abs(Math.sin(Math.PI * hops * t)) + glove * t;
  }
  return { x: to.x * k, y: to.y * k, z };
}

/**
 * Where someone standing at `spot` steps to so that, seen from the thrower,
 * they're clear of what the covering fielder at `target` can reach (with room
 * for their own width), or `spot` itself if they already are. Fielders, the
 * pitcher and the umpire get out of the line of a throw, so nothing stands in
 * front of or behind the player's target. `side` (1 to the thrower's left, -1
 * to their right) picks which way they step; `extra` feet take them further.
 * @param {Point} thrower
 * @param {Point} target
 * @param {Point} spot
 * @param {object} [rules]
 * @param {{side?: number, extra?: number}} [options]
 * @returns {Point}
 */
export function outOfTheWay(thrower, target, spot, rules = FIELDERS_CHOICE_RULES, { side: prefer = 0, extra = 0 } = {}) {
  const L = Math.hypot(target.x - thrower.x, target.y - thrower.y);
  const d = { x: (target.x - thrower.x) / L, y: (target.y - thrower.y) / L };
  const left = { x: -d.y, y: d.x };
  const v = { x: spot.x - thrower.x, y: spot.y - thrower.y };
  const along = v.x * d.x + v.y * d.y;
  const lat = v.x * left.x + v.y * left.y;
  if (along < 5) return spot;
  // Half the reach (and a little more) at the target, scaled to this distance, plus a figure's half width.
  const need = (along * (rules.reach.side + 1)) / L + 2.5;
  if (Math.abs(lat) >= need && !extra) return spot;
  const side = prefer || (lat < 0 ? -1 : 1);
  const to = need + extra;
  return { x: thrower.x + d.x * along + left.x * to * side, y: thrower.y + d.y * along + left.y * to * side };
}

/**
 * Which side of the line of the throw the runner the throw is for comes in
 * from: 1 to the thrower's left, -1 to their right. People stepping out of
 * the way go to the other side, so the runner doesn't run through them.
 * @param {Play} play
 */
export function runnerSide(play) {
  const base = BASES[play.target];
  const from = BASES[play.runnerPath[play.runnerPath.length - 2]];
  const L = Math.hypot(base.x - play.fieldedAt.x, base.y - play.fieldedAt.y);
  const left = { x: -(base.y - play.fieldedAt.y) / L, y: (base.x - play.fieldedAt.x) / L };
  return Math.sign((from.x - play.fieldedAt.x) * left.x + (from.y - play.fieldedAt.y) * left.y) || 1;
}

/**
 * Where the umpire making the call stands: a few feet beyond the bag, on the
 * other side from the runner coming in, clear (seen from the thrower) of what
 * the covering fielder can reach, and further out than anyone who has
 * stepped out of the way, so they aren't hidden behind them.
 * @param {Play} play
 * @returns {Point}
 */
export function umpireSpot(play, rules = FIELDERS_CHOICE_RULES) {
  const base = BASES[play.target];
  const L = Math.hypot(base.x - play.fieldedAt.x, base.y - play.fieldedAt.y);
  const d = { x: (base.x - play.fieldedAt.x) / L, y: (base.y - play.fieldedAt.y) / L };
  const start = { x: base.x + d.x * 7, y: base.y + d.y * 7 };
  return outOfTheWay(play.fieldedAt, play.coverAt, start, rules, { side: -runnerSide(play), extra: 6 });
}

// ---- The fielder's-eye view -------------------------------------------------

/**
 * @typedef {object} View where the player looks from and how far it zooms
 * @property {Point3} eye
 * @property {number} yaw radians, 0 looking out to centre field, + turning towards first
 * @property {number} pitch radians, + looking up
 * @property {number} f focal length, in screen heights: how many screen heights a
 *   thing 1 foot across is, 1 foot away
 * @property {number} centreY where on the screen (0–1 down) the view's centre is
 */

/** The angles to look from `eye` straight at `target`. */
export function lookAngles(eye, target) {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = (target.z ?? 0) - eye.z;
  return { yaw: Math.atan2(dx, dy), pitch: Math.atan2(dz, Math.hypot(dx, dy)) };
}

/** How far the covering fielder's feet are from the thrower's eye, in feet. */
function throwDistance(from, feet, rules) {
  return Math.hypot(feet.x - from.x, feet.y - from.y, rules.eyeHeight);
}

/**
 * The view for a throw from `from`: it looks straight at the covering
 * fielder's feet, which it puts at `feetAt`, and zooms so they stand
 * `fielderOnScreen` tall, but no further than for a throw of `zoomUpTo` feet
 * (see `feetScale`).
 * @param {Point} from where the thrower stands
 * @param {Point} feet where the covering fielder stands
 * @returns {View}
 */
export function throwView(from, feet, rules = FIELDERS_CHOICE_RULES) {
  const eye = { x: from.x, y: from.y, z: rules.eyeHeight };
  const distance = Math.min(throwDistance(from, feet, rules), rules.zoomUpTo);
  return {
    eye,
    ...lookAngles(eye, { ...feet, z: 0 }),
    f: (rules.fielderOnScreen * distance) / rules.fielderHeight,
    centreY: rules.feetAt.y,
  };
}

/** The view from `from` towards home plate, while the pitch comes in. */
export function battingView(from, rules = FIELDERS_CHOICE_RULES) {
  const eye = { x: from.x, y: from.y, z: rules.eyeHeight };
  const distance = Math.hypot(eye.x, eye.y, eye.z);
  return {
    eye,
    ...lookAngles(eye, { x: 0, y: 0, z: 0 }),
    f: (rules.batterOnScreen * distance) / rules.fielderHeight,
    centreY: 0.72,
  };
}

/**
 * Part of the way (`u`, 0–1) from one view to another: the eye moves in a
 * straight line, it turns the short way round and zooms evenly.
 * @param {View} a
 * @param {View} b
 * @returns {View}
 */
export function blendViews(a, b, u) {
  const t = Math.min(1, Math.max(0, u));
  const lerp = (p, q) => p + (q - p) * t;
  let turn = b.yaw - a.yaw;
  turn -= Math.round(turn / (2 * Math.PI)) * 2 * Math.PI;
  return {
    eye: { x: lerp(a.eye.x, b.eye.x), y: lerp(a.eye.y, b.eye.y), z: lerp(a.eye.z, b.eye.z) },
    yaw: a.yaw + turn * t,
    pitch: lerp(a.pitch, b.pitch),
    f: Math.exp(lerp(Math.log(a.f), Math.log(b.f))),
    centreY: lerp(a.centreY, b.centreY),
  };
}

/**
 * A pinhole camera for a view, on a screen `aspect` wide for each unit high.
 * `toCamera` gives a field point relative to the eye (x right, y up, z ahead,
 * in feet), `toScreen` turns that into a screen position with `scale`, the
 * screen heights a foot is there, and `project` does both (null for a point
 * behind the eye).
 * @param {View} view
 * @param {number} aspect
 */
export function makeCamera(view, aspect) {
  const { eye, yaw, pitch, f, centreY } = view;
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const sinPitch = Math.sin(pitch);
  const cosPitch = Math.cos(pitch);
  const ahead = [sinYaw * cosPitch, cosYaw * cosPitch, sinPitch];
  const right = [cosYaw, -sinYaw, 0];
  const up = [-sinPitch * sinYaw, -sinPitch * cosYaw, cosPitch];
  const near = 1;
  const toCamera = (p) => {
    const v = [p.x - eye.x, p.y - eye.y, (p.z ?? 0) - eye.z];
    const dot = (a) => a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
    return { x: dot(right), y: dot(up), z: dot(ahead) };
  };
  const toScreen = (c) => ({ x: 0.5 + (f * c.x) / c.z / aspect, y: centreY - (f * c.y) / c.z, scale: f / c.z, depth: c.z });
  return {
    view,
    aspect,
    near,
    toCamera,
    toScreen,
    /** @returns {{x:number, y:number, scale:number, depth:number}|null} */
    project(p) {
      const c = toCamera(p);
      return c.z < near ? null : toScreen(c);
    },
  };
}

// ---- The throw --------------------------------------------------------------

/**
 * How much of the screen height a foot is at the covering fielder, in the
 * view for a throw from `from` to `feet`: the same for every throw up to
 * `zoomUpTo` feet, and less the further a longer one is. With no throw given,
 * the size for a throw the view zooms in all the way for.
 * @param {Point} [from]
 * @param {Point} [feet]
 */
export function feetScale(from, feet, rules = FIELDERS_CHOICE_RULES) {
  const full = rules.fielderOnScreen / rules.fielderHeight;
  if (!from || !feet) return full;
  return full * Math.min(1, rules.zoomUpTo / throwDistance(from, feet, rules));
}

/**
 * The area of the screen the covering fielder can reach: a throw that lands
 * in it is caught. The view always puts the fielder's feet in the same
 * place, so it is the same box for every throw but for its size, `s` (from
 * `feetScale`): smaller on a long throw.
 * @returns {Rect}
 */
export function reachBox(aspect, s = feetScale(), rules = FIELDERS_CHOICE_RULES) {
  const { x, y } = rules.feetAt;
  const { side, up, down } = rules.reach;
  return { x0: x - (side * s) / aspect, x1: x + (side * s) / aspect, y0: y - up * s, y1: y + down * s };
}

/** Whether a throw at `point` is one the covering fielder catches. */
export function inReach(point, aspect, s = feetScale(), rules = FIELDERS_CHOICE_RULES) {
  const r = reachBox(aspect, s, rules);
  return point.x >= r.x0 && point.x <= r.x1 && point.y >= r.y0 && point.y <= r.y1;
}

/**
 * Where a throw at `point` is, from the covering fielder: feet to their side
 * (+ is to the right on screen) and feet above the ground.
 * @returns {Point}
 */
export function fromFielder(point, aspect, s = feetScale(), rules = FIELDERS_CHOICE_RULES) {
  return { x: ((point.x - rules.feetAt.x) * aspect) / s, y: (rules.feetAt.y - point.y) / s };
}

/**
 * How a throw at `point` turns out for the covering fielder: caught, or
 * which way it got past them ('high' over the glove, 'low' into the dirt in
 * front, 'left' or 'right' out of reach to that side). A corner counts as
 * whichever way it missed by more.
 * @returns {'catch'|'high'|'low'|'left'|'right'}
 */
export function throwOutcome(point, aspect, s = feetScale(), rules = FIELDERS_CHOICE_RULES) {
  const r = reachBox(aspect, s, rules);
  // How far outside the box, in feet.
  const over = {
    left: ((r.x0 - point.x) * aspect) / s,
    right: ((point.x - r.x1) * aspect) / s,
    high: (r.y0 - point.y) / s,
    low: (point.y - r.y1) / s,
  };
  let worst = 'catch';
  let by = 0;
  for (const [way, feet] of Object.entries(over)) {
    if (feet > by) {
      worst = way;
      by = feet;
    }
  }
  return worst;
}
