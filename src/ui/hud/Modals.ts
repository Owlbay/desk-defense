import type { PerkCard, TowerState, WorldState } from '../../core/types';
import { ui } from '../../game/UiStore';
import type { Rewards } from '../../meta/progress';
import { towerIcon } from '../assets';
import { audio } from '../audio';
import { TOWER_META } from '../coreMeta';
import { TOWERS } from '../../config/towers';
import { copyText, fmtNum, h, img, setText } from '../dom';
import { G } from '../icons';
import { settingsPanel } from '../screens/settings';
import { RARITY_NAME, type GameCtx } from './context';
import { runSummary } from '../screens/menu';
import { starRow } from '../screens/common';

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
    this.el = overlay(
      'perk-overlay',
      h('div.perk-dialog', { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '选择增益' } }, h('h2.perk-title', null, '选择一个增益'), h('p.muted.center', null, '本局永久有效'), this.cards, h('div.row.center', null, this.reroll)),
    );
    this.el.hidden = true;
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
    if (!show || !st.perkChoices) return;
    const sig = st.perkChoices.map((c) => c.id).join(',');
    if (sig !== this.sig) {
      this.sig = sig;
      this.renderCards(st.perkChoices);
    }
    const cost = st.perkRerollCost;
    setText(this.rerollText, cost <= 0 ? '免费刷新' : `刷新 · ${cost} 金`);
    this.reroll.classList.toggle('poor', cost > st.gold);
  }

  private renderCards(cards: PerkCard[]): void {
    this.cards.replaceChildren(
      ...cards.map((c, i) =>
        h(
          `button.perk-card.r-${c.rarity}`,
          { style: `--i:${i}`, onclick: () => this.choose(c) },
          h('span.perk-rarity', null, RARITY_NAME[c.rarity]),
          h('h3', null, c.name),
          h('p', null, c.desc),
          c.needsTower ? h('span.perk-note', null, h('span.gi', { html: G.target }), '需要选择一座塔') : null,
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
        onclick: () => {
          const r = perk ? ctx.cmd({ type: 'choosePerk', id: o.perkId!, uid, branch: b }) : ctx.cmd({ type: 'upgrade', uid, branch: b });
          if (r.ok) close(true);
        },
      },
      h('span.branch-tag', null, `传奇 ${b}`),
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
      h('h2', null, `${info.name} · 选择传奇分支`),
      h(
        'p.muted',
        null,
        perk ? `「传奇在望」：这座 Lv${info.level} 的塔将直接成为传奇，只需支付一半的传奇升级费用。分支一旦选定无法更改。` : `花费 ${fmtNum(info.upgradeCost ?? 0)} 金升到 Lv10，分支一旦选定无法更改。`,
      ),
      h('div.branch-cards', null, card('A'), card('B')),
      h('div.row.end', null, h('button.btn', { onclick: () => (audio.play('click'), close(false)) }, perk ? '换一座塔' : '再想想')),
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

export function pauseMenu(ctx: GameCtx, hd: PauseHandlers): HTMLElement {
  const st = ctx.world.state;
  const seed = st.seed;
  const main = h('div.pause-main');
  const confirmBox = h('div.pause-confirm');
  confirmBox.hidden = true;
  const settingsBox = h('div.pause-settings');
  settingsBox.hidden = true;

  const ask = (title: string, text: string, okText: string, fn: () => void) => {
    main.hidden = true;
    confirmBox.hidden = false;
    confirmBox.replaceChildren(
      h('h2', null, title),
      h('p.muted', null, text),
      h(
        'div.row.end',
        null,
        h('button.btn', { onclick: () => ((confirmBox.hidden = true), (main.hidden = false), audio.play('click')) }, '取消'),
        h('button.btn.danger', { onclick: fn }, okText),
      ),
    );
  };

  const midNote = st.wave > 0 ? '进度会保存到上一波结束时，可以从主菜单「继续游戏」。' : '还没打完第一波，退出后不会保留进度。';

  main.append(
    h('h2.pause-title', null, '暂停'),
    h('p.muted.center', null, runSummary(ctx.opts)),
    h('button.btn.primary.big', { onclick: hd.resume }, h('span.gi', { html: G.play }), '继续'),
    h(
      'button.btn.big',
      {
        onclick: () => {
          audio.play('click');
          ask('重新开始？', '当前这局的进度会丢失。', '重新开始', hd.restart);
        },
      },
      h('span.gi', { html: G.refresh }),
      '重新开始',
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
      '设置',
    ),
    h(
      'button.btn.big',
      {
        onclick: () => {
          audio.play('click');
          ask('退出到主菜单？', midNote, '退出', hd.quit);
        },
      },
      h('span.gi', { html: G.back }),
      '退出到菜单',
    ),
    h(
      'div.seed-row',
      null,
      h('span.muted', null, '种子'),
      h('code', null, seed),
      h(
        'button.btn.small',
        {
          onclick: async () => {
            const ok = await copyText(seed);
            ctx.toast(ok ? '种子已复制' : '复制失败', ok ? 'good' : 'warn');
          },
        },
        h('span.gi', { html: G.copy }),
        '复制',
      ),
    ),
  );

  settingsBox.append(
    h('h2', null, '设置'),
    settingsPanel(ctx.app, { inGame: true, host: ctx.root }),
    h('button.btn.big', { onclick: () => ((settingsBox.hidden = true), (main.hidden = false), audio.play('click')) }, '返回'),
  );

  return overlay('pause-overlay', h('div.dialog.card.pause-dialog', { attrs: { role: 'dialog', 'aria-modal': 'true' } }, main, confirmBox, settingsBox));
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
  const title = d.won ? '防线守住了！' : '防线被突破';
  const sub = campaign
    ? d.won
      ? `撑过全部 ${st.totalWaves} 波`
      : `倒在第 ${d.wave} / ${st.totalWaves} 波`
    : `撑过 ${d.wavesSurvived} 波`;

  const stat = (label: string, value: string) => h('div.go-stat', null, h('span.muted', null, label), h('b', null, value));

  const rewards: HTMLElement[] = [];
  if (campaign && d.won) {
    rewards.push(h('div.go-reward', null, starRow(d.rewards.starsBest), d.rewards.stars > 0 ? h('span', null, `+${d.rewards.stars}`, h('span.gi', { html: G.star })) : h('span.muted', null, '未超过最佳星数')));
  }
  if (d.rewards.ink > 0) rewards.push(h('div.go-reward', null, h('span.gi', { html: G.ink }), `墨水 +${d.rewards.ink}`));
  if (d.rewards.rank > 0) rewards.push(h('div.go-reward', null, h('span.gi', { html: G.trophy }), `排行榜第 ${d.rewards.rank} 名`));
  if (d.rewards.newRecord && !campaign) rewards.push(h('div.go-reward.new', null, '新纪录！'));

  const mvp =
    towers.length > 0
      ? h(
          'div.mvp',
          null,
          h('h3', null, '伤害排行'),
          towers.map((t, i) =>
            h(
              `div.mvp-row${i === 0 ? '.first' : ''}`,
              null,
              h('span.mvp-rank', null, i === 0 ? h('span.gi', { html: G.crown }) : String(i + 1)),
              img(towerIcon(t.id, t.tier, t.branch, t.level), 'ico'),
              h(
                'div.mvp-main',
                null,
                h('div.mvp-name', null, TOWER_META[t.id]?.name ?? t.id, h('small.muted', null, ` Lv${t.level}`)),
                h('div.mvp-bar', null, h('span', { style: `width:${((t.damage / top) * 100).toFixed(1)}%` })),
              ),
              h('div.mvp-num', null, fmtNum(t.damage), h('small.muted', null, `${fmtNum(t.kills)} 击杀`)),
            ),
          ),
        )
      : null;

  return overlay(
    `gameover-overlay.${d.won ? 'won' : 'lost'}`,
    h(
      'div.dialog.card.gameover',
      { attrs: { role: 'dialog', 'aria-modal': 'true' } },
      h('div.go-head', null, h('span.go-ico', { html: d.won ? G.crown : G.skull }), h('h2', null, title), h('p.muted', null, sub)),
      h(
        'div.go-stats',
        null,
        stat('得分', fmtNum(d.score)),
        stat('击杀', fmtNum(st.stats.kills)),
        stat('剩余生命', `${st.lives}/${st.maxLives}`),
        stat('漏怪', fmtNum(st.stats.leaks)),
      ),
      rewards.length ? h('div.go-rewards', null, rewards) : null,
      mvp,
      h(
        'div.go-actions',
        null,
        h('button.btn.primary.big', { onclick: hd.again }, h('span.gi', { html: G.refresh }), '再来一局'),
        h('button.btn.big', { onclick: hd.changeDifficulty }, h('span.gi', { html: G.sliders }), '换难度'),
        h('button.btn.big', { onclick: hd.menu }, h('span.gi', { html: G.back }), '返回菜单'),
      ),
      h('p.muted.small.center', null, `种子 ${st.seed}`),
    ),
  );
}

// ───────────── 读取存档 ─────────────

export function loadingOverlay(text: string): { el: HTMLElement; set(p: number): void } {
  const fill = h('span.load-fill');
  const el = overlay('loading-overlay', h('div.dialog.card.loading', null, h('p', null, text), h('div.load-bar', null, fill)));
  return { el, set: (p) => (fill.style.width = `${(p * 100).toFixed(1)}%`) };
}
