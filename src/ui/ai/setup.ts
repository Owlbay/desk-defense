/**
 * 「AI 参战」设置表单（动态分包：进入页面时才加载，连同 src/agent 的纯逻辑）。
 *
 * 角色（AI 玩家 / AI 军师）→ 对局（模式 / 地图 / 难度 / 种子）→ 模型（直连 / 本机桥接）→ 决策与预算 → 开始。
 * 只保存不含密钥的配置（saveableConfig）；Key 的存放方式由玩家选择，默认只在内存。
 */
import {
  BYO_KEY_WARNING,
  CLAUDE_MODELS,
  FAMILY_LABEL,
  PRESETS,
  RELAY_API_LABEL,
  classifyRelayError,
  connectBridge,
  detectRelayApi,
  groupModels,
  normalizeRelayBase,
  parseRelayUrl,
  relayFailureText,
  relayHost,
  listModels,
  resolveConfig,
  saveableConfig,
  testConnection,
  validateConfig,
  type AgentModelConfig,
  type ConnectionDiagnostics,
  CONTEXT_MODES,
  CONTEXT_MODE_LABEL,
  THINKING_LABEL,
  claudeThinkingPlan,
  type ContextMode,
  type ThinkingLevel,
  type LLMProvider,
  type PiApi,
  type Preset,
  type RelayApi,
  type RelayDetection,
} from '../../agent';
import type { WsLike } from '../../agent/bridge';
import type { DifficultyId, MapId } from '../../core/types';
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
import { MAP_META } from '../coreMeta';
import { clear, copyText, fmtNum, h, setText } from '../dom';
import { G } from '../icons';
import { buildRunOptions, layoutPicker, randomSeed, switchRow } from '../screens/common';
import { requestAiLaunch, type AiRole } from './launch';
import { bridgeCommands, detectOs, localGuides, networkNotes, OS_NAME, type OsId, type SetupStep } from './snippets';
import { forgetKey, keyModeOf, loadSetup, readKey, saveSetup, writeKey, type AiSetupSaved, type AiSource, type KeyMode } from './store';

const SOURCE_ORDER: AiSource[] = ['demo', 'relay', 'claude', 'openai', 'google', 'openrouter', 'deepseek', 'ollama', 'lmstudio', 'llamacpp', 'vllm', 'anthropic', 'custom'];
const SOURCE_LABEL = (s: AiSource): string =>
  s === 'demo' ? '离线演示（内置策略，不需要 Key）' : s === 'claude' ? 'Claude（官方 SDK，推荐）' : s === 'anthropic' ? 'Anthropic（经 pi 适配器）' : PRESETS[s].label;
const API_LABEL: Record<PiApi, string> = {
  'anthropic-messages': 'Anthropic Messages',
  'openai-completions': 'OpenAI 兼容（Chat Completions）',
  'openai-responses': 'OpenAI Responses',
  'google-generative-ai': 'Google Generative AI',
};
/** 思考等级的选项：很高 / 最高只对 Claude 开放 */
const thinkingOptions = (claude: boolean): ThinkingLevel[] => (claude ? ['off', 'low', 'medium', 'high', 'xhigh', 'max'] : ['off', 'low', 'medium', 'high']);
const DIFF_ORDER: DifficultyId[] = ['easy', 'normal', 'hard', 'nightmare', 'abyss'];

/** 已连接的桥接器（跨页面保留：从对局回到设置页不需要重新配对） */
let bridge: { provider: LLMProvider; url: string; code: string; alive: boolean; close(): void } | null = null;

const NET_ERR_RE = /connection error|failed to fetch|networkerror|load failed|fetch failed|econnrefused|enotfound|timed? ?out|abort/i;

/**
 * testConnection 把「发出过请求」也算作连通；浏览器里连接被拒 / 被 CORS 拦截时同样会计一次请求。
 * 这里按结果再判一次：报了错、且一个 token 都没收到 ⇒ 没有真正连通（不应据此建议切换 JSON 模式）。
 */
export function normalizeDiag(d: ConnectionDiagnostics): ConnectionDiagnostics & { network: boolean } {
  const dead = !!d.error && d.tokens === 0 && !d.toolCalling;
  const network = dead && NET_ERR_RE.test(d.error ?? '');
  return dead ? { ...d, ok: false, reachable: false, advice: undefined, network } : { ...d, network: false };
}

const isPreset = (s: AiSource): s is Preset => s !== 'demo' && s !== 'claude';
const isLocal = (s: AiSource): boolean => isPreset(s) && PRESETS[s].local;

function codeBlock(app: App, step: SetupStep): HTMLElement {
  if (!step.code) return h('p.ai-step', null, step.text);
  const code = step.code;
  return h(
    'div.ai-step',
    null,
    h('p', null, step.text),
    h(
      'div.ai-code',
      null,
      h('pre', { attrs: { tabindex: 0 } }, code),
      h(
        'button.btn.small.ai-copy',
        {
          attrs: { type: 'button', 'aria-label': '复制命令' },
          onclick: async () => {
            audio.play('click');
            const ok = await copyText(code);
            app.toast(ok ? '已复制' : '复制失败，请手动选择文字', ok ? 'good' : 'warn');
          },
        },
        h('span.gi', { html: G.copy }),
        '复制',
      ),
    ),
  );
}

interface Seg {
  el: HTMLElement;
  paint(): void;
}

function segs<T extends string>(items: readonly (readonly [T, string, string?])[], get: () => T, set: (v: T) => void, label: string, cls = ''): Seg {
  const el = h(`div.seg-grid.ai-seg${cls}`, { attrs: { role: 'group', 'aria-label': label } });
  const paint = (): void => {
    clear(el);
    for (const [v, text, hint] of items) {
      const on = get() === v;
      el.appendChild(
        h(
          `button.seg${on ? '.on' : ''}`,
          {
            attrs: { type: 'button', 'aria-pressed': on ? 'true' : 'false' },
            title: hint,
            onclick: () => {
              if (get() === v) return;
              audio.play('click');
              set(v);
              paint();
            },
          },
          text,
        ),
      );
    }
  };
  paint();
  return { el, paint };
}

const field = (label: string, control: HTMLElement, hint?: string | HTMLElement): HTMLElement =>
  h('div.field.ai-field', null, h('span.ai-label', null, label), control, hint ? (typeof hint === 'string' ? h('small.muted', null, hint) : hint) : null);

export function mountAiSetup(app: App, body: HTMLElement): () => void {
  const p = app.store.get();
  const st: AiSetupSaved = loadSetup();
  const origin = typeof location !== 'undefined' ? location.origin : 'https://jjjj.games';
  const pageProtocol = typeof location !== 'undefined' ? location.protocol : 'https:';
  let os: OsId = detectOs();
  let disposed = false;
  const run = { seed: '', layoutSeed: randomSeed(), rerolled: false };
  const models = new Map<AiSource, string[]>();
  let diag: { source: AiSource; d: ReturnType<typeof normalizeDiag> } | null = null;
  let busy: 'test' | 'models' | 'bridge' | 'detect' | null = null;
  /** 中转服务：最近一次自动检测的结果 / 进度 */
  let relayResult: RelayDetection | null = null;
  let relayProgress = '';

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
  if (st.tab === 'direct' && !SOURCE_ORDER.includes(st.source)) st.source = 'demo';

  const persist = (): void => saveSetup(st);

  // ───────────── 角色 ─────────────
  const roleBox = h('div.ai-roles', { attrs: { role: 'radiogroup', 'aria-label': 'AI 的角色' } });
  const paintRoles = (): void => {
    clear(roleBox);
    const card = (role: AiRole, title: string, text: string, glyph: string) =>
      h(
        `button.ai-role${st.role === role ? '.on' : ''}`,
        {
          attrs: { type: 'button', role: 'radio', 'aria-checked': st.role === role ? 'true' : 'false' },
          onclick: () => {
            if (st.role === role) return;
            audio.play('click');
            st.role = role;
            // 军师不打断玩家：默认实时模式、决策间隔拉长
            if (role === 'advisor') {
              st.decisionMode = 'realtime';
              st.waveIntervalSec = Math.max(20, st.waveIntervalSec ?? 20);
            } else st.decisionMode = 'pause';
            persist();
            paintRoles();
            decisionSeg.paint();
            intervalInput.value = st.waveIntervalSec === null ? '' : String(st.waveIntervalSec);
            paintSummary();
          },
        },
        h('span.gi', { html: glyph }),
        h('span.ai-role-text', null, h('b', null, title), h('small', null, text)),
      );
    roleBox.append(
      card('player', 'AI 玩家', '模型自己建塔、升级、放技能，你来观战。成绩进 AI 榜，不进真人榜。', G.bolt),
      card('advisor', 'AI 军师', '你来玩，模型在旁边给建议，点“采纳”一键执行。', G.eye),
    );
  };

  // ───────────── 对局 ─────────────
  const modeBox = h('div.seg-grid.two');
  const mapBox = h('div.seg-grid.maps');
  const diffBox = h('div.seg-grid.ai-diffs');
  const abyssBox = h('div.ai-abyss');
  const seedInput = h<HTMLInputElement>('input.input', {
    attrs: { type: 'text', placeholder: '留空随机', maxlength: 24, autocomplete: 'off', spellcheck: 'false', 'aria-label': '随机种子' },
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
  const pureSw = switchRow('纯净模式', '不带永久天赋，AI 之间更好比较；成绩进入纯净 AI 榜', st.run.pure, (v) => {
    st.run.pure = v;
    persist();
  });
  const autoSw = switchRow('自动开波', '关闭后由 AI（或你）决定什么时候开下一波；排行榜按开波方式分开记录', st.run.autoWave, (v) => {
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
              if (!ok) return audio.play('error'), app.toast('先自己通关战役第一章，再让 AI 来打战役', 'warn');
              if (st.run.mode === m) return;
              audio.play('click');
              st.run.mode = m;
              persist();
              paintRun();
            },
          },
          ok ? null : h('span.gi', { html: G.lock }),
          m === 'endless' ? '无尽' : '战役',
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
              if (!ok) return audio.play('error'), app.toast('通关该章战役后可选', 'warn');
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
              if (!ok) return audio.play('error'), app.toast('这个难度你自己还没解锁', 'warn');
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
      const sel = h<HTMLSelectElement>('select.input', { attrs: { 'aria-label': '魔境等级' } });
      for (let i = 1; i <= Math.min(ABYSS_MAX, abyssMax); i++) sel.appendChild(h('option', { attrs: { value: i, selected: i === st.run.abyss } }, `魔境 ${roman(i)}`));
      sel.onchange = () => {
        st.run.abyss = Number(sel.value) || 1;
        persist();
      };
      abyssBox.appendChild(field('魔境等级', sel));
    }
    layout.el.hidden = st.run.mode !== 'endless';
    pureSw.el.hidden = st.run.mode !== 'endless';
    setText(
      runNote,
      st.run.mode === 'endless'
        ? 'AI 对局不发放墨水、不进本地和全服真人榜。无尽模式下“AI 玩家”的成绩可以提交到 AI 榜。'
        : '战役由 AI 代打不会获得星星，也不上排行榜。',
    );
    paintSummary();
  };

  // ───────────── 模型：直连 ─────────────
  const tabBox = h('div.lb-mode-tabs.ai-tabs', { attrs: { role: 'tablist', 'aria-label': '模型接入方式' } });
  const directBox = h('div.ai-direct');
  const bridgeBox = h('div.ai-bridge');
  const diagBox = h('div.ai-diag', { attrs: { role: 'status', 'aria-live': 'polite' } });
  const errBox = h('div.ai-errors', { attrs: { role: 'alert' } });

  const per = (s: AiSource = st.source) => (st.per[s] ??= {});
  const modelOf = (s: AiSource = st.source): string =>
    s === 'demo' ? 'scripted-v1' : (per(s).model ?? (s === 'claude' ? 'claude-sonnet-5-5' : PRESETS[s as Preset].defaultModel));
  const baseUrlOf = (s: AiSource = st.source): string => (isPreset(s) ? (per(s).baseUrl ?? PRESETS[s].baseUrl) : '');
  const apiOf = (s: AiSource = st.source): PiApi | undefined => (isPreset(s) ? (per(s).api ?? PRESETS[s].api) : undefined);

  // ── 中转服务 ──
  const relayMode = (): 'auto' | RelayApi => per('relay').relayApi ?? 'auto';
  /** 检测缓存的键：规范化地址 + 模型（换了就要重新检测） */
  const relayFor = (): string => {
    const u = parseRelayUrl(baseUrlOf('relay'));
    return u ? `${u.origin}${u.root}|${modelOf('relay').trim()}` : '';
  };
  const relayDetected = (): RelayApi | undefined => {
    const d = per('relay').detected;
    return d && d.for === relayFor() ? d.api : undefined;
  };
  /** 实际使用的接口：手动选择 > 检测结果 > Chat Completions（尚未检测时的占位） */
  const relayApiNow = (): RelayApi => {
    const m = relayMode();
    return m !== 'auto' ? m : (relayDetected() ?? 'openai-completions');
  };
  const relayNeedsDetect = (): boolean => st.tab === 'direct' && st.source === 'relay' && relayMode() === 'auto' && !relayDetected();

  /** 当前表单 → 模型配置（含内存里的 Key） */
  const buildConfig = (): Partial<AgentModelConfig> => {
    const common: Partial<AgentModelConfig> = {
      role: st.role,
      toolMode: st.toolMode,
      ...(st.contextMode !== 'auto' ? { contextMode: st.contextMode } : {}),
      ...(st.thinking !== 'auto' ? { thinking: st.thinking } : {}),
      decision: { mode: st.decisionMode, ...(st.waveIntervalSec !== null ? { waveIntervalSec: st.waveIntervalSec } : {}) },
      budget: { ...(st.budgetTokens ? { tokens: st.budgetTokens } : {}), ...(st.budgetUsd ? { usd: st.budgetUsd } : {}), mode: st.budgetMode },
    };
    if (st.tab === 'bridge') {
      return { ...common, provider: 'bridge', model: bridge?.provider.model ?? 'bridge', bridge: { url: bridge?.url ?? st.bridgeUrl, code: bridge?.code ?? '' } };
    }
    const s = st.source;
    if (s === 'demo') return { ...common, provider: 'scripted', model: 'scripted-v1' };
    const key = readKey(s).trim();
    if (s === 'claude') return { ...common, provider: 'claude-native', model: modelOf(s).trim(), browser: true, ...(key ? { apiKey: key } : {}) };
    if (s === 'relay') {
      // 中转服务一律走 pi（不走 Claude 官方 SDK 适配器）；地址按接口类型规范化
      const api = relayApiNow();
      const raw = baseUrlOf(s).trim();
      return { ...common, provider: 'pi', preset: 'relay', api, baseUrl: raw ? normalizeRelayBase(raw, api) : '', model: modelOf(s).trim(), browser: true, ...(key ? { apiKey: key } : {}) };
    }
    return {
      ...common,
      provider: 'pi',
      preset: s,
      api: apiOf(s),
      baseUrl: baseUrlOf(s).trim(),
      model: modelOf(s).trim(),
      browser: true,
      // 本机服务不需要 Key，但 OpenAI 兼容客户端要求非空
      apiKey: key || (PRESETS[s].local ? 'local' : undefined),
    };
  };

  /** 表单层面的校验（在 validateConfig 之外补上“需要 Key”等） */
  const formErrors = (): string[] => {
    const cfg = buildConfig();
    const errs = validateConfig(cfg);
    if (st.tab === 'bridge') {
      if (!bridge?.alive) return ['还没有连接桥接器：填好地址和配对码后点“连接”'];
      return errs.filter((e) => !e.includes('配对码'));
    }
    const s = st.source;
    if (s !== 'demo' && !isLocal(s) && s !== 'custom' && !readKey(s).trim()) errs.push('请填写 API Key');
    if (s === 'relay') {
      const raw = baseUrlOf(s).trim();
      const i = errs.indexOf('baseUrl 不是合法 URL');
      if (i >= 0) errs.splice(i, 1);
      if (raw && !parseRelayUrl(raw)) errs.push('服务地址不是合法的 http(s) 地址');
      if (!modelOf(s).trim()) {
        const j = errs.indexOf('缺少 model');
        if (j >= 0) errs.splice(j, 1);
        errs.push('请填写模型名（可以点“获取模型列表”选择）');
      }
    }
    return errs;
  };

  const paintErrors = (show = false): string[] => {
    const errs = formErrors();
    clear(errBox);
    if (show && errs.length) errBox.appendChild(h('ul', null, errs.map((e) => h('li', null, e))));
    return errs;
  };

  const sourceLabel = (): string => {
    if (st.tab === 'bridge') return bridge?.alive ? `桥接 · ${bridge.provider.model}` : '本机桥接（未连接）';
    const s = st.source;
    if (s === 'demo') return '内置策略（离线演示）';
    return `${s === 'claude' ? 'Claude' : PRESETS[s].label.replace(/（.*）/, '')} · ${modelOf(s) || '未选模型'}`;
  };

  const paintDiag = (): void => {
    clear(diagBox);
    if (busy === 'test') {
      diagBox.appendChild(h('div.ai-diag-card.pending', null, h('span.ai-spinner', { attrs: { 'aria-hidden': 'true' } }), '正在测试连接：发送一个很小的请求…'));
      return;
    }
    if (busy === 'detect') {
      diagBox.appendChild(h('div.ai-diag-card.pending', null, h('span.ai-spinner', { attrs: { 'aria-hidden': 'true' } }), `正在检测接口…${relayProgress}`));
      return;
    }
    const line = (ok: boolean, text: string) => h(`li.${ok ? 'ok' : 'bad'}`, null, h('span.gi', { html: ok ? G.check : G.close }), text);
    if (st.tab === 'direct' && st.source === 'relay' && relayResult) {
      diagBox.appendChild(relayCard(relayResult, line));
      return;
    }
    if (!diag || diag.source !== st.source || st.tab !== 'direct') return;
    const d = diag.d;
    const notes: string[] = [];
    if (st.source === 'relay') {
      if (!d.reachable || (d.error && !d.ok)) notes.push(relayFailureText(classifyRelayError(d.error, d.reachable, d.tokens)));
    } else if (!d.reachable) {
      if (isLocal(st.source) || st.source === 'custom') {
        if (d.network && !d.hint) notes.push('没有连上本机服务：确认它已经启动，并且允许本站跨域（见下面的配置方法）。');
        notes.push(...networkNotes(pageProtocol, baseUrlOf()));
      } else if (d.network) notes.push('这家服务商可能不允许浏览器直接访问（CORS）。可以改用“使用本地桥接”：由你电脑上的桥接器代为调用，没有跨域问题，Key 也不进网页。');
      else notes.push('服务有回应，但拒绝了请求：请检查 API Key 和模型名是否正确、账户是否有额度。');
    }
    diagBox.appendChild(
      h(
        `div.ai-diag-card.${d.ok ? 'good' : d.reachable ? 'warn' : 'bad'}`,
        null,
        h('b', null, d.ok ? '连接正常，可以开始' : d.reachable ? '连上了，但模型没有按要求调用工具' : d.network ? '连接失败：没有连上服务' : '连接失败：请求被拒绝'),
        h(
          'ul.ai-diag-list',
          null,
          line(d.reachable, d.reachable ? `已连通 · ${d.model}` : '没有连通'),
          line(d.toolCalling, d.toolCalling ? '会调用工具' : st.toolMode === 'json' ? '没有输出可解析的动作' : '没有调用工具'),
          h('li.info', null, `耗时 ${(d.latencyMs / 1000).toFixed(1)} 秒${d.tokens ? ` · ${fmtNum(d.tokens)} token` : ''}`),
        ),
        d.error ? h('p.ai-diag-err', null, `错误：${d.error}`) : null,
        d.advice ? h('p', null, d.advice) : null,
        d.hint ? h('p', null, d.hint) : null,
        notes.map((n) => h('p', null, n)),
        !d.reachable && isLocal(st.source)
          ? h(
              'button.btn.small',
              {
                attrs: { type: 'button' },
                onclick: () => {
                  audio.play('click');
                  const g = directBox.querySelector<HTMLDetailsElement>('details.ai-guide');
                  if (g) {
                    g.open = true;
                    g.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                  }
                },
              },
              '查看本机服务的配置方法',
            )
          : null,
      ),
    );
  };

  const SHORT_FAIL: Record<string, string> = {
    cors: '连不上（跨域 / 网络）',
    auth: 'Key 被拒绝',
    not_found: '接口不存在',
    model: '模型不可用',
    rate: '限流 / 额度不足',
    no_tools: '有回复，但没有调用工具',
    other: '失败',
  };
  function relayCard(r: RelayDetection, line: (ok: boolean, text: string) => HTMLElement): HTMLElement {
    const partial = !r.ok && r.api;
    const failed = r.attempts.filter((a) => !a.ok);
    const err = failed.find((a) => a.failure === r.failure)?.error ?? failed[0]?.error;
    const host = relayHost(baseUrlOf('relay'));
    return h(
      `div.ai-diag-card.${r.ok ? 'good' : partial ? 'warn' : 'bad'}`,
      null,
      h('b', null, r.ok && r.api ? `接口检测完成：${RELAY_API_LABEL[r.api]}` : partial ? '连上了，但模型没有按要求调用工具' : '接口检测失败'),
      h(
        'ul.ai-diag-list.ai-relay-attempts',
        null,
        r.attempts.map((a) =>
          line(a.ok, `${RELAY_API_LABEL[a.api]}${a.ok ? ` · ${(a.latencyMs / 1000).toFixed(1)} 秒` : ` · ${SHORT_FAIL[a.failure ?? 'other']}`}`),
        ),
      ),
      h('p', null, r.message),
      r.ok ? h('p.muted', null, `已记住：${host} + 这个模型以后直接用 ${RELAY_API_LABEL[r.api!]}（换地址或模型会重新检测）。`) : null,
      !r.ok && err ? h('p.ai-diag-err', null, `错误：${err}`) : null,
      r.failure === 'cors' ? h('p', null, '提示：中转站文档里一般会写是否支持网页 / 浏览器直接调用；不支持时可以改用“使用本地桥接”，由你电脑上的桥接器代为请求。') : null,
    );
  }

  const toolSeg = segs(
    [
      ['native', '原生工具调用', '模型自己发起工具调用（推荐）'],
      ['json', 'JSON 动作', '给不擅长工具调用的小模型：输出 JSON 动作列表'],
    ] as const,
    () => st.toolMode,
    (v) => ((st.toolMode = v), persist()),
    '工具模式',
    '.two',
  );
  // 上下文模式：自动 / 省流 / 均衡 / 完整（估算按离线 token 模型，思考等级 低）
  const ctxHint = h('small.muted');
  const autoCtx = (): ContextMode => (isLocal(st.source) ? 'saver' : 'balanced');
  const paintCtxHint = (): void => {
    const m = st.contextMode === 'auto' ? autoCtx() : st.contextMode;
    const sp = CONTEXT_MODES[m];
    setText(ctxHint, `${st.contextMode === 'auto' ? `自动 → ${CONTEXT_MODE_LABEL[m]}。` : ''}约 ${fmtNum(sp.estTokensPerWave)} 折算 token / 波（思考“低”时的离线估算）。${sp.desc}`);
  };
  const ctxSeg = segs(
    [
      ['auto', '自动', '本机模型用省流，其他用均衡'],
      ['saver', '省流', CONTEXT_MODES.saver.desc],
      ['balanced', '均衡', CONTEXT_MODES.balanced.desc],
      ['full', '完整', CONTEXT_MODES.full.desc],
    ] as const,
    () => st.contextMode,
    (v) => ((st.contextMode = v), persist(), paintCtxHint()),
    '上下文模式',
  );
  paintCtxHint();
  const decisionSeg = segs(
    [
      ['pause', '暂停等待', '到决策点时游戏暂停，模型想多久都行（推荐）'],
      ['realtime', '实时', '游戏不等人，指令到达时才生效'],
    ] as const,
    () => st.decisionMode,
    (v) => ((st.decisionMode = v), persist(), paintSummary()),
    '决策模式',
    '.two',
  );
  // 思考等级：自动 / 无思考 / 低 / 中 / 高（Claude 另有 很高 / 最高）；提示按服务商与模型给出
  const thinkingSel = h<HTMLSelectElement>('select.input', { attrs: { 'aria-label': '思考等级' } });
  const thinkingHint = h('small.muted');
  const autoThinking = (): ThinkingLevel => (st.source === 'relay' ? 'low' : isLocal(st.source) ? 'off' : st.source === 'demo' ? 'off' : 'medium');
  const thinkingNote = (lv: ThinkingLevel): string => {
    const s = st.source;
    if (s === 'demo') return '离线演示不调用模型，这项不起作用。';
    if (s === 'claude') {
      const plan = claudeThinkingPlan(modelOf('claude').trim() || 'claude-opus-5-5', lv);
      return plan.note ?? (lv === 'off' ? `关闭思考：${plan.effective}` : '自适应思考 + effort；越高越慢、越贵。');
    }
    if (s === 'relay') return lv === 'off' ? 'DeepSeek / Qwen 系列发送“关闭思考”；其他模型不发推理参数。' : '推理模型按等级发送 reasoning_effort（DeepSeek / Qwen 用各自的开关）；中转默认“低”。';
    if (isLocal(s)) return '本机小模型一般不支持推理参数，默认无思考。';
    return lv === 'off' ? '不发推理参数（模型支持时显式关闭）。' : '按服务商支持的方式发送推理强度。';
  };
  const paintThinking = (): void => {
    const claude = st.source === 'claude';
    const opts = thinkingOptions(claude);
    if (st.thinking !== 'auto' && !opts.includes(st.thinking)) st.thinking = 'high';
    clear(thinkingSel);
    const auto = autoThinking();
    thinkingSel.appendChild(h('option', { attrs: { value: 'auto', selected: st.thinking === 'auto' } }, `自动（${THINKING_LABEL[auto]}）`));
    for (const e of opts) thinkingSel.appendChild(h('option', { attrs: { value: e, selected: e === st.thinking } }, THINKING_LABEL[e]));
    setText(thinkingHint, thinkingNote(st.thinking === 'auto' ? auto : st.thinking));
  };
  thinkingSel.onchange = () => {
    st.thinking = thinkingSel.value as ThinkingLevel | 'auto';
    persist();
    paintThinking();
  };
  paintThinking();
  const budgetModeSeg = segs(
    [
      ['soft', '压缩后继续', '70% 起切换省流、90% 关思考；用完后以最省模式继续（默认）'],
      ['hard', '交给机器人', '用完后余下决策由内置机器人接管'],
      ['ask', '暂停并询问', '用完时暂停游戏，让你选：继续 / 追加 50 万 / 交给机器人'],
    ] as const,
    () => st.budgetMode,
    (v) => ((st.budgetMode = v), persist()),
    '超出预算时',
  );
  const numInput = (value: number | null, attrs: Record<string, string | number>, on: (v: number | null) => void): HTMLInputElement => {
    const el = h<HTMLInputElement>('input.input', { attrs: { type: 'number', inputmode: 'decimal', autocomplete: 'off', ...attrs } });
    if (value !== null) el.value = String(value);
    el.addEventListener('change', () => {
      const n = Number(el.value);
      on(el.value.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : n);
      persist();
    });
    return el;
  };
  const intervalInput = numInput(st.waveIntervalSec, { min: 3, max: 120, step: 1, placeholder: '按模式', 'aria-label': '波次中决策间隔（秒）' }, (v) => {
    st.waveIntervalSec = v === null ? null : Math.max(3, Math.min(120, Math.round(v)));
    intervalInput.value = st.waveIntervalSec === null ? '' : String(st.waveIntervalSec);
  });
  const tokenInput = numInput(st.budgetTokens, { min: 1000, step: 1000, placeholder: '不限', 'aria-label': 'token 预算' }, (v) => (st.budgetTokens = v ? Math.round(v) : null));
  const usdInput = numInput(st.budgetUsd, { min: 0.01, step: 0.01, placeholder: '不限', 'aria-label': '费用预算（美元）' }, (v) => (st.budgetUsd = v));

  const paintDirect = (): void => {
    clear(directBox);
    const s = st.source;
    const srcSel = h<HTMLSelectElement>('select.input', { attrs: { 'aria-label': '模型服务' } });
    for (const o of SOURCE_ORDER) srcSel.appendChild(h('option', { attrs: { value: o, selected: o === s } }, SOURCE_LABEL(o)));
    srcSel.onchange = () => {
      st.source = srcSel.value as AiSource;
      // 本机小模型：间隔拉长（文档 10 §10.6）
      if (isLocal(st.source) && st.waveIntervalSec !== null) st.waveIntervalSec = Math.max(20, st.waveIntervalSec);
      intervalInput.value = st.waveIntervalSec === null ? '' : String(st.waveIntervalSec);
      persist();
      paintThinking();
      paintCtxHint();
      paintDirect();
      paintDiag();
      paintSummary();
      paintErrors();
    };
    directBox.appendChild(field('模型服务', srcSel, isPreset(s) && s !== 'relay' && PRESETS[s].notes ? PRESETS[s].notes : undefined));

    if (s === 'demo') {
      directBox.appendChild(
        h(
          'div.ai-note',
          null,
          h('b', null, '离线演示'),
          h('p', null, '不联网、不花钱：由游戏内置的脚本策略代替大模型下指令，流程和界面与真正的模型完全一样。适合先看看 AI 参战是什么样子。'),
          h('p.muted.small', null, '成绩可以提交到 AI 榜，但会标注为“内置策略”。'),
        ),
      );
      return;
    }

    /** 中转服务：Key 的去向（随地址实时更新） */
    const keyDest = h('small.muted.ai-key-dest');
    const paintKeyDest = (): void => {
      const host = relayHost(baseUrlOf('relay'));
      setText(keyDest, host ? `Key 只会发送到 ${host}` : '填好服务地址后，Key 只会发送到那个地址');
    };
    const relayChanged = (): void => {
      relayResult = null;
      paintDiag();
      paintSummary();
      paintErrors();
    };

    if (s === 'relay') {
      const relayEndpointHint = (raw: string): string => {
        const ep = (api: RelayApi): string =>
          `${normalizeRelayBase(raw, api)}${api === 'anthropic-messages' ? '/v1/messages' : api === 'openai-responses' ? '/responses' : '/chat/completions'}`;
        if (relayMode() !== 'auto' || relayDetected()) return `将请求 ${ep(relayApiNow())}`;
        return `会自动规范化：OpenAI 接口用 ${normalizeRelayBase(raw, 'openai-completions')}，Anthropic 接口用 ${ep('anthropic-messages')}`;
      };
      directBox.appendChild(
        h(
          'div.ai-note',
          null,
          h('b', null, '中转服务'),
          h('p', null, '用中转站（API 代理商）给你的地址和 Key 直接玩：支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 三种接口，默认自动检测。'),
          h('p.muted.small', null, '请求由你的浏览器直接发给中转站，不经过我们的服务器；因此中转站必须允许网页跨域访问（CORS）。'),
        ),
      );
      const urlInput = h<HTMLInputElement>('input.input', {
        attrs: { type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://中转站地址（带不带 /v1 都可以）', 'aria-label': '服务地址' },
      });
      urlInput.value = baseUrlOf(s);
      const urlHint = h('small.muted');
      const paintUrlHint = (): void => {
        const raw = urlInput.value.trim();
        const u = raw ? parseRelayUrl(raw) : null;
        setText(urlHint, !raw ? '粘贴中转站文档里的地址即可，例如 https://example.com 或 https://example.com/v1，完整的 …/v1/chat/completions 也行' : u ? relayEndpointHint(raw) : '地址格式不对：应该像 https://example.com/v1');
      };
      paintUrlHint();
      urlInput.addEventListener('input', () => {
        per(s).baseUrl = urlInput.value.trim();
        paintUrlHint();
        paintKeyDest();
      });
      urlInput.addEventListener('change', () => {
        const v = urlInput.value.trim();
        if (v) per(s).baseUrl = v;
        else delete per(s).baseUrl;
        persist();
        relayChanged();
      });
      directBox.appendChild(field('服务地址', urlInput, urlHint));

      const apiSel = h<HTMLSelectElement>('select.input', { attrs: { 'aria-label': '接口类型' } });
      apiSel.appendChild(h('option', { attrs: { value: 'auto', selected: relayMode() === 'auto' } }, '自动检测（推荐）'));
      for (const a of ['openai-completions', 'openai-responses', 'anthropic-messages'] as RelayApi[]) {
        apiSel.appendChild(h('option', { attrs: { value: a, selected: relayMode() === a } }, RELAY_API_LABEL[a]));
      }
      const apiHint = h('small.muted');
      const paintApiHint = (): void => {
        const d = relayDetected();
        setText(
          apiHint,
          relayMode() !== 'auto'
            ? '手动指定：不再自动检测'
            : d
              ? `已检测：${RELAY_API_LABEL[d]}（点“测试连接”可重新检测）`
              : '点“测试连接”或开始对局时自动检测（依次发几个很小的请求）',
        );
      };
      paintApiHint();
      apiSel.onchange = () => {
        const v = apiSel.value as 'auto' | RelayApi;
        if (v === 'auto') delete per(s).relayApi;
        else per(s).relayApi = v;
        persist();
        paintApiHint();
        paintUrlHint();
        relayChanged();
      };
      directBox.appendChild(field('接口类型', apiSel, apiHint));
    } else if (isPreset(s)) {
      const apiSel = h<HTMLSelectElement>('select.input', { attrs: { 'aria-label': 'API 类型' } });
      for (const a of Object.keys(API_LABEL) as PiApi[]) apiSel.appendChild(h('option', { attrs: { value: a, selected: a === apiOf(s) } }, API_LABEL[a]));
      apiSel.disabled = s !== 'custom';
      apiSel.onchange = () => {
        per(s).api = apiSel.value as PiApi;
        persist();
      };
      directBox.appendChild(field('API 类型', apiSel, s === 'custom' ? undefined : '由服务商预设自动填写'));
      const urlInput = h<HTMLInputElement>('input.input', {
        attrs: { type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: PRESETS[s].baseUrl, 'aria-label': 'Base URL' },
      });
      urlInput.value = baseUrlOf(s);
      urlInput.addEventListener('change', () => {
        const v = urlInput.value.trim();
        if (v && v !== PRESETS[s].baseUrl) per(s).baseUrl = v;
        else delete per(s).baseUrl;
        persist();
        paintErrors();
      });
      directBox.appendChild(field('Base URL', urlInput));
    }

    // 模型 + 获取模型列表
    const listId = `ai-models-${s}`;
    const dl = h('datalist', { attrs: { id: listId } });
    const fillList = (): void => {
      clear(dl);
      for (const m of models.get(s) ?? (s === 'claude' ? [...CLAUDE_MODELS] : [])) dl.appendChild(h('option', { attrs: { value: m } }));
    };
    fillList();
    const modelInput = h<HTMLInputElement>('input.input', {
      attrs: { type: 'text', list: listId, autocomplete: 'off', spellcheck: 'false', placeholder: s === 'claude' ? 'claude-sonnet-5-5' : PRESETS[s].defaultModel || '模型名', 'aria-label': '模型' },
    });
    modelInput.value = modelOf(s);
    modelInput.addEventListener('change', () => {
      per(s).model = modelInput.value.trim();
      persist();
      if (s === 'relay') relayChanged();
      if (s === 'claude') paintThinking();
      paintSummary();
      paintErrors();
    });
    // 中转服务：可搜索、按家族分组的模型列表
    const picker = h('div.ai-model-picker');
    const pickModel = (m: string): void => {
      audio.play('click');
      modelInput.value = m;
      per(s).model = m;
      persist();
      relayChanged();
      paintPicker();
    };
    const pickerFilter = h<HTMLInputElement>('input.input', {
      attrs: { type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: '搜索模型，例如 claude、gpt-5、gemini', 'aria-label': '搜索模型' },
    });
    const pickerList = h('div.ai-model-groups');
    function paintPicker(): void {
      const all = models.get(s) ?? [];
      picker.hidden = s !== 'relay' || !all.length;
      if (picker.hidden) return;
      clear(pickerList);
      const groups = groupModels(all, pickerFilter.value);
      if (!groups.length) pickerList.appendChild(h('p.muted.small', null, '没有匹配的模型'));
      const cur = modelInput.value.trim();
      for (const g of groups) {
        pickerList.appendChild(
          h(
            'div.ai-model-group',
            null,
            h('b.ai-model-family', null, `${FAMILY_LABEL[g.family]}（${g.models.length}）`),
            h(
              'div.ai-model-chips',
              null,
              g.models.map((m) =>
                h(`button.ai-model-chip${m === cur ? '.on' : ''}`, { attrs: { type: 'button', 'aria-pressed': m === cur ? 'true' : 'false' }, onclick: () => pickModel(m) }, m),
              ),
            ),
          ),
        );
      }
    }
    pickerFilter.addEventListener('input', () => paintPicker());
    picker.append(pickerFilter, pickerList);
    paintPicker();
    const listMsg = h('small.muted.ai-list-msg', { attrs: { role: 'status' } });
    const listBtn = h<HTMLButtonElement>(
      'button.btn.small',
      {
        attrs: { type: 'button' },
        onclick: async () => {
          if (busy) return;
          audio.play('click');
          busy = 'models';
          listBtn.disabled = true;
          setText(listMsg, '正在获取…');
          const r = await listModels(buildConfig()).catch((e: unknown) => ({ ok: false, models: [] as string[], error: e instanceof Error ? e.message : String(e), hint: undefined }));
          busy = null;
          if (disposed) return;
          listBtn.disabled = false;
          if (r.ok && r.models.length) {
            models.set(s, r.models);
            fillList();
            paintPicker();
            setText(listMsg, s === 'relay' ? `找到 ${r.models.length} 个模型，在下面搜索并点选` : `找到 ${r.models.length} 个模型，点输入框选择`);
            if (s !== 'relay' && (!modelInput.value.trim() || !r.models.includes(modelInput.value.trim()))) {
              if (isLocal(s) || !modelInput.value.trim()) {
                modelInput.value = r.models[0];
                per(s).model = r.models[0];
                persist();
                paintSummary();
              }
            }
          } else {
            setText(listMsg, r.ok ? '服务端没有返回模型，请手动填写模型名' : `获取失败${r.error ? `（${r.error}）` : ''}${r.hint ? `。${r.hint}` : ''}`);
          }
        },
      },
      h('span.gi', { html: G.refresh }),
      '获取模型列表',
    );
    directBox.appendChild(field('模型', h('div.ai-inline', null, modelInput, listBtn, dl), listMsg));
    if (s === 'relay') directBox.appendChild(picker);

    // Key
    const local = isLocal(s);
    const keyInput = h<HTMLInputElement>('input.input', {
      attrs: {
        type: 'password',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: local ? '本机服务一般不需要；经隧道访问时填鉴权 token' : 'API Key',
        'aria-label': 'API Key',
        name: `ai-key-${s}`,
      },
    });
    keyInput.value = readKey(s);
    if (s === 'relay') paintKeyDest();
    st.keyMode = keyModeOf(s) ?? st.keyMode;
    const saveKey = (): void => {
      writeKey(s, keyInput.value.trim(), st.keyMode);
      paintErrors();
    };
    keyInput.addEventListener('change', saveKey);
    const keySeg = segs<KeyMode>(
      [
        ['memory', '仅本次会话', '只放在内存里，刷新页面就没了（默认，最安全）'],
        ['session', '本标签页内记住', '存入 sessionStorage：刷新不丢，关闭标签页即清除'],
        ['local', '记住在本机（不推荐）', '存入本机浏览器的 localStorage：下次打开还在，但任何能读到本站存储的脚本 / 扩展都能拿到'],
      ] as const,
      () => st.keyMode,
      (v) => {
        st.keyMode = v;
        persist();
        saveKey();
        localWarn.hidden = v !== 'local';
      },
      'Key 的保存方式',
      '.ai-key-modes',
    );
    const localWarn = h('p.ai-warn-strong', null, '已选择把 Key 明文保存在这台设备的浏览器里。请只在自己的电脑上这样做，并使用设了额度上限的专用 Key。');
    localWarn.hidden = st.keyMode !== 'local';
    const forgetBtn = h(
      'button.btn.small',
      {
        attrs: { type: 'button' },
        onclick: () => {
          audio.play('click');
          forgetKey(s);
          keyInput.value = '';
          app.toast('已清除这个服务的 Key', 'info');
          paintErrors();
        },
      },
      '清除 Key',
    );
    directBox.appendChild(
      h(
        'div.ai-key',
        null,
        field(local ? 'Key / Token（可选）' : 'API Key', h('div.ai-inline', null, keyInput, forgetBtn), s === 'relay' ? keyDest : undefined),
        keySeg.el,
        localWarn,
        h('p.ai-warn', null, h('span.gi', { html: G.warn }), h('span', null, BYO_KEY_WARNING)),
      ),
    );

    // 本机服务配置指引
    if (local || s === 'custom') {
      const guideBody = h('div.ai-guide-body');
      const paintGuide = (): void => {
        clear(guideBody);
        const osSeg = h('div.seg-grid.ai-os', { attrs: { role: 'group', 'aria-label': '操作系统' } });
        for (const o of ['mac', 'win', 'linux'] as OsId[]) {
          osSeg.appendChild(
            h(
              `button.seg${os === o ? '.on' : ''}`,
              { attrs: { type: 'button', 'aria-pressed': os === o ? 'true' : 'false' }, onclick: () => (audio.play('click'), (os = o), paintGuide()) },
              OS_NAME[o],
            ),
          );
        }
        guideBody.appendChild(osSeg);
        const guides = localGuides(origin, os);
        const ordered = [...guides.filter((g) => g.id === s), ...guides.filter((g) => g.id !== s)];
        for (const g of ordered) {
          const d = h<HTMLDetailsElement>('details.ai-guide-item', null, h('summary', null, g.name), ...g.steps.map((x) => codeBlock(app, x)));
          d.open = g.id === s;
          guideBody.appendChild(d);
        }
        for (const n of networkNotes(pageProtocol, baseUrlOf(s))) guideBody.appendChild(h('p.muted.small', null, n));
        guideBody.appendChild(h('p.muted.small', null, '手机 / 平板想用电脑上的模型：https 页面不能直接访问 http://192.168.x.x，请用带鉴权的 HTTPS 隧道，或改用“使用本地桥接”。'));
      };
      paintGuide();
      directBox.appendChild(
        h('details.ai-guide', null, h('summary', null, h('span.gi', { html: G.list }), `让浏览器连上本机模型（允许 ${origin} 跨域）`), guideBody),
      );
    }

    // 测试连接
    const testBtn = h<HTMLButtonElement>(
      'button.btn.ai-test',
      {
        attrs: { type: 'button' },
        onclick: async () => {
          if (busy) return;
          const errs = paintErrors(true);
          if (errs.length) return audio.play('error');
          audio.play('click');
          if (st.source === 'relay' && relayMode() === 'auto') {
            testBtn.disabled = true;
            const r = await runRelayDetect();
            if (disposed) return;
            testBtn.disabled = false;
            paintDirectHints();
            if (r) audio.play(r.ok ? 'select' : 'error');
            return;
          }
          relayResult = null;
          busy = 'test';
          testBtn.disabled = true;
          paintDiag();
          const src = st.source;
          let raw: ConnectionDiagnostics;
          try {
            raw = await testConnection({ ...buildConfig(), decisionTimeoutMs: 45_000, budget: {} });
          } catch (e) {
            const c = resolveConfig(buildConfig());
            raw = { ok: false, reachable: false, toolCalling: false, latencyMs: 0, model: c.model, provider: c.provider, tokens: 0, error: e instanceof Error ? e.message : String(e) };
          }
          const d = normalizeDiag(raw);
          busy = null;
          if (disposed) return;
          testBtn.disabled = false;
          diag = { source: src, d };
          // 连得上但不会调用工具：自动建议 JSON 动作模式（文档 10 §17.9）
          if (d.reachable && !d.toolCalling && st.toolMode === 'native') {
            st.toolMode = 'json';
            persist();
            toolSeg.paint();
            app.toast('模型没有调用工具，已切换到“JSON 动作”模式，可以再测一次', 'info');
          }
          paintDiag();
          audio.play(d.ok ? 'select' : 'error');
        },
      },
      h('span.gi', { html: G.bolt }),
      '测试连接',
    );
    directBox.appendChild(
      h('div.ai-test-row', null, testBtn, h('small.muted', null, s === 'relay' && relayMode() === 'auto' ? '自动检测接口：最多依次发 3 个很小的请求' : '会发送一个很小的请求（几十个 token）')),
    );
  };

  /** 检测结束后刷新“接口类型”下的说明（重画整个直连表单最简单，不会丢失输入：值都已保存） */
  const paintDirectHints = (): void => {
    if (st.tab === 'direct' && st.source === 'relay') paintDirect();
  };

  /** 中转服务：自动检测接口类型，结果缓存到（不含 Key 的）设置里 */
  const runRelayDetect = async (): Promise<RelayDetection | null> => {
    if (busy) return null;
    busy = 'detect';
    diag = null;
    relayResult = null;
    relayProgress = '';
    paintDiag();
    // 用玩家填写的原始地址（各接口在 detectRelayApi 里各自规范化）
    const cfg = { ...buildConfig(), baseUrl: baseUrlOf('relay').trim() };
    const forKey = relayFor();
    let r: RelayDetection;
    try {
      r = await detectRelayApi(cfg, {
        onProgress: (api, i, n) => {
          relayProgress = `（${i + 1}/${n}：${RELAY_API_LABEL[api]}）`;
          if (!disposed) paintDiag();
        },
      });
    } catch (e) {
      r = { ok: false, attempts: [], failure: 'other', message: e instanceof Error ? e.message : String(e) };
    }
    busy = null;
    relayProgress = '';
    if (disposed) return null;
    relayResult = r;
    if (r.api && forKey && relayFor() === forKey) {
      per('relay').detected = { api: r.api, for: forKey };
      persist();
    }
    // 能回复但不会调用工具：切到 JSON 动作模式（文档 10 §17.9）
    if (!r.ok && r.api && st.toolMode === 'native') {
      st.toolMode = 'json';
      persist();
      toolSeg.paint();
      app.toast('模型没有调用工具，已切换到“JSON 动作”模式', 'info');
    }
    paintDiag();
    paintSummary();
    return r;
  };

  // ───────────── 模型：本机桥接 ─────────────
  const paintBridge = (): void => {
    clear(bridgeBox);
    const urlInput = h<HTMLInputElement>('input.input', {
      attrs: { type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'ws://127.0.0.1:8787', 'aria-label': '桥接器地址' },
    });
    urlInput.value = st.bridgeUrl;
    urlInput.addEventListener('change', () => {
      st.bridgeUrl = urlInput.value.trim() || 'ws://127.0.0.1:8787';
      persist();
    });
    const codeInput = h<HTMLInputElement>('input.input.ai-code-input', {
      attrs: { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, placeholder: '6 位配对码', 'aria-label': '配对码' },
    });
    const msg = h('p.ai-bridge-msg', { attrs: { role: 'status', 'aria-live': 'polite' } });
    const paintState = (): void => {
      clear(msg);
      if (bridge?.alive) {
        msg.className = 'ai-bridge-msg good';
        msg.append(h('span.gi', { html: G.check }), `已连接 · ${bridge.provider.id.replace(/^bridge:/, '')} · ${bridge.provider.model}`);
      } else if (bridge && !bridge.alive) {
        msg.className = 'ai-bridge-msg warn';
        msg.append('连接已断开：桥接器会生成新的配对码，请重新连接。');
      } else {
        msg.className = 'ai-bridge-msg';
        msg.append('桥接器启动后会在终端里打印 6 位配对码。');
      }
      connectBtn.hidden = !!bridge?.alive;
      dropBtn.hidden = !bridge?.alive;
      paintSummary();
    };
    const connectBtn = h<HTMLButtonElement>(
      'button.btn.primary',
      {
        attrs: { type: 'button' },
        onclick: async () => {
          if (busy) return;
          const url = urlInput.value.trim() || 'ws://127.0.0.1:8787';
          const code = codeInput.value.trim();
          if (!/^wss?:\/\//.test(url)) return audio.play('error'), app.toast('地址必须以 ws:// 或 wss:// 开头', 'warn');
          if (!code) return audio.play('error'), app.toast('请填写配对码', 'warn');
          audio.play('click');
          busy = 'bridge';
          connectBtn.disabled = true;
          msg.className = 'ai-bridge-msg';
          msg.replaceChildren(h('span.ai-spinner', { attrs: { 'aria-hidden': 'true' } }), '正在连接…');
          try {
            bridge?.close();
            let sock: WebSocket | null = null;
            const provider = await connectBridge(url, code, (u) => {
              sock = new WebSocket(u);
              return sock as unknown as WsLike;
            });
            const conn = { provider: provider as LLMProvider, url, code, alive: true, close: () => provider.dispose() };
            (sock as WebSocket | null)?.addEventListener('close', () => {
              conn.alive = false;
              if (bridge === conn && !disposed && bridgeBox.isConnected) paintState();
            });
            bridge = conn;
            st.bridgeUrl = url;
            persist();
            audio.play('select');
          } catch (e) {
            bridge = null;
            audio.play('error');
            busy = null;
            connectBtn.disabled = false;
            if (disposed) return;
            paintState();
            msg.className = 'ai-bridge-msg bad';
            const notes = networkNotes(pageProtocol, url.replace(/^ws/, 'http'));
            msg.replaceChildren(`连接失败：${e instanceof Error ? e.message : String(e)}`, ...notes.map((n) => h('small.muted', null, n)));
            return;
          }
          busy = null;
          connectBtn.disabled = false;
          if (disposed) return;
          codeInput.value = '';
          paintState();
          paintErrors();
        },
      },
      '连接',
    );
    const dropBtn = h(
      'button.btn',
      {
        attrs: { type: 'button' },
        onclick: () => {
          audio.play('click');
          bridge?.close();
          bridge = null;
          paintState();
        },
      },
      '断开',
    );
    bridgeBox.append(
      h(
        'div.ai-note',
        null,
        h('b', null, '本机桥接器'),
        h('p', null, '在你自己的电脑上运行一个小程序，由它调用模型（本机 Ollama、或用本机环境变量里的 Key 调用云端模型）。没有跨域问题，Key 永远不进网页。'),
      ),
      ...bridgeCommands(origin).map((x) => codeBlock(app, x)),
      h('div.ai-bridge-form', null, field('桥接器地址', urlInput), field('配对码', codeInput), h('div.ai-bridge-actions', null, connectBtn, dropBtn)),
      msg,
      h('p.muted.small', null, '桥接器只监听本机（127.0.0.1），配对码一次有效。手机想连电脑上的桥接器：用带鉴权的 HTTPS 隧道暴露它，然后填 wss:// 地址。'),
    );
    paintState();
  };

  const paintTabs = (): void => {
    clear(tabBox);
    for (const [t, label] of [
      ['direct', '直连模型'],
      ['bridge', '使用本地桥接'],
    ] as const) {
      tabBox.appendChild(
        h(
          `button.seg${st.tab === t ? '.on' : ''}`,
          {
            attrs: { type: 'button', role: 'tab', 'aria-selected': st.tab === t ? 'true' : 'false' },
            onclick: () => {
              if (st.tab === t) return;
              audio.play('click');
              st.tab = t;
              persist();
              paintTabs();
            },
          },
          label,
        ),
      );
    }
    directBox.hidden = st.tab !== 'direct';
    bridgeBox.hidden = st.tab !== 'bridge';
    // 模型参数由桥接器自己的启动参数决定
    modelOpts.hidden = st.tab === 'bridge' || st.source === 'demo';
    if (st.tab === 'direct') paintDirect();
    else paintBridge();
    paintDiag();
    paintSummary();
    paintErrors();
  };

  // ───────────── 开始 ─────────────
  const summary = h('p.ai-summary.muted');
  function paintSummary(): void {
    const role = st.role === 'player' ? 'AI 玩家' : 'AI 军师';
    setText(summary, `${role} · ${sourceLabel()} · ${st.decisionMode === 'pause' ? '暂停等待' : '实时'}`);
    modelOpts.hidden = st.tab === 'bridge' || st.source === 'demo';
  }

  const startBtn = h(
    'button.btn.primary.big',
    {
      attrs: { type: 'button' },
      onclick: async () => {
        if (busy) return;
        const errs = paintErrors(true);
        if (errs.length) {
          audio.play('error');
          app.toast(errs[0], 'warn');
          errBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          return;
        }
        // 中转服务 + 自动检测：还没检测过这个地址 + 模型时，先检测再开局
        if (relayNeedsDetect()) {
          audio.play('click');
          diagBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          const r = await runRelayDetect();
          if (disposed || !r) return;
          paintDirectHints();
          if (!r.api) {
            audio.play('error');
            app.toast('没有检测到可用的接口，详见“模型”一栏的诊断', 'warn');
            diagBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            return;
          }
        }
        audio.play('select');
        const cfg = buildConfig();
        const resolved = resolveConfig(cfg);
        st.lastConfig = saveableConfig(resolved);
        persist();
        const typed = seedInput.value.trim();
        const endless = st.run.mode === 'endless';
        const userSeed = endless && (!!typed || run.rerolled);
        requestAiLaunch({
          config: cfg,
          role: st.role,
          mode: st.decisionMode,
          label: sourceLabel(),
          userSeed,
          ...(st.tab === 'bridge' && bridge
            ? // 不带 dispose：一局结束 / 重开时连接保留，由设置页的“断开”负责关闭
              { provider: { id: bridge.provider.id, model: bridge.provider.model, decide: (c) => bridge!.provider.decide(c) } satisfies LLMProvider }
            : {}),
        });
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
    '开始 AI 对局',
  );

  const modelOpts = h(
    'div.ai-grid',
    null,
    field('工具模式', toolSeg.el, '“测试连接”发现模型不会调用工具时会自动切到 JSON 动作'),
    field('上下文模式', ctxSeg.el, ctxHint),
    field('思考等级', thinkingSel, thinkingHint),
  );

  body.replaceChildren(
    h('section.card.section.ai-card', null, h('h3', null, '角色'), roleBox),
    h(
      'section.card.section.ai-card',
      null,
      h('h3', null, '对局'),
      field('模式', modeBox),
      field('地图', mapBox),
      layout.el,
      field('难度', diffBox),
      abyssBox,
      h('label.field', null, h('span', null, '随机种子'), seedInput),
      pureSw.el,
      autoSw.el,
      runNote,
    ),
    h('section.card.section.ai-card', null, h('h3', null, '模型'), tabBox, directBox, bridgeBox, diagBox, modelOpts),
    h(
      'section.card.section.ai-card',
      null,
      h('h3', null, '决策与预算'),
      h(
        'div.ai-grid',
        null,
        field('决策模式', decisionSeg.el, '暂停等待：结果只取决于模型的决定，和网速无关'),
        field('波次中决策间隔（秒）', intervalInput, '留空 = 按上下文模式（省流 30 / 均衡 15 / 完整 10）；本机小模型建议 20～30'),
        field('token 预算（整局，折算）', tokenInput, '折算 = 新输入 + 输出 + 缓存写×1.25 + 缓存读×0.1（缓存读很便宜，只算一成）'),
        field('超出预算时', budgetModeSeg.el, '默认：70% 切换省流、90% 关思考，用完后压缩上下文以最省模式继续'),
        field('费用预算（美元，估算）', usdInput, '按公开价格估算，以服务商账单为准'),
      ),
    ),
    summary,
    errBox,
    h('div.start-bar', null, startBtn),
  );

  paintRoles();
  paintRun();
  paintTabs();

  return () => {
    disposed = true;
    clearTimeout(seedTimer);
  };
}
