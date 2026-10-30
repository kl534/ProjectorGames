// Where an on-screen element was a moment ago. The camera sees the projected
// picture a little late, so to know where a moving thing is in a camera frame,
// the game's screen positions are recorded every animation frame and looked up
// one camera delay back. Kept free of the browser so it can be unit-tested.

/**
 * @typedef {{x0:number, y0:number, x1:number, y1:number}} Rect normalised screen coordinates
 * @typedef {{t: number, rect: Rect|null}} Sample rect null: not on screen at time t (ms)
 */

export class SpriteHistory {
  /** @param {number} keepMs how far back to remember */
  constructor(keepMs) {
    this.keepMs = keepMs;
    /** @type {Sample[]} oldest first */
    this.samples = [];
  }

  /** Records where the element is at time `t` (null if it isn't shown). */
  add(t, rect) {
    this.samples.push({ t, rect });
    // Keep one sample older than keepMs, so times just inside it can still be looked up.
    while (this.samples.length > 2 && this.samples[1].t < t - this.keepMs) this.samples.shift();
  }

  /** True once the element has been off screen for all of the remembered time. */
  get gone() {
    return this.samples.length > 0 && this.samples.every((s) => !s.rect)
      && this.samples[this.samples.length - 1].t - this.samples[0].t >= this.keepMs;
  }

  /**
   * Where the element was at time `t`: in between samples it moved smoothly;
   * after the last sample it is where it was last seen. Null if it wasn't on
   * screen then (or isn't known yet).
   * @returns {Rect|null}
   */
  at(t) {
    const { samples } = this;
    if (!samples.length || t < samples[0].t) return null;
    let k = samples.length - 1;
    while (k > 0 && samples[k].t > t) k--;
    const a = samples[k];
    const b = samples[k + 1];
    if (!a.rect) return null;
    if (!b?.rect || b.t === a.t) return a.rect;
    const f = (t - a.t) / (b.t - a.t);
    const mix = (p, q) => p + (q - p) * f;
    return {
      x0: mix(a.rect.x0, b.rect.x0), y0: mix(a.rect.y0, b.rect.y0), x1: mix(a.rect.x1, b.rect.x1), y1: mix(a.rect.y1, b.rect.y1),
    };
  }
}
