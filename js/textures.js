// Terrain and scenery rendering, built from the "Holey Moley Spritesheet.png" art (see
// assets/ for the individually-cut pieces - dirt/rock/root bands, grass strip, tree trunk,
// bushes, flowers, carrot). The dirt/rock/root/grass bands were preprocessed (offline, not
// here) into seamlessly-tileable swatches, so they're sampled the same way the old
// procedurally-drawn swatches were: continuous world-space coordinates, no visible seams.
// The one exception is TUNNEL, which the sheet doesn't cover - that stays a small procedural
// dark swatch. Must call initTextures(sprites) once (with assets.js's loaded images) before
// any drawTerrainTile call.

import { TILE, CORNER } from "./tiles.js";

const AVG_COLOR = {
  DIRT_SOFT: "#886436", DIRT_MEDIUM: "#634b30", DIRT_HARD: "#554533",
  ROOT: "#4e453a", ROCK: "#555149",
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

// Tiles a seamless image 2x2 so any tileSize-wide crop starting anywhere within the image's
// own bounds never runs off the edge of the canvas (same trick the old procedural swatches used).
function buildField(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const field = document.createElement("canvas");
  field.width = w * 2;
  field.height = h * 2;
  const fctx = field.getContext("2d");
  for (const ox of [0, w]) {
    for (const oy of [0, h]) {
      fctx.drawImage(img, ox, oy);
    }
  }
  return { field, w, h };
}

// The sheet has no cave/tunnel art - build a small procedural dark swatch just for that.
function buildTunnelField() {
  const size = 96;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#241a12";
  ctx.fillRect(0, 0, size, size);
  const rng = mulberry32(606);
  ctx.fillStyle = "#0f0a06";
  for (let i = 0; i < 30; i++) {
    const x = rng() * size, y = rng() * size, s = 1 + rng() * 3;
    ctx.globalAlpha = 0.3 + rng() * 0.3;
    ctx.fillRect(x, y, s, s);
    ctx.fillRect((x + size / 2) % size, y, s, s);
    ctx.fillRect(x, (y + size / 2) % size, s, s);
    ctx.fillRect((x + size / 2) % size, (y + size / 2) % size, s, s);
  }
  ctx.globalAlpha = 1;
  const dummyImg = { naturalWidth: size, naturalHeight: size };
  const field = document.createElement("canvas");
  field.width = size * 2;
  field.height = size * 2;
  const fctx = field.getContext("2d");
  for (const ox of [0, size]) for (const oy of [0, size]) fctx.drawImage(c, ox, oy);
  return { field, w: size, h: size };
}

let sprites = null;
let fields = null;
let flowerSprites = null;
let bushSprites = null;

export function initTextures(loadedSprites) {
  sprites = loadedSprites;
  fields = {
    DIRT_SOFT: buildField(sprites.dirtSoft),
    DIRT_MEDIUM: buildField(sprites.dirtMedium),
    DIRT_HARD: buildField(sprites.dirtHard),
    ROOT: buildField(sprites.rootBase),
    ROCK: buildField(sprites.rock),
    SURFACE: buildField(sprites.dirtSoft), // grass sits directly on topsoil in the source art
    TUNNEL: buildTunnelField(),
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

const BLENDABLE = new Set(["DIRT_SOFT", "DIRT_MEDIUM", "DIRT_HARD", "ROOT", "ROCK"]);

/** Draws one terrain tile: base texture crop, then soft edge-blend toward differing neighbors. */
export function drawTerrainTile(ctx, map, tile, col, row, x, y, tileSize) {
  const swatch = fields[tile.id];
  const px = Math.round(x);
  const py = Math.round(y);
  const overdraw = tileSize + 1;

  const cornerCut = tile.diggable ? map.getCornerCut(col, row) : CORNER.NONE;
  if (cornerCut !== CORNER.NONE) {
    _drawDiagonalTile(ctx, swatch, cornerCut, col, row, px, py, tileSize, overdraw);
    return;
  }

  if (swatch) {
    // Sample using continuous world-space coordinates (not a per-tile random crop) so the
    // texture flows unbroken from one tile into the next instead of looking patchworked.
    const sx = ((col * tileSize) % swatch.w + swatch.w) % swatch.w;
    const sy = ((row * tileSize) % swatch.h + swatch.h) % swatch.h;
    ctx.drawImage(swatch.field, sx, sy, tileSize, tileSize, px, py, overdraw, overdraw);
  } else {
    ctx.fillStyle = tile.color || "#000";
    ctx.fillRect(px, py, overdraw, overdraw);
  }

  if (tile === TILE.ROOT) {
    const h = hashTile(col, row);
    const wobble = ((h % 7) - 3) * 3;
    ctx.strokeStyle = "rgba(201,154,83,0.8)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(px + 4, py + tileSize / 2);
    ctx.lineTo(px + tileSize - 4, py + tileSize / 2 + wobble);
    ctx.stroke();
  }

  if (BLENDABLE.has(tile.id)) {
    _drawEdgeBlends(ctx, map, tile, col, row, px, py, tileSize);
  }

  if (tile === TILE.SURFACE) {
    _drawGrassStrip(ctx, col, px, py, tileSize);
  }
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
// triangle and paint the material texture only inside it - the boundary between the two
// is a single straight 45 degree line, continuous with the neighboring tiles' own cuts.
function _drawDiagonalTile(ctx, swatch, cornerCut, col, row, px, py, tileSize, overdraw) {
  const tunnel = fields.TUNNEL;
  ctx.drawImage(tunnel.field, 0, 0, tileSize, tileSize, px, py, overdraw, overdraw);
  if (!swatch) return;

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

  const sx = ((col * tileSize) % swatch.w + swatch.w) % swatch.w;
  const sy = ((row * tileSize) % swatch.h + swatch.h) % swatch.h;
  ctx.drawImage(swatch.field, sx, sy, tileSize, tileSize, px, py, overdraw, overdraw);
  ctx.restore();
}

function _drawEdgeBlends(ctx, map, tile, col, row, px, py, tileSize) {
  const span = Math.max(10, tileSize * 0.4);
  const dirs = [
    { dx: 0, dy: -1, side: "top" },
    { dx: 0, dy: 1, side: "bottom" },
    { dx: -1, dy: 0, side: "left" },
    { dx: 1, dy: 0, side: "right" },
  ];
  for (const d of dirs) {
    const nt = map.getTile(col + d.dx, row + d.dy);
    if (nt === tile || !BLENDABLE.has(nt.id)) continue;
    const color = AVG_COLOR[nt.id];
    if (!color) continue;

    let grad;
    if (d.side === "top") grad = ctx.createLinearGradient(0, py, 0, py + span);
    else if (d.side === "bottom") grad = ctx.createLinearGradient(0, py + tileSize, 0, py + tileSize - span);
    else if (d.side === "left") grad = ctx.createLinearGradient(px, 0, px + span, 0);
    else grad = ctx.createLinearGradient(px + tileSize, 0, px + tileSize - span, 0);

    grad.addColorStop(0, hexAlpha(color, 0.32));
    grad.addColorStop(1, hexAlpha(color, 0));
    ctx.fillStyle = grad;

    if (d.side === "top") ctx.fillRect(px, py, tileSize, span);
    else if (d.side === "bottom") ctx.fillRect(px, py + tileSize - span, tileSize, span);
    else if (d.side === "left") ctx.fillRect(px, py, span, tileSize);
    else ctx.fillRect(px + tileSize - span, py, span, tileSize);
  }
}

// The surface tile is a full grass block; this repeats the real grass-blade strip art along
// its top edge, poking slightly above the tile boundary into the sky.
function _drawGrassStrip(ctx, col, px, py, tileSize) {
  const img = sprites.grassStrip;
  const stripH = tileSize * 0.5;
  const sx = ((col * tileSize) % img.naturalWidth + img.naturalWidth) % img.naturalWidth;
  const remaining = img.naturalWidth - sx;
  if (remaining >= tileSize) {
    ctx.drawImage(img, sx, 0, tileSize, img.naturalHeight, px, py - stripH * 0.55, tileSize, stripH);
  } else {
    ctx.drawImage(img, sx, 0, remaining, img.naturalHeight, px, py - stripH * 0.55, remaining, stripH);
    ctx.drawImage(img, 0, 0, tileSize - remaining, img.naturalHeight, px + remaining, py - stripH * 0.55, tileSize - remaining, stripH);
  }
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

// Anchors a sprite so its "collar" point (where stem/trunk meets the ground, as a fraction
// of the image's own height, 0=top 1=bottom) lands exactly on the ground line (px,py).
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
  const dispH = tileSize * (TREE_HEIGHTS[size] || TREE_HEIGHTS.small);
  _drawAnchored(ctx, sprites.treeTrunk, cx, py + tileSize * 0.08, dispH, 0.92);
}

function _drawBush(ctx, col, px, py, tileSize) {
  const rng = mulberry32(col * 7639 + 11);
  const img = bushSprites[Math.floor(rng() * bushSprites.length)];
  const cx = px + tileSize / 2;
  const dispH = tileSize * (0.85 + rng() * 0.15);
  _drawAnchored(ctx, img, cx, py + tileSize * 0.06, dispH, 0.88);
}

function _drawFlower(ctx, col, px, py, tileSize) {
  const rng = mulberry32(col * 26113 + 5);
  const spec = flowerSprites[Math.floor(rng() * flowerSprites.length)];
  const cx = px + tileSize / 2 + (rng() - 0.5) * tileSize * 0.3;
  const dispH = tileSize * (spec.collar === 1 ? 0.85 : 1.3);
  _drawAnchored(ctx, spec.img, cx, py + tileSize * 0.05, dispH, spec.collar);
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
  const dispH = tileSize * 1.95;
  // The visual ground line is the TOP of the surface tile (grass is drawn as a fringe above
  // it - see _drawGrassStrip), same anchor the tree/bush/flower decorations use below.
  const groundY = py + tileSize * 0.08;
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
