/**
 * Agent 参战 CLI（文档 10 §9）
 *
 *   npm run agent:play -- [选项]
 *
 *   --provider claude|pi|scripted|baseline   claude = 官方 SDK（默认）；pi = 多厂商；scripted = 内置确定性策略；baseline = 只跑内置机器人
 *   --model claude-opus-5-5                  claude-opus-5-5 | claude-sonnet-5-5 | claude-haiku-5-5 | claude-fable-5-2 | pi 的模型 id
 *   --effort low|medium|high|xhigh|max       默认 medium
 *   --preset ollama|lmstudio|llamacpp|vllm|openai|google|openrouter|deepseek|anthropic|relay|custom   （pi）
 *   --api openai-completions|openai-responses|anthropic-messages|google-generative-ai  --base-url URL   （pi，覆盖预设）
 *   --tool-mode native|json  --context full|compact
 *   --mode endless|campaign  --map ch1|ch2|ch3  --difficulty easy|normal|hard|nightmare|abyss  --abyss N
 *   --seed S  --seeds N（评测场：N 个种子）  --max-waves 30
 *   --budget-tokens 2000000  --budget-usd 5  --max-tool-calls 12  --timeout-ms 90000
 *   --decision pause|realtime  --wave-interval 10  --latency 3|measured
 *   --role player|advisor|attacker
 *   --fallback medium|expert|newbie|scripted  兜底机器人（默认 medium）
 *   --compare medium,expert                  评测场对照：同种子再跑这些内置机器人
 *   --out DIR                                默认 scripts/out/agent/<时间>-<模式>-<地图>-<难度>
 *   --quiet
 *
 * 输出：report.json（汇总 + 每波 + 决策）、replay-<seed>.json（可用 src/meta/midrun.ts 回放）、decisions-<seed>.jsonl、report.html
 * 密钥：从不在命令行传入。claude 走 SDK 默认凭据链（ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login`）；pi 读各厂商环境变量。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DifficultyId, IWorld, MapId, ModeId, RunOptions, SkillId } from '../src/core';
import { BOTS, StrategyBot } from './bots';
import { createProvider } from '../src/agent/factory';
import { resolveConfig, validateConfig, type AgentModelConfig, type Effort, type Preset, type PiApi } from '../src/agent/config';
import { runAgentGame, type AgentRunReport } from '../src/agent/runner';
import type { AgentRole, DecisionMode, FallbackPolicy } from '../src/agent/types';
import { scriptedFallback } from '../src/agent/providers/scripted';

const argv = process.argv.slice(2).filter((a) => a !== '--');
function arg(name: string, def?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? 'true' : v;
}
const num = (name: string, def?: number): number | undefined => {
  const v = arg(name);
  return v === undefined ? def : Number(v);
};

const HERE = dirname(fileURLToPath(import.meta.url));
const QUIET = arg('quiet') === 'true';
const providerArg = arg('provider', 'claude')!;
const mode = arg('mode', 'endless') as ModeId;
const map = arg('map', 'ch1') as MapId;
const difficulty = arg('difficulty', 'normal') as DifficultyId;
const maxWaves = num('max-waves', mode === 'endless' ? 30 : undefined);
const seeds = num('seeds', 1)!;
const baseSeed = arg('seed', `agent-${Date.now().toString(36)}`)!;
const fallbackName = arg('fallback', 'medium')!;
const compare = (arg('compare') ?? '').split(',').filter(Boolean);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = resolve(arg('out', join(HERE, 'out', 'agent', `${stamp}-${mode}-${map}-${difficulty}`))!);

const latencyArg = arg('latency');
const config: Partial<AgentModelConfig> = {
  provider: providerArg === 'claude' ? 'claude-native' : providerArg === 'baseline' ? 'scripted' : (providerArg as AgentModelConfig['provider']),
  model: arg('model'),
  effort: arg('effort', 'medium') as Effort,
  preset: arg('preset') as Preset | undefined,
  api: arg('api') as PiApi | undefined,
  baseUrl: arg('base-url'),
  toolMode: arg('tool-mode') as 'native' | 'json' | undefined,
  contextBudget: arg('context') as 'full' | 'compact' | undefined,
  maxToolCallsPerDecision: num('max-tool-calls'),
  role: arg('role', 'player') as AgentRole,
  decisionTimeoutMs: num('timeout-ms'),
  decision: {
    mode: arg('decision', 'pause') as DecisionMode,
    waveIntervalSec: num('wave-interval'),
    realtimeLatencySec: latencyArg === 'measured' ? 'measured' : latencyArg !== undefined ? Number(latencyArg) : undefined,
  },
  budget: { tokens: num('budget-tokens', 2_000_000), usd: num('budget-usd') },
};
if (config.provider === 'claude-native' && !config.model) config.model = 'claude-opus-5-5';
for (const k of Object.keys(config) as (keyof AgentModelConfig)[]) if (config[k] === undefined) delete config[k];

function botFallback(name: string, m: ModeId, mp: MapId): (w: IWorld) => FallbackPolicy {
  if (name === 'scripted' || !BOTS[name]) return scriptedFallback;
  return (w) => {
    const bot = new StrategyBot(w, BOTS[name]({ mode: m, map: mp }));
    return {
      name: `bot:${name}`,
      decide: () => { bot.act(w.state.phase === 'wave' ? 'wave' : 'build'); bot.tick(); },
      onWaveStart: (wave) => bot.onWaveStart(wave),
      onWaveEnd: () => bot.onWaveEnd(),
      onLeak: (e) => bot.onLeak(e),
    };
  };
}

function runOpts(seed: string, skills?: SkillId[]): RunOptions {
  const o: RunOptions = { mode, map, difficulty, seed, skills: skills ?? ['eraser_strike', 'bell', 'whiteout_zone'], pure: true };
  const ab = num('abyss');
  if (ab) o.abyssLevel = ab;
  return o;
}

const fmt$ = (v: number) => `$${v.toFixed(v < 1 ? 4 : 2)}`;

async function one(seed: string, baseline: string | null): Promise<AgentRunReport> {
  const opts = runOpts(seed);
  const isBaseline = baseline !== null;
  const provider = isBaseline ? null : providerArg === 'baseline' ? null : await createProvider(config);
  const label = isBaseline ? `bot:${baseline}` : provider ? `${provider.id}/${provider.model}` : `bot:${fallbackName}`;
  const ctl = new AbortController();
  const onSig = () => ctl.abort();
  process.once('SIGINT', onSig);
  const rep = await runAgentGame(opts, {
    config: isBaseline ? { ...config, provider: 'scripted' } : config,
    provider,
    fallback: botFallback(isBaseline ? baseline! : fallbackName, mode, map),
    maxWaves,
    signal: ctl.signal,
    onWave: (r) => {
      if (QUIET) return;
      console.log(`[${label} ${seed}] wave ${String(r.wave).padStart(3)}  lives ${r.lives}  gold ${r.gold}  towers ${r.towers}  leaks ${r.leaks}  score ${r.score}  ` +
        `tokens ${r.tokens}  ${fmt$(r.costUsd)}  decisions ${r.decisions} (fallback ${r.fallbacks})`);
    },
    onDecision: (rec) => {
      if (QUIET || !rec.fallbackReason || rec.by !== 'fallback') return;
      console.log(`  ! decision ${rec.point.seq} fell back: ${rec.fallbackReason}`);
    },
  });
  process.removeListener('SIGINT', onSig);
  return rep;
}

function summary(r: AgentRunReport) {
  return {
    seed: r.replay.opts.seed, agent: r.agent, board: r.board, result: r.result,
    tokens: r.totalTokens, usage: r.usage, costUsd: r.costUsd,
    costPerWave: r.result.cleared ? r.costUsd / r.result.cleared : null,
    tokensPerWave: r.result.cleared ? Math.round(r.totalTokens / r.result.cleared) : null,
    decisions: r.decisions.length, fallbacks: r.decisions.filter((d) => d.by === 'fallback').length,
    toolCalls: r.decisions.reduce((a, d) => a + d.toolCalls.length, 0),
    rejected: r.decisions.reduce((a, d) => a + d.toolCalls.filter((c) => !c.ok).length, 0),
    errors: r.errors, disabledReason: r.disabledReason, wallMs: r.wallMs,
  };
}

function html(title: string, runs: AgentRunReport[], baselines: AgentRunReport[]): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const rows = [...runs, ...baselines].map((r) => `<tr><td>${esc(r.agent.provider)}/${esc(r.agent.model)}</td><td>${esc(String(r.replay.opts.seed))}</td><td>${r.result.outcome}</td><td>${r.result.wave}</td><td>${r.result.score}</td><td>${r.result.lives}/${r.result.maxLives}</td><td>${r.totalTokens}</td><td>${fmt$(r.costUsd)}</td><td>${r.decisions.length}</td><td>${r.decisions.filter((d) => d.by === 'fallback').length}</td></tr>`).join('');
  const charts = runs.map((r) => {
    const W = 560; const H = 140; const n = Math.max(1, r.waves.length);
    const maxL = Math.max(1, r.result.maxLives); const maxT = Math.max(1, ...r.waves.map((x) => x.tokens));
    const pts = (f: (x: (typeof r.waves)[number]) => number) => r.waves.map((x, i) => `${(i / Math.max(1, n - 1)) * (W - 20) + 10},${H - 10 - f(x) * (H - 20)}`).join(' ');
    return `<figure><figcaption>${esc(String(r.replay.opts.seed))}: <span class="l">lives</span> / <span class="t">tokens (cumulative)</span> per wave</figcaption>
<svg viewBox="0 0 ${W} ${H}" role="img"><polyline class="l" fill="none" points="${pts((x) => x.lives / maxL)}"/><polyline class="t" fill="none" points="${pts((x) => x.tokens / maxT)}"/></svg></figure>`;
  }).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark;--fg:#222;--bg:#fbf7f0;--mute:#776;--l:#2a7;--t:#c63}@media(prefers-color-scheme:dark){:root{--fg:#eee;--bg:#1b1a18;--mute:#aa9}}
body{font:14px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:24px 16px;max-width:960px;margin-inline:auto}
table{border-collapse:collapse;width:100%}td,th{padding:4px 8px;border-bottom:1px solid #8884;text-align:right;font-variant-numeric:tabular-nums}td:first-child,th:first-child{text-align:left}
.wrap{overflow-x:auto}svg{width:100%;height:auto;background:#8881;border-radius:6px}polyline{stroke-width:2}.l{stroke:var(--l);color:var(--l)}.t{stroke:var(--t);color:var(--t)}small{color:var(--mute)}</style>
<h1>${esc(title)}</h1><p><small>Agent 参战报告 · AI 专用榜（不进入真人榜）· 费用为估算</small></p>
<div class="wrap"><table><tr><th>agent</th><th>seed</th><th>result</th><th>wave</th><th>score</th><th>lives</th><th>tokens</th><th>cost</th><th>decisions</th><th>fallbacks</th></tr>${rows}</table></div>${charts}`;
}

async function main(): Promise<void> {
  const errs = validateConfig(resolveConfig(config));
  if (errs.length) { console.error(`配置有误：${errs.join('；')}`); process.exit(2); }
  mkdirSync(OUT, { recursive: true });
  const runs: AgentRunReport[] = [];
  const baselines: AgentRunReport[] = [];
  for (let i = 0; i < seeds; i++) {
    const seed = seeds > 1 ? `${baseSeed}-${i + 1}` : baseSeed;
    const r = await one(seed, null);
    runs.push(r);
    writeFileSync(join(OUT, `replay-${seed}.json`), JSON.stringify(r.replay));
    writeFileSync(join(OUT, `decisions-${seed}.jsonl`), r.decisions.map((d) => JSON.stringify(d)).join('\n'));
    console.log(`== ${r.agent.provider}/${r.agent.model} seed ${seed}: ${r.result.outcome} wave ${r.result.wave} score ${r.result.score} lives ${r.result.lives}/${r.result.maxLives} ` +
      `tokens ${r.totalTokens} (in ${r.usage.inputTokens} out ${r.usage.outputTokens} cache r/w ${r.usage.cacheReadTokens}/${r.usage.cacheWriteTokens}) cost≈${fmt$(r.costUsd)} ` +
      `decisions ${r.decisions.length} fallbacks ${r.decisions.filter((d) => d.by === 'fallback').length}${r.disabledReason ? ` [model disabled: ${r.disabledReason}]` : ''}`);
    for (const b of compare) {
      const br = await one(seed, b);
      baselines.push(br);
      console.log(`   vs bot:${b}: ${br.result.outcome} wave ${br.result.wave} score ${br.result.score}`);
    }
  }
  const med = (a: number[]) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : 0);
  const report = {
    generatedAt: new Date().toISOString(), args: argv,
    config: runs[0]?.config, opts: runOpts(baseSeed), maxWaves,
    arena: {
      seeds, medianWave: med(runs.map((r) => r.result.wave)), medianScore: med(runs.map((r) => r.result.score)),
      totalTokens: runs.reduce((a, r) => a + r.totalTokens, 0), totalCostUsd: runs.reduce((a, r) => a + r.costUsd, 0),
      costPerWave: runs.reduce((a, r) => a + r.costUsd, 0) / Math.max(1, runs.reduce((a, r) => a + r.result.cleared, 0)),
      baselines: compare.map((b) => ({ bot: b, medianWave: med(baselines.filter((x) => x.agent.model === `bot:${b}`).map((x) => x.result.wave)) })),
    },
    runs: runs.map((r) => ({ ...summary(r), waves: r.waves })),
    baselines: baselines.map(summary),
  };
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT, 'report.html'), html(`Agent 参战 · ${mode} ${map} ${difficulty}`, runs, baselines));
  console.log(`report → ${join(OUT, 'report.json')}  ${join(OUT, 'report.html')}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
