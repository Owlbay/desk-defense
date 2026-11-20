import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/** 只属于 AI 参战的模块：src/agent、AI 面板，以及除 Phaser 外的所有第三方依赖（游戏本体只依赖 Phaser） */
const AI_MODULE_RE = /\/src\/agent\/|\/src\/ui\/ai\/|\/node_modules\/(?!phaser\/)/;

export default defineConfig({
  base: './',
  server: { port: 5173 },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      // Phaser 单独成包：游戏代码更新时，玩家浏览器里缓存的引擎不用重新下载
      output: {
        manualChunks: (id: string) => (id.includes('node_modules/phaser') ? 'phaser' : undefined),
        // AI 参战（文档 10）：Agent 逻辑与模型 SDK（pi / @anthropic-ai/sdk 及其依赖）只经 dynamic import() 加载。
        // 这些分包单独放到 assets/ai/：不进 PWA 预缓存（否则安装时就会把几 MB 的 SDK 全下载下来），第一次用到时再缓存。
        chunkFileNames: (chunk: { name: string; moduleIds?: string[] }) =>
          chunk.name !== 'phaser' && (chunk.moduleIds ?? []).some((id) => AI_MODULE_RE.test(id.replace(/\\/g, '/')))
            ? 'assets/ai/[name]-[hash].js'
            : 'assets/[name]-[hash].js',
      },
    },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: '书桌防线 Desk Defense',
        short_name: '书桌防线',
        description: '书桌题材的迷宫式塔防游戏',
        lang: 'zh-CN',
        start_url: './',
        scope: './',
        display: 'fullscreen',
        orientation: 'any',
        background_color: '#E8D5B5',
        theme_color: '#E8D5B5',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // AI 分包不预缓存；进入「AI 参战」时按需下载，之后离线可用
        globIgnores: ['**/assets/ai/**'],
        runtimeCaching: [
          {
            urlPattern: /\/assets\/ai\/[^/]+\.js$/,
            handler: 'CacheFirst',
            options: { cacheName: 'dd-ai-chunks', expiration: { maxEntries: 120, maxAgeSeconds: 60 * 24 * 3600 } },
          },
        ],
      },
    }),
  ],
});
