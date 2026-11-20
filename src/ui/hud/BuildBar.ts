import type { BuildOption, TowerId } from '../../core/types';
import { ui } from '../../game/UiStore';
import { parseUnlock } from '../../meta/progress';
import { towerIcon } from '../assets';
import { audio } from '../audio';
import { TOWER_META } from '../coreMeta';
import { h, img, setText, toggle } from '../dom';
import { G } from '../icons';
import { BUILD_KEYS, type GameCtx } from './context';
import { replay } from './motion';

interface Btn {
  el: HTMLButtonElement;
  price: HTMLElement;
  opt: BuildOption;
  /** 上次「买得起」动画的时间（金币在价格附近抖动时不反复弹） */
  affordAt: number;
  badge: HTMLElement | null;
}

export class BuildBar {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private btns = new Map<TowerId, Btn>();
  private order: TowerId[] = [];
  private sig = '';
  /** 第一次填充之后，新出现 / 新解锁的塔会有「NEW」提示 */
  private primed = false;
  private known = new Map<TowerId, boolean>();

  constructor(private ctx: GameCtx) {
    this.list = h('div.build-list', { attrs: { role: 'toolbar', 'aria-label': '建造' } });
    this.el = h('div.buildbar', null, this.list);
  }

  buttonFor(id: TowerId): HTMLElement | null {
    return this.btns.get(id)?.el ?? null;
  }

  /** 按快捷键序号选择 */
  pickIndex(i: number): void {
    const id = this.order[i];
    if (id) this.pick(id);
  }

  pick(id: TowerId): void {
    const b = this.btns.get(id);
    if (!b) return;
    const o = b.opt;
    if (ui.state.build === id) {
      audio.play('click');
      ui.set({ build: null, pending: null });
      return;
    }
    if (!o.unlocked) {
      audio.play('error');
      const u = parseUnlock(TOWER_META[id]?.unlock);
      this.ctx.toast(u ? `${o.name}：战役 ${u.chapter}-${u.wave} 解锁` : `${o.name} 尚未解锁`, 'warn');
      return;
    }
    if (o.limitReached) {
      audio.play('error');
      this.ctx.toast(`${o.name} 已达数量上限`, 'warn');
      return;
    }
    audio.play('select');
    this.clearNew(b);
    ui.set({ build: id, selected: null, aiming: null, relocateFrom: null, pending: null });
    if (!o.affordable) this.ctx.toast(`金币不够（需要 ${o.cost}）`, 'warn');
  }

  update(opts: BuildOption[]): void {
    const sig = opts.map((o) => o.id).join(',');
    if (sig !== this.sig) this.rebuild(opts);
    for (const o of opts) {
      const b = this.btns.get(o.id);
      if (!b) continue;
      b.opt = o;
      setText(b.price, o.limitReached ? '上限' : String(o.cost));
      const wasPoor = b.el.classList.contains('poor');
      toggle(b.el, 'poor', !o.affordable);
      toggle(b.el, 'locked', !o.unlocked);
      toggle(b.el, 'limit', !!o.limitReached);
      // 刚攒够钱：图标弹一下
      if (this.primed && wasPoor && o.affordable && o.unlocked && !o.limitReached) {
        const now = performance.now();
        if (now - b.affordAt > 2500) {
          b.affordAt = now;
          replay(b.el, 'afford', 420);
        }
      }
      // 新解锁：NEW 角标 + 扫光
      const was = this.known.get(o.id);
      if (this.primed && o.unlocked && was !== true) this.markNew(b);
      this.known.set(o.id, o.unlocked);
    }
    this.primed = true;
    this.syncSelected();
  }

  private markNew(b: Btn): void {
    if (b.badge) return;
    b.badge = h('span.b-new', { attrs: { 'aria-hidden': 'true' } }, 'NEW');
    b.el.append(b.badge, h('span.b-shine', { attrs: { 'aria-hidden': 'true' } }));
    b.el.classList.add('is-new');
    const badge = b.badge;
    setTimeout(() => b.badge === badge && this.clearNew(b), 9000);
  }

  private clearNew(b: Btn): void {
    if (!b.badge) return;
    b.badge.remove();
    b.badge = null;
    b.el.querySelector('.b-shine')?.remove();
    b.el.classList.remove('is-new');
  }

  syncSelected(): void {
    for (const [id, b] of this.btns) {
      const on = ui.state.build === id;
      toggle(b.el, 'on', on);
      b.el.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  private rebuild(opts: BuildOption[]): void {
    this.sig = opts.map((o) => o.id).join(',');
    this.list.replaceChildren();
    this.btns.clear();
    this.order = opts.map((o) => o.id);
    opts.forEach((o, i) => {
      const price = h('span.b-price');
      const airOnly = o.hitsAir && !o.hitsGround;
      const air = o.hitsAir && o.hitsGround ? '对空/地' : airOnly ? '只打空中' : o.hitsGround ? '对地' : '';
      const el = h<HTMLButtonElement>(
        'button.build-btn',
        {
          title: `${o.name}（${o.role}）${air ? ' · ' + air : ''}\n${o.desc}`,
          attrs: { 'aria-label': `${o.name} ${o.cost} 金币`, 'aria-pressed': 'false' },
          onclick: () => this.pick(o.id),
        },
        h('span.b-ico', null, img(towerIcon(o.id), 'ico')),
        h('span.b-text', null, h('span.b-name', null, o.name), h('span.b-cost', null, h('span.gi', { html: G.coin }), price)),
        BUILD_KEYS[i] ? h('kbd.key-hint', null, BUILD_KEYS[i]) : null,
        airOnly ? h('span.b-air', { attrs: { 'aria-hidden': 'true' } }, h('span.gi', { html: G.plane }), '只打空中') : null,
        h('span.b-lock.gi', { html: G.lock }),
        h('span.b-sel', { attrs: { 'aria-hidden': 'true' } }),
      );
      this.list.appendChild(el);
      this.btns.set(o.id, { el, price, opt: o, affordAt: 0, badge: null });
    });
  }
}
