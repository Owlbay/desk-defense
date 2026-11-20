// 把 art/ 下的所有 SVG 内联进 art/gallery.html，方便直接用浏览器打开预览（无需服务器）。
// 用法：node scripts/build-gallery.mjs
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const art = join(root, 'art');

const list = (dir) =>
  existsSync(join(art, dir))
    ? readdirSync(join(art, dir)).filter((f) => f.endsWith('.svg')).sort()
    : [];

// 内联多个 SVG 时，渐变 / 滤镜的 id 可能重名，给每个文件加前缀避免冲突
let uid = 0;
const inline = (dir, file) => {
  const p = `s${uid++}_`;
  let svg = readFileSync(join(art, dir, file), 'utf8').replace(/<\?xml[^>]*>/, '');
  const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const defs = ids.filter((id) => new RegExp(`url\\(#${id}\\)|href="#${id}"`).test(svg));
  for (const id of defs) {
    svg = svg
      .replaceAll(`id="${id}"`, `id="${p}${id}"`)
      .replaceAll(`url(#${id})`, `url(#${p}${id})`)
      .replaceAll(`href="#${id}"`, `href="#${p}${id}"`);
  }
  return svg;
};

const TOWERS = [
  ['wall', '书本墙'], ['pencil', '铅笔'], ['stapler', '订书机'], ['glue', '胶水'],
  ['lamp', '台灯'], ['compass', '圆规'], ['eraser', '橡皮擦'], ['ruler', '尺子'],
  ['pen', '钢笔'], ['calculator', '计算器'], ['piggy', '存钱罐'],
  ['swatter', '苍蝇拍'],
];
const TIERS = [['t1', 'T1 草稿'], ['t2', 'T2 精良'], ['t3', 'T3 镀金'], ['t4a', 'T4 传奇 A'], ['t4b', 'T4 传奇 B'], ['t5a', 'T5 神话 A'], ['t5b', 'T5 神话 B']];
const NAMES = {
  crumb: '橡皮屑', inkdot: '墨点', paperclip: '回形针', plane: '纸飞机', paperball: '纸团',
  sticky: '便利贴', rubberband: '橡皮筋', whiteout: '修正液', ant: '蚂蚁', invisink: '隐形墨水',
  tape: '胶带卷', moth: '飞蛾', boss_coffee: '咖啡渍', boss_shredder: '碎纸机',
  boss_inkbottle: '墨水瓶', boss_alarm: '闹钟',
  hard: '坚硬', swift: '迅捷', regen: '再生', shield: '护盾', split: '分裂', stealth: '隐身',
  reflect: '反光', unstoppable: '免控', rally: '激励',
  eraser_strike: '大橡皮', bell: '下课铃', whiteout_zone: '涂改液', caffeine: '咖啡因',
  ruler_sweep: '横扫尺', scholarship: '奖学金', relocate: '搬家', inspiration: '灵感闪现',
  magnifier: '放大镜', seal_tape: '封箱胶带',
  pencil_a: '弹幕', pencil_b: '调色盘', stapler_a: '连环钉', stapler_b: '拆解', glue_a: '封冻', glue_b: '熔胶海',
  lamp_a: '过载', lamp_b: '白昼', compass_a: '满圆', compass_b: '深钻', eraser_a: '全面修改', eraser_b: '擦除',
  ruler_a: '横扫千军', ruler_b: '精准测量', pen_a: '挥毫', pen_b: '不及格', calculator_a: '精算', calculator_b: '速算',
  piggy_a: '砸罐', piggy_b: '紧急锁门', swatter_a: '电网', swatter_b: '天网',
  drop_box: '空降纸箱', lamp_outage: '台灯跳闸', fan: '风扇转起来', books_fall: '书本倒下', homework_check: '作业检查',
  coffee_spill: '咖啡打翻', reinforce: '敌军增援', coins: '掉落零花钱', inspiration_ev: '灵感闪现', nap: '午休铃',
  praise: '老师表扬', supply_crate: '补给箱', tidy: '桌面整理', wind: '窗外起风', secret_door: '暗门',
};

const towerFiles = new Set(list('towers'));
const cell = (svg, label) =>
  `<figure>${svg ? `<div class="tile">${svg}</div>` : '<div class="tile missing">缺</div>'}<figcaption>${label}</figcaption></figure>`;

let towerRows = '';
for (const [id, name] of TOWERS) {
  const files = id === 'wall' ? ['l1', 'l2', 'l3'] : TIERS.map((t) => t[0]);
  const cells = files.map((t) => {
    const f = `${id}_${t}.svg`;
    const label = id === 'wall' ? `Lv${t[1]}` : TIERS.find((x) => x[0] === t)[1];
    return cell(towerFiles.has(f) ? inline('towers', f) : null, label);
  });
  towerRows += `<div class="row"><h3>${name}<small>${id}</small></h3><div class="cells">${cells.join('')}</div></div>`;
}

const grid = (dir) =>
  list(dir)
    .map((f) => {
      const id = f.replace('.svg', '');
      return cell(inline(dir, f), `${NAMES[id] ?? id}<small>${id}</small>`);
    })
    .join('');

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>书桌防线 · 素材预览</title>
<style>
  :root { --bg:#E8D5B5; --ink:#3B2F2A; --card:#FBF8F1; --line:#D4BC94; }
  * { box-sizing:border-box }
  body { margin:0; padding:24px 16px 48px; background:var(--bg); color:var(--ink);
         font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",sans-serif }
  main { max-width:1100px; margin:0 auto }
  h1 { margin:0 0 4px; font-size:24px } h2 { margin:32px 0 12px; font-size:18px }
  h3 { margin:0; font-size:15px; min-width:96px } small { display:block; opacity:.55; font-weight:400; font-size:11px }
  .row { display:flex; gap:16px; align-items:center; padding:12px 0; border-top:1px solid var(--line); flex-wrap:wrap }
  .cells, .grid { display:flex; gap:12px; flex-wrap:wrap }
  figure { margin:0; text-align:center; font-size:12px }
  .tile { width:112px; height:112px; background:var(--card); border-radius:12px; display:grid; place-items:center;
          box-shadow:inset 0 0 0 1px var(--line) }
  .tile svg { width:96px; height:96px }
  .tile.missing { color:#B23A48; font-weight:600 }
  .size { display:flex; gap:8px; align-items:center; margin-top:8px }
  .sizes .tile { width:auto; height:auto; padding:8px; display:flex; gap:10px; align-items:end }
  .s48 svg { width:48px; height:48px } .s32 svg { width:32px; height:32px } .s16 svg { width:16px; height:16px }
  label { cursor:pointer; user-select:none }
  body.dark { --bg:#2B2522; --card:#3B3330; --line:#4A403B; color:#F2E8DA }
</style></head><body><main>
<h1>书桌防线 · 素材预览</h1>
<p>由 <code>scripts/build-gallery.mjs</code> 生成。 <label><input type="checkbox" onchange="document.body.classList.toggle('dark',this.checked)"> 深色背景对比</label></p>
<h2>防御塔 · 形态</h2>${towerRows}
<h2>实际尺寸检查（48 / 32 / 16 px）</h2>
<div class="grid sizes">${['pencil_t1', 'pencil_t3', 'lamp_t4a', 'pen_t4b']
  .filter((n) => towerFiles.has(`${n}.svg`))
  .map((n) => {
    const s = inline('towers', `${n}.svg`);
    return `<figure><div class="tile"><span class="s48">${s}</span><span class="s32">${inline('towers', `${n}.svg`)}</span><span class="s16">${inline('towers', `${n}.svg`)}</span></div><figcaption>${n}</figcaption></figure>`;
  })
  .join('')}</div>
<h2>敌人与 Boss</h2><div class="grid">${grid('enemies')}</div>
<h2>精英词缀</h2><div class="grid">${grid('affixes')}</div>
<h2>主动技能</h2><div class="grid">${grid('skills')}</div>
<h2>神话塔主动能力</h2><div class="grid">${grid('abilities')}</div>
<h2>随机事件</h2><div class="grid">${grid('events')}</div>
</main></body></html>`;

writeFileSync(join(art, 'gallery.html'), html);
console.log('wrote art/gallery.html');
