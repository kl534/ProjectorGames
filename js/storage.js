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
 * @property {'capture'|'stream'} [frameClock] how the frame showing the change was timed for latencyMs, so the
 *   games time frames the same way. 'stream': every frame read from the camera (see readFrames in frames.js);
 *   'capture': when the camera took it, from the video's frame callbacks. Missing: when it reached the page.
 * @property {import('./camera.js').CameraMode} [cameraMode] the camera mode used, which the games use
 *   too (missing in older calibrations, made in whatever mode the browser picked)
 * @property {number} [fovDeg] how wide its lens sees (degrees), refined from real flights in Ball Test (missing:
 *   worked out from the calibration, or a typical webcam's; calibrating again forgets it)
 * @property {{lens: import('./lens.js').Lens, pose: import('./lens.js').Pose}} [measured] a measured camera of a
 *   rig (an IR camera that can't see the picture, rig.js's rigCameraCalibration): its lens, and its pose in the
 *   wall frame (metres); the screen fields above are then worked out from it, and only drawn
 *
 * @typedef {CameraCalibration & {createdAt: string, screenAspect?: number, second?: CameraCalibration,
 *   wall?: {corners: import('./lens.js').Vec[]}}} Calibration
 *   the main camera's calibration, plus: createdAt, an ISO timestamp; screenAspect, the projected screen's
 *   height / width (missing in older calibrations); second, the second camera's, if one was calibrated with it;
 *   wall, for a measured rig, the picture's corners on the wall (metres, clockwise from the top-left)
 *
 * @typedef {object} Settings
 * @property {string|null} cameraId
 * @property {string} cameraLabel
 * @property {string|null} secondCameraId the second camera chosen in Setup, or null for none
 * @property {string} secondCameraLabel
 * @property {number|null} screenWidthFt how wide the projected screen is (feet), for ball speeds; null if not given
 * @property {Object<string, import('./camera.js').CameraMode>} cameraModes the mode chosen in Setup for each
 *   camera (by deviceId); a camera not in it runs in its fastest mode
 * @property {Object<string, number>} cameraExposure the exposure set by hand in Setup for each camera (by
 *   deviceId; its exposureTime, see setExposure in camera.js); a camera not in it adjusts its exposure by
 *   itself, and the games hold it where it is
 * @property {Object<string, MeasuredLens>} cameraLenses each camera's lens as measured in Setup with the
 *   checkerboard (by deviceId); good for any of its modes with the same aspect
 * @property {Object<string, true>} cameraUpsideDown the cameras mounted upside down (by deviceId, as ticked in
 *   Setup): their picture is shown turned round, the right way up, wherever it is shown (only shown: what the
 *   detector and calibration work on is the camera's own picture)
 * @property {{id: string, x: number, y: number}[]} irMarkers the IR rig's wall markers as measured (metres:
 *   across from the top-left marker, and down), entered in Measure the IR rig
 * @property {Calibration|null} calibration
 *
 * @typedef {object} MeasuredLens
 * @property {import('./lens.js').Lens} lens
 * @property {number} rmsPixels how far the board's corners landed from where the lens put them
 * @property {number} views how many views of the board it was measured from
 * @property {number} width @property {number} height the pictures' size, pixels
 * @property {string} measuredAt an ISO timestamp
 */

/** @returns {Settings} */
export function defaultSettings() {
  return {
    cameraId: null,
    cameraLabel: '',
    secondCameraId: null,
    secondCameraLabel: '',
    screenWidthFt: null,
    cameraModes: {},
    cameraExposure: {},
    cameraLenses: {},
    cameraUpsideDown: {},
    irMarkers: [],
    calibration: null,
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
  if (parsed.cameraModes && typeof parsed.cameraModes === 'object') {
    for (const [id, mode] of Object.entries(parsed.cameraModes)) if (isValidMode(mode)) settings.cameraModes[id] = mode;
  }
  if (parsed.cameraExposure && typeof parsed.cameraExposure === 'object') {
    for (const [id, time] of Object.entries(parsed.cameraExposure)) {
      if (Number.isFinite(time) && time > 0) settings.cameraExposure[id] = time;
    }
  }
  if (parsed.cameraLenses && typeof parsed.cameraLenses === 'object') {
    for (const [id, measured] of Object.entries(parsed.cameraLenses)) {
      if (isValidMeasuredLens(measured)) settings.cameraLenses[id] = measured;
    }
  }
  if (parsed.cameraUpsideDown && typeof parsed.cameraUpsideDown === 'object') {
    for (const [id, flipped] of Object.entries(parsed.cameraUpsideDown)) if (flipped === true) settings.cameraUpsideDown[id] = true;
  }
  if (Array.isArray(parsed.irMarkers)) {
    settings.irMarkers = parsed.irMarkers.filter((m) => m && typeof m.id === 'string' && Number.isFinite(m.x) && Number.isFinite(m.y));
  }
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
      cameraModes: settings.cameraModes ?? {},
      cameraExposure: settings.cameraExposure ?? {},
      cameraLenses: settings.cameraLenses ?? {},
      cameraUpsideDown: settings.cameraUpsideDown ?? {},
      irMarkers: settings.irMarkers ?? [],
      calibration: settings.calibration,
    }));
    return true;
  } catch {
    return false;
  }
}

/** Whether a camera (by deviceId) is mounted upside down, so its picture is shown turned round. */
export function isUpsideDown(settings, deviceId) {
  return Boolean(deviceId && settings?.cameraUpsideDown?.[deviceId]);
}

export function isValidCalibration(c) {
  if (!c || typeof c !== 'object') return false;
  if (typeof c.createdAt !== 'string' || Number.isNaN(Date.parse(c.createdAt))) return false;
  if (c.screenAspect !== undefined && !(Number.isFinite(c.screenAspect) && c.screenAspect > 0)) return false;
  if (c.second !== undefined && !isValidCameraCalibration(c.second)) return false;
  // A measured rig's: where the picture is on the wall, which its cameras need.
  if (c.wall !== undefined && !(Array.isArray(c.wall?.corners) && c.wall.corners.length === 4 && c.wall.corners.every(isVec))) return false;
  if ((c.measured || c.second?.measured) && c.wall === undefined) return false;
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
  if (c.frameClock !== undefined && c.frameClock !== 'capture' && c.frameClock !== 'stream') return false;
  if (c.cameraMode !== undefined && !isValidMode(c.cameraMode)) return false;
  if (c.fovDeg !== undefined && !(Number.isFinite(c.fovDeg) && c.fovDeg > 0)) return false;
  if (c.measured !== undefined) {
    const pose = c.measured?.pose;
    if (!isValidLens(c.measured?.lens) || !pose || !Array.isArray(pose.rotation) || pose.rotation.length !== 9
      || !pose.rotation.every(Number.isFinite) || !isVec(pose.translation)) return false;
  }
  return true;
}

/** Whether a measured lens (MeasuredLens) is complete and sensible. */
export function isValidMeasuredLens(m) {
  if (!m || typeof m !== 'object' || !isValidLens(m.lens)) return false;
  if (!['rmsPixels', 'views', 'width', 'height'].every((k) => Number.isFinite(m[k]) && m[k] >= 0)) return false;
  return typeof m.measuredAt === 'string' && !Number.isNaN(Date.parse(m.measuredAt));
}

/** Whether a lens (lens.js's Lens) is complete and sensible. */
function isValidLens(l) {
  if (!l || typeof l !== 'object' || (l.model !== 'brown' && l.model !== 'fisheye')) return false;
  if (!['fx', 'fy', 'imageAspect'].every((k) => Number.isFinite(l[k]) && l[k] > 0)) return false;
  if (!Number.isFinite(l.cx) || !Number.isFinite(l.cy)) return false;
  if (!Array.isArray(l.k) || l.k.length !== (l.model === 'fisheye' ? 4 : 3) || !l.k.every(Number.isFinite)) return false;
  return Array.isArray(l.p) && l.p.length === 2 && l.p.every(Number.isFinite);
}

const isVec = (v) => Boolean(v && typeof v === 'object' && ['x', 'y', 'z'].every((k) => Number.isFinite(v[k])));

/**
 * A camera's measured lens, if it was measured in pictures of the same shape as `width` × `height` (the lens
 * is kept in picture widths, so any size of that shape will do); else null.
 * @param {Settings} settings @param {string|null} deviceId @param {number} width @param {number} height
 * @returns {import('./lens.js').Lens|null}
 */
export function lensFor(settings, deviceId, width, height) {
  const m = deviceId ? settings.cameraLenses?.[deviceId] : null;
  if (!m || !(width > 0 && height > 0)) return null;
  return Math.abs(m.lens.imageAspect - height / width) < 0.01 ? m.lens : null;
}

/** Whether a camera mode has a sensible size and frame rate. */
function isValidMode(mode) {
  return Boolean(mode && typeof mode === 'object' && ['width', 'height', 'frameRate']
    .every((k) => Number.isFinite(mode[k]) && mode[k] > 0));
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
