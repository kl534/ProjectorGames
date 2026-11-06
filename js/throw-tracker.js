// The ball tracking every game shares: from what each camera's detector saw,
// one hit per throw, with where and when it hit, how fast it was going and
// which cameras saw it. No browser code, so it is unit tested; ThrowCamera
// feeds it each camera's frames, and games only ever see the hits it makes.
//
// Each camera's frames are timed on the screen's clock (frame time less that
// camera's delay), so what two cameras saw lines up.
//
// A hit seen by one camera is held back a moment if another camera is
// following a ball too, until that camera has also seen it hit, or has seen
// past that moment without a hit: then both cameras' spots are averaged. So a
// throw both cameras saw is one hit, a few milliseconds later at most.
//
// Where both cameras saw the ball arrive, their paths meet in the room
// (stereo.js), giving its speed. Every path a camera followed is also gathered
// into throws, each with what every camera saw and the ball's flight, for
// Ball Test's data.

import { applyHomography } from './homography.js';
import { analyseFlight, roomPath } from './stereo.js';

// Hits from two cameras this close together (ms) are the same throw.
export const SAME_THROW_MS = 250;
// A hit waits for the other camera until it has seen this far (ms) past it without a hit…
const FUSE_SEEN_PAST_MS = 60;
// …or until this long (ms, real time) has passed, if that camera stalls.
const FUSE_MAX_WAIT_MS = 150;
// Paths followed this close together (ms) belong to the same throw…
const THROW_JOIN_MS = 150;
// …and a throw is complete once no camera has added to it for this long (ms), and none is still
// following a path that may belong to it (but at most this long: something that never stops moving isn't a throw).
const THROW_CLOSE_MS = 450;
const THROW_WAIT_MS = 3000;
// Feet a second in miles an hour.
const FPS_TO_MPH = 3600 / 5280;
// A hit's speed is measured from the paths seen up to this long (ms) before it.
const APPROACH_MS = 400;

/**
 * @typedef {{x:number, y:number}} Point normalised screen coordinates
 * @typedef {{x:number, y:number, t:number}} TimedPoint normalised camera coords; t ms
 * @typedef {object} TrackerCamera what the tracker needs to know about a camera
 * @property {number[]} cameraToScreen its calibration's homography
 * @property {number} latencyMs how late it sees the screen
 * @property {number} imageAspect its picture's height / width
 * @property {import('./stereo.js').CameraModel|null} model where it is in the room, if known
 *
 * @typedef {object} Hit a ball hit the screen: all a game needs to know
 * @property {number} x where it hit, 0–1 across the screen
 * @property {number} y where it hit, 0–1 down the screen
 * @property {number} time when the picture it hit was on screen (performance.now() ms): check it
 *   against where things were then
 * @property {number[]} cameras which cameras saw it hit (0 the main camera, 1 the second)
 * @property {number|null} spread how far apart the cameras put it (fraction of the screen's width), null with one camera
 * @property {number|null} speed how fast it was going (screen widths a second), where two cameras saw it arrive
 * @property {number|null} speedMph the same in miles an hour, if the screen's width was given in Setup
 * @property {number|null} towardWall how fast it was going straight at the wall (screen widths a second)
 * @property {number|null} elevation the angle its path rose at as it arrived, in degrees above level (below is negative), null if its flight isn't known
 * @property {number} frames the most frames a camera followed it for
 *
 * @typedef {object} TrackSeen one camera's path in a throw
 * @property {number} camera 0 main, 1 second
 * @property {TimedPoint[]} points t on the screen's clock (ms)
 * @property {Point[]} onScreen the same points through the camera's calibration (only right on the wall)
 * @property {string} verdict 'hit', or 'no hit: <why>'
 * @property {Point|null} hit where this camera saw it hit (screen)
 * @property {number} durationMs
 * @property {number} topSpeed fastest move between frames, in camera picture widths a second
 *
 * @typedef {object} ThrowSeen everything the cameras saw of one throw
 * @property {number} id
 * @property {number} time when it was first seen (screen's clock, ms)
 * @property {TrackSeen[]} tracks
 * @property {{path: import('./stereo.js').RoomPoint[], flight: ReturnType<typeof analyseFlight>}|null} room
 *   where both cameras saw it: its path through the room (screen widths) and what that says
 * @property {Hit|null} reported the hit the game was told about, if any
 */

export class ThrowTracker {
  /**
   * @param {object} args
   * @param {number} args.screenAspect the projected screen's height / width
   * @param {number|null} [args.screenWidthFt] its width in feet, for speeds in mph
   * @param {(hit: Hit) => void} args.onHit
   * @param {((seen: ThrowSeen) => void)|null} [args.onThrow] everything seen of a throw, once it is over
   */
  constructor({ screenAspect, screenWidthFt = null, onHit, onThrow = null }) {
    this.screenAspect = screenAspect;
    this.screenWidthFt = screenWidthFt;
    this.onHit = onHit;
    this.onThrow = onThrow;
    /** @type {Map<number, TrackerCamera & {seenTo: number, following: TimedPoint[]|null, blips: number}>} */
    this.cameras = new Map();
    /** @type {{parts: {camera: number, screen: Point, time: number}[], since: number}|null} a hit waiting for another camera */
    this.pending = null;
    /** @type {Hit[]} hits reported lately */
    this.reported = [];
    /** @type {(ThrowSeen & {start: number, end: number, lastAdded: number})[]} throws still being seen */
    this.openThrows = [];
    this.throwCount = 0;
  }

  /** @param {number} index @param {TrackerCamera} camera */
  addCamera(index, camera) {
    this.cameras.set(index, { ...camera, seenTo: -Infinity, following: null, blips: 0 });
  }

  /** The camera has stopped: a hit waiting for it waits no longer. */
  removeCamera(index, now) {
    this.cameras.delete(index);
    this.settle(now);
  }

  /** How many paths a camera saw in only one frame. */
  blipsOf(index) {
    return this.cameras.get(index)?.blips ?? 0;
  }

  /**
   * One camera's frame, after its detector has looked at it.
   * @param {number} index
   * @param {object} seen
   * @param {number} seen.time the frame's time (ms, before the camera's delay is taken off)
   * @param {number} seen.now when it was looked at (performance.now() ms)
   * @param {TimedPoint[]|null} seen.following the path being followed now, if any
   * @param {import('./hit-tracker.js').EndedTrack[]} seen.ended paths just finished
   * @param {import('./hit-tracker.js').Hit|null} seen.hit where this camera saw a ball hit
   */
  frame(index, { time, now, following = null, ended = [], hit = null }) {
    const camera = this.cameras.get(index);
    if (!camera) return;
    const shift = (p) => ({ x: p.x, y: p.y, t: p.t - camera.latencyMs });
    camera.seenTo = time - camera.latencyMs;
    camera.following = following?.length ? following.map(shift) : null;
    for (const track of ended) this.addTrack(index, track, now);
    if (hit) this.addHit(index, { screen: hit.screen, time: hit.time - camera.latencyMs }, now);
    this.settle(now);
    this.closeThrows(now);
  }

  // ---- Hits ----

  addHit(camera, part, now) {
    const { pending } = this;
    if (pending && Math.abs(part.time - pending.parts[0].time) < SAME_THROW_MS
      && !pending.parts.some((p) => p.camera === camera)) {
      pending.parts.push({ ...part, camera });
      return;
    }
    // Already reported, from another camera: the same throw, seen a little later.
    if (this.reported.some((h) => !h.cameras.includes(camera) && Math.abs(part.time - h.time) < SAME_THROW_MS)) return;
    if (pending) this.report(pending, now);
    this.pending = { parts: [{ ...part, camera }], since: now };
  }

  /** Reports the waiting hit once every other camera has seen it, seen past it, or isn't following a ball. */
  settle(now) {
    const { pending } = this;
    if (!pending) return;
    const { time } = pending.parts[0];
    const waitingFor = [...this.cameras].filter(([index, c]) => !pending.parts.some((p) => p.camera === index)
      && c.following && c.seenTo < time + FUSE_SEEN_PAST_MS);
    if (!waitingFor.length || now - pending.since >= FUSE_MAX_WAIT_MS) this.report(pending, now);
  }

  report(pending, now) {
    this.pending = null;
    const { parts } = pending;
    const mean = (f) => parts.reduce((s, p) => s + f(p), 0) / parts.length;
    const screen = { x: mean((p) => p.screen.x), y: mean((p) => p.screen.y) };
    const time = mean((p) => p.time);
    const spread = parts.length > 1
      ? Math.max(...parts.map((p) => Math.hypot(p.screen.x - screen.x, (p.screen.y - screen.y) * this.screenAspect))) * 2
      : null;
    const flight = this.flightBefore(time);
    const speed = flight?.speed ?? null;
    // Y is down the screen, so a rising ball has a negative Y velocity.
    const v = flight?.velocity;
    const elevation = v ? (Math.atan2(-v.y, Math.hypot(v.x, v.z)) * 180) / Math.PI : null;
    /** @type {Hit} */
    const hit = {
      x: Math.min(1, Math.max(0, screen.x)),
      y: Math.min(1, Math.max(0, screen.y)),
      time,
      cameras: parts.map((p) => p.camera).sort(),
      spread,
      speed,
      speedMph: speed !== null && this.screenWidthFt ? speed * this.screenWidthFt * FPS_TO_MPH : null,
      towardWall: flight?.towardWall ?? null,
      elevation,
      frames: Math.max(0, ...[...this.cameras.keys()].map((c) => this.pathOf(c, time - APPROACH_MS, time + SAME_THROW_MS).length)),
    };
    this.reported = [...this.reported.filter((h) => now - h.time < 5000), hit];
    this.onHit(hit);
  }

  /** The ball's flight through the room as it arrived for a hit at `time`, if two cameras followed it. */
  flightBefore(time) {
    const models = [...this.cameras].filter(([, c]) => c.model);
    if (models.length < 2) return null;
    const [[a, ca], [b, cb]] = models;
    const from = time - APPROACH_MS;
    const to = time + SAME_THROW_MS;
    const path = roomPath(ca.model, cb.model, this.pathOf(a, from, to), this.pathOf(b, from, to));
    return path.length ? analyseFlight(path, this.screenAspect) : null;
  }

  /** Everything a camera followed between two times (screen's clock): finished paths and the one being followed. */
  pathOf(index, from, to) {
    const camera = this.cameras.get(index);
    const points = this.openThrows.flatMap((th) => th.tracks.filter((tr) => tr.camera === index).flatMap((tr) => tr.points));
    if (camera?.following) points.push(...camera.following);
    return points.filter((p) => p.t >= from && p.t <= to).sort((p, q) => p.t - q.t);
  }

  // ---- Throws, as all the cameras saw them ----

  /** Adds a path a camera has finished following to the throw it belongs to. */
  addTrack(index, ended, now) {
    const camera = this.cameras.get(index);
    if (ended.points.length < 2) {
      camera.blips++;
      return;
    }
    const points = ended.points.map((p) => ({ x: p.x, y: p.y, t: p.t - camera.latencyMs }));
    let topSpeed = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      topSpeed = Math.max(topSpeed, (Math.hypot(b.x - a.x, (b.y - a.y) * camera.imageAspect) * 1000) / Math.max(1, b.t - a.t));
    }
    const toScreen = (p) => applyHomography(camera.cameraToScreen, p);
    /** @type {TrackSeen} */
    const track = {
      camera: index,
      points,
      onScreen: points.map(toScreen),
      verdict: ended.verdict,
      hit: ended.hit ? toScreen(ended.hit) : null,
      durationMs: points[points.length - 1].t - points[0].t,
      topSpeed,
    };
    const start = points[0].t;
    const end = points[points.length - 1].t;
    let seen = this.openThrows.find((th) => start <= th.end + THROW_JOIN_MS && end >= th.start - THROW_JOIN_MS);
    if (!seen) {
      seen = {
        id: ++this.throwCount, time: start, start, end, tracks: [], room: null, reported: null, lastAdded: now,
      };
      this.openThrows.push(seen);
    }
    seen.tracks.push(track);
    seen.start = Math.min(seen.start, start);
    seen.time = seen.start;
    seen.end = Math.max(seen.end, end);
    seen.lastAdded = now;
  }

  /**
   * Throws no camera has added to for a while, and that no camera is still following, are over:
   * works out their path through the room and passes them on.
   */
  closeThrows(now) {
    // Paths are only added when they end, so one still being followed may belong to an open throw.
    const following = [...this.cameras.values()].filter((c) => c.following).map((c) => c.following[0].t);
    const done = this.openThrows.filter((th) => now - th.lastAdded > THROW_WAIT_MS
      || (now - th.lastAdded > THROW_CLOSE_MS && !following.some((t) => t <= th.end + THROW_JOIN_MS)));
    if (!done.length) return;
    this.openThrows = this.openThrows.filter((th) => !done.includes(th));
    for (const seen of done) {
      seen.reported = this.reported.find((h) => h.time >= seen.start - THROW_JOIN_MS && h.time <= seen.end + THROW_JOIN_MS) ?? null;
      const models = [...this.cameras].filter(([, c]) => c.model);
      if (models.length >= 2) {
        const [[a, ca], [b, cb]] = models;
        const pathOf = (camera) => seen.tracks.filter((tr) => tr.camera === camera)
          .flatMap((tr) => tr.points).sort((p, q) => p.t - q.t);
        const path = roomPath(ca.model, cb.model, pathOf(a), pathOf(b));
        if (path.length) seen.room = { path, flight: analyseFlight(path, this.screenAspect) };
      }
      const { lastAdded, start, end, ...out } = seen;
      this.onThrow?.(out);
    }
  }
}
