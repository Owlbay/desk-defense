import { applySettings, confirmDialog, screenHeader, type App, type Screen } from '../App';
import { audio } from '../audio';
import { h } from '../dom';
import { G } from '../icons';

/** 设置面板（菜单页与暂停菜单共用） */
export function settingsPanel(app: App, opts: { inGame?: boolean; host?: HTMLElement } = {}): HTMLElement {
  const s = app.store.get().settings;

  const save = (fn: () => void) => {
    app.store.update(() => fn());
    applySettings(app.store.get().settings);
  };

  const qualitySeg = h('div.seg-grid.two');
  const renderQuality = () => {
    qualitySeg.replaceChildren(
      ...(['high', 'low'] as const).map((q) =>
        h(
          `button.seg${app.store.get().settings.quality === q ? '.on' : ''}`,
          {
            onclick: () => {
              audio.play('click');
              save(() => (app.store.get().settings.quality = q));
              renderQuality();
            },
          },
          q === 'high' ? '高' : '低（省电）',
        ),
      ),
    );
  };
  renderQuality();

  const waveSeg = h('div.seg-grid.three');
  const renderWave = () => {
    const cur = app.store.get().settings.autoWave;
    const opts: [boolean | null, string][] = [
      [null, '按难度'],
      [true, '自动'],
      [false, '手动'],
    ];
    waveSeg.replaceChildren(
      ...opts.map(([v, label]) =>
        h(
          `button.seg${cur === v ? '.on' : ''}`,
          {
            onclick: () => {
              audio.play('click');
              save(() => (app.store.get().settings.autoWave = v));
              renderWave();
            },
          },
          label,
        ),
      ),
    );
  };
  renderWave();
  const fixedInput = h<HTMLInputElement>('input', { attrs: { type: 'checkbox' } });
  fixedInput.checked = s.fixedLayout;
  fixedInput.onchange = () => {
    audio.play('click');
    save(() => (app.store.get().settings.fixedLayout = fixedInput.checked));
  };

  const volume = (label: string, glyph: string, key: 'sfx' | 'music') => {
    const out = h('output.slider-val', null, `${Math.round(s[key] * 100)}%`);
    const input = h<HTMLInputElement>('input.range', { attrs: { type: 'range', min: 0, max: 100, step: 5, 'aria-label': label } });
    input.value = String(Math.round(s[key] * 100));
    input.style.setProperty('--fill', `${input.value}%`);
    input.addEventListener('input', () => {
      const v = Number(input.value) / 100;
      out.textContent = `${input.value}%`;
      input.style.setProperty('--fill', `${input.value}%`);
      app.store.get().settings[key] = v;
      applySettings(app.store.get().settings);
      if (key === 'music') audio.setMusic(v > 0);
    });
    input.addEventListener('change', () => {
      save(() => {});
      if (key === 'sfx') audio.play('select');
    });
    return h('label.slider-row', null, h('span.slider-label', null, h('span.gi', { html: glyph }), h('b', null, label)), out, input);
  };

  const host = opts.host ?? app.root;
  return h(
    'div.settings-panel',
    null,
    h('section.card.section', null, h('h3', null, '画质'), qualitySeg, h('p.muted', null, '低画质关闭发光层和光环粒子，适合老手机。')),
    h('section.card.section', null, h('h3', null, '声音'), volume('音效', G.sound, 'sfx'), volume('音乐', G.music, 'music')),
    h(
      'section.card.section',
      null,
      h('h3', null, '对局'),
      h('div.field-label', null, h('b', null, '开波方式'), h('small.muted', null, opts.inGame ? '下一局生效' : '按难度：简单和新手引导为手动，其余为自动')),
      waveSeg,
      h(
        'label.switch-row',
        null,
        h('span', null, h('b', null, '战役固定布局'), h('small.muted', null, '战役里的杂物每局摆在同一个位置')),
        h('span.switch', null, fixedInput, h('span.knob')),
      ),
    ),
    h(
      'section.card.section',
      null,
      h('h3', null, '存档'),
      h(
        'div.setting-actions',
        null,
        h(
          'button.btn',
          {
            onclick: () => {
              audio.play('click');
              app.store.update((p) => (p.tutorial = {}));
              app.toast('新手引导已重置，下次进入第一章时会重新出现', 'good');
            },
          },
          '重置新手引导',
        ),
        opts.inGame
          ? null
          : h(
              'button.btn.danger',
              {
                onclick: async () => {
                  audio.play('click');
                  const ok = await confirmDialog(host, {
                    title: '清除全部存档？',
                    text: '战役星星、墨水、天赋、技能等级、排行榜和中途存档都会被删除，无法恢复。',
                    ok: '全部清除',
                    danger: true,
                  });
                  if (!ok) return;
                  app.store.reset();
                  applySettings(app.store.get().settings);
                  app.toast('存档已清除', 'info');
                  app.go({ name: 'menu' });
                },
              },
              '清除存档',
            ),
      ),
    ),
  );
}

export function settingsScreen(app: App): Screen {
  const el = h('div.screen.settings-screen');
  el.append(screenHeader(app, '设置', { chips: false }), h('div.screen-body.narrow', null, settingsPanel(app, { host: el }), h('p.muted.center', null, '书桌防线 · Desk Defense')));
  return { el };
}
