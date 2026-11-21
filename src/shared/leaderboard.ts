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
export type _CheckCommands = Exhaustive<Exclude<Command['type'], (typeof COMMAND_TYPES)[number]>>;

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
  /** AI 对局标记（文档 10 §13）：带它的成绩只能进 `ai:` 榜，真人榜一律拒收 */
  agent?: AgentMeta;
}

/** AI 对局随成绩上传的元数据（不含任何 Key） */
export interface AgentMeta {
  /** claude-native / pi:ollama / bridge / scripted / mcp … */
  provider: string;
  model: string;
  /** 决策模式 */
  mode: 'pause' | 'realtime';
  /** 兜底机器人做的决策占比 0..1（内置策略 scripted 恒为 1） */
  botShare: number;
  /** 决策点总数 */
  decisions: number;
  tokens?: number;
  costUsd?: number;
}

/** 榜单上展示的 AI 标记 */
export interface AgentBadge {
  provider: string;
  model: string;
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
  status: RunStatus;
  /** 毫秒时间戳 */
  createdAt: number;
  /** 仅 AI 榜 */
  agent?: AgentBadge;
}

export interface LeaderboardResponse {
  board: string;
  rows: LeaderRow[];
  total: number;
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
  /** 仅 AI 榜 */
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

const clampAbyss = (n: number | undefined): number => Math.max(1, Math.min(ABYSS_MAX_LEVEL, Math.floor(n ?? 1) || 1));

/** 与 core world.ts 一致：未指定时除简单难度外默认自动开波 */
export function effectiveAutoWave(opts: Pick<RunOptions, 'autoWave' | 'difficulty'>): boolean {
  return opts.autoWave ?? opts.difficulty !== 'easy';
}

/** 难度键：easy / normal / hard / nightmare / abyss1..abyss10（同 src/meta/progress diffKey） */
export function diffKeyOf(d: DifficultyId, abyssLevel?: number): string {
  return d === 'abyss' ? `abyss${clampAbyss(abyssLevel)}` : d;
}

/** 无尽榜键：`<难度键>[:pure][:auto]`，与本地排行榜（progress.leaderKey）一致 */
export function endlessBoardKey(d: DifficultyId, abyssLevel: number | undefined, pure: boolean, auto: boolean): string {
  return `${diffKeyOf(d, abyssLevel)}${pure ? ':pure' : ''}${auto ? ':auto' : ''}`;
}

export const dailyBoardKey = (day: string): string => `daily:${day}`;

export type ParsedBoard =
  { kind: 'endless'; difficulty: DifficultyId; abyssLevel?: number; pure: boolean; auto: boolean } | { kind: 'daily'; day: string };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseBoard(key: unknown): ParsedBoard | null {
  if (typeof key !== 'string' || key.length > 40) return null;
  if (key.startsWith('daily:')) {
    const day = key.slice(6);
    return isValidDay(day) ? { kind: 'daily', day } : null;
  }
  const m = /^(easy|normal|hard|nightmare|abyss([1-9]|10))(:pure)?(:auto)?$/.exec(key);
  if (!m) return null;
  const pure = !!m[3];
  const auto = !!m[4];
  if (m[2]) return { kind: 'endless', difficulty: 'abyss', abyssLevel: Number(m[2]), pure, auto };
  return { kind: 'endless', difficulty: m[1] as DifficultyId, pure, auto };
}

// ── AI 榜（文档 10 §13）：键 = `ai:` + 无尽榜键；与真人榜完全隔离（parseBoard 不认 `ai:`） ──

export const AI_BOARD_PREFIX = 'ai:';
/** 兜底机器人决策占比超过这个值的 AI 成绩会被标注 */
export const AI_BOT_SHARE_FLAG = 0.2;

export const isAiBoardKey = (key: unknown): key is string => typeof key === 'string' && key.startsWith(AI_BOARD_PREFIX);

/** 解析 AI 榜键（只有无尽榜有 AI 版；每日挑战没有） */
export function parseAiBoard(key: unknown): Extract<ParsedBoard, { kind: 'endless' }> | null {
  if (!isAiBoardKey(key)) return null;
  const b = parseBoard(key.slice(AI_BOARD_PREFIX.length));
  return b && b.kind === 'endless' ? b : null;
}

export function aiEndlessBoardKey(d: DifficultyId, abyssLevel: number | undefined, pure: boolean, auto: boolean): string {
  return AI_BOARD_PREFIX + endlessBoardKey(d, abyssLevel, pure, auto);
}

const AGENT_PROVIDER_RE = /^[a-z0-9][a-z0-9:_.-]{0,39}$/;
const AGENT_MODEL_RE = /^[\x21-\x7e]{1,80}$/;

/** 校验 / 规范化 AI 标记 */
export function sanitizeAgentMeta(raw: unknown): Checked<AgentMeta> {
  const bad = (message: string): Checked<AgentMeta> => ({ ok: false, message });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('AI 标记无效');
  const a = raw as Record<string, unknown>;
  if (typeof a.provider !== 'string' || !AGENT_PROVIDER_RE.test(a.provider)) return bad('AI 标记无效（服务商）');
  if (typeof a.model !== 'string' || !AGENT_MODEL_RE.test(a.model)) return bad('AI 标记无效（模型）');
  if (a.role !== undefined && a.role !== 'player') return bad('只有「AI 玩家」的对局可以进入 AI 榜');
  if (a.mode !== 'pause' && a.mode !== 'realtime') return bad('AI 标记无效（决策模式）');
  if (typeof a.botShare !== 'number' || !(a.botShare >= 0 && a.botShare <= 1)) return bad('AI 标记无效（兜底占比）');
  if (!Number.isSafeInteger(a.decisions) || (a.decisions as number) < 0 || (a.decisions as number) > 200_000)
    return bad('AI 标记无效（决策数）');
  if (a.tokens !== undefined && !(Number.isSafeInteger(a.tokens) && (a.tokens as number) >= 0)) return bad('AI 标记无效（token）');
  if (a.costUsd !== undefined && !(typeof a.costUsd === 'number' && a.costUsd >= 0 && a.costUsd <= 1e6)) return bad('AI 标记无效（费用）');
  // 内置策略本身就是机器人：占比恒为 1
  const botShare = a.provider === 'scripted' ? 1 : Math.round((a.botShare as number) * 1000) / 1000;
  return {
    ok: true,
    value: {
      provider: a.provider,
      model: a.model,
      mode: a.mode,
      botShare,
      decisions: a.decisions as number,
      ...(a.tokens !== undefined ? { tokens: a.tokens as number } : {}),
      ...(a.costUsd !== undefined ? { costUsd: Math.round((a.costUsd as number) * 1e4) / 1e4 } : {}),
    },
  };
}

export function agentBadge(a: Pick<AgentMeta, 'provider' | 'model' | 'mode' | 'botShare'>): AgentBadge {
  return { provider: a.provider, model: a.model, mode: a.mode, botShare: a.botShare, botAssisted: a.botShare > AI_BOT_SHARE_FLAG };
}

/** 某局（无尽）应进入的榜；dailyDay 非空表示这局是每日挑战 */
export function boardForOpts(opts: RunOptions, dailyDay?: string | null): string {
  if (dailyDay) return dailyBoardKey(dailyDay);
  return endlessBoardKey(opts.difficulty, opts.abyssLevel, !!opts.pure, effectiveAutoWave(opts));
}

// 榜单名称文本。src/shared 不能依赖 i18n（Pages Functions 也会引用），用 stDef 注册 key + 简体中文回退；
// 浏览器里由 i18n 注入翻译（见 src/shared/text.ts）。
const BOARD_TEXT = {
  ai: stDef('core.board.ai', 'AI 榜 · {label}'),
  daily: stDef('core.board.daily', '每日挑战 {day}'),
  pure: stDef('core.board.pure', '纯净'),
  auto: stDef('core.board.auto', '自动开波'),
  manual: stDef('core.board.manual', '手动开波'),
  abyss: stDef('data.difficulty.abyssLevel', '魔境 {lv}'),
};
const DIFF_TEXT: Record<DifficultyId, () => string> = {
  easy: stDef('data.difficulty.easy', '简单'),
  normal: stDef('data.difficulty.normal', '普通'),
  hard: stDef('data.difficulty.hard', '困难'),
  nightmare: stDef('data.difficulty.nightmare', '噩梦'),
  abyss: stDef('data.difficulty.abyss', '魔境'),
};

export function boardLabel(key: string): string {
  if (isAiBoardKey(key)) return parseAiBoard(key) ? BOARD_TEXT.ai({ label: boardLabel(key.slice(AI_BOARD_PREFIX.length)) }) : key;
  const b = parseBoard(key);
  if (!b) return key;
  if (b.kind === 'daily') return BOARD_TEXT.daily({ day: b.day });
  const roman = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  const parts = [b.difficulty === 'abyss' ? BOARD_TEXT.abyss({ lv: roman[b.abyssLevel ?? 1] }) : DIFF_TEXT[b.difficulty]()];
  if (b.pure) parts.push(BOARD_TEXT.pure());
  parts.push(b.auto ? BOARD_TEXT.auto() : BOARD_TEXT.manual());
  return parts.join(' · ');
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
  board: string;
  parsedBoard: ParsedBoard;
  opts: RunOptions;
  seed: string;
  log: LogPayload;
  result: ClaimedResult;
  gameVersion: string;
  turnstileToken?: string;
  /** 每日挑战的日期（无尽榜为 null） */
  day: string | null;
  /** AI 榜的成绩才有；真人榜恒为 null */
  agent: AgentMeta | null;
}

export interface SubmitContext {
  now: number;
  /** 服务端接受的版本，缺省为 [GAME_VERSION] */
  acceptVersions?: readonly string[];
}

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

  // AI 标记与 AI 榜必须成对出现：带标记的成绩进不了真人榜，没有标记的成绩也进不了 AI 榜
  const hasAgent = body.agent !== undefined && body.agent !== null;
  const aiBoard = isAiBoardKey(body.board);
  if (hasAgent && !aiBoard) return bad('AI 对局的成绩只能提交到 AI 榜');
  if (aiBoard && !hasAgent) return bad('AI 榜只接受带 AI 标记的成绩');
  let agent: AgentMeta | null = null;
  if (hasAgent) {
    const a = sanitizeAgentMeta(body.agent);
    if (!a.ok) return bad(a.message);
    agent = a.value;
  }
  const parsedBoard: ParsedBoard | null = aiBoard ? parseAiBoard(body.board) : parseBoard(body.board);
  if (!parsedBoard) return bad('排行榜不存在');

  // ── opts ──
  const o = body.opts;
  if (!isObj(o)) return bad('开局参数缺失');
  if (o.mode !== 'endless') return bad('只有无尽模式（含每日挑战）可以上传成绩');
  if (!MAPS.includes(o.map as MapId)) return bad('地图无效');
  if (!DIFFICULTIES.includes(o.difficulty as DifficultyId)) return bad('难度无效');
  const difficulty = o.difficulty as DifficultyId;
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
  const known = new Set([
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
  if (Object.keys(o).some((k) => !known.has(k))) return bad('开局参数包含未知字段');

  // ── 种子 ──
  if (!isValidSeed(body.seed)) return bad('种子无效');
  if (o.seed !== body.seed) return bad('开局参数与种子不一致');
  const seed = body.seed;

  // ── 榜键一致性 / 每日挑战规则 ──
  let day: string | null = null;
  if (parsedBoard.kind === 'daily') {
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
  } else {
    if (/^d\d{8}[0-9a-z]{7}$/.test(seed)) return bad('每日挑战的种子不能用于普通排行');
    const expect = endlessBoardKey(
      difficulty,
      o.abyssLevel as number | undefined,
      pure,
      effectiveAutoWave({ autoWave: o.autoWave as boolean | undefined, difficulty }),
    );
    if ((aiBoard ? AI_BOARD_PREFIX : '') + expect !== body.board) return bad('排行榜与开局参数不一致');
  }

  // ── 结果 ──
  const r = body.result;
  if (!isObj(r)) return bad('结算数据缺失');
  if (!intIn(r.wave, 0, 10_000)) return bad('波数无效');
  if (!intIn(r.score, 0, 1e10)) return bad('得分无效');
  if (!intIn(r.kills, 0, (r.wave + 1) * 2000)) return bad('击杀数不合理');
  if (!intIn(r.lives, 0, 500)) return bad('剩余生命不合理');
  if (!inRange(r.gold, 0, 1e8)) return bad('金币数不合理');
  if (r.won !== false) return bad('无尽模式没有胜利结算');
  if (!intIn(r.ticks, 0, MAX_RUN_SEC * TICKS_PER_SECOND)) return bad('对局时长不合理');
  if (r.ticks > (r.wave + 1) * MAX_SEC_PER_WAVE * TICKS_PER_SECOND) return bad('对局时长与波数不符');
  if (r.ticks < r.wave * MIN_SEC_PER_WAVE * TICKS_PER_SECOND) return bad('对局时长与波数不符');
  if (r.cleared !== undefined && !isInt(r.cleared)) return bad('结算数据无效');
  if (r.bonus !== undefined && !isNum(r.bonus)) return bad('结算数据无效');
  const result: ClaimedResult = {
    wave: r.wave,
    score: r.score,
    kills: r.kills,
    lives: r.lives,
    gold: r.gold,
    won: false,
    ticks: r.ticks,
    ...(r.cleared !== undefined ? { cleared: r.cleared as number } : {}),
    ...(r.bonus !== undefined ? { bonus: r.bonus as number } : {}),
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
      board: body.board as string,
      parsedBoard,
      opts,
      seed,
      log: log as LogPayload,
      result,
      gameVersion: body.gameVersion,
      ...(typeof body.turnstileToken === 'string' ? { turnstileToken: body.turnstileToken } : {}),
      day,
      agent,
    },
  };
}

/**
 * 解码后的指令日志校验：形状、帧号单调、不晚于结束帧（游戏结束后没有指令）、
 * 数量与波数 / 时长相称、开波指令数量合理。
 */
export function checkLog(log: unknown, result: ClaimedResult, opts: RunOptions): Checked<LogEntry[]> {
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
  for (const e of log) {
    if (!isObj(e) || !isInt(e.tick) || !isObj(e.cmd) || typeof e.cmd.type !== 'string') return bad('操作记录格式错误');
    if (!COMMAND_TYPES.includes(e.cmd.type as Command['type'])) return bad('操作记录包含未知指令');
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
