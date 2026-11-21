/**
 * 榜单 / 结算 / 对战榜上的模型标记：只显示「模型名 · 思考档位」，不显示渠道；内置机器人显示「离线演示」；旧数据没有档位就不显示。
 */
import { describe, expect, it } from 'vitest';

import { setLocale, t } from '../../src/i18n';

describe('模型标记文本', () => {
  it('AI 辅助 / AI 参战：模型 · 档位；没有档位只显示模型；内置机器人显示离线演示', async () => {
    await setLocale('zh-CN');
    const { aiModelText } = await import('../../src/ui/online/model-tag');
    expect(aiModelText({ aiModel: 'deepseek-flash', aiEffort: 'high' })).toBe('deepseek-flash · high');
    expect(aiModelText({ aiModel: 'deepseek-flash' })).toBe('deepseek-flash');
    expect(
      aiModelText({ aiModel: 'x', agent: { model: 'claude-sonnet-5-5', effort: 'low', mode: 'pause', botShare: 0, botAssisted: false } }),
    ).toBe('claude-sonnet-5-5 · low');
    expect(aiModelText({ aiModel: 'scripted-v1' })).toBe(t('agent.setup.label.demo'));
    expect(aiModelText({ agent: { model: 'scripted-v1', scripted: true, mode: 'pause', botShare: 1, botAssisted: true } })).toBe(
      t('agent.setup.label.demo'),
    );
  });

  it('AI 对战：攻 / 守 双方各自的模型 · 档位', async () => {
    await setLocale('zh-CN');
    const { duelSideText, duelVsText } = await import('../../src/ui/online/model-tag');
    expect(duelSideText({ model: 'deepseek-flash', effort: 'high' })).toBe('deepseek-flash · high');
    expect(duelVsText({ model: 'deepseek-flash', effort: 'high' }, { model: 'claude-sonnet-5-5' })).toBe(
      '攻 deepseek-flash · high vs 守 claude-sonnet-5-5',
    );
    await setLocale('en');
    expect(duelVsText({ model: 'a', effort: 'max' }, { model: 'scripted-v1', scripted: true })).toBe(
      `ATK a · max vs DEF ${t('agent.setup.label.demo')}`,
    );
    await setLocale('zh-CN');
  });
});
