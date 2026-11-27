// Fielder's Choice's plays, worked out by Batter Up's defence (gap-shot-play.js), kept
// free of the browser so they can be unit-tested. Each batter really hits the ball: a
// spray angle, a launch angle and an exit speed, picked so that it goes to the player's
// position, and `planHit` follows it (hops and bounces, a fly carrying to the gap) and
// plays it out the way a real team would: the other fielders cover the bases and back
// them up, the cut-off man lines up, and the runners read the ball, each base runner at
// this batter's own speed (some are quicker than others). The player fields it and makes
// the throw; this file says where to (the base the ball should go to: where the defence
// throws it when a runner is arriving there, else the lead runner's base, so there is
// always a play), when the runner gets there, and what the play comes to: an out if the
// throw beat him, safe if not, and every runner a base further if the throw got away.
//
// Field positions are in feet, as in fielders-choice-logic.js; plan times are in
// seconds from the crack of the bat.

import {
  BASES, FIELDERS, FIELDERS_CHOICE_RULES, battingView, coveringFielder, lookAngles, planPlay, runnerMoves,
} from './fielders-choice-logic.js';
import { LEVELS, fieldersOf } from './gap-shot-logic.js';
import { planHit, positionAt, runnerAt } from './gap-shot-play.js';
import { mphToFps } from './gap-shot-physics.js';

/**
 * @typedef {import('./fielders-choice-logic.js').Base} Base
 * @typedef {import('./fielders-choice-logic.js').Bases} Bases
 * @typedef {import('./fielders-choice-logic.js').GameState} GameState
 * @typedef {import('./gap-shot-play.js').Plan} Plan
 * @typedef {{x:number, y:number}} Point
 */

export const BATTER_RULES = {
  // How hard and at what angle the ball comes off the bat, to an infielder and an outfielder (degrees and mph), and
  // how far either side of the fielder's own line from home plate (degrees).
  infield: { launch: [-14, 7], mph: [55, 108], spray: 14 },
  outfield: { launch: [-5, 32], mph: [66, 102], spray: 17 },
  // How quick this batter's runners are (feet a second): an average big leaguer is about 27.
  runnerSpeed: [24.5, 29.5],
  // Hits tried before falling back on the simple play (fielders-choice-logic.js's planPlay).
  tries: 120,
  // A fielder who takes longer than this (beyond his transfer) to throw after getting the ball has run somewhere
  // with it first (stepped on a bag himself): not a play for the player.
  carry: 0.35,
  // The time from the view settling on the base (SETTLE_MS, in throw-camera.js) to the runner getting there: `base`
  // ms, and `perSecond` more for each second a perfect real throw would have beaten him by, within `min` and `max`.
  window: { base: 1050, perSecond: 450, min: 1000, max: 1700 },
  // How fast the player's throw goes (feet a second), for that sum.
  throwSpeed: 125,
};

const ORDER = ['home', 'first', 'second', 'third', 'home'];
const DEG = Math.PI / 180;

/** The plan's base number (0 home, 1–3, 4 home again) as a base's name. */
export function baseName(k) {
  return ORDER[k];
}

/**
 * @typedef {object} Mover a runner on the play
 * @property {Base} from where they start ('home' for the batter)
 * @property {Base[]} path the bases they run through, from start to where they stop (one base: they stay put)
 * @property {boolean} thrownAt the throw is for them
 * @property {number} startU how far along `path` (0–1, by distance) they are when the ball is fielded
 * @property {number} [planIndex] which of the plan's runners they are
 *
 * @typedef {import('./fielders-choice-logic.js').Play & {
 *   plan: Plan|null, fieldT: number, caught: boolean, movers: Mover[], call: string, style: string|null,
 *   runnerSpeed: number,
 * }} BatterPlay what a batter does: the old Play's fields (target, cover, coverAt…), plus the whole plan
 */

/** A seeded random number generator (0–1), for tests and for repeatable plays. */
export function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * The play the next batter makes, to the player at `position`, with these
 * runners on and this many out: a real batted ball played out by the defence
 * (see the top of the file), or, if no hit tried makes a play for the player
 * (rare), the simple one fielders-choice-logic.js would have made.
 * @param {string} position one of PLAYABLE_POSITIONS
 * @param {Bases} bases
 * @param {number} outs
 * @param {() => number} [random]
 * @returns {BatterPlay}
 */
export function planBatter(position, bases, outs, random = Math.random, rules = BATTER_RULES) {
  const fielder = FIELDERS[position];
  const infield = Boolean(fielder.infield);
  const range = infield ? rules.infield : rules.outfield;
  const own = Math.atan2(fielder.spot.x, fielder.spot.y) / DEG;
  const runnerSpeed = rules.runnerSpeed[0] + random() * (rules.runnerSpeed[1] - rules.runnerSpeed[0]);
  const level = { ...LEVELS.pro, running: { speed: runnerSpeed } };
  const fielders = fieldersOf(level);
  for (let i = 0; i < rules.tries; i++) {
    const hit = {
      spray: (own + (random() * 2 - 1) * range.spray) * DEG,
      launch: (range.launch[0] + random() * (range.launch[1] - range.launch[0])) * DEG,
      speed: mphToFps(range.mph[0] + random() * (range.mph[1] - range.mph[0])),
    };
    const play = playFor(position, bases, outs, planHit(hit, level, bases, outs), fielders, rules);
    if (play) return { ...play, runnerSpeed, hit };
  }
  return simplePlay(position, bases, runnerSpeed);
}

/**
 * The player's play in a plan, or null if there isn't one for them: they must
 * get the ball (field it, or catch it with a runner tagging up) and throw it
 * straight away, with a runner still running to the base it should go to.
 * @param {Plan} plan
 * @returns {BatterPlay|null}
 */
export function playFor(position, bases, outs, plan, fielders, rules = BATTER_RULES) {
  const ev = plan.events;
  if (plan.kind === 'foul' || plan.kind === 'homer' || ev.fielder !== position || !ev.kind) return null;
  const infield = Boolean(FIELDERS[position].infield);
  // An infielder fields a ground ball; an outfielder either.
  if (infield && ev.kind !== 'field') return null;
  // A catch for the third out ends the inning: there is no throw to make.
  if (ev.kind === 'catch' && outs >= 2) return null;
  const me = fielders[position];
  const first = ev.throws[0];
  if (first && (first.by !== position || first.t0 - ev.at > me.transfer + rules.carry)) return null;
  if (!first && ev.kind === 'field') return null;
  const fieldT = ev.at;
  const fieldedAt = positionAt(plan.fielders[position], me.spot, fieldT);
  const caught = ev.kind === 'catch';

  // Where each runner is going, and who is still on the way when the ball is fielded.
  const running = plan.runners.map((r, i) => ({ r, i, arrive: r.path[r.path.length - 1].t }))
    .filter(({ r, arrive }) => r.to > r.from && !(caught && r.from === 0) && arrive > fieldT);
  if (!running.length) return null;
  // The base the defence throws to (the end of a relay), if someone is arriving there; else the lead runner's.
  const last = ev.throws.filter((t) => t.t0 >= (first?.t0 ?? 0)).reduce((end, t) => (!end || t.t0 >= end.t0 ? t : end), null);
  const thrownTo = last ? baseAt(last.to) : null;
  let chosen = thrownTo ? running.find(({ r }) => baseName(r.to) === thrownTo && r.to < 4) ?? running.find(({ r }) => r.to === 4 && thrownTo === 'home') : null;
  chosen ??= running.reduce((lead, c) => (!lead || c.r.to > lead.r.to ? c : lead), null);
  const { r: runner, arrive } = chosen;
  const target = baseName(runner.to);
  // Not a throw to the player's own bag (the third baseman runs a ball to third himself), nor from the outfield to
  // first (the batter is in long before it gets there).
  if (position === '3B' && target === 'third') return null;
  if (!infield && target === 'first') return null;

  const base = BASES[target];
  const throwFeet = Math.hypot(base.x - fieldedAt.x, base.y - fieldedAt.y);
  const along = { x: (base.x - fieldedAt.x) / throwFeet, y: (base.y - fieldedAt.y) / throwFeet };
  const ready = fieldT + me.transfer;
  const slack = arrive - (ready + throwFeet / rules.throwSpeed);
  const w = rules.window;
  const runnerMs = Math.round(Math.max(w.min, Math.min(w.max, w.base + w.perSecond * slack)));

  // Each runner runs to where the plan sends them (the player's throw is the only one made, so nobody else is put
  // out), but a batter whose ball was caught, who is out and leaves.
  const movers = plan.runners.map((r, i) => {
    const from = baseName(r.from);
    const path = ORDER.slice(r.from, Math.max(r.from, Math.min(r.to, 4)) + 1);
    return { from, path, thrownAt: r === runner, startU: pathShare(path, runnerAt(r, fieldT)), planIndex: i };
  }).filter((m) => m.from !== 'home' || !caught);
  const runnerPath = movers.find((m) => m.thrownAt).path;
  return {
    kind: infield ? 'grounder' : 'hit',
    position,
    start: me.spot,
    fieldedAt,
    target,
    runnerFrom: baseName(runner.from),
    runnerPath,
    cover: coveringFielder(position, target),
    coverAt: { x: base.x + along.x * FIELDERS_CHOICE_RULES.coverBehind, y: base.y + along.y * FIELDERS_CHOICE_RULES.coverBehind },
    throwFeet,
    runnerMs,
    plan,
    fieldT,
    caught,
    movers,
    call: describe(plan, infield, runner, caught, fieldT),
    style: ev.style,
  };
}

/** The base a fielder throwing to `to` is throwing to (the nearest bag). */
function baseAt(to) {
  let best = null;
  for (const [name, p] of Object.entries(BASES)) {
    const d = Math.hypot(p.x - to.x, p.y - to.y);
    if (!best || d < best.d) best = { name, d };
  }
  return best.d < 20 ? best.name : null;
}

/** How far along a path of bases (0–1, by distance) the point nearest `p` is. */
export function pathShare(path, p) {
  if (path.length < 2) return 1;
  const points = path.map((b) => BASES[b]);
  let total = 0;
  const legs = [];
  for (let i = 1; i < points.length; i++) {
    const L = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    legs.push(L);
    total += L;
  }
  let best = { d: Infinity, at: 0 };
  let before = 0;
  legs.forEach((L, i) => {
    const a = points[i];
    const b = points[i + 1];
    const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (L * L))) : 0;
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.d) best = { d, at: before + t * L };
    before += L;
  });
  return total ? best.at / total : 0;
}

/** What kind of ball it was, in a word or two, for the caption: "Hard grounder!", "Base hit!", "Sac fly!"… */
function describe(plan, infield, runner, caught, fieldT) {
  const mph = plan.sim.samples.length > 1 ? Math.hypot(plan.sim.samples[1].x - plan.sim.samples[0].x, plan.sim.samples[1].y - plan.sim.samples[0].y,
    plan.sim.samples[1].z - plan.sim.samples[0].z) / (plan.sim.samples[1].t - plan.sim.samples[0].t) / 1.4667 : 80;
  if (infield) {
    const first = plan.sim.firstGround;
    const hop = Math.max(0, ...plan.sim.samples.filter((s) => first && s.t > first.t && s.t < first.t + 1.2).map((s) => s.z));
    if (mph < 68) return 'Slow roller!';
    if (hop > 9) return 'Chopper!';
    if (mph > 96) return 'Hard grounder!';
    return 'Grounder!';
  }
  if (caught) return runner.to === 4 ? 'Sac fly!' : 'Caught! He’s tagging up!';
  if (plan.sim.wallHits.some((w) => w.t < fieldT)) return 'Off the wall!';
  return plan.bases >= 2 ? 'In the gap!' : 'Base hit!';
}

/**
 * The player's own eyes while the ball comes to them, `t` seconds after the
 * crack of the bat: they run where the plan has them run, looking in at home
 * plate as the ball is hit and then following the ball (up into the sky for a
 * fly, right into the glove), and crouch to field a ground ball as it gets to
 * them. At the crack it is the view of home plate (battingView); once a
 * ground ball is near, it turns back towards home so the glove takes it in
 * front of them.
 * @param {BatterPlay} play
 * @param {number} t
 * @returns {import('./fielders-choice-logic.js').View}
 */
export function fieldingView(play, t, rules = FIELDERS_CHOICE_RULES) {
  const start = battingView(play.start, rules);
  if (!play.plan) return start;
  const k = Math.max(0, Math.min(t, play.fieldT));
  const at = positionAt(play.plan.fielders[play.position], play.start, k);
  const ball = play.plan.ball(k);
  const crouch = play.caught ? 0 : Math.max(0, Math.min(1, (k - (play.fieldT - 0.45)) / 0.45));
  const eye = { x: at.x, y: at.y, z: rules.eyeHeight - 1.6 * crouch };
  const near = Math.hypot(ball.x - eye.x, ball.y - eye.y, ball.z - eye.z);
  // (A ball in the air is watched right into the glove; a ground ball until it is nearly there.)
  const follow = Math.min(1, k / 0.5) * (play.caught ? 1 : 0.8 * Math.max(0, Math.min(1, (near - 6) / 14)));
  const home = { x: 0, y: 0, z: 0 };
  const look = { x: home.x + (ball.x - home.x) * follow, y: home.y + (ball.y - home.y) * follow, z: home.z + (ball.z - home.z) * follow };
  const angles = lookAngles(eye, look);
  // Zoomed out a little for a fly, so the sky round the ball shows.
  const wide = play.caught ? 1 - 0.4 * Math.min(1, k / 0.8) : 1;
  return {
    eye,
    yaw: angles.yaw,
    pitch: Math.max(-0.55, Math.min(1.1, angles.pitch)),
    f: start.f * wide,
    centreY: start.centreY + (0.5 - start.centreY) * follow,
  };
}

/**
 * The simple play (fielders-choice-logic.js's), with no plan behind it: the
 * ball comes straight to the fielder and the runners all run the same way.
 * @returns {BatterPlay}
 */
export function simplePlay(position, bases, runnerSpeed = 27, random = Math.random) {
  const play = planPlay(position, bases, random);
  const movers = runnerMoves(play, bases).map((m) => ({ ...m, startU: 0 }));
  const call = { grounder: 'Grounder!', dinker: 'Dinker!', hit: 'Base hit!' }[play.kind];
  return { ...play, plan: null, fieldT: 0, caught: false, movers, call, style: null, runnerSpeed };
}

/**
 * What a play comes to. The runner the throw is for is out if `out`; a
 * batter whose ball was caught is out too. Everyone else ends where they ran
 * to, and if the throw got away (`error`) every runner who isn't out takes
 * one more base. On a third out that is a force (or the batter at first), no
 * runs count; on a tag out, the runners who scored still count (they were in
 * before the tag). After the third out, or once the mercy rule's runs have
 * scored, the inning is over: the returned state is the start of the next one
 * (or the game is over).
 * @param {GameState} state
 * @param {BatterPlay} play
 * @param {{out: boolean, error?: boolean}} result
 * @returns {{state: GameState, runs: number, outs: number, inningOver: boolean, mercy: boolean, gameOver: boolean, ends: Record<string, Base|'out'>}}
 */
export function batterResult(state, play, { out, error = false }, rules = FIELDERS_CHOICE_RULES) {
  const bases = { first: false, second: false, third: false };
  let runs = 0;
  let outs = play.caught ? 1 : 0;
  let forced = false;
  const ends = {};
  // Lead runners first, so a runner taking an extra base never lands on someone else.
  const order = (m) => (m.from === 'home' ? 0 : ORDER.indexOf(m.from));
  const movers = [...play.movers].sort((a, b) => order(b) - order(a));
  for (const m of movers) {
    if (m.thrownAt && out) {
      outs++;
      ends[m.from] = 'out';
      forced = isForce(play, m, state.bases);
      continue;
    }
    let k = m.path.length - 1 + order(m);
    if (error) k = Math.min(4, k + 1);
    // Never onto a base taken by a runner ahead.
    while (k > 0 && k < 4 && bases[ORDER[k]]) k--;
    if (k >= 4) {
      runs++;
      ends[m.from] = 'home';
    } else if (k > 0) {
      bases[ORDER[k]] = true;
      ends[m.from] = ORDER[k];
    }
  }
  const totalOuts = state.outs + outs;
  if (totalOuts >= rules.outsPerInning && forced) runs = 0;
  const inningRuns = state.inningRuns + runs;
  const next = { ...state, outs: totalOuts, inningRuns, runs: state.runs + runs, bases, batters: state.batters + 1 };
  const mercy = totalOuts < rules.outsPerInning && inningRuns >= rules.mercyRuns;
  const inningOver = totalOuts >= rules.outsPerInning || mercy;
  const gameOver = inningOver && state.inning >= state.innings;
  if (gameOver) next.over = true;
  else if (inningOver) Object.assign(next, { inning: state.inning + 1, outs: 0, inningRuns: 0, bases: { first: false, second: false, third: false } });
  return { state: next, runs, outs, inningOver, mercy, gameOver, ends };
}

/** Whether putting this runner out was a force: the batter at first, or a runner who had to move up to make room. */
function isForce(play, m, bases) {
  if (play.caught) return false;
  if (m.from === 'home') return play.target === 'first';
  const forcedFrom = { first: true, second: bases.first, third: bases.first && bases.second };
  return forcedFrom[m.from] && ORDER.indexOf(play.target, 1) === ORDER.indexOf(m.from, 1) + 1;
}
