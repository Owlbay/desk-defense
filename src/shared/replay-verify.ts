/**
 * 全服排行榜第二阶段：服务端回放校验（docs/12 §5.2）。纯逻辑，无 DOM / Node / Workers 专有 API。
 *
 * 给定「种子 + 开局参数 + 指令日志 + 客户端声明的结算」，用当前代码的确定性 core 以固定步长重放整局，
 * 比对结算是否一致：一致 → verified；不一致 / 日志无法复现 → rejected（带原因）。
 *
 * 共用方：
 *  - functions/_lib/admin.ts（POST /api/admin/verify，REPLAY_VERIFY=1 时才启用；只能 dynamic import，见那里的注释）
 *  - scripts/verify-runs.ts（Node / vite-node，处理本地 D1 导出的 pending 行）
 *  - tests/online/verify.test.ts
 *
 * reason 一律是英文短句（给运维看，服务端没有 i18n；界面只显示「未通过」）。
 * 回放规则与 src/meta/midrun.ts replayChunk 一致：在帧 t（state.tick === t）先按顺序执行所有 tick === t 的指令，再 step()。
 * 指令一律经 World.command() 下达（不认识具体指令类型；core 新增指令自动支持）。
 * 客户端日志里只有执行成功的指令，所以回放时任何一条指令失败都说明日志与这份代码对不上 → rejected。
 *
 * 注意：src/shared/leaderboard.ts 只允许 `import type` core；这个模块会把整个 core 打进去，
 * 所以浏览器包不要引用它。
 */
import { createWorld, stateHash } from '../core';
import type { IWorld, RunOptions } from '../core/types';
import { decodeLogPayload } from './codec';
import { type ClaimedResult, type LogEntry, MAX_RUN_SEC, starsFor, TICKS_PER_SECOND } from './leaderboard';

export interface VerifyInput {
  opts: RunOptions;
  seed: string;
  log: readonly LogEntry[];
  result: ClaimedResult;
}

/** 回放出来的结算 */
export interface ReplayedResult {
  wave: number;
  /** 撑过的波数（与客户端结算同口径：通关 = wave，失败 = wave - 1） */
  wavesSurvived: number;
  score: number;
  kills: number;
  lives: number;
  maxLives: number;
  gold: number;
  phase: string;
  ticks: number;
  /** stateHash，排查用 */
  hash: string;
}

export type RejectCode =
  'bad_input' | 'log_order' | 'log_after_end' | 'command_failed' | 'perk_stuck' | 'ended_early' | 'too_long' | 'mismatch' | 'replay_error';

export type VerifyOutcome =
  { status: 'verified'; replayed: ReplayedResult } | { status: 'rejected'; code: RejectCode; reason: string; replayed?: ReplayedResult };

export interface VerifyOptions {
  /** 回放步数上限（缺省 = 12 小时，与提交校验的 MAX_RUN_SEC 一致） */
  maxTicks?: number;
  /** 测试注入 */
  createWorld?: (opts: RunOptions) => IWorld;
}

const reject = (code: RejectCode, reason: string, replayed?: ReplayedResult): VerifyOutcome => ({
  status: 'rejected',
  code,
  reason,
  ...(replayed ? { replayed } : {}),
});

function snapshot(w: IWorld): ReplayedResult {
  const s = w.state;
  return {
    wave: s.wave,
    wavesSurvived: s.phase === 'won' ? s.wave : Math.max(0, s.wave - 1),
    score: Math.round(s.score),
    kills: s.stats.kills,
    lives: s.lives,
    maxLives: s.maxLives,
    gold: s.gold,
    phase: s.phase,
    ticks: s.tick,
    hash: stateHash(w),
  };
}

const sameNum = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/** 比对声明结算与回放结算；返回第一处不一致的说明，一致返回 null */
export function compareResult(claimed: ClaimedResult, r: ReplayedResult, opts: Pick<RunOptions, 'mode'>): string | null {
  const diffs: string[] = [];
  const chk = (name: string, c: number, v: number) => {
    if (!sameNum(c, v)) diffs.push(`${name} claimed ${c} replayed ${v}`);
  };
  chk('ticks', claimed.ticks, r.ticks);
  chk('score', Math.round(claimed.score), r.score);
  chk('kills', claimed.kills, r.kills);
  chk('lives', claimed.lives, r.lives);
  chk('gold', claimed.gold, r.gold);
  const won = r.phase === 'won';
  if (claimed.won !== won) diffs.push(`won claimed ${claimed.won} replayed ${won}`);
  if (r.phase === 'won' || r.phase === 'lost') chk('wave', claimed.wave, r.wavesSurvived);
  // 没结束的局（理论上不会上传）：声明的波数只能是当前波或上一波
  else if (claimed.wave !== r.wave && claimed.wave !== Math.max(0, r.wave - 1))
    diffs.push(`wave claimed ${claimed.wave} replayed ${r.wave}`);
  if (opts.mode === 'campaign') {
    const maxLives = Math.max(r.lives, r.maxLives);
    const stars = won ? starsFor(r.lives, maxLives) : 0;
    if (claimed.stars !== undefined) chk('stars', claimed.stars, stars);
    if (won && claimed.maxLives !== undefined) chk('maxLives', claimed.maxLives, maxLives);
  }
  return diffs.length ? diffs.join(', ') : null;
}

/**
 * 重放并校验一局。永不抛异常（core 抛错时返回 replay_error）。
 * CPU：与对局长度成正比（开发机上每 1 万帧约几十 ms）——免费计划的 10 ms 不够，见 docs/12 §5.2。
 */
export function verifyRun(input: VerifyInput, o: VerifyOptions = {}): VerifyOutcome {
  const { log, result } = input;
  if (!input.opts || typeof input.opts !== 'object') return reject('bad_input', 'missing opts');
  if (!Array.isArray(log)) return reject('bad_input', 'log is not an array');
  if (!result || !Number.isSafeInteger(result.ticks) || result.ticks < 0) return reject('bad_input', 'result.ticks missing');
  const maxTicks = o.maxTicks ?? MAX_RUN_SEC * TICKS_PER_SECOND;
  if (result.ticks > maxTicks) return reject('too_long', `ticks ${result.ticks} > ${maxTicks}`);
  let prev = 0;
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (!e || !Number.isSafeInteger(e.tick) || !e.cmd || typeof e.cmd !== 'object') return reject('bad_input', `entry #${i + 1} malformed`);
    if (e.tick < prev) return reject('log_order', `entry #${i + 1} tick goes backwards (${e.tick} < ${prev})`);
    if (e.tick > result.ticks) return reject('log_after_end', `entry #${i + 1} after end tick (${e.tick} > ${result.ticks})`);
    prev = e.tick;
  }

  let w: IWorld;
  let next = 0;
  try {
    w = (o.createWorld ?? createWorld)({ ...input.opts, seed: input.seed });
    let steps = 0;
    for (;;) {
      const t = w.state.tick;
      while (next < log.length && log[next].tick <= t) {
        const r = w.command(log[next].cmd);
        if (!r.ok) {
          return reject(
            'command_failed',
            `entry #${next + 1} (${String((log[next].cmd as { type?: unknown }).type)} @${t}) failed: ${r.code ?? '?'}`,
            snapshot(w),
          );
        }
        next++;
      }
      const ph = w.state.phase;
      if (t >= result.ticks || ph === 'won' || ph === 'lost') break;
      if (ph === 'perk') {
        // 选增益阶段逻辑不前进：下一条指令（应当是选增益）却在更晚的帧 → 日志对不上
        return reject(
          'perk_stuck',
          `stuck in perk phase at tick ${t}, next command at ${next < log.length ? log[next].tick : 'none'}`,
          snapshot(w),
        );
      }
      w.step();
      if ((++steps & 1023) === 0) w.drainEvents();
    }
    w.drainEvents();
  } catch (e) {
    return reject('replay_error', `replay threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  const replayed = snapshot(w);
  if (next < log.length) {
    return reject(
      'ended_early',
      `run ended at tick ${replayed.ticks} (${replayed.phase}) with ${log.length - next} commands left`,
      replayed,
    );
  }
  const diff = compareResult(result, replayed, input.opts);
  if (diff) return reject('mismatch', diff, replayed);
  return { status: 'verified', replayed };
}

/** runs 表里校验需要的列（D1 行 / wrangler d1 导出的 JSON 行都是这个形状） */
export interface StoredRun {
  id?: string;
  seed: string;
  opts_json: string;
  result_json: string;
  log_gz: string;
}

/** 解开存储格式（JSON 文本 + gzip/base64 日志）再校验。永不抛异常。 */
export async function verifyStoredRun(row: StoredRun, o: VerifyOptions = {}): Promise<VerifyOutcome> {
  let input: VerifyInput;
  try {
    const decoded = await decodeLogPayload({ gz: row.log_gz });
    input = {
      seed: row.seed,
      opts: JSON.parse(row.opts_json) as RunOptions,
      result: JSON.parse(row.result_json) as ClaimedResult,
      log: decoded.log as LogEntry[],
    };
  } catch (e) {
    return reject('bad_input', `stored row unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  return verifyRun(input, o);
}

/** 写进 runs.reject_reason 的文本（≤ 300 字符；英文，给运维看） */
export const rejectReasonText = (v: Extract<VerifyOutcome, { status: 'rejected' }>): string => `${v.code}: ${v.reason}`.slice(0, 300);
