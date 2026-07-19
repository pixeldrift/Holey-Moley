import { MOVE_ACTION, CORNER } from "./tiles.js";
import { ENERGY, FOOD_TYPES, FOOD_ID_TO_TYPE } from "./constants.js";

const WALK_DURATION = 220;
const CLIMB_DURATION = 260;

// Which corner of each of the two "elbow" tiles (the orthogonal neighbors flanking a
// diagonal step) gets shaved off, keyed by the move's [dx,dy]. See tiles.js CORNER.
const DIAGONAL_ELBOW_CORNERS = {
  "1,1": [CORNER.SW, CORNER.NE],
  "1,-1": [CORNER.NW, CORNER.SE],
  "-1,1": [CORNER.SE, CORNER.NW],
  "-1,-1": [CORNER.NE, CORNER.SW],
};

export const MAX_ENERGY = ENERGY.MAX;

export class Mole {
  constructor(tileMap, startCol, startRow) {
    this.map = tileMap;
    this.col = startCol;
    this.row = startRow;
    this.px = startCol; // position in tile units (float, for smooth interpolation)
    this.py = startRow;
    this.facing = "right"; // 'left' | 'right'
    this.state = "idle"; // idle | walk | climb | dig | eat | sleep
    this.energy = MAX_ENERGY;
    this.score = 0;
    this.actionElapsed = 0;
    this.actionDuration = 0;
    this.actionTarget = null; // {col,row}
    this.actionType = null;
    this.bumpTimer = 0;
    this.eatTimer = 0;
    this.hurtTimer = 0;
    this.onScoreChange = null;
    this.onEnergyChange = null;
    this.onEvent = null; // (name, data) for HUD toasts / juice
  }

  get isBusy() {
    return this.actionTarget !== null;
  }

  /** Request movement in a grid direction (8-way - diagonals dig/walk/climb too). */
  requestMove(dx, dy) {
    if (this.state === "sleep") return;
    if (this.isBusy) return;
    dx = Math.sign(dx);
    dy = Math.sign(dy);
    if (dx === 0 && dy === 0) return;

    const targetCol = this.col + dx;
    const targetRow = this.row + dy;
    if (!this.map.inBounds(targetCol, targetRow)) return;
    if (targetRow < this.map.skyRows) return; // can't fly into the sky

    if (dx > 0) this.facing = "right";
    if (dx < 0) this.facing = "left";

    // Diagonal moves cover sqrt(2) the distance of an orthogonal one - scale the travel
    // time to match so diagonal digging/walking doesn't look like it's teleporting.
    const isDiagonal = dx !== 0 && dy !== 0;
    const distanceScale = isDiagonal ? Math.SQRT2 : 1;

    const targetTile = this.map.getTile(targetCol, targetRow);

    if (targetTile.solid) {
      if (!targetTile.diggable) {
        this._bump();
        return;
      }
      this._beginAction(MOVE_ACTION.DIG, targetCol, targetRow, targetTile.digDuration * distanceScale, targetTile.digEnergyCost, targetTile);
      return;
    }

    // Open space: climbing if there's any vertical component (includes diagonals), walking if purely horizontal.
    const isVertical = dy !== 0;
    const duration = (isVertical ? CLIMB_DURATION : WALK_DURATION) * distanceScale;
    const cost = isVertical ? ENERGY.CLIMB_COST : ENERGY.WALK_COST;
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
    if (this.energy <= 0 && this.state !== "sleep") {
      this.state = "sleep";
      this.onEvent?.("sleep");
    }
  }

  _addScore(amount) {
    if (amount <= 0) return;
    this.score += amount;
    this.onScoreChange?.(this.score);
  }

  update(dt) {
    if (this.bumpTimer > 0) this.bumpTimer = Math.max(0, this.bumpTimer - dt);
    if (this.hurtTimer > 0) this.hurtTimer = Math.max(0, this.hurtTimer - dt);
    if (this.eatTimer > 0) {
      this.eatTimer -= dt;
      if (this.eatTimer <= 0 && this.state === "eat") this.state = "idle";
    }

    if (this.state === "sleep") {
      this._updateSleep(dt);
      return;
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

    this.px = this.col;
    this.py = this.row;
    if (this.state !== "eat") {
      this.state = "idle";
    }
  }

  _updateSleep(dt) {
    this.energy = Math.min(MAX_ENERGY, this.energy + (ENERGY.SLEEP_REGEN_PER_SEC * dt) / 1000);
    this.onEnergyChange?.(this.energy);
    if (this.energy >= ENERGY.WAKE_THRESHOLD) {
      this.state = "idle";
      this.onEvent?.("wake");
    }
  }

  _completeAction() {
    const { col, row, tile } = this.actionTarget;
    const dx = col - this.col;
    const dy = row - this.row;

    if (this.actionType === MOVE_ACTION.DIG) {
      this.map.digOut(col, row);
      this._addScore(tile.digScore ?? 1);
      if (dx !== 0 && dy !== 0) {
        this._carveDiagonalElbows(this.col, this.row, dx, dy);
      }
    }

    this._spendEnergy(this._pendingEnergyCost); // may put the mole to sleep

    this.col = col;
    this.row = row;
    this.px = col;
    this.py = row;
    this.actionTarget = null;
    this.actionType = null;

    const foodId = this.map.consumeFood(col, row);
    const typeKey = FOOD_ID_TO_TYPE[foodId];
    if (typeKey) {
      this._applyFood(typeKey);
    } else if (this.state !== "sleep") {
      this.state = "idle";
    }
  }

  /** Notches the two orthogonal neighbors flanking a diagonal step so the boundary between
   *  dirt and tunnel reads as one straight 45 degree line instead of a staircase. */
  _carveDiagonalElbows(fromCol, fromRow, dx, dy) {
    const [cornerA, cornerB] = DIAGONAL_ELBOW_CORNERS[`${dx},${dy}`];
    this.map.cutCorner(fromCol + dx, fromRow, cornerA);
    this.map.cutCorner(fromCol, fromRow + dy, cornerB);
  }

  _applyFood(typeKey) {
    const stats = FOOD_TYPES[typeKey];
    if (!stats) return;
    this.energy = Math.min(MAX_ENERGY, this.energy + stats.energy);
    this.onEnergyChange?.(this.energy);
    this._addScore(stats.score);
    this.state = "eat";
    this.eatTimer = stats.nibbleDuration * stats.slowFactor;
    this.onEvent?.("eat", { col: this.col, row: this.row, type: typeKey });
  }

  /** Called by the creature manager when the mole moves into a critter's cell. */
  eatCreature(typeKey) {
    this._applyFood(typeKey);
  }

  /** Called by the creature manager when an ant catches the mole from behind. */
  takeDamage(amount) {
    this._spendEnergy(amount);
    this.hurtTimer = 300;
    this.onEvent?.("hurt", { amount });
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
// walk/dig/climb/eat/sleep animation cycles with canvas primitives. Swap the
// body of drawMole() for spritesheet blitting later without changing Mole's API.
// ---------------------------------------------------------------------------

export function drawMole(ctx, mole, screenX, screenY, tileSize, nowMs) {
  const t = nowMs / 1000;
  const flip = mole.facing === "left" ? -1 : 1;
  const bump = mole.bumpTimer > 0 ? Math.sin(mole.bumpTimer / 220 * Math.PI) * 4 : 0;
  const hurtFlash = mole.hurtTimer > 0;

  if (mole.state === "sleep") {
    drawSleepingMole(ctx, mole, screenX, screenY, tileSize, t);
    return;
  }

  ctx.save();
  ctx.translate(screenX + tileSize / 2 + bump * -flip, screenY + tileSize / 2);

  const isVertical = mole.actionType === MOVE_ACTION.CLIMB;
  if (isVertical && mole.actionTarget) {
    const goingUp = mole.actionTarget.row < mole.row;
    const fullTilt = goingUp ? -Math.PI / 2 : Math.PI / 2;
    const isDiagonal = mole.actionTarget.col !== mole.col;
    ctx.rotate(isDiagonal ? fullTilt / 2 : fullTilt);
  }
  ctx.scale(flip, 1);

  const cycle = (t * 6) % (Math.PI * 2);
  const bob = mole.state === "walk" || mole.state === "climb" ? Math.sin(cycle) * 2.2 : Math.sin(t * 2) * 1.2;
  const s = tileSize / 48; // base art at 48px tile

  ctx.translate(0, bob * s);

  const bodyColor = hurtFlash ? "#c0503f" : "#8b6f47";
  const bellyColor = hurtFlash ? "#f0b3a8" : "#e6cfa0";
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
}

function drawSleepingMole(ctx, mole, screenX, screenY, tileSize, t) {
  const flip = mole.facing === "left" ? -1 : 1;
  const s = tileSize / 48;
  const cx = screenX + tileSize / 2;
  const cy = screenY + tileSize / 2;

  ctx.save();
  ctx.translate(cx, cy + 6 * s);
  ctx.scale(flip, 1);

  const breathe = 1 + Math.sin(t * 2.4) * 0.04;

  // Tail
  ctx.strokeStyle = "#5c4529";
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.moveTo(-16 * s, 2 * s);
  ctx.quadraticCurveTo(-24 * s, -2 * s, -20 * s, -8 * s);
  ctx.stroke();

  // Body lying on its side - wide flat ellipse, gently "breathing" via scale.
  ctx.save();
  ctx.translate(0, 0);
  ctx.scale(1, breathe);
  ctx.fillStyle = "#8b6f47";
  ctx.beginPath();
  ctx.ellipse(0, 0, 18 * s, 10 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#e6cfa0";
  ctx.beginPath();
  ctx.ellipse(2 * s, 4 * s, 12 * s, 5 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Snout resting on the ground
  ctx.fillStyle = "#d98a9a";
  ctx.beginPath();
  ctx.ellipse(17 * s, 3 * s, 4.5 * s, 3 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // Closed eye - a small curved lash
  ctx.strokeStyle = "#241a12";
  ctx.lineWidth = 1.4 * s;
  ctx.beginPath();
  ctx.arc(8 * s, -3 * s, 2.4 * s, 0.2 * Math.PI, 0.9 * Math.PI);
  ctx.stroke();

  // Ear
  ctx.fillStyle = "#5c4529";
  ctx.beginPath();
  ctx.arc(-4 * s, -9 * s, 3 * s, 0, Math.PI * 2);
  ctx.fill();

  // Tucked paws
  ctx.fillStyle = "#c9a876";
  ctx.beginPath();
  ctx.ellipse(10 * s, 8 * s, 4 * s, 3 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // Floating "Z Z Z" - drawn unrotated/unflipped, in screen space above the head.
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < 3; i++) {
    const phase = (t * 0.9 + i * 0.33) % 1;
    const size = (10 + i * 4) * s;
    const x = cx + (14 + i * 8) * s * flip;
    const y = cy - 14 * s - phase * 22 * s;
    const alpha = phase < 0.15 ? phase / 0.15 : phase > 0.75 ? (1 - phase) / 0.25 : 1;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle = "#3a4a6b";
    ctx.font = `bold ${size}px sans-serif`;
    ctx.fillText("Z", x, y);
  }
  ctx.restore();
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
