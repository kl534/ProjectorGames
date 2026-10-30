// Automatic calibration: work out where the projected screen sits in the camera
// picture.
//
// The projector shows a dark screen, then lights the corner markers one at a
// time. Comparing each camera frame with the dark one finds that marker's
// position in the camera picture. Lighting them one by one (rather than all at
// once) means we always know which marker is which, even if the camera is
// upside down or mirrored. From the four marker positions we compute a
// homography (perspective mapping) between camera and screen coordinates.
//
// Then one marker is flashed a few more times, to time how long the camera
// takes to see it light up (projector + camera delay). Games need that delay
// to know where their moving things are in the camera picture.

import { findMarker } from './detect.js';
import { captureTimeOf, createGrabber } from './frames.js';
import {
  applyHomography, computeHomography, invertHomography, isConvexQuad, polygonArea,
} from './homography.js';

export const CORNER_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
export const CALIBRATION_TIMEOUT_MS = 10_000;

const DEFAULT_TIMING = {
  firstSettleMs: 800, // projector + camera + auto-exposure catching up with the dark screen
  settleMs: 400, // after lighting a marker
  frames: 3, // frames averaged per measurement, to reduce camera noise
  frameGapMs: 35,
  latencyTrials: 3, // flashes timed to measure the delay
  latencyDarkMs: 350, // dark time before each flash
  latencyGiveUpMs: 1500, // a flash not seen by then doesn't count
};

// Frames are analysed at this width (keeps detection fast; plenty of detail).
const PROCESS_WIDTH = 480;
// Markers closer together than this (fraction of the frame) can't be right.
const MIN_MARKER_SEPARATION = 0.03;
// The screen must cover at least this fraction of the camera picture.
const MIN_SCREEN_AREA = 0.02;

const SCREEN_CORNERS = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

/**
 * Turns four marker positions (normalised camera coords) and where those
 * markers were on screen (normalised screen coords) into the camera↔screen
 * mapping. Returns null if the geometry doesn't make sense.
 */
export function buildCalibration(markersCamera, markersScreen) {
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const d = Math.hypot(markersCamera[i].x - markersCamera[j].x, markersCamera[i].y - markersCamera[j].y);
      if (d < MIN_MARKER_SEPARATION) return null;
    }
  }
  if (!isConvexQuad(markersCamera)) return null;
  const cameraToScreen = computeHomography(markersCamera, markersScreen);
  if (!cameraToScreen) return null;
  const screenToCamera = invertHomography(cameraToScreen);
  if (!screenToCamera) return null;
  const screenCornersCamera = SCREEN_CORNERS.map((p) => applyHomography(screenToCamera, p));
  if (!screenCornersCamera.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
  if (!isConvexQuad(screenCornersCamera)) return null;
  if (polygonArea(screenCornersCamera) < MIN_SCREEN_AREA) return null;
  return { cameraToScreen, screenCornersCamera };
}

/**
 * Runs the calibration pattern and looks for the markers, retrying until it
 * succeeds or the time runs out.
 * @param {object} args
 * @param {HTMLVideoElement} args.video playing camera video
 * @param {{show(index: number|null): void, markerCentres(): {x:number,y:number}[]}} args.pattern
 * @param {AbortSignal} [args.signal] abort to cancel (the promise then rejects with an AbortError)
 * @returns {Promise<object|null>} calibration data (without date/camera info), or null on failure
 */
export async function findScreenCorners({
  video, pattern, signal, timeoutMs = CALIBRATION_TIMEOUT_MS, timing = {},
}) {
  const t = { ...DEFAULT_TIMING, ...timing };
  const deadline = Date.now() + timeoutMs;
  try {
    await waitForVideo(video, signal);
    const grabber = createGrabber(video, PROCESS_WIDTH);
    let attempt = 0;
    while (Date.now() < deadline) {
      const result = await attemptOnce(grabber, pattern, t, attempt === 0, deadline, signal);
      if (result) {
        const { levels, ...found } = result;
        const latency = await measureLatency({
          video, grabber, pattern, marker: found.markersCamera[0], levels, t, signal,
        });
        return {
          ...found,
          ...latency,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
        };
      }
      attempt++;
    }
    return null;
  } finally {
    pattern.show(null);
  }
}

async function attemptOnce(grabber, pattern, t, first, deadline, signal) {
  pattern.show(null);
  await sleep(first ? t.firstSettleMs : t.settleMs, signal);
  const markersScreen = pattern.markerCentres();
  const baseline = await captureAverage(grabber, t, signal);

  const markersCamera = [];
  let levels = null;
  for (let corner = 0; corner < 4; corner++) {
    if (Date.now() > deadline) return null;
    pattern.show(corner);
    await sleep(t.settleMs, signal);
    const frame = await captureAverage(grabber, t, signal);
    const found = findMarker(baseline, frame, grabber.width, grabber.height);
    if (!found) return null;
    markersCamera.push({ x: found.x, y: found.y });
    // How bright the first marker's spot is, dark and lit, for timing the delay.
    if (corner === 0) {
      levels = {
        dark: brightnessAt(baseline, grabber.width, grabber.height, found),
        lit: brightnessAt(frame, grabber.width, grabber.height, found),
      };
    }
  }
  pattern.show(null);

  // The window changed size part-way through (e.g. entering full screen): measure again.
  const moved = pattern.markerCentres()
    .some((p, i) => Math.abs(p.x - markersScreen[i].x) > 1e-3 || Math.abs(p.y - markersScreen[i].y) > 1e-3);
  if (moved) return null;

  const mapping = buildCalibration(markersCamera, markersScreen);
  if (!mapping) return null;
  return { markersCamera, markersScreen, ...mapping, levels };
}

/**
 * Times how long the camera takes to see the first marker light up: flashes it
 * a few times and watches its spot frame by frame. Returns the median delay in
 * ms (nothing if it couldn't be measured). Timed like the games: from the
 * animation frame that shows the change to the camera frame that shows it.
 * Camera frames are timed by when the camera took them where the browser says
 * (`frameClock: 'capture'`), or else by when they reached the page.
 * @returns {Promise<{latencyMs?: number, frameClock?: 'capture'}>}
 */
async function measureLatency({
  video, grabber, pattern, marker, levels, t, signal,
}) {
  if (levels.lit - levels.dark < 20) return {};
  const halfway = (levels.dark + levels.lit) / 2;
  const delays = [];
  for (let trial = 0; trial < t.latencyTrials; trial++) {
    pattern.show(null);
    await sleep(t.latencyDarkMs, signal);
    const shownAt = await nextAnimationFrame(() => pattern.show(0), signal);
    for (;;) {
      const frame = await nextVideoFrame(video, signal);
      if (frame.arrived - shownAt > t.latencyGiveUpMs) break;
      if (brightnessAt(grabber.grab(), grabber.width, grabber.height, marker) > halfway) {
        delays.push({ arrived: frame.arrived - shownAt, captured: frame.captured === null ? null : frame.captured - shownAt });
        break;
      }
    }
  }
  pattern.show(null);
  if (!delays.length) return {};
  if (delays.every((d) => d.captured !== null)) {
    return { latencyMs: Math.max(0, Math.round(median(delays.map((d) => d.captured)))), frameClock: 'capture' };
  }
  return { latencyMs: Math.round(median(delays.map((d) => d.arrived))) };
}

/** Mean brightness of the 3×3 pixels around a point (normalised coords) of a frame. */
export function brightnessAt(luma, width, height, point) {
  const cx = Math.min(width - 2, Math.max(1, Math.floor(point.x * width)));
  const cy = Math.min(height - 2, Math.max(1, Math.floor(point.y * height)));
  let sum = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += luma[(cy + dy) * width + cx + dx];
  return sum / 9;
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Runs `change` in the next animation frame; resolves with that frame's time. */
function nextAnimationFrame(change, signal) {
  return new Promise((resolve, reject) => {
    requestAnimationFrame(() => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      change();
      resolve(performance.now());
    });
  });
}

/**
 * Resolves when the next camera frame arrives (or soon, if the browser can't
 * tell) with when it arrived and, where the browser says, when the camera took it.
 * @returns {Promise<{arrived: number, captured: number|null}>}
 */
function nextVideoFrame(video, signal) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (_now, metadata) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const arrived = performance.now();
      if (signal?.aborted) reject(abortError());
      else resolve({ arrived, captured: captureTimeOf(metadata, arrived) });
    };
    // Without frame callbacks, check every 40 ms; with them, wait for the
    // frame, even from a slow camera (but not for ever, if it stops).
    const timer = setTimeout(finish, video.requestVideoFrameCallback ? 500 : 40);
    video.requestVideoFrameCallback?.(finish);
  });
}

async function captureAverage(grabber, t, signal) {
  const sum = new Float32Array(grabber.width * grabber.height);
  for (let k = 0; k < t.frames; k++) {
    if (k > 0) await sleep(t.frameGapMs, signal);
    const luma = grabber.grab();
    for (let i = 0; i < sum.length; i++) sum[i] += luma[i];
  }
  for (let i = 0; i < sum.length; i++) sum[i] /= t.frames;
  return sum;
}

async function waitForVideo(video, signal) {
  for (let waited = 0; video.videoWidth === 0 || video.readyState < 2; waited += 50) {
    if (waited > 3000) throw new Error('Camera video is not playing');
    await sleep(50, signal);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  return new DOMException('Calibration cancelled', 'AbortError');
}
