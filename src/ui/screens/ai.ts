/**
 * 「AI 参战」设置页的外壳：只有标题和加载占位，表单（连同 Agent 代码）进入页面时才 import()。
 */
import { screenHeader, type App, type Screen } from '../App';
import { audio } from '../audio';
import { h } from '../dom';

export function aiScreen(app: App): Screen {
  const body = h('div.screen-body.ai-body', null, h('div.ai-loading', { attrs: { role: 'status' } }, h('span.ai-spinner', { attrs: { 'aria-hidden': 'true' } }), '正在加载 AI 模块…'));
  const el = h('div.screen.ai-screen', null, screenHeader(app, 'AI 参战', { chips: false }), body);
  let destroyed = false;
  let cleanup: (() => void) | null = null;
  const load = (): void => {
    void import('../ai/setup')
      .then((m) => {
        if (destroyed) return;
        cleanup = m.mountAiSetup(app, body);
      })
      .catch((e: unknown) => {
        console.error('[ai] 设置页加载失败', e);
        if (destroyed) return;
        body.replaceChildren(
          h(
            'div.empty-state',
            null,
            h('p', null, 'AI 模块加载失败'),
            h('small.muted', null, '请检查网络后重试。'),
            h('button.btn.small', { attrs: { type: 'button' }, onclick: () => (audio.play('click'), body.replaceChildren(h('div.ai-loading', null, '正在加载 AI 模块…')), load()) }, '重试'),
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
