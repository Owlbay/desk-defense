// 生成社交分享图 public/og.png（1200×630）。
// 用游戏自己的美术（art/**/*.svg）拼一张 SVG（scripts/og/og.svg，作为可提交的源文件），再用 resvg 渲染成 PNG。
// 用法：node scripts/gen-og.mjs        （文字用系统里的中文黑体：macOS 的 Hiragino Sans GB / PingFang SC）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INK = '#3B2F2A';
const art = (path) => `data:image/svg+xml;base64,${readFileSync(resolve(root, 'art', `${path}.svg`)).toString('base64')}`;
const img = (path, x, y, size) => `<image href="${art(path)}" x="${x}" y="${y}" width="${size}" height="${size}"/>`;

// 右侧的示意棋盘：7 × 6 格，每格 68px（与介绍页首屏的布局相同）
const B = { x: 664, y: 96, cell: 68, cols: 7, rows: 6 };
const cx = (c) => B.x + c * B.cell;
const cy = (r) => B.y + r * B.cell;
const at = (path, c, r, scale = 0.86) => {
  const size = B.cell * scale;
  return img(path, cx(c) + (B.cell - size) / 2, cy(r) + (B.cell - size) / 2, size);
};
const mid = (c, r) => `${cx(c) + B.cell / 2} ${cy(r) + B.cell / 2}`;

const grid = [];
for (let c = 1; c < B.cols; c++) grid.push(`M${cx(c)} ${B.y}V${cy(B.rows)}`);
for (let r = 1; r < B.rows; r++) grid.push(`M${B.x} ${cy(r)}H${cx(B.cols)}`);

const grain = [];
for (let x = 23; x < 1200; x += 46) grain.push(`M${x} 0V630`);

const towers = [
  ['towers/wall_l1', 0, 1],
  ['towers/stapler_t2', 1, 1],
  ['towers/wall_l2', 2, 1],
  ['towers/glue_t2', 3, 1],
  ['towers/wall_l1', 4, 1],
  ['towers/pencil_t3', 5, 1],
  ['towers/lamp_t3', 1, 3],
  ['towers/wall_l3', 2, 3],
  ['towers/compass_t4a', 3, 3],
  ['towers/wall_l1', 4, 3],
  ['towers/wall_l2', 5, 3],
  ['towers/swatter_t2', 6, 3],
];
const foes = [
  ['enemies/crumb', 4, 0, 0.58],
  ['enemies/inkdot', 5, 0, 0.58],
  ['enemies/paperclip', 4, 2, 0.58],
  ['enemies/paperball', 2, 2, 0.58],
  ['enemies/plane', 3, 2, 0.62],
  ['enemies/boss_coffee', 1, 4, 0.94],
];
const forms = ['pencil_t1', 'pencil_t2', 'pencil_t3', 'pencil_t4a', 'pencil_t5a'];

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <rect width="1200" height="630" fill="#E8D5B5"/>
  <path d="${grain.join('')}" stroke="#C9AD80" stroke-opacity="0.35" stroke-width="2"/>
  <ellipse cx="240" cy="0" rx="700" ry="330" fill="#FFFFFF" fill-opacity="0.22"/>

  <!-- 棋盘 -->
  <rect x="${B.x}" y="${B.y + 10}" width="${B.cell * B.cols}" height="${B.cell * B.rows}" rx="18" fill="${INK}"/>
  <rect x="${B.x}" y="${B.y}" width="${B.cell * B.cols}" height="${B.cell * B.rows}" rx="18" fill="#FBF8F1"/>
  <clipPath id="board"><rect x="${B.x}" y="${B.y}" width="${B.cell * B.cols}" height="${B.cell * B.rows}" rx="18"/></clipPath>
  <g clip-path="url(#board)">
    <path d="${grid.join('')}" stroke="${INK}" stroke-opacity="0.16" stroke-width="2"/>
    <rect x="${cx(3)}" y="${cy(0)}" width="${B.cell}" height="${B.cell}" fill="#E63946" fill-opacity="0.2"/>
    <rect x="${cx(3)}" y="${cy(0)}" width="${B.cell}" height="6" fill="#E63946"/>
    <rect x="${cx(3)}" y="${cy(5)}" width="${B.cell}" height="${B.cell}" fill="#4FA3E0" fill-opacity="0.28"/>
    <rect x="${cx(3)}" y="${cy(6) - 6}" width="${B.cell}" height="6" fill="#4FA3E0"/>
    <path d="M${cx(3) + B.cell / 2} ${B.y}L${mid(3, 0)}L${mid(6, 0)}L${mid(6, 2)}L${mid(0, 2)}L${mid(0, 4)}L${mid(3, 4)}L${cx(3) + B.cell / 2} ${cy(6)}"
      fill="none" stroke="#E63946" stroke-opacity="0.8" stroke-width="5" stroke-dasharray="3 14" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <rect x="${B.x}" y="${B.y}" width="${B.cell * B.cols}" height="${B.cell * B.rows}" rx="18" fill="none" stroke="${INK}" stroke-width="5"/>
  ${towers.map(([p, c, r]) => at(p, c, r)).join('\n  ')}
  ${foes.map(([p, c, r, s]) => at(p, c, r, s)).join('\n  ')}

  <!-- 标题 -->
  <text x="70" y="212" font-family="Hiragino Sans GB, PingFang SC, STHeiti, sans-serif" font-weight="700" font-size="118" fill="${INK}" letter-spacing="4">书桌防线</text>
  <text x="74" y="272" font-family="Helvetica Neue, Arial, sans-serif" font-weight="700" font-size="40" fill="${INK}" letter-spacing="9">DESK DEFENSE</text>
  <text x="74" y="346" font-family="Hiragino Sans GB, PingFang SC, STHeiti, sans-serif" font-weight="700" font-size="35" fill="${INK}" fill-opacity="0.78">用文具搭迷宫，守住你的作业本</text>

  <!-- 铅笔塔的五种形态 -->
  <rect x="70" y="396" width="496" height="124" rx="18" fill="${INK}"/>
  <rect x="70" y="388" width="496" height="124" rx="18" fill="#FBF8F1" stroke="${INK}" stroke-width="5"/>
  ${forms.map((f, i) => img(`towers/${f}`, 88 + i * 94, 406, 86)).join('\n  ')}
  ${[0, 1, 2, 3].map((i) => `<path d="M${88 + i * 94 + 87} 449l7 0m-4 -5l5 5l-5 5" fill="none" stroke="${INK}" stroke-opacity="0.45" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`).join('\n  ')}

  <rect x="70" y="548" width="208" height="46" rx="23" fill="#F2C14E" stroke="${INK}" stroke-width="4"/>
  <text x="174" y="580" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-weight="700" font-size="26" fill="${INK}">jjjj.games</text>
</svg>
`;

mkdirSync(resolve(root, 'scripts/og'), { recursive: true });
writeFileSync(resolve(root, 'scripts/og/og.svg'), svg);
const png = new Resvg(svg, {
  fitTo: { mode: 'width', value: 1200 },
  font: { loadSystemFonts: true, defaultFontFamily: 'Hiragino Sans GB' },
})
  .render()
  .asPng();
writeFileSync(resolve(root, 'public/og.png'), png);
console.log(`og.svg ${(svg.length / 1024).toFixed(0)} KB → public/og.png ${(png.length / 1024).toFixed(0)} KB`);
