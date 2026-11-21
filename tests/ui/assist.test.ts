/**
 * 全局 AI 助手：对局中挂上 / 摘下 AI（插槽）、公平性标记、上传拦截、模型设置表单的复用。
 * Node 里没有 DOM：AI 面板（src/ui/ai/hud.ts）用替身代替，只验证插槽本身的行为。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions } from '../../src/core/types';
import { Session } from '../../src/game/Session';
import { ui } from '../../src/game/UiStore';
import { t } from '../../src/i18n';
import { cloneAssist, emptyAssist, isAiAssisted, markAssist, sanitizeAssist, usedAi } from '../../src/meta/aiAssist';
import { makeMidRun } from '../../src/meta/midrun';
import { defaultProfile, normalizeProfile } from '../../src/meta/profile';
import { leaderKey, leaderView, settleRun } from '../../src/meta/progress';
import type { AiAttachCtx, AiLaunch } from '../../src/ui/ai/launch';

// ── AI 面板替身：记录挂载 / 销毁；AI 玩家挂上后像真面板一样把棋盘设为只读 ──
const hudLog: { mounted: AiLaunch[]; destroyed: number; finished: number; tookOver: number } = {
  mounted: [],
  destroyed: 0,
  finished: 0,
  tookOver: 0,
};
vi.mock('../../src/ui/ai/hud', () => ({
  mountAiHud: (_ctx: AiAttachCtx, launch: AiLaunch) => {
    hudLog.mounted.push(launch);
    if (launch.role === 'player') ui.set({ inspectOnly: true });
    // 暂停模式的 AI 玩家正在思考：游戏被它暂停
    if (launch.role === 'player' && launch.mode === 'pause') _ctx.session.togglePause(true);
    return {
      gameOverCard: () => ({}) as HTMLElement,
      finish: () => void hudLog.finished++,
      takeOver: () => void hudLog.tookOver++,
      // 故意不复位 inspectOnly：插槽自己必须交还控制
      destroy: () => void hudLog.destroyed++,
    };
  },
}));

const OPTS: RunOptions = {
  mode: 'campaign',
  map: 'ch1',
  difficulty: 'normal',
  seed: 'assist-test',
  skills: ['eraser_strike', 'bell'],
  autoWave: false,
};
const ENDLESS: RunOptions = {
  mode: 'endless',
  map: 'ch1',
  difficulty: 'normal',
  seed: 'assist-endless',
  skills: ['eraser_strike'],
  pure: true,
  autoWave: true,
};

function fakeGame() {
  const cls = new Set<string>();
  return {
    cls,
    el: {
      classList: {
        add: (...c: string[]) => c.forEach((x) => cls.add(x)),
        remove: (...c: string[]) => c.forEach((x) => cls.delete(x)),
        toggle: () => false,
        contains: (c: string) => cls.has(c),
      },
      querySelector: () => null,
    } as unknown as HTMLElement,
  };
}

function makeCtx(opts = OPTS) {
  const session = new Session(opts);
  const g = fakeGame();
  const toasts: string[] = [];
  const ctx: AiAttachCtx = {
    app: { toast: (s: string) => void toasts.push(s) } as unknown as AiAttachCtx['app'],
    session,
    opts,
    game: g.el,
    modals: g.el,
  };
  return { ctx, session, g, toasts };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const launch = (role: 'player' | 'advisor', mode: 'pause' | 'realtime' = 'pause', label = '离线演示'): AiLaunch => ({
  config: { provider: 'scripted', model: 'scripted-v1', role },
  role,
  mode,
  label,
});

/** 对局状态指纹：挂上 / 摘下 AI 不能改动对局本身 */
const fingerprint = (s: Session) => {
  const st = s.world.state;
  return JSON.stringify({
    tick: st.tick,
    wave: st.wave,
    gold: st.gold,
    lives: st.lives,
    phase: st.phase,
    towers: [...st.towers.keys()],
    log: s.world.log.length,
  });
};

describe('AI 插槽：对局中挂上 / 摘下', () => {
  beforeEach(() => {
    hudLog.mounted = [];
    hudLog.destroyed = hudLog.finished = hudLog.tookOver = 0;
    ui.set({ inspectOnly: false });
  });

  it('中途启用 AI 玩家 → 只读；停用 → 交还控制、恢复暂停、对局状态不变', async () => {
    const { createAiSlot } = await import('../../src/ui/ai/launch');
    const { ctx, session, g } = makeCtx();
    // 先自己玩一会儿（中途启用）
    for (let i = 0; i < 120; i++) session.world.step();
    const before = fingerprint(session);
    const slot = createAiSlot(ctx);
    expect(slot.role).toBeNull();
    expect(usedAi(slot.assist)).toBe(false);

    slot.attach(launch('player'));
    // 启用即标记（不等面板加载完）
    expect(slot.assist).toMatchObject({ player: true, advisor: false, model: '离线演示' });
    expect(slot.role).toBe('player');
    expect(slot.loading).toBe(true);
    expect(g.cls.has('ai-run') && g.cls.has('ai-player')).toBe(true);
    await flush();
    expect(slot.loading).toBe(false);
    expect(hudLog.mounted).toHaveLength(1);
    // 对局中启用的 AI：停止按钮改为整个停用
    expect(typeof hudLog.mounted[0].onStop).toBe('function');
    expect(ui.state.inspectOnly).toBe(true);
    expect(session.paused).toBe(true);
    expect(fingerprint(session)).toBe(before);

    slot.detach();
    expect(slot.role).toBeNull();
    expect(hudLog.destroyed).toBe(1);
    expect(ui.state.inspectOnly).toBe(false);
    expect(session.paused).toBe(false);
    expect(g.cls.size).toBe(0);
    expect(fingerprint(session)).toBe(before);
    // 标记保留
    expect(isAiAssisted(slot.assist)).toBe(true);
    // 面板里的「停止」走同一条路
    slot.attach(launch('advisor', 'realtime'));
    await flush();
    hudLog.mounted[1].onStop?.();
    expect(slot.role).toBeNull();
    expect(hudLog.destroyed).toBe(2);
  });

  it('切换角色：先摘下旧面板再挂新的；只用军师不算 AI 协助', async () => {
    const { createAiSlot } = await import('../../src/ui/ai/launch');
    const { ctx } = makeCtx();
    const slot = createAiSlot(ctx);
    slot.attach(launch('advisor', 'realtime', 'Claude · claude-sonnet-5-5'));
    await flush();
    expect(slot.assist).toMatchObject({ player: false, advisor: true });
    expect(isAiAssisted(slot.assist)).toBe(false);
    expect(ui.state.inspectOnly).toBe(false);
    slot.attach(launch('player', 'realtime'));
    await flush();
    expect(hudLog.destroyed).toBe(1);
    expect(hudLog.mounted.map((l) => l.role)).toEqual(['advisor', 'player']);
    expect(slot.assist).toMatchObject({ player: true, advisor: true, model: '离线演示' });
    expect(ui.state.inspectOnly).toBe(true);
    slot.attach(launch('advisor', 'realtime'));
    await flush();
    expect(ui.state.inspectOnly).toBe(false);
    expect(slot.noSettle).toBe(false);
  });

  it('面板还没加载完就停用：不会再挂上，控制立即交还', async () => {
    const { createAiSlot } = await import('../../src/ui/ai/launch');
    const { ctx } = makeCtx();
    const slot = createAiSlot(ctx);
    slot.attach(launch('player'));
    ui.set({ inspectOnly: true });
    slot.detach();
    expect(ui.state.inspectOnly).toBe(false);
    await flush();
    expect(hudLog.mounted).toHaveLength(0);
    expect(slot.role).toBeNull();
  });

  it('对局结束：普通对局停掉 AI 照常结算；AI 参战局出报告、AI 玩家不结算', async () => {
    const { createAiSlot } = await import('../../src/ui/ai/launch');
    const info = { won: false, wave: 3, wavesSurvived: 2, score: 100 };
    const hd = { again: () => {}, menu: () => {} };
    const a = createAiSlot(makeCtx().ctx);
    a.attach(launch('player'));
    await flush();
    expect(a.gameOver(info, hd)).toBeNull();
    expect(hudLog.finished).toBe(1);
    expect(a.noSettle).toBe(false);

    const b = createAiSlot(makeCtx(ENDLESS).ctx);
    b.attach(launch('player'), { dedicated: true });
    await flush();
    expect(b.dedicated).toBe(true);
    expect(b.noSettle).toBe(true);
    expect(b.gameOver(info, hd)).not.toBeNull();
    // AI 参战局的「停止」= 接管（面板留着出报告）
    b.detach();
    expect(hudLog.tookOver).toBe(1);
    expect(b.role).toBe('player');
  });

  it('读档：公平性标记从中途存档恢复', async () => {
    const { createAiSlot } = await import('../../src/ui/ai/launch');
    const slot = createAiSlot(makeCtx().ctx, { assist: { player: true, advisor: false, model: 'x' } });
    expect(isAiAssisted(slot.assist)).toBe(true);
    expect(slot.role).toBeNull();
  });
});

describe('公平性标记', () => {
  it('标记 / 清洗 / 复制', () => {
    const a = emptyAssist();
    expect(usedAi(a)).toBe(false);
    expect(cloneAssist(a)).toBeUndefined();
    markAssist(a, 'advisor', 'm1');
    expect(isAiAssisted(a)).toBe(false);
    markAssist(a, 'player', 'm2');
    expect(a).toEqual({ player: true, advisor: true, model: 'm2' });
    expect(sanitizeAssist({ player: 'yes', advisor: true })).toEqual({ player: false, advisor: true });
    expect(sanitizeAssist({ player: false, advisor: false })).toBeUndefined();
    expect(sanitizeAssist(null)).toBeUndefined();
  });

  it('中途存档带上标记，读档后保留；没用过 AI 不写', () => {
    const s = new Session(OPTS);
    for (let i = 0; i < 30; i++) s.world.step();
    expect(makeMidRun(s.world).aiAssist).toBeUndefined();
    const run = makeMidRun(s.world, { player: true, advisor: false, model: '离线演示' });
    expect(run.aiAssist).toEqual({ player: true, advisor: false, model: '离线演示' });
    const p = defaultProfile();
    p.midRun = run;
    const back = normalizeProfile(JSON.parse(JSON.stringify(p)));
    expect(back.midRun?.aiAssist).toEqual({ player: true, advisor: false, model: '离线演示' });
  });

  it('本地排行榜：AI 协助的成绩打标记、单独占名额、默认不显示；战役星星照常', () => {
    const p = defaultProfile();
    const base = { won: false, kills: 10, lives: 5, maxLives: 20, seed: 's', perks: [], autoWave: true };
    const human = settleRun(p, ENDLESS, { ...base, wavesSurvived: 5, score: 500 });
    const ai = settleRun(p, ENDLESS, { ...base, wavesSurvived: 30, score: 99_999, aiAssisted: true });
    expect(human.rank).toBe(1);
    // 各算各的名次：AI 协助的高分不把真人挤下去
    expect(ai.rank).toBe(1);
    expect(ai.ink).toBeGreaterThan(0);
    const key = leaderKey('normal', true, true);
    const list = p.leaderboard[key];
    expect(list.filter((e) => e.ai)).toHaveLength(1);
    expect(leaderView(list).map((e) => e.score)).toEqual([500]);
    expect(leaderView(list, true).map((e) => e.score)).toEqual([99_999, 500]);
    // 真人与 AI 各 10 个名额
    for (let i = 0; i < 15; i++) settleRun(p, ENDLESS, { ...base, wavesSurvived: 40, score: 200_000 + i, aiAssisted: true });
    expect(p.leaderboard[key].filter((e) => !e.ai).map((e) => e.score)).toEqual([500]);
    expect(p.leaderboard[key].filter((e) => e.ai)).toHaveLength(10);
    expect(normalizeProfile(JSON.parse(JSON.stringify(p))).leaderboard[key]).toHaveLength(11);

    const c = defaultProfile();
    const r = settleRun(c, OPTS, { ...base, won: true, lives: 20, wavesSurvived: 10, score: 1000, aiAssisted: true });
    expect(r.stars).toBe(3);
    expect(c.campaign['ch1:normal']).toBe(3);
  });

  it('用过「让 AI 替我玩」的对局不上传（不发请求）', async () => {
    const { submitWorldRun } = await import('../../src/meta/online');
    const s = new Session(ENDLESS);
    const fetchSpy = vi.fn();
    const g = globalThis as { fetch?: unknown };
    const had = g.fetch;
    g.fetch = fetchSpy;
    try {
      const r = await submitWorldRun(s.world, { wavesSurvived: 3, aiAssist: { player: true, advisor: false } });
      expect(r).toEqual({ kind: 'rejected', message: t('ui.assist.blockedShort') });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      g.fetch = had;
    }
  });
});

describe('模型设置：一份配置到处用', () => {
  const mem = new Map<string, string>();
  beforeAll(() => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
  });

  it('没保存过设置 → 先问（离线演示 / 配置）；演示与保存的设置按角色生成启动参数', async () => {
    const { resolveAssistLaunch, demoLaunch } = await import('../../src/ui/ai/assist');
    const { defaultSetup, saveSetup, writeKey, forgetKey, AI_SETUP_KEY } = await import('../../src/ui/ai/store');
    mem.clear();
    expect(resolveAssistLaunch('player')).toEqual({ ok: false, reason: null });

    const d = demoLaunch('advisor');
    expect(d.config.provider).toBe('scripted');
    expect(d.role).toBe('advisor');
    // 军师总是实时，不替玩家暂停
    expect(d.mode).toBe('realtime');
    expect(demoLaunch('player').mode).toBe('pause');

    const st = defaultSetup();
    st.source = 'claude';
    st.per.claude = { model: 'claude-sonnet-5-5' };
    saveSetup(st);
    const noKey = resolveAssistLaunch('player');
    expect(noKey).toEqual({ ok: false, reason: t('agent.setup.err.needKey') });
    writeKey('claude', 'sk-ant-TEST', 'memory');
    const ok = resolveAssistLaunch('player');
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.launch.config).toMatchObject({
      provider: 'claude-native',
      model: 'claude-sonnet-5-5',
      role: 'player',
      apiKey: 'sk-ant-TEST',
    });
    expect(ok.launch.label).toContain('claude-sonnet-5-5');
    // Key 只在内存（默认存放方式），保存的设置里没有
    expect(mem.get(AI_SETUP_KEY)).not.toContain('sk-ant-TEST');
    forgetKey('claude');
  });

  it('「AI 参战」设置页与「AI 助手」生成的配置一致（只有军师的决策方式不同）', async () => {
    const { buildModelConfig } = await import('../../src/ui/ai/model-config');
    const { defaultSetup } = await import('../../src/ui/ai/store');
    const st = defaultSetup();
    st.source = 'deepseek';
    st.decisionMode = 'pause';
    const route = buildModelConfig(st, { role: 'player' });
    const global = buildModelConfig(st, { role: 'player', perRole: true });
    expect(global).toEqual(route);
    const adv = buildModelConfig(st, { role: 'advisor', perRole: true });
    expect(adv.decision).toEqual({ mode: 'realtime', waveIntervalSec: 20 });
    expect({ ...adv, decision: undefined, role: undefined }).toEqual({ ...route, decision: undefined, role: undefined });
  });

  it('两个入口都挂同一个 AiModelConfigForm', () => {
    const read = (f: string) => readFileSync(join(__dirname, '../../src/ui/ai', f), 'utf8');
    expect(read('setup.ts')).toMatch(/mountAiModelConfigForm\(/);
    expect(read('assist.ts').match(/mountAiModelConfigForm\(/g)?.length).toBe(2);
    // 表单本身不再拼配置：统一走 model-config
    expect(read('model-form.ts')).toMatch(/buildModelConfig\(st/);
    expect(read('setup.ts')).not.toMatch(/buildModelConfig|readKey/);
  });
});
