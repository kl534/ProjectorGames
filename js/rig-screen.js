// The Measure the IR rig screen, opened from Setup with its two cameras (the IR pair): the wall markers'
// measured places (step 2's table), placing the cameras from them, the wand, and the picture placed on the
// wall by a webcam with the IR cameras' delay (docs/ir-calibration.md, steps 2–4), then saved as the games'
// calibration. Each camera's frames are read as they come (a clone of its track, so Setup's preview is left
// alone), its bright spots found (ir-spots.js) and fed to whichever step is collecting; the steps themselves
// are rig-build.js's.

import { captureTimeOf, createGrabber, readFrames } from './frames.js';
import { SpotAverager, findSpots, movingSpots } from './ir-spots.js';
import { centreOf } from './lens.js';
import { irDelays, placeCameras, placePicture, refineCameras, rigFromSteps } from './rig-build.js';

const INCH = 0.0254;
const FOOT = 0.3048;
// Still spots are averaged over this long (ms).
const STILL_MS = 1000;
// The wand is collected for at most this long (ms); the LED's blinks for this long.
const WAND_MAX_MS = 90000;
const BLINK_MS = 8000;
// Pictures are looked at this wide at most (the IR cameras give 640).
const MAX_WIDTH = 640;

/**
 * @typedef {{id: string, x: number, y: number}} SavedMarker a marker's place in the wall frame (metres): across
 *   from the top-left marker, and down
 * @typedef {object} RigCameraIn
 * @property {MediaStream} stream @property {string} deviceId @property {string} label
 * @property {import('./lens.js').Lens|null} lens measured in Setup (Measure lens…)
 * @property {import('./camera.js').CameraMode|null} mode
 * @property {boolean} upsideDown mounted upside down (ticked in Setup): its picture is shown turned round
 */

export class RigScreen {
  /**
   * @param {HTMLElement} root
   * @param {object} hooks
   * @param {(markers: SavedMarker[]) => void} hooks.saveMarkers
   * @param {(calibration: import('./storage.js').Calibration) => void} hooks.saveRig
   * @param {(deviceId: string) => Promise<MediaStream>} hooks.openWebcam
   * @param {(deviceId: string) => boolean} hooks.isUpsideDown whether a camera is mounted upside down
   * @param {(video: HTMLVideoElement, whileDark: () => Promise<void>) => Promise<object|null>} hooks.calibrateWebcam
   *   runs the flashing-corner calibration with the webcam, then calls whileDark with the projected picture still
   *   black; gives its calibration (cameraToScreen, latencyMs…), or null
   */
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.$ = (sel) => root.querySelector(sel);
    this.previews = [0, 1].map((i) => {
      const el = this.$(`#rig-preview-${i}`);
      return { el, video: el.querySelector('video'), canvas: el.querySelector('canvas'), caption: el.querySelector('.rig-caption') };
    });
    this.webcamPreview = (() => {
      const el = this.$('#rig-webcam-preview');
      return { el, video: el.querySelector('video'), canvas: el.querySelector('canvas'), caption: null };
    })();
    this.$('#btn-rig-add-marker').addEventListener('click', () => this.addMarker());
    this.$('#rig-units').addEventListener('change', () => this.renderMarkers());
    this.$('#btn-rig-place').addEventListener('click', () => this.place());
    this.$('#btn-rig-wand').addEventListener('click', () => this.wandButton());
    this.$('#rig-webcam').addEventListener('change', () => this.chooseWebcam());
    this.$('#btn-rig-picture').addEventListener('click', () => this.findPicture());
    this.$('#btn-rig-blink').addEventListener('click', () => this.blink());
    this.$('#btn-rig-save').addEventListener('click', () => this.save());
    this.session = 0;
    this.eyes = [];
    this.webcam = null;
  }

  /**
   * @param {object} args
   * @param {RigCameraIn[]} args.cameras the two IR cameras (Setup's main and second)
   * @param {SavedMarker[]} args.markers saved before
   * @param {{deviceId: string, label: string}[]} args.webcams the other cameras, for step 4
   */
  open({ cameras, markers, webcams }) {
    this.close();
    const session = ++this.session;
    this.markers = markers.length ? markers.map((m) => ({ ...m })) : defaultMarkers();
    this.cameras = cameras;
    this.step2 = null;
    this.step3 = null;
    this.step4 = null;
    this.delays = null;
    this.wanding = null;
    this.$('#rig-cameras').textContent = cameras.map((c, i) => `${i ? 'Right' : 'Left'}: ${c.label}`).join(' · ');
    this.eyes = cameras.map((c, i) => this.startEye(session, this.previews[i], c.stream, c.label, c.upsideDown));
    const select = this.$('#rig-webcam');
    select.replaceChildren(new Option('Choose the webcam…', ''), ...webcams.map((w) => new Option(w.label, w.deviceId)));
    this.webcamPreview.el.hidden = true;
    this.renderMarkers();
    for (const id of ['#rig-place-result', '#rig-wand-status', '#rig-picture-status', '#rig-blink-status']) this.$(id).textContent = '';
    const missing = cameras.filter((c) => !c.lens).map((c) => c.label);
    this.$('#rig-lens-note').textContent = missing.length
      ? `Measure the lens of ${missing.join(' and ')} first (Setup → Measure lens…), in this camera mode.` : '';
    this.update();
  }

  close() {
    this.session++;
    for (const eye of [...this.eyes, this.webcam].filter(Boolean)) eye.stop();
    this.eyes = [];
    if (this.webcam?.ownStream) this.webcam.ownStream.getTracks().forEach((t) => t.stop());
    this.webcam = null;
    this.collecting = null;
  }

  // ---- Cameras ----

  /**
   * Shows a camera and finds the spots in every frame it gives. A camera mounted upside down is shown turned
   * round (CSS on the video; the overlay is drawn turned in `draw`, so its numbers stay upright); the spots
   * stay in the camera's own picture.
   */
  startEye(session, preview, stream, label, upsideDown = false) {
    preview.el.classList.toggle('upside-down', upsideDown);
    const eye = {
      preview, label, upsideDown, spots: [], still: null, matched: null, frames: 0, width: 0, height: 0, grabber: null,
      listeners: new Set(), stop: () => {},
    };
    preview.video.srcObject = stream;
    preview.video.play().catch(() => {});
    const track = stream.getVideoTracks()[0]?.clone();
    const onFrame = (source, time) => {
      if (session !== this.session) return;
      const video = preview.video;
      if (!video.videoWidth) return;
      if (!eye.grabber) {
        eye.grabber = createGrabber(video, MAX_WIDTH);
        eye.width = eye.grabber.width;
        eye.height = eye.grabber.height;
        preview.el.style.setProperty('--ar', String(video.videoWidth / video.videoHeight));
        video.classList.add('live');
      }
      eye.spots = findSpots(eye.grabber.grab(source), eye.width, eye.height);
      eye.frames++;
      for (const listener of eye.listeners) listener(eye.spots, time);
      if (eye.frames % 4 === 0) this.draw(eye);
    };
    const reader = track ? readFrames(track, onFrame) : null;
    if (reader) {
      eye.stop = () => { reader.stop(); track.stop(); };
    } else {
      // Without the track reader: the video's frames, once a screen refresh each.
      let stopped = false;
      const tick = (now, meta) => {
        if (stopped) return;
        onFrame(preview.video, captureTimeOf(meta, now) ?? now);
        preview.video.requestVideoFrameCallback(tick);
      };
      preview.video.requestVideoFrameCallback(tick);
      eye.stop = () => { stopped = true; track?.stop(); };
    }
    return eye;
  }

  /** The spots a camera finds, and once placed which marker each is, over its picture. */
  draw(eye) {
    const { canvas } = eye.preview;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 2;
    ctx.font = '600 13px system-ui, sans-serif';
    // Where a spot in the camera's picture is shown.
    const shown = (s) => (eye.upsideDown ? { x: 1 - s.x, y: 1 - s.y } : s);
    for (const spot of eye.spots) {
      const s = shown(spot);
      ctx.strokeStyle = '#ffd23f';
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, 7, 0, 2 * Math.PI);
      ctx.stroke();
    }
    (eye.matched ?? []).forEach((spot, i) => {
      if (!spot) return;
      const s = shown(spot);
      ctx.strokeStyle = '#3ddc84';
      ctx.fillStyle = '#3ddc84';
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, 10, 0, 2 * Math.PI);
      ctx.stroke();
      // Its number in the table (names would crowd each other), beside the ring and kept inside the picture:
      // below it near the top, to its left near the right edge.
      const label = String(i + 1);
      const right = s.x * w + 12 + ctx.measureText(label).width > w;
      ctx.textAlign = right ? 'right' : 'left';
      ctx.fillText(label, s.x * w + (right ? -12 : 12), s.y * h + (s.y * h < 20 ? 22 : -8));
      ctx.textAlign = 'left';
    });
  }

  /**
   * Collects from every camera for `ms`: each frame's spots go to `onFrame(index, spots, time)`.
   * @returns {Promise<void>}
   */
  collect(eyes, ms, onFrame) {
    return new Promise((resolve) => {
      const listeners = eyes.map((eye, i) => {
        const listener = (spots, time) => onFrame(i, spots, time);
        eye.listeners.add(listener);
        return listener;
      });
      const finish = () => {
        eyes.forEach((eye, i) => eye.listeners.delete(listeners[i]));
        this.collecting = null;
        resolve();
      };
      this.collecting = { finish };
      setTimeout(() => this.collecting?.finish === finish && finish(), ms);
    });
  }

  /** Each camera's still spots, averaged over a second. */
  async stillSpots(eyes) {
    const averagers = eyes.map((eye) => new SpotAverager({ width: eye.width || MAX_WIDTH, height: eye.height || MAX_WIDTH * 0.625 }));
    await this.collect(eyes, STILL_MS, (i, spots) => averagers[i].add(spots));
    return averagers.map((a) => a.result());
  }

  // ---- Step 1: the markers' table ----

  renderMarkers() {
    const unit = this.$('#rig-units').value === 'in' ? INCH : 0.001;
    const digits = unit === INCH ? 2 : 0;
    const body = this.$('#rig-markers tbody');
    body.replaceChildren(...this.markers.map((m, i) => {
      const row = document.createElement('tr');
      const cell = (input) => { const td = document.createElement('td'); td.append(input); return td; };
      const index = document.createElement('span');
      index.textContent = String(i + 1);
      const name = Object.assign(document.createElement('input'), { type: 'text', value: m.id, ariaLabel: `Marker ${i + 1} name` });
      name.addEventListener('change', () => { m.id = name.value.trim() || `marker ${i + 1}`; this.markersChanged(); });
      const number = (key, label) => {
        const input = Object.assign(document.createElement('input'), {
          type: 'number', step: 'any', inputMode: 'decimal', value: String(Number((m[key] / unit).toFixed(digits))), ariaLabel: `${m.id} ${label}`,
        });
        input.addEventListener('change', () => {
          const v = Number(input.value);
          if (Number.isFinite(v)) { m[key] = v * unit; this.markersChanged(); }
        });
        return input;
      };
      const remove = Object.assign(document.createElement('button'), { className: 'btn btn-small', textContent: 'Remove', type: 'button' });
      remove.addEventListener('click', () => { this.markers.splice(i, 1); this.markersChanged(); this.renderMarkers(); });
      row.append(cell(index), cell(name), cell(number('x', 'across')), cell(number('y', 'down')), cell(remove));
      return row;
    }));
  }

  addMarker() {
    this.markers.push({ id: `marker ${this.markers.length + 1}`, x: 0, y: 0 });
    this.markersChanged();
    this.renderMarkers();
  }

  markersChanged() {
    this.hooks.saveMarkers(this.markers.map((m) => ({ ...m })));
    // Whatever was placed from the old places is out of date.
    this.step2 = null;
    this.step3 = null;
    this.eyes.forEach((eye) => { eye.matched = null; });
    this.$('#rig-place-result').textContent = '';
    this.update();
  }

  /** The markers as rig.js wants them. */
  rigMarkers() {
    return this.markers.map((m) => ({ id: m.id, at: { x: m.x, y: m.y, z: 0 } }));
  }

  // ---- Step 2: placing the cameras ----

  async place() {
    if (this.collecting || this.cameras.some((c) => !c.lens)) return;
    const out = this.$('#rig-place-result');
    out.textContent = 'Hold still: looking at the markers for a second…';
    this.update();
    const still = await this.stillSpots(this.eyes);
    const markers = this.rigMarkers();
    const result = placeCameras({
      markers, cameras: this.cameras.map((c, i) => ({ lens: c.lens, still: still[i], width: this.eyes[i].width })),
    });
    this.eyes.forEach((eye, i) => { eye.still = still[i]; eye.matched = result.cameras[i].matched; this.draw(eye); });
    this.step2 = result.ok ? result : null;
    this.step3 = null;
    out.replaceChildren(...result.cameras.map((c, i) => line(`${i ? 'Right' : 'Left'} camera: ${placedText(c)}`)));
    this.update();
  }

  // ---- Step 3: the wand ----

  wandButton() {
    if (this.wanding) this.finishWand();
    else this.startWand();
  }

  startWand() {
    if (!this.step2 || this.collecting) return;
    const frames = [[], []];
    this.wanding = { frames, since: performance.now() };
    const status = this.$('#rig-wand-status');
    const still = this.eyes.map((eye) => eye.still);
    const done = this.collect(this.eyes, WAND_MAX_MS, (i, spots, time) => {
      const eye = this.eyes[i];
      const moving = movingSpots(spots, still[i], eye.width, eye.height);
      if (moving.length === 2) frames[i].push({ t: time, ends: moving.map((s) => ({ x: s.x, y: s.y })) });
      if (i === 0 && eye.frames % 30 === 0) {
        const secs = Math.round((performance.now() - this.wanding.since) / 1000);
        status.textContent = `Wave it slowly through where the ball flies, every way round: ${secs} s, `
          + `${frames[0].length} and ${frames[1].length} frames of both ends. Press Finish after half a minute or so.`;
      }
    });
    done.then(() => { if (this.wanding?.frames === frames) this.finishWand(); });
    this.update();
  }

  finishWand() {
    const { frames } = this.wanding;
    this.wanding = null;
    this.collecting?.finish();
    const status = this.$('#rig-wand-status');
    const length = Number(this.$('#rig-wand-length').value) / 1000;
    if (!(length > 0.1)) {
      status.textContent = 'Enter the wand\'s length (mm, between its markers\' centres), then wave it again.';
      this.update();
      return;
    }
    const result = refineCameras({ markers: this.rigMarkers(), placed: this.step2.cameras, wand: frames, length, width: this.eyes[0].width });
    if (!result) {
      status.textContent = 'Both cameras didn\'t see both ends together often enough: wave it where both see it, and try again.';
      this.step3 = null;
    } else {
      this.step3 = result.problem && result.markersSay ? null : result;
      const mm = (m) => `${(m * 1000).toFixed(1)} mm`;
      status.replaceChildren(
        line(`${result.samples} moments both cameras saw both ends. The wand comes out ${mm(result.lengthMean)} on average (each moment within ${mm(result.lengthRms)}).`),
        line(`Left camera: ${whereText(result.cameras[0])}. Right camera: ${whereText(result.cameras[1])}.`),
        ...(result.problem ? [line(result.problem, 'problem')] : []),
      );
    }
    this.update();
  }

  // ---- Step 4: the picture and the delays ----

  async chooseWebcam() {
    const id = this.$('#rig-webcam').value;
    if (this.webcam) {
      this.webcam.stop();
      this.webcam.ownStream?.getTracks().forEach((t) => t.stop());
      this.webcam = null;
    }
    this.step4 = null;
    this.delays = null;
    this.webcamPreview.el.hidden = !id;
    if (id) {
      const session = this.session;
      const stream = await this.hooks.openWebcam(id);
      if (session !== this.session) { stream.getTracks().forEach((t) => t.stop()); return; }
      const label = this.$('#rig-webcam').selectedOptions[0]?.text ?? 'Webcam';
      this.webcam = this.startEye(session, this.webcamPreview, stream, label, this.hooks.isUpsideDown(id));
      this.webcam.ownStream = stream;
    }
    this.update();
  }

  async findPicture() {
    if (!this.webcam || this.collecting) return;
    const status = this.$('#rig-picture-status');
    status.textContent = 'Finding the picture…';
    let still = null;
    const calibration = await this.hooks.calibrateWebcam(this.webcamPreview.video, async () => {
      [still] = await this.stillSpots([this.webcam]);
    });
    if (!calibration || !still) {
      status.textContent = 'The webcam couldn\'t find the picture\'s corners: it must see the whole projected picture.';
      this.update();
      return;
    }
    this.webcam.still = still;
    const video = this.webcamPreview.video;
    const result = placePicture({
      markers: this.rigMarkers(), still, cameraToScreen: calibration.cameraToScreen, imageAspect: video.videoHeight / video.videoWidth,
    });
    this.step4 = result.screen ? { ...result, latencyMs: calibration.latencyMs ?? null } : null;
    this.delays = null;
    status.replaceChildren(
      ...(result.screen ? [line(`The picture is ${feetText(result.screen.width)} wide (${result.found} markers seen).`)] : []),
      ...(result.problem ? [line(result.problem, 'problem')] : []),
    );
    this.update();
  }

  async blink() {
    if (!this.webcam?.still || !this.step2 || this.collecting) return;
    const status = this.$('#rig-blink-status');
    status.textContent = 'Hold an LED where all three cameras see it, and cover and uncover it with your hand, five or six times, irregularly…';
    this.update();
    const all = [this.webcam, ...this.eyes];
    const lit = all.map(() => []);
    await this.collect(all, BLINK_MS, (i, spots, time) => {
      const eye = all[i];
      lit[i].push({ t: time, lit: movingSpots(spots, eye.still ?? [], eye.width, eye.height).length > 0 });
    });
    if (this.step4.latencyMs === null) {
      status.textContent = 'The webcam\'s own delay wasn\'t measured: find the picture again.';
      this.update();
      return;
    }
    const result = irDelays({ webcamLatencyMs: this.step4.latencyMs, webcam: lit[0], cameras: lit.slice(1) });
    this.delays = result.latencyMs ? result : null;
    status.textContent = result.problem ?? `Delays: left camera ${Math.round(result.latencyMs[0])} ms, right ${Math.round(result.latencyMs[1])} ms.`;
    this.update();
  }

  // ---- Saving ----

  save() {
    if (!this.step2 || !this.step4?.screen) return;
    const rigCameras = this.step3 ? this.step3.cameras : this.step2.cameras.map((c) => c.placed);
    const calibration = rigFromSteps({
      cameras: rigCameras,
      screen: this.step4.screen,
      info: this.cameras.map((c, i) => ({
        cameraId: c.deviceId, cameraLabel: c.label, videoWidth: this.eyes[i].width, videoHeight: this.eyes[i].height,
        ...(c.mode ? { cameraMode: c.mode } : {}),
      })),
      latencyMs: this.delays?.latencyMs ?? null,
    });
    this.hooks.saveRig(calibration);
    this.$('#rig-status').textContent = 'Saved: the games now use the IR cameras.';
  }

  /** Which buttons can be pressed, and what the screen says overall. */
  update() {
    const busy = Boolean(this.collecting) && !this.wanding;
    const lenses = this.cameras?.every((c) => c.lens);
    const enoughMarkers = (this.markers?.length ?? 0) >= 4;
    this.$('#btn-rig-place').disabled = busy || !lenses || !enoughMarkers;
    const wand = this.$('#btn-rig-wand');
    wand.disabled = !this.step2 || (busy && !this.wanding);
    wand.textContent = this.wanding ? 'Finish' : 'Start waving';
    this.$('#btn-rig-picture').disabled = busy || !this.webcam;
    this.$('#btn-rig-blink').disabled = busy || !this.step4 || !this.step2;
    this.$('#btn-rig-save').disabled = !this.step2 || !this.step4;
    const status = this.$('#rig-status');
    if (!lenses) status.textContent = 'Measure both cameras\' lenses first.';
    else if (!enoughMarkers) status.textContent = 'Enter at least four markers.';
    else if (!this.step2) status.textContent = 'Next: place the cameras.';
    else if (!this.step3) status.textContent = 'Next: the wand (it fixes the cameras to each other, for right speeds).';
    else if (!this.step4) status.textContent = 'Next: find the picture with the webcam.';
    else if (!this.delays) status.textContent = 'Next: time the cameras with the LED (or save without: their delay will be a guess).';
    else status.textContent = 'All measured: save the rig.';
  }
}

/** Four corners and the top middle of a 3 m × 1.75 m rectangle round the screen: a start to edit. */
function defaultMarkers() {
  return [
    { id: 'top-left', x: 0, y: 0 }, { id: 'top-middle', x: 1.5, y: 0 }, { id: 'top-right', x: 3, y: 0 },
    { id: 'bottom-right', x: 3, y: 1.75 }, { id: 'bottom-left', x: 0, y: 1.75 },
  ];
}

function line(text, kind = '') {
  const p = document.createElement('span');
  p.className = `rig-line ${kind}`;
  p.textContent = text;
  return p;
}

const feetText = (m) => `${(m / FOOT).toFixed(1)} ft`;

/** Where a placed camera is, from the top-left marker: across, up from it, and out from the wall. */
function whereText(camera) {
  const c = centreOf(camera.pose);
  const across = c.x >= 0 ? `${feetText(c.x)} right of` : `${feetText(-c.x)} left of`;
  const up = c.y <= 0 ? `${feetText(-c.y)} above` : `${feetText(c.y)} below`;
  return `${across} and ${up} the top-left marker, ${feetText(-c.z)} out from the wall`;
}

function placedText(c) {
  if (!c.placed) return c.problem;
  const missing = c.missing.length ? ` (not seen: ${c.missing.join(', ')})` : '';
  return `${c.found} markers${missing}, ${c.rmsPixels.toFixed(2)} px off; ${whereText(c.placed)}.`;
}
