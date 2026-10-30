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

import { applyHomography } from './homography.js';

/**
 * @typedef {{x:number, y:number}} Point
 * @typedef {{camera: Point, screen: Point, time: number}} Hit time: when the camera saw the impact (ms)
 * @typedef {{x:number, y:number, area:number}} Blob
 */

export class HitTracker {
  /**
   * @param {object} args
   * @param {number} args.aspect camera frame height / width
   * @param {number[]} args.cameraToScreen homography, normalised camera -> normalised screen coords
   * @param {number[]} args.screenToCamera its inverse
   * @param {object} args.opts the detector's settings (HIT_DETECTOR_DEFAULTS with any overrides)
   */
  constructor({ aspect, cameraToScreen, screenToCamera, opts }) {
    this.aspect = aspect;
    this.cameraToScreen = cameraToScreen;
    this.screenToCamera = screenToCamera;
    this.opts = opts;
    this.track = null;
    this.stillSpots = []; // [{x, y, until}] places where something stopped
    this.lastHitAt = -Infinity;
  }

  /** Drops the ball being followed, e.g. when the picture changed under it. */
  reset() {
    this.track = null;
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
    const { gateDistance, maxGapMs, turnLength, stillMs } = this.opts;
    let hit = null;
    if (this.track && t - this.track.lastT > maxGapMs) hit = this.endTrack();
    this.stillSpots = this.stillSpots.filter((s) => s.until > t);

    if (blobs.length) {
      if (this.track) {
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
        if (best) {
          pts.push({ x: best.x, y: best.y, t });
          this.track.lastT = t;
          // Something that has stopped moving: end the track there.
          let m = pts.length - 1;
          while (m > 0 && this.dist(pts[m - 1], best) < turnLength / 2) m--;
          if (t - pts[m].t >= stillMs) {
            this.stillSpots.push({ x: best.x, y: best.y, until: t + this.opts.stillSpotMs });
            hit = this.endTrack() ?? hit;
          }
        }
      } else {
        const fresh = blobs.filter((b) => {
          const spot = this.stillSpots.find((s) => this.dist(b, s) < turnLength * 2);
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
      if (k !== null) hit = this.reportHit(this.track.points[k], t);
    }
    return hit;
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
        if (this.dist(pts[0], pts[best]) < this.opts.minApproach) continue;
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
    if (!track || track.done) return null;
    const {
      turnLength: L, stillMs, stopSpeedRatio, endingMs,
    } = this.opts;
    const all = track.points;
    const end = all[all.length - 1];
    // Split off the points where the ball sat still at the end.
    let m = all.length - 1;
    while (m > 0 && this.dist(all[m - 1], end) < L / 2) m--;
    const stopped = end.t - all[m].t >= stillMs;
    const pts = all.slice(0, m + 1);
    const n = pts.length;
    if (n < 4) return null;
    // How it was moving at the end: over at least two frames, and at least endingMs.
    const last = pts[n - 1];
    let e = n - 3;
    while (e > 0 && last.t - pts[e].t < endingMs) e--;
    const ending = pts[e];
    // Only for a straight path: one that turned but wasn't judged a bounce isn't a stop.
    const lastDir = { x: last.x - ending.x, y: (last.y - ending.y) * this.aspect };
    const allDir = { x: last.x - pts[0].x, y: (last.y - pts[0].y) * this.aspect };
    const lengths = Math.hypot(lastDir.x, lastDir.y) * Math.hypot(allDir.x, allDir.y);
    if (!lengths || (lastDir.x * allDir.x + lastDir.y * allDir.y) / lengths < 0.8) return null;
    if (this.dist(last, pts[0]) < this.opts.minApproach) return null;
    // Lost at the edge of the picture: it left, rather than stopping at the wall.
    if (this.nearPictureEdge(end, 2 * L)) return null;
    // Seen sitting still, or slowing down as it vanished (rather than leaving at speed).
    const speed = (a, b) => this.dist(a, b) / Math.max(1, b.t - a.t);
    let top = 0;
    for (let i = 1; i < n; i++) top = Math.max(top, speed(pts[i - 1], pts[i]));
    const lastSpeed = speed(ending, last);
    if (stopped || lastSpeed < stopSpeedRatio * top) return this.reportHit(end, track.lastT);
    return null;
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

  /** Distance in fractions of the frame width (so x and y are measured alike). */
  dist(a, b) {
    return Math.hypot(a.x - b.x, (a.y - b.y) * this.aspect);
  }

  /** @param {{x:number, y:number, t:number}} point where (and when) the ball hit, in the camera picture */
  reportHit(point, t) {
    if (this.track) this.track.done = true; // one hit per throw
    if (t - this.lastHitAt < this.opts.cooldownMs) return null;
    const camera = { x: point.x, y: point.y };
    const s = applyHomography(this.cameraToScreen, camera);
    const m = this.opts.hitMargin;
    if (!(s.x >= -m && s.x <= 1 + m && s.y >= -m && s.y <= 1 + m)) return null;
    this.lastHitAt = t;
    return { camera, screen: { x: clamp01(s.x), y: clamp01(s.y) }, time: point.t };
  }
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}
