// Bright spots in a camera's picture, for measuring the IR rig: the wall markers (LEDs, or retroreflective dots
// lit from the camera), the wand's ends, an LED blinking for the cameras' delay. Each is found to a fraction of
// a pixel (its brightness-weighted centre); still ones are averaged over many frames (SpotAverager), and the
// ones that moved are told from them (movingSpots). Also when an LED came on and went off in two cameras'
// pictures, which says how much later one sees the room than the other (blinkDelay). Works on flat luma
// arrays (no browser code), so it is unit tested.

/**
 * @typedef {{x:number, y:number, area:number, peak:number, brightness:number}} Spot normalised picture coords;
 *   area in pixels; peak: its brightest pixel; brightness: its total above the background
 */

export const SPOT_DEFAULTS = {
  // A spot is at least this much brighter (grey levels) than the picture's typical brightness…
  minContrast: 40,
  // …covers at least and at most this many pixels…
  minArea: 2,
  maxArea: 900,
  // …and is no more than this many times longer than it is wide (a lit edge or a strip light isn't a spot).
  maxElongation: 3,
};

/**
 * Every bright spot in a picture, brightest first.
 * @param {ArrayLike<number>} luma row by row
 * @param {number} width @param {number} height
 * @param {Partial<typeof SPOT_DEFAULTS>} [options]
 * @returns {Spot[]}
 */
export function findSpots(luma, width, height, options = {}) {
  const opts = { ...SPOT_DEFAULTS, ...options };
  const background = typicalLevel(luma);
  const threshold = background + opts.minContrast;
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const spots = [];
  for (let start = 0; start < luma.length; start++) {
    if (seen[start] || luma[start] < threshold) continue;
    // Flood fill the patch above the threshold (4-connected).
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let area = 0;
    let peak = 0;
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    let touchesEdge = false;
    while (top > 0) {
      const i = stack[--top];
      const x = i % width;
      const y = (i - x) / width;
      const w = luma[i] - background;
      area++;
      if (luma[i] > peak) peak = luma[i];
      sw += w; sx += w * x; sy += w * y; sxx += w * x * x; syy += w * y * y; sxy += w * x * y;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
      if (x > 0 && !seen[i - 1] && luma[i - 1] >= threshold) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < width - 1 && !seen[i + 1] && luma[i + 1] >= threshold) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && !seen[i - width] && luma[i - width] >= threshold) { seen[i - width] = 1; stack[top++] = i - width; }
      if (y < height - 1 && !seen[i + width] && luma[i + width] >= threshold) { seen[i + width] = 1; stack[top++] = i + width; }
    }
    if (area < opts.minArea || area > opts.maxArea || touchesEdge || sw <= 0) continue;
    // Sharpened: the centre weighed by brightness over the whole patch, its faint rim included, then refined
    // over the pixels round it with the background taken off, so a spot cut by the threshold isn't pulled.
    const cx = sx / sw;
    const cy = sy / sw;
    const vx = sxx / sw - cx * cx;
    const vy = syy / sw - cy * cy;
    const vxy = sxy / sw - cx * cy;
    const spread = Math.sqrt(((vx - vy) / 2) ** 2 + vxy * vxy);
    const major = (vx + vy) / 2 + spread;
    const minor = Math.max(1e-6, (vx + vy) / 2 - spread);
    if (Math.sqrt(major / minor) > opts.maxElongation) continue;
    const refined = centreAround(luma, width, height, cx, cy, Math.max(2, Math.ceil(2.5 * Math.sqrt(major))), background);
    spots.push({
      x: (refined.x + 0.5) / width,
      y: (refined.y + 0.5) / height,
      area,
      peak,
      brightness: sw,
    });
  }
  return spots.sort((a, b) => b.brightness - a.brightness);
}

/** The brightness-weighted centre of the pixels within r of (cx, cy), the background taken off. */
function centreAround(luma, width, height, cx, cy, r, background) {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(height - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const w = luma[y * width + x] - background;
      if (w <= 0) continue;
      sw += w; sx += w * x; sy += w * y;
    }
  }
  return sw > 0 ? { x: sx / sw, y: sy / sw } : { x: cx, y: cy };
}

/** The picture's typical brightness: the median of a sample of its pixels. */
function typicalLevel(luma) {
  const step = Math.max(1, Math.floor(luma.length / 4096));
  const sample = [];
  for (let i = 0; i < luma.length; i += step) sample.push(luma[i]);
  sample.sort((a, b) => a - b);
  return sample[sample.length >> 1];
}

/**
 * Still spots averaged over many frames: each frame's spots are added, and those found in most frames, at
 * the same place, are given as their average place, far better than any one frame's.
 */
export class SpotAverager {
  /**
   * @param {{width: number, height: number, matchPixels?: number}} args a spot within matchPixels of where it
   *   has been is the same spot
   */
  constructor({ width, height, matchPixels = 2 }) {
    this.width = width;
    this.height = height;
    this.matchPixels = matchPixels;
    this.frames = 0;
    /** @type {{x:number, y:number, n:number, sx:number, sy:number, sxx:number, syy:number, brightness:number}[]} */
    this.clusters = [];
  }

  /** @param {Spot[]} spots one frame's */
  add(spots) {
    this.frames++;
    const used = new Set();
    for (const s of spots) {
      let best = null;
      let bestD = this.matchPixels;
      for (const c of this.clusters) {
        if (used.has(c)) continue;
        const d = Math.hypot((s.x - c.x) * this.width, (s.y - c.y) * this.height);
        if (d <= bestD) { bestD = d; best = c; }
      }
      if (!best) {
        best = { x: s.x, y: s.y, n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, brightness: 0 };
        this.clusters.push(best);
      }
      used.add(best);
      best.n++;
      best.sx += s.x; best.sy += s.y; best.sxx += s.x * s.x; best.syy += s.y * s.y;
      best.brightness += s.brightness;
      best.x = best.sx / best.n;
      best.y = best.sy / best.n;
    }
  }

  /**
   * The spots found in at least `minShare` of the frames, brightest first, at their average place.
   * @returns {{x:number, y:number, frames:number, sigmaPixels:number, brightness:number}[]} sigmaPixels: how
   *   much one frame's place scattered round the average (pixels)
   */
  result(minShare = 0.8) {
    return this.clusters
      .filter((c) => c.n >= Math.max(1, minShare * this.frames))
      .map((c) => {
        const vx = Math.max(0, c.sxx / c.n - c.x * c.x) * this.width * this.width;
        const vy = Math.max(0, c.syy / c.n - c.y * c.y) * this.height * this.height;
        return { x: c.x, y: c.y, frames: c.n, sigmaPixels: Math.sqrt(vx + vy), brightness: c.brightness / c.n };
      })
      .sort((a, b) => b.brightness - a.brightness);
  }
}

/**
 * The spots of a frame that aren't still ones (the markers): the wand's ends, an LED being moved or blinked.
 * @param {Spot[]} spots @param {{x:number, y:number}[]} still SpotAverager's result
 * @param {number} width @param {number} height @param {number} [nearPixels] this close to a still spot is it
 */
export function movingSpots(spots, still, width, height, nearPixels = 3) {
  return spots.filter((s) => !still.some((m) => Math.hypot((s.x - m.x) * width, (s.y - m.y) * height) <= nearPixels));
}

/**
 * How much later one camera sees the room than another, from an LED both saw being covered and uncovered:
 * each camera's frames say whether it was lit, every change is put halfway between the frames either side,
 * and the changes the two cameras saw are paired (the nearest, within `pairMs`). Frames are timed on the
 * page's clock as each camera gives them, so the difference is the second's delay less the first's.
 * @param {{t:number, lit:boolean}[]} first @param {{t:number, lit:boolean}[]} second in time order
 * @param {{pairMs?: number}} [opts]
 * @returns {{delayMs:number, changes:number, spreadMs:number}|null} delayMs: how much later the second sees it
 *   (negative: sooner); spreadMs: how much the pairs disagreed (median absolute deviation); null without at
 *   least two paired changes
 */
export function blinkDelay(first, second, { pairMs = 150 } = {}) {
  const changes = (frames) => {
    const out = [];
    for (let i = 1; i < frames.length; i++) {
      if (frames[i].lit !== frames[i - 1].lit) out.push({ t: (frames[i].t + frames[i - 1].t) / 2, lit: frames[i].lit });
    }
    return out;
  };
  const a = changes(first);
  const b = changes(second);
  const diffs = [];
  for (const ca of a) {
    let best = null;
    for (const cb of b) {
      if (cb.lit !== ca.lit || Math.abs(cb.t - ca.t) > pairMs) continue;
      if (!best || Math.abs(cb.t - ca.t) < Math.abs(best.t - ca.t)) best = cb;
    }
    if (best) diffs.push(best.t - ca.t);
  }
  if (diffs.length < 2) return null;
  const sorted = [...diffs].sort((x, y) => x - y);
  const delayMs = sorted[sorted.length >> 1];
  const dev = diffs.map((d) => Math.abs(d - delayMs)).sort((x, y) => x - y);
  return { delayMs, changes: diffs.length, spreadMs: dev[dev.length >> 1] };
}
