/**
 * AI 模型设置表单（动态分包，连同 src/agent 的纯逻辑）：「AI 参战」设置页与设置里的「AI 助手」共用。
 *
 * 来源（离线演示 / 直连各服务商 / 中转 / 本机桥接）→ 地址 / Key 存放方式 / 模型列表 / 测试连接 →
 * 动作模式 / 上下文模式 / 思考等级 → 决策方式与预算。
 * 只保存不含密钥的配置（store.saveSetup）；Key 的存放方式由玩家选择，默认只在内存，只发给所选的模型服务商。
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
  testConnection,
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
import type { App } from '../App';
import { audio } from '../audio';
import { fmtNumber, t, tOr } from '../../i18n';
import { clear, copyText, fmtNum, h, setText } from '../dom';
import { G } from '../icons';
import { bridgeProvider, getBridge, setBridge, type BridgeConn } from './bridge-state';
import type { AiRole } from './launch';
import {
  SOURCE_ORDER,
  apiOf,
  baseUrlOf,
  buildModelConfig,
  isLocal,
  isPreset,
  modelConfigErrors,
  modelOf,
  perOf,
  presetLabel,
  relayApiNow,
  relayDetected,
  relayFor,
  relayMode,
  relayNeedsDetect,
  sourceLabelOf,
} from './model-config';
import { bridgeCommands, detectOs, localGuides, networkNotes, OS_NAME, type OsId, type SetupStep } from './snippets';
import { forgetKey, keyModeOf, loadSetup, readKey, saveSetup, writeKey, type AiSetupSaved, type AiSource, type KeyMode } from './store';

/** 服务商预设的说明：src/agent 里是中文，这里按 id 取本地化文字（没有翻译时用原文） */
const presetNotes = (s: Preset): string | undefined => (PRESETS[s].notes ? tOr(`agent.setup.presetNote.${s}`, PRESETS[s].notes) : undefined);
const SOURCE_LABEL = (s: AiSource): string =>
  s === 'demo' ? t('agent.setup.source.demo') : s === 'claude' ? t('agent.setup.source.claude') : s === 'anthropic' ? t('agent.setup.source.anthropic') : presetLabel(s);
const API_LABEL = (a: PiApi): string =>
  a === 'openai-completions' ? t('agent.setup.api.openaiCompat') : a === 'anthropic-messages' ? 'Anthropic Messages' : a === 'openai-responses' ? 'OpenAI Responses' : 'Google Generative AI';
const API_IDS: PiApi[] = ['anthropic-messages', 'openai-completions', 'openai-responses', 'google-generative-ai'];
const thinkingLabel = (l: ThinkingLevel): string => tOr(`agent.setup.thinking.${l}`, THINKING_LABEL[l]);
const ctxLabel = (m: ContextMode): string => tOr(`agent.setup.ctx.${m}`, CONTEXT_MODE_LABEL[m]);
const ctxDesc = (m: ContextMode): string => tOr(`agent.setup.ctxDesc.${m}`, CONTEXT_MODES[m].desc);
const familyLabel = (f: keyof typeof FAMILY_LABEL): string => tOr(`agent.setup.family.${f}`, FAMILY_LABEL[f]);
/** 思考等级的选项：很高 / 最高只对 Claude 开放 */
const thinkingOptions = (claude: boolean): ThinkingLevel[] => (claude ? ['off', 'low', 'medium', 'high', 'xhigh', 'max'] : ['off', 'low', 'medium', 'high']);

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
          attrs: { type: 'button', 'aria-label': t('agent.setup.copyCmd') },
          onclick: async () => {
            audio.play('click');
            const ok = await copyText(code);
            app.toast(ok ? t('agent.setup.copied') : t('agent.setup.copyFailed'), ok ? 'good' : 'warn');
          },
        },
        h('span.gi', { html: G.copy }),
        t('agent.setup.copy'),
      ),
    ),
  );
}

export interface Seg {
  el: HTMLElement;
  paint(): void;
}

export function segs<T extends string>(items: readonly (readonly [T, string, string?])[], get: () => T, set: (v: T) => void, label: string, cls = ''): Seg {
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

export const field = (label: string, control: HTMLElement, hint?: string | HTMLElement): HTMLElement =>
  h('div.field.ai-field', null, h('span.ai-label', null, label), control, hint ? (typeof hint === 'string' ? h('small.muted', null, hint) : hint) : null);

export interface AiModelConfigFormOptions {
  /** 共用的设置对象（缺省读取保存的设置）；表单改动会写回并保存 */
  st?: AiSetupSaved;
  /** 配置里写的角色（AI 参战页：角色卡片的选择；AI 助手：军师 / 玩家在启用时才决定，这里只影响预览） */
  role: () => AiRole;
  /** true：决策方式按角色决定（军师总是实时）；false：用表单里的选择 */
  perRole?: boolean;
  /** 任何会影响摘要的改动（来源、模型、决策方式、桥接状态…） */
  onChange?: () => void;
}

/** 可复用的模型设置表单：两张卡片（模型 / 决策与预算）+ 错误列表 */
export interface AiModelConfigForm {
  /** 「模型」卡片 */
  readonly modelCard: HTMLElement;
  /** 「决策与预算」卡片 */
  readonly decisionCard: HTMLElement;
  /** 表单错误列表（role=alert） */
  readonly errBox: HTMLElement;
  /** 诊断卡片（测试连接 / 中转检测的结果） */
  readonly diagBox: HTMLElement;
  readonly st: AiSetupSaved;
  /** 当前表单 → 模型配置（含按存放方式读取的 Key） */
  buildConfig(): Partial<AgentModelConfig>;
  /** 界面上显示的模型名 */
  sourceLabel(): string;
  /** 校验；show = 把错误列出来 */
  errors(show?: boolean): string[];
  /** 开局 / 启用前的准备：中转服务自动检测接口类型（还没检测过时）。返回 false = 不能开始 */
  prepare(): Promise<boolean>;
  /** 已连接的本机桥接器（不带 dispose） */
  provider(): LLMProvider | undefined;
  /** 角色改变时调用：军师默认实时、间隔拉长；玩家默认暂停模式 */
  roleChanged(role: AiRole): void;
  busy(): boolean;
  persist(): void;
  destroy(): void;
}

export function mountAiModelConfigForm(app: App, o: AiModelConfigFormOptions): AiModelConfigForm {
  const st: AiSetupSaved = o.st ?? loadSetup();
  const origin = typeof location !== 'undefined' ? location.origin : 'https://jjjj.games';
  const pageProtocol = typeof location !== 'undefined' ? location.protocol : 'https:';
  let os: OsId = detectOs();
  let disposed = false;
  const models = new Map<AiSource, string[]>();
  let diag: { source: AiSource; d: ReturnType<typeof normalizeDiag> } | null = null;
  let busy: 'test' | 'models' | 'bridge' | 'detect' | null = null;
  /** 中转服务：最近一次自动检测的结果 / 进度 */
  let relayResult: RelayDetection | null = null;
  let relayProgress = '';
  /** 构造期间不回调（调用方此时还拿不到表单句柄） */
  let ready = false;
  const changed = (): void => {
    modelOpts.hidden = st.tab === 'bridge' || st.source === 'demo';
    if (ready) o.onChange?.();
  };
  if (st.tab === 'direct' && !SOURCE_ORDER.includes(st.source)) st.source = 'demo';

  const persist = (): void => saveSetup(st);

  // ───────────── 模型：直连 ─────────────
  const tabBox = h('div.lb-mode-tabs.ai-tabs', { attrs: { role: 'tablist', 'aria-label': t('agent.setup.tabsAria') } });
  const directBox = h('div.ai-direct');
  const bridgeBox = h('div.ai-bridge');
  const diagBox = h('div.ai-diag', { attrs: { role: 'status', 'aria-live': 'polite' } });
  const errBox = h('div.ai-errors', { attrs: { role: 'alert' } });

  const buildConfig = (): Partial<AgentModelConfig> => buildModelConfig(st, { role: o.role(), bridge: getBridge(), perRole: !!o.perRole });
  const formErrors = (): string[] => modelConfigErrors(st, buildConfig(), getBridge());

  const paintErrors = (show = false): string[] => {
    const errs = formErrors();
    clear(errBox);
    if (show && errs.length) errBox.appendChild(h('ul', null, errs.map((e) => h('li', null, e))));
    return errs;
  };

  const sourceLabel = (): string => sourceLabelOf(st, getBridge());

  const paintDiag = (): void => {
    clear(diagBox);
    if (busy === 'test') {
      diagBox.appendChild(h('div.ai-diag-card.pending', null, h('span.ai-spinner', { attrs: { 'aria-hidden': 'true' } }), t('agent.setup.diag.testing')));
      return;
    }
    if (busy === 'detect') {
      diagBox.appendChild(h('div.ai-diag-card.pending', null, h('span.ai-spinner', { attrs: { 'aria-hidden': 'true' } }), `${t('agent.setup.diag.detecting')}${relayProgress}`));
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
        if (d.network && !d.hint) notes.push(t('agent.setup.diag.localDown'));
        notes.push(...networkNotes(pageProtocol, baseUrlOf(st)));
      } else if (d.network) notes.push(t('agent.setup.diag.cors'));
      else notes.push(t('agent.setup.diag.rejected'));
    }
    diagBox.appendChild(
      h(
        `div.ai-diag-card.${d.ok ? 'good' : d.reachable ? 'warn' : 'bad'}`,
        null,
        h('b', null, d.ok ? t('agent.setup.diag.ok') : d.reachable ? t('agent.setup.diag.noTools') : d.network ? t('agent.setup.diag.netFail') : t('agent.setup.diag.refused')),
        h(
          'ul.ai-diag-list',
          null,
          line(d.reachable, d.reachable ? t('agent.setup.diag.reached', { model: d.model }) : t('agent.setup.diag.unreached')),
          line(d.toolCalling, d.toolCalling ? t('agent.setup.diag.tools') : st.toolMode === 'json' ? t('agent.setup.diag.noJson') : t('agent.setup.diag.noToolCall')),
          h('li.info', null, `${t('agent.setup.diag.latency', { s: fmtNumber(d.latencyMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}${d.tokens ? ` · ${t('agent.setup.diag.tokens', { n: fmtNum(d.tokens) })}` : ''}`),
        ),
        d.error ? h('p.ai-diag-err', null, t('agent.setup.diag.error', { msg: d.error })) : null,
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
              t('agent.setup.diag.showGuide'),
            )
          : null,
      ),
    );
  };

  const SHORT_FAIL = (f: string): string => tOr(`agent.setup.fail.${f}`, t('agent.setup.fail.other'));
  function relayCard(r: RelayDetection, line: (ok: boolean, text: string) => HTMLElement): HTMLElement {
    const partial = !r.ok && r.api;
    const failed = r.attempts.filter((a) => !a.ok);
    const err = failed.find((a) => a.failure === r.failure)?.error ?? failed[0]?.error;
    const host = relayHost(baseUrlOf(st, 'relay'));
    return h(
      `div.ai-diag-card.${r.ok ? 'good' : partial ? 'warn' : 'bad'}`,
      null,
      h('b', null, r.ok && r.api ? t('agent.setup.relay.done', { api: RELAY_API_LABEL[r.api] }) : partial ? t('agent.setup.diag.noTools') : t('agent.setup.relay.failed')),
      h(
        'ul.ai-diag-list.ai-relay-attempts',
        null,
        r.attempts.map((a) =>
          line(a.ok, `${RELAY_API_LABEL[a.api]} · ${a.ok ? t('agent.setup.relay.secs', { s: fmtNumber(a.latencyMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }) : SHORT_FAIL(a.failure ?? 'other')}`),
        ),
      ),
      h('p', null, r.message),
      r.ok ? h('p.muted', null, t('agent.setup.relay.remembered', { host, api: RELAY_API_LABEL[r.api!] })) : null,
      !r.ok && err ? h('p.ai-diag-err', null, t('agent.setup.diag.error', { msg: err })) : null,
      r.failure === 'cors' ? h('p', null, t('agent.setup.relay.corsTip')) : null,
    );
  }

  const toolSeg = segs(
    [
      ['native', t('agent.setup.tool.native'), t('agent.setup.tool.nativeHint')],
      ['json', t('agent.setup.tool.json'), t('agent.setup.tool.jsonHint')],
    ] as const,
    () => st.toolMode,
    (v) => ((st.toolMode = v), persist()),
    t('agent.setup.tool.label'),
    '.two',
  );
  // 上下文模式：自动 / 省流 / 均衡 / 完整（估算按离线 token 模型，思考等级 低）
  const ctxHint = h('small.muted');
  const autoCtx = (): ContextMode => (isLocal(st.source) ? 'saver' : 'balanced');
  const paintCtxHint = (): void => {
    const m = st.contextMode === 'auto' ? autoCtx() : st.contextMode;
    const sp = CONTEXT_MODES[m];
    setText(ctxHint, `${st.contextMode === 'auto' ? t('agent.setup.ctx.autoArrow', { mode: ctxLabel(m) }) : ''}${t('agent.setup.ctx.estimate', { n: fmtNum(sp.estTokensPerWave) })}${ctxDesc(m)}`);
  };
  const ctxSeg = segs(
    [
      ['auto', t('agent.setup.auto'), t('agent.setup.ctx.autoHint')],
      ['saver', ctxLabel('saver'), ctxDesc('saver')],
      ['balanced', ctxLabel('balanced'), ctxDesc('balanced')],
      ['full', ctxLabel('full'), ctxDesc('full')],
    ] as const,
    () => st.contextMode,
    (v) => ((st.contextMode = v), persist(), paintCtxHint()),
    t('agent.setup.ctx.label'),
  );
  paintCtxHint();
  const decisionSeg = segs(
    [
      ['pause', t('agent.setup.decision.pause'), t('agent.setup.decision.pauseHint')],
      ['realtime', t('agent.setup.decision.realtime'), t('agent.setup.decision.realtimeHint')],
    ] as const,
    () => st.decisionMode,
    (v) => ((st.decisionMode = v), persist(), changed()),
    t('agent.setup.decision.label'),
    '.two',
  );
  // 思考等级：自动 / 无思考 / 低 / 中 / 高（Claude 另有 很高 / 最高）；提示按服务商与模型给出
  const thinkingSel = h<HTMLSelectElement>('select.input', { attrs: { 'aria-label': t('agent.setup.thinking.label') } });
  const thinkingHint = h('small.muted');
  const autoThinking = (): ThinkingLevel => (st.source === 'relay' ? 'low' : isLocal(st.source) ? 'off' : st.source === 'demo' ? 'off' : 'medium');
  const thinkingNote = (lv: ThinkingLevel): string => {
    const s = st.source;
    if (s === 'demo') return t('agent.setup.thinking.demo');
    if (s === 'claude') {
      const plan = claudeThinkingPlan(modelOf(st, 'claude').trim() || 'claude-opus-5-5', lv);
      return plan.note ?? (lv === 'off' ? t('agent.setup.thinking.claudeOff', { v: plan.effective }) : t('agent.setup.thinking.claudeOn'));
    }
    if (s === 'relay') return lv === 'off' ? t('agent.setup.thinking.relayOff') : t('agent.setup.thinking.relayOn');
    if (isLocal(s)) return t('agent.setup.thinking.local');
    return lv === 'off' ? t('agent.setup.thinking.otherOff') : t('agent.setup.thinking.otherOn');
  };
  const paintThinking = (): void => {
    const claude = st.source === 'claude';
    const opts = thinkingOptions(claude);
    if (st.thinking !== 'auto' && !opts.includes(st.thinking)) st.thinking = 'high';
    clear(thinkingSel);
    const auto = autoThinking();
    thinkingSel.appendChild(h('option', { attrs: { value: 'auto', selected: st.thinking === 'auto' } }, t('agent.setup.thinking.auto', { v: thinkingLabel(auto) })));
    for (const e of opts) thinkingSel.appendChild(h('option', { attrs: { value: e, selected: e === st.thinking } }, thinkingLabel(e)));
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
      ['soft', t('agent.setup.budget.soft'), t('agent.setup.budget.softHint')],
      ['hard', t('agent.setup.budget.hard'), t('agent.setup.budget.hardHint')],
      ['ask', t('agent.setup.budget.ask'), t('agent.setup.budget.askHint')],
    ] as const,
    () => st.budgetMode,
    (v) => ((st.budgetMode = v), persist()),
    t('agent.setup.budget.over'),
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
  const intervalInput = numInput(st.waveIntervalSec, { min: 3, max: 120, step: 1, placeholder: t('agent.setup.interval.placeholder'), 'aria-label': t('agent.setup.interval.label') }, (v) => {
    st.waveIntervalSec = v === null ? null : Math.max(3, Math.min(120, Math.round(v)));
    intervalInput.value = st.waveIntervalSec === null ? '' : String(st.waveIntervalSec);
  });
  const tokenInput = numInput(st.budgetTokens, { min: 1000, step: 1000, placeholder: t('agent.setup.unlimited'), 'aria-label': t('agent.setup.budget.tokensAria') }, (v) => (st.budgetTokens = v ? Math.round(v) : null));
  const usdInput = numInput(st.budgetUsd, { min: 0.01, step: 0.01, placeholder: t('agent.setup.unlimited'), 'aria-label': t('agent.setup.budget.usdAria') }, (v) => (st.budgetUsd = v));

  const paintDirect = (): void => {
    clear(directBox);
    const s = st.source;
    const srcSel = h<HTMLSelectElement>('select.input', { attrs: { 'aria-label': t('agent.setup.service') } });
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
      changed();
      paintErrors();
    };
    directBox.appendChild(field(t('agent.setup.service'), srcSel, isPreset(s) && s !== 'relay' ? presetNotes(s) : undefined));

    if (s === 'demo') {
      directBox.appendChild(
        h(
          'div.ai-note',
          null,
          h('b', null, t('agent.setup.demo.title')),
          h('p', null, t('agent.setup.demo.desc')),
          h('p.muted.small', null, t('agent.setup.demo.board')),
        ),
      );
      return;
    }

    /** 中转服务：Key 的去向（随地址实时更新） */
    const keyDest = h('small.muted.ai-key-dest');
    const paintKeyDest = (): void => {
      const host = relayHost(baseUrlOf(st, 'relay'));
      setText(keyDest, host ? t('agent.setup.key.dest', { host }) : t('agent.setup.key.destNone'));
    };
    const relayChanged = (): void => {
      relayResult = null;
      paintDiag();
      changed();
      paintErrors();
    };

    if (s === 'relay') {
      const relayEndpointHint = (raw: string): string => {
        const ep = (api: RelayApi): string =>
          `${normalizeRelayBase(raw, api)}${api === 'anthropic-messages' ? '/v1/messages' : api === 'openai-responses' ? '/responses' : '/chat/completions'}`;
        if (relayMode(st) !== 'auto' || relayDetected(st)) return t('agent.setup.relay.willRequest', { url: ep(relayApiNow(st)) });
        return t('agent.setup.relay.normalize', { openai: normalizeRelayBase(raw, 'openai-completions'), anthropic: ep('anthropic-messages') });
      };
      directBox.appendChild(
        h(
          'div.ai-note',
          null,
          h('b', null, t('agent.setup.relay.title')),
          h('p', null, t('agent.setup.relay.desc')),
          h('p.muted.small', null, t('agent.setup.relay.cors')),
        ),
      );
      const urlInput = h<HTMLInputElement>('input.input', {
        attrs: { type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: t('agent.setup.relay.urlPlaceholder'), 'aria-label': t('agent.setup.relay.url') },
      });
      urlInput.value = baseUrlOf(st, s);
      const urlHint = h('small.muted');
      const paintUrlHint = (): void => {
        const raw = urlInput.value.trim();
        const u = raw ? parseRelayUrl(raw) : null;
        setText(urlHint, !raw ? t('agent.setup.relay.urlHint') : u ? relayEndpointHint(raw) : t('agent.setup.relay.urlBad'));
      };
      paintUrlHint();
      urlInput.addEventListener('input', () => {
        perOf(st, s).baseUrl = urlInput.value.trim();
        paintUrlHint();
        paintKeyDest();
      });
      urlInput.addEventListener('change', () => {
        const v = urlInput.value.trim();
        if (v) perOf(st, s).baseUrl = v;
        else delete perOf(st, s).baseUrl;
        persist();
        relayChanged();
      });
      directBox.appendChild(field(t('agent.setup.relay.url'), urlInput, urlHint));

      const apiSel = h<HTMLSelectElement>('select.input', { attrs: { 'aria-label': t('agent.setup.relay.api') } });
      apiSel.appendChild(h('option', { attrs: { value: 'auto', selected: relayMode(st) === 'auto' } }, t('agent.setup.relay.apiAuto')));
      for (const a of ['openai-completions', 'openai-responses', 'anthropic-messages'] as RelayApi[]) {
        apiSel.appendChild(h('option', { attrs: { value: a, selected: relayMode(st) === a } }, RELAY_API_LABEL[a]));
      }
      const apiHint = h('small.muted');
      const paintApiHint = (): void => {
        const d = relayDetected(st);
        setText(
          apiHint,
          relayMode(st) !== 'auto'
            ? t('agent.setup.relay.apiManual')
            : d
              ? t('agent.setup.relay.apiDetected', { api: RELAY_API_LABEL[d] })
              : t('agent.setup.relay.apiPending'),
        );
      };
      paintApiHint();
      apiSel.onchange = () => {
        const v = apiSel.value as 'auto' | RelayApi;
        if (v === 'auto') delete perOf(st, s).relayApi;
        else perOf(st, s).relayApi = v;
        persist();
        paintApiHint();
        paintUrlHint();
        relayChanged();
      };
      directBox.appendChild(field(t('agent.setup.relay.api'), apiSel, apiHint));
    } else if (isPreset(s)) {
      const apiSel = h<HTMLSelectElement>('select.input', { attrs: { 'aria-label': t('agent.setup.apiType') } });
      for (const a of API_IDS) apiSel.appendChild(h('option', { attrs: { value: a, selected: a === apiOf(st, s) } }, API_LABEL(a)));
      apiSel.disabled = s !== 'custom';
      apiSel.onchange = () => {
        perOf(st, s).api = apiSel.value as PiApi;
        persist();
      };
      directBox.appendChild(field(t('agent.setup.apiType'), apiSel, s === 'custom' ? undefined : t('agent.setup.apiTypeAuto')));
      const urlInput = h<HTMLInputElement>('input.input', {
        attrs: { type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: PRESETS[s].baseUrl, 'aria-label': 'Base URL' },
      });
      urlInput.value = baseUrlOf(st, s);
      urlInput.addEventListener('change', () => {
        const v = urlInput.value.trim();
        if (v && v !== PRESETS[s].baseUrl) perOf(st, s).baseUrl = v;
        else delete perOf(st, s).baseUrl;
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
      attrs: { type: 'text', list: listId, autocomplete: 'off', spellcheck: 'false', placeholder: s === 'claude' ? 'claude-sonnet-5-5' : PRESETS[s].defaultModel || t('agent.setup.modelName'), 'aria-label': t('agent.setup.model') },
    });
    modelInput.value = modelOf(st, s);
    modelInput.addEventListener('change', () => {
      perOf(st, s).model = modelInput.value.trim();
      persist();
      if (s === 'relay') relayChanged();
      if (s === 'claude') paintThinking();
      changed();
      paintErrors();
    });
    // 中转服务：可搜索、按家族分组的模型列表
    const picker = h('div.ai-model-picker');
    const pickModel = (m: string): void => {
      audio.play('click');
      modelInput.value = m;
      perOf(st, s).model = m;
      persist();
      relayChanged();
      paintPicker();
    };
    const pickerFilter = h<HTMLInputElement>('input.input', {
      attrs: { type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: t('agent.setup.modelSearchPlaceholder'), 'aria-label': t('agent.setup.modelSearch') },
    });
    const pickerList = h('div.ai-model-groups');
    function paintPicker(): void {
      const all = models.get(s) ?? [];
      picker.hidden = s !== 'relay' || !all.length;
      if (picker.hidden) return;
      clear(pickerList);
      const groups = groupModels(all, pickerFilter.value);
      if (!groups.length) pickerList.appendChild(h('p.muted.small', null, t('agent.setup.modelNoMatch')));
      const cur = modelInput.value.trim();
      for (const g of groups) {
        pickerList.appendChild(
          h(
            'div.ai-model-group',
            null,
            h('b.ai-model-family', null, t('agent.setup.family.count', { name: familyLabel(g.family), n: fmtNumber(g.models.length) })),
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
          setText(listMsg, t('agent.setup.models.loading'));
          const r = await listModels(buildConfig()).catch((e: unknown) => ({ ok: false, models: [] as string[], error: e instanceof Error ? e.message : String(e), hint: undefined }));
          busy = null;
          if (disposed) return;
          listBtn.disabled = false;
          if (r.ok && r.models.length) {
            models.set(s, r.models);
            fillList();
            paintPicker();
            setText(listMsg, s === 'relay' ? t('agent.setup.models.foundRelay', { n: r.models.length }) : t('agent.setup.models.found', { n: r.models.length }));
            if (s !== 'relay' && (!modelInput.value.trim() || !r.models.includes(modelInput.value.trim()))) {
              if (isLocal(s) || !modelInput.value.trim()) {
                modelInput.value = r.models[0];
                perOf(st, s).model = r.models[0];
                persist();
                changed();
              }
            }
          } else {
            setText(listMsg, r.ok ? t('agent.setup.models.empty') : `${r.error ? t('agent.setup.models.failedWith', { msg: r.error }) : t('agent.setup.models.failed')}${r.hint ? ` ${r.hint}` : ''}`);
          }
        },
      },
      h('span.gi', { html: G.refresh }),
      t('agent.setup.models.fetch'),
    );
    directBox.appendChild(field(t('agent.setup.model'), h('div.ai-inline', null, modelInput, listBtn, dl), listMsg));
    if (s === 'relay') directBox.appendChild(picker);

    // Key
    const local = isLocal(s);
    const keyInput = h<HTMLInputElement>('input.input', {
      attrs: {
        type: 'password',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: local ? t('agent.setup.key.localPlaceholder') : 'API Key',
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
        ['memory', t('agent.setup.key.memory'), t('agent.setup.key.memoryHint')],
        ['session', t('agent.setup.key.session'), t('agent.setup.key.sessionHint')],
        ['local', t('agent.setup.key.local'), t('agent.setup.key.localHint')],
      ] as const,
      () => st.keyMode,
      (v) => {
        st.keyMode = v;
        persist();
        saveKey();
        localWarn.hidden = v !== 'local';
      },
      t('agent.setup.key.modeLabel'),
      '.ai-key-modes',
    );
    const localWarn = h('p.ai-warn-strong', null, t('agent.setup.key.localWarn'));
    localWarn.hidden = st.keyMode !== 'local';
    const forgetBtn = h(
      'button.btn.small',
      {
        attrs: { type: 'button' },
        onclick: () => {
          audio.play('click');
          forgetKey(s);
          keyInput.value = '';
          app.toast(t('agent.setup.key.forgotten'), 'info');
          paintErrors();
        },
      },
      t('agent.setup.key.forget'),
    );
    directBox.appendChild(
      h(
        'div.ai-key',
        null,
        field(local ? t('agent.setup.key.optional') : 'API Key', h('div.ai-inline', null, keyInput, forgetBtn), s === 'relay' ? keyDest : undefined),
        keySeg.el,
        localWarn,
        h('p.ai-warn', null, h('span.gi', { html: G.warn }), h('span', null, tOr('agent.setup.key.byoWarning', BYO_KEY_WARNING))),
      ),
    );

    // 本机服务配置指引
    if (local || s === 'custom') {
      const guideBody = h('div.ai-guide-body');
      const paintGuide = (): void => {
        clear(guideBody);
        const osSeg = h('div.seg-grid.ai-os', { attrs: { role: 'group', 'aria-label': t('agent.setup.os') } });
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
        for (const n of networkNotes(pageProtocol, baseUrlOf(st, s))) guideBody.appendChild(h('p.muted.small', null, n));
        guideBody.appendChild(h('p.muted.small', null, t('agent.setup.guide.mobile')));
      };
      paintGuide();
      directBox.appendChild(
        h('details.ai-guide', null, h('summary', null, h('span.gi', { html: G.list }), t('agent.setup.guide.title', { origin })), guideBody),
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
          if (st.source === 'relay' && relayMode(st) === 'auto') {
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
            app.toast(t('agent.setup.toast.jsonRetry'), 'info');
          }
          paintDiag();
          audio.play(d.ok ? 'select' : 'error');
        },
      },
      h('span.gi', { html: G.bolt }),
      t('agent.setup.test'),
    );
    directBox.appendChild(
      h('div.ai-test-row', null, testBtn, h('small.muted', null, s === 'relay' && relayMode(st) === 'auto' ? t('agent.setup.testHintRelay') : t('agent.setup.testHint'))),
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
    const cfg = { ...buildConfig(), baseUrl: baseUrlOf(st, 'relay').trim() };
    const forKey = relayFor(st);
    let r: RelayDetection;
    try {
      r = await detectRelayApi(cfg, {
        onProgress: (api, i, n) => {
          relayProgress = t('agent.setup.relay.progress', { i: i + 1, n, api: RELAY_API_LABEL[api] });
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
    if (r.api && forKey && relayFor(st) === forKey) {
      perOf(st, 'relay').detected = { api: r.api, for: forKey };
      persist();
    }
    // 能回复但不会调用工具：切到 JSON 动作模式（文档 10 §17.9）
    if (!r.ok && r.api && st.toolMode === 'native') {
      st.toolMode = 'json';
      persist();
      toolSeg.paint();
      app.toast(t('agent.setup.toast.json'), 'info');
    }
    paintDiag();
    changed();
    return r;
  };

  // ───────────── 模型：本机桥接 ─────────────
  const paintBridge = (): void => {
    clear(bridgeBox);
    const urlInput = h<HTMLInputElement>('input.input', {
      attrs: { type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'ws://127.0.0.1:8787', 'aria-label': t('agent.setup.bridge.url') },
    });
    urlInput.value = st.bridgeUrl;
    urlInput.addEventListener('change', () => {
      st.bridgeUrl = urlInput.value.trim() || 'ws://127.0.0.1:8787';
      persist();
    });
    const codeInput = h<HTMLInputElement>('input.input.ai-code-input', {
      attrs: { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, placeholder: t('agent.setup.bridge.codePlaceholder'), 'aria-label': t('agent.setup.bridge.code') },
    });
    const msg = h('p.ai-bridge-msg', { attrs: { role: 'status', 'aria-live': 'polite' } });
    const paintState = (): void => {
      clear(msg);
      const bridge = getBridge();
      if (bridge?.alive) {
        msg.className = 'ai-bridge-msg good';
        msg.append(h('span.gi', { html: G.check }), t('agent.setup.bridge.connected', { id: bridge.provider.id.replace(/^bridge:/, ''), model: bridge.provider.model }));
      } else if (bridge && !bridge.alive) {
        msg.className = 'ai-bridge-msg warn';
        msg.append(t('agent.setup.bridge.lost'));
      } else {
        msg.className = 'ai-bridge-msg';
        msg.append(t('agent.setup.bridge.idle'));
      }
      connectBtn.hidden = !!bridge?.alive;
      dropBtn.hidden = !bridge?.alive;
      changed();
    };
    const connectBtn = h<HTMLButtonElement>(
      'button.btn.primary',
      {
        attrs: { type: 'button' },
        onclick: async () => {
          if (busy) return;
          const url = urlInput.value.trim() || 'ws://127.0.0.1:8787';
          const code = codeInput.value.trim();
          if (!/^wss?:\/\//.test(url)) return audio.play('error'), app.toast(t('agent.setup.bridge.badUrl'), 'warn');
          if (!code) return audio.play('error'), app.toast(t('agent.setup.bridge.needCode'), 'warn');
          audio.play('click');
          busy = 'bridge';
          connectBtn.disabled = true;
          msg.className = 'ai-bridge-msg';
          msg.replaceChildren(h('span.ai-spinner', { attrs: { 'aria-hidden': 'true' } }), t('agent.setup.bridge.connecting'));
          try {
            getBridge()?.close();
            let sock: WebSocket | null = null;
            const provider = await connectBridge(url, code, (u) => {
              sock = new WebSocket(u);
              return sock as unknown as WsLike;
            });
            const conn: BridgeConn = { provider: provider as LLMProvider, url, code, alive: true, close: () => provider.dispose() };
            (sock as WebSocket | null)?.addEventListener('close', () => {
              conn.alive = false;
              if (getBridge() === conn && !disposed && bridgeBox.isConnected) paintState();
            });
            setBridge(conn);
            st.bridgeUrl = url;
            persist();
            audio.play('select');
          } catch (e) {
            setBridge(null);
            audio.play('error');
            busy = null;
            connectBtn.disabled = false;
            if (disposed) return;
            paintState();
            msg.className = 'ai-bridge-msg bad';
            const notes = networkNotes(pageProtocol, url.replace(/^ws/, 'http'));
            msg.replaceChildren(t('agent.setup.bridge.failed', { msg: e instanceof Error ? e.message : String(e) }), ...notes.map((n) => h('small.muted', null, n)));
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
      t('agent.setup.bridge.connect'),
    );
    const dropBtn = h(
      'button.btn',
      {
        attrs: { type: 'button' },
        onclick: () => {
          audio.play('click');
          getBridge()?.close();
          setBridge(null);
          paintState();
        },
      },
      t('agent.setup.bridge.disconnect'),
    );
    bridgeBox.append(
      h(
        'div.ai-note',
        null,
        h('b', null, t('agent.setup.bridge.title')),
        h('p', null, t('agent.setup.bridge.desc')),
      ),
      ...bridgeCommands(origin).map((x) => codeBlock(app, x)),
      h('div.ai-bridge-form', null, field(t('agent.setup.bridge.url'), urlInput), field(t('agent.setup.bridge.code'), codeInput), h('div.ai-bridge-actions', null, connectBtn, dropBtn)),
      msg,
      h('p.muted.small', null, t('agent.setup.bridge.note')),
    );
    paintState();
  };

  const paintTabs = (): void => {
    clear(tabBox);
    for (const [tab, label] of [
      ['direct', t('agent.setup.tab.direct')],
      ['bridge', t('agent.setup.tab.bridge')],
    ] as const) {
      tabBox.appendChild(
        h(
          `button.seg${st.tab === tab ? '.on' : ''}`,
          {
            attrs: { type: 'button', role: 'tab', 'aria-selected': st.tab === tab ? 'true' : 'false' },
            onclick: () => {
              if (st.tab === tab) return;
              audio.play('click');
              st.tab = tab;
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
    changed();
    paintErrors();
  };
  const modelOpts = h(
    'div.ai-grid',
    null,
    field(t('agent.setup.tool.label'), toolSeg.el, t('agent.setup.tool.fieldHint')),
    field(t('agent.setup.ctx.label'), ctxSeg.el, ctxHint),
    field(t('agent.setup.thinking.label'), thinkingSel, thinkingHint),
  );

  const modelCard = h('section.card.section.ai-card', null, h('h3', null, t('agent.setup.model')), tabBox, directBox, bridgeBox, diagBox, modelOpts);
  const decisionCard = h(
    'section.card.section.ai-card',
    null,
    h('h3', null, t('agent.setup.sec.decision')),
    h(
      'div.ai-grid',
      null,
      field(t('agent.setup.decision.label'), decisionSeg.el, o.perRole ? t('ui.assist.decisionHint') : t('agent.setup.decision.fieldHint')),
      field(t('agent.setup.interval.label'), intervalInput, t('agent.setup.interval.hint')),
      field(t('agent.setup.budget.tokens'), tokenInput, t('agent.setup.budget.tokensHint')),
      field(t('agent.setup.budget.over'), budgetModeSeg.el, t('agent.setup.budget.overHint')),
      field(t('agent.setup.budget.usd'), usdInput, t('agent.setup.budget.usdHint')),
    ),
  );
  paintTabs();
  ready = true;

  return {
    modelCard,
    decisionCard,
    errBox,
    diagBox,
    st,
    buildConfig,
    sourceLabel,
    errors: (show = false) => paintErrors(show),
    async prepare() {
      // 中转服务 + 自动检测：还没检测过这个地址 + 模型时，先检测
      if (!relayNeedsDetect(st)) return true;
      diagBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const r = await runRelayDetect();
      if (disposed || !r) return false;
      paintDirectHints();
      if (!r.api) {
        audio.play('error');
        app.toast(t('agent.setup.toast.noApi'), 'warn');
        diagBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return false;
      }
      return true;
    },
    provider: () => (st.tab === 'bridge' ? bridgeProvider() : undefined),
    roleChanged(role) {
      // 军师不打断玩家：默认实时模式、决策间隔拉长
      if (role === 'advisor') {
        st.decisionMode = 'realtime';
        st.waveIntervalSec = Math.max(20, st.waveIntervalSec ?? 20);
      } else st.decisionMode = 'pause';
      persist();
      decisionSeg.paint();
      intervalInput.value = st.waveIntervalSec === null ? '' : String(st.waveIntervalSec);
      changed();
    },
    busy: () => busy !== null,
    persist,
    destroy() {
      disposed = true;
    },
  };
}
