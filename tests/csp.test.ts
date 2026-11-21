/**
 * public/_headers 里的 CSP（文档 10 §10.7）：
 *  - 页面里每段会执行的内联脚本（about.html 的主题脚本）都必须在 script-src 里有哈希，否则改了脚本就会被 CSP 拦下；
 *  - connect-src 必须放行玩家自己配置的任意模型端点（https / http 局域网与 localhost / ws 桥接器）与本站 /api。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const headers = readFileSync(resolve(root, 'public/_headers'), 'utf8');
const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1].trim() ?? '';
const directive = (name: string): string[] =>
  csp
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .find((d) => d[0] === name)
    ?.slice(1) ?? [];

/** 会被执行的内联脚本（排除 src= 与 JSON-LD 等非 JS 类型） */
function inlineScripts(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attrs = m[1];
    if (/\bsrc=/.test(attrs)) continue;
    const type = /\btype=["']?([^"'\s>]+)/.exec(attrs)?.[1];
    if (type && type !== 'module' && type !== 'text/javascript') continue;
    out.push(m[2]);
  }
  return out;
}

describe('CSP (public/_headers)', () => {
  it('exists and keeps scripts to self', () => {
    expect(csp).toBeTruthy();
    const s = directive('script-src');
    expect(s).toContain("'self'");
    expect(s).not.toContain("'unsafe-inline'");
    expect(s).not.toContain("'unsafe-eval'");
    expect(directive('object-src')).toEqual(["'none'"]);
  });

  it('hashes every inline script of the pages', () => {
    const s = directive('script-src');
    for (const page of ['index.html', 'about.html', 'public/404.html']) {
      for (const code of inlineScripts(readFileSync(resolve(root, page), 'utf8'))) {
        const h = `'sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}'`;
        expect(s, `${page}: inline script needs ${h} in script-src`).toContain(h);
      }
    }
  });

  it('lets players reach any model endpoint, the local bridge and /api', () => {
    const c = directive('connect-src');
    for (const src of ["'self'", 'https:', 'http:', 'ws:', 'wss:']) expect(c).toContain(src);
    expect(directive('img-src')).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:']));
    expect(directive('worker-src')).toContain("'self'");
  });
});
