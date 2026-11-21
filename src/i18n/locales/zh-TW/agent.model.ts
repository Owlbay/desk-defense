import type { Dict } from '../../index';

// 命名空間 agent · 模型目錄（依模型的思考檔位與價格，資料來自 modelinfo.dev）（zh-TW）
export default {
  'agent.think.clamped': '{model} 沒有「{from}」檔，已改用「{to}」',
  'agent.mi.think.unknown': '模型目錄裡沒有這個模型，按通用檔位傳送。',
  'agent.mi.think.noReasoning': '{model} 不支援思考，只能選「無思考」。',
  'agent.mi.think.levels': '{model} 支援：{levels}。',
  'agent.mi.think.perModel': '每個模型分別記住。',
  'agent.mi.priceKnown': '輸入 {in} · 輸出 {out} / 百萬 token',
  'agent.mi.priceManual': '手填：輸入 {in} · 輸出 {out} / 百萬 token',
  'agent.mi.cache': '快取讀取 {cr}',
  'agent.mi.perWave': '約 {cost} / 每波',
  'agent.mi.source': '資料來自 modelinfo.dev（{date}）',
  'agent.mi.priceUnknown': '價格未知，可在「進階設定」裡手動填寫',
  'agent.mi.priceLocal': '本機模型，不計費',
  'agent.mi.hudUnknown': '價格未知',
  'agent.mi.adv': '進階設定',
  'agent.mi.advHint': '一般不用改：工具模式由「測試連線」自動判斷，上下文模式預設均衡。',
  'agent.mi.price.title': '價格',
  'agent.mi.price.label': '手填價格（美元 / 百萬 token）',
  'agent.mi.price.in': '輸入',
  'agent.mi.price.out': '輸出',
  'agent.mi.price.cr': '快取讀取',
  'agent.mi.price.cw': '快取寫入',
  'agent.mi.price.hint': '只對目前模型（{model}）生效；留空 = 使用模型目錄的價格（灰字）。',
} satisfies Dict;
