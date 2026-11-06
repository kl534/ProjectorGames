// Planar homography helpers. A homography is stored as a flat array of 9 numbers
// (row-major 3x3 matrix, normalised so the last entry is 1).

/**
 * Computes the homography that maps each of the four `src` points onto the
 * matching `dst` point. Returns null if the points are degenerate.
 * @param {{x:number,y:number}[]} src
 * @param {{x:number,y:number}[]} dst
 */
export function computeHomography(src, dst) {
  if (src.length !== 4 || dst.length !== 4) throw new Error('Need exactly four point pairs');
  const a = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear(a, b);
  return h ? [...h, 1] : null;
}

/** Maps point `p` through homography `h`. */
export function applyHomography(h, p) {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
}

/** Returns the inverse homography, or null if `h` is singular. */
export function invertHomography(h) {
  const [a, b, c, d, e, f, g, i, j] = h;
  const A = e * j - f * i;
  const B = -(d * j - f * g);
  const C = d * i - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const inv = [
    A, -(b * j - c * i), b * f - c * e,
    B, a * j - c * g, -(a * f - c * d),
    C, -(a * i - b * g), a * e - b * d,
  ];
  const s = inv[8];
  if (Math.abs(s) < 1e-12) return inv.map((v) => v / det);
  return inv.map((v) => v / s);
}

/**
 * True if the four points, taken in order, form a convex quadrilateral that
 * doesn't cross itself (either winding direction is accepted).
 */
export function isConvexQuad(points) {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const p0 = points[k];
    const p1 = points[(k + 1) % 4];
    const p2 = points[(k + 2) % 4];
    const cross = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
    if (!Number.isFinite(cross) || Math.abs(cross) < 1e-12) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Area of a simple polygon (shoelace formula). */
export function polygonArea(points) {
  let sum = 0;
  for (let k = 0; k < points.length; k++) {
    const p = points[k];
    const q = points[(k + 1) % points.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return Math.abs(sum) / 2;
}

// Gaussian elimination with partial pivoting. Returns null for singular systems.
function solveLinear(a, b) {
  const n = b.length;
  const m = a.map((row, r) => [...row, b[r]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r][col] / m[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= factor * m[col][c];
    }
  }
  return m.map((row, r) => row[n] / row[r]);
}
