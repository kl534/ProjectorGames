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
//
// With a second camera, both watch the same markers and flashes at once, and
// each gets its own mapping and delay.

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
 * Runs the calibration pattern and looks for the markers in each camera's
 * picture, retrying until every camera has found them or the time runs out.
 * All the cameras watch the same markers at once, so two cameras take no
 * longer than one.
 * @param {object} args
 * @param {HTMLVideoElement[]} args.videos each camera's playing video
 * @param {{show(index: number|null): void, markerCentres(): {x:number,y:number}[]}} args.pattern
 * @param {AbortSignal} [args.signal] abort to cancel (the promise then rejects with an AbortError)
 * @returns {Promise<{cameras: (object|null)[]}>} each camera's calibration data (without date/camera
 *   info), in the order of `videos`, or null for a camera that couldn't find all four markers
 */
export async function findScreenCorners({
  videos, pattern, signal, timeoutMs = CALIBRATION_TIMEOUT_MS, timing = {},
}) {
  const t = { ...DEFAULT_TIMING, ...timing };
  const deadline = Date.now() + timeoutMs;
  /** @type {(object|null)[]} */
  const found = videos.map(() => null);
  try {
    for (const video of videos) await waitForVideo(video, signal);
    const grabbers = videos.map((video) => createGrabber(video, PROCESS_WIDTH));
    let attempt = 0;
    while (Date.now() < deadline && found.some((f) => f === null)) {
      const wanted = found.map((f) => f === null);
      const results = await attemptOnce(grabbers, wanted, pattern, t, attempt === 0, deadline, signal);
      results.forEach((r, i) => { if (r) found[i] = r; });
      attempt++;
    }
    const latencies = await measureLatency({
      videos, grabbers, pattern, cameras: found, t, signal,
    });
    return {
      cameras: found.map((f, i) => {
        if (!f) return null;
        const { levels, ...rest } = f;
        return {
          ...rest,
          ...latencies[i],
          videoWidth: videos[i].videoWidth,
          videoHeight: videos[i].videoHeight,
        };
      }),
    };
  } finally {
    pattern.show(null);
  }
}

/** Lights each marker in turn; returns what each wanted camera found (null where it failed). */
async function attemptOnce(grabbers, wanted, pattern, t, first, deadline, signal) {
  pattern.show(null);
  await sleep(first ? t.firstSettleMs : t.settleMs, signal);
  const markersScreen = pattern.markerCentres();
  const baselines = await captureAverage(grabbers, t, signal);

  const looking = [...wanted];
  const markersCamera = grabbers.map(() => []);
  const levels = grabbers.map(() => null);
  for (let corner = 0; corner < 4 && looking.some(Boolean); corner++) {
    if (Date.now() > deadline) return grabbers.map(() => null);
    pattern.show(corner);
    await sleep(t.settleMs, signal);
    const frames = await captureAverage(grabbers, t, signal);
    grabbers.forEach((grabber, i) => {
      if (!looking[i]) return;
      const marker = findMarker(baselines[i], frames[i], grabber.width, grabber.height);
      if (!marker) {
        looking[i] = false;
        return;
      }
      markersCamera[i].push({ x: marker.x, y: marker.y });
      // How bright the first marker's spot is, dark and lit, for timing the delay.
      if (corner === 0) {
        levels[i] = {
          dark: brightnessAt(baselines[i], grabber.width, grabber.height, marker),
          lit: brightnessAt(frames[i], grabber.width, grabber.height, marker),
        };
      }
    });
  }
  pattern.show(null);

  // The window changed size part-way through (e.g. entering full screen): measure again.
  const moved = pattern.markerCentres()
    .some((p, i) => Math.abs(p.x - markersScreen[i].x) > 1e-3 || Math.abs(p.y - markersScreen[i].y) > 1e-3);
  if (moved) return grabbers.map(() => null);

  return grabbers.map((_, i) => {
    if (!looking[i]) return null;
    const mapping = buildCalibration(markersCamera[i], markersScreen);
    if (!mapping) return null;
    return { markersCamera: markersCamera[i], markersScreen, ...mapping, levels: levels[i] };
  });
}

/**
 * Times how long each camera takes to see the first marker light up: flashes
 * it a few times and watches its spot frame by frame, in every camera at once.
 * Returns each camera's median delay in ms (nothing for a camera where it
 * couldn't be measured). Timed like the games: from the animation frame that
 * shows the change to the camera frame that shows it. Camera frames are timed
 * by when the camera took them where the browser says (`frameClock:
 * 'capture'`), or else by when they reached the page.
 * @param {object} args
 * @param {(object|null)[]} args.cameras what each camera found (markersCamera, levels), null to skip it
 * @returns {Promise<{latencyMs?: number, frameClock?: 'capture'}[]>}
 */
async function measureLatency({
  videos, grabbers, pattern, cameras, t, signal,
}) {
  const timed = cameras.map((c) => Boolean(c && c.levels.lit - c.levels.dark >= 20));
  const delays = cameras.map(() => []);
  if (!timed.some(Boolean)) return cameras.map(() => ({}));
  for (let trial = 0; trial < t.latencyTrials; trial++) {
    pattern.show(null);
    await sleep(t.latencyDarkMs, signal);
    const shownAt = await nextAnimationFrame(() => pattern.show(0), signal);
    await Promise.all(cameras.map(async (camera, i) => {
      if (!timed[i]) return;
      const halfway = (camera.levels.dark + camera.levels.lit) / 2;
      const marker = camera.markersCamera[0];
      const { width, height } = grabbers[i];
      for (;;) {
        const frame = await nextVideoFrame(videos[i], signal);
        if (frame.arrived - shownAt > t.latencyGiveUpMs) break;
        if (brightnessAt(grabbers[i].grab(), width, height, marker) > halfway) {
          delays[i].push({ arrived: frame.arrived - shownAt, captured: frame.captured === null ? null : frame.captured - shownAt });
          break;
        }
      }
    }));
  }
  pattern.show(null);
  return delays.map((d) => {
    if (!d.length) return {};
    if (d.every((x) => x.captured !== null)) {
      return { latencyMs: Math.max(0, Math.round(median(d.map((x) => x.captured)))), frameClock: 'capture' };
    }
    return { latencyMs: Math.round(median(d.map((x) => x.arrived))) };
  });
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

/** Each camera's picture, averaged over a few frames taken at the same moments. */
async function captureAverage(grabbers, t, signal) {
  const sums = grabbers.map((g) => new Float32Array(g.width * g.height));
  for (let k = 0; k < t.frames; k++) {
    if (k > 0) await sleep(t.frameGapMs, signal);
    grabbers.forEach((grabber, i) => {
      const luma = grabber.grab();
      const sum = sums[i];
      for (let j = 0; j < sum.length; j++) sum[j] += luma[j];
    });
  }
  for (const sum of sums) for (let j = 0; j < sum.length; j++) sum[j] /= t.frames;
  return sums;
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
