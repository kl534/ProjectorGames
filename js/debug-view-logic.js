// The sums behind the debug view (debug.html, js/debug-view.js): how a path
// the camera is following is moving, and the numbers in its tables. No browser
// code, unit tested.

// A path's speed is measured over at least this long (ms), so one frame's jitter doesn't swamp it.
const SPEED_SPAN_MS = 20;

/**
 * How a path in the camera picture is moving at its newest point.
 * @param {{x: number, y: number, t: number}[]} points normalised camera coords (x across, y down, both 0–1 of the
 *   picture's width and height), t in ms
 * @param {number} aspect the picture's height / width, so y is measured in the same units as x
 * @returns {{points: number, durationMs: number, length: number, speed: number|null, angleDeg: number|null,
 *   x: number, y: number}|null} length: along the path, and speed: picture widths (a second); angleDeg: the way
 *   it is going, 0 to the right, 90 down
 */
export function pathMotion(points, aspect) {
  if (!points.length) return null;
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, (points[i].y - points[i - 1].y) * aspect);
  }
  const last = points.at(-1);
  let from = points.length - 2;
  while (from > 0 && last.t - points[from].t < SPEED_SPAN_MS) from--;
  const first = points[Math.max(0, from)];
  const dt = (last.t - first.t) / 1000;
  const dx = last.x - first.x;
  const dy = (last.y - first.y) * aspect;
  const moving = points.length > 1 && dt > 0;
  return {
    points: points.length,
    durationMs: last.t - points[0].t,
    length,
    speed: moving ? Math.hypot(dx, dy) / dt : null,
    angleDeg: moving && (dx || dy) ? (Math.atan2(dy, dx) * 180) / Math.PI : null,
    x: last.x,
    y: last.y,
  };
}

/**
 * A number for a table: fixed decimals, or a dash where there is none.
 * @param {number|null|undefined} value
 * @param {number} [decimals]
 * @param {string} [unit] put after it, with a space
 */
export function num(value, decimals = 2, unit = '') {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  return `${value.toFixed(decimals)}${unit ? ` ${unit}` : ''}`;
}

/**
 * Picture widths a second as miles an hour, on a wall `screenWidthFt` wide (a rough figure for a camera's own
 * picture: its width is roughly the screen's).
 */
export function widthsToMph(widthsPerSecond, screenWidthFt) {
  if (!Number.isFinite(widthsPerSecond) || !(screenWidthFt > 0)) return null;
  return (widthsPerSecond * screenWidthFt * 3600) / 5280;
}

/**
 * The lines of a throw's summary: each camera's verdict and what both cameras made of its flight.
 * @param {object} seen a ThrowSeen (throw-tracker.js), as sent by the game
 */
export function throwSummary(seen) {
  const tracks = (seen.tracks ?? []).map((t) => `cam ${t.camera}: ${t.verdict} (${t.points?.length ?? 0} pts, ${num(t.durationMs, 0)} ms, top ${num(t.topSpeed, 2)} w/s)`);
  const flight = seen.room?.flight;
  const room = flight ? `room: speed ${num(flight.speed, 2)} w/s, toward wall ${num(flight.towardWall, 2)} w/s, gap ${num(flight.meanGap, 4)}, ${flight.points ?? 0} pts`
    : null;
  return [...tracks, room, seen.dropped ? `dropped: ${seen.dropped}` : null].filter(Boolean);
}
