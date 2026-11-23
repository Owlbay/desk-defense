/**
 * 「AI 参战」设置页（动态分包：进入页面时才加载，连同 src/agent 的纯逻辑）。
 *
 * 角色（AI 玩家 / AI 军师 / AI 出题 / AI 对战）→ 对局（模式 / 地图 / 难度 / 种子）→ 模型设置表单（与设置里的「AI 助手」共用，
 * 见 model-form.ts）→ 开始。AI 参战的对局由 AI 从第 1 波开始全程操作，可以进 AI 榜。
 */
import { resolveConfig, saveableConfig } from '../../agent';
import type { DifficultyId, MapId } from '../../core/types';
import { t } from '../../i18n';
import {
  ABYSS_MAX,
  campaignDiffUnlocked,
  chapterCleared,
  DIFF_NAME,
  difficultyUnlocked,
  MAPS,
  maxAbyssLevel,
  roman,
} from '../../meta/progress';
import type { App } from '../App';
import { audio } from '../audio';
import { collapsible } from '../collapse';
import { MAP_META } from '../coreMeta';
import { clear, h, setText } from '../dom';
import { G } from '../icons';
import { buildRunOptions, layoutPicker, randomSeed, switchRow } from '../screens/common';
import { doctrinePicker } from './doctrine-ui';
import { type AiLaunch, type AiRole, attackLaunch, duelLaunch, requestAiLaunch } from './launch';
import { field, mountAiModelConfigForm } from './model-form';
import { type AiSetupKind, type AiSetupSaved, loadAttackerSetup, loadSetup, saveAttackerSetup } from './store';

export { normalizeDiag } from './model-form';

const DIFF_ORDER: DifficultyId[] = ['easy', 'normal', 'hard', 'nightmare', 'abyss'];

export function mountAiSetup(app: App, body: HTMLElement): () => void {
  const p = app.store.get();
  const st: AiSetupSaved = loadSetup();
  let disposed = false;
  const run = { seed: '', layoutSeed: randomSeed(), rerolled: false };

  // ── 可选范围：AI 模式不发奖励，简单 / 普通与第一章始终可选，其余跟随玩家的解锁进度 ──
  const mapOk = (m: MapId): boolean => (st.run.mode === 'campaign' ? chapterCleared(p, m) : m === 'ch1' || chapterCleared(p, m));
  const abyssMax = maxAbyssLevel(p);
  const diffOk = (d: DifficultyId): boolean => {
    if (st.run.mode === 'campaign') return (d === 'normal' || d === 'hard') && campaignDiffUnlocked(p, st.run.map, d);
    if (d === 'easy' || d === 'normal') return true;
    return d === 'abyss' ? abyssMax > 0 : difficultyUnlocked(p, d);
  };
  const campaignOk = MAPS.some((m) => chapterCleared(p, m));
  const fixRun = (): void => {
    if (st.run.mode === 'campaign' && !campaignOk) st.run.mode = 'endless';
    if (!mapOk(st.run.map)) st.run.map = MAPS.find(mapOk) ?? 'ch1';
    if (!diffOk(st.run.difficulty)) st.run.difficulty = 'normal';
    st.run.abyss = Math.max(1, Math.min(abyssMax || 1, st.run.abyss));
  };
  fixRun();

  /** 玩法：AI 防守（AI 玩家 / 军师）/ AI 出题（AI 进攻、你防守）/ AI 对战（两个模型） */
  const kind = (): AiSetupKind => st.kind ?? 'defend';
  /** 主表单写进配置的角色：AI 对战里它是防守方（玩家）；AI 出题里是进攻方（attackLaunch 再改成 attacker） */
  const formRole = (): AiRole => (kind() === 'defend' ? st.role : kind() === 'duel' ? 'player' : 'advisor');

  // 模型设置（与「AI 助手」共用同一个表单与同一份保存的设置）
  const summary = h('p.ai-summary.muted');
  const form = mountAiModelConfigForm(app, { st, role: formRole, onChange: () => paintSummary() });
  const persist = (): void => form.persist();
  // AI 对战：进攻方模型（同一个表单组件，另存一份设置；决策固定为暂停模式，不显示决策卡片）
  const aform = mountAiModelConfigForm(app, {
    st: loadAttackerSetup(),
    role: () => 'advisor',
    save: saveAttackerSetup,
    heading: t('agent.duel.attackerModel'),
    onChange: () => paintSummary(),
  });
  const kindNote = h('p.muted.small.ai-kind-note');
  // 中心策略（§20）：AI 玩家 / 军师 / AI 对战的防守方；AI 出题（AI 只进攻）不用
  const doctrine = doctrinePicker(st.doctrine, (c) => {
    st.doctrine = c;
    persist();
  });
  const doctrineCard = h('section.card.section.ai-card', null, h('h3', null, t('agent.doctrine.title')), doctrine.el);
  const paintKind = (): void => {
    const k = kind();
    doctrineCard.hidden = k === 'attack';
    aform.modelCard.hidden = k !== 'duel';
    aform.errBox.hidden = k !== 'duel';
    const head = form.modelCard.querySelector('h3');
    if (head)
      setText(head, k === 'duel' ? t('agent.duel.defenderModel') : k === 'attack' ? t('agent.duel.attackerModel') : t('agent.setup.model'));
    // 两边都固定为暂停模式：决策卡片里的「暂停 / 实时」只对 AI 防守有意义
    kindNote.hidden = k === 'defend';
    setText(kindNote, k === 'duel' ? t('agent.duel.setupNote') : k === 'attack' ? t('agent.duel.attackNote') : '');
  };

  // ───────────── 角色 ─────────────
  const roleBox = h('div.ai-roles', { attrs: { role: 'radiogroup', 'aria-label': t('agent.setup.role.aria') } });
  const paintRoles = (): void => {
    clear(roleBox);
    const card = (role: AiRole, title: string, text: string, glyph: string) =>
      h(
        `button.ai-role${st.role === role && kind() === 'defend' ? '.on' : ''}`,
        {
          attrs: { type: 'button', role: 'radio', 'aria-checked': st.role === role && kind() === 'defend' ? 'true' : 'false' },
          onclick: () => {
            if (st.role === role && kind() === 'defend') return;
            audio.play('click');
            st.role = role;
            st.kind = 'defend';
            form.roleChanged(role);
            paintRoles();
            paintKind();
            paintSummary();
          },
        },
        h('span.gi', { html: glyph }),
        h('span.ai-role-text', null, h('b', null, title), h('small', null, text)),
      );
    const kindCard = (k: Exclude<AiSetupKind, 'defend'>, title: string, text: string, glyph: string) =>
      h(
        `button.ai-role${kind() === k ? '.on' : ''}`,
        {
          attrs: { type: 'button', role: 'radio', 'aria-checked': kind() === k ? 'true' : 'false' },
          onclick: () => {
            if (kind() === k) return;
            audio.play('click');
            st.kind = k;
            // 进攻方 / AI 对战都按暂停模式（进攻方要在开波前出题）
            form.roleChanged('player');
            paintRoles();
            paintKind();
            paintSummary();
          },
        },
        h('span.gi', { html: glyph }),
        h('span.ai-role-text', null, h('b', null, title), h('small', null, text)),
      );
    roleBox.append(
      card('player', t('agent.setup.role.player'), t('agent.setup.role.playerDesc'), G.bolt),
      card('advisor', t('agent.setup.role.advisor'), t('agent.setup.role.advisorDesc'), G.eye),
      kindCard('attack', t('agent.duel.roleAttack'), t('agent.duel.roleAttackDesc'), G.sword),
      kindCard('duel', t('agent.duel.roleDuel'), t('agent.duel.roleDuelDesc'), G.target),
    );
  };

  // ───────────── 对局 ─────────────
  const modeBox = h('div.seg-grid.two');
  const mapBox = h('div.seg-grid.maps');
  const diffBox = h('div.seg-grid.ai-diffs');
  const abyssBox = h('div.ai-abyss');
  const seedInput = h<HTMLInputElement>('input.input', {
    attrs: {
      type: 'text',
      placeholder: t('agent.setup.seedPlaceholder'),
      maxlength: 24,
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': t('agent.setup.seed'),
    },
  });
  const runSeed = (): string => seedInput.value.trim() || run.layoutSeed;
  const layout = layoutPicker({
    map: () => st.run.map,
    seed: runSeed,
    onReroll: () => {
      run.layoutSeed = randomSeed();
      run.rerolled = true;
      seedInput.value = '';
    },
  });
  let seedTimer = 0;
  seedInput.addEventListener('input', () => {
    clearTimeout(seedTimer);
    seedTimer = window.setTimeout(() => layout.refresh(), 250);
  });
  const pureSw = switchRow(t('agent.setup.pure'), t('agent.setup.pureHint'), st.run.pure, (v) => {
    st.run.pure = v;
    persist();
  });
  const autoSw = switchRow(t('agent.setup.autoWave'), t('agent.setup.autoWaveHint'), st.run.autoWave, (v) => {
    st.run.autoWave = v;
    persist();
  });
  const runNote = h('p.muted.small.ai-run-note');

  const paintRun = (): void => {
    fixRun();
    clear(modeBox);
    for (const m of ['endless', 'campaign'] as const) {
      const ok = m === 'endless' || campaignOk;
      modeBox.appendChild(
        h(
          `button.seg${st.run.mode === m ? '.on' : ''}${ok ? '' : '.locked'}`,
          {
            attrs: { type: 'button', 'aria-pressed': st.run.mode === m ? 'true' : 'false' },
            onclick: () => {
              if (!ok) return (audio.play('error'), app.toast(t('agent.setup.campaignLocked'), 'warn'));
              if (st.run.mode === m) return;
              audio.play('click');
              st.run.mode = m;
              persist();
              paintRun();
            },
          },
          ok ? null : h('span.gi', { html: G.lock }),
          m === 'endless' ? t('agent.setup.mode.endless') : t('agent.setup.mode.campaign'),
        ),
      );
    }
    clear(mapBox);
    for (const m of MAPS) {
      const ok = mapOk(m);
      mapBox.appendChild(
        h(
          `button.seg${st.run.map === m ? '.on' : ''}${ok ? '' : '.locked'}`,
          {
            attrs: { type: 'button', 'aria-pressed': st.run.map === m ? 'true' : 'false' },
            onclick: () => {
              if (!ok) return (audio.play('error'), app.toast(t('agent.setup.mapLocked'), 'warn'));
              if (st.run.map === m) return;
              audio.play('click');
              st.run.map = m;
              persist();
              paintRun();
              layout.refresh();
            },
          },
          ok ? null : h('span.gi', { html: G.lock }),
          MAP_META[m]?.name ?? m,
        ),
      );
    }
    clear(diffBox);
    for (const d of st.run.mode === 'campaign' ? (['normal', 'hard'] as DifficultyId[]) : DIFF_ORDER) {
      const ok = diffOk(d);
      diffBox.appendChild(
        h(
          `button.seg${st.run.difficulty === d ? '.on' : ''}${ok ? '' : '.locked'}${d === 'abyss' ? '.abyss' : ''}`,
          {
            attrs: { type: 'button', 'aria-pressed': st.run.difficulty === d ? 'true' : 'false' },
            onclick: () => {
              if (!ok) return (audio.play('error'), app.toast(t('agent.setup.diffLocked'), 'warn'));
              if (st.run.difficulty === d) return;
              audio.play('click');
              st.run.difficulty = d;
              persist();
              paintRun();
            },
          },
          ok ? null : h('span.gi', { html: G.lock }),
          DIFF_NAME[d],
        ),
      );
    }
    clear(abyssBox);
    if (st.run.difficulty === 'abyss' && st.run.mode === 'endless') {
      const sel = h<HTMLSelectElement>('select.input', { attrs: { 'aria-label': t('agent.setup.abyssLevel') } });
      for (let i = 1; i <= Math.min(ABYSS_MAX, abyssMax); i++)
        sel.appendChild(h('option', { attrs: { value: i, selected: i === st.run.abyss } }, t('agent.setup.abyssN', { lv: roman(i) })));
      sel.onchange = () => {
        st.run.abyss = Number(sel.value) || 1;
        persist();
      };
      abyssBox.appendChild(field(t('agent.setup.abyssLevel'), sel));
    }
    layout.el.hidden = st.run.mode !== 'endless';
    pureSw.el.hidden = st.run.mode !== 'endless';
    setText(runNote, st.run.mode === 'endless' ? t('agent.setup.runNote.endless') : t('agent.setup.runNote.campaign'));
    paintSummary();
  };

  // ───────────── 开始 ─────────────
  function paintSummary(): void {
    const k = kind();
    if (k === 'duel') {
      setText(
        summary,
        `${t('agent.duel.roleDuel')} · ${t('agent.duel.label', { attacker: aform.sourceLabel(), defender: form.sourceLabel() })} · ${t('agent.setup.decision.pause')}`,
      );
      return;
    }
    if (k === 'attack') {
      setText(summary, `${t('agent.duel.roleAttack')} · ${form.sourceLabel()} · ${t('agent.setup.decision.pause')}`);
      return;
    }
    const role = st.role === 'player' ? t('agent.setup.role.player') : t('agent.setup.role.advisor');
    setText(
      summary,
      `${role} · ${form.sourceLabel()} · ${st.decisionMode === 'pause' ? t('agent.setup.decision.pause') : t('agent.setup.decision.realtime')}`,
    );
  }

  const startBtn = h(
    'button.btn.primary.big',
    {
      attrs: { type: 'button' },
      onclick: async () => {
        const k = kind();
        const duel = k === 'duel';
        if (form.busy() || (duel && aform.busy())) return;
        for (const f of duel ? [aform, form] : [form]) {
          const errs = f.errors(true);
          if (errs.length) {
            audio.play('error');
            app.toast(errs[0], 'warn');
            f.errBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            return;
          }
        }
        audio.play('click');
        if (!(await form.prepare()) || disposed) return;
        if (duel && (!(await aform.prepare()) || disposed)) return;
        audio.play('select');
        const cfg = form.buildConfig();
        if (k !== 'attack' && st.doctrine) cfg.doctrine = { ...st.doctrine };
        const resolved = resolveConfig(cfg);
        st.lastConfig = saveableConfig(resolved);
        persist();
        if (duel) aform.persist();
        const typed = seedInput.value.trim();
        const endless = st.run.mode === 'endless';
        const userSeed = endless && (!!typed || run.rerolled);
        const provider = form.provider();
        const base: AiLaunch = {
          config: cfg,
          role: k === 'defend' ? st.role : 'player',
          mode: st.decisionMode,
          label: form.sourceLabel(),
          userSeed,
          ...(provider ? { provider } : {}),
        };
        if (duel) {
          const ap = aform.provider();
          requestAiLaunch(duelLaunch(base, { config: aform.buildConfig(), label: aform.sourceLabel(), ...(ap ? { provider: ap } : {}) }));
        } else if (k === 'attack') requestAiLaunch(attackLaunch({ ...base, role: 'advisor' }));
        else requestAiLaunch(base);
        app.go({
          name: 'game',
          userSeed,
          opts: buildRunOptions(app.store.get(), {
            mode: st.run.mode,
            map: st.run.map,
            difficulty: st.run.difficulty,
            abyssLevel: st.run.abyss,
            ...(endless ? { seed: runSeed(), pure: st.run.pure } : {}),
            autoWave: autoSw.input.checked,
          }),
        });
      },
    },
    h('span.gi', { html: G.play }),
    t('agent.setup.start'),
  );

  const runCard = h(
    'section.card.section.ai-card',
    null,
    h('h3', null, t('agent.setup.sec.run')),
    field(t('agent.setup.field.mode'), modeBox),
    field(t('agent.setup.field.map'), mapBox),
    layout.el,
    field(t('agent.setup.field.difficulty'), diffBox),
    abyssBox,
    h('label.field', null, h('span', null, t('agent.setup.seed')), seedInput),
    pureSw.el,
    autoSw.el,
    runNote,
  );
  // 长页面（手机上三屏多）：对局 / 中心策略 / 决策与预算可以收起，收起时显示当前选择；决策与预算默认收起
  const folds = [
    collapsible(runCard, { key: 'ai.setup.run' }),
    collapsible(doctrineCard, { key: 'ai.setup.doctrine' }),
    collapsible(form.decisionCard, { key: 'ai.setup.decision', folded: true }),
  ];
  body.addEventListener('click', () => requestAnimationFrame(() => folds.forEach((f) => f.refresh())));

  const roleCard = h('section.card.section.ai-card', null, h('h3', null, t('agent.setup.sec.role')), roleBox, kindNote);
  folds.unshift(collapsible(roleCard, { key: 'ai.setup.role' }));
  body.replaceChildren(
    roleCard,
    runCard,
    doctrineCard,
    aform.modelCard,
    form.modelCard,
    form.decisionCard,
    summary,
    aform.errBox,
    form.errBox,
    h('div.start-bar', null, startBtn),
  );

  paintRoles();
  paintKind();
  paintRun();
  paintSummary();

  return () => {
    disposed = true;
    folds.forEach((f) => f.destroy());
    form.destroy();
    aform.destroy();
    clearTimeout(seedTimer);
  };
}
