// Demolition Day rules, kept free of the browser so they can be unit-tested:
// the hidden grid the buildings are made of, how buildings are built from a
// short description, the levels (made by hand, then generated), craters, what
// stands up and what falls, slabs and where they land, TNT, the moving targets'
// paths, rubble, and points.
//
// Positions are normalised screen coordinates (0–1 across and down). Distances
// that should look round on screen (the size of a crater) are measured in
// pixels, from the size of the screen, so the same throw makes the same hole on
// any screen.
//
// A city is a fine grid of cells standing on the ground: 64 across and 36
// high, so a cell is a few pixels. Players never see the grid. Each building is
// drawn as one facade, and a throw blasts a ragged hole out of it. Row 0 is the
// ground row and rows count upwards, because that suits gravity. A cell belongs
// to a `Piece`: most are a single cell, TNT and the gold hard hat are 2×2, and
// a piece breaks, falls or explodes whole. A skybridge between two buildings is
// made of the same single cells (concrete and glass) as the walls.
//
// A throw hits the nearest standing cell, and damage falls off with the
// distance from where it landed, so each material gets a different crater.
// What is left without support (`findLoose`) snaps off as slabs that fall
// straight down and shatter where they land.

/**
 * @typedef {{x:number, y:number}} Point
 * @typedef {{x0:number, y0:number, x1:number, y1:number}} Rect
 * @typedef {{width:number, height:number}} View screen size in pixels
 * @typedef {'wood'|'brick'|'concrete'|'glass'|'tnt'|'gold'} Kind
 * @typedef {object} Piece one or more cells that break, fall or explode together
 * @property {number} id
 * @property {Kind} kind
 * @property {number} row the lowest row it covers (0 is the ground row)
 * @property {number} col the leftmost column it covers
 * @property {number} width how many columns it covers: 1 for most, 2 for TNT and the gold hard hat
 * @property {number} height how many rows it covers
 * @property {number} hp what it has left. At 0 or below, it breaks.
 * @property {number} maxHp what it started with, so the damage taken is `maxHp - hp`
 * @property {number} [building] which structure it belongs to: a building's index in the city's `buildings`, or for
 *   a bridge `buildings.length` plus its index in `bridges`
 * @property {boolean} [extra] added by the helicopter: it has to be smashed too, but doesn't count towards clearing
 * @typedef {{rows: number, columns: number, cells: (Piece|null)[][]}} Grid cells[row][col]
 * @typedef {{row:number, col:number}} Cell
 * @typedef {object} BuildingDesc a building, as levels describe it
 * @property {'shack'|'tenement'|'block'|'tower'} type
 * @property {number} col the column of its left edge
 * @property {number} width
 * @property {number} storeys
 * @property {Kind} [wall] a different material for the walls
 * @property {{storey: number, x: number}[]} [tnt] a 2×2 crate on the floor of storey `storey` (0 is the ground
 *   floor), `x` columns from the building's left edge
 * @property {{storey: number, x: number}[]} [gold] likewise, the 2×2 gold hard hat
 * @property {{row: number}[]} [bridges] skybridges from this building to the next one in the list (the one to its
 *   right): a walkway `BRIDGE_ROWS` tall (concrete floor, glass band, concrete roof) whose floor is at `row` (counted
 *   from the ground), filling the gap between them. All its rows must lie within both buildings' heights.
 * @typedef {object} Level
 * @property {number} n
 * @property {string} name
 * @property {number} timeMs
 * @property {BuildingDesc[]} buildings
 * @property {{crane: boolean, balloons: boolean, helicopter: boolean}} movers
 * @typedef {object} Slab cells that have come loose and fall as one
 * @property {Piece[]} pieces
 * @property {Cell[]} cells every cell of every piece
 * @property {number} row0 the lowest row
 * @property {number} row1 the highest row
 * @property {number} col0
 * @property {number} col1
 * @typedef {object} Result what a throw or an explosion did. Pieces are not removed from the grid:
 *   `clearBroken` does that.
 * @property {Piece[]} damaged pieces that took damage but still stand
 * @property {Piece[]} broken
 * @property {Piece[]} explosions the TNT among `broken`: it blows up too
 */

export const DEMOLITION_DAY_RULES = {
  // The grid: `columns` across from `left` to `right`, up to `maxRows` rows of
  // `rowHeight` standing on the ground line (fractions of the screen). 36 rows
  // end at 0.27, leaving the sky band above for the moving targets (and the
  // score and buttons above that).
  columns: 64,
  maxRows: 36,
  left: 0.04,
  right: 0.96,
  ground: 0.9,
  rowHeight: 0.0175,
  // The corners of the cells are moved by up to this much of a cell (hash of
  // their position), so the edge of a hole is ragged instead of stair-stepped.
  jitter: 0.32,
  // A throw this far from the nearest standing cell (fraction of the screen
  // height) still hits it: forgiving for small players and camera wobble.
  grace: 0.042,
  // The same for the moving targets and the Start crate: as a fraction of the target's height.
  graceRatio: 0.6,

  // Craters. A throw does `power` damage where it lands, falling off in a
  // straight line to nothing at `reach` cells away (a cell here is the average
  // size of a cell on screen, so a crater is round). Each cell takes the
  // damage and compares it with its own material's hit points; what doesn't
  // break it stays as damage (cracks). Every cell's damage is varied by up to
  // `noise` (a fixed number per cell and throw), so the edge is ragged.
  // With these hit points, a direct throw breaks cells out to about this
  // radius (in cells): glass 3.5, wood 3.3, brick 2, TNT 3.5, gold 2.5.
  // Concrete only chips the middle (a lucky cell or two) the first time and
  // cracks the cells round it; it takes a bite of about 2.3 once weakened.
  throw: { power: 10, reach: 5 },
  noise: 0.2,
  // TNT, a crane load and a falling crate: a much bigger crater.
  blast: { power: 28, reach: 9 },
  craneBlast: { power: 30, reach: 10 },
  // A slab landing on standing cells hits the ones under it: `base` plus
  // `perCell` for each cell in the slab (but at most `max`), out to `reach` cells.
  slabImpact: { base: 3, perCell: 0.1, max: 9, reach: 3 },
  // A loose bit smaller than this many cells crumbles at once instead of falling.
  slabMinCells: 3,
  // Hit points to start with.
  hp: { wood: 3.5, glass: 3, brick: 6.5, concrete: 11, tnt: 3, gold: 5 },
  // How far (in cells) a piece may stick out sideways or hang down from
  // structure that is held up before it snaps off. Going up costs nothing, and a
  // piece resting on a held piece is carried by it whatever its own limit.
  maxOverhang: { glass: 1, wood: 3, brick: 4, concrete: 6, tnt: 2, gold: 2 },
  // TNT blows up this long after it breaks, so chains can be seen.
  explodeDelayMs: 150,
  // Points for each cell demolished, by material. TNT and gold score once for the piece.
  cellPoints: { wood: 1, glass: 1, brick: 2, concrete: 3 },
  piecePoints: { tnt: 25, gold: 100 },
  // Points for the moving targets.
  cranePoints: 50,
  balloonPoints: 40,
  helicopterPoints: 75,
  // Clearing a level: points for each second left on the clock.
  timeBonusPerSecond: 10,
  // Demolish this share of the cells (counted when the level starts) and the rest crumbles.
  clearRatio: 0.85,
  // Things fall at this many screen heights per second squared.
  gravity: 4,
  // Rubble piles up at the foot of the buildings: each demolished cell adds
  // `perCell` (screen heights) to the columns around its own, in the shares of
  // `kernel`, and a pile never gets higher than `max`.
  rubble: { max: 0.035, perCell: 0.0016, kernel: [0.1, 0.2, 0.4, 0.2, 0.1] },

  // The crane's swinging load: the anchor is where the cable hangs from the jib
  // (fractions of the screen), `length` is the cable's length (screen heights).
  crane: {
    anchorX: 0.3,
    anchorY: 0.12,
    length: 0.1,
    amplitude: 0.85, // radians either side of straight down
    periodMs: 3200,
    // A new load is lowered in this long after the last one was dropped.
    respawnMs: 6000,
  },
  // The balloons: they drift across the sky band at `speed` screen widths a
  // second, bobbing `bob` (screen heights) up and down every `bobMs`.
  balloon: {
    y: 0.17, // the balloon's centre, in the sky band
    bob: 0.012,
    bobMs: 2600,
    speed: { min: 0.035, max: 0.06 },
    // A new balloon floats in this long after one has gone or been popped.
    replaceMs: { min: 2000, max: 5000 },
    // How many drift about at once: one at first, up to three later.
    maxCount: 3,
  },
  // The rebuild helicopter flies in at `speed` screen widths a second at height `y`
  // (its top edge), hovers over the building it wants to mend, then drops a
  // prefab chunk of wall `chunk` cells wide and high.
  helicopter: {
    y: 0.105,
    // Its size (width as a fraction of the screen width, height as one of the screen height),
    // and the rope the chunk hangs from.
    width: 0.12,
    height: 0.075,
    rope: 0.02,
    speed: 0.14,
    hoverMs: 1500,
    everyMs: { start: 15_000, shrinkPerLevel: 1000, min: 7000 },
    chunk: 4,
  },

  // The generated levels (from level 6 on).
  generator: {
    firstGeneratedLevel: 6,
    // Time: `slack` times the time the throws are expected to take, between
    // `minMs` and `maxMs`, scaled down for every level after the fifth, but never below `floorMs`.
    slack: 1.7,
    minMs: 55_000,
    maxMs: 80_000,
    timeRatioPerLevel: 0.97,
    floorMs: 55_000,
    // Winnable: players are expected to throw about this often, and a throw
    // demolishes about this many cells of each material (including what falls as a result).
    // This is a guess that is a little cautious: a player aiming at random needs about 60% of the throws it allows.
    throwMs: 1500,
    cellsPerThrow: { wood: 30, glass: 30, brick: 11, concrete: 5.5, tnt: 12, gold: 12 },
  },
};

const R = DEMOLITION_DAY_RULES;

/** The kinds of building. Heights are in rows; windows are glass cells in the wall. */
export const BUILDING_TYPES = {
  // A wooden shack: planks, small windows.
  shack: {
    wall: 'wood', slab: 'wood', roof: 'wood', storeyRows: 5, slabRows: 1, roofRows: 1,
    window: { w: 2, h: 2, sill: 1, pitch: 4, margin: 1 }, door: false,
  },
  // A brick tenement: brick walls and floors, a concrete cornice, a wooden door.
  tenement: {
    wall: 'brick', slab: 'brick', roof: 'concrete', storeyRows: 6, slabRows: 1, roofRows: 1,
    window: { w: 2, h: 3, sill: 1, pitch: 4, margin: 1 }, door: true,
  },
  // A concrete block: concrete walls, or a concrete frame (columns at the ends and floor slabs) with other infill.
  block: {
    wall: 'concrete', slab: 'concrete', roof: 'concrete', storeyRows: 6, slabRows: 1, roofRows: 1,
    window: { w: 3, h: 2, sill: 2, pitch: 5, margin: 2 }, door: true, frame: 2,
  },
  // A glass office tower: a curtain wall of glass between concrete columns and floor slabs.
  tower: {
    wall: 'glass', slab: 'concrete', roof: 'concrete', storeyRows: 5, slabRows: 1, roofRows: 1,
    window: null, door: false, frame: 2,
  },
};

/** A repeatable stream of numbers from 0 up to (not including) 1, for a given seed. */
export function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A number from 0 up to (not including) 1 that depends only on `a`, `b` and `c`. */
export function hash01(a, b, c = 0) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * How far the corner where grid lines `i` (across) and `j` (up) meet is moved,
 * in cells (each from -jitter to +jitter). Cells share their corners, so the
 * city stays in one piece. Corners on the ground line move only sideways.
 * @returns {{dx: number, dy: number}}
 */
export function vertexJitter(i, j, rules = R) {
  return {
    dx: (hash01(i, j, 1) * 2 - 1) * rules.jitter,
    dy: j === 0 ? 0 : (hash01(i, j, 2) * 2 - 1) * rules.jitter,
  };
}

// ---- Where things are -------------------------------------------------------

/** The width of one cell (fraction of the screen width). */
export function cellWidth(rules = R) {
  return (rules.right - rules.left) / rules.columns;
}

/** The area of one grid cell. Row 0 stands on the ground line. */
export function cellRect(row, col, rules = R) {
  const width = cellWidth(rules);
  const y1 = rules.ground - row * rules.rowHeight;
  return { x0: rules.left + col * width, y0: y1 - rules.rowHeight, x1: rules.left + (col + 1) * width, y1 };
}

/** The area the cells rows `row0`…`row1` and columns `col0`…`col1` cover. */
export function cellsRect(row0, col0, row1, col1, rules = R) {
  const a = cellRect(row1, col0, rules);
  const b = cellRect(row0, col1, rules);
  return { x0: a.x0, y0: a.y0, x1: b.x1, y1: b.y1 };
}

/** The area the cells of a piece cover. */
export function pieceRect(piece, rules = R) {
  return cellsRect(piece.row, piece.col, piece.row + piece.height - 1, piece.col + piece.width - 1, rules);
}

/** The column under screen position `x`, or -1 if it is outside the grid. */
export function columnAt(x, rules = R) {
  const col = Math.floor(((x - rules.left) / (rules.right - rules.left)) * rules.columns);
  return col >= 0 && col < rules.columns ? col : -1;
}

/** The row at screen position `y` (negative below the ground, above `maxRows` in the sky). */
export function rowAt(y, rules = R) {
  return Math.floor((rules.ground - y) / rules.rowHeight);
}

/** The size of a cell on screen in pixels, on average: the unit craters are measured in. */
export function cellUnit(view, rules = R) {
  return Math.sqrt(cellWidth(rules) * view.width * rules.rowHeight * view.height);
}

/** How far `point` is from a rectangle, in pixels (0 when inside). */
export function distanceToRect(rect, point, view) {
  const dx = Math.max(rect.x0 - point.x, 0, point.x - rect.x1) * view.width;
  const dy = Math.max(rect.y0 - point.y, 0, point.y - rect.y1) * view.height;
  return Math.hypot(dx, dy);
}

/**
 * Is `point` on a rectangle (a moving target, the Start crate), or close enough
 * to count? As close as a throw may be to it, in terms of its height.
 */
export function isNear(rect, point, view, rules = R) {
  return distanceToRect(rect, point, view) <= rules.graceRatio * (rect.y1 - rect.y0) * view.height;
}

/** The point of a rectangle nearest to `point`. */
export function clampToRect(rect, point) {
  return { x: Math.min(rect.x1, Math.max(rect.x0, point.x)), y: Math.min(rect.y1, Math.max(rect.y0, point.y)) };
}

// ---- The grid ---------------------------------------------------------------

/** An empty grid. */
export function createGrid(rules = R) {
  return {
    rows: rules.maxRows,
    columns: rules.columns,
    cells: Array.from({ length: rules.maxRows }, () => Array(rules.columns).fill(null)),
  };
}

/** Puts a piece into the grid, in the cells it covers. Throws if one is taken. */
export function placePiece(grid, piece) {
  for (let r = piece.row; r < piece.row + piece.height; r++) {
    for (let c = piece.col; c < piece.col + piece.width; c++) {
      if (!grid.cells[r] || c < 0 || c >= grid.columns) throw new Error(`cell ${r},${c} is outside the grid`);
      if (grid.cells[r][c]) throw new Error(`cell ${r},${c} is taken`);
    }
  }
  for (let r = piece.row; r < piece.row + piece.height; r++) {
    for (let c = piece.col; c < piece.col + piece.width; c++) grid.cells[r][c] = piece;
  }
}

export function removePiece(grid, piece) {
  for (let r = piece.row; r < piece.row + piece.height; r++) {
    for (let c = piece.col; c < piece.col + piece.width; c++) {
      if (grid.cells[r]?.[c] === piece) grid.cells[r][c] = null;
    }
  }
}

/** A grid holding these pieces. */
export function buildGrid(pieces, rules = R) {
  const grid = createGrid(rules);
  for (const piece of pieces) placePiece(grid, piece);
  return grid;
}

/** Every piece in the grid once. */
export function piecesIn(grid) {
  const seen = new Set();
  for (const row of grid.cells) for (const piece of row) if (piece) seen.add(piece);
  return [...seen];
}

/** The cells a piece covers. */
export function cellsOf(piece) {
  const cells = [];
  for (let row = piece.row; row < piece.row + piece.height; row++) {
    for (let col = piece.col; col < piece.col + piece.width; col++) cells.push({ row, col });
  }
  return cells;
}

/** How many cells a piece covers. */
export function areaOf(piece) {
  return piece.width * piece.height;
}

/** The row of the highest piece in a column, or -1 if it is empty. */
export function topRow(grid, col) {
  for (let r = grid.rows - 1; r >= 0; r--) if (grid.cells[r][col]) return r;
  return -1;
}

/** How many rows a column is tall (counting from the ground to its highest piece). */
export function heightOf(grid, col) {
  return topRow(grid, col) + 1;
}

/** How many rows each column is tall now. */
export function heights(grid) {
  return Array.from({ length: grid.columns }, (_, col) => heightOf(grid, col));
}

/** How many cells stand in each column (holes included: a column with a hole in it counts fewer). */
export function columnCounts(grid) {
  const counts = Array(grid.columns).fill(0);
  for (const line of grid.cells) line.forEach((piece, col) => { if (piece) counts[col]++; });
  return counts;
}

/** The row a block dropped onto these columns comes to rest in. */
export function landingRow(grid, col, width = 1) {
  let row = 0;
  for (let c = col; c < col + width; c++) if (c >= 0 && c < grid.columns) row = Math.max(row, heightOf(grid, c));
  return row;
}

/**
 * How many cells there are to demolish: all of them, not counting those the
 * helicopter has added.
 */
export function breakableCells(pieces) {
  return pieces.reduce((sum, p) => (!p.extra ? sum + areaOf(p) : sum), 0);
}

// ---- Buildings --------------------------------------------------------------

/**
 * Lays out one building: the kind of every cell, relative to its lower left
 * corner, and where the windows and the door are.
 * @param {BuildingDesc} desc
 * @returns {{type: string, col: number, width: number, storeys: number, rows: number, wall: Kind, slab: Kind,
 *   roof: Kind, storeyRows: number, slabRows: number, roofRows: number, kinds: (Kind|null)[][],
 *   windows: {row: number, col: number, w: number, h: number}[], door: {row: number, col: number, w: number, h: number}|null}}
 *   `kinds[row][col]`; windows and the door in absolute rows and columns
 */
export function layoutBuilding(desc) {
  const type = BUILDING_TYPES[desc.type];
  if (!type) throw new Error(`unknown building type ${desc.type}`);
  const { width, storeys } = desc;
  const wall = desc.wall ?? type.wall;
  const rows = storeys * type.storeyRows + type.roofRows;
  const kinds = Array.from({ length: rows }, () => Array(width).fill(wall));
  const windows = [];
  let door = null;
  const frame = type.frame && (desc.type === 'tower' || wall !== type.wall || desc.frame) ? type.frame : 0;
  // A frame: columns at both ends (and floors, which every building has).
  if (frame) for (const row of kinds) for (let x = 0; x < frame; x++) row[x] = row[width - 1 - x] = type.slab;
  for (let s = 0; s < storeys; s++) {
    const base = s * type.storeyRows;
    for (let r = base; r < base + type.slabRows; r++) kinds[r].fill(type.slab);
    const wallBase = base + type.slabRows;
    const wallRows = type.storeyRows - type.slabRows;
    if (desc.type === 'tower') {
      // The curtain wall: glass from column to column.
      for (let r = wallBase; r < wallBase + wallRows; r++) for (let x = frame; x < width - frame; x++) kinds[r][x] = 'glass';
      windows.push({ row: wallBase, col: desc.col + frame, w: width - 2 * frame, h: wallRows });
      continue;
    }
    const w = type.window;
    const count = Math.max(0, Math.floor((width - 2 * w.margin - w.w) / w.pitch) + 1);
    const span = (count - 1) * w.pitch + w.w;
    const start = Math.floor((width - span) / 2);
    for (let k = 0; k < count; k++) {
      const x = start + k * w.pitch;
      // The door takes the place of the middle window of the ground floor.
      if (type.door && s === 0 && Math.abs(x + w.w / 2 - width / 2) <= w.pitch / 2) {
        const dw = 2;
        const dx = Math.floor((width - dw) / 2);
        for (let r = wallBase; r < wallBase + 3; r++) for (let c = dx; c < dx + dw; c++) kinds[r][c] = 'wood';
        door = { row: wallBase, col: desc.col + dx, w: dw, h: 3 };
        continue;
      }
      for (let r = wallBase + w.sill; r < wallBase + w.sill + w.h; r++) for (let c = x; c < x + w.w; c++) kinds[r][c] = 'glass';
      windows.push({ row: wallBase + w.sill, col: desc.col + x, w: w.w, h: w.h });
    }
  }
  kinds[rows - 1].fill(type.roof);
  return {
    type: desc.type, col: desc.col, width, storeys, rows, wall, slab: type.slab, roof: type.roof,
    storeyRows: type.storeyRows, slabRows: type.slabRows, roofRows: type.roofRows, kinds, windows, door,
  };
}

/**
 * How many rows tall a skybridge is: a concrete floor, a band of glass, a concrete roof. A storey of a
 * block or a tenement, so a bridge whose floor is on a storey's floor reads as a corridor between them.
 */
export const BRIDGE_ROWS = 6;
const BRIDGE_FLOOR_ROWS = 1;
const BRIDGE_ROOF_ROWS = 1;

/**
 * Lays out a skybridge: an enclosed walkway across a gap, from row `row` up.
 * @param {number} row the row of its floor
 * @param {number} col its leftmost column (the first one past the building on its left)
 * @param {number} width how many columns it spans
 * @returns {{row: number, col: number, width: number, rows: number, floorRows: number, roofRows: number,
 *   kinds: Kind[][], glass: {row: number, col: number, w: number, h: number}}} `kinds[row][x]`, relative to its lower left corner
 */
export function layoutBridge(row, col, width) {
  const kinds = Array.from({ length: BRIDGE_ROWS }, (_, r) => Array(width).fill(
    r < BRIDGE_FLOOR_ROWS || r >= BRIDGE_ROWS - BRIDGE_ROOF_ROWS ? 'concrete' : 'glass',
  ));
  return {
    row, col, width, rows: BRIDGE_ROWS, floorRows: BRIDGE_FLOOR_ROWS, roofRows: BRIDGE_ROOF_ROWS, kinds,
    glass: { row: row + BRIDGE_FLOOR_ROWS, col, w: width, h: BRIDGE_ROWS - BRIDGE_FLOOR_ROWS - BRIDGE_ROOF_ROWS },
  };
}

/** The row on which things stand in a building's storey (above its floor). */
export function storeyFloorRow(desc, storey) {
  const type = BUILDING_TYPES[desc.type];
  return storey * type.storeyRows + type.slabRows;
}

/**
 * Builds a city from building descriptions: the pieces, and each building's layout.
 * Throws if a building doesn't fit the grid.
 * @param {BuildingDesc[]} descs
 * @returns {{pieces: Piece[], buildings: ReturnType<typeof layoutBuilding>[], bridges: ReturnType<typeof layoutBridge>[]}}
 *   pieces from the ground up and left to right, with unique ids; each bridge also has an `index` (the
 *   `building` of its pieces, counted on from the last building)
 */
export function buildCity(descs, rules = R) {
  const buildings = descs.map((desc, index) => ({ ...layoutBuilding(desc), index }));
  const bridges = [];
  descs.forEach((desc, i) => {
    for (const { row } of desc.bridges ?? []) {
      const next = buildings[i + 1];
      if (!next) throw new Error(`building ${i} has a bridge but no building to its right`);
      const col = desc.col + desc.width;
      const width = next.col - col;
      if (width < 1) throw new Error(`the bridge from building ${i} has no gap to cross`);
      if (row < 1 || row + BRIDGE_ROWS > Math.min(buildings[i].rows, next.rows)) {
        throw new Error(`the bridge from building ${i} is not inside both buildings`);
      }
      bridges.push({ ...layoutBridge(row, col, width), index: buildings.length + bridges.length });
    }
  });
  /** The kind of every cell, or a piece for the cells of a piece bigger than one cell. */
  const map = Array.from({ length: rules.maxRows }, () => Array(rules.columns).fill(null));
  for (const b of buildings) {
    if (b.col < 0 || b.col + b.width > rules.columns) throw new Error(`building ${b.index} is outside the grid`);
    if (b.rows > rules.maxRows) throw new Error(`building ${b.index} is too tall`);
    b.kinds.forEach((line, row) => line.forEach((kind, x) => {
      if (map[row][b.col + x]) throw new Error(`building ${b.index} overlaps another`);
      map[row][b.col + x] = { kind, building: b.index };
    }));
  }
  for (const b of bridges) {
    b.kinds.forEach((line, r) => line.forEach((kind, x) => {
      if (map[b.row + r][b.col + x]) throw new Error(`bridge ${b.index} overlaps a building`);
      map[b.row + r][b.col + x] = { kind, building: b.index };
    }));
  }
  const specials = [];
  const put = (kind, building, row, col, width, height) => {
    if (row < 0 || col < 0 || col + width > rules.columns || row + height > rules.maxRows) return;
    for (let r = row; r < row + height; r++) for (let c = col; c < col + width; c++) if (map[r][c]?.special) return;
    const hp = rules.hp[kind] ?? 0;
    const piece = { id: 0, kind, row, col, width, height, hp, maxHp: hp, building };
    for (let r = row; r < row + height; r++) for (let c = col; c < col + width; c++) map[r][c] = { special: piece };
    specials.push(piece);
  };
  descs.forEach((desc, index) => {
    for (const t of desc.tnt ?? []) put('tnt', index, storeyFloorRow(desc, t.storey), desc.col + t.x, 2, 2);
    for (const g of desc.gold ?? []) put('gold', index, storeyFloorRow(desc, g.storey), desc.col + g.x, 2, 2);
  });
  const pieces = [...specials];
  for (let row = 0; row < rules.maxRows; row++) {
    for (let col = 0; col < rules.columns; col++) {
      const entry = map[row][col];
      if (!entry || entry.special) continue;
      const hp = rules.hp[entry.kind];
      pieces.push({ id: 0, kind: entry.kind, row, col, width: 1, height: 1, hp, maxHp: hp, building: entry.building });
    }
  }
  pieces.sort((a, b) => a.row - b.row || a.col - b.col);
  pieces.forEach((piece, i) => { piece.id = i + 1; });
  return { pieces, buildings, bridges };
}

// ---- Clearing a level -------------------------------------------------------

/** How many cells have to be demolished for a level to count as cleared (`clearRatio` of the breakable ones). */
export function clearTarget(breakableCount, rules = R) {
  return Math.ceil(breakableCount * rules.clearRatio - 1e-9);
}

/** Has the level been cleared, with this many of its `breakableCount` cells demolished? */
export function isCleared(demolished, breakableCount, rules = R) {
  return breakableCount > 0 && demolished >= clearTarget(breakableCount, rules);
}

/** How much of the city is gone, as a whole percentage for the meter (never more than 100). */
export function demolishedPercent(demolished, breakableCount) {
  if (breakableCount <= 0) return 0;
  return Math.min(100, Math.floor((demolished / breakableCount) * 100 + 1e-9));
}

/** Where the target is marked on the meter, as a whole percentage. */
export function targetPercent(rules = R) {
  return Math.round(rules.clearRatio * 100);
}

// ---- Finding what a throw hits ----------------------------------------------

/** How many cells round a point a throw can reach, with the grace distance. */
function graceWindow(view, rules) {
  const reachCols = Math.ceil((rules.grace * view.height) / (cellWidth(rules) * view.width)) + 1;
  const reachRows = Math.ceil((rules.grace * view.height) / (rules.rowHeight * view.height)) + 1;
  return { reachCols, reachRows };
}

/**
 * The cell a throw hits: the nearest standing one, if it is close enough.
 * Throws into holes hit the nearest cell around them. Equally near: the lowest, then the leftmost.
 * @param {Grid} grid
 * @returns {{piece: Piece, row: number, col: number, distance: number, impact: Point}|null}
 *   distance in pixels; impact: where on the cell the throw is taken to land
 */
export function findCell(grid, point, view, rules = R) {
  const col0 = Math.floor(((point.x - rules.left) / (rules.right - rules.left)) * rules.columns);
  const row0 = rowAt(point.y, rules);
  const { reachCols, reachRows } = graceWindow(view, rules);
  let best = null;
  for (let row = Math.max(0, row0 - reachRows); row <= Math.min(grid.rows - 1, row0 + reachRows); row++) {
    for (let col = Math.max(0, col0 - reachCols); col <= Math.min(grid.columns - 1, col0 + reachCols); col++) {
      const piece = grid.cells[row][col];
      if (!piece) continue;
      const rect = cellRect(row, col, rules);
      const distance = distanceToRect(rect, point, view);
      if (!best || distance < best.distance) best = { piece, row, col, distance, impact: clampToRect(rect, point) };
    }
  }
  return best && best.distance <= rules.grace * view.height ? best : null;
}

/**
 * The same for a falling slab, which is `offsetY` (screen heights) lower than its cells.
 * @returns {{slab: Slab, row: number, col: number, distance: number, impact: Point}|null}
 */
export function findSlabCell(slab, offsetY, point, view, rules = R) {
  let best = null;
  for (const { row, col } of slab.cells) {
    const r = cellRect(row, col, rules);
    const rect = { x0: r.x0, y0: r.y0 + offsetY, x1: r.x1, y1: r.y1 + offsetY };
    const distance = distanceToRect(rect, point, view);
    if (!best || distance < best.distance) best = { slab, row, col, distance, impact: clampToRect(rect, point) };
  }
  return best && best.distance <= rules.grace * view.height ? best : null;
}

// ---- Damage -----------------------------------------------------------------

/**
 * Damage dealt by blasts at some points. Each piece takes the largest damage
 * any blast does where its nearest cell is (power, falling to nothing at the
 * blast's reach), varied a little by a number fixed for the piece and `seed`.
 * Changes the pieces' `hp`.
 * @param {Grid} grid the pieces still standing
 * @param {{x: number, y: number, power: number, reach: number}[]} blasts impact points on screen; reach in cells
 * @param {number} seed a number that differs from throw to throw
 * @param {View} view
 * @returns {Result}
 */
export function damageField(grid, blasts, seed, view, rules = R) {
  const result = { damaged: [], broken: [], explosions: [] };
  const unit = cellUnit(view, rules);
  const cw = cellWidth(rules) * view.width;
  const ch = rules.rowHeight * view.height;
  const done = new Set();
  const examine = (piece) => {
    if (done.has(piece)) return;
    done.add(piece);
    if (piece.hp <= 0) return;
    let damage = 0;
    for (const { row, col } of cellsOf(piece)) {
      const rect = cellRect(row, col, rules);
      const cx = ((rect.x0 + rect.x1) / 2) * view.width;
      const cy = ((rect.y0 + rect.y1) / 2) * view.height;
      for (const b of blasts) {
        const d = Math.hypot(cx - b.x * view.width, cy - b.y * view.height) / unit;
        if (d < b.reach) damage = Math.max(damage, b.power * (1 - d / b.reach));
      }
    }
    if (damage <= 0) return;
    piece.hp -= damage * (1 + rules.noise * (hash01(piece.row, piece.col, seed) * 2 - 1));
    if (piece.hp > 0) {
      result.damaged.push(piece);
    } else {
      result.broken.push(piece);
      if (piece.kind === 'tnt') result.explosions.push(piece);
    }
  };
  for (const b of blasts) {
    const rowC = rowAt(b.y, rules);
    const colC = Math.floor(((b.x - rules.left) / (rules.right - rules.left)) * rules.columns);
    const reachCols = Math.ceil((b.reach * unit) / cw) + 1;
    const reachRows = Math.ceil((b.reach * unit) / ch) + 1;
    for (let row = Math.max(0, rowC - reachRows); row <= Math.min(grid.rows - 1, rowC + reachRows); row++) {
      for (let col = Math.max(0, colC - reachCols); col <= Math.min(grid.columns - 1, colC + reachCols); col++) {
        const piece = grid.cells[row][col];
        if (piece) examine(piece);
      }
    }
  }
  return result;
}

/**
 * A throw hit a cell: a crater where it landed.
 * @param {{piece: Piece, impact: Point}} hit what `findCell` found
 * @returns {Result}
 */
export function resolveThrow(grid, hit, seed, view, rules = R) {
  return damageField(grid, [{ x: hit.impact.x, y: hit.impact.y, power: rules.throw.power, reach: rules.throw.reach }], seed, view, rules);
}

/** A blast (TNT, a crane load, a crate) at a point: `blast` is `rules.blast` or `rules.craneBlast`. */
export function blastAt(grid, point, blast, seed, view, rules = R) {
  return damageField(grid, [{ x: point.x, y: point.y, power: blast.power, reach: blast.reach }], seed, view, rules);
}

/** TNT blows up: its middle is the centre of a big crater. The TNT is no longer in the grid. */
export function explode(grid, tnt, seed, view, rules = R) {
  const rect = pieceRect(tnt, rules);
  const point = { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 };
  return blastAt(grid, point, rules.blast, seed, view, rules);
}

/** Takes the pieces a result broke out of the grid. */
export function clearBroken(grid, result) {
  for (const piece of result.broken) removePiece(grid, piece);
}

/** Points for demolishing a piece. */
export function pointsFor(piece, rules = R) {
  return rules.piecePoints[piece.kind] ?? (rules.cellPoints[piece.kind] ?? 0) * areaOf(piece);
}

/**
 * Points for clearing a level with `msLeft` on the clock: for each second the
 * clock shows (it rounds up, so 12.3 s left shows 13).
 */
export function timeBonus(msLeft, rules = R) {
  return Math.ceil(Math.max(0, msLeft) / 1000) * rules.timeBonusPerSecond;
}

// ---- Support and slabs ------------------------------------------------------

/**
 * Which pieces are held up, and which have come loose. A piece is held up if
 * it reaches the ground or is joined, through any side, to something that is.
 * Going up from a held piece costs nothing; going sideways or down (hanging
 * from above) costs one cell of overhang. A piece reached sideways or from
 * above stays up only if the cost of the cheapest way to it is within its
 * material's `maxOverhang`, so a ledge that sticks out too far snaps off. A
 * piece reached by going up, resting directly on a held piece, is carried by
 * it and stays up whatever its own limit (glass on a concrete cantilever is
 * fine), and keeps the cost it inherited, so what sits beside it pays from
 * there. A skybridge is held the same way as any wall. (A 0-1 search over the
 * pieces, from the ground row: each piece is reached in two ways, from below
 * and from the side, which are costed apart.)
 * @param {Grid} grid
 * @returns {Piece[]} the pieces that are not held up
 */
export function findLoose(grid, rules = R) {
  const pieces = piecesIn(grid);
  const held = new Set();
  // The cheapest way to each piece found so far, from below (carried) and otherwise.
  const costs = [new Map(), new Map()];
  const buckets = [[]];
  const push = (piece, c, carried) => {
    const map = costs[carried ? 0 : 1];
    if (c >= (map.get(piece) ?? Infinity)) return;
    map.set(piece, c);
    (buckets[c] ??= []).push({ piece, carried });
  };
  for (const piece of pieces) if (piece.row === 0) push(piece, 0, false);
  for (let level = 0; level < buckets.length; level++) {
    const bucket = buckets[level];
    for (let k = 0; k < bucket.length; k++) {
      const { piece, carried } = bucket[k];
      if (costs[carried ? 0 : 1].get(piece) !== level) continue;
      if (!carried && level > (rules.maxOverhang[piece.kind] ?? 0)) continue;
      held.add(piece);
      const top = piece.row + piece.height;
      for (let c = piece.col; c < piece.col + piece.width; c++) {
        const above = grid.cells[top]?.[c];
        if (above) push(above, level, true);
        const below = piece.row > 0 ? grid.cells[piece.row - 1][c] : null;
        if (below) push(below, level + 1, false);
      }
      for (let r = piece.row; r < top; r++) {
        const left = piece.col > 0 ? grid.cells[r][piece.col - 1] : null;
        const right = grid.cells[r][piece.col + piece.width];
        if (left) push(left, level + 1, false);
        if (right) push(right, level + 1, false);
      }
    }
  }
  return pieces.filter((p) => !held.has(p));
}

/** Groups loose pieces that touch into slabs, each falling as one. */
export function groupSlabs(grid, loose) {
  const set = new Set(loose);
  const seen = new Set();
  const slabs = [];
  for (const start of loose) {
    if (seen.has(start)) continue;
    const pieces = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const piece = stack.pop();
      pieces.push(piece);
      for (const { row, col } of cellsOf(piece)) {
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const other = grid.cells[row + dr]?.[col + dc];
          if (other && set.has(other) && !seen.has(other)) {
            seen.add(other);
            stack.push(other);
          }
        }
      }
    }
    const cells = pieces.flatMap(cellsOf);
    slabs.push({
      pieces,
      cells,
      row0: Math.min(...cells.map((c) => c.row)),
      row1: Math.max(...cells.map((c) => c.row)),
      col0: Math.min(...cells.map((c) => c.col)),
      col1: Math.max(...cells.map((c) => c.col)),
    });
  }
  return slabs.sort((a, b) => a.row0 - b.row0 || a.col0 - b.col0);
}

/**
 * Takes everything that is not held up out of the grid, as slabs.
 * @returns {Slab[]} lowest first
 */
export function detachLoose(grid, rules = R) {
  const slabs = groupSlabs(grid, findLoose(grid, rules));
  for (const slab of slabs) for (const piece of slab.pieces) removePiece(grid, piece);
  return slabs;
}

/**
 * Where a slab comes to rest if it falls straight down: it drops until one of
 * its cells meets a standing cell (or the ground). `grid` doesn't hold the slab.
 * @returns {{drop: number, contacts: Cell[]}} drop: how many rows it falls; contacts: the standing cells it lands on
 */
export function slabLanding(grid, slab) {
  let drop = Infinity;
  const below = [];
  for (const { row, col } of slab.cells) {
    let top = -1;
    for (let r = row - 1; r >= 0; r--) {
      if (grid.cells[r][col]) {
        top = r;
        break;
      }
    }
    const allowed = row - top - 1;
    below.push({ allowed, top, col });
    drop = Math.min(drop, allowed);
  }
  const seen = new Set();
  const contacts = [];
  for (const b of below) {
    if (b.allowed === drop && b.top >= 0 && !seen.has(b.col)) {
      seen.add(b.col);
      contacts.push({ row: b.top, col: b.col });
    }
  }
  return { drop: drop === Infinity ? 0 : drop, contacts };
}

/**
 * A slab lands on standing cells: the ones it lands on (`contacts`) take a
 * modest blow, harder for a bigger slab. Changes the pieces' `hp`.
 * @returns {Result}
 */
export function slabImpact(grid, slab, contacts, seed, view, rules = R) {
  const s = rules.slabImpact;
  const power = Math.min(s.max, s.base + s.perCell * slab.cells.length);
  const blasts = contacts.map(({ row, col }) => {
    const rect = cellRect(row, col, rules);
    return { x: (rect.x0 + rect.x1) / 2, y: rect.y0, power, reach: s.reach };
  });
  return damageField(grid, blasts, seed, view, rules);
}

/**
 * Covers a slab's cells with a few rectangles that hold only its cells: the
 * largest that fit, then the largest of the rest, and so on. The game follows
 * each with the camera (a rectangle is solid, so the camera can learn what it
 * looks like even though the slab itself is ragged).
 * @param {Cell[]} cells
 * @param {number} maxRects
 * @returns {{row0: number, col0: number, row1: number, col1: number, area: number}[]} largest first
 */
export function coverWithRects(cells, maxRects) {
  if (!cells.length) return [];
  const row0 = Math.min(...cells.map((c) => c.row));
  const col0 = Math.min(...cells.map((c) => c.col));
  const h = Math.max(...cells.map((c) => c.row)) - row0 + 1;
  const w = Math.max(...cells.map((c) => c.col)) - col0 + 1;
  const free = Array.from({ length: h }, () => Array(w).fill(false));
  for (const c of cells) free[c.row - row0][c.col - col0] = true;
  const rects = [];
  while (rects.length < maxRects) {
    // The largest rectangle of free cells: for each row, the heights of the free runs above it.
    let best = null;
    const run = Array(w).fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) run[x] = free[y][x] ? run[x] + 1 : 0;
      for (let x0 = 0; x0 < w; x0++) {
        let min = Infinity;
        for (let x1 = x0; x1 < w && run[x1] > 0; x1++) {
          min = Math.min(min, run[x1]);
          const area = min * (x1 - x0 + 1);
          if (!best || area > best.area) best = { y1: y, y0: y - min + 1, x0, x1, area };
        }
      }
    }
    if (!best) break;
    for (let y = best.y0; y <= best.y1; y++) for (let x = best.x0; x <= best.x1; x++) free[y][x] = false;
    rects.push({ row0: row0 + best.y0, col0: col0 + best.x0, row1: row0 + best.y1, col1: col0 + best.x1, area: best.area });
  }
  return rects;
}

/** What the loose bits of a grid do at once, for simulations and tests: they fall and shatter. Returns the cells lost. */
export function collapseAll(grid, rules = R) {
  let cells = 0;
  for (;;) {
    const slabs = detachLoose(grid, rules);
    if (!slabs.length) return cells;
    for (const slab of slabs) cells += slab.pieces.reduce((n, p) => n + areaOf(p), 0);
  }
}

// ---- Gravity ----------------------------------------------------------------

/**
 * Where a falling thing is at `time`, from where it started: `fall` has the
 * top edge `y0` and speed `v0` (screen heights, and per second, downwards) at
 * `t0` (ms), and the top edge `y1` it stops at.
 * @returns {{y: number, v: number, landed: boolean}}
 */
export function fallAt(fall, time, rules = R) {
  const t = Math.max(0, (time - fall.t0) / 1000);
  const y = fall.y0 + fall.v0 * t + 0.5 * rules.gravity * t * t;
  if (y >= fall.y1) return { y: fall.y1, v: fall.v0 + rules.gravity * t, landed: true };
  return { y, v: fall.v0 + rules.gravity * t, landed: false };
}

/** How long (ms) it takes to fall `distance` screen heights, starting at speed `v0`. */
export function fallMs(distance, v0 = 0, rules = R) {
  if (distance <= 0) return 0;
  return ((-v0 + Math.sqrt(v0 * v0 + 2 * rules.gravity * distance)) / rules.gravity) * 1000;
}

// ---- Rubble -----------------------------------------------------------------

/**
 * Adds rubble where `cells` cells were demolished in column `col`: the pile
 * grows there and (less) in the columns around it, never beyond `max`.
 * Changes `piles` (a height for each column, in screen heights).
 * @returns {number[]} the columns whose pile changed
 */
export function growRubble(piles, col, cells, rules = R) {
  const { max, perCell, kernel } = rules.rubble;
  const changed = [];
  kernel.forEach((share, k) => {
    const c = col + k - (kernel.length >> 1);
    if (c < 0 || c >= piles.length) return;
    const before = piles[c];
    piles[c] = Math.min(max, before + cells * perCell * share);
    if (piles[c] !== before) changed.push(c);
  });
  return changed;
}

// ---- Levels -----------------------------------------------------------------

/**
 * The hand-made levels, as buildings. A building's `col` is where its left
 * edge stands (0–63), `x` is how far from that edge something goes.
 * @type {Level[]}
 */
export const LEVELS = [
  {
    n: 1,
    name: 'First Day on the Job',
    timeMs: 60_000,
    buildings: [
      { type: 'shack', col: 3, width: 10, storeys: 2 },
      { type: 'shack', col: 16, width: 8, storeys: 1 },
      { type: 'shack', col: 27, width: 12, storeys: 3 },
      { type: 'shack', col: 42, width: 9, storeys: 2 },
      { type: 'shack', col: 54, width: 8, storeys: 1 },
    ],
    movers: { crane: false, balloons: false, helicopter: false },
  },
  {
    n: 2,
    name: 'Bricks and Mortar',
    timeMs: 60_000,
    buildings: [
      { type: 'tenement', col: 4, width: 12, storeys: 2 },
      { type: 'tenement', col: 25, width: 10, storeys: 3, gold: [{ storey: 0, x: 4 }] },
      { type: 'tenement', col: 46, width: 12, storeys: 2 },
    ],
    movers: { crane: false, balloons: false, helicopter: false },
  },
  {
    n: 3,
    name: 'Bridge Over Nothing',
    timeMs: 75_000, // the bridge adds cells to demolish, so a little longer than it had
    buildings: [
      // A skybridge joins the first two blocks across the gap between them.
      { type: 'block', col: 4, width: 10, storeys: 2, bridges: [{ row: 6 }] },
      { type: 'block', col: 22, width: 12, storeys: 2, wall: 'brick' },
      { type: 'block', col: 46, width: 10, storeys: 1 },
    ],
    movers: { crane: true, balloons: false, helicopter: false },
  },
  {
    n: 4,
    name: 'Handle With Care',
    timeMs: 65_000,
    buildings: [
      { type: 'tenement', col: 3, width: 12, storeys: 2, tnt: [{ storey: 0, x: 3 }, { storey: 1, x: 7 }] },
      { type: 'shack', col: 20, width: 10, storeys: 3, tnt: [{ storey: 1, x: 4 }] },
      { type: 'block', col: 35, width: 12, storeys: 2, wall: 'brick', tnt: [{ storey: 0, x: 5 }] },
      { type: 'shack', col: 52, width: 9, storeys: 2 },
    ],
    movers: { crane: true, balloons: true, helicopter: false },
  },
  {
    n: 5,
    name: 'Air Support',
    timeMs: 70_000,
    buildings: [
      { type: 'tower', col: 4, width: 10, storeys: 3, tnt: [{ storey: 1, x: 4 }] },
      { type: 'tenement', col: 20, width: 12, storeys: 2, gold: [{ storey: 1, x: 3 }], bridges: [{ row: 6 }] },
      { type: 'block', col: 40, width: 12, storeys: 2, wall: 'brick', tnt: [{ storey: 0, x: 4 }] },
      { type: 'shack', col: 56, width: 6, storeys: 2 },
    ],
    movers: { crane: true, balloons: false, helicopter: true },
  },
];

/**
 * The city of a level: its pieces and buildings (see `buildCity`).
 * @param {Level} level
 */
export function buildLevel(level, rules = R) {
  return buildCity(level.buildings, rules);
}

/** How many cells a level asks players to demolish. */
export function breakableCount(level, rules = R) {
  return breakableCells(buildLevel(level, rules).pieces);
}

/**
 * About how many throws it takes to clear a level: the cheapest 85% of its
 * cells, by what each throw is expected to demolish of that material
 * (`cellsPerThrow`, which counts what falls as a result). A rough guess that
 * ignores the help of TNT, but it tells a level that can't be won from one
 * that can.
 */
export function throwsNeeded(level, rules = R) {
  const g = rules.generator;
  const costs = [];
  for (const piece of buildLevel(level, rules).pieces) {
    const each = 1 / g.cellsPerThrow[piece.kind];
    for (let i = 0; i < areaOf(piece); i++) costs.push(each);
  }
  costs.sort((a, b) => a - b);
  const cheapest = costs.slice(0, clearTarget(costs.length, rules));
  return Math.ceil(cheapest.reduce((sum, v) => sum + v, 0));
}

/** Is the level winnable: can the throws it needs be made in the time? */
export function isWinnable(level, rules = R) {
  return throwsNeeded(level, rules) * rules.generator.throwMs <= level.timeMs;
}

const GENERATED_NAMES = [
  'Block Party', 'Skyline Sweep', 'Tower Trouble', 'Dust Bowl', 'Wrecking Crew', 'Rubble Rousers',
  'Downtown Dust-up', 'Rooftop Rumble',
];

/**
 * How hard the generated levels are at level `n`. Everything here only ever
 * gets harder as `n` goes up (more and taller buildings, tougher materials,
 * more TNT and bridges, more moving targets, less time).
 */
export function difficultyFor(n, rules = R) {
  const g = rules.generator;
  const s = Math.max(0, n - g.firstGeneratedLevel);
  return {
    buildings: { min: 4, max: Math.min(6, 4 + Math.floor(s / 3)) },
    width: { min: 9, max: Math.min(14, 11 + Math.floor(s / 2)) },
    storeys: { min: 2 + Math.min(1, Math.floor(s / 4)), max: Math.min(5, 3 + Math.floor(s / 2)) },
    // The share of the types: shacks get rarer, concrete blocks and (from level 9) towers commoner.
    shack: Math.max(0.05, 0.4 - 0.06 * s),
    tenement: 0.35,
    block: Math.min(0.5, 0.2 + 0.05 * s),
    tower: s >= 3 ? Math.min(0.3, 0.08 * (s - 2)) : 0,
    bridgeChance: Math.min(0.7, 0.2 + 0.05 * s),
    maxTnt: Math.min(3, 1 + Math.floor(s / 4)),
    goldChance: Math.min(0.6, 0.3 + 0.03 * s),
    movers: { crane: n >= g.firstGeneratedLevel, balloons: n >= 7, helicopter: n >= 8 },
    timeRatio: g.timeRatioPerLevel ** Math.max(0, n - 5),
  };
}

/**
 * A level made from `n` alone: the same level number is always the same city.
 * Taller and harder as `n` rises (see `difficultyFor`), and trimmed to a size
 * that can be cleared in the time it gets.
 * @returns {Level}
 */
export function generateLevel(n, rules = R) {
  const d = difficultyFor(n, rules);
  const g = rules.generator;
  const sum = (list) => list.reduce((a, b) => a + b, 0);

  // Everything random is decided here, once, so that taking a storey off a building later changes nothing else.
  const random = seededRandom(n);
  const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
  const count = int(d.buildings.min, d.buildings.max);
  const widths = Array.from({ length: count }, () => int(d.width.min, d.width.max));
  const gaps = Array.from({ length: count + 1 }, (_, i) => (i === 0 || i === count ? int(1, 3) : int(2, 5)));
  while (sum(widths) + sum(gaps) > rules.columns) widths[widths.indexOf(Math.max(...widths))]--;
  const total = d.shack + d.tenement + d.block + d.tower;
  const plans = widths.map((width) => {
    const x = random() * total;
    const type = x < d.shack ? 'shack' : x < d.shack + d.tenement ? 'tenement' : x < d.shack + d.tenement + d.block ? 'block' : 'tower';
    return {
      type, width, storeys: int(d.storeys.min, d.storeys.max), infill: random() < 0.5 ? 'brick' : 'concrete',
      rolls: [random(), random(), random(), random()],
    };
  });
  const tntCount = int(0, d.maxTnt);
  const tntSpots = Array.from({ length: tntCount }, () => ({ building: int(0, count - 1), storey: random(), x: random() }));
  const goldSpot = random() < d.goldChance ? { building: int(0, count - 1), storey: random(), x: random() } : null;
  const bridgeRolls = Array.from({ length: count }, () => random());

  const compose = (storeys) => {
    let col = gaps[0];
    const descs = plans.map((plan, i) => {
      const desc = { type: plan.type, col, width: plan.width, storeys: storeys[i] };
      if (plan.type === 'block' && plan.infill === 'brick') desc.wall = 'brick';
      col += plan.width + gaps[i + 1];
      return desc;
    });
    const spot = (s) => {
      const desc = descs[s.building % descs.length];
      const storey = Math.floor(s.storey * desc.storeys);
      return { desc, storey, x: 2 + Math.floor(s.x * Math.max(1, desc.width - 5)) };
    };
    const taken = new Set();
    for (const s of tntSpots) {
      const { desc, storey, x } = spot(s);
      const key = `${s.building % descs.length} ${storey} ${x >> 2}`;
      if (taken.has(key)) continue;
      taken.add(key);
      (desc.tnt ??= []).push({ storey, x });
    }
    if (goldSpot) {
      const { desc, storey, x } = spot(goldSpot);
      if (!taken.has(`${goldSpot.building % descs.length} ${storey} ${x >> 2}`)) (desc.gold ??= []).push({ storey, x });
    }
    // A skybridge between neighbours that are close and tall enough. Its rows lie inside both
    // buildings (`tall` is the shorter one's height). Concrete holds 6 cells of overhang from either side,
    // so any gap up to 12 is held; these are at most 4.
    for (let i = 0; i + 1 < descs.length; i++) {
      const a = descs[i];
      const b = descs[i + 1];
      const gap = b.col - (a.col + a.width);
      const tall = Math.min(layoutBuilding(a).rows, layoutBuilding(b).rows);
      if (gap <= 4 && tall >= 12 && bridgeRolls[i] < d.bridgeChance) {
        // On the floor of one of the left building's upper storeys, with the whole bridge below the roofs.
        const storeyRows = BUILDING_TYPES[a.type].storeyRows;
        const floors = Math.floor((tall - BRIDGE_ROWS) / storeyRows);
        const row = storeyRows * (1 + Math.floor(bridgeRolls[i] * 1000) % floors);
        (a.bridges ??= []).push({ row });
      }
    }
    return descs;
  };
  const toLevel = (storeys) => {
    const level = {
      n, name: GENERATED_NAMES[(n - g.firstGeneratedLevel) % GENERATED_NAMES.length], timeMs: 0, buildings: compose(storeys), movers: d.movers,
    };
    const ms = Math.min(g.maxMs, Math.max(g.minMs, throwsNeeded(level, rules) * g.throwMs * g.slack));
    level.timeMs = Math.round(Math.max(g.floorMs, ms * d.timeRatio));
    return level;
  };

  // Rows: keep every building within the grid.
  const storeys = plans.map((plan) => {
    const type = BUILDING_TYPES[plan.type];
    return Math.min(plan.storeys, Math.floor((rules.maxRows - type.roofRows) / type.storeyRows));
  });
  // Too big to clear in the time: take a building off the end (down to three), then a storey off the
  // tallest building, until it is not. Fewer buildings but as tall keeps the levels tall.
  let level = toLevel(storeys);
  while (!isWinnable(level, rules)) {
    if (storeys.length > 3) {
      storeys.pop();
      plans.pop();
    } else {
      let tallest = -1;
      storeys.forEach((s, i) => {
        if (s > 1 && (tallest < 0 || layoutBuilding(level.buildings[i]).rows > layoutBuilding(level.buildings[tallest]).rows)) tallest = i;
      });
      if (tallest < 0) break;
      storeys[tallest]--;
    }
    level = toLevel(storeys);
  }
  return level;
}

/**
 * The level for number `n` (1 is the first): the five hand-made ones, then
 * generated ones.
 * @returns {Level}
 */
export function levelFor(n, rules = R) {
  n = Math.max(1, Math.floor(n));
  const made = LEVELS[n - 1];
  if (made) return JSON.parse(JSON.stringify(made));
  return generateLevel(n, rules);
}

// ---- Rebuilding -------------------------------------------------------------

/**
 * The prefab chunk the helicopter drops: a small section of the building's
 * wall, `chunk` cells wide and high, with a window (a tower's has a glass
 * band between concrete slabs). Its cells are marked as added by the helicopter.
 * @param {string} type the building type
 * @param {number} col the column of its left edge
 * @param {number} row the row of its lowest cells
 * @returns {Piece[]} ids are 0: the game gives them
 */
export function chunkPieces(type, col, row, rules = R) {
  const size = rules.helicopter.chunk;
  const def = BUILDING_TYPES[type];
  const pieces = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      let kind = def.wall;
      if (type === 'tower') kind = r === 0 || r === size - 1 ? def.slab : 'glass';
      else if (r >= 1 && r <= size - 2 && c >= 1 && c <= size - 2) kind = 'glass';
      const hp = rules.hp[kind];
      pieces.push({ id: 0, kind, row: row + r, col: col + c, width: 1, height: 1, hp, maxHp: hp, extra: true });
    }
  }
  return pieces;
}

/**
 * What fills the dips under a chunk that lands on a ragged top: wall (or, for
 * a glass tower, concrete) in every column from the top of the column up to
 * the row the chunk rests in. Marked as added by the helicopter too.
 * @returns {Piece[]}
 */
export function chunkFill(grid, type, col, row, rules = R) {
  const def = BUILDING_TYPES[type];
  const kind = def.wall === 'glass' ? def.slab : def.wall;
  const hp = rules.hp[kind];
  const pieces = [];
  for (let c = col; c < col + rules.helicopter.chunk; c++) {
    for (let r = heightOf(grid, c); r < row; r++) {
      pieces.push({ id: 0, kind, row: r, col: c, width: 1, height: 1, hp, maxHp: hp, extra: true });
    }
  }
  return pieces;
}

/**
 * Where the rebuild helicopter should drop its chunk: the most damaged
 * building (the one that has lost the most cells since the start of the
 * level), at the stretch of `chunk` columns of it that has lost the most. The
 * chunk lands on top of the building there. Null if nothing is damaged (or
 * nothing fits).
 * @param {{col: number, width: number, type: string}[]} buildings the buildings at the start
 * @param {number[]} startCounts how many cells stood in each column at the start (`columnCounts`)
 * @param {Grid} grid the city now
 * @returns {{col: number, row: number, type: string}|null} col: its left edge; row: the row it lands in
 */
export function pickDrop(buildings, startCounts, grid, rules = R) {
  const size = rules.helicopter.chunk;
  const now = columnCounts(grid);
  const lost = (col) => Math.max(0, startCounts[col] - now[col]);
  const ranked = buildings
    .map((b) => {
      let total = 0;
      for (let col = b.col; col < b.col + b.width; col++) total += lost(col);
      return { building: b, total };
    })
    .filter((b) => b.total > 0 && b.building.width >= size)
    .sort((a, b) => b.total - a.total);
  for (const { building } of ranked) {
    const options = [];
    for (let col = building.col; col + size <= building.col + building.width; col++) {
      let total = 0;
      for (let c = col; c < col + size; c++) total += lost(c);
      options.push({ col, total, row: landingRow(grid, col, size) });
    }
    options.sort((a, b) => b.total - a.total || a.col - b.col);
    const fit = options.find((o) => o.total > 0 && o.row + size <= rules.maxRows);
    if (fit) return { col: fit.col, row: fit.row, type: building.type };
  }
  return null;
}

/** How many balloons drift about at once at level `n` (they first come at level 4). */
export function balloonCount(n, rules = R) {
  return Math.min(rules.balloon.maxCount, 1 + Math.floor(Math.max(0, n - 4) / 3));
}

/** How often the rebuild helicopter comes, at level `n` (it first comes at level 5). */
export function helicopterEveryMs(n, rules = R) {
  const { start, shrinkPerLevel, min } = rules.helicopter.everyMs;
  return Math.max(min, start - shrinkPerLevel * Math.max(0, n - 5));
}

// ---- Moving targets ---------------------------------------------------------

/**
 * Where the crane's load hangs at `time`: it swings like a pendulum from the
 * anchor, and stays upright.
 * @param {{anchorX: number, anchorY: number, length: number, amplitude: number, periodMs: number, phase: number, t0: number}} swing
 * @returns {{x: number, y: number, angle: number}} the load's centre; angle: the cable's, 0 straight down, positive to the right
 */
export function pendulumAt(swing, time, view) {
  const angle = swing.amplitude * Math.sin(swing.phase + (2 * Math.PI * (time - swing.t0)) / swing.periodMs);
  return {
    x: swing.anchorX + (Math.sin(angle) * swing.length * view.height) / view.width,
    y: swing.anchorY + Math.cos(angle) * swing.length,
    angle,
  };
}

/**
 * Where a balloon is at `time`: it drifts sideways and bobs.
 * @param {{x0: number, y0: number, dir: 1|-1, speed: number, bob: number, bobMs: number, phase: number, t0: number}} flight
 *   x0, y0: its centre at t0; speed: screen widths a second
 */
export function balloonAt(flight, time) {
  const t = time - flight.t0;
  return {
    x: flight.x0 + (flight.dir * flight.speed * t) / 1000,
    y: flight.y0 + flight.bob * Math.sin(flight.phase + (2 * Math.PI * t) / flight.bobMs),
  };
}

/**
 * The rebuild helicopter at `time`: it flies in from off the side, hovers over
 * `targetX` and flies on. If it was hit (`fled`), it zooms off upwards
 * instead, from where it was. Its position is its top edge's, centre.
 * @param {{x0: number, dir: 1|-1, speed: number, targetX: number, hoverMs: number, y: number, t0: number,
 *   fled?: {t: number, x: number, y: number}}} flight
 * @returns {{x: number, y: number, phase: 'in'|'hover'|'out'|'fled', dropAt: number}} dropAt: when it lets go
 */
export function helicopterAt(flight, time) {
  const arriveMs = (Math.abs(flight.targetX - flight.x0) / flight.speed) * 1000;
  const dropAt = flight.t0 + arriveMs + flight.hoverMs;
  const elapsed = (time - flight.t0) / 1000;
  const bob = 0.004 * Math.sin(elapsed * 5);
  if (flight.fled) {
    const s = Math.max(0, (time - flight.fled.t) / 1000);
    return { x: flight.fled.x + flight.dir * 0.03 * s, y: flight.fled.y - 0.25 * s - 1.4 * s * s, phase: 'fled', dropAt };
  }
  if (time < flight.t0 + arriveMs) {
    return { x: flight.x0 + flight.dir * flight.speed * elapsed, y: flight.y + bob, phase: 'in', dropAt };
  }
  if (time < dropAt) return { x: flight.targetX, y: flight.y + bob, phase: 'hover', dropAt };
  const out = (time - dropAt) / 1000;
  return { x: flight.targetX + flight.dir * flight.speed * out, y: flight.y + bob, phase: 'out', dropAt };
}
