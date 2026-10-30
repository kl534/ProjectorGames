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
// so it doesn't change the whole picture as players come and go.
//
// Expects the game's screen element to contain a <video>, and a
// `.debug-panel` holding a <canvas> and a `.debug-stats` line.

import {
  CAMERA_MESSAGES, CameraError, holdAdjustments, openPreferredCamera, stopStream, stopStreamReleasing,
} from './camera.js';
import { captureTimeOf, createGrabber } from './frames.js';
import { HitDetector } from './hit-detector.js';
import { SpriteHistory } from './sprite-history.js';

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

export const GAME_MESSAGES = {
  differentCamera: 'This isn’t the camera that was calibrated – recalibrate in Setup for accurate hits.',
  notFullscreen: 'Press F for full screen – hits only line up in full screen.',
  starting: 'Starting camera…',
  cameraOff: (kind) => `${CAMERA_MESSAGES[kind].split(' – ')[0]} – ball detection is off. Mouse clicks still work.`,
  noLatency: 'Recalibrate in Setup so throws at moving things line up.',
  noCameraMode: 'Recalibrate in Setup to run the camera at its fastest, for more accurate hits.',
};

/**
 * @typedef {{x:number, y:number}} Point normalised screen coordinates
 * @typedef {{x0:number, y0:number, x1:number, y1:number}} Rect normalised screen coordinates
 */

export class ThrowCamera {
  /**
   * @param {HTMLElement} root the game's screen element
   * @param {object} handlers
   * @param {(point: Point, info: {time: number}) => void} handlers.onHit a ball hit the screen
   *   here, on the picture that was on screen at `time` (performance.now() ms)
   * @param {() => void} handlers.onNote the camera note (see `note`) changed
   * @param {boolean} [handlers.moving] the game moves things around (and tracks them)
   */
  constructor(root, { onHit, onNote, moving = false }) {
    this.onHit = onHit;
    this.onNote = onNote;
    this.moving = moving;
    this.video = root.querySelector('video');
    this.debugPanel = root.querySelector('.debug-panel');
    this.debugCanvas = this.debugPanel.querySelector('canvas');
    this.debugStats = this.debugPanel.querySelector('.debug-stats');

    this.session = 0; // increments on start/stop so stale async work can tell it's outdated
    this.stream = null;
    this.grabber = null;
    this.detector = null;
    this.calibration = null;
    /** A message about the camera for the players, or '' when all is well. */
    this.note = '';
    this.debug = false;
    this.ignoredElements = [];
    this.excluded = [];
    this.lastBallHit = null;
    this.fps = { frames: 0, since: 0, value: 0 };
    this.latencyMs = DEFAULT_LATENCY_MS;
    // Whether frames are timed by when the camera took them, as the delay was measured.
    this.captureClock = false;
    /** @type {Promise<import('./camera.js').HeldAdjustment[]>|null} the camera settings held, once asked */
    this.held = null;
    this.heldNames = '';
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

  /** @param {import('./storage.js').Calibration} calibration */
  async start(calibration) {
    const session = ++this.session;
    this.calibration = calibration;
    this.latencyMs = calibration.latencyMs ?? DEFAULT_LATENCY_MS;
    this.captureClock = calibration.frameClock === 'capture';
    this.lastBallHit = null;
    this.setNote(GAME_MESSAGES.starting);
    this.recordPositions(session);
    try {
      // The mode it was calibrated in: another mode may see a different part of the picture.
      const { stream, deviceId } = await openPreferredCamera(calibration.cameraId, { mode: calibration.cameraMode });
      if (session !== this.session) {
        stopStream(stream);
        return;
      }
      this.stream = stream;
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (this.stream !== stream) return;
        this.stopCamera();
        this.setNote(GAME_MESSAGES.cameraOff('disconnected'));
      });
      this.video.srcObject = stream;
      this.video.play().catch(() => {});
      await videoReady(this.video);
      if (session !== this.session) return;
      this.grabber = createGrabber(this.video, PROCESS_WIDTH);
      this.detector = new HitDetector({
        width: this.grabber.width,
        height: this.grabber.height,
        cameraToScreen: calibration.cameraToScreen,
      });
      // The game's picture appeared while the camera was starting, and the
      // camera may not show it yet: let it settle before looking for balls.
      this.pictureChangeEverywhere();
      this.debugCanvas.width = this.grabber.width;
      this.debugCanvas.height = this.grabber.height;
      this.excluded = [];
      this.updateExcluded();
      if (deviceId && deviceId !== calibration.cameraId) this.setNote(GAME_MESSAGES.differentCamera);
      else if (this.moving && calibration.latencyMs === undefined) this.setNote(GAME_MESSAGES.noLatency);
      else this.setNote(calibration.cameraMode ? '' : GAME_MESSAGES.noCameraMode);
      this.scheduleFrame(session);
      setTimeout(() => this.holdCamera(session, stream), HOLD_AFTER_MS);
    } catch (err) {
      if (session !== this.session) return;
      if (!(err instanceof CameraError)) console.error(err);
      this.stopCamera();
      this.setNote(GAME_MESSAGES.cameraOff(err instanceof CameraError ? err.kind : 'error'));
    }
  }

  stop() {
    this.session++;
    this.stopCamera();
    this.tracked.clear();
  }

  stopCamera() {
    const { stream, held } = this;
    // Give the camera its automatic settings back before closing it.
    if (held) held.then((h) => stopStreamReleasing(stream, h));
    else stopStream(stream);
    this.held = null;
    this.heldNames = '';
    this.stream = null;
    this.video.srcObject = null;
    this.grabber = null;
    this.detector = null;
  }

  /** Holds the camera's exposure, white balance and focus where it has adjusted them to. */
  holdCamera(session, stream) {
    if (session !== this.session || this.stream !== stream || !this.detector) return;
    // Held at the values the camera has now, so the picture barely changes; if
    // it does jump, the detector follows exposure changes anyway. So a throw
    // at that moment still counts.
    this.held = holdAdjustments(stream.getVideoTracks()[0]).then((held) => {
      if (this.stream === stream) this.heldNames = held.map((h) => h.name).join(', ');
      return held;
    });
  }

  setNote(text) {
    this.note = text;
    this.onNote();
  }

  /**
   * The game is about to change its picture inside `rect`: don't take that for a ball.
   * @param {Rect} rect
   * @param {number} [ms] how long the change lasts (an animation), before it settles
   */
  pictureChange(rect, ms = 0) {
    this.detector?.suppress(rect, performance.now() + ms + SETTLE_MS);
  }

  /** The whole picture is about to change (e.g. cleared): ignore everything until it settles. */
  pictureChangeEverywhere(ms = 0) {
    this.detector?.suppressAll(performance.now() + ms + SETTLE_MS);
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

  /** Where the tracked things are in a camera frame taken at `time`, for the detector. */
  spritesAt(time) {
    const shown = time - this.latencyMs;
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

  scheduleFrame(session) {
    const next = (_now, metadata) => {
      if (session === this.session && this.detector) this.onFrame(session, metadata);
    };
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(next);
    else setTimeout(next, 33);
  }

  onFrame(session, metadata) {
    const now = performance.now();
    // Timed the way calibration timed the delay: by when the camera took the frame, where it can be.
    const time = (this.captureClock ? captureTimeOf(metadata, now) : null) ?? now;
    const luma = this.grabber.grab();
    const unit = Math.min(window.innerWidth, window.innerHeight);
    this.detector.setSprites(this.spritesAt(time), {
      x: (CHANGE_MARGIN * unit) / window.innerWidth,
      y: (CHANGE_MARGIN * unit) / window.innerHeight,
    }, time);
    const result = this.detector.process(luma, time);
    if (result.hit) {
      this.lastBallHit = result.hit.camera;
      this.onHit(result.hit.screen, { time: result.hit.time - this.latencyMs });
    }
    this.countFrame(time);
    // onHit may have ended the game (and the camera).
    if (this.debug && this.detector) this.drawDebug(luma, result);
    this.scheduleFrame(session);
  }

  countFrame(now) {
    const { fps } = this;
    fps.frames++;
    if (now - fps.since >= 1000) {
      fps.value = Math.round((fps.frames * 1000) / (now - fps.since));
      fps.frames = 0;
      fps.since = now;
    }
  }

  /** Keeps the detector from watching on-screen controls and the camera view. */
  updateExcluded() {
    if (!this.detector) return;
    const rects = this.ignoredElements.filter(isShown).map((el) => rectOf(el, 0.02));
    if (this.debug) rects.push(rectOf(this.debugPanel, 0.02));
    // Areas no longer covered weren't watched, so let the camera re-learn them.
    for (const old of this.excluded) this.pictureChange(old);
    this.excluded = rects;
    this.detector.setExcluded(rects);
  }

  // ---- Camera view (D) ----

  drawDebug(luma, result) {
    const { width: w, height: h } = this.grabber;
    const ctx = this.debugCanvas.getContext('2d');
    if (this.debugImage?.width !== w || this.debugImage?.height !== h) this.debugImage = ctx.createImageData(w, h);
    const px = this.debugImage.data;
    const fg = this.detector.foregroundMask;
    const sprites = this.detector.spriteMask;
    for (let i = 0, j = 0; i < luma.length; i++, j += 4) {
      if (fg[i]) {
        px[j] = 255; px[j + 1] = 60; px[j + 2] = 60;
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
    ctx.putImageData(this.debugImage, 0, 0);

    const line = (points, colour, close) => {
      if (points.length < 2) return;
      ctx.beginPath();
      points.forEach((p, i) => (i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h)));
      if (close) ctx.closePath();
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };
    line(this.calibration.screenCornersCamera, '#3ddc84', true);
    line(result.track, '#ffe066', false);
    ctx.strokeStyle = '#6cc4ff';
    for (const b of result.blobs) {
      ctx.beginPath();
      ctx.arc(b.x * w, b.y * h, 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (this.lastBallHit) {
      const x = this.lastBallHit.x * w;
      const y = this.lastBallHit.y * h;
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y);
      ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6);
      ctx.stroke();
    }

    const state = result.sceneChange ? 'Whole picture changed – relearning'
      : result.track.length ? 'Following the ball' : 'Waiting for a throw';
    const held = this.heldNames ? ` · holding ${this.heldNames}` : '';
    this.debugStats.textContent = `${state} · moving pixels: ${result.changed} · ${this.fps.value} fps${held}`;
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
