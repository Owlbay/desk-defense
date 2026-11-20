import { buyTalent, talentLevel, totalStarsEarned } from '../../meta/progress';
import { screenHeader, type App, type Screen } from '../App';
import { audio } from '../audio';
import { TALENT_META, TALENT_ORDER } from '../coreMeta';
import { clear, h } from '../dom';
import { G } from '../icons';
import { burst } from './motion';

const TALENT_GLYPH: Record<string, string> = {
  wallet: G.coin,
  bandaid: G.heart,
  alarm: G.bolt,
  study: G.book,
  secondhand: G.sell,
  bigbag: G.bag,
  luckydraw: G.refresh,
  collector: G.crown,
};

export function talentsScreen(app: App): Screen {
  const el = h('div.screen.talents-screen');
  /** 刚买的天赋：这次渲染给它播"升级"演出 */
  let justBought: string | null = null;
  const render = () => {
    const p = app.store.get();
    clear(el);
    el.appendChild(screenHeader(app, '书包'));
    const grid = h('div.talent-grid');
    for (const id of TALENT_ORDER) {
      const m = TALENT_META[id];
      if (!m) continue;
      const lv = talentLevel(p, id);
      const maxed = lv >= m.max;
      const pips = h('span.pips');
      const up = justBought === id;
      for (let i = 1; i <= m.max; i++) pips.appendChild(h(`span.pip${i <= lv ? '.on' : ''}${up && i === lv ? '.just-on' : ''}`));
      const buy = (cur: 'star' | 'ink') => {
        const cost = cur === 'star' ? m.star : m.ink;
        const can = p.currency[cur] >= cost;
        return h(
          `button.btn.small.buy${can ? '' : '.poor'}`,
          {
            onclick: () => {
              let ok = false;
              app.store.update((pp) => {
                ok = buyTalent(pp, id, m, cur);
              });
              if (ok) {
                audio.play('upgrade');
                app.toast(`${m.name} 升到 ${lv + 1} 级`, 'good');
                justBought = id;
                render();
              } else {
                audio.play('error');
                app.toast(cur === 'star' ? '星星不够' : '墨水不够', 'warn');
              }
            },
          },
          h('span.gi', { html: cur === 'star' ? G.star : G.ink }),
          String(cost),
        );
      };
      const icoEl = h('span.talent-ico', { html: TALENT_GLYPH[id] ?? G.star });
      if (up) burst(icoEl, 12, 52);
      grid.appendChild(
        h(
          `article.talent-card.card${maxed ? '.maxed' : ''}${up ? '.level-up' : ''}`,
          null,
          h('div.talent-head', null, icoEl, h('div', null, h('h3', null, m.name), pips)),
          h('p', null, m.desc, m.max > 1 ? h('small.muted', null, `（每级，最高 ${m.max} 级）`) : null),
          maxed ? h('span.badge.good', null, '已满级') : h('div.row.buy-row', null, buy('star'), h('span.muted.or', null, '或'), buy('ink')),
        ),
      );
    }
    justBought = null;
    el.appendChild(
      h(
        'div.screen-body',
        null,
        h(
          'p.muted.center',
          null,
          `永久天赋。星星来自战役评星（已累计获得 ${totalStarsEarned(p)} 颗），墨水来自无尽和自定义模式。天赋都是小幅加成；开局选择「纯净模式」可以关闭它们。`,
        ),
        grid,
      ),
    );
  };
  render();
  return { el };
}
