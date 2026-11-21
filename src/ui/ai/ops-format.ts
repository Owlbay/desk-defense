/**
 * 操作解读的文案（当前语言；名称在读取时翻译）：一条操作 → 一行人话，意图组 → 组头 + 结果摘要。
 */
import { TOWERS } from '../../config/towers';
import { ABILITY_META, PERK_META, SKILL_META, TOWER_META } from '../../core';
import type { TowerId } from '../../core/types';
import { fmtNumber, t, tOr } from '../../i18n';
import { spawnerName } from '../coreMeta';
import type { Op, OpGroup, OpKind, OpsTotals } from './ops';

const towerName = (id: string | undefined): string => (id ? (TOWER_META[id as TowerId]?.name ?? id) : t('agent.ops.aTower'));
const towerRef = (op: Op): string =>
  op.uid !== undefined ? t('agent.ops.towerRef', { name: towerName(op.tower), uid: op.uid }) : towerName(op.tower);
const skillName = (id: string | undefined): string => (id ? (SKILL_META[id as keyof typeof SKILL_META]?.name ?? id) : '?');
const perkName = (id: string | undefined): string => (id ? (PERK_META.find((p) => p.id === id)?.name ?? id) : '?');
const abilityName = (op: Op): string => {
  if (op.ability && ABILITY_META[op.ability]) return ABILITY_META[op.ability].name;
  return op.ability ?? towerRef(op);
};
const branchName = (tower: string | undefined, b: string | undefined): string => {
  const def = tower ? (TOWERS as Record<string, { A?: { name: string }; B?: { name: string } }>)[tower] : undefined;
  const n = b === 'A' ? def?.A?.name : b === 'B' ? def?.B?.name : undefined;
  return n ?? '';
};
const TARGETS = new Set(['first', 'last', 'strong', 'weak', 'close', 'air']);
const CRATES = new Set(['gold', 'lives', 'cooldown', 'xp', 'caffeine', 'charge']);
const targetName = (m: unknown): string => (typeof m === 'string' && TARGETS.has(m) ? t(`agent.actions.target.${m}`) : String(m ?? '?'));
const crateName = (o: string | undefined): string => (o && CRATES.has(o) ? t(`agent.actions.crate.${o}`) : (o ?? '?'));

/** 「 @ (x,y)」；多格时取第一格并注明格数 */
export function atText(op: Pick<Op, 'cells'>): string {
  const c = op.cells;
  if (!c?.length) return '';
  if (c.length > 3) return t('agent.ops.atLine', { x: c[0].x, y: c[0].y, n: c.length });
  return t('agent.ops.at', { x: c[0].x, y: c[0].y });
}

/** 金币变化（负 = 花费） */
export const goldText = (g: number): string =>
  g < 0 ? t('agent.ops.goldSpend', { n: fmtNumber(-g) }) : t('agent.ops.goldGain', { n: fmtNumber(g) });

/** 操作本身的描述（不含成败前缀、不含金币） */
export function opWhat(op: Op): string {
  const at = atText(op);
  switch (op.k) {
    case 'place':
      return t('agent.ops.place', { tower: towerName(op.tower), at });
    case 'sell':
      return t('agent.ops.sell', { tower: towerRef(op), at });
    case 'upgrade':
      return op.from !== undefined && op.to !== undefined
        ? t('agent.ops.upgradeTo', { tower: towerRef(op), from: op.from, to: op.to })
        : t('agent.ops.upgrade', { tower: towerRef(op) });
    case 'branch': {
      const name = branchName(op.tower, op.branch);
      return name
        ? t('agent.ops.branchNamed', { branch: op.branch ?? '?', name, tower: towerRef(op) })
        : t('agent.ops.branch', { branch: op.branch ?? '?', tower: towerRef(op) });
    }
    case 'evolve':
      if (op.stars === undefined) return t('agent.ops.evolve', { tower: towerRef(op) });
      return op.mythic
        ? t('agent.ops.evolveMythic', { tower: towerRef(op), stars: op.stars })
        : t('agent.ops.evolveStars', { tower: towerRef(op), stars: op.stars });
    case 'cast':
      return op.spawner && !op.cells?.length
        ? t('agent.ops.castOn', { skill: skillName(op.skill), target: spawnerName(op.spawner) })
        : t('agent.ops.cast', { skill: skillName(op.skill), at });
    case 'ability':
      return t('agent.ops.ability', { ability: abilityName(op), at });
    case 'target':
      return op.from !== undefined && op.from !== op.to
        ? t('agent.ops.targetFrom', { tower: towerRef(op), from: targetName(op.from), to: targetName(op.to) })
        : t('agent.ops.target', { tower: towerRef(op), to: targetName(op.to) });
    case 'perk':
      return t('agent.ops.perk', { perk: perkName(op.perk) });
    case 'reroll':
      return t('agent.ops.reroll');
    case 'crate':
      return t('agent.ops.crate', { option: crateName(op.option) });
    case 'demolish':
      return t('agent.ops.demolish', { spawner: op.spawner ? spawnerName(op.spawner) : t('agent.ops.aSpawner'), at });
    case 'collect':
      return op.pickup === 'crate' ? t('agent.ops.collectCrate', { at }) : t('agent.ops.collectCoin', { at });
    case 'wave': {
      const n = op.wave ?? '?';
      return op.gold && op.gold > 0 ? t('agent.ops.waveEarly', { n, bonus: fmtNumber(op.gold) }) : t('agent.ops.wave', { n });
    }
    case 'end':
      return op.note ? t('agent.ops.endNote', { note: op.note.length > 80 ? `${op.note.slice(0, 80)}…` : op.note }) : t('agent.ops.end');
    default:
      return t('agent.ops.other');
  }
}

/** 被拒原因（当前语言；原因码优先） */
export function rejectReason(op: Op): string {
  const fb = op.reason ?? t('agent.ops.unknownReason');
  return op.code ? tOr(`core.reason.${op.code}`, fb) : fb;
}

/** 完整一行（含成败前缀与挪位说明；金币另外显示，见 opGold） */
export function opLine(op: Op): string {
  const what = opWhat(op);
  if (!op.ok)
    return op.invalid
      ? t('agent.ops.invalid', { what, reason: rejectReason(op) })
      : t('agent.ops.rejected', { what, reason: rejectReason(op) });
  if (op.movedFrom) return `${what}${t('agent.ops.moved', { x: op.movedFrom.x, y: op.movedFrom.y })}`;
  return what;
}

/** 行尾的金币标签（开波的提前奖励已写在文字里） */
export function opGold(op: Op): string | null {
  if (!op.ok || !op.gold || op.k === 'wave') return null;
  return goldText(op.gold);
}

const ICON: Record<OpKind, string> = {
  place: 'hammer',
  sell: 'sell',
  upgrade: 'up',
  branch: 'crown',
  evolve: 'star',
  cast: 'sparkle',
  ability: 'bolt',
  target: 'target',
  perk: 'gift',
  reroll: 'refresh',
  crate: 'crate',
  demolish: 'parachute',
  collect: 'coin',
  wave: 'wave',
  end: 'check',
  other: 'list',
};
/** 图标名（src/ui/icons.ts 的 G 键） */
export const opIcon = (op: Op): string => (op.ok ? ICON[op.k] : 'close');

// ───────────── 组 ─────────────

const INTENTS = new Set([
  'maze',
  'build_near',
  'upgrade_best',
  'anti_air',
  'spend',
  'save',
  'combo',
  'support',
  'economy',
  'reclaim',
  'rebuild_maze',
]);

function argText(k: string, v: unknown): string | null {
  switch (k) {
    case 'style':
      return v === 'serpentine' || v === 'funnel' ? t(`agent.ops.style.${v}`) : String(v);
    case 'budget':
      return t('agent.ops.arg.budget', { n: String(v) });
    case 'tower':
      return towerName(String(v));
    case 'count':
      return t('agent.ops.arg.count', { n: String(v) });
    case 'route':
      return t('agent.ops.arg.route', { id: spawnerName(String(v)) });
    case 'reserve':
      return t('agent.ops.arg.reserve', { n: String(v) });
    case 'until':
      return t('agent.ops.arg.until', { n: String(v) });
    case 'target':
    case 'focus':
    case 'metric':
    case 'pair':
    case 'what':
    case 'purpose':
      return String(v);
    default:
      return null;
  }
}

/** 组头（意图：名称 + 参数；兜底 / 决策后 / 旧工具：固定标题；act 的底层动作：无组头） */
export function groupTitle(g: OpGroup): string | null {
  switch (g.kind) {
    case 'intent': {
      const name = g.intent ?? '?';
      const label = INTENTS.has(name) ? t(`agent.ops.intent.${name}`) : t('agent.ops.intent.other', { name });
      const args = Object.entries(g.args ?? {})
        .map(([k, v]) => argText(k, v))
        .filter((x): x is string => !!x);
      return args.length ? t('agent.ops.intentHead', { label, args: args.join(t('agent.ops.sep')) }) : label;
    }
    case 'auto':
      return t('agent.ops.group.auto');
    case 'after':
      return t('agent.ops.group.after');
    case 'tool':
      return t('agent.ops.group.tool', { name: g.tool ?? '?' });
    default:
      return null;
  }
}

/** 意图结果摘要：「8 面墙，−80 金，路线 24→41」或「没做成」 */
export function groupSummary(g: OpGroup): string | null {
  if (g.kind !== 'intent') return null;
  const ok = g.ops.filter((o) => o.ok);
  const parts: string[] = [];
  if (!ok.length) parts.push(t('agent.ops.sum.noop'));
  else if (ok.every((o) => o.k === 'place' && o.tower === 'wall')) parts.push(t('agent.ops.sum.walls', { n: ok.length }));
  else if (ok.every((o) => o.k === 'sell')) parts.push(t('agent.ops.sum.sold', { n: ok.length }));
  else parts.push(t('agent.ops.sum.ops', { n: ok.length }));
  const gold = ok.reduce((s, o) => s + (o.gold ?? 0), 0);
  if (gold) parts.push(goldText(gold));
  if (g.path && g.path[0] !== g.path[1]) parts.push(t('agent.ops.sum.path', { a: g.path[0], b: g.path[1] }));
  return parts.join(t('agent.ops.sep'));
}

/** 顶部「本局操作汇总」的条目 */
export function totalsItems(tt: OpsTotals): { label: string; value: string; tone?: 'bad' | 'gold' }[] {
  return [
    { label: t('agent.ops.tot.build'), value: fmtNumber(tt.build) },
    { label: t('agent.ops.tot.sell'), value: fmtNumber(tt.sell) },
    { label: t('agent.ops.tot.upgrade'), value: fmtNumber(tt.upgrade) },
    { label: t('agent.ops.tot.skill'), value: fmtNumber(tt.skill) },
    { label: t('agent.ops.tot.rejected'), value: fmtNumber(tt.rejected), tone: tt.rejected ? 'bad' : undefined },
    { label: t('agent.ops.tot.spent'), value: t('agent.ops.goldN', { n: fmtNumber(tt.spent) }), tone: 'gold' },
    { label: t('agent.ops.tot.refunded'), value: t('agent.ops.goldN', { n: fmtNumber(tt.refunded) }), tone: 'gold' },
  ];
}
