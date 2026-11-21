import type { SkillId } from '../../core/types';
import { resolveLoadout, SKILL_MAX_LEVEL, skillLevel, skillSlots, skillUpgradeCost, unlockText, upgradeSkill } from '../../meta/progress';
import { screenHeader, type App, type Route, type Screen } from '../App';
import { skillIcon } from '../assets';
import { audio } from '../audio';
import { SKILL_META, SKILL_ORDER } from '../coreMeta';
import { clear, h, img } from '../dom';
import { G } from '../icons';
import { unlockedSkills } from './common';
import { burst } from './motion';
import { fmtNumber, t } from '../../i18n';

const TARGET_KEYS = ['none', 'circle', 'rect2', 'line', 'tower', 'tower+cell', 'spawner'];
const targetText = (k: string): string => (TARGET_KEYS.includes(k) ? t(`ui.skills.target.${k.replace('+', '_')}`) : '');

export function skillsScreen(app: App, route: Route): Screen {
  const back: Route = route.name === 'skills' && route.from ? route.from : { name: 'menu' };
  const body = h('div.screen-body');
  const el = h('div.screen.skills-screen');

  /** 上一次渲染时带入的技能；用来找出"刚放进槽位"的那个 */
  let prevLoadout: SkillId[] | null = null;
  /** 刚升级的技能：这次渲染给它播升级演出 */
  let justUpgraded: SkillId | null = null;

  const render = () => {
    const p = app.store.get();
    const unlocked = unlockedSkills(p);
    const slots = skillSlots(p);
    const loadout = resolveLoadout(p, unlocked);
    clear(el);
    el.appendChild(screenHeader(app, t('ui.skills.title'), { back }));
    el.appendChild(body);
    clear(body);

    const setLoadout = (next: SkillId[]) => {
      app.store.update((pp) => {
        pp.skills.loadout = next;
      });
      render();
    };

    const slotRow = h('div.slot-row');
    for (let i = 0; i < 4; i++) {
      const s = loadout[i];
      if (i >= slots) {
        slotRow.appendChild(
          h(
            'div.slot.locked',
            { title: t('ui.skills.slotLockedTip') },
            h('span.gi', { html: G.lock }),
            h('small', null, t('ui.skills.slotLocked')),
          ),
        );
      } else if (s) {
        slotRow.appendChild(
          h(
            `button.slot.filled${prevLoadout && !prevLoadout.includes(s) ? '.just-filled' : ''}`,
            {
              title: t('ui.skills.tapRemove'),
              onclick: () => {
                if (loadout.length <= 1) {
                  audio.play('error');
                  app.toast(t('ui.skills.minLoadout'), 'warn');
                  return;
                }
                audio.play('click');
                setLoadout(loadout.filter((x) => x !== s));
              },
            },
            img(skillIcon(s), 'ico'),
            h('small', null, SKILL_META[s]?.name ?? s),
            h('span.slot-key', null, 'QWER'[i]),
          ),
        );
      } else {
        slotRow.appendChild(h('div.slot.empty', null, h('small', null, t('ui.skills.emptySlot'))));
      }
    }

    const grid = h('div.skill-grid');
    for (const id of SKILL_ORDER) {
      const meta = SKILL_META[id];
      const ok = unlocked.includes(id);
      const lv = skillLevel(p, id);
      const cost = skillUpgradeCost(lv);
      const inLoadout = loadout.includes(id);
      const pips = h('span.pips');
      const up = justUpgraded === id;
      for (let i = 1; i <= SKILL_MAX_LEVEL; i++) pips.appendChild(h(`span.pip${i <= lv ? '.on' : ''}${up && i === lv ? '.just-on' : ''}`));
      const cdText = !meta
        ? ''
        : id === 'relocate'
          ? t('ui.skills.charges', { n: [2, 3, 4][lv - 1] })
          : t('ui.skills.cooldown', { n: Math.round((meta?.cd ?? 0) * (1 - 0.08 * (lv - 1))) });
      const justPicked = !!prevLoadout && inLoadout && !prevLoadout.includes(id);
      const card = h(
        `article.skill-card.card${ok ? '' : '.locked'}${inLoadout ? '.picked' : ''}${justPicked ? '.just-picked' : ''}${up ? '.level-up' : ''}`,
        null,
        h('div.skill-card-head', null, img(skillIcon(id), 'ico skill-ico'), h('div', null, h('h3', null, meta?.name ?? id), pips)),
        h('p.skill-desc', null, meta?.desc ?? (id === 'seal_tape' ? t('ui.skills.sealTapeDesc') : '')),
        h(
          'div.skill-tags',
          null,
          h('span.tag', null, targetText(meta?.target ?? (id === 'seal_tape' ? 'spawner' : 'none'))),
          cdText ? h('span.tag', null, cdText) : null,
        ),
        ok
          ? h(
              'div.row',
              null,
              h(
                `button.btn.small${inLoadout ? '.on' : ''}`,
                {
                  onclick: () => {
                    if (inLoadout && loadout.length <= 1) {
                      audio.play('error');
                      app.toast(t('ui.skills.minLoadout'), 'warn');
                    } else if (inLoadout) {
                      audio.play('click');
                      setLoadout(loadout.filter((x) => x !== id));
                    } else if (loadout.length >= slots) {
                      audio.play('error');
                      app.toast(t('ui.skills.maxLoadout', { n: slots }), 'warn');
                    } else {
                      audio.play('select');
                      setLoadout([...loadout, id]);
                    }
                  },
                },
                inLoadout ? h('span.gi', { html: G.check }) : null,
                inLoadout ? t('ui.skills.equipped') : t('ui.skills.equip'),
              ),
              cost === null
                ? h('span.badge.good', null, t('ui.skills.maxed'))
                : h(
                    `button.btn.small.buy${p.currency.ink >= cost ? '' : '.poor'}`,
                    {
                      title: t('ui.skills.upgradeTip'),
                      onclick: () => {
                        let ok2 = false;
                        app.store.update((pp) => {
                          ok2 = upgradeSkill(pp, id);
                        });
                        if (ok2) {
                          audio.play('upgrade');
                          app.toast(t('ui.skills.upgraded', { name: meta?.name ?? id, n: lv + 1 }), 'good');
                          justUpgraded = id;
                          render();
                        } else {
                          audio.play('error');
                          app.toast(t('ui.skills.noInk'), 'warn');
                        }
                      },
                    },
                    `${t('ui.skills.upgrade')} `,
                    h('span.gi', { html: G.ink }),
                    fmtNumber(cost),
                  ),
            )
          : h('div.lock-line', null, h('span.gi', { html: G.lock }), unlockText(meta?.unlock)),
      );
      grid.appendChild(card);
      if (up) {
        const ico = card.querySelector<HTMLElement>('.skill-card-head');
        if (ico) burst(ico, 10, 44);
      }
    }
    prevLoadout = loadout;
    justUpgraded = null;

    body.append(
      h(
        'section.card.section',
        null,
        h('h3', null, t('ui.skills.loadoutTitle', { n: loadout.length, max: slots })),
        slotRow,
        h('p.muted', null, t('ui.skills.loadoutHint')),
      ),
      grid,
    );
  };
  render();
  return { el };
}
