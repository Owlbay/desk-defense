import { getLocale, LOCALES, setLocale, t } from '../../i18n';
import { getAutoUpload, setAutoUpload } from '../../meta/online';
import { AI_GLYPH } from '../ai/icon';
import { type App, applySettings, confirmDialog, type Screen, screenHeader } from '../App';
import { audio } from '../audio';
import { h } from '../dom';
import { G } from '../icons';
import { rememberLocale } from '../locale';
import { THEME_MODES, type ThemeMode } from '../theme';
import { anim, popSelected } from './motion';

/** 滑块数值变化时轻轻跳一下（上一次没播完就接着播，不叠加） */
function bump(el: HTMLElement): void {
  if (el.getAnimations?.().length) return;
  anim(el, [{ transform: 'scale(1.14)' }, { transform: 'scale(1)' }], { duration: 160, easing: 'ease-out' });
}

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
              popSelected(qualitySeg);
            },
          },
          q === 'high' ? t('ui.settings.qualityHigh') : t('ui.settings.qualityLow'),
        ),
      ),
    );
  };
  renderQuality();

  // 主题：跟随系统 / 浅色 / 深色（applySettings → setTheme 立即生效，棋盘同步换成夜晚的桌面）
  const themeLabel = t('ui.settings.theme');
  const themeSeg = h('div.seg-grid.three', { attrs: { role: 'radiogroup', 'aria-label': themeLabel } });
  const renderTheme = () => {
    const cur = app.store.get().settings.theme ?? 'system';
    const names: Record<ThemeMode, string> = {
      system: t('ui.settings.themeSystem'),
      light: t('ui.settings.themeLight'),
      dark: t('ui.settings.themeDark'),
    };
    themeSeg.replaceChildren(
      ...THEME_MODES.map((m) =>
        h(
          `button.seg${cur === m ? '.on' : ''}`,
          {
            attrs: { role: 'radio', 'aria-checked': String(cur === m), 'data-focus-key': `theme-${m}` },
            onclick: () => {
              audio.play('click');
              if (m === app.store.get().settings.theme) return;
              save(() => (app.store.get().settings.theme = m));
              renderTheme();
              popSelected(themeSeg);
            },
          },
          names[m],
        ),
      ),
    );
  };
  renderTheme();

  const waveSeg = h('div.seg-grid.three');
  const renderWave = () => {
    const cur = app.store.get().settings.autoWave;
    const opts: [boolean | null, string][] = [
      [null, t('ui.settings.waveByDiff')],
      [true, t('ui.settings.waveAuto')],
      [false, t('ui.settings.waveManual')],
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
              popSelected(waveSeg);
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

  const mazeInput = h<HTMLInputElement>('input', { attrs: { type: 'checkbox' } });
  mazeInput.checked = !!s.mazeHint;
  mazeInput.onchange = () => {
    audio.play('click');
    save(() => (app.store.get().settings.mazeHint = mazeInput.checked));
  };

  // 自动上传成绩：与排行榜页的开关是同一个设置（src/meta/online.ts AUTO_UPLOAD_KEY）
  const uploadInput = h<HTMLInputElement>('input', { attrs: { type: 'checkbox' } });
  uploadInput.checked = getAutoUpload();
  uploadInput.onchange = () => {
    audio.play('click');
    setAutoUpload(uploadInput.checked);
  };

  const motionInput = h<HTMLInputElement>('input', { attrs: { type: 'checkbox' } });
  motionInput.checked = s.reduceMotion;
  motionInput.onchange = () => {
    audio.play('click');
    save(() => (app.store.get().settings.reduceMotion = motionInput.checked));
  };

  const volume = (label: string, glyph: string, key: 'sfx' | 'music') => {
    const out = h('output.slider-val', null, `${Math.round(s[key] * 100)}%`);
    const input = h<HTMLInputElement>('input.range', { attrs: { type: 'range', min: 0, max: 100, step: 5, 'aria-label': label } });
    input.value = String(Math.round(s[key] * 100));
    input.style.setProperty('--fill', `${input.value}%`);
    input.addEventListener('input', () => {
      const v = Number(input.value) / 100;
      out.textContent = `${input.value}%`;
      bump(out);
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

  // 语言：每种语言用它自己的文字显示；切换后 App 会重新渲染当前页面（对局中就地刷新 HUD）
  const langSeg = h('div.seg-grid.two', { attrs: { role: 'radiogroup', 'aria-label': t('common.language') } });
  const renderLang = () => {
    const cur = getLocale();
    langSeg.replaceChildren(
      ...LOCALES.map((l) =>
        h(
          `button.seg${cur === l.id ? '.on' : ''}`,
          {
            attrs: { lang: l.id, role: 'radio', 'aria-checked': String(cur === l.id), 'data-focus-key': `lang-${l.id}` },
            onclick: () => {
              audio.play('click');
              if (l.id === getLocale()) return;
              rememberLocale(app.store, l.id);
              void setLocale(l.id).then(() => {
                // 设置面板在对局暂停菜单里时，App 不会重建它：就地刷新选中态
                if (langSeg.isConnected) renderLang();
              });
            },
          },
          l.label,
        ),
      ),
    );
  };
  renderLang();

  const host = opts.host ?? app.root;
  return h(
    'div.settings-panel',
    null,
    h('section.card.section', null, h('h3', null, getLocale() === 'en' ? 'Language' : `${t('common.language')} · Language`), langSeg),
    h(
      'section.card.section',
      null,
      h('h3', null, t('ui.settings.quality')),
      qualitySeg,
      h('p.muted', null, t('ui.settings.qualityHint')),
      h('div.field-label', null, h('b', null, themeLabel), h('small.muted', null, t('ui.settings.themeHint'))),
      themeSeg,
      h(
        'label.switch-row',
        null,
        h('span', null, h('b', null, t('ui.settings.reduceMotion')), h('small.muted', null, t('ui.settings.reduceMotionHint'))),
        h('span.switch', null, motionInput, h('span.knob')),
      ),
    ),
    h(
      'section.card.section',
      null,
      h('h3', null, t('ui.settings.sound')),
      volume(t('ui.settings.sfx'), G.sound, 'sfx'),
      volume(t('ui.settings.music'), G.music, 'music'),
    ),
    h(
      'section.card.section',
      null,
      h('h3', null, t('ui.settings.game')),
      h(
        'div.field-label',
        null,
        h('b', null, t('ui.settings.waveMode')),
        h('small.muted', null, opts.inGame ? t('ui.settings.nextRun') : t('ui.settings.waveModeHint')),
      ),
      waveSeg,
      h(
        'label.switch-row',
        null,
        h('span', null, h('b', null, t('ui.settings.fixedLayout')), h('small.muted', null, t('ui.settings.fixedLayoutHint'))),
        h('span.switch', null, fixedInput, h('span.knob')),
      ),
      h(
        'label.switch-row',
        null,
        h('span', null, h('b', null, t('ui.settings.mazeHint')), h('small.muted', null, t('ui.settings.mazeHintHint'))),
        h('span.switch', null, mazeInput, h('span.knob')),
      ),
      h(
        'label.switch-row',
        null,
        h('span', null, h('b', null, t('ui.lb.autoUpload')), h('small.muted', null, t('ui.lb.autoUploadHint'))),
        h('span.switch', null, uploadInput, h('span.knob')),
      ),
    ),
    // AI 助手：全局模型设置（对局里的 AI 按钮与「AI 参战」共用）；对局里从 AI 按钮的「配置模型…」打开
    opts.inGame
      ? null
      : h(
          'section.card.section.ai-assist-section',
          null,
          h('h3', null, h('span.gi', { html: AI_GLYPH }), t('ui.assist.title')),
          h('p.muted', null, t('ui.assist.settingsHint')),
          h(
            'button.btn',
            {
              attrs: { type: 'button' },
              onclick: () => {
                audio.play('click');
                app.go({ name: 'aiAssistant' });
              },
            },
            h('span.gi', { html: G.sliders }),
            t('ui.assist.openSettings'),
          ),
        ),
    h(
      'section.card.section',
      null,
      h('h3', null, t('ui.settings.save')),
      h(
        'div.setting-actions',
        null,
        h(
          'button.btn',
          {
            onclick: () => {
              audio.play('click');
              app.store.update((p) => (p.tutorial = {}));
              app.toast(t('ui.settings.tutorialResetDone'), 'good');
            },
          },
          t('ui.settings.tutorialReset'),
        ),
        opts.inGame
          ? null
          : h(
              'button.btn.danger',
              {
                onclick: async () => {
                  audio.play('click');
                  const ok = await confirmDialog(host, {
                    title: t('ui.settings.wipeTitle'),
                    text: t('ui.settings.wipeText'),
                    ok: t('ui.settings.wipeOk'),
                    danger: true,
                  });
                  if (!ok) return;
                  app.store.reset();
                  applySettings(app.store.get().settings);
                  app.toast(t('ui.settings.wipeDone'), 'info');
                  app.go({ name: 'menu' });
                },
              },
              t('ui.settings.wipe'),
            ),
      ),
    ),
  );
}

export function settingsScreen(app: App): Screen {
  const el = h('div.screen.settings-screen');
  el.append(
    screenHeader(app, t('ui.settings.title'), { chips: false }),
    h('div.screen-body.narrow', null, settingsPanel(app, { host: el }), h('p.muted.center', null, t('ui.settings.footer'))),
  );
  return { el };
}
