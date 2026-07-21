import { Game } from "./game.js";
import { loadAssets } from "./assets.js";
import { VERSION } from "./version.js";

document.getElementById("version-tag").textContent = VERSION;

const canvas = document.getElementById("game");
const sprites = await loadAssets();
new Game(canvas, sprites);
