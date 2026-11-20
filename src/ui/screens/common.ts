import type { DifficultyId, DifficultyParams, MapId, ModeId, RunOptions, SkillId } from '../../core/types';
import type { Profile } from '../../meta/profile';
import { resolveLoadout, skillLevel, unlockReached } from '../../meta/progress';
import type { App, Route } from '../App';
import { skillIcon } from '../assets';
import { audio } from '../audio';
import { SKILL_META, SKILL_ORDER } from '../coreMeta';
import { h, img } from '../dom';

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
  return opts;
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
