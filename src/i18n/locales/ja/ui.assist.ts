import type { Dict } from '../../index';

// 名前空間 ui · AI アシスタント（ja）
export default {
  'ui.assist.title': 'AI アシスタント',
  'ui.assist.button': 'AI アシスタント（I）',
  'ui.assist.menu': 'AI アシスタント',
  'ui.assist.menuPlayer': 'AI に代わりにプレイさせる（プレイヤー）',
  'ui.assist.menuPlayerSub': 'AI が操作を引き継ぎ、いつでも止められます。この対局は「AI 補助」になります',
  'ui.assist.menuAdvisor': 'AI に助言してもらう（軍師）',
  'ui.assist.menuAdvisorSub': 'AI は提案だけ。採用するかはあなた次第で、成績に影響しません',
  'ui.assist.stop': 'AI を止める',
  'ui.assist.stopSub': 'AI パネルを閉じ、操作をすべて戻します',
  'ui.assist.stopDedicatedSub': 'AI 参戦の対局：あなたが引き継ぎます（終了時は AI レポートを表示）',
  'ui.assist.configure': 'モデル設定…',
  'ui.assist.configureSub': 'オフラインデモ、Claude、中継サービス、ローカルモデル…',
  'ui.assist.currentModel': '現在のモデル：{model}',
  'ui.assist.rolePlayer': 'AI プレイヤー',
  'ui.assist.roleAdvisor': 'AI 軍師',
  'ui.assist.fairnessShort': 'AI に代わりにプレイさせた対局もランキングに載り、「AI 補助」の印が付きます。軍師だけなら印は付きません。',
  'ui.assist.markedNote': 'この対局は「AI 補助」です：報酬は通常どおり、成績は「AI 補助」の印付きでランキングに載ります。',
  'ui.assist.dedicatedNote':
    'これは「AI 参戦」の対局で、AI が第 1 ウェーブから操作します。役割を変えるには「AI 参戦」から始め直してください。',
  'ui.assist.badge': 'AI 補助',
  'ui.assist.badgeAdvisor': 'AI 軍師',
  'ui.assist.badgeTip': 'この対局では AI が代わりにプレイしました：報酬は通常どおり、成績は「AI 補助」の印付きでランキングに載ります',
  'ui.assist.badgeAdvisorTip': 'AI 軍師は提案するだけで、成績に影響しません',
  'ui.assist.enabledPlayer': 'AI が引き継ぎました（{model}）— I キーでいつでも停止',
  'ui.assist.enabledAdvisor': 'AI 軍師がスタンバイしました（{model}）',
  'ui.assist.stopped': 'AI を停止しました。操作はあなたに戻りました',
  'ui.assist.restarted': '新しい設定で AI を再起動しました（{model}）',
  'ui.assist.offerTitle': 'モデルがまだ設定されていません',
  'ui.assist.offerText': 'まずはオフラインデモで{role}を試せます（通信なし・無料）。自分のモデルを今すぐ設定することもできます。',
  'ui.assist.offerInvalidTitle': 'モデル設定がまだ使えません',
  'ui.assist.offerInvalid': '{reason}。オフラインデモを使うか、設定を開いて補ってください。',
  'ui.assist.offerDemoHint': 'オフラインデモは内蔵のスクリプト戦略です。AI の遊び方・助言の仕方をのぞいてみましょう。',
  'ui.assist.useDemo': 'オフラインデモ',
  'ui.assist.needDetect': '中継サービスの API 種別をまだ検出していません（設定で一度「接続テスト」を押してください）',
  'ui.assist.needConfig': '先にモデル設定を完了してください',
  'ui.assist.configTitle': 'AI アシスタント · モデル設定',
  'ui.assist.configIntro':
    'この設定は端末に保存され、対局中の AI ボタンと「AI 参戦」で共用します。API キーは選んだ方法で保存され、選んだモデル提供元にだけ送信されます。',
  'ui.assist.saveEnable': '保存して有効化（{role}）',
  'ui.assist.done': '完了',
  'ui.assist.decisionHint':
    '「AI プレイヤー」用：一時停止モードでは AI の思考中ゲームが止まります。軍師は常にリアルタイム（邪魔しません）、間隔は 20 秒以上。',
  'ui.assist.settingsHint':
    'モデルを一度設定すれば、どのモードでも上部バーの AI ボタン（ショートカット I）で AI に代わりにプレイさせたり助言をもらったりできます。',
  'ui.assist.openSettings': 'モデル設定…',
  'ui.assist.howTitle': '使い方',
  'ui.assist.howPlayer':
    'AI が現在の局面から操作を引き継ぎます。この対局は「AI 補助」になります：キャンペーンの進行・星・インクは通常どおり、成績も「AI 補助」の印付きでランキングに載ります（ランキングで非表示にできます）。',
  'ui.assist.howAdvisor': 'AI は提案カードを出すだけで、「採用」を押すまで何も起きません。成績や送信に影響しません。',
  'ui.assist.howButtonTitle': '対局中の AI ボタン',
  'ui.assist.howButton':
    '上部バーの AI ボタン（ショートカット I）：いつでも有効化・役割の切り替え・停止ができ、停止すると操作はすべて戻ります。',
  'ui.assist.fairness':
    'AI に 1 ウェーブ目から通しで戦わせるなら、メインメニューの「AI 参戦」から始めてください。成績は「AI 補助」とモデル名付きでランキングに載ります。',
  'ui.assist.goNote': 'この対局では AI が代わりにプレイしました：報酬は通常どおり、成績は「AI 補助」の印付きでランキングに載ります。',
  'ui.assist.goNoteAdvisor': 'この対局では AI 軍師に助言してもらいました。成績に影響はありません。',
  'ui.tutorial.tip-ai.title': 'AI アシスタント',
  'ui.tutorial.tip-ai.body': '行き詰まった？ここ（または I キー）で AI に助言をもらったり、しばらく代わりにプレイさせたりできます。',
} satisfies Dict;
