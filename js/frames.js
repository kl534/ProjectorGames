// Grabs camera frames as greyscale (luma) images for analysis, and reads every
// frame a camera sends (readFrames), timed on the page's clock.
//
// A <video>'s frame callbacks come at most once per screen refresh, so a
// 120 frames a second camera on a 60 Hz projector would be seen at 60. Reading
// the camera's track directly (MediaStreamTrackProcessor, in Chrome) gets every frame.

import { rgbaToLuma } from './detect.js';

// A capture time further back than this is taken to be wrong.
const MAX_CAPTURE_AGE_MS = 1000;

/**
 * When the camera took a frame (performance.now() ms), from the metadata
 * requestVideoFrameCallback gives with it; null where the browser doesn't say.
 * Frames are taken at even intervals, but reach the page unevenly (it depends
 * on how busy the page is), so this is a steadier time than when the callback runs.
 * @param {{captureTime?: number}|undefined} metadata
 * @param {number} now when the callback ran
 */
export function captureTimeOf(metadata, now) {
  const t = metadata?.captureTime;
  return Number.isFinite(t) && t <= now && t > now - MAX_CAPTURE_AGE_MS ? t : null;
}

/**
 * @param {HTMLVideoElement} video playing camera video
 * @param {number} maxWidth frames are scaled down to at most this width
 */
export function createGrabber(video, maxWidth) {
  const width = Math.min(maxWidth, video.videoWidth);
  const height = Math.max(1, Math.round((width * video.videoHeight) / video.videoWidth));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    width,
    height,
    /**
     * @param {CanvasImageSource} [source] a frame of the same camera (a VideoFrame); the video's picture now if not given
     * @returns {Float32Array} luma values 0–255, row by row
     */
    grab(source = video) {
      ctx.drawImage(source, 0, 0, width, height);
      return rgbaToLuma(ctx.getImageData(0, 0, width, height).data);
    },
  };
}

/**
 * The average brightness of a greyscale frame, from every `step`th pixel.
 * @param {Float32Array} luma
 */
export function meanLuma(luma, step = 7) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < luma.length; i += step) {
    sum += luma[i];
    n++;
  }
  return n ? sum / n : 0;
}

// A frame's own timestamp is on the camera's clock. The page's clock runs
// slightly apart from it, so the offset between them may grow this much (ms per ms).
const CLOCK_DRIFT = 0.001;

/**
 * Times frames on the page's clock (performance.now() ms) from their own
 * timestamps (µs, on some clock of the camera's): as the earliest any frame
 * has reached the page, so frames that reach it late (the page was busy) are
 * still timed evenly. The calibration measures the camera's delay with the
 * same clock, so whatever the pipeline adds before that is part of the delay.
 */
export class FrameClock {
  constructor() {
    this.offset = null;
    this.lastArrived = null;
  }

  /**
   * @param {number} timestampUs the frame's timestamp (µs)
   * @param {number} arrived when it reached the page (ms)
   * @returns {number} its time (ms)
   */
  time(timestampUs, arrived) {
    const offset = arrived - timestampUs / 1000;
    if (this.offset === null || !Number.isFinite(timestampUs)) {
      this.offset = offset;
    } else {
      const allowed = this.offset + CLOCK_DRIFT * Math.max(0, arrived - this.lastArrived);
      this.offset = Math.min(offset, allowed);
    }
    this.lastArrived = arrived;
    return Number.isFinite(timestampUs) ? timestampUs / 1000 + this.offset : arrived;
  }
}

/** Whether readFrames can be used here. */
export function canReadFrames() {
  return typeof globalThis.MediaStreamTrackProcessor === 'function';
}

/**
 * Reads every frame a camera track sends, until stopped or the track ends.
 * `onFrame` is given each frame and its time, and must not keep the frame: it
 * is closed straight after (a camera runs out of frames to fill if they aren't).
 * Frames that arrive while one is being looked at wait (the latest few), so a
 * slow page sees fewer, but none twice.
 * @param {MediaStreamTrack} track
 * @param {(frame: VideoFrame, time: number) => void} onFrame
 * @returns {{stop: () => void, done: Promise<void>}|null} null where frames can't be read this way
 */
export function readFrames(track, onFrame) {
  if (!canReadFrames() || !track) return null;
  const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 4 }).readable.getReader();
  const clock = new FrameClock();
  let stopped = false;
  const done = (async () => {
    try {
      while (!stopped) {
        const { value: frame, done: ended } = await reader.read();
        if (ended) break;
        try {
          if (!stopped) onFrame(frame, clock.time(frame.timestamp, performance.now()));
        } catch (err) {
          console.error(err);
        } finally {
          frame.close();
        }
      }
    } catch (err) {
      if (!stopped) console.error(err);
    }
  })();
  return {
    stop() {
      stopped = true;
      reader.cancel().catch(() => {});
    },
    done,
  };
}
