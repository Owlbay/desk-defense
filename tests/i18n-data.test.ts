/**
 * 数据 / 核心文本（命名空间 core、data）的国际化测试：
 *  - 四种语言 key 一致、占位符一致；
 *  - src/shared 里 stDef 的回退文本与 zh-CN 词典一致（Pages Functions 用回退文本）；
 *  - 切换到英文后塔信息 / 建造选项 / 指令原因是英文，切回中文恢复；
 *  - 语言不影响模拟：同一组指令在不同语言下 stateHash 完全一致；
 *  - src/core、src/config、src/meta、src/shared 里不残留中文字符串字面量（注释与白名单除外）。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dictOf, getLocale, loadLocale, setLocale, t, tSource, withLocale, type Locale } from '../src/i18n';
import { createWorld, stateHash, TOWER_META, ENEMY_META, ABILITY_META, type Command, type IWorld, type RunOptions } from '../src/core';
import { TIER_NAMES, TOWERS } from '../src/config/towers';
import { PERKS } from '../src/config/perks';
import { CUSTOM_FIELDS } from '../src/meta/custom';
import { diffLabel, unlockHint } from '../src/meta/progress';
import { boardLabel } from '../src/shared/leaderboard';
import { SHARED_FALLBACKS } from '../src/shared/text';

const LOCALES: Locale[] = ['zh-CN', 'zh-TW', 'en', 'ja'];
const NS = /^(core|data)\./;
const CJK = /[㐀-鿿豈-﫿]/;
const KANA = /[぀-ヿ]/;

const placeholders = (s: string): string[] => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

afterAll(async () => {
  await setLocale('zh-CN');
});

describe('core / data dictionaries', () => {
  it('have the same keys and placeholders in every locale', async () => {
    for (const l of LOCALES) await loadLocale(l);
    const src = dictOf('zh-CN')!;
    const keys = Object.keys(src).filter((k) => NS.test(k)).sort();
    expect(keys.length).toBeGreaterThan(600);
    for (const l of LOCALES) {
      const d = dictOf(l)!;
      const own = Object.keys(d).filter((k) => NS.test(k)).sort();
      expect(own, `${l} keys`).toEqual(keys);
      for (const k of keys) {
        // 英文复数 'one|other'：两段的占位符合起来与源文本一致
        expect(placeholders(d[k]), `${l} ${k}`).toEqual(placeholders(src[k]));
        if (l !== 'en') expect(d[k].includes('|'), `${l} ${k} must not use plural form`).toBe(false);
      }
    }
  });

  it('en has no Chinese, ja is Japanese, zh-TW is converted', () => {
    const en = dictOf('en')!;
    const ja = dictOf('ja')!;
    const tw = dictOf('zh-TW')!;
    const src = dictOf('zh-CN')!;
    for (const k of Object.keys(src).filter((x) => NS.test(x))) {
      expect(CJK.test(en[k]) || KANA.test(en[k]), `en ${k}: ${en[k]}`).toBe(false);
    }
    expect(ja['data.tower.lamp.name']).toBe('デスクライト');
    expect(tw['data.tower.lamp.name']).toBe('檯燈');
    // 繁体里不应出现常见简体字
    const simplified = /[们这进发时击护伤级经验钱罐规灯钉胶墙铅笔计]/;
    for (const k of Object.keys(src).filter((x) => NS.test(x))) expect(simplified.test(tw[k]), `zh-TW ${k}: ${tw[k]}`).toBe(false);
  });

  it('stDef fallbacks in src/shared match the zh-CN dictionary', () => {
    const src = dictOf('zh-CN')!;
    expect(Object.keys(SHARED_FALLBACKS).length).toBeGreaterThan(5);
    for (const [k, fb] of Object.entries(SHARED_FALLBACKS)) expect(src[k], k).toBe(fb);
  });
});

// ───────────── 运行时切换 ─────────────

const rich = (o: Partial<RunOptions> = {}): RunOptions => ({
  mode: 'custom', map: 'ch1', difficulty: 'normal', seed: 'i18n-seed', skills: ['eraser_strike', 'bell', 'whiteout_zone'],
  fixedLayout: true, custom: { startGold: 100000 }, ...o,
});

function texts(w: IWorld): string[] {
  const out: string[] = [];
  for (const o of w.getBuildOptions()) out.push(o.name, o.role, o.desc);
  for (const tw of w.state.towers.values()) {
    const info = w.getTowerInfo(tw.uid)!;
    out.push(info.name, info.tierName);
    for (const s of info.stats) out.push(s.label, s.value);
    for (const tr of [...info.traits, ...info.evoTraits]) out.push(tr.name, tr.desc);
    if (info.branches) out.push(info.branches.A.name, info.branches.A.desc, info.branches.B.name, info.branches.B.desc);
    if (info.ability) out.push(info.ability.name, info.ability.desc);
  }
  return out.filter((s) => s !== '' && s !== '—');
}

function buildSample(): IWorld {
  const w = createWorld(rich());
  const cmds: Command[] = [
    { type: 'place', tower: 'pencil', cx: 7, cy: 2 },
    { type: 'place', tower: 'glue', cx: 4, cy: 5 },
    { type: 'place', tower: 'wall', cx: 0, cy: 5 },
    { type: 'place', tower: 'swatter', cx: 3, cy: 2 },
  ];
  for (const c of cmds) expect(w.command(c).ok).toBe(true);
  // 铅笔升到传奇 A 并进化满星（有能力 / ★ 特性文本）
  const pencil = [...w.state.towers.values()].find((x) => x.id === 'pencil')!;
  for (let i = 0; i < 9; i++) w.command({ type: 'upgrade', uid: pencil.uid, branch: 'A' });
  for (let i = 0; i < 3; i++) w.command({ type: 'evolve', uid: pencil.uid } as Command);
  return w;
}

describe('locale switching', () => {
  it('TowerInfo / BuildOptions / reasons follow the current locale', async () => {
    await setLocale('zh-CN');
    const w = buildSample();
    const zh = texts(w);
    expect(zh.some((s) => CJK.test(s))).toBe(true);
    expect(w.canPlace('wall', 8, 3).reason).toBe('这里不能建造');

    await setLocale('en');
    expect(getLocale()).toBe('en');
    const en = texts(w);
    expect(en.length).toBe(zh.length);
    for (const s of en) expect(CJK.test(s), s).toBe(false);
    const chk = w.canPlace('wall', 8, 3);
    expect(chk.code).toBe('cantBuild');
    expect(chk.reason).toBe(dictOf('en')!['core.reason.cantBuild']);
    expect(CJK.test(w.command({ type: 'sell', uid: 9999 }).reason ?? '')).toBe(false);
    expect(TOWER_META.pencil.name).toBe(dictOf('en')!['data.tower.pencil.name']);
    expect(CJK.test(ENEMY_META.boss_alarm.desc)).toBe(false);
    expect(CJK.test(ABILITY_META.pencil_a.desc)).toBe(false);
    expect(TIER_NAMES[4]).toBe('Mythic');
    expect(CJK.test(TOWERS.swatter.B.desc)).toBe(false);
    expect(CJK.test(PERKS[0].desc)).toBe(false);
    expect(CJK.test(CUSTOM_FIELDS[0].label)).toBe(false);
    expect(CJK.test(diffLabel('abyss', 3))).toBe(false);
    expect(CJK.test(unlockHint('nightmare'))).toBe(false);
    expect(CJK.test(boardLabel('abyss3:pure:auto'))).toBe(false);
    // 源语言文本（AI 参战用）不受当前语言影响
    expect(tSource('data.tower.pencil.name')).toBe('铅笔塔');
    expect(withLocale('zh-CN', () => TOWERS.pencil.name)).toBe('铅笔塔');
    expect(TOWERS.pencil.name).toBe(t('data.tower.pencil.name'));

    for (const l of ['zh-TW', 'ja'] as Locale[]) {
      await setLocale(l);
      expect(texts(w).length).toBe(zh.length);
    }
    await setLocale('zh-CN');
    expect(texts(w)).toEqual(zh);
  });

  it('simulation and replays are identical across locales', async () => {
    const plan: [number, Command][] = [
      [0, { type: 'place', tower: 'pencil', cx: 7, cy: 2 }],
      [1, { type: 'place', tower: 'glue', cx: 4, cy: 5 }],
      [2, { type: 'startWave' }],
      [400, { type: 'cast', skill: 'eraser_strike', x: 6, y: 4 }],
      [900, { type: 'startWave' }],
    ];
    const runIn = async (l: Locale) => {
      await setLocale(l);
      const w = createWorld({ ...rich({ seed: 'i18n-replay', fixedLayout: false }), mode: 'endless', custom: undefined });
      const toasts: string[] = [];
      for (let tick = 0; tick < 2500; tick++) {
        for (const [tk, c] of plan) if (tk === tick) w.command(c);
        if (w.state.phase === 'build' && tick > 900) w.command({ type: 'startWave' });
        w.step();
        for (const ev of w.drainEvents()) if (ev.type === 'toast') toasts.push(ev.key ?? '');
      }
      return { hash: stateHash(w), log: w.log.slice(), tick: w.state.tick, toasts };
    };
    const zh = await runIn('zh-CN');
    for (const l of ['en', 'ja', 'zh-TW'] as Locale[]) {
      const o = await runIn(l);
      expect(o.hash, l).toBe(zh.hash);
      expect(o.toasts, l).toEqual(zh.toasts);
    }
    // 中文下录的指令日志，在英文下回放结果一致
    await setLocale('en');
    const b = createWorld({ ...rich({ seed: 'i18n-replay', fixedLayout: false }), mode: 'endless', custom: undefined });
    let li = 0;
    while (b.state.tick < zh.tick) {
      while (li < zh.log.length && zh.log[li].tick === b.state.tick) b.command(zh.log[li++].cmd);
      b.step();
    }
    expect(stateHash(b)).toBe(zh.hash);
    await setLocale('zh-CN');
  });
});

// ───────────── 残留中文字面量扫描 ─────────────

/**
 * 允许保留中文字面量的位置（理由）：
 *  - src/shared/leaderboard.ts 的 bad(...) / checkScore：服务端（Pages Functions）校验信息，服务端无 i18n，直接返回给客户端；
 *  - src/shared/leaderboard.ts 的 stDef(...) 回退文本与昵称屏蔽词表；
 *  - 解析旧数据格式的正则 / 示例。
 */
const ALLOW: { file: RegExp; line: RegExp }[] = [
  { file: /src\/shared\/leaderboard\.ts$/, line: /\bbad\(|return '[^']*';$|stDef\(|'管理员'|'傻逼'/ },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 去掉注释（行注释 / 块注释），保留字符串 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let q: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (q) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === q) q = null;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const chunk = src.slice(i, end < 0 ? src.length : end + 2);
      out += chunk.replace(/[^\n]/g, ' ');
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') q = c;
    out += c;
    i++;
  }
  return out;
}

describe('no leftover Chinese literals', () => {
  it('src/core, src/config, src/meta, src/shared', () => {
    const root = join(__dirname, '..');
    const files = ['src/core', 'src/config', 'src/meta', 'src/shared'].flatMap((d) => walk(join(root, d)));
    const hits: string[] = [];
    for (const f of files) {
      const rel = f.slice(root.length + 1);
      const lines = stripComments(readFileSync(f, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (!CJK.test(line)) return;
        if (ALLOW.some((a) => a.file.test(rel) && a.line.test(line))) return;
        hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
