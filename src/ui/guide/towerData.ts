/**
 * 图鉴里塔的面板数值：在一个临时对局里真的放塔、逐级升级，再读 getTowerInfo()，
 * 与游戏内显示完全一致（做法同 scripts/gen-data-docs.ts）。按「语言 + 塔」缓存。
 */
import { type Branch, createWorld, type IWorld, type TowerId, type TowerInfo } from '../../core';
import { getLocale } from '../../i18n';

export interface TowerSheet {
  id: TowerId;
  /** 书本墙：Lv1..3；其它塔：Lv1 */
  base: TowerInfo[];
  /** Lv10 的两个分支（书本墙没有） */
  legend: Partial<Record<Branch, TowerInfo>>;
  /** Lv9→10 的金币费用（未打折） */
  legendCost: number | null;
}

const cache = new Map<string, TowerSheet | null>();

function scratch(seed: string): IWorld {
  const w = createWorld({
    mode: 'endless',
    map: 'ch1',
    difficulty: 'normal',
    seed,
    skills: [],
    pure: true,
    fixedLayout: true,
    autoWave: false,
  });
  w.state.gold = 1e9;
  return w;
}

function place(w: IWorld, id: TowerId): number {
  const g = w.state.grid;
  for (let y = 2; y < g.rows - 2; y++) {
    for (let x = 0; x < g.cols; x++) {
      if (!w.canPlace(id, x, y).ok) continue;
      if (!w.command({ type: 'place', tower: id, cx: x, cy: y }).ok) continue;
      return g.towerAt[y * g.cols + x];
    }
  }
  return 0;
}

function build(id: TowerId): TowerSheet | null {
  const sheet: TowerSheet = { id, base: [], legend: {}, legendCost: null };
  const maxLv = id === 'wall' ? 3 : 10;
  for (const br of ['A', 'B'] as const) {
    const w = scratch(`guide-${id}-${br}`);
    const uid = place(w, id);
    if (!uid) return null;
    for (let lv = 1; lv <= maxLv; lv++) {
      const info = w.getTowerInfo(uid);
      if (!info) return null;
      if (lv === 10) sheet.legend[br] = info;
      else if (br === 'A' && (lv === 1 || id === 'wall')) sheet.base.push(info);
      if (lv === 9 && br === 'A') sheet.legendCost = info.upgradeCost;
      if (lv < maxLv && !w.command({ type: 'upgrade', uid, branch: lv === 9 ? br : undefined }).ok) return null;
    }
    if (id === 'wall') break;
  }
  return sheet;
}

/** 读不出来时返回 null（页面显示一句提示，不影响其它内容） */
export function towerSheet(id: TowerId): TowerSheet | null {
  const key = `${getLocale()}:${id}`;
  if (!cache.has(key)) {
    let sheet: TowerSheet | null = null;
    try {
      sheet = build(id);
    } catch (e) {
      console.warn('[guide] 读取塔数值失败', id, e);
    }
    cache.set(key, sheet);
  }
  return cache.get(key) ?? null;
}
