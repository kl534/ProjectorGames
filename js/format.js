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
 * A camera mode in Setup's list of modes: "640 × 480, 120 frames a second – narrower view".
 * @param {import('./camera.js').MeasuredMode} measured
 */
export function modeOptionText({ mode, fps, whole }) {
  return `${cameraModeText(mode.width, mode.height, fps)}${whole ? '' : ' – narrower view'}`;
}

/**
 * An exposure time for Setup: "7.8 ms (1/128 s)", or "0.5 s".
 * @param {number} time exposureTime, in units of 100 µs
 */
export function exposureText(time) {
  const seconds = time / 10000;
  if (!(seconds > 0)) return '';
  if (seconds >= 0.5) return `${Math.round(seconds * 10) / 10} s`;
  const ms = seconds * 1000;
  const shown = ms < 1 ? ms.toFixed(2) : ms < 10 ? ms.toFixed(1) : String(Math.round(ms));
  return `${shown} ms (1/${Math.round(1 / seconds)} s)`;
}

/**
 * Whether the calibration was made in a different camera mode than the one
 * running now, for the setup screen: games run in the calibrated mode.
 * @param {import('./storage.js').CameraCalibration|null|undefined} calibration
 * @param {string|null} cameraId the camera running now
 * @param {import('./camera.js').CameraMode|null} mode the mode it is running in, if known
 */
export function calibratedInOtherMode(calibration, cameraId, mode) {
  if (!calibration || !mode || calibration.cameraId !== cameraId) return false;
  const was = calibration.cameraMode;
  return !was || was.width !== mode.width || was.height !== mode.height || was.frameRate !== mode.frameRate;
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
    const lensFrom = {
      wall: 'from the wall’s tilt', refined: 'refined from throws', assumed: 'assumed: it faces the wall square on',
    }[model.focalFrom] ?? 'assumed: it faces the wall square on';
    parts.push(`lens ${Math.round(model.fovDeg)}° across (${lensFrom})`);
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
  // A hit that was seen but isn't one (a person walking by): why not.
  if (seen.dropped) lines.push(`Not counted as a hit: ${seen.dropped}`);
  if (seen.reported?.launch) lines.push(launchText(seen.reported.launch, screenWidthFt));
  return lines;
}

/**
 * What refining the lenses did, for Ball Test's data: "Lenses refined: main 95°, second 80° · flights now fit
 * within 0.006 screen widths (1 in) (was 0.020)", or, not applied, that they were left as they were.
 * @param {{fovDeg: number[], rms: number, before: number}|null} result refineLenses's
 * @param {number|null} screenWidthFt
 * @param {boolean} [applied] whether the lenses were changed
 */
export function lensText(result, screenWidthFt, applied = true) {
  if (!result) return 'No flights both cameras followed to fit the lenses to: left as they were';
  if (!applied) return `The lenses already fit these flights (within ${distance(result.before, screenWidthFt, 3)}): left as they were`;
  const [main, second] = result.fovDeg.map((f) => `${Number(f.toFixed(1))}°`);
  return `Lenses refined: main ${main}, second ${second} · flights now fit within ${distance(result.rms, screenWidthFt, 3)}`
    + ` (was ${result.before.toFixed(3)})`;
}

/**
 * How a ball left the bat, for Ball Test's data: "Off the bat: 62.0 mph · launch 14° · 3° left ·
 * 1.12 screen widths (11.2 ft) from the wall · toss and hit met within 0.012 screen widths (1 in)".
 * @param {import('./throw-tracker.js').Launch} launch @param {number|null} screenWidthFt
 */
export function launchText(launch, screenWidthFt) {
  const across = Math.round(launch.azimuth);
  return [
    `Off the bat: ${speed(launch.speed, screenWidthFt)}`,
    `launch ${Math.round(launch.elevation)}°`,
    across === 0 ? 'straight at the wall' : `${Math.abs(across)}° ${across > 0 ? 'right' : 'left'}`,
    `${distance(-launch.point.z, screenWidthFt)} from the wall`,
    launch.from === 'contact' ? `toss and hit met within ${distance(launch.gap, screenWidthFt, 3)}` : 'from where it was first seen off the bat',
  ].join(' · ');
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

/**
 * How a swing left the tee, as Gap Shot shows it under the call: "74 mph · launch 18° · spray 12° right".
 * The speed only if it was measured.
 * @param {{mph?: number|null, launch: number, spray: number}} swing angles in radians: launch up from level,
 *   spray from straight out to centre field, + towards first base (the right of the screen)
 */
export function swingText({ mph = null, launch, spray }) {
  const degrees = (r) => Math.round((r * 180) / Math.PI);
  const across = degrees(spray);
  const parts = [];
  if (Number.isFinite(mph)) parts.push(mphText(mph));
  parts.push(`launch ${degrees(launch)}°`);
  parts.push(across === 0 ? 'spray 0°' : `spray ${Math.abs(across)}° ${across > 0 ? 'right' : 'left'}`);
  return parts.join(' · ');
}
