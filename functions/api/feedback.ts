/// <reference types="@cloudflare/workers-types" />
import { depsFromEnv, type Env } from '../_lib/env';
import { handleFeedback } from '../_lib/feedback';

/** POST /api/feedback —— 游戏内反馈（bug / 建议），存进 D1 feedback 表 */
export const onRequestPost: PagesFunction<Env> = (ctx) => handleFeedback(ctx.request, depsFromEnv(ctx.env));
