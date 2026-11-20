/// <reference types="@cloudflare/workers-types" />
import { depsFromEnv, type Env } from '../../_lib/env';
import { handleGetRun } from '../../_lib/handlers';

/** GET /api/runs/:id —— 成绩详情（种子 + 开局参数 + 指令日志，用于回放） */
export const onRequestGet: PagesFunction<Env, 'id'> = (ctx) =>
  handleGetRun(ctx.request, depsFromEnv(ctx.env), String(ctx.params.id ?? ''));
