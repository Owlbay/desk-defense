/// <reference types="@cloudflare/workers-types" />
import type { Env } from '../_lib/env';
import { apiError, crossSiteRejection, withCors } from '../_lib/http';

/** /api/* 公共中间件：同源限制（放行原生 App 壳并回 CORS 头）+ 兜底错误（中文 JSON） */
export const onRequest: PagesFunction<Env> = async (ctx) => {
  const rejected = crossSiteRejection(ctx.request);
  if (rejected) return rejected;
  try {
    return withCors(ctx.request, await ctx.next());
  } catch (e) {
    console.error('api error', e);
    return withCors(ctx.request, apiError('internal', '服务器开小差了，请稍后再试'));
  }
};
