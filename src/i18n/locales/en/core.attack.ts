import type { Dict } from '../../index';

// Namespace core · why an AI attacker's wave override was rejected (doc 10 §2.3; en)
export default {
  'core.reason.attackPhase': 'The next wave can only be rewritten in the build phase, before it starts',
  'core.reason.attackWave': 'Only the next wave (wave {wave}) can be rewritten',
  'core.reason.attackBadPlan': 'Invalid plan: it needs at least one enemy group',
  'core.reason.attackGroups': 'At most {max} enemy groups',
  'core.reason.attackEnemy': '{name} is not in this wave’s enemy pool',
  'core.reason.attackCount': 'Each group needs 1–{max} enemies',
  'core.reason.attackAffixCount': 'At most {max} affixes per group',
  'core.reason.attackAffix': '{name} can’t have the “{affix}” affix',
  'core.reason.attackSpawner': 'Spawn point {id} isn’t available now',
  'core.reason.attackDelay': 'Start time must be 0–{max} s',
  'core.reason.attackBudget': 'Not enough ink points: needs {cost}, budget {budget}',
  'core.reason.attackHp': 'Too strong: HP equivalent {hp} exceeds the cap of {cap}',
} satisfies Dict;
