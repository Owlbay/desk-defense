/**
 * 设置 →「AI 助手」页面的外壳：只有标题和加载占位，模型设置表单（连同 Agent 代码）进入页面时才 import()。
 * 这里保存的设置是全局的：对局里的 AI 按钮（任何模式）与「AI 参战」共用。
 */
import { t } from '../../i18n';
import { screenHeader, type App, type Screen } from '../App';
import { audio } from '../audio';
import { h } from '../dom';

export function aiAssistantScreen(app: App): Screen {
  const loading = (): HTMLElement => h('div.ai-loading', { attrs: { role: 'status' } }, h('span.ai-spinner', { attrs: { 'aria-hidden': 'true' } }), t('agent.setup.loading'));
  const body = h('div.screen-body.ai-body', null, loading());
  const el = h('div.screen.ai-screen.ai-assistant-screen', null, screenHeader(app, t('ui.assist.title'), { chips: false, back: { name: 'settings' } }), body);
  let destroyed = false;
  let cleanup: (() => void) | null = null;
  const load = (): void => {
    void import('../ai/assist')
      .then((m) => {
        if (destroyed) return;
        cleanup = m.mountAiAssistant(app, body);
      })
      .catch((e: unknown) => {
        console.error('[ai] assistant load failed', e);
        if (destroyed) return;
        body.replaceChildren(
          h(
            'div.empty-state',
            null,
            h('p', null, t('agent.setup.loadFailed')),
            h('small.muted', null, t('agent.setup.loadFailedHint')),
            h('button.btn.small', { attrs: { type: 'button' }, onclick: () => (audio.play('click'), body.replaceChildren(loading()), load()) }, t('agent.setup.retry')),
          ),
        );
      });
  };
  load();
  return {
    el,
    onEsc() {
      app.go({ name: 'settings' });
      return true;
    },
    destroy() {
      destroyed = true;
      cleanup?.();
    },
  };
}
