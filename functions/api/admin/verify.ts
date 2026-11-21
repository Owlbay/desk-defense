/// <reference types="@cloudflare/workers-types" />
import { handleAdminVerify } from '../../_lib/admin';
import { depsFromEnv, type Env } from '../../_lib/env';

/** POST /api/admin/verify?limit=5 —— 第二阶段服务端回放校验（REPLAY_VERIFY=1 + X-Admin-Token，见 functions/_lib/admin.ts） */
export const onRequest: PagesFunction<Env> = (ctx) => handleAdminVerify(ctx.request, depsFromEnv(ctx.env));
