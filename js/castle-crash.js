// Castle Crash: goblins have built forts of wood, ice and stone, with TNT, and
// sit on and inside them, down the field from the players, who see it from just
// behind themselves. Every throw is a boulder thrown from where they stand: it
// flies to whatever was on the screen where the ball hit, and knocks it back out
// of the fort, breaks it or cracks it, while the rest tips, slides and tumbles
// as real things would (castle-crash-logic.js, castle-crash-physics.js). Beat
// every goblin before the boulders run out to move on to the next fort;
// boulders to spare score a bonus. Everyone throws together.
//
// A throw's whole shot is worked out the moment it lands (playShot), so the
// camera can be told, a little ahead of each moment, just where the picture
// will change then (motionAreas, effectArea): what moves, appears or goes, and
// the effects. Everywhere else it keeps watching, so the next throw is taken
// almost at once, while the last is still tumbling down. That boulder joins
// the same shot: it is worked out again from the fort as it stood before the
// first, with the new boulder thrown at the moment the ball hit, and plays on
// seamlessly. Everything else that appears or goes (the fort, the panel, the
// Start sign) is reported with pictureChange first.
//
// Games start (and restart) by hitting the big Start sign; Enter, Space or a
// click work too.

import { drawBackdrop, drawEffects, drawPoses, effectArea, effectMs, effectsEndAt } from './castle-crash-art.js';
import {
  LEVELS, bonusFor, buildLevel, fortArea, goblinsIn, levelFor, mergeRects, motionAreas, playShot, posesAt, shotFor,
  standing, viewFor,
} from './castle-crash-logic.js';
import { loadBestScore, saveBestScore } from './storage.js';
import {
  playBoom, playCrack, playFanfare, playGroan, playLevelClear, playPop, playSmash, playThud,
} from './sound.js';
import { ThrowCamera, rectOf, renderGameStatus } from './throw-camera.js';

export const GAME_ID = 'castle-crash';

const BANNER_MS = 1800; // "Level 2: The Watchtower" before the fort appears
const CLEARED_MS = 2600; // "Fort smashed!" before the next level
const REARM_MS = 1500; // before Try again / Play again appears, so a ball still in the air can't hit it
const SIGN_POP_MS = 300; // the Start sign appearing or bursting (css/style.css)
const SOUND_GAP_MS = 70; // the same sound no more often than this
const THROW_GAP_MS = 250; // after a throw, the next is taken this soon (one ball is never two boulders)
// The camera is told where the picture will change this far ahead, in slices this long.
const REPORT_AHEAD_MS = 250;
const REPORT_SLICE_MS = 300;
// The Start sign: big, so anyone can hit it.
const START_SIGN = { x0: 0.3, y0: 0.4, x1: 0.7, y1: 0.7 };
const SIGN_GRACE = 0.03; // a throw this near the sign (fraction of the screen) still hits it

export const CASTLE_CRASH_TEXT = {
  title: 'Castle Crash',
  startPrompt: 'Throw a ball at the sign to start!',
  startLabel: 'START',
  retryLabel: 'TRY AGAIN',
  againLabel: 'PLAY AGAIN',
  level: (n) => `Level ${n}`,
  aim: 'Throw at the fort: beat every goblin!',
  cleared: 'Fort smashed!',
  bonus: (left, points) => (left ? `${left} boulder${left === 1 ? '' : 's'} to spare: +${points}` : 'Not a boulder to spare!'),
  failed: 'Out of boulders!',
  holdOut: (name, left) => `${left} goblin${left === 1 ? '' : 's'} still hold${left === 1 ? 's' : ''} ${name}`,
  retryPrompt: 'Throw at the sign to try again',
  won: 'Victory!',
  result: (score) => `Every fort smashed: ${score} points`,
  best: (score) => `Best score: ${score}`,
  newBest: 'New best score!',
};

export class CastleCrash {
  /**
   * @param {HTMLElement} root the game's screen element
   * @param {{level?: number}} [options] level: the level to start at
   */
  constructor(root, { level = 1 } = {}) {
    this.root = root;
    this.firstLevel = Number.isFinite(level) && level >= 1 ? Math.floor(level) : 1;
    this.field = root.querySelector('.cc-field');
    this.canvas = root.querySelector('.cc-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.hud = root.querySelector('.cc-hud');
    this.scoreEl = root.querySelector('.cc-score b');
    this.levelEl = root.querySelector('.cc-level b');
    this.goblinsEl = root.querySelector('.cc-goblins b');
    this.bouldersEl = root.querySelector('.cc-boulders i');
    this.panel = root.querySelector('.cc-panel');
    this.bar = root.querySelector('.game-bar');
    this.statusEl = root.querySelector('.game-status');

    this.session = 0; // increments when the game starts or stops, so stale timers can tell
    this.round = 0; // increments when a level starts or ends
    this.state = 'ready'; // 'ready' | 'playing' | 'over'
    this.phase = 'between'; // while playing: 'aiming' | 'shot' | 'between'
    this.level = null;
    this.levelNumber = this.firstLevel;
    this.fort = null;
    this.boulders = 0; // boulders left for this fort
    this.score = 0;
    this.levelStartScore = 0; // what the score was when this fort began, for Try again
    this.best = 0;
    // The shot playing out: the play, its boulders (`throws`), the fort as it stood before the first
    // (`before`), when it began, how long it lasts, the next event, how far ahead the camera has been told.
    this.play = null;
    this.goblinsLeft = 0; // as far as the shot has got
    this.readyAt = 0; // balls on pictures from before this are not a throw
    this.sign = null; // the Start / Try again / Play again sign, when shown: {el, action}
    // For the debug view and tests: balls the camera saw hit the screen since the game was opened, and throws
    // that missed the sign.
    this.balls = 0;
    this.misses = 0;
    this.lastSound = new Map();
    this.view = viewFor(window.innerWidth, window.innerHeight);

    this.camera = new ThrowCamera(root, {
      onHit: (hit) => this.throwAt(hit, 'ball', hit.time),
      onNote: () => this.updateStatus(),
    });
    this.camera.ignore(this.bar, this.hud);

    this.field.addEventListener('click', (e) => {
      this.throwAt({ x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }, 'mouse', performance.now());
    });
    document.addEventListener('fullscreenchange', () => this.updateStatus());
    window.addEventListener('resize', () => {
      if (!this.root.classList.contains('active')) return;
      this.camera.pictureChangeEverywhere();
      this.layout();
      this.drawStill();
    });
  }

  /** @param {import('./storage.js').Calibration|null} calibration */
  start(calibration) {
    this.session++;
    this.root.dataset.balls = String(this.balls);
    this.root.dataset.misses = String(this.misses);
    this.best = loadBestScore(GAME_ID);
    this.reset();
    this.layout();
    this.drawStill();
    this.setState('ready');
    this.showPanel({
      title: CASTLE_CRASH_TEXT.title,
      best: this.best ? CASTLE_CRASH_TEXT.best(this.best) : '',
      prompt: CASTLE_CRASH_TEXT.startPrompt,
    });
    this.showSign(CASTLE_CRASH_TEXT.startLabel, () => this.beginGame());
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

  /** Enter / Space: the same as hitting the sign. */
  pressStart() {
    if (this.sign) this.hitSign();
  }

  reset() {
    this.round++;
    this.play = null;
    this.fort = null;
    this.goblinsLeft = 0;
    this.level = null;
    this.sign?.el.remove();
    this.sign = null;
    this.score = 0;
    this.panel.hidden = true;
    this.hud.hidden = true;
    this.phase = 'between';
    this.camera.updateExcluded();
  }

  setState(state) {
    this.state = state;
    this.root.dataset.state = state;
  }

  setPhase(phase) {
    this.phase = phase;
    this.root.dataset.phase = phase;
  }

  // ---- Throws ----

  /**
   * A ball (or a click) hit the screen.
   * @param {{x:number, y:number, speedMph?: number|null}} hit normalised screen coordinates
   * @param {'ball'|'mouse'} source
   * @param {number} time when the picture it landed on was on screen
   */
  throwAt(hit, source, time) {
    if (source === 'ball') {
      this.balls++;
      this.root.dataset.balls = String(this.balls);
    }
    if (this.state === 'playing') {
      if (!this.canShoot() || time < this.readyAt) return;
      this.shoot(hit);
    } else if (this.sign) {
      if (inside(START_SIGN, hit, SIGN_GRACE)) {
        this.hitSign();
      } else {
        this.misses++;
        this.root.dataset.misses = String(this.misses);
        playThud();
      }
    }
  }

  /** Can a boulder be thrown now: a boulder left, and goblins the shot playing out won't beat anyway? */
  canShoot() {
    if (this.phase === 'aiming') return this.boulders > 0;
    return this.phase === 'shot' && this.boulders > 0 && this.play?.play.goblinsLeft > 0;
  }

  /**
   * The boulder flies: the whole shot is worked out now and played back. One
   * thrown while a shot plays out joins it: the shot is worked out again, from
   * the fort as it was before it began, with this boulder thrown now.
   */
  shoot(hit) {
    const now = performance.now();
    this.boulders--;
    this.readyAt = now + THROW_GAP_MS;
    if (!this.play) {
      const before = structuredClone(this.fort);
      const shot = shotFor(hit, this.view, this.fort);
      this.play = { play: null, throws: [{ shot, atMs: 0 }], before, startedAt: now, totalMs: 0, next: 0, reportedTo: 0 };
    } else {
      const atMs = now - this.play.startedAt;
      const { play } = this.play;
      const shot = shotFor(hit, this.view, this.fort, posesAt(play, Math.min(atMs, play.endMs)));
      this.play.throws.push({ shot, atMs });
      this.fort = structuredClone(this.play.before);
      this.play.reportedTo = atMs; // what is to come has changed: tell the camera afresh
    }
    const play = playShot(this.fort, this.play.throws);
    this.play.play = play;
    this.play.totalMs = Math.max(play.endMs, effectsEndAt(play.events)) + 50;
    this.reportAhead(now - this.play.startedAt);
    this.setPhase('shot');
    this.showHud();
    playThud();
  }

  /**
   * Tells the camera where the shot will change the picture, from what it has
   * been told up to `REPORT_AHEAD_MS` past `ms` (into the shot), a slice at a time.
   */
  reportAhead(ms) {
    const p = this.play;
    const { play } = p;
    while (p.reportedTo < Math.min(ms + REPORT_AHEAD_MS, p.totalMs)) {
      const from = p.reportedTo;
      const to = Math.min(from + REPORT_SLICE_MS, p.totalMs);
      for (const rect of motionAreas(play, this.view, from, to)) this.camera.pictureChange(grown(rect, 0.01), to - ms, { quick: true });
      const effects = [];
      let lasts = 0;
      for (const event of play.events) {
        if (event.ms < from) continue;
        if (event.ms >= to) break;
        effects.push(effectArea(this.view, event, play.bodies.get(event.id)));
        lasts = Math.max(lasts, event.ms + effectMs(event));
      }
      for (const rect of mergeRects(effects, 2)) this.camera.pictureChange(grown(rect, 0.01), lasts - ms, { quick: true });
      p.reportedTo = to;
    }
  }

  /** Every animation frame: plays the shot, if one is flying. */
  update(now) {
    if (!this.play) return;
    const { play, startedAt, totalMs } = this.play;
    const ms = Math.min(now - startedAt, totalMs);
    this.reportAhead(ms);
    while (this.play.next < play.events.length && play.events[this.play.next].ms <= ms) {
      this.happen(play.events[this.play.next++]);
    }
    const { ctx, view } = this;
    drawBackdrop(ctx, view, this.fort.pads);
    drawPoses(ctx, view, posesAt(play, Math.min(ms, play.endMs)).filter((p) => ms < play.endMs || p.body.kind !== 'boulder'));
    drawEffects(ctx, view, play.events, play.bodies, ms);
    if (ms >= totalMs) this.finishShot();
  }

  /** A break, a goblin beaten, a blast: its points and its sound. */
  happen(event) {
    const beaten = event.type === 'goblin' || (event.type === 'gone' && this.play.play.bodies.get(event.id)?.kind === 'goblin');
    if (beaten) this.goblinsLeft = Math.max(0, this.goblinsLeft - 1);
    if (event.points) {
      this.score += event.points;
      this.showHud();
    }
    const body = this.play.play.bodies.get(event.id);
    if (event.type === 'boom') this.sound('boom', playBoom);
    else if (beaten) this.sound('goblin', () => playPop(true));
    else if (event.type === 'break') {
      if (body?.material === 'ice') this.sound('ice', playCrack);
      else if (body?.material !== 'tnt') this.sound('smash', playSmash);
    }
  }

  sound(kind, play) {
    const now = performance.now();
    if (now - (this.lastSound.get(kind) ?? -Infinity) < SOUND_GAP_MS) return;
    this.lastSound.set(kind, now);
    play();
  }

  /** The shot is over: the next throw, or the fort is beaten, or the boulders are gone. */
  finishShot() {
    const { play } = this.play;
    this.play = null;
    this.goblinsLeft = goblinsIn(this.fort).length;
    this.drawStill();
    this.showHud();
    if (play.goblinsLeft === 0) this.fortCleared();
    else if (this.boulders <= 0) this.fortHeld();
    else this.setPhase('aiming');
  }

  // ---- Game flow ----

  beginGame() {
    this.score = 0;
    this.setState('playing');
    this.beginLevel(this.firstLevel);
  }

  /** "Level 2: The Watchtower", then the fort appears and players aim. */
  beginLevel(n) {
    this.round++;
    this.levelNumber = n;
    this.level = levelFor(n);
    this.levelStartScore = this.score;
    this.boulders = this.level.boulders;
    this.setPhase('between');
    // The old fort goes.
    if (this.fort) this.camera.pictureChange(fortArea(this.fort, this.view));
    this.fort = null;
    this.goblinsLeft = 0;
    this.drawStill();
    this.hud.hidden = false;
    this.camera.updateExcluded();
    this.showHud();
    this.showPanel({ title: CASTLE_CRASH_TEXT.level(n), result: this.level.name, prompt: CASTLE_CRASH_TEXT.aim });

    const { session, round } = this;
    setTimeout(() => {
      if (session !== this.session || round !== this.round) return;
      this.hidePanel();
      this.fort = buildLevel(this.level);
      this.goblinsLeft = goblinsIn(this.fort).length;
      this.camera.pictureChange(fortArea(this.fort, this.view));
      this.drawStill();
      this.showHud();
      this.readyAt = performance.now();
      this.setPhase('aiming');
    }, BANNER_MS);
  }

  fortCleared() {
    this.round++;
    this.setPhase('between');
    const bonus = bonusFor(this.boulders);
    this.score += bonus;
    this.saveBest();
    playLevelClear();
    this.showHud();
    this.showPanel({ title: CASTLE_CRASH_TEXT.cleared, result: CASTLE_CRASH_TEXT.bonus(this.boulders, bonus) });
    const { session, round } = this;
    setTimeout(() => {
      if (session !== this.session || round !== this.round) return;
      if (this.levelNumber >= LEVELS.length) this.winGame();
      else this.beginLevel(this.levelNumber + 1);
    }, CLEARED_MS);
  }

  /** The boulders ran out with goblins left: try this fort again, from the score it began with. */
  fortHeld() {
    this.round++;
    this.setPhase('between');
    this.setState('over');
    playGroan();
    const left = goblinsIn(this.fort).length;
    this.showPanel({
      title: CASTLE_CRASH_TEXT.failed,
      result: CASTLE_CRASH_TEXT.holdOut(this.level.name, left),
      prompt: CASTLE_CRASH_TEXT.retryPrompt,
    });
    const session = this.session;
    setTimeout(() => {
      if (session !== this.session || this.state !== 'over') return;
      this.showSign(CASTLE_CRASH_TEXT.retryLabel, () => {
        this.score = this.levelStartScore;
        this.setState('playing');
        this.beginLevel(this.levelNumber);
      });
    }, REARM_MS);
  }

  winGame() {
    this.round++;
    this.setState('over');
    this.setPhase('between');
    playFanfare();
    const isBest = this.saveBest();
    if (this.fort) this.camera.pictureChange(fortArea(this.fort, this.view));
    this.fort = null;
    this.drawStill();
    this.hud.hidden = true;
    this.camera.updateExcluded();
    this.showPanel({
      title: CASTLE_CRASH_TEXT.won,
      result: CASTLE_CRASH_TEXT.result(this.score),
      best: isBest ? CASTLE_CRASH_TEXT.newBest : this.best ? CASTLE_CRASH_TEXT.best(this.best) : '',
    });
    this.panel.classList.toggle('new-best', isBest);
    const session = this.session;
    setTimeout(() => {
      if (session === this.session && this.state === 'over') this.showSign(CASTLE_CRASH_TEXT.againLabel, () => this.beginGame());
    }, REARM_MS);
  }

  /** Keeps the score if it is the best yet (not when playing with the mouse only). True if it was. */
  saveBest() {
    if (this.camera.mouseOnly || this.score <= this.best) return false;
    this.best = this.score;
    saveBestScore(GAME_ID, this.score);
    return true;
  }

  // ---- Drawing ----

  /** Sizes the canvas to the screen. */
  layout() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.view = viewFor(width, height);
  }

  /** The still picture: the field and the fort as it stands. */
  drawStill() {
    drawBackdrop(this.ctx, this.view, this.fort?.pads);
    if (this.fort) drawPoses(this.ctx, this.view, standing(this.fort));
  }

  showHud() {
    const goblins = this.fort ? this.goblinsLeft : 0;
    this.scoreEl.textContent = String(this.score);
    this.levelEl.textContent = String(this.levelNumber);
    this.goblinsEl.textContent = String(goblins);
    Object.assign(this.root.dataset, { level: String(this.levelNumber), goblins: String(goblins), boulders: String(this.boulders) });
    const total = this.level?.boulders ?? 0;
    this.bouldersEl.replaceChildren(...Array.from({ length: total }, (_, i) => {
      const dot = document.createElement('span');
      dot.className = i < this.boulders ? 'left' : 'used';
      return dot;
    }));
  }

  showSign(label, action) {
    this.sign?.el.remove();
    const el = document.createElement('div');
    el.className = `cc-sign${label.length > 6 ? ' long-label' : ''}`;
    el.style.left = `${START_SIGN.x0 * 100}%`;
    el.style.top = `${START_SIGN.y0 * 100}%`;
    el.style.width = `${(START_SIGN.x1 - START_SIGN.x0) * 100}%`;
    el.style.height = `${(START_SIGN.y1 - START_SIGN.y0) * 100}%`;
    const text = document.createElement('span');
    text.textContent = label;
    el.append(text);
    this.field.append(el);
    // It pops in, springing a little beyond its size.
    this.camera.pictureChange(grown(START_SIGN, 0.06), SIGN_POP_MS);
    this.sign = { el, action };
  }

  hitSign() {
    const { el, action } = this.sign;
    this.sign = null;
    el.classList.add('pop');
    this.camera.pictureChange(grown(START_SIGN, 0.1), SIGN_POP_MS);
    setTimeout(() => el.remove(), SIGN_POP_MS);
    playSmash();
    this.hidePanel();
    action();
  }

  showPanel({ title, result = '', best = '', prompt = '' }) {
    // The panel changes size between messages: cover where it was too.
    if (!this.panel.hidden) this.camera.pictureChange(rectOf(this.panel, 0.03));
    const set = (selector, text) => {
      const el = this.panel.querySelector(selector);
      el.textContent = text;
      el.hidden = !text;
    };
    set('.cc-title', title);
    set('.cc-result', result);
    set('.cc-best', best);
    set('.cc-prompt', prompt);
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

/** Is the point inside `rect`, or within `grace` of it (all normalised)? */
function inside(rect, point, grace) {
  return point.x >= rect.x0 - grace && point.x <= rect.x1 + grace && point.y >= rect.y0 - grace && point.y <= rect.y1 + grace;
}

/** A rectangle grown by `pad` on every side. */
function grown(rect, pad) {
  return { x0: rect.x0 - pad, y0: rect.y0 - pad, x1: rect.x1 + pad, y1: rect.y1 + pad };
}
