import type { MapId, Obstacle } from '../core/types';

export interface MapDef {
  id: MapId;
  name: string;
  chapter: number;
  desc: string;
  /** 每个入口的格子（顶边，宽 2） */
  entrances: { x: number; y: number }[][];
  exits: { x: number; y: number }[];
  obstacles: Obstacle[];
}

const EXIT = [{ x: 5, y: 13 }, { x: 6, y: 13 }];

export const MAPS: Record<MapId, MapDef> = {
  ch1: {
    id: 'ch1', name: '学生书桌', chapter: 1,
    desc: '单入口单出口；水杯和课本堆挡在桌面上',
    entrances: [[{ x: 5, y: 0 }, { x: 6, y: 0 }]],
    exits: EXIT,
    obstacles: [
      { kind: 'cup', x: 8, y: 3, w: 2, h: 2 },
      { kind: 'books', x: 2, y: 8, w: 1, h: 3 },
    ],
  },
  ch2: {
    id: 'ch2', name: '程序员工位', chapter: 2,
    desc: '两个入口；键盘横在中间，只留一个缺口',
    entrances: [[{ x: 1, y: 0 }, { x: 2, y: 0 }], [{ x: 9, y: 0 }, { x: 10, y: 0 }]],
    exits: EXIT,
    obstacles: [
      { kind: 'keyboard', x: 2, y: 6, w: 3, h: 1 },
      { kind: 'keyboard', x: 6, y: 6, w: 3, h: 1 },
      { kind: 'mouse', x: 10, y: 9, w: 1, h: 2 },
    ],
  },
  ch3: {
    id: 'ch3', name: '画师工作台', chapter: 3,
    desc: '两个角落入口，空中路线更长；调色盘和颜料管',
    entrances: [[{ x: 0, y: 0 }, { x: 1, y: 0 }], [{ x: 10, y: 0 }, { x: 11, y: 0 }]],
    exits: EXIT,
    obstacles: [
      { kind: 'palette', x: 4, y: 4, w: 2, h: 2 },
      { kind: 'paint', x: 9, y: 8, w: 1, h: 2 },
      { kind: 'paint', x: 1, y: 10, w: 2, h: 1 },
    ],
  },
};
