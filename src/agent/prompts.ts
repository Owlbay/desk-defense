/**
 * 提示词（文档 10 §7）。
 *
 * 缓存布局（前缀匹配）：tools（固定顺序）→ system[0] 规则（按角色固定）→ system[1] 速查表（全局固定，带 cache_control）
 * → messages（每次决策：本局开局信息 + 原因 + 备忘 + 观测 / 增量）。
 * 规则与速查表不含任何随局变化的内容（种子、时间、金币……），所以同一模型、同一角色的所有局共享一份缓存。
 * 完整资料表（≈4.4k token）不再放进前缀，改由 get_catalog 按需取。
 */
import type { IWorld, RunOptions } from '../core/types';
import { TOWERS, TIER_NAMES } from '../config/towers';
import { ENEMIES, AFFIXES } from '../config/enemies';
import { SKILLS } from '../config/skills';
import { PERKS } from '../config/perks';
import { ABILITIES, EVOLUTION } from '../config/evolution';
import { RANDOM_EVENTS, CRATE_OPTIONS } from '../config/events';
import { TOWER_CHAR } from './observation';
import { ENEMY_CODE } from './compact';
import type { AgentRole, DecisionPoint } from './types';

export type CatalogSection = 'all' | 'towers' | 'enemies' | 'skills' | 'perks' | 'abilities' | 'events';

function towersSection(): string {
  const lines = ['## Towers (id name cost | role | air/ground | Lv1 dmg/interval/range | Lv4,Lv7 traits | Lv10 branches A/B)'];
  for (const t of Object.values(TOWERS)) {
    const hits = t.attacks ? `${t.hitsGround ? 'G' : ''}${t.hitsAir ? 'A' : ''}` : '-';
    const stats = t.attacks ? ` ${t.damage}/${t.interval}s/${t.range}` : '';
    const evo = EVOLUTION[t.id];
    const br = t.id === 'wall' ? '' : ` | A ${t.A.name}: ${t.A.desc} | B ${t.B.name}: ${t.B.desc}`;
    const ab = evo ? ` | ★3 A=${evo.A.ability.id} B=${evo.B.ability.id}` : '';
    lines.push(`- ${t.id} ${t.name} ${t.cost}g | ${t.role}: ${t.desc} | ${hits}${stats} | L4 ${t.t2.name}: ${t.t2.desc}; L7 ${t.t3.name}: ${t.t3.desc}${br}${ab}`);
  }
  lines.push(`Tiers: ${Object.values(TIER_NAMES).join('/')}. Levels 1..10 (wall 1..3). Towers gain XP from attacking and level up for free; gold upgrades are discounted by XP. Lv9→10 requires choosing branch A or B. Lv10 towers can evolve ★1..★3 with gold/XP; ★3 gives an active ability.`);
  return lines.join('\n');
}

function enemiesSection(): string {
  const lines = ['## Enemies (id name: desc [air] [boss])'];
  for (const e of Object.values(ENEMIES)) lines.push(`- ${e.id} ${e.name}: ${e.desc}${e.flying ? ' [air]' : ''}${e.boss ? ' [boss]' : ''}`);
  lines.push('## Elite affixes');
  for (const a of Object.values(AFFIXES)) lines.push(`- ${a.id} ${a.name}: ${a.desc}`);
  return lines.join('\n');
}

function skillsSection(): string {
  const lines = ['## Player skills (id name cooldown target: desc)'];
  for (const k of Object.values(SKILLS)) lines.push(`- ${k.id} ${k.name} cd${k.cd}s ${k.target}${k.radius ? ` r${k.radius}` : ''}: ${k.desc}`);
  return lines.join('\n');
}

function perksSection(): string {
  const lines = ['## Perks (offered 3-choose-1 every 10 waves; id name rarity: desc)'];
  for (const p of PERKS) lines.push(`- ${p.id} ${p.name} ${p.rarity}${p.needsTower ? ' needs uid+branch' : ''}: ${p.desc}`);
  lines.push('## Supply crate options');
  for (const c of CRATE_OPTIONS) lines.push(`- ${c.id} ${c.name}: ${c.desc}`);
  return lines.join('\n');
}

function abilitiesSection(): string {
  const lines = ['## Mythic abilities (★3; id form name cd target: desc)'];
  for (const a of Object.values(ABILITIES)) lines.push(`- ${a.id} ${a.form}·${a.name} cd${a.cd}s${a.chargeWaves ? ` (charge every ${a.chargeWaves} waves)` : ''} ${a.target}: ${a.desc}`);
  return lines.join('\n');
}

function eventsSection(): string {
  const lines = ['## Random events (id name tone: desc)'];
  for (const e of Object.values(RANDOM_EVENTS)) lines.push(`- ${e.id} ${e.name} ${e.tone}: ${e.desc}`);
  return lines.join('\n');
}

export function catalogText(section: CatalogSection = 'all'): string {
  switch (section) {
    case 'towers': return towersSection();
    case 'enemies': return enemiesSection();
    case 'skills': return skillsSection();
    case 'perks': return perksSection();
    case 'abilities': return abilitiesSection();
    case 'events': return eventsSection();
    default: return [towersSection(), enemiesSection(), skillsSection(), perksSection(), abilitiesSection(), eventsSection()].join('\n\n');
  }
}

/** 单座塔 / 单种敌人的完整资料（get_catalog {id}） */
export function catalogEntry(id: string): string | null {
  const t = (TOWERS as Record<string, (typeof TOWERS)[keyof typeof TOWERS]>)[id];
  if (t) {
    const hits = t.attacks ? `${t.hitsGround ? 'G' : ''}${t.hitsAir ? 'A' : ''}` : '-';
    const evo = EVOLUTION[t.id];
    const lines = [
      `${t.id} ${t.name} ${t.cost}g | ${t.role}: ${t.desc} | hits ${hits}${t.attacks ? ` | Lv1 ${t.damage}dmg/${t.interval}s r${t.range}` : ''}`,
      `L4 ${t.t2.name}: ${t.t2.desc}`, `L7 ${t.t3.name}: ${t.t3.desc}`,
    ];
    if (t.id !== 'wall') lines.push(`A ${t.A.name}: ${t.A.desc}`, `B ${t.B.name}: ${t.B.desc}`);
    if (evo) lines.push(`★3 A=${evo.A.ability.id} B=${evo.B.ability.id}`);
    return lines.join('\n');
  }
  const e = (ENEMIES as Record<string, (typeof ENEMIES)[keyof typeof ENEMIES]>)[id];
  if (e) return `${e.id} ${e.name}: ${e.desc} | hp${e.hp} spd${e.speed} armor${e.armor} lives${e.lives}${e.flying ? ' [air]' : ''}${e.boss ? ' [boss]' : ''}`;
  const k = (SKILLS as Record<string, (typeof SKILLS)[keyof typeof SKILLS]>)[id];
  if (k) return `${k.id} ${k.name} cd${k.cd}s ${k.target}${k.radius ? ` r${k.radius}` : ''}: ${k.desc}`;
  const a = (ABILITIES as Record<string, (typeof ABILITIES)[keyof typeof ABILITIES]>)[id];
  if (a) return `${a.id} ${a.form}·${a.name} cd${a.cd}s ${a.target}: ${a.desc}`;
  const pk = PERKS.find((x) => x.id === id);
  if (pk) return `${pk.id} ${pk.name} ${pk.rarity}${pk.needsTower ? ' needs uid+branch' : ''}: ${pk.desc}`;
  const ev = (RANDOM_EVENTS as Record<string, (typeof RANDOM_EVENTS)[keyof typeof RANDOM_EVENTS]>)[id];
  if (ev) return `${ev.id} ${ev.name} ${ev.tone}: ${ev.desc}`;
  return null;
}

/** 敌人的克制提示（速查表用；按敌人属性推出，不需要逐个维护） */
function counterOf(e: (typeof ENEMIES)[keyof typeof ENEMIES]): string {
  if (e.boss) return 'focus dps+skills';
  if (e.flying) return e.dodge ? 'AA: lamp/swatter' : 'AA: pencil/swatter/ruler';
  if (e.stealthy) return 'reveal: magnifier/whiteout/eraser_strike';
  if (e.shieldRatio) return 'burst/eraser';
  if (e.unstoppable) return 'dps, no cc';
  if (e.armor >= 2) return 'lamp/eraser (armor)';
  if (e.fast) return 'glue slow';
  return 'any';
}

/**
 * 速查表（固定前缀的第二块，≈600 token）：塔一行一个（价格 / 定位 / 对空 / Lv1 数值 / 传奇分支名）、
 * 敌人一行一个（代号 / 属性 / 克制）、技能一行。完整资料用 get_catalog 按需取。
 */
export function cheatSheet(): string {
  const tw = Object.values(TOWERS).map((t) => {
    const hits = t.attacks ? `${t.hitsGround ? 'G' : ''}${t.hitsAir ? 'A' : ''}` : '-';
    const st = t.attacks ? ` ${t.damage}/${t.interval}s r${t.range}` : '';
    const br = t.id === 'wall' ? '' : ` A:${t.A.name} B:${t.B.name}`;
    return `${TOWER_CHAR[t.id]} ${t.id} ${t.cost}g ${t.role} ${hits}${st}${br}`;
  });
  const en = Object.values(ENEMIES).map((e) => `${ENEMY_CODE[e.id]} ${e.id} hp${e.hp} v${e.speed}${e.armor ? ` ar${e.armor}` : ''}${e.flying ? ' air' : ''}${e.boss ? ' boss' : ''} → ${counterOf(e)}`);
  const sk = Object.values(SKILLS).map((k) => `${k.id}(${k.target},cd${k.cd})`).join(' ');
  return [
    '# Cheat sheet (static; full data: get_catalog)',
    'Towers (map char, id, cost, role, hits G/A, Lv1 dmg/interval range, Lv10 branches):',
    ...tw,
    'Enemies (code id hp speed armor → counter):',
    ...en,
    `Skills: ${sk}`,
    `Affixes: ${Object.keys(AFFIXES).join(' ')}`,
  ].join('\n');
}

const RULES = `You play 书桌防线 / Desk Defense (deterministic maze tower defense) through tools.

# Rules
- Board 12 cols (x 0..11) × 14 rows (y 0..13). Ground enemies walk the shortest path from spawns to the exit; every tower is a wall, so towers shape the maze. Placements that fully block a path are rejected. Flyers fly straight to the exit; only A towers hit them.
- Leaks cost lives (bosses more); 0 lives = loss. Gold: kills, wave bonus, interest on unspent gold, piggy banks, calling waves early.
- Phases: build, wave, perk (paused: pick 1 of 3), won/lost. Auto-wave starts later waves by itself; otherwise start_wave.
- Random events (warned), air-drop boxes that become spawns (demolish / seal_tape), coins/crates.
- Towers gain XP; gold upgrades are discounted by XP. Lv9→10 needs a branch. Lv10 → evolve ★1..★3; ★3 = tower_ability. Selling refunds part (full within 5 s).

# Strategy
- Long mazes win: cheap walls make the ground path long; stack damage where the route passes repeatedly. Use preview before walls.
- Keep anti-air near flight lines (R air aa%) before air waves (nx has [air]).
- Spend gold; idle gold above the interest cap is wasted. Upgrade a few strong towers in mid/late game.
- Skills when they matter: enemies near the exit, bosses, stealth.

# Each decision (be economical: every request costs money)
1. Read STATE (already in the message — do not call observe unless something is unclear).
2. Plan briefly, then make ONE act call with ALL actions in order and end:{...} included. A second act only to fix a REJECTED action.
3. end:{plan, maze, priorities, note} is your memory (≤300 tokens total), shown back as MEMO next time; omitted fields keep their old value.
- Every action is validated by the game; REJECTED lines say why — adapt, don't repeat.
- If nothing is worth doing: act {actions:[], end:{}}.

# STATE keys (after the first decision you get Δ = only changed keys; T+ changed/new towers, T- removed uids, _unset removed keys)
t time s | ph phase | w wave/total | g gold | hp lives | sc score | aw auto-wave | T towers "#uid id x,y Llevel [A|B] [★n] [x xp%] [t=target] [up cost|br cost=needs branch] [ev evolve cost] (costs rounded up to 5) [ab R|cd]" | W walls "uid@x,y" | E enemy groups "code×n hp% far/mid/near [A air] [B boss] [e elite] [h hidden]" | Ef enemy nearest exit | EB bosses | nx next wave "wN [tags] | spawner: code×n" | R ground routes "spawner:waypoints Llen" (turn points only; warn = air-drop landing soon) | Rs longest straight segments "spawner a>b Llen b=buildable cells beside" | Rp best tower spots "x,y:route cells within r2.5" | Ra flight lines "spawner from>to Llen aa% covering towers" | sk skills id:R|cd | ev events | sp drop boxes | pu pickups | perk offer | crate options | own perks | b build prices ("base" = cheat-sheet prices; else differences, locked, max) | rc since last decision | pe queued errors.
- MAP (sent when terrain changes): rows y, cols x (0..9,a,b). . empty | # obstacle | S spawn | X exit | d drop warning | D drop spawn | route letters a,b,c… (+ overlap, ~ future drop route) | towers: ${Object.entries(TOWER_CHAR).map(([k, v]) => `${v}=${k}`).join(' ')}. "(RLE)" rows: "3." = "...".`;

const ROLE_TEXT: Record<AgentRole, string> = {
  player: `# Role: AI player (defender). Maximize waves survived and score.`,
  advisor: `# Role: AI advisor (军师). A human plays; you cannot act. Read STATE, then call suggest once (Chinese, concise, concrete coordinates/uids, actions like "place pencil 3,5"). suggest ends your turn.`,
  attacker: `# Role: AI attacker (design stub). The attacker protocol is not implemented; reply with a one-line plan and no tool calls.`,
};

/** 固定前缀的两个块：[规则 + 角色, 速查表]。纯函数、逐字节稳定（无种子 / 时间 / 随局内容），所有局共享缓存。 */
export function systemBlocks(role: AgentRole): [string, string] {
  return [`${RULES}\n\n${ROLE_TEXT[role]}`, cheatSheet()];
}

/** 本局开局信息（放在每次决策 user 消息的开头，随局变化但同局内不变） */
export function runHeader(opts: RunOptions, w: IWorld): string {
  const st = w.state;
  const all = st.unlockedTowers.length >= Object.keys(TOWERS).length;
  return `Game: mode ${opts.mode}, map ${opts.map}, difficulty ${opts.difficulty}${opts.abyssLevel ? ` ${opts.abyssLevel}` : ''}, seed ${st.seed}, ` +
    `skills ${st.skills.map((k) => k.id).join(',')}, autoWave ${st.autoWave.enabled ? 'on' : 'off'}, towers ${all ? 'all unlocked' : st.unlockedTowers.join(',')}.`;
}

const REASON_TEXT: Record<string, string> = {
  game_start: 'game start — plan the opening maze',
  build: 'build phase — spend gold for the next wave',
  wave_interval: 'periodic check',
  event_warn: 'random event announced',
  drop_warn: 'air-drop landing soon',
  boss_spawn: 'boss appeared',
  perk: 'perk offer — choose_perk now',
  crate: 'crate opened — choose_crate',
  leak: 'enemies leaked',
};

export interface DecisionMessageParts {
  header: string;
  point: DecisionPoint;
  /** 观测文本（完整 JSON 或增量 JSON，可带 MAP） */
  observation: string;
  /** 结构化备忘（上次 end 写的） */
  memo?: string;
  /** 跳过的决策点数（门控）——提示模型中间发生过的事件已合并进 rc */
  skipped?: number;
  extra?: string;
  /** 是否增量 */
  delta?: boolean;
}

export function decisionMessage(p: DecisionMessageParts): string;
export function decisionMessage(header: string, point: DecisionPoint, observation: string, extra?: string): string;
export function decisionMessage(a: string | DecisionMessageParts, point?: DecisionPoint, observation?: string, extra?: string): string {
  const p: DecisionMessageParts = typeof a === 'string' ? { header: a, point: point!, observation: observation!, extra } : a;
  const why = p.point.reasons.map((r) => REASON_TEXT[r] ?? r).join('; ');
  const lines = [...(p.header ? [p.header] : []), `Decision #${p.point.seq} t=${p.point.time.toFixed(1)}s: ${why}.${p.skipped ? ` (${p.skipped} quiet checks skipped)` : ''}`];
  if (p.extra) lines.push(p.extra);
  if (p.memo) lines.push(`MEMO ${p.memo}`);
  lines.push(p.delta ? 'STATE Δ' : 'STATE', p.observation, 'Act now: one act call with all actions + end.');
  return lines.join('\n');
}
