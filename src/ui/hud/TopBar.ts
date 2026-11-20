import type { WorldState } from '../../core/types';
import { diffLabel } from '../../meta/progress';
import { audio } from '../audio';
import { fmtNum, h, setText } from '../dom';
import { G } from '../icons';
import type { GameCtx } from './context';
import { reduced, replay, Roll } from './motion';

export class TopBar {
  readonly el: HTMLElement;
  private lives: HTMLElement;
  private wave: HTMLElement;
  private livesBox: HTMLElement;
  private goldBox: HTMLElement;
  private waveBox: HTMLElement;
  private goldRoll: Roll;
  private scoreRoll: Roll;
  /** 金币入账时冒出的「+N」（短时间内的多笔合并显示） */
  private pop: HTMLElement;
  private popSum = 0;
  private popUntil = 0;
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
    this.wave = w.v;
    this.livesBox = l.box;
    this.goldBox = g.box;
    this.waveBox = w.box;
    this.goldRoll = new Roll(g.v, fmtNum, 320);
    this.scoreRoll = new Roll(s.v, fmtNum, 420);
    this.pop = h('span.stat-pop', { attrs: { 'aria-hidden': 'true' } });
    g.box.appendChild(this.pop);
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

  /** 金币飞入动画的落点（金币图标） */
  get goldIcon(): HTMLElement {
    return this.goldBox.firstElementChild as HTMLElement;
  }

  /** 一笔金币到账：图标弹一下 + 「+N」上浮（连续到账合并成一个数） */
  goldArrive(amount: number): void {
    if (amount <= 0 || reduced()) return;
    const now = performance.now();
    this.popSum = now < this.popUntil ? this.popSum + amount : amount;
    this.popUntil = now + 700;
    setText(this.pop, `+${fmtNum(this.popSum)}`);
    replay(this.pop, 'show', 900);
    replay(this.goldBox, 'bump', 320);
  }

  update(st: WorldState): void {
    const L = this.last;
    const now = performance.now();
    if (st.lives !== L.lives) {
      if (L.lives >= 0 && st.lives < L.lives) replay(this.livesBox, 'hurt', 520);
      else if (L.lives >= 0) replay(this.livesBox, 'up', 520);
      L.lives = st.lives;
      setText(this.lives, st.lives);
      this.livesBox.classList.toggle('low', st.lives <= Math.max(3, st.maxLives * 0.25));
    }
    const gold = Math.floor(st.gold);
    if (gold !== L.gold) {
      if (L.gold >= 0) replay(this.goldBox, gold > L.gold ? 'up' : 'down', 520);
      this.goldRoll.set(gold, now, L.gold < 0);
      L.gold = gold;
    }
    this.goldRoll.step(now);
    if (st.wave !== L.wave || st.totalWaves !== L.total) {
      if (L.wave >= 0 && st.wave > L.wave) replay(this.waveBox, 'flip', 560);
      L.wave = st.wave;
      L.total = st.totalWaves;
      setText(this.wave, st.totalWaves > 0 ? `${st.wave}/${st.totalWaves}` : String(st.wave));
    }
    const sc = Math.round(st.score);
    if (sc !== L.score) {
      this.scoreRoll.set(sc, now, L.score < 0);
      L.score = sc;
    }
    this.scoreRoll.step(now);
  }
}
