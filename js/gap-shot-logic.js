// Gap Shot rules, kept free of the browser so they can be unit-tested: the three
// levels (how hard the ball is hit, where the fence is, how good the fielders are),
// the batter's view and the exact link between a spot on the screen and the way the
// ball leaves the tee, and the innings (outs, strikes, runners, runs).
//
// Field positions are in feet, as in fielders-choice-logic.js: home plate at the
// origin, +y out to centre field, +x towards first base, z up. Screen positions are
// normalised (0-1 across and down); `aspect` is the screen's width over its height.
// Angles are radians (the spray angle from straight out to centre field, + towards first
// base; the launch angle from level, + upwards) unless a name says degrees.

import { BASES, FIELDERS, makeCamera } from './fielders-choice-logic.js';
import { PHYSICS, mphToFps } from './gap-shot-physics.js';

/**
 * @typedef {{x:number, y:number}} Point
 * @typedef {{x:number, y:number, z:number}} Point3
 * @typedef {'little'|'high'|'pro'} LevelId
 * @typedef {import('./fielders-choice-logic.js').Bases} Bases
 */

const DEG = Math.PI / 180;

export const GAP_SHOT_RULES = {
  inningsChoices: [1, 3, 9],
  outsPerInning: 3,
  // A foul is a strike up to two strikes, and after that it only means swing again: fouls never strike you out.
  maxStrikes: 2,
  // An inning also ends once this many runs have scored in it, so it can't go on for ever.
  mercyRuns: 10,
  // A ball whose speed was measured leaves the bat at that speed, but kept between these (mph): a camera that
  // misjudges a throw can't send the ball nowhere, or into orbit.
  exitMph: { min: 20, max: 130 },
};

/**
 * The three levels. The ball leaves the bat at `mph` (the player only chooses where it goes), the fence
 * `line` feet down the lines and `centre` feet to centre field is `height` feet tall (for the first two
 * a portable fence in front of the stadium's wall, the last the stadium's own), and the Lamplighters
 * and the Rattlers play as `fielding` and `running` say (feet and seconds). `sacDepth` is how far a
 * caught fly must be hit for a runner on third to tag up and score.
 * @type {Record<LevelId, {
 *   id: LevelId, name: string, mph: number, speed: number,
 *   fence: {line:number, centre:number, height:number, portable:boolean},
 *   fielding: {reaction:number, speed:number, throw:number, transfer:number, relay:number},
 *   running: {speed:number},
 *   sacDepth: number,
 * }>}
 */
export const LEVELS = {
  little: {
    id: 'little',
    name: 'Little League',
    mph: 68,
    speed: mphToFps(68),
    fence: { line: 190, centre: 215, height: 4, portable: true },
    fielding: { reaction: 0.7, speed: 11, throw: 60, transfer: 1.0, relay: 2.0 },
    running: { speed: 24 },
    sacDepth: 130,
  },
  high: {
    id: 'high',
    name: 'High School',
    mph: 82,
    speed: mphToFps(82),
    fence: { line: 270, centre: 300, height: 5, portable: true },
    fielding: { reaction: 0.6, speed: 13.5, throw: 85, transfer: 0.8, relay: 0.3 },
    running: { speed: 26 },
    sacDepth: 170,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    mph: 100,
    speed: mphToFps(100),
    fence: { line: 330, centre: 400, height: 9, portable: false },
    fielding: { reaction: 0.36, speed: 21, throw: 125, transfer: 0.45, relay: 0.4 },
    running: { speed: 28 },
    sacDepth: 220,
  },
};

/** @typedef {typeof LEVELS[LevelId]} Level */

export const LEVEL_IDS = /** @type {LevelId[]} */ (Object.keys(LEVELS));

/**
 * How each position differs from the level's fielders: extra reaction time (seconds), a share of their
 * running speed, and how far (feet) they reach for a ball without running to it.
 */
export const FIELDER_TRAITS = {
  P: { react: 0.12, speed: 0.85, reach: 3.5 },
  C: { react: 0.15, speed: 0.8, reach: 3 },
  '1B': { react: 0.04, speed: 0.88, reach: 4.5 },
  '2B': { react: -0.04, speed: 1, reach: 5 },
  SS: { react: -0.06, speed: 1.02, reach: 5.5 },
  '3B': { react: -0.02, speed: 0.95, reach: 5 },
  LF: { react: 0, speed: 1.03, reach: 5 },
  CF: { react: 0, speed: 1.1, reach: 5.5 },
  RF: { react: 0, speed: 1.03, reach: 5 },
};

/** The fence of a level: how far round the outfield it is at `deg` degrees from centre field (down the lines at 45). */
export function fenceOf(level) {
  const { line, centre, height } = level.fence;
  return {
    height,
    radiusAt: (deg) => centre - (centre - line) * (Math.min(45, Math.abs(deg)) / 45) ** 1.5,
  };
}

/** The outfielders stand this share of the way to the fence (they stand in front of a closer fence). */
const OUTFIELDERS = ['LF', 'CF', 'RF'];

/**
 * The fielders of a level: where each stands, and how quickly they react, run, reach and throw. The infield
 * is the same at every level (the bases are always 90 feet apart); the outfielders stand where they do at Pro
 * in proportion to the fence, so at a level with a closer fence they stand in front of it.
 */
export function fieldersOf(level) {
  const pro = fenceOf(LEVELS.pro);
  const fence = fenceOf(level);
  const out = {};
  for (const [id, fielder] of Object.entries(FIELDERS)) {
    const trait = FIELDER_TRAITS[id];
    let spot = fielder.spot;
    if (OUTFIELDERS.includes(id)) {
      const deg = (Math.atan2(spot.x, spot.y) * 180) / Math.PI;
      const k = fence.radiusAt(deg) / pro.radiusAt(deg);
      spot = { x: spot.x * k, y: spot.y * k };
    }
    out[id] = {
      id,
      spot,
      reaction: level.fielding.reaction + trait.react,
      speed: level.fielding.speed * trait.speed,
      reach: trait.reach,
      throwSpeed: level.fielding.throw,
      transfer: level.fielding.transfer,
    };
  }
  return out;
}

// ---- The batter's view and the link from the screen to the ball -----------------

/** The ball on the tee (feet), and the batter's eyes: behind home plate, at about the height of a batter's eyes. */
export const TEE = PHYSICS.tee;
export const BATTER_EYE = { x: 0, y: -4, z: 5.6 };

export const BATTER_VIEW = {
  // The camera looks up this much, so the grass is in the lower part of the screen, and the sky above.
  pitch: 21 * DEG,
  // The picture is zoomed so that the horizon row reaches this many degrees either side of straight ahead:
  // both foul lines (at 45) and some foul territory beyond them are always on screen, on any screen.
  halfSpray: 55 * DEG,
  // A point the ball is aimed at is no further out than this (feet): a ray that never meets the ground,
  // or meets it beyond, is taken to the point this far out along it.
  aimRange: 500,
  // The ball is never sent down or up more steeply than this, nor more sideways than this.
  launch: { min: -20 * DEG, max: 75 * DEG },
  spray: { max: 80 * DEG },
};

/**
 * The batter's view on a screen `aspect` wide for each unit high. Its zoom is set by the width, so the
 * sideways reach of the picture is the same on any screen; the height then follows: from the dirt in
 * front of the plate at the bottom to a steep pop-up at the top.
 * @returns {import('./fielders-choice-logic.js').View}
 */
export function batterView(aspect) {
  const { pitch, halfSpray } = BATTER_VIEW;
  return {
    eye: BATTER_EYE,
    yaw: 0,
    pitch,
    f: (0.5 * aspect * Math.cos(pitch)) / Math.tan(halfSpray),
    centreY: 0.5,
  };
}

/** The camera for the batter's view on a screen of this shape. */
export function batterCamera(aspect) {
  return makeCamera(batterView(aspect), aspect);
}

/** The unit vector, in the field's terms, from the eye of a view through a point on the screen. */
export function rayThrough(view, aspect, screen) {
  const sy = Math.sin(view.yaw);
  const cy = Math.cos(view.yaw);
  const sp = Math.sin(view.pitch);
  const cp = Math.cos(view.pitch);
  const right = [cy, -sy, 0];
  const up = [-sp * sy, -sp * cy, cp];
  const ahead = [sy * cp, cy * cp, sp];
  const cx = ((screen.x - 0.5) * aspect) / view.f;
  const cu = (view.centreY - screen.y) / view.f;
  const d = [0, 1, 2].map((i) => right[i] * cx + up[i] * cu + ahead[i]);
  const n = Math.hypot(...d);
  return { x: d[0] / n, y: d[1] / n, z: d[2] / n };
}

/**
 * The point in the picture a spot on the screen shows, which the ball is sent through: where the ray from
 * the batter's eye through that spot meets the ground, or, for a spot in the sky or beyond the park, the
 * point that far out along the ray.
 * @param {Point} screen
 * @param {number} aspect
 * @returns {Point3}
 */
export function aimPoint(screen, aspect) {
  const view = batterView(aspect);
  const ray = rayThrough(view, aspect, screen);
  const flat = Math.hypot(ray.x, ray.y);
  let distance = BATTER_VIEW.aimRange; // along the ground, from the eye
  if (ray.z < 0) distance = Math.min(distance, (view.eye.z / -ray.z) * flat);
  const k = distance / flat;
  return { x: view.eye.x + ray.x * k, y: view.eye.y + ray.y * k, z: view.eye.z + ray.z * k };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * How the ball leaves the tee for a ball that hit the screen at `screen`: along the line from the ball on
 * the tee through the point `aimPoint` gives, so it goes through the spot you hit in the picture.
 * Only a hit so low or so wide that no bat could send the ball there is turned a little (see BATTER_VIEW).
 * @returns {{spray:number, launch:number, aim:Point3}}
 */
export function launchFor(screen, aspect) {
  const aim = aimPoint(screen, aspect);
  const dx = aim.x - TEE.x;
  const dy = aim.y - TEE.y;
  const dz = aim.z - TEE.z;
  return {
    spray: clamp(Math.atan2(dx, dy), -BATTER_VIEW.spray.max, BATTER_VIEW.spray.max),
    launch: clamp(Math.atan2(dz, Math.hypot(dx, dy)), BATTER_VIEW.launch.min, BATTER_VIEW.launch.max),
    aim,
  };
}

/**
 * How the ball leaves the tee for a ball that hit the screen: the spray from where it hit, as `launchFor` has it.
 * Where the cameras saw the ball's flight, the launch angle is the angle it arrived at (`elevation`, degrees above
 * level) and the exit speed is the speed it arrived at (`speedMph`, miles an hour), within the limits of
 * GAP_SHOT_RULES; where they didn't (one camera, a mouse click, no screen width), they are the screen spot's
 * and the level's. The two are separate: a ball can have an angle without a speed.
 * @param {{x:number, y:number, speedMph?:number|null, elevation?:number|null}} ball a hit (or a click, which has only x and y)
 * @param {number} aspect
 * @param {Level} level
 * @returns {{spray:number, launch:number, speed:number, mph:number|null}} speed in ft/s; mph the measured speed
 *   as used (within the limits), null if it wasn't measured
 */
export function hitFor(ball, aspect, level, rules = GAP_SHOT_RULES) {
  const aimed = launchFor(ball, aspect);
  let launch = aimed.launch;
  if (Number.isFinite(ball.elevation)) launch = clamp(ball.elevation * DEG, BATTER_VIEW.launch.min, BATTER_VIEW.launch.max);
  let speed = level.speed;
  let mph = null;
  if (Number.isFinite(ball.speedMph)) {
    mph = clamp(ball.speedMph, rules.exitMph.min, rules.exitMph.max);
    speed = mphToFps(mph);
  }
  return { spray: aimed.spray, launch, speed, mph };
}

/**
 * Where on the screen a ball sent out at this spray and launch angle is aimed: the opposite of `launchFor`
 * (for tests, and for the end-to-end test to throw a ball at).
 * @returns {Point}
 */
export function screenFor(spray, launch, aspect) {
  const view = batterView(aspect);
  const camera = makeCamera(view, aspect);
  const u = { x: Math.sin(spray), y: Math.cos(spray) }; // along the ground
  const rise = Math.tan(launch); // feet up for each foot along the ground
  const R = BATTER_VIEW.aimRange;
  // Where the line from the tee meets the ground, if it goes down and does so within the aim range of the eye…
  let along = Infinity;
  if (rise < 0) {
    const toGround = -TEE.z / rise;
    const x = TEE.x + u.x * toGround - view.eye.x;
    const y = TEE.y + u.y * toGround - view.eye.y;
    if (Math.hypot(x, y) <= R) along = toGround;
  }
  // …and otherwise where it is the aim range from the eye, along the ground.
  if (!Number.isFinite(along)) {
    const ax = TEE.x - view.eye.x;
    const ay = TEE.y - view.eye.y;
    const dot = ax * u.x + ay * u.y;
    along = -dot + Math.sqrt(dot * dot - (ax * ax + ay * ay) + R * R);
  }
  return camera.project({ x: TEE.x + u.x * along, y: TEE.y + u.y * along, z: TEE.z + rise * along });
}

// ---- The innings ----------------------------------------------------------------

const NO_RUNNERS = Object.freeze({ first: false, second: false, third: false });

/**
 * @typedef {object} GameState
 * @property {LevelId} level
 * @property {number} innings how many the game lasts
 * @property {number} inning the one being played, from 1
 * @property {number} outs in this inning
 * @property {number} strikes the batter has
 * @property {number} runs scored in the whole game
 * @property {number} inningRuns scored in this inning
 * @property {Bases} bases
 * @property {number} batters who have batted
 * @property {boolean} over
 */

/** @returns {GameState} */
export function newGame(level, innings) {
  return {
    level, innings, inning: 1, outs: 0, strikes: 0, runs: 0, inningRuns: 0, bases: { ...NO_RUNNERS }, batters: 0, over: false,
  };
}

/**
 * What a swing comes to for the innings. A foul is a strike up to two strikes, and then nothing (and a
 * foul that is caught is an out like any other). Any other swing ends the batter's turn, so the next
 * batter has no strikes. After the third out, or once the mercy rule's runs have scored, the inning
 * is over: the returned state is the start of the next one (or the game is over).
 * @param {GameState} state
 * @param {{foul:boolean, outs:number, runs:number, basesAfter:Bases}} play from planHit: `basesAfter` is where the
 *   runners are afterwards, `runs` how many scored and `outs` how many were made (0 or 1)
 * @returns {{state: GameState, runs: number, strike: boolean, inningOver: boolean, mercy: boolean, gameOver: boolean}}
 */
export function applyPlay(state, play, rules = GAP_SHOT_RULES) {
  if (play.foul && !play.outs) {
    const strike = state.strikes < rules.maxStrikes;
    return {
      state: { ...state, strikes: state.strikes + (strike ? 1 : 0) },
      runs: 0, strike, inningOver: false, mercy: false, gameOver: false,
    };
  }
  const outs = state.outs + play.outs;
  const inningRuns = state.inningRuns + play.runs;
  const next = {
    ...state, outs, strikes: 0, inningRuns, runs: state.runs + play.runs, bases: { ...play.basesAfter }, batters: state.batters + 1,
  };
  const mercy = outs < rules.outsPerInning && inningRuns >= rules.mercyRuns;
  const inningOver = outs >= rules.outsPerInning || mercy;
  const gameOver = inningOver && state.inning >= state.innings;
  if (gameOver) next.over = true;
  else if (inningOver) Object.assign(next, { inning: state.inning + 1, outs: 0, inningRuns: 0, bases: { ...NO_RUNNERS } });
  return { state: next, runs: play.runs, strike: false, inningOver, mercy, gameOver };
}

/** The key best scores are saved under: one for each level and number of innings. */
export function scoreKey(gameId, level, innings) {
  return `${gameId}:${level}:${innings}`;
}

/** The bases a runner can stand on, in order, with home plate first and last (so 0 is home and 4 is home again). */
export const BASE_ORDER = ['home', 'first', 'second', 'third', 'home'];

/** Where a base is (home plate is the same at both ends). */
export function baseSpot(index) {
  return BASES[BASE_ORDER[index]];
}
