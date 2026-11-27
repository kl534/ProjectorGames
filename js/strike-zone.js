// Strike Zone: pitch an inning against the Rattlers, at a projected strike zone. Players are the pitcher: the
// picture is the view from the mound (strike-zone-scene.js), with the batter in his box, the catcher behind the plate
// and the umpire over his shoulder, zoomed so the strike zone is big enough to aim at. Where a ball hits the screen
// is where the pitch crossed the plate (strike-zone-logic.js). The batter decides what to do with it (take it, swing
// and miss, foul it off, put it in play: `decidePitch`, from where it was, how fast it was (with two cameras the
// speed is measured; with one it is the level's comfortable one and shown as est.), and the count), the umpire calls
// it, the count and the inning move on. A ball in play is Batter Up's play (gap-shot-play.js), shown with its camera
// rising from the pitcher's view and coming back to it. Three outs end the inning, or seven runs (the mercy rule); the
// score is the runs allowed, and then the pitches it took.
//
// The camera: nothing moves while players aim. A pitch changes the picture (the batter swings, the ball goes in, the
// call and the inset), and a ball in play all of it (the camera moves, everyone runs), so the game tells the camera
// about the whole pitch at once, with its length (pictureChangeEverywhere), and ignores hits until the picture is
// back and still (readyAt), as Batter Up does. One hit a pitch; the score bar and panel are ignored.
//
// Rules are in strike-zone-logic.js, the picture in strike-zone-scene.js (no browser code, unit tested); the drawing
// is Fielder's Choice's ballpark and players (fielders-choice-art.js), with Batter Up's tracer and fireworks.

import { loadLowestScore, saveBestScore } from './storage.js';
import { mphText } from './format.js';
import {
  playBatCrack, playBeep, playCheer, playDing, playFanfare, playFirework, playGlovePop, playGroan, playRoar, playThud,
} from './sound.js';
import { BASES, makeCamera } from './fielders-choice-logic.js';
import { drawScene, fitCanvas } from './fielders-choice-art.js';
import { drawFireworks, drawTracer } from './gap-shot-art.js';
import { fieldersOf } from './gap-shot-logic.js';
import { planHit } from './gap-shot-play.js';
import {
  CAMERA, ballShapes, cameraPath, dustShapes, fenceShapes, fireworksFor, markerShapes, playFigures, tracerFor,
} from './gap-shot-scene.js';
import {
  GAME_ID, LEVELS, LEVEL_IDS, STRIKE_ZONE_RULES as RULES, applyPitch, batterFor, beatsBest, contextFor, decidePitch, newGame, pitchFor,
  pitchPoint, pitcherCamera, pitcherView, rngFor, scoreKey, scoreText, scoreValue, summary,
} from './strike-zone-logic.js';
import {
  DOT_COLOURS, dotKind, insetLayout, pitchAnimation, pitchBallShapes, pitchFigures, playFiguresFor, zoneShapes,
} from './strike-zone-scene.js';
import { SETTLE_MS, ThrowCamera, renderGameStatus } from './throw-camera.js';

export { GAME_ID };

// After a pitch the picture is back and still; a pitch is ready this long after (the camera sees the change a little late,
// and takes a moment to settle on the picture).
const READY_MS = SETTLE_MS + 300;
const POP_MS = 250; // a target appearing
const BURST_MS = 350; // …and being hit
const SPLAT_MS = 1200;
const SPLAT_RADIUS = 0.035;
// After the game ends, the targets to play again appear this much later, so a ball still in the air can't
// start the next game by accident.
const REARM_MS = 1500;
const PICK_RADIUS = 0.1; // fraction of the shorter screen side
const PICK_GRACE = 1.2; // a throw this many radii from a pick target's centre picks it
const LEVEL_SPOTS = [{ x: 0.24, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.76, y: 0.5 }];
const AGAIN_SPOTS = { again: { x: 0.35, y: 0.62 }, change: { x: 0.65, y: 0.62 } };
const MOVING_SCALE = 0.8; // the 3D picture is drawn this much smaller while it moves (and stretched to fit)

export const STRIKE_ZONE_TEXT = {
  title: 'Strike Zone',
  pickLevel: 'Hit a ball at a level to pitch to it',
  levelLabel: (id) => LEVELS[id].name.toUpperCase(),
  inningOver: 'Three outs!',
  mercy: (runs) => `Mercy rule – ${runs} runs`,
  noRuns: 'No runs!',
  result: (runs, pitches, level) => `${runs} run${runs === 1 ? '' : 's'} on ${pitches} pitch${pitches === 1 ? '' : 'es'} at ${LEVELS[level].name}`,
  stats: (s) => `Strikes ${s.strikePct}% · K ${s.strikeouts} · BB ${s.walks} · HBP ${s.hitByPitch} · H ${s.hits}`,
  best: (value) => `Best here: ${scoreText(value)}`,
  newBest: 'New best!',
  again: 'PLAY AGAIN',
  change: 'NEW LEVEL',
  est: 'est.',
};

export class StrikeZone {
  /**
   * @param {HTMLElement} root the game's screen element
   * @param {{seed?: number}} [options] `seed` fixes the batters' choices (handy for testing); else `window.__strikeZoneSeed`, else random
   */
  constructor(root, options = {}) {
    this.root = root;
    this.options = options;
    this.field = root.querySelector('.sz-field');
    this.scene = root.querySelector('.sz-scene');
    this.fx = root.querySelector('.sz-fx');
    this.hud = root.querySelector('.sz-hud');
    this.ballsEl = root.querySelector('.sz-balls');
    this.strikesEl = root.querySelector('.sz-strikes');
    this.outsEl = root.querySelector('.sz-outs');
    this.runsEl = root.querySelector('.sz-runs b');
    this.pitchesEl = root.querySelector('.sz-pitches b');
    this.batterEl = root.querySelector('.sz-batter');
    this.diamond = root.querySelector('.sz-diamond');
    this.inset = root.querySelector('.sz-inset');
    this.callBox = root.querySelector('.sz-callbox');
    this.callEl = root.querySelector('.sz-call');
    this.detailEl = root.querySelector('.sz-detail');
    this.radarEl = root.querySelector('.sz-radar');
    this.panel = root.querySelector('.sz-panel');
    this.bar = root.querySelector('.game-bar');
    this.statusEl = root.querySelector('.game-status');

    this.session = 0; // increments when the game starts or stops, so stale timers can tell
    this.state = 'pick-level'; // 'pick-level' | 'playing' | 'over'
    this.phase = ''; // while playing: 'aiming' (a ball can be hit) | 'pitch' | 'between'
    this.picks = []; // the targets on screen to pick from: {x, y, r, el, value}
    this.level = 'high';
    this.game = null;
    this.shown = null; // what the score bar shows (the count, outs and runs, before the next batter or inning)
    this.pitch = null; // the pitch being shown: {anim, plan, t0, result, …}
    this.dots = []; // this at-bat's pitches in the inset: {x, z, outcome}
    this.shownBatter = null; // who is at the plate as far as the score bar and the inset show (the next batter only once the call is over)
    this.crowd = { mood: 'still', since: 0 };
    this.markers = []; // where each ball in play this inning landed or was caught
    this.lineScore = [0];
    this.fences = new Map(); // each level's portable fence as shapes, built once
    this.readyAt = 0; // balls on pictures from before this are not a pitch
    this.throws = 0; // balls the camera saw hit the screen, since the game was opened
    this.last = null; // the last pitch: {spot, mph, measured, decision, call}

    this.camera = new ThrowCamera(root, {
      onHit: (hit) => this.hitAt(hit, 'ball', hit.time),
      onNote: () => this.updateStatus(),
    });
    this.camera.ignore(this.bar, this.hud, this.panel);

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

  /** Enter / Space: pick the last level again, or play again. */
  pressStart() {
    if (this.state === 'pick-level') this.pickLevel(this.level);
    else if (this.state === 'over' && this.picks.length) this.playAgain();
  }

  reset() {
    this.field.querySelectorAll('.sz-pick, .splat').forEach((el) => el.remove());
    this.picks = [];
    this.game = null;
    this.shown = null;
    this.pitch = null;
    this.dots = [];
    this.shownBatter = null;
    this.markers = [];
    this.lineScore = [0];
    this.last = null;
    this.crowd = { mood: 'still', since: 0 };
    this.hud.hidden = true;
    this.inset.hidden = true;
    this.callBox.hidden = true;
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
    const last = this.last;
    d.level = this.level;
    d.ballCount = g ? String(g.balls) : '';
    d.strikeCount = g ? String(g.strikes) : '';
    d.outs = g ? String(g.outs) : '';
    d.runs = g ? String(g.runs) : '';
    d.bases = g ? ['first', 'second', 'third'].filter((b) => g.bases[b]).join(',') : '';
    d.pitches = g ? String(g.pitches) : '';
    d.batter = g ? batterFor(g).name : '';
    d.throws = String(this.throws);
    d.dots = String(this.dots.length);
    d.markers = String(this.markers.length);
    d.outcome = last ? last.decision.outcome : '';
    d.zone = last ? (last.decision.strike ? 'strike' : 'ball') : '';
    d.pitchX = last ? last.spot.x.toFixed(2) : '';
    d.pitchZ = last ? last.spot.z.toFixed(2) : '';
    d.measured = last?.measured ? 'yes' : '';
    d.mph = last?.measured ? last.mph.toFixed(1) : '';
    d.kind = last?.plan ? last.plan.kind : '';
  }

  // ---- Picking a level ----

  showLevels() {
    this.setState('pick-level');
    this.clearPicks();
    this.drawRest();
    this.showPanel({ title: STRIKE_ZONE_TEXT.title, prompt: STRIKE_ZONE_TEXT.pickLevel });
    LEVEL_IDS.forEach((id, i) => this.addPick({ ...LEVEL_SPOTS[i], r: PICK_RADIUS * 1.15 }, id, STRIKE_ZONE_TEXT.levelLabel(id)));
  }

  pickLevel(level) {
    this.level = level;
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
    el.className = 'fc-pick sz-pick';
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
   * A ball (or a mouse click) hit the screen.
   * @param {{x:number, y:number, speedMph?:number|null}} point normalised screen coordinates, and how fast the cameras measured it
   * @param {'ball'|'mouse'} source
   * @param {number} time when the picture it landed on was on screen (performance.now())
   */
  hitAt(point, source, time) {
    if (source === 'ball') {
      this.throws++;
      this.publish();
    }
    if (this.state === 'playing') {
      // One hit a pitch: nothing while a pitch is on, and nothing from before the picture was back and still.
      if (this.phase !== 'aiming' || time < this.readyAt) return;
      this.throwPitch(point);
      return;
    }
    if (!this.picks.length) return;
    const pick = this.pickAt(point);
    if (!pick) {
      this.splat(point, source);
      return;
    }
    playDing(2);
    if (this.state === 'pick-level') this.pickLevel(pick.value);
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

  /** The seed for a game's batters: the page's (for tests), the option, or a fresh one. */
  newSeed() {
    if (Number.isFinite(window.__strikeZoneSeed)) return window.__strikeZoneSeed;
    if (Number.isFinite(this.options.seed)) return this.options.seed;
    return Math.floor(Math.random() * 2 ** 31);
  }

  beginGame() {
    this.setState('playing');
    this.game = newGame(this.level, this.newSeed());
    this.shown = this.game;
    this.lineScore = [0];
    this.markers = [];
    this.last = null;
    this.dots = [];
    this.shownBatter = batterFor(this.game);
    this.hud.hidden = false;
    this.inset.hidden = false;
    this.callBox.hidden = true;
    this.camera.updateExcluded();
    this.showScore();
    this.camera.pictureChangeEverywhere();
    this.drawRest();
    this.drawInset();
    playBeep(true);
    this.getReady();
  }

  /** The picture is still: once the camera has settled on it, a pitch can be thrown. */
  getReady() {
    const wait = this.readyMs();
    this.readyAt = performance.now() + wait;
    if (!wait) {
      this.setPhase('aiming');
      this.publish();
      return;
    }
    this.setPhase('between');
    this.publish();
    const session = this.session;
    setTimeout(() => {
      if (session !== this.session || this.state !== 'playing' || this.phase !== 'between') return;
      this.setPhase('aiming');
      this.publish();
    }, wait);
  }

  /** How long after the picture is still before a pitch counts: the camera's time to settle on it, none for taps alone. */
  readyMs() {
    return this.camera.mouseOnly ? 0 : READY_MS;
  }

  /** A ball hit the screen at `point` (a hit with its speed, if the cameras measured it): the pitch, what the batter does, and the call. */
  throwPitch(point) {
    const aspect = aspectOf();
    const game = this.game;
    const level = LEVELS[game.level];
    const batter = batterFor(game);
    const spot = pitchPoint({ x: clamp01(point.x), y: clamp01(point.y) }, aspect);
    const pitch = pitchFor(spot, point.speedMph, game.level);
    const decision = decidePitch(pitch, batter, contextFor(game), rngFor(game.seed, game.pitches));
    const plan = decision.outcome === 'inPlay' ? planHit(decision.hit, level, game.bases, game.outs) : null;
    const result = applyPitch(game, decision, { pitch, plan });
    const anim = pitchAnimation(decision, spot, batter, result.event);
    const now = performance.now();
    // Hit fair or not, a ball the bat hit shows the play; its length is the whole pitch's.
    const total = plan ? anim.contactAt + (plan.endAt + CAMERA.back) * 1000 : anim.endAt;
    this.last = { spot, mph: pitch.mph, measured: pitch.measured, decision, plan, call: result.call };
    this.pitch = {
      anim, plan, result, batter, batters: game.batters, t0: now, total, aspect, called: false, sounds: new Set(), playing: false,
      path: plan ? cameraPath(plan, aspect, pitcherView(aspect)) : null,
      fielders: fieldersOf(level),
      fireworks: plan && plan.kind === 'homer' ? fireworksFor(plan).map((b) => ({ ...b, at: b.at + now + anim.contactAt })) : [],
    };
    this.setPhase('pitch');
    this.root.dataset.call = '';
    this.callBox.hidden = true;
    // The whole picture changes from here until it is back and still: the batter, the ball, the call, and for a ball in
    // play the camera and everyone. So the next pitch can be thrown once the camera has settled after (readyMs).
    this.camera.pictureChangeEverywhere(total);
    this.readyAt = now + total + this.readyMs();
    this.publish();
  }

  /** Once a frame while a pitch is on. */
  update(now) {
    const p = this.pitch;
    if (!p) return;
    const ms = now - p.t0;
    const { anim, plan } = p;
    for (const s of anim.sounds) {
      if (ms >= s.at && !p.sounds.has(s.kind)) {
        p.sounds.add(s.kind);
        if (s.kind === 'pop') playGlovePop();
        else if (s.kind === 'crack') playBatCrack();
        else playThud();
      }
    }
    if (plan && ms >= anim.contactAt) {
      this.updatePlay(p, (ms - anim.contactAt) / 1000, now);
      return;
    }
    if (!plan && anim.callAt !== null && ms >= anim.callAt && !p.called) this.call(now);
    if (!plan && ms >= anim.endAt) {
      this.finish(now);
      return;
    }
    this.drawPitch(p, ms);
  }

  /** The play, once the ball is hit: Batter Up's, from the pitcher's view. */
  updatePlay(p, t, now) {
    const { plan } = p;
    p.playing = true;
    if (!p.called && t >= plan.callAt) this.call(now);
    this.sounds(p, t, now);
    if (t >= plan.endAt + CAMERA.back) {
      this.finish(now);
      return;
    }
    this.drawPlay(p, t, now);
  }

  /** Sounds of the play, each once: the glove (and again for each throw caught), the ball landing foul, the fireworks. */
  sounds(p, t) {
    const { plan } = p;
    const once = (name, at, fn) => {
      if (t >= at && !p.sounds.has(name)) {
        p.sounds.add(name);
        fn();
      }
    };
    if (plan.events.kind) once('glove', plan.events.at, playGlovePop);
    plan.events.throws.forEach((th, i) => once(`throw ${i}`, th.t1, playGlovePop));
    if (plan.kind === 'foul') once('thud', plan.events.lands, playThud);
    p.fireworks.forEach((b, i) => once(`firework ${i}`, (b.at - p.t0 - p.anim.contactAt) / 1000, playFirework));
  }

  /** The call is made: the big word, how fast it was, the count, the dot in the inset. */
  call(now) {
    const p = this.pitch;
    const { plan, result, anim } = p;
    p.called = true;
    this.game = result.state;
    if (result.runs) this.lineScore[0] += result.runs;
    if (plan) this.markers.push(plan.marker);
    this.dots.push({ x: anim.point.x, z: anim.point.z, outcome: plan?.foul ? 'foul' : this.last.decision.outcome });
    const word = plan ? plan.call : result.call;
    this.root.dataset.call = word;
    this.callEl.textContent = word;
    this.callEl.dataset.kind = plan ? plan.kind : callKind(result.event, this.last.decision.outcome);
    this.callEl.toggleAttribute('data-long', word.length > 12);
    this.detailEl.textContent = plan ? plan.detail : '';
    this.detailEl.hidden = !plan;
    // The radar: how fast, or that it is an estimate.
    this.radarEl.textContent = this.last.measured ? mphText(this.last.mph) : STRIKE_ZONE_TEXT.est;
    this.radarEl.dataset.est = this.last.measured ? '' : 'yes';
    this.callBox.hidden = false;
    this.callBox.style.animation = 'none';
    void this.callBox.offsetWidth;
    this.callBox.style.animation = '';
    if (plan) {
      if (plan.kind === 'homer') {
        playRoar();
        this.crowd = { mood: 'cheer', since: now };
      } else if (plan.kind === 'hit') playCheer();
      else if (plan.kind === 'out') playGroan();
    } else if (result.event === 'strikeout') playDing(2);
    else if (result.event === 'walk') playGroan();
    // The score shows the pitch's count, outs and runs; the next batter's name only once this one's call is over.
    this.shown = this.game;
    this.showScore(this.shown);
    this.drawInset();
    this.publish();
  }

  /** The picture is back to the pitcher's view: on to the next pitch, the next batter, or the end of the inning. */
  finish(now) {
    const { result } = this.pitch;
    this.pitch = null;
    this.callBox.hidden = true;
    this.clearFx();
    // The picture settles into the still view, which is one more change.
    this.camera.pictureChangeEverywhere();
    if (result.gameOver) {
      this.endGame(result);
      return;
    }
    this.shown = this.game;
    this.crowd = { mood: 'still', since: now };
    if (result.batterDone) {
      // The next batter steps in: his zone, and a clean inset.
      this.dots = [];
      this.shownBatter = batterFor(this.game);
    }
    this.showScore();
    this.drawRest();
    this.drawInset();
    this.getReady();
  }

  endGame(result) {
    this.setState('over');
    this.setPhase('');
    this.hud.hidden = true;
    this.inset.hidden = true;
    this.camera.updateExcluded();
    this.drawRest();
    playFanfare();

    const game = this.game;
    const s = summary(game);
    const key = scoreKey(this.level);
    const value = scoreValue(game.runs, game.pitches);
    const best = loadLowestScore(key);
    const isBest = !this.camera.mouseOnly && beatsBest(value, best);
    if (isBest) saveBestScore(key, value);
    this.publish();
    this.showPanel({
      title: result.mercy ? STRIKE_ZONE_TEXT.mercy(RULES.mercyRuns) : STRIKE_ZONE_TEXT.inningOver,
      result: game.runs === 0 ? STRIKE_ZONE_TEXT.noRuns : STRIKE_ZONE_TEXT.result(game.runs, game.pitches, this.level),
      stats: STRIKE_ZONE_TEXT.stats(s),
      best: isBest ? STRIKE_ZONE_TEXT.newBest : best !== null ? STRIKE_ZONE_TEXT.best(best) : '',
    });
    this.panel.classList.toggle('new-best', isBest);
    this.root.dataset.result = STRIKE_ZONE_TEXT.result(game.runs, game.pitches, this.level);
    const session = this.session;
    setTimeout(() => {
      if (session !== this.session || this.state !== 'over') return;
      this.addPick({ ...AGAIN_SPOTS.again, r: PICK_RADIUS * 1.3 }, 'again', STRIKE_ZONE_TEXT.again);
      this.addPick({ ...AGAIN_SPOTS.change, r: PICK_RADIUS * 1.3 }, 'change', STRIKE_ZONE_TEXT.change);
    }, REARM_MS);
  }

  // ---- Drawing ----

  /** Draws the frames of a pitch, one a frame, while there is one. */
  startLoop() {
    const session = this.session;
    const tick = () => {
      if (session !== this.session) return;
      if (this.pitch) this.update(performance.now());
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
    return { runs: this.lineScore, inning: 1, innings: 1, outs: g ? g.outs : 0 };
  }

  /** Draws the pitcher's view, with the batter at the plate (if there is one), at `ms` of a pitch (none: standing still). */
  drawView(anim, ms, extra = [], scale = 1) {
    const aspect = aspectOf();
    const batter = anim ? anim.batter : this.shownBatter;
    fitCanvas(this.scene);
    drawScene(this.scene.getContext('2d'), pitcherCamera(aspect), {
      figures: pitchFigures(anim, ms, { batter, batters: anim ? this.pitch.batters : this.game ? this.game.batters : 0 }),
      crowd: { mood: 'still', since: 0 },
      board: this.board(),
      now: performance.now(),
      shapes: [...(batter ? zoneShapes(batter) : []), ...extra],
      scale,
    });
    drew(this.scene);
  }

  /** The still picture: the plate with the batter in his box, the catcher and the umpire. */
  drawRest() {
    this.drawView(null, 0);
  }

  drawPitch(p, ms) {
    this.drawView(p.anim, ms, pitchBallShapes(p.anim, ms), MOVING_SCALE);
  }

  drawPlay(p, t, now) {
    const { plan } = p;
    const level = this.currentLevel();
    const view = p.path(t);
    fitCanvas(this.scene);
    const camera = makeCamera(view, p.aspect);
    const ctx = this.scene.getContext('2d');
    const figures = playFiguresFor(playFigures, plan, p.fielders, t, { batters: p.batters, batter: p.batter });
    drawScene(ctx, camera, {
      figures,
      crowd: this.crowd,
      board: this.board(),
      now,
      shapes: [...this.fenceOf(level), ...markerShapes(this.markers), ...dustShapes(plan, t), ...ballShapes(plan, t, view.eye)],
      // The camera is on the move: a smaller picture, stretched, is quicker and looks the same.
      scale: 0.75,
    });
    drawTracer(ctx, camera, tracerFor(plan, t));
    drew(this.scene);
    if (p.fireworks.length) {
      fitCanvas(this.fx);
      const fx = this.fx.getContext('2d');
      fx.clearRect(0, 0, this.fx.width, this.fx.height);
      drawFireworks(fx, p.fireworks, now);
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
    if (!this.pitch) {
      this.drawRest();
      this.drawInset();
    }
  }

  // ---- The score bar, the inset, captions and panels ----

  showScore(state = this.shown ?? this.game) {
    if (!state) return;
    const dots = (count, max, on = '') => Array.from({ length: max }, (_, i) => {
      const dot = document.createElement('i');
      dot.className = i < count ? `sz-dot on ${on}` : 'sz-dot';
      return dot;
    });
    this.ballsEl.replaceChildren(...dots(state.balls, RULES.ballsForWalk - 1));
    this.strikesEl.replaceChildren(...dots(state.strikes, RULES.strikesForOut - 1));
    this.outsEl.replaceChildren(...dots(state.outs, RULES.outsPerInning));
    this.runsEl.textContent = String(state.runs);
    this.pitchesEl.textContent = String(state.pitches);
    const batter = this.shownBatter ?? batterFor(this.game ?? state);
    this.batterEl.textContent = `${batter.name} · ${batter.bats}`;
    this.batterEl.title = batter.bats === 'R' ? 'Bats right-handed' : 'Bats left-handed';
    this.drawDiamond(state.bases);
  }

  /** The bases in the score bar, the ones with a runner lit. */
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

  /** The zone inset: the batter's strike zone, the plate and his box, and this at-bat's pitches, numbered and coloured. */
  drawInset() {
    const canvas = this.inset;
    if (canvas.hidden) return;
    fitCanvas(canvas);
    const ctx = canvas.getContext('2d');
    const { width: W, height: H } = canvas;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);
    const layout = insetLayout(this.shownBatter, W, H);
    ctx.fillStyle = '#10151f';
    ctx.fillRect(0, 0, W, H);
    // The ground, the plate, and the batter's body where he stands.
    ctx.fillStyle = '#2b3140';
    ctx.fillRect(0, layout.ground, W, H - layout.ground);
    ctx.fillStyle = '#6a7388';
    ctx.fillRect(layout.plate.x0, layout.ground, layout.plate.x1 - layout.plate.x0, Math.max(2, H * 0.025));
    if (layout.body) {
      ctx.fillStyle = 'rgba(167, 51, 43, 0.45)';
      ctx.fillRect(layout.body.x0, layout.body.y0, layout.body.x1 - layout.body.x0, layout.body.y1 - layout.body.y0);
    }
    // The strike zone.
    ctx.strokeStyle = '#e8b32e';
    ctx.lineWidth = Math.max(2, W * 0.015);
    ctx.strokeRect(layout.zone.x0, layout.zone.y0, layout.zone.x1 - layout.zone.x0, layout.zone.y1 - layout.zone.y0);
    // Each pitch of this at-bat.
    const r = Math.max(7, W * 0.055);
    ctx.font = `800 ${Math.round(r * 1.25)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this.dots.forEach((dot, i) => {
      const c = layout.point(dot);
      ctx.beginPath();
      ctx.arc(Math.max(r, Math.min(W - r, c.x)), Math.max(r, Math.min(H - r, c.y)), r, 0, Math.PI * 2);
      ctx.fillStyle = DOT_COLOURS[dotKind(dot.outcome)];
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, r * 0.18);
      ctx.strokeStyle = '#10131a';
      ctx.stroke();
      ctx.fillStyle = '#10131a';
      ctx.fillText(String(i + 1), Math.max(r, Math.min(W - r, c.x)), Math.max(r, Math.min(H - r, c.y)) + r * 0.05);
    });
    drew(canvas);
  }

  showPanel({ title, result = '', stats = '', best = '', prompt = '' }) {
    const set = (selector, text) => {
      const el = this.panel.querySelector(selector);
      el.textContent = text;
      el.hidden = !text;
    };
    this.camera.pictureChangeEverywhere();
    set('.sz-title', title);
    set('.sz-result', result);
    set('.sz-stats', stats);
    set('.sz-best', best);
    set('.sz-prompt', prompt);
    this.panel.classList.remove('new-best');
    this.panel.hidden = false;
    this.camera.updateExcluded();
  }

  hidePanel() {
    if (this.panel.hidden) return;
    this.camera.pictureChangeEverywhere();
    this.panel.hidden = true;
    this.camera.updateExcluded();
  }

  updateStatus() {
    renderGameStatus(this.statusEl, this.camera.note);
  }
}

/** Which colour the big word is, from what the pitch came to. */
function callKind(event, outcome) {
  if (event === 'walk') return 'walk';
  if (event === 'strikeout') return 'strikeout';
  if (event === 'hitByPitch') return 'hitByPitch';
  if (event === 'foul') return 'foul';
  return outcome === 'ball' ? 'ball' : 'strike';
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function aspectOf() {
  return window.innerWidth / window.innerHeight;
}

/** Numbers each new drawing on a canvas (data-rev), so a test (or anything copying it) knows when it changed. */
function drew(canvas) {
  canvas.dataset.rev = String(Number(canvas.dataset.rev ?? 0) + 1);
}
