/**
 * ⚠️ 渲染层独立调试页（render-dev.html）的入口，不属于正式应用。
 * - 若 src/core/index.ts 已存在则用真实 core（URL 加 ?mock=1 强制使用假 World）。
 * - 自带一个与 Session 接口一致的 DevSession，避免依赖 core 是否就绪。
 */
import { DT, TOWER_IDS, type Command, type CommandResult, type GameEvent, type IWorld, type RunOptions, type SkillId } from '../../core/types';
import type { Session } from '../../game/Session';
import { ui } from '../../game/UiStore';
import { mountBoard, setRenderQuality, getRenderQuality } from '../index';
import { createMockWorld } from './mockWorld';

type Listener = (ev: GameEvent) => void;

class DevSession {
  speed: 1 | 2 | 3 = 1;
  paused = false;
  autoPaused = false;
  private acc = 0;
  private listeners = new Set<Listener>();
  constructor(readonly world: IWorld) {}
  get running(): boolean {
    return !this.paused && !this.autoPaused;
  }
  get alpha(): number {
    return this.acc / DT;
  }
  update(dtMs: number): void {
    if (!this.running) return this.flush();
    const ph = this.world.state.phase;
    if (ph === 'perk' || ph === 'won' || ph === 'lost') return this.flush();
    this.acc += Math.min(dtMs / 1000, 0.25) * this.speed;
    let n = 0;
    while (this.acc >= DT && n < 30) {
      this.world.step();
      this.acc -= DT;
      n++;
    }
    this.flush();
  }
  command(cmd: Command): CommandResult {
    const r = this.world.command(cmd);
    this.flush();
    return r;
  }
  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onChange(): () => void {
    return () => {};
  }
  private flush(): void {
    for (const ev of this.world.drainEvents()) for (const fn of this.listeners) fn(ev);
  }
}

// 懒加载 core：mock 模式下不把 core 拉进模块图（避免 core 热更新时整页刷新）
const coreLoaders = import.meta.glob('../../core/index.ts') as Record<string, () => Promise<{ createWorld?: (o: RunOptions) => IWorld }>>;
const wantMock = new URLSearchParams(location.search).has('mock');
const loader = Object.values(coreLoaders)[0];
const real = !wantMock && loader ? (await loader()).createWorld : undefined;
const useMock = !real;
const world: IWorld = useMock
  ? createMockWorld()
  : real!({
      mode: 'endless',
      map: 'ch1',
      difficulty: 'normal',
      skills: ['eraser_strike', 'bell', 'whiteout_zone', 'ruler_sweep', 'relocate', 'inspiration', 'magnifier', 'caffeine', 'scholarship'] as SkillId[],
    });
if (!useMock) (world.state as { gold: number }).gold = 99999;

const session = new DevSession(world);
const host = document.getElementById('board')!;
let handle = mountBoard(host, session as unknown as Session);
(window as unknown as Record<string, unknown>).dd = { session, ui, world };

// ───────── 调试面板 ─────────
const panel = document.getElementById('panel')!;
const info = document.getElementById('info')!;
function btn(label: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = fn;
  panel.appendChild(b);
  return b;
}
const sep = () => panel.appendChild(document.createElement('hr'));

info.textContent = useMock ? '使用假 World（mock）' : '使用真实 core';
TOWER_IDS.forEach((id, i) => btn(`${i < 9 ? i + 1 : i === 9 ? 0 : '-'} ${id}`, () => ui.set({ build: ui.state.build === id ? null : id, pending: null, aiming: null })));
sep();
for (const s of world.state.skills) btn(`技能 ${s.id}`, () => {
  if (s.target === 'none') {
    const r = session.command({ type: 'cast', skill: s.id });
    if (!r.ok) console.warn(r.reason);
  } else ui.set({ aiming: ui.state.aiming === s.id ? null : s.id, build: null, pending: null, relocateFrom: null });
});
btn('轴向 R', () => ui.set({ aimAxis: ui.state.aimAxis === 'row' ? 'col' : 'row' }));
sep();
btn('开波 ␣', () => session.command({ type: 'startWave' }));
btn('速度 F', () => (session.speed = (((session.speed % 3) + 1) as 1 | 2 | 3)));
btn('暂停 P', () => (session.paused = !session.paused));
btn('升级 U', () => ui.state.selected !== null && session.command({ type: 'upgrade', uid: ui.state.selected, branch: Math.random() < 0.5 ? 'A' : 'B' }));
btn('出售 S', () => ui.state.selected !== null && session.command({ type: 'sell', uid: ui.state.selected }) && ui.set({ selected: null }));
btn('画质', () => setRenderQuality(getRenderQuality() === 'high' ? 'low' : 'high'));
btn('重挂载', () => {
  handle.destroy();
  handle = mountBoard(host, session as unknown as Session);
});
btn('满屏塔', () => {
  const ids = TOWER_IDS.filter((t) => t !== 'wall');
  let k = 0;
  for (let y = 2; y < 12; y += 2)
    for (let x = 0; x < 12; x += 3) {
      session.command({ type: 'place', tower: ids[k++ % ids.length], cx: x, cy: y });
    }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ui.clear();
  else if (e.key === 'r' || e.key === 'R') ui.set({ aimAxis: ui.state.aimAxis === 'row' ? 'col' : 'row' });
  else if (e.key === ' ') session.command({ type: 'startWave' });
  else if (e.key === 'p') session.paused = !session.paused;
  else if (e.key === 'f') session.speed = (((session.speed % 3) + 1) as 1 | 2 | 3);
  else if (e.key === 'u' && ui.state.selected !== null) session.command({ type: 'upgrade', uid: ui.state.selected, branch: 'B' });
  else if (e.key === 's' && ui.state.selected !== null) session.command({ type: 'sell', uid: ui.state.selected });
  else {
    const idx = '1234567890-'.indexOf(e.key);
    if (idx >= 0) ui.set({ build: TOWER_IDS[idx], aiming: null });
  }
});

const stat = document.getElementById('stat')!;
setInterval(() => {
  const st = world.state;
  stat.textContent = `wave ${st.wave} · ${st.phase} · gold ${Math.floor(st.gold)} · lives ${st.lives} · enemies ${st.enemies.length} · speed ${session.speed}× ${session.paused ? '(暂停)' : ''} · ui ${JSON.stringify({ b: ui.state.build, a: ui.state.aiming, s: ui.state.selected, ax: ui.state.aimAxis, t: ui.state.touch })}`;
}, 250);

// ───────── 调试辅助（控制台：dd.drive(n) 手动推进帧；dd.scenario() 摆出所有敌人状态） ─────────
let fakeT = performance.now();
function drive(n: number, dt = 1000 / 60): number {
  const b = (window as unknown as { __ddBoard?: { game: { step(t: number, d: number): void } } }).__ddBoard;
  for (let i = 0; i < n; i++) {
    fakeT += dt;
    b?.game.step(fakeT, dt);
  }
  return world.state.tick;
}
function scenario(): void {
  const st = world.state;
  const ids = ['crumb', 'inkdot', 'paperclip', 'plane', 'paperball', 'sticky', 'rubberband', 'whiteout', 'ant', 'invisink', 'tape', 'moth', 'crumbmini', 'boss_coffee', 'boss_coffee_small', 'boss_shredder', 'boss_inkbottle', 'boss_alarm'] as const;
  let u = 9000;
  ids.forEach((id, i) => {
    const boss = id.startsWith('boss');
    const x = boss ? 1.2 + ((i - 13) % 3) * 3.5 : 1 + (i % 6) * 2;
    const y = boss ? 9 + Math.floor((i - 13) / 3) * 3 : 1.5 + Math.floor(i / 6) * 2.3;
    st.enemies.push({
      uid: u++, id, x, y, angle: Math.PI / 2, hp: i % 2 ? 50 : 100, maxHp: 100, shield: id === 'sticky' ? 40 : 0, maxShield: 40, armor: 0, speed: 0,
      radius: boss ? 0.7 : id === 'crumbmini' ? 0.16 : 0.27, scale: i === 2 ? 1.2 : 1, flying: id === 'plane' || id === 'moth', boss,
      elite: i === 2 || i === 5, affixes: i === 2 ? ['hard', 'shield', 'rally'] : i === 5 ? ['swift', 'stealth'] : [], group: i === 7 ? 5 : 1,
      hidden: id === 'invisink', stealthy: id === 'invisink' || i === 5, slowPct: 0.4, slowUntil: i === 0 ? 999 : 0, stunUntil: i === 1 ? 999 : 0,
      rootUntil: i === 3 ? 999 : 0, inkStacks: i === 4 ? 4 : 0, bleedStacks: 0, burnUntil: 0, markedUntil: i === 6 ? 999 : 0,
      jumping: id === 'rubberband', lastHit: -1, spawnedAt: -10,
    });
  });
  session.paused = true;
}
Object.assign((window as unknown as { dd: Record<string, unknown> }).dd, { drive, scenario });
