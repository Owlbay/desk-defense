/**
 * AI 参战：对局入口（很小，随首屏包加载）。
 *
 * 「AI 参战」页面点开始时调用 requestAiLaunch(...)，然后照常 app.go({ name: 'game', opts })；
 * 对局页（GameScreen）创建时调用 attachAi(...)：有待处理的启动请求就按需 import() AI 面板与 Agent 代码，
 * 没有则返回 null（普通对局，零开销）。Agent / 模型 SDK 只会出现在动态分包里。
 */
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
  gameOverCard(d: AiGameOverInfo, hd: AiGameOverHandlers): HTMLElement;
  destroy(): void;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function attachAi(ctx: AiAttachCtx): AiGameHooks | null {
  const launch = pending ?? (rearm && now() - rearm.at < 250 ? rearm.launch : null);
  pending = null;
  rearm = null;
  if (!launch) return null;

  ctx.game.classList.add('ai-run', `ai-${launch.role}`);
  let hud: AiHudHandle | null = null;
  let destroyed = false;
  const failed = (e: unknown): void => {
    console.error('[ai] 面板加载失败', e);
    ctx.app.toast('AI 模块加载失败，请检查网络后重试', 'warn');
  };
  const loading = import('./hud')
    .then((m) => {
      if (destroyed) return null;
      hud = m.mountAiHud(ctx, launch);
      return hud;
    })
    .catch((e: unknown) => {
      failed(e);
      return null;
    });

  return {
    role: launch.role,
    noSettle: launch.role === 'player',
    gameOver(d, hd) {
      if (hud) return hud.gameOverCard(d, hd);
      // 极少见：面板还没加载完对局就结束了
      const host = h('div.overlay.ai-report-overlay');
      void loading.then((m) => {
        if (m && host.isConnected) host.replaceWith(m.gameOverCard(d, hd));
        else if (host.isConnected) {
          host.appendChild(
            h('div.dialog.card', null, h('h2', null, d.won ? '防线守住了！' : '防线被突破'), h('p.muted', null, `撑过 ${d.wavesSurvived} 波`), h('button.btn.primary.big', { onclick: hd.menu }, '返回菜单')),
          );
        }
      });
      return host;
    },
    destroy() {
      destroyed = true;
      rearm = { launch, at: now() };
      try {
        hud?.destroy();
      } catch (e) {
        console.error(e);
      }
    },
  };
}
