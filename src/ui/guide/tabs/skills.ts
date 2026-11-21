/** 图鉴 · 技能 / 增益 / 天赋 */
import { PERK_META, SKILL_IDS, SKILL_META, TALENT_IDS, TALENT_META, type Rarity } from '../../../core';
import { t } from '../../../i18n';
import { skillIcon } from '../../assets';
import { h } from '../../dom';
import { bullets, icon, rich, section, tag, unlockLabel, type Entry, type TabContext, type TabModule } from '../kit';

const RARITIES: Rarity[] = ['common', 'rare', 'epic'];

function row(id: string, iconEl: HTMLElement | null, name: string, desc: string, tags: (HTMLElement | null)[], cls = ''): HTMLElement {
  return h(
    `div.guide-row${cls}`,
    { data: { item: id }, attrs: { id: `guide-${id}`, tabindex: '-1' } },
    iconEl,
    h('div.guide-row-main', null, h('div.guide-row-title', null, h('strong', null, name), tags), h('p', null, desc)),
  );
}

export const skillTab: TabModule = {
  entries(): Entry[] {
    return [
      ...SKILL_IDS.map((id): Entry => ({ tab: 'skill', id: `skill-${id}`, title: SKILL_META[id].name, text: SKILL_META[id].desc, icon: skillIcon(id) })),
      ...PERK_META.map((p): Entry => ({ tab: 'skill', id: `perk-${p.id}`, title: p.name, text: p.desc })),
      ...TALENT_IDS.map((id): Entry => ({ tab: 'skill', id: `talent-${id}`, title: TALENT_META[id].name, text: TALENT_META[id].desc })),
    ];
  },
  render(_ctx: TabContext): HTMLElement {
    return h(
      'div.guide-tab',
      null,
      section(
        'skills',
        t('guide.skill.section.skills'),
        rich('p', t('guide.skill.intro')),
        bullets('guide.skill.rules'),
        h(
          'div.guide-rows',
          null,
          SKILL_IDS.map((id) => {
            const m = SKILL_META[id];
            return row(`skill-${id}`, icon(skillIcon(id), 'guide-ico', 44), m.name, m.desc, [
              tag(m.cd > 0 ? t('guide.skill.cd', { n: m.cd }) : t('guide.skill.charge')),
              tag(unlockLabel(m.unlock)),
            ]);
          }),
        ),
      ),
      section(
        'perks',
        t('guide.skill.section.perks'),
        rich('p', t('guide.perk.intro')),
        RARITIES.map((r) => [
          h(`h3.guide-h3.g-rarity-${r}`, null, t(`guide.perk.rarity.${r}`)),
          h(
            'div.guide-rows',
            null,
            PERK_META.filter((p) => p.rarity === r).map((p) => row(`perk-${p.id}`, null, p.name, p.desc, [p.needsTower ? tag(t('guide.perk.needsTower')) : null], `.g-rarity-${r}`)),
          ),
        ]),
      ),
      section(
        'talents',
        t('guide.skill.section.talents'),
        rich('p', t('guide.talent.intro')),
        h(
          'div.guide-rows',
          null,
          TALENT_IDS.map((id) => {
            const m = TALENT_META[id];
            return row(`talent-${id}`, null, m.name, m.desc, [tag(t('guide.talent.max', { n: m.max })), tag(t('guide.talent.price', { star: m.star, ink: m.ink }))]);
          }),
        ),
        rich('p.muted', t('guide.talent.tip')),
        rich('p', t('guide.talent.pure')),
      ),
    );
  },
};
