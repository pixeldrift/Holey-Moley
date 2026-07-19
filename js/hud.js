import { MAX_ENERGY } from "./mole.js";

export class HUD {
  constructor() {
    this.scoreEl = document.getElementById("score-value");
    this.depthEl = document.getElementById("depth-value");
    this.energyFillEl = document.getElementById("energy-fill");

    this.startScreen = document.getElementById("start-screen");
    this.pauseScreen = document.getElementById("pause-screen");
    this.settingsScreen = document.getElementById("settings-screen");

    this.btnPlay = document.getElementById("btn-play");
    this.btnPause = document.getElementById("btn-pause");
    this.btnResume = document.getElementById("btn-resume");
    this.btnSettings = document.getElementById("btn-settings");
    this.btnCloseSettings = document.getElementById("btn-close-settings");
    this.btnRestart = document.getElementById("btn-restart");
    this.chkSound = document.getElementById("chk-sound");
    this.selControls = document.getElementById("sel-controls");

    this.callbacks = {};
  }

  on(name, fn) {
    this.callbacks[name] = fn;
  }

  bind() {
    this.btnPlay.addEventListener("click", () => this.callbacks.play?.());
    this.btnPause.addEventListener("click", () => this.callbacks.pause?.());
    this.btnResume.addEventListener("click", () => this.callbacks.resume?.());
    this.btnSettings.addEventListener("click", () => this.callbacks.openSettings?.());
    this.btnCloseSettings.addEventListener("click", () => this.callbacks.closeSettings?.());
    this.btnRestart.addEventListener("click", () => this.callbacks.restart?.());
    this.chkSound.addEventListener("change", (e) => this.callbacks.soundToggle?.(e.target.checked));
    this.selControls.addEventListener("change", (e) => this.callbacks.controlSchemeChange?.(e.target.value));
  }

  showStart() {
    this.startScreen.classList.remove("hidden");
  }
  hideStart() {
    this.startScreen.classList.add("hidden");
  }
  showPause() {
    this.pauseScreen.classList.remove("hidden");
    this.btnPause.textContent = "▶";
  }
  hidePause() {
    this.pauseScreen.classList.add("hidden");
    this.btnPause.textContent = "⏸";
  }
  showSettings() {
    this.settingsScreen.classList.remove("hidden");
  }
  hideSettings() {
    this.settingsScreen.classList.add("hidden");
  }

  setScore(score) {
    this.scoreEl.textContent = score;
  }

  setDepth(depth) {
    this.depthEl.textContent = Math.max(0, depth);
  }

  setEnergy(energy) {
    const pct = Math.max(0, Math.min(100, (energy / MAX_ENERGY) * 100));
    this.energyFillEl.style.width = `${pct}%`;
    let color;
    if (pct > 55) color = "linear-gradient(90deg,#4caf50,#8bc34a)";
    else if (pct > 25) color = "linear-gradient(90deg,#f9a825,#fbc02d)";
    else color = "linear-gradient(90deg,#e53935,#ef5350)";
    this.energyFillEl.style.background = color;
  }
}
