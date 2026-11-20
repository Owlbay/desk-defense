/// <reference types="@cloudflare/workers-types" />
import { depsFromEnv, type Env } from '../../_lib/env';
import { handleSubmit } from '../../_lib/handlers';

/** POST /api/runs —— 提交成绩 */
export const onRequestPost: PagesFunction<Env> = (ctx) => handleSubmit(ctx.request, depsFromEnv(ctx.env));
