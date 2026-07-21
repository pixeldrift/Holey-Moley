// Sprite assets, cut directly from "Holey Moley Spritesheet.png" as raw, untrimmed 64x64
// crops on the sheet's native grid - every source below is one grid cell, always starting at
// (0,0) and always at (col*64, row*64). No content-bbox trimming, no scaling, no fractional
// anchoring: sprites that span multiple tiles (veggie top+bottom, worm segments) are just
// several full 64x64 cells meant to be drawn edge-to-edge.

function terrainVariants(material) {
  return [0, 1, 2, 3].map((i) => `assets/terrain_${material}_${i}.png`);
}

function frames(prefix, count) {
  return Array.from({ length: count }, (_, i) => `assets/${prefix}_${i}.png`);
}

const SOURCES = {
  terrainGrass: terrainVariants("grass"),
  terrainSand: terrainVariants("sand"),
  terrainSoil: terrainVariants("soil"),
  terrainDirt: terrainVariants("dirt"),
  terrainGravel: terrainVariants("gravel"),
  terrainRock: terrainVariants("rock"),
  // Dedicated, randomized ROOT-tile overlay art (no longer reusing flower art).
  rootOverlays: [
    "assets/root_overlay_0.png",
    "assets/root_overlay_1.png",
    "assets/root_overlay_2.png",
    "assets/root_overlay_3.png",
  ],
  treeTrunk: "assets/tree_trunk.png",
  bush01: "assets/bush_01.png",
  bush01Root: "assets/bush_01_root.png",
  bush02: "assets/bush_02.png",
  bush02Root: "assets/bush_02_root.png",
  // Single-tile flowers - the sheet no longer pairs these with their own root art (see
  // rootOverlays above for the generic root tiles used by the ROOT terrain type instead).
  flowers: [
    "assets/flower_01.png",
    "assets/flower_02.png",
    "assets/flower_03.png",
    "assets/flower_04.png",
  ],
  carrotTop: "assets/carrot_top.png",
  carrotBottom: "assets/carrot_bottom.png",
  beetTop: "assets/beet_top.png",
  beetBottom: "assets/beet_bottom.png",
  turnipTop: "assets/turnip_top.png",
  turnipBottom: "assets/turnip_bottom.png",
  cabbage: "assets/cabbage.png",
  // A grassy mound with a dark opening - used only for a surface hole exactly one tile wide
  // (see textures.js), picked randomly per column between the two variants.
  burrowMounds: ["assets/burrow_01.png", "assets/burrow_02.png"],
  wormHead: "assets/worm_head.png",
  wormMid: "assets/worm_mid.png",
  wormTail: "assets/worm_tail.png",
  wormHeadBend: "assets/worm_head_bend.png",
  wormMidBend: "assets/worm_mid_bend.png",
  wormTailBend: "assets/worm_tail_bend.png",
  antWalk: frames("ant", 6),
};

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load sprite: ${src}`));
    img.src = src;
  });
}

async function loadValue(value) {
  return Array.isArray(value) ? Promise.all(value.map(loadImage)) : loadImage(value);
}

let loaded = null;

/** Resolves once every sprite is loaded, to a map of the same keys as SOURCES (arrays of
 *  sources resolve to arrays of loaded images). */
export function loadAssets() {
  if (loaded) return loaded;
  loaded = Promise.all(
    Object.entries(SOURCES).map(async ([key, value]) => [key, await loadValue(value)])
  ).then((pairs) => Object.fromEntries(pairs));
  return loaded;
}
