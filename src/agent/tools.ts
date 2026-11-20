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
import {
  TOWER_IDS, type Branch, type Command, type IWorld, type SkillId, type TargetMode, type TowerId,
} from '../core/types';
import { SKILL_IDS } from '../config/skills';
import { asciiMap, renderObservation } from './observation';
import { catalogText, type CatalogSection } from './prompts';
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

/** 全部工具。顺序固定（提示缓存要求工具列表逐字节稳定）。 */
export const AGENT_TOOLS: AgentToolDef[] = [
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

export const TOOL_BY_NAME: Record<string, AgentToolDef> = Object.fromEntries(AGENT_TOOLS.map((t) => [t.name, t]));

export function toolsForRole(role: AgentRole): AgentToolDef[] {
  return AGENT_TOOLS.filter((t) => t.roles.includes(role));
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
}

const fmtCmd = (c: Command): string => JSON.stringify(c);

function describeOk(w: IWorld, name: string, cmd: Command, before: { gold: number; towers: Set<number> }): string {
  const st = w.state;
  const gold = Math.floor(st.gold);
  const spent = Math.round(before.gold - st.gold);
  switch (cmd.type) {
    case 'place': {
      const nu = [...st.towers.keys()].find((u) => !before.towers.has(u));
      return `OK placed ${cmd.tower} #${nu ?? '?'} at ${cmd.cx},${cmd.cy} (-${spent}g, gold ${gold}). path lengths now ${w.currentPaths().map((p) => p.length).join('/')}`;
    }
    case 'upgrade': {
      const t = st.towers.get(cmd.uid);
      return `OK #${cmd.uid} ${t?.id} now L${t?.level}${t?.branch ? ` branch ${t.branch}` : ''} (-${spent}g, gold ${gold})`;
    }
    case 'evolve': return `OK #${cmd.uid} now ★${st.towers.get(cmd.uid)?.stars} (-${spent}g, gold ${gold})`;
    case 'sell': return `OK sold #${cmd.uid} (+${-spent}g, gold ${gold}). path lengths now ${w.currentPaths().map((p) => p.length).join('/')}`;
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
  const def = TOOL_BY_NAME[name];
  if (!def) return { ok: false, text: `ERROR unknown tool "${name}"` };
  if (!def.roles.includes(ctx.role)) return { ok: false, text: `ERROR tool ${name} is not available for role ${ctx.role}` };
  const input = (rawInput ?? {}) as In;
  const errs = validateToolInput(name, input);
  if (errs.length) return { ok: false, text: `ERROR invalid input: ${errs.join('; ')}` };
  const w = ctx.world;
  const st = w.state;

  switch (name) {
    case 'get_state':
      return { ok: true, text: renderObservation(w, { detail: input.detail === 'full' ? 'full' : 'compact' }) };
    case 'get_catalog':
      return { ok: true, text: catalogText((input.section as CatalogSection | undefined) ?? 'all') };
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
      return { ok: true, text: 'OK suggestion recorded' };
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
