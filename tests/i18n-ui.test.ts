/**
 * 界面国际化检查（命名空间 common / ui / agent）：
 *  1. src/ui、src/main.ts、src/render 里不能再有含中日文字符的字符串字面量（文本都应走 t('…')）。
 *     确实需要保留的（例如给模型看的内容、检测用的正则）：在同一行或上一行写注释 `i18n-ignore`。
 *  2. 四种语言的 key 一一对应，且每条翻译的占位符 {name} 集合与简体中文一致。
 *  3. 源码里 t('ui.…') / t('agent.…') / t('common.…') 用到的 key 都在简体中文字典里。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SCAN = ['src/ui', 'src/main.ts', 'src/render'];
/** 不属于界面文字的文件（主题 / 背景由主题工程负责，dev 目录是渲染调试页，guide 由介绍页负责） */
const SKIP = [
  /^src\/render\/palette\.ts$/,
  /^src\/render\/background\.ts$/,
  /^src\/render\/dev\//,
  /^src\/ui\/theme\.ts$/,
  /^src\/ui\/screens\/guide\.ts$/,
  /^src\/ui\/guide\//,
];
const NS = ['common', 'ui', 'agent'];
const LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja'];
const CJK = /[぀-ヿ㐀-鿿＀-￯]/;

function files(p: string): string[] {
  const abs = join(ROOT, p);
  if (!statSync(abs, { throwIfNoEntry: false })) return [];
  if (statSync(abs).isFile()) return p.endsWith('.ts') ? [p] : [];
  return readdirSync(abs).flatMap((f) => files(join(p, f)));
}

const sources = SCAN.flatMap(files)
  .map((f) => relative(ROOT, join(ROOT, f)).replace(/\\/g, '/'))
  .filter((f) => !SKIP.some((re) => re.test(f)));

function cjkLiterals(file: string): string[] {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const lines = text.split('\n');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      (ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n) ||
        ts.isTemplateHead(n) ||
        ts.isTemplateMiddle(n) ||
        ts.isTemplateTail(n)) &&
      CJK.test(n.text)
    ) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart()).line;
      if (!/i18n-ignore/.test(lines[line] ?? '') && !/i18n-ignore/.test(lines[line - 1] ?? ''))
        out.push(`${file}:${line + 1}: ${n.text.slice(0, 60)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

type Dict = Record<string, string>;
const mods = import.meta.glob<{ default: Dict }>('../src/i18n/locales/*/*.ts', { eager: true });
const dicts: Record<string, Dict> = {};
for (const [p, m] of Object.entries(mods)) {
  const [, loc, ns] = /locales\/([^/]+)\/([^/.]+)[^/]*\.ts$/.exec(p) ?? [];
  if (!NS.includes(ns)) continue;
  Object.assign((dicts[loc] ??= {}), m.default);
}
const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

describe('UI i18n', () => {
  it('has no hard-coded CJK string literals in src/ui, src/main.ts, src/render', () => {
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.flatMap(cjkLiterals)).toEqual([]);
  });

  it('every zh-CN key exists in all locales with matching placeholders', () => {
    const src = dicts['zh-CN'];
    expect(Object.keys(src).length).toBeGreaterThan(50);
    const problems: string[] = [];
    for (const loc of LOCALES.slice(1)) {
      const d = dicts[loc] ?? {};
      for (const [k, v] of Object.entries(src)) {
        if (!(k in d)) problems.push(`${loc}: missing ${k}`);
        else if (placeholders(d[k]).join() !== placeholders(v).join()) problems.push(`${loc}: placeholders differ in ${k}: ${d[k]}`);
        else if (!d[k].trim() && v.trim()) problems.push(`${loc}: empty ${k}`);
      }
      for (const k of Object.keys(d)) if (!(k in src)) problems.push(`${loc}: extra key ${k}`);
    }
    expect(problems).toEqual([]);
  });

  it('keys are namespaced by their file', () => {
    const bad: string[] = [];
    for (const [p, m] of Object.entries(mods)) {
      const [, , ns] = /locales\/([^/]+)\/([^/.]+)[^/]*\.ts$/.exec(p) ?? [];
      if (!NS.includes(ns)) continue;
      for (const k of Object.keys(m.default)) if (!k.startsWith(`${ns}.`)) bad.push(`${p}: ${k}`);
    }
    expect(bad).toEqual([]);
  });

  it('every literal t() key used in the UI exists in zh-CN', () => {
    const src = dicts['zh-CN'];
    const missing = new Set<string>();
    for (const f of [...sources, ...files('src/agent')]) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      for (const m of text.matchAll(/\bt(?:Or)?\(\s*'((?:common|ui|agent)\.[\w.-]+)'/g)) if (!(m[1] in src)) missing.add(`${f}: ${m[1]}`);
    }
    expect([...missing]).toEqual([]);
  });
});

describe('UI locale persistence', () => {
  it('resolves saved choice, mirror key and browser fallback', async () => {
    const { ProfileStore } = await import('../src/meta/profile');
    const { memoryStorage } = await import('../src/meta/storage');
    const { resolveLocale, rememberLocale, LANG_KEY } = await import('../src/ui/locale');
    const kv = memoryStorage();
    const store = new ProfileStore(kv);
    // 旧默认值 'zh' 不算选择 → 按浏览器语言（测试环境里 navigator 可能不存在，结果是受支持的语言即可）
    expect(['zh-CN', 'zh-TW', 'en', 'ja']).toContain(resolveLocale(store));
    rememberLocale(store, 'ja');
    expect(kv.get(LANG_KEY)).toBe('ja');
    expect(resolveLocale(new ProfileStore(kv))).toBe('ja');
  });
});
