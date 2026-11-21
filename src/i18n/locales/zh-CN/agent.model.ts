import type { Dict } from '../../index';

// 命名空间 agent · 模型目录（按模型的思考档位与价格，数据来自 modelinfo.dev）（zh-CN）
export default {
  'agent.think.clamped': '{model} 没有“{from}”档，已改用“{to}”',
  'agent.mi.think.unknown': '模型目录里没有这个模型，按通用档位发送。',
  'agent.mi.think.noReasoning': '{model} 不支持思考，只能选“无思考”。',
  'agent.mi.think.levels': '{model} 支持：{levels}。',
  'agent.mi.think.perModel': '每个模型分别记住。',
  'agent.mi.priceKnown': '输入 {in} · 输出 {out} / 百万 token',
  'agent.mi.priceManual': '手填：输入 {in} · 输出 {out} / 百万 token',
  'agent.mi.cache': '缓存读 {cr}',
  'agent.mi.perWave': '约 {cost} / 每波',
  'agent.mi.source': '数据来自 modelinfo.dev（{date}）',
  'agent.mi.priceUnknown': '价格未知，可在「高级设置」里手动填',
  'agent.mi.priceLocal': '本机模型，不计费',
  'agent.mi.hudUnknown': '价格未知',
  'agent.mi.adv': '高级设置',
  'agent.mi.advHint': '一般不用改：工具模式由“测试连接”自动判断，上下文模式默认均衡。',
  'agent.mi.price.title': '价格',
  'agent.mi.price.label': '手填价格（美元 / 百万 token）',
  'agent.mi.price.in': '输入',
  'agent.mi.price.out': '输出',
  'agent.mi.price.cr': '缓存读',
  'agent.mi.price.cw': '缓存写',
  'agent.mi.price.hint': '只对当前模型（{model}）生效；留空 = 用模型目录的价格（灰字）。',
} satisfies Dict;
