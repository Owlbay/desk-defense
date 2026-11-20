/**
 * 书桌防线 · 平衡模拟（文档 07 §3.2）
 *
 * 用法：
 *   npx vite-node scripts/simulate.ts -- [选项]          （或 npm run sim -- [选项]）
 *
 *   --scenario calib|campaign|endless|xp|ladder|custom   预设场景集（默认 calib = 全部校准目标；ladder = 各难度阶梯参考）
 *   --bot newbie|medium|expert                    custom 场景用
 *   --mode endless|campaign                       custom 场景用
 *   --diff easy|normal|hard|nightmare|abyss1..10  custom 场景用
 *   --talents none|max                            custom 场景用：纯净 / 满天赋（含技能 2 级、第 4 技能槽）
 *   --maps ch1,ch2,ch3                            地图（默认三张都跑）
 *   --seeds N                                     每个场景每张图的种子数（默认 8）
 *   --max-wave W                                  无尽模式封顶波数（默认 120）
 *   --out DIR                                     输出目录（默认 scripts/out）
 *   --save-baseline                               把本次结果另存为 baseline.json，之后的报告会叠加对比
 *   --quiet                                       不打印每局一行
 *   --patch '{"enemies.boss_coffee.hp":300,"presets.hard.hpMul":1.2}'
 *                                                 运行时临时改配置做对比（enemies/towers/presets/abyss/abyssPer/maps/events/drop/evo），不写文件
 *   环境变量 SIM_OPTS='{"autoWave":false,"fixedLayout":true}'  覆盖每局的 RunOptions（调试用）
 *
 * 输出：
 *   runs.csv      每局一行汇总
 *   waves.csv     每局每波一行（金币、生命、漏怪、塔平均等级、场上敌人……）
 *   summary.json  每个场景的统计
 *   report.html   波数分布图（自包含，可直接用浏览器打开）
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld, type DifficultyId, type MapId, type ModeId, type RunOptions } from '../src/core';
import { BOTS, StrategyBot } from './bots';
import { ENEMIES } from '../src/config/enemies';
import { TOWERS } from '../src/config/towers';
import { PRESETS, ABYSS_BASE, ABYSS_PER_LEVEL } from '../src/config/difficulty';
import { MAPS as MAP_DEFS } from '../src/config/maps';
import { RANDOM_EVENTS, DROP } from '../src/config/events';
import { EVO } from '../src/config/evolution';

// ───────────────────────── 参数 ─────────────────────────

const argv = process.argv.slice(2).filter((a) => a !== '--');
function arg(name: string, def?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? 'true' : v;
}
const SEEDS = Number(arg('seeds', '8'));
const MAX_WAVE = Number(arg('max-wave', '120'));
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(arg('out', join(HERE, 'out'))!);
const QUIET = arg('quiet') === 'true';
const MAPS: MapId[] = (arg('maps', 'ch1,ch2,ch3')!).split(',') as MapId[];

export interface Scenario {
  id: string;
  label: string;
  bot: string;
  mode: ModeId;
  diff: DifficultyId;
  abyssLevel?: number;
  maps: MapId[];
  /** 永久天赋：none = 纯净模式；max = 全部满级 + 技能 2 级 + 第 4 技能槽 */
  talents?: 'none' | 'max';
  /** 目标说明（报告里显示） */
  target: string;
  /** 判定：给出该场景的统计，返回是否达标 */
  check?: (st: ScenarioStats) => boolean;
}

function parseDiff(d: string): { diff: DifficultyId; abyssLevel?: number } {
  const m = /^abyss(\d+)$/.exec(d);
  if (m) return { diff: 'abyss', abyssLevel: Number(m[1]) };
  return { diff: d as DifficultyId };
}

function scenarios(): Scenario[] {
  const which = arg('scenario', 'calib')!;
  const endless: Scenario[] = [
    { id: 'easy-newbie', label: '简单 · 新手', bot: 'newbie', mode: 'endless', diff: 'easy', maps: MAPS, target: '撑过第 20 波（中位数 ≥ 20）', check: (s) => s.median >= 20 },
    { id: 'normal-medium', label: '普通 · 中等', bot: 'medium', mode: 'endless', diff: 'normal', maps: MAPS, target: '中位数 45～60', check: (s) => s.median >= 45 && s.median <= 60 },
    { id: 'abyss1-expert', label: '魔境 I · 高手（满天赋）', bot: 'expert', mode: 'endless', diff: 'abyss', abyssLevel: 1, talents: 'max', maps: MAPS, target: '中位数 30～40', check: (s) => s.median >= 30 && s.median <= 40 },
  ];
  const campaign: Scenario[] = [];
  for (const map of MAPS) {
    campaign.push({ id: `camp-${map}-normal-medium`, label: `战役 ${map} 普通 · 中等`, bot: 'medium', mode: 'campaign', diff: 'normal', maps: [map], target: '能通关（≥1 星）', check: (s) => s.winRate >= 0.5 });
    campaign.push({ id: `camp-${map}-hard-expert`, label: `战役 ${map} 困难 · 高手`, bot: 'expert', mode: 'campaign', diff: 'hard', maps: [map], target: '能通关', check: (s) => s.winRate >= 0.5 });
  }
  const xp: Scenario[] = [
    { id: 'xp-normal-medium', label: '经验节奏（普通 · 中等，纯经验铅笔）', bot: 'medium', mode: 'endless', diff: 'normal', maps: MAPS, target: '第 20 波 Lv5～6', check: (s) => s.xpProbeMedian >= 5 && s.xpProbeMedian <= 6.5 },
  ];
  // 难度阶梯（参考，无判定）：各难度下中等 / 高手的表现
  const ladder: Scenario[] = [];
  for (const [d, lv] of [['easy'], ['normal'], ['hard'], ['nightmare'], ['abyss', 1], ['abyss', 3]] as [DifficultyId, number?][]) {
    for (const bot of ['medium', 'expert']) {
      for (const talents of (bot === 'expert' ? ['none', 'max'] : ['none']) as ('none' | 'max')[]) {
        const dn = lv ? `abyss${lv}` : d;
        ladder.push({ id: `ladder-${dn}-${bot}-${talents}`, label: `阶梯 ${dn} · ${bot}${talents === 'max' ? '（满天赋）' : ''}`, bot, mode: 'endless', diff: d, abyssLevel: lv, talents, maps: MAPS, target: '参考' });
      }
    }
  }
  if (which === 'ladder') return ladder;
  if (which === 'endless') return endless;
  if (which === 'campaign') return campaign;
  if (which === 'xp') return xp;
  if (which === 'custom') {
    const { diff, abyssLevel } = parseDiff(arg('diff', 'normal')!);
    const bot = arg('bot', 'medium')!;
    const mode = arg('mode', 'endless') as ModeId;
    const talents = arg('talents', 'none') as 'none' | 'max';
    return [{ id: `custom-${bot}-${mode}-${arg('diff', 'normal')}`, label: `自定义 ${bot} ${mode} ${arg('diff', 'normal')}${talents === 'max' ? ' 满天赋' : ''}`, bot, mode, diff, abyssLevel, talents, maps: MAPS, target: '—' }];
  }
  // calib：无尽三档（normal-medium 同时测经验节奏）+ 战役
  return [...endless, ...campaign];
}

// 运行时配置补丁（只影响本进程）
const PATCH_ROOTS: Record<string, unknown> = {
  enemies: ENEMIES, towers: TOWERS, presets: PRESETS, abyss: ABYSS_BASE, abyssPer: ABYSS_PER_LEVEL,
  maps: MAP_DEFS, events: RANDOM_EVENTS, drop: DROP, evo: EVO,
};
const patch = arg('patch');
if (patch && patch !== 'true') {
  for (const [path, v] of Object.entries(JSON.parse(patch) as Record<string, number>)) {
    const parts = path.split('.');
    let o = PATCH_ROOTS[parts[0]] as Record<string, unknown>;
    for (const k of parts.slice(1, -1)) o = o[k] as Record<string, unknown>;
    if (!o) throw new Error(`bad patch path ${path}`);
    o[parts[parts.length - 1]] = v;
  }
}

// ───────────────────────── 单局 ─────────────────────────

export interface WaveRow {
  wave: number; time: number; gold: number; lives: number; leaks: number;
  avgLevel: number; maxLevel: number; towers: number; walls: number; alive: number; peakAlive: number;
}
export interface RunResult {
  scenario: string; bot: string; mode: ModeId; diff: string; map: MapId; seed: string;
  result: 'won' | 'lost' | 'cap'; wave: number; cleared: number; lives: number; maxLives: number; stars: number;
  kills: number; leaks: number; goldEarned: number; towers: number; avgLevel: number; score: number;
  xpProbeLv20: number; perks: string; leakBy: string; ms: number; rows: WaveRow[];
}

function runOne(sc: Scenario, map: MapId, seed: string): RunResult {
  const t0 = performance.now();
  const params = BOTS[sc.bot]({ mode: sc.mode, map });
  // 调试：BOT_OVERRIDE='{"wallShare":0.3}' 覆盖机器人参数（仅 JSON 可表示的字段）
  if (process.env.BOT_OVERRIDE) Object.assign(params, JSON.parse(process.env.BOT_OVERRIDE));
  const maxT = sc.talents === 'max';
  const skills = maxT && params.extraSkill ? [...params.skills, params.extraSkill] : params.skills;
  const opts: RunOptions = {
    mode: sc.mode, map, difficulty: sc.diff, abyssLevel: sc.abyssLevel, seed, skills,
    pure: !maxT,
    talents: maxT ? { wallet: 5, bandaid: 3, alarm: 5, study: 5, secondhand: 3, bigbag: 1, luckydraw: 1, collector: 1 } : undefined,
    skillLevels: maxT ? Object.fromEntries(skills.map((k) => [k, 2])) : undefined,
  };
  if (process.env.SIM_OPTS) Object.assign(opts, JSON.parse(process.env.SIM_OPTS));
  const w = createWorld(opts);
  const bot = new StrategyBot(w, params);
  const s = w.state;
  const rows: WaveRow[] = [];
  let leaksWave = 0;
  let peak = 0;
  let cleared = 0;
  let xpProbeLv20 = 0;
  const leakBy = new Map<string, number>();
  let livesTrack = s.lives;
  const maxTicks = 60 * 60 * 60 * 3; // 3 小时游戏时间兜底
  let result: RunResult['result'] = 'cap';
  for (let tick = 0; tick < maxTicks; tick++) {
    if (s.phase === 'won' || s.phase === 'lost') { result = s.phase; break; }
    if (s.phase === 'perk') {
      bot.act('build');
      if ((s.phase as string) === 'perk' && s.perkChoices) {
        // 兜底：选一张不需要目标的
        const c = s.perkChoices.find((x) => !x.needsTower) ?? s.perkChoices[0];
        const uid = [...s.towers.values()].find((t) => t.id !== 'wall' && t.level >= 7 && t.level < 10)?.uid;
        w.command({ type: 'choosePerk', id: c.id, uid });
      }
      continue;
    }
    const auto = s.autoWave.enabled && s.autoWave.started;
    if (sc.mode !== 'campaign' && s.wave >= MAX_WAVE && (s.phase === 'build' || auto)) { result = 'cap'; break; }
    if (s.phase === 'build' && !auto) {
      // 手动开波（简单难度 / 第一波）：建造完立即开波
      bot.act('build');
      w.command({ type: 'startWave' });
    } else if (tick % params.decisionTicks === 0) bot.act(s.phase === 'wave' ? 'wave' : 'build');
    bot.tick();
    w.step();
    if (s.enemies.length > peak) peak = s.enemies.length;
    for (const ev of w.drainEvents()) {
      if (ev.type === 'waveStart') { bot.onWaveStart(ev.wave); livesTrack = s.lives; }
      else if (ev.type === 'leak') { leaksWave++; bot.onLeak(ev.enemy); leakBy.set(ev.enemy, (leakBy.get(ev.enemy) ?? 0) + Math.max(0, livesTrack - ev.lives)); livesTrack = ev.lives; }
      else if (ev.type === 'waveEnd') {
        bot.onWaveEnd();
        cleared = Math.max(cleared, ev.wave);
        const ts = [...s.towers.values()];
        const atk = ts.filter((t) => t.id !== 'wall');
        rows.push({
          wave: ev.wave, time: Math.round(s.time), gold: s.gold, lives: s.lives, leaks: leaksWave,
          avgLevel: atk.length ? atk.reduce((a, t) => a + t.level, 0) / atk.length : 0,
          maxLevel: atk.reduce((a, t) => Math.max(a, t.level), 0),
          towers: atk.length, walls: ts.length - atk.length, alive: s.enemies.length, peakAlive: peak,
        });
        leaksWave = 0;
        peak = s.enemies.length;
        if (ev.wave === 20 && bot.probe) {
          const p = s.towers.get(bot.probe);
          xpProbeLv20 = p && !bot.goldUpgraded.has(p.uid) ? Math.round((p.level + (p.xpNext ? p.xp / p.xpNext : 0)) * 10) / 10 : 0;
        }
      }
    }
  }
  const atk = [...s.towers.values()].filter((t) => t.id !== 'wall');
  const ratio = s.lives / s.maxLives;
  const stars = result === 'won' ? (ratio >= 0.9 ? 3 : ratio >= 0.5 ? 2 : 1) : 0;
  return {
    scenario: sc.id, bot: sc.bot, mode: sc.mode, diff: sc.abyssLevel ? `abyss${sc.abyssLevel}` : sc.diff, map, seed,
    result, wave: s.wave, cleared, lives: s.lives, maxLives: s.maxLives, stars,
    kills: s.stats.kills, leaks: s.stats.leaks, goldEarned: s.stats.goldEarned, towers: atk.length,
    avgLevel: atk.length ? atk.reduce((a, t) => a + t.level, 0) / atk.length : 0, score: s.score,
    xpProbeLv20, perks: s.perks.join('|'), leakBy: [...leakBy].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('|'), ms: Math.round(performance.now() - t0), rows,
  };
}

// ───────────────────────── 统计 ─────────────────────────

export interface ScenarioStats {
  id: string; label: string; target: string; runs: number;
  waves: number[]; median: number; mean: number; min: number; max: number; p25: number; p75: number;
  winRate: number; stars: number[]; xpProbeMedian: number; byMap: Record<string, { median: number; winRate: number }>;
  pass?: boolean;
}

function quantile(a: number[], q: number): number {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function stats(sc: Scenario, rs: RunResult[]): ScenarioStats {
  const waves = rs.map((r) => (r.result === 'won' ? r.wave : r.wave));
  const byMap: ScenarioStats['byMap'] = {};
  for (const m of new Set(rs.map((r) => r.map))) {
    const sub = rs.filter((r) => r.map === m);
    byMap[m] = { median: quantile(sub.map((r) => r.wave), 0.5), winRate: sub.filter((r) => r.result === 'won').length / sub.length };
  }
  const probes = rs.map((r) => r.xpProbeLv20).filter((v) => v > 0);
  const st: ScenarioStats = {
    id: sc.id, label: sc.label, target: sc.target, runs: rs.length, waves,
    median: quantile(waves, 0.5), mean: waves.reduce((a, b) => a + b, 0) / Math.max(1, waves.length),
    min: Math.min(...waves), max: Math.max(...waves), p25: quantile(waves, 0.25), p75: quantile(waves, 0.75),
    winRate: rs.filter((r) => r.result === 'won').length / Math.max(1, rs.length),
    stars: rs.map((r) => r.stars), xpProbeMedian: quantile(probes, 0.5), byMap,
  };
  if (sc.check) st.pass = sc.check(st);
  return st;
}

// ───────────────────────── 输出 ─────────────────────────

function csv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map((v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : /[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n') + '\n';
}

function html(all: ScenarioStats[], base: ScenarioStats[] | null): string {
  const data = JSON.stringify({ all, base });
  return `<!doctype html><meta charset="utf-8"><title>书桌防线 · 平衡模拟报告</title>
<style>
:root{--bg:#faf8f3;--fg:#2b2a28;--mut:#77736b;--bar:#3b6fb6;--base:#c9a227;--ok:#2e8b57;--bad:#c0392b;--card:#fff;--line:#e4dfd3}
@media (prefers-color-scheme:dark){:root{--bg:#1d1c1a;--fg:#ece8df;--mut:#a39e93;--bar:#6c9be0;--base:#d9b43c;--card:#272623;--line:#3a3833}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif}
main{max-width:1000px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}.mut{color:var(--mut)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin-top:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card h2{font-size:15px;margin:0}.tag{font-size:12px;padding:1px 8px;border-radius:99px;color:#fff;margin-left:6px}
.ok{background:var(--ok)}.bad{background:var(--bad)}
svg{width:100%;height:auto;display:block;margin-top:6px}
table{border-collapse:collapse;width:100%;font-size:13px;margin-top:16px}td,th{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left}
.legend span{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 10px}
</style>
<main>
<h1>书桌防线 · 平衡模拟报告</h1>
<div class="mut">生成于 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · 每个场景 ${SEEDS} 个种子 × 地图 · 柱状图为到达波数分布<span class="legend"><span style="background:var(--bar)"></span>本次<span style="background:var(--base)"></span>基线</span></div>
<div class="grid" id="g"></div>
<div style="overflow-x:auto"><table id="t"></table></div>
</main>
<script>
const D=${data};
const g=document.getElementById('g');
const css=getComputedStyle(document.documentElement);
function hist(ws,lo,hi,bins){const h=new Array(bins).fill(0);for(const w of ws){let i=Math.floor((w-lo)/(hi-lo+1e-9)*bins);i=Math.max(0,Math.min(bins-1,i));h[i]++;}return h;}
for(const s of D.all){
  const b=D.base?D.base.find(x=>x.id===s.id):null;
  const ws=s.waves.concat(b?b.waves:[]);
  const lo=Math.max(0,Math.floor(Math.min(...ws)/5)*5),hi=Math.ceil((Math.max(...ws)+1)/5)*5;
  const bins=Math.max(1,Math.min(24,(hi-lo)/ (hi-lo>60?5:hi-lo>24?2:1)));
  const h=hist(s.waves,lo,hi,bins),hb=b?hist(b.waves,lo,hi,bins):null;
  const W=300,H=120,pad=18,bw=(W-pad)/bins,mx=Math.max(...h,...(hb||[0]),1);
  let svg='<svg viewBox="0 0 '+W+' '+(H+18)+'" role="img" aria-label="波数分布">';
  for(let i=0;i<bins;i++){
    if(hb){const bh=hb[i]/mx*(H-10);svg+='<rect x="'+(pad+i*bw+bw*0.5)+'" y="'+(H-bh)+'" width="'+(bw*0.42)+'" height="'+bh+'" fill="var(--base)"/>';}
    const hh=h[i]/mx*(H-10);svg+='<rect x="'+(pad+i*bw+1)+'" y="'+(H-hh)+'" width="'+(bw*(hb?0.42:0.85))+'" height="'+hh+'" fill="var(--bar)" rx="1"><title>'+h[i]+' 局</title></rect>';
  }
  svg+='<line x1="'+pad+'" x2="'+W+'" y1="'+H+'" y2="'+H+'" stroke="var(--line)"/>';
  const ticks=5;for(let k=0;k<=ticks;k++){const v=Math.round(lo+(hi-lo)*k/ticks);svg+='<text x="'+(pad+(W-pad)*k/ticks)+'" y="'+(H+14)+'" font-size="10" fill="var(--mut)" text-anchor="middle">'+v+'</text>';}
  const mxp=pad+(s.median-lo)/(hi-lo)*(W-pad);svg+='<line x1="'+mxp+'" x2="'+mxp+'" y1="0" y2="'+H+'" stroke="var(--fg)" stroke-dasharray="3 3"/>';
  svg+='</svg>';
  const tag=s.pass===undefined?'':'<span class="tag '+(s.pass?'ok':'bad')+'">'+(s.pass?'达标':'未达标')+'</span>';
  const camp=s.id.startsWith('camp');
  const line=camp?'胜率 '+Math.round(s.winRate*100)+'% · 星 '+s.stars.join(' '):'中位 '+s.median+' · P25 '+s.p25.toFixed(0)+' · P75 '+s.p75.toFixed(0)+' · 范围 '+s.min+'–'+s.max;
  const xp=s.xpProbeMedian?' · 纯经验铅笔 W20 中位 Lv'+s.xpProbeMedian:'';
  const bm=Object.entries(s.byMap).map(([m,v])=>m+': '+(camp?Math.round(v.winRate*100)+'%':v.median)).join(' · ');
  const div=document.createElement('div');div.className='card';
  div.innerHTML='<h2>'+s.label+tag+'</h2><div class="mut">目标：'+s.target+'</div>'+svg+'<div>'+line+xp+'</div><div class="mut">'+bm+(b?' · 基线中位 '+b.median+(camp?' / 胜率 '+Math.round(b.winRate*100)+'%':''):'')+'</div>';
  g.appendChild(div);
}
const t=document.getElementById('t');
t.innerHTML='<tr><th>场景</th><th>目标</th><th>局数</th><th>中位</th><th>均值</th><th>胜率</th><th>结论</th></tr>'+D.all.map(s=>'<tr><td>'+s.label+'</td><td>'+s.target+'</td><td>'+s.runs+'</td><td>'+s.median+'</td><td>'+s.mean.toFixed(1)+'</td><td>'+Math.round(s.winRate*100)+'%</td><td>'+(s.pass===undefined?'—':s.pass?'达标':'未达标')+'</td></tr>').join('');
</script>`;
}

// ───────────────────────── 主程序 ─────────────────────────

function main(): void {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const scs = scenarios();
  const allRuns: RunResult[] = [];
  const allStats: ScenarioStats[] = [];
  const t0 = performance.now();
  for (const sc of scs) {
    const rs: RunResult[] = [];
    for (const map of sc.maps) {
      for (let k = 0; k < SEEDS; k++) {
        const r = runOne(sc, map, `${sc.mode}-${map}-${k + 1}`);
        rs.push(r);
        if (!QUIET) {
          const extra = r.xpProbeLv20 ? ` xpPencil@20=Lv${r.xpProbeLv20}` : '';
          process.stdout.write(`${sc.id.padEnd(26)} ${map} ${r.seed.padEnd(16)} ${r.result.padEnd(4)} wave ${String(r.wave).padStart(3)} lives ${r.lives}/${r.maxLives} towers ${r.towers} avgLv ${r.avgLevel.toFixed(1)}${extra} lost: ${r.leakBy} ${r.ms}ms\n`);
        }
      }
    }
    allRuns.push(...rs);
    const st = stats(sc, rs);
    allStats.push(st);
    const camp = sc.mode === 'campaign';
    process.stdout.write(`== ${sc.label}: ${camp ? `win ${Math.round(st.winRate * 100)}% stars [${st.stars.join(',')}]` : `median ${st.median} (P25 ${st.p25.toFixed(0)}, P75 ${st.p75.toFixed(0)}, ${st.min}-${st.max}) byMap ${JSON.stringify(Object.fromEntries(Object.entries(st.byMap).map(([m, v]) => [m, v.median])))}`}${st.xpProbeMedian ? ` xpPencil@20 median Lv${st.xpProbeMedian}` : ''} target: ${sc.target} ${st.pass === undefined ? '' : st.pass ? 'PASS' : 'FAIL'}\n`);
  }
  // CSV
  const runRows: (string | number)[][] = [['scenario', 'bot', 'mode', 'diff', 'map', 'seed', 'result', 'wave', 'cleared', 'lives', 'maxLives', 'stars', 'kills', 'leaks', 'goldEarned', 'towers', 'avgLevel', 'score', 'xpProbeLv20', 'perks', 'livesLostBy', 'ms']];
  for (const r of allRuns) runRows.push([r.scenario, r.bot, r.mode, r.diff, r.map, r.seed, r.result, r.wave, r.cleared, r.lives, r.maxLives, r.stars, r.kills, r.leaks, r.goldEarned, r.towers, r.avgLevel, r.score, r.xpProbeLv20, r.perks, r.leakBy, r.ms]);
  writeFileSync(join(OUT, 'runs.csv'), csv(runRows));
  const waveRows: (string | number)[][] = [['scenario', 'bot', 'mode', 'diff', 'map', 'seed', 'wave', 'time', 'gold', 'lives', 'leaks', 'avgLevel', 'maxLevel', 'towers', 'walls', 'enemiesAlive', 'peakAlive']];
  for (const r of allRuns) for (const w of r.rows) waveRows.push([r.scenario, r.bot, r.mode, r.diff, r.map, r.seed, w.wave, w.time, w.gold, w.lives, w.leaks, w.avgLevel, w.maxLevel, w.towers, w.walls, w.alive, w.peakAlive]);
  writeFileSync(join(OUT, 'waves.csv'), csv(waveRows));
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(allStats, null, 2));
  let base: ScenarioStats[] | null = null;
  const basePath = join(OUT, 'baseline.json');
  if (arg('save-baseline') === 'true') writeFileSync(basePath, JSON.stringify(allStats, null, 2));
  else if (existsSync(basePath)) {
    try {
      base = JSON.parse(readFileSync(basePath, 'utf8')) as ScenarioStats[];
    } catch { base = null; }
  }
  writeFileSync(join(OUT, 'report.html'), html(allStats, base));
  process.stdout.write(`\n${allRuns.length} runs in ${((performance.now() - t0) / 1000).toFixed(1)}s → ${OUT}/{runs.csv,waves.csv,summary.json,report.html}\n`);
}

main();
