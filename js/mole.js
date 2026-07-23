import { MOVE_ACTION, SHAPE } from "./tiles.js";
import { ENERGY, FOOD_TYPES, FOOD_ID_TO_TYPE } from "./constants.js";

const WALK_DURATION = 220;
const CLIMB_DURATION = 260;
const FALL_SPEED_MULTIPLIER = 1.5; // falling off a wall drops faster than climbing it

// Which corner stays solid on each of the two "elbow" tiles (the orthogonal neighbors
// flanking a diagonal step), keyed by the move's [dx,dy]. See tiles.js SHAPE.
const DIAGONAL_ELBOW_SHAPES = {
  "1,1": [SHAPE.NE, SHAPE.SW],
  "1,-1": [SHAPE.SE, SHAPE.NW],
  "-1,1": [SHAPE.NW, SHAPE.SE],
  "-1,-1": [SHAPE.SW, SHAPE.NE],
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

    // Non-digging wall-climbing state (see requestMove). 0 = ordinary footing; +/-1 = clinging
    // to a vertical wall on that side of the mole's own open cell, same convention as an ant's
    // wallDx. falling is true while dropping straight down after letting go of a wall with
    // nothing else to grab (see _beginFall/_tickFall) - unlike an ant, the mole has no ceiling-
    // clinging state to fall out of, only this wall-release case.
    this.wallDx = 0;
    this.falling = false;
    this._pendingFall = false;
    this.onScoreChange = null;
    this.onEnergyChange = null;
    this.onStarsEarned = null;
    this.onEvent = null; // (name, data) for HUD toasts / juice

    // Stat/cosmetic customization, set via applyProfile()/setColors() - defaults are neutral.
    this.speedFactor = 1;
    this.strengthFactor = 1;
    this.staminaRegenFactor = 1;
    this.maxEnergy = MAX_ENERGY;
    this.colors = { body: "#8b6f47", belly: "#e6cfa0" };
  }

  /** Applies stat-derived gameplay multipliers from a Profile. Safe to call mid-run. */
  applyProfile(effects) {
    this.speedFactor = effects.speedFactor;
    this.strengthFactor = effects.strengthFactor;
    this.staminaRegenFactor = effects.staminaRegenFactor;
    const oldMax = this.maxEnergy;
    this.maxEnergy = MAX_ENERGY + effects.maxEnergyBonus;
    this.energy = Math.min(this.maxEnergy, this.energy + (this.maxEnergy - oldMax));
    this.onEnergyChange?.(this.energy);
  }

  setColors(colorSet) {
    this.colors = { body: colorSet.body, belly: colorSet.belly };
  }

  get isBusy() {
    return this.actionTarget !== null;
  }

  /** Request movement in a grid direction (8-way). Pass digging=true (held down by the player,
   *  see InputController.isDigging) to dig through a blocked diggable wall like any other move;
   *  without it, movement is restricted to whatever tunnel already exists - see
   *  _requestSurfaceMove for exactly what "already exists" means once walls and overhangs are
   *  involved. */
  requestMove(dx, dy, digging = false) {
    if (this.state === "sleep") return;
    if (this.isBusy || this.falling) return;
    dx = Math.sign(dx);
    dy = Math.sign(dy);
    if (dx === 0 && dy === 0) return;

    if (digging) {
      this.wallDx = 0; // digging always lets go of a wall and returns to plain footing
      this._requestDiggingMove(dx, dy);
    } else {
      this._requestSurfaceMove(dx, dy);
    }
  }

  _requestDiggingMove(dx, dy) {
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

    if (!this.map.canEnter(targetCol, targetRow, dx, dy)) {
      if (!targetTile.diggable) {
        this._bump();
        return;
      }
      const duration = targetTile.digDuration * distanceScale * this.speedFactor;
      const cost = targetTile.digEnergyCost * this.strengthFactor;
      this._beginAction(MOVE_ACTION.DIG, targetCol, targetRow, duration, cost, targetTile);
      return;
    }

    this._beginWalkOrClimb(targetCol, targetRow, dx, dy, distanceScale, targetTile);
  }

  // Not digging: walk/climb along whatever surface already exists, never carving new tunnel.
  // A 45 degree incline (an already-open diagonal corner, see TileMap.canEnter) still counts
  // as walking - see _beginWalkOrClimb. Bumping into a genuine vertical wall while walking
  // grabs onto it and climbs UP instead of just stopping, converting the same horizontal press
  // into upward motion without the player needing to switch to pressing Up. Once attached
  // (this.wallDx != 0) that same direction keeps climbing; the opposite direction lets go,
  // landing on solid ground right there, re-attaching to a facing wall across a narrow shaft,
  // or falling if there's neither. Unlike an ant, the mole never clings upside down - if the
  // wall it's climbing stops continuing, that's an overhang, and it's a hard barrier (dig
  // through it instead) rather than somewhere to wrap onto a ceiling.
  _requestSurfaceMove(dx, dy) {
    if (this.wallDx !== 0 && this._hasFloorBelow()) {
      this.wallDx = 0; // reached solid ground - even mid-climb, that's ordinary footing again
    }

    if (this.wallDx !== 0 && dy === 0) {
      if (dx === -this.wallDx) {
        this._releaseWall();
        return;
      }
      // Pressing back toward the wall (or just still holding the direction that first grabbed
      // it) is exactly holding Up while attached.
      dx = 0;
      dy = -1;
    }

    const targetCol = this.col + dx, targetRow = this.row + dy;
    if (!this.map.inBounds(targetCol, targetRow)) return;
    if (targetRow < this.map.skyRows) return;

    if (dx > 0) this.facing = "right";
    if (dx < 0) this.facing = "left";

    const isDiagonal = dx !== 0 && dy !== 0;
    const distanceScale = isDiagonal ? Math.SQRT2 : 1;
    const targetTile = this.map.getTile(targetCol, targetRow);

    if (this.map.canEnter(targetCol, targetRow, dx, dy)) {
      if (this.wallDx !== 0 && dy < 0 && !this._wallContinuesAt(targetRow)) {
        this._bump(); // the wall ends here - an overhang, not somewhere to climb onto
        return;
      }
      this._beginWalkOrClimb(targetCol, targetRow, dx, dy, distanceScale, targetTile);
      if (dx !== 0 && dy === 0) this.wallDx = 0; // a plain sideways walk means normal footing
      return;
    }

    // Blocked, not digging: a vertical wall met by a purely horizontal press is climbed
    // instead of bumped. Anything else (an un-diggable wall/rock, or a blocked vertical move)
    // is a genuine barrier while not digging.
    if (dy === 0 && dx !== 0 && this.wallDx === 0) {
      this._attemptAttach(dx);
      return;
    }
    this._bump();
  }

  _hasFloorBelow() {
    return this.map.getTile(this.col, this.row + 1).solid && this.map.isEdgeSolid(this.col, this.row + 1, 0, 1);
  }

  _wallContinuesAt(row) {
    return this.map.getTile(this.col + this.wallDx, row).solid;
  }

  // First contact with a vertical wall while walking - grab on and immediately climb up one
  // step, exactly as if the player had pressed Up instead of the direction that just got
  // blocked. Never digs; a wall too short to climb at all (blocked immediately above) just
  // bumps instead of attaching to nothing.
  _attemptAttach(dx) {
    const targetRow = this.row - 1;
    if (!this.map.inBounds(this.col, targetRow) || targetRow < this.map.skyRows) {
      this._bump();
      return;
    }
    this.wallDx = dx;
    if (!this._wallContinuesAt(targetRow) || !this.map.canEnter(this.col, targetRow, 0, -1)) {
      this.wallDx = 0;
      this._bump();
      return;
    }
    const targetTile = this.map.getTile(this.col, targetRow);
    this._beginWalkOrClimb(this.col, targetRow, 0, -1, 1, targetTile);
  }

  // Letting go of the currently-attached wall (pressed away from it) - lands on solid ground
  // right there if there is any, re-attaches to a wall facing it across a narrow shaft if not,
  // or starts falling once that step lands if there's neither.
  _releaseWall() {
    const awayDx = -this.wallDx;
    const targetCol = this.col + awayDx;
    if (!this.map.inBounds(targetCol, this.row)) return;
    if (!this.map.canEnter(targetCol, this.row, awayDx, 0)) {
      this._bump(); // still boxed in on that side - stay put, still attached
      return;
    }

    const targetTile = this.map.getTile(targetCol, this.row);
    const hasFloor = this.map.getTile(targetCol, this.row + 1).solid && this.map.isEdgeSolid(targetCol, this.row + 1, 0, 1);
    const hasOppositeWall = !hasFloor && this.map.getTile(targetCol + awayDx, this.row).solid;

    this._beginWalkOrClimb(targetCol, this.row, awayDx, 0, 1, targetTile);
    if (hasFloor) this.wallDx = 0;
    else if (hasOppositeWall) this.wallDx = awayDx;
    else this._pendingFall = true;
  }

  // Shared by both digging and non-digging moves once a target cell is known to be enterable
  // without digging (see TileMap.canEnter) - a diagonal glide through an already-open corner
  // counts as walking, not climbing (a 45 degree incline is still just a slope you walk up),
  // so only a purely vertical move (no horizontal component at all) is a real climb.
  _beginWalkOrClimb(targetCol, targetRow, dx, dy, distanceScale, targetTile) {
    const isVertical = dy !== 0 && dx === 0;
    const duration = (isVertical ? CLIMB_DURATION : WALK_DURATION) * distanceScale * this.speedFactor;
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
    this.onStarsEarned?.(amount);
  }

  update(dt) {
    if (this.falling) {
      this._tickFall(dt);
      return;
    }

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
      // Linear, constant-speed interpolation - an eased curve decelerates to a stop at every
      // tile boundary, which is what made continuous holding of a direction read as a series
      // of discrete hops instead of one smooth glide. requestMove() below already re-issues
      // the next tile's action the instant this one completes (isBusy clears the same frame
      // _completeAction runs), so back-to-back tiles in the same direction carry speed through
      // the boundary seamlessly.
      const t = Math.min(1, this.actionElapsed / this.actionDuration);
      this.px = lerp(this.col, this.actionTarget.col, t);
      this.py = lerp(this.row, this.actionTarget.row, t);

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
    const regen = ENERGY.SLEEP_REGEN_PER_SEC * this.staminaRegenFactor * dt / 1000;
    this.energy = Math.min(this.maxEnergy, this.energy + regen);
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

    if (this._pendingFall) {
      this._pendingFall = false;
      this._beginFall();
    }
  }

  // Let go of a wall with nothing else to grab (see _releaseWall) - drops straight down from
  // exactly where it landed until it reaches solid, upward-facing ground.
  _beginFall() {
    this.falling = true;
    this.wallDx = 0;
    this.state = "fall";
  }

  _tickFall(dt) {
    this.py += ((FALL_SPEED_MULTIPLIER / CLIMB_DURATION) * dt);
    this.row = Math.floor(this.py);
    // A diagonal tile (see tiles.js SHAPE) is only real ground to land on if its upward-facing
    // edge is solid - falling through the open half of one keeps falling, same as an ant.
    if (this.map.getTile(this.col, this.row).solid && this.map.isEdgeSolid(this.col, this.row, 0, 1)) {
      this.falling = false;
      this.row -= 1;
      this.py = this.row;
      this.px = this.col;
      this.state = "idle";
    }
  }

  /** Notches the two orthogonal neighbors flanking a diagonal step so the boundary between
   *  dirt and tunnel reads as one straight 45 degree line instead of a staircase. */
  _carveDiagonalElbows(fromCol, fromRow, dx, dy) {
    const [shapeA, shapeB] = DIAGONAL_ELBOW_SHAPES[`${dx},${dy}`];
    this.map.carveDiagonal(fromCol + dx, fromRow, shapeA);
    this.map.carveDiagonal(fromCol, fromRow + dy, shapeB);
  }

  _applyFood(typeKey) {
    const stats = FOOD_TYPES[typeKey];
    if (!stats) return;
    this.energy = Math.min(this.maxEnergy, this.energy + stats.energy);
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

// Darkens (negative amt) or lightens (positive) a hex color - used to derive legs/ears/tail
// shading from whichever body color the player picked, instead of a fixed brown.
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const r = clamp(((n >> 16) & 255) + 255 * amt);
  const g = clamp(((n >> 8) & 255) + 255 * amt);
  const b = clamp((n & 255) + 255 * amt);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
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

  const bodyColor = hurtFlash ? "#c0503f" : mole.colors.body;
  const bellyColor = hurtFlash ? "#f0b3a8" : mole.colors.belly;
  const darkColor = shade(mole.colors.body, -0.28);

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
  ctx.strokeStyle = shade(mole.colors.body, -0.28);
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.moveTo(-16 * s, 2 * s);
  ctx.quadraticCurveTo(-24 * s, -2 * s, -20 * s, -8 * s);
  ctx.stroke();

  // Body lying on its side - wide flat ellipse, gently "breathing" via scale.
  ctx.save();
  ctx.translate(0, 0);
  ctx.scale(1, breathe);
  ctx.fillStyle = mole.colors.body;
  ctx.beginPath();
  ctx.ellipse(0, 0, 18 * s, 10 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = mole.colors.belly;
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
  ctx.fillStyle = shade(mole.colors.body, -0.28);
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
