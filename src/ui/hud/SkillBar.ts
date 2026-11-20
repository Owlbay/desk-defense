import type { SkillId, SkillState, TowerState, WorldState } from '../../core/types';
import { ui } from '../../game/UiStore';
import { abilityIcon, skillIcon } from '../assets';
import { audio } from '../audio';
import { SKILL_META, TOWER_META } from '../coreMeta';
import { h, img, setText, toggle } from '../dom';
import { G } from '../icons';
import { castTowerAbility } from './abilities';
import { fmtSec, SKILL_KEYS, type GameCtx } from './context';

interface AbilityBtn {
  uid: number;
  el: HTMLButtonElement;
  sweep: HTMLElement;
  secs: HTMLElement;
  charges: HTMLElement | null;
  cdMax: number;
  maxCharges: number | undefined;
  lastPct: number;
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
    this.strip = h('div.ability-strip', { attrs: { 'aria-label': '塔能力' } }, h('span.strip-title', null, '塔能力'), this.stripList);
    this.strip.hidden = true;
    this.el = h('div.skillbar', { attrs: { role: 'toolbar', 'aria-label': '技能' } }, this.list, this.strip);
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
      this.ctx.toast(s.maxCharges ? `${name}：没有充能了（每 3 波恢复 1 次）` : `${name} 冷却中（${fmtSec(s.cd)} 秒）`, 'warn');
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
        this.ctx.toast('场上没有空降出生点', 'warn');
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
      if (b.charges) setText(b.charges, `${s.charges ?? 0}/${s.maxCharges ?? 0}`);
      toggle(b.el, 'ready', s.ready);
      toggle(b.el, 'cooling', !s.ready);
      if (s.ready && !b.wasReady) {
        b.el.classList.remove('ping');
        void b.el.offsetWidth;
        b.el.classList.add('ping');
      }
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
      if (b.charges) setText(b.charges, `${charges ?? 0}/${b.maxCharges ?? 0}`);
      toggle(b.el, 'ready', ready);
      toggle(b.el, 'cooling', !ready);
      toggle(b.el, 'aiming', ui.state.abilityAiming === b.uid);
    }
  }

  private rebuildAbilities(towers: TowerState[], sig: string): void {
    this.abil = [];
    this.stripList.replaceChildren();
    for (const t of towers) {
      const info = this.ctx.world.getTowerInfo(t.uid);
      const ab = info?.ability;
      if (!info || !ab) continue;
      const sweep = h('span.cd-sweep');
      const secs = h('span.cd-secs');
      const charges = ab.maxCharges !== undefined ? h('span.charges') : null;
      const el = h<HTMLButtonElement>(
        'button.skill-btn.ability-btn',
        {
          title: `${ab.name} · ${TOWER_META[t.id]?.name ?? t.id}（${info.tierName}）\n${ab.desc}`,
          attrs: { 'aria-label': ab.name },
          onclick: () => castTowerAbility(this.ctx, t.uid),
        },
        img(abilityIcon(t.id, t.branch), 'ico'),
        sweep,
        secs,
        charges,
      );
      this.stripList.appendChild(el);
      this.abil.push({ uid: t.uid, el, sweep, secs, charges, cdMax: ab.cdMax, maxCharges: ab.maxCharges, lastPct: -1 });
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
        b.axis.title = ui.state.aimAxis === 'row' ? '横向（按 T 切换）' : '纵向（按 T 切换）';
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
          title: `${meta?.name ?? s.id}（${SKILL_KEYS[i] ?? ''}）\n${meta?.desc ?? ''}`,
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
              attrs: { 'aria-label': '切换横竖' },
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
