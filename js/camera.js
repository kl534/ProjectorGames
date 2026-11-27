// Webcam access: listing cameras, opening one, finding its fastest mode,
// holding its exposure steady, and turning failures into messages a person
// setting up the rig can act on.
//
// A fast camera matters: the more pictures a second, the closer one of them is
// to the moment the ball hits. But browsers don't open a camera at its fastest
// unless asked (Chrome aims for 30 frames a second), and don't always deliver
// the frame rate they report: Chrome on a Mac may open a slow format of the
// same size. So the fastest mode is found by opening each candidate and
// counting the frames that actually arrive.
//
// Some modes are only a window cut from the middle of the camera's picture
// (a fast global-shutter camera's 320 × 240 shows a quarter of the width), so
// the fastest mode chosen by itself must also show the same view as the
// camera's largest mode. Every mode tried is listed (findCameraModes), so one
// of the others can be chosen by hand in Setup.
//
// Cameras read by ffmpeg through the server (native-camera.js) are listed and
// opened here too, alongside the browser's own: their deviceIds start with
// 'native:', and they work like any other camera.

import { rgbaToLuma } from './detect.js';
import { isNativeId, nativeCameras } from './native-camera.js';

export const CAMERA_MESSAGES = {
  none: 'No camera found – connect a camera and press Refresh.',
  blocked: "Camera access was blocked – allow camera access in Chrome's address bar, then press Refresh.",
  busy: 'The camera is being used by another program – close that program, then press Refresh.',
  disconnected: 'The camera was disconnected – reconnect it and press Refresh.',
  unsupported: 'Cameras can’t be used from this address – start the app with “npm start” and open http://localhost:8000.',
  error: 'The camera could not be started – check its connection, then press Refresh.',
};

export class CameraError extends Error {
  /** @param {keyof CAMERA_MESSAGES} kind */
  constructor(kind, cause) {
    super(CAMERA_MESSAGES[kind], { cause });
    this.name = 'CameraError';
    this.kind = kind;
  }
}

/** Maps a getUserMedia error to one of the CAMERA_MESSAGES kinds. */
export function classifyCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'blocked';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'none';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'busy';
    default:
      return 'error';
  }
}

/**
 * A camera mode, as asked of the browser: the camera's own mode nearest to it is used.
 * @typedef {{width:number, height:number, frameRate:number}} CameraMode
 */

// Sizes tried when looking for the fastest mode, besides the camera's largest
// size, halved and quartered.
const MODE_SIZES = [[1920, 1080], [1280, 720], [960, 540], [800, 600], [640, 480], [640, 360], [424, 240], [320, 240]];
// A mode shows the same view as the largest if its shape is within this fraction of the largest's…
const SAME_SHAPE = 0.02;
// …and a small greyscale copy of its picture matches the largest's this well (correlation, up to 1).
const SAME_VIEW = 0.75;
// Pictures with less detail than this (brightness spread) can't be compared.
const MIN_VIEW_DETAIL = 4;
// The size of those small copies.
const VIEW_WIDTH = 32;
const VIEW_HEIGHT = 24;
// Frames are analysed 320 pixels wide, so narrower modes aren't used.
export const MIN_MODE_WIDTH = 320;
// Modes within this fraction of the fastest count as just as fast (the wider one is used).
const SAME_SPEED = 0.1;

/** @param {CameraMode|null} [mode] null: a good picture, at whatever speed the browser picks */
function constraints(deviceId, mode = null) {
  return {
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      ...(mode ? {
        width: { ideal: mode.width },
        height: { ideal: mode.height },
        frameRate: { ideal: mode.frameRate },
        // The camera's own mode, not one the browser makes by cropping and scaling.
        resizeMode: 'none',
      } : {
        width: { ideal: 1280 },
        height: { ideal: 720 },
      }),
    },
  };
}

/**
 * The browser's cameras, then those read through the server (if any).
 * @param {MediaDevices} [md]
 * @param {{enumerateDevices: () => Promise<MediaDeviceInfo[]>}|null} [native] the server's cameras
 * @returns {Promise<{deviceId:string, label:string}[]>}
 */
export async function listCameras(md = navigator.mediaDevices, native = nativeCameras) {
  const devices = await md.enumerateDevices();
  const browser = devices
    .filter((d) => d.kind === 'videoinput' && d.deviceId)
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  let served = [];
  try {
    served = native ? (await native.enumerateDevices()).map((d) => ({ deviceId: d.deviceId, label: d.label })) : [];
  } catch {
    // the server's cameras can't be listed: the browser's still can
  }
  return [...browser, ...served];
}

/** Where a camera is opened: through the server for its cameras, else the browser. */
function devicesFor(deviceId, md, native) {
  return isNativeId(deviceId) && native ? native : md;
}

function deviceIdOf(stream, fallback) {
  const track = stream.getVideoTracks()[0];
  return track?.getSettings?.().deviceId || fallback || null;
}

/**
 * Opens the preferred camera, or the first available one if the preferred
 * camera can't be opened (e.g. it was unplugged). Also lists the cameras,
 * which only have names once permission has been granted.
 * @param {string|null} preferredId
 * @param {object} [options]
 * @param {CameraMode|null} [options.mode] the mode to open the preferred camera in (not used for another camera)
 * @param {Storage} [options.storage] where settings held on cameras are remembered (see holdAdjustments)
 * @returns {Promise<{stream: MediaStream, deviceId: string|null, cameras: {deviceId:string,label:string}[]}>}
 * @throws {CameraError}
 */
export async function openPreferredCamera(preferredId, {
  mode = null, md = globalThis.navigator?.mediaDevices, native = nativeCameras, storage = globalThis.localStorage,
} = {}) {
  if (!md?.getUserMedia) throw new CameraError('unsupported');
  let stream;
  let requested = preferredId;
  try {
    stream = await devicesFor(preferredId, md, native).getUserMedia(constraints(preferredId, preferredId ? mode : null));
  } catch (err) {
    const kind = classifyCameraError(err);
    if (kind === 'blocked' || !preferredId) throw new CameraError(kind, err);
    requested = null;
    try {
      stream = await md.getUserMedia(constraints(null));
    } catch (err2) {
      throw new CameraError(classifyCameraError(err2), err2);
    }
  }
  let cameras;
  try {
    cameras = await listCameras(md, native);
  } catch {
    cameras = [];
  }
  let deviceId = deviceIdOf(stream, requested);
  if (!deviceId) {
    const label = stream.getVideoTracks()[0]?.label;
    deviceId = cameras.find((c) => c.label === label)?.deviceId ?? cameras[0]?.deviceId ?? null;
  }
  await releaseLeftHeld(stream.getVideoTracks()[0], deviceId, storage);
  return { stream, deviceId, cameras };
}

/**
 * Opens one specific camera.
 * @param {string} deviceId
 * @param {{mode?: CameraMode|null, md?: MediaDevices, storage?: Storage}} [options]
 * @throws {CameraError}
 */
export async function openCamera(deviceId, {
  mode = null, md = globalThis.navigator?.mediaDevices, native = nativeCameras, storage = globalThis.localStorage,
} = {}) {
  if (!md?.getUserMedia) throw new CameraError('unsupported');
  try {
    const stream = await devicesFor(deviceId, md, native).getUserMedia(constraints(deviceId, mode));
    const opened = deviceIdOf(stream, deviceId);
    await releaseLeftHeld(stream.getVideoTracks()[0], opened, storage);
    return { stream, deviceId: opened };
  } catch (err) {
    throw new CameraError(classifyCameraError(err), err);
  }
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

// Settings a camera keeps adjusting by itself as the picture changes: the
// setting that turns that on or off, and the value it adjusts.
const ADJUSTMENTS = [
  { mode: 'exposureMode', value: 'exposureTime', name: 'exposure' },
  { mode: 'whiteBalanceMode', value: 'colorTemperature', name: 'white balance' },
  { mode: 'focusMode', value: 'focusDistance', name: 'focus' },
];
// A camera that doesn't answer within this long is closed anyway.
const RELEASE_TIMEOUT_MS = 1000;
// Settings held on each camera are remembered here until released, in case
// the page is closed first: they are released the next time the camera is opened.
export const HELD_KEY = 'projectorGames.heldCamera';

/**
 * A setting held by holdAdjustments: its name for people, and what it was set to before.
 * @typedef {{mode: string, was: string, name: string}} HeldAdjustment
 */

/**
 * Holds the camera's exposure, white balance and focus where they are now,
 * instead of letting the camera keep adjusting them. A camera adjusting itself
 * changes the whole picture as players come and go and the game's picture
 * changes. Only settings the camera reports, and lets be set by hand, are
 * held; the rest are left alone. What was held is remembered (in `storage`)
 * until released.
 * @param {MediaStreamTrack} track
 * @returns {Promise<HeldAdjustment[]>} what was held, for releaseAdjustments
 */
export async function holdAdjustments(track, storage = globalThis.localStorage) {
  const caps = track.getCapabilities?.() ?? {};
  const settings = track.getSettings?.() ?? {};
  const held = [];
  for (const { mode, value, name } of ADJUSTMENTS) {
    const was = settings[mode];
    if (!was || was === 'manual' || !caps[mode]?.includes?.('manual') || !Number.isFinite(settings[value])) continue;
    if (await setAdjustment(track, { [mode]: 'manual', [value]: settings[value] }, mode)) {
      held.push({ mode, was, name });
      rememberHeld(storage, settings.deviceId, held);
    }
  }
  return held;
}

/** Lets the camera adjust the settings held by holdAdjustments by itself again. */
export async function releaseAdjustments(track, held, storage = globalThis.localStorage) {
  await releaseSomeAdjustments(track, held, () => true, storage);
}

/**
 * Lets the camera adjust some of the held settings by itself again.
 * @param {HeldAdjustment[]} held
 * @param {(h: HeldAdjustment) => boolean} which the settings to release
 * @returns {Promise<HeldAdjustment[]>} what is still held
 */
export async function releaseSomeAdjustments(track, held, which, storage = globalThis.localStorage) {
  const kept = held.filter((h) => !which(h));
  for (const { mode, was } of held.filter(which)) await setAdjustment(track, { [mode]: was }, mode);
  rememberHeld(storage, track.getSettings?.().deviceId, kept);
  return kept;
}

// Holding exposure darkened the picture if its brightness fell below this
// fraction of what it was; pictures darker than DARK_PICTURE can't tell.
const HELD_DARKER = 0.75;
const DARK_PICTURE = 6;

/**
 * Whether holding the exposure made the picture darker. Cameras adjusting
 * their exposure by themselves often report a stale exposure time (the last
 * one set by hand, or a default), not the one they are using, so holding
 * "where it is" can leave the picture much too dark to see a ball.
 * @param {number|null} before the picture's average brightness (0–255) before holding
 * @param {number|null} after the same, once held
 */
export function heldTooDark(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before < DARK_PICTURE) return false;
  return after < before * HELD_DARKER;
}

/** Releases settings left held on a camera when the page was last closed during a game. */
async function releaseLeftHeld(track, deviceId, storage) {
  const held = readHeld(storage)[deviceId];
  if (track && Array.isArray(held) && held.length) await releaseAdjustments(track, held, storage);
}

function readHeld(storage) {
  try {
    const all = JSON.parse(storage?.getItem(HELD_KEY) || '{}');
    return all && typeof all === 'object' ? all : {};
  } catch {
    return {};
  }
}

function rememberHeld(storage, deviceId, held) {
  if (!deviceId) return;
  try {
    const { [deviceId]: _old, ...rest } = readHeld(storage);
    const all = held.length ? { ...rest, [deviceId]: held } : rest;
    if (Object.keys(all).length) storage?.setItem(HELD_KEY, JSON.stringify(all));
    else storage?.removeItem(HELD_KEY);
  } catch {
    // Storage blocked: released when the game ends, but not after a crash.
  }
}

/**
 * Stops a stream, first releasing the settings held by holdAdjustments: some
 * cameras keep their settings after they are closed, which would leave other
 * programs with a fixed exposure.
 * @param {MediaStream|null} stream
 * @param {HeldAdjustment[]} held
 */
export async function stopStreamReleasing(stream, held, timeoutMs = RELEASE_TIMEOUT_MS) {
  const track = stream?.getVideoTracks()[0];
  if (track && held.length) {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
    await Promise.race([releaseAdjustments(track, held), timeout]);
    clearTimeout(timer);
  }
  stopStream(stream);
}

/**
 * Changes one of a track's settings, keeping the size and frame rate it was
 * opened with (new constraints replace all the old ones). True if the camera
 * took it.
 */
async function setAdjustment(track, set, mode) {
  const { advanced = [], ...current } = track.getConstraints?.() ?? {};
  try {
    await track.applyConstraints({ ...current, advanced: [...advanced.filter((s) => !(mode in s)), set] });
  } catch {
    return false;
  }
  return track.getSettings?.()[mode] === set[mode];
}

/**
 * The exposure times a camera can be set to by hand (its exposureTime capability; 100 µs units in Chrome on
 * Windows and for cameras read through the server), or null if it can't be.
 * @param {MediaStreamTrack|null} track
 * @returns {{min: number, max: number}|null}
 */
export function exposureRange(track) {
  const caps = track?.getCapabilities?.() ?? {};
  const range = caps.exposureTime;
  if (!caps.exposureMode?.includes?.('manual') || !(range?.max > 0)) return null;
  return { min: Math.max(range.min, range.max / 2 ** 20, 1e-3), max: range.max };
}

/**
 * Sets a camera's exposure by hand, or (null) lets it adjust it by itself again.
 * Set by hand, a camera keeps it, in games and after: holdAdjustments leaves it alone.
 * @param {MediaStreamTrack} track
 * @param {number|null} exposureTime
 * @returns {Promise<boolean>} whether the camera took it
 */
export async function setExposure(track, exposureTime) {
  if (exposureTime === null) {
    if (track.getSettings?.().exposureMode !== 'manual') return true;
    return setAdjustment(track, { exposureMode: 'continuous' }, 'exposureMode');
  }
  const range = exposureRange(track);
  if (!range) return false;
  const time = Math.min(range.max, Math.max(range.min, exposureTime));
  return setAdjustment(track, { exposureMode: 'manual', exposureTime: time }, 'exposureMode');
}

/**
 * A camera mode that was tried: how fast it really is, and whether it shows the
 * camera's whole view (some are a window cut from it, or a different shape).
 * @typedef {{mode: CameraMode, fps: number, whole: boolean}} MeasuredMode
 */

/**
 * Tries a camera's modes: opens it at each candidate size in turn, asking for
 * its top frame rate, and counts the frames that arrive. Modes that turn out
 * the same size as one already tried, or narrower than frames are analysed,
 * are left out. The fastest is chosen from the modes showing the same view as
 * the camera's largest mode; the others can still be chosen by hand in Setup.
 * The camera must not be open elsewhere (it would stay in that mode). Leaves it closed.
 * @param {string} deviceId
 * @param {{width: number, height: number, frameRate: number}} largest the camera's
 *   largest size and fastest frame rate (from its capabilities)
 * @param {object} [options]
 * @param {(track: MediaStreamTrack) => Promise<{fps: number|null, view: Float32Array|null}>} [options.measure]
 *   frames a second a track delivers, and a small greyscale copy of its picture
 * @param {() => boolean} [options.wanted] false stops the search (e.g. another camera was chosen meanwhile)
 * @returns {Promise<{fastest: {mode: CameraMode, fps: number}|null, modes: MeasuredMode[]}|null>}
 *   null if stopped; `modes` from the largest down, `fastest` null if none showing the whole view could be measured
 */
export async function findCameraModes(deviceId, largest, {
  measure = measureMode, wanted = () => true, md = globalThis.navigator?.mediaDevices, native = nativeCameras,
} = {}) {
  const { width: W, height: H, frameRate } = largest;
  const devices = devicesFor(deviceId, md, native);
  // A camera read through the server says what sizes it has: those are tried, not guessed.
  const own = devices.modeSizes ? await devices.modeSizes(deviceId) : null;
  const sizes = own?.length ? own.filter(([w], i) => i === 0 || w >= MIN_MODE_WIDTH)
    : [[W, H], [W / 2, H / 2], [W / 4, H / 4], ...MODE_SIZES].map(([w, h]) => [Math.round(w), Math.round(h)]);
  const tried = [];
  /** @type {MeasuredMode[]} */
  const modes = [];
  let reference = null; // the largest mode: its shape and view
  for (const [width, height] of sizes) {
    if (!wanted()) return null;
    let stream;
    try {
      stream = await devices.getUserMedia(constraints(deviceId, { width, height, frameRate }));
    } catch {
      continue;
    }
    try {
      const track = stream.getVideoTracks()[0];
      const { width: w, height: h } = track?.getSettings?.() ?? {};
      // Not every size exists: the camera may have given one already tried.
      if (!(w > 0 && h > 0) || tried.some((t) => t.w === w && t.h === h)) continue;
      tried.push({ w, h });
      if (w < MIN_MODE_WIDTH && reference) continue;
      const { fps, view } = await measure(track);
      let whole = true;
      if (!reference) reference = { shape: w / h, view };
      else whole = Math.abs((w / h) / reference.shape - 1) <= SAME_SHAPE && sameView(reference.view, view);
      if (w >= MIN_MODE_WIDTH && fps > 0) modes.push({ mode: { width: w, height: h, frameRate }, fps, whole });
    } finally {
      stopStream(stream);
    }
  }
  if (!wanted()) return null;
  const fastest = pickFastestMode(modes.filter((m) => m.whole));
  return { fastest: fastest && { mode: fastest.mode, fps: fastest.fps }, modes };
}

/**
 * Finds a camera's fastest mode showing its whole view (see findCameraModes).
 * @returns {Promise<{mode: CameraMode, fps: number}|null>} null if no mode could be measured, or stopped
 */
export async function findFastestMode(deviceId, largest, options = {}) {
  return (await findCameraModes(deviceId, largest, options))?.fastest ?? null;
}

/**
 * Whether a small greyscale picture shows the same view as a reference one.
 * True when it can't be told (no pictures, or a reference too plain to compare).
 * @param {Float32Array|null} reference
 * @param {Float32Array|null} view
 */
export function sameView(reference, view) {
  if (!reference || !view || reference.length !== view.length) return true;
  const n = reference.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += reference[i];
    mb += view[i];
  }
  ma /= n;
  mb /= n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    const a = reference[i] - ma;
    const b = view[i] - mb;
    ab += a * b;
    aa += a * a;
    bb += b * b;
  }
  if (Math.sqrt(aa / n) < MIN_VIEW_DETAIL) return true;
  return bb > 0 && ab / Math.sqrt(aa * bb) >= SAME_VIEW;
}

/**
 * The fastest of the measured modes; of modes about as fast, the widest.
 * @param {{mode: CameraMode, fps: number}[]} found
 */
export function pickFastestMode(found) {
  if (!found.length) return null;
  const top = Math.max(...found.map((f) => f.fps));
  return found
    .filter((f) => f.fps >= top * (1 - SAME_SPEED))
    .reduce((a, b) => (b.mode.width > a.mode.width ? b : a));
}

/**
 * How many frames a second a camera track delivers, counted after letting it
 * settle (a camera starting up is slow at first), and a small greyscale copy
 * of its picture. Uses the browser's reported frame rate, and no picture,
 * where frames can't be read.
 * @returns {Promise<{fps: number|null, view: Float32Array|null}>}
 */
export async function measureMode(track, { settleMs = 400, countMs = 600 } = {}) {
  if (typeof MediaStreamTrackProcessor !== 'function') return { fps: track.getSettings?.().frameRate ?? null, view: null };
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  // A camera that sends nothing would leave read() waiting for ever.
  const timer = setTimeout(() => reader.cancel(), settleMs + countMs + 1000);
  const start = performance.now();
  let first = null;
  let last = null;
  let frames = 0;
  let latest = null; // the last frame counted, kept open for its picture
  try {
    while (performance.now() - start < settleMs + countMs) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      if (performance.now() - start < settleMs) {
        frame.close();
        continue;
      }
      first ??= frame.timestamp;
      last = frame.timestamp;
      frames++;
      latest?.close();
      latest = frame;
    }
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  const view = latest ? viewOf(latest) : null;
  latest?.close();
  // Timestamps are in microseconds.
  return { fps: frames > 2 && last > first ? ((frames - 1) * 1e6) / (last - first) : 0, view };
}

/** A small greyscale copy of a video frame, for comparing views. */
function viewOf(frame) {
  const ctx = new OffscreenCanvas(VIEW_WIDTH, VIEW_HEIGHT).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(frame, 0, 0, VIEW_WIDTH, VIEW_HEIGHT);
  return rgbaToLuma(ctx.getImageData(0, 0, VIEW_WIDTH, VIEW_HEIGHT).data);
}
