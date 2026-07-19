// Living food: worms wander freely through solid dirt and open tunnels alike. Ants,
// termites and beetles are surface walkers - they're only ever on an open cell that has
// solid floor beneath it (the original ground surface, or the floor of a tunnel the mole
// has dug). Ants additionally chase the mole down a shared row and attack on contact;
// everything else is harmless and just gets eaten when the mole walks/digs into its cell.

import { TILE } from "./tiles.js";
import { FOOD_TYPES, CREATURE_STATS } from "./constants.js";

const STEP_DURATION = 260;

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
    this._duration = STEP_DURATION;
    this._fromCol = col;
    this._fromRow = row;
    this._toCol = col;
    this._toRow = row;
    this._waitTimer = randomBetween(0, CREATURE_STATS[type].moveIntervalMs);
    this.hidden = false; // worms inside solid dirt aren't drawn
  }
}

function randomBetween(a, b) {
  return a + Math.random() * (b - a);
}

const ANT_SPAWN_EXCLUSION = 7; // tiles from the mole's start column ants won't spawn within

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
    const surfaceCounts = { ANT: CREATURE_STATS.ANT.cap, TERMITE: CREATURE_STATS.TERMITE.cap, BEETLE: CREATURE_STATS.BEETLE.cap };
    for (const [type, count] of Object.entries(surfaceCounts)) {
      for (let i = 0; i < count; i++) {
        let col;
        do {
          col = Math.floor(Math.random() * map.width);
        } while (type === "ANT" && Math.abs(col - moleStartCol) < ANT_SPAWN_EXCLUSION);
        this._add(type, col, map.surfaceRow);
      }
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

    this._maybeRespawn();
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

  _beginStep(c, toCol, toRow, interval) {
    c.facing = toCol > c.col ? 1 : toCol < c.col ? -1 : c.facing;
    c._fromCol = c.col;
    c._fromRow = c.row;
    c._toCol = toCol;
    c._toRow = toRow;
    c._elapsed = 0;
    c._duration = STEP_DURATION;
    c.isBusy = true;
    c._waitTimer = interval;
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

  _stepAnt(c, mole, onMoleHurt) {
    const stats = CREATURE_STATS.ANT;
    const sameRow = c.row === mole.row;
    const dist = Math.abs(c.col - mole.col);

    if (sameRow && dist <= stats.detectRange && dist > 0) {
      const dir = mole.col > c.col ? 1 : -1;
      const nc = c.col + dir;
      const nr = c.row;
      if (nc === mole.col && nr === mole.row) {
        c.facing = dir;
        c._fromCol = c.col; c._fromRow = c.row;
        c._toCol = nc; c._toRow = nr;
        c._elapsed = 0; c._duration = STEP_DURATION; c.isBusy = true;
        c._waitTimer = stats.chaseIntervalMs;
        c._attacking = true;
        return;
      }
      if (this._canWalkFloor(nc, nr)) {
        this._beginStep(c, nc, nr, stats.chaseIntervalMs);
        return;
      }
    }
    this._stepSurfaceBug(c, mole);
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

  _maybeRespawn() {
    this._respawnAcc = (this._respawnAcc || 0) + 1;
    if (this._respawnAcc < 240) return; // roughly every few seconds at 60fps-ish ticks
    this._respawnAcc = 0;

    for (const type of ["WORM", "ANT", "TERMITE", "BEETLE"]) {
      const stats = CREATURE_STATS[type];
      if (this._countAlive(type) >= stats.cap) continue;
      if (type === "WORM") {
        const col = Math.floor(Math.random() * this.map.width);
        const row = this.map.surfaceRow + 2 + Math.floor(Math.random() * (this.map.height - this.map.surfaceRow - 3));
        const tile = this.map.getTile(col, row);
        if (tile !== TILE.ROCK && tile !== TILE.SKY) this._add(type, col, row);
      } else {
        // Spawn onto any currently-valid floor cell (surface row always qualifies).
        for (let attempt = 0; attempt < 12; attempt++) {
          const col = Math.floor(Math.random() * this.map.width);
          const row = this.map.surfaceRow;
          if (this._canWalkFloor(col, row)) {
            this._add(type, col, row);
            break;
          }
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

export function drawCreature(ctx, c, screenX, screenY, tileSize, nowMs) {
  const t = nowMs / 1000;
  const s = tileSize / 48;
  const cx = screenX + tileSize / 2;
  const cy = screenY + tileSize / 2;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(c.facing, 1);

  if (c.type === "WORM") {
    drawWorm(ctx, s, t);
  } else if (c.type === "ANT") {
    drawAnt(ctx, s, t, c.isBusy);
  } else if (c.type === "TERMITE") {
    drawTermite(ctx, s, t, c.isBusy);
  } else if (c.type === "BEETLE") {
    drawBeetle(ctx, s, t, c.isBusy);
  }

  ctx.restore();
}

function drawWorm(ctx, s, t) {
  const wiggle = Math.sin(t * 8) * 2 * s;
  ctx.strokeStyle = "#d98a9a";
  ctx.lineWidth = 4 * s;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-8 * s, wiggle);
  ctx.quadraticCurveTo(0, -wiggle, 8 * s, wiggle);
  ctx.stroke();
  ctx.fillStyle = "#c96c80";
  ctx.beginPath();
  ctx.arc(8 * s, wiggle, 2.2 * s, 0, Math.PI * 2);
  ctx.fill();
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
