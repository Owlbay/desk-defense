/**
 * AI 参战界面的纯逻辑（无 DOM）：军师动作解析、配置片段、设置保存不含密钥、结算上传标记、启动钩子。
 */
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { createWorld } from '../../src/core';
import type { Command, RunOptions } from '../../src/core/types';
import { sanitizeAgentMeta } from '../../src/shared/leaderboard';
import { applyAction, describeCall, failReason, parseAction } from '../../src/ui/ai/actions';
import { fmtCost, fmtTokens, providerLabel } from '../../src/ui/ai/format';
import { attachAi, clearAiLaunch, requestAiLaunch } from '../../src/ui/ai/launch';
import { bridgeCommands, detectOs, localGuides, networkNotes } from '../../src/ui/ai/snippets';

const OPTS: RunOptions = {
  mode: 'endless',
  map: 'ch1',
  difficulty: 'normal',
  seed: 'ai-ui',
  skills: ['eraser_strike', 'bell'],
  pure: true,
  autoWave: true,
};

describe('军师动作解析', () => {
  it('位置参数 / key=value / JSON / 带编号和反引号', () => {
    expect(parseAction('place_tower pencil 3,5')).toEqual({ name: 'place_tower', input: { tower: 'pencil', x: 3, y: 5 } });
    expect(parseAction('place_tower pencil 3 5')).toEqual({ name: 'place_tower', input: { tower: 'pencil', x: 3, y: 5 } });
    expect(parseAction('1. `place_tower(tower=glue, x=a, y=12)`')).toEqual({ name: 'place_tower', input: { tower: 'glue', x: 10, y: 12 } });
    expect(parseAction('place_tower {"tower":"wall","x":2,"y":7}')).toEqual({ name: 'place_tower', input: { tower: 'wall', x: 2, y: 7 } });
    expect(parseAction('upgrade_tower #12')).toEqual({ name: 'upgrade_tower', input: { uid: 12 } });
    expect(parseAction('choose_branch 12 b')).toEqual({ name: 'choose_branch', input: { uid: 12, branch: 'B' } });
    expect(parseAction('set_target_mode 4 strong')).toEqual({ name: 'set_target_mode', input: { uid: 4, mode: 'strong' } });
    expect(parseAction('start_wave')).toEqual({ name: 'start_wave', input: {} });
    expect(parseAction('choose_crate gold')).toEqual({ name: 'choose_crate', input: { option: 'gold' } });
    expect(parseAction('collect_pickup')).toEqual({ name: 'collect_pickup', input: {} });
  });

  it('cast_skill 按参数形状取字段', () => {
    expect(parseAction('cast_skill eraser_strike 5,11')).toEqual({ name: 'cast_skill', input: { skill: 'eraser_strike', x: 5, y: 11 } });
    expect(parseAction('cast_skill bell')).toEqual({ name: 'cast_skill', input: { skill: 'bell' } });
    expect(parseAction('cast_skill ruler_sweep row 6')).toEqual({
      name: 'cast_skill',
      input: { skill: 'ruler_sweep', axis: 'row', index: 6 },
    });
    expect(parseAction('cast_skill relocate 3 4 5')).toEqual({ name: 'cast_skill', input: { skill: 'relocate', uid: 3, x: 4, y: 5 } });
    expect(parseAction('cast_skill seal_tape drop-2')).toEqual({ name: 'cast_skill', input: { skill: 'seal_tape', spawner: 'drop-2' } });
  });

  it('认不出、只读工具、不合 Schema 的一律返回 null', () => {
    expect(parseAction('多建几座铅笔塔')).toBeNull();
    expect(parseAction('get_state')).toBeNull();
    expect(parseAction('end_turn')).toBeNull();
    expect(parseAction('place_tower laser 3,5')).toBeNull();
    expect(parseAction('place_tower pencil')).toBeNull();
    expect(parseAction('place_tower {bad json')).toBeNull();
    expect(parseAction('upgrade_tower abc')).toBeNull();
    expect(parseAction('')).toBeNull();
  });

  it('采纳：走给定的指令出口，与手动操作同一套校验', () => {
    const w = createWorld(OPTS);
    const sent: Command[] = [];
    const send = (c: Command) => (sent.push(c), w.command(c));
    const cell = (() => {
      for (let y = 2; y < 12; y++) for (let x = 0; x < 12; x++) if (w.canPlace('pencil', x, y).ok) return { x, y };
      throw new Error('no cell');
    })();
    const ok = applyAction(w, send, parseAction(`place_tower pencil ${cell.x},${cell.y}`)!);
    expect(ok).toEqual({ ok: true });
    expect(sent).toEqual([{ type: 'place', tower: 'pencil', cx: cell.x, cy: cell.y }]);
    expect(w.state.towers.size).toBe(1);
    // 同一格再放一次：世界拒绝，原因原样带回
    const again = applyAction(w, send, parseAction(`place_tower pencil ${cell.x},${cell.y}`)!);
    expect(again.ok).toBe(false);
    expect(again.reason).toBeTruthy();
    // 没有掉落物时"全部拾取"不算成功
    expect(applyAction(w, send, parseAction('collect_pickup')!).ok).toBe(false);
    const uid = [...w.state.towers.keys()][0];
    expect(describeCall(w, 'upgrade_tower', { uid })).toBe(`升级 铅笔塔 #${uid}`);
  });

  it('中文描述与失败原因', () => {
    expect(describeCall(null, 'place_tower', { tower: 'pencil', x: 3, y: 5 })).toBe('建造 铅笔塔（3,5）');
    expect(describeCall(null, 'start_wave', {})).toBe('开始下一波');
    expect(describeCall(null, 'get_state', {})).toBeNull();
    expect(describeCall(null, 'end_turn', { note: 'x' })).toBeNull();
    expect(failReason({ result: 'REJECTED {"type":"place","tower":"pencil","cx":1,"cy":1}: 会堵死道路 (cost 20, gold 8)' })).toBe(
      '会堵死道路',
    );
    expect(failReason({ result: 'ERROR invalid input: input.y is required' })).toBe('invalid input: input.y is required');
  });
});

describe('配置片段', () => {
  it('按系统给出 Ollama 的跨域配置，带上当前页面来源', () => {
    const origin = 'https://jjjj.games';
    const mac = localGuides(origin, 'mac').find((g) => g.id === 'ollama')!;
    expect(mac.steps[0].code).toBe('launchctl setenv OLLAMA_ORIGINS "https://jjjj.games"');
    const win = localGuides(origin, 'win').find((g) => g.id === 'ollama')!;
    expect(win.steps[0].code).toBe('setx OLLAMA_ORIGINS "https://jjjj.games"');
    const linux = localGuides(origin, 'linux').find((g) => g.id === 'ollama')!;
    expect(linux.steps.map((s) => s.code).join('\n')).toContain('Environment="OLLAMA_ORIGINS=https://jjjj.games"');
    expect(localGuides(origin, 'win').find((g) => g.id === 'llamacpp')!.steps[0].code).toContain('llama-server.exe');
    expect(localGuides(origin, 'mac').find((g) => g.id === 'llamacpp')!.steps[0].code).toContain('--jinja');
    expect(localGuides(origin, 'mac').map((g) => g.id)).toEqual(['ollama', 'lmstudio', 'llamacpp', 'vllm']);
  });

  it('桥接器命令：默认允许的来源不加 --origin，其它来源要加', () => {
    expect(bridgeCommands('https://jjjj.games')[0].code).toBe('npm run agent:bridge -- --provider pi --preset ollama --model qwen3:8b');
    expect(bridgeCommands('http://localhost:5173')[0].code).not.toContain('--origin');
    expect(bridgeCommands('https://my.site')[0].code).toContain('--origin https://my.site');
    expect(bridgeCommands('https://jjjj.games')[2].code).toContain('npx desk-defense-agent bridge');
  });

  it('网络提示：混合内容 / Safari / 本地网络权限', () => {
    const chrome = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
    const safari = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
    expect(networkNotes('https:', 'http://192.168.1.5:11434/v1', chrome).join('')).toContain('混合内容');
    expect(networkNotes('https:', 'http://localhost:11434/v1', chrome).join('')).not.toContain('混合内容');
    expect(networkNotes('https:', 'http://localhost:11434/v1', chrome).join('')).toContain('允许访问本地网络');
    expect(networkNotes('https:', 'http://localhost:11434/v1', safari).join('')).toContain('Safari');
    expect(networkNotes('http:', 'http://localhost:11434/v1', safari).join('')).not.toContain('Safari 可能');
    expect(networkNotes('https:', 'not a url')).toEqual([]);
    expect(detectOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('win');
    expect(detectOs('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
    expect(detectOs('Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)')).toBe('mac');
  });
});

describe('格式化', () => {
  it('token / 费用 / 服务商名', () => {
    expect(fmtTokens(950)).toBe('950');
    expect(fmtTokens(1500)).toBe('1.5k');
    expect(fmtTokens(123456)).toBe('123k');
    expect(fmtTokens(2_500_000)).toBe('2.50M');
    expect(fmtCost(0)).toBe('$0');
    expect(fmtCost(0.0042)).toBe('$0.0042');
    expect(fmtCost(1.234)).toBe('$1.23');
    expect(providerLabel('claude-native')).toBe('Claude');
    expect(providerLabel('pi:ollama')).toBe('Ollama');
    expect(providerLabel('pi:relay')).toBe('中转服务');
    expect(providerLabel('scripted')).toBe('内置策略');
    expect(providerLabel('pi:somethingnew')).toBe('somethingnew');
  });
});

describe('设置保存与上传标记', () => {
  beforeEach(() => clearAiLaunch());

  it('保存的设置里没有 Key 和配对码', async () => {
    // Node 里没有 localStorage：装一个内存版，验证真正写进去的内容
    const mem = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const had = g.localStorage;
    g.localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
    onTestFinished(() => void (g.localStorage = had));
    const { defaultSetup, saveSetup, loadSetup, AI_SETUP_KEY } = await import('../../src/ui/ai/store');
    const { saveableConfig, resolveConfig } = await import('../../src/agent');
    const st = defaultSetup();
    st.source = 'openai';
    st.lastConfig = saveableConfig(resolveConfig({ provider: 'pi', preset: 'openai', model: 'gpt-5-mini', apiKey: 'sk-SECRET-123' }));
    // 即使调用方传错也要兜住
    (st.lastConfig as { apiKey?: string }).apiKey = 'sk-SECRET-456';
    st.lastConfig.bridge = { url: 'ws://127.0.0.1:8787', code: '424242' };
    saveSetup(st);
    const raw = mem.get(AI_SETUP_KEY) ?? '';
    expect(raw).toContain('"source":"openai"');
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('424242');
    expect(loadSetup().source).toBe('openai');
    expect(AI_SETUP_KEY).toContain('desk-defense.ai');
    expect(defaultSetup().keyMode).toBe('memory');
    expect(defaultSetup().source).toBe('demo');

    // 中转服务：接口检测结果是不含 Key 的普通设置，可以保存
    const r = defaultSetup();
    r.source = 'relay';
    r.per.relay = {
      baseUrl: 'https://relay.test/v1',
      model: 'gpt-5-mini',
      relayApi: 'auto',
      detected: { api: 'openai-responses', for: 'https://relay.test|gpt-5-mini' },
    };
    r.lastConfig = saveableConfig(
      resolveConfig({
        provider: 'pi',
        preset: 'relay',
        api: 'openai-responses',
        baseUrl: 'https://relay.test/v1',
        model: 'gpt-5-mini',
        apiKey: 'test-RELAYKEY',
      }),
    );
    saveSetup(r);
    const raw2 = mem.get(AI_SETUP_KEY) ?? '';
    expect(raw2).not.toContain('RELAYKEY');
    expect(loadSetup().per.relay?.detected).toEqual({ api: 'openai-responses', for: 'https://relay.test|gpt-5-mini' });
  });

  it('上传标记通过服务端校验；军师按普通成绩、接管只带 AI 辅助、战役也能上传', async () => {
    const { agentMetaOf, aiUploadPlan, botShareOf } = await import('../../src/ui/ai/meta');
    const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 300, requests: 9 };
    const share = botShareOf([{ by: 'agent' }, { by: 'agent' }, { by: 'fallback' }, { by: 'agent' }]);
    expect(share).toBe(0.25);
    expect(botShareOf([])).toBe(0);
    const meta = agentMetaOf({
      agent: { provider: 'pi:Ollama', model: 'qwen3:8b 中文 tag', role: 'player' },
      mode: 'pause',
      botShare: share,
      decisions: 4,
      usage,
      costUsd: 0.123456,
    });
    expect(meta).toMatchObject({
      provider: 'pi:ollama',
      model: 'qwen3:8b____tag',
      mode: 'pause',
      botShare: 0.25,
      decisions: 4,
      tokens: 6500,
      costUsd: 0.1235,
    });
    expect(sanitizeAgentMeta(meta)).toEqual({ ok: true, value: meta });

    const base = {
      agent: { provider: 'claude-native', model: 'claude-sonnet-5-5', role: 'player' },
      opts: OPTS,
      takenOver: false,
      decisions: 3,
    };
    expect(aiUploadPlan(base)).toEqual({ kind: 'agent' });
    expect(aiUploadPlan({ ...base, agent: { ...base.agent, role: 'advisor' } })).toEqual({ kind: 'human' });
    expect(aiUploadPlan({ ...base, takenOver: true })).toEqual({ kind: 'assist' });
    // AI 出题 / AI 对战：不参与排行
    expect(aiUploadPlan({ ...base, agent: { ...base.agent, role: 'attacker' } }).kind).toBe('skip');
    expect(aiUploadPlan({ ...base, agent: { ...base.agent, role: 'duel' } }).kind).toBe('skip');
    expect(aiUploadPlan({ ...base, opts: { ...OPTS, mode: 'campaign', map: 'ch2' } })).toEqual({ kind: 'agent' });
    expect(aiUploadPlan({ ...base, opts: { ...OPTS, fixedLayout: true } }).kind).toBe('skip');
    expect(aiUploadPlan({ ...base, decisions: 0 }).kind).toBe('skip');
  });

  it('连接诊断：报错且没收到任何 token ⇒ 视为没连通（不建议切 JSON 模式）', async () => {
    const { normalizeDiag } = await import('../../src/ui/ai/setup');
    const base = { ok: false, reachable: true, toolCalling: false, latencyMs: 900, model: 'm', provider: 'pi', tokens: 0 };
    expect(normalizeDiag({ ...base, error: 'error: Connection error.', advice: 'x' })).toMatchObject({
      reachable: false,
      network: true,
      advice: undefined,
    });
    expect(normalizeDiag({ ...base, error: '401 invalid api key' })).toMatchObject({ reachable: false, network: false });
    // 真的连上了、只是没调用工具：保持原判
    expect(normalizeDiag({ ...base, tokens: 42, advice: '换模型' })).toMatchObject({ reachable: true, network: false, advice: '换模型' });
    expect(normalizeDiag({ ...base, ok: true, toolCalling: true, tokens: 42 })).toMatchObject({ ok: true, reachable: true });
  });

  it('没有启动请求时 attachAi 返回 null（普通对局零开销）', () => {
    const ctx = {} as Parameters<typeof attachAi>[0];
    expect(attachAi(ctx)).toBeNull();
    // 请求后被取消：同样是普通对局
    requestAiLaunch({ config: { provider: 'scripted' }, role: 'player', mode: 'pause', label: 'x' });
    clearAiLaunch();
    expect(attachAi(ctx)).toBeNull();
  });
});
