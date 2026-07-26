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
const SOLID_THRESHOLD = 127.5;

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
    this._seedFromTileMap();
  }

  _idx(px, py) {
    return py * this.pointsW + px;
  }

  // A point exactly on a tile boundary is numerically assigned to the tile on its lower/right
  // side (Math.floor of an exact integer is that integer) - an arbitrary but fixed, consistent
  // tie-break. Pre-dig, every tile is uniformly solid or uniformly empty (no partial shapes
  // exist yet), so which side wins a boundary point only shifts the eventual contour by at most
  // half a sub-cell - imperceptible, and only at the seed step; digging supersedes it immediately.
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
  }

  /** Fraction (0..1) of a tile's own point samples that are solid - the coarse "is this tile
   *  basically solid" signal that replaces hand-tracked SHAPE/solid flags, derived instead of
   *  stored so it can never drift out of sync with what was actually dug. */
  tileSolidFraction(col, row) {
    const { res, pointsW, samples } = this;
    const px0 = col * res, py0 = row * res;
    let solidCount = 0;
    const total = (res + 1) * (res + 1);
    for (let py = py0; py <= py0 + res; py++) {
      for (let px = px0; px <= px0 + res; px++) {
        if (samples[py * pointsW + px] >= SOLID_THRESHOLD) solidCount++;
      }
    }
    return solidCount / total;
  }

  // Marching squares over an arbitrary rectangle of cells, in point-index space - shared by
  // tileContour (one tile) and, later, multi-tile chunk contours for rendering without
  // reworking this. Returns segments as {x1,y1,x2,y2} in world tile-units.
  _marchCellsRegion(startPx, startPy, cellsW, cellsH) {
    const { res, pointsW, samples } = this;
    const segments = [];
    for (let cy = startPy; cy < startPy + cellsH; cy++) {
      for (let cx = startPx; cx < startPx + cellsW; cx++) {
        const tl = samples[cy * pointsW + cx];
        const tr = samples[cy * pointsW + cx + 1];
        const bl = samples[(cy + 1) * pointsW + cx];
        const br = samples[(cy + 1) * pointsW + cx + 1];
        const caseIndex =
          (bl >= SOLID_THRESHOLD ? 1 : 0) |
          (br >= SOLID_THRESHOLD ? 2 : 0) |
          (tr >= SOLID_THRESHOLD ? 4 : 0) |
          (tl >= SOLID_THRESHOLD ? 8 : 0);
        const crossings = EDGE_CROSSINGS[caseIndex];
        if (crossings.length === 0) continue;

        const edgePoint = (edge) => {
          if (edge === 0) return { x: (cx + edgeT(tl, tr)) / res, y: cy / res };
          if (edge === 1) return { x: (cx + 1) / res, y: (cy + edgeT(tr, br)) / res };
          if (edge === 2) return { x: (cx + edgeT(bl, br)) / res, y: (cy + 1) / res };
          return { x: cx / res, y: (cy + edgeT(tl, bl)) / res };
        };

        for (const [a, b] of crossings) {
          const p1 = edgePoint(a), p2 = edgePoint(b);
          segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
        }
      }
    }
    return segments;
  }

  /** Boundary segments (world tile-units) for a single tile - the render-ready contour that
   *  replaces the fixed 45-degree cut a SHAPE tile used to draw. */
  tileContour(col, row) {
    return this._marchCellsRegion(col * this.res, row * this.res, this.res, this.res);
  }
}
