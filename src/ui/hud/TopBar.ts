import type { WorldState } from '../../core/types';
import { diffLabel } from '../../meta/progress';
import { audio } from '../audio';
import { fmtNum, h, setText } from '../dom';
import { G } from '../icons';
import type { GameCtx } from './context';

export class TopBar {
  readonly el: HTMLElement;
  private lives: HTMLElement;
  private gold: HTMLElement;
  private wave: HTMLElement;
  private score: HTMLElement;
  private livesBox: HTMLElement;
  private goldBox: HTMLElement;
  private last = { lives: -1, gold: -1, wave: -1, total: -1, score: -1 };
  readonly pauseBtn: HTMLButtonElement;

  constructor(ctx: GameCtx, onPause: () => void) {
    const stat = (glyph: string, cls: string, label: string) => {
      const v = h('b.stat-v');
      const box = h(`div.stat.${cls}`, { title: label, attrs: { 'aria-label': label } }, h('span.gi', { html: glyph }), v);
      return { box, v };
    };
    const l = stat(G.heart, 'lives', '生命');
    const g = stat(G.coin, 'gold', '金币');
    const w = stat(G.wave, 'wave', '波次');
    const s = stat(G.score, 'score', '得分');
    this.lives = l.v;
    this.gold = g.v;
    this.wave = w.v;
    this.score = s.v;
    this.livesBox = l.box;
    this.goldBox = g.box;
    this.pauseBtn = h<HTMLButtonElement>(
      'button.btn.icon-btn.pause-btn',
      {
        attrs: { 'aria-label': '暂停 (P)' },
        title: '暂停 (P)',
        onclick: () => {
          audio.play('click');
          onPause();
        },
      },
      h('span.gi', { html: G.pause }),
    );
    const o = ctx.opts;
    const diff = o.mode === 'custom' ? '自定义' : diffLabel(o.difficulty, o.abyssLevel ?? 1);
    this.el = h(
      'div.topbar',
      null,
      h('div.stats', null, l.box, g.box, w.box, s.box),
      h('span.diff-chip', { title: o.pure ? '纯净模式' : '' }, diff, o.pure ? ' · 纯净' : ''),
      this.pauseBtn,
    );
  }

  update(st: WorldState): void {
    const L = this.last;
    if (st.lives !== L.lives) {
      if (L.lives >= 0 && st.lives < L.lives) this.flash(this.livesBox, 'hurt');
      L.lives = st.lives;
      setText(this.lives, st.lives);
      this.livesBox.classList.toggle('low', st.lives <= Math.max(3, st.maxLives * 0.25));
    }
    const gold = Math.floor(st.gold);
    if (gold !== L.gold) {
      if (L.gold >= 0 && gold > L.gold) this.flash(this.goldBox, 'gain');
      L.gold = gold;
      setText(this.gold, fmtNum(gold));
    }
    if (st.wave !== L.wave || st.totalWaves !== L.total) {
      L.wave = st.wave;
      L.total = st.totalWaves;
      setText(this.wave, st.totalWaves > 0 ? `${st.wave}/${st.totalWaves}` : String(st.wave));
    }
    const sc = Math.round(st.score);
    if (sc !== L.score) {
      L.score = sc;
      setText(this.score, fmtNum(sc));
    }
  }

  private flash(el: HTMLElement, cls: string): void {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }
}
