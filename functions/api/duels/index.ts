/// <reference types="@cloudflare/workers-types" />
import { depsFromEnv, type Env } from '../../_lib/env';
import { handleDuelBoard, handleDuelSubmit } from '../../_lib/handlers';

/** GET /api/duels?limit=20[&around=deviceId] —— AI 对战榜 */
export const onRequestGet: PagesFunction<Env> = (ctx) => handleDuelBoard(ctx.request, depsFromEnv(ctx.env));
/** POST /api/duels —— 提交 AI 对战成绩 */
export const onRequestPost: PagesFunction<Env> = (ctx) => handleDuelSubmit(ctx.request, depsFromEnv(ctx.env));
