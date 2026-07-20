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
  flowerSprites = [
    { img: sprites.flowerDaisyYellow, collar: 1 },
    { img: sprites.flowerConeflower, collar: 0.4 },
    { img: sprites.flowerDaisyWhite, collar: 0.4 },
    { img: sprites.flowerBellflower, collar: 0.42 },
  ];
  bushSprites = [sprites.bushDark, sprites.bushFlowering];
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
    const oh = tileSize * 1.1;
    const ow = oh * (overlay.naturalWidth / overlay.naturalHeight);
    ctx.drawImage(overlay, px + tileSize / 2 - ow / 2, py - tileSize * 0.05, ow, oh);
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
  if (feature?.type === "tree") _drawTreeBase(ctx, col, px, py, tileSize, feature.size);
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

// Anchors a sprite so its "collar" point (where stem/trunk meets the ground, as a fraction
// of the image's own height, 0=top 1=bottom) lands on the ground line. The ground line is
// the BOTTOM of the grass tile (grass art fills the whole 64x64 cell, walkable ground at
// its bottom edge) - same reference point every decoration and the mole/bugs use.
// `img` may be an <img> (naturalWidth/Height) or an offscreen <canvas> (width/height).
function _drawAnchored(ctx, img, cx, groundY, dispH, collarFrac) {
  const w = img.naturalWidth ?? img.width;
  const h = img.naturalHeight ?? img.height;
  const dispW = dispH * (w / h);
  const destY = groundY - dispH * collarFrac;
  ctx.drawImage(img, cx - dispW / 2, destY, dispW, dispH);
}

const TREE_HEIGHTS = { small: 0.95, medium: 1.25, large: 1.55 };

function _drawTreeBase(ctx, col, px, py, tileSize, size) {
  const rng = mulberry32(col * 51197 + 3);
  const cx = px + tileSize / 2 + (rng() - 0.5) * tileSize * 0.1;
  const groundY = py + tileSize;
  const dispH = tileSize * (TREE_HEIGHTS[size] || TREE_HEIGHTS.small);
  _drawAnchored(ctx, sprites.treeTrunk, cx, groundY, dispH, 0.92);
}

function _drawBush(ctx, col, px, py, tileSize) {
  const rng = mulberry32(col * 7639 + 11);
  const img = bushSprites[Math.floor(rng() * bushSprites.length)];
  const cx = px + tileSize / 2;
  const groundY = py + tileSize;
  const dispH = tileSize * (0.85 + rng() * 0.15);
  _drawAnchored(ctx, img, cx, groundY, dispH, 0.88);
}

function _drawFlower(ctx, col, px, py, tileSize) {
  const rng = mulberry32(col * 26113 + 5);
  const spec = flowerSprites[Math.floor(rng() * flowerSprites.length)];
  const cx = px + tileSize / 2 + (rng() - 0.5) * tileSize * 0.3;
  const groundY = py + tileSize;
  const dispH = tileSize * (spec.collar === 1 ? 0.85 : 1.3);
  _drawAnchored(ctx, spec.img, cx, groundY, dispH, spec.collar);
}

const VEGGIE_TINT = {
  CARROT: null,
  BEET: "rgba(107,58,130,0.45)",
  TURNIP: "rgba(230,225,215,0.5)",
};

let tintedVeggieCache = null;

// BEET/TURNIP reuse the carrot art with a tint. Tinting has to happen on an isolated
// offscreen copy of just the sprite - using source-atop directly on the main canvas would
// composite against whatever's already painted there (sky, dirt), washing out a whole
// rectangle instead of just the carrot's own silhouette. Built once and cached.
function _getTintedVeggieImage(veggieType) {
  const tint = VEGGIE_TINT[veggieType];
  if (!tint) return sprites.carrot;
  tintedVeggieCache ||= {};
  if (tintedVeggieCache[veggieType]) return tintedVeggieCache[veggieType];

  const img = sprites.carrot;
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const cctx = c.getContext("2d");
  cctx.drawImage(img, 0, 0);
  cctx.globalCompositeOperation = "source-atop";
  cctx.fillStyle = tint;
  cctx.fillRect(0, 0, c.width, c.height);
  tintedVeggieCache[veggieType] = c;
  return c;
}

// The carrot art already has both the greens (top) and root (bottom) in one image, with a
// "collar" where they meet at roughly 28% down from the top - lining that up with the grass
// line puts the greens above ground and the root hanging into the tile below, exactly
// matching the "body under the grass, greens above" layout, spanning ~2 tiles tall.
function _drawVeggieGreens(ctx, col, px, py, tileSize, veggieType) {
  const rng = mulberry32(col * 91771 + 41);
  const img = _getTintedVeggieImage(veggieType);
  const cx = px + tileSize / 2 + (rng() - 0.5) * tileSize * 0.15;
  const groundY = py + tileSize;
  const dispH = tileSize * 1.95;
  _drawAnchored(ctx, img, cx, groundY, dispH, 0.28);
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
