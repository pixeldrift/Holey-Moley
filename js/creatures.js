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

let wormSegmentSprites = null; // { head, mid, tail }

/** Must be called once with assets.js's loaded images before any drawCreature call. */
export function initCreatureSprites(sprites) {
  wormSegmentSprites = { head: sprites.wormHead, mid: sprites.wormMid, tail: sprites.wormTail };
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
    this.hidden = false; // worms inside solid dirt aren't drawn
    // Worms are built from a head + tail + 0-3 repeated middle segments, so they come out
    // in a few different lengths instead of always looking identical.
    this.wormMiddleSegments = type === "WORM" ? Math.floor(Math.random() * 4) : 0;

    // Ants cling to whatever surface they're walking on rather than always walking
    // horizontally on a floor. wallD{x,y} is the unit vector from the ant to the solid
    // neighbor it's standing on (0,1 = normal floor); travelD{x,y} is perpendicular to that,
    // the direction it's currently walking along that surface.
    if (type === "ANT") {
      this.wallDx = 0;
      this.wallDy = 1;
      this.travelDx = this.facing;
      this.travelDy = 0;
    }
  }
}

function randomBetween(a, b) {
  return a + Math.random() * (b - a);
}

const ANT_SPAWN_EXCLUSION = 7; // tiles from the mole's start column ants won't spawn within
const ANT_SURFACE_TURN_CHANCE = 0.1; // ~1-in-10 chance per tile to turn back while on open ground
const ANT_CORNER_TURN_CHANCE = 0.25; // chance to turn back instead of following a tunnel corner
const ANT_OFFSCREEN_MARGIN = 10; // tiles beyond the mole's column considered safely offscreen

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
      if (map.getTile(col, row) !== TILE.ROCK) this._add("WORM", col, row);
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

    if (c.type === "WORM") {
      this._stepWorm(c);
    } else if (c.type === "ANT") {
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

  _stepWorm(c) {
    const stats = CREATURE_STATS.WORM;
    const dirs = shuffled([[1, 0], [-1, 0], [0, 1], [0, -1]]);
    for (const [dx, dy] of dirs) {
      const nc = c.col + dx, nr = c.row + dy;
      if (!this.map.inBounds(nc, nr)) continue;
      if (nc === this._moleColHint && nr === this._moleRowHint) continue;
      const tile = this.map.getTile(nc, nr);
      if (tile === TILE.ROCK || tile === TILE.SKY) continue;
      this._beginStep(c, nc, nr, stats.moveIntervalMs);
      return;
    }
    c._waitTimer = stats.moveIntervalMs * 0.5;
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
      c.wallDx = -c.travelDx;
      c.wallDy = 0;
      c.travelDx = 0;
      c.travelDy = 1;
      this._beginStep(c, nc, c.row + 1, stats.moveIntervalMs);
      return;
    }

    this._beginStep(c, nc, c.row, stats.moveIntervalMs);
  }

  // Generic wall-following, valid regardless of which surface (floor/wall/ceiling) the ant is
  // currently clinging to: keep walking while the wall continues, and treat both "wall blocks
  // the path ahead" (concave corner) and "wall drops away at an edge" (convex corner) as
  // corner events with the same turn-around-or-follow odds.
  _stepAntTunnel(c) {
    const map = this.map;
    const stats = CREATURE_STATS.ANT;
    const isSolid = (x, y) => map.getTile(x, y).solid;

    const aheadX = c.col + c.travelDx, aheadY = c.row + c.travelDy;

    if (isSolid(aheadX, aheadY)) {
      // Concave corner: the wall turns to block the path ahead.
      if (Math.random() < ANT_CORNER_TURN_CHANCE) {
        c.travelDx *= -1;
        c.travelDy *= -1;
      } else {
        const newWallDx = c.travelDx, newWallDy = c.travelDy;
        c.travelDx = -c.wallDx;
        c.travelDy = -c.wallDy;
        c.wallDx = newWallDx;
        c.wallDy = newWallDy;
      }
      c._waitTimer = stats.moveIntervalMs * 0.4;
      return;
    }

    const wallAheadX = aheadX + c.wallDx, wallAheadY = aheadY + c.wallDy;
    if (!isSolid(wallAheadX, wallAheadY)) {
      // Convex corner: the wall it was hugging drops away at an edge.
      if (Math.random() < ANT_CORNER_TURN_CHANCE) {
        c.travelDx *= -1;
        c.travelDy *= -1;
        c._waitTimer = stats.moveIntervalMs * 0.4;
        return;
      }
      const newWallDx = -c.travelDx, newWallDy = -c.travelDy;
      const newTravelDx = c.wallDx, newTravelDy = c.wallDy;
      c.wallDx = newWallDx;
      c.wallDy = newWallDy;
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
        const tile = this.map.getTile(col, row);
        if (tile !== TILE.ROCK && tile !== TILE.SKY) this._add(type, col, row);
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

// ---------------------------------------------------------------------------
// Rendering - small, readable silhouettes for each critter type.
// ---------------------------------------------------------------------------

// Ants, termites, and beetles are floor-walkers (see the module doc comment above) - anchor
// their feet to the bottom of their current cell instead of centering them in it, or their
// small silhouettes float well above the visible ground line the way the mole's much bigger
// legs don't. Each offset is the lowest point that type's own draw function reaches below its
// own local origin (leg tips / body-ellipse bottom), at s=1 (48px tile).
const FOOT_OFFSET = { ANT: 5, TERMITE: 4, BEETLE: 5 };

// Rotation that puts local "down" (feet) onto the wall the ant is clinging to, keyed by
// wallDx,wallDy. Derived from rotate(0,1,angle) = wallSide for each of the 4 cardinal cases.
const ANT_WALL_ANGLE = {
  "0,1": 0, // normal floor
  "1,0": -Math.PI / 2, // right-hand wall
  "0,-1": Math.PI, // ceiling
  "-1,0": Math.PI / 2, // left-hand wall
};

export function drawCreature(ctx, c, screenX, screenY, tileSize, nowMs) {
  const t = nowMs / 1000;
  const s = tileSize / 48;
  const cx = screenX + tileSize / 2;
  const cy = screenY + tileSize / 2;

  ctx.save();
  ctx.translate(cx, cy);

  if (c.type === "ANT") {
    ctx.rotate(ANT_WALL_ANGLE[`${c.wallDx},${c.wallDy}`] ?? 0);
    // Flip so the ant visually walks the direction it's actually traveling, whichever surface
    // it's currently on - "local right" (unflipped) is the wall direction rotated 90deg CCW.
    const localRightDx = c.wallDy, localRightDy = -c.wallDx;
    const flip = (c.travelDx === localRightDx && c.travelDy === localRightDy) ? 1 : -1;
    ctx.scale(flip, 1);
    ctx.translate(0, tileSize / 2 - FOOT_OFFSET.ANT * s);
    drawAnt(ctx, s, t, c.isBusy);
  } else if (c.type === "WORM") {
    drawWorm(ctx, s, t, c.wormMiddleSegments);
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

// Built from a head + 0-3 repeated middle segments + tail, always laid out head-on-the-left
// to tail-on-the-right (matching the sheet's own col4=head..col6=tail ordering) - gives worms
// a few different lengths instead of one fixed sprite.
//
// Regular worms render at half the sheet's native 64px tile size - the sprite sheet itself is
// left untouched at full size so a later "boss worm" can reuse the same art at WORM_DISPLAY_SCALE
// 1 (or higher) for a dramatically bigger creature.
const WORM_DISPLAY_SCALE = 0.5;

// Inchworm gait: compress the body toward the head (tail scoots forward, head fixed), then
// extend it back out from the tail (head reaches forward, tail fixed) - alternating which end
// stays put over one cycle is what reads as "inching" rather than just squashing in place.
const WORM_INCH_CYCLE_MS = 1000;
const WORM_INCH_MIN_SCALE = 0.8;

function drawWorm(ctx, s, t, middleSegments) {
  if (!wormSegmentSprites) return;
  const { head, mid, tail } = wormSegmentSprites;
  const tileSize = s * 48 * WORM_DISPLAY_SCALE;
  const totalSegments = 2 + middleSegments;

  const half = WORM_INCH_CYCLE_MS / 2;
  const cycleMs = (t * 1000) % WORM_INCH_CYCLE_MS;
  const compressing = cycleMs < half;
  const local = easeInOutQuad((compressing ? cycleMs : cycleMs - half) / half);
  const scaleX = compressing
    ? lerp(1, WORM_INCH_MIN_SCALE, local)
    : lerp(WORM_INCH_MIN_SCALE, 1, local);

  const restW = tileSize * totalSegments;
  const headX = -restW / 2; // fixed while compressing
  const tailXAtMin = headX + (totalSegments - 1) * tileSize * WORM_INCH_MIN_SCALE; // where the tail lands at full compression; fixed while extending

  ctx.save();
  for (let i = 0; i < totalSegments; i++) {
    const img = i === 0 ? head : i === totalSegments - 1 ? tail : mid;
    const x = compressing
      ? headX + i * tileSize * scaleX
      : tailXAtMin - (totalSegments - 1 - i) * tileSize * scaleX;
    ctx.drawImage(img, x, -tileSize / 2, tileSize, tileSize);
  }
  ctx.restore();
}

function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function drawAnt(ctx, s, t, moving) {
  const bob = moving ? Math.sin(t * 30) * 1 * s : 0;
  ctx.translate(0, bob);
  ctx.strokeStyle = "#241a12";
  ctx.lineWidth = 1 * s;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 3 * s, 0);
    ctx.lineTo(i * 3 * s + (moving ? Math.sin(t * 20 + i) * 3 * s : 3 * s), 5 * s);
    ctx.stroke();
  }
  ctx.fillStyle = "#1e1610";
  ctx.beginPath();
  ctx.ellipse(-4 * s, 0, 3 * s, 2.4 * s, 0, 0, Math.PI * 2);
  ctx.ellipse(0, 0, 3.4 * s, 2.8 * s, 0, 0, Math.PI * 2);
  ctx.ellipse(4.5 * s, -0.5 * s, 2.4 * s, 2 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#1e1610";
  ctx.beginPath();
  ctx.moveTo(6 * s, -2 * s);
  ctx.lineTo(9 * s, -5 * s);
  ctx.moveTo(6.5 * s, -1 * s);
  ctx.lineTo(9.5 * s, -3 * s);
  ctx.stroke();
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
