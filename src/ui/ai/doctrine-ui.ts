/**
 * 中心策略（文档 10 §20）的界面部件：设置页的选择卡片、对局侧栏的标签与切换菜单共用。
 */
import { DOCTRINE_PRESETS, type DoctrinePreset, type DoctrineState, parseDoctrine } from '../../agent/doctrine';
import { t } from '../../i18n';
import { audio } from '../audio';
import { clear, h, setText } from '../dom';
import { switchRow } from '../screens/common';
import type { AiSetupSaved } from './store';

export type DoctrineChoice = NonNullable<AiSetupSaved['doctrine']>;

export const doctrineName = (p: DoctrinePreset | 'custom' | 'auto'): string =>
  p === 'auto' ? t('agent.doctrine.auto') : t(`agent.doctrine.p.${p}`);

/** 侧栏标签文字 */
export function doctrineTag(st: DoctrineState | null | undefined): string {
  if (!st) return '';
  if (!st.chosen) return t('agent.doctrine.tagAuto');
  const name = doctrineName(st.doc.preset);
  return st.locked ? t('agent.doctrine.tagLocked', { name }) : t('agent.doctrine.tag', { name });
}

/** 设置页：选择卡片（AI 自动选 + 7 个预设）、玩家原话（自动认出预设）、锁定开关 */
export function doctrinePicker(initial: DoctrineChoice | undefined, onChange: (c: DoctrineChoice) => void): { el: HTMLElement } {
  const c: DoctrineChoice = {
    preset: initial?.preset ?? 'auto',
    locked: !!initial?.locked,
    ...(initial?.notes ? { notes: initial.notes } : {}),
  };
  const grid = h('div.seg-grid.ai-doctrines', { attrs: { role: 'radiogroup', 'aria-label': t('agent.doctrine.title') } });
  const desc = h('p.muted.small.ai-doctrine-desc');
  const matched = h('p.small.ai-doctrine-match');
  const notes = h<HTMLInputElement>('input.input', {
    attrs: { type: 'text', maxlength: 120, placeholder: t('agent.doctrine.notesPlaceholder'), 'aria-label': t('agent.doctrine.notes') },
  });
  notes.value = c.notes ?? '';
  const lock = switchRow(t('agent.doctrine.lock'), t('agent.doctrine.lockHint'), c.locked, (v) => {
    c.locked = v;
    onChange({ ...c });
  });
  const paint = (): void => {
    clear(grid);
    for (const p of ['auto', ...DOCTRINE_PRESETS] as const) {
      const on = c.preset === p;
      grid.appendChild(
        h(
          `button.seg${on ? '.on' : ''}`,
          {
            attrs: { type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false' },
            onclick: () => {
              if (c.preset === p) return;
              audio.play('click');
              c.preset = p;
              paint();
              onChange({ ...c });
            },
          },
          doctrineName(p),
        ),
      );
    }
    setText(desc, c.preset === 'auto' ? t('agent.doctrine.autoDesc') : t(`agent.doctrine.d.${c.preset}`));
    lock.el.hidden = c.preset === 'auto';
  };
  notes.addEventListener('input', () => {
    const v = notes.value.trim();
    c.notes = v || undefined;
    const m = v ? parseDoctrine(v) : null;
    if (m?.preset && m.preset !== c.preset) {
      c.preset = m.preset;
      paint();
    }
    setText(matched, m?.preset ? t('agent.doctrine.matched', { name: doctrineName(m.preset) }) : '');
    onChange({ ...c });
  });
  paint();
  const el = h(
    'div.ai-doctrine',
    null,
    h('p.muted.small', null, t('agent.doctrine.hint')),
    grid,
    desc,
    h('label.field', null, h('span', null, t('agent.doctrine.notes')), notes),
    matched,
    lock.el,
  );
  return { el };
}

/** 对局里切换：返回菜单元素（预设按钮 + 锁定 + 修改记录）；onPick 交给控制器 */
export function doctrineMenu(st: DoctrineState | null, on: { pick: (p: DoctrinePreset) => void; lock: (v: boolean) => void }): HTMLElement {
  const box = h('div.ai-doctrine-menu');
  const grid = h('div.seg-grid.ai-doctrines');
  for (const p of DOCTRINE_PRESETS) {
    const cur = !!st?.chosen && st.doc.preset === p;
    grid.appendChild(
      h(
        `button.seg${cur ? '.on' : ''}${st?.suggested === p ? '.suggested' : ''}`,
        { attrs: { type: 'button', title: t(`agent.doctrine.d.${p}`) }, onclick: () => on.pick(p) },
        doctrineName(p),
      ),
    );
  }
  box.append(h('b', null, t('agent.doctrine.menu')), grid);
  if (st?.chosen) box.append(switchRow(t('agent.doctrine.lock'), t('agent.doctrine.lockHint'), st.locked, on.lock).el);
  if (st?.log.length) {
    const ul = h('ul.ai-doctrine-log.small.muted');
    for (const l of st.log.slice(-8).reverse())
      ul.appendChild(
        h(
          'li',
          null,
          t('agent.doctrine.historyItem', {
            wave: l.wave,
            from: l.from === 'none' ? t('agent.doctrine.none') : doctrineName(l.from as DoctrinePreset),
            to: doctrineName(l.to as DoctrinePreset),
            by: t(`agent.doctrine.by.${l.by}`),
            why: l.why ? ` · ${l.why}` : '',
          }),
        ),
      );
    box.append(h('b', null, t('agent.doctrine.history')), ul);
  }
  return box;
}
