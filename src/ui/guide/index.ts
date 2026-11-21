/**
 * 图鉴与玩法（游戏内）：分类标签 + 搜索 + 深链（#guide/<分类>/<条目>）。
 * 这个模块连同样式由 screens/guide.ts 动态加载，不进主包。
 */
import '../../styles/guide.css';
import { t } from '../../i18n';
import type { App } from '../App';
import { audio } from '../audio';
import { clear, h } from '../dom';
import { G } from '../icons';
import { icon, TAB_IDS, type Entry, type GuidePath, type TabContext, type TabId, type TabModule } from './kit';
import { affixTab } from './tabs/affixes';
import { aiTab } from './tabs/ai';
import { comboTab } from './tabs/combos';
import { enemyTab } from './tabs/enemies';
import { faqTab } from './tabs/faq';
import { playTab } from './tabs/play';
import { skillTab } from './tabs/skills';
import { towerTab } from './tabs/towers';

const TABS: Record<TabId, TabModule> = {
  play: playTab,
  tower: towerTab,
  enemy: enemyTab,
  affix: affixTab,
  skill: skillTab,
  combo: comboTab,
  ai: aiTab,
  faq: faqTab,
};

export interface GuideHandle {
  destroy(): void;
  /** 外部（地址栏 hash 变化）要求跳转 */
  navigate(path: string): void;
  onEsc(): boolean;
}

/** 'tower/pencil' → { tab: 'tower', item: 'pencil' }；认不出的分类回到「玩法」 */
export function parsePath(path: string | undefined): GuidePath {
  const [tab, ...rest] = (path ?? '').split('/').filter(Boolean);
  const item = rest.join('/') || undefined;
  return (TAB_IDS as readonly string[]).includes(tab) ? { tab: tab as TabId, item } : { tab: 'play' };
}

export const formatPath = (p: GuidePath): string => (p.item ? `${p.tab}/${p.item}` : p.tab);

const MAX_RESULTS = 40;

function snippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text.length > 90 ? `${text.slice(0, 90)}…` : text;
  const from = Math.max(0, i - 24);
  const to = Math.min(text.length, i + q.length + 60);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

export function mountGuide(app: App, host: HTMLElement, initial: string | undefined, onPath: (path: string) => void): GuideHandle {
  let cur = parsePath(initial);
  let query = '';
  let index: Entry[] | null = null;
  let destroyed = false;

  const input = h<HTMLInputElement>('input.guide-search-input', {
    attrs: { type: 'search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search' },
    oninput: () => {
      query = input.value.trim();
      renderContent(false);
    },
  });
  const clearBtn = h('button.guide-search-clear', { attrs: { type: 'button' }, onclick: () => setQuery('', true) }, h('span.gi', { html: G.close, attrs: { 'aria-hidden': 'true' } }));
  const searchBox = h('div.guide-search', { attrs: { role: 'search' } }, input, clearBtn);
  const tabBar = h('div.guide-tabs', { attrs: { role: 'tablist' } });
  const status = h('p.guide-status', { attrs: { role: 'status', 'aria-live': 'polite' } });
  const content = h('div.guide-content', { attrs: { id: 'guide-panel', role: 'tabpanel', tabindex: '-1' } });
  const scroller = h('div.guide-scroll', null, status, content);
  const root = h('div.guide', null, h('div.guide-bar', null, searchBox, tabBar), scroller);
  host.replaceChildren(root);

  const ctx = (): TabContext => ({
    item: cur.item,
    go,
    openRoute: (name) => {
      audio.play('click');
      app.go({ name });
    },
  });

  function setQuery(q: string, focus: boolean): void {
    query = q;
    input.value = q;
    renderContent(false);
    if (focus) input.focus();
  }

  function go(path: GuidePath): void {
    if (destroyed) return;
    audio.play('click');
    cur = path;
    query = '';
    input.value = '';
    onPath(formatPath(cur));
    renderTabs();
    renderContent(true);
  }

  function renderTabs(): void {
    clear(tabBar);
    tabBar.setAttribute('aria-label', t('guide.tabs.label'));
    for (const id of TAB_IDS) {
      const on = id === cur.tab;
      tabBar.appendChild(
        h(
          `button.guide-tab-btn${on ? '.on' : ''}`,
          {
            attrs: { type: 'button', role: 'tab', id: `guide-tab-${id}`, 'aria-selected': on ? 'true' : 'false', 'aria-controls': 'guide-panel', tabindex: on ? '0' : '-1' },
            onclick: () => go({ tab: id }),
          },
          t(`guide.tab.${id}`),
        ),
      );
    }
    tabBar.querySelector<HTMLElement>('.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  // 标签栏：左右方向键切换（WAI-ARIA tabs）
  tabBar.addEventListener('keydown', (e) => {
    const i = TAB_IDS.indexOf(cur.tab);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? TAB_IDS.length - 1 : -1;
    if (next < 0 && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    go({ tab: TAB_IDS[(next + TAB_IDS.length) % TAB_IDS.length] });
    tabBar.querySelector<HTMLElement>('.on')?.focus();
  });

  function renderResults(): void {
    index ??= TAB_IDS.flatMap((id) => TABS[id].entries());
    const q = query.toLowerCase();
    const inTitle = index.filter((e) => e.title.toLowerCase().includes(q));
    const inText = index.filter((e) => !inTitle.includes(e) && e.text.toLowerCase().includes(q));
    const hits = [...inTitle, ...inText];
    content.removeAttribute('aria-labelledby');
    if (!hits.length) {
      status.textContent = t('guide.search.empty', { q: query });
      content.appendChild(h('div.empty-state', null, h('p', null, t('guide.search.empty', { q: query })), h('small.muted', null, t('guide.search.emptyHint'))));
      return;
    }
    status.textContent = t('guide.search.count', { n: hits.length });
    content.appendChild(
      h(
        'ul.guide-results',
        null,
        hits.slice(0, MAX_RESULTS).map((e) =>
          h(
            'li',
            null,
            h(
              'a.guide-result.card',
              { attrs: { href: `#guide/${e.tab}/${e.id}` }, onclick: (ev: Event) => (ev.preventDefault(), go({ tab: e.tab, item: e.id })) },
              e.icon ? icon(e.icon, 'guide-ico', 40) : h('span.guide-ico.blank', { attrs: { 'aria-hidden': 'true' } }),
              h('span.guide-result-main', null, h('strong', null, e.title), e.text ? h('small.muted', null, snippet(e.text, q)) : null),
              h('span.tag', null, t(`guide.tab.${e.tab}`)),
            ),
          ),
        ),
      ),
    );
  }

  function renderContent(focusTarget: boolean): void {
    clear(content);
    clearBtn.hidden = !query;
    root.classList.toggle('searching', !!query);
    if (query) {
      renderResults();
      scroller.scrollTop = 0;
      return;
    }
    status.textContent = '';
    content.setAttribute('aria-labelledby', `guide-tab-${cur.tab}`);
    content.appendChild(TABS[cur.tab].render(ctx()));
    const target = cur.item ? content.querySelector<HTMLElement>(`[data-item="${CSS.escape(cur.item)}"]`) : null;
    if (!target) {
      scroller.scrollTop = 0;
      return;
    }
    if (target instanceof HTMLDetailsElement) target.open = true;
    target.classList.add('is-target');
    // 等布局完成再滚动（图片有固定宽高，不会再跳）
    requestAnimationFrame(() => {
      if (destroyed) return;
      scroller.scrollTop = Math.max(0, target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 8);
      if (focusTarget) target.focus({ preventScroll: true });
    });
  }

  function renderChrome(): void {
    input.placeholder = t('guide.search.placeholder');
    input.setAttribute('aria-label', t('guide.search.label'));
    clearBtn.setAttribute('aria-label', t('guide.search.clear'));
    renderTabs();
  }

  renderChrome();
  renderContent(false);
  onPath(formatPath(cur));

  return {
    destroy() {
      destroyed = true;
    },
    navigate(path) {
      const next = parsePath(path);
      if (next.tab === cur.tab && next.item === cur.item) return;
      cur = next;
      query = '';
      input.value = '';
      renderTabs();
      renderContent(true);
    },
    onEsc() {
      if (query) {
        setQuery('', false);
        return true;
      }
      if (cur.tab === 'tower' && cur.item) {
        go({ tab: 'tower' });
        return true;
      }
      return false;
    },
  };
}
