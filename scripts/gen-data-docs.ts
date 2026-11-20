/**
 * 书桌防线 · 游戏数据参考文档生成器
 *
 * 用法：
 *   npm run docs:data            （= npx vite-node scripts/gen-data-docs.ts）
 *
 * 输出：docs/guide/数据/*.md（全部自动生成，请勿手改）
 *
 * 原则：
 *  - 所有数字都从 src/core 与 src/config 的真实导出读取，或者在临时 World 里
 *    放塔 / 升级 / 进化后从 getTowerInfo() 读取，保证与游戏一致。
 *  - 少数只存在于 world.ts 内部逻辑、没有导出的数值，会明确标注"取自逻辑"。
 *  - 某个导出缺失时打印警告并跳过对应小节，不会整体失败。
 *  - 输出确定性：固定种子；唯一会变的是生成日期。
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as core from '../src/core';
import * as cfgTowers from '../src/config/towers';
import * as cfgEnemies from '../src/config/enemies';
import * as cfgDifficulty from '../src/config/difficulty';
import * as cfgCampaign from '../src/config/campaign';
import * as cfgMaps from '../src/config/maps';
import * as cfgSkills from '../src/config/skills';
import * as cfgPerks from '../src/config/perks';
import * as cfgEvents from '../src/config/events';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, 'docs', 'guide', '数据');
/** 从输出目录到仓库根的相对前缀 */
const REL = '../../../';

const C: Any = core;
const T: Any = cfgTowers;
const E: Any = cfgEnemies;
const DF: Any = cfgDifficulty;
const CP: Any = cfgCampaign;
const MP: Any = cfgMaps;
const SK: Any = cfgSkills;
const PK: Any = cfgPerks;
const EV: Any = cfgEvents;

const warnings: string[] = [];
function warn(msg: string): void {
  warnings.push(msg);
  console.warn(`[gen-data-docs] 警告：${msg}`);
}

/** 读取一个导出；缺失时警告并返回 undefined */
function need<V = Any>(mod: Any, name: string, where: string): V | undefined {
  const v = mod?.[name];
  if (v === undefined) warn(`缺少导出 ${where}.${name}`);
  return v as V | undefined;
}

/** 运行一个小节；抛错时警告并返回占位文字 */
function section(title: string, fn: () => string): string {
  try {
    return fn();
  } catch (e) {
    warn(`小节「${title}」生成失败：${(e as Error).message}`);
    return `> ⚠️ 本节（${title}）生成失败，已跳过：\`${(e as Error).message.replace(/`/g, "'")}\`\n\n`;
  }
}

// ───────────────────────── 格式化 ─────────────────────────

function num(v: number | undefined | null, d = 2): string {
  if (v === undefined || v === null || Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return '∞';
  const r = Math.round(v * 10 ** d) / 10 ** d;
  return String(r);
}
function pct(v: number, d = 1): string {
  return `${num(v * 100, d)}%`;
}
function esc(s: unknown): string {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}
function table(headers: string[], rows: (string | number)[][]): string {
  const h = `| ${headers.map(esc).join(' | ')} |`;
  const sep = `|${headers.map(() => '---').join('|')}|`;
  const body = rows.map((r) => `| ${r.map((c) => (typeof c === 'number' ? num(c) : String(c).replace(/\n/g, '<br>'))).join(' | ')} |`);
  return [h, sep, ...body].join('\n') + '\n\n';
}
function img(path: string, alt: string, w = 32): string {
  if (!existsSync(join(ROOT, path))) return '';
  return `<img src="${REL}${path}" width="${w}" alt="${alt}">`;
}
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
function unlockText(u: string | undefined): string {
  if (!u || u === 'default') return '默认';
  const m = /^(\d+)-(\d+)$/.exec(u);
  return m ? `战役 ${m[1]}-${m[2]}` : u;
}
const yesNo = (b: unknown) => (b ? '是' : '—');

function header(title: string, intro: string): string {
  return `<!-- 本文件由 scripts/gen-data-docs.ts 自动生成，请勿手改；修改游戏配置后运行 npm run docs:data 重新生成 -->\n\n# ${title}\n\n${intro}\n\n> 返回 [数据索引](./README.md)\n\n`;
}

// ───────────────────────── 通用：难度列表 ─────────────────────────

const DIFF_LABEL: Record<string, string> = { easy: '简单', normal: '普通', hard: '困难', nightmare: '噩梦' };

interface DiffEntry { key: string; label: string; params: Any }
function difficulties(abyssLevels: number[]): DiffEntry[] {
  const out: DiffEntry[] = [];
  const presets = need<Record<string, Any>>(C, 'DIFFICULTY_PRESETS', 'core');
  if (presets) for (const k of Object.keys(presets)) out.push({ key: k, label: DIFF_LABEL[k] ?? k, params: presets[k] });
  const abyss = need<(l: number) => Any>(C, 'abyssParams', 'core');
  if (abyss) for (const L of abyssLevels) out.push({ key: `abyss${L}`, label: `魔境 ${ROMAN[L] ?? L}`, params: abyss(L) });
  return out;
}

// ───────────────────────── 通用：临时 World ─────────────────────────

function scratchWorld(seed = 'docs-scratch', extra: Any = {}): Any {
  const w = C.createWorld({
    mode: 'endless', map: 'ch1', difficulty: 'normal', seed, skills: [], pure: true,
    fixedLayout: true, autoWave: false, ...extra,
  });
  (w.state as Any).gold = 1e9;
  return w;
}
/** 找一个可放置的格子（从中部开始，避开出入口） */
function findCell(w: Any, tower: string, avoid: Set<string> = new Set()): { x: number; y: number } | null {
  const g = w.state.grid;
  for (let y = 2; y < g.rows - 2; y++) {
    for (let x = 0; x < g.cols; x++) {
      if (avoid.has(`${x},${y}`)) continue;
      if (w.canPlace(tower, x, y).ok) return { x, y };
    }
  }
  return null;
}
function placeAt(w: Any, tower: string, x: number, y: number): number {
  const r = w.command({ type: 'place', tower, cx: x, cy: y });
  if (!r.ok) throw new Error(`放置 ${tower}@${x},${y} 失败：${r.reason}`);
  const uid = w.state.grid.towerAt[y * w.state.grid.cols + x];
  // 关掉"撤销全额退款"窗口，使 sellValue 反映真实返还率
  const t = w.state.towers.get(uid);
  if (t) { t.undoUntil = -1; }
  return uid;
}
function placeTower(w: Any, tower: string): number {
  const c = findCell(w, tower);
  if (!c) throw new Error(`找不到可放 ${tower} 的格子`);
  return placeAt(w, tower, c.x, c.y);
}
function statMap(info: Any): Record<string, string> {
  const m: Record<string, string> = {};
  for (const s of info.stats ?? []) m[s.label] = s.value;
  return m;
}
function parseNum(s: string | undefined): number | null {
  if (!s) return null;
  const m = /-?\d+(\.\d+)?/.exec(s);
  return m ? Number(m[0]) : null;
}

// ═════════════════════════ 防御塔 ═════════════════════════

interface LevelRow {
  level: number;
  label: string;
  info: Any;
  invested: number;
  upgradeCost: number | null;
}

interface TowerData {
  id: string;
  levels: LevelRow[];          // Lv1..9（墙 Lv1..3）
  legend: Record<'A' | 'B', LevelRow[]>;   // Lv10, ★1, ★2, ★3
  evoCost: Record<'A' | 'B', (number | null)[]>;
  evoXp: Record<'A' | 'B', number[]>;
}

function collectTower(id: string): TowerData {
  const meta = C.TOWER_META[id];
  const data: TowerData = { id, levels: [], legend: { A: [], B: [] }, evoCost: { A: [], B: [] }, evoXp: { A: [], B: [] } };
  const maxLv = id === 'wall' ? 3 : 10;
  for (const br of ['A', 'B'] as const) {
    const w = scratchWorld(`docs-tower-${id}-${br}`);
    const uid = placeTower(w, id);
    const read = (label: string): LevelRow => {
      const info = w.getTowerInfo(uid);
      const t = w.state.towers.get(uid);
      return { level: info.level, label, info, invested: t?.invested ?? NaN, upgradeCost: info.upgradeCost };
    };
    for (let L = 1; L <= maxLv; L++) {
      const row = read(`Lv${L}`);
      if (L < 10) {
        if (br === 'A') data.levels.push(row);
      } else data.legend[br].push(row);
      if (L < maxLv) {
        const r = w.command({ type: 'upgrade', uid, branch: L === 9 ? br : undefined });
        if (!r.ok) throw new Error(`${meta?.name ?? id} 升级到 Lv${L + 1} 失败：${r.reason}`);
      }
    }
    if (id === 'wall') break;
    // 进化 ★1..★3
    for (let s = 1; s <= 3; s++) {
      const before = w.getTowerInfo(uid);
      data.evoCost[br].push(before.evolveCost);
      data.evoXp[br].push(before.evoXpNext);
      if (before.evolveCost === null) break;
      const r = w.command({ type: 'evolve', uid });
      if (!r.ok) { warn(`${id} ${br} 进化 ★${s} 失败：${r.reason}`); break; }
      data.legend[br].push(read(`★${s}`));
    }
  }
  return data;
}

function towerIcon(id: string, row: LevelRow | null, br: 'A' | 'B' | null, w = 40): string {
  if (id === 'wall') return img(`art/towers/wall_l${row?.level ?? 1}.svg`, id, w);
  if (!row) return img(`art/towers/${id}_t1.svg`, id, w);
  const tier = row.info.tier as number;
  if (tier <= 3) return img(`art/towers/${id}_t${tier}.svg`, id, w);
  return img(`art/towers/${id}_t${tier}${(br ?? 'A').toLowerCase()}.svg`, id, w);
}

function genTowers(): { md: string; summary: TowerData[] } {
  const TM = need<Record<string, Any>>(C, 'TOWER_META', 'core');
  const ids: string[] = C.TOWER_IDS ?? (TM ? Object.keys(TM) : []);
  let md = header('防御塔数据', '每座塔的逐级数值、升级费用、出售返还、经验需求、特性、传奇分支与进化。数值来自临时对局里放塔、逐级升级后 `getTowerInfo()` 读到的面板（普通难度、纯净模式、无相邻加成、无增益），与游戏内显示完全一致。');
  if (!TM || !C.createWorld) return { md: md + '> ⚠️ 缺少 TOWER_META / createWorld，本页跳过。\n', summary: [] };
  const GROWTH = T.GROWTH;
  md += '## 通用规则\n\n';
  md += section('通用规则', () => {
    const rows: string[][] = [];
    if (GROWTH) rows.push(['每级成长', `伤害 ×${GROWTH.damage}，攻击间隔 ×${GROWTH.interval}，射程 +${GROWTH.range} 格`]);
    if (C.rawUpgradeCost) rows.push(['升级费用（无折扣）', `造价 × 0.6 × L^1.25（Lv9→10 再 ×1.5），四舍五入；经验可抵扣最多 50%`]);
    if (C.refundRate) rows.push(['出售返还率', [1, 2, 3, 5, 7, 9, 10].map((L) => `Lv${L} ${pct(C.refundRate(L), 0)}`).join('，') + '（放下 ' + (T.UNDO_SECONDS ?? '?') + ' 秒内且未攻击可全额撤销）']);
    if (C.xpForLevel) rows.push(['升级经验', `Lv1→2 ${C.xpForLevel(1)}，Lv5→6 ${C.xpForLevel(5)}，Lv8→9 ${C.xpForLevel(8)}；经验只能升到 Lv9，Lv9→10 必须花金币并选择传奇分支`]);
    const evo = need<Any>(C, 'EVO', 'core');
    if (evo) rows.push(['传奇进化', `★1/★2/★3 进化经验 ${evo.xp.join(' / ')}；金币进化费用 = 传奇升级费用 × ${evo.costMul.join(' / ')}（经验最多抵扣 50%，★3 只能用金币）；每颗星伤害 ×${evo.dmg}、射程 +${evo.range}、间隔 ×${evo.interval}，辅助/经济塔 +${pct(evo.support, 0)}`]);
    if (C.TIER_NAMES) rows.push(['品阶', `${C.TIER_NAMES.join(' / ')}（Lv1–3 / 4–6 / 7–9 / 10 / ★3）`]);
    if (T.PIGGY_MAX) rows.push(['存钱罐上限', `${T.PIGGY_MAX} 个`]);
    return table(['项目', '数值'], rows);
  });

  const all: TowerData[] = [];
  for (const id of ids) {
    const m = TM[id];
    if (!m) continue;
    md += section(`塔 ${id}`, () => {
      const d = collectTower(id);
      all.push(d);
      let s = `## ${towerIcon(id, null, null, 48)} ${m.name}（${id}）\n\n`;
      s += table(['造价', '定位', '打地面', '打空中', '战役解锁', '说明'], [[
        String(m.cost), m.role, yesNo(m.hitsGround), yesNo(m.hitsAir), unlockText(m.unlock), esc(m.desc),
      ]]);
      // 逐级表
      const rows = [...d.levels, ...d.legend.A.slice(0, 1).map((r) => ({ ...r, label: `Lv10·A` })), ...d.legend.B.slice(0, 1).map((r) => ({ ...r, label: `Lv10·B` }))];
      const labels: string[] = [];
      for (const r of rows) for (const st of r.info.stats) if (!labels.includes(st.label)) labels.push(st.label);
      const head = ['', '等级', '品阶', ...labels, '升级费用', '累计投入', '出售返还', '升级经验'];
      const trs = rows.map((r) => {
        const sm = statMap(r.info);
        const br = r.label.endsWith('B') ? 'B' : r.label.endsWith('A') ? 'A' : null;
        return [
          towerIcon(id, r, br, 28), r.label, esc(r.info.tierName),
          ...labels.map((l) => esc(sm[l] ?? '—')),
          r.upgradeCost === null ? '—' : String(r.upgradeCost),
          String(r.invested), String(r.info.sellValue),
          r.info.xpNext ? (r.level === 9 && id !== 'wall' ? `${r.info.xpNext}（只抵扣费用）` : String(r.info.xpNext)) : '—',
        ];
      });
      s += `### 逐级数值\n\n"升级费用"指从本级升到下一级的金币（无经验折扣、无增益折扣）；"出售返还"为在本级出售的金币（返还率 × 累计投入，向下取整）；"升级经验"为本级升到下一级所需经验。\n\n`;
      s += table(head, trs);
      if (id !== 'wall' && labels.includes('秒伤') && /×N/.test(statMap(d.levels[0].info)['秒伤'] ?? '')) s += '> "×N"：范围攻击，实际秒伤 = 表中数值 × 命中的敌人数。\n\n';
      // 特性
      const lv9 = rows[rows.length - 1].info;
      s += '### 特性\n\n';
      const tr: string[][] = [];
      for (const t of (d.legend.A[0]?.info.traits ?? d.levels[d.levels.length - 1].info.traits) as Any[]) {
        if (t.name.startsWith('传奇·')) continue;
        tr.push([esc(t.name), t.name.startsWith('组合·') ? '相邻组合' : `Lv${t.unlockLevel}`, esc(t.desc)]);
      }
      s += table(['特性', '解锁', '效果'], tr);
      if (id !== 'wall' && lv9.branches) {
        s += '### 传奇分支（Lv9→10 二选一）\n\n';
        s += table(['分支', '', '名称', '效果'], (['A', 'B'] as const).map((b) => [
          b, towerIcon(id, d.legend[b][0] ?? null, b, 32), esc(lv9.branches[b].name), esc(lv9.branches[b].desc),
        ]));
        // 进化
        const evoRows: string[][] = [];
        for (const b of ['A', 'B'] as const) {
          const leg = d.legend[b];
          if (leg.length <= 1) continue;
          for (let k = 1; k < leg.length; k++) {
            const r = leg[k];
            const star = k;
            const tline = star <= 2 ? (r.info.evoTraits?.[star - 1] ?? null) : null;
            const sm = statMap(r.info);
            const key = sm['秒伤'] ? `秒伤 ${sm['秒伤']}` : sm['持续伤害'] ? `持续伤害 ${sm['持续伤害']}` : sm['伤害加成'] ? `伤害加成 ${sm['伤害加成']}` : sm['每波产出'] ? `每波产出 ${sm['每波产出']}` : '';
            evoRows.push([
              `${b} ★${star}`, towerIcon(id, r, b, 28), esc(r.info.tierName),
              String(d.evoCost[b][star - 1] ?? '—'),
              star <= 2 ? String(d.evoXp[b][star - 1] ?? '—') : '只能用金币',
              String(r.invested),
              tline ? `**${esc(tline.name)}**：${esc(tline.desc)}` : star === 3 ? `解锁神话主动能力` : '',
              esc(key), esc(sm['射程'] ?? sm['范围'] ?? sm['光环范围'] ?? ''),
            ]);
          }
        }
        if (evoRows.length) {
          s += '### 传奇进化（★1–★3）\n\n"金币费用"为无经验抵扣时的价格；"进化经验"为不花金币、靠经验升到该星所需的进化经验（★3 只能花金币）。\n\n';
          s += table(['星级', '', '形态', '金币费用', '进化经验', '累计投入', '新特性', '关键数值', '射程/范围'], evoRows);
        }
        const abRows: string[][] = [];
        for (const b of ['A', 'B'] as const) {
          const top = d.legend[b][d.legend[b].length - 1]?.info;
          const ab = top?.ability;
          if (!ab) continue;
          const am = C.ABILITY_META?.[ab.id];
          abRows.push([
            img(`art/abilities/${ab.id}.svg`, ab.name, 32), `${b}`, esc(am?.form ?? ''), esc(ab.name),
            am?.chargeWaves ? `充能：每 ${am.chargeWaves} 波 1 次` : `${num(ab.cdMax)} 秒`,
            esc(targetLabel(ab.target)) + (ab.radius !== undefined ? `（半径 ${num(ab.radius)}）` : ''),
            am?.duration ? `${am.duration} 秒` : '瞬时',
            esc(ab.desc),
          ]);
        }
        if (abRows.length) {
          s += '### ★3 神话主动能力\n\n';
          s += table(['', '分支', '神话形态', '能力', '冷却', '目标', '持续', '效果'], abRows);
        }
      }
      return s;
    });
  }

  // 汇总
  md = md.replace('## 通用规则', `## 汇总对比\n\n<!--SUMMARY-->\n\n## 通用规则`);
  const sumRows: string[][] = [];
  for (const d of all) {
    if (d.id === 'wall') continue;
    const m = TM[d.id];
    const l1 = d.levels[0];
    const dps1 = parseNum(statMap(l1.info)['秒伤']);
    const cell = (r: LevelRow | undefined) => {
      if (!r) return ['—', '—', '—'];
      const sm = statMap(r.info);
      const v = parseNum(sm['秒伤'] ?? sm['持续伤害']);
      return [v === null ? '—' : num(v) + (sm['持续伤害'] && !sm['秒伤'] ? '（持续，递增）' : ''), String(r.invested), v === null ? '—' : num(v / r.invested, 3)];
    };
    const [a10, aInv, aPer] = cell(d.legend.A[0]);
    const [b10, , bPer] = cell(d.legend.B[0]);
    const aoe = /×N/.test(statMap(l1.info)['秒伤'] ?? '') ? ' ×N' : '';
    sumRows.push([
      towerIcon(d.id, null, null, 28), m.name, String(m.cost),
      dps1 === null ? '—' : num(dps1) + aoe, dps1 === null ? '—' : num(dps1 / l1.invested, 3),
      a10, b10, aInv, aPer, bPer,
    ]);
  }
  const sumMd = '数值来自下方各塔的逐级表。"秒伤/金"= 秒伤 ÷ 累计投入。范围塔（×N）的秒伤按单目标计；辅助与经济塔没有秒伤。钢笔的秒伤只含直击，不含墨迹持续伤害（见其逐级表"伤害"列）；台灯 A（激光笔）为持续光束，显示的是起始每秒伤害。\n\n'
    + table(['', '塔', '造价', 'Lv1 秒伤', 'Lv1 秒伤/金', 'Lv10·A 秒伤', 'Lv10·B 秒伤', 'Lv10 累计投入', 'Lv10·A 秒伤/金', 'Lv10·B 秒伤/金'], sumRows);
  md = md.replace('<!--SUMMARY-->', sumMd);
  return { md, summary: all };
}

function targetLabel(t: string): string {
  return ({ none: '无需目标（全局 / 自身）', circle: '圆形区域', rect3: '3×3 区域', direction: '方向', axis: '一行或一列', enemy: '单个敌人', tower: '一座塔', rect2: '2×2 区域', line: '一行或一列', spawner: '空降出生点', 'tower+cell': '塔 + 目标格' } as Record<string, string>)[t] ?? t;
}

// ═════════════════════════ 敌人 ═════════════════════════

const WAVES = [1, 5, 10, 20, 30, 40, 50, 75, 100];

function enemyIcon(id: string, w = 32): string {
  const file = id === 'crumbmini' ? 'crumb' : id === 'boss_coffee_small' ? 'boss_coffee' : id;
  return img(`art/enemies/${file}.svg`, id, w);
}

function genEnemies(): string {
  let md = header('敌人数据', '所有敌人与 Boss 的基础属性、能力、各难度下随波数成长后的生命 / 数量 / 金币 / 经验，以及精英词缀。成长公式全部调用 core 导出的 `hpScale / countScale / goldScale / xpScale / armorAt / speedScale / eliteChance`。');
  const ENEMIES = need<Record<string, Any>>(E, 'ENEMIES', 'config/enemies');
  if (!ENEMIES) return md + '> ⚠️ 缺少 ENEMIES，本页跳过。\n';
  const ids = Object.keys(ENEMIES);
  const normals = ids.filter((i) => !ENEMIES[i].boss);
  const bosses = ids.filter((i) => ENEMIES[i].boss);

  md += section('基础属性', () => {
    const row = (e: Any) => {
      const sp: string[] = [];
      if (e.flying) sp.push('飞行');
      if (e.shieldRatio) sp.push(`护盾 ${pct(e.shieldRatio, 0)} 生命`);
      if (e.stealthy) sp.push('隐形');
      if (e.unstoppable) sp.push('免控');
      if (e.dodge) sp.push(`闪避 ${pct(e.dodge, 0)}`);
      if (e.fast) sp.push('快速（冲锋波 ×2）');
      return [enemyIcon(e.id), `${e.name}<br><sub>${e.id}</sub>`, e.hp, e.speed, e.armor, e.bounty, e.xp, e.lives, e.radius, e.first || '—', e.baseCount || '—', e.interval, e.weight || '—', sp.join('、') || '—', esc(e.desc)];
    };
    const head = ['', '敌人', '生命', '速度(格/秒)', '护甲', '金币', '经验', '扣命', '半径', '无尽首次出现', '基础数量', '出怪间隔', '权重', '特性', '能力'];
    let s = '## 基础属性\n\n### 普通敌人\n\n' + table(head, normals.map((i) => row(ENEMIES[i])));
    s += '### Boss\n\n' + table(head, bosses.map((i) => row(ENEMIES[i])));
    s += '> 护甲按 `armorAt` 随波数增长（每 armorStep 波 +1，仅对基础护甲 > 0 的敌人）；速度按 `speedScale` 每波 +0.5%，最多 ×1.5。Boss 生命额外乘以难度的 bossHpMul。\n\n';
    return s;
  });

  md += section('精英与词缀', () => {
    let s = '## 精英与词缀\n\n';
    const ELITE = need<Any>(E, 'ELITE', 'config/enemies');
    if (ELITE) s += `精英：生命 ×${ELITE.hp}，体型 ×${ELITE.scale}，金币 ×${ELITE.bounty}，经验 ×${ELITE.xp}。每个精英随机 1～maxAffix 个词缀（Boss 不会成为精英）。\n\n`;
    const AFF = need<Record<string, Any>>(E, 'AFFIXES', 'config/enemies');
    const nm = (id: string) => ENEMIES[id]?.name ?? id;
    if (AFF) {
      s += table(['', '词缀', '效果', '互斥', '不会出现在'], Object.values(AFF).map((a: Any) => [
        img(`art/affixes/${a.id}.svg`, a.id), `${a.name}<br><sub>${a.id}</sub>`, esc(a.desc),
        (a.excludes ?? []).map((x: string) => AFF[x]?.name ?? x).join('、') || '—',
        (a.notOn ?? []).map(nm).join('、') || '—',
      ]));
    }
    if (C.eliteChance) {
      s += '### 精英概率（每个非 Boss 敌人）\n\n';
      const ds = difficulties([1, 5, 10]);
      const ws = [1, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100];
      s += table(['难度', '起始波', '每波 +', '上限', '最多词缀', ...ws.map((w) => `W${w}`)], ds.map((d) => [
        d.label, d.params.eliteStart > 999 ? '不出现' : num(d.params.eliteStart), pct(d.params.eliteRate), pct(d.params.eliteCap, 0), d.params.maxAffix,
        ...ws.map((w) => { const p = C.eliteChance(d.params, w); return p > 0 ? pct(p) : '—'; }),
      ]));
    }
    return s;
  });

  md += section('成长', () => {
    let s = '## 各难度成长\n\n';
    s += '"基准数量"为普通波的敌人总数基准；"实际总数"为该波无尽模式实际生成的敌人数量（Boss 波普通敌人 ×0.3，冲锋波快速敌人 ×2）（`generateWave`，种子 `docs`，地图 ch1，含兵团合并）；"HP 倍率"= hpScale；金币 / 经验倍率 = goldScale / xpScale。\n\n';
    const ds = difficulties([1, 5, 10]);
    for (const d of ds) {
      const P = d.params;
      s += `### ${d.label}\n\n`;
      const totals = WAVES.map((w) => {
        try {
          const plan = C.generateWave({ seed: 'docs', mode: 'endless', map: 'ch1', params: P }, w);
          const n = plan.groups.reduce((a: number, g: Any) => a + g.count, 0);
          const tag = (plan.tags ?? []).map((t: string) => ({ boss: 'Boss', air: '空袭', rush: '冲锋' } as Record<string, string>)[t] ?? t).join('');
          return tag ? `${n}（${tag}）` : String(n);
        } catch { return '—'; }
      });
      s += table(['波数', ...WAVES.map((w) => `W${w}`)], [
        ['HP 倍率', ...WAVES.map((w) => num(C.hpScale(P, w)))],
        ['数量系数', ...WAVES.map((w) => num(C.countScale(P, w)))],
        ['基准数量 round(9×系数)', ...WAVES.map((w) => String(Math.max(1, Math.round(9 * C.countScale(P, w)))))],
        ['实际总数', ...totals],
        ['速度倍率', ...WAVES.map((w) => num(C.speedScale(P, w), 3))],
        ['金币倍率', ...WAVES.map((w) => num(C.goldScale(P, w)))],
        ['经验倍率', ...WAVES.map((w) => num(C.xpScale(P, w)))],
        ['精英概率', ...WAVES.map((w) => { const p = C.eliteChance(P, w); return p > 0 ? pct(p) : '—'; })],
      ]);
      s += `<details><summary>${d.label}：各敌人生命 / 护甲 / 金币 / 经验</summary>\n\n`;
      s += table(['敌人', ...WAVES.map((w) => `W${w}`)], ids.map((id) => {
        const e = ENEMIES[id];
        return [`${e.name}`, ...WAVES.map((w) => {
          const hp = e.hp * C.hpScale(P, w) * (e.boss ? P.bossHpMul : 1);
          const ar = C.armorAt(P, e.armor, w);
          return `${Math.round(hp)}${ar ? ` 🛡${ar}` : ''}<br>${num(e.bounty * C.goldScale(P, w), 1)}金 / ${num(e.xp * C.xpScale(P, w), 1)}经`;
        })];
      }));
      s += '</details>\n\n';
    }
    return s;
  });
  return md;
}

// ═════════════════════════ 难度参数 ═════════════════════════

const PARAM_LABEL: Record<string, string> = {
  startGold: '初始金币', lives: '生命', hpMul: '生命倍率', hpLinear: '生命线性增长/波', hpExp: '生命指数增长/波',
  countMul: '数量倍率', countGrowth: '数量增长/波', speedMul: '速度倍率', armorStep: '护甲 +1 间隔（波）',
  rewardMul: '金币倍率', xpMul: '经验倍率', eliteStart: '精英起始波', eliteRate: '精英概率增长/波', eliteCap: '精英概率上限',
  maxAffix: '最多词缀数', bossHpMul: 'Boss 生命倍率', skillCdMul: '技能冷却倍率', interestCap: '利息上限', scoreMul: '得分倍率',
  spawnMode: '默认出怪策略', maxActiveSpawners: '同时开放出生点上限', maxDrops: '空降出生点上限', dropWarn: '空降预警（秒）',
  eventRate: '随机事件频率', eventHostile: '负面事件占比', waveGap: '自动开波间隔（秒）', waveMax: '每波最长时间（秒）',
};
const SPAWN_MODE_LABEL: Record<string, string> = { fixed: '固定', roundRobin: '轮流', random: '随机', split: '包夹', focus: '集中' };

function genDifficulty(): string {
  let md = header('难度参数', '每个预设难度与魔境 I–X 的完整 `DifficultyParams`（`DIFFICULTY_PRESETS` 与 `abyssParams(n)` 的返回值）。战役只有普通 / 困难两档。');
  md += section('难度参数表', () => {
    const ds = difficulties([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    if (!ds.length) return '> ⚠️ 无难度数据。\n';
    const keys: string[] = [];
    for (const d of ds) for (const k of Object.keys(d.params)) if (!keys.includes(k)) keys.push(k);
    const fmtV = (k: string, v: Any) => {
      if (k === 'spawnMode') return SPAWN_MODE_LABEL[v] ?? String(v);
      if (k === 'eliteStart' && v > 999) return '不出现';
      if (k === 'eliteRate' || k === 'eliteCap' || k === 'eventHostile') return pct(v);
      return typeof v === 'number' ? num(v, 4) : String(v);
    };
    const pre = ds.filter((d) => !d.key.startsWith('abyss'));
    const ab = ds.filter((d) => d.key.startsWith('abyss'));
    let s = '## 预设难度\n\n';
    s += table(['参数', '字段', ...pre.map((d) => d.label)], keys.map((k) => [PARAM_LABEL[k] ?? k, `\`${k}\``, ...pre.map((d) => fmtV(k, d.params[k]))]));
    s += '## 魔境 I–X\n\n';
    s += table(['参数', '字段', ...ab.map((d) => ROMAN[Number(d.key.slice(5))] ?? d.key)], keys.map((k) => [PARAM_LABEL[k] ?? k, `\`${k}\``, ...ab.map((d) => fmtV(k, d.params[k]))]));
    const per = DF.ABYSS_PER_LEVEL;
    if (per) {
      s += '### 魔境每级增量\n\n' + table(['参数', '每升 1 级'], Object.entries(per).map(([k, v]) => [PARAM_LABEL[k] ?? k, (Number(v) > 0 ? '+' : '') + num(Number(v), 4)]));
      s += '> 另有上下限（见 `abyssParams`）：生命每 2 级 −1（最少 5），护甲间隔每 3 级 −1（最少 4），速度 ≤1.3，金币/经验倍率 ≥0.6，精英起始 ≥3，精英上限 ≤70%，V 级起最多 4 个词缀，开波间隔 ≥10 秒，每波最长 ≥40 秒，空降预警 ≥2.5 秒，事件频率 ≤1.5，负面占比 ≤72%。上表已经是应用这些限制后的实际值。\n\n';
    }
    if (C.resolveParams && C.MAP_META) {
      const rows: string[][] = [];
      for (const map of Object.keys(C.MAP_META)) for (const diff of ['normal', 'hard']) {
        const P = C.resolveParams({ mode: 'campaign', map, difficulty: diff, skills: [] });
        const base = C.DIFFICULTY_PRESETS?.[diff] ?? {};
        const delta = keys.filter((k) => P[k] !== base[k]).map((k) => `${PARAM_LABEL[k] ?? k} ${fmtV(k, base[k])} → ${fmtV(k, P[k])}`);
        rows.push([`${C.MAP_META[map].name}（${map}）`, DIFF_LABEL[diff], delta.join('<br>') || '与预设相同']);
      }
      s += '## 战役实际参数\n\n战役只有普通 / 困难两档，`resolveParams` 可能按章节再做调整；下表列出与对应预设不同的字段。\n\n' + table(['章节', '难度', '与预设的差异'], rows);
    }
    const INK = C.INK_FACTOR;
    if (INK) s += '## 墨水结算系数\n\n' + table(['难度', '每撑过 1 波获得墨水'], Object.entries(INK).map(([k, v]) => [DIFF_LABEL[k] ?? (k === 'abyss' ? '魔境' : k), `×${v}`]));
    const CAPS = C.CAPS;
    if (CAPS) s += '## 全局上限\n\n' + table(['项目', '数值'], [['场上敌人上限', CAPS.maxOnField], ['单波敌人上限（超出时同类合并为兵团）', CAPS.maxPerWave]]);
    return s;
  });
  return md;
}

// ═════════════════════════ 波次 ═════════════════════════

function genWaves(): string {
  let md = header('波次', '战役三章（普通 / 困难）的固定波次、无尽模式的 Boss 轮换、敌人解锁波次与特殊波规则，以及固定种子下无尽前 30 波的生成样例。');
  const ENEMIES: Record<string, Any> = E.ENEMIES ?? {};
  const nm = (id: string) => ENEMIES[id]?.name ?? id;

  const describePlan = (plan: Any, P: Any) => {
    const byEnemy = new Map<string, { n: number; hp: number; elite: number }>();
    for (const e of plan.entries) {
      const def = ENEMIES[e.enemy];
      const hp = def ? def.hp * C.hpScale(P, plan.effWave) * (def.boss ? P.bossHpMul : 1) * (e.hpMul ?? 1) : NaN;
      const k = `${e.enemy}|${Math.round(hp)}`;
      const g = byEnemy.get(k) ?? { n: 0, hp, elite: 0 };
      g.n += e.group;
      if (e.elite) g.elite += e.group;
      byEnemy.set(k, g);
    }
    const parts: string[] = [];
    let total = 0;
    let elites = 0;
    for (const [k, g] of byEnemy) {
      const id = k.split('|')[0];
      parts.push(`${nm(id)}×${g.n}（HP ${Math.round(g.hp)}）`);
      total += g.n;
      elites += g.elite;
    }
    const spawnNotes: string[] = [];
    (plan.groupSpawn ?? []).forEach((gs: Any, i: number) => {
      if (!gs.mode) return;
      spawnNotes.push(`${SPAWN_MODE_LABEL[gs.mode] ?? gs.mode}${gs.from ? `(${gs.from})` : ''}`);
      void i;
    });
    return { parts, total, elites, spawnNotes };
  };
  const TAG: Record<string, string> = { boss: 'Boss', air: '空袭', rush: '冲锋' };

  md += section('战役', () => {
    const CAMPAIGN = need<Record<string, Any>>(CP, 'CAMPAIGN', 'config/campaign');
    if (!CAMPAIGN || !C.generateWave) return '';
    let s = '## 战役波次\n\n每章 ' + (C.CAMPAIGN_WAVES ?? 20) + ' 波。"有效波"= 波数 + 章节偏移，成长公式按有效波计算；数量按难度的 countMul 取整；HP 已含 Boss 倍率与小 Boss 系数（' + (CP.CAMPAIGN_MINI_BOSS_HP ?? '?') + '）。精英数为种子 `docs` 下的一次抽样。\n\n';
    for (const [map, ch] of Object.entries(CAMPAIGN)) {
      const mname = C.MAP_META?.[map]?.name ?? map;
      for (const diff of ['normal', 'hard']) {
        const P = C.resolveParams({ mode: 'campaign', map, difficulty: diff, skills: [] });
        s += `### 第 ${ch.chapter} 章 ${mname}（${DIFF_LABEL[diff]}，章节偏移 +${ch.waveOffset}，生命倍率 ${num(P.hpMul, 3)}，章末 Boss：${nm(ch.boss)}）\n\n`;
        const rows: string[][] = [];
        for (let w = 1; w <= ch.waves.length; w++) {
          const plan = C.generateWave({ seed: 'docs', mode: 'campaign', map, params: P }, w);
          const d = describePlan(plan, P);
          rows.push([String(w), String(plan.effWave), (plan.tags ?? []).map((t: string) => TAG[t] ?? t).join('、') || '—', d.parts.join('，'), String(d.total), d.elites ? String(d.elites) : '—', d.spawnNotes.join('，') || '—']);
        }
        s += table(['波', '有效波', '标签', '敌人（数量与单体生命）', '总数', '精英', '出怪策略'], rows);
      }
    }
    return s;
  });

  md += section('无尽规则', () => {
    let s = '## 无尽模式\n\n';
    const POOL: string[] | undefined = E.ENDLESS_POOL;
    if (POOL) {
      s += '### 敌人解锁波次\n\n' + table(['', '敌人', '首次出现', '权重', '基础数量'], POOL.map((id) => [enemyIcon(id, 24), nm(id), `第 ${ENEMIES[id].first} 波`, ENEMIES[id].weight, ENEMIES[id].baseCount]));
      s += '> 新敌人解锁后的 3 波内必定出现。每波种类数 = min(4, 2 + ⌊波数/20⌋ + 50% 概率 +1)，Boss 波最多 2 种。\n\n';
    }
    const MAPS = MP.MAPS;
    if (MAPS && MP.spawnerOpenWave) {
      s += '### 出生点开放\n\n' + table(['地图', '出生点', '类型', '无尽开放', '战役开放', '随机权重'], Object.values(MAPS).flatMap((m: Any) => m.spawners.map((sp: Any) => {
        const ow = MP.spawnerOpenWave(sp, false);
        const cw = MP.spawnerOpenWave(sp, true);
        return [m.name, `${sp.name}（${sp.id}）`, sp.kind === 'hidden' ? '暗门（事件开启）' : '边缘', ow ? `第 ${ow} 波` : '—', cw ? `第 ${cw} 波` : '—', sp.weight];
      })));
    }
    if (C.bossesForWave) {
      const rows: string[][] = [];
      for (let w = 10; w <= 120; w += 10) rows.push([`第 ${w} 波`, C.bossesForWave(w).map(nm).join(' + ')]);
      s += '### Boss 轮换\n\n每 10 波一次 Boss 波，按顺序轮换；50 波起每次 2 个，100 波起 3 个。Boss 波的普通敌人数量 ×0.3（至少 3）。\n\n' + table(['波', 'Boss'], rows);
    }
    if (C.generateWave && C.DIFFICULTY_PRESETS) {
      const P = C.DIFFICULTY_PRESETS.normal;
      const air: number[] = [];
      const rush: number[] = [];
      const pincer: number[] = [];
      for (let w = 1; w <= 60; w++) {
        const plan = C.generateWave({ seed: 'docs', mode: 'endless', map: 'ch1', params: P }, w);
        if (plan.tags.includes('air')) air.push(w);
        if (plan.tags.includes('rush')) rush.push(w);
        if ((plan.groupSpawn ?? []).some((g: Any) => g.mode === 'split')) pincer.push(w);
      }
      s += '### 特殊波（1–60 波实测）\n\n';
      s += table(['类型', '规则', '1–60 波中出现于'], [
        ['空袭', '非 Boss 波且波数为 7 的倍数：已解锁的飞行敌人优先，占 60% 数量', air.join('、')],
        ['冲锋', '非 Boss、非空袭且波数为 5 的倍数：至少一种快速敌人，快速敌人数量 ×2、生命 ×0.8，整组从同一出生点出来', rush.join('、')],
        ['包夹', '12 波起、波数除以 8 余 4 且非 Boss / 冲锋：每组平均分配到各出生点同时出现', pincer.join('、')],
      ]);
      s += '> 规则描述取自 `wavegen.ts` 逻辑；右列为调用 `generateWave` 实测得到的波数。\n\n';
    }
    return s;
  });

  md += section('无尽样例', () => {
    if (!C.generateWave || !C.DIFFICULTY_PRESETS) return '';
    let s = '## 无尽前 30 波样例\n\n种子 `docs-sample`，地图 ch1。每局种子不同，敌人种类与精英会变，但数量与生命只取决于难度和波数。\n\n';
    for (const diff of ['normal', 'nightmare']) {
      const P = C.DIFFICULTY_PRESETS[diff];
      if (!P) continue;
      const rows: string[][] = [];
      for (let w = 1; w <= 30; w++) {
        const plan = C.generateWave({ seed: 'docs-sample', mode: 'endless', map: 'ch1', params: P }, w);
        const d = describePlan(plan, P);
        rows.push([String(w), (plan.tags ?? []).map((t: string) => TAG[t] ?? t).join('、') || '—', d.parts.join('，'), String(d.total), d.elites ? String(d.elites) : '—', d.spawnNotes.join('，') || '—']);
      }
      s += `### ${DIFF_LABEL[diff]}\n\n` + table(['波', '标签', '敌人（数量与单体生命）', '总数', '精英', '特殊出怪'], rows);
    }
    return s;
  });
  return md;
}

// ═════════════════════════ 技能 / 增益 / 天赋 / 事件 ═════════════════════════

function genSkills(): string {
  let md = header('技能、增益、天赋与随机事件', '玩家主动技能、局内增益卡、永久天赋、随机事件、补给箱与拾取物。技能冷却由临时对局按技能等级实际读出。');
  md += section('技能', () => {
    const SM = need<Record<string, Any>>(C, 'SKILL_META', 'core');
    if (!SM) return '';
    const SL = SK.SKILL_LEVEL;
    const RC = SK.RELOCATE_CHARGES;
    const ids = Object.keys(SM);
    // 各等级冷却（普通难度）
    const cdBy = (diff: string, lvl: number): Record<string, Any> => {
      const out: Record<string, Any> = {};
      for (let i = 0; i < ids.length; i += 3) {
        const chunk = ids.slice(i, i + 3);
        const w = C.createWorld({ mode: 'endless', map: 'ch1', difficulty: diff, seed: 'docs-skill', skills: chunk, pure: true, fixedLayout: true, autoWave: false, skillLevels: Object.fromEntries(chunk.map((id) => [id, lvl])) });
        for (const sk of w.state.skills) out[sk.id] = sk;
      }
      return out;
    };
    const lv = [1, 2, 3].map((l) => cdBy('normal', l));
    let s = '## 主动技能\n\n';
    if (SL) s += `技能可用墨水升到 Lv${SL.maxLevel}：每级冷却 −${pct(SL.cdPerLevel, 0)}、效果 +${pct(SL.effectPerLevel, 0)}${RC ? `；搬家的充能次数为 ${RC.join(' / ')}${SK.RELOCATE_RECOVER_WAVES ? `，每 ${SK.RELOCATE_RECOVER_WAVES} 波恢复 1 次` : ''}` : ''}。`;
    try {
      const prog = require0('../src/meta/progress');
      if (prog?.skillUpgradeCost) s += ` 升级价格：Lv1→2 ${prog.skillUpgradeCost(1)} 墨水，Lv2→3 ${prog.skillUpgradeCost(2)} 墨水。`;
    } catch { /* ignore */ }
    s += '下表冷却为普通难度（skillCdMul = 1），无天赋。\n\n';
    const eff = (l: number) => (SL ? `×${num(1 + SL.effectPerLevel * (l - 1))}` : '—');
    s += table(['', '技能', '解锁', '目标', '冷却 Lv1', 'Lv2', 'Lv3', '效果倍率 Lv1/2/3', '说明'], ids.map((id) => {
      const m = SM[id];
      const cd = (l: number) => {
        const st = lv[l - 1][id];
        if (!st) return '—';
        return id === 'relocate' ? `${st.maxCharges} 次充能` : `${num(st.cdMax, 1)} 秒`;
      };
      return [img(`art/skills/${id}.svg`, id), `${m.name}<br><sub>${id}</sub>`, unlockText(m.unlock), targetLabel(m.target) + (m.radius ? `（半径 ${m.radius}）` : ''), cd(1), cd(2), cd(3), id === 'relocate' || id === 'seal_tape' ? '—' : [1, 2, 3].map(eff).join(' / '), esc(m.desc)];
    }));
    // 各难度冷却
    const ds = difficulties([1, 10]);
    const cdDiff = ds.map((d) => {
      const out: Record<string, Any> = {};
      const diff = d.key.startsWith('abyss') ? 'abyss' : d.key;
      const abyssLevel = d.key.startsWith('abyss') ? Number(d.key.slice(5)) : undefined;
      for (let i = 0; i < ids.length; i += 3) {
        const chunk = ids.slice(i, i + 3);
        const w = C.createWorld({ mode: 'endless', map: 'ch1', difficulty: diff, abyssLevel, seed: 'docs-skill', skills: chunk, pure: true, fixedLayout: true, autoWave: false });
        for (const sk of w.state.skills) out[sk.id] = sk;
      }
      return out;
    });
    const rows = ids.filter((id) => id !== 'relocate').map((id) => [SM[id].name, ...cdDiff.map((m) => (m[id] ? num(m[id].cdMax, 1) : '—'))]);
    s += '### 各难度 Lv1 冷却（秒）\n\n临时对局实测（= 基础冷却 × 难度 skillCdMul，保留 1 位小数）。\n\n' + table(['技能', ...ds.map((d) => d.label)], rows);
    return s;
  });

  md += section('增益', () => {
    const PM = need<Any[]>(C, 'PERK_META', 'core');
    if (!PM) return '';
    const RL: Record<string, string> = { common: '普通', rare: '稀有', epic: '史诗' };
    const PERKS: Any[] = PK.PERKS ?? [];
    const rep = new Set(PERKS.filter((p) => p.repeatable).map((p) => p.id));
    let s = '## 局内增益\n\n';
    if (PK.RARITY_WEIGHT) s += `稀有度权重：${Object.entries(PK.RARITY_WEIGHT).map(([k, v]) => `${RL[k] ?? k} ${v}`).join('，')}${PK.EPIC_LATE_WAVE ? `；第 ${PK.EPIC_LATE_WAVE} 波起史诗权重提高到 ${PK.EPIC_WEIGHT_LATE}` : ''}${PK.PERK_REROLL_COST ? `；刷新一次 ${PK.PERK_REROLL_COST} 金币` : ''}。\n\n`;
    s += table(['增益', '稀有度', '效果', '需选塔', '可重复'], PM.map((p) => [`${p.name}<br><sub>${p.id}</sub>`, RL[p.rarity] ?? p.rarity, esc(p.desc), yesNo(p.needsTower), yesNo(rep.has(p.id))]));
    return s;
  });

  md += section('天赋', () => {
    const TM = need<Record<string, Any>>(C, 'TALENT_META', 'core');
    if (!TM) return '';
    let s = '## 永久天赋\n\n每升 1 级可以用星星或墨水任选其一支付（价格见下）。纯净模式下天赋不生效。\n\n';
    s += table(['天赋', '每级效果', '最高等级', '每级价格（星星）', '每级价格（墨水）', '满级总价'], Object.entries(TM).map(([id, t]: [string, Any]) => [
      `${t.name}<br><sub>${id}</sub>`, esc(t.desc), t.max, `${t.star}⭐`, `${t.ink}💧`, `${t.star * t.max}⭐ 或 ${t.ink * t.max}💧`,
    ]));
    return s;
  });

  md += section('随机事件', () => {
    const RE = need<Record<string, Any>>(C, 'RANDOM_EVENTS', 'core');
    if (!RE) return '';
    const TONE: Record<string, string> = { bad: '负面', good: '正面', neutral: '中性' };
    let s = '## 随机事件\n\n';
    const ED = EV.EVENT_DIRECTOR;
    if (ED) s += `事件导演：两次事件之间间隔 ${ED.gapMin}～${ED.gapMax} 波 ÷ 难度 eventRate；开波后 ${ED.offsetMin}～${ED.offsetMax} 秒触发；先按难度 eventHostile 决定是否负面，非负面事件中正面占 ${pct(ED.goodShare, 0)}。同一 tone 内按权重抽取，同标签事件不会同时进行。\n\n`;
    const order = ['bad', 'good', 'neutral'];
    const list = Object.values(RE).sort((a: Any, b: Any) => order.indexOf(a.tone) - order.indexOf(b.tone));
    s += table(['', '事件', '类型', '权重', '最早波数', '冷却（波）', '预警', '持续', '标签', '效果'], list.map((e: Any) => [
      img(`art/events/${e.id}.svg`, e.id), `${e.name}<br><sub>${e.id}</sub>`, TONE[e.tone] ?? e.tone, e.weight, e.minWave, e.cooldown,
      e.warn === 'drop' ? '难度 dropWarn' : e.warn ? `${e.warn} 秒` : '无', e.duration ? `${e.duration} 秒` : '瞬时', (e.tags ?? []).join(', ') || '—', esc(e.desc),
    ]));
    const DROP = C.DROP;
    if (DROP) {
      s += '### 空降出生点\n\n' + table(['参数', '数值'], [
        ['离出口最短距离', `${DROP.minExitDist} 格`], ['持续', `${DROP.minWaves}～${DROP.maxWaves} 波`],
        ['分走本波敌人比例', `${pct(DROP.ratioMin, 0)}～${pct(DROP.ratioMax, 0)}`], ['拆除费用', `${DROP.demolishBase} + ${DROP.demolishPerWave}×波数 金币`],
      ]);
    }
    return s;
  });

  md += section('补给箱与拾取物', () => {
    const CO = need<Any[]>(C, 'CRATE_OPTIONS', 'core');
    let s = '## 补给箱与拾取物\n\n';
    if (CO) s += '### 补给箱（打开后从下列 6 项中随机三选一）\n\n' + table(['', '奖励', '效果'], CO.map((o) => [img('art/events/supply_crate.svg', 'crate', 24), `${o.name}<br><sub>${o.id}</sub>`, esc(o.desc)]));
    s += '### 拾取物\n\n' + table(['', '拾取物', '来源', '说明'], [
      [img('art/events/coins.svg', 'coin', 24), '硬币', '「掉落零花钱」事件', `出现 3～5 枚，每枚 round(3 + 0.4×波数) 金币，${C.RANDOM_EVENTS?.coins?.duration ?? '?'} 秒内点击收集`],
      [img('art/events/supply_crate.svg', 'crate', 24), '补给箱', '「补给箱」事件', `${C.RANDOM_EVENTS?.supply_crate?.duration ?? '?'} 秒内点击打开，三选一`],
    ]);
    s += '> 硬币数量与面值取自 `world.ts` 逻辑（未导出为常量），若平衡调整改动了这里，需要同步更新本脚本。\n\n';
    return s;
  });
  return md;
}

/** 可选依赖（失败时返回 null） */
const optionalMods: Record<string, Any> = {};
function require0(p: string): Any {
  return optionalMods[p] ?? null;
}

// ═════════════════════════ 组合与加成 ═════════════════════════

function genCombos(): string {
  let md = header('组合与加成', '相邻组合技、书本墙相邻加成与计算器光环。下方"实测"列是在临时对局里把两座 Lv1 塔上下左右相邻摆放后，`getTowerInfo()` 面板相对单独摆放时的变化。');
  const TM = C.TOWER_META ?? {};
  const nm = (id: string) => TM[id]?.name ?? id;
  const diffStats = (a: Record<string, string>, b: Record<string, string>) => {
    const out: string[] = [];
    for (const k of Object.keys(b)) if (a[k] !== b[k]) out.push(`${k}：${a[k] ?? '—'} → ${b[k]}`);
    return out.join('<br>') || '面板无变化（效果在战斗中结算）';
  };
  const pairWorld = (a: string, b: string, aLv = 1, bLv = 1) => {
    const w = scratchWorld(`docs-combo-${a}-${b}`);
    const g = w.state.grid;
    for (let y = 2; y < g.rows - 3; y++) for (let x = 0; x < g.cols - 1; x++) {
      if (!w.canPlace(a, x, y).ok) continue;
      const ua = placeAt(w, a, x, y);
      if (w.canPlace(b, x + 1, y).ok) {
        const ub = placeAt(w, b, x + 1, y);
        for (let i = 1; i < aLv; i++) w.command({ type: 'upgrade', uid: ua });
        for (let i = 1; i < bLv; i++) w.command({ type: 'upgrade', uid: ub });
        return { w, ua, ub };
      }
      w.command({ type: 'sell', uid: ua });
    }
    throw new Error(`找不到相邻位置 ${a}/${b}`);
  };
  const solo = (id: string, lv = 1) => {
    const w = scratchWorld(`docs-solo-${id}`);
    const u = placeTower(w, id);
    for (let i = 1; i < lv; i++) w.command({ type: 'upgrade', uid: u });
    return w.getTowerInfo(u);
  };

  md += section('组合技', () => {
    const COMBOS = need<Any[]>(C, 'COMBOS', 'core');
    if (!COMBOS) return '';
    let s = '## 相邻组合技\n\n两座塔上下左右相邻即激活（斜向不算），双方面板都会显示组合特性。\n\n';
    const rows = COMBOS.map((cb) => {
      let a = '—';
      let b = '—';
      let on = '—';
      try {
        const { w, ua, ub } = pairWorld(cb.a, cb.b);
        const ia = w.getTowerInfo(ua);
        const ib = w.getTowerInfo(ub);
        a = diffStats(statMap(solo(cb.a)), statMap(ia));
        b = diffStats(statMap(solo(cb.b)), statMap(ib));
        on = ia.traits.some((t: Any) => t.name === `组合·${cb.name}` && t.unlocked) ? '✔' : '✘';
      } catch (e) { warn(`组合 ${cb.name} 实测失败：${(e as Error).message}`); }
      return [`${towerIcon(cb.a, null, null, 24)}${towerIcon(cb.b, null, null, 24)}`, cb.name, `${nm(cb.a)} + ${nm(cb.b)}`, esc(cb.desc), on, `${nm(cb.a)}：${a}<br>${nm(cb.b)}：${b}`];
    });
    s += table(['', '组合', '塔', '效果', '实测激活', '实测面板变化（Lv1）'], rows);
    return s;
  });

  md += section('书本墙加成', () => {
    let s = '## 书本墙相邻加成\n\n攻击塔上下左右相邻的书本墙取最高等级生效（不叠加）。升级费用：';
    const W = T.WALL_UPGRADE_COST;
    s += W ? `Lv1→2 ${W[1]} 金币，Lv2→3 ${W[2]} 金币。\n\n` : '（缺少 WALL_UPGRADE_COST）\n\n';
    const rows: string[][] = [];
    const base = statMap(solo('pencil'));
    rows.push(['无墙', '—', base['伤害'] ?? '—', base['射程'] ?? '—', base['秒伤'] ?? '—']);
    for (const lv of [1, 2, 3]) {
      try {
        const { w, ub } = pairWorld('wall', 'pencil', lv, 1);
        const sm = statMap(w.getTowerInfo(ub));
        const wallInfo = [...w.state.towers.values()].find((t: Any) => t.id === 'wall');
        const wm = wallInfo ? statMap(w.getTowerInfo(wallInfo.uid)) : {};
        rows.push([`书本墙 Lv${lv}`, wm['相邻加成'] ?? '—', sm['伤害'] ?? '—', sm['射程'] ?? '—', sm['秒伤'] ?? '—']);
      } catch (e) { warn(`书本墙 Lv${lv} 实测失败：${(e as Error).message}`); }
    }
    s += '以相邻一座 Lv1 铅笔塔为例（实测）：\n\n' + table(['相邻墙', '墙面板', '铅笔伤害', '铅笔射程', '铅笔秒伤'], rows);
    return s;
  });

  md += section('计算器光环', () => {
    let s = '## 计算器光环（实测）\n\n光环内的攻击塔获得加成；多个计算器默认取最高值（「学霸光环」增益后可叠加）。光环内的塔每获得经验，计算器分到 10%。\n\n';
    const rows: string[][] = [];
    const levels = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    for (const L of levels) {
      const sm = statMap(solo('calculator', L));
      rows.push([`Lv${L}`, sm['光环范围'] ?? '—', sm['伤害加成'] ?? '—', sm['攻速加成'] ?? '—', sm['射程加成'] ?? '—']);
    }
    s += table(['计算器等级', '光环范围', '伤害加成', '攻速加成', '射程加成'], rows);
    try {
      const { w, ua, ub } = pairWorld('calculator', 'pencil', 9, 1);
      void ua;
      s += `例：Lv9 计算器旁的 Lv1 铅笔塔面板：${diffStats(statMap(solo('pencil')), statMap(w.getTowerInfo(ub)))}\n\n`;
    } catch { /* ignore */ }
    return s;
  });
  return md;
}

// ═════════════════════════ 地图 ═════════════════════════

const CLUTTER_CH: Record<string, string> = {
  cup: 'C', books: 'B', keyboard: 'K', mouse: 'M', palette: 'P', paint: 'p',
  eraser: 'e', pencilcup: 'u', sticky: 's', phone: 'h', ruler: 'r', tape: 't', stapler: 'x', clip: 'c',
};
const CLUTTER_NAME: Record<string, string> = {
  cup: '水杯', books: '课本', keyboard: '键盘', mouse: '鼠标', palette: '调色盘', paint: '颜料管',
  eraser: '橡皮', pencilcup: '笔筒', sticky: '便利贴', phone: '手机', ruler: '直尺', tape: '胶带', stapler: '订书机', clip: '回形针',
};

function genMaps(): string {
  let md = header('地图', '每张地图的固定骨架（出生点、出口、标志物）、随机杂物池与布局规则，以及用 `generateLayout` 按固定种子生成的 3 个示例布局。');
  const MAPS = need<Record<string, Any>>(MP, 'MAPS', 'config/maps');
  if (!MAPS) return md + '> ⚠️ 缺少 MAPS，本页跳过。\n';
  const COLS = C.GRID_COLS ?? 12;
  const ROWS = C.GRID_ROWS ?? 14;

  const legend = () => {
    const used = new Set<string>();
    for (const m of Object.values(MAPS) as Any[]) {
      for (const o of m.landmarks) used.add(o.kind);
      for (const c of m.clutter) used.add(c.kind);
    }
    return '图例：`S` 开局开放的入口，`L` 后期开放的入口，`H` 暗门（事件开启的隐藏出生点），`E` 出口，`.` 空地，`*` 开局时敌人的地面路线；障碍物：'
      + [...used].map((k) => `\`${CLUTTER_CH[k] ?? '#'}\` ${CLUTTER_NAME[k] ?? k}`).join('，') + '。坐标 x 向右 0–' + (COLS - 1) + '，y 向下 0–' + (ROWS - 1) + '。\n\n';
  };

  const render = (m: Any, obstacles: Any[], path?: { x: number; y: number }[][]) => {
    const grid: string[][] = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => '.'));
    if (path) for (const p of path) for (const c of p) if (grid[c.y]?.[c.x] === '.') grid[c.y][c.x] = '*';
    for (const o of obstacles) for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) grid[y][x] = CLUTTER_CH[o.kind] ?? '#';
    for (const sp of m.spawners) {
      const open = MP.spawnerOpenWave ? MP.spawnerOpenWave(sp, false) : 1;
      for (const c of sp.cells) grid[c.y][c.x] = sp.kind === 'hidden' ? 'H' : open === 1 ? 'S' : 'L';
    }
    for (const c of m.exits) grid[c.y][c.x] = 'E';
    const head = '    ' + Array.from({ length: COLS }, (_, i) => String(i % 10)).join(' ');
    const lines = grid.map((r, y) => `${String(y).padStart(2)}  ${r.join(' ')}`);
    return '```text\n' + [head, ...lines].join('\n') + '\n```\n\n';
  };

  md += legend();
  md += section('布局规则', () => {
    const R = C.LAYOUT_RULES;
    if (!R) return '';
    return '## 布局规则\n\n' + table(['规则', '数值'], [
      ['每个开局入口到出口的路线长度', `${R.minRoute}～${R.maxRoute} 格（后期入口也不超过 ${R.maxRoute}）`],
      ['可建造空地比例', `≥ ${pct(R.minBuildable, 0)}`],
      ['单格宽缺口', `≤ ${R.maxGaps} 个`],
      ['杂物间距', '杂物与杂物、标志物之间至少隔 1 格；出生点与出口周围 1 格内不放'],
      ['重试', `每件杂物最多尝试 ${R.placeTries} 个位置；整张布局最多重试 ${R.attempts} 次，失败则用手工默认布局`],
    ]);
  });

  for (const m of Object.values(MAPS) as Any[]) {
    md += section(`地图 ${m.id}`, () => {
      let s = `## 第 ${m.chapter} 章 · ${m.name}（${m.id}）\n\n${esc(m.desc)}\n\n`;
      s += '### 出生点与出口\n\n' + table(['出生点', '类型', '格子', '随机权重', '无尽开放', '战役开放'], m.spawners.map((sp: Any) => {
        const ow = MP.spawnerOpenWave?.(sp, false);
        const cw = MP.spawnerOpenWave?.(sp, true);
        return [`${sp.name}（${sp.id}）`, sp.kind === 'hidden' ? '暗门' : '边缘', sp.cells.map((c: Any) => `(${c.x},${c.y})`).join(' '), sp.weight, ow ? `第 ${ow} 波` : '事件开启', cw ? `第 ${cw} 波` : (sp.kind === 'hidden' ? '事件开启' : '不开放')];
      }));
      s += `出口：${m.exits.map((c: Any) => `(${c.x},${c.y})`).join(' ')}。标志物：${m.landmarks.length ? m.landmarks.map((o: Any) => `${CLUTTER_NAME[o.kind] ?? o.kind} ${o.w}×${o.h} @(${o.x},${o.y})`).join('，') : '无'}。\n\n`;
      s += '### 骨架\n\n' + render(m, m.landmarks);
      s += `### 杂物池（总面积预算 ${m.clutterBudget[0]}～${m.clutterBudget[1]} 格，可旋转 90°）\n\n`;
      const tw = m.clutter.reduce((a: number, c: Any) => a + c.weight, 0);
      s += table(['杂物', '字符', '尺寸', '权重', '抽中概率', '每张最多'], m.clutter.map((c: Any) => [CLUTTER_NAME[c.kind] ?? c.kind, `\`${CLUTTER_CH[c.kind] ?? '#'}\``, `${c.w}×${c.h}`, c.weight, pct(c.weight / tw, 0), c.max ?? '—']));
      s += '### 默认（固定）布局\n\n' + render(m, [...m.landmarks, ...m.defaultClutter]);
      if (C.generateLayout) {
        s += '### 随机布局示例\n\n';
        for (const seed of ['docs-1', 'docs-2', 'docs-3']) {
          const lay = C.generateLayout(m.id, seed);
          let path: Any;
          try {
            const w = C.createWorld({ mode: 'endless', map: m.id, difficulty: 'normal', seed, skills: [], pure: true, autoWave: false });
            path = w.currentPaths();
          } catch { path = undefined; }
          const chk = C.checkLayout ? C.checkLayout(m.id, lay.obstacles) : null;
          s += `**种子 \`${seed}\`**${chk ? `：路线 ${chk.routes.join(' / ')} 格，可建造 ${pct(chk.buildable, 0)}，缺口 ${chk.gaps}${chk.ok ? '' : '（未通过校验，已回退默认布局）'}` : ''}\n\n`;
          s += render(m, lay.obstacles, path);
        }
      }
      return s;
    });
  }
  return md;
}

// ═════════════════════════ 索引 ═════════════════════════

function gitRev(): string {
  // 不依赖 child_process：直接读 .git/HEAD
  try {
    const head = readFileSync(join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head.slice(0, 7);
    const ref = head.slice(4).trim();
    if (existsSync(join(ROOT, '.git', ref))) return readFileSync(join(ROOT, '.git', ref), 'utf8').trim().slice(0, 7);
    const packed = readFileSync(join(ROOT, '.git', 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
    return line ? line.slice(0, 7) : '未知';
  } catch { return '未知'; }
}

function genIndex(files: { file: string; title: string; desc: string }[]): string {
  let version = '?';
  try { version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version; } catch { /* ignore */ }
  const today = new Date().toISOString().slice(0, 10);
  let md = `<!-- 本文件由 scripts/gen-data-docs.ts 自动生成，请勿手改 -->\n\n# 游戏数据参考\n\n`;
  md += `> 游戏版本 **${version}**（提交 \`${gitRev()}\`）· 生成日期 ${today}\n\n`;
  md += '本目录下的所有数据页都由脚本直接读取游戏代码生成，数值与游戏内一致。玩法讲解请看上一级的玩家指南。\n\n';
  md += table(['页面', '内容'], files.map((f) => [`[${f.title}](./${f.file})`, f.desc]));
  md += '## 如何生成\n\n```bash\nnpm run docs:data\n# 等价于\nnpx vite-node scripts/gen-data-docs.ts\n```\n\n';
  md += '- 生成器导入 `src/core` 与 `src/config` 的真实导出；塔的逐级数值、升级费用、出售返还、进化费用、组合加成都是在临时对局（`createWorld`）里实际放塔、升级、进化后从 `getTowerInfo()` 读出的。\n';
  md += '- 波次与布局使用固定种子（`docs`、`docs-sample`、`docs-1..3`），重复运行结果相同。\n';
  md += '- 修改了平衡数值后重新运行即可，不要手改这些文件。\n\n';
  if (warnings.length) md += '## 生成警告\n\n' + warnings.map((w) => `- ${esc(w)}`).join('\n') + '\n';
  return md;
}

// ═════════════════════════ main ═════════════════════════

async function main(): Promise<void> {
  const t0 = Date.now();
  try { optionalMods['../src/meta/progress'] = await import('../src/meta/progress'); } catch (e) { warn(`无法导入 src/meta/progress：${(e as Error).message}`); }
  mkdirSync(OUT, { recursive: true });
  const pages: { file: string; title: string; desc: string; gen: () => string }[] = [
    { file: '防御塔数据.md', title: '防御塔数据', desc: '每座塔 Lv1–10 数值、升级费用、出售返还、经验、特性、传奇分支、★1–★3 进化与神话能力；性价比汇总', gen: () => genTowers().md },
    { file: '敌人数据.md', title: '敌人数据', desc: '敌人与 Boss 基础属性、各难度各波生命/数量/金币/经验、精英词缀与精英概率', gen: genEnemies },
    { file: '难度参数.md', title: '难度参数', desc: '简单～噩梦与魔境 I–X 的全部难度参数', gen: genDifficulty },
    { file: '波次.md', title: '波次', desc: '战役三章波次表、无尽 Boss 轮换、敌人解锁、特殊波规则、前 30 波样例', gen: genWaves },
    { file: '技能增益天赋.md', title: '技能、增益、天赋与随机事件', desc: '主动技能各级冷却、局内增益、永久天赋、随机事件、补给箱与拾取物', gen: genSkills },
    { file: '组合与加成.md', title: '组合与加成', desc: '相邻组合技、书本墙加成、计算器光环（均为实测）', gen: genCombos },
    { file: '地图.md', title: '地图', desc: '三张地图的骨架、杂物池、布局规则与随机布局示例', gen: genMaps },
  ];
  for (const p of pages) {
    let md: string;
    try { md = p.gen(); } catch (e) {
      warn(`页面 ${p.file} 生成失败：${(e as Error).stack ?? e}`);
      md = header(p.title, '') + `> ⚠️ 生成失败：${(e as Error).message}\n`;
    }
    writeFileSync(join(OUT, p.file), md.trimEnd() + '\n');
    console.log(`  写入 ${p.file}（${md.length} 字符）`);
  }
  writeFileSync(join(OUT, 'README.md'), genIndex(pages).trimEnd() + '\n');
  console.log(`  写入 README.md`);
  console.log(`完成，用时 ${Date.now() - t0} ms，警告 ${warnings.length} 条 → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
