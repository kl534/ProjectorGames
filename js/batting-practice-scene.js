// Batting Practice's picture, kept free of the browser so it can be unit-tested: the fixed, slightly raised view
// from behind home plate that shows the whole field to the fence, the replay of a shot (the ball flying
// along its flight, sped up, with a trail, then a marker where it came down) as shapes for Fielder's Choice's
// 3D drawing (fielders-choice-art.js's `drawScene`), and the top-down spray chart's coordinates.
//
// Field positions are in feet as in gap-shot-logic.js (home plate at the origin, +y out to centre field, +x
// towards first base, z up). A replay's time is milliseconds since the swing.

import { lookAngles, makeCamera } from './fielders-choice-logic.js';
import { ballShape } from './fielders-choice-models.js';
import { fenceOf } from './gap-shot-logic.js';
import { ballAt, simulateBall } from './gap-shot-physics.js';
import { ballShapes, markerShapes } from './gap-shot-scene.js';
import { flightMsFor, replayMsFor } from './batting-practice-logic.js';

/**
 * @typedef {import('./fielders-choice-logic.js').View} View
 * @typedef {import('./batting-practice-logic.js').Shot} Shot
 */

export const VIEW = {
  // The camera: high behind home plate (feet), looking at the field out beyond the infield.
  eye: { x: 0, y: -60, z: 60 },
  lookAt: { x: 0, y: 150, z: 0 },
  // The foul poles (the ends of the fence) are this far from the middle of the picture, as a share of its width…
  fenceHalfWidth: 0.46,
  // …and home plate is this far down it.
  homeAt: 0.9,
};

/**
 * The fixed view of a level's field on a canvas `aspect` wide for each unit high: zoomed so the fence just fits
 * across, the same for every swing and never moving.
 * @returns {View}
 */
export function fieldView(level, aspect) {
  const { eye, lookAt } = VIEW;
  const angles = lookAngles(eye, lookAt);
  const fence = fenceOf(level);
  let across = 0;
  const unit = makeCamera({ eye, ...angles, f: 1, centreY: 0.5 }, aspect);
  for (let deg = -45; deg <= 45; deg += 15) {
    const r = fence.radiusAt(deg);
    const p = unit.project({ x: r * Math.sin((deg * Math.PI) / 180), y: r * Math.cos((deg * Math.PI) / 180), z: 0 });
    across = Math.max(across, Math.abs(p.x - 0.5));
  }
  const f = VIEW.fenceHalfWidth / across;
  const home = makeCamera({ eye, ...angles, f, centreY: 0.5 }, aspect).project({ x: 0, y: 0, z: 0 });
  return { eye, ...angles, f, centreY: 0.5 + VIEW.homeAt - home.y };
}

// ---- The replay ----------------------------------------------------------------------------

// No fence, as the numbers are worked out (batting-practice-logic.js).
const OPEN_FENCE = { radiusAt: () => 1e5, height: 0 };
const TRAIL_POINTS = 60;

/**
 * A shot's replay: the ball's flight from the bat to where it first comes down, played `speed` times as fast, with
 * how long each part lasts (ms).
 * @param {Shot} shot
 */
export function replayFor(shot) {
  const flight = simulateBall({ speed: shot.speed, spray: shot.spray, launch: shot.launch }, OPEN_FENCE);
  const landAt = shot.hang;
  const flightMs = flightMsFor(landAt);
  return { flight, landAt, flightMs, totalMs: replayMsFor(landAt), shot };
}

/** Where the ball is `ms` into a replay (it stays where it came down once it has). */
export function replayBall(replay, ms) {
  const t = Math.min(replay.landAt, (Math.max(0, ms) / replay.flightMs) * replay.landAt);
  const b = ballAt(replay.flight.samples, t);
  return { x: b.x, y: b.y, z: b.z, t };
}

/**
 * What a replay shows `ms` in, besides the park and the fielders: the ball (bigger the further it is from the eye, so it
 * can be seen), its shadow and the trail it has left, and, once it has come down, the marker where it landed.
 * @param {ReturnType<typeof replayFor>} replay
 * @param {number} ms
 * @param {View} view
 * @returns {import('./fielders-choice-models.js').Shape[]}
 */
export function replayShapes(replay, ms, view) {
  const eye = view.eye;
  const now = replayBall(replay, ms);
  const landed = ms >= replay.flightMs;
  const shapes = [];
  const upTo = Math.ceil((now.t / replay.landAt) * TRAIL_POINTS);
  for (let i = 0; i < upTo; i++) {
    const p = ballAt(replay.flight.samples, (i / TRAIL_POINTS) * replay.landAt);
    const distance = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
    const r = Math.max(0.3, 0.0035 * distance);
    shapes.push({ ...ballShape(p, r), colour: [0.95, 0.92, 0.8, landed ? 0.45 : 0.25 + 0.5 * (i / TRAIL_POINTS)] });
  }
  if (!landed) {
    const ball = (s) => ballAt(replay.flight.samples, Math.min(s, replay.landAt));
    shapes.push(...ballShapes({ ball }, now.t, eye));
  } else {
    shapes.push(...markerShapes([replay.shot.spot]));
  }
  return shapes;
}

// ---- The spray chart ---------------------------------------------------------------------

// The chart shows the field from above, home plate at the bottom: this far out (a share of the centre field fence) at
// the sides, and from a little behind the plate to a little beyond the fence.
export const CHART = { side: 0.8, behind: 0.08, beyond: 1.04, margin: 0.03 };

/** The chart's width over its height. */
export const CHART_ASPECT = (2 * CHART.side) / (CHART.beyond + CHART.behind);

/**
 * Where a point of the field is on a level's spray chart, 0–1 across and down (a point off the chart is put at its edge).
 * @param {{x:number, y:number}} p
 */
export function chartPoint(p, level) {
  const R = level.fence.centre;
  const clamp = (v) => Math.max(CHART.margin, Math.min(1 - CHART.margin, v));
  return {
    x: clamp(0.5 + p.x / (2 * CHART.side * R)),
    y: clamp(1 - (p.y + CHART.behind * R) / ((CHART.beyond + CHART.behind) * R)),
  };
}

/** The level's fence as a line on the chart, from the left foul line to the right one, and the two foul lines from home plate. */
export function chartLines(level) {
  const { radiusAt } = fenceOf(level);
  const at = (deg) => {
    const r = radiusAt(deg);
    return { x: r * Math.sin((deg * Math.PI) / 180), y: r * Math.cos((deg * Math.PI) / 180) };
  };
  const fence = [];
  for (let deg = -45; deg <= 45; deg += 5) fence.push(chartPoint(at(deg), level));
  const home = chartPoint({ x: 0, y: 0 }, level);
  return { fence, foulLeft: [home, chartPoint(at(-45), level)], foulRight: [home, chartPoint(at(45), level)] };
}
