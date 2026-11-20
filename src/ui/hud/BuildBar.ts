import type { BuildOption, TowerId } from '../../core/types';
import { ui } from '../../game/UiStore';
import { parseUnlock } from '../../meta/progress';
import { towerIcon } from '../assets';
import { audio } from '../audio';
import { TOWER_META } from '../coreMeta';
import { h, img, setText, toggle } from '../dom';
import { G } from '../icons';
import { BUILD_KEYS, type GameCtx } from './context';

interface Btn {
  el: HTMLButtonElement;
  price: HTMLElement;
  opt: BuildOption;
}

export class BuildBar {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private btns = new Map<TowerId, Btn>();
  private order: TowerId[] = [];
  private sig = '';

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
      toggle(b.el, 'poor', !o.affordable);
      toggle(b.el, 'locked', !o.unlocked);
      toggle(b.el, 'limit', !!o.limitReached);
    }
    this.syncSelected();
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
      const air = o.hitsAir && o.hitsGround ? '对空/地' : o.hitsAir ? '对空' : o.hitsGround ? '对地' : '';
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
        h('span.b-lock.gi', { html: G.lock }),
      );
      this.list.appendChild(el);
      this.btns.set(o.id, { el, price, opt: o });
    });
  }
}
