// What a flickering picture does to a camera, learned as a few patterns. No browser code, so it is unit tested.
//
// A DLP projector shows its colours one after another, and a short exposure catches a different mix of them
// each frame, so a pixel of a busy picture changes by an amount that depends on its colour: no gain, for the
// whole picture or for a row, brings it back. But the frames are all mixes of a few coloured pictures, so they
// lie close to a flat space of just a few dimensions (one for the overall brightness, a few more for the colours).
//
// FlickerBasis keeps the last few frames, works out that space from them (the strongest directions the frames
// vary in: a small eigenproblem on how the frames compare with each other), and for each new frame finds the
// point in the space nearest to it, leaving out pixels it misses by a lot (a ball, a hand). The frame is given
// back with that flicker taken out; a ball, which is not in the space, is left as it was.
//
// It only does this while the picture really flickers (its brightness goes up and down from frame to frame),
// and it works the space out a slice of the picture at a time over the following frames, so that no one frame
// is held up by it.

const MAX_FRAMES = 64;
// Only a picture that flickers is corrected: its brightness goes up and down from frame to frame, so that in most
// frames it is off a straight line through its neighbours by at least this much (a fraction of it), where a change
// of exposure or someone moving about at a steady pace follows a line, and something appearing is a single step.
const MIN_JUMP = 0.03;
// The space is worked out in this many slices of the picture, one a frame, from frames the ring keeps this many
// slots beyond those it uses, so they are not written over meanwhile.
const SLICES = 6;
const SPARE_SLOTS = 8;

export class FlickerBasis {
  /**
   * @param {object} args
   * @param {Int32Array} args.pixels the pixels watched (indices into a frame), in order
   * @param {number} [args.frames] how many recent frames the space is worked out from
   * @param {number} [args.components] how many directions it has
   * @param {number} [args.everyMs] how often it is worked out afresh (ms of frame time)
   * @param {number} [args.outlier] a pixel this far (levels) from the fit is left out of it
   */
  constructor({ pixels, frames = 24, components = 4, everyMs = 250, outlier = 30 }) {
    this.pixels = pixels;
    this.frames = Math.min(MAX_FRAMES, frames);
    this.slots = this.frames + SPARE_SLOTS;
    this.components = components;
    this.everyMs = everyMs;
    this.outlier = outlier;
    const p = pixels.length;
    this.ring = new Float32Array(this.slots * p);
    this.levels = new Float64Array(this.slots); // each frame's mean brightness
    this.count = 0; // frames in the ring
    this.next = 0; // slot to fill next
    this.mean = new Float32Array(p); // of the latest frames
    this.sum = new Float32Array(p);
    this.basis = new Float32Array(components * p);
    this.pending = new Float32Array(components * p);
    this.job = null;
    this.made = 0;
    this.ready = false;
    this.fittedAt = -Infinity;
    this.coefficients = new Float64Array(components);
    this.fit = new Float32Array(p);
    this.outliers = new Uint8Array(p);
  }

  /** Forgets the frames (the picture has changed, so its flicker is not what it was). */
  reset() {
    this.count = 0;
    this.next = 0;
    this.sum.fill(0);
    this.ready = false;
    this.job = null;
    this.fittedAt = -Infinity;
  }

  /**
   * Takes this frame's flicker out of it.
   * @param {ArrayLike<number>} luma the frame
   * @param {Float32Array} out where the corrected frame goes (only the watched pixels are written)
   * @param {number} time the frame's time (ms)
   * @param {Uint8Array|null} [skip] pixels (by frame index) to leave alone: not fitted to, and given back as they are
   * @returns {ArrayLike<number>} `out` once the space is known, else `luma`
   */
  correct(luma, out, time, skip = null) {
    const { pixels, fit, outliers, mean } = this;
    const P = pixels.length;
    let result = luma;
    if (this.ready) {
      this.coefficientsFor(luma, skip);
      this.fitFrame();
      // Pixels far from the fit are something else (a ball): fit again without them.
      let left = 0;
      for (let p = 0; p < P; p++) {
        const i = pixels[p];
        const bad = (skip !== null && skip[i] === 1) || Math.abs(luma[i] - fit[p]) > this.outlier;
        outliers[p] = bad ? 1 : 0;
        if (bad) left++;
      }
      if (left > 0 && left < P / 2) {
        this.coefficientsFor(luma, outliers, true);
        this.fitFrame();
      }
      // The frame less what the flicker did to it, which is how far it is from the mean along the space.
      for (let p = 0; p < P; p++) {
        const i = pixels[p];
        out[i] = skip !== null && skip[i] === 1 ? luma[i] : luma[i] - (fit[p] - mean[p]);
      }
      result = out;
    }
    this.add(luma, result === luma ? null : fit, outliers);
    if (this.job) this.work();
    else if (this.count >= Math.min(this.frames, 12) && time - this.fittedAt >= this.everyMs) this.start(time);
    return result;
  }

  /** Sets `fit` to the mean plus the frame's coefficients along each direction. */
  fitFrame() {
    const { components: K, coefficients: c, fit, basis, mean } = this;
    const P = this.pixels.length;
    for (let p = 0; p < P; p++) {
      let f = mean[p];
      for (let j = 0; j < K; j++) f += c[j] * basis[j * P + p];
      fit[p] = f;
    }
  }

  /** Sets the coefficients: where the frame is along each direction, over the pixels not marked in `leaveOut`. */
  coefficientsFor(luma, leaveOut, flagged = false) {
    const { pixels, components: K, coefficients: c, basis, mean } = this;
    const P = pixels.length;
    // Only every other pixel, which is enough to place the frame.
    for (let j = 0; j < K; j++) {
      let s = 0;
      let used = 0;
      const base = j * P;
      for (let p = 0; p < P; p += 2) {
        const i = pixels[p];
        if (leaveOut !== null && (flagged ? leaveOut[p] === 1 : leaveOut[i] === 1)) continue;
        s += basis[base + p] * (luma[i] - mean[p]);
        used++;
      }
      // The directions are of length 1 over all the pixels, so what a sample gives is scaled up to all of them.
      c[j] = used ? (s * P) / used : 0;
    }
  }

  /** Remembers a frame; where a pixel was left out of the fit it is remembered as the fit has it. */
  add(luma, fit, outliers) {
    const { pixels, ring, sum, mean } = this;
    const P = pixels.length;
    const slot = this.next * P;
    const full = this.count === this.frames;
    // With the frames the ring holds this many, the oldest one is the one that goes.
    const old = full ? ((this.next - this.frames + this.slots) % this.slots) * P : -1;
    let level = 0;
    for (let p = 0; p < P; p++) {
      const value = fit !== null && outliers[p] === 1 ? fit[p] : luma[pixels[p]];
      sum[p] += value - (old >= 0 ? ring[old + p] : 0);
      ring[slot + p] = value;
      level += value;
    }
    this.levels[this.next] = level / P;
    this.next = (this.next + 1) % this.slots;
    this.count = Math.min(this.frames, this.count + 1);
    if (this.ready) for (let p = 0; p < P; p++) mean[p] = sum[p] / this.count;
  }

  /** The slots of the frames kept, oldest first. */
  keptSlots() {
    const M = this.count;
    return Array.from({ length: M }, (_, k) => (this.next - M + k + this.slots * 2) % this.slots);
  }

  /** Whether the frames kept show a picture whose brightness goes up and down from frame to frame. */
  flickers(slots) {
    const levels = slots.map((s) => this.levels[s]);
    const jumps = [];
    let level = 0;
    for (let k = 0; k < levels.length; k++) {
      level += levels[k];
      if (k > 1) jumps.push(Math.abs(levels[k] - 2 * levels[k - 1] + levels[k - 2]));
    }
    level /= levels.length;
    if (jumps.length < 3 || !(level > 0)) return false;
    jumps.sort((a, b) => a - b);
    return jumps[jumps.length >> 1] / level >= MIN_JUMP;
  }

  /** Starts working the space out afresh from the frames kept (or finds the picture is not flickering, and stops). */
  start(time) {
    const { pixels, ring, components: K } = this;
    const P = pixels.length;
    const slots = this.keptSlots();
    const M = slots.length;
    this.fittedAt = time;
    if (!this.flickers(slots)) {
      this.ready = false;
      return;
    }
    // How each frame compares with each other, on a sample of the pixels.
    const stride = Math.max(1, Math.floor(P / 5000));
    const sample = [];
    for (let p = 0; p < P; p += stride) sample.push(p);
    const centred = slots.map(() => new Float32Array(sample.length));
    sample.forEach((p, n) => {
      let m = 0;
      for (const s of slots) m += ring[s * P + p];
      m /= M;
      slots.forEach((s, a) => { centred[a][n] = ring[s * P + p] - m; });
    });
    const gram = Array.from({ length: M }, () => new Float64Array(M));
    for (let a = 0; a < M; a++) {
      for (let b = a; b < M; b++) {
        let s = 0;
        const x = centred[a];
        const y = centred[b];
        for (let n = 0; n < x.length; n++) s += x[n] * y[n];
        gram[a][b] = s;
        gram[b][a] = s;
      }
    }
    const { values, vectors } = symmetricEigen(gram);
    const order = Array.from({ length: M }, (_, i) => i).sort((x, y) => values[y] - values[x]);
    const directions = [];
    for (let j = 0; j < K && j < M; j++) {
      if (!(values[order[j]] > 1e-6)) break;
      directions.push(Float64Array.from(vectors.map((row) => row[order[j]])));
    }
    if (!directions.length) return;
    this.pending.fill(0);
    this.job = { slots, directions, slice: 0, norms: new Float64Array(K) };
  }

  /** Works out one more slice of the new directions. */
  work() {
    const { job, pixels, ring, pending } = this;
    const P = pixels.length;
    const { slots, directions } = job;
    const M = slots.length;
    const from = Math.floor((job.slice * P) / SLICES);
    const to = Math.floor(((job.slice + 1) * P) / SLICES);
    for (let p = from; p < to; p++) {
      let m = 0;
      for (let a = 0; a < M; a++) m += ring[slots[a] * P + p];
      m /= M;
      for (let j = 0; j < directions.length; j++) {
        let v = 0;
        const w = directions[j];
        for (let a = 0; a < M; a++) v += w[a] * (ring[slots[a] * P + p] - m);
        pending[j * P + p] = v;
        job.norms[j] += v * v;
      }
    }
    if (++job.slice < SLICES) return;
    // All of it: the directions are made of length 1, and take the place of the old ones.
    for (let j = 0; j < directions.length; j++) {
      const norm = Math.sqrt(job.norms[j]) || 1;
      for (let p = 0; p < P; p++) pending[j * P + p] /= norm;
    }
    this.basis.set(pending);
    this.made = directions.length;
    for (let p = 0; p < P; p++) this.mean[p] = this.sum[p] / this.count;
    this.ready = true;
    this.job = null;
  }
}

/**
 * Eigenvalues and vectors of a small symmetric matrix (Jacobi rotations). The matrix is changed.
 * @param {Float64Array[]} a
 * @returns {{values: number[], vectors: Float64Array[]}} vectors[row][k] is the row-th entry of the k-th vector
 */
export function symmetricEigen(a) {
  const n = a.length;
  const v = Array.from({ length: n }, (_, i) => {
    const row = new Float64Array(n);
    row[i] = 1;
    return row;
  });
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i]), vectors: v };
}
