// Dunk the Clown: clowns climb onto seats above tanks of water. Hit the
// bullseye under a clown and the seat gives way: down he goes! Everyone throws
// together for one shared score in a timed round. A bullseye in the middle is
// worth extra, and so are hits in a row (a miss ends the streak). The clowns
// stay up for less time as the round goes on, and more of them come at once.
//
// Rounds start (and restart) by hitting the big Start target, so nobody needs
// to walk over to the computer; Enter, Space or a click work too.
//
// Everything is drawn in 3D (see dunk-the-clown-scene.js and -gl.js): a booth
// with a tank of water under each clown, and the water splashes when he falls
// in. The 3D picture is drawn only when something changes, and each change is
// reported to the camera first (pictureChange…) so the projector's own picture
// is never mistaken for a ball. A clown is perfectly still while he can be hit.

import { loadBestScore, saveBestScore } from './storage.js';
import {
  playBeep, playDing, playFanfare, playHonk, playSplash, playThud, playTick,
} from './sound.js';
import { ClownRenderer } from './dunk-the-clown-gl.js';
import {
  DUNK_THE_CLOWN_RULES, difficulty, findHit, hitPoints, pickSeat, seats,
} from './dunk-the-clown-logic.js';
import { ClownScene, SCENE_MS } from './dunk-the-clown-scene.js';
import { ThrowCamera, rectOf, renderGameStatus } from './throw-camera.js';

export const GAME_ID = 'dunk-the-clown';

// Animation lengths, from the scene.
const { rise: RISE_MS, dunk: DUNK_MS, leave: LEAVE_MS, burst: BURST_MS, splat: SPLAT_MS } = SCENE_MS;
const FLOAT_MS = 900; // "+25" floating up from a hit (a CSS animation)
const COUNT_STEP_MS = 800; // each of 3, 2, 1, Go!

const SPLAT_RADIUS = 0.035; // fraction of the shorter screen side
const FLOAT_RISE = 0.12; // how far "+25" floats up (same unit)
// Huge, so anyone can hit it: over half the screen height across. It may rest on the counter.
const START_TARGET = { x: 0.5, y: 0.62, r: 0.3 };
const START_FIRST_MS = 500; // the clowns of a round climb up this far apart at the start
// After a round ends, the Play again target appears this much later, so a ball
// still in the air can't start the next round by accident.
const REARM_MS = 1500;
const LAST_SECONDS = 5; // the clock turns red and ticks

export const DUNK_THE_CLOWN_TEXT = {
  title: 'Dunk the Clown',
  timeUp: 'Time’s up!',
  startPrompt: 'Throw a ball at the target to start!',
  startLabel: 'START',
  againLabel: 'PLAY AGAIN',
  best: (score) => `Best score: ${score}`,
  newBest: 'New best score!',
  result: (score) => `You scored ${score} point${score === 1 ? '' : 's'}`,
};

export class DunkTheClown {
  /**
   * @param {HTMLElement} root the game's screen element
   * @param {{roundMs?: number}} [options]
   */
  constructor(root, { roundMs = DUNK_THE_CLOWN_RULES.roundMs } = {}) {
    this.root = root;
    this.roundMs = roundMs;
    this.canvas = root.querySelector('.dc-canvas');
    this.field = root.querySelector('.dc-field');
    this.hud = root.querySelector('.dc-hud');
    this.scoreEl = root.querySelector('.dc-score b');
    this.streakEl = root.querySelector('.dc-streak b');
    this.timeEl = root.querySelector('.dc-time');
    this.panel = root.querySelector('.dc-panel');
    this.countdownEl = root.querySelector('.dc-countdown');
    this.bar = root.querySelector('.game-bar');
    this.statusEl = root.querySelector('.game-status');

    this.session = 0; // increments when the game starts or stops, so stale timers can tell
    this.state = 'ready'; // 'ready' | 'countdown' | 'playing' | 'over'
    // Each seat: {x, y, r, index, readyAt, clown}. clown is {x, y, r, seat, expiresAt} while one sits there.
    this.seats = seats().map((seat, index) => ({ ...seat, index, readyAt: 0, clown: null }));
    this.renderer = null; // the 3D picture: set up when the game starts, once its screen is showing
    this.scene = null;
    this.startTarget = null; // the Start / Play again target, when shown
    this.score = 0;
    this.streak = 0;
    this.misses = 0; // throws that hit nothing, since the game was opened
    this.best = 0;
    this.endsAt = 0;
    this.lastSecond = null;

    this.camera = new ThrowCamera(root, {
      onHit: (hit) => this.throwAt(hit, 'ball'),
      onNote: () => this.updateStatus(),
    });
    this.camera.ignore(this.bar, this.hud);
    window.addEventListener('resize', () => this.resize());

    this.field.addEventListener('click', (e) => {
      this.throwAt({ x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }, 'mouse');
    });
    document.addEventListener('fullscreenchange', () => this.updateStatus());
  }

  /** @param {import('./storage.js').Calibration|null} calibration */
  start(calibration) {
    this.session++;
    this.best = loadBestScore(GAME_ID);
    this.setUpPicture();
    this.reset();
    this.setState('ready');
    this.showPanel({
      title: DUNK_THE_CLOWN_TEXT.title,
      best: this.best ? DUNK_THE_CLOWN_TEXT.best(this.best) : '',
      prompt: DUNK_THE_CLOWN_TEXT.startPrompt,
    });
    this.showStartTarget(DUNK_THE_CLOWN_TEXT.startLabel);
    this.updateStatus();
    return this.camera.start(calibration);
  }

  stop() {
    this.session++;
    this.camera.stop();
    this.reset();
  }

  /** Sets up the 3D picture, the first time the game starts, and starts drawing it. */
  setUpPicture() {
    if (!this.renderer) {
      this.renderer = new ClownRenderer(this.canvas);
      this.scene = new ClownScene(view());
    } else {
      this.resize();
    }
    const session = this.session;
    const loop = () => {
      if (session !== this.session) return;
      if (this.scene.step(performance.now())) this.renderer.draw(this.scene.frame(performance.now()));
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** The window has changed size: draw the picture again to fit. The game reports it, as it is a change. */
  resize() {
    if (!this.renderer) return;
    this.renderer.resize();
    this.scene.resize(view());
    this.camera.pictureChangeEverywhere(300);
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
    this.scene?.reset();
    for (const seat of this.seats) {
      seat.clown = null;
      seat.readyAt = 0;
    }
    this.startTarget = null;
    this.misses = 0;
    this.publish();
    this.setScore(0);
    this.setStreak(0);
    this.panel.hidden = true;
    this.hud.hidden = true;
    this.countdownEl.hidden = true;
    this.camera.updateExcluded();
  }

  setState(state) {
    this.state = state;
    this.root.dataset.state = state;
  }

  /** What the game is doing, for the end-to-end test to read: the seats with a clown up, and the throws that missed. */
  publish() {
    this.root.dataset.up = this.seats.filter((seat) => seat.clown).map((seat) => seat.index).join(',');
    this.root.dataset.misses = String(this.misses);
  }

  /** The clowns that are up, with the bullseye each can be hit on. */
  get clowns() {
    return this.seats.filter((seat) => seat.clown).map((seat) => seat.clown);
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
      const hit = findHit(this.clowns, point, view());
      if (hit) this.dunk(hit.clown, hit.bull);
      else this.miss(point, source);
    } else if (this.startTarget) {
      if (findHit([this.startTarget], point, view())) this.hitStartTarget();
      else this.miss(point, source);
    }
  }

  dunk(clown, bull) {
    clown.seat.clown = null;
    clown.seat.readyAt = performance.now() + DUNK_MS;
    this.camera.pictureChange(areaOf(clown), DUNK_MS);
    this.scene.dunk(clown.seat.index, performance.now());
    this.publish();
    playSplash();
    playDing(bull ? 2 : 1);
    const points = hitPoints(this.streak, bull);
    this.floatPoints(clown, points, bull);
    this.setScore(this.score + points);
    this.setStreak(this.streak + 1);
  }

  miss(point, source) {
    this.camera.pictureChangeAround(point, SPLAT_RADIUS * 1.3, SPLAT_MS);
    this.scene.splat(point, performance.now());
    this.misses++;
    this.publish();
    playThud();
    this.setStreak(0);
  }

  hitStartTarget() {
    const target = this.startTarget;
    this.startTarget = null;
    this.camera.pictureChangeAround(target, target.r * 1.6, BURST_MS);
    this.scene.hitStart(performance.now());
    playDing(2);
    this.beginCountdown();
  }

  // ---- Round flow ----

  beginCountdown() {
    this.setState('countdown');
    this.hidePanel();
    this.setScore(0);
    this.setStreak(0);
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
    // The first clowns climb up one after another.
    const order = [...this.seats].sort(() => Math.random() - 0.5);
    order.forEach((seat, i) => { seat.readyAt = now + i * START_FIRST_MS; });
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

    for (const clown of this.clowns.filter((c) => now >= c.expiresAt)) this.leave(clown);

    const { maxUp, upMs, respawnMs } = difficulty((now - this.startsAt) / this.roundMs);
    while (this.clowns.length < maxUp) {
      const seat = pickSeat(this.seats.filter((s) => !s.clown && now >= s.readyAt));
      if (!seat) break;
      this.raise(seat, now, upMs);
      // Seats stay empty a moment after a clown has gone.
      for (const other of this.seats) {
        if (!other.clown && other.readyAt <= now) {
          other.readyAt = Math.max(other.readyAt, now + respawnMs.min + Math.random() * (respawnMs.max - respawnMs.min));
        }
      }
    }
  }

  /** A clown climbs onto a seat. */
  raise(seat, now, upMs) {
    const clown = { x: seat.x, y: seat.y, r: seat.r, seat, expiresAt: now + RISE_MS + upMs };
    seat.clown = clown;
    this.camera.pictureChange(areaOf(clown), RISE_MS);
    this.scene.raise(seat.index, performance.now());
    this.publish();
    playHonk();
  }

  /** Nobody hit him in time: he climbs down. */
  leave(clown) {
    clown.seat.clown = null;
    clown.seat.readyAt = performance.now() + LEAVE_MS;
    this.camera.pictureChange(areaOf(clown), LEAVE_MS);
    this.scene.leave(clown.seat.index, performance.now());
    this.publish();
  }

  endRound() {
    this.setState('over');
    this.showTime(0);
    for (const clown of this.clowns) this.leave(clown);
    playFanfare();

    const isBest = !this.camera.mouseOnly && this.score > this.best;
    if (isBest) {
      this.best = this.score;
      saveBestScore(GAME_ID, this.score);
    }
    this.hud.hidden = true;
    this.camera.updateExcluded();
    this.showPanel({
      title: DUNK_THE_CLOWN_TEXT.timeUp,
      result: DUNK_THE_CLOWN_TEXT.result(this.score),
      best: isBest ? DUNK_THE_CLOWN_TEXT.newBest : this.best ? DUNK_THE_CLOWN_TEXT.best(this.best) : '',
    });
    this.panel.classList.toggle('new-best', isBest);

    const session = this.session;
    setTimeout(() => {
      if (session === this.session && this.state === 'over') this.showStartTarget(DUNK_THE_CLOWN_TEXT.againLabel);
    }, REARM_MS);
  }

  // ---- Drawing ----

  setScore(score) {
    this.score = score;
    this.scoreEl.textContent = String(score);
  }

  setStreak(streak) {
    this.streak = streak;
    this.streakEl.textContent = String(streak);
  }

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
    this.camera.pictureChangeAround(target, target.r * 1.3, 250);
    this.scene.showStart(target, label, performance.now());
    this.startTarget = target;
  }

  floatPoints(clown, points, bull) {
    const el = this.addElement('points-pop', clown);
    el.textContent = `+${points}`;
    el.dataset.ring = bull ? '0' : '1';
    // The text floats up from the bullseye's centre.
    const unit = Math.min(window.innerWidth, window.innerHeight);
    const halfWidth = (0.14 * unit) / window.innerWidth;
    this.camera.pictureChange({
      x0: clown.x - halfWidth,
      x1: clown.x + halfWidth,
      y0: clown.y - ((FLOAT_RISE + 0.08) * unit) / window.innerHeight,
      y1: clown.y + (0.08 * unit) / window.innerHeight,
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
    set('.dc-title', title);
    set('.dc-result', result);
    set('.dc-best', best);
    set('.dc-prompt', prompt);
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

/**
 * Everything a clown's seat changes: the clown above the bullseye, the bullseye,
 * and the splash in the tank below.
 */
function areaOf(clown) {
  const unit = Math.min(window.innerWidth, window.innerHeight);
  const halfWidth = (2.0 * clown.r * unit) / window.innerWidth;
  return {
    x0: clown.x - halfWidth,
    x1: clown.x + halfWidth,
    y0: clown.y - (4.8 * clown.r * unit) / window.innerHeight,
    y1: clown.y + (2.4 * clown.r * unit) / window.innerHeight,
  };
}

function view() {
  return { width: window.innerWidth, height: window.innerHeight };
}
