// Strike Zone's picture: what is in the pitcher's view at any moment, kept free of the browser so it is unit-tested.
// The view is fixed (strike-zone-logic.js): the plate in the middle, the batter in his box, the catcher crouched
// behind it with his mitt up and the plate umpire over his shoulder. After a pitch that hit the screen, the pitch is
// shown as a short replay that starts where it crossed the plate: the ball comes in (a quick lead-in, while the batter
// swings or takes), then goes into the mitt, off the bat foul, or into the batter; the umpire makes the call. A ball
// the batter puts in play hands over to Batter Up's play (gap-shot-play.js, gap-shot-scene.js), whose camera rises
// from the pitcher's view and comes back to it.
//
// Everything is a function of the time since the pitch began (milliseconds), so the same pitch is always drawn the same
// way. Positions on the field are in feet as in fielders-choice-logic.js (+x towards first base, which is the LEFT of
// the screen); a pitch's own `x` is the pitcher's (see strike-zone-logic.js), so the field's x is minus it.

import { BODY, POSES, blendPoses, ease, keyframes, shoulderOf, swapSides, twoBone } from './fielders-choice-players.js';
import { ballShape, baseballShapes, turnAbout } from './fielders-choice-models.js';
import { MOUND } from './fielders-choice-logic.js';
import { STRIKE_ZONE_RULES as RULES, batterSpot, bodyBox, zoneOf } from './strike-zone-logic.js';

/**
 * @typedef {import('./strike-zone-logic.js').Batter} Batter
 * @typedef {import('./strike-zone-logic.js').Pitch} Pitch
 * @typedef {import('./strike-zone-logic.js').Decision} Decision
 * @typedef {{x:number, y:number, z:number}} Point3
 */

/** The pitch replay's timing, in milliseconds. */
export const PITCH_TIMING = {
  approach: 260, // the lead-in: the ball comes in to the plate, the batter swings (or takes) as it arrives
  travel: 240, // from the plate into the mitt
  callAfter: 100, // the call comes this long after the ball is in the mitt (or off the bat)
  hold: 1100, // …and stays this long
  foul: 700, // a foul ball's flight, before it is out of the picture
  hit: 120, // from the plate to the batter's body
  swingBefore: 240, // the swing takes this long to reach the ball
  followThrough: 240,
};

/** Where everyone stands (feet): the catcher a little behind the plate, the plate umpire behind him. */
export const SPOTS = { catcher: { x: 0, y: -3 }, umpire: { x: 0, y: -6.5 } };

// The catcher is a smaller man than the ballplayers the poses were drawn for, so that his head is about level with the top of
// the zone as he crouches; the plate umpire is a little smaller too. Both are the whole figure scaled, flesh and bones.
export const SCALES = { catcher: 0.82, umpire: 0.93 };
const CATCH_DEPTH = -1.5; // how far behind the plate the ball goes into the mitt (y)
const BALL_RADIUS = 0.17; // a little bigger than a baseball's 0.12 ft: it has to be seen from the mound
const LEAD_IN = { along: 9, across: 0.8, above: 0.5 }; // where the ball is at the start of the lead-in, from the plate
const GRAVITY = 32.2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp3 = (a, b, u) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u });

// ---- The pitch ------------------------------------------------------------------------------------

/**
 * @typedef {object} Animation a pitch to show, from the moment its replay starts
 * @property {Decision} decision
 * @property {Pitch} point
 * @property {Batter} batter
 * @property {boolean} swings
 * @property {number} contactAt when the ball is at the plate: the bat meets it (ms)
 * @property {number|null} arriveAt when it is in the mitt (or has hit the batter), else null
 * @property {number|null} callAt when the umpire calls it (null for a ball in play: the play's call is its own)
 * @property {number|null} endAt when the replay is over (null for a ball in play)
 * @property {'strike'|'out'|null} gesture the umpire's signal
 * @property {{x:number, z:number}} mitt where the catcher's mitt is (a pitch's x, z)
 * @property {(ms:number) => Point3|null} ball where the ball is (field), null when it can't be seen
 * @property {{at:number, kind:'crack'|'pop'|'thud'}[]} sounds
 */

/**
 * What a pitch looks like: when the ball is where, what the batter and the umpire do. `event` is what the pitch came
 * to for the inning (strikeout, walk…), which the umpire's signal shows.
 * @param {Decision} decision
 * @param {Pitch} point where the pitch crossed the plate
 * @param {Batter} batter
 * @param {string} event
 * @returns {Animation}
 */
export function pitchAnimation(decision, point, batter, event, timing = PITCH_TIMING) {
  const { outcome } = decision;
  const plate = RULES.plate.front;
  const contactAt = timing.approach;
  const at = { x: 0 - point.x, y: plate, z: point.z }; // on the plate's plane, in field coordinates
  const lead = { x: at.x + LEAD_IN.across, y: plate + LEAD_IN.along, z: at.z + LEAD_IN.above };
  const mitt = { x: clamp(point.x, -2.4, 2.4), z: clamp(point.z, 0.5, 4.6) };
  const caught = outcome === 'ball' || outcome === 'calledStrike' || outcome === 'swingingStrike';
  const into = { x: at.x, y: CATCH_DEPTH, z: Math.max(0.4, at.z - 0.15) };
  let arriveAt = null;
  let callAt = null;
  let sounds = [];
  /** @type {(ms:number) => Point3|null} */
  let after = () => null;

  if (caught) {
    arriveAt = contactAt + timing.travel;
    callAt = arriveAt + timing.callAfter;
    sounds = [{ at: arriveAt, kind: 'pop' }];
    after = (ms) => (ms <= arriveAt ? lerp3(at, into, (ms - contactAt) / timing.travel) : null);
  } else if (outcome === 'foul') {
    // Off the bat to the side (out of the picture in a moment) or straight back over the catcher.
    const side = decision.foul?.side ?? 1;
    const back = decision.foul?.kind === 'back';
    const v = back ? { x: 0, y: -48, z: 42 } : { x: -side * 40, y: -8, z: 22 };
    arriveAt = contactAt;
    callAt = contactAt + timing.callAfter + 150;
    sounds = [{ at: contactAt, kind: 'crack' }];
    after = (ms) => {
      const s = (ms - contactAt) / 1000;
      return s > timing.foul / 1000 ? null : { x: at.x + v.x * s, y: at.y + v.y * s, z: at.z + v.z * s - 0.5 * GRAVITY * s * s };
    };
  } else if (outcome === 'hitByPitch') {
    // Into the batter, then down to the ground.
    const body = bodyBox(batter);
    const to = { x: 0 - clamp(point.x, body.x0, body.x1), y: 0.4, z: point.z };
    arriveAt = contactAt + timing.hit;
    callAt = arriveAt + timing.callAfter + 100;
    sounds = [{ at: arriveAt, kind: 'thud' }];
    after = (ms) => {
      if (ms <= arriveAt) return lerp3(at, to, (ms - contactAt) / timing.hit);
      const s = (ms - arriveAt) / 1000;
      const ground = BALL_RADIUS * 0.8;
      return { x: to.x + 0.5 * s * (to.x > 0 ? 1 : -1), y: to.y + 0.8 * s, z: Math.max(ground, to.z - 0.5 * GRAVITY * s * s + 3 * s * Math.exp(-4 * s)) };
    };
  } else {
    // In play: the ball is out of the lead-in at the plate and Batter Up's flight takes over.
    sounds = [{ at: contactAt, kind: 'crack' }];
  }
  const ball = (ms) => {
    if (ms < 0) return null;
    if (ms <= contactAt) return lerp3(lead, at, ms / contactAt);
    return after(ms);
  };
  return {
    decision, point, batter, swings: decision.swing, contactAt, arriveAt, callAt, endAt: callAt === null ? null : callAt + timing.hold,
    gesture: caught && event === 'strikeout' ? 'out' : caught && outcome !== 'ball' ? 'strike' : null, mitt, ball, sounds,
  };
}

/** The ball at time `ms` of a pitch as shapes, with a short trail of ghosts behind it. */
export function pitchBallShapes(anim, ms) {
  const p = anim.ball(ms);
  if (!p) return [];
  const out = [];
  [0.05, 0.035, 0.02].forEach((back, i, all) => {
    const q = anim.ball(Math.max(0, ms - back * 1000));
    if (q) out.push({ ...ballShape(q, BALL_RADIUS * (0.55 + ((all.length - i) / all.length) * 0.3)), colour: [0.89, 0.87, 0.82, 0.12 + 0.1 * i] });
  });
  out.push(...baseballShapes(p, BALL_RADIUS, turnAbout({ x: 0.6, y: 0.8, z: 0 }, ms * 0.03)));
  return out;
}

// ---- The people ----------------------------------------------------------------------------------------

/** How the batter stands, loads, swings and follows through, or takes the pitch, over the replay (a taller one is a bigger skeleton). */
export function batterPose(anim, ms, timing = PITCH_TIMING) {
  if (!anim) return POSES.stance;
  const c = anim.contactAt;
  if (anim.swings) {
    return keyframes([
      { at: 0, pose: POSES.stance }, { at: 40, pose: POSES.stance }, { at: c - timing.swingBefore + 40, pose: POSES.load },
      { at: c, pose: POSES.swing }, { at: c + timing.followThrough, pose: POSES.followThrough },
    ], ms);
  }
  // Takes it: a stride into the pitch and back.
  return keyframes([
    { at: 0, pose: POSES.stance }, { at: c - 160, pose: POSES.stance }, { at: c, pose: POSES.load }, { at: c + 360, pose: POSES.stance },
  ], ms);
}

/** A batter's pose for his side: a right-hander's limbs are swapped (see gap-shot-scene.js), so he is a true mirror of a left-hander. */
export function sided(batter, pose) {
  return batter.bats === 'R' ? swapSides(pose) : pose;
}

/** How big the whole batter is, over a six-footer: a shorter or taller one is the whole figure scaled. */
export function batterScale(batter) {
  return batter.height / RULES.referenceHeight;
}

/** The catcher's crouch with his mitt held out to `target` (a pitch's x, z; the figure is drawn scaled, so the pose reaches 1/scale as far). */
function mittPose(target) {
  const base = POSES.catcher;
  const k = SCALES.catcher;
  const hand = { x: target.x / k, y: target.z / k };
  const { elbow } = twoBone(shoulderOf(base, 'r'), hand, 1, BODY.upperArm, BODY.forearm);
  return { ...base, rHand: hand, rElbow: elbow };
}

/** His mitt held low and inside the zone, before the pitch. */
const MITT_REST = { x: 0.3, z: 1.9 };
const CATCHER_REST = mittPose(MITT_REST);

/** The catcher at time `ms`: where he is and how he is crouched, his mitt moving to where the pitch is going. */
export function catcherAt(anim, ms) {
  if (!anim || anim.decision.outcome === 'inPlay') return { at: SPOTS.catcher, pose: CATCHER_REST, holdsBall: false };
  // He shifts a little towards a wide pitch, and the mitt goes the rest of the way.
  const shift = clamp(0.6 * anim.mitt.x, -1.2, 1.2);
  const arrive = anim.arriveAt ?? anim.contactAt + 200;
  const u = ease((ms - (anim.contactAt - 140)) / (arrive - anim.contactAt + 100));
  return {
    at: { x: SPOTS.catcher.x - shift * u, y: SPOTS.catcher.y },
    pose: blendPoses(CATCHER_REST, mittPose({ x: anim.mitt.x - shift, z: anim.mitt.z }), u),
    holdsBall: anim.decision.outcome !== 'foul' && anim.decision.outcome !== 'hitByPitch' && ms >= (anim.arriveAt ?? Infinity),
  };
}

/** The plate umpire at time `ms`: set, then the signal for a strike (a fist) or a strikeout (the punch-out). */
export function umpirePose(anim, ms) {
  if (!anim || !anim.gesture || anim.callAt === null) return POSES.umpSet;
  const c = anim.callAt;
  if (anim.gesture === 'out') {
    return keyframes([{ at: c, pose: POSES.umpSet }, { at: c + 200, pose: POSES.umpOutUp }, { at: c + 400, pose: POSES.umpOutDown }, { at: c + 650, pose: POSES.umpOutUp }, { at: c + 850, pose: POSES.umpOutDown }], ms);
  }
  return keyframes([{ at: c, pose: POSES.umpSet }, { at: c + 200, pose: POSES.umpOutUp }, { at: c + 900, pose: POSES.umpOutUp }], ms);
}

/**
 * Everyone in the picture at time `ms` of a pitch (or standing still, with no pitch): the batter in his box, the
 * catcher and the umpire. The fielders and the runners are behind the pitcher's eyes, so they are not drawn.
 * @param {Animation|null} anim null for the still picture
 * @param {number} ms
 * @param {{batter:Batter|null, batters:number}} info who is at the plate and how many have batted (his number)
 */
export function pitchFigures(anim, ms, info) {
  const figures = [];
  const batter = anim?.batter ?? info.batter;
  const catcher = catcherAt(anim, ms);
  figures.push({
    at: catcher.at, facing: { x: 0, y: 1 },
    player: { pose: catcher.pose, team: 'home', number: 9, skin: 4, glove: 'r', mask: true, holdsBall: catcher.holdsBall, scale: SCALES.catcher },
  });
  const away = batter && batter.bats === 'R' ? 0.8 : -0.8; // he stands off to the side away from the batter, to see over the catcher
  figures.push({
    at: { x: SPOTS.umpire.x + away, y: SPOTS.umpire.y }, facing: { x: 0, y: 1 },
    player: { pose: umpirePose(anim, ms), team: 'umpire', skin: 1, mask: true, scale: SCALES.umpire },
  });
  if (batter) {
    figures.push({
      at: batterSpot(batter), facing: { x: batter.bats === 'R' ? 1 : -1, y: 0 },
      player: {
        pose: sided(batter, batterPose(anim ?? { batter, swings: false, contactAt: 0 }, anim ? ms : 0)), team: 'away', helmet: true, number: 10 + ((info.batters * 7) % 40), skin: 3,
        scale: batterScale(batter), youth: batterScale(batter) < 0.85,
      },
      lookAt: { x: 0, y: 60.5 },
    });
  }
  return figures;
}

/**
 * Batter Up's figures for a ball in play, for a left-handed or short batter and with the catcher still masked in the
 * first moments (the camera starts in front of him).
 * @param {typeof import('./gap-shot-scene.js').playFigures} playFigures Batter Up's
 */
export function playFiguresFor(playFigures, plan, fielders, t, info) {
  const batter = info.batter;
  const figures = playFigures(plan, fielders, t, {
    batters: info.batters, batterSide: batter.bats, batterScale: batterScale(batter),
  });
  const kept = [];
  for (const f of figures) {
    const home = f.player && f.player.team === 'home';
    // The pitcher stands just behind the camera as the play starts: out of the picture until the camera has risen past him.
    if (home && t < PITCHER_HIDDEN && Math.hypot(f.at.x - MOUND.x, f.at.y - MOUND.y) < 4) continue;
    if (home && t < 0.6 && Math.hypot(f.at.x - SPOTS.catcher.x, f.at.y - SPOTS.catcher.y) < 0.5) {
      kept.push({ ...f, player: { ...f.player, mask: true, scale: SCALES.catcher, pose: t < 0.15 ? CATCHER_REST : f.player.pose } });
    } else kept.push(f);
  }
  kept.push({
    at: { x: SPOTS.umpire.x + (batter.bats === 'R' ? 0.8 : -0.8), y: SPOTS.umpire.y }, facing: { x: 0, y: 1 },
    player: { pose: POSES.umpSet, team: 'umpire', skin: 1, mask: true, scale: SCALES.umpire },
  });
  return kept;
}

/** Seconds into a play for which the pitcher is not drawn: the camera starts a step in front of him and rises past. */
export const PITCHER_HIDDEN = 0.7;

// ---- The zone, drawn ----------------------------------------------------------------------------------

const ZONE_COLOUR = [0.93, 0.72, 0.2, 0.55];
const ZONE_LINE = 0.028; // half the line's thickness (feet)

/** A box from its middle and half-sizes. */
function box(c, hx, hy, hz, colour) {
  return { mesh: 'box', m: [hx, 0, 0, 0, 0, hy, 0, 0, 0, 0, hz, 0, c.x, c.y, c.z, 1], colour, outline: false, cast: false };
}

/**
 * The strike zone as a thin amber frame hanging over the front of the plate, so players can see what they are aiming at.
 * @param {Batter} batter
 */
export function zoneShapes(batter) {
  const zone = zoneOf(batter);
  const y = RULES.plate.front;
  const half = (zone.right - zone.left) / 2;
  const height = zone.top - zone.bottom;
  const mid = (zone.top + zone.bottom) / 2;
  return [
    box({ x: 0, y, z: zone.top }, half + ZONE_LINE, ZONE_LINE, ZONE_LINE, ZONE_COLOUR),
    box({ x: 0, y, z: zone.bottom }, half + ZONE_LINE, ZONE_LINE, ZONE_LINE, ZONE_COLOUR),
    box({ x: -half, y, z: mid }, ZONE_LINE, ZONE_LINE, height / 2, ZONE_COLOUR),
    box({ x: half, y, z: mid }, ZONE_LINE, ZONE_LINE, height / 2, ZONE_COLOUR),
  ];
}

// ---- The zone inset ----------------------------------------------------------------------------------

/** What the inset shows, in a pitch's own x and z (feet): a fixed window, so batters of any height fit. */
export const INSET = { x: 2.3, bottom: 0.4, top: 4.8 };

/** The colours of a pitch's dot in the inset, by what it was. */
export const DOT_COLOURS = { ball: '#4aa3ff', strike: '#ff6b5a', inPlay: '#ffd23f', hitByPitch: '#b98cff' };

/** Which colour a pitch's outcome is drawn in. */
export function dotKind(outcome) {
  if (outcome === 'ball') return 'ball';
  if (outcome === 'inPlay') return 'inPlay';
  if (outcome === 'hitByPitch') return 'hitByPitch';
  return 'strike';
}

/**
 * Where things are in the inset, a `width` by `height` picture: the same way round as the screen (the pitcher's right
 * is the right). The strike zone and the plate, the batter's box (shaded where he stands), and a function from a pitch
 * to a point in the picture.
 * @param {Batter|null} batter
 * @returns {{point:(p:{x:number, z:number}) => {x:number, y:number}, zone:{x0:number, y0:number, x1:number, y1:number},
 *   plate:{x0:number, x1:number, y:number}, body:{x0:number, y0:number, x1:number, y1:number}|null, ground:number}}
 */
export function insetLayout(batter, width, height) {
  const point = (p) => ({ x: ((p.x + INSET.x) / (2 * INSET.x)) * width, y: height - ((p.z - INSET.bottom) / (INSET.top - INSET.bottom)) * height });
  const z = batter ? zoneOf(batter) : zoneOf({ height: RULES.referenceHeight });
  const a = point({ x: z.left, z: z.top });
  const b = point({ x: z.right, z: z.bottom });
  const plate = point({ x: RULES.plate.half, z: 0 });
  const body = batter ? bodyBox(batter) : null;
  const bodyA = body && point({ x: body.x0, z: body.z1 });
  const bodyB = body && point({ x: body.x1, z: body.z0 });
  return {
    point,
    zone: { x0: a.x, y0: a.y, x1: b.x, y1: b.y },
    plate: { x0: point({ x: -RULES.plate.half, z: 0 }).x, x1: plate.x, y: point({ x: 0, z: 0 }).y },
    body: body ? { x0: bodyA.x, y0: bodyA.y, x1: bodyB.x, y1: bodyB.y } : null,
    ground: point({ x: 0, z: 0 }).y,
  };
}
