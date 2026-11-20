/**
 * 本机模型 / 桥接器的配置片段（文档 10 §10.2 – §10.4），按操作系统给出可复制的命令。
 * 纯数据，无 DOM。origin = 当前页面来源（本机服务要允许它跨域）。
 */
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
          { text: '允许本站跨域访问 Ollama：', code: `launchctl setenv OLLAMA_ORIGINS "${origin}"` },
          { text: '然后从菜单栏退出 Ollama 并重新打开（改完必须重启才生效）。' },
          { text: '只想临时试一下：', code: `OLLAMA_ORIGINS="${origin}" ollama serve` },
        ]
      : os === 'win'
        ? [
            { text: '在 PowerShell 里设置用户环境变量：', code: `setx OLLAMA_ORIGINS "${origin}"` },
            { text: '然后在任务栏右键退出 Ollama 再重新打开（也可以在 系统设置 → 环境变量 里新建同名变量）。' },
            { text: '只想临时试一下（PowerShell）：', code: `$env:OLLAMA_ORIGINS="${origin}"; ollama serve` },
          ]
        : [
            { text: '用 systemd 运行的 Ollama：', code: 'sudo systemctl edit ollama.service' },
            { text: '在打开的文件里加入：', code: `[Service]\nEnvironment="OLLAMA_ORIGINS=${origin}"` },
            { text: '保存后重启服务：', code: 'sudo systemctl daemon-reload && sudo systemctl restart ollama' },
            { text: '只想临时试一下：', code: `OLLAMA_ORIGINS="${origin}" ollama serve` },
          ];
  ollama.push({ text: '还没有模型？先拉一个支持工具调用的：', code: 'ollama pull qwen3:8b' });

  const exe = os === 'win' ? 'llama-server.exe' : 'llama-server';
  return [
    { id: 'ollama', name: 'Ollama', steps: ollama },
    {
      id: 'lmstudio',
      name: 'LM Studio',
      steps: [
        { text: '打开 LM Studio → Developer（开发者）→ Server 设置，打开 Enable CORS，然后启动服务器（默认端口 1234）。' },
        { text: '也可以用命令行启动：', code: 'lms server start --port 1234 --cors' },
      ],
    },
    {
      id: 'llamacpp',
      name: 'llama.cpp',
      steps: [
        { text: '启动时加 --jinja 才有工具调用（新版本默认允许跨域）：', code: `${exe} -m model.gguf --jinja --port 8080` },
        { text: `如果前面有反向代理，需要加响应头 Access-Control-Allow-Origin: ${origin}` },
      ],
    },
    {
      id: 'vllm',
      name: 'vLLM',
      steps: [
        {
          text: '启动时打开工具调用并允许本站跨域：',
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
    { text: '在游戏项目目录里运行（本机 Ollama 模型）：', code: `npm run agent:bridge -- --provider pi --preset ollama --model qwen3:8b${extra}` },
    { text: '或者用 Claude（Key 从本机环境变量 / ant auth 读取，网页拿不到）：', code: `npm run agent:bridge -- --provider claude --model claude-sonnet-5-5 --effort low${extra}` },
    { text: '发布后也可以不下载项目，直接：', code: `npx desk-defense-agent bridge --provider pi --preset ollama --model qwen3:8b${extra}` },
  ];
}

/** 浏览器 / 网络环境的额外提示（混合内容、Safari、本地网络权限） */
export function networkNotes(pageProtocol: string, baseUrl: string, ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string[] {
  const out: string[] = [];
  let u: URL | null = null;
  try {
    u = new URL(baseUrl);
  } catch {
    return out;
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  const https = pageProtocol === 'https:';
  const safari = /Safari/i.test(ua) && !/Chrome|Chromium|Edg|Firefox|FxiOS|CriOS/i.test(ua);
  if (https && (u.protocol === 'http:' || u.protocol === 'ws:') && !loopback) {
    out.push('当前页面是 https，浏览器会拦截对 http:// 局域网地址的请求（混合内容）。请用 HTTPS 隧道（cloudflared / tailscale serve，并加上鉴权），或改用本机桥接器。');
  }
  if (loopback && https && safari) out.push('Safari 可能直接拦截 https 页面访问 http://localhost：请改用本机桥接器，或换用 Chrome / Edge / Firefox。');
  if (loopback) out.push('Chrome / Edge 第一次访问本机服务时会弹出“允许访问本地网络”，需要点允许。');
  return out;
}
