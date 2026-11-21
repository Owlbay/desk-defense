import { describe, expect, it } from 'vitest';

import { resolveParams } from '../../src/core/scaling';
import type { DifficultyId, RunOptions } from '../../src/core/types';
import { diffKey, leaderKey, runAutoWave } from '../../src/meta/progress';
import { decodeLogPayload, encodeLog, gzipJsonBase64 } from '../../src/shared/codec';
import {
  acceptedDailyDays,
  boardForOpts,
  boardLabel,
  checkLog,
  checkScore,
  checkSubmission,
  type ClaimedResult,
  computeScore,
  DAILY_GRACE_MIN,
  dailyBoardKey,
  dailyInfo,
  dailyRunOptions,
  dailySeed,
  dayOf,
  effectiveAutoWave,
  endlessBoardKey,
  GAME_VERSION,
  isValidDay,
  LOG_MAX_RAW_BYTES,
  parseBoard,
  sanitizeNickname,
  scoreMul,
  type SubmitBody,
} from '../../src/shared/leaderboard';
import { playRun } from './helpers';

const SKILLS: RunOptions['skills'] = ['eraser_strike', 'bell', 'whiteout_zone'];
const DEVICE = '0b6f6a4e-3c1d-4a8e-9f00-1234567890ab';
const NOW = Date.parse('2026-11-20T04:00:00Z'); // 北京时间 12:00

function baseOpts(extra: Partial<RunOptions> = {}): RunOptions {
  return { mode: 'endless', map: 'ch1', difficulty: 'normal', seed: 'abc123', skills: SKILLS, autoWave: true, ...extra };
}

function bodyFor(opts: RunOptions, result: ClaimedResult, extra: Partial<SubmitBody> = {}): SubmitBody {
  return {
    nickname: '小明',
    deviceId: DEVICE,
    board: boardForOpts(opts),
    opts,
    seed: opts.seed!,
    log: [{ tick: 0, cmd: { type: 'startWave' } }],
    result,
    gameVersion: GAME_VERSION,
    ...extra,
  };
}

describe('排行榜键', () => {
  it('与本地排行榜 leaderKey 一致', () => {
    const diffs: DifficultyId[] = ['easy', 'normal', 'hard', 'nightmare', 'abyss'];
    for (const d of diffs) {
      for (const lvl of [1, 3, 10]) {
        for (const pure of [false, true]) {
          for (const auto of [false, true]) {
            const k = endlessBoardKey(d, lvl, pure, auto);
            expect(k).toBe(leaderKey(diffKey(d, lvl), pure, auto));
            const p = parseBoard(k);
            expect(p).toMatchObject({ kind: 'endless', difficulty: d, pure, auto });
            if (d === 'abyss') expect(p).toMatchObject({ abyssLevel: lvl });
          }
        }
      }
    }
  });

  it('自动开波默认值与 core 一致；显式设置时与 progress.runAutoWave 一致', () => {
    expect(effectiveAutoWave({ difficulty: 'easy' })).toBe(false);
    expect(effectiveAutoWave({ difficulty: 'hard' })).toBe(true);
    expect(effectiveAutoWave({ difficulty: 'hard', autoWave: false })).toBe(false);
    expect(effectiveAutoWave(baseOpts({ autoWave: true }))).toBe(runAutoWave(baseOpts({ autoWave: true })));
    expect(boardForOpts(baseOpts({ difficulty: 'abyss', abyssLevel: 4, pure: true, autoWave: true }))).toBe('abyss4:pure:auto');
    expect(boardForOpts(baseOpts(), '2026-11-20')).toBe('daily:2026-11-20');
  });

  it('拒绝非法榜键', () => {
    for (const k of ['', 'custom', 'abyss0', 'abyss11', 'normal:auto:pure', 'daily:2026-13-01', 'daily:x', 'normal;drop', 42]) {
      expect(parseBoard(k)).toBeNull();
    }
    expect(parseBoard('daily:2026-02-28')).toEqual({ kind: 'daily', day: '2026-02-28' });
    expect(boardLabel('abyss3:pure:auto')).toBe('魔境 III · 纯净 · 自动开波');
    expect(boardLabel('daily:2026-11-20')).toBe('每日挑战 2026-11-20');
  });
});

describe('得分重算', () => {
  it('倍率与 core resolveParams 同源', () => {
    for (const d of ['easy', 'normal', 'hard', 'nightmare'] as const)
      expect(scoreMul(d)).toBe(resolveParams(baseOpts({ difficulty: d })).scoreMul);
    for (let l = 1; l <= 10; l++)
      expect(scoreMul('abyss', l)).toBe(resolveParams(baseOpts({ difficulty: 'abyss', abyssLevel: l })).scoreMul);
  });

  it('真实对局：精确校验与区间校验都通过', () => {
    for (const d of ['normal', 'hard'] as const) {
      const run = playRun(baseOpts({ difficulty: d, seed: `s-${d}` }));
      const mul = scoreMul(d);
      expect(
        computeScore(
          { cleared: run.cleared, kills: run.result.kills, lives: run.result.lives, gold: run.result.gold, bonus: run.bonus },
          mul,
        ),
      ).toBe(run.result.score);
      expect(checkScore({ ...run.result, cleared: run.cleared, bonus: run.bonus }, mul)).toBeNull();
      expect(checkScore(run.result, mul)).toBeNull();
    }
  });

  it('拒绝不一致的得分', () => {
    const r: ClaimedResult = { wave: 10, score: 0, kills: 120, lives: 5, gold: 300, won: false, ticks: 60 * 600 };
    r.score = computeScore({ cleared: 10, kills: 120, lives: 5, gold: 300, bonus: 0 }, 1.5);
    expect(checkScore({ ...r, cleared: 10, bonus: 0 }, 1.5)).toBeNull();
    expect(checkScore({ ...r, cleared: 10, bonus: 0, score: r.score + 1 }, 1.5)).not.toBeNull();
    expect(checkScore({ ...r, cleared: 30, bonus: 0 }, 1.5)).not.toBeNull();
    expect(checkScore(r, 1.5)).toBeNull();
    expect(checkScore({ ...r, score: r.score * 10 }, 1.5)).not.toBeNull();
    expect(checkScore({ ...r, score: 10 }, 1.5)).not.toBeNull();
  });
});

describe('每日挑战', () => {
  it('按北京时间换日', () => {
    expect(dayOf(Date.parse('2026-11-19T15:59:59Z'))).toBe('2026-11-19');
    expect(dayOf(Date.parse('2026-11-19T16:00:00Z'))).toBe('2026-11-20');
  });

  it('确定性、轮换、种子唯一', () => {
    const a = dailyInfo('2026-11-20');
    expect(dailyInfo('2026-11-20')).toEqual(a);
    expect(a.seed).toBe(dailySeed('2026-11-20'));
    expect(a.board).toBe(dailyBoardKey('2026-11-20'));
    const seeds = new Set<string>();
    const maps = new Set<string>();
    const diffs = new Set<string>();
    for (let i = 0; i < 21; i++) {
      const day = new Date(Date.parse('2026-11-01T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10);
      const info = dailyInfo(day);
      seeds.add(info.seed);
      maps.add(info.map);
      diffs.add(info.difficulty);
      expect(info.seed).toMatch(/^d\d{8}[0-9a-z]{7}$/);
    }
    expect(seeds.size).toBe(21);
    expect(maps.size).toBe(3);
    expect(diffs.size).toBeGreaterThanOrEqual(3);
  });

  it('零点宽限期', () => {
    const midnight = Date.parse('2026-11-19T16:00:00Z'); // 北京时间 11-20 00:00
    expect(acceptedDailyDays(midnight + 60_000)).toEqual(['2026-11-20', '2026-11-19']);
    expect(acceptedDailyDays(midnight + (DAILY_GRACE_MIN + 1) * 60_000)).toEqual(['2026-11-20']);
  });

  it('日期校验', () => {
    expect(isValidDay('2026-02-29')).toBe(false);
    expect(isValidDay('2028-02-29')).toBe(true);
  });
});

describe('昵称', () => {
  it('清理控制字符与空白、限制长度', () => {
    expect(sanitizeNickname('  小\u0000明​  ')).toEqual({ ok: true, value: '小明' });
    expect(sanitizeNickname('Ａｂｃ')).toEqual({ ok: true, value: 'Abc' });
    expect(sanitizeNickname('一二三四五六七八九十一二').ok).toBe(true);
    expect(sanitizeNickname('一二三四五六七八九十一二三').ok).toBe(false);
    expect(sanitizeNickname('   ').ok).toBe(false);
    expect(sanitizeNickname(42).ok).toBe(false);
  });

  it('屏蔽词', () => {
    expect(sanitizeNickname('傻 逼').ok).toBe(false);
    expect(sanitizeNickname('ADMIN').ok).toBe(false);
    expect(sanitizeNickname('SB').ok).toBe(false);
    expect(sanitizeNickname('Sbeve').ok).toBe(true); // 两字母词只拦整名
  });
});

describe('提交校验', () => {
  const run = playRun(baseOpts());
  const good = (): SubmitBody => ({ ...bodyFor(run.opts, run.result), log: run.log });

  it('真实对局通过', () => {
    const r = checkSubmission(good(), { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(checkLog(run.log, r.value.result, r.value.opts).ok).toBe(true);
  });

  it.each([
    ['版本不符', (b: SubmitBody) => ({ ...b, gameVersion: '0.0.0+c0' }), '版本'],
    ['榜键与 opts 不一致', (b: SubmitBody) => ({ ...b, board: 'hard:auto' }), '不一致'],
    ['自定义模式', (b: SubmitBody) => ({ ...b, opts: { ...b.opts, mode: 'custom' } }), '无尽'],
    ['自定义参数', (b: SubmitBody) => ({ ...b, opts: { ...b.opts, custom: { lives: 999 } } }), '自定义'],
    ['种子不一致', (b: SubmitBody) => ({ ...b, seed: 'other' }), '种子'],
    ['胜利', (b: SubmitBody) => ({ ...b, result: { ...b.result, won: true } }), '胜利'],
    ['得分被改', (b: SubmitBody) => ({ ...b, result: { ...b.result, score: b.result.score + 5000 } }), '不符'],
    ['时长过短', (b: SubmitBody) => ({ ...b, result: { ...b.result, wave: 50, score: 99999, ticks: 600 } }), ''],
    ['未知字段', (b: SubmitBody) => ({ ...b, opts: { ...b.opts, cheat: 1 } as RunOptions }), '未知'],
    ['技能重复', (b: SubmitBody) => ({ ...b, opts: { ...b.opts, skills: ['bell', 'bell'] } }), '技能'],
    ['设备 id', (b: SubmitBody) => ({ ...b, deviceId: 'abc' }), '设备'],
    [
      '每日种子用于普通榜',
      (b: SubmitBody) => ({ ...b, seed: dailySeed('2026-11-20'), opts: { ...b.opts, seed: dailySeed('2026-11-20') } }),
      '每日',
    ],
    ['日志过大', (b: SubmitBody) => ({ ...b, log: { gz: 'x'.repeat(200_000) } }), '过长'],
  ])('%s', (_name, mut, msg) => {
    const r = checkSubmission(mut(good()), { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(msg);
  });

  it('每日挑战规则', () => {
    const info = dailyInfo('2026-11-20');
    const opts = dailyRunOptions(info, SKILLS);
    const d = playRun(opts);
    const body: SubmitBody = { ...bodyFor(d.opts, d.result), board: info.board, log: d.log };
    expect(checkSubmission(body, { now: NOW }).ok).toBe(true);
    // 过期
    expect(checkSubmission(body, { now: NOW + 2 * 86_400_000 }).ok).toBe(false);
    // 非纯净
    expect(checkSubmission({ ...body, opts: { ...body.opts, pure: false } }, { now: NOW }).ok).toBe(false);
    // 换种子
    expect(checkSubmission({ ...body, seed: 'zzz', opts: { ...body.opts, seed: 'zzz' } }, { now: NOW }).ok).toBe(false);
    // 技能升级
    expect(checkSubmission({ ...body, opts: { ...body.opts, skillLevels: { bell: 3 } } }, { now: NOW }).ok).toBe(false);
  });

  it('日志合理性', () => {
    const r: ClaimedResult = { ...run.result };
    expect(
      checkLog(
        [
          { tick: 5, cmd: { type: 'startWave' } },
          { tick: 3, cmd: { type: 'startWave' } },
        ],
        r,
        run.opts,
      ).ok,
    ).toBe(false);
    expect(checkLog([{ tick: r.ticks + 1, cmd: { type: 'startWave' } }], r, run.opts).ok).toBe(false);
    expect(checkLog([{ tick: 0, cmd: { type: 'godMode' } }], r, run.opts).ok).toBe(false);
    expect(checkLog([], { ...r, wave: 3 }, run.opts).ok).toBe(false);
    // 手动开波：撑过 N 波至少要 N 次开波
    expect(checkLog([{ tick: 0, cmd: { type: 'startWave' } }], { ...r, wave: 3 }, { ...run.opts, autoWave: false }).ok).toBe(false);
    // 指令过密
    const spam = Array.from({ length: 5000 }, () => ({ tick: 0, cmd: { type: 'rerollPerks' as const } }));
    expect(checkLog(spam, r, run.opts).ok).toBe(false);
  });
});

describe('日志编解码', () => {
  it('gzip 往返', async () => {
    const log = Array.from({ length: 500 }, (_, i) => ({
      tick: i * 10,
      cmd: { type: 'place' as const, tower: 'pencil' as const, cx: i % 20, cy: 3 },
    }));
    const p = await encodeLog(log);
    expect(Array.isArray(p)).toBe(false);
    const { log: back, rawBytes } = await decodeLogPayload(p);
    expect(back).toEqual(log);
    expect(rawBytes).toBe(JSON.stringify(log).length);
  });

  it('解压炸弹被截断', async () => {
    const huge = 'a'.repeat(LOG_MAX_RAW_BYTES * 3);
    const gz = await gzipJsonBase64(huge);
    expect(gz.length).toBeLessThan(10_000);
    await expect(decodeLogPayload({ gz })).rejects.toThrow('too_large');
    await expect(decodeLogPayload({ gz: '!!!notbase64' })).rejects.toThrow('bad_log');
  });
});
