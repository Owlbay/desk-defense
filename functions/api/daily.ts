/// <reference types="@cloudflare/workers-types" />
import { depsFromEnv, type Env } from '../_lib/env';
import { handleDaily } from '../_lib/handlers';

/** GET /api/daily —— 今天（北京时间）的每日挑战 */
export const onRequestGet: PagesFunction<Env> = (ctx) => handleDaily(ctx.request, depsFromEnv(ctx.env));
