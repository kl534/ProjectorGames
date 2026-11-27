// Strike Zone rules, kept free of the browser so they can be unit-tested: the pitcher's view from the mound and
// the exact link between a spot on the screen and where the pitch crossed the plate, the strike zone and the
// batter's body (a pitch that hits him), the nine batters of each level's lineup, what a batter does with a
// pitch (`decidePitch`: take it, swing and miss, foul it off, or put it in play), and the inning: balls and
// strikes, walks, outs, runners and runs (a ball in play is Batter Up's `planHit` and `applyPlay`).
//
// Positions on the field are in feet as in fielders-choice-logic.js: home plate at the origin, +y out to centre
// field, +x towards first base, z up. A pitch is a point on the vertical plane over the front of the plate,
// `{x, z}` in feet, and there `x` is measured as the pitcher sees it: from the middle of the plate, positive
// towards the RIGHT of the screen (the third base side), the opposite of the field's own x. A right-handed batter
// stands on the third base side, so at positive x; a left-handed one at negative x. Screen positions are
// normalised (0-1 across and down); `aspect` is the screen's width over its height. Angles are radians unless a
// name says degrees; the spray angle is Batter Up's (from straight out to centre field, + towards first base, so a
// right-handed batter pulls the ball towards negative spray).

import { MOUND, makeCamera } from './fielders-choice-logic.js';
import { FIELD } from './fielders-choice-models.js';
import {
  GAP_SHOT_RULES, LEVELS, LEVEL_IDS, applyPlay, newGame as newInning, rayThrough,
} from './gap-shot-logic.js';
import { mphToFps } from './gap-shot-physics.js';

export { LEVELS, LEVEL_IDS };

/**
 * @typedef {{x:number, z:number}} Pitch where a pitch crossed the plate (feet, see above)
 * @typedef {{name:string, bats:'R'|'L', height:number, eye:number, contact:number, power:number}} Batter
 *   height in feet; the traits run from 0 to 1: `eye` (how well he lays off bad pitches), `contact`, `power`
 * @typedef {import('./gap-shot-logic.js').GameState & {
 *   balls:number, pitches:number, recent:number[], atBat:{x:number, z:number, outcome:string, mph:number}[],
 *   stats:Stats, seed:number,
 * }} Game
 * @typedef {{pitches:number, strikes:number, balls:number, strikeouts:number, walks:number, hitByPitch:number, hits:number,
 *   homers:number, fouls:number, swings:number, misses:number}} Stats
 */

export const GAME_ID = 'strike-zone';

const DEG = Math.PI / 180;

export const STRIKE_ZONE_RULES = {
  // An inning ends at three outs, or once this many runs have scored (the mercy rule).
  mercyRuns: 7,
  outsPerInning: 3,
  ballsForWalk: 4,
  strikesForOut: 3,
  // A game can't go round the lineup for ever: no more batters than this (never reached in play).
  maxBatters: 60,
  // The ball (a baseball is 2.9 inches across) and the plate (17 inches across, its front edge 17/2 + 8.5 inches
  // from its back point at the origin): a pitch is a strike if any part of the ball touches the zone over it.
  ballRadius: 1.45 / 12,
  plate: { half: 8.5 / 12, front: FIELD.plate.front / 2 + FIELD.plate.side },
  // The zone runs from the batter's knees (this share of his height) to the midpoint between his shoulders and his belt.
  zone: { bottom: 0.27, top: 0.56 },
  // The batter's feet this far from the middle of the plate; his body, for a pitch that hits him, is this far to
  // either side of that and from the ground to this share of his height.
  batterX: 2.8,
  body: { half: 0.95, top: 0.94, bottom: 0.25 },
  // The pitcher's eyes: on the mound a little in front of the rubber, looking at the plate.
  eye: { x: 0, y: MOUND.y - 1.5, z: 6 },
  // The view is zoomed so that everything from the ground up to just above a tall batter's bat (`fit`, feet above the
  // ground at the plate) fits between `screenTop` (under the score bar) and `screenBottom`; on a narrow screen it is
  // zoomed out further until `minHalfWidth` feet either side of the plate's middle are on screen.
  referenceHeight: 6,
  fit: { bottom: -0.1, top: 7.8, screenTop: 0.13, screenBottom: 0.985 },
  minHalfWidth: 3.8,
  // A pitch's speed (mph) is kept between these, so a camera that misjudges one can't make a batter swing at nothing.
  mph: { min: 12, max: 110 },
  exitMph: GAP_SHOT_RULES.exitMph,
  // Each level: the speed its batters handle easily (a throw in a living room is 25 to 60 mph), and how hard their
  // best contact goes, as a share of Batter Up's `mph` for the level.
  levels: {
    little: { comfortMph: 25, exitScale: 1 },
    high: { comfortMph: 35, exitScale: 1 },
    pro: { comfortMph: 45, exitScale: 1.01 },
  },
  // How a batter decides (see decidePitch).
  batter: {
    zoneSwing: 0.82, // the chance to swing at a pitch in the zone, before the count and his eye
    chase: 0.5, // …and at one just off it, before his eye
    chaseFall: 0.55, // feet: how quickly that falls the further off the zone it is
    chaseNever: 2.2, // feet off the zone beyond which he never swings
    timingFeet: 0.25, // a pitch this share of the expected speed off is one timing error
    foulBelow: 0.22, // contact below this quality is a foul
    // Contact: a base chance from his `contact`, then each fault takes this share off at its worst.
    contactBase: 0.78, contactSlope: 0.3, paceCost: 0.45, awkwardCost: 0.2, timingCost: 0.2,
    // The quality of the contact: from his `contact`, less for each fault, plus luck.
    qualityBase: 0.38, qualitySlope: 0.45, qualityPace: 0.2, qualityAwkward: 0.3, qualityTiming: 0.1, qualityLuck: 0.2,
    // The exit speed, as a share of the level's: this much, and this much more for the quality of the contact.
    exitBase: 0.6, exitSlope: 0.55,
    // The launch angle (degrees): this much, this much more for a pitch at the top of the zone (less at the bottom), and luck.
    launchBase: 13, launchSlope: 12, launchSpread: 9,
  },
};

// ---- The pitcher's view and the link from the screen to the plate -------------------------------------

/**
 * The pitcher's view on a screen `aspect` wide for each unit high: a fixed view from the mound, zoomed so that the
 * whole batter, bat and all, fits on screen under the score bar, with the plate in the middle.
 * @returns {import('./fielders-choice-logic.js').View}
 */
export function pitcherView(aspect, rules = STRIKE_ZONE_RULES) {
  const { eye, plate, fit, minHalfWidth } = rules;
  const middle = (fit.top + fit.bottom) / 2;
  const along = eye.y - plate.front;
  const distance = Math.hypot(along, eye.z - middle);
  const f = Math.min(((fit.screenBottom - fit.screenTop) * distance) / (fit.top - fit.bottom), (0.5 * aspect * distance) / minHalfWidth);
  // The middle of that height appears at the middle of the space between the score bar and the bottom of the screen.
  const pitch = Math.atan2(middle - eye.z, along) + Math.atan(((fit.screenTop + fit.screenBottom) / 2 - 0.5) / f);
  return { eye, yaw: Math.PI, pitch, f, centreY: 0.5 };
}

/** The camera for the pitcher's view on a screen of this shape. */
export function pitcherCamera(aspect, rules = STRIKE_ZONE_RULES) {
  return makeCamera(pitcherView(aspect, rules), aspect);
}

/**
 * Where a pitch that hit the screen at `screen` crossed the plate: the point where the ray from the pitcher's eye
 * through that spot meets the vertical plane over the front of the plate.
 * @param {{x:number, y:number}} screen
 * @param {number} aspect
 * @returns {Pitch}
 */
export function pitchPoint(screen, aspect, rules = STRIKE_ZONE_RULES) {
  const view = pitcherView(aspect, rules);
  const ray = rayThrough(view, aspect, screen);
  const k = (rules.plate.front - view.eye.y) / ray.y;
  return { x: 0 - (view.eye.x + ray.x * k), z: view.eye.z + ray.z * k };
}

/** The opposite of `pitchPoint`: where on the screen a pitch at this point crossed the plate is drawn. */
export function screenForPitch(pitch, aspect, rules = STRIKE_ZONE_RULES) {
  const p = pitcherCamera(aspect, rules).project({ x: 0 - pitch.x, y: rules.plate.front, z: pitch.z });
  return { x: p.x, y: p.y };
}

// ---- The zone and the batter's body --------------------------------------------------------------

/** Where a batter stands, on the field (feet): the right-handed on the third base side of the plate (negative x). */
export function batterSpot(batter, rules = STRIKE_ZONE_RULES) {
  return { x: batter.bats === 'R' ? -rules.batterX : rules.batterX, y: 0 };
}

/** The batter's strike zone, over the plate: feet to either side of its middle, and up from the ground. */
export function zoneOf(batter, rules = STRIKE_ZONE_RULES) {
  return { left: -rules.plate.half, right: rules.plate.half, bottom: rules.zone.bottom * batter.height, top: rules.zone.top * batter.height };
}

/**
 * How a pitch sits in a batter's zone: `outside`, how far the ball is from touching it (feet; 0 if any part of the ball
 * is in the zone, which is a strike), and `centre`, how far from the middle of the zone as a share of its half-size
 * (0 in the middle, 1 on its edge, more outside, so the corners are about 1).
 * @param {Pitch} pitch
 * @param {Batter} batter
 * @returns {{outside:number, centre:number}}
 */
export function zoneDistance(pitch, batter, rules = STRIKE_ZONE_RULES) {
  const zone = zoneOf(batter, rules);
  const dx = Math.max(zone.left - pitch.x, 0, pitch.x - zone.right);
  const dz = Math.max(zone.bottom - pitch.z, 0, pitch.z - zone.top);
  const halfWidth = (zone.right - zone.left) / 2;
  const halfHeight = (zone.top - zone.bottom) / 2;
  return {
    outside: Math.max(0, Math.hypot(dx, dz) - rules.ballRadius),
    centre: Math.max(Math.abs(pitch.x) / halfWidth, Math.abs(pitch.z - (zone.top + zone.bottom) / 2) / halfHeight),
  };
}

/** Whether a pitch is a strike: any part of the ball touches the zone. */
export function inZone(pitch, batter, rules = STRIKE_ZONE_RULES) {
  return zoneDistance(pitch, batter, rules).outside === 0;
}

/** The batter's body on the plate's plane (feet, as a pitch is measured): a pitch inside it hits him. */
export function bodyBox(batter, rules = STRIKE_ZONE_RULES) {
  const x = batter.bats === 'R' ? rules.batterX : -rules.batterX;
  return { x0: x - rules.body.half, x1: x + rules.body.half, z0: rules.body.bottom, z1: rules.body.top * batter.height };
}

/** Whether a pitch hits the batter. */
export function hitsBatter(pitch, batter, rules = STRIKE_ZONE_RULES) {
  const b = bodyBox(batter, rules);
  return pitch.x >= b.x0 && pitch.x <= b.x1 && pitch.z >= b.z0 && pitch.z <= b.z1;
}

/** The batter's body as a box on the screen (x0 < x1, y0 < y1, normalised). */
export function bodyScreenBox(batter, aspect, rules = STRIKE_ZONE_RULES) {
  const b = bodyBox(batter, rules);
  const a = screenForPitch({ x: b.x0, z: b.z1 }, aspect, rules);
  const c = screenForPitch({ x: b.x1, z: b.z0 }, aspect, rules);
  return { x0: Math.min(a.x, c.x), x1: Math.max(a.x, c.x), y0: Math.min(a.y, c.y), y1: Math.max(a.y, c.y) };
}

// ---- The lineups -------------------------------------------------------------------------------------

/**
 * The nine batters of each level, in batting order: a name, which side he bats, his height, and what he is good at.
 * Little Leaguers are small and swing at anything; the Pro lineup waits for its pitch and hits it hard.
 * @type {Record<import('./gap-shot-logic.js').LevelId, Batter[]>}
 */
export const LINEUPS = {
  little: [
    { name: 'Mia Park', bats: 'R', height: 4.4, eye: 0.3, contact: 0.5, power: 0.3 },
    { name: 'Noah Reyes', bats: 'R', height: 4.7, eye: 0.35, contact: 0.55, power: 0.4 },
    { name: 'Jaden Cole', bats: 'L', height: 4.9, eye: 0.3, contact: 0.5, power: 0.5 },
    { name: 'Ava Brooks', bats: 'R', height: 4.6, eye: 0.4, contact: 0.5, power: 0.35 },
    { name: 'Eli Tran', bats: 'R', height: 4.5, eye: 0.25, contact: 0.4, power: 0.45 },
    { name: 'Zoe Grant', bats: 'L', height: 4.3, eye: 0.3, contact: 0.45, power: 0.25 },
    { name: 'Owen Diaz', bats: 'R', height: 4.8, eye: 0.35, contact: 0.4, power: 0.4 },
    { name: 'Lily Chen', bats: 'R', height: 4.2, eye: 0.25, contact: 0.4, power: 0.2 },
    { name: 'Max Ortiz', bats: 'L', height: 4.6, eye: 0.3, contact: 0.35, power: 0.3 },
  ],
  high: [
    { name: 'Tyler Banks', bats: 'R', height: 5.8, eye: 0.5, contact: 0.65, power: 0.5 },
    { name: 'Marcus Webb', bats: 'L', height: 5.9, eye: 0.55, contact: 0.7, power: 0.45 },
    { name: 'Caleb Ruiz', bats: 'R', height: 6.1, eye: 0.45, contact: 0.6, power: 0.7 },
    { name: 'Dylan Foster', bats: 'R', height: 6.0, eye: 0.5, contact: 0.6, power: 0.65 },
    { name: 'Jordan Hale', bats: 'L', height: 5.7, eye: 0.45, contact: 0.55, power: 0.55 },
    { name: 'Ethan Pike', bats: 'R', height: 5.9, eye: 0.4, contact: 0.5, power: 0.5 },
    { name: 'Gavin Shaw', bats: 'R', height: 5.6, eye: 0.35, contact: 0.5, power: 0.4 },
    { name: 'Isaac Lowe', bats: 'L', height: 5.5, eye: 0.4, contact: 0.45, power: 0.35 },
    { name: 'Cole Barnes', bats: 'R', height: 5.8, eye: 0.35, contact: 0.45, power: 0.4 },
  ],
  pro: [
    { name: 'Luis Moreno', bats: 'R', height: 5.9, eye: 0.75, contact: 0.90, power: 0.60 },
    { name: 'Derek Walsh', bats: 'L', height: 6.0, eye: 0.75, contact: 0.85, power: 0.65 },
    { name: 'Marco Vega', bats: 'R', height: 6.3, eye: 0.65, contact: 0.80, power: 0.95 },
    { name: 'Jake Sullivan', bats: 'R', height: 6.2, eye: 0.65, contact: 0.80, power: 0.90 },
    { name: 'Ray Okafor', bats: 'L', height: 6.1, eye: 0.60, contact: 0.75, power: 0.85 },
    { name: 'Sam Whitfield', bats: 'R', height: 5.9, eye: 0.60, contact: 0.75, power: 0.65 },
    { name: 'Tomas Rivera', bats: 'R', height: 5.8, eye: 0.55, contact: 0.75, power: 0.60 },
    { name: 'Nate Larson', bats: 'L', height: 6.0, eye: 0.55, contact: 0.70, power: 0.55 },
    { name: 'Andre Booker', bats: 'R', height: 5.7, eye: 0.55, contact: 0.70, power: 0.50 },
  ],
};

// ---- Random numbers --------------------------------------------------------------------------------

/** A repeatable stream of numbers from 0 up to (not including) 1, for a given seed. */
export function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The stream for one pitch of a game: it depends only on the game's seed and the pitch's number. */
export function rngFor(seed, pitchNumber) {
  let h = Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul((pitchNumber | 0) + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return seededRng(h ^ (h >>> 15));
}

/** A number from a bell curve (mean 0, standard deviation 1) from a stream of uniform ones. */
export function gauss(rng) {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- What a batter does with a pitch --------------------------------------------------------------

/**
 * @typedef {object} PitchContext what the batter knows
 * @property {number} balls
 * @property {number} strikes
 * @property {number} outs
 * @property {number[]} recentMph the speeds of the last few pitches (up to 3), oldest first
 * @property {number} comfortMph the speed this level's batters handle easily
 * @property {number} levelMph how hard this level's best contact goes (Batter Up's `mph` for it)
 */

/**
 * @typedef {object} Decision
 * @property {boolean} swing
 * @property {'ball'|'calledStrike'|'swingingStrike'|'foul'|'inPlay'|'hitByPitch'} outcome
 * @property {boolean} strike whether the pitch was in the zone
 * @property {{spray:number, launch:number, speed:number, mph:number}} [hit] for `inPlay`: radians, and ft/s (and mph for show)
 * @property {{kind:'side'|'back', side:-1|1}} [foul] for `foul`: where it went (side: -1 towards the left of the screen)
 * @property {number} timing the timing error (0 on time; + early) in units where 1 is a clear mistake
 */

/**
 * What the batter does with a pitch, and how it goes: pure, with `rng` giving the chances (a seeded stream, so a
 * test or a replay gets the same answer).
 *
 * - A pitch that hits him is a hit by pitch.
 * - He swings at most pitches in the zone (about 0.7), far fewer outside it the further off it is (more of them if his
 *   `eye` is poor), more with two strikes (he protects), almost never at 3-0, and a bit less at 0-0.
 * - He expects the speed of the last few pitches (or the level's comfortable one at first): a pitch faster than that
 *   finds him late, slower early, and a big mismatch (a change-up after fast ones) is a likely miss or weak contact.
 * - Contact comes from his `contact`, less for a pitch faster than he handles, near the edge or off the zone, and
 *   mistimed. A miss is a swinging strike. Its quality is from the same things and luck: poor is a foul, else it is in
 *   play, with a launch angle from the height of the pitch (low: ground ball, high: fly or pop-up), a spray from
 *   his timing and where the pitch was (early or inside: pulled), and an exit speed from his power, the quality of the
 *   contact and a little from the pitch.
 * @param {Pitch & {mph:number}} pitch where it crossed the plate and how fast
 * @param {Batter} batter
 * @param {PitchContext} state
 * @param {() => number} rng
 * @returns {Decision}
 */
export function decidePitch(pitch, batter, state, rng, rules = STRIKE_ZONE_RULES) {
  const k = rules.batter;
  if (hitsBatter(pitch, batter, rules)) return { swing: false, outcome: 'hitByPitch', strike: false, timing: 0 };
  const zd = zoneDistance(pitch, batter, rules);
  const strike = zd.outside === 0;
  const { balls, strikes, comfortMph } = state;

  // Does he swing?
  let swingChance;
  if (strike) swingChance = k.zoneSwing - 0.15 * (batter.eye - 0.5);
  else if (zd.outside >= k.chaseNever) swingChance = 0;
  else swingChance = k.chase * (1.15 - batter.eye) * Math.exp(-zd.outside / k.chaseFall);
  if (strikes === 2) swingChance = strike ? Math.max(swingChance, 0.9) : Math.min(0.75, swingChance * 1.6);
  else if (balls === 3 && strikes === 0) swingChance *= 0.06;
  else if (balls === 3) swingChance *= 0.7;
  else if (balls === 0 && strikes === 0) swingChance *= 0.85;
  const swings = rng() < clamp(swingChance, 0, 0.97);
  if (!swings) return { swing: false, outcome: strike ? 'calledStrike' : 'ball', strike, timing: 0 };

  // Timing: early if the pitch is slower than he expects, late if faster.
  const recent = state.recentMph ?? [];
  const expected = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : comfortMph;
  const early = (expected - pitch.mph) / Math.max(6, expected * k.timingFeet);
  const timing = Math.abs(early);
  const pace = Math.max(0, (pitch.mph - comfortMph) / comfortMph);
  const awkward = Math.max(0, zd.centre - 0.5);

  // Contact, and how good it is.
  let contactChance = k.contactBase + k.contactSlope * batter.contact;
  contactChance *= 1 - Math.min(0.85, k.paceCost * pace);
  contactChance *= 1 - k.awkwardCost * Math.min(1, awkward);
  contactChance *= 1 - k.timingCost * Math.min(1, timing / 1.6);
  if (rng() >= clamp(contactChance, 0.04, 0.97)) return { swing: true, outcome: 'swingingStrike', strike, timing: early };
  const quality = k.qualityBase + k.qualitySlope * batter.contact - k.qualityPace * pace - k.qualityAwkward * awkward
    - k.qualityTiming * Math.min(1.5, timing) + k.qualityLuck * gauss(rng);
  const pull = batter.bats === 'R' ? -1 : 1; // towards the batter's pull side: negative spray, left field, for a righty
  if (quality < k.foulBelow) {
    const side = rng() < 0.65 ? pull : -pull;
    return { swing: true, outcome: 'foul', strike, timing: early, foul: { kind: rng() < 0.4 ? 'back' : 'side', side: /** @type {-1|1} */ (side * -1) } };
  }

  // In play.
  const zone = zoneOf(batter, rules);
  const high = clamp((pitch.z - (zone.top + zone.bottom) / 2) / ((zone.top - zone.bottom) / 2), -1.6, 1.6);
  const launch = clamp(k.launchBase + k.launchSlope * high + k.launchSpread * gauss(rng), -25, 70);
  const inside = pitch.x * (batter.bats === 'R' ? 1 : -1); // feet towards the batter's side
  const spray = clamp(pull * (clamp(early, -1.5, 1.5) * 17 + inside * 5) + 15 * gauss(rng), -70, 70);
  const scale = rules.levels[state.levelId ?? 'pro']?.exitScale ?? 1;
  const mph = clamp(
    state.levelMph * scale * (k.exitBase + k.exitSlope * clamp(quality, 0, 1)) * (0.8 + 0.4 * batter.power) + 0.12 * (pitch.mph - comfortMph),
    rules.exitMph.min, rules.exitMph.max,
  );
  return { swing: true, outcome: 'inPlay', strike, timing: early, hit: { spray: spray * DEG, launch: launch * DEG, speed: mphToFps(mph), mph } };
}

// ---- The inning ----------------------------------------------------------------------------------------

const NO_RUNNERS = Object.freeze({ first: false, second: false, third: false });
const WORDS = ['zero', 'one', 'two', 'three'];

/** @returns {Stats} */
function newStats() {
  return { pitches: 0, strikes: 0, balls: 0, strikeouts: 0, walks: 0, hitByPitch: 0, hits: 0, homers: 0, fouls: 0, swings: 0, misses: 0 };
}

/** The rules of Batter Up's innings, with this game's mercy rule. */
function inningRules(rules) {
  return { ...GAP_SHOT_RULES, mercyRuns: rules.mercyRuns };
}

/**
 * A new game: one inning at a level, from the top of the lineup. `seed` makes the batters' choices repeatable.
 * @param {import('./gap-shot-logic.js').LevelId} level
 * @returns {Game}
 */
export function newGame(level, seed = 1) {
  return { ...newInning(level, 1), balls: 0, pitches: 0, recent: [], atBat: [], stats: newStats(), seed };
}

/** The batter at the plate. */
export function batterFor(game) {
  const lineup = LINEUPS[game.level];
  return lineup[game.batters % lineup.length];
}

/** What the batter at the plate knows: the count, the outs, the last few speeds, and the level's numbers. */
export function contextFor(game, rules = STRIKE_ZONE_RULES) {
  return {
    balls: game.balls, strikes: game.strikes, outs: game.outs, recentMph: game.recent,
    comfortMph: rules.levels[game.level].comfortMph, levelMph: LEVELS[game.level].mph, levelId: game.level,
  };
}

/** What a pitch is: where, how fast, and whether the speed was measured (else it is the level's comfortable one). */
export function pitchFor(point, speedMph, level, rules = STRIKE_ZONE_RULES) {
  const measured = Number.isFinite(speedMph);
  return {
    x: point.x, z: point.z, measured,
    mph: measured ? clamp(speedMph, rules.mph.min, rules.mph.max) : rules.levels[level].comfortMph,
  };
}

/**
 * The runners after a walk or a hit batter: each moves up only if the one behind him is forced.
 * @param {import('./fielders-choice-logic.js').Bases} bases
 * @returns {{bases: import('./fielders-choice-logic.js').Bases, runs:number}}
 */
export function forceAdvance(bases) {
  let { first, second, third } = bases;
  let runs = 0;
  if (first && second) {
    if (third) runs = 1;
    third = true;
  }
  if (first) second = true;
  first = true;
  return { bases: { first, second, third }, runs };
}

/** The words for a ball or strike count: "Ball two", "Strike one". */
export function countWord(kind, n) {
  return `${kind} ${WORDS[n]}`;
}

/**
 * What a pitch comes to for the inning. A ball is the fourth a walk; a strike the third a strikeout; a foul a strike
 * unless there are two; a hit batter takes first; a ball in play is Batter Up's play (`plan` from `planHit`: runs, outs
 * and where the runners are afterwards, or foul). A walk, a hit batter, a strikeout and a ball in play end the batter's
 * turn: the next batter has no balls or strikes. Past the third out, or the mercy rule's runs, the inning (the game) is over.
 * @param {Game} game
 * @param {{swing:boolean, outcome: Decision['outcome']} & Pick<Decision, 'hit'>} result what the batter did
 * @param {{pitch: Pitch & {mph:number}, plan?: import('./gap-shot-play.js').Plan|null}} info the pitch, and the play for a ball in play
 * @returns {{state: Game, event: 'ball'|'strike'|'foul'|'walk'|'strikeout'|'hitByPitch'|'play', call: string, runs:number,
 *   inningOver:boolean, mercy:boolean, gameOver:boolean, batterDone:boolean}}
 */
export function applyPitch(game, result, { pitch, plan = null }, rules = STRIKE_ZONE_RULES) {
  const stats = { ...game.stats, pitches: game.stats.pitches + 1 };
  let outcome = result.outcome;
  if (outcome === 'inPlay' && plan?.foul) outcome = 'foul'; // hit fair by the bat, but it came down foul
  if (result.swing) stats.swings++;
  const base = {
    ...game,
    pitches: game.pitches + 1,
    recent: [...game.recent, pitch.mph].slice(-3),
    atBat: [...game.atBat, { x: pitch.x, z: pitch.z, outcome, mph: pitch.mph }],
    stats,
  };
  const rulesOf = inningRules(rules);
  const done = (play, event, call) => {
    const applied = applyPlay({ ...base, balls: 0 }, play, rulesOf);
    const state = { ...applied.state, balls: 0, atBat: [], stats };
    return { state, event, call, runs: applied.runs, inningOver: applied.inningOver, mercy: applied.mercy, gameOver: applied.gameOver, batterDone: true };
  };
  const stay = (event, call, change) => ({
    state: { ...base, ...change }, event, call, runs: 0, inningOver: false, mercy: false, gameOver: false, batterDone: false,
  });

  switch (outcome) {
    case 'ball': {
      stats.balls++;
      if (game.balls + 1 < rules.ballsForWalk) return stay('ball', countWord('Ball', game.balls + 1), { balls: game.balls + 1 });
      stats.walks++;
      const { bases, runs } = forceAdvance(game.bases);
      return done({ foul: false, outs: 0, runs, basesAfter: bases }, 'walk', 'Ball four — take your base');
    }
    case 'hitByPitch': {
      stats.balls++;
      stats.hitByPitch++;
      const { bases, runs } = forceAdvance(game.bases);
      return done({ foul: false, outs: 0, runs, basesAfter: bases }, 'hitByPitch', 'Hit by pitch');
    }
    case 'calledStrike':
    case 'swingingStrike': {
      stats.strikes++;
      if (outcome === 'swingingStrike') stats.misses++;
      if (game.strikes + 1 < rules.strikesForOut) return stay('strike', countWord('Strike', game.strikes + 1), { strikes: game.strikes + 1 });
      stats.strikeouts++;
      return done({ foul: false, outs: 1, runs: 0, basesAfter: { ...game.bases } }, 'strikeout', 'Strike three!');
    }
    case 'foul': {
      stats.strikes++;
      stats.fouls++;
      const applied = applyPlay(base, { foul: true, outs: 0, runs: 0, basesAfter: { ...game.bases } }, rulesOf);
      return {
        state: { ...applied.state, stats }, event: 'foul', call: 'Foul ball', runs: 0, inningOver: false, mercy: false, gameOver: false, batterDone: false,
      };
    }
    default: {
      // In play: Batter Up's play.
      stats.strikes++;
      if (plan.kind === 'hit' || plan.kind === 'homer') stats.hits++;
      if (plan.kind === 'homer') stats.homers++;
      return done(plan, 'play', plan.call);
    }
  }
}

/**
 * The inning in numbers: pitches, how many were strikes, strikeouts, walks, hit batters, hits and runs.
 * @param {Game} game
 */
export function summary(game) {
  const s = game.stats;
  return {
    pitches: s.pitches,
    strikePct: s.pitches ? Math.round((100 * s.strikes) / s.pitches) : 0,
    strikeouts: s.strikeouts,
    walks: s.walks,
    hitByPitch: s.hitByPitch,
    hits: s.hits,
    runs: game.runs,
  };
}

// ---- Best scores ----------------------------------------------------------------------------------------

/** The key best scores are saved under: one for each level. */
export function scoreKey(level) {
  return `${GAME_ID}:${level}`;
}

/** What is saved and compared, lower being better: the runs allowed, and then the pitches it took. */
export function scoreValue(runs, pitches) {
  return runs * 1000 + Math.min(999, pitches);
}

/** Whether a score beats the best saved so far (null if there is none). */
export function beatsBest(value, best) {
  return best === null || value < best;
}

/** A saved score as words: "2 runs, 31 pitches". */
export function scoreText(value) {
  const runs = Math.floor(value / 1000);
  const pitches = value % 1000;
  return `${runs} run${runs === 1 ? '' : 's'}, ${pitches} pitch${pitches === 1 ? '' : 'es'}`;
}
