import type { Dict } from '../../index';

// Namespace agent · AI vs AI (attacker model vs defender model) and the "AI sets the waves" setup entry (doc 10 §2.3; en)
export default {
  'agent.duel.label': 'ATK {attacker} vs DEF {defender}',
  'agent.duel.badge': 'AI vs AI',
  'agent.duel.badgeTip':
    'Two AIs in one run: the attacker rewrites each wave before it starts, the defender builds to stop it. Not ranked; recorded locally only',
  'agent.duel.unranked': 'AI vs AI runs aren’t ranked; they’re only recorded locally',
  'agent.duel.role': 'AI vs AI',
  'agent.duel.panel': 'AI vs AI',
  'agent.duel.side.attack': 'ATK',
  'agent.duel.side.defend': 'DEF',
  'agent.duel.lineThinking': '{model} thinking: {reasons}',
  'agent.duel.lineWaitAttack': '{model}: waiting for the next build phase to plan a wave',
  'agent.duel.lineWaitDefend': '{model}: waiting for the next decision point',
  'agent.duel.lineStopped': '{model}: stopped',
  'agent.duel.planAct': 'Wave plan: {plan}',
  'agent.duel.attackerModel': 'Attacker model',
  'agent.duel.defenderModel': 'Defender model',
  'agent.duel.roleAttack': 'AI sets the waves',
  'agent.duel.roleAttackDesc': 'The AI attacks and rewrites each wave before it starts; you defend (not uploaded to online boards)',
  'agent.duel.roleDuel': 'AI vs AI',
  'agent.duel.roleDuelDesc': 'Two models in one run: one plans the attack, the other builds the defense (recorded locally only)',
  'agent.duel.setupNote':
    'At each build phase the attacker rewrites the next wave first, then the defender decides. Both use pause mode; not ranked.',
  'agent.duel.attackNote':
    'The AI only plans during build phases (pause mode) and you defend. These runs aren’t uploaded; they’re recorded locally only.',
} satisfies Dict;
