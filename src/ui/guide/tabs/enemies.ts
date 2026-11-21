/** 图鉴 · 敌人与 Boss：基础数值、行为、对策，以及护甲 / 护盾 / 飞行 / 隐形规则 */
import { BOSS_ROTATION, ENDLESS_POOL, ENEMIES, type EnemyDef } from '../../../config/enemies';
import { ENEMY_META, type EnemyId } from '../../../core';
import { t } from '../../../i18n';
import { enemyIcon } from '../../assets';
import { h } from '../../dom';
import { type Entry, icon, plain, rich, section, stat, type TabContext, type TabModule, tag } from '../kit';

const NORMAL: EnemyId[] = [...ENDLESS_POOL, 'crumbmini'];
const BOSSES: EnemyId[] = [...BOSS_ROTATION.slice(0, 1), 'boss_coffee_small', ...BOSS_ROTATION.slice(1)];
const RULES = ['armor', 'shield', 'air', 'stealth', 'elite'] as const;

function tags(d: EnemyDef): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (d.boss) out.push(tag(t('guide.enemy.tag.boss'), '.boss'));
  if (d.flying) out.push(tag(t('guide.enemy.tag.flying'), '.flying'));
  if (d.stealthy) out.push(tag(t('guide.enemy.tag.stealth')));
  if (d.unstoppable) out.push(tag(t('guide.enemy.tag.unstoppable')));
  if (d.shieldRatio) out.push(tag(t('guide.enemy.tag.shield')));
  if (d.armor >= 2) out.push(tag(t('guide.enemy.tag.armored')));
  if (d.fast) out.push(tag(t('guide.enemy.tag.fast')));
  return out;
}

function card(id: EnemyId): HTMLElement {
  const d = ENEMIES[id];
  const m = ENEMY_META[id];
  return h(
    `article.guide-entity.card${d.boss ? '.boss' : ''}`,
    { data: { item: id }, attrs: { id: `guide-${id}`, tabindex: '-1' } },
    h(
      'div.guide-entity-head',
      null,
      icon(enemyIcon(id), 'guide-ico big', d.boss ? 72 : 56),
      h('div.guide-entity-title', null, h('h3.guide-h3', null, m.name), h('p.muted', null, m.desc), h('div.guide-tags', null, tags(d))),
    ),
    h(
      'div.guide-stats',
      null,
      stat(t('guide.enemy.hp'), String(d.hp)),
      stat(t('guide.enemy.speed'), t('guide.enemy.speedUnit', { n: d.speed })),
      stat(t('guide.enemy.armor'), String(d.armor)),
      stat(t('guide.enemy.bounty'), String(d.bounty)),
      stat(t('guide.enemy.lives'), String(d.lives)),
      d.first > 0 ? stat(t('guide.enemy.first'), t('guide.wave', { n: d.first })) : null,
    ),
    h(
      'dl.guide-dl',
      null,
      h('dt', null, t('guide.enemy.behavior')),
      rich('dd', t(`guide.enemy.${id}.behavior`)),
      h('dt', null, t('guide.enemy.counter')),
      rich('dd', t(`guide.enemy.${id}.counter`)),
    ),
  );
}

export const enemyTab: TabModule = {
  entries(): Entry[] {
    return [...NORMAL, ...BOSSES].map((id) => ({
      tab: 'enemy',
      id,
      title: ENEMY_META[id].name,
      text: [ENEMY_META[id].desc, t(`guide.enemy.${id}.behavior`), t(`guide.enemy.${id}.counter`)].map(plain).join(' '),
      icon: enemyIcon(id),
    }));
  },
  render(_ctx: TabContext): HTMLElement {
    return h(
      'div.guide-tab',
      null,
      rich('p.guide-lead', t('guide.enemy.intro')),
      h('h2.guide-h2.bare', null, t('guide.enemy.section.normal')),
      h('div.guide-entities', null, NORMAL.map(card)),
      h('h2.guide-h2.bare', null, t('guide.enemy.section.boss')),
      rich('p', t('guide.enemy.bossCommon')),
      h('div.guide-entities', null, BOSSES.map(card)),
      section(
        'rules',
        t('guide.enemy.section.rules'),
        h(
          'ul.guide-list',
          null,
          RULES.map((r) => rich('li', t(`guide.enemy.rules.${r}`))),
        ),
      ),
    );
  },
};
