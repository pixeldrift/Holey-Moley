// Movement collision queries against a ScalarField (see field.js) - the v2 replacement for
// tiles.js's isEdgeSolid/canEnter/diagonalSlopeDir, which only ever had to reason about 5 fixed
// SHAPE cases. A field has no such enum to pattern-match against, so these work by raycasting a
// short distance through the actual continuous density instead - correct for any carved shape,
// not just a 45-degree cut, and the same primitive answers every one of these questions instead
// of needing a separate hand-derived formula per case the way tiles.js did.

import { SOLID_THRESHOLD } from "./field.js";

// Step size for marching a ray through the field, in tile-units - fine enough that even a
// fairly thin wall a dig could leave behind still gets sampled inside it, coarse enough to stay
// cheap (a handful of samples per ray, not hundreds).
const RAY_STEP = 1 / 16;

/** March from (x,y) in direction (dx,dy) (need not be a unit vector) up to maxDist tile-units,
 *  stopping at the first solid sample. Returns {dist, x, y, normal} for the hit, or null if
 *  nothing solid was found in range. normal points away from the solid material, into open
 *  space - the same convention textures.js's bevel highlight/shadow split already uses. */
export function raycast(field, x, y, dx, dy, maxDist) {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const steps = Math.max(1, Math.ceil(maxDist / RAY_STEP));
  let loDist = 0;
  for (let i = 1; i <= steps; i++) {
    const hiDist = Math.min(maxDist, (i / steps) * maxDist);
    const px = x + ux * hiDist, py = y + uy * hiDist;
    if (field.sampleWorld(px, py) >= SOLID_THRESHOLD) {
      const dist = _refineHit(field, x, y, ux, uy, loDist, hiDist);
      const hx = x + ux * dist, hy = y + uy * dist;
      return { dist, x: hx, y: hy, normal: _estimateNormal(field, hx, hy) };
    }
    loDist = hiDist;
  }
  return null;
}

// A coarse RAY_STEP can land its first "solid" sample anywhere up to one whole step past the
// true boundary - fine for "is there something in range" but not precise enough to estimate a
// normal from (the gradient sample below needs to actually straddle the real crossing, not two
// points both still buried inside the same solid mass). Bisects the last clear/solid pair down
// to well under one gradient-sampling epsilon before returning.
function _refineHit(field, x, y, ux, uy, loDist, hiDist) {
  for (let i = 0; i < 6; i++) {
    const mid = (loDist + hiDist) / 2;
    if (field.sampleWorld(x + ux * mid, y + uy * mid) >= SOLID_THRESHOLD) hiDist = mid;
    else loDist = mid;
  }
  return hiDist;
}

// The field has no analytic normal the way a hand-classified SHAPE did (see tiles.js
// diagonalSlopeDir) - estimated instead from a small central-difference gradient. Density rises
// toward the interior of solid material, so the raw gradient points INTO solid; the outward
// normal (away from solid, into open air) is its negation.
function _estimateNormal(field, x, y) {
  const eps = 0.5 / field.res;
  const gx = field.sampleWorld(x + eps, y) - field.sampleWorld(x - eps, y);
  const gy = field.sampleWorld(x, y + eps) - field.sampleWorld(x, y - eps);
  const len = Math.hypot(gx, gy);
  if (len < 1e-6) return { x: 0, y: -1 }; // degenerate (uniform neighborhood) - default to "floor"
  return { x: -gx / len, y: -gy / len };
}

/** True if a surface's outward normal faces meaningfully downward - the underside of an
 *  overhang. 0.3 is a generous ~17 degrees past vertical before something counts as an overhang
 *  rather than just a steep wall. */
export function isOverhangNormal(normal) {
  return normal.y > 0.3;
}

/** Straight-line field equivalent of TileMap.canEnter: true only if nothing solid lies anywhere
 *  between (fromX,fromY) and (toX,toY), not just at the destination - catches a path that grazes
 *  a thin wall along the way, which a single sample at the target alone would miss. Works for
 *  any direction, not just the 8 compass angles a SHAPE could describe. */
export function canEnterField(field, fromX, fromY, toX, toY) {
  const dx = toX - fromX, dy = toY - fromY;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return true;
  return raycast(field, fromX, fromY, dx, dy, dist) === null;
}

// Directions fanned out from straight down (0 degrees), used by findSupport to search for
// nearby ground OR a nearby wall to catch a fall - not just what's directly underfoot. Angles
// go out to +/-80 degrees (nearly horizontal) so a wall just to one side in a narrow shaft is
// found before the mole ever starts truly falling through open air, matching "shouldn't fall
// straight down a shaft unless an edge is more than a tile away."
const SUPPORT_ANGLES_DEG = [0, -20, 20, -40, 40, -60, 60, -80, 80];

/** The closest solid surface within maxDist tile-units of (x,y), searching a fan of directions
 *  centered on straight down - gravity's "stick to the closest surface" rule. Overhangs are
 *  never valid support (see isOverhangNormal) - a surface only above and behind, with nothing
 *  underneath, doesn't count as something to stand on or cling to. Returns the same shape as
 *  raycast (dist/x/y/normal), or null if nothing usable was found in range. */
export function findSupport(field, x, y, maxDist) {
  let best = null;
  for (const deg of SUPPORT_ANGLES_DEG) {
    const rad = (deg * Math.PI) / 180;
    const hit = raycast(field, x, y, Math.sin(rad), Math.cos(rad), maxDist);
    if (hit && !isOverhangNormal(hit.normal) && (!best || hit.dist < best.dist)) best = hit;
  }
  return best;
}
