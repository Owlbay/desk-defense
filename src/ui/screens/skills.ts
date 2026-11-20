import type { SkillId } from '../../core/types';
import { resolveLoadout, SKILL_MAX_LEVEL, skillLevel, skillSlots, skillUpgradeCost, unlockText, upgradeSkill } from '../../meta/progress';
import { screenHeader, type App, type Route, type Screen } from '../App';
import { skillIcon } from '../assets';
import { audio } from '../audio';
import { SKILL_META, SKILL_ORDER } from '../coreMeta';
import { clear, h, img } from '../dom';
import { G } from '../icons';
import { unlockedSkills } from './common';

const TARGET_TEXT: Record<string, string> = {
  none: '全场 · 立即释放',
  circle: '圆形范围',
  rect2: '2×2 区域',
  line: '一行或一列',
  tower: '选一座塔',
  'tower+cell': '选塔 → 选空格',
  spawner: '选一个空降出生点',
};

export function skillsScreen(app: App, route: Route): Screen {
  const back: Route = route.name === 'skills' && route.from ? route.from : { name: 'menu' };
  const body = h('div.screen-body');
  const el = h('div.screen.skills-screen');

  const render = () => {
    const p = app.store.get();
    const unlocked = unlockedSkills(p);
    const slots = skillSlots(p);
    const loadout = resolveLoadout(p, unlocked);
    clear(el);
    el.appendChild(screenHeader(app, '技能', { back }));
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
        slotRow.appendChild(h('div.slot.locked', { title: '书包天赋「大书包」解锁' }, h('span.gi', { html: G.lock }), h('small', null, '大书包')));
      } else if (s) {
        slotRow.appendChild(
          h(
            'button.slot.filled',
            {
              title: '点击移出',
              onclick: () => {
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
        slotRow.appendChild(h('div.slot.empty', null, h('small', null, '空槽')));
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
      for (let i = 1; i <= SKILL_MAX_LEVEL; i++) pips.appendChild(h(`span.pip${i <= lv ? '.on' : ''}`));
      const cdText = !meta ? '' : id === 'relocate' ? `充能 ${[2, 3, 4][lv - 1]} 次` : `冷却 ${Math.round((meta?.cd ?? 0) * (1 - 0.08 * (lv - 1)))} 秒`;
      grid.appendChild(
        h(
          `article.skill-card.card${ok ? '' : '.locked'}${inLoadout ? '.picked' : ''}`,
          null,
          h('div.skill-card-head', null, img(skillIcon(id), 'ico skill-ico'), h('div', null, h('h3', null, meta?.name ?? id), pips)),
          h('p.skill-desc', null, meta?.desc ?? (id === 'seal_tape' ? '封掉一个空降出生点，立即关闭它。' : '')),
          h('div.skill-tags', null, h('span.tag', null, TARGET_TEXT[meta?.target ?? (id === 'seal_tape' ? 'spawner' : 'none')] ?? ''), cdText ? h('span.tag', null, cdText) : null),
          ok
            ? h(
                'div.row',
                null,
                h(
                  `button.btn.small${inLoadout ? '.on' : ''}`,
                  {
                    onclick: () => {
                      if (inLoadout) {
                        audio.play('click');
                        setLoadout(loadout.filter((x) => x !== id));
                      } else if (loadout.length >= slots) {
                        audio.play('error');
                        app.toast(`最多带入 ${slots} 个技能，先移出一个`, 'warn');
                      } else {
                        audio.play('select');
                        setLoadout([...loadout, id]);
                      }
                    },
                  },
                  inLoadout ? h('span.gi', { html: G.check }) : null,
                  inLoadout ? '已带入' : '带入',
                ),
                cost === null
                  ? h('span.badge.good', null, '满级')
                  : h(
                      `button.btn.small.buy${p.currency.ink >= cost ? '' : '.poor'}`,
                      {
                        title: '每升 1 级：冷却 −8%，效果 +15%',
                        onclick: () => {
                          let ok2 = false;
                          app.store.update((pp) => {
                            ok2 = upgradeSkill(pp, id);
                          });
                          if (ok2) {
                            audio.play('upgrade');
                            app.toast(`${meta?.name ?? id} 升到 Lv${lv + 1}`, 'good');
                            render();
                          } else {
                            audio.play('error');
                            app.toast('墨水不够', 'warn');
                          }
                        },
                      },
                      '升级 ',
                      h('span.gi', { html: G.ink }),
                      String(cost),
                    ),
              )
            : h('div.lock-line', null, h('span.gi', { html: G.lock }), unlockText(meta?.unlock)),
        ),
      );
    }

    body.append(
      h('section.card.section', null, h('h3', null, `带入的技能（${loadout.length}/${slots}）`), slotRow, h('p.muted', null, '对局中按 Q / W / E / R 释放。开局时所有技能都已就绪。')),
      grid,
    );
  };
  render();
  return { el };
}
