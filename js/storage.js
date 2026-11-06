// Settings remembered by this browser on this computer (localStorage).

export const STORAGE_KEY = 'projectorGames.settings';
const VERSION = 1;
// A foot in metres, for a screen width saved in metres by an older version.
const METRES_PER_FOOT = 0.3048;

/**
 * @typedef {{x:number, y:number}} Point
 * @typedef {object} CameraCalibration where the projected screen is in one camera's picture
 * @property {string|null} cameraId deviceId of the camera used
 * @property {string} cameraLabel human-readable camera name
 * @property {number} videoWidth camera resolution at calibration time
 * @property {number} videoHeight
 * @property {Point[]} markersCamera marker centres found, normalised camera coords (TL, TR, BR, BL)
 * @property {Point[]} markersScreen the same marker centres, normalised screen coords
 * @property {Point[]} screenCornersCamera projected-screen corners, normalised camera coords (TL, TR, BR, BL)
 * @property {number[]} cameraToScreen homography: normalised camera coords -> normalised screen coords
 * @property {number} [latencyMs] how long the camera takes to see a change on screen (missing in older calibrations)
 * @property {'capture'} [frameClock] 'capture': latencyMs runs to when the camera took the frame showing the
 *   change, so the games time frames the same way. Missing: to when the frame reached the page.
 * @property {import('./camera.js').CameraMode} [cameraMode] the camera mode used, which the games use
 *   too (missing in older calibrations, made in whatever mode the browser picked)
 *
 * @typedef {CameraCalibration & {createdAt: string, screenAspect?: number, second?: CameraCalibration}} Calibration
 *   the main camera's calibration, plus: createdAt, an ISO timestamp; screenAspect, the projected screen's
 *   height / width (missing in older calibrations); second, the second camera's, if one was calibrated with it
 *
 * @typedef {object} Settings
 * @property {string|null} cameraId
 * @property {string} cameraLabel
 * @property {string|null} secondCameraId the second camera chosen in Setup, or null for none
 * @property {string} secondCameraLabel
 * @property {number|null} screenWidthFt how wide the projected screen is (feet), for ball speeds; null if not given
 * @property {Calibration|null} calibration
 */

/** @returns {Settings} */
export function defaultSettings() {
  return {
    cameraId: null, cameraLabel: '', secondCameraId: null, secondCameraLabel: '', screenWidthFt: null, calibration: null,
  };
}

/** Reads settings, falling back to defaults for anything missing or corrupt. */
export function loadSettings(storage = globalThis.localStorage) {
  const settings = defaultSettings();
  let parsed;
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return settings;
    parsed = JSON.parse(raw);
  } catch {
    return settings;
  }
  if (!parsed || typeof parsed !== 'object') return settings;
  if (typeof parsed.cameraId === 'string' && parsed.cameraId) settings.cameraId = parsed.cameraId;
  if (typeof parsed.cameraLabel === 'string') settings.cameraLabel = parsed.cameraLabel;
  if (typeof parsed.secondCameraId === 'string' && parsed.secondCameraId) settings.secondCameraId = parsed.secondCameraId;
  if (typeof parsed.secondCameraLabel === 'string') settings.secondCameraLabel = parsed.secondCameraLabel;
  if (Number.isFinite(parsed.screenWidthFt) && parsed.screenWidthFt > 0) settings.screenWidthFt = parsed.screenWidthFt;
  // Saved in metres before it was asked for in feet.
  else if (Number.isFinite(parsed.screenWidthM) && parsed.screenWidthM > 0) settings.screenWidthFt = parsed.screenWidthM / METRES_PER_FOOT;
  const c = parsed.calibration;
  if (isValidCalibration(c)) settings.calibration = c;
  else if (c && typeof c === 'object' && c.second !== undefined) {
    // A broken second camera's calibration doesn't lose the main camera's.
    const { second, ...main } = c;
    if (isValidCalibration(main)) settings.calibration = main;
  }
  return settings;
}

/** Writes settings. Returns false if the browser refused (e.g. storage blocked). */
export function saveSettings(settings, storage = globalThis.localStorage) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      version: VERSION,
      cameraId: settings.cameraId,
      cameraLabel: settings.cameraLabel,
      secondCameraId: settings.secondCameraId ?? null,
      secondCameraLabel: settings.secondCameraLabel ?? '',
      screenWidthFt: settings.screenWidthFt ?? null,
      calibration: settings.calibration,
    }));
    return true;
  } catch {
    return false;
  }
}

export function isValidCalibration(c) {
  if (!c || typeof c !== 'object') return false;
  if (typeof c.createdAt !== 'string' || Number.isNaN(Date.parse(c.createdAt))) return false;
  if (c.screenAspect !== undefined && !(Number.isFinite(c.screenAspect) && c.screenAspect > 0)) return false;
  if (c.second !== undefined && !isValidCameraCalibration(c.second)) return false;
  return isValidCameraCalibration(c);
}

/** Whether one camera's part of a calibration is complete and sensible. */
export function isValidCameraCalibration(c) {
  if (!c || typeof c !== 'object') return false;
  if (c.cameraId !== null && typeof c.cameraId !== 'string') return false;
  const isPoints = (pts) => Array.isArray(pts) && pts.length === 4
    && pts.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!isPoints(c.markersCamera) || !isPoints(c.markersScreen) || !isPoints(c.screenCornersCamera)) return false;
  if (!Array.isArray(c.cameraToScreen) || c.cameraToScreen.length !== 9
    || !c.cameraToScreen.every(Number.isFinite)) return false;
  if (c.latencyMs !== undefined && !(Number.isFinite(c.latencyMs) && c.latencyMs >= 0)) return false;
  if (c.frameClock !== undefined && c.frameClock !== 'capture') return false;
  if (c.cameraMode !== undefined && !(c.cameraMode && ['width', 'height', 'frameRate']
    .every((k) => Number.isFinite(c.cameraMode[k]) && c.cameraMode[k] > 0))) return false;
  return true;
}

// ---- Best scores ------------------------------------------------------------

export const SCORES_KEY = 'projectorGames.bestScores';

function readScores(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(SCORES_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The best score for a game in this browser, or 0. */
export function loadBestScore(gameId, storage = globalThis.localStorage) {
  const score = readScores(storage)[gameId];
  return Number.isFinite(score) && score > 0 ? score : 0;
}

/**
 * The best score for a game where fewer is better (Fielder's Choice counts runs
 * allowed, and 0 is the best of all), or null if none has been saved yet.
 */
export function loadLowestScore(gameId, storage = globalThis.localStorage) {
  const score = readScores(storage)[gameId];
  return Number.isFinite(score) && score >= 0 ? score : null;
}

/** Stores a game's best score. Returns false if the browser refused. */
export function saveBestScore(gameId, score, storage = globalThis.localStorage) {
  try {
    storage.setItem(SCORES_KEY, JSON.stringify({ ...readScores(storage), [gameId]: score }));
    return true;
  } catch {
    return false;
  }
}

// ---- Kick speeds ------------------------------------------------------------

export const KICK_SPEEDS_KEY = 'projectorGames.kickSpeeds';
// More than this many are never kept, whatever the file says.
const MAX_KICK_SPEEDS = 100;

/**
 * The speeds of the latest kicks Golden Boot measured (screen widths a second, oldest first), or none.
 * Anything that isn't a positive number is dropped.
 * @returns {number[]}
 */
export function loadKickSpeeds(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(KICK_SPEEDS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v) => Number.isFinite(v) && v > 0).slice(-MAX_KICK_SPEEDS);
  } catch {
    return [];
  }
}

/** Stores the latest kick speeds. Returns false if the browser refused. */
export function saveKickSpeeds(speeds, storage = globalThis.localStorage) {
  try {
    storage.setItem(KICK_SPEEDS_KEY, JSON.stringify(speeds));
    return true;
  } catch {
    return false;
  }
}
