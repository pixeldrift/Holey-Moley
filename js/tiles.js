// Tile type definitions and the world grid.
// Rendering uses flat colors as placeholders until real sprite art is added -
// swap TILE.*.color for a spritesheet reference later without touching the rest of the game.

export const TILE = {
  SKY: {
    id: "SKY", solid: false, diggable: false, walkable: true,
    color: null, // sky is painted as a gradient, not a flat tile
  },
  GRASS: {
    id: "GRASS", solid: true, diggable: true, walkable: false,
    digDuration: 260, digEnergyCost: 1.5, digAction: "walk",
    color: "#5fa832", accent: "#4c8a27",
  },
  TUNNEL: {
    id: "TUNNEL", solid: false, diggable: false, walkable: true,
    color: "#241a12",
  },
  DIRT_SOFT: {
    id: "DIRT_SOFT", solid: true, diggable: true, walkable: false,
    digDuration: 300, digEnergyCost: 2, digAction: "dig",
    color: "#8a5a34", accent: "#7a4d2a",
  },
  DIRT_MEDIUM: {
    id: "DIRT_MEDIUM", solid: true, diggable: true, walkable: false,
    digDuration: 520, digEnergyCost: 4, digAction: "dig",
    color: "#77492b", accent: "#663e24",
  },
  DIRT_HARD: {
    id: "DIRT_HARD", solid: true, diggable: true, walkable: false,
    digDuration: 820, digEnergyCost: 7, digAction: "dig",
    color: "#5f3a22", accent: "#4f2f1b",
  },
  ROOT: {
    id: "ROOT", solid: true, diggable: true, walkable: false,
    digDuration: 1300, digEnergyCost: 11, digAction: "dig",
    color: "#8a5a34", accent: "#c99a53",
  },
  ROCK: {
    id: "ROCK", solid: true, diggable: false, walkable: false,
    color: "#6b6b6b", accent: "#565656",
  },
};

const MOVE_ACTION = { WALK: "walk", CLIMB: "climb", DIG: "dig" };
export { MOVE_ACTION };

export class TileMap {
  constructor(width, height, { skyRows = 3, seed } = {}) {
    this.width = width;
    this.height = height;
    this.skyRows = skyRows;
    this.grassRow = skyRows;
    this.grid = new Array(width * height);
    this.food = new Uint8Array(width * height);
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

  hasFood(x, y) {
    if (!this.inBounds(x, y)) return false;
    return this.food[this.idx(x, y)] === 1;
  }

  consumeFood(x, y) {
    if (!this.inBounds(x, y)) return false;
    const i = this.idx(x, y);
    if (this.food[i] === 1) {
      this.food[i] = 0;
      return true;
    }
    return false;
  }

  setTile(x, y, tile) {
    if (!this.inBounds(x, y)) return;
    this.grid[this.idx(x, y)] = tile;
  }

  /** Dig out a tile, turning it into a walkable tunnel. Returns the tile that was removed. */
  digOut(x, y) {
    const removed = this.getTile(x, y);
    this.setTile(x, y, TILE.TUNNEL);
    return removed;
  }

  _generate() {
    const rng = this._rng;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        let tile;
        if (y < this.skyRows) {
          tile = TILE.SKY;
        } else if (y === this.grassRow) {
          tile = TILE.GRASS;
        } else {
          const depth = y - this.grassRow; // 1..N
          tile = this._pickDirtTile(depth, rng);
        }
        this.setTile(x, y, tile);
      }
    }

    // Scatter rock clusters and root patches, depth-weighted.
    this._scatterClusters(TILE.ROCK, 0.010, 2, 4);
    this._scatterClusters(TILE.ROOT, 0.014, 2, 5);

    // Scatter buried food (worms/grubs) - never under grass/sky, weight increases with depth.
    for (let y = this.grassRow + 1; y < this.height; y++) {
      const depth = y - this.grassRow;
      const chance = Math.min(0.05 + depth * 0.0025, 0.14);
      for (let x = 0; x < this.width; x++) {
        const tile = this.getTile(x, y);
        if (tile.diggable && tile !== TILE.ROOT && rng() < chance) {
          this.food[this.idx(x, y)] = 1;
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
      const cy = this.grassRow + 2 + Math.floor(rng() * (this.height - this.grassRow - 3));
      const size = minSize + Math.floor(rng() * (maxSize - minSize + 1));
      this._blob(cx, cy, size, tileType, rng);
    }
  }

  _blob(cx, cy, size, tileType, rng) {
    let x = cx, y = cy;
    for (let i = 0; i < size; i++) {
      if (this.inBounds(x, y) && y > this.grassRow) {
        const current = this.getTile(x, y);
        if (current !== TILE.SKY && current !== TILE.GRASS) {
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
