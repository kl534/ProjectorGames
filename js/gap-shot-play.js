// Gap Shot's defence: what happens after a ball is hit. `planHit` follows the ball
// (gap-shot-physics.js), sends the Lamplighters after it, decides who catches it,
// where it is fielded and what the batter and the runners do, and gives back the
// whole play as a timeline: where the ball, every fielder and every runner is at any
// moment, and the call at the end. Kept free of the browser so it can be unit-tested,
// and fully deterministic: the same hit, level, runners and outs always give the same
// play. Nothing in it is random.
//
// Times are in seconds from the crack of the bat; field positions are in feet, as in
// fielders-choice-logic.js (home plate at the origin, +y out to centre field, +x towards
// first base, z up).
//
// How it decides:
// - A fielder who can be at the ball's spot (after his reaction time, running at his
//   speed, with a little reach) while it is still within the height of a glove catches
//   it: the one who gets there first, the earliest time the ball allows. That is an out.
// - Otherwise a ball over the fence in fair territory is a home run, one landing in foul
//   territory is a foul ball, and a fair ball is chased: the first fielder to reach any
//   point of its path (low enough to field) fields it there.
// - Fielded on the infield, he throws to the base the lead forced runner is running to
//   (first with nobody forced), as in Fielder's Choice; the runner is out if the throw
//   (his transfer time, then the throw, then the cover fielder catching it) is no later
//   than he is. Runners who are forced move up a base; the others stay.
// - Fielded in the outfield, every runner takes the furthest base he would still reach
//   before a throw from there would, no more than the runner ahead of him allows.
// - A caught fly with a runner on third and fewer than two outs scores him, if it was
//   caught deep enough (a sacrifice fly). Other runners hold.

import { BASES, MOUND, coveringFielder, forceTarget } from './fielders-choice-logic.js';
import { BASE_ORDER, baseSpot, fenceOf, fieldersOf } from './gap-shot-logic.js';
import { ballAt, isFair, sprayDegrees, simulateBall } from './gap-shot-physics.js';

/**
 * @typedef {{x:number, y:number}} Point
 * @typedef {{x:number, y:number, z:number}} Point3
 * @typedef {{t0:number, t1:number, from:Point, to:Point}} Segment a straight run from `from` at t0 to `to` at t1
 * @typedef {{first:boolean, second:boolean, third:boolean}} Bases
 * @typedef {object} Runner
 * @property {number} from the base the runner starts on: 0 for the batter, 1 first, 2 second, 3 third
 * @property {number} to the base he reaches (4 is home plate, scoring)
 * @property {boolean} out he is put out there
 * @property {{t:number, p:Point}[]} path where he is when, base to base (he stands still before the first and after the last)
 *
 * @typedef {object} Plan
 * @property {'homer'|'out'|'hit'|'foul'} kind
 * @property {string} call the big word: SINGLE!, DOUBLE!, TRIPLE!, HOME RUN!, OUT!, SAC FLY! or FOUL BALL!
 * @property {string} detail what happened, in a line
 * @property {number} bases how many bases the batter takes (0 if he is out or it was foul)
 * @property {number} outs 0 or 1
 * @property {number} runs
 * @property {Bases} basesAfter
 * @property {boolean} foul
 * @property {{x:number, y:number, kind:'hit'|'out'|'homer'|'foul'}} marker where it landed or was caught
 * @property {ReturnType<typeof simulateBall>} sim
 * @property {(t:number) => Point3} ball
 * @property {Record<string, Segment[]>} fielders
 * @property {Runner[]} runners
 * @property {{fielder:string|null, at:number|null, kind:'catch'|'field'|null, release:number|null, receiver:string|null, lands:number|null}} events
 * @property {number} callAt when the call is made
 * @property {number} endAt when the play is over (everyone has stopped, and the fielders have walked back)
 */

export const PLAY = {
  // A ball can be caught in the air between these heights (feet): jumping for it, or at the shoe tops.
  catchLow: 0.8,
  catchHigh: 9,
  // A ball on the ground or in a hop this low can be picked up.
  fieldHeight: 3.5,
  // Fielded this close to the mound (feet) is an infield play; further out is an outfield play.
  infieldRadius: 105,
  glove: 2.4, // how high the ball is held in a glove (feet)
  batterBox: { x: -2.8, y: 0 },
  // The batter takes this long (swing, dropping the bat, the first strides) to get going, a runner already on base less.
  batterDelay: 0.6,
  runnerDelay: 0.3,
  cornerCost: 0.12, // extra seconds for each base turned after the first
  catchPad: 0.2, // the cover fielder catching a throw and putting the tag on
  throwArc: 0.035, // how high a throw arcs, as a fraction of its length
  coverBehind: 1.5, // the cover fielder stands this far beyond his base
  callPad: 0.25, // the call comes this long after the last thing that settles it
  hold: 1.8, // the call stays up this long
  walkBack: 70, // ft/s: fielders hurry back to their spots (a cartoon's speed)
  walkBackAfter: 0.8, // after the call
  walkBackMax: 3.2, // …but no longer than this (seconds); the rest of the way is a jump
  trot: 52, // ft/s: a home run trot (a cartoon's speed again)
  trotDelay: 0.9,
  foulLinger: 0.8,
};

const DEG = Math.PI / 180;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** When a fielder can be at a spot: his reaction time, then a run there (his reach saves some of it). */
export function arrival(fielder, spot) {
  return fielder.reaction + Math.max(0, dist(fielder.spot, spot) - fielder.reach) / fielder.speed;
}

/** How long a runner takes to run from base `from` to base `to` (0 is home plate, 4 is home plate again). */
export function runTime(level, from, to) {
  const delay = from === 0 ? PLAY.batterDelay : PLAY.runnerDelay;
  return delay + ((to - from) * 90) / level.running.speed + PLAY.cornerCost * Math.max(0, to - from - 1);
}

/** The earliest moment a fielder can catch the ball in the air, or null. */
function findCatch(sim, fielders) {
  const limit = Math.min(sim.firstGround ? sim.firstGround.t : Infinity, sim.wallHits[0] ? sim.wallHits[0].t : Infinity,
    sim.overFence ? sim.overFence.t : Infinity);
  for (const s of sim.samples) {
    if (s.t > limit) break;
    if (s.z < PLAY.catchLow || s.z > PLAY.catchHigh) continue;
    let best = null;
    for (const f of Object.values(fielders)) {
      const a = arrival(f, s);
      if (a <= s.t && (!best || a < best.a)) best = { fielder: f, a };
    }
    if (best) return { fielder: best.fielder, t: s.t, x: s.x, y: s.y, z: s.z };
  }
  return null;
}

/** Where and when the ball is picked up off the ground, and by whom. */
function findPickup(sim, fielders) {
  const from = sim.firstGround.t;
  for (const s of sim.samples) {
    if (s.t < from || s.z > PLAY.fieldHeight) continue;
    let best = null;
    for (const f of Object.values(fielders)) {
      const a = arrival(f, s);
      if (a <= s.t && (!best || a < best.a)) best = { fielder: f, a };
    }
    if (best) return { fielder: best.fielder, t: s.t, x: s.x, y: s.y };
  }
  // Nobody got to it while it moved: the first to reach where it stopped.
  const end = sim.end;
  let best = null;
  for (const f of Object.values(fielders)) {
    const a = arrival(f, end);
    if (!best || a < best.a) best = { fielder: f, a };
  }
  return { fielder: best.fielder, t: Math.max(best.a, end.t), x: end.x, y: end.y };
}

/** Whether a ball that landed fair is fair: a ball that bounces in front of the bases counts where it passes them. */
function landedFair(sim) {
  const g = sim.firstGround;
  if (g.y >= BASES.first.y) return isFair(g.x, g.y);
  const past = sim.samples.find((s) => s.t >= g.t && s.y >= BASES.first.y);
  const where = past ?? sim.end;
  return isFair(where.x, where.y);
}

// ---- Tracks ---------------------------------------------------------------------

/** Where something is at `t` along straight runs (standing at the first start before, and the last end after). */
export function positionAt(segments, spot, t) {
  if (!segments.length || t <= segments[0].t0) return segments.length ? segments[0].from : spot;
  for (const s of segments) {
    if (t < s.t0) return segments[0].from;
    if (t <= s.t1) {
      const u = s.t1 > s.t0 ? (t - s.t0) / (s.t1 - s.t0) : 1;
      return { x: s.from.x + (s.to.x - s.from.x) * u, y: s.from.y + (s.to.y - s.from.y) * u };
    }
  }
  return segments[segments.length - 1].to;
}

/** Where a runner is at `t`: along the path between the bases, a straight line each way. */
export function runnerAt(runner, t) {
  const path = runner.path;
  if (t <= path[0].t) return path[0].p;
  for (let i = 1; i < path.length; i++) {
    if (t <= path[i].t) {
      const u = (t - path[i - 1].t) / (path[i].t - path[i - 1].t || 1);
      const a = path[i - 1].p;
      const b = path[i].p;
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
  }
  return path[path.length - 1].p;
}

/**
 * A runner from base `from` (0 is the batter, at the plate) who goes on to base `to`, a straight run from base
 * to base after `runTime`'s delay, or at `speed` after a trot's delay.
 */
function makeRunner(level, from, to, { out = false, start = 0, speed = null } = {}) {
  const here = from === 0 ? PLAY.batterBox : baseSpot(from);
  const path = [{ t: start, p: here }];
  if (to > from) {
    const delay = speed ? PLAY.trotDelay : from === 0 ? PLAY.batterDelay : PLAY.runnerDelay;
    path.push({ t: start + delay, p: here });
    for (let i = from + 1; i <= to; i++) {
      const t = speed ? start + delay + ((i - from) * 90) / speed : start + runTime(level, from, i);
      path.push({ t: Math.max(t, path[path.length - 1].t + 0.05), p: baseSpot(i) });
    }
  }
  return { from, to, out, path };
}

/** The ball in a throw: an arc from `from` at `t0` to `to` at `t1`. */
function throwPoint(from, to, t0, t1, t) {
  const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0 || 1)));
  const d = dist(from, to);
  return {
    x: from.x + (to.x - from.x) * u,
    y: from.y + (to.y - from.y) * u,
    z: 5.2 + (3.2 - 5.2) * u + PLAY.throwArc * d * 4 * u * (1 - u),
  };
}

/**
 * Sticks legs of the ball's journey together. Each leg is [t0, t1, at(t)]; before the first it is at
 * the start of the first, and after the last it stays where the last ends.
 */
function journey(legs) {
  return (t) => {
    for (const [t0, t1, at] of legs) {
      if (t <= t1) return at(Math.max(t, t0));
    }
    const [, t1, at] = legs[legs.length - 1];
    return at(t1);
  };
}

const NAMES = {
  P: 'pitcher', C: 'catcher', '1B': 'first baseman', '2B': 'second baseman', SS: 'shortstop', '3B': 'third baseman',
  LF: 'left fielder', CF: 'centre fielder', RF: 'right fielder',
};

function sprayWord(x, y) {
  const deg = sprayDegrees(x, y);
  if (deg < -45) return 'down the left field line';
  if (deg > 45) return 'down the right field line';
  if (Math.abs(deg) < 9) return 'to centre field';
  if (Math.abs(deg) < 24) return deg < 0 ? 'to left-centre' : 'to right-centre';
  return deg < 0 ? 'to left field' : 'to right field';
}

/**
 * The play for a ball hit at this spray and launch angle, and speed (the level's, unless the hit has its own).
 * @param {{spray:number, launch:number, speed?:number}} hit radians, and ft/s
 * @param {import('./gap-shot-logic.js').Level} level
 * @param {Bases} bases the runners on base
 * @param {number} outs outs before this swing
 * @returns {Plan}
 */
export function planHit(hit, level, bases, outs) {
  const fence = fenceOf(level);
  const fielders = fieldersOf(level);
  const speed = hit.speed ?? level.speed;
  const sim = simulateBall({ speed, spray: hit.spray, launch: hit.launch }, fence);
  const ctx = { hit, speed, level, bases, outs, sim, fence, fielders };

  const caught = findCatch(sim, fielders);
  if (caught) return caughtPlan(ctx, caught);
  if (sim.overFence && isFair(sim.overFence.x, sim.overFence.y)) return homerPlan(ctx);
  // A ball that left the park in foul territory without landing is foul too.
  if (!sim.firstGround || !landedFair(sim)) return foulPlan(ctx);
  const pickup = findPickup(sim, fielders);
  const infield = Math.hypot(pickup.x - MOUND.x, pickup.y - MOUND.y) <= PLAY.infieldRadius;
  return infield ? infieldPlan(ctx, pickup) : outfieldPlan(ctx, pickup);
}

/** The runners on base, lead first, as [base index, ...]. */
function onBase(bases) {
  return [3, 2, 1].filter((i) => bases[BASE_ORDER[i]]);
}

/** Everyone standing still at their spots. */
function standing(fielders) {
  return Object.fromEntries(Object.keys(fielders).map((id) => [id, []]));
}

/**
 * After the call, the fielders hurry back to where they stand, as far as they can in a few seconds (a
 * cartoon's speed). Anyone with further to go than that is at his spot when the camera cuts back.
 * @returns {number} when the last of them has got as far as he goes
 */
function walkBack(fielders, tracks, callAt) {
  const start = callAt + PLAY.walkBackAfter;
  let end = callAt + PLAY.hold;
  for (const f of Object.values(fielders)) {
    const segs = tracks[f.id];
    const last = segs.length ? segs[segs.length - 1] : null;
    const at = last ? last.to : f.spot;
    const d = dist(at, f.spot);
    if (d < 0.5) continue;
    const t0 = Math.max(start, last ? last.t1 : start);
    const go = Math.min(d, PLAY.walkBackMax * PLAY.walkBack);
    const t1 = t0 + go / PLAY.walkBack;
    segs.push({ t0, t1, from: at, to: { x: at.x + ((f.spot.x - at.x) * go) / d, y: at.y + ((f.spot.y - at.y) * go) / d } });
    end = Math.max(end, t1);
  }
  return end;
}

function finish(plan, fielders) {
  const endAt = walkBack(fielders, plan.fielders, plan.callAt);
  plan.endAt = Math.max(endAt, plan.callAt + PLAY.hold);
  return plan;
}

function basesFrom(runners) {
  const bases = { first: false, second: false, third: false };
  for (const r of runners) if (!r.out && r.to >= 1 && r.to <= 3) bases[BASE_ORDER[r.to]] = true;
  return bases;
}

// ---- A ball caught in the air ---------------------------------------------------

function caughtPlan(ctx, caught) {
  const { level, bases, outs, hit, sim, fielders } = ctx;
  const f = caught.fielder;
  const at = { x: caught.x, y: caught.y };
  const depth = Math.hypot(at.x, at.y);
  const foul = !isFair(at.x, at.y);
  const sacFly = bases.third && outs < 2 && depth >= level.sacDepth;
  const tracks = standing(fielders);
  tracks[f.id].push({ t0: f.reaction, t1: caught.t, from: f.spot, to: at });
  const runners = [];
  let runs = 0;
  // Everyone stays put (they tag up and hold), but for a runner scoring on a deep fly.
  for (const i of onBase(bases)) {
    if (i === 3 && sacFly) {
      runners.push(makeRunner(level, 3, 4, { start: caught.t }));
      runs = 1;
    } else {
      runners.push(makeRunner(level, i, i));
    }
  }
  const scoreAt = sacFly ? runners.find((r) => r.from === 3).path.at(-1).t : 0;
  const callAt = Math.max(caught.t, scoreAt) + PLAY.callPad;
  const kind = hit.launch > 50 * DEG ? 'Pop out' : hit.launch > 25 * DEG ? 'Fly out' : 'Line out';
  const glove = { x: at.x, y: at.y, z: Math.min(7, Math.max(PLAY.glove, caught.z)) };
  const ball = journey([flightLeg(sim, caught.t), [caught.t, Infinity, () => glove]]);
  const resultBases = { first: bases.first, second: bases.second, third: bases.third && !sacFly };
  const outsNow = 1;
  if (outs + outsNow >= 3) runs = 0;
  const plan = {
    kind: 'out',
    call: sacFly && runs ? 'SAC FLY!' : 'OUT!',
    detail: `${kind} to the ${NAMES[f.id]}${foul ? ' in foul territory' : ''}${sacFly && runs ? ' – the run scores' : ''}`,
    bases: 0,
    outs: outsNow,
    runs,
    basesAfter: outs + outsNow >= 3 ? { first: false, second: false, third: false } : resultBases,
    foul,
    marker: { x: at.x, y: at.y, kind: 'out' },
    sim,
    ball,
    fielders: tracks,
    runners,
    events: { fielder: f.id, at: caught.t, kind: 'catch', release: null, receiver: null, lands: null },
    callAt,
    endAt: 0,
  };
  return finish(plan, fielders);
}

// ---- A home run ------------------------------------------------------------------

function homerPlan(ctx) {
  const { level, bases, hit, speed, sim, fielders } = ctx;
  const over = sim.overFence;
  // The ball keeps going, for the picture: the same flight with no fence.
  const free = simulateBall({ speed, spray: hit.spray, launch: hit.launch }, { radiusAt: () => 1e5, height: 0 });
  const runners = [];
  // Everyone circles the bases, the lead runner first and the batter last, and scores.
  for (const i of onBase(bases)) runners.push(makeRunner(level, i, 4, { start: 0.5, speed: PLAY.trot }));
  runners.push(makeRunner(level, 0, 4, { start: 0.2, speed: PLAY.trot }));
  const runs = runners.length;
  const last = runners.reduce((m, r) => Math.max(m, r.path[r.path.length - 1].t), 0);
  const callAt = over.t + 0.3;
  const ball = journey([flightLeg(free, free.end.t)]);
  const plan = {
    kind: 'homer',
    call: 'HOME RUN!',
    detail: runs === 1 ? `Over the fence ${sprayWord(over.x, over.y)}` : `Over the fence ${sprayWord(over.x, over.y)}: ${runs} runs score`,
    bases: 4,
    outs: 0,
    runs,
    basesAfter: { first: false, second: false, third: false },
    foul: false,
    marker: { x: over.x, y: over.y, kind: 'homer' },
    sim,
    ball,
    fielders: standing(fielders),
    runners,
    events: { fielder: null, at: null, kind: null, release: null, receiver: null, lands: free.firstGround ? free.firstGround.t : null },
    callAt,
    endAt: 0,
  };
  const plan2 = finish(plan, fielders);
  plan2.endAt = Math.max(plan2.endAt, last + 0.8);
  return plan2;
}

// ---- A foul ball ------------------------------------------------------------------

function foulPlan(ctx) {
  const { sim, fielders } = ctx;
  const g = sim.firstGround ?? { t: sim.end.t, x: sim.end.x, y: sim.end.y };
  const ball = journey([flightLeg(sim, sim.end.t)]);
  const callAt = g.t + 0.35;
  const plan = {
    kind: 'foul',
    call: 'FOUL BALL!',
    detail: 'Foul',
    bases: 0,
    outs: 0,
    runs: 0,
    basesAfter: { ...ctx.bases },
    foul: true,
    marker: { x: g.x, y: g.y, kind: 'foul' },
    sim,
    ball,
    fielders: standing(fielders),
    runners: onBase(ctx.bases).map((i) => makeRunner(ctx.level, i, i)),
    events: { fielder: null, at: null, kind: null, release: null, receiver: null, lands: g.t },
    callAt,
    endAt: 0,
  };
  const out = finish(plan, fielders);
  out.endAt = Math.max(g.t + PLAY.foulLinger + 0.8, callAt + 1.1);
  return out;
}

// ---- Throws -------------------------------------------------------------------------

/**
 * Sends the fielder who has the ball at `pickup` to throw to base `target` (a base name), with the cover
 * fielder running to it. Adds their runs to the tracks.
 * `relay` is the extra seconds a throw from the outfield takes, going through the cut-off man.
 * @returns {{receiver:string, self:boolean, release:number, arrives:number, covered:number}} when the ball gets to the base's cover
 *   fielder (`arrives`), and when that fielder is there to take it (`covered`)
 */
function throwTo(ctx, pickup, target, tracks, relay = 0) {
  const f = pickup.fielder;
  const base = BASES[target];
  const coverId = coveringFielder(f.id, target);
  const cover = ctx.fielders[coverId];
  const self = coverId === f.id;
  const from = { x: pickup.x, y: pickup.y };
  const d = dist(from, base);
  const along = { x: (base.x - from.x) / (d || 1), y: (base.y - from.y) / (d || 1) };
  const stand = { x: base.x + along.x * PLAY.coverBehind, y: base.y + along.y * PLAY.coverBehind };
  if (self) {
    // He carries it to the bag himself.
    const t0 = pickup.t + f.transfer * 0.35;
    const t1 = t0 + dist(from, stand) / f.speed;
    tracks[f.id].push({ t0, t1, from, to: stand });
    return { receiver: f.id, self, release: t0, arrives: t1, covered: t1, from, stand };
  }
  const release = pickup.t + f.transfer;
  const arrives = release + d / f.throwSpeed + relay;
  const covered = cover.reaction + dist(cover.spot, stand) / cover.speed;
  tracks[cover.id].push({ t0: cover.reaction, t1: Math.max(covered, cover.reaction + 0.1), from: cover.spot, to: stand });
  return { receiver: cover.id, self, release, arrives, covered, from, stand };
}

/** The ball's journey from the moment it is picked up: held, thrown (or carried) and held by the cover fielder. */
function carryLegs(pickup, th) {
  const held = { x: pickup.x, y: pickup.y, z: PLAY.glove };
  const stand = th.stand;
  const legs = [[pickup.t, th.release, () => held]];
  if (th.self) {
    legs.push([th.release, th.arrives, (t) => {
      const u = (t - th.release) / (th.arrives - th.release || 1);
      return { x: th.from.x + (stand.x - th.from.x) * u, y: th.from.y + (stand.y - th.from.y) * u, z: PLAY.glove };
    }]);
    legs.push([th.arrives, Infinity, () => ({ x: stand.x, y: stand.y, z: PLAY.glove })]);
  } else {
    legs.push([th.release, th.arrives, (t) => throwPoint(th.from, stand, th.release, th.arrives, t)]);
    legs.push([th.arrives, Infinity, () => ({ x: stand.x, y: stand.y, z: PLAY.glove + 0.8 })]);
  }
  return legs;
}

/** The ball in flight, from the bat. */
function flightLeg(sim, until) {
  return [0, until, (t) => {
    const b = ballAt(sim.samples, t);
    return { x: b.x, y: b.y, z: b.z };
  }];
}

// ---- The infield --------------------------------------------------------------------

function infieldPlan(ctx, pickup) {
  const { level, bases, outs, sim, fielders } = ctx;
  const f = pickup.fielder;
  const tracks = standing(fielders);
  const at = { x: pickup.x, y: pickup.y };
  tracks[f.id].push({ t0: f.reaction, t1: Math.max(pickup.t, f.reaction + 0.05), from: f.spot, to: at });
  const target = forceTarget(bases);
  const targetIdx = BASE_ORDER.indexOf(target, 1);
  const th = throwTo(ctx, pickup, target, tracks);
  const catchAt = Math.max(th.arrives, th.covered) + (th.self ? 0 : PLAY.catchPad);
  const forcedFrom = targetIdx - 1; // the runner the throw is for starts one base back
  const arriveAt = runTime(level, forcedFrom, targetIdx);
  const out = catchAt <= arriveAt;

  // Every forced runner moves up a base: the batter, the runner on first, and so on up while first is taken.
  const runners = [];
  const forced = [0];
  for (let i = 1; i <= 3; i++) {
    if (bases[BASE_ORDER[i]] && forced.includes(i - 1)) forced.push(i);
  }
  for (const i of onBase(bases)) {
    if (forced.includes(i)) {
      runners.push(makeRunner(level, i, i + 1, i === forcedFrom ? { out } : {}));
    } else {
      runners.push(makeRunner(level, i, i));
    }
  }
  const batterOut = out && forcedFrom === 0;
  runners.push(makeRunner(level, 0, 1, batterOut ? { out: true } : {}));
  let runs = runners.filter((r) => !r.out && r.to === 4).length;
  const outCount = out ? 1 : 0;
  let basesAfter = basesFrom(runners);
  if (outs + outCount >= 3) {
    runs = 0;
    basesAfter = { first: false, second: false, third: false };
  }

  const settles = out ? catchAt : Math.max(arriveAt, catchAt);
  const callAt = settles + PLAY.callPad;
  const ball = journey([flightLeg(sim, pickup.t), ...carryLegs(pickup, th)]);

  const targetWord = { first: 'first', second: 'second', third: 'third', home: 'home' }[target];
  let call;
  let detail;
  if (out) {
    call = 'OUT!';
    detail = forcedFrom === 0
      ? `Grounded out, ${NAMES[f.id]} to ${targetWord}`
      : `Forced out at ${targetWord}`;
  } else {
    call = 'SINGLE!';
    detail = forcedFrom === 0 ? 'Infield single' : `Safe at ${targetWord}: infield single`;
  }
  const plan = {
    kind: out ? 'out' : 'hit',
    call,
    detail,
    bases: batterOut ? 0 : 1,
    outs: outCount,
    runs,
    basesAfter,
    foul: false,
    marker: { x: at.x, y: at.y, kind: out ? 'out' : 'hit' },
    sim,
    ball,
    fielders: tracks,
    runners,
    events: { fielder: f.id, at: pickup.t, kind: 'field', release: th.release, receiver: th.receiver, lands: sim.firstGround.t },
    callAt,
    endAt: 0,
  };
  const done = finish(plan, fielders);
  // The runners are still running when the call is made on a throw that beat them.
  const lastRun = runners.reduce((m, r) => Math.max(m, r.path[r.path.length - 1].t), 0);
  done.endAt = Math.max(done.endAt, lastRun + 0.6);
  return done;
}

// ---- The outfield -------------------------------------------------------------------

function outfieldPlan(ctx, pickup) {
  const { level, bases, sim, fielders } = ctx;
  const f = pickup.fielder;
  const tracks = standing(fielders);
  const at = { x: pickup.x, y: pickup.y };
  tracks[f.id].push({ t0: f.reaction, t1: Math.max(pickup.t, f.reaction + 0.05), from: f.spot, to: at });
  const release = pickup.t + f.transfer;
  // When a throw from here would get to each base.
  const throwArrives = (base) => release + dist(at, baseSpot(base)) / f.throwSpeed + level.fielding.relay + PLAY.catchPad;

  // Each runner, lead first, takes the furthest base he would reach before the throw, never beyond the runner ahead.
  const order = [...onBase(bases), 0];
  const dest = new Map();
  let limit = 5; // the base the runner ahead has reached (4 scores, so the next can too)
  for (const from of order) {
    const forced = from === 0 || (from <= 3 && [...Array(from).keys()].every((i) => i === 0 || bases[BASE_ORDER[i]]));
    let to = from + (forced ? 1 : 0);
    for (let k = to + 1; k <= 4; k++) {
      if (runTime(level, from, k) <= throwArrives(k)) to = k;
      else break;
    }
    // Not past, or onto, the runner ahead (unless he scores).
    if (limit <= 3) to = Math.min(to, limit - 1);
    to = Math.max(to, from);
    dest.set(from, to);
    limit = to === 4 ? 5 : to;
  }

  const runners = order.map((from) => makeRunner(level, from, dest.get(from)));
  const batterTo = dest.get(0);
  const runs = runners.filter((r) => r.to === 4).length;
  // The throw goes to the base ahead of the batter (home if he scored), where the ball is held.
  const throwBase = batterTo >= 4 ? 'home' : BASE_ORDER[batterTo + 1];
  const th = throwTo(ctx, pickup, throwBase, tracks, level.fielding.relay);
  const batterArrives = runners.find((r) => r.from === 0).path.at(-1).t;
  const last = runners.reduce((m, r) => Math.max(m, r.path.at(-1).t), 0);
  const callAt = Math.max(batterArrives, th.arrives) + PLAY.callPad;
  const ball = journey([flightLeg(sim, pickup.t), ...carryLegs(pickup, th)]);
  const call = ['', 'SINGLE!', 'DOUBLE!', 'TRIPLE!', 'HOME RUN!'][batterTo];
  const plan = {
    kind: 'hit',
    call,
    detail: `${['', 'Single', 'Double', 'Triple', 'Inside-the-park home run'][batterTo]} ${sprayWord(at.x, at.y)}${runs ? `: ${runs} run${runs === 1 ? '' : 's'} score${runs === 1 ? 's' : ''}` : ''}`,
    bases: batterTo,
    outs: 0,
    runs,
    basesAfter: basesFrom(runners),
    foul: false,
    marker: { x: sim.firstGround.x, y: sim.firstGround.y, kind: batterTo === 4 ? 'homer' : 'hit' },
    sim,
    ball,
    fielders: tracks,
    runners,
    events: { fielder: f.id, at: pickup.t, kind: 'field', release: th.release, receiver: th.receiver, lands: sim.firstGround.t },
    callAt,
    endAt: 0,
  };
  const done = finish(plan, fielders);
  done.endAt = Math.max(done.endAt, last + 0.6);
  return done;
}
