/**
 * 全服排行榜：客户端与服务端（Cloudflare Pages Functions）共用的纯逻辑。
 *
 * 约束：这里的代码会同时打进浏览器包和 Functions 包，
 * 只能使用两边都有的 API（不得引用 DOM / Node 专有对象），只允许 `import type` 引入 core 的类型。
 * 运行时依赖只有 src/config/difficulty（纯数据，得分倍率与 core 保持同源）。
 *
 * 设计文档：docs/12-全服排行榜.md
 */
import { version as PACKAGE_VERSION } from '../../package.json';
import { ABYSS_MAX_LEVEL, abyssParams, PRESETS } from '../config/difficulty';
import type { Command, DifficultyId, MapId, RunOptions, SkillId, TalentId } from '../core/types';
import { stDef } from './text';

// ───────────────────────── 版本 ─────────────────────────

/**
 * 内容修订号：任何会改变「同种子 + 同指令 → 同结果」的改动（数值平衡、波次生成、塔 / 敌人 / 事件逻辑）
 * 都必须 +1（或者升 package.json 版本号）。服务端只接受与自己相同版本的成绩，
 * 这样第二阶段的回放校验总能用「当前代码」复现「当前版本」提交的成绩。
 */
export const CONTENT_REVISION = 1;

/** 例如 "0.1.0+c1" */
export const GAME_VERSION = `${PACKAGE_VERSION}+c${CONTENT_REVISION}`;

// ───────────────────────── 常量 ─────────────────────────

export const TICKS_PER_SECOND = 60;
/** 指令日志：JSON 原文最大字节数 */
export const LOG_MAX_RAW_BYTES = 200_000;
/** 指令日志：gzip 后 base64 的最大字符数 */
export const LOG_MAX_GZ_CHARS = 160_000;
export const LOG_MAX_ENTRIES = 20_000;
/** 请求体上限（plain JSON 日志兜底时也够用） */
export const MAX_BODY_BYTES = 320_000;
export const NICK_MIN = 1;
export const NICK_MAX = 12;
export const SEED_MAX = 64;
/** 每个 IP / 每台设备：windowSec 内最多 max 次提交 */
export const RATE_LIMIT = { max: 10, windowSec: 600 } as const;
/** 每日挑战使用北京时间（UTC+8） */
export const DAILY_TZ_OFFSET_MIN = 8 * 60;
/** 跨零点宽限：零点后这么久内仍接受前一天的每日挑战成绩 */
export const DAILY_GRACE_MIN = 120;
/** 单波最长时长（手动开波可以在建造阶段无限发呆，这里给得很宽） */
export const MAX_SEC_PER_WAVE = 20 * 60;
/** 单波最短时长（提前开波也需要敌人出生、行走） */
export const MIN_SEC_PER_WAVE = 3;
/** 整局上限 12 小时 */
export const MAX_RUN_SEC = 12 * 3600;
/** 每秒最多 30 条指令 */
export const MAX_CMDS_PER_SEC = 30;
export const MAX_CMDS_PER_WAVE = 400;
export const LEADERBOARD_MAX_LIMIT = 100;

// ───────────────────────── 运行时 id 列表（编译期与 core 的类型保持一致） ─────────────────────────

export const MAPS = ['ch1', 'ch2', 'ch3'] as const satisfies readonly MapId[];
export const DIFFICULTIES = ['easy', 'normal', 'hard', 'nightmare', 'abyss'] as const satisfies readonly DifficultyId[];
export const SKILLS = [
  'eraser_strike',
  'bell',
  'whiteout_zone',
  'caffeine',
  'ruler_sweep',
  'scholarship',
  'relocate',
  'inspiration',
  'magnifier',
  'seal_tape',
] as const satisfies readonly SkillId[];
export const TALENTS = [
  'wallet',
  'bandaid',
  'alarm',
  'study',
  'secondhand',
  'bigbag',
  'luckydraw',
  'collector',
] as const satisfies readonly TalentId[];
export const COMMAND_TYPES = [
  'place',
  'upgrade',
  'sell',
  'setTarget',
  'startWave',
  'cast',
  'choosePerk',
  'rerollPerks',
  'collect',
  'chooseCrate',
  'demolishSpawner',
  'evolve',
  'towerAbility',
] as const satisfies readonly Command['type'][];

// core 新增了 id 而这里没跟上时，下面几行会编译失败（提醒同步 + 升 CONTENT_REVISION）
type Exhaustive<T extends never> = T;
export type _CheckMaps = Exhaustive<Exclude<MapId, (typeof MAPS)[number]>>;
export type _CheckDiffs = Exhaustive<Exclude<DifficultyId, (typeof DIFFICULTIES)[number]>>;
export type _CheckSkills = Exhaustive<Exclude<SkillId, (typeof SKILLS)[number]>>;
export type _CheckTalents = Exhaustive<Exclude<TalentId, (typeof TALENTS)[number]>>;
// overrideWave（AI 进攻方改写波次，文档 10 §2.3）故意不在白名单里：AI 出题局不参与排行，带它的记录会被拒绝
export type _CheckCommands = Exhaustive<Exclude<Command['type'], (typeof COMMAND_TYPES)[number] | 'overrideWave'>>;

// ───────────────────────── 数据结构 ─────────────────────────

export interface LogEntry {
  tick: number;
  cmd: Command;
}

/** 指令日志的传输格式：gzip + base64（首选），或直接是数组（浏览器不支持 CompressionStream 时） */
export type LogPayload = { gz: string } | LogEntry[];

/**
 * 客户端声明的结算结果。
 * 得分公式（文档 04 §7 / core updateScore）：
 *   round((cleared×100 + kills + lives×50 + gold×0.1 + bonus) × scoreMul)
 * cleared / bonus 是 core 的内部量（最近清掉的波 / 老师表扬加分），core 暴露之前可以不填，
 * 服务端会改用区间校验；填了就做精确校验。
 */
export interface ClaimedResult {
  /** 撑过的波数（排行展示 / 次级排序用） */
  wave: number;
  score: number;
  kills: number;
  lives: number;
  /** 结束时的金币 */
  gold: number;
  won: boolean;
  /** 结束时的逻辑帧号 world.state.tick */
  ticks: number;
  cleared?: number;
  bonus?: number;
  /** 仅战役：结束时的生命上限（增益会加上限），用于核对评星 */
  maxLives?: number;
  /** 仅战役：评星 1..3（通关），失败为 0 */
  stars?: number;
}

export interface SubmitBody {
  nickname: string;
  /** 客户端随机 UUID（服务端只保存其加盐哈希） */
  deviceId: string;
  board: string;
  opts: RunOptions;
  seed: string;
  log: LogPayload;
  result: ClaimedResult;
  gameVersion: string;
  turnstileToken?: string;
  /** 「AI 参战」（AI 从第 1 波起全程操作）：成绩照常进同一个榜，带「AI 辅助」+ 模型标记 */
  agent?: AgentMeta;
  /** 对局里用过「让 AI 替我玩」：成绩照常进榜，带「AI 辅助」标记（只用过军师不算，不发这个字段） */
  aiAssist?: AiAssistMeta;
}

/** 「让 AI 替我玩」的标记（只带模型名与思考档位，不含渠道 / 服务商 / 地址 / 任何 Key） */
export interface AiAssistMeta {
  model?: string;
  /** 思考档位（AI_EFFORTS）；旧客户端不发 */
  effort?: AiEffort;
  /**
   * 可选：AI 操作期间兜底机器人做的决策占比 0..1（AI 参战中途被你接管的局会带；> AI_BOT_SHARE_FLAG 时榜上标「兜底多」）。
   * 旧客户端不发，服务端存 NULL。
   */
  botShare?: number;
}

/** AI 对局随成绩上传的元数据（不含任何 Key） */
export interface AgentMeta {
  /**
   * 只做内部判断：新客户端只发 'scripted'（内置机器人）或 'llm'，不再发渠道 / 服务商；
   * 旧客户端可能发 claude-native / pi:ollama …（服务端照收、只存库，不对外返回）
   */
  provider: string;
  /** 模型名（publicModelName 清洗过：不带中转前缀 / 地址） */
  model: string;
  /** 思考档位（AI_EFFORTS）；内置机器人 / 旧客户端没有 */
  effort?: AiEffort;
  /** 决策模式 */
  mode: 'pause' | 'realtime';
  /** 兜底机器人做的决策占比 0..1（内置策略 scripted 恒为 1） */
  botShare: number;
  /** 决策点总数 */
  decisions: number;
  tokens?: number;
  costUsd?: number;
}

/** 榜单上展示的 AI 标记（只有模型名 + 思考档位，不含渠道 / 服务商） */
export interface AgentBadge {
  model: string;
  effort?: AiEffort;
  /** 内置机器人（离线演示 / 脚本策略） */
  scripted?: boolean;
  mode: 'pause' | 'realtime';
  botShare: number;
  /** 兜底机器人决策占比超过 AI_BOT_SHARE_FLAG：榜上标注「机器人代打」 */
  botAssisted: boolean;
}

export type RunStatus = 'pending' | 'verified' | 'rejected';

export interface SubmitResponse {
  /** 本设备在该榜上当前最佳成绩的 id（未刷新纪录时是旧纪录的 id） */
  id: string;
  /** 当前最佳成绩的名次（1 起） */
  rank: number;
  total: number;
  /** 这次提交是否刷新了本设备在该榜上的纪录 */
  improved: boolean;
  status: RunStatus;
}

export interface LeaderRow {
  rank: number;
  id: string;
  nickname: string;
  score: number;
  wave: number;
  kills: number;
  lives: number;
  map: MapId;
  difficulty: DifficultyId;
  /** 魔境等级（仅魔境） */
  abyssLevel?: number;
  /** 战役评星（通关 1..3，失败 0）；无尽 / 每日恒为 0 */
  stars: number;
  /** 战役是否通关 */
  won: boolean;
  status: RunStatus;
  /** 毫秒时间戳 */
  createdAt: number;
  /** AI 辅助（「让 AI 替我玩」或「AI 参战」）的成绩 */
  ai: boolean;
  /** AI 辅助时的模型名（可能为空；不含渠道） */
  aiModel?: string;
  /** AI 辅助时的思考档位（旧成绩没有） */
  aiEffort?: AiEffort;
  /** 仅「AI 参战」：模型 / 思考档位 / 决策模式 / 兜底占比 */
  agent?: AgentBadge;
  /**
   * AI 辅助成绩里兜底机器人决策占比超过 AI_BOT_SHARE_FLAG（AI 参战或中途接管的局；内置策略 scripted 除外）：
   * 照常排名，榜上标「兜底多」。缺省 / false 不标。
   */
  botHeavy?: boolean;
}

export interface LeaderboardResponse {
  board: string;
  rows: LeaderRow[];
  total: number;
  /** 是否隐藏了 AI 辅助的成绩（hideAi=1） */
  hideAi: boolean;
  /** 传了 around=deviceId 时：调用者在该榜的最佳成绩（没有成绩则 null） */
  me?: LeaderRow | null;
  generatedAt: number;
}

export interface RunDetail {
  id: string;
  board: string;
  nickname: string;
  opts: RunOptions;
  seed: string;
  /** gzip + base64 的指令日志（用 decodeLogPayload 解开） */
  logGz: string;
  result: ClaimedResult;
  gameVersion: string;
  status: RunStatus;
  createdAt: number;
  ai: boolean;
  aiModel?: string;
  aiEffort?: AiEffort;
  /** 仅「AI 参战」 */
  agent?: AgentBadge;
}

export interface DailyInfo {
  day: string;
  seed: string;
  map: MapId;
  difficulty: DifficultyId;
  abyssLevel?: number;
  board: string;
  /** 每日挑战固定：纯净（不带天赋）+ 自动开波，技能等级按 1 级 */
  pure: true;
  autoWave: true;
}

export interface StatusResponse {
  ok: true;
  gameVersion: string;
  turnstileSiteKey: string | null;
  daily: DailyInfo;
}

export interface ApiError {
  error: string;
  /** 中文提示，可直接展示 */
  message: string;
  retryAfter?: number;
}

// ───────────────────────── 排行榜键 ─────────────────────────
//
// 只有三类榜（文档 12 §3）：
//   endless              无尽榜：所有无尽成绩一张榜，按得分排（得分已含难度倍率），行上标难度 / 魔境等级 / 波数
//   daily:<YYYY-MM-DD>   每日挑战榜：每天一张
//   campaign:<ch1|ch2|ch3> 战役榜：每章一张，按 评星 → 得分 → 波数 排（普通 / 困难合并，得分倍率区分难度）
// AI 辅助（「让 AI 替我玩」/「AI 参战」）的成绩进同一张榜，只是带标记；查询时可以隐藏。
// 自定义模式（任意参数）不排名。
//
// 旧版本的榜键（'normal' / 'abyss3:pure:auto' / 'ai:normal:auto' …）一律归一到 endless（normalizeBoardKey），
// migrations/0003_simple_boards.sql 也把库里的旧行改到新榜键上。

const clampAbyss = (n: number | undefined): number => Math.max(1, Math.min(ABYSS_MAX_LEVEL, Math.floor(n ?? 1) || 1));

/** 与 core world.ts 一致：未指定时除简单难度外默认自动开波 */
export function effectiveAutoWave(opts: Pick<RunOptions, 'autoWave' | 'difficulty'>): boolean {
  return opts.autoWave ?? opts.difficulty !== 'easy';
}

/** 难度键：easy / normal / hard / nightmare / abyss1..abyss10（同 src/meta/progress diffKey） */
export function diffKeyOf(d: DifficultyId, abyssLevel?: number): string {
  return d === 'abyss' ? `abyss${clampAbyss(abyssLevel)}` : d;
}

/** 战役一章的波数（与 src/config/campaign.ts CAMPAIGN_WAVES 一致，测试里核对） */
export const CAMPAIGN_TOTAL_WAVES = 20;
/** 战役可选难度 */
export const CAMPAIGN_DIFFICULTIES = ['normal', 'hard'] as const satisfies readonly DifficultyId[];

export const ENDLESS_BOARD = 'endless';
export const dailyBoardKey = (day: string): string => `daily:${day}`;
export const campaignBoardKey = (map: MapId): string => `campaign:${map}`;
/** 自定义模式的「榜键」：不排名，服务端拒收 */
export const CUSTOM_BOARD = 'custom';

export type ParsedBoard = { kind: 'endless' } | { kind: 'daily'; day: string } | { kind: 'campaign'; map: MapId };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LEGACY_ENDLESS_RE = /^(easy|normal|hard|nightmare|abyss([1-9]|10))(:pure)?(:auto)?$/;

/** 解析（新）榜键；旧榜键先经过 normalizeBoardKey */
export function parseBoard(key: unknown): ParsedBoard | null {
  if (typeof key !== 'string' || key.length > 40) return null;
  if (key === ENDLESS_BOARD) return { kind: 'endless' };
  if (key.startsWith('daily:')) {
    const day = key.slice(6);
    return isValidDay(day) ? { kind: 'daily', day } : null;
  }
  if (key.startsWith('campaign:')) {
    const map = key.slice(9);
    return MAPS.includes(map as MapId) ? { kind: 'campaign', map: map as MapId } : null;
  }
  return null;
}

/** 旧版无尽榜键（`<难度键>[:pure][:auto]`，以及 AI 榜 `ai:` + 它）？ */
export function isLegacyEndlessKey(key: unknown): boolean {
  if (typeof key !== 'string' || key.length > 40) return false;
  const k = key.startsWith(AI_BOARD_PREFIX) ? key.slice(AI_BOARD_PREFIX.length) : key;
  return LEGACY_ENDLESS_RE.test(k) || k === ENDLESS_BOARD;
}

/** 任意（新 / 旧）榜键 → 新榜键；不认识的返回 null */
export function normalizeBoardKey(key: unknown): string | null {
  if (parseBoard(key)) return key as string;
  return isLegacyEndlessKey(key) ? ENDLESS_BOARD : null;
}

// ── AI 标记 ──

/** 旧版 AI 榜键前缀（'ai:normal:auto'）；现在只用于兼容旧客户端 / 旧链接，归一到 endless */
export const AI_BOARD_PREFIX = 'ai:';
/** 兜底机器人决策占比超过这个值的 AI 成绩会被标注 */
export const AI_BOT_SHARE_FLAG = 0.2;

const AGENT_PROVIDER_RE = /^[a-z0-9][a-z0-9:_.-]{0,39}$/;
const AGENT_MODEL_RE = /^[\x21-\x7e]{1,80}$/;

// ── 模型名 / 思考档位（对外只显示这两样，不显示渠道） ──

/** 思考档位白名单（与 src/agent/config.ts THINKING_LEVELS 一致，测试里核对） */
export const AI_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];
export const isAiEffort = (x: unknown): x is AiEffort => typeof x === 'string' && (AI_EFFORTS as readonly string[]).includes(x);

const URL_HEAD_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i;
const HOST_PORT_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+:\d{1,5}$/i;

/**
 * 对外显示的模型名：去掉渠道信息，只留模型本身。
 *  - 旧客户端的界面标签「服务商 · 模型」→ 只留「模型」；
 *  - 带地址 / 中转前缀 / 路径（https://relay.example/v1/gpt-5、openrouter 的 vendor/model）→ 只留最后一段；
 *  - 去掉查询串、控制字符；ascii = true 时非可打印 ASCII 换成 _（AI 参战的模型名要求）；≤ AI_MODEL_MAX 字。
 * 结果可能是空串（例如只填了一个地址）。
 */
export function publicModelName(raw: unknown, ascii = false): string {
  if (typeof raw !== 'string') return '';
  let s = raw.normalize('NFKC').replace(CONTROL_RE, '').trim();
  const dot = s.lastIndexOf(' · ');
  if (dot >= 0) s = s.slice(dot + 3);
  s = s
    .replace(/[?#].*$/, '')
    .replace(URL_HEAD_RE, '')
    .replace(/\/+$/, '');
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(/\s+/g, ' ').trim();
  if (HOST_PORT_RE.test(s)) s = '';
  if (ascii) s = s.replace(/[^\x21-\x7e]/g, '_');
  return Array.from(s).slice(0, AI_MODEL_MAX).join('');
}

/** 榜单 / 结算上的模型标记文本：「deepseek-flash · high」（没有档位时只有模型名） */
export function modelTagText(model: string | null | undefined, effort?: string | null): string {
  return [model, effort].filter((x) => !!x).join(' · ');
}

/** 校验 / 规范化 AI 标记 */
export function sanitizeAgentMeta(raw: unknown): Checked<AgentMeta> {
  const bad = (message: string): Checked<AgentMeta> => ({ ok: false, message });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('AI 标记无效');
  const a = raw as Record<string, unknown>;
  if (typeof a.provider !== 'string' || !AGENT_PROVIDER_RE.test(a.provider)) return bad('AI 标记无效（服务商）');
  if (typeof a.model !== 'string' || !AGENT_MODEL_RE.test(a.model)) return bad('AI 标记无效（模型）');
  const model = publicModelName(a.model, true);
  if (!model) return bad('AI 标记无效（模型）');
  if (a.effort !== undefined && a.effort !== null && !isAiEffort(a.effort)) return bad('AI 标记无效（思考档位）');
  if (a.role !== undefined && a.role !== 'player') return bad('只有「AI 玩家」的对局带 AI 参战标记');
  if (a.mode !== 'pause' && a.mode !== 'realtime') return bad('AI 标记无效（决策模式）');
  if (typeof a.botShare !== 'number' || !(a.botShare >= 0 && a.botShare <= 1)) return bad('AI 标记无效（兜底占比）');
  if (!Number.isSafeInteger(a.decisions) || (a.decisions as number) < 0 || (a.decisions as number) > 200_000)
    return bad('AI 标记无效（决策数）');
  if (a.tokens !== undefined && !(Number.isSafeInteger(a.tokens) && (a.tokens as number) >= 0)) return bad('AI 标记无效（token）');
  if (a.costUsd !== undefined && !(typeof a.costUsd === 'number' && a.costUsd >= 0 && a.costUsd <= 1e6)) return bad('AI 标记无效（费用）');
  // 内置策略本身就是机器人：占比恒为 1
  const scripted = a.provider === 'scripted';
  const botShare = scripted ? 1 : Math.round((a.botShare as number) * 1000) / 1000;
  return {
    ok: true,
    value: {
      provider: a.provider,
      model,
      ...(isAiEffort(a.effort) && !scripted ? { effort: a.effort } : {}),
      mode: a.mode,
      botShare,
      decisions: a.decisions as number,
      ...(a.tokens !== undefined ? { tokens: a.tokens as number } : {}),
      ...(a.costUsd !== undefined ? { costUsd: Math.round((a.costUsd as number) * 1e4) / 1e4 } : {}),
    },
  };
}

export const AI_MODEL_MAX = 80;

/** 校验「让 AI 替我玩」标记：只保留清洗过的模型名（≤ 80 字） */
export function sanitizeAiAssist(raw: unknown): Checked<AiAssistMeta> {
  const bad = (message: string): Checked<AiAssistMeta> => ({ ok: false, message });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('AI 辅助标记无效');
  const m = (raw as Record<string, unknown>).model;
  const b = (raw as Record<string, unknown>).botShare;
  const e = (raw as Record<string, unknown>).effort;
  if (b !== undefined && b !== null && !(typeof b === 'number' && b >= 0 && b <= 1)) return bad('AI 辅助标记无效（兜底占比）');
  if (e !== undefined && e !== null && !isAiEffort(e)) return bad('AI 辅助标记无效（思考档位）');
  const share = typeof b === 'number' ? { botShare: Math.round(b * 1000) / 1000 } : {};
  const effort = isAiEffort(e) ? { effort: e } : {};
  if (m === undefined || m === null || m === '') return { ok: true, value: { ...effort, ...share } };
  if (typeof m !== 'string' || m.length > 200) return bad('AI 辅助标记无效（模型）');
  const model = publicModelName(m);
  return { ok: true, value: { ...(model ? { model } : {}), ...effort, ...share } };
}

/** 兜底占比是否要在榜上标「兜底多」（内置策略 scripted 本身就是机器人，不标） */
export function isBotHeavy(botShare: number | null | undefined, provider?: string | null): boolean {
  return provider !== 'scripted' && typeof botShare === 'number' && botShare > AI_BOT_SHARE_FLAG;
}

/** 榜上的 AI 标记：provider 只用来判断是不是内置机器人，不放进返回值 */
export function agentBadge(a: Pick<AgentMeta, 'provider' | 'model' | 'mode' | 'botShare' | 'effort'>): AgentBadge {
  const scripted = a.provider === 'scripted';
  return {
    model: publicModelName(a.model) || a.model.slice(0, AI_MODEL_MAX),
    ...(isAiEffort(a.effort) && !scripted ? { effort: a.effort } : {}),
    ...(scripted ? { scripted: true } : {}),
    mode: a.mode,
    botShare: a.botShare,
    botAssisted: a.botShare > AI_BOT_SHARE_FLAG,
  };
}

/** 这局是不是参与排名的对局：无尽（非自定义参数、非固定布局）/ 每日挑战 / 战役 */
export function isRankedOpts(opts: Pick<RunOptions, 'mode' | 'custom' | 'events' | 'fixedLayout'>): boolean {
  if (opts.mode !== 'endless' && opts.mode !== 'campaign') return false;
  return !(opts.custom || opts.events || opts.fixedLayout);
}

/** 某局应进入的榜；dailyDay 非空表示这局是每日挑战；自定义模式返回 CUSTOM_BOARD（不排名） */
export function boardForOpts(opts: RunOptions, dailyDay?: string | null): string {
  if (!isRankedOpts(opts)) return CUSTOM_BOARD;
  if (opts.mode === 'campaign') return campaignBoardKey(opts.map);
  if (dailyDay) return dailyBoardKey(dailyDay);
  return ENDLESS_BOARD;
}

// 榜单名称文本。src/shared 不能依赖 i18n（Pages Functions 也会引用），用 stDef 注册 key + 简体中文回退；
// 浏览器里由 i18n 注入翻译（见 src/shared/text.ts）。
const BOARD_TEXT = {
  endless: stDef('core.board.endless', '无尽榜'),
  daily: stDef('core.board.daily', '每日挑战 {day}'),
  campaign: stDef('core.board.campaign', '战役 · {map}'),
  custom: stDef('core.board.custom', '自定义（不排名）'),
};
const MAP_TEXT: Record<MapId, () => string> = {
  ch1: stDef('data.map.ch1.name', '学生书桌'),
  ch2: stDef('data.map.ch2.name', '程序员工位'),
  ch3: stDef('data.map.ch3.name', '画师工作台'),
};

/** 榜的显示名（旧榜键按归一后的新榜显示） */
export function boardLabel(key: string): string {
  const b = parseBoard(normalizeBoardKey(key));
  if (!b) return key === CUSTOM_BOARD ? BOARD_TEXT.custom() : key;
  if (b.kind === 'daily') return BOARD_TEXT.daily({ day: b.day });
  if (b.kind === 'campaign') return BOARD_TEXT.campaign({ map: MAP_TEXT[b.map]() });
  return BOARD_TEXT.endless();
}

// ───────────────────────── 战役评星 ─────────────────────────

/** 评星：剩余生命 ≥90% 3 星，≥50% 2 星，通关 1 星（src/meta/progress 也用这一份） */
export function starsFor(lives: number, maxLives: number): number {
  if (maxLives <= 0) return 1;
  const r = lives / maxLives;
  if (r >= 0.9) return 3;
  if (r >= 0.5) return 2;
  return 1;
}

// ───────────────────────── 得分 ─────────────────────────

export function scoreMul(d: DifficultyId, abyssLevel?: number): number {
  return d === 'abyss' ? abyssParams(clampAbyss(abyssLevel)).scoreMul : PRESETS[d].scoreMul;
}

/** 与 core updateScore 完全相同的算式 */
export function computeScore(p: { cleared: number; kills: number; lives: number; gold: number; bonus: number }, mul: number): number {
  return Math.round((p.cleared * 100 + p.kills + p.lives * 50 + p.gold * 0.1 + p.bonus) * mul);
}

/**
 * 用声明的字段重算得分。返回错误信息（中文），通过返回 null。
 * - 带 cleared/bonus：精确比对；cleared 必须在 [wave-5, wave+1] 内，bonus ∈ [0, cleared×100 + kills]。
 * - 不带：cleared ∈ [max(0, wave-5), wave+1]、bonus ∈ [0, (wave+1)×100 + kills] 的区间校验。
 */
export function checkScore(r: ClaimedResult, mul: number): string | null {
  const lo = Math.max(0, r.wave - 5);
  const hi = r.wave + 1;
  if (r.cleared !== undefined || r.bonus !== undefined) {
    const cleared = r.cleared ?? r.wave;
    const bonus = r.bonus ?? 0;
    if (!isInt(cleared) || cleared < lo || cleared > hi) return '成绩数据不一致（波数）';
    if (!isNum(bonus) || bonus < 0 || bonus > cleared * 100 + r.kills) return '成绩数据不一致（加分）';
    if (computeScore({ cleared, kills: r.kills, lives: r.lives, gold: r.gold, bonus }, mul) !== r.score) return '成绩与结算数据不符';
    return null;
  }
  const min = computeScore({ cleared: lo, kills: r.kills, lives: r.lives, gold: r.gold, bonus: 0 }, mul);
  const max = computeScore({ cleared: hi, kills: r.kills, lives: r.lives, gold: r.gold, bonus: hi * 100 + r.kills }, mul);
  if (r.score < min || r.score > max) return '成绩与结算数据不符';
  return null;
}

// ───────────────────────── 每日挑战（北京时间） ─────────────────────────

export function isValidDay(day: unknown): day is string {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
}

/** 某个时刻在 UTC+8 的日期 YYYY-MM-DD */
export function dayOf(t: number | Date): string {
  const ms = typeof t === 'number' ? t : t.getTime();
  return new Date(ms + DAILY_TZ_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

/** 自 1970-01-01 起的天数 */
export function dayIndex(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function dailySeed(day: string): string {
  return `d${day.replace(/-/g, '')}${fnv1a(`desk-defense|daily|${day}`).toString(36).padStart(7, '0')}`;
}

/** 一周 7 天的难度轮换（与地图 3 天轮换叠加，21 天一个循环） */
export const DAILY_DIFFICULTY_ROTATION: readonly DifficultyId[] = ['normal', 'hard', 'normal', 'nightmare', 'hard', 'normal', 'hard'];

export function dailyInfo(day: string): DailyInfo {
  const idx = dayIndex(day);
  const map = MAPS[((idx % MAPS.length) + MAPS.length) % MAPS.length];
  const difficulty = DAILY_DIFFICULTY_ROTATION[((idx % 7) + 7) % 7];
  return { day, seed: dailySeed(day), map, difficulty, board: dailyBoardKey(day), pure: true, autoWave: true };
}

/** 当前可以提交的每日挑战日期（今天；零点后宽限期内还包括昨天） */
export function acceptedDailyDays(now: number): string[] {
  const today = dayOf(now);
  const yesterday = dayOf(now - DAILY_GRACE_MIN * 60_000);
  return yesterday === today ? [today] : [today, yesterday];
}

/** 每日挑战的开局参数：带入的技能由玩家选（最多 3 个，纯净模式没有第 4 槽） */
export function dailyRunOptions(info: DailyInfo, skills: SkillId[]): RunOptions {
  return {
    mode: 'endless',
    map: info.map,
    difficulty: info.difficulty,
    ...(info.abyssLevel ? { abyssLevel: info.abyssLevel } : {}),
    seed: info.seed,
    skills: skills.slice(0, 3),
    pure: true,
    autoWave: true,
  };
}

// ───────────────────────── 昵称 ─────────────────────────

/** 简单屏蔽词（小写、去空白/标点后做子串匹配）。只是第一道筛子，运营可在服务端追加。 */
// 保持两行：tests/i18n-data.test.ts 按行匹配 '管理员' / '傻逼' 白名单
// prettier-ignore
export const NICK_BLOCKLIST: readonly string[] = [
  'admin', 'administrator', '管理员', '官方', 'gm', 'fuck', 'shit', 'bitch', 'nigger', 'nigga',
  '傻逼', '煞笔', '沙比', 'sb', '操你', '草泥马', '你妈', '妈的', '去死', '共产党', '法轮', '习近平', '毛泽东',
];

// eslint-disable-next-line no-control-regex -- 有意匹配控制字符，用于清洗昵称
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff0-\uffff]/g;
const NORMALIZE_FOR_BLOCK_RE = /[\s\p{P}\p{S}_]/gu;

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

const NICK_TEXT = {
  empty: stDef('core.nick.empty', '请填写昵称'),
  tooLong: stDef('core.nick.tooLong', '昵称最多 {n} 个字'),
  blocked: stDef('core.nick.blocked', '昵称包含不合适的内容，换一个吧'),
};

export function sanitizeNickname(raw: unknown): Checked<string> {
  if (typeof raw !== 'string') return { ok: false, message: NICK_TEXT.empty() };
  if (raw.length > 64) return { ok: false, message: NICK_TEXT.tooLong({ n: NICK_MAX }) };
  const s = raw.normalize('NFKC').replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
  const len = Array.from(s).length;
  if (len < NICK_MIN) return { ok: false, message: NICK_TEXT.empty() };
  if (len > NICK_MAX) return { ok: false, message: NICK_TEXT.tooLong({ n: NICK_MAX }) };
  const flat = s.toLowerCase().replace(NORMALIZE_FOR_BLOCK_RE, '');
  for (const w of NICK_BLOCKLIST) {
    // 两个字母的短词（gm / sb）只在整名匹配时拦截，避免误伤
    if (w.length <= 2 && /^[a-z]+$/.test(w) ? flat === w : flat.includes(w)) return { ok: false, message: NICK_TEXT.blocked() };
  }
  return { ok: true, value: s };
}

// ───────────────────────── 提交校验 ─────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isDeviceId = (x: unknown): x is string => typeof x === 'string' && UUID_RE.test(x);

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isInt = (x: unknown): x is number => Number.isSafeInteger(x);
const inRange = (x: unknown, lo: number, hi: number): x is number => isNum(x) && x >= lo && x <= hi;
const intIn = (x: unknown, lo: number, hi: number): x is number => isInt(x) && x >= lo && x <= hi;

export function isValidSeed(s: unknown): s is string {
  // eslint-disable-next-line no-control-regex -- 种子不允许控制字符
  return typeof s === 'string' && s.length >= 1 && s.length <= SEED_MAX && !/[\u0000-\u001f\u007f]/.test(s);
}

/** 经过校验 / 规范化的提交（日志尚未解码） */
export interface CheckedSubmission {
  nickname: string;
  deviceId: string;
  /** 归一后的新榜键（旧客户端提交的旧榜键已映射） */
  board: string;
  parsedBoard: ParsedBoard;
  opts: RunOptions;
  seed: string;
  log: LogPayload;
  result: ClaimedResult;
  gameVersion: string;
  turnstileToken?: string;
  /** 每日挑战的日期（其他榜为 null） */
  day: string | null;
  /** 「AI 参战」的元数据；其他成绩为 null */
  agent: AgentMeta | null;
  /** AI 辅助（AI 参战或「让 AI 替我玩」）的成绩 */
  ai: boolean;
  /** AI 辅助时显示的模型名 */
  aiModel: string | null;
  /** AI 辅助时的思考档位 */
  aiEffort: AiEffort | null;
  /** 兜底机器人决策占比 0..1：AI 参战取 agent.botShare，接管过的 AI 辅助局取 aiAssist.botShare；未知为 null */
  botShare: number | null;
  /** 战役评星（失败 0）；无尽 / 每日恒为 0 */
  stars: number;
}

export interface SubmitContext {
  now: number;
  /** 服务端接受的版本，缺省为 [GAME_VERSION] */
  acceptVersions?: readonly string[];
}

const OPTS_KNOWN = new Set([
  'mode',
  'map',
  'difficulty',
  'abyssLevel',
  'seed',
  'skills',
  'skillLevels',
  'talents',
  'pure',
  'autoWave',
  'fixedLayout',
]);

/**
 * 只依赖请求体本身的轻量校验（schema / 版本 / 榜键与 opts 一致 / 种子规则 / 得分重算 / 结果合理性）。
 * 日志解码后的校验见 checkLog。
 */
export function checkSubmission(body: unknown, ctx: SubmitContext): Checked<CheckedSubmission> {
  const bad = (message: string): Checked<CheckedSubmission> => ({ ok: false, message });
  if (!isObj(body)) return bad('请求格式错误');

  const versions = ctx.acceptVersions ?? [GAME_VERSION];
  if (typeof body.gameVersion !== 'string' || !versions.includes(body.gameVersion)) {
    return bad('游戏版本已更新，请刷新页面后再提交成绩');
  }

  const nick = sanitizeNickname(body.nickname);
  if (!nick.ok) return bad(nick.message);
  if (!isDeviceId(body.deviceId)) return bad('设备标识无效');

  // ── AI 标记：所有榜都接受，只是成绩带「AI 辅助」标记 ──
  let agent: AgentMeta | null = null;
  if (body.agent !== undefined && body.agent !== null) {
    const a = sanitizeAgentMeta(body.agent);
    if (!a.ok) return bad(a.message);
    agent = a.value;
  }
  let assist: AiAssistMeta | null = null;
  if (body.aiAssist !== undefined && body.aiAssist !== null) {
    const a = sanitizeAiAssist(body.aiAssist);
    if (!a.ok) return bad(a.message);
    assist = a.value;
  }
  const ai = !!agent || !!assist;
  const aiModel = agent ? agent.model : (assist?.model ?? null);
  const aiEffort = (agent ? agent.effort : assist?.effort) ?? null;
  const botShare = agent ? agent.botShare : (assist?.botShare ?? null);

  const board = normalizeBoardKey(body.board);
  const parsedBoard = parseBoard(board);
  if (!board || !parsedBoard) return bad('排行榜不存在');

  // ── opts ──
  const o = body.opts;
  if (!isObj(o)) return bad('开局参数缺失');
  if (o.mode !== 'endless' && o.mode !== 'campaign') return bad('自定义模式不参与排行');
  const campaign = o.mode === 'campaign';
  if (!MAPS.includes(o.map as MapId)) return bad('地图无效');
  if (!DIFFICULTIES.includes(o.difficulty as DifficultyId)) return bad('难度无效');
  const difficulty = o.difficulty as DifficultyId;
  if (campaign && !(CAMPAIGN_DIFFICULTIES as readonly string[]).includes(difficulty)) return bad('战役难度无效');
  if (difficulty === 'abyss') {
    if (!intIn(o.abyssLevel, 1, ABYSS_MAX_LEVEL)) return bad('魔境等级无效');
  } else if (o.abyssLevel !== undefined) return bad('开局参数不一致（魔境等级）');
  if (o.custom !== undefined || o.events !== undefined) return bad('自定义参数的对局不参与排行');
  if (o.fixedLayout) return bad('固定布局的对局不参与排行');
  if (o.pure !== undefined && typeof o.pure !== 'boolean') return bad('开局参数无效（纯净）');
  if (o.autoWave !== undefined && typeof o.autoWave !== 'boolean') return bad('开局参数无效（自动开波）');
  const pure = o.pure === true;
  if (!Array.isArray(o.skills) || o.skills.length > (pure ? 3 : 4)) return bad('技能数量无效');
  if (new Set(o.skills).size !== o.skills.length || !o.skills.every((s) => SKILLS.includes(s as SkillId))) return bad('技能无效');
  if (o.skillLevels !== undefined) {
    if (!isObj(o.skillLevels)) return bad('技能等级无效');
    for (const [k, v] of Object.entries(o.skillLevels)) {
      if (!SKILLS.includes(k as SkillId) || !intIn(v, 1, 3)) return bad('技能等级无效');
    }
  }
  if (o.talents !== undefined) {
    if (!isObj(o.talents)) return bad('天赋无效');
    for (const [k, v] of Object.entries(o.talents)) {
      if (!TALENTS.includes(k as TalentId) || !intIn(v, 0, 10)) return bad('天赋无效');
    }
  }
  if (Object.keys(o).some((k) => !OPTS_KNOWN.has(k))) return bad('开局参数包含未知字段');

  // ── 种子 ──
  if (!isValidSeed(body.seed)) return bad('种子无效');
  if (o.seed !== body.seed) return bad('开局参数与种子不一致');
  const seed = body.seed;
  const dailySeedLike = /^d\d{8}[0-9a-z]{7}$/.test(seed);

  // ── 榜键一致性 / 每日挑战规则 ──
  let day: string | null = null;
  if (parsedBoard.kind === 'daily') {
    if (campaign) return bad('排行榜与开局参数不一致');
    day = parsedBoard.day;
    if (!acceptedDailyDays(ctx.now).includes(day)) return bad('这期每日挑战已经结束了');
    const info = dailyInfo(day);
    if (seed !== info.seed) return bad('每日挑战的种子不对');
    if (o.map !== info.map || difficulty !== info.difficulty || (o.abyssLevel ?? undefined) !== info.abyssLevel) {
      return bad('每日挑战的地图或难度不对');
    }
    if (!pure || o.autoWave !== true) return bad('每日挑战需要纯净模式 + 自动开波');
    if (o.skills.length > 3) return bad('技能数量无效');
    if (o.skillLevels && Object.values(o.skillLevels).some((v) => v !== 1)) return bad('每日挑战的技能等级固定为 1 级');
  } else if (parsedBoard.kind === 'campaign') {
    if (!campaign || parsedBoard.map !== o.map) return bad('排行榜与开局参数不一致');
  } else {
    if (campaign) return bad('排行榜与开局参数不一致');
    if (dailySeedLike) return bad('每日挑战的种子不能用于普通排行');
  }

  // ── 结果 ──
  const r = body.result;
  if (!isObj(r)) return bad('结算数据缺失');
  if (!intIn(r.wave, 0, campaign ? CAMPAIGN_TOTAL_WAVES : 10_000)) return bad('波数无效');
  if (!intIn(r.score, 0, 1e10)) return bad('得分无效');
  if (!intIn(r.kills, 0, (r.wave + 1) * 2000)) return bad('击杀数不合理');
  if (!intIn(r.lives, 0, 500)) return bad('剩余生命不合理');
  if (!inRange(r.gold, 0, 1e8)) return bad('金币数不合理');
  if (typeof r.won !== 'boolean') return bad('结算数据无效');
  if (r.won && !campaign) return bad('无尽模式没有胜利结算');
  if (!intIn(r.ticks, 0, MAX_RUN_SEC * TICKS_PER_SECOND)) return bad('对局时长不合理');
  if (r.ticks > (r.wave + 1) * MAX_SEC_PER_WAVE * TICKS_PER_SECOND) return bad('对局时长与波数不符');
  if (r.ticks < r.wave * MIN_SEC_PER_WAVE * TICKS_PER_SECOND) return bad('对局时长与波数不符');
  if (r.cleared !== undefined && !isInt(r.cleared)) return bad('结算数据无效');
  if (r.bonus !== undefined && !isNum(r.bonus)) return bad('结算数据无效');
  // 战役：通关 = 打满 20 波且还有生命；评星由「剩余生命 / 生命上限」算出
  let stars = 0;
  let maxLives: number | undefined;
  if (campaign) {
    if (r.won) {
      if (r.wave !== CAMPAIGN_TOTAL_WAVES || r.lives < 1) return bad('战役通关数据不一致');
      if (!intIn(r.maxLives, r.lives, 500)) return bad('生命上限不合理');
      maxLives = r.maxLives;
      stars = starsFor(r.lives, maxLives);
    } else if (r.wave >= CAMPAIGN_TOTAL_WAVES) return bad('战役失败时的波数不对');
    if (r.stars !== undefined && r.stars !== stars) return bad('评星与剩余生命不符');
  } else if (r.stars !== undefined && r.stars !== 0) return bad('只有战役有评星');
  const result: ClaimedResult = {
    wave: r.wave,
    score: r.score,
    kills: r.kills,
    lives: r.lives,
    gold: r.gold,
    won: r.won,
    ticks: r.ticks,
    ...(r.cleared !== undefined ? { cleared: r.cleared as number } : {}),
    ...(r.bonus !== undefined ? { bonus: r.bonus as number } : {}),
    ...(campaign ? { stars, ...(maxLives !== undefined ? { maxLives } : {}) } : {}),
  };
  const scoreErr = checkScore(result, scoreMul(difficulty, o.abyssLevel as number | undefined));
  if (scoreErr) return bad(scoreErr);

  // ── 日志载荷（只看形状和大小，解码在后面） ──
  const log = body.log;
  if (Array.isArray(log)) {
    if (log.length > LOG_MAX_ENTRIES) return bad('操作记录过长');
  } else if (isObj(log) && typeof log.gz === 'string') {
    if (log.gz.length === 0 || log.gz.length > LOG_MAX_GZ_CHARS) return bad('操作记录过长');
  } else return bad('操作记录缺失');

  if (body.turnstileToken !== undefined && (typeof body.turnstileToken !== 'string' || body.turnstileToken.length > 4096)) {
    return bad('人机验证数据无效');
  }

  const opts: RunOptions = JSON.parse(JSON.stringify(o)) as RunOptions;
  return {
    ok: true,
    value: {
      nickname: nick.value,
      deviceId: (body.deviceId as string).toLowerCase(),
      board,
      parsedBoard,
      opts,
      seed,
      log: log as LogPayload,
      result,
      gameVersion: body.gameVersion,
      ...(typeof body.turnstileToken === 'string' ? { turnstileToken: body.turnstileToken } : {}),
      day,
      agent,
      ai,
      aiModel,
      aiEffort,
      botShare,
      stars,
    },
  };
}

/**
 * 解码后的指令日志校验：形状、帧号单调、不晚于结束帧（游戏结束后没有指令）、
 * 数量与波数 / 时长相称、开波指令数量合理。
 */
export function checkLog(log: unknown, result: ClaimedResult, opts: RunOptions, o: { allowOverride?: boolean } = {}): Checked<LogEntry[]> {
  const bad = (message: string): Checked<LogEntry[]> => ({ ok: false, message });
  if (!Array.isArray(log)) return bad('操作记录格式错误');
  if (log.length > LOG_MAX_ENTRIES) return bad('操作记录过长');
  const maxCmds = Math.min(
    50 + (result.wave + 1) * MAX_CMDS_PER_WAVE,
    50 + Math.floor((result.ticks / TICKS_PER_SECOND) * MAX_CMDS_PER_SEC),
  );
  if (log.length > maxCmds) return bad('操作次数与对局时长不符');
  let prev = 0;
  let starts = 0;
  let overrides = 0;
  for (const e of log) {
    if (!isObj(e) || !isInt(e.tick) || !isObj(e.cmd) || typeof e.cmd.type !== 'string') return bad('操作记录格式错误');
    if (e.cmd.type === 'overrideWave' && o.allowOverride) {
      // AI 对战：进攻方改写下一波（每波最多一次；内容由 core 回放时校验，这里只看形状）
      const plan = e.cmd.plan;
      if (!intIn(e.cmd.wave, 1, 10_000) || !isObj(plan) || !Array.isArray(plan.groups) || plan.groups.length > 64)
        return bad('出题记录格式错误');
      if (++overrides > result.wave + 2) return bad('出题次数与波数不符');
    } else if (!COMMAND_TYPES.includes(e.cmd.type as (typeof COMMAND_TYPES)[number])) return bad('操作记录包含未知指令');
    if (e.tick < prev) return bad('操作记录的时间顺序错误');
    if (e.tick > result.ticks) return bad('游戏结束后不应再有操作');
    prev = e.tick;
    if (e.cmd.type === 'startWave') starts++;
  }
  if (result.wave >= 1 && starts < 1) return bad('操作记录与波数不符');
  // 手动开波：每一波都要玩家点开始（撑过 N 波至少开了 N 波）
  if (!effectiveAutoWave(opts) && starts < result.wave) return bad('操作记录与波数不符');
  return { ok: true, value: log as LogEntry[] };
}

// ───────────────────────── AI 对战榜（进攻方模型 vs 防守方模型） ─────────────────────────
//
// 独立于三类榜（不混进玩家 / AI 玩家的成绩）：POST /api/duels、GET /api/duels、GET /api/duels/:id，
// 存在 D1 的 duel_runs 表（migrations/0004）。每台设备每个「进攻模型+档位 × 防守模型+档位」组合保留最好的一条，
// 排序：通关（战役）↓ → 撑过的波数 ↓ → 得分 ↓ → 先提交 → id。
// 对外只有模型名 + 思考档位，不含渠道 / 服务商 / 地址。

export const DUEL_BOARD = 'duel';
/** 进攻方出题次数的上限（一局里） */
export const DUEL_MAX_PLANS = 10_000;

/** AI 对战里一方的上传数据 */
export interface DuelSideMeta {
  /** 模型名（publicModelName 清洗过） */
  model: string;
  effort?: AiEffort;
  /** 内置机器人（离线演示 / 脚本策略） */
  scripted?: boolean;
  /** 这一方的决策数 */
  decisions: number;
  /** 兜底机器人决策占比 0..1 */
  botShare: number;
  tokens?: number;
  costUsd?: number;
  /** 出错次数 */
  errors?: number;
}

export interface DuelMeta {
  attacker: DuelSideMeta;
  defender: DuelSideMeta;
  /** 进攻方实际改写了几波（overrideWave 条数） */
  plans?: number;
}

export interface DuelSubmitBody {
  nickname: string;
  deviceId: string;
  opts: RunOptions;
  seed: string;
  /** 含 overrideWave 的完整指令日志 */
  log: LogPayload;
  /** 防守方视角的结算（wave = 撑过的波数） */
  result: ClaimedResult;
  gameVersion: string;
  turnstileToken?: string;
  duel: DuelMeta;
}

/** 对战榜上一方的标记 */
export interface DuelSideBadge {
  model: string;
  effort?: AiEffort;
  scripted?: boolean;
  /** 兜底机器人决策占比超过 AI_BOT_SHARE_FLAG（内置机器人除外） */
  botHeavy?: boolean;
}

export interface DuelRow {
  rank: number;
  id: string;
  nickname: string;
  attacker: DuelSideBadge;
  defender: DuelSideBadge;
  mode: 'endless' | 'campaign';
  map: MapId;
  difficulty: DifficultyId;
  abyssLevel?: number;
  /** 防守方撑过的波数 */
  wave: number;
  score: number;
  kills: number;
  lives: number;
  /** 战役通关（防守方赢） */
  won: boolean;
  stars: number;
  /** 进攻方改写了几波 */
  plans: number;
  createdAt: number;
}

export interface DuelBoardResponse {
  board: typeof DUEL_BOARD;
  rows: DuelRow[];
  total: number;
  /** 传了 around=deviceId 时：本设备最好的一条（没有则 null） */
  me?: DuelRow | null;
  generatedAt: number;
}

export interface DuelDetail {
  id: string;
  nickname: string;
  opts: RunOptions;
  seed: string;
  logGz: string;
  result: ClaimedResult;
  gameVersion: string;
  createdAt: number;
  attacker: DuelSideBadge;
  defender: DuelSideBadge;
}

export interface CheckedDuel {
  nickname: string;
  deviceId: string;
  opts: RunOptions;
  seed: string;
  log: LogPayload;
  result: ClaimedResult;
  gameVersion: string;
  turnstileToken?: string;
  stars: number;
  duel: DuelMeta;
}

function sanitizeDuelSide(raw: unknown): DuelSideMeta | null {
  if (!isObj(raw)) return null;
  if (typeof raw.model !== 'string' || raw.model.length > 200) return null;
  const model = publicModelName(raw.model, true);
  if (!model) return null;
  if (raw.effort !== undefined && raw.effort !== null && !isAiEffort(raw.effort)) return null;
  if (raw.scripted !== undefined && typeof raw.scripted !== 'boolean') return null;
  if (!intIn(raw.decisions, 0, 200_000) || !inRange(raw.botShare, 0, 1)) return null;
  if (raw.tokens !== undefined && !intIn(raw.tokens, 0, 1e12)) return null;
  if (raw.costUsd !== undefined && !inRange(raw.costUsd, 0, 1e6)) return null;
  if (raw.errors !== undefined && !intIn(raw.errors, 0, 200_000)) return null;
  const scripted = raw.scripted === true;
  return {
    model,
    ...(isAiEffort(raw.effort) && !scripted ? { effort: raw.effort } : {}),
    ...(scripted ? { scripted: true } : {}),
    decisions: raw.decisions,
    botShare: scripted ? 1 : Math.round(raw.botShare * 1000) / 1000,
    ...(raw.tokens !== undefined ? { tokens: raw.tokens as number } : {}),
    ...(raw.costUsd !== undefined ? { costUsd: Math.round((raw.costUsd as number) * 1e4) / 1e4 } : {}),
    ...(raw.errors !== undefined ? { errors: raw.errors as number } : {}),
  };
}

/** 校验 AI 对战的元数据（未知字段一律丢掉，包括任何渠道 / 服务商信息） */
export function sanitizeDuelMeta(raw: unknown): Checked<DuelMeta> {
  const bad = (message: string): Checked<DuelMeta> => ({ ok: false, message });
  if (!isObj(raw)) return bad('对战数据缺失');
  const attacker = sanitizeDuelSide(raw.attacker);
  if (!attacker) return bad('对战数据无效（进攻方）');
  const defender = sanitizeDuelSide(raw.defender);
  if (!defender) return bad('对战数据无效（防守方）');
  if (raw.plans !== undefined && !intIn(raw.plans, 0, DUEL_MAX_PLANS)) return bad('对战数据无效（出题次数）');
  return { ok: true, value: { attacker, defender, ...(raw.plans !== undefined ? { plans: raw.plans as number } : {}) } };
}

/**
 * AI 对战成绩的轻量校验：开局参数 / 种子 / 结算 / 得分与普通成绩同一套（checkSubmission，按无尽或战役榜键），
 * 再加对战元数据。日志解码后用 checkLog(..., { allowOverride: true }) 校验（允许进攻方的 overrideWave）。
 */
export function checkDuelSubmission(body: unknown, ctx: SubmitContext): Checked<CheckedDuel> {
  const bad = (message: string): Checked<CheckedDuel> => ({ ok: false, message });
  if (!isObj(body)) return bad('请求格式错误');
  const d = sanitizeDuelMeta(body.duel);
  if (!d.ok) return bad(d.message);
  const o = body.opts;
  const board = isObj(o) && o.mode === 'campaign' && MAPS.includes(o.map as MapId) ? campaignBoardKey(o.map as MapId) : ENDLESS_BOARD;
  const { agent: _a, aiAssist: _b, duel: _d, ...rest } = body;
  void _a;
  void _b;
  void _d;
  const c = checkSubmission({ ...rest, board }, ctx);
  if (!c.ok) return bad(c.message);
  const v = c.value;
  return {
    ok: true,
    value: {
      nickname: v.nickname,
      deviceId: v.deviceId,
      opts: v.opts,
      seed: v.seed,
      log: v.log,
      result: v.result,
      gameVersion: v.gameVersion,
      ...(v.turnstileToken ? { turnstileToken: v.turnstileToken } : {}),
      stars: v.stars,
      duel: d.value,
    },
  };
}

/** 一方的上传数据 → 榜上标记 */
export function duelSideBadge(s: Pick<DuelSideMeta, 'model' | 'effort' | 'scripted' | 'botShare'>): DuelSideBadge {
  return {
    model: publicModelName(s.model) || s.model.slice(0, AI_MODEL_MAX),
    ...(isAiEffort(s.effort) && !s.scripted ? { effort: s.effort } : {}),
    ...(s.scripted ? { scripted: true } : {}),
    ...(isBotHeavy(s.botShare, s.scripted ? 'scripted' : null) ? { botHeavy: true } : {}),
  };
}
