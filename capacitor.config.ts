import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 原生壳（文档 07 §2 阶段 ③）：iOS / Android 直接加载 `npm run build` 的 dist/。
 * 原生工程（ios/、android/）由 `npx cap add ios|android` 生成，构建产物已在 .gitignore 中忽略。
 */
const config: CapacitorConfig = {
  appId: 'games.jjjj.deskdefense',
  appName: '书桌防线',
  webDir: 'dist',
  backgroundColor: '#E8D5B5',
  plugins: {
    // 不劫持全局 fetch：CapacitorHttp 不支持流式响应，会弄坏 AI 参战的模型流式调用。
    // 排行榜 API 改为对原生壳的 Origin（capacitor://localhost、https://localhost）放行 CORS，见文档 07 §2.3。
    CapacitorHttp: { enabled: false },
  },
  ios: { contentInset: 'never' },
  android: { allowMixedContent: false },
};

export default config;
