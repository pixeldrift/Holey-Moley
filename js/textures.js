// Procedural terrain textures.
//
// There's no image-generation tool in this pipeline, so "photo-realistic" isn't literally
// achievable - what this module does instead is build richly mottled, non-repeating-looking
// material textures out of layered noise blobs (rendered once to offscreen canvases), then
// sample them per-tile with a randomized crop/rotation so adjacent same-type tiles don't look
// stamped. Material boundaries get a soft gradient "melt" instead of a hard edge, and tile
// draws are pixel-rounded + slightly overdrawn so there are no seam/grid-line artifacts.

import { TILE, CORNER } from "./tiles.js";

const SWATCH_SIZE = 160;

const PALETTES = {
  DIRT_SOFT: { base: "#8a5a34", dark: "#6e4527", light: "#a06f45", fleck: "#563a20" },
  DIRT_MEDIUM: { base: "#77492b", dark: "#5c3620", light: "#8c5c38", fleck: "#452c18" },
  DIRT_HARD: { base: "#5f3a22", dark: "#472a18", light: "#734830", fleck: "#33200f" },
  ROOT: { base: "#8a5a34", dark: "#6e4527", light: "#a06f45", fleck: "#c99a53" },
  ROCK: { base: "#787878", dark: "#5c5c5c", light: "#949494", fleck: "#484848" },
  SURFACE: { base: "#5fa832", dark: "#4c8a27", light: "#7bc94a", fleck: "#3f7020" },
  TUNNEL: { base: "#241a12", dark: "#160f0a", light: "#31241a", fleck: "#0f0a06" },
};

const AVG_COLOR = {
  DIRT_SOFT: "#835435", DIRT_MEDIUM: "#6f4529", DIRT_HARD: "#583621",
  ROOT: "#8a5a34", ROCK: "#787878",
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

// Draws at (x,y) plus every wrapped copy that could bleed into the [0,SWATCH_SIZE) canvas,
// so the resulting unit tiles perfectly with itself - no seam when it repeats.
function wrapDraw(x, y, margin, draw) {
  for (const ox of [-SWATCH_SIZE, 0, SWATCH_SIZE]) {
    for (const oy of [-SWATCH_SIZE, 0, SWATCH_SIZE]) {
      const ex = x + ox, ey = y + oy;
      if (ex > -margin && ex < SWATCH_SIZE + margin && ey > -margin && ey < SWATCH_SIZE + margin) {
        draw(ex, ey);
      }
    }
  }
}

function buildSwatch(palette, seed, rocky) {
  const c = document.createElement("canvas");
  c.width = SWATCH_SIZE;
  c.height = SWATCH_SIZE;
  const ctx = c.getContext("2d");
  const rng = mulberry32(seed);

  ctx.fillStyle = palette.base;
  ctx.fillRect(0, 0, SWATCH_SIZE, SWATCH_SIZE);

  // Layered soft blobs for organic mottling. Wrapped so the unit tiles seamlessly.
  const blobCount = rocky ? 14 : 26;
  for (let i = 0; i < blobCount; i++) {
    const x = rng() * SWATCH_SIZE;
    const y = rng() * SWATCH_SIZE;
    const r = (rocky ? 14 + rng() * 30 : 8 + rng() * 22);
    const shade = rng() < 0.5 ? palette.dark : palette.light;
    wrapDraw(x, y, r, (ex, ey) => {
      const grad = ctx.createRadialGradient(ex, ey, 0, ex, ey, r);
      grad.addColorStop(0, hexAlpha(shade, rocky ? 0.35 : 0.22));
      grad.addColorStop(1, hexAlpha(shade, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(ex, ey, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Fine grit flecks.
  ctx.fillStyle = palette.fleck;
  const fleckCount = rocky ? 40 : 70;
  for (let i = 0; i < fleckCount; i++) {
    const x = rng() * SWATCH_SIZE;
    const y = rng() * SWATCH_SIZE;
    const size = 1 + rng() * (rocky ? 3 : 2);
    ctx.globalAlpha = 0.35 + rng() * 0.35;
    wrapDraw(x, y, size, (ex, ey) => ctx.fillRect(ex, ey, size, size));
  }
  ctx.globalAlpha = 1;

  // Subtle sedimentary striations - periodic in x already, so they wrap on their own.
  if (!rocky) {
    ctx.strokeStyle = hexAlpha(palette.dark, 0.15);
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 4; i++) {
      const y = rng() * SWATCH_SIZE;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= SWATCH_SIZE; x += 20) {
        ctx.lineTo(x, y + Math.sin((x / SWATCH_SIZE) * Math.PI * 2 + i) * 4);
      }
      ctx.stroke();
    }
  }

  // Tile the seamless unit 2x2 so any tileSize-wide crop starting anywhere within
  // [0, SWATCH_SIZE) never runs off the edge of the canvas.
  const field = document.createElement("canvas");
  field.width = SWATCH_SIZE * 2;
  field.height = SWATCH_SIZE * 2;
  const fctx = field.getContext("2d");
  for (const ox of [0, SWATCH_SIZE]) {
    for (const oy of [0, SWATCH_SIZE]) {
      fctx.drawImage(c, ox, oy);
    }
  }
  return field;
}

function hexAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

let swatches = null;
function getSwatches() {
  if (swatches) return swatches;
  swatches = {
    DIRT_SOFT: buildSwatch(PALETTES.DIRT_SOFT, 101, false),
    DIRT_MEDIUM: buildSwatch(PALETTES.DIRT_MEDIUM, 202, false),
    DIRT_HARD: buildSwatch(PALETTES.DIRT_HARD, 303, false),
    ROOT: buildSwatch(PALETTES.ROOT, 404, false),
    ROCK: buildSwatch(PALETTES.ROCK, 505, true),
    SURFACE: buildSwatch(PALETTES.SURFACE, 101, false),
    TUNNEL: buildSwatch(PALETTES.TUNNEL, 606, true),
  };
  return swatches;
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
  const swatches = getSwatches();
  const swatch = swatches[tile.id];
  const px = Math.round(x);
  const py = Math.round(y);
  const overdraw = tileSize + 1;

  const cornerCut = tile.diggable ? map.getCornerCut(col, row) : CORNER.NONE;
  if (cornerCut !== CORNER.NONE) {
    _drawDiagonalTile(ctx, swatches, swatch, cornerCut, col, row, px, py, tileSize, overdraw);
    return;
  }

  if (swatch) {
    // Sample using continuous world-space coordinates (not a per-tile random crop) so the
    // texture flows unbroken from one tile into the next instead of looking patchworked.
    const sx = ((col * tileSize) % SWATCH_SIZE + SWATCH_SIZE) % SWATCH_SIZE;
    const sy = ((row * tileSize) % SWATCH_SIZE + SWATCH_SIZE) % SWATCH_SIZE;
    ctx.drawImage(swatch, sx, sy, tileSize, tileSize, px, py, overdraw, overdraw);
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
    _drawGrassBlades(ctx, col, px, py, tileSize);
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
function _drawDiagonalTile(ctx, swatches, swatch, cornerCut, col, row, px, py, tileSize, overdraw) {
  ctx.drawImage(swatches.TUNNEL, 0, 0, tileSize, tileSize, px, py, overdraw, overdraw);
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

  const sx = ((col * tileSize) % SWATCH_SIZE + SWATCH_SIZE) % SWATCH_SIZE;
  const sy = ((row * tileSize) % SWATCH_SIZE + SWATCH_SIZE) % SWATCH_SIZE;
  ctx.drawImage(swatch, sx, sy, tileSize, tileSize, px, py, overdraw, overdraw);
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

// The surface tile is a full grass block now (not dirt with a thin cap) - these tufts just
// give its top edge some texture, poking slightly above the tile boundary into the sky.
function _drawGrassBlades(ctx, col, px, py, tileSize) {
  const rng = mulberry32(col * 92821 + 17);
  ctx.fillStyle = "#3f7020";
  const bladeCount = 6;
  for (let i = 0; i < bladeCount; i++) {
    const bx = px + (i + 0.5) * (tileSize / bladeCount) + (rng() - 0.5) * 4;
    const bh = tileSize * (0.14 + rng() * 0.12);
    const lean = (rng() - 0.5) * 6;
    ctx.beginPath();
    ctx.moveTo(bx - 1.5, py);
    ctx.quadraticCurveTo(bx + lean, py - bh * 0.6, bx + lean * 0.6, py - bh);
    ctx.quadraticCurveTo(bx + lean, py - bh * 0.6, bx + 1.5, py);
    ctx.closePath();
    ctx.fill();
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

const TREE_SIZES = {
  small: { trunkW: 0.42, trunkH: 0.9, flare: 1.3 },
  medium: { trunkW: 0.58, trunkH: 1.15, flare: 1.45 },
  large: { trunkW: 0.78, trunkH: 1.4, flare: 1.6 },
};

function _drawTreeBase(ctx, col, px, py, tileSize, size) {
  const rng = mulberry32(col * 51197 + 3);
  const spec = TREE_SIZES[size] || TREE_SIZES.small;
  const cx = px + tileSize / 2 + (rng() - 0.5) * tileSize * 0.15;
  const w = tileSize * spec.trunkW;
  const h = tileSize * spec.trunkH;
  const flare = w * spec.flare;

  ctx.fillStyle = "#5a4229";
  ctx.beginPath();
  ctx.moveTo(cx - flare / 2, py + tileSize * 0.1);
  ctx.quadraticCurveTo(cx - w / 2, py - h * 0.3, cx - w / 2, py - h);
  ctx.lineTo(cx + w / 2, py - h);
  ctx.quadraticCurveTo(cx + w / 2, py - h * 0.3, cx + flare / 2, py + tileSize * 0.1);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(0,0,0,0.18)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.12, py - h * 0.15);
  ctx.lineTo(cx - w * 0.12, py - h * 0.85);
  ctx.stroke();
}

function _drawBush(ctx, col, px, py, tileSize) {
  const rng = mulberry32(col * 7639 + 11);
  const cx = px + tileSize / 2;
  const baseY = py + tileSize * 0.05;
  ctx.fillStyle = "#3f7d2c";
  for (let i = 0; i < 3; i++) {
    const bx = cx + (i - 1) * tileSize * 0.22 + (rng() - 0.5) * 6;
    const r = tileSize * (0.2 + rng() * 0.08);
    ctx.beginPath();
    ctx.arc(bx, baseY - r * 0.7, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#57a83f";
  ctx.beginPath();
  ctx.arc(cx, baseY - tileSize * 0.22, tileSize * 0.16, 0, Math.PI * 2);
  ctx.fill();
}

const FLOWER_COLORS = ["#e85d75", "#f2c94c", "#ffffff", "#c77dff"];

function _drawFlower(ctx, col, px, py, tileSize) {
  const rng = mulberry32(col * 26113 + 5);
  const cx = px + tileSize / 2 + (rng() - 0.5) * tileSize * 0.4;
  const baseY = py;
  const stemH = tileSize * 0.22;

  ctx.strokeStyle = "#4c8a27";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, baseY);
  ctx.lineTo(cx, baseY - stemH);
  ctx.stroke();

  const color = FLOWER_COLORS[Math.floor(rng() * FLOWER_COLORS.length)];
  ctx.fillStyle = color;
  const petalR = tileSize * 0.06;
  const cy = baseY - stemH;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * petalR, cy + Math.sin(a) * petalR, petalR * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#f2c94c";
  ctx.beginPath();
  ctx.arc(cx, cy, petalR * 0.7, 0, Math.PI * 2);
  ctx.fill();
}

const VEGGIE_GREEN_COLORS = {
  CARROT: "#4c8a27",
  BEET: "#5a3a6b",
  TURNIP: "#4c8a27",
};

function _drawVeggieGreens(ctx, col, px, py, tileSize, veggieType) {
  const rng = mulberry32(col * 91771 + 41);
  const cx = px + tileSize / 2;
  const color = VEGGIE_GREEN_COLORS[veggieType] || "#4c8a27";
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  const bladeCount = 4;
  for (let i = 0; i < bladeCount; i++) {
    const bx = cx + (i - (bladeCount - 1) / 2) * 4 + (rng() - 0.5) * 3;
    const bh = tileSize * (0.22 + rng() * 0.1);
    const lean = (rng() - 0.5) * 8;
    ctx.beginPath();
    ctx.moveTo(bx, py);
    ctx.quadraticCurveTo(bx + lean * 0.6, py - bh * 0.6, bx + lean, py - bh);
    ctx.stroke();
  }
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
