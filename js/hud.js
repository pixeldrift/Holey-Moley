import { MAX_ENERGY } from "./mole.js";
import { ENERGY } from "./constants.js";
import { STATS, STAT_MAX_LEVEL, MOLE_COLORS } from "./profile.js";

export class HUD {
  constructor() {
    this.scoreEl = document.getElementById("score-value");
    this.depthEl = document.getElementById("depth-value");
    this.energyFillEl = document.getElementById("energy-fill");
    this.energyBoxEl = document.getElementById("energy-box");
    this.energyWarnEl = document.getElementById("energy-warn");

    this.startScreen = document.getElementById("start-screen");
    this.pauseScreen = document.getElementById("pause-screen");
    this.settingsScreen = document.getElementById("settings-screen");
    this.moleScreen = document.getElementById("mole-screen");

    this.btnPlay = document.getElementById("btn-play");
    this.btnPause = document.getElementById("btn-pause");
    this.btnResume = document.getElementById("btn-resume");
    this.btnSettings = document.getElementById("btn-settings");
    this.btnCloseSettings = document.getElementById("btn-close-settings");
    this.btnRestart = document.getElementById("btn-restart");
    this.chkSound = document.getElementById("chk-sound");
    this.selControls = document.getElementById("sel-controls");

    this.btnMole = document.getElementById("btn-mole");
    this.btnCloseMole = document.getElementById("btn-close-mole");
    this.moleStarsEl = document.getElementById("mole-stars-value");
    this.statRowsEl = document.getElementById("stat-rows");
    this.colorSwatchesEl = document.getElementById("color-swatches");

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
    this.btnMole.addEventListener("click", () => this.callbacks.openMole?.());
    this.btnCloseMole.addEventListener("click", () => this.callbacks.closeMole?.());
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
  showMole() {
    this.moleScreen.classList.remove("hidden");
  }
  hideMole() {
    this.moleScreen.classList.add("hidden");
  }

  /** Rebuilds the stat rows + color swatches from the current profile state. Call whenever
   *  the panel opens and after every upgrade/color pick so pips/costs/selection stay accurate. */
  renderMoleScreen(profile) {
    this.moleStarsEl.textContent = profile.stars;

    this.statRowsEl.innerHTML = "";
    for (const key of Object.keys(STATS)) {
      const def = STATS[key];
      const level = profile.level(key);
      const maxed = level >= STAT_MAX_LEVEL;
      const cost = profile.costFor(key);
      const canAfford = profile.canUpgrade(key);

      const row = document.createElement("div");
      row.className = "stat-row";

      const pips = Array.from({ length: STAT_MAX_LEVEL }, (_, i) =>
        `<span class="stat-pip${i < level ? " filled" : ""}"></span>`
      ).join("");

      row.innerHTML = `
        <div class="stat-row-top">
          <span class="stat-name">${def.label}</span>
          <button class="stat-upgrade-btn" ${maxed || !canAfford ? "disabled" : ""}>
            ${maxed ? "Max" : `Upgrade (${cost}⭐)`}
          </button>
        </div>
        <div class="stat-pips">${pips}</div>
        <div class="stat-desc">${def.description}</div>
      `;

      const btn = row.querySelector(".stat-upgrade-btn");
      if (!maxed) {
        btn.addEventListener("click", () => this.callbacks.upgradeStat?.(key));
      }
      this.statRowsEl.appendChild(row);
    }

    this.colorSwatchesEl.innerHTML = "";
    for (const c of MOLE_COLORS) {
      const swatch = document.createElement("button");
      swatch.className = `color-swatch${c.id === profile.colorId ? " selected" : ""}`;
      swatch.style.background = c.body;
      swatch.setAttribute("aria-label", c.name);
      swatch.addEventListener("click", () => this.callbacks.pickColor?.(c.id));
      this.colorSwatchesEl.appendChild(swatch);
    }
  }

  setScore(score) {
    this.scoreEl.textContent = score;
  }

  setDepth(depth) {
    this.depthEl.textContent = Math.max(0, depth);
  }

  setEnergy(energy, maxEnergy = MAX_ENERGY) {
    const pct = Math.max(0, Math.min(100, (energy / maxEnergy) * 100));
    this.energyFillEl.style.width = `${pct}%`;

    const critical = pct <= ENERGY.CRITICAL_THRESHOLD;
    const low = pct <= ENERGY.LOW_THRESHOLD;

    let color;
    if (critical) color = "linear-gradient(90deg,#e53935,#ef5350)";
    else if (low) color = "linear-gradient(90deg,#f9a825,#fbc02d)";
    else color = "linear-gradient(90deg,#4caf50,#8bc34a)";
    this.energyFillEl.style.background = color;

    this.energyBoxEl.classList.toggle("low", low && !critical);
    this.energyBoxEl.classList.toggle("critical", critical);
    this.energyWarnEl.classList.toggle("hidden", !critical);
  }
}
