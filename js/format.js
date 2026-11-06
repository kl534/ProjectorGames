// User-facing text that depends on state.

/** Feet a second in miles an hour. */
const FPS_TO_MPH = 3600 / 5280;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "25 Oct 2026" in the computer's local time zone. */
export function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Status line for the setup screen.
 * @param {import('./storage.js').Calibration|null} calibration
 * @param {string|null} currentCameraId camera in use right now, or null if none
 */
export function calibrationStatus(calibration, currentCameraId) {
  if (!calibration) return 'Not calibrated';
  let text = `Calibrated on ${formatDate(calibration.createdAt)}`;
  if (currentCameraId && calibration.cameraId !== currentCameraId) {
    text += ' (calibrated with a different camera)';
  }
  return text;
}

/**
 * The camera's mode, for the setup screen: "320 × 240, 120 frames a second".
 * @param {number|null} fps measured frames a second, or null if not known
 */
export function cameraModeText(width, height, fps) {
  const size = `${width} × ${height}`;
  return fps ? `${size}, ${Math.round(fps)} frames a second` : size;
}

/**
 * Which calibrated cameras there are, for the setup screen: '' with one camera.
 * @param {import('./storage.js').Calibration|null} calibration
 * @param {string|null} secondCameraId the second camera chosen now, or null for none
 */
export function secondCameraStatus(calibration, secondCameraId) {
  if (!secondCameraId) return calibration?.second ? 'Second camera calibrated, but not chosen now' : '';
  if (!calibration) return '';
  if (!calibration.second) return 'Second camera not calibrated yet – press Calibrate';
  if (calibration.second.cameraId !== secondCameraId) return 'Second camera: calibrated with a different camera';
  return 'Second camera calibrated too';
}

const CAMERA_NAMES = ['Main', 'Second'];

/** A screen position, normalised, as "(0.41, 0.62)". */
function spot(p) {
  return `(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`;
}

/** A distance in screen widths, in feet (or inches) too if the screen's width is known: "0.84 screen widths (6.7 ft)". */
function distance(widths, screenWidthFt, digits = 2) {
  if (!screenWidthFt) return `${widths.toFixed(digits)} screen widths`;
  const ft = widths * screenWidthFt;
  return `${widths.toFixed(digits)} screen widths (${Math.abs(ft) < 1 ? `${Math.round(ft * 12)} in` : `${ft.toFixed(1)} ft`})`;
}

/** A speed in screen widths a second, as miles an hour if the screen's width is known. */
function speed(perSecond, screenWidthFt) {
  return screenWidthFt ? `${(perSecond * screenWidthFt * FPS_TO_MPH).toFixed(1)} mph` : `${perSecond.toFixed(1)} screen widths/s`;
}

/**
 * One camera, for Ball Test's data: what it is, how fast, and where it seems to be.
 * @param {ReturnType<import('./throw-camera.js').ThrowCamera['cameraInfo']>[number]} info
 * @param {number|null} screenWidthFt
 */
export function cameraSummary(info, screenWidthFt) {
  const parts = [`${CAMERA_NAMES[info.camera]} camera: ${info.label || 'camera'}`];
  if (info.width) parts.push(`${info.width} × ${info.height}`);
  parts.push(`${info.fps} fps`, `delay ${Math.round(info.latencyMs)} ms`);
  const { model } = info;
  if (model) {
    parts.push(`${distance(model.distance, screenWidthFt, 1)} from the wall, ${Math.round(model.angleDeg)}° from square on`);
    parts.push(`lens ${Math.round(model.fovDeg)}° across (${model.focalFrom === 'wall' ? 'from the wall’s tilt' : 'assumed: it faces the wall square on'})`);
    if (model.mirrored) parts.push('picture mirrored');
  }
  if (info.blips) parts.push(`${info.blips} single-frame blips`);
  return parts.join(' · ');
}

/**
 * One throw, for Ball Test's data: what each camera saw and, where both saw it, its flight.
 * @param {import('./throw-tracker.js').ThrowSeen} seen
 * @param {number|null} screenWidthFt
 * @returns {string[]} a line for each camera's paths, then one for its flight through the room
 */
export function throwSummary(seen, screenWidthFt) {
  const lines = [];
  for (const camera of [0, 1]) {
    const tracks = seen.tracks.filter((t) => t.camera === camera);
    if (!tracks.length) continue;
    const frames = tracks.reduce((n, t) => n + t.points.length, 0);
    const ms = Math.round(tracks.reduce((n, t) => n + t.durationMs, 0));
    const top = Math.max(...tracks.map((t) => t.topSpeed));
    const pieces = tracks.length > 1 ? ` in ${tracks.length} pieces` : '';
    const hit = tracks.find((t) => t.hit);
    // Without a hit, how the longest piece ended says most.
    const longest = tracks.reduce((a, b) => (b.points.length > a.points.length ? b : a));
    const verdict = hit ? `hit ${spot(hit.hit)}` : longest.verdict;
    lines.push(`${CAMERA_NAMES[camera]}: ${frames} frames${pieces} over ${ms} ms, up to ${top.toFixed(1)} picture widths/s · ${verdict}`);
  }
  const flight = seen.room?.flight;
  if (flight) {
    const parts = [`In the room: ${flight.points} points`];
    if (flight.speed !== null) parts.push(`${speed(flight.speed, screenWidthFt)} (${speed(flight.towardWall, screenWidthFt)} toward the wall)`);
    parts.push(`closest ${distance(-flight.closest.z, screenWidthFt)} from the wall`);
    if (flight.hit) parts.push(`meets the wall at ${spot(flight.hit)}`);
    parts.push(`cameras agree within ${distance(flight.meanGap, screenWidthFt, 3)}`);
    lines.push(parts.join(' · '));
  } else if (seen.tracks.some((t) => t.camera === 1) !== seen.tracks.some((t) => t.camera === 0)) {
    lines.push('Seen by one camera only');
  }
  return lines;
}

/**
 * A hit's speed, for its mark: "16 mph", or in screen widths a second without the screen's width,
 * or '' where it isn't known (only one camera followed the ball in).
 * @param {Partial<import('./throw-tracker.js').Hit>} hit
 */
export function hitSpeedText(hit) {
  if (Number.isFinite(hit.speedMph)) return mphText(hit.speedMph);
  if (Number.isFinite(hit.speed)) return `${hit.speed.toFixed(1)} screens/s`;
  return '';
}

/** A speed in miles an hour as the games show it: "87 mph". */
export function mphText(mph) {
  return `${Math.round(mph)} mph`;
}
