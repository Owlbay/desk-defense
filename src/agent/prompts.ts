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

/** 每种塔什么时候用（速查表塔行的尾巴；静态文本，改了就改了缓存前缀） */
const TOWER_USE: Record<string, string> = {
  wall: 'maze only',
  pencil: 'main dps, cheap, opener, any lane',
  stapler: 'AoE at U-turns/merges, swarms',
  glue: 'slow, early route, feeds stapler/compass',
  lamp: 'ramping beam, ignores armor, sees stealth r1.5',
  compass: 'ring 0.8-1.8, cell between two lanes',
  eraser: '-armor, ×3 vs shield, early route',
  ruler: 'pierce line, end of long straights',
  pen: 'DoT, halves healing',
  calculator: 'aura r2 +10% dmg, amid ≥3 strong towers',
  piggy: '+8g/wave, max 3, early when safe',
  swatter: 'air-only splash',
};

/** 台灯（持续光束 / 递增 / 光棱联动，docs/notes-lamp-for-agent.md）；静态文本 */
const LAMP_NOTE =
  'Lamp: +60%/s on one target up to 3x, resets on retarget: bosses/armor/long straights, weak vs swarms. ' +
  "Lamps <=2.5 apart link (group max 4, unlimited with an A laser); the lead beam gets the others' light (4 equal ~3.9x): " +
  'cluster 3-4 by the boss lane before boss waves.';

/** 怪物类随机事件的应对（ev 行；EG = 金色目标）；静态文本 */
const EVENT_NOTE =
  'Events (ev): goldbag gb fast, regens if unhit 2s: focus + eraser_strike/slow, kill = coins, leak steals gold | golden elite (EG) drops coins | ' +
  'tea_break heal / shield_supply: burst skills, pen, eraser | medic_squad wo: pen/aoe | ' +
  'frenzy (+30% speed, +50% gold) / bounty (2x gold): slow + buy DPS now | training 2x XP: keep towers firing.';

/**
 * 速查表（固定前缀的第二块，≈600 token）：塔一行一个（价格 / 定位 / 对空 / Lv1 数值 / 传奇分支名）、
 * 敌人一行一个（代号 / 属性 / 克制）、技能一行。完整资料用 get_catalog 按需取。
 */
export function cheatSheet(): string {
  const tw = Object.values(TOWERS).map((t) => {
    const hits = t.attacks ? `${t.hitsGround ? 'G' : ''}${t.hitsAir ? 'A' : ''}` : '-';
    const st = t.attacks ? ` ${t.damage}/${t.interval}s r${t.range}` : '';
    return `${TOWER_CHAR[t.id]} ${t.id} ${t.cost}g ${hits}${st}: ${TOWER_USE[t.id] ?? t.role}`;
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
    'Towers (map char, id, cost, hits G/A, Lv1 dmg/interval range: use):',
    ...tw,
    'Enemies (code id hp speed armor → purpose):',
    ...en,
    `Skills: ${sk}`,
    `Affixes: ${Object.keys(AFFIXES).join(' ')}`,
    `Purposes (enemy → purpose; {do:"build_near",purpose} picks): ${PURPOSES.map(purposeText).join(' ')}`,
    `Combos (orthogonally adjacent, auto; {do:"build_near",pair}): ${COMBOS.map((c) => `${c.a}+${c.b} ${c.desc}`).join(' | ')}`,
    'Wall next to attack towers: upgrade Lv2 (+15g) range+5%, Lv3 (+30g) +5% dmg. A tower on a wall cell keeps the maze.',
    'Branches: pencil A 2× speed | stapler B shreds armor | glue A roots/B burns | lamp A 5× ramp, melts bosses/B stealth+amp | ruler B executes | pen B +20% dmg taken | swatter B nets flyers. ★3 ability on bosses.',
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
t time s | ph phase | w wave/total | g gold | hp lives | sc score | aw auto-wave | T towers "#uid id x,y Llevel [A|B] [★n] [x xp%] [t=target] [up cost|br cost=needs branch] [ev evolve cost] (costs rounded up to 5) [ab R|cd]" | W walls "uid@x,y" | E enemy groups "code×n hp% far/mid/near [A air] [B boss] [e elite] [h hidden]" | Ef enemy nearest exit | EB bosses | EG coin targets | nx next wave "wN [tags] early+Ng" | AR attack routes "spawner: next-wave enemies | waypoints (last = exit) Llen | gap uncovered stretches" and "air:spawner: flyers | from>to Llen aa% covering towers" | Rs longest straight segments "spawner a>b Llen b=buildable cells beside" | Rp best tower spots "x,y:route cells within r2.5" | sk skills id:R|cd | ev events | sp drop boxes | pu pickups | perk offer | crate options | own perks | b build prices ("base" = cheat-sheet prices; else differences, locked, max) | rc since last decision | pe queued errors.
- MAP (sent when terrain changes): rows y, cols x (0..9,a,b). . empty | # obstacle | S spawn | X exit | d drop warning | D drop spawn | route letters a,b,c… (+ overlap, ~ future drop route) | towers: ${Object.entries(
  TOWER_CHAR,
)
  .map(([k, v]) => `${v}=${k}`)
  .join(' ')}. "(RLE)" rows: "3." = "...".`;

const TOWER_LEGEND = Object.entries(TOWER_CHAR)
  .map(([k, v]) => `${v}=${k}`)
  .join(' ');

/**
 * 玩家规则（assist 版，固定前缀 system[0]）。四段：规则与成长 → 打法手册（开局 / 各阶段 / 增益 / 分支）→ 每次决策 → 术语表。
 * 数字都来自配置（src/config/difficulty.ts、towers.ts、scaling.ts；docs/guide/数据），改配置时一起核对。
 */
const RULES = `You play 书桌防线 / Desk Defense (deterministic maze TD) via tools.

# Rules
- Board 12×14 (x 0..11, y 0..13). Ground enemies walk the shortest path to the exit; every tower (walls too) blocks, so towers ARE the maze; path-blocking placements are rejected. Flyers fly straight to the exit; only A towers hit them.
- Leak = lives (boss more); 0 = loss. Gold: kills, wave bonus 10+2w, 5% interest on unspent (cap 20; nightmare/魔境 15), piggies, early calls (nx early+Ng).
- Phases build / wave / perk (paused, 1 of 3 every 10 waves) / won / lost. Auto-wave starts later waves. Events are warned; air-drop boxes become spawns (demolish / seal_tape).
- Firing towers earn XP: free levels to Lv9 + up to 50% off gold upgrades. Lv9→10 = gold + branch A|B; Lv10 → evolve ★1..★3 (★3 = tower_ability). Sell refund 70% (Lv1)…25% (Lv10), 100% within 5 s.
- Endless wave n: enemy HP ×(1+.18n)·1.04^n (w20 ×9, w40 ×37, w60 ×118, w80 ×340), count +8%/wave, armor +1 per 12 waves, elites from w30; kill gold only ×(1+.04n) ⇒ late waves are won by levels, ★, calculators and compounding gold, not more Lv1 towers.
- Boss every 10th wave (2 from w50); air raid on multiples of 7; rush (fast ×2) on 5s; pincer (all spawns) w12/28/36/44/52. hard/nightmare/魔境: less gold, faster growth, more spawns/drops, elites from w20/15/12 ⇒ maze + anti-air sooner, piggies only if TH ≥3 everywhere.

# Playbook (intents pick the cells)
- w0 (150g): [{do:"spend",reserve:0}] = 4 pencils in the first serpentine barrier + walls. Don't hand-place walls.
- Default turn = [build_near purpose:"air" if nx [air] and TH air ≠ 安全, spend]. spend alone buys the rotation (pencils + eraser/lamp/glue, later calculator/compass/piggy), walls ≤50% of tower gold and upgrades, whichever is worth more per gold; put upgrade_best / build_near BEFORE it only for a reason (CTR 缺, LK/GAP hole, boss) — they refuse when the other is better. {do:"maze"} until MZ ≥2.5×.
- w1-10: pencils (cheapest dps; Lv7 shoots twice); eraser before paperclips (pc, w5+); glue+stapler at a U-turn before rushes; an A tower on each flight line by w6.
- w10-30: upgrades start to win (Lv4 crit, Lv7 ≈2× dps). 3 piggies by ≈w20 if safe (build_near tower:"piggy": +8g/wave, ~12-wave payback, not after w40). 2-3 calculators amid ≥3 strong towers (build_near tower:"calculator"). Before w30/40 bosses: 3-4 lamps 2 apart by the boss lane.
- Armor: +1 per 12 waves (pc ar 6, bosses ar 7+ at w40) and each hit loses that much, so pencil-only boards die at the w40 boss. Follow CTR (build_near purpose armor/boss/aoe): by w35 ≥6 lamps (ignore armor), rulers (20/hit, pierce), 2 erasers A.
- w30-60: elites ⇒ evolve the top-damage Lv10 first; new A towers only if TH air is 吃紧/危险.
- w60+ or full board (build_near: "covers only"): gold to upgrade_best/evolve; never sell firing towers; never save while TH 危险.
- Perks: legend (+uid of best Lv7+ pencil/lamp, branch A) > promotion > sale > compound > timemgmt > notes > sharpener > scholaraura (≥2 calculators) > safe. Crates: gold before w30, then xp; lives if hp ≤5.
- Branches (auto): pencil/lamp/eraser/calculator/piggy/swatter A; stapler/glue/compass/ruler/pen B.
- Place for the NEXT wave: AR names each route's enemies and uncovered stretches → build_near target "route:sp" / "seg:x1,y1-x2,y2" there. LK/GAP holes likewise; KH LATE ⇒ add damage earlier; RC → reclaim; routes changed → maze rebuild:true; skills on bosses / Ef d≤3.

# Each decision
STATE is below (observe only if unclear). ONE act call with ALL actions + end:{plan,maze,priorities,note} (= your memory ≤300 tokens, shown as MEMO; omitted fields keep old values). Prefer intents (validated cells, reported costs/path).
Example (build, g140, nx [air], CTR 缺 armor): act {actions:[{do:"build_near",purpose:"air"},{do:"build_near",purpose:"armor"},{do:"spend",reserve:0}],end:{plan:"maze+spend; lamps by w35"}}

# Glossary (STATE Δ = changed keys only: T+ new/changed towers, T- removed uids, _unset gone keys)
t time | ph phase | w wave | g gold | hp lives | sc score | aw auto-wave | T "#uid id x,y Llv [A|B] [★n] [x25|50|75 xp% to next] [t=target] [up|br|ev cost: upgrade / Lv9→10 needs branch / evolve] [abR|cd]" | W walls "uid@x,y" | E "code×n hp% far/mid/near [A air] [B boss] [eN elite] [hN hidden]" | Ef nearest exit (dN cells left) | EB bosses | EG coin targets | nx "wN [tags] early+Ng" | AR attack routes, one per route: "sp: next-wave groups code×n(eN) or - | turn cells a>b>… (last = exit) Llen | gap uncovered stretches a>b(cells)", "air:sp: flyers | from>exit Llen aa% covered #uids", "sp lands Ns:" = drop route soon, "*:" = any spawner | Rs straights "sp a>b Llen bN free cells beside" | Rp spots "x,y:route cells in r2.5" | sk skill:R|cd | ev events | sp drops | pu pickups | perk/crate offers | own perks | b prices (base = sheet) | rc since last "kN kills +Ng wN clear +bonus iInterest #uid→Llv" | pe queued errors.
Lines: BR last wave (leaks, kills, dmg/tower, 0dmg, idle gold) | TH next wave per route/air line: ratio = your dmg ÷ incoming HP, 安全 ≥2, 吃紧 ≥1.2, 危险 <1.2 → fix | CTR enemy→purpose, 缺 = no tower for it | LK leaks by AR route "| sp: code×n(hp% left, in% time in range, stretch gap0 uncovered|gap1 one tower, top#uid dmg%)", e. = elite, ^ = flyer | GAPn holes leaking ≥2× in n waves | KH kills f/m/l % by route third, hot 3×3 block %, LATE = >45% in the last third | RC reclaimable | CB combos / lone towers | MZ route vs plan | IDLE unspent gold | EVT event tips.
MAP (on terrain change): rows y, cols x 0..9,a,b; . empty # obstacle S spawn X exit d/D drop warn/spawn; routes a,b… (+ overlap, ~ future drop); ${TOWER_LEGEND}; RLE "3." = "...".`;

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
- 限制：只能用 pool 里的敌人（Boss 不能编排；Boss 波的 Boss 原样保留）；最多 ${ATTACK.maxGroups} 组、每组 ${ATTACK.maxCount} 只、${ATTACK.maxAffixes} 个词缀（不含 golden；飞行敌人不能带词缀）；生命当量（基础生命 × 数量，带词缀 = 精英 ×2.5）≤ hpCap（默认波 baseHp 的 ${ATTACK.hpCap} 倍）。delay = 本组开波后第几秒出发（0..${ATTACK.maxDelay}）。
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
