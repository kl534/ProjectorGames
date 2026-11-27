// Finds a printed checkerboard's inner corners in a greyscale camera picture, to a fraction of a pixel, for
// measuring the camera's lens (lens-calibration.js). Works on flat luma arrays (no browser code), so it is
// unit tested on rendered pictures of the board seen through distorted lenses.
//
// The steps: where four squares meet, the picture is a saddle (dark, light, dark, light around the point),
// which the blurred picture's Hessian shows as a negative determinant, unlike an edge (zero) or a blob
// (positive). The strongest saddles are kept, and each is checked by walking a small circle round it: an
// inner corner of the board changes from dark to light four times on it, a square's corner against the white
// border only twice. Each is then moved to where the picture's gradients all point away from it (the usual
// sub-pixel corner refinement). From the saddle nearest the middle of the rest, the grid is grown one
// neighbour at a time, each predicted from the two before it (so perspective and distortion are followed),
// until it stops; it must then be exactly the board's size, every cell between four corners must alternate
// dark and light, and the board is turned the right way round by its colours: the printed board has an odd
// number of squares down and an even number across, so its top-left corner square is black and its
// bottom-right one white.

/**
 * @typedef {{cols:number, rows:number}} BoardSize inner corners across and down (the letter board: 9 × 6)
 * @typedef {{x:number, y:number}} Spot normalised picture coords
 */

// The picture is blurred by this much (pixels) before saddles are looked for.
const SIGMA = 1.5;
// Saddles weaker than this fraction of the strongest few aren't corners.
const MIN_RELATIVE = 0.12;
// At most this many of the strongest saddles are looked at.
const MAX_CANDIDATES = 400;
// A grid neighbour is looked for within this fraction of the grid's spacing of where it was predicted.
const NEIGHBOUR_TOLERANCE = 0.3;
// The sub-pixel refinement may move a saddle at most this far (pixels); further, it wasn't a corner.
const MAX_REFINE_MOVE = 3;
// Dark and light squares must differ by at least this (grey levels) for the board to be believed.
const MIN_CONTRAST = 15;

/**
 * The board's inner corners, in its own order (row by row, as boardCorners lists them), or null if the whole
 * board isn't clearly in the picture.
 * @param {ArrayLike<number>} luma row by row
 * @param {number} width @param {number} height
 * @param {BoardSize} size
 * @returns {{corners: Spot[], spacing: number}|null} spacing: between neighbouring corners, pixels (median)
 */
export function findCheckerboard(luma, width, height, size) {
  const smooth = blur(luma, width, height, SIGMA);
  const candidates = saddles(smooth, width, height);
  if (candidates.length < size.cols * size.rows) return null;
  const spacing = medianSpacing(candidates);
  if (!(spacing > 3)) return null;
  const radius = Math.max(2.5, Math.min(6, spacing * 0.28));
  const refineRadius = Math.max(2, Math.min(7, Math.round(spacing * 0.3)));
  const corners = [];
  for (const c of candidates) {
    if (!isCross(smooth, width, height, c.x, c.y, radius)) continue;
    const p = refine(smooth, width, height, c.x, c.y, refineRadius);
    if (p && Math.hypot(p.x - c.x, p.y - c.y) <= MAX_REFINE_MOVE) corners.push({ ...p, strength: c.strength });
  }
  if (corners.length < size.cols * size.rows) return null;
  const finalSpacing = medianSpacing(corners);
  // Seeds: the corners nearest the middle of them all first (the board is usually most of what is found).
  const mx = corners.reduce((s, c) => s + c.x, 0) / corners.length;
  const my = corners.reduce((s, c) => s + c.y, 0) / corners.length;
  const order = corners.map((c, i) => i).sort((a, b) => Math.hypot(corners[a].x - mx, corners[a].y - my) - Math.hypot(corners[b].x - mx, corners[b].y - my));
  for (const seed of order.slice(0, 12)) {
    const grid = grow(corners, seed, finalSpacing);
    if (!grid) continue;
    const board = asBoard(grid, smooth, width, height, size);
    if (board) {
      return { corners: board.map((p) => ({ x: (p.x + 0.5) / width, y: (p.y + 0.5) / height })), spacing: finalSpacing };
    }
  }
  return null;
}

/** A separable Gaussian blur. */
export function blur(src, width, height, sigma) {
  const r = Math.ceil(3 * sigma);
  const k = new Float32Array(2 * r + 1);
  let total = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); total += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= total;
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xi = x + i < 0 ? 0 : x + i >= width ? width - 1 : x + i;
        s += k[i + r] * src[row + xi];
      }
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const yi = y + i < 0 ? 0 : y + i >= height ? height - 1 : y + i;
        s += k[i + r] * tmp[yi * width + x];
      }
      out[y * width + x] = s;
    }
  }
  return out;
}

/** The strongest saddles (local maxima of −det Hessian), strongest first, in pixels. */
function saddles(s, width, height) {
  const R = new Float32Array(width * height);
  let max = 0;
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const i = y * width + x;
      const ixx = s[i - 1] - 2 * s[i] + s[i + 1];
      const iyy = s[i - width] - 2 * s[i] + s[i + width];
      const ixy = (s[i - width - 1] + s[i + width + 1] - s[i - width + 1] - s[i + width - 1]) / 4;
      const r = ixy * ixy - ixx * iyy;
      if (r > 0) { R[i] = r; if (r > max) max = r; }
    }
  }
  const found = [];
  const floor = max * MIN_RELATIVE * MIN_RELATIVE;
  const W = 3;
  for (let y = W; y < height - W; y++) {
    for (let x = W; x < width - W; x++) {
      const i = y * width + x;
      const r = R[i];
      if (r <= floor) continue;
      let peak = true;
      for (let dy = -W; dy <= W && peak; dy++) {
        for (let dx = -W; dx <= W; dx++) {
          if ((dx || dy) && R[i + dy * width + dx] > r) { peak = false; break; }
        }
      }
      if (peak) found.push({ x, y, strength: r });
    }
  }
  found.sort((a, b) => b.strength - a.strength);
  // Judged against the strongest few rather than the single strongest, which may be a stray bright edge.
  const ref = found[Math.min(found.length - 1, 8)]?.strength ?? 0;
  return found.filter((c) => c.strength >= ref * MIN_RELATIVE).slice(0, MAX_CANDIDATES);
}

/** The median distance from each point to its nearest other point. */
function medianSpacing(points) {
  const d = points.map((p, i) => {
    let best = Infinity;
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue;
      const e = Math.hypot(points[j].x - p.x, points[j].y - p.y);
      if (e < best) best = e;
    }
    return best;
  }).sort((a, b) => a - b);
  return d[d.length >> 1];
}

/** Bilinear sample. */
function at(s, width, height, x, y) {
  const x0 = Math.max(0, Math.min(width - 2, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 2, Math.floor(y)));
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const i = y0 * width + x0;
  return (s[i] * (1 - fx) + s[i + 1] * fx) * (1 - fy) + (s[i + width] * (1 - fx) + s[i + width + 1] * fx) * fy;
}

/**
 * Whether a circle round (x, y) changes between dark and light exactly four times, with both dark and light
 * arcs of about the same size: an inner corner, where four squares meet. A square's corner against the white
 * border changes only twice, an edge twice.
 */
function isCross(s, width, height, x, y, radius) {
  const N = 32;
  const v = [];
  for (let k = 0; k < N; k++) {
    const a = (2 * Math.PI * k) / N;
    v.push(at(s, width, height, x + radius * Math.cos(a), y + radius * Math.sin(a)));
  }
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  if (hi - lo < MIN_CONTRAST) return false;
  const mid = (lo + hi) / 2;
  const dark = v.map((g) => g < mid);
  let changes = 0;
  for (let k = 0; k < N; k++) if (dark[k] !== dark[(k + 1) % N]) changes++;
  const darkCount = dark.filter(Boolean).length;
  return changes === 4 && darkCount >= N * 0.25 && darkCount <= N * 0.75;
}

/**
 * The corner to a fraction of a pixel: the point every gradient in a window round it points straight away
 * from (or toward), found by least squares and repeated from the new point a few times.
 */
function refine(s, width, height, x0, y0, r) {
  let x = x0;
  let y = y0;
  for (let iter = 0; iter < 10; iter++) {
    let a = 0;
    let b = 0;
    let c = 0;
    let bx = 0;
    let by = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const qx = x + dx;
        const qy = y + dy;
        if (qx < 1 || qy < 1 || qx > width - 2 || qy > height - 2) return null;
        const gx = (at(s, width, height, qx + 1, qy) - at(s, width, height, qx - 1, qy)) / 2;
        const gy = (at(s, width, height, qx, qy + 1) - at(s, width, height, qx, qy - 1)) / 2;
        // Weighed toward the middle of the window.
        const w = Math.exp(-(dx * dx + dy * dy) / (2 * (r / 1.5) ** 2));
        const gxx = w * gx * gx;
        const gxy = w * gx * gy;
        const gyy = w * gy * gy;
        a += gxx; b += gxy; c += gyy;
        bx += gxx * qx + gxy * qy;
        by += gxy * qx + gyy * qy;
      }
    }
    const det = a * c - b * b;
    if (!(Math.abs(det) > 1e-9)) return null;
    const nx = (c * bx - b * by) / det;
    const ny = (a * by - b * bx) / det;
    const moved = Math.hypot(nx - x, ny - y);
    x = nx;
    y = ny;
    if (moved < 0.005) break;
  }
  return { x, y };
}

/**
 * The grid of corners connected to `seed`: the seed's nearest neighbours along two directions give the grid's
 * two steps, and each new corner is looked for where the two before it in that line say it should be.
 * @returns {Map<string, {x:number, y:number}>|null} keyed "i,j"
 */
function grow(corners, seed, spacing) {
  const s = corners[seed];
  const near = corners
    .map((c, i) => ({ i, d: Math.hypot(c.x - s.x, c.y - s.y) }))
    .filter((n) => n.i !== seed && n.d < spacing * 1.8)
    .sort((a, b) => a.d - b.d)
    .slice(0, 4);
  if (near.length < 2) return null;
  // The first step is to the nearest neighbour; the second is to the nearest one well off that line.
  const u = { x: corners[near[0].i].x - s.x, y: corners[near[0].i].y - s.y };
  const second = near.slice(1).find((n) => {
    const v = { x: corners[n.i].x - s.x, y: corners[n.i].y - s.y };
    const cos = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y));
    return Math.abs(cos) < 0.5;
  });
  if (!second) return null;
  const v = { x: corners[second.i].x - s.x, y: corners[second.i].y - s.y };
  const grid = new Map([['0,0', s]]);
  const used = new Set([seed]);
  const queue = [[0, 0]];
  const steps = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (queue.length) {
    const [i, j] = queue.shift();
    const p = grid.get(`${i},${j}`);
    for (const [di, dj] of steps) {
      const key = `${i + di},${j + dj}`;
      if (grid.has(key)) continue;
      // Predicted from this corner and the one behind it in the same line, else from the starting steps.
      const back = grid.get(`${i - di},${j - dj}`);
      const step = back ? { x: p.x - back.x, y: p.y - back.y } : { x: di * u.x + dj * v.x, y: di * u.y + dj * v.y };
      const want = { x: p.x + step.x, y: p.y + step.y };
      const tol = NEIGHBOUR_TOLERANCE * Math.hypot(step.x, step.y);
      let best = -1;
      let bestD = tol;
      for (let k = 0; k < corners.length; k++) {
        if (used.has(k)) continue;
        const d = Math.hypot(corners[k].x - want.x, corners[k].y - want.y);
        if (d < bestD) { bestD = d; best = k; }
      }
      if (best < 0) continue;
      used.add(best);
      grid.set(key, corners[best]);
      queue.push([i + di, j + dj]);
    }
  }
  return grid;
}

/**
 * The grid as the board, in its own order, or null: it must be exactly the board's size and full, its cells
 * must alternate dark and light, and it is turned so that the square outside its first corner is black.
 */
function asBoard(grid, s, width, height, size) {
  const keys = [...grid.keys()].map((k) => k.split(',').map(Number));
  const is = keys.map((k) => k[0]);
  const js = keys.map((k) => k[1]);
  const [i0, i1, j0, j1] = [Math.min(...is), Math.max(...is), Math.min(...js), Math.max(...js)];
  const ni = i1 - i0 + 1;
  const nj = j1 - j0 + 1;
  if (grid.size !== ni * nj) return null;
  let across;
  if (ni === size.cols && nj === size.rows) across = 'i';
  else if (ni === size.rows && nj === size.cols) across = 'j';
  else return null;
  const node = (a, b) => grid.get(`${a},${b}`);
  // The board's (c, r) as grid nodes, for each of its two ways round in the picture.
  const ways = [];
  for (const flip of [false, true]) {
    const map = (c, r) => {
      const cc = flip ? size.cols - 1 - c : c;
      const rr = flip ? size.rows - 1 - r : r;
      return across === 'i' ? node(i0 + cc, j0 + rr) : node(i0 + rr, j0 + cc);
    };
    ways.push(map);
  }
  // The board seen from its printed side: going across it then down turns the same way as across the picture
  // then down it. One of the grid's two mirror images is that way.
  const handed = (map) => {
    const o = map(0, 0);
    const a = map(1, 0);
    const b = map(0, 1);
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x) > 0;
  };
  const candidates = [];
  for (const map of ways) {
    if (handed(map)) candidates.push(map);
    else {
      // Mirror it: read the grid's columns the other way.
      candidates.push((c, r) => map(c, size.rows - 1 - r));
    }
  }
  for (const map of candidates) {
    if (!handed(map)) continue;
    const cellMid = (c, r) => {
      const ps = [map(c, r), map(c + 1, r), map(c, r + 1), map(c + 1, r + 1)];
      return { x: ps.reduce((t, p) => t + p.x, 0) / 4, y: ps.reduce((t, p) => t + p.y, 0) / 4 };
    };
    // Cells between corners alternate: cell (c, r) is dark when c + r is even (the printed square (c+1, r+1)).
    let darkSum = 0;
    let lightSum = 0;
    let darkMax = -Infinity;
    let lightMin = Infinity;
    for (let r = 0; r < size.rows - 1; r++) {
      for (let c = 0; c < size.cols - 1; c++) {
        const m = cellMid(c, r);
        const g = at(s, width, height, m.x, m.y);
        if ((c + r) % 2 === 0) { darkSum += g; darkMax = Math.max(darkMax, g); } else { lightSum += g; lightMin = Math.min(lightMin, g); }
      }
    }
    if (!(lightMin - darkMax > MIN_CONTRAST * 0.5)) continue;
    // The square outside the first corner (diagonally) is black, and outside the last one white.
    const outside = (c, r, dc, dr) => {
      const p = map(c, r);
      const q = map(c + dc, r + dr);
      return at(s, width, height, p.x - (q.x - p.x) / 2, p.y - (q.y - p.y) / 2);
    };
    const first = outside(0, 0, 1, 1);
    const last = outside(size.cols - 1, size.rows - 1, -1, -1);
    const mid = (darkSum / Math.ceil(((size.rows - 1) * (size.cols - 1)) / 2) + lightSum / Math.floor(((size.rows - 1) * (size.cols - 1)) / 2)) / 2;
    if (first < mid && last > mid) {
      const out = [];
      for (let r = 0; r < size.rows; r++) for (let c = 0; c < size.cols; c++) out.push(map(c, r));
      return out;
    }
  }
  return null;
}
