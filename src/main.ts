import './styles/motion.css';
import './styles/main.css';
import './styles/screens-motion.css';
import './styles/hud-motion.css';
import './styles/online.css';
import './styles/responsive.css';
import './styles/ai.css';
import { ui } from './game/UiStore';
import { ProfileStore } from './meta/profile';
import { App, applySettings } from './ui/App';
import { audio } from './ui/audio';
import { initOnline } from './meta/online';
import { registerSW } from 'virtual:pwa-register';
import { campaignScreen } from './ui/screens/campaign';
import { customScreen } from './ui/screens/custom';
import { endlessScreen } from './ui/screens/endless';
import { leaderboardScreen } from './ui/screens/leaderboard';
import { dailyScreen } from './ui/screens/daily';
import { menuScreen } from './ui/screens/menu';
import { settingsScreen } from './ui/screens/settings';
import { skillsScreen } from './ui/screens/skills';
import { talentsScreen } from './ui/screens/talents';
import { gameScreen } from './ui/hud/GameScreen';
import { aiScreen } from './ui/screens/ai';

function boot(): void {
  const root = document.getElementById('app');
  if (!root) return;
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

  const store = new ProfileStore();
  audio.install();
  applySettings(store.get().settings);
  // PWA：打开游戏时检查更新，发现新版本立即激活并刷新页面（否则玩家要手动刷新两次才能看到新版本）。
  // 只在启动时检查，不做定时检查，避免对局中途被刷新。
  if (!import.meta.env.DEV) registerSW({ immediate: true });
  // 联网：探测排行榜接口并补交离线时排队的成绩（失败不影响游戏）
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
  app.go({ name: 'menu' });

  // 调试入口（仅开发环境）
  if (import.meta.env.DEV) (window as unknown as { __dd?: unknown }).__dd = { app, store, ui };
}

boot();
