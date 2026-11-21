import type { Dict } from '../../index';

// 名前空間 agent · AI 出題（AI が攻め、あなたが守る；ドキュメント 10 §2.3；ja）
export default {
  'agent.attack.label': 'AI 出題 · {model}',
  'agent.attack.menu': 'AI 出題',
  'agent.attack.menuSub': '新しく始める：AI が毎ウェーブ敵を組み替え、あなたが守ります（オンラインランキングには送信しません）',
  'agent.attack.menuConfirm': 'もう一度押すと、今の対局をやめて「AI 出題」を始めます',
  'agent.attack.badge': 'AI 出題',
  'agent.attack.badgeTip': 'AI 攻撃側が各ウェーブの開始前に次のウェーブを組み替えます。この対局はローカルにだけ記録されます',
  'agent.attack.unranked': 'AI 出題の対局はランキング対象外です（ローカルにだけ記録）',
  'agent.attack.waveTag': 'AI 出題 {cost}/{budget}',
  'agent.attack.waveTip': 'このウェーブは AI 攻撃側が組み替えました：インクポイント {cost} / {budget} を使用',
  'agent.attack.pending': 'AI 出題中…',
  'agent.attack.pendingTip': 'AI 攻撃側がこのウェーブの開始前に組み替えます（組み替えなければ通常のウェーブ）',
  'agent.attack.panel': 'AI 攻撃側',
} satisfies Dict;
