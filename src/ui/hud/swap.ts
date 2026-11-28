import { PIGGY_MAX } from '../../config/towers';
import type { BuildOption, Command, CommandResult, IWorld, TowerId, TowerInfo } from '../../core/types';

/**
 * 原地换塔：只是「出售 + 在同一格放置」两条普通指令的组合（回放与服务端校验照常成立）。
 * 这里只做界面层的预检：出售之前先确认放置一定能成功，避免卖掉了却放不回去。
 * 纯函数，不碰 DOM，便于单元测试。
 */
export interface SwapPlan {
  ok: boolean;
  /** 不可换时的原因码：core.reason.<code>，或 'same'（同一种塔） */
  code?: string;
  /** 原因文本需要的参数（如存钱罐上限） */
  params?: Record<string, number>;
  uid: number;
  from: TowerId | null;
  to: TowerId;
  cx: number;
  cy: number;
  /** 出售退还 */
  refund: number;
  /** 新塔造价 */
  cost: number;
  /** 净花费 = 造价 − 退还（负数表示换完还能剩钱） */
  net: number;
  /** 依次执行的指令（可换时为 sell + place） */
  commands: Command[];
}

/** 塔栏里存钱罐的上限标记由 core 给出；这里换成别的塔时会先卖掉原塔，所以原塔是存钱罐时不受上限限制 */
function limitBlocks(opt: BuildOption | undefined, from: TowerId): boolean {
  return !!opt?.limitReached && from !== opt.id;
}

export function planSwap(
  world: IWorld,
  uid: number,
  to: TowerId,
  opts: BuildOption[] = world.getBuildOptions(),
  info: TowerInfo | null = world.getTowerInfo(uid),
): SwapPlan {
  const st = world.state;
  const tw = st.towers.get(uid);
  const opt = opts.find((o) => o.id === to);
  const cost = opt?.cost ?? 0;
  const refund = info?.sellValue ?? 0;
  const plan: SwapPlan = {
    ok: false,
    uid,
    from: tw?.id ?? null,
    to,
    cx: tw?.cx ?? -1,
    cy: tw?.cy ?? -1,
    refund,
    cost,
    net: cost - refund,
    commands: [],
  };
  const no = (code: string, params?: Record<string, number>): SwapPlan => {
    plan.code = code;
    if (params) plan.params = params;
    return plan;
  };
  if (st.phase === 'won' || st.phase === 'lost') return no('gameOver');
  if (!tw || !info) return no('noTower');
  if (st.phase === 'perk') return no('perkPending');
  if (!opt) return no('unknownTower');
  if (tw.id === to) return no('same');
  if (!opt.unlocked) return no('locked');
  if (limitBlocks(opt, tw.id)) return no('piggyLimit', { n: PIGGY_MAX });
  // 出售的退款是整数并且会和金币零头合并，因此「现有 + 退款 ≥ 造价」足以保证放得起
  if (st.gold + refund < cost) return no('noGold');
  // 同一格：塔换成塔，格子始终是障碍物，路线与堵路校验都不变；只剩「格子上压着地面敌人」需要单独看
  if (enemyOnCell(world, tw.cx, tw.cy)) return no('enemyHere');
  plan.ok = true;
  plan.commands = [
    { type: 'sell', uid },
    { type: 'place', tower: to, cx: tw.cx, cy: tw.cy },
  ];
  return plan;
}

/** 与 core 的放置校验同口径：地面敌人当前所在格或下一步目标格是这一格 */
function enemyOnCell(world: IWorld, cx: number, cy: number): boolean {
  for (const e0 of world.state.enemies) {
    // ccx / tcx 是 core 内部字段（运行时在对象上），缺失时按坐标所在格判断
    const e = e0 as typeof e0 & { dead?: boolean; ccx?: number; ccy?: number; tcx?: number; tcy?: number };
    if (e.dead || e.flying) continue;
    const ccx = e.ccx ?? Math.floor(e.x);
    const ccy = e.ccy ?? Math.floor(e.y);
    if ((ccx === cx && ccy === cy) || (e.tcx === cx && e.tcy === cy)) return true;
  }
  return false;
}

/** 选中塔时可以换成的塔（除自身外的全部塔种，含未解锁 / 买不起的，由界面置灰） */
export function swapTargets(world: IWorld, uid: number, opts: BuildOption[] = world.getBuildOptions()): SwapPlan[] {
  const tw = world.state.towers.get(uid);
  if (!tw) return [];
  const info = world.getTowerInfo(uid);
  return opts.filter((o) => o.id !== tw.id).map((o) => planSwap(world, uid, o.id, opts, info));
}

export interface SwapResult {
  ok: boolean;
  /** 新放下的塔 uid（成功时） */
  uid?: number;
  /** 失败的指令结果 */
  fail?: CommandResult;
  /** 已经卖掉但没放成（预检之外的意外，正常不会发生） */
  sold?: boolean;
}

/**
 * 执行换塔：先预检，再依次发出 sell / place。run 是发送指令的函数（游戏里是 ctx.cmd，测试里是 world.command）。
 * 预检不通过时不发任何指令。
 */
export function executeSwap(world: IWorld, run: (c: Command) => CommandResult, uid: number, to: TowerId): SwapResult {
  const plan = planSwap(world, uid, to);
  if (!plan.ok) return { ok: false };
  const sold = run(plan.commands[0]);
  if (!sold.ok) return { ok: false, fail: sold };
  const placed = run(plan.commands[1]);
  if (!placed.ok) return { ok: false, fail: placed, sold: true };
  const g = world.state.grid;
  const newUid = g.towerAt[plan.cy * g.cols + plan.cx];
  return { ok: true, uid: newUid || undefined };
}
