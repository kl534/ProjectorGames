// The camera side of a throwing game: opens the calibrated camera, feeds its
// frames to the hit detector and reports where balls hit the screen. Also
// keeps the detector away from on-screen controls and the game's own picture
// changes, tells it where the game's moving things are (track), and draws the
// camera view (D) used when setting up the rig.
//
// The camera sees the projected picture a little late (the delay measured in
// calibration). So moving things are looked up where they were that long ago,
// and hits say when the picture they landed on was on screen.
//
// A few seconds in, once the camera has adjusted to the game's picture, its
// exposure, white balance and focus are held there (where the camera allows),
// so it doesn't change the whole picture as players come and go. If holding
// the exposure makes the picture darker (the camera reported a stale exposure),
// the camera is left to adjust its exposure by itself after all. An exposure
// set by hand in Setup is set as the camera opens, and left alone.
//
// People in front of a camera (and their shadows on the screen) are kept out of it
// by the detector's person zone, and the zone is told to the tracker, which uses it to
// tell whether the other camera's view of a spot was blocked. The camera view draws
// the zone in magenta.
//
// If a second camera was calibrated with the main one, it is used too. Each
// camera has its own detector, and what they all see goes to the ThrowTracker
// (throw-tracker.js), which turns it into hits for the game: one per throw,
// with where, when and how fast (see its Hit). Games only use those.
//
// Launch mode (launch, for a ball tossed and then hit with a bat) watches the
// whole camera picture, not just the screen, follows several things at once
// and splits a path at each turn (the detector's lanes, splitAtHit and
// watchAll), and leaves it to the ThrowTracker to say which turn was the wall
// and how the ball left the bat. A calibration's lens refined from real
// flights (fovDeg) places the camera in the room.
//
// Every frame the camera sends is looked at (readFrames), not just one per
// screen refresh, so a fast camera is used at its full speed.
//
// Expects the game's screen element to contain a <video>, and a
// `.debug-panel` holding a <canvas> and a `.debug-stats` line. The second
// camera's video, canvas and line are added next to them.

import {
  CAMERA_MESSAGES, CameraError, heldTooDark, holdAdjustments, openCamera, openPreferredCamera, releaseSomeAdjustments,
  setExposure, stopStream, stopStreamReleasing,
} from './camera.js';
import {
  captureTimeOf, createGrabber, meanLuma, readFrames,
} from './frames.js';
import { HitDetector } from './hit-detector.js';
import { SpriteHistory } from './sprite-history.js';
import { cameraModel } from './stereo.js';
import { loadSettings } from './storage.js';
import { ThrowTracker } from './throw-tracker.js';

// Frames are analysed at this width: enough to see a ball, fast enough for every frame.
const PROCESS_WIDTH = 320;
// After the picture changes (a mark appears, the screen is cleared), the camera
// sees the change a little later: projector + camera delay plus a short pop-in
// animation. Changes during this time aren't a ball.
export const SETTLE_MS = 900;
// The camera picture is a little blurred, so a change spreads slightly beyond
// where it was drawn (fraction of the shorter screen side).
const CHANGE_MARGIN = 0.015;
// Used when the calibration is older than the delay measurement.
export const DEFAULT_LATENCY_MS = 150;
// The delay varies a little from frame to frame (and a camera frame takes time
// to capture), so a moving thing may be this much further on or behind.
const LATENCY_SLACK_MS = 40;
// How long tracked positions are remembered.
const HISTORY_MS = 1500;
// How long the camera adjusts its exposure, white balance and focus to the
// game's picture before they are held.
const HOLD_AFTER_MS = 3000;
// How long after holding them the picture is checked: a camera takes a few
// frames to change its exposure.
const HOLD_CHECK_MS = 600;

export const GAME_MESSAGES = {
  differentCamera: 'This isn’t the camera that was calibrated – recalibrate in Setup for accurate hits.',
  notFullscreen: 'Press F for full screen – hits only line up in full screen.',
  starting: 'Starting camera…',
  cameraOff: (kind) => `${CAMERA_MESSAGES[kind].split(' – ')[0]} – ball detection is off. Mouse clicks still work.`,
  notCalibrated: 'Screen not calibrated – mouse clicks and taps only. Scores aren’t saved.',
  noLatency: 'Recalibrate in Setup so throws at moving things line up.',
  noCameraMode: 'Recalibrate in Setup to run the camera at its fastest, for more accurate hits.',
  oldTiming: 'Recalibrate in Setup so throws at moving things line up exactly.',
  secondCameraOff: (kind) => `Second camera: ${CAMERA_MESSAGES[kind].split(' – ')[0].toLowerCase()} – using the main camera only.`,
  secondDifferent: 'The second camera isn’t the one that was calibrated – recalibrate in Setup.',
};

/**
 * @typedef {{x:number, y:number}} Point normalised screen coordinates
 * @typedef {{x0:number, y0:number, x1:number, y1:number}} Rect normalised screen coordinates
 * @typedef {object} Eye one camera watching the screen
 * @property {number} index 0 for the main camera, 1 for the second
 * @property {import('./storage.js').CameraCalibration} calibration
 * @property {HTMLVideoElement} video
 * @property {HTMLCanvasElement} canvas its camera view
 * @property {HTMLElement} stats its line under the camera view
 * @property {MediaStream|null} stream
 * @property {ReturnType<typeof createGrabber>|null} grabber
 * @property {HitDetector|null} detector
 * @property {number} latencyMs how long it takes to see a change on screen
 * @property {boolean} captureClock frames are timed by when the camera took them, as the delay was measured
 *   (only where frames come from the video's callbacks)
 * @property {{stop: () => void}|null} reader reads every frame the camera sends, where the browser can
 * @property {import('./stereo.js').CameraModel|null} model where it is in the room, for two-camera paths
 * @property {Promise<import('./camera.js').HeldAdjustment[]>|null} held the camera settings held, once asked
 * @property {Promise<boolean>|null} manualExposure setting the exposure chosen by hand in Setup, if one was
 * @property {string} heldNames
 * @property {number|null} brightness the last frame's average brightness (0–255), null before the first
 * @property {string} exposureNote why the exposure isn't held, for the camera view, or ''
 * @property {Point|null} lastBallHit camera coords
 * @property {{frames: number, since: number, value: number}} fps
 *
 * @typedef {import('./throw-tracker.js').Hit} Hit
 * @typedef {import('./throw-tracker.js').ThrowSeen} ThrowSeen
 */

export class ThrowCamera {
  /**
   * @param {HTMLElement} root the game's screen element
   * @param {object} handlers
   * @param {(hit: Hit) => void} handlers.onHit a ball hit the screen: where (`x`, `y`), on the
   *   picture that was on screen at `time` (performance.now() ms), how fast, and more (see Hit)
   * @param {() => void} handlers.onNote the camera note (see `note`) changed
   * @param {boolean} [handlers.moving] the game moves things around (and tracks them)
   * @param {(seen: ThrowSeen) => void} [handlers.onThrow] everything the cameras saw of a throw, once it is over
   * @param {boolean} [handlers.flightHits] also hits from a ball both cameras saw flying at the wall that neither
   *   saw hit the screen (off the floor first, over the top): `fromFlight`, and its x and y may be off the screen
   * @param {boolean} [handlers.launch] launch mode: follow the ball from the bat: hits get `launch`, how it left
   *   the bat, where both cameras saw it; and a ball tossed and then hit is only a hit where it meets the screen
   *   (it can be changed between stop() and start())
   */
  constructor(root, {
    onHit, onNote, moving = false, onThrow = null, flightHits = false, launch = false,
  }) {
    this.onHit = onHit;
    this.flightHits = flightHits;
    this.launch = launch;
    this.onNote = onNote;
    this.onThrow = onThrow;
    this.moving = moving;
    this.root = root;
    this.video = root.querySelector('video');
    this.debugPanel = root.querySelector('.debug-panel');
    this.debugCanvas = this.debugPanel.querySelector('canvas');
    this.debugStats = this.debugPanel.querySelector('.debug-stats');
    this.second = null; // the second camera's video, canvas and line, made when first needed

    this.session = 0; // increments on start/stop so stale async work can tell it's outdated
    /** @type {Eye[]} the cameras running */
    this.eyes = [];
    this.calibration = null;
    /** A message about the camera for the players, or '' when all is well. */
    this.mainNote = '';
    this.secondNote = '';
    this.debug = false;
    this.ignoredElements = [];
    this.excluded = [];
    // How far the screen is from square, for two-camera paths.
    this.screenAspect = 9 / 16;
    /** The projected screen's width in feet, from Setup, or null. */
    this.screenWidthFt = null;
    /** @type {ThrowTracker|null} turns what the cameras see into hits, while they run */
    this.tracker = null;
    /** @type {Map<Element, {shape: string, watch: boolean, history: SpriteHistory, active: boolean}>} */
    this.tracked = new Map();

    // On-screen controls and the camera view change size (status messages, the
    // camera picture loading), so keep the ignored areas up to date.
    this.resized = new ResizeObserver(() => this.updateExcluded());
    this.resized.observe(this.debugPanel);
    window.addEventListener('resize', () => this.updateExcluded());
  }

  /** Screen elements the detector never watches (buttons, score display…). The camera view is always ignored. */
  ignore(...elements) {
    for (const el of elements) {
      this.ignoredElements.push(el);
      this.resized.observe(el);
    }
    this.updateExcluded();
  }

  /**
   * Something the game moves around (a rising balloon): the detector looks
   * for balls in front of it rather than taking it for one. Its on-screen box
   * is recorded every frame until it is removed from the page.
   * @param {Element} el
   * @param {object} [options]
   * @param {'ellipse'|'rect'} [options.shape] an ellipse fills the element's box
   * @param {boolean} [options.watch] false for thin parts (a string): the area is just ignored
   */
  track(el, { shape = 'ellipse', watch = true } = {}) {
    const history = new SpriteHistory(HISTORY_MS);
    history.add(performance.now(), rectOf(el));
    this.tracked.set(el, { shape, watch, history, active: true });
  }

  /**
   * The element has stopped moving (a falling block has landed): the detector
   * goes back to treating it as part of the picture, which the game reports
   * (pictureChange) as it changes. Where it was is still remembered for a
   * moment, for `whereWas`. Tracking it again afterwards starts it afresh.
   */
  untrack(el) {
    const sprite = this.tracked.get(el);
    if (!sprite) return;
    sprite.active = false;
    setTimeout(() => {
      if (this.tracked.get(el) === sprite) this.tracked.delete(el);
    }, HISTORY_MS);
  }

  /** True when playing without a calibration: no camera, only mouse clicks and taps. */
  get mouseOnly() {
    return this.calibration === null;
  }

  /** @param {import('./storage.js').Calibration|null} calibration null: mouse clicks and taps only, the camera stays off */
  async start(calibration) {
    const session = ++this.session;
    this.calibration = calibration;
    this.secondNote = '';
    this.tracker = null;
    this.recordPositions(session);
    if (!calibration) {
      this.setNote(GAME_MESSAGES.notCalibrated);
      return;
    }
    this.screenAspect = calibration.screenAspect ?? window.innerHeight / window.innerWidth;
    this.screenWidthFt = loadSettings().screenWidthFt;
    this.tracker = new ThrowTracker({
      screenAspect: this.screenAspect,
      screenWidthFt: this.screenWidthFt,
      onHit: (hit) => this.onHit(hit),
      onThrow: (seen) => this.onThrow?.(seen),
      flightHits: this.flightHits,
      launch: this.launch,
    });
    this.setNote(GAME_MESSAGES.starting);
    const main = this.makeEye(0, calibration, this.video, this.debugCanvas, this.debugStats);
    try {
      // The mode it was calibrated in: another mode may see a different part of the picture.
      const { stream, deviceId } = await openPreferredCamera(calibration.cameraId, { mode: calibration.cameraMode });
      if (session !== this.session) {
        stopStream(stream);
        return;
      }
      await this.startEye(session, main, stream);
      if (session !== this.session) return;
      if (deviceId && deviceId !== calibration.cameraId) this.setNote(GAME_MESSAGES.differentCamera);
      else if (this.moving && calibration.latencyMs === undefined) this.setNote(GAME_MESSAGES.noLatency);
      // Its delay was timed on another clock than the frames are now: a few milliseconds out.
      else if (this.moving && main.reader && calibration.frameClock !== 'stream') this.setNote(GAME_MESSAGES.oldTiming);
      else this.setNote(calibration.cameraMode ? '' : GAME_MESSAGES.noCameraMode);
    } catch (err) {
      if (session !== this.session) return;
      if (!(err instanceof CameraError)) console.error(err);
      this.stopCamera();
      this.setNote(GAME_MESSAGES.cameraOff(err instanceof CameraError ? err.kind : 'error'));
      return;
    }
    if (calibration.second) await this.startSecond(session, calibration.second);
  }

  /** Starts the second camera next to the main one; without it, the main camera carries on alone. */
  async startSecond(session, calibration) {
    const parts = this.secondParts();
    const eye = this.makeEye(1, calibration, parts.video, parts.canvas, parts.stats);
    try {
      // Exactly that camera: any other might be the main camera.
      const { stream, deviceId } = await openCamera(calibration.cameraId, { mode: calibration.cameraMode });
      // Stopped meanwhile, or the main camera went (the second never runs alone).
      if (session !== this.session || !this.main) {
        stopStream(stream);
        return;
      }
      await this.startEye(session, eye, stream);
      if (session !== this.session) return;
      if (deviceId && deviceId !== calibration.cameraId) this.setSecondNote(GAME_MESSAGES.secondDifferent);
      this.debugPanel.classList.add('two-cameras');
    } catch (err) {
      if (session !== this.session) return;
      if (!(err instanceof CameraError)) console.error(err);
      this.stopEye(eye);
      this.setSecondNote(GAME_MESSAGES.secondCameraOff(err instanceof CameraError ? err.kind : 'error'));
    }
  }

  /** The second camera's video, camera view and line, made the first time they are needed. */
  secondParts() {
    if (!this.second) {
      const video = document.createElement('video');
      video.className = 'capture-video';
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('aria-hidden', 'true');
      this.root.append(video);
      const canvas = document.createElement('canvas');
      canvas.className = 'second-camera';
      canvas.setAttribute('aria-label', 'Second camera view');
      const stats = document.createElement('p');
      stats.className = 'debug-stats second-camera';
      this.debugPanel.append(canvas, stats);
      this.second = { video, canvas, stats };
    }
    return this.second;
  }

  /** @returns {Eye} */
  makeEye(index, calibration, video, canvas, stats) {
    return {
      index,
      calibration,
      video,
      canvas,
      stats,
      stream: null,
      grabber: null,
      detector: null,
      latencyMs: calibration.latencyMs ?? DEFAULT_LATENCY_MS,
      captureClock: calibration.frameClock === 'capture',
      reader: null,
      model: calibration.videoWidth > 0 && calibration.videoHeight > 0 ? cameraModel({
        cameraToScreen: calibration.cameraToScreen,
        imageAspect: calibration.videoHeight / calibration.videoWidth,
        screenAspect: this.screenAspect,
        fovDeg: calibration.fovDeg ?? null,
      }) : null,
      held: null,
      manualExposure: null,
      heldNames: '',
      brightness: null,
      exposureNote: '',
      lastBallHit: null,
      fps: { frames: 0, since: 0, value: 0 },
    };
  }

  /** Shows a camera's stream in its video and starts looking for balls in it. */
  async startEye(session, eye, stream) {
    eye.stream = stream;
    this.eyes = [...this.eyes.filter((e) => e.index !== eye.index), eye].sort((a, b) => a.index - b.index);
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (eye.stream !== stream) return;
      if (eye.index === 0) {
        this.stopCamera();
        this.setNote(GAME_MESSAGES.cameraOff('disconnected'));
      } else {
        this.stopEye(eye);
        this.setSecondNote(GAME_MESSAGES.secondCameraOff('disconnected'));
      }
    });
    // An exposure set by hand in Setup: set now, so the camera never adjusts it by itself.
    const manual = loadSettings().cameraExposure[eye.calibration.cameraId];
    const track = stream.getVideoTracks()[0];
    eye.manualExposure = manual && track ? setExposure(track, manual).catch(() => false) : null;
    eye.video.srcObject = stream;
    eye.video.play().catch(() => {});
    await videoReady(eye.video);
    if (session !== this.session || eye.stream !== stream) return;
    eye.grabber = createGrabber(eye.video, PROCESS_WIDTH);
    eye.detector = new HitDetector({
      width: eye.grabber.width,
      height: eye.grabber.height,
      cameraToScreen: eye.calibration.cameraToScreen,
      // Launch mode: the whole picture, several things at once, a path for each stretch of flight; the
      // tracker spaces the hits out itself.
      options: this.launch ? {
        lanes: 6, splitAtHit: true, watchAll: true, cooldownMs: 0,
      } : {},
    });
    // The game's picture appeared while the camera was starting, and the
    // camera may not show it yet: let it settle before looking for balls.
    eye.detector.suppressAll(performance.now() + SETTLE_MS);
    this.tracker.addCamera(eye.index, {
      cameraToScreen: eye.calibration.cameraToScreen,
      latencyMs: eye.latencyMs,
      imageAspect: eye.grabber.height / eye.grabber.width,
      model: eye.model,
    });
    eye.canvas.width = eye.grabber.width;
    eye.canvas.height = eye.grabber.height;
    this.excluded = [];
    this.updateExcluded();
    eye.reader = readFrames(stream.getVideoTracks()[0], (frame, time) => {
      if (session === this.session && eye.detector) this.onFrame(session, eye, { time, source: frame });
    });
    if (!eye.reader) this.scheduleFrame(session, eye);
    setTimeout(() => this.holdCamera(session, eye, stream), HOLD_AFTER_MS);
  }

  stop() {
    this.session++;
    // Nothing more for the game: not even a hit that was waiting for another camera.
    this.tracker = null;
    this.stopCamera();
    this.tracked.clear();
  }

  stopCamera() {
    for (const eye of this.eyes) this.stopEye(eye);
    this.eyes = [];
    this.video.srcObject = null;
    this.debugPanel.classList.remove('two-cameras');
  }

  stopEye(eye) {
    const { stream, held } = eye;
    // Give the camera its automatic settings back before closing it.
    if (held) held.then((h) => stopStreamReleasing(stream, h));
    else stopStream(stream);
    eye.reader?.stop();
    eye.reader = null;
    eye.held = null;
    eye.stream = null;
    eye.video.srcObject = null;
    eye.grabber = null;
    eye.detector = null;
    this.eyes = this.eyes.filter((e) => e !== eye);
    this.tracker?.removeCamera(eye.index, performance.now());
    if (eye.index === 1) this.debugPanel.classList.remove('two-cameras');
  }

  /** Holds a camera's exposure, white balance and focus where it has adjusted them to. */
  holdCamera(session, eye, stream) {
    if (session !== this.session || eye.stream !== stream || !eye.detector) return;
    // Held at the values the camera has now, so the picture barely changes; if
    // it does jump, the detector follows exposure changes anyway. So a throw
    // at that moment still counts.
    const track = stream.getVideoTracks()[0];
    const before = eye.brightness;
    // An exposure set by hand is already manual, so holdAdjustments leaves it be.
    eye.held = Promise.resolve(eye.manualExposure).then((byHand) => {
      if (byHand) eye.exposureNote = 'exposure set by hand';
      return holdAdjustments(track);
    }).then(async (held) => {
      if (held.some((h) => h.mode === 'exposureMode')) {
        await new Promise((resolve) => { setTimeout(resolve, HOLD_CHECK_MS); });
        if (eye.stream === stream && heldTooDark(before, eye.brightness)) {
          console.info(`Holding the camera's exposure darkened the picture (brightness ${Math.round(before)} → ${Math.round(eye.brightness)}): leaving it automatic.`);
          held = await releaseSomeAdjustments(track, held, (h) => h.mode === 'exposureMode');
          eye.exposureNote = 'exposure automatic (holding it darkened the picture)';
        }
      }
      if (eye.stream === stream) eye.heldNames = held.map((h) => h.name).join(', ');
      return held;
    });
  }

  /** A message about the cameras for the players, or '' when all is well. */
  get note() {
    return [this.mainNote, this.secondNote].filter(Boolean).join(' ');
  }

  setNote(text) {
    this.mainNote = text;
    this.onNote();
  }

  setSecondNote(text) {
    this.secondNote = text;
    this.onNote();
  }

  /** The main camera, while it runs. */
  get main() {
    return this.eyes.find((e) => e.index === 0) ?? null;
  }

  /** Forgets where the cameras last saw a ball hit (shown in the camera views). */
  clearMarks() {
    for (const eye of this.eyes) eye.lastBallHit = null;
  }

  /**
   * The game is about to change its picture inside `rect`: don't take that for a ball.
   * @param {Rect} rect
   * @param {number} [ms] how long the change lasts (an animation), before it settles
   */
  pictureChange(rect, ms = 0) {
    for (const eye of this.eyes) eye.detector?.suppress(rect, performance.now() + ms + SETTLE_MS);
  }

  /** The whole picture is about to change (e.g. cleared): ignore everything until it settles. */
  pictureChangeEverywhere(ms = 0) {
    for (const eye of this.eyes) eye.detector?.suppressAll(performance.now() + ms + SETTLE_MS);
  }

  /**
   * Changes near a point, e.g. a mark appearing where a ball hit.
   * @param {Point} point
   * @param {number} radius fraction of the shorter screen side
   */
  pictureChangeAround(point, radius, ms = 0) {
    const r = (radius + CHANGE_MARGIN) * Math.min(window.innerWidth, window.innerHeight);
    const rx = r / window.innerWidth;
    const ry = r / window.innerHeight;
    this.pictureChange({ x0: point.x - rx, y0: point.y - ry, x1: point.x + rx, y1: point.y + ry }, ms);
  }

  toggleDebug() {
    this.debug = !this.debug;
    this.debugPanel.hidden = !this.debug;
    this.updateExcluded();
  }

  // ---- Moving things ----

  /** Records where every tracked element is, each animation frame. */
  recordPositions(session) {
    const record = () => {
      if (session !== this.session) return;
      const now = performance.now();
      for (const [el, sprite] of this.tracked) {
        if (!sprite.active) continue;
        sprite.history.add(now, el.isConnected ? rectOf(el) : null);
        if (sprite.history.gone) this.tracked.delete(el);
      }
      requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
  }

  /** Where the tracked things are in a camera frame taken at `time`, by a camera with this delay, for its detector. */
  spritesAt(time, latencyMs) {
    const shown = time - latencyMs;
    const sprites = [];
    for (const sprite of this.tracked.values()) {
      if (!sprite.active) continue;
      const { shape, watch, history } = sprite;
      const boxes = [shown - LATENCY_SLACK_MS, shown, shown + LATENCY_SLACK_MS].map((t) => history.at(t));
      const known = boxes.filter(Boolean);
      if (!known.length) continue;
      // Appearing or disappearing around now: just keep the detector off it.
      // Each time an element is tracked, it is a new sprite, whose look is learned afresh.
      sprites.push({ key: sprite, shape, watch: watch && known.length === boxes.length, boxes: known });
    }
    return sprites;
  }

  /**
   * Where a tracked element was on screen at `time` (e.g. a hit's time), in
   * normalised screen coordinates. Null if it wasn't shown then.
   */
  whereWas(el, time) {
    return this.tracked.get(el)?.history.at(time) ?? null;
  }

  // ---- Camera frames ----

  /** Where every frame can't be read: the video's next frame, as the screen refreshes. */
  scheduleFrame(session, eye) {
    const next = (_now, metadata) => {
      if (session !== this.session || !eye.detector) return;
      const now = performance.now();
      // Timed the way calibration timed the delay: by when the camera took the frame, where it can be.
      const time = (eye.captureClock ? captureTimeOf(metadata, now) : null) ?? now;
      this.onFrame(session, eye, { time, source: eye.video });
      if (session === this.session && eye.detector) this.scheduleFrame(session, eye);
    };
    if (eye.video.requestVideoFrameCallback) eye.video.requestVideoFrameCallback(next);
    else setTimeout(next, 33);
  }

  /**
   * Looks at one camera frame.
   * @param {{time: number, source: CanvasImageSource}} frame its time (page clock, ms) and picture
   */
  onFrame(session, eye, { time, source }) {
    const now = performance.now();
    const luma = eye.grabber.grab(source);
    eye.brightness = meanLuma(luma);
    const unit = Math.min(window.innerWidth, window.innerHeight);
    eye.detector.setSprites(this.spritesAt(time, eye.latencyMs), {
      x: (CHANGE_MARGIN * unit) / window.innerWidth,
      y: (CHANGE_MARGIN * unit) / window.innerHeight,
    }, time);
    const result = eye.detector.process(luma, time);
    if (result.hit) eye.lastBallHit = result.hit.camera;
    countFrame(eye.fps, time);
    this.tracker.frame(eye.index, {
      time, now, followingAll: eye.detector.followingAll, ended: eye.detector.takeEnded(), hits: result.hits, people: result.people,
    });
    // A hit may have ended the game (and the camera).
    if (session !== this.session) return;
    if (this.debug && eye.detector) this.drawDebug(eye, luma, result);
  }

  /** What each running camera is and where it seems to be, for Ball Test's data. */
  cameraInfo() {
    return this.eyes.map((eye) => {
      const settings = eye.stream?.getVideoTracks()[0]?.getSettings?.() ?? {};
      return {
        camera: eye.index,
        label: eye.calibration.cameraLabel,
        width: settings.width ?? eye.video.videoWidth,
        height: settings.height ?? eye.video.videoHeight,
        fps: eye.fps.value,
        latencyMs: eye.latencyMs,
        blips: this.tracker?.blipsOf(eye.index) ?? 0,
        model: eye.model,
      };
    });
  }

  /** Keeps the detectors from watching on-screen controls and the camera view. */
  updateExcluded() {
    if (!this.eyes.some((e) => e.detector)) return;
    const rects = this.ignoredElements.filter(isShown).map((el) => rectOf(el, 0.02));
    if (this.debug) rects.push(rectOf(this.debugPanel, 0.02));
    // Areas no longer covered weren't watched, so let the cameras re-learn them.
    for (const old of this.excluded) this.pictureChange(old);
    this.excluded = rects;
    for (const eye of this.eyes) eye.detector?.setExcluded(rects);
  }

  // ---- Camera view (D) ----

  drawDebug(eye, luma, result) {
    const { width: w, height: h } = eye.grabber;
    const ctx = eye.canvas.getContext('2d');
    if (eye.debugImage?.width !== w || eye.debugImage?.height !== h) eye.debugImage = ctx.createImageData(w, h);
    const px = eye.debugImage.data;
    const fg = eye.detector.foregroundMask;
    const sprites = eye.detector.spriteMask;
    const people = eye.detector.personZone;
    const cellOf = eye.detector.personCellOf;
    for (let i = 0, j = 0; i < luma.length; i++, j += 4) {
      if (fg[i]) {
        px[j] = 255; px[j + 1] = 60; px[j + 2] = 60;
      } else if (people[cellOf[i]]) {
        // Around a person (or their shadow): nothing is followed here, tinted magenta.
        px[j] = luma[i] * 0.5 + 110; px[j + 1] = luma[i] * 0.3; px[j + 2] = luma[i] * 0.5 + 110;
      } else if (sprites[i] === 2) {
        // A moving thing the detector knows about: tinted blue.
        px[j] = luma[i] * 0.5; px[j + 1] = luma[i] * 0.7; px[j + 2] = 90 + luma[i] * 0.6;
      } else if (sprites[i] === 1) {
        px[j] = px[j + 1] = px[j + 2] = luma[i] * 0.4; // ignored edge: darkened
      } else {
        px[j] = px[j + 1] = px[j + 2] = luma[i];
      }
      px[j + 3] = 255;
    }
    ctx.putImageData(eye.debugImage, 0, 0);

    const line = (points, colour, close) => {
      if (points.length < 2) return;
      ctx.beginPath();
      points.forEach((p, i) => (i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h)));
      if (close) ctx.closePath();
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };
    line(eye.calibration.screenCornersCamera, '#3ddc84', true);
    for (const path of result.tracks) line(path, '#ffe066', false);
    ctx.strokeStyle = '#6cc4ff';
    for (const b of result.blobs) {
      ctx.beginPath();
      ctx.arc(b.x * w, b.y * h, 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (eye.lastBallHit) {
      const x = eye.lastBallHit.x * w;
      const y = eye.lastBallHit.y * h;
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y);
      ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6);
      ctx.stroke();
    }

    const state = result.sceneChange ? 'Whole picture changed – relearning'
      : result.tracks.length ? 'Following the ball' : 'Waiting for a throw';
    const held = (eye.heldNames ? ` · holding ${eye.heldNames}` : '') + (eye.exposureNote ? ` · ${eye.exposureNote}` : '');
    const verdict = result.verdict ? ` · last throw: ${result.verdict}` : '';
    const which = this.eyes.length > 1 || eye.index > 0 ? `${eye.index ? 'Second' : 'Main'} camera: ` : '';
    eye.stats.textContent = `${which}${state} · moving pixels: ${result.changed} · ${eye.fps.value} fps${held}${verdict}`;
  }
}

/** Counts a camera's frames, to show its frame rate. */
function countFrame(fps, now) {
  fps.frames++;
  if (now - fps.since >= 1000) {
    fps.value = Math.round((fps.frames * 1000) / (now - fps.since));
    fps.frames = 0;
    fps.since = now;
  }
}

/** Shows the camera note, plus a reminder when not in full screen, in a game's status box. */
export function renderGameStatus(statusEl, note) {
  const lines = [note];
  if (!document.fullscreenElement) lines.push(GAME_MESSAGES.notFullscreen);
  statusEl.replaceChildren(...lines.filter(Boolean).map((text) => {
    const p = document.createElement('p');
    p.textContent = text;
    return p;
  }));
}

/** An element's area in normalised screen coordinates, with some padding. */
export function rectOf(el, pad = 0) {
  const r = el.getBoundingClientRect();
  const w = window.innerWidth;
  const h = window.innerHeight;
  return { x0: r.left / w - pad, y0: r.top / h - pad, x1: r.right / w + pad, y1: r.bottom / h + pad };
}

function isShown(el) {
  return !el.hidden && el.getClientRects().length > 0;
}

function videoReady(video) {
  if (video.videoWidth) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Camera video did not start')), 5000);
    video.addEventListener('loadedmetadata', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
