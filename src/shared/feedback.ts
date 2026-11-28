/**
 * 游戏内反馈（POST /api/feedback）：前端与 Pages Functions 共用的常量、类型和清洗函数。
 * 服务端校验在 functions/_lib/feedback.ts；这里不放任何提示文字（错误信息由服务端给出）。
 */

export const FEEDBACK_KINDS = ['bug', 'idea', 'other'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** 正文最多字符数（按 Unicode 码点计） */
export const FEEDBACK_TEXT_MAX = 1000;
/** 联系方式（可选）最多字符数 */
export const FEEDBACK_CONTACT_MAX = 100;
/** 请求体上限（字节）：正文 1000 字 × 最多 4 字节 + 环境信息，留足余量 */
export const FEEDBACK_MAX_BODY_BYTES = 8_000;
/** 固定窗口限流（所有请求都计数，包括格式错误的）：每个 IP / 每台设备 10 分钟内最多 3 次 */
export const FEEDBACK_RATE_LIMIT = { max: 3, windowSec: 600 } as const;
/** 滑动窗口（按 feedback 表里已存的条数）：每个 IP / 每台设备 1 小时内最多 6 条 */
export const FEEDBACK_HOURLY_MAX = 6;

/** 自动附带的环境信息上限（字符） */
export const FEEDBACK_CONTEXT_MAX = { version: 24, locale: 16, screen: 32, route: 80, ua: 300 } as const;

/** 自动附带的环境信息（界面上会原样展示给玩家） */
export interface FeedbackContext {
  /** APP_VERSION */
  version: string;
  locale: string;
  /** 例如 390x844@3 */
  screen: string;
  /** 当前页面；对局中为 game/<模式>/<地图>/<难度> */
  route: string;
  ua: string;
}

export interface FeedbackBody {
  kind: FeedbackKind;
  text: string;
  /** 可选：邮箱 / QQ 等 */
  contact?: string;
  /** 可选：设备 id（只用于限流，服务端只存哈希） */
  deviceId?: string;
  context: FeedbackContext;
  turnstileToken?: string;
}

export interface FeedbackResponse {
  ok: true;
  id: string;
}

export const isFeedbackKind = (x: unknown): x is FeedbackKind => typeof x === 'string' && (FEEDBACK_KINDS as readonly string[]).includes(x);

/** 按码点截断（不切断代理对） */
export function clampChars(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max).join('') : s;
}

/** 码点长度（与 clampChars 一致，界面上的计数器也用它） */
export const charCount = (s: string): number => Array.from(s).length;

// 控制字符（保留 \t \n）、零宽 / 方向控制字符
// eslint-disable-next-line no-control-regex -- 清洗用户输入里的控制字符
const CTRL_KEEP_NL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
// eslint-disable-next-line no-control-regex -- 清洗单行字段里的控制字符（含换行）
const CTRL_ALL = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

/** 多行正文：统一换行、去控制字符、折叠过多空行、去首尾空白、截断 */
export function cleanFeedbackText(raw: unknown, max = FEEDBACK_TEXT_MAX): string {
  if (typeof raw !== 'string') return '';
  const s = raw
    .replace(/\r\n?/g, '\n')
    .replace(CTRL_KEEP_NL, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  return clampChars(s, max).trim();
}

/** 单行字段（联系方式、环境信息）：去控制字符和换行、合并空白、截断 */
export function cleanLine(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const s = raw.replace(CTRL_ALL, ' ').replace(/\s+/g, ' ').trim();
  return clampChars(s, max).trim();
}
