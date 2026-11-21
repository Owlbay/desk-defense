import type { Dict } from '../../index';

// Namespace agent · AI vs AI (attacker model vs defender model) and the "AI sets the waves" setup entry (doc 10 §2.3; en)
export default {
  'agent.duel.label': 'ATK {attacker} vs DEF {defender}',
  'agent.duel.badge': 'AI vs AI',
  'agent.duel.badgeTip':
    'Two AIs in one run: the attacker rewrites each wave before it starts, the defender builds to stop it. Not on the Endless / Daily / Campaign boards; results go to a separate AI vs AI board',
  'agent.duel.unranked': 'AI vs AI runs aren’t on the Endless / Daily / Campaign boards; results go to a separate AI vs AI board',
  'agent.duel.role': 'AI vs AI',
  'agent.duel.panel': 'AI vs AI',
  'agent.duel.side.attack': 'ATK',
  'agent.duel.side.defend': 'DEF',
  'agent.duel.lineThinking': '{model} thinking: {reasons}',
  'agent.duel.lineWaitAttack': '{model}: will plan the following wave once the next one starts',
  'agent.duel.lineWaitDefend': '{model}: waiting for the next decision point',
  'agent.duel.lineStopped': '{model}: stopped',
  'agent.duel.planAct': 'Wave plan: {plan}',
  'agent.duel.attackerModel': 'Attacker model',
  'agent.duel.defenderModel': 'Defender model',
  'agent.duel.roleAttack': 'AI sets the waves',
  'agent.duel.roleAttackDesc': 'The AI attacks and rewrites each wave before it starts; you defend (not uploaded to online boards)',
  'agent.duel.roleDuel': 'AI vs AI',
  'agent.duel.roleDuelDesc':
    'Two models in one run: one plans the attack, the other builds the defense (uploaded to a separate AI vs AI board)',
  'agent.duel.setupNote':
    'At each build phase the attacker rewrites the next wave first, then the defender decides. Both use pause mode. Full data is kept locally; results go to a separate AI vs AI board (models and thinking levels only).',
  'agent.duel.attackNote':
    'As each wave starts, the AI plans the next one in the background (no pause; starting a wave waits briefly if the plan isn’t ready). You defend. Not uploaded; recorded locally only.',
} satisfies Dict;
