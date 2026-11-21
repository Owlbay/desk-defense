/**
 * 评测场实现（scripts/agent-eval.ts 的库部分；测试直接调用 runEval）。用法见 agent-eval.ts。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command, DifficultyId, GameEvent, IWorld, MapId, ModeId, RunOptions } from '../src/core';
import { createWorld } from '../src/core';
import { TOWERS } from '../src/config/towers';
import { replaySync } from '../src/meta/midrun';
import { passesPerTower } from '../src/agent/board';
import { BOTS, StrategyBot } from './bots';
import { createProvider } from '../src/agent/factory';
import { parseContextMode, parseThinking, type AgentModelConfig } from '../src/agent/config';
import { runAgentGame, type AgentRunReport } from '../src/agent/runner';
import { budgetTokens, type FallbackPolicy } from '../src/agent/types';

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

const HERE = dirname(fileURLToPath(import.meta.url));

export interface Variant { name: string; kv: Record<string, string> }

export function parseVariants(spec: string): Variant[] {
  return spec.split(';').map((x) => x.trim()).filter(Boolean).map((v) => {
    const [name, rest = ''] = v.split(':');
    const kv: Record<string, string> = {};
    for (const p of rest.split(',').filter(Boolean)) {
      const [k, val] = p.split('=');
      kv[k.trim()] = (val ?? '').trim();
    }
    return { name: name.trim(), kv };
  });
}

export interface EvalRow {
  variant: string;
  kind: 'agent' | 'bot';
  seed: string;
  map: MapId;
  difficulty: DifficultyId;
  outcome: string;
  wave: number;
  cleared: number;
  lives: number;
  maxLives: number;
  leaks: number;
  score: number;
  idleGold: number;
  towers: number;
  walls: number;
  pathLen: number;
  pathLen0: number;
  rawTokens: number;
  weighted: number;
  rawPerWave: number;
  weightedPerWave: number;
  requests: number;
  modelDecisions: number;
  reqPerDecision: number;
  rejected: number;
  recovered: number;
  fallbacks: number;
  errors: number;
  wallMs: number;
  /** 打法多样性（回放统计，与引擎版本无关）：建过的不同攻击塔种类数 */
  types: number;
  /** 结束时激活的组合技对数 */
  combos: number;
  /** 卖掉的墙 / 攻击塔 */
  wallsSold: number;
  towersSold: number;
  /** 卖出后又在同一格放了攻击塔的格数（腾格重建） */
  reclaimed: number;
  /** 第一次漏怪那一波之后，平均每波漏怪数（学习效果；没漏过 = 0） */
  leakAfter: number;
  /** 回放终局得分与报告一致（指标可信） */
  replayOk: boolean;
  /** 终局路线长度 / 不建迷宫时的路线长度 */
  pathRatio: number;
  /** 攻击塔平均覆盖几段路线（迷宫里夹在两条通道之间的塔 ≥2） */
  passes: number;
}

export interface PlayMetrics { types: number; combos: number; wallsSold: number; towersSold: number; reclaimed: number; replayOk: boolean; passes: number }

/**
 * 回放一局（种子 + 指令序列，确定性）统计打法指标：只依赖 core 与回放日志，不依赖 Agent 实现，
 * 因而新旧版本（含 git HEAD）用同一口径。
 */
export function playMetrics(rep: Pick<AgentRunReport, 'replay' | 'result'>): PlayMetrics {
  const w = createWorld(rep.replay.opts);
  const placed = new Set<string>();
  const freed = new Set<number>();
  let wallsSold = 0;
  let towersSold = 0;
  let reclaimed = 0;
  const cols = w.state.grid.cols;
  const onEv = (e: GameEvent): void => {
    if (e.type === 'place') {
      if (TOWERS[e.tower]?.attacks) {
        placed.add(e.tower);
        const i = e.cy * cols + e.cx;
        if (freed.has(i)) { reclaimed++; freed.delete(i); }
      }
    } else if (e.type === 'sell') {
      if (e.tower === 'wall') wallsSold++;
      else towersSold++;
      freed.add(e.cy * cols + e.cx);
    }
  };
  const rw = {
    step: () => w.step(),
    command: (c: Command) => w.command(c),
    drainEvents: () => {
      const evs = w.drainEvents();
      for (const e of evs) onEv(e);
      return evs;
    },
    get state() { return w.state; },
  };
  replaySync(rw, rep.replay);
  let pairs = 0;
  for (const t of w.state.towers.values()) pairs += t.comboWith.length;
  return { types: placed.size, combos: pairs / 2, wallsSold, towersSold, reclaimed, replayOk: w.state.score === rep.result.score, passes: passesPerTower(w) };
}

/** 第一次漏怪那一波之后的平均每波漏怪 */
export function leaksAfterFirst(waves: readonly { wave: number; leaks: number }[]): number {
  const k = waves.findIndex((x) => x.leaks > 0);
  if (k < 0 || k === waves.length - 1) return 0;
  const rest = waves.slice(k + 1);
  return Math.round((rest.reduce((a, x) => a + x.leaks, 0) / rest.length) * 100) / 100;
}

export function rowOf(variant: string, kind: 'agent' | 'bot', r: AgentRunReport): EvalRow {
  const o = r.replay.opts;
  const called = r.decisions.filter((d) => d.by === 'agent').length;
  const cleared = Math.max(1, r.result.cleared);
  const w = budgetTokens(r.usage);
  return {
    variant, kind, seed: String(o.seed), map: o.map, difficulty: o.difficulty,
    outcome: r.result.outcome, wave: r.result.wave, cleared: r.result.cleared, lives: r.result.lives, maxLives: r.result.maxLives,
    leaks: r.result.leaks, score: r.result.score,
    idleGold: r.play.idleGold, towers: r.play.towers, walls: r.play.walls, pathLen: r.play.pathLen, pathLen0: r.play.pathLen0,
    rawTokens: r.totalTokens, weighted: w, rawPerWave: Math.round(r.totalTokens / cleared), weightedPerWave: Math.round(w / cleared),
    requests: r.usage.requests, modelDecisions: called, reqPerDecision: called ? Math.round((r.usage.requests / called) * 100) / 100 : 0,
    rejected: r.play.rejected, recovered: r.play.recovered,
    fallbacks: kind === 'bot' ? 0 : r.decisions.filter((d) => d.by === 'fallback').length, errors: r.errors.length, wallMs: r.wallMs,
    ...playMetrics(r), leakAfter: leaksAfterFirst(r.waves), pathRatio: Math.round((r.play.pathLen / Math.max(1, r.play.pathLen0)) * 100) / 100,
  };
}

export interface EvalSummary {
  variant: string;
  kind: 'agent' | 'bot';
  runs: number;
  lost: number;
  wave: number;
  lives: number;
  livesPct: number;
  leaks: number;
  score: number;
  idleGold: number;
  towers: number;
  walls: number;
  pathLen: number;
  rawPerWave: number;
  weightedPerWave: number;
  reqPerDecision: number;
  rejected: number;
  recovered: number;
  fallbacks: number;
  types: number;
  combos: number;
  wallsSold: number;
  reclaimed: number;
  leakAfter: number;
  pathRatio: number;
  passes: number;
}

const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r1 = (n: number): number => Math.round(n * 10) / 10;

export function summarize(rows: EvalRow[]): EvalSummary[] {
  const names = [...new Set(rows.map((r) => r.variant))];
  return names.map((v) => {
    const rs = rows.filter((r) => r.variant === v);
    const agentRows = rs.filter((r) => r.modelDecisions > 0);
    const totalCleared = rs.reduce((a, r) => a + Math.max(1, r.cleared), 0);
    return {
      variant: v, kind: rs[0].kind, runs: rs.length, lost: rs.filter((r) => r.outcome === 'lost').length,
      wave: r1(mean(rs.map((r) => r.wave))), lives: r1(mean(rs.map((r) => r.lives))), livesPct: Math.round(mean(rs.map((r) => r.lives / Math.max(1, r.maxLives))) * 100),
      leaks: rs.reduce((a, r) => a + r.leaks, 0), score: Math.round(mean(rs.map((r) => r.score))),
      idleGold: Math.round(mean(rs.map((r) => r.idleGold))), towers: r1(mean(rs.map((r) => r.towers))), walls: r1(mean(rs.map((r) => r.walls))),
      pathLen: r1(mean(rs.map((r) => r.pathLen))),
      rawPerWave: Math.round(rs.reduce((a, r) => a + r.rawTokens, 0) / totalCleared),
      weightedPerWave: Math.round(rs.reduce((a, r) => a + r.weighted, 0) / totalCleared),
      reqPerDecision: agentRows.length ? Math.round((agentRows.reduce((a, r) => a + r.requests, 0) / agentRows.reduce((a, r) => a + r.modelDecisions, 0)) * 100) / 100 : 0,
      rejected: rs.reduce((a, r) => a + r.rejected, 0), recovered: rs.reduce((a, r) => a + r.recovered, 0),
      fallbacks: rs.reduce((a, r) => a + r.fallbacks, 0),
      types: r1(mean(rs.map((r) => r.types))), combos: r1(mean(rs.map((r) => r.combos))), wallsSold: r1(mean(rs.map((r) => r.wallsSold))),
      reclaimed: r1(mean(rs.map((r) => r.reclaimed))), leakAfter: Math.round(mean(rs.map((r) => r.leakAfter)) * 100) / 100,
      pathRatio: Math.round(mean(rs.map((r) => r.pathRatio)) * 100) / 100, passes: Math.round(mean(rs.map((r) => r.passes)) * 100) / 100,
    };
  });
}

const COLS: [keyof EvalSummary, string][] = [
  ['variant', 'variant'], ['runs', 'runs'], ['lost', 'lost'], ['wave', 'wave'], ['lives', 'lives'], ['livesPct', 'lives%'], ['leaks', 'leaks'],
  ['score', 'score'], ['idleGold', 'idle g'], ['towers', 'towers'], ['walls', 'walls'], ['pathLen', 'path'], ['rawPerWave', 'raw/wave'],
  ['weightedPerWave', 'wtd/wave'], ['reqPerDecision', 'req/dec'], ['rejected', 'rejected'], ['recovered', 'moved'], ['fallbacks', 'fallback'],
  ['types', 'types'], ['combos', 'combos'], ['wallsSold', 'w.sold'], ['reclaimed', 'reclaim'], ['leakAfter', 'leak/w>1st'], ['pathRatio', 'path×'], ['passes', 'passes'],
];

export function markdownTable(sum: EvalSummary[]): string {
  const head = `| ${COLS.map((c) => c[1]).join(' | ')} |`;
  const sep = `|${COLS.map(() => '---').join('|')}|`;
  return [head, sep, ...sum.map((s) => `| ${COLS.map((c) => String(s[c[0]])).join(' | ')} |`)].join('\n');
}

export function evalHtml(title: string, sum: EvalSummary[], rows: EvalRow[]): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const t1 = sum.map((s) => `<tr>${COLS.map((c) => `<td>${esc(String(s[c[0]]))}</td>`).join('')}</tr>`).join('');
  const rc: (keyof EvalRow)[] = ['variant', 'seed', 'map', 'difficulty', 'outcome', 'wave', 'lives', 'leaks', 'score', 'idleGold', 'towers', 'walls', 'pathLen', 'rawPerWave', 'weightedPerWave', 'reqPerDecision', 'rejected', 'recovered', 'types', 'combos', 'wallsSold', 'towersSold', 'reclaimed', 'leakAfter', 'pathRatio', 'passes', 'replayOk'];
  const t2 = rows.map((r) => `<tr>${rc.map((k) => `<td>${esc(String(r[k]))}</td>`).join('')}</tr>`).join('');
  const maxL = Math.max(1, ...sum.map((s) => s.livesPct));
  const bars = sum.map((s) => `<div class="bar"><span>${esc(s.variant)}</span><i style="width:${(s.livesPct / maxL) * 100}%"></i><b>${s.livesPct}%</b></div>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark;--fg:#222;--bg:#fbf7f0;--mute:#776;--acc:#2a7}@media(prefers-color-scheme:dark){:root{--fg:#eee;--bg:#1b1a18;--mute:#aa9}}
body{font:14px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:24px 16px;max-width:1100px;margin-inline:auto}
table{border-collapse:collapse;width:100%}td,th{padding:3px 6px;border-bottom:1px solid #8884;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}td:first-child,th:first-child{text-align:left}
.wrap{overflow-x:auto;margin-bottom:24px}small{color:var(--mute)}.bar{display:flex;align-items:center;gap:8px;margin:2px 0}.bar span{width:120px}.bar i{display:block;height:12px;background:var(--acc);border-radius:3px}</style>
<h1>${esc(title)}</h1><p><small>lives% = 剩余生命 / 上限（固定波数封顶）· idle g = 建造阶段决策后剩余金币均值 · raw/wtd = 每清一波的原始 / 折算 token · moved = 被拒放置由规划器自动挪位</small></p>
<h2>汇总</h2><div class="wrap"><table><tr>${COLS.map((c) => `<th>${c[1]}</th>`).join('')}</tr>${t1}</table></div>
<h2>剩余生命</h2>${bars}
<h2>每局</h2><div class="wrap"><table><tr>${rc.map((k) => `<th>${k}</th>`).join('')}</tr>${t2}</table></div>`;
}

function botFallback(name: string, mode: ModeId, map: MapId): (w: IWorld) => FallbackPolicy {
  return (w) => {
    const bot = new StrategyBot(w, BOTS[name]({ mode, map }));
    return {
      name: `bot:${name}`,
      decide: () => { bot.act(w.state.phase === 'wave' ? 'wave' : 'build'); bot.tick(); },
      onWaveStart: (wave) => bot.onWaveStart(wave),
      onWaveEnd: () => bot.onWaveEnd(),
      onLeak: (e) => bot.onLeak(e),
    };
  };
}

/** 跑一组评测（argv 同命令行）；返回汇总与每局行 */
export async function runEval(argvIn: string[], log: (s: string) => void = console.log): Promise<{ summary: EvalSummary[]; rows: EvalRow[]; out: string }> {
  const argv = argvIn.filter((a) => a !== '--');
  const arg = (name: string, def?: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return def;
    const v = argv[i + 1];
    return v === undefined || v.startsWith('--') ? 'true' : v;
  };
  const providerArg = arg('provider', 'scripted')!;
  const relay = providerArg === 'relay';
  const variants = parseVariants(arg('variants') ?? (relay
    ? 'base:assist=off,thinking=low;assist:assist=on,thinking=low'
    : 'v1:model=scripted-v1;intents:model=scripted-intents'));
  const seeds = list(arg('seeds', 'relay1,relay4,relay5'));
  const maps = list(arg('maps', 'ch1')) as MapId[];
  const diffs = list(arg('difficulties', 'normal')) as DifficultyId[];
  const mode = arg('mode', 'endless') as ModeId;
  const maxWaves = Number(arg('max-waves', '8'));
  const bots = list(arg('bots', 'medium,expert')).filter((b) => b !== 'none' && BOTS[b]);
  const conc = Math.max(1, Number(arg('concurrency', relay ? '3' : '1')));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const OUT = resolve(arg('out', join(HERE, 'out', 'eval', stamp))!);
  const quiet = arg('quiet') === 'true';
  if (quiet) log = () => {};
  mkdirSync(OUT, { recursive: true });
  const env = (k: string | undefined): string | undefined => (k ? process.env[k] : undefined);
  const apiKey = env(arg('api-key-env', relay ? 'RELAY_KEY' : undefined));
  const baseUrl = env(arg('base-url-env', relay ? 'RELAY_BASE' : undefined));
  const relayModel = env(arg('model-env', relay ? 'RELAY_MODEL' : undefined));
  if (relay && (!apiKey || !baseUrl || !relayModel)) {
    throw new Error('relay: set RELAY_KEY / RELAY_BASE / RELAY_MODEL (or --api-key-env / --base-url-env / --model-env)');
  }

  const jobs: (() => Promise<EvalRow>)[] = [];
  for (const map of maps) for (const difficulty of diffs) for (const seed of seeds) {
    const opts: RunOptions = { mode, map, difficulty, seed, skills: ['eraser_strike', 'bell', 'whiteout_zone'], pure: true };
    for (const v of variants) {
      jobs.push(async () => {
        const kv = v.kv;
        const config: Partial<AgentModelConfig> = relay
          ? {
            provider: 'pi', preset: 'relay', api: (arg('api', 'openai-completions') as AgentModelConfig['api']), baseUrl, apiKey,
            model: kv.model ?? relayModel!, thinking: parseThinking(kv.thinking ?? 'low'), contextMode: parseContextMode(kv.context ?? 'balanced'),
          }
          : { provider: 'scripted', model: kv.model ?? 'scripted-intents', contextMode: parseContextMode(kv.context ?? 'balanced') };
        config.assist = kv.assist !== 'off';
        config.budget = { tokens: Number(arg('budget-tokens', '1000000')), mode: 'soft' };
        const provider = await createProvider(config);
        const rep = await runAgentGame(opts, { config, provider, fallback: botFallback('medium', mode, map), maxWaves });
        const tag = `${v.name}-${seed}-${map}-${difficulty}`.replace(/[^\w.-]+/g, '_');
        try {
          writeFileSync(join(OUT, `decisions-${tag}.jsonl`), rep.decisions.map((d) => JSON.stringify(d)).join('\n'));
          writeFileSync(join(OUT, `replay-${tag}.json`), JSON.stringify({ replay: rep.replay, result: rep.result }));
        } catch (e) {
          console.error(`write failed (${tag}): ${e instanceof Error ? e.message : e}`);
        }
        const row = rowOf(v.name, 'agent', rep);
        log(`  ${v.name} ${seed} ${map} ${difficulty}: ${row.outcome} w${row.wave} lives ${row.lives}/${row.maxLives} leaks ${row.leaks} idle ${row.idleGold}g path ${row.pathLen} raw/w ${row.rawPerWave} req/d ${row.reqPerDecision} rej ${row.rejected} types ${row.types} combos ${row.combos} wsold ${row.wallsSold} reclaim ${row.reclaimed}${row.replayOk ? '' : ' (replay≠)'}`);
        return row;
      });
    }
    for (const b of bots) {
      jobs.push(async () => {
        const rep = await runAgentGame(opts, { config: { provider: 'scripted' }, provider: null, fallback: botFallback(b, mode, map), maxWaves });
        const row = rowOf(`bot:${b}`, 'bot', rep);
        log(`  bot:${b} ${seed} ${map} ${difficulty}: ${row.outcome} w${row.wave} lives ${row.lives}/${row.maxLives} leaks ${row.leaks} idle ${row.idleGold}g path ${row.pathLen} types ${row.types} combos ${row.combos}`);
        return row;
      });
    }
  }
  const rows: EvalRow[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(conc, jobs.length) }, async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      try { rows.push(await j()); } catch (e) { console.error(`job failed: ${e instanceof Error ? e.message : e}`); }
    }
  }));
  const order = [...variants.map((v) => v.name), ...bots.map((b) => `bot:${b}`)];
  rows.sort((a, b) => order.indexOf(a.variant) - order.indexOf(b.variant) || a.seed.localeCompare(b.seed) || a.map.localeCompare(b.map));
  const sum = summarize(rows);
  const table = markdownTable(sum);
  log(`\n${providerArg} · ${mode} ${maps.join(',')} ${diffs.join(',')} · seeds ${seeds.join(',')} · ${maxWaves} waves\n${table}`);
  const report = {
    generatedAt: new Date().toISOString(), provider: providerArg, model: relay ? relayModel : 'scripted', mode, maps, difficulties: diffs, seeds, maxWaves,
    variants, summary: sum, rows,
  };
  writeFileSync(join(OUT, 'eval.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT, 'eval.html'), evalHtml(`Agent 打法评测 · ${providerArg} · ${maps.join(',')} ${diffs.join(',')} · ${maxWaves} 波`, sum, rows));
  writeFileSync(join(OUT, 'eval.md'), table);
  log(`→ ${join(OUT, 'eval.json')}  ${join(OUT, 'eval.html')}`);
  return { summary: sum, rows, out: OUT };
}
