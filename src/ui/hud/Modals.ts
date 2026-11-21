import type { PerkCard, TowerState, WorldState } from '../../core/types';
import { ui } from '../../game/UiStore';
import type { Rewards } from '../../meta/progress';
import { towerIcon } from '../assets';
import { audio } from '../audio';
import { eventMeta, TOWER_META } from '../coreMeta';
import { TOWERS } from '../../config/towers';
import { getLocale, onLocaleChange, t } from '../../i18n';
import { copyText, fmtNum, h, img, setText } from '../dom';
import { G } from '../icons';
import { settingsPanel } from '../screens/settings';
import { RARITY_NAME, type GameCtx } from './context';
import { runSummary } from '../screens/menu';
import { countUp } from './motion';
import { starRow } from '../screens/common';
import { mountOnlineSubmit } from '../online/submit';
import { isAiAssisted, usedAi } from '../../meta/aiAssist';

function overlay(cls: string, ...children: HTMLElement[]): HTMLElement {
  return h(`div.overlay.${cls}`, null, ...children);
}

// ───────────── 局内增益三选一 ─────────────

export class PerkModal {
  readonly el: HTMLElement;
  private cards: HTMLElement;
  private reroll: HTMLButtonElement;
  private rerollText: HTMLElement;
  private sig = '';
  private visible = false;
  private locale = getLocale();
  private dialog: HTMLElement;
  private titleEl: HTMLElement;
  private noteEl: HTMLElement;

  constructor(
    private ctx: GameCtx,
    /** 需要选塔的增益：交给对局界面处理选塔与分支 */
    private onNeedsTower: (card: PerkCard) => void,
    /** 正在选塔时隐藏卡片 */
    private suppressed: () => boolean,
  ) {
    this.cards = h('div.perk-cards');
    this.rerollText = h('span');
    this.reroll = h<HTMLButtonElement>(
      'button.btn.reroll',
      {
        onclick: () => {
          const r = this.ctx.cmd({ type: 'rerollPerks' });
          if (r.ok) audio.play('perkOffer');
        },
      },
      h('span.gi', { html: G.refresh }),
      this.rerollText,
    );
    this.titleEl = h('h2.perk-title');
    this.noteEl = h('p.muted.center');
    this.dialog = h(
      'div.perk-dialog',
      { attrs: { role: 'dialog', 'aria-modal': 'true' } },
      this.titleEl,
      this.noteEl,
      this.cards,
      h('div.row.center', null, this.reroll),
    );
    this.el = overlay('perk-overlay', this.dialog);
    this.setStatic();
    this.el.hidden = true;
  }

  private setStatic(): void {
    this.dialog.setAttribute('aria-label', t('ui.modal.perkAria'));
    setText(this.titleEl, t('ui.modal.perkTitle'));
    setText(this.noteEl, t('ui.modal.perkNote'));
  }

  get isOpen(): boolean {
    return this.visible;
  }

  update(st: WorldState): void {
    const show = st.phase === 'perk' && !!st.perkChoices && st.perkChoices.length > 0 && !ui.state.perkTargeting && !this.suppressed();
    if (show !== this.visible) {
      this.visible = show;
      this.el.hidden = !show;
    }
    if (this.locale !== getLocale()) {
      // 语言切换：静态文字就地更新，卡片按新语言重建
      this.locale = getLocale();
      this.setStatic();
      this.sig = '';
    }
    if (!show || !st.perkChoices) return;
    const sig = st.perkChoices.map((c) => c.id).join(',');
    if (sig !== this.sig) {
      this.sig = sig;
      this.renderCards(st.perkChoices);
    }
    const cost = st.perkRerollCost;
    setText(this.rerollText, cost <= 0 ? t('ui.modal.rerollFree') : t('ui.modal.reroll', { n: fmtNum(cost) }));
    this.reroll.classList.toggle('poor', cost > st.gold);
  }

  private renderCards(cards: PerkCard[]): void {
    this.cards.replaceChildren(
      ...cards.map((c, i) =>
        h(
          `button.perk-card.r-${c.rarity}`,
          { style: `--i:${i}`, onclick: () => this.choose(c) },
          h('span.perk-shine', { attrs: { 'aria-hidden': 'true' } }),
          h('span.perk-rarity', null, RARITY_NAME[c.rarity]),
          h('h3', null, c.name),
          h('p', null, c.desc),
          c.needsTower ? h('span.perk-note', null, h('span.gi', { html: G.target }), t('ui.modal.needsTower')) : null,
        ),
      ),
    );
  }

  private choose(c: PerkCard): void {
    if (c.needsTower) {
      audio.play('select');
      this.onNeedsTower(c);
      return;
    }
    this.ctx.cmd({ type: 'choosePerk', id: c.id });
  }
}

// ───────────── 传奇分支选择 ─────────────

export interface BranchOptions {
  /** 来自增益「传奇在望」：直接升到 Lv10，发送 choosePerk */
  perkId?: string;
}

export function branchModal(ctx: GameCtx, uid: number, onClose: (done: boolean) => void, o: BranchOptions = {}): HTMLElement | null {
  const info = ctx.world.getTowerInfo(uid);
  if (!info) return null;
  const perk = o.perkId !== undefined;
  if (!perk && (!info.needsBranch || !info.branches)) return null;
  const def = TOWERS[info.id];
  const names = info.branches ?? (def ? { A: def.A, B: def.B } : null);
  if (!names) return null;
  const close = (done: boolean) => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 160);
    onClose(done);
  };
  const card = (b: 'A' | 'B') => {
    const br = names[b];
    return h(
      `button.branch-card.br-${b}${perk || info.canAffordUpgrade ? '' : '.poor'}`,
      {
        style: `--i:${b === 'A' ? 0 : 1}`,
        onclick: () => {
          const r = perk ? ctx.cmd({ type: 'choosePerk', id: o.perkId!, uid, branch: b }) : ctx.cmd({ type: 'upgrade', uid, branch: b });
          if (r.ok) close(true);
        },
      },
      h('span.branch-tag', null, t('ui.modal.legendBranch', { b })),
      img(towerIcon(info.id, 4, b), 'ico branch-ico'),
      h('h3', null, br.name),
      h('p', null, br.desc),
    );
  };
  const el = overlay(
    'branch-overlay',
    h(
      'div.dialog.card.branch-dialog',
      { attrs: { role: 'dialog', 'aria-modal': 'true' } },
      h('h2', null, t('ui.modal.branchTitle', { name: info.name })),
      h(
        'p.muted',
        null,
        perk ? t('ui.modal.branchPerk', { level: info.level }) : t('ui.modal.branchCost', { n: fmtNum(info.upgradeCost ?? 0) }),
      ),
      h('div.branch-cards', null, card('A'), card('B')),
      h(
        'div.row.end',
        null,
        h('button.btn', { onclick: () => (audio.play('click'), close(false)) }, perk ? t('ui.modal.otherTower') : t('ui.modal.thinkAgain')),
      ),
    ),
  );
  el.addEventListener('click', (e) => e.target === el && close(false));
  return el;
}

// ───────────── 暂停菜单 ─────────────

export interface PauseHandlers {
  resume(): void;
  restart(): void;
  quit(): void;
}

type PauseView = 'main' | 'settings' | 'history';

export function pauseMenu(ctx: GameCtx, hd: PauseHandlers): HTMLElement {
  let dialog = pauseDialog(ctx, hd, 'main');
  const el = overlay('pause-overlay', dialog);
  // 在暂停菜单的设置里切换语言：按新语言重建菜单，停留在原来的子页面（并把焦点放回原来的按钮）
  const off = onLocaleChange(() => {
    if (!el.isConnected) return void off();
    const view: PauseView = !dialog.querySelector<HTMLElement>('.pause-settings')?.hidden
      ? 'settings'
      : !dialog.querySelector<HTMLElement>('.pause-history')?.hidden
        ? 'history'
        : 'main';
    const focusKey =
      document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement)
        ? document.activeElement.dataset.focusKey
        : undefined;
    const next = pauseDialog(ctx, hd, view);
    dialog.replaceWith(next);
    dialog = next;
    if (focusKey) next.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`)?.focus({ preventScroll: true });
  });
  return el;
}

function pauseDialog(ctx: GameCtx, hd: PauseHandlers, view: PauseView): HTMLElement {
  const st = ctx.world.state;
  const seed = st.seed;
  const main = h('div.pause-main');
  const confirmBox = h('div.pause-confirm');
  confirmBox.hidden = true;
  const settingsBox = h('div.pause-settings');
  settingsBox.hidden = true;
  const historyBox = h('div.pause-history');
  historyBox.hidden = true;
  const TONE_GLYPH = { bad: G.warn, good: G.gift, neutral: G.swirl } as const;
  const log = st.eventLog ?? [];

  const ask = (title: string, text: string, okText: string, fn: () => void) => {
    main.hidden = true;
    confirmBox.hidden = false;
    confirmBox.replaceChildren(
      h('h2', null, title),
      h('p.muted', null, text),
      h(
        'div.row.end',
        null,
        h('button.btn', { onclick: () => ((confirmBox.hidden = true), (main.hidden = false), audio.play('click')) }, t('common.cancel')),
        h('button.btn.danger', { onclick: fn }, okText),
      ),
    );
  };

  const midNote = st.wave > 0 ? t('ui.modal.quitSaved') : t('ui.modal.quitUnsaved');

  main.append(
    h('h2.pause-title', null, t('ui.modal.paused')),
    h('p.muted.center', null, runSummary(ctx.opts)),
    h('button.btn.primary.big', { onclick: hd.resume }, h('span.gi', { html: G.play }), t('ui.modal.resume')),
    h(
      'button.btn.big',
      {
        onclick: () => {
          audio.play('click');
          ask(t('ui.modal.restartTitle'), t('ui.modal.restartText'), t('ui.modal.restart'), hd.restart);
        },
      },
      h('span.gi', { html: G.refresh }),
      t('ui.modal.restart'),
    ),
    h(
      'button.btn.big',
      {
        onclick: () => {
          audio.play('click');
          main.hidden = true;
          settingsBox.hidden = false;
        },
      },
      h('span.gi', { html: G.gear }),
      t('ui.modal.settings'),
    ),
    ...(log.length > 0
      ? [
          h(
            'button.btn.big',
            {
              onclick: () => {
                audio.play('click');
                main.hidden = true;
                historyBox.hidden = false;
              },
            },
            h('span.gi', { html: G.list }),
            t('ui.modal.eventLogN', { n: log.length }),
          ),
        ]
      : []),
    h(
      'button.btn.big',
      {
        onclick: () => {
          audio.play('click');
          ask(t('ui.modal.quitTitle'), midNote, t('ui.modal.quit'), hd.quit);
        },
      },
      h('span.gi', { html: G.back }),
      t('ui.modal.quitToMenu'),
    ),
    h(
      'div.seed-row',
      null,
      h('span.muted', null, t('ui.modal.seed')),
      h('code', null, seed),
      h(
        'button.btn.small',
        {
          onclick: async () => {
            const ok = await copyText(seed);
            ctx.toast(ok ? t('ui.modal.seedCopied') : t('ui.modal.copyFailed'), ok ? 'good' : 'warn');
          },
        },
        h('span.gi', { html: G.copy }),
        t('ui.modal.copy'),
      ),
    ),
  );

  historyBox.append(
    h('h2', null, t('ui.modal.eventLog')),
    h(
      'ol.event-log',
      null,
      log
        .slice()
        .reverse()
        .map((e) => {
          const m = eventMeta(e.id);
          return h(
            `li.tone-${m.tone}`,
            { title: m.desc },
            h('span.ev-wave', null, t('ui.modal.waveN', { n: e.wave })),
            h('span.gi', { html: TONE_GLYPH[m.tone] }),
            h('b', null, e.name || m.name),
            h('small.muted', null, m.desc),
          );
        }),
    ),
    h('button.btn.big', { onclick: () => ((historyBox.hidden = true), (main.hidden = false), audio.play('click')) }, t('common.back')),
  );

  settingsBox.append(
    h('h2', null, t('ui.modal.settings')),
    settingsPanel(ctx.app, { inGame: true, host: ctx.root }),
    h('button.btn.big', { onclick: () => ((settingsBox.hidden = true), (main.hidden = false), audio.play('click')) }, t('common.back')),
  );

  main.hidden = view !== 'main';
  settingsBox.hidden = view !== 'settings';
  historyBox.hidden = view !== 'history';
  return h('div.dialog.card.pause-dialog', { attrs: { role: 'dialog', 'aria-modal': 'true' } }, main, confirmBox, settingsBox, historyBox);
}

// ───────────── 结算 ─────────────

export interface GameOverData {
  won: boolean;
  wave: number;
  wavesSurvived: number;
  score: number;
  st: WorldState;
  rewards: Rewards;
}

export interface GameOverHandlers {
  again(): void;
  changeDifficulty(): void;
  menu(): void;
}

export function gameOverView(ctx: GameCtx, d: GameOverData, hd: GameOverHandlers): HTMLElement {
  const st = d.st;
  const towers: TowerState[] = Array.from(st.towers.values())
    .filter((t) => t.damage > 0)
    .sort((a, b) => b.damage - a.damage)
    .slice(0, 5);
  const top = towers[0]?.damage ?? 1;
  const campaign = ctx.opts.mode === 'campaign';
  const title = d.won ? t('ui.modal.goWon') : t('ui.modal.goLost');
  const sub = campaign
    ? d.won
      ? t('ui.modal.goAllWaves', { n: st.totalWaves })
      : t('ui.modal.goFellAt', { wave: d.wave, total: st.totalWaves })
    : t('ui.modal.goSurvived', { n: d.wavesSurvived });

  // 结算演出：数字依次从 0 涨上来（元素里先写好最终值，「减少动画」时保持不变）
  let statIdx = 0;
  const stat = (label: string, value: string, num?: number) => {
    const b = h('b', null, value);
    const k = statIdx++;
    if (num !== undefined) countUp(b, Math.round(num), fmtNum, 450 + k * 120, 700);
    return h('div.go-stat', { style: `--i:${k}` }, h('span.muted', null, label), b);
  };
  const inkNum = h('b.go-ink', null, String(d.rewards.ink));
  if (d.rewards.ink > 0) countUp(inkNum, d.rewards.ink, String, 1100, 800);

  const rewards: HTMLElement[] = [];
  if (campaign && d.won) {
    rewards.push(
      h(
        'div.go-reward',
        null,
        starRow(d.rewards.starsBest),
        d.rewards.stars > 0
          ? h('span', null, `+${d.rewards.stars}`, h('span.gi', { html: G.star }))
          : h('span.muted', null, t('ui.modal.goNoNewStars')),
      ),
    );
  }
  if (d.rewards.ink > 0) rewards.push(h('div.go-reward', null, h('span.gi', { html: G.ink }), t('ui.modal.goInk'), inkNum));
  // AI 协助的成绩单独排名，不在结算里报「第 N 名」
  if (d.rewards.rank > 0 && !isAiAssisted(ctx.aiAssist))
    rewards.push(h('div.go-reward', null, h('span.gi', { html: G.trophy }), t('ui.modal.goRank', { n: d.rewards.rank })));
  if (d.rewards.newRecord && !campaign) rewards.push(h('div.go-reward.new', null, t('ui.modal.goNewRecord')));

  const mvp =
    towers.length > 0
      ? h(
          'div.mvp',
          null,
          h('h3', null, t('ui.modal.goDamage')),
          towers.map((tw, i) =>
            h(
              `div.mvp-row${i === 0 ? '.first' : ''}`,
              { style: `--i:${i}` },
              h('span.mvp-rank', null, i === 0 ? h('span.gi', { html: G.crown }) : String(i + 1)),
              img(towerIcon(tw.id, tw.tier, tw.branch, tw.level), 'ico'),
              h(
                'div.mvp-main',
                null,
                h(
                  'div.mvp-name',
                  null,
                  TOWER_META[tw.id]?.name ?? tw.id,
                  h('small.muted', null, ` Lv${tw.level}${tw.stars ? ` ${'★'.repeat(tw.stars)}` : ''}`),
                ),
                h('div.mvp-bar', null, h('span', { style: `width:${((tw.damage / top) * 100).toFixed(1)}%` })),
              ),
              h('div.mvp-num', null, fmtNum(tw.damage), h('small.muted', null, t('ui.modal.goKills', { n: fmtNum(tw.kills) }))),
            ),
          ),
        )
      : null;

  const onlineSlot = h('div.go-online', { data: { slot: 'online-submit' } });
  mountOnlineSubmit(onlineSlot, ctx, d.wavesSurvived);

  return overlay(
    `gameover-overlay.${d.won ? 'won' : 'lost'}`,
    h(
      'div.dialog.card.gameover',
      { attrs: { role: 'dialog', 'aria-modal': 'true' } },
      h(
        'div.go-head',
        null,
        h('span.go-ico', { html: d.won ? G.crown : G.skull }),
        h('h2', null, title),
        h('p.muted', null, sub),
        assistLine(ctx),
      ),
      h(
        'div.go-stats',
        null,
        stat(t('ui.modal.goScore'), fmtNum(d.score), d.score),
        stat(t('ui.modal.goKillsLabel'), fmtNum(st.stats.kills), st.stats.kills),
        stat(t('ui.modal.goLives'), `${st.lives}/${st.maxLives}`),
        stat(t('ui.modal.goLeaks'), fmtNum(st.stats.leaks), st.stats.leaks),
      ),
      // 在线排行榜「提交成绩」面板的挂载点（空的时候不占位）：mountOnlineSubmit(onlineSlot, ctx)
      onlineSlot,
      rewards.length ? h('div.go-rewards', null, rewards) : null,
      mvp,
      h(
        'div.go-actions',
        null,
        h('button.btn.primary.big', { onclick: hd.again }, h('span.gi', { html: G.refresh }), t('ui.modal.goAgain')),
        h('button.btn.big', { onclick: hd.changeDifficulty }, h('span.gi', { html: G.sliders }), t('ui.modal.goDifficulty')),
        h('button.btn.big', { onclick: hd.menu }, h('span.gi', { html: G.back }), t('ui.modal.goMenu')),
      ),
      h('p.muted.small.center', null, t('ui.modal.goSeed', { seed: st.seed })),
    ),
  );
}

/** 结算卡片标题下的 AI 助手标记：替我玩过 → 「AI 协助」+ 说明；只用过军师 → 小标记，无限制 */
function assistLine(ctx: GameCtx): HTMLElement | null {
  const a = ctx.aiAssist;
  if (!usedAi(a)) return null;
  const assisted = isAiAssisted(a);
  return h(
    'p.go-assist',
    null,
    h(
      `span.badge.ai-assist-badge${assisted ? '' : '.advisor'}`,
      { title: a?.model ?? '' },
      assisted ? t('ui.assist.badge') : t('ui.assist.badgeAdvisor'),
    ),
    h('small.muted', null, assisted ? t('ui.assist.goNote') : t('ui.assist.goNoteAdvisor')),
  );
}

// ───────────── 读取存档 ─────────────

export function loadingOverlay(text: string): { el: HTMLElement; set(p: number): void } {
  const fill = h('span.load-fill');
  const el = overlay('loading-overlay', h('div.dialog.card.loading', null, h('p', null, text), h('div.load-bar', null, fill)));
  return { el, set: (p) => (fill.style.width = `${(p * 100).toFixed(1)}%`) };
}
