// Golden Boot's 3D scene, kept free of the browser so it can be unit-tested: the
// stadium (pitch and markings, goal and net, advertising boards, stands full of
// people, floodlights), the keeper, the ball, and what each is doing during a
// kick. It keeps what is happening and says what to draw; Dunk the Clown's
// WebGL renderer (dunk-the-clown-gl.js) draws it.
//
// The picture must stay perfectly still unless the game has told the camera it
// is about to change, so `step` says whether anything has changed since the last
// picture, and the game draws only then. While players aim, nothing moves: the
// keeper waits in his stance, the ball sits on the spot, the crowd is still.
// A kick is one burst of motion (`planShot` works it all out in advance), and
// `shotArea` gives the part of the screen that burst can change, for the game to
// report to the camera first.
//
// Everything is in metres (see golden-boot-models.js): the goal line is z = 0,
// the penalty spot z = 11, and the camera is behind the spot.

import { boardParts } from './dunk-the-clown-scene.js';
import { chain, limb, multiply, rotationX, rotationZ, scaling, transform, translation } from './dunk-the-clown-models.js';
import { GOLDEN_BOOT_RULES } from './golden-boot-logic.js';
import {
  bakeParts, billboard, bouncingHeight, flightPoint, makeCamera, netPush, project, seededRandom, smooth,
} from './golden-boot-models.js';
import {
  READY, bodyCentre, chestAt, diveMotion, divePose, gloveAt, keeperParts,
} from './golden-boot-keeper.js';

/** @typedef {{mesh: string, m: Float32Array, colour: number[], alpha?: number, shine?: number, glow?: number, tex?: string, layer?: number}} Drawable */
/** @typedef {{x0:number, y0:number, x1:number, y1:number}} Rect */

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

// Mid to dark, so a light ball stands out against all of it, and so the picture stays
// easy for the camera: nothing here is white.
const COLOURS = {
  sky: hex('#0a1028'),
  grassA: hex('#2a5a31'), grassB: hex('#306738'), apron: hex('#262a35'),
  line: hex('#939aa2'),
  post: hex('#aeb2b8'), frame: hex('#868b92'), net: hex('#7b818a'),
  step: hex('#2c303d'), stepAlt: hex('#323746'), aisle: hex('#454a5a'), wall: hex('#1c1f2a'), roof: hex('#14161f'),
  roofEdge: hex('#2b2f3c'), lamp: hex('#d9c88a'), halo: hex('#9aa6c8'),
  ball: hex('#cfcfc6'), ballDark: hex('#1d1e24'), shadow: hex('#050805'),
  board: [hex('#7a2f2f'), hex('#2f5a7a'), hex('#6b5a2a'), hex('#3d6b45'), hex('#5a3d6b'), hex('#7a5a2f'), hex('#2f6b6b'), hex('#7a2f4f')],
  boardStripe: hex('#c9a95a'), boardBase: hex('#1a1c24'),
  shirts: [
    '#8e3b3b', '#3d5a80', '#7a6a3a', '#4f6b45', '#6a4a7a', '#8a5a3a', '#38424f', '#7d6f62', '#a0663a', '#4a6f86',
    '#24427a', '#7b3b3b', '#5b7a8a', '#6b6040', '#3a4a30', '#9a4a30',
  ].map(hex),
  home: [hex('#9a3030'), hex('#7c2626')],
  skin: ['#c9946b', '#8d5a3b', '#e0b48f', '#6e4630'].map(hex),
  hair: ['#2b1d14', '#4a3320', '#171310', '#6b4a2a', '#8a7a5a'].map(hex),
};

const R = GOLDEN_BOOT_RULES;
const GOAL_X = R.goal.halfWidth + R.goal.post / 2; // the middle of a post
const BAR_Y = R.goal.height + R.goal.post / 2; // the middle of the bar
const POST_R = R.goal.post / 2;
// The net hangs from the back of the frame: a metre behind the bar at the top, two behind the line at the bottom.
const NET_TOP_Z = -1.0;
const NET_BOTTOM_Z = -2.0;
const BOARDS_Z = -6.2;

/** How far back the net is at a height (the back of the net slopes). */
export function netZ(y) {
  return NET_BOTTOM_Z + (Math.min(BAR_Y, Math.max(0, y)) / BAR_Y) * (NET_TOP_Z - NET_BOTTOM_Z);
}

/** How long things last (ms). */
export const SCENE_MS = {
  burst: 350, // the Start target being hit
};

const SKY = COLOURS.sky;
const NET_COLS = 24;
const NET_ROWS = 8;

// ---- Building the stadium ----

function rotationY(angle) {
  const m = new Float32Array(16);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  m[0] = c; m[2] = -s; m[5] = 1; m[8] = s; m[10] = c; m[15] = 1;
  return m;
}

/** The parts of the stadium that are drawn in one go, and the few that are drawn one by one. */
function buildStadium() {
  const baked = [];
  const loose = [];
  const random = seededRandom(20240611);
  const pick = (list) => list[Math.floor(random() * list.length) % list.length];
  const add = (list, mesh, m, colour, extra = {}) => list.push({ mesh, m, colour, shine: 0.05, ...extra });
  const box = (list, c, size, colour, extra) => add(list, 'box', multiply(translation(...c), scaling(...size)), colour, extra);
  const rod = (list, a, b, r, colour, extra) => add(list, 'cylinder', limb(a, b, r), colour, extra);

  // The pitch, in mown stripes across it, and a darker apron of grass behind the goal.
  for (let i = 0, z = -6.3; z < 26; i++, z += 3.66) {
    box(baked, [0, -0.03, z + 1.83], [160, 0.06, 3.66], i % 2 ? COLOURS.grassA : COLOURS.grassB);
  }
  box(baked, [0, -0.04, -8.5], [200, 0.06, 5], COLOURS.apron);

  // Markings: the goal line, the six-yard box, the penalty area and the spot.
  const mark = (a, b) => box(baked, [(a[0] + b[0]) / 2, 0.012, (a[1] + b[1]) / 2], [Math.abs(b[0] - a[0]) + 0.12, 0.02, Math.abs(b[1] - a[1]) + 0.12], COLOURS.line, { shine: 0 });
  mark([-50, 0], [50, 0]);
  mark([-9.16, 0], [-9.16, 5.5]); mark([9.16, 0], [9.16, 5.5]); mark([-9.16, 5.5], [9.16, 5.5]);
  mark([-20.16, 0], [-20.16, 16.5]); mark([20.16, 0], [20.16, 16.5]); mark([-20.16, 16.5], [20.16, 16.5]);
  add(loose, 'cylinder', multiply(translation(0, 0.012, R.spotDistance), scaling(0.11, 0.02, 0.11)), COLOURS.line, { shine: 0 });
  // The arc of the penalty area, outside the box.
  const arcFrom = -Math.acos((16.5 - R.spotDistance) / 9.15);
  for (let k = 0; k < 24; k++) {
    const a = arcFrom + ((-2 * arcFrom) * (k + 0.5)) / 24;
    const z = R.spotDistance + 9.15 * Math.cos(a);
    if (z < 16.5) continue;
    add(baked, 'box', chain(translation(9.15 * Math.sin(a), 0.012, z), rotationY(-a), scaling(0.12, 0.02, 1.25)), COLOURS.line, { shine: 0 });
  }

  // The goal: posts and bar 12 cm thick, with the frame and the net behind them.
  for (const side of [-1, 1]) {
    add(loose, 'cylinder', multiply(translation(side * GOAL_X, (BAR_Y + POST_R) / 2, 0), scaling(POST_R, BAR_Y + POST_R, POST_R)), COLOURS.post, { shine: 0.35 });
    add(loose, 'sphere', multiply(translation(side * GOAL_X, BAR_Y + POST_R, 0), scaling(POST_R)), COLOURS.post, { shine: 0.35 });
    rod(baked, [side * GOAL_X, BAR_Y, 0], [side * GOAL_X, BAR_Y, NET_TOP_Z], 0.025, COLOURS.frame);
    rod(baked, [side * GOAL_X, BAR_Y, NET_TOP_Z], [side * GOAL_X, 0.03, NET_BOTTOM_Z], 0.025, COLOURS.frame);
    rod(baked, [side * GOAL_X, 0.03, 0], [side * GOAL_X, 0.03, NET_BOTTOM_Z], 0.02, COLOURS.frame);
  }
  add(loose, 'cylinder', multiply(translation(0, BAR_Y, 0), chain(rotationZ(Math.PI / 2), scaling(POST_R, 2 * GOAL_X, POST_R))), COLOURS.post, { shine: 0.35 });
  rod(baked, [-GOAL_X, BAR_Y, NET_TOP_Z], [GOAL_X, BAR_Y, NET_TOP_Z], 0.025, COLOURS.frame);
  rod(baked, [-GOAL_X, 0.03, NET_BOTTOM_Z], [GOAL_X, 0.03, NET_BOTTOM_Z], 0.02, COLOURS.frame);
  // Top and side nets (the back net is drawn each time, as it moves).
  const dx = (2 * GOAL_X) / NET_COLS;
  for (let i = 0; i <= NET_COLS; i++) rod(baked, [-GOAL_X + i * dx, BAR_Y, 0], [-GOAL_X + i * dx, BAR_Y, NET_TOP_Z], 0.011, COLOURS.net, { shine: 0 });
  for (let k = 1; k < 4; k++) rod(baked, [-GOAL_X, BAR_Y, (NET_TOP_Z * k) / 4], [GOAL_X, BAR_Y, (NET_TOP_Z * k) / 4], 0.011, COLOURS.net, { shine: 0 });
  for (const side of [-1, 1]) {
    for (let j = 0; j <= NET_ROWS; j++) {
      const y = (BAR_Y * j) / NET_ROWS;
      if (j) rod(baked, [side * GOAL_X, y, 0], [side * GOAL_X, y, netZ(y)], 0.011, COLOURS.net, { shine: 0 });
    }
    for (let k = 1; k <= 5; k++) {
      const z0 = (NET_BOTTOM_Z * k) / 5;
      // A vertical line at depth z0: as high as the net's slope allows there.
      const top = z0 > NET_TOP_Z ? BAR_Y : (BAR_Y * (z0 - NET_BOTTOM_Z)) / (NET_TOP_Z - NET_BOTTOM_Z);
      rod(baked, [side * GOAL_X, 0.03, z0], [side * GOAL_X, Math.max(0.03, top), z0], 0.011, COLOURS.net, { shine: 0 });
    }
  }

  // Advertising boards along the back of the run-off, each a muted colour with a gold stripe.
  for (let i = 0, x = -49.5; x < 50; i++, x += 3.6) {
    const colour = COLOURS.board[i % COLOURS.board.length];
    box(baked, [x + 1.8, 0.5, BOARDS_Z], [3.55, 1.0, 0.14], colour, { shine: 0.1 });
    box(baked, [x + 1.8, 0.72, BOARDS_Z + 0.08], [2.4, 0.07, 0.02], COLOURS.boardStripe, { shine: 0 });
    box(baked, [x + 1.8, 0.45, BOARDS_Z + 0.08], [1.4, 0.26, 0.02], COLOURS.boardBase, { shine: 0 });
  }

  // The stands: two tiers of steps, a person in most seats, a concourse wall between.
  const seat = (x, y, z) => {
    if (random() < 0.1) return;
    const shirt = (Math.abs(x) < 16 && random() < 0.5) ? pick(COLOURS.home) : pick(COLOURS.shirts);
    const h = 0.9 + random() * 0.18;
    box(baked, [x, y + 0.27 * h, z], [0.44, 0.52 * h, 0.28], shirt, { shine: 0.05 });
    add(baked, 'sphere', multiply(translation(x, y + 0.7 * h, z + 0.02), scaling(0.1, 0.11, 0.1)), pick(COLOURS.skin), { shine: 0.15 });
    box(baked, [x, y + 0.8 * h, z - 0.015], [0.19, 0.07, 0.19], pick(COLOURS.hair), { shine: 0.1 });
  };
  const tier = (rows, z0, dz, y0, dy) => {
    for (let r = 0; r < rows; r++) {
      const z = z0 - dz * r;
      const y = y0 + dy * r;
      // How wide a row has to be: what the camera sees of it, a little more.
      const half = Math.min(78, 1.4 * (15.2 - z) + 6);
      box(baked, [0, y - 0.2, z], [half * 2, 0.4, dz], r % 2 ? COLOURS.step : COLOURS.stepAlt, { shine: 0 });
      for (let x = -half + 0.5; x <= half - 0.5; x += 0.72) {
        // An aisle every 15 m.
        if ((x + 600) % 15 < 0.9) continue;
        seat(x + (random() - 0.5) * 0.12, y, z + (random() - 0.5) * 0.1);
      }
    }
  };
  tier(13, -8.0, 0.85, 0.7, 0.45);
  box(baked, [0, 4.4, -19.0], [160, 9.4, 0.6], COLOURS.wall, { shine: 0 }); // the concourse wall under the upper tier
  box(baked, [0, 6.6, -19.35], [160, 0.5, 0.2], COLOURS.aisle, { shine: 0.1 });
  tier(10, -20.6, 0.9, 7.6, 0.55);
  box(baked, [0, 9, -29.8], [200, 24, 0.6], COLOURS.wall, { shine: 0 }); // the back wall
  // The roof: a slab over the upper tier, with a darker edge and rows of lamps along the front.
  box(baked, [0, 14.0, -26], [200, 0.7, 14], COLOURS.roof, { shine: 0 });
  box(baked, [0, 13.55, -19.2], [200, 0.45, 0.4], COLOURS.roofEdge, { shine: 0.1 });

  // Floodlights along the roof edge, each a bank of lamps with a soft halo.
  for (let x = -60; x <= 60; x += 4) {
    add(loose, 'sphere', multiply(translation(x, 13.3, -19.0), scaling(0.35, 0.18, 0.2)), COLOURS.lamp, { glow: 0.9 });
  }
  for (const bank of [-42, -14, 14, 42]) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 2; j++) {
        add(loose, 'sphere', multiply(translation(bank + (i - 1.5) * 0.9, 12.5 + j * 0.7, -18.6), scaling(0.32)), COLOURS.lamp, { glow: 1 });
      }
    }
    add(loose, 'sphere', multiply(translation(bank, 13.0, -18.2), scaling(4.2, 1.9, 0.5)), COLOURS.halo, { glow: 1, alpha: 0.16, layer: -3 });
  }
  return { baked, loose };
}

let stadium = null;
function stadiumParts() {
  stadium ??= buildStadium();
  return stadium;
}

let bakedStadium = null;
/** The stadium joined into one mesh (done once, the first time it is drawn). */
export function stadiumMesh() {
  bakedStadium ??= bakeParts(stadiumParts().baked);
  return bakedStadium;
}

// ---- The ball ----

// The twelve dark patches of a football sit where an icosahedron's corners are.
const PATCHES = (() => {
  const phi = (1 + Math.sqrt(5)) / 2;
  const out = [];
  for (const a of [-1, 1]) {
    for (const b of [-phi, phi]) {
      out.push([0, a, b], [a, b, 0], [b, 0, a]);
    }
  }
  return out.map((v) => v.map((c) => c / Math.hypot(...v)));
})();

/** The ball's parts, at a place, turned by `spin` (about x, then z). */
export function ballParts(pos, spin = [0, 0]) {
  const r = R.ballRadius;
  const turn = chain(translation(...pos), rotationZ(spin[1]), rotationX(spin[0]));
  const parts = [{ mesh: 'sphere', m: multiply(turn, scaling(r)), colour: COLOURS.ball, shine: 0.35 }];
  for (const p of PATCHES) {
    parts.push({
      mesh: 'sphere',
      m: multiply(turn, multiply(translation(p[0] * r * 0.8, p[1] * r * 0.8, p[2] * r * 0.8), scaling(r * 0.28))),
      colour: COLOURS.ballDark,
      shine: 0.2,
    });
  }
  return parts;
}

/** How a ball has turned by the time it is at `pos`, if it started at the penalty spot. */
function spinAt(pos) {
  return [(R.spotDistance - pos[2]) / R.ballRadius, pos[0] / R.ballRadius];
}

// ---- A kick ----

/**
 * Everything that happens in a kick, worked out in advance from the result.
 * @param {import('./golden-boot-logic.js').ShotResult} result
 * @param {object} [rules]
 * @param {number} [flightMs] how long the ball takes to reach the goal (a quick kick gets there sooner, and the rest
 *   follows); a ball that bounces takes the longer `result.flightMs`
 * @returns {{
 *   durationMs: number, impactMs: number, dive: ReturnType<typeof divePose>|null, style: string|null,
 *   at: (t: number) => {ball: {pos: number[], spin: number[], hidden: boolean}, keeper: {pose: object, shift: number}, net: {hit: {x:number, y:number}, age: number}|null}
 * }}
 */
export function planShot(result, rules = R, flightMs = rules.flightMs) {
  if (result.bounce) flightMs = result.flightMs;
  const T = flightMs / 1000;
  const r = rules.ballRadius;
  const start = [0, r, rules.spotDistance];
  // A ball that bounces comes down on the grass first, then rises off it to the goal; its first leg is quicker
  // than the second, as the bounce takes its pace.
  const land = result.bounce ? [result.bounce.x, r, result.bounce.z] : null;
  const tLand = land ? T * (start[2] - land[2]) / (start[2] - land[2] + land[2] * rules.bounce.slower) : 0;
  // Where the ball is `t` seconds into its flight to `to` (reached at T), with `arc` metres of lift.
  const approach = (t, to, arc = 0) => {
    if (!land) return flightPoint(start, to, t / T, arc);
    if (t < tLand) return flightPoint(start, land, t / tLand, 0.7);
    return flightPoint(land, to, (t - tLand) / (T - tLand), 0.15 + arc);
  };
  const style = result.kind === 'saved' ? result.save : result.dive ? 'beaten' : null;
  const dive = result.dive ? divePose(result.dive, style) : null;
  const side = result.shot.x < 0 ? -1 : 1;
  const keeperAtTime = diveMotion(dive, { reaction: rules.keeper.reactionMs / 1000, contact: T, wall: rules.goal.halfWidth });
  const out = (pos, hidden = false) => ({ pos, spin: spinAt(pos), hidden });
  // Drift with drag from a point: where it has got `t` seconds after, going `v` at first.
  const drift = (p0, v, t, k = 1.1) => {
    const f = (1 - Math.exp(-k * t)) / k;
    return [p0[0] + v[0] * f, p0[1], p0[2] + v[2] * f];
  };
  let ball;
  let durationMs;
  let netInfo = null;
  const hitPoint = [result.shot.x, result.shot.y, 0];

  if (result.kind === 'goal') {
    // The ball goes through the plane of the goal (or off the post and in), then into the back of the net.
    const through = result.wood ? [result.shot.x, result.shot.y, 0] : [result.point.x, result.point.y, 0];
    const into = [result.point.x * 0.96, Math.max(r, result.point.y), 0];
    into[2] = netZ(into[1]) + r;
    const tNet = T + 0.1;
    netInfo = { hit: { x: into[0], y: into[1] }, born: tNet, amount: 0.6 };
    ball = (t) => {
      if (t < T) return out(approach(t, through));
      if (t < tNet) return out(flightPoint(through, into, (t - T) / (tNet - T)));
      // In the net: it drops, held by it, while the net rings.
      const age = t - tNet;
      const y = bouncingHeight(into[1], 0, age * 0.9, r, { gravity: 6, keep: 0.25 });
      const x = into[0] * (1 + 0.04 * age);
      const push = netPush({ x, y }, netInfo.hit, age, netInfo.amount) * (y > 1.0 ? 1 : 0.5);
      return out([x, y, netZ(y) + r - push * 0.8]);
    };
    durationMs = 2300;
  } else if (result.kind === 'saved') {
    const lead = dive.lead;
    const glove = gloveAt(dive.pose, lead, dive.shift);
    if (result.save === 'catch') {
      ball = (t) => {
        if (t < T) return out(approach(t, glove, 0.1));
        // He pulls it in to his chest.
        const k = keeperAtTime(t);
        const hand = gloveAt(k.pose, lead, k.shift);
        const chest = chestAt(k.pose, k.shift);
        return out([0, 1, 2].map((i) => hand[i] + (chest[i] - hand[i]) * smooth((t - T - 0.2) / 0.4)));
      };
      durationMs = 2000;
    } else {
      // Parried wide and back into play, or tipped up and over the bar.
      const tip = result.save === 'tip';
      const away = Math.abs(glove[0]) > 0.3 ? Math.sign(glove[0]) : side;
      const v = tip ? [away * 0.8, 4.2, -4.2] : [away * 3.4, glove[1] < 1 ? 1.8 : 0.5, 3.2];
      ball = (t) => {
        if (t < T) return out(approach(t, glove, 0.1));
        const age = t - T;
        const p = drift(glove, v, age, tip ? 0.8 : 1.2);
        p[1] = bouncingHeight(glove[1], v[1], age, r);
        return out(p);
      };
      durationMs = 2000;
    }
  } else if (result.wood) {
    // Off the post or the bar and back into play.
    const wood = [result.shot.x, result.shot.y, 0];
    const v = result.miss === 'post' ? [side * 2.6, 1.4, 6] : [side * 0.8, 3.0, 5];
    ball = (t) => {
      if (t < T) return out(approach(t, wood));
      const age = t - T;
      const p = drift(wood, v, age, 1.0);
      p[1] = bouncingHeight(wood[1], v[1], age, r);
      return out(p);
    };
    durationMs = 2100;
  } else if (result.miss === 'short') {
    const land = [result.shot.x * 0.5, r, 3.2];
    ball = (t) => {
      if (t < T) return out(flightPoint(start, land, t / T, 0.55));
      const age = t - T;
      const p = drift(land, [0, 0, -2.4], age, 1.2);
      p[1] = bouncingHeight(r, 2.2, age, r);
      return out(p);
    };
    durationMs = 1900;
  } else {
    // Wide or over: it carries on past the plane of the goal. Low, it hits the boards and drops; high, it is in the crowd.
    // (One that bounced carries on in a straight line from where it bounced.)
    const from = land ?? start;
    const t0 = land ? tLand : 0;
    const dir = [hitPoint[0] - from[0], hitPoint[1] - from[1], hitPoint[2] - from[2]];
    const at = (u) => [from[0] + dir[0] * u, from[1] + dir[1] * u, from[2] + dir[2] * u];
    const uBoards = (from[2] - (BOARDS_Z + 0.25)) / (from[2] - 0);
    const hitsBoards = at(uBoards)[1] < 1.0;
    ball = (t) => {
      if (t < t0) return out(approach(t, hitPoint));
      const u = (t - t0) / (T - t0);
      if (!hitsBoards) return out(at(u), at(u)[2] < -14);
      if (u < uBoards) return out(at(u));
      const stop = at(uBoards);
      const age = t - t0 - uBoards * (T - t0);
      const p = [stop[0], stop[1], stop[2] + 0.5 * (1 - Math.exp(-4 * age))];
      p[1] = bouncingHeight(stop[1], 0.5, age, r);
      return out(p);
    };
    durationMs = 1900;
  }

  // Whatever the ball's speed, the kick goes on as long after it reaches the goal as it does for a kick at the average speed.
  return {
    durationMs: durationMs + (flightMs - rules.flightMs),
    impactMs: flightMs,
    dive,
    style,
    at: (t) => ({
      ball: ball(t),
      keeper: keeperAtTime(t),
      net: netInfo && t >= netInfo.born ? { hit: netInfo.hit, age: t - netInfo.born, amount: netInfo.amount } : null,
    }),
  };
}

// ---- The scene ----

// Half the size of each shape along its own axes, for bounding what is drawn.
const HALF = {
  sphere: [1, 1, 1], cylinder: [1, 0.5, 1], cone: [1, 0.5, 1], box: [0.5, 0.5, 0.5], torus: [1.2, 0.2, 1.2], quad: [0.5, 0.5, 0.01],
};

/** Where the Start target stands in front of the camera: this many metres along its line of sight. */
const START_DEPTH = 3;
const KEEPER_Z = 0;

export class BootScene {
  /** @param {{width: number, height: number}} view screen size in pixels */
  constructor(view) {
    this.board = boardParts();
    this.restKeeper = keeperParts(READY);
    this.reset();
    this.resize(view);
  }

  /** The screen has changed size: the camera is set again. (The stadium doesn't depend on it.) */
  resize(view) {
    this.view = view;
    this.camera = makeCamera(view);
    this.dirty = true;
  }

  /** Back to waiting: the keeper in his stance, the ball on the spot, the net still. */
  reset() {
    this.shot = null; // {plan, born, done}
    this.start = null; // {x, y, r, label, born, hit: number|null}
    this.dirty = true;
  }

  /** Starts a kick (see `planShot`) at `now`. */
  kick(plan, now) {
    this.shot = { plan, born: now, done: false };
    this.dirty = true;
  }

  showStart(target, label, now) {
    this.start = { ...target, label, born: now, hit: null };
    this.dirty = true;
  }

  hitStart(now) {
    if (this.start) this.start.hit = now;
  }

  /** How long ago in seconds, within a shot. */
  timeIn(now) {
    return Math.max(0, now - this.shot.born) / 1000;
  }

  /**
   * Moves everything on to `now`.
   * @returns {boolean} true if the picture needs drawing again
   */
  step(now) {
    let active = this.dirty;
    this.dirty = false;
    if (this.shot) {
      if (now - this.shot.born < this.shot.plan.durationMs) {
        active = true;
      } else if (!this.shot.done) {
        // One last picture, of where everything ended up.
        this.shot.done = true;
        active = true;
      }
    }
    if (this.start && this.start.hit !== null) {
      if (now - this.start.hit >= SCENE_MS.burst) this.start = null;
      active = true;
    }
    return active;
  }

  // ---- What to draw ----

  /**
   * Everything to draw, split by how it must be drawn.
   * @returns {{opaque: Drawable[], translucent: Drawable[], overlay: Drawable[], label: string, camera: object, baked: object, clear: number[]}}
   */
  frame(now) {
    const { loose } = stadiumParts();
    const opaque = loose.filter((d) => (d.alpha ?? 1) >= 1);
    const translucent = loose.filter((d) => (d.alpha ?? 1) < 1);
    this.addMoving(this.shot ? Math.min(this.timeIn(now), this.shot.plan.durationMs / 1000) : null, opaque, translucent);
    if (this.start) this.addStart(this.start, now, opaque, translucent);
    return {
      opaque, translucent, overlay: [], label: this.start?.label ?? '', camera: this.camera,
      baked: { key: 'stadium', build: stadiumMesh }, clear: SKY,
    };
  }

  /** The keeper, the ball, the back of the net: whatever moves in a kick. `t` is seconds into the kick, null if none. */
  addMoving(t, opaque, translucent) {
    const state = t === null ? null : this.shot.plan.at(t);
    const keeper = state ? state.keeper : { pose: READY, shift: 0 };
    const parts = state ? keeperParts(keeper.pose) : this.restKeeper;
    const place = translation(keeper.shift, 0, KEEPER_Z);
    for (const part of parts) opaque.push({ mesh: part.mesh, m: multiply(place, part.m), colour: part.colour, shine: part.shine });
    translucent.push(keeperShadow(keeper));

    const ball = state ? state.ball : { pos: [0, R.ballRadius, R.spotDistance], spin: [0, 0], hidden: false };
    if (!ball.hidden) {
      opaque.push(...ballParts(ball.pos, ball.spin));
      translucent.push(shadow([ball.pos[0], ball.pos[2]], 0.13, 0.13, Math.max(0.1, 0.45 - ball.pos[1] * 0.12), Math.max(0, ball.pos[1] - R.ballRadius)));
    }
    this.addNet(state?.net ?? null, opaque);
  }

  /** The back of the net: a grid of cords that swells where a ball has hit it. */
  addNet(hit, opaque) {
    const node = (i, j) => {
      const x = -GOAL_X + (2 * GOAL_X * i) / NET_COLS;
      const y = (BAR_Y * j) / NET_ROWS;
      const push = hit ? netPush({ x, y }, hit.hit, hit.age, hit.amount) : 0;
      return [x, y, netZ(y) - push];
    };
    const grid = [];
    for (let j = 0; j <= NET_ROWS; j++) for (let i = 0; i <= NET_COLS; i++) grid.push(node(i, j));
    const at = (i, j) => grid[j * (NET_COLS + 1) + i];
    for (let j = 0; j <= NET_ROWS; j++) {
      for (let i = 0; i < NET_COLS; i++) opaque.push({ mesh: 'cylinder', m: limb(at(i, j), at(i + 1, j), 0.011), colour: COLOURS.net, shine: 0 });
    }
    for (let i = 0; i <= NET_COLS; i++) {
      for (let j = 0; j < NET_ROWS; j++) opaque.push({ mesh: 'cylinder', m: limb(at(i, j), at(i, j + 1), 0.011), colour: COLOURS.net, shine: 0 });
    }
  }

  addStart(start, now, opaque, translucent) {
    const spot = billboard(this.camera, start, START_DEPTH);
    const burst = start.hit === null ? 0 : Math.min(1, (now - start.hit) / SCENE_MS.burst);
    const radius = start.r * spot.unit * (1 + 0.5 * burst);
    const root = multiply(spot.m, scaling(radius));
    for (const part of this.board) {
      const d = { mesh: part.mesh, m: multiply(root, part.m), colour: part.colour, shine: part.shine };
      if (burst > 0) translucent.push({ ...d, alpha: 1 - burst, layer: 5 });
      else opaque.push(d);
    }
    translucent.push({
      mesh: 'quad',
      m: multiply(root, multiply(translation(0, 0, 0.16), scaling(1.7, 0.85, 1))),
      colour: [1, 1, 1], alpha: 1 - burst, tex: 'label', layer: 6,
    });
  }

  // ---- Where the camera must not look ----

  /** The part of the screen a drawable covers (a conservative box), as a rect. */
  boundsOf(d) {
    const half = HALF[d.mesh] ?? [1, 1, 1];
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const w = transform(d.m, [sx * half[0], sy * half[1], sz * half[2]]);
          const p = project(this.camera, [w[0], w[1], w[2]]);
          x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
        }
      }
    }
    return { x0, y0, x1, y1 };
  }

  /**
   * Everything a kick can change on the screen, from the kick to the reset: the ball's path, the
   * keeper's dive, the back of the net. The game reports it to the camera before the kick starts, and again
   * when the picture goes back to waiting.
   * @param {ReturnType<typeof planShot>} plan
   * @returns {Rect}
   */
  shotArea(plan) {
    const area = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const take = (b) => {
      area.x0 = Math.min(area.x0, b.x0); area.y0 = Math.min(area.y0, b.y0);
      area.x1 = Math.max(area.x1, b.x1); area.y1 = Math.max(area.y1, b.y1);
    };
    for (let ms = 0; ms <= plan.durationMs + 1; ms += 50) {
      const opaque = [];
      const translucent = [];
      const state = plan.at(Math.min(ms, plan.durationMs) / 1000);
      const keeper = state.keeper;
      const place = translation(keeper.shift, 0, KEEPER_Z);
      const parts = keeperParts(keeper.pose);
      for (const part of parts) opaque.push({ mesh: part.mesh, m: multiply(place, part.m) });
      translucent.push(keeperShadow(keeper));
      if (!state.ball.hidden) {
        opaque.push(...ballParts(state.ball.pos, state.ball.spin).slice(0, 1));
        translucent.push(shadow([state.ball.pos[0], state.ball.pos[2]], 0.13, 0.13, 0.4));
      } else {
        // Gone into the crowd: the ball is a speck there; it covers where it was last seen.
        opaque.push(...ballParts(plan.at(Math.max(0, ms / 1000 - 0.2)).ball.pos).slice(0, 1));
      }
      for (const d of [...opaque, ...translucent]) take(this.boundsOf(d));
    }
    // The whole back of the net, and the ball on the spot, whatever happens.
    const netCorners = [[-GOAL_X, 0, netZ(0)], [GOAL_X, 0, netZ(0)], [-GOAL_X, BAR_Y, netZ(BAR_Y)], [GOAL_X, BAR_Y, netZ(BAR_Y)], [0, BAR_Y, 0], [0, 0, 0]];
    for (const c of netCorners) {
      const p = project(this.camera, c);
      take({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    }
    take(this.boundsOf(ballParts([0, R.ballRadius, R.spotDistance])[0]));
    return this.pad(area, 0.02);
  }

  /** The Start target's area (it grows as it bursts). */
  startArea(target) {
    const spot = billboard(this.camera, target, START_DEPTH);
    const radius = target.r * spot.unit * 1.6;
    const parts = [{ mesh: 'cylinder', m: multiply(multiply(spot.m, scaling(radius)), rotationX(Math.PI / 2)), colour: [0, 0, 0] }];
    const b = this.boundsOf(parts[0]);
    return this.pad(b, 0.02);
  }

  /** A rect grown by `margin` of the shorter screen side, kept on the screen. */
  pad(rect, margin) {
    const unit = Math.min(this.view.width, this.view.height);
    const px = (margin * unit) / this.view.width;
    const py = (margin * unit) / this.view.height;
    return {
      x0: Math.max(0, rect.x0 - px), y0: Math.max(0, rect.y0 - py), x1: Math.min(1, rect.x1 + px), y1: Math.min(1, rect.y1 + py),
    };
  }
}

/** The keeper's shadow: under his hips, longer as he lies over, fainter the higher he is. */
function keeperShadow(keeper) {
  const [x, y] = bodyCentre(keeper);
  const rise = Math.max(0, y - 0.9);
  return shadow([x, KEEPER_Z], 0.5 + Math.abs(Math.sin(keeper.pose.turn)) * 0.55, 0.3, Math.max(0.12, 0.38 - rise * 0.2), rise);
}

/** A soft dark patch on the grass: where something at (x, z) is, `lift` metres above it. */
function shadow([x, z], rx, rz, alpha, lift = 0) {
  const grow = 1 + lift * 0.4;
  return {
    mesh: 'sphere',
    m: multiply(translation(x, 0.012, z), scaling(rx * grow, 0.004, rz * grow)),
    colour: COLOURS.shadow, alpha, shine: 0, layer: -2,
  };
}
