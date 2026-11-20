import type { EnemyState, ProjectileState, TowerState, ZoneState } from './types';
import type { TowerDef } from '../config/towers';

/** 组合技位标志 */
export const C_PENCIL_ERASER = 1;
export const C_GLUE_STAPLER = 2;
export const C_LAMP_PEN = 4;
export const C_RULER_COMPASS = 8;
export const C_CALC_PIGGY = 16;

/** 伤害标志 */
export const F_IGNORE_ARMOR = 1;
export const F_BEAM = 2;
export const F_DOT = 4;
export const F_AOE = 8;
export const F_SHIELD3 = 16;
export const F_SKILL = 32;
export const F_CRIT = 64;
export const F_TRUE = 128;

export interface Tower extends TowerState {
  def: TowerDef;
  cd: number;
  attacked: boolean;
  // 派生数值（dirty 时重算）
  dmg: number;
  dmgFactor: number;       // dmg / 基础伤害
  interval: number;
  range: number;
  inner: number;
  aura: number;
  critChance: number;
  critMul: number;
  atkMul: number;
  xpGainMul: number;
  calcCovers: Tower[];
  combo: number;
  slowPct: number;
  slowDur: number;
  stunChance: number;
  inkMax: number;
  // 运行时
  focusUid: number;
  focusStacks: number;
  laserUid: number;
  laserTime: number;
  laserAcc: number;
  laserBeamT: number;
  sweepPhase: number;
  colorGold: number;
  halfLegend: boolean;
  lastTape: number;
}

export interface Enemy extends EnemyState {
  dead: boolean;
  wave: number;
  effWave: number;
  bounty: number;
  xpVal: number;
  livesCost: number;
  baseSpeed: number;
  // 地面寻路
  ccx: number; ccy: number;
  tcx: number; tcy: number;
  pcx: number; pcy: number;
  remaining: number;
  // 飞行
  fx0: number; fy0: number; fx1: number; fy1: number;
  flyLen: number; flyT: number; flyPhase: number;
  // 计时
  jumpTimer: number;
  jumpEnd: number;
  abilityT: number;
  revealUntil: number;
  litUntil: number;
  redUntil: number;
  shred: number;
  stapleReady: number;
  burnDps: number; burnOwner: number;
  inkDps: number; inkUntil: number; inkOwner: number;
  bleedDps: number; bleedUntil: number; bleedOwner: number;
  debuffers: number[];
  dotT: number;
  unstoppable: boolean;
  dodge: number;
  aoeRadius: number;
  rallied: boolean;
  ringUntil: number;
  splitDone: boolean;
  cloudDone: boolean;
  cloudUntil: number;
  zoneVuln: number;
  permStealth: boolean;
  reflect: boolean;
  /** 同波橡皮屑生命（纸团分裂用） */
  crumbHp: number;
}

export interface Proj extends ProjectileState {
  tower: Tower | null;
  targetUid: number;
  tx: number; ty: number;
  speed: number;
  dmg: number;
  crit: boolean;
  vx: number; vy: number;
  travelled: number;
  maxDist: number;
  hits: number[];
  bounce: number;
  dead: boolean;
}

export interface Zone extends ZoneState {
  towerUid: number;
  slow: number;
  dps: number;
  vuln: number;
  reveal: boolean;
  air: boolean;
  tick: number;
  cos: number;
  sin: number;
  /** 包围圆（查询用） */
  cx: number; cy: number; br: number;
}
