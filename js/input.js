// Unified input: keyboard (desktop) + pointer events (mouse & touch alike).
//
// Pointer handling covers drag, swipe and tap with one code path:
//  - press and move past a small threshold -> continuous "held direction"
//    (this is both the drag-joystick and a swipe-and-hold).
//  - release without much movement -> a single-step "tap" nudge, direction
//    chosen relative to the mole's on-screen position (passed in via getMoleScreenPos).
//
// Directions snap to 8 ways (orthogonal + diagonal) so the mole can dig at 45 degrees.
//
// Consumers read `getDirection()` each tick for continuous movement, and
// register onStep(dx,dy) for one-shot taps/key-presses.

const DRAG_THRESHOLD = 14; // px before a press counts as a drag instead of a tap
const KEY_DIRS = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0],
};

export class InputController {
  constructor(canvas, { getMoleScreenPos } = {}) {
    this.canvas = canvas;
    this.getMoleScreenPos = getMoleScreenPos || (() => ({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }));
    this.keyDir = { dx: 0, dy: 0 };
    this._activeKeys = new Set();
    this.pointerDir = { dx: 0, dy: 0 };
    this._dragging = false;
    this._pointerId = null;
    this._startX = 0;
    this._startY = 0;
    this.onStep = null; // (dx,dy) callback for taps

    this._bind();
  }

  _bind() {
    window.addEventListener("keydown", (e) => {
      const dir = KEY_DIRS[e.code];
      if (!dir) return;
      if (!this._activeKeys.has(e.code)) {
        this._activeKeys.add(e.code);
        this._recomputeKeyDir();
      }
    });
    window.addEventListener("keyup", (e) => {
      if (this._activeKeys.delete(e.code)) {
        this._recomputeKeyDir();
      }
    });
    window.addEventListener("blur", () => {
      this._activeKeys.clear();
      this._recomputeKeyDir();
    });

    this.canvas.addEventListener("pointerdown", (e) => this._onPointerDown(e));
    this.canvas.addEventListener("pointermove", (e) => this._onPointerMove(e));
    this.canvas.addEventListener("pointerup", (e) => this._onPointerUp(e));
    this.canvas.addEventListener("pointercancel", (e) => this._onPointerUp(e));
  }

  _recomputeKeyDir() {
    let dx = 0, dy = 0;
    for (const code of this._activeKeys) {
      const [kx, ky] = KEY_DIRS[code];
      dx += kx; dy += ky;
    }
    // Holding two adjacent-axis keys (e.g. Up+Right) gives a diagonal.
    this.keyDir.dx = Math.sign(dx);
    this.keyDir.dy = Math.sign(dy);
  }

  _onPointerDown(e) {
    this.canvas.setPointerCapture?.(e.pointerId);
    this._pointerId = e.pointerId;
    this._startX = e.clientX;
    this._startY = e.clientY;
    this._dragging = false;
    this.pointerDir = { dx: 0, dy: 0 };
  }

  _onPointerMove(e) {
    if (e.pointerId !== this._pointerId) return;
    const dx = e.clientX - this._startX;
    const dy = e.clientY - this._startY;
    const dist = Math.hypot(dx, dy);
    if (dist > DRAG_THRESHOLD) {
      this._dragging = true;
      this.pointerDir = octantFromVector(dx, dy);
    }
  }

  _onPointerUp(e) {
    if (e.pointerId !== this._pointerId) return;
    if (!this._dragging) {
      // Tap: nudge one step toward the tap point relative to the mole's screen position.
      const molePos = this.getMoleScreenPos();
      const dx = e.clientX - molePos.x;
      const dy = e.clientY - molePos.y;
      if (Math.hypot(dx, dy) > 6) {
        const dir = octantFromVector(dx, dy);
        this.onStep?.(dir.dx, dir.dy);
      }
    }
    this._dragging = false;
    this._pointerId = null;
    this.pointerDir = { dx: 0, dy: 0 };
  }

  /** Continuous held direction this frame, from keyboard or pointer-drag. */
  getDirection() {
    if (this.keyDir.dx !== 0 || this.keyDir.dy !== 0) return this.keyDir;
    if (this.pointerDir.dx !== 0 || this.pointerDir.dy !== 0) return this.pointerDir;
    return { dx: 0, dy: 0 };
  }
}

// Snaps a drag/swipe/tap vector to one of 8 directions (orthogonal + diagonal).
function octantFromVector(dx, dy) {
  const angle = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const snapped = Math.round(angle / step) * step;
  return { dx: Math.round(Math.cos(snapped)), dy: Math.round(Math.sin(snapped)) };
}
