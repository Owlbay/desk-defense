/**
 * 提示词（文档 10 §7）。
 *
 * 缓存布局（前缀匹配）：tools（固定顺序）→ system[0] 规则（按角色固定）→ system[1] 资料表（全局固定，带 cache_control）
 * → messages（每次决策：本局开局信息 + 观测）。
 * 规则与资料表不含任何随局变化的内容（种子、时间、金币……），所以同一模型、同一角色的所有局共享一份缓存。
 */
import type { IWorld, RunOptions } from '../core/types';
import { TOWERS, TIER_NAMES } from '../config/towers';
import { ENEMIES, AFFIXES } from '../config/enemies';
import { SKILLS } from '../config/skills';
import { PERKS } from '../config/perks';
import { ABILITIES, EVOLUTION } from '../config/evolution';
import { RANDOM_EVENTS, CRATE_OPTIONS } from '../config/events';
import { MAP_LEGEND } from './observation';
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

const RULES = `You are playing 书桌防线 / Desk Defense, a deterministic maze tower-defense game, through tools.

# Rules (short)
- Board: 12 columns (x 0..11) × 14 rows (y 0..13). Enemies enter at spawns (S, usually top edge) and walk to the exit (X, bottom). Ground enemies follow the shortest path; every tower is also a wall, so towers shape the maze. You may never fully block a path (placement is rejected). Flying enemies ignore the maze and fly straight to the exit — only towers that hit air (A) can shoot them.
- Each enemy that reaches the exit costs lives (bosses cost more). 0 lives = game over.
- Gold: kills, wave-clear bonus, interest on unspent gold (capped), piggy banks. Calling a wave early gives bonus gold.
- Phases: build (between waves), wave (enemies spawning/walking), perk (paused: pick 1 of 3 perk cards; every 10 waves), won/lost. With auto-wave enabled, waves start automatically after the first one; otherwise you must call start_wave.
- Dynamic battlefield: random events (warned in advance; some disable towers or block cells), air-drop spawners (boxes that become new spawns; can be demolished or sealed with seal_tape), coins and supply crates to collect.
- Towers level up from XP; gold upgrades are cheaper with XP. Lv9→10 needs a branch (choose_branch). Lv10 → evolve ★1..★3; ★3 unlocks tower_ability.
- Selling refunds only part of the investment (full refund within 5 s of placing).

# Strategy hints
- Long mazes win: use cheap walls and towers to make the ground path long, and cluster damage towers where the path passes many times. Check preview_placement before building walls.
- Always keep some anti-air (pencil, swatter, lamp…) covering the exit approach before air waves (next.tags contains "air").
- Spend gold; idle gold beyond the interest cap is wasted. Upgrading a few strong towers is usually better than many Lv1 towers in mid/late game.
- Use skills when they matter: many enemies close to the exit (band[2]), bosses, stealth (whiteout/magnifier reveal).

# How decisions work
- You are called at decision points (start, build phase, every few seconds of a wave, event warnings, boss spawn, perk offer, crate). The user message contains the current state as compact JSON + ASCII map, and the reasons for this decision.
- Act with tool calls (you may call several in one response), then ALWAYS finish with end_turn (optionally with a short note — your memory for the next decision). Keep reasoning brief; the game is paused while you think in pause mode, but in real-time mode the game keeps running.
- Every action is validated by the game; a REJECTED result tells you why — adapt instead of repeating it.
- Do not call get_catalog unless needed; the reference data below is the same.

# Observation format
- JSON keys: t time(s), phase, wave/totalWaves (0 = endless), gold, lives, score, autoWave, path (ground path lengths per spawn), towers ("#uid id@x,y Llevel [brA] [★n] [xp%] [tgt=mode] [up=cost] [evo=cost] [ability=id:READY/cdN/target]"), enemies (alive, groups {type,n,hp fraction,band:[far,mid,near exit]}, front = enemy closest to exit, bosses), next (next wave preview), skills ("id:READY|cdN target=..."), events, spawners, pickups ("#uid coin 5g ttl"), perks (offer), crate (options), owned perks, build (tower=cost, ✗ = cannot afford), recent (summary since last decision), note (your last note).
- ${MAP_LEGEND}`;

const ROLE_TEXT: Record<AgentRole, string> = {
  player: `# Your role: AI player (defender)
You control the defense. Maximize waves survived and score. Be decisive and economical with tool calls.`,
  advisor: `# Your role: AI advisor (军师)
A human is playing. You can only read state and give advice with the suggest tool (Chinese, concise, concrete coordinates/uids). You cannot act. Give at most one suggestion per decision, then end_turn.`,
  attacker: `# Your role: AI attacker (design stub)
You will spend an attack budget on enemy waves. The attacker protocol is not implemented yet; read the state, then end_turn.`,
};

/** 系统提示的两个块（规则 + 资料表）。纯函数，逐字节稳定（用于缓存）。 */
export function systemBlocks(role: AgentRole): [string, string] {
  return [`${RULES}\n\n${ROLE_TEXT[role]}`, `# Reference data (static)\n${catalogText('all')}`];
}

/** 本局开局信息（放在每次决策 user 消息的开头，随局变化但同局内不变） */
export function runHeader(opts: RunOptions, w: IWorld): string {
  const st = w.state;
  return `Game: mode ${opts.mode}, map ${opts.map}, difficulty ${opts.difficulty}${opts.abyssLevel ? ` ${opts.abyssLevel}` : ''}, seed ${st.seed}, ` +
    `skills ${st.skills.map((k) => k.id).join(',')}, autoWave ${st.autoWave.enabled ? 'on' : 'off'}, unlocked towers ${st.unlockedTowers.join(',')}.`;
}

const REASON_TEXT: Record<string, string> = {
  game_start: 'game start — plan your opening maze and first towers',
  build: 'build phase — spend gold, prepare for the next wave',
  wave_interval: 'periodic check during the wave',
  event_warn: 'a random event was announced',
  drop_warn: 'an air-drop spawner is about to land',
  boss_spawn: 'a boss appeared',
  perk: 'perk offer — you must choose_perk (or reroll_perks) now',
  crate: 'supply crate opened — choose_crate',
  leak: 'enemies leaked since last decision',
};

export function decisionMessage(header: string, point: DecisionPoint, observation: string, extra?: string): string {
  const why = point.reasons.map((r) => REASON_TEXT[r] ?? r).join('; ');
  return `${header}\nDecision #${point.seq} at t=${point.time.toFixed(1)}s (tick ${point.tick}). Reasons: ${why}.${extra ? `\n${extra}` : ''}\nSTATE\n${observation}\nAct with tools, then call end_turn.`;
}
