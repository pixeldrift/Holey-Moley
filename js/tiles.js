// Tile type definitions and the world grid.
// Rendering uses these as material identities; actual pixel textures live in textures.js
// so a tile's `color`/`accent` here are only used as a fallback / tint reference.

import { BLOCK_STATS, FOOD_ID } from "./constants.js";

export const TILE = {
  SKY: {
    id: "SKY", solid: false, diggable: false, walkable: true,
    color: null, // sky is painted as a gradient, not a flat tile
  },
  SURFACE: {
    // The walkway at ground level. Non-diggable - it's just open ground with a thin
    // decorative grass cap drawn on top (see textures.js). The real grass "hill" scenery
    // behind it is pure background art, not a tile at all.
    id: "SURFACE", solid: false, diggable: false, walkable: true,
    color: "#8a5a34", accent: "#7a4d2a",
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

// A "corner cut" marks a solid tile as having one of its triangular halves opened up -
// this is what turns a diagonal dig from a blocky staircase into a smooth 45 degree tunnel.
// The label names the corner whose triangle is REMOVED (the opposite triangle stays solid).
export const CORNER = { NONE: 0, NE: 1, NW: 2, SE: 3, SW: 4 };

export class TileMap {
  constructor(width, height, { skyRows = 3, seed } = {}) {
    this.width = width;
    this.height = height;
    this.skyRows = skyRows;
    this.surfaceRow = skyRows;
    this.grid = new Array(width * height);
    this.food = new Uint8Array(width * height); // holds FOOD_ID codes
    this.cornerCuts = new Uint8Array(width * height); // holds CORNER codes
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

  setTile(x, y, tile) {
    if (!this.inBounds(x, y)) return;
    this.grid[this.idx(x, y)] = tile;
  }

  /** Dig out a tile, turning it into a walkable tunnel. Returns the tile that was removed. */
  digOut(x, y) {
    const removed = this.getTile(x, y);
    this.setTile(x, y, TILE.TUNNEL);
    if (this.inBounds(x, y)) this.cornerCuts[this.idx(x, y)] = CORNER.NONE;
    return removed;
  }

  getCornerCut(x, y) {
    if (!this.inBounds(x, y)) return CORNER.NONE;
    return this.cornerCuts[this.idx(x, y)];
  }

  /**
   * Shaves the given triangular corner off a solid tile so a diagonal dig reads as one
   * continuous 45 degree wall instead of two square steps. If the tile already has a
   * *different* corner cut (a second diagonal path crossed it), just open the whole tile -
   * that's rare enough not to need real multi-notch geometry.
   */
  cutCorner(x, y, corner) {
    if (!this.inBounds(x, y)) return;
    const tile = this.getTile(x, y);
    if (!tile.diggable) return;
    const i = this.idx(x, y);
    const existing = this.cornerCuts[i];
    if (existing === CORNER.NONE) {
      this.cornerCuts[i] = corner;
    } else if (existing !== corner) {
      this.digOut(x, y);
    }
  }

  /** True if this open cell has a solid floor directly beneath it (surface bugs walk here). */
  hasFloorBelow(x, y) {
    const here = this.getTile(x, y);
    if (here.solid) return false;
    return this.getTile(x, y + 1).solid;
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

    // Root vegetables - shallow only, just under the surface.
    const rootVeggies = [FOOD_ID.CARROT, FOOD_ID.BEET, FOOD_ID.TURNIP];
    for (let y = this.surfaceRow + 1; y <= this.surfaceRow + 4; y++) {
      for (let x = 0; x < this.width; x++) {
        const tile = this.getTile(x, y);
        if (tile.diggable && tile !== TILE.ROOT && this.getFoodId(x, y) === FOOD_ID.NONE && rng() < 0.05) {
          this.setFoodId(x, y, rootVeggies[Math.floor(rng() * rootVeggies.length)]);
        }
      }
    }
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
