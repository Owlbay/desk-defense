import { CELL_PX, GRID_COLS, GRID_ROWS } from '../core/types';

export const CELL = CELL_PX;
export const BOARD_W = GRID_COLS * CELL_PX;
export const BOARD_H = GRID_ROWS * CELL_PX;

/** 渲染层级 */
export const DEPTH = {
  bg: 0,
  inputUnder: 4,
  zone: 6,
  under: 8, // 精英环、定身胶团等脚下标记
  tower: 10, // + cy * 0.01
  ghost: 18,
  ground: 20,
  proj: 30,
  air: 34,
  over: 40, // 血条、状态
  overIcons: 41,
  fx: 50,
  inputOver: 55,
  text: 60,
  tint: 65,
  loading: 80,
} as const;

/** 格坐标（浮点）→ 逻辑像素 */
export const px = (c: number): number => c * CELL;

export type Quality = 'high' | 'low';
