// Sprite assets, cut directly from "Holey Moley Spritesheet.png" with no further processing
// (no blur, no seamless-ification) - the terrain rows are already independently-tileable
// 64x64 variants by design, so each material just needs several of them to pick between at
// random per grid cell instead of one texture stretched everywhere.

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
  rootOverlays: [
    "assets/root_overlay_0.png",
    "assets/root_overlay_1.png",
    "assets/root_overlay_2.png",
  ],
  treeTrunk: "assets/tree_trunk.png",
  bushDark: "assets/bush_dark.png",
  bushFlowering: "assets/bush_flowering.png",
  flowerDaisyYellow: "assets/flower_daisy_yellow.png",
  flowerConeflower: "assets/flower_coneflower.png",
  flowerDaisyWhite: "assets/flower_daisy_white.png",
  flowerBellflower: "assets/flower_bellflower.png",
  carrot: "assets/carrot.png",
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
