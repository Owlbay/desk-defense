import type { WavePreview, WorldState } from '../../core/types';
import type { Speed } from '../../game/Session';
import { affixIcon, enemyIcon } from '../assets';
import { audio } from '../audio';
import { AFFIX_META, ENEMY_META } from '../coreMeta';
import { h, img, setText, toggle } from '../dom';
import { G } from '../icons';
import type { GameCtx } from './context';

const TAG: Record<WavePreview['tags'][number], { name: string; glyph: string }> = {
  boss: { name: 'Boss', glyph: G.skull },
  air: { name: '空袭', glyph: G.plane },
  rush: { name: '冲锋', glyph: G.rush },
};

export class WavePanel {
  readonly el: HTMLElement;
  readonly startBtn: HTMLButtonElement;
  private startLabel: HTMLElement;
  private startSub: HTMLElement;
  private speedBtn: HTMLButtonElement;
  private speedText: HTMLElement;
  private preview: HTMLElement;
  private previewTitle: HTMLElement;
  private sig = '';

  constructor(private ctx: GameCtx) {
    this.preview = h('div.preview-list');
    this.previewTitle = h('span.preview-title');
    this.startLabel = h('span.act-label');
    this.startSub = h('span.act-sub');
    this.startBtn = h<HTMLButtonElement>(
      'button.btn.primary.start-btn',
      { title: '开始下一波（空格）', onclick: () => this.start() },
      h('span.gi', { html: G.play }),
      h('span.act-text', null, this.startLabel, this.startSub),
    );
    this.speedText = h('b');
    this.speedBtn = h<HTMLButtonElement>(
      'button.btn.speed-btn',
      { title: '游戏速度（F）', attrs: { 'aria-label': '切换速度' }, onclick: () => this.cycleSpeed() },
      h('span.gi', { html: G.fast }),
      this.speedText,
    );
    this.el = h(
      'div.wavepanel',
      null,
      h('div.preview', null, this.previewTitle, this.preview),
      h('div.wave-actions', null, this.startBtn, this.speedBtn),
    );
    this.syncSpeed();
  }

  start(): void {
    const st = this.ctx.world.state;
    if (st.phase !== 'build' && st.phase !== 'wave') return;
    if (this.startBtn.disabled) {
      audio.play('error');
      return;
    }
    this.ctx.cmd({ type: 'startWave' });
  }

  cycleSpeed(): void {
    const s = this.ctx.session;
    const next = ((s.speed % 3) + 1) as Speed;
    s.setSpeed(next);
    audio.play('click');
    this.syncSpeed();
  }

  syncSpeed(): void {
    const sp = this.ctx.session.speed;
    setText(this.speedText, `${sp}×`);
    this.speedBtn.dataset.speed = String(sp);
  }

  update(st: WorldState): void {
    const nw = st.nextWave;
    const lastWave = st.totalWaves > 0 && st.wave >= st.totalWaves;
    const sig = `${nw.wave}|${nw.tags.join(',')}|${nw.groups.map((g) => `${g.enemy}${g.count}${g.elite}${g.affixes.join('')}`).join(';')}|${lastWave}`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.renderPreview(nw, lastWave);
    }
    // 开波按钮
    let label = '';
    let sub = '';
    let disabled = false;
    if (st.phase === 'build') {
      label = st.wave === 0 ? '开始第 1 波' : `开始第 ${nw.wave} 波`;
    } else if (st.phase === 'wave') {
      if (lastWave) {
        label = '最后一波';
        disabled = true;
      } else {
        label = '提前开波';
        sub = nw.earlyBonus > 0 ? `+${nw.earlyBonus} 金` : '';
      }
    } else {
      label = st.phase === 'perk' ? '选择增益' : '已结束';
      disabled = true;
    }
    setText(this.startLabel, label);
    setText(this.startSub, sub);
    this.startBtn.disabled = disabled;
    toggle(this.startBtn, 'early', st.phase === 'wave' && !disabled);
    toggle(this.startBtn, 'pulse', st.phase === 'build');
  }

  private renderPreview(nw: WavePreview, lastWave: boolean): void {
    if (lastWave) {
      this.previewTitle.textContent = '最后一波';
      this.preview.replaceChildren(h('span.muted.small', null, '撑住这一波就胜利了！'));
      return;
    }
    this.previewTitle.textContent = `下一波 · 第 ${nw.wave} 波`;
    const items: HTMLElement[] = [];
    for (const t of nw.tags) items.push(h(`span.wave-tag.${t}`, null, h('span.gi', { html: TAG[t].glyph }), TAG[t].name));
    for (const g of nw.groups) {
      const name = ENEMY_META[g.enemy]?.name ?? g.enemy;
      const affixNames = g.affixes.map((a) => AFFIX_META[a]?.name ?? a).join('、');
      items.push(
        h(
          `span.pv-group${g.elite > 0 ? '.elite' : ''}`,
          { title: `${name} ×${g.count}${g.elite ? `（精英 ${g.elite}${affixNames ? '：' + affixNames : ''}）` : ''}` },
          img(enemyIcon(g.enemy), 'ico'),
          h('b', null, `×${g.count}`),
          g.affixes.length ? h('span.pv-affixes', null, g.affixes.slice(0, 4).map((a) => img(affixIcon(a), 'ico affix'))) : null,
        ),
      );
    }
    if (items.length === 0) items.push(h('span.muted.small', null, '—'));
    this.preview.replaceChildren(...items);
  }
}
