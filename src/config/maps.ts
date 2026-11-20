import type { MapId, Obstacle } from '../core/types';

/** 出生点定义（文档 09 §1.3） */
export interface SpawnerDef {
  id: string;                    // 'north' | 'west' | 'hidden-1' …
  name: string;                  // 显示名
  cells: { x: number; y: number }[];
  kind: 'edge' | 'hidden';
  weight: number;                // random 策略下的权重
  /** 无尽 / 自定义：从第几波开始开放（默认 1） */
  openFromWave?: number;
  /** 战役：从第几波开始开放；0 = 战役中不开放；缺省同 openFromWave */
  campaignOpen?: number;
}

/** 杂物池条目（尺寸为横放时的宽高，可旋转 90°） */
export interface ClutterDef {
  kind: Obstacle['kind'];
  w: number;
  h: number;
  weight: number;
  /** 同一张布局里最多几个 */
  max?: number;
}

export interface MapDef {
  id: MapId;
  name: string;
  chapter: number;
  desc: string;
  /** 战役章节种子（杂物 = 章节种子 + 局种子） */
  chapterSeed: string;
  spawners: SpawnerDef[];
  exits: { x: number; y: number }[];
  /** 骨架：章节标志物（不随机） */
  landmarks: Obstacle[];
  /** 杂物池 */
  clutter: ClutterDef[];
  /** 杂物预算（格面积） */
  clutterBudget: [number, number];
  /** 手工默认杂物布局（固定布局 / 生成失败时回退） */
  defaultClutter: Obstacle[];
}

const EXIT = [{ x: 5, y: 13 }, { x: 6, y: 13 }];

/** 通用杂物（各图再加自己的） */
const COMMON: ClutterDef[] = [
  { kind: 'eraser', w: 1, h: 1, weight: 3, max: 2 },
  { kind: 'sticky', w: 1, h: 1, weight: 3, max: 2 },
  { kind: 'clip', w: 1, h: 1, weight: 2, max: 2 },
  { kind: 'pencilcup', w: 1, h: 1, weight: 2, max: 1 },
  { kind: 'tape', w: 1, h: 1, weight: 2, max: 1 },
  { kind: 'phone', w: 1, h: 2, weight: 2, max: 1 },
  { kind: 'stapler', w: 2, h: 1, weight: 2, max: 1 },
  { kind: 'ruler', w: 3, h: 1, weight: 1, max: 1 },
];

export const MAPS: Record<MapId, MapDef> = {
  ch1: {
    id: 'ch1', name: '学生书桌', chapter: 1,
    desc: '北边一个入口；水杯、课本等杂物每局位置不同。无尽后期西侧也会出怪',
    chapterSeed: 'ch1-student-desk',
    spawners: [
      { id: 'north', name: '北入口', cells: [{ x: 5, y: 0 }, { x: 6, y: 0 }], kind: 'edge', weight: 1 },
      { id: 'west', name: '西入口', cells: [{ x: 0, y: 3 }, { x: 0, y: 4 }], kind: 'edge', weight: 0.6, openFromWave: 25, campaignOpen: 0 },
      { id: 'hidden-1', name: '暗门', cells: [{ x: 11, y: 4 }, { x: 11, y: 5 }], kind: 'hidden', weight: 0.5 },
    ],
    exits: EXIT,
    landmarks: [],
    clutter: [
      ...COMMON,
      { kind: 'cup', w: 2, h: 2, weight: 4, max: 1 },
      { kind: 'books', w: 1, h: 3, weight: 4, max: 1 },
    ],
    clutterBudget: [6, 9],
    defaultClutter: [
      { kind: 'cup', x: 8, y: 3, w: 2, h: 2 },
      { kind: 'books', x: 2, y: 8, w: 1, h: 3 },
    ],
  },
  ch2: {
    id: 'ch2', name: '程序员工位', chapter: 2,
    desc: '北边两个入口；键盘横在中间，只留一个缺口。后期东侧也会出怪',
    chapterSeed: 'ch2-coder-desk',
    spawners: [
      { id: 'north-1', name: '北入口 1', cells: [{ x: 1, y: 0 }, { x: 2, y: 0 }], kind: 'edge', weight: 1 },
      { id: 'north-2', name: '北入口 2', cells: [{ x: 9, y: 0 }, { x: 10, y: 0 }], kind: 'edge', weight: 1 },
      { id: 'east', name: '东入口', cells: [{ x: 11, y: 3 }, { x: 11, y: 4 }], kind: 'edge', weight: 0.6, openFromWave: 30, campaignOpen: 15 },
      { id: 'hidden-1', name: '暗门', cells: [{ x: 0, y: 4 }, { x: 0, y: 5 }], kind: 'hidden', weight: 0.5 },
    ],
    exits: EXIT,
    landmarks: [
      { kind: 'keyboard', x: 2, y: 6, w: 3, h: 1 },
      { kind: 'keyboard', x: 6, y: 6, w: 3, h: 1 },
    ],
    clutter: [
      ...COMMON,
      { kind: 'mouse', w: 1, h: 2, weight: 4, max: 1 },
      { kind: 'cup', w: 2, h: 2, weight: 2, max: 1 },
    ],
    clutterBudget: [4, 7],
    defaultClutter: [
      { kind: 'mouse', x: 10, y: 9, w: 1, h: 2 },
    ],
  },
  ch3: {
    id: 'ch3', name: '画师工作台', chapter: 3,
    desc: '两个角落入口，空中路线更长；调色盘固定，颜料管每局位置不同。后期西侧也会出怪',
    chapterSeed: 'ch3-artist-desk',
    spawners: [
      { id: 'north-1', name: '北入口 1', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }], kind: 'edge', weight: 1 },
      { id: 'north-2', name: '北入口 2', cells: [{ x: 10, y: 0 }, { x: 11, y: 0 }], kind: 'edge', weight: 1 },
      { id: 'west', name: '西入口', cells: [{ x: 0, y: 5 }, { x: 0, y: 6 }], kind: 'edge', weight: 0.6, openFromWave: 30, campaignOpen: 16 },
      { id: 'hidden-1', name: '暗门', cells: [{ x: 11, y: 5 }, { x: 11, y: 6 }], kind: 'hidden', weight: 0.5 },
    ],
    exits: EXIT,
    landmarks: [
      { kind: 'palette', x: 4, y: 4, w: 2, h: 2 },
    ],
    clutter: [
      ...COMMON,
      { kind: 'paint', w: 1, h: 2, weight: 5, max: 2 },
      { kind: 'cup', w: 2, h: 2, weight: 2, max: 1 },
    ],
    clutterBudget: [5, 8],
    defaultClutter: [
      { kind: 'paint', x: 9, y: 8, w: 1, h: 2 },
      { kind: 'paint', x: 1, y: 10, w: 2, h: 1 },
    ],
  },
};

/** 某出生点在给定模式下从第几波开放（0 = 不开放） */
export function spawnerOpenWave(d: SpawnerDef, campaign: boolean): number {
  if (d.kind === 'hidden') return 0;
  if (campaign && d.campaignOpen !== undefined) return d.campaignOpen;
  return d.openFromWave ?? 1;
}
