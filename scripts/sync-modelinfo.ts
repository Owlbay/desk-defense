/**
 * 模型目录快照：从 modelinfo.dev 拉取模型表，生成 src/agent/modelinfo.data.json（文档 10 §8.6）。
 *
 * 用法：
 *   npx vite-node scripts/sync-modelinfo.ts                 （联网拉取 https://modelinfo.dev/site/models?lang=en）
 *   npx vite-node scripts/sync-modelinfo.ts --from a.json   （用本地保存的同一接口返回值）
 *
 * 只保留「仍可调用（active / preview / deprecated，不含 retired）+ 支持工具调用 + 输出文本」的模型；
 * 每个模型只留 AI 参战用得到的字段：id、name、vendor、context、maxOut、efforts、off、price（美元 / 百万 token）、aliases。
 *  - efforts：模型公布的思考档位（去掉 none 等"关闭"档；[] = 支持思考但没有公布档位；null = 不支持思考）
 *  - off：能否关闭思考（档位里有 none / no_think / instant，或者用开关式参数 enable_thinking / thinking.type 等）
 *  - price：第一条 USD、按百万 token 计价的价格；cr / cw = 缓存读 / 写（null = 未公布）
 *  - aliases：各服务商的模型 id 与官方别名（小写、去重，不含 id 本身）
 * 数据来自 modelinfo.dev；快照日期写在 JSON 的 date 字段里，界面会显示。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_URL = 'https://modelinfo.dev/site/models?lang=en';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/agent/modelinfo.data.json');

interface RawPrice {
  currency: string;
  unit: string;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
}
interface RawModel {
  id: string;
  name?: string;
  owned_by?: string;
  limits?: { context?: number | null; output?: number | null };
  modalities?: { output?: string[] };
  reasoning?: { supported?: boolean | null; efforts?: string[] };
  prices?: RawPrice[];
  features?: string[];
  info?: { status?: string; release_date?: string };
  providers?: { id: string; model?: string; reasoning_param?: string | null }[];
  aliases?: string[];
}

interface SnapModel {
  id: string;
  name: string;
  vendor: string;
  context?: number;
  maxOut?: number;
  efforts: string[] | null;
  off?: true;
  price: { in: number; out: number; cr: number | null; cw: number | null } | null;
  aliases?: string[];
}

const USABLE = ['active', 'preview', 'deprecated'];
const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const OFF_EFFORTS = new Set(['none', 'no_think', 'instant']);
/** 开关式思考参数：能直接关掉思考 */
const TOGGLE_PARAMS = new Set([
  'enable_thinking',
  'thinking',
  'thinking.type',
  'thinking_mode',
  'chat_template_kwargs.enable_thinking',
  'chat_template_kwargs.thinking',
  'chat_template_kwargs.thinking_mode',
]);

function compactModel(m: RawModel): SnapModel {
  const r = m.reasoning ?? {};
  const raw = (r.efforts ?? []).map((e) => e.toLowerCase());
  const efforts = r.supported === true ? LEVELS.filter((l) => raw.includes(l)) : null;
  const off =
    r.supported !== true ||
    raw.some((e) => OFF_EFFORTS.has(e)) ||
    (m.providers ?? []).some((p) => TOGGLE_PARAMS.has(p.reasoning_param ?? ''));
  const p = (m.prices ?? []).find((x) => x.currency === 'USD' && x.unit === '1M_tokens' && x.input !== null && x.output !== null);
  const ids = new Set<string>();
  for (const pr of m.providers ?? []) if (pr.model) ids.add(pr.model.toLowerCase());
  for (const a of m.aliases ?? []) ids.add(a.toLowerCase());
  ids.delete(m.id.toLowerCase());
  const out: SnapModel = {
    id: m.id,
    name: m.name ?? m.id,
    vendor: m.owned_by ?? '',
    ...(m.limits?.context ? { context: m.limits.context } : {}),
    ...(m.limits?.output ? { maxOut: m.limits.output } : {}),
    efforts,
    ...(off && efforts ? { off: true as const } : {}),
    price: p ? { in: p.input!, out: p.output!, cr: p.cache_read, cw: p.cache_write } : null,
    ...(ids.size ? { aliases: [...ids].sort() } : {}),
  };
  return out;
}

function buildSnapshot(raw: { data: RawModel[] }, date: string) {
  const rank = (m: RawModel): number => USABLE.indexOf(m.info?.status ?? '');
  const models = raw.data
    .filter((m) => rank(m) >= 0 && (m.features ?? []).includes('tools') && (m.modalities?.output ?? ['text']).includes('text'))
    // 先 active 再 preview / deprecated，同级按发布日期新到旧：别名冲突时先到先得
    .sort((a, b) => rank(a) - rank(b) || (b.info?.release_date ?? '').localeCompare(a.info?.release_date ?? '') || a.id.localeCompare(b.id))
    .map(compactModel);
  return { source: 'modelinfo.dev', url: 'https://modelinfo.dev', note: '数据来自 modelinfo.dev', date, count: models.length, models };
}

async function main(): Promise<void> {
  const i = process.argv.indexOf('--from');
  let raw: { data: RawModel[] };
  if (i > 0 && process.argv[i + 1]) raw = JSON.parse(readFileSync(process.argv[i + 1], 'utf8')) as { data: RawModel[] };
  else {
    const res = await fetch(SRC_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${SRC_URL}`);
    raw = (await res.json()) as { data: RawModel[] };
  }
  if (!Array.isArray(raw.data) || raw.data.length < 50) throw new Error('unexpected catalog shape');
  const snap = buildSnapshot(raw, new Date().toISOString().slice(0, 10));
  // 一个模型一行：体积小、diff 好读
  const body = snap.models.map((m) => `    ${JSON.stringify(m)}`).join(',\n');
  const { models: _m, ...head } = snap;
  void _m;
  const headJson = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  writeFileSync(OUT, `${headJson},\n  "models": [\n${body}\n  ]\n}\n`);
  process.stdout.write(`modelinfo: ${snap.count} models → ${OUT}\n`);
}

main().catch((e: unknown) => {
  process.stdout.write(`sync-modelinfo failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
