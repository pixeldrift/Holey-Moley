import { TileMap, TILE } from "./tiles.js";
import { Mole, drawMole } from "./mole.js";
import { InputController } from "./input.js";
import { HUD } from "./hud.js";
import { CreatureManager, drawCreature } from "./creatures.js";
import { drawTerrainTile, drawBackgroundHills } from "./textures.js";

const TILE_SIZE = 48;
const MAP_WIDTH = 40;
const MAP_HEIGHT = 90;
const SKY_ROWS = 3;

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.hud = new HUD();
    this.state = "menu"; // menu | playing | paused
    this.camera = { x: 0, y: 0 };
    this.lastTime = 0;
    this._resizeObserverBound = () => this.resize();

    this._newMap();
    this.input = new InputController(canvas, {
      getMoleScreenPos: () => this._moleScreenPos(),
    });
    this.input.onStep = (dx, dy) => {
      if (this.state === "playing") this.mole.requestMove(dx, dy);
    };

    this._bindHud();
    this.resize();
    window.addEventListener("resize", this._resizeObserverBound);

    requestAnimationFrame((t) => this._loop(t));
  }

  _newMap() {
    this.map = new TileMap(MAP_WIDTH, MAP_HEIGHT, { skyRows: SKY_ROWS });
    this.mole = new Mole(this.map, Math.floor(MAP_WIDTH / 2), this.map.surfaceRow);
    this.mole.onScoreChange = (score) => this.hud.setScore(score);
    this.mole.onEnergyChange = (energy) => this.hud.setEnergy(energy);
    this.creatures = new CreatureManager(this.map, this.mole.col);
    this.camera.x = this.mole.col * TILE_SIZE;
    this.camera.y = this.mole.row * TILE_SIZE;
    this.hud.setScore(0);
    this.hud.setEnergy(this.mole.energy);
    this.hud.setDepth(0);
  }

  _bindHud() {
    this.hud.bind();
    this.hud.on("play", () => this.start());
    this.hud.on("pause", () => (this.state === "playing" ? this.pause() : this.resume()));
    this.hud.on("resume", () => this.resume());
    this.hud.on("openSettings", () => {
      this._wasPlayingBeforeSettings = this.state === "playing";
      if (this.state === "playing") this.state = "paused";
      this.hud.showSettings();
    });
    this.hud.on("closeSettings", () => {
      this.hud.hideSettings();
      if (this._wasPlayingBeforeSettings) this.state = "playing";
    });
    this.hud.on("restart", () => {
      this.hud.hideSettings();
      this._newMap();
      this.state = "playing";
      this.hud.hidePause();
      this.hud.hideStart();
    });
    this.hud.on("controlSchemeChange", (mode) => {
      this.tapToMoveOnly = mode === "tap";
    });
  }

  start() {
    this.hud.hideStart();
    this.state = "playing";
  }
  pause() {
    if (this.state !== "playing") return;
    this.state = "paused";
    this.hud.showPause();
  }
  resume() {
    this.state = "playing";
    this.hud.hidePause();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewW = w;
    this.viewH = h;
  }

  _moleScreenPos() {
    const wx = this.mole.px * TILE_SIZE + TILE_SIZE / 2;
    const wy = this.mole.py * TILE_SIZE + TILE_SIZE / 2;
    return { x: wx - this.camera.x + this.viewW / 2, y: wy - this.camera.y + this.viewH / 2 };
  }

  _loop(now) {
    const dt = Math.min(50, now - (this.lastTime || now));
    this.lastTime = now;

    if (this.state === "playing") {
      this._handleContinuousInput();
      this.mole.update(dt);
      this.creatures.update(dt, this.mole);
      this._updateCamera(dt);
      this.hud.setDepth(Math.round(this.mole.row - this.map.surfaceRow));
    }

    this._render(now);
    requestAnimationFrame((t) => this._loop(t));
  }

  _handleContinuousInput() {
    if (this.mole.isBusy) return;
    const dir = this.input.getDirection();
    if (dir.dx !== 0 || dir.dy !== 0) {
      this.mole.requestMove(dir.dx, dir.dy);
    }
  }

  _updateCamera(dt) {
    const targetX = this.mole.px * TILE_SIZE + TILE_SIZE / 2;
    const targetY = this.mole.py * TILE_SIZE + TILE_SIZE / 2;
    const smoothing = 1 - Math.pow(0.001, dt / 1000);
    this.camera.x += (targetX - this.camera.x) * smoothing;
    this.camera.y += (targetY - this.camera.y) * smoothing;
  }

  _render(now) {
    const ctx = this.ctx;
    const { viewW, viewH, camera } = this;

    // Sky backdrop
    const grad = ctx.createLinearGradient(0, 0, 0, viewH);
    grad.addColorStop(0, "#8fd6ee");
    grad.addColorStop(1, "#c9ecf7");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, viewW, viewH);

    const originX = viewW / 2 - camera.x;
    const originY = viewH / 2 - camera.y;

    // Pure-scenery rolling hills behind the surface line - not a tile, not interactive.
    drawBackgroundHills(ctx, viewW, viewH, originX, originY + this.map.surfaceRow * TILE_SIZE);

    const startCol = Math.max(0, Math.floor(-originX / TILE_SIZE) - 1);
    const endCol = Math.min(this.map.width - 1, Math.ceil((viewW - originX) / TILE_SIZE) + 1);
    const startRow = Math.max(0, Math.floor(-originY / TILE_SIZE) - 1);
    const endRow = Math.min(this.map.height - 1, Math.ceil((viewH - originY) / TILE_SIZE) + 1);

    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const tile = this.map.getTile(col, row);
        if (tile === TILE.SKY) continue;
        const x = originX + col * TILE_SIZE;
        const y = originY + row * TILE_SIZE;
        drawTerrainTile(ctx, this.map, tile, col, row, x, y, TILE_SIZE);
      }
    }

    // Creatures (culled to viewport, hidden while buried inside solid dirt).
    for (const c of this.creatures.list) {
      const checkCol = Math.round(c.px);
      const checkRow = Math.round(c.py);
      if (c.type === "WORM" && this.map.getTile(checkCol, checkRow).solid) continue;
      const x = originX + c.px * TILE_SIZE;
      const y = originY + c.py * TILE_SIZE;
      if (x < -TILE_SIZE || x > viewW + TILE_SIZE || y < -TILE_SIZE || y > viewH + TILE_SIZE) continue;
      drawCreature(ctx, c, x, y, TILE_SIZE, now);
    }

    // Mole
    const moleX = originX + this.mole.px * TILE_SIZE;
    const moleY = originY + this.mole.py * TILE_SIZE;
    drawMole(ctx, this.mole, moleX, moleY, TILE_SIZE, now);
  }
}
