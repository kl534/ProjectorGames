// Fielder's Choice players: bold cartoon ballplayers and umpires, their teams
// and sizes. Each is a simple skeleton (joints in feet) posed by keyframes
// (the pitcher's windup, the swing, the umpire's calls), by cycles (running,
// jogging) and, for a catch, by reaching the glove to a spot with a two-bone
// arm. The poses are drawn flat, from the front or the side;
// fielders-choice-models.js stands them up in 3D and builds the players'
// bodies round them.
//
// Nothing runs in the browser when this loads, so the poses are unit tested.
// Painting takes a canvas context. Colours are mid to dark, with no white,
// so a light-coloured ball stands out against every player.

/** @typedef {{x:number, y:number}} Joint feet: across (+ right on screen) and up from between the feet */

/**
 * @typedef {object} Pose
 * @property {'front'|'side'} view facing us, or side on (facing right; painting can mirror it)
 * @property {Joint} hip
 * @property {Joint} neck the top of the body
 * @property {Joint} head its centre
 * @property {Joint} lElbow screen left (front view), or the far side (side view)
 * @property {Joint} lHand
 * @property {Joint} rElbow screen right (front view), or the near side (side view)
 * @property {Joint} rHand
 * @property {Joint} lKnee
 * @property {Joint} lFoot
 * @property {Joint} rKnee
 * @property {Joint} rFoot
 * @property {string} [face] 'neutral' | 'focus' | 'yell' | 'happy' | 'oops'
 * @property {Joint} [look] where the eyes look (-1–1 each way)
 * @property {Joint} [batTip] the end of a bat held in both hands
 * @property {number} [lift] feet off the ground (a jump, a run's bounce)
 * @property {number} [turn] radians the whole figure is turned about its feet (a dive), + anticlockwise
 */

const J = (x, y) => ({ x, y });
const TAU = 2 * Math.PI;
const JOINTS = ['hip', 'neck', 'head', 'lElbow', 'lHand', 'rElbow', 'rHand', 'lKnee', 'lFoot', 'rKnee', 'rFoot'];

/** How far from the middle of the bag (15 inches across) a foot on it stands, in feet. */
export const BAG_FOOT = 0.3;

/** Sizes, in feet. A bold cartoon: a big head on a sturdy body. */
export const BODY = {
  headRadius: 0.62,
  upperArm: 1.15,
  forearm: 1.05,
  thigh: 1.4,
  shin: 1.35,
  shoulderHalf: 0.78,
};

/** The two teams (made up) and the umpires. */
export const TEAMS = {
  home: {
    name: 'Lamplighters', city: 'Harbor City', letter: 'L',
    jersey: '#24427a', jerseyShade: '#1a3160', trim: '#e0a72a', undershirt: '#1a2c55',
    pants: '#a3aab8', pantsShade: '#838a99', socks: '#24427a', cap: '#1a3160', capShade: '#121f45', logo: '#e0a72a',
  },
  away: {
    name: 'Rattlers', city: 'Red Rock', letter: 'R',
    jersey: '#a7332b', jerseyShade: '#82241e', trim: '#3a3d45', undershirt: '#5e1a16',
    pants: '#8d9099', pantsShade: '#6f727b', socks: '#a7332b', cap: '#82241e', capShade: '#5e1a16', logo: '#e8c48a',
  },
  umpire: {
    name: '', letter: '',
    jersey: '#2a3346', jerseyShade: '#1d2433', trim: '#59606e', undershirt: '#2a3346',
    pants: '#575d6a', pantsShade: '#444954', socks: '#1d2433', cap: '#141822', capShade: '#0c0f16', logo: '#59606e',
  },
};

export const SKIN = ['#e3b48e', '#c68e63', '#8d5a3b', '#f0c7a2', '#a8714b', '#6e4630'];

// ---- Poses ------------------------------------------------------------------

/** Every pose made of joints; `view` and the rest are filled in. */
function pose(view, joints, extra = {}) {
  return { view, face: 'neutral', look: J(0, 0), lift: 0, turn: 0, ...joints, ...extra };
}

/** @type {Record<string, Pose>} */
export const POSES = {
  stand: pose('front', {
    hip: J(0, 2.85), neck: J(0, 4.5), head: J(0, 5.15),
    lElbow: J(-1.0, 3.6), lHand: J(-1.05, 2.7), rElbow: J(1.0, 3.6), rHand: J(1.05, 2.7),
    lKnee: J(-0.42, 1.45), lFoot: J(-0.48, 0), rKnee: J(0.42, 1.45), rFoot: J(0.48, 0),
  }),
  // Waiting for the throw: feet apart, knees bent, glove up as a target.
  ready: pose('front', {
    hip: J(0, 2.55), neck: J(0, 4.2), head: J(0, 4.85),
    lElbow: J(-0.95, 3.3), lHand: J(-0.25, 3.85), rElbow: J(0.95, 3.4), rHand: J(0.3, 4.15),
    lKnee: J(-0.95, 1.3), lFoot: J(-1.1, 0), rKnee: J(0.95, 1.3), rFoot: J(1.1, 0),
  }, { face: 'focus' }),
  // Infielders and outfielders as the pitch comes in.
  crouch: pose('front', {
    hip: J(0, 2.3), neck: J(0, 3.9), head: J(0, 4.55),
    lElbow: J(-1.0, 2.85), lHand: J(-0.6, 2.0), rElbow: J(1.0, 2.85), rHand: J(0.6, 2.0),
    lKnee: J(-1.05, 1.2), lFoot: J(-1.15, 0), rKnee: J(1.05, 1.2), rFoot: J(1.15, 0),
  }, { face: 'focus' }),
  catcher: pose('front', {
    hip: J(0, 1.35), neck: J(0, 2.95), head: J(0, 3.6),
    lElbow: J(-1.0, 2.1), lHand: J(-0.65, 1.35), rElbow: J(0.95, 2.3), rHand: J(0.35, 2.7),
    lKnee: J(-1.2, 1.25), lFoot: J(-0.95, 0), rKnee: J(1.2, 1.25), rFoot: J(0.95, 0),
  }, { face: 'focus' }),
  umpSet: pose('front', {
    hip: J(0, 2.2), neck: J(0, 3.8), head: J(0, 4.45),
    lElbow: J(-1.1, 2.6), lHand: J(-0.85, 1.6), rElbow: J(1.1, 2.6), rHand: J(0.85, 1.6),
    lKnee: J(-0.9, 1.25), lFoot: J(-1.0, 0), rKnee: J(0.9, 1.25), rFoot: J(1.0, 0),
  }, { face: 'focus' }),
  // The out call: the right fist goes up…
  umpOutUp: pose('front', {
    hip: J(0, 2.85), neck: J(0, 4.5), head: J(0, 5.15),
    lElbow: J(-1.0, 3.6), lHand: J(-0.95, 2.7), rElbow: J(1.25, 5.0), rHand: J(1.0, 6.0),
    lKnee: J(-0.42, 1.45), lFoot: J(-0.6, 0), rKnee: J(0.42, 1.45), rFoot: J(0.6, 0),
  }, { face: 'yell' }),
  // …and hammers down.
  umpOutDown: pose('front', {
    hip: J(0.1, 2.7), neck: J(0.2, 4.35), head: J(0.25, 5.0),
    lElbow: J(-0.95, 3.5), lHand: J(-0.9, 2.6), rElbow: J(1.45, 4.5), rHand: J(1.0, 4.0),
    lKnee: J(-0.45, 1.4), lFoot: J(-0.7, 0), rKnee: J(0.55, 1.35), rFoot: J(0.75, 0),
  }, { face: 'yell' }),
  // The safe call: arms crossed in front…
  umpSafeIn: pose('front', {
    hip: J(0, 2.6), neck: J(0, 4.25), head: J(0, 4.9),
    lElbow: J(-0.6, 3.6), lHand: J(0.7, 3.9), rElbow: J(0.6, 3.7), rHand: J(-0.7, 4.0),
    lKnee: J(-0.7, 1.35), lFoot: J(-0.9, 0), rKnee: J(0.7, 1.35), rFoot: J(0.9, 0),
  }, { face: 'yell' }),
  // …then swept out wide.
  umpSafeOut: pose('front', {
    hip: J(0, 2.6), neck: J(0, 4.25), head: J(0, 4.9),
    lElbow: J(-1.45, 4.05), lHand: J(-2.5, 4.0), rElbow: J(1.45, 4.05), rHand: J(2.5, 4.0),
    lKnee: J(-0.75, 1.35), lFoot: J(-1.0, 0), rKnee: J(0.75, 1.35), rFoot: J(1.0, 0),
  }, { face: 'yell' }),
  // A fielder showing the umpire the ball in the glove.
  showBall: pose('front', {
    hip: J(0, 2.8), neck: J(0, 4.45), head: J(0, 5.1),
    lElbow: J(-1.0, 3.55), lHand: J(-1.0, 2.7), rElbow: J(1.2, 4.6), rHand: J(1.05, 5.6),
    lKnee: J(-0.45, 1.45), lFoot: J(-0.55, 0), rKnee: J(0.45, 1.45), rFoot: J(0.55, 0),
  }, { face: 'happy' }),
  // Shrugging, when the runner beat the throw (or there was none).
  shrug: pose('front', {
    hip: J(0, 2.85), neck: J(0, 4.4), head: J(0, 5.05),
    lElbow: J(-1.25, 3.7), lHand: J(-1.5, 4.25), rElbow: J(1.25, 3.7), rHand: J(1.5, 4.25),
    lKnee: J(-0.45, 1.45), lFoot: J(-0.5, 0), rKnee: J(0.45, 1.45), rFoot: J(0.5, 0),
  }, { face: 'oops' }),

  // Side on, facing right. The batter.
  stance: pose('side', {
    hip: J(0, 2.75), neck: J(-0.15, 4.4), head: J(-0.05, 5.05),
    lElbow: J(-0.2, 3.95), lHand: J(-0.45, 4.6), rElbow: J(-0.9, 4.15), rHand: J(-0.4, 4.5),
    lKnee: J(-0.75, 1.4), lFoot: J(-1.05, 0), rKnee: J(0.65, 1.4), rFoot: J(0.95, 0), batTip: J(-1.1, 6.7),
  }, { face: 'focus', look: J(1, 0) }),
  load: pose('side', {
    hip: J(-0.15, 2.7), neck: J(-0.35, 4.35), head: J(-0.2, 5.0),
    lElbow: J(-0.4, 3.95), lHand: J(-0.75, 4.65), rElbow: J(-1.15, 4.1), rHand: J(-0.7, 4.55),
    lKnee: J(-0.85, 1.35), lFoot: J(-1.1, 0), rKnee: J(0.5, 1.55), rFoot: J(0.7, 0.35), batTip: J(-1.6, 6.5),
  }, { face: 'focus', look: J(1, 0) }),
  swing: pose('side', {
    hip: J(0.15, 2.65), neck: J(0.25, 4.35), head: J(0.35, 5.0),
    lElbow: J(0.4, 3.6), lHand: J(0.9, 3.7), rElbow: J(0.5, 3.95), rHand: J(0.95, 3.65),
    lKnee: J(-0.55, 1.2), lFoot: J(-1.0, 0.05), rKnee: J(0.85, 1.35), rFoot: J(1.15, 0), batTip: J(3.3, 3.85),
  }, { face: 'yell', look: J(1, 0) }),
  followThrough: pose('side', {
    hip: J(0.2, 2.7), neck: J(0.1, 4.35), head: J(0.25, 5.0),
    lElbow: J(0.5, 4.3), lHand: J(-0.05, 4.55), rElbow: J(0.6, 4.0), rHand: J(0.05, 4.45),
    lKnee: J(-0.3, 1.35), lFoot: J(-0.75, 0.25), rKnee: J(0.85, 1.4), rFoot: J(1.15, 0), batTip: J(-1.6, 5.0),
  }, { face: 'happy', look: J(1, 0.3) }),

  // The pitcher, facing home (right).
  set: pose('side', {
    hip: J(0, 2.85), neck: J(0, 4.5), head: J(0.05, 5.15),
    lElbow: J(0.15, 3.45), lHand: J(0.45, 3.9), rElbow: J(0.1, 3.5), rHand: J(0.4, 3.95),
    lKnee: J(0.25, 1.45), lFoot: J(0.35, 0), rKnee: J(-0.2, 1.45), rFoot: J(-0.3, 0),
  }, { face: 'focus', look: J(1, 0) }),
  kick: pose('side', {
    hip: J(-0.1, 2.95), neck: J(-0.2, 4.6), head: J(-0.1, 5.25),
    lElbow: J(0.15, 3.75), lHand: J(0.35, 4.3), rElbow: J(0.05, 3.8), rHand: J(0.3, 4.35),
    lKnee: J(0.65, 2.85), lFoot: J(0.35, 1.65), rKnee: J(-0.1, 1.5), rFoot: J(-0.15, 0),
  }, { face: 'focus', look: J(1, 0) }),
  stride: pose('side', {
    hip: J(0.2, 2.55), neck: J(0.05, 4.2), head: J(0.2, 4.85),
    lElbow: J(0.95, 3.95), lHand: J(1.5, 4.2), rElbow: J(-0.9, 4.3), rHand: J(-1.55, 4.95),
    lKnee: J(1.2, 1.3), lFoot: J(1.65, 0), rKnee: J(-0.75, 1.25), rFoot: J(-1.5, 0.15),
  }, { face: 'yell', look: J(1, 0) }),
  release: pose('side', {
    hip: J(0.55, 2.45), neck: J(1.25, 3.95), head: J(1.6, 4.55),
    lElbow: J(1.0, 3.25), lHand: J(0.75, 3.6), rElbow: J(1.55, 4.65), rHand: J(2.3, 4.25),
    lKnee: J(1.4, 1.25), lFoot: J(1.75, 0), rKnee: J(-0.45, 1.4), rFoot: J(-1.2, 0.9),
  }, { face: 'yell', look: J(1, 0) }),
  pitchFollow: pose('side', {
    hip: J(0.75, 2.4), neck: J(1.5, 3.75), head: J(1.9, 4.25),
    lElbow: J(0.95, 3.05), lHand: J(0.7, 3.5), rElbow: J(1.55, 3.0), rHand: J(1.05, 2.25),
    lKnee: J(1.45, 1.25), lFoot: J(1.8, 0), rKnee: J(-0.15, 2.1), rFoot: J(-0.9, 2.35),
  }, { face: 'focus', look: J(1, 0) }),

  // A runner sliding feet first into the bag (facing right).
  slide: pose('side', {
    hip: J(0, 0.85), neck: J(-1.4, 1.85), head: J(-1.9, 2.4),
    lElbow: J(-1.95, 2.55), lHand: J(-1.65, 3.35), rElbow: J(-1.15, 2.65), rHand: J(-0.75, 3.4),
    lKnee: J(0.7, 1.15), lFoot: J(0.2, 0.25), rKnee: J(1.3, 0.55), rFoot: J(2.6, 0.3),
  }, { face: 'yell', look: J(1, 0.2) }),
};

/** How far in front of the feet the leading foot of a slide is (feet). */
export const SLIDE_REACH = 2.6;

/** A pose part of the way (`t`, 0–1) from one to another. */
export function blendPoses(a, b, t) {
  const k = Math.min(1, Math.max(0, t));
  const out = { view: k < 0.5 ? a.view : b.view, face: k < 0.5 ? a.face : b.face };
  for (const key of JOINTS) out[key] = J(a[key].x + (b[key].x - a[key].x) * k, a[key].y + (b[key].y - a[key].y) * k);
  for (const key of ['lift', 'turn']) out[key] = (a[key] ?? 0) + ((b[key] ?? 0) - (a[key] ?? 0)) * k;
  out.look = J((a.look?.x ?? 0) + ((b.look?.x ?? 0) - (a.look?.x ?? 0)) * k, (a.look?.y ?? 0) + ((b.look?.y ?? 0) - (a.look?.y ?? 0)) * k);
  if (a.batTip && b.batTip) out.batTip = J(a.batTip.x + (b.batTip.x - a.batTip.x) * k, a.batTip.y + (b.batTip.y - a.batTip.y) * k);
  else if (k < 0.5 ? a.batTip : b.batTip) out.batTip = (k < 0.5 ? a : b).batTip;
  return out;
}

/**
 * The pose at `t` through keyframes [{at, pose}] (sorted by `at`), eased
 * between each pair.
 */
export function keyframes(frames, t) {
  if (t <= frames[0].at) return frames[0].pose;
  for (let i = 1; i < frames.length; i++) {
    if (t <= frames[i].at) {
      const u = (t - frames[i - 1].at) / (frames[i].at - frames[i - 1].at);
      return blendPoses(frames[i - 1].pose, frames[i].pose, ease(u));
    }
  }
  return frames[frames.length - 1].pose;
}

export function ease(u) {
  const t = Math.min(1, Math.max(0, u));
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) ** 2;
}

// ---- Running ----------------------------------------------------------------

/** Feet covered in one full running cycle (two strides), and jogging. */
export const STRIDE = { run: 9, jog: 5 };

/** A periodic bump around `centre` (0–1), `width` wide. */
function bump(q, centre, width) {
  let d = Math.abs(q - centre) % 1;
  if (d > 0.5) d = 1 - d;
  return Math.exp(-((d / width) ** 2));
}

/**
 * Running (or jogging), side on, facing right, `phase` (0–1) of the way
 * through a cycle of two strides: the legs drive and kick up behind, the arms
 * pump bent at the elbow, the body leans in. The hips and everything above
 * them stay put; `lift` is the bounce, for whoever draws it to apply.
 * @returns {Pose}
 */
export function runPose(phase, { jog = false } = {}) {
  const amp = jog ? 0.6 : 1;
  const lean = jog ? 0.12 : 0.26;
  const hip = J(0, 2.7);
  const spine = J(Math.sin(lean), Math.cos(lean));
  const neck = J(hip.x + spine.x * 1.65, hip.y + spine.y * 1.65);
  const head = J(neck.x + spine.x * 0.6 + 0.12, neck.y + spine.y * 0.6);
  const shoulder = J(neck.x - spine.x * 0.25, neck.y - spine.y * 0.25);
  const leg = (q) => {
    const thigh = amp * 0.8 * Math.sin(TAU * q);
    const flex = 0.25 + amp * (1.55 * bump(q, 0.95, 0.17) + 0.75 * bump(q, 0.2, 0.15));
    const knee = J(hip.x + Math.sin(thigh) * BODY.thigh, hip.y - Math.cos(thigh) * BODY.thigh);
    const shin = thigh - flex;
    return { knee, foot: J(knee.x + Math.sin(shin) * BODY.shin, knee.y - Math.cos(shin) * BODY.shin) };
  };
  const arm = (q) => {
    const swing = -amp * 0.95 * Math.sin(TAU * q);
    const elbow = J(shoulder.x + Math.sin(swing) * BODY.upperArm, shoulder.y - Math.cos(swing) * BODY.upperArm);
    const fore = swing + 1.65;
    return { elbow, hand: J(elbow.x + Math.sin(fore) * BODY.forearm * 0.95, elbow.y - Math.cos(fore) * BODY.forearm * 0.95) };
  };
  const near = leg(phase);
  const far = leg(phase + 0.5);
  // Each arm swings against the leg on its side: back as the leg comes forward.
  const nearArm = arm(phase);
  const farArm = arm(phase + 0.5);
  return pose('side', {
    hip, neck, head,
    lElbow: farArm.elbow, lHand: farArm.hand, rElbow: nearArm.elbow, rHand: nearArm.hand,
    lKnee: far.knee, lFoot: far.foot, rKnee: near.knee, rFoot: near.foot,
  }, { face: 'focus', look: J(1, 0), lift: amp * 0.22 * Math.sin(TAU * phase) ** 2 });
}

// ---- Reaching for a throw ---------------------------------------------------

/**
 * Where the elbow and hand go for a hand reaching from `shoulder` to
 * `target`: two bones, bent outwards (towards `sign`) and down. Out of reach,
 * the cartoon arm stretches up to nearly half as long again, then the hand stops short.
 */
export function twoBone(shoulder, target, sign, a = BODY.upperArm, b = BODY.forearm) {
  let dx = target.x - shoulder.x;
  let dy = target.y - shoulder.y;
  const d = Math.hypot(dx, dy) || 1e-6;
  const stretch = Math.min(1.45, Math.max(1, d / (a + b)));
  const la = a * stretch;
  const lb = b * stretch;
  const reach = Math.min(d, la + lb - 1e-6);
  dx = (dx / d) * reach;
  dy = (dy / d) * reach;
  const hand = J(shoulder.x + dx, shoulder.y + dy);
  // The elbow: on the circle of the upper arm, by the law of cosines.
  const cosA = Math.min(1, Math.max(-1, (la * la + reach * reach - lb * lb) / (2 * la * reach)));
  const base = Math.atan2(dy, dx);
  const bend = Math.acos(cosA);
  const options = [base + bend, base - bend].map((angle) => J(shoulder.x + Math.cos(angle) * la, shoulder.y + Math.sin(angle) * la));
  // Outwards and down looks natural.
  const score = (e) => (e.x - shoulder.x) * sign - (e.y - shoulder.y) * 0.6;
  return { elbow: score(options[0]) >= score(options[1]) ? options[0] : options[1], hand };
}

/**
 * The covering fielder reaching for a throw at `target` (feet from between
 * their feet: across, and up), glove on the hand nearest it. Out wide they
 * step and lean; high, they jump; low, they scoop. With `dive`, they lay out
 * sideways for it (a throw they can't quite reach).
 * @param {Joint} target
 * @param {{dive?: boolean}} [options]
 * @returns {{pose: Pose, glove: 'l'|'r'}}
 */
export function reachPose(target, { dive = false } = {}) {
  const glove = target.x < 0 ? 'l' : 'r';
  const sign = glove === 'l' ? -1 : 1;
  if (dive) {
    // Laid out: a reach straight overhead, turned to lie along the ground.
    const { pose: up } = reachPose(J(sign * 0.4, 8.2));
    const turn = -sign * 1.25;
    return { pose: { ...up, turn, lift: 1.0, face: 'yell', look: J(sign, 0.3), lFoot: J(-0.35, 0.2), rFoot: J(0.35, 0.2) }, glove };
  }
  const low = Math.max(0, Math.min(1.9, 2.3 - target.y));
  // Low and wide, they lunge deeper; high and wide, they leap higher.
  const lean = Math.max(-0.9, Math.min(0.9, (target.x / 5.5) * 0.5 * (1 + low * 0.5)));
  const lift = Math.max(0, Math.min(3, target.y - 6.2 + Math.abs(target.x) * 0.25));
  // A wide one on the ground is a stretch: the trail foot stays on the bag and
  // the hips drop as the near foot strides out, so they go only as far as the
  // trail leg reaches.
  const wide = lift > 0 ? 0 : Math.min(1, Math.abs(target.x) / 5.5);
  const hipY = 2.6 - low * 0.75 - wide * 0.5 + lift;
  const trailX = -sign * BAG_FOOT;
  const legReach = BODY.thigh + BODY.shin - 0.15;
  const stretch = lift > 0 ? 2.4 : Math.sqrt(Math.max(0, legReach ** 2 - hipY ** 2)) - BAG_FOOT;
  const shift = Math.max(-stretch, Math.min(stretch, Math.max(-2.4, Math.min(2.4, target.x * (0.35 + low * 0.08)))));
  const hip = J(shift, hipY);
  const spine = J(Math.sin(lean), Math.cos(lean));
  const torso = 1.6 - low * 0.15;
  const neck = J(hip.x + spine.x * torso, hip.y + spine.y * torso);
  const head = J(neck.x + spine.x * 0.65, neck.y + spine.y * 0.65);
  const across = J(spine.y, -spine.x);
  const shoulder = (s) => J(neck.x + across.x * BODY.shoulderHalf * s - spine.x * 0.18, neck.y + across.y * BODY.shoulderHalf * s - spine.y * 0.18);
  const reach = twoBone(shoulder(sign), target, sign);
  // The other arm swings out for balance.
  const other = shoulder(-sign);
  const otherElbow = J(other.x - sign * 0.75, other.y - 0.75);
  const otherHand = J(other.x - sign * 1.1, other.y - 0.2 + lift * 0.2);
  let nearFoot;
  let farFoot;
  if (lift > 0) {
    // Straight up off the bag, feet tucked under, ready to come down on it.
    nearFoot = J(sign * 0.45 + shift * 0.6, lift + 0.15);
    farFoot = J(-sign * 0.35 + shift * 0.5, lift + 0.5);
  } else {
    nearFoot = J(sign * Math.max(1.0, Math.abs(shift) * 1.9 + 0.3), 0);
    farFoot = J(trailX, 0);
  }
  const knee = (foot, s) => {
    const leg = twoBone(J(hip.x + s * 0.35, hip.y), foot, s, BODY.thigh, BODY.shin);
    // Knees bend forward and out: towards us is out, so up is right.
    return leg.elbow.y < Math.min(hip.y, foot.y) ? J((hip.x + foot.x) / 2 + s * 0.4, (hip.y + foot.y) / 2) : leg.elbow;
  };
  const p = pose('front', {
    hip, neck, head,
    lElbow: sign < 0 ? reach.elbow : otherElbow, lHand: sign < 0 ? reach.hand : otherHand,
    rElbow: sign > 0 ? reach.elbow : otherElbow, rHand: sign > 0 ? reach.hand : otherHand,
    lFoot: sign < 0 ? nearFoot : farFoot, rFoot: sign > 0 ? nearFoot : farFoot,
  }, { face: 'yell', look: J(Math.max(-1, Math.min(1, (target.x - head.x) / 3)), Math.max(-1, Math.min(1, (target.y - head.y) / 3))) });
  p.lKnee = knee(p.lFoot, -1);
  p.rKnee = knee(p.rFoot, 1);
  return { pose: p, glove };
}

/**
 * The covering fielder back on the ground after a jump for a throw at
 * `target`: the trail foot on the bag, the glove pulled in to the chest.
 * @param {Joint} target
 * @returns {{pose: Pose, glove: 'l'|'r'}}
 */
export function landPose(target) {
  const side = Math.max(-1, Math.min(1, target.x / 3));
  const x = (target.x < 0 ? -1 : 1) * Math.max(0.6, Math.abs(side) * 1.2);
  return reachPose(J(x, 4.4));
}

/** Where the gloved hand is in a pose, turned and lifted as it will be drawn. */
export function handAt(p, glove) {
  return placed(p, glove === 'l' ? p.lHand : p.rHand);
}

/** A joint moved as the pose is drawn: turned about the feet, then lifted. */
export function placed(p, j) {
  const c = Math.cos(p.turn ?? 0);
  const s = Math.sin(p.turn ?? 0);
  return J(j.x * c - j.y * s, j.x * s + j.y * c + (p.lift ?? 0));
}

// ---- Who is who ---------------------------------------------------------------

/**
 * @typedef {object} Player someone to draw (see playerShapes in fielders-choice-models.js)
 * @property {Pose} pose
 * @property {'home'|'away'|'umpire'} team
 * @property {number} [number] on the jersey
 * @property {number} [skin] which skin tone
 * @property {'l'|'r'|null} [glove] the hand wearing a glove
 * @property {boolean} [holdsBall] a ball in the glove
 * @property {boolean} [helmet] a batting helmet rather than a cap
 * @property {boolean} [mask] a catcher's or umpire's mask
 */
