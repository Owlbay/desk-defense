/// <reference types="@cloudflare/workers-types" />
import { depsFromEnv, type Env } from '../../_lib/env';
import { handleGetDuel } from '../../_lib/handlers';

/** GET /api/duels/:id —— AI 对战详情（种子 + 开局参数 + 含出题的指令日志，用于回放） */
export const onRequestGet: PagesFunction<Env, 'id'> = (ctx) =>
  handleGetDuel(ctx.request, depsFromEnv(ctx.env), String(ctx.params.id ?? ''));
