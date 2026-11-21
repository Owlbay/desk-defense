/**
 * 「图鉴与玩法」页面的外壳：只有标题和加载占位；内容（各分类、搜索、塔的数值计算、样式）进入页面时才 import()。
 * 深链：#guide、#guide/tower/pencil、#guide/enemy/boss_coffee …（installGuideRoute 负责注册路由并监听地址栏）。
 */
import { t } from '../../i18n';
import { type App, type Route, type Screen, screenHeader } from '../App';
import { audio } from '../audio';
import { h } from '../dom';
import { parseGuideHash } from '../guide/hash';

type GuideRoute = Extract<Route, { name: 'guide' }>;

function setHash(path: string | null): void {
  try {
    const url = `${location.pathname}${location.search}${path === null ? '' : `#guide${path ? `/${path}` : ''}`}`;
    history.replaceState(history.state, '', url);
  } catch {
    /* 某些内嵌环境不允许改地址：深链只是锦上添花 */
  }
}

export function guideScreen(app: App, route: GuideRoute): Screen {
  const loading = () =>
    h('div.ai-loading', { attrs: { role: 'status' } }, h('span.ai-spinner', { attrs: { 'aria-hidden': 'true' } }), t('guide.loading'));
  const body = h('div.guide-body', null, loading());
  const el = h('div.screen.guide-screen', null, screenHeader(app, t('guide.title'), { chips: false }), body);

  let destroyed = false;
  let path = route.path;
  let handle: import('../guide').GuideHandle | null = null;

  const onHash = (): void => {
    const p = parseGuideHash(location.hash);
    if (p !== null) handle?.navigate(p);
  };
  window.addEventListener('hashchange', onHash);

  const load = (): void => {
    void import('../guide')
      .then((m) => {
        if (destroyed) return;
        handle = m.mountGuide(app, body, path, (p) => {
          // 记到路由上：切换语言时 App 会用同一个路由重建页面，位置不丢
          path = route.path = p;
          setHash(p);
        });
      })
      .catch((e: unknown) => {
        console.error('[guide] 图鉴加载失败', e);
        if (destroyed) return;
        body.replaceChildren(
          h(
            'div.empty-state',
            null,
            h('p', null, t('guide.loadFail')),
            h('small.muted', null, t('guide.loadFail.hint')),
            h(
              'button.btn.small',
              { attrs: { type: 'button' }, onclick: () => (audio.play('click'), body.replaceChildren(loading()), load()) },
              t('guide.retry'),
            ),
          ),
        );
      });
  };
  load();

  return {
    el,
    destroy() {
      destroyed = true;
      window.removeEventListener('hashchange', onHash);
      handle?.destroy();
      if (parseGuideHash(location.hash) !== null) setHash(null);
    },
    onEsc: () => handle?.onEsc() ?? false,
  };
}

/**
 * 注册图鉴路由，并让 #guide…（以及 #leaderboard）深链生效：启动时地址带 #guide 就直接打开图鉴；
 * 之后地址栏的 hash 变成 #guide… 也会打开（对局进行中不打断）。在 app.go('menu') 之后调用。
 */
export function installGuideRoute(app: App): void {
  app.register('guide', (a, r) => guideScreen(a, r as GuideRoute));
  const sync = (): void => {
    if (app.route.name === 'game') return;
    // 介绍页页脚的「排行榜」链接：/#leaderboard
    if (location.hash === '#leaderboard') {
      setHash(null);
      if (app.route.name !== 'leaderboard') app.go({ name: 'leaderboard' });
      return;
    }
    const p = parseGuideHash(location.hash);
    if (p === null || app.route.name === 'guide') return;
    app.go({ name: 'guide', path: p });
  };
  window.addEventListener('hashchange', sync);
  sync();
}
