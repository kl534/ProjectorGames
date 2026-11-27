// Batter Up's drawing over the 3D picture, flat on the screen: the ball's tracer, the
// way television shows a hit (a glowing line from the bat to the ball, with the ball
// lit at its head), and the fireworks for a home run (rockets, then bursts of sparks
// that streak, droop and fade). What to draw comes from gap-shot-scene.js; this only
// paints it, on 2D canvases.

import { burstAt } from './gap-shot-scene.js';

/**
 * Draws the tracer (see tracerFor) through `camera` on `ctx`: a soft wide glow under a bright core, both
 * thickening from the bat to the ball, and while the ball is still flying, a glow round it.
 * @param {CanvasRenderingContext2D} ctx
 * @param {ReturnType<import('./fielders-choice-logic.js').makeCamera>} camera
 * @param {ReturnType<import('./gap-shot-scene.js').tracerFor>} tracer
 */
export function drawTracer(ctx, camera, tracer) {
  if (!tracer) return;
  const { width: W, height: H } = ctx.canvas;
  const pts = tracer.points.map((p) => camera.project(p));
  const n = pts.length;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'lighter';
  for (const [width, colour, alpha] of [[0.014, '255, 176, 64', 0.22], [0.0045, '255, 236, 190', 0.85]]) {
    for (let i = 1; i < n; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (!a || !b) continue;
      const k = i / (n - 1);
      ctx.strokeStyle = `rgba(${colour}, ${alpha * tracer.alpha * (0.15 + 0.85 * k)})`;
      ctx.lineWidth = Math.max(1, width * H * (0.35 + 0.65 * k));
      ctx.beginPath();
      ctx.moveTo(a.x * W, a.y * H);
      ctx.lineTo(b.x * W, b.y * H);
      ctx.stroke();
    }
  }
  const head = pts[n - 1];
  if (tracer.flying && head) {
    const r = H * 0.03;
    const glow = ctx.createRadialGradient(head.x * W, head.y * H, 0, head.x * W, head.y * H, r);
    glow.addColorStop(0, 'rgba(255, 244, 214, 0.55)');
    glow.addColorStop(0.4, 'rgba(255, 196, 96, 0.18)');
    glow.addColorStop(1, 'rgba(255, 196, 96, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(head.x * W - r, head.y * H - r, r * 2, r * 2);
  }
  ctx.restore();
}

/**
 * Fireworks over the stands (see fireworksFor and burstAt): each rocket's climb, the flash as it bursts, and
 * its sparks as streaks of light.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number, y:number, at:number, colour:string, second?:string, kind?:string}[]} bursts
 * @param {number} now ms
 */
export function drawFireworks(ctx, bursts, now) {
  const { width: W, height: H } = ctx.canvas;
  const aspect = W / H;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (const burst of bursts) {
    const { rocket, flash, sparks } = burstAt(burst, now, aspect);
    if (rocket) {
      const trail = ctx.createLinearGradient(rocket.x * W, rocket.y * H, rocket.x * W, (rocket.y + 0.12) * H);
      trail.addColorStop(0, `rgba(255, 226, 170, ${rocket.alpha})`);
      trail.addColorStop(1, 'rgba(255, 226, 170, 0)');
      ctx.strokeStyle = trail;
      ctx.lineWidth = Math.max(1.5, H * 0.004);
      ctx.beginPath();
      ctx.moveTo(rocket.x * W, rocket.y * H);
      ctx.lineTo(rocket.x * W, (rocket.y + 0.12) * H);
      ctx.stroke();
    }
    if (flash > 0) {
      const r = H * 0.09;
      const g = ctx.createRadialGradient(burst.x * W, burst.y * H, 0, burst.x * W, burst.y * H, r);
      g.addColorStop(0, `rgba(255, 246, 220, ${0.7 * flash})`);
      g.addColorStop(1, 'rgba(255, 246, 220, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(burst.x * W - r, burst.y * H - r, r * 2, r * 2);
    }
    // Each spark: a soft wide streak of its colour, a thinner one over it, and a white-hot head.
    for (const [width, alpha] of [[0.009, 0.3], [0.0035, 1]]) {
      ctx.lineWidth = Math.max(1.5, H * width);
      for (const s of sparks) {
        ctx.strokeStyle = s.colour;
        let from = s;
        s.tail.forEach((p, k) => {
          ctx.globalAlpha = s.alpha * alpha * (1 - k / s.tail.length);
          ctx.beginPath();
          ctx.moveTo(from.x * W, from.y * H);
          ctx.lineTo(p.x * W, p.y * H);
          ctx.stroke();
          from = p;
        });
      }
    }
    ctx.fillStyle = '#fff6e0';
    const head = Math.max(1, H * 0.0025);
    for (const s of sparks) {
      ctx.globalAlpha = s.alpha;
      ctx.fillRect(s.x * W - head, s.y * H - head, head * 2, head * 2);
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}
