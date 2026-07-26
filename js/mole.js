import { MOVE_ACTION, SHAPE, TILE } from "./tiles.js";
import { ENERGY, FOOD_TYPES, FOOD_ID_TO_TYPE } from "./constants.js";
import { SOLID_THRESHOLD } from "./field.js";
import { raycast, canEnterField, findSupport, isOverhangNormal } from "./field-collision.js";

// How far (tile-units) the mole's gravity search reaches for a nearby surface to stick to - see
// _checkSupport. Matches "shouldn't fall straight down a shaft unless an edge is more than a
// tile away."
const GRAVITY_SEARCH_DIST = 1.0;

// Radius (tile-units) of the circle a dig carves into the field - see Mole._digField. Chosen so
// consecutive orthogonal AND diagonal dig steps connect with no gap: adjacent cell centers are
// 1 tile-unit apart on a cardinal step but sqrt(2) apart on a diagonal one, and a lone circle at
// each step's endpoint alone wouldn't reliably touch the previous one on the diagonal case.
const DIG_RADIUS = 0.55;

// How far ahead of the mole's own center tryContinuousDig checks for material to dig into - has
// to be strictly more than DIG_RADIUS. Each step's carve clears a full DIG_RADIUS circle around
// the mole's new position, so a lookahead of exactly DIG_RADIUS lands right back on the edge of
// what was just cleared - the very next tick reads that spot as "already open" and stalls
// (confirmed: caused digging to advance on roughly 1 in 20 frames instead of every frame). The
// margin pushes the check past the freshly-cleared circle into genuinely untouched material.
const DIG_LOOKAHEAD = DIG_RADIUS + 0.15;

const WALK_DURATION = 220;
const CLIMB_DURATION = 260;
const FALL_SPEED_MULTIPLIER = 1.5; // falling off a wall drops faster than climbing it

// Continuous digging (see Mole.tryContinuousDig): while the dig control is held with a direction
// pressed, the mole moves and carves the field itself along the raw (un-snapped-to-8-directions)
// aim vector, at whatever material is directly ahead's normal dig pace - instead of only ever
// hopping one whole tile at a time in one of 8 directions. This is what actually rounds off the
// mole's own path in whatever direction is held, not just a cosmetic extra. It falls back to
// nothing (letting the ordinary discrete walk/climb/bump system handle it) the instant the path
// ahead is already open or blocked by rock, so gravity/wall-climbing on existing tunnel is
// completely unchanged - only "there's diggable material in the way" gets this treatment.
// A tile only flips to TUNNEL (see tiles.js) once the field says it's genuinely mostly cleared -
// grazing a fresh tile's corner in passing shouldn't tell the legacy tile grid (and anything
// reading it, like creatures.js's collision) that the whole tile is open.
const TUNNEL_FRACTION_THRESHOLD = 0.15;

// Burrow digging (see Mole.holdBurrow): holding the dig control with no direction pressed grows
// a round chamber centered on the mole - the "dig a round room to stop and rest in" action, as
// opposed to tryContinuousDig's moving-forward carve. Scored the same way (real digging, not a
// polish tool), at a flat per-area rate rather than tracking the exact material at every point
// the growing circle happens to cover.
const BURROW_MIN_RADIUS = 0.6; // roughly one normal dig capsule's reach - no jarring pop-in
const BURROW_MAX_RADIUS = 1.9; // a proper round room, capped so holding dig forever isn't free
const BURROW_GROWTH_PER_SEC = 0.35; // tile-units of radius per second held
const BURROW_REGROW_STEP = 0.02; // minimum radius growth before bothering to re-carve
const BURROW_SCORE_PER_AREA = 2; // matches DIRT_SOFT's digScore/tile-area rate
const BURROW_ENERGY_PER_AREA = 2.5; // matches DIRT_SOFT's digEnergyCost/tile-area rate

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
  // field (see field.js/field-collision.js) is optional and defaults to null - every method
  // below that has a field-aware path falls back to the original tiles.js SHAPE-based logic
  // when it's absent, so nothing here changes the live game until whatever constructs a Mole
  // actually starts passing a real, dig-synced field (see field-collision.js's module comment
  // for why that has to happen together with the field-clipped renderer, not on its own).
  constructor(tileMap, startCol, startRow, field = null) {
    this.map = tileMap;
    this.field = field;
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
    this._digScoreCarry = 0; // fractional score between whole-star awards - see tryContinuousDig
    this._continuousDigActive = false; // set for one frame by tryContinuousDig - see update()
    this._burrowHeld = 0; // ms the dig control has been held with no direction - see holdBurrow
    this._burrowRadius = 0; // radius already carved this hold, so growth only adds the new ring
    this._burrowScoreCarry = 0; // fractional score between whole-star awards - see holdBurrow
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

  // Continuous, arbitrary-angle digging - see the module comment above TUNNEL_FRACTION_THRESHOLD.
  // Called every frame from game.js's loop whenever the dig control is held with a direction
  // (raw, un-snapped aim vector from InputController.getAimVector). Returns true the moment it
  // actually takes over the mole's movement for this frame (there was diggable material directly
  // ahead, or rock got bumped into), false the instant there's nothing for it to do - the caller
  // falls back to the ordinary discrete requestMove whenever this returns false, so walking and
  // wall-climbing on already-open tunnel are completely untouched by this.
  tryContinuousDig(dt, aimX, aimY) {
    if (!this.field || this.state === "sleep" || this.falling || this.isBusy) return false;
    const mag = Math.hypot(aimX, aimY);
    if (mag < 0.01) return false;
    const nx = aimX / mag, ny = aimY / mag;

    const aheadX = this.px + nx * DIG_LOOKAHEAD, aheadY = this.py + ny * DIG_LOOKAHEAD;
    const aheadCol = Math.floor(aheadX), aheadRow = Math.floor(aheadY);
    if (!this.map.inBounds(aheadCol, aheadRow) || aheadRow < this.map.skyRows) return false;
    if (this.field.sampleWorld(aheadX, aheadY) < SOLID_THRESHOLD) return false; // already open - not this system's job

    const aheadTile = this.map.getTile(aheadCol, aheadRow);
    if (!aheadTile.diggable) {
      this._bump(); // rock - consume the input so the caller doesn't also try a grid-step here
      return true;
    }

    this.wallDx = 0; // digging always lets go of a wall, same as the discrete system
    if (nx > 0.01) this.facing = "right";
    else if (nx < -0.01) this.facing = "left";
    this.state = "dig";
    this._continuousDigActive = true; // tells update() to skip its idle/gravity fallthrough this frame

    // Same tiles.js digDuration/speedFactor pacing the discrete dig uses, expressed as a rate
    // instead of a fixed per-tile duration - moving any distance at any angle costs exactly the
    // same total time/energy/score per unit of material removed as before, just continuously.
    const speed = 1000 / (aheadTile.digDuration * this.speedFactor); // tiles/sec
    const dist = (speed * dt) / 1000;
    const newX = this.px + nx * dist, newY = this.py + ny * dist;

    this._digFieldWorld(this.px, this.py, newX, newY);
    this.px = newX;
    this.py = newY;
    this.col = Math.round(this.px);
    this.row = Math.round(this.py);

    // Same tiny-fractional-amount-per-tick trap holdBurrow already has to guard against - each
    // frame's sliver of distance is almost always well under 1 star, so round the running total
    // instead of each individual tick.
    this._digScoreCarry += dist * aheadTile.digScore;
    const wholeScore = Math.floor(this._digScoreCarry);
    if (wholeScore > 0) {
      this._addScore(wholeScore);
      this._digScoreCarry -= wholeScore;
    }
    this._spendEnergy(dist * aheadTile.digEnergyCost * this.strengthFactor);

    if (this.map.getTile(aheadCol, aheadRow) !== TILE.TUNNEL && this.field.tileSolidFraction(aheadCol, aheadRow) < TUNNEL_FRACTION_THRESHOLD) {
      this.map.digOut(aheadCol, aheadRow);
      const foodId = this.map.consumeFood(aheadCol, aheadRow);
      const typeKey = FOOD_ID_TO_TYPE[foodId];
      if (typeKey) this._applyFood(typeKey);
    }

    return true;
  }

  // Holding the dig control with no direction pressed (see game.js's loop - it calls this
  // instead of tryContinuousDig exactly when the aim vector is zero) grows a round chamber
  // centered on the mole, a widening ring at a time, up to BURROW_MAX_RADIUS - "dig a round
  // burrow" as its own distinct action rather than moving forward. Requires standing still
  // (isBusy) since there's no direction to walk into; resetBurrow() must be called by the caller
  // the instant that's no longer true (direction pressed, dig released) so the next hold starts
  // over instead of resuming a stale radius.
  holdBurrow(dt) {
    if (!this.field || this.state === "sleep" || this.falling || this.isBusy) return;
    if (!this.map.inBounds(this.col, this.row) || this.row < this.map.skyRows) return;

    this._burrowHeld += dt;
    const radius = Math.min(BURROW_MAX_RADIUS, BURROW_MIN_RADIUS + (BURROW_GROWTH_PER_SEC * this._burrowHeld) / 1000);
    if (radius < this._burrowRadius + BURROW_REGROW_STEP) return;

    const prevRadius = this._burrowRadius;
    this._burrowRadius = radius;
    const newArea = Math.PI * (radius * radius - prevRadius * prevRadius);

    this.field.subtractCircleProtected(this.px, this.py, radius);

    const colMin = Math.max(0, Math.floor(this.px - radius));
    const colMax = Math.min(this.map.width - 1, Math.floor(this.px + radius));
    const rowMin = Math.max(0, Math.floor(this.py - radius));
    const rowMax = Math.min(this.map.height - 1, Math.floor(this.py + radius));
    for (let row = rowMin; row <= rowMax; row++) {
      for (let col = colMin; col <= colMax; col++) {
        if (this.map.getTile(col, row) !== TILE.TUNNEL && this.field.tileSolidFraction(col, row) < TUNNEL_FRACTION_THRESHOLD) {
          this.map.digOut(col, row);
        }
      }
    }

    // Each tick's slice of new area is a thin ring - its raw score is almost always well under
    // 1 star, so rounding per-tick would round nearly everything down to 0 and starve the total.
    // Carry the fractional remainder forward instead, only ever awarding whole stars.
    this._burrowScoreCarry += newArea * BURROW_SCORE_PER_AREA;
    const wholeScore = Math.floor(this._burrowScoreCarry);
    if (wholeScore > 0) {
      this._addScore(wholeScore);
      this._burrowScoreCarry -= wholeScore;
    }
    this._spendEnergy(newArea * BURROW_ENERGY_PER_AREA);
  }

  /** Call whenever holdBurrow's conditions stop holding (direction pressed, dig released, mole
   *  starts moving) - without this the next hold would silently resume mid-radius. */
  resetBurrow() {
    this._burrowHeld = 0;
    this._burrowRadius = 0;
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

    if (!this._canEnter(targetCol, targetRow, dx, dy)) {
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

  // Field-based (see field-collision.js canEnterField) when a field is attached, generalizing
  // to any carved shape instead of pattern-matching tiles.js's 5-case SHAPE enum - falls back to
  // the original tile logic otherwise (see the constructor's field param doc comment).
  _canEnter(targetCol, targetRow, dx, dy) {
    if (this.field) {
      return canEnterField(this.field, this.col + 0.5, this.row + 0.5, targetCol + 0.5, targetRow + 0.5);
    }
    return this.map.canEnter(targetCol, targetRow, dx, dy);
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

    if (this._canEnter(targetCol, targetRow, dx, dy)) {
      if (this.wallDx !== 0 && dy < 0) {
        const wallState = this._wallState(targetRow);
        if (wallState === "overhang") {
          this._bump(); // curves back over the mole - a genuine barrier, not somewhere to wrap onto
          return;
        }
        this._beginWalkOrClimb(targetCol, targetRow, dx, dy, distanceScale, targetTile);
        // The wall simply stopped (the flat top of a cliff or a short wall, not an overhang) -
        // there's nothing left to cling to, so this step lands on ordinary footing instead of
        // continuing to "climb" a wall that isn't there anymore. Going around a corner and over
        // a cliff like this is exactly the case that used to get conflated with an overhang and
        // wrongly treated as a barrier.
        if (wallState === "ended") this.wallDx = 0;
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

  // The grass surface is ground by definition (see TILE.SURFACE) even though it isn't a solid
  // tile itself - standing on it never needs a solid tile underneath, same as the starting
  // burrow carved directly beneath it (see TileMap._carveStartingBurrow). Field-based when a
  // field is attached: a short downward raycast from the cell's own center, rejecting an
  // overhang (the underside of a ledge doesn't count as "floor reached").
  _hasFloorAt(col, row) {
    if (this.map.getTile(col, row) === TILE.SURFACE) return true;
    if (this.field) {
      const hit = raycast(this.field, col + 0.5, row + 0.5, 0, 1, 0.6);
      return hit !== null && !isOverhangNormal(hit.normal);
    }
    return this.map.getTile(col, row + 1).solid && this.map.isEdgeSolid(col, row + 1, 0, 1);
  }

  _hasFloorBelow() {
    return this._hasFloorAt(this.col, this.row);
  }

  // What's happening to the wall the mole is climbing, at this row: "continues" (a normal wall
  // - keep climbing), "overhang" (curves back over the mole - a genuine barrier, "concave angles
  // are treated as a barrier"), or "ended" (the wall simply stopped - the flat top of a cliff or
  // a short wall, not a barrier at all, just somewhere to step onto). Field-based: a short
  // horizontal raycast toward the wall side distinguishes "stopped" (no hit) from "curved into a
  // ceiling" (hit, but the surface there faces down) - two cases tiles.js's flat SHAPE-based
  // wall could never actually tell apart, since it only ever had straight walls to begin with;
  // without a field, every non-continuation reads as "ended" (SHAPE has no way to represent a
  // real overhang shape at all).
  _wallState(row) {
    if (this.field) {
      const hit = raycast(this.field, this.col + 0.5, row + 0.5, this.wallDx, 0, 0.6);
      if (hit === null) return "ended";
      return isOverhangNormal(hit.normal) ? "overhang" : "continues";
    }
    return this.map.getTile(this.col + this.wallDx, row).solid ? "continues" : "ended";
  }

  // First contact with a vertical wall while walking - grab on and immediately climb up one
  // step, exactly as if the player had pressed Up instead of the direction that just got
  // blocked. Never digs; only a genuine overhang right above bumps instead of attaching - a
  // short wall/step that tops out immediately still completes as a quick climb onto it.
  _attemptAttach(dx) {
    const targetRow = this.row - 1;
    if (!this.map.inBounds(this.col, targetRow) || targetRow < this.map.skyRows) {
      this._bump();
      return;
    }
    this.wallDx = dx;
    const wallState = this._wallState(targetRow);
    if (wallState === "overhang" || !this._canEnter(this.col, targetRow, 0, -1)) {
      this.wallDx = 0;
      this._bump();
      return;
    }
    const targetTile = this.map.getTile(this.col, targetRow);
    this._beginWalkOrClimb(this.col, targetRow, 0, -1, 1, targetTile);
    if (wallState === "ended") this.wallDx = 0; // a low step, not a real wall to keep climbing
  }

  /** True if the cell at (col,row) reads as solid - field-based when attached, else the plain
   *  tile flag. Used for the narrow-shaft "opposite wall" checks below. */
  _isSolidCell(col, row) {
    if (this.field) return this.field.sampleWorld(col + 0.5, row + 0.5) >= SOLID_THRESHOLD;
    return this.map.getTile(col, row).solid;
  }

  // Letting go of the currently-attached wall (pressed away from it) - lands on solid ground
  // right there if there is any, re-attaches to a wall facing it across a narrow shaft if not,
  // or starts falling once that step lands if there's neither.
  _releaseWall() {
    const awayDx = -this.wallDx;
    const targetCol = this.col + awayDx;
    if (!this.map.inBounds(targetCol, this.row)) return;
    if (!this._canEnter(targetCol, this.row, awayDx, 0)) {
      this._bump(); // still boxed in on that side - stay put, still attached
      return;
    }

    const targetTile = this.map.getTile(targetCol, this.row);
    const hasFloor = this._hasFloorAt(targetCol, this.row);
    const hasOppositeWall = !hasFloor && this._isSolidCell(targetCol + awayDx, this.row);

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

    // tryContinuousDig already fully owns px/py/state for this frame (moving and carving along
    // whatever raw angle is held) - the gravity/idle fallthrough below would otherwise stomp that
    // fractional position back to the rounded col/row every single frame. Gravity resumes
    // checking the very next frame continuous digging isn't active, same as how the discrete dig
    // action above already defers gravity until it completes.
    if (this._continuousDigActive) {
      this._continuousDigActive = false;
      return;
    }

    // Gravity applies continuously whenever the mole is at rest, not just right after letting
    // go of a wall (see _releaseWall) - digging is free-form in all 8 directions with no floor
    // requirement of its own (that's how a downward or diagonal dig works at all), so digging
    // sideways into a cavity, or out from under solid ground some other way, can leave the mole
    // resting over open air. wallDx != 0 is exempt - clinging to a wall never needs a floor.
    if (this.wallDx === 0 && !this._checkSupport()) {
      this._beginFall();
      return;
    }

    this.px = this.col;
    this.py = this.row;
    if (this.state !== "eat") {
      this.state = "idle";
    }
  }

  // Gravity's "stick to the closest surface" rule (see field-collision.js findSupport) - not
  // just what's directly underfoot, so the mole doesn't free-fall down the middle of a shaft
  // it's close enough to lean against a wall in instead ("shouldn't fall straight down a shaft
  // unless an edge is more than a tile away"). A wall found closer than any floor auto-attaches
  // to it (same wallDx state a deliberate player-driven attach uses - see _attemptAttach)
  // instead of just reporting "supported" and leaving the mole floating unattached next to it.
  // Without a field this degrades to the plain floor-only check, same as before.
  _checkSupport() {
    if (!this.field) return this._hasFloorBelow();
    if (this.map.getTile(this.col, this.row) === TILE.SURFACE) return true;
    const support = findSupport(this.field, this.col + 0.5, this.row + 0.5, GRAVITY_SEARCH_DIST);
    if (!support) return false;
    if (Math.abs(support.normal.x) > Math.abs(support.normal.y)) {
      this.wallDx = support.x > this.col + 0.5 ? 1 : -1;
    }
    return true;
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
      // Keeps the field the authoritative shape (see field.js) in sync with the same dig - the
      // material grid above still gets digOut/carveDiagonalElbows too, so creatures.js (not
      // yet field-aware - see field-collision.js's module comment) keeps working against it.
      if (this.field) this._digField(this.col, this.row, col, row);
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

  // Carves a circle of DIG_RADIUS at several points along the straight line actually just
  // traveled (a cheap capsule approximation), not just one circle at the destination - a single
  // circle at only the endpoint wouldn't reliably touch the previous dig's circle on a diagonal
  // step, since adjacent cell centers are sqrt(2) tile-units apart on the diagonal but the two
  // circles would only be 2*DIG_RADIUS apart. This is what replaces carveDiagonal/
  // _carveDiagonalElbows entirely for shape purposes - no separate elbow-notching step needed,
  // the capsule's own geometry already traces a smooth line between the two cells. A thin
  // tile-index wrapper around _digFieldWorld, which tryContinuousDig also uses directly with
  // real (non-tile-center) world positions for its own, much shorter, per-frame capsules.
  _digField(fromCol, fromRow, toCol, toRow) {
    this._digFieldWorld(fromCol + 0.5, fromRow + 0.5, toCol + 0.5, toRow + 0.5);
  }

  _digFieldWorld(fromX, fromY, toX, toY) {
    const dist = Math.hypot(toX - fromX, toY - fromY);
    const steps = Math.max(1, Math.ceil(dist / (DIG_RADIUS * 0.6)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.field.subtractCircle(fromX + (toX - fromX) * t, fromY + (toY - fromY) * t, DIG_RADIUS);
    }
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

// A diagonal tile (see tiles.js SHAPE) the mole is allowed to rest or glide inside of - see
// TileMap.canEnter's diagonal-approach case - is still materially solid on one triangular
// half; only the other half, centered a sixth of a tile off the tile's raw center toward the
// open corner, is actually open ground (the two triangles split the tile along its diagonal
// cut, so their centroids sit at 1/3 and 2/3 of the way across - 1/6 tile off center each way).
// Drawing the sprite at the tile's literal center - which is where mole.px/py naturally lands,
// dead center of whichever tile it's currently in or transitioning into/out of - draws it half
// inside the still-solid triangle. This nudges the render (not the actual collision position)
// toward the open triangle's centroid so the sprite visually clears the solid corner.
function _diagonalRenderOffset(solidDir) {
  return { x: -solidDir.dx / 6, y: -solidDir.dy / 6 };
}

// Rotation that puts the mole's local "down" (feet) onto the surface it's currently against -
// same convention as the ant's _wallAngle (creatures.js): rotate(0,1) -> (wallDx,wallDy) gives
// theta = atan2(-wallDx, wallDy). Ordinary flat ground is (0,1) - feet straight down, no tilt.
function _wallAngle(wallDx, wallDy) {
  return Math.atan2(-wallDx, wallDy);
}

// Same idea as _wallAngle but driven by a real field surface normal instead of a fixed axis -
// lets the sprite's feet track a wall that curves (a round tunnel, a corner being climbed
// around) instead of snapping to a flat +-90 degrees. field-collision.js's normal convention
// points AWAY from solid material, INTO open space, so the feet direction (toward the surface)
// is -normal: fx,fy = -nx,-ny, and theta = atan2(-fx,fy) = atan2(nx,-ny).
function _surfaceAngle(nx, ny) {
  return Math.atan2(nx, -ny);
}

// Wall-climbing (this.wallDx != 0, clinging to a side wall - see _requestSurfaceMove) always
// wins: it's an explicit, intentional state, not something to infer from the tile underfoot,
// and needs to stay correct even at rest (standing still partway up a shaft), not just mid-
// animation. Otherwise, if the mole's current tile (nearest whole cell, same rounding
// _diagonalRenderOffset uses) is a diagonal SHAPE, tilt to match its slope: a diagonal tile's
// own retained-corner direction (solidDir, from TileMap.diagonalSlopeDir) IS the correct "wall"
// to feed _wallAngle - the same relationship an ant's ramp render angle already relies on (see
// creatures.js _antRenderAngle's doc comment: wall-travel, the diagonal leg's perpendicular-to-
// tangent direction, equals that tile's own retained corner). A plain vertical move with no
// wall reference at all (burrowing straight up/down through open dirt, not clinging to any
// side) has no surface to match, so it keeps the older, simpler up/down tilt instead.
function _moleRenderAngle(mole, solidDir) {
  if (mole.wallDx !== 0) {
    if (mole.field) {
      const hit = raycast(mole.field, mole.col + 0.5, mole.py + 0.5, mole.wallDx, 0, 0.6);
      if (hit) return _surfaceAngle(hit.normal.x, hit.normal.y);
    }
    return _wallAngle(mole.wallDx, 0);
  }
  if (solidDir) return _wallAngle(solidDir.dx, solidDir.dy);
  if (mole.actionType === MOVE_ACTION.CLIMB && mole.actionTarget) {
    const goingUp = mole.actionTarget.row < mole.row;
    return goingUp ? -Math.PI / 2 : Math.PI / 2;
  }
  return 0;
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

  const solidDir = mole.map ? mole.map.diagonalSlopeDir(Math.round(mole.px), Math.round(mole.py)) : null;
  const diagOffset = solidDir ? _diagonalRenderOffset(solidDir) : { x: 0, y: 0 };

  ctx.save();
  ctx.translate(
    screenX + tileSize / 2 + bump * -flip + diagOffset.x * tileSize,
    screenY + tileSize / 2 + diagOffset.y * tileSize
  );
  ctx.rotate(_moleRenderAngle(mole, solidDir));
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
