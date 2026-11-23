#!/usr/bin/env node
/**
 * 发版：升版本号 → 写更新日志 → 提交 → 打 tag → 推送（→ 可选部署）。
 *
 *   npm run release                 # changelog.json 最前面已写好比当前版本新的条目：按它发版
 *   npm run release -- patch        # 版本号 +0.0.1；没有写好的条目时，用上个 tag 以来的提交标题生成简体中文条目
 *   npm run release -- minor | major | 1.2.3
 *   加 --deploy 发版后部署到 Cloudflare Pages；--dry 只打印将要做的事；--skip-check 跳过 npm run check
 *
 * 更新日志的唯一来源是 src/meta/changelog.json：游戏内「更新日志」、升级提示、CHANGELOG.md、
 * GitHub Release（.github/workflows/release.yml 在 tag 推上去后读取）都用它。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const P = {
  pkg: resolve(root, 'package.json'),
  lock: resolve(root, 'package-lock.json'),
  log: resolve(root, 'src/meta/changelog.json'),
  md: resolve(root, 'CHANGELOG.md'),
};

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const bumpArg = args.find((a) => !a.startsWith('--'));
const DRY = flag('--dry');

const sh = (cmd, a, o = {}) => execFileSync(cmd, a, { cwd: root, encoding: 'utf8', stdio: o.inherit ? 'inherit' : 'pipe' });
const run = (cmd, a) => {
  console.log(`$ ${cmd} ${a.join(' ')}`);
  if (!DRY) sh(cmd, a, { inherit: true });
};
const die = (m) => {
  console.error(`✖ ${m}`);
  process.exit(1);
};

const cmp = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};
const bump = (v, kind) => {
  const [a, b, c] = v.split('.').map(Number);
  if (kind === 'major') return `${a + 1}.0.0`;
  if (kind === 'minor') return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ── 前置检查 ──
if (sh('git', ['status', '--porcelain']).trim() && !DRY) die('工作区有未提交的改动，先提交或暂存再发版');
const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
if (branch !== 'main' && !DRY) die(`当前在 ${branch} 分支，发版只在 main 上做`);

const pkg = JSON.parse(readFileSync(P.pkg, 'utf8'));
const log = JSON.parse(readFileSync(P.log, 'utf8'));
const cur = pkg.version;
const top = log[0];

// ── 决定新版本号与日志条目 ──
let next;
let entry;
if (!bumpArg) {
  if (!top || cmp(top.version, cur) <= 0) die(`changelog.json 里没有比 ${cur} 新的条目：先写好条目，或指定 patch / minor / major`);
  next = top.version;
  entry = top;
} else {
  next = /^\d+\.\d+\.\d+$/.test(bumpArg) ? bumpArg : ['patch', 'minor', 'major'].includes(bumpArg) ? bump(cur, bumpArg) : null;
  if (!next) die(`看不懂的版本参数：${bumpArg}`);
  if (cmp(next, cur) <= 0) die(`新版本 ${next} 必须大于当前版本 ${cur}`);
  if (top && top.version === next) {
    entry = top;
  } else {
    if (top && cmp(top.version, cur) > 0) die(`changelog.json 最前面是 ${top.version}，与要发的 ${next} 不一致`);
    // 没写条目：用上个 tag 以来的提交标题生成（排除发版提交本身）
    let range = [];
    try {
      range = [`${sh('git', ['describe', '--tags', '--abbrev=0']).trim()}..HEAD`];
    } catch {
      /* 还没有 tag：取全部 */
    }
    const subjects = sh('git', ['log', '--no-merges', '--format=%s', ...range])
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !/^发布 v\d/.test(s));
    if (!subjects.length) die('上个版本以来没有新提交');
    entry = { version: next, date: today(), notes: { 'zh-CN': subjects.reverse() } };
    log.unshift(entry);
  }
}
if (sh('git', ['tag', '-l', `v${next}`]).trim()) die(`tag v${next} 已存在`);
entry.date = today();

console.log(`\n发版 v${cur} → v${next}（${entry.date}）\n${entry.notes['zh-CN'].map((n) => `  · ${n}`).join('\n')}\n`);

// ── 写文件 ──
const writeJson = (p, o) => !DRY && writeFileSync(p, `${JSON.stringify(o, null, 2)}\n`);
pkg.version = next;
writeJson(P.pkg, pkg);
try {
  const lock = JSON.parse(readFileSync(P.lock, 'utf8'));
  lock.version = next;
  if (lock.packages?.['']) lock.packages[''].version = next;
  writeJson(P.lock, lock);
} catch {
  /* 没有 lock 文件 */
}
writeJson(P.log, log);

const md = [
  '# 更新日志',
  '',
  '每个版本的更新内容（简体中文）。游戏内「设置 → 版本 · 更新日志」可以看到各语言版本。由 `npm run release` 根据 `src/meta/changelog.json` 生成，请勿手改。',
  '',
  ...log.flatMap((e) => [`## v${e.version} · ${e.date}`, '', ...e.notes['zh-CN'].map((n) => `- ${n}`), '']),
].join('\n');
if (!DRY) writeFileSync(P.md, md);

// ── 检查、提交、打 tag、推送 ──
run('npx', ['prettier', '--write', 'src/meta/changelog.json', 'CHANGELOG.md', 'package.json']);
if (!flag('--skip-check')) run('npm', ['run', 'check']);
run('git', ['add', 'package.json', 'package-lock.json', 'src/meta/changelog.json', 'CHANGELOG.md']);
run('git', ['commit', '-m', `发布 v${next}`]);
run('git', ['tag', '-a', `v${next}`, '-m', `v${next}\n\n${entry.notes['zh-CN'].map((n) => `- ${n}`).join('\n')}`]);
run('git', ['push', 'origin', 'main', `v${next}`]);
if (flag('--deploy')) run('npm', ['run', 'deploy']);

console.log(`\n✔ v${next} 已打 tag 并推送。GitHub Actions 会据此创建 Release。${flag('--deploy') ? '已部署。' : '部署：npm run deploy'}`);
