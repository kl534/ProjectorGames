// App shell: screens, navigation, keyboard handling, camera setup and calibration flow.

import { BallTest } from './ball-test.js';
import { BalloonPop } from './balloon-pop.js';
import { BrickBreaker } from './brick-breaker.js';
import { findScreenCorners } from './calibration.js';
import {
  CAMERA_MESSAGES, CameraError, findFastestMode, listCameras, openCamera, openPreferredCamera, stopStream,
} from './camera.js';
import { DemolitionDay } from './demolition-day.js';
import { DunkTheClown } from './dunk-the-clown.js';
import { FieldersChoice } from './fielders-choice.js';
import { calibrationStatus, cameraModeText, secondCameraStatus } from './format.js';
import { GAMES } from './games.js';
import { GapShot } from './gap-shot.js';
import { GoldenBoot } from './golden-boot.js';
import { seededRandom } from './golden-boot-models.js';
import { unlockAudio } from './sound.js';
import { loadSettings, saveSettings } from './storage.js';
import { TargetPractice } from './target-practice.js';

const $ = (selector) => document.querySelector(selector);

const screens = Object.fromEntries(
  [...document.querySelectorAll('[data-screen]')].map((el) => [el.dataset.screen, el]),
);

const els = {
  start: $('#btn-start'),
  gamesNotice: $('#games-notice'),
  gameGrid: $('#game-grid'),
  setupPreview: $('#setup-preview'),
  setupVideo: $('#setup-video'),
  setupOutline: $('#setup-preview .outline'),
  cameraMessage: $('#camera-message'),
  cameraMode: $('#camera-mode'),
  cameraSelect: $('#camera-select'),
  refresh: $('#btn-refresh'),
  status: $('#calibration-status'),
  calibrate: $('#btn-calibrate'),
  calCancel: $('#btn-cal-cancel'),
  checkPreview: $('#check-preview'),
  checkVideo: $('#check-video'),
  checkOutline: $('#check-preview .outline'),
  calSave: $('#btn-cal-save'),
  calRedo: $('#btn-cal-redo'),
  calRetry: $('#btn-cal-retry'),
  ballClear: $('#btn-ball-clear'),
  calFailCancel: $('#btn-cal-fail-cancel'),
  markers: [...document.querySelectorAll('#screen-calibrating .marker')],
  setupPreviews: $('.setup-previews'),
  secondPreview: $('#second-preview'),
  secondVideo: $('#second-video'),
  secondOutline: $('#second-preview .outline'),
  secondMessage: $('#second-message'),
  secondSelect: $('#second-camera-select'),
  secondMode: $('#second-camera-mode'),
  secondStatus: $('#second-calibration-status'),
  screenWidth: $('#screen-width'),
  checkPreviews: $('.check-previews'),
  checkSecondPreview: $('#check-second-preview'),
  checkSecondVideo: $('#check-second-video'),
  checkSecondOutline: $('#check-second-preview .outline'),
  checkNote: $('#check-note'),
  calFailedMessage: $('#cal-failed-message'),
};
const FAILED_MESSAGES = {
  main: els.calFailedMessage.textContent,
  second: 'The second camera couldn’t find all four corners. Make sure it can see the whole projected screen and the room isn’t too bright, or set Second camera to None, then try again.',
};

// Frames for calibration are grabbed from this always-rendered (but invisible)
// video, because browsers may stop updating videos that aren't displayed.
const captureVideo = document.createElement('video');
captureVideo.className = 'capture-video';
captureVideo.muted = true;
captureVideo.playsInline = true;
captureVideo.setAttribute('aria-hidden', 'true');
document.body.append(captureVideo);
// The same for the second camera.
const secondCaptureVideo = captureVideo.cloneNode();
document.body.append(secondCaptureVideo);

const ballTest = new BallTest(screens['ball-test']);
const query = new URLSearchParams(location.search);
// ?round=20 plays 20-second rounds of Target Practice (handy for testing).
const roundSeconds = Number(query.get('round'));
const targetPractice = new TargetPractice(screens['target-practice'], {
  ...(roundSeconds > 0 ? { roundMs: roundSeconds * 1000 } : {}),
});
// ?lives=2 gives Balloon Pop 2 lives (handy for testing).
const lives = Math.floor(Number(query.get('lives')));
const balloonPop = new BalloonPop(screens['balloon-pop'], { ...(lives > 0 ? { lives } : {}) });
// ?time=25 gives every Brick Breaker wall 25 seconds, and ?level=3 starts Brick Breaker and Demolition Day at
// level 3 (handy for testing).
const wallSeconds = Number(query.get('time'));
const startLevel = Math.floor(Number(query.get('level')));
const levelOptions = startLevel > 0 ? { level: startLevel } : {};
const brickBreaker = new BrickBreaker(screens['brick-breaker'], {
  ...(wallSeconds > 0 ? { timeMs: wallSeconds * 1000 } : {}),
  ...levelOptions,
});
const demolitionDay = new DemolitionDay(screens['demolition-day'], levelOptions);
const fieldersChoice = new FieldersChoice(screens['fielders-choice']);
const gapShot = new GapShot(screens['gap-shot']);
// ?round=20 also plays 20-second rounds of Dunk the Clown.
const dunkTheClown = new DunkTheClown(screens['dunk-the-clown'], {
  ...(roundSeconds > 0 ? { roundMs: roundSeconds * 1000 } : {}),
});
// ?seed=7 fixes the random numbers Golden Boot's keeper uses to decide a close one (handy for testing).
const seed = Math.floor(Number(query.get('seed')));
const goldenBoot = new GoldenBoot(screens['golden-boot'], {
  ...(query.has('seed') && Number.isFinite(seed) ? { random: seededRandom(seed) } : {}),
});
// The games that can be played, by id (see games.js).
const games = {
  'ball-test': ballTest,
  'target-practice': targetPractice,
  'balloon-pop': balloonPop,
  'brick-breaker': brickBreaker,
  'demolition-day': demolitionDay,
  'fielders-choice': fieldersChoice,
  'gap-shot': gapShot,
  'dunk-the-clown': dunkTheClown,
  'golden-boot': goldenBoot,
};

const state = {
  pendingGame: null, // the game picked before the needs-calibration page
  mouseOnly: false, // the player chose to play with mouse/taps only, until reload
  settings: loadSettings(),
  screen: 'start',
  stream: null,
  cameraId: null,
  cameraLabel: '',
  cameraMode: null, // the fastest mode found for the camera (see findFastestMode), or null
  cameraFps: null, // frames a second it was measured at
  cameras: [],
  cameraProblem: null, // a key of CAMERA_MESSAGES, or null
  cameraRequest: 0, // increments so that stale camera requests can be ignored
  speedCheck: 0, // the camera request whose speed is being checked
  // The second camera (optional): chosen in Setup, calibrated with the main one.
  second: {
    cameraId: null, // chosen, whether or not it has opened
    cameraLabel: '',
    stream: null,
    cameraMode: null,
    cameraFps: null,
    problem: null, // a key of CAMERA_MESSAGES, or null
    checking: false, // finding its fastest mode
    request: 0, // increments so that stale requests can be ignored
  },
  calibrationAbort: null,
  pendingCalibration: null,
  appLeavingFullscreen: false, // true while the app itself (F key) leaves full screen
};

// ---- Screens & navigation ---------------------------------------------------

function showScreen(name) {
  state.screen = name;
  for (const [screenName, el] of Object.entries(screens)) {
    el.classList.toggle('active', screenName === name);
  }
  const screen = screens[name];
  if (screen.hasAttribute('data-no-focus')) {
    document.activeElement?.blur();
    return;
  }
  (screen.querySelector('[autofocus]') || focusables(screen)[0])?.focus({ preventScroll: true });
}

function focusables(container) {
  return [...container.querySelectorAll('button, select, input')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
}

function goBack() {
  switch (state.screen) {
    case 'games':
      showScreen('menu');
      break;
    case 'needs-calibration':
      showGames();
      break;
    case 'ball-test':
    case 'target-practice':
    case 'balloon-pop':
    case 'brick-breaker':
    case 'demolition-day':
    case 'fielders-choice':
    case 'gap-shot':
    case 'dunk-the-clown':
    case 'golden-boot':
      games[state.screen].stop();
      showGames();
      break;
    case 'setup':
      leaveSetup();
      break;
    case 'calibrating':
    case 'check':
    case 'failed':
      cancelCalibration();
      break;
    default:
      break;
  }
}

function enterFullscreen() {
  const root = document.documentElement;
  if (document.fullscreenElement || !root.requestFullscreen) {
    return Promise.resolve(Boolean(document.fullscreenElement));
  }
  return root.requestFullscreen({ navigationUI: 'hide' }).then(() => true, () => false);
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    state.appLeavingFullscreen = true;
    document.exitFullscreen().catch(() => { state.appLeavingFullscreen = false; });
  } else {
    enterFullscreen();
  }
}

// In full screen, Chrome keeps Esc for itself (it leaves full screen and the
// page may never see the key). So during calibration, leaving full screen by
// any means other than the app's own F key counts as Esc.
function onFullscreenChange() {
  const byApp = state.appLeavingFullscreen;
  state.appLeavingFullscreen = false;
  if (document.fullscreenElement || byApp) return;
  if (['calibrating', 'check', 'failed'].includes(state.screen)) cancelCalibration();
}

function start() {
  enterFullscreen();
  showScreen('menu');
}

// ---- Game selection ---------------------------------------------------------

function renderGames() {
  els.gameGrid.replaceChildren(...GAMES.map((game) => {
    const card = document.createElement('button');
    card.className = 'game-card';
    card.dataset.game = game.id;
    if (!game.available) card.setAttribute('aria-disabled', 'true');
    const title = document.createElement('h3');
    title.textContent = game.name;
    const description = document.createElement('p');
    description.textContent = game.description;
    card.append(title, description);
    if (!game.available) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'Coming soon';
      card.append(badge);
    }
    card.addEventListener('click', () => {
      if (game.available) launchGame(game.id); // coming-soon games do nothing
    });
    return card;
  }));
}

function showGames() {
  els.gamesNotice.hidden = Boolean(state.settings.calibration);
  showScreen('games');
  els.gameGrid.querySelector('.game-card:not([aria-disabled="true"])')?.focus({ preventScroll: true });
}

function launchGame(id) {
  if (!games[id]) return;
  if (!state.settings.calibration && !state.mouseOnly) {
    state.pendingGame = id;
    showScreen('needs-calibration');
    return;
  }
  // Both must be called straight from the click/key press.
  enterFullscreen();
  unlockAudio();
  showScreen(id);
  games[id].start(state.settings.calibration);
}

/** Plays the game that was picked without a calibration: no camera, mouse clicks and taps only. */
function playMouseOnly() {
  state.mouseOnly = true;
  if (state.pendingGame) launchGame(state.pendingGame);
}

// ---- Setup: camera ----------------------------------------------------------

function openSetup() {
  showScreen('setup');
  // Shown to a tenth of a foot (one converted from metres would otherwise show a long fraction).
  els.screenWidth.value = state.settings.screenWidthFt === null ? '' : String(Math.round(state.settings.screenWidthFt * 10) / 10);
  state.second.cameraId = state.settings.secondCameraId;
  state.second.cameraLabel = state.settings.secondCameraLabel;
  startCamera(state.settings.cameraId);
}

function leaveSetup() {
  state.cameraRequest++;
  stopCamera();
  state.second.request++;
  stopSecondCamera();
  showScreen('menu');
}

async function startCamera(preferredId) {
  const request = ++state.cameraRequest;
  stopCamera();
  state.cameraProblem = null;
  updateSetup();
  try {
    const { stream, deviceId, cameras } = await openPreferredCamera(preferredId);
    if (request !== state.cameraRequest) {
      stopStream(stream);
      return;
    }
    state.cameras = cameras;
    const fast = await reopenFastest(stream, deviceId, ...mainChecks(request, deviceId));
    if (!fast) return;
    useStream(fast.stream, deviceId, cameras, fast);
    if (!state.settings.cameraId && deviceId) rememberCamera();
    startChosenSecond();
  } catch (err) {
    if (request !== state.cameraRequest) return;
    await showCameraProblem(err);
  }
}

async function selectCamera(deviceId) {
  const request = ++state.cameraRequest;
  stopCamera();
  state.cameraProblem = null;
  updateSetup();
  try {
    const opened = await openCamera(deviceId);
    if (request !== state.cameraRequest) {
      stopStream(opened.stream);
      return;
    }
    const fast = await reopenFastest(opened.stream, opened.deviceId, ...mainChecks(request, opened.deviceId));
    if (!fast) return;
    useStream(fast.stream, opened.deviceId, state.cameras, fast);
    rememberCamera();
    startChosenSecond();
  } catch (err) {
    if (request !== state.cameraRequest) return;
    await showCameraProblem(err);
  }
}

/** For reopenFastest on the main camera: whether it is still wanted, and what to show while its speed is checked. */
function mainChecks(request, deviceId) {
  return [() => request === state.cameraRequest, () => {
    state.cameraId = deviceId;
    state.speedCheck = request;
    updateSetup();
  }];
}

/**
 * Swaps a camera just opened for the same camera in its fastest mode, which is
 * measured (see findFastestMode) before the preview starts. Resolves with the
 * stream to use, or null if it is no longer wanted (another camera was asked for meanwhile).
 * @param {() => boolean} wanted
 * @param {() => void} checking called as the modes start being tried
 * @returns {Promise<{stream: MediaStream, mode: import('./camera.js').CameraMode|null, fps: number|null}|null>}
 */
async function reopenFastest(stream, deviceId, wanted, checking) {
  const track = stream.getVideoTracks()[0];
  const caps = track?.getCapabilities?.() ?? {};
  const settings = track?.getSettings?.() ?? {};
  const largest = {
    width: caps.width?.max ?? settings.width,
    height: caps.height?.max ?? settings.height,
    frameRate: caps.frameRate?.max,
  };
  if (!deviceId || !(largest.width > 0 && largest.height > 0 && largest.frameRate > 0)) {
    return { stream, mode: null, fps: null };
  }
  // The camera stays in the mode it is open in, so close it while modes are tried.
  stopStream(stream);
  checking();
  const fastest = await findFastestMode(deviceId, largest, { wanted });
  if (!wanted()) return null;
  const opened = await openCamera(deviceId, { mode: fastest?.mode ?? null });
  if (!wanted()) {
    stopStream(opened.stream);
    return null;
  }
  return { stream: opened.stream, mode: fastest?.mode ?? null, fps: fastest?.fps ?? null };
}

// ---- Setup: second camera ---------------------------------------------------

/** Starts the second camera chosen earlier, once the main camera is running (unless it already is). */
function startChosenSecond() {
  const { second } = state;
  if (second.cameraId && second.cameraId === state.cameraId) {
    // The main camera is now the one that was second: it can't be both.
    chooseSecond(null);
    return;
  }
  if (second.cameraId && !second.stream && !second.checking && !second.problem) startSecondCamera(second.cameraId);
  else updateSetup();
}

/** The second camera chosen in Setup (null: none). */
function chooseSecond(deviceId) {
  state.second.cameraId = deviceId;
  state.second.cameraLabel = state.cameras.find((c) => c.deviceId === deviceId)?.label ?? '';
  state.settings.secondCameraId = deviceId;
  state.settings.secondCameraLabel = state.second.cameraLabel;
  saveSettings(state.settings);
  startSecondCamera(deviceId);
}

async function startSecondCamera(deviceId) {
  const { second } = state;
  const request = ++second.request;
  stopSecondCamera();
  second.problem = null;
  second.checking = false;
  updateSetup();
  if (!deviceId) return;
  const wanted = () => request === second.request;
  try {
    const opened = await openCamera(deviceId);
    if (!wanted()) {
      stopStream(opened.stream);
      return;
    }
    const fast = await reopenFastest(opened.stream, opened.deviceId, wanted, () => {
      second.checking = true;
      updateSetup();
    });
    second.checking = false;
    if (!fast) return;
    useSecondStream(fast.stream, fast);
  } catch (err) {
    if (!wanted()) return;
    if (!(err instanceof CameraError)) console.error(err);
    second.checking = false;
    second.problem = err instanceof CameraError ? err.kind : 'error';
    updateSetup();
  }
}

function useSecondStream(stream, { mode = null, fps = null }) {
  const { second } = state;
  second.stream = stream;
  second.cameraMode = mode;
  second.cameraFps = fps;
  second.cameraLabel = state.cameras.find((c) => c.deviceId === second.cameraId)?.label
    || stream.getVideoTracks()[0]?.label || 'Second camera';
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (second.stream !== stream) return;
    if (state.calibrationAbort) cancelCalibration();
    stopSecondCamera();
    second.problem = 'disconnected';
    updateSetup();
  });
  for (const video of [els.secondVideo, els.checkSecondVideo, secondCaptureVideo]) {
    video.srcObject = stream;
    video.play().catch(() => {});
  }
  updateSetup();
}

function stopSecondCamera() {
  const { second } = state;
  stopStream(second.stream);
  second.stream = null;
  second.cameraMode = null;
  second.cameraFps = null;
  for (const video of [els.secondVideo, els.checkSecondVideo, secondCaptureVideo]) {
    video.srcObject = null;
    video.classList.remove('live');
  }
}

function onSecondVideoSize() {
  const { videoWidth: w, videoHeight: h } = els.secondVideo;
  if (!w || !h) return;
  for (const preview of [els.secondPreview, els.checkSecondPreview]) preview.style.setProperty('--ar', String(w / h));
  els.secondVideo.classList.add('live');
  els.checkSecondVideo.classList.add('live');
  updateSetup();
}

function saveScreenWidth() {
  const value = Number.parseFloat(els.screenWidth.value);
  state.settings.screenWidthFt = Number.isFinite(value) && value > 0 ? value : null;
  saveSettings(state.settings);
}

async function showCameraProblem(err) {
  const kind = err instanceof CameraError ? err.kind : 'error';
  if (!(err instanceof CameraError)) console.error(err);
  state.cameraProblem = kind;
  state.cameras = [];
  // If a camera exists but couldn't start, still list cameras so another can be picked.
  if (kind === 'busy' || kind === 'error') {
    try {
      state.cameras = await listCameras();
    } catch {
      // ignore – the message already explains the problem
    }
  }
  updateSetup();
}

function useStream(stream, deviceId, cameras, { mode = null, fps = null } = {}) {
  state.stream = stream;
  state.cameraId = deviceId;
  state.cameraMode = mode;
  state.cameraFps = fps;
  state.cameras = cameras;
  state.cameraProblem = null;
  const track = stream.getVideoTracks()[0];
  state.cameraLabel = cameras.find((c) => c.deviceId === deviceId)?.label || track?.label || 'Camera';
  track?.addEventListener('ended', () => {
    if (state.stream !== stream) return;
    if (state.calibrationAbort) cancelCalibration();
    stopCamera();
    state.cameraProblem = 'disconnected';
    updateSetup();
  });
  for (const video of [els.setupVideo, els.checkVideo, captureVideo]) {
    video.srcObject = stream;
    video.play().catch(() => {});
  }
  updateSetup();
}

function stopCamera() {
  stopStream(state.stream);
  state.stream = null;
  state.cameraId = null;
  state.cameraMode = null;
  state.cameraFps = null;
  for (const video of [els.setupVideo, els.checkVideo, captureVideo]) {
    video.srcObject = null;
    video.classList.remove('live');
  }
}

function rememberCamera() {
  state.settings.cameraId = state.cameraId;
  state.settings.cameraLabel = state.cameraLabel;
  saveSettings(state.settings);
}

function onVideoSize() {
  const { videoWidth: w, videoHeight: h } = els.setupVideo;
  if (!w || !h) return;
  for (const preview of [els.setupPreview, els.checkPreview]) {
    preview.style.setProperty('--ar', String(w / h));
  }
  els.setupVideo.classList.add('live');
  els.checkVideo.classList.add('live');
  updateSetup();
}

function updateSetup() {
  const { cameras, cameraId, stream, cameraProblem } = state;
  const { calibration } = state.settings;

  const select = els.cameraSelect;
  if (cameras.length === 0) {
    select.replaceChildren(new Option('No camera', ''));
  } else {
    select.replaceChildren(...cameras.map((c) => new Option(c.label, c.deviceId)));
    select.value = cameraId && cameras.some((c) => c.deviceId === cameraId) ? cameraId : '';
    if (!select.value) select.prepend(new Option('Choose a camera…', '', true, true));
  }
  select.disabled = cameras.length === 0;

  if (cameraProblem) {
    els.cameraMessage.textContent = CAMERA_MESSAGES[cameraProblem];
    els.cameraMessage.classList.add('problem');
  } else if (stream) {
    els.cameraMessage.textContent = els.setupVideo.classList.contains('live') ? '' : 'Starting camera…';
    els.cameraMessage.classList.remove('problem');
  } else {
    els.cameraMessage.textContent = state.speedCheck === state.cameraRequest
      ? 'Finding the camera’s fastest setting…' : 'Starting camera…';
    els.cameraMessage.classList.remove('problem');
  }
  const settings = stream?.getVideoTracks()[0]?.getSettings?.();
  els.cameraMode.textContent = stream && settings?.width
    ? cameraModeText(settings.width, settings.height, state.cameraFps) : '';

  els.calibrate.disabled = !stream;
  els.status.textContent = calibrationStatus(calibration, cameraId);
  els.status.classList.toggle('calibrated', Boolean(calibration));

  const showSaved = Boolean(stream && calibration && calibration.cameraId === cameraId);
  setOutline(els.setupOutline, showSaved ? calibration.screenCornersCamera : null);
  updateSecondSetup();

  // Keep keyboard focus on the screen if the focused control was just disabled.
  const screen = screens[state.screen];
  const focused = document.activeElement;
  if (state.screen === 'setup' && (!screen.contains(focused) || focused.disabled)) {
    focusables(screen)[0]?.focus({ preventScroll: true });
  }
}

function updateSecondSetup() {
  const { cameras, cameraId } = state;
  const { second } = state;
  const { calibration } = state.settings;
  const others = cameras.filter((c) => c.deviceId !== cameraId);
  const select = els.secondSelect;
  select.replaceChildren(new Option('None', ''), ...others.map((c) => new Option(c.label, c.deviceId)));
  if (second.cameraId && !others.some((c) => c.deviceId === second.cameraId)) {
    select.append(new Option(`${second.cameraLabel || 'Second camera'} (not found)`, second.cameraId));
  }
  select.value = second.cameraId ?? '';
  select.disabled = others.length === 0 && !second.cameraId;

  els.secondPreview.hidden = !second.cameraId;
  els.setupPreviews.classList.toggle('two', Boolean(second.cameraId));
  if (second.problem) {
    els.secondMessage.textContent = CAMERA_MESSAGES[second.problem];
    els.secondMessage.classList.add('problem');
  } else {
    els.secondMessage.classList.remove('problem');
    els.secondMessage.textContent = second.stream && els.secondVideo.classList.contains('live') ? ''
      : second.checking ? 'Finding the camera’s fastest setting…' : 'Starting camera…';
  }
  const settings = second.stream?.getVideoTracks()[0]?.getSettings?.();
  els.secondMode.textContent = second.stream && settings?.width
    ? cameraModeText(settings.width, settings.height, second.cameraFps) : '';
  els.secondStatus.textContent = secondCameraStatus(calibration, second.cameraId);
  const saved = calibration?.second;
  setOutline(els.secondOutline, second.stream && saved?.cameraId === second.cameraId ? saved.screenCornersCamera : null);
}

function setOutline(svg, points) {
  svg.classList.toggle('show', Boolean(points));
  svg.querySelector('polygon').setAttribute(
    'points',
    points ? points.map((p) => `${p.x},${p.y}`).join(' ') : '',
  );
}

// ---- Calibration ------------------------------------------------------------

const pattern = {
  show(index) {
    els.markers.forEach((marker, i) => marker.classList.toggle('lit', i === index));
  },
  markerCentres() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    return els.markers.map((marker) => {
      const r = marker.getBoundingClientRect();
      return { x: (r.left + r.width / 2) / w, y: (r.top + r.height / 2) / h };
    });
  },
};

async function startCalibration() {
  if (!state.stream) return;
  state.calibrationAbort?.abort();
  const abort = new AbortController();
  state.calibrationAbort = abort;
  state.pendingCalibration = null;
  // Must be requested straight from the click/key press, before any await.
  const fullscreen = enterFullscreen();
  pattern.show(null);
  showScreen('calibrating');

  await fullscreen;
  if (abort.signal.aborted) return;

  // The second camera is calibrated with the main one, watching the same markers, if it is running.
  const { second } = state;
  const withSecond = Boolean(second.stream);
  try {
    const videos = withSecond ? [captureVideo, secondCaptureVideo] : [captureVideo];
    const { cameras: [main, other = null] } = await findScreenCorners({ videos, pattern, signal: abort.signal });
    if (abort.signal.aborted) return;
    if (!main || (withSecond && !other)) {
      els.calFailedMessage.textContent = main ? FAILED_MESSAGES.second : FAILED_MESSAGES.main;
      showScreen('failed');
      return;
    }
    state.pendingCalibration = {
      createdAt: new Date().toISOString(),
      screenAspect: window.innerHeight / window.innerWidth,
      cameraId: state.cameraId,
      cameraLabel: state.cameraLabel,
      ...(state.cameraMode ? { cameraMode: state.cameraMode } : {}),
      ...main,
      ...(other ? {
        second: {
          cameraId: second.cameraId,
          cameraLabel: second.cameraLabel,
          ...(second.cameraMode ? { cameraMode: second.cameraMode } : {}),
          ...other,
        },
      } : {}),
    };
    setOutline(els.checkOutline, main.screenCornersCamera);
    setOutline(els.checkSecondOutline, other?.screenCornersCamera ?? null);
    els.checkSecondPreview.hidden = !other;
    els.checkPreviews.classList.toggle('two', Boolean(other));
    const delay = (c) => (c.latencyMs === undefined ? 'not measured' : `${c.latencyMs} ms`);
    els.checkNote.hidden = !other;
    els.checkNote.textContent = other
      ? `Both cameras found the screen. Each green outline should run along its edges. Delay: main camera ${delay(main)}, second camera ${delay(other)}.`
      : '';
    showScreen('check');
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error(err);
    if (!abort.signal.aborted) showScreen('failed');
  } finally {
    if (state.calibrationAbort === abort) state.calibrationAbort = null;
  }
}

/** Leaves the calibration flow without changing the saved calibration. */
function cancelCalibration() {
  state.calibrationAbort?.abort();
  state.calibrationAbort = null;
  state.pendingCalibration = null;
  pattern.show(null);
  showScreen('setup');
  updateSetup();
}

function saveCalibration() {
  const calibration = state.pendingCalibration;
  if (!calibration) return;
  state.settings.calibration = calibration;
  state.settings.cameraId = calibration.cameraId;
  state.settings.cameraLabel = calibration.cameraLabel;
  if (!saveSettings(state.settings)) {
    console.warn('Calibration could not be stored in this browser; it will be lost when the page closes.');
  }
  state.pendingCalibration = null;
  showScreen('setup');
  updateSetup();
}

// ---- Events -----------------------------------------------------------------

els.start.addEventListener('click', start);
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'play') showGames();
  else if (action === 'setup') openSetup();
  else if (action === 'mouse-only') playMouseOnly();
  else if (action === 'back') goBack();
});

els.refresh.addEventListener('click', () => {
  state.second.problem = null; // try the second camera again too
  startCamera(state.cameraId || state.settings.cameraId);
});
els.cameraSelect.addEventListener('change', () => {
  if (els.cameraSelect.value) selectCamera(els.cameraSelect.value);
});
els.setupVideo.addEventListener('loadedmetadata', onVideoSize);
els.setupVideo.addEventListener('resize', onVideoSize);
els.secondSelect.addEventListener('change', () => chooseSecond(els.secondSelect.value || null));
els.secondVideo.addEventListener('loadedmetadata', onSecondVideoSize);
els.secondVideo.addEventListener('resize', onSecondVideoSize);
els.screenWidth.addEventListener('change', saveScreenWidth);

els.calibrate.addEventListener('click', startCalibration);
els.calCancel.addEventListener('click', cancelCalibration);
els.calSave.addEventListener('click', saveCalibration);
els.calRedo.addEventListener('click', startCalibration);
els.calRetry.addEventListener('click', startCalibration);
els.calFailCancel.addEventListener('click', cancelCalibration);
els.ballClear.addEventListener('click', () => ballTest.clear());

const NEXT_KEYS = ['ArrowDown', 'ArrowRight'];
const PREV_KEYS = ['ArrowUp', 'ArrowLeft'];

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // Typing in a box (the screen width) is just typing; up and down still move between controls.
  if (e.target instanceof HTMLInputElement && !['Escape', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    if (!e.repeat) toggleFullscreen();
  } else if (e.key === 'Escape') {
    goBack();
  } else if (state.screen === 'ball-test' && (e.key === 'c' || e.key === 'C')) {
    ballTest.clear();
  } else if (games[state.screen] && (e.key === 'd' || e.key === 'D')) {
    if (!e.repeat) games[state.screen].toggleDebug();
  } else if (games[state.screen]?.pressStart && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    if (!e.repeat) games[state.screen].pressStart();
  } else if (e.key === 'Enter' && state.screen === 'start' && e.target.tagName !== 'BUTTON') {
    e.preventDefault();
    start();
  } else if ((NEXT_KEYS.includes(e.key) || PREV_KEYS.includes(e.key)) && e.target.tagName !== 'SELECT') {
    const items = focusables(screens[state.screen]);
    if (items.length === 0) return;
    e.preventDefault();
    const current = items.indexOf(document.activeElement);
    const step = NEXT_KEYS.includes(e.key) ? 1 : -1;
    const next = current === -1 ? 0 : Math.min(items.length - 1, Math.max(0, current + step));
    items[next].focus();
  }
});

renderGames();
showScreen('start');
