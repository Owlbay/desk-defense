/**
 * 「AI 参战」设置页的外壳：只有标题和加载占位，表单（连同 Agent 代码）进入页面时才 import()。
 */
import { t } from '../../i18n';
import { screenHeader, type App, type Screen } from '../App';
import { audio } from '../audio';
import { h } from '../dom';

export function aiScreen(app: App): Screen {
  const body = h('div.screen-body.ai-body', null, h('div.ai-loading', { attrs: { role: 'status' } }, h('span.ai-spinner', { attrs: { 'aria-hidden': 'true' } }), t('agent.setup.loading')));
  const el = h('div.screen.ai-screen', null, screenHeader(app, t('agent.setup.title'), { chips: false }), body);
  let destroyed = false;
  let cleanup: (() => void) | null = null;
  const load = (): void => {
    void import('../ai/setup')
      .then((m) => {
        if (destroyed) return;
        cleanup = m.mountAiSetup(app, body);
      })
      .catch((e: unknown) => {
        console.error('[ai] setup load failed', e);
        if (destroyed) return;
        body.replaceChildren(
          h(
            'div.empty-state',
            null,
            h('p', null, t('agent.setup.loadFailed')),
            h('small.muted', null, t('agent.setup.loadFailedHint')),
            h('button.btn.small', { attrs: { type: 'button' }, onclick: () => (audio.play('click'), body.replaceChildren(h('div.ai-loading', null, t('agent.setup.loading'))), load()) }, t('agent.setup.retry')),
          ),
        );
      });
  };
  load();
  return {
    el,
    destroy() {
      destroyed = true;
      cleanup?.();
    },
  };
}
