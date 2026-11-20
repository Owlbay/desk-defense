import type { DifficultyId, DifficultyParams } from '../core/types';

/** 文档 04 §2.1 预设难度 */
export const PRESETS: Record<Exclude<DifficultyId, 'abyss'>, DifficultyParams> = {
  easy: {
    startGold: 200, lives: 30,
    hpMul: 0.8, hpLinear: 0.15, hpExp: 1.03,
    countMul: 0.9, countGrowth: 0.06,
    speedMul: 0.9, armorStep: 15,
    rewardMul: 1.2, xpMul: 1.2,
    eliteStart: 9999, eliteRate: 0, eliteCap: 0, maxAffix: 0,
    bossHpMul: 0.8, skillCdMul: 0.8, interestCap: 25, scoreMul: 0.5,
    spawnMode: 'roundRobin', maxActiveSpawners: 2, maxDrops: 1, dropWarn: 6,
    eventRate: 0.6, eventHostile: 0.3, waveGap: 20, waveMax: 75,
  },
  normal: {
    startGold: 150, lives: 20,
    hpMul: 1.0, hpLinear: 0.18, hpExp: 1.04,
    countMul: 1.0, countGrowth: 0.08,
    speedMul: 1.0, armorStep: 12,
    rewardMul: 1.0, xpMul: 1.0,
    eliteStart: 30, eliteRate: 0.004, eliteCap: 0.15, maxAffix: 1,
    bossHpMul: 1.0, skillCdMul: 1.0, interestCap: 20, scoreMul: 1.0,
    spawnMode: 'roundRobin', maxActiveSpawners: 3, maxDrops: 1, dropWarn: 5,
    eventRate: 1.0, eventHostile: 0.4, waveGap: 15, waveMax: 60,
  },
  hard: {
    startGold: 130, lives: 15,
    hpMul: 1.15, hpLinear: 0.19, hpExp: 1.043,
    countMul: 1.1, countGrowth: 0.09,
    speedMul: 1.05, armorStep: 10,
    rewardMul: 0.95, xpMul: 1.0,
    eliteStart: 20, eliteRate: 0.006, eliteCap: 0.25, maxAffix: 2,
    bossHpMul: 1.1, skillCdMul: 1.0, interestCap: 20, scoreMul: 1.5,
    spawnMode: 'random', maxActiveSpawners: 4, maxDrops: 2, dropWarn: 5,
    eventRate: 1.1, eventHostile: 0.55, waveGap: 12, waveMax: 50,
  },
  nightmare: {
    startGold: 120, lives: 10,
    hpMul: 1.3, hpLinear: 0.2, hpExp: 1.047,
    countMul: 1.15, countGrowth: 0.1,
    speedMul: 1.1, armorStep: 8,
    rewardMul: 0.95, xpMul: 0.9,
    eliteStart: 15, eliteRate: 0.008, eliteCap: 0.35, maxAffix: 2,
    bossHpMul: 1.15, skillCdMul: 1.1, interestCap: 15, scoreMul: 2.0,
    spawnMode: 'random', maxActiveSpawners: 4, maxDrops: 3, dropWarn: 4,
    eventRate: 1.2, eventHostile: 0.6, waveGap: 10, waveMax: 45,
  },
};

/** 魔境 I 的参数 */
export const ABYSS_BASE: DifficultyParams = {
  startGold: 120, lives: 10,
  hpMul: 1.4, hpLinear: 0.2, hpExp: 1.05,
  countMul: 1.2, countGrowth: 0.11,
  speedMul: 1.15, armorStep: 7,
  rewardMul: 0.95, xpMul: 0.85,
  eliteStart: 12, eliteRate: 0.01, eliteCap: 0.45, maxAffix: 3,
  bossHpMul: 1.2, skillCdMul: 1.2, interestCap: 15, scoreMul: 3.0,
  spawnMode: 'random', maxActiveSpawners: 5, maxDrops: 3, dropWarn: 3,
  eventRate: 1.25, eventHostile: 0.62, waveGap: 8, waveMax: 40,
};

/** 魔境每升 1 级的增量 */
export const ABYSS_PER_LEVEL: Partial<DifficultyParams> = {
  hpMul: 0.1, hpLinear: 0.01, hpExp: 0.001,
  countMul: 0.05, countGrowth: 0.005,
  speedMul: 0.01,
  rewardMul: -0.02, xpMul: -0.02,
  eliteStart: -0.5, eliteRate: 0.001, eliteCap: 0.03,
  bossHpMul: 0.1, skillCdMul: 0.02, scoreMul: 0.5,
  // 文档 09：间隔更短、事件更频繁（有上下限，见 abyssParams）
  waveGap: -0.3, waveMax: -1, dropWarn: -0.05, eventRate: 0.03, eventHostile: 0.01,
};

export const ABYSS_MAX_LEVEL = 10;

export const CAPS = { maxOnField: 150, maxPerWave: 200 };

/** 墨水结算的难度系数（文档 05 §3.1），供 meta 使用 */
export const INK_FACTOR: Record<DifficultyId, number> = {
  easy: 0.5, normal: 1, hard: 1.5, nightmare: 2, abyss: 3,
};

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** 魔境 N 级参数（含上下限） */
export function abyssParams(level: number): DifficultyParams {
  const L = Math.max(1, Math.min(ABYSS_MAX_LEVEL, Math.floor(level || 1)));
  const n = L - 1;
  const p: DifficultyParams = { ...ABYSS_BASE };
  const num = p as unknown as Record<string, number>;
  const base = ABYSS_BASE as unknown as Record<string, number>;
  for (const k of Object.keys(ABYSS_PER_LEVEL)) {
    num[k] = round4(base[k] + ((ABYSS_PER_LEVEL as Record<string, number>)[k]) * n);
  }
  p.lives = Math.max(5, ABYSS_BASE.lives - Math.floor(n / 2));
  p.armorStep = Math.max(4, ABYSS_BASE.armorStep - Math.floor(n / 3));
  p.speedMul = Math.min(1.3, p.speedMul);
  p.rewardMul = Math.max(0.6, p.rewardMul);
  p.xpMul = Math.max(0.6, p.xpMul);
  p.eliteStart = Math.max(3, p.eliteStart);
  p.eliteCap = Math.min(0.7, p.eliteCap);
  p.maxAffix = L >= 5 ? 4 : 3;
  p.waveGap = Math.max(6, p.waveGap);
  p.waveMax = Math.max(32, p.waveMax);
  p.dropWarn = Math.max(2.5, p.dropWarn);
  p.eventRate = Math.min(1.5, p.eventRate);
  p.eventHostile = Math.min(0.72, p.eventHostile);
  return p;
}
