/**
 * 提示词（文档 10 §7）。
 *
 * 缓存布局（前缀匹配）：tools（固定顺序）→ system[0] 规则（按角色固定）→ system[1] 速查表（全局固定，带 cache_control）
 * → messages（每次决策：本局开局信息 + 原因 + 备忘 + 观测 / 增量）。
 * 规则与速查表不含任何随局变化的内容（种子、时间、金币……），所以同一模型、同一角色的所有局共享一份缓存。
 * 完整资料表（≈4.4k token）不再放进前缀，改由 get_catalog 按需取。
 */
import { ATTACK } from '../config/attack';
import { AFFIXES, ENEMIES } from '../config/enemies';
import { CRATE_OPTIONS, RANDOM_EVENTS } from '../config/events';
import { ABILITIES, EVOLUTION } from '../config/evolution';
import { PERKS } from '../config/perks';
import { SKILLS } from '../config/skills';
import { TIER_NAMES, TOWERS } from '../config/towers';
import { COMBOS } from '../config/towers';
import type { IWorld, RunOptions } from '../core/types';
import { ENEMY_CODE } from './compact';
import { TOWER_CHAR } from './observation';
import { enemyPurposes, PURPOSES, purposeText } from './purpose';
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
    lines.push(
      `- ${t.id} ${t.name} ${t.cost}g | ${t.role}: ${t.desc} | ${hits}${stats} | L4 ${t.t2.name}: ${t.t2.desc}; L7 ${t.t3.name}: ${t.t3.desc}${br}${ab}`,
    );
  }
  lines.push(
    `Tiers: ${Object.values(TIER_NAMES).join('/')}. Levels 1..10 (wall 1..3). Towers gain XP from attacking and level up for free; gold upgrades are discounted by XP. Lv9→10 requires choosing branch A or B. Lv10 towers can evolve ★1..★3 with gold/XP; ★3 gives an active ability.`,
  );
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
  for (const k of Object.values(SKILLS))
    lines.push(`- ${k.id} ${k.name} cd${k.cd}s ${k.target}${k.radius ? ` r${k.radius}` : ''}: ${k.desc}`);
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
  for (const a of Object.values(ABILITIES))
    lines.push(
      `- ${a.id} ${a.form}·${a.name} cd${a.cd}s${a.chargeWaves ? ` (charge every ${a.chargeWaves} waves)` : ''} ${a.target}: ${a.desc}`,
    );
  return lines.join('\n');
}

function eventsSection(): string {
  const lines = ['## Random events (id name tone: desc)'];
  for (const e of Object.values(RANDOM_EVENTS)) lines.push(`- ${e.id} ${e.name} ${e.tone}: ${e.desc}`);
  return lines.join('\n');
}

export function catalogText(section: CatalogSection = 'all'): string {
  switch (section) {
    case 'towers':
      return towersSection();
    case 'enemies':
      return enemiesSection();
    case 'skills':
      return skillsSection();
    case 'perks':
      return perksSection();
    case 'abilities':
      return abilitiesSection();
    case 'events':
      return eventsSection();
    default:
      return [towersSection(), enemiesSection(), skillsSection(), perksSection(), abilitiesSection(), eventsSection()].join('\n\n');
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
      `L4 ${t.t2.name}: ${t.t2.desc}`,
      `L7 ${t.t3.name}: ${t.t3.desc}`,
    ];
    if (t.id !== 'wall') lines.push(`A ${t.A.name}: ${t.A.desc}`, `B ${t.B.name}: ${t.B.desc}`);
    if (evo) lines.push(`★3 A=${evo.A.ability.id} B=${evo.B.ability.id}`);
    return lines.join('\n');
  }
  const e = (ENEMIES as Record<string, (typeof ENEMIES)[keyof typeof ENEMIES]>)[id];
  if (e)
    return `${e.id} ${e.name}: ${e.desc} | hp${e.hp} spd${e.speed} armor${e.armor} lives${e.lives}${e.flying ? ' [air]' : ''}${e.boss ? ' [boss]' : ''}`;
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

/** 敌人的克制提示（速查表 / CTR 用；按敌人属性推出的用途，见 purpose.ts） */
export function counterOf(e: (typeof ENEMIES)[keyof typeof ENEMIES]): string {
  const ps = enemyPurposes(e);
  if (!ps.length) return 'any';
  return ps.join('+') + (e.id === 'tape' ? ' no-slow' : '');
}

/** 每种塔什么时候用（速查表；静态文本，改了就改了缓存前缀） */
const TOWER_USE: Record<string, string> = {
  pencil: 'cheap G+A, opener, any lane',
  stapler: 'AoE r1.6 at U-turns/merges, swarms',
  glue: 'slow, early route, feeds stapler/compass',
  lamp: 'ramping beam, pierces armor, sees stealth r1.5',
  compass: 'ring 0.8-1.8, cell between two lanes',
  eraser: '-armor, ×3 vs shield, early route',
  ruler: 'r4.5 pierce, end of long straight lanes',
  pen: 'DoT, halves healing',
  calculator: 'aura r2 +dmg, amid ≥3 strong towers {do:"support"}',
  piggy: '+8g/wave max3, early when safe {do:"economy"}',
  swatter: 'air only splash {do:"anti_air"}',
};

/** 台灯（持续光束 / 递增 / 光棱联动，docs/notes-lamp-for-agent.md）；静态文本 */
const LAMP_NOTE =
  'Lamp: beam ignores armor, +60%/s on one target up to 3x, resets on retarget: bosses/armor/long straights, weak vs swarms/fast. ' +
  "Lamps <=2.5 apart link (group max 4, unlimited with an A laser); the lead beam gets the others' light (4 equal ~3.9x). " +
  'Before boss waves cluster 3-4 lamps 2 cells apart by the boss lane; vs swarms spread them. A: 5x ramp, overload when a boss enters.';

/** 怪物类随机事件的应对（ev 行；EG = 金色目标）；静态文本 */
const EVENT_NOTE =
  'Events (ev; EG = coin targets): goldbag gb fast, regens if unhit 2s: focus fire + eraser_strike/slow, kill = coins (pu), leak steals gold | golden elite (EG) drops coins: target it | ' +
  'tea_break heal / shield_supply: burst skills, pen halves heal, eraser 3x shield | medic_squad wo: pen/aoe | ' +
  "frenzy (+30% speed, +50% kill gold) / bounty (2x kill gold): slow + buy DPS now | training 2x XP: keep towers firing, don't sell.";

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
  const en = Object.values(ENEMIES).map(
    (e) =>
      `${ENEMY_CODE[e.id]} ${e.id} hp${e.hp} v${e.speed}${e.armor ? ` ar${e.armor}` : ''}${e.flying ? ' air' : ''}${e.boss ? ' boss' : ''} → ${counterOf(e)}`,
  );
  const sk = Object.values(SKILLS)
    .map((k) => `${k.id}(${k.target},cd${k.cd})`)
    .join(' ');
  return [
    '# Cheat sheet (static; full data: get_catalog)',
    'Towers (map char, id, cost, role, hits G/A, Lv1 dmg/interval range, Lv10 branches):',
    ...tw,
    'Enemies (code id hp speed armor → counter):',
    ...en,
    `Skills: ${sk}`,
    `Affixes: ${Object.keys(AFFIXES).join(' ')}`,
    `Use: ${Object.entries(TOWER_USE)
      .map(([id, u]) => `${id} ${u}`)
      .join(' | ')}`,
    `Purposes (enemy → purpose; {do:"build_near",purpose} picks): ${PURPOSES.map(purposeText).join(' ')}`,
    `Combos (orthogonally adjacent, auto; {do:"combo",pair}): ${COMBOS.map((c) => `${c.a}+${c.b} ${c.desc}`).join(' | ')}`,
    'Wall next to attack towers: upgrade Lv2 (+15g) range+5%, Lv3 (+30g) +5% dmg. Swapping a wall for a tower keeps the maze (towers block too).',
    'Branches: stapler B shreds armor | glue A roots fast/B burns | lamp A melts bosses/B stealth+amp | ruler B executes | pen B +20% dmg taken | swatter B nets flyers to ground. Evolve top-damage Lv10 first; ★3 ability on bosses.',
    LAMP_NOTE,
    EVENT_NOTE,
  ].join('\n');
}

const RULES_V1 = `You play 书桌防线 / Desk Defense (deterministic maze tower defense) through tools.

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
t time s | ph phase | w wave/total | g gold | hp lives | sc score | aw auto-wave | T towers "#uid id x,y Llevel [A|B] [★n] [x xp%] [t=target] [up cost|br cost=needs branch] [ev evolve cost] (costs rounded up to 5) [ab R|cd]" | W walls "uid@x,y" | E enemy groups "code×n hp% far/mid/near [A air] [B boss] [e elite] [h hidden]" | Ef enemy nearest exit | EB bosses | EG coin targets | nx next wave "wN [tags] | spawner: code×n" | R ground routes "spawner:waypoints Llen" (turn points only; warn = air-drop landing soon) | Rs longest straight segments "spawner a>b Llen b=buildable cells beside" | Rp best tower spots "x,y:route cells within r2.5" | Ra flight lines "spawner from>to Llen aa% covering towers" | sk skills id:R|cd | ev events | sp drop boxes | pu pickups | perk offer | crate options | own perks | b build prices ("base" = cheat-sheet prices; else differences, locked, max) | rc since last decision | pe queued errors.
- MAP (sent when terrain changes): rows y, cols x (0..9,a,b). . empty | # obstacle | S spawn | X exit | d drop warning | D drop spawn | route letters a,b,c… (+ overlap, ~ future drop route) | towers: ${Object.entries(
  TOWER_CHAR,
)
  .map(([k, v]) => `${v}=${k}`)
  .join(' ')}. "(RLE)" rows: "3." = "...".`;

const RULES_HEAD = `You play 书桌防线 / Desk Defense (deterministic maze tower defense) through tools.

# Rules
- Board 12×14 (x 0..11, y 0..13). Ground enemies walk the shortest path spawn→exit; every tower (walls too) blocks, so towers shape the maze; path-blocking placements are rejected. Flyers fly straight to the exit; only A towers hit them.
- Leaks cost lives (bosses more); 0 = loss. Gold: kills, wave bonus, 5% interest (cap ≈20), piggy banks, early waves.
- Phases build / wave / perk (paused, pick 1 of 3) / won / lost. Auto-wave starts later waves. Events are warned; air-drop boxes become spawns (demolish / seal_tape).
- Towers gain XP (cheaper upgrades). Lv9→10 branch; Lv10 → evolve ★1..★3 (★3 = tower_ability). Selling refunds part (full within 5 s).
`;

const RULES = `${RULES_HEAD}
# How to win
1. Maze early: a straight route is ≈14 cells, a 5g-wall serpentine makes it 40-60 (towers shoot 3-4× longer). {do:"maze"} builds a proven serpentine barrier by barrier (never blocks); build_near/spend put towers inside the barriers.
2. Keep gold working: interest is tiny; end build phases with ≲20g unless saving on purpose ({do:"save",until:N}).
3. Waves 1-6 buy towers; later upgrade_best too (Lv4/Lv7 are big jumps; Lv9 branch auto-picked).
4. Before [air] waves every flight line (Ra) needs an A tower: {do:"anti_air"}.
5. Mix roles: pencils alone fail vs armor/swarms/air/healers. CTR maps next-wave enemies to purposes → {do:"build_near",purpose:"armor"} (planner picks eraser/lamp…). Pair combos ({do:"combo"}; CB line). Skills on leaks / bosses / Ef d≤3.
6. TH = next-wave threat (your damage ÷ incoming HP): 危险/吃紧 → add damage there now; 安全 → may call early. BR = last wave; LK = each leaked enemy (hp left, % time in range, uncovered cells); GAP = recurring holes → build_near target "seg:…" / anti_air. KH = where kills happen.
7. Full board: a wall refunds 3g but a freed good cell holds a tower. RC (useless walls / 0-dmg towers / crowded cells) → {do:"reclaim"}; routes changed → {do:"rebuild_maze"}. MZ = route vs achievable length.
Openings (150g): [{do:"spend",reserve:0}] (= 4 pencils + first barriers). ch2: two entrances merge → build_near target "chokepoint". ch3: long flight lines → anti_air each line early.
Each build phase: anti_air if [air], maze, fix LK/GAP/CTR, spend; ≈w6+ upgrade_best; reclaim/combo when RC/CB suggest.

# Each decision
1. STATE is in the message; observe only if unclear.
2. ONE act call with ALL actions + end:{…}. Prefer intents (the planner picks valid cells, reports cells/costs/path).
3. end:{plan,maze,priorities,note} = your memory (≤300 tokens), shown as MEMO; omitted fields keep old values.
Example (build, g140, nx [air]): act {actions:[{do:"anti_air"},{do:"maze",budget:40},{do:"spend",reserve:10}],end:{plan:"serpentine+pencils; AA before air",priorities:"upgrade_best from w6"}}

# STATE keys (after the first decision you get Δ = only changed keys; T+ changed/new towers, T- removed uids, _unset removed keys)
t time s | ph phase | w wave/total | g gold | hp lives | sc score | aw auto-wave | T towers "#uid id x,y Llevel [A|B] [★n] [x xp%] [t=target] [up cost|br cost=needs branch] [ev evolve cost] [ab R|cd]" | W walls "uid@x,y" | E enemy groups "code×n hp% far/mid/near [A air] [B boss] [e elite] [h hidden]" | Ef enemy nearest exit | EB bosses | EG coin targets | nx next wave "wN [tags] | spawner: code×n" | R ground routes "sp:turn points Llen" (warn = drop landing soon) | Rs long straights "sp a>b Llen b=free cells beside" | Rp best spots "x,y:route cells in r2.5" | Ra flight lines "sp from>to Llen aa% towers" | sk skills id:R|cd | ev events | sp drop boxes | pu pickups | perk offer | crate options | own perks | b prices ("base" = cheat sheet; else diffs/locked/max) | rc since last decision | pe queued errors.
- Extra lines: BR TH CTR LK GAP KH RC CB MZ (above), IDLE unspent gold, EVT event tips.
- MAP (sent when terrain changes): rows y, cols x (0..9,a,b). . empty | # obstacle | S spawn | X exit | d drop warning | D drop spawn | route letters a,b,c… (+ overlap, ~ future drop route) | towers: ${Object.entries(
  TOWER_CHAR,
)
  .map(([k, v]) => `${v}=${k}`)
  .join(' ')}. "(RLE)" rows: "3." = "...".`;

const ROLE_TEXT: Record<AgentRole, string> = {
  player: `# Role: AI player (defender). Maximize waves survived and score.`,
  advisor: `# Role: AI advisor (军师). A human plays; you cannot act. Read STATE, then call suggest once (Chinese, concise, concrete coordinates/uids, actions like "place pencil 3,5"). suggest ends your turn.`,
  attacker: `# 角色：AI 进攻方（出题人）。防守方是真人（无头评测里是机器人）。你不能建塔，只能在每波开始前用预算改写下一波，目标是让防守方漏怪掉命，但每一波都要合规。`,
};

/** 进攻方规则（文档 10 §2.3；固定文本，进固定前缀） */
const ATTACK_RULES = `你在玩《书桌防线》（确定性的迷宫塔防），扮演进攻方，通过工具出题。

# 规则
- 每波开始前（建造阶段）你有预算 budget = ${ATTACK.baseBudget} + ${ATTACK.perWave}×波数「墨水点」，用 attack_plan 改写下一波；不调用则保留默认波。
- 价格：单价 = 敌人赏金 × ${ATTACK.priceFactor}（STATE.pool 里的 $）；每个词缀 +单价×${ATTACK.affixSurcharge}（向上取整，至少 1）；从空降点（spawners 里带 (drop)）出来每只再 +单价×${ATTACK.dropSurcharge}+1。
- 限制：只能用 pool 里的敌人（Boss 不能编排；Boss 波的 Boss 原样保留）；最多 ${ATTACK.maxGroups} 组、每组 ${ATTACK.maxCount} 只、${ATTACK.maxAffixes} 个词缀（不含 golden）；生命当量（基础生命 × 数量，带词缀 = 精英 ×2.5）≤ hpCap（默认波 baseHp 的 ${ATTACK.hpCap} 倍）。delay = 本组开波后第几秒出发（0..${ATTACK.maxDelay}）。
- 地面敌人沿最短路走到出口，路线越长（R 的 L）塔打得越久；飞行敌人直飞出口，只有能打空的塔（aa = 对空塔数量）能拦。

# 打法
1. 看防守方的弱点：aa 少 → 飞行敌人；路线短 / 塔少 → 大量便宜地面敌人；单体塔多 → 一大群；减速 / 范围塔多 → 少量高血、护甲或护盾精英。
2. 集中火力比平均分配有效；快敌（fast）适合短路线，护甲（armor）克制低伤害塔。
3. hist = 最近几波的结果（leak 漏怪数、-hp 掉命）：有效的组合可以加码，无效的换思路。
4. 用 note 记下你的思路（下次作为 MEMO 回显）。

# STATE 键
w 下一波 | open 能否改写 | budget 预算 | hpCap/baseHp 生命当量上限 / 默认值 | tags 默认波标签 | boss 保留的 Boss | pool "id $单价 hp基础生命 特性" | affixes 可用词缀 | spawners 可指定的出生点 | default 默认波组成 | planned 已改写的花费 | def 防守方：hp 生命、g 金币、T 塔（类型×数量 平均等级）、aa 对空塔、R 地面路线长度 | hist 最近几波。

# 每次决策
调用一次 attack_plan {groups:[{enemy,count,affixes?,spawner?,delay?}],note}；被拒会告诉你原因，改正后再调用。成功即结束回合。
示例：attack_plan {groups:[{enemy:"plane",count:6},{enemy:"crumb",count:8,delay:3}],note:"对空薄弱，压飞行"}`;

/** 玩家指令的优先级规则（固定文本，进固定前缀；指令内容本身只在 user 消息里） */
const PLAYER_TEXT: Partial<Record<AgentRole, string>> = {
  player: `# Player orders: "P<id>!" = do now, "P<id>" = standing. Obey over your plan unless illegal/fatal. end.note: "P<id> ok:…"/"P<id> 无法:why".`,
  advisor: `# Player questions: answer "P<id>!" in suggest as "P<id>: …"; "P<id>" = standing preference.`,
};

/**
 * 固定前缀的两个块：[规则 + 角色, 速查表]。纯函数、逐字节稳定（无种子 / 时间 / 随局内容），所有局共享缓存。
 * assist = false：旧版规则（无意图 / 打法要点），评测基线用。
 */
export function systemBlocks(role: AgentRole, assist = true): [string, string] {
  if (role === 'attacker') return [`${ATTACK_RULES}\n\n${ROLE_TEXT.attacker}`, cheatSheet()];
  const pt = assist ? PLAYER_TEXT[role] : undefined;
  return [`${assist && role === 'player' ? RULES : RULES_V1}\n\n${ROLE_TEXT[role]}${pt ? `\n\n${pt}` : ''}`, cheatSheet()];
}

/** 本局开局信息（放在每次决策 user 消息的开头，随局变化但同局内不变） */
export function runHeader(opts: RunOptions, w: IWorld): string {
  const st = w.state;
  const all = st.unlockedTowers.length >= Object.keys(TOWERS).length;
  return (
    `Game: mode ${opts.mode}, map ${opts.map}, difficulty ${opts.difficulty}${opts.abyssLevel ? ` ${opts.abyssLevel}` : ''}, seed ${st.seed}, ` +
    `skills ${st.skills.map((k) => k.id).join(',')}, autoWave ${st.autoWave.enabled ? 'on' : 'off'}, towers ${all ? 'all unlocked' : st.unlockedTowers.join(',')}.`
  );
}

const REASON_TEXT: Record<string, string> = {
  game_start: 'game start — plan the opening maze',
  build: 'build phase — spend gold for the next wave',
  wave_interval: 'periodic check',
  event_warn: 'random event announced or started (see ev / EG)',
  drop_warn: 'air-drop landing soon',
  boss_spawn: 'boss appeared',
  perk: 'perk offer — choose_perk now',
  crate: 'crate opened — choose_crate',
  leak: 'enemies leaked',
  player: 'the human sent an instruction (玩家指令 below)',
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
  /** 「玩家指令」段（instructions.ts instructionSection；只在 user 消息里，不进固定前缀） */
  instructions?: string;
}

export function decisionMessage(p: DecisionMessageParts): string;
export function decisionMessage(header: string, point: DecisionPoint, observation: string, extra?: string): string;
export function decisionMessage(a: string | DecisionMessageParts, point?: DecisionPoint, observation?: string, extra?: string): string {
  const p: DecisionMessageParts = typeof a === 'string' ? { header: a, point: point!, observation: observation!, extra } : a;
  const why = p.point.reasons.map((r) => REASON_TEXT[r] ?? r).join('; ');
  const lines = [
    ...(p.header ? [p.header] : []),
    `Decision #${p.point.seq} t=${p.point.time.toFixed(1)}s: ${why}.${p.skipped ? ` (${p.skipped} quiet checks skipped)` : ''}`,
  ];
  if (p.instructions) lines.push(p.instructions);
  if (p.extra) lines.push(p.extra);
  if (p.memo) lines.push(`MEMO ${p.memo}`);
  lines.push(p.delta ? 'STATE Δ' : 'STATE', p.observation, 'Act now: one act call with all actions + end.');
  return lines.join('\n');
}
