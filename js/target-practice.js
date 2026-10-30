// Target Practice: bullseye targets pop up around the screen; hit them before
// they fade away. Everyone throws together for one shared score in a timed
// round. The centre ring is worth most. The game gets a little faster and the
// targets a little smaller as the round goes on.
//
// Rounds start (and restart) by hitting the big Start target, so nobody needs
// to walk over to the computer; Enter, Space or a click work too.
//
// Everything the game draws appears, animates and disappears in short bursts,
// and each burst is reported to the camera (pictureChange…) so the projector's
// own picture is never mistaken for a ball. Targets are perfectly still while
// they can be hit.

import { loadBestScore, saveBestScore } from './storage.js';
import { playBeep, playDing, playFanfare, playThud, playTick } from './sound.js';
import {
  TARGET_PRACTICE_RULES, difficulty, findHit, pickSpot,
} from './target-practice-logic.js';
import { ThrowCamera, rectOf, renderGameStatus } from './throw-camera.js';

export const GAME_ID = 'target-practice';

// Animation lengths; these match css/style.css.
const POP_MS = 250; // a target appearing
const BURST_MS = 350; // a target being hit
const FADE_MS = 400; // a target timing out
const SPLAT_MS = 1200; // the mark left by a miss
const FLOAT_MS = 900; // "+25" floating up from a hit
const COUNT_STEP_MS = 800; // each of 3, 2, 1, Go!

const SPLAT_RADIUS = 0.035; // fraction of the shorter screen side
const FLOAT_RISE = 0.12; // how far "+25" floats up (same unit)
// Huge, so anyone can hit it: over half the screen height across. It may rest on the counter.
const START_TARGET = { x: 0.5, y: 0.62, r: 0.3 };
// After a round ends, the Play again target appears this much later, so a ball
// still in the air can't start the next round by accident.
const REARM_MS = 1500;
const LAST_SECONDS = 5; // the clock turns red and ticks
// Targets stay off the background's tent canopy and prize counter (img/carnival.svg).
const SCENERY = [{ x0: 0, y0: 0, x1: 1, y1: 0.14 }, { x0: 0, y0: 0.86, x1: 1, y1: 1 }];

export const TARGET_PRACTICE_TEXT = {
  title: 'Target Practice',
  timeUp: 'Time’s up!',
  startPrompt: 'Throw a ball at the target to start!',
  startLabel: 'START',
  againLabel: 'PLAY AGAIN',
  best: (score) => `Best score: ${score}`,
  newBest: 'New best score!',
  result: (score) => `You scored ${score} point${score === 1 ? '' : 's'}`,
};

export class TargetPractice {
  /**
   * @param {HTMLElement} root the game's screen element
   * @param {{roundMs?: number}} [options]
   */
  constructor(root, { roundMs = TARGET_PRACTICE_RULES.roundMs } = {}) {
    this.root = root;
    this.roundMs = roundMs;
    this.field = root.querySelector('.tp-field');
    this.hud = root.querySelector('.tp-hud');
    this.scoreEl = root.querySelector('.tp-score b');
    this.timeEl = root.querySelector('.tp-time');
    this.panel = root.querySelector('.tp-panel');
    this.countdownEl = root.querySelector('.tp-countdown');
    this.bar = root.querySelector('.game-bar');
    this.statusEl = root.querySelector('.game-status');

    this.session = 0; // increments when the game starts or stops, so stale timers can tell
    this.state = 'ready'; // 'ready' | 'countdown' | 'playing' | 'over'
    this.targets = []; // targets that can be hit: {x, y, r, el, expiresAt}
    this.startTarget = null; // the Start / Play again target, when shown
    this.spawning = 0; // targets waiting to appear
    this.score = 0;
    this.best = 0;
    this.endsAt = 0;
    this.lastSecond = null;

    this.camera = new ThrowCamera(root, {
      onHit: (point) => this.throwAt(point, 'ball'),
      onNote: () => this.updateStatus(),
    });
    this.camera.ignore(this.bar, this.hud);

    this.field.addEventListener('click', (e) => {
      this.throwAt({ x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }, 'mouse');
    });
    document.addEventListener('fullscreenchange', () => this.updateStatus());
  }

  /** @param {import('./storage.js').Calibration} calibration */
  start(calibration) {
    this.session++;
    this.best = loadBestScore(GAME_ID);
    this.reset();
    this.setState('ready');
    this.showPanel({
      title: TARGET_PRACTICE_TEXT.title,
      best: this.best ? TARGET_PRACTICE_TEXT.best(this.best) : '',
      prompt: TARGET_PRACTICE_TEXT.startPrompt,
    });
    this.showStartTarget(TARGET_PRACTICE_TEXT.startLabel);
    this.updateStatus();
    return this.camera.start(calibration);
  }

  stop() {
    this.session++;
    this.camera.stop();
    this.reset();
  }

  toggleDebug() {
    this.camera.toggleDebug();
  }

  /** Enter / Space: start a round, the same as hitting the Start target. */
  pressStart() {
    if (this.startTarget) this.hitStartTarget();
  }

  reset() {
    this.field.replaceChildren();
    this.targets = [];
    this.startTarget = null;
    this.spawning = 0;
    this.score = 0;
    this.scoreEl.textContent = '0';
    this.panel.hidden = true;
    this.hud.hidden = true;
    this.countdownEl.hidden = true;
    this.camera.updateExcluded();
  }

  setState(state) {
    this.state = state;
    this.root.dataset.state = state;
  }

  // ---- Throws ----

  /**
   * A ball (or a mouse click) hit the screen.
   * @param {{x:number, y:number}} point normalised screen coordinates
   * @param {'ball'|'mouse'} source
   */
  throwAt(point, source) {
    if (this.state === 'countdown') return;
    if (this.state === 'playing') {
      const hit = findHit(this.targets, point, view());
      if (hit) this.hitTarget(hit.target, hit.points);
      else this.miss(point, source);
    } else if (this.startTarget) {
      if (findHit([this.startTarget], point, view())) this.hitStartTarget();
      else this.miss(point, source);
    }
  }

  hitTarget(target, points) {
    this.targets = this.targets.filter((t) => t !== target);
    this.burst(target);
    this.floatPoints(target, points);
    playDing(TARGET_PRACTICE_RULES.rings.length - 1 - TARGET_PRACTICE_RULES.rings.indexOf(points));
    this.score += points;
    this.scoreEl.textContent = String(this.score);
  }

  miss(point, source) {
    const splat = this.addElement('splat', point);
    splat.dataset.source = source;
    this.camera.pictureChangeAround(point, SPLAT_RADIUS * 1.3, SPLAT_MS);
    setTimeout(() => splat.remove(), SPLAT_MS);
    playThud();
  }

  hitStartTarget() {
    const target = this.startTarget;
    this.startTarget = null;
    this.burst(target);
    playDing(2);
    this.beginCountdown();
  }

  // ---- Round flow ----

  beginCountdown() {
    this.setState('countdown');
    this.hidePanel();
    this.score = 0;
    this.scoreEl.textContent = '0';
    this.showTime(this.roundMs);
    this.hud.hidden = false;
    this.camera.updateExcluded();

    const session = this.session;
    const steps = ['3', '2', '1', 'Go!'];
    this.countdownEl.hidden = false;
    steps.forEach((text, i) => setTimeout(() => {
      if (session !== this.session) return;
      // Re-adding the text restarts its pop-in animation.
      this.countdownEl.replaceChildren(Object.assign(document.createElement('span'), { textContent: text }));
      this.camera.pictureChange(rectOf(this.countdownEl, 0.03), COUNT_STEP_MS);
      playBeep(i === steps.length - 1);
      if (i === steps.length - 1) this.beginRound();
    }, i * COUNT_STEP_MS));
    setTimeout(() => {
      if (session === this.session) this.countdownEl.hidden = true;
    }, steps.length * COUNT_STEP_MS);
  }

  beginRound() {
    this.setState('playing');
    const now = performance.now();
    this.startsAt = now;
    this.endsAt = now + this.roundMs;
    this.lastSecond = null;
    const session = this.session;
    const tick = () => {
      if (session !== this.session || this.state !== 'playing') return;
      this.update(performance.now());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  update(now) {
    const left = this.endsAt - now;
    if (left <= 0) {
      this.endRound();
      return;
    }
    this.showTime(left);

    for (const target of this.targets.filter((t) => now >= t.expiresAt)) this.expire(target);

    const { maxTargets } = difficulty((now - this.startsAt) / this.roundMs);
    while (this.targets.length + this.spawning < maxTargets) {
      // The first targets of a round appear straight away (staggered a little).
      const first = now - this.startsAt < 100;
      const { min, max } = TARGET_PRACTICE_RULES.respawnMs;
      const delay = first ? (this.spawning + this.targets.length) * 500 : min + Math.random() * (max - min);
      this.queueSpawn(delay);
    }
  }

  queueSpawn(delay) {
    this.spawning++;
    const session = this.session;
    setTimeout(() => {
      if (session !== this.session) return;
      this.spawning--;
      if (this.state !== 'playing') return;
      // No room right now (e.g. under the countdown): the next update queues another.
      this.spawnTarget(performance.now());
    }, delay);
  }

  spawnTarget(now) {
    const progress = (now - this.startsAt) / this.roundMs;
    const { radius, lifetimeMs } = difficulty(progress);
    const avoid = [this.hud, this.bar, this.countdownEl, this.camera.debugPanel]
      .filter((el) => !el.hidden).map((el) => rectOf(el, 0.01)).concat(SCENERY);
    const spot = pickSpot({ radius, targets: this.targets, avoid, view: view() });
    if (!spot) return;
    const target = { ...spot, r: radius, expiresAt: now + POP_MS + lifetimeMs };
    target.el = this.addTarget(target);
    this.targets.push(target);
  }

  expire(target) {
    this.targets = this.targets.filter((t) => t !== target);
    target.el.classList.add('fade');
    this.camera.pictureChangeAround(target, target.r * 1.1, FADE_MS);
    setTimeout(() => target.el.remove(), FADE_MS);
  }

  endRound() {
    this.setState('over');
    this.showTime(0);
    for (const target of [...this.targets]) this.expire(target);
    playFanfare();

    const isBest = this.score > this.best;
    if (isBest) {
      this.best = this.score;
      saveBestScore(GAME_ID, this.score);
    }
    this.hud.hidden = true;
    this.camera.updateExcluded();
    this.showPanel({
      title: TARGET_PRACTICE_TEXT.timeUp,
      result: TARGET_PRACTICE_TEXT.result(this.score),
      best: isBest ? TARGET_PRACTICE_TEXT.newBest : TARGET_PRACTICE_TEXT.best(this.best),
    });
    this.panel.classList.toggle('new-best', isBest);

    const session = this.session;
    setTimeout(() => {
      if (session === this.session && this.state === 'over') this.showStartTarget(TARGET_PRACTICE_TEXT.againLabel);
    }, REARM_MS);
  }

  // ---- Drawing ----

  showTime(ms) {
    const seconds = Math.ceil(ms / 1000);
    if (seconds === this.lastSecond) return;
    this.lastSecond = seconds;
    this.timeEl.querySelector('b').textContent = String(seconds);
    const low = this.state === 'playing' && seconds <= LAST_SECONDS;
    this.timeEl.classList.toggle('low', low);
    if (low && seconds > 0) playTick();
  }

  showStartTarget(label) {
    const target = { ...START_TARGET };
    target.el = this.addTarget(target, 'start-target');
    const text = document.createElement('span');
    text.textContent = label;
    target.el.append(text);
    this.startTarget = target;
  }

  /** Adds a bullseye to the screen (it pops in). */
  addTarget(target, extraClass = '') {
    const el = this.addElement(`target ${extraClass}`.trim(), target);
    el.style.setProperty('--r', `${target.r * 100}vmin`);
    this.camera.pictureChangeAround(target, target.r * 1.15, POP_MS);
    return el;
  }

  burst(target) {
    target.el.classList.add('burst');
    this.camera.pictureChangeAround(target, target.r * 1.6, BURST_MS);
    setTimeout(() => target.el.remove(), BURST_MS);
  }

  floatPoints(target, points) {
    const el = this.addElement('points-pop', target);
    el.textContent = `+${points}`;
    el.dataset.points = String(points);
    el.dataset.ring = String(TARGET_PRACTICE_RULES.rings.indexOf(points));
    // The text floats up from the target's centre.
    const unit = Math.min(window.innerWidth, window.innerHeight);
    const halfWidth = (0.12 * unit) / window.innerWidth;
    this.camera.pictureChange({
      x0: target.x - halfWidth,
      x1: target.x + halfWidth,
      y0: target.y - ((FLOAT_RISE + 0.08) * unit) / window.innerHeight,
      y1: target.y + (0.08 * unit) / window.innerHeight,
    }, FLOAT_MS);
    setTimeout(() => el.remove(), FLOAT_MS);
  }

  addElement(className, point) {
    const el = document.createElement('div');
    el.className = className;
    el.style.left = `${point.x * 100}%`;
    el.style.top = `${point.y * 100}%`;
    this.field.append(el);
    return el;
  }

  showPanel({ title, result = '', best = '', prompt = '' }) {
    const set = (selector, text) => {
      const el = this.panel.querySelector(selector);
      el.textContent = text;
      el.hidden = !text;
    };
    set('.tp-title', title);
    set('.tp-result', result);
    set('.tp-best', best);
    set('.tp-prompt', prompt);
    this.panel.classList.remove('new-best');
    this.panel.hidden = false;
    this.camera.pictureChange(rectOf(this.panel, 0.03));
  }

  hidePanel() {
    if (this.panel.hidden) return;
    this.camera.pictureChange(rectOf(this.panel, 0.03));
    this.panel.hidden = true;
  }

  updateStatus() {
    renderGameStatus(this.statusEl, this.camera.note);
  }
}

function view() {
  return { width: window.innerWidth, height: window.innerHeight };
}
