// Single source of truth for "how hard is this to dig" and "how much energy do I get
// from eating this." Both tile generation and the mole's action logic read from here.

export const BLOCK_STATS = {
  DIRT_SOFT: { digDuration: 300, digEnergyCost: 2, digScore: 2 },
  DIRT_MEDIUM: { digDuration: 520, digEnergyCost: 4, digScore: 4 },
  DIRT_HARD: { digDuration: 820, digEnergyCost: 7, digScore: 8 },
  ROOT: { digDuration: 1300, digEnergyCost: 11, digScore: 14 },
  SURFACE: { digDuration: 260, digEnergyCost: 1.5, digScore: 1 }, // not diggable, kept for reference/legacy score parity
};

// kind: 'creature' (instant nibble) or 'produce' (slower nibble, root vegetables).
// slowFactor scales nibbleDuration relative to a worm's baseline bite.
export const FOOD_TYPES = {
  WORM: { kind: "creature", energy: 28, score: 15, nibbleDuration: 350, slowFactor: 1 },
  CARROT: { kind: "produce", energy: 14, score: 8, nibbleDuration: 700, slowFactor: 2 },
  BEET: { kind: "produce", energy: 18, score: 10, nibbleDuration: 900, slowFactor: 2.6 },
  TURNIP: { kind: "produce", energy: 16, score: 9, nibbleDuration: 800, slowFactor: 2.3 },
  CABBAGE: { kind: "produce", energy: 20, score: 11, nibbleDuration: 950, slowFactor: 2.8 },
  ANT: { kind: "creature", energy: 10, score: 12, nibbleDuration: 300, slowFactor: 0.9, damage: 9 },
  TERMITE: { kind: "creature", energy: 8, score: 10, nibbleDuration: 300, slowFactor: 0.9 },
  BEETLE: { kind: "creature", energy: 12, score: 14, nibbleDuration: 350, slowFactor: 1 },
};

export const FOOD_ID = {
  NONE: 0,
  WORM: 1,
  CARROT: 2,
  BEET: 3,
  TURNIP: 4,
  CABBAGE: 5,
};

export const FOOD_ID_TO_TYPE = {
  [FOOD_ID.WORM]: "WORM",
  [FOOD_ID.CARROT]: "CARROT",
  [FOOD_ID.BEET]: "BEET",
  [FOOD_ID.TURNIP]: "TURNIP",
  [FOOD_ID.CABBAGE]: "CABBAGE",
};

export const CREATURE_STATS = {
  WORM: { moveIntervalMs: 900, cap: 10 },
  ANT: { moveIntervalMs: 840, chaseIntervalMs: 520, cap: 6, detectRange: 6 },
  TERMITE: { moveIntervalMs: 520, cap: 5 },
  BEETLE: { moveIntervalMs: 650, cap: 5 },
};

export const ENERGY = {
  MAX: 100,
  WALK_COST: 0.5,
  CLIMB_COST: 1.2,
  LOW_THRESHOLD: 40, // bar turns yellow at/below this %
  CRITICAL_THRESHOLD: 18, // bar turns red + pulses at/below this %
  SLEEP_REGEN_PER_SEC: 9,
  WAKE_THRESHOLD: 35,
};
