// Living food: worms wander freely through solid dirt and open tunnels alike. Ants cling to
// whatever solid surface they're walking along - the original ground, or the floor/wall/
// ceiling of a tunnel the mole has dug - and reorient themselves to match it, the same way a
// real ant can walk up a wall. They chase the mole down a shared row and attack on contact
// when they have normal footing; everything else is harmless and just gets eaten when the
// mole walks/digs into its cell.
//
// Termites and beetles are temporarily disabled (not spawned) while the ant wall-following
// behavior above is being worked out - their stats/drawing code is left in place to re-enable
// later.

import { TILE } from "./tiles.js";
import { FOOD_TYPES, CREATURE_STATS } from "./constants.js";

let wormSegmentSprites = null; // { head, mid, tail, headBend, midBend, tailBend }
let antWalkSprites = null; // [img, img, ...] walk-cycle frames

/** Must be called once with assets.js's loaded images before any drawCreature call. */
export function initCreatureSprites(sprites) {
  wormSegmentSprites = {
    head: sprites.wormHead, mid: sprites.wormMid, tail: sprites.wormTail,
    headBend: sprites.wormHeadBend, midBend: sprites.wormMidBend, tailBend: sprites.wormTailBend,
  };
  antWalkSprites = sprites.antWalk;
}

class Creature {
  constructor(type, col, row) {
    this.type = type;
    this.col = col;
    this.row = row;
    this.px = col;
    this.py = row;
    this.facing = Math.random() < 0.5 ? -1 : 1;
    this.alive = true;
    this.isBusy = false;
    this._elapsed = 0;
    this._duration = CREATURE_STATS[type].moveIntervalMs; // overwritten by the first real step
    this._fromCol = col;
    this._fromRow = row;
    this._toCol = col;
    this._toRow = row;
    this._waitTimer = randomBetween(0, CREATURE_STATS[type].moveIntervalMs);

    // Worms move in full half-tile increments, snapping directly from one position to the
    // next (no glide/interpolation) and only ever deciding a new direction once the head is
    // aligned back to a whole tile (see CreatureManager._tickWorm). trail holds one entry per
    // body segment PLUS one hidden "ghost" slot past the tail, used only so the tail can tell
    // which way it's arriving from - the same way every other segment does - without needing
    // special-cased math.
    if (type === "WORM") {
      this.wormMiddleSegments = Math.floor(Math.random() * 4);
      const totalSegments = 2 + this.wormMiddleSegments;
      this.headCol = col;
      this.headRow = row;
      this.wormDx = 1;
      this.wormDy = 0;
      this._wormTurning = false;
      this.trail = Array.from({ length: totalSegments + 1 }, () => ({ col, row }));
    } else {
      this.wormMiddleSegments = 0;
    }

    // Ants cling to whatever surface they're walking on rather than always walking
    // horizontally on a floor. wallD{x,y} is the unit vector from the ant to the solid
    // neighbor it's standing on (0,1 = normal floor); travelD{x,y} is perpendicular to that,
    // the direction it's currently walking along that surface. angleFrom/angleTo/rotElapsed/
    // rotDuration drive a smooth rotation animation whenever wallD{x,y} changes, instead of
    // popping straight to the new orientation (see _currentAntAngle).
    if (type === "ANT") {
      this.wallDx = 0;
      this.wallDy = 1;
      this.travelDx = this.facing;
      this.travelDy = 0;
      this._angleFrom = 0;
      this._angleTo = 0;
      this._rotElapsed = 0;
      this._rotDuration = 1;
    }
  }
}

function randomBetween(a, b) {
  return a + Math.random() * (b - a);
}

const ANT_SPAWN_EXCLUSION = 7; // tiles from the mole's start column ants won't spawn within
const ANT_SURFACE_TURN_CHANCE = 0.1; // ~1-in-10 chance per tile to turn back while on open ground
const ANT_CORNER_TURN_CHANCE = 0.25; // chance to turn back instead of following a real corner
const ANT_OFFSCREEN_MARGIN = 10; // tiles beyond the mole's column considered safely offscreen
const WORM_TURN_CHANCE = 0.25; // chance per move to turn instead of continuing straight

export class CreatureManager {
  constructor(map, moleStartCol) {
    this.map = map;
    this.list = [];
    this._spawnInitial(moleStartCol);
  }

  _spawnInitial(moleStartCol) {
    const map = this.map;
    for (let i = 0; i < CREATURE_STATS.WORM.cap; i++) {
      const col = Math.floor(Math.random() * map.width);
      const row = map.surfaceRow + 2 + Math.floor(Math.random() * 10);
      if (this._wormCanEnter(col, row)) this._add("WORM", col, row);
    }
    // A few ants on the surface to start - TERMITE/BEETLE are disabled for now (see doc comment).
    for (let i = 0; i < CREATURE_STATS.ANT.cap; i++) {
      let col;
      do {
        col = Math.floor(Math.random() * map.width);
      } while (Math.abs(col - moleStartCol) < ANT_SPAWN_EXCLUSION);
      this._add("ANT", col, map.surfaceRow);
    }
  }

  _add(type, col, row) {
    const c = new Creature(type, col, row);
    this.list.push(c);
    return c;
  }

  _countAlive(type) {
    let n = 0;
    for (const c of this.list) if (c.alive && c.type === type) n++;
    return n;
  }

  update(dt, mole, onMoleEat, onMoleHurt) {
    this._moleColHint = mole.col;
    this._moleRowHint = mole.row;

    this._resolveMoleContact(mole, onMoleEat);

    for (const c of this.list) {
      if (!c.alive) continue;
      this._updateCreature(c, dt, mole, onMoleHurt);
    }

    this._resolveAttacks(mole, onMoleHurt);

    for (let i = this.list.length - 1; i >= 0; i--) {
      if (!this.list[i].alive) this.list.splice(i, 1);
    }

    this._maybeRespawn(mole);
  }

  _resolveMoleContact(mole, onMoleEat) {
    if (mole.isBusy || mole.state === "sleep") return;
    for (const c of this.list) {
      if (c.alive && !c.isBusy && c.col === mole.col && c.row === mole.row) {
        c.alive = false;
        mole.eatCreature(c.type);
        onMoleEat?.(c);
      }
    }
  }

  _updateCreature(c, dt, mole, onMoleHurt) {
    if (c.type === "ANT") c._rotElapsed += dt;

    if (c.type === "WORM") {
      this._tickWorm(c, dt);
      return;
    }

    if (c.isBusy) {
      c._elapsed += dt;
      const t = Math.min(1, c._elapsed / c._duration);
      c.px = lerp(c._fromCol, c._toCol, t);
      c.py = lerp(c._fromRow, c._toRow, t);
      if (t >= 1) {
        c.col = c._toCol;
        c.row = c._toRow;
        c.px = c.col;
        c.py = c.row;
        c.isBusy = false;
      }
      return;
    }

    c._waitTimer -= dt;
    if (c._waitTimer > 0) return;

    if (c.type === "ANT") {
      this._stepAnt(c, mole, onMoleHurt);
    } else {
      this._stepSurfaceBug(c, mole);
    }
  }

  // `interval` (the per-type moveIntervalMs/chaseIntervalMs) is the time to glide across one
  // tile, i.e. speed. waitTimer is left at 0 - once this glide finishes, the creature is
  // immediately eligible to decide and start its next step (same frame, since waitTimer is
  // only checked/decremented while not busy), so consecutive tiles in the same direction glide
  // through the boundary at constant speed instead of gliding, stopping, then gliding again.
  _beginStep(c, toCol, toRow, interval) {
    c.facing = toCol > c.col ? 1 : toCol < c.col ? -1 : c.facing;
    c._fromCol = c.col;
    c._fromRow = c.row;
    c._toCol = toCol;
    c._toRow = toRow;
    c._elapsed = 0;
    c._duration = interval;
    c.isBusy = true;
    c._waitTimer = 0;
  }

  // Worms may only occupy solid diggable dirt (drawn as an overlay burrowing through it) or an
  // open cell resting directly on a solid floor (a dug-out tunnel floor, or the grass surface
  // itself) - never open air with nothing underneath.
  _wormCanEnter(col, row) {
    const map = this.map;
    if (!map.inBounds(col, row)) return false;
    const tile = map.getTile(col, row);
    if (tile === TILE.ROCK || tile === TILE.SKY) return false;
    if (tile.solid) return true;
    return map.hasFloorBelow(col, row);
  }

  // A worm mostly keeps crawling in whatever direction it's already headed, the same way a
  // real worm (or classic Snake) doesn't constantly zigzag - but every move has a WORM_TURN_
  // CHANCE odds of turning onto one of the two perpendicular directions instead. It can never
  // reverse straight back the way it came: the segment right behind its head already occupies
  // that cell, so doubling back would overlap its own body. Whichever choice isn't available
  // (a turn when the dice say turn, or straight-ahead otherwise) falls back to the other,
  // and if neither is open at all, it's stuck for now and waits.
  _pickWormDirection(c) {
    const turns = shuffled([[-c.wormDy, c.wormDx], [c.wormDy, -c.wormDx]]);

    if (Math.random() < WORM_TURN_CHANCE) {
      for (const [dx, dy] of turns) {
        if (this._wormDirValid(c, dx, dy)) return [dx, dy];
      }
    }

    if (this._wormDirValid(c, c.wormDx, c.wormDy)) return [c.wormDx, c.wormDy];

    for (const [dx, dy] of turns) {
      if (this._wormDirValid(c, dx, dy)) return [dx, dy];
    }
    return null;
  }

  _wormDirValid(c, dx, dy) {
    const nc = c.headCol + dx, nr = c.headRow + dy;
    if (nc === this._moleColHint && nr === this._moleRowHint) return false;
    return this._wormCanEnter(nc, nr);
  }

  // Worms move by snapping directly from one half-tile position to the next - no smooth
  // glide/interpolation, just a wait timer between discrete steps, like classic Snake. A new
  // direction can only be chosen while the head sits exactly on a whole tile. Turning costs one
  // extra tick - a pure in-place pivot with no forward progress - before half-tile steps resume,
  // which is what lets the head/mid/tail bend sprites sweep through the corner one at a time
  // (see _wormSegmentArt).
  _tickWorm(c, dt) {
    const stats = CREATURE_STATS.WORM;
    const halfMs = stats.moveIntervalMs / 2;

    c._waitTimer -= dt;
    if (c._waitTimer > 0) return;

    if (c._wormTurning) {
      c._wormTurning = false;
      c.wormDx = c._pendingDx;
      c.wormDy = c._pendingDy;
      this._advanceWorm(c);
      c._waitTimer = halfMs;
      return;
    }

    const atWholeTile = Number.isInteger(c.headCol) && Number.isInteger(c.headRow);
    if (atWholeTile) {
      const dir = this._pickWormDirection(c);
      if (!dir) {
        c._waitTimer = stats.moveIntervalMs * 0.5;
        return;
      }
      const [dx, dy] = dir;
      if (dx !== c.wormDx || dy !== c.wormDy) {
        c._pendingDx = dx;
        c._pendingDy = dy;
        c._wormTurning = true;
        c._waitTimer = halfMs; // in-place pivot pause, same length as a real step
        return;
      }
    }

    this._advanceWorm(c);
    c._waitTimer = halfMs;
  }

  _advanceWorm(c) {
    const newCol = c.headCol + c.wormDx * 0.5;
    const newRow = c.headRow + c.wormDy * 0.5;
    c.trail.pop();
    c.trail.unshift({ col: newCol, row: newRow });
    c.headCol = newCol;
    c.headRow = newRow;
    c.px = newCol;
    c.py = newRow;
    if (Number.isInteger(newCol) && Number.isInteger(newRow)) {
      c.col = newCol;
      c.row = newRow;
    }
  }

  _canWalkFloor(col, row) {
    const tile = this.map.getTile(col, row);
    if (tile.solid || tile === TILE.SKY) return false;
    return this.map.hasFloorBelow(col, row);
  }

  _stepSurfaceBug(c, mole) {
    const stats = CREATURE_STATS[c.type];
    let nc = c.col + c.facing;
    const nr = c.row;
    const forwardOk = this._canWalkFloor(nc, nr) && !(nc === mole.col && nr === mole.row);
    if (!forwardOk) {
      c.facing *= -1;
      nc = c.col + c.facing;
      if (!this._canWalkFloor(nc, nr) || (nc === mole.col && nr === mole.row)) {
        c._waitTimer = stats.moveIntervalMs * 0.5;
        return;
      }
    }
    this._beginStep(c, nc, nr, stats.moveIntervalMs);
  }

  // Chasing only happens with normal footing (wall directly below) - an ant mid-climb on a
  // wall or ceiling just keeps following that surface instead.
  _stepAnt(c, mole, onMoleHurt) {
    const stats = CREATURE_STATS.ANT;
    const normalFooting = c.wallDx === 0 && c.wallDy === 1;
    const sameRow = c.row === mole.row;
    const dist = Math.abs(c.col - mole.col);

    if (normalFooting && sameRow && dist <= stats.detectRange && dist > 0) {
      const dir = mole.col > c.col ? 1 : -1;
      const nc = c.col + dir;
      const nr = c.row;
      if (nc === mole.col && nr === mole.row) {
        c.travelDx = dir;
        c._fromCol = c.col; c._fromRow = c.row;
        c._toCol = nc; c._toRow = nr;
        c._elapsed = 0; c._duration = stats.chaseIntervalMs; c.isBusy = true;
        c._waitTimer = 0;
        c._attacking = true;
        return;
      }
      if (this._canWalkFloor(nc, nr)) {
        c.travelDx = dir;
        this._beginStep(c, nc, nr, stats.chaseIntervalMs);
        return;
      }
    }

    if (normalFooting && c.row === this.map.surfaceRow) {
      this._stepAntSurface(c);
    } else {
      this._stepAntTunnel(c);
    }
  }

  // Walking the original top-of-world ground: ambles left/right, occasionally changes its
  // mind at random (~1 in 10 tiles), and on finding a hole in the ground ahead either turns
  // back or commits to climbing down into it, 50/50.
  _stepAntSurface(c) {
    const stats = CREATURE_STATS.ANT;
    const map = this.map;

    if (Math.random() < ANT_SURFACE_TURN_CHANCE) {
      c.travelDx *= -1;
    }

    const nc = c.col + c.travelDx;
    if (!map.inBounds(nc, c.row)) {
      c.travelDx *= -1;
      c._waitTimer = stats.moveIntervalMs * 0.4;
      return;
    }

    if (!map.hasFloorBelow(nc, c.row)) {
      if (Math.random() < 0.5) {
        c.travelDx *= -1;
        c._waitTimer = stats.moveIntervalMs * 0.4;
        return;
      }
      // Commit to the hole: curl down into it - the direction it was walking becomes the new
      // "down," and the wall it clings to is now behind it, on the side it approached from.
      const newWallDx = -c.travelDx, newWallDy = 0;
      _setAntWall(c, newWallDx, newWallDy, false);
      c.travelDx = 0;
      c.travelDy = 1;
      this._beginStep(c, nc, c.row + 1, stats.moveIntervalMs);
      return;
    }

    this._beginStep(c, nc, c.row, stats.moveIntervalMs);
  }

  // Generic wall-following, valid regardless of which surface (floor/wall/ceiling) the ant is
  // currently clinging to. A corner is either a real 90-degree bend - the wall keeps going
  // straight afterward, and following it is a genuine decision the ant might turn back from -
  // or one tile of a staircase, where the very next tile is already another corner. Staircases
  // are walked through at a continuous 45-degree lean with no chance to turn back, exactly
  // like a classic single-tile-tread/riser slope.
  _stepAntTunnel(c) {
    const map = this.map;
    const stats = CREATURE_STATS.ANT;
    const isSolid = (x, y) => map.getTile(x, y).solid;

    const aheadX = c.col + c.travelDx, aheadY = c.row + c.travelDy;

    if (isSolid(aheadX, aheadY)) {
      // Concave corner: the wall turns to block the path ahead. Reorienting and advancing
      // into the inside corner happen together, in one glide, rather than pausing in place
      // first - a staircase needs that to read as continuous, not stop-and-go.
      const newWallDx = c.travelDx, newWallDy = c.travelDy;
      const newTravelDx = -c.wallDx, newTravelDy = -c.wallDy;
      const staircase = _isImmediateCorner(map, c.col, c.row, newWallDx, newWallDy, newTravelDx, newTravelDy);

      if (!staircase && Math.random() < ANT_CORNER_TURN_CHANCE) {
        c.travelDx *= -1;
        c.travelDy *= -1;
        c._waitTimer = stats.moveIntervalMs * 0.4;
        return;
      }

      _setAntWall(c, newWallDx, newWallDy, staircase);
      c.travelDx = newTravelDx;
      c.travelDy = newTravelDy;
      this._beginStep(c, c.col + newTravelDx, c.row + newTravelDy, stats.moveIntervalMs);
      return;
    }

    const wallAheadX = aheadX + c.wallDx, wallAheadY = aheadY + c.wallDy;
    if (!isSolid(wallAheadX, wallAheadY)) {
      // Convex corner: the wall it was hugging drops away at an edge.
      const newWallDx = -c.travelDx, newWallDy = -c.travelDy;
      const newTravelDx = c.wallDx, newTravelDy = c.wallDy;
      const staircase = _isImmediateCorner(map, wallAheadX, wallAheadY, newWallDx, newWallDy, newTravelDx, newTravelDy);

      if (!staircase && Math.random() < ANT_CORNER_TURN_CHANCE) {
        c.travelDx *= -1;
        c.travelDy *= -1;
        c._waitTimer = stats.moveIntervalMs * 0.4;
        return;
      }

      _setAntWall(c, newWallDx, newWallDy, staircase);
      c.travelDx = newTravelDx;
      c.travelDy = newTravelDy;
      this._beginStep(c, wallAheadX, wallAheadY, stats.moveIntervalMs);
      return;
    }

    // Flat stretch of wall - keep walking.
    this._beginStep(c, aheadX, aheadY, stats.moveIntervalMs);
  }

  /** Call after ant step animations complete to resolve any pending bite. */
  _resolveAttacks(mole, onMoleHurt) {
    for (const c of this.list) {
      if (c.alive && c._attacking && !c.isBusy) {
        c._attacking = false;
        if (c.col === mole.col && c.row === mole.row) {
          const dmg = FOOD_TYPES.ANT.damage;
          mole.takeDamage(dmg);
          onMoleHurt?.(c);
        }
        c.alive = false;
      }
    }
  }

  _maybeRespawn(mole) {
    this._respawnAcc = (this._respawnAcc || 0) + 1;
    if (this._respawnAcc < 240) return; // roughly every few seconds at 60fps-ish ticks
    this._respawnAcc = 0;

    // TERMITE/BEETLE are disabled for now (see module doc comment).
    for (const type of ["WORM", "ANT"]) {
      const stats = CREATURE_STATS[type];
      if (this._countAlive(type) >= stats.cap) continue;
      if (type === "WORM") {
        const col = Math.floor(Math.random() * this.map.width);
        const row = this.map.surfaceRow + 2 + Math.floor(Math.random() * (this.map.height - this.map.surfaceRow - 3));
        if (this._wormCanEnter(col, row)) this._add(type, col, row);
      } else {
        // Ants spawn just off one side of the screen and walk in, rather than popping into
        // view - pick a column safely beyond the mole's (camera stays centered on it).
        const side = Math.random() < 0.5 ? -1 : 1;
        const col = Math.max(0, Math.min(
          this.map.width - 1,
          mole.col + side * (ANT_OFFSCREEN_MARGIN + Math.floor(Math.random() * 5))
        ));
        const row = this.map.surfaceRow;
        if (this._canWalkFloor(col, row)) {
          const c = this._add(type, col, row);
          c.travelDx = -side; // walk inward, toward the visible area
          c.facing = c.travelDx;
        }
      }
    }
  }

}

// True if, starting at (col,row) with the given wall/travel orientation, taking one more step
// forward would immediately hit another corner (concave or convex). That single-tile-only
// validity is the signature of one tread/riser of a staircase, as opposed to a real corner
// with a straight run on the other side of it.
function _isImmediateCorner(map, col, row, wallDx, wallDy, travelDx, travelDy) {
  const isSolid = (x, y) => map.getTile(x, y).solid;
  const aheadX = col + travelDx, aheadY = row + travelDy;
  if (isSolid(aheadX, aheadY)) return true;
  const wallAheadX = aheadX + wallDx, wallAheadY = aheadY + wallDy;
  return !isSolid(wallAheadX, wallAheadY);
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Shortest-path angle interpolation (handles the +-pi wraparound) so a rotation animation
// always turns the short way around instead of occasionally spinning the long way.
function lerpAngle(a, b, t) {
  const twoPi = Math.PI * 2;
  const diff = (((b - a + Math.PI) % twoPi) + twoPi) % twoPi - Math.PI;
  return a + diff * t;
}

// ---------------------------------------------------------------------------
// Rendering - small, readable silhouettes for each critter type.
// ---------------------------------------------------------------------------

// Termites and beetles are floor-walkers (see the module doc comment above) - anchor their
// feet to the bottom of their current cell instead of centering them in it, or their small
// silhouettes float well above the visible ground line the way the mole's much bigger legs
// don't. Each offset is the lowest point that type's own draw function reaches below its own
// local origin (leg tips / body-ellipse bottom), at s=1 (48px tile). Ants use real sprite art
// instead (see drawAnt) whose feet already sit at the bottom edge of its own 64x64 cell, so no
// offset is needed for them.
const FOOT_OFFSET = { TERMITE: 4, BEETLE: 5 };

// Rotation that puts local "down" (feet) onto the wall the ant is clinging to. Derived from
// rotate(0,1,angle) = wallSide: canvas rotate(theta) sends local (0,1) to (-sin(theta),
// cos(theta)), so matching that to (wallDx,wallDy) gives theta = atan2(-wallDx, wallDy).
function _wallAngle(wallDx, wallDy) {
  return Math.atan2(-wallDx, wallDy);
}

// The diagonal angle bisecting two adjacent cardinal wall directions - used while an ant is
// mid-staircase, so its feet lean into the slope instead of popping between the two cardinal
// orientations every single tile.
function _wallBisectAngle(wallDxA, wallDyA, wallDxB, wallDyB) {
  return Math.atan2(-(wallDxA + wallDxB), wallDyA + wallDyB);
}

// The ant's currently rendered rotation, animating smoothly from the angle it had before its
// last orientation change to the target angle set by that change (see _setAntWall).
function _currentAntAngle(c) {
  const t = c._rotDuration > 0 ? Math.min(1, c._rotElapsed / c._rotDuration) : 1;
  return lerpAngle(c._angleFrom, c._angleTo, t);
}

// Changes which wall an ant clings to, kicking off a smooth rotation from its current visual
// angle to the new one - a cardinal angle for a real corner, or the diagonal bisector for one
// tile of a staircase (see _stepAntTunnel).
function _setAntWall(c, newWallDx, newWallDy, staircase) {
  const fromAngle = _currentAntAngle(c);
  const toAngle = staircase
    ? _wallBisectAngle(c.wallDx, c.wallDy, newWallDx, newWallDy)
    : _wallAngle(newWallDx, newWallDy);
  c.wallDx = newWallDx;
  c.wallDy = newWallDy;
  c._angleFrom = fromAngle;
  c._angleTo = toAngle;
  c._rotElapsed = 0;
  c._rotDuration = CREATURE_STATS.ANT.moveIntervalMs;
}

export function drawCreature(ctx, c, screenX, screenY, tileSize, nowMs) {
  const t = nowMs / 1000;
  const s = tileSize / 48;
  const cx = screenX + tileSize / 2;
  const cy = screenY + tileSize / 2;

  ctx.save();
  ctx.translate(cx, cy);

  if (c.type === "ANT") {
    ctx.rotate(_currentAntAngle(c));
    // Flip so the ant visually walks the direction it's actually traveling, whichever surface
    // it's currently on - "local right" (unflipped) is the wall direction rotated 90deg CCW.
    const localRightDx = c.wallDy, localRightDy = -c.wallDx;
    const facingLocalRight = c.travelDx === localRightDx && c.travelDy === localRightDy;
    // The sprite's own art faces left natively, opposite of the "unflipped = local right"
    // convention above, so the mirror condition is inverted from the usual flip=1/-1 pattern.
    ctx.scale(facingLocalRight ? -1 : 1, 1);
    drawAnt(ctx, tileSize, t, c.isBusy);
  } else if (c.type === "WORM") {
    // Worms are drawn separately (see the exported drawWorm below) - each body segment lives
    // in its own real grid cell, so it needs the camera origin rather than one shared point.
  } else {
    // Termites/beetles are currently disabled (not spawned) but keep their floor-anchored
    // rendering intact for when they're re-enabled.
    const footOffset = FOOT_OFFSET[c.type];
    if (footOffset != null) ctx.translate(0, tileSize / 2 - footOffset * s);
    ctx.scale(c.facing, 1);
    if (c.type === "TERMITE") drawTermite(ctx, s, t, c.isBusy);
    else if (c.type === "BEETLE") drawBeetle(ctx, s, t, c.isBusy);
  }

  ctx.restore();
}

// Regular worms render at half the sheet's native 64px tile size - the sprite sheet itself is
// left untouched at full size so a later "boss worm" can reuse the same art at WORM_DISPLAY_SCALE
// 1 (or higher) for a dramatically bigger creature.
const WORM_DISPLAY_SCALE = 0.5;

// The unrotated straight sprites (head/mid/tail) all face West (tapered/leading end pointing
// left) - see js/assets.js's extraction notes. Rotates that West-facing art to point `dx,dy`
// instead: canvas rotate(θ) sends local West (-1,0) to (-cosθ,-sinθ), so θ = atan2(-dy,-dx).
function _straightAngle(dx, dy) {
  return Math.atan2(-dy, -dx);
}

// The unrotated *_bend sprites are each a quarter-pipe elbow, but they are NOT all drawn with
// the same canonical orientation in the sheet - verified by inspecting each crop's actual
// pixels (which edges the art truly touches, and which way its open/tapered end curves):
//   mid_bend:  a symmetric elbow connecting East (flat, right edge) and South (flat, bottom
//              edge) - both ends are real connections, interchangeable.
//   head_bend: one flat/real edge at East (right edge); the other end is the tapered,
//              non-connecting head TIP, which curves toward North (never actually touches an
//              edge, since it's rounded, but that's the direction it opens toward).
//   tail_bend: one flat/real edge at West (left edge); the tapered tail TIP curves toward
//              North, same as head_bend's tip direction, but its flat side is mirrored.
// head_bend/tail_bend therefore each need a specific (flat -> real neighbor, tip -> open end)
// mapping, not just "which 2 directions are involved" - see _findBendTransform.
const MID_BEND_CANON = { a: [1, 0], b: [0, 1] }; // East, South (order interchangeable)
const HEAD_BEND_CANON = { flat: [1, 0], tip: [0, -1] }; // East, North
const TAIL_BEND_CANON = { flat: [-1, 0], tip: [0, -1] }; // West, North

function _vecEq(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

// Applies an optional horizontal mirror (in the sprite's own local space) followed by a
// rotation - matching the draw order `ctx.rotate(angle); ctx.scale(flip?-1:1,1);`, where the
// scale (nearest to drawImage) takes effect before the rotate.
function _applyFlipRotate([x, y], flip, angle) {
  const fx = flip ? -x : x;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return [fx * cos - y * sin, fx * sin + y * cos];
}

// Finds the (flip, angle) pair - one of the 8 combinations of an optional horizontal mirror
// and a 90-degree-step rotation - that lands a bend sprite's canonical connecting direction(s)
// on the actual directions needed this frame, so its flat edge always butts exactly against
// the flat edge of whichever real neighbor segment sits next to it. A pure rotation can only
// reach 4 of the 8 possible orientations of an asymmetric (flat+tip) shape; the other 4 need a
// mirror first, which is exactly the "flipped or rotated" case a 90-degree turn can produce
// depending on which way the worm turns.
function _findBendTransform(canon, reqFlat, reqTip) {
  for (const flip of [false, true]) {
    for (let k = 0; k < 4; k++) {
      const angle = k * (Math.PI / 2);
      if (_vecEq(_applyFlipRotate(canon.flat, flip, angle), reqFlat) &&
          _vecEq(_applyFlipRotate(canon.tip, flip, angle), reqTip)) {
        return { flip, angle };
      }
    }
  }
  return { flip: false, angle: 0 }; // unreachable for a valid perpendicular pair
}

// mid_bend's two ends are both real, interchangeable connections (see MID_BEND_CANON) - a pure
// rotation always suffices (no mirror needed) since a symmetric elbow looks the same read
// either direction, so this only searches the 4 rotations against both port assignments.
function _findMidBendTransform(dirA, dirB) {
  for (const [reqA, reqB] of [[dirA, dirB], [dirB, dirA]]) {
    for (let k = 0; k < 4; k++) {
      const angle = k * (Math.PI / 2);
      if (_vecEq(_applyFlipRotate(MID_BEND_CANON.a, false, angle), reqA) &&
          _vecEq(_applyFlipRotate(MID_BEND_CANON.b, false, angle), reqB)) {
        return { flip: false, angle };
      }
    }
  }
  return { flip: false, angle: 0 };
}

// True only for a genuine 90-degree turn between two cardinal directions - false for both
// "same direction" and "180-degree reversal", neither of which any *_bend sprite can represent.
function _isRightAngle(dxA, dyA, dxB, dyB) {
  return dxA * dxB + dyA * dyB === 0;
}

// Every segment (head, middles, tail alike) compares the direction arriving into it from the
// tail-ward side against the direction leaving it toward the head-ward side: equal (or a full
// reversal) renders straight, a genuine right angle renders that segment's *_bend art. The
// head has no tail-ward neighbor while it isn't turning, so it just faces the worm's current
// travel direction; while c._wormTurning is set (the one-tick in-place pivot - see
// CreatureManager._tickWorm) it instead bridges the old travel direction (its flat edge, toward
// the body) to the new pending one (its tapered tip), which is the only time headBend is ever
// used. The real tail (index n-1) is the only OTHER segment whose *_bend sprite can appear,
// once it sweeps through the same corner tile the head and any middles already turned at -
// trail[n] (one past the last real segment) is a hidden ghost slot carried purely so the tail
// has a "trail-ward neighbor" to compare against, same as everyone else; the physical direction
// toward that ghost (-dirIn) is where the tail's tapered tip points, and dirOut (the physical
// direction to the real neighbor ahead) is where its flat edge connects.
function _wormSegmentArt(c, i) {
  const { head, mid, tail, headBend, midBend, tailBend } = wormSegmentSprites;
  const trail = c.trail;
  const n = trail.length - 1;

  if (i === 0) {
    if (c._wormTurning) {
      if (_isRightAngle(c.wormDx, c.wormDy, c._pendingDx, c._pendingDy)) {
        const { flip, angle } = _findBendTransform(HEAD_BEND_CANON, [-c.wormDx, -c.wormDy], [c._pendingDx, c._pendingDy]);
        return { img: headBend, angle, flip };
      }
      return { img: head, angle: _straightAngle(c._pendingDx, c._pendingDy), flip: false };
    }
    return { img: head, angle: _straightAngle(c.wormDx, c.wormDy), flip: false };
  }

  // dirIn is the direction of TRAVEL arriving at this segment (trail[i] minus the tail-ward
  // neighbor trail[i+1]) - the physical direction FROM here TOWARD that neighbor is the
  // opposite, -dirIn. dirOut (trail[i-1] minus trail[i]) is already the physical direction
  // toward the head-ward neighbor, no flip needed. Every *_bend orientation below is built
  // from real/physical neighbor directions, so dirIn is negated at every use.
  const dirInDx = Math.sign(trail[i].col - trail[i + 1].col);
  const dirInDy = Math.sign(trail[i].row - trail[i + 1].row);
  const dirOutDx = Math.sign(trail[i - 1].col - trail[i].col);
  const dirOutDy = Math.sign(trail[i - 1].row - trail[i].row);
  const isBend = _isRightAngle(dirInDx, dirInDy, dirOutDx, dirOutDy);

  if (i === n - 1) {
    if (!isBend) return { img: tail, angle: _straightAngle(dirOutDx, dirOutDy), flip: false };
    const { flip, angle } = _findBendTransform(TAIL_BEND_CANON, [dirOutDx, dirOutDy], [-dirInDx, -dirInDy]);
    return { img: tailBend, angle, flip };
  }
  if (!isBend) return { img: mid, angle: _straightAngle(dirOutDx, dirOutDy), flip: false };
  const { flip, angle } = _findMidBendTransform([-dirInDx, -dirInDy], [dirOutDx, dirOutDy]);
  return { img: midBend, angle, flip };
}

function _drawWormSegment(ctx, placement, x, y, segSize) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(placement.angle);
  ctx.scale(placement.flip ? -1 : 1, 1);
  ctx.drawImage(placement.img, -segSize / 2, -segSize / 2, segSize, segSize);
  ctx.restore();
}

// Reuses one offscreen canvas per worm (instead of allocating a fresh one every frame) to
// render the glow silhouette into.
function _wormGlowCanvas(c, w, h) {
  if (!c._glowCanvas) c._glowCanvas = document.createElement("canvas");
  const canvas = c._glowCanvas;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return canvas;
}

const WORM_GLOW_BLUR = 0.2; // fraction of segment size
const WORM_GLOW_COLOR = "rgba(0, 0, 0, 0.7)";

/**
 * Worms occupy a real trail of grid cells (Snake-style), so they need the camera origin
 * rather than a single screen position - called directly by game.js instead of going through
 * drawCreature. Each segment is drawn exactly at its settled half-tile position - no glide or
 * scaling animation between steps, just a snap from one position to the next (see
 * CreatureManager._tickWorm). A segment overlaid inside solid dirt stays centered in its cell;
 * one resting on an open floor (a dug-out tunnel or the grass surface) is shifted down so it
 * sits directly on the ground plane instead of floating mid-cell.
 *
 * The whole body gets a single soft black glow rather than one per segment: every segment is
 * first drawn into an offscreen buffer (reused per worm, not reallocated every frame), then that
 * ONE flattened silhouette casts the shadow - so adjacent/overlapping segments never double up
 * their glow at the seams the way stacking per-segment shadows would, and the glow always reads
 * as one continuous halo around the whole worm rather than a chain of separate blobs.
 */
export function drawWorm(ctx, map, c, originX, originY, tileSize) {
  if (!wormSegmentSprites || !c.trail) return;
  const segSize = tileSize * WORM_DISPLAY_SCALE;
  const segCount = c.trail.length - 1; // last slot is the hidden ghost, never drawn
  if (segCount <= 0) return;

  const placements = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < segCount; i++) {
    const { col, row } = c.trail[i];
    const { img, angle, flip } = _wormSegmentArt(c, i);
    const cellCol = Math.round(col), cellRow = Math.round(row);
    const onFloor = !map.getTile(cellCol, cellRow).solid;
    const screenX = originX + col * tileSize + tileSize / 2;
    const screenY = onFloor
      ? originY + (row + 1) * tileSize - segSize / 2 // rest on the floor, not floating mid-cell
      : originY + row * tileSize + tileSize / 2; // centered, overlaid in the surrounding dirt
    placements.push({ img, angle, flip, screenX, screenY });
    minX = Math.min(minX, screenX);
    maxX = Math.max(maxX, screenX);
    minY = Math.min(minY, screenY);
    maxY = Math.max(maxY, screenY);
  }

  const pad = segSize; // room for rotated corners plus the blur radius
  minX -= pad; maxX += pad; minY -= pad; maxY += pad;
  const bufW = Math.ceil(maxX - minX), bufH = Math.ceil(maxY - minY);
  const buf = _wormGlowCanvas(c, bufW, bufH);
  const bctx = buf.getContext("2d");
  bctx.clearRect(0, 0, bufW, bufH);
  for (const p of placements) {
    _drawWormSegment(bctx, p, p.screenX - minX, p.screenY - minY, segSize);
  }

  ctx.save();
  ctx.shadowColor = WORM_GLOW_COLOR;
  ctx.shadowBlur = segSize * WORM_GLOW_BLUR;
  ctx.drawImage(buf, minX, minY);
  ctx.shadowColor = "transparent";
  ctx.drawImage(buf, minX, minY);
  ctx.restore();
}

const ANT_DISPLAY_SCALE = 0.5;
const ANT_WALK_FPS = 5; // walk-cycle playback speed while moving

// The 6 walk-cycle frames fill their own 64x64 cell with feet at the bottom edge; anchor that
// bottom edge to tileSize/2 (the wall-facing edge, pre-rotation) so scaling down still keeps
// the ant's feet planted on the surface it's clinging to instead of floating mid-cell.
function drawAnt(ctx, tileSize, t, moving) {
  if (!antWalkSprites) return;
  const frame = moving ? Math.floor(t * ANT_WALK_FPS) % antWalkSprites.length : 0;
  const size = tileSize * ANT_DISPLAY_SCALE;
  ctx.drawImage(antWalkSprites[frame], -size / 2, tileSize / 2 - size, size, size);
}

function drawTermite(ctx, s, t, moving) {
  const bob = moving ? Math.sin(t * 24) * 1 * s : 0;
  ctx.translate(0, bob);
  ctx.fillStyle = "#e8d9b8";
  ctx.beginPath();
  ctx.ellipse(0, 0, 6 * s, 4 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#c9b587";
  ctx.beginPath();
  ctx.ellipse(4.5 * s, -0.5 * s, 2 * s, 1.8 * s, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawBeetle(ctx, s, t, moving) {
  const bob = moving ? Math.sin(t * 18) * 0.8 * s : 0;
  ctx.translate(0, bob);
  ctx.fillStyle = "#2f3a24";
  ctx.beginPath();
  ctx.ellipse(0, 0, 7 * s, 5 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#1c2416";
  ctx.lineWidth = 1 * s;
  ctx.beginPath();
  ctx.moveTo(0, -5 * s);
  ctx.lineTo(0, 5 * s);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.beginPath();
  ctx.ellipse(-2 * s, -2 * s, 2.5 * s, 1.4 * s, -0.4, 0, Math.PI * 2);
  ctx.fill();
}
