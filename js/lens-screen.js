// The Measure lens screen, opened from Setup for one camera: shows its picture, finds the printed
// checkerboard in it (checkerboard.js) a few times a second, takes a view whenever the board is held still
// somewhere new (lens-capture.js), shows which parts of the picture it has covered and where it still has to
// go, then measures the lens and offers to save it. The guide is docs/ir-calibration.md, step 1.

import { findCheckerboard } from './checkerboard.js';
import { createGrabber } from './frames.js';
import { boardCorners } from './lens-calibration.js';
import { LensCapture, whereNeeded } from './lens-capture.js';
import { measuredLensText } from './format.js';

// The board in print/checkerboard-letter.svg: 9 × 6 inner corners. The size of its squares doesn't matter to
// the lens (a bigger board further away looks the same), so it isn't asked for.
const BOARD = { cols: 9, rows: 6 };
const BOARD_POINTS = boardCorners(BOARD.cols, BOARD.rows, 0.024);
// Pictures are looked at this wide at most: corners are found more precisely the more pixels they have.
const MAX_WIDTH = 1280;
// A taken view flashes green this long (ms).
const FLASH_MS = 500;

const MESSAGES = {
  none: 'Looking for the checkerboard. Hold it 1½–2 ft from the camera, the whole board in the picture.',
  moving: 'Found it. Hold it still…',
  similar: 'Got this one. Move it somewhere new, or tilt it another way.',
  taken: 'Taken!',
};

export class LensScreen {
  /**
   * @param {HTMLElement} root the screen
   * @param {{onSave: (deviceId: string, measured: import('./storage.js').MeasuredLens) => void}} options
   */
  constructor(root, { onSave }) {
    this.root = root;
    this.onSave = onSave;
    this.video = root.querySelector('video');
    this.overlay = root.querySelector('canvas');
    this.preview = root.querySelector('.preview');
    this.cameraLine = root.querySelector('#lens-camera');
    this.status = root.querySelector('#lens-status');
    this.progress = root.querySelector('#lens-progress');
    this.result = root.querySelector('#lens-result');
    this.model = root.querySelector('#lens-model');
    this.measureButton = root.querySelector('#btn-lens-measure');
    this.saveButton = root.querySelector('#btn-lens-save');
    this.clearButton = root.querySelector('#btn-lens-clear');
    this.measureButton.addEventListener('click', () => this.measure());
    this.saveButton.addEventListener('click', () => this.save());
    this.clearButton.addEventListener('click', () => this.clear());
    this.session = 0;
    this.deviceId = null;
    this.grabber = null;
    this.capture = null;
    this.measured = null;
    this.lastCorners = null;
    this.lastResult = 'none';
    this.flashUntil = 0;
  }

  /**
   * Starts on a camera's running stream (Setup's).
   * @param {{stream: MediaStream, deviceId: string, label: string, saved: import('./storage.js').MeasuredLens|null}} camera
   */
  open({ stream, deviceId, label, saved }) {
    const session = ++this.session;
    this.deviceId = deviceId;
    this.grabber = null;
    this.capture = null;
    this.measured = null;
    this.cameraLine.textContent = `${label}. ${saved ? `Measured before: ${measuredLensText(saved)}.` : 'Not measured yet.'}`;
    this.result.textContent = '';
    this.saveButton.hidden = true;
    this.video.srcObject = stream;
    this.video.play().catch(() => {});
    const tick = () => {
      if (session !== this.session) return;
      this.step();
      // The next picture once this one is done, so a slow computer just looks less often.
      setTimeout(tick, 30);
    };
    tick();
  }

  close() {
    this.session++;
    this.video.srcObject = null;
    this.video.classList.remove('live');
  }

  /** Looks at the camera's picture now. */
  step() {
    const { video } = this;
    if (!video.videoWidth || video.readyState < 2) return;
    if (!this.grabber || this.grabber.sourceWidth !== video.videoWidth || this.grabber.sourceHeight !== video.videoHeight) {
      this.grabber = createGrabber(video, MAX_WIDTH);
      this.grabber.sourceWidth = video.videoWidth;
      this.grabber.sourceHeight = video.videoHeight;
      this.capture = new LensCapture({ board: BOARD_POINTS, imageWidth: this.grabber.width, imageHeight: this.grabber.height });
      this.preview.style.setProperty('--ar', String(video.videoWidth / video.videoHeight));
      video.classList.add('live');
    }
    const { width, height } = this.grabber;
    const found = findCheckerboard(this.grabber.grab(), width, height, BOARD);
    const now = performance.now();
    this.lastCorners = found?.corners ?? null;
    this.lastResult = this.capture.offer(this.lastCorners, now);
    if (this.lastResult === 'taken') this.flashUntil = now + FLASH_MS;
    this.draw(now);
    this.updateText(now);
  }

  updateText(now) {
    const ready = this.capture.readiness();
    const flashing = now < this.flashUntil;
    this.status.textContent = flashing ? MESSAGES.taken : MESSAGES[this.lastResult === 'taken' ? 'similar' : this.lastResult];
    const needed = whereNeeded(this.capture.coverage().counts);
    const parts = [`${ready.views} view${ready.views === 1 ? '' : 's'}`, `${Math.round(ready.covered * 100)}% of the picture covered`];
    let advice;
    if (ready.good) advice = 'That’s plenty: press Measure.';
    else if (needed.length) advice = `Still needed: ${needed.slice(0, 3).join(', ')}. Push the board right into it, tilted.`;
    else advice = `Keep going, tilting it a different way each time (about ${this.capture.opts.goodViews} views in all).`;
    this.progress.textContent = `${parts.join(' · ')}. ${advice}`;
    this.measureButton.disabled = !ready.canMeasure;
  }

  /** The coverage grid and the corners found, over the picture. */
  draw(now) {
    const canvas = this.overlay;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const { counts } = this.capture.coverage();
    const rows = counts.length;
    const cols = counts[0].length;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = (c * w) / cols;
        const y = (r * h) / rows;
        if (counts[r][c]) {
          ctx.fillStyle = `rgba(61, 220, 132, ${Math.min(0.35, 0.08 + counts[r][c] / 400)})`;
          ctx.fillRect(x, y, w / cols, h / rows);
        }
        ctx.strokeStyle = counts[r][c] ? 'rgba(61, 220, 132, 0.5)' : 'rgba(255, 120, 90, 0.6)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w / cols - 1, h / rows - 1);
      }
    }
    const corners = this.lastCorners;
    if (!corners) return;
    const colour = now < this.flashUntil ? '#3ddc84' : this.lastResult === 'moving' ? '#ffd23f' : '#ffffff';
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = 2;
    for (let r = 0; r < BOARD.rows; r++) {
      ctx.beginPath();
      for (let c = 0; c < BOARD.cols; c++) {
        const p = corners[r * BOARD.cols + c];
        if (c === 0) ctx.moveTo(p.x * w, p.y * h); else ctx.lineTo(p.x * w, p.y * h);
      }
      ctx.stroke();
    }
    // The first corner a little bigger, so it can be seen which way round the board was taken.
    corners.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, i === 0 ? 6 : 3, 0, 2 * Math.PI);
      ctx.fill();
    });
  }

  measure() {
    if (!this.capture?.readiness().canMeasure) return;
    this.result.textContent = 'Measuring…';
    // Let that show before the measuring holds up the page for a moment.
    setTimeout(() => {
      const result = this.capture.measure({ model: this.model.value === 'fisheye' ? 'fisheye' : 'brown' });
      if (!result) {
        this.result.textContent = 'It couldn’t be measured from these views. Press Start again and take them again.';
        return;
      }
      this.measured = {
        lens: result.lens,
        rmsPixels: result.rmsPixels,
        views: result.used,
        width: this.grabber.width,
        height: this.grabber.height,
        measuredAt: new Date().toISOString(),
      };
      const dropped = result.dropped ? ` (${result.dropped} that didn’t fit left out)` : '';
      let verdict = '';
      if (result.rmsPixels > 2) verdict = ' That is far off: is the board flat, and is the camera’s picture not mirrored? Start again.';
      else if (result.rmsPixels > 1) verdict = ' That is more than it should be: a view may have been blurred or the board bent. Consider starting again.';
      else if (!this.capture.readiness().good) verdict = ' More views, reaching every corner, would measure it better.';
      this.result.textContent = `Measured: ${measuredLensText(this.measured)}, from ${result.used} views${dropped}.${verdict}`;
      this.saveButton.hidden = false;
    }, 30);
  }

  save() {
    if (!this.measured || !this.deviceId) return;
    this.onSave(this.deviceId, this.measured);
    this.result.textContent = `Saved: ${measuredLensText(this.measured)}.`;
    this.saveButton.hidden = true;
  }

  clear() {
    this.capture?.clear();
    this.measured = null;
    this.result.textContent = '';
    this.saveButton.hidden = true;
  }
}
