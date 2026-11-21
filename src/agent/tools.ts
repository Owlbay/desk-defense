/**
 * Agent 工具（文档 10 §6）：定义（严格 JSON Schema）+ 校验 + 执行器。
 *
 * - 动作类工具与 core 的 Command 一一对应，最终都走 IWorld.command()（与玩家点击同一套校验）。
 * - 读取类工具（get_state / get_catalog / get_tower / preview_placement）不改变世界。
 * - 控制类工具：end_turn（结束本次决策）；军师专用 suggest（只记录建议）。
 * - 坐标统一用"格"：x = 列 0..11，y = 行 0..13；圆形技能以格中心为圆心。
 *
 * 本文件不依赖任何 LLM SDK：Claude 适配器、MCP 服务、脚本策略都复用这里的定义与执行器。
 */
import { SOURCE_LOCALE, withLocale } from '../i18n';
import {
  TOWER_IDS, type Branch, type Command, type IWorld, type SkillId, type TargetMode, type TowerId,
} from '../core/types';
import { SKILL_IDS } from '../config/skills';
import { asciiMap, renderObservation } from './observation';
import { catalogEntry, catalogText, type CatalogSection } from './prompts';
import { compactObservation, terrainMap, type CompactObs } from './compact';
import { coverageLines, groundRoutes, fmtWp, previewChanges, previewText, routeSummary } from './routes';
import { COMBO_PAIRS, Planner, type IntentOutcome, type PlannerState } from './planner';
import { PURPOSES, type Purpose } from './purpose';
import type { AgentRole, CommandSink, ToolResult } from './types';

// ───────────────────────── Schema ─────────────────────────

export type JsonSchema =
  | { type: 'object'; properties: Record<string, JsonSchema>; required: string[]; additionalProperties: false; description?: string }
  | { type: 'string'; enum?: string[]; description?: string }
  | { type: 'integer'; description?: string }
  | { type: 'number'; description?: string }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; items: JsonSchema; description?: string };

export type ObjectSchema = Extract<JsonSchema, { type: 'object' }>;

export type ToolKind = 'read' | 'action' | 'control';

export interface AgentToolDef {
  name: string;
  description: string;
  input_schema: ObjectSchema;
  kind: ToolKind;
  roles: AgentRole[];
}

const TARGET_MODES: TargetMode[] = ['first', 'last', 'strong', 'weak', 'close', 'air'];
const CATALOG_SECTIONS: CatalogSection[] = ['all', 'towers', 'enemies', 'skills', 'perks', 'abilities', 'events'];

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): ObjectSchema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const int = (description: string): JsonSchema => ({ type: 'integer', description });
const num = (description: string): JsonSchema => ({ type: 'number', description });
const str = (description: string, e?: readonly string[]): JsonSchema => (e ? { type: 'string', enum: [...e], description } : { type: 'string', description });

const X = int('cell column 0..11');
const Y = int('cell row 0..13');
const UID = int('tower uid (the number after # in the towers list)');
const BRANCH = str('legend branch at Lv9→10', ['A', 'B']);

const P: AgentRole[] = ['player'];
const ALL: AgentRole[] = ['player', 'advisor', 'attacker'];

/**
 * 旧的细粒度工具（19 个）。不再发给模型（太占前缀），但：MCP 仍开放（兼容旧客户端）、军师建议字符串按它们解析、
 * 模型若仍调用旧名字，执行器照常执行。顺序固定。
 */
export const LEGACY_TOOLS: AgentToolDef[] = [
  // ── 读取 ──
  {
    name: 'get_state', kind: 'read', roles: ALL,
    description: 'Re-read the current game state. Call this after several actions if you need fresh numbers, or with detail="full" to get per-tower upgrade/sell prices, path cell lists and the 12 enemies closest to the exit. The decision message already contains a compact state, so you rarely need this.',
    input_schema: obj({ detail: str('compact (default) or full', ['compact', 'full']) }),
  },
  {
    name: 'get_catalog', kind: 'read', roles: ALL,
    description: 'Static reference data: tower stats/costs/branches, enemies, affixes, skills, perks, mythic abilities, random events. It is identical for every game; call only when the system prompt summary is not enough.',
    input_schema: obj({ section: str('which section (default all)', CATALOG_SECTIONS) }),
  },
  {
    name: 'get_tower', kind: 'read', roles: ALL,
    description: 'Detailed info for one tower: stats, next upgrade cost, branch options at Lv9, evolve cost, sell value, ability cooldown, target modes.',
    input_schema: obj({ uid: UID }, ['uid']),
  },
  {
    name: 'preview_placement', kind: 'read', roles: ALL,
    description: 'Check whether a tower can be placed at (x,y) and how the enemy path length would change. Use before place_tower when building a maze, to avoid blocking errors.',
    input_schema: obj({ tower: str('tower id', TOWER_IDS), x: X, y: Y }, ['tower', 'x', 'y']),
  },
  // ── 动作（1:1 Command） ──
  {
    name: 'place_tower', kind: 'action', roles: P,
    description: 'Build a tower on an empty cell (costs gold). Towers are also walls: placement may not fully block any entrance→exit path. Walls ("wall") are cheap maze blocks.',
    input_schema: obj({ tower: str('tower id', TOWER_IDS), x: X, y: Y }, ['tower', 'x', 'y']),
  },
  {
    name: 'upgrade_tower', kind: 'action', roles: P,
    description: 'Upgrade a tower by one level with gold (XP discount applies). Lv9→10 needs a branch: use choose_branch instead. Walls upgrade Lv1→3.',
    input_schema: obj({ uid: UID }, ['uid']),
  },
  {
    name: 'choose_branch', kind: 'action', roles: P,
    description: 'Upgrade a Lv9 tower to Lv10 (legend) choosing branch A or B (see get_tower for branch effects).',
    input_schema: obj({ uid: UID, branch: BRANCH }, ['uid', 'branch']),
  },
  {
    name: 'evolve_tower', kind: 'action', roles: P,
    description: 'Spend gold to add one evolution star (★1..★3) to a Lv10 tower. ★3 unlocks a mythic active ability (tower_ability).',
    input_schema: obj({ uid: UID }, ['uid']),
  },
  {
    name: 'sell_tower', kind: 'action', roles: P,
    description: 'Sell a tower (full refund within 5 s of placing if it has not attacked, otherwise the refund rate). Changes the path.',
    input_schema: obj({ uid: UID }, ['uid']),
  },
  {
    name: 'set_target_mode', kind: 'action', roles: P,
    description: 'Set an attacking tower\'s targeting priority.',
    input_schema: obj({ uid: UID, mode: str('first|last|strong|weak|close|air', TARGET_MODES) }, ['uid', 'mode']),
  },
  {
    name: 'cast_skill', kind: 'action', roles: P,
    description: 'Cast a carried active skill (must be READY). Targets by skill: eraser_strike/magnifier: x,y = center cell; whiteout_zone: x,y = top-left cell of the 2×2 area; ruler_sweep: axis + index (row y or column x); inspiration: uid; relocate: uid + destination x,y; seal_tape: spawner id; bell/caffeine/scholarship: no target.',
    input_schema: obj({
      skill: str('skill id', SKILL_IDS), x: X, y: Y, uid: UID,
      axis: str('ruler_sweep line direction', ['row', 'col']), index: int('ruler_sweep row/column index'),
      spawner: str('seal_tape: drop spawner id, e.g. drop-3'),
    }, ['skill']),
  },
  {
    name: 'tower_ability', kind: 'action', roles: P,
    description: 'Use the mythic (★3) active ability of a tower. Target depends on ability (see get_tower): none; circle/rect3: x,y cell; direction: x,y cell to aim at (or angle in radians); axis: axis+index; enemy/tower: target_uid.',
    input_schema: obj({
      uid: UID, x: X, y: Y, angle: num('radians, 0 = +x, y grows downward'),
      axis: str('row or col', ['row', 'col']), index: int('row/column index'), target_uid: int('enemy or tower uid'),
    }, ['uid']),
  },
  {
    name: 'choose_perk', kind: 'action', roles: P,
    description: 'Pick one of the offered perk cards (game is paused until you pick). Perks that "need uid+branch" also require a Lv7+ tower uid and a branch.',
    input_schema: obj({ id: str('perk id from the offer'), uid: UID, branch: BRANCH }, ['id']),
  },
  {
    name: 'reroll_perks', kind: 'action', roles: P,
    description: 'Pay the reroll cost to redraw the perk offer.',
    input_schema: obj({}),
  },
  {
    name: 'collect_pickup', kind: 'action', roles: P,
    description: 'Collect a coin or supply crate lying on the board (they expire). Omit uid to collect everything.',
    input_schema: obj({ uid: int('pickup uid; omit for all') }),
  },
  {
    name: 'choose_crate', kind: 'action', roles: P,
    description: 'Choose one option from an opened supply crate.',
    input_schema: obj({ option: str('crate option id', ['gold', 'lives', 'cooldown', 'xp', 'caffeine', 'charge']) }, ['option']),
  },
  {
    name: 'demolish_spawner', kind: 'action', roles: P,
    description: 'Pay gold to demolish an active air-drop spawner (box) so no more enemies come from it.',
    input_schema: obj({ id: str('drop spawner id, e.g. drop-3') }, ['id']),
  },
  {
    name: 'start_wave', kind: 'action', roles: P,
    description: 'Start the next wave now. In build phase this starts the wave; during a wave it calls the next wave early for bonus gold (riskier).',
    input_schema: obj({}),
  },
  // ── 控制 ──
  {
    name: 'end_turn', kind: 'control', roles: ALL,
    description: 'Finish this decision and let the game run until the next decision point. Always call it when done. The optional note (≤200 chars) is shown back to you next time — use it for your plan.',
    input_schema: obj({ note: str('short memo for your future self') }),
  },
  {
    name: 'suggest', kind: 'control', roles: ['advisor'],
    description: 'Advisor only: give the human player a short suggestion (Chinese preferred) plus optional concrete actions written as tool calls, e.g. "place_tower pencil 3,5".',
    input_schema: obj({ text: str('suggestion ≤120 chars'), actions: { type: 'array', items: str('one concrete action'), description: 'up to 4 actions' } }, ['text']),
  },
];

/** 兼容旧名字：AGENT_TOOLS = 细粒度旧工具 */
export const AGENT_TOOLS = LEGACY_TOOLS;

/** act 里的动作类型 → 旧工具名 */
export const ACT_TO_LEGACY: Record<string, string> = {
  place: 'place_tower', upgrade: 'upgrade_tower', branch: 'choose_branch', evolve: 'evolve_tower', sell: 'sell_tower',
  target: 'set_target_mode', cast_skill: 'cast_skill', tower_ability: 'tower_ability', collect: 'collect_pickup',
  choose_perk: 'choose_perk', reroll_perks: 'reroll_perks', choose_crate: 'choose_crate', demolish: 'demolish_spawner',
  start_wave: 'start_wave',
};
export const ACT_KINDS_V1 = [...Object.keys(ACT_TO_LEGACY), 'end_turn'];
/** 高层意图（由 planner.ts 挑具体格子 / 目标执行） */
export const INTENT_KINDS = ['maze', 'build_near', 'upgrade_best', 'anti_air', 'spend', 'save', 'combo', 'support', 'economy', 'reclaim', 'rebuild_maze'] as const;
export const ACT_KINDS = [...INTENT_KINDS, ...ACT_KINDS_V1];

/** 每种动作用到的字段（其余字段忽略） */
const ACT_FIELDS: Record<string, string[]> = {
  place: ['tower', 'x', 'y'], upgrade: ['uid'], branch: ['uid', 'branch'], evolve: ['uid'], sell: ['uid'],
  target: ['uid', 'mode'], cast_skill: ['skill', 'x', 'y', 'uid', 'axis', 'index', 'spawner'],
  tower_ability: ['uid', 'x', 'y', 'angle', 'axis', 'index', 'target_uid'], collect: ['uid'],
  choose_perk: ['id', 'uid', 'branch'], reroll_perks: [], choose_crate: ['option'], demolish: ['id'], start_wave: [],
};

const MEMO: ObjectSchema = obj({
  plan: str('overall plan (≤60 words)'), maze: str('maze intent'), priorities: str('next priorities'), note: str('anything else'),
});

const ACTION_FIELDS: Record<string, JsonSchema> = {
  tower: str('place / build_near: tower id', TOWER_IDS), x: X, y: Y, uid: UID,
  branch: BRANCH, mode: str('target mode', TARGET_MODES), skill: str('cast_skill id', SKILL_IDS),
  axis: str('row|col', ['row', 'col']), index: int('row/col index'), angle: num('radians'), target_uid: int('ability target uid'),
  id: str('choose_perk id / demolish spawner id'), option: str('choose_crate option', ['gold', 'lives', 'cooldown', 'xp', 'caffeine', 'charge']),
  spawner: str('seal_tape spawner id'), note: str('end_turn memo'),
};

/** 旧版 act 动作（assist 关闭时发给模型；评测基线） */
const ACTION_V1: ObjectSchema = obj({ do: str('action', ACT_KINDS_V1), ...ACTION_FIELDS }, ['do']);

const ACTION: ObjectSchema = obj({
  do: str('action', ACT_KINDS),
  ...ACTION_FIELDS,
  style: str('maze style', ['serpentine', 'funnel']), budget: int('maze / upgrade_best: max gold'),
  target: str('build_near: route|route:<spawner>|early|exit|air|airline:<spawner>|chokepoint|seg:x1,y1-x2,y2; reclaim: useless_walls|idle_towers|cells'), count: int('how many (build_near / upgrade_best / anti_air / economy)'),
  purpose: str('build_near instead of tower', PURPOSES), pair: str('combo', COMBO_PAIRS),
  near: str('combo: like target'), replaceWith: str('reclaim: tower or purpose for freed cells'), max: int('reclaim max'), dry: { type: 'boolean', description: 'reclaim: list only' },
  metric: str('upgrade_best metric', ['dps', 'coverage']), route: str('spawner id (maze funnel / anti_air line)'),
  reserve: int('spend: keep this much gold'), focus: str('spend focus', ['balanced', 'towers', 'upgrades', 'maze']), until: int('save: target gold'),
}, ['do']);

/**
 * 精简工具（发给模型的，≤ 6 个）：act（批量动作）、observe、preview、get_catalog、get_tower、suggest（军师）。
 * 描述短、Schema 用枚举收紧；顺序固定（缓存前缀逐字节稳定）。
 */
export const SLIM_TOOLS: AgentToolDef[] = [
  {
    name: 'act', kind: 'action', roles: P,
    description: 'Run actions in order (each validated, per-action results); ONE call per decision incl. end. Intents (planner picks cells): maze | build_near tower|purpose | upgrade_best | anti_air | spend | save | combo pair | support | economy | reclaim target | rebuild_maze. Low-level: place tower,x,y (auto-moved if blocked) | upgrade/evolve/sell uid | branch uid,branch | target uid,mode | cast_skill skill (+x,y/uid/axis,index/spawner) | tower_ability uid (+args) | collect | choose_perk id | choose_crate option | demolish id | start_wave.',
    input_schema: obj({
      actions: { type: 'array', items: ACTION, description: 'ordered actions (max 16)' },
      end: { ...MEMO, description: 'finish the turn; fields update your MEMO' },
    }, ['actions']),
  },
  {
    name: 'observe', kind: 'read', roles: ALL,
    description: 'Full current state (not a delta) + map. detail=full adds per-tower coverage, prices, path cells, nearest enemies. Rarely needed.',
    input_schema: obj({ detail: str('compact (default) | full', ['compact', 'full']) }),
  },
  {
    name: 'preview', kind: 'read', roles: ALL,
    description: 'Simulate placements/removals without changing the game: validity, new route waypoints and length change per spawner, tower coverage gained/lost, anti-air change. No args = current routes.',
    input_schema: obj({
      place: { type: 'array', items: obj({ tower: str('tower id', TOWER_IDS), x: X, y: Y }, ['tower', 'x', 'y']), description: 'hypothetical placements, in order' },
      remove: { type: 'array', items: int('tower uid to sell'), description: 'hypothetical sells' },
    }),
  },
  {
    name: 'get_catalog', kind: 'read', roles: ALL,
    description: 'Static reference beyond the cheat sheet: a section, or one entry by id (tower / enemy / skill / ability / perk / event).',
    input_schema: obj({ section: str('section', CATALOG_SECTIONS), id: str('entry id, e.g. lamp or boss_alarm') }),
  },
  {
    name: 'get_tower', kind: 'read', roles: ALL,
    description: 'One placed tower: stats, upgrade/branch/evolve costs and effects, sell value, ability.',
    input_schema: obj({ uid: UID }, ['uid']),
  },
  {
    name: 'suggest', kind: 'control', roles: ['advisor'],
    description: 'Advisor: advise the human (Chinese, ≤120 chars) + up to 4 concrete actions like "place pencil 3,5". Ends your turn.',
    input_schema: obj({ text: str('suggestion'), actions: { type: 'array', items: str('one action'), description: 'up to 4' }, note: str('memo for next time') }, ['text']),
  },
];

/** 旧版 act（无意图；assist 关闭 = 评测基线） */
export const ACT_TOOL_V1: AgentToolDef = {
  name: 'act', kind: 'action', roles: P,
  description: 'Run game actions in order (each validated; per-action results). Put ALL actions of this decision in one call and include end to finish the turn. Fields per do: place tower,x,y | upgrade/evolve/sell uid | branch uid,branch | target uid,mode | cast_skill skill (+x,y / uid / axis,index / spawner) | tower_ability uid (+x,y/angle/axis,index/target_uid) | collect [uid] | choose_perk id [uid,branch] | reroll_perks | choose_crate option | demolish id | start_wave | end_turn [note].',
  input_schema: obj({
    actions: { type: 'array', items: ACTION_V1, description: 'ordered actions (max 16)' },
    end: { ...MEMO, description: 'finish the turn; fields update your MEMO' },
  }, ['actions']),
};

export const TOOL_BY_NAME: Record<string, AgentToolDef> = Object.fromEntries([...LEGACY_TOOLS, ...SLIM_TOOLS].map((t) => [t.name, t]));

/** 发给模型的工具（精简集）。assist = false：旧版 act（无意图），评测基线用 */
export function toolsForRole(role: AgentRole, assist = true): AgentToolDef[] {
  return SLIM_TOOLS.filter((t) => t.roles.includes(role)).map((t) => (t.name === 'act' && !assist ? ACT_TOOL_V1 : t));
}

/** 旧的细粒度工具（MCP / 旧客户端） */
export function legacyToolsForRole(role: AgentRole): AgentToolDef[] {
  return LEGACY_TOOLS.filter((t) => t.roles.includes(role));
}

// ───────────────────────── 校验 ─────────────────────────

/** 最小 JSON Schema 校验（只覆盖本文件用到的子集）。返回错误列表，空 = 通过。 */
export function validateAgainst(schema: JsonSchema, v: unknown, path = 'input'): string[] {
  switch (schema.type) {
    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return [`${path} must be an object`];
      const o = v as Record<string, unknown>;
      const errs: string[] = [];
      for (const k of schema.required) if (o[k] === undefined || o[k] === null) errs.push(`${path}.${k} is required`);
      for (const [k, val] of Object.entries(o)) {
        if (val === undefined || val === null) continue;
        const sub = schema.properties[k];
        if (!sub) errs.push(`${path}.${k} is not allowed`);
        else errs.push(...validateAgainst(sub, val, `${path}.${k}`));
      }
      return errs;
    }
    case 'string':
      if (typeof v !== 'string') return [`${path} must be a string`];
      if (schema.enum && !schema.enum.includes(v)) return [`${path} must be one of ${schema.enum.join('|')}`];
      return [];
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v) ? [] : [`${path} must be an integer`];
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? [] : [`${path} must be a number`];
    case 'boolean':
      return typeof v === 'boolean' ? [] : [`${path} must be a boolean`];
    case 'array': {
      if (!Array.isArray(v)) return [`${path} must be an array`];
      return v.flatMap((x, i) => validateAgainst(schema.items, x, `${path}[${i}]`));
    }
  }
}

export function validateToolInput(name: string, input: unknown): string[] {
  const def = TOOL_BY_NAME[name];
  if (!def) return [`unknown tool ${name}`];
  return validateAgainst(def.input_schema, input ?? {});
}

// ───────────────────────── 工具 → 指令 ─────────────────────────

type In = Record<string, unknown>;
const n = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * 动作工具 → Command（纯函数；需要世界信息的只有 cast_skill：按技能的目标类型挑字段）。
 * 返回 { error } 表示参数不足。
 */
export function toCommand(w: IWorld | null, name: string, input: In): Command | { error: string } {
  switch (name) {
    case 'place_tower': return { type: 'place', tower: input.tower as TowerId, cx: n(input.x)!, cy: n(input.y)! };
    case 'upgrade_tower': return { type: 'upgrade', uid: n(input.uid)! };
    case 'choose_branch': return { type: 'upgrade', uid: n(input.uid)!, branch: input.branch as Branch };
    case 'evolve_tower': return { type: 'evolve', uid: n(input.uid)! };
    case 'sell_tower': return { type: 'sell', uid: n(input.uid)! };
    case 'set_target_mode': return { type: 'setTarget', uid: n(input.uid)!, mode: input.mode as TargetMode };
    case 'start_wave': return { type: 'startWave' };
    case 'reroll_perks': return { type: 'rerollPerks' };
    case 'choose_crate': return { type: 'chooseCrate', option: s(input.option)! };
    case 'demolish_spawner': return { type: 'demolishSpawner', id: s(input.id)! };
    case 'choose_perk': {
      const c: Command = { type: 'choosePerk', id: s(input.id)! };
      if (n(input.uid) !== undefined) c.uid = n(input.uid);
      if (s(input.branch)) c.branch = input.branch as Branch;
      return c;
    }
    case 'collect_pickup': {
      if (n(input.uid) === undefined) return { error: 'collect_pickup without uid is expanded by the executor' };
      return { type: 'collect', uid: n(input.uid)! };
    }
    case 'cast_skill': return castCommand(w, input);
    case 'tower_ability': {
      const c: Extract<Command, { type: 'towerAbility' }> = { type: 'towerAbility', uid: n(input.uid)! };
      const x = n(input.x);
      const y = n(input.y);
      if (x !== undefined && y !== undefined) { c.x = x + 0.5; c.y = y + 0.5; }
      if (n(input.angle) !== undefined) c.angle = n(input.angle);
      if (s(input.axis)) c.axis = input.axis as 'row' | 'col';
      if (n(input.index) !== undefined) c.index = n(input.index);
      if (n(input.target_uid) !== undefined) c.targetUid = n(input.target_uid);
      return c;
    }
  }
  return { error: `${name} is not an action tool` };
}

function castCommand(w: IWorld | null, input: In): Command | { error: string } {
  const skill = input.skill as SkillId;
  const x = n(input.x);
  const y = n(input.y);
  const target = w?.state.skills.find((k) => k.id === skill)?.target ?? defaultSkillTarget(skill);
  const c: Extract<Command, { type: 'cast' }> = { type: 'cast', skill };
  switch (target) {
    case 'none': break;
    case 'circle':
      if (x === undefined || y === undefined) return { error: `${skill} needs x,y (center cell)` };
      c.x = x + 0.5; c.y = y + 0.5;
      break;
    case 'rect2':
      if (x === undefined || y === undefined) return { error: `${skill} needs x,y (top-left cell of 2×2)` };
      c.cx = x; c.cy = y;
      break;
    case 'line': {
      const axis = (s(input.axis) as 'row' | 'col' | undefined) ?? 'row';
      const idx = n(input.index) ?? (axis === 'row' ? y : x);
      if (idx === undefined) return { error: `${skill} needs axis + index` };
      c.axis = axis;
      if (axis === 'row') c.cy = idx; else c.cx = idx;
      break;
    }
    case 'tower':
      if (n(input.uid) === undefined) return { error: `${skill} needs uid` };
      c.uid = n(input.uid);
      break;
    case 'tower+cell':
      if (n(input.uid) === undefined || x === undefined || y === undefined) return { error: `${skill} needs uid and destination x,y` };
      c.uid = n(input.uid); c.cx = x; c.cy = y;
      break;
    case 'spawner':
      if (!s(input.spawner)) return { error: `${skill} needs spawner id` };
      c.spawner = s(input.spawner);
      break;
  }
  return c;
}

function defaultSkillTarget(skill: SkillId): string {
  const m: Record<SkillId, string> = {
    eraser_strike: 'circle', bell: 'none', whiteout_zone: 'rect2', caffeine: 'none', ruler_sweep: 'line',
    scholarship: 'none', relocate: 'tower+cell', inspiration: 'tower', magnifier: 'circle', seal_tape: 'spawner',
  };
  return m[skill] ?? 'none';
}

// ───────────────────────── 执行器 ─────────────────────────

export interface ToolContext {
  world: IWorld;
  role: AgentRole;
  /**
   * 指令出口。缺省直接 world.command()；realtime 浏览器模式可以换成"排队到下一帧"的实现。
   * 军师角色永远不会调用它。
   */
  sink?: CommandSink;
  /** 军师建议回调 */
  onSuggest?: (text: string, actions: string[]) => void;
  /** observe 被调用：模型拿到了一份完整观测（增量基线随之更新） */
  onObserve?: (obs: CompactObs) => void;
  /** 地图用游程编码 */
  rleMap?: boolean;
  /** 打法辅助（意图 + 被拒放置自动挪位 + 不可修正的失败直接结束回合）；缺省开 */
  assist?: boolean;
  /** 规划器的跨决策状态（save 意图） */
  planner?: PlannerState;
}

const fmtCmd = (c: Command): string => JSON.stringify(c);

function describeOk(w: IWorld, name: string, cmd: Command, before: { gold: number; towers: Set<number> }): string {
  const st = w.state;
  const gold = Math.floor(st.gold);
  const spent = Math.round(before.gold - st.gold);
  switch (cmd.type) {
    case 'place': {
      const nu = [...st.towers.keys()].find((u) => !before.towers.has(u));
      return `OK placed ${cmd.tower} #${nu ?? '?'} at ${cmd.cx},${cmd.cy} (-${spent}g, gold ${gold}) path ${w.currentPaths().map((p) => p.length).join('/')}`;
    }
    case 'upgrade': {
      const t = st.towers.get(cmd.uid);
      return `OK #${cmd.uid} ${t?.id} now L${t?.level}${t?.branch ? ` branch ${t.branch}` : ''} (-${spent}g, gold ${gold})`;
    }
    case 'evolve': return `OK #${cmd.uid} now ★${st.towers.get(cmd.uid)?.stars} (-${spent}g, gold ${gold})`;
    case 'sell': return `OK sold #${cmd.uid} (+${-spent}g, gold ${gold}) path ${w.currentPaths().map((p) => p.length).join('/')}`;
    case 'startWave': return `OK wave ${st.wave} started${-spent > 0 ? ` (+${-spent}g early bonus)` : ''}`;
    case 'choosePerk': return `OK perk ${cmd.id} taken (gold ${gold}). phase ${st.phase}`;
    case 'rerollPerks': return `OK rerolled: ${st.perkChoices?.map((c) => `${c.id}(${c.rarity}${c.needsTower ? ', needs uid+branch' : ''}): ${c.desc}`).join(' | ')}`;
    default: return `OK ${name} (gold ${gold})`;
  }
}

/**
 * 执行一个工具。永不抛异常：参数错误 / 指令被拒都以 ok:false + 可读原因返回，模型可以据此改正。
 */
export function executeTool(ctx: ToolContext, name: string, rawInput: unknown): ToolResult {
  // AI 看到的目录 / 原因 / 观察文本始终用源语言（简体中文），与玩家界面语言无关
  return withLocale(SOURCE_LOCALE, () => executeToolInner(ctx, name, rawInput));
}

function executeToolInner(ctx: ToolContext, name: string, rawInput: unknown): ToolResult {
  const def = TOOL_BY_NAME[name];
  if (!def) return { ok: false, text: `ERROR unknown tool "${name}"` };
  if (!def.roles.includes(ctx.role)) return { ok: false, text: `ERROR tool ${name} is not available for role ${ctx.role}` };
  const input = (rawInput ?? {}) as In;
  const errs = validateToolInput(name, input);
  if (errs.length) return { ok: false, text: `ERROR invalid input: ${errs.join('; ')}` };
  const w = ctx.world;
  const st = w.state;

  switch (name) {
    case 'act':
      return executeAct(ctx, input);
    case 'observe': {
      const full = input.detail === 'full';
      if (full) {
        return { ok: true, text: `${renderObservation(w, { detail: 'full' })}\nROUTES ${routeSummary(w).ground.join(' | ')}\nCOVERAGE ${coverageLines(w).join(' | ')}` };
      }
      const obs = compactObservation(w);
      ctx.onObserve?.(obs);
      return { ok: true, text: `${JSON.stringify(obs)}\nMAP\n${terrainMap(w, { rle: ctx.rleMap, routes: groundRoutes(w) }).join('\n')}` };
    }
    case 'preview': {
      const place = (input.place as { tower: TowerId; x: number; y: number }[] | undefined) ?? [];
      const remove = (input.remove as number[] | undefined) ?? [];
      if (!place.length && !remove.length) {
        const rs = groundRoutes(w);
        return { ok: true, text: rs.map((r) => `${r.id}${r.status === 'warn' ? '(warn)' : ''} L${r.len}: ${fmtWp(r.wp)}`).join('\n') || 'no routes' };
      }
      return { ok: true, text: previewText(previewChanges(w, { place: place.slice(0, 8), remove: remove.slice(0, 8) })) };
    }
    case 'get_state':
      return { ok: true, text: renderObservation(w, { detail: input.detail === 'full' ? 'full' : 'compact' }) };
    case 'get_catalog': {
      if (typeof input.id === 'string') {
        const e = catalogEntry(input.id);
        return e ? { ok: true, text: e } : { ok: false, text: `ERROR no catalog entry "${input.id}"` };
      }
      return { ok: true, text: catalogText((input.section as CatalogSection | undefined) ?? 'all') };
    }
    case 'get_tower': {
      const info = w.getTowerInfo(input.uid as number);
      if (!info) return { ok: false, text: `ERROR tower #${input.uid} does not exist` };
      const { stats, traits, evoTraits, ...rest } = info;
      return {
        ok: true,
        text: JSON.stringify({
          ...rest,
          stats: stats.map((x) => `${x.label} ${x.value}`),
          traits: traits.filter((t) => t.unlocked).map((t) => `${t.name}: ${t.desc}`),
          evoTraits: evoTraits.map((t) => `${t.unlocked ? '✓' : '·'}${t.name}: ${t.desc}`),
        }),
      };
    }
    case 'preview_placement': {
      const tower = input.tower as TowerId;
      const x = input.x as number;
      const y = input.y as number;
      const chk = w.canPlace(tower, x, y);
      const cur = w.currentPaths().map((p) => p.length);
      if (!chk.ok) return { ok: true, text: `cannot place ${tower} at ${x},${y}: ${chk.reason}` };
      const pv = w.previewPath(tower, x, y);
      const nl = pv ? pv.map((p) => p.length) : cur;
      return { ok: true, text: `can place ${tower} at ${x},${y} (cost ${w.getBuildOptions().find((b) => b.id === tower)?.cost}). path lengths ${cur.join('/')} → ${nl.join('/')}` };
    }
    case 'end_turn': {
      const note = typeof input.note === 'string' ? input.note.slice(0, 200) : undefined;
      return { ok: true, text: 'OK turn ended', endTurn: true, note };
    }
    case 'suggest': {
      const text = String(input.text).slice(0, 240);
      const actions = Array.isArray(input.actions) ? (input.actions as string[]).slice(0, 4).map((a) => String(a).slice(0, 80)) : [];
      ctx.onSuggest?.(text, actions);
      const note = typeof input.note === 'string' ? input.note : undefined;
      return { ok: true, text: 'OK suggestion recorded; turn ended', endTurn: true, ...(note ? { note: note.slice(0, 600), memo: { note } } : {}) };
    }
  }

  // 动作
  if (name === 'collect_pickup' && input.uid === undefined) {
    const items = st.pickups.slice();
    if (!items.length) return { ok: false, text: 'ERROR nothing to collect' };
    const got: string[] = [];
    for (const p of items) {
      if (p.kind === 'crate' && st.crateChoice) continue;
      const r = send(ctx, { type: 'collect', uid: p.uid });
      if (r.ok) got.push(`#${p.uid} ${p.kind}`);
    }
    const crate = st.crateChoice ? ` crate opened: ${st.crateChoice.options.map((o) => `${o.id}: ${o.desc}`).join(' | ')} → call choose_crate` : '';
    return { ok: got.length > 0, text: got.length ? `OK collected ${got.join(', ')} (gold ${Math.floor(st.gold)}).${crate}` : 'ERROR nothing collectable' };
  }
  const cmd = toCommand(w, name, input);
  if ('error' in cmd) return { ok: false, text: `ERROR ${cmd.error}` };
  const before = { gold: st.gold, towers: new Set(st.towers.keys()) };
  const r = send(ctx, cmd);
  if (!r.ok) return { ok: false, text: `REJECTED ${fmtCmd(cmd)}: ${r.reason ?? 'invalid'}${hint(w, cmd)}`, cmd };
  if (r.queuedFor !== undefined) return { ok: true, text: `QUEUED ${fmtCmd(cmd)} for tick ${r.queuedFor}`, cmd, queuedFor: r.queuedFor };
  let text = describeOk(w, name, cmd, before);
  if (cmd.type === 'collect' && st.crateChoice) text += ` crate opened: ${st.crateChoice.options.map((o) => `${o.id}: ${o.desc}`).join(' | ')} → call choose_crate`;
  return { ok: true, text, cmd };
}

function send(ctx: ToolContext, cmd: Command): ReturnType<CommandSink> {
  return ctx.sink ? ctx.sink(cmd) : ctx.world.command(cmd);
}

/** 被拒时附带一点帮助模型改正的信息 */
function hint(w: IWorld, cmd: Command): string {
  const st = w.state;
  if (cmd.type === 'place') {
    const b = w.getBuildOptions().find((o) => o.id === cmd.tower);
    if (b && !b.affordable) return ` (cost ${b.cost}, gold ${Math.floor(st.gold)})`;
    if (cmd.cx < 0 || cmd.cx >= st.grid.cols || cmd.cy < 0 || cmd.cy >= st.grid.rows) return ` (grid is ${st.grid.cols}×${st.grid.rows})`;
  }
  if ((cmd.type === 'upgrade' || cmd.type === 'evolve') && st.towers.has(cmd.uid)) {
    const info = w.getTowerInfo(cmd.uid);
    if (info) return ` (upgrade ${info.upgradeCost ?? 'max'}${info.needsBranch ? ' needs branch → choose_branch' : ''}, evolve ${info.evolveCost ?? '-'}, gold ${Math.floor(st.gold)})`;
  }
  if (cmd.type === 'choosePerk' && st.perkChoices) return ` (offered: ${st.perkChoices.map((c) => c.id).join(', ')})`;
  return '';
}

/** 地图（给 MCP / 调试） */
export const mapText = (w: IWorld): string => asciiMap(w).join('\n');


// ───────────────────────── act：批量动作 ─────────────────────────

/** 一条 act 动作 → 旧工具名 + 输入（只取该动作用到的字段） */
export function actToLegacy(a: Record<string, unknown>): { name: string; input: Record<string, unknown> } | { error: string } {
  const kind = String(a.do);
  const name = ACT_TO_LEGACY[kind];
  if (!name) return { error: `unknown do "${kind}"` };
  const input: Record<string, unknown> = {};
  for (const f of ACT_FIELDS[kind] ?? []) if (a[f] !== undefined && a[f] !== null) input[f] = a[f];
  if (kind === 'demolish' && input.id === undefined && typeof a.spawner === 'string') input.id = a.spawner;
  return { name, input };
}

const MAX_ACT = 16;

/** 去掉旧结果文字里的冗余前缀，保证一行 */
const oneLine = (t: string): string => t.replace(/\s*\n\s*/g, ' ').slice(0, 220);

/** 模型这回合修不好的失败（钱不够 / 冷却 / 充能）：不为它们再发一次请求 */
const UNFIXABLE = /金币不足|技能冷却中|没有充能|冷却中|nothing to collect|nothing collectable/;

function runIntent(p: Planner, a: Record<string, unknown>): IntentOutcome {
  const nn = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const ss = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  switch (a.do) {
    case 'maze': return p.maze((ss(a.style) as 'serpentine' | 'funnel' | undefined) ?? 'serpentine', nn(a.budget), ss(a.route));
    case 'build_near': {
      const t = ss(a.tower) as TowerId | undefined;
      const pu = ss(a.purpose);
      if (!t && pu && (PURPOSES as readonly string[]).includes(pu)) return p.buildPurpose(pu as Purpose, ss(a.target) ?? '', nn(a.count) ?? 1);
      if (!t) return { ok: false, text: `build_near needs tower or purpose (${PURPOSES.join('|')})`, spent: 0, done: 0 };
      return p.buildNear(t, ss(a.target) ?? '', nn(a.count) ?? 1);
    }
    case 'combo': return p.combo(ss(a.pair) ?? '', ss(a.near) ?? ss(a.target) ?? 'route');
    case 'support': return p.support();
    case 'economy': return p.economy(nn(a.count) ?? 1);
    case 'reclaim': {
      const tg = ss(a.target) ?? 'useless_walls';
      if (!['useless_walls', 'idle_towers', 'cells'].includes(tg)) return { ok: false, text: 'reclaim target: useless_walls|idle_towers|cells', spent: 0, done: 0 };
      return p.reclaim(tg as 'useless_walls' | 'idle_towers' | 'cells', nn(a.max) ?? nn(a.count) ?? 4, ss(a.replaceWith), a.dry === true);
    }
    case 'rebuild_maze': return p.rebuildMaze((ss(a.style) as 'serpentine' | 'funnel' | undefined) ?? 'serpentine', ss(a.route), nn(a.budget));
    case 'upgrade_best': return p.upgradeBest(nn(a.count) ?? 1, (ss(a.metric) as 'dps' | 'coverage' | undefined) ?? 'dps', nn(a.budget));
    case 'anti_air': return p.antiAir(ss(a.route), nn(a.count) ?? 1);
    case 'spend': return p.spend(Math.max(0, nn(a.reserve) ?? 0), (ss(a.focus) as 'balanced' | 'towers' | 'upgrades' | 'maze' | undefined) ?? 'balanced');
    case 'save': return p.save(Math.max(0, nn(a.until) ?? 0));
  }
  return { ok: false, text: `unknown intent ${String(a.do)}`, spent: 0, done: 0 };
}

function executeAct(ctx: ToolContext, input: In): ToolResult {
  const list = Array.isArray(input.actions) ? (input.actions as Record<string, unknown>[]) : [];
  const w = ctx.world;
  const assist = ctx.assist !== false;
  const lines: string[] = [];
  let failed = 0;
  let hardFailed = 0;
  let endNote: string | undefined;
  let ended = input.end !== undefined && input.end !== null;
  const memo: NonNullable<ToolResult['memo']> = {};
  if (ended && typeof input.end === 'object') {
    for (const k of ['plan', 'maze', 'priorities', 'note'] as const) {
      const v = (input.end as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.trim()) memo[k] = v.trim();
    }
  }
  let planner: Planner | null = null;
  const getPlanner = (): Planner => (planner ??= new Planner(w, (c) => send(ctx, c), ctx.planner ?? {}));
  let last: ToolResult | undefined;
  list.slice(0, MAX_ACT).forEach((a, i) => {
    const n = i + 1;
    if (a.do === 'end_turn') {
      ended = true;
      if (typeof a.note === 'string' && a.note.trim()) endNote = a.note.trim();
      lines.push(`${n} OK end`);
      return;
    }
    if ((INTENT_KINDS as readonly string[]).includes(String(a.do))) {
      if (!assist) { failed++; hardFailed++; lines.push(`${n} ERROR unknown do "${String(a.do)}"`); return; }
      const o = runIntent(getPlanner(), a);
      // 意图"什么都没做"不算错误（例如钱不够）：结果文字里写明原因，模型下次再决定
      lines.push(`${n} ${o.done || o.ok ? 'OK' : 'NOOP'} ${o.text}`.slice(0, 600));
      return;
    }
    const m = actToLegacy(a);
    if ('error' in m) { failed++; hardFailed++; lines.push(`${n} ERROR ${m.error}`); return; }
    const errs = validateToolInput(m.name, m.input);
    if (errs.length) { failed++; hardFailed++; lines.push(`${n} ERROR ${a.do}: ${errs.join('; ')}`); return; }
    let r = executeTool(ctx, m.name, m.input);
    if (!r.ok && assist && m.name === 'place_tower' && m.input.tower !== 'wall') {
      // 被拒的放置：格子被敌人 / 障碍 / 塔占着或会堵路 → 自动挪到 2 格内覆盖最好的可放格
      const t = m.input.tower as TowerId;
      const x = m.input.x as number;
      const y = m.input.y as number;
      const chk = w.canPlace(t, x, y);
      const why = chk.reason ?? '';
      const alt = getPlanner().relocate(t, x, y, chk.code ?? '');
      if (alt) {
        const r2 = executeTool(ctx, 'place_tower', { tower: t, x: alt.x, y: alt.y });
        if (r2.ok) r = { ...r2, text: `MOVED ${x},${y} (${why}) → ${r2.text}` };
      }
    }
    last = r;
    if (!r.ok) {
      failed++;
      // 放置被拒但其实也买不起（位置错 + 钱不够）：这回合同样修不好
      const poor = m.name === 'place_tower' && (w.getBuildOptions().find((b) => b.id === m.input.tower)?.cost ?? 0) > w.state.gold;
      if (!UNFIXABLE.test(r.text) && !(assist && poor)) hardFailed++;
    }
    lines.push(`${n} ${oneLine(r.text)}`);
  });
  if (list.length > MAX_ACT) lines.push(`(only the first ${MAX_ACT} actions were run)`);
  if (endNote && !memo.note) memo.note = endNote;
  const st = w.state;
  lines.push(`→ gold ${Math.floor(st.gold)} lives ${st.lives} phase ${st.phase} path ${w.currentPaths().map((p) => p.length).join('/')}`);
  // 全部成功又没写 end：也算本回合结束（省一次"只为说结束"的请求）；有失败则留给模型改正
  // assist：只剩"钱不够 / 冷却中"这类这回合修不好的失败，也直接结束
  const endTurn = ended || ((assist ? hardFailed : failed) === 0 && list.length > 0);
  if (!ended && endTurn) lines.push(failed ? 'turn ended (the failures cannot be fixed this turn)' : 'turn ended (all actions OK)');
  else if (!endTurn) lines.push(failed ? 'fix the failed actions with another act (include end), or act {actions:[],end:{}}' : '');
  const hasMemo = Object.keys(memo).length > 0;
  return {
    ok: failed === 0,
    text: lines.filter(Boolean).join('\n'),
    endTurn,
    ...(hasMemo ? { memo, note: Object.values(memo).join(' | ').slice(0, 600) } : {}),
    ...(last?.cmd && list.length === 1 ? { cmd: last.cmd } : {}),
    ...(last?.queuedFor !== undefined && list.length === 1 ? { queuedFor: last.queuedFor } : {}),
  };
}
