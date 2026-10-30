// User-facing text that depends on state.

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
