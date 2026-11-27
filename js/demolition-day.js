// Demolition Day: a street of real-looking buildings stands on a construction
// site. Every throw is a little wrecking-ball blast: it blasts a ragged crater
// out of the facade where it landed (a big one in wood and glass, a small one
// in brick, hardly a dent in concrete), blasting chunks of the wall out, and
// cracks the wall around it. Whatever is left without support snaps off as a
// slab, a solid body that tips over the edge it rested on, hinges off the wall
// it was torn from, or drops (demolition-day-physics.js), and breaks into
// chunks where it strikes, which bounce and settle into the rubble. Demolish
// most of the city and the rest collapses in a cloud of dust, and the next,
// harder level starts. There is no clock. Later levels add a
// swinging crane load, balloons carrying crates, and a helicopter that drops
// new chunks of wall on what you knocked down. Everyone throws together for
// one shared score.
//
// Underneath, the city is a fine grid (see demolition-day-logic.js), but
// players never see it: demolition-day-art.js draws the buildings on a canvas
// and redraws only the part that changed.
//
// The city stands perfectly still while it can be hit. Everything that moves
// while players aim (a falling slab, the crane's load, a balloon, the
// helicopter and its chunk) is told to the camera (track): it then looks for
// balls in front of it rather than taking it for a ball. A slab is ragged, so
// the camera follows a few solid rectangles inside it instead, and one that
// turns as it falls is only kept out of the camera's way. Flying chunks are
// worked out in advance, so their whole area is reported before they fly. Everything else
// that appears, changes or vanishes (the city popping in, a crater, a crack,
// the spray of fragments, rubble, a landing, an explosion, the countdown) is
// reported with pictureChange… BEFORE it happens. A hit is checked against
// where things were when the ball landed, not where they are by the time the
// camera reports it.
//
// Games start (and restart) by hitting the big Start crate, so nobody needs
// to walk over to the computer; Enter, Space or a click work too.

import {
  DEMOLITION_DAY_RULES, areaOf, balloonAt, balloonCount, blastAt, breakableCells, buildGrid, buildLevel, cellRect,
  cellUnit, cellWidth, cellsOf, cellsRect, chunkFill, chunkPieces, clearBroken, columnAt, coverWithRects, damageField,
  demolishedPercent, columnCounts, collapse, explode, fallAt, fallMs, findCell, findSlabCell, helicopterAt,
  helicopterEveryMs, isCleared, isNear, landingRow, levelFor, pendulumAt, pickDrop, pieceRect, placePiece, pointsFor,
  resolveThrow, targetPercent, growRubble,
} from './demolition-day-logic.js';
import { CityArt, Fx, KIND_COLOURS, MATERIALS, Rubble } from './demolition-day-art.js';
import {
  blastApart, bodyBox, bodyOf, breakOnImpact, chunkPath, impactBlow, localPoint, planFall, startMotion, stateAt, turns,
} from './demolition-day-physics.js';
import { loadBestScore, saveBestScore } from './storage.js';
import {
  playBeep, playBoom, playCrack, playLevelClear, playPop, playRumble, playSmash, playThud,
  playWhistle,
} from './sound.js';
import { ThrowCamera, rectOf, renderGameStatus } from './throw-camera.js';

export const GAME_ID = 'demolition-day';

const RULES = DEMOLITION_DAY_RULES;

// Animation lengths; these match css/style.css.
const POP_MS = 300; // the city popping in
const START_POP_MS = 300; // the Start crate appearing or bursting
const BOOM_MS = 450; // an explosion's flash
const BLAST_MS = 350; // the flash of a throw
const SPRAY_MS = 550; // the fragments a hit throws out
const DUST_MS = 650; // a dust puff
const STAR_MS = 700; // the stars when the helicopter is hit
const SPLAT_MS = 1200; // the mark left by a miss
const FLOAT_MS = 900; // "+30" floating up from a throw
const COUNT_STEP_MS = 800; // each of 3, 2, 1, Go!
const COLLAPSE_MS = 1300; // what is left sinking into the dust
const POP_BALLOON_MS = 300; // a balloon bursting
// Rubble settles this long after what made it was demolished.
const RUBBLE_DELAY_MS = 450;

// How long the panel shows "Level 3" before the city appears, and "Demolished!"
// before the next level.
const BANNER_MS = 1600;
const CLEARED_MS = 2800;

const SPLAT_RADIUS = 0.035; // fraction of the shorter screen side
const FLOAT_RISE = 0.12; // how far "+30" floats up (same unit)
// The camera picture is a little blurred, so a change spreads slightly beyond
// where it was drawn (fraction of the shorter screen side).
const CHANGE_PAD = 0.015;
// Huge, so anyone can hit it: half the screen wide, nearly a third of its height.
const START_CRATE = { x0: 0.25, y0: 0.47, x1: 0.75, y1: 0.77 };
// A slab is followed by at most this many rectangles; only the roomy ones are watched for balls.
const MAX_TILES = 6;
const WATCH_MIN = { rows: 3, cols: 3 };

const BALLOON_COLOURS = ['#c0392b', '#2471a3', '#27ae60', '#7d3c98', '#d35400'];
const STAR_COLOUR = '#f2c14e';

// The moving targets' sizes. Fractions of the shorter screen side unless noted.
const BALLOON = { r: 0.03, aspect: 1.2, string: 0.016, crate: 0.7 /* of a 4-cell width */, y: 0.165 };
const LOAD = { ball: { w: 0.075, h: 0.075 }, pallet: { w: 0.1, h: 0.06 } };
// The static crane: its tower stands left of the city, its jib runs out over it.
const CRANE = { tower: { x0: 0.006, x1: 0.034, y0: 0.1 }, jib: { x1: 0.52, y0: 0.1, y1: 0.124 }, trolley: { w: 0.03, h: 0.02 } };

export const DEMOLITION_DAY_TEXT = {
  title: 'Demolition Day',
  cleared: 'Demolished!',
  startPrompt: 'Throw a ball at the TNT to start!',
  startLabel: 'START',
  level: (n) => `Level ${n}`,
  best: (score) => `Best score: ${score}`,
  newBest: 'New best score!',
};

export class DemolitionDay {
  /**
   * @param {HTMLElement} root the game's screen element
   * @param {{level?: number}} [options] level: the level to start at
   */
  constructor(root, { level = 1 } = {}) {
    this.root = root;
    this.firstLevel = firstLevelOf(level);
    this.field = root.querySelector('.dd-field');
    this.hud = root.querySelector('.dd-hud');
    this.scoreEl = root.querySelector('.dd-score b');
    this.levelEl = root.querySelector('.dd-level b');
    this.meterEl = root.querySelector('.dd-meter');
    this.meterText = root.querySelector('.dd-meter b');
    this.panel = root.querySelector('.dd-panel');
    this.countdownEl = root.querySelector('.dd-countdown');
    this.bar = root.querySelector('.game-bar');
    this.statusEl = root.querySelector('.game-status');

    // The canvases the city, its rubble and the flying fragments are drawn on (see demolition-day-art.js).
    this.cityEl = canvasElement('dd-city');
    this.rubbleEl = canvasElement('dd-rubble');
    this.fxEl = canvasElement('dd-fx');
    this.art = new CityArt(this.cityEl);
    this.rubble = new Rubble(this.rubbleEl);
    this.fx = new Fx(this.fxEl);

    this.session = 0; // increments when the game starts or stops, so stale timers can tell
    this.round = 0; // increments when a level starts or ends, so stale explosions can tell
    this.state = 'ready'; // 'ready' | 'countdown' | 'between' | 'playing'
    this.startCrate = null; // the Start / Play again crate, when shown
    this.resetCity();
    this.level = this.firstLevel;
    this.score = 0;
    this.best = 0;
    this.lastThudAt = 0;

    this.camera = new ThrowCamera(root, {
      onHit: (hit) => this.throwAt(hit, 'ball', hit.time),
      onNote: () => this.updateStatus(),
      moving: true,
    });
    this.camera.ignore(this.bar, this.hud);

    this.field.addEventListener('click', (e) => {
      this.throwAt({ x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }, 'mouse');
    });
    document.addEventListener('fullscreenchange', () => this.updateStatus());
  }

  /** Forgets the city and everything moving over it. */
  resetCity() {
    this.grid = null;
    // Slabs falling: {cells, pieces, el, tiles, fall, rect, tally}. Others fall too (a crane
    // load, a crate, the helicopter's chunk): {el, fall, landed()}
    this.slabs = new Set();
    this.fallers = [];
    this.gridRev = 0; // goes up whenever cells leave or join the city, so a falling slab knows to look again
    this.nextPieceId = 1;
    this.throwSeq = 0; // numbers the throws and blasts, so craters differ
    this.total = 0; // how many cells the level has to demolish (not counting the helicopter's)
    this.demolished = 0;
    this.exploding = 0; // explosions waiting to go off
    this.buildings = [];
    this.startCounts = [];
    this.pendingRubble = new Map(); // column -> {cells, kinds}
    this.rubbleTimer = 0;
    this.crane = null; // the swinging load: {swing, kind, load, cable}
    this.craneAt = 0; // when the next load is lowered in
    this.balloons = []; // {flight, body, string, crate, crateKind, size}
    this.balloonAt = 0; // when the next balloon floats in
    this.heli = null; // {flight, body, rope, chunk, drop, released, dropTried}
    this.heliAt = 0; // when the next helicopter comes
    this.loads = 0; // how many crane loads there have been, to alternate their kind
    this.balloonsMade = 0; // likewise, to give the balloons different colours
    this.levelInfo = { movers: { crane: false, balloons: false, helicopter: false } };
  }

  /** @param {import('./storage.js').Calibration|null} calibration */
  start(calibration) {
    this.session++;
    this.best = loadBestScore(GAME_ID);
    this.reset();
    this.setState('ready');
    this.showPanel({
      title: DEMOLITION_DAY_TEXT.title,
      best: this.best ? DEMOLITION_DAY_TEXT.best(this.best) : '',
      prompt: DEMOLITION_DAY_TEXT.startPrompt,
    });
    this.showStartCrate(DEMOLITION_DAY_TEXT.startLabel);
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

  /** Enter / Space: start a game, the same as hitting the Start crate. */
  pressStart() {
    if (this.startCrate) this.hitStartCrate();
  }

  reset() {
    this.clearField();
    this.round++;
    this.resetCity();
    this.startCrate = null;
    this.setScore(0);
    this.setLevel(this.firstLevel);
    this.setMeter(0, 0);
    this.syncStats();
    this.panel.hidden = true;
    this.hud.hidden = true;
    this.countdownEl.hidden = true;
    this.camera.updateExcluded();
  }

  /** Wipes the three canvases (and the rubble they remember). The caller has told the camera. */
  clearArt() {
    this.rubble.size();
    this.fx.size();
    for (const el of [this.cityEl, this.rubbleEl, this.fxEl]) {
      el.classList.remove('pop-in', 'collapse');
      el.getContext('2d').clearRect(0, 0, el.width, el.height);
    }
  }

  /** Empties the play area, leaving the three canvases (blank) in it. */
  clearField() {
    this.field.replaceChildren(this.cityEl, this.rubbleEl, this.fxEl);
    for (const el of [this.cityEl, this.rubbleEl, this.fxEl]) {
      el.classList.remove('pop-in', 'collapse');
      el.getContext('2d').clearRect(0, 0, el.width, el.height);
    }
    this.fx.items = [];
    this.fx.lastBox = null;
  }

  setState(state) {
    this.state = state;
    this.root.dataset.state = state;
  }

  /**
   * Shows, as data attributes on the screen, how many cells stand, how many have been demolished and how many
   * there are to demolish (the end-to-end test reads these: the city itself is a picture).
   */
  syncStats() {
    this.root.dataset.standing = String(this.grid ? columnCounts(this.grid).reduce((a, b) => a + b, 0) : 0);
    this.root.dataset.demolished = String(this.demolished);
    this.root.dataset.total = String(this.total);
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
    if (this.state === 'playing') {
      if (this.hitMover(point, time)) return;
      const v = view();
      const cell = findCell(this.grid, point, v);
      let slabHit = null;
      for (const slab of this.slabs) {
        const hit = this.slabHitAt(slab, point, time);
        if (hit && (!slabHit || hit.distance < slabHit.distance)) slabHit = hit;
      }
      if (slabHit && (!cell || slabHit.distance <= cell.distance)) this.shatterSlab(slabHit.slab, point);
      else if (cell) this.hitCity(cell);
      else this.miss(point, source);
    } else if (this.startCrate) {
      if (isNear(START_CRATE, point, view())) this.hitStartCrate();
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

  hitStartCrate() {
    const crate = this.startCrate;
    this.startCrate = null;
    crate.el.classList.add('pop');
    // It bursts bigger than it was.
    this.camera.pictureChange(grow(scaled(START_CRATE, 1.3), CHANGE_PAD), START_POP_MS);
    setTimeout(() => crate.el.remove(), START_POP_MS);
    playSmash();
    this.beginCountdown();
  }

  /**
   * Whether a throw at `point` at `time` hit a falling slab where it was then. One that only drops is where the camera
   * followed it (which is the truth; the game's own plan fills in before that); one that turns is where its plan had
   * it. The point is turned back onto the slab as it stood, and checked against its cells there.
   */
  slabHitAt(slab, point, time) {
    const tile = slab.tiles[0];
    const was = tile && this.camera.whereWas(tile.el, time);
    if (was) return findSlabCell(slab, was.y0 - tile.home.y0, point, view());
    const v = view();
    const s = this.slabStateAt(slab, time);
    const p = localPoint(s, slab.body, point.x * v.width, point.y * v.height);
    return findSlabCell(slab, 0, { x: p.x / v.width, y: p.y / v.height }, v);
  }

  // ---- Damage ----

  /** A throw hit the city: a flash, a crater, and the cracks round it. */
  hitCity(cell) {
    const v = view();
    const tally = this.openTally(cell.impact);
    const flash = this.addRect('dd-blast', circleAround(cell.impact, 0.04));
    flash.dataset.kind = cell.piece.kind;
    this.camera.pictureChange(grow(circleAround(cell.impact, 0.06), CHANGE_PAD), BLAST_MS);
    setTimeout(() => flash.remove(), BLAST_MS);
    const result = resolveThrow(this.grid, cell, ++this.throwSeq, v);
    this.applyResult(result, { tally, origin: cell.impact });
    if (result.broken.length) playSmash();
    else playCrack();
    this.releaseTally(tally);
  }

  /**
   * Shows what a hit, a blast or a landing did: the cells it broke leave the
   * city, the ones it hurt are redrawn, a spray of fragments flies, and the
   * broken pieces score. TNT among them blows up soon after.
   * @param {import('./demolition-day-logic.js').Result} result
   * @param {{tally: object, origin: {x: number, y: number}, boost?: number}} where
   */
  applyResult(result, { tally, origin, boost = 1, power = RULES.throw.power }) {
    const { damaged, broken, explosions } = result;
    // Nothing changed, but this may be the last explosion of a chain, which the city waited for before settling.
    if (!damaged.length && !broken.length) {
      this.settleCity(tally);
      return;
    }
    const region = this.art.regionOf([...damaged, ...broken].flatMap(cellsOf));
    // Reported first: the hole and the cracks, which are drawn straight away, and the spray.
    this.camera.pictureChange(grow(region.rect, CHANGE_PAD), SPRAY_MS);
    clearBroken(this.grid, result);
    if (broken.length) this.gridRev++;
    // What broke is blasted out of the wall in chunks of its own picture.
    const blasted = broken.length ? this.cutOut(broken) : null;
    this.art.redraw(region);
    this.syncStats();
    if (broken.length) this.spray(origin, broken, boost * 0.8);
    if (blasted) {
      const v = view();
      const centre = { x: origin.x * v.width, y: origin.y * v.height };
      this.flyChunks(blasted, blastApart(blasted.body, centre, power, this.throwSeq, v, power > 15 ? 2 : 1.3));
    }
    for (const piece of broken) this.demolish(piece, tally, false);
    for (const piece of explosions) this.queueExplosion(piece, tally);
    this.settleCity(tally);
    this.checkCleared();
  }

  /**
   * Pieces just taken out of the grid, as a body (see demolition-day-physics.js) with their picture, to break into
   * chunks.
   * @param {import('./demolition-day-logic.js').Piece[]} pieces
   */
  cutOut(pieces) {
    const cells = pieces.flatMap(cellsOf);
    const slab = {
      pieces, cells,
      row0: Math.min(...cells.map((c) => c.row)), row1: Math.max(...cells.map((c) => c.row)),
      col0: Math.min(...cells.map((c) => c.col)), col1: Math.max(...cells.map((c) => c.col)),
    };
    return { body: bodyOf(slab, view()), picture: this.art.extractSlab(slab) };
  }

  /**
   * Chunks of a body's picture fly off on their own paths, bounce and come to rest on the ground or the rubble, where
   * the rubble then grows by what they were made of. Reported to the camera first, everywhere they will go.
   * @param {{body: object, picture: {canvas: HTMLCanvasElement, rect: object}}} what
   * @param {import('./demolition-day-physics.js').Chunk[]} chunks
   */
  flyChunks({ body, picture }, chunks) {
    if (!chunks.length) return;
    const v = view();
    const cw = cellWidth() * v.width;
    const floor = (x) => {
      const col = Math.max(0, Math.min(RULES.columns - 1, Math.floor((x / v.width - RULES.left) / cellWidth())));
      return (RULES.ground - this.rubble.piles[col] * 0.85) * v.height;
    };
    const pictures = this.art.cutChunks(picture, body, chunks);
    const pieces = chunks.map((chunk, k) => ({ ...pictures[k], path: chunkPath(chunk, v, floor) }));
    const area = this.fx.chunks(pieces, this.art.width / window.innerWidth, performance.now());
    this.camera.pictureChange(grow(area, CHANGE_PAD), Math.max(...pieces.map((p) => p.path.endT)));
    // Where each comes to rest, the rubble grows (while it fades out).
    chunks.forEach((chunk, k) => {
      const { path } = pieces[k];
      const end = path.points[path.points.length - 1];
      const col = Math.floor((end.x - RULES.left * v.width) / cw);
      if (col < 0 || col >= RULES.columns) return;
      this.queueRubble(col, chunk.kinds, Math.max(0, path.endT - RULES.physics.fadeMs - RUBBLE_DELAY_MS));
    });
  }

  /** Fragments in the colours of what broke, and dust, fly out of a point. */
  spray(point, pieces, boost = 1) {
    const cells = pieces.reduce((n, p) => n + areaOf(p), 0);
    const radius = Math.min(0.2, (0.03 + 0.007 * Math.sqrt(cells)) * boost);
    this.camera.pictureChange(grow(Fx.area(point.x, point.y, radius * 1.2), CHANGE_PAD), SPRAY_MS);
    const kinds = [...new Set(pieces.map((p) => p.kind))];
    const colours = kinds.flatMap((kind) => MATERIALS[kind].debris);
    const now = performance.now();
    this.fx.burst({ x: point.x, y: point.y, radius, colours, count: Math.min(80, 12 + cells), ms: SPRAY_MS, now });
    this.fx.dust({ x: point.x, y: point.y, radius: radius * 1.15, ms: DUST_MS, now });
  }

  /**
   * A piece is demolished: it scores, counts towards the meter and leaves rubble (unless `rubble` is false: its chunks
   * leave it where they come to rest). The caller has drawn it gone.
   */
  demolish(piece, tally, rubble = true) {
    const cells = areaOf(piece);
    if (!piece.extra) this.demolished += cells;
    const points = pointsFor(piece);
    this.setScore(this.score + points);
    tally.points += points;
    this.setMeter(this.demolished, this.total);
    if (rubble) this.queueRubble(piece.col + (piece.width >> 1), { [piece.kind]: cells }, 0);
  }

  /** Rubble of these materials (material → cells) will lie at the foot of column `col`, `delayMs` from now. */
  queueRubble(col, kinds, delayMs) {
    if (delayMs > 0) {
      const { session, round } = this;
      setTimeout(() => {
        if (session === this.session && round === this.round && this.grid) this.queueRubble(col, kinds, 0);
      }, delayMs);
      return;
    }
    const entry = this.pendingRubble.get(col) ?? { cells: 0, kinds: {} };
    for (const [kind, n] of Object.entries(kinds)) {
      entry.cells += n;
      entry.kinds[kind] = (entry.kinds[kind] ?? 0) + n;
    }
    this.pendingRubble.set(col, entry);
    if (!this.rubbleTimer) {
      const { session, round } = this;
      this.rubbleTimer = setTimeout(() => {
        this.rubbleTimer = 0;
        if (session === this.session && round === this.round) this.settleRubble();
      }, RUBBLE_DELAY_MS);
    }
  }

  /** The demolished cells have landed: the piles at the foot of the buildings grow. */
  settleRubble() {
    const pending = this.pendingRubble;
    this.pendingRubble = new Map();
    let first = Infinity;
    let last = -Infinity;
    for (const [col, { cells }] of pending) {
      for (const c of growRubble(this.rubble.piles, col, cells)) {
        first = Math.min(first, c);
        last = Math.max(last, c);
      }
    }
    for (const [col, { kinds }] of pending) this.rubble.addMix(col, kinds);
    if (first > last) return;
    // Reported before it is drawn.
    this.camera.pictureChange(grow(this.rubble.area(first, last), CHANGE_PAD), 0);
    this.rubble.draw(first, last);
  }

  queueExplosion(tnt, tally) {
    this.exploding++;
    this.holdTally(tally);
    const { session, round } = this;
    setTimeout(() => {
      if (session !== this.session || round !== this.round) return;
      this.exploding--;
      const rect = pieceRect(tnt);
      const centre = { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 };
      this.showBoom(centre, RULES.blast.reach);
      this.applyResult(explode(this.grid, tnt, ++this.throwSeq, view()), { tally, origin: centre, boost: 1.6, power: RULES.blast.power });
      this.releaseTally(tally);
    }, RULES.explodeDelayMs);
  }

  /** The flash of an explosion, as big as the crater it makes (`reach`, in cells). */
  showBoom(point, reach) {
    const area = circleAround(point, (reach * cellUnit(view())) / window.innerHeight * 0.8);
    const flash = this.addRect('dd-boom', area);
    this.camera.pictureChange(grow(scaled(area, 1.15), CHANGE_PAD), BOOM_MS);
    setTimeout(() => flash.remove(), BOOM_MS);
    playBoom();
  }

  // ---- Slabs ----

  /**
   * Lets everything without support come loose, and crushes what was left holding up more than it can carry.
   * It waits until the explosions are over.
   */
  settleCity(tally) {
    if (this.exploding || this.state !== 'playing' || !this.grid) return;
    const { slabs, crushed } = collapse(this.grid);
    if (!slabs.length && !crushed.length) return;
    this.gridRev++;
    this.holdTally(tally);
    // Their pictures first (they need the cells as they were), then the hole they leave behind.
    const parts = slabs.map((slab) => ({ slab, ...this.art.extractSlab(slab) }));
    const region = this.art.regionOf([...slabs.flatMap((s) => s.cells), ...crushed.flatMap(cellsOf)]);
    this.camera.pictureChange(grow(region.rect, CHANGE_PAD), SPRAY_MS);
    this.art.redraw(region);
    this.syncStats();
    if (crushed.length) this.crush(crushed, tally);
    for (const { slab, canvas, rect } of parts) {
      if (slab.cells.length < RULES.slabMinCells) this.crumble(slab, { canvas, rect }, tally);
      else this.startSlab(slab, canvas, rect, tally);
    }
    this.releaseTally(tally);
  }

  /**
   * Supports crushed under the weight they held burst where they stood (the caller has drawn them gone): for each
   * pier (they may be far apart under one building), its chunks burst out sideways from under the weight, with dust.
   */
  crush(pieces, tally) {
    const sorted = [...pieces].sort((a, b) => a.col - b.col);
    const piers = [];
    for (const piece of sorted) {
      const last = piers[piers.length - 1];
      if (last && piece.col <= last.col1 + 1) {
        last.pieces.push(piece);
        last.col1 = Math.max(last.col1, piece.col + piece.width - 1);
      } else {
        piers.push({ pieces: [piece], col1: piece.col + piece.width - 1 });
      }
    }
    const v = view();
    for (const pier of piers) {
      const cells = pier.pieces.flatMap(cellsOf);
      const rect = cellsRect(
        Math.min(...cells.map((c) => c.row)), Math.min(...cells.map((c) => c.col)),
        Math.max(...cells.map((c) => c.row)), Math.max(...cells.map((c) => c.col)),
      );
      this.spray({ x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 }, pier.pieces, 1.2);
      // Squeezed from above: out from the top of the pier.
      const cut = this.cutOut(pier.pieces);
      const top = { x: ((rect.x0 + rect.x1) / 2) * v.width, y: rect.y0 * v.height };
      this.flyChunks(cut, blastApart(cut.body, top, 7, ++this.throwSeq, v, 1.4));
    }
    for (const piece of pieces) this.demolish(piece, tally, false);
    this.checkCleared();
  }

  /** A loose bit too small to fall as a slab crumbles where it is: its bits drop away. */
  crumble(slab, picture, tally) {
    const rect = cellsRect(slab.row0, slab.col0, slab.row1, slab.col1);
    const centre = { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 };
    this.spray(centre, slab.pieces, 0.8);
    const v = view();
    const body = bodyOf(slab, v);
    this.flyChunks({ body, picture }, blastApart(body, { x: centre.x * v.width, y: centre.y * v.height }, 1.5, ++this.throwSeq, v, 1));
    for (const piece of slab.pieces) this.demolish(piece, tally, false);
    this.checkCleared();
  }

  /**
   * A slab starts to fall: a canvas of its own, moved as a rigid body (demolition-day-physics.js): it tips over the
   * edge it was left resting on, hinges off the wall it was torn from, or drops. One that only drops is followed by
   * the camera as a few solid rectangles, which it looks for balls in front of; one that turns is just kept out of
   * the camera's way, as the box round it, frame by frame.
   */
  startSlab(slab, canvas, rect, tally) {
    const now = performance.now();
    const v = view();
    const body = bodyOf(slab, v);
    const { state, pivot } = startMotion(this.grid, body, v);
    const plan = planFall(this.grid, body, state, pivot, v);
    const el = this.addRect('dd-slab', rect);
    el.append(canvas);
    // It turns about its centre of mass.
    el.style.transformOrigin = `${body.x0 - rect.x0 * v.width}px ${body.y0 - rect.y0 * v.height}px`;
    const home = cellsRect(slab.row0, slab.col0, slab.row1, slab.col1);
    const turning = turns(plan);
    let tiles = [];
    if (turning) {
      el.dataset.turning = '';
      this.camera.track(el, { shape: 'rect', watch: false });
    } else {
      // The rectangles inside the slab that the camera follows (they move with it, and show nothing).
      tiles = coverWithRects(slab.cells, MAX_TILES).map((t) => {
        const r = cellsRect(t.row0, t.col0, t.row1, t.col1);
        const box = document.createElement('i');
        placeIn(box, r, rect);
        el.append(box);
        return { el: box, home: r, watch: t.row1 - t.row0 + 1 >= WATCH_MIN.rows && t.col1 - t.col0 + 1 >= WATCH_MIN.cols };
      });
      for (const tile of tiles) this.camera.track(tile.el, { shape: 'rect', watch: tile.watch });
    }
    // Reported before it moves: the cells it leaves, and where it will strike (with its dust).
    this.camera.pictureChange(grow(home, CHANGE_PAD), plan.impact.t);
    this.reportImpact(body, plan);
    const slabState = { ...slab, el, tiles, body, pivot: plan.pivot, plan, t0: now, rev: this.gridRev, turning, rect, tally };
    this.slabs.add(slabState);
    this.holdTally(tally);
    playRumble(Math.min(1, slab.cells.length / 400));
  }

  /** Tells the camera about the area a slab will strike and break up in, from now until it does and a little after. */
  reportImpact(body, plan) {
    const v = view();
    const b = bodyBox(body, plan.impact.state);
    const there = { x0: b.x0 / v.width, y0: b.y0 / v.height, x1: b.x1 / v.width, y1: b.y1 / v.height };
    this.camera.pictureChange(grow(scaled(there, 1.2), CHANGE_PAD), Math.max(0, plan.impact.t - (plan.states[0].t)) + SPRAY_MS);
  }

  /** Where a slab is at `time` (ms on the page clock): its state on its plan. */
  slabStateAt(slab, time) {
    return stateAt(slab.plan, time - slab.t0);
  }

  /** Moves what falls: slabs and the other things dropped from the sky. */
  moveFalling(now) {
    const v = view();
    for (const slab of [...this.slabs]) {
      const t = now - slab.t0;
      // The city changed under it: work out the rest of its fall again from where it is.
      if (slab.rev !== this.gridRev && this.grid) {
        slab.rev = this.gridRev;
        const from = stateAt(slab.plan, t);
        const before = slab.plan.impact.t;
        slab.plan = planFall(this.grid, slab.body, from, slab.pivot, v);
        if (Math.abs(slab.plan.impact.t - before) > 5) this.reportImpact(slab.body, slab.plan);
      }
      const s = stateAt(slab.plan, t);
      slab.el.style.transform = `translate(${s.x - slab.body.x0}px, ${s.y - slab.body.y0}px) rotate(${s.angle}rad)`;
      if (t >= slab.plan.impact.t) this.landSlab(slab);
    }
    for (const faller of [...this.fallers]) {
      const { y, landed } = fallAt(faller.fall, now);
      faller.el.style.top = `${y * 100}%`;
      if (landed) {
        this.fallers = this.fallers.filter((f) => f !== faller);
        faller.landed();
      }
    }
  }

  /** Stops following a slab with the camera. */
  untrackSlab(slab) {
    if (slab.turning) this.camera.untrack(slab.el);
    for (const tile of slab.tiles) this.camera.untrack(tile.el);
  }

  /**
   * A slab strikes the ground or the city: it breaks into chunks that carry on with its motion, bounce and scatter,
   * a cloud of dust rolls out, and the cells it struck take a blow as hard as its momentum.
   */
  landSlab(slab) {
    const v = view();
    const { impact } = slab.plan;
    this.slabs.delete(slab);
    this.untrackSlab(slab);
    const point = { x: impact.point.x / v.width, y: impact.point.y / v.height };
    const picture = { canvas: slab.el.querySelector('canvas'), rect: slab.rect };
    this.shatter(slab, point, 1 + Math.min(0.6, impact.momentum / 400));
    this.flyChunks({ body: slab.body, picture }, breakOnImpact(slab.body, impact, ++this.throwSeq, v));
    // A cloud as big as the slab is heavy, rolling out along whatever it struck.
    const size = Math.sqrt(slab.body.mass);
    const width = Math.min(0.3, 0.03 + size * 0.008);
    const height = Math.min(0.09, 0.015 + size * 0.0028);
    const area = this.fx.cloud({ x: point.x, y: point.y, width, height, ms: 1000 + Math.min(900, size * 40), now: performance.now() });
    this.camera.pictureChange(grow(area, CHANGE_PAD), 1000 + Math.min(900, size * 40));
    if (impact.contacts.length && this.grid) {
      const blow = impactBlow(impact);
      const blasts = impact.contacts.map(({ row, col }) => {
        const rect = cellRect(row, col);
        return { x: (rect.x0 + rect.x1) / 2, y: rect.y0, power: blow.power, reach: blow.reach };
      });
      const result = damageField(this.grid, blasts, ++this.throwSeq, v);
      this.applyResult(result, { tally: slab.tally, origin: point, boost: 1.2, power: blow.power });
    }
    this.releaseTally(slab.tally);
    const t = performance.now();
    if (t - this.lastThudAt > 150) playRumble(Math.min(1, slab.cells.length / 300 + impact.speed / 8));
    this.lastThudAt = t;
  }

  /** A slab hit in the air shatters where it is: its chunks fly on with its motion, and out from the hit. */
  shatterSlab(slab, hit) {
    const v = view();
    this.slabs.delete(slab);
    this.untrackSlab(slab);
    const now = performance.now();
    const s = this.slabStateAt(slab, now);
    const rect = rectOf(slab.el);
    const picture = { canvas: slab.el.querySelector('canvas'), rect: slab.rect };
    this.shatter(slab, hit ?? { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 }, 1.2);
    const centre = hit ? { x: hit.x * v.width, y: hit.y * v.height } : { x: s.x, y: s.y };
    const impact = { state: s, point: centre, speed: RULES.physics.blastSpeed, momentum: 0 };
    this.flyChunks({ body: slab.body, picture }, breakOnImpact(slab.body, impact, ++this.throwSeq, v, { bounce: false }));
    this.releaseTally(slab.tally);
    playSmash();
  }

  /** The slab's picture vanishes in a spray and a puff of dust, and its cells are demolished. */
  shatter(slab, point, boost) {
    this.camera.pictureChange(grow(rectOf(slab.el), CHANGE_PAD), SPRAY_MS);
    slab.el.remove();
    this.spray(point, slab.pieces, boost * 0.7);
    for (const piece of slab.pieces) this.demolish(piece, slab.tally, false);
    this.checkCleared();
  }

  // ---- Moving targets ----

  /** Did a throw hit the helicopter, the crane's load or a balloon? Then it has been dealt with. */
  hitMover(point, time) {
    const v = view();
    const { heli } = this;
    if (heli && !heli.flight.fled && !heli.released) {
      const els = [heli.body, heli.chunk.el];
      if (els.some((el) => isNear(this.rectAt(el, time), point, v))) {
        this.chaseHelicopter();
        return true;
      }
    }
    if (this.crane && isNear(this.rectAt(this.crane.load, time), point, v)) {
      this.dropLoad();
      return true;
    }
    for (const balloon of this.balloons) {
      if ([balloon.body, balloon.crate].some((el) => isNear(this.rectAt(el, time), point, v))) {
        this.popBalloon(balloon);
        return true;
      }
    }
    return false;
  }

  /** Where something that moves was at `time`. */
  rectAt(el, time) {
    return this.camera.whereWas(el, time) ?? rectOf(el);
  }

  // The crane

  /** The jib, tower and trolley are drawn once, when the level starts. */
  showCrane() {
    this.addRect('dd-crane-tower', { x0: CRANE.tower.x0, y0: CRANE.tower.y0, x1: CRANE.tower.x1, y1: RULES.ground + 0.02 });
    this.addRect('dd-crane-jib', { x0: CRANE.tower.x0, y0: CRANE.jib.y0, x1: CRANE.jib.x1, y1: CRANE.jib.y1 });
    const { anchorX } = RULES.crane;
    this.addRect('dd-crane-trolley', {
      x0: anchorX - CRANE.trolley.w / 2, y0: CRANE.jib.y1, x1: anchorX + CRANE.trolley.w / 2, y1: CRANE.jib.y1 + CRANE.trolley.h,
    });
    this.craneAt = performance.now() + 500;
  }

  /** The area the load and its cable can be in. */
  swingArea(kind) {
    const { anchorX, anchorY, length, amplitude } = RULES.crane;
    const size = loadSize(kind);
    const reach = (Math.sin(amplitude) * length * window.innerHeight) / window.innerWidth;
    return {
      x0: anchorX - reach - size.w / 2, y0: anchorY, x1: anchorX + reach + size.w / 2, y1: anchorY + length + size.h / 2,
    };
  }

  /** A new load is lowered in and starts to swing. */
  spawnLoad(now) {
    const kind = this.loads++ % 2 ? 'pallet' : 'ball';
    this.camera.pictureChange(grow(this.swingArea(kind), CHANGE_PAD), POP_MS);
    const swing = { ...RULES.crane, phase: Math.random() * 2 * Math.PI, t0: now };
    const load = this.addRect(`dd-load dd-${kind}`, { x0: 0, y0: 0, x1: 0, y1: 0 });
    const cable = this.addRect('dd-cable', {
      x0: swing.anchorX - 0.002, y0: swing.anchorY, x1: swing.anchorX + 0.002, y1: swing.anchorY + swing.length,
    });
    this.crane = { swing, kind, load, cable };
    this.moveCrane(now);
    this.camera.track(load, { shape: kind === 'ball' ? 'ellipse' : 'rect' });
    this.camera.track(cable, { shape: 'rect', watch: false });
  }

  moveCrane(now) {
    const { swing, kind, load, cable } = this.crane;
    const pos = pendulumAt(swing, now, view());
    const size = loadSize(kind);
    placeRect(load, { x0: pos.x - size.w / 2, y0: pos.y - size.h / 2, x1: pos.x + size.w / 2, y1: pos.y + size.h / 2 });
    // The cable is a thin line that turns about the anchor (the only thing that rotates).
    cable.style.transform = `rotate(${-pos.angle}rad)`;
  }

  /** The load was hit: it drops straight down, and blasts a big crater where it lands. */
  dropLoad() {
    const { load, cable } = this.crane;
    this.crane = null;
    this.craneAt = performance.now() + RULES.crane.respawnMs;
    const rect = rectOf(load);
    const landing = this.landingFor(rect);
    const height = rect.y1 - rect.y0;
    const fall = { y0: rect.y0, v0: 0, t0: performance.now(), y1: landing.y - height };
    // The cable lets go; the load (still tracked) falls, and the blast is reported before it lands.
    cable.remove();
    const centre = { x: (rect.x0 + rect.x1) / 2, y: landing.y };
    this.reportBlast(centre, RULES.craneBlast.reach, fallMs(fall.y1 - fall.y0));
    this.fallers.push({
      el: load,
      fall,
      landed: () => {
        if (this.state !== 'playing') return;
        const spot = rectOf(load);
        this.camera.untrack(load);
        load.remove();
        const tally = this.openTally(centre);
        this.showBoom(centre, RULES.craneBlast.reach * 0.8);
        this.spray(centre, [{ kind: 'concrete', width: 1, height: 1 }], 1.2);
        this.floatPoints(spot, RULES.cranePoints, false);
        this.setScore(this.score + RULES.cranePoints);
        this.applyResult(blastAt(this.grid, centre, RULES.craneBlast, ++this.throwSeq, view()), { tally, origin: centre, boost: 1.6, power: RULES.craneBlast.power });
        this.releaseTally(tally);
      },
    });
  }

  /** Where something falling straight down from `rect` comes to rest: the top of the city under it (or the ground). */
  landingFor(rect) {
    const cols = [Math.floor(((rect.x0 - RULES.left) / (RULES.right - RULES.left)) * RULES.columns),
      Math.floor(((rect.x1 - RULES.left) / (RULES.right - RULES.left)) * RULES.columns)];
    const col = Math.max(0, cols[0]);
    const width = Math.max(1, Math.min(RULES.columns - 1, cols[1]) - col + 1);
    const row = landingRow(this.grid, col, width);
    return { row, col, y: cellRect(row, col).y1 };
  }

  /** Tells the camera about the area a blast of `reach` cells at `point` will change. */
  reportBlast(point, reach, delayMs) {
    const radius = (reach * cellUnit(view())) / window.innerHeight;
    this.camera.pictureChange(grow(circleAround(point, radius * 1.3), CHANGE_PAD), delayMs + BOOM_MS + SPRAY_MS);
  }

  // The balloons

  /** A balloon with a crate floats in from one side. */
  spawnBalloon(now) {
    const { balloon: rules } = RULES;
    const dir = Math.random() < 0.5 ? 1 : -1;
    const size = balloonSize();
    const flight = {
      x0: dir > 0 ? -size.w : 1 + size.w, y0: BALLOON.y, dir, bob: rules.bob, bobMs: rules.bobMs,
      speed: rules.speed.min + Math.random() * (rules.speed.max - rules.speed.min),
      phase: Math.random() * 2 * Math.PI, t0: now,
    };
    const crateKind = Math.random() < 0.25 ? 'gold' : 'tnt';
    const zero = { x0: 0, y0: 0, x1: 0, y1: 0 };
    const body = this.addRect('dd-balloon', zero);
    body.style.setProperty('--colour', BALLOON_COLOURS[this.balloonsMade++ % BALLOON_COLOURS.length]);
    const string = this.addRect('dd-string', zero);
    const crate = this.addRect('dd-block dd-crate', zero);
    crate.dataset.kind = crateKind;
    crate.style.setProperty('--colour', KIND_COLOURS[crateKind]);
    const balloon = { flight, body, string, crate, crateKind, size };
    this.balloons.push(balloon);
    this.moveBalloon(balloon, now);
    this.camera.track(body, { shape: 'ellipse' });
    this.camera.track(string, { shape: 'rect', watch: false });
    this.camera.track(crate, { shape: 'rect' });
  }

  moveBalloon(balloon, now) {
    const { x, y } = balloonAt(balloon.flight, now);
    const { w, h, crateW, crateH, string } = balloon.size;
    placeRect(balloon.body, { x0: x - w, y0: y - h, x1: x + w, y1: y + h });
    placeRect(balloon.string, { x0: x - 0.0015, y0: y + h, x1: x + 0.0015, y1: y + h + string });
    placeRect(balloon.crate, { x0: x - crateW / 2, y0: y + h + string, x1: x + crateW / 2, y1: y + h + string + crateH });
  }

  /** A balloon was hit: it bursts, and its crate drops onto the city. */
  popBalloon(balloon) {
    this.balloons = this.balloons.filter((b) => b !== balloon);
    this.balloonAt = performance.now() + randomBetween(RULES.balloon.replaceMs);
    const body = rectOf(balloon.body);
    // It bursts bigger than it was.
    this.camera.pictureChange(grow(scaled(body, 1.8), CHANGE_PAD), POP_BALLOON_MS);
    balloon.body.classList.add('pop');
    setTimeout(() => balloon.body.remove(), POP_BALLOON_MS);
    balloon.string.remove();
    playPop(true);
    this.floatPoints(body, RULES.balloonPoints, false);
    this.setScore(this.score + RULES.balloonPoints);
    this.dropCrate(balloon);
  }

  /** The crate drops straight down from where it hangs. */
  dropCrate({ crate, crateKind }) {
    const rect = rectOf(crate);
    const onCity = columnAt((rect.x0 + rect.x1) / 2) >= 0;
    const landing = onCity ? this.landingFor(rect) : null;
    const height = rect.y1 - rect.y0;
    const fall = { y0: rect.y0, v0: 0, t0: performance.now(), y1: (landing ? landing.y : 1.1) - height };
    const centre = { x: (rect.x0 + rect.x1) / 2, y: landing ? landing.y : 1.1 };
    const ms = fallMs(fall.y1 - fall.y0);
    // Where it lands: the dust, or the blast and the cells it breaks.
    if (onCity) this.reportBlast(centre, crateKind === 'tnt' ? RULES.blast.reach : 2, ms);
    this.fallers.push({
      el: crate,
      fall,
      landed: () => {
        if (this.state !== 'playing') return;
        const spot = rectOf(crate);
        this.camera.untrack(crate);
        crate.remove();
        if (!onCity) return;
        const tally = this.openTally(centre);
        if (crateKind === 'tnt') {
          // It explodes where it lands; the city around it takes the blast.
          this.exploding++;
          const { session, round } = this;
          this.holdTally(tally);
          setTimeout(() => {
            if (session !== this.session || round !== this.round) return;
            this.exploding--;
            this.showBoom(centre, RULES.blast.reach);
            this.applyResult(blastAt(this.grid, centre, RULES.blast, ++this.throwSeq, view()), { tally, origin: centre, boost: 1.6, power: RULES.blast.power });
            this.releaseTally(tally);
          }, RULES.explodeDelayMs);
        } else {
          this.floatPoints(spot, RULES.piecePoints.gold, true);
          this.setScore(this.score + RULES.piecePoints.gold);
        }
        this.releaseTally(tally);
      },
    });
  }

  // The helicopter

  /** The rebuild helicopter flies in with a new chunk of wall for the most damaged building. */
  spawnHelicopter(now) {
    const drop = pickDrop(this.buildings, this.startCounts, this.grid);
    if (!drop) {
      this.heliAt = now + 3000;
      return;
    }
    const { helicopter: rules } = RULES;
    const dir = Math.random() < 0.5 ? 1 : -1;
    const cell = cellRect(0, drop.col + (rules.chunk >> 1));
    const flight = {
      x0: dir > 0 ? -rules.width : 1 + rules.width, dir, speed: rules.speed, targetX: cell.x0,
      hoverMs: rules.hoverMs, y: rules.y, t0: now,
    };
    const zero = { x0: 0, y0: 0, x1: 0, y1: 0 };
    const body = this.addRect(`dd-heli${dir < 0 ? ' flip' : ''}`, zero);
    const rope = this.addRect('dd-rope', zero);
    // The chunk is a small canvas, painted the way the building's wall is.
    const pieces = chunkPieces(drop.type, drop.col, drop.row);
    const picture = this.art.paintChunk(pieces);
    const chunk = { el: this.addRect('dd-slab', zero), pieces, type: drop.type };
    chunk.el.append(picture);
    this.heli = { flight, body, rope, chunk, drop, released: false, dropTried: false };
    this.moveHelicopter(now);
    this.camera.track(body, { shape: 'rect' });
    this.camera.track(rope, { shape: 'rect', watch: false });
    this.camera.track(chunk.el, { shape: 'rect' });
  }

  moveHelicopter(now) {
    const { flight, body, rope, chunk, released } = this.heli;
    const { x, y } = helicopterAt(flight, now);
    const { width, height, rope: ropeLength } = RULES.helicopter;
    placeRect(body, { x0: x - width / 2, y0: y, x1: x + width / 2, y1: y + height });
    if (released) return;
    placeRect(rope, { x0: x - 0.0015, y0: y + height, x1: x + 0.0015, y1: y + height + ropeLength });
    // It hangs the way it will stand: the size of its cells.
    const size = RULES.helicopter.chunk;
    const w = size * (RULES.right - RULES.left) / RULES.columns;
    const h = size * RULES.rowHeight;
    const top = y + height + ropeLength;
    placeRect(chunk.el, { x0: x - w / 2, y0: top, x1: x + w / 2, y1: top + h });
  }

  /** Over the building, the helicopter lets go: the chunk falls and joins the city. */
  releaseChunk() {
    const heli = this.heli;
    heli.dropTried = true;
    const { chunk } = heli;
    const size = RULES.helicopter.chunk;
    const col = heli.drop.col;
    const base = landingRow(this.grid, col, size);
    if (base + size > RULES.maxRows) return; // no room after all: it flies off with it
    heli.released = true;
    heli.rope.remove();
    const rect = rectOf(chunk.el);
    const rest = cellRect(base, col).y1 - size * RULES.rowHeight; // its top edge once it stands
    const fall = { y0: rect.y0, v0: 0, t0: performance.now(), y1: rest };
    const area = cellsRect(base, col, base + size - 1, col + size - 1);
    // Where it lands (with the filling under it, and the dust): reported before it falls.
    this.camera.pictureChange(grow(scaled(area, 1.4), CHANGE_PAD), fallMs(fall.y1 - fall.y0) + SPRAY_MS);
    this.fallers.push({
      el: chunk.el,
      fall,
      landed: () => {
        this.camera.untrack(chunk.el);
        if (this.state !== 'playing') return;
        this.landChunk(chunk, col, base);
      },
    });
    heli.chunk = { ...chunk, el: chunk.el, gone: true };
  }

  /** The chunk reaches the building: its cells (and the filling under them) join the city. */
  landChunk(chunk, col, base) {
    const pieces = [...chunkFill(this.grid, chunk.type, col, base), ...chunkPieces(chunk.type, col, base)];
    const region = this.art.regionOf(pieces.flatMap(cellsOf));
    this.camera.pictureChange(grow(region.rect, CHANGE_PAD), SPRAY_MS);
    for (const piece of pieces) {
      piece.id = this.nextPieceId++;
      placePiece(this.grid, piece);
    }
    this.gridRev++;
    this.art.markBuilt(pieces);
    this.art.paintChunk(pieces, this.art.texture);
    this.art.redraw(region);
    this.syncStats();
    chunk.el.remove();
    const foot = { x: (RULES.left + (col + RULES.helicopter.chunk / 2) * ((RULES.right - RULES.left) / RULES.columns)), y: cellRect(base, col).y1 };
    this.camera.pictureChange(grow(Fx.area(foot.x, foot.y, 0.05), CHANGE_PAD), DUST_MS);
    this.fx.dust({ x: foot.x, y: foot.y, radius: 0.045, ms: DUST_MS, now: performance.now() });
    const now = performance.now();
    if (now - this.lastThudAt > 150) playThud();
    this.lastThudAt = now;
  }

  /** The helicopter was hit before it dropped its chunk: it zooms off upwards, with stars. */
  chaseHelicopter() {
    const heli = this.heli;
    const now = performance.now();
    const pos = helicopterAt(heli.flight, now);
    heli.flight.fled = { t: now, x: pos.x, y: pos.y };
    const rect = rectOf(heli.body);
    this.camera.pictureChange(grow(scaled(rect, 1.6), CHANGE_PAD), STAR_MS);
    for (const [dx, dy] of [[-0.5, 0.1], [0.45, 0.3], [0, -0.35]]) {
      const w = 0.025;
      const h = (w * window.innerWidth) / window.innerHeight;
      const cx = (rect.x0 + rect.x1) / 2 + dx * (rect.x1 - rect.x0);
      const cy = (rect.y0 + rect.y1) / 2 + dy * (rect.y1 - rect.y0);
      const star = this.addRect('dd-star', { x0: cx - w, y0: cy - h, x1: cx + w, y1: cy + h });
      star.style.setProperty('--colour', STAR_COLOUR);
      setTimeout(() => star.remove(), STAR_MS);
    }
    playPop(true);
    this.floatPoints(rect, RULES.helicopterPoints, true);
    this.setScore(this.score + RULES.helicopterPoints);
  }

  removeHelicopter() {
    const { body, rope, chunk } = this.heli;
    body.remove();
    rope.remove();
    if (!chunk.gone) chunk.el.remove();
    this.heli = null;
  }

  /** Every animation frame: moves the crane, balloons and helicopter, and starts new ones. */
  updateMovers(now) {
    const { movers } = this.levelInfo;
    if (movers.crane) {
      if (this.crane) this.moveCrane(now);
      else if (now >= this.craneAt) this.spawnLoad(now);
    }
    if (movers.balloons) {
      for (const balloon of [...this.balloons]) {
        this.moveBalloon(balloon, now);
        const { x } = balloonAt(balloon.flight, now);
        const gone = balloon.flight.dir < 0 ? x < -balloon.size.w * 2 : x > 1 + balloon.size.w * 2;
        if (gone) {
          this.balloons = this.balloons.filter((b) => b !== balloon);
          for (const el of [balloon.body, balloon.string, balloon.crate]) el.remove();
          this.balloonAt = now + randomBetween(RULES.balloon.replaceMs);
        }
      }
      if (this.balloons.length < balloonCount(this.level) && now >= this.balloonAt) {
        this.spawnBalloon(now);
        this.balloonAt = now + randomBetween(RULES.balloon.replaceMs);
      }
    }
    if (movers.helicopter) {
      const heli = this.heli;
      if (heli) {
        this.moveHelicopter(now);
        const pos = helicopterAt(heli.flight, now);
        if (!heli.dropTried && !heli.flight.fled && now >= pos.dropAt) this.releaseChunk();
        if (pos.x < -RULES.helicopter.width * 1.2 || pos.x > 1 + RULES.helicopter.width * 1.2 || pos.y < -0.2) {
          this.removeHelicopter();
          this.heliAt = now + helicopterEveryMs(this.level);
        }
      } else if (now >= this.heliAt) {
        this.spawnHelicopter(now);
      }
    }
  }

  /** Takes the crane's load, the balloons, the helicopter and any slabs in the air away (the caller has reported the change). */
  clearMovers() {
    if (this.crane) {
      this.crane.load.remove();
      this.crane.cable.remove();
      this.crane = null;
    }
    for (const balloon of this.balloons) for (const el of [balloon.body, balloon.string, balloon.crate]) el.remove();
    this.balloons = [];
    if (this.heli) this.removeHelicopter();
    for (const faller of this.fallers) faller.el.remove();
    this.fallers = [];
    for (const slab of this.slabs) slab.el.remove();
    this.slabs.clear();
  }

  // ---- Game flow ----

  beginCountdown() {
    this.setState('countdown');
    // The last game's rubble (left in place behind the results) is cleared away.
    this.camera.pictureChangeEverywhere(COUNT_STEP_MS);
    this.clearArt();
    this.hidePanel();
    this.setScore(0);
    this.setLevel(this.firstLevel);
    this.setMeter(0, 0);
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
      if (i === steps.length - 1) playWhistle();
      else playBeep(false);
      if (i === steps.length - 1) this.beginLevel(this.level);
    }, i * COUNT_STEP_MS));
    setTimeout(() => {
      if (session === this.session) this.countdownEl.hidden = true;
    }, steps.length * COUNT_STEP_MS);
  }

  /** Shows "Level 3" and the level's name, then the city pops in. */
  beginLevel(n) {
    const level = levelFor(n);
    this.round++;
    this.setState('between');
    this.setLevel(n);
    this.setMeter(0, 0);
    this.showPanel({ title: DEMOLITION_DAY_TEXT.level(n), result: level.name });

    const { session, round } = this;
    setTimeout(() => {
      if (session !== this.session || round !== this.round) return;
      this.hidePanel();
      this.showCity(level);
      this.setState('playing');
    }, BANNER_MS);
  }

  /** The city pops in, every building at once. */
  showCity(level) {
    // The last city's remains have long since faded away.
    this.camera.pictureChangeEverywhere(POP_MS);
    this.resetCity();
    this.art.size();
    this.rubble.size();
    this.fx.size();
    this.clearField();
    this.levelInfo = level;
    const { pieces, buildings, bridges } = buildLevel(level);
    this.nextPieceId = pieces.length + 1;
    this.grid = buildGrid(pieces);
    this.total = breakableCells(pieces);
    this.demolished = 0;
    this.buildings = buildings;
    this.startCounts = columnCounts(this.grid);
    this.art.paintLevel(this.grid, buildings, bridges);
    this.setMeter(0, this.total);
    this.syncStats();
    void this.cityEl.offsetWidth; // restarts the animation if the last level's was done
    this.cityEl.classList.add('pop-in');
    const now = performance.now();
    if (level.movers.crane) this.showCrane();
    this.balloonAt = now + 1500;
    this.heliAt = now + helicopterEveryMs(level.n);
  }

  /** Every animation frame: moves what falls and flies. */
  update(now) {
    this.moveFalling(now);
    this.fx.update(now);
    if (this.state !== 'playing') return;
    this.updateMovers(now);
  }

  /** Has enough of the city been demolished, with no explosion still to come? Then the level is won. */
  checkCleared() {
    if (this.state !== 'playing' || this.exploding || !isCleared(this.demolished, this.total)) return;
    this.round++;
    this.setState('between');
    playLevelClear();
    this.collapse();
    // With no clock to end a game, the best score is kept as each level is cleared.
    const isBest = !this.camera.mouseOnly && this.score > this.best;
    if (isBest) {
      this.best = this.score;
      saveBestScore(GAME_ID, this.score);
    }
    this.showPanel({
      title: DEMOLITION_DAY_TEXT.cleared,
      best: isBest ? DEMOLITION_DAY_TEXT.newBest : this.best ? DEMOLITION_DAY_TEXT.best(this.best) : '',
    });
    this.panel.classList.toggle('new-best', isBest);

    const { session, round } = this;
    setTimeout(() => {
      if (session === this.session && round === this.round) this.beginLevel(this.level + 1);
    }, CLEARED_MS);
  }

  /** Everything left sinks into a big cloud of dust, and the moving targets go. */
  collapse() {
    this.camera.pictureChangeEverywhere(COLLAPSE_MS);
    this.clearMovers();
    this.exploding = 0;
    this.cityEl.classList.remove('pop-in');
    void this.cityEl.offsetWidth;
    this.cityEl.classList.add('collapse');
    this.fx.items = [];
    const clouds = Array.from({ length: 9 }, (_, i) => {
      const x = 0.1 + i * 0.1;
      const cloud = this.addRect('dd-cloud', { x0: x - 0.09, y0: 0.62 + (i % 3) * 0.06, x1: x + 0.09, y1: 0.86 + (i % 3) * 0.06 });
      cloud.style.animationDelay = `${(i % 4) * 60}ms`;
      return cloud;
    });
    this.grid = null;
    this.syncStats();
    setTimeout(() => {
      for (const cloud of clouds) cloud.remove();
    }, COLLAPSE_MS);
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

  /** The meter: how much of the level's city is gone, with the target marked. */
  setMeter(demolished, total) {
    const percent = demolishedPercent(demolished, total);
    this.meterText.textContent = String(percent);
    this.meterEl.style.setProperty('--fill', String(percent));
    this.meterEl.style.setProperty('--target', String(targetPercent()));
    this.meterEl.classList.toggle('reached', total > 0 && isCleared(demolished, total));
    this.root.dataset.demolished = String(demolished);
    this.root.dataset.total = String(total);
  }

  showStartCrate(label) {
    const el = this.addRect('dd-block dd-start', START_CRATE);
    el.dataset.kind = 'tnt';
    el.style.setProperty('--colour', KIND_COLOURS.tnt);
    el.append(Object.assign(document.createElement('span'), { textContent: label }));
    // It pops in, springing a little beyond its size first.
    this.camera.pictureChange(grow(scaled(START_CRATE, 1.15), CHANGE_PAD), START_POP_MS);
    this.startCrate = { el };
  }

  // Points: one "+N" for everything a throw did, once all of it has happened (the slabs
  // it brought down have landed, the TNT it set off has gone off).

  /** Starts counting what a throw does. Call `releaseTally` once the throw itself is dealt with. */
  openTally(point) {
    return { points: 0, pending: 1, point };
  }

  holdTally(tally) {
    tally.pending++;
  }

  releaseTally(tally) {
    if (--tally.pending > 0) return;
    if (tally.points > 0) this.floatPoints(tally.point ?? { x: 0.5, y: 0.5 }, tally.points, false);
  }

  /** A "+30" floating up from `where` (a point, or a rectangle's centre). */
  floatPoints(where, points, bright) {
    const centre = 'x0' in where ? { x: (where.x0 + where.x1) / 2, y: (where.y0 + where.y1) / 2 } : where;
    const el = this.addElement('points-pop', centre);
    el.textContent = `+${points}`;
    el.dataset.points = String(points);
    if (bright) el.dataset.ring = '0'; // the big, bright style
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

  /** Adds a box covering `rect` to the screen. */
  addRect(className, rect) {
    const el = document.createElement('div');
    el.className = className;
    placeRect(el, rect);
    this.field.append(el);
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
    set('.dd-title', title);
    set('.dd-result', result);
    set('.dd-best', best);
    set('.dd-prompt', prompt);
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

function canvasElement(className) {
  const canvas = document.createElement('canvas');
  canvas.className = className;
  return canvas;
}

function firstLevelOf(level) {
  return Number.isFinite(level) && level >= 1 ? Math.floor(level) : 1;
}

function randomBetween({ min, max }) {
  return min + Math.random() * (max - min);
}

/** Puts an element over a rectangle (normalised screen coordinates). */
function placeRect(el, rect) {
  el.style.left = `${rect.x0 * 100}%`;
  el.style.top = `${rect.y0 * 100}%`;
  el.style.width = `${(rect.x1 - rect.x0) * 100}%`;
  el.style.height = `${(rect.y1 - rect.y0) * 100}%`;
}

/** Puts an element over a rectangle (normalised screen coordinates), inside `parent`'s rectangle. */
function placeIn(el, rect, parent) {
  const w = parent.x1 - parent.x0;
  const h = parent.y1 - parent.y0;
  el.style.left = `${((rect.x0 - parent.x0) / w) * 100}%`;
  el.style.top = `${((rect.y0 - parent.y0) / h) * 100}%`;
  el.style.width = `${((rect.x1 - rect.x0) / w) * 100}%`;
  el.style.height = `${((rect.y1 - rect.y0) / h) * 100}%`;
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

/** The square round a point that a circle of `radius` (screen heights) fits in. */
function circleAround(point, radius) {
  const rx = (radius * window.innerHeight) / window.innerWidth;
  return { x0: point.x - rx, y0: point.y - radius, x1: point.x + rx, y1: point.y + radius };
}

/** A load's width and height as fractions of the screen. */
function loadSize(kind) {
  const unit = Math.min(window.innerWidth, window.innerHeight);
  return { w: (LOAD[kind].w * unit) / window.innerWidth, h: (LOAD[kind].h * unit) / window.innerHeight };
}

/** A balloon's half width and half height, the length of its string, and its crate's size, as fractions of the screen. */
function balloonSize() {
  const unit = Math.min(window.innerWidth, window.innerHeight);
  const cell = cellRect(0, 0);
  const block = (cell.x1 - cell.x0) * 4;
  return {
    w: (BALLOON.r * unit) / window.innerWidth,
    h: (BALLOON.r * BALLOON.aspect * unit) / window.innerHeight,
    string: (BALLOON.string * unit) / window.innerHeight,
    crateW: block * BALLOON.crate,
    crateH: RULES.rowHeight * 4 * BALLOON.crate,
  };
}
