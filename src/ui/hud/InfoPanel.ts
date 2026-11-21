import type { BuildOption, SpawnerState, TargetMode, TowerInfo, WorldState } from '../../core/types';
import { ui } from '../../game/UiStore';
import { abilityIcon, enemyIcon, svgUrl, towerIcon } from '../assets';
import { audio } from '../audio';
import { ENEMY_META, SKILL_META, spawnerName } from '../coreMeta';
import { getLocale, t } from '../../i18n';
import { fmtNum, h, img, setText, toggle } from '../dom';
import { G } from '../icons';
import { ABILITY_TARGET_TEXT, castTowerAbility } from './abilities';
import { fmtSec, TARGET_NAME, type GameCtx } from './context';
import { reduced, replay, sparkle } from './motion';

interface AbilityRefs {
  card: HTMLElement;
  sweep: HTMLElement;
  secs: HTMLElement;
  btn: HTMLButtonElement;
  btnText: HTMLElement;
  charges: HTMLElement | null;
  cdMax: number;
  charged: boolean;
  lastPct: number;
  wasReady: boolean | null;
}

interface TowerRefs {
  key: string;
  uid: number;
  level: number;
  starCount: number;
  lastFill: string;
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
  /** 当前显示内容的「身份」：变了才播放切换动画（同一座塔升级重建不算） */
  private ident = '';
  /** 最近一次花钱升级 / 进化成功的时间（用来区分经验升级） */
  private paidAt = 0;
  private locale = getLocale();

  constructor(private ctx: GameCtx) {
    this.body = h('div.info-body');
    this.el = h('div.infopanel', { attrs: { 'aria-live': 'off' } }, this.body);
  }

  /** 选中塔信息（null 时根据 build / 提示显示） */
  update(info: TowerInfo | null, buildOpt: BuildOption | null): void {
    this.render(info, buildOpt);
    // 给样式用：hint（空）/ build / tower / spawner / aim / abil / perk
    const kind = this.mode.split(':')[0] || 'hint';
    if (this.el.dataset.kind !== kind) this.el.dataset.kind = kind;
  }

  private render(info: TowerInfo | null, buildOpt: BuildOption | null): void {
    this.info = info;
    // 语言切换后：丢掉缓存的结构，按当前状态用新语言重建（身份不变，所以不播切换动画）
    if (this.locale !== getLocale()) {
      this.locale = getLocale();
      this.mode = '';
      this.refs = null;
      this.spRefs = null;
    }
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
    if (ui.state.perkTargeting) return this.setSimple('perk', h('div.info-hint', null, h('span.gi', { html: G.target }), t('ui.info.perkTarget')));
    if (ui.state.abilityAiming !== null) {
      const ti = this.ctx.world.getTowerInfo(ui.state.abilityAiming);
      const ab = ti?.ability;
      const what = ab ? t('ui.info.abilWhat', { name: ab.name, target: ABILITY_TARGET_TEXT[ab.target] ?? t('ui.info.pickTarget') }) : t('ui.info.pickTarget');
      return this.setSimple(`abil:${ui.state.abilityAiming}`, h('div.info-hint', null, h('span.gi', { html: G.sparkle }), t('ui.info.abilHint', { what, cancel: ui.state.touch ? t('ui.info.cancelAbilTouch') : t('ui.info.cancelMouse') })));
    }
    if (buildOpt) {
      const key = `build:${buildOpt.id}:${buildOpt.cost}:${buildOpt.affordable}`;
      const ident = `build:${buildOpt.id}`;
      if (this.mode === key) return;
      const air = t(buildOpt.hitsAir && buildOpt.hitsGround ? 'ui.info.hitsBoth' : buildOpt.hitsAir ? 'ui.info.hitsAir' : buildOpt.hitsGround ? 'ui.info.hitsGround' : 'ui.info.noAttack');
      const touch = ui.state.touch;
      this.setSimple(
        key,
        h(
          'div.build-info',
          null,
          h('div.info-head', null, h('span.info-ico', null, img(towerIcon(buildOpt.id), 'ico')), h('div', null, h('h3', null, buildOpt.name), h('div.tags', null, h('span.tag', null, buildOpt.role), h('span.tag', null, air)))),
          h('p.info-desc', null, buildOpt.desc),
          h('p.muted.small', null, touch ? t('ui.info.buildTouch') : t('ui.info.buildMouse')),
        ),
        ident,
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
          spawnerAim ? t('ui.info.aimSpawner') : ui.state.touch ? t('ui.info.aimTouch') : t('ui.info.aimMouse'),
        ),
      );
    }
    this.setSimple('hint', h('div.info-hint.muted', null, t('ui.info.idle')));
  }

  private setSimple(key: string, node: HTMLElement, ident = key): void {
    if (this.mode === key) return;
    this.mode = key;
    this.swap(node, ident);
  }

  /**
   * 换内容：身份变了就让旧内容原地淡出（绝对定位的残影，不占布局）、新内容滑入。
   * 全程只有 transform / opacity，输入立即作用在新内容上。
   */
  private swap(node: HTMLElement, ident: string): void {
    const changed = ident !== this.ident;
    this.ident = ident;
    const old = this.body.firstElementChild as HTMLElement | null;
    if (!changed || !old || old.classList.contains('info-ghost') || reduced()) {
      this.body.replaceChildren(node);
      return;
    }
    old.classList.remove('info-enter');
    old.classList.add('info-ghost');
    old.setAttribute('aria-hidden', 'true');
    node.classList.add('info-enter');
    this.body.replaceChildren(node, old);
    setTimeout(() => old.remove(), 200);
  }

  /** 每帧调用：只更新能力冷却扇形（一个 CSS 变量），其余内容仍按低频刷新 */
  tickFast(st: WorldState): void {
    const r = this.refs;
    const a = r?.ability;
    if (!r || !a || a.charged || a.cdMax <= 0) return;
    const t = st.towers.get(r.uid);
    if (!t) return;
    this.setSweep(a, Math.max(0, Math.min(1, Math.max(0, t.abilityCd ?? 0) / a.cdMax)));
  }

  private setSweep(a: AbilityRefs, pct: number): void {
    if (Math.abs(pct - a.lastPct) <= 0.002 && !(pct === 0 && a.lastPct !== 0)) return;
    a.lastPct = pct;
    a.sweep.style.setProperty('--cd', `${(pct * 360).toFixed(1)}deg`);
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
    if (sp.warnUntil !== undefined && sp.warnUntil > st.time) status = t('ui.info.sp.warn', { n: Math.ceil(sp.warnUntil - st.time) });
    else if (sp.kind === 'drop' || sp.kind === 'hidden') {
      if (sp.expiresAfterWave !== undefined) {
        const left = sp.expiresAfterWave - st.wave;
        status = left > 0 ? t('ui.info.sp.closesIn', { wave: sp.expiresAfterWave, n: left }) : t('ui.info.sp.closesNow', { wave: sp.expiresAfterWave });
      } else status = sp.active ? t('ui.info.sp.open') : t('ui.info.sp.closed');
    } else status = sp.active ? t('ui.info.sp.open') : t('ui.info.sp.notOpen');
    setText(r.status, status);
    if (r.demolish && sp.demolishCost !== undefined) {
      toggle(r.demolish, 'poor', st.gold < sp.demolishCost);
    }
    if (r.seal) {
      const sk = st.skills.find((s) => s.id === 'seal_tape');
      r.seal.disabled = !sk?.ready;
      setText(r.seal.querySelector('.act-sub') ?? r.seal, sk?.ready ? t('ui.info.sp.sealNow') : t('ui.info.cooldownSec', { s: fmtSec(sk?.cd ?? 0) }));
    }
  }

  private buildSpawner(st: WorldState, sp: SpawnerState, key: string, hasSeal: boolean): void {
    this.mode = 'spawner';
    const drop = sp.kind === 'drop';
    const status = h('p.sp-status');
    const kindName = t(drop ? 'ui.info.sp.drop' : sp.kind === 'hidden' ? 'ui.info.sp.hidden' : 'ui.info.sp.edge');
    let demolish: HTMLButtonElement | null = null;
    let demolishSub: HTMLElement | null = null;
    let seal: HTMLButtonElement | null = null;
    if (drop && sp.demolishCost !== undefined) {
      demolishSub = h('span.act-sub', null, t('ui.info.gold', { n: fmtNum(sp.demolishCost) }));
      demolish = h<HTMLButtonElement>(
        'button.btn.act.demolish',
        {
          onclick: () => {
            const r = this.ctx.cmd({ type: 'demolishSpawner', id: sp.id });
            if (r.ok) ui.set({ spawnerSelected: null });
          },
        },
        h('span.gi', { html: G.hammer }),
        h('span.act-text', null, h('span.act-label', null, t('ui.info.sp.demolish')), demolishSub),
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
        h('span.act-text', null, h('span.act-label', null, SKILL_META.seal_tape?.name ?? t('ui.info.sp.seal')), h('span.act-sub', null, '')),
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
            attrs: { 'aria-label': t('common.close') },
            onclick: () => {
              audio.play('click');
              ui.set({ spawnerSelected: null });
            },
          },
          h('span.gi', { html: G.close }),
        ),
      ),
      sp.icon ? h('p.muted.small', null, t('ui.info.sp.boxIcon', { name: ENEMY_META[sp.icon]?.name ?? sp.icon })) : null,
      demolish || seal ? h('div.actions', null, demolish, seal) : null,
      drop && !hasSeal ? h('p.muted.small', null, t('ui.info.sp.sealTip', { skill: SKILL_META.seal_tape?.name ?? t('ui.info.sp.seal') })) : null,
      !drop ? h('p.muted.small', null, t('ui.info.sp.edgeFixed')) : null,
    );
    this.swap(node, `sp:${sp.id}`);
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
    const prev = this.mode === 'tower' && this.refs && this.refs.uid === i.uid ? this.refs : null;
    const starCount = i.stars ?? 0;
    const lvUp = !!prev && i.level > prev.level;
    const starUp = !!prev && starCount > prev.starCount;
    this.mode = 'tower';
    const legend = isLegend(i);
    const pips = h('span.pips.level-pips');
    for (let k = 1; k <= i.maxLevel; k++) pips.appendChild(h(`span.pip${k <= i.level ? '.on' : ''}${k === 10 ? '.legend' : ''}`));
    const stars: HTMLElement[] = [];
    let starRow: HTMLElement | null = null;
    if (legend) {
      for (let k = 1; k <= 3; k++) stars.push(h(`span.evo-star${k === 3 ? '.mythic' : ''}`, { title: k === 3 ? t('ui.info.mythicStar') : `★${k}` }));
      starRow = h('span.evo-stars', { attrs: { 'aria-label': t('ui.info.evoStars', { n: i.stars ?? 0 }) } }, ...stars);
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
            h('span.muted.small', null, t('ui.info.target')),
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
          h('div.ability-name', null, h('b', null, ab.name), h('span.tag', null, ABILITY_TARGET_TEXT[ab.target] ?? ''), h('span.muted.small', null, ab.maxCharges !== undefined ? t('ui.info.charged') : t('ui.info.cdMax', { n: Math.round(ab.cdMax) }))),
          h('p.ability-desc', null, ab.desc),
        ),
        btn,
      );
      ability = { card: abilityCard, sweep, secs, btn, btnText, charges, cdMax: ab.cdMax, charged: ab.maxCharges !== undefined, lastPct: -1, wasReady: null };
    }

    const lvEl = h('span.lv', null, `Lv${i.level}`);
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
          h('div.lv-row', null, lvEl, starRow ?? pips),
          h('div.xp', null, xpBar, xpText),
        ),
        h(
          'button.btn.icon-btn.close-info',
          {
            attrs: { 'aria-label': t('ui.info.deselect') },
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
    this.swap(node, `tower:${i.uid}`);
    // ── 成长演出（同一座塔重建时才有）──
    if ((lvUp || starUp) && !reduced()) {
      const paid = performance.now() - this.paidAt < 800;
      this.paidAt = 0;
      if (lvUp) {
        (pips.children[i.level - 1] as HTMLElement | undefined)?.classList.add('pop');
        lvEl.classList.add('pop');
        if (!paid) {
          // 靠经验升级：经验条闪光 + 星点
          xpBar.classList.add('lvup');
          sparkle(xpBar.parentElement ?? xpBar, { x: 40, n: 8, spread: 30 });
        }
      }
      if (starUp) {
        const mythic = starCount >= 3;
        stars.forEach((s, k) => {
          if (mythic || k === starCount - 1) {
            s.classList.add('pop');
            s.style.setProperty('--i', String(mythic ? k : 0));
          }
        });
        node.classList.add(mythic ? 'mythic-moment' : 'evo-moment');
        node.appendChild(h('span.info-shimmer', { attrs: { 'aria-hidden': 'true' } }));
        const ico = node.querySelector<HTMLElement>('.info-ico');
        if (ico) sparkle(ico, { n: mythic ? 12 : 8, spread: mythic ? 44 : 32, cls: 'gold' });
        setTimeout(() => {
          node.classList.remove('mythic-moment', 'evo-moment');
          node.querySelector('.info-shimmer')?.remove();
        }, 1700);
      }
      if (paid) {
        upBtn.classList.add('success');
        sparkle(upBtn, { x: 22, n: 8, spread: 30, cls: starUp ? 'gold' : '' });
        setTimeout(() => upBtn.classList.remove('success'), 500);
      }
    }
    this.refs = { key, uid: i.uid, level: i.level, starCount, lastFill: '', xpBar, xpFill, xpText, stars, stats: statEls, modeBtns, upBtn, upLabel, upPrice, upDisc, sellBtn, sellLabel, sellSub, record, ability };
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
        this.setFill(r, 1, true);
        setText(r.xpText, stars >= 3 ? t('ui.info.mythicMax') : t('ui.info.evo'));
      } else {
        const pct = Math.min(100, (i.evoXp / i.evoXpNext) * 100);
        this.setFill(r, pct / 100, false);
        setText(r.xpText, stars === 2 && i.evoXp >= i.evoXpNext ? t('ui.info.evoFullGold') : t('ui.info.evoXp', { a: fmtNum(Math.floor(i.evoXp)), b: fmtNum(Math.ceil(i.evoXpNext)) }));
      }
    } else if (i.level >= i.maxLevel) {
      this.setFill(r, 1, true);
      setText(r.xpText, t('ui.info.maxLevel'));
    } else if (i.xpCapped) {
      this.setFill(r, 1, true);
      setText(r.xpText, t('ui.info.xpFullGold'));
    } else {
      const pct = i.xpNext > 0 ? Math.min(100, (i.xp / i.xpNext) * 100) : 0;
      this.setFill(r, pct / 100, false);
      setText(r.xpText, `${Math.floor(i.xp)}/${Math.ceil(i.xpNext)}`);
    }
    i.stats.forEach((s, k) => r.stats[k] && setText(r.stats[k], s.value));
    for (const [m, b] of r.modeBtns) toggle(b, 'on', i.targetMode === m);
    // 升级 / 进化
    const evolving = i.upgradeCost === null && i.evolveCost !== null && i.evolveCost !== undefined;
    if (evolving) {
      r.upBtn.disabled = false;
      setText(r.upLabel, stars >= 2 ? t('ui.info.mythicEvolve') : t('ui.info.evolveStar', { n: stars + 1 }));
      setText(r.upPrice, t('ui.info.gold', { n: fmtNum(i.evolveCost!) }));
      const d = i.evolveDiscount ?? 0;
      setText(r.upDisc, d > 0.005 ? t('ui.info.xpDisc', { n: Math.round(d * 100) }) : '');
      toggle(r.upDisc, 'show', d > 0.005);
    } else if (i.upgradeCost === null) {
      setText(r.upLabel, legend && stars >= 3 ? t('ui.info.isMythic') : t('ui.info.maxed'));
      setText(r.upPrice, '');
      setText(r.upDisc, '');
      toggle(r.upDisc, 'show', false);
      r.upBtn.disabled = true;
    } else {
      r.upBtn.disabled = false;
      setText(r.upLabel, i.needsBranch ? t('ui.info.chooseBranch') : t('ui.info.upgrade'));
      setText(r.upPrice, t('ui.info.gold', { n: fmtNum(i.upgradeCost) }));
      setText(r.upDisc, i.upgradeDiscount > 0.005 ? t('ui.info.xpDisc', { n: Math.round(i.upgradeDiscount * 100) }) : '');
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
      this.setSweep(a, pct);
      setText(a.secs, !ab.ready && ab.cd > 0 && !hasCharge ? fmtSec(ab.cd) : '');
      if (a.charges) setText(a.charges, `${ab.charges ?? 0}/${ab.maxCharges ?? 0}`);
      const aiming = ui.state.abilityAiming === i.uid;
      setText(a.btnText, aiming ? t('common.cancel') : ab.ready ? t('ui.info.cast') : charged && !hasCharge ? t('ui.info.noCharge') : t('ui.info.cooling'));
      a.btn.disabled = !ab.ready && !aiming;
      toggle(a.card, 'ready', ab.ready);
      if (ab.ready && a.wasReady === false) replay(a.card, 'ding', 600);
      a.wasReady = ab.ready;
      toggle(a.card, 'aiming', aiming);
    }
    // 出售 / 撤销
    const armed = this.sellArmed > performance.now();
    if (i.canUndo) {
      setText(r.sellLabel, t('ui.info.undo', { n: Math.ceil(i.undoRemaining) }));
      setText(r.sellSub, t('ui.info.undoRefund', { n: fmtNum(i.sellValue) }));
    } else if (armed) {
      setText(r.sellLabel, t('ui.info.sellConfirm'));
      setText(r.sellSub, t('ui.info.goldPlus', { n: fmtNum(i.sellValue) }));
    } else {
      setText(r.sellLabel, t('ui.info.sell'));
      setText(r.sellSub, `+${fmtNum(i.sellValue)} · ${Math.round(i.refundRate * 100)}%`);
    }
    toggle(r.sellBtn, 'undo', i.canUndo);
    toggle(r.sellBtn, 'armed', armed && !i.canUndo);
    setText(r.record, t('ui.info.record', { kills: fmtNum(i.kills), dmg: fmtNum(i.damage) }));
  }

  /** 经验条：用 scaleX 表示进度（不改 width，不触发布局） */
  private setFill(r: TowerRefs, p: number, full: boolean): void {
    const v = `scaleX(${Math.max(0, Math.min(1, p)).toFixed(3)})`;
    if (v !== r.lastFill) {
      r.lastFill = v;
      r.xpFill.style.transform = v;
    }
    toggle(r.xpBar, 'full', full);
  }

  /** U：升级；Lv10 之后为进化（★3 = 神话，必须花金币） */
  upgrade(): void {
    const i = this.info;
    if (!i) return;
    if (i.upgradeCost === null) {
      if (i.evolveCost !== null && i.evolveCost !== undefined && this.ctx.cmd({ type: 'evolve', uid: i.uid }).ok) this.paidAt = performance.now();
      return;
    }
    if (i.needsBranch) {
      audio.play('click');
      this.ctx.openBranch(i.uid);
      return;
    }
    if (this.ctx.cmd({ type: 'upgrade', uid: i.uid }).ok) this.paidAt = performance.now();
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
