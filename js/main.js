import { Game } from "./game.js";
import { loadAssets } from "./assets.js";

const canvas = document.getElementById("game");
const sprites = await loadAssets();
new Game(canvas, sprites);
