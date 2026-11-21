/**
 * 中心策略（Doctrine，文档 10 §20）：整局「以什么为主」的一组参数——核心塔、迷宫长度与选位、传奇分支、增益偏好。
 *
 *  - 只在 agent 一侧（规划器 / 兜底 / 提示），不碰 core：回放与确定性不受影响；
 *  - 加权、不排他：核心塔在买塔 / 升级评分里加权，紧急补铅笔、防空、破甲等保底照常；
 *  - 开局可由玩家选定（可锁定），也可让模型在第一次决策里用 act 的 end.doctrine 选；中途可改（模型有冷却，玩家随时可改）；
 *  - 每次决策给模型一行 DOC（固定英文代码，不随界面语言变）。
 */
import type { Branch, TowerId } from '../core/types';

/** 预设（离线评测后去掉了 ruler：6 局平均 47～49 波，均衡 60；尺子仍可放进自定义 core） */
export const DOCTRINE_PRESETS = ['balanced', 'pencil', 'aoe', 'lamp', 'economy', 'antiair'] as const;
export type DoctrinePreset = (typeof DOCTRINE_PRESETS)[number];
export type MazeLength = 'long' | 'standard' | 'lean';
export type MazeFocus = 'route' | 'uturn';

export interface Doctrine {
  preset: DoctrinePreset | 'custom';
  /** 核心塔（排序）：买塔 / 升级评分加权 ×1.3 / ×1.15 / ×1.05 */
  core: TowerId[];
  /** 迷宫长度目标（路线 / 直线）：long 3.5× / standard 2.5× / lean 2.0× */
  maze: MazeLength;
  /** uturn：核心塔优先放在能打到多层走廊的位置（U 形转弯） */
  focus: MazeFocus;
  /** 传奇分支（缺省按规划器的默认） */
  branches: Partial<Record<TowerId, Branch>>;
  /** 增益偏好（自动选增益时优先） */
  perks: string[];
  /** 玩家原话（自定义），≤120 字 */
  notes?: string;
}

export type DoctrineBy = 'player' | 'model' | 'auto';

export interface DoctrineChange {
  wave: number;
  from: string;
  to: string;
  by: DoctrineBy;
  why?: string;
}

/** 跨决策的策略状态（引擎的 PlannerState.doctrine） */
export interface DoctrineState {
  doc: Doctrine;
  /** 已确定（玩家选的，或模型已选）；false = 等模型在第一次决策里选（期间按 balanced 打） */
  chosen: boolean;
  by: DoctrineBy;
  /** 上次修改在第几波 */
  wave: number;
  /** 玩家锁定：模型不能改，只能建议 */
  locked: boolean;
  why?: string;
  log: DoctrineChange[];
  /** 模型在锁定时的建议（界面显示「采纳」） */
  suggested?: DoctrinePreset;
}

/** 模型修改的冷却（波） */
export const DOCTRINE_COOLDOWN = 5;

/** 默认买塔轮换（与高手机器人同序；balanced） */
export const BALANCED_ROTATION: TowerId[] = [
  'pencil',
  'pencil',
  'pencil',
  'pencil',
  'eraser',
  'pencil',
  'pencil',
  'lamp',
  'pencil',
  'pencil',
  'glue',
  'pencil',
  'lamp',
  'pencil',
  'eraser',
  'pencil',
  'calculator',
  'pencil',
  'compass',
  'pencil',
  'piggy',
  'lamp',
  'pencil',
  'stapler',
  'pencil',
  'calculator',
  'piggy',
];

const P = 'pencil' as const;
/** 各预设的买塔轮换：开局一律 4 支铅笔（§19.7：开局买贵塔会失守），之后按核心塔穿插；破甲（橡皮擦 / 台灯）都保留 */
const ROTATIONS: Record<DoctrinePreset, TowerId[]> = {
  balanced: BALANCED_ROTATION,
  pencil: [
    P,
    P,
    P,
    P,
    'eraser',
    P,
    P,
    P,
    'lamp',
    P,
    P,
    'eraser',
    P,
    'calculator',
    P,
    P,
    'lamp',
    P,
    'piggy',
    P,
    'lamp',
    P,
    'calculator',
    P,
    'piggy',
    'lamp',
    'lamp',
  ],
  aoe: [
    P,
    P,
    P,
    P,
    'eraser',
    P,
    'stapler',
    P,
    'glue',
    'stapler',
    P,
    'lamp',
    'compass',
    P,
    'stapler',
    'eraser',
    'compass',
    'calculator',
    P,
    'glue',
    'compass',
    'piggy',
    'lamp',
    'stapler',
    'compass',
    'calculator',
    'piggy',
  ],
  lamp: [
    P,
    P,
    P,
    P,
    'eraser',
    P,
    P,
    'lamp',
    P,
    'glue',
    'lamp',
    P,
    'lamp',
    'eraser',
    P,
    'calculator',
    'lamp',
    P,
    'compass',
    'piggy',
    'lamp',
    'lamp',
    'calculator',
    'piggy',
  ],
  economy: [
    P,
    P,
    P,
    P,
    'eraser',
    P,
    P,
    'piggy',
    P,
    'lamp',
    'piggy',
    P,
    'calculator',
    P,
    'piggy',
    'lamp',
    P,
    'glue',
    'calculator',
    'compass',
    P,
    'lamp',
    'stapler',
    'calculator',
  ],
  antiair: [
    P,
    P,
    P,
    P,
    'swatter',
    P,
    'eraser',
    P,
    'swatter',
    'lamp',
    P,
    'glue',
    'swatter',
    'lamp',
    P,
    'calculator',
    'compass',
    'swatter',
    'piggy',
    'lamp',
    'calculator',
    'piggy',
  ],
};

export const DOCTRINE_TABLE: Record<DoctrinePreset, Omit<Doctrine, 'preset'>> = {
  balanced: { core: [], maze: 'standard', focus: 'route', branches: {}, perks: [] },
  pencil: {
    core: ['pencil', 'eraser', 'calculator'],
    maze: 'long',
    focus: 'route',
    branches: { pencil: 'A' },
    perks: ['sharpener', 'legend'],
  },
  aoe: {
    core: ['stapler', 'compass', 'glue'],
    maze: 'long',
    focus: 'uturn',
    branches: { stapler: 'A', compass: 'A' },
    perks: ['staples', 'drafting', 'quickglue', 'thickcover'],
  },
  lamp: { core: ['lamp', 'glue', 'eraser'], maze: 'long', focus: 'route', branches: { lamp: 'A' }, perks: ['bulb', 'thickcover'] },
  economy: {
    core: ['piggy', 'calculator', 'pencil'],
    maze: 'lean',
    focus: 'route',
    branches: { calculator: 'A', piggy: 'A' },
    perks: ['compound', 'sale', 'promotion'],
  },
  antiair: { core: ['swatter', 'pencil', 'lamp'], maze: 'standard', focus: 'route', branches: { swatter: 'A' }, perks: [] },
};

export function presetDoctrine(p: DoctrinePreset): Doctrine {
  const d = DOCTRINE_TABLE[p];
  return { preset: p, core: d.core.slice(), maze: d.maze, focus: d.focus, branches: { ...d.branches }, perks: d.perks.slice() };
}

/** 初始状态：preset 缺省 = 等模型选（期间按 balanced 打） */
export function initialDoctrine(o: { preset?: DoctrinePreset | 'auto'; locked?: boolean; notes?: string } = {}): DoctrineState {
  const chosen = !!o.preset && o.preset !== 'auto';
  const doc = presetDoctrine(chosen ? (o.preset as DoctrinePreset) : 'balanced');
  if (o.notes) doc.notes = o.notes.slice(0, 120);
  return { doc, chosen, by: chosen ? 'player' : 'auto', wave: 0, locked: chosen && !!o.locked, log: [] };
}

export const isPreset = (x: unknown): x is DoctrinePreset => typeof x === 'string' && (DOCTRINE_PRESETS as readonly string[]).includes(x);

/** 核心塔 → 最接近的预设（自定义核心时取轮换） */
const CORE_PRESET: Partial<Record<TowerId, DoctrinePreset>> = {
  pencil: 'pencil',
  eraser: 'pencil',
  stapler: 'aoe',
  compass: 'aoe',
  glue: 'aoe',
  lamp: 'lamp',
  pen: 'lamp',
  ruler: 'lamp',
  piggy: 'economy',
  calculator: 'economy',
  swatter: 'antiair',
};

export function rotationFor(doc: Doctrine | undefined): TowerId[] {
  if (!doc) return BALANCED_ROTATION;
  if (doc.preset !== 'custom') return ROTATIONS[doc.preset];
  const p = doc.core.length ? CORE_PRESET[doc.core[0]] : undefined;
  return ROTATIONS[p ?? 'balanced'];
}

/** 核心塔权重（不排他，有上限） */
export function coreWeight(doc: Doctrine | undefined, id: TowerId): number {
  const k = doc ? doc.core.indexOf(id) : -1;
  return k === 0 ? 1.3 : k === 1 ? 1.15 : k === 2 ? 1.05 : 1;
}

export const MAZE_TARGET: Record<MazeLength, number> = { long: 3.5, standard: 2.5, lean: 2.0 };
export const MAZE_WALL_SHARE: Record<MazeLength, number> = { long: 0.7, standard: 0.5, lean: 0.35 };

/** 发给模型的一行（固定英文代码；约 30～50 token） */
export function doctrineLine(st: DoctrineState | undefined, wave: number): string | undefined {
  if (!st) return undefined;
  if (!st.chosen)
    return 'DOC none — pick one in end.doctrine {preset,why}: balanced | pencil (single-target, long maze; armor needs lamps/erasers) | aoe (stapler/compass/glue at U-turns of a long maze; add anti-air) | lamp (ignores armor; bosses/late) | economy (piggy/calculator; normal only) | antiair (flyers/drops); or core:[≤3 towers], maze long|standard|lean, focus uturn. Playing balanced meanwhile';
  const d = st.doc;
  const tags = [st.by, `w${st.wave}`];
  if (st.locked) tags.push('locked');
  else if (st.by === 'model' && wave - st.wave < DOCTRINE_COOLDOWN) tags.push(`change≥w${st.wave + DOCTRINE_COOLDOWN}`);
  const parts = [`DOC ${d.preset}(${tags.join(',')})`];
  if (d.core.length) parts.push(`core ${d.core.join('>')}`);
  parts.push(`maze ${d.maze} ${MAZE_TARGET[d.maze]}x${d.focus === 'uturn' ? ' uturn' : ''}`);
  const br = Object.entries(d.branches).map(([k, v]) => `${k} ${v}`);
  if (br.length) parts.push(`br ${br.join(' ')}`);
  if (d.perks.length) parts.push(`perks ${d.perks.join(',')}`);
  if (d.notes) parts.push(`player: ${d.notes}`);
  return parts.join(' | ');
}

const TOWER_SET = new Set<TowerId>([
  'pencil',
  'stapler',
  'glue',
  'lamp',
  'compass',
  'eraser',
  'ruler',
  'pen',
  'calculator',
  'piggy',
  'swatter',
]);

/** 模型 / 玩家提出的修改（act 的 end.doctrine） */
export interface DoctrineInput {
  preset?: string;
  core?: unknown;
  maze?: string;
  focus?: string;
  why?: string;
  /** 玩家原话（只有玩家能写） */
  notes?: string;
}

/**
 * 应用一次修改（就地改 st）；返回结果行。
 * 模型：必须写 why；玩家锁定时只记建议；冷却 5 波（最近掉过命例外——打不过就该换）。玩家：不受限制。
 */
export function applyDoctrine(
  st: DoctrineState,
  input: DoctrineInput,
  by: DoctrineBy,
  ctx: { wave: number; hurt?: boolean },
): { ok: boolean; text: string } {
  const preset = input.preset === undefined ? undefined : String(input.preset);
  if (preset !== undefined && preset !== 'custom' && !isPreset(preset))
    return { ok: false, text: `doctrine: unknown preset "${preset}" (${DOCTRINE_PRESETS.join('|')})` };
  const why = typeof input.why === 'string' ? input.why.trim().slice(0, 160) : '';
  // 只写了 why（例如「保持」）：不算修改，不触发冷却
  if (
    preset === undefined &&
    input.core === undefined &&
    input.maze === undefined &&
    input.focus === undefined &&
    input.notes === undefined
  )
    return { ok: false, text: `doctrine: unchanged (${st.chosen ? st.doc.preset : 'none'})` };
  if (by === 'model') {
    if (!why) return { ok: false, text: 'doctrine: rejected — give a why' };
    if (st.locked) {
      if (preset && isPreset(preset) && preset !== st.doc.preset) st.suggested = preset;
      return { ok: false, text: `doctrine: locked by the player (${st.doc.preset}) — suggestion noted, keep following it` };
    }
    if (st.chosen && st.by !== 'auto' && ctx.wave - st.wave < DOCTRINE_COOLDOWN && !ctx.hurt)
      return { ok: false, text: `doctrine: cooldown — next change from w${st.wave + DOCTRINE_COOLDOWN} (or after losing lives)` };
  }
  const from = st.chosen ? st.doc.preset : 'none';
  const next: Doctrine =
    preset && preset !== 'custom' ? presetDoctrine(preset) : { ...st.doc, branches: { ...st.doc.branches }, perks: st.doc.perks.slice() };
  if (preset === 'custom') next.preset = 'custom';
  if (Array.isArray(input.core)) {
    const core = [...new Set(input.core.filter((x): x is TowerId => typeof x === 'string' && TOWER_SET.has(x as TowerId)))].slice(0, 3);
    if (core.length) {
      next.core = core;
      if (!preset) next.preset = 'custom';
    }
  }
  if (input.maze === 'long' || input.maze === 'standard' || input.maze === 'lean') next.maze = input.maze;
  if (input.focus === 'route' || input.focus === 'uturn') next.focus = input.focus;
  if (by === 'player' && typeof input.notes === 'string') {
    const n = input.notes.trim().slice(0, 120);
    if (n) next.notes = n;
    else delete next.notes;
  } else if (st.doc.notes) next.notes = st.doc.notes;
  st.doc = next;
  st.chosen = true;
  st.by = by;
  st.wave = ctx.wave;
  st.why = why || undefined;
  if (by === 'player') st.suggested = undefined;
  st.log.push({ wave: ctx.wave, from, to: next.preset, by, ...(why ? { why } : {}) });
  if (st.log.length > 40) st.log.splice(0, st.log.length - 40);
  return {
    ok: true,
    text: `doctrine: ${from} → ${next.preset}${next.core.length ? ` core ${next.core.join('>')}` : ''} maze ${next.maze}`,
  };
}

/** 玩家原话 → 预设（「主打范围」「铅笔流」「多绕几圈」…）；认不出返回 null */
export function parseDoctrine(text: string): { preset?: DoctrinePreset; maze?: MazeLength; focus?: MazeFocus } | null {
  const s = text.toLowerCase();
  const has = (...k: string[]) => k.some((x) => s.includes(x));
  let preset: DoctrinePreset | undefined;
  if (has('铅笔', '鉛筆', 'pencil', 'えんぴつ')) preset = 'pencil';
  else if (has('范围', '範圍', '群伤', '群傷', 'aoe', '订书机', '訂書機', '圆规', '圓規', '範囲')) preset = 'aoe';
  else if (has('台灯', '檯燈', '光束', '激光', 'lamp', 'ランプ')) preset = 'lamp';
  else if (has('经济', '經濟', '存钱罐', '存錢筒', '复利', '複利', 'economy', '経済')) preset = 'economy';
  else if (has('防空', '对空', '對空', 'anti-air', 'antiair', '対空')) preset = 'antiair';
  else if (has('均衡', '平衡', 'balanced', 'バランス')) preset = 'balanced';
  else if (has('单点', '單點', '单体', '單體', 'single')) preset = 'pencil';
  let maze: MazeLength | undefined;
  let focus: MazeFocus | undefined;
  if (has('弯弯绕', '彎彎繞', '绕远', '繞遠', '多绕', '多繞', '长迷宫', '長迷宮', '绕路', '繞路', 'long maze', 'winding')) {
    maze = 'long';
    focus = 'uturn';
  } else if (has('多层', '多層', 'u形', 'u 形', 'uturn', 'u-turn')) focus = 'uturn';
  else if (has('少建墙', '少建牆', '短迷宫', '短迷宮', 'lean')) maze = 'lean';
  if (!preset && !maze && !focus) return null;
  return { ...(preset ? { preset } : {}), ...(maze ? { maze } : {}), ...(focus ? { focus } : {}) };
}
