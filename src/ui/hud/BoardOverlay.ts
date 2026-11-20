import type { WavePreview, WorldState } from '../../core/types';
import { enemyIcon } from '../assets';
import { ENEMY_META } from '../coreMeta';
import { fmtNum, h, img, setText } from '../dom';
import { G } from '../icons';

interface BossRow {
  el: HTMLElement;
  hp: HTMLElement;
  shield: HTMLElement;
  text: HTMLElement;
}

/** 棋盘上方叠加层：Boss 血条、提示、开波横幅 */
export class BoardOverlay {
  readonly el: HTMLElement;
  private bossBox: HTMLElement;
  private toastBox: HTMLElement;
  private bannerBox: HTMLElement;
  readonly hintBox: HTMLElement;
  private bosses = new Map<number, BossRow>();
  private recent = new Map<string, number>();

  constructor() {
    this.bossBox = h('div.boss-bars');
    this.toastBox = h('div.toasts', { attrs: { 'aria-live': 'polite' } });
    this.bannerBox = h('div.banner-host');
    this.hintBox = h('div.board-hint-host');
    this.el = h('div.board-overlay', null, this.bossBox, this.toastBox, this.bannerBox, this.hintBox);
  }

  update(st: WorldState): void {
    const seen = new Set<number>();
    for (const uid of st.bossUids) {
      const e = st.enemies.find((x) => x.uid === uid);
      if (!e) continue;
      seen.add(uid);
      let row = this.bosses.get(uid);
      if (!row) {
        const hp = h('span.boss-hp');
        const shield = h('span.boss-shield');
        const text = h('span.boss-num');
        const el = h(
          'div.boss-row',
          null,
          img(enemyIcon(e.id), 'ico'),
          h('div.boss-main', null, h('div.boss-name', null, ENEMY_META[e.id]?.name ?? e.id, text), h('div.boss-bar', null, hp, shield)),
        );
        this.bossBox.appendChild(el);
        row = { el, hp, shield, text };
        this.bosses.set(uid, row);
      }
      const total = Math.max(1, e.maxHp + e.maxShield);
      row.hp.style.width = `${Math.max(0, (e.hp / total) * 100).toFixed(2)}%`;
      row.shield.style.left = row.hp.style.width;
      row.shield.style.width = `${Math.max(0, (e.shield / total) * 100).toFixed(2)}%`;
      setText(row.text, e.shield > 0 ? `${fmtNum(e.hp)} +${fmtNum(e.shield)}` : fmtNum(e.hp));
    }
    for (const [uid, row] of this.bosses) {
      if (!seen.has(uid)) {
        row.el.classList.add('out');
        setTimeout(() => row.el.remove(), 300);
        this.bosses.delete(uid);
      }
    }
  }

  toast(text: string, tone: 'info' | 'warn' | 'good' = 'info'): void {
    const now = performance.now();
    const last = this.recent.get(text) ?? 0;
    if (now - last < 900) return; // 去重
    this.recent.set(text, now);
    while (this.toastBox.children.length >= 3) this.toastBox.firstElementChild?.remove();
    const t = h(`div.toast.tone-${tone}`, null, text);
    this.toastBox.appendChild(t);
    setTimeout(() => t.classList.add('out'), 2000);
    setTimeout(() => t.remove(), 2400);
  }

  banner(wave: number, tags: WavePreview['tags'], total: number): void {
    const boss = tags.includes('boss');
    const sub = tags
      .map((t) => (t === 'boss' ? 'Boss 来袭' : t === 'air' ? '空袭波 · 小心飞行敌人' : '冲锋波 · 敌人更快'))
      .join(' · ');
    const el = h(
      `div.banner${boss ? '.boss' : ''}`,
      null,
      boss ? h('span.gi.banner-ico', { html: G.skull }) : null,
      h('div.banner-title', null, total > 0 ? `第 ${wave} / ${total} 波` : `第 ${wave} 波`),
      sub ? h('div.banner-sub', null, sub) : null,
    );
    this.bannerBox.replaceChildren(el);
    setTimeout(() => el.classList.add('out'), boss ? 2000 : 1300);
    setTimeout(() => el.remove(), boss ? 2500 : 1800);
  }

  bigText(title: string, sub: string, cls: string): void {
    const el = h(`div.banner.${cls}`, null, h('div.banner-title', null, title), h('div.banner-sub', null, sub));
    this.bannerBox.replaceChildren(el);
    setTimeout(() => el.classList.add('out'), 1600);
    setTimeout(() => el.remove(), 2100);
  }
}
