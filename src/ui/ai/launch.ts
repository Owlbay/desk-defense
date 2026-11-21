/**
 * AI 助手的对局入口（很小，随首屏包加载）：任何模式的对局都可以中途挂上 / 摘下 AI 面板。
 *
 * - 对局页（GameScreen）创建时 createAiSlot(...)：一个「AI 插槽」，管理当前挂着的 AI 面板与本局的公平性标记。
 *   对局里的 AI 按钮调用 slot.attach(launch) / slot.detach()；面板与 Agent 代码按需 import()（动态分包）。
 * - 「AI 参战」页面点开始时调用 requestAiLaunch(...)，然后照常 app.go({ name: 'game', opts })；
 *   对局页用 takeAiLaunch() 取出这个请求并以「AI 参战」方式挂上（同一套机制：从第 1 波开始、结算出 AI 报告）。
 * 没有启用 AI 的对局零开销：Agent / 模型 SDK 只会出现在动态分包里。
 */
import { t } from '../../i18n';
import { ui } from '../../game/UiStore';
import { emptyAssist, markAssist, type AiAssist } from '../../meta/aiAssist';
import type { AgentModelConfig } from '../../agent/config';
import type { LLMProvider } from '../../agent/providers/types';
import type { RunOptions } from '../../core/types';
import type { Session } from '../../game/Session';
import type { App } from '../App';
import { h } from '../dom';

export type AiRole = 'player' | 'advisor';

export interface AiLaunch {
  /** 完整模型配置（apiKey 只在内存里，随本对象传递，不落盘） */
  config: Partial<AgentModelConfig>;
  role: AiRole;
  mode: 'pause' | 'realtime';
  /** 已连好的适配器（本机桥接器）；缺省由控制器按 config 动态加载 */
  provider?: LLMProvider;
  /** 界面上显示的模型名，例如「Claude · claude-sonnet-5-5」 */
  label: string;
  /** 玩家是否自己指定了种子（再来一局时保留） */
  userSeed?: boolean;
  /** 对局中启用的 AI：面板里的「停止 / 接管」改为整个停用（交还控制并移除面板）；AI 参战局不设 */
  onStop?: () => void;
}

let pending: AiLaunch | null = null;
/** 上一局 AI 对局刚销毁时留下的启动参数：同一次 app.go 里紧接着又开一局（暂停菜单 / 结算的「再来一局」）时沿用 */
let rearm: { launch: AiLaunch; at: number } | null = null;

export function requestAiLaunch(l: AiLaunch): void {
  pending = l;
}

/** 测试 / 离开 AI 流程时清掉 */
export function clearAiLaunch(): void {
  pending = null;
  rearm = null;
}

export interface AiGameOverInfo {
  won: boolean;
  wave: number;
  wavesSurvived: number;
  score: number;
}

export interface AiGameOverHandlers {
  again(): void;
  menu(): void;
}

export interface AiAttachCtx {
  app: App;
  session: Session;
  opts: RunOptions;
  /** div.game */
  game: HTMLElement;
  /** div.g-modals */
  modals: HTMLElement;
}

/** GameScreen 用到的钩子 */
export interface AiGameHooks {
  readonly role: AiRole;
  /** AI 玩家的对局不结算奖励、不进本地排行榜（军师模式是真人在玩，照常结算） */
  readonly noSettle: boolean;
  /** 结算卡片（替换普通结算界面） */
  gameOver(d: AiGameOverInfo, hd: AiGameOverHandlers): HTMLElement;
  destroy(): void;
}

/** hud.ts 导出的句柄 */
export interface AiHudHandle {
  /** AI 参战局：结算报告卡片 */
  gameOverCard(d: AiGameOverInfo, hd: AiGameOverHandlers): HTMLElement;
  /** 普通对局结束：停掉控制器（不出报告，结算照常） */
  finish(): void;
  /** AI 参战局：交还控制（同面板里的「接管」；面板留着，结算仍出报告） */
  takeOver(): void;
  destroy(): void;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** 取出「AI 参战」页面留下的启动请求（没有则 null）；「再来一局」时沿用上一局的参数 */
export function takeAiLaunch(): AiLaunch | null {
  const launch = pending ?? (rearm && now() - rearm.at < 250 ? rearm.launch : null);
  pending = null;
  rearm = null;
  return launch;
}

/** 一局里的 AI 插槽：同一时间最多挂一个 AI 面板（玩家或军师） */
export interface AiSlot {
  /** 本局的公平性标记（启用即标记，摘下后保留） */
  readonly assist: AiAssist;
  /** 「AI 参战」局（从第 1 波起由 AI 全程操作，结算出 AI 报告、可进 AI 榜） */
  readonly dedicated: boolean;
  /** 当前挂着的角色；没有 AI 时 null */
  readonly role: AiRole | null;
  /** 当前模型名 */
  readonly label: string;
  /** 面板还在加载 */
  readonly loading: boolean;
  /** AI 参战的 AI 玩家局：不结算奖励、不进本地排行榜 */
  readonly noSettle: boolean;
  /** 挂上 AI（已有的先摘下）；从当前局面开始，记忆为空、第一次决策拿完整观察 */
  attach(launch: AiLaunch, o?: { dedicated?: boolean }): void;
  /** 停用：摘下面板、交还全部操作（AI 参战局改为「接管」） */
  detach(): void;
  /** 对局结束：AI 参战局返回报告卡片；其他对局停掉 AI 并返回 null（照常结算） */
  gameOver(d: AiGameOverInfo, hd: AiGameOverHandlers): HTMLElement | null;
  /** 状态变化（挂上 / 摘下 / 加载完成） */
  subscribe(fn: () => void): () => void;
  destroy(): void;
}

export function createAiSlot(ctx: AiAttachCtx, init: { assist?: AiAssist } = {}): AiSlot {
  const assist: AiAssist = init.assist ? { ...init.assist } : emptyAssist();
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const fn of listeners) {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    }
  };
  let cur: {
    launch: AiLaunch;
    dedicated: boolean;
    hud: AiHudHandle | null;
    loading: Promise<AiHudHandle | null> | null;
    gen: number;
  } | null = null;
  let gen = 0;
  let dedicatedRole: AiRole | null = null;
  let destroyed = false;
  const pauseMenuOpen = (): boolean => !!ctx.game.querySelector('.pause-overlay');

  const unmount = (): void => {
    const c = cur;
    cur = null;
    if (!c) return;
    try {
      c.hud?.destroy();
    } catch (e) {
      console.error(e);
    }
    ctx.game.classList.remove('ai-run', 'ai-player', 'ai-advisor', 'ai-driving');
    // 交还全部操作（面板没加载完就停用时也要复位）
    ui.set({ inspectOnly: false, aiFocus: null, aiFocusCells: null });
    // 暂停模式下 AI 思考时游戏是停着的：交还时恢复（玩家自己打开的暂停菜单不动）
    if (!destroyed && ctx.session.paused && !pauseMenuOpen()) ctx.session.togglePause(false);
  };

  const slot: AiSlot = {
    assist,
    get dedicated() {
      return dedicatedRole !== null;
    },
    get role() {
      return cur?.launch.role ?? null;
    },
    get label() {
      return cur?.launch.label ?? '';
    },
    get loading() {
      return !!cur && !cur.hud;
    },
    get noSettle() {
      return dedicatedRole === 'player';
    },
    attach(launch, o = {}) {
      if (destroyed) return;
      unmount();
      const dedicated = !!o.dedicated;
      if (dedicated) dedicatedRole = launch.role;
      markAssist(assist, launch.role, launch.label);
      const g = ++gen;
      const l: AiLaunch = dedicated ? launch : { ...launch, onStop: () => slot.detach() };
      const c: NonNullable<typeof cur> = { launch: l, dedicated, hud: null, loading: null, gen: g };
      cur = c;
      ctx.game.classList.add('ai-run', `ai-${launch.role}`);
      c.loading = import('./hud')
        .then((m) => {
          if (destroyed || cur !== c) return null;
          c.hud = m.mountAiHud(ctx, l);
          emit();
          return c.hud;
        })
        .catch((e: unknown) => {
          console.error('[ai] panel load failed', e);
          ctx.app.toast(t('agent.setup.loadFailedToast'), 'warn');
          if (cur === c && !dedicated) {
            unmount();
            emit();
          }
          return null;
        });
      emit();
    },
    detach() {
      if (!cur) return;
      if (cur.dedicated) {
        cur.hud?.takeOver();
        return;
      }
      unmount();
      emit();
    },
    gameOver(d, hd) {
      const c = cur;
      if (!c) return null;
      if (!c.dedicated) {
        c.hud?.finish();
        // 面板还没加载完：直接摘下
        if (!c.hud) unmount();
        return null;
      }
      if (c.hud) return c.hud.gameOverCard(d, hd);
      // 极少见：面板还没加载完对局就结束了
      const host = h('div.overlay.ai-report-overlay');
      void c.loading?.then((hud) => {
        if (hud && host.isConnected) host.replaceWith(hud.gameOverCard(d, hd));
        else if (host.isConnected) {
          host.appendChild(
            h(
              'div.dialog.card',
              null,
              h('h2', null, d.won ? t('agent.setup.over.won') : t('agent.setup.over.lost')),
              h('p.muted', null, t('agent.setup.over.survived', { n: d.wavesSurvived })),
              h('button.btn.primary.big', { onclick: hd.menu }, t('agent.setup.over.menu')),
            ),
          );
        }
      });
      return host;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      if (destroyed) return;
      // AI 参战局：同一次 app.go 里紧接着又开一局（暂停菜单 / 结算的「再来一局」）时沿用启动参数
      if (cur?.dedicated) rearm = { launch: cur.launch, at: now() };
      destroyed = true;
      unmount();
      listeners.clear();
    },
  };
  return slot;
}

/**
 * 兼容入口：有「AI 参战」启动请求时以 AI 参战方式挂上并返回钩子，否则返回 null（普通对局零开销）。
 * GameScreen 现在直接用 createAiSlot + takeAiLaunch；这里留给测试与外部调用。
 */
export function attachAi(ctx: AiAttachCtx): AiGameHooks | null {
  const launch = takeAiLaunch();
  if (!launch) return null;
  const slot = createAiSlot(ctx);
  slot.attach(launch, { dedicated: true });
  return {
    role: launch.role,
    noSettle: slot.noSettle,
    gameOver: (d, hd) => slot.gameOver(d, hd) ?? h('div'),
    destroy: () => slot.destroy(),
  };
}
