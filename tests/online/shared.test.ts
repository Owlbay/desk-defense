import { describe, expect, it } from 'vitest';

import { CAMPAIGN_WAVES } from '../../src/config/campaign';
import { resolveParams } from '../../src/core/scaling';
import type { DifficultyId, RunOptions } from '../../src/core/types';
import { runAutoWave, starsFor as progressStars } from '../../src/meta/progress';
import { decodeLogPayload, encodeLog, gzipJsonBase64 } from '../../src/shared/codec';
import {
  acceptedDailyDays,
  boardForOpts,
  boardLabel,
  CAMPAIGN_TOTAL_WAVES,
  campaignBoardKey,
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
  ENDLESS_BOARD,
  GAME_VERSION,
  isValidDay,
  LOG_MAX_RAW_BYTES,
  normalizeBoardKey,
  parseBoard,
  sanitizeNickname,
  scoreMul,
  starsFor,
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
  it('只有三类榜：endless / daily:<日期> / campaign:<章节>', () => {
    expect(parseBoard('endless')).toEqual({ kind: 'endless' });
    expect(parseBoard('daily:2026-02-28')).toEqual({ kind: 'daily', day: '2026-02-28' });
    expect(parseBoard('campaign:ch2')).toEqual({ kind: 'campaign', map: 'ch2' });
    for (const k of ['', 'custom', 'campaign:ch9', 'normal', 'abyss3:pure:auto', 'ai:normal', 'daily:2026-13-01', 'daily:x', 42]) {
      expect(parseBoard(k)).toBeNull();
    }
  });

  it('旧榜键（难度 / 纯净 / 开波方式 / ai:）全部归一到无尽榜', () => {
    const diffs: DifficultyId[] = ['easy', 'normal', 'hard', 'nightmare'];
    for (const d of diffs)
      for (const suffix of ['', ':pure', ':auto', ':pure:auto']) {
        expect(normalizeBoardKey(d + suffix)).toBe(ENDLESS_BOARD);
        expect(normalizeBoardKey(`ai:${d}${suffix}`)).toBe(ENDLESS_BOARD);
      }
    expect(normalizeBoardKey('abyss10:pure:auto')).toBe(ENDLESS_BOARD);
    expect(normalizeBoardKey('ai:endless')).toBe(ENDLESS_BOARD);
    expect(normalizeBoardKey('daily:2026-11-20')).toBe('daily:2026-11-20');
    expect(normalizeBoardKey('campaign:ch1')).toBe('campaign:ch1');
    for (const k of ['abyss0', 'abyss11', 'normal:auto:pure', 'ai:daily:2026-11-20', 'ai:ai:normal', 'normal;drop', 'custom', null]) {
      expect(normalizeBoardKey(k)).toBeNull();
    }
  });

  it('boardForOpts：无尽不分难度 / 纯净 / 开波方式；战役按章；自定义不排名', () => {
    expect(boardForOpts(baseOpts({ difficulty: 'abyss', abyssLevel: 4, pure: true, autoWave: true }))).toBe('endless');
    expect(boardForOpts(baseOpts({ difficulty: 'easy', autoWave: false }))).toBe('endless');
    expect(boardForOpts(baseOpts(), '2026-11-20')).toBe('daily:2026-11-20');
    expect(boardForOpts(baseOpts({ mode: 'campaign', map: 'ch3', difficulty: 'hard' }))).toBe(campaignBoardKey('ch3'));
    expect(boardForOpts(baseOpts({ mode: 'custom' }))).toBe('custom');
    expect(boardForOpts(baseOpts({ custom: { lives: 5 } }))).toBe('custom');
    expect(boardLabel('endless')).toBe('无尽榜');
    expect(boardLabel('abyss3:pure:auto')).toBe('无尽榜');
    expect(boardLabel('daily:2026-11-20')).toBe('每日挑战 2026-11-20');
    expect(boardLabel('campaign:ch1')).toBe('战役 · 学生书桌');
    expect(boardLabel('custom')).toBe('自定义（不排名）');
  });

  it('自动开波默认值与 core 一致；显式设置时与 progress.runAutoWave 一致', () => {
    expect(effectiveAutoWave({ difficulty: 'easy' })).toBe(false);
    expect(effectiveAutoWave({ difficulty: 'hard' })).toBe(true);
    expect(effectiveAutoWave({ difficulty: 'hard', autoWave: false })).toBe(false);
    expect(effectiveAutoWave(baseOpts({ autoWave: true }))).toBe(runAutoWave(baseOpts({ autoWave: true })));
  });

  it('战役常量与评星和 core / progress 同源', () => {
    expect(CAMPAIGN_TOTAL_WAVES).toBe(CAMPAIGN_WAVES);
    for (const [l, m] of [
      [10, 10],
      [9, 10],
      [8, 10],
      [5, 10],
      [4, 10],
      [1, 0],
    ])
      expect(starsFor(l, m)).toBe(progressStars(l, m));
    expect(starsFor(9, 10)).toBe(3);
    expect(starsFor(5, 10)).toBe(2);
    expect(starsFor(4, 10)).toBe(1);
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
    expect(sanitizeNickname('一二三四五六七八九十'.repeat(2) + '一二三四').ok).toBe(true); // 24 字
    expect(sanitizeNickname('一二三四五六七八九十'.repeat(2) + '一二三四五').ok).toBe(false);
    expect(sanitizeNickname('deepseek-v4-flash').ok).toBe(true);
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

  it('旧客户端的旧榜键归一到 endless；AI 辅助照常接受并带标记', () => {
    const legacy = checkSubmission({ ...good(), board: 'normal:auto' }, { now: NOW });
    expect(legacy.ok && legacy.value.board).toBe('endless');
    expect(legacy.ok && legacy.value.ai).toBe(false);
    const oldAi = checkSubmission({ ...good(), board: 'ai:normal:auto', aiAssist: {} }, { now: NOW });
    expect(oldAi.ok && oldAi.value.board).toBe('endless');
    const assisted = checkSubmission({ ...good(), aiAssist: { model: '  Claude\u0000 · sonnet  ' } }, { now: NOW });
    // 旧客户端发的是界面标签「服务商 · 模型」：只留模型名，渠道不进库
    expect(assisted.ok && assisted.value).toMatchObject({ ai: true, aiModel: 'sonnet', aiEffort: null, agent: null });
    const noModel = checkSubmission({ ...good(), aiAssist: {} }, { now: NOW });
    expect(noModel.ok && noModel.value).toMatchObject({ ai: true, aiModel: null });
    const long = checkSubmission({ ...good(), aiAssist: { model: 'x'.repeat(150) } }, { now: NOW });
    expect(long.ok && long.value.aiModel?.length).toBe(80);
  });

  it.each([
    ['版本不符', (b: SubmitBody) => ({ ...b, gameVersion: '0.0.0+c0' }), '版本'],
    ['榜键与 opts 不一致', (b: SubmitBody) => ({ ...b, board: 'campaign:ch1' }), '不一致'],
    ['未知榜键', (b: SubmitBody) => ({ ...b, board: 'custom' }), '不存在'],
    ['自定义模式', (b: SubmitBody) => ({ ...b, opts: { ...b.opts, mode: 'custom' } }), '自定义'],
    ['自定义参数', (b: SubmitBody) => ({ ...b, opts: { ...b.opts, custom: { lives: 999 } } }), '自定义'],
    ['种子不一致', (b: SubmitBody) => ({ ...b, seed: 'other' }), '种子'],
    ['胜利', (b: SubmitBody) => ({ ...b, result: { ...b.result, won: true } }), '胜利'],
    ['无尽有评星', (b: SubmitBody) => ({ ...b, result: { ...b.result, stars: 3 } }), '评星'],
    ['AI 标记无效', (b: SubmitBody) => ({ ...b, aiAssist: 'yes' as unknown as SubmitBody['aiAssist'] }), 'AI'],
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

  it('战役：通关按剩余生命评星；失败记 0 星；榜键与章节一致', () => {
    const opts = baseOpts({ mode: 'campaign', map: 'ch2', difficulty: 'hard', seed: 'camp-1' });
    const won = (lives: number, maxLives: number, extra: Partial<ClaimedResult> = {}): ClaimedResult => {
      const r = { wave: 20, kills: 900, lives, gold: 400, won: true, ticks: 60 * 60 * 30, cleared: 20, bonus: 0, maxLives };
      return { ...r, score: computeScore(r, scoreMul('hard')), ...extra };
    };
    const ok = checkSubmission(bodyFor(opts, won(19, 20)), { now: NOW });
    expect(ok.ok && ok.value).toMatchObject({ board: 'campaign:ch2', stars: 3, result: { stars: 3, maxLives: 20, won: true } });
    expect(checkSubmission(bodyFor(opts, won(12, 20, { stars: 2 })), { now: NOW }).ok).toBe(true);
    // 评星对不上 / 生命上限比剩余生命还小 / 没打满 20 波就通关
    expect(checkSubmission(bodyFor(opts, won(12, 20, { stars: 3 })), { now: NOW })).toMatchObject({ ok: false });
    expect(checkSubmission(bodyFor(opts, won(12, 5)), { now: NOW })).toMatchObject({ ok: false });
    expect(checkSubmission(bodyFor(opts, { ...won(12, 20), wave: 19 }), { now: NOW })).toMatchObject({ ok: false });
    // 章节不一致 / 进无尽榜 / 战役没有简单难度
    expect(checkSubmission({ ...bodyFor(opts, won(19, 20)), board: 'campaign:ch1' }, { now: NOW })).toMatchObject({ ok: false });
    expect(checkSubmission({ ...bodyFor(opts, won(19, 20)), board: 'endless' }, { now: NOW })).toMatchObject({ ok: false });
    const easy = { ...opts, difficulty: 'easy' as const };
    expect(checkSubmission(bodyFor(easy, won(19, 20)), { now: NOW })).toMatchObject({ ok: false, message: '战役难度无效' });
    // 失败：0 星
    const lost = playRun(baseOpts({ mode: 'campaign', map: 'ch1', seed: 'camp-lost' }));
    const r = checkSubmission({ ...bodyFor(lost.opts, lost.result), log: lost.log }, { now: NOW });
    expect(r.ok && r.value).toMatchObject({ board: 'campaign:ch1', stars: 0, result: { won: false, stars: 0 } });
    // AI 辅助的战役成绩也接受
    const ai = checkSubmission({ ...bodyFor(opts, won(19, 20)), aiAssist: { model: 'demo' } }, { now: NOW });
    expect(ai.ok && ai.value.ai).toBe(true);
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
