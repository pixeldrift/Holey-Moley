import { TILE, MOVE_ACTION } from "./tiles.js";

const WALK_DURATION = 220;
const CLIMB_DURATION = 260;
const WALK_ENERGY = 0.5;
const CLIMB_ENERGY = 1.2;
const EAT_DURATION = 350;
const FOOD_ENERGY = 28;
const FOOD_SCORE = 15;
const DIG_SCORE = { DIRT_SOFT: 2, DIRT_MEDIUM: 4, DIRT_HARD: 8, ROOT: 14, GRASS: 1 };

export const MAX_ENERGY = 100;

export class Mole {
  constructor(tileMap, startCol, startRow) {
    this.map = tileMap;
    this.col = startCol;
    this.row = startRow;
    this.px = startCol; // position in tile units (float, for smooth interpolation)
    this.py = startRow;
    this.facing = "right"; // 'left' | 'right'
    this.state = "idle"; // idle | walk | climb | dig | eat | exhausted | blocked
    this.energy = MAX_ENERGY;
    this.score = 0;
    this.actionElapsed = 0;
    this.actionDuration = 0;
    this.actionTarget = null; // {col,row}
    this.actionType = null;
    this.bumpTimer = 0;
    this.eatTimer = 0;
    this.onScoreChange = null;
    this.onEnergyChange = null;
    this.onEvent = null; // (name, data) for HUD toasts / juice
  }

  get isBusy() {
    return this.actionTarget !== null;
  }

  /** Request movement in a grid direction. Ignored if already mid-action or direction invalid. */
  requestMove(dx, dy) {
    if (this.isBusy) return;
    if (dx === 0 && dy === 0) return;
    if (dx !== 0) dy = 0; // cardinal only, prioritize horizontal if diagonal sneaks in

    const targetCol = this.col + dx;
    const targetRow = this.row + dy;
    if (!this.map.inBounds(targetCol, targetRow)) return;
    if (targetRow < this.map.skyRows) return; // can't fly into the sky

    if (dx > 0) this.facing = "right";
    if (dx < 0) this.facing = "left";

    const targetTile = this.map.getTile(targetCol, targetRow);

    if (targetTile.solid) {
      if (!targetTile.diggable) {
        this._bump();
        return;
      }
      const cost = targetTile.digEnergyCost;
      if (this.energy < cost * 0.4) {
        this._bump();
        this.state = "exhausted";
        this.onEvent?.("exhausted");
        return;
      }
      this._beginAction(MOVE_ACTION.DIG, targetCol, targetRow, targetTile.digDuration, cost, targetTile);
      return;
    }

    // Open space: climbing if vertical move, walking if horizontal.
    const isVertical = dy !== 0;
    const duration = isVertical ? CLIMB_DURATION : WALK_DURATION;
    const cost = isVertical ? CLIMB_ENERGY : WALK_ENERGY;
    if (this.energy < cost) {
      this.state = "exhausted";
      return;
    }
    this._beginAction(isVertical ? MOVE_ACTION.CLIMB : MOVE_ACTION.WALK, targetCol, targetRow, duration, cost, targetTile);
  }

  _beginAction(type, col, row, duration, energyCost, tile) {
    this.actionType = type;
    this.actionTarget = { col, row, tile };
    this.actionDuration = duration;
    this.actionElapsed = 0;
    this._pendingEnergyCost = energyCost;
    this.state = type === MOVE_ACTION.DIG ? "dig" : type === MOVE_ACTION.CLIMB ? "climb" : "walk";
  }

  _bump() {
    this.bumpTimer = 220;
    this.onEvent?.("bump");
  }

  _spendEnergy(amount) {
    this.energy = Math.max(0, this.energy - amount);
    this.onEnergyChange?.(this.energy);
  }

  _addScore(amount) {
    if (amount <= 0) return;
    this.score += amount;
    this.onScoreChange?.(this.score);
  }

  update(dt) {
    if (this.bumpTimer > 0) this.bumpTimer = Math.max(0, this.bumpTimer - dt);
    if (this.eatTimer > 0) {
      this.eatTimer -= dt;
      if (this.eatTimer <= 0) this.state = "idle";
    }

    if (this.actionTarget) {
      this.actionElapsed += dt;
      const t = Math.min(1, this.actionElapsed / this.actionDuration);
      this.px = lerp(this.col, this.actionTarget.col, easeInOutQuad(t));
      this.py = lerp(this.row, this.actionTarget.row, easeInOutQuad(t));

      if (t >= 1) {
        this._completeAction();
      }
      return;
    }

    // idle drift toward exact tile (snap) + passive tiny energy regen while idle
    this.px = this.col;
    this.py = this.row;
    if (this.state !== "eat") {
      this.state = this.energy <= 0 ? "exhausted" : "idle";
    }
  }

  _completeAction() {
    const { col, row, tile } = this.actionTarget;

    if (this.actionType === MOVE_ACTION.DIG) {
      this.map.digOut(col, row);
      this._addScore(DIG_SCORE[tile.id] ?? 1);
    }

    this._spendEnergy(this._pendingEnergyCost);

    this.col = col;
    this.row = row;
    this.px = col;
    this.py = row;
    this.actionTarget = null;
    this.actionType = null;

    if (this.map.consumeFood(col, row)) {
      this._eatFood();
    } else {
      this.state = this.energy <= 0 ? "exhausted" : "idle";
    }
  }

  _eatFood() {
    this.energy = Math.min(MAX_ENERGY, this.energy + FOOD_ENERGY);
    this.onEnergyChange?.(this.energy);
    this._addScore(FOOD_SCORE);
    this.state = "eat";
    this.eatTimer = EAT_DURATION;
    this.onEvent?.("eat", { col: this.col, row: this.row });
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// ---------------------------------------------------------------------------
// Procedural mole sprite. No image assets yet - this draws the mole and its
// walk/dig/climb/eat animation cycles with canvas primitives. Swap the body
// of drawMole() for spritesheet blitting later without changing Mole's API.
// ---------------------------------------------------------------------------

export function drawMole(ctx, mole, screenX, screenY, tileSize, nowMs) {
  const t = nowMs / 1000;
  const flip = mole.facing === "left" ? -1 : 1;
  const bump = mole.bumpTimer > 0 ? Math.sin(mole.bumpTimer / 220 * Math.PI) * 4 : 0;

  ctx.save();
  ctx.translate(screenX + tileSize / 2 + bump * -flip, screenY + tileSize / 2);

  const isVertical = mole.actionType === MOVE_ACTION.CLIMB;
  if (isVertical) {
    // Orient body vertically while climbing.
    ctx.rotate(mole.py < mole.row || (mole.actionTarget && mole.actionTarget.row < mole.row) ? -Math.PI / 2 : Math.PI / 2);
  }
  ctx.scale(flip, 1);

  const cycle = (t * 6) % (Math.PI * 2);
  const bob = mole.state === "walk" || mole.state === "climb" ? Math.sin(cycle) * 2.2 : Math.sin(t * 2) * 1.2;
  const s = tileSize / 48; // base art at 48px tile

  ctx.translate(0, bob * s);

  const bodyColor = "#8b6f47";
  const bellyColor = "#e6cfa0";
  const darkColor = "#5c4529";

  // Legs (behind body), animate paw swipe when digging.
  ctx.fillStyle = darkColor;
  const legSwing = mole.state === "dig" ? Math.sin(t * 18) * 6 : Math.sin(cycle) * 5;
  drawLeg(ctx, -10 * s, 10 * s, legSwing * s, s);
  drawLeg(ctx, 10 * s, 10 * s, -legSwing * s, s);

  // Tail
  ctx.strokeStyle = darkColor;
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.moveTo(-14 * s, 2 * s);
  ctx.quadraticCurveTo(-22 * s, 6 * s, -20 * s, -4 * s);
  ctx.stroke();

  // Body
  ctx.fillStyle = bodyColor;
  ctx.beginPath();
  ctx.ellipse(0, 0, 16 * s, 12 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // Belly
  ctx.fillStyle = bellyColor;
  ctx.beginPath();
  ctx.ellipse(1 * s, 3 * s, 10 * s, 7 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // Snout
  const snoutStretch = mole.state === "eat" ? 2 * s : 0;
  ctx.fillStyle = "#d98a9a";
  ctx.beginPath();
  ctx.ellipse(15 * s + snoutStretch, 2 * s, 5 * s, 3.5 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // Eyes
  ctx.fillStyle = "#241a12";
  ctx.beginPath();
  ctx.arc(7 * s, -4 * s, 1.6 * s, 0, Math.PI * 2);
  ctx.fill();

  // Ear
  ctx.fillStyle = darkColor;
  ctx.beginPath();
  ctx.arc(-2 * s, -10 * s, 3 * s, 0, Math.PI * 2);
  ctx.fill();

  // Front paws - big swipe animation while digging, chew motion while eating.
  ctx.fillStyle = "#c9a876";
  if (mole.state === "dig") {
    const swipe = (Math.sin(t * 18) + 1) / 2;
    drawPaw(ctx, 12 * s + swipe * 6 * s, -2 * s + swipe * 4 * s, s);
    drawPaw(ctx, 12 * s - swipe * 4 * s, 2 * s - swipe * 2 * s, s);
  } else if (mole.state === "eat") {
    const chew = (Math.sin(t * 14) + 1) / 2;
    drawPaw(ctx, 14 * s, -1 * s - chew * 2 * s, s);
    drawPaw(ctx, 14 * s, 3 * s + chew * 1 * s, s);
  } else if (mole.state === "climb") {
    const reach = Math.sin(cycle);
    drawPaw(ctx, 8 * s, -8 * s + reach * 3 * s, s);
    drawPaw(ctx, -6 * s, 8 * s - reach * 3 * s, s);
  } else {
    drawPaw(ctx, 13 * s, 4 * s, s);
  }

  // Dirt crumb particles while digging.
  if (mole.state === "dig") {
    ctx.fillStyle = "#7a4d2a";
    for (let i = 0; i < 3; i++) {
      const a = t * 10 + i * 2.1;
      const dist = 16 + (i * 3);
      const px = Math.cos(a) * dist * 0.3 * s + 18 * s;
      const py = Math.sin(a * 1.7) * 6 * s - 2 * s;
      ctx.beginPath();
      ctx.arc(px, py, 1.6 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();

  // Exhausted indicator (drawn unrotated, above head)
  if (mole.state === "exhausted") {
    ctx.save();
    ctx.font = `${14 * s}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("😮‍💨", screenX + tileSize / 2, screenY - 4);
    ctx.restore();
  }
}

function drawLeg(ctx, x, y, swing, s) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((swing / 20));
  ctx.fillRect(-2.5 * s, 0, 5 * s, 8 * s);
  ctx.restore();
}

function drawPaw(ctx, x, y, s) {
  ctx.beginPath();
  ctx.ellipse(x, y, 4.5 * s, 3.5 * s, 0, 0, Math.PI * 2);
  ctx.fill();
}
