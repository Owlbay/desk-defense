/**
 * 全局 AI 助手（动态分包，连同 src/agent 的纯逻辑）：
 *  - resolveAssistLaunch：按保存的模型设置（「AI 助手」/「AI 参战」共用）生成启动参数；
 *  - offerDialog：还没配置模型 / 配置不完整时，问玩家用离线演示还是去配置；
 *  - openConfigOverlay：对局里打开的模型设置（同一个 AiModelConfigForm，覆盖在棋盘上，期间游戏暂停）；
 *  - mountAiAssistant：设置 →「AI 助手」页面的内容。
 * Key 按玩家选的存放方式读取，只随配置发给所选的模型服务商。
 */
import type { App } from '../App';
import { audio } from '../audio';
import { h, setText } from '../dom';
import { G } from '../icons';
import { t } from '../../i18n';
import { getBridge, bridgeProvider } from './bridge-state';
import { AI_GLYPH } from './icon';
import type { AiLaunch, AiRole } from './launch';
import { mountAiModelConfigForm, type AiModelConfigForm } from './model-form';
import { buildModelConfig, decisionFor, modelConfigErrors, relayNeedsDetect, sourceLabelOf } from './model-config';
import { hasSavedSetup, loadSetup, saveSetup, type AiSetupSaved } from './store';

export type ResolveResult = { ok: true; launch: AiLaunch } | { ok: false; reason: string | null };

const roleName = (role: AiRole): string => (role === 'player' ? t('ui.assist.rolePlayer') : t('ui.assist.roleAdvisor'));

/** 保存的设置 + 角色 → 启动参数（不发起任何网络请求） */
export function launchFromSetup(st: AiSetupSaved, role: AiRole): ResolveResult {
  const bridge = getBridge();
  const config = buildModelConfig(st, { role, bridge, perRole: true });
  const errs = modelConfigErrors(st, config, bridge);
  if (errs.length) return { ok: false, reason: errs[0] };
  if (relayNeedsDetect(st)) return { ok: false, reason: t('ui.assist.needDetect') };
  const provider = st.tab === 'bridge' ? bridgeProvider() : undefined;
  return {
    ok: true,
    launch: { config, role, mode: decisionFor(st, role, true).mode, label: sourceLabelOf(st, bridge), ...(provider ? { provider } : {}) },
  };
}

/** 对局里启用 AI：按保存的设置；从没保存过设置时 reason = null（先问要不要离线演示） */
export function resolveAssistLaunch(role: AiRole): ResolveResult {
  if (!hasSavedSetup()) return { ok: false, reason: null };
  return launchFromSetup(loadSetup(), role);
}

/** 离线演示（内置脚本策略；军师由 hud 换成「预演后给建议」的演示版） */
export function demoLaunch(role: AiRole): AiLaunch {
  const st = { ...loadSetup(), tab: 'direct' as const, source: 'demo' as const };
  const config = buildModelConfig(st, { role, perRole: true });
  return { config, role, mode: decisionFor(st, role, true).mode, label: t('agent.setup.label.demo') };
}

/** 没有可用的模型：离线演示 / 配置模型 / 取消 */
export function offerDialog(parent: HTMLElement, role: AiRole, reason: string | null): Promise<'demo' | 'config' | null> {
  return new Promise((resolve) => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let done = false;
    const close = (v: 'demo' | 'config' | null): void => {
      if (done) return;
      done = true;
      audio.play('click');
      el.remove();
      document.removeEventListener('keydown', onKey, true);
      if (!v && opener?.isConnected) opener.focus({ preventScroll: true });
      resolve(v);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close(null);
      }
    };
    const demoBtn = h('button.btn.primary', { attrs: { type: 'button' }, onclick: () => close('demo') }, h('span.gi', { html: G.play }), t('ui.assist.useDemo'));
    const el = h(
      'div.overlay.confirm-overlay.ai-offer-overlay',
      { onclick: (e: MouseEvent) => e.target === el && close(null) },
      h(
        'div.dialog.card.ai-offer',
        { attrs: { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'ai-offer-title' } },
        h('div.ai-offer-head', null, h('span.gi.ai-offer-ico', { html: AI_GLYPH }), h('h2', { attrs: { id: 'ai-offer-title' } }, reason ? t('ui.assist.offerInvalidTitle') : t('ui.assist.offerTitle'))),
        h('p', null, reason ? t('ui.assist.offerInvalid', { reason }) : t('ui.assist.offerText', { role: roleName(role) })),
        h('p.muted.small', null, t('ui.assist.offerDemoHint')),
        h(
          'div.row.end.ai-offer-actions',
          null,
          h('button.btn', { attrs: { type: 'button' }, onclick: () => close(null) }, t('common.cancel')),
          h('button.btn', { attrs: { type: 'button' }, onclick: () => close('config') }, h('span.gi', { html: G.sliders }), t('ui.assist.configure')),
          demoBtn,
        ),
      ),
    );
    document.addEventListener('keydown', onKey, true);
    parent.appendChild(el);
    requestAnimationFrame(() => demoBtn.focus());
  });
}

export interface ConfigOverlayResult {
  /** 「保存并启用」时：按新设置生成的启动参数 */
  launch?: AiLaunch;
  /** 设置有改动（当前挂着的 AI 需要重新启动才会用上） */
  changed: boolean;
}

/**
 * 对局里的模型设置：同一个 AiModelConfigForm，覆盖在对局上。
 * role 给出时，底部按钮是「保存并启用（角色）」：校验 + 中转检测通过后返回启动参数。
 */
export function openConfigOverlay(app: App, parent: HTMLElement, o: { role?: AiRole | null; onClose(r: ConfigOverlayResult): void }): () => void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const st = loadSetup();
  let form: AiModelConfigForm | null = null;
  let closed = false;
  const before = (): string => JSON.stringify(form ? form.buildConfig() : {});
  const close = (r: ConfigOverlayResult): void => {
    if (closed) return;
    closed = true;
    form?.destroy();
    el.remove();
    document.removeEventListener('keydown', onKey, true);
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    o.onClose(r);
  };
  const summary = h('p.ai-summary.muted');
  const paint = (): void => {
    if (form) setText(summary, t('ui.assist.currentModel', { model: form.sourceLabel() }));
  };
  form = mountAiModelConfigForm(app, { st, role: () => o.role ?? 'player', perRole: true, onChange: paint });
  const snap = before();
  // 打开即保存一次：之后对局里的 AI 按钮就按这份设置启用（不再询问离线演示）
  saveSetup(st);
  paint();
  const finish = async (): Promise<void> => {
    if (!form || form.busy()) return;
    if (!o.role) {
      audio.play('click');
      form.persist();
      close({ changed: before() !== snap });
      return;
    }
    const errs = form.errors(true);
    if (errs.length) {
      audio.play('error');
      app.toast(errs[0], 'warn');
      form.errBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    audio.play('click');
    if (!(await form.prepare()) || closed) return;
    form.persist();
    const r = launchFromSetup(form.st, o.role);
    if (!r.ok) {
      audio.play('error');
      app.toast(r.reason ?? t('ui.assist.needConfig'), 'warn');
      return;
    }
    audio.play('select');
    close({ launch: r.launch, changed: true });
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !(e.target instanceof HTMLElement && e.target.closest('input, select, textarea'))) {
      e.preventDefault();
      e.stopImmediatePropagation();
      close({ changed: before() !== snap });
    }
  };
  const closeBtn = h('button.btn.icon-btn.ai-config-close', { attrs: { type: 'button', 'aria-label': t('common.close') }, onclick: () => (audio.play('click'), close({ changed: before() !== snap })) }, h('span.gi', { html: G.close }));
  const doneBtn = h(
    'button.btn.primary',
    { attrs: { type: 'button' }, onclick: () => void finish() },
    o.role ? h('span.gi', { html: G.play }) : h('span.gi', { html: G.check }),
    o.role ? t('ui.assist.saveEnable', { role: roleName(o.role) }) : t('ui.assist.done'),
  );
  const el = h(
    'div.overlay.ai-config-overlay',
    null,
    h(
      'div.dialog.card.ai-config-dialog',
      { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ai-config-title' } },
      h('div.ai-config-head', null, h('span.gi', { html: AI_GLYPH }), h('h2', { attrs: { id: 'ai-config-title' } }, t('ui.assist.configTitle')), closeBtn),
      h('div.ai-config-scroll', null, h('p.muted.small', null, t('ui.assist.configIntro')), form.modelCard, form.decisionCard, form.errBox),
      h('div.ai-config-foot', null, summary, doneBtn),
    ),
  );
  // 对局快捷键（数字建塔等）不要穿透到对局
  el.addEventListener('keydown', (e) => e.stopPropagation());
  document.addEventListener('keydown', onKey, true);
  parent.appendChild(el);
  requestAnimationFrame(() => doneBtn.focus({ preventScroll: true }));
  return () => close({ changed: false });
}

/** 设置 →「AI 助手」页面：说明 + 模型设置表单（自动保存） */
export function mountAiAssistant(app: App, body: HTMLElement): () => void {
  const st = loadSetup();
  const summary = h('p.ai-summary.muted');
  const form = mountAiModelConfigForm(app, { st, role: () => 'player', perRole: true, onChange: () => setText(summary, t('ui.assist.currentModel', { model: form.sourceLabel() })) });
  saveSetup(st);
  setText(summary, t('ui.assist.currentModel', { model: form.sourceLabel() }));
  const li = (glyph: string, title: string, text: string): HTMLElement => h('li', null, h('span.gi', { html: glyph }), h('span', null, h('b', null, title), h('small.muted', null, text)));
  body.replaceChildren(
    h(
      'section.card.section.ai-card.ai-assist-intro',
      null,
      h('h3', null, t('ui.assist.howTitle')),
      h(
        'ul.ai-assist-list',
        null,
        li(G.bolt, t('ui.assist.rolePlayer'), t('ui.assist.howPlayer')),
        li(G.eye, t('ui.assist.roleAdvisor'), t('ui.assist.howAdvisor')),
        li(AI_GLYPH, t('ui.assist.howButtonTitle'), t('ui.assist.howButton')),
      ),
      h('p.muted.small', null, t('ui.assist.fairness')),
    ),
    form.modelCard,
    form.decisionCard,
    summary,
    form.errBox,
  );
  return () => form.destroy();
}
