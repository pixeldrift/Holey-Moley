// Terrain and scenery rendering, built from the "Holey Moley Spritesheet.png" art (see
// assets/ for the individually-cut pieces). Each terrain material has several independently
// tileable 64x64 variants straight from the sheet - no blur, no stretching, just a random
// pick per grid cell (deterministic by position, so it doesn't shimmer frame to frame).
// Must call initTextures(sprites) once (with assets.js's loaded images) before any
// drawTerrainTile call.

import { TILE, CORNER } from "./tiles.js";

let sprites = null;
let materials = null; // { grass: [img,img,img,img], sand: [...], ... }
let flowerSprites = null;
let bushSprites = null;

const MATERIAL_FOR_TILE = {
  SURFACE: "grass",
  DIRT_SOFT: "sand",
  DIRT_MEDIUM: "soil",
  DIRT_HARD: "dirt",
  ROOT: "gravel",
  ROCK: "rock",
};

export function initTextures(loadedSprites) {
  sprites = loadedSprites;
  materials = {
    grass: sprites.terrainGrass,
    sand: sprites.terrainSand,
    soil: sprites.terrainSoil,
    dirt: sprites.terrainDirt,
    gravel: sprites.terrainGravel,
    rock: sprites.terrainRock,
  };
  // Flowers are single tiles now - the sheet no longer pairs them with their own root art
  // (dedicated, randomized root tiles are used for the ROOT terrain type instead).
  flowerSprites = sprites.flowers;
  // Bushes keep a small root sprig of their own, drawn one row down, same shape as a tree.
  bushSprites = [
    { top: sprites.bush01, root: sprites.bush01Root },
    { top: sprites.bush02, root: sprites.bush02Root },
  ];
}

function hashTile(col, row) {
  let h = (col * 374761393 + row * 668265263) ^ (col << 13);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = (h ^ (h >>> 13)) >>> 0;
  return h;
}

function pickVariant(variants, col, row, salt = 0) {
  return variants[(hashTile(col, row) + salt) % variants.length];
}

/** Draws one terrain tile: a randomly-picked variant of its material, full stop - no
 *  blending, no softened edges between neighbors, just the sheet's own tile art. */
export function drawTerrainTile(ctx, map, tile, col, row, x, y, tileSize) {
  const px = Math.round(x);
  const py = Math.round(y);

  if (tile === TILE.TUNNEL) {
    _drawTunnel(ctx, col, row, px, py, tileSize);
    return;
  }

  const material = MATERIAL_FOR_TILE[tile.id];
  const variants = material ? materials[material] : null;

  const cornerCut = tile.diggable ? map.getCornerCut(col, row) : CORNER.NONE;
  if (cornerCut !== CORNER.NONE) {
    _drawDiagonalTile(ctx, variants, col, row, cornerCut, px, py, tileSize);
    return;
  }

  if (variants) {
    ctx.drawImage(pickVariant(variants, col, row), px, py, tileSize, tileSize);
  } else {
    ctx.fillStyle = tile.color || "#000";
    ctx.fillRect(px, py, tileSize, tileSize);
  }

  if (tile === TILE.ROOT) {
    const overlay = pickVariant(sprites.rootOverlays, col, row, 7);
    ctx.drawImage(overlay, px, py, tileSize, tileSize);
  }
}

// The sheet has no cave/tunnel art - a flat fill with a few crisp (unblurred) darker flecks,
// deterministic per tile so it doesn't shimmer.
function _drawTunnel(ctx, col, row, px, py, tileSize) {
  ctx.fillStyle = "#241a12";
  ctx.fillRect(px, py, tileSize, tileSize);
  ctx.fillStyle = "#150e09";
  const h = hashTile(col, row);
  for (let i = 0; i < 4; i++) {
    const fx = px + ((h >> (i * 4)) % 11) * (tileSize / 12) + 2;
    const fy = py + ((h >> (i * 4 + 2)) % 11) * (tileSize / 12) + 2;
    ctx.fillRect(fx, fy, 2, 2);
  }
}

// The four points of a tile, in canvas order, used to build the triangular clip paths below.
function _tileCorners(px, py, tileSize) {
  return {
    NW: [px, py],
    NE: [px + tileSize, py],
    SE: [px + tileSize, py + tileSize],
    SW: [px, py + tileSize],
  };
}

// Given which corner's triangle was cut away, returns the 3 points of the SOLID triangle
// that remains (always the corner diagonally opposite the one that was cut).
function _solidTrianglePoints(cornerCut, corners) {
  switch (cornerCut) {
    case CORNER.SW: return [corners.NW, corners.NE, corners.SE]; // NE half solid
    case CORNER.NE: return [corners.NW, corners.SW, corners.SE]; // SW half solid
    case CORNER.SE: return [corners.NW, corners.NE, corners.SW]; // NW half solid
    case CORNER.NW: return [corners.NE, corners.SE, corners.SW]; // SE half solid
    default: return null;
  }
}

// Renders a tile that's had one triangular half opened up by a diagonal dig: fill the whole
// cell as tunnel first (that becomes the open half), then clip to the remaining solid
// triangle and paint the material there - the boundary is a single straight 45 degree line,
// continuous with the neighboring tiles' own cuts.
function _drawDiagonalTile(ctx, variants, col, row, cornerCut, px, py, tileSize) {
  _drawTunnel(ctx, col, row, px, py, tileSize);
  if (!variants) return;

  const corners = _tileCorners(px, py, tileSize);
  const points = _solidTrianglePoints(cornerCut, corners);
  if (!points) return;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  ctx.lineTo(points[1][0], points[1][1]);
  ctx.lineTo(points[2][0], points[2][1]);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(pickVariant(variants, col, row), px, py, tileSize, tileSize);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Surface scenery: trees (trunk base + roots below), bushes, flowers, and the
// visible greens of any root vegetable planted directly beneath this column.
// All purely decorative except the tree's root tiles, which are real diggable
// ROOT tiles placed at map-generation time (see tiles.js _generateSurfaceFeatures).
// ---------------------------------------------------------------------------

function drawSurfaceDecoration(ctx, map, col, px, py, tileSize) {
  const feature = map.surfaceFeatures?.[col];
  if (feature?.type === "tree") _drawTreeBase(ctx, col, px, py, tileSize);
  else if (feature?.type === "bush") _drawBush(ctx, col, px, py, tileSize);
  else if (feature?.type === "flower") _drawFlower(ctx, col, px, py, tileSize);

  const veggieType = map.getRootVeggieGreensType?.(col);
  if (veggieType) _drawVeggieGreens(ctx, col, px, py, tileSize, veggieType);
}

/**
 * Trees/bushes/flowers/veggie-greens draw well outside their own tile's cell - a tall tree
 * or a carrot's root can reach into rows above or below the surface row. Since the terrain
 * loop draws row by row top-to-bottom, anything drawn inline during the surface row's own
 * pass would get painted over by the next row's tile fill. So these are drawn in a separate
 * pass, after every visible terrain tile is down, layering cleanly on top of all of them.
 */
export function drawSurfaceDecorations(ctx, map, startCol, endCol, originX, originY, tileSize) {
  const py = originY + map.surfaceRow * tileSize;
  for (let col = startCol; col <= endCol; col++) {
    const px = originX + col * tileSize;
    drawSurfaceDecoration(ctx, map, col, px, py, tileSize);
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

// Every sprite is exactly one 64x64 cell from the sheet's own grid, and the sheet's own rows
// line up with the terrain's rows: sheet row0 (grass) is the same row as the SURFACE tile,
// sheet row1 (sand) is the same row as the first DIRT tile below it. So an "above ground"
// piece (tree/bush/flower top) draws in the surface row's own cell - same as the grass tile
// underneath it - and a "below ground" piece (flower/carrot root) draws one row down, in the
// first dirt row's cell, matching where the actual food tile lives (see tiles.js
// getRootVeggieGreensType, which reads surfaceRow+1). Two plain adjacent tiles meeting
// exactly at the ground line, no scaling or fractional anchoring needed.
function _drawTile(ctx, img, px, py, tileSize) {
  ctx.drawImage(img, px, py, tileSize, tileSize);
}

function _drawTreeBase(ctx, col, px, py, tileSize) {
  _drawTile(ctx, sprites.treeTrunk, px, py, tileSize);
}

function _drawBush(ctx, col, px, py, tileSize) {
  const rng = mulberry32(col * 7639 + 11);
  const spec = bushSprites[Math.floor(rng() * bushSprites.length)];
  _drawTile(ctx, spec.top, px, py, tileSize);
  _drawTile(ctx, spec.root, px, py + tileSize, tileSize);
}

function _drawFlower(ctx, col, px, py, tileSize) {
  const rng = mulberry32(col * 26113 + 5);
  const img = flowerSprites[Math.floor(rng() * flowerSprites.length)];
  _drawTile(ctx, img, px, py, tileSize);
}

// Carrot/beet/turnip each have their own dedicated top (greens) + bottom (bulb/root) art now -
// no more tinting a shared carrot sprite. Cabbage is handled separately in _drawVeggieGreens -
// it's a single whole-head image with no underground part, so it isn't part of this table.
function _getVeggieTiles(veggieType) {
  switch (veggieType) {
    case "BEET": return { top: sprites.beetTop, bottom: sprites.beetBottom };
    case "TURNIP": return { top: sprites.turnipTop, bottom: sprites.turnipBottom };
    default: return { top: sprites.carrotTop, bottom: sprites.carrotBottom };
  }
}

// Greens (top) sit in the surface row cell, body one row down where the food tile actually is -
// except cabbage, which is a single whole-head sprite that sits right on the ground like a real
// cabbage would, not buried a row down with the other veggies' bulbs.
function _drawVeggieGreens(ctx, col, px, py, tileSize, veggieType) {
  if (veggieType === "CABBAGE") {
    _drawTile(ctx, sprites.cabbage, px, py, tileSize);
    return;
  }
  const tiles = _getVeggieTiles(veggieType);
  if (tiles.top) _drawTile(ctx, tiles.top, px, py, tileSize);
  _drawTile(ctx, tiles.bottom, px, py + tileSize, tileSize);
}

/** Big soft rolling hill silhouette drawn once behind the surface row - pure ambiance, no gameplay meaning. */
export function drawBackgroundHills(ctx, viewW, viewH, originX, groundY) {
  if (groundY < -60 || groundY > viewH + 200) return;

  ctx.save();
  ctx.fillStyle = "#6fae3f";
  ctx.beginPath();
  ctx.moveTo(0, viewH);
  ctx.lineTo(0, groundY + 24);
  const step = 24;
  for (let sx = 0; sx <= viewW; sx += step) {
    const worldX = sx - originX;
    const hillHeight = 22 + Math.sin(worldX / 140) * 12 + Math.sin(worldX / 55) * 5;
    ctx.lineTo(sx, groundY + 24 - hillHeight);
  }
  ctx.lineTo(viewW, groundY + 24);
  ctx.lineTo(viewW, viewH);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
