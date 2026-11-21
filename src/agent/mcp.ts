/**
 * MCP 服务的处理逻辑（文档 10 §11）——不依赖 @modelcontextprotocol/sdk，便于单元测试直接调用；
 * scripts/mcp-server.ts 只负责把它挂到 stdio 传输上。
 *
 * 外部 Agent（Claude Code / Claude Desktop / 任意 MCP 客户端）自己当玩家：
 *   new_game → observe → 动作工具… → advance（推进到下一个决策点或 N 秒）→ … → get_replay
 * 多局并存，用 session_id 区分。所有动作仍走 World.command 校验；成绩只属于 AI 榜（agent = mcp）。
 */
import { SKILL_IDS } from '../config/skills';
import { createWorld } from '../core';
import type { DifficultyId, IWorld, MapId, ModeId, RunOptions, SkillId } from '../core/types';
import { makeMidRun } from '../meta/midrun';
import { boardForOpts } from '../shared/leaderboard';
import { renderObservation } from './observation';
import { runHeader, systemBlocks } from './prompts';
import { AgentScheduler } from './scheduler';
import { executeTool, type JsonSchema, LEGACY_TOOLS, normalizeAction, type ObjectSchema, SLIM_TOOLS, validateAgainst } from './tools';
import type { AgentReplay, DecisionPoint } from './types';

export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: ObjectSchema;
}

export interface McpCallResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

interface GameSession {
  id: string;
  opts: RunOptions;
  world: IWorld;
  sched: AgentScheduler;
  point: DecisionPoint | null;
  agentName: string;
}

const SID: JsonSchema = { type: 'string', description: 'session id returned by new_game' };

const META_TOOLS: McpToolSpec[] = [
  {
    name: 'new_game',
    description:
      'Start a new Desk Defense game and return its session_id, the rules summary (first call only) and the first observation. You then play with the action tools and call advance to let time pass.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        mode: { type: 'string', enum: ['endless', 'campaign'], description: 'default endless' },
        map: { type: 'string', enum: ['ch1', 'ch2', 'ch3'], description: 'default ch1' },
        difficulty: { type: 'string', enum: ['easy', 'normal', 'hard', 'nightmare', 'abyss'], description: 'default normal' },
        abyss_level: { type: 'integer', description: '1..10 when difficulty=abyss' },
        seed: { type: 'string', description: 'random seed (same seed = same game)' },
        skills: {
          type: 'array',
          items: { type: 'string', enum: SKILL_IDS },
          description: '3 skills, default eraser_strike,bell,whiteout_zone',
        },
        auto_wave: { type: 'boolean', description: 'auto-start waves after the first (default: difficulty default)' },
        wave_interval: { type: 'integer', description: 'seconds between decision points during a wave (default 10)' },
        max_waves: { type: 'integer', description: 'endless: stop after this wave' },
        agent_name: { type: 'string', description: 'model / agent name for the AI leaderboard tag' },
        include_rules: { type: 'boolean', description: 'include rules + catalog text (default true)' },
      },
    },
  },
  {
    name: 'observe',
    description: 'Current state of a game (compact JSON + ASCII map). detail=full adds prices, paths and nearest enemies.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id'],
      properties: { session_id: SID, detail: { type: 'string', enum: ['compact', 'full'] } },
    },
  },
  {
    name: 'advance',
    description:
      'Let the game run. Without seconds: run until the next decision point (build phase, every few seconds of a wave, event warning, boss, perk offer, crate) and return the observation. With seconds: run exactly that long (max 120). Perk offers and manual-start build phases block until you act.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id'],
      properties: { session_id: SID, seconds: { type: 'number', description: 'game seconds to run' } },
    },
  },
  {
    name: 'get_replay',
    description:
      "Replay JSON (seed + options + command log + tick) usable with the game's replay code; tagged as an agent run for the AI leaderboard only.",
    inputSchema: { type: 'object', additionalProperties: false, required: ['session_id'], properties: { session_id: SID } },
  },
  {
    name: 'list_sessions',
    description: 'List open game sessions.',
    inputSchema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
  {
    name: 'end_session',
    description: 'Close a game session and free memory.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['session_id'], properties: { session_id: SID } },
  },
];

/**
 * 游戏动作 / 读取工具（加 session_id）：批量 act + preview（路线预览）+ 旧的细粒度工具（兼容）。
 * end_turn 由 advance 代替（act 的 end 只更新备忘），suggest 不开放；MCP 的 observe 是会话工具（上面）。
 */
const GAME_TOOLS: McpToolSpec[] = [
  ...SLIM_TOOLS.filter((t) => t.name === 'act' || t.name === 'preview'),
  ...LEGACY_TOOLS.filter((t) => t.roles.includes('player') && t.name !== 'end_turn'),
].map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: {
    ...t.input_schema,
    properties: { session_id: SID, ...t.input_schema.properties },
    required: ['session_id', ...t.input_schema.required],
  },
}));

const text = (t: string, isError = false): McpCallResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

export class McpGameServer {
  private sessions = new Map<string, GameSession>();
  private counter = 0;
  private rulesSent = false;
  readonly maxSessions: number;

  constructor(o: { maxSessions?: number } = {}) {
    this.maxSessions = o.maxSessions ?? 8;
  }

  listTools(): McpToolSpec[] {
    return [...META_TOOLS, ...GAME_TOOLS];
  }

  private obs(g: GameSession, detail: 'compact' | 'full' = 'compact'): string {
    const p = g.point;
    const why = p ? `decision point #${p.seq}: ${p.reasons.join(', ')}` : g.sched.stopped ? `game over: ${g.sched.stopped}` : 'running';
    return `${why}\n${renderObservation(g.world, { detail, recent: g.sched.takeRecent() })}`;
  }

  callTool(name: string, args: Record<string, unknown> = {}): McpCallResult {
    const spec = this.listTools().find((t) => t.name === name);
    if (!spec) return text(`unknown tool ${name}`, true);
    // act 的旧意图名（anti_air / combo / support / economy / rebuild_maze）先改写成合并后的写法再校验
    if (name === 'act' && Array.isArray(args.actions))
      args = {
        ...args,
        actions: (args.actions as Record<string, unknown>[]).map((a) => (a && typeof a === 'object' ? normalizeAction(a) : a)),
      };
    const errs = validateAgainst(spec.inputSchema, args);
    if (errs.length) return text(`invalid input: ${errs.join('; ')}`, true);
    if (name === 'new_game') return this.newGame(args);
    if (name === 'list_sessions') {
      return text(
        JSON.stringify(
          [...this.sessions.values()].map((g) => ({
            session_id: g.id,
            mode: g.opts.mode,
            map: g.opts.map,
            difficulty: g.opts.difficulty,
            wave: g.world.state.wave,
            phase: g.world.state.phase,
          })),
        ),
      );
    }
    const g = this.sessions.get(String(args.session_id));
    if (!g) return text(`no session ${String(args.session_id)} (call new_game)`, true);
    switch (name) {
      case 'end_session':
        this.sessions.delete(g.id);
        return text(`closed ${g.id}`);
      case 'observe':
        return text(this.obs(g, args.detail === 'full' ? 'full' : 'compact'));
      case 'get_replay': {
        const replay: AgentReplay = { ...makeMidRun(g.world), agent: { provider: 'mcp', model: g.agentName, role: 'player' } };
        return text(JSON.stringify({ board: boardForOpts(g.opts), replay }));
      }
      case 'advance':
        return this.advance(g, args.seconds as number | undefined);
    }
    const { session_id: _sid, ...input } = args;
    void _sid;
    const r = executeTool({ world: g.world, role: 'player' }, name, input);
    return text(r.text, !r.ok);
  }

  private newGame(a: Record<string, unknown>): McpCallResult {
    if (this.sessions.size >= this.maxSessions) return text(`too many sessions (max ${this.maxSessions}); end_session first`, true);
    const id = `g${++this.counter}`;
    const opts: RunOptions = {
      mode: (a.mode as ModeId) ?? 'endless',
      map: (a.map as MapId) ?? 'ch1',
      difficulty: (a.difficulty as DifficultyId) ?? 'normal',
      seed: (a.seed as string | undefined) ?? `mcp-${id}-${Date.now().toString(36)}`,
      skills: ((a.skills as SkillId[] | undefined) ?? ['eraser_strike', 'bell', 'whiteout_zone']).slice(0, 4),
      pure: true,
    };
    if (a.abyss_level !== undefined) opts.abyssLevel = a.abyss_level as number;
    if (a.auto_wave !== undefined) opts.autoWave = a.auto_wave as boolean;
    let world: IWorld;
    try {
      world = createWorld(opts);
    } catch (e) {
      return text(`cannot create game: ${e instanceof Error ? e.message : String(e)}`, true);
    }
    const sched = new AgentScheduler(world, {
      mode: 'pause',
      waveIntervalSec: (a.wave_interval as number | undefined) ?? 10,
      maxWaves: a.max_waves as number | undefined,
    });
    const g: GameSession = { id, opts, world, sched, point: null, agentName: (a.agent_name as string | undefined) ?? 'external' };
    g.point = sched.advance(0);
    this.sessions.set(id, g);
    const rules = (a.include_rules ?? !this.rulesSent) ? `${systemBlocks('player').join('\n\n')}\n\n` : '';
    this.rulesSent = true;
    return text(
      `${rules}session_id: ${id}\n${runHeader(opts, world)}\nPlay with act (batch of actions, pass session_id) or the single-action tools, then call advance (act's end does not advance time).\n${this.obs(g)}`,
    );
  }

  private advance(g: GameSession, seconds?: number): McpCallResult {
    const s = g.world.state;
    if (g.sched.stopped) return text(`game over: ${g.sched.stopped}\n${this.obs(g)}`);
    if (s.phase === 'perk') return text(`blocked: choose_perk first (offer: ${s.perkChoices?.map((c) => c.id).join(', ')})`, true);
    if (s.phase === 'build' && !(s.autoWave.enabled && s.autoWave.started))
      return text('blocked: waves start manually — call start_wave when ready', true);
    g.sched.markDecided();
    if (seconds !== undefined) {
      g.sched.run(Math.max(0, Math.min(120, seconds)));
      g.point = null;
      return text(this.obs(g));
    }
    // 最多推进 10 分钟游戏时间，避免关闭波中决策时一次跑完整局
    g.point = g.sched.advance(60 * 600);
    return text(this.obs(g));
  }
}
