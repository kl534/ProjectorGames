// Batter Up's picture: what is on the field at any moment, and where the camera is,
// for the batter's view (the camera at the batter's eyes, behind home plate, nothing
// moving) and for a play (the camera rising to follow the ball and the fielders chasing
// it, then coming back), and what goes with it: the players' shadows under the lights,
// the ball's tracer, dust where it bounces, the fence, the dots and the fireworks. Kept
// free of the browser, so it is unit-tested; the game hands these to fielders-choice-art.js,
// which draws them in 3D, and gap-shot-art.js, which draws the tracer and fireworks flat.
//
// Everything here is a function of time since the crack of the bat (seconds) and the
// plan from gap-shot-play.js, so the same play is always drawn the same way.

import { BASES, FIELDERS, blendViews, lookAngles, overrun } from './fielders-choice-logic.js';
import { baseballShapes, ballShape, groundHeight, rgb, turnAbout } from './fielders-choice-models.js';
import { POSES, STRIDE, blendPoses, ease, handAt, keyframes, reachPose, runPose, swapSides } from './fielders-choice-players.js';
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

// A portable fence's padded vinyl panels (two greens, so the panels show), its yellow home-run rail and grey posts.
const FENCE_COLOURS = [rgb('#1f5a3c'), rgb('#1b5136')];
const FENCE_TOP = rgb('#f0c22c');
const FENCE_POST = rgb('#8b9098');
const UP = { x: 0, y: 0, z: 1 };

// Everyone's skin tone and number, so the same player looks the same all game.
const SKIN_OF = { P: 2, C: 4, '1B': 1, '2B': 0, SS: 5, '3B': 3, LF: 5, CF: 2, RF: 0, home: 3, first: 0, second: 5, third: 2 };
const NUMBER_OF = { P: 31, C: 9, '1B': 25, '2B': 4, SS: 6, '3B': 5, LF: 7, CF: 8, RF: 22, first: 12, second: 23, third: 3 };
const BAT_AT = { x: -5, y: -4.5 };
const BAT_AT_BOX = 2.8; // how far from the middle of the plate the batter stands
const SWING_END = 0.22;
const OUTFIELD = ['LF', 'CF', 'RF']; // a batter who stops at first rounds it on a ball one of them fields
const OUT_LEAVES = 1.0; // a runner put out leaves the field this long after the call
const SLIDE_TIME = 0.35; // seconds of a slide before the bag

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
      { x: 0, y: 0, z: height / 2 }, FENCE_COLOURS[i % 2]));
    // The yellow rail along the top: over it is a home run.
    out.push(solid('box', { x: mid.x, y: mid.y, z: height + 0.18 }, { x: (d.x * len) / 2, y: (d.y * len) / 2, z: 0 }, { x: n.x * 0.42, y: n.y * 0.42, z: 0 },
      { x: 0, y: 0, z: 0.18 }, FENCE_TOP, { outline: false }));
  }
  // A grey post between every few panels, and a foul pole at each end, standing well above the fence.
  for (let i = 0; i <= steps; i += 3) {
    const p = at(i);
    const pole = i === 0 || i === steps;
    out.push(solid('cyl', { x: p.x, y: p.y, z: 0 }, { x: pole ? 0.4 : 0.3, y: 0, z: 0 }, { x: 0, y: pole ? 0.4 : 0.3, z: 0 },
      { x: 0, y: 0, z: pole ? height * 4 : height + 0.5 }, pole ? FENCE_TOP : FENCE_POST, { taper: 1 }));
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
  return markers.flatMap((m) => {
    const distance = Math.hypot(m.x, m.y);
    const r = 2.6 + 0.016 * distance;
    const back = m.kind === 'homer' ? (distance - r - 4) / distance : 1;
    const x = m.x * back;
    const y = m.y * back;
    const z = groundHeight(x, y);
    const colour = rgb(MARKER_COLOURS[m.kind]);
    // A soft glow of its colour on the ground round it, so it reads like a spot of light, not a stone.
    const glow = r * 2.4;
    return [
      solid('quad', { x, y, z: z + 0.03 }, { x: glow, y: 0, z: 0 }, { x: 0, y: glow, z: 0 }, UP, [colour[0], colour[1], colour[2], 0.55], { shadow: true, outline: false }),
      solid('dome', { x, y, z }, { x: r, y: 0, z: 0 }, { x: 0, y: r, z: 0 }, { x: 0, y: 0, z: r * 0.75 }, colour),
    ];
  });
}

// ---- Night shadows ---------------------------------------------------------------------

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

/** The angle to add to `from` to get to `to` the short way round (between -π and π). */
function turnBetween(from, to) {
  const d = to - from;
  return d - Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
}

/** A view part of the way from one to another, its yaw taken as it is (see cameraPath), the zoom evenly in its logarithm. */
function blendRaw(a, b, u) {
  const lerp = (p, q) => p + (q - p) * u;
  return {
    eye: { x: lerp(a.eye.x, b.eye.x), y: lerp(a.eye.y, b.eye.y), z: lerp(a.eye.z, b.eye.z) },
    yaw: lerp(a.yaw, b.yaw),
    pitch: lerp(a.pitch, b.pitch),
    f: Math.exp(lerp(Math.log(a.f), Math.log(b.f))),
    centreY: lerp(a.centreY, b.centreY),
  };
}

/**
 * Where the camera is throughout a play, as a lookup: it rises from the batter's eyes to a high place
 * behind home plate, looks at what is going on (see `interest`), eases after it and zooms to fit it, then
 * comes back to the batter's eyes after the play. `start` is the view it begins from and returns to, the batter's eyes
 * unless a game (Strike Zone's pitcher's view) gives its own.
 * @param {Plan} plan
 * @param {number} aspect
 * @param {View} [start]
 * @returns {(t:number) => View}
 */
export function cameraPath(plan, aspect, start = batterView(aspect)) {
  const { step } = CAMERA;
  const batter = start;
  const total = plan.endAt + CAMERA.back;
  const n = Math.ceil(total / step) + 1;
  const alpha = 1 - Math.exp(-step / CAMERA.smooth);
  const highs = [];
  let target = null;
  let logF = Math.log(CAMERA.fMin);
  let centreY = 0.5;
  let yaw = null;
  for (let i = 0; i < n; i++) {
    const t = i * step;
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
      const angles = lookAngles(CAMERA.eye, target);
      // The yaw carried on continuously (not wrapped back into a circle), so the camera never whips round when it passes the
      // opposite of where it began.
      yaw = yaw === null ? angles.yaw : yaw + turnBetween(yaw, angles.yaw);
      highs.push({ eye: CAMERA.eye, yaw, pitch: angles.pitch, f: Math.exp(logF), centreY });
    }
  }
  // The turn from the start is the short way to where the camera looks as it has risen, decided once (a start looking the
  // opposite way to the play, as the pitcher's view does, would otherwise turn either way as the target drifted).
  const settled = highs[Math.min(highs.length - 1, Math.round(CAMERA.rise / step))];
  const from = { ...batter, yaw: settled.yaw + turnBetween(settled.yaw, batter.yaw) };
  const views = [];
  let last = null;
  for (let i = 0; i < n; i++) {
    const t = i * step;
    if (t <= plan.endAt) {
      last = blendRaw(from, highs[i], ease(Math.min(1, t / CAMERA.rise)));
      views.push(last);
    } else {
      views.push(blendRaw(last, { ...batter, yaw: last.yaw + turnBetween(last.yaw, batter.yaw) }, ease((t - plan.endAt) / CAMERA.back)));
    }
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

// How long each move takes either side of its moment (seconds): reaching for a ball in the air, laying out for one,
// getting down for a ground ball, reaching for a throw, the throw itself, putting a tag on.
const MOVES = {
  reach: [0.3, 0.25],
  dive: [0.25, 0.75],
  scoop: [0.3, 0.15],
  take: [0.3, 0.2],
  throw: [0.45, 0.3],
  tag: [0.05, 0.45],
};

/** Keyframes from `rest` into `pose` at `at`, held, and back, over a move's window. */
function move(rest, pose, at, [before, after], t, back = rest) {
  return keyframes([{ at: at - before, pose: rest }, { at, pose }, { at: at + after * 0.5, pose }, { at: at + after, pose: back }], t);
}

/** How far into a move (0–1) the body is at `t`, as `move` blends it: in, held, and out again. */
function moveWeight(at, [before, after], t) {
  if (t < at) return ease((t - at + before) / before);
  if (t < at + after * 0.5) return 1;
  return 1 - ease((t - at - after * 0.5) / (after * 0.5));
}

/**
 * What a fielder is doing at `t` when it is more than running or standing, or null: catching a ball in the air
 * (reaching for it at its height, laid out for a low one he only just gets to, leaping for a high one), getting
 * down to field a ground ball, reaching for a throw coming to him, throwing (gathering himself, the stride with an
 * outfielder's crow hop, the release and the follow-through, turned to where it goes), and putting a tag on.
 * @returns {{pose:object, facing:{x:number, y:number}|null, glove:'l'|'r'}|null}
 */
function fielderMove(plan, f, at, t) {
  const ev = plan.events;
  const throws = ev.throws ?? [];
  const towards = (p) => direction(at, p);
  // Throwing.
  for (const th of throws) {
    if (th.by !== f.id || t < th.t0 - MOVES.throw[0] || t > th.t0 + MOVES.throw[1]) continue;
    const hop = OUTFIELDERS.includes(f.id);
    const gather = hop ? { ...POSES.set, lift: 0.55 } : POSES.set;
    const pose = keyframes([
      { at: th.t0 - MOVES.throw[0], pose: POSES.ready },
      { at: th.t0 - 0.3, pose: gather },
      { at: th.t0 - 0.12, pose: POSES.stride },
      { at: th.t0, pose: POSES.release },
      { at: th.t0 + MOVES.throw[1], pose: POSES.pitchFollow },
    ], t);
    return { pose, facing: towards(th.to), glove: 'l' };
  }
  // A tag on a runner sliding in: the glove swept down to the bag.
  for (const tag of ev.tags ?? []) {
    if (tag.by !== f.id || t < tag.t - MOVES.tag[0] || t > tag.t + MOVES.tag[1]) continue;
    const { pose, glove } = reachPose({ x: 1.3, y: 0.45 });
    return { pose: move(POSES.ready, pose, tag.t, MOVES.tag, t), facing: null, glove };
  }
  // Taking a throw: the glove out to where the ball arrives, at the chest.
  for (const th of throws) {
    if (th.toId !== f.id || t < th.t1 - MOVES.take[0] || t > th.t1 + MOVES.take[1]) continue;
    const { pose, glove } = reachPose({ x: 0.55, y: plan.ball(th.t1).z });
    return { pose: move(POSES.ready, pose, th.t1, MOVES.take, t), facing: towards(plan.ball(th.t0)), glove };
  }
  if (ev.fielder !== f.id || ev.at == null) return null;
  const ball = plan.ball(ev.at);
  const before = plan.ball(ev.at - 0.25);
  if (ev.kind === 'field') {
    if (t < ev.at - MOVES.scoop[0] || t > ev.at + MOVES.scoop[1]) return null;
    // Down in front of the ball, glove on the ground, eyes on it.
    const { pose, glove } = reachPose({ x: 0.5, y: Math.min(2, Math.max(0.25, ball.z)) });
    return { pose: move(POSES.ready, pose, ev.at, MOVES.scoop, t), facing: towards(before), glove, glovePoint: gloveShift(pose, glove, ev.at, MOVES.scoop, t) };
  }
  if (ev.kind === 'catch') {
    const dive = ev.style === 'dive';
    const window = dive ? MOVES.dive : MOVES.reach;
    if (t < ev.at - window[0] || t > ev.at + window[1]) return null;
    const { pose, glove } = dive ? reachPose({ x: 2.5, y: 1 }, { dive: true }) : reachPose({ x: 0.6, y: Math.max(1, ball.z) });
    // Laid out, he stays down a moment before getting up.
    const back = dive ? blendPoses(pose, POSES.crouch, 0.6) : POSES.ready;
    return {
      pose: move(POSES.ready, pose, ev.at, window, t, back), facing: towards(before) ?? null, glove, glovePoint: gloveShift(pose, glove, ev.at, window, t),
    };
  }
  return null;
}

const OUTFIELDERS = ['LF', 'CF', 'RF'];

/**
 * Where the glove is, across the body (feet, to the figure's right), as far into the move as he is: the figure is
 * drawn that far the other way, so the glove, not his feet, is where the ball is (laid out in a dive, it is a body's
 * length away).
 */
function gloveShift(pose, glove, at, window, t) {
  return { right: -handAt(pose, glove).x * moveWeight(at, window, t) };
}

function runnerPlayer(from, info, pose) {
  const key = from === 0 ? 'home' : BASE_ORDER[from];
  // A batter shorter or taller than usual (Strike Zone's lineups) is the whole figure scaled, and a young one has no beard.
  const size = from === 0 && info.batterScale ? { scale: info.batterScale, youth: info.batterScale < 0.85 } : {};
  // A right-hander's near-side limbs are drawn the way a left-hander's are, so each is the other's mirror image.
  const turned = from === 0 && info.batterSide === 'R' ? swapSides(pose) : pose;
  return { pose: turned, ...size, team: 'away', helmet: true, number: from === 0 ? 10 + ((info.batters * 7) % 40) : NUMBER_OF[key], skin: SKIN_OF[key] };
}

/**
 * The fielders and runners (and the batter) at time `t` of a play.
 * @param {Plan} plan
 * @param {ReturnType<typeof fieldersOf>} fielders where each stands, how fast…
 * @param {number} t
 * @param {{batters:number, batterSide?:'R'|'L', batterScale?:number}} info `batterSide`: a left-handed batter (Strike Zone's)
 *   stands on the other side of the plate, facing the other way (a right-handed one, as in Batter Up, if not given);
 *   `batterScale`: his height over a six-footer's
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
    const doing = fielderMove(plan, f, at, t);
    if (doing) {
      // Turned the way he runs if he is still running, else the way the move has him.
      const facing = (run ? direction(run.from, run.to) : null) ?? doing.facing ?? direction(at, ball) ?? { x: -at.x, y: -at.y };
      // (Facing f, his right is (f.y, -f.x).)
      const shift = doing.glovePoint ? doing.glovePoint.right : 0;
      const drawnAt = { x: at.x - facing.y * shift, y: at.y + facing.x * shift };
      figures.push({ at: drawnAt, facing, player: { ...player, glove: doing.glove, pose: doing.pose } });
      continue;
    }
    if (run) {
      // Striding by how far he has really gone: slowly as he gets going, flat out, then pulling up.
      const travelled = Math.hypot(at.x - run.from.x, at.y - run.from.y);
      figures.push({
        at, facing: direction(run.from, run.to), player: { ...player, glove: 'l', pose: runPose(travelled / STRIDE.run) },
      });
      continue;
    }
    // Standing: watching the ball, ready for it when it is coming to him, and turned to where he will throw it
    // while he has it (the throw itself is a move).
    let pose = t < 0.15 ? POSES.crouch : POSES.stand;
    let facing = direction(at, ball);
    if (!facing || Math.hypot(ball.x - at.x, ball.y - at.y) < 3) facing = null;
    const throws = ev.throws ?? [];
    const mine = throws.filter((th) => th.by === f.id);
    const involved = ev.fielder === f.id || throws.some((th) => th.toId === f.id) || mine.length > 0;
    if (involved && t >= 0.15) pose = POSES.ready;
    const next = mine.find((th) => t < th.t0);
    if (next && (ev.fielder !== f.id || t >= ev.at) && Math.hypot(ball.x - at.x, ball.y - at.y) < 3) facing = direction(at, next.to) ?? facing;
    facing ??= { x: -at.x, y: -at.y };
    if (f.id === 'C' && t < 0.15) pose = POSES.catcher;
    figures.push({ at, facing, player: { ...player, pose } });
  }
  // The batter at the plate, then running; the runners on base.
  const batter = plan.runners.find((r) => r.from === 0);
  const callOver = plan.callAt + OUT_LEAVES;
  const lefty = info.batterSide === 'L';
  for (const r of plan.runners) {
    if ((r.out || r.leaves) && t >= callOver) continue;
    let at = runnerAt(r, t);
    // A left-handed batter starts from the other side of the plate: the shift is gone by the time he is off on his first leg.
    if (lefty && r.from === 0 && r.path.length > 1) {
      const k = Math.min(1, Math.max(0, (t - r.path[0].t) / (r.path[1].t - r.path[0].t || 1)));
      at = { x: at.x + 2 * BAT_AT_BOX * (1 - k), y: at.y };
    }
    const first = r.path[0];
    const last = r.path[r.path.length - 1];
    const moving = r.path.length > 1 && t > r.path[1].t && t < last.t;
    if (moving) {
      // Facing along the leg they are on, and running by how far they have gone.
      let k = 1;
      while (k < r.path.length - 1 && t > r.path[k].t) k++;
      const from = r.path[k - 1].p;
      const to = r.path[k].p;
      if (Math.hypot(to.x - from.x, to.y - from.y) < 0.5) {
        // Off the bag, waiting to see whether a fly ball is caught: crouched, facing the next base.
        const next = r.path.slice(k).find((q) => Math.hypot(q.p.x - at.x, q.p.y - at.y) > 0.5)?.p;
        figures.push({ at, facing: next ? direction(at, next) : null, player: runnerPlayer(r.from, info, POSES.ready) });
        continue;
      }
      let covered = 0;
      for (let j = 1; j < k; j++) covered += Math.hypot(r.path[j].p.x - r.path[j - 1].p.x, r.path[j].p.y - r.path[j - 1].p.y);
      covered += Math.hypot(at.x - from.x, at.y - from.y);
      let pose = runPose(covered / STRIDE.run);
      // Sliding into the bag on a close play, feet first.
      if (r.slide && k === r.path.length - 1 && t > last.t - SLIDE_TIME) pose = blendPoses(pose, POSES.slide, ease((t - last.t + SLIDE_TIME) / 0.15));
      figures.push({ at, facing: direction(from, to), player: runnerPlayer(r.from, info, pose) });
    } else if (r.slide && r.path.length > 1 && t >= last.t && t < last.t + 1.1) {
      // Down on the bag after the slide, then up again.
      const prev = r.path[r.path.length - 2].p;
      const pose = keyframes([{ at: last.t + 0.5, pose: POSES.slide }, { at: last.t + 1.1, pose: POSES.stand }], t);
      figures.push({ at, facing: direction(prev, last.p), player: runnerPlayer(r.from, info, pose) });
    } else if (r === batter && r.to === 1 && r.path.length > 1 && t >= last.t) {
      // Past first base and back: through it on a ground ball, round it on a hit to the outfield.
      const o = overrun(OUTFIELD.includes(ev.fielder) && !r.out ? 'round' : 'through', t - last.t);
      const pose = o.gait === 'stand' ? POSES.stand : runPose(o.ran / STRIDE[o.gait === 'jog' ? 'jog' : 'run'], { jog: o.gait === 'jog' });
      figures.push({ at: o.at, facing: o.facing, player: runnerPlayer(0, info, pose) });
    } else if (r === batter && t < first.t + 0.9) {
      // The batter's swing, then the follow-through, standing in the box until he goes.
      const pose = keyframes([{ at: 0, pose: POSES.swing }, { at: SWING_END, pose: POSES.followThrough }], t);
      figures.push({ at, facing: { x: lefty ? -1 : 1, y: 0 }, player: runnerPlayer(0, info, pose), lookAt: FIELDERS.P.spot });
    } else if (r.from === 0) {
      figures.push({ at, facing: direction(at, BASES.first), player: runnerPlayer(0, info, POSES.stand) });
    } else {
      figures.push({ at, facing: null, player: runnerPlayer(r.from, info, t < 0.15 ? POSES.crouch : POSES.stand) });
    }
  }
  if (t >= SWING_END + 0.03) figures.push({ prop: 'bat', at: lefty ? { x: -BAT_AT.x, y: BAT_AT.y } : BAT_AT, angle: lefty ? Math.PI - 2.6 : 2.6 });
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

// ---- The ball's tracer and where it lands ---------------------------------------------------

const TRACER = { step: 1 / 60, fade: 0.8 };

/**
 * When the ball's own flight ends, for the tracer: when it is caught or picked up, it first comes down, or (a
 * home run) a little after it clears the fence.
 * @param {Plan} plan
 */
export function flightEnd(plan) {
  const { sim, events } = plan;
  let end = sim.end.t;
  if (events.kind && events.at != null) end = Math.min(end, events.at);
  if (sim.firstGround) end = Math.min(end, sim.firstGround.t);
  if (plan.kind === 'homer' && sim.overFence) end = Math.min(end, sim.overFence.t + 0.6);
  return end;
}

/**
 * The tracer at time `t`, as television draws it: the line the ball has flown since it left the bat, up to
 * where it is now (or where its flight ended), fading away once it has. Null when there is none to draw.
 * @param {Plan} plan
 * @returns {{points: {x:number, y:number, z:number}[], alpha: number, flying: boolean}|null}
 */
export function tracerFor(plan, t) {
  const end = flightEnd(plan);
  if (t <= 0 || t > end + TRACER.fade) return null;
  const upTo = Math.min(t, end);
  const points = [];
  for (let s = 0; s < upTo; s += TRACER.step) points.push(plan.ball(s));
  points.push(plan.ball(upTo));
  if (points.length < 2) return null;
  return { points, alpha: t <= end ? 1 : 1 - (t - end) / TRACER.fade, flying: t <= end };
}

const DUST = { life: 0.9, colour: [0.74, 0.62, 0.47] };

/**
 * A puff of dust where the ball comes down, at each bounce before a fielder has it: it spreads and fades.
 * @param {Plan} plan
 * @returns {import('./fielders-choice-models.js').Shape[]}
 */
export function dustShapes(plan, t) {
  const until = plan.events.kind && plan.events.at != null ? plan.events.at : Infinity;
  const out = [];
  for (const b of plan.sim.bounces ?? []) {
    if (b.t > until) break;
    const u = (t - b.t) / DUST.life;
    if (u < 0 || u >= 1) continue;
    const r = 1 + 4.5 * Math.sqrt(u);
    out.push(solid('sphere', { x: b.x, y: b.y, z: groundHeight(b.x, b.y) }, { x: r, y: 0, z: 0 }, { x: 0, y: r, z: 0 }, { x: 0, y: 0, z: r * 0.45 },
      [...DUST.colour, 0.4 * (1 - u) * (1 - u)]));
  }
  return out;
}

// ---- Fireworks -------------------------------------------------------------------------

/** Bursts of fireworks over the stands for a home run: where (normalised) and when (ms from the start of the play). */
export function fireworksFor(plan, from = plan.callAt) {
  const colours = ['#f2c14e', '#ff6b5a', '#7fb8ff', '#8ff07a', '#f7d9a8', '#e18cff'];
  const kinds = ['peony', 'ring', 'willow'];
  return Array.from({ length: 10 }, (_, i) => ({
    x: 0.12 + ((i * 0.37) % 0.76),
    y: 0.1 + ((i * 0.23) % 0.3),
    at: (from + 0.2 + i * 0.4) * 1000,
    colour: colours[i % colours.length],
    second: colours[(i + 2) % colours.length],
    kind: kinds[i % kinds.length],
  }));
}

export const FIREWORK = { rise: 450, life: 1600, sparks: 64 };

/** A number from 0 to 1 that is always the same for the same two numbers. */
function hashOf(i, seed) {
  const v = Math.sin(i * 127.1 + seed * 0.0131) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * One burst at `now` (ms): the rocket climbing to it with its trail, then the sparks flying out, slowing, falling
 * and fading (a willow's hang longer and droop, a ring's go out in a circle, a peony's fill a ball). Positions are
 * normalised to the screen, `aspect` wide; each spark has where it was over the last moments too (newest first), for its
 * tail.
 * @param {{x:number, y:number, at:number, colour:string, second?:string, kind?:string}} burst
 * @returns {{rocket: {x:number, y:number, alpha:number}|null, flash: number,
 *   sparks: {x:number, y:number, tail: {x:number, y:number}[], alpha:number, colour:string}[]}}
 */
export function burstAt(burst, now, aspect = 16 / 9) {
  const t = now - burst.at;
  if (t < -FIREWORK.rise || t > FIREWORK.life) return { rocket: null, flash: 0, sparks: [] };
  if (t < 0) {
    const u = 1 + t / FIREWORK.rise;
    const climb = 1 - (1 - u) * (1 - u);
    return { rocket: { x: burst.x, y: 1.05 + (burst.y - 1.05) * climb, alpha: 0.9 }, flash: 0, sparks: [] };
  }
  const kind = burst.kind ?? 'peony';
  const s = t / 1000;
  const sparks = [];
  // Out fast, slowed by the air, and falling: x = v(1 − e^(−kt))/k, plus gravity's sag.
  const drag = kind === 'willow' ? 3.2 : 2.4;
  const gravity = kind === 'willow' ? 0.16 : 0.1;
  const where = (v, a, time) => {
    const out = (v * (1 - Math.exp(-drag * time))) / drag;
    return { x: burst.x + (Math.cos(a) * out) / aspect, y: burst.y + Math.sin(a) * out + gravity * time * time };
  };
  for (let i = 0; i < FIREWORK.sparks; i++) {
    const jitter = hashOf(i, burst.at);
    const a = ((i + (kind === 'ring' ? 0 : jitter - 0.5)) / FIREWORK.sparks) * 2 * Math.PI + burst.x * 10;
    // A ring's sparks all go as fast; a peony's at many speeds, so they fill a ball (seen flat, a disc).
    const v = kind === 'ring' ? 0.55 : 0.2 + 0.4 * Math.sqrt(hashOf(i + 101, burst.at));
    const p = where(v, a, s);
    const back = kind === 'willow' ? 0.8 : 0.14;
    const tail = [1, 2, 3, 4].map((k) => where(v, a, Math.max(0, s - (back * k) / 4)));
    const fade = 1 - t / FIREWORK.life;
    sparks.push({ x: p.x, y: p.y, tail, alpha: fade * fade, colour: i % 3 === 0 && burst.second ? burst.second : burst.colour });
  }
  return { rocket: null, flash: Math.max(0, 1 - t / 160), sparks };
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
    figures.push({ at, facing: { x: -at.x, y: -at.y }, player: runnerPlayer(BASE_ORDER.indexOf(base), info, POSES.crouch) });
  }
  return figures;
}
