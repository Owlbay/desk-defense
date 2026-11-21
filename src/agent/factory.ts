/**
 * 配置 → 适配器。所有厂商 SDK 都用 dynamic import() 按需加载：
 * 浏览器首屏包里只有 src/agent 的纯逻辑；玩家打开 AI 模式时才下载 pi / @anthropic-ai/sdk 对应的分包。
 */
import { configErrorMessage, resolveConfig, validateConfig, type AgentModelConfig } from './config';
import type { LLMProvider } from './providers/types';

export async function createProvider(c: Partial<AgentModelConfig>): Promise<LLMProvider> {
  const errs = validateConfig({ ...c, provider: c.provider ?? 'claude-native' });
  if (errs.length) throw new Error(configErrorMessage(errs));
  const cfg = resolveConfig(c);
  switch (cfg.provider) {
    case 'scripted': {
      const { ScriptedProvider } = await import('./providers/scripted');
      return new ScriptedProvider({ intents: cfg.model === 'scripted-intents' || cfg.model === 'scripted-tactics', tactics: cfg.model === 'scripted-tactics' });
    }
    case 'claude-native': {
      const { ClaudeProvider } = await import('./providers/claude');
      return new ClaudeProvider({
        model: cfg.model, thinking: cfg.thinking, apiKey: cfg.apiKey, browser: cfg.browser,
        maxOutputTokens: cfg.maxOutputTokens, refusalFallback: cfg.refusalFallback,
      });
    }
    case 'pi': {
      const { PiProvider } = await import('./providers/pi');
      return new PiProvider({ config: cfg });
    }
    case 'bridge': {
      const { connectBridge } = await import('./bridge');
      return connectBridge(cfg.bridge!.url, cfg.bridge!.code);
    }
  }
}
