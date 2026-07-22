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
let burrowMoundSprites = null;
let burrowWideSprite = null;
let skeletonSprite = null;
let rootGiantSprite = null;

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
  burrowMoundSprites = sprites.burrowMounds;
  burrowWideSprite = sprites.burrowWide;
  skeletonSprite = sprites.skeleton;
  rootGiantSprite = sprites.rootGiant;
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
    _drawTunnel(ctx, map, col, row, px, py, tileSize);
    return;
  }

  if (tile === TILE.SURFACE && !map.getTile(col, row + 1).solid) {
    // Grass with nothing solid left underneath (the dirt below has been dug away) - there's
    // no turf to stand on anymore. A hole exactly one tile wide (both neighbors still have
    // their own support) gets one of the two dedicated mound-with-opening sprites; anything
    // wider just shows plain sky - painted explicitly rather than left undrawn, since the
    // decorative background hills (drawn behind everything) would otherwise still show
    // through a gap this close to the ground line.
    const leftOpen = _isUnsupportedSurface(map, col - 1, row);
    const rightOpen = _isUnsupportedSurface(map, col + 1, row);
    if (!leftOpen && !rightOpen) {
      _drawBurrowMound(ctx, col, px, py, tileSize);
    } else if (!leftOpen && rightOpen) {
      _drawBurrowWideHalf(ctx, px, py, tileSize, "left");
    } else if (leftOpen && !rightOpen) {
      _drawBurrowWideHalf(ctx, px, py, tileSize, "right");
    } else {
      ctx.fillStyle = "#8fd6ee";
      ctx.fillRect(px, py, tileSize, tileSize);
    }
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

  // Roots stay exclusive to plain terrain - never drawn on either tile the skeleton's 2-cell-
  // tall sprite occupies (its own anchor tile and the one directly below), so that art shows
  // only the background material and the skeleton itself, not both competing for the same
  // square (see tiles.js _placeSkeleton, which also keeps the skeleton's candidate tiles clear
  // of the giant root's footprint for the same reason).
  const sk = map.skeletonTile;
  const isSkeletonTile = sk?.col === col && (sk?.row === row || sk?.row + 1 === row);
  if (tile === TILE.ROOT && !isSkeletonTile) {
    const overlay = pickVariant(sprites.rootOverlays, col, row, 7);
    ctx.drawImage(overlay, px, py, tileSize, tileSize);
  }
}

// The sheet has no dedicated cave/tunnel art - a dug-out cell is rendered as a darkened version
// of whatever material used to be there (see tiles.js's tunnelOrigin tracking), not a flat
// unrelated fill, so a tunnel through sand still reads as sand, just in shadow.
function _darkenedMaterialDraw(ctx, variants, col, row, px, py, tileSize) {
  if (variants) {
    ctx.drawImage(pickVariant(variants, col, row), px, py, tileSize, tileSize);
  } else {
    ctx.fillStyle = "#3a2c1c";
    ctx.fillRect(px, py, tileSize, tileSize);
  }
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(px, py, tileSize, tileSize);
}

function _drawTunnel(ctx, map, col, row, px, py, tileSize) {
  const origin = map.getTunnelOrigin(col, row);
  const material = MATERIAL_FOR_TILE[origin.id];
  const variants = material ? materials[material] : null;
  _darkenedMaterialDraw(ctx, variants, col, row, px, py, tileSize);
}

// True for a SURFACE column that's lost its support (used to tell a one-tile-wide hole from a
// wider one by checking whether either neighbor is in the same state).
function _isUnsupportedSurface(map, col, row) {
  return map.getTile(col, row) === TILE.SURFACE && !map.getTile(col, row + 1).solid;
}

function _drawBurrowMound(ctx, col, px, py, tileSize) {
  const rng = mulberry32(col * 9187 + 31);
  const img = burrowMoundSprites[Math.floor(rng() * burrowMoundSprites.length)];
  ctx.drawImage(img, px, py, tileSize, tileSize);
}

// The edge of an opening 2+ tiles wide: burrow_wide is drawn at the same native scale as every
// other terrain sprite (no stretching), then masked to just its left or right half - the left
// half shows on the opening's left edge, the right half on its right edge. Sky-blue fill first
// since the sprite's own transparent margins would otherwise let the decorative background
// hills bleed through.
function _drawBurrowWideHalf(ctx, px, py, tileSize, side) {
  ctx.fillStyle = "#8fd6ee";
  ctx.fillRect(px, py, tileSize, tileSize);
  const halfW = tileSize / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(side === "left" ? px : px + halfW, py, halfW, tileSize);
  ctx.clip();
  ctx.drawImage(burrowWideSprite, px, py, tileSize, tileSize);
  ctx.restore();
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

// Renders a tile that's had one triangular half opened up by a diagonal dig: darken the whole
// cell first (that becomes the open half), then clip to the remaining solid triangle and paint
// the material there at full brightness - the boundary is a single straight 45 degree line,
// continuous with the neighboring tiles' own cuts.
function _drawDiagonalTile(ctx, variants, col, row, cornerCut, px, py, tileSize) {
  // The open half is the current (not-yet-dug) tile's own material darkened, not a lookup -
  // cutting a corner doesn't change the tile's identity, only digOut does.
  _darkenedMaterialDraw(ctx, variants, col, row, px, py, tileSize);
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

// root_giant's own art doesn't taper to a point at the exact horizontal center of its 6-tile
// canvas - measured directly from the extracted sprite (topmost opaque row's x-midpoint is at
// pixel 155.5 of 384), as the fraction of the sprite's own width from its left edge to where
// it connects to the trunk. Centering the whole bounding box instead (as if it were symmetric)
// would visibly offset the root from the trunk it's supposed to grow out of.
const ROOT_GIANT_TRUNK_FRACTION = 155.5 / 384;

/**
 * Rare buried decorations that draw well outside their own tile's cell - the skeleton (2
 * cells tall) and the giant root system under a large tree's trunk (6x5 cells). Same
 * separate-pass reasoning as drawSurfaceDecorations: drawn after the whole terrain loop so
 * later rows/columns don't paint over them. Each is only drawn while its anchor tile is still
 * solid/undug, so it disappears the moment the player digs into that spot.
 */
export function drawUndergroundDecorations(ctx, map, startCol, endCol, startRow, endRow, originX, originY, tileSize) {
  const sk = map.skeletonTile;
  if (sk && sk.col >= startCol && sk.col <= endCol && sk.row >= startRow - 1 && sk.row <= endRow + 1) {
    if (map.getTile(sk.col, sk.row).solid) {
      const px = originX + sk.col * tileSize;
      const py = originY + sk.row * tileSize;
      ctx.drawImage(skeletonSprite, px, py, tileSize, tileSize * 2);
    }
  }

  const spanCols = 6, spanRows = 5;
  for (let col = startCol; col <= endCol; col++) {
    const feature = map.surfaceFeatures?.[col];
    if (feature?.type !== "tree" || feature.size !== "large") continue;
    const trunkRow = map.surfaceRow + 1;
    if (!map.getTile(col, trunkRow).solid) continue;
    // The trunk sits at world x [col,col+1), centered at col+0.5 - align the sprite's own
    // connection point (not its bounding-box center) to that, the same way a carrot's bottom
    // is centered directly under its top rather than under the middle of its whole sprite.
    const px = originX + (col + 0.5 - ROOT_GIANT_TRUNK_FRACTION * spanCols) * tileSize;
    const py = originY + trunkRow * tileSize;
    ctx.drawImage(rootGiantSprite, px, py, tileSize * spanCols, tileSize * spanRows);
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
