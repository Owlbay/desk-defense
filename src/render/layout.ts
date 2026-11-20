import { CELL_PX, GRID_COLS, GRID_ROWS } from '../core/types';

export const CELL = CELL_PX;
export const BOARD_W = GRID_COLS * CELL_PX;
export const BOARD_H = GRID_ROWS * CELL_PX;

/** 渲染层级 */
export const DEPTH = {
  bg: 0,
  inputUnder: 4,
  zone: 6,
  fieldUnder: 7, // 出生点高亮、事件预警底色
  under: 8,
  box: 9.5, // 已落地的空降纸箱（与塔不重叠） // 精英环、定身胶团等脚下标记
  tower: 10, // + cy * 0.01
  ghost: 18,
  ground: 20,
  proj: 30,
  air: 34,
  pickup: 36, // 硬币 / 补给箱（在敌人之上，便于点击）
  over: 40, // 血条、状态
  overIcons: 41,
  fieldTop: 48, // 事件覆盖（风、Zzz、预警框、下落的纸箱）
  fx: 50,
  inputOver: 55,
  text: 60,
  tint: 65,
  loading: 80,
} as const;

/** 格坐标（浮点）→ 逻辑像素 */
export const px = (c: number): number => c * CELL;

export type Quality = 'high' | 'low';
