// The tracking half of the hit detector: follows one ball blob from frame to
// frame and says where it hit. Works on blob positions, so it can be unit-tested
// without a browser or any pictures.
//
// Hit: a ball flying at the wall moves steadily towards the spot it will hit,
// then bounces back or drops. A sharp change of direction is therefore a hit.
// A ball that slows to a stop on a straight path (it stuck, or vanished at
// the wall) is also a hit, where it was last seen.
// A ball lobbed at the wall often doesn't turn sharply: it arrives slowing
// down (it is moving away from the camera), then drops down the wall
// speeding up. That is a hit too, where the drop starts.
//
// Positions are normalised camera coordinates (0–1 across and down the camera
// picture); distances are fractions of the frame width, so x and y are measured alike.
//
// Where the foreground is a person (or a shadow: see foreground.js) nothing is
// followed, so a ball that vanishes into that zone is lost there, not judged:
// what was left of it may be a hand or an edge.
//
// Each throw it follows ends with a verdict (a hit, or why it wasn't one),
// shown in the camera view so a missed throw can be put right. Every path it
// followed is kept too (takeEnded), with its verdict, for Ball Test's data and
// for matching up what two cameras saw.
//
// A throw must travel far enough across the picture (minApproach) to count
// by itself. One that travels less (a camera behind the thrower sees the ball
// fly mostly away from it) but still minSupportApproach is a supporting hit:
// it only counts alongside another camera's hit (ThrowTracker), adding its
// spot and its view of the flight.
//
// Launch mode (a ball tossed, hit with a bat, flying at the wall) needs more:
// with splitAtHit a path ends at each sharp turn and another starts there, so
// each path is one stretch of flight (the toss, the flight off the bat, the
// rebound) and every turn on the screen is reported; and LaneTracker follows
// several things at once (the toss, the bat, the ball), a HitTracker for each,
// so the batted ball is picked up on its first frame. Which turn was the wall
// is ThrowTracker's to say, from both cameras.

import { applyHomography } from './homography.js';

/**
 * @typedef {{x:number, y:number}} Point
 * @typedef {{camera: Point, screen: Point, time: number, support?: boolean}} Hit time: when the camera saw the
 *   impact (ms); support: it came too short a way across the picture to count by itself (see minSupportApproach)
 * @typedef {{x:number, y:number, area:number}} Blob
 * @typedef {object} EndedTrack a path followed to its end
 * @property {{x:number, y:number, t:number}[]} points where the ball was seen (normalised camera coords, frame time ms)
 * @property {{x:number, y:number, t:number}|null} hit where it hit, if it was a hit
 * @property {{x:number, y:number, t:number}|null} bounce where it bounced outside the screen (off the floor, say), if it did
 * @property {string} verdict 'hit', 'supporting hit', or 'no hit: <why>'
 */

// Ended tracks kept until taken (takeEnded), at most.
const MAX_ENDED = 20;

export class HitTracker {
  /**
   * @param {object} args
   * @param {number} args.aspect camera frame height / width
   * @param {number[]} args.cameraToScreen homography, normalised camera -> normalised screen coords
   * @param {number[]} args.screenToCamera its inverse
   * @param {object} args.opts the detector's settings (HIT_DETECTOR_DEFAULTS with any overrides)
   * @param {{stillSpots: {x:number, y:number, until:number}[], lastHitAt: number}} [args.shared] where things
   *   stopped and when the last hit was, if shared with other trackers (LaneTracker's lanes)
   * @param {(p: Point) => boolean} [args.personAt] whether a camera point is in the person zone now
   */
  constructor({
    aspect, cameraToScreen, screenToCamera, opts, shared = { stillSpots: [], lastHitAt: -Infinity }, personAt = () => false,
  }) {
    this.personAt = personAt;
    this.aspect = aspect;
    this.cameraToScreen = cameraToScreen;
    this.screenToCamera = screenToCamera;
    this.opts = opts;
    this.track = null;
    // Places where something stopped ([{x, y, until}]), and when the last hit was: shared by all the lanes of
    // a LaneTracker.
    this.shared = shared;
    // How the last throw followed ended, for display: 'hit', or 'no hit: <why>'. Null before the first.
    this.verdict = null;
    /** @type {EndedTrack[]} paths followed to their end, oldest first, until taken */
    this.ended = [];
  }

  /** Drops the ball being followed, e.g. when the picture changed under it. */
  reset() {
    if (this.track && !this.track.done && this.track.points.length > 1) {
      this.track.verdict = 'no hit: dropped, the picture changed';
    }
    this.keepEnded(this.track);
    this.track = null;
  }

  /** The paths followed to their end since the last call, oldest first. */
  takeEnded() {
    const { ended } = this;
    this.ended = [];
    return ended;
  }

  keepEnded(track) {
    if (!track) return;
    const n = track.points.length;
    this.ended.push({
      points: track.points,
      hit: track.hit ?? null,
      bounce: track.bounce ?? null,
      verdict: track.verdict ?? `no hit: seen in only ${n} frame${n === 1 ? '' : 's'}`,
    });
    if (this.ended.length > MAX_ENDED) this.ended.shift();
  }

  /** The path of the ball being followed, for display. */
  get points() {
    return this.track ? this.track.points.map(({ x, y }) => ({ x, y })) : [];
  }

  /**
   * Feeds the ball blobs seen in the next frame.
   * @param {Blob[]} blobs
   * @param {number} t frame time in ms
   * @returns {Hit|null}
   */
  update(blobs, t) {
    const { maxGapMs, turnLength, stillMs } = this.opts;
    let hit = null;
    if (this.track && t - this.track.lastT > maxGapMs) hit = this.endTrack();
    this.shared.stillSpots = this.shared.stillSpots.filter((s) => s.until > t);

    if (blobs.length) {
      if (this.track) {
        const pts = this.track.points;
        const best = this.claim(blobs, t);
        if (best) {
          pts.push({ x: best.x, y: best.y, t });
          this.track.lastT = t;
          // Something that has stopped moving: end the track there.
          let m = pts.length - 1;
          while (m > 0 && this.dist(pts[m - 1], best) < turnLength / 2) m--;
          if (t - pts[m].t >= stillMs) {
            this.shared.stillSpots.push({ x: best.x, y: best.y, until: t + this.opts.stillSpotMs });
            hit = this.endTrack() ?? hit;
          }
        }
      } else {
        const fresh = blobs.filter((b) => {
          const spot = this.shared.stillSpots.find((s) => this.dist(b, s) < turnLength * 2);
          if (spot) spot.until = t + this.opts.stillSpotMs; // still there
          return !spot;
        });
        if (fresh.length) {
          const biggest = fresh.reduce((a, b) => (b.area > a.area ? b : a));
          this.track = { points: [{ x: biggest.x, y: biggest.y, t }], lastT: t, done: false, checked: 0 };
        }
      }
    }

    if (!hit && this.track && !this.track.done) {
      const k = this.findTurn(this.track) ?? this.findDrop(this.track);
      if (k !== null) {
        hit = this.reportHit(this.track.points[k], t);
        if (this.opts.splitAtHit) this.splitAt(k);
      }
    }
    return hit;
  }

  /** The blob the ball being followed has most likely become in a frame at time t, or null. */
  claim(blobs, t) {
    if (!this.track || !blobs.length) return null;
    const { gateDistance, turnLength } = this.opts;
    const pts = this.track.points;
    const last = pts[pts.length - 1];
    const prev = pts.length > 1 ? pts[pts.length - 2] : last;
    // Where it would be now at the same speed (frames needn't be evenly spaced).
    const k = last.t > prev.t ? (t - last.t) / (last.t - prev.t) : 0;
    const predicted = { x: last.x + k * (last.x - prev.x), y: last.y + k * (last.y - prev.y) };
    let best = null;
    // Its recent step: the larger of the last two (it may be seen in the same place twice).
    const step = Math.max(this.dist(last, prev), pts.length > 2 ? this.dist(prev, pts[pts.length - 3]) : 0);
    let bestDist = pts.length > 1
      ? Math.min(gateDistance, Math.max(3 * turnLength, this.opts.gateSteps * Math.min(k, 2) * step))
      : gateDistance;
    for (const b of blobs) {
      const d = Math.min(this.dist(b, predicted), this.dist(b, last));
      if (d < bestDist) {
        best = b;
        bestDist = d;
      }
    }
    return best;
  }

  /**
   * Ends the path at its turn (point k) and starts another there: what comes after a turn is another stretch
   * of flight (off the bat, off the wall), which may turn again. Whether the turn was a hit or not.
   */
  splitAt(k) {
    const track = this.track;
    const rest = track.points.slice(k);
    track.points = track.points.slice(0, k + 1);
    this.keepEnded(track);
    this.track = { points: rest, lastT: track.lastT, done: false, checked: 0 };
  }

  /**
   * Looks for a bounce among the points whose direction can now be judged.
   * Returns the index of the sharpest turn, or null.
   */
  findTurn(track) {
    const pts = track.points;
    for (let k = Math.max(1, track.checked); k < pts.length - 1; k++) {
      const cos = this.turnCos(pts, k);
      if (cos === null) break; // not enough of the path after k yet
      track.checked = k + 1;
      if (cos < this.opts.turnCos) {
        // The turn is spread over a few points; the impact is where it is sharpest.
        let best = k;
        let bestCos = cos;
        for (let j = k + 1; j < pts.length - 1; j++) {
          const c = this.turnCos(pts, j);
          if (c === null || c > bestCos) break;
          best = j;
          bestCos = c;
        }
        const came = this.dist(pts[0], pts[best]);
        if (came < this.supportApproach) continue;
        track.support = came < this.opts.minApproach;
        return best;
      }
    }
    return null;
  }

  /**
   * Cosine of the change of direction at point k (1 = straight on, -1 = straight
   * back), with directions measured over at least `turnLength`. Null if the path
   * doesn't yet reach that far after k; 1 if it doesn't reach that far before k.
   */
  turnCos(pts, k) {
    const L = this.opts.turnLength;
    let a = k - 1;
    while (a > 0 && this.dist(pts[a], pts[k]) < L) a--;
    let b = k + 1;
    while (b < pts.length && this.dist(pts[b], pts[k]) < L) b++;
    if (b >= pts.length) return null;
    if (this.dist(pts[a], pts[k]) < L) return 1;
    const vin = { x: pts[k].x - pts[a].x, y: (pts[k].y - pts[a].y) * this.aspect };
    const vout = { x: pts[b].x - pts[k].x, y: (pts[b].y - pts[k].y) * this.aspect };
    return (vin.x * vout.x + vin.y * vout.y) / (Math.hypot(vin.x, vin.y) * Math.hypot(vout.x, vout.y));
  }

  /** Ends the current track; returns a hit if the track ended in one. */
  endTrack() {
    const track = this.track;
    this.track = null;
    if (!track) return null;
    // Lost where a person is now: what the ball became may be a hand or the edge of a shadow, so it isn't judged.
    const lostAtPerson = !track.done && this.personAt(track.points[track.points.length - 1]);
    const hit = track.done ? null : (lostAtPerson ? this.reject('lost next to a person', track) : this.judgeEnd(track));
    this.keepEnded(track);
    return hit;
  }

  /** Whether a track that has just ended (without a bounce or drop) was a hit. */
  judgeEnd(track) {
    const {
      turnLength: L, stillMs, stopSpeedRatio, endingMs, minApproach,
    } = this.opts;
    const all = track.points;
    const end = all[all.length - 1];
    // Split off the points where the ball sat still at the end.
    let m = all.length - 1;
    while (m > 0 && this.dist(all[m - 1], end) < L / 2) m--;
    const stopped = end.t - all[m].t >= stillMs;
    const pts = all.slice(0, m + 1);
    const n = pts.length;
    // A blip seen once or twice (noise, a hand) says nothing about the last throw.
    if (n < 4) return this.reject(n < 3 ? null : `seen in only ${n} frames while moving`, track);
    // How it was moving at the end: over at least two frames, and at least endingMs.
    const last = pts[n - 1];
    let e = n - 3;
    while (e > 0 && last.t - pts[e].t < endingMs) e--;
    const ending = pts[e];
    // Only for a straight path: one that turned but wasn't judged a bounce isn't a stop.
    const lastDir = { x: last.x - ending.x, y: (last.y - ending.y) * this.aspect };
    const allDir = { x: last.x - pts[0].x, y: (last.y - pts[0].y) * this.aspect };
    const lengths = Math.hypot(lastDir.x, lastDir.y) * Math.hypot(allDir.x, allDir.y);
    const came = this.dist(last, pts[0]);
    if (came < this.supportApproach) {
      return this.reject(`moved ${percent(came)} of the picture, a throw must travel ${percent(minApproach)}`, track);
    }
    track.support = came < minApproach;
    if (!lengths || (lastDir.x * allDir.x + lastDir.y * allDir.y) / lengths < 0.8) {
      const needed = Math.round(degrees(this.opts.turnCos));
      return this.reject(`turned ${Math.round(this.sharpestTurn(pts))}°, a bounce must turn more than ${needed}°`, track);
    }
    // Lost at the edge of the picture: it left, rather than stopping at the wall.
    if (this.nearPictureEdge(end, 2 * L)) return this.reject('lost at the edge of the camera picture', track);
    // Seen sitting still, or slowing down as it vanished (rather than leaving at speed).
    const speed = (a, b) => this.dist(a, b) / Math.max(1, b.t - a.t);
    let top = 0;
    for (let i = 1; i < n; i++) top = Math.max(top, speed(pts[i - 1], pts[i]));
    const lastSpeed = speed(ending, last);
    if (stopped || lastSpeed < stopSpeedRatio * top) return this.reportHit(end, track.lastT, track);
    return this.reject('lost while still moving fast, without turning or slowing', track);
  }

  /** Records why the throw just ended wasn't a hit (null: not worth showing). Returns null. */
  reject(why, track = this.track) {
    if (why) this.verdict = `no hit: ${why}`;
    if (why && track) track.verdict = `no hit: ${why}`;
    return null;
  }

  /** The sharpest change of direction along a path, in degrees (0 = straight on). */
  sharpestTurn(pts) {
    let lowest = 1;
    for (let k = 1; k < pts.length - 1; k++) {
      const cos = this.turnCos(pts, k);
      if (cos === null) break;
      lowest = Math.min(lowest, cos);
    }
    return degrees(lowest);
  }

  /**
   * Looks for a ball that arrived slowing down and then dropped down the wall.
   * Returns the index of the point where the drop starts, or null.
   */
  findDrop(track) {
    const { dropSteps, dropAngle, dropTurn, turnLength } = this.opts;
    const pts = track.points;
    const n = pts.length;
    if (n < dropSteps + 3) return null;
    // Each step: how far it is from straight down the screen (degrees), and how fast.
    const steps = [];
    for (let i = 1; i < n; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const v = { x: b.x - a.x, y: (b.y - a.y) * this.aspect };
      const len = Math.hypot(v.x, v.y);
      const down = this.downAt(a);
      const cos = len ? (v.x * down.x + v.y * down.y) / len : 0;
      steps.push({ angle: (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI, speed: len / Math.max(1, b.t - a.t) });
    }
    // Speeds smoothed over three steps: the ball's position jitters a little.
    const speed = steps.map((_, i) => (steps[Math.max(0, i - 1)].speed + steps[i].speed
      + steps[Math.min(steps.length - 1, i + 1)].speed) / 3);
    // Where the drop starts: the sharpest turn more steeply down…
    let start = null;
    let sharpest = dropTurn;
    for (let i = 2; i < steps.length - 1; i++) {
      const turn = (steps[i - 2].angle + steps[i - 1].angle) / 2 - (steps[i].angle + steps[i + 1].angle) / 2;
      if (turn > sharpest) {
        sharpest = turn;
        start = i;
      }
    }
    // …or else the slowest point (not counting the last step, still being measured).
    if (start === null) {
      start = 1;
      for (let i = 2; i < steps.length - 1; i++) if (speed[i] < speed[start]) start = i;
    }
    // Seen arriving, and arriving faster than it starts to drop.
    if (start < 2 || Math.max(...speed.slice(0, start)) < 1.2 * speed[start]) return null;
    // The drop: enough steps, all going down, covering some distance.
    const drop = steps.slice(start);
    if (drop.length < dropSteps || drop.some((s) => s.angle > dropAngle)) return null;
    if (this.dist(pts[start], pts[n - 1]) < 4 * turnLength) return null;
    return start;
  }

  /** The direction straight down the screen at camera point p, as a unit vector (x, and y scaled like dist). */
  downAt(p) {
    const s = applyHomography(this.cameraToScreen, p);
    const q = applyHomography(this.screenToCamera, { x: s.x, y: s.y + 0.01 });
    const v = { x: q.x - p.x, y: (q.y - p.y) * this.aspect };
    const len = Math.hypot(v.x, v.y) || 1;
    return { x: v.x / len, y: v.y / len };
  }

  /** Whether camera point p is within `margin` (fraction of the frame width) of the picture's edge. */
  nearPictureEdge(p, margin) {
    return p.x < margin || p.x > 1 - margin || p.y * this.aspect < margin || (1 - p.y) * this.aspect < margin;
  }

  /** How far a supporting hit must have come (never further than a hit by itself). */
  get supportApproach() {
    return Math.min(this.opts.minApproach, this.opts.minSupportApproach ?? this.opts.minApproach);
  }

  /** Distance in fractions of the frame width (so x and y are measured alike). */
  dist(a, b) {
    return Math.hypot(a.x - b.x, (a.y - b.y) * this.aspect);
  }

  /** @param {{x:number, y:number, t:number}} point where (and when) the ball hit, in the camera picture */
  reportHit(point, t, track = this.track) {
    if (track) track.done = true; // one hit per throw
    if (t - this.shared.lastHitAt < this.opts.cooldownMs) return this.reject('too soon after the last hit', track);
    const camera = { x: point.x, y: point.y };
    const s = applyHomography(this.cameraToScreen, camera);
    const m = this.opts.hitMargin;
    if (!(s.x >= -m && s.x <= 1 + m && s.y >= -m && s.y <= 1 + m)) {
      // Kept with the path: a ball off the floor ends its flight there (see ThrowTracker's flight hits).
      if (track) track.bounce = { x: point.x, y: point.y, t: point.t };
      return this.reject('hit outside the screen (the green outline)', track);
    }
    const support = Boolean(track?.support);
    // A supporting hit may not count, so it doesn't hold off the next throw.
    if (!support) this.shared.lastHitAt = t;
    this.verdict = support ? 'supporting hit' : 'hit';
    if (track) {
      track.verdict = this.verdict;
      track.hit = { x: point.x, y: point.y, t: point.t };
    }
    const hit = { camera, screen: { x: clamp01(s.x), y: clamp01(s.y) }, time: point.t };
    return support ? { ...hit, support: true } : hit;
  }
}

/**
 * Follows several things at once: a HitTracker (a lane) for each. Used where the ball isn't the only thing
 * moving (a toss, a bat, the ball off it): a blob no lane is following starts a path in a free lane at once.
 * Which path was the ball is for ThrowTracker to say, from both cameras.
 */
export class LaneTracker {
  /** @param {object} args as HitTracker's, and `lanes`: how many things can be followed at once */
  constructor({ lanes, ...args }) {
    const shared = { stillSpots: [], lastHitAt: -Infinity };
    this.lanes = Array.from({ length: lanes }, () => new HitTracker({ ...args, shared }));
    /** How the last path to end ended, for display. */
    this.verdict = null;
  }

  reset() {
    for (const lane of this.lanes) lane.reset();
  }

  /** @returns {EndedTrack[]} the paths every lane followed to their end since the last call */
  takeEnded() {
    return this.lanes.flatMap((lane) => lane.takeEnded());
  }

  /** Every path being followed now (the points themselves: normalised camera coords, frame times). */
  get paths() {
    return this.lanes.filter((lane) => lane.track).map((lane) => lane.track.points);
  }

  /** The longest path being followed, for display. */
  get points() {
    const longest = this.paths.reduce((a, b) => (b.length > a.length ? b : a), []);
    return longest.map(({ x, y }) => ({ x, y }));
  }

  /**
   * Feeds the blobs seen in the next frame.
   * @param {Blob[]} blobs
   * @param {number} t frame time in ms
   * @returns {Hit[]} every hit seen in it (a path's turn on the screen: see ThrowTracker's candidates)
   */
  update(blobs, t) {
    const hits = [];
    let free = [...blobs];
    const feed = (lane, some) => {
      const before = lane.verdict;
      const hit = lane.update(some, t);
      if (hit) hits.push(hit);
      if (lane.verdict !== before) this.verdict = lane.verdict;
    };
    // Lanes following something take the blob it has become, the longest path choosing first.
    const busy = this.lanes.filter((lane) => lane.track)
      .sort((a, b) => b.track.points.length - a.track.points.length);
    for (const lane of busy) {
      const mine = lane.claim(free, t);
      if (mine) free = free.filter((b) => b !== mine);
      feed(lane, mine ? [mine] : []);
    }
    // Each blob left starts a path in a lane that is free (one that has just ended its path is).
    for (const lane of this.lanes) {
      if (!free.length) break;
      if (lane.track) continue;
      feed(lane, free);
      const first = lane.track?.points[0];
      if (!first) break; // every blob left is at a still spot
      free = free.filter((b) => !(b.x === first.x && b.y === first.y));
    }
    return hits;
  }
}

/** The angle (degrees) whose cosine is `cos`. */
function degrees(cos) {
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/** A fraction as a whole percentage, e.g. '5%'. */
function percent(f) {
  return `${Math.round(f * 100)}%`;
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}
