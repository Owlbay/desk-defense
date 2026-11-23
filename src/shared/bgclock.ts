/**
 * 后台时钟（后台模式）：标签页切到后台时，浏览器会把 requestAnimationFrame 停掉，把 setInterval 降到每秒一次，
 * 超过 5 分钟后甚至一分钟一次。后台模式下由一个 Worker 定时发消息（Worker 里的计时器不受这套节流），
 * 主线程收到消息就推进对局、轮询 AI 控制器。
 *
 * - holdBackground()：开始驱动（引用计数）；同时持有一把 Web Lock，降低 Chrome 冻结后台标签页的概率。
 * - onBackgroundTick(fn)：每次心跳回调 fn(dtMs)。
 * - steadyInterval(fn, ms)：普通 setInterval；后台时钟运行期间额外由心跳补上，保证后台也按 ms 的节奏调用。
 * 没有 Worker 的环境（Node 脚本、测试）里 holdBackground 什么都不做，steadyInterval 就是 setInterval。
 */

type TickFn = (dtMs: number) => void;

// 这个模块也会被 Pages Functions（无 DOM 类型）间接引用：只用到的浏览器 API 在这里自己声明
interface WorkerLike {
  onmessage: (() => void) | null;
  terminate(): void;
}
interface BrowserApis {
  Worker?: new (url: string) => WorkerLike;
  Blob?: new (parts: string[], o: { type: string }) => unknown;
  URL: { createObjectURL?(b: unknown): string; revokeObjectURL?(u: string): void };
  navigator?: { locks?: { request(name: string, cb: () => Promise<void>): Promise<unknown> } };
}
const g = globalThis as unknown as BrowserApis;

const TICK_MS = 50;
const subs = new Set<TickFn>();
let holders = 0;
let worker: WorkerLike | null = null;
let workerUrl: string | null = null;
let last = 0;
let releaseLock: (() => void) | null = null;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function emit(): void {
  const t = now();
  const dt = last ? t - last : TICK_MS;
  last = t;
  for (const fn of [...subs]) {
    try {
      fn(dt);
    } catch (e) {
      console.error(e);
    }
  }
}

function startWorker(): void {
  const { Worker: W, Blob: B, URL: U } = g;
  if (worker || !W || !B || !U?.createObjectURL) return;
  try {
    workerUrl = U.createObjectURL(new B([`setInterval(function(){postMessage(0)},${TICK_MS});`], { type: 'text/javascript' }));
    worker = new W(workerUrl);
    worker.onmessage = emit;
  } catch (e) {
    console.warn('[bgclock] worker unavailable', e);
    worker = null;
  }
  last = now();
  // 持有 Web Lock 的标签页不会被 Chrome 的「标签页冻结」冻住（省电 / 内存节省模式仍可能丢弃，那是浏览器的决定）
  try {
    const locks = g.navigator?.locks;
    if (locks) {
      void locks.request('desk-defense-background', () => new Promise<void>((resolve) => (releaseLock = resolve))).catch(() => undefined);
    }
  } catch {
    /* 不支持就算了 */
  }
}

function stopWorker(): void {
  worker?.terminate();
  worker = null;
  if (workerUrl) g.URL?.revokeObjectURL?.(workerUrl);
  workerUrl = null;
  releaseLock?.();
  releaseLock = null;
  last = 0;
}

/** 后台时钟是否在跑 */
export function backgroundActive(): boolean {
  return holders > 0;
}

/** 开始用后台时钟驱动；返回的函数释放（引用计数归零时停掉 Worker、释放锁） */
export function holdBackground(): () => void {
  holders++;
  if (holders === 1) startWorker();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    holders = Math.max(0, holders - 1);
    if (holders === 0) stopWorker();
  };
}

export function onBackgroundTick(fn: TickFn): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** setInterval 的后台版：后台时钟运行时，即使浏览器节流了计时器，也由心跳按 ms 的节奏补调 */
export function steadyInterval(fn: () => void, ms: number): () => void {
  let lastRun = now();
  const run = () => {
    lastRun = now();
    fn();
  };
  const timer = setInterval(run, ms);
  const off = onBackgroundTick(() => {
    if (now() - lastRun >= ms) run();
  });
  return () => {
    clearInterval(timer);
    off();
  };
}
