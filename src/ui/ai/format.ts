/** AI 面板共用的小格式化函数 */
import { t } from '../../i18n';

export const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

export const fmtCost = (usd: number): string => (usd <= 0 ? '$0' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

/** 排行榜 / 报告里展示的服务商名 */
export function providerLabel(provider: string): string {
  const map: Record<string, string> = {
    'claude-native': 'Claude',
    scripted: t('agent.setup.provider.scripted'),
    bridge: t('agent.setup.provider.bridge'),
    mcp: 'MCP',
    'pi:anthropic': 'Anthropic',
    'pi:openai': 'OpenAI',
    'pi:google': 'Gemini',
    'pi:openrouter': 'OpenRouter',
    'pi:deepseek': 'DeepSeek',
    'pi:ollama': 'Ollama',
    'pi:lmstudio': 'LM Studio',
    'pi:llamacpp': 'llama.cpp',
    'pi:vllm': 'vLLM',
    'pi:relay': t('agent.setup.provider.relay'),
    'pi:custom': t('agent.setup.provider.custom'),
  };
  return map[provider] ?? provider.replace(/^(pi|bridge):/, '');
}
