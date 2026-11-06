// Golden Boot: ten penalties against a goalkeeper, kicked (or thrown) at the
// picture. Where the ball hits the screen is where the penalty goes; the keeper
// sees it coming and dives, and gets better after every goal. The score is the
// goals, out of ten.
//
// A shootout starts (and restarts) by hitting the Start target, so nobody needs
// to walk over to the computer; Enter, Space or a click work too. Each kick goes:
// the whistle (the kick is ready), a ball hits the screen, the ball flies and the
// keeper dives (about two seconds, in which further balls are ignored), a big
// word for the result, then the keeper is back in the middle with a ball on the
// spot for the next kick.
//
// How long the ball takes to reach the goal depends on how hard it was kicked, where
// both cameras followed it in: compared with the average of the kicks before it, a harder
// kick gets there sooner, and the keeper has less time to dive. Its speed in mph shows
// under the big word, if the screen's width is known. The average is kept in the browser.
//
// Everything is drawn in 3D (see golden-boot-scene.js; Dunk the Clown's renderer draws
// it). The picture is drawn only when something changes, and each burst of change is
// reported to the camera first (pictureChange…) so the projector's own picture is never
// mistaken for a ball. While players aim, nothing on the screen moves.

import { loadBestScore, loadKickSpeeds, saveBestScore, saveKickSpeeds } from './storage.js';
import { mphText } from './format.js';
import {
  playClang, playDing, playFanfare, playGroan, playKick, playRoar, playThud, playWhistle,
} from './sound.js';
import { ClownRenderer } from './dunk-the-clown-gl.js';
import {
  GOLDEN_BOOT_RULES, decideShot, flightMsFor, goalsIn, learnSpeed, nextLevel, onTarget, resultWord,
} from './golden-boot-logic.js';
import { shotPoint } from './golden-boot-models.js';
import { BootScene, SCENE_MS, planShot } from './golden-boot-scene.js';
import { ThrowCamera, rectOf, renderGameStatus } from './throw-camera.js';

export const GAME_ID = 'golden-boot';

const WORD_MS = 400; // the big word pops in (a CSS animation)
// The Start target is in the grass between the goal and the ball on the spot.
const START_TARGET = { x: 0.5, y: 0.68, r: 0.15 };
// A kick is ready this long after the picture went back to waiting: the camera sees the change a
// little late, and there is the whistle.
const READY_MS = 1100;
// After the last kick, the Play again target appears this much later, so a ball still in the air
// can't start the next shootout by accident.
const REARM_MS = 1500;

export const GOLDEN_BOOT_TEXT = {
  title: 'Golden Boot',
  startPrompt: 'Throw a ball at the target to start!',
  startLabel: 'START',
  againLabel: 'PLAY AGAIN',
  fullTime: 'Full time!',
  best: (score) => `Best score: ${score}`,
  newBest: 'New best score!',
  result: (goals, kicks) => `You scored ${goals} / ${kicks}`,
};

export class GoldenBoot {
  /**
   * @param {HTMLElement} root the game's screen element
   * @param {{random?: () => number}} [options] random: decides the keeper's close calls (fix it to repeat a game)
   */
  constructor(root, { random = Math.random } = {}) {
    this.root = root;
    this.random = random;
    this.kicks = GOLDEN_BOOT_RULES.kicks;
    this.canvas = root.querySelector('.gb-canvas');
    this.field = root.querySelector('.gb-field');
    this.hud = root.querySelector('.gb-hud');
    this.scoreEl = root.querySelector('.gb-score b');
    this.kickEl = root.querySelector('.gb-kick b');
    this.tallyEl = root.querySelector('.gb-tally');
    this.wordEl = root.querySelector('.gb-word');
    this.speedEl = root.querySelector('.gb-speed');
    this.panel = root.querySelector('.gb-panel');
    this.bar = root.querySelector('.game-bar');
    this.statusEl = root.querySelector('.game-status');
    // One marker for each kick: still to take, a goal, or a miss.
    this.tally = Array.from({ length: this.kicks }, () => document.createElement('li'));
    this.tallyEl.replaceChildren(...this.tally);
    this.root.querySelectorAll('.gb-kick b')[1].textContent = String(this.kicks);

    this.session = 0; // increments when the game starts or stops, so stale timers can tell
    this.state = 'ready'; // 'ready' (the Start target) | 'playing' | 'over'
    this.phase = 'between'; // while playing: 'aiming' (a ball can be kicked) | 'shot' | 'between'
    this.renderer = null; // the 3D picture: set up when the game starts, once its screen is showing
    this.scene = null;
    this.startTarget = null; // the Start / Play again target, when shown
    this.results = []; // 'goal', 'saved' or 'miss' for each kick taken
    this.level = GOLDEN_BOOT_RULES.keeper.startLevel;
    this.readyAt = 0; // balls on pictures from before this are not a kick
    this.shotArea = null; // what the kick changed, to report again when the picture goes back
    this.balls = 0; // balls the camera saw hit the screen, since the game was opened
    this.misses = 0; // throws at the Start target that missed
    this.best = 0;
    this.last = null; // the last shot: {result, shot, flightMs, mph}
    this.speeds = []; // how fast the latest kicks were (screen widths a second), kept in the browser: the average is what a usual kick is

    this.camera = new ThrowCamera(root, {
      onHit: (hit) => this.throwAt(hit, 'ball', hit.time),
      onNote: () => this.updateStatus(),
    });
    this.camera.ignore(this.bar, this.hud);
    window.addEventListener('resize', () => this.resize());

    this.field.addEventListener('click', (e) => {
      this.throwAt({ x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }, 'mouse', performance.now());
    });
    document.addEventListener('fullscreenchange', () => this.updateStatus());
  }

  /** @param {import('./storage.js').Calibration|null} calibration */
  start(calibration) {
    this.session++;
    this.best = loadBestScore(GAME_ID);
    this.speeds = loadKickSpeeds();
    this.setUpPicture();
    this.reset();
    this.setState('ready');
    this.showPanel({
      title: GOLDEN_BOOT_TEXT.title,
      best: this.best ? GOLDEN_BOOT_TEXT.best(this.best) : '',
      prompt: GOLDEN_BOOT_TEXT.startPrompt,
    });
    this.showStartTarget(GOLDEN_BOOT_TEXT.startLabel);
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
      this.scene = new BootScene(view());
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

  /** Enter / Space: start a shootout, the same as hitting the Start target. */
  pressStart() {
    if (this.startTarget) this.hitStartTarget();
  }

  reset() {
    this.field.replaceChildren();
    this.scene?.reset();
    this.startTarget = null;
    this.results = [];
    this.level = GOLDEN_BOOT_RULES.keeper.startLevel;
    this.phase = 'between';
    this.misses = 0;
    this.last = null;
    this.panel.hidden = true;
    this.hud.hidden = true;
    this.wordEl.hidden = true;
    this.speedEl.hidden = true;
    this.showHud();
    this.publish();
    this.camera.updateExcluded();
  }

  setState(state) {
    this.state = state;
    this.root.dataset.state = state;
  }

  /** What the game is doing, for the end-to-end test to read. */
  publish() {
    const d = this.root.dataset;
    d.phase = this.phase;
    d.kick = String(Math.min(this.kicks, this.results.length + 1));
    d.goals = String(goalsIn(this.results));
    d.results = this.results.join(',');
    d.level = String(this.level);
    d.balls = String(this.balls);
    d.misses = String(this.misses);
    d.last = this.last ? this.last.result.kind : '';
    d.lastShot = this.last ? `${this.last.result.shot.x.toFixed(3)},${this.last.result.shot.y.toFixed(3)}` : '';
    d.flightMs = this.last ? String(Math.round(this.last.flightMs)) : '';
    d.kickMph = this.last?.mph ? this.last.mph.toFixed(1) : '';
  }

  // ---- Throws ----

  /**
   * A ball (or a mouse click) hit the screen.
   * @param {{x:number, y:number, speed?:number|null, speedMph?:number|null}} point normalised screen coordinates (a
   *   ball also has its speed, if two cameras followed it in)
   * @param {'ball'|'mouse'} source
   * @param {number} time when the picture it landed on was on screen (performance.now())
   */
  throwAt(point, source, time) {
    if (source === 'ball') {
      this.balls++;
      this.publish();
    }
    if (this.state === 'playing') {
      // One shot a kick: nothing while a kick is playing out, and nothing from before the kick was ready.
      if (this.phase !== 'aiming' || time < this.readyAt) return;
      this.shoot(point);
    } else if (this.startTarget) {
      if (onTarget(this.startTarget, point, view())) {
        this.hitStartTarget();
      } else {
        this.misses++;
        this.publish();
        playThud();
      }
    }
  }

  /**
   * The ball hit the screen at `point`: it is the penalty. A kick whose speed was measured takes longer or
   * less long to reach the goal than the average of the kicks before it, and joins them in the average.
   */
  shoot(point) {
    const shot = shotPoint(this.scene.camera, point);
    const flightMs = flightMsFor(point.speed, this.speeds);
    const result = decideShot(shot, this.level, this.random, GOLDEN_BOOT_RULES, flightMs);
    const plan = planShot(result, GOLDEN_BOOT_RULES, flightMs);
    const learned = learnSpeed(this.speeds, point.speed);
    if (learned !== this.speeds) {
      this.speeds = learned;
      saveKickSpeeds(learned);
    }
    this.phase = 'shot';
    this.last = {
      result, shot, flightMs, mph: Number.isFinite(point.speedMph) ? point.speedMph : null,
    };
    // The whole burst of motion, reported before any of it is drawn.
    this.shotArea = this.scene.shotArea(plan);
    this.camera.pictureChange(this.shotArea, plan.durationMs);
    this.scene.kick(plan, performance.now());
    this.publish();
    playKick();

    const session = this.session;
    setTimeout(() => {
      if (session === this.session) this.conclude(result);
    }, plan.impactMs);
    setTimeout(() => {
      if (session === this.session) this.finishKick(result);
    }, plan.durationMs);
  }

  /** The ball has reached the goal: the result, the crowd, the tally. */
  conclude(result) {
    this.results.push(result.kind);
    this.level = nextLevel(result.level, result.kind);
    if (result.kind === 'goal') playRoar();
    else playGroan();
    if (result.wood) playClang();
    this.showWord(result, this.last?.mph ?? null);
    this.showHud();
    this.publish();
  }

  /** The kick is over: back to waiting for the next, or full time. */
  finishKick() {
    this.hideWord();
    this.camera.pictureChange(this.shotArea, 0);
    this.scene.reset();
    if (this.results.length >= this.kicks) {
      this.endShootout();
      return;
    }
    this.getReady();
  }

  /** Waits for the camera to settle on the picture, then the whistle: the next kick is ready. */
  getReady() {
    this.phase = 'between';
    this.readyAt = performance.now() + READY_MS;
    this.showHud();
    this.publish();
    const session = this.session;
    setTimeout(() => {
      if (session !== this.session || this.state !== 'playing') return;
      this.phase = 'aiming';
      this.publish();
      playWhistle();
    }, READY_MS);
  }

  hitStartTarget() {
    const target = this.startTarget;
    this.startTarget = null;
    this.camera.pictureChange(this.scene.startArea(target), SCENE_MS.burst);
    this.scene.hitStart(performance.now());
    playDing(2);
    this.beginShootout();
  }

  // ---- Shootout flow ----

  beginShootout() {
    this.setState('playing');
    this.hidePanel();
    this.results = [];
    this.level = GOLDEN_BOOT_RULES.keeper.startLevel;
    this.hud.hidden = false;
    this.camera.updateExcluded();
    this.getReady();
  }

  endShootout() {
    this.setState('over');
    this.phase = 'between';
    const goals = goalsIn(this.results);
    playFanfare();
    const isBest = !this.camera.mouseOnly && goals > this.best;
    if (isBest) {
      this.best = goals;
      saveBestScore(GAME_ID, goals);
    }
    this.publish();
    this.showPanel({
      title: GOLDEN_BOOT_TEXT.fullTime,
      result: GOLDEN_BOOT_TEXT.result(goals, this.kicks),
      best: isBest ? GOLDEN_BOOT_TEXT.newBest : this.best ? GOLDEN_BOOT_TEXT.best(this.best) : '',
    });
    this.panel.classList.toggle('new-best', isBest);

    const session = this.session;
    setTimeout(() => {
      if (session === this.session && this.state === 'over') this.showStartTarget(GOLDEN_BOOT_TEXT.againLabel);
    }, REARM_MS);
  }

  // ---- Drawing ----

  /** The goals, the kick we are on and the tally. */
  showHud() {
    const taken = this.results.length;
    this.scoreEl.textContent = String(goalsIn(this.results));
    this.kickEl.textContent = String(Math.min(this.kicks, taken + 1));
    this.tally.forEach((li, i) => {
      li.dataset.state = i < taken ? this.results[i] : 'todo';
      li.classList.toggle('now', i === taken && this.state === 'playing');
    });
  }

  /** The big word for the result, and under it how fast the kick was if that was measured (`mph`). */
  showWord(result, mph = null) {
    const word = resultWord(result);
    this.wordEl.textContent = word;
    this.wordEl.dataset.kind = result.kind;
    this.wordEl.toggleAttribute('data-long', word.length > 8);
    this.wordEl.hidden = false;
    // Re-adding the text restarts its pop-in animation.
    this.wordEl.style.animation = 'none';
    void this.wordEl.offsetWidth;
    this.wordEl.style.animation = '';
    this.camera.pictureChange(rectOf(this.wordEl, 0.03), WORD_MS);
    if (mph === null) return;
    this.speedEl.textContent = mphText(mph);
    this.speedEl.hidden = false;
    this.speedEl.style.animation = 'none';
    void this.speedEl.offsetWidth;
    this.speedEl.style.animation = '';
    this.camera.pictureChange(rectOf(this.speedEl, 0.03), WORD_MS);
  }

  hideWord() {
    if (!this.speedEl.hidden) {
      this.camera.pictureChange(rectOf(this.speedEl, 0.03));
      this.speedEl.hidden = true;
    }
    if (this.wordEl.hidden) return;
    this.camera.pictureChange(rectOf(this.wordEl, 0.03));
    this.wordEl.hidden = true;
  }

  showStartTarget(label) {
    const target = { ...START_TARGET };
    this.camera.pictureChange(this.scene.startArea(target), 250);
    this.scene.showStart(target, label, performance.now());
    this.startTarget = target;
  }

  showPanel({ title, result = '', best = '', prompt = '' }) {
    const set = (selector, text) => {
      const el = this.panel.querySelector(selector);
      el.textContent = text;
      el.hidden = !text;
    };
    set('.gb-title', title);
    set('.gb-result', result);
    set('.gb-best', best);
    set('.gb-prompt', prompt);
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
