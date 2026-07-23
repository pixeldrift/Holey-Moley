// Tile type definitions and the world grid.
// Rendering uses these as material identities; actual pixel textures live in textures.js
// so a tile's `color`/`accent` here are only used as a fallback / tint reference.

import { BLOCK_STATS, FOOD_ID, FOOD_ID_TO_TYPE } from "./constants.js";

export const TILE = {
  SKY: {
    id: "SKY", solid: false, diggable: false, walkable: true,
    color: null, // sky is painted as a gradient, not a flat tile
  },
  SURFACE: {
    // The walkway at ground level, rendered as a full grass block (see textures.js).
    // Non-diggable - it's the ground itself, not something to tunnel through. The rolling
    // hill silhouette behind it is separate, pure background art, not a tile at all.
    id: "SURFACE", solid: false, diggable: false, walkable: true,
    color: "#5fa832", accent: "#4c8a27",
  },
  TUNNEL: {
    id: "TUNNEL", solid: false, diggable: false, walkable: true,
    color: "#241a12",
  },
  DIRT_SOFT: {
    id: "DIRT_SOFT", solid: true, diggable: true, walkable: false,
    digAction: "dig", ...BLOCK_STATS.DIRT_SOFT,
    color: "#8a5a34", accent: "#7a4d2a",
  },
  DIRT_MEDIUM: {
    id: "DIRT_MEDIUM", solid: true, diggable: true, walkable: false,
    digAction: "dig", ...BLOCK_STATS.DIRT_MEDIUM,
    color: "#77492b", accent: "#663e24",
  },
  DIRT_HARD: {
    id: "DIRT_HARD", solid: true, diggable: true, walkable: false,
    digAction: "dig", ...BLOCK_STATS.DIRT_HARD,
    color: "#5f3a22", accent: "#4f2f1b",
  },
  ROOT: {
    id: "ROOT", solid: true, diggable: true, walkable: false,
    digAction: "dig", ...BLOCK_STATS.ROOT,
    color: "#8a5a34", accent: "#c99a53",
  },
  ROCK: {
    id: "ROCK", solid: true, diggable: false, walkable: false,
    color: "#6b6b6b", accent: "#565656",
  },
};

const MOVE_ACTION = { WALK: "walk", CLIMB: "climb", DIG: "dig" };
export { MOVE_ACTION };

// A diggable tile's SHAPE: FULL is an ordinary whole tile, solid on every side. NE/NW/SE/SW
// mean the tile has been diagonally halved by a 45 degree dig - solid material fills the
// tile's corner of that name, and the opposite corner is open, walkable space. This is a real
// collision surface, not just a decoration: the mole can walk/climb straight through a
// diagonal tile's open corner without digging (see TileMap.canEnter), and any wall-hugging
// creature (ants today, worms later) can tell which of a tile's edges are solid ground versus
// open air (see isEdgeSolid/diagonalSlopeDir) instead of treating every diggable tile as one
// uniform solid block.
export const SHAPE = { FULL: 0, NE: 1, NW: 2, SE: 3, SW: 4 };

// The two edges (by compass letter) that are solid for each diagonal shape - always just the
// shape's own two letters, e.g. SHAPE.NE is solid along its N and E edges. The other two edges
// are open along almost their entire length, save for the single point where the diagonal cut
// line touches them. See TileMap.isEdgeSolid/diagonalSlopeDir.
const SHAPE_EDGES = {
  [SHAPE.NE]: "NE",
  [SHAPE.NW]: "NW",
  [SHAPE.SE]: "SE",
  [SHAPE.SW]: "SW",
};

// Which edge (by compass letter) of a tile is shared with a creature approaching it from
// (wallDx,wallDy) - the vector FROM the creature's open cell TO that tile.
function _edgeForApproach(wallDx, wallDy) {
  if (wallDy === 1) return "N";
  if (wallDy === -1) return "S";
  if (wallDx === 1) return "W";
  if (wallDx === -1) return "E";
  return null;
}

export class TileMap {
  constructor(width, height, { skyRows = 3, seed } = {}) {
    this.width = width;
    this.height = height;
    this.skyRows = skyRows;
    this.surfaceRow = skyRows;
    this.startCol = Math.floor(width / 2);
    this.grid = new Array(width * height);
    this.food = new Uint8Array(width * height); // holds FOOD_ID codes
    this.shapes = new Uint8Array(width * height); // holds SHAPE codes
    this.tunnelOrigin = new Array(width * height).fill(null); // material a TUNNEL cell used to be
    this.surfaceFeatures = new Array(width).fill(null); // trees/bushes/flowers, keyed by column
    this.skeletonTile = null; // {col, row} of the map's single buried skeleton, or null
    this._rng = mulberry32(seed ?? Date.now());
    this._generate();
  }

  idx(x, y) {
    return y * this.width + x;
  }

  inBounds(x, y) {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  getTile(x, y) {
    if (!this.inBounds(x, y)) return TILE.ROCK;
    return this.grid[this.idx(x, y)];
  }

  getFoodId(x, y) {
    if (!this.inBounds(x, y)) return FOOD_ID.NONE;
    return this.food[this.idx(x, y)];
  }

  hasFood(x, y) {
    return this.getFoodId(x, y) !== FOOD_ID.NONE;
  }

  consumeFood(x, y) {
    if (!this.inBounds(x, y)) return FOOD_ID.NONE;
    const i = this.idx(x, y);
    const id = this.food[i];
    if (id !== FOOD_ID.NONE) {
      this.food[i] = FOOD_ID.NONE;
      return id;
    }
    return FOOD_ID.NONE;
  }

  setFoodId(x, y, id) {
    if (!this.inBounds(x, y)) return;
    this.food[this.idx(x, y)] = id;
  }

  /** Root-vegetable type (if any) planted directly under the grass at this column, used to
   *  draw its greens poking up above ground as a permanent dig hint. */
  getRootVeggieGreensType(col) {
    const type = FOOD_ID_TO_TYPE[this.getFoodId(col, this.surfaceRow + 1)];
    return type === "CARROT" || type === "BEET" || type === "TURNIP" || type === "CABBAGE" ? type : null;
  }

  setTile(x, y, tile) {
    if (!this.inBounds(x, y)) return;
    this.grid[this.idx(x, y)] = tile;
  }

  /** Dig out a tile, turning it into a walkable tunnel. Returns the tile that was removed. */
  digOut(x, y) {
    const removed = this.getTile(x, y);
    if (this.inBounds(x, y) && removed !== TILE.TUNNEL) {
      this.tunnelOrigin[this.idx(x, y)] = removed;
    }
    this.setTile(x, y, TILE.TUNNEL);
    if (this.inBounds(x, y)) this.shapes[this.idx(x, y)] = SHAPE.FULL;
    return removed;
  }

  /** The material a TUNNEL cell used to be, so its rendered background can be a darker version
   *  of that same material instead of a generic fill - falls back to plain dirt if untracked. */
  getTunnelOrigin(x, y) {
    if (!this.inBounds(x, y)) return TILE.DIRT_SOFT;
    return this.tunnelOrigin[this.idx(x, y)] || TILE.DIRT_SOFT;
  }

  getShape(x, y) {
    if (!this.inBounds(x, y)) return SHAPE.FULL;
    return this.shapes[this.idx(x, y)];
  }

  /**
   * Halves the given tile diagonally so a diagonal dig reads as one continuous 45 degree wall
   * instead of two square steps - solidCorner names which corner keeps its solid material (see
   * SHAPE). If the tile already has a *different* diagonal shape (a second diagonal path
   * crossed it), just open the whole tile - that's rare enough not to need real multi-notch
   * geometry.
   */
  carveDiagonal(x, y, solidCorner) {
    if (!this.inBounds(x, y)) return;
    const tile = this.getTile(x, y);
    if (!tile.diggable) return;
    const i = this.idx(x, y);
    const existing = this.shapes[i];
    if (existing === SHAPE.FULL) {
      this.shapes[i] = solidCorner;
    } else if (existing !== solidCorner) {
      this.digOut(x, y);
    }
  }

  /**
   * True if the side of tile (col,row) facing a creature approaching from (wallDx,wallDy) -
   * the direction FROM the creature's open cell TO this tile - is fully solid, safe to cling
   * to as an ordinary flat wall. False means that edge has been diagonally cut away almost
   * along its whole length (see SHAPE), and the creature should instead follow the cut's 45
   * degree slope toward this tile's solid corner - see diagonalSlopeDir. Always true for a
   * FULL (non-diagonal) tile, regardless of approach direction.
   */
  isEdgeSolid(col, row, wallDx, wallDy) {
    const shape = this.getShape(col, row);
    if (shape === SHAPE.FULL) return true;
    const solidEdges = SHAPE_EDGES[shape];
    const edge = _edgeForApproach(wallDx, wallDy);
    return edge != null && solidEdges.includes(edge);
  }

  /**
   * For a diagonal tile whose approached edge ISN'T fully solid (isEdgeSolid returned false),
   * the direction a creature should travel to follow the cut's 45 degree slope and stay
   * against real solid ground - a diagonal step running alongside the cut line toward this
   * tile's solid corner. Returns null for a FULL (non-diagonal) tile.
   */
  diagonalSlopeDir(col, row) {
    const shape = this.getShape(col, row);
    const solidEdges = SHAPE_EDGES[shape];
    if (!solidEdges) return null;
    return { dx: solidEdges.includes("E") ? 1 : -1, dy: solidEdges.includes("S") ? 1 : -1 };
  }

  /**
   * True if an entity standing in the open cell at (col-fromDx,row-fromDy) can move directly
   * into tile (col,row) - fromDx,fromDy is the direction FROM that open cell TO this tile,
   * same convention as isEdgeSolid - without digging: either the tile isn't solid at all, or
   * it's a diagonal tile (see SHAPE) and this is its open corner. For a cardinal approach,
   * isEdgeSolid's edge-by-edge check already answers that directly. A diagonal approach (both
   * fromDx and fromDy nonzero) instead has to compare against diagonalSlopeDir - free entry
   * only when fromDx,fromDy points the SAME way as the tile's own solid-corner direction (an
   * entity travelling that exact diagonal enters right at the tile's open corner and never
   * crosses the solid half at all - verified by tracing the straight-line entry point in tile-
   * relative coordinates, e.g. an NE tile's solidDir (1,-1) traced from its SW-adjacent
   * neighbor lands exactly on the SW corner, which is strictly on the open side of the cut);
   * any other diagonal, or a FULL tile, still requires digging. This is what lets a non-digging
   * mole (see Mole.requestMove's digging parameter) walk/climb diagonally through a notch the
   * same way an ant already ramps through one, instead of always needing to dig even when the
   * corner is already open.
   */
  canEnter(col, row, fromDx, fromDy) {
    const tile = this.getTile(col, row);
    if (!tile.solid) return true;
    const shape = this.getShape(col, row);
    if (shape === SHAPE.FULL) return false;
    if (fromDx !== 0 && fromDy !== 0) {
      const solidDir = this.diagonalSlopeDir(col, row);
      return fromDx === solidDir.dx && fromDy === solidDir.dy;
    }
    return !this.isEdgeSolid(col, row, fromDx, fromDy);
  }

  /** True if this open cell has a solid floor directly beneath it (surface bugs walk here) -
   *  a diagonal tile only counts as floor if its upward-facing edge is the solid one. */
  hasFloorBelow(x, y) {
    const here = this.getTile(x, y);
    if (here.solid) return false;
    const below = this.getTile(x, y + 1);
    return below.solid && this.isEdgeSolid(x, y + 1, 0, 1);
  }

  _generate() {
    const rng = this._rng;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        let tile;
        if (y < this.skyRows) {
          tile = TILE.SKY;
        } else if (y === this.surfaceRow) {
          tile = TILE.SURFACE;
        } else {
          const depth = y - this.surfaceRow; // 1..N
          tile = this._pickDirtTile(depth, rng);
        }
        this.setTile(x, y, tile);
      }
    }

    // Scatter rock clusters and root patches, depth-weighted.
    this._scatterClusters(TILE.ROCK, 0.010, 2, 4);
    this._scatterClusters(TILE.ROOT, 0.014, 2, 5);

    // Buried worms - anywhere diggable, weight increases with depth.
    for (let y = this.surfaceRow + 1; y < this.height; y++) {
      const depth = y - this.surfaceRow;
      const chance = Math.min(0.05 + depth * 0.0025, 0.14);
      for (let x = 0; x < this.width; x++) {
        const tile = this.getTile(x, y);
        if (tile.diggable && tile !== TILE.ROOT && rng() < chance) {
          this.setFoodId(x, y, FOOD_ID.WORM);
        }
      }
    }

    // Root vegetables - always in the tile directly under the grass, so digging one tile
    // down from the surface is enough to reach them. Their greens render above ground
    // regardless (see textures.js), giving the player a permanent hint of where they are.
    const rootVeggies = [FOOD_ID.CARROT, FOOD_ID.BEET, FOOD_ID.TURNIP, FOOD_ID.CABBAGE];
    const veggieRow = this.surfaceRow + 1;
    for (let x = 0; x < this.width; x++) {
      const tile = this.getTile(x, veggieRow);
      if (tile.diggable && tile !== TILE.ROOT && rng() < 0.12) {
        this.setFoodId(x, veggieRow, rootVeggies[Math.floor(rng() * rootVeggies.length)]);
      }
    }

    this._generateSurfaceFeatures(rng);
    this._carveStartingBurrow();
    this._placeSkeleton(rng);

    // The very bottom row is always solid rock - a hard natural floor so there's nowhere
    // left to dig once you've gone deep enough, regardless of whatever depth-based material
    // or cluster scattering put there.
    for (let x = 0; x < this.width; x++) {
      this.setTile(x, this.height - 1, TILE.ROCK);
    }
  }

  _generateSurfaceFeatures(rng) {
    let col = 2;
    const treeCols = [];
    while (col < this.width - 2) {
      col += 6 + Math.floor(rng() * 10);
      if (col >= this.width - 2) break;

      const roll = rng();
      if (roll < 0.28) {
        const sizeRoll = rng();
        const size = sizeRoll < 0.5 ? "small" : sizeRoll < 0.85 ? "medium" : "large";
        this.surfaceFeatures[col] = { type: "tree", size };
        this._growTreeRoots(col, size, rng);
        treeCols.push(col);
      } else if (roll < 0.55) {
        this.surfaceFeatures[col] = { type: "bush" };
      } else if (roll < 0.8) {
        this.surfaceFeatures[col] = { type: "flower" };
      }
    }
    this._ensureLargeTree(treeCols, rng);
  }

  // "Large" is only ~15% of the already-uncommon tree rolls, so most maps would otherwise
  // never grow one - guarantee at least one big stump (and its giant buried root system, see
  // textures.js drawUndergroundDecorations) per map. Prefer upgrading an existing tree; if the
  // map rolled no trees at all, plant one clear of the starting burrow.
  _ensureLargeTree(treeCols, rng) {
    if (treeCols.some((c) => this.surfaceFeatures[c]?.size === "large")) return;
    let col;
    if (treeCols.length) {
      col = treeCols[Math.floor(rng() * treeCols.length)];
    } else {
      const candidates = [];
      for (let x = 4; x < this.width - 4; x++) {
        if (Math.abs(x - this.startCol) > 3) candidates.push(x);
      }
      col = candidates[Math.floor(rng() * candidates.length)];
    }
    this.surfaceFeatures[col] = { type: "tree", size: "large" };
    this._growTreeRoots(col, "large", rng);
  }

  // Bigger trees send down deeper, wider root systems - real diggable ROOT tiles, tougher
  // and slower to clear than plain dirt, so a big tree visually explains a tough patch below.
  _growTreeRoots(col, size, rng) {
    const maxDepth = { small: 3, medium: 5, large: 8 }[size];
    const maxSpread = { small: 1, medium: 2, large: 3 }[size];
    for (let d = 1; d <= maxDepth; d++) {
      const row = this.surfaceRow + d;
      const spread = Math.max(0, maxSpread - Math.floor(d / 2));
      for (let s = -spread; s <= spread; s++) {
        if (rng() >= 0.7) continue;
        const x = col + s;
        const tile = this.getTile(x, row);
        if (tile.diggable) {
          this.setTile(x, row, TILE.ROOT);
          this.setFoodId(x, row, FOOD_ID.NONE);
        }
      }
    }
  }

  // A small pre-dug home base so the game doesn't start on a completely blank slate: a
  // short shaft down from the surface opening into a 2x2 chamber.
  _carveStartingBurrow() {
    const c0 = this.startCol;
    this._forceTunnel(c0, this.surfaceRow + 1);
    this._forceTunnel(c0, this.surfaceRow + 2);
    for (const x of [c0, c0 + 1]) {
      for (const y of [this.surfaceRow + 3, this.surfaceRow + 4]) {
        this._forceTunnel(x, y);
      }
    }
  }

  // A rare buried decoration - at most one per map, resting on a ROOT tile (see
  // textures.js drawUndergroundDecorations). Picked once here, not at render time, so it
  // can't accidentally show up more than once. Roots are meant to be exclusive of other
  // buried decorations rather than layering with them, so candidates also exclude any ROOT
  // tile that falls within a large tree's giant root art - a generous margin around its
  // actual (fractionally-centered) footprint, since being a little conservative here just
  // means fewer candidate tiles, not a visible bug.
  _placeSkeleton(rng) {
    const largeTreeCols = [];
    for (let x = 0; x < this.width; x++) {
      const f = this.surfaceFeatures[x];
      if (f?.type === "tree" && f.size === "large") largeTreeCols.push(x);
    }
    const trunkRow = this.surfaceRow + 1;
    const inRootGiantFootprint = (col, row) =>
      row >= trunkRow && row <= trunkRow + 4 &&
      largeTreeCols.some((tc) => col >= tc - 3 && col <= tc + 4);

    const candidates = [];
    for (let y = this.surfaceRow + 1; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.getTile(x, y) === TILE.ROOT && !inRootGiantFootprint(x, y)) {
          candidates.push({ col: x, row: y });
        }
      }
    }
    this.skeletonTile = candidates.length
      ? candidates[Math.floor(rng() * candidates.length)]
      : null;
  }

  _forceTunnel(x, y) {
    if (!this.inBounds(x, y)) return;
    const existing = this.getTile(x, y);
    if (existing !== TILE.TUNNEL) this.tunnelOrigin[this.idx(x, y)] = existing;
    this.setTile(x, y, TILE.TUNNEL);
    this.setFoodId(x, y, FOOD_ID.NONE);
    this.shapes[this.idx(x, y)] = SHAPE.FULL;
  }

  _pickDirtTile(depth, rng) {
    // Hardness bands loosely increase with depth, with noise so it's not uniform bands.
    const r = rng();
    if (depth <= 9) {
      if (r < 0.78) return TILE.DIRT_SOFT;
      if (r < 0.96) return TILE.DIRT_MEDIUM;
      return TILE.DIRT_HARD;
    } else if (depth <= 24) {
      if (r < 0.35) return TILE.DIRT_SOFT;
      if (r < 0.8) return TILE.DIRT_MEDIUM;
      return TILE.DIRT_HARD;
    } else {
      if (r < 0.15) return TILE.DIRT_SOFT;
      if (r < 0.55) return TILE.DIRT_MEDIUM;
      return TILE.DIRT_HARD;
    }
  }

  _scatterClusters(tileType, density, minSize, maxSize) {
    const rng = this._rng;
    const attempts = Math.floor(this.width * this.height * density);
    for (let i = 0; i < attempts; i++) {
      const cx = Math.floor(rng() * this.width);
      const cy = this.surfaceRow + 2 + Math.floor(rng() * (this.height - this.surfaceRow - 3));
      const size = minSize + Math.floor(rng() * (maxSize - minSize + 1));
      this._blob(cx, cy, size, tileType, rng);
    }
  }

  _blob(cx, cy, size, tileType, rng) {
    let x = cx, y = cy;
    for (let i = 0; i < size; i++) {
      if (this.inBounds(x, y) && y > this.surfaceRow) {
        const current = this.getTile(x, y);
        if (current !== TILE.SKY && current !== TILE.SURFACE) {
          this.setTile(x, y, tileType);
        }
      }
      const dir = Math.floor(rng() * 4);
      if (dir === 0) x++;
      else if (dir === 1) x--;
      else if (dir === 2) y++;
      else y--;
    }
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
