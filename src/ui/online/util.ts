/**
 * 在线功能的纯函数（无 DOM、无网络），便于单测。
 */
import type { Command, RunOptions } from '../../core/types';
import { getLocale } from '../../i18n';
import { boardForOpts, DAILY_TZ_OFFSET_MIN, dailyInfo, isValidDay, sanitizeNickname } from '../../shared/leaderboard';

const DAILY_SEED_RE = /^d(\d{4})(\d{2})(\d{2})[0-9a-z]{7}$/;

/** 这局是不是每日挑战：返回日期（YYYY-MM-DD），否则 null */
export function dailyDayOfOpts(opts: Pick<RunOptions, 'mode' | 'seed' | 'map' | 'difficulty' | 'pure'>): string | null {
  if (opts.mode !== 'endless' || !opts.seed) return null;
  const m = DAILY_SEED_RE.exec(opts.seed);
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  if (!isValidDay(day)) return null;
  const info = dailyInfo(day);
  if (info.seed !== opts.seed || info.map !== opts.map || info.difficulty !== opts.difficulty || !opts.pure) return null;
  return day;
}

/** 可以上传到全服榜的对局：无尽（非自定义、非固定布局）或每日挑战 */
export function isEligibleRun(opts: RunOptions): boolean {
  if (opts.mode !== 'endless') return false;
  if (opts.custom || opts.events || opts.fixedLayout) return false;
  if (!opts.seed) return false;
  return true;
}

/** 这局应进入的榜键 */
export function boardOfRun(opts: RunOptions): string {
  return boardForOpts(opts, dailyDayOfOpts(opts));
}

/** 距离下一个北京时间零点的毫秒数 */
export function msUntilNextDay(now: number): number {
  const off = DAILY_TZ_OFFSET_MIN * 60_000;
  const local = now + off;
  const next = (Math.floor(local / 86_400_000) + 1) * 86_400_000;
  return next - local;
}

/** 12:03:09 */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** 昵称校验：返回错误信息或 null */
export function nicknameError(raw: string): string | null {
  const r = sanitizeNickname(raw);
  return r.ok ? null : r.message;
}

/** 按当前语言格式化的「月-日 时:分」，例如 11/20 14:05 */
export function fmtTime(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  return new Intl.DateTimeFormat(getLocale(), {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/** 存档里的日期（YYYY-MM-DD）按当前语言显示；格式不对就原样返回 */
export function fmtDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Intl.DateTimeFormat(getLocale(), { year: 'numeric', month: 'numeric', day: 'numeric' }).format(d);
}

/** 回放驱动：world.step 前执行该帧的指令（与 midrun.replayChunk 同规则） */
export interface ReplayFeeder {
  /** 执行所有 tick <= 当前帧 的指令 */
  feed(): void;
  readonly done: boolean;
  readonly next: number;
}

export function makeFeeder(
  world: { state: { tick: number }; command(c: Command): unknown },
  log: readonly { tick: number; cmd: Command }[],
): ReplayFeeder {
  let next = 0;
  return {
    feed() {
      const t = world.state.tick;
      while (next < log.length && log[next].tick <= t) {
        try {
          world.command(log[next].cmd);
        } catch (e) {
          console.warn('[replay] command failed', e);
        }
        next++;
      }
    },
    get done() {
      return next >= log.length;
    },
    get next() {
      return next;
    },
  };
}
