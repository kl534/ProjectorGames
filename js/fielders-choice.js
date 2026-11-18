// Fielder's Choice: play defence for a few innings. Players pick a position
// (2B, SS, 3B, LF, CF or RF) and how many innings, by throwing at them. Every
// batter then hits the ball to that position: the view, through the fielder's
// eyes, watches the pitch and the ball coming, fields it, then turns to the
// base the throw should go to, with the fielder covering it lined up in the
// middle of the screen and the runner on the way. A throw the covering
// fielder can reach, before the runner gets there, is an out. Anything else
// (wide, or too late) and the runner is safe. The score is the runs allowed:
// fewer is better.
//
// Rules (who throws where, how runners move, innings) are in
// fielders-choice-logic.js; the drawing is in fielders-choice-art.js, which
// draws the ballpark and the players in 3D (fielders-choice-models.js, drawn
// with WebGL by fielders-choice-gl.js).
//
// When the camera sees a throw land, a drawn ball flies in from the bottom of
// the screen to that spot and the fielder reaches for it: caught (POP!), or
// sailing over, skipping in the dirt or getting past a dive. The base umpire
// makes the call; runners slide into close plays at second, third and home.
//
// The camera: everything before the throw (the windup, the swing, the batted
// ball, the view turning) changes the whole picture, so it is reported as one
// picture change that lasts until the view settles. While players throw, the
// picture stands still except for the runner, who runs with pumping arms and
// legs: the camera watches only their head (which never changes as they run)
// and keeps the rest of them out of the way, and follows them afresh whenever
// they turn round or start to slide. Once a throw has been seen (or the runner
// is in), no more are taken for that batter, so everything after it (the
// catch, the call, the crowd) is free to move: it is reported as it happens.

import { loadLowestScore, saveBestScore } from './storage.js';
import {
  playBatCrack, playBeep, playCheer, playDing, playEscape, playFanfare, playGlovePop, playThud,
} from './sound.js';
import {
  BASES, FIELDERS, FIELDERS_CHOICE_RULES as RULES, PLAYABLE_POSITIONS, alongPath, battedBallAt, battingView,
  blendViews, describeBases, feetScale, fromFielder, makeCamera, newGame, ordinal, outOfTheWay, planPlay,
  playResult, reachBox, runnerMoves, runnerSide, throwOutcome, throwView, umpireSpot,
} from './fielders-choice-logic.js';
import {
  PICK_SPOTS, drawBigGlove, drawDiagram, drawFigures, drawFireworks, drawScene, drawSprite, fitCanvas, drawFlyingBall,
} from './fielders-choice-art.js';
import { groundHeight, jointAt, viewAxes } from './fielders-choice-models.js';
import {
  POSES, SLIDE_REACH, STRIDE, blendPoses, ease, keyframes, landPose, reachPose, runPose,
} from './fielders-choice-players.js';
import { SETTLE_MS, ThrowCamera, rectOf, renderGameStatus } from './throw-camera.js';

export const GAME_ID = 'fielders-choice';

// How long each part of a batter takes (ms).
const INTRO_MS = 1900; // the view of home plate, with the situation, up to the pitch
const WINDUP_MS = 800; // the pitcher's windup, the end of the intro
const PITCH_MS = 600; // the pitch on its way
const BATTED_MS = { grounder: 1300, dinker: 1900, hit: 2100 }; // the ball on its way to the fielder
const GLOVE_MS = 450; // the ball in the glove
const PAN_MS = 1000; // the view turning to the base
const FLIGHT_MS = 300; // the drawn ball flying in to where the throw landed
const SLIDE_MS = 420; // a runner sliding into the bag
const TAG_MS = 180; // the glove coming down for a tag
const LAND_MS = 280; // a fielder who jumped for it coming back down on the bag
const RESULT_MS = 2300; // after the call, before the next batter
const INNING_MS = 2600; // "Three outs!" between innings
const FIREWORKS_MS = 2800; // more time after the last out of a shutout
const POW_MS = 700; // a comic word
const CROWD_MS = 2500; // the umpire's call and the crowd's cheer or groan, after the call
const SCENE_MS = 100; // …redrawn this often meanwhile
// A ball that landed just before the runner got there is reported a little
// later (the camera sees the screen late): it still counts, so the runner is
// only called safe this much after they arrive.
const LATE_GRACE_MS = 400;
const POP_MS = 250; // a pick target appearing
const BURST_MS = 350; // …and being hit
const SPLAT_MS = 1200; // the mark a throw that misses every pick target leaves
const SPLAT_RADIUS = 0.035;
// After the game ends, the targets to play again appear this much later, so a
// ball still in the air can't start the next game by accident.
const REARM_MS = 1500;
const PICK_RADIUS = 0.1; // fraction of the shorter screen side
const PICK_GRACE = 1.2; // a throw this many radii from a pick target's centre picks it
const INNINGS_SPOTS = [{ x: 0.3, y: 0.42 }, { x: 0.5, y: 0.42 }, { x: 0.7, y: 0.42 }];
const AGAIN_SPOTS = { again: { x: 0.35, y: 0.62 }, change: { x: 0.65, y: 0.62 } };
const BATTER_BOX = { x: -2.8, y: 0 };
const PLATE_UMPIRE = { x: 0, y: -6.5 };
// Where the base umpire starts for a play at each base, before hurrying over to make the call.
const BASE_UMPIRE = { first: { x: 82, y: 50 }, second: { x: -24, y: 148 }, third: { x: -82, y: 50 } };
const SPEED = { run: 0.024, jog: 0.011 }; // feet a millisecond
const RUN_FRAMES = 24; // pictures of the runner in each stride
// The runner's picture: room round their feet (feet), enough for a slide.
const SPRITE = { side: 5.6, up: 6.9, down: 0.6 };
// Everyone's skin tone and number: the covering fielder looks the same in the cutscene and on their own.
const SKIN_OF = {
  P: 2, C: 4, U: 3, BU: 1, '1B': 1, '2B': 0, SS: 5, '3B': 3, LF: 5, CF: 2, RF: 0, home: 3, first: 0, second: 5, third: 2,
};
const NUMBER_OF = { P: 31, C: 9, '1B': 25, '2B': 4, SS: 6, '3B': 5, LF: 7, CF: 8, RF: 22, first: 12, second: 23, third: 3 };

const BASE_WORDS = { first: 'FIRST', second: 'SECOND', third: 'THIRD', home: 'HOME' };

export const FIELDERS_CHOICE_TEXT = {
  title: 'Fielder’s Choice',
  pickPosition: 'Throw at a position to play it',
  pickInnings: (position) => `Playing ${FIELDERS[position].name}. How many innings?`,
  inningsLabel: (n) => `${n} INNING${n === 1 ? '' : 'S'}`,
  situation: (state) => `${ordinal(state.inning)} inning · ${describeBases(state.bases)} · ${state.outs} out${state.outs === 1 ? '' : 's'}`,
  throwTo: (play) => {
    const base = BASE_WORDS[play.target];
    const to = play.target === 'home' ? 'Throw HOME!' : `Throw to ${base}!`;
    if (play.kind === 'dinker') return `Dinker! ${to}`;
    if (play.kind === 'hit') return play.target === 'home' ? `Base hit – he’s heading home! ${to}` : `Base hit – he’s going for two! ${to}`;
    return `Grounder! ${to}`;
  },
  out: (play) => `OUT at ${play.target}!`,
  safe: (play, late) => `${late ? 'Too late – safe' : 'Wide – safe'} at ${play.target}.`,
  runs: (n) => (n ? ` ${n} run${n === 1 ? '' : 's'} score${n === 1 ? 's' : ''}.` : ''),
  inningOver: (inning) => `Three outs! That’s the ${ordinal(inning)} inning.`,
  mercy: (inning) => `Mercy rule – ${RULES.mercyRuns} runs. That’s the ${ordinal(inning)} inning.`,
  gameOver: (runs) => (runs === 0 ? 'Shutout!' : 'Game over'),
  result: (runs, innings, position) => `You allowed ${runs} run${runs === 1 ? '' : 's'} in ${innings} inning${innings === 1 ? '' : 's'} at ${FIELDERS[position].short}`,
  best: (runs) => `Fewest runs here: ${runs}`,
  newBest: 'New record!',
  again: 'PLAY AGAIN',
  change: 'NEW POSITION',
};

export class FieldersChoice {
  /** @param {HTMLElement} root the game's screen element */
  constructor(root) {
    this.root = root;
    this.field = root.querySelector('.fc-field');
    this.scene = root.querySelector('.fc-scene');
    this.overlay = root.querySelector('.fc-fielder');
    this.fx = root.querySelector('.fc-fx');
    this.reachEl = root.querySelector('.fc-reach');
    this.hud = root.querySelector('.fc-hud');
    this.inningEl = root.querySelector('.fc-inning b');
    this.outsEl = root.querySelector('.fc-outs b');
    this.runsEl = root.querySelector('.fc-runs b');
    this.diamond = root.querySelector('.fc-diamond');
    this.caption = root.querySelector('.fc-caption');
    this.panel = root.querySelector('.fc-panel');
    this.bar = root.querySelector('.game-bar');
    this.statusEl = root.querySelector('.game-status');

    this.session = 0; // increments when the game starts or stops, so stale timers can tell
    this.state = 'pick-position'; // 'pick-position' | 'pick-innings' | 'playing' | 'over'
    this.phase = ''; // while playing: 'intro' | 'pitch' | 'batted' | 'glove' | 'pan' | 'throw' | 'result' | 'between'
    this.picks = []; // the targets on screen to pick from: {x, y, r, el, value}
    this.position = 'SS';
    this.innings = 3;
    this.game = null;
    this.play = null;
    this.moves = [];
    this.timeline = null;
    this.runner = null; // the runner the throw is for, drawn on their own while the view is on them
    this.cast = []; // everyone else on the field who moves when the ball is hit
    this.resolved = false; // a throw has been seen (or the runner got there): no more for this batter
    this.anim = null; // the drawn throw: where it went and how it turned out
    this.called = null; // the umpire's call, once made: {out, at}
    this.pending = []; // things to do at a time: [{at, fn}]
    this.remap = null; // the runners hurrying or slowing so the play looks right: {t0, u0, t1}
    this.slide = null; // whether the runner the throw is for slides in (decided as they near the bag)
    this.lineScore = [];

    this.camera = new ThrowCamera(root, {
      onHit: (hit) => this.throwAt(hit, 'ball', hit.time),
      onNote: () => this.updateStatus(),
      moving: true,
    });
    this.camera.ignore(this.bar, this.hud, this.caption, this.panel);

    this.field.addEventListener('click', (e) => {
      this.throwAt({ x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }, 'mouse', performance.now());
    });
    document.addEventListener('fullscreenchange', () => this.updateStatus());
    window.addEventListener('resize', () => this.redraw());
  }

  /** @param {import('./storage.js').Calibration|null} calibration */
  start(calibration) {
    this.session++;
    this.reset();
    this.showPositions();
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
    // Shows what the covering fielder can reach.
    this.camera.pictureChange(grow(reachBox(aspect(), this.scale), 0.02));
    this.reachEl.classList.toggle('show', this.camera.debug);
  }

  /** Enter / Space: pick the last position or innings again, or play again. */
  pressStart() {
    if (this.state === 'pick-position') this.pickPosition(this.position);
    else if (this.state === 'pick-innings') this.pickInnings(this.innings);
    else if (this.state === 'over' && this.picks.length) this.playAgain();
  }

  reset() {
    this.field.querySelectorAll('.fc-pick, .splat, .fc-runner, .fc-pow').forEach((el) => el.remove());
    this.picks = [];
    this.game = null;
    this.play = null;
    this.scale = feetScale();
    this.runner = null;
    this.anim = null;
    this.called = null;
    this.pending = [];
    this.clearFx();
    this.hud.hidden = true;
    this.caption.hidden = true;
    this.panel.hidden = true;
    this.setPhase('');
    this.clearFielder();
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

  // ---- Picking a position and the innings ----

  showPositions() {
    this.setState('pick-position');
    this.clearPicks();
    this.drawDiagram();
    this.showPanel({ title: FIELDERS_CHOICE_TEXT.title, prompt: FIELDERS_CHOICE_TEXT.pickPosition, low: true });
    for (const position of PLAYABLE_POSITIONS) this.addPick({ ...PICK_SPOTS[position], r: PICK_RADIUS }, position, position);
  }

  pickPosition(position) {
    this.position = position;
    this.setState('pick-innings');
    this.clearPicks();
    this.showPanel({ title: FIELDERS_CHOICE_TEXT.title, prompt: FIELDERS_CHOICE_TEXT.pickInnings(position), low: true });
    RULES.inningsChoices.forEach((n, i) => {
      this.addPick({ ...INNINGS_SPOTS[i], r: PICK_RADIUS * 1.15 }, n, FIELDERS_CHOICE_TEXT.inningsLabel(n));
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
    el.className = 'fc-pick';
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

  /** The pick target a throw hit, if any (the nearest one). */
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

  // ---- Throws ----

  /**
   * A ball (or a mouse click) hit the screen.
   * @param {{x:number, y:number}} point normalised screen coordinates
   * @param {'ball'|'mouse'} source
   * @param {number} time when the picture it landed on was on screen
   */
  throwAt(point, source, time) {
    if (this.state === 'playing') {
      if (this.phase !== 'throw' || this.resolved || time < this.timeline.throwAt) return;
      this.thrown(point, time <= this.timeline.arrivesAt);
      return;
    }
    if (!this.picks.length) return;
    const pick = this.pickAt(point);
    if (!pick) {
      this.splat(point, source);
      return;
    }
    playDing(2);
    if (this.state === 'pick-position') this.pickPosition(pick.value);
    else if (this.state === 'pick-innings') this.pickInnings(pick.value);
    else if (pick.value === 'again') this.playAgain();
    else this.showPositions();
  }

  splat(point, source) {
    const splat = this.addElement('splat', point);
    splat.dataset.source = source;
    this.camera.pictureChangeAround(point, SPLAT_RADIUS * 1.3, SPLAT_MS);
    setTimeout(() => splat.remove(), SPLAT_MS);
    playThud();
  }

  // ---- A game ----

  beginGame() {
    this.setState('playing');
    this.game = newGame(this.innings);
    this.lineScore = [0];
    this.hud.hidden = false;
    this.camera.updateExcluded();
    this.showScore();
    playBeep(true);
    const session = this.session;
    const tick = () => {
      if (session !== this.session || this.state !== 'playing') return;
      this.update(performance.now());
      requestAnimationFrame(tick);
    };
    this.nextBatter();
    requestAnimationFrame(tick);
  }

  /** The next batter steps in: everything up to the throw is one long change to the whole picture. */
  nextBatter() {
    const now = performance.now();
    const play = planPlay(this.position, this.game.bases);
    this.play = play;
    this.moves = runnerMoves(play, this.game.bases);
    this.resolved = false;
    this.anim = null;
    this.called = null;
    this.pending = [];
    this.remap = null;
    this.slide = null;
    this.crowd = { mood: 'still', since: now };
    this.fireworks = [];
    const windupAt = now + INTRO_MS - WINDUP_MS;
    const pitchAt = now + INTRO_MS;
    const crackAt = pitchAt + PITCH_MS;
    const fieldedAt = crackAt + BATTED_MS[play.kind];
    const panAt = fieldedAt + GLOVE_MS;
    const throwAt = panAt + PAN_MS;
    // The runner gets there once the throw has been open (to the camera too) for their time.
    const arrivesAt = throwAt + SETTLE_MS + play.runnerMs;
    this.timeline = { start: now, windupAt, pitchAt, crackAt, fieldedAt, panAt, throwAt, arrivesAt, sounds: new Set() };
    this.views = {
      start: battingView(play.start),
      fielded: battingView(play.fieldedAt),
      lined: throwView(play.fieldedAt, play.coverAt),
    };
    // A foot at the covering fielder, in screen heights: smaller on a long throw.
    this.scale = feetScale(play.fieldedAt, play.coverAt);
    this.cast = this.castFor(play);
    this.camera.pictureChangeEverywhere(throwAt - now);
    this.removeRunner();
    this.field.querySelectorAll('.fc-pow').forEach((el) => el.remove());
    this.clearFielder();
    this.clearFx();
    this.setCaption(FIELDERS_CHOICE_TEXT.situation(this.game));
    this.setPhase('intro');
    this.root.dataset.target = play.target;
    this.root.dataset.call = '';
    this.root.dataset.throw = '';
  }

  /**
   * Everyone besides the batter and runners: where they start, where they go
   * once the ball is hit (the covering fielder to the bag, the umpire making
   * the call to beside it, anyone in the line of the throw out of it), and
   * when they get there (before the view turns to the base).
   */
  castFor(play) {
    const tl = this.timeline;
    const leave = tl.crackAt + 150;
    // Anyone getting out of the way goes to the side the runner isn't coming from.
    const away = -runnerSide(play);
    const cast = [];
    const add = (id, from, to, extra) => {
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      const gait = extra.gait ?? 'jog';
      const ms = Math.min(distance / SPEED[gait], (tl.throwAt - leave) * 0.85);
      cast.push({ id, from, to, leave, arrive: leave + Math.max(1, ms), gait, ...extra });
    };
    for (const [id, fielder] of Object.entries(FIELDERS)) {
      if (id === this.position) continue;
      if (id === play.cover) {
        add(id, fielder.spot, play.coverAt, { team: 'home', role: 'cover', gait: 'run' });
        continue;
      }
      add(id, fielder.spot, outOfTheWay(play.fieldedAt, play.coverAt, fielder.spot, RULES, { side: away }), { team: 'home', role: id });
    }
    // At home, the plate umpire makes the call from beside the plate, away from the runner.
    const plate = play.target === 'home' ? umpireSpot(play) : outOfTheWay(play.fieldedAt, play.coverAt, PLATE_UMPIRE, RULES, { side: away });
    add('U', PLATE_UMPIRE, plate, { team: 'umpire', role: 'U', caller: play.target === 'home' });
    if (play.target !== 'home') {
      add('BU', BASE_UMPIRE[play.target], umpireSpot(play), { team: 'umpire', role: 'BU', caller: true });
    }
    return cast;
  }

  update(now) {
    this.drawDiamond(now);
    const tl = this.timeline;
    if (!tl) return;
    for (const job of this.pending.filter((j) => now >= j.at)) {
      this.pending = this.pending.filter((j) => j !== job);
      job.fn(now);
    }
    if (this.phase === 'throw' || this.phase === 'result' || this.phase === 'between') {
      this.moveRunner(now);
      if (this.phase === 'throw' && !this.resolved && now >= tl.arrivesAt + LATE_GRACE_MS) this.late(now);
      if (this.phase !== 'throw') {
        // After the throw, everything moves: none of it is a ball.
        this.camera.pictureChangeEverywhere();
        this.drawResult(now);
      }
      return;
    }
    if (!this.play) return;

    let phase = 'intro';
    if (now >= tl.throwAt) phase = 'throw';
    else if (now >= tl.panAt) phase = 'pan';
    else if (now >= tl.fieldedAt) phase = 'glove';
    else if (now >= tl.crackAt) phase = 'batted';
    else if (now >= tl.pitchAt) phase = 'pitch';
    if (phase !== this.phase) this.setPhase(phase);
    if (phase === 'throw') {
      this.openThrow(now);
      return;
    }
    this.sound(now);
    this.drawPlay(now);
  }

  /** Sounds of the play, each once. */
  sound(now) {
    const tl = this.timeline;
    const once = (name, at, play) => {
      if (now >= at && !tl.sounds.has(name)) {
        tl.sounds.add(name);
        play();
      }
    };
    once('crack', tl.crackAt, () => {
      playBatCrack();
      const cam = this.cameraFor(this.views.start);
      const p = cam.project({ x: 0, y: 0, z: 4 });
      if (p) this.pow('crack', { x: Math.min(0.85, Math.max(0.15, p.x)), y: Math.min(0.7, Math.max(0.2, p.y - 0.12)) }, false);
    });
    once('glove', tl.fieldedAt, playGlovePop);
  }

  /** The view has turned to the base: the picture stands still but for the runner. */
  openThrow(now) {
    const play = this.play;
    const cam = this.cameraFor(this.views.lined);
    fitCanvas(this.scene);
    drawScene(this.scene.getContext('2d'), cam, this.sceneFor(this.timeline.throwAt, 'throw'));
    drew(this.scene);
    this.drawFielderAt(now);
    this.addRunner(cam);
    this.moveRunner(now);
    this.setCaption(FIELDERS_CHOICE_TEXT.throwTo(play), true);
    this.placeReach();
  }

  // ---- The throw and how it turns out ----

  /** A throw landed at `point`: the drawn ball flies in, and the fielder catches it or it gets past. */
  thrown(point, inTime) {
    const now = performance.now();
    this.resolve(now);
    const outcome = throwOutcome(point, aspect(), this.scale);
    this.root.dataset.throw = outcome;
    const target = fromFielder(point, aspect(), this.scale);
    const reach = outcome === 'catch' ? reachPose(target) : this.missReach(target, outcome);
    const catchAt = now + FLIGHT_MS;
    this.anim = { start: now, point, outcome, reach, end: outcome === 'catch' ? this.gloveScreen(reach) : point };
    // Up in the air for it: they come down with a foot back on the bag.
    if (reach.pose.lFoot.y > 0 && reach.pose.rFoot.y > 0 && !reach.pose.turn) this.anim.land = landPose(target);
    if (outcome === 'catch') {
      this.after(FLIGHT_MS, () => {
        playGlovePop();
        this.pow('pop', this.anim.end);
      });
      if (!inTime) {
        this.at(catchAt + 250, () => this.call(false, true));
        return;
      }
      if (this.play.kind === 'hit') {
        // A tag: the runner comes in to the glove, and is tagged as they get there.
        const arrive = Math.max(this.timeline.arrivesAt, catchAt + 350);
        this.hurryRunners(now, arrive);
        this.anim.tagAt = arrive - TAG_MS;
        this.anim.tag = reachPose({ x: (this.runner?.fromLeft ?? true) ? -1.4 : 1.4, y: 0.7 });
        this.anim.showAt = arrive + 300;
        this.at(arrive + 60, () => this.call(true, false));
      } else {
        // A force: the ball beats the runner to the bag.
        this.hurryRunners(now, Math.max(this.timeline.arrivesAt, catchAt + 450));
        this.anim.showAt = catchAt + 450;
        this.at(catchAt + 200, () => this.call(true, false));
      }
    } else {
      this.after(FLIGHT_MS, () => {
        this.pow(outcome === 'low' ? 'skip' : 'whiff', point);
        playThud();
      });
      this.at(Math.max(this.arrival(), catchAt + 700), () => this.call(false, false));
    }
  }

  /** The fielder going for a throw out of reach: a dive out wide, a jump high, a scoop low. */
  missReach(target, outcome) {
    const { side, up, down } = RULES.reach;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const near = { x: clamp(target.x, -side, side), y: clamp(target.y, -down, up) };
    if (outcome === 'left' || outcome === 'right') return reachPose({ x: near.x, y: Math.max(1, near.y) }, { dive: true });
    return reachPose({ x: near.x, y: outcome === 'high' ? up - 0.3 : 0.3 });
  }

  /** Nobody threw in time: the runner is in. */
  late(now) {
    this.resolve(now);
    this.root.dataset.throw = 'none';
    this.call(false, true);
  }

  /** No more throws for this batter; from now on everything is free to move. */
  resolve() {
    this.resolved = true;
    this.setPhase('result');
    if (this.runner) for (const box of this.runner.boxes) this.camera.untrack(box.el);
    this.camera.pictureChangeEverywhere();
  }

  /**
   * The runners speed up or slow down from now so they get there at `arrive`
   * (a throw that beat them, drawn flying in, must get there first).
   */
  hurryRunners(now, arrive) {
    if (arrive <= this.arrival()) return;
    this.remap = { t0: now, u0: this.progress(now), t1: arrive };
  }

  /** When the runners get there, as drawn. */
  arrival() {
    return this.remap ? this.remap.t1 : this.timeline.arrivesAt;
  }

  /** How far (0–1) the runners are along their paths at `now`, as drawn. */
  progress(now) {
    const tl = this.timeline;
    if (this.remap && now >= this.remap.t0) {
      const { t0, u0, t1 } = this.remap;
      return Math.min(1, u0 + ((1 - u0) * (now - t0)) / (t1 - t0));
    }
    return Math.min(1, Math.max(0, (now - tl.crackAt) / (tl.arrivesAt - tl.crackAt)));
  }

  /** The umpire's call, then what it means for the game. */
  call(out, late) {
    const now = performance.now();
    this.called = { out, late, at: now };
    this.sceneAt = now; // the scene shows the call from the next redraw on, so this frame stays quick
    this.root.dataset.call = out ? 'out' : 'safe';
    const result = playResult(this.game, this.play, out);
    const before = this.game;
    this.game = result.state;
    this.lineScore[before.inning - 1] = (this.lineScore[before.inning - 1] ?? 0) + result.runs;
    if (out) {
      playDing(2);
      playCheer();
      this.crowd = { mood: 'cheer', since: now };
    } else {
      playEscape();
      if (result.runs) this.crowd = { mood: 'groan', since: now };
    }
    const anim = this.anim;
    const text = out ? FIELDERS_CHOICE_TEXT.out(this.play)
      : FIELDERS_CHOICE_TEXT.safe(this.play, late || !anim || anim.outcome === 'catch');
    this.setCaption(text + FIELDERS_CHOICE_TEXT.runs(result.runs));
    // The score shows the play's outs and runs, before the inning changes over.
    this.showScore({ ...before, outs: before.outs + (out ? 1 : 0), runs: result.state.runs });

    let wait = RESULT_MS;
    if (result.gameOver && result.state.runs === 0) {
      // A shutout: fireworks over the stands.
      wait += FIREWORKS_MS;
      const colours = ['#e0a72a', '#e8574a', '#6aa6d6', '#7fd36a', '#e8c48a'];
      this.fireworks = Array.from({ length: 9 }, (_, i) => ({
        x: 0.15 + ((i * 0.37) % 0.7), y: 0.12 + ((i * 0.23) % 0.25), at: now + 300 + i * 320, colour: colours[i % colours.length],
      }));
      playFanfare();
    }
    this.after(wait, () => {
      if (result.gameOver) this.endGame();
      else if (result.inningOver) this.betweenInnings(before.inning, result.mercy);
      else {
        this.showScore();
        this.nextBatter();
      }
    });
  }

  betweenInnings(inning, mercy) {
    this.setPhase('between');
    this.lineScore[inning] = 0;
    this.showScore();
    this.setCaption(mercy ? FIELDERS_CHOICE_TEXT.mercy(inning) : FIELDERS_CHOICE_TEXT.inningOver(inning));
    playFanfare();
    this.after(INNING_MS, () => this.nextBatter());
  }

  endGame() {
    this.setState('over');
    this.setPhase('');
    this.removeRunner();
    this.camera.pictureChangeEverywhere();
    this.clearFielder();
    this.clearFx();
    this.hideCaption();
    this.hud.hidden = true;
    this.camera.updateExcluded();
    this.field.querySelectorAll('.fc-pow').forEach((el) => el.remove());
    this.drawDiagram();
    playFanfare();

    const runs = this.game.runs;
    const key = `${GAME_ID}:${this.position}:${this.innings}`;
    const best = loadLowestScore(key);
    const isBest = !this.camera.mouseOnly && (best === null || runs < best);
    if (isBest) saveBestScore(key, runs);
    this.showPanel({
      title: FIELDERS_CHOICE_TEXT.gameOver(runs),
      result: FIELDERS_CHOICE_TEXT.result(runs, this.innings, this.position),
      best: isBest ? FIELDERS_CHOICE_TEXT.newBest : best === null ? '' : FIELDERS_CHOICE_TEXT.best(best),
    });
    this.panel.classList.toggle('new-best', isBest);
    this.after(REARM_MS, () => {
      if (this.state !== 'over') return;
      this.addPick({ ...AGAIN_SPOTS.again, r: PICK_RADIUS * 1.3 }, 'again', FIELDERS_CHOICE_TEXT.again);
      this.addPick({ ...AGAIN_SPOTS.change, r: PICK_RADIUS * 1.3 }, 'change', FIELDERS_CHOICE_TEXT.change);
    });
  }

  /** Runs `fn` after `ms`, unless the game has been left or restarted meanwhile. */
  after(ms, fn) {
    const session = this.session;
    setTimeout(() => {
      if (session === this.session) fn();
    }, ms);
  }

  /** Runs `fn` on the first frame at or after `time` (for this batter only). */
  at(time, fn) {
    this.pending.push({ at: time, fn });
  }

  /** A comic word (POP!, WHIFF!, SKIP!, CRACK!) bursting out at `point`. */
  pow(kind, point, report = true) {
    const el = this.addElement('fc-pow', point);
    el.dataset.kind = kind;
    const word = document.createElement('span');
    word.textContent = { pop: 'POP!', whiff: 'WHIFF!', skip: 'SKIP!', crack: 'CRACK!' }[kind];
    el.append(word);
    if (report) this.camera.pictureChange(rectOf(el, 0.03), POW_MS);
    this.after(POW_MS, () => el.remove());
  }

  // ---- Drawing the play ----

  cameraFor(view) {
    return makeCamera(view, aspect());
  }

  /** The scene before the throw: the windup and pitch, the swing, the ball coming to the fielder, and the view turning. */
  drawPlay(now) {
    const tl = this.timeline;
    const play = this.play;
    let view;
    let ball = null;
    let trail = [];
    let glove = 0;
    if (now < tl.crackAt) {
      view = this.views.start;
      if (now >= tl.pitchAt) {
        const pitch = (u) => ({ x: 0.4 * (1 - u), y: 56 - 55 * u, z: 5.6 - 2.6 * u });
        const u = (now - tl.pitchAt) / PITCH_MS;
        ball = pitch(u);
        trail = [0.12, 0.08, 0.04].map((d) => pitch(Math.max(0, u - d)));
      }
    } else if (now < tl.fieldedAt) {
      const u = (now - tl.crackAt) / (tl.fieldedAt - tl.crackAt);
      view = blendViews(this.views.start, this.views.fielded, ease(Math.min(1, u * 1.15)));
      ball = battedBallAt(play, u);
      trail = [0.06, 0.04, 0.02].map((d) => battedBallAt(play, Math.max(0, u - d)));
      glove = Math.max(0, (u - 0.6) / 0.4);
    } else if (now < tl.panAt) {
      view = this.views.fielded;
      glove = 1;
    } else {
      const u = (now - tl.panAt) / PAN_MS;
      view = blendViews(this.views.fielded, this.views.lined, ease(u));
      glove = Math.max(0, 1 - u * 2);
    }
    fitCanvas(this.scene);
    const ctx = this.scene.getContext('2d');
    drawScene(ctx, this.cameraFor(view), { ...this.sceneFor(now, 'play'), ball, trail });
    if (glove > 0) drawBigGlove(ctx, glove, now >= tl.fieldedAt, play.kind);
    drew(this.scene);
  }

  /**
   * After the throw: the covering fielder, the ball and the fireworks, and
   * the scene while anything in it moves (the umpire's call and the crowd,
   * the scoreboard changing). Until the call, it stays as it was for the throw.
   */
  drawResult(now) {
    // The crowd and the umpire are drawn ten times a second: often enough to look lively.
    if (this.called && now - this.called.at < CROWD_MS && !(now - this.sceneAt < SCENE_MS)) {
      this.sceneAt = now;
      fitCanvas(this.scene);
      drawScene(this.scene.getContext('2d'), this.cameraFor(this.views.lined), this.sceneFor(now, 'result'));
      drew(this.scene);
    }
    this.drawFielderAt(now);
  }

  /**
   * What's on the field at `now`. In 'play' (before the throw), everyone. In
   * 'throw' (the still picture players throw at) and 'result', not the
   * covering fielder or the runner the throw is for (drawn on their own); and
   * while throwing, not the other runners either (they'd move).
   * @param {'play'|'throw'|'result'} mode
   */
  sceneFor(now, mode) {
    const tl = this.timeline;
    const figures = [];
    const hit = now >= tl.crackAt;
    for (const actor of this.cast) {
      if (mode !== 'play' && actor.role === 'cover') continue;
      figures.push(this.actorAt(actor, now));
    }
    // The batter, then the runners.
    if (!hit || now < tl.crackAt + 250) {
      const swing = keyframes([
        { at: tl.windupAt, pose: POSES.stance },
        { at: tl.pitchAt + PITCH_MS * 0.5, pose: POSES.load },
        { at: tl.crackAt, pose: POSES.swing },
        { at: tl.crackAt + 220, pose: POSES.followThrough },
      ], now);
      figures.push({ at: BATTER_BOX, player: this.runnerPlayer('home', swing), facing: { x: 1, y: 0 }, lookAt: FIELDERS.P.spot });
    }
    if (now >= tl.crackAt + 250) figures.push({ prop: 'bat', at: { x: -5, y: -4.5 }, angle: 2.6 });
    for (const move of this.moves) {
      if (move.from === 'home' && now < tl.crackAt + 250) continue;
      if (mode !== 'play' && move.thrownAt) continue;
      // The other runners on the move aren't drawn once the view is on the base (they'd move across the still picture).
      if (mode !== 'play' && move.path.length > 1) continue;
      figures.push(this.runnerThing(move, now));
    }
    return {
      figures,
      crowd: this.crowd,
      now,
      board: { runs: this.lineScore, inning: this.game.inning, innings: this.game.innings, outs: this.game.outs },
    };
  }

  /** A fielder or umpire at `now`: in their stance, on the move, or (the umpire making the call) calling it. */
  actorAt(actor, now) {
    const tl = this.timeline;
    const player = {
      team: actor.team, number: NUMBER_OF[actor.id], skin: SKIN_OF[actor.id],
      glove: actor.team === 'home' ? 'r' : null, mask: actor.id === 'U' || (actor.id === 'C' && now < tl.crackAt),
    };
    const moving = now >= actor.leave && now < actor.arrive && Math.hypot(actor.to.x - actor.from.x, actor.to.y - actor.from.y) > 0.5;
    if (moving) {
      const k = (now - actor.leave) / (actor.arrive - actor.leave);
      const at = { x: actor.from.x + (actor.to.x - actor.from.x) * k, y: actor.from.y + (actor.to.y - actor.from.y) * k };
      const run = Math.hypot(at.x - actor.from.x, at.y - actor.from.y);
      const facing = { x: actor.to.x - actor.from.x, y: actor.to.y - actor.from.y };
      const pose = runPose(run / STRIDE[actor.gait], { jog: actor.gait === 'jog' });
      return { at, player: { ...player, pose, glove: actor.team === 'home' ? 'l' : null }, facing };
    }
    const at = now >= actor.arrive ? actor.to : actor.from;
    return { at, player: { ...player, pose: this.stanceOf(actor, now) }, facing: this.facingOf(actor, at, now) };
  }

  /**
   * Which way someone standing still faces: the pitcher and everyone in the
   * field towards home (the catcher and the plate umpire out to the pitcher)
   * until the ball is hit, then towards the fielder with the ball (the eye):
   * null, as the art faces them that way.
   */
  facingOf(actor, at, now) {
    const tl = this.timeline;
    if (actor.id === 'P') return now < tl.crackAt + 600 ? { x: 0, y: -1 } : null;
    if (now >= tl.crackAt + 300) return null;
    if (actor.id === 'C' || actor.id === 'U') return { x: 0, y: 1 };
    return { x: -at.x, y: -at.y };
  }

  /** How someone stands when they aren't moving. */
  stanceOf(actor, now) {
    const tl = this.timeline;
    const hit = now >= tl.crackAt;
    if (actor.id === 'P' && now < tl.crackAt + 600) {
      return keyframes([
        { at: tl.windupAt, pose: POSES.set },
        { at: tl.windupAt + WINDUP_MS * 0.55, pose: POSES.kick },
        { at: tl.pitchAt - 60, pose: POSES.stride },
        { at: tl.pitchAt + 60, pose: POSES.release },
        { at: tl.pitchAt + 320, pose: POSES.pitchFollow },
      ], now);
    }
    if (actor.team === 'umpire') {
      if (actor.caller && this.called) {
        const t = now - this.called.at;
        return this.called.out
          ? keyframes([{ at: 0, pose: POSES.umpSet }, { at: 220, pose: POSES.umpOutUp }, { at: 420, pose: POSES.umpOutDown }], t)
          : keyframes([{ at: 0, pose: POSES.umpSet }, { at: 180, pose: POSES.umpSafeIn }, { at: 400, pose: POSES.umpSafeOut }], t);
      }
      return POSES.umpSet;
    }
    if (actor.role === 'cover') return hit ? POSES.ready : POSES.crouch;
    if (actor.id === 'C') return hit ? POSES.stand : POSES.catcher;
    return hit ? POSES.stand : POSES.crouch;
  }

  /** A runner's look: the visitors, in batting helmets. */
  runnerPlayer(from, pose) {
    const number = from === 'home' ? 10 + ((this.game.batters * 7) % 40) : NUMBER_OF[from];
    return { pose, team: 'away', helmet: true, number, skin: SKIN_OF[from] };
  }

  /** A runner on the field at `now` (not the one the throw is for, once the view is on them). */
  runnerThing(move, now) {
    const tl = this.timeline;
    if (move.path.length === 1) {
      const at = BASES[move.from];
      return { at, player: this.runnerPlayer(move.from, now < tl.crackAt ? POSES.crouch : POSES.stand), facing: now < tl.crackAt ? { x: -at.x, y: -at.y } : null };
    }
    const { at, pose, facing, reach } = this.runnerState(move, now);
    return { at: feetOf(at, facing, reach), player: this.runnerPlayer(move.from, pose), facing };
  }

  /**
   * Where a running runner is at `now`, how they're posed (running, sliding,
   * standing on the bag), which way they face, and how far their leading foot
   * is ahead of their feet (in a slide). Their feet are where `at` is, but in
   * a slide `at` is their leading foot, which reaches the bag.
   */
  runnerState(move, now) {
    const tl = this.timeline;
    const u = this.progress(now);
    const length = pathLength(move.path);
    let at = alongPath(move.path, u);
    // The batter takes a moment to drop the bat, then starts from the box.
    if (move.from === 'home' && now < tl.crackAt + 650) {
      const k = Math.max(0, (now - tl.crackAt - 250) / 400);
      at = { x: BATTER_BOX.x + (at.x - BATTER_BOX.x) * k, y: BATTER_BOX.y + (at.y - BATTER_BOX.y) * k };
    }
    // They face along the base path they're on (straight at the next base, so they look the same all the way there).
    const leg = legAt(move.path, u);
    const from = BASES[move.path[leg]];
    const to = BASES[move.path[Math.min(leg + 1, move.path.length - 1)]];
    const facing = { x: to.x - from.x, y: to.y - from.y };
    const arrive = this.arrival();
    const run = runPose((u * length) / STRIDE.run);
    if (now < tl.crackAt) return { at: BASES[move.from], pose: POSES.crouch, facing: null, reach: 0, leg };
    if (move.thrownAt && this.slides(now)) {
      const k = Math.min(1, (now - (arrive - SLIDE_MS)) / 140);
      if (now >= arrive + 900 && this.called && !this.called.out) {
        return { at, pose: blendPoses(POSES.slide, POSES.stand, (now - arrive - 900) / 300), facing, reach: 0, leg };
      }
      return { at, pose: blendPoses(run, POSES.slide, k), facing, reach: SLIDE_REACH * ease(k), leg };
    }
    if (now >= arrive) return { at, pose: blendPoses({ ...run, lift: 0 }, POSES.stand, (now - arrive) / 220), facing, reach: 0, leg };
    return { at, pose: run, facing, reach: 0, leg, phase: (u * length) / STRIDE.run };
  }

  /**
   * Whether the runner the throw is for slides in: into second, third or
   * home, when the throw hasn't been caught as they near the bag, or was
   * caught only just before. Decided once, as they near it.
   */
  slides(now) {
    if (this.slide !== null) return this.slide;
    const arrive = this.arrival();
    if (now < arrive - SLIDE_MS) return false;
    const anim = this.anim;
    const caughtAt = anim?.outcome === 'catch' ? anim.start + FLIGHT_MS : null;
    this.slide = RULES.slideBases.includes(this.play.target)
      && (caughtAt === null || caughtAt > now || caughtAt >= arrive - RULES.closeMs);
    return this.slide;
  }

  /** The runner the throw is for, as an element of their own the camera follows (by their head). */
  addRunner(cam) {
    const move = this.moves.find((m) => m.thrownAt);
    if (!move) return;
    const H = window.innerHeight;
    const px = this.scale * H; // the same size as the covering fielder
    const el = document.createElement('div');
    el.className = 'fc-runner';
    el.style.width = `${2 * SPRITE.side * px}px`;
    el.style.height = `${(SPRITE.up + SPRITE.down) * px}px`;
    const canvas = document.createElement('canvas');
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(2 * SPRITE.side * px * ratio);
    canvas.height = Math.round((SPRITE.up + SPRITE.down) * px * ratio);
    el.append(canvas);
    this.field.insertBefore(el, this.fx);
    this.runner = { el, canvas, ratio, move, cam, px, boxes: [], key: null, arrived: false, frames: new Map() };
  }

  /**
   * Tells the camera how to follow the runner: in their run, the head is the
   * one part that never changes, so it is watched; arms, legs and the field
   * between them are kept out of the way. Sliding, they're kept out of the
   * way entirely. Each change of look (starting a new base path, starting to
   * slide) is followed afresh.
   * @param {{x:number, y:number}} facing the way they run on this base path
   */
  trackRunner(mode, key, facing) {
    const runner = this.runner;
    for (const box of runner.boxes) {
      this.camera.untrack(box.el);
      box.el.remove();
    }
    runner.boxes = [];
    runner.mode = mode;
    runner.key = key;
    if (this.resolved || mode === 'gone') return;
    const { side, up, down } = SPRITE;
    // Where their head is in their picture: feet across and up from their feet, as the view sees it.
    const feet = { x: 0, y: 0, z: 0 };
    const head = jointAt({ at: feet, facing, player: { pose: { ...runPose(0), lift: 0 } } }, 'head');
    const axes = viewAxes(runner.cam.view);
    const hx = head.x * axes.right.x + head.y * axes.right.y + head.z * axes.right.z;
    const hy = head.x * axes.up.x + head.y * axes.up.y + head.z * axes.up.z;
    const core = { x0: hx - 0.38, x1: hx + 0.38, y0: hy - 0.38, y1: hy + 0.38 };
    const boxes = mode === 'run' ? [
      { x0: core.x0, x1: core.x1, y0: core.y0, y1: core.y1, watch: true },
      { x0: -side, x1: core.x0, y0: -down, y1: up, watch: false },
      { x0: core.x1, x1: side, y0: -down, y1: up, watch: false },
      { x0: core.x0, x1: core.x1, y0: core.y1, y1: up, watch: false },
      { x0: core.x0, x1: core.x1, y0: -down, y1: core.y0, watch: false },
    ] : [{ x0: -side, x1: side, y0: -down, y1: up, watch: false }];
    const { px } = runner;
    for (const b of boxes) {
      const box = document.createElement('i');
      box.style.left = `${(b.x0 + side) * px}px`;
      box.style.width = `${(b.x1 - b.x0) * px}px`;
      box.style.top = `${(up - b.y1) * px}px`;
      box.style.height = `${(b.y1 - b.y0) * px}px`;
      runner.el.append(box);
      runner.boxes.push({ el: box, watch: b.watch });
      this.camera.track(box, { shape: 'rect', watch: b.watch });
    }
  }

  /** Draws the runner the throw is for and moves them on; tells the camera when they change how they look. */
  moveRunner(now) {
    const runner = this.runner;
    if (!runner) return;
    const { at, pose, facing, reach, leg, phase } = this.runnerState(runner.move, now);
    const cam = runner.cam;
    const arrived = now >= this.arrival();
    const mode = arrived ? 'gone' : this.slides(now) ? 'slide' : 'run';
    const key = `${mode} ${leg}`;
    if (!this.resolved && key !== runner.key) {
      if (mode === 'gone' && runner.mode !== 'gone') this.camera.pictureChange(rectOf(runner.el, 0.02), SETTLE_MS);
      this.trackRunner(mode, key, facing);
    }
    // In a slide, `at` is the leading foot: the picture is centred on their feet, behind it.
    const feet = feetOf(at, facing, reach);
    const origin = { ...feet, z: groundHeight(feet.x, feet.y) };
    // The bounce of the run moves the whole picture, so the head stays put in it.
    const lift = pose.lift ?? 0;
    const p = cam.project(origin);
    runner.fromLeft = p ? p.x < RULES.feetAt.x : true;
    const { side, up, down } = SPRITE;
    const { px } = runner;
    const width = 2 * side * px;
    const height = (up + down) * px;
    const clamp = (v, size, max) => Math.min(max + 10, Math.max(-size - 10, v));
    const x = p ? clamp(p.x * window.innerWidth - side * px, width, window.innerWidth) : -width - 10;
    const y = p ? clamp(p.y * window.innerHeight - up * px - lift * px, height, window.innerHeight) : 0;
    runner.el.style.transform = `translate(${x}px, ${y}px)`;
    const r = runner.ratio;
    const draw = (canvas, p) => drawSprite(canvas.getContext('2d'), cam.view, {
      at: origin, facing, player: this.runnerPlayer(runner.move.from, { ...p, lift: 0 }),
    }, { px: px * r, ax: side * px * r, ay: up * px * r, origin });
    const ctx = runner.canvas.getContext('2d');
    if (mode === 'run' && phase !== undefined) {
      // The run repeats every stride, and looks the same all along a base path: each picture of it is drawn once.
      if (runner.framesLeg !== leg) {
        runner.frames.clear();
        runner.framesLeg = leg;
      }
      const k = Math.round((((phase % 1) + 1) % 1) * RUN_FRAMES) % RUN_FRAMES;
      let frame = runner.frames.get(k);
      if (!frame) {
        frame = Object.assign(document.createElement('canvas'), { width: runner.canvas.width, height: runner.canvas.height });
        draw(frame, runPose(k / RUN_FRAMES));
        runner.frames.set(k, frame);
      }
      ctx.clearRect(0, 0, runner.canvas.width, runner.canvas.height);
      ctx.drawImage(frame, 0, 0);
    } else {
      draw(runner.canvas, pose);
    }
  }

  removeRunner() {
    if (!this.runner) return;
    for (const box of this.runner.boxes) this.camera.untrack(box.el);
    this.runner.el.remove();
    this.runner = null;
  }

  /** The covering fielder, on their own canvas, with the drawn throw. */
  drawFielderAt(now) {
    fitCanvas(this.overlay);
    fitCanvas(this.fx);
    const ctx = this.overlay.getContext('2d');
    const fx = this.fx.getContext('2d');
    const { width: W, height: H } = this.overlay;
    fx.clearRect(0, 0, W, H);
    const { pose, glove, holdsBall } = this.fielderPose(now);
    const ball = this.ballAt(now);
    // Only round the fielder: room for a dive to either side, or a leap.
    const s = this.scale;
    const { x, y } = RULES.feetAt;
    const crop = { x0: x - (10 * s) / aspect(), x1: x + (10 * s) / aspect(), y0: y - 12.5 * s, y1: y + 2.5 * s };
    drawFigures(ctx, this.cameraFor(this.views.lined), [this.coverThing({
      pose, team: 'home', number: NUMBER_OF[this.play.cover], skin: SKIN_OF[this.play.cover], glove, holdsBall, mask: false,
    })], crop);
    if (ball && ball.behind) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      drawFlyingBall(ctx, ball.x * W, ball.y * H, ball.r * H, null, now);
      ctx.restore();
    }
    if (ball && !ball.behind) drawFlyingBall(fx, ball.x * W, ball.y * H, ball.r * H, ball.from && { x: ball.from.x * W, y: ball.from.y * H }, now);
    if (this.fireworks.length) drawFireworks(fx, this.fireworks, now);
    if (ball?.puff) {
      // A puff of dust where the ball smacks into the glove.
      fx.strokeStyle = `rgba(200, 170, 120, ${1 - ball.puff})`;
      fx.lineWidth = H * 0.008;
      fx.beginPath();
      fx.arc(ball.x * W, ball.y * H, H * (0.02 + 0.05 * ball.puff), 0, 2 * Math.PI);
      fx.stroke();
    }
    drew(this.overlay);
    drew(this.fx);
  }

  /** The covering fielder on the bag, facing the thrower. */
  coverThing(player) {
    const at = this.play.coverAt;
    const eye = this.views.lined.eye;
    return { at, facing: { x: eye.x - at.x, y: eye.y - at.y }, player };
  }

  /** How the covering fielder is posed at `now`: ready, reaching for the throw, tagging, showing the ball, or shrugging. */
  fielderPose(now) {
    const anim = this.anim;
    const ready = { pose: POSES.ready, glove: 'r', holdsBall: false };
    if (!anim) {
      if (this.called && !this.called.out) return { pose: blendPoses(POSES.ready, POSES.shrug, (now - this.called.at) / 250), glove: 'r', holdsBall: false };
      return ready;
    }
    const t = now - anim.start;
    const k = 1 - (1 - Math.min(1, t / FLIGHT_MS)) ** 2;
    let pose = blendPoses(POSES.ready, anim.reach.pose, k);
    let { glove } = anim.reach;
    let reached = anim.reach.pose;
    if (anim.land && t > FLIGHT_MS) {
      // Falling back to earth: slow at the top, quickest as the feet reach the bag.
      const u = Math.min(1, (t - FLIGHT_MS) / LAND_MS);
      reached = blendPoses(anim.reach.pose, anim.land.pose, u * u);
      pose = reached;
    }
    const holdsBall = anim.outcome === 'catch' && t >= FLIGHT_MS;
    if (anim.outcome === 'catch') {
      if (anim.tag && now >= anim.tagAt) {
        pose = blendPoses(reached, anim.tag.pose, (now - anim.tagAt) / TAG_MS);
        glove = anim.tag.glove;
      }
      if (anim.showAt && now >= anim.showAt && this.called?.out) {
        pose = blendPoses(pose, POSES.showBall, (now - anim.showAt) / 250);
        glove = 'r';
      }
    } else if (t > FLIGHT_MS + 700 && !anim.reach.pose.turn) {
      pose = blendPoses(reached, { ...POSES.shrug, face: 'oops' }, (t - FLIGHT_MS - 700) / 300);
    } else if (t > FLIGHT_MS) {
      pose = { ...pose, face: 'oops' };
    }
    return { pose, glove, holdsBall };
  }

  /** Where on the screen the glove of a reach pose is. */
  gloveScreen(reach) {
    const hand = jointAt(this.coverThing({ pose: reach.pose }), `${reach.glove}Hand`);
    const p = this.cameraFor(this.views.lined).project(hand);
    return { x: p.x, y: p.y };
  }

  /**
   * The drawn ball at `now` (normalised screen position, radius as a fraction
   * of the screen height): flying in from the bottom of the screen, then past
   * the fielder if it wasn't caught, and away. `behind` once it's beyond them.
   */
  ballAt(now) {
    const anim = this.anim;
    if (!anim) return null;
    const t = now - anim.start;
    const s = this.scale;
    const far = 0.3 * s; // a ball (cartoon-sized) as big as it is at the fielder
    const near = 0.06;
    const P = anim.end;
    const S = { x: 0.5 + (P.x - 0.5) * 0.35, y: 1.12 };
    const C = { x: (S.x + P.x) / 2, y: Math.min(S.y, P.y) - 0.12 };
    if (t < FLIGHT_MS) {
      const u = t / FLIGHT_MS;
      const bez = (a, b, c) => (1 - u) ** 2 * a + 2 * (1 - u) * u * b + u * u * c;
      const x = bez(S.x, C.x, P.x);
      const y = bez(S.y, C.y, P.y);
      const r = 1 / ((1 - u) / near + u / far);
      const back = Math.max(0, u - 0.15);
      const from = { x: (1 - back) ** 2 * S.x + 2 * (1 - back) * back * C.x + back * back * P.x, y: (1 - back) ** 2 * S.y + 2 * (1 - back) * back * C.y + back * back * P.y };
      return { x, y, r, from };
    }
    const t2 = (t - FLIGHT_MS) / 1000;
    if (anim.outcome === 'catch') return t2 < 0.25 ? { x: P.x, y: P.y, r: 0, puff: t2 / 0.25, behind: false } : null;
    if (t2 > 1.4) return null;
    const ground = RULES.feetAt.y + 0.01;
    if (anim.outcome === 'high') {
      // Sails on over the glove, into the distance, and drops.
      const x = P.x + (P.x - C.x) * t2 * 1.2;
      const y = P.y - 0.25 * t2 + 0.5 * t2 * t2;
      return { x, y: Math.min(y, ground - 0.05), r: far * Math.max(0.35, 1 - t2 * 0.6), behind: true };
    }
    if (anim.outcome === 'low') {
      // Skips off the dirt, up past the glove, and away.
      const dir = P.x < 0.5 ? 1 : -1;
      const x = P.x + dir * 0.12 * t2;
      const y = P.y - 0.5 * t2 + 0.7 * t2 * t2;
      return { x, y: Math.min(y, ground + 0.02), r: far * Math.max(0.4, 1 - t2 * 0.5), behind: t2 > 0.08 };
    }
    // Wide: on past the dive, then bouncing and rolling away.
    const dir = anim.outcome === 'right' ? 1 : -1;
    const x = P.x + dir * (0.35 * t2 - 0.08 * t2 * t2);
    const y = Math.min(ground, P.y + 0.3 * t2 * t2 + 0.1 * t2);
    return { x, y, r: far * Math.max(0.4, 1 - t2 * 0.45), behind: true };
  }

  clearFielder() {
    this.overlay.getContext('2d').clearRect(0, 0, this.overlay.width, this.overlay.height);
    drew(this.overlay);
  }

  clearFx() {
    this.fx.getContext('2d').clearRect(0, 0, this.fx.width, this.fx.height);
    drew(this.fx);
  }

  /** Puts the (invisible) reach box where it is, for the camera view and tests. */
  placeReach() {
    const r = reachBox(aspect(), this.scale);
    Object.assign(this.reachEl.style, {
      left: `${r.x0 * 100}%`, top: `${r.y0 * 100}%`, width: `${(r.x1 - r.x0) * 100}%`, height: `${(r.y1 - r.y0) * 100}%`,
    });
  }

  drawDiagram() {
    fitCanvas(this.scene);
    drawDiagram(this.scene.getContext('2d'));
    drew(this.scene);
    this.clearFielder();
  }

  /** After the window changes size: draw the still picture again. */
  redraw() {
    if (!this.root.classList.contains('active')) return;
    this.camera.pictureChangeEverywhere();
    if (this.state !== 'playing') {
      this.drawDiagram();
      return;
    }
    this.placeReach();
    if (this.phase === 'throw') {
      fitCanvas(this.scene);
      const cam = this.cameraFor(this.views.lined);
      drawScene(this.scene.getContext('2d'), cam, this.sceneFor(this.timeline.throwAt, 'throw'));
      drew(this.scene);
      this.drawFielderAt(performance.now());
      if (this.runner) this.runner.cam = cam;
    }
  }

  // ---- Score, captions and panels ----

  showScore(state = this.game) {
    this.inningEl.textContent = `${state.inning}/${state.innings}`;
    this.outsEl.dataset.outs = String(state.outs);
    this.outsEl.replaceChildren(...Array.from({ length: RULES.outsPerInning }, (_, i) => {
      const dot = document.createElement('i');
      dot.className = i < state.outs ? 'fc-out on' : 'fc-out';
      return dot;
    }));
    this.runsEl.textContent = String(state.runs);
  }

  /** The bases in the corner, with the runners moving round them. */
  drawDiamond(now) {
    const ctx = this.diamond.getContext('2d');
    const { width: W, height: H } = this.diamond;
    ctx.clearRect(0, 0, W, H);
    const map = (p) => [W / 2 + (p.x / 90) * W * 0.36, H * 0.88 - (p.y / 127.3) * H * 0.72];
    const corners = ['home', 'first', 'second', 'third'].map((b) => map({ home: { x: 0, y: 0 }, first: { x: 63.6, y: 63.6 }, second: { x: 0, y: 127.3 }, third: { x: -63.6, y: 63.6 } }[b]));
    ctx.strokeStyle = '#8a93a6';
    ctx.lineWidth = W * 0.025;
    ctx.beginPath();
    corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    const occupied = new Set();
    const dots = [];
    const moving = this.timeline && this.play && this.phase !== 'between' && this.phase !== '' && now >= this.timeline.crackAt;
    if (moving && this.state === 'playing') {
      for (const move of this.moves) {
        if (this.called?.out && move.thrownAt) continue;
        dots.push({ p: alongPath(move.path, this.progress(now)), target: move.thrownAt });
      }
    } else if (this.game) {
      for (const base of ['first', 'second', 'third']) if (this.game.bases[base]) occupied.add(base);
    }
    ['first', 'second', 'third'].forEach((base, i) => {
      const [x, y] = corners[i + 1];
      const r = W * 0.075;
      ctx.fillStyle = occupied.has(base) ? '#ffd23f' : '#3a4152';
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fill();
    });
    for (const dot of dots) {
      const [x, y] = map(dot.p);
      ctx.fillStyle = dot.target ? '#ff6b5e' : '#ffd23f';
      ctx.beginPath();
      ctx.arc(x, y, W * 0.06, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  setCaption(text, big = false) {
    this.camera.pictureChange(rectOf(this.caption, 0.02));
    this.caption.textContent = text;
    this.caption.classList.toggle('big', big);
    if (this.caption.hidden) {
      this.caption.hidden = false;
      this.camera.updateExcluded();
    }
    this.camera.pictureChange(rectOf(this.caption, 0.02));
  }

  hideCaption() {
    if (this.caption.hidden) return;
    this.camera.pictureChange(rectOf(this.caption, 0.02));
    this.caption.hidden = true;
    this.camera.updateExcluded();
  }

  showPanel({ title, result = '', best = '', prompt = '', low = false }) {
    const set = (selector, text) => {
      const el = this.panel.querySelector(selector);
      el.textContent = text;
      el.hidden = !text;
    };
    if (!this.panel.hidden) this.camera.pictureChange(rectOf(this.panel, 0.03));
    set('.fc-title', title);
    set('.fc-result', result);
    set('.fc-best', best);
    set('.fc-prompt', prompt);
    this.panel.classList.remove('new-best');
    this.panel.classList.toggle('low', low);
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

  addElement(className, point) {
    const el = document.createElement('div');
    el.className = className;
    el.style.left = `${point.x * 100}%`;
    el.style.top = `${point.y * 100}%`;
    this.field.append(el);
    return el;
  }

  updateStatus() {
    renderGameStatus(this.statusEl, this.camera.note);
  }
}

/** Which leg of a path (from the base at that index to the next) a runner `u` (0–1) of the way along it is on. */
function legAt(path, u) {
  const total = pathLength(path);
  let left = Math.min(1, Math.max(0, u)) * total;
  for (let i = 0; i + 1 < path.length; i++) {
    const leg = Math.hypot(BASES[path[i + 1]].x - BASES[path[i]].x, BASES[path[i + 1]].y - BASES[path[i]].y);
    if (left < leg || i + 2 === path.length) return i;
    left -= leg;
  }
  return 0;
}

/** Where someone's feet are: in a slide, `at` is their leading foot, `reach` feet ahead of them. */
function feetOf(at, facing, reach) {
  if (!reach || !facing) return at;
  const d = Math.hypot(facing.x, facing.y) || 1;
  return { x: at.x - (facing.x / d) * reach, y: at.y - (facing.y / d) * reach };
}

function pathLength(path) {
  let length = 0;
  for (let i = 1; i < path.length; i++) {
    length += Math.hypot(BASES[path[i]].x - BASES[path[i - 1]].x, BASES[path[i]].y - BASES[path[i - 1]].y);
  }
  return length;
}

function aspect() {
  return window.innerWidth / window.innerHeight;
}

/** Numbers each new drawing on a canvas (data-rev), so anything copying it knows when it changed. */
function drew(canvas) {
  canvas.dataset.rev = String(Number(canvas.dataset.rev ?? 0) + 1);
}

function grow(r, pad) {
  return { x0: r.x0 - pad, y0: r.y0 - pad, x1: r.x1 + pad, y1: r.y1 + pad };
}
