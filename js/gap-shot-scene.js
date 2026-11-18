// Gap Shot's picture: what is on the field at any moment, and where the camera is,
// for the batter's view (the camera at the batter's eyes, behind home plate, nothing
// moving) and for a play (the camera rising to follow the ball and the fielders chasing
// it, then coming back). Kept free of the browser, so it is unit-tested; the game hands
// these to fielders-choice-art.js, which draws them in 3D.
//
// Everything here is a function of time since the crack of the bat (seconds) and the
// plan from gap-shot-play.js, so the same play is always drawn the same way.

import { BASES, FIELDERS, blendViews, lookAngles } from './fielders-choice-logic.js';
import { baseballShapes, ballShape, groundHeight, rgb, turnAbout } from './fielders-choice-models.js';
import { POSES, STRIDE, ease, keyframes, runPose } from './fielders-choice-players.js';
import { BASE_ORDER, batterView, fenceOf, fieldersOf } from './gap-shot-logic.js';
import { positionAt, runnerAt } from './gap-shot-play.js';

/**
 * @typedef {import('./gap-shot-play.js').Plan} Plan
 * @typedef {import('./fielders-choice-logic.js').View} View
 * @typedef {{x:number, y:number, kind:'hit'|'out'|'homer'|'foul'}} Marker
 */

export const CAMERA = {
  // Where the camera rises to, high behind home plate (feet), like a television camera.
  eye: { x: 0, y: -95, z: 62 },
  rise: 1.1, // seconds to get there from the batter's eyes
  back: 1.3, // seconds to come back to the batter's eyes after the play
  // The picture is zoomed so that what it follows (the ball, the fielder going for it, the runners) fills about
  // this much of the height of the screen, but never shows less than `least` feet across, within limits.
  fill: 0.62,
  least: 55,
  // On a home run, once the ball has gone, the batter is shown low in the picture, so the stands and the sky (and the
  // fireworks) are above him, and the picture is wider.
  trotCentre: 0.72,
  trotLeast: 110,
  fMin: 1,
  fMax: 3.6,
  smooth: 0.3, // seconds: how slowly the camera follows
  step: 1 / 30,
};

/** What each result looks like on the ground: bright enough to read from the batter's eyes against the grass and dirt. */
export const MARKER_COLOURS = {
  hit: '#2fbf63',
  out: '#d8403f',
  homer: '#f2b01e',
  foul: '#8d97b0',
};

const FENCE_COLOUR = rgb('#b9651f');
const FENCE_TOP = rgb('#e0a72a');
const UP = { x: 0, y: 0, z: 1 };

// Everyone's skin tone and number, so the same player looks the same all game.
const SKIN_OF = { P: 2, C: 4, '1B': 1, '2B': 0, SS: 5, '3B': 3, LF: 5, CF: 2, RF: 0, home: 3, first: 0, second: 5, third: 2 };
const NUMBER_OF = { P: 31, C: 9, '1B': 25, '2B': 4, SS: 6, '3B': 5, LF: 7, CF: 8, RF: 22, first: 12, second: 23, third: 3 };
const BAT_AT = { x: -5, y: -4.5 };
const SWING_END = 0.22;
const OUT_LEAVES = 1.0; // a runner put out leaves the field this long after the call

/** A solid shape from its centre and three axis vectors (their lengths are the sizes). */
function solid(mesh, c, ax, ay, az, colour, extra = {}) {
  return { mesh, m: [ax.x, ax.y, ax.z, 0, ay.x, ay.y, ay.z, 0, az.x, az.y, az.z, 0, c.x, c.y, c.z, 1], colour, ...extra };
}

/**
 * The portable fence at a level with one (Little League and High School): a low wall of panels with a
 * rail on top, all the way round from the left foul line to the right one, at the distance the home
 * run is measured to. None for the stadium's own wall.
 * @returns {import('./fielders-choice-models.js').Shape[]}
 */
export function fenceShapes(level) {
  if (!level.fence.portable) return [];
  const { radiusAt, height } = fenceOf(level);
  const out = [];
  const steps = 36;
  const at = (i) => {
    const deg = -45 + (90 * i) / steps;
    const r = radiusAt(deg);
    const a = (deg * Math.PI) / 180;
    return { x: r * Math.sin(a), y: r * Math.cos(a) };
  };
  for (let i = 0; i < steps; i++) {
    const a = at(i);
    const b = at(i + 1);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const n = { x: -d.y, y: d.x };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    out.push(solid('box', { x: mid.x, y: mid.y, z: height / 2 }, { x: (d.x * len) / 2, y: (d.y * len) / 2, z: 0 }, { x: n.x * 0.3, y: n.y * 0.3, z: 0 },
      { x: 0, y: 0, z: height / 2 }, FENCE_COLOUR));
    out.push(solid('box', { x: mid.x, y: mid.y, z: height + 0.2 }, { x: (d.x * len) / 2, y: (d.y * len) / 2, z: 0 }, { x: n.x * 0.45, y: n.y * 0.45, z: 0 },
      { x: 0, y: 0, z: 0.2 }, FENCE_TOP, { outline: false }));
  }
  // A post at each end of every panel, where the foul poles would be.
  for (let i = 0; i <= steps; i += 3) {
    const p = at(i);
    out.push(solid('cyl', { x: p.x, y: p.y, z: 0 }, { x: 0.35, y: 0, z: 0 }, { x: 0, y: 0.35, z: 0 }, { x: 0, y: 0, z: height + 0.5 }, FENCE_TOP, { taper: 1 }));
  }
  return out;
}

/**
 * The marks left on the field by each play: a dot where the ball landed or was caught, coloured by what it
 * was. Seen from the batter's eyes the far field is at a grazing angle, where a disc lying flat would
 * all but vanish, so each dot is a low dome sitting on the ground (flat underneath), bigger the further it
 * is from home plate so that it reads from there. A home run's dot is where it crossed the fence, so it is
 * drawn a little in front of it (the fence would hide it).
 * @param {Marker[]} markers
 * @returns {import('./fielders-choice-models.js').Shape[]}
 */
export function markerShapes(markers) {
  return markers.map((m) => {
    const distance = Math.hypot(m.x, m.y);
    const r = 2.6 + 0.016 * distance;
    const back = m.kind === 'homer' ? (distance - r - 4) / distance : 1;
    const x = m.x * back;
    const y = m.y * back;
    return solid('dome', { x, y, z: groundHeight(x, y) }, { x: r, y: 0, z: 0 }, { x: 0, y: r, z: 0 }, { x: 0, y: 0, z: r * 0.75 },
      rgb(MARKER_COLOURS[m.kind]));
  });
}

// ---- The camera --------------------------------------------------------------------

/**
 * What the camera looks at, at time `t`: the ball and the fielder who goes for it, and once he has it, the
 * runners still going too. On a home run, the batter running the bases once the ball has gone.
 * @param {Plan} plan
 * @returns {{x:number, y:number, z:number}[]}
 */
function interest(plan, t) {
  const ev = plan.events;
  const ball = plan.ball(t);
  if (plan.kind === 'homer') {
    const trailing = plan.runners[plan.runners.length - 1];
    if (t > plan.callAt + 0.9) {
      const p = runnerAt(trailing, t);
      return [{ x: p.x, y: p.y, z: 3 }];
    }
    // The ball, with the field it is leaving, so that there is something under it.
    return [ball, { x: ball.x * 0.6, y: ball.y * 0.6, z: 0 }];
  }
  const points = [ball];
  const at = (id) => {
    const segments = plan.fielders[id];
    if (!segments.length) return null;
    const p = positionAt(segments, segments[0].from, t);
    return { x: p.x, y: p.y, z: 3 };
  };
  if (ev.fielder) points.push(at(ev.fielder));
  if (ev.kind && t >= ev.at) {
    if (ev.receiver && ev.receiver !== ev.fielder) points.push(at(ev.receiver));
    for (const r of plan.runners) {
      if (r.path.length < 2 || ((r.out || r.leaves) && t >= plan.callAt + 0.5)) continue;
      const p = runnerAt(r, t);
      points.push({ x: p.x, y: p.y, z: 3 });
    }
  }
  return points.filter(Boolean);
}

/**
 * Where the camera is throughout a play, as a lookup: it rises from the batter's eyes to a high place
 * behind home plate, looks at what is going on (see `interest`), eases after it and zooms to fit it, then
 * comes back to the batter's eyes after the play.
 * @param {Plan} plan
 * @param {number} aspect
 * @returns {(t:number) => View}
 */
export function cameraPath(plan, aspect) {
  const { step } = CAMERA;
  const batter = batterView(aspect);
  const total = plan.endAt + CAMERA.back;
  const n = Math.ceil(total / step) + 1;
  const alpha = 1 - Math.exp(-step / CAMERA.smooth);
  const views = [];
  let target = null;
  let logF = Math.log(CAMERA.fMin);
  let centreY = 0.5;
  let last = null;
  for (let i = 0; i < n; i++) {
    const t = i * step;
    let view;
    if (t <= plan.endAt) {
      const points = interest(plan, t);
      const lo = { x: Infinity, y: Infinity, z: Infinity };
      const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
      for (const p of points) {
        for (const k of ['x', 'y', 'z']) {
          lo[k] = Math.min(lo[k], p[k]);
          hi[k] = Math.max(hi[k], p[k]);
        }
      }
      // Looking a little more at the high end of it: a ball in the air is what matters, not the grass under it.
      const raw = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2, z: lo.z + (hi.z - lo.z) * 0.75 };
      const trot = plan.kind === 'homer' && t > plan.callAt + 0.9;
      const extent = Math.max(trot ? CAMERA.trotLeast : CAMERA.least, hi.x - lo.x, hi.y - lo.y, (hi.z - lo.z) * 1.3);
      centreY += ((trot ? CAMERA.trotCentre : 0.5) - centreY) * alpha;
      target = target ? { x: target.x + (raw.x - target.x) * alpha, y: target.y + (raw.y - target.y) * alpha, z: target.z + (raw.z - target.z) * alpha } : raw;
      const distance = Math.hypot(target.x - CAMERA.eye.x, target.y - CAMERA.eye.y, target.z - CAMERA.eye.z);
      const wanted = Math.log(Math.min(CAMERA.fMax, Math.max(CAMERA.fMin, (CAMERA.fill * distance) / extent)));
      logF = i === 0 ? wanted : logF + (wanted - logF) * alpha;
      const high = { eye: CAMERA.eye, ...lookAngles(CAMERA.eye, target), f: Math.exp(logF), centreY };
      view = blendViews(batter, high, ease(Math.min(1, t / CAMERA.rise)));
      last = view;
    } else {
      view = blendViews(last, batter, ease((t - plan.endAt) / CAMERA.back));
    }
    views.push(view);
  }
  return (t) => {
    const x = Math.max(0, t) / step;
    const i = Math.min(n - 2, Math.floor(x));
    if (i < 0) return views[0];
    return blendViews(views[i], views[i + 1], x - i);
  };
}

// ---- The players ---------------------------------------------------------------------

function direction(from, to) {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  return d > 1e-6 ? { x: (to.x - from.x) / d, y: (to.y - from.y) / d } : null;
}

/** The segment someone is running along at `t`, if they are. */
function activeSegment(segments, t) {
  return segments.find((s) => t >= s.t0 && t < s.t1 && Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y) > 0.5) ?? null;
}

function runnerPlayer(from, batters, pose) {
  const key = from === 0 ? 'home' : BASE_ORDER[from];
  return { pose, team: 'away', helmet: true, number: from === 0 ? 10 + ((batters * 7) % 40) : NUMBER_OF[key], skin: SKIN_OF[key] };
}

/**
 * The fielders and runners (and the batter) at time `t` of a play.
 * @param {Plan} plan
 * @param {ReturnType<typeof fieldersOf>} fielders where each stands, how fast…
 * @param {number} t
 * @param {{batters:number}} info
 */
export function playFigures(plan, fielders, t, info) {
  const figures = [];
  const ev = plan.events;
  const ball = plan.ball(t);
  for (const f of Object.values(fielders)) {
    const segments = plan.fielders[f.id];
    const at = positionAt(segments, f.spot, t);
    const run = activeSegment(segments, t);
    const player = { team: 'home', number: NUMBER_OF[f.id], skin: SKIN_OF[f.id], glove: 'r', mask: false };
    if (run) {
      const length = Math.hypot(run.to.x - run.from.x, run.to.y - run.from.y);
      const travelled = (length * (t - run.t0)) / (run.t1 - run.t0 || 1);
      figures.push({
        at, facing: direction(run.from, run.to), player: { ...player, glove: 'l', pose: runPose(travelled / STRIDE.run) },
      });
      continue;
    }
    // Standing: watching the ball, ready for it when it is coming to him, throwing as he lets it go, and
    // turned to where he will throw it while he has it.
    let pose = t < 0.15 ? POSES.crouch : POSES.stand;
    let facing = direction(at, ball);
    if (!facing || Math.hypot(ball.x - at.x, ball.y - at.y) < 3) facing = null;
    const throws = ev.throws ?? [];
    const mine = throws.filter((th) => th.by === f.id);
    const involved = ev.fielder === f.id || ev.receiver === f.id || mine.length > 0;
    if (involved && t >= 0.15) pose = POSES.ready;
    const next = mine.find((th) => t < th.t0 + 0.35);
    if (next && (ev.fielder !== f.id || t >= ev.at)) {
      if (!facing || t >= next.t0 - 0.2) facing = direction(at, next.to) ?? facing;
      if (t >= next.t0 - 0.2) pose = POSES.release;
    }
    facing ??= { x: -at.x, y: -at.y };
    if (f.id === 'C' && t < 0.15) pose = POSES.catcher;
    figures.push({ at, facing, player: { ...player, pose } });
  }
  // The batter at the plate, then running; the runners on base.
  const batter = plan.runners.find((r) => r.from === 0);
  const callOver = plan.callAt + OUT_LEAVES;
  for (const r of plan.runners) {
    if ((r.out || r.leaves) && t >= callOver) continue;
    const at = runnerAt(r, t);
    const first = r.path[0];
    const moving = r.path.length > 1 && t > r.path[1].t && t < r.path[r.path.length - 1].t;
    if (moving) {
      // Facing along the leg they are on, and running by how far they have gone.
      let k = 1;
      while (k < r.path.length - 1 && t > r.path[k].t) k++;
      const from = r.path[k - 1].p;
      const to = r.path[k].p;
      let covered = 0;
      for (let j = 1; j < k; j++) covered += Math.hypot(r.path[j].p.x - r.path[j - 1].p.x, r.path[j].p.y - r.path[j - 1].p.y);
      covered += Math.hypot(at.x - from.x, at.y - from.y);
      figures.push({ at, facing: direction(from, to), player: runnerPlayer(r.from, info.batters, runPose(covered / STRIDE.run)) });
    } else if (r === batter && t < first.t + 0.9) {
      // The batter's swing, then the follow-through, standing in the box until he goes.
      const pose = keyframes([{ at: 0, pose: POSES.swing }, { at: SWING_END, pose: POSES.followThrough }], t);
      figures.push({ at, facing: { x: 1, y: 0 }, player: runnerPlayer(0, info.batters, pose), lookAt: FIELDERS.P.spot });
    } else if (r.from === 0) {
      figures.push({ at, facing: direction(at, BASES.first), player: runnerPlayer(0, info.batters, POSES.stand) });
    } else {
      figures.push({ at, facing: null, player: runnerPlayer(r.from, info.batters, t < 0.15 ? POSES.crouch : POSES.stand) });
    }
  }
  if (t >= SWING_END + 0.03) figures.push({ prop: 'bat', at: BAT_AT, angle: 2.6 });
  return figures;
}

/** The ball as shapes at time `t`, seen from `eye`: bigger the further it is, so it can be seen, with a shadow and a short trail. */
export function ballShapes(plan, t, eye) {
  const p = plan.ball(t);
  const distance = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
  const r = Math.max(0.22, 0.003 * distance);
  const out = [];
  const ground = groundHeight(p.x, p.y);
  const shadow = r * (1.4 + Math.min(1, Math.max(0, p.z) / 120));
  out.push(solid('quad', { x: p.x, y: p.y, z: ground + 0.03 }, { x: shadow, y: 0, z: 0 }, { x: 0, y: shadow, z: 0 }, UP, [0, 0, 0, 0.45], { shadow: true, outline: false }));
  [0.1, 0.07, 0.04].forEach((back, i, all) => {
    const q = plan.ball(Math.max(0, t - back));
    out.push({ ...ballShape(q, r * (0.6 + ((all.length - i) / all.length) * 0.3)), colour: [0.89, 0.87, 0.82, 0.12 + 0.1 * i] });
  });
  out.push(...baseballShapes(p, r, turnAbout({ x: 0.6, y: 0.8, z: 0 }, t * 22)));
  return out;
}

// ---- Fireworks -------------------------------------------------------------------------

/** Bursts of fireworks over the stands for a home run: where (normalised) and when (ms from the start of the play). */
export function fireworksFor(plan, from = plan.callAt) {
  const colours = ['#e0a72a', '#e8574a', '#6aa6d6', '#7fd36a', '#e8c48a'];
  return Array.from({ length: 10 }, (_, i) => ({
    x: 0.12 + ((i * 0.37) % 0.76),
    y: 0.1 + ((i * 0.23) % 0.3),
    at: (from + 0.2 + i * 0.4) * 1000,
    colour: colours[i % colours.length],
  }));
}

// ---- The batter's view --------------------------------------------------------------------

/**
 * Everyone at their places for the batter's view: the fielders crouching, ready, the runners on base.
 * Nobody moves. The catcher and the plate umpire are behind the camera.
 * @param {ReturnType<typeof fieldersOf>} fielders
 * @param {import('./fielders-choice-logic.js').Bases} bases
 * @param {{batters:number}} info
 */
export function restFigures(fielders, bases, info) {
  const figures = [];
  for (const f of Object.values(fielders)) {
    const player = { team: 'home', number: NUMBER_OF[f.id], skin: SKIN_OF[f.id], glove: 'r', mask: false, pose: f.id === 'C' ? POSES.catcher : POSES.crouch };
    figures.push({ at: f.spot, facing: { x: -f.spot.x, y: -f.spot.y }, player });
  }
  for (const base of ['first', 'second', 'third']) {
    if (!bases[base]) continue;
    const at = BASES[base];
    figures.push({ at, facing: { x: -at.x, y: -at.y }, player: runnerPlayer(BASE_ORDER.indexOf(base), info.batters, POSES.crouch) });
  }
  return figures;
}
