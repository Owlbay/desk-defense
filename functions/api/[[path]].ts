/// <reference types="@cloudflare/workers-types" />
import { apiError } from '../_lib/http';

/** 其它 /api/* 路径：返回 JSON 404，而不是落到静态站点的 index.html */
export const onRequest: PagesFunction = () => apiError('not_found', '接口不存在');
