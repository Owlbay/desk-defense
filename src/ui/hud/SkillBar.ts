import type { SkillId, SkillState, TowerState, WorldState } from '../../core/types';
import { t } from '../../i18n';
import { ui } from '../../game/UiStore';
import { abilityIcon, skillIcon } from '../assets';
import { audio } from '../audio';
import { SKILL_META, TOWER_META } from '../coreMeta';
import { h, img, setText, toggle } from '../dom';
import { G } from '../icons';
import { castTowerAbility } from './abilities';
import { fmtSec, SKILL_KEYS, type GameCtx } from './context';
import { replay } from './motion';

interface AbilityBtn {
  uid: number;
  el: HTMLButtonElement;
  sweep: HTMLElement;
  secs: HTMLElement;
  charges: HTMLElement | null;
  cdMax: number;
  maxCharges: number | undefined;
  lastPct: number;
  wasReady: boolean | null;
}

/**
 * 充能显示：不超过 5 格时画成小圆点（充能 / 消耗时圆点弹一下），更多则退回「n/m」文字。
 * 只在数值变化时写 DOM。
 */
function setCharges(el: HTMLElement, n: number, max: number): void {
  const key = `${n}/${max}`;
  if (el.dataset.v === key) return;
  const first = el.dataset.v === undefined;
  el.dataset.v = key;
  el.setAttribute('aria-label', t('ui.skillbar.charges', { v: key }));
  if (max > 5 || max <= 0) {
    el.classList.remove('dots');
    el.textContent = key;
    return;
  }
  if (el.childElementCount !== max) {
    el.classList.add('dots');
    el.replaceChildren(...Array.from({ length: max }, () => h('i')));
  }
  for (let k = 0; k < max; k++) {
    const d = el.children[k] as HTMLElement;
    const on = k < n;
    if (d.classList.contains('on') === on) continue;
    d.classList.toggle('on', on);
    if (!first) replay(d, on ? 'gain' : 'spend', 420);
  }
}

/** 技能栏右侧「塔能力」区最多显示的神话塔数（文档 11 §1.4） */
const MAX_TOWER_ABILITIES = 4;

interface Btn {
  wrap: HTMLElement;
  el: HTMLButtonElement;
  sweep: HTMLElement;
  secs: HTMLElement;
  charges: HTMLElement | null;
  axis: HTMLButtonElement | null;
  lastPct: number;
  wasReady: boolean;
}

export class SkillBar {
  readonly el: HTMLElement;
  private btns = new Map<SkillId, Btn>();
  private order: SkillId[] = [];
  private sig = '';
  private list: HTMLElement;
  private strip: HTMLElement;
  private stripList: HTMLElement;
  private abil: AbilityBtn[] = [];
  private abilSig = '';

  constructor(private ctx: GameCtx) {
    this.list = h('div.skill-list');
    this.stripList = h('div.ability-list');
    this.stripTitle = h('span.strip-title');
    this.strip = h('div.ability-strip', null, this.stripTitle, this.stripList);
    this.strip.hidden = true;
    this.el = h('div.skillbar', { attrs: { role: 'toolbar' } }, this.list, this.strip);
    this.labelStatic();
  }

  private stripTitle: HTMLElement;

  private labelStatic(): void {
    this.strip.setAttribute('aria-label', t('ui.skillbar.towerAbilities'));
    this.stripTitle.textContent = t('ui.skillbar.towerAbilities');
    this.el.setAttribute('aria-label', t('ui.skillbar.skills'));
  }

  /** 切换语言：刷新固定标签，下次 update 时重建按钮（名字 / 说明按新语言） */
  relabel(): void {
    this.labelStatic();
    this.sig = '';
    this.abilSig = '';
  }

  buttonFor(id: SkillId): HTMLElement | null {
    return this.btns.get(id)?.el ?? null;
  }

  pickIndex(i: number): void {
    const id = this.order[i];
    if (id) this.pick(id);
  }

  toggleAxis(): void {
    const next = ui.state.aimAxis === 'row' ? 'col' : 'row';
    ui.set({ aimAxis: next });
    audio.play('click');
    this.syncAiming();
  }

  pick(id: SkillId): void {
    const s = this.ctx.world.state.skills.find((k) => k.id === id);
    if (!s) return;
    if (ui.state.aiming === id) {
      audio.play('click');
      ui.set({ aiming: null, relocateFrom: null, pending: null });
      return;
    }
    if (!s.ready) {
      audio.play('error');
      const name = SKILL_META[id]?.name ?? id;
      this.ctx.toast(s.maxCharges ? t('ui.skillbar.noChargesRegen', { name }) : t('ui.game.cooldown', { name, s: fmtSec(s.cd) }), 'warn');
      return;
    }
    if (s.target === 'none') {
      this.ctx.cmd({ type: 'cast', skill: id });
      ui.set({ aiming: null, relocateFrom: null });
      return;
    }
    if (s.target === 'spawner') {
      // 封箱胶带：已点选空降点 / 场上只有一个时直接释放
      const drops = this.ctx.world.state.spawners.filter((sp) => sp.kind === 'drop');
      const chosen = ui.state.spawnerSelected !== null && drops.some((d) => d.id === ui.state.spawnerSelected) ? ui.state.spawnerSelected : drops.length === 1 ? drops[0].id : null;
      if (drops.length === 0) {
        audio.play('error');
        this.ctx.toast(t('ui.skillbar.noDrops'), 'warn');
        return;
      }
      if (chosen !== null) {
        const r = this.ctx.cmd({ type: 'cast', skill: id, spawner: chosen });
        if (r.ok) ui.set({ aiming: null, spawnerSelected: null });
        return;
      }
    }
    audio.play('select');
    ui.set({
      aiming: id,
      build: null,
      relocateFrom: null,
      pending: null,
      abilityAiming: null,
      selected: s.target === 'tower' || s.target === 'tower+cell' ? ui.state.selected : null,
    });
  }

  update(st: WorldState): void {
    const sig = st.skills.map((s) => s.id).join(',');
    if (sig !== this.sig) this.rebuild(st.skills);
    for (const s of st.skills) {
      const b = this.btns.get(s.id);
      if (!b) continue;
      const charged = s.maxCharges !== undefined;
      let pct = 0;
      if (!s.ready && s.cdMax > 0 && s.cd > 0) pct = Math.max(0, Math.min(1, s.cd / s.cdMax));
      if (charged && (s.charges ?? 0) > 0) pct = 0;
      if (Math.abs(pct - b.lastPct) > 0.002) {
        b.lastPct = pct;
        b.sweep.style.setProperty('--cd', `${(pct * 360).toFixed(1)}deg`);
      }
      setText(b.secs, !s.ready && s.cd > 0 && !(charged && (s.charges ?? 0) > 0) ? fmtSec(s.cd) : '');
      if (b.charges) setCharges(b.charges, s.charges ?? 0, s.maxCharges ?? 0);
      toggle(b.el, 'ready', s.ready);
      toggle(b.el, 'cooling', !s.ready);
      if (s.ready && !b.wasReady) replay(b.el, 'ping', 650);
      b.wasReady = s.ready;
    }
    this.updateAbilities(st);
  }

  // ───────────── 塔能力 ─────────────

  private updateAbilities(st: WorldState): void {
    const mythic: TowerState[] = [];
    for (const t of st.towers.values()) if (t.stars === 3) mythic.push(t);
    mythic.sort((a, b) => a.uid - b.uid);
    const shown = mythic.slice(0, MAX_TOWER_ABILITIES);
    const sig = shown.map((t) => t.uid).join(',');
    if (sig !== this.abilSig) this.rebuildAbilities(shown, sig);
    for (const b of this.abil) {
      const t = st.towers.get(b.uid);
      if (!t) continue;
      const cd = Math.max(0, t.abilityCd ?? 0);
      const charges = t.abilityCharges;
      const charged = b.maxCharges !== undefined;
      const ready = charged ? (charges ?? 0) > 0 : cd <= 0;
      let pct = 0;
      if (!ready && !charged && b.cdMax > 0) pct = Math.max(0, Math.min(1, cd / b.cdMax));
      if (Math.abs(pct - b.lastPct) > 0.002) {
        b.lastPct = pct;
        b.sweep.style.setProperty('--cd', `${(pct * 360).toFixed(1)}deg`);
      }
      setText(b.secs, !ready && !charged && cd > 0 ? fmtSec(cd) : '');
      if (b.charges) setCharges(b.charges, charges ?? 0, b.maxCharges ?? 0);
      toggle(b.el, 'ready', ready);
      toggle(b.el, 'cooling', !ready);
      if (ready && b.wasReady === false) replay(b.el, 'ping', 650);
      b.wasReady = ready;
      toggle(b.el, 'aiming', ui.state.abilityAiming === b.uid);
    }
  }

  private rebuildAbilities(towers: TowerState[], sig: string): void {
    this.abil = [];
    this.stripList.replaceChildren();
    for (const tw of towers) {
      const info = this.ctx.world.getTowerInfo(tw.uid);
      const ab = info?.ability;
      if (!info || !ab) continue;
      const sweep = h('span.cd-sweep');
      const secs = h('span.cd-secs');
      const charges = ab.maxCharges !== undefined ? h('span.charges') : null;
      const el = h<HTMLButtonElement>(
        'button.skill-btn.ability-btn',
        {
          title: `${ab.name} · ${t('ui.build.nameRole', { name: TOWER_META[tw.id]?.name ?? tw.id, role: info.tierName })}\n${ab.desc}`,
          attrs: { 'aria-label': ab.name },
          onclick: () => castTowerAbility(this.ctx, tw.uid),
        },
        img(abilityIcon(tw.id, tw.branch), 'ico'),
        sweep,
        secs,
        charges,
      );
      this.stripList.appendChild(el);
      this.abil.push({ uid: tw.uid, el, sweep, secs, charges, cdMax: ab.cdMax, maxCharges: ab.maxCharges, lastPct: -1, wasReady: null });
    }
    // 能力信息还没就绪时下次重试
    this.abilSig = this.abil.length === towers.length ? sig : '';
    this.strip.hidden = this.abil.length === 0;
  }

  syncAiming(): void {
    for (const [id, b] of this.btns) {
      const on = ui.state.aiming === id;
      toggle(b.el, 'aiming', on);
      b.el.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (b.axis) {
        toggle(b.axis, 'show', on);
        b.axis.innerHTML = '';
        b.axis.appendChild(h('span.gi', { html: ui.state.aimAxis === 'row' ? G.axisRow : G.axisCol }));
        b.axis.title = ui.state.aimAxis === 'row' ? t('ui.skillbar.axisRow') : t('ui.skillbar.axisCol');
      }
    }
  }

  private rebuild(skills: SkillState[]): void {
    this.sig = skills.map((s) => s.id).join(',');
    this.list.replaceChildren();
    this.btns.clear();
    this.order = skills.map((s) => s.id);
    skills.forEach((s, i) => {
      const meta = SKILL_META[s.id];
      const sweep = h('span.cd-sweep');
      const secs = h('span.cd-secs');
      const charges = s.maxCharges !== undefined ? h('span.charges') : null;
      const el = h<HTMLButtonElement>(
        'button.skill-btn',
        {
          title: `${t('ui.build.nameRole', { name: meta?.name ?? s.id, role: SKILL_KEYS[i] ?? '' })}\n${meta?.desc ?? ''}`,
          attrs: { 'aria-label': meta?.name ?? s.id, 'aria-pressed': 'false' },
          onclick: () => this.pick(s.id),
        },
        img(skillIcon(s.id), 'ico'),
        sweep,
        secs,
        charges,
        SKILL_KEYS[i] ? h('kbd.key-hint', null, SKILL_KEYS[i]) : null,
        s.level > 1 ? h('span.skill-lv', null, `${s.level}`) : null,
      );
      const axis =
        s.target === 'line'
          ? h<HTMLButtonElement>('button.axis-btn', {
              attrs: { 'aria-label': t('ui.skillbar.axisToggle') },
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                this.toggleAxis();
              },
            })
          : null;
      const wrap = h('div.skill-wrap', null, el, axis, h('span.skill-name', null, meta?.name ?? s.id));
      this.list.appendChild(wrap);
      this.btns.set(s.id, { wrap, el, sweep, secs, charges, axis, lastPct: -1, wasReady: s.ready });
    });
    this.syncAiming();
  }
}
