// Ball Test: throw a ball at the screen and a mark appears where it hit.
// Marks stay until cleared. Mouse clicks make marks too (handy for testing).
//
// Like every game, it uses the second camera too, if one was calibrated. With
// the camera view on (D), it also shows everything the cameras pick up: each camera's mode,
// frame rate, delay and where it seems to be, and for each throw what each
// camera followed and why it was or wasn't a hit, plus, where both cameras
// saw it, its speed and where its flight meets the wall. With two cameras,
// each camera's own hit spot is marked (a ring numbered 1 or 2), and the
// flight's (a diamond), next to the hit that counted.

import { cameraSummary, hitSpeedText, throwSummary } from './format.js';
import { playThud } from './sound.js';
import { ThrowCamera, renderGameStatus } from './throw-camera.js';

// Area around a new mark that is ignored while it appears (fraction of the shorter screen side).
const MARK_SETTLE_RADIUS = 0.07;
const MARK_COLOURS = ['#ffb020', '#3ddc84', '#6cc4ff', '#ff6b8b', '#c792ea', '#ffe066'];
// Throws listed in the data, newest first.
const THROWS_SHOWN = 4;
// The cameras' lines are refreshed this often (ms) while the data shows.
const INFO_EVERY_MS = 500;

export class BallTest {
  /** @param {HTMLElement} root the game's screen element */
  constructor(root) {
    this.layer = root.querySelector('.hit-layer');
    this.statusEl = root.querySelector('.game-status');
    this.dataEl = root.querySelector('.bt-data');
    this.camerasEl = root.querySelector('.bt-cameras');
    this.throwsEl = root.querySelector('.bt-throws');
    this.marks = 0;
    this.infoTimer = null;
    this.camera = new ThrowCamera(root, {
      onHit: (hit) => this.addHit(hit, 'ball'),
      onNote: () => this.updateStatus(),
      onThrow: (seen) => this.addThrow(seen),
    });
    this.camera.ignore(root.querySelector('.game-bar'), this.dataEl);

    this.layer.addEventListener('click', (e) => {
      this.addHit({ x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }, 'mouse');
    });
    document.addEventListener('fullscreenchange', () => this.updateStatus());
  }

  /** @param {import('./storage.js').Calibration|null} calibration */
  start(calibration) {
    this.layer.replaceChildren();
    this.throwsEl.replaceChildren();
    this.marks = 0;
    this.showData(this.camera.debug);
    return this.camera.start(calibration);
  }

  stop() {
    this.camera.stop();
    this.showData(false);
  }

  /** Removes all marks. */
  clear() {
    this.layer.replaceChildren();
    this.marks = 0;
    this.camera.clearMarks();
    this.camera.pictureChangeEverywhere();
  }

  toggleDebug() {
    this.showData(!this.camera.debug);
    this.camera.toggleDebug();
  }

  /** Shows or hides what the cameras pick up, with the camera view. */
  showData(show) {
    this.dataEl.hidden = !show;
    clearInterval(this.infoTimer);
    this.infoTimer = null;
    // The marks for where each camera put a hit show with it.
    if (this.layer.classList.toggle('show-camera-marks', show) !== show || this.layer.querySelector('.hit-spot')) {
      this.camera.pictureChangeEverywhere();
    }
    if (!show) return;
    this.updateCameras();
    this.infoTimer = setInterval(() => this.updateCameras(), INFO_EVERY_MS);
  }

  updateCameras() {
    const info = this.camera.cameraInfo();
    this.camerasEl.replaceChildren(...info.map((c) => item('li', cameraSummary(c, this.camera.screenWidthFt))));
  }

  /**
   * Shows a hit mark, with the ball's speed under it where two cameras followed it in.
   * @param {{x:number, y:number}|import('./throw-tracker.js').Hit} point normalised screen coordinates
   * @param {'ball'|'mouse'} source
   */
  addHit(point, source) {
    const mark = document.createElement('div');
    mark.className = 'hit-mark';
    mark.dataset.source = source;
    mark.style.left = `${point.x * 100}%`;
    mark.style.top = `${point.y * 100}%`;
    mark.style.setProperty('--mark', MARK_COLOURS[this.marks % MARK_COLOURS.length]);
    const speed = hitSpeedText(point);
    if (speed) {
      const label = document.createElement('span');
      label.className = 'hit-speed';
      label.textContent = speed;
      mark.append(label);
    }
    this.layer.append(mark);
    this.marks++;
    playThud();
    this.camera.pictureChangeAround(point, MARK_SETTLE_RADIUS);
  }

  /** @param {import('./throw-tracker.js').ThrowSeen} seen */
  addThrow(seen) {
    const entry = document.createElement('li');
    entry.dataset.throw = String(seen.id);
    entry.append(...throwSummary(seen, this.camera.screenWidthFt).map((line) => item('p', line)));
    this.throwsEl.prepend(entry);
    while (this.throwsEl.children.length > THROWS_SHOWN) this.throwsEl.lastElementChild.remove();
    // Where each camera, and the flight, put it (with one camera, that is the mark itself).
    if (this.camera.eyes.length < 2) return;
    for (const track of seen.tracks) {
      if (track.hit) this.addSpot(track.hit, 'camera', String(track.camera + 1));
    }
    if (seen.room?.flight?.hit) this.addSpot(seen.room.flight.hit, 'room', '');
  }

  /** A small mark for where one camera, or the flight, put a hit; shown with the camera view. */
  addSpot(point, kind, label) {
    if (!(point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)) return;
    const spot = document.createElement('div');
    spot.className = `hit-spot hit-spot-${kind}`;
    spot.textContent = label;
    spot.style.left = `${point.x * 100}%`;
    spot.style.top = `${point.y * 100}%`;
    if (this.camera.debug) this.camera.pictureChangeAround(point, 0.03);
    this.layer.append(spot);
  }

  updateStatus() {
    renderGameStatus(this.statusEl, this.camera.note);
  }
}

function item(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}
