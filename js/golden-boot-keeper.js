// Golden Boot's goalkeeper: his poses, and the solid shapes he is built from.
//
// His skeleton is the one Fielder's Choice's players have (fielders-choice-players.js):
// joints in feet, seen from the front, with two-bone arms and legs, blended between
// poses; fielders-choice-models.js stands a flat pose up in three dimensions
// (`liftPose`). Here the poses are a keeper's: waiting in his stance, and diving or
// reaching for a shot, with both big gloves at the ball. A pose is worked out for
// the place he must get his hands to, so a save really does end with a glove on the ball.
// `diveMotion` is how he gets there and what happens after: a sink as the ball is
// struck, a step and a push off the near foot, a flight that carries on after the ball
// (his hips go as a thrown body does, with gravity), and a fall onto his side, a slide
// on the grass and lying there; or, for a leap or a reach, landing on his feet.
//
// The shapes are the ones Dunk the Clown draws (dunk-the-clown-models.js): spheres and
// tubes, here in a keeper's kit (a bright jersey, dark shorts and socks, boots, big gloves)
// with a head, face and hair, built round the joints of the pose. The keeper faces the
// kicker (+z) and his drawing is in metres, standing on the grass between his feet.
//
// Nothing runs in the browser when this loads, so the poses can be unit tested.

import { BODY, blendPoses, placed, twoBone } from './fielders-choice-players.js';
import { liftPose } from './fielders-choice-models.js';
import { limb } from './dunk-the-clown-models.js';
import { smooth } from './golden-boot-models.js';

/** @typedef {import('./fielders-choice-players.js').Pose} Pose */
/** @typedef {{mesh: string, m: Float32Array, colour: number[], shine?: number}} Part */

/** Metres to a foot of pose. The cartoon skeleton is 5¾ ft tall; the keeper is a tall man. */
export const KEEPER_SCALE = 0.3048 * 1.1;

const J = (x, y) => ({ x, y });

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
// Mid to dark, with a bright jersey and gloves; nothing white.
export const KIT = {
  jersey: hex('#d1701f'), jerseyShade: hex('#a9561a'), sleeve: hex('#d1701f'), band: hex('#2a3340'),
  shorts: hex('#232a3a'), socks: hex('#232a3a'), sockStripe: hex('#d1701f'), boots: hex('#17181e'),
  glove: hex('#5aa860'), gloveDark: hex('#2f6e3a'), cuff: hex('#2a3340'),
  skin: hex('#c68e63'), skinShade: hex('#a9744d'), hair: hex('#2b1d14'), eye: hex('#17181e'), mouth: hex('#7a3b33'),
};

// ---- Poses ----

/** How far from the feet his gloves are when he stands straight with his arms over his head (feet). */
const OVERHEAD = 6.7;
/** The most his feet leave the ground (feet). */
const MAX_LIFT = 4.5;
/** The most he tilts (radians from upright): nearly flat. */
const MAX_TILT = 1.5;
/** Feet from his hip to the ground when he stands straight. */
const STAND_HIP = 2.75;

/**
 * A front pose built from a few things: where his hips are and how far his body leans to one side
 * (radians, + towards +x), where each glove goes (in the body's own terms, before it is turned and
 * lifted), and where his feet are. Arms and legs are two-bone, bent as they need to be.
 * @param {{hipX?: number, hipY?: number, lean?: number, lHand: {x:number,y:number}, rHand: {x:number,y:number}, lFoot?: {x:number,y:number}, rFoot?: {x:number,y:number}, face?: string, turn?: number, lift?: number}} p
 * @returns {Pose}
 */
function figure({ hipX = 0, hipY = STAND_HIP, lean = 0, lHand, rHand, lFoot = J(-0.4, 0), rFoot = J(0.4, 0), face = 'focus', turn = 0, lift = 0 }) {
  const up = J(Math.sin(lean), Math.cos(lean));
  const across = J(up.y, -up.x);
  const hip = J(hipX, hipY);
  const along = (k) => J(hip.x + up.x * k, hip.y + up.y * k);
  const neck = along(1.65);
  const head = along(2.3);
  const shoulder = (s) => J(neck.x + across.x * BODY.shoulderHalf * s - up.x * 0.18, neck.y + across.y * BODY.shoulderHalf * s - up.y * 0.18);
  const arm = (s, target) => twoBone(shoulder(s), target, s);
  const leg = (s, foot) => {
    const hipJoint = J(hip.x + across.x * s * 0.4, hip.y + across.y * s * 0.4);
    const bent = twoBone(hipJoint, foot, s, BODY.thigh, BODY.shin).elbow;
    // Knees point out and forward: towards us is out, so up.
    return bent.y < Math.min(hipJoint.y, foot.y) ? J((hipJoint.x + foot.x) / 2 + s * 0.4, (hipJoint.y + foot.y) / 2) : bent;
  };
  const l = arm(-1, lHand);
  const r = arm(1, rHand);
  return {
    view: 'front', face, look: J(0, 0), lift, turn,
    hip, neck, head,
    lElbow: l.elbow, lHand: l.hand, rElbow: r.elbow, rHand: r.hand,
    lKnee: leg(-1, lFoot), lFoot, rKnee: leg(1, rFoot), rFoot,
  };
}

/** Waiting for the kick: feet apart, knees bent, arms out wide and hands low and open. */
export const READY = figure({
  hipY: 2.5, lHand: J(-1.85, 2.7), rHand: J(1.85, 2.7), lFoot: J(-1.0, 0), rFoot: J(1.0, 0),
});

/**
 * How far he tilts (radians from upright) to dive for a spot `a` feet across and `height` feet up: he
 * launches towards it, so the further across and the lower it is, the flatter he lies. He never tilts
 * more than his arms' reach across needs, so a ball close in is a reach, not a dive.
 */
function tiltFor(a, height) {
  const towards = Math.atan2(a, Math.max(0.5, height - 1.5));
  const needed = Math.asin(Math.min(1, a / OVERHEAD));
  return Math.min(MAX_TILT, towards, needed);
}

/**
 * The pose and place for a keeper whose gloves must get to a spot, and how he has to travel to do it.
 * Low or wide, he lays out sideways; high, he jumps; close in, he just reaches or crouches.
 * @param {{x:number, y:number}} target metres from where he stands (across) and up from the grass
 * @param {'catch'|'parry'|'tip'|'beaten'} [style] a catch has both gloves together on the ball; otherwise the
 *   far glove trails
 * @returns {{pose: Pose, shift: number, lead: 'l'|'r', side: -1|1, style: string}} shift: metres across the goal he has moved
 */
export function divePose(target, style = 'parry') {
  const side = target.x < 0 ? -1 : 1;
  const a = Math.abs(target.x) / KEEPER_SCALE;
  const height = Math.max(0, target.y / KEEPER_SCALE);

  // Tilted towards the ball, and off the ground by as much as it takes to get his gloves up to it.
  const tilt = tiltFor(a, height);
  const lead = side < 0 ? 'l' : 'r';
  const theta = side * tilt;
  const [c, s] = [Math.cos(theta), Math.sin(theta)];
  // He travels so that, tilted, his gloves are as far across as the ball; never backwards.
  const shift = Math.max(0, a - OVERHEAD * Math.sin(tilt));
  // A low ball close in: he crouches for it.
  const stoop = height < 3.4 ? Math.min(1, (3.4 - height) / 3) * Math.max(0, 1 - tilt / 0.9) : 0;
  const flat = tilt > 0.4;
  const together = style === 'catch';
  const build = (lift) => {
    // The ball in his own terms: from his feet, turned back by the tilt he is given.
    const dx = side * (a - shift);
    const dy = height - lift;
    const local = J(dx * c - dy * s, dx * s + dy * c);
    const trail = J(local.x - side * (together ? 0.3 : 0.9) * c, local.y - (together ? 0 : 0.7));
    return figure({
      hipY: STAND_HIP - stoop,
      lHand: lead === 'l' ? local : trail,
      rHand: lead === 'r' ? local : trail,
      lFoot: J(flat ? -0.25 : -0.7, flat ? 0.1 : 0),
      rFoot: J(flat ? 0.25 : 0.7, flat ? 0.4 : 0),
      face: 'yell', turn: -theta, lift,
    });
  };
  let pose = build(Math.min(MAX_LIFT, Math.max(0, height - OVERHEAD * Math.cos(tilt))));
  // Laid out for a low one, he is on the grass, not in it: lifted clear, his arm reaching down to the ball.
  // Standing and tilted, the foot away from the ball stays on the grass.
  for (let i = 0; i < 3; i++) {
    const clear = restLift(pose, flat ? CLEAR : FEET);
    if (clear <= pose.lift + 1e-6) break;
    pose = build(clear);
  }
  return { pose, shift: side * shift * KEEPER_SCALE, lead, side, style };
}

/**
 * Where a pose has the glove on one hand, in metres from between his feet at the start (across, up, towards
 * the kicker), with `shift` metres across the goal added.
 * @param {Pose} pose
 * @param {'l'|'r'} hand
 */
export function gloveAt(pose, hand, shift = 0) {
  const j = liftPose(pose)[`${hand}Hand`];
  return [-j.r * KEEPER_SCALE + shift, j.u * KEEPER_SCALE, j.f * KEEPER_SCALE];
}

/** The middle of the chest, for a ball he has caught and holds. */
export function chestAt(pose, shift = 0) {
  const j = liftPose(pose);
  const mid = (a, b, k) => a + (b - a) * k;
  return [
    -mid(j.hip.r, j.neck.r, 0.75) * KEEPER_SCALE + shift,
    mid(j.hip.u, j.neck.u, 0.75) * KEEPER_SCALE,
    (mid(j.hip.f, j.neck.f, 0.75) + 0.45) * KEEPER_SCALE,
  ];
}

// ---- Moving ----

/** Gravity, in metres a second². */
const GRAVITY = 9.81;
/** How long his step and push off the ground take, at most (seconds). */
const PUSH_S = 0.13;
/** Before a leap he crouches for this long at most (seconds). */
const CROUCH_S = 0.18;
/** The fastest he flies across (metres a second): a leap that needn't go far across is timed to be at its top at the ball. */
const TOP_SPEED = 6;
/** Tilted further than this (radians) at the ball, he can't get his feet back under him: he lands on his side. */
const FALL_TILT = 0.6;
/** Lying on his side: nearly flat, his head a little up. */
const LIE_TURN = Math.PI / 2 - 0.1;
/** How far a glove reaches past the hand's joint (metres): it stops this far short of the post. */
const GLOVE = 0.22;
/** How quickly the grass stops a slide (seconds): he slides on as far as he would fly in this time. */
const SKID_S = 0.12;
/** How far each joint must stay above the grass (metres): roughly how thick he is there. */
const CLEAR = {
  head: 0.11, neck: 0.15, hip: 0.15, lShoulder: 0.07, rShoulder: 0.07, lHip: 0.08, rHip: 0.08,
  lElbow: 0.06, rElbow: 0.06, lHand: 0.05, rHand: 0.05, lKnee: 0.07, rKnee: 0.07, lFoot: 0, rFoot: 0,
};
const FEET = { lFoot: 0, rFoot: 0 };

/** As the ball is struck: he sinks a little lower, his weight on his toes. */
const SET = figure({
  hipY: 2.36, lHand: J(-1.75, 2.6), rHand: J(1.75, 2.6), lFoot: J(-1.0, 0), rFoot: J(1.0, 0),
});

/**
 * The moment before he leaves the ground: the near foot stepped out towards the ball, the knees bent deep
 * (deeper for a leap), his weight over the near foot and his body leaning that way, his arms down to swing up.
 */
function pushPose({ pose, side: s }) {
  const across = Math.min(1, Math.abs(pose.turn) / 1.1);
  const leap = Math.min(1, pose.lift / 3);
  const hipY = STAND_HIP - 0.5 - 0.35 * leap - 0.15 * across;
  const arms = hipY + 0.55 - 0.6 * leap;
  const lead = J(s * (1.5 + 0.4 * across), arms + 0.3 * across);
  const trail = J(-s * (1.3 - 0.8 * across), arms - 0.1);
  const near = J(s * (1.05 + 0.5 * across), 0);
  const far = J(-s * (1.0 - 0.15 * across), 0);
  return figure({
    hipX: s * 0.5 * across, hipY, lean: s * 0.3 * across,
    lHand: s < 0 ? lead : trail, rHand: s < 0 ? trail : lead,
    lFoot: s < 0 ? near : far, rFoot: s < 0 ? far : near,
    face: 'yell',
  });
}

/** Down on his side after a dive, head towards the ball: arms out past his head, or a caught ball hugged to his chest. */
function lyingPose(s, held) {
  const shoulders = STAND_HIP + 1.65;
  const [lead, trail] = held
    ? [J(s * 0.3, shoulders - 0.55), J(-s * 0.05, shoulders - 0.35)]
    : [J(s * 0.5, shoulders + 1.9), J(s * 0.05, shoulders + 1.5)];
  // The leg underneath lies nearly straight on the grass; the one on top is bent, its knee up.
  const under = J(s * 0.4, 0);
  const over = J(-s * 0.1, 0.6);
  return figure({
    lHand: s < 0 ? lead : trail, rHand: s < 0 ? trail : lead,
    lFoot: s < 0 ? under : over, rFoot: s < 0 ? over : under,
    face: 'yell', turn: -s * LIE_TURN,
  });
}

/** Back on his feet after a leap: knees bent to take it, the ball at his chest if he caught it. */
const landPose = (held) => figure({
  hipY: 2.05, lHand: held ? J(-0.3, 3.3) : J(-1.5, 2.3), rHand: held ? J(0.3, 3.3) : J(1.5, 2.3), lFoot: J(-0.95, 0), rFoot: J(0.95, 0),
});

/** Standing up again: holding a caught ball at his chest, or with his hands down. */
const standPose = (held) => figure({
  hipY: held ? 2.7 : 2.65,
  lHand: held ? J(-0.3, 3.75) : J(-1.5, 2.35), rHand: held ? J(0.3, 3.75) : J(1.5, 2.35),
  lFoot: J(-0.8, 0), rFoot: J(0.8, 0),
});

/** How far (feet) a pose must be lifted for every joint (or only those in `clear`) to be clear of the grass. */
function restLift(pose, clearOf = CLEAR) {
  const j = liftPose({ ...pose, lift: 0 });
  let need = -Infinity;
  for (const [name, clear] of Object.entries(clearOf)) need = Math.max(need, clear / KEEPER_SCALE - j[name].u);
  return need;
}

/** Where his hips are as a pose is drawn, in feet: across (with `shift`, in feet, added) and up. */
function hipOf(pose, shift = 0) {
  const p = placed(pose, pose.hip);
  return J(p.x + shift, p.y);
}

/** A pose put where its hips are at `hip` (feet): the lift and the shift (metres) that do it. */
function putHip(pose, hip) {
  const p = placed({ ...pose, lift: 0 }, pose.hip);
  return { pose: { ...pose, lift: hip.y - p.y }, shift: (hip.x - p.x) * KEEPER_SCALE };
}

/** How far across (metres) his joints go on one side (`side`), as drawn. */
function farthest(keeper, side) {
  const j = liftPose(keeper.pose);
  return Math.max(...Object.values(j).map((p) => side * (-p.r * KEEPER_SCALE + keeper.shift)));
}

/** How far (feet) his joints go past his hips on one side, however he is placed. */
function beyondHip(pose, side) {
  return farthest({ pose, shift: 0 }, side) / KEEPER_SCALE - side * hipOf(pose).x;
}

/**
 * How the keeper moves through a kick, for a dive (see `divePose`) that must be done by `contact`.
 * Until `reaction` he only sinks a little as the ball is struck. Then, for a ball close to him, he
 * reaches for it with his feet on the grass and afterwards stands up straight again. For anything
 * further he steps and pushes off, and flies: his hips go as a thrown body's do, under gravity, on a
 * path that gets his gloves to the ball at `contact` (at the top of it, for a leap). He doesn't stop
 * there: he carries on, comes down, and either lands on his side and slides, or, from a leap, lands on
 * his feet. He never slides on past `wall` (metres either side of the middle: the posts).
 * @param {ReturnType<typeof divePose>|null} dive null: he stands in his stance
 * @param {{reaction?: number, contact?: number, wall?: number}} [timing] seconds from the kick
 * @returns {(t: number) => {pose: Pose, shift: number}} where he is `t` seconds after the kick
 */
export function diveMotion(dive, { reaction = 0.15, contact = 0.6, wall = Infinity } = {}) {
  if (!dive) return () => ({ pose: READY, shift: 0 });
  const reach = dive.pose;
  const held = dive.style === 'catch';
  const tilt = Math.abs(reach.turn);
  const falls = tilt > FALL_TILT;
  const settle = (t) => blendPoses(READY, SET, smooth(t / reaction));

  if (reach.lift < 0.15 && Math.abs(dive.shift) < 0.3 && tilt < 0.45) {
    // Close in: a reach or a crouch, feet on the grass, then up straight again.
    const end = standPose(held);
    return (t) => {
      if (t <= reaction) return { pose: settle(t), shift: 0 };
      if (t <= contact) {
        const k = smooth((t - reaction) / (contact - reaction));
        return { pose: blendPoses(SET, reach, k), shift: dive.shift * k };
      }
      return { pose: blendPoses(reach, end, smooth((t - contact - 0.15) / 0.5)), shift: dive.shift };
    };
  }

  const G = GRAVITY / KEEPER_SCALE; // in feet a second²
  const push = pushPose(dive);
  const shape = { ...reach, lift: 0 };
  // From his hips as he leaves the ground to his hips at the ball: across at a steady speed, and up
  // and down as gravity has it.
  const from = push.hip;
  const to = hipOf(reach, dive.shift / KEEPER_SCALE);
  const rise = to.y - from.y;
  // He leaves the ground as soon as he has pushed off; for a leap, only as early as he needs to, so that
  // he is at the top of it at the ball (or quicker than gravity, if there isn't time).
  const most = contact - reaction - Math.min(PUSH_S, 0.45 * (contact - reaction));
  const d = rise > 0 ? Math.min(most, Math.max(Math.sqrt((2 * rise) / G), Math.abs(to.x - from.x) * KEEPER_SCALE / TOP_SPEED)) : most;
  const takeoff = contact - d;
  const crouch = Math.max(reaction, takeoff - CROUCH_S);
  const vx = (to.x - from.x) / d;
  const g = Math.max(G, (2 * rise) / (d * d));
  const vy = (rise + (g * d * d) / 2) / d;
  const vyAtBall = vy - g * d;
  // When he comes down: his hips falling from where they were at the ball to where they are lying (or standing).
  const down = falls ? lyingPose(dive.side, held) : landPose(held);
  const end = falls ? down : standPose(held);
  const groundY = hipOf(down).y + restLift(down);
  const drop = to.y - groundY;
  const air = Math.max(0.12, (vyAtBall + Math.sqrt(Math.max(0, vyAtBall * vyAtBall + 2 * G * drop))) / G);
  const skid = falls ? SKID_S : 0.04;
  // He carries on across until his hands are at the post (or where they were at the ball, if that's further).
  const wallAt = Math.max(wall - GLOVE, farthest({ pose: reach, shift: dive.shift }, dive.side));
  const reachOut = Math.max(beyondHip(shape, dive.side), beyondHip(down, dive.side));
  const room = Math.max(0, (wallAt / KEEPER_SCALE - reachOut) - dive.side * to.x);
  const carry = (travel) => {
    const along = dive.side * travel;
    return dive.side * (along <= 0 || room === 0 ? Math.min(along, 0) : room * (1 - Math.exp(-along / room)));
  };

  return (t) => {
    if (t <= reaction) return { pose: settle(t), shift: 0 };
    if (t <= takeoff) return { pose: blendPoses(SET, push, smooth((t - crouch) / (takeoff - crouch))), shift: 0 };
    if (t <= contact) {
      // Off the ground: he stretches out quickly, and is at full stretch as the ball arrives.
      const tau = t - takeoff;
      const body = blendPoses(push, shape, 1 - (1 - tau / d) ** 2);
      // His trailing foot leaves the grass as he goes; it doesn't go through it.
      const y = Math.max(from.y + vy * tau - (g * tau * tau) / 2, hipOf(body).y + restLift(body, FEET));
      return putHip(body, J(from.x + vx * tau, y));
    }
    const tau = t - contact;
    let body;
    if (falls || tau < air) body = blendPoses(shape, down, smooth(tau / air));
    else body = blendPoses(down, end, smooth((tau - air - 0.08) / 0.45));
    // In the air he keeps going; on the grass he slides to a stop.
    const across = Math.min(tau, air) + skid * (1 - Math.exp(-Math.max(0, tau - air) / skid));
    const y = Math.max(to.y + vyAtBall * tau - (G * tau * tau) / 2, hipOf(body).y + restLift(body));
    const out = putHip(body, J(to.x + carry(vx * across), y));
    // Never through the post.
    const over = farthest(out, dive.side) - wallAt;
    if (over > 0) out.shift -= dive.side * over;
    return out;
  };
}

/** Where his hips are as drawn, in metres across and up: the middle of him, for his shadow. */
export function bodyCentre(keeper) {
  const h = hipOf(keeper.pose);
  return [h.x * KEEPER_SCALE + keeper.shift, h.y * KEEPER_SCALE];
}

// ---- Shapes ----

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dotv = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossv = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unitv = (a) => mul(a, 1 / (Math.hypot(...a) || 1));
const lerpv = (a, b, t) => add(a, mul(sub(b, a), t));

/** A matrix with the axes x, y, z (their lengths the sizes) and the centre c. */
function basis(c, x, y, z) {
  return new Float32Array([...x, 0, ...y, 0, ...z, 0, ...c, 1]);
}

/** Two unit vectors square to the unit vector d, the first as near as it can be to `hint`. */
function squareTo(d, hint) {
  let p = sub(hint, mul(d, dotv(hint, d)));
  if (Math.hypot(...p) < 1e-4) p = crossv(d, Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]);
  p = unitv(p);
  return [p, crossv(d, p)];
}

/**
 * Builds a keeper's parts from a pose.
 * @param {Pose} pose
 * @param {{gloves?: boolean}} [options]
 * @returns {Part[]} in metres, standing on the origin and facing +z (towards the kicker)
 */
export function keeperParts(pose, { gloves = true } = {}) {
  const out = [];
  const j3 = liftPose(pose);
  const P = (name) => [-j3[name].r * KEEPER_SCALE, j3[name].u * KEEPER_SCALE, j3[name].f * KEEPER_SCALE];
  const ball = (c, radii, colour, shine = 0.2) => {
    out.push({ mesh: 'sphere', m: basis(c, [radii[0], 0, 0], [0, radii[1], 0], [0, 0, radii[2]]), colour, shine });
  };
  // A round limb from a to b, `r` thick, with round ends.
  const tube = (a, b, r1, colour, shine = 0.2, r2 = r1) => {
    out.push({ mesh: 'cylinder', m: limb(a, b, r1), colour, shine });
    ball(a, [r1, r1, r1], colour, shine);
    ball(b, [r2, r2, r2], colour, shine);
  };
  // An oval-sectioned body part from a to b: wide across `side`, deep along `front`.
  const oval = (a, b, wide, deep, side, front, colour, shine = 0.2) => {
    const d = sub(b, a);
    out.push({ mesh: 'cylinder', m: basis(lerpv(a, b, 0.5), mul(side, wide), d, mul(front, deep)), colour, shine });
  };

  const hip = P('hip');
  const neck = P('neck');
  const spine = unitv(sub(neck, hip));
  const lSh = P('lShoulder');
  const rSh = P('rShoulder');
  const side = unitv(sub(rSh, lSh));
  let front = crossv(side, spine);
  if (front[2] < 0) front = mul(front, -1);
  const along = (k) => add(hip, mul(sub(neck, hip), k));

  // Torso: shorts at the hips, the jersey up to the shoulders, with a darker panel on the chest.
  oval(add(hip, mul(spine, -0.12)), add(hip, mul(spine, 0.2)), 0.19, 0.125, side, front, KIT.shorts);
  ball(add(hip, mul(spine, 0.04)), [0.19, 0.16, 0.13], KIT.shorts);
  oval(along(0.12), along(0.8), 0.17, 0.115, side, front, KIT.jersey, 0.25);
  ball(along(0.84), [0.215, 0.14, 0.13], KIT.jersey, 0.25);
  ball(add(along(0.55), mul(front, 0.095)), [0.12, 0.17, 0.035], KIT.jerseyShade, 0.15);
  ball(add(along(0.1), mul(front, 0.02)), [0.185, 0.07, 0.125], KIT.band, 0.1);

  // Legs: shorts to mid-thigh, bare knees, socks with a stripe, boots.
  for (const s of ['l', 'r']) {
    const hipJ = P(`${s}Hip`);
    const knee = P(`${s}Knee`);
    const foot = P(`${s}Foot`);
    const mid = lerpv(hipJ, knee, 0.5);
    const sock = lerpv(knee, foot, 0.28);
    tube(hipJ, mid, 0.115, KIT.shorts, 0.15, 0.1);
    tube(mid, knee, 0.095, KIT.skin, 0.2, 0.075);
    tube(knee, sock, 0.07, KIT.skin, 0.2, 0.065);
    tube(sock, foot, 0.065, KIT.socks, 0.1, 0.05);
    out.push({ mesh: 'cylinder', m: limb(lerpv(sock, foot, 0.1), lerpv(sock, foot, 0.28), 0.068), colour: KIT.sockStripe, shine: 0.1 });
    const toe = unitv([0, 0, 1]);
    ball(add(foot, add(mul(toe, 0.1), [0, 0.03, 0])), [0.06, 0.05, 0.14], KIT.boots, 0.4);
  }

  // Arms: long sleeves to the wrist, a cuff, then a big glove.
  for (const s of ['l', 'r']) {
    const shoulder = P(`${s}Shoulder`);
    const elbow = P(`${s}Elbow`);
    const hand = P(`${s}Hand`);
    ball(shoulder, [0.085, 0.085, 0.085], KIT.jersey, 0.25);
    const wrist = lerpv(elbow, hand, 0.82);
    tube(shoulder, elbow, 0.075, KIT.sleeve, 0.2, 0.065);
    tube(elbow, wrist, 0.065, KIT.sleeve, 0.2, 0.055);
    out.push({ mesh: 'cylinder', m: limb(lerpv(elbow, hand, 0.72), wrist, 0.067), colour: KIT.cuff, shine: 0.1 });
    if (gloves) glove(out, wrist, unitv(sub(hand, elbow)), front, s === 'l' ? -1 : 1);
  }

  // Head: skin, hair, ears, eyes, brows and a mouth.
  const head = P('head');
  const neckTop = lerpv(neck, head, 0.55);
  tube(add(neck, mul(spine, -0.03)), neckTop, 0.05, KIT.skin);
  const hUp = unitv(sub(head, neck));
  const hFront = front;
  const hRight = unitv(crossv(hUp, hFront)).map((v) => -v);
  const hc = lerpv(neck, head, 0.72);
  const at = (x, y, z) => add(hc, add(mul(hRight, x), add(mul(hUp, y), mul(hFront, z))));
  const R = 0.105;
  ball(hc, [R, R * 1.1, R], KIT.skin, 0.35);
  ball(at(0, 0.035, -0.02), [R * 1.06, R * 1.0, R * 1.04], KIT.hair, 0.3);
  for (const x of [-1, 1]) {
    ball(at(x * R * 0.98, -0.01, -0.01), [0.018, 0.04, 0.03], KIT.skinShade);
    ball(at(x * 0.04, 0.0, R * 0.9), [0.017, 0.014, 0.012], KIT.eye);
    ball(at(x * 0.04, 0.03, R * 0.9), [0.024, 0.007, 0.012], KIT.hair);
  }
  ball(at(0, -0.02, R * 0.98), [0.016, 0.02, 0.016], KIT.skinShade);
  ball(at(0, -0.065, R * 0.9), [0.03, 0.008, 0.012], KIT.mouth);
  return out;
}

/**
 * A big keeper's glove on a hand: a thick palm, four fingers and a thumb in green with darker
 * pads, the fingers along `dir`, the palm turned towards `front`.
 */
function glove(out, wrist, dir, front, sign) {
  const [pad, across] = squareTo(dir, front);
  const at = (x, y, z = 0) => add(wrist, add(mul(across, x), add(mul(dir, y), mul(pad, z))));
  const part = (mesh, m, colour, shine = 0.3) => out.push({ mesh, m, colour, shine });
  const orient = (c, ax, ay, az) => basis(c, mul(across, ax), mul(dir, ay), mul(pad, az));
  part('sphere', orient(at(0, 0.09), 0.095, 0.11, 0.05), KIT.glove);
  part('sphere', orient(at(0, 0.1, 0.045), 0.075, 0.09, 0.02), KIT.gloveDark, 0.2);
  [-0.067, -0.022, 0.022, 0.067].forEach((x, i) => {
    const len = [0.105, 0.125, 0.12, 0.1][i];
    const base = at(x, 0.15);
    const tip = add(base, mul(dir, len));
    out.push({ mesh: 'cylinder', m: limb(base, tip, 0.021), colour: KIT.glove, shine: 0.3 });
    part('sphere', orient(tip, 0.021, 0.021, 0.021), KIT.glove);
  });
  const thumbBase = at(sign * 0.09, 0.07);
  const thumbTip = add(thumbBase, add(mul(across, sign * 0.07), mul(dir, 0.06)));
  out.push({ mesh: 'cylinder', m: limb(thumbBase, thumbTip, 0.023), colour: KIT.glove, shine: 0.3 });
  part('sphere', orient(thumbTip, 0.023, 0.023, 0.023), KIT.glove);
}

/** Lowest and highest points of a pose's joints in metres, and across: for fitting him in a picture. */
export function poseExtent(pose) {
  const j3 = liftPose(pose);
  const pts = Object.values(j3).map((j) => [-j.r * KEEPER_SCALE, j.u * KEEPER_SCALE, j.f * KEEPER_SCALE]);
  const range = (i) => [Math.min(...pts.map((p) => p[i])), Math.max(...pts.map((p) => p[i]))];
  return { x: range(0), y: range(1), z: range(2) };
}
