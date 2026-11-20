/**
 * 军师建议里的动作字符串（"place_tower pencil 3,5"）→ 工具调用 → 指令；以及工具调用的中文短描述（决策流用）。
 * 解析很宽松（位置参数 / key=value / JSON 都认），但最终都要过 Agent 工具的同一份 Schema 校验，
 * 执行仍走玩家的 session.command —— 与手动点击完全同一套规则。
 */
import { AGENT_TOOLS, toCommand, validateToolInput, type ToolCallRecord } from '../../agent';
import type { Command, CommandResult, IWorld } from '../../core/types';
import { SKILL_META, TOWER_META } from '../coreMeta';

export interface ParsedAction {
  name: string;
  input: Record<string, unknown>;
}

const TOOL_NAMES = new Set(AGENT_TOOLS.filter((t) => t.kind === 'action').map((t) => t.name));

const POSITIONAL: Record<string, string[]> = {
  place_tower: ['tower', 'x', 'y'],
  upgrade_tower: ['uid'],
  evolve_tower: ['uid'],
  sell_tower: ['uid'],
  choose_branch: ['uid', 'branch'],
  set_target_mode: ['uid', 'mode'],
  choose_perk: ['id', 'uid', 'branch'],
  choose_crate: ['option'],
  demolish_spawner: ['id'],
  collect_pickup: ['uid'],
  tower_ability: ['uid', 'x', 'y'],
  start_wave: [],
  reroll_perks: [],
};

const NUMERIC = new Set(['x', 'y', 'uid', 'index', 'target_uid', 'angle']);

function coerce(key: string, raw: string): unknown {
  const v = raw.replace(/^["'`]|["'`]$/g, '').replace(/^#/, '');
  if (NUMERIC.has(key)) {
    // 地图图例里列 10 / 11 写作 a / b
    if (key === 'x' && /^[ab]$/i.test(v)) return v.toLowerCase() === 'a' ? 10 : 11;
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}

function castSkillArgs(tokens: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!tokens.length) return out;
  out.skill = coerce('skill', tokens[0]);
  const rest = tokens.slice(1);
  if (!rest.length) return out;
  const nums = rest.map((t) => Number(t.replace(/^#/, '')));
  if (/^(row|col)$/i.test(rest[0]) && rest[1] !== undefined) {
    out.axis = rest[0].toLowerCase();
    out.index = Number(rest[1]);
  } else if (/^drop-/i.test(rest[0])) out.spawner = rest[0];
  else if (rest.length >= 3 && nums.slice(0, 3).every(Number.isFinite)) {
    out.uid = nums[0];
    out.x = nums[1];
    out.y = nums[2];
  } else if (rest.length === 2 && nums.every(Number.isFinite)) {
    out.x = nums[0];
    out.y = nums[1];
  } else if (rest.length === 1 && Number.isFinite(nums[0])) out.uid = nums[0];
  return out;
}

/** 解析一条动作；认不出或不合 Schema 时返回 null */
export function parseAction(raw: string): ParsedAction | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/^[-*•\d.)\s`]+(?=[a-z_]+)/i, '').replace(/[`;\s]+$/g, '').trim();
  const m = /^([a-z_]+)\s*(.*)$/is.exec(s);
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (!TOOL_NAMES.has(name)) return null;
  s = m[2].trim().replace(/^[:(]\s*/, '').replace(/\)\s*;?$/, '').trim();
  let input: Record<string, unknown> = {};
  if (s.startsWith('{')) {
    try {
      const j: unknown = JSON.parse(s);
      if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
      input = j as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (/[a-z_]+\s*[=:]\s*\S/i.test(s)) {
    const re = /([a-z_]+)\s*[=:]\s*("[^"]*"|'[^']*'|[^,\s]+)/gi;
    let kv: RegExpExecArray | null;
    while ((kv = re.exec(s))) input[kv[1]] = coerce(kv[1], kv[2]);
  } else {
    const tokens = s.split(/[\s,@]+/).filter(Boolean);
    if (name === 'cast_skill') input = castSkillArgs(tokens);
    else {
      const keys = POSITIONAL[name] ?? [];
      tokens.slice(0, keys.length).forEach((t, i) => (input[keys[i]] = coerce(keys[i], t)));
    }
  }
  if (typeof input.branch === 'string') input.branch = input.branch.toUpperCase();
  if (validateToolInput(name, input).length) return null;
  return { name, input };
}

/** 执行一条已解析的动作（走调用方给的指令出口） */
export function applyAction(world: IWorld, send: (c: Command) => CommandResult, a: ParsedAction): { ok: boolean; reason?: string } {
  if (a.name === 'collect_pickup' && a.input.uid === undefined) {
    let any = false;
    for (const p of world.state.pickups.slice()) any = send({ type: 'collect', uid: p.uid }).ok || any;
    return any ? { ok: true } : { ok: false, reason: '没有可以拾取的东西' };
  }
  const cmd = toCommand(world, a.name, a.input);
  if ('error' in cmd) return { ok: false, reason: '这条建议缺少必要的参数' };
  const r = send(cmd);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? '现在不能这样做' };
}

// ───────────── 中文短描述 ─────────────

const towerName = (id: unknown): string => (typeof id === 'string' ? (TOWER_META[id as keyof typeof TOWER_META]?.name ?? id) : '塔');
const skillName = (id: unknown): string => (typeof id === 'string' ? (SKILL_META[id as keyof typeof SKILL_META]?.name ?? id) : '技能');
const TARGET_NAME: Record<string, string> = { first: '最前', last: '最后', strong: '最强', weak: '最弱', close: '最近', air: '优先飞行' };
const CRATE_NAME: Record<string, string> = { gold: '金币', lives: '生命', cooldown: '冷却', xp: '经验', caffeine: '咖啡因', charge: '充能' };

function towerRef(world: IWorld | null, uid: unknown): string {
  const t = typeof uid === 'number' ? world?.state.towers.get(uid) : undefined;
  return t ? `${towerName(t.id)} #${t.uid}` : `#${String(uid)}`;
}

/** 一次工具调用的中文短描述；只读 / 控制类工具返回 null（决策流里不逐条显示） */
export function describeCall(world: IWorld | null, name: string, input: unknown): string | null {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const at = i.x !== undefined && i.y !== undefined ? `（${String(i.x)},${String(i.y)}）` : '';
  switch (name) {
    case 'place_tower': return `建造 ${towerName(i.tower)}${at}`;
    case 'upgrade_tower': return `升级 ${towerRef(world, i.uid)}`;
    case 'choose_branch': return `${towerRef(world, i.uid)} 走传奇分支 ${String(i.branch)}`;
    case 'evolve_tower': return `进化 ${towerRef(world, i.uid)}`;
    case 'sell_tower': return `出售 ${towerRef(world, i.uid)}`;
    case 'set_target_mode': return `${towerRef(world, i.uid)} 目标改为${TARGET_NAME[String(i.mode)] ?? String(i.mode)}`;
    case 'cast_skill': return `释放技能 ${skillName(i.skill)}${at}`;
    case 'tower_ability': return `${towerRef(world, i.uid)} 发动神话技能${at}`;
    case 'choose_perk': return `选择增益 ${String(i.id)}`;
    case 'reroll_perks': return '重抽增益';
    case 'collect_pickup': return i.uid === undefined ? '拾取全部掉落' : '拾取掉落';
    case 'choose_crate': return `补给箱选 ${CRATE_NAME[String(i.option)] ?? String(i.option)}`;
    case 'demolish_spawner': return `拆除空降点 ${String(i.id)}`;
    case 'start_wave': return '开始下一波';
    default: return null;
  }
}

/** 失败原因：从给模型看的结果文本里取出游戏给的中文原因 */
export function failReason(c: Pick<ToolCallRecord, 'result'>): string {
  const m = /^REJECTED [^:]*\{.*?\}: ([^(]+)/.exec(c.result) ?? /^ERROR (.+)$/.exec(c.result);
  return (m ? m[1] : c.result).trim().slice(0, 60);
}

export const REASON_NAME: Record<string, string> = {
  game_start: '开局',
  build: '建造阶段',
  wave_interval: '波次中',
  event_warn: '事件预警',
  drop_warn: '空降预警',
  boss_spawn: 'Boss 出场',
  perk: '选增益',
  crate: '补给箱',
  leak: '有漏怪',
};
