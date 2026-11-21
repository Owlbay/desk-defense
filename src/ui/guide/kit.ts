/**
 * 图鉴页的小工具：富文本（**加粗**）、编号列表、分节、表格。
 * 所有文字都来自 t('guide.…') 或 core 的 *_META，这里不写死任何文案。
 */
import { t, tOr } from '../../i18n';
import { h, type Child } from '../dom';

export const TAB_IDS = ['play', 'tower', 'enemy', 'affix', 'skill', 'combo', 'ai', 'faq'] as const;
export type TabId = (typeof TAB_IDS)[number];

/** 可搜索、可深链的条目：#guide/<tab>/<id> */
export interface Entry {
  tab: TabId;
  id: string;
  title: string;
  /** 参与搜索的正文（纯文本） */
  text: string;
  icon?: string;
}

export interface GuidePath {
  tab: TabId;
  item?: string;
}

/** 各分类页渲染时拿到的上下文 */
export interface TabContext {
  /** 当前要定位的条目（深链 / 搜索结果） */
  item?: string;
  /** 跳到别的条目 */
  go(path: GuidePath): void;
  /** 关闭图鉴并打开游戏里的其它页面 */
  openRoute(name: 'ai' | 'settings' | 'skills' | 'talents'): void;
}

export interface TabModule {
  entries(): Entry[];
  render(ctx: TabContext): HTMLElement;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `**文字**` → <strong>，其余原样转义 */
export function richHtml(s: string): string {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/** 去掉加粗标记，得到纯文本（搜索用） */
export const plain = (s: string): string => s.replace(/\*\*/g, '');

export function rich(sel: string, text: string): HTMLElement {
  return h(sel, { html: richHtml(text) });
}

/** 读取 base.1、base.2…（连续编号）对应的文本 */
export function items(base: string): string[] {
  const out: string[] = [];
  for (let i = 1; i < 60; i++) {
    const s = tOr(`${base}.${i}`, '');
    if (!s) break;
    out.push(s);
  }
  return out;
}

export function bullets(base: string, ordered = false): HTMLElement {
  return h(
    ordered ? 'ol.guide-list' : 'ul.guide-list',
    null,
    items(base).map((s) => rich('li', s)),
  );
}

/** 一节：带锚点的标题 + 内容 */
export function section(id: string, title: string, ...children: Child[]): HTMLElement {
  return h(
    'section.guide-section.card',
    { data: { item: id }, attrs: { id: `guide-${id}`, tabindex: '-1' } },
    h('h2.guide-h2', null, title),
    children,
  );
}

/** 表格：外面包一层可横向滚动的容器（窄屏不撑破页面） */
export function table(head: Child[], rows: Child[][], cls = ''): HTMLElement {
  return h(
    'div.guide-table-wrap',
    { attrs: { tabindex: '0', role: 'group' } },
    h(
      `table.guide-table${cls}`,
      null,
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          head.map((c) => h('th', { attrs: { scope: 'col' } }, c)),
        ),
      ),
      h(
        'tbody',
        null,
        rows.map((r) =>
          h(
            'tr',
            null,
            r.map((c, i) => (i === 0 ? h('th', { attrs: { scope: 'row' } }, c) : h('td', null, c))),
          ),
        ),
      ),
    ),
  );
}

/** "标签 数值" 的小方块 */
export function stat(label: string, value: Child, cls = ''): HTMLElement {
  return h(`div.guide-stat${cls}`, null, h('span.guide-stat-label', null, label), h('span.guide-stat-value', null, value));
}

export function tag(text: string, cls = ''): HTMLElement {
  return h(`span.tag.guide-tag${cls}`, null, text);
}

/** 美术图标（装饰性；名字就在旁边，所以 alt 为空） */
export function icon(src: string, cls = 'guide-ico', size?: number): HTMLElement {
  const i = document.createElement('img');
  i.src = src;
  i.alt = '';
  i.className = cls;
  i.draggable = false;
  i.decoding = 'async';
  i.loading = 'lazy';
  if (size) {
    i.width = size;
    i.height = size;
  }
  return i;
}

/** 解锁条件：'default' → 开局可用；'2-5' → 战役 2-5 */
export function unlockLabel(unlock: string | undefined): string {
  const m = /^(\d+)-(\d+)$/.exec(unlock ?? '');
  return m ? t('guide.unlock.campaign', { c: m[1], w: m[2] }) : t('guide.unlock.default');
}

export const yesNo = (b: boolean): string => (b ? t('guide.yes') : t('guide.no'));
