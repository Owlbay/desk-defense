import type { SkillId, SkillState, WorldState } from '../../core/types';
import { ui } from '../../game/UiStore';
import { skillIcon } from '../assets';
import { audio } from '../audio';
import { SKILL_META } from '../coreMeta';
import { h, img, setText, toggle } from '../dom';
import { G } from '../icons';
import { fmtSec, SKILL_KEYS, type GameCtx } from './context';

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

  constructor(private ctx: GameCtx) {
    this.el = h('div.skillbar', { attrs: { role: 'toolbar', 'aria-label': '技能' } });
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
    audio.play('select');
    ui.set({ aiming: id, build: null, relocateFrom: null, pending: null, selected: s.target === 'tower' || s.target === 'tower+cell' ? ui.state.selected : null });
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
    this.el.replaceChildren();
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
      this.el.appendChild(wrap);
      this.btns.set(s.id, { wrap, el, sweep, secs, charges, axis, lastPct: -1, wasReady: s.ready });
    });
    this.syncAiming();
  }
}
