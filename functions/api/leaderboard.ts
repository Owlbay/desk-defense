/// <reference types="@cloudflare/workers-types" />
import { depsFromEnv, type Env } from '../_lib/env';
import { handleLeaderboard } from '../_lib/handlers';

/** GET /api/leaderboard?board=…&limit=20[&around=deviceId] */
export const onRequestGet: PagesFunction<Env> = (ctx) => handleLeaderboard(ctx.request, depsFromEnv(ctx.env));
