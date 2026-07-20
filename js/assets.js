// Sprite assets, cut directly from "Holey Moley Spritesheet.png" as raw, untrimmed 64x64
// crops on the sheet's native grid - every source below is one grid cell (or, for the head/
// root pairs and worm segments, a run of adjacent cells), always starting at (0,0) and always
// at (col*64, row*64). No content-bbox trimming, no scaling, no fractional anchoring: sprites
// that span multiple tiles (flower top+root, carrot top+root, worm head/mid/tail) are just
// several full 64x64 cells meant to be drawn edge-to-edge, exactly like the terrain variants.

function terrainVariants(material) {
  return [0, 1, 2, 3].map((i) => `assets/terrain_${material}_${i}.png`);
}

const SOURCES = {
  terrainGrass: terrainVariants("grass"),
  terrainSand: terrainVariants("sand"),
  terrainSoil: terrainVariants("soil"),
  terrainDirt: terrainVariants("dirt"),
  terrainGravel: terrainVariants("gravel"),
  terrainRock: terrainVariants("rock"),
  // The randomized ROOT-tile overlay reuses the same root art drawn beneath the three rooted
  // flowers below - no separate crop needed.
  rootOverlays: [
    "assets/flower_coneflower_root.png",
    "assets/flower_daisy_white_root.png",
    "assets/flower_bellflower_root.png",
  ],
  treeTrunk: "assets/tree_trunk.png",
  bushDark: "assets/bush_dark.png",
  bushFlowering: "assets/bush_flowering.png",
  flowerDaisyYellow: "assets/flower_daisy_yellow.png",
  flowerConeflowerTop: "assets/flower_coneflower_top.png",
  flowerConeflowerRoot: "assets/flower_coneflower_root.png",
  flowerDaisyWhiteTop: "assets/flower_daisy_white_top.png",
  flowerDaisyWhiteRoot: "assets/flower_daisy_white_root.png",
  flowerBellflowerTop: "assets/flower_bellflower_top.png",
  flowerBellflowerRoot: "assets/flower_bellflower_root.png",
  carrotTop: "assets/carrot_top.png",
  carrotRoot: "assets/carrot_root.png",
  wormHead: "assets/worm_head.png",
  wormMid: "assets/worm_mid.png",
  wormTail: "assets/worm_tail.png",
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
