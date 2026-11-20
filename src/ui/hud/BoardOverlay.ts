import type { CrateChoice, GameEvent, RandomEventState, WavePreview, WorldState } from '../../core/types';
import { enemyIcon } from '../assets';
import { ENEMY_META } from '../coreMeta';
import { fmtNum, h, img, setText } from '../dom';
import { G } from '../icons';

type RandomEv = Extract<GameEvent, { type: 'randomEvent' }>;
const TONE_GLYPH: Record<RandomEventState['tone'], string> = { bad: G.warn, good: G.gift, neutral: G.swirl };

interface EventCard {
  el: HTMLElement;
  secs: HTMLElement;
  phase: 'warn' | 'start';
  collapseAt: number;
}

interface Chip {
  el: HTMLElement;
  secs: HTMLElement;
}

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
  private eventHost: HTMLElement;
  private chipBox: HTMLElement;
  private crateBox: HTMLElement;
  private cards = new Map<number, EventCard>();
  private chips = new Map<number, Chip>();
  private crateUid: number | null = null;
  /** 补给箱三选一：选择回调（GameScreen 设置） */
  onCrate: ((option: string, name: string) => void) | null = null;

  constructor() {
    this.bossBox = h('div.boss-bars');
    this.eventHost = h('div.event-banners', { attrs: { 'aria-live': 'polite' } });
    this.chipBox = h('div.event-chips');
    this.crateBox = h('div.crate-host');
    this.toastBox = h('div.toasts', { attrs: { 'aria-live': 'polite' } });
    this.bannerBox = h('div.banner-host');
    this.hintBox = h('div.board-hint-host');
    this.el = h(
      'div.board-overlay',
      null,
      h('div.overlay-top', null, this.bossBox, this.eventHost),
      this.chipBox,
      this.toastBox,
      this.bannerBox,
      this.crateBox,
      this.hintBox,
    );
  }

  /** 当前显示中的事件横幅（新手提示定位用） */
  eventsEl(): HTMLElement | null {
    return this.eventHost.childElementCount > 0 ? this.eventHost : this.chipBox.childElementCount > 0 ? this.chipBox : null;
  }

  // ───────────── 随机事件（文档 09 §3.3） ─────────────

  /** 事件横幅：预警 / 开始时从顶部滑下，3 秒后缩进状态栏 */
  randomEvent(ev: RandomEv): void {
    if (ev.phase === 'end') {
      this.dropCard(ev.uid);
      return;
    }
    this.dropCard(ev.uid);
    const secs = h('span.ev-secs');
    const el = h(
      `div.event-card.tone-${ev.tone}.ph-${ev.phase}`,
      { attrs: { role: 'status' } },
      h('span.ev-ico', { html: TONE_GLYPH[ev.tone] ?? G.warn }),
      h('div.ev-main', null, h('div.ev-name', null, h('b', null, ev.name), h('span.ev-phase', null, ev.phase === 'warn' ? '即将发生' : '发生了')), h('div.ev-desc', null, ev.desc)),
      secs,
    );
    while (this.cards.size >= 2) {
      const first = this.cards.keys().next().value;
      if (first === undefined) break;
      this.dropCard(first);
    }
    this.eventHost.appendChild(el);
    this.cards.set(ev.uid, { el, secs, phase: ev.phase, collapseAt: performance.now() + 3000 });
  }

  private dropCard(uid: number): void {
    const c = this.cards.get(uid);
    if (!c) return;
    this.cards.delete(uid);
    c.el.classList.add('collapse');
    setTimeout(() => c.el.remove(), 380);
  }

  private updateEvents(st: WorldState): void {
    const now = performance.now();
    for (const [uid, c] of this.cards) {
      const e = st.events.find((x) => x.uid === uid);
      if (!e || now >= c.collapseAt) {
        this.dropCard(uid);
        continue;
      }
      if (e.phase === 'warn') setText(c.secs, `${Math.max(0, Math.ceil(e.startsAt - st.time))}s`);
      else if (e.phase === 'active' && e.endsAt > st.time) setText(c.secs, `${Math.ceil(e.endsAt - st.time)}s`);
      else setText(c.secs, '');
    }
    // 状态栏小图标：进行中的持续型事件
    const seen = new Set<number>();
    for (const e of st.events) {
      if (e.phase !== 'active' || e.endsAt <= e.startsAt || e.endsAt <= st.time) continue;
      if (this.cards.has(e.uid)) continue; // 横幅还在
      seen.add(e.uid);
      let chip = this.chips.get(e.uid);
      if (!chip) {
        const secs = h('b');
        const el = h(`div.event-chip.tone-${e.tone}`, { title: `${e.name}：${e.desc}` }, h('span.gi', { html: TONE_GLYPH[e.tone] ?? G.warn }), h('span.chip-name', null, e.name), secs);
        this.chipBox.appendChild(el);
        chip = { el, secs };
        this.chips.set(e.uid, chip);
      }
      setText(chip.secs, `${Math.ceil(e.endsAt - st.time)}s`);
    }
    for (const [uid, chip] of this.chips) {
      if (!seen.has(uid)) {
        chip.el.remove();
        this.chips.delete(uid);
      }
    }
  }

  // ───────────── 补给箱三选一（不暂停） ─────────────

  private updateCrate(c: CrateChoice | null): void {
    const uid = c ? c.uid : null;
    if (uid === this.crateUid) return;
    this.crateUid = uid;
    if (!c) {
      const old = this.crateBox.firstElementChild;
      if (old) {
        old.classList.add('out');
        setTimeout(() => old.remove(), 220);
      }
      return;
    }
    const card = h(
      'div.crate-card',
      { attrs: { role: 'dialog', 'aria-label': '补给箱：选一个奖励' } },
      h('div.crate-head', null, h('span.gi', { html: G.crate }), h('b', null, '补给箱'), h('small.muted', null, '选一个奖励')),
      h(
        'div.crate-opts',
        null,
        c.options.map((o, i) =>
          h(
            'button.crate-opt',
            {
              style: `--i:${i}`,
              title: o.desc,
              onclick: () => this.onCrate?.(o.id, o.name),
            },
            h('b', null, o.name),
            h('small', null, o.desc),
          ),
        ),
      ),
    );
    this.crateBox.replaceChildren(card);
  }

  update(st: WorldState): void {
    this.updateEvents(st);
    this.updateCrate(st.crateChoice ?? null);
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
