// Demolition Day physics, kept free of the browser so it can be unit-tested:
// how a slab that has come loose moves (it tips over the edge of what it rests
// on, hinges off a wall it was torn from, or drops), where and how hard it
// strikes the city or the ground, how it breaks into chunks there, and how
// each chunk flies, bounces, rolls and comes to rest.
//
// A slab is a rigid body made of its cells, each as heavy as its material's
// `density`. Everything here is worked out in pixels of the screen (`view`),
// so that turning is round on any screen: x across, y down, and an angle is
// clockwise on screen. The simulation runs in fixed steps from the moment the
// slab comes loose, so the same slab in the same city always falls the same
// way, and the game can tell the camera where it will go before it moves.

import { DEMOLITION_DAY_RULES, cellRect, cellWidth, hash01 } from './demolition-day-logic.js';

const R = DEMOLITION_DAY_RULES;

/**
 * @typedef {import('./demolition-day-logic.js').Grid} Grid
 * @typedef {import('./demolition-day-logic.js').Slab} Slab
 * @typedef {import('./demolition-day-logic.js').Cell} Cell
 * @typedef {import('./demolition-day-logic.js').View} View
 * @typedef {object} Body a slab as a rigid body
 * @property {{row: number, col: number, x: number, y: number, m: number, kind: string}[]} cells each cell's centre
 *   from the centre of mass when the slab was in place (pixels), and its mass
 * @property {number[]} edge the indices of the cells on its outline, which are what can strike something
 * @property {number} mass
 * @property {number} inertia about the centre of mass
 * @property {number} x0 where the centre of mass was, in place (pixels)
 * @property {number} y0
 * @property {number} cw a cell's width and height (pixels)
 * @property {number} ch
 * @property {string} kind its main material, by mass
 * @typedef {object} State where a body is and how it moves at a moment
 * @property {number} t ms since it came loose
 * @property {number} x the centre of mass (pixels)
 * @property {number} y
 * @property {number} angle clockwise, radians
 * @property {number} vx pixels a second
 * @property {number} vy
 * @property {number} omega radians a second
 * @property {boolean} pivoting still turning over the edge it rested on (or the joint it hung from)
 * @typedef {object} Pivot the edge a slab turns over before it flies off
 * @property {number} x pixels
 * @property {number} y
 * @property {Cell} cell the standing cell it turns on: if that goes, it flies off at once
 * @property {number} release how far it turns (radians) before it flies off
 * @typedef {object} Impact
 * @property {number} t ms since it came loose
 * @property {State} state
 * @property {Cell[]} contacts the standing cells it struck
 * @property {boolean} ground whether it struck the ground
 * @property {{x: number, y: number}} point where it first struck (pixels)
 * @property {number} speed how fast that point was going (screen heights a second)
 * @property {number} momentum the slab's mass times `speed`
 * @typedef {object} Plan a fall worked out in advance
 * @property {Pivot|null} pivot
 * @property {State[]} states one a step, from when it came loose (or was planned again) to the impact
 * @property {Impact} impact
 */

/** Pixels across a cell, and down. */
function cellSize(view, rules) {
  return { cw: cellWidth(rules) * view.width, ch: rules.rowHeight * view.height };
}

/** The centre of a cell in pixels. */
function centrePx(row, col, view, rules) {
  const r = cellRect(row, col, rules);
  return { x: ((r.x0 + r.x1) / 2) * view.width, y: ((r.y0 + r.y1) / 2) * view.height };
}

/**
 * A slab as a rigid body: its mass, centre of mass and moment of inertia from its cells and their materials.
 * @param {Slab} slab
 * @returns {Body}
 */
export function bodyOf(slab, view, rules = R) {
  const { cw, ch } = cellSize(view, rules);
  const raw = [];
  const byKind = {};
  for (const piece of slab.pieces) {
    const density = rules.density[piece.kind] ?? 1;
    for (let r = piece.row; r < piece.row + piece.height; r++) {
      for (let c = piece.col; c < piece.col + piece.width; c++) {
        raw.push({ row: r, col: c, ...centrePx(r, c, view, rules), m: density, kind: piece.kind });
        byKind[piece.kind] = (byKind[piece.kind] ?? 0) + density;
      }
    }
  }
  const mass = raw.reduce((s, c) => s + c.m, 0);
  const x0 = raw.reduce((s, c) => s + c.m * c.x, 0) / mass;
  const y0 = raw.reduce((s, c) => s + c.m * c.y, 0) / mass;
  const own = (cw * cw + ch * ch) / 12;
  let inertia = 0;
  const cells = raw.map((c) => {
    const x = c.x - x0;
    const y = c.y - y0;
    inertia += c.m * (x * x + y * y + own);
    return { row: c.row, col: c.col, x, y, m: c.m, kind: c.kind };
  });
  const key = new Set(cells.map((c) => c.row * 1000 + c.col));
  const edge = [];
  cells.forEach((c, i) => {
    const k = c.row * 1000 + c.col;
    if (!key.has(k + 1000) || !key.has(k - 1000) || !key.has(k + 1) || !key.has(k - 1)) edge.push(i);
  });
  const kind = Object.entries(byKind).sort((a, b) => b[1] - a[1])[0][0];
  return { cells, edge, mass, inertia, x0, y0, cw, ch, kind };
}

/**
 * How a slab that has just come loose starts to move, from what it was still touching (`grid` no longer holds it):
 * - resting on standing cells, with its centre of mass past the edge of them: it turns over that edge (`tip`);
 * - torn from a wall at its side (touching it only there): it hinges down about the bottom of the joint (`hinge`);
 * - otherwise (nothing under it, or its centre of mass over what it rests on, which has given way): it drops.
 * @param {Grid} grid
 * @param {Body} body
 * @returns {{state: State, pivot: Pivot|null}}
 */
export function startMotion(grid, body, view, rules = R) {
  const { cw, ch } = { cw: body.cw, ch: body.ch };
  const own = new Set(body.cells.map((c) => c.row * 1000 + c.col));
  const standing = (r, c) => r >= 0 && c >= 0 && c < grid.columns && r < grid.rows && grid.cells[r][c] && !own.has(r * 1000 + c);
  const below = [];
  const left = [];
  const right = [];
  for (const c of body.cells) {
    if (standing(c.row - 1, c.col)) below.push(c);
    if (standing(c.row, c.col - 1)) left.push(c);
    if (standing(c.row, c.col + 1)) right.push(c);
  }
  const state = { t: 0, x: body.x0, y: body.y0, angle: 0, vx: 0, vy: 0, omega: 0, pivoting: false };
  const at = (c) => ({ x: body.x0 + c.x, y: body.y0 + c.y });
  let pivot = null;
  if (below.length) {
    // The span it rests on, and which side of it the centre of mass is.
    const xs = below.map((c) => at(c).x);
    const x0 = Math.min(...xs) - cw / 2;
    const x1 = Math.max(...xs) + cw / 2;
    const slack = cw * 0.05;
    if (body.x0 > x1 + slack || body.x0 < x0 - slack) {
      const toRight = body.x0 > x1;
      const edge = below.filter((c) => Math.abs(at(c).x - (toRight ? x1 - cw / 2 : x0 + cw / 2)) < 1e-6);
      const c = edge.reduce((a, b) => (b.row > a.row ? b : a));
      pivot = { x: toRight ? x1 : x0, y: at(c).y + ch / 2, cell: { row: c.row - 1, col: c.col }, release: rules.physics.tip };
    }
  } else if (left.length || right.length) {
    const onLeft = left.length >= right.length;
    const side = onLeft ? left : right;
    const c = side.reduce((a, b) => (b.row < a.row ? b : a));
    const p = at(c);
    const x = onLeft ? p.x - cw / 2 : p.x + cw / 2;
    // It only hinges if its weight is out past the joint; else it slides straight down off it.
    if (onLeft ? body.x0 > x : body.x0 < x) {
      pivot = { x, y: p.y + ch / 2, cell: { row: c.row, col: onLeft ? c.col - 1 : c.col + 1 }, release: rules.physics.hinge };
    }
  }
  if (pivot) state.pivoting = true;
  return { state, pivot };
}

/** Where a cell's point (`lx`, `ly` from the centre of mass, in place) is when the body is at `state`. */
export function worldPoint(state, lx, ly) {
  const cos = Math.cos(state.angle);
  const sin = Math.sin(state.angle);
  return { x: state.x + lx * cos - ly * sin, y: state.y + lx * sin + ly * cos };
}

/** The other way: a point on screen (pixels) as where it would be on the slab in place. */
export function localPoint(state, body, x, y) {
  const cos = Math.cos(state.angle);
  const sin = Math.sin(state.angle);
  const dx = x - state.x;
  const dy = y - state.y;
  return { x: body.x0 + dx * cos + dy * sin, y: body.y0 - dx * sin + dy * cos };
}

/** How fast a point of the body (pixels from its centre of mass, as it is turned now) is moving. */
function velocityAt(state, rx, ry) {
  return { vx: state.vx - state.omega * ry, vy: state.vy + state.omega * rx };
}

/**
 * Works out a fall in steps until the slab strikes standing cells or the ground. The corners of its outline cells
 * (a little inside them, so that it doesn't strike what it was resting on as it leaves) are what can strike.
 * While it turns over its pivot, it does so under gravity about that point, and flies off with the motion it has
 * when it has turned `pivot.release` (or at once if the cell it turns on is no longer there). If it strikes something
 * before it has turned a quarter of that, it is wedged in and can't turn: it drops straight instead.
 * @param {Grid} grid what stands (not the slab)
 * @param {Body} body
 * @param {State} start
 * @param {Pivot|null} pivot
 * @returns {Plan}
 */
export function planFall(grid, body, start, pivot, view, rules = R) {
  const p = rules.physics;
  const dt = p.step;
  const g = rules.gravity * view.height;
  const ground = rules.ground * view.height;
  const cwn = cellWidth(rules);
  const inset = 0.38;
  const corners = [];
  for (const i of body.edge) {
    const c = body.cells[i];
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      corners.push({ x: c.x + sx * body.cw * inset, y: c.y + sy * body.ch * inset });
    }
  }
  let s = { ...start };
  let piv = pivot && s.pivoting && grid.cells[pivot.cell.row]?.[pivot.cell.col] ? pivot : null;
  if (!piv) s.pivoting = false;
  // About the pivot: the inertia there, and where the centre of mass is from it when the slab is in place.
  const ip = piv ? body.inertia + body.mass * ((body.x0 - piv.x) ** 2 + (body.y0 - piv.y) ** 2) : 0;
  const states = [{ ...s }];
  const maxSteps = Math.ceil(4 / dt);
  for (let k = 0; k < maxSteps; k++) {
    if (piv) {
      const rx = s.x - piv.x;
      s.omega += ((body.mass * g * rx) / ip) * dt;
      s.angle += s.omega * dt;
      const q = worldPoint({ x: piv.x, y: piv.y, angle: s.angle }, body.x0 - piv.x, body.y0 - piv.y);
      s.vx = (q.x - s.x) / dt;
      s.vy = (q.y - s.y) / dt;
      s.x = q.x;
      s.y = q.y;
      if (Math.abs(s.angle) >= piv.release) {
        piv = null;
        s.pivoting = false;
      }
    } else {
      s.vy += g * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.angle += s.omega * dt;
    }
    s.t += dt * 1000;
    // What it strikes now.
    const contacts = new Map();
    let ground_ = false;
    // Where it strikes: the middle of every corner that has gone in (a slab that lands flat strikes all along).
    let hits = 0;
    let hx = 0;
    let hy = 0;
    let lx = 0;
    let ly = 0;
    const struck = (w, c) => {
      hits++;
      hx += w.x;
      hy += w.y;
      lx += c.x;
      ly += c.y;
    };
    for (const c of corners) {
      const w = worldPoint(s, c.x, c.y);
      const depth = w.y - ground;
      if (depth >= 0) {
        ground_ = true;
        struck(w, c);
        continue;
      }
      const col = Math.floor((w.x / view.width - rules.left) / cwn);
      const row = Math.floor((rules.ground - w.y / view.height) / rules.rowHeight);
      if (col < 0 || col >= grid.columns || row < 0 || row >= grid.rows) continue;
      if (!grid.cells[row][col]) continue;
      if (piv && row === piv.cell.row && col === piv.cell.col) continue;
      contacts.set(row * grid.columns + col, { row, col });
      struck(w, c);
    }
    states.push({ ...s });
    // Turning, it struck something at once: it is wedged in (a wall beside it on the side it would turn into), so it
    // can't turn, and slides straight down instead.
    if (hits && piv && Math.abs(s.angle) < piv.release / 4) {
      return planFall(grid, body, { ...start, pivoting: false }, null, view, rules);
    }
    if (hits) {
      const r = worldPoint({ x: 0, y: 0, angle: s.angle }, lx / hits, ly / hits);
      const v = velocityAt(s, r.x, r.y);
      const speed = Math.hypot(v.vx, v.vy) / view.height;
      return {
        pivot,
        states,
        impact: {
          t: s.t, state: { ...s }, contacts: [...contacts.values()], ground: ground_, point: { x: hx / hits, y: hy / hits },
          speed, momentum: body.mass * speed,
        },
      };
    }
  }
  // Never reached: everything strikes the ground in the end.
  return { pivot, states, impact: { t: s.t, state: { ...s }, contacts: [], ground: true, point: { x: s.x, y: s.y }, speed: 0, momentum: 0 } };
}

/** The state of a plan at `t` (ms since it came loose), between its steps; the impact's at or after it. */
export function stateAt(plan, t) {
  const { states } = plan;
  if (t <= states[0].t) return { ...states[0] };
  const last = states[states.length - 1];
  if (t >= last.t) return { ...last };
  const dt = states[1].t - states[0].t;
  const k = Math.min(states.length - 2, Math.floor((t - states[0].t) / dt));
  const a = states[k];
  const b = states[k + 1];
  const f = (t - a.t) / (b.t - a.t);
  const mix = (u, v) => u + (v - u) * f;
  return {
    t, x: mix(a.x, b.x), y: mix(a.y, b.y), angle: mix(a.angle, b.angle), vx: mix(a.vx, b.vx), vy: mix(a.vy, b.vy),
    omega: mix(a.omega, b.omega), pivoting: a.pivoting,
  };
}

/** Whether a plan ever turns the slab (if not, it only drops, and the camera can follow it as it is). */
export function turns(plan) {
  return plan.states.some((s) => Math.abs(s.angle) > 1e-4) || Math.abs(plan.impact.state.omega) > 1e-4;
}

/**
 * The box (pixels) a body covers at `state`: its outline cells' corners.
 * @returns {{x0: number, y0: number, x1: number, y1: number}}
 */
export function bodyBox(body, state) {
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const i of body.edge) {
    const c = body.cells[i];
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const w = worldPoint(state, c.x + (sx * body.cw) / 2, c.y + (sy * body.ch) / 2);
      box.x0 = Math.min(box.x0, w.x);
      box.y0 = Math.min(box.y0, w.y);
      box.x1 = Math.max(box.x1, w.x);
      box.y1 = Math.max(box.y1, w.y);
    }
  }
  return box;
}

/**
 * How hard a landing hits the cells it struck: a blow for `damageField`, from the slab's momentum.
 * @returns {{power: number, reach: number}}
 */
export function impactBlow(impact, rules = R) {
  const { base, perMomentum, max, reach } = rules.physics.impact;
  return { power: Math.min(max, base + perMomentum * impact.momentum), reach };
}

// ---- Chunks ---------------------------------------------------------------------

/**
 * @typedef {object} Chunk a piece a slab or a wall breaks into
 * @property {number[]} cells indices into its body's `cells`
 * @property {number} lx its centre, from the body's centre of mass, in place (pixels)
 * @property {number} ly
 * @property {number} radius about how far its edge is from its centre (pixels)
 * @property {number} mass
 * @property {Record<string, number>} kinds how many cells of each material
 * @property {State} state where it is and how it moves when it breaks off
 */

/**
 * Splits a body into chunks about `size` cells across (by its main material, `chunkCells`, bigger if there would be
 * more than `maxChunks`): each cell goes to the nearest of a set of points scattered over it, so they are irregular.
 * @param {Body} body
 * @param {number} seed
 * @param {number} [size] cells across, instead of the material's
 * @returns {Omit<Chunk, 'state'>[]}
 */
export function splitBody(body, seed, size, rules = R) {
  const p = rules.physics;
  let s = Math.max(size ?? p.chunkCells[body.kind] ?? 3, Math.sqrt(body.cells.length / p.maxChunks));
  const rows = body.cells.map((c) => c.row);
  const cols = body.cells.map((c) => c.col);
  const r0 = Math.min(...rows);
  const c0 = Math.min(...cols);
  const blockKey = (c) => `${Math.floor((c.row - r0) / s)},${Math.floor((c.col - c0) / s)}`;
  while (new Set(body.cells.map(blockKey)).size > p.maxChunks) s *= 1.1;
  // One point in each block of the lattice that has a cell of the body.
  const blocks = new Map();
  for (const c of body.cells) {
    const key = blockKey(c);
    if (!blocks.has(key)) {
      const [br, bc] = key.split(',').map(Number);
      blocks.set(key, {
        row: r0 + (br + 0.15 + 0.7 * hash01(br, bc, seed)) * s,
        col: c0 + (bc + 0.15 + 0.7 * hash01(bc, br, seed + 7)) * s,
        cells: [],
      });
    }
  }
  const seeds = [...blocks.values()];
  const aspect = body.ch / body.cw;
  body.cells.forEach((c, i) => {
    let best = null;
    let bestD = Infinity;
    for (const sd of seeds) {
      const d = (c.col + 0.5 - sd.col) ** 2 + ((c.row + 0.5 - sd.row) * aspect) ** 2;
      if (d < bestD) { bestD = d; best = sd; }
    }
    best.cells.push(i);
  });
  return seeds.filter((sd) => sd.cells.length).map((sd) => {
    let m = 0;
    let lx = 0;
    let ly = 0;
    const kinds = {};
    for (const i of sd.cells) {
      const c = body.cells[i];
      m += c.m;
      lx += c.m * c.x;
      ly += c.m * c.y;
      kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
    }
    lx /= m;
    ly /= m;
    let radius = 0;
    for (const i of sd.cells) {
      const c = body.cells[i];
      radius = Math.max(radius, Math.hypot(Math.abs(c.x - lx) + body.cw / 2, Math.abs(c.y - ly) + body.ch / 2));
    }
    // The radius it rests on is less than its farthest corner: about its mean half-size.
    const across = Math.sqrt(sd.cells.length * body.cw * body.ch);
    return { cells: sd.cells, lx, ly, radius: Math.min(radius, across * 0.55), mass: m, kinds };
  });
}

/**
 * A slab breaks where it landed: each chunk keeps the motion its part of the slab had, bounces back up (`rebound`)
 * and is thrown out from where the slab struck, faster the harder it hit (`spread`), and set spinning.
 * @param {Body} body
 * @param {Pick<Impact, 'state'|'point'|'speed'>} impact
 * @param {number} seed
 * @param {{bounce?: boolean}} [options] bounce: false for a slab broken in the air, whose chunks carry on down
 * @returns {Chunk[]}
 */
export function breakOnImpact(body, impact, seed, view, { bounce = true } = {}, rules = R) {
  const p = rules.physics;
  const s = impact.state;
  const speed = impact.speed * view.height;
  return splitBody(body, seed, undefined, rules).map((chunk, k) => {
    const r = worldPoint({ x: 0, y: 0, angle: s.angle }, chunk.lx, chunk.ly);
    const v = velocityAt(s, r.x, r.y);
    const x = s.x + r.x;
    const y = s.y + r.y;
    const away = Math.sign(x - impact.point.x) || (hash01(k, seed, 3) < 0.5 ? -1 : 1);
    const a = hash01(k, seed, 1);
    const b = hash01(k, seed, 2);
    const vy = bounce && v.vy > 0 ? -v.vy * p.rebound * (0.3 + 0.7 * a) : v.vy;
    return {
      ...chunk,
      state: {
        t: 0, x, y, angle: s.angle,
        vx: v.vx * 0.6 + away * speed * p.spread * (0.2 + 0.8 * b),
        vy: vy - speed * p.spread * 0.5 * b,
        omega: s.omega * 0.5 + (a - 0.5) * 2 * (speed / Math.max(8, chunk.radius)) * 0.6,
        pivoting: false,
      },
    };
  });
}

/**
 * Cells blasted out of a wall: each chunk flies out from the blast's centre (`origin`, pixels), the faster the
 * stronger the blast (`power`, 10 for a throw) and the nearer to it, a little upwards, spinning.
 * @param {Body} body the cells that broke, in place
 * @param {{x: number, y: number}} origin
 * @param {number} power
 * @param {number} seed
 * @param {number} [size] chunks about this many cells across
 * @returns {Chunk[]}
 */
export function blastApart(body, origin, power, seed, view, size = 1.5, rules = R) {
  const p = rules.physics;
  const top = p.blastSpeed * view.height * (power / 10) ** 0.6;
  return splitBody(body, seed, size, rules).map((chunk, k) => {
    const x = body.x0 + chunk.lx;
    const y = body.y0 + chunk.ly;
    let dx = x - origin.x;
    let dy = y - origin.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) {
      const a = hash01(k, seed, 4) * Math.PI * 2;
      dx = Math.cos(a);
      dy = Math.sin(a);
    } else {
      dx /= d;
      dy /= d;
    }
    const near = 1 / (1 + d / (body.cw * 3));
    const speed = top * (0.35 + 0.65 * near) * (0.6 + 0.4 * hash01(k, seed, 5));
    return {
      ...chunk,
      state: {
        t: 0, x, y, angle: 0,
        // Out of the wall and towards the players, so less sideways than it would on the wall itself, and up a little:
        // gravity brings it down.
        vx: dx * speed * 0.7,
        vy: dy * speed * 0.6 - speed * 0.45,
        omega: (hash01(k, seed, 6) - 0.5) * 2 * (speed / Math.max(6, chunk.radius)),
        pivoting: false,
      },
    };
  });
}

/**
 * @typedef {object} ChunkPath how a chunk flies, bounces and comes to rest
 * @property {{t: number, x: number, y: number, angle: number}[]} points every `stepMs`, from 0 to `restT`
 * @property {number} stepMs
 * @property {number} restT ms until it lies still
 * @property {number} endT ms until it has faded away (`restMs` + `fadeMs` after it comes to rest)
 * @property {{x0: number, y0: number, x1: number, y1: number}} box everywhere it goes (pixels)
 */

/**
 * A chunk's flight: gravity, then bounces on the ground (`floor(x)` is the ground's height there, pixels down), each
 * giving back `restitution` of its speed into the ground and keeping `friction` of its speed along it, then rolling
 * and sliding to a stop (`roll`), its spin matching its roll, until it is slower than `restSpeed`; lying down, it settles flat on its
 * nearest side.
 * @param {Chunk} chunk
 * @param {(x: number) => number} [floor]
 * @returns {ChunkPath}
 */
export function chunkPath(chunk, view, floor, rules = R) {
  const p = rules.physics;
  const dt = 1 / 120;
  const stepMs = 1000 / 60;
  const g = rules.gravity * view.height;
  const groundAt = floor ?? (() => rules.ground * view.height);
  const rest = p.restSpeed * view.height;
  const r = chunk.radius;
  let { x, y, vx, vy, angle, omega } = chunk.state;
  const points = [{ t: 0, x, y, angle }];
  const box = { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
  let t = 0;
  let restT = null;
  let next = stepMs;
  let onGround = false;
  while (t < p.maxFlightMs) {
    vy += g * dt;
    x += vx * dt;
    y += vy * dt;
    angle += omega * dt;
    t += dt * 1000;
    const floorY = groundAt(x) - r;
    if (y >= floorY) {
      y = floorY;
      if (vy > 0) {
        vy = -vy * p.restitution;
        vx *= p.friction;
        omega = 0.6 * omega + 0.4 * (vx / Math.max(4, r));
      }
      onGround = Math.abs(vy) < rest * 2;
      if (onGround) {
        vy = 0;
        vx *= Math.max(0, 1 - p.roll * dt);
        omega = vx / Math.max(4, r);
      }
    }
    if (onGround && Math.abs(vx) < rest) {
      restT = t;
      break;
    }
    box.x0 = Math.min(box.x0, x - r);
    box.y0 = Math.min(box.y0, y - r);
    box.x1 = Math.max(box.x1, x + r);
    box.y1 = Math.max(box.y1, y + r);
    if (t >= next) {
      points.push({ t, x, y, angle });
      next += stepMs;
    }
  }
  // Lying on the ground: it rocks onto its nearest flat side.
  const flat = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
  restT ??= t;
  points.push({ t: restT, x, y: Math.min(y, groundAt(x) - r), angle });
  points.push({ t: restT + 120, x, y: groundAt(x) - r, angle: flat });
  box.x0 = Math.min(box.x0, x - r * 1.5);
  box.x1 = Math.max(box.x1, x + r * 1.5);
  box.y1 = Math.max(box.y1, groundAt(x));
  return { points, stepMs, restT: restT + 120, endT: restT + 120 + p.restMs + p.fadeMs, box };
}

/** Where a chunk is at `t` (ms since it broke off) on its path. */
export function chunkAt(path, t) {
  const { points } = path;
  if (t <= 0) return points[0];
  const last = points[points.length - 1];
  if (t >= last.t) return last;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const f = (t - a.t) / (b.t - a.t || 1);
  return { t, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, angle: a.angle + (b.angle - a.angle) * f };
}

/** How opaque a chunk is at `t`: whole until it has lain still for `restMs`, then fading out. */
export function chunkAlpha(path, t, rules = R) {
  const fadeFrom = path.endT - rules.physics.fadeMs;
  if (t <= fadeFrom) return 1;
  return Math.max(0, 1 - (t - fadeFrom) / rules.physics.fadeMs);
}
