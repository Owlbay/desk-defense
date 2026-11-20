import type { BuildOption, TargetMode, TowerInfo } from '../../core/types';
import { ui } from '../../game/UiStore';
import { towerIcon } from '../assets';
import { audio } from '../audio';
import { fmtNum, h, img, setText, toggle } from '../dom';
import { G } from '../icons';
import { TARGET_NAME, type GameCtx } from './context';

interface TowerRefs {
  key: string;
  uid: number;
  xpFill: HTMLElement;
  xpText: HTMLElement;
  stats: HTMLElement[];
  modeBtns: Map<TargetMode, HTMLElement>;
  upBtn: HTMLButtonElement;
  upLabel: HTMLElement;
  upPrice: HTMLElement;
  upDisc: HTMLElement;
  sellBtn: HTMLButtonElement;
  sellLabel: HTMLElement;
  sellSub: HTMLElement;
  record: HTMLElement;
}

const TIER_CLS = ['', 't1', 't2', 't3', 't4'];

export class InfoPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private refs: TowerRefs | null = null;
  private mode = '';
  private info: TowerInfo | null = null;
  private sellArmed = 0;

  constructor(private ctx: GameCtx) {
    this.body = h('div.info-body');
    this.el = h('div.infopanel', { attrs: { 'aria-live': 'off' } }, this.body);
  }

  /** 选中塔信息（null 时根据 build / 提示显示） */
  update(info: TowerInfo | null, buildOpt: BuildOption | null): void {
    this.info = info;
    if (info) {
      const key = this.structKey(info);
      if (!this.refs || this.refs.key !== key || this.mode !== 'tower') this.buildTower(info, key);
      this.applyTower(info);
      return;
    }
    this.refs = null;
    if (ui.state.perkTargeting) return this.setSimple('perk', h('div.info-hint', null, h('span.gi', { html: G.target }), '在棋盘上点一座塔，作为增益的目标。'));
    if (buildOpt) {
      const key = `build:${buildOpt.id}:${buildOpt.cost}:${buildOpt.affordable}`;
      if (this.mode === key) return;
      const air = buildOpt.hitsAir && buildOpt.hitsGround ? '可打空中和地面' : buildOpt.hitsAir ? '只打空中' : buildOpt.hitsGround ? '只打地面' : '不攻击';
      const touch = ui.state.touch;
      this.setSimple(
        key,
        h(
          'div.build-info',
          null,
          h('div.info-head', null, h('span.info-ico', null, img(towerIcon(buildOpt.id), 'ico')), h('div', null, h('h3', null, buildOpt.name), h('div.tags', null, h('span.tag', null, buildOpt.role), h('span.tag', null, air)))),
          h('p.info-desc', null, buildOpt.desc),
          h('p.muted.small', null, touch ? '点格子预览，再点同一格放下。再点一次塔栏按钮取消。' : '点击格子放下，可连续放置；右键或 Esc 取消。'),
        ),
      );
      return;
    }
    if (ui.state.aiming) return this.setSimple('aim', h('div.info-hint', null, h('span.gi', { html: G.target }), ui.state.touch ? '点棋盘预览范围，再点一次释放；点技能按钮取消。' : '点击棋盘释放技能；右键或 Esc 取消。'));
    this.setSimple('hint', h('div.info-hint.muted', null, '选择塔栏里的塔来建造，或点棋盘上的塔查看详情。'));
  }

  private setSimple(key: string, node: HTMLElement): void {
    if (this.mode === key) return;
    this.mode = key;
    this.body.replaceChildren(node);
  }

  private structKey(i: TowerInfo): string {
    return [
      i.uid,
      i.level,
      i.tier,
      i.branch,
      i.needsBranch,
      i.upgradeCost === null,
      i.targetMode === null,
      i.targetModes.join('|'),
      i.stats.map((s) => s.label).join('|'),
      i.traits.map((t) => `${t.name}${t.unlocked ? 1 : 0}`).join('|'),
      i.xpCapped,
    ].join(';');
  }

  private buildTower(i: TowerInfo, key: string): void {
    this.mode = 'tower';
    const pips = h('span.pips.level-pips');
    for (let k = 1; k <= i.maxLevel; k++) pips.appendChild(h(`span.pip${k <= i.level ? '.on' : ''}${k === 10 ? '.legend' : ''}`));
    const xpFill = h('span.xp-fill');
    const xpText = h('span.xp-text');
    const stats = i.stats.map(() => h('b'));
    const modeBtns = new Map<TargetMode, HTMLElement>();
    const modeRow =
      i.targetMode !== null && i.targetModes.length > 1
        ? h(
            'div.target-row',
            null,
            h('span.muted.small', null, '目标'),
            h(
              'div.seg-mini',
              null,
              i.targetModes.map((m) => {
                const b = h(
                  'button.mini',
                  {
                    onclick: () => {
                      audio.play('click');
                      this.ctx.cmd({ type: 'setTarget', uid: i.uid, mode: m });
                    },
                  },
                  TARGET_NAME[m] ?? m,
                );
                modeBtns.set(m, b);
                return b;
              }),
            ),
          )
        : null;

    const upLabel = h('span.act-label');
    const upPrice = h('span.act-sub');
    const upDisc = h('span.disc');
    const upBtn = h<HTMLButtonElement>('button.btn.act.upgrade', { onclick: () => this.upgrade() }, h('span.gi', { html: G.up }), h('span.act-text', null, upLabel, upPrice), upDisc);
    const sellLabel = h('span.act-label');
    const sellSub = h('span.act-sub');
    const sellBtn = h<HTMLButtonElement>('button.btn.act.sell', { onclick: () => this.sell(false) }, h('span.gi', { html: G.sell }), h('span.act-text', null, sellLabel, sellSub));
    const record = h('span.muted.small');

    const traits =
      i.traits.length > 0
        ? h(
            'ul.traits',
            null,
            i.traits.map((t) =>
              h(
                `li.trait${t.unlocked ? '.on' : ''}`,
                { title: t.desc },
                h('span.trait-lv', null, `Lv${t.unlockLevel}`),
                h('span', null, h('b', null, t.name), ' ', h('span.muted', null, t.desc)),
                t.unlocked ? null : h('span.gi', { html: G.lock }),
              ),
            ),
          )
        : null;

    const node = h(
      `div.tower-info.${TIER_CLS[i.tier]}${i.branch ? `.br-${i.branch}` : ''}`,
      null,
      h(
        'div.info-head',
        null,
        h('span.info-ico', null, img(towerIcon(i.id, i.tier, i.branch, i.level), 'ico')),
        h(
          'div.info-title',
          null,
          h('h3', null, i.name, h('span.tier-badge', null, i.tierName)),
          h('div.lv-row', null, h('span.lv', null, `Lv${i.level}`), pips),
          h('div.xp', null, h('span.xp-bar', null, xpFill), xpText),
        ),
        h(
          'button.btn.icon-btn.close-info',
          {
            attrs: { 'aria-label': '取消选中' },
            onclick: () => {
              audio.play('click');
              ui.set({ selected: null });
            },
          },
          h('span.gi', { html: G.close }),
        ),
      ),
      h('div.actions', null, upBtn, sellBtn),
      modeRow,
      h(
        'dl.stats-grid',
        null,
        i.stats.map((s, k) => h('div', null, h('dt', null, s.label), h('dd', null, stats[k]))),
      ),
      traits,
      h('div.record', null, record),
    );
    this.body.replaceChildren(node);
    this.refs = { key, uid: i.uid, xpFill, xpText, stats, modeBtns, upBtn, upLabel, upPrice, upDisc, sellBtn, sellLabel, sellSub, record };
  }

  private applyTower(i: TowerInfo): void {
    const r = this.refs;
    if (!r) return;
    // 经验
    if (i.level >= i.maxLevel) {
      r.xpFill.style.width = '100%';
      setText(r.xpText, i.mastery > 0 ? `熟练度 ${Math.floor(i.mastery)}` : '满级');
    } else if (i.xpCapped) {
      r.xpFill.style.width = '100%';
      setText(r.xpText, '经验已满 · 需花钱升级');
    } else {
      const pct = i.xpNext > 0 ? Math.min(100, (i.xp / i.xpNext) * 100) : 0;
      r.xpFill.style.width = `${pct.toFixed(1)}%`;
      setText(r.xpText, `${Math.floor(i.xp)}/${Math.ceil(i.xpNext)}`);
    }
    i.stats.forEach((s, k) => r.stats[k] && setText(r.stats[k], s.value));
    for (const [m, b] of r.modeBtns) toggle(b, 'on', i.targetMode === m);
    // 升级
    if (i.upgradeCost === null) {
      setText(r.upLabel, '已满级');
      setText(r.upPrice, '');
      setText(r.upDisc, '');
      r.upBtn.disabled = true;
    } else {
      r.upBtn.disabled = false;
      setText(r.upLabel, i.needsBranch ? '选择传奇分支' : '升级');
      setText(r.upPrice, `${fmtNum(i.upgradeCost)} 金`);
      setText(r.upDisc, i.upgradeDiscount > 0.005 ? `经验 −${Math.round(i.upgradeDiscount * 100)}%` : '');
      toggle(r.upDisc, 'show', i.upgradeDiscount > 0.005);
    }
    toggle(r.upBtn, 'poor', i.upgradeCost !== null && !i.canAffordUpgrade);
    toggle(r.upBtn, 'branch', i.needsBranch);
    // 出售 / 撤销
    const armed = this.sellArmed > performance.now();
    if (i.canUndo) {
      setText(r.sellLabel, `撤销 (${Math.ceil(i.undoRemaining)}s)`);
      setText(r.sellSub, `全额退 ${fmtNum(i.sellValue)}`);
    } else if (armed) {
      setText(r.sellLabel, '再点确认');
      setText(r.sellSub, `+${fmtNum(i.sellValue)} 金`);
    } else {
      setText(r.sellLabel, '出售');
      setText(r.sellSub, `+${fmtNum(i.sellValue)} · ${Math.round(i.refundRate * 100)}%`);
    }
    toggle(r.sellBtn, 'undo', i.canUndo);
    toggle(r.sellBtn, 'armed', armed && !i.canUndo);
    setText(r.record, `击杀 ${fmtNum(i.kills)} · 伤害 ${fmtNum(i.damage)}`);
  }

  upgrade(): void {
    const i = this.info;
    if (!i || i.upgradeCost === null) return;
    if (i.needsBranch) {
      audio.play('click');
      this.ctx.openBranch(i.uid);
      return;
    }
    this.ctx.cmd({ type: 'upgrade', uid: i.uid });
  }

  /** immediate：键盘 S 直接出售 */
  sell(immediate: boolean): void {
    const i = this.info;
    if (!i) return;
    if (!immediate && !i.canUndo && this.sellArmed <= performance.now()) {
      audio.play('click');
      this.sellArmed = performance.now() + 2500;
      this.applyTower(i);
      return;
    }
    this.sellArmed = 0;
    const r = this.ctx.cmd({ type: 'sell', uid: i.uid });
    if (r.ok) ui.set({ selected: null });
  }
}
