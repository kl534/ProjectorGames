// Brick Breaker: a wall of bricks fills the top of the screen. Every throw
// smashes the brick nearest where it landed and cracks the bricks touching it;
// broken bricks split in two and tumble off the screen. Clear the wall before
// the clock runs out for a time bonus and the next, harder wall. The game ends
// when time runs out on a wall. Everyone throws together for one shared score.
//
// Bricks stand perfectly still while they can be hit. The halves of a broken
// brick keep moving while players aim, so the camera is told about each one
// (track): it then looks for balls in front of them rather than taking them
// for balls. Everything else that appears, changes or vanishes (the wall
// popping in, a crack, a brick breaking, an explosion, the countdown) is
// reported with pictureChange….
//
// Games start (and restart) by hitting the big Start brick, so nobody needs
// to walk over to the computer; Enter, Space or a click work too.

import {
  BRICK_BREAKER_RULES, brickRect, buildWall, cellRect, explode, findTarget, isNear, levelFor, pointsFor,
  resolveHit, timeBonus, wallArea,
} from './brick-breaker-logic.js';
import { loadBestScore, saveBestScore } from './storage.js';
import {
  playBeep, playBoom, playCrack, playFanfare, playLevelClear, playSmash, playThud, playTick,
} from './sound.js';
import { ThrowCamera, rectOf, renderGameStatus } from './throw-camera.js';

export const GAME_ID = 'brick-breaker';

// Animation lengths; these match css/style.css.
const POP_MS = 250; // the wall popping in
const START_POP_MS = 300; // the Start brick appearing or bursting
const BOOM_MS = 400; // an explosion's flash
const SPLAT_MS = 1200; // the mark left by a miss
const FLOAT_MS = 900; // "+30" floating up from a broken brick
const COUNT_STEP_MS = 800; // each of 3, 2, 1, Go!

// How long the panel shows "Level 3" before the wall appears, and "Wall cleared!"
// before the next level.
const BANNER_MS = 1600;
const CLEARED_MS = 2200;
// After a game ends, the Play again brick appears this much later, so a ball
// still in the air can't start the next game by accident.
const REARM_MS = 1500;
const LAST_SECONDS = 5; // the clock turns red and ticks

const SPLAT_RADIUS = 0.035; // fraction of the shorter screen side
const FLOAT_RISE = 0.12; // how far "+30" floats up (same unit)
// The camera picture is a little blurred, so a change spreads slightly beyond
// where it was drawn (fraction of the shorter screen side).
const CHANGE_PAD = 0.015;
// Huge, so anyone can hit it: half the screen wide, nearly a third of its height.
const START_BRICK = { x0: 0.25, y0: 0.47, x1: 0.75, y1: 0.77 };
// The halves of a broken brick fall like this: screen heights per second squared,
// and the screen widths per second they drift apart at.
const GRAVITY = 3.5;
const DRIFT = 0.08;
// Mid tones for the normal bricks, row by row from the top: no white, so a
// light ball stands out against every brick.
const ROW_COLOURS = ['#c0392b', '#d35400', '#b7950b', '#27ae60', '#2471a3', '#7d3c98', '#a93226'];
const KIND_COLOURS = { tough: '#5d6d7e', explosive: '#a01818', gold: '#e8b400' };
const START_COLOUR = '#c0392b';

export const BRICK_BREAKER_TEXT = {
  title: 'Brick Breaker',
  timeUp: 'Time’s up!',
  cleared: 'Wall cleared!',
  startPrompt: 'Throw a ball at the brick to start!',
  startLabel: 'START',
  againLabel: 'PLAY AGAIN',
  level: (n) => `Level ${n}`,
  bonus: (points) => `Time bonus +${points}`,
  best: (score) => `Best score: ${score}`,
  newBest: 'New best score!',
  result: (level, score) => `You reached level ${level}: ${score} point${score === 1 ? '' : 's'}`,
};

export class BrickBreaker {
  /**
   * @param {HTMLElement} root the game's screen element
   * @param {{timeMs?: number, level?: number}} [options] timeMs: the time for
   *   every wall, instead of the designed times; level: the level to start at
   */
  constructor(root, { timeMs = 0, level = 1 } = {}) {
    this.root = root;
    this.timeMs = timeMs;
    this.firstLevel = firstLevelOf(level);
    this.field = root.querySelector('.bb-field');
    this.hud = root.querySelector('.bb-hud');
    this.scoreEl = root.querySelector('.bb-score b');
    this.levelEl = root.querySelector('.bb-level b');
    this.timeEl = root.querySelector('.bb-time');
    this.panel = root.querySelector('.bb-panel');
    this.countdownEl = root.querySelector('.bb-countdown');
    this.bar = root.querySelector('.game-bar');
    this.statusEl = root.querySelector('.game-status');

    this.session = 0; // increments when the game starts or stops, so stale timers can tell
    this.round = 0; // increments when a level starts or ends, so stale explosions can tell
    this.state = 'ready'; // 'ready' | 'countdown' | 'between' | 'playing' | 'over'
    // The wall: {id, row, col, kind, hp, maxHp, rect, el}. Broken bricks leave the list.
    this.bricks = [];
    this.debris = []; // the halves of broken bricks, falling: {el, x, y, vx, t0}
    this.startBrick = null; // the Start / Play again brick, when shown
    this.exploding = 0; // explosions waiting to go off
    this.level = this.firstLevel;
    this.score = 0;
    this.best = 0;
    this.endsAt = 0;
    this.lastSecond = null;

    this.camera = new ThrowCamera(root, {
      onHit: (point) => this.throwAt(point, 'ball'),
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
      title: BRICK_BREAKER_TEXT.title,
      best: this.best ? BRICK_BREAKER_TEXT.best(this.best) : '',
      prompt: BRICK_BREAKER_TEXT.startPrompt,
    });
    this.showStartBrick(BRICK_BREAKER_TEXT.startLabel);
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

  /** Enter / Space: start a game, the same as hitting the Start brick. */
  pressStart() {
    if (this.startBrick) this.hitStartBrick();
  }

  reset() {
    this.field.replaceChildren();
    this.round++;
    this.bricks = [];
    this.debris = [];
    this.startBrick = null;
    this.exploding = 0;
    this.setScore(0);
    this.setLevel(this.firstLevel);
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
   * A ball (or a mouse click) hit the screen. The bricks don't move, so it
   * doesn't matter when exactly it landed.
   * @param {{x:number, y:number}} point normalised screen coordinates
   * @param {'ball'|'mouse'} source
   */
  throwAt(point, source) {
    if (this.state === 'playing') {
      const target = findTarget(this.bricks, point, view());
      if (!target) {
        this.miss(point, source);
        return;
      }
      const result = resolveHit(this.bricks, target);
      this.apply(result);
      if (result.broken.length) playSmash();
      else playCrack();
      this.checkCleared();
    } else if (this.startBrick) {
      if (isNear(START_BRICK, point, view())) this.hitStartBrick();
      else this.miss(point, source);
    }
  }

  miss(point, source) {
    const splat = this.addElement('splat', point);
    splat.dataset.source = source;
    this.camera.pictureChangeAround(point, SPLAT_RADIUS * 1.3, SPLAT_MS);
    setTimeout(() => splat.remove(), SPLAT_MS);
    playThud();
  }

  hitStartBrick() {
    const brick = this.startBrick;
    this.startBrick = null;
    brick.el.classList.add('pop');
    // It bursts bigger than it was.
    this.camera.pictureChange(grow(scaled(START_BRICK, 1.3), CHANGE_PAD), START_POP_MS);
    setTimeout(() => brick.el.remove(), START_POP_MS);
    playSmash();
    this.beginCountdown();
  }

  // ---- Damage ----

  /** Shows what a hit or an explosion did, and scores the bricks it broke. */
  apply({ cracked, broken, explosions }) {
    for (const { brick, cracks } of cracked) this.crack(brick, cracks);
    this.bricks = this.bricks.filter((b) => !broken.includes(b));
    for (const brick of broken) this.breakBrick(brick);
    for (const brick of explosions) this.queueExplosion(brick);
  }

  crack(brick, cracks) {
    brick.el.dataset.cracks = String(cracks);
    brick.el.dataset.hp = String(brick.hp);
    this.camera.pictureChange(grow(brick.rect, CHANGE_PAD));
  }

  /** The brick splits in two, and the halves fall. It scores, unless the game is over. */
  breakBrick(brick, scores = true) {
    const { x0, y0, x1, y1 } = brick.rect;
    const middle = (x0 + x1) / 2;
    const now = performance.now();
    brick.el.remove();
    for (const side of ['left', 'right']) {
      const el = document.createElement('div');
      el.className = `brick-debris ${side}`;
      el.dataset.kind = brick.kind;
      el.style.setProperty('--colour', brick.el.style.getPropertyValue('--colour'));
      const half = { x: side === 'left' ? x0 : middle, y: y0 };
      el.style.left = `${half.x * 100}%`;
      el.style.top = `${half.y * 100}%`;
      el.style.width = `${((x1 - x0) / 2) * 100}%`;
      el.style.height = `${(y1 - y0) * 100}%`;
      this.field.append(el);
      // The halves keep moving while players aim.
      this.camera.track(el, { shape: 'rect' });
      this.debris.push({ el, ...half, vx: side === 'left' ? -DRIFT : DRIFT, t0: now });
    }
    // The gap between the halves appears.
    this.camera.pictureChange(grow(brick.rect, CHANGE_PAD));

    if (!scores) return;
    const points = pointsFor(brick);
    this.floatPoints(brick, points);
    this.setScore(this.score + points);
  }

  queueExplosion(brick) {
    this.exploding++;
    const { session, round } = this;
    setTimeout(() => {
      if (session !== this.session || round !== this.round) return;
      this.exploding--;
      this.explodeBrick(brick);
      this.checkCleared();
    }, BRICK_BREAKER_RULES.explodeDelayMs);
  }

  /** An explosive brick that broke blows up: a flash over the 3×3 cells, and the bricks around it break. */
  explodeBrick(brick) {
    const from = cellRect(brick.row - 1, brick.col - 1);
    const to = cellRect(brick.row + 1, brick.col + 1);
    const area = { x0: from.x0, y0: from.y0, x1: to.x1, y1: to.y1 };
    const flash = this.addElement('bb-boom', { x: area.x0, y: area.y0 });
    flash.style.width = `${(area.x1 - area.x0) * 100}%`;
    flash.style.height = `${(area.y1 - area.y0) * 100}%`;
    this.camera.pictureChange(grow(area, CHANGE_PAD), BOOM_MS);
    setTimeout(() => flash.remove(), BOOM_MS);
    playBoom();
    this.apply(explode(this.bricks, brick));
  }

  floatPoints(brick, points) {
    const centre = { x: (brick.rect.x0 + brick.rect.x1) / 2, y: (brick.rect.y0 + brick.rect.y1) / 2 };
    const el = this.addElement('points-pop', centre);
    el.textContent = `+${points}`;
    el.dataset.points = String(points);
    if (brick.kind === 'gold') el.dataset.ring = '0'; // the big, bright style
    // The text floats up from the brick's centre.
    const unit = Math.min(window.innerWidth, window.innerHeight);
    const halfWidth = (0.12 * unit) / window.innerWidth;
    this.camera.pictureChange({
      x0: centre.x - halfWidth,
      x1: centre.x + halfWidth,
      y0: centre.y - ((FLOAT_RISE + 0.08) * unit) / window.innerHeight,
      y1: centre.y + (0.08 * unit) / window.innerHeight,
    }, FLOAT_MS);
    setTimeout(() => el.remove(), FLOAT_MS);
  }

  // ---- Game flow ----

  beginCountdown() {
    this.setState('countdown');
    this.hidePanel();
    this.setScore(0);
    this.setLevel(this.firstLevel);
    this.lastSecond = null;
    this.showTime(this.levelFor(this.level).timeMs);
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
      if (i === steps.length - 1) this.beginLevel(this.level);
    }, i * COUNT_STEP_MS));
    setTimeout(() => {
      if (session === this.session) this.countdownEl.hidden = true;
    }, steps.length * COUNT_STEP_MS);
  }

  /** The level for `n`, with the time the game was opened with (?time=) if any. */
  levelFor(n) {
    const level = levelFor(n);
    if (this.timeMs > 0) level.timeMs = this.timeMs;
    return level;
  }

  /** Shows "Level 3" and the wall's name, then the wall pops in and the clock starts. */
  beginLevel(n) {
    const level = this.levelFor(n);
    this.round++;
    this.exploding = 0;
    this.setState('between');
    this.setLevel(n);
    this.lastSecond = null;
    this.showTime(level.timeMs);
    this.showPanel({ title: BRICK_BREAKER_TEXT.level(n), result: level.name });

    const { session, round } = this;
    setTimeout(() => {
      if (session !== this.session || round !== this.round) return;
      this.hidePanel();
      this.showWall(level);
      this.setState('playing');
      this.endsAt = performance.now() + level.timeMs;
    }, BANNER_MS);
  }

  /** Every animation frame: moves the falling halves, and runs the clock while playing. */
  update(now) {
    this.moveDebris(now);
    if (this.state !== 'playing') return;
    const left = this.endsAt - now;
    if (left <= 0) {
      this.showTime(0);
      this.endGame();
      return;
    }
    this.showTime(left);
  }

  moveDebris(now) {
    for (const piece of [...this.debris]) {
      const seconds = (now - piece.t0) / 1000;
      const y = piece.y + 0.5 * GRAVITY * seconds * seconds;
      if (y > 1) {
        piece.el.remove();
        this.debris = this.debris.filter((p) => p !== piece);
        continue;
      }
      piece.el.style.left = `${(piece.x + piece.vx * seconds) * 100}%`;
      piece.el.style.top = `${y * 100}%`;
    }
  }

  /** Is the wall gone, with no explosion still to come? Then the level is won. */
  checkCleared() {
    if (this.state !== 'playing' || this.bricks.length || this.exploding) return;
    const bonus = timeBonus(this.endsAt - performance.now());
    this.round++;
    this.setState('between');
    this.timeEl.classList.remove('low');
    this.setScore(this.score + bonus);
    playLevelClear();
    this.showPanel({ title: BRICK_BREAKER_TEXT.cleared, result: BRICK_BREAKER_TEXT.bonus(bonus) });

    const { session, round } = this;
    setTimeout(() => {
      if (session === this.session && round === this.round) this.beginLevel(this.level + 1);
    }, CLEARED_MS);
  }

  endGame() {
    this.round++; // explosions still to come never go off
    this.exploding = 0;
    this.setState('over');
    // The rest of the wall crumbles, leaving the screen clear for Play again.
    for (const brick of this.bricks) this.breakBrick(brick, false);
    this.bricks = [];
    playSmash();
    playFanfare();

    const isBest = this.score > this.best;
    if (isBest) {
      this.best = this.score;
      saveBestScore(GAME_ID, this.score);
    }
    this.hud.hidden = true;
    this.camera.updateExcluded();
    this.showPanel({
      title: BRICK_BREAKER_TEXT.timeUp,
      result: BRICK_BREAKER_TEXT.result(this.level, this.score),
      best: isBest ? BRICK_BREAKER_TEXT.newBest : BRICK_BREAKER_TEXT.best(this.best),
    });
    this.panel.classList.toggle('new-best', isBest);

    const session = this.session;
    setTimeout(() => {
      if (session === this.session && this.state === 'over') this.showStartBrick(BRICK_BREAKER_TEXT.againLabel);
    }, REARM_MS);
  }

  // ---- Drawing ----

  setScore(score) {
    this.score = score;
    this.scoreEl.textContent = String(score);
  }

  setLevel(n) {
    this.level = n;
    this.levelEl.textContent = String(n);
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

  /** The wall pops in, all bricks at once. */
  showWall(level) {
    this.bricks = buildWall(level);
    for (const brick of this.bricks) {
      brick.rect = brickRect(brick, view());
      brick.el = this.addBrick(brick.rect, `brick ${brick.kind}`);
      brick.el.dataset.kind = brick.kind;
      brick.el.dataset.row = String(brick.row);
      brick.el.dataset.col = String(brick.col);
      brick.el.dataset.hp = String(brick.hp);
      brick.el.style.setProperty('--colour', KIND_COLOURS[brick.kind] ?? ROW_COLOURS[brick.row % ROW_COLOURS.length]);
    }
    this.camera.pictureChange(grow(wallArea(level.rows.length), CHANGE_PAD), POP_MS);
  }

  showStartBrick(label) {
    // The longer label needs smaller letters.
    const long = label === BRICK_BREAKER_TEXT.againLabel ? ' long-label' : '';
    const el = this.addBrick(START_BRICK, `brick start-brick${long}`);
    el.style.setProperty('--colour', START_COLOUR);
    const text = document.createElement('span');
    text.textContent = label;
    el.append(text);
    // It pops in, springing a little beyond its size first.
    this.camera.pictureChange(grow(scaled(START_BRICK, 1.15), CHANGE_PAD), START_POP_MS);
    this.startBrick = { el };
  }

  /** Adds a brick-shaped box to the screen, covering `rect`. */
  addBrick(rect, className) {
    const el = this.addElement(className, { x: rect.x0, y: rect.y0 });
    el.style.width = `${(rect.x1 - rect.x0) * 100}%`;
    el.style.height = `${(rect.y1 - rect.y0) * 100}%`;
    return el;
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
    // The panel changes size between messages: cover where it was too.
    if (!this.panel.hidden) this.camera.pictureChange(rectOf(this.panel, 0.03));
    const set = (selector, text) => {
      const el = this.panel.querySelector(selector);
      el.textContent = text;
      el.hidden = !text;
    };
    set('.bb-title', title);
    set('.bb-result', result);
    set('.bb-best', best);
    set('.bb-prompt', prompt);
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

function firstLevelOf(level) {
  return Number.isFinite(level) && level >= 1 ? Math.floor(level) : 1;
}

/** A rectangle grown by `pad` (fraction of the shorter screen side) on every side. */
function grow(rect, pad) {
  const unit = Math.min(window.innerWidth, window.innerHeight);
  const px = (pad * unit) / window.innerWidth;
  const py = (pad * unit) / window.innerHeight;
  return { x0: rect.x0 - px, y0: rect.y0 - py, x1: rect.x1 + px, y1: rect.y1 + py };
}

/** A rectangle scaled by `factor` about its centre. */
function scaled(rect, factor) {
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  const hw = ((rect.x1 - rect.x0) / 2) * factor;
  const hh = ((rect.y1 - rect.y0) / 2) * factor;
  return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
}
