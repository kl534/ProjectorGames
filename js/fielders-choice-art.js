// Fielder's Choice drawing: the ballpark under the lights seen through the
// fielder's eyes, and the players in it, in 3D (built in
// fielders-choice-models.js, drawn by fielders-choice-gl.js), behind a sky
// of stars and a moon with the light towers glowing; the pictures on the
// signs and the scoreboards (the line score); and, flat on the screen, the
// player's own glove, the ball they throw, fireworks, and a view of the
// park from above for picking a position. Everything goes onto canvases;
// nothing here knows about the game's timing or about the camera watching
// for throws.
//
// Colours are mid to dark (a night game), so a light-coloured ball stands out
// against all of it.

import {
  ADS, BOARDS, COLOURS, GLYPHS, PARK_CENTRE, TOWERS, TOWER_HEIGHT, baseballShapes, ballShape, bigGloveShapes, droppedBat, turnAbout, groundHeight, playerShapes,
} from './fielders-choice-models.js';
import { TEAMS } from './fielders-choice-players.js';
import { renderer } from './fielders-choice-gl.js';
import { makeCamera } from './fielders-choice-logic.js';

const TAU = 2 * Math.PI;
const BALL_RADIUS = 0.22; // feet: a little bigger than a real one (0.12), so it reads from the outfield
const SKY = { star: '#d8d1b6', moon: '#d9cfa8', moonShade: '#b4a984' };

/** A little random number generator, so the stars are the same every time. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Stars, as directions from the eye (far enough away that they never move as it does).
const STARS = (() => {
  const random = seeded(11);
  return Array.from({ length: 220 }, () => {
    const az = random() * TAU;
    const el = 0.15 + random() * 1.1;
    return { x: Math.sin(az) * Math.cos(el), y: Math.cos(az) * Math.cos(el), z: Math.sin(el), size: random() < 0.15 ? 2 : 1, alpha: 0.35 + random() * 0.6 };
  });
})();
const MOON = (() => {
  const d = { x: -0.45, y: -1, z: 0.5 };
  const n = Math.hypot(d.x, d.y, d.z);
  return { x: d.x / n, y: d.y / n, z: d.z / n };
})();

// The lamps on each light tower, where their glow is centred.
const LAMPS = TOWERS.map((t) => {
  const d = Math.hypot(PARK_CENTRE.x - t.x, PARK_CENTRE.y - t.y);
  return { x: t.x + ((PARK_CENTRE.x - t.x) / d) * 2.5, y: t.y + ((PARK_CENTRE.y - t.y) / d) * 2.5, z: TOWER_HEIGHT + 8 };
});

/**
 * @typedef {object} SceneThing someone (or something) on the field
 * @property {{x:number, y:number, z?:number}} at where their feet are
 * @property {import('./fielders-choice-players.js').Player} [player]
 * @property {{x:number, y:number}|null} [facing] the way they face, on the field (towards the eye if not given)
 * @property {{x:number, y:number}|null} [lookAt] what they turn their head to look at
 * @property {'bat'} [prop] a thing lying on the ground (a dropped bat)
 * @property {number} [angle] its direction on the field
 *
 * @typedef {object} Scene what to draw besides the ballpark
 * @property {SceneThing[]} [figures]
 * @property {{x:number, y:number, z:number}|null} [ball]
 * @property {{x:number, y:number, z:number}[]} [trail] where the ball was just before, newest last
 * @property {{mood: 'still'|'cheer'|'groan', since: number}} [crowd] the crowd's reaction, and when it started (ms)
 * @property {{runs: number[], inning: number, innings: number, outs: number}} [board] for the scoreboards
 * @property {number} [now] the time (ms), for anything that moves
 * @property {import('./fielders-choice-models.js').Shape[]} [shapes] more solid things to draw (Gap Shot's fence, markers and ball)
 */

/**
 * Draws the whole scene for a camera (see makeCamera): the sky, then the
 * ballpark, the players and the ball in 3D, then the lights' glow.
 * @param {CanvasRenderingContext2D} ctx
 * @param {ReturnType<import('./fielders-choice-logic.js').makeCamera>} camera
 * @param {Scene} [scene]
 */
export function drawScene(ctx, camera, scene = {}) {
  const { figures = [], ball = null, trail = [], crowd = null, board = null, now = 0, shapes: extra = [] } = scene;
  const { width: W, height: H } = ctx.canvas;
  drawSky(ctx, camera);
  const gl = renderer();
  gl.begin(W, H);
  gl.setCamera(camera.view, camera.aspect);
  gl.drawPark(ART, { crowd, now, board });
  const shapes = [];
  for (const thing of figures) shapes.push(...thingShapes(thing, camera.view.eye));
  if (ball) {
    const ground = groundHeight(ball.x, ball.y);
    shapes.push({
      mesh: 'quad', m: [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, ball.x, ball.y, ground + 0.03, 1], colour: [0, 0, 0, 0.4], shadow: true, outline: false,
    });
    trail.forEach((t, i) => shapes.push({ ...ballShape(t, BALL_RADIUS * (0.6 + (i / trail.length) * 0.4)), colour: [0.89, 0.87, 0.82, ((i + 1) / (trail.length + 1)) * 0.35] }));
    shapes.push(...baseballShapes(ball, BALL_RADIUS, turnAbout(SPIN_AXIS, now * SPIN_RATE)));
  }
  shapes.push(...extra);
  gl.drawShapes(ART, shapes);
  gl.copyTo(ctx);
  drawGlow(ctx, camera);
  drawVignette(ctx);
}

/**
 * Draws players on their own over a clear canvas (the covering fielder), as
 * the camera sees them, in the same place on the screen as in the scene:
 * only in `crop` (a part of the screen, 0–1), if given, where they are.
 * @param {CanvasRenderingContext2D} ctx
 * @param {SceneThing[]} things
 * @param {{x0:number, y0:number, x1:number, y1:number}} [crop]
 */
export function drawFigures(ctx, camera, things, crop = { x0: 0, y0: 0, x1: 1, y1: 1 }) {
  const { width: W, height: H } = ctx.canvas;
  ctx.clearRect(0, 0, W, H);
  // Whole pixels, so the picture lands exactly where it belongs.
  const px = {
    x0: Math.max(0, Math.floor(crop.x0 * W)), y0: Math.max(0, Math.floor(crop.y0 * H)),
    x1: Math.min(W, Math.ceil(crop.x1 * W)), y1: Math.min(H, Math.ceil(crop.y1 * H)),
  };
  if (px.x1 <= px.x0 || px.y1 <= px.y0) return;
  const gl = renderer();
  gl.begin(px.x1 - px.x0, px.y1 - px.y0);
  gl.setCamera(camera.view, camera.aspect, { crop: { x0: px.x0 / W, y0: px.y0 / H, x1: px.x1 / W, y1: px.y1 / H } });
  gl.drawShapes(ART, things.flatMap((t) => thingShapes(t, camera.view.eye)));
  gl.copyTo(ctx, px.x0, px.y0);
}

/**
 * Draws one player on their own little canvas (the runner): seen the way
 * `view` looks, but flat, `px` pixels to a foot, with the point `origin` (on
 * the field) at (ax, ay) on the canvas. Flat, so the picture of them doesn't
 * change as they move about.
 * @param {CanvasRenderingContext2D} ctx
 * @param {SceneThing} thing
 */
export function drawSprite(ctx, view, thing, { px, ax, ay, origin }) {
  const { width: W, height: H } = ctx.canvas;
  ctx.clearRect(0, 0, W, H);
  const gl = renderer('sprite');
  gl.begin(W, H);
  gl.setCamera(view, W / H, { sprite: { px, ax, ay, origin } });
  gl.drawShapes(ART, thingShapes(thing, view.eye));
  gl.copyTo(ctx);
}

/** The shapes a scene thing is made of. Someone facing nowhere in particular faces the eye. */
function thingShapes(thing, eye) {
  if (thing.prop === 'bat') return droppedBat(thing.at, thing.angle);
  const facing = thing.facing ?? { x: eye.x - thing.at.x, y: eye.y - thing.at.y };
  return playerShapes({ ...thing, facing });
}

function drawSky(ctx, camera) {
  const { width: W, height: H } = ctx.canvas;
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, COLOURS.skyTop);
  sky.addColorStop(1, COLOURS.skyLow);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  const eye = camera.view.eye;
  const far = 1e5;
  for (const star of STARS) {
    const p = camera.project({ x: eye.x + star.x * far, y: eye.y + star.y * far, z: eye.z + star.z * far });
    if (!p || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) continue;
    ctx.globalAlpha = star.alpha;
    ctx.fillStyle = SKY.star;
    ctx.fillRect(p.x * W, p.y * H, star.size, star.size);
  }
  ctx.globalAlpha = 1;
  const moon = camera.project({ x: eye.x + MOON.x * far, y: eye.y + MOON.y * far, z: eye.z + MOON.z * far });
  if (moon && moon.x > -0.1 && moon.x < 1.1 && moon.y > -0.1 && moon.y < 1.1) {
    // The moon is about 1.5° across, whatever the zoom.
    const r = Math.max(6, Math.min(0.2 * H, Math.tan(0.013) * camera.view.f * H));
    const x = moon.x * W;
    const y = moon.y * H;
    const glow = ctx.createRadialGradient(x, y, r, x, y, r * 3);
    glow.addColorStop(0, 'rgba(217, 207, 168, 0.18)');
    glow.addColorStop(1, 'rgba(217, 207, 168, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(x - r * 3, y - r * 3, r * 6, r * 6);
    ctx.fillStyle = SKY.moon;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = SKY.moonShade;
    for (const [dx, dy, k] of [[-0.3, -0.2, 0.22], [0.25, 0.1, 0.16], [-0.05, 0.4, 0.12], [0.35, -0.35, 0.1]]) {
      ctx.beginPath();
      ctx.arc(x + dx * r, y + dy * r, k * r, 0, TAU);
      ctx.fill();
    }
  }
}

/** The light towers' glow, over the picture. */
function drawGlow(ctx, camera) {
  const { width: W, height: H } = ctx.canvas;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const lamp of LAMPS) {
    const p = camera.project(lamp);
    if (!p) continue;
    const size = 26 * p.scale * H * 2.6;
    if (p.x * W < -size || p.x * W > W + size || p.y * H < -size || p.y * H > H + size) continue;
    const glow = ctx.createRadialGradient(p.x * W, p.y * H, 0, p.x * W, p.y * H, size);
    glow.addColorStop(0, 'rgba(241, 214, 138, 0.35)');
    glow.addColorStop(0.35, 'rgba(241, 214, 138, 0.12)');
    glow.addColorStop(1, 'rgba(241, 214, 138, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(p.x * W - size, p.y * H - size, size * 2, size * 2);
  }
  ctx.restore();
}

// ---- The pictures on the signs and scoreboards -----------------------------------

const SHEET_WIDTH = 768;

/** What the renderer asks the art for: the signs, the scoreboards and the letters on the players. */
const ART = {
  boards: BOARDS,
  board: null,

  /**
   * One canvas with every sign's picture on it, one under the other, each
   * shaped like its panel. Returns where each panel's picture is (0–1).
   */
  signSheet(panels) {
    const sizes = panels.map((p) => {
      const [tl, tr, bl] = p.corners;
      const w = Math.hypot(tr.x - tl.x, tr.y - tl.y, tr.z - tl.z);
      const h = Math.hypot(bl.x - tl.x, bl.y - tl.y, bl.z - tl.z);
      return Math.max(24, Math.min(256, Math.round(SHEET_WIDTH * (h / w))));
    });
    const canvas = document.createElement('canvas');
    canvas.width = SHEET_WIDTH;
    canvas.height = sizes.reduce((a, b) => a + b + 2, 0);
    const ctx = canvas.getContext('2d');
    let y = 0;
    const slots = panels.map((panel, i) => {
      const h = sizes[i];
      ctx.save();
      ctx.translate(0, y);
      paintSign(ctx, panel.slot, SHEET_WIDTH, h);
      ctx.restore();
      const slot = { u0: 0, u1: 1, v0: (y + 0.5) / canvas.height, v1: (y + h - 0.5) / canvas.height };
      y += h + 2;
      return slot;
    });
    return { canvas, slots };
  },

  boardCanvas() {
    if (!this.board) {
      this.board = document.createElement('canvas');
      this.board.width = 1024;
      this.board.height = 356;
      this.paintBoard(null);
    }
    return this.board;
  },

  /** The scoreboard: the home team's name, then the visitors' runs inning by inning, and the outs. */
  paintBoard(board) {
    const canvas = this.boardCanvas();
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.fillStyle = COLOURS.board;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = COLOURS.boardText;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${H * 0.2}px system-ui, sans-serif`;
    ctx.fillText(`${TEAMS.home.city.toUpperCase()} ${TEAMS.home.name.toUpperCase()}`, W / 2, H * 0.16, W * 0.95);
    const innings = Math.max(9, board?.innings ?? 9);
    const left = W * 0.2;
    const col = (W - left - W * 0.12) / innings;
    ctx.font = `800 ${H * 0.14}px system-ui, sans-serif`;
    for (let i = 0; i < innings; i++) ctx.fillText(String(i + 1), left + col * (i + 0.5), H * 0.38);
    ctx.fillText('R', W - W * 0.06, H * 0.38);
    ctx.textAlign = 'left';
    ctx.fillText(TEAMS.away.name.toUpperCase(), W * 0.025, H * 0.58);
    ctx.fillText(TEAMS.home.name.toUpperCase().slice(0, 8), W * 0.025, H * 0.78);
    ctx.textAlign = 'center';
    const runs = board?.runs ?? [];
    for (let i = 0; i < innings; i++) {
      if (i < runs.length) ctx.fillText(String(runs[i]), left + col * (i + 0.5), H * 0.58);
    }
    ctx.fillText(String(runs.reduce((a, b) => a + b, 0)), W - W * 0.06, H * 0.58);
    if (board) {
      ctx.font = `800 ${H * 0.11}px system-ui, sans-serif`;
      ctx.fillText(`OUTS ${'● '.repeat(board.outs)}${'○ '.repeat(Math.max(0, 3 - board.outs))}`.trim(), W / 2, H * 0.93);
    }
  },

  /**
   * The letters and digits painted on the players, white, with their outline
   * in the green channel (the renderer colours them): four to a row.
   */
  glyphSheet() {
    const canvas = document.createElement('canvas');
    const cell = 128;
    canvas.width = cell * 4;
    canvas.height = cell * 4;
    const ctx = canvas.getContext('2d');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${cell * 0.92}px system-ui, sans-serif`;
    ctx.lineJoin = 'round';
    [...GLYPHS].forEach((ch, i) => {
      const x = (i % 4) * cell + cell / 2;
      const y = Math.floor(i / 4) * cell + cell / 2 + cell * 0.04;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - cell / 2, y - cell / 2 - cell * 0.04, cell, cell);
      ctx.clip();
      ctx.translate(x, y);
      ctx.scale(0.72, 1);
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = cell * 0.12;
      ctx.strokeText(ch, 0, 0);
      ctx.fillStyle = '#ff0000';
      ctx.fillText(ch, 0, 0);
      ctx.restore();
    });
    return canvas;
  },
};

/** One sign's picture, `w` × `h`: an ad, a team's name over its dugout, or a distance on the wall. */
function paintSign(ctx, slot, w, h) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (slot.kind === 'ad') {
    const [colour, text] = ADS[slot.index];
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(240, 220, 160, 0.5)';
    ctx.lineWidth = h * 0.05;
    ctx.strokeRect(h * 0.06, h * 0.06, w - h * 0.12, h * 0.88);
    ctx.fillStyle = '#f0dca0';
    ctx.font = `900 ${h * (text.length > 12 ? 0.42 : 0.55)}px system-ui, sans-serif`;
    ctx.fillText(text, w / 2, h * 0.53, w * 0.92);
  } else if (slot.kind === 'dugout') {
    const team = TEAMS[slot.text];
    ctx.fillStyle = team.jersey;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = team.trim === '#3a3d45' ? '#e8c48a' : team.trim;
    ctx.font = `900 ${h * 0.8}px system-ui, sans-serif`;
    ctx.fillText(team.name.toUpperCase(), w / 2, h * 0.55, w * 0.9);
  } else {
    // Painted straight on the padding (the rest of the picture is clear), in the colour of the line along the top of the wall.
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = COLOURS.wallTop;
    ctx.font = `900 ${h * 0.9}px system-ui, sans-serif`;
    ctx.fillText(slot.text, w / 2, h * 0.55, w * 0.95);
  }
}

/** Darkens the corners a little, like a camera lens. */
function drawVignette(ctx) {
  const { width: W, height: H } = ctx.canvas;
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.hypot(W, H) * 0.6);
  g.addColorStop(0, 'rgba(0, 0, 0, 0)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0.35)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/** A flat view straight ahead, for the pictures of a ball or a glove on the screen: x across, z up. */
const FRONT = { eye: { x: 0, y: -10, z: 0 }, yaw: 0, pitch: 0, f: 1, centreY: 0.5 };
const ORIGIN = { x: 0, y: 0, z: 0 };
const SPIN_AXIS = unitOf({ x: 0.35, y: 0.1, z: 0.93 });
const SPIN_RATE = 0.02; // radians a millisecond

function unitOf(v) {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

/**
 * Draws shapes built at the origin of a flat view (see FRONT), `px` pixels to
 * a unit, so that the origin lands at (x, y) on `ctx`, in a square just big
 * enough for them (`reach` units out from the origin).
 */
function drawOnScreen(ctx, shapes, x, y, px, reach) {
  const size = Math.ceil(px * reach * 2) + 4;
  const left = Math.floor(x - size / 2);
  const top = Math.floor(y - size / 2);
  const gl = renderer('sprite');
  gl.begin(size, size);
  gl.setCamera(FRONT, 1, { sprite: { px, ax: x - left, ay: y - top, origin: ORIGIN } });
  gl.drawShapes(ART, shapes);
  gl.copyTo(ctx, left, top);
}

/**
 * A baseball on the screen (not on the field), in 3D, turning as it comes:
 * at (x, y) on the canvas, `r` pixels across the middle, with a faint streak
 * back to `from`.
 */
export function drawFlyingBall(ctx, x, y, r, from, now = 0) {
  if (from) {
    const g = ctx.createLinearGradient(from.x, from.y, x, y);
    g.addColorStop(0, 'rgba(228, 223, 210, 0)');
    g.addColorStop(1, 'rgba(228, 223, 210, 0.4)');
    ctx.strokeStyle = g;
    ctx.lineCap = 'round';
    ctx.lineWidth = r * 1.4;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
  drawOnScreen(ctx, baseballShapes(ORIGIN, 1, turnAbout(SPIN_AXIS, now * SPIN_RATE)), x, y, r, 1.2);
}

/**
 * The fielder's own glove, in 3D, rising from the bottom of the screen to take the
 * batted ball (low for a grounder, higher for a base hit), with the ball in it once `caught`.
 * @param {number} u 0 out of sight, 1 all the way up
 */
export function drawBigGlove(ctx, u, caught, kind = 'grounder') {
  const { width: W, height: H } = ctx.canvas;
  const k = Math.min(1, Math.max(0, u));
  const r = 0.2 * H;
  const rest = kind === 'hit' ? 0.7 : 0.86;
  const x = W * (0.5 + (kind === 'hit' ? 0.06 : -0.04) * k);
  const y = H * (1.3 - (1.3 - rest) * k);
  drawOnScreen(ctx, bigGloveShapes(kind === 'hit' ? 0.25 : -0.35, caught), x, y, r * GLOVE_SCALE, 1.1);
}

const GLOVE_SCALE = 1.6; // the glove model is about 0.7 across; this makes it about as big as the old drawing

/**
 * Fireworks over the stands: bursts of sparks that spread, fall and fade.
 * @param {{x:number, y:number, at:number, colour:string}[]} bursts where (normalised) and when (ms) each goes off
 */
export function drawFireworks(ctx, bursts, now) {
  const { width: W, height: H } = ctx.canvas;
  for (const burst of bursts) {
    const t = (now - burst.at) / 1000;
    if (t < 0 || t > 1.6) continue;
    const fade = 1 - t / 1.6;
    const sparks = 26;
    for (let i = 0; i < sparks; i++) {
      const a = (i / sparks) * TAU + burst.x * 10;
      const speed = 0.12 + ((i * 37) % 10) / 100;
      const x = (burst.x + Math.cos(a) * speed * Math.sqrt(t) * 0.9) * W;
      const y = (burst.y + Math.sin(a) * speed * Math.sqrt(t) * 0.9 * (W / H) * 0.6 + 0.12 * t * t) * H;
      ctx.globalAlpha = fade;
      ctx.fillStyle = burst.colour;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.5, H * 0.004 * (1 + fade)), 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// ---- The view for picking a position -----------------------------------------

/** The park from high up behind home plate, like the camera on a blimp. */
export const DIAGRAM_VIEW = (() => {
  const eye = { x: 0, y: -330, z: 420 };
  const target = { x: 0, y: 175, z: 0 };
  return {
    eye,
    yaw: 0,
    pitch: Math.atan2(target.z - eye.z, target.y - eye.y),
    f: 2.3,
    centreY: 0.42,
  };
})();

/**
 * The ballpark from above, for picking a position: home plate at the
 * bottom, centre field at the top, the crowd in the stands round it.
 * @param {CanvasRenderingContext2D} ctx
 */
export function drawDiagram(ctx) {
  const { width: W, height: H } = ctx.canvas;
  drawScene(ctx, makeCamera(DIAGRAM_VIEW, W / H));
}

/**
 * Where each position's pick target goes on the view from above (normalised
 * screen coordinates): over where they stand, though third base is moved out
 * a little so its target is clear of the shortstop's.
 */
export const PICK_SPOTS = {
  '3B': { x: 0.315, y: 0.675 },
  SS: { x: 0.427, y: 0.547 },
  '2B': { x: 0.573, y: 0.547 },
  LF: { x: 0.228, y: 0.266 },
  CF: { x: 0.5, y: 0.159 },
  RF: { x: 0.772, y: 0.266 },
};

/**
 * Sizes a canvas to the screen it fills, in device pixels (capped, so a big
 * screen doesn't make redrawing slow). Returns true if it changed.
 * @param {HTMLCanvasElement} canvas
 */
export function fitCanvas(canvas) {
  const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}
