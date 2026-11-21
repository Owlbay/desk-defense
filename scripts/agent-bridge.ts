/**
 * 本机桥接器（文档 10 §10.3）：让网页版游戏使用你电脑上的模型 / 你自己的 API Key，而网页拿不到 Key。
 *
 *   npm run agent:bridge -- --provider pi --preset ollama --model qwen3:8b
 *   npm run agent:bridge -- --provider claude --model claude-sonnet-5-5 --effort low
 *   （以后发布为：npx desk-defense-agent bridge ...）
 *
 *   --port 8787  --host 127.0.0.1（默认只监听本机；--host 0.0.0.0 需要显式 --allow-lan）
 *   --origin https://my.domain    额外允许的网页来源（默认 https://jjjj.games 与 localhost）
 *   其余模型参数与 agent-play 相同：--provider --model --preset --api --base-url --tool-mode --thinking（--effort 为别名）--context
 *
 * 启动后打印 6 位一次性配对码；在游戏的 AI 设置里填 ws://127.0.0.1:8787 和配对码。
 * 每次配对成功后会生成新的配对码（旧码作废）。Key 只从本机环境变量 / `ant auth` 读取。
 */
import { WebSocketServer } from 'ws';
import { createProvider } from '../src/agent/factory';
import { createBridgeSession, makePairingCode, originAllowed, type BridgeServerMsg } from '../src/agent/bridge';
import { parseContextMode, parseThinking, type AgentModelConfig, type PiApi, type Preset } from '../src/agent/config';

const argv = process.argv.slice(2).filter((a) => a !== '--');
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i < 0 ? d : argv[i + 1];
};

const port = Number(arg('port', '8787'));
const host = arg('host', '127.0.0.1')!;
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && !argv.includes('--allow-lan')) {
  console.error('拒绝监听非本机地址：确实需要（例如经 HTTPS 隧道给手机用）请加 --allow-lan，并只通过加密隧道暴露。');
  process.exit(2);
}
const extraOrigins = (arg('origin') ?? '').split(',').filter(Boolean);
const providerArg = arg('provider', 'claude')!;
const cfg: Partial<AgentModelConfig> = {
  provider: providerArg === 'claude' ? 'claude-native' : (providerArg as AgentModelConfig['provider']),
  model: arg('model', providerArg === 'claude' ? 'claude-opus-5-5' : undefined),
  preset: arg('preset') as Preset | undefined,
  api: arg('api') as PiApi | undefined,
  baseUrl: arg('base-url'),
  toolMode: arg('tool-mode') as 'native' | 'json' | undefined,
  contextMode: parseContextMode(arg('context')),
  thinking: parseThinking(arg('thinking') ?? arg('effort')),
};
for (const k of Object.keys(cfg) as (keyof AgentModelConfig)[]) if (cfg[k] === undefined) delete cfg[k];

const provider = await createProvider(cfg);
let code = makePairingCode();
const wss = new WebSocketServer({ host, port, maxPayload: 4 * 1024 * 1024 });
let active = 0;

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (!originAllowed(origin, extraOrigins)) {
    console.error(`拒绝来源 ${origin}`);
    ws.close(1008, 'origin not allowed');
    return;
  }
  if (active >= 1) {
    ws.close(1013, 'bridge busy');
    return;
  }
  active++;
  const send = (m: BridgeServerMsg) => ws.send(JSON.stringify(m));
  // 思路与请求转发给网页前，把本机环境里的密钥也登记为必须替换的字符串（再加上通用格式规则）
  const secrets = Object.entries(process.env)
    .filter(([k, v]) => v && /KEY|TOKEN|SECRET/i.test(k) && v.length >= 8)
    .map(([, v]) => v as string);
  const session = createBridgeSession({
    provider,
    code,
    send,
    secrets,
    log: (s) => {
      if (s === 'paired') {
        console.log(`已配对：${origin ?? '(无 Origin)'}`);
        code = makePairingCode();
        console.log(`下次连接的新配对码：${code}`);
      }
    },
  });
  ws.on('message', (data) => session.handle(String(data)));
  ws.on('close', () => {
    active--;
    session.close();
  });
});

wss.on('listening', () => {
  console.log(`desk-defense agent bridge → ws://${host}:${port}  模型 ${provider.id}/${provider.model}`);
  console.log(`配对码：${code}`);
  console.log(`允许的网页来源：https://jjjj.games, http://localhost:*${extraOrigins.length ? `, ${extraOrigins.join(', ')}` : ''}`);
});
