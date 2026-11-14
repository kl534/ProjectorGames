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
// People are more than one big blob: where their clothes match the picture they
// break up into many small blobs (hands, the edges of limbs, a head), and a person
// between the projector and the wall casts a moving shadow on it, which breaks up
// the same way. So the picture is also cut into a coarse grid of cells, and a cell
// with a good share of foreground in it is busy. Busy cells that join up and hold
// enough foreground between them (far more than a ball, or the blur of a bat) are a
// person, a shadow, or what one left behind (a ghost); so are the cells of a blob that
// was too big to be a ball. Those cells, a margin round them, and for a moment after
// (personHoldMs: they flicker as the person moves) are the person zone: a blob whose
// centre is in it is not followed at all, so a hand at the edge of a person can't be a
// ball. A ball thrown from inside the zone is picked up as it leaves it. The zone is
// given as boxes (personBoxes) too, for the tracker to tell when a camera's view of
// the screen was blocked, and as cells (personCells and cellOf), for the camera view.
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
import { FlickerBasis } from './flicker-basis.js';

// Brightness at which the camera picture is over-exposed (white).
const WHITE = 250;

// The exposure change is measured in this many bands of brightness, each this wide.
const EXPOSURE_BANDS = 16;
const BAND_WIDTH = 256 / EXPOSURE_BANDS;

// Each row's gain is measured on background pixels at least this bright: about GAIN_ROW_TARGET pixels spread along each row, a row's own gain from at least GAIN_ROW_SAMPLES of them (else the nearest such row's), and no
// gain at all unless GAIN_MIN_SAMPLES were found.
const GAIN_MIN_LUMA = 20;
const GAIN_ROW_TARGET = 48;
const GAIN_ROW_SAMPLES = 8;
const GAIN_ROW_CAP = 96;
const GAIN_MIN_SAMPLES = 50;

// The gain alone is enough when this fraction of those pixels end up within half the threshold of the background.
const GAIN_FIT_FRACTION = 0.8;

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
    // The frame with its overall gain divided out (see followExposure).
    this.normalised = new Float32Array(n);
    // Each row's gain, and the ratios it is the median of (see followExposure).
    this.rowGain = new Float32Array(height);
    this.rowBuf = new Float32Array(height * GAIN_ROW_CAP);
    this.rowCount = new Uint16Array(height);
    this.nearestAbove = new Float32Array(height);
    this.distAbove = new Int32Array(height);
    this.rowOf = new Uint16Array(n);
    for (let i = 0; i < n; i++) this.rowOf[i] = Math.floor(i / width);
    // The person zone's grid: square cells, each pixel's cell worked out once, and what is counted in them.
    const cell = Math.max(2, Math.round(opts.personCell * width));
    this.cell = cell;
    this.cols = Math.ceil(width / cell);
    this.rows = Math.ceil(height / cell);
    const cells = this.cols * this.rows;
    this.cellOf = new Uint16Array(n);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) this.cellOf[y * width + x] = Math.floor(y / cell) * this.cols + Math.floor(x / cell);
    }
    this.cellWatched = new Uint16Array(cells); // watched pixels in the cell
    this.cellFg = new Uint16Array(cells); // foreground pixels in the cell this frame
    this.cellUntil = new Float64Array(cells); // until when the cell counts as a person's (ms)
    this.cellStamp = new Int32Array(cells); // which blob last touched the cell
    this.stamp = 0;
    this.cellList = new Int32Array(cells);
    this.cellSeen = new Uint8Array(cells);
    this.cellStack = new Int32Array(cells);
    this.cellGroup = new Int32Array(cells);
    this.personCells = new Uint8Array(cells); // the person zone: 1 = a person is (or just was) here, or next to here
    this.personUntil = 0; // when the latest cell stops counting
    /** @type {{x0:number, y0:number, x1:number, y1:number}[]} the zone's parts, normalised camera coords */
    this.personBoxes = [];
    // The frame with what the projector's flicker does to it taken out (see FlickerBasis), and the pixels it leaves alone.
    this.corrected = new Float32Array(n);
    this.skip = new Uint8Array(n);
    this.setExcluded([]);
  }

  /** Screen areas never watched (e.g. on-screen buttons). */
  setExcluded(rects) {
    const m = this.opts.regionMargin;
    const indices = [];
    for (let i = 0; i < this.screenX.length; i++) {
      const sx = this.screenX[i];
      const sy = this.screenY[i];
      if (!this.opts.watchAll && !(sx >= -m && sx <= 1 + m && sy >= -m && sy <= 1 + m)) continue;
      if (rects.some((r) => inRect(r, sx, sy))) continue;
      indices.push(i);
    }
    this.region = Int32Array.from(indices);
    this.cellWatched.fill(0);
    for (const i of this.region) this.cellWatched[this.cellOf[i]]++;
    this.basis = new FlickerBasis({ pixels: this.region });
  }

  /** Foreground mask of the last processed frame (1 = changed), for display. */
  get foregroundMask() {
    return this.foreground;
  }

  /** What each pixel showed in the last frame: 0 scene, 1 ignored sprite edge, 2 sprite, for display. */
  get spriteMask() {
    return this.zone;
  }

  /** The person zone as cells (1 = in it), for display: a pixel i is in it if personZone[personCellOf[i]] is. */
  get personZone() {
    return this.personCells;
  }

  /** Each pixel's cell in the person zone's grid. */
  get personCellOf() {
    return this.cellOf;
  }

  /** Whether a point of the camera picture (normalised camera coords) is in the person zone. */
  personAt(p) {
    const col = Math.floor((p.x * this.width) / this.cell);
    const row = Math.floor((p.y * this.height) / this.cell);
    return col >= 0 && col < this.cols && row >= 0 && row < this.rows && this.personCells[row * this.cols + col] === 1;
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
   * @returns {ArrayLike<number>} the frame to compare with the background: this one, or a copy with the flicker taken out
   */
  followExposure(luma, suppressedRects, time = 0) {
    const { background: bg, foreground: fg, region, zone } = this;
    const step = Math.max(1, Math.floor(region.length / this.opts.exposureSamples));
    // …then lights that flicker (LEDs, against a fast camera) scale the picture by a different amount every
    // frame, and down the frame too: each row is exposed a little later than the one above and sees
    // the lights at another point of their cycle (bands of rows 10-20% brighter or darker). So first
    // find each row's gain, the median ratio of its pixels to the background over those bright
    // enough to measure, and divide it out of the frame. The background itself stays as it was
    // (scaling it each frame would add up the errors).
    // First the flicker of the projector's colours, which no gain can take out, from the frame as the camera gave it…
    luma = this.takeOutFlicker(luma, time, suppressedRects);
    const { height, rowGain, rowBuf, rowCount, rowOf } = this;
    const ratioStep = Math.max(1, Math.floor(this.width / GAIN_ROW_TARGET));
    rowCount.fill(0);
    let sampled = 0;
    for (let k = 0; k < region.length; k += ratioStep) {
      const i = region[k];
      if (zone[i] !== SCENE || !this.backgroundKnown[i] || bg[i] < GAIN_MIN_LUMA || bg[i] >= WHITE || luma[i] >= WHITE) continue;
      const y = rowOf[i];
      if (rowCount[y] >= GAIN_ROW_CAP) continue;
      if (suppressedRects.length && suppressedRects.some((r) => inRect(r, this.screenX[i], this.screenY[i]))) continue;
      rowBuf[y * GAIN_ROW_CAP + rowCount[y]++] = luma[i] / bg[i];
      sampled++;
    }
    let gainFits = false;
    if (sampled >= GAIN_MIN_SAMPLES) {
      // A row's own gain where it has enough pixels, else that of the nearest row that has.
      let measured = 0;
      for (let y = 0; y < height; y++) {
        const n = rowCount[y];
        if (n >= GAIN_ROW_SAMPLES) {
          const r = rowBuf.subarray(y * GAIN_ROW_CAP, y * GAIN_ROW_CAP + n).sort();
          rowGain[y] = r[n >> 1];
          measured++;
        } else {
          rowGain[y] = NaN;
        }
      }
      if (measured) this.fillGaps();
      else rowGain.fill(rowBuf[0] || 1);
      const norm = this.normalised;
      // Pixels at white (over-exposed) have no gain to divide out.
      for (const i of region) {
        const gain = rowGain[rowOf[i]];
        norm[i] = luma[i] >= WHITE || Math.abs(gain - 1) <= 0.002 ? luma[i] : Math.min(255, luma[i] / gain);
      }
      luma = norm;
      // How much of the picture those gains bring back to the background (the rest is something new, or the tone curve).
      const close = this.opts.threshold / 256;
      let fits = 0;
      for (let y = 0; y < height; y++) {
        const base = y * GAIN_ROW_CAP;
        for (let k = 0; k < rowCount[y]; k++) if (Math.abs(rowBuf[base + k] - rowGain[y]) <= close) fits++;
      }
      gainFits = fits >= GAIN_FIT_FRACTION * sampled;
    }
    // A flicker is only a gain: no need to go looking for a tone curve, which sparse bands get wrong.
    if (gainFits) return luma;
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
    if (!known.length || known.every((k) => Math.abs(k.change) < 0.5)) return luma;
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
    return luma;
  }

  /**
   * The frame with the flicker of the projector's colours taken out (see FlickerBasis), once that is known.
   * Pixels the game is changing or that are behind a sprite are left as they are, and not fitted to.
   */
  takeOutFlicker(luma, time, suppressedRects) {
    const { skip, zone, region } = this;
    for (const i of region) {
      skip[i] = zone[i] !== SCENE || (suppressedRects.length > 0
        && suppressedRects.some((r) => inRect(r, this.screenX[i], this.screenY[i]))) ? 1 : 0;
    }
    return this.basis.correct(luma, this.corrected, time, skip);
  }

  /** Gives each row that has no gain of its own that of the nearest row that has one. */
  fillGaps() {
    const { height, rowGain, nearestAbove, distAbove } = this;
    let above = NaN;
    for (let y = 0, d = 0; y < height; y++) {
      if (!Number.isNaN(rowGain[y])) { above = rowGain[y]; d = 0; } else d++;
      nearestAbove[y] = above;
      distAbove[y] = d;
    }
    let below = NaN;
    for (let y = height - 1, d = 0; y >= 0; y--) {
      if (!Number.isNaN(rowGain[y])) { below = rowGain[y]; d = 0; continue; }
      d++;
      rowGain[y] = Number.isNaN(below) || (!Number.isNaN(nearestAbove[y]) && distAbove[y] <= d) ? nearestAbove[y] : below;
    }
  }

  resetBackground(luma) {
    this.basis.reset();
    this.background = Float32Array.from(luma);
    this.foreground.fill(0);
    this.backgroundKnown.fill(1);
    // Behind a sprite, the background wasn't seen.
    for (const i of this.zoned) this.backgroundKnown[i] = 0;
    // The whole picture changed, so what the sprites look like may have too.
    this.looks.clear();
    // …and anyone in it is part of the new background.
    this.cellFg.fill(0);
    this.cellUntil.fill(0);
    this.personCells.fill(0);
    this.personUntil = 0;
    this.personBoxes = [];
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

  /**
   * The ball blobs of the last frame: foreground in groups, not too small and not too big, and not in the
   * person zone (see the top of this file), which this works out from the same groups.
   * @param {number} [time] the frame's time (ms), for how long the zone is held
   */
  findBlobs(time = 0) {
    const {
      width, height, foreground, cellOf, cellFg, cellStamp, cellList, cellUntil,
    } = this;
    const maxArea = this.opts.maxBlobFraction * this.region.length;
    const heldUntil = time + this.opts.personHoldMs;
    const seen = new Uint8Array(foreground.length);
    const stack = [];
    const found = [];
    let total = 0;
    for (const start of this.region) {
      if (!foreground[start] || seen[start]) continue;
      let area = 0;
      let sx = 0;
      let sy = 0;
      let touched = 0;
      const stamp = ++this.stamp;
      seen[start] = 1;
      stack.push(start);
      while (stack.length) {
        const i = stack.pop();
        const x = i % width;
        const y = (i - x) / width;
        area++;
        sx += x;
        sy += y;
        const c = cellOf[i];
        cellFg[c]++;
        if (cellStamp[c] !== stamp) {
          cellStamp[c] = stamp;
          cellList[touched++] = c;
        }
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
      total += area;
      // Too big to be a ball: a person, whose cells are the person's, busy or not.
      if (area > maxArea) {
        for (let k = 0; k < touched; k++) cellUntil[cellList[k]] = heldUntil;
        this.personUntil = Math.max(this.personUntil, heldUntil);
        continue;
      }
      if (area >= this.opts.minBlobArea) found.push({ x: (sx / area + 0.5) / width, y: (sy / area + 0.5) / height, area });
    }
    this.findPeople(time, total);
    return found.filter((b) => !this.personAt(b));
  }

  /**
   * Works out the person zone from the foreground counted in each cell (findBlobs), and clears the counts.
   * @param {number} time frame time (ms)
   * @param {number} total foreground pixels in the frame
   */
  findPeople(time, total) {
    const {
      cols, rows, cellFg, cellUntil, cellSeen, cellStack, cellGroup, personCells,
    } = this;
    const {
      personCellFill, personMinFraction, personMarginCells, personHoldMs,
    } = this.opts;
    // Nothing in the frame, and nothing held from before: no zone.
    if (!total && time >= this.personUntil) {
      if (this.personBoxes.length) {
        personCells.fill(0);
        this.personBoxes = [];
      }
      return;
    }
    const cells = cols * rows;
    const minPixels = personMinFraction * this.width * this.height;
    // Busy cells that touch (8 ways) are one group; one holding enough foreground is a person.
    if (total >= minPixels) {
      cellSeen.fill(0);
      for (let start = 0; start < cells; start++) {
        if (cellSeen[start] || !this.busy(start, personCellFill)) continue;
        let sum = 0;
        let members = 0;
        let top = 0;
        cellSeen[start] = 1;
        cellStack[top++] = start;
        while (top) {
          const c = cellStack[--top];
          sum += cellFg[c];
          cellGroup[members++] = c;
          const col = c % cols;
          const row = (c - col) / cols;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nc = col + dx;
              const nr = row + dy;
              if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
              const j = nr * cols + nc;
              if (!cellSeen[j] && this.busy(j, personCellFill)) {
                cellSeen[j] = 1;
                cellStack[top++] = j;
              }
            }
          }
        }
        if (sum < minPixels) continue;
        for (let k = 0; k < members; k++) cellUntil[cellGroup[k]] = time + personHoldMs;
        this.personUntil = Math.max(this.personUntil, time + personHoldMs);
      }
    }
    cellFg.fill(0);
    // The zone: the cells held, and a margin round them.
    personCells.fill(0);
    const m = personMarginCells;
    for (let c = 0; c < cells; c++) {
      if (cellUntil[c] <= time) continue;
      const col = c % cols;
      const row = (c - col) / cols;
      for (let r = Math.max(0, row - m); r <= Math.min(rows - 1, row + m); r++) {
        for (let k = Math.max(0, col - m); k <= Math.min(cols - 1, col + m); k++) personCells[r * cols + k] = 1;
      }
    }
    this.personBoxes = this.boxesOfZone();
  }

  /** Whether a cell has at least `fill` of its watched pixels in the foreground. */
  busy(c, fill) {
    return this.cellFg[c] > 0 && this.cellFg[c] >= fill * this.cellWatched[c];
  }

  /** The parts of the person zone (cells that touch, 8 ways), as boxes in normalised camera coordinates. */
  boxesOfZone() {
    const {
      cols, rows, cell, width, height, personCells, cellSeen, cellStack,
    } = this;
    const boxes = [];
    cellSeen.fill(0);
    for (let start = 0; start < cols * rows; start++) {
      if (!personCells[start] || cellSeen[start]) continue;
      let c0 = cols;
      let r0 = rows;
      let c1 = -1;
      let r1 = -1;
      let top = 0;
      cellSeen[start] = 1;
      cellStack[top++] = start;
      while (top) {
        const c = cellStack[--top];
        const col = c % cols;
        const row = (c - col) / cols;
        c0 = Math.min(c0, col);
        c1 = Math.max(c1, col);
        r0 = Math.min(r0, row);
        r1 = Math.max(r1, row);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nc = col + dx;
            const nr = row + dy;
            if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
            const j = nr * cols + nc;
            if (personCells[j] && !cellSeen[j]) {
              cellSeen[j] = 1;
              cellStack[top++] = j;
            }
          }
        }
      }
      boxes.push({
        x0: (c0 * cell) / width,
        y0: (r0 * cell) / height,
        x1: Math.min(1, ((c1 + 1) * cell) / width),
        y1: Math.min(1, ((r1 + 1) * cell) / height),
      });
    }
    return boxes;
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
