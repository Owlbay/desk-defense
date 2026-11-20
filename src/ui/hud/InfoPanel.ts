import type { BuildOption, SpawnerState, TargetMode, TowerInfo, WorldState } from '../../core/types';
import { ui } from '../../game/UiStore';
import { abilityIcon, enemyIcon, svgUrl, towerIcon } from '../assets';
import { audio } from '../audio';
import { ENEMY_META, SKILL_META, spawnerName } from '../coreMeta';
import { fmtNum, h, img, setText, toggle } from '../dom';
import { G } from '../icons';
import { ABILITY_TARGET_TEXT, castTowerAbility } from './abilities';
import { fmtSec, TARGET_NAME, type GameCtx } from './context';

interface AbilityRefs {
  card: HTMLElement;
  sweep: HTMLElement;
  secs: HTMLElement;
  btn: HTMLButtonElement;
  btnText: HTMLElement;
  charges: HTMLElement | null;
}

interface TowerRefs {
  key: string;
  uid: number;
  xpBar: HTMLElement;
  xpFill: HTMLElement;
  xpText: HTMLElement;
  stars: HTMLElement[];
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
  ability: AbilityRefs | null;
}

interface SpawnerRefs {
  key: string;
  status: HTMLElement;
  demolish: HTMLButtonElement | null;
  demolishSub: HTMLElement | null;
  seal: HTMLButtonElement | null;
}

const TIER_CLS = ['', 't1', 't2', 't3', 't4', 't5'];

/** 传奇（Lv10 已选分支）之后才有进化 */
const isLegend = (i: TowerInfo): boolean => i.id !== 'wall' && i.level >= i.maxLevel && i.branch !== null;

export class InfoPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private refs: TowerRefs | null = null;
  private spRefs: SpawnerRefs | null = null;
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
    // 空降出生点（文档 09 §2.2）
    const spId = ui.state.spawnerSelected;
    if (spId !== null) {
      const st = this.ctx.world.state;
      const sp = st.spawners.find((s) => s.id === spId);
      if (sp) {
        this.refs = null;
        this.showSpawner(st, sp);
        return;
      }
      ui.set({ spawnerSelected: null });
    }
    this.spRefs = null;
    if (info) {
      const key = this.structKey(info);
      if (!this.refs || this.refs.key !== key || this.mode !== 'tower') this.buildTower(info, key);
      this.applyTower(info);
      return;
    }
    this.refs = null;
    if (ui.state.perkTargeting) return this.setSimple('perk', h('div.info-hint', null, h('span.gi', { html: G.target }), '在棋盘上点一座塔，作为增益的目标。'));
    if (ui.state.abilityAiming !== null) {
      const ti = this.ctx.world.getTowerInfo(ui.state.abilityAiming);
      const ab = ti?.ability;
      const what = ab ? `「${ab.name}」：${ABILITY_TARGET_TEXT[ab.target] ?? '选择目标'}` : '选择目标';
      return this.setSimple(`abil:${ui.state.abilityAiming}`, h('div.info-hint', null, h('span.gi', { html: G.sparkle }), `${what}。${ui.state.touch ? '点能力按钮取消。' : '右键或 Esc 取消。'}`));
    }
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
    if (ui.state.aiming) {
      const spawnerAim = SKILL_META[ui.state.aiming]?.target === 'spawner' || ui.state.aiming === 'seal_tape';
      return this.setSimple(
        `aim:${spawnerAim}`,
        h(
          'div.info-hint',
          null,
          h('span.gi', { html: G.target }),
          spawnerAim ? '点一个空降出生点（纸箱）把它封掉。' : ui.state.touch ? '点棋盘预览范围，再点一次释放；点技能按钮取消。' : '点击棋盘释放技能；右键或 Esc 取消。',
        ),
      );
    }
    this.setSimple('hint', h('div.info-hint.muted', null, '选择塔栏里的塔来建造，或点棋盘上的塔查看详情。'));
  }

  private setSimple(key: string, node: HTMLElement): void {
    if (this.mode === key) return;
    this.mode = key;
    this.body.replaceChildren(node);
  }

  // ───────────── 出生点 ─────────────

  private showSpawner(st: WorldState, sp: SpawnerState): void {
    const hasSeal = st.skills.some((s) => s.id === 'seal_tape');
    const key = `sp:${sp.id}:${sp.kind}:${sp.demolishCost ?? -1}:${sp.icon ?? ''}:${hasSeal}`;
    if (!this.spRefs || this.spRefs.key !== key || this.mode !== 'spawner') this.buildSpawner(st, sp, key, hasSeal);
    const r = this.spRefs;
    if (!r) return;
    // 状态行
    let status = '';
    if (sp.warnUntil !== undefined && sp.warnUntil > st.time) status = `预警中 · ${Math.ceil(sp.warnUntil - st.time)} 秒后落地`;
    else if (sp.kind === 'drop' || sp.kind === 'hidden') {
      if (sp.expiresAfterWave !== undefined) {
        const left = sp.expiresAfterWave - st.wave;
        status = `第 ${sp.expiresAfterWave} 波结束后关闭${left > 0 ? `（还剩 ${left} 波）` : '（本波结束）'}`;
      } else status = sp.active ? '开放中' : '已关闭';
    } else status = sp.active ? '开放中' : '尚未开放';
    setText(r.status, status);
    if (r.demolish && sp.demolishCost !== undefined) {
      toggle(r.demolish, 'poor', st.gold < sp.demolishCost);
    }
    if (r.seal) {
      const sk = st.skills.find((s) => s.id === 'seal_tape');
      r.seal.disabled = !sk?.ready;
      setText(r.seal.querySelector('.act-sub') ?? r.seal, sk?.ready ? '立即封掉' : `冷却 ${fmtSec(sk?.cd ?? 0)} 秒`);
    }
  }

  private buildSpawner(st: WorldState, sp: SpawnerState, key: string, hasSeal: boolean): void {
    this.mode = 'spawner';
    const drop = sp.kind === 'drop';
    const status = h('p.sp-status');
    const kindName = drop ? '空降出生点' : sp.kind === 'hidden' ? '隐藏出生点' : '桌边入口';
    let demolish: HTMLButtonElement | null = null;
    let demolishSub: HTMLElement | null = null;
    let seal: HTMLButtonElement | null = null;
    if (drop && sp.demolishCost !== undefined) {
      demolishSub = h('span.act-sub', null, `${fmtNum(sp.demolishCost)} 金`);
      demolish = h<HTMLButtonElement>(
        'button.btn.act.demolish',
        {
          onclick: () => {
            const r = this.ctx.cmd({ type: 'demolishSpawner', id: sp.id });
            if (r.ok) ui.set({ spawnerSelected: null });
          },
        },
        h('span.gi', { html: G.hammer }),
        h('span.act-text', null, h('span.act-label', null, '拆除'), demolishSub),
      );
    }
    if (drop && hasSeal) {
      seal = h<HTMLButtonElement>(
        'button.btn.act.seal',
        {
          onclick: () => {
            const r = this.ctx.cmd({ type: 'cast', skill: 'seal_tape', spawner: sp.id });
            if (r.ok) ui.set({ spawnerSelected: null, aiming: null });
          },
        },
        h('span.gi', { html: G.tape }),
        h('span.act-text', null, h('span.act-label', null, '封箱胶带'), h('span.act-sub', null, '')),
      );
    }
    const icon = sp.icon ? img(enemyIcon(sp.icon), 'ico') : img(svgUrl(drop ? G.parachute : G.warn), 'ico');
    const node = h(
      `div.spawner-info.k-${sp.kind}`,
      null,
      h(
        'div.info-head',
        null,
        h('span.info-ico', null, icon),
        h('div.info-title', null, h('h3', null, spawnerName(sp.id, st.spawners), h('span.tier-badge', null, kindName)), status),
        h(
          'button.btn.icon-btn.close-info',
          {
            attrs: { 'aria-label': '关闭' },
            onclick: () => {
              audio.play('click');
              ui.set({ spawnerSelected: null });
            },
          },
          h('span.gi', { html: G.close }),
        ),
      ),
      sp.icon ? h('p.muted.small', null, `纸箱上画着「${ENEMY_META[sp.icon]?.name ?? sp.icon}」，部分敌人会从这里出来。`) : null,
      demolish || seal ? h('div.actions', null, demolish, seal) : null,
      drop && !hasSeal ? h('p.muted.small', null, '小提示：技能「封箱胶带」可以直接封掉空降点（在技能页带入）。') : null,
      !drop ? h('p.muted.small', null, '入口无法拆除。') : null,
    );
    this.body.replaceChildren(node);
    this.spRefs = { key, status, demolish, demolishSub, seal };
  }

  // ───────────── 塔 ─────────────

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
      i.stars ?? 0,
      i.evolveCost === null,
      (i.evoTraits ?? []).map((t) => `${t.name}${t.unlocked ? 1 : 0}`).join('|'),
      i.ability ? `${i.ability.id}:${i.ability.target}:${i.ability.maxCharges ?? ''}` : '',
    ].join(';');
  }

  private buildTower(i: TowerInfo, key: string): void {
    this.mode = 'tower';
    const legend = isLegend(i);
    const pips = h('span.pips.level-pips');
    for (let k = 1; k <= i.maxLevel; k++) pips.appendChild(h(`span.pip${k <= i.level ? '.on' : ''}${k === 10 ? '.legend' : ''}`));
    const stars: HTMLElement[] = [];
    let starRow: HTMLElement | null = null;
    if (legend) {
      for (let k = 1; k <= 3; k++) stars.push(h(`span.evo-star${k === 3 ? '.mythic' : ''}`, { title: k === 3 ? '★3 神话' : `★${k}` }));
      starRow = h('span.evo-stars', { attrs: { 'aria-label': `进化 ${i.stars ?? 0} 星` } }, ...stars);
    }
    const xpFill = h('span.xp-fill');
    const xpBar = h(`span.xp-bar${legend ? '.evo' : ''}`, null, xpFill);
    const xpText = h('span.xp-text');
    const statEls = i.stats.map(() => h('b'));
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
    const upBtn = h<HTMLButtonElement>('button.btn.act.upgrade', { onclick: () => this.upgrade() }, h('span.gi', { html: legend ? G.star : G.up }), h('span.act-text', null, upLabel, upPrice), upDisc);
    const sellLabel = h('span.act-label');
    const sellSub = h('span.act-sub');
    const sellBtn = h<HTMLButtonElement>('button.btn.act.sell', { onclick: () => this.sell(false) }, h('span.gi', { html: G.sell }), h('span.act-text', null, sellLabel, sellSub));
    const record = h('span.muted.small');

    const traitList = (list: TowerInfo['traits'], evo: boolean) =>
      list.length > 0
        ? h(
            `ul.traits${evo ? '.evo-traits' : ''}`,
            null,
            list.map((t, k) =>
              h(
                `li.trait${t.unlocked ? '.on' : ''}`,
                { title: t.desc },
                h('span.trait-lv', null, evo ? `★${t.unlockLevel > 10 ? t.unlockLevel - 10 : k + 1}` : `Lv${t.unlockLevel}`),
                h('span', null, h('b', null, t.name), ' ', h('span.muted', null, t.desc)),
                t.unlocked ? null : h('span.gi', { html: G.lock }),
              ),
            ),
          )
        : null;

    // 主动能力（★3 神话）
    let ability: AbilityRefs | null = null;
    let abilityCard: HTMLElement | null = null;
    if (i.ability) {
      const ab = i.ability;
      const sweep = h('span.cd-sweep');
      const secs = h('span.cd-secs');
      const charges = ab.maxCharges !== undefined ? h('span.charges') : null;
      const btnText = h('span');
      const btn = h<HTMLButtonElement>('button.btn.small.ability-cast', { onclick: () => this.castAbility() }, btnText, h('kbd.key-hint.inline', null, 'A'));
      abilityCard = h(
        'div.ability-card',
        null,
        h('button.ability-ico', { attrs: { 'aria-label': ab.name }, onclick: () => this.castAbility() }, img(abilityIcon(i.id, i.branch), 'ico'), sweep, secs, charges),
        h(
          'div.ability-main',
          null,
          h('div.ability-name', null, h('b', null, ab.name), h('span.tag', null, ABILITY_TARGET_TEXT[ab.target] ?? ''), h('span.muted.small', null, ab.maxCharges !== undefined ? '充能制' : `冷却 ${Math.round(ab.cdMax)}s`)),
          h('p.ability-desc', null, ab.desc),
        ),
        btn,
      );
      ability = { card: abilityCard, sweep, secs, btn, btnText, charges };
    }

    const tierCls = TIER_CLS[i.tier] ?? 't4';
    const node = h(
      `div.tower-info.${tierCls}${i.branch ? `.br-${i.branch}` : ''}${i.tier >= 5 ? '.mythic' : ''}`,
      null,
      h(
        'div.info-head',
        null,
        h('span.info-ico', null, img(towerIcon(i.id, i.tier, i.branch, i.level), 'ico')),
        h(
          'div.info-title',
          null,
          h('h3', null, i.name, h('span.tier-badge', null, i.tierName)),
          h('div.lv-row', null, h('span.lv', null, `Lv${i.level}`), starRow ?? pips),
          h('div.xp', null, xpBar, xpText),
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
      abilityCard,
      modeRow,
      h(
        'dl.stats-grid',
        null,
        i.stats.map((s, k) => h('div', null, h('dt', null, s.label), h('dd', null, statEls[k]))),
      ),
      legend ? traitList(i.evoTraits ?? [], true) : null,
      traitList(i.traits, false),
      h('div.record', null, record),
    );
    this.body.replaceChildren(node);
    this.refs = { key, uid: i.uid, xpBar, xpFill, xpText, stars, stats: statEls, modeBtns, upBtn, upLabel, upPrice, upDisc, sellBtn, sellLabel, sellSub, record, ability };
  }

  private applyTower(i: TowerInfo): void {
    const r = this.refs;
    if (!r) return;
    const legend = isLegend(i);
    const stars = i.stars ?? 0;
    r.stars.forEach((s, k) => toggle(s, 'on', k < stars));
    // 经验 / 进化经验
    if (legend) {
      if (stars >= 3 || (i.evoXpNext ?? 0) <= 0) {
        r.xpFill.style.width = '100%';
        setText(r.xpText, stars >= 3 ? '神话 · 已满星' : '进化');
      } else {
        const pct = Math.min(100, (i.evoXp / i.evoXpNext) * 100);
        r.xpFill.style.width = `${pct.toFixed(1)}%`;
        setText(r.xpText, stars === 2 && i.evoXp >= i.evoXpNext ? '经验已满 · 神话需花金币' : `进化 ${fmtNum(Math.floor(i.evoXp))}/${fmtNum(Math.ceil(i.evoXpNext))}`);
      }
    } else if (i.level >= i.maxLevel) {
      r.xpFill.style.width = '100%';
      setText(r.xpText, '满级');
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
    // 升级 / 进化
    const evolving = i.upgradeCost === null && i.evolveCost !== null && i.evolveCost !== undefined;
    if (evolving) {
      r.upBtn.disabled = false;
      setText(r.upLabel, stars >= 2 ? '神话进化' : `进化 ★${stars + 1}`);
      setText(r.upPrice, `${fmtNum(i.evolveCost!)} 金`);
      const d = i.evolveDiscount ?? 0;
      setText(r.upDisc, d > 0.005 ? `经验 −${Math.round(d * 100)}%` : '');
      toggle(r.upDisc, 'show', d > 0.005);
    } else if (i.upgradeCost === null) {
      setText(r.upLabel, legend ? (stars >= 3 ? '已是神话' : '已满级') : '已满级');
      setText(r.upPrice, '');
      setText(r.upDisc, '');
      toggle(r.upDisc, 'show', false);
      r.upBtn.disabled = true;
    } else {
      r.upBtn.disabled = false;
      setText(r.upLabel, i.needsBranch ? '选择传奇分支' : '升级');
      setText(r.upPrice, `${fmtNum(i.upgradeCost)} 金`);
      setText(r.upDisc, i.upgradeDiscount > 0.005 ? `经验 −${Math.round(i.upgradeDiscount * 100)}%` : '');
      toggle(r.upDisc, 'show', i.upgradeDiscount > 0.005);
    }
    toggle(r.upBtn, 'poor', evolving ? !i.canAffordEvolve : i.upgradeCost !== null && !i.canAffordUpgrade);
    toggle(r.upBtn, 'branch', i.needsBranch);
    toggle(r.upBtn, 'evolve', evolving);
    toggle(r.upBtn, 'mythic-up', evolving && stars >= 2);
    // 主动能力
    const a = r.ability;
    const ab = i.ability;
    if (a && ab) {
      const charged = ab.maxCharges !== undefined;
      const hasCharge = charged && (ab.charges ?? 0) > 0;
      let pct = 0;
      if (!ab.ready && ab.cdMax > 0 && ab.cd > 0 && !hasCharge) pct = Math.max(0, Math.min(1, ab.cd / ab.cdMax));
      a.sweep.style.setProperty('--cd', `${(pct * 360).toFixed(1)}deg`);
      setText(a.secs, !ab.ready && ab.cd > 0 && !hasCharge ? fmtSec(ab.cd) : '');
      if (a.charges) setText(a.charges, `${ab.charges ?? 0}/${ab.maxCharges ?? 0}`);
      const aiming = ui.state.abilityAiming === i.uid;
      setText(a.btnText, aiming ? '取消' : ab.ready ? '释放' : charged && !hasCharge ? '无充能' : '冷却中');
      a.btn.disabled = !ab.ready && !aiming;
      toggle(a.card, 'ready', ab.ready);
      toggle(a.card, 'aiming', aiming);
    }
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

  /** U：升级；Lv10 之后为进化（★3 = 神话，必须花金币） */
  upgrade(): void {
    const i = this.info;
    if (!i) return;
    if (i.upgradeCost === null) {
      if (i.evolveCost !== null && i.evolveCost !== undefined) this.ctx.cmd({ type: 'evolve', uid: i.uid });
      return;
    }
    if (i.needsBranch) {
      audio.play('click');
      this.ctx.openBranch(i.uid);
      return;
    }
    this.ctx.cmd({ type: 'upgrade', uid: i.uid });
  }

  /** A：释放选中神话塔的能力 */
  castAbility(): void {
    const i = this.info;
    if (!i?.ability) return;
    castTowerAbility(this.ctx, i.uid, i);
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
