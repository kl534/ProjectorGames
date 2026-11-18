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
// With two cameras, outside launch mode, a ball is only a hit if both saw it at the
// wall. A hit only one camera saw is dropped, unless the other camera followed the
// ball to the wall too (though it didn't judge that a hit itself: its sight line
// meets the first's at the wall), or its view of that spot was blocked by a person
// at the time (each camera's detector says where people are: see foreground.js):
// then it is reported from the one camera, as it would be if the other camera were
// not there. A hit both cameras saw is dropped too if their
// sight lines put it well in front of the wall (a person walking across the room is
// half a screen width or more out from it, a ball is at the wall), where they met
// well enough to say. A dropped hit says why on the throw it belongs to (`dropped`),
// for Ball Test's data. With one camera nothing changes, and launch mode, which checks
// the wall from both cameras for every turn, is as it was.
//
// A supporting hit (one camera saw the ball come only a short way across its
// picture, see minSupportApproach) never makes a hit by itself: it waits for
// another camera's hit to join, and is dropped if none comes.
//
// A game can also ask for flight hits (flightHits): a ball both cameras
// followed, flying fast at the wall, that neither saw hit the screen (it
// bounced off the floor first, flew over the top, or was lost) is reported
// from its flight alone, where it was heading on the wall, which may be off
// the screen (x or y outside 0–1), as soon as both have lost it.
//
// Where both cameras saw the ball arrive, their paths meet in the room
// (stereo.js), giving its speed and the way it was going as it hit. Only what
// they saw up to the moment it hit is used: after that it is coming back off
// the wall, and a camera's frame either side of the bounce would be
// interpolated into a point that was never on the ball's path. Every path a camera followed is also gathered
// into throws, each with what every camera saw and the ball's flight, for
// Ball Test's data.
//
// Launch mode (launch: a ball tossed to a batter, hit, flying at the wall)
// is different, because the ball isn't the only thing moving. The detectors
// follow several things at once, and end a path at each sharp turn, so each
// path is one stretch of flight (the toss, the flight off the bat, the
// rebound), and every turn on the screen is only a candidate. The room says
// which was the wall: where both cameras saw the ball then, the flight fitted
// to their sight lines just before the turn is at the wall, or the turn is
// dropped (the bat, the floor). A turn only one camera saw waits a moment: by
// then the other may have seen enough of the ball to say where it was, and if
// what both saw either side of it is one flight away from the wall, the ball
// never turned there (a pitch coming at a camera barely moves in its picture,
// and a jitter looks like a turn); otherwise a ball that leaves it much faster
// than it came was hit there (a ball never leaves a wall faster than it
// arrived). The end of a hit's rebound is not another hit. A camera's paths are
// never joined into one there: one path of each camera is paired, only while
// both were following it, and the fit says whether they are the same ball.
// Where both followed it in, the hit is put where their fitted flight crosses
// the wall, closer than either camera's nearest frame; and the start of that
// flight is how the ball left the bat (Hit.launch), at the moment the toss both
// cameras saw met it, if they did, else where it was first seen off the bat.
// One camera may have had it for much less of the flight than the other (it
// was out of its picture): all of what the other saw is used, and its few
// frames say how far away it was.

import { applyHomography, invertHomography } from './homography.js';
import {
  analyseFlight, fitBallistic, flightLines, isAtWall, isOffWall, launchAt, launchFit, meetingOf, pointAtHit, roomPath, sightLines,
} from './stereo.js';

// Hits from two cameras this close together (ms) are the same throw.
export const SAME_THROW_MS = 250;
// A hit waits for the other camera until it has seen this far (ms) past it without a hit…
const FUSE_SEEN_PAST_MS = 60;
// …or until this long (ms, real time) has passed, if that camera stalls.
const FUSE_MAX_WAIT_MS = 150;
// A supporting hit waits this long (ms, real time) for another camera's hit, while that camera follows a
// ball: a hit where the ball stopped is only known once it has been gone a while (maxGapMs).
const SUPPORT_WAIT_MS = 400;
// Where a camera saw people is remembered this long (ms)…
const PEOPLE_KEPT_MS = 1000;
// …and a camera's view of a spot was blocked if a person's box (grown by this much, a fraction of the picture's
// width) was over it within this long (ms) of a hit.
const BLOCK_WINDOW_MS = 100;
const BLOCK_MARGIN = 0.03;
// A hit is judged for being off the wall from what the cameras saw this close to it (ms).
const OFF_WALL_WINDOW_MS = 60;
// The room point a camera's path meets a hit's sight line at must be within this (screen widths) of the hit's spot.
const AT_WALL_SPOT_MAX = 0.1;
// Hits dropped are remembered this long (ms), for the throw they belong to.
const DROPPED_KEPT_MS = 6000;
// Camera names, for saying why a hit was dropped.
const CAMERA_NAMES = ['main', 'second'];
// Paths followed this close together (ms) belong to the same throw…
const THROW_JOIN_MS = 150;
// …and a throw is complete once no camera has added to it for this long (ms), and none is still
// following a path that may belong to it (but at most this long: something that never stops moving isn't a throw).
const THROW_CLOSE_MS = 450;
const THROW_WAIT_MS = 3000;
// Feet a second in miles an hour.
const FPS_TO_MPH = 3600 / 5280;
// Gravity, in feet a second².
const GRAVITY_FT = 32.174;
// A hit's speed is measured from the paths seen up to this long (ms) before it.
const APPROACH_MS = 400;
// A flight hit is looked for once no camera has added to the throw for this long (ms)…
const FLIGHT_WAIT_MS = 60;
// …and is only a ball if the cameras followed it for at least this many points (and as many arriving), agreeing within this
// (screen widths, on average), and it was flying at the wall at least this fast (screen widths a second)
// and at least this share of its speed (a steep pop-up is mostly going up).
const FLIGHT_MIN_POINTS = 6;
const FLIGHT_MAX_GAP = 0.03;
const FLIGHT_MIN_TOWARD = 2;
const FLIGHT_MIN_TOWARD_SHARE = 0.2;

// ---- Launch mode: which turn was the wall, and how the ball left the bat ----
// How a ball arrived at a turn is fitted over the last this long (ms) before it. (Not APPROACH_MS, which is
// longer than a batted ball's whole flight.)
const ARRIVAL_MS = 150;
// A flight is fitted to both cameras' sight lines only if each has this many in it…
const PAIR_MIN_LINES = 3;
// …and they fit it within this (screen widths, RMS).
const PAIR_MAX_RMS = 0.03;
// A turn is at the wall if the ball was this close to it (screen widths)…
const WALL_NEAR = 0.05;
// …or flying at it at least this fast (screen widths a second) and within this long (ms) of reaching it
// (the turn is seen in the frame before or after the bounce).
const WALL_MIN_TOWARD = 0.5;
const WALL_WITHIN_MS = 50;
// A turn only one camera saw waits until that camera has seen this far (ms) past it (at most
// CONFIRM_MAX_WAIT_MS, real time): if the ball leaves it more than SPEED_UP times as fast as it came,
// it was hit there. A ball never leaves the wall faster than it arrived.
const CONFIRM_MS = 50;
const CONFIRM_MAX_WAIT_MS = 150;
const SPEED_UP = 1.5;
// After a hit, turns for this long (ms) are its rebound (the detectors' own cooldown is off in launch mode).
const LAUNCH_COOLDOWN_MS = 300;
// The toss is looked for this long (ms) before the ball left the bat, among paths followed at least
// TOSS_MIN_MS, that fit a flight within TOSS_MAX_RMS (screen widths)…
const TOSS_MS = 600;
const TOSS_MIN_MS = 60;
const TOSS_MAX_RMS = 0.02;
// …and came within this (screen widths) of the ball's flight off the bat, no more than this long (ms)
// after the toss was last seen or before the ball was first seen.
const CONTACT_MAX_GAP = 0.15;
const CONTACT_SLACK_MS = 30;
// A flight hit waits for a camera still following something at most this long (ms): in launch mode
// something is nearly always being followed. (Paths still being followed are tried then too.)
const FLIGHT_MAX_WAIT_MS = 1000;
// A hit both cameras followed in is put where their fitted flight crosses the wall, unless that is further
// than this (screen widths) from where the cameras saw it turn.
const WALL_SPOT_MAX_MOVE = 0.08;
// Outside launch mode, a hit is put there only if the flight was fitted to at least this many points arriving.
const FIT_MIN_POINTS = 4;
// Turns taken to be the wall are remembered this long (ms).
const WALLS_KEPT_MS = 5000;

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
 * @property {boolean} fromFlight no camera saw it hit: it is where its flight was heading on the wall (a flight
 *   hit, only for a tracker with flightHits), and x and y may be off the screen
 * @property {'cameras'|'flight'} spotFrom where x and y are from: the cameras' own spots (averaged), or, in
 *   launch mode where both followed it in, where their fitted flight crosses the wall
 * @property {Launch|null} launch how it left the bat, where both cameras followed it from there (launch mode);
 *   else null
 *
 * @typedef {object} Launch how the ball left the bat, from both cameras (launch mode)
 * @property {number} speed screen widths a second
 * @property {number|null} speedMph miles an hour, if the screen's width was given in Setup
 * @property {number} elevation the angle it left at, degrees above level (below is negative)
 * @property {number} azimuth degrees to the right of straight at the wall (to the left is negative)
 * @property {{x:number, y:number, z:number}} point where it was then, in the room (screen widths; z is
 *   negative in front of the wall)
 * @property {number} time when (screen's clock, ms)
 * @property {'contact'|'first-seen'} from 'contact': where the toss both cameras saw met it; 'first-seen':
 *   no toss was seen by both, so this is where the first camera to have the ball off the bat first had it
 * @property {number|null} gap how nearly the toss and the hit met (screen widths), for 'contact'
 * @property {number} rms how well the cameras' sight lines fit the flight (screen widths)
 * @property {number} lines how many sight lines the fit used
 * @property {{points: TimedPoint[][], from: number, until: number}} legs what each camera followed of it
 *   (index 0 the main camera's path, 1 the second's), from when to when: for refining the lenses
 *
 * @typedef {object} TrackSeen one camera's path in a throw
 * @property {number} camera 0 main, 1 second
 * @property {TimedPoint[]} points t on the screen's clock (ms)
 * @property {Point[]} onScreen the same points through the camera's calibration (only right on the wall)
 * @property {string} verdict 'hit', or 'no hit: <why>'
 * @property {Point|null} hit where this camera saw it hit (screen)
 * @property {number|null} bounceAt when this camera saw it bounce, on the screen or outside it (screen's clock, ms), if it did
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
 * @property {string|null} dropped why a hit at this throw was dropped, if one was (see the top of this file)
 */

export class ThrowTracker {
  /**
   * @param {object} args
   * @param {number} args.screenAspect the projected screen's height / width
   * @param {number|null} [args.screenWidthFt] its width in feet, for speeds in mph
   * @param {(hit: Hit) => void} args.onHit
   * @param {((seen: ThrowSeen) => void)|null} [args.onThrow] everything seen of a throw, once it is over
   * @param {boolean} [args.flightHits] also report balls both cameras saw flying at the wall that neither saw
   *   hit the screen (Hit.fromFlight)
   * @param {boolean} [args.launch] launch mode: the detectors follow several things and split paths at each
   *   turn; a turn is a hit only where it was at the wall, and hits say how the ball left the bat (Hit.launch)
   */
  constructor({
    screenAspect, screenWidthFt = null, onHit, onThrow = null, flightHits = false, launch = false,
  }) {
    this.screenAspect = screenAspect;
    this.flightHits = flightHits;
    this.launch = launch;
    this.screenWidthFt = screenWidthFt;
    this.onHit = onHit;
    this.onThrow = onThrow;
    /** @type {Map<number, TrackerCamera & {seenTo: number, following: TimedPoint[][]|null, blips: number}>}
     *  following: every path the camera is following now */
    this.cameras = new Map();
    /** @type {{parts: {camera: number, screen: Point, time: number, support: boolean}[], since: number}|null}
     *  a hit waiting for another camera */
    this.pending = null;
    /** @type {Hit[]} hits reported lately */
    this.reported = [];
    /** @type {(ThrowSeen & {start: number, end: number, lastAdded: number})[]} throws still being seen */
    this.openThrows = [];
    this.throwCount = 0;
    /** Launch mode: turns on the screen that only one camera saw, waiting to see how the ball left them. */
    this.waiting = [];
    /** @type {{time: number, why: string, now: number}[]} hits dropped lately, and why */
    this.dropped = [];
    /** Launch mode: turns taken to be at the wall lately ({camera, time}): a path that starts at one is its rebound. */
    this.walls = [];
  }

  /** @param {number} index @param {TrackerCamera} camera */
  addCamera(index, camera) {
    this.cameras.set(index, {
      ...camera, seenTo: -Infinity, following: null, blips: 0, screenToCamera: invertHomography(camera.cameraToScreen), people: [],
    });
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
   * @param {TimedPoint[]|null} [seen.following] the path being followed now, if any…
   * @param {TimedPoint[][]|null} [seen.followingAll] …or every path being followed now (a detector with lanes)
   * @param {import('./hit-tracker.js').EndedTrack[]} seen.ended paths just finished
   * @param {import('./hit-tracker.js').Hit|null} [seen.hit] where this camera saw a ball hit…
   * @param {import('./hit-tracker.js').Hit[]|null} [seen.hits] …or every hit it saw in this frame
   * @param {{x0:number, y0:number, x1:number, y1:number}[]} [seen.people] where its detector saw people in this
   *   frame (normalised camera coords)
   */
  frame(index, {
    time, now, following = null, followingAll = null, ended = [], hit = null, hits = null, people = [],
  }) {
    const camera = this.cameras.get(index);
    if (!camera) return;
    const shift = (p) => ({ x: p.x, y: p.y, t: p.t - camera.latencyMs });
    const paths = (followingAll ?? (following?.length ? [following] : [])).filter((path) => path.length);
    const hitList = hits ?? (hit ? [hit] : []);
    camera.seenTo = time - camera.latencyMs;
    // Only frames with people in them are kept: a view is blocked only where someone was.
    camera.people = camera.people.filter((p) => camera.seenTo - p.t <= PEOPLE_KEPT_MS);
    if (people.length) camera.people.push({ t: camera.seenTo, boxes: people });
    if (this.launch) this.walls = this.walls.filter((w) => camera.seenTo - w.time < WALLS_KEPT_MS);
    camera.following = paths.length ? paths.map((path) => path.map(shift)) : null;
    const made = new Map(); // each path that ended in this frame -> its TrackSeen
    for (const track of ended) made.set(track, this.addTrack(index, track, now));
    for (const h of hitList) {
      const part = {
        screen: h.screen, time: h.time - camera.latencyMs, support: Boolean(h.support), seenAt: h.camera ?? null,
      };
      if (!this.launch) {
        this.addHit(index, part, now);
        continue;
      }
      // The path that ended in this turn (with splitAtHit, every hit ends one, in the same frame).
      const leg = made.get(ended.find((e) => e.hit && e.hit.t === h.time)) ?? null;
      this.addCandidate(index, part, leg, now);
    }
    if (this.launch) this.settleWaiting(now);
    this.settle(now);
    this.checkFlights(now);
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
    // Already reported, from another camera (or from its flight): the same throw, seen a little later.
    if (this.reported.some((h) => (h.fromFlight || !h.cameras.includes(camera)) && Math.abs(part.time - h.time) < SAME_THROW_MS)) return;
    if (pending) this.finish(pending, now);
    this.pending = { parts: [{ ...part, camera }], since: now };
  }

  /**
   * Reports the waiting hit once every other camera has seen it, seen past it, or isn't following a ball.
   * Supporting hits alone wait for another camera's hit while it follows a ball, and are dropped without one.
   */
  settle(now) {
    const { pending } = this;
    if (!pending) return;
    if (pending.parts.every((p) => p.support)) {
      const others = [...this.cameras].filter(([index, c]) => !pending.parts.some((p) => p.camera === index) && c.following);
      if (!others.length || now - pending.since >= SUPPORT_WAIT_MS) this.pending = null;
      return;
    }
    const { time } = pending.parts[0];
    // A camera following a ball is waited for until it has seen past the hit; outside launch mode, so is any
    // other that hasn't yet seen as far as the hit, to judge whether it was blocked there (see vetoOf).
    const waitingFor = [...this.cameras].filter(([index, c]) => !pending.parts.some((p) => p.camera === index)
      && (c.following ? c.seenTo < time + FUSE_SEEN_PAST_MS : !this.launch && c.seenTo < time));
    if (!waitingFor.length || now - pending.since >= FUSE_MAX_WAIT_MS) this.report(pending, now);
  }

  /** Reports a waiting hit, or drops it if it is only supporting hits. */
  finish(pending, now) {
    if (pending.parts.some((p) => !p.support)) this.report(pending, now);
    else if (this.pending === pending) this.pending = null;
  }

  report(pending, now) {
    this.pending = null;
    const { parts } = pending;
    const why = this.vetoOf(parts);
    if (why) {
      this.dropped.push({ time: parts[0].time, why, now });
      return;
    }
    const mean = (f) => parts.reduce((s, p) => s + f(p), 0) / parts.length;
    const screen = { x: mean((p) => p.screen.x), y: mean((p) => p.screen.y) };
    const time = mean((p) => p.time);
    const spread = parts.length > 1
      ? Math.max(...parts.map((p) => Math.hypot(p.screen.x - screen.x, (p.screen.y - screen.y) * this.screenAspect))) * 2
      : null;
    // Launch mode: where both cameras followed the ball to the wall, the two paths that arrived.
    const arrival = parts.find((p) => p.arrival)?.arrival ?? null;
    const pair = arrival && [
      [arrival.camera, this.cameras.get(arrival.camera), arrival.own],
      [arrival.partnerCamera, this.cameras.get(arrival.partnerCamera), arrival.partner],
    ];
    // In launch mode many things are followed at once, so the flight is that of the two paths that arrived.
    const flight = this.launch
      ? (pair && pair.every(([, c]) => c?.model) ? this.flightOf(pair, time) : null)
      : this.flightBefore(time);
    // Where the fitted flight crosses the wall, if the ball was flying at it: a camera's own spot is the blob
    // in the frame nearest the bounce, up to a frame's flight from the wall.
    let spot = screen;
    let spotFrom = 'cameras';
    // Outside launch mode, with both cameras on the ball, the same: each camera's spot is the blob in a frame
    // that may be a whole frame's flight (a hard throw is a quarter of a screen width) before or after the
    // wall, and seen from the side, so the flight both cameras' sight lines fit is the better spot.
    const toward = arrival ? arrival.fit.velocity.z * 1000 : (flight?.towardWall ?? 0);
    const fitted = arrival
      || (flight && parts.length > 1 && flight.arriving >= FIT_MIN_POINTS && flight.meanGap <= FLIGHT_MAX_GAP);
    if (fitted && flight?.hit && toward >= WALL_MIN_TOWARD
      && Math.hypot(flight.hit.x - screen.x, (flight.hit.y - screen.y) * this.screenAspect) <= WALL_SPOT_MAX_MOVE) {
      spot = flight.hit;
      spotFrom = 'flight';
    }
    this.tell({
      x: Math.min(1, Math.max(0, spot.x)),
      y: Math.min(1, Math.max(0, spot.y)),
      time,
      cameras: parts.map((p) => p.camera).sort(),
      spread,
      ...this.measured(flight),
      frames: Math.max(0, ...[...this.cameras.keys()].map((c) => this.pathOf(c, time - APPROACH_MS, time + SAME_THROW_MS).length)),
      fromFlight: false,
      spotFrom,
      launch: arrival ? this.measureLaunch(arrival.camera, arrival.own, arrival.partnerCamera, arrival.partner, time) : null,
    }, now);
  }

  /**
   * Why a hit waiting to be reported isn't one, or null. Outside launch mode with two cameras: a hit only one
   * camera saw, where the other had a clear view of the spot; a hit both saw, where their sight lines put the ball
   * well in front of the wall.
   * @param {{camera: number, screen: Point, time: number, seenAt: Point|null}[]} parts
   */
  vetoOf(parts) {
    if (this.launch) return null;
    return parts.length === 1 ? this.unseenByOther(parts[0]) : this.offTheWall(parts);
  }

  /**
   * A hit one camera saw is dropped if every other camera had a clear view of the spot, and has seen as far as
   * the hit, and didn't have the ball at the wall: it saw no ball hit there. A camera that hasn't (it stalled), or whose picture doesn't take in
   * the spot, can't say.
   */
  unseenByOther(part) {
    const others = [...this.cameras].filter(([index]) => index !== part.camera);
    if (!others.length) return null;
    const margin = (c) => ({ x: BLOCK_MARGIN, y: BLOCK_MARGIN / c.imageAspect });
    for (const [index, c] of others) {
      if (c.seenTo < part.time || !c.screenToCamera) return null;
      // It followed the ball to the wall, though it didn't judge that a hit (a bounce too flat to count, say):
      // it saw the ball there.
      if (this.sawBallAtWall(part, index)) return null;
      const spot = applyHomography(c.screenToCamera, part.screen);
      if (!(spot.x >= 0 && spot.x <= 1 && spot.y >= 0 && spot.y <= 1)) return null;
      const m = margin(c);
      const blocked = c.people.some((seen) => Math.abs(seen.t - part.time) <= BLOCK_WINDOW_MS && seen.boxes.some((b) => (
        spot.x >= b.x0 - m.x && spot.x <= b.x1 + m.x && spot.y >= b.y0 - m.y && spot.y <= b.y1 + m.y)));
      if (blocked) return null;
    }
    const [[other]] = others;
    return `only the ${CAMERA_NAMES[part.camera]} camera saw it, and the ${CAMERA_NAMES[other]} camera's view of that spot was clear`;
  }

  /**
   * Whether another camera had the ball at the wall when this part's camera saw it hit: it followed something
   * near then, and its sight line through that meets the hit camera's (through the hit, or its own path) at the wall.
   */
  sawBallAtWall(part, other) {
    const [ca, cb] = [this.cameras.get(part.camera), this.cameras.get(other)];
    if (!ca?.model || !cb?.model) return false;
    const path = (camera) => this.pathOf(camera, part.time - OFF_WALL_WINDOW_MS, part.time + OFF_WALL_WINDOW_MS);
    const theirs = path(other);
    if (!theirs.length) return false;
    const found = pointAtHit(ca.model, cb.model, path(part.camera), theirs, part.time, part.seenAt, null);
    // …and at the spot the hit was seen at, not elsewhere along the sight line (the wall's whole width is on it).
    return isAtWall(found)
      && Math.hypot(found.point.x - part.screen.x, found.point.y - part.screen.y * this.screenAspect) <= AT_WALL_SPOT_MAX;
  }

  /** A hit both cameras saw is dropped if their sight lines put it well in front of the wall (see stereo.js). */
  offTheWall(parts) {
    const [a, b] = parts;
    const [ca, cb] = [this.cameras.get(a.camera), this.cameras.get(b.camera)];
    if (!ca?.model || !cb?.model) return null;
    const time = (a.time + b.time) / 2;
    const found = pointAtHit(
      ca.model, cb.model,
      this.pathOf(a.camera, time - OFF_WALL_WINDOW_MS, time + OFF_WALL_WINDOW_MS),
      this.pathOf(b.camera, time - OFF_WALL_WINDOW_MS, time + OFF_WALL_WINDOW_MS),
      time, a.seenAt, b.seenAt,
    );
    if (!isOffWall(found)) return null;
    const away = -found.point.z;
    return `both cameras saw it, but put it ${away.toFixed(2)} screen widths in front of the wall`;
  }

  /** @param {Hit} hit */
  tell(hit, now) {
    this.reported = [...this.reported.filter((h) => now - h.time < 5000), hit];
    this.onHit(hit);
  }

  /** What a hit says about the ball's flight, if it is known. */
  measured(flight) {
    const speed = flight?.speed ?? null;
    // Y is down the screen, so a rising ball has a negative Y velocity.
    const v = flight?.velocity;
    return {
      speed,
      speedMph: speed !== null && this.screenWidthFt ? speed * this.screenWidthFt * FPS_TO_MPH : null,
      towardWall: flight?.towardWall ?? null,
      elevation: v ? (Math.atan2(-v.y, Math.hypot(v.x, v.z)) * 180) / Math.PI : null,
    };
  }

  // ---- Flight hits: a ball both cameras saw flying at the wall, that neither saw hit the screen ----

  /**
   * Looks at each throw both cameras have finished following that no hit came of: if its flight was a ball
   * flying fast at the wall, reports it, where it was heading. Its flight ends where a camera saw it bounce
   * outside the screen (off the floor), if one did; otherwise where they lost it (over the top).
   */
  checkFlights(now) {
    if (!this.flightHits) return;
    const models = [...this.cameras].filter(([, c]) => c.model);
    if (models.length < 2) return;
    const [[a, ca], [b, cb]] = models;
    const following = [...this.cameras.values()].filter((c) => c.following)
      .map((c) => Math.min(...c.following.map((path) => path[0].t)));
    for (const seen of this.openThrows) {
      if (seen.flightChecked || now - seen.lastAdded < FLIGHT_WAIT_MS) continue;
      const waited = this.launch && now - seen.lastAdded > FLIGHT_MAX_WAIT_MS;
      if (!waited && following.some((t) => t <= seen.end + THROW_JOIN_MS)) continue;
      const during = (t) => t >= seen.start - THROW_JOIN_MS && t <= seen.end + SAME_THROW_MS;
      // A hit from it may still be waiting for the other camera (or, in launch mode, to see how the ball left).
      if (this.pending && during(this.pending.parts[0].time)) continue;
      if (this.waiting.some((w) => during(w.part.time))) continue;
      seen.flightChecked = true;
      if (this.reported.some((h) => during(h.time))) continue;
      const tracksOf = (camera) => seen.tracks.filter((tr) => tr.camera === camera);
      const joined = (camera) => tracksOf(camera).flatMap((tr) => tr.points).sort((p, q) => p.t - q.t);
      // Launch mode follows many things at once: each pair of paths is tried, and the best flight among them
      // is the ball's. Otherwise all a camera followed is one path, as before.
      // (A path still being followed counts: one camera may follow the ball on past where the other saw it bounce.
      // But only one that began during this throw: a ball lost round the bat for a moment is picked up again on
      // a path of a later throw, still flying at the wall, which would otherwise be reported from here, before
      // it got there, and its real hit dropped as too soon after.)
      const legsOf = (camera) => [
        ...tracksOf(camera).map((tr) => ({ points: tr.points, bounceAt: tr.bounceAt })),
        ...(this.cameras.get(camera).following ?? []).filter((points) => points[0].t <= seen.end + THROW_JOIN_MS)
          .map((points) => ({ points, bounceAt: null })),
      ];
      // A pair is only looked at while both were following it: one camera's path can run on through the bounce
      // (it saw no turn there), and its lines from before the other's path began would make a flight of the
      // rebound and what came before it together.
      const together = (pa, pb) => {
        const from = Math.max(pa[0].t, pb[0].t);
        const to = Math.min(pa[pa.length - 1].t, pb[pb.length - 1].t);
        const within = (path) => path.filter((p) => p.t >= from && p.t <= to);
        return [within(pa), within(pb)];
      };
      const pairs = this.launch
        ? legsOf(a).flatMap((la) => legsOf(b).map((lb) => [...together(la.points, lb.points), [la.bounceAt, lb.bounceAt]]))
        : [[joined(a), joined(b), seen.tracks.map((tr) => tr.bounceAt)]];
      let best = null;
      for (const [pathA, pathB, bounced] of pairs) {
        if (!pathA.length || !pathB.length) continue;
        const bounces = bounced.filter((t) => t !== null);
        const until = bounces.length ? Math.min(...bounces) : null;
        const flight = this.flightOf([[a, ca, pathA], [b, cb, pathB]], until);
        if (isFlying(flight) && (!best || flight.points > best.flight.points)) best = { flight, until, pathA, pathB };
      }
      if (!best) continue;
      const { flight, until, pathA, pathB } = best;
      const time = until ?? flight.closest.t;
      this.tell({
        x: flight.hit.x,
        y: flight.hit.y,
        time,
        cameras: [a, b].sort(),
        spread: null,
        ...this.measured(flight),
        frames: Math.max(pathA.length, pathB.length),
        fromFlight: true,
        spotFrom: 'cameras',
        launch: this.launch ? this.measureLaunch(a, pathA, b, pathB, time) : null,
      }, now);
    }
  }

  /** The ball's flight through the room as it arrived for a hit at `time`, if two cameras followed it. */
  flightBefore(time) {
    const models = [...this.cameras].filter(([, c]) => c.model);
    if (models.length < 2) return null;
    const [[a, ca], [b, cb]] = models;
    const from = time - APPROACH_MS;
    return this.flightOf([[a, ca, this.pathOf(a, from, time)], [b, cb, this.pathOf(b, from, time)]], time);
  }

  /**
   * The flight two cameras saw up to `until` (if known): their paths met in the room, and the flight fitted
   * to their sight lines. Null if their paths never overlapped.
   * @param {[number, TrackerCamera, TimedPoint[]][]} seen each camera, with what it followed
   */
  flightOf([[a, ca, pathA], [b, cb, pathB]], until) {
    const before = (path) => (until === null ? path : path.filter((p) => p.t <= until));
    const [beforeA, beforeB] = [before(pathA), before(pathB)];
    const path = roomPath(ca.model, cb.model, beforeA, beforeB);
    if (!path.length) return null;
    const lines = [...sightLines(ca.model, beforeA, a), ...sightLines(cb.model, beforeB, b)];
    return analyseFlight(path, this.screenAspect, { until, gravity: this.gravity, lines });
  }

  /** Gravity in screen widths a second², if the screen's width is known (else none). */
  get gravity() {
    return this.screenWidthFt ? GRAVITY_FT / this.screenWidthFt : 0;
  }

  /** Everything a camera followed between two times (screen's clock): finished paths and the one being followed. */
  pathOf(index, from, to) {
    const camera = this.cameras.get(index);
    const points = this.openThrows.flatMap((th) => th.tracks.filter((tr) => tr.camera === index).flatMap((tr) => tr.points));
    if (camera?.following) points.push(...camera.following.flat());
    return points.filter((p) => p.t >= from && p.t <= to).sort((p, q) => p.t - q.t);
  }

  // ---- Launch mode: which turn was the wall, and how the ball left the bat ----

  /** Every path a camera has followed lately (in throws still open) or is following: each a TimedPoint[]. */
  pathsOf(index) {
    const finished = this.openThrows.flatMap((th) => th.tracks.filter((tr) => tr.camera === index).map((tr) => tr.points));
    return [...finished, ...(this.cameras.get(index)?.following ?? [])];
  }

  /**
   * Launch mode: a turn one camera saw on the screen. A hit only if it was at the wall: the bat, the floor in
   * front of the screen and the end of a rebound turn the ball too.
   * @param {number} index the camera
   * @param {{screen: Point, time: number, support: boolean}} part the turn, on the screen's clock
   * @param {TrackSeen|null} leg the path that ended in it
   */
  addCandidate(index, part, leg, now) {
    // The path began at a turn already taken to be the wall: this is how its rebound ended.
    if (leg && this.walls.some((w) => w.camera === index && w.time === leg.points[0].t)) return;
    const arrival = leg ? this.arrival(index, part.time, leg) : null;
    // Both cameras saw the ball then, and it was not at the wall.
    if (arrival && !arrival.atWall) return;
    const joins = this.pending && Math.abs(part.time - this.pending.parts[0].time) < SAME_THROW_MS
      && !this.pending.parts.some((p) => p.camera === index);
    if (!joins && this.reported.some((h) => Math.abs(part.time - h.time) < LAUNCH_COOLDOWN_MS)) {
      this.walls.push({ camera: index, time: part.time });
      return;
    }
    if (arrival) part.arrival = arrival;
    if (arrival || joins || part.support || !leg) {
      this.walls.push({ camera: index, time: part.time });
      this.addHit(index, part, now);
    } else {
      this.waiting.push({ camera: index, part, leg, since: now });
    }
  }

  /**
   * Where the ball was, and how it was flying, as the path `leg` (one camera's) ended at `time`: fitted to that
   * path's sight lines and those of whichever path of another camera fits a flight with them best, from where
   * they became one flight (flightLines: a path begins at the turn the last one ended in, and with the ball
   * hidden round the bat that point is on the toss). Null if no other camera followed it then. With `after`
   * (ms), what both saw that long after `time` is fitted too, all of it: one flight right through the turn.
   * @param {number} index @param {number} time @param {{points: TimedPoint[]}} leg @param {number} [after]
   * @returns {{fit: object, atWall: boolean, camera: number, own: TimedPoint[], partnerCamera: number,
   *   partner: TimedPoint[]}|null}
   */
  arrival(index, time, leg, after = 0) {
    const own = this.cameras.get(index);
    if (!own?.model) return null;
    const lately = (points) => points.filter((p) => p.t >= time - ARRIVAL_MS && p.t <= time + after);
    const mine = sightLines(own.model, lately(leg.points), index);
    if (mine.length < PAIR_MIN_LINES) return null;
    let best = null;
    for (const [other, camera] of this.cameras) {
      if (other === index || !camera.model) continue;
      for (const path of this.pathsOf(other)) {
        const theirs = sightLines(camera.model, lately(path), other);
        if (theirs.length < PAIR_MIN_LINES) continue;
        const g = this.gravity / 1e6;
        const flight = after ? [...mine, ...theirs] : flightLines([...mine, ...theirs], g, time);
        if (!flight || [index, other].some((c) => flight.filter((l) => l.camera === c).length < PAIR_MIN_LINES)) continue;
        const fit = fitBallistic(flight, g, time);
        if (!fit || fit.rms > PAIR_MAX_RMS) continue;
        if (!best || fit.rms < best.fit.rms) best = { fit, camera: index, own: leg.points, partnerCamera: other, partner: path };
      }
    }
    if (!best) return null;
    const { at, velocity } = best.fit; // velocity per ms
    const toWall = velocity.z > 0 ? -at.z / velocity.z : Infinity; // ms until it reaches the wall; negative: just past it
    best.atWall = Math.abs(at.z) <= WALL_NEAR
      || (velocity.z * 1000 >= WALL_MIN_TOWARD && Math.abs(toWall) <= WALL_WITHIN_MS);
    return best;
  }

  /**
   * Launch mode: turns only one camera saw. Once that camera has seen a moment past one: if the ball left it
   * much faster than it came, it was hit there (the bat); otherwise it is a hit on the screen.
   */
  settleWaiting(now) {
    const still = [];
    for (const w of this.waiting) {
      const camera = this.cameras.get(w.camera);
      if (camera && camera.seenTo < w.part.time + CONFIRM_MS && now - w.since < CONFIRM_MAX_WAIT_MS) {
        still.push(w);
        continue;
      }
      // The other camera may not have had enough of the ball yet when the turn was seen: where both have it
      // now, the room says whether it was at the wall.
      const arrival = this.arrival(w.camera, w.part.time, w.leg);
      if (arrival && !arrival.atWall) continue;
      if (arrival) {
        w.part.arrival = arrival;
      } else {
        // The path that began at the turn (HitTracker.splitAt): how the ball left it.
        const after = camera && this.pathsOf(w.camera).find((path) => path !== w.leg.points && path[0].t === w.part.time);
        // Just after a pitch leaves the hand, coming at a camera behind the batter, its blob barely moves and a
        // jitter is a turn, before the other camera has seen enough of it to say where it was. If what both saw
        // either side of the turn is one flight, the ball never turned: if that wasn't at the wall, it is no hit.
        // (Off the wall or the bat, the two sides are never one flight.)
        const through = after && this.arrival(w.camera, w.part.time, { points: [...w.leg.points, ...after.slice(1)] }, CONFIRM_MS);
        if (through && !through.atWall) continue;
        const left = after ? topSpeedOf(after.filter((p) => p.t <= w.part.time + CONFIRM_MS), camera.imageAspect) : 0;
        if (left > SPEED_UP * w.leg.topSpeed) continue;
      }
      this.walls.push({ camera: w.camera, time: w.part.time });
      this.addHit(w.camera, w.part, now);
    }
    this.waiting = still;
  }

  /**
   * How the ball left the bat, for the flight two cameras' paths show arriving at `until`. Null if their
   * sight lines aren't one flight.
   * @param {number} a a camera @param {TimedPoint[]} pathA what it followed @param {number} b the other
   * @param {TimedPoint[]} pathB @param {number} until when the flight ended (the hit, the bounce)
   * @returns {Launch|null}
   */
  measureLaunch(a, pathA, b, pathB, until) {
    const [ca, cb] = [this.cameras.get(a), this.cameras.get(b)];
    if (!ca?.model || !cb?.model) return null;
    const g = this.gravity / 1e6;
    const fit = launchFit([...sightLines(ca.model, pathA, a), ...sightLines(cb.model, pathB, b)], g, until);
    if (!fit) return null;
    const from = fit.tRef;
    // The toss: a path of each camera from before then, that is a flight too, and meets this one.
    const before = (path) => path.filter((p) => p.t < from && p.t >= from - TOSS_MS);
    const long = (points) => points.length >= PAIR_MIN_LINES && points[points.length - 1].t - points[0].t >= TOSS_MIN_MS;
    let met = null;
    for (const pa of this.pathsOf(a).map(before).filter(long)) {
      for (const pb of this.pathsOf(b).map(before).filter(long)) {
        const toss = fitBallistic([...sightLines(ca.model, pa, a), ...sightLines(cb.model, pb, b)], g, from);
        if (!toss || toss.rms > TOSS_MAX_RMS) continue;
        const last = Math.max(pa[pa.length - 1].t, pb[pb.length - 1].t);
        const meeting = meetingOf(toss, fit, last - CONTACT_SLACK_MS, from + CONTACT_SLACK_MS);
        if (meeting.gap <= CONTACT_MAX_GAP && (!met || meeting.gap < met.gap)) met = meeting;
      }
    }
    const time = met ? met.t : from;
    const left = launchAt(fit, time);
    const byCamera = a < b ? [pathA, pathB] : [pathB, pathA];
    return {
      speed: left.speed,
      speedMph: this.screenWidthFt ? left.speed * this.screenWidthFt * FPS_TO_MPH : null,
      elevation: left.elevation,
      azimuth: left.azimuth,
      point: left.point,
      time,
      from: met ? 'contact' : 'first-seen',
      gap: met ? met.gap : null,
      rms: fit.rms,
      lines: fit.count,
      legs: { points: byCamera.map((path) => path.filter((p) => p.t >= from && p.t <= until)), from, until },
    };
  }

  // ---- Throws, as all the cameras saw them ----

  /**
   * Adds a path a camera has finished following to the throw it belongs to.
   * @returns {TrackSeen|null} what was kept of it (null for a blip seen in one frame)
   */
  addTrack(index, ended, now) {
    const camera = this.cameras.get(index);
    if (ended.points.length < 2) {
      camera.blips++;
      return null;
    }
    const points = ended.points.map((p) => ({ x: p.x, y: p.y, t: p.t - camera.latencyMs }));
    const topSpeed = topSpeedOf(points, camera.imageAspect);
    const toScreen = (p) => applyHomography(camera.cameraToScreen, p);
    /** @type {TrackSeen} */
    const track = {
      camera: index,
      points,
      onScreen: points.map(toScreen),
      verdict: ended.verdict,
      hit: ended.hit ? toScreen(ended.hit) : null,
      bounceAt: (ended.bounce ?? ended.hit) ? (ended.bounce ?? ended.hit).t - camera.latencyMs : null,
      durationMs: points[points.length - 1].t - points[0].t,
      topSpeed,
    };
    const start = points[0].t;
    const end = points[points.length - 1].t;
    let seen = this.openThrows.find((th) => start <= th.end + THROW_JOIN_MS && end >= th.start - THROW_JOIN_MS);
    if (!seen) {
      seen = {
        id: ++this.throwCount, time: start, start, end, tracks: [], room: null, reported: null, dropped: null, lastAdded: now, flightChecked: false,
      };
      this.openThrows.push(seen);
    }
    seen.tracks.push(track);
    seen.start = Math.min(seen.start, start);
    seen.time = seen.start;
    seen.end = Math.max(seen.end, end);
    seen.lastAdded = now;
    return track;
  }

  /**
   * Throws no camera has added to for a while, and that no camera is still following, are over:
   * works out their path through the room and passes them on.
   */
  closeThrows(now) {
    // Paths are only added when they end, so one still being followed may belong to an open throw.
    const following = [...this.cameras.values()].filter((c) => c.following)
      .map((c) => Math.min(...c.following.map((path) => path[0].t)));
    this.dropped = this.dropped.filter((d) => now - d.now < DROPPED_KEPT_MS);
    const done = this.openThrows.filter((th) => now - th.lastAdded > THROW_WAIT_MS
      || (now - th.lastAdded > THROW_CLOSE_MS && !following.some((t) => t <= th.end + THROW_JOIN_MS)));
    if (!done.length) return;
    this.openThrows = this.openThrows.filter((th) => !done.includes(th));
    for (const seen of done) {
      seen.reported = this.reported.find((h) => h.time >= seen.start - THROW_JOIN_MS && h.time <= seen.end + THROW_JOIN_MS) ?? null;
      seen.dropped = this.dropped.find((d) => d.time >= seen.start - THROW_JOIN_MS && d.time <= seen.end + THROW_JOIN_MS)?.why ?? null;
      const models = [...this.cameras].filter(([, c]) => c.model);
      if (models.length >= 2) {
        const [[a, ca], [b, cb]] = models;
        const pathOf = (camera) => {
          const tracks = seen.tracks.filter((tr) => tr.camera === camera);
          if (!this.launch) return tracks.flatMap((tr) => tr.points).sort((p, q) => p.t - q.t);
          // Many things were followed: the ball's path is the one that hit, or else the longest.
          const hit = tracks.filter((tr) => tr.hit).pop();
          const longest = tracks.reduce((x, y) => (y.points.length > x.points.length ? y : x), tracks[0]);
          return (hit ?? longest)?.points ?? [];
        };
        const path = roomPath(ca.model, cb.model, pathOf(a), pathOf(b));
        // Its flight from what was seen up to the hit, if one was reported (as the hit had it).
        const flight = this.flightOf([[a, ca, pathOf(a)], [b, cb, pathOf(b)]], seen.reported?.time ?? null);
        if (path.length) seen.room = { path, flight: flight ?? analyseFlight(path, this.screenAspect, { gravity: this.gravity }) };
      }
      const {
        lastAdded, start, end, flightChecked, ...out
      } = seen;
      this.onThrow?.(out);
    }
  }
}

/** The fastest move between two points of a path, in camera picture widths a second. */
function topSpeedOf(points, imageAspect) {
  let top = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    top = Math.max(top, (Math.hypot(b.x - a.x, (b.y - a.y) * imageAspect) * 1000) / Math.max(1, b.t - a.t));
  }
  return top;
}

/** Whether a flight the cameras saw was a ball flying fast at the wall (see checkFlights). */
function isFlying(flight) {
  if (!flight || flight.speed === null || !flight.hit) return false;
  if (!Number.isFinite(flight.hit.x) || !Number.isFinite(flight.hit.y)) return false;
  // Seen arriving: a rebound is nearest the wall where it starts, so it has next to nothing before then.
  return flight.points >= FLIGHT_MIN_POINTS && flight.arriving >= FLIGHT_MIN_POINTS && flight.meanGap <= FLIGHT_MAX_GAP
    && flight.towardWall >= Math.max(FLIGHT_MIN_TOWARD, FLIGHT_MIN_TOWARD_SHARE * flight.speed);
}
