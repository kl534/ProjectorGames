// Grabs camera frames as greyscale (luma) images for analysis.

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
    /** @returns {Float32Array} luma values 0–255, row by row */
    grab() {
      ctx.drawImage(video, 0, 0, width, height);
      return rgbaToLuma(ctx.getImageData(0, 0, width, height).data);
    },
  };
}
