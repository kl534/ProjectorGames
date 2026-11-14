// Batting Practice rules, kept free of the browser so they can be unit-tested: how a swing (a `Hit`
// from the cameras, or a click) becomes a shot with its ball-flight numbers and outcome, the session's
// statistics and records, and the timing budget that has the screen still and ready for the next swing
// soon after a hit.
//
// The ball is a real baseball, flown with Gap Shot's physics (gap-shot-physics.js) at the speed and
// angles the cameras measured, as HitTrax does it, and the outcome is Gap Shot's defence (planHit) with
// nobody on base and nobody out. Field positions are in feet as in gap-shot-logic.js (home plate at the
// origin, +y out to centre field, +x towards first base); angles are radians in a shot (the spray from
// straight out to centre field, + towards first base; the launch angle up from level) and degrees where a
// name says so.

import { mphText } from './format.js';
import { BATTER_VIEW, fenceOf, hitFor } from './gap-shot-logic.js';
import { simulateBall, sprayDegrees } from './gap-shot-physics.js';
import { planHit } from './gap-shot-play.js';

/**
 * @typedef {import('./gap-shot-logic.js').Level} Level
 * @typedef {import('./gap-shot-logic.js').LevelId} LevelId
 * @typedef {'single'|'double'|'triple'|'homer'|'out'|'foul'} OutcomeId
 * @typedef {{id: OutcomeId, word: string, kind: 'hit'|'out'|'homer'|'foul'}} Outcome the outcome, its big word
 *   and what its dot looks like (gap-shot-scene.js's MARKER_COLOURS)
 *
 * @typedef {object} Shot one swing
 * @property {LevelId} level
 * @property {boolean} measured how it left the bat was measured: both cameras followed it from the bat
 *   (`Hit.launch`) with the screen's width known, so its speed, launch angle and spray are real. Anything
 *   else is an estimate (est.): from where and how it arrived at the screen, or from a click.
 * @property {number} spray radians
 * @property {number} launch radians
 * @property {number} speed ft/s off the bat
 * @property {number|null} mph the exit speed in mph, if some camera measured one (an estimate unless `measured`)
 * @property {Outcome} outcome
 * @property {number} carry feet from home plate to where it first comes down (the distance)
 * @property {number} total feet from home plate to where it stops, with no fence or fielder in the way
 * @property {number} hang seconds from the bat to where it first comes down
 * @property {number} apex feet above the ground at the top of its flight
 * @property {{x:number, y:number}} landing where it comes down, as projected
 * @property {{x:number, y:number, kind: Outcome['kind']}} spot where its dot is drawn: the landing, brought in
 *   to the fence if it would have come down beyond it
 */

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const GAME_ID = 'batting-practice';

export const BATTING_PRACTICE_RULES = {
  // A ball hit this hard (mph) is a hard-hit ball: MLB's definition.
  hardHitMph: 95,
  // The swings the recent-shots table shows.
  recentShots: 8,
  // A ball that rolls on this much further than it carried (feet) shows where it stopped too.
  rollShownFt: 30,
};

/** The times that make up a swing's replay, and what the screen is allowed to cost the next swing (ms). */
export const TIMING = {
  // The screen is still and ready for the next swing no more than this long after a hit arrives…
  budgetMs: 3000,
  // …which is the camera's settling time (throw-camera.js's SETTLE_MS, told to the camera along with the replay's
  // length) plus this much more, as Gap Shot allows (its READY_MS)…
  settleExtraMs: 300,
  // …and what is left is the replay: the ball's flight, sped up to fit between these (twice as fast as it
  // happened, but not shorter or longer than these)…
  flightMinMs: 600,
  flightMaxMs: 1400,
  speedUp: 2,
  // …and the moment the landing marker is up before the picture is left still, and a little to spare for timers and
  // frames that come late. So at most 1400 + 300 + 900 + 300 + 100 = 3000.
  markerMs: 300,
  slackMs: 100,
};

/** How long the ball's flight takes on the screen, for a ball in the air `hangSeconds`. */
export function flightMsFor(hangSeconds) {
  return clamp((hangSeconds * 1000) / TIMING.speedUp, TIMING.flightMinMs, TIMING.flightMaxMs);
}

/** How long the whole replay lasts: the flight, then the marker. */
export function replayMsFor(hangSeconds) {
  return flightMsFor(hangSeconds) + TIMING.markerMs;
}

/** How long after the replay the next swing can be taken, given the camera's settling time (ms). */
export function readyAfterMs(settleMs) {
  return settleMs + TIMING.settleExtraMs;
}

/** How long after a hit the screen is still and ready, for a ball in the air `hangSeconds`. */
export function readyByMs(hangSeconds, settleMs) {
  return replayMsFor(hangSeconds) + readyAfterMs(settleMs);
}

// ---- A swing ----------------------------------------------------------------

const NO_RUNNERS = Object.freeze({ first: false, second: false, third: false });
// No fence and no fielders: the flight as if the park were open, for the numbers (HitTrax's "projected distance").
const OPEN_FENCE = { radiusAt: () => 1e5, height: 0 };

export const OUTCOMES = {
  single: 'Single', double: 'Double', triple: 'Triple', homer: 'Home run', out: 'Out', foul: 'Foul',
};
export const OUTCOME_IDS = /** @type {OutcomeId[]} */ (Object.keys(OUTCOMES));

/**
 * What a play comes to, in the words of the outcome: the plan's call (SINGLE!, OUT!, FOUL BALL!…), and for an
 * out, how it was made (the plan says: caught in the air, or fielded on the ground; a ball caught in the air is
 * a pop, fly or line out by its launch angle, as the plan's own detail has it).
 * @param {import('./gap-shot-play.js').Plan} plan
 * @param {number} launch radians
 * @returns {Outcome}
 */
export function outcomeOf(plan, launch) {
  const kind = plan.marker.kind;
  if (plan.kind === 'homer' || plan.bases === 4) return { id: 'homer', word: 'HOME RUN', kind };
  if (plan.kind === 'foul') return { id: 'foul', word: 'FOUL', kind };
  if (plan.kind === 'hit') {
    const id = /** @type {OutcomeId} */ (['', 'single', 'double', 'triple'][plan.bases]);
    return { id, word: id.toUpperCase(), kind };
  }
  let word = 'GROUND OUT';
  if (plan.events.kind === 'catch') word = launch > 50 * DEG ? 'POP OUT' : launch > 25 * DEG ? 'FLY OUT' : 'LINE OUT';
  return { id: 'out', word, kind };
}

/**
 * A swing as a shot. `hit` is what the cameras reported (or a click, which has only x and y).
 * Where both cameras followed the ball from the bat (`hit.launch`) and the screen's width was known, the
 * exit speed, launch angle and spray are what they measured: the spray is the launch's azimuth (the ballpark
 * does not fill the screen here, so a spot on the screen is not a direction as it is in Gap Shot). Anything
 * else is an estimate: `hitFor` takes the launch angle and speed from how the ball arrived at the screen where the
 * cameras saw that, and else from the level (no speed shown), and the spray from where it hit the screen.
 * Both are kept to the limits of Gap Shot's batter's view (launch -20 to 75 degrees, spray within 80 of
 * straight ahead): a bat can't send a ball any further down or sideways, and a camera that misjudges a ball
 * can't send it into orbit.
 * @param {{x:number, y:number, launch?: import('./throw-tracker.js').Launch|null}} hit
 * @param {number} aspect the whole screen's width over its height (for a spot on it)
 * @param {Level} level
 * @returns {Shot}
 */
export function shotFor(hit, aspect, level) {
  const aimed = hitFor(hit, aspect, level);
  const launched = hit.launch ?? null;
  const azimuth = launched && Number.isFinite(launched.azimuth) ? launched.azimuth : null;
  const spray = azimuth === null ? aimed.spray : clamp(azimuth * DEG, -BATTER_VIEW.spray.max, BATTER_VIEW.spray.max);
  const measured = azimuth !== null && Number.isFinite(launched.elevation) && aimed.mph !== null;

  const plan = planHit({ spray, launch: aimed.launch, speed: aimed.speed }, level, NO_RUNNERS, 0);
  const flight = simulateBall({ speed: aimed.speed, spray, launch: aimed.launch }, OPEN_FENCE);
  const land = flight.firstGround ?? flight.end;
  const landT = land.t;
  let apex = 0;
  for (const s of flight.samples) {
    if (s.t > landT) break;
    apex = Math.max(apex, s.z);
  }
  const outcome = outcomeOf(plan, aimed.launch);
  const landing = { x: land.x, y: land.y };
  return {
    level: level.id,
    measured,
    spray,
    launch: aimed.launch,
    speed: aimed.speed,
    mph: aimed.mph,
    outcome,
    carry: Math.hypot(land.x, land.y),
    total: Math.hypot(flight.end.x, flight.end.y),
    hang: landT,
    apex,
    landing,
    spot: { ...spotFor(landing, level, outcome.kind), kind: outcome.kind },
  };
}

/** Where a landing is drawn: where it came down, but no further out than the fence (a home run's dot is on it). */
export function spotFor(landing, level, kind) {
  const deg = clamp(sprayDegrees(landing.x, landing.y), -45, 45);
  const wall = fenceOf(level).radiusAt(deg);
  const limit = kind === 'homer' ? wall : wall - 4;
  const r = Math.hypot(landing.x, landing.y);
  if (r <= limit || r === 0) return { x: landing.x, y: landing.y };
  return { x: (landing.x * limit) / r, y: (landing.y * limit) / r };
}

// ---- What a shot says ---------------------------------------------------------

/**
 * A shot as the screen shows it, in words and units.
 * @param {Shot} shot
 */
export function shotText(shot) {
  const degrees = (r) => Math.round(r / DEG);
  const across = degrees(shot.spray);
  const rolls = shot.total - shot.carry >= BATTING_PRACTICE_RULES.rollShownFt;
  return {
    word: shot.outcome.word,
    est: !shot.measured,
    ev: shot.mph === null ? '—' : mphText(shot.mph),
    launch: `${degrees(shot.launch)}°`,
    spray: across === 0 ? '0°' : `${Math.abs(across)}° ${across > 0 ? 'R' : 'L'}`,
    distance: `${Math.round(shot.carry)} ft`,
    total: rolls ? `${Math.round(shot.total)} ft` : null,
    hang: `${shot.hang.toFixed(1)} s`,
    apex: `${Math.round(shot.apex)} ft`,
  };
}

// ---- The session ----------------------------------------------------------------

/**
 * @typedef {object} Session
 * @property {LevelId} level
 * @property {Shot[]} shots every swing, oldest first
 * @property {number} measured swings whose numbers were measured
 * @property {number} mphSum exit speeds added up over the measured swings
 * @property {number} maxMph
 * @property {number} longest feet, over the measured swings
 * @property {number} hardHits measured swings at or above the hard-hit speed
 * @property {Record<OutcomeId, number>} counts every swing by outcome, estimated ones too
 */

/** @returns {Session} */
export function newSession(level) {
  return {
    level, shots: [], measured: 0, mphSum: 0, maxMph: 0, longest: 0, hardHits: 0, counts: Object.fromEntries(OUTCOME_IDS.map((id) => [id, 0])),
  };
}

/**
 * The session with a swing added. An estimated swing counts as a swing and in the outcomes, but is left out of
 * the averages, the maxes and the hard-hit rate: they are of what was measured.
 * @param {Session} session
 * @param {Shot} shot
 * @returns {Session}
 */
export function addShot(session, shot) {
  const next = { ...session, shots: [...session.shots, shot], counts: { ...session.counts } };
  next.counts[shot.outcome.id]++;
  if (shot.measured && shot.mph !== null) {
    next.measured++;
    next.mphSum += shot.mph;
    next.maxMph = Math.max(next.maxMph, shot.mph);
    next.longest = Math.max(next.longest, shot.carry);
    if (shot.mph >= BATTING_PRACTICE_RULES.hardHitMph) next.hardHits++;
  }
  return next;
}

/**
 * What the session panel shows. Numbers from measured swings are null until there is one.
 * @param {Session} session
 */
export function summary(session) {
  const m = session.measured;
  return {
    swings: session.shots.length,
    measured: m,
    avgMph: m ? session.mphSum / m : null,
    maxMph: m ? session.maxMph : null,
    longest: m ? session.longest : null,
    hardHitPct: m ? Math.round((session.hardHits / m) * 100) : null,
    counts: session.counts,
  };
}

/** The last swings, newest first. */
export function recentShots(session, n = BATTING_PRACTICE_RULES.recentShots) {
  return session.shots.slice(-n).reverse();
}

// ---- Personal bests ----------------------------------------------------------------

/** The key a level's best of one thing is saved under (storage.js's best scores): 'exit-velocity' or 'distance'. */
export function bestKey(level, metric) {
  return `${GAME_ID}:${level}:${metric}`;
}

/**
 * The personal bests for a level, with a swing's set against them: only a measured swing can set one.
 * Exit speed is kept to a tenth of a mph and distance to a foot.
 * @param {{mph:number, distance:number}} bests what is saved (0 for none)
 * @param {Shot} shot
 * @returns {{bests: {mph:number, distance:number}, newMph: boolean, newDistance: boolean}}
 */
export function updateBests(bests, shot) {
  if (!shot.measured) return { bests, newMph: false, newDistance: false };
  const mph = shot.mph === null ? 0 : Math.round(shot.mph * 10) / 10;
  const distance = Math.round(shot.carry);
  const newMph = mph > bests.mph;
  const newDistance = distance > bests.distance;
  return { bests: { mph: newMph ? mph : bests.mph, distance: newDistance ? distance : bests.distance }, newMph, newDistance };
}
