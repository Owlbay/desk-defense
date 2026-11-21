/**
 * 离线 token 基准：npm run agent:tokens -- [--waves 15] [--seed tok-1] [--map ch1] [--json]
 * 模型与假设见 ./token-model.ts。不联网、不需要 Key。
 */
import type { MapId } from '../src/core/types';
import { estimateTokens } from '../src/agent/observation';
import { catalogText, systemBlocks } from '../src/agent/prompts';
import { LEGACY_TOOLS, SLIM_TOOLS } from '../src/agent/tools';
import { CONTEXT_MODES } from '../src/agent/config';
import { tokenRun, LEGACY_RULES_TOKENS, type TokenRun } from './token-model';

const argv = process.argv.slice(2).filter((a) => a !== '--');
const arg = (k: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${k}`);
  return i < 0 ? d : argv[i + 1];
};
const WAVES = Number(arg('waves', '15'));
const SEED = arg('seed', 'tok-1')!;
const MAP = arg('map', 'ch1') as MapId;
const JSON_OUT = argv.includes('--json');

const k = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));

async function main(): Promise<void> {
  const out: TokenRun[] = [];
  for (const th of ['low', 'off'] as const) {
    for (const m of ['before', 'full', 'balanced', 'saver'] as const) {
      const r = await tokenRun(m, th, { waves: WAVES, seed: SEED, map: MAP });
      out.push({ ...r, label: `${r.label}·思考${th === 'low' ? '低' : '无'}` });
    }
  }
  if (JSON_OUT) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const sb = systemBlocks('player');
  console.log(
    `前缀：规则 ${estimateTokens(sb[0])} + 速查表 ${estimateTokens(sb[1])} + 工具 ${estimateTokens(JSON.stringify(SLIM_TOOLS.filter((t) => t.roles.includes('player')).map(({ name, description, input_schema }) => ({ name, description, input_schema }))))}（${SLIM_TOOLS.filter((t) => t.roles.includes('player')).length} 个）` +
      `；旧：规则 ≈${LEGACY_RULES_TOKENS} + 资料表 ${estimateTokens(catalogText('all'))} + 工具 ${estimateTokens(JSON.stringify(LEGACY_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }))))}（${LEGACY_TOOLS.length} 个）`,
  );
  console.log(`种子 ${SEED} · ${MAP} · ${WAVES} 波 · 估算（estimateTokens），只用于比较\n`);
  const head = [
    '模式',
    '波',
    '决策点',
    '叫模型',
    '跳过',
    '请求',
    '请求/决策',
    '前缀',
    '消息均值',
    '新输入',
    '缓存读',
    '输出',
    '原始/波',
    '折算/波',
  ];
  console.log(head.join('\t'));
  for (const r of out) {
    console.log(
      [
        r.label,
        r.waves,
        r.decisionPoints,
        r.called,
        r.skipped,
        r.requests,
        r.reqPerDecision,
        r.prefixTokens,
        r.avgMessageTokens,
        k(r.usage.inputTokens),
        k(r.usage.cacheReadTokens),
        k(r.usage.outputTokens),
        k(r.perWaveRaw),
        k(r.perWaveWeighted),
      ].join('\t'),
    );
  }
  console.log(
    `\n模式说明：${Object.entries(CONTEXT_MODES)
      .map(([m, s]) => `${m}: 观测 ${s.observation}、门控 ${s.gating}、波中间隔 ${s.waveIntervalSec}s`)
      .join('；')}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
