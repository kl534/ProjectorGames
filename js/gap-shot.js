// Gap Shot: bat for the Red Rock Rattlers against the Harbor City Lamplighters, off
// a tee, into the projected ballpark. Players pick a level (how hard the ball comes
// off the bat, how far the fence is and how good the fielders are) and 1, 3 or 9
// innings, by hitting at the targets. The view is through the batter's eyes, looking
// out at the field from behind home plate, and nothing moves while players aim. Where a
// ball hits the screen sets the way the ball leaves the tee: left and right the spray
// angle, up and down the launch angle (gap-shot-logic.js), and the defence then plays it
// out (gap-shot-play.js) with the camera rising to follow the ball and the fielders
// chasing it (gap-shot-scene.js). A ball both cameras followed in leaves the tee at the
// angle and speed it arrived at instead, or, where both followed it from the bat (a ball
// tossed and hit: the camera's launch mode), at the angle and speed it left the bat at; a
// turn in the air (the bat) is never taken for the screen. Under the call, how it left the tee: its speed in
// mph (if measured), and its launch and spray angles. With two cameras, a ball topped into the
// floor or popped up over the top of the screen is a swing too, from its flight (Hit.fromFlight):
// it is sent where it was heading, so off the bottom of the screen is a grounder and off the
// top a pop-up.
// Three outs end an inning; the score is the runs.
//
// The camera: the picture stands still while players aim, apart from nothing. A swing
// changes all of it (the camera moves, everyone runs), so the game tells the camera
// about the whole play at once, with its length (pictureChangeEverywhere), and nothing
// more is looked for until the view is back at the batter's eyes and still. A ball counts
// only if the picture it landed on was on screen after that, and only one hit a swing.
//
// Rules and the ball are in gap-shot-logic.js, gap-shot-physics.js and gap-shot-play.js
// (no browser code, unit tested); the drawing is Fielder's Choice's ballpark and players
// (fielders-choice-art.js).

import { loadBestScore, saveBestScore } from './storage.js';
import { swingText } from './format.js';
import {
  playBatCrack, playBeep, playCheer, playCrowdNoise, playDing, playFanfare, playFirework, playGlovePop, playGroan, playRoar, playThud,
} from './sound.js';
import { BASES, makeCamera, ordinal } from './fielders-choice-logic.js';
import { drawFireworks, drawScene, fitCanvas } from './fielders-choice-art.js';
import {
  GAP_SHOT_RULES as RULES, LEVELS, LEVEL_IDS, applyPlay, batterView, fieldersOf, hitFor, newGame, scoreKey,
} from './gap-shot-logic.js';
import { planHit } from './gap-shot-play.js';
import {
  CAMERA, ballShapes, cameraPath, fenceShapes, fireworksFor, markerShapes, playFigures, restFigures,
} from './gap-shot-scene.js';
import { SETTLE_MS, ThrowCamera, rectOf, renderGameStatus } from './throw-camera.js';

export const GAME_ID = 'gap-shot';

// After a play the camera is back and the picture still; a swing is ready this long after (the camera sees
// the change a little late, and takes a moment to settle on the picture).
const READY_MS = SETTLE_MS + 300;
const INNING_MS = 2400; // "Three outs!" between innings
const POP_MS = 250; // a target appearing
const BURST_MS = 350; // …and being hit
const SPLAT_MS = 1200;
const SPLAT_RADIUS = 0.035;
// After the game ends, the targets to play again appear this much later, so a ball still in the air can't
// start the next game by accident.
const REARM_MS = 1500;
const PICK_RADIUS = 0.1; // fraction of the shorter screen side
const PICK_GRACE = 1.2; // a throw this many radii from a pick target's centre picks it
const LEVEL_SPOTS = [{ x: 0.24, y: 0.36 }, { x: 0.5, y: 0.36 }, { x: 0.76, y: 0.36 }];
const INNINGS_SPOTS = [{ x: 0.3, y: 0.36 }, { x: 0.5, y: 0.36 }, { x: 0.7, y: 0.36 }];
const AGAIN_SPOTS = { again: { x: 0.35, y: 0.5 }, change: { x: 0.65, y: 0.5 } };

export const GAP_SHOT_TEXT = {
  title: 'Gap Shot',
  pickLevel: 'Hit a ball at a level to play it',
  pickInnings: (level) => `${LEVELS[level].name}. How many innings?`,
  levelLabel: (id) => LEVELS[id].name.toUpperCase(),
  inningsLabel: (n) => `${n} INNING${n === 1 ? '' : 'S'}`,
  strike: (strikes) => `Strike ${strikes}`,
  keepSwinging: 'Foul – swing again',
  inningOver: (inning) => `Three outs! That’s the ${ordinal(inning)} inning.`,
  mercy: (inning) => `Mercy rule – ${RULES.mercyRuns} runs. That’s the ${ordinal(inning)} inning.`,
  gameOver: (runs) => (runs === 0 ? 'No runs' : 'Game over'),
  result: (runs, level, innings) => `${runs} run${runs === 1 ? '' : 's'} in ${innings} inning${innings === 1 ? '' : 's'} at ${LEVELS[level].name}`,
  best: (runs) => `Most runs here: ${runs}`,
  newBest: 'New record!',
  again: 'PLAY AGAIN',
  change: 'NEW LEVEL',
};

export class GapShot {
  /** @param {HTMLElement} root the game's screen element */
  constructor(root) {
    this.root = root;
    this.field = root.querySelector('.gs-field');
    this.scene = root.querySelector('.gs-scene');
    this.fx = root.querySelector('.gs-fx');
    this.hud = root.querySelector('.gs-hud');
    this.inningEl = root.querySelector('.gs-inning b');
    this.outsEl = root.querySelector('.gs-outs b');
    this.strikesEl = root.querySelector('.gs-strikes b');
    this.runsEl = root.querySelector('.gs-runs b');
    this.diamond = root.querySelector('.gs-diamond');
    this.callEl = root.querySelector('.gs-call');
    this.caption = root.querySelector('.gs-caption');
    this.panel = root.querySelector('.gs-panel');
    this.bar = root.querySelector('.game-bar');
    this.statusEl = root.querySelector('.game-status');

    this.session = 0; // increments when the game starts or stops, so stale timers can tell
    this.state = 'pick-level'; // 'pick-level' | 'pick-innings' | 'playing' | 'over'
    this.phase = ''; // while playing: 'aiming' (a ball can be hit) | 'play' | 'between'
    this.picks = []; // the targets on screen to pick from: {x, y, r, el, value}
    this.level = 'high';
    this.innings = 3;
    this.game = null;
    this.shown = null; // what the score shows (the play's outs and runs, before the inning changes over)
    this.play = null; // the play being shown: {plan, t0, path, …}
    this.markers = []; // where each ball this inning landed or was caught
    this.lineScore = [];
    this.crowd = { mood: 'still', since: 0 };
    this.fences = new Map(); // each level's portable fence as shapes, built once
    this.readyAt = 0; // balls on pictures from before this are not a swing
    this.balls = 0; // balls the camera saw hit the screen, since the game was opened
    this.last = null; // the last swing: {spray, launch, plan}

    this.camera = new ThrowCamera(root, {
      onHit: (hit) => this.hitAt(hit, 'ball', hit.time),
      onNote: () => this.updateStatus(),
      // A ball topped into the floor, or popped up over the screen, is a swing too (two cameras).
      flightHits: true,
      // A ball tossed and hit: followed from the bat, so how it left the bat is measured, and the bat is
      // never taken for the screen.
      launch: true,
    });
    this.camera.ignore(this.bar, this.hud, this.caption, this.panel);

    this.field.addEventListener('click', (e) => {
      this.hitAt({ x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }, 'mouse', performance.now());
    });
    document.addEventListener('fullscreenchange', () => this.updateStatus());
    window.addEventListener('resize', () => this.redraw());
  }

  /** @param {import('./storage.js').Calibration|null} calibration */
  start(calibration) {
    this.session++;
    this.reset();
    this.showLevels();
    this.updateStatus();
    this.startLoop();
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

  /** Enter / Space: pick the last level or innings again, or play again. */
  pressStart() {
    if (this.state === 'pick-level') this.pickLevel(this.level);
    else if (this.state === 'pick-innings') this.pickInnings(this.innings);
    else if (this.state === 'over' && this.picks.length) this.playAgain();
  }

  reset() {
    this.field.querySelectorAll('.gs-pick, .splat').forEach((el) => el.remove());
    this.picks = [];
    this.game = null;
    this.shown = null;
    this.play = null;
    this.markers = [];
    this.lineScore = [];
    this.crowd = { mood: 'still', since: 0 };
    this.last = null;
    this.hud.hidden = true;
    this.caption.hidden = true;
    this.callEl.hidden = true;
    this.panel.hidden = true;
    this.clearFx();
    this.setPhase('');
    this.publish();
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

  /** What the game is doing, for the end-to-end test to read. */
  publish() {
    const d = this.root.dataset;
    const g = this.game;
    d.level = this.level;
    d.innings = String(this.innings);
    d.inning = g ? String(g.inning) : '';
    d.outs = g ? String(g.outs) : '';
    d.strikes = g ? String(g.strikes) : '';
    d.runs = g ? String(g.runs) : '';
    d.bases = g ? ['first', 'second', 'third'].filter((b) => g.bases[b]).join(',') : '';
    d.balls = String(this.balls);
    d.markers = String(this.markers.length);
    d.spray = this.last ? (this.last.spray * (180 / Math.PI)).toFixed(2) : '';
    d.launch = this.last ? (this.last.launch * (180 / Math.PI)).toFixed(2) : '';
    d.exitMph = this.last ? this.last.exitMph.toFixed(1) : '';
    d.measured = this.last?.mph ? 'yes' : '';
    d.kind = this.last ? this.last.plan.kind : '';
  }

  // ---- Picking a level and the innings ----

  showLevels() {
    this.setState('pick-level');
    this.clearPicks();
    this.drawRest();
    this.showPanel({ title: GAP_SHOT_TEXT.title, prompt: GAP_SHOT_TEXT.pickLevel });
    LEVEL_IDS.forEach((id, i) => this.addPick({ ...LEVEL_SPOTS[i], r: PICK_RADIUS * 1.15 }, id, GAP_SHOT_TEXT.levelLabel(id)));
  }

  pickLevel(level) {
    this.level = level;
    this.setState('pick-innings');
    this.clearPicks();
    this.drawRest();
    this.showPanel({ title: GAP_SHOT_TEXT.title, prompt: GAP_SHOT_TEXT.pickInnings(level) });
    RULES.inningsChoices.forEach((n, i) => {
      this.addPick({ ...INNINGS_SPOTS[i], r: PICK_RADIUS * 1.15 }, n, GAP_SHOT_TEXT.inningsLabel(n));
    });
  }

  pickInnings(innings) {
    this.innings = innings;
    this.clearPicks();
    this.hidePanel();
    this.beginGame();
  }

  playAgain() {
    this.clearPicks();
    this.hidePanel();
    this.beginGame();
  }

  addPick(spot, value, label) {
    const el = document.createElement('div');
    el.className = 'fc-pick gs-pick';
    el.style.left = `${spot.x * 100}%`;
    el.style.top = `${spot.y * 100}%`;
    el.style.setProperty('--r', `${spot.r * 100}vmin`);
    el.dataset.value = String(value);
    const text = document.createElement('span');
    text.textContent = label;
    el.append(text);
    this.field.append(el);
    this.camera.pictureChangeAround(spot, spot.r * 1.15, POP_MS);
    this.picks.push({ ...spot, el, value });
  }

  clearPicks() {
    for (const pick of this.picks) {
      pick.el.classList.add('burst');
      this.camera.pictureChangeAround(pick, pick.r * 1.6, BURST_MS);
      setTimeout(() => pick.el.remove(), BURST_MS);
    }
    this.picks = [];
  }

  /** The pick target a hit landed on, if any (the nearest one). */
  pickAt(point) {
    const unit = Math.min(window.innerWidth, window.innerHeight);
    let best = null;
    let bestDistance = Infinity;
    for (const pick of this.picks) {
      const d = Math.hypot((point.x - pick.x) * window.innerWidth, (point.y - pick.y) * window.innerHeight) / (pick.r * unit);
      if (d <= PICK_GRACE && d < bestDistance) {
        best = pick;
        bestDistance = d;
      }
    }
    return best;
  }

  // ---- Hits ----

  /**
   * A ball (or a mouse click) hit the screen; or, with two cameras, flew at it but went into the floor or over
   * the top (`fromFlight`, with x or y off the screen), which counts only as a swing.
   * @param {{x:number, y:number, fromFlight?: boolean}} point normalised screen coordinates
   * @param {'ball'|'mouse'} source
   * @param {number} time when the picture it landed on was on screen (performance.now())
   */
  hitAt(point, source, time) {
    if (source === 'ball') {
      this.balls++;
      this.publish();
    }
    if (this.state === 'playing') {
      // One hit a swing: nothing while a play is on, and nothing from before the picture was back and still.
      if (this.phase !== 'aiming' || time < this.readyAt) return;
      this.swing(point);
      return;
    }
    if (!this.picks.length || point.fromFlight) return;
    const pick = this.pickAt(point);
    if (!pick) {
      this.splat(point, source);
      return;
    }
    playDing(2);
    if (this.state === 'pick-level') this.pickLevel(pick.value);
    else if (this.state === 'pick-innings') this.pickInnings(pick.value);
    else if (pick.value === 'again') this.playAgain();
    else this.showLevels();
  }

  splat(point, source) {
    const el = document.createElement('div');
    el.className = 'splat';
    el.dataset.source = source;
    el.style.left = `${point.x * 100}%`;
    el.style.top = `${point.y * 100}%`;
    this.field.append(el);
    this.camera.pictureChangeAround(point, SPLAT_RADIUS * 1.3, SPLAT_MS);
    setTimeout(() => el.remove(), SPLAT_MS);
    playThud();
  }

  // ---- A game ----

  beginGame() {
    this.setState('playing');
    this.game = newGame(this.level, this.innings);
    this.shown = this.game;
    this.lineScore = [0];
    this.markers = [];
    this.last = null;
    this.hud.hidden = false;
    this.caption.hidden = true;
    this.camera.updateExcluded();
    this.showScore();
    this.camera.pictureChangeEverywhere();
    this.drawRest();
    playBeep(true);
    this.getReady();
  }

  /** The picture is back at the batter's eyes: once the camera has settled on it, a swing can be taken. */
  getReady() {
    this.setPhase('between');
    this.readyAt = performance.now() + READY_MS;
    this.publish();
    const session = this.session;
    setTimeout(() => {
      if (session !== this.session || this.state !== 'playing' || this.phase !== 'between') return;
      this.setPhase('aiming');
      this.publish();
    }, READY_MS);
  }

  /** A ball hit the screen at `point` (a hit with its speed and angle, if the cameras measured them): the swing, and the play it makes. */
  swing(point) {
    const aspect = aspectOf();
    const level = LEVELS[this.game.level];
    const { spray, launch, speed, mph } = hitFor(point, aspect, level);
    const plan = planHit({ spray, launch, speed }, level, this.game.bases, this.game.outs);
    const now = performance.now();
    this.last = { point, spray, launch, mph, exitMph: mph ?? level.mph, plan };
    this.play = {
      plan,
      mph,
      t0: now,
      path: cameraPath(plan, aspect),
      fielders: fieldersOf(level),
      aspect,
      called: false,
      sounds: new Set(),
      result: null,
      fireworks: plan.kind === 'homer' ? fireworksFor(plan).map((b) => ({ ...b, at: b.at + now })) : [],
    };
    this.setPhase('play');
    this.root.dataset.call = '';
    // The whole picture changes from here until the view is back at the batter's eyes: the camera moves, everyone runs.
    this.camera.pictureChangeEverywhere((plan.endAt + CAMERA.back) * 1000);
    this.hideCaption();
    this.callEl.hidden = true;
    playBatCrack();
    this.publish();
  }

  /** Once a frame while a play is on. */
  update(now) {
    const play = this.play;
    if (!play) return;
    const t = (now - play.t0) / 1000;
    const { plan } = play;
    if (!play.called && t >= plan.callAt) this.call(now);
    this.sounds(play, t, now);
    if (t >= plan.endAt + CAMERA.back) {
      this.finishPlay(now);
      return;
    }
    this.drawPlay(play, t, now);
  }

  /** Sounds of the play, each once: the glove, the ball landing foul, the fireworks. */
  sounds(play, t, now) {
    const { plan } = play;
    const once = (name, at, fn) => {
      if (t >= at && !play.sounds.has(name)) {
        play.sounds.add(name);
        fn();
      }
    };
    if (plan.events.kind) once('glove', plan.events.at, playGlovePop);
    if (plan.kind === 'foul') once('thud', plan.events.lands, playThud);
    play.fireworks.forEach((b, i) => once(`firework ${i}`, (b.at - play.t0) / 1000, playFirework));
    if (plan.kind === 'homer') {
      // The crowd is on its feet all the way round the bases.
      for (let k = 1; k <= 2; k++) once(`cheer ${k}`, plan.callAt + 2 * k, () => { this.crowd = { mood: 'cheer', since: now }; });
    }
  }

  /** The call is made: the big word, the score, the dot on the field. */
  call(now) {
    const play = this.play;
    const { plan } = play;
    play.called = true;
    const before = this.game;
    play.inning = before.inning;
    const result = applyPlay(before, plan);
    play.result = result;
    this.game = result.state;
    this.lineScore[before.inning - 1] = (this.lineScore[before.inning - 1] ?? 0) + result.runs;
    this.markers.push(plan.marker);
    this.root.dataset.call = plan.call;

    const kind = plan.kind === 'homer' ? 'homer' : plan.kind === 'hit' ? 'hit' : plan.kind === 'foul' ? 'foul' : 'out';
    this.callEl.textContent = plan.call;
    this.callEl.dataset.kind = kind;
    this.callEl.toggleAttribute('data-long', plan.call.length > 9);
    this.callEl.hidden = false;
    this.callEl.style.animation = 'none';
    void this.callEl.offsetWidth;
    this.callEl.style.animation = '';
    let detail = plan.detail;
    if (plan.kind === 'foul') detail = result.strike ? GAP_SHOT_TEXT.strike(result.state.strikes) : GAP_SHOT_TEXT.keepSwinging;
    // How it left the tee: its speed if the cameras measured it, the launch and spray angles it was hit at.
    this.setCaption(detail, swingText({ mph: play.mph, launch: this.last.launch, spray: this.last.spray }));

    if (kind === 'homer') {
      playRoar();
      playCrowdNoise(Math.max(4, plan.endAt - plan.callAt));
      this.crowd = { mood: 'cheer', since: now };
    } else if (kind === 'hit') {
      playCheer();
      this.crowd = { mood: 'cheer', since: now };
    } else if (kind === 'out') {
      playGroan();
      this.crowd = { mood: 'groan', since: now };
    }
    // The score shows the play's outs and runs, before the inning changes over.
    this.shown = result.inningOver
      ? { ...before, outs: Math.min(RULES.outsPerInning, before.outs + plan.outs), runs: result.state.runs, bases: plan.basesAfter, strikes: 0 }
      : result.state;
    this.showScore(this.shown);
    this.publish();
  }

  /** The camera is back at the batter's eyes: on to the next swing, the next inning, or the end of the game. */
  finishPlay(now) {
    const { result, inning } = this.play;
    this.play = null;
    this.callEl.hidden = true;
    this.clearFx();
    this.crowd = { mood: 'still', since: now };
    // The picture settles into the still view of the field, which is one more change.
    this.camera.pictureChangeEverywhere();
    if (result.gameOver) {
      this.endGame();
      return;
    }
    if (!result.inningOver) this.shown = this.game;
    this.drawRest();
    if (result.inningOver) {
      // The score keeps showing the inning that has just ended, for a moment.
      this.showScore();
      this.setPhase('between');
      this.readyAt = Infinity;
      this.setCaption(result.mercy ? GAP_SHOT_TEXT.mercy(inning) : GAP_SHOT_TEXT.inningOver(inning));
      playFanfare();
      const session = this.session;
      setTimeout(() => {
        if (session !== this.session || this.state !== 'playing') return;
        // A new inning: the field is clear, the bases empty.
        this.markers = [];
        this.lineScore[this.game.inning - 1] = 0;
        this.hideCaption();
        this.shown = this.game;
        this.showScore();
        this.camera.pictureChangeEverywhere();
        this.drawRest();
        this.getReady();
      }, INNING_MS);
      this.publish();
      return;
    }
    this.showScore();
    this.getReady();
  }

  endGame() {
    this.setState('over');
    this.setPhase('');
    this.hud.hidden = true;
    this.camera.updateExcluded();
    this.hideCaption();
    this.drawRest(true);
    playFanfare();

    const runs = this.game.runs;
    const key = scoreKey(GAME_ID, this.level, this.innings);
    const best = loadBestScore(key);
    const isBest = !this.camera.mouseOnly && runs > best;
    if (isBest) saveBestScore(key, runs);
    this.publish();
    this.showPanel({
      title: GAP_SHOT_TEXT.gameOver(runs),
      result: GAP_SHOT_TEXT.result(runs, this.level, this.innings),
      best: isBest ? GAP_SHOT_TEXT.newBest : best ? GAP_SHOT_TEXT.best(best) : '',
    });
    this.panel.classList.toggle('new-best', isBest);
    const session = this.session;
    setTimeout(() => {
      if (session !== this.session || this.state !== 'over') return;
      this.addPick({ ...AGAIN_SPOTS.again, r: PICK_RADIUS * 1.3 }, 'again', GAP_SHOT_TEXT.again);
      this.addPick({ ...AGAIN_SPOTS.change, r: PICK_RADIUS * 1.3 }, 'change', GAP_SHOT_TEXT.change);
    }, REARM_MS);
  }

  // ---- Drawing ----

  /** Draws the frames of a play, one a frame, while there is one. */
  startLoop() {
    const session = this.session;
    const tick = () => {
      if (session !== this.session) return;
      if (this.play) this.update(performance.now());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** The level being played (or picked), with its fence. */
  currentLevel() {
    return LEVELS[this.game ? this.game.level : this.level];
  }

  /** The level's portable fence, if it has one. */
  fenceOf(level) {
    if (!this.fences.has(level.id)) this.fences.set(level.id, fenceShapes(level));
    return this.fences.get(level.id);
  }

  board() {
    const g = this.shown ?? this.game;
    return { runs: this.lineScore, inning: g ? g.inning : 1, innings: this.innings, outs: g ? g.outs : 0 };
  }

  /** The still batter's view: the field with everyone in place, the runners on, the fence, the dots of this inning. */
  drawRest(empty = false) {
    const level = this.currentLevel();
    const aspect = aspectOf();
    const bases = this.game && !empty ? this.game.bases : { first: false, second: false, third: false };
    fitCanvas(this.scene);
    const camera = makeCamera(batterView(aspect), aspect);
    drawScene(this.scene.getContext('2d'), camera, {
      figures: restFigures(fieldersOf(level), bases, { batters: this.game ? this.game.batters : 0 }),
      crowd: this.crowd,
      board: this.board(),
      now: performance.now(),
      shapes: [...this.fenceOf(level), ...markerShapes(this.markers)],
    });
    drew(this.scene);
  }

  drawPlay(play, t, now) {
    const { plan } = play;
    const level = this.currentLevel();
    const aspect = aspectOf();
    const view = play.path(t);
    fitCanvas(this.scene);
    drawScene(this.scene.getContext('2d'), makeCamera(view, aspect), {
      figures: playFigures(plan, play.fielders, t, { batters: this.game.batters }),
      crowd: this.crowd,
      board: this.board(),
      now,
      shapes: [...this.fenceOf(level), ...markerShapes(this.markers), ...ballShapes(plan, t, view.eye)],
    });
    drew(this.scene);
    if (play.fireworks.length) {
      fitCanvas(this.fx);
      const fx = this.fx.getContext('2d');
      fx.clearRect(0, 0, this.fx.width, this.fx.height);
      drawFireworks(fx, play.fireworks, now);
      drew(this.fx);
    }
  }

  clearFx() {
    this.fx.getContext('2d').clearRect(0, 0, this.fx.width, this.fx.height);
    drew(this.fx);
  }

  /** After the window changes size: draw the still picture again. */
  redraw() {
    if (!this.root.classList.contains('active')) return;
    this.camera.pictureChangeEverywhere();
    if (!this.play) this.drawRest(this.state === 'over');
  }

  // ---- Score, captions and panels ----

  showScore(state = this.shown ?? this.game) {
    if (!state) return;
    this.inningEl.textContent = `${state.inning}/${state.innings}`;
    const dots = (count, max) => Array.from({ length: max }, (_, i) => {
      const dot = document.createElement('i');
      dot.className = i < count ? 'gs-dot on' : 'gs-dot';
      return dot;
    });
    this.outsEl.replaceChildren(...dots(state.outs, RULES.outsPerInning));
    this.strikesEl.replaceChildren(...dots(state.strikes, RULES.maxStrikes));
    this.runsEl.textContent = String(state.runs);
    this.drawDiamond(state.bases);
  }

  /** The bases in the corner of the scoreboard strip, the ones with a runner lit. */
  drawDiamond(bases) {
    const ctx = this.diamond.getContext('2d');
    const { width: W, height: H } = this.diamond;
    ctx.clearRect(0, 0, W, H);
    const map = (p) => [W / 2 + (p.x / 90) * W * 0.36, H * 0.88 - (p.y / 127.3) * H * 0.72];
    const corners = ['home', 'first', 'second', 'third'].map((b) => map(BASES[b]));
    ctx.strokeStyle = '#8a93a6';
    ctx.lineWidth = W * 0.025;
    ctx.beginPath();
    corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ['first', 'second', 'third'].forEach((base, i) => {
      const [x, y] = corners[i + 1];
      const r = W * 0.09;
      ctx.fillStyle = bases[base] ? '#ffd23f' : '#3a4152';
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fill();
    });
  }

  /** What happened, and optionally a smaller second line under it (a swing's numbers). */
  setCaption(text, numbers = '') {
    this.camera.pictureChange(rectOf(this.caption, 0.02));
    this.caption.textContent = text;
    if (numbers) {
      const line = document.createElement('span');
      line.className = 'gs-numbers';
      line.textContent = numbers;
      this.caption.append(line);
    }
    this.caption.hidden = false;
    this.camera.updateExcluded();
    this.camera.pictureChange(rectOf(this.caption, 0.02));
  }

  hideCaption() {
    if (this.caption.hidden) return;
    this.camera.pictureChange(rectOf(this.caption, 0.02));
    this.caption.hidden = true;
    this.camera.updateExcluded();
  }

  showPanel({ title, result = '', best = '', prompt = '' }) {
    const set = (selector, text) => {
      const el = this.panel.querySelector(selector);
      el.textContent = text;
      el.hidden = !text;
    };
    if (!this.panel.hidden) this.camera.pictureChange(rectOf(this.panel, 0.03));
    set('.gs-title', title);
    set('.gs-result', result);
    set('.gs-best', best);
    set('.gs-prompt', prompt);
    this.panel.classList.remove('new-best');
    this.panel.hidden = false;
    this.camera.updateExcluded();
    this.camera.pictureChange(rectOf(this.panel, 0.03));
  }

  hidePanel() {
    if (this.panel.hidden) return;
    this.camera.pictureChange(rectOf(this.panel, 0.03));
    this.panel.hidden = true;
    this.camera.updateExcluded();
  }

  updateStatus() {
    renderGameStatus(this.statusEl, this.camera.note);
  }
}

function aspectOf() {
  return window.innerWidth / window.innerHeight;
}

/** Numbers each new drawing on a canvas (data-rev), so a test (or anything copying it) knows when it changed. */
function drew(canvas) {
  canvas.dataset.rev = String(Number(canvas.dataset.rev ?? 0) + 1);
}
