/**
 * 脚本策略（确定性、离线）：和模型用同一套工具（文档 10 §8.5）。
 *
 * 用途：测试（确定性 / 端到端）、无网络演示、浏览器里的默认兜底、Agent 评测的下限基线。
 * 策略很朴素：选增益 → 补给 → 小段迷宫（墙放在最能拉长路线的路格）→ 沿路线买塔（覆盖路格最多的位置）
 * → 升级最低级的塔 → 敌人逼近出口时放技能 → 手动模式开波 → end_turn。
 * 全部遍历顺序固定，无随机数：同一种子 ⇒ 同一结果。
 */
import { ENEMIES } from '../../config/enemies';
import type { IWorld, TowerId } from '../../core/types';
import { CellKind } from '../../core/types';
import { t } from '../../i18n';
import { comboState } from '../board';
import { HOLD_INTENTS, instructionIntents, type InstructionRef } from '../instructions';
import type { PlannerState } from '../planner';
import { enemyPurposes, type Purpose, PURPOSE_CORE } from '../purpose';
import { executeTool } from '../tools';
import { type DecisionReason, emptyUsage, type FallbackPolicy, type ToolResult } from '../types';
import type { DecisionContext, DecisionOutcome, LLMProvider } from './types';

type Call = (name: string, input: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

const PERK_PRIORITY = [
  'promotion',
  'sale',
  'notes',
  'sharpener',
  'safe',
  'compound',
  'pocketmoney',
  'quickreview',
  'bulb',
  'drafting',
  'timemgmt',
];
const ROTATION: TowerId[] = [
  'pencil',
  'pencil',
  'glue',
  'stapler',
  'pencil',
  'lamp',
  'compass',
  'pencil',
  'ruler',
  'swatter',
  'stapler',
  'pen',
];

function pathCells(w: IWorld): { x: number; y: number }[] {
  const seen = new Set<number>();
  const out: { x: number; y: number }[] = [];
  for (const p of w.currentPaths())
    for (const c of p) {
      const k = c.y * 100 + c.x;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(c);
      }
    }
  return out;
}

/** 覆盖路格最多的可建空格（不在路上，不改路线） */
function bestCell(w: IWorld, tower: TowerId): { x: number; y: number } | null {
  const g = w.state.grid;
  const path = pathCells(w);
  const onPath = new Set(path.map((c) => c.y * 100 + c.x));
  const r = Math.max(1.2, w.baseRange(tower).range);
  let best: { x: number; y: number; score: number } | null = null;
  for (let y = 0; y < g.rows; y++) {
    for (let x = 0; x < g.cols; x++) {
      if (g.cells[y * g.cols + x] !== CellKind.Empty || onPath.has(y * 100 + x)) continue;
      let cov = 0;
      for (const c of path) if (Math.hypot(c.x - x, c.y - y) <= r) cov++;
      // 越靠近出口越好一点（漏怪前最后一道防线）
      const score = cov + y * 0.05;
      if (cov > 0 && (!best || score > best.score) && w.canPlace(tower, x, y).ok) best = { x, y, score };
    }
  }
  return best;
}

/** 让路线变长最多的墙（只看当前路格） */
function bestWall(w: IWorld): { x: number; y: number; gain: number } | null {
  const cur = w.currentPaths().reduce((a, p) => a + p.length, 0);
  let best: { x: number; y: number; gain: number } | null = null;
  for (const c of pathCells(w)) {
    if (c.y < 1 || c.y > w.state.grid.rows - 2) continue;
    if (!w.canPlace('wall', c.x, c.y).ok) continue;
    const pv = w.previewPath('wall', c.x, c.y);
    if (!pv) continue;
    const gain = pv.reduce((a, p) => a + p.length, 0) - cur;
    if (gain >= 2 && (!best || gain > best.gain)) best = { x: c.x, y: c.y, gain };
  }
  return best;
}

/**
 * 一次决策（异步：经 call 执行每个动作，与模型完全同一路径）。
 * think：规则策略的"思路"（每条规则判断写一行，思路与请求面板里当作思考过程展示；不影响决策）。
 */
export async function scriptedTurn(w: IWorld, call: Call, reasons: DecisionReason[], think?: (line: string) => void): Promise<string> {
  const s = w.state;
  const done: string[] = [];
  const say = (line: string): void => think?.(`${line}\n`);
  say(
    t('agent.demo.reason', {
      reasons: reasons.join(', ') || '—',
      phase: s.phase,
      wave: s.wave,
      gold: Math.floor(s.gold),
      lives: s.lives,
      max: s.maxLives,
    }),
  );
  // 增益
  if (s.phase === 'perk' && s.perkChoices) {
    const cards = s.perkChoices.slice().sort((a, b) => rank(a.id) - rank(b.id));
    say(t('agent.demo.perk', { list: cards.map((c) => c.id).join(' > ') }));
    for (const c of cards) {
      const input: Record<string, unknown> = { id: c.id };
      if (c.needsTower) {
        const t = [...s.towers.values()].find((x) => x.id !== 'wall' && x.level >= 7 && x.level < 10);
        if (!t) continue;
        input.uid = t.uid;
        input.branch = 'A';
      }
      if ((await call('choose_perk', input)).ok) {
        done.push(`perk ${c.id}`);
        break;
      }
    }
  }
  if (s.crateChoice) {
    const pref = ['gold', 'xp', 'lives', 'caffeine', 'cooldown', 'charge'];
    const opt = s.crateChoice.options.slice().sort((a, b) => pref.indexOf(a.id) - pref.indexOf(b.id))[0];
    if (opt) say(t('agent.demo.crate', { pref: pref.join(' > '), pick: opt.id }));
    if (opt && (await call('choose_crate', { option: opt.id })).ok) done.push(`crate ${opt.id}`);
  }
  // 拆空降点（钱多时）
  for (const sp of s.spawners) {
    if (sp.kind === 'drop' && sp.active && sp.demolishCost && s.gold >= sp.demolishCost * 3) {
      say(t('agent.demo.demolish', { id: sp.id, cost: sp.demolishCost }));
      if ((await call('demolish_spawner', { id: sp.id })).ok) done.push(`demolish ${sp.id}`);
    }
  }
  // 花钱
  const towers = () => [...s.towers.values()];
  for (let guard = 0; guard < 10; guard++) {
    const atk = towers().filter((t) => t.id !== 'wall');
    const walls = towers().length - atk.length;
    const target = Math.min(4 + Math.floor(s.wave * 1.2), 30);
    if (guard === 0) say(t('agent.demo.force', { atk: atk.length, target, walls, wallTarget: 4 + s.wave * 2 }));
    if (walls < 4 + s.wave * 2 && s.gold >= 25 && atk.length >= 2) {
      const wl = bestWall(w);
      if (wl) say(t('agent.demo.wall', { x: wl.x, y: wl.y, gain: wl.gain }));
      if (wl && (await call('place_tower', { tower: 'wall', x: wl.x, y: wl.y })).ok) {
        done.push(`wall ${wl.x},${wl.y}`);
        continue;
      }
    }
    if (atk.length < target) {
      const opts = w.getBuildOptions();
      let placed = false;
      for (let k = 0; k < ROTATION.length && !placed; k++) {
        const id = ROTATION[(atk.length + k) % ROTATION.length];
        const b = opts.find((o) => o.id === id);
        if (!b || !b.unlocked || !b.affordable || b.limitReached) continue;
        const cell = bestCell(w, id);
        if (cell) say(t('agent.demo.build', { tower: t(`data.tower.${id}.name`), x: cell.x, y: cell.y }));
        if (cell && (await call('place_tower', { tower: id, x: cell.x, y: cell.y })).ok) {
          done.push(`${id} ${cell.x},${cell.y}`);
          placed = true;
        }
      }
      if (placed) continue;
    }
    // 升级最低级、买得起的塔
    const cand = atk
      .map((t) => ({ t, info: w.getTowerInfo(t.uid) }))
      .filter((x) => x.info && x.info.upgradeCost !== null && x.info.upgradeCost <= s.gold)
      .sort((a, b) => a.t.level - b.t.level || a.t.uid - b.t.uid)[0];
    if (cand && (atk.length >= target || s.gold > 120)) {
      say(
        t('agent.demo.upgrade', {
          gold: Math.floor(s.gold),
          uid: cand.t.uid,
          level: cand.t.level,
          cost: cand.info!.upgradeCost ?? 0,
        }),
      );
      const r = cand.info!.needsBranch
        ? await call('choose_branch', { uid: cand.t.uid, branch: 'A' })
        : await call('upgrade_tower', { uid: cand.t.uid });
      if (r.ok) {
        done.push(`up #${cand.t.uid}`);
        continue;
      }
    }
    break;
  }
  // 技能
  if (s.phase === 'wave' && s.enemies.length) {
    let near = 0;
    let front: { x: number; y: number; d: number } | null = null;
    for (const e of s.enemies) {
      const d = s.grid.dist[Math.floor(e.y) * s.grid.cols + Math.floor(e.x)];
      const dd = Number.isFinite(d) ? d : 99;
      if (dd <= 4) near++;
      if (!front || dd < front.d) front = { x: Math.floor(e.x), y: Math.floor(e.y), d: dd };
    }
    const ready = (id: string) => s.skills.some((k) => k.id === id && k.ready);
    say(t(s.bossUids.length ? 'agent.demo.skillBoss' : 'agent.demo.skill', { near }));
    if (front && (near >= 3 || s.bossUids.length) && ready('eraser_strike')) {
      if ((await call('cast_skill', { skill: 'eraser_strike', x: front.x, y: front.y })).ok) done.push('eraser');
    }
    if (near >= 6 && ready('bell') && (await call('cast_skill', { skill: 'bell' })).ok) done.push('bell');
  }
  const manual = s.phase === 'build' && !(s.autoWave.enabled && s.autoWave.started);
  if (manual) say(t('agent.demo.startWave'));
  if (manual && (await call('start_wave', {})).ok) done.push('start');
  if (!done.length) say(t('agent.demo.idle'));
  const note = done.length ? done.join('; ').slice(0, 200) : 'hold';
  await call('end_turn', { note });
  return note;
}

/**
 * 意图版脚本策略（确定性）：像模型那样每个决策点只发一次 act，用高层意图（anti_air / spend / 技能），
 * 选位与迷宫全部交给规划器。用于离线评测规划器本身（scripts/agent-eval.ts 的 scripted-intents 变体）。
 */
export async function scriptedIntentTurn(
  w: IWorld,
  call: Call,
  reasons: DecisionReason[],
  think?: (line: string) => void,
  tactics = false,
  /** 建造阶段照抄消息里的 NEXT 清单（评测 scripted-next：检验 NEXT 本身好不好） */
  next?: Record<string, unknown>[],
): Promise<string> {
  const s = w.state;
  const say = (line: string): void => think?.(`${line}\n`);
  const actions: Record<string, unknown>[] = [];
  if (s.phase === 'perk' && s.perkChoices) {
    const c =
      s.perkChoices
        .slice()
        .sort((a, b) => rank(a.id) - rank(b.id))
        .find((x) => !x.needsTower) ?? s.perkChoices[0];
    actions.push({ do: 'choose_perk', id: c.id });
  }
  if (s.crateChoice) {
    const pref = ['gold', 'xp', 'lives', 'caffeine', 'cooldown', 'charge'];
    const opt = s.crateChoice.options.slice().sort((a, b) => pref.indexOf(a.id) - pref.indexOf(b.id))[0];
    if (opt) actions.push({ do: 'choose_crate', option: opt.id });
  }
  if (s.pickups.length) actions.push({ do: 'collect' });
  if (next) actions.push(...next);
  else if (s.nextWave.tags.includes('air')) actions.push({ do: 'anti_air' });
  if (next) {
    /* NEXT 已经包含 spend */
  } else if (tactics && s.phase === 'build') {
    // §19.8 的新意图：回收无用墙 / 零伤害塔、按克制用途补塔、给落单塔配组合技、早期存钱罐
    const atk = [...s.towers.values()].filter((t) => t.id !== 'wall');
    if (s.wave >= 3) actions.push({ do: 'reclaim', target: 'useless_walls', max: 3, replaceWith: 'dps' });
    if (s.wave >= 4) actions.push({ do: 'reclaim', target: 'idle_towers', max: 2, replaceWith: 'dps' });
    for (const p of counterNeeds(w)) actions.push({ do: 'build_near', purpose: p });
    // 组合技只给已有的落单塔配搭档（新建一对 60g 的铅笔 + 橡皮擦不如 spend 的选择）
    const lone = comboState(w).lonely.find(
      (l) => ['glue', 'stapler', 'lamp', 'pen', 'ruler', 'compass'].includes(l.id) && l.partner !== 'piggy',
    );
    if (s.wave >= 5 && atk.length >= 6 && lone) actions.push({ do: 'combo', pair: `${lone.id}+${lone.partner}` });
    if (s.wave >= 2 && s.wave <= 8 && s.lives === s.maxLives) actions.push({ do: 'economy' });
  }
  if (!next) actions.push({ do: 'spend', reserve: 0 });
  if (s.phase === 'wave' && s.enemies.length) {
    let near = 0;
    let front: { x: number; y: number; d: number } | null = null;
    for (const e of s.enemies) {
      const d = s.grid.dist[Math.floor(e.y) * s.grid.cols + Math.floor(e.x)];
      const dd = Number.isFinite(d) ? d : 99;
      if (dd <= 4) near++;
      if (!front || dd < front.d) front = { x: Math.floor(e.x), y: Math.floor(e.y), d: dd };
    }
    const ready = (id: string) => s.skills.some((k) => k.id === id && k.ready);
    if (front && (near >= 3 || s.bossUids.length) && ready('eraser_strike'))
      actions.push({ do: 'cast_skill', skill: 'eraser_strike', x: front.x, y: front.y });
    if (near >= 6 && ready('bell')) actions.push({ do: 'cast_skill', skill: 'bell' });
  }
  if (s.phase === 'build' && !(s.autoWave.enabled && s.autoWave.started)) actions.push({ do: 'start_wave' });
  say(
    t('agent.demo.intent', {
      reasons: reasons.join(', ') || '—',
      gold: Math.floor(s.gold),
      actions: actions.map((a) => a.do).join(', '),
    }),
  );
  const r = await call('act', { actions, end: { plan: 'serpentine maze + spend', note: `w${s.wave}` } });
  return r.text.split('\n').slice(0, -1).join('; ').slice(0, 200) || 'hold';
}

/** 意图版 + §19.8 新意图（评测 scripted-tactics） */
export function scriptedTacticsTurn(w: IWorld, call: Call, reasons: DecisionReason[], think?: (line: string) => void): Promise<string> {
  return scriptedIntentTurn(w, call, reasons, think, true);
}

/** CTR 行里"缺"的用途（下一波敌人需要、还没有主力塔），最多 2 个 */
function counterNeeds(w: IWorld): Purpose[] {
  const have = new Set([...w.state.towers.values()].map((t) => t.id));
  const need = new Set<Purpose>();
  for (const g of w.state.nextWave.groups) for (const p of enemyPurposes(ENEMIES[g.enemy])) need.add(p);
  return [...need].filter((p) => p !== 'dps' && p !== 'air' && !PURPOSE_CORE[p].some((id) => have.has(id))).slice(0, 2);
}

const rank = (id: string): number => {
  const i = PERK_PRIORITY.indexOf(id);
  return i < 0 ? 99 : i;
};

/**
 * 玩家指令（离线演示）：关键词 → 意图（instructions.ts instructionIntents），合成一次 act 执行，
 * 回应写成 "P3 ok: …" / "P3 无法: …"（引擎从回复里按编号找回应）。
 * 一次性指令全部执行；长期方针只执行持续性的（防空 / 存钱 / 范围 / 别动某边……，不含开波 / 拆墙 / 集火）。
 */
export async function scriptedInstructionTurn(
  w: IWorld,
  call: Call,
  once: readonly InstructionRef[],
  standing: readonly InstructionRef[],
  think?: (line: string) => void,
): Promise<{ hold: boolean; ack: string }> {
  const s = w.state;
  const say = (line: string): void => think?.(`${line}\n`);
  const bossCells = s.bossUids
    .map((u) => s.enemies.find((e) => e.uid === u))
    .filter((e): e is NonNullable<typeof e> => !!e)
    .map((e) => ({ x: Math.floor(e.x), y: Math.floor(e.y) }));
  const skill = s.skills.find((k) => k.ready && k.target === 'circle')?.id;
  const actions: Record<string, unknown>[] = [];
  /** 每条一次性指令对应的动作下标 */
  const owned = new Map<number, number[]>();
  const keys = new Map<number, string[]>();
  let hold = false;
  const ONCE_ONLY = ['start_wave', 'reclaim', 'boss', 'maze', 'upgrade'];
  for (const x of [...once, ...standing]) {
    const intents = instructionIntents(x.text, { bossCells, skill });
    keys.set(
      x.id,
      intents.map((i) => i.key),
    );
    const idx: number[] = [];
    for (const it of intents) {
      if (x.kind === 'standing' && ONCE_ONLY.includes(it.key)) continue;
      if (HOLD_INTENTS.includes(it.key)) hold = true;
      for (const a of it.actions) {
        const k = JSON.stringify(a);
        let j = actions.findIndex((b) => JSON.stringify(b) === k);
        if (j < 0) {
          j = actions.length;
          actions.push(a);
        }
        idx.push(j);
      }
    }
    if (x.kind === 'once') owned.set(x.id, idx);
    say(
      t('agent.demo.instruction', {
        id: x.id,
        mark: x.kind === 'once' ? '!' : '',
        text: x.text,
        intents: intents.length ? intents.map((i) => i.key).join(', ') : t('agent.demo.unknown'),
      }),
    );
  }
  let lines: string[] = [];
  if (actions.length) {
    const r = await call('act', { actions });
    lines = r.text.split('\n');
  }
  const acks: string[] = [];
  for (const x of once) {
    const k = keys.get(x.id) ?? [];
    const idx = owned.get(x.id) ?? [];
    if (!k.length) {
      acks.push(`P${x.id} ${t('agent.dock.demoAck.cannot')}: ${t('agent.dock.demoAck.unknown')}`);
      continue;
    }
    if (!idx.length) {
      // 限制类（存钱 / 别动）或没有 Boss 可集火
      // 回应给玩家看：按界面语言（"ok" 不翻译，findAck / 面板据此判断成败）
      const cannot = t('agent.dock.demoAck.cannot');
      const why =
        k.includes('boss') && !bossCells.length
          ? `${cannot}: ${t('agent.dock.demoAck.noBoss')}`
          : k.includes('boss') && !skill
            ? `${cannot}: ${t('agent.dock.demoAck.noAoe')}`
            : `ok: ${t('agent.dock.demoAck.hold')}`;
      acks.push(`P${x.id} ${why}`);
      continue;
    }
    const res = idx.map((j) => lines.find((l) => l.startsWith(`${j + 1} `)) ?? '');
    const good = res.filter((l) => /^\d+ OK/.test(l));
    const first = (good[0] ?? res[0] ?? '').replace(/^\d+ \w+\s*/, '').slice(0, 80);
    acks.push(`P${x.id} ${good.length ? 'ok' : t('agent.dock.demoAck.cannot')}: ${k.join('+')}${first ? ` — ${first}` : ''}`);
  }
  return { hold, ack: acks.join(' | ') };
}

/** 从决策消息里取 NEXT 行的动作清单（没有 / 解析失败 = undefined） */
export function parseNext(message: string): Record<string, unknown>[] | undefined {
  const m = /^NEXT (\[.*?\]) ←/m.exec(message);
  if (!m) return undefined;
  try {
    const a = JSON.parse(m[1]) as unknown;
    return Array.isArray(a) ? (a as Record<string, unknown>[]) : undefined;
  } catch {
    return undefined;
  }
}

/** 作为 LLMProvider：所有动作经 ctx.callTool（记录、realtime 时间推进与模型完全一致） */
export class ScriptedProvider implements LLMProvider {
  readonly id = 'scripted';
  readonly model: string;
  /** intents = 意图版（一次 act + 规划器），否则旧版逐个细粒度工具 */
  constructor(private readonly o: { intents?: boolean; tactics?: boolean; next?: boolean } = {}) {
    this.model = o.next ? 'scripted-next' : o.tactics ? 'scripted-tactics' : o.intents ? 'scripted-intents' : 'scripted-v1';
  }

  async decide(ctx: DecisionContext): Promise<DecisionOutcome> {
    const out: DecisionOutcome = { usage: emptyUsage(), costUsd: 0, toolCalls: 0, ended: false };
    if (!ctx.world) return { ...out, error: 'scripted provider needs in-process world access' };
    const tr = ctx.trace;
    const t0 = Date.now();
    // 合成的"请求"：离线演示没有网络请求，但面板照样能看到发给"模型"的局面与工具
    tr?.({
      k: 'request',
      n: 1,
      provider: this.id,
      api: 'local',
      model: this.model,
      host: t('agent.setup.demo.host'),
      params: { note: t('agent.demo.scriptNote') },
      messages: 1,
      raw: {
        provider: 'scripted',
        model: this.model,
        note: t('agent.setup.demo.noNetwork'),
        messages: [{ role: 'user', content: t('agent.demo.seeObs') }],
      },
    });
    let seq = 0;
    const call: Call = async (name, input) => {
      out.toolCalls++;
      const r = await ctx.callTool(name, input, { id: `scripted_${++seq}` });
      if (r.endTurn) {
        out.ended = true;
        out.note = r.note;
      }
      return r;
    };
    const think = tr ? (line: string) => tr({ k: 'thinking', n: 1, text: line }) : undefined;
    // 玩家指令：按关键词先执行对应的意图；限制类（存钱 / 别动某边）这回合不再按规则花钱
    const ins = ctx.instructions;
    let hold = false;
    let ack = '';
    if (ins && (ins.once.length || ins.standing.length)) {
      const r = await scriptedInstructionTurn(ctx.world, call, ins.once, ins.standing, think);
      hold = r.hold;
      ack = r.ack;
    }
    // 选了非均衡的中心策略：旧版逐个工具不经规划器，改走意图版（规划器按策略买塔 / 分支 / 迷宫）
    const intents = this.o.intents || (!!ctx.doctrine && ctx.doctrine !== 'balanced');
    const turn = this.o.tactics ? scriptedTacticsTurn : intents ? scriptedIntentTurn : scriptedTurn;
    const next = this.o.next ? parseNext(ctx.message) : undefined;
    const note = hold
      ? `hold (${t('agent.demo.holdTag')})`
      : next
        ? await scriptedIntentTurn(ctx.world, call, ctx.point.reasons, think, false, next)
        : await turn(ctx.world, call, ctx.point.reasons, think);
    if (hold) think?.(`${t('agent.demo.holdThink')}\n`);
    if (ack) out.text = ack;
    tr?.({ k: 'text', n: 1, text: `${ack ? `${ack}\n` : ''}${t('agent.demo.turn', { note })}` });
    tr?.({
      k: 'response',
      n: 1,
      stop: 'end_turn',
      usage: emptyUsage(),
      ms: Date.now() - t0,
      costUsd: 0,
      raw: { stop_reason: 'end_turn', note, tool_calls: out.toolCalls },
    });
    return out;
  }
}

/** 作为兜底策略（同步执行器，直接下指令；浏览器里无脚本机器人时的默认兜底） */
export function scriptedFallback(w: IWorld): FallbackPolicy {
  // 引擎绑定了规划器状态且选了中心策略（非 balanced）：走意图版（规划器按策略买塔 / 分支 / 迷宫）；否则保持旧版
  let planner: PlannerState | undefined;
  return {
    name: 'scripted',
    bindPlanner(s) {
      planner = s;
    },
    decide: async (reasons) => {
      const d = planner?.doctrine;
      const intents = !!d?.chosen && d.doc.preset !== 'balanced';
      const call: Call = async (name, input) => executeTool({ world: w, role: 'player', planner }, name, input);
      await (intents ? scriptedIntentTurn(w, call, reasons) : scriptedTurn(w, call, reasons));
    },
  };
}
