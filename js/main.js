// App shell: screens, navigation, keyboard handling, camera setup and calibration flow.

import { BallTest } from './ball-test.js';
import { BalloonPop } from './balloon-pop.js';
import { BrickBreaker } from './brick-breaker.js';
import { findScreenCorners } from './calibration.js';
import {
  CAMERA_MESSAGES, CameraError, findFastestMode, listCameras, openCamera, openPreferredCamera, stopStream,
} from './camera.js';
import { DemolitionDay } from './demolition-day.js';
import { calibrationStatus, cameraModeText } from './format.js';
import { GAMES } from './games.js';
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
};

// Frames for calibration are grabbed from this always-rendered (but invisible)
// video, because browsers may stop updating videos that aren't displayed.
const captureVideo = document.createElement('video');
captureVideo.className = 'capture-video';
captureVideo.muted = true;
captureVideo.playsInline = true;
captureVideo.setAttribute('aria-hidden', 'true');
document.body.append(captureVideo);

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
// ?time=25 gives every Brick Breaker wall and Demolition Day level 25 seconds, and ?level=3 starts both at
// level 3 (handy for testing).
const wallSeconds = Number(query.get('time'));
const startLevel = Math.floor(Number(query.get('level')));
const levelOptions = {
  ...(wallSeconds > 0 ? { timeMs: wallSeconds * 1000 } : {}),
  ...(startLevel > 0 ? { level: startLevel } : {}),
};
const brickBreaker = new BrickBreaker(screens['brick-breaker'], levelOptions);
const demolitionDay = new DemolitionDay(screens['demolition-day'], levelOptions);
// The games that can be played, by id (see games.js).
const games = {
  'ball-test': ballTest,
  'target-practice': targetPractice,
  'balloon-pop': balloonPop,
  'brick-breaker': brickBreaker,
  'demolition-day': demolitionDay,
};

const state = {
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
  return [...container.querySelectorAll('button, select')]
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
  if (!state.settings.calibration) {
    showScreen('needs-calibration');
    return;
  }
  // Both must be called straight from the click/key press.
  enterFullscreen();
  unlockAudio();
  showScreen(id);
  games[id].start(state.settings.calibration);
}

// ---- Setup: camera ----------------------------------------------------------

function openSetup() {
  showScreen('setup');
  startCamera(state.settings.cameraId);
}

function leaveSetup() {
  state.cameraRequest++;
  stopCamera();
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
    const fast = await reopenFastest(stream, deviceId, request);
    if (!fast) return;
    useStream(fast.stream, deviceId, cameras, fast);
    if (!state.settings.cameraId && deviceId) rememberCamera();
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
    const fast = await reopenFastest(opened.stream, opened.deviceId, request);
    if (!fast) return;
    useStream(fast.stream, opened.deviceId, state.cameras, fast);
    rememberCamera();
  } catch (err) {
    if (request !== state.cameraRequest) return;
    await showCameraProblem(err);
  }
}

/**
 * Swaps a camera just opened for the same camera in its fastest mode, which is
 * measured (see findFastestMode) before the preview starts. Resolves with the
 * stream to use, or null if another camera was asked for meanwhile.
 * @returns {Promise<{stream: MediaStream, mode: import('./camera.js').CameraMode|null, fps: number|null}|null>}
 */
async function reopenFastest(stream, deviceId, request) {
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
  state.cameraId = deviceId;
  state.speedCheck = request;
  updateSetup();
  const fastest = await findFastestMode(deviceId, largest, { wanted: () => request === state.cameraRequest });
  if (request !== state.cameraRequest) return null;
  const opened = await openCamera(deviceId, { mode: fastest?.mode ?? null });
  if (request !== state.cameraRequest) {
    stopStream(opened.stream);
    return null;
  }
  return { stream: opened.stream, mode: fastest?.mode ?? null, fps: fastest?.fps ?? null };
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

  // Keep keyboard focus on the screen if the focused control was just disabled.
  const screen = screens[state.screen];
  const focused = document.activeElement;
  if (state.screen === 'setup' && (!screen.contains(focused) || focused.disabled)) {
    focusables(screen)[0]?.focus({ preventScroll: true });
  }
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

  try {
    const result = await findScreenCorners({ video: captureVideo, pattern, signal: abort.signal });
    if (abort.signal.aborted) return;
    if (!result) {
      showScreen('failed');
      return;
    }
    state.pendingCalibration = {
      createdAt: new Date().toISOString(),
      cameraId: state.cameraId,
      cameraLabel: state.cameraLabel,
      ...(state.cameraMode ? { cameraMode: state.cameraMode } : {}),
      ...result,
    };
    setOutline(els.checkOutline, result.screenCornersCamera);
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
  else if (action === 'back') goBack();
});

els.refresh.addEventListener('click', () => startCamera(state.cameraId || state.settings.cameraId));
els.cameraSelect.addEventListener('change', () => {
  if (els.cameraSelect.value) selectCamera(els.cameraSelect.value);
});
els.setupVideo.addEventListener('loadedmetadata', onVideoSize);
els.setupVideo.addEventListener('resize', onVideoSize);

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
