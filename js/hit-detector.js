// Spots where a thrown ball hits the projected screen, from a stream of camera
// frames. Works on greyscale (luma) frames, so it can be unit-tested without a
// browser.
//
// How it works, for a camera mounted next to the projector:
// 1. Background: keep a slowly updated picture of the scene without the ball.
//    Pixels that differ from it are "foreground": something that has just
//    appeared or is moving (this sees the whole ball, even when it is slow).
// 2. Ball candidates: group foreground pixels into blobs. Only blobs over (or
//    just around) the projected screen count, and big ones are ignored: those
//    are people, not balls. People (and the shadows they cast on the screen)
//    break up into small blobs too, so the picture is also cut into cells, and
//    the cells where a lot of the picture changed, for as much as a person
//    makes, are the person zone: blobs in it are not followed, so a hand or the
//    edge of a shadow never gets as far as being a ball.
//    Steps 1 and 2 are in foreground.js, which also follows the camera's
//    exposure and works around things the game moves (sprites).
// 3. Tracking: follow one blob from frame to frame (or several at once, in
//    launch mode: lanes, splitAtHit and watchAll, for a ball tossed and then
//    hit with a bat; the whole camera picture is watched then).
// 4. Hit: a sharp change of direction, a slowing stop, or a drop down the wall.
//    Steps 3 and 4 are in hit-tracker.js. The person zone is also given as
//    boxes (`people`, for ThrowTracker's check that a camera's view was blocked)
//    and a ball lost where it vanished into the zone is not judged.
//
// The projector's own picture changes too (a hit mark appearing, the screen
// being cleared). Callers report those changes with suppress()/suppressAll() so
// they become part of the background instead of being mistaken for a ball, and
// exclude on-screen UI with setExcluded().
//
// Things the game moves around (a rising balloon) are given before each frame
// with setSprites().

import { ForegroundFinder } from './foreground.js';
import { HitTracker, LaneTracker } from './hit-tracker.js';
import { invertHomography } from './homography.js';

export const HIT_DETECTOR_DEFAULTS = {
  // Brightness difference (0–255) from the background that counts as "something there"…
  threshold: 22,
  // …or this many times the pixel's own flicker, if that is more. Some of the
  // projected picture flickers to the camera (a DLP projector shows colours one
  // after another, and a short exposure catches only some of them), so each
  // pixel learns how much it varies (its typical difference from the background)…
  noiseFactor: 5,
  // …over about this long (ms)…
  noiseMs: 2000,
  // …or this long while the game changes the picture there, so it knows a new mark's flicker by the time it is watched.
  noiseLearnMs: 300,
  // Settings are in milliseconds, not frames, so they hold at any camera frame rate.
  // How quickly the background follows the scene: it catches up with most of a change in about this long (ms)…
  backgroundMs: 650,
  // …and how slowly something that stays put (a stuck ball, a bag) fades into it.
  foregroundMs: 3300,
  // A ball blob is at least this many pixels (at the analysed frame size)…
  minBlobArea: 3,
  // …and at most this fraction of the watched area. Bigger means a person.
  maxBlobFraction: 0.03,
  // People are found on a grid of cells this wide (fraction of the frame width, square in pixels)…
  personCell: 1 / 32,
  // …a cell is busy if this fraction of it is foreground…
  personCellFill: 0.2,
  // …busy cells that touch are a person (or a shadow) if they hold this fraction of the frame's pixels as
  // foreground: much more than a ball, even a close and blurred one, or a bat's streak makes…
  personMinFraction: 0.012,
  // …and the person zone is those cells and this many cells round them (a hand or a head comes away from the body
  // by more than one cell, and the edge of a moving person leaves slivers a little behind them)…
  personMarginCells: 2,
  // …for this long (ms) after the cell was last a person's: the background takes about this long to take back
  // what a person covered, and until then the patches that are left look like small moving things.
  personHoldMs: 1000,
  // If more than this fraction of the watched area changes, the whole picture
  // changed (lights, camera adjusting): the background is reset and the frame skipped.
  maxChangeFraction: 0.25,
  // Also watch this far beyond the screen edges (fraction of the screen size),
  // so a ball can be followed as it arrives.
  regionMargin: 0.15,
  // Largest jump between frames still treated as the same ball (fraction of frame width)…
  gateDistance: 0.25,
  // …and once it is moving, at most this many times its last step (but always 3 × turnLength),
  // so the track doesn't jump to something else when the ball leaves the picture.
  gateSteps: 2,
  // A track ends if the ball isn't seen for this long.
  maxGapMs: 150,
  // Directions are measured over at least this distance (fraction of frame width),
  // so a slow ball's jitter doesn't look like a turn.
  turnLength: 0.012,
  // A change of direction sharper than this is a bounce (cosine of the angle; 0.25 ≈ 75°)…
  turnCos: 0.25,
  // …after the ball has come at least this far (fraction of frame width); a ball that
  // stops must have come this far too. Something wobbling on the spot (a person at the
  // edge of the picture) turns and stops too.
  minApproach: 0.05,
  // A throw that came less far than that, but at least this far, is a supporting hit: it only counts
  // alongside another camera's hit (a camera behind the thrower sees the ball go mostly away from it).
  minSupportApproach: 0.01,
  // A straight track that ends having slowed to this fraction of its top speed is a hit.
  stopSpeedRatio: 0.5,
  // A drop down the wall is seen for at least this many frames…
  dropSteps: 3,
  // …each moving within this angle (degrees) of straight down the screen.
  dropAngle: 45,
  // The drop starts where the path turns at least this much (degrees) more steeply
  // down; without such a turn, where the ball is slowest.
  dropTurn: 12,
  // A ball seen in the same place for this long (ms) has stopped.
  stillMs: 130,
  // After that, ignore that spot for new tracks until nothing has been seen there for this long.
  stillSpotMs: 1000,
  // Minimum time between two hits.
  cooldownMs: 300,
  // Hits this far outside the screen edges still count (and are moved onto the edge).
  hitMargin: 0.03,
  // The speed and direction a track ends with are measured over at least this long (ms).
  endingMs: 66,
  // Time (ms) spent learning the background before detecting anything.
  warmupMs: 90,
  // The camera's exposure is measured from about this many background pixels.
  exposureSamples: 4000,
  // A sprite's look is learned on a grid of this many cells across and down…
  spriteGrid: 16,
  // …and a cell is compared with only once it has been seen this many times.
  spriteLearnSamples: 6,
  // How many things are followed at once. More than one (launch mode): the ball isn't the only thing
  // moving (a toss, a bat), and which path was the ball is decided from both cameras (ThrowTracker).
  lanes: 1,
  // A path ends at each sharp turn and another starts there (launch mode), so a ball hit in the air and then
  // hitting the wall turns twice, and either may be the hit.
  splitAtHit: false,
  // Watch the whole camera picture, not just the screen and a band round it (launch mode): the ball is
  // followed from the bat. Hits still only count on the screen (hitMargin).
  watchAll: false,
};

// Frames further apart than this (ms) are treated as this far apart, so a
// stall (a busy computer) doesn't wipe the background.
const MAX_FRAME_GAP_MS = 200;

/**
 * @typedef {import('./hit-tracker.js').Hit} Hit
 * @typedef {{x:number, y:number}} Point
 * @typedef {import('./foreground.js').Sprite} Sprite
 */

export class HitDetector {
  /**
   * @param {object} args
   * @param {number} args.width analysed frame width in pixels
   * @param {number} args.height analysed frame height in pixels
   * @param {number[]} args.cameraToScreen homography, normalised camera -> normalised screen coords
   * @param {Partial<typeof HIT_DETECTOR_DEFAULTS>} [args.options]
   */
  constructor({ width, height, cameraToScreen, options = {} }) {
    this.opts = { ...HIT_DETECTOR_DEFAULTS, ...options };
    const screenToCamera = invertHomography(cameraToScreen);
    this.scene = new ForegroundFinder({
      width, height, cameraToScreen, screenToCamera, opts: this.opts,
    });
    const trackerArgs = {
      aspect: height / width, cameraToScreen, screenToCamera, opts: this.opts, personAt: (p) => this.scene.personAt(p),
    };
    // Several things followed at once (launch mode), or one.
    this.laned = this.opts.lanes > 1;
    this.tracker = this.laned ? new LaneTracker({ lanes: this.opts.lanes, ...trackerArgs }) : new HitTracker(trackerArgs);
    this.firstFrameAt = null;
    this.lastFrameAt = null;
    this.suppressed = []; // [{rect, until}] – rect null means everywhere
  }

  /** Screen areas never watched (e.g. on-screen buttons). */
  setExcluded(rects) {
    this.scene.setExcluded(rects);
  }

  /** Treat changes inside `rect` (normalised screen coords) as background until time `until` (ms). */
  suppress(rect, until) {
    this.suppressed.push({ rect, until });
  }

  /** Treat all changes as background until time `until`, e.g. after clearing the screen. */
  suppressAll(until) {
    this.suppressed.push({ rect: null, until });
    this.tracker.reset();
  }

  /**
   * The paths the ball was followed along since the last call, each with its verdict.
   * @returns {import('./hit-tracker.js').EndedTrack[]}
   */
  takeEnded() {
    return this.tracker.takeEnded();
  }

  /**
   * The path of the ball being followed now (normalised camera coords, frame times), or null if none is.
   * @returns {{x:number, y:number, t:number}[]|null}
   */
  get following() {
    return this.followingAll.reduce((a, b) => (!a || b.length > a.length ? b : a), null);
  }

  /**
   * Every path being followed now (normalised camera coords, frame times); empty if none.
   * @returns {{x:number, y:number, t:number}[][]}
   */
  get followingAll() {
    if (this.laned) return this.tracker.paths;
    return this.tracker.track ? [this.tracker.track.points] : [];
  }

  /** Foreground mask of the last processed frame (1 = changed), for display. */
  get foregroundMask() {
    return this.scene.foregroundMask;
  }

  /** The person zone as cells (1 = in it); pixel i is in it if personZone[personCellOf[i]] is, for display. */
  get personZone() {
    return this.scene.personZone;
  }

  get personCellOf() {
    return this.scene.personCellOf;
  }

  /** What each pixel showed in the last frame: 0 scene, 1 ignored sprite edge, 2 sprite, for display. */
  get spriteMask() {
    return this.scene.spriteMask;
  }

  /**
   * Where the game's moving things are in the frame about to be processed.
   * @param {Sprite[]} sprites
   * @param {{x:number, y:number}} margin width of the ignored band around each edge (fraction of the screen)
   * @param {number} time time of the frame (ms), to forget sprites that have gone
   */
  setSprites(sprites, margin, time) {
    this.scene.setSprites(sprites, margin, time);
  }

  /**
   * Feeds the next camera frame.
   * @param {Float32Array} luma frame, width*height values
   * @param {number} time frame time in ms
   * @returns {{hit: Hit|null, hits: Hit[], blobs: Point[], track: Point[], tracks: Point[][], changed: number,
   *   sceneChange: boolean, verdict: string|null, people: {x0:number, y0:number, x1:number, y1:number}[]}} hit: the
   *   first of `hits`, every hit seen in this frame (more than one only with lanes); track: the longest path being
   *   followed, tracks: all of them, for display; verdict: how the last throw ended ('hit' or 'no hit: <why>'), for
   *   display; people: the person zone as boxes (normalised camera coords), where nothing is followed
   */
  process(luma, time) {
    const result = {
      hit: null, hits: [], blobs: [], track: [], tracks: [], changed: 0, sceneChange: false, verdict: this.tracker.verdict, people: [],
    };
    this.suppressed = this.suppressed.filter((s) => s.until > time);
    this.firstFrameAt ??= time;
    const dt = this.lastFrameAt === null ? 0 : Math.min(MAX_FRAME_GAP_MS, Math.max(0, time - this.lastFrameAt));
    this.lastFrameAt = time;
    if (!this.scene.background || time - this.firstFrameAt < this.opts.warmupMs
      || this.suppressed.some((s) => s.rect === null)) {
      this.scene.resetBackground(luma);
      return result;
    }

    const suppressedRects = this.suppressed.map((s) => s.rect);
    const steady = this.scene.followExposure(luma, suppressedRects, time);
    // How far the background moves towards this frame: the same per second at any frame rate.
    const rates = {
      background: 1 - Math.exp(-dt / this.opts.backgroundMs),
      foreground: 1 - Math.exp(-dt / this.opts.foregroundMs),
      noise: 1 - Math.exp(-dt / this.opts.noiseMs),
      noiseLearn: 1 - Math.exp(-dt / this.opts.noiseLearnMs),
    };
    result.changed = this.scene.findForeground(steady, suppressedRects, rates);
    if (result.changed > this.opts.maxChangeFraction * this.scene.region.length) {
      result.sceneChange = true;
      this.tracker.reset();
      this.scene.resetBackground(luma);
      return result;
    }

    const blobs = this.scene.findBlobs(time);
    result.blobs = blobs;
    result.people = this.scene.personBoxes;
    const hits = this.laned ? this.tracker.update(blobs, time) : [this.tracker.update(blobs, time)].filter(Boolean);
    result.hits = hits;
    result.hit = hits[0] ?? null;
    result.track = this.tracker.points;
    result.tracks = this.followingAll.map((path) => path.map(({ x, y }) => ({ x, y })));
    result.verdict = this.tracker.verdict;
    return result;
  }
}
