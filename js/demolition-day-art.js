// How Demolition Day looks: the drawing side of the game, kept apart from its
// rules (demolition-day-logic.js) and its flow (demolition-day.js).
//
// - `CityArt` paints each building once as a continuous facade (wall texture
//   for its material, floor bands, windows with frames, a cornice) on an
//   offscreen canvas. What players see is that texture clipped to the cells
//   still standing: the corners of the hidden grid are jittered (the same
//   corners for neighbouring cells, so unbroken walls join up), which makes
//   the edge of a hole ragged. Broken edges get a dark rim, damaged cells
//   cracks and darkening. After a change only the part of the canvas that
//   changed is redrawn (`regionOf`, then `redraw`). A slab that has come loose
//   gets a canvas of its own (`extractSlab`).
// - `Fx` draws the spray of fragments and the dust of a hit, a landing or an
//   explosion, on a transparent canvas over everything.
// - `Rubble` draws the low piles at the foot of the buildings.
//
// Nothing here tells the camera anything: the game calls pictureChange… for
// the rectangle a drawing will change BEFORE it asks for the drawing.

import {
  DEMOLITION_DAY_RULES, cellWidth, seededRandom, vertexJitter, hash01,
} from './demolition-day-logic.js';

const RULES = DEMOLITION_DAY_RULES;

// Mid tones for every material (no white anywhere in the city, so a light ball
// stands out). `rim` is the dark edge of a break; `debris` the colours of the
// fragments it throws out.
export const MATERIALS = {
  wood: { base: '#b9803f', rim: '#4a2c12', debris: ['#b9803f', '#8a5a2a', '#c48d4b', '#4a2c12'] },
  brick: { base: '#b4503a', rim: '#5e2214', debris: ['#b4503a', '#a8452f', '#c25b43', '#6e2a1a'] },
  concrete: { base: '#8c9399', rim: '#3d4348', debris: ['#8c9399', '#767d84', '#979ea4', '#5d646b'] },
  glass: { base: '#2f7f8c', rim: '#143940', debris: ['#3b93a0', '#2f7f8c', '#8fc4cc', '#1b4650'] },
  tnt: { base: '#b3281f', rim: '#3a0b07', debris: ['#b3281f', '#7d1912', '#e0a526', '#4a0f0a'] },
  gold: { base: '#d7a312', rim: '#5a3d05', debris: ['#e8b923', '#bf8a0a', '#e8761a', '#8f6606'] },
};
export const KIND_COLOURS = Object.fromEntries(Object.entries(MATERIALS).map(([kind, m]) => [kind, m.base]));

/** Dust, in mid browns so a light ball stands out against it. */
export const DUST_COLOURS = ['#968870', '#8c7f68', '#a09279', '#847762'];

const CRACK = 'rgba(24, 16, 10, 0.6)';

function canvasOf(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  return canvas;
}

export class CityArt {
  /**
   * @param {HTMLCanvasElement} canvas what players see
   * @param {number} [scale] canvas pixels for each CSS pixel
   */
  constructor(canvas, scale = Math.min(window.devicePixelRatio || 1, 1.5)) {
    this.canvas = canvas;
    this.scale = scale;
    this.rules = RULES;
    this.rev = 0;
    this.grid = null;
    this.original = null;
    this.size();
  }

  /** Sizes everything for the screen as it is now, and forgets the picture. */
  size() {
    this.width = Math.round(window.innerWidth * this.scale);
    this.height = Math.round(window.innerHeight * this.scale);
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d');
    this.texture = canvasOf(this.width, this.height);
    this.tctx = this.texture.getContext('2d');
    this.cw = cellWidth(this.rules) * this.width;
    this.rh = this.rules.rowHeight * this.height;
    this.grid = null;
  }

  // ---- Geometry ----

  /** Pixel x of grid line `i` (0 is the left edge of column 0). */
  gx(i) {
    return (this.rules.left + i * cellWidth(this.rules)) * this.width;
  }

  /** Pixel y of grid line `j` (0 is the ground). */
  gy(j) {
    return (this.rules.ground - j * this.rules.rowHeight) * this.height;
  }

  /** The unjittered rectangle of the cells `row0…row1`, `col0…col1`, in pixels. */
  box(row0, col0, row1, col1) {
    return { x0: this.gx(col0), y0: this.gy(row1 + 1), x1: this.gx(col1 + 1), y1: this.gy(row0) };
  }

  // ---- Painting the facades (once per level) ----

  /**
   * Paints the buildings and bridges of a new city and shows it whole.
   * @param {import('./demolition-day-logic.js').Grid} grid
   * @param {ReturnType<typeof import('./demolition-day-logic.js').buildCity>['buildings']} buildings
   * @param {ReturnType<typeof import('./demolition-day-logic.js').buildCity>['bridges']} [bridges]
   */
  paintLevel(grid, buildings, bridges = []) {
    this.size();
    this.grid = grid;
    this.original = this.occupancy(grid);
    for (const b of buildings) this.paintBuilding(this.tctx, 0, 0, grid, b);
    for (const b of bridges) this.paintBridge(this.tctx, 0, 0, b);
    for (const piece of new Set(grid.cells.flat().filter(Boolean))) {
      if (piece.kind === 'tnt' || piece.kind === 'gold') this.paintSpecial(this.tctx, 0, 0, piece);
    }
    this.redraw({ row0: 0, col0: 0, row1: grid.rows - 1, col1: grid.columns - 1 });
  }

  /** Remembers that these pieces are part of the city as built, so their outline stays straight. */
  markBuilt(pieces) {
    for (const piece of pieces) {
      for (let r = piece.row; r < piece.row + piece.height; r++) {
        for (let c = piece.col; c < piece.col + piece.width; c++) this.original[r * this.grid.columns + c] = 1;
      }
    }
  }

  occupancy(grid) {
    const marks = new Uint8Array(grid.rows * grid.columns);
    grid.cells.forEach((line, r) => line.forEach((piece, c) => { marks[r * grid.columns + c] = piece ? 1 : 0; }));
    return marks;
  }

  /**
   * Paints a prefab chunk (the helicopter's) onto a canvas of its own, or, with `into` null, onto the city's texture.
   * @param {import('./demolition-day-logic.js').Piece[]} pieces
   * @returns {HTMLCanvasElement|null} the chunk, to hang from the helicopter
   */
  paintChunk(pieces, into = null) {
    const row0 = Math.min(...pieces.map((p) => p.row));
    const col0 = Math.min(...pieces.map((p) => p.col));
    const row1 = Math.max(...pieces.map((p) => p.row));
    const col1 = Math.max(...pieces.map((p) => p.col));
    const area = this.box(row0, col0, row1, col1);
    const canvas = into ?? canvasOf(area.x1 - area.x0, area.y1 - area.y0);
    const ctx = canvas === this.texture ? this.tctx : canvas.getContext('2d');
    const [ox, oy] = canvas === this.texture ? [0, 0] : [area.x0, area.y0];
    const cells = pieces.map((p) => ({ row: p.row, col: p.col, kind: p.kind }));
    this.paintMaterials(ctx, ox, oy, cells, area, 7);
    this.paintWindows(ctx, ox, oy, cells);
    // A cornice along the top, so the chunk reads as a piece of wall.
    this.paintLedge(ctx, ox, oy, area.x0, area.x1, area.y0, 0.5);
    return canvas === this.texture ? null : canvas;
  }

  paintBuilding(ctx, ox, oy, grid, b) {
    const area = this.box(0, b.col, b.rows - 1, b.col + b.width - 1);
    const cells = [];
    for (let row = 0; row < b.rows; row++) {
      for (let col = b.col; col < b.col + b.width; col++) {
        const piece = grid.cells[row][col];
        if (piece && piece.building === b.index && piece.kind !== 'tnt' && piece.kind !== 'gold') {
          cells.push({ row, col, kind: piece.kind });
        }
      }
    }
    this.paintMaterials(ctx, ox, oy, cells, area, b.index + 1);
    this.paintWindows(ctx, ox, oy, cells);

    ctx.save();
    ctx.translate(-ox, -oy);
    const x0 = area.x0;
    const x1 = area.x1;
    // Floor bands: a dark line along the top of every floor slab and a shadow under it.
    for (let s = 0; s < b.storeys; s++) {
      const top = this.gy(s * b.storeyRows + b.slabRows);
      const bottom = this.gy(s * b.storeyRows);
      if (s > 0) {
        ctx.fillStyle = 'rgba(30, 22, 16, 0.5)';
        ctx.fillRect(x0, top - 1, x1 - x0, Math.max(1.5, this.rh * 0.12));
        ctx.fillRect(x0, bottom, x1 - x0, Math.max(1.5, this.rh * 0.12));
        ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
        ctx.fillRect(x0, bottom + this.rh * 0.12, x1 - x0, this.rh * 0.35);
      }
    }
    // The door.
    if (b.door) {
      const d = this.box(b.door.row, b.door.col, b.door.row + b.door.h - 1, b.door.col + b.door.w - 1);
      ctx.strokeStyle = '#2b1a0c';
      ctx.lineWidth = Math.max(2, this.rh * 0.22);
      ctx.strokeRect(d.x0 + 1, d.y0 + 1, d.x1 - d.x0 - 2, d.y1 - d.y0 - 2);
      ctx.fillStyle = '#e0a526';
      ctx.beginPath();
      ctx.arc(d.x1 - this.cw * 0.4, (d.y0 + d.y1) / 2, Math.max(1.5, this.cw * 0.12), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    // The roofline.
    this.paintLedge(ctx, ox, oy, x0, x1, this.gy(b.rows - b.roofRows), b.roofRows);
    // The sides of the building are a little darker than the middle.
    ctx.save();
    ctx.translate(-ox, -oy);
    const shade = Math.min(this.cw * 2.5, (x1 - x0) / 3);
    for (const [from, to] of [[x0, x0 + shade], [x1, x1 - shade]]) {
      const g = ctx.createLinearGradient(from, 0, to, 0);
      g.addColorStop(0, 'rgba(0, 0, 0, 0.28)');
      g.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(Math.min(from, to), area.y0, shade, area.y1 - area.y0);
    }
    ctx.restore();
  }

  /**
   * A skybridge across a gap: a concrete floor and roof with a glass band
   * between them, divided by mullions, like an enclosed walkway. Painted
   * as one facade of its own, clipped to its standing cells like a building.
   * @param {ReturnType<typeof import('./demolition-day-logic.js').layoutBridge> & {index: number}} b
   */
  paintBridge(ctx, ox, oy, b) {
    const area = this.box(b.row, b.col, b.row + b.rows - 1, b.col + b.width - 1);
    const cells = [];
    b.kinds.forEach((line, r) => line.forEach((kind, x) => cells.push({ row: b.row + r, col: b.col + x, kind })));
    this.paintMaterials(ctx, ox, oy, cells, area, b.index + 1);

    ctx.save();
    ctx.translate(-ox, -oy);
    const { x0, x1 } = area;
    const glass = this.box(b.glass.row, b.glass.col, b.glass.row + b.glass.h - 1, b.glass.col + b.glass.w - 1);
    // The glass band: a dark frame, and a mullion every few cells.
    const lw = Math.max(1.8, this.rh * 0.2);
    ctx.strokeStyle = '#1b4650';
    ctx.lineWidth = lw;
    ctx.strokeRect(glass.x0 - 1, glass.y0 + lw / 2, glass.x1 - glass.x0 + 2, glass.y1 - glass.y0 - lw);
    ctx.beginPath();
    const step = 3;
    for (let c = b.col + step; c < b.col + b.width; c += step) {
      ctx.moveTo(this.gx(c), glass.y0);
      ctx.lineTo(this.gx(c), glass.y1);
    }
    ctx.stroke();
    // A handrail line along the middle of the glass, and a shadow under the floor.
    ctx.fillStyle = 'rgba(27, 70, 80, 0.55)';
    ctx.fillRect(x0, (glass.y0 + glass.y1) / 2, x1 - x0, Math.max(1.2, this.rh * 0.1));
    ctx.fillStyle = 'rgba(30, 22, 16, 0.5)';
    ctx.fillRect(x0, glass.y1, x1 - x0, Math.max(1.5, this.rh * 0.12));
    ctx.restore();
    // The roof's edge, like a building's cornice.
    this.paintLedge(ctx, ox, oy, x0, x1, this.gy(b.row + b.rows - b.roofRows), b.roofRows);
    // The floor is a little darker underneath, where the walkway hangs over nothing.
    ctx.save();
    ctx.translate(-ox, -oy);
    const g = ctx.createLinearGradient(0, area.y1 - this.rh * b.floorRows, 0, area.y1);
    g.addColorStop(0, 'rgba(0, 0, 0, 0)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0.28)');
    ctx.fillStyle = g;
    ctx.fillRect(x0, area.y1 - this.rh * b.floorRows, x1 - x0, this.rh * b.floorRows);
    ctx.restore();
  }

  /** The cornice: a light edge along the top of the roof row and a dark line under it. */
  paintLedge(ctx, ox, oy, x0, x1, yTop, rows) {
    ctx.save();
    ctx.translate(-ox, -oy);
    ctx.fillStyle = 'rgba(232, 196, 140, 0.32)';
    ctx.fillRect(x0, yTop, x1 - x0, this.rh * 0.3);
    ctx.fillStyle = 'rgba(30, 22, 16, 0.55)';
    ctx.fillRect(x0, yTop + this.rh * rows - 1, x1 - x0, Math.max(1.5, this.rh * 0.14));
    // Little blocks under the edge.
    ctx.fillStyle = 'rgba(30, 22, 16, 0.3)';
    for (let x = x0 + this.cw * 0.5; x < x1 - this.cw; x += this.cw * 1.5) ctx.fillRect(x, yTop + this.rh * 0.3, this.cw * 0.6, this.rh * 0.25);
    ctx.restore();
  }

  /** Each material's pattern, over all the cells of that material at once, so it runs on from cell to cell. */
  paintMaterials(ctx, ox, oy, cells, area, seed) {
    const byKind = new Map();
    for (const cell of cells) {
      if (!byKind.has(cell.kind)) byKind.set(cell.kind, []);
      byKind.get(cell.kind).push(cell);
    }
    ctx.save();
    ctx.translate(-ox, -oy);
    for (const [kind, list] of byKind) {
      ctx.save();
      const path = new Path2D();
      for (const { row, col } of list) {
        const r = this.box(row, col, row, col);
        // A hair wider, so no seams show between cells.
        path.rect(r.x0 - 0.5, r.y0 - 0.5, r.x1 - r.x0 + 1, r.y1 - r.y0 + 1);
      }
      ctx.clip(path);
      this.paintPattern(ctx, kind, area, seededRandom(seed * 31 + kind.length));
      ctx.restore();
    }
    ctx.restore();
  }

  paintPattern(ctx, kind, area, random) {
    const { cw, rh } = this;
    const w = area.x1 - area.x0;
    const h = area.y1 - area.y0;
    if (kind === 'wood') {
      ctx.fillStyle = MATERIALS.wood.base;
      ctx.fillRect(area.x0, area.y0, w, h);
      const plank = rh * 1.25;
      let i = 0;
      for (let y = area.y1; y > area.y0; y -= plank, i++) {
        ctx.fillStyle = ['#c48d4b', '#b57b3b', '#bd8444'][i % 3];
        ctx.fillRect(area.x0, y - plank, w, plank);
        ctx.fillStyle = '#4a2c12';
        ctx.fillRect(area.x0, y - 1, w, Math.max(1.2, rh * 0.1));
        ctx.strokeStyle = 'rgba(110, 70, 30, 0.65)';
        ctx.lineWidth = 1;
        for (let k = 0; k < Math.max(2, w / (cw * 5)); k++) {
          const gx = area.x0 + random() * w;
          const gy = y - plank * (0.25 + random() * 0.5);
          ctx.beginPath();
          ctx.moveTo(gx, gy);
          ctx.quadraticCurveTo(gx + cw * 1.2, gy - rh * 0.15, gx + cw * 2.6, gy);
          ctx.stroke();
        }
        ctx.fillStyle = '#3b2410';
        for (let x = area.x0 + cw * 0.6; x < area.x1; x += cw * 3) ctx.fillRect(x, y - plank * 0.5, 1.8, 1.8);
      }
    } else if (kind === 'brick') {
      ctx.fillStyle = '#c9a58c';
      ctx.fillRect(area.x0, area.y0, w, h);
      const course = rh * 0.5;
      const length = cw * 0.9;
      const tones = ['#b4503a', '#a8452f', '#c25b43', '#b04a36'];
      let c = 0;
      for (let y = area.y1 - course; y > area.y0 - course; y -= course, c++) {
        const shift = c % 2 ? length / 2 : 0;
        for (let x = area.x0 - shift; x < area.x1; x += length) {
          ctx.fillStyle = tones[Math.floor(random() * tones.length)];
          ctx.fillRect(x + 0.6, y + 0.6, length - 1.2, course - 1.2);
        }
      }
    } else if (kind === 'concrete') {
      ctx.fillStyle = MATERIALS.concrete.base;
      ctx.fillRect(area.x0, area.y0, w, h);
      const pw = cw * 4;
      const ph = rh * 3;
      for (let y = area.y1 - ph; y > area.y0 - ph; y -= ph) {
        for (let x = area.x0; x < area.x1; x += pw) {
          ctx.fillStyle = '#979ea4';
          ctx.fillRect(x + 1.5, y + 1.5, pw - 3, ph - 3);
          ctx.strokeStyle = '#5d646b';
          ctx.lineWidth = 1.4;
          ctx.strokeRect(x + 1, y + 1, pw - 2, ph - 2);
          ctx.fillStyle = '#5d646b';
          for (const [bx, by] of [[3.5, 3.5], [pw - 3.5, 3.5], [3.5, ph - 3.5], [pw - 3.5, ph - 3.5]]) {
            ctx.beginPath();
            ctx.arc(x + bx, y + by, 1.1, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.fillStyle = 'rgba(70, 78, 85, 0.5)';
      for (let k = 0; k < (w * h) / 220; k++) ctx.fillRect(area.x0 + random() * w, area.y0 + random() * h, 1.6, 1.6);
    } else if (kind === 'glass') {
      const g = ctx.createLinearGradient(0, area.y0, 0, area.y1);
      g.addColorStop(0, '#3f98a4');
      g.addColorStop(1, '#2a7480');
      ctx.fillStyle = g;
      ctx.fillRect(area.x0, area.y0, w, h);
      ctx.fillStyle = 'rgba(159, 208, 216, 0.3)';
      for (let x = area.x0 - h * 0.3; x < area.x1; x += cw * 5) {
        ctx.beginPath();
        ctx.moveTo(x, area.y1);
        ctx.lineTo(x + cw * 1.2, area.y1);
        ctx.lineTo(x + cw * 1.2 + h * 0.3, area.y0);
        ctx.lineTo(x + h * 0.3, area.y0);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = MATERIALS[kind]?.base ?? '#888';
      ctx.fillRect(area.x0, area.y0, w, h);
    }
  }

  /** Frames, a cross and a sill for every window: a block of glass cells that touch. */
  paintWindows(ctx, ox, oy, cells) {
    const glass = new Map(cells.filter((c) => c.kind === 'glass').map((c) => [`${c.row},${c.col}`, c]));
    const seen = new Set();
    ctx.save();
    ctx.translate(-ox, -oy);
    for (const start of glass.values()) {
      if (seen.has(`${start.row},${start.col}`)) continue;
      let row0 = start.row;
      let row1 = start.row;
      let col0 = start.col;
      let col1 = start.col;
      const stack = [start];
      seen.add(`${start.row},${start.col}`);
      while (stack.length) {
        const { row, col } = stack.pop();
        row0 = Math.min(row0, row);
        row1 = Math.max(row1, row);
        col0 = Math.min(col0, col);
        col1 = Math.max(col1, col);
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const key = `${row + dr},${col + dc}`;
          if (glass.has(key) && !seen.has(key)) {
            seen.add(key);
            stack.push(glass.get(key));
          }
        }
      }
      const a = this.box(row0, col0, row1, col1);
      const lw = Math.max(1.8, this.rh * 0.2);
      ctx.strokeStyle = '#1b4650';
      ctx.lineWidth = lw;
      ctx.strokeRect(a.x0 + lw / 2, a.y0 + lw / 2, a.x1 - a.x0 - lw, a.y1 - a.y0 - lw);
      // Mullions: a cross for a window, a bar every few cells along a curtain wall.
      const step = col1 - col0 + 1 > 6 ? 3 : 0;
      ctx.beginPath();
      if (step) {
        for (let c = col0 + step; c <= col1; c += step) ctx.moveTo(this.gx(c), a.y0), ctx.lineTo(this.gx(c), a.y1);
      } else if (col1 > col0) {
        ctx.moveTo((a.x0 + a.x1) / 2, a.y0);
        ctx.lineTo((a.x0 + a.x1) / 2, a.y1);
      }
      if (row1 > row0 && !step) {
        ctx.moveTo(a.x0, (a.y0 + a.y1) / 2);
        ctx.lineTo(a.x1, (a.y0 + a.y1) / 2);
      }
      ctx.stroke();
      // A sill under a window set in a wall.
      if (!step) {
        ctx.fillStyle = 'rgba(30, 22, 16, 0.55)';
        ctx.fillRect(a.x0 - this.cw * 0.2, a.y1, a.x1 - a.x0 + this.cw * 0.4, Math.max(2, this.rh * 0.3));
      }
    }
    ctx.restore();
  }

  /** TNT crates and gold hard hats: bigger pieces painted over the wall. */
  paintSpecial(ctx, ox, oy, piece) {
    const a = this.box(piece.row, piece.col, piece.row + piece.height - 1, piece.col + piece.width - 1);
    const w = a.x1 - a.x0;
    const h = a.y1 - a.y0;
    ctx.save();
    ctx.translate(-ox, -oy);
    ctx.beginPath();
    ctx.rect(a.x0, a.y0, w, h);
    ctx.clip();
    if (piece.kind === 'tnt') {
      ctx.fillStyle = '#b3281f';
      ctx.fillRect(a.x0, a.y0, w, h);
      ctx.fillStyle = '#a02219';
      ctx.fillRect(a.x0, a.y0, w, h * 0.2);
      ctx.fillRect(a.x0, a.y1 - h * 0.2, w, h * 0.2);
      ctx.fillStyle = 'rgba(125, 25, 18, 0.75)';
      ctx.fillRect(a.x0, a.y0 + h * 0.28, w, h * 0.44);
      ctx.strokeStyle = '#4a0f0a';
      ctx.lineWidth = Math.max(1.5, h * 0.05);
      ctx.strokeRect(a.x0 + 1, a.y0 + 1, w - 2, h - 2);
      ctx.beginPath();
      ctx.moveTo(a.x0, a.y0 + h * 0.2);
      ctx.lineTo(a.x1, a.y0 + h * 0.2);
      ctx.moveTo(a.x0, a.y1 - h * 0.2);
      ctx.lineTo(a.x1, a.y1 - h * 0.2);
      ctx.stroke();
      ctx.fillStyle = '#e8b030';
      ctx.strokeStyle = '#1a1a1a';
      ctx.lineWidth = Math.max(1.5, h * 0.06);
      ctx.font = `900 ${Math.round(h * 0.34)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.strokeText('TNT', (a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2 + h * 0.02);
      ctx.fillText('TNT', (a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2 + h * 0.02);
    } else if (piece.kind === 'gold') {
      const g = ctx.createLinearGradient(0, a.y0, 0, a.y1);
      g.addColorStop(0, '#e8b923');
      g.addColorStop(1, '#bf8a0a');
      ctx.fillStyle = g;
      ctx.fillRect(a.x0, a.y0, w, h);
      ctx.strokeStyle = '#8f6606';
      ctx.lineWidth = Math.max(1.5, h * 0.06);
      ctx.strokeRect(a.x0 + 2, a.y0 + 2, w - 4, h - 4);
      // The hard hat.
      ctx.fillStyle = '#e8761a';
      ctx.strokeStyle = '#1a1a1a';
      ctx.lineWidth = Math.max(1.5, h * 0.06);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x0 + w * 0.2, a.y0 + h * 0.68);
      ctx.quadraticCurveTo(a.x0 + w * 0.2, a.y0 + h * 0.2, a.x0 + w * 0.5, a.y0 + h * 0.2);
      ctx.quadraticCurveTo(a.x0 + w * 0.8, a.y0 + h * 0.2, a.x0 + w * 0.8, a.y0 + h * 0.68);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#c9590c';
      ctx.fillRect(a.x0 + w * 0.14, a.y0 + h * 0.66, w * 0.72, h * 0.12);
      ctx.strokeRect(a.x0 + w * 0.14, a.y0 + h * 0.66, w * 0.72, h * 0.12);
    }
    ctx.restore();
  }

  // ---- Showing the standing cells ----

  /**
   * The area (and the cells) to redraw after `cells` changed: they and a ring
   * of cells round them, whose edges and cracks may change too.
   * @param {{row: number, col: number}[]} cells
   * @returns {{row0: number, col0: number, row1: number, col1: number, rect: import('./demolition-day-logic.js').Rect}}
   */
  regionOf(cells) {
    const { grid } = this;
    const row0 = Math.max(0, Math.min(...cells.map((c) => c.row)) - 1);
    const row1 = Math.min(grid.rows - 1, Math.max(...cells.map((c) => c.row)) + 1);
    const col0 = Math.max(0, Math.min(...cells.map((c) => c.col)) - 1);
    const col1 = Math.min(grid.columns - 1, Math.max(...cells.map((c) => c.col)) + 1);
    const a = this.box(row0, col0, row1, col1);
    const padX = this.cw * 0.5;
    const padY = this.rh * 0.5;
    return {
      row0, col0, row1, col1,
      rect: { x0: (a.x0 - padX) / this.width, y0: (a.y0 - padY) / this.height, x1: (a.x1 + padX) / this.width, y1: (a.y1 + padY) / this.height },
    };
  }

  /** Redraws a region (see `regionOf`) from the texture, the cells standing now and their damage. */
  redraw(region) {
    const { ctx, grid } = this;
    const pad = 2;
    const a = this.box(region.row0, region.col0, region.row1, region.col1);
    const x0 = Math.max(0, Math.floor(a.x0 - this.cw * 0.5 - pad));
    const y0 = Math.max(0, Math.floor(a.y0 - this.rh * 0.5 - pad));
    const x1 = Math.min(this.width, Math.ceil(a.x1 + this.cw * 0.5 + pad));
    const y1 = Math.min(this.height, Math.ceil(a.y1 + this.rh * 0.5 + pad));
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    const label = (r, c) => (grid.cells[r]?.[c] ? 1 : 0);
    // One more ring of cells than the region: their corners reach into it.
    this.paintCells(ctx, 0, 0, Math.max(0, region.row0 - 1), Math.max(0, region.col0 - 1),
      Math.min(grid.rows - 1, region.row1 + 1), Math.min(grid.columns - 1, region.col1 + 1), label, 1);
    ctx.restore();
    this.canvas.dataset.rev = String(++this.rev);
  }

  /** The label of every cell for the vertex rule: 1 standing now, with the grid as it was at the start. */
  mixedAt(i, j, label) {
    const rows = this.grid.rows;
    const cols = this.grid.columns;
    const at = (r, c) => {
      if (c < 0 || c >= cols || r >= rows) return 0;
      return label(Math.max(0, r), c);
    };
    const a = at(j - 1, i - 1);
    const b = at(j - 1, i);
    const c = at(j, i - 1);
    const d = at(j, i);
    return !(a === b && b === c && c === d);
  }

  wasMixedAt(i, j) {
    const rows = this.grid.rows;
    const cols = this.grid.columns;
    const at = (r, c) => (c < 0 || c >= cols || r >= rows ? 0 : this.original[Math.max(0, r) * cols + c]);
    const a = at(j - 1, i - 1);
    const b = at(j - 1, i);
    const c = at(j, i - 1);
    const d = at(j, i);
    return !(a === b && b === c && c === d);
  }

  /**
   * Draws the cells that carry `show` as their label, clipped to the corners
   * of their grid cells (moved where a break has made a new edge), with their
   * damage and the rim of their broken edges.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} ox pixel position of the canvas' top left corner on the screen
   * @param {number} oy
   * @param {(row: number, col: number) => number} label 0 for nothing, 1 for standing, 2 for a slab…
   * @param {number} show the label to draw
   */
  paintCells(ctx, ox, oy, row0, col0, row1, col1, label, show) {
    const { grid } = this;
    const vr = row1 - row0 + 2;
    const vc = col1 - col0 + 2;
    const vx = new Float32Array(vr * vc);
    const vy = new Float32Array(vr * vc);
    const cwn = cellWidth(this.rules);
    for (let jj = 0; jj < vr; jj++) {
      for (let ii = 0; ii < vc; ii++) {
        const i = col0 + ii;
        const j = row0 + jj;
        let x = this.rules.left + i * cwn;
        let y = this.rules.ground - j * this.rules.rowHeight;
        if (this.mixedAt(i, j, label) && !this.wasMixedAt(i, j)) {
          const { dx, dy } = vertexJitter(i, j, this.rules);
          x += dx * cwn;
          y -= dy * this.rules.rowHeight;
        }
        vx[jj * vc + ii] = x * this.width - ox;
        vy[jj * vc + ii] = y * this.height - oy;
      }
    }
    const v = (r, c) => (r - row0) * vc + (c - col0);

    const shape = new Path2D();
    const shown = [];
    for (let r = row0; r <= row1; r++) {
      for (let c = col0; c <= col1; c++) {
        if (label(r, c) !== show) continue;
        shown.push({ r, c });
        shape.moveTo(vx[v(r, c)], vy[v(r, c)]);
        shape.lineTo(vx[v(r, c + 1)], vy[v(r, c + 1)]);
        shape.lineTo(vx[v(r + 1, c + 1)], vy[v(r + 1, c + 1)]);
        shape.lineTo(vx[v(r + 1, c)], vy[v(r + 1, c)]);
        shape.closePath();
      }
    }
    if (!shown.length) return;
    ctx.save();
    ctx.clip(shape);
    ctx.drawImage(this.texture, -ox, -oy);
    ctx.restore();

    // Damage: darker, and cracks, the more the cell has lost.
    ctx.lineWidth = Math.max(1, this.rh * 0.08);
    ctx.lineJoin = 'round';
    for (const { r, c } of shown) {
      const piece = grid.cells[r]?.[c] ?? this.slabPiece?.get(r * grid.columns + c);
      if (!piece || piece.maxHp <= 0) continue;
      const f = 1 - piece.hp / piece.maxHp;
      if (f < 0.2) continue;
      ctx.fillStyle = `rgba(30, 22, 16, ${0.06 + 0.3 * Math.min(1, f)})`;
      ctx.beginPath();
      ctx.moveTo(vx[v(r, c)], vy[v(r, c)]);
      ctx.lineTo(vx[v(r, c + 1)], vy[v(r, c + 1)]);
      ctx.lineTo(vx[v(r + 1, c + 1)], vy[v(r + 1, c + 1)]);
      ctx.lineTo(vx[v(r + 1, c)], vy[v(r + 1, c)]);
      ctx.fill();
      const cx = (vx[v(r, c)] + vx[v(r + 1, c + 1)]) / 2;
      const cy = (vy[v(r, c)] + vy[v(r + 1, c + 1)]) / 2;
      ctx.strokeStyle = CRACK;
      if (f < 0.35 && hash01(r, c, 9) < 0.5) continue;
      for (let k = 0; k < (f < 0.6 ? 1 : 2); k++) {
        const angle = hash01(r, c, 10 + k) * Math.PI;
        const len = this.cw * (0.45 + f * 0.5);
        const bend = (hash01(r, c, 20 + k) - 0.5) * this.rh;
        ctx.beginPath();
        ctx.moveTo(cx - Math.cos(angle) * len, cy - Math.sin(angle) * len * 0.8);
        ctx.lineTo(cx + Math.sin(angle) * bend * 0.4, cy + Math.cos(angle) * bend);
        ctx.lineTo(cx + Math.cos(angle) * len, cy + Math.sin(angle) * len * 0.8);
        ctx.stroke();
      }
    }

    // The rim of every broken edge (not the ground), in the material's dark colour; concrete shows a bit of rebar.
    const rims = new Map();
    const rebar = new Path2D();
    const edge = (kind, r, c, a, b, side) => {
      let path = rims.get(kind);
      if (!path) rims.set(kind, (path = new Path2D()));
      path.moveTo(vx[a], vy[a]);
      path.lineTo(vx[b], vy[b]);
      if (kind === 'concrete' && hash01(r, c, 30 + side) < 0.14) {
        const mx = (vx[a] + vx[b]) / 2;
        const my = (vy[a] + vy[b]) / 2;
        const out = [[0, 1], [0, -1], [-1, 0], [1, 0]][side];
        rebar.moveTo(mx, my);
        rebar.lineTo(mx + out[0] * this.cw * 0.9, my + out[1] * this.rh * 0.9);
      }
    };
    // Only where something was broken off: the outline of the building as built has no rim.
    const broken = (r, c) => r >= 0 && r < grid.rows && c >= 0 && c < grid.columns && this.original[r * grid.columns + c] === 1 && label(r, c) !== show;
    for (const { r, c } of shown) {
      const kind = (grid.cells[r]?.[c] ?? this.slabPiece?.get(r * grid.columns + c))?.kind ?? 'concrete';
      if (broken(r - 1, c)) edge(kind, r, c, v(r, c), v(r, c + 1), 0);
      if (broken(r + 1, c)) edge(kind, r, c, v(r + 1, c), v(r + 1, c + 1), 1);
      if (broken(r, c - 1)) edge(kind, r, c, v(r, c), v(r + 1, c), 2);
      if (broken(r, c + 1)) edge(kind, r, c, v(r, c + 1), v(r + 1, c + 1), 3);
    }
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.4, this.rh * 0.2);
    for (const [kind, path] of rims) {
      ctx.strokeStyle = MATERIALS[kind]?.rim ?? '#222';
      ctx.stroke(path);
    }
    ctx.lineWidth = Math.max(1.2, this.rh * 0.1);
    ctx.strokeStyle = '#8a4a24';
    ctx.stroke(rebar);
  }

  /**
   * A canvas holding a slab's pixels, to fall as one piece. Call it with the
   * slab already out of the grid.
   * @param {import('./demolition-day-logic.js').Slab} slab
   * @returns {{canvas: HTMLCanvasElement, rect: import('./demolition-day-logic.js').Rect}} rect: where it is on screen
   */
  extractSlab(slab) {
    const { grid } = this;
    const own = new Map();
    for (const piece of slab.pieces) for (let r = piece.row; r < piece.row + piece.height; r++) {
      for (let c = piece.col; c < piece.col + piece.width; c++) own.set(r * grid.columns + c, piece);
    }
    this.slabPiece = own;
    const label = (r, c) => (own.has(r * grid.columns + c) ? 2 : grid.cells[r]?.[c] ? 1 : 0);
    const a = this.box(slab.row0, slab.col0, slab.row1, slab.col1);
    const x0 = Math.floor(a.x0 - this.cw);
    const y0 = Math.floor(a.y0 - this.rh);
    const x1 = Math.ceil(a.x1 + this.cw);
    const y1 = Math.ceil(a.y1 + this.rh);
    const canvas = canvasOf(x1 - x0, y1 - y0);
    this.paintCells(canvas.getContext('2d'), x0, y0, Math.max(0, slab.row0 - 1), Math.max(0, slab.col0 - 1),
      Math.min(grid.rows - 1, slab.row1 + 1), Math.min(grid.columns - 1, slab.col1 + 1), label, 2);
    this.slabPiece = null;
    return { canvas, rect: { x0: x0 / this.width, y0: y0 / this.height, x1: x1 / this.width, y1: y1 / this.height } };
  }
}

// ---- Fragments and dust -------------------------------------------------------

/**
 * Sprays of fragments and puffs of dust on a transparent canvas laid over the
 * whole screen. Each one lasts a fixed time and covers a known area, so the
 * game can tell the camera about it before it starts (`area`).
 */
export class Fx {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas, scale = Math.min(window.devicePixelRatio || 1, 1.5)) {
    this.canvas = canvas;
    this.scale = scale;
    this.items = [];
    this.lastBox = null;
    this.size();
  }

  size() {
    this.width = Math.round(window.innerWidth * this.scale);
    this.height = Math.round(window.innerHeight * this.scale);
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d');
    this.items = [];
    this.lastBox = null;
  }

  /**
   * Every place a spray or puff from `x, y` (screen) reaches within its time:
   * `radius` is a fraction of the screen height.
   * @returns {import('./demolition-day-logic.js').Rect}
   */
  static area(x, y, radius) {
    const rx = (radius * window.innerHeight) / window.innerWidth;
    return { x0: x - rx * 1.3, y0: y - radius * 1.3, x1: x + rx * 1.3, y1: y + radius * 1.9 };
  }

  /**
   * A spray of `count` fragments from a point, in these colours, with a puff of dust.
   * @param {object} spray
   * @param {number} spray.x
   * @param {number} spray.y
   * @param {number} spray.radius how far the fragments fly (fraction of the screen height)
   * @param {string[]} spray.colours
   * @param {number} spray.count
   * @param {number} spray.ms how long it lasts
   * @param {number} spray.now
   */
  burst({ x, y, radius, colours, count, ms, now }) {
    const unit = this.height;
    const r = radius * unit;
    const particles = Array.from({ length: count }, (_, k) => {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5;
      const speed = r * (1.4 + Math.random() * 1.6);
      return {
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, size: 2 + Math.random() * (2 + r / 25),
        colour: colours[k % colours.length], spin: (Math.random() - 0.5) * 12, angle: Math.random() * 6,
      };
    });
    this.items.push({ kind: 'spray', x: x * this.width, y: y * unit, r, particles, gravity: r * 3.4, t0: now, ms, area: Fx.area(x, y, radius) });
  }

  /** A puff of dust at a point, growing to `radius` (fraction of the screen height) and fading. */
  dust({ x, y, radius, ms, now }) {
    const blobs = Array.from({ length: 5 }, () => ({
      dx: (Math.random() - 0.5) * 1.2, dy: (Math.random() - 0.7) * 0.8, size: 0.5 + Math.random() * 0.6,
      colour: DUST_COLOURS[Math.floor(Math.random() * DUST_COLOURS.length)],
    }));
    this.items.push({ kind: 'dust', x: x * this.width, y: y * this.height, r: radius * this.height, blobs, t0: now, ms, area: Fx.area(x, y, radius) });
  }

  /** Draws everything alive at `now`, clearing only where it was drawn. */
  update(now) {
    this.items = this.items.filter((it) => now - it.t0 < it.ms);
    if (!this.items.length && !this.lastBox) return;
    const { ctx } = this;
    if (this.lastBox) ctx.clearRect(this.lastBox.x, this.lastBox.y, this.lastBox.w, this.lastBox.h);
    let box = null;
    for (const it of this.items) {
      const t = (now - it.t0) / 1000;
      const life = (now - it.t0) / it.ms;
      if (it.kind === 'spray') {
        for (const p of it.particles) {
          const px = it.x + p.vx * t;
          const py = it.y + p.vy * t + 0.5 * it.gravity * t * t;
          ctx.globalAlpha = Math.min(1, (1 - life) * 3);
          ctx.fillStyle = p.colour;
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(p.angle + p.spin * t);
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
          ctx.restore();
        }
      } else {
        ctx.globalAlpha = 0.65 * (1 - life) ** 1.5;
        for (const b of it.blobs) {
          ctx.fillStyle = b.colour;
          ctx.beginPath();
          ctx.arc(it.x + b.dx * it.r * (0.3 + life), it.y + b.dy * it.r * (0.3 + life), it.r * b.size * (0.25 + 0.75 * life), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      const a = it.area;
      box = box ?? { x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 };
      box = { x0: Math.min(box.x0, a.x0), y0: Math.min(box.y0, a.y0), x1: Math.max(box.x1, a.x1), y1: Math.max(box.y1, a.y1) };
    }
    this.lastBox = box ? { x: box.x0 * this.width, y: box.y0 * this.height, w: (box.x1 - box.x0) * this.width, h: (box.y1 - box.y0) * this.height } : null;
    // Where it is drawn, in CSS pixels, so the end-to-end test's simulated camera can film it.
    this.canvas.dataset.box = box ? [box.x0, box.y0, box.x1, box.y1].map((v) => v.toFixed(4)).join(',') : '';
  }
}

// ---- Rubble -------------------------------------------------------------------

/** Low piles of fragments at the foot of the buildings, drawn on a canvas over the whole screen. */
export class Rubble {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas, scale = Math.min(window.devicePixelRatio || 1, 1.5)) {
    this.canvas = canvas;
    this.scale = scale;
    this.rules = RULES;
    this.size();
  }

  size() {
    this.width = Math.round(window.innerWidth * this.scale);
    this.height = Math.round(window.innerHeight * this.scale);
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d');
    this.piles = Array(this.rules.columns).fill(0);
    /** @type {Record<string, number>[]} how much of each material has gone into each column's pile */
    this.mix = Array.from({ length: this.rules.columns }, () => ({}));
    this.rev = 0;
  }

  /** Adds the colours of demolished cells (`weights`: material → cells) to the piles round column `col`. */
  addMix(col, weights) {
    const kernel = this.rules.rubble.kernel;
    kernel.forEach((share, k) => {
      const c = col + k - (kernel.length >> 1);
      if (c < 0 || c >= this.rules.columns) return;
      for (const [kind, n] of Object.entries(weights)) this.mix[c][kind] = (this.mix[c][kind] ?? 0) + n * share;
    });
  }

  /**
   * The area columns `col0…col1` of the piles cover, grown by one column each way:
   * what to tell the camera before `draw`.
   */
  area(col0, col1) {
    const cw = cellWidth(this.rules);
    const x0 = this.rules.left + Math.max(0, col0 - 1) * cw;
    const x1 = this.rules.left + Math.min(this.rules.columns, col1 + 2) * cw;
    return { x0, x1, y0: this.rules.ground - this.rules.rubble.max - 0.012, y1: this.rules.ground + 0.006 };
  }

  /** Redraws the piles from column `col0` to `col1` (and the one beside each). */
  draw(col0, col1) {
    const { ctx, rules } = this;
    const a = this.area(col0, col1);
    const x0 = Math.floor(a.x0 * this.width);
    const x1 = Math.ceil(a.x1 * this.width);
    const y0 = Math.floor(a.y0 * this.height);
    const y1 = Math.ceil(a.y1 * this.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    const cw = cellWidth(rules) * this.width;
    const base = rules.ground * this.height;
    const first = Math.max(0, col0 - 1);
    const last = Math.min(rules.columns - 1, col1 + 1);
    // The outline of the piles: a height for the middle of each column, with a little unevenness.
    const top = (c) => base - this.piles[c] * this.height * (0.85 + 0.3 * hash01(c, 5, 3));
    const x = (c) => rules.left * this.width + (c + 0.5) * cw;
    ctx.beginPath();
    ctx.moveTo(x(first) - cw, base + 2);
    ctx.lineTo(x(first) - cw, top(first));
    for (let c = first; c <= last; c++) ctx.lineTo(x(c), top(c));
    ctx.lineTo(x(last) + cw, top(last));
    ctx.lineTo(x(last) + cw, base + 2);
    ctx.closePath();
    ctx.fillStyle = '#5b5148';
    ctx.fill();
    ctx.strokeStyle = '#2f2a25';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Fragments in the colours of what the pile is made of.
    for (let c = first; c <= last; c++) {
      const height = base - top(c);
      if (height < 1) continue;
      const kinds = Object.entries(this.mix[c]);
      const total = kinds.reduce((sum, [, n]) => sum + n, 0);
      const bits = Math.round((height * cw) / 9);
      for (let k = 0; k < bits; k++) {
        let pick = hash01(c, k, 9) * (total || 1);
        let kind = 'concrete';
        for (const [name, n] of kinds) {
          pick -= n;
          if (pick <= 0) {
            kind = name;
            break;
          }
        }
        const colours = MATERIALS[kind]?.debris ?? MATERIALS.concrete.debris;
        ctx.fillStyle = colours[Math.floor(hash01(c, k, 11) * colours.length)];
        const size = 2 + hash01(c, k, 13) * 4;
        ctx.save();
        ctx.translate(x(c) + (hash01(c, k, 15) - 0.5) * cw * 1.6, base - hash01(c, k, 17) * height * 0.95);
        ctx.rotate(hash01(c, k, 19) * 3);
        ctx.fillRect(-size / 2, -size / 2, size, size * 0.7);
        ctx.restore();
      }
    }
    ctx.restore();
    this.canvas.dataset.rev = String(++this.rev);
  }
}

