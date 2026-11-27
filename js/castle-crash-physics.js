// Castle Crash physics: a small 2D rigid-body engine (no browser code, unit
// tested) for boxes and balls that stack, tip, slide, tumble and knock each
// other over, in the manner of Box2D Lite: contact points found by separating
// axes and clipping, sequential impulses with warm starting (each contact's
// impulse carried from one step to the next by which corner and face made it),
// Coulomb friction, a little bounce, and sleeping. A fort stands asleep until
// something awake touches it; then all of it that is touching wakes together,
// and falls asleep again once every part of it has been still a while.
//
// Units are metres, kilograms and seconds, with y up and the ground's top at
// y = 0. Angles are radians, anticlockwise. A body's mass is its density times
// its area. What a body is for the game (wood, a goblin…) rides on it in
// `kind` and the game's own fields; the engine only reads its shape and
// material numbers, and reports each step's contact impulses (`onImpulse`),
// which the game turns into damage.

/**
 * @typedef {object} Body
 * @property {number} id
 * @property {'box'|'circle'} shape
 * @property {number} w box width
 * @property {number} h box height
 * @property {number} r circle radius
 * @property {number} x centre
 * @property {number} y centre
 * @property {number} a angle
 * @property {number} vx
 * @property {number} vy
 * @property {number} va angular velocity
 * @property {number} mass 0 for a static body
 * @property {number} invM
 * @property {number} invI
 * @property {number} friction
 * @property {number} restitution
 * @property {boolean} isStatic
 * @property {boolean} awake
 * @property {number} still seconds it has been slow for
 * @property {boolean} removed
 * @typedef {object} ContactPoint
 * @property {number} px
 * @property {number} py
 * @property {number} sep separation, negative when overlapping
 * @property {string} key which features made it, to carry its impulse over
 * @property {number} pn accumulated normal impulse this step
 * @property {number} pt accumulated friction impulse this step
 * @property {number} warm the normal impulse it started the step with (last step's)
 * @typedef {object} Manifold
 * @property {Body} a
 * @property {Body} b
 * @property {number} nx normal, from a to b
 * @property {number} ny
 * @property {ContactPoint[]} points
 * @typedef {object} World
 * @property {Body[]} bodies
 * @property {Map<string, Manifold>} contacts by pair
 * @property {number} gravity metres a second squared, down
 * @property {number} time seconds simulated
 */

export const PHYSICS = {
  dt: 1 / 120,
  iterations: 12,
  // Overlap allowed before it is pushed out, and how much of the rest is pushed out a step.
  slop: 0.008,
  baumgarte: 0.2,
  // Closing faster than this bounces (by the bodies' restitution); slower just stops.
  bounceSpeed: 1,
  // A body slower than these for `sleepAfter` seconds may sleep (with all it touches).
  sleepSpeed: 0.08,
  sleepSpin: 0.12,
  sleepAfter: 0.6,
  // Gentle damping (a second), a little more turning damping for balls.
  linearDamping: 0.02,
  angularDamping: 0.1,
  rollingDamping: 0.3,
  // How much a ball resists rolling (it stays put on a slope up to about this steep, as a tangent).
  rollingResistance: 0.06,
  // Broad phase boxes are grown by this, so contacts are found just before they touch.
  margin: 0.02,
};

/** A world with only the ground: a static slab whose top is y = 0. */
export function createWorld({ gravity = 9.8 } = {}) {
  /** @type {World} */
  const world = { bodies: [], contacts: new Map(), gravity, time: 0, nextId: 1 };
  addBody(world, { shape: 'box', w: 400, h: 10, x: 0, y: -5, isStatic: true, friction: 0.8, kind: 'ground' });
  return world;
}

/**
 * Adds a body. `spec` has its shape (`w`/`h` or `r`), `x`/`y` (its centre), and
 * optionally `a`, `density` (1), `friction` (0.6), `restitution` (0.1),
 * `isStatic`, `awake` (true), and any of the game's own fields, which are kept.
 * @returns {Body}
 */
export function addBody(world, spec) {
  const { density = 1, friction = 0.6, restitution = 0.1, isStatic = false, awake = true, ...rest } = spec;
  const body = {
    a: 0, vx: 0, vy: 0, va: 0, w: 0, h: 0, r: 0,
    ...rest,
    id: world.nextId++, friction, restitution, isStatic, awake: !isStatic && awake, still: 0, removed: false,
  };
  if (isStatic) {
    body.mass = 0;
    body.invM = 0;
    body.invI = 0;
  } else if (body.shape === 'circle') {
    body.mass = density * Math.PI * body.r * body.r;
    body.invM = 1 / body.mass;
    body.invI = 1 / (0.5 * body.mass * body.r * body.r);
  } else {
    body.mass = density * body.w * body.h;
    body.invM = 1 / body.mass;
    body.invI = 1 / ((body.mass * (body.w * body.w + body.h * body.h)) / 12);
  }
  world.bodies.push(body);
  return body;
}

/** Takes a body out of the world, waking what it was touching. */
export function removeBody(world, body) {
  if (body.removed) return;
  body.removed = true;
  world.bodies = world.bodies.filter((b) => b !== body);
  for (const [key, m] of world.contacts) {
    if (m.a !== body && m.b !== body) continue;
    wake(m.a === body ? m.b : m.a);
    world.contacts.delete(key);
  }
}

/** Wakes a body (a static one stays as it is). */
export function wake(body) {
  if (body.isStatic || body.removed) return;
  body.awake = true;
  body.still = 0;
}

/** Puts every moving body to sleep where it is. */
export function sleepAll(world) {
  for (const b of world.bodies) {
    if (b.isStatic) continue;
    b.awake = false;
    b.vx = 0;
    b.vy = 0;
    b.va = 0;
  }
}

/** Is anything (other than those `ignore` says) still awake? */
export function isAwake(world, ignore = () => false) {
  return world.bodies.some((b) => b.awake && !ignore(b));
}

/** Gives a body a push: an impulse (kg m/s) through the point (px, py), default its centre. */
export function applyImpulse(body, jx, jy, px = body.x, py = body.y) {
  if (body.isStatic) return;
  wake(body);
  body.vx += jx * body.invM;
  body.vy += jy * body.invM;
  body.va += body.invI * ((px - body.x) * jy - (py - body.y) * jx);
}

/**
 * One fixed step. `onImpulse(body, knock)` is called for each body pushed by a
 * contact this step: `knock.impulse` is the sum of its contacts' normal
 * impulses (kg m/s), `knock.rise` how much more that is than the same contacts
 * gave the step before (a knock, where a load that rests on it gives none), and
 * `knock.other` the body that pushed hardest.
 * @param {World} world
 * @param {{onImpulse?: (body: Body, knock: {impulse: number, rise: number, other: Body}) => void}} [options]
 */
export function step(world, { onImpulse } = {}) {
  const { dt, iterations } = PHYSICS;
  const invDt = 1 / dt;
  updateContacts(world);
  wakeIslands(world);

  for (const b of world.bodies) {
    if (!b.awake) continue;
    b.vy -= world.gravity * dt;
    const linear = 1 / (1 + dt * PHYSICS.linearDamping);
    b.vx *= linear;
    b.vy *= linear;
    b.va *= 1 / (1 + dt * (b.shape === 'circle' ? PHYSICS.rollingDamping : PHYSICS.angularDamping));
  }

  const active = [];
  for (const m of world.contacts.values()) {
    if (!m.points.length || !(m.a.awake || m.b.awake)) continue;
    preStep(m, invDt);
    active.push(m);
  }
  for (const m of active) warmStart(m);
  for (let i = 0; i < iterations; i++) {
    for (const m of active) solve(m);
  }

  if (onImpulse) {
    const pushes = new Map();
    for (const m of active) {
      let sum = 0;
      let rise = 0;
      for (const p of m.points) {
        sum += p.pn;
        rise += p.pn - p.warm;
      }
      if (sum <= 0) continue;
      for (const [body, other] of [[m.a, m.b], [m.b, m.a]]) {
        if (body.isStatic) continue;
        const was = pushes.get(body) ?? { impulse: 0, rise: 0, other, most: 0 };
        was.impulse += sum;
        was.rise += Math.max(0, rise);
        if (sum > was.most) {
          was.most = sum;
          was.other = other;
        }
        pushes.set(body, was);
      }
    }
    for (const [body, { impulse, rise, other }] of pushes) onImpulse(body, { impulse, rise, other });
  }

  for (const b of world.bodies) {
    if (!b.awake) continue;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.a += b.va * dt;
    const slow = Math.hypot(b.vx, b.vy) < PHYSICS.sleepSpeed && Math.abs(b.va) < PHYSICS.sleepSpin;
    b.still = slow ? b.still + dt : 0;
  }
  sleepIslands(world);
  world.time += dt;
}

// ---- Islands and sleep ------------------------------------------------------

/** Groups the moving bodies that touch (the ground and other static bodies don't join them). */
function islands(world) {
  const parent = new Map();
  const find = (b) => {
    let root = b;
    while (parent.get(root) !== root) root = parent.get(root);
    let at = b;
    while (parent.get(at) !== root) {
      const next = parent.get(at);
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  for (const b of world.bodies) if (!b.isStatic) parent.set(b, b);
  for (const m of world.contacts.values()) {
    if (!m.points.length || m.a.isStatic || m.b.isStatic) continue;
    const ra = find(m.a);
    const rb = find(m.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map();
  for (const b of parent.keys()) {
    const root = find(b);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(b);
  }
  return [...groups.values()];
}

function wakeIslands(world) {
  for (const group of islands(world)) {
    if (!group.some((b) => b.awake) || group.every((b) => b.awake)) continue;
    for (const b of group) {
      if (!b.awake) {
        b.awake = true;
        b.still = 0;
      }
    }
  }
}

function sleepIslands(world) {
  for (const group of islands(world)) {
    if (!group.some((b) => b.awake)) continue;
    if (group.some((b) => b.still < PHYSICS.sleepAfter)) continue;
    for (const b of group) {
      b.awake = false;
      b.vx = 0;
      b.vy = 0;
      b.va = 0;
    }
  }
}

// ---- Contacts ---------------------------------------------------------------

/** Finds what touches what, keeping last step's impulses where the same corner touches the same face. */
function updateContacts(world) {
  const { bodies, contacts } = world;
  const boxes = bodies.map(aabb);
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    const boxA = boxes[i];
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      if (!a.awake && !b.awake) continue; // sleeping and static bodies keep what they had
      const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
      const boxB = boxes[j];
      if (boxA.x1 < boxB.x0 || boxB.x1 < boxA.x0 || boxA.y1 < boxB.y0 || boxB.y1 < boxA.y0) {
        contacts.delete(key);
        continue;
      }
      const [first, second] = a.id < b.id ? [a, b] : [b, a];
      const found = collide(first, second);
      if (!found) {
        contacts.delete(key);
        continue;
      }
      const old = contacts.get(key);
      if (old) {
        for (const p of found.points) {
          const was = old.points.find((q) => q.key === p.key);
          if (was) {
            p.pn = was.pn;
            p.pt = was.pt;
          }
        }
      }
      contacts.set(key, { a: first, b: second, ...found });
    }
  }
}

function aabb(b) {
  const m = PHYSICS.margin;
  if (b.shape === 'circle') return { x0: b.x - b.r - m, x1: b.x + b.r + m, y0: b.y - b.r - m, y1: b.y + b.r + m };
  const c = Math.abs(Math.cos(b.a));
  const s = Math.abs(Math.sin(b.a));
  const ex = (c * b.w + s * b.h) / 2 + m;
  const ey = (s * b.w + c * b.h) / 2 + m;
  return { x0: b.x - ex, x1: b.x + ex, y0: b.y - ey, y1: b.y + ey };
}

/**
 * The contact between two bodies, normal from `a` to `b`, or null if apart.
 * @returns {{nx:number, ny:number, points: ContactPoint[]}|null}
 */
export function collide(a, b) {
  if (a.shape === 'box' && b.shape === 'box') return boxBox(a, b);
  if (a.shape === 'circle' && b.shape === 'circle') return circleCircle(a, b);
  if (a.shape === 'box') return boxCircle(a, b);
  const flipped = boxCircle(b, a);
  if (!flipped) return null;
  return { nx: -flipped.nx, ny: -flipped.ny, points: flipped.points };
}

/** A box's corners, anticlockwise from bottom left, and its faces' outward normals (face i runs from corner i to i+1). */
export function boxCorners(b) {
  const c = Math.cos(b.a);
  const s = Math.sin(b.a);
  const hw = b.w / 2;
  const hh = b.h / 2;
  const local = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  return local.map(([x, y]) => ({ x: b.x + c * x - s * y, y: b.y + s * x + c * y }));
}

function boxNormals(b) {
  const c = Math.cos(b.a);
  const s = Math.sin(b.a);
  return [{ x: s, y: -c }, { x: c, y: s }, { x: -s, y: c }, { x: -c, y: -s }];
}

/** The face of `a` that `b` is furthest outside, and by how much. */
function maxSeparation(va, na, vb) {
  let best = -Infinity;
  let face = 0;
  for (let i = 0; i < 4; i++) {
    const n = na[i];
    const v = va[i];
    let least = Infinity;
    for (const p of vb) least = Math.min(least, n.x * (p.x - v.x) + n.y * (p.y - v.y));
    if (least > best) {
      best = least;
      face = i;
    }
  }
  return { separation: best, face };
}

function boxBox(a, b) {
  const va = boxCorners(a);
  const vb = boxCorners(b);
  const na = boxNormals(a);
  const nb = boxNormals(b);
  const sa = maxSeparation(va, na, vb);
  if (sa.separation > PHYSICS.margin) return null;
  const sb = maxSeparation(vb, nb, va);
  if (sb.separation > PHYSICS.margin) return null;

  // The reference face is the one with the least overlap: a's, unless b's is clearly less,
  // so that two boxes lying face to face keep the same one from step to step.
  const flip = sb.separation > 0.95 * sa.separation + 0.005;
  const [vr, nr, face, vi, ni] = flip ? [vb, nb, sb.face, va, na] : [va, na, sa.face, vb, nb];
  const n = nr[face];
  // The incident face: the other box's face most nearly facing it.
  let incident = 0;
  let mostAgainst = Infinity;
  for (let i = 0; i < 4; i++) {
    const d = n.x * ni[i].x + n.y * ni[i].y;
    if (d < mostAgainst) {
      mostAgainst = d;
      incident = i;
    }
  }
  const v1 = vr[face];
  const v2 = vr[(face + 1) % 4];
  const tx = v2.x - v1.x;
  const ty = v2.y - v1.y;
  const length = Math.hypot(tx, ty);
  const t = { x: tx / length, y: ty / length };
  const e1 = vi[incident];
  const e2 = vi[(incident + 1) % 4];
  let points = [e1, e2];
  // Clip the incident face to the reference face's ends.
  points = clip(points, { x: -t.x, y: -t.y }, -(t.x * v1.x + t.y * v1.y));
  if (points.length < 2) return null;
  points = clip(points, t, t.x * v2.x + t.y * v2.y);
  if (points.length < 2) return null;

  const front = n.x * v1.x + n.y * v1.y;
  // A point is known by the faces that made it and which end of the incident face it is
  // nearer, which stays the same while one face rests on another.
  const middle = (t.x * (e1.x + e2.x) + t.y * (e1.y + e2.y)) / 2;
  const out = [];
  for (const p of points) {
    const sep = n.x * p.x + n.y * p.y - front;
    if (sep > PHYSICS.margin) continue;
    const end = t.x * p.x + t.y * p.y < middle ? 0 : 1;
    out.push({ px: p.x, py: p.y, sep, key: `${flip ? 'b' : 'a'}${face}:${incident}:${end}`, pn: 0, pt: 0 });
  }
  if (!out.length) return null;
  out.sort((p, q) => (p.key < q.key ? -1 : 1));
  return flip ? { nx: -n.x, ny: -n.y, points: out } : { nx: n.x, ny: n.y, points: out };
}

/** Keeps the part of a two-point segment where dot(normal, p) <= offset. */
function clip(points, normal, offset) {
  const [p, q] = points;
  const dp = normal.x * p.x + normal.y * p.y - offset;
  const dq = normal.x * q.x + normal.y * q.y - offset;
  const out = [];
  if (dp <= 0) out.push(p);
  if (dq <= 0) out.push(q);
  if (dp * dq < 0) {
    const f = dp / (dp - dq);
    out.push({ x: p.x + f * (q.x - p.x), y: p.y + f * (q.y - p.y) });
  }
  return out;
}

function boxCircle(box, circle) {
  const c = Math.cos(box.a);
  const s = Math.sin(box.a);
  const dx = circle.x - box.x;
  const dy = circle.y - box.y;
  const lx = c * dx + s * dy;
  const ly = -s * dx + c * dy;
  const hw = box.w / 2;
  const hh = box.h / 2;
  const qx = Math.max(-hw, Math.min(hw, lx));
  const qy = Math.max(-hh, Math.min(hh, ly));
  let nlx;
  let nly;
  let sep;
  let key;
  if (qx === lx && qy === ly) {
    // The centre is inside: out through the nearest face.
    const ex = hw - Math.abs(lx);
    const ey = hh - Math.abs(ly);
    if (ex < ey) {
      nlx = Math.sign(lx) || 1;
      nly = 0;
      sep = -ex - circle.r;
    } else {
      nlx = 0;
      nly = Math.sign(ly) || 1;
      sep = -ey - circle.r;
    }
    key = 'in';
  } else {
    const ox = lx - qx;
    const oy = ly - qy;
    const d = Math.hypot(ox, oy);
    sep = d - circle.r;
    if (sep > PHYSICS.margin) return null;
    nlx = ox / d;
    nly = oy / d;
    key = 'out';
  }
  const nx = c * nlx - s * nly;
  const ny = s * nlx + c * nly;
  return {
    nx, ny,
    points: [{ px: circle.x - nx * circle.r, py: circle.y - ny * circle.r, sep, key, pn: 0, pt: 0 }],
  };
}

function circleCircle(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const sep = d - a.r - b.r;
  if (sep > PHYSICS.margin) return null;
  const nx = d > 1e-9 ? dx / d : 0;
  const ny = d > 1e-9 ? dy / d : 1;
  return { nx, ny, points: [{ px: a.x + nx * (a.r + sep / 2), py: a.y + ny * (a.r + sep / 2), sep, key: 'cc', pn: 0, pt: 0 }] };
}

// ---- Solver -----------------------------------------------------------------

function preStep(m, invDt) {
  const { a, b, nx, ny } = m;
  const tx = ny;
  const ty = -nx;
  m.friction = Math.sqrt(a.friction * b.friction);
  m.rolls = [a, b].filter((body) => body.shape === 'circle' && body.awake);
  const restitution = Math.max(a.restitution, b.restitution);
  for (const p of m.points) {
    const rax = p.px - a.x;
    const ray = p.py - a.y;
    const rbx = p.px - b.x;
    const rby = p.py - b.y;
    const rna = rax * ny - ray * nx;
    const rnb = rbx * ny - rby * nx;
    const rta = rax * ty - ray * tx;
    const rtb = rbx * ty - rby * tx;
    const ia = a.awake ? 1 : 0;
    const ib = b.awake ? 1 : 0;
    const kn = ia * (a.invM + a.invI * rna * rna) + ib * (b.invM + b.invI * rnb * rnb);
    const kt = ia * (a.invM + a.invI * rta * rta) + ib * (b.invM + b.invI * rtb * rtb);
    p.rax = rax;
    p.ray = ray;
    p.rbx = rbx;
    p.rby = rby;
    p.massN = kn > 0 ? 1 / kn : 0;
    p.massT = kt > 0 ? 1 / kt : 0;
    p.pr = 0;
    p.warm = p.pn;
    const vn = normalSpeed(a, b, p, nx, ny);
    if (p.sep > 0) {
      // Not touching yet: it may close the gap this step, but no faster.
      p.bias = -p.sep * invDt;
    } else {
      p.bias = PHYSICS.baumgarte * invDt * Math.max(0, -p.sep - PHYSICS.slop);
      if (vn < -PHYSICS.bounceSpeed) p.bias = Math.max(p.bias, -restitution * vn);
    }
  }
}

/** Last step's impulses, applied straight away (after every contact has measured how fast it closes). */
function warmStart(m) {
  const { a, b, nx, ny } = m;
  for (const p of m.points) push(a, b, p, p.pn * nx + p.pt * ny, p.pn * ny - p.pt * nx);
}

function solve(m) {
  const { a, b, nx, ny } = m;
  const tx = ny;
  const ty = -nx;
  for (const p of m.points) {
    const vn = normalSpeed(a, b, p, nx, ny);
    const was = p.pn;
    p.pn = Math.max(was + p.massN * (p.bias - vn), 0);
    const dn = p.pn - was;
    push(a, b, p, dn * nx, dn * ny);

    const vt = normalSpeed(a, b, p, tx, ty);
    const limit = m.friction * p.pn;
    const wasT = p.pt;
    p.pt = Math.max(-limit, Math.min(limit, wasT - p.massT * vt));
    const dt = p.pt - wasT;
    push(a, b, p, dt * tx, dt * ty);

    // Rolling resistance: a ball resists turning, up to its share of the load.
    for (const body of m.rolls) {
      const limit = PHYSICS.rollingResistance * p.pn * body.r;
      const wasR = p.pr;
      p.pr = Math.max(-limit, Math.min(limit, wasR - body.va / body.invI));
      body.va += (p.pr - wasR) * body.invI;
    }
  }
}

/** How fast b's point moves away from a's along (nx, ny). */
function normalSpeed(a, b, p, nx, ny) {
  const vax = a.awake ? a.vx - a.va * p.ray : 0;
  const vay = a.awake ? a.vy + a.va * p.rax : 0;
  const vbx = b.awake ? b.vx - b.va * p.rby : 0;
  const vby = b.awake ? b.vy + b.va * p.rbx : 0;
  return (vbx - vax) * nx + (vby - vay) * ny;
}

/** Pushes b by (jx, jy) at the contact point, and a the other way. */
function push(a, b, p, jx, jy) {
  if (a.awake) {
    a.vx -= jx * a.invM;
    a.vy -= jy * a.invM;
    a.va -= a.invI * (p.rax * jy - p.ray * jx);
  }
  if (b.awake) {
    b.vx += jx * b.invM;
    b.vy += jy * b.invM;
    b.va += b.invI * (p.rbx * jy - p.rby * jx);
  }
}
