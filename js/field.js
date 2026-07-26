// The v2 terrain representation: a scalar density field, sampled at sub-tile resolution,
// replacing tiles.js's discrete SHAPE enum (FULL/NE/NW/SE/SW). A tile's material grid (dirt
// variant, rock, root, food, dig cost) stays exactly as-is in tiles.js - that's the "what". This
// field is the "how much of the world is actually solid at this exact point" - continuous
// enough that digging can carve any shape (a circle, eventually a rough/irregular blob) instead
// of always landing on one of five fixed corner cuts, and collision/rendering can query the
// real boundary instead of pattern-matching a shape enum that can silently fall out of sync
// with material solidity (see the ant-ramp bug this replaces the root cause of entirely).
//
// Samples live at grid POINTS, not cells - marching squares (see tileContour) operates on the
// 4 corner samples of each small cell and needs points shared between neighbors to butt up
// seamlessly, the same reason heightmaps and voxel terrain always sample at corners. A tile
// spanning world tile-units [col,col+1) x [row,row+1) is covered by a (resolution+1) x
// (resolution+1) block of points, sharing its edge points with each neighboring tile.

// sample >= this counts as solid. Exactly halfway through the 0-255 Uint8 range (not 128) so
// that edgeT(255,0) lands on exactly 0.5 - an off-by-half-a-unit threshold like 128 would bias
// every hard 255/0 edge crossing by a fraction of a sub-cell, on top of (and indistinguishable
// from) the real, already-accounted-for half-sub-cell error a hard tile-seeded boundary has
// from not varying smoothly across a cell in the first place (see _seedFromTileMap).
export const SOLID_THRESHOLD = 127.5;

// Cell corner bits, matching the classic marching-squares convention: bit0=BL, bit1=BR,
// bit2=TR, bit3=TL. Each case lists which of the 4 cell edges (0=N,1=E,2=S,3=W) the boundary
// crosses, as segments of edge-index pairs. Complementary cases (case and 15-case) always cross
// the same edges - only the saddle cases (5 and 10) differ, needing two separate segments since
// two diagonally-opposite corners are solid with no way to connect them with one line.
const EDGE_CROSSINGS = [
  [], // 0: empty
  [[3, 2]], // 1: BL
  [[2, 1]], // 2: BR
  [[3, 1]], // 3: BL+BR
  [[0, 1]], // 4: TR
  [[3, 2], [0, 1]], // 5: BL+TR (saddle)
  [[0, 2]], // 6: TR+BR
  [[0, 3]], // 7: BL+BR+TR (TL empty)
  [[0, 3]], // 8: TL
  [[0, 2]], // 9: TL+BL
  [[0, 3], [2, 1]], // 10: TL+BR (saddle)
  [[0, 1]], // 11: TL+BL+BR (TR empty)
  [[3, 1]], // 12: TL+TR
  [[2, 1]], // 13: TL+TR+BL (BR empty)
  [[3, 2]], // 14: TL+TR+BR (BL empty)
  [], // 15: full
];

// Same 16 cases as EDGE_CROSSINGS, but as FILLED polygons (corner + edge points, going around
// each solid region) instead of just the boundary line - what rendering needs to clip the
// existing bitmap art to "only the actually-solid part of this cell", the marching-squares
// analog of textures.js's old _solidTrianglePoints (which only ever had one fixed triangle per
// SHAPE; this is the same idea generalized to all 16 configurations). Point keys reference the
// computed corner/edge positions built per-cell in _cellPoints. The saddle cases (5, 10) are two
// disconnected polygons, same reason they're two segments in EDGE_CROSSINGS.
const CASE_POLYGONS = [
  [], // 0: empty
  [["W", "BL", "S"]], // 1: BL
  [["S", "BR", "E"]], // 2: BR
  [["W", "BL", "BR", "E"]], // 3: BL+BR
  [["N", "TR", "E"]], // 4: TR
  [["W", "BL", "S"], ["N", "TR", "E"]], // 5: BL+TR (saddle)
  [["N", "TR", "BR", "S"]], // 6: TR+BR
  [["W", "BL", "BR", "TR", "N"]], // 7: BL+BR+TR (TL empty)
  [["N", "TL", "W"]], // 8: TL
  [["TL", "N", "S", "BL"]], // 9: TL+BL
  [["N", "TL", "W"], ["S", "BR", "E"]], // 10: TL+BR (saddle)
  [["TL", "BL", "BR", "E", "N"]], // 11: TL+BL+BR (TR empty)
  [["TL", "TR", "E", "W"]], // 12: TL+TR
  [["TL", "TR", "E", "S", "BL"]], // 13: TL+TR+BL (BR empty)
  [["N", "TR", "BR", "BL", "W"]], // 14: TL+TR+BR (BL empty)
  [["TL", "TR", "BR", "BL"]], // 15: full
];

// Where along the a->b edge the density crosses SOLID_THRESHOLD, as a 0..1 fraction from a to
// b. A same-value edge (both solid or both empty) never actually gets queried by a real
// marching-squares case, but degenerates safely to the midpoint rather than dividing by zero.
function edgeT(a, b) {
  const d = b - a;
  if (d === 0) return 0.5;
  return Math.max(0, Math.min(1, (SOLID_THRESHOLD - a) / d));
}

export class ScalarField {
  constructor(tileMap, resolution = 8) {
    this.tileMap = tileMap;
    this.res = resolution;
    this.pointsW = tileMap.width * resolution + 1;
    this.pointsH = tileMap.height * resolution + 1;
    this.samples = new Uint8Array(this.pointsW * this.pointsH);
    // tileSolidFraction/tileContour/tileSolidPolygons are re-derived from raw samples on every
    // call by design (no stored-shape state to drift out of sync - see the module doc comment),
    // but that makes them too expensive to call fresh every frame for every visible tile at a
    // real resolution (measured: ~30ms for one frame's worth of boundary tiles at resolution 32,
    // several times a 60fps frame budget on its own). A tile's terrain only ever changes when a
    // dig actually reaches it, so caching per tile and invalidating just the tiles a dig's
    // bounding box touches (see subtractCircle/_invalidateTileCache) gets the same "always
    // correct, never hand-tracked" guarantee at a cost that's amortized to nearly free.
    this._tileCache = new Map(); // key: row*width+col -> {fraction, contour, polygons}
    this._seedFromTileMap();
  }

  _tileCacheKey(col, row) {
    return row * this.tileMap.width + col;
  }

  _idx(px, py) {
    return py * this.pointsW + px;
  }

  // A point exactly on a tile boundary is numerically assigned to the tile on its lower/right
  // side (Math.floor of an exact integer is that integer) - an arbitrary but fixed, consistent
  // tie-break. Pre-dig, every tile is uniformly solid or uniformly empty (no partial shapes
  // exist yet), so which side wins a boundary point only shifts the eventual contour by at most
  // half a sub-cell - imperceptible, and only at the seed step; digging supersedes it immediately.
  //
  // That "half a sub-cell" applies per shared POINT - but two tiles don't share just one point,
  // they share a whole EDGE of them (every point along a tile's right/bottom border belongs to
  // its neighbor by this same rule). So the very first dig on a tile whose neighbors are still
  // completely untouched briefly shows a roughly half-sub-cell-wide strip of "solid" bleeding in
  // from each untouched neighbor along the shared edge - real, and more visible at low
  // resolution (confirmed empirically: about 20% of a tile's area at resolution 5, shrinking
  // close to proportionally as resolution increases). It's inherently transient: the moment a
  // neighboring tile is also dug, subtractCircle stamps those shared points directly and the
  // bleed is gone - and it only ever happens on the solid side, so it never opens a gap where
  // there shouldn't be one, only softens a corner that will get carved through soon anyway.
  _seedFromTileMap() {
    const { tileMap, res, pointsW, pointsH } = this;
    for (let py = 0; py < pointsH; py++) {
      const row = Math.min(tileMap.height - 1, Math.floor(py / res));
      for (let px = 0; px < pointsW; px++) {
        const col = Math.min(tileMap.width - 1, Math.floor(px / res));
        this.samples[py * pointsW + px] = tileMap.getTile(col, row).solid ? 255 : 0;
      }
    }
  }

  /** Raw sample at a point index (not a world coordinate) - clamped to the field's bounds. */
  sampleAt(px, py) {
    const cx = Math.max(0, Math.min(this.pointsW - 1, px));
    const cy = Math.max(0, Math.min(this.pointsH - 1, py));
    return this.samples[this._idx(cx, cy)];
  }

  /** Nearest-point density at a world position (tile units). */
  sampleWorld(x, y) {
    return this.sampleAt(Math.round(x * this.res), Math.round(y * this.res));
  }

  // Hard cut: every point within radius r (tile units) of (cx,cy) goes fully empty. A later
  // roughness pass (see the v2 plan) replaces this flat cut with a falloff and/or per-angle
  // noise on the radius so dig edges stop being perfect circles - this is deliberately the
  // simplest possible version first, so the field/contour/collision plumbing can be verified
  // against exact, predictable geometry before anything gets organic.
  subtractCircle(cx, cy, r) {
    const { res, pointsW, pointsH, samples } = this;
    const pxMin = Math.max(0, Math.floor((cx - r) * res));
    const pxMax = Math.min(pointsW - 1, Math.ceil((cx + r) * res));
    const pyMin = Math.max(0, Math.floor((cy - r) * res));
    const pyMax = Math.min(pointsH - 1, Math.ceil((cy + r) * res));
    const r2 = r * r;
    for (let py = pyMin; py <= pyMax; py++) {
      const wy = py / res;
      const dy = wy - cy;
      for (let px = pxMin; px <= pxMax; px++) {
        const wx = px / res;
        const dx = wx - cx;
        if (dx * dx + dy * dy <= r2) samples[py * pointsW + px] = 0;
      }
    }
    this._invalidateTileCache(cx, cy, r);
  }

  // Same as subtractCircle, but leaves any point whose enclosing tile is solid-and-not-diggable
  // (rock - the only tile type that combination describes; TUNNEL/SKY/SURFACE are also
  // non-diggable but aren't solid, so they're never blocked here, which matters: a TUNNEL tile
  // can still have solid leftover residue in the field that a burrow dig needs to be able to
  // clear) untouched - lets a big player-triggered round dig (see Mole.holdBurrow) expand freely
  // without ever eating through the one material ordinary tile-by-tile digging already can't
  // touch either. Reads tileMap.getTile(...).solid/.diggable the same duck-typed way
  // _seedFromTileMap already does, rather than importing tiles.js's TILE constants directly.
  subtractCircleProtected(cx, cy, r) {
    const { res, pointsW, pointsH, samples, tileMap } = this;
    const pxMin = Math.max(0, Math.floor((cx - r) * res));
    const pxMax = Math.min(pointsW - 1, Math.ceil((cx + r) * res));
    const pyMin = Math.max(0, Math.floor((cy - r) * res));
    const pyMax = Math.min(pointsH - 1, Math.ceil((cy + r) * res));
    const r2 = r * r;
    for (let py = pyMin; py <= pyMax; py++) {
      const wy = py / res;
      const dy = wy - cy;
      const row = Math.min(tileMap.height - 1, Math.floor(wy));
      for (let px = pxMin; px <= pxMax; px++) {
        const wx = px / res;
        const dx = wx - cx;
        if (dx * dx + dy * dy > r2) continue;
        const col = Math.min(tileMap.width - 1, Math.floor(wx));
        const tile = tileMap.getTile(col, row);
        if (tile.solid && !tile.diggable) continue; // rock - never carved
        samples[py * pointsW + px] = 0;
      }
    }
    this._invalidateTileCache(cx, cy, r);
  }

  // Every tile whose own point block overlaps the circle's bounding box needs its cache entry
  // dropped - not just the tile(s) the center falls in, since a dig can graze a neighbor's edge
  // (or, per the shared-edge seeding note above, even just touching one tile's own points can
  // affect a neighbor's cached shape at their shared border).
  _invalidateTileCache(cx, cy, r) {
    const { tileMap } = this;
    const colMin = Math.max(0, Math.floor(cx - r));
    const colMax = Math.min(tileMap.width - 1, Math.floor(cx + r));
    const rowMin = Math.max(0, Math.floor(cy - r));
    const rowMax = Math.min(tileMap.height - 1, Math.floor(cy + r));
    for (let row = rowMin; row <= rowMax; row++) {
      for (let col = colMin; col <= colMax; col++) {
        this._tileCache.delete(this._tileCacheKey(col, row));
      }
    }
  }

  _tileEntry(col, row) {
    const key = this._tileCacheKey(col, row);
    let entry = this._tileCache.get(key);
    if (!entry) {
      entry = {};
      this._tileCache.set(key, entry);
    }
    return entry;
  }

  /** Fraction (0..1) of a tile's own point samples that are solid - the coarse "is this tile
   *  basically solid" signal that replaces hand-tracked SHAPE/solid flags, derived instead of
   *  stored so it can never drift out of sync with what was actually dug. */
  tileSolidFraction(col, row) {
    const entry = this._tileEntry(col, row);
    if (entry.fraction !== undefined) return entry.fraction;
    const { res, pointsW, samples } = this;
    const px0 = col * res, py0 = row * res;
    let solidCount = 0;
    const total = (res + 1) * (res + 1);
    for (let py = py0; py <= py0 + res; py++) {
      for (let px = px0; px <= px0 + res; px++) {
        if (samples[py * pointsW + px] >= SOLID_THRESHOLD) solidCount++;
      }
    }
    entry.fraction = solidCount / total;
    return entry.fraction;
  }

  // One marching-squares cell's case index and its 8 named points (4 corners, 4 possibly-
  // interpolated edge crossings), in world tile-units - the shared geometry both tileContour
  // (boundary line) and tileSolidPolygons (filled region) build on, so the corner/edgeT math
  // only happens once per cell no matter how many consumers read it.
  _cellPoints(cx, cy) {
    const { res, pointsW, samples } = this;
    const tl = samples[cy * pointsW + cx];
    const tr = samples[cy * pointsW + cx + 1];
    const bl = samples[(cy + 1) * pointsW + cx];
    const br = samples[(cy + 1) * pointsW + cx + 1];
    const caseIndex =
      (bl >= SOLID_THRESHOLD ? 1 : 0) |
      (br >= SOLID_THRESHOLD ? 2 : 0) |
      (tr >= SOLID_THRESHOLD ? 4 : 0) |
      (tl >= SOLID_THRESHOLD ? 8 : 0);
    return {
      caseIndex,
      points: {
        TL: { x: cx / res, y: cy / res },
        TR: { x: (cx + 1) / res, y: cy / res },
        BR: { x: (cx + 1) / res, y: (cy + 1) / res },
        BL: { x: cx / res, y: (cy + 1) / res },
        N: { x: (cx + edgeT(tl, tr)) / res, y: cy / res },
        E: { x: (cx + 1) / res, y: (cy + edgeT(tr, br)) / res },
        S: { x: (cx + edgeT(bl, br)) / res, y: (cy + 1) / res },
        W: { x: cx / res, y: (cy + edgeT(tl, bl)) / res },
      },
    };
  }

  /** Boundary segments (world tile-units) for a single tile - the render-ready contour that
   *  replaces the fixed 45-degree cut a SHAPE tile used to draw. */
  tileContour(col, row) {
    const entry = this._tileEntry(col, row);
    if (entry.contour) return entry.contour;
    const { res } = this;
    const px0 = col * res, py0 = row * res;
    const segments = [];
    for (let cy = py0; cy < py0 + res; cy++) {
      for (let cx = px0; cx < px0 + res; cx++) {
        const { caseIndex, points } = this._cellPoints(cx, cy);
        for (const [a, b] of EDGE_CROSSINGS[caseIndex]) {
          const p1 = points[["N", "E", "S", "W"][a]], p2 = points[["N", "E", "S", "W"][b]];
          segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
        }
      }
    }
    entry.contour = segments;
    return segments;
  }

  /** Filled solid-region polygons (world tile-units) for a single tile - each an array of
   *  {x,y} points going around one contiguous solid patch (usually one polygon per tile, two
   *  for a saddle cell straddling a diagonal). Used to clip existing bitmap art to the real
   *  field boundary instead of the old fixed 45-degree triangle. */
  tileSolidPolygons(col, row) {
    const entry = this._tileEntry(col, row);
    if (entry.polygons) return entry.polygons;
    const { res } = this;
    const px0 = col * res, py0 = row * res;
    const polygons = [];
    for (let cy = py0; cy < py0 + res; cy++) {
      for (let cx = px0; cx < px0 + res; cx++) {
        const { caseIndex, points } = this._cellPoints(cx, cy);
        for (const keys of CASE_POLYGONS[caseIndex]) {
          polygons.push(keys.map((k) => points[k]));
        }
      }
    }
    entry.polygons = polygons;
    return polygons;
  }
}
