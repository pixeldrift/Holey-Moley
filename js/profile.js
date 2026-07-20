// Persistent mole profile: stars (currency earned from play), stat levels, and cosmetic
// color choice. Survives restarts via localStorage so upgrades feel like progress, not
// just a per-run score.

const STORAGE_KEY = "holemole:profile:v1";

export const STAT_MAX_LEVEL = 5;

export const STATS = {
  speed: { label: "Speed", description: "Faster walking, climbing, and digging." },
  strength: { label: "Strength", description: "Digging costs less energy." },
  stamina: { label: "Stamina", description: "More max energy, faster sleep recovery." },
};

export const MOLE_COLORS = [
  { id: "brown", name: "Brown", body: "#8b6f47", belly: "#e6cfa0" },
  { id: "gray", name: "Gray", body: "#787878", belly: "#d9d9d9" },
  { id: "black", name: "Charcoal", body: "#3a3128", belly: "#a89a80" },
  { id: "ginger", name: "Ginger", body: "#b5651d", belly: "#f2c78b" },
  { id: "snowy", name: "Snowy", body: "#e8e2d5", belly: "#fffdf8" },
  { id: "rose", name: "Rose", body: "#c98a9a", belly: "#f7dde3" },
];

function upgradeCost(currentLevel) {
  return (currentLevel + 1) * 50;
}

function defaultData() {
  return { stars: 0, speed: 0, strength: 0, stamina: 0, color: "brown" };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaultData(), ...JSON.parse(raw) };
  } catch (e) {
    // localStorage unavailable (private mode, etc) - fall back to an in-memory default.
  }
  return defaultData();
}

export class Profile {
  constructor() {
    this.data = load();
  }

  get stars() {
    return this.data.stars;
  }

  level(stat) {
    return this.data[stat];
  }

  costFor(stat) {
    return upgradeCost(this.data[stat]);
  }

  canUpgrade(stat) {
    return this.data[stat] < STAT_MAX_LEVEL && this.data.stars >= this.costFor(stat);
  }

  upgrade(stat) {
    if (!this.canUpgrade(stat)) return false;
    this.data.stars -= this.costFor(stat);
    this.data[stat] += 1;
    this._save();
    return true;
  }

  earnStars(amount) {
    if (amount <= 0) return;
    this.data.stars += amount;
    this._save();
  }

  get colorId() {
    return this.data.color;
  }

  setColor(colorId) {
    if (!MOLE_COLORS.some((c) => c.id === colorId)) return;
    this.data.color = colorId;
    this._save();
  }

  get colorSet() {
    return MOLE_COLORS.find((c) => c.id === this.data.color) || MOLE_COLORS[0];
  }

  /** Gameplay multipliers/bonuses derived from current stat levels. */
  effects() {
    return {
      speedFactor: 1 - 0.05 * this.data.speed,
      strengthFactor: 1 - 0.05 * this.data.strength,
      maxEnergyBonus: 10 * this.data.stamina,
      staminaRegenFactor: 1 + 0.1 * this.data.stamina,
    };
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (e) {
      // Ignore write failures (quota, private mode) - profile just won't persist.
    }
  }
}
