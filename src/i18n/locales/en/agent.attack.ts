import type { Dict } from '../../index';

// Namespace agent · AI sets the waves (AI attacker, you defend; doc 10 §2.3; en)
export default {
  'agent.attack.label': 'AI attacker · {model}',
  'agent.attack.menu': 'AI sets the waves',
  'agent.attack.menuSub': 'New run: the AI rewrites every wave and you defend (not uploaded to online boards)',
  'agent.attack.menuConfirm': 'Click again to abandon this run and start an “AI sets the waves” run',
  'agent.attack.badge': 'AI attacker',
  'agent.attack.badgeTip': 'The AI attacker rewrites each wave before it starts; this run is only recorded locally, not uploaded',
  'agent.attack.unranked': 'Runs with an AI attacker aren’t ranked; they’re only recorded locally',
  'agent.attack.waveTag': 'AI wave {cost}/{budget}',
  'agent.attack.waveTip': 'The AI attacker rewrote this wave: {cost} / {budget} ink points spent',
  'agent.attack.pending': 'AI planning…',
  'agent.attack.pendingTip': 'The AI attacker will rewrite this wave before it starts (otherwise it’s the default wave)',
  'agent.attack.panel': 'AI attacker',
} satisfies Dict;
