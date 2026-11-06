// The picture half of the hit detector: from camera frames, finds the pixels
// that show something new (the foreground) and groups them into blobs. Works on
// greyscale (luma) frames, so it can be unit-tested without a browser.
//
// Background: keep a slowly updated picture of the scene without the ball.
// Pixels that differ from it are "foreground": something that has just appeared
// or is moving (this sees the whole ball, even when it is slow). Only blobs over
// (or just around) the projected screen count, and big ones are ignored: those
// are people, not balls.
//
// The camera adjusts its exposure as the picture gets brighter or darker
// (when it starts, when the game changes its picture, when someone walks in),
// which makes the whole picture brighter or darker at once. Each frame, that
// change is measured and the background adjusted to match, so it isn't taken
// for something new.
//
// Things the game moves around (a rising balloon) are "sprites", given before
// each frame with setSprites(): where each one is in the camera picture right
// now. Over a sprite, the detector compares the camera picture with what that
// sprite looks like to the camera, learned as it watches (in the sprite's own
// coordinates, so it follows the sprite as it moves). A ball in front of a
// moving balloon still stands out. A thin band around each sprite's edge (the
// picture is blurred, and its position is only known roughly) is ignored, and
// the background behind a sprite is left as it was, ready for when the sprite
// moves on.

import { applyHomography } from './homography.js';

// Brightness at which the camera picture is over-exposed (white).
const WHITE = 250;

// The exposure change is measured in this many bands of brightness, each this wide.
const EXPOSURE_BANDS = 16;
const BAND_WIDTH = 256 / EXPOSURE_BANDS;

// What a camera pixel shows this frame (see setSprites).
const SCENE = 0; // the background, or a ball in front of it
const EDGE = 1; // around a sprite's edge, or over a sprite not watched: ignored
const SPRITE = 2; // inside a sprite: compared with its learned look

/**
 * @typedef {{x0:number, y0:number, x1:number, y1:number}} Rect normalised screen coordinates
 * @typedef {object} Sprite something the game moves, where it is in the camera picture now
 * @property {*} key the same value every frame for the same sprite (e.g. its element)
 * @property {'ellipse'|'rect'} shape an ellipse fills its box
 * @property {boolean} watch false: only ignore the area, don't look for balls over it (thin parts like a string)
 * @property {Rect[]} boxes where it may be (normalised screen coords). The area inside all of them is
 *   compared with its look; the area inside only some of them is ignored. The middle one places its look.
 */

export class ForegroundFinder {
  /**
   * @param {object} args
   * @param {number} args.width analysed frame width in pixels
   * @param {number} args.height analysed frame height in pixels
   * @param {number[]} args.cameraToScreen homography, normalised camera -> normalised screen coords
   * @param {number[]} args.screenToCamera its inverse
   * @param {object} args.opts the detector's settings (HIT_DETECTOR_DEFAULTS with any overrides)
   */
  constructor({ width, height, cameraToScreen, screenToCamera, opts }) {
    this.width = width;
    this.height = height;
    this.screenToCamera = screenToCamera;
    this.opts = opts;

    // Screen position of every camera pixel, worked out once.
    const n = width * height;
    this.screenX = new Float32Array(n);
    this.screenY = new Float32Array(n);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = applyHomography(cameraToScreen, { x: (x + 0.5) / width, y: (y + 0.5) / height });
        this.screenX[y * width + x] = p.x;
        this.screenY[y * width + x] = p.y;
      }
    }
    this.background = null;
    this.foreground = new Uint8Array(n);
    // Sprites: what each pixel shows this frame, and which sprite and cell of its look.
    this.zone = new Uint8Array(n);
    this.zoneSprite = new Int32Array(n);
    this.zoneCell = new Int32Array(n);
    this.zoned = []; // pixels with a zone set, to clear next frame
    this.spriteLooks = []; // this frame's sprites' looks, by index
    this.looks = new Map(); // key -> {value, count, seenAt}
    // Pixels whose background was never seen (a sprite was in front): learned when it moves away.
    this.backgroundKnown = new Uint8Array(n);
    // How much each pixel varies from frame to frame (mean squared difference from the background).
    this.noise = new Float32Array(n);
    this.setExcluded([]);
  }

  /** Screen areas never watched (e.g. on-screen buttons). */
  setExcluded(rects) {
    const m = this.opts.regionMargin;
    const indices = [];
    for (let i = 0; i < this.screenX.length; i++) {
      const sx = this.screenX[i];
      const sy = this.screenY[i];
      if (!(sx >= -m && sx <= 1 + m && sy >= -m && sy <= 1 + m)) continue;
      if (rects.some((r) => inRect(r, sx, sy))) continue;
      indices.push(i);
    }
    this.region = Int32Array.from(indices);
  }

  /** Foreground mask of the last processed frame (1 = changed), for display. */
  get foregroundMask() {
    return this.foreground;
  }

  /** What each pixel showed in the last frame: 0 scene, 1 ignored sprite edge, 2 sprite, for display. */
  get spriteMask() {
    return this.zone;
  }


  /**
   * Where the game's moving things are in the frame about to be processed.
   * @param {Sprite[]} sprites
   * @param {{x:number, y:number}} margin width of the ignored band around each edge (fraction of the screen)
   * @param {number} time time of the frame (ms), to forget sprites that have gone
   */
  setSprites(sprites, margin, time) {
    const { zone, zoneSprite, zoneCell, screenX, screenY, width, height } = this;
    const G = this.opts.spriteGrid;
    for (const i of this.zoned) zone[i] = SCENE;
    this.zoned = [];
    this.spriteLooks = [];
    const grow = (b, k) => ({ x0: b.x0 - k * margin.x, y0: b.y0 - k * margin.y, x1: b.x1 + k * margin.x, y1: b.y1 + k * margin.y });

    sprites.forEach((sprite, k) => {
      if (!sprite.boxes.length) return;
      let look = this.looks.get(sprite.key);
      if (!look) {
        look = { value: new Float32Array(G * G), count: new Uint8Array(G * G), seenAt: time };
        this.looks.set(sprite.key, look);
      }
      look.seenAt = time;
      this.spriteLooks[k] = look;
      const outer = sprite.boxes.map((b) => grow(b, 1));
      const inner = sprite.boxes.map((b) => grow(b, -1));
      const ref = sprite.boxes[Math.floor(sprite.boxes.length / 2)];
      const inside = sprite.shape === 'rect' ? inRect : inEllipse;

      // The sprite's area in the camera picture, in pixels.
      let px0 = width;
      let py0 = height;
      let px1 = -1;
      let py1 = -1;
      for (const b of outer) {
        for (const corner of [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 }]) {
          const c = applyHomography(this.screenToCamera, corner);
          px0 = Math.min(px0, c.x * width);
          px1 = Math.max(px1, c.x * width);
          py0 = Math.min(py0, c.y * height);
          py1 = Math.max(py1, c.y * height);
        }
      }
      const xa = Math.max(0, Math.floor(px0) - 1);
      const xb = Math.min(width - 1, Math.ceil(px1) + 1);
      const ya = Math.max(0, Math.floor(py0) - 1);
      const yb = Math.min(height - 1, Math.ceil(py1) + 1);

      for (let y = ya; y <= yb; y++) {
        for (let x = xa; x <= xb; x++) {
          const i = y * width + x;
          const sx = screenX[i];
          const sy = screenY[i];
          if (!outer.some((b) => inside(b, sx, sy))) continue;
          if (zone[i] !== SCENE) {
            zone[i] = EDGE; // two sprites overlap here
            continue;
          }
          const core = sprite.watch && inner.every((b) => inside(b, sx, sy));
          zone[i] = core ? SPRITE : EDGE;
          zoneSprite[i] = k;
          const u = Math.min(G - 1, Math.max(0, Math.floor(((sx - ref.x0) / (ref.x1 - ref.x0)) * G)));
          const v = Math.min(G - 1, Math.max(0, Math.floor(((sy - ref.y0) / (ref.y1 - ref.y0)) * G)));
          zoneCell[i] = v * G + u;
          this.zoned.push(i);
        }
      }
    });

    for (const [key, look] of this.looks) if (time - look.seenAt > 2000) this.looks.delete(key);
  }

  /**
   * Brings the background (and the sprites' looks) to this frame's exposure.
   * The camera's tone curve makes dark areas change more than bright ones, so
   * the change is measured separately for each band of brightness: the median
   * change of background pixels in that band (leaving out ones that aren't
   * background, or that the game is changing). Between bands, it is interpolated.
   */
  followExposure(luma, suppressedRects) {
    const { background: bg, foreground: fg, region, zone } = this;
    const step = Math.max(1, Math.floor(region.length / this.opts.exposureSamples));
    const changes = Array.from({ length: EXPOSURE_BANDS }, () => []);
    for (let k = 0; k < region.length; k += step) {
      const i = region[k];
      if (fg[i] || zone[i] !== SCENE || !this.backgroundKnown[i]) continue;
      if (suppressedRects.length && suppressedRects.some((r) => inRect(r, this.screenX[i], this.screenY[i]))) continue;
      changes[Math.min(EXPOSURE_BANDS - 1, Math.max(0, Math.floor(bg[i] / BAND_WIDTH)))].push(luma[i] - bg[i]);
    }
    // Each band's median change, where enough of the picture is that bright.
    const known = [];
    for (let b = 0; b < EXPOSURE_BANDS; b++) {
      const c = changes[b];
      if (c.length < 20) continue;
      c.sort((x, y) => x - y);
      known.push({ at: (b + 0.5) * BAND_WIDTH, change: c[c.length >> 1] });
    }
    if (!known.length || known.every((k) => Math.abs(k.change) < 0.5)) return;
    // Change at every brightness 0–255, interpolated between the bands measured.
    const table = new Float32Array(256);
    for (let v = 0, k = 0; v < 256; v++) {
      while (k < known.length - 1 && known[k + 1].at <= v) k++;
      const a = known[k];
      const b = known[Math.min(k + 1, known.length - 1)];
      const u = b.at > a.at ? Math.min(1, Math.max(0, (v - a.at) / (b.at - a.at))) : 0;
      table[v] = a.change + u * (b.change - a.change);
    }
    const adjust = (v) => Math.min(255, Math.max(0, v + table[Math.min(255, Math.max(0, Math.round(v)))]));
    for (const i of region) bg[i] = adjust(bg[i]);
    for (const look of this.looks.values()) {
      for (let c = 0; c < look.value.length; c++) look.value[c] = adjust(look.value[c]);
    }
  }

  resetBackground(luma) {
    this.background = Float32Array.from(luma);
    this.foreground.fill(0);
    this.backgroundKnown.fill(1);
    // Behind a sprite, the background wasn't seen.
    for (const i of this.zoned) this.backgroundKnown[i] = 0;
    // The whole picture changed, so what the sprites look like may have too.
    this.looks.clear();
  }

  findForeground(luma, suppressedRects, {
    background: backgroundRate, foreground: foregroundRate, noise: noiseRate, noiseLearn: noiseLearnRate,
  }) {
    const { threshold: th, spriteLearnSamples, noiseFactor } = this.opts;
    const { noise } = this;
    // A ball passing adds at most this much to a pixel's flicker.
    const maxNoise = 4 * th * th;
    const bg = this.background;
    const fg = this.foreground;
    const { zone, backgroundKnown: known } = this;
    fg.fill(0);
    let count = 0;
    for (const i of this.region) {
      const z = zone[i];
      if (suppressedRects.length && suppressedRects.some((r) => inRect(r, this.screenX[i], this.screenY[i]))) {
        // The projector changed this area on purpose. Behind a sprite, the
        // background can't be seen, so learn it again once the sprite has gone.
        if (z === SCENE) {
          // Successive frames differ by twice the variance of each.
          const d = luma[i] - bg[i];
          noise[i] += noiseLearnRate * (Math.min(maxNoise, (d * d) / 2) - noise[i]);
          bg[i] = luma[i];
          known[i] = 1;
        } else {
          known[i] = 0;
        }
        continue;
      }
      if (z === EDGE) continue;
      if (z === SPRITE) {
        const look = this.spriteLooks[this.zoneSprite[i]];
        const c = this.zoneCell[i];
        const seen = look.count[c];
        if (seen < spriteLearnSamples) {
          // Not seen enough yet: learn it, but don't judge it.
          look.count[c] = seen + 1;
          look.value[c] += (luma[i] - look.value[c]) / (seen + 1);
          continue;
        }
        const d = luma[i] - look.value[c];
        if (d > th || d < -th) {
          fg[i] = 1;
          count++;
          look.value[c] += foregroundRate * d;
        } else {
          look.value[c] += backgroundRate * d;
        }
        continue;
      }
      if (!known[i]) {
        // A sprite has just moved off a spot never seen before.
        bg[i] = luma[i];
        known[i] = 1;
        continue;
      }
      const diff = luma[i] - bg[i];
      if (this.onWhiteEdge(i)) {
        // A white (over-exposed) area grows and shrinks as the exposure
        // changes, so its edge can't be judged: just follow it.
        bg[i] = luma[i];
        continue;
      }
      noise[i] += noiseRate * (Math.min(maxNoise, diff * diff) - noise[i]);
      const limit = Math.max(th, noiseFactor * Math.sqrt(noise[i]));
      if (diff > limit || diff < -limit) {
        fg[i] = 1;
        count++;
        bg[i] += foregroundRate * diff;
      } else {
        bg[i] += backgroundRate * diff;
      }
    }
    return count;
  }

  /** Whether pixel i is on the edge of a white area of the background (white and not white around it). */
  onWhiteEdge(i) {
    const { background: bg, width, height } = this;
    const x = i % width;
    const y = (i - x) / width;
    let white = false;
    let other = false;
    for (let dy = -1; dy <= 1; dy++) {
      if (y + dy < 0 || y + dy >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (x + dx < 0 || x + dx >= width) continue;
        if (bg[i + dy * width + dx] >= WHITE) white = true;
        else other = true;
      }
    }
    return white && other;
  }

  findBlobs() {
    const { width, height, foreground } = this;
    const maxArea = this.opts.maxBlobFraction * this.region.length;
    const seen = new Uint8Array(foreground.length);
    const stack = [];
    const blobs = [];
    for (const start of this.region) {
      if (!foreground[start] || seen[start]) continue;
      let area = 0;
      let sx = 0;
      let sy = 0;
      seen[start] = 1;
      stack.push(start);
      while (stack.length) {
        const i = stack.pop();
        const x = i % width;
        const y = (i - x) / width;
        area++;
        sx += x;
        sy += y;
        // 8 neighbours: a fast, blurry ball can break up diagonally.
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const j = ny * width + nx;
            if (foreground[j] && !seen[j]) {
              seen[j] = 1;
              stack.push(j);
            }
          }
        }
      }
      if (area < this.opts.minBlobArea || area > maxArea) continue;
      blobs.push({ x: (sx / area + 0.5) / width, y: (sy / area + 0.5) / height, area });
    }
    return blobs;
  }
}

function inRect(r, x, y) {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

/** Inside the ellipse that fills box `r`. */
function inEllipse(r, x, y) {
  const rx = (r.x1 - r.x0) / 2;
  const ry = (r.y1 - r.y0) / 2;
  if (rx <= 0 || ry <= 0) return false;
  const dx = (x - (r.x0 + rx)) / rx;
  const dy = (y - (r.y0 + ry)) / ry;
  return dx * dx + dy * dy <= 1;
}
