import type { RandomEventState, WavePreview, WavePreviewGroup, WorldState } from '../../core/types';
import type { Speed } from '../../game/Session';
import { getLocale, t } from '../../i18n';
import { affixIcon, enemyIcon } from '../assets';
import { audio } from '../audio';
import { AFFIX_META, ENEMY_META, spawnerName } from '../coreMeta';
import { h, img, setText, toggle } from '../dom';
import { G } from '../icons';
import type { GameCtx } from './context';
import { replay } from './motion';

const TAG: Record<WavePreview['tags'][number], { key: string; glyph: string }> = {
  boss: { key: 'ui.wave.tagBoss', glyph: G.skull },
  air: { key: 'ui.wave.tagAir', glyph: G.plane },
  rush: { key: 'ui.wave.tagRush', glyph: G.rush },
};

export const TONE_GLYPH: Record<RandomEventState['tone'], string> = { bad: G.warn, good: G.gift, neutral: G.swirl };

interface UpcomingRow {
  el: HTMLElement;
  secs: HTMLElement;
}

export class WavePanel {
  readonly el: HTMLElement;
  readonly startBtn: HTMLButtonElement;
  private startIco: HTMLElement;
  private ring: HTMLElement;
  private startLabel: HTMLElement;
  private startSub: HTMLElement;
  private bossHint: HTMLElement;
  private speedBtn: HTMLButtonElement;
  private speedText: HTMLElement;
  private preview: HTMLElement;
  private previewTitle: HTMLElement;
  private upcoming: HTMLElement;
  private upRows = new Map<number, UpcomingRow>();
  private sig = '';
  /** 本轮倒计时总长（用于进度环） */
  private cdTotal = 0;
  private lastNextAt: number | null = null;
  private counting = false;
  private lastP = -1;
  private locale = '';

  constructor(private ctx: GameCtx) {
    this.preview = h('div.preview-list');
    this.previewTitle = h('span.preview-title');
    this.upcoming = h('div.upcoming');
    this.upcoming.hidden = true;
    this.startLabel = h('span.act-label');
    this.startSub = h('span.act-sub');
    this.startIco = h('span.gi', { html: G.play });
    this.ring = h('span.count-ring');
    this.ring.hidden = true;
    this.bossHint = h('span.boss-hint', null, h('span.gi', { html: G.skull }));
    this.bossHint.hidden = true;
    this.startBtn = h<HTMLButtonElement>(
      'button.btn.primary.start-btn',
      { onclick: () => this.start() },
      this.startIco,
      this.ring,
      h('span.act-text', null, this.startLabel, this.startSub),
      this.bossHint,
    );
    this.speedText = h('b');
    this.speedBtn = h<HTMLButtonElement>(
      'button.btn.speed-btn',
      { onclick: () => this.cycleSpeed() },
      h('span.gi', { html: G.fast }),
      this.speedText,
    );
    this.el = h(
      'div.wavepanel',
      null,
      h('div.preview', null, this.previewTitle, this.preview, this.upcoming),
      h('div.wave-actions', null, this.startBtn, this.speedBtn),
    );
    this.syncSpeed();
    this.syncLocale();
  }

  /** 静态文字（提示 / 无障碍标签）；语言切换后预览与「即将发生」也按新语言重建 */
  private syncLocale(): void {
    if (this.locale === getLocale()) return;
    this.locale = getLocale();
    this.upcoming.setAttribute('aria-label', t('ui.wave.upcomingAria'));
    this.bossHint.title = t('ui.wave.bossNext');
    this.startBtn.title = t('ui.wave.startTip');
    this.speedBtn.title = t('ui.wave.speedTip');
    this.speedBtn.setAttribute('aria-label', t('ui.wave.speedAria'));
    this.sig = '';
    for (const row of this.upRows.values()) row.el.remove();
    this.upRows.clear();
    this.upcoming.replaceChildren();
    this.upcoming.hidden = true;
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

  /** 自动开波倒计时剩 3/2/1 秒：按钮闪一下（提示音由 audio 处理） */
  onCountdown(secondsLeft: number): void {
    replay(this.startBtn, 'blink', 520);
    this.startBtn.dataset.count = String(secondsLeft);
  }

  update(st: WorldState): void {
    this.syncLocale();
    const nw = st.nextWave;
    const lastWave = st.totalWaves > 0 && st.wave >= st.totalWaves;
    const spSig = st.spawners.map((s) => `${s.id}${s.kind}`).join(',');
    const sig = `${nw.wave}|${nw.tags.join(',')}|${nw.groups.map((g) => `${g.spawner}:${g.enemy}${g.count}${g.elite}${g.affixes.join('')}`).join(';')}|${lastWave}|${spSig}`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.renderPreview(st, nw, lastWave);
    }
    this.updateUpcoming(st);

    // 开波按钮
    const aw = st.autoWave;
    const auto = !!aw?.enabled;
    const started = auto && (aw.started || st.wave > 0);
    let label: string;
    let sub = '';
    let disabled = false;
    let counting = false;
    let blocked = false;
    let remain = 0;
    if (aw?.nextAt == null) {
      this.cdTotal = 0;
      this.lastNextAt = null;
    }
    if (st.phase === 'perk') {
      label = t('ui.wave.choosePerk');
      sub = auto && aw.nextAt != null ? t('ui.wave.countPaused') : '';
      disabled = true;
    } else if (st.phase === 'won' || st.phase === 'lost') {
      label = t('ui.wave.ended');
      disabled = true;
    } else if (lastWave && st.phase === 'wave') {
      label = t('ui.wave.lastWave');
      disabled = true;
    } else if (started && aw.blocked) {
      label = t('ui.wave.tooMany');
      sub = t('ui.wave.countPaused');
      disabled = true;
      blocked = true;
    } else if (started && aw.nextAt != null) {
      remain = Math.max(0, aw.nextAt - st.time);
      if (this.lastNextAt !== aw.nextAt) {
        this.lastNextAt = aw.nextAt;
        this.cdTotal = Math.max(this.cdTotal, remain);
      }
      counting = true;
      label = t('ui.wave.nextIn', { n: Math.ceil(remain) });
      sub = nw.earlyBonus > 0 ? t('ui.wave.earlyBonus', { n: nw.earlyBonus }) : t('ui.wave.tapEarly');
    } else if (st.phase === 'build') {
      if (st.wave === 0) label = auto ? t('ui.wave.start') : t('ui.wave.startN', { n: 1 });
      else label = t('ui.wave.startN', { n: nw.wave });
      if (st.wave === 0 && auto) sub = t('ui.wave.autoAfter');
    } else {
      label = t('ui.wave.early');
      sub = nw.earlyBonus > 0 ? t('ui.wave.goldPlus', { n: nw.earlyBonus }) : '';
    }
    setText(this.startLabel, label);
    setText(this.startSub, sub);
    this.startBtn.disabled = disabled;
    toggle(this.startBtn, 'early', !disabled && (st.phase === 'wave' || counting));
    toggle(this.startBtn, 'pulse', st.phase === 'build' && !counting);
    toggle(this.startBtn, 'counting', counting);
    toggle(this.startBtn, 'urgent', counting && remain <= 3.05);
    toggle(this.startBtn, 'blocked', blocked);
    this.ring.hidden = !counting;
    this.startIco.hidden = counting;
    this.counting = counting;
    if (counting) this.setRing(remain);
    else this.lastP = -1;
    const bossNext = !lastWave && nw.tags.includes('boss') && st.phase !== 'won' && st.phase !== 'lost';
    this.bossHint.hidden = !bossNext;
    toggle(this.startBtn, 'boss-next', bossNext);
    this.startBtn.title = bossNext ? t('ui.wave.bossTip') : counting ? t('ui.wave.earlyTip') : t('ui.wave.startTip');
  }

  /** 每帧调用：倒计时环平滑走（只写一个 CSS 变量，其余内容仍按低频刷新） */
  tickFast(st: WorldState): void {
    if (!this.counting) return;
    const at = st.autoWave?.nextAt;
    if (at == null || st.phase === 'perk') return;
    this.setRing(Math.max(0, at - st.time));
  }

  private setRing(remain: number): void {
    const p = this.cdTotal > 0 ? Math.max(0, Math.min(1, remain / this.cdTotal)) : 0;
    if (Math.abs(p - this.lastP) < 0.0015) return;
    this.lastP = p;
    this.ring.style.setProperty('--p', p.toFixed(4));
  }

  /** 预警中的事件：「即将发生」时间轴 */
  private updateUpcoming(st: WorldState): void {
    const warns = st.events.filter((e) => e.phase === 'warn');
    const seen = new Set<number>();
    for (const e of warns) {
      seen.add(e.uid);
      let row = this.upRows.get(e.uid);
      if (!row) {
        const secs = h('b.up-secs');
        const el = h(
          `span.up-event.tone-${e.tone}`,
          { title: e.desc },
          h('span.gi', { html: TONE_GLYPH[e.tone] ?? G.warn }),
          h('span.up-name', null, e.name),
          secs,
        );
        this.upcoming.appendChild(el);
        row = { el, secs };
        this.upRows.set(e.uid, row);
      }
      setText(row.secs, `${Math.max(0, Math.ceil(e.startsAt - st.time))}s`);
    }
    for (const [uid, row] of this.upRows) {
      if (!seen.has(uid)) {
        row.el.remove();
        this.upRows.delete(uid);
      }
    }
    const show = this.upRows.size > 0;
    if (this.upcoming.hidden === show) {
      this.upcoming.hidden = !show;
      if (show) this.upcoming.prepend(h('span.up-title', null, t('ui.wave.upcoming')));
      else this.upcoming.replaceChildren();
    }
  }

  private renderPreview(st: WorldState, nw: WavePreview, lastWave: boolean): void {
    if (lastWave) {
      this.previewTitle.textContent = t('ui.wave.lastWave');
      this.preview.replaceChildren(h('span.muted.small', null, t('ui.wave.lastHint')));
      return;
    }
    this.previewTitle.textContent = t('ui.wave.nextTitle', { n: nw.wave });
    const items: HTMLElement[] = [];
    for (const tag of nw.tags) items.push(h(`span.wave-tag.${tag}`, null, h('span.gi', { html: TAG[tag].glyph }), t(TAG[tag].key)));
    // 按出生点分组（文档 09 §1.2）
    const bySpawner = new Map<string, WavePreviewGroup[]>();
    for (const g of nw.groups) {
      const k = g.spawner ?? '';
      const arr = bySpawner.get(k);
      if (arr) arr.push(g);
      else bySpawner.set(k, [g]);
    }
    const single = bySpawner.size <= 1;
    for (const [sp, groups] of bySpawner) {
      const spState = st.spawners.find((s) => s.id === sp);
      const showLabel = sp !== '' && (!single || sp === '*' || (spState !== undefined && spState.kind !== 'edge'));
      const kind = sp === '*' ? 'split' : (spState?.kind ?? 'edge');
      const chips = groups.map((g) => this.groupChip(g));
      if (showLabel) {
        items.push(h(`span.pv-spawner.k-${kind}`, null, h('span.pv-sp-name', null, spawnerName(sp, st.spawners)), ...chips));
      } else items.push(...chips);
    }
    if (items.length === 0) items.push(h('span.muted.small', null, '—'));
    // 预览变化：小卡片依次弹入
    items.forEach((it, k) => {
      it.classList.add('pv-in');
      it.style.setProperty('--i', String(Math.min(k, 8)));
    });
    this.preview.replaceChildren(...items);
  }

  private groupChip(g: WavePreviewGroup): HTMLElement {
    const name = ENEMY_META[g.enemy]?.name ?? g.enemy;
    const affixNames = g.affixes.map((a) => AFFIX_META[a]?.name ?? a).join(t('ui.wave.listSep'));
    return h(
      `span.pv-group${g.elite > 0 ? '.elite' : ''}`,
      {
        title: g.elite
          ? affixNames
            ? t('ui.wave.groupEliteAffix', { name, n: g.count, elite: g.elite, affixes: affixNames })
            : t('ui.wave.groupElite', { name, n: g.count, elite: g.elite })
          : `${name} ×${g.count}`,
      },
      img(enemyIcon(g.enemy), 'ico'),
      h('b', null, `×${g.count}`),
      g.affixes.length
        ? h(
            'span.pv-affixes',
            null,
            g.affixes.slice(0, 4).map((a) => img(affixIcon(a), 'ico affix')),
          )
        : null,
    );
  }
}
