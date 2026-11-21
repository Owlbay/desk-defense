/**
 * 评测场实现（scripts/agent-eval.ts 的库部分；测试直接调用 runEval）。用法见 agent-eval.ts。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DifficultyId, IWorld, MapId, ModeId, RunOptions } from '../src/core';
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
    };
  });
}

const COLS: [keyof EvalSummary, string][] = [
  ['variant', 'variant'], ['runs', 'runs'], ['lost', 'lost'], ['wave', 'wave'], ['lives', 'lives'], ['livesPct', 'lives%'], ['leaks', 'leaks'],
  ['score', 'score'], ['idleGold', 'idle g'], ['towers', 'towers'], ['walls', 'walls'], ['pathLen', 'path'], ['rawPerWave', 'raw/wave'],
  ['weightedPerWave', 'wtd/wave'], ['reqPerDecision', 'req/dec'], ['rejected', 'rejected'], ['recovered', 'moved'], ['fallbacks', 'fallback'],
];

export function markdownTable(sum: EvalSummary[]): string {
  const head = `| ${COLS.map((c) => c[1]).join(' | ')} |`;
  const sep = `|${COLS.map(() => '---').join('|')}|`;
  return [head, sep, ...sum.map((s) => `| ${COLS.map((c) => String(s[c[0]])).join(' | ')} |`)].join('\n');
}

export function evalHtml(title: string, sum: EvalSummary[], rows: EvalRow[]): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const t1 = sum.map((s) => `<tr>${COLS.map((c) => `<td>${esc(String(s[c[0]]))}</td>`).join('')}</tr>`).join('');
  const rc: (keyof EvalRow)[] = ['variant', 'seed', 'map', 'difficulty', 'outcome', 'wave', 'lives', 'leaks', 'score', 'idleGold', 'towers', 'walls', 'pathLen', 'rawPerWave', 'weightedPerWave', 'reqPerDecision', 'rejected', 'recovered'];
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
        writeFileSync(join(OUT, `decisions-${v.name}-${seed}-${map}-${difficulty}.jsonl`), rep.decisions.map((d) => JSON.stringify(d)).join('\n'));
        const row = rowOf(v.name, 'agent', rep);
        log(`  ${v.name} ${seed} ${map} ${difficulty}: ${row.outcome} w${row.wave} lives ${row.lives}/${row.maxLives} leaks ${row.leaks} idle ${row.idleGold}g path ${row.pathLen} raw/w ${row.rawPerWave} req/d ${row.reqPerDecision} rej ${row.rejected}`);
        return row;
      });
    }
    for (const b of bots) {
      jobs.push(async () => {
        const rep = await runAgentGame(opts, { config: { provider: 'scripted' }, provider: null, fallback: botFallback(b, mode, map), maxWaves });
        const row = rowOf(`bot:${b}`, 'bot', rep);
        log(`  bot:${b} ${seed} ${map} ${difficulty}: ${row.outcome} w${row.wave} lives ${row.lives}/${row.maxLives} leaks ${row.leaks} idle ${row.idleGold}g path ${row.pathLen}`);
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
