// Sprite assets, cut from assets/../"Holey Moley Spritesheet.png" (see assets/ dir - each
// file here is one already-extracted, already-trimmed piece of that sheet). Terrain bands
// were additionally reprocessed into seamlessly-tileable swatches (see the offset+blend
// preprocessing used to produce them) so they can be sampled the same way the old
// procedurally-drawn swatches were: continuous world-space coordinates, no visible seams.

const SOURCES = {
  dirtSoft: "assets/dirt_soft.png",
  dirtMedium: "assets/dirt_medium.png",
  dirtHard: "assets/dirt_hard.png",
  rootBase: "assets/root_base.png",
  rock: "assets/rock.png",
  grassStrip: "assets/grass_strip.png",
  treeTrunk: "assets/tree_trunk.png",
  bushDark: "assets/bush_dark.png",
  bushFlowering: "assets/bush_flowering.png",
  flowerDaisyYellow: "assets/flower_daisy_yellow.png",
  flowerConeflower: "assets/flower_coneflower.png",
  flowerDaisyWhite: "assets/flower_daisy_white.png",
  flowerBellflower: "assets/flower_bellflower.png",
  carrot: "assets/carrot.png",
  worm: "assets/worm.png",
};

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load sprite: ${src}`));
    img.src = src;
  });
}

let loaded = null;

/** Resolves once every sprite is loaded, to a map of the same keys as SOURCES. */
export function loadAssets() {
  if (loaded) return loaded;
  loaded = Promise.all(
    Object.entries(SOURCES).map(async ([key, src]) => [key, await loadImage(src)])
  ).then((pairs) => Object.fromEntries(pairs));
  return loaded;
}
