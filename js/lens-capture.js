// Taking checkerboard views for measuring a lens, from the live picture: a view is kept whenever the board
// has been held still for a moment somewhere it hasn't been before (another place, or turned another way),
// and the parts of the picture it has covered are counted, so the Setup screen can say where it still has to
// go. Then the lens is measured from them, without any view that doesn't fit the rest (it moved, or was
// blurred). Works on corner lists (findCheckerboard's), not pictures, so it is unit tested.

import { calibrateLens, coverage } from './lens-calibration.js';

/**
 * @typedef {import('./checkerboard.js').Spot} Spot
 * @typedef {'none'|'moving'|'similar'|'taken'} OfferResult none: no board; moving: not still yet; similar: still,
 *   but too like a view already taken; taken: kept
 */

export const LENS_CAPTURE_DEFAULTS = {
  // The board must be still (every corner within stillPixels) for this long to be taken.
  stillMs: 400,
  stillPixels: 0.6,
  // A view is new if one of the board's outer corners is at least this far (fraction of the picture's width)
  // from where it was in every view taken.
  newAtLeast: 0.05,
  // Measuring needs at least this many views, and is worth it from enough to cover the picture.
  minViews: 15,
  goodViews: 45,
  // The coverage grid, and how much of it is plenty: a simulated person who left three corner cells empty at
  // 90% still measured the lens to a tenth of a pixel; a board kept to the middle covers under 80%.
  coverCols: 8,
  coverRows: 5,
  goodCoverage: 0.9,
  // Views whose corners land further than this many times the median view's RMS off the measured lens are
  // dropped and it is measured again.
  outlierFactor: 3,
};

export class LensCapture {
  /**
   * @param {object} args
   * @param {import('./lens-calibration.js').Vec[]} args.board the board's corners in its own frame (boardCorners)
   * @param {number} args.imageWidth @param {number} args.imageHeight pixels of the pictures the corners came from
   * @param {Partial<typeof LENS_CAPTURE_DEFAULTS>} [args.options]
   */
  constructor({ board, imageWidth, imageHeight, options = {} }) {
    this.board = board;
    this.imageWidth = imageWidth;
    this.imageHeight = imageHeight;
    this.imageAspect = imageHeight / imageWidth;
    this.opts = { ...LENS_CAPTURE_DEFAULTS, ...options };
    /** @type {{points: import('./lens-calibration.js').Vec[], seen: Spot[]}[]} */
    this.views = [];
    this.recent = [];
  }

  /**
   * One live picture's corners (null where the board wasn't found), at time t (ms).
   * @param {Spot[]|null} corners
   * @param {number} t
   * @returns {OfferResult}
   */
  offer(corners, t) {
    if (!corners || corners.length !== this.board.length) {
      this.recent = [];
      return 'none';
    }
    const px = (a, b) => Math.hypot((a.x - b.x) * this.imageWidth, (a.y - b.y) * this.imageHeight);
    // Still: every corner within stillPixels of where it was in each picture since the stillness began.
    this.recent = this.recent.filter((r) => corners.every((c, i) => px(c, r.corners[i]) <= this.opts.stillPixels));
    this.recent.push({ corners, t });
    if (t - this.recent[0].t < this.opts.stillMs) return 'moving';
    if (!this.isNew(corners)) return 'similar';
    this.views.push({ points: this.board, seen: corners });
    this.recent = [];
    return 'taken';
  }

  /** Whether a board at these corners is in another place, or turned another way, from every view taken. */
  isNew(corners) {
    const outer = outerCorners(corners, this.board);
    return this.views.every((v) => {
      const o = outerCorners(v.seen, this.board);
      return o.some((p, i) => Math.hypot(p.x - outer[i].x, (p.y - outer[i].y) * this.imageAspect) >= this.opts.newAtLeast);
    });
  }

  /** Which parts of the picture the views have covered (coverage's). */
  coverage() {
    return coverage(this.views, this.opts.coverCols, this.opts.coverRows);
  }

  /** Whether there are enough views to measure the lens at all, and whether enough to measure it well. */
  readiness() {
    const covered = this.coverage().covered;
    return {
      views: this.views.length,
      covered,
      canMeasure: this.views.length >= this.opts.minViews,
      good: this.views.length >= this.opts.goodViews && covered >= this.opts.goodCoverage,
    };
  }

  /**
   * Measures the lens from the views, then again without any whose corners fit it far worse than the rest.
   * @param {{model?: 'brown'|'fisheye'}} [opts]
   * @returns {(ReturnType<typeof calibrateLens> & {used: number, dropped: number})|null}
   */
  measure({ model = 'brown' } = {}) {
    if (this.views.length < this.opts.minViews) return null;
    const args = { imageAspect: this.imageAspect, imageWidth: this.imageWidth, model };
    const first = calibrateLens({ ...args, views: this.views });
    if (!first) return null;
    const sorted = [...first.viewRms].sort((a, b) => a - b);
    const limit = this.opts.outlierFactor * sorted[sorted.length >> 1];
    const kept = this.views.filter((_, i) => first.viewRms[i] <= limit);
    if (kept.length === this.views.length || kept.length < this.opts.minViews) {
      return { ...first, used: this.views.length, dropped: 0 };
    }
    const second = calibrateLens({ ...args, views: kept });
    return second ? { ...second, used: kept.length, dropped: this.views.length - kept.length } : { ...first, used: this.views.length, dropped: 0 };
  }

  /** Forgets every view. */
  clear() {
    this.views = [];
    this.recent = [];
  }
}

const REGION_NAMES = [
  ['top left corner', 'top edge', 'top right corner'],
  ['left edge', 'middle', 'right edge'],
  ['bottom left corner', 'bottom edge', 'bottom right corner'],
];

/**
 * Where in the picture the board still has to go: of its nine parts (corners, edges, middle), those with a
 * coverage cell nothing has fallen in yet, corners first (they matter most).
 * @param {number[][]} counts coverage's, [row][col]
 * @returns {string[]}
 */
export function whereNeeded(counts) {
  const rows = counts.length;
  const cols = counts[0]?.length ?? 0;
  const third = (k, n) => Math.min(2, Math.floor((3 * k) / n));
  const empty = [[false, false, false], [false, false, false], [false, false, false]];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (!counts[r][c]) empty[third(r, rows)][third(c, cols)] = true;
  const order = [[0, 0], [0, 2], [2, 0], [2, 2], [0, 1], [1, 0], [1, 2], [2, 1], [1, 1]];
  return order.filter(([r, c]) => empty[r][c]).map(([r, c]) => REGION_NAMES[r][c]);
}

/** The spots of the board's four outermost corners: first, last of the first row, last, first of the last row. */
function outerCorners(seen, board) {
  const cols = board.findIndex((p, i) => i > 0 && p.y !== board[0].y);
  const n = board.length;
  return [seen[0], seen[cols - 1], seen[n - 1], seen[n - cols]];
}
