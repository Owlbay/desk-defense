/**
 * 第一章「摆迷宫」小教学的步骤推进（纯逻辑，无 DOM）：
 *   放下第一座铅笔后 → ① 横墙一排、缺口留在一端 → ② 第二排、缺口在另一端（蛇形）→ ③ 走廊之间的塔打两次。
 * 进度来自迷宫规划（src/agent/maze.ts）给出的挡板段：第 k 段（第 k 排墙）建好了就进入下一步。
 * 每步一次性（记进存档的 tutorial 记录，「重置新手引导」清空后会重新出现）；可单步跳过，也可整段跳过。
 */

export const MAZE_STEPS = ['ch1-maze-row', 'ch1-maze-snake', 'ch1-maze-lanes'] as const;
export type MazeStep = (typeof MAZE_STEPS)[number];

export type LessonEvent =
  /** 推荐的挡板段里已经建好的段数（从入口一侧数起，连续建好的段） */
  | { type: 'progress'; built: number }
  /** 玩家点了「知道了」：结束当前这一步 */
  | { type: 'ok' }
  /** 玩家点了「跳过教学」：剩下的步骤全部记为已看过 */
  | { type: 'skip' }
  /** 开波 / 对局结束：教学到此为止（剩下的步骤记为已看过，不在战斗中打扰） */
  | { type: 'abort' };

export interface LessonResult {
  /** 下一个要显示的步骤（null = 教学结束） */
  step: MazeStep | null;
  /** 需要记为已看过的步骤 */
  seen: MazeStep[];
}

/** 每一步需要建好的段数：建好这么多段后这一步就算完成 */
const NEED: Record<MazeStep, number> = { 'ch1-maze-row': 1, 'ch1-maze-snake': 2, 'ch1-maze-lanes': Infinity };

/** 某一步在棋盘上提示的挡板段（null = 不显示幽灵墙） */
export function ghostSegment(step: MazeStep | null): number | null {
  if (step === 'ch1-maze-row') return 0;
  if (step === 'ch1-maze-snake') return 1;
  return null;
}

/** 第一个还没看过、也还没被已建好的墙跳过的步骤 */
export function firstStep(seen: (s: MazeStep) => boolean, built = 0): MazeStep | null {
  for (const s of MAZE_STEPS) {
    if (seen(s)) continue;
    if (built >= NEED[s]) continue;
    return s;
  }
  return null;
}

/** 当前步骤收到一个事件后：下一步是什么、哪些步骤记为已看过 */
export function lessonStep(cur: MazeStep | null, ev: LessonEvent): LessonResult {
  if (cur === null) return { step: null, seen: [] };
  const idx = MAZE_STEPS.indexOf(cur);
  const rest = MAZE_STEPS.slice(idx);
  switch (ev.type) {
    case 'skip':
    case 'abort':
      return { step: null, seen: [...rest] };
    case 'ok':
      return { step: MAZE_STEPS[idx + 1] ?? null, seen: [cur] };
    case 'progress': {
      // 一次建了好几排：连跳几步
      const seen: MazeStep[] = [];
      let k = idx;
      while (k < MAZE_STEPS.length && ev.built >= NEED[MAZE_STEPS[k]]) seen.push(MAZE_STEPS[k++]);
      return { step: seen.length ? (MAZE_STEPS[k] ?? null) : cur, seen };
    }
  }
}

/**
 * 从入口一侧数起，连续「已完成」的挡板段数。
 * 一段完成 = 段里每格要么已经不是空地（墙 / 塔 / 杂物），要么现在已经放不下（再放就会堵死路线等）。
 * placeable(i)：这一格现在还能放墙吗（金币不足也算能放——那只是暂时的）。
 */
export function builtSegments(
  segments: readonly (readonly number[])[],
  isEmpty: (i: number) => boolean,
  placeable: (i: number) => boolean,
): number {
  let n = 0;
  for (const seg of segments) {
    if (seg.some((i) => isEmpty(i) && placeable(i))) break;
    n++;
  }
  return n;
}

/** 一段里还需要摆的格子（按建造顺序） */
export function remainingCells(
  seg: readonly number[] | undefined,
  isEmpty: (i: number) => boolean,
  placeable: (i: number) => boolean,
): number[] {
  return seg ? seg.filter((i) => isEmpty(i) && placeable(i)) : [];
}
