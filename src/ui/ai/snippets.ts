/**
 * 本机模型 / 桥接器的配置片段（文档 10 §10.2 – §10.4），按操作系统给出可复制的命令。
 * 纯数据，无 DOM；说明文字按当前语言生成。origin = 当前页面来源（本机服务要允许它跨域）。
 */
import { t } from '../../i18n';

export type OsId = 'mac' | 'win' | 'linux';

export const OS_NAME: Record<OsId, string> = { mac: 'macOS', win: 'Windows', linux: 'Linux' };

export function detectOs(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): OsId {
  if (/Windows/i.test(ua)) return 'win';
  if (/Mac|iPhone|iPad/i.test(ua)) return 'mac';
  return 'linux';
}

export interface SetupStep {
  /** 说明文字 */
  text: string;
  /** 可复制的命令 / 配置（可选） */
  code?: string;
}

export interface SetupGuide {
  id: 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm';
  name: string;
  steps: SetupStep[];
}

export function localGuides(origin: string, os: OsId): SetupGuide[] {
  const ollama: SetupStep[] =
    os === 'mac'
      ? [
          { text: t('agent.snippets.ollamaCors'), code: `launchctl setenv OLLAMA_ORIGINS "${origin}"` },
          { text: t('agent.snippets.ollamaRestartMac') },
          { text: t('agent.snippets.tryOnce'), code: `OLLAMA_ORIGINS="${origin}" ollama serve` },
        ]
      : os === 'win'
        ? [
            { text: t('agent.snippets.winSetx'), code: `setx OLLAMA_ORIGINS "${origin}"` },
            { text: t('agent.snippets.ollamaRestartWin') },
            { text: t('agent.snippets.tryOncePs'), code: `$env:OLLAMA_ORIGINS="${origin}"; ollama serve` },
          ]
        : [
            { text: t('agent.snippets.systemd'), code: 'sudo systemctl edit ollama.service' },
            { text: t('agent.snippets.addToFile'), code: `[Service]\nEnvironment="OLLAMA_ORIGINS=${origin}"` },
            { text: t('agent.snippets.restartService'), code: 'sudo systemctl daemon-reload && sudo systemctl restart ollama' },
            { text: t('agent.snippets.tryOnce'), code: `OLLAMA_ORIGINS="${origin}" ollama serve` },
          ];
  ollama.push({ text: t('agent.snippets.pullModel'), code: 'ollama pull qwen3:8b' });

  const exe = os === 'win' ? 'llama-server.exe' : 'llama-server';
  return [
    { id: 'ollama', name: 'Ollama', steps: ollama },
    {
      id: 'lmstudio',
      name: 'LM Studio',
      steps: [
        { text: t('agent.snippets.lmstudio') },
        { text: t('agent.snippets.lmstudioCli'), code: 'lms server start --port 1234 --cors' },
      ],
    },
    {
      id: 'llamacpp',
      name: 'llama.cpp',
      steps: [
        { text: t('agent.snippets.llamacpp'), code: `${exe} -m model.gguf --jinja --port 8080` },
        { text: t('agent.snippets.llamacppProxy', { origin }) },
      ],
    },
    {
      id: 'vllm',
      name: 'vLLM',
      steps: [
        {
          text: t('agent.snippets.vllm'),
          code: `vllm serve Qwen/Qwen3-8B --enable-auto-tool-choice --tool-call-parser hermes --allowed-origins '["${origin}"]'`,
        },
      ],
    },
  ];
}

/** 桥接器启动命令 */
export function bridgeCommands(origin: string): SetupStep[] {
  const extra = /^https:\/\/jjjj\.games$|^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? '' : ` --origin ${origin}`;
  return [
    { text: t('agent.snippets.bridgeOllama'), code: `npm run agent:bridge -- --provider pi --preset ollama --model qwen3:8b${extra}` },
    {
      text: t('agent.snippets.bridgeClaude'),
      code: `npm run agent:bridge -- --provider claude --model claude-sonnet-5-5 --effort low${extra}`,
    },
    { text: t('agent.snippets.bridgeNpx'), code: `npx desk-defense-agent bridge --provider pi --preset ollama --model qwen3:8b${extra}` },
  ];
}

/** 浏览器 / 网络环境的额外提示（混合内容、Safari、本地网络权限） */
export function networkNotes(
  pageProtocol: string,
  baseUrl: string,
  ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
): string[] {
  const out: string[] = [];
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return out;
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  const https = pageProtocol === 'https:';
  const safari = /Safari/i.test(ua) && !/Chrome|Chromium|Edg|Firefox|FxiOS|CriOS/i.test(ua);
  if (https && (u.protocol === 'http:' || u.protocol === 'ws:') && !loopback) {
    out.push(t('agent.snippets.mixedContent'));
  }
  if (loopback && https && safari) out.push(t('agent.snippets.safari'));
  if (loopback) out.push(t('agent.snippets.localNetwork'));
  return out;
}
