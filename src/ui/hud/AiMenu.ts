/**
 * 对局里的 AI 按钮（顶栏，快捷键 I）与小菜单：让 AI 替我玩（玩家）/ 让 AI 给建议（军师）/ 停止 AI / 配置模型…
 * 以及顶栏的「AI 协助」标记。所有模式的对局都有；AI 面板与 Agent 代码在启用时才按需加载（src/ui/ai/assist.ts）。
 */
import { t } from '../../i18n';
import { isAiAssisted } from '../../meta/aiAssist';
import { audio } from '../audio';
import { AI_GLYPH } from '../ai/icon';
import type { AiLaunch, AiRole, AiSlot } from '../ai/launch';
import { h, setText } from '../dom';
import { G } from '../icons';
import type { GameCtx } from './context';

type Item = { el: HTMLButtonElement; title: HTMLElement; sub: HTMLElement };

export class AiMenu {
  readonly btn: HTMLButtonElement;
  /** 顶栏的「AI 协助」标记 */
  readonly badge: HTMLElement;
  private label: HTMLElement;
  private menu: HTMLElement;
  private items: { player: Item; advisor: Item; stop: Item; config: Item };
  private note: HTMLElement;
  private isOpen = false;
  private busy = false;
  private ended = false;
  private closeConfig: (() => void) | null = null;
  private offSlot: () => void;
  private destroyed = false;

  constructor(
    private ctx: GameCtx,
    private slot: AiSlot,
    /** 弹窗挂载点（div.g-modals） */
    private host: HTMLElement,
    /** 菜单第一次打开 / 按钮被用到（新手提示据此收起） */
    private onUsed: () => void = () => {},
  ) {
    this.label = h('span.ai-btn-label', null, 'AI');
    this.btn = h<HTMLButtonElement>(
      'button.btn.ai-btn',
      {
        attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'ai-menu' },
        onclick: () => (audio.play('click'), this.toggle()),
      },
      h('span.gi', { html: AI_GLYPH }),
      this.label,
    );
    this.badge = h('span.badge.ai-assist-badge.ai-top-badge');
    this.badge.hidden = true;

    const item = (glyph: string, role: 'menuitemradio' | 'menuitem', on: () => void): Item => {
      const title = h('b');
      const sub = h('small');
      const el = h<HTMLButtonElement>(
        'button.ai-menu-item',
        { attrs: { type: 'button', role }, onclick: () => on() },
        h('span.gi', { html: glyph }),
        h('span.ai-menu-text', null, title, sub),
      );
      return { el, title, sub };
    };
    this.items = {
      player: item(G.bolt, 'menuitemradio', () => void this.enable('player')),
      advisor: item(G.eye, 'menuitemradio', () => void this.enable('advisor')),
      stop: item(G.close, 'menuitem', () => this.stop()),
      config: item(G.sliders, 'menuitem', () => void this.openConfig(null)),
    };
    this.note = h('p.ai-menu-note');
    this.menu = h(
      'div.ai-menu',
      { attrs: { id: 'ai-menu', role: 'menu' } },
      this.items.player.el,
      this.items.advisor.el,
      h('div.ai-menu-sep', { attrs: { role: 'separator' } }),
      this.items.stop.el,
      this.items.config.el,
      this.note,
    );
    this.menu.hidden = true;
    this.menu.addEventListener('keydown', (e) => this.onMenuKey(e));
    this.offSlot = slot.subscribe(() => this.paint());
    this.relabel();
  }

  /** 菜单挂到对局根元素上（绝对定位在按钮下方） */
  mount(root: HTMLElement): void {
    root.appendChild(this.menu);
  }

  relabel(): void {
    const tip = t('ui.assist.button');
    this.btn.title = tip;
    this.btn.setAttribute('aria-label', tip);
    this.menu.setAttribute('aria-label', t('ui.assist.menu'));
    setText(this.items.player.title, t('ui.assist.menuPlayer'));
    setText(this.items.player.sub, t('ui.assist.menuPlayerSub'));
    setText(this.items.advisor.title, t('ui.assist.menuAdvisor'));
    setText(this.items.advisor.sub, t('ui.assist.menuAdvisorSub'));
    setText(this.items.stop.title, t('ui.assist.stop'));
    setText(this.items.config.title, t('ui.assist.configure'));
    this.paint();
  }

  paint(): void {
    const s = this.slot;
    const role = s.role;
    const assisted = isAiAssisted(s.assist);
    this.btn.classList.toggle('on', role !== null);
    this.btn.dataset.role = role ?? '';
    this.btn.classList.toggle('busy', this.busy || s.loading);
    this.btn.disabled = this.ended && role === null;
    for (const r of ['player', 'advisor'] as const) {
      const it = this.items[r];
      const on = role === r;
      it.el.setAttribute('aria-checked', on ? 'true' : 'false');
      it.el.classList.toggle('on', on);
      it.el.disabled = this.busy || this.ended || s.dedicated;
    }
    this.items.stop.el.disabled = role === null || this.ended;
    setText(this.items.stop.sub, s.dedicated ? t('ui.assist.stopDedicatedSub') : t('ui.assist.stopSub'));
    setText(this.items.config.sub, role ? t('ui.assist.currentModel', { model: s.label }) : t('ui.assist.configureSub'));
    setText(this.note, s.dedicated ? t('ui.assist.dedicatedNote') : assisted ? t('ui.assist.markedNote') : t('ui.assist.fairnessShort'));
    // 顶栏标记：AI 在场时显示；替我玩过的对局即使停用了也保留（本局已记为 AI 协助）
    const show = role !== null || assisted;
    this.badge.hidden = !show;
    if (show) {
      const advisorOnly = role === 'advisor' && !assisted;
      setText(this.badge, advisorOnly ? t('ui.assist.badgeAdvisor') : t('ui.assist.badge'));
      this.badge.classList.toggle('advisor', advisorOnly);
      this.badge.classList.toggle('idle', role === null);
      this.badge.title = assisted ? t('ui.assist.badgeTip') : t('ui.assist.badgeAdvisorTip');
    }
    this.ctx.root.classList.toggle('ai-assisted', assisted);
  }

  toggle(): void {
    if (this.isOpen) this.close(true);
    else this.open();
  }

  open(): void {
    if (this.isOpen || this.destroyed) return;
    this.onUsed();
    this.isOpen = true;
    this.paint();
    this.menu.hidden = false;
    this.btn.setAttribute('aria-expanded', 'true');
    this.place();
    document.addEventListener('pointerdown', this.onOutside, true);
    const first = [this.items.player, this.items.advisor, this.items.stop, this.items.config].find((i) => !i.el.disabled);
    requestAnimationFrame(() => first?.el.focus({ preventScroll: true }));
  }

  close(focusBtn = false): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.menu.hidden = true;
    this.btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.onOutside, true);
    if (focusBtn) this.btn.focus({ preventScroll: true });
  }

  /** 对局结束：停用菜单（AI 面板由插槽收尾） */
  end(): void {
    this.ended = true;
    this.close();
    this.closeConfig?.();
    this.paint();
  }

  private onOutside = (e: Event): void => {
    const tg = e.target;
    if (tg instanceof Node && (this.menu.contains(tg) || this.btn.contains(tg))) return;
    this.close();
  };

  /** 菜单放在按钮下方，右边对齐，不超出对局区域 */
  private place(): void {
    const root = this.ctx.root.getBoundingClientRect();
    const r = this.btn.getBoundingClientRect();
    const w = this.menu.offsetWidth;
    const right = Math.max(8, root.right - r.right);
    const left = root.width - right - w;
    this.menu.style.top = `${Math.round(r.bottom - root.top + 6)}px`;
    this.menu.style.right = `${Math.round(left < 8 ? Math.max(8, root.width - w - 8) : right)}px`;
  }

  private onMenuKey(e: KeyboardEvent): void {
    const list = [this.items.player, this.items.advisor, this.items.stop, this.items.config].map((i) => i.el).filter((b) => !b.disabled);
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = list.length;
      if (n) list[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      list[e.key === 'Home' ? 0 : list.length - 1]?.focus();
    } else if (e.key === 'Escape' || (e.key.toLowerCase() === 'i' && !e.repeat)) {
      e.preventDefault();
      this.close(true);
    } else if (e.key === 'Tab') {
      this.close();
      return;
    }
    // 菜单里的按键不触发对局快捷键（数字建塔等）
    e.stopPropagation();
  }

  /** 弹窗期间暂停对局（系统暂停，不打开暂停菜单），返回恢复函数 */
  private hold(): () => void {
    const s = this.ctx.session;
    const prev = s.autoPaused;
    s.setAutoPaused(true);
    return () => {
      if (!this.destroyed) s.setAutoPaused(prev);
    };
  }

  private toastOn(role: AiRole, launch: AiLaunch): void {
    this.ctx.toast(
      role === 'player' ? t('ui.assist.enabledPlayer', { model: launch.label }) : t('ui.assist.enabledAdvisor', { model: launch.label }),
      'good',
    );
  }

  /** 启用（或切换到）某个角色：按保存的模型设置；没有可用的模型时问要不要离线演示 / 去配置 */
  async enable(role: AiRole): Promise<void> {
    this.close();
    if (this.busy || this.ended || this.destroyed) return;
    if (this.slot.dedicated) return void this.ctx.toast(t('ui.assist.dedicatedNote'), 'info');
    if (this.slot.role === role) return;
    audio.play('click');
    this.busy = true;
    this.paint();
    let release: (() => void) | null = null;
    try {
      const m = await import('../ai/assist');
      if (this.destroyed || this.ended) return;
      const r = m.resolveAssistLaunch(role);
      let launch: AiLaunch | null = r.ok ? r.launch : null;
      if (!r.ok) {
        release = this.hold();
        const c = await m.offerDialog(this.host, role, r.reason);
        if (this.destroyed || this.ended) return;
        if (c === 'demo') launch = m.demoLaunch(role);
        else if (c === 'config') {
          release();
          release = null;
          this.busy = false;
          void this.openConfig(role);
          return;
        }
      }
      if (!launch) return;
      this.slot.attach(launch);
      this.toastOn(role, launch);
    } catch (e) {
      console.error('[ai] assist load failed', e);
      this.ctx.toast(t('agent.setup.loadFailedToast'), 'warn');
    } finally {
      release?.();
      this.busy = false;
      this.paint();
    }
  }

  stop(): void {
    this.close(true);
    if (this.slot.role === null) return;
    audio.play('click');
    const dedicated = this.slot.dedicated;
    this.slot.detach();
    this.ctx.toast(dedicated ? t('agent.hud.tookOver') : t('ui.assist.stopped'), 'info');
    this.paint();
  }

  /** 模型设置（覆盖在对局上，期间暂停）；role 给出时底部是「保存并启用」 */
  async openConfig(role: AiRole | null): Promise<void> {
    this.close();
    if (this.closeConfig || this.destroyed) return;
    audio.play('click');
    this.busy = true;
    this.paint();
    try {
      const m = await import('../ai/assist');
      if (this.destroyed) return;
      const release = this.hold();
      this.closeConfig = m.openConfigOverlay(this.ctx.app, this.host, {
        role: this.slot.dedicated || this.ended ? null : role,
        onClose: (r) => {
          this.closeConfig = null;
          release();
          if (this.destroyed || this.ended) return;
          if (r.launch) {
            this.slot.attach(r.launch);
            this.toastOn(r.launch.role, r.launch);
          } else if (r.changed && this.slot.role && !this.slot.dedicated) {
            // 改了设置：当前的 AI 按新设置重新启动（从当前局面开始）
            const rr = m.resolveAssistLaunch(this.slot.role);
            if (rr.ok) {
              this.slot.attach(rr.launch);
              this.ctx.toast(t('ui.assist.restarted', { model: rr.launch.label }), 'info');
            }
          }
          this.paint();
        },
      });
    } catch (e) {
      console.error('[ai] config load failed', e);
      this.ctx.toast(t('agent.setup.loadFailedToast'), 'warn');
    } finally {
      this.busy = false;
      this.paint();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.close();
    this.closeConfig?.();
    this.offSlot();
    this.menu.remove();
  }
}
