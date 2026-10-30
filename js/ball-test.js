// Ball Test: throw a ball at the screen and a mark appears where it hit.
// Marks stay until cleared. Mouse clicks make marks too (handy for testing).

import { playThud } from './sound.js';
import { ThrowCamera, renderGameStatus } from './throw-camera.js';

// Area around a new mark that is ignored while it appears (fraction of the shorter screen side).
const MARK_SETTLE_RADIUS = 0.07;
const MARK_COLOURS = ['#ffb020', '#3ddc84', '#6cc4ff', '#ff6b8b', '#c792ea', '#ffe066'];

export class BallTest {
  /** @param {HTMLElement} root the game's screen element */
  constructor(root) {
    this.layer = root.querySelector('.hit-layer');
    this.statusEl = root.querySelector('.game-status');
    this.marks = 0;
    this.camera = new ThrowCamera(root, {
      onHit: (point) => this.addHit(point, 'ball'),
      onNote: () => this.updateStatus(),
    });
    this.camera.ignore(root.querySelector('.game-bar'));

    this.layer.addEventListener('click', (e) => {
      this.addHit({ x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }, 'mouse');
    });
    document.addEventListener('fullscreenchange', () => this.updateStatus());
  }

  /** @param {import('./storage.js').Calibration} calibration */
  start(calibration) {
    this.layer.replaceChildren();
    this.marks = 0;
    return this.camera.start(calibration);
  }

  stop() {
    this.camera.stop();
  }

  /** Removes all marks. */
  clear() {
    this.layer.replaceChildren();
    this.marks = 0;
    this.camera.lastBallHit = null;
    this.camera.pictureChangeEverywhere();
  }

  toggleDebug() {
    this.camera.toggleDebug();
  }

  /**
   * Shows a hit mark.
   * @param {{x:number, y:number}} point normalised screen coordinates
   * @param {'ball'|'mouse'} source
   */
  addHit(point, source) {
    const mark = document.createElement('div');
    mark.className = 'hit-mark';
    mark.dataset.source = source;
    mark.style.left = `${point.x * 100}%`;
    mark.style.top = `${point.y * 100}%`;
    mark.style.setProperty('--mark', MARK_COLOURS[this.marks % MARK_COLOURS.length]);
    this.layer.append(mark);
    this.marks++;
    playThud();
    this.camera.pictureChangeAround(point, MARK_SETTLE_RADIUS);
  }

  updateStatus() {
    renderGameStatus(this.statusEl, this.camera.note);
  }
}
