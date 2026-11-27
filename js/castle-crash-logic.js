// Castle Crash rules, kept free of the browser so they can be unit tested: the
// forts (wood, ice, stone and TNT, with goblins on them), the view from just
// behind the players, the boulder a throw becomes, what a boulder does to what
// it hits, TNT blasts, points, and a whole shot worked out in advance
// (`playShot`) as poses the game plays back, with what broke and when.
//
// The world is in metres: x across (right), y up (the ground is y = 0), z away
// from the players into the picture. The camera stands behind the players,
// `camera.eyeY` up, looking a little down the field; the forts stand 13–18 m
// away, facing it. A fort is one or more walls (`layers`), each a row of pieces
// standing in the plane z = its `z` (its front face) and `depth` deep. Each wall
// is its own world in castle-crash-physics.js, in x and y: within a wall, things
// fall, tip, slide and tumble as real ones would.
//
// A throw is a boulder thrown from where the players stand. Whatever is on the
// screen where the ball hit is what it hits: it arcs from the bottom of the
// screen to arrive there, as fast as the ball was thrown if that was measured.
// It strikes the front of the piece: the knock into the fort (`impact`) wears
// the piece's health down, and if it is left standing but the knock is more
// than it and what it holds up can resist (`impact.knock`), it is knocked out of
// the wall backwards, tumbling away (a flyer) into whatever stands behind it,
// while what it held up falls. Within a wall, every knock beyond a little
// (`damageFloor`; a load resting on a piece is no knock) wears health down too.
// At none a piece breaks (a goblin is beaten), and TNT blows up, throwing and
// hurting everything near it, in front and behind as well. A goblin knocked out
// of its wall or off the field is beaten too, and so is one knocked off its
// perch (`goblinFall` below where it sat, landed) or bowled along (`goblinShove`
// from where it sat). Beat every goblin before the boulders run out.
//
// More boulders can be thrown while a shot is still playing out: `playShot`
// takes several, each with the moment it is thrown (`atMs`), and runs them all
// in one world. The game keeps the fort as it was before the first, and works
// the whole thing out again from there with the new boulder added; nothing in
// it is random, so up to the new throw it plays exactly as before.

import {
  addBody, applyImpulse, collide, createWorld, isAwake, removeBody, sleepAll, step, PHYSICS,
} from './castle-crash-physics.js';

/**
 * @typedef {import('./castle-crash-physics.js').Body} Body
 * @typedef {import('./castle-crash-physics.js').World} World
 * @typedef {'wood'|'ice'|'stone'|'tnt'} Material
 * @typedef {'goblin'|'helmet'|'king'} GoblinKind
 * @typedef {{type: 'box', material: Material, x: number, y: number, w: number, h: number}
 *   | {type: 'goblin', kind: GoblinKind, x: number, y: number}} Piece a piece of a wall: x its centre, y its bottom
 * @typedef {{z: number, pieces: Piece[]}} LayerPlan a wall: the depth of its front face, and its pieces
 * @typedef {{n: number, name: string, boulders: number, layers: LayerPlan[]}} Level
 * @typedef {{z: number, depth: number, world: World}} Layer
 * @typedef {{body: Body, x: number, y: number, z: number, a: number, tilt: number, health: number}} Pose
 *   where a body is: its centre, its turn in the wall's plane (`a`) and back out of it (`tilt`), its health 0–1
 * @typedef {{x0: number, x1: number, z0: number, z1: number}} Pad the trodden ground a wall stands on
 * @typedef {{layers: Layer[], rubble: Pose[], pads: Pad[]}} Fort
 * @typedef {object} View screen size in pixels, and the camera: focal length `f` (pixels), centre, eye height, pitch
 * @property {number} width
 * @property {number} height
 * @property {number} f
 * @property {number} cx
 * @property {number} cy
 * @property {number} eyeY
 * @property {number} pitch radians, looking down
 * @typedef {object} Shot a boulder on its way
 * @property {{x:number, y:number, z:number}} from where it is thrown from
 * @property {{x:number, y:number, z:number}} to the spot it is aimed at (what the ball hit on the screen)
 * @property {number} vx
 * @property {number} vy
 * @property {number} vz its velocity leaving `from`
 * @property {number} speed metres a second
 * @property {number} flightMs how long it takes to reach `to`
 * @typedef {{shot: Shot, atMs: number}} Throw a boulder thrown `atMs` into a play
 * @typedef {object} PlayEvent
 * @property {number} ms when, from the start of the shot
 * @property {'break'|'goblin'|'knock'|'boom'|'gone'|'shatter'|'poof'} type
 * @property {number} id the body's
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} points
 * @property {number} [push] how fast its pieces fly back (metres a second, into the picture)
 * @typedef {object} Play a shot worked out to its end
 * @property {Map<number, Body>} bodies every body that was in it, by id, including the boulder
 * @property {Float32Array[]} frames poses every `frameMs`: id, x, y, z, a, tilt, health for each body there
 * @property {number} frameMs
 * @property {PlayEvent[]} events in time order
 * @property {number} endMs when everything has come to rest (or been stopped)
 * @property {number} points scored
 * @property {number} goblinsLeft
 * @property {number} boulderId the first boulder's id (each one after it is one more)
 * @property {number[]} boulderIds every boulder's, in the order they were thrown
 */

export const CASTLE_CRASH_RULES = {
  gravity: 12,
  // The camera, behind the players: eye height (m), how far it looks down, and how wide it sees
  // (degrees). It sees at least `minVfovDeg` up and down, so on a very wide screen it sees wider.
  camera: { eyeY: 3.5, pitchDeg: 4, hfovDeg: 62, minVfovDeg: 37 },
  // Where a boulder is thrown from: the players, low and just in front of the camera.
  throwFrom: { x: 0, y: 1.2, z: 0.5 },
  // The boulder is drawn once it is `shownFrom` in front of the camera (m): nearer, it would fill the screen.
  boulder: { r: 0.42, density: 5, shownFrom: 3 },
  // Boulder speed (metres a second): a measured throw's mph times `perMph`, within
  // `min`–`max`; `normal` for a throw whose speed wasn't measured, or a click.
  speed: { normal: 30, perMph: 1, min: 18, max: 42 },
  // How deep every piece is, front to back (m).
  depth: 1,
  materials: {
    wood: { density: 1, friction: 0.7, restitution: 0.08, health: 14, points: 500 },
    ice: { density: 0.9, friction: 0.35, restitution: 0.05, health: 6, points: 300 },
    stone: { density: 2.6, friction: 0.8, restitution: 0.05, health: 36, points: 1000 },
    tnt: { density: 0.8, friction: 0.7, restitution: 0.05, health: 2.5, points: 500 },
  },
  goblins: {
    goblin: { r: 0.55, density: 0.8, health: 3, points: 5000 },
    helmet: { r: 0.55, density: 0.9, health: 7, points: 7000 },
    king: { r: 0.7, density: 0.9, health: 11, points: 15000 },
  },
  tnt: { size: 0.8, radius: 3.6, impulse: 26, damage: 30 },
  // A boulder (or a flying piece) striking the front of a piece: `harm` of its momentum into the
  // fort (kg m/s) less `floor` comes off the piece's health; a piece left standing is knocked out
  // backwards if that momentum is more than `knock` times its mass and what rests on it; `share` of
  // it reaches the other pieces the boulder touches; `along` of its momentum across the wall pushes
  // the piece across.
  impact: { harm: 0.14, floor: 1, knock: 12, share: 0.35, along: 0.3 },
  // The part of each step's knock within a wall (kg m/s: how much harder it is pushed than the
  // step before, so a resting load does no harm) that does no harm.
  damageFloor: 1.2,
  // A flying piece of ice landing faster than this (m/s) shatters; TNT blows up.
  shatterSpeed: 5,
  // Points for every boulder left when the last goblin falls.
  boulderBonus: 10000,
  // A shot is stopped this long after its last boulder was thrown even if something still moves (it is frozen).
  maxShotMs: 7000,
  // A goblin that ends up this far below where it sat (m), and has landed, has been knocked off its
  // perch: beaten. One pushed or rolled this far across from where it sat (m) is beaten too, so none
  // is left rolling off the edge of the screen.
  goblinFall: 0.7,
  goblinShove: 2.5,
  // Things past these (metres) have left the field: across (either way), below, beyond.
  bounds: { x: 22, y0: -2, z: 60 },
  // Steps run on a new fort, so its contacts are found before it sleeps.
  settleSteps: 90,
};

// ---- Forts --------------------------------------------------------------------

const box = (material, x, y, w, h) => ({ type: 'box', material, x, y, w, h });
const post = (material, x, y, h = 2) => box(material, x, y, 0.5, h);
const plank = (material, x, y, w) => box(material, x, y, w, 0.5);
const tnt = (x, y) => box('tnt', x, y, CASTLE_CRASH_RULES.tnt.size, CASTLE_CRASH_RULES.tnt.size);
const goblin = (x, y, kind = 'goblin') => ({ type: 'goblin', kind, x, y });

/** The forts, easiest first. Every wall is centred on the players. */
export const LEVELS = [
  {
    name: 'The Lookout',
    boulders: 4,
    layers: [{
      z: 14,
      pieces: [
        post('wood', -1.5, 0), post('wood', 1.5, 0), plank('wood', 0, 2, 4),
        goblin(0, 0), goblin(0, 2.5),
        box('ice', 4.5, 0, 1, 1), box('ice', 4.5, 1, 1, 1), goblin(4.5, 2),
      ],
    }],
  },
  {
    name: 'The Watchtower',
    boulders: 4,
    layers: [{
      z: 14,
      pieces: [
        post('wood', -1.5, 0), post('wood', 1.5, 0), plank('wood', 0, 2, 4),
        post('wood', -1.25, 2.5), post('wood', 1.25, 2.5), plank('wood', 0, 4.5, 3.5),
        goblin(0, 0), goblin(0, 2.5), goblin(0, 5),
        box('stone', -4.5, 0, 1, 1), goblin(-4.5, 1),
      ],
    }],
  },
  {
    name: 'The Ice Palace',
    boulders: 5,
    layers: [
      {
        z: 13.5,
        pieces: [
          box('ice', -4, 0, 1, 1), box('ice', -3, 0, 1, 1), goblin(-3.5, 1),
          box('ice', 3, 0, 1, 1), box('ice', 4, 0, 1, 1), goblin(3.5, 1),
        ],
      },
      {
        z: 17,
        pieces: [
          post('ice', -2.25, 0), post('ice', 0, 0), post('ice', 2.25, 0), plank('ice', 0, 2, 5),
          goblin(-1.125, 0), goblin(1.125, 0),
          post('ice', -1, 2.5), post('ice', 1, 2.5), plank('ice', 0, 4.5, 2.6),
          goblin(0, 2.5), goblin(0, 5),
        ],
      },
    ],
  },
  {
    name: 'The Stone Keep',
    boulders: 5,
    layers: [
      {
        z: 13.5,
        pieces: [
          box('stone', -3, 0, 1, 1), box('stone', -3, 1, 1, 1), box('stone', -2, 0, 1, 1), box('stone', -2, 1, 1, 1),
          box('stone', 2, 0, 1, 1), box('stone', 2, 1, 1, 1), box('stone', 3, 0, 1, 1), box('stone', 3, 1, 1, 1),
          plank('wood', 0, 2, 5), goblin(0, 2.5), tnt(0, 0),
        ],
      },
      {
        z: 17.5,
        pieces: [
          post('stone', -1.5, 0), post('stone', 1.5, 0), plank('stone', 0, 2, 4),
          post('wood', -1, 2.5), post('wood', 1, 2.5), plank('wood', 0, 4.5, 3),
          goblin(0, 0), goblin(0, 2.5), goblin(0, 5, 'helmet'),
        ],
      },
    ],
  },
  {
    name: 'The Twin Towers',
    boulders: 5,
    layers: [
      {
        z: 14,
        pieces: [
          post('wood', -5, 0), post('wood', -3, 0), plank('wood', -4, 2, 2.6),
          post('wood', -4.6, 2.5, 1.5), post('wood', -3.4, 2.5, 1.5), plank('wood', -4, 4, 2),
          post('wood', 3, 0), post('wood', 5, 0), plank('wood', 4, 2, 2.6),
          post('wood', 3.4, 2.5, 1.5), post('wood', 4.6, 2.5, 1.5), plank('wood', 4, 4, 2),
          plank('wood', 0, 4.5, 9.4),
          goblin(-4, 0), goblin(4, 0), goblin(-1.2, 5), goblin(1.2, 5),
        ],
      },
      {
        z: 18,
        pieces: [box('ice', -1.25, 0, 0.5, 1.5), box('ice', 1.25, 0, 0.5, 1.5), goblin(0, 0, 'helmet')],
      },
    ],
  },
  {
    name: 'The Goblin King’s Castle',
    boulders: 6,
    layers: [
      {
        z: 13.5,
        pieces: [
          box('stone', -5, 0, 1, 1), box('stone', -5, 1, 1, 1), goblin(-5, 2),
          box('stone', 5, 0, 1, 1), box('stone', 5, 1, 1, 1), goblin(5, 2),
          box('ice', -2.5, 0, 1, 1), box('ice', 2.5, 0, 1, 1),
        ],
      },
      {
        z: 17.5,
        pieces: [
          post('stone', -2, 0, 2.5), post('stone', 2, 0, 2.5), plank('stone', 0, 2.5, 4.8),
          tnt(-1, 0), goblin(0.8, 0, 'helmet'),
          post('wood', -1.5, 3, 1.5), post('wood', 1.5, 3, 1.5), plank('wood', 0, 4.5, 3.8),
          goblin(0, 3), goblin(0, 5, 'king'),
        ],
      },
    ],
  },
  {
    name: 'The Woodpile',
    boulders: 5,
    layers: [{
      z: 14,
      pieces: [
        ...[-2, -1, 0, 1, 2].map((x) => box('wood', x, 0, 1, 1)),
        box('wood', -1.25, 1, 1, 1.25), box('wood', 1.25, 1, 1, 1.25), plank('wood', 0, 2.25, 3.5),
        box('wood', -1.25, 2.75, 1, 1.25), box('wood', 1.25, 2.75, 1, 1.25), plank('wood', 0, 4, 3.5),
        goblin(-2.3, 1), goblin(2.3, 1), goblin(0, 1), goblin(0, 2.75), goblin(0, 4.5),
      ],
    }],
  },
  {
    name: 'The Rope Bridge',
    boulders: 5,
    layers: [{
      z: 14,
      pieces: [
        post('wood', -4.85, 0), post('wood', -3.15, 0), plank('wood', -4, 2, 2.4),
        post('wood', 3.15, 0), post('wood', 4.85, 0), plank('wood', 4, 2, 2.4),
        plank('wood', 0, 2.5, 7),
        goblin(-4, 0), goblin(4, 0), goblin(0, 0), goblin(-1.5, 3), goblin(1.5, 3),
      ],
    }],
  },
  {
    name: 'The Frozen Gate',
    boulders: 5,
    layers: [
      {
        z: 13.5,
        pieces: [
          post('ice', -1.25, 0, 2.5), post('ice', 1.25, 0, 2.5), plank('ice', 0, 2.5, 3), goblin(0, 3),
          box('ice', -3.5, 0, 1, 1), box('ice', -3.5, 1, 1, 1), goblin(-3.5, 2),
          box('ice', 3.5, 0, 1, 1), box('ice', 3.5, 1, 1, 1), goblin(3.5, 2),
        ],
      },
      {
        z: 17.5,
        pieces: [
          post('wood', -1, 0), post('wood', 1, 0), plank('wood', 0, 2, 2.6),
          goblin(0, 0, 'helmet'), goblin(0, 2.5),
        ],
      },
    ],
  },
  {
    name: 'The Powder Store',
    boulders: 5,
    layers: [{
      z: 14,
      pieces: [
        post('wood', -2.5, 0), post('wood', 2.5, 0), plank('wood', 0, 2, 5.6),
        tnt(-1.3, 0), tnt(1.3, 0), goblin(0, 0),
        tnt(0, 2.5), goblin(-1.6, 2.5), goblin(1.6, 2.5),
        box('stone', -4.6, 0, 1, 1), goblin(-4.6, 1), tnt(-5.6, 0),
        box('stone', 4.6, 0, 1, 1), goblin(4.6, 1), tnt(5.6, 0),
      ],
    }],
  },
  {
    name: 'The Stilts',
    boulders: 5,
    layers: [{
      z: 16,
      pieces: [
        post('wood', -4.35, 0, 3), post('wood', -2.65, 0, 3), plank('wood', -3.5, 3, 2.2), goblin(-3.5, 3.5), goblin(-3.5, 0),
        post('wood', 2.65, 0, 3), post('wood', 4.35, 0, 3), plank('wood', 3.5, 3, 2.2), goblin(3.5, 3.5), goblin(3.5, 0),
        post('wood', -0.75, 0, 3), post('wood', 0.75, 0, 3), plank('wood', 0, 3, 2),
        post('wood', -0.6, 3.5, 1.5), post('wood', 0.6, 3.5, 1.5), plank('wood', 0, 5, 1.7), goblin(0, 5.5),
      ],
    }],
  },
  {
    name: 'The Quarry',
    boulders: 6,
    layers: [
      {
        z: 14,
        pieces: [
          box('stone', -2, 0, 1, 1), box('stone', -2, 1, 1, 1), box('stone', 2, 0, 1, 1), box('stone', 2, 1, 1, 1),
          plank('stone', 0, 2, 5), goblin(0, 2.5, 'helmet'), goblin(0, 0), tnt(-1.05, 0),
          box('ice', -5.5, 0, 1, 1), goblin(-5.5, 1), box('ice', 5.5, 0, 1, 1), goblin(5.5, 1),
        ],
      },
      {
        z: 18,
        pieces: [
          box('stone', -4.5, 0, 1, 1), box('stone', -4.5, 1, 1, 1), goblin(-4.5, 2, 'helmet'),
          box('stone', 4.5, 0, 1, 1), box('stone', 4.5, 1, 1, 1), goblin(4.5, 2, 'helmet'),
        ],
      },
    ],
  },
  {
    name: 'The Three Little Huts',
    boulders: 5,
    layers: [{
      z: 14,
      pieces: [
        ...[['ice', -4], ['wood', 0], ['stone', 4]].flatMap(([material, x]) => [
          post(material, x - 0.9, 0, 1.5), post(material, x + 0.9, 0, 1.5), plank(material, x, 1.5, 2.3),
          goblin(x, 0, material === 'stone' ? 'helmet' : 'goblin'), goblin(x, 2),
        ]),
      ],
    }],
  },
  {
    name: 'The Barricade',
    boulders: 6,
    layers: [
      {
        z: 13,
        pieces: [
          box('wood', -3, 0, 1, 1), box('wood', -3, 1, 1, 1), goblin(-3, 2),
          box('wood', 3, 0, 1, 1), box('wood', 3, 1, 1, 1), goblin(3, 2),
          box('ice', -0.5, 0, 1, 1), box('ice', 0.5, 0, 1, 1),
        ],
      },
      {
        z: 16.5,
        pieces: [
          post('stone', -2, 0, 2.5), post('stone', 2, 0, 2.5), plank('wood', 0, 2.5, 4.6),
          goblin(0, 0, 'helmet'),
        ],
      },
      {
        z: 20,
        pieces: [
          post('wood', -0.75, 0), post('wood', 0.75, 0), plank('wood', 0, 2, 2),
          post('wood', -0.6, 2.5), post('wood', 0.6, 2.5), plank('wood', 0, 4.5, 1.8),
          goblin(0, 5, 'helmet'),
        ],
      },
    ],
  },
  {
    name: 'The Icicle Spire',
    boulders: 5,
    layers: [{
      z: 16,
      pieces: [
        post('ice', -0.85, 0), post('ice', 0.85, 0), plank('ice', 0, 2, 2.2), goblin(0, 0),
        post('ice', -0.6, 2.5, 1.5), post('ice', 0.6, 2.5, 1.5), plank('ice', 0, 4, 1.7), goblin(0, 4.5),
        box('ice', -3.5, 0, 1, 1), box('ice', -3.5, 1, 1, 1), goblin(-3.5, 2),
        box('ice', 3.5, 0, 1, 1), box('ice', 3.5, 1, 1, 1), goblin(3.5, 2),
      ],
    }],
  },
  {
    name: 'The Goblin Barracks',
    boulders: 6,
    layers: [
      {
        z: 13.5,
        pieces: [
          box('stone', -3, 0, 1, 1), box('stone', -3, 1, 1, 1), box('stone', -2, 0, 1, 1), box('stone', -2, 1, 1, 1),
          box('stone', 2, 0, 1, 1), box('stone', 2, 1, 1, 1), box('stone', 3, 0, 1, 1), box('stone', 3, 1, 1, 1),
          goblin(-2.5, 2), goblin(2.5, 2),
        ],
      },
      {
        z: 17.5,
        pieces: [
          ...[-3.5, -1.2, 1.2, 3.5].map((x) => post('stone', x, 0)), plank('stone', 0, 2, 7.5),
          goblin(-2.35, 0, 'helmet'), goblin(2.35, 0, 'helmet'), tnt(0, 0),
          post('stone', -1.05, 2.5), post('stone', 1.05, 2.5), plank('stone', 0, 4.5, 2.6),
          goblin(0, 2.5, 'king'), goblin(0, 5),
        ],
      },
    ],
  },
  {
    name: 'The Seesaw',
    boulders: 5,
    layers: [{
      z: 14,
      pieces: [
        box('stone', 0, 0, 1, 1.5), plank('wood', 0, 1.5, 6.4),
        goblin(-2.6, 2), goblin(2.6, 2), goblin(-2.6, 0), goblin(2.6, 0),
        box('ice', -5, 0, 1, 1), box('ice', -5, 1, 1, 1), goblin(-5, 2),
        box('ice', 5, 0, 1, 1), box('ice', 5, 1, 1, 1), goblin(5, 2),
      ],
    }],
  },
  {
    name: 'The Pillars',
    boulders: 6,
    layers: [{
      z: 15,
      pieces: [
        box('stone', -4.4, 0, 1, 1), box('wood', -2.2, 0, 1, 2), box('stone', 0, 0, 1, 3),
        box('wood', 2.2, 0, 1, 2), box('stone', 4.4, 0, 1, 1), tnt(-3.3, 0),
        goblin(-4.4, 1), goblin(-2.2, 2), goblin(0, 3, 'helmet'), goblin(2.2, 2), goblin(4.4, 1),
      ],
    }],
  },
  {
    name: 'The Frost Bridge',
    boulders: 6,
    layers: [{
      z: 15,
      pieces: [
        box('stone', -4, 0, 1.5, 1), box('stone', -4, 1, 1.5, 1), box('stone', -4, 2, 1.5, 1),
        box('stone', 4, 0, 1.5, 1), box('stone', 4, 1, 1.5, 1), box('stone', 4, 2, 1.5, 1),
        plank('ice', 0, 3, 7.5), goblin(-1.5, 3.5), goblin(1.5, 3.5, 'helmet'), goblin(-4.35, 3), goblin(4.35, 3),
        goblin(0, 0, 'helmet'),
      ],
    }],
  },
  {
    name: 'The Crooked Tower',
    boulders: 4,
    layers: [{
      z: 16,
      pieces: [
        ...[0, 0.15, 0.3, 0.45, 0.6].map((x, i) => box('wood', x, i, 1, 1)), goblin(0.6, 5),
        post('stone', -4.9, 0, 1.5), post('stone', -3.1, 0, 1.5), plank('stone', -4, 1.5, 2.3),
        goblin(-4, 0, 'helmet'), goblin(-4, 2),
        tnt(3.4, 0), box('wood', 4.5, 0, 1, 1), goblin(4.5, 1),
      ],
    }],
  },
  {
    name: 'The Gatehouse',
    boulders: 6,
    layers: [
      {
        z: 13.5,
        pieces: [
          box('stone', -3, 0, 1, 1), box('stone', -3, 1, 1, 1), box('stone', -3, 2, 1, 1), goblin(-3, 3),
          box('stone', 3, 0, 1, 1), box('stone', 3, 1, 1, 1), box('stone', 3, 2, 1, 1), goblin(3, 3),
          post('wood', -1.25, 0, 2.5), post('wood', 1.25, 0, 2.5), plank('wood', 0, 2.5, 3), goblin(0, 3, 'helmet'),
        ],
      },
      {
        z: 17.5,
        pieces: [
          post('wood', -1, 0), post('wood', 1, 0), plank('wood', 0, 2, 2.6), tnt(0, 0),
          goblin(-2.5, 0), goblin(2.5, 0),
        ],
      },
    ],
  },
  {
    name: 'The Gauntlet',
    boulders: 7,
    layers: [
      {
        z: 13,
        pieces: [
          box('ice', -4, 0, 1, 1), goblin(-4, 1), box('ice', 4, 0, 1, 1), goblin(4, 1),
        ],
      },
      {
        z: 16,
        pieces: [
          post('wood', -2.8, 0), post('wood', -1.2, 0), plank('wood', -2, 2, 2.2), goblin(-2, 2.5),
          post('wood', 1.2, 0), post('wood', 2.8, 0), plank('wood', 2, 2, 2.2), goblin(2, 2.5),
        ],
      },
      {
        z: 19.5,
        pieces: [
          post('stone', -1, 0, 2.5), post('stone', 1, 0, 2.5), plank('stone', 0, 2.5, 2.6),
          goblin(0, 0, 'helmet'), goblin(0, 3, 'helmet'),
        ],
      },
    ],
  },
  {
    name: 'The Fireworks Factory',
    boulders: 5,
    layers: [{
      z: 15,
      pieces: [
        post('stone', -3, 0), post('stone', 3, 0), plank('wood', 0, 2, 6.6),
        tnt(-1.6, 0), goblin(0, 0, 'helmet'), box('stone', 1.6, 0, 1, 1),
        box('stone', -2, 2.5, 1, 1.25), tnt(-0.9, 2.5), goblin(0.4, 2.5, 'helmet'), box('stone', 2, 2.5, 1, 1.25),
        plank('wood', 0, 3.75, 5), goblin(-1, 4.25), goblin(1, 4.25),
        box('stone', -5, 0, 1, 1), goblin(-5, 1), box('stone', 5, 0, 1, 1), goblin(5, 1),
      ],
    }],
  },
  {
    name: 'The Goblin Fortress',
    boulders: 6,
    layers: [
      {
        z: 14,
        pieces: [
          box('wood', -1.5, 0, 1, 1.25), box('wood', 1.5, 0, 1, 1.25), plank('wood', 0, 1.25, 4), goblin(0, 0), goblin(0, 1.75),
        ],
      },
      {
        z: 18,
        pieces: [
          post('stone', -5.4, 0, 3), post('stone', -3.4, 0, 3), plank('stone', -4.4, 3, 2.5), goblin(-4.4, 3.5, 'helmet'),
          post('stone', 3.4, 0, 3), post('stone', 5.4, 0, 3), plank('stone', 4.4, 3, 2.5), goblin(4.4, 3.5, 'helmet'),
          goblin(-4.4, 0), goblin(4.4, 0),
          post('wood', -2.5, 0, 2.5), post('wood', 2.5, 0, 2.5), plank('wood', 0, 2.5, 5.6), tnt(0, 3),
          goblin(-1.5, 0, 'helmet'), goblin(1.5, 0, 'helmet'),
        ],
      },
    ],
  },
  {
    name: 'The Great Wall',
    boulders: 6,
    layers: [
      {
        z: 13.5,
        pieces: [
          ...[-4.5, -3.5, -1.5, -0.5, 0.5, 1.5, 3.5, 4.5].map((x) => box('stone', x, 0, 1, 1)),
          plank('stone', -4, 1, 2), plank('stone', 0, 1, 4), plank('stone', 4, 1, 2),
          goblin(-4, 1.5), goblin(-1, 1.5, 'helmet'), goblin(1, 1.5, 'helmet'), goblin(4, 1.5),
        ],
      },
      {
        z: 18,
        pieces: [
          post('wood', -1.25, 0, 3), post('wood', 1.25, 0, 3), plank('wood', 0, 3, 3), tnt(0, 0),
          goblin(0, 3.5, 'helmet'),
        ],
      },
    ],
  },
  {
    name: 'The Goblin King’s Throne',
    boulders: 7,
    layers: [
      {
        z: 13.5,
        pieces: [
          box('stone', -4.5, 0, 1, 1), box('stone', -4.5, 1, 1, 1), goblin(-4.5, 2, 'helmet'),
          box('stone', 4.5, 0, 1, 1), box('stone', 4.5, 1, 1, 1), goblin(4.5, 2, 'helmet'),
          box('ice', -2, 0, 1, 1), box('ice', 2, 0, 1, 1), tnt(0, 0),
        ],
      },
      {
        z: 16.5,
        pieces: [
          post('stone', -2.5, 0, 2.5), post('stone', 2.5, 0, 2.5), plank('stone', 0, 2.5, 5.6),
          goblin(-1.2, 0), goblin(1.2, 0),
        ],
      },
      {
        z: 20.5,
        pieces: [
          post('stone', -1.4, 0, 5), post('stone', 1.4, 0, 5), plank('stone', 0, 5, 3.4), tnt(-0.6, 5.5),
          box('stone', 0, 0, 1, 3), goblin(0, 3, 'king'), goblin(0.7, 5.5, 'helmet'),
        ],
      },
    ],
  },
  {
    name: 'The Windmill',
    boulders: 4,
    layers: [{
      z: 15,
      pieces: [
        post('wood', -0.9, 0), post('wood', 0.9, 0), plank('wood', 0, 2, 2.3), goblin(0, 0),
        post('wood', -0.85, 2.5, 1.5), post('wood', 0.85, 2.5, 1.5), plank('wood', 0, 4, 2.2), goblin(0, 2.5), goblin(0, 4.5),
        box('stone', -4, 0, 1, 1), box('wood', -4, 1, 1, 1), goblin(-4, 2),
        box('ice', 4, 0, 1, 1), box('ice', 4, 1, 1, 1), goblin(4, 2),
      ],
    }],
  },
  {
    name: 'The Ice Caves',
    boulders: 5,
    layers: [
      {
        z: 13.5,
        pieces: [
          box('ice', -3.5, 0, 1, 1), box('ice', -2.5, 0, 1, 1), plank('ice', -3, 1, 2.4), goblin(-3, 1.5),
          box('ice', 2.5, 0, 1, 1), box('ice', 3.5, 0, 1, 1), plank('ice', 3, 1, 2.4), goblin(3, 1.5),
        ],
      },
      {
        z: 17.5,
        pieces: [
          post('ice', -1.5, 0, 2.5), post('ice', 1.5, 0, 2.5), plank('ice', 0, 2.5, 3.6), goblin(0, 0, 'helmet'),
          box('ice', -1.3, 3, 0.6, 1.2), box('ice', 1.3, 3, 0.6, 1.2), goblin(0, 3, 'helmet'),
        ],
      },
    ],
  },
  {
    name: 'The Drawbridge',
    boulders: 4,
    layers: [{
      z: 15,
      pieces: [
        post('stone', -4.9, 0, 3), post('stone', -3.1, 0, 3), plank('stone', -4, 3, 2.3), goblin(-4.3, 3.5, 'helmet'),
        post('wood', 3.1, 0, 3), post('wood', 4.9, 0, 3), plank('wood', 4, 3, 2.3), goblin(4.3, 3.5),
        plank('wood', 0, 3.5, 7), goblin(-1.2, 4), goblin(1.2, 4),
        tnt(-1.2, 0), goblin(0, 0),
      ],
    }],
  },
  {
    name: 'The Pyramid',
    boulders: 7,
    layers: [{
      z: 15,
      pieces: [
        ...[-3, -2, -1, 0, 1, 2, 3].map((x) => box('stone', x, 0, 1, 1)),
        ...[-2, -1, 0, 1, 2].map((x) => box('wood', x, 1, 1, 1)),
        ...[-1, 0, 1].map((x) => box('ice', x, 2, 1, 1)),
        box('ice', 0, 3, 1, 1),
        goblin(-3.05, 1), goblin(3.05, 1), goblin(-1.05, 3, 'helmet'), goblin(1.05, 3, 'helmet'), goblin(0, 4, 'king'),
      ],
    }],
  },
  {
    name: 'The Lighthouse',
    boulders: 5,
    layers: [
      {
        z: 13,
        pieces: [box('wood', -4, 0, 1, 1), goblin(-4, 1), box('wood', 4, 0, 1, 1), goblin(4, 1)],
      },
      {
        z: 17,
        pieces: [
          box('stone', 0, 0, 1.5, 1.5), box('wood', 0, 1.5, 1.2, 1.5), box('wood', 0, 3, 1, 1.5), plank('wood', 0, 4.5, 2),
          goblin(0, 5, 'helmet'), tnt(-1.3, 0), goblin(1.4, 0),
        ],
      },
    ],
  },
  {
    name: 'The Treehouse',
    boulders: 4,
    layers: [{
      z: 15,
      pieces: [
        post('wood', -1, 0, 3.5), post('wood', 1, 0, 3.5), plank('wood', 0, 3.5, 3), goblin(0, 0),
        post('wood', -1.2, 4, 1.5), post('wood', 1.2, 4, 1.5), plank('wood', 0, 5.5, 3), goblin(0, 4, 'helmet'),
        box('ice', -4, 0, 1, 1), goblin(-4, 1, 'helmet'), box('ice', 4, 0, 1, 1), goblin(4, 1, 'helmet'),
      ],
    }],
  },
  {
    name: 'The Twin Keeps',
    boulders: 5,
    layers: [
      {
        z: 14,
        pieces: [
          post('stone', -4.9, 0), post('stone', -3.1, 0), plank('stone', -4, 2, 2.3), goblin(-4, 0, 'helmet'), goblin(-4, 2.5),
          post('wood', 3.1, 0), post('wood', 4.9, 0), plank('wood', 4, 2, 2.3), goblin(4, 0, 'helmet'), goblin(4, 2.5),
        ],
      },
      {
        z: 18,
        pieces: [
          post('wood', -1.5, 0, 2.5), post('wood', 1.5, 0, 2.5), plank('wood', 0, 2.5, 3.6), goblin(0, 0, 'helmet'),
          post('wood', -1, 3, 1.5), post('wood', 1, 3, 1.5), plank('wood', 0, 4.5, 2.6), goblin(0, 3), goblin(0, 5),
        ],
      },
    ],
  },
  {
    name: 'The Siege Camp',
    boulders: 6,
    layers: [
      {
        z: 13,
        pieces: [box('wood', -3, 0, 1, 1), goblin(-3, 1), box('wood', 3, 0, 1, 1), goblin(3, 1), tnt(0, 0)],
      },
      {
        z: 16.5,
        pieces: [
          box('stone', -1.5, 0, 1, 1.25), box('stone', 1.5, 0, 1, 1.25), plank('wood', 0, 1.25, 4.2),
          goblin(0, 1.75, 'helmet'), goblin(0, 0),
        ],
      },
      {
        z: 20,
        pieces: [
          post('wood', -3.6, 0, 3), post('wood', -1.8, 0, 3), plank('wood', -2.7, 3, 2.3), goblin(-2.7, 3.5), goblin(-2.7, 0),
          post('stone', 1.8, 0, 3), post('stone', 3.6, 0, 3), plank('stone', 2.7, 3, 2.3), goblin(2.7, 3.5, 'helmet'), goblin(2.7, 0),
        ],
      },
    ],
  },
  {
    name: 'The Treasure Vault',
    boulders: 5,
    layers: [{
      z: 15.5,
      pieces: [
        post('stone', -2, 0, 2.5), post('stone', 2, 0, 2.5), plank('stone', 0, 2.5, 4.6),
        tnt(-1, 0), goblin(0.6, 0, 'king'),
        box('stone', -1.6, 3, 1, 1), box('stone', 1.6, 3, 1, 1), goblin(0, 3, 'helmet'),
        tnt(-4.2, 0), box('wood', -5.2, 0, 1, 1), goblin(-5.2, 1),
        tnt(4.2, 0), box('wood', 5.2, 0, 1, 1), goblin(5.2, 1),
      ],
    }],
  },
  {
    name: 'The Goblin Emperor’s Citadel',
    boulders: 7,
    layers: [
      {
        z: 13.5,
        pieces: [
          box('stone', -4.5, 0, 1, 1), box('stone', -4.5, 1, 1, 1), box('stone', -4.5, 2, 1, 1), goblin(-4.5, 3, 'helmet'),
          box('stone', 4.5, 0, 1, 1), box('stone', 4.5, 1, 1, 1), box('stone', 4.5, 2, 1, 1), goblin(4.5, 3, 'helmet'),
          post('ice', -1, 0, 2.5), post('ice', 1, 0, 2.5), plank('ice', 0, 2.5, 2.5),
        ],
      },
      {
        z: 17,
        pieces: [
          ...[-3.4, -1, 1, 3.4].map((x) => post('stone', x, 0, 2.5)), plank('stone', 0, 2.5, 7.4),
          goblin(-2.2, 0, 'helmet'), goblin(2.2, 0, 'helmet'), tnt(0, 0), goblin(-2.2, 3), goblin(2.2, 3),
        ],
      },
      {
        z: 21,
        pieces: [
          post('stone', -1.5, 0, 3), post('stone', 1.5, 0, 3), plank('stone', 0, 3, 3.6), goblin(0, 0, 'helmet'),
          post('wood', -1.2, 3.5, 2), post('wood', 1.2, 3.5, 2), plank('wood', 0, 5.5, 3), goblin(0, 3.5, 'king'),
        ],
      },
    ],
  },
].map((level, i) => ({ n: i + 1, ...level }));

/** Level `n` (1 is the first); past the last, the forts come round again. */
export function levelFor(n) {
  return LEVELS[(Math.max(1, Math.floor(n)) - 1) % LEVELS.length];
}

/** A piece of a wall as a body in that wall's world. */
function addPiece(world, piece, layer, z, depth) {
  const rules = CASTLE_CRASH_RULES;
  const at = { layer, zc: z + depth / 2, depth };
  if (piece.type === 'goblin') {
    const g = rules.goblins[piece.kind];
    return addBody(world, {
      shape: 'circle', r: g.r, x: piece.x, y: piece.y + g.r, density: g.density, friction: 0.8, restitution: 0.1,
      kind: 'goblin', goblin: piece.kind, health: g.health, maxHealth: g.health, ...at,
    });
  }
  const m = rules.materials[piece.material];
  return addBody(world, {
    shape: 'box', w: piece.w, h: piece.h, x: piece.x, y: piece.y + piece.h / 2,
    density: m.density, friction: m.friction, restitution: m.restitution,
    kind: 'block', material: piece.material, health: m.health, maxHealth: m.health, ...at,
  });
}

/**
 * A fort, standing and asleep: each wall a world of its own, every piece a body, its contacts found.
 * @param {Level} level
 * @returns {Fort}
 */
export function buildLevel(level) {
  const rules = CASTLE_CRASH_RULES;
  const depth = rules.depth;
  const layers = level.layers.map((plan, i) => {
    const world = createWorld({ gravity: rules.gravity });
    world.nextId = (i + 1) * 1000; // ids unique across the fort's walls
    for (const piece of plan.pieces) addPiece(world, piece, i, plan.z, depth);
    for (let k = 0; k < rules.settleSteps; k++) step(world);
    sleepAll(world);
    for (const b of world.bodies) {
      if (b.kind !== 'goblin') continue;
      b.homeX = b.x;
      b.homeY = b.y;
    }
    return { z: plan.z, depth, world };
  });
  const pads = layers.map((layer) => {
    const bodies = layer.world.bodies.filter((b) => !b.isStatic);
    const x0 = Math.min(...bodies.map((b) => b.x - reach(b)));
    const x1 = Math.max(...bodies.map((b) => b.x + reach(b)));
    return { x0: x0 - 0.6, x1: x1 + 0.6, z0: layer.z - 0.5, z1: layer.z + layer.depth + 0.5 };
  });
  return { layers, rubble: [], pads };
}

function reach(b) {
  return b.shape === 'circle' ? b.r : Math.hypot(b.w, b.h) / 2;
}

/** The goblins still standing in a fort. */
export function goblinsIn(fort) {
  return fort.layers.flatMap((layer) => layer.world.bodies.filter((b) => b.kind === 'goblin'));
}

/** Points for breaking `body` (a block or a goblin), or knocking it out. */
export function pointsFor(body) {
  if (body.kind === 'goblin') return CASTLE_CRASH_RULES.goblins[body.goblin].points;
  if (body.kind === 'block') return CASTLE_CRASH_RULES.materials[body.material].points;
  return 0;
}

/** The bonus for clearing a fort with `left` boulders to spare. */
export function bonusFor(left) {
  return Math.max(0, left) * CASTLE_CRASH_RULES.boulderBonus;
}

// ---- The view -------------------------------------------------------------------

/**
 * The camera behind the players for a screen `width` × `height` pixels: as wide
 * as `hfovDeg`, unless that would show less than `minVfovDeg` up and down.
 * @returns {View}
 */
export function viewFor(width, height) {
  const { camera } = CASTLE_CRASH_RULES;
  const rad = Math.PI / 180;
  const f = Math.min((width / 2) / Math.tan((camera.hfovDeg * rad) / 2), (height / 2) / Math.tan((camera.minVfovDeg * rad) / 2));
  return { width, height, f, cx: width / 2, cy: height / 2, eyeY: camera.eyeY, pitch: camera.pitchDeg * rad };
}

/**
 * A world point on the screen (pixels), with how far in front of the camera it is (`depth`, metres).
 * @param {View} view
 */
export function project(view, x, y, z) {
  const c = Math.cos(view.pitch);
  const s = Math.sin(view.pitch);
  const dy = y - view.eyeY;
  const yc = dy * c + z * s;
  const depth = z * c - dy * s;
  return { x: view.cx + (view.f * x) / depth, y: view.cy - (view.f * yc) / depth, depth };
}

/** The way into the world through a screen point (pixels): a direction from the eye, not of unit length. */
export function rayThrough(view, px, py) {
  const u = (px - view.cx) / view.f;
  const v = (view.cy - py) / view.f;
  const c = Math.cos(view.pitch);
  const s = Math.sin(view.pitch);
  return { x: u, y: v * c - s, z: v * s + c };
}

/** Where the ray through a screen point (pixels) crosses the plane z = `z`. */
export function pointAtDepth(view, px, py, z) {
  const d = rayThrough(view, px, py);
  const t = z / d.z;
  return { x: d.x * t, y: view.eyeY + d.y * t, z };
}

/** The screen y of the horizon (pixels). */
export function horizonY(view) {
  return view.cy - view.f * Math.tan(view.pitch);
}

/** How fast the boulder flies (metres a second) for a throw of `mph`, or a normal throw for none. */
export function boulderSpeed(mph) {
  const { speed } = CASTLE_CRASH_RULES;
  if (!Number.isFinite(mph) || mph <= 0) return speed.normal;
  return Math.max(speed.min, Math.min(speed.max, mph * speed.perMph));
}

/**
 * The boulder a throw makes. It is aimed at whatever is on the screen where the
 * ball hit (normalised screen coordinates): the first piece of the fort the line
 * of sight through that spot meets, else the ground, else far off in the sky.
 * It is thrown from the players and arcs to arrive exactly there.
 * @param {{x:number, y:number, speedMph?: number|null}} hit
 * @param {View} view
 * @param {Fort} [fort]
 * @param {Pose[]} [poses] where the fort's pieces are now, while a shot plays out (else where they stand)
 * @returns {Shot}
 */
export function shotFor(hit, view, fort, poses) {
  const rules = CASTLE_CRASH_RULES;
  const r = rules.boulder.r;
  const px = hit.x * view.width;
  const py = hit.y * view.height;
  let to = null;
  const inWall = (layer, i) => (poses
    ? poses.filter((p) => p.body.layer === i && p.tilt === 0 && Math.abs(p.z - p.body.zc) < 1e-3).map((p) => ({ ...p.body, x: p.x, y: p.y, a: p.a }))
    : layer.world.bodies.filter((b) => !b.isStatic));
  for (const [i, layer] of (fort?.layers ?? []).entries()) {
    const front = pointAtDepth(view, px, py, layer.z);
    const middle = pointAtDepth(view, px, py, layer.z + layer.depth / 2);
    const struck = inWall(layer, i).some((b) => overlaps(b, b.kind === 'goblin' ? middle : front, r * 0.5));
    if (struck) {
      to = pointAtDepth(view, px, py, layer.z - r);
      break;
    }
  }
  if (!to) {
    const d = rayThrough(view, px, py);
    const ground = d.y < 0 ? (view.eyeY - r) / -d.y : Infinity;
    to = ground * d.z < 45 ? { x: d.x * ground, y: r, z: d.z * ground } : pointAtDepth(view, px, py, 45);
  }
  const from = rules.throwFrom;
  const speed = boulderSpeed(hit.speedMph);
  const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const t = distance / speed;
  return {
    from, to, speed, flightMs: t * 1000,
    vx: (to.x - from.x) / t,
    vy: (to.y - from.y) / t + 0.5 * rules.gravity * t,
    vz: (to.z - from.z) / t,
  };
}

/** Does a ball of radius `r` at (x, y) touch body `b` in its wall? */
function overlaps(b, at, r) {
  const contact = collide(b, { shape: 'circle', x: at.x, y: at.y, r, a: 0 });
  return Boolean(contact?.points.some((p) => p.sep < 0));
}

// ---- A shot -----------------------------------------------------------------------

/** The bodies resting on `body` in its wall, which it holds up. */
function loadOn(world, body) {
  let load = 0;
  for (const m of world.contacts.values()) {
    if (!m.points.length) continue;
    if (m.a === body && m.ny > 0.5 && !m.b.isStatic) load += m.b.mass;
    else if (m.b === body && m.ny < -0.5 && !m.a.isStatic) load += m.a.mass;
  }
  return load;
}

/** A box's eight corners, turned by `a` in the wall's plane and tipped back by `tilt`. */
export function boxCorners3d(body, x, y, z, a, tilt) {
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const hw = body.w / 2;
  const hh = body.h / 2;
  const hd = body.depth / 2;
  const out = [];
  for (const lz of [-hd, hd]) {
    for (const [lx, ly] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
      const rx = ca * lx - sa * ly;
      const ry = sa * lx + ca * ly;
      out.push({ x: x + rx, y: y + ry * ct - lz * st, z: z + ry * st + lz * ct });
    }
  }
  return out;
}

/**
 * Throws a boulder (or several, each `atMs` into the play) into the fort and
 * runs everything until it is still again (or `maxShotMs` after the last was
 * thrown), recording where every body was and what broke. The fort is left as
 * the shot leaves it: pieces knocked out lie where they came to rest
 * (`rubble`), and the boulders are gone.
 * @param {Fort} fort
 * @param {Shot|Throw[]} shots one boulder thrown at once, or several
 * @returns {Play}
 */
export function playShot(fort, shots) {
  const rules = CASTLE_CRASH_RULES;
  const { dt } = PHYSICS;
  const stepMs = dt * 1000;
  const g = rules.gravity;
  const r = rules.boulder.r;
  const throws = Array.isArray(shots) ? shots : [{ shot: shots, atMs: 0 }];
  const bodies = new Map();
  const boulders = throws.map(({ shot, atMs }, i) => {
    const body = { id: i + 1, kind: 'boulder', shape: 'circle', r, mass: rules.boulder.density * Math.PI * r * r };
    bodies.set(body.id, body);
    return {
      body, ...shot.from, vx: shot.vx, vy: shot.vy, vz: shot.vz, atMs, alive: atMs <= 0, done: false, passed: new Set(),
    };
  });
  const lastThrowMs = Math.max(0, ...throws.map((t) => t.atMs));
  for (const layer of fort.layers) for (const b of layer.world.bodies) if (!b.isStatic) bodies.set(b.id, b);
  for (const pose of fort.rubble) bodies.set(pose.body.id, pose.body);
  /** @type {{body: Body, x: number, y: number, z: number, vx: number, vy: number, vz: number, a: number, va: number, tilt: number, vt: number, health: number, from: number, resting: boolean}[]} */
  const flyers = [];
  const events = [];
  let points = 0;
  let ms = 0;

  const record = (event) => {
    points += event.points;
    events.push({ ms, ...event });
  };

  /** Breaks (or beats) a body in its wall, or lets one leave the field. */
  const breakBody = (body, type, push = 0) => {
    if (body.removed) return;
    const layer = fort.layers[body.layer];
    record({
      type: type === 'gone' ? 'gone' : body.kind === 'goblin' ? 'goblin' : 'break',
      id: body.id, x: body.x, y: body.y, z: body.zc, points: pointsFor(body), push,
    });
    removeBody(layer.world, body);
    if (body.material === 'tnt' && type !== 'gone') blast(body.x, body.y, body.zc);
  };

  /** Knocks a body out of its wall, backwards: a goblin is beaten, a block flies. */
  const knockOut = (body, speed, hitY, across) => {
    const layer = fort.layers[body.layer];
    if (body.kind === 'goblin') {
      breakBody(body, 'goblin', speed);
      return;
    }
    record({ type: 'knock', id: body.id, x: body.x, y: body.y, z: body.zc, points: pointsFor(body) });
    removeBody(layer.world, body);
    const above = Math.max(-1, Math.min(1, (hitY - body.y) / Math.max(0.25, body.h / 2)));
    flyers.push({
      body, x: body.x, y: body.y, z: body.zc, vx: across, vy: 1.5 + 0.1 * Math.abs(speed), vz: speed,
      a: body.a, va: across * 0.3, tilt: 0, vt: (above >= 0 ? 1 : -1) * Math.min(12, 2 + Math.abs(speed) * (0.4 + Math.abs(above))),
      health: Math.max(0, body.health / body.maxHealth), from: body.layer, resting: false,
    });
  };

  /**
   * Something (`mass`, moving at v) strikes the front of wall `layer` at (x, y), reaching `r` around.
   * @returns {'none'|'broke'|'knocked'|'held'}
   */
  const impact = (layer, x, y, mass, v, reachR) => {
    const world = fort.layers[layer].world;
    const touched = world.bodies.filter((b) => !b.isStatic && overlaps(b, { x, y }, reachR));
    if (!touched.length) return 'none';
    const { impact: k } = rules;
    touched.sort((p, q) => Math.hypot(p.x - x, p.y - y) - Math.hypot(q.x - x, q.y - y));
    let outcome = 'held';
    touched.forEach((body, i) => {
      const into = mass * Math.max(0, v.vz) * (i === 0 ? 1 : k.share);
      if (i === 0) applyImpulse(body, mass * v.vx * k.along, mass * v.vy * k.along, x, y);
      else applyImpulse(body, 0, 0);
      body.health -= Math.max(0, into * k.harm - k.floor) * (body.kind === 'goblin' ? 2 : 1);
      let result = 'held';
      if (body.health <= 0) {
        breakBody(body, 'break', Math.min(10, into / body.mass / 2));
        result = 'broke';
      } else if (into > k.knock * (body.mass + loadOn(world, body))) {
        knockOut(body, Math.min(14, (0.6 * into) / body.mass), y, v.vx * 0.2);
        result = 'knocked';
      }
      if (i === 0) outcome = result;
    });
    return outcome;
  };

  /** TNT going off at (x, y, z): everything within reach, in its wall or another, is thrown and hurt. */
  const blast = (x, y, z) => {
    const { radius, impulse, damage } = rules.tnt;
    record({ type: 'boom', id: 0, x, y, z, points: 0 });
    for (const layer of fort.layers) {
      const caught = [];
      for (const body of [...layer.world.bodies]) {
        if (body.isStatic || body.removed) continue;
        const dx = body.x - x;
        const dy = body.y - y;
        const dz = body.zc - z;
        const d = Math.hypot(dx, dy, dz);
        if (d >= radius) continue;
        const near = 1 - d / radius;
        const u = d > 1e-6 ? 1 / d : 0;
        const push = impulse * near;
        applyImpulse(body, dx * u * push, (dy * u + 0.3) * push);
        body.health -= damage * near;
        const into = Math.abs(dz * u * push) * 4;
        if (body.health <= 0) caught.push([body, 'break']);
        else if (into > rules.impact.knock * (body.mass + loadOn(layer.world, body))) caught.push([body, 'knock', Math.sign(dz) * (into / body.mass) * 0.6]);
      }
      for (const [body, what, speed] of caught) {
        if (body.removed) continue;
        if (what === 'break') breakBody(body, 'break', Math.sign(body.zc - z) * 4);
        else knockOut(body, speed, body.y, (body.x - x) * 0.5);
      }
    }
  };

  const frames = [];
  const pose = () => {
    const list = [];
    for (const layer of fort.layers) {
      for (const b of layer.world.bodies) {
        if (!b.isStatic) list.push(b.id, b.x, b.y, b.zc, b.a, 0, b.maxHealth ? Math.max(0, b.health / b.maxHealth) : 1);
      }
    }
    for (const f of flyers) list.push(f.body.id, f.x, f.y, f.z, f.a, f.tilt, f.health);
    for (const p of fort.rubble) list.push(p.body.id, p.x, p.y, p.z, p.a, p.tilt, p.health);
    for (const boulder of boulders) if (boulder.alive) list.push(boulder.body.id, boulder.x, boulder.y, boulder.z, 0, 0, 1);
    frames.push(Float32Array.from(list));
  };
  pose();

  const maxSteps = Math.ceil((lastThrowMs + rules.maxShotMs) / stepMs);
  let steps = 0;
  while (steps < maxSteps) {
    steps++;
    ms = steps * stepMs;

    // The boulders: through the air, striking the walls they reach, bouncing on the ground.
    for (const boulder of boulders) {
      if (!boulder.done && !boulder.alive && boulder.atMs < ms) boulder.alive = true;
      if (!boulder.alive) continue;
      const boulderBody = boulder.body;
      const z0 = boulder.z;
      boulder.vy -= g * dt;
      boulder.x += boulder.vx * dt;
      boulder.y += boulder.vy * dt;
      boulder.z += boulder.vz * dt;
      fort.layers.forEach((layer, i) => {
        const plane = layer.z - r;
        if (boulder.passed.has(i) || !(z0 < plane && boulder.z >= plane)) return;
        boulder.passed.add(i);
        const outcome = impact(i, boulder.x, boulder.y, boulderBody.mass, boulder, r);
        if (outcome === 'none') return;
        if (outcome === 'broke') {
          boulder.vx *= 0.6;
          boulder.vz *= 0.6;
        } else if (outcome === 'knocked') {
          boulder.vx *= 0.5;
          boulder.vz *= 0.3;
        } else {
          boulder.vx *= 0.5;
          boulder.vz *= -0.25;
          boulder.z = plane;
        }
      });
      if (boulder.y < r) {
        boulder.y = r;
        if (boulder.vy < 0) boulder.vy *= -0.3;
        boulder.vx *= 0.7;
        boulder.vz *= 0.7;
        if (Math.hypot(boulder.vx, boulder.vy, boulder.vz) < 1.5) {
          boulder.alive = false;
          boulder.done = true;
          record({ type: 'poof', id: boulderBody.id, x: boulder.x, y: boulder.y, z: boulder.z, points: 0 });
        }
      }
      if (boulder.alive && (Math.abs(boulder.x) > rules.bounds.x || boulder.z > rules.bounds.z)) {
        boulder.alive = false;
        boulder.done = true;
      }
    }

    // Each wall: its pieces fall, tip and knock each other.
    fort.layers.forEach((layer) => {
      const hurt = [];
      step(layer.world, {
        onImpulse: (body, { rise }) => {
          if (body.health === undefined) return;
          const harm = rise - rules.damageFloor;
          if (harm <= 0) return;
          body.health -= harm;
          if (body.health <= 0) hurt.push(body);
        },
      });
      for (const body of hurt) breakBody(body, 'break');
      for (const body of [...layer.world.bodies]) {
        if (body.isStatic) continue;
        if (Math.abs(body.x) > rules.bounds.x || body.y < rules.bounds.y0) breakBody(body, 'gone');
        else if (body.kind === 'goblin' && knockedDown(body)) breakBody(body, 'break');
      }
    });

    // Pieces knocked out: tumbling back, into the walls behind them, onto the ground.
    for (const f of [...flyers]) {
      if (f.resting) continue;
      const z0 = f.z;
      f.vy -= g * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.z += f.vz * dt;
      f.a += f.va * dt;
      f.tilt += f.vt * dt;
      fort.layers.forEach((layer, i) => {
        const plane = layer.z - f.body.depth / 2;
        if (i <= f.from || !(z0 < plane && f.z >= plane)) return;
        const outcome = impact(i, f.x, f.y, f.body.mass, f, Math.min(f.body.w, f.body.h) / 2);
        if (outcome === 'held') {
          f.vz *= -0.2;
          f.z = plane;
        } else if (outcome !== 'none') {
          f.vz *= 0.5;
        }
      });
      const low = Math.min(...boxCorners3d(f.body, f.x, f.y, f.z, f.a, f.tilt).map((c) => c.y));
      if (low < 0) {
        f.y -= low;
        const landing = -f.vy;
        if (landing > rules.shatterSpeed && (f.body.material === 'ice' || f.body.material === 'tnt')) {
          flyers.splice(flyers.indexOf(f), 1);
          record({ type: 'shatter', id: f.body.id, x: f.x, y: f.y, z: f.z, points: 0 });
          if (f.body.material === 'tnt') blast(f.x, f.y, f.z);
          continue;
        }
        if (f.vy < 0) f.vy *= -0.25;
        f.vx *= 0.6;
        f.vz *= 0.6;
        f.vt *= 0.55;
        f.va *= 0.55;
        if (Math.hypot(f.vx, f.vy, f.vz) < 0.7) {
          f.resting = true;
          f.vx = f.vy = f.vz = f.vt = f.va = 0;
        }
      }
      if (Math.abs(f.x) > rules.bounds.x || f.z > rules.bounds.z) flyers.splice(flyers.indexOf(f), 1);
    }

    if (steps % 2 === 0) pose();
    const moving = boulders.some((b) => !b.done) || flyers.some((f) => !f.resting)
      || fort.layers.some((layer) => isAwake(layer.world));
    if (!moving) break;
  }
  const endMs = steps * stepMs;
  for (const layer of fort.layers) sleepAll(layer.world);
  for (const f of flyers) fort.rubble.push({ body: f.body, x: f.x, y: Math.max(f.y, 0), z: f.z, a: f.a, tilt: f.tilt, health: f.health });
  for (const boulder of boulders) {
    if (!boulder.alive) continue;
    boulder.alive = false;
    record({ type: 'poof', id: boulder.body.id, x: boulder.x, y: boulder.y, z: boulder.z, points: 0 });
  }
  if (steps % 2 !== 0) pose();
  events.sort((p, q) => p.ms - q.ms);
  return {
    bodies, frames, frameMs: stepMs * 2, events, endMs, points, goblinsLeft: goblinsIn(fort).length,
    boulderId: boulders[0].body.id, boulderIds: boulders.map((b) => b.body.id),
  };
}

/** Has this goblin been knocked off its perch (and landed), or bowled away from where it sat? */
function knockedDown(body) {
  const { goblinFall, goblinShove } = CASTLE_CRASH_RULES;
  if (body.homeX === undefined) return false;
  if (Math.abs(body.x - body.homeX) > goblinShove) return true;
  return body.homeY - body.y > goblinFall && Math.abs(body.vy) < 1;
}

/**
 * The poses `ms` into a play, between the recorded frames.
 * @param {Play} play
 * @returns {Pose[]}
 */
export function posesAt(play, ms) {
  const at = Math.max(0, Math.min(play.frames.length - 1, ms / play.frameMs));
  const i = Math.floor(at);
  const f = at - i;
  const now = play.frames[i];
  const next = play.frames[Math.min(i + 1, play.frames.length - 1)];
  const later = new Map();
  for (let k = 0; k < next.length; k += 7) later.set(next[k], k);
  const out = [];
  for (let k = 0; k < now.length; k += 7) {
    const body = play.bodies.get(now[k]);
    if (!body) continue;
    const j = later.get(now[k]);
    const lerp = (o) => (j === undefined ? now[k + o] : now[k + o] + (next[j + o] - now[k + o]) * f);
    out.push({ body, x: lerp(1), y: lerp(2), z: lerp(3), a: lerp(4), tilt: lerp(5), health: now[k + 6] });
  }
  return out;
}

/**
 * The fort as it stands between shots: every piece in its wall, and what lies knocked out.
 * @param {Fort} fort
 * @returns {Pose[]}
 */
export function standing(fort) {
  const poses = fort.layers.flatMap((layer) => layer.world.bodies.filter((b) => !b.isStatic).map((body) => ({
    body, x: body.x, y: body.y, z: body.zc, a: body.a, tilt: 0,
    health: body.maxHealth ? Math.max(0, body.health / body.maxHealth) : 1,
  })));
  return [...poses, ...fort.rubble];
}

/**
 * A rectangle (normalised screen coordinates) round all of a fort, its rubble
 * and the ground it stands on: what changes when a fort appears or goes.
 * @param {Fort} fort
 * @param {View} view
 */
export function fortArea(fort, view) {
  const points = [];
  for (const pose of standing(fort)) {
    const b = pose.body;
    const s = b.shape === 'circle' ? b.r * 1.4 : Math.hypot(b.w, b.h, b.depth) / 2;
    for (const dx of [-s, s]) for (const dy of [-s, s]) for (const dz of [-s, s]) points.push(project(view, pose.x + dx, Math.max(0, pose.y + dy), pose.z + dz));
  }
  for (const pad of fort.pads) {
    for (const x of [pad.x0, pad.x1]) for (const z of [pad.z0, pad.z1]) points.push(project(view, x, 0, z));
  }
  if (!points.length) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    x0: Math.min(...xs) / view.width, x1: Math.max(...xs) / view.width,
    y0: Math.min(...ys) / view.height, y1: Math.max(...ys) / view.height,
  };
}

/**
 * Where the picture changes between `fromMs` and `toMs` into a play: a rectangle
 * (normalised screen coordinates) round each body that moves, appears or goes
 * then, with its shadow on the ground, merged into at most `most`. Effects
 * (splinters, puffs, points) are the art's to say (`effectArea`).
 * @param {Play} play
 * @param {View} view
 * @returns {{x0: number, y0: number, x1: number, y1: number}[]}
 */
export function motionAreas(play, view, fromMs, toMs, most = 3) {
  const { frames, frameMs } = play;
  const last = frames.length - 1;
  const i0 = Math.max(0, Math.min(last, Math.floor(fromMs / frameMs) - 1));
  const i1 = Math.max(0, Math.min(last, Math.ceil(toMs / frameMs) + 1));
  /** @type {Map<number, {moved: boolean, poses: number[][]}>} */
  const seen = new Map();
  for (let i = i0; i <= i1; i++) {
    const f = frames[i];
    const here = new Set();
    for (let k = 0; k < f.length; k += 7) {
      const id = f[k];
      here.add(id);
      const pose = [f[k + 1], f[k + 2], f[k + 3], f[k + 4], f[k + 5]];
      let entry = seen.get(id);
      if (!entry) {
        entry = { moved: i > i0, poses: [] }; // one that appears has moved
        seen.set(id, entry);
      } else if (!entry.moved) {
        const before = entry.poses[entry.poses.length - 1];
        entry.moved = pose.some((v, j) => Math.abs(v - before[j]) > 1e-4);
      }
      entry.poses.push(pose);
    }
    for (const [id, entry] of seen) if (!here.has(id)) entry.moved = true; // one that goes has changed too
  }
  const rects = [];
  for (const [id, entry] of seen) {
    if (!entry.moved) continue;
    const body = play.bodies.get(id);
    if (!body) continue;
    const s = body.shape === 'circle' ? body.r * (body.kind === 'goblin' ? 1.7 : 1.2) : Math.hypot(body.w, body.h, body.depth ?? 1) / 2;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const [x, y, z] of entry.poses) {
      for (const dx of [-s, s]) {
        for (const dz of [-s, s]) {
          for (const py of [y - s, y + s, 0]) {
            const p = project(view, x + dx, Math.max(0, py), z + dz);
            if (p.depth < (body.kind === 'boulder' ? CASTLE_CRASH_RULES.boulder.shownFrom - s : 0.1)) continue;
            x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
            y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
          }
        }
      }
    }
    if (x0 <= x1) rects.push({ x0: x0 / view.width, y0: y0 / view.height, x1: x1 / view.width, y1: y1 / view.height });
  }
  return mergeRects(rects, most);
}

/**
 * Rectangles merged where they overlap, then the pair that grows least when
 * joined, until there are at most `most`.
 * @param {{x0: number, y0: number, x1: number, y1: number}[]} rects
 */
export function mergeRects(rects, most) {
  const out = rects.map((r) => ({ ...r }));
  const join = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
  const area = (r) => (r.x1 - r.x0) * (r.y1 - r.y0);
  const touch = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
  for (;;) {
    let best = null;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const grow = touch(out[i], out[j]) ? -1 : area(join(out[i], out[j])) - area(out[i]) - area(out[j]);
        if (!best || grow < best.grow) best = { i, j, grow };
      }
    }
    if (!best || (best.grow >= 0 && out.length <= most)) return out;
    out[best.i] = join(out[best.i], out[best.j]);
    out.splice(best.j, 1);
  }
}
