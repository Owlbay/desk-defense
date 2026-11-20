/// <reference types="@cloudflare/workers-types" />
import type { Env } from '../_lib/env';
import { apiError, crossSiteRejection } from '../_lib/http';

/** /api/* 公共中间件：同源限制 + 兜底错误（中文 JSON） */
export const onRequest: PagesFunction<Env> = async (ctx) => {
  const rejected = crossSiteRejection(ctx.request);
  if (rejected) return rejected;
  try {
    return await ctx.next();
  } catch (e) {
    console.error('api error', e);
    return apiError('internal', '服务器开小差了，请稍后再试');
  }
};
