/**
 * 在线升级与更新日志（界面部分）。
 *
 * - PWA 用 registerType: 'prompt'：新版本的 Service Worker 在后台装好后等待，不会自己接管页面。
 * - 定时（启动 5 秒后、之后每 10 分钟、切回前台时）请求 version.json；发现版本号比当前大，就在右下角弹出升级卡片，
 *   列出新版本的更新内容。点「立即升级」：激活等待中的新版本并刷新页面（对局中会先确认）。
 * - 升级后第一次打开：弹出「已更新到 vX」卡片，列出这次跨过的所有版本的更新内容。
 * - changelogDialog()：完整更新日志（设置页底部的「版本 · 更新日志」按钮）。
 */
import { registerSW } from 'virtual:pwa-register';

import { getLocale, t } from '../i18n';
import {
  APP_VERSION,
  CHANGELOG,
  type ChangelogEntry,
  compareVersions,
  entriesBetween,
  notesOf,
  parseRemoteVersion,
  type RemoteVersion,
} from '../meta/version';
import { nativeShell } from '../platform';
import { type App, confirmDialog } from './App';
import { audio } from './audio';
import { h } from './dom';
import { DUR, motionOK } from './screens/motion';

const SEEN_KEY = 'dd.seenVersion';
const DISMISS_KEY = 'dd.updateDismissed';
const CHECK_EVERY_MS = 10 * 60_000;

let updateSW: ((reload?: boolean) => Promise<void>) | null = null;
let registration: ServiceWorkerRegistration | null = null;
let swWaiting = false;
let remote: RemoteVersion | null = null;
let card: HTMLElement | null = null;
let upgrading = false;
let appRef: App | null = null;

const storage = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 隐私模式等：忽略 */
    }
  },
  sget(k: string): string | null {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  sset(k: string, v: string): void {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      /* 忽略 */
    }
  },
};

const fmtVersion = (v: string): string => `v${v.replace(/^v/, '')}`;

function notesList(entries: readonly ChangelogEntry[], o: { heads?: boolean } = {}): HTMLElement {
  const loc = getLocale();
  return h(
    'div.changelog-list',
    null,
    ...entries.map((e) =>
      h(
        'section.changelog-entry',
        null,
        o.heads === false ? null : h('h3', null, h('b', null, fmtVersion(e.version)), e.date ? h('small.muted', null, e.date) : null),
        h('ul', null, ...notesOf(e, loc).map((n) => h('li', null, n))),
      ),
    ),
  );
}

/** 完整更新日志对话框 */
export function changelogDialog(parent: HTMLElement): void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const close = () => {
    audio.play('click');
    overlay.classList.add('out');
    setTimeout(() => overlay.remove(), motionOK() ? DUR.s + 40 : 0);
    document.removeEventListener('keydown', onKey, true);
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close();
    }
  };
  const closeBtn = h('button.btn.primary', { attrs: { type: 'button' }, onclick: close }, t('common.close'));
  const overlay = h(
    'div.overlay.confirm-overlay',
    { onclick: (e: MouseEvent) => e.target === overlay && close() },
    h(
      'div.dialog.card.changelog-dialog',
      { attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('ui.update.changelog') } },
      h('h2', null, t('ui.update.changelog')),
      h('p.muted', null, t('ui.update.current', { v: fmtVersion(APP_VERSION) })),
      notesList(CHANGELOG),
      h('div.row.end', null, closeBtn),
    ),
  );
  document.addEventListener('keydown', onKey, true);
  parent.appendChild(overlay);
  requestAnimationFrame(() => closeBtn.focus());
}

function removeCard(): void {
  if (!card) return;
  const c = card;
  card = null;
  c.classList.add('out');
  setTimeout(() => c.remove(), motionOK() ? 260 : 0);
}

function showCard(el: HTMLElement): void {
  if (!appRef) return;
  card?.remove();
  card = el;
  appRef.root.appendChild(el);
}

/** 正在对局（还没结束）时升级会丢掉本波进度：先确认 */
async function confirmInGame(): Promise<boolean> {
  const app = appRef;
  if (!app || app.route.name !== 'game') return true;
  if (document.querySelector('.game-screen .gameover-overlay')) return true;
  return confirmDialog(app.root, { title: t('ui.update.inGameTitle'), text: t('ui.update.inGameText'), ok: t('ui.update.now') });
}

/** 等新版本的 Service Worker 装好（最多 ms 毫秒） */
async function waitForWaiting(ms: number): Promise<boolean> {
  const reg = registration;
  if (!reg) return false;
  if (reg.waiting) return true;
  try {
    await reg.update();
  } catch {
    /* 离线等 */
  }
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (reg.waiting) return true;
    if (!reg.installing && !reg.waiting && Date.now() - t0 > 1500) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !!reg.waiting;
}

/** 执行升级：激活等待中的新版本并刷新；没有 Service Worker 时直接刷新 */
export async function applyUpdate(): Promise<void> {
  if (upgrading) return;
  upgrading = true;
  storage.sset('dd.reloadAt', String(Date.now()));
  try {
    if (updateSW && (swWaiting || (await waitForWaiting(8000)))) {
      // 新 Service Worker 接管后 workbox-window 会刷新页面；兜底再手动刷新一次
      setTimeout(() => location.reload(), 4000);
      await updateSW(true);
      return;
    }
  } catch (e) {
    console.warn('[update]', e);
  }
  location.reload();
}

function updateCard(r: RemoteVersion | null): HTMLElement {
  const entries = r?.changelog ? entriesBetween(r.changelog, APP_VERSION, r.version) : [];
  const btn = h(
    'button.btn.primary',
    {
      attrs: { type: 'button' },
      onclick: async () => {
        audio.play('click');
        if (!(await confirmInGame())) return;
        btn.setAttribute('disabled', '');
        btn.textContent = t('ui.update.applying');
        void applyUpdate();
      },
    },
    t('ui.update.now'),
  );
  return h(
    'aside.update-card.card',
    { attrs: { role: 'status', 'aria-live': 'polite' } },
    h(
      'div.update-head',
      null,
      h('b', null, r ? t('ui.update.available', { v: fmtVersion(r.version) }) : t('ui.update.availableGeneric')),
      h('small.muted', null, t('ui.update.current', { v: fmtVersion(APP_VERSION) })),
    ),
    entries.length ? notesList(entries, { heads: entries.length > 1 }) : null,
    h(
      'div.row.end',
      null,
      h(
        'button.btn',
        {
          attrs: { type: 'button' },
          onclick: () => {
            audio.play('click');
            if (r) storage.sset(DISMISS_KEY, r.version);
            removeCard();
          },
        },
        t('ui.update.later'),
      ),
      btn,
    ),
  );
}

function maybeShowUpdate(): void {
  if (upgrading) return;
  const newer = remote && compareVersions(remote.version, APP_VERSION) > 0;
  if (!newer && !swWaiting) return;
  if (remote && storage.sget(DISMISS_KEY) === remote.version) return;
  if (card?.classList.contains('update-card') && card.dataset.v === (remote?.version ?? '')) return;
  const el = updateCard(newer ? remote : null);
  el.dataset.v = remote?.version ?? '';
  showCard(el);
}

let lastCheck = 0;
async function check(): Promise<void> {
  lastCheck = Date.now();
  void registration?.update().catch(() => undefined);
  try {
    const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) remote = parseRemoteVersion(await res.json()) ?? remote;
  } catch {
    /* 离线：下次再查 */
  }
  maybeShowUpdate();
}

/** 升级后第一次打开：展示跨过的版本的更新内容 */
function showWhatsNew(): void {
  const seen = storage.get(SEEN_KEY);
  storage.set(SEEN_KEY, APP_VERSION);
  if (!seen || compareVersions(APP_VERSION, seen) <= 0) return;
  const entries = entriesBetween(CHANGELOG, seen, APP_VERSION);
  if (!entries.length) return;
  showCard(
    h(
      'aside.update-card.whats-new.card',
      { attrs: { role: 'status', 'aria-live': 'polite' } },
      h('div.update-head', null, h('b', null, t('ui.update.updated', { v: fmtVersion(APP_VERSION) }))),
      notesList(entries, { heads: entries.length > 1 }),
      h(
        'div.row.end',
        null,
        h(
          'button.btn.primary',
          {
            attrs: { type: 'button' },
            onclick: () => {
              audio.play('click');
              removeCard();
            },
          },
          t('ui.update.gotIt'),
        ),
      ),
    ),
  );
}

/** 启动时调用一次（main.ts） */
export function initUpdates(app: App): void {
  appRef = app;
  showWhatsNew();
  // 原生壳（Tauri / Capacitor）的网页随安装包发布，不走在线升级；开发环境没有 version.json
  if (import.meta.env.DEV || nativeShell()) return;
  updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      swWaiting = true;
      maybeShowUpdate();
    },
    onRegisteredSW(_url, reg) {
      registration = reg ?? null;
    },
  });
  setTimeout(() => void check(), 5000);
  setInterval(() => void check(), CHECK_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastCheck > 60_000) void check();
  });
}

/**
 * 旧页面加载已被新部署替换掉的分包失败（vite:preloadError）：直接升级到新版本。
 * 返回 false 表示不处理（交给调用方的刷新兜底）。
 */
export function upgradeForStaleChunk(): boolean {
  if (!updateSW) return false;
  void applyUpdate();
  return true;
}
