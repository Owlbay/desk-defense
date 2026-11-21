/**
 * Agent 打法评测（文档 10 §19.6）：变体 × 种子 × 地图 × 难度 的矩阵，外加内置机器人作对照。
 *
 *   npm run agent:eval -- [选项]
 *
 *   --provider scripted|relay          scripted = 离线确定性策略（缺省）；relay = OpenAI 兼容中转（pi，openai-completions）
 *   --variants "名字:键=值,键=值;…"     每个变体一组配置。键：assist on|off、thinking off|low|…、context saver|balanced|full、
 *                                     model（scripted：scripted-v1 | scripted-intents；relay：模型 id）。
 *                                     doctrine（中心策略预设 balanced|pencil|aoe|lamp|ruler|economy|antiair|auto）。
 *   --doctrine aoe                     所有变体统一用这个中心策略（变体里的 doctrine 优先）
 *                                     缺省：scripted → "v1:model=scripted-v1;intents:model=scripted-intents"
 *                                           relay    → "base:assist=off,thinking=low;assist:assist=on,thinking=low"
 *   --seeds relay1,relay4,relay5       固定种子（可复现）
 *   --maps ch1  --difficulties normal  --mode endless  --max-waves 8
 *   --bots medium,expert               对照机器人（none = 不跑）
 *   --concurrency 3                    同时跑几局（只影响墙钟时间）
 *   --base-url-env RELAY_BASE --api-key-env RELAY_KEY --model-env RELAY_MODEL   （relay：都从环境变量读，不写进报告）
 *   --api openai-completions           （relay）
 *   --budget-tokens 1000000            每局折算预算（soft）
 *   --out DIR                          缺省 scripts/out/eval/<时间>
 *
 * 输出：stdout 汇总表（markdown）、eval.json（每局 + 每变体汇总）、eval.html（自包含小报告）、
 *       每局 decisions-<变体>-<种子>-<地图>-<难度>.jsonl。
 * 指标：波数 / 生命 / 漏怪 / 得分、建造阶段闲置金币、塔 / 墙数、路线长度、每波原始 / 折算 token、请求 / 决策、被拒动作。
 */
import { runEval } from './eval-lib';

runEval(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
