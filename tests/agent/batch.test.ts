import { describe, expect, it } from 'vitest';

import { fitNickname, uuidFrom } from '../../scripts/batch-lib';
import { isDeviceId, sanitizeNickname } from '../../src/shared/leaderboard';

describe('批量对局：昵称与设备 id', () => {
  it('昵称不超过 12 个字，同一家的不同模型保留末尾以便区分', () => {
    const a = fitNickname('测试·{model}', 'deepseek-flash');
    const b = fitNickname('测试·{model}', 'deepseek-v4-flash');
    expect(a).not.toBe(b);
    for (const n of [
      a,
      b,
      fitNickname('{model}', 'claude-sonnet-5-5'),
      fitNickname('{model}', 'openai/gpt-5-mini'),
      fitNickname('很长很长很长很长很长很长的前缀', 'x'),
    ]) {
      expect([...n].length).toBeLessThanOrEqual(12);
      expect(sanitizeNickname(n).ok).toBe(true);
    }
    expect(fitNickname('{model}', 'qwen3:8b')).toBe('qwen3:8b');
    expect(fitNickname('{model}', 'openai/gpt-5-mini')).toBe('gpt-5-mini');
  });

  it('设备 id 是合法 UUID，且同一输入稳定、不同输入不同', () => {
    expect(isDeviceId(uuidFrom('a|m1'))).toBe(true);
    expect(uuidFrom('a|m1')).toBe(uuidFrom('a|m1'));
    expect(uuidFrom('a|m1')).not.toBe(uuidFrom('a|m2'));
  });
});
