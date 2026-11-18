// Batting Practice: hit off a pitching machine, with the numbers of every swing HitTrax-style. The machine stands
// between the batter and the projected wall and pitches small wiffle balls back at the batter every few
// seconds (a ball tossed at the bat, which the camera's launch mode follows, as in Gap Shot). Each swing is
// measured as it leaves the bat (exit velocity, launch angle, spray) and flown as if it were a baseball, with
// Gap Shot's physics, and Gap Shot's defence (with nobody on) calls it: single, double, triple, home run, out
// or foul. No innings, outs or strikes.
//
// The screen: the ballpark in 3D on the left, from a fixed, slightly raised view behind home plate; after a
// swing a short replay sends the ball along its flight with a trail and leaves a marker where it came down.
// On the right, a column (it is part of the picture, a ball that hits it counts): the call and the last shot's
// numbers (exit velocity, launch angle, spray, distance, hang time, apex), a top-down spray chart of the
// session, the session's averages and records, and the last swings. Swings that were not measured (one camera,
// a ball only seen arriving, a click) are shown as est. and left out of the averages, maxes and records.
//
// The camera: nothing moves while players aim. A swing changes the whole picture (the replay, the column), so
// the game tells the camera about all of it once, with the replay's length (pictureChangeEverywhere), and ignores
// hits until the picture is still and the camera has settled on it (readyAt): no more than TIMING.budgetMs after
// the hit (batting-practice-logic.js). The level is picked by hitting a target, as in Gap Shot.
//
// Rules and the numbers are in batting-practice-logic.js, the picture in batting-practice-scene.js (no browser
// code, unit tested); the drawing is Fielder's Choice's ballpark and players (fielders-choice-art.js).

import { loadBestScore, saveBestScore } from './storage.js';
import { playBatCrack, playCheer, playDing, playFanfare, playGroan, playRoar, playThud } from './sound.js';
import { BASES, makeCamera } from './fielders-choice-logic.js';
import { drawScene, fitCanvas } from './fielders-choice-art.js';
import { LEVELS, LEVEL_IDS, fieldersOf } from './gap-shot-logic.js';
import { MARKER_COLOURS, fenceShapes, restFigures } from './gap-shot-scene.js';
import {
  GAME_ID, OUTCOMES, OUTCOME_IDS, addShot, bestKey, newSession, readyAfterMs, recentShots, shotFor, shotText, summary, updateBests,
} from './batting-practice-logic.js';
import { chartLines, chartPoint, fieldView, replayFor, replayShapes } from './batting-practice-scene.js';
import { mphText } from './format.js';
import { SETTLE_MS, ThrowCamera, renderGameStatus } from './throw-camera.js';

export { GAME_ID };

// A swing is ready this long after the replay (the camera sees the change a little late, and takes a moment
// to settle on the picture): the camera's settling time, and a little more, as in Gap Shot.
const READY_MS = readyAfterMs(SETTLE_MS);
const POP_MS = 250; // a target appearing
const BURST_MS = 350; // …and being hit
const SPLAT_MS = 1200;
const SPLAT_RADIUS = 0.035;
const PICK_RADIUS = 0.1; // fraction of the shorter screen side
const PICK_GRACE = 1.2; // a throw this many radii from a pick target's centre picks it
// The targets sit over the ballpark, which is the left part of the screen (the column takes the rest).
const LEVEL_SPOTS = [{ x: 0.13, y: 0.55 }, { x: 0.325, y: 0.55 }, { x: 0.52, y: 0.55 }];
const NO_RUNNERS = { first: false, second: false, third: false };

export const BATTING_PRACTICE_TEXT = {
  title: 'Batting Practice',
  pickLevel: 'Hit a ball at a level to start',
  levelLabel: (id) => LEVELS[id].name.toUpperCase(),
  ready: 'READY',
  best: (level) => `Best at ${LEVELS[level].name}`,
};

export class BattingPractice {
  /** @param {HTMLElement} root the game's screen element */
  constructor(root) {
    this.root = root;
    this.field = root.querySelector('.bp-field');
    this.scene = root.querySelector('.bp-scene');
    this.panel = root.querySelector('.bp-panel');
    this.column = root.querySelector('.bp-column');
    this.lastEl = root.querySelector('.bp-last');
    this.wordEl = root.querySelector('.bp-word');
    this.chart = root.querySelector('.bp-chart');
    this.rows = root.querySelector('.bp-recent tbody');
    this.bar = root.querySelector('.game-bar');
    this.statusEl = root.querySelector('.game-status');

    this.token = 0; // increments when the game starts or stops, so stale timers can tell
    this.state = 'pick-level'; // 'pick-level' | 'playing'
    this.phase = ''; // while playing: 'aiming' (a ball can be hit) | 'replay' | 'between'
    this.picks = []; // the targets on screen to pick from: {x, y, r, el, value}
    this.level = 'high';
    this.session = newSession(this.level);
    this.bests = { mph: 0, distance: 0 }; // saved, for the level being played
    this.newBest = { mph: false, distance: false }; // set during this session
    this.replay = null; // the replay being shown: {replay, t0, revealed, …}
    this.shown = null; // the replay of the last swing, for the still picture after it
    this.fences = new Map(); // each level's portable fence as shapes, built once
    this.readyAt = 0; // balls on pictures from before this are not a swing
    this.balls = 0; // balls the camera saw hit the screen, since the game was opened

    this.camera = new ThrowCamera(root, {
      onHit: (hit) => this.hitAt(hit, 'ball', hit.time),
      onNote: () => this.updateStatus(),
      // A ball topped into the floor, or popped up over the screen, is a swing too (two cameras).
      flightHits: true,
      // A ball pitched and hit: followed from the bat, so how it left the bat is measured.
      launch: true,
    });
    // Only what changes on its own is ignored: the column is part of the picture, and a ball that hits it counts.
    this.camera.ignore(this.bar, this.panel);

    this.field.addEventListener('click', (e) => {
      this.hitAt({ x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }, 'mouse', performance.now());
    });
    document.addEventListener('fullscreenchange', () => this.updateStatus());
    window.addEventListener('resize', () => this.redraw());
  }

  /** @param {import('./storage.js').Calibration|null} calibration */
  start(calibration) {
    this.token++;
    this.reset();
    this.showLevels();
    this.updateStatus();
    this.startLoop();
    return this.camera.start(calibration);
  }

  stop() {
    this.token++;
    this.camera.stop();
    this.reset();
  }

  toggleDebug() {
    this.camera.toggleDebug();
  }

  /** Enter / Space: start with the level played last. */
  pressStart() {
    if (this.state === 'pick-level') this.pickLevel(this.level);
  }

  /** R: a new session at the same level. L: back to the level picker. */
  pressKey(key) {
    if (key === 'r') this.pickLevel(this.level);
    else if (key === 'l' && this.state !== 'pick-level') this.showLevels();
  }

  reset() {
    this.field.querySelectorAll('.bp-pick, .splat').forEach((el) => el.remove());
    this.picks = [];
    this.replay = null;
    this.shown = null;
    this.session = newSession(this.level);
    this.column.hidden = true;
    this.panel.hidden = true;
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
    const last = this.session.shots[this.session.shots.length - 1];
    d.level = this.level;
    d.balls = String(this.balls);
    d.swings = String(this.session.shots.length);
    d.measured = String(this.session.measured);
    // The last swing, once it is shown (at the end of its flight).
    const shown = this.shown && last === this.shown.shot ? last : null;
    d.outcome = shown ? shown.outcome.id : '';
    d.word = shown ? shown.outcome.word : '';
    d.est = shown && !shown.measured ? 'yes' : '';
    d.exitMph = shown && shown.mph !== null ? shown.mph.toFixed(1) : '';
    d.launch = shown ? ((shown.launch * 180) / Math.PI).toFixed(2) : '';
    d.spray = shown ? ((shown.spray * 180) / Math.PI).toFixed(2) : '';
    d.distance = shown ? String(Math.round(shown.carry)) : '';
  }

  // ---- Picking a level ----

  showLevels() {
    this.replay = null;
    this.shown = null;
    this.setState('pick-level');
    this.setPhase('');
    this.clearPicks();
    this.column.hidden = true;
    this.camera.updateExcluded();
    this.camera.pictureChangeEverywhere();
    this.drawStill();
    this.showPanel(BATTING_PRACTICE_TEXT.title, BATTING_PRACTICE_TEXT.pickLevel);
    LEVEL_IDS.forEach((id, i) => this.addPick({ ...LEVEL_SPOTS[i], r: PICK_RADIUS * 1.15 }, id, BATTING_PRACTICE_TEXT.levelLabel(id)));
    this.publish();
  }

  /** Starts a session at a level. */
  pickLevel(level) {
    this.level = level;
    this.clearPicks();
    this.hidePanel();
    this.session = newSession(level);
    this.bests = { mph: loadBestScore(bestKey(level, 'exit-velocity')), distance: loadBestScore(bestKey(level, 'distance')) };
    this.newBest = { mph: false, distance: false };
    this.replay = null;
    this.shown = null;
    this.setState('playing');
    this.column.hidden = false;
    this.camera.updateExcluded();
    // The column appears and the field is drawn afresh: all one change.
    this.camera.pictureChangeEverywhere();
    this.renderColumn();
    this.drawStill();
    this.getReady();
  }

  addPick(spot, value, label) {
    const el = document.createElement('div');
    el.className = 'fc-pick bp-pick';
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
   * @param {{x:number, y:number, fromFlight?: boolean}} hit normalised screen coordinates, and what the cameras measured
   * @param {'ball'|'mouse'} source
   * @param {number} time when the picture it landed on was on screen (performance.now())
   */
  hitAt(hit, source, time) {
    if (source === 'ball') {
      this.balls++;
      this.publish();
    }
    if (this.state === 'playing') {
      // One hit a swing: nothing while a replay is on, and nothing from before the picture was still.
      if (this.phase !== 'aiming' || time < this.readyAt) return;
      this.swing(hit);
      return;
    }
    if (!this.picks.length || hit.fromFlight) return;
    const pick = this.pickAt(hit);
    if (!pick) {
      this.splat(hit, source);
      return;
    }
    playDing(2);
    this.pickLevel(pick.value);
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

  // ---- A session ----

  /** The picture is still: once the camera has settled on it, a swing can be taken. */
  getReady() {
    this.setPhase('between');
    this.readyAt = performance.now() + READY_MS;
    this.publish();
    const token = this.token;
    setTimeout(() => {
      if (token !== this.token || this.state !== 'playing' || this.phase !== 'between' || this.replay) return;
      this.setPhase('aiming');
      this.publish();
    }, READY_MS);
  }

  /** A ball hit the screen (a hit, with how it left the bat where the cameras measured that): the swing, and its replay. */
  swing(hit) {
    const level = LEVELS[this.level];
    const shot = shotFor(hit, aspectOf(), level);
    const replay = replayFor(shot);
    const now = performance.now();
    this.session = addShot(this.session, shot);
    const records = updateBests(this.bests, shot);
    this.newBest = { mph: this.newBest.mph || records.newMph, distance: this.newBest.distance || records.newDistance };
    if (records.newMph) saveBestScore(bestKey(this.level, 'exit-velocity'), records.bests.mph);
    if (records.newDistance) saveBestScore(bestKey(this.level, 'distance'), records.bests.distance);
    this.bests = records.bests;
    this.replay = { replay, t0: now, revealed: false, drewFinal: false };
    this.shown = null;
    this.setPhase('replay');
    // The whole picture changes from here until the replay is over and the camera has settled on it: the ball
    // flies, and the column is filled in. So the next swing can be taken READY_MS after the replay, which is
    // no more than TIMING.budgetMs after the hit.
    this.camera.pictureChangeEverywhere(replay.totalMs);
    this.readyAt = now + replay.totalMs + READY_MS;
    playBatCrack();
    this.publish();
    const token = this.token;
    setTimeout(() => {
      if (token !== this.token || this.state !== 'playing' || this.replay) return;
      this.setPhase('aiming');
      this.publish();
    }, replay.totalMs + READY_MS);
  }

  /** Once a frame while a replay is on. */
  update(now) {
    const play = this.replay;
    if (!play) return;
    const ms = now - play.t0;
    if (!play.revealed && ms >= play.replay.flightMs) this.reveal(play);
    // Every frame of the flight, then the landed picture once.
    if (ms < play.replay.flightMs || !play.drewFinal) {
      play.drewFinal = ms >= play.replay.flightMs;
      this.drawReplay(play.replay, ms);
    }
    if (ms >= play.replay.totalMs) {
      this.replay = null;
      this.setPhase('between');
    }
  }

  /** The ball is down: the call, the numbers, the chart, the session. */
  reveal(play) {
    play.revealed = true;
    this.shown = play.replay;
    const { shot } = play.replay;
    this.renderColumn();
    this.publish();
    if (shot.outcome.id === 'homer') playRoar();
    else if (shot.outcome.id === 'out') playGroan();
    else if (shot.outcome.id === 'foul') playThud();
    else playCheer();
    if (this.newBest.mph && shot.measured && shot.mph === this.bests.mph) playFanfare();
  }

  // ---- Drawing ----

  /** Draws the frames of a replay, one a frame, while there is one. */
  startLoop() {
    const token = this.token;
    const tick = () => {
      if (token !== this.token) return;
      if (this.replay) this.update(performance.now());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** The level being played (or picked), with its fence. */
  fenceOf(level) {
    if (!this.fences.has(level.id)) this.fences.set(level.id, fenceShapes(level));
    return this.fences.get(level.id);
  }

  /** Draws the ballpark from the fixed view, with the shapes `extra` gives for that view added. */
  drawField(extra) {
    const level = LEVELS[this.level];
    fitCanvas(this.scene);
    const aspect = this.scene.width / this.scene.height || 1;
    const view = fieldView(level, aspect);
    drawScene(this.scene.getContext('2d'), makeCamera(view, aspect), {
      figures: restFigures(fieldersOf(level), NO_RUNNERS, { batters: 0 }),
      crowd: { mood: 'still', since: 0 },
      board: { runs: [0], inning: 1, innings: 1, outs: 0 },
      now: performance.now(),
      shapes: [...this.fenceOf(level), ...extra(view)],
    });
    drew(this.scene);
  }

  /** The still picture: the park, and the last shot's trail and marker if there is one. */
  drawStill() {
    const shown = this.shown;
    this.drawField((view) => (shown ? replayShapes(shown, Infinity, view) : []));
  }

  drawReplay(replay, ms) {
    this.drawField((view) => replayShapes(replay, ms, view));
  }

  /** After the window changes size: draw the still picture again. */
  redraw() {
    if (!this.root.classList.contains('active')) return;
    this.camera.pictureChangeEverywhere();
    if (!this.replay) this.drawStill();
    if (!this.column.hidden) this.drawChart();
  }

  // ---- The column ----

  /** Everything in the column, from the session and the last shot shown. */
  renderColumn() {
    const shot = this.shown ? this.shown.shot : null;
    const text = shot ? shotText(shot) : null;
    const set = (selector, value, est = false) => {
      const el = this.root.querySelector(selector);
      el.textContent = value;
      if (est) el.append(estTag());
    };
    this.lastEl.dataset.kind = shot ? shot.outcome.kind : '';
    this.lastEl.dataset.est = shot && !shot.measured ? 'yes' : '';
    this.wordEl.textContent = text ? text.word : BATTING_PRACTICE_TEXT.ready;
    const est = Boolean(text && text.est);
    set('.bp-ev dd', text ? text.ev : '—', est && Boolean(text) && text.ev !== '—');
    set('.bp-launch dd', text ? text.launch : '—', est);
    set('.bp-spray dd', text ? text.spray : '—', est);
    set('.bp-distance dd', text ? text.distance : '—', est);
    set('.bp-hang dd', text ? text.hang : '—', est);
    set('.bp-apex dd', text ? text.apex : '—', est);
    // The distance is how far it carried; where it then rolls well on, that is shown too.
    const total = text && text.total ? ` (rolls to ${text.total})` : '';
    this.root.querySelector('.bp-distance dt').textContent = `Distance${total}`;

    // The session: what was measured, and every swing's outcome.
    const s = summary(this.session);
    const dash = (v, fn) => (v === null ? '—' : fn(v));
    this.root.querySelector('.bp-swings').textContent = String(s.swings);
    this.root.querySelector('.bp-measured').textContent = String(s.measured);
    this.root.querySelector('.bp-avg').textContent = dash(s.avgMph, mphText);
    this.root.querySelector('.bp-max').textContent = dash(s.maxMph, mphText);
    this.root.querySelector('.bp-longest').textContent = dash(s.longest, (v) => `${Math.round(v)} ft`);
    this.root.querySelector('.bp-hard').textContent = dash(s.hardHitPct, (v) => `${v}%`);
    this.root.querySelector('.bp-counts').textContent = OUTCOME_IDS.map((id) => `${OUTCOMES[id]} ${s.counts[id]}`).join(' · ');
    const bests = this.root.querySelector('.bp-bests');
    bests.replaceChildren(`${BATTING_PRACTICE_TEXT.best(this.level)}: `);
    for (const [value, key] of [[this.bests.mph ? mphText(this.bests.mph) : '—', 'mph'], [this.bests.distance ? `${this.bests.distance} ft` : '—', 'distance']]) {
      const span = document.createElement('span');
      span.textContent = value;
      if (this.newBest[key]) {
        span.className = 'bp-new';
        span.append(Object.assign(document.createElement('small'), { textContent: 'new best!' }));
      }
      bests.append(span);
    }

    // The last swings, newest first.
    this.rows.replaceChildren(...recentShots(this.session).map((past) => {
      const t = shotText(past);
      const row = document.createElement('tr');
      row.dataset.outcome = past.outcome.id;
      const cells = [t.word, t.ev, t.launch, t.spray, t.distance].map((value) => {
        const td = document.createElement('td');
        td.textContent = value;
        return td;
      });
      if (t.est) cells[0].append(estTag());
      row.append(...cells);
      return row;
    }));
    this.drawChart();
  }

  /** The top-down spray chart: the level's fence and foul lines, and a dot where each ball of the session came down. */
  drawChart() {
    const canvas = this.chart;
    fitCanvas(canvas);
    const ctx = canvas.getContext('2d');
    const { width: W, height: H } = canvas;
    if (!W || !H) return;
    const level = LEVELS[this.level];
    const at = (p) => [p.x * W, p.y * H];
    ctx.clearRect(0, 0, W, H);
    const lines = chartLines(level);
    // The fair ground, between the foul lines and the fence.
    ctx.beginPath();
    [...lines.foulLeft.slice(0, 1), ...lines.fence, ...lines.foulRight.slice(0, 1)].forEach((p, i) => (i ? ctx.lineTo(...at(p)) : ctx.moveTo(...at(p))));
    ctx.closePath();
    ctx.fillStyle = '#1d4a33';
    ctx.fill();
    // The infield.
    ctx.beginPath();
    ['home', 'first', 'second', 'third'].forEach((b, i) => {
      const p = chartPoint(BASES[b], level);
      return i ? ctx.lineTo(...at(p)) : ctx.moveTo(...at(p));
    });
    ctx.closePath();
    ctx.fillStyle = '#6b4a2b';
    ctx.fill();
    ctx.lineWidth = Math.max(2, W * 0.008);
    ctx.strokeStyle = '#e8e8e8';
    for (const line of [lines.foulLeft, lines.foulRight]) {
      ctx.beginPath();
      line.forEach((p, i) => (i ? ctx.lineTo(...at(p)) : ctx.moveTo(...at(p))));
      ctx.stroke();
    }
    ctx.strokeStyle = '#e0a72a';
    ctx.lineWidth = Math.max(3, W * 0.012);
    ctx.beginPath();
    lines.fence.forEach((p, i) => (i ? ctx.lineTo(...at(p)) : ctx.moveTo(...at(p))));
    ctx.stroke();
    // A dot for each swing, the last one ringed.
    const shots = this.session.shots.filter((s) => this.shown || s !== this.session.shots[this.session.shots.length - 1]);
    shots.forEach((shot, i) => {
      const [x, y] = at(chartPoint(shot.spot, level));
      ctx.beginPath();
      ctx.arc(x, y, W * 0.02, 0, Math.PI * 2);
      ctx.fillStyle = MARKER_COLOURS[shot.outcome.kind];
      ctx.fill();
      ctx.lineWidth = Math.max(2, W * 0.006);
      ctx.strokeStyle = i === shots.length - 1 ? '#ffffff' : '#10131a';
      ctx.stroke();
    });
    drew(canvas);
  }

  // ---- Panels and status ----

  showPanel(title, prompt) {
    this.panel.querySelector('.bp-title').textContent = title;
    this.panel.querySelector('.bp-prompt').textContent = prompt;
    this.panel.hidden = false;
    this.camera.updateExcluded();
  }

  hidePanel() {
    if (this.panel.hidden) return;
    this.panel.hidden = true;
    this.camera.updateExcluded();
  }

  updateStatus() {
    renderGameStatus(this.statusEl, this.camera.note);
  }
}

/** The small "est." that marks a number that was estimated, not measured. */
function estTag() {
  return Object.assign(document.createElement('small'), { className: 'bp-est', textContent: 'est.' });
}

function aspectOf() {
  return window.innerWidth / window.innerHeight;
}

/** Numbers each new drawing on a canvas (data-rev), so a test (or anything copying it) knows when it changed. */
function drew(canvas) {
  canvas.dataset.rev = String(Number(canvas.dataset.rev ?? 0) + 1);
}
