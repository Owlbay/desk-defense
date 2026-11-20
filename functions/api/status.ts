/// <reference types="@cloudflare/workers-types" />
import { depsFromEnv, type Env } from '../_lib/env';
import { handleStatus } from '../_lib/handlers';

/** GET /api/status —— 在线功能探测：服务端版本、Turnstile site key、今日挑战 */
export const onRequestGet: PagesFunction<Env> = (ctx) => handleStatus(ctx.request, depsFromEnv(ctx.env));
