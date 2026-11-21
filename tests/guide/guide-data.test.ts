import { describe, expect, it } from 'vitest';

import { AFFIX_IDS, ENEMIES } from '../../src/config/enemies';
import { TOWER_IDS } from '../../src/core/types';
import zhCN from '../../src/i18n/locales/zh-CN/guide';
import { parseGuideHash } from '../../src/ui/guide/hash';
import { towerSheet } from '../../src/ui/guide/towerData';

const src = zhCN as Record<string, string>;

describe('图鉴数据', () => {
  it('每座塔都能从临时对局读出面板：Lv1 与两个传奇分支', () => {
    for (const id of TOWER_IDS) {
      const sheet = towerSheet(id);
      expect(sheet, id).not.toBeNull();
      if (!sheet) continue;
      if (id === 'wall') {
        expect(sheet.base.map((b) => b.level)).toEqual([1, 2, 3]);
        continue;
      }
      expect(sheet.base[0].level).toBe(1);
      for (const b of ['A', 'B'] as const) {
        const info = sheet.legend[b];
        expect(info?.level, `${id} ${b}`).toBe(10);
        expect(info?.branch).toBe(b);
        expect(info?.evoTraits.length, `${id} ${b} ★1/★2`).toBe(2);
        expect(info?.ability?.id, `${id} ${b}`).toBe(`${id}_${b.toLowerCase()}`);
      }
      expect(sheet.legendCost).toBeGreaterThan(0);
    }
  });

  it('每种敌人、每条词缀都有行为 / 对策文案', () => {
    for (const id of Object.keys(ENEMIES)) {
      expect(src[`guide.enemy.${id}.behavior`], id).toBeTruthy();
      expect(src[`guide.enemy.${id}.counter`], id).toBeTruthy();
    }
    for (const id of AFFIX_IDS) expect(src[`guide.affix.${id}.counter`], id).toBeTruthy();
  });

  it('解析深链', () => {
    expect(parseGuideHash('#guide')).toBe('');
    expect(parseGuideHash('#guide/tower/pencil')).toBe('tower/pencil');
    expect(parseGuideHash('#/guide/enemy/boss_coffee')).toBe('enemy/boss_coffee');
    expect(parseGuideHash('#guidebook')).toBeNull();
    expect(parseGuideHash('')).toBeNull();
  });
});
