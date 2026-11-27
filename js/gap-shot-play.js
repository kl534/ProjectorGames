// Batter Up's defence: what happens after a ball is hit. `planHit` follows the ball
// (gap-shot-physics.js), sends the Lamplighters after it, decides who catches it,
// where it is fielded, where the ball is thrown and what the batter and the runners
// do, and gives back the whole play as a timeline: where the ball, every fielder and
// every runner is at any moment, and the call at the end. Kept free of the browser so
// it can be unit-tested, and fully deterministic: the same hit, level, runners and
// outs always give the same play. Nothing in it is random.
//
// Times are in seconds from the crack of the bat; field positions are in feet, as in
// fielders-choice-logic.js (home plate at the origin, +y out to centre field, +x towards
// first base, z up).
//
// How the Lamplighters play it, as a real team is taught to:
// - A ball in the air is caught by whoever calls for it. Of the fielders who can get
//   under it in time to settle (`camp`), the one with priority takes it: the centre
//   fielder over the corner outfielders, outfielders coming in over infielders going
//   out, the middle infielders over the corners, the pitcher last (`PRIORITY`, a head
//   start in seconds, so a man much nearer still takes it). A ball nobody can settle
//   under is caught by whoever gets to it first, on the run, with a dive or a leap. A
//   ball just over a low enough fence can be pulled back by a leap at the wall.
// - A ball on the ground is fielded by the first fielder who can cut it off, but the
//   first baseman leaves one the second baseman can get to (he goes back to the bag),
//   and the pitcher one behind the mound that a middle infielder can.
// - On the infield, the fielder takes the out that matters most among those he can
//   make: a double play (a force at second, third or home, and the pivot man's throw on
//   to first) with fewer than two outs, then a runner trying to score, then the lead
//   runner, then the batter; with two outs, the surest out. A runner forced to a base
//   is out when the ball beats him there; one who is not has to be tagged. A fielder
//   near the bag takes it there himself; a first baseman pulled off the bag throws to
//   the pitcher covering. If there is no play anywhere, he doesn't throw it away.
// - Runners read the ball. On the ground they go on contact if they are forced, or
//   with two outs; a runner on second takes third on a ball hit behind him, and a
//   runner on third goes home on a ball to the right side or (with one out) through
//   the middle. On a ball in the air with fewer than two outs they go halfway (third
//   tags up) and only run on once it drops. With two outs everyone runs on contact.
// - On a hit to the outfield each runner, lead first, takes the furthest base he would
//   still reach before the throw, by the margin his coach asks for (`SEND`: careful
//   with nobody out, never making the first or the third out at third, and sending a
//   runner home with two outs even on a close play). The outfielder throws to the lead
//   runner he can get; with no play anywhere, to the base ahead of the batter. A long
//   throw goes to a relay man (the middle infielder on the ball's side), and a throw in
//   on a line through a cut-off man; the others cover the bases and back them up.
//   Trailing runners move up on a throw home or to third when the catcher or third
//   baseman couldn't throw them out in turn.
// - A caught fly with fewer than two outs: each runner tags up and goes if he would beat
//   the throw by his coach's margin (a sacrifice fly, from third); the others go halfway
//   on a fly that might drop and come back. The ball is thrown to the base the lead
//   runner goes for, or in to second when nobody goes.
// - On a third out that is a force (or the batter at first) no runs count; on a tag out,
//   only the runs that crossed the plate before it (a time play).
// - Nobody throws a ball to an empty base: each throw is let go when it will reach the
//   next man as he gets there (no later than it would have anyway), so the ball is
//   always in the air or in someone's glove, and a held ball goes where he goes.
// - They run as people do: speeding up from a standing start (`ramp`) and slowing to a
//   stop where they stop (`stop`), at the same average speed as before (a level's
//   `speed` is the average over a chase).

import { BASES, MOUND, coveringFielder } from './fielders-choice-logic.js';
import { BASE_ORDER, baseSpot, fenceOf, fieldersOf } from './gap-shot-logic.js';
import { PHYSICS, ballAt, isFair, sprayDegrees, simulateBall } from './gap-shot-physics.js';

/**
 * @typedef {{x:number, y:number}} Point
 * @typedef {{x:number, y:number, z:number}} Point3
 * @typedef {{t0:number, t1:number, from:Point, to:Point, ease?:[number, number]}} Segment a run from `from` at t0 to
 *   `to` at t1; `ease` is how long (seconds) he takes to get up to speed at the start and to stop at the end
 * @typedef {{first:boolean, second:boolean, third:boolean}} Bases
 * @typedef {object} Runner
 * @property {number} from the base the runner starts on: 0 for the batter, 1 first, 2 second, 3 third
 * @property {number} to the base he reaches (4 is home plate, scoring)
 * @property {boolean} out he is put out there
 * @property {boolean} [leaves] he leaves the field after the call, out though not put out by a throw (a batter whose ball was caught)
 * @property {boolean} [slide] he slides into the base at the end (a close play, or one where he is tagged)
 * @property {{t:number, p:Point}[]} path where he is when, base to base (he stands still before the first and after the last)
 *
 * @typedef {object} Plan
 * @property {'homer'|'out'|'hit'|'foul'} kind
 * @property {string} call the big word: SINGLE!, DOUBLE!, TRIPLE!, HOME RUN!, OUT!, DOUBLE PLAY!, SAC FLY!, SAFE! or FOUL BALL!
 * @property {string} detail what happened, in a line
 * @property {number} bases how many bases the batter takes (0 if he is out or it was foul)
 * @property {number} outs 0, 1 or 2
 * @property {number} runs
 * @property {Bases} basesAfter
 * @property {boolean} foul
 * @property {{x:number, y:number, kind:'hit'|'out'|'homer'|'foul'}} marker where it landed or was caught
 * @property {ReturnType<typeof simulateBall>} sim
 * @property {(t:number) => Point3} ball
 * @property {Record<string, Segment[]>} fielders
 * @property {Runner[]} runners
 * @property {{fielder:string|null, at:number|null, kind:'catch'|'field'|null, style:string|null, release:number|null,
 *   receiver:string|null, lands:number|null, throws:{by:string, t0:number, t1:number, to:Point, toId:string}[],
 *   tags:{by:string, t:number}[]}} events who has the ball and when; `style` how a ball in the air was caught
 *   ('camped', 'running', 'dive', 'leap' or 'reach') or a ground ball fielded ('scoop'); `release` is when it
 *   first leaves him, `throws` each throw (a relay, or a double play's two): who makes it, when it leaves and gets
 *   there, where to and to whom; `tags` each tag put on a runner who was not forced, by whom and when
 * @property {number} callAt when the call is made
 * @property {number} endAt when the play is over (everyone has stopped, and the fielders have walked back)
 */

export const PLAY = {
  // A ball can be caught in the air between these heights (feet): jumping for it, or at the shoe tops.
  catchLow: 0.8,
  catchHigh: 9,
  // A fielder under a fly this long before it comes down has settled under it: it is his if he has priority…
  camp: 0.35,
  // …and he takes it at about the height of his head, not at the top of a jump.
  comfortHigh: 6.5,
  // With time to spare he goes no slower than this share of his speed, to be under it this long (seconds) before it comes down.
  drift: 0.5,
  settle: 1,
  // A leap at the wall reaches this high (feet) for a ball going over it.
  robHigh: 10.5,
  // A ball on the ground or in a hop this low can be picked up.
  fieldHeight: 3.5,
  // The first baseman (or the pitcher) leaves a ground ball to a middle infielder who can get to it this much later.
  yieldTime: 0.4,
  // Fielded this close to the mound (feet) is an infield play; further out is an outfield play.
  infieldRadius: 105,
  glove: 2.4, // how high the ball is held in a glove (feet)
  batterBox: { x: -2.8, y: 0 },
  // The batter takes this long (swing, dropping the bat, the first strides) to get going, a runner already on base less.
  batterDelay: 0.6,
  runnerDelay: 0.3,
  cornerCost: 0.12, // extra seconds for each base turned after the first
  // On a ball in the air with fewer than two outs a runner on first or second goes this far off his base (feet), and
  // waits to see it drop; he goes on this long before it comes down, and takes this long to get going again.
  halfway: [0, 45, 35, 0],
  read: 0.2,
  restart: 0.15,
  // A ball still in the air this long after it was hit (seconds) is read as a fly; one down sooner as a ground ball.
  flyTime: 0.9,
  // A fly no fielder could have got to within this long of it (seconds) is plainly going to drop: the runners go.
  plainMiss: 0.8,
  // A runner who holds on a ground ball is this far off his base (feet) when the ball is thrown elsewhere.
  secondaryLead: 15,
  recover: 0.3, // a first baseman stretching for a throw takes this long to get up and throw again
  catchPad: 0.2, // the cover fielder catching a throw and stepping on the bag
  tagPad: 0.15, // …and putting a tag on a runner who wasn't forced, as well
  carry: 15, // feet: an infielder this close to the bag he wants takes the ball there himself
  holdLate: 0.35, // a throw that would be later than this to every base isn't made
  releaseHeight: 5.2, // feet: where a throw leaves the hand…
  catchHeight: 3.2, // …and where it is caught and held, at the chest
  coverBehind: 1.5, // the cover fielder stands this far beyond his base
  cutoffShort: 42, // feet: the cut-off man stands this far in front of the base a throw goes through to
  backUp: 30, // feet: how far behind a base, or a fielder chasing the ball, the man backing him up stands
  ramp: 0.6, // seconds to get up to speed from standing
  stop: 0.35, // …and to pull up at the end of a run
  callPad: 0.25, // the call comes this long after the last thing that settles it
  hold: 1.8, // the call stays up this long
  walkBack: 70, // ft/s: fielders hurry back to their spots (a cartoon's speed)
  walkBackAfter: 0.8, // after the call
  walkBackMax: 3.2, // …but no longer than this (seconds); the rest of the way is a jump
  trot: 52, // ft/s: a home run trot (a cartoon's speed again)
  trotDelay: 0.9,
  foulLinger: 0.8,
};

/**
 * Who has the right to a ball in the air that more than one fielder can settle under: a head start, in seconds,
 * over the time each takes to get there. Outfielders coming in see it better than infielders going out, the
 * centre fielder is in charge of the outfield, the pitcher gets out of the way.
 */
export const PRIORITY = { CF: 1.0, LF: 0.8, RF: 0.8, SS: 0.6, '2B': 0.5, '3B': 0.35, '1B': 0.3, C: 0.2, P: 0 };

/**
 * How sure the coach wants a runner to be of beating the throw (seconds) before sending him on to a base, by outs
 * (0, 1, 2): careful with nobody out; never the first or the third out at third; and home with two outs even on a
 * close play, when waiting for the next hit is the bigger risk. Negative is a gamble: he can be thrown out.
 */
export const SEND = { home: [0.1, -0.1, -0.35], third: [0.25, 0, 0.3], other: [0.1, 0.05, 0.05] };

/** The margin a runner trying for base `base` (2, 3 or 4) is sent on with `outs` out (see SEND). */
export function sendMargin(base, outs) {
  return (base >= 4 ? SEND.home : base === 3 ? SEND.third : SEND.other)[Math.min(2, outs)];
}

const DEG = Math.PI / 180;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const OUTFIELD = ['LF', 'CF', 'RF'];
const NUMBER = { P: 1, C: 2, '1B': 3, '2B': 4, '3B': 5, SS: 6, LF: 7, CF: 8, RF: 9 };

/** When a fielder can be at a spot: his reaction time, then a run there (his reach saves some of it). */
export function arrival(fielder, spot) {
  return fielder.reaction + Math.max(0, dist(fielder.spot, spot) - fielder.reach) / fielder.speed;
}

/** How long a runner takes to run from base `from` to base `to` (0 is home plate, 4 is home plate again). */
export function runTime(level, from, to) {
  const delay = from === 0 ? PLAY.batterDelay : PLAY.runnerDelay;
  return delay + ((to - from) * 90) / level.running.speed + PLAY.cornerCost * Math.max(0, to - from - 1);
}

// ---- Who gets to the ball -----------------------------------------------------------

/**
 * The catch, if anyone can make one: who calls for it (see PRIORITY), where and when, and how he makes it.
 * @returns {{fielder:object, t:number, x:number, y:number, z:number, style:string, robbed?:boolean}|null}
 */
function findCatch(sim, fielders, fence) {
  const limit = Math.min(sim.firstGround ? sim.firstGround.t : Infinity, sim.wallHits[0] ? sim.wallHits[0].t : Infinity,
    sim.overFence ? sim.overFence.t : Infinity);
  const chances = [];
  for (const f of Object.values(fielders)) {
    let first = null;
    let settled = null;
    for (const s of sim.samples) {
      if (s.t > limit) break;
      if (s.z < PLAY.catchLow || s.z > PLAY.catchHigh) continue;
      const a = arrival(f, s);
      if (a > s.t) continue;
      first ??= { s, a };
      if (s.z <= PLAY.comfortHigh && a <= s.t - PLAY.camp) {
        settled = { s, a };
        break;
      }
    }
    if (first) chances.push({ f, first, settled });
  }
  const settled = chances.filter((c) => c.settled);
  if (settled.length) {
    const best = settled.reduce((a, b) => (b.settled.a - PRIORITY[b.f.id] < a.settled.a - PRIORITY[a.f.id] ? b : a));
    const { s } = best.settled;
    return { fielder: best.f, t: s.t, x: s.x, y: s.y, z: s.z, style: 'camped' };
  }
  if (chances.length) {
    const best = chances.reduce((a, b) => (b.first.s.t < a.first.s.t || (b.first.s.t === a.first.s.t && b.first.a < a.first.a) ? b : a));
    const { s, a } = best.first;
    return { fielder: best.f, t: s.t, x: s.x, y: s.y, z: s.z, style: catchStyle(best.f, s, a) };
  }
  // A ball going over the fence low enough to reach: the outfielder who gets to the wall in time leaps for it.
  const over = sim.overFence;
  if (over && isFair(over.x, over.y) && over.z <= PLAY.robHigh) {
    const r = Math.hypot(over.x, over.y);
    const at = { x: over.x * (r - 1.5) / r, y: over.y * (r - 1.5) / r };
    let best = null;
    for (const id of OUTFIELD) {
      const a = arrival(fielders[id], at);
      if (a <= over.t && (!best || a < best.a)) best = { f: fielders[id], a };
    }
    if (best) return { fielder: best.f, t: over.t, x: at.x, y: at.y, z: over.z, style: 'leap', robbed: true };
  }
  return null;
}

/** How a fielder who only just gets to a ball in the air catches it: laid out for a low one, leaping for a high one. */
function catchStyle(f, s, a) {
  const spare = s.t - a;
  const lunged = dist(f.spot, s) > f.reach && spare < 0.15;
  if (lunged && s.z < 3) return 'dive';
  if (s.z > 7.4) return 'leap';
  return spare < 0.5 ? 'running' : 'reach';
}

/** Where and when the ball is picked up off the ground, and by whom. */
function findPickup(sim, fielders) {
  const from = sim.firstGround.t;
  /** @type {Record<string, {fielder:object, t:number, x:number, y:number}>} */
  const firstChance = {};
  for (const s of sim.samples) {
    if (s.t < from || s.z > PLAY.fieldHeight) continue;
    for (const f of Object.values(fielders)) {
      if (!firstChance[f.id] && arrival(f, s) <= s.t) firstChance[f.id] = { fielder: f, t: s.t, x: s.x, y: s.y };
    }
  }
  const all = Object.values(firstChance);
  if (all.length) {
    let best = all.reduce((a, b) => (b.t < a.t || (b.t === a.t && arrival(b.fielder, b) < arrival(a.fielder, a)) ? b : a));
    // The first baseman leaves a ball the second baseman can get to, and goes back to the bag; the pitcher leaves one
    // behind the mound to the middle infielders.
    const yields = best.fielder.id === '1B' ? ['2B'] : best.fielder.id === 'P' && best.y > MOUND.y ? ['SS', '2B'] : [];
    for (const id of yields) {
      const other = firstChance[id];
      if (other && other.t <= best.t + PLAY.yieldTime) {
        best = other;
        break;
      }
    }
    return best;
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

/**
 * How far along a run (0–1) someone is `tau` seconds into it: speeding up over the first `ease[0]` seconds,
 * steady, then slowing over the last `ease[1]`, at an average speed that gets there in the run's time.
 */
function progress(s, tau) {
  const T = s.t1 - s.t0;
  if (T <= 0) return 1;
  const k = Math.min(T, Math.max(0, tau));
  const [rampIn, rampOut] = s.ease ?? [0, 0];
  // (A run this short is a lunge, all at one speed.)
  const a = Math.min(rampIn, Math.max(0, T - 0.3) * 0.45);
  const b = Math.min(rampOut, Math.max(0, T - 0.3) * 0.45);
  const v = 1 / (T - (a + b) / 2);
  if (a > 0 && k < a) return (v * k * k) / (2 * a);
  if (b > 0 && k > T - b) return 1 - (v * (T - k) ** 2) / (2 * b);
  return v * (k - a / 2);
}

/**
 * Where something is at `t` along runs, in time order: standing at the first start before the first,
 * where the last run ended between two, and at the last end after them all.
 */
export function positionAt(segments, spot, t) {
  if (!segments.length) return spot;
  let at = segments[0].from;
  for (const s of segments) {
    if (t < s.t0) return at;
    if (t <= s.t1) {
      const u = progress(s, t - s.t0);
      return { x: s.from.x + (s.to.x - s.from.x) * u, y: s.from.y + (s.to.y - s.from.y) * u };
    }
    at = s.to;
  }
  return at;
}

/**
 * A run from `from` to `to` at the fielder's full speed, starting at `t0` from a standstill: `reach` feet of it
 * are a lunge he makes no slower. Stops short where he has got to by `until`, if he can't get all the way there
 * by then (and then he is still going when he stops).
 * @returns {Segment|null} null for a run too short to see
 */
function runSegment(f, from, to, t0, { reach = 0, until = Infinity } = {}) {
  const d = dist(from, to);
  let t1 = t0 + Math.max(0, d - reach) / f.speed;
  let end = to;
  let stops = true;
  if (t1 > until) {
    const go = Math.max(0, until - t0) * f.speed + reach;
    if (go < d) {
      end = { x: from.x + ((to.x - from.x) * go) / d, y: from.y + ((to.y - from.y) * go) / d };
      stops = false;
    }
    t1 = Math.max(t0, until);
  }
  if (dist(from, end) < 0.5) return null;
  return { t0, t1: Math.max(t1, t0 + 0.05), from, to: end, ease: [PLAY.ramp, stops ? PLAY.stop : 0] };
}

/**
 * The fielder going for the ball: as fast as he needs to where he gets it. With time to spare he drifts there,
 * no slower than half his speed, to be under it a second early, and slows to a stop and waits; if it takes him all
 * the way he is still going when he gets it.
 */
function chase(f, at, t) {
  const d = dist(f.spot, at);
  // (The last few feet, his reach, are a lunge at up to twice his speed.)
  const there = Math.max(arrival(f, at), f.reaction + d / (2 * f.speed), f.reaction + 0.05);
  const easy = Math.min(t - PLAY.settle, f.reaction + d / (PLAY.drift * f.speed));
  const t1 = Math.min(t, Math.max(there, easy));
  return { t0: f.reaction, t1, from: f.spot, to: at, ease: [PLAY.ramp, t1 < t - 0.1 ? PLAY.stop : 0] };
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

/** A point `by` feet from `from` towards `to`. */
function toward(from, to, by) {
  const d = dist(from, to) || 1;
  return { x: from.x + ((to.x - from.x) * by) / d, y: from.y + ((to.y - from.y) * by) / d };
}

/** A point `by` feet beyond `to`, on the line from `from` through it. */
function beyond(from, to, by) {
  return toward(to, { x: 2 * to.x - from.x, y: 2 * to.y - from.y }, by);
}

// ---- Runners ----------------------------------------------------------------------

/**
 * How a runner goes: from base `from`, leaving it at `start` (the crack of the bat, or the moment a fly he tagged
 * up on was caught or dropped); with `lead`, he goes that far off it at once and waits there until `go`.
 * @typedef {{from:number, start:number, lead:number, go:number}} Going
 */

/** Off at the crack of the bat. */
const onContact = (from) => ({ from, start: 0, lead: 0, go: 0 });

/**
 * How long a fielder was from catching a ball in the air: the least, over the fielders and the moments it could
 * have been caught, of how late he would have been (seconds). A ball with nobody near it is plainly going to drop.
 */
function nearestMiss(ctx) {
  const { sim, fielders } = ctx;
  const limit = Math.min(sim.firstGround ? sim.firstGround.t : Infinity, sim.wallHits[0] ? sim.wallHits[0].t : Infinity);
  let least = Infinity;
  for (const s of sim.samples) {
    if (s.t > limit) break;
    if (s.z < PLAY.catchLow || s.z > PLAY.catchHigh) continue;
    for (const f of Object.values(fielders)) least = Math.min(least, arrival(f, s) - s.t);
  }
  return least;
}

/**
 * How each runner on base goes on a ball that isn't caught, landing at `landT`: on contact on the ground or with two
 * outs, or on a ball in the air that plainly nobody will catch (in a moment, `read`, once he has seen it); on one a
 * fielder might get to, halfway (third tags up) and on once it drops.
 * @returns {Map<number, Going>}
 */
function readTheBall(ctx, landT) {
  const out = new Map([[0, onContact(0)]]);
  const fly = landT > PLAY.flyTime;
  const dropping = fly && nearestMiss(ctx) > PLAY.plainMiss;
  for (const i of onBase(ctx.bases)) {
    if (!fly || ctx.outs >= 2) out.set(i, onContact(i));
    else if (dropping) out.set(i, { from: i, start: PLAY.read, lead: 0, go: 0 });
    else if (i === 3) out.set(i, { from: 3, start: Math.max(0, landT - PLAY.read), lead: 0, go: 0 });
    else out.set(i, { from: i, start: 0, lead: PLAY.halfway[i], go: landT - PLAY.read });
  }
  return out;
}

/** When a runner going as `r` gets to base `k`. */
function reachTime(level, r, k) {
  if (k <= r.from) return r.start;
  if (!r.lead) return r.start + runTime(level, r.from, k);
  const speed = level.running.speed;
  const off = r.start + PLAY.runnerDelay + r.lead / speed;
  return Math.max(off, r.go) + PLAY.restart + ((k - r.from) * 90 - r.lead) / speed + PLAY.cornerCost * Math.max(0, k - r.from - 1);
}

/**
 * A runner going as `r` who ends up on base `to`. One who went off his base and doesn't go on (a fly that was
 * caught) is back on it once he has seen the catch, at `backAt`.
 * @returns {Runner}
 */
function makeRun(level, r, to, { out = false, slide = false, backAt = null } = {}) {
  const here = r.from === 0 ? PLAY.batterBox : baseSpot(r.from);
  const path = [{ t: 0, p: here }];
  const speed = level.running.speed;
  const delay = r.from === 0 ? PLAY.batterDelay : PLAY.runnerDelay;
  if (r.lead) {
    const spot = toward(here, baseSpot(r.from + 1), r.lead);
    const off = r.start + delay + r.lead / speed;
    path.push({ t: r.start + delay, p: here }, { t: off, p: spot });
    if (to <= r.from) {
      const t = Math.max(off, backAt ?? off);
      path.push({ t, p: spot }, { t: t + PLAY.restart + r.lead / speed, p: here });
      return { from: r.from, to: r.from, out, path };
    }
    path.push({ t: Math.max(off, r.go) + PLAY.restart, p: spot });
  } else if (to > r.from) {
    path.push({ t: r.start + delay, p: here });
  }
  for (let i = r.from + 1; i <= to; i++) {
    path.push({ t: Math.max(reachTime(level, r, i), path[path.length - 1].t + 0.05), p: baseSpot(i) });
  }
  return { from: r.from, to, out, slide, path };
}

/** A runner from base `from` who trots round to `to` at `speed` (a home run), from `start`. */
function trotRunner(from, to, start, speed) {
  const here = from === 0 ? PLAY.batterBox : baseSpot(from);
  const path = [{ t: start, p: here }, { t: start + PLAY.trotDelay, p: here }];
  for (let i = from + 1; i <= to; i++) path.push({ t: start + PLAY.trotDelay + ((i - from) * 90) / speed, p: baseSpot(i) });
  return { from, to, out: false, path };
}

/** Standing on his base (or in the box) throughout. */
function stays(from) {
  return { from, to: from, out: false, path: [{ t: 0, p: from === 0 ? PLAY.batterBox : baseSpot(from) }] };
}

/** The batter on a ball that is caught: out of the box and down the line until it is, then he leaves the field. */
function batterUntil(level, t) {
  const box = PLAY.batterBox;
  const going = Math.min(dist(box, BASES.first), Math.max(0, t - PLAY.batterDelay) * level.running.speed);
  const path = [{ t: 0, p: box }];
  if (going > 0.5) {
    path.push({ t: PLAY.batterDelay, p: box });
    path.push({ t: PLAY.batterDelay + going / level.running.speed, p: toward(box, BASES.first, going) });
  }
  return { from: 0, to: 0, out: false, leaves: true, path };
}

/** The runners on base, lead first, as [base index, ...]. */
function onBase(bases) {
  return [3, 2, 1].filter((i) => bases[BASE_ORDER[i]]);
}

/** Which runners are forced to run (the batter always is): 0, then 1 if first is taken, 2 if first and second are… */
function forcedFrom(bases) {
  const forced = new Set([0]);
  for (let i = 1; i <= 3; i++) if (bases[BASE_ORDER[i]] && forced.has(i - 1)) forced.add(i);
  return forced;
}

function basesFrom(runners) {
  const bases = { first: false, second: false, third: false };
  for (const r of runners) if (!r.out && r.to >= 1 && r.to <= 3) bases[BASE_ORDER[r.to]] = true;
  return bases;
}

/**
 * The runs that count and the bases left. On the third out nobody is left on base, and a run counts only if it
 * crossed the plate before the third out was made, and never when that out was a force (the batter at first too).
 * @param {{t:number, force:boolean}[]} outsMade
 * @param {Map<Runner, number>} scoredAt when each runner who scored touched the plate
 */
function settle(ctx, runners, outsMade, scoredAt) {
  const scorers = runners.filter((r) => !r.out && r.to === 4);
  if (ctx.outs + outsMade.length < 3) return { runs: scorers.length, basesAfter: basesFrom(runners) };
  const third = [...outsMade].sort((a, b) => a.t - b.t)[2 - ctx.outs];
  const runs = third.force ? 0 : scorers.filter((r) => (scoredAt.get(r) ?? Infinity) < third.t).length;
  return { runs, basesAfter: { first: false, second: false, third: false } };
}

// ---- Throws -------------------------------------------------------------------------

const INFIELD = ['P', 'C', '1B', '2B', 'SS', '3B'];

/**
 * Who takes a throw at base `target` from `thrower`, fielding it at `from`: an infielder near the bag takes it
 * there himself; first base is the first baseman's (the pitcher's, covering, when he is the one off the bag);
 * second the middle infielder who isn't on the ball's side; third the third baseman's (the shortstop's when he
 * has charged a ball); home the catcher's (the pitcher's when the catcher has the ball). `busy` are fielders
 * already in the play elsewhere.
 */
function coverFor(thrower, target, from, busy) {
  if (INFIELD.includes(thrower.id) && dist(from, BASES[target]) <= PLAY.carry) return thrower.id;
  let id;
  if (target === 'first') id = '1B';
  else if (target === 'third') id = '3B';
  else if (target === 'home') id = 'C';
  else id = thrower.id === 'CF' ? (from.x < 0 ? '2B' : 'SS') : coveringFielder(thrower.id, 'second');
  if (id === thrower.id || busy.has(id)) {
    id = { first: 'P', second: id === 'SS' ? '2B' : 'SS', third: 'SS', home: 'P' }[target];
  }
  return id;
}

/**
 * @typedef {object} Route how the ball gets from the fielder who has it to a base
 * @property {string} receiver who catches it there (the fielder himself, if he carries it)
 * @property {boolean} self he carries it to the bag himself
 * @property {Point} stand where the receiver stands, just beyond the base
 * @property {number} release when it leaves the fielder (his first step, if he carries it)
 * @property {number} arrives when it gets to the receiver
 * @property {{by:string, from:Point, to:Point, t0:number, t1:number, toId:string}[]} throws each throw, in turn
 * @property {string|null} cutoff the relay man, if it goes through one
 * @property {{id:string, segment:Segment}[]} runs where the receiver and the relay man run to take it
 */

/**
 * How a ball fielded by `thrower` at `from`, who can throw it from `ready` on, gets to base `target`. It goes
 * straight to the fielder covering it (see `coverFor`); or, with `cutoff` allowed and a throw longer than his
 * arm, to a relay man (a middle infielder, the one on the ball's side, or a corner man) halfway, who catches it
 * and throws it on in the level's relay time. Each throw leaves the hand only when it will reach the next man as
 * he gets there, if he is not there yet: a ball is never thrown to nobody. The throws are timed to the base, and
 * drawn to where the receiver stands. Adds nothing to the tracks: the caller does, from `runs`.
 * @param {import('./gap-shot-logic.js').Level} level
 * @param {ReturnType<typeof fieldersOf>} fielders
 * @param {boolean|{cutoff?:boolean, busy?:Set<string>}} [options] true allows a relay; `busy` fielders can't take it
 * @returns {Route}
 */
export function throwRoute(level, fielders, thrower, from, ready, target, options = false) {
  const { cutoff = false, busy = new Set() } = typeof options === 'boolean' ? { cutoff: options } : options;
  const base = BASES[target];
  const cover = fielders[coverFor(thrower, target, from, busy)];
  const d = dist(from, base);
  const along = { x: (base.x - from.x) / (d || 1), y: (base.y - from.y) / (d || 1) };
  const stand = { x: base.x + along.x * PLAY.coverBehind, y: base.y + along.y * PLAY.coverBehind };
  const ease = [PLAY.ramp, PLAY.stop];
  const covered = cover.reaction + dist(cover.spot, stand) / cover.speed;
  // An infielder runs it to the bag himself when that is quicker than waiting for the man covering it.
  const carryAt = ready - thrower.transfer * 0.65 + dist(from, stand) / thrower.speed;
  const throwAt = Math.max(ready + d / thrower.throwSpeed, covered);
  if (cover.id === thrower.id || (INFIELD.includes(thrower.id) && carryAt < throwAt)) {
    // He carries it to the bag himself.
    const t0 = ready - thrower.transfer * 0.65;
    const t1 = t0 + dist(from, stand) / thrower.speed;
    return {
      receiver: thrower.id, self: true, stand, release: t0, arrives: t1, throws: [], cutoff: null,
      runs: dist(from, stand) > 0.5 ? [{ id: thrower.id, segment: { t0, t1: Math.max(t1, t0 + 0.05), from, to: stand, ease: [0.3, 0.2] } }] : [],
    };
  }
  const runs = [{ id: cover.id, segment: { t0: cover.reaction, t1: Math.max(covered, cover.reaction + 0.1), from: cover.spot, to: stand, ease } }];
  const order = from.x < 0 ? ['SS', '2B', '3B'] : ['2B', 'SS', '1B'];
  const relayId = cutoff && d > thrower.arm ? order.find((id) => id !== thrower.id && id !== cover.id && !busy.has(id)) : null;
  if (relayId) {
    const man = fielders[relayId];
    const mid = { x: from.x + (along.x * d) / 2, y: from.y + (along.y * d) / 2 };
    const there = man.reaction + dist(man.spot, mid) / man.speed;
    runs.push({ id: man.id, segment: { t0: man.reaction, t1: Math.max(there, man.reaction + 0.1), from: man.spot, to: mid, ease } });
    const first = d / 2 / thrower.throwSpeed;
    const second = d / 2 / man.throwSpeed;
    const r1 = Math.max(ready, there - first);
    const r2 = Math.max(r1 + first + level.fielding.relay, covered - second);
    return {
      receiver: cover.id, self: false, stand, release: r1, arrives: r2 + second, cutoff: man.id, runs,
      throws: [
        { by: thrower.id, from, to: mid, t0: r1, t1: r1 + first, toId: man.id },
        { by: man.id, from: mid, to: stand, t0: r2, t1: r2 + second, toId: cover.id },
      ],
    };
  }
  const flight = d / thrower.throwSpeed;
  const release = Math.max(ready, covered - flight);
  return {
    receiver: cover.id, self: false, stand, release, arrives: release + flight, cutoff: null, runs,
    throws: [{ by: thrower.id, from, to: stand, t0: release, t1: release + flight, toId: cover.id }],
  };
}

/** When a route has the ball on the bag: caught and the foot on it, or carried there. */
function onTheBag(route) {
  return route.arrives + (route.self ? 0 : PLAY.catchPad);
}

/**
 * The ball's journey from the moment `holder` picks it up at `since`, through each route in turn (a double play
 * has two), into the last receiver's glove; and the runs of everyone who takes part, put on the tracks.
 */
function routeLegs(ctx, tracks, holder, since, routes) {
  const legs = [];
  let who = holder;
  let from = since;
  let z = PLAY.glove;
  for (const route of routes) {
    for (const { id, segment } of route.runs) tracks[id].push(segment);
    for (const th of route.throws) {
      legs.push([from, th.t0, heldBy(tracks, ctx.fielders[who], z)]);
      legs.push([th.t0, th.t1, (t) => throwPoint(th.from, th.to, th.t0, th.t1, t)]);
      who = th.toId;
      from = th.t1;
      z = PLAY.catchHeight;
    }
  }
  legs.push([from, Infinity, heldBy(tracks, ctx.fielders[who], z)]);
  return legs;
}

/**
 * The ball in a throw: from the hand at `t0` to the glove at `t1`, going up and coming down as gravity has a
 * ball in the air that long (so a slow throw is a high one, and a quick one a line).
 */
function throwPoint(from, to, t0, t1, t) {
  const T = t1 - t0;
  const u = Math.min(1, Math.max(0, (t - t0) / (T || 1)));
  const { releaseHeight: z0, catchHeight: z1 } = PLAY;
  return {
    x: from.x + (to.x - from.x) * u,
    y: from.y + (to.y - from.y) * u,
    z: z0 + (z1 - z0) * u + (PHYSICS.gravity * T * T * u * (1 - u)) / 2,
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

/** The ball in flight, from the bat. */
function flightLeg(sim, until) {
  return [0, until, (t) => {
    const b = ballAt(sim.samples, t);
    return { x: b.x, y: b.y, z: b.z };
  }];
}

/** The ball in someone's glove, at `z` feet: wherever he goes, it goes with him. */
function heldBy(tracks, f, z = PLAY.catchHeight) {
  return (t) => {
    const p = positionAt(tracks[f.id], f.spot, t);
    return { x: p.x, y: p.y, z: typeof z === 'function' ? z(t) : z };
  };
}

function throwEvents(routes) {
  return routes.flatMap((route) => route.throws.map((th) => ({ by: th.by, t0: th.t0, t1: th.t1, to: th.to, toId: th.toId })));
}

// ---- Words ---------------------------------------------------------------------------

const NAMES = {
  P: 'pitcher', C: 'catcher', '1B': 'first baseman', '2B': 'second baseman', SS: 'shortstop', '3B': 'third baseman',
  LF: 'left fielder', CF: 'centre fielder', RF: 'right fielder',
};
const BASE_WORD = ['home', 'first', 'second', 'third', 'home'];
const RUNNER_WORD = ['the batter', 'the runner from first', 'the runner from second', 'the runner from third'];

function sprayWord(x, y) {
  const deg = sprayDegrees(x, y);
  if (deg < -45) return 'down the left field line';
  if (deg > 45) return 'down the right field line';
  if (Math.abs(deg) < 9) return 'to centre field';
  if (Math.abs(deg) < 24) return deg < 0 ? 'to left-centre' : 'to right-centre';
  return deg < 0 ? 'to left field' : 'to right field';
}

function runsWord(runs) {
  return runs ? `: ${runs} run${runs === 1 ? ' scores' : 's score'}` : '';
}

// ---- The play -------------------------------------------------------------------------

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

  const caught = findCatch(sim, fielders, fence);
  if (caught) return caughtPlan(ctx, caught);
  if (sim.overFence && isFair(sim.overFence.x, sim.overFence.y)) return homerPlan(ctx);
  // A ball that left the park in foul territory without landing is foul too.
  if (!sim.firstGround || !landedFair(sim)) return foulPlan(ctx);
  const pickup = findPickup(sim, fielders);
  const infield = Math.hypot(pickup.x - MOUND.x, pickup.y - MOUND.y) <= PLAY.infieldRadius && !OUTFIELD.includes(pickup.fielder.id);
  return infield ? infieldPlan(ctx, pickup) : outfieldPlan(ctx, pickup);
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
function walkBack(fielders, tracks, callAt, busyUntil) {
  const start = callAt + PLAY.walkBackAfter;
  let end = callAt + PLAY.hold;
  for (const f of Object.values(fielders)) {
    const segs = tracks[f.id];
    const last = segs.length ? segs[segs.length - 1] : null;
    const at = last ? last.to : f.spot;
    const d = dist(at, f.spot);
    if (d < 0.5) continue;
    const t0 = Math.max(start, last ? last.t1 : start, busyUntil[f.id] ?? 0);
    const go = Math.min(d, PLAY.walkBackMax * PLAY.walkBack);
    const t1 = t0 + go / PLAY.walkBack;
    segs.push({ t0, t1, from: at, to: toward(at, f.spot, go) });
    end = Math.max(end, t1);
  }
  return end;
}

/** Kept inside the park: no further from home plate than a few feet in front of the fence. */
function inPark(ctx, p) {
  const deg = Math.max(-45, Math.min(45, sprayDegrees(p.x, p.y)));
  const most = ctx.fence.radiusAt(deg) - 8;
  const r = Math.hypot(p.x, p.y);
  return r > most ? { x: (p.x * most) / r, y: (p.y * most) / r } : p;
}

/** Where a fielder covering a base stands: on the bag's corner, facing the play. */
const BAG_STAND = {
  first: { x: BASES.first.x - 2, y: BASES.first.y + 1 },
  second: { x: BASES.second.x, y: BASES.second.y - 2 },
  third: { x: BASES.third.x + 2, y: BASES.third.y + 1 },
};

/**
 * Where everyone not already in the play goes, as a real team does, until the call. On a ball to the outfield
 * the cut-off man lines up between the ball and the base it is thrown to (the first baseman for a throw home from
 * centre or right, the third baseman from left, the shortstop for third, the middle infielder on the ball's side
 * for second), the bases are covered by whoever is free (first by the first baseman, or the second baseman when
 * he is the cut-off man, or the pitcher; second by the middle infielder away from the ball; third by the third
 * baseman, or the shortstop), the other middle infielder goes out towards the ball, the pitcher backs up the base
 * the throw goes to, and the outfielders back up the man with the ball and the throws. On the infield the pitcher
 * breaks towards first on a ball to his left, the catcher backs up a throw to first, and the outfielders back up
 * the base the ball goes to. On a home run the outfielder nearest it runs back to the fence; on a foul ball the
 * nearest fielder takes off after it.
 * @param {{ball:Point, throwBase:number|null, from:Point|null, deep:boolean, direct:boolean}} focus where the ball
 *   is played, the base (1-4) it is thrown to and where from, whether that is out in the outfield, and whether the
 *   throw goes straight there (not through a relay man)
 */
function support(ctx, plan, focus) {
  const { fielders } = ctx;
  const tracks = plan.fielders;
  const until = plan.callAt;
  const isFree = (id) => !tracks[id].length;
  const go = (id, to, by = until) => {
    const f = fielders[id];
    const seg = runSegment(f, f.spot, inPark(ctx, to), f.reaction, { until: by });
    if (seg) tracks[id].push(seg);
    taken.add(id);
  };
  const taken = new Set(Object.keys(fielders).filter((id) => !isFree(id)));
  const free = (id) => !taken.has(id);
  const nearest = (ids, p) => ids.filter(free).reduce((a, b) => (a && dist(fielders[a].spot, p) <= dist(fielders[b].spot, p) ? a : b), null);
  const ball = focus.ball;
  if (plan.kind === 'homer') {
    const id = nearest(OUTFIELD, ball);
    if (id) go(id, ball);
    return;
  }
  if (plan.kind === 'foul') {
    const id = nearest(Object.keys(fielders), ball);
    if (id) go(id, ball, Math.min(until, plan.events.lands ?? until));
    return;
  }
  const left = ball.x < 0;
  const target = focus.throwBase ? baseSpot(focus.throwBase) : null;
  // Is anyone (already in the play) ending up on this base?
  const covered = (p) => Object.keys(fielders).some((id) => taken.has(id) && tracks[id].length && dist(tracks[id][tracks[id].length - 1].to, p) < 8);

  if (focus.deep && target && focus.direct && focus.throwBase >= 2) {
    // The cut-off man, lined up on the throw, short of the base.
    const id = focus.throwBase === 4 ? (left ? '3B' : '1B') : focus.throwBase === 3 ? 'SS' : left ? 'SS' : '2B';
    if (free(id)) go(id, toward(target, focus.from, PLAY.cutoffShort));
  }
  // The bases, each covered by whoever is free.
  const cover = {
    first: ['1B', '2B', 'P'],
    second: left ? ['2B', 'SS'] : ['SS', '2B'],
    third: ['3B', 'SS'],
  };
  for (const base of ['first', 'second', 'third']) {
    if (covered(BASES[base])) continue;
    const id = cover[base].find(free);
    if (id && !(id === 'P' && focus.deep)) go(id, BAG_STAND[base]);
  }
  // On a ball to the outfield, a middle infielder still free goes out towards it, to take a throw in.
  if (focus.deep) {
    const out = [left ? 'SS' : '2B', left ? '2B' : 'SS'].find(free);
    if (out) go(out, toward(BASES.second, ball, Math.min(dist(BASES.second, ball) / 2, 110)));
  }
  // The pitcher: to first on a ground ball to his left, else backing up the base the ball is thrown to.
  if (free('P')) {
    if (!focus.deep && ball.x > 10 && focus.throwBase === 1) go('P', toward(BASES.first, MOUND, 12));
    else if (target && focus.from && focus.throwBase !== 1) go('P', beyond(focus.from, target, PLAY.backUp));
    else if (target && focus.from) go('P', toward(MOUND, BASES.first, 25));
  }
  // The catcher: down the line behind a throw to first; otherwise he stays at the plate.
  if (free('C') && !focus.deep && focus.throwBase === 1 && !ctx.bases.second && !ctx.bases.third) go('C', { x: 26, y: 16 });
  // The outfielders.
  const outfield = OUTFIELD.filter(free);
  if (focus.deep) {
    // The nearest backs up the man with the ball; the other, the base the throw goes to (or second).
    const backer = nearest(outfield, ball);
    if (backer) go(backer, beyond(BASES.home, ball, PLAY.backUp));
    const other = outfield.find(free);
    if (other) go(other, beyond(ball, target ?? BASES.second, PLAY.backUp * 1.5));
  } else {
    const backer = target ? nearest(outfield, target) : null;
    if (backer && focus.from) go(backer, beyond(focus.from, target, PLAY.backUp * 1.5));
    for (const id of outfield.filter(free)) {
      const f = fielders[id];
      go(id, { x: f.spot.x + (ball.x - f.spot.x) * 0.1, y: f.spot.y + (ball.y - f.spot.y) * 0.1 });
    }
  }
}

function finish(ctx, plan, focus) {
  support(ctx, plan, focus);
  for (const segs of Object.values(plan.fielders)) segs.sort((a, b) => a.t0 - b.t0);
  // Nobody walks off while a throw is still coming to him, or before he has made his.
  const busyUntil = {};
  for (const th of plan.events.throws) {
    busyUntil[th.by] = Math.max(busyUntil[th.by] ?? 0, th.t0 + 0.3);
    busyUntil[th.toId] = Math.max(busyUntil[th.toId] ?? 0, th.t1 + 0.4);
  }
  const endAt = walkBack(ctx.fielders, plan.fielders, plan.callAt, busyUntil);
  const lastRun = plan.runners.reduce((m, r) => Math.max(m, r.path[r.path.length - 1].t), 0);
  plan.endAt = Math.max(endAt, plan.callAt + PLAY.hold, lastRun + 0.6);
  return plan;
}

// ---- A ball caught in the air ---------------------------------------------------

function caughtPlan(ctx, caught) {
  const { level, bases, outs, hit, sim, fielders } = ctx;
  const f = caught.fielder;
  const at = { x: caught.x, y: caught.y };
  const foul = !isFair(at.x, at.y);
  const deep = dist(at, MOUND) > PLAY.infieldRadius;
  const tracks = standing(fielders);
  tracks[f.id].push(chase(f, at, caught.t));
  const ready = caught.t + f.transfer;
  const routeTo = (k, busy) => throwRoute(level, fielders, f, at, ready, BASE_ORDER[k], { cutoff: true, busy });

  // The runners: with two outs they ran on contact, and the inning is over; otherwise each tags up and goes on if
  // he would beat the throw by his coach's margin (only on a ball caught in the outfield), or goes halfway on a fly
  // that might drop and comes back, or (on a line drive or an infield pop-up) stays.
  const runners = [];
  const moves = [];
  let ahead = 4; // the base the runner ahead of him ends up on
  for (const i of onBase(bases)) {
    if (outs >= 2) {
      runners.push(makeRun(level, onContact(i), i + 1));
      continue;
    }
    const tag = { from: i, start: caught.t, lead: 0, go: 0 };
    const free = i + 1 < ahead || i + 1 === 4;
    const beats = deep && free && reachTime(level, tag, i + 1) <= onTheBag(routeTo(i + 1)) + PLAY.tagPad - sendMargin(i + 1, outs);
    if (beats) {
      moves.push({ from: i, to: i + 1, going: tag });
      ahead = i + 1;
      continue;
    }
    ahead = i;
    if (i < 3 && caught.t > 1.5) runners.push(makeRun(level, { from: i, start: 0, lead: deep ? PLAY.halfway[i] : PLAY.halfway[i] / 3, go: Infinity }, i, { backAt: caught.t + 0.1 }));
    else runners.push(stays(i));
  }
  runners.push(batterUntil(level, caught.t + 0.3));
  const outsMade = [{ t: caught.t, force: false }];

  // The throw: to the lead runner he can get, else to the lead runner's base anyway, else in to second.
  let routes = [];
  let playOn = null;
  let throwBase = null;
  if (outs < 2 && moves.length) {
    const options = moves.map((m) => ({ m, route: routeTo(m.to) }));
    const outsAt = options.filter((o) => onTheBag(o.route) + PLAY.tagPad <= reachTime(level, o.m.going, o.m.to));
    const pick = outsAt[0] ?? options[0];
    routes = [pick.route];
    throwBase = pick.m.to;
    if (outsAt.length) playOn = pick;
  } else if (outs < 2 && deep && onBase(bases).length) {
    routes = [routeTo(2)];
    throwBase = 2;
  }
  const scoredAt = new Map();
  let throwOut = null;
  for (const m of moves) {
    const out = playOn?.m === m;
    const r = makeRun(level, m.going, m.to, { out, slide: m.to >= 2 && Math.abs(reachTime(level, m.going, m.to) - (playOn ? onTheBag(playOn.route) : 0)) < 0.6 });
    runners.unshift(r);
    if (m.to === 4 && !out) scoredAt.set(r, reachTime(level, m.going, 4));
    if (out) {
      throwOut = { runner: r, t: onTheBag(playOn.route) + PLAY.tagPad };
      outsMade.push({ t: throwOut.t, force: false });
    }
  }
  const { runs, basesAfter } = settle(ctx, runners, outsMade, scoredAt);

  const lastSettled = Math.max(caught.t, ...[...scoredAt.values()], throwOut ? throwOut.t : 0,
    ...moves.map((m) => reachTime(level, m.going, m.to)));
  const callAt = lastSettled + PLAY.callPad;
  const kind = caught.robbed ? 'Home run robbed' : hit.launch > 50 * DEG ? 'Pop out' : hit.launch > 25 * DEG ? 'Fly out' : 'Line out';
  // In the glove where he caught it, then brought down to his chest.
  const high = Math.min(7, Math.max(PLAY.glove, caught.z));
  const glove = (t) => PLAY.catchHeight + (high - PLAY.catchHeight) * Math.max(0, 1 - (t - caught.t) / 0.3);
  const legs = routes.length ? routeLegs(ctx, tracks, f.id, caught.t, routes) : [[caught.t, Infinity, heldBy(tracks, f, glove)]];
  if (routes.length) legs[0] = [caught.t, legs[0][1], heldBy(tracks, f, glove)];
  const ball = journey([flightLeg(sim, caught.t), ...legs]);
  const sacFly = runs > 0;
  let detail = caught.robbed ? `Home run robbed: a leap at the wall by the ${NAMES[f.id]}` : `${kind} to the ${NAMES[f.id]}`;
  if (foul) detail += ' in foul territory';
  else if (caught.style === 'dive') detail += ', diving';
  if (sacFly) detail += runs === 1 ? ' – the run scores' : ` – ${runs} runs score`;
  if (throwOut) detail += ` – ${RUNNER_WORD[throwOut.runner.from]} is thrown out at ${BASE_WORD[throwOut.runner.to]}`;
  const tags = throwOut ? [{ by: routes[0].receiver, t: throwOut.t - PLAY.tagPad }] : [];
  const plan = {
    kind: 'out',
    call: outsMade.length === 2 ? 'DOUBLE PLAY!' : sacFly ? 'SAC FLY!' : 'OUT!',
    detail,
    bases: 0,
    outs: outsMade.length,
    runs,
    basesAfter,
    foul,
    marker: { x: at.x, y: at.y, kind: 'out' },
    sim,
    ball,
    fielders: tracks,
    runners,
    events: {
      fielder: f.id, at: caught.t, kind: 'catch', style: caught.style, release: routes.length ? routes[0].release : null,
      receiver: routes.length ? routes[routes.length - 1].receiver : null, lands: null, throws: throwEvents(routes), tags,
    },
    callAt,
    endAt: 0,
  };
  return finish(ctx, plan, { ball: at, throwBase, from: at, deep, direct: routes.length ? !routes[0].cutoff : true });
}

// ---- A home run ------------------------------------------------------------------

function homerPlan(ctx) {
  const { bases, hit, speed, sim, fielders } = ctx;
  const over = sim.overFence;
  // The ball keeps going, for the picture: the same flight with no fence.
  const free = simulateBall({ speed, spray: hit.spray, launch: hit.launch }, { radiusAt: () => 1e5, height: 0 });
  const runners = [];
  // Everyone circles the bases, the lead runner first and the batter last, and scores.
  for (const i of onBase(bases)) runners.push(trotRunner(i, 4, 0.5, PLAY.trot));
  runners.push(trotRunner(0, 4, 0.2, PLAY.trot));
  const runs = runners.length;
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
    events: {
      fielder: null, at: null, kind: null, style: null, release: null, receiver: null, lands: free.firstGround ? free.firstGround.t : null, throws: [], tags: [],
    },
    callAt,
    endAt: 0,
  };
  return finish(ctx, plan, { ball: { x: over.x, y: over.y }, throwBase: null, from: null, deep: true, direct: true });
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
    runners: [...onBase(ctx.bases).map(stays), stays(0)],
    events: { fielder: null, at: null, kind: null, style: null, release: null, receiver: null, lands: g.t, throws: [], tags: [] },
    callAt,
    endAt: 0,
  };
  const out = finish(ctx, plan, { ball: { x: g.x, y: g.y }, throwBase: null, from: null, deep: false, direct: true });
  out.endAt = Math.max(g.t + PLAY.foulLinger + 0.8, callAt + 1.1);
  return out;
}

// ---- The infield --------------------------------------------------------------------

/**
 * Where each runner goes on a ball fielded on the infield, lead first: the forced ones to the next base, and with
 * two outs everyone; a runner who isn't forced only when he reads that a throw there wouldn't get him by his coach's
 * margin (a slow roller, a ball the fielder has to go a long way for, one hit behind him), and onto a base the
 * runner ahead is leaving.
 */
function infieldIntents(ctx, pickup, goings) {
  const { level, bases, outs, fielders } = ctx;
  const forced = forcedFrom(bases);
  const f = pickup.fielder;
  const at = { x: pickup.x, y: pickup.y };
  const intents = [];
  let ahead = 5;
  for (const i of onBase(bases)) {
    let to = i;
    const going = goings.get(i);
    if (forced.has(i) || outs >= 2) to = i + 1;
    else {
      const route = throwRoute(level, fielders, f, at, pickup.t + f.transfer, BASE_ORDER[i + 1]);
      if (reachTime(level, going, i + 1) <= onTheBag(route) + PLAY.tagPad - sendMargin(i + 1, outs)) to = i + 1;
    }
    if (to >= ahead && to < 4) to = i;
    ahead = to;
    intents.push({ from: i, to, forced: forced.has(i), going });
  }
  intents.push({ from: 0, to: 1, forced: true, going: goings.get(0) });
  return intents;
}

function infieldPlan(ctx, pickup) {
  const { level, outs, sim, fielders } = ctx;
  const f = pickup.fielder;
  const tracks = standing(fielders);
  const at = { x: pickup.x, y: pickup.y };
  tracks[f.id].push(chase(f, at, pickup.t));
  const ready = pickup.t + f.transfer;
  const goings = readTheBall(ctx, sim.firstGround.t);
  const intents = infieldIntents(ctx, pickup, goings);
  const batter = intents[intents.length - 1];

  // Every out he could go for, and the double plays.
  const options = [];
  for (const m of intents) {
    if (m.to <= m.from) continue;
    const route = throwRoute(level, fielders, f, at, ready, BASE_ORDER[m.to]);
    const outAt = onTheBag(route) + (m.forced ? 0 : PLAY.tagPad);
    const option = { m, route, outAt, margin: reachTime(level, m.going, m.to) - outAt, dp: null };
    if (option.margin >= 0 && m.forced && m.to >= 2 && outs < 2) {
      const pivot = fielders[route.receiver];
      const turn = route.self ? pivot.transfer * 0.6 : level.fielding.relay;
      const second = throwRoute(level, fielders, pivot, route.stand, onTheBag(route) + turn, 'first', { busy: new Set([f.id, pivot.id]) });
      const outAt2 = onTheBag(second);
      option.dp = { route: second, outAt: outAt2, margin: reachTime(level, batter.going, 1) - outAt2 };
    }
    options.push(option);
  }
  const rank = (o) => (o.m.to === 4 ? 10 : o.m.to) + o.margin * 1e-3;
  const made = options.filter((o) => o.margin >= 0);
  const dps = made.filter((o) => o.dp && o.dp.margin >= 0);
  let pick = null;
  // The double play: home to first if it can be turned (it saves a run), else the surest.
  const sure = (o) => (o.m.to === 4 ? 10 : 0) + Math.min(o.margin, o.dp.margin);
  if (dps.length) pick = dps.reduce((a, b) => (sure(b) > sure(a) ? b : a));
  else if (made.length && outs >= 2) pick = made.reduce((a, b) => (b.margin > a.margin ? b : a));
  else if (made.length) pick = made.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  else {
    // No play: he throws only on a close one, to the base he comes nearest to getting.
    const close = options.reduce((a, b) => (!a || b.margin > a.margin ? b : a), null);
    if (close && close.margin > -PLAY.holdLate) pick = close;
  }
  const double = pick?.dp && pick.dp.margin >= 0 ? pick.dp : null;
  const routes = pick ? [pick.route, ...(double ? [double.route] : [])] : [];

  // A runner who held goes on the throw, when it goes to a base behind him and the man who catches it there
  // couldn't throw him out in turn: off his secondary lead as the ball leaves the fielder's hand.
  if (pick) {
    const last = routes[routes.length - 1];
    const lastBase = double ? 1 : pick.m.to;
    const receiver = fielders[last.receiver];
    // (The bases still taken: everyone's but the runners put out.)
    const putOut = new Set([pick.margin >= 0 ? pick.m : null, double ? batter : null]);
    const taken = new Set(intents.filter((m) => !putOut.has(m)).map((m) => m.to));
    for (const m of intents) {
      if (m.to !== m.from || m.from === 0 || lastBase > m.from || (taken.has(m.from + 1) && m.from + 1 < 4)) continue;
      // (A runner on second holds on a ball hit in front of him, on the left side: the fielder can look him back.)
      if (m.from === 2 && at.x <= 0) continue;
      const going = { from: m.from, start: 0, lead: PLAY.secondaryLead, go: pick.route.release };
      const back = onTheBag(last) + PLAY.recover + receiver.transfer + dist(last.stand, baseSpot(m.from + 1)) / receiver.throwSpeed + PLAY.catchPad + PLAY.tagPad;
      if (reachTime(level, going, m.from + 1) <= back - sendMargin(m.from + 1, outs)) {
        taken.delete(m.from);
        m.to = m.from + 1;
        m.going = going;
        taken.add(m.to);
      }
    }
  }

  // What happens to everyone.
  const runners = [];
  const outsMade = [];
  const scoredAt = new Map();
  const tags = [];
  for (const m of intents) {
    const firstOut = pick && pick.m === m && pick.margin >= 0;
    const secondOut = double && m === batter;
    const out = Boolean(firstOut || secondOut);
    const playedOn = pick && (pick.m === m || (double && m === batter));
    const outAt = firstOut ? pick.outAt : secondOut ? double.outAt : null;
    const close = playedOn && m.to >= 2 && Math.abs(reachTime(level, m.going, m.to) - (secondOut ? double.outAt : pick.outAt)) < 0.5;
    const r = m.to > m.from ? makeRun(level, m.going, m.to, { out, slide: close || (out && !m.forced) }) : stays(m.from);
    runners.push(r);
    if (out) {
      outsMade.push({ t: outAt, force: m.forced });
      if (!m.forced) tags.push({ by: (secondOut ? double : pick).route.receiver, t: outAt - PLAY.tagPad });
    }
    if (m.to === 4 && !out) scoredAt.set(r, reachTime(level, m.going, 4));
  }
  const { runs, basesAfter } = settle(ctx, runners, outsMade, scoredAt);

  const lastOut = outsMade.reduce((m, o) => Math.max(m, o.t), 0);
  const batterSafe = !runners[runners.length - 1].out;
  const settles = Math.max(lastOut, batterSafe ? reachTime(level, batter.going, 1) : 0, routes.length ? onTheBag(routes[routes.length - 1]) : 0);
  const callAt = settles + PLAY.callPad;
  const ball = journey([flightLeg(sim, pickup.t), ...routeLegs(ctx, tracks, f.id, pickup.t, routes)]);

  // The words.
  let call;
  let detail;
  const batterOut = runners[runners.length - 1].out;
  if (double) {
    call = 'DOUBLE PLAY!';
    const chain = [f.id, pick.route.receiver, double.route.receiver].filter((id, i, all) => i === 0 || id !== all[i - 1]);
    detail = `Double play, ${chain.map((id) => NUMBER[id]).join('-')}${runsWord(runs)}`;
  } else if (pick && pick.margin >= 0) {
    call = 'OUT!';
    const word = BASE_WORD[pick.m.to];
    if (batterOut) {
      if (pick.route.self) detail = `Grounded out to the ${NAMES[f.id]}, unassisted`;
      else if (pick.route.receiver === 'P') detail = `Grounded out, ${NAMES[f.id]} to the pitcher covering first`;
      else detail = `Grounded out, ${NAMES[f.id]} to first`;
    } else if (pick.m.forced) detail = `Forced out at ${word}`;
    else detail = `${RUNNER_WORD[pick.m.from][0].toUpperCase()}${RUNNER_WORD[pick.m.from].slice(1)} is thrown out at ${word}`;
    detail += runsWord(runs);
  } else if (pick && pick.m !== batter) {
    call = 'SAFE!';
    detail = `Fielder’s choice: the throw ${pick.m.to === 4 ? 'home' : `to ${BASE_WORD[pick.m.to]}`} is too late, everyone safe${runsWord(runs)}`;
  } else {
    call = 'SINGLE!';
    detail = `Infield single${pick ? '' : `: no throw by the ${NAMES[f.id]}`}${runsWord(runs)}`;
  }
  const plan = {
    kind: outsMade.length ? 'out' : 'hit',
    call,
    detail,
    bases: batterOut ? 0 : 1,
    outs: outsMade.length,
    runs,
    basesAfter,
    foul: false,
    marker: { x: at.x, y: at.y, kind: outsMade.length ? 'out' : 'hit' },
    sim,
    ball,
    fielders: tracks,
    runners,
    events: {
      fielder: f.id, at: pickup.t, kind: 'field', style: 'scoop', release: routes.length ? routes[0].release : null,
      receiver: routes.length ? routes[routes.length - 1].receiver : null, lands: sim.firstGround.t, throws: throwEvents(routes), tags,
    },
    callAt,
    endAt: 0,
  };
  return finish(ctx, plan, { ball: at, throwBase: pick ? pick.m.to : null, from: at, deep: false, direct: true });
}

// ---- The outfield -------------------------------------------------------------------

function outfieldPlan(ctx, pickup) {
  const { level, bases, outs, sim, fielders } = ctx;
  const f = pickup.fielder;
  const tracks = standing(fielders);
  const at = { x: pickup.x, y: pickup.y };
  tracks[f.id].push(chase(f, at, pickup.t));
  const ready = pickup.t + f.transfer;
  const goings = readTheBall(ctx, sim.firstGround.t);
  const forced = forcedFrom(bases);
  // How a throw from here would go to each base, and when it would be on the bag.
  const cache = new Map();
  const route = (base) => {
    if (!cache.has(base)) cache.set(base, throwRoute(level, fielders, f, at, ready, BASE_ORDER[base], true));
    return cache.get(base);
  };
  const throwArrives = (base) => onTheBag(route(base));

  // Each runner, lead first, takes the furthest base he would reach before the throw by his coach's margin, never
  // passing the runner ahead or stopping on his base.
  const order = [...onBase(bases), 0];
  const moves = [];
  let limit = 5; // the base the runner ahead has reached (4 scores, so the next can too)
  for (const from of order) {
    const going = goings.get(from);
    let to = from + (forced.has(from) ? 1 : 0);
    for (let k = to + 1; k <= 4; k++) {
      if (reachTime(level, going, k) <= throwArrives(k) + (forced.has(from) && k === from + 1 ? 0 : PLAY.tagPad) - sendMargin(k, outs)) to = k;
      else break;
    }
    if (limit <= 3) to = Math.min(to, limit - 1);
    to = Math.max(to, from);
    moves.push({ from, to, going, forced: forced.has(from) && to === from + 1 });
    limit = to === 4 ? 5 : to;
  }

  // The throw: to the lead runner he can get; with no play anywhere, to the base ahead of the batter.
  const outAt = (m) => throwArrives(m.to) + (m.forced ? 0 : PLAY.tagPad);
  const playable = moves.filter((m) => m.to > m.from && outAt(m) <= reachTime(level, m.going, m.to));
  const playOn = playable.length ? playable.reduce((a, b) => (b.to > a.to ? b : a)) : null;
  const batterMove = moves[moves.length - 1];
  const throwBase = playOn ? playOn.to : Math.min(4, batterMove.to + 1);
  const th = route(throwBase);
  const routes = [th];

  // Trailing runners move up on a throw to a base ahead of them, when the man who catches it couldn't throw them out.
  if (throwBase >= 3) {
    const receiver = fielders[th.receiver];
    const caughtAt = onTheBag(th);
    const occupied = new Set(moves.filter((m) => m !== playOn).map((m) => m.to));
    for (const m of moves) {
      if (m === playOn || m.to >= throwBase - 1 || m.to >= 4) continue;
      const next = m.to + 1;
      if (occupied.has(next) && next < 4) continue;
      const back = caughtAt + receiver.transfer + dist(BASES[BASE_ORDER[throwBase]], baseSpot(next)) / receiver.throwSpeed + PLAY.catchPad + PLAY.tagPad;
      if (reachTime(level, m.going, next) <= back - sendMargin(next, outs)) {
        occupied.delete(m.to);
        m.to = next;
        occupied.add(next);
      }
    }
  }

  const runners = [];
  const outsMade = [];
  const scoredAt = new Map();
  const tags = [];
  for (const m of moves) {
    const out = m === playOn;
    const close = m.to >= 2 && m.to === throwBase && Math.abs(reachTime(level, m.going, m.to) - outAt(m)) < 0.6;
    const r = makeRun(level, m.going, m.to, { out, slide: close || out });
    runners.push(r);
    if (out) {
      outsMade.push({ t: outAt(m), force: m.forced });
      if (!m.forced) tags.push({ by: th.receiver, t: outAt(m) - PLAY.tagPad });
    }
    if (m.to === 4 && !out) scoredAt.set(r, reachTime(level, m.going, 4));
  }
  const { runs, basesAfter } = settle(ctx, runners, outsMade, scoredAt);
  const batterRun = runners[runners.length - 1];
  const batterTo = batterMove.to;
  const batterArrives = batterRun.path[batterRun.path.length - 1].t;
  const callAt = Math.max(batterArrives, th.arrives, ...outsMade.map((o) => o.t)) + PLAY.callPad;
  const ball = journey([flightLeg(sim, pickup.t), ...routeLegs(ctx, tracks, f.id, pickup.t, routes)]);
  const hitWord = ['', 'Single', 'Double', 'Triple', 'Inside-the-park home run'][batterRun.out ? batterTo - 1 : batterTo];
  let call = ['', 'SINGLE!', 'DOUBLE!', 'TRIPLE!', 'HOME RUN!'][batterTo];
  let detail = `${hitWord} ${sprayWord(at.x, at.y)}${runsWord(runs)}`;
  if (playOn) {
    if (playOn.from === 0) {
      call = 'OUT!';
      detail = `${hitWord} ${sprayWord(at.x, at.y)}, but out at ${BASE_WORD[playOn.to]} trying for ${['', '', 'a double', 'a triple', 'an inside-the-park home run'][playOn.to]}${runsWord(runs)}`;
    } else {
      detail += ` – ${RUNNER_WORD[playOn.from]} is thrown out at ${BASE_WORD[playOn.to]}`;
    }
  }
  const plan = {
    kind: batterRun.out ? 'out' : 'hit',
    call,
    detail,
    bases: batterRun.out ? batterTo - 1 : batterTo,
    outs: outsMade.length,
    runs,
    basesAfter,
    foul: false,
    marker: { x: sim.firstGround.x, y: sim.firstGround.y, kind: batterRun.out ? 'out' : batterTo === 4 ? 'homer' : 'hit' },
    sim,
    ball,
    fielders: tracks,
    runners,
    events: {
      fielder: f.id, at: pickup.t, kind: 'field', style: 'scoop', release: th.release, receiver: th.receiver, lands: sim.firstGround.t,
      throws: throwEvents(routes), tags,
    },
    callAt,
    endAt: 0,
  };
  return finish(ctx, plan, { ball: at, throwBase, from: at, deep: true, direct: !th.cutoff });
}
