// Least squares for the camera rig: solving linear systems, and fitting a few parameters to many
// measurements (Levenberg–Marquardt) with how sure each fitted parameter is. Used to measure lenses
// (lens-calibration.js), place cameras from markers and refine them with a wand (rig.js). Works on
// numbers only (no browser code), so it is unit tested.

/**
 * Solves M x = rhs (Gauss–Jordan with partial pivoting). Null if M is (nearly) singular.
 * @param {number[][]} M square
 * @param {number[]} rhs
 * @returns {number[]|null}
 */
export function solve(M, rhs) {
  const n = rhs.length;
  const a = M.map((row, i) => [...row, rhs[i]]);
  const scale = Math.max(...M.map((row) => Math.max(...row.map(Math.abs))));
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (!(Math.abs(a[pivot][c]) > scale * 1e-14)) return null;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = a[r][c] / a[c][c];
      if (k === 0) continue;
      for (let j = c; j <= n; j++) a[r][j] -= k * a[c][j];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

/**
 * The inverse of a square matrix, or null if it is (nearly) singular (Gauss–Jordan on [M | I]).
 * @param {number[][]} M
 * @returns {number[][]|null}
 */
export function invert(M) {
  const n = M.length;
  const a = M.map((row, i) => {
    const out = new Float64Array(2 * n);
    out.set(row);
    out[n + i] = 1;
    return out;
  });
  const scale = Math.max(...M.map((row) => Math.max(...row.map(Math.abs))));
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (!(Math.abs(a[pivot][c]) > scale * 1e-14)) return null;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    const p = a[c];
    const inv = 1 / p[c];
    for (let j = 0; j < 2 * n; j++) p[j] *= inv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const row = a[r];
      const k = row[c];
      if (k === 0) continue;
      for (let j = c; j < 2 * n; j++) row[j] -= k * p[j];
    }
  }
  return a.map((row) => Array.from(row.subarray(n)));
}

/**
 * Solves A x = b for a symmetric positive definite A (Cholesky): a sixth of the work of solve. Null if A
 * isn't positive definite.
 * @param {number[][]} A @param {number[]} b
 * @returns {number[]|null}
 */
export function solveSymmetric(A, b) {
  const n = b.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    const Li = L[i];
    for (let j = 0; j <= i; j++) {
      const Lj = L[j];
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= Li[k] * Lj[k];
      if (i === j) {
        if (!(sum > 0)) return null;
        Li[i] = Math.sqrt(sum);
      } else {
        Li[j] = sum / Lj[j];
      }
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i][k] * y[k];
    y[i] = sum / L[i][i];
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k][i] * x[k];
    x[i] = sum / L[i][i];
  }
  return x;
}

/**
 * Fits parameters to measurements: the `x` for which `residuals(x)` (each measurement less what `x`
 * predicts, in the measurements' own units) is smallest in the sum of squares. Levenberg–Marquardt, with
 * the Jacobian taken by finite differences, so `residuals` need only be smooth near the answer.
 *
 * The result says how sure it is: `sigma` is the residuals' RMS corrected for the parameters used up
 * (the measurements' noise, if the model is right), and `covariance` is that noise carried into the
 * parameters, so `Math.sqrt(covariance[i][i])` is one standard deviation of `x[i]`.
 * @param {(x:number[]) => number[]} residuals the same length for every x
 * @param {number[]} x0 a start near enough to the answer
 * @param {object} [opts]
 * @param {number} [opts.maxIterations]
 * @param {number[]} [opts.steps] finite-difference step for each parameter (default from its size)
 * @param {number} [opts.tolerance] stop when the cost falls by less than this fraction
 * @param {(x:number[], j:number) => {from:number, values:number[]}} [opts.partial] for a problem where each
 *   parameter moves only some residuals (a lens fitted to many views, each view's pose moving only its own):
 *   the residuals from index `from` on, as far as there are `values`, at x, and none other change with x[j].
 *   Much faster than evaluating every residual for every parameter.
 * @returns {{x:number[], rms:number, sigma:number, covariance:number[][]|null, iterations:number}}
 */
export function leastSquares(residuals, x0, { maxIterations = 100, steps = null, tolerance = 1e-12, partial = null } = {}) {
  let x = [...x0];
  let r = residuals(x);
  let cost = sumSquares(r);
  let lambda = 1e-3;
  let iterations = 0;
  let J = jacobian(residuals, x, r, steps, partial);
  for (; iterations < maxIterations; iterations++) {
    const { JtJ, Jtr } = normal(J, r);
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v + lambda * Math.max(v, 1e-12) : v)));
      const dx = solveSymmetric(A, Jtr.map((v) => -v)) ?? solve(A, Jtr.map((v) => -v));
      if (!dx) { lambda *= 10; continue; }
      const xNew = x.map((v, i) => v + dx[i]);
      const rNew = residuals(xNew);
      const costNew = sumSquares(rNew);
      if (Number.isFinite(costNew) && costNew < cost) {
        const fell = (cost - costNew) / Math.max(cost, 1e-300);
        x = xNew;
        r = rNew;
        cost = costNew;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = fell > tolerance;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
    J = jacobian(residuals, x, r, steps, partial);
  }
  const { JtJ } = normal(J, r);
  const dof = Math.max(1, r.length - x.length);
  const sigma = Math.sqrt(cost / dof);
  const inverse = invert(JtJ);
  return {
    x,
    rms: Math.sqrt(cost / Math.max(1, r.length)),
    sigma,
    covariance: inverse ? inverse.map((row) => row.map((v) => v * sigma * sigma)) : null,
    iterations,
  };
}

function sumSquares(r) {
  let s = 0;
  for (const v of r) s += v * v;
  return s;
}

function jacobian(residuals, x, r, steps, partial) {
  // Stored by rows, each row only its non-zero columns: [column, value] pairs.
  const rows = r.map(() => []);
  for (let j = 0; j < x.length; j++) {
    const h = steps?.[j] ?? 1e-6 * Math.max(1, Math.abs(x[j]));
    const xh = [...x];
    xh[j] += h;
    if (partial) {
      const { from, values } = partial(xh, j);
      for (let k = 0; k < values.length; k++) {
        const d = (values[k] - r[from + k]) / h;
        if (d !== 0) rows[from + k].push(j, d);
      }
      continue;
    }
    const rh = residuals(xh);
    for (let i = 0; i < r.length; i++) {
      const d = (rh[i] - r[i]) / h;
      if (d !== 0) rows[i].push(j, d);
    }
  }
  return { rows, n: x.length };
}

function normal(J, r) {
  const n = J.n;
  const JtJ = Array.from({ length: n }, () => new Array(n).fill(0));
  const Jtr = new Array(n).fill(0);
  J.rows.forEach((row, i) => {
    for (let a = 0; a < row.length; a += 2) {
      const ca = row[a];
      const va = row[a + 1];
      Jtr[ca] += va * r[i];
      const out = JtJ[ca];
      for (let b = 0; b < row.length; b += 2) out[row[b]] += va * row[b + 1];
    }
  });
  return { JtJ, Jtr };
}
