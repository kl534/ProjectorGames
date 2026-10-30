// Balloon Pop: balloons rise up the screen; pop them before they float away.
// Everyone throws together for one shared score. Each balloon that gets away
// costs a life, and the game ends when the lives run out. Gold balloons are
// worth more but rise faster. The game gets faster as it goes on.
//
// The balloons move all the time, so the camera is told about each one
// (track): it then looks for balls in front of them rather than taking them
// for balls. A hit says when the picture it landed on was shown, and is
// checked against where the balloons were then. Things that appear or vanish
// (a balloon bursting, the countdown) are reported with pictureChange….
//
// Games start (and restart) by popping the big Start balloon, so nobody needs
// to walk over to the computer; Enter, Space or a click work too.

import {
  BALLOON_POP_RULES, difficulty, findHit, isHit, pickColumn, positionAt,
} from './balloon-pop-logic.js';
import { loadBestScore, saveBestScore } from './storage.js';
import { playBeep, playEscape, playFanfare, playPop, playThud } from './sound.js';
import { ThrowCamera, rectOf, renderGameStatus } from './throw-camera.js';

export const GAME_ID = 'balloon-pop';

// Animation lengths; these match css/style.css.
const POP_MS = 300; // a balloon bursting
const SPLAT_MS = 1200; // the mark left by a miss
const FLOAT_MS = 900; // "+10" floating up from a popped balloon
const COUNT_STEP_MS = 800; // each of 3, 2, 1, Go!

const SPLAT_RADIUS = 0.035; // fraction of the shorter screen side
const FLOAT_RISE = 0.12; // how far "+10" floats up (same unit)
const STRING_RATIO = 0.9; // string length, in balloon radii
// The camera picture is a little blurred, so a change spreads slightly beyond
// where it was drawn (fraction of the screen size).
const CHANGE_PAD = 0.02;
// Huge, so anyone can hit it: over half the screen height tall. Its string hangs off the bottom.
const START_BALLOON = { x: 0.5, y: 0.63, r: 0.24 };
// After a game ends, the Play again balloon appears this much later, so a ball
// still in the air can't start the next game by accident.
const REARM_MS = 1500;
// The first balloons rise this long after "Go!", so they don't arrive under it.
const FIRST_SPAWN_MS = 600;
// When the game ends, the balloons left float away this much faster.
const LEAVE_SPEEDUP = 3;
const COLOURS = ['#e8392e', '#2f74d6', '#2fa84f', '#8a4fd6', '#e8790f', '#d63f8c'];
const GOLD = '#e8b400';

export const BALLOON_POP_TEXT = {
  title: 'Balloon Pop',
  gameOver: 'Too many got away!',
  startPrompt: 'Throw a ball at the balloon to start!',
  startLabel: 'START',
  againLabel: 'PLAY AGAIN',
  best: (score) => `Best score: ${score}`,
  newBest: 'New best score!',
  result: (score, popped) => `You popped ${popped} balloon${popped === 1 ? '' : 's'}: ${score} point${score === 1 ? '' : 's'}`,
};

export class BalloonPop {
  /**
   * @param {HTMLElement} root the game's screen element
   * @param {{lives?: number}} [options]
   */
  constructor(root, { lives = BALLOON_POP_RULES.lives } = {}) {
    this.root = root;
    this.startLives = lives;
    this.field = root.querySelector('.bp-field');
    this.hud = root.querySelector('.bp-hud');
    this.scoreEl = root.querySelector('.bp-score b');
    this.livesEl = root.querySelector('.bp-lives b');
    this.panel = root.querySelector('.bp-panel');
    this.countdownEl = root.querySelector('.bp-countdown');
    this.bar = root.querySelector('.game-bar');
    this.statusEl = root.querySelector('.game-status');

    this.session = 0; // increments when the game starts or stops, so stale timers can tell
    this.state = 'ready'; // 'ready' | 'countdown' | 'playing' | 'over'
    // Balloons on screen: {x, y, r, kind, flight, el, leaving}. x and y are
    // where it is now (see positionAt). Ones leaving at the end of a game
    // (leaving: true) can't be popped and cost no lives.
    this.balloons = [];
    this.startBalloon = null; // the Start / Play again balloon, when shown
    this.spawning = 0; // balloons waiting to appear
    this.score = 0;
    this.popped = 0;
    this.lives = lives;
    this.best = 0;
    this.startsAt = 0;
    this.colour = 0;

    this.camera = new ThrowCamera(root, {
      onHit: (point, { time }) => this.throwAt(point, 'ball', time),
      onNote: () => this.updateStatus(),
      moving: true,
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
      title: BALLOON_POP_TEXT.title,
      best: this.best ? BALLOON_POP_TEXT.best(this.best) : '',
      prompt: BALLOON_POP_TEXT.startPrompt,
    });
    this.showStartBalloon(BALLOON_POP_TEXT.startLabel);
    this.updateStatus();
    const session = this.session;
    const tick = () => {
      if (session !== this.session) return;
      this.update(performance.now());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
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

  /** Enter / Space: start a game, the same as popping the Start balloon. */
  pressStart() {
    if (this.startBalloon) this.popStartBalloon();
  }

  reset() {
    this.field.replaceChildren();
    this.balloons = [];
    this.startBalloon = null;
    this.spawning = 0;
    this.setScore(0);
    this.popped = 0;
    this.setLives(this.startLives);
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
   * @param {number} [time] when the picture it hit was on screen (a ball's
   *   is a moment ago: the camera sees the screen a little late)
   */
  throwAt(point, source, time = performance.now()) {
    if (this.state === 'countdown') return;
    if (this.state === 'playing') {
      // Where the balloons were when it hit.
      const then = this.balloons.filter((b) => !b.leaving)
        .map((b) => ({ balloon: b, r: b.r, ...positionAt(b.flight, time, view()) }));
      const hit = findHit(then, point, view());
      if (hit) this.pop(hit.balloon);
      else this.miss(point, source);
    } else if (this.startBalloon) {
      if (isHit(this.startBalloon, point, view())) this.popStartBalloon();
      else this.miss(point, source);
    }
  }

  pop(balloon) {
    this.balloons = this.balloons.filter((b) => b !== balloon);
    this.burst(balloon);
    const points = BALLOON_POP_RULES.points[balloon.kind];
    this.floatPoints(balloon, points);
    playPop(balloon.kind === 'gold');
    this.popped++;
    this.setScore(this.score + points);
  }

  miss(point, source) {
    const splat = this.addElement('splat', point);
    splat.dataset.source = source;
    this.camera.pictureChangeAround(point, SPLAT_RADIUS * 1.3, SPLAT_MS);
    setTimeout(() => splat.remove(), SPLAT_MS);
    playThud();
  }

  popStartBalloon() {
    const balloon = this.startBalloon;
    this.startBalloon = null;
    this.burst(balloon);
    playPop(true);
    this.beginCountdown();
  }

  // ---- Game flow ----

  beginCountdown() {
    this.setState('countdown');
    this.hidePanel();
    this.setScore(0);
    this.popped = 0;
    this.setLives(this.startLives);
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
      if (i === steps.length - 1) this.beginPlay();
    }, i * COUNT_STEP_MS));
    setTimeout(() => {
      if (session === this.session) this.countdownEl.hidden = true;
    }, steps.length * COUNT_STEP_MS);
  }

  beginPlay() {
    this.setState('playing');
    this.startsAt = performance.now();
  }

  /** Every animation frame: moves the balloons, and keeps new ones coming while playing. */
  update(now) {
    for (const balloon of [...this.balloons]) {
      Object.assign(balloon, positionAt(balloon.flight, now, view()));
      balloon.el.style.left = `${balloon.x * 100}%`;
      balloon.el.style.top = `${balloon.y * 100}%`;
      const { height, string } = this.size(balloon.r);
      if (balloon.y + height + string < 0) this.gotAway(balloon);
    }
    if (this.state !== 'playing') return;

    const { maxBalloons } = difficulty(now - this.startsAt);
    while (this.balloons.length + this.spawning < maxBalloons) {
      // The first balloons of a game rise straight away (staggered a little).
      const first = now - this.startsAt < 100;
      const { min, max } = BALLOON_POP_RULES.spawnMs;
      const delay = first ? FIRST_SPAWN_MS + this.spawning * 700 : min + Math.random() * (max - min);
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
      // No room right now: the next update queues another.
      this.spawnBalloon(performance.now());
    }, delay);
  }

  spawnBalloon(now) {
    const { radius, riseMs } = difficulty(now - this.startsAt);
    const avoid = [this.hud, this.bar, this.camera.debugPanel]
      .filter((el) => !el.hidden).map((el) => rectOf(el, 0.01));
    const x0 = pickColumn({ radius, balloons: this.balloons.map((b) => ({ ...b, x: b.flight.x0 })), avoid, view: view() });
    if (x0 === null) return;
    const kind = Math.random() < BALLOON_POP_RULES.goldChance ? 'gold' : 'normal';
    const speed = (kind === 'gold' ? BALLOON_POP_RULES.goldSpeedRatio : 1) / riseMs;
    // It starts just below the screen.
    const flight = { x0, y0: 1 + this.size(radius).height, t0: now, speed, phase: Math.random() * 2 * Math.PI };
    const balloon = { ...positionAt(flight, now, view()), r: radius, kind, flight, leaving: false };
    balloon.el = this.addBalloon(balloon);
    this.camera.track(balloon.el, { shape: 'ellipse' });
    this.camera.track(balloon.el.querySelector('.balloon-tail'), { shape: 'rect', watch: false });
    this.balloons.push(balloon);
  }

  /** A balloon has floated off the top. Unless the game is over, it costs a life. */
  gotAway(balloon) {
    balloon.el.remove();
    this.balloons = this.balloons.filter((b) => b !== balloon);
    if (balloon.leaving || this.state !== 'playing') return;
    playEscape();
    this.setLives(this.lives - 1);
    if (this.lives <= 0) this.endGame();
  }

  endGame() {
    this.setState('over');
    // The balloons left float away quickly, and can't be popped.
    const now = performance.now();
    for (const balloon of this.balloons) {
      const { flight } = balloon;
      const elapsed = now - flight.t0;
      balloon.leaving = true;
      balloon.flight = {
        ...flight,
        y0: flight.y0 - flight.speed * elapsed,
        t0: now,
        speed: flight.speed * LEAVE_SPEEDUP,
        phase: flight.phase + (2 * Math.PI * elapsed) / BALLOON_POP_RULES.swayMs,
      };
    }
    playFanfare();

    const isBest = this.score > this.best;
    if (isBest) {
      this.best = this.score;
      saveBestScore(GAME_ID, this.score);
    }
    this.hud.hidden = true;
    this.camera.updateExcluded();
    this.showPanel({
      title: BALLOON_POP_TEXT.gameOver,
      result: BALLOON_POP_TEXT.result(this.score, this.popped),
      best: isBest ? BALLOON_POP_TEXT.newBest : BALLOON_POP_TEXT.best(this.best),
    });
    this.panel.classList.toggle('new-best', isBest);

    const session = this.session;
    setTimeout(() => {
      if (session === this.session && this.state === 'over') this.showStartBalloon(BALLOON_POP_TEXT.againLabel);
    }, REARM_MS);
  }

  // ---- Drawing ----

  setScore(score) {
    this.score = score;
    this.scoreEl.textContent = String(score);
  }

  setLives(lives) {
    this.lives = Math.max(0, lives);
    this.livesEl.replaceChildren(...Array.from({ length: this.startLives }, (_, i) => {
      const icon = document.createElement('i');
      icon.className = i < this.lives ? 'bp-life' : 'bp-life lost';
      return icon;
    }));
    this.livesEl.dataset.lives = String(this.lives);
  }

  /** A balloon's half width, half height and string length, in fractions of the screen size. */
  size(radius) {
    const unit = Math.min(window.innerWidth, window.innerHeight);
    return {
      width: (radius * unit) / window.innerWidth,
      height: (radius * BALLOON_POP_RULES.aspect * unit) / window.innerHeight,
      string: (radius * STRING_RATIO * unit) / window.innerHeight,
    };
  }

  /** The area a balloon covers where it is now, with its string, grown by `grow` of its size. */
  area(balloon, grow = 0) {
    const { width, height, string } = this.size(balloon.r * (1 + grow));
    return {
      x0: balloon.x - width - CHANGE_PAD,
      x1: balloon.x + width + CHANGE_PAD,
      y0: balloon.y - height - CHANGE_PAD,
      y1: balloon.y + height + string + CHANGE_PAD,
    };
  }

  showStartBalloon(label) {
    const balloon = { ...START_BALLOON, kind: 'normal' };
    balloon.el = this.addBalloon(balloon, 'start-balloon');
    balloon.el.style.setProperty('--colour', COLOURS[0]);
    const text = document.createElement('span');
    text.textContent = label;
    balloon.el.append(text);
    // It inflates in place.
    this.camera.pictureChange(this.area(balloon, 0.1), POP_MS);
    this.startBalloon = balloon;
  }

  /** Adds a balloon to the screen where it is now (x, y). */
  addBalloon(balloon, extraClass = '') {
    const el = this.addElement(`balloon ${extraClass}`.trim(), balloon);
    el.dataset.kind = balloon.kind;
    el.style.setProperty('--r', `${balloon.r * 100}vmin`);
    el.style.setProperty('--colour', balloon.kind === 'gold' ? GOLD : COLOURS[this.colour++ % COLOURS.length]);
    // The knot and string hang below the body; this box covers them, for the camera.
    el.append(Object.assign(document.createElement('i'), { className: 'balloon-tail' }));
    return el;
  }

  burst(balloon) {
    balloon.el.classList.add('pop');
    // Grown well beyond the balloon: it bursts bigger, and a moving one is seen a little behind.
    this.camera.pictureChange(this.area(balloon, 0.6), POP_MS);
    setTimeout(() => balloon.el.remove(), POP_MS);
  }

  floatPoints(balloon, points) {
    const el = this.addElement('points-pop', balloon);
    el.textContent = `+${points}`;
    el.dataset.points = String(points);
    if (balloon.kind === 'gold') el.dataset.ring = '0'; // the big, bright style
    // The text floats up from the balloon's centre.
    const unit = Math.min(window.innerWidth, window.innerHeight);
    const halfWidth = (0.12 * unit) / window.innerWidth;
    this.camera.pictureChange({
      x0: balloon.x - halfWidth,
      x1: balloon.x + halfWidth,
      y0: balloon.y - ((FLOAT_RISE + 0.08) * unit) / window.innerHeight,
      y1: balloon.y + (0.08 * unit) / window.innerHeight,
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
    set('.bp-title', title);
    set('.bp-result', result);
    set('.bp-best', best);
    set('.bp-prompt', prompt);
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
