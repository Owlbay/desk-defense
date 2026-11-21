import type { EnemyId, TowerId } from '../core/types';

/** 调色板（文档 06 §2），全部为 0xRRGGBB 数值 */
export const C = {
  desk: 0xe8d5b5,
  deskDark: 0xd4bc94,
  ink: 0x3b2f2a,
  paper: 0xfbf8f1,
  white: 0xffffff,
  t2Base: 0x6b5b4e,
  teal: 0x2a9d8f,
  gold: 0xd4a82c,
  goldLight: 0xf5d76e,
  goldDark: 0x9c7a1c,
  cyan: 0x4fd1c5,
  magenta: 0xd53f8c,
  bookRed: 0xb23a48,
  bookPage: 0xf2e3c6,
  pencil: 0xf2c14e,
  wood: 0xe07a5f,
  lead: 0x4a4a4a,
  pink: 0xf28aa0,
  steel: 0x5c6b7a,
  metal: 0xa0aec0,
  glue: 0xf4f1e8,
  blueCap: 0x6fa8dc,
  lamp: 0xf29e4c,
  lampLight: 0xffe8a3,
  slate: 0x4a5568,
  ruler: 0x9bd1e5,
  penBlue: 0x2e4a7d,
  screen: 0x9ae6b4,
  piggy: 0xf6a6b2,
  swatter: 0x7bc67e,
  netString: 0xf4ead2,
  inkBlue: 0x2b3a67,
  alarmRed: 0xe63946,
  coffee: 0x6f4e37,
  whiteoutBlue: 0x4fa3e0,
  tapeTan: 0xc8b68e,
  good: 0x2a9d8f,
  bad: 0xe63946,
} as const;

/**
 * 棋盘主题色：桌面本身和直接画在桌面上的标记（网格、路径、范围圈、飘字描边…）随浅色 / 深色主题变化。
 * 塔、敌人、杂物等「物件」的颜色（上面的 C）不变。
 * B 是同一个对象，切换主题时就地改值；所以绘制代码要在画的时候读 B.xxx，不要把值存起来。
 */
export type BoardTheme = 'light' | 'dark';

export interface BoardPalette {
  /** 桌面底色 */
  desk: number;
  /** 木纹、木节 */
  grain: number;
  /** 网格线、格点、暗门接缝 */
  grid: number;
  /** 桌沿描边 */
  edge: number;
  /** 投影颜色与浓度倍数 */
  shadow: number;
  shadowK: number;
  /** 入口缺口、暗门洞口的深色填充 */
  pit: number;
  /** 直接画在桌面上的墨线（当前路径、内圈范围、组合连线的底线…） */
  line: number;
  /** 飘字 / 棋盘文字的描边 */
  textStroke: number;
  /** 深色敌人身下的浅色光晕（0 = 不画） */
  haloAlpha: number;
}

const BOARD_LIGHT: BoardPalette = {
  desk: C.desk,
  grain: C.deskDark,
  grid: C.deskDark,
  edge: C.ink,
  shadow: C.ink,
  shadowK: 1,
  pit: C.ink,
  line: C.ink,
  textStroke: C.ink,
  haloAlpha: 0,
};

/** 夜晚的书桌：深胡桃木桌面，网格线比桌面亮一档，墨线换成米白 */
const BOARD_DARK: BoardPalette = {
  desk: 0x574435,
  grain: 0x473629,
  grid: 0x806850,
  edge: 0x1a1310,
  shadow: 0x000000,
  shadowK: 1.7,
  pit: 0x1a1310,
  line: 0xf3e9d7,
  textStroke: 0x1a1310,
  haloAlpha: 0.3,
};

export const B: BoardPalette = { ...BOARD_LIGHT };

let boardTheme: BoardTheme = 'light';
const boardThemeSubs = new Set<(t: BoardTheme) => void>();

export function getBoardTheme(): BoardTheme {
  return boardTheme;
}

/** 切换棋盘主题（由 src/ui/theme.ts 调用）；已挂载的棋盘会重画桌面 */
export function setBoardTheme(t: BoardTheme): void {
  if (t === boardTheme) return;
  boardTheme = t;
  Object.assign(B, t === 'dark' ? BOARD_DARK : BOARD_LIGHT);
  for (const fn of [...boardThemeSubs]) fn(t);
}

export function onBoardTheme(fn: (t: BoardTheme) => void): () => void {
  boardThemeSubs.add(fn);
  return () => boardThemeSubs.delete(fn);
}

export const ENEMY_COLOR: Record<EnemyId, number> = {
  crumb: 0xf497b6,
  crumbmini: 0xf497b6,
  inkdot: 0x2b3a67,
  paperclip: 0xa0aec0,
  plane: 0xffffff,
  paperball: 0xedede6,
  sticky: 0xfce38a,
  rubberband: 0xe8833a,
  whiteout: 0xf7f7f7,
  ant: 0x3a2e2e,
  invisink: 0x6c5b7b,
  tape: 0xc8b68e,
  moth: 0xb7a99a,
  boss_coffee: 0x6f4e37,
  boss_coffee_small: 0x6f4e37,
  boss_shredder: 0x4a4a4a,
  boss_inkbottle: 0x1f2a44,
  boss_alarm: 0xe63946,
};

export const TOWER_COLOR: Record<TowerId, number> = {
  wall: 0xb23a48,
  pencil: 0xf2c14e,
  stapler: 0x5c6b7a,
  glue: 0xf4f1e8,
  lamp: 0xf29e4c,
  compass: 0x8e9aaf,
  eraser: 0xf28aa0,
  ruler: 0x9bd1e5,
  pen: 0x2e4a7d,
  calculator: 0x4a5568,
  piggy: 0xf6a6b2,
  swatter: 0x7bc67e,
};

export const FONT = '"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif';

export function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}
