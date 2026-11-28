/**
 * 游戏内反馈的纯逻辑（不碰 DOM）：收集自动附带的环境信息、生成「复制反馈内容」的文本。
 * 对话框在 src/ui/feedback.ts；接口见 src/shared/feedback.ts 与 functions/_lib/feedback.ts。
 */
import type { RunOptions } from '../core/types';
import { getLocale, t } from '../i18n';
import { cleanLine, FEEDBACK_CONTEXT_MAX, type FeedbackContext, type FeedbackKind } from '../shared/feedback';
import { APP_VERSION } from './version';

/** 发送失败时的兜底渠道 */
export const FEEDBACK_ISSUES_URL = 'https://github.com/Owlbay/desk-defense/issues';

/** 只用到路由的名字和对局参数（与 src/ui/App.ts 的 Route 结构兼容） */
export interface RouteLike {
  name: string;
  opts?: Pick<RunOptions, 'mode' | 'map' | 'difficulty' | 'abyssLevel'>;
}

/** 当前页面；对局中带上模式 / 地图 / 难度（魔境带等级），例如 game/endless/ch2/abyss3 */
export function routeLabel(r: RouteLike | null | undefined): string {
  if (!r) return '';
  if (r.name !== 'game' || !r.opts) return r.name;
  const o = r.opts;
  const diff = o.difficulty === 'abyss' ? `abyss${o.abyssLevel ?? 1}` : o.difficulty;
  return ['game', o.mode, o.map, diff].join('/');
}

export interface EnvLike {
  width: number;
  height: number;
  dpr: number;
  ua: string;
}

function browserEnv(): EnvLike {
  if (typeof window === 'undefined') return { width: 0, height: 0, dpr: 1, ua: '' };
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  };
}

/** 自动附带的环境信息：版本、语言、屏幕尺寸、当前页面 / 对局模式、浏览器 UA（不含其他个人信息） */
export function feedbackContext(route: RouteLike | null | undefined, env: EnvLike = browserEnv()): FeedbackContext {
  const M = FEEDBACK_CONTEXT_MAX;
  const dpr = Math.round(env.dpr * 100) / 100;
  return {
    version: cleanLine(APP_VERSION, M.version),
    locale: cleanLine(getLocale(), M.locale),
    screen: cleanLine(`${Math.round(env.width)}x${Math.round(env.height)}${dpr !== 1 ? `@${dpr}` : ''}`, M.screen),
    route: cleanLine(routeLabel(route), M.route),
    ua: cleanLine(env.ua, M.ua),
  };
}

/** 界面上展示的一行（UA 太长时截短；完整内容仍会发送） */
export function contextSummary(c: FeedbackContext, uaMax = 60): string {
  const ua = c.ua.length > uaMax ? `${c.ua.slice(0, uaMax)}…` : c.ua;
  return [`v${c.version}`, c.locale, c.screen, c.route, ua].filter(Boolean).join(' · ');
}

/** 发送失败时复制到剪贴板的文本（可以直接贴到 GitHub Issue） */
export function feedbackCopyText(d: { kind: FeedbackKind; text: string; contact?: string }, c: FeedbackContext): string {
  const lines = [
    `[${t(`ui.feedback.kind.${d.kind}`)}]`,
    d.text.trim(),
    '',
    d.contact?.trim() ? `${t('ui.feedback.contact')}: ${d.contact.trim()}` : null,
    `${t('ui.feedback.attachedLabel')}: v${c.version} · ${c.locale} · ${c.screen}${c.route ? ` · ${c.route}` : ''}`,
    `UA: ${c.ua}`,
  ];
  return lines.filter((l) => l !== null).join('\n');
}
