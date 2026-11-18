// Gap Shot's ball: flight with gravity, air drag and a little backspin lift, bounces
// and rolling on the ground, and the outfield fence. Kept free of the browser so
// it can be unit-tested, and fully deterministic: the same hit always follows the
// same path.
//
// Field positions are in feet, as in fielders-choice-logic.js: home plate at the
// origin, +y out to centre field, +x towards first base, z up. Angles are in
// radians: the spray angle is measured from straight out to centre field (+ towards
// first base), the launch angle from level (+ upwards).

/**
 * @typedef {{x:number, y:number, z:number}} Point3
 * @typedef {object} Fence the wall the ball must clear to be a home run
 * @property {(deg:number) => number} radiusAt how far from home plate the fence is, `deg` degrees from centre field
 * @property {number} height feet
 *
 * @typedef {object} Sample where the ball is at a moment, and how fast it goes
 * @property {number} t seconds since contact
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} vx
 * @property {number} vy
 * @property {number} vz
 * @property {boolean} air off the ground (and clear of it by more than a hop's height)
 */

export const PHYSICS = {
  gravity: 32.174, // ft/s²
  // Air drag: a = -drag × |v| × v. Near what a baseball's size and weight give (drag coefficient about 0.3).
  drag: 0.00165,
  // Backspin lift: an upward push at right angles to the flight, lift × |v|². Tuned so a ball hit at 100 mph and 28 degrees goes about 430 feet.
  lift: 0.00095,
  bounce: 0.46, // the fraction of the downward speed a bounce keeps
  scrub: 0.84, // the fraction of the speed along the ground a bounce keeps
  rollBelow: 5, // ft/s: a bounce this slow becomes a roll
  roll: 8, // ft/s²: the ground slowing a rolling ball
  stopBelow: 0.6, // ft/s: a rolling ball this slow has stopped
  wallBounce: 0.38, // the fraction of the speed into the fence a bounce off it keeps
  wallScrub: 0.9, // …and of the speed along it
  step: 1 / 240, // seconds: the size of each step of the simulation
  sampleEvery: 2, // steps between the samples kept (so 120 a second)
  maxTime: 16, // seconds: a ball still moving after this is taken to have stopped
  tee: { x: 0, y: 1.5, z: 2.9 }, // the ball on the tee
};

const DEG = Math.PI / 180;

/** Miles an hour as feet a second. */
export function mphToFps(mph) {
  return (mph * 5280) / 3600;
}

/**
 * The ball's velocity as it leaves the bat.
 * @param {number} speed ft/s
 * @param {number} spray radians, + towards first base
 * @param {number} launch radians, + upwards
 */
export function launchVelocity(speed, spray, launch) {
  const flat = Math.cos(launch) * speed;
  return { vx: Math.sin(spray) * flat, vy: Math.cos(spray) * flat, vz: Math.sin(launch) * speed };
}

/** Whether a spot on the ground is in fair territory (between the foul lines). */
export function isFair(x, y) {
  return y >= Math.abs(x);
}

/** The angle (degrees) a spot is from straight out to centre field, + towards first base. */
export function sprayDegrees(x, y) {
  return Math.atan2(x, y) / DEG;
}

/** The fence, at 45 degrees either side of centre (the foul lines) and beyond, taken as the distance on the line. */
function fenceAt(fence, x, y) {
  const deg = sprayDegrees(x, y);
  return fence.radiusAt(Math.max(-45, Math.min(45, deg)));
}

/**
 * Follows a batted ball from the tee until it stops, goes over the fence or leaves the park.
 * @param {object} hit
 * @param {number} hit.speed ft/s off the bat
 * @param {number} hit.spray radians
 * @param {number} hit.launch radians
 * @param {Fence} fence
 * @param {object} [rules]
 * @returns {{
 *   samples: Sample[],
 *   firstGround: {t:number, x:number, y:number}|null,
 *   bounces: {t:number, x:number, y:number}[],
 *   overFence: {t:number, x:number, y:number, z:number}|null,
 *   wallHits: {t:number, x:number, y:number}[],
 *   end: Sample,
 * }}
 */
export function simulateBall(hit, fence, rules = PHYSICS) {
  const dt = rules.step;
  let { x, y, z } = rules.tee;
  let { vx, vy, vz } = launchVelocity(hit.speed, hit.spray, hit.launch);
  let t = 0;
  let rolling = false;
  let step = 0;
  const samples = [];
  const bounces = [];
  const wallHits = [];
  let firstGround = null;
  let overFence = null;
  let touched = false; // has been on the ground
  const keep = (air) => samples.push({ t, x, y, z, vx, vy, vz, air });
  keep(true);

  while (t < rules.maxTime) {
    step++;
    t += dt;
    if (rolling) {
      // On the ground: slowed by the grass.
      const speed = Math.hypot(vx, vy);
      const slow = Math.max(0, speed - rules.roll * dt);
      if (slow < rules.stopBelow) {
        vx = 0;
        vy = 0;
        keep(false);
        break;
      }
      vx *= slow / speed;
      vy *= slow / speed;
      x += vx * dt;
      y += vy * dt;
    } else {
      const speed = Math.hypot(vx, vy, vz);
      // Drag, against the flight; lift, at right angles to it in the vertical plane, upwards.
      let ax = -rules.drag * speed * vx;
      let ay = -rules.drag * speed * vy;
      let az = -rules.gravity - rules.drag * speed * vz;
      const flat = Math.hypot(vx, vy);
      if (flat > 1e-6 && speed > 1e-6) {
        // The unit vector at right angles to v, in the plane of v and straight up, pointing up.
        const nz = flat / speed;
        const nh = -vz / speed / flat;
        ax += rules.lift * speed * speed * nh * vx;
        ay += rules.lift * speed * speed * nh * vy;
        az += rules.lift * speed * speed * nz;
      }
      vx += ax * dt;
      vy += ay * dt;
      vz += az * dt;
      x += vx * dt;
      y += vy * dt;
      z += vz * dt;
    }

    // The fence, in fair territory: over it for a home run, or off it back into play.
    if (isFair(x, y)) {
      const r = Math.hypot(x, y);
      const wall = fenceAt(fence, x, y);
      if (r >= wall && (x * vx + y * vy) > 0) {
        if (!touched && !rolling && z >= fence.height) {
          overFence = { t, x, y, z };
          keep(true);
          break;
        }
        wallHits.push({ t, x, y });
        const nx = x / r;
        const ny = y / r;
        const into = vx * nx + vy * ny;
        const tx = vx - into * nx;
        const ty = vy - into * ny;
        vx = -into * rules.wallBounce * nx + tx * rules.wallScrub;
        vy = -into * rules.wallBounce * ny + ty * rules.wallScrub;
        x = nx * (wall - 0.05);
        y = ny * (wall - 0.05);
      }
    } else if (Math.hypot(x, y) > 420) {
      // Gone, in foul territory, into the stands.
      keep(true);
      break;
    }

    if (!rolling && z <= 0) {
      z = 0;
      touched = true;
      const hop = { t, x, y };
      firstGround ??= hop;
      bounces.push(hop);
      if (-vz * rules.bounce < rules.rollBelow) {
        rolling = true;
        vz = 0;
      } else {
        vz = -vz * rules.bounce;
        vx *= rules.scrub;
        vy *= rules.scrub;
      }
    }
    if (step % rules.sampleEvery === 0) keep(!rolling && z > 0);
  }
  const last = samples[samples.length - 1];
  if (last.t < t - 1e-9) keep(!rolling && z > 0);
  return { samples, firstGround, bounces, overFence, wallHits, end: samples[samples.length - 1] };
}

/** Where the ball is at `t`, between the samples (and still, once the last is past). */
export function ballAt(samples, t) {
  const n = samples.length;
  if (t <= samples[0].t) return { ...samples[0] };
  if (t >= samples[n - 1].t) return { ...samples[n - 1] };
  // The samples are evenly spaced but for the last, so start near where `t` should be.
  const dt = samples[1].t - samples[0].t;
  let i = Math.min(n - 2, Math.max(0, Math.floor(t / dt)));
  while (i > 0 && samples[i].t > t) i--;
  while (i < n - 2 && samples[i + 1].t < t) i++;
  const a = samples[i];
  const b = samples[i + 1];
  const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  const lerp = (p, q) => p + (q - p) * u;
  return {
    t, x: lerp(a.x, b.x), y: lerp(a.y, b.y), z: lerp(a.z, b.z), vx: lerp(a.vx, b.vx), vy: lerp(a.vy, b.vy), vz: lerp(a.vz, b.vz), air: a.air && b.air,
  };
}
