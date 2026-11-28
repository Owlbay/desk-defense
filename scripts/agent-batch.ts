/**
 * 批量对局：一次让多个渠道的多个模型并行玩同一组对局，汇总成绩，可选上传到全服 AI 榜。
 *
 *   npm run agent:batch -- --config my-batch.json [--dry] [--upload] [--out DIR]
 *   npm run agent:batch -- --config my-batch.json --upload-from DIR   （不重打，只把 DIR 里跑好的结果传上去）
 *
 * 配置文件（JSON，示例见 scripts/agent-batch.example.json）：
 *   channels[]：{ name, preset, baseUrl | baseUrlEnv, keyEnv, api?, models: (string | { model, thinking? })[] }
 *     preset = relay（OpenAI / Anthropic 兼容中转）| claude | openai | deepseek | openrouter | google | ollama | lmstudio | … （src/agent/config.ts PRESETS）
 *     Key 只从环境变量读（keyEnv），配置文件里出现 apiKey / key 字段会直接报错——配置文件可以放心分享。
 *   games：{ mode, maps[], difficulties[], seeds[], maxWaves?, pure?, autoWave? }——每个模型都打同样这些局（同种子 = 公平比较）
 *   concurrency：同时跑几局（缺省 3）；thinking：缺省思考等级（缺省 low）；budgetTokens：每局折算预算（缺省 2,000,000）
 *   upload：{ enabled, api?, nickname? }——nickname 里的 {model} 换成模型名（缺省 "{model}"）；
 *           每个模型一个固定的设备 id（由昵称 + 模型名派生），所以榜上每个模型各占一行、只保留最佳
 *
 * 上传前先在本地跑一遍和服务端一样的回放校验（src/shared/replay-verify.ts），只传校验通过的；
 * 遇到限流（每个 IP 每 10 分钟 10 次）按服务端给的等待时间自动重试。无尽模式（含每日挑战）才上传，战役不传。
 * 输出：DIR/summary.md、eval.html、batch.json，每局 decisions-*.jsonl、replay-*.json。Key 不会写进任何输出。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { type AgentModelConfig, parseThinking, type Preset, PRESETS } from '../src/agent/config';
import { createProvider } from '../src/agent/factory';
import { type AgentRunReport, runAgentGame } from '../src/agent/runner';
import type { DifficultyId, MapId, ModeId, RunOptions } from '../src/core';
import { encodeLog } from '../src/shared/codec';
import { type AgentMeta, boardForOpts, type ClaimedResult, GAME_VERSION, sanitizeNickname } from '../src/shared/leaderboard';
import { verifyRun } from '../src/shared/replay-verify';
import { fitNickname, uuidFrom } from './batch-lib';
import { botFallback, evalHtml, type EvalRow, markdownTable, rowOf, summarize } from './eval-lib';

// ───────────────────────── 配置 ─────────────────────────

interface ModelSpec {
  model: string;
  thinking?: string;
}
interface ChannelSpec {
  name: string;
  preset: string;
  baseUrl?: string;
  baseUrlEnv?: string;
  keyEnv?: string;
  api?: string;
  models: (string | ModelSpec)[];
}
interface BatchConfig {
  channels: ChannelSpec[];
  games: {
    mode?: ModeId;
    maps?: MapId[];
    difficulties?: DifficultyId[];
    seeds?: string[];
    maxWaves?: number;
    pure?: boolean;
    autoWave?: boolean;
  };
  concurrency?: number;
  thinking?: string;
  budgetTokens?: number;
  upload?: { enabled?: boolean; api?: string; nickname?: string };
}

const argv = process.argv.slice(2).filter((a) => a !== '--');
const arg = (k: string): string | undefined => {
  const i = argv.indexOf(`--${k}`);
  return i < 0 ? undefined : argv[i + 1];
};
const flag = (k: string): boolean => argv.includes(`--${k}`);

function fail(msg: string): never {
  console.error(`agent-batch: ${msg}`);
  process.exit(1);
}

/** 配置里不允许出现密钥（只能写环境变量名） */
function assertNoSecrets(v: unknown, path = 'config'): void {
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (/^(api_?key|key|token|secret)$/i.test(k)) fail(`${path}.${k}: 不要把 Key 写进配置文件，改用 keyEnv（环境变量名）`);
    assertNoSecrets(x, `${path}.${k}`);
  }
}

function loadConfig(file: string): BatchConfig {
  let c: BatchConfig;
  try {
    c = JSON.parse(readFileSync(file, 'utf8')) as BatchConfig;
  } catch (e) {
    fail(`读不了配置 ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  assertNoSecrets(c);
  if (!Array.isArray(c.channels) || !c.channels.length) fail('channels 不能为空');
  for (const ch of c.channels) {
    if (!ch.name) fail('每个渠道都要有 name');
    if (ch.preset !== 'claude' && !(ch.preset in PRESETS)) fail(`渠道 ${ch.name}: 未知 preset "${ch.preset}"`);
    if (!Array.isArray(ch.models) || !ch.models.length) fail(`渠道 ${ch.name}: models 不能为空`);
  }
  return c;
}

// ───────────────────────── 任务 ─────────────────────────

interface Job {
  channel: ChannelSpec;
  model: string;
  thinking: string;
  label: string;
  opts: RunOptions;
}

function expand(c: BatchConfig): Job[] {
  const g = c.games ?? {};
  const mode = g.mode ?? 'endless';
  const maps = g.maps?.length ? g.maps : (['ch1'] as MapId[]);
  const diffs = g.difficulties?.length ? g.difficulties : (['normal'] as DifficultyId[]);
  const seeds = g.seeds?.length ? g.seeds : ['batch-1'];
  const jobs: Job[] = [];
  for (const ch of c.channels)
    for (const m of ch.models) {
      const spec: ModelSpec = typeof m === 'string' ? { model: m } : m;
      const thinking = spec.thinking ?? c.thinking ?? 'low';
      for (const map of maps)
        for (const difficulty of diffs)
          for (const seed of seeds)
            jobs.push({
              channel: ch,
              model: spec.model,
              thinking,
              label: `${ch.name}/${spec.model}${spec.thinking ? `@${spec.thinking}` : ''}`,
              opts: {
                mode,
                map,
                difficulty,
                seed,
                skills: ['eraser_strike', 'bell', 'whiteout_zone'],
                pure: g.pure ?? true,
                ...(g.autoWave !== undefined ? { autoWave: g.autoWave } : {}),
              } as RunOptions,
            });
    }
  return jobs;
}

/** 渠道 + 模型 → 模型配置（Key 从环境变量读） */
function configOf(j: Job, c: BatchConfig): Partial<AgentModelConfig> {
  const ch = j.channel;
  const key = ch.keyEnv ? process.env[ch.keyEnv] : undefined;
  if (ch.keyEnv && !key) fail(`渠道 ${ch.name}: 环境变量 ${ch.keyEnv} 没有设置`);
  const baseUrl = ch.baseUrl ?? (ch.baseUrlEnv ? process.env[ch.baseUrlEnv] : undefined);
  if (ch.baseUrlEnv && !baseUrl) fail(`渠道 ${ch.name}: 环境变量 ${ch.baseUrlEnv} 没有设置`);
  const common: Partial<AgentModelConfig> = {
    role: 'player',
    model: j.model,
    thinking: parseThinking(j.thinking),
    assist: true,
    budget: { tokens: c.budgetTokens ?? 2_000_000, mode: 'soft' },
  };
  if (ch.preset === 'claude') return { ...common, provider: 'claude-native', ...(key ? { apiKey: key } : {}) };
  const preset = ch.preset as Preset;
  return {
    ...common,
    provider: 'pi',
    preset,
    ...(ch.api ? { api: ch.api as AgentModelConfig['api'] } : preset === 'relay' ? { api: 'openai-completions' } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    apiKey: key || (PRESETS[preset].local ? 'local' : undefined),
  };
}

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

// ───────────────────────── 上传 ─────────────────────────

/** 与界面同口径的 AI 标记（只带模型名 + 思考档位，不带渠道 / 地址） */
function agentMeta(rep: AgentRunReport, j: Job): AgentMeta {
  const total = rep.decisions.length || 1;
  const bot = rep.decisions.filter((d) => d.by === 'fallback').length;
  const tokens = rep.usage.inputTokens + rep.usage.outputTokens + rep.usage.cacheReadTokens + rep.usage.cacheWriteTokens;
  const effort = j.thinking === 'off' ? undefined : j.thinking;
  return {
    provider: 'llm',
    model: j.model.replace(/^.*\//, '').slice(0, 80),
    ...(effort ? { effort: effort as AgentMeta['effort'] } : {}),
    mode: 'pause',
    botShare: Math.round((bot / total) * 1000) / 1000,
    decisions: rep.decisions.length,
    tokens: Math.round(tokens),
    costUsd: Math.round(rep.costUsd * 1e4) / 1e4,
  };
}

interface UploadResult {
  ok: boolean;
  text: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 上传需要的一局：回放 + AI 标记（打完时存进 replay-*.json 的 batch 字段，--upload-from 读回来） */
interface SavedRun {
  label: string;
  model: string;
  opts: AgentRunReport['replay']['opts'];
  log: { tick: number; cmd: unknown }[];
  tick: number;
  agent: AgentMeta;
}

const savedOf = (rep: AgentRunReport, j: Job): SavedRun => ({
  label: j.label,
  model: j.model,
  opts: rep.replay.opts,
  log: rep.replay.log.map((e) => ({ tick: e.tick, cmd: e.cmd })),
  tick: rep.replay.tick,
  agent: agentMeta(rep, j),
});

async function upload(run: SavedRun, c: BatchConfig): Promise<UploadResult> {
  const opts = run.opts;
  if (opts.mode !== 'endless') return { ok: false, text: 'skip (只上传无尽模式)' };
  const seed = opts.seed ?? '';
  const log = run.log as Parameters<typeof verifyRun>[0]['log'];
  // 先用回放算出声明结果，再走一遍服务端同款校验：不通过就不传
  const probe = verifyRun({
    opts,
    seed,
    log,
    result: { wave: 0, score: 0, kills: 0, lives: 0, gold: 0, won: false, ticks: run.tick },
  });
  const r = probe.replayed;
  if (!r) return { ok: false, text: `本地重放失败: ${probe.status === 'rejected' ? probe.reason : ''}` };
  const ended = r.phase === 'won' || r.phase === 'lost';
  const result: ClaimedResult = {
    wave: ended ? r.wavesSurvived : Math.max(0, r.wave - 1),
    score: r.score,
    kills: r.kills,
    lives: r.lives,
    gold: r.gold,
    won: r.phase === 'won',
    ticks: r.ticks,
  };
  const check = verifyRun({ opts, seed, log, result });
  if (check.status === 'rejected') return { ok: false, text: `本地校验没通过（${check.code}: ${check.reason}），不上传` };
  const nick = sanitizeNickname(fitNickname(c.upload?.nickname ?? '{model}', run.model));
  if (!nick.ok) return { ok: false, text: `昵称不合法: ${nick.message}` };
  const body = {
    nickname: nick.value,
    deviceId: uuidFrom(`${c.upload?.nickname ?? '{model}'}|${run.model}`),
    board: boardForOpts(opts, null),
    opts,
    seed,
    log: await encodeLog([...log]),
    result,
    gameVersion: GAME_VERSION,
    agent: run.agent,
  };
  const api = (c.upload?.api ?? 'https://jjjj.games').replace(/\/+$/, '');
  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${api}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      return { ok: false, text: `网络错误: ${e instanceof Error ? e.message : String(e)}` };
    }
    const data = (await res.json().catch(() => ({}))) as {
      rank?: number;
      total?: number;
      error?: string;
      message?: string;
      retryAfter?: number;
    };
    if (res.ok) return { ok: true, text: `已上传 · ${nick.value} · 第 ${data.rank ?? '?'} 名${data.total ? ` / ${data.total}` : ''}` };
    if (data.error === 'rate_limited' && attempt < 3) {
      const wait = Math.min(600, (data.retryAfter ?? 60) + 2);
      console.log(`  限流：${wait}s 后重试 ${run.label}`);
      await sleep(wait * 1000);
      continue;
    }
    return { ok: false, text: `服务端拒收 ${res.status}: ${data.message ?? data.error ?? ''}` };
  }
  return { ok: false, text: '多次限流，放弃' };
}

// ───────────────────────── 主流程 ─────────────────────────

async function main(): Promise<void> {
  const file = arg('config');
  if (!file) fail('用法: npm run agent:batch -- --config my-batch.json [--dry] [--upload] [--out DIR]');
  const c = loadConfig(resolve(file));
  const doUpload = flag('upload') || c.upload?.enabled === true;
  // 只上传之前跑好的结果（不重打）：读 DIR 下 replay-*.json 里的 batch 字段
  const from = arg('upload-from');
  if (from) {
    const dir = resolve(from);
    const files = readdirSync(dir).filter((f) => /^replay-.*\.json$/.test(f));
    console.log(`从 ${dir} 上传 ${files.length} 局`);
    for (const f of files) {
      const saved = (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { batch?: SavedRun }).batch;
      if (!saved) {
        console.log(`  · ${f}: 没有 batch 字段（旧版本输出），跳过`);
        continue;
      }
      const u = await upload(saved, c);
      console.log(`  ${u.ok ? '↑' : '·'} ${saved.label} ${saved.opts.seed}: ${u.text}`);
    }
    return;
  }
  const jobs = expand(c);
  const conc = Number(arg('concurrency') ?? c.concurrency ?? 3);
  console.log(
    `${jobs.length} 局 · ${new Set(jobs.map((j) => j.label)).size} 个模型 · 并行 ${conc}${doUpload ? ' · 打完上传到 AI 榜' : ''}`,
  );
  if (flag('dry')) {
    for (const j of jobs) console.log(`  ${j.label}  ${j.opts.mode} ${j.opts.map} ${j.opts.difficulty} seed=${j.opts.seed}`);
    return;
  }
  // 先检查所有渠道的环境变量都在（不在就别开局）
  for (const j of jobs) configOf(j, c);

  const out = resolve(arg('out') ?? join('scripts', 'out', 'batch', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)));
  mkdirSync(out, { recursive: true });
  const rows: EvalRow[] = [];
  const uploads: { label: string; seed: string; map: string; difficulty: string; text: string; ok: boolean }[] = [];
  const t0 = Date.now();
  await pool(jobs, conc, async (j) => {
    const tag = `${j.label}-${j.opts.seed}-${j.opts.map}-${j.opts.difficulty}`.replace(/[^\w.@-]+/g, '_');
    let rep: AgentRunReport;
    try {
      const config = configOf(j, c);
      const provider = await createProvider(config);
      rep = await runAgentGame(j.opts, {
        config,
        provider,
        fallback: botFallback('medium', j.opts.mode, j.opts.map),
        maxWaves: c.games.maxWaves,
      });
    } catch (e) {
      console.error(`  ✗ ${j.label} ${j.opts.seed}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    writeFileSync(join(out, `decisions-${tag}.jsonl`), rep.decisions.map((d) => JSON.stringify(d)).join('\n'));
    const saved = savedOf(rep, j);
    writeFileSync(join(out, `replay-${tag}.json`), JSON.stringify({ replay: rep.replay, result: rep.result, batch: saved }));
    const row = rowOf(j.label, 'agent', rep);
    rows.push(row);
    console.log(
      `  ${j.label} ${j.opts.seed} ${j.opts.map} ${j.opts.difficulty}: ${row.outcome} w${row.wave} lives ${row.lives}/${row.maxLives} leaks ${row.leaks} wtd/w ${row.weightedPerWave} fallback ${row.fallbacks}`,
    );
    if (doUpload) {
      const u = await upload(saved, c);
      uploads.push({ label: j.label, seed: String(j.opts.seed), map: j.opts.map, difficulty: j.opts.difficulty, ...u });
      console.log(`    ${u.ok ? '↑' : '·'} ${u.text}`);
    }
  });
  const sum = summarize(rows);
  const md = `# 批量对局 ${new Date().toISOString()}\n\n${markdownTable(sum)}\n${uploads.length ? `\n## 上传\n\n${uploads.map((u) => `- ${u.label} ${u.seed} ${u.map} ${u.difficulty}: ${u.text}`).join('\n')}\n` : ''}`;
  writeFileSync(join(out, 'summary.md'), md);
  writeFileSync(join(out, 'eval.html'), evalHtml('批量对局', sum, rows));
  writeFileSync(join(out, 'batch.json'), JSON.stringify({ gameVersion: GAME_VERSION, rows, summary: sum, uploads }, null, 2));
  console.log(`\n${markdownTable(sum)}`);
  console.log(`用时 ${Math.round((Date.now() - t0) / 1000)}s → ${out}`);
}

void main();
