import { GRID_COLS, GRID_ROWS, type DifficultyId, type DifficultyParams, type MapId, type ModeId, type RandomEventId, type RunOptions, type SkillId } from '../../core/types';
import type { Profile } from '../../meta/profile';
import { effectiveAutoWave, resolveLoadout, skillLevel, unlockReached } from '../../meta/progress';
import type { App, Route } from '../App';
import { skillIcon } from '../assets';
import { audio } from '../audio';
import { generateLayout, SKILL_META, SKILL_ORDER, spawnerName } from '../coreMeta';
import { h, img } from '../dom';
import { G } from '../icons';

export function unlockedSkills(p: Profile): SkillId[] {
  return SKILL_ORDER.filter((id) => unlockReached(p, SKILL_META[id]?.unlock));
}

export interface RunBase {
  mode: ModeId;
  map: MapId;
  difficulty: DifficultyId;
  abyssLevel?: number;
  custom?: Partial<DifficultyParams>;
  seed?: string;
  pure?: boolean;
  /** 自动开波；缺省按玩家偏好 / 难度默认 */
  autoWave?: boolean;
  /** 被关闭的随机事件（自定义） */
  events?: Partial<Record<RandomEventId, boolean>>;
}

/** 组合开局参数：带入技能、技能等级、天赋 */
export function buildRunOptions(p: Profile, b: RunBase): RunOptions {
  const skills = resolveLoadout(p, unlockedSkills(p), !!b.pure);
  const skillLevels: Partial<Record<SkillId, number>> = {};
  for (const s of skills) skillLevels[s] = skillLevel(p, s);
  const opts: RunOptions = {
    mode: b.mode,
    map: b.map,
    difficulty: b.difficulty,
    skills,
    skillLevels,
  };
  if (b.difficulty === 'abyss') opts.abyssLevel = b.abyssLevel ?? 1;
  if (b.custom) opts.custom = { ...b.custom };
  const seed = b.seed?.trim();
  if (seed) opts.seed = seed;
  if (b.pure) opts.pure = true;
  else opts.talents = { ...p.talents };
  // 文档 09：总是写明开波方式，回放 / 排行榜不依赖 core 的默认值
  opts.autoWave = b.autoWave ?? effectiveAutoWave(p, b.mode, b.map, b.difficulty);
  if (b.mode === 'campaign' && p.settings.fixedLayout) opts.fixedLayout = true;
  if (b.events) {
    const off: Partial<Record<RandomEventId, boolean>> = {};
    for (const [k, v] of Object.entries(b.events)) if (v === false) off[k as RandomEventId] = false;
    if (Object.keys(off).length) opts.events = off;
  }
  return opts;
}

/** 界面生成的随机种子（用于布局缩略图，开局时作为种子传入，保证所见即所得） */
export function randomSeed(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

/** 开关行（label.switch-row） */
export function switchRow(title: string, hint: string, checked: boolean, onChange: (v: boolean) => void): { el: HTMLElement; input: HTMLInputElement } {
  const input = h<HTMLInputElement>('input', { attrs: { type: 'checkbox' } });
  input.checked = checked;
  input.onchange = () => {
    audio.play('click');
    onChange(input.checked);
  };
  const el = h('label.switch-row', null, h('span', null, h('b', null, title), h('small.muted', null, hint)), h('span.switch', null, input, h('span.knob')));
  return { el, input };
}

const OBST_COLOR: Record<string, string> = {
  cup: '#9BD1E5',
  books: '#B23A48',
  keyboard: '#A0AEC0',
  mouse: '#CBD5E0',
  palette: '#F2C14E',
  paint: '#F28AA0',
  eraser: '#F28AA0',
  pencilcup: '#2A9D8F',
  sticky: '#F5D76E',
  phone: '#4A5568',
  ruler: '#9BD1E5',
  tape: '#D4A373',
  stapler: '#6C5B7B',
  clip: '#A0AEC0',
};

/** 布局缩略图（文档 09 §5.2）：杂物、出生点、出口 */
export function layoutThumb(map: MapId, seed: string, fixedLayout = false): HTMLElement {
  const lay = generateLayout(map, seed, fixedLayout);
  if (!lay) return h('div.layout-thumb.empty', null, h('small.muted', null, '布局预览暂不可用'));
  const W = GRID_COLS;
  const H = GRID_ROWS;
  const parts: string[] = [];
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="0.4" fill="#F4EDDF"/>`);
  for (let x = 1; x < W; x++) parts.push(`<path d="M${x} 0V${H}" stroke="#3B2F2A" stroke-opacity=".08" stroke-width=".04"/>`);
  for (let y = 1; y < H; y++) parts.push(`<path d="M0 ${y}H${W}" stroke="#3B2F2A" stroke-opacity=".08" stroke-width=".04"/>`);
  for (const o of lay.obstacles) {
    parts.push(`<rect x="${o.x + 0.06}" y="${o.y + 0.06}" width="${o.w - 0.12}" height="${o.h - 0.12}" rx=".18" fill="${OBST_COLOR[o.kind] ?? '#C9AD80'}" stroke="#3B2F2A" stroke-width=".08"/>`);
  }
  for (const sp of lay.spawners) {
    const hidden = sp.kind === 'hidden';
    for (const c of sp.cells) {
      parts.push(
        `<rect x="${c.x + 0.1}" y="${c.y + 0.1}" width=".8" height=".8" rx=".2" fill="${hidden ? '#6C5B7B' : '#E63946'}" fill-opacity="${hidden ? 0.35 : 0.85}" stroke="#3B2F2A" stroke-width=".07"${hidden ? ' stroke-dasharray=".15 .1"' : ''}/>`,
      );
    }
  }
  for (const e of lay.exits) parts.push(`<rect x="${e.x + 0.1}" y="${e.y + 0.1}" width=".8" height=".8" rx=".15" fill="#2E4A7D" stroke="#3B2F2A" stroke-width=".07"/>`);
  const svg = `<svg viewBox="-0.2 -0.2 ${W + 0.4} ${H + 0.4}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="布局缩略图">${parts.join('')}</svg>`;
  const names = lay.spawners.filter((s) => s.kind !== 'hidden').map((s) => spawnerName(s.id, lay.spawners));
  return h(
    'div.layout-thumb',
    null,
    h('div.layout-svg', { html: svg }),
    h(
      'div.layout-legend',
      null,
      h('span', null, h('i.lg.spawn'), names.length > 1 ? `入口 ×${names.length}` : '入口'),
      lay.spawners.some((s) => s.kind === 'hidden') ? h('span', null, h('i.lg.hidden'), '暗门') : null,
      h('span', null, h('i.lg.exit'), '作业本'),
      h('span', null, h('i.lg.obst'), `杂物 ${lay.obstacles.length}`),
    ),
  );
}

/** 布局预览卡片（缩略图 + 换一个） */
export function layoutPicker(o: { map: () => MapId; seed: () => string; onReroll: () => void; fixed?: () => boolean }): { el: HTMLElement; refresh(): void } {
  const host = h('div.layout-host');
  const refresh = () => host.replaceChildren(layoutThumb(o.map(), o.seed(), o.fixed?.() ?? false));
  const btn = h(
    'button.btn.small',
    {
      onclick: () => {
        audio.play('click');
        o.onReroll();
        refresh();
      },
    },
    h('span.gi', { html: G.refresh }),
    '换一个',
  );
  const el = h('div.layout-picker', null, host, h('div.layout-side', null, h('p.muted.small', null, '杂物按种子随机摆放，同一个种子布局完全相同。'), btn));
  refresh();
  return { el, refresh };
}

/** 技能带入条（选关页面底部） */
export function loadoutStrip(app: App, from: Route): HTMLElement {
  const p = app.store.get();
  const skills = resolveLoadout(p, unlockedSkills(p));
  return h(
    'div.loadout-strip.card',
    null,
    h('span.strip-label', null, '带入技能'),
    h(
      'div.strip-skills',
      null,
      skills.map((s) =>
        h('span.strip-skill', { title: SKILL_META[s]?.name ?? s }, img(skillIcon(s), 'ico'), h('small', null, `Lv${skillLevel(p, s)}`)),
      ),
    ),
    h(
      'button.btn.small',
      {
        onclick: () => {
          audio.play('click');
          app.go({ name: 'skills', from });
        },
      },
      '调整',
    ),
  );
}

export function starRow(n: number, max = 3): HTMLElement {
  const wrap = h('span.stars', { attrs: { 'aria-label': `${n} 星` } });
  for (let i = 0; i < max; i++) wrap.appendChild(h(`span.star${i < n ? '.on' : ''}`));
  return wrap;
}
