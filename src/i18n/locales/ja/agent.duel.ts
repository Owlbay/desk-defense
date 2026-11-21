import type { Dict } from '../../index';

// 名前空間 agent · AI 対戦（攻撃側モデル vs 防衛側モデル）と設定画面の AI 出題（ドキュメント 10 §2.3；ja）
export default {
  'agent.duel.label': '攻 {attacker} vs 守 {defender}',
  'agent.duel.badge': 'AI 対戦',
  'agent.duel.badgeTip':
    '2 つの AI が同じ対局で対戦：攻撃側が各ウェーブ開始前に次のウェーブを書き換え、防衛側がタワーで迎え撃ちます。エンドレス / デイリー / キャンペーンのランキングには入らず、専用の AI 対戦ランキングに送信します',
  'agent.duel.unranked': 'AI 対戦はエンドレス / デイリー / キャンペーンのランキングには入らず、専用の AI 対戦ランキングに送信します',
  'agent.duel.role': 'AI 対戦',
  'agent.duel.panel': 'AI 対戦',
  'agent.duel.side.attack': '攻',
  'agent.duel.side.defend': '守',
  'agent.duel.lineThinking': '{model} 思考中：{reasons}',
  'agent.duel.lineWaitAttack': '{model}：次のウェーブ開始後にその次を出題',
  'agent.duel.lineWaitDefend': '{model}：次の判断ポイントを待機中',
  'agent.duel.lineStopped': '{model}：停止しました',
  'agent.duel.planAct': '出題：{plan}',
  'agent.duel.attackerModel': '攻撃側モデル',
  'agent.duel.defenderModel': '防衛側モデル',
  'agent.duel.roleAttack': 'AI 出題',
  'agent.duel.roleAttackDesc':
    'AI が攻撃側として各ウェーブ開始前に敵を書き換え、あなたが防衛します（オンラインランキングには送信しません）',
  'agent.duel.roleDuel': 'AI 対戦',
  'agent.duel.roleDuelDesc':
    '2 つのモデルが同じ対局で対戦：一方が出題して攻め、もう一方がタワーで守ります（専用の AI 対戦ランキングに送信）',
  'agent.duel.setupNote':
    '各建設フェーズでは攻撃側が先に次のウェーブを書き換え、その後に防衛側が判断します。両方とも一時停止モードです。詳細データはローカルに保存し、成績は専用の AI 対戦ランキングに送信します（モデル名と思考レベルのみ表示）。',
  'agent.duel.attackNote':
    '各ウェーブの開始と同時に AI が次のウェーブを裏で出題します（一時停止なし。出題前に開始すると少し待ちます）。あなたは防衛。ランキングには送信せず、ローカル記録のみ。',
} satisfies Dict;
