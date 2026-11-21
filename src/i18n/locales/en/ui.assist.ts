import type { Dict } from '../../index';

// Namespace ui · AI helper (in-game AI button, Settings → "AI helper", fairness marks; en)
export default {
  'ui.assist.title': 'AI helper',
  'ui.assist.button': 'AI helper (I)',
  'ui.assist.menu': 'AI helper',
  'ui.assist.menuPlayer': 'Let AI play for me (player)',
  'ui.assist.menuPlayerSub': 'AI takes over; stop it any time. This run is marked "AI-assisted"',
  'ui.assist.menuAdvisor': 'Let AI give advice (advisor)',
  'ui.assist.menuAdvisorSub': 'AI only suggests; you decide. Your score is unaffected',
  'ui.assist.stop': 'Stop AI',
  'ui.assist.stopSub': 'Close the AI panel and give you full control',
  'ui.assist.stopDedicatedSub': 'AI Battle run: you take over; the AI report still shows at the end',
  'ui.assist.configure': 'Configure model…',
  'ui.assist.configureSub': 'Offline demo, Claude, relay, local models…',
  'ui.assist.currentModel': 'Model: {model}',
  'ui.assist.rolePlayer': 'AI player',
  'ui.assist.roleAdvisor': 'AI advisor',
  'ui.assist.fairnessShort':
    'Runs where AI played for you still go on the leaderboards, tagged AI-assisted; advisor-only runs are not tagged.',
  'ui.assist.markedNote':
    'This run is marked "AI-assisted": rewards as usual, and it still goes on the leaderboards with an AI-assisted tag.',
  'ui.assist.dedicatedNote': 'This is an AI Battle run, played by AI from wave 1. To change roles, start again from AI Battle.',
  'ui.assist.badge': 'AI-assisted',
  'ui.assist.badgeAdvisor': 'AI advisor',
  'ui.assist.badgeTip': 'AI played for you in this run: rewards as usual; it still goes on the leaderboards, tagged AI-assisted',
  'ui.assist.badgeAdvisorTip': 'The AI advisor only suggests moves; your score is unaffected',
  'ui.assist.enabledPlayer': 'AI has taken over ({model}) — press I to stop any time',
  'ui.assist.enabledAdvisor': 'AI advisor is ready ({model})',
  'ui.assist.stopped': 'AI stopped — you have full control',
  'ui.assist.restarted': 'AI restarted with the new settings ({model})',
  'ui.assist.offerTitle': 'No model configured yet',
  'ui.assist.offerText': 'Try the {role} with the offline demo (no network, no cost), or set up your own model now.',
  'ui.assist.offerInvalidTitle': 'Model settings are incomplete',
  'ui.assist.offerInvalid': '{reason}. Use the offline demo for now, or open the settings to finish.',
  'ui.assist.offerDemoHint': 'The offline demo is a built-in scripted strategy — a quick look at how the AI plays or advises.',
  'ui.assist.useDemo': 'Offline demo',
  'ui.assist.needDetect': 'The relay API type hasn\'t been detected yet (press "Test connection" once in the settings)',
  'ui.assist.needConfig': 'Finish the model settings first',
  'ui.assist.configTitle': 'AI helper · Model settings',
  'ui.assist.configIntro':
    'Saved on this device and shared by the in-game AI button and AI Battle. Your API key is stored the way you choose and only ever sent to the provider you pick.',
  'ui.assist.saveEnable': 'Save and enable ({role})',
  'ui.assist.done': 'Done',
  'ui.assist.decisionHint':
    'For the AI player: in pause mode the game waits while it thinks. The advisor is always real-time (never interrupts you), at least 20 s apart.',
  'ui.assist.settingsHint':
    'Set up a model once, then tap the AI button in the top bar (shortcut I) in any mode to let AI play for you or give advice.',
  'ui.assist.openSettings': 'Model settings…',
  'ui.assist.howTitle': 'How it works',
  'ui.assist.howPlayer':
    'AI takes over from the current position. The run is marked "AI-assisted": campaign progress, stars and ink as usual, and the score still goes on the leaderboards with an AI-assisted tag (the leaderboard can hide these).',
  'ui.assist.howAdvisor': 'AI only shows suggestion cards; nothing happens until you tap "Adopt". No effect on scores or uploads.',
  'ui.assist.howButtonTitle': 'The in-game AI button',
  'ui.assist.howButton':
    'AI button in the top bar (shortcut I): enable, switch roles or stop at any time — stopping gives you back full control.',
  'ui.assist.fairness':
    'For a full AI run from wave 1, start from "AI Battle" in the main menu; it also goes on the leaderboards, tagged AI-assisted with the model name.',
  'ui.assist.goNote': 'AI played for you in this run: rewards as usual; the score goes on the leaderboards tagged AI-assisted.',
  'ui.assist.goNoteAdvisor': 'You had an AI advisor this run; your score is unaffected.',
  'ui.tutorial.tip-ai.title': 'AI helper',
  'ui.tutorial.tip-ai.body': 'Stuck? Tap here (or press I) to get advice from AI — or let it play for a while.',
} satisfies Dict;
