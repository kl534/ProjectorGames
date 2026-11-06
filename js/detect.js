// Finds a projected calibration marker in a camera frame by comparing it with a
// "dark" baseline frame taken just before the marker was shown. Works on
// greyscale (luma) images stored as flat arrays, so it can be unit-tested
// without a browser.

/** Converts RGBA pixel data (e.g. ImageData.data) to luma values 0–255. */
export function rgbaToLuma(rgba, out = new Float32Array(rgba.length / 4)) {
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  return out;
}

const DEFAULTS = {
  // Smallest brightness increase (0–255) that counts as "the marker lit up".
  minContrast: 25,
  // Pixels at least this fraction of the brightest change belong to the marker.
  relThreshold: 0.5,
  // Marker must cover at least this many pixels…
  minArea: 4,
  // …and at most this fraction of the frame (more means the whole room changed).
  maxAreaFraction: 0.2,
  // Reject if a second bright patch is nearly as strong (reflection, second screen…).
  ambiguity: 0.6,
};

/**
 * Locates the brightest newly-lit patch in `frame` compared to `baseline`.
 * Returns its centre in normalised frame coordinates (0–1), or null if no
 * single clear marker is visible.
 * @param {ArrayLike<number>} baseline luma values, length width*height
 * @param {ArrayLike<number>} frame luma values, length width*height
 */
export function findMarker(baseline, frame, width, height, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const n = width * height;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = frame[i] - baseline[i];
    if (d > 0) raw[i] = d;
  }
  const diff = boxBlur3(raw, width, height);

  let peak = 0;
  for (let i = 0; i < n; i++) if (diff[i] > peak) peak = diff[i];
  if (peak < opts.minContrast) return null;
  const threshold = Math.max(opts.minContrast * 0.6, peak * opts.relThreshold);

  // Connected components (4-neighbour flood fill) over the thresholded diff.
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  let best = null;
  let second = null;
  for (let start = 0; start < n; start++) {
    if (visited[start] || diff[start] < threshold) continue;
    let area = 0;
    let weight = 0;
    let sx = 0;
    let sy = 0;
    let top = 0;
    stack[top++] = start;
    visited[start] = 1;
    while (top > 0) {
      const i = stack[--top];
      const x = i % width;
      const y = (i - x) / width;
      const w = diff[i];
      area++;
      weight += w;
      sx += w * x;
      sy += w * y;
      const neighbours = [
        x > 0 ? i - 1 : -1,
        x < width - 1 ? i + 1 : -1,
        y > 0 ? i - width : -1,
        y < height - 1 ? i + width : -1,
      ];
      for (const j of neighbours) {
        if (j >= 0 && !visited[j] && diff[j] >= threshold) {
          visited[j] = 1;
          stack[top++] = j;
        }
      }
    }
    const blob = { area, weight, cx: sx / weight, cy: sy / weight };
    if (!best || blob.weight > best.weight) {
      second = best;
      best = blob;
    } else if (!second || blob.weight > second.weight) {
      second = blob;
    }
  }

  if (!best || best.area < opts.minArea) return null;
  if (best.area > opts.maxAreaFraction * n) return null;
  if (second && second.weight > opts.ambiguity * best.weight) return null;

  // +0.5: pixel k covers [k, k+1), so its centre is at k + 0.5.
  return {
    x: (best.cx + 0.5) / width,
    y: (best.cy + 0.5) / height,
    area: best.area,
    peak,
  };
}

// 3x3 box blur, to stop single noisy pixels from dominating.
function boxBlur3(src, width, height) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = src[row + x];
      let count = 1;
      if (x > 0) { sum += src[row + x - 1]; count++; }
      if (x < width - 1) { sum += src[row + x + 1]; count++; }
      tmp[row + x] = sum / count;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let sum = tmp[i];
      let count = 1;
      if (y > 0) { sum += tmp[i - width]; count++; }
      if (y < height - 1) { sum += tmp[i + width]; count++; }
      out[i] = sum / count;
    }
  }
  return out;
}
