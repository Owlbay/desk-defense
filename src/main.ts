import './styles/motion.css';
import './styles/main.css';
import './styles/screens-motion.css';
import './styles/hud-motion.css';
import './styles/online.css';
import './styles/responsive.css';
import './styles/ai.css';
import './styles/replay.css';
import './styles/update.css';

import { ui } from './game/UiStore';
import { getLocale, onLocaleChange, setLocale, t } from './i18n';
import { configureOnline, initOnline } from './meta/online';
import { ProfileStore } from './meta/profile';
import { apiBaseUrl } from './platform';
import { App, applySettings } from './ui/App';
import { audio } from './ui/audio';
import { gameScreen } from './ui/hud/GameScreen';
import { resolveLocale } from './ui/locale';
import { aiScreen } from './ui/screens/ai';
import { aiAssistantScreen } from './ui/screens/aiAssistant';
import { campaignScreen } from './ui/screens/campaign';
import { customScreen } from './ui/screens/custom';
import { dailyScreen } from './ui/screens/daily';
import { endlessScreen } from './ui/screens/endless';
import { installGuideRoute } from './ui/screens/guide';
import { leaderboardScreen } from './ui/screens/leaderboard';
import { menuScreen } from './ui/screens/menu';
import { settingsScreen } from './ui/screens/settings';
import { skillsScreen } from './ui/screens/skills';
import { talentsScreen } from './ui/screens/talents';
import { backupOnVersionChange, initUpdates, upgradeForStaleChunk } from './ui/update';

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) return;
  // 换了版本后第一次启动：读存档之前先把旧版本留下的存档原样备份一份（升级本身不动存档，这是额外的保险）
  backupOnVersionChange();
  // 语言：存档里的选择优先，否则按浏览器语言。字典加载完再渲染第一屏（很快）
  const store = new ProfileStore();
  const locale = resolveLocale(store);
  try {
    await setLocale(locale);
  } catch (e) {
    console.error(e); // 字典加载失败：退回源语言（简体中文）
  }
  document.documentElement.lang = getLocale();
  document.title = t('ui.docTitle');
  onLocaleChange(() => (document.title = t('ui.docTitle')));
  root.replaceChildren();
  root.classList.add('app');

  // 禁止长按菜单、双指缩放、双击缩放
  document.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement | null;
    if (!t?.closest('input, textarea')) e.preventDefault();
  });
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  let lastTouch = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = Date.now();
      if (now - lastTouch < 300 && !(e.target as HTMLElement | null)?.closest('input, textarea')) e.preventDefault();
      lastTouch = now;
    },
    { passive: false },
  );

  audio.install();
  applySettings(store.get().settings);
  // 部署了新版本后，旧页面去加载已被替换的分包会失败：自动刷新一次拿到新版本（60 秒内只刷新一次，避免循环）
  window.addEventListener('vite:preloadError', (e) => {
    try {
      const last = Number(sessionStorage.getItem('dd.reloadAt') ?? 0);
      if (Date.now() - last < 60_000) return;
      sessionStorage.setItem('dd.reloadAt', String(Date.now()));
    } catch {
      return;
    }
    e.preventDefault();
    // 有等待中的新版本 Service Worker 时激活它（否则刷新后旧 Service Worker 仍会给出旧页面）
    if (!upgradeForStaleChunk()) location.reload();
  });
  // 联网：探测排行榜接口并补交离线时排队的成绩（失败不影响游戏）
  configureOnline({ baseUrl: apiBaseUrl() });
  void initOnline().catch(() => undefined);

  const app = new App(root, store);
  app.register('menu', (a) => menuScreen(a));
  app.register('campaign', (a) => campaignScreen(a));
  app.register('endless', (a) => endlessScreen(a));
  app.register('custom', (a) => customScreen(a));
  app.register('skills', (a, r) => skillsScreen(a, r));
  app.register('talents', (a) => talentsScreen(a));
  app.register('leaderboard', (a) => leaderboardScreen(a));
  app.register('daily', (a) => dailyScreen(a));
  app.register('settings', (a) => settingsScreen(a));
  app.register('game', (a, r) => gameScreen(a, r));
  // AI 参战（文档 10）：页面外壳很小，表单与 Agent 代码进入页面时才动态加载
  app.register('ai', (a) => aiScreen(a));
  // 设置 →「AI 助手」：全局模型设置（对局里的 AI 按钮与「AI 参战」共用），表单进入页面时才加载
  app.register('aiAssistant', (a) => aiAssistantScreen(a));
  app.go({ name: 'menu' });
  // 在线升级：定时检查新版本，提示玩家点一下升级；升级后第一次打开展示更新内容（src/ui/update.ts）
  initUpdates(app);
  // 图鉴与玩法：注册路由；地址带 #guide/… 时直接打开（内容进入页面时才动态加载）
  installGuideRoute(app);

  // 调试入口（仅开发环境）
  if (import.meta.env.DEV) (window as unknown as { __dd?: unknown }).__dd = { app, store, ui };
}

void boot();
