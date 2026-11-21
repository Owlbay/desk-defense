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
 * 原生 App 壳（Capacitor / Tauri）里的页面来源：它们从这些 origin 调用线上 /api（例如 https://jjjj.games/api），
 * 属于跨站请求，需要放行并回 CORS 头。只放行这几个固定值，不做通配。
 */
export const APP_ORIGINS: ReadonlySet<string> = new Set([
  'capacitor://localhost',
  'https://localhost',
  'tauri://localhost',
  'http://tauri.localhost',
]);

/** 请求来自允许的 App 壳时返回其 origin（与站点同源时返回 null，不需要 CORS） */
export function appOriginOf(request: Request): string | null {
  const origin = request.headers.get('Origin');
  if (!origin || !APP_ORIGINS.has(origin)) return null;
  return origin === new URL(request.url).origin ? null : origin;
}

function corsHeaders(origin: string): Record<string, string> {
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

/**
 * 只允许同源调用（外加 APP_ORIGINS 里的原生 App 壳）：
 * 带 Origin 的请求必须与请求 URL 同源或是 App 壳；Sec-Fetch-Site 为 cross-site 且不是 App 壳一律拒绝。
 * 对其他来源不返回任何 Access-Control-Allow-* 头，所以跨站页面的 fetch 拿不到响应。
 * App 壳的 OPTIONS 预检直接 204（只允许 GET / POST 与 Content-Type / Accept 头）。
 */
export function crossSiteRejection(request: Request): Response | null {
  const app = appOriginOf(request);
  if (app) {
    if (request.method !== 'OPTIONS') return null;
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(app),
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return apiError('forbidden', '不允许跨站访问');
  const site = request.headers.get('Sec-Fetch-Site');
  if (site === 'cross-site') return apiError('forbidden', '不允许跨站访问');
  if (request.method === 'OPTIONS') return apiError('forbidden', '不允许跨站访问');
  return null;
}

/** App 壳的请求：给响应补上 CORS 头（其他请求原样返回） */
export function withCors(request: Request, res: Response): Response {
  const app = appOriginOf(request);
  if (!app) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders(app))) out.headers.set(k, v);
  return out;
}
