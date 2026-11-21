import type { Dict } from '../../index';

// 名前空間 agent · モデルカタログ（モデルごとの思考レベルと価格、データ提供 modelinfo.dev）（ja）
export default {
  'agent.think.clamped': '{model} には「{from}」がないため「{to}」を使います',
  'agent.mi.think.unknown': 'このモデルはカタログにないため、汎用レベルで送信します。',
  'agent.mi.think.noReasoning': '{model} は思考に対応していません。「思考なし」のみ選べます。',
  'agent.mi.think.levels': '{model} の対応レベル：{levels}。',
  'agent.mi.think.perModel': 'モデルごとに記憶します。',
  'agent.mi.priceKnown': '入力 {in} · 出力 {out} / 100万 token',
  'agent.mi.priceManual': '手入力：入力 {in} · 出力 {out} / 100万 token',
  'agent.mi.cache': 'キャッシュ読み取り {cr}',
  'agent.mi.perWave': '約 {cost} / ウェーブ',
  'agent.mi.source': 'データ提供：modelinfo.dev（{date}）',
  'agent.mi.priceUnknown': '価格不明。「詳細設定」で手入力できます',
  'agent.mi.priceLocal': 'ローカルモデル（無料）',
  'agent.mi.hudUnknown': '価格不明',
  'agent.mi.adv': '詳細設定',
  'agent.mi.advHint': '通常は変更不要：ツールモードは「接続テスト」で自動判定、コンテキストモードの既定は「バランス」です。',
  'agent.mi.price.title': '価格',
  'agent.mi.price.label': '手入力の価格（米ドル / 100万 token）',
  'agent.mi.price.in': '入力',
  'agent.mi.price.out': '出力',
  'agent.mi.price.cr': 'キャッシュ読み取り',
  'agent.mi.price.cw': 'キャッシュ書き込み',
  'agent.mi.price.hint': '現在のモデル（{model}）にのみ適用。空欄 = カタログの価格（灰色）を使用。',
} satisfies Dict;
