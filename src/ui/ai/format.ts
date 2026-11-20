/** AI 面板共用的小格式化函数（无依赖） */
export const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

export const fmtCost = (usd: number): string => (usd <= 0 ? '$0' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

/** 排行榜 / 报告里展示的服务商名 */
export function providerLabel(provider: string): string {
  const map: Record<string, string> = {
    'claude-native': 'Claude',
    scripted: '内置策略',
    bridge: '本机桥接',
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
    'pi:custom': '自定义',
  };
  return map[provider] ?? provider.replace(/^(pi|bridge):/, '');
}
