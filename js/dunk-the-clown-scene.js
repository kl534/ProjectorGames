// Dunk the Clown's 3D scene, kept free of the browser so it can be unit-tested:
// the booth, the tanks, the clowns, the bullseyes, the splashes. It keeps what
// is happening (a clown rising, a clown falling in) and says what to draw; the
// WebGL renderer (dunk-the-clown-gl.js) draws it.
//
// The picture must stay perfectly still unless the game has told the camera it
// is about to change, so `step` says whether anything has changed since the last
// picture, and the game draws only then.
//
// Each seat has a bullseye on the plane z = 0, exactly where the rules say (see
// the camera in dunk-the-clown-models.js). The clown sits on a seat over a tank
// behind it, and is placed so he looks right above his bullseye.

import { seats as ruleSeats } from './dunk-the-clown-logic.js';
import {
  MOTION, anchor, chain, dropAt, dropLandsAt, easeOutBack, fall, limb, makeCamera, multiply, rotationX, rotationZ,
  scaleAt, scaling, seededRandom, splashDrops, timeToWater, translation,
} from './dunk-the-clown-models.js';

/** @typedef {{mesh: string, m: Float32Array, colour: number[], alpha?: number, shine?: number, glow?: number, tex?: string, layer?: number}} Drawable */

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const COLOURS = {
  wallA: hex('#1d3a52'), wallB: hex('#25506d'), counter: hex('#7a4c28'), counterSeam: hex('#3a2410'),
  awningA: hex('#a3262e'), awningB: hex('#d89b2b'), wood: hex('#8a5a2e'), woodDark: hex('#3a2410'),
  tankBack: hex('#17496d'), glass: hex('#9fd0ee'), water: hex('#2a82bf'), ripple: hex('#9fd8ff'), drop: hex('#a9dcff'),
  purple: hex('#7b3fb8'), orange: hex('#f08a24'), yellow: hex('#f2c230'), skin: hex('#e3a76f'), red: hex('#d62f2f'),
  blue: hex('#2f74d6'), blueDark: hex('#1f4f9a'), hair: hex('#e8541e'), dark: hex('#2a1540'), mouth: hex('#a52424'),
  ink: hex('#1a1a1a'), gold: hex('#e8a800'), bull: hex('#e8392e'), bulb: hex('#ffd98a'), splat: hex('#f6e7a0'),
};
const FLAGS = [COLOURS.red, COLOURS.blue, COLOURS.gold, hex('#3aa05a')];

// Depths (z), from the wall to the player.
const WALL_Z = -1.3;
const TANK_FRONT_Z = -0.25;
const TANK_BACK_Z = -0.9;
const SEAT_Z = (TANK_FRONT_Z + TANK_BACK_Z) / 2; // the clown sits over the middle of the tank
const BOARD_Z = 0; // the bullseye boards stand on the plane the rules use
const START_Z = 0.35; // the big Start target stands in front of everything

// Where things are, measured from the middle of a bullseye in bullseye radii (up is
// negative, as on the screen), so the booth fits any shape of screen: the top of the
// seat, the tank's rim, its water, and its bottom. Heights are those at the seat's depth.
const PLANK_AT = -1.2;
const RIM_AT = -0.35;
const WATER_AT = 0.5;
const FLOOR_AT = 1.85;
const PLANK_THICK = 0.025;
const AWNING_LIP_SY = 0.06;

// The pieces of a bullseye board (radius 1, front at z = 0), as radius, how far its front is
// in front of the rim's, and colour: dark ring, blue, dark, gold, dark, red.
const BOARD_LAYERS = [
  { radius: 1.06, front: 0, thick: 0.22, colour: COLOURS.ink },
  { radius: 1.0, front: 0.03, thick: 0.1, colour: COLOURS.blue },
  { radius: 0.685, front: 0.06, thick: 0.1, colour: COLOURS.ink },
  { radius: 0.667, front: 0.08, thick: 0.1, colour: COLOURS.gold },
  { radius: 0.35, front: 0.11, thick: 0.1, colour: COLOURS.ink },
  { radius: 0.333, front: 0.13, thick: 0.1, colour: COLOURS.bull },
];

const CLOWN_SCALE = 0.88;
const SEAT_LOCAL_Y = 1.2; // where he tips about, above the plank's top, in radii

export const SCENE_MS = {
  rise: 350, // a clown climbing up
  dunk: 1400, // a clown falling in, and the splash
  leave: 450, // a clown climbing down
  burst: 350, // the Start target being hit
  splat: 1200, // the mark left by a miss
};

/** The drawing of a clown, in bullseye radii, standing on the origin (the top of his plank). */
function clownParts(armAngles) {
  const parts = [];
  const add = (mesh, m, colour, shine = 0.2) => parts.push({ mesh, m, colour, shine });
  const ball = (c, s, colour, shine) => add('sphere', multiply(translation(...c), scaling(...s)), colour, shine);
  for (const side of [-1, 1]) {
    const hip = [side * 0.42, 0.45, 0.1];
    const knee = [side * 0.5, 0.75, 1.0];
    const ankle = [side * 0.5, 0.15, 1.2];
    add('cylinder', limb(hip, knee, 0.3), COLOURS.orange);
    ball(knee, [0.31, 0.31, 0.31], COLOURS.orange);
    add('cylinder', limb(knee, ankle, 0.26), COLOURS.orange);
    ball([side * 0.5, 0.02, 1.42], [0.34, 0.2, 0.62], COLOURS.red, 0.5);
  }
  const body = [0, 1.2, 0];
  const radii = [0.86, 0.9, 0.72];
  ball(body, radii, COLOURS.purple, 0.3);
  for (const d of [[-0.5, 0.35, 0.8], [0.45, 0.6, 0.65], [0.1, -0.1, 1], [-0.6, -0.3, 0.7], [0.65, -0.2, 0.6], [-0.15, 0.8, 0.6], [0.3, -0.6, 0.7]]) {
    const len = Math.hypot(...d);
    ball(d.map((v, i) => body[i] + (v / len) * radii[i] * 0.97), [0.15, 0.15, 0.15], COLOURS.orange, 0.3);
  }
  ball([0, 2.0, 0], [0.64, 0.2, 0.62], COLOURS.yellow);
  ball([0, 2.62, 0.02], [0.58, 0.6, 0.56], COLOURS.skin, 0.35);
  ball([-0.6, 2.72, 0], [0.3, 0.3, 0.3], COLOURS.hair);
  ball([0.6, 2.72, 0], [0.3, 0.3, 0.3], COLOURS.hair);
  ball([0, 2.56, 0.56], [0.17, 0.17, 0.17], COLOURS.red, 0.7);
  ball([-0.21, 2.78, 0.5], [0.08, 0.1, 0.05], COLOURS.dark);
  ball([0.21, 2.78, 0.5], [0.08, 0.1, 0.05], COLOURS.dark);
  ball([0, 2.32, 0.5], [0.28, 0.09, 0.06], COLOURS.mouth);
  add('cone', multiply(translation(0, 3.5, 0), scaling(0.5, 1, 0.5)), COLOURS.blue, 0.4);
  add('cylinder', multiply(translation(0, 3.02, 0), scaling(0.62, 0.07, 0.62)), COLOURS.blueDark);
  ball([0, 4.05, 0], [0.13, 0.13, 0.13], COLOURS.red, 0.5);
  // Arms hang from the shoulders: 0 is straight down, pi straight up.
  [-1, 1].forEach((side, i) => {
    const shoulder = [side * 0.78, 1.75, 0];
    const angle = armAngles[i];
    const along = (d) => [shoulder[0] + d * Math.sin(angle), shoulder[1] - d * Math.cos(angle), 0];
    add('cylinder', limb(shoulder, along(0.95), 0.24), COLOURS.purple, 0.25);
    ball(along(1.0), [0.22, 0.22, 0.22], COLOURS.yellow, 0.3);
  });
  return parts;
}

/** A bullseye board's drawing: radius 1, front on z = 0. */
export function boardParts() {
  const turn = rotationX(Math.PI / 2); // cylinders stand on Y; the board faces +Z
  return BOARD_LAYERS.map(({ radius, front, thick, colour }) => ({
    mesh: 'cylinder',
    m: chain(translation(0, 0, front - thick / 2), turn, scaling(radius, thick, radius)),
    colour,
    shine: 0.35,
  }));
}

export class ClownScene {
  /**
   * @param {{width: number, height: number}} view screen size in pixels
   * @param {import('./dunk-the-clown-logic.js').Seat[]} [seatList]
   */
  constructor(view, seatList = ruleSeats()) {
    this.seatList = seatList;
    this.armsAt = clownParts([0.55, 0.55]);
    this.board = boardParts();
    this.reset();
    this.resize(view);
  }

  /** The screen has changed size: lay everything out again. */
  resize(view) {
    this.view = view;
    this.camera = makeCamera(view);
    const { camera } = this;
    const at = (x, y, z) => anchor(camera, x, y, z);
    const kSeat = scaleAt(SEAT_Z);
    this.seatsLayout = this.seatList.map((seat) => {
      // A bullseye radius as a fraction of the screen's height.
      const rh = (seat.r * Math.min(view.width, view.height)) / view.height;
      const plank = at(seat.x, seat.y + PLANK_AT * rh, SEAT_Z);
      const rs = seat.r * plank.scale; // one bullseye radius, there
      const rimY = at(seat.x, seat.y + RIM_AT * rh, SEAT_Z).position[1];
      const waterY = at(seat.x, seat.y + WATER_AT * rh, SEAT_Z).position[1];
      const floorY = at(seat.x, seat.y + FLOOR_AT * rh, SEAT_Z).position[1];
      const board = at(seat.x, seat.y, BOARD_Z);
      // Tanks are as wide as the seats are far apart, up to a limit.
      const spacing = this.seatList.length > 1 ? Math.abs(this.seatList[1].x - this.seatList[0].x) * camera.width : 1;
      const width = Math.min(3.3 * rs, (spacing / kSeat) * 0.95);
      return {
        x: plank.position[0], plankY: plank.position[1], rs, rimY, waterY, floorY, width,
        board: { x: board.position[0], y: board.position[1], r: seat.r },
        // In radii, from the top of the plank, for the clown's fall.
        tank: { water: (waterY - plank.position[1]) / rs, floor: (floorY - plank.position[1]) / rs },
      };
    });
    const built = this.buildStatic();
    this.staticOpaque = built.filter((d) => (d.alpha ?? 1) >= 1);
    this.staticTranslucent = built.filter((d) => (d.alpha ?? 1) < 1);
    this.dirty = true;
  }

  reset() {
    this.seatStates = this.seatList.map(() => ({ phase: 'empty', since: 0, splashed: false }));
    this.drops = []; // flying drops: {drop, seat, born}
    this.ripples = []; // {seat, born}
    this.splats = []; // {x, y, born}
    this.start = null; // {x, y, r, label, born, hit: number|null}
    this.dirty = true;
  }

  // ---- What is happening ----

  raise(index, now) {
    this.seatStates[index] = { phase: 'rising', since: now, splashed: false };
  }

  dunk(index, now) {
    this.seatStates[index] = { phase: 'falling', since: now, splashed: false };
  }

  leave(index, now) {
    this.seatStates[index] = { phase: 'leaving', since: now, splashed: false };
  }

  splat(point, now) {
    this.splats.push({ ...point, born: now });
  }

  showStart(target, label, now) {
    this.start = { ...target, label, born: now, hit: null };
    this.dirty = true;
  }

  hitStart(now) {
    if (this.start) this.start.hit = now;
  }

  /** How long ago, in seconds. */
  static age(now, born) {
    return Math.max(0, (now - born) / 1000);
  }

  /**
   * Moves everything on to `now`.
   * @returns {boolean} true if the picture needs drawing again
   */
  step(now) {
    let active = this.dirty;
    this.dirty = false;
    this.seatStates.forEach((state, i) => {
      const age = now - state.since;
      if (state.phase === 'rising' && age >= SCENE_MS.rise) {
        state.phase = 'sitting';
        active = true;
      } else if (state.phase === 'leaving' && age >= SCENE_MS.leave) {
        state.phase = 'empty';
        active = true;
      } else if (state.phase === 'falling') {
        if (age >= SCENE_MS.dunk) {
          state.phase = 'empty';
          active = true;
        } else if (!state.splashed) {
          const hitAt = timeToWater(this.seatsLayout[i].tank.water) * 1000;
          if (age >= hitAt) {
            state.splashed = true;
            this.splash(i, state.since + hitAt);
          }
        }
      }
      if (state.phase === 'rising' || state.phase === 'falling' || state.phase === 'leaving') active = true;
    });
    this.drops = this.drops.filter((d) => ClownScene.age(now, d.born) < dropLandsAt(d.drop));
    this.ripples = this.ripples.filter((r) => ClownScene.age(now, r.born) < 0.9);
    const before = this.splats.length;
    this.splats = this.splats.filter((s) => now - s.born < SCENE_MS.splat);
    if (this.drops.length || this.ripples.length || this.splats.length || before) active = true;
    if (this.start && this.start.hit !== null) {
      if (now - this.start.hit >= SCENE_MS.burst) this.start = null;
      active = true;
    }
    return active;
  }

  splash(index, born) {
    const random = seededRandom(Math.floor(born) + index * 7919);
    for (const drop of splashDrops(random)) this.drops.push({ drop, seat: index, born });
    [0, 0.13, 0.26].forEach((delay) => this.ripples.push({ seat: index, born: born + delay * 1000 }));
  }

  // ---- Where things are ----

  // ---- The picture ----

  /**
   * Everything to draw, split by how it must be drawn.
   * @returns {{opaque: Drawable[], translucent: Drawable[], overlay: Drawable[], label: string, camera: object}}
   */
  frame(now) {
    const opaque = [...this.staticOpaque];
    const translucent = [...this.staticTranslucent];
    const overlay = [];
    this.seatsLayout.forEach((seat, i) => this.addSeat(i, seat, this.seatStates[i], now, opaque, translucent));
    this.addDrops(now, translucent);
    for (const splat of this.splats) this.addSplat(splat, now, overlay);
    if (this.start) this.addStart(this.start, now, opaque, translucent);
    return { opaque, translucent, overlay, label: this.start?.label ?? '', camera: this.camera };
  }

  addSeat(index, seat, state, now, opaque, translucent) {
    const age = ClownScene.age(now, state.since);
    const { rs } = seat;
    // The seat itself: a plank hinged at its back edge, which swings open under a falling clown.
    const open = state.phase === 'falling'
      ? Math.min(1.45, age * 14) * Math.min(1, Math.max(0, (MOTION.fadeStartS + MOTION.fadeS - age) / 0.3))
      : 0;
    const depth = 0.5;
    const hingeZ = SEAT_Z - depth / 2;
    opaque.push({
      mesh: 'box',
      m: chain(
        translation(seat.x, seat.plankY - PLANK_THICK / 2, hingeZ),
        rotationX(open),
        translation(0, 0, depth / 2),
        scaling(3.2 * rs, PLANK_THICK, depth),
      ),
      colour: COLOURS.wood,
      shine: 0.15,
    });

    // The water, which sloshes when a clown has gone in.
    const slosh = state.phase === 'falling' && state.splashed
      ? rs * 0.22 * Math.exp(-4 * (age - timeToWater(seat.tank.water))) * Math.sin(16 * (age - timeToWater(seat.tank.water)))
      : 0;
    const top = seat.waterY + slosh;
    const depthTank = TANK_FRONT_Z - TANK_BACK_Z;
    translucent.push({
      mesh: 'box',
      m: chain(
        translation(seat.x, (top + seat.floorY) / 2, SEAT_Z),
        scaling(seat.width - 0.02, top - seat.floorY, depthTank - 0.02),
      ),
      colour: COLOURS.water,
      alpha: 0.55,
      shine: 0.7,
      layer: 0,
    });
    for (const ripple of this.ripples.filter((r) => r.seat === index)) {
      const t = ClownScene.age(now, ripple.born);
      if (t <= 0) continue;
      const radius = Math.min(1.4 * rs, (0.35 + 3.4 * t) * rs);
      translucent.push({
        mesh: 'torus',
        m: chain(translation(seat.x, top + 0.004, SEAT_Z), scaling(radius, rs * 0.5, radius * 0.9)),
        colour: COLOURS.ripple,
        alpha: 0.7 * (1 - t / 0.9),
        shine: 0.5,
        layer: 2,
      });
    }

    if (state.phase === 'empty') return;

    // The bullseye board and the clown.
    const popping = state.phase === 'rising' ? age / (SCENE_MS.rise / 1000) : state.phase === 'leaving' ? 1 - age / (SCENE_MS.leave / 1000) : 1;
    const pop = state.phase === 'rising' ? easeOutBack(popping) : Math.max(0, popping);
    const alphaIn = Math.min(1, Math.max(0, popping) * 3);

    const flip = state.phase === 'falling' ? Math.min(1.5, age * 12) : 0;
    const boardScale = state.phase === 'falling' ? 1 : Math.max(0.01, pop);
    const { board } = seat;
    const boardMatrix = chain(
      translation(board.x, board.y - board.r, BOARD_Z),
      rotationX(flip),
      translation(0, board.r * boardScale, 0),
      scaling(board.r * boardScale),
    );
    // A target that has been hit folds down and is gone a moment later.
    const boardAlpha = state.phase === 'falling' ? Math.max(0, 1 - Math.max(0, age - 0.2) / 0.2) : alphaIn;
    if (boardAlpha > 0) this.pushParts(this.board, boardMatrix, boardAlpha, opaque, translucent, 1);

    const pose = state.phase === 'falling' ? fall(age, seat.tank) : null;
    const y = pose ? pose.y : 0;
    const tilt = pose ? pose.tilt : 0;
    const topple = pose ? pose.topple : 0;
    const flail = pose ? pose.flail : 0;
    const wave = pose ? Math.sin(age * 22) * 0.4 * flail : 0;
    const arms = [-(0.55 + flail * 2.1 + wave), 0.55 + flail * 2.1 - wave];
    const scale = rs * CLOWN_SCALE * (state.phase === 'falling' ? 1 : Math.max(0.01, 0.3 + 0.7 * pop));
    const pivot = SEAT_LOCAL_Y * rs * CLOWN_SCALE;
    const root = chain(
      translation(seat.x, seat.plankY + y * rs, SEAT_Z),
      translation(0, pivot, 0),
      rotationX(topple),
      rotationZ(tilt),
      translation(0, -pivot, 0),
      scaling(scale),
    );
    const parts = state.phase === 'falling' ? clownParts(arms) : this.armsAt;
    this.pushParts(parts, root, pose ? pose.alpha : alphaIn, opaque, translucent, -1);
  }

  /** A shape made of parts, moved by `root`, into the opaque or the translucent list. */
  pushParts(parts, root, alpha, opaque, translucent, layer) {
    for (const part of parts) {
      const drawable = { mesh: part.mesh, m: multiply(root, part.m), colour: part.colour, shine: part.shine };
      if (alpha < 1) {
        translucent.push({ ...drawable, alpha, layer });
      } else {
        opaque.push(drawable);
      }
    }
  }

  addDrops(now, translucent) {
    for (const { drop, seat, born } of this.drops) {
      const layout = this.seatsLayout[seat];
      const t = ClownScene.age(now, born);
      const [x, y, z] = dropAt(drop, t);
      const limit = layout.width / 2 - 0.02;
      const half = (TANK_FRONT_Z - TANK_BACK_Z) / 2 - 0.02;
      translucent.push({
        mesh: 'sphere',
        m: chain(
          translation(
            layout.x + Math.max(-limit, Math.min(limit, x * layout.rs)),
            layout.waterY + y * layout.rs,
            SEAT_Z + Math.max(-half, Math.min(half, z * layout.rs)),
          ),
          scaling(drop.size * layout.rs),
        ),
        colour: COLOURS.drop,
        alpha: 0.85,
        shine: 0.9,
        layer: 3,
      });
    }
  }

  addSplat(splat, now, overlay) {
    const t = (now - splat.born) / SCENE_MS.splat;
    const spot = anchor(this.camera, splat.x, splat.y, 0.05);
    const size = 0.035 * (0.5 + Math.min(1, t * 5) * 0.5);
    overlay.push({
      mesh: 'sphere',
      m: chain(translation(...spot.position), scaling(size, size, size * 0.3)),
      colour: COLOURS.splat,
      alpha: 0.9 * (1 - t) ** 1.5,
      shine: 0.5,
    });
  }

  addStart(start, now, opaque, translucent) {
    const spot = anchor(this.camera, start.x, start.y, START_Z);
    const burst = start.hit === null ? 0 : Math.min(1, (now - start.hit) / SCENE_MS.burst);
    const r = start.r * spot.scale * (1 + 0.5 * burst);
    const root = chain(translation(...spot.position), scaling(r));
    this.pushParts(this.board, root, 1 - burst, opaque, translucent, 5);
    const label = {
      mesh: 'quad',
      m: chain(translation(spot.position[0], spot.position[1], spot.position[2] + r * 0.16), scaling(r * 1.7, r * 0.85, 1)),
      colour: [1, 1, 1],
      alpha: 1 - burst,
      tex: 'label',
      layer: 6,
    };
    translucent.push(label);
  }

  // ---- The booth ----

  buildStatic() {
    const parts = [];
    const { camera } = this;
    const at = (x, y, z) => anchor(camera, x, y, z);
    const box = (centre, size, colour, extra = {}) => {
      parts.push({ mesh: 'box', m: chain(translation(...centre), scaling(...size)), colour, shine: 0.1, ...extra });
    };
    const farX = camera.width * 2.4;

    // The back wall, in alternating stripes.
    const wallScale = 1 / scaleAt(WALL_Z);
    const wallHeight = camera.height * wallScale * 1.6;
    const stripes = 28;
    for (let i = 0; i < stripes; i++) {
      const w = farX / stripes;
      box([-farX / 2 + w * (i + 0.5), 0, WALL_Z], [w, wallHeight, 0.1], i % 2 ? COLOURS.wallA : COLOURS.wallB, { shine: 0.05 });
    }

    // The awning: slanted stripes from the back to a lip along the top of the screen.
    const front = at(0.5, AWNING_LIP_SY, 0.3).position;
    const back = at(0.5, -0.12, -1.25).position;
    const dz = front[2] - back[2];
    const dy = front[1] - back[1];
    const length = Math.hypot(dz, dy);
    const tilt = Math.atan2(-dy, dz);
    const awningStripes = 24;
    const stripeW = farX / awningStripes;
    for (let i = 0; i < awningStripes; i++) {
      const colour = i % 2 ? COLOURS.awningA : COLOURS.awningB;
      const x = -farX / 2 + stripeW * (i + 0.5);
      parts.push({
        mesh: 'box',
        m: chain(translation(x, (front[1] + back[1]) / 2, (front[2] + back[2]) / 2), rotationX(tilt), scaling(stripeW, 0.03, length)),
        colour,
        shine: 0.1,
      });
      // The valance hanging from the lip, with a rounded bottom.
      box([x, front[1] - 0.03, front[2]], [stripeW, 0.06, 0.03], colour);
      parts.push({ mesh: 'sphere', m: chain(translation(x, front[1] - 0.06, front[2]), scaling(stripeW / 2, 0.035, 0.03)), colour, shine: 0.1 });
    }
    // Bulbs along the lip, and little flags hanging in a curve under it.
    const bulbs = 18;
    for (let i = 0; i < bulbs; i++) {
      const sx = (i + 0.5) / bulbs;
      const p = at(sx, AWNING_LIP_SY + 0.085, 0.32);
      parts.push({ mesh: 'sphere', m: chain(translation(...p.position), scaling(0.016 * p.scale)), colour: COLOURS.bulb, glow: 0.9, shine: 0.9 });
    }
    const flags = 22;
    for (let i = 0; i < flags; i++) {
      const sx = (i + 0.5) / flags;
      const sag = 0.05 * Math.sin(sx * Math.PI * 4);
      const p = at(sx, 0.2 + sag, -0.4);
      parts.push({
        mesh: 'cone',
        m: chain(translation(p.position[0], p.position[1], p.position[2]), rotationX(Math.PI), scaling(0.035 * p.scale, 0.07 * p.scale, 0.012)),
        colour: FLAGS[i % 4],
        shine: 0.1,
      });
    }

    // The counter the tanks stand on: a slab with plank seams, seen from above.
    const counterTop = this.seatsLayout[0].floorY;
    const counterDepth = 2.2;
    const counterZ = -1.0 + counterDepth / 2;
    box([0, counterTop - 0.2, counterZ], [farX, 0.4, counterDepth], COLOURS.counter, { shine: 0.1 });
    for (let z = -0.95; z < 1.0; z += 0.16) box([0, counterTop + 0.001, z], [farX, 0.003, 0.012], COLOURS.counterSeam, { shine: 0 });

    // A tank and a pedestal for each bullseye.
    this.seatsLayout.forEach((seat) => {
      const depth = TANK_FRONT_Z - TANK_BACK_Z;
      const height = seat.rimY - seat.floorY;
      const wood = COLOURS.woodDark;
      box([seat.x, seat.floorY + 0.01, SEAT_Z], [seat.width, 0.02, depth], wood);
      box([seat.x, (seat.rimY + seat.floorY) / 2, TANK_BACK_Z + 0.005], [seat.width, height, 0.01], COLOURS.tankBack, { shine: 0.2 });
      // Rim.
      box([seat.x, seat.rimY, TANK_FRONT_Z], [seat.width + 0.02, 0.02, 0.025], wood);
      box([seat.x, seat.rimY, TANK_BACK_Z], [seat.width + 0.02, 0.02, 0.025], wood);
      for (const side of [-1, 1]) {
        box([seat.x + side * seat.width / 2, seat.rimY, SEAT_Z], [0.02, 0.02, depth], wood);
        // Glass sides and the posts the seat stands on.
        parts.push({
          mesh: 'box',
          m: chain(translation(seat.x + side * (seat.width / 2 - 0.004), (seat.rimY + seat.floorY) / 2, SEAT_Z), scaling(0.006, height, depth)),
          colour: COLOURS.glass, alpha: 0.2, shine: 0.8, layer: 1,
        });
        box([seat.x + side * seat.width * 0.45, (seat.plankY + seat.rimY) / 2, SEAT_Z], [0.02 * seat.rs / 0.1, seat.plankY - seat.rimY + 0.05, 0.04], wood);
      }
      parts.push({
        mesh: 'box',
        m: chain(translation(seat.x, (seat.rimY + seat.floorY) / 2, TANK_FRONT_Z - 0.004), scaling(seat.width, height, 0.006)),
        colour: COLOURS.glass, alpha: 0.12, shine: 0.8, layer: 1,
      });
      // The bullseye's pole and base.
      const poleTop = seat.board.y - seat.board.r;
      parts.push({
        mesh: 'cylinder',
        m: chain(translation(seat.board.x, (poleTop + counterTop) / 2, BOARD_Z - 0.03), scaling(0.014, poleTop - counterTop, 0.014)),
        colour: COLOURS.woodDark, shine: 0.2,
      });
      parts.push({
        mesh: 'cylinder',
        m: chain(translation(seat.board.x, counterTop + 0.01, BOARD_Z - 0.03), scaling(0.07, 0.02, 0.07)),
        colour: COLOURS.woodDark, shine: 0.2,
      });
    });
    return parts;
  }
}
