import type { ApiError } from '../../src/shared/leaderboard';

export type ErrorCode =
  | 'bad_request'
  | 'version'
  | 'too_large'
  | 'rate_limited'
  | 'turnstile'
  | 'forbidden'
  | 'not_found'
  | 'method'
  | 'not_configured'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  version: 409,
  too_large: 413,
  rate_limited: 429,
  turnstile: 403,
  forbidden: 403,
  not_found: 404,
  method: 405,
  not_configured: 503,
  internal: 500,
};

const BASE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};

export function json(data: unknown, init: { status?: number; cacheControl?: string; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { ...BASE_HEADERS, 'Cache-Control': init.cacheControl ?? 'no-store', ...(init.headers ?? {}) },
  });
}

export function apiError(code: ErrorCode, message: string, extra: { retryAfter?: number } = {}): Response {
  const body: ApiError = { error: code, message, ...(extra.retryAfter ? { retryAfter: extra.retryAfter } : {}) };
  return json(body, {
    status: STATUS[code],
    headers: extra.retryAfter ? { 'Retry-After': String(extra.retryAfter) } : {},
  });
}

/**
 * 只允许同源调用：带 Origin 的请求必须与请求 URL 同源；Sec-Fetch-Site 为 cross-site 一律拒绝。
 * 不返回任何 Access-Control-Allow-* 头，所以跨站页面的 fetch 拿不到响应。
 */
export function crossSiteRejection(request: Request): Response | null {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return apiError('forbidden', '不允许跨站访问');
  const site = request.headers.get('Sec-Fetch-Site');
  if (site === 'cross-site') return apiError('forbidden', '不允许跨站访问');
  if (request.method === 'OPTIONS') return apiError('forbidden', '不允许跨站访问');
  return null;
}
