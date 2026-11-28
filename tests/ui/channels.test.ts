import { beforeEach, describe, expect, it, vi } from 'vitest';

import { activeChannel, buildModelConfig, ensureChannels, keyIdOf, syncChannel, useChannel } from '../../src/ui/ai/model-config';
import { type AiSetupSaved, defaultSetup, loadChannels, loadSetup, saveChannels, saveSetup, writeKey } from '../../src/ui/ai/store';

/** 内存版 Storage（测试环境没有 localStorage / sessionStorage） */
function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const setup = (o: Partial<AiSetupSaved>): AiSetupSaved => ({ ...defaultSetup(), ...o });

describe('多渠道多模型', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage());
    vi.stubGlobal('sessionStorage', fakeStorage());
  });

  it('旧的「按来源」设置迁移成渠道，id = 来源名，旧 Key 照常可用', () => {
    const st = setup({
      source: 'relay',
      per: { relay: { baseUrl: 'https://a.test/v1', model: 'deepseek-flash' }, openai: { model: 'gpt-5-mini' } },
    });
    writeKey('relay', 'key-a', 'session');
    const list = ensureChannels(st);
    expect(list.map((c) => [c.id, c.source, c.models])).toEqual([
      ['relay', 'relay', ['deepseek-flash']],
      ['openai', 'openai', ['gpt-5-mini']],
    ]);
    expect(st.channel).toBe('relay');
    expect(list[0].per).toEqual({ baseUrl: 'https://a.test/v1' });
    expect(buildModelConfig(st, { role: 'player' }).apiKey).toBe('key-a');
    // 再调一次不重复迁移
    expect(ensureChannels(st)).toHaveLength(2);
  });

  it('两个中转渠道各用各的地址和 Key，切换模型就切到对应渠道', () => {
    const st = setup({ source: 'relay', per: { relay: { baseUrl: 'https://a.test/v1', model: 'm-a' } } });
    writeKey('relay', 'key-a', 'session');
    const list = ensureChannels(st);
    list.push({ id: 'relay-2', name: 'B', source: 'relay', per: { baseUrl: 'https://b.test/v1' }, models: ['m-b1', 'm-b2'] });
    saveChannels(list);
    writeKey('relay-2', 'key-b', 'session');

    useChannel(st, list[1], 'm-b2');
    const b = buildModelConfig(st, { role: 'player' });
    expect([b.baseUrl, b.model, b.apiKey]).toEqual(['https://b.test/v1', 'm-b2', 'key-b']);
    expect(keyIdOf(st, list)).toBe('relay-2');

    useChannel(st, list[0], 'm-a');
    const a = buildModelConfig(st, { role: 'player' });
    expect([a.baseUrl, a.model, a.apiKey]).toEqual(['https://a.test/v1', 'm-a', 'key-a']);
  });

  it('编辑器里的改动写回当前渠道，用过的模型自动收藏', () => {
    const st = setup({ source: 'openai', per: { openai: { model: 'gpt-5-mini' } } });
    const list = ensureChannels(st);
    st.per.openai = { model: 'gpt-5', baseUrl: 'https://proxy.test/v1' };
    syncChannel(st, list);
    const c = loadChannels().find((x) => x.id === 'openai')!;
    expect(c.models).toEqual(['gpt-5-mini', 'gpt-5']);
    expect(c.per).toEqual({ baseUrl: 'https://proxy.test/v1' });
  });

  it('渠道的服务商类型和当前来源不一致时不算当前渠道（Key 退回按来源）', () => {
    const st = setup({ source: 'relay', per: { relay: { model: 'x' } } });
    const list = ensureChannels(st);
    st.source = 'openai';
    expect(activeChannel(st, list)).toBeUndefined();
    expect(keyIdOf(st, list)).toBe('openai');
  });

  it('上下文模式不再让玩家选：读取时一律自动', () => {
    saveSetup(setup({ contextMode: 'full' }));
    expect(loadSetup().contextMode).toBe('auto');
  });
});
