# 10 · Agent 参战（大模型来玩书桌防线）

> 让大模型（Claude、OpenAI、Gemini、本机的 Ollama / LM Studio……）像玩家一样玩这个游戏：
> 读状态、用工具下指令、在决策点思考。同一套代码跑在 CLI 评测、MCP 服务、本机桥接器和（之后的）网页 AI 模式里。
>
> 状态：核心（`src/agent/`）、CLI、MCP 服务、桥接器、测试已实现；网页 UI 由后续 UI 工作接入（§12 给出接口）。
> 没有改动 `src/core`、`src/config`、`src/ui`、`src/styles`、`src/main.ts`。

---

## 1. 目标与边界

**目标**
1. **AI 玩家**：模型独立打完一局（无尽 / 战役），成绩进入**独立的 AI 排行榜**，可回放、可复现。
2. **AI 军师**：真人在玩，模型只读状态并给建议（坐标、uid 具体到可以一键执行），不能下指令。
3. **评测场**：同种子批量对比模型 vs 内置机器人（newbie / medium / expert），统计波数、得分、token、每波成本。
4. **开放接入**：任意 MCP 客户端（Claude Code / Claude Desktop）直接当玩家；网页里可接玩家自己的 Key、自己电脑上的本地模型。
5. **公平**：所有操作都走 `World.command()`——与玩家点击完全同一套校验，模型无法作弊；AI 成绩永远不混进真人榜。

**非目标**
- 不训练模型、不做强化学习；不改游戏规则去迁就模型。
- 不由运营方付费提供模型（§10.5 只记录设计与风险）。
- AI 进攻方本期只有协议桩（§2.3）。

---

## 2. 角色

| 角色 | 能做什么 | 工具 | 实现状态 |
|---|---|---|---|
| **AI 玩家** `player` | 建塔、升级、技能、选增益、开波…… | 读取 + 全部动作 + `end_turn` | ✅ |
| **AI 军师** `advisor` | 只读 + `suggest(text, actions[])` | 读取 + `suggest` + `end_turn` | ✅（无头模式下由兜底机器人代替"真人"执行，用于测试建议质量） |
| **AI 进攻方** `attacker` | 用预算编排下一波敌人 | 读取 + `end_turn`（`attack_plan` 待 core 钩子） | 🧩 协议桩 |

### 2.1 AI 玩家
默认角色。每个决策点拿到观测，调用若干动作工具，以 `end_turn(note)` 收尾。`note`（≤200 字）会在下一次决策时回显给模型，充当跨决策记忆（每次决策都是新对话，见 §7）。

### 2.2 AI 军师
真人在玩时，控制器在决策点（同 §4；建议配置 `role: 'advisor'`、`waveIntervalSec: 20`、`mode: 'realtime'` 以免打断玩家）调用模型；模型只能 `suggest`。UI 把建议显示成卡片，`actions` 是形如 `place_tower pencil 3,5` 的字符串，UI 可解析成同名工具调用做"一键执行"（执行时仍走玩家的 `session.command`）。

### 2.3 AI 进攻方（设计 + 协议桩）
- 每波开始前（`build` 决策点）给进攻方一个预算 `budget = 50 + 10×波数`（"墨水点"）。
- 工具（设计）：`attack_plan({ groups: [{ enemy, count, affixes[], spawner, delay }] })`，价格表 = 敌人赏金 × 系数，词缀加价，空降点额外收费；Boss 波禁止修改 Boss。
- 校验：总价 ≤ 预算；敌人必须在当前波数的出怪池内；每波上限 = 默认波的 1.5 倍血量当量。
- **需要的 core 钩子（未做，待批准）**：`World.command({ type: 'overrideWave', wave, plan })`——在 `generateWave` 结果之上替换本波条目，写入指令日志（回放仍确定）。这是纯增量指令，不改变现有行为。
- 对抗形态：AI 进攻 vs AI 防守（双模型）、AI 进攻 vs 真人（"出题人"模式）。成绩另立 `ai-attack:` 榜。
- 本期：`role: 'attacker'` 只开放读取 + `end_turn`，实际防守由兜底机器人完成，用于打通流程。

---

## 3. 架构

```
                         ┌─────────────────────────── src/agent（纯 TS，无 DOM，Node / 浏览器通用）──────────────────────────┐
                         │                                                                                                     │
 RunOptions ─► createWorld│  AgentScheduler / DecisionDetector ──► DecisionPoint ──► DecisionEngine ──► LLMProvider.decide(ctx) │
   (core World)          │      ▲  step()/drainEvents()            (reasons)         │  观测 observation.ts                    │
        ▲                │      │                                                    │  提示 prompts.ts（固定前缀，可缓存）      │
        │ command()      │      │                                                    │  预算 / 超时 / 熔断 / 兜底 FallbackPolicy │
        └────────────────┼──── tools.ts executeTool ◄──── ctx.callTool(name,input) ◄─┘                                           │
                         │      （strict JSON Schema 校验 → Command → World.command）                                           │
                         │                                                                                                     │
                         │  providers/                                                                                         │
                         │   ├ claude.ts   官方 @anthropic-ai/sdk（推荐的 Claude 路径）                                         │
                         │   ├ pi.ts       @mariozechner/pi-ai：anthropic / openai-completions / openai-responses / google       │
                         │   ├ json-mode   不会调工具的小模型：输出 JSON 动作列表                                                 │
                         │   ├ scripted.ts 确定性脚本策略（测试 / 离线 / 兜底）                                                   │
                         │   └ bridge.ts   浏览器 ⇄ 本机桥接器（WebSocket）                                                      │
                         └─────────────────────────────────────────────────────────────────────────────────────────────────────┘
   入口：
   scripts/agent-play.ts   CLI：整局 / 评测场 / 报告（runner.ts → runAgentGame）
   scripts/mcp-server.ts   MCP stdio 服务（mcp.ts → McpGameServer，外部 Agent 当玩家）
   scripts/agent-bridge.ts 本机桥接器（bridge.ts → createBridgeSession）
   src/agent/index.ts      网页 UI 用：createAgentController({ config, session, … })
```

文件一览：

| 文件 | 内容 |
|---|---|
| `src/agent/types.ts` | 公共类型：角色、决策点、用量、决策记录、回放（MidRun + agent 标记）、兜底接口 |
| `src/agent/observation.ts` | 状态 → 紧凑 JSON + 12×14 ASCII 地图；token 估算 |
| `src/agent/tools.ts` | 工具定义（strict JSON Schema）、最小 Schema 校验器、工具 → Command、执行器 |
| `src/agent/prompts.ts` | 规则 / 资料表（系统提示，逐字节稳定）、开局信息、决策消息 |
| `src/agent/scheduler.ts` | `DecisionDetector`（纯判定）与 `AgentScheduler`（无头推进） |
| `src/agent/trace.ts` / `redact.ts` | 思路与请求：决策追踪事件、环形缓冲 `AgentTrace`、导出；脱敏（§12.1） |
| `src/agent/engine.ts` | `DecisionEngine`：一次决策的完整流程（观测、调用、记录、预算、超时、熔断、兜底、推进保证） |
| `src/agent/runner.ts` | `runAgentGame(opts, agent)`；`aiBoardKey()` |
| `src/agent/config.ts` | 模型配置 schema、预设、校验、`saveableConfig`（去掉 Key） |
| `src/agent/factory.ts` | `createProvider(config)`：按需 `import()` 各适配器 |
| `src/agent/models.ts` | `listModels(config)`、`testConnection(config)` |
| `src/agent/bridge.ts` | 桥接器协议、服务端会话、浏览器端 `connectBridge` / `BridgeProvider` |
| `src/agent/mcp.ts` | MCP 处理逻辑（不依赖 MCP SDK，便于测试） |
| `src/agent/index.ts` | 公共 API + 网页控制器 `createAgentController` + Key 存放 |

---

## 4. 决策节奏

模型很慢（几秒到几十秒），游戏是 60 Hz 的实时塔防。两种模式：

### 4.1 暂停模式 `pause`（默认、推荐、评测用）
到决策点时世界冻结，模型想多久都行；做完（`end_turn` / 用完工具调用 / 超时）后继续。结果只取决于模型的决定，与网速无关。

### 4.2 实时模式 `realtime`
世界不等人。无头运行时（CLI / 测试）为了可复现，**每次模型请求让世界前进固定的 `realtimeLatencySec` 游戏秒**（默认 3 秒，可设 `'measured'` 用实测耗时）；之后的工具调用落在更晚的帧上。浏览器里世界本来就在跑，指令到达时经 `session.command()` 落地。指令日志自带帧号，所以回放与真人完全一致。

### 4.3 决策点

| 原因 | 触发 | 说明 |
|---|---|---|
| `game_start` | 开局第一帧 | 同时带 `build` |
| `build` | 手动开波时每次等待开波；自动开波时每波结束 | 手动模式下若模型没开波，引擎自动 `start_wave`（记在决策记录里） |
| `wave_interval` | 波次进行中，距上次决策 ≥ N 秒（默认 10，本地小模型 20） | 0 = 关闭 |
| `event_warn` | 随机事件预警 | 合并到下次决策（≥ minGap） |
| `drop_warn` | 空降出生点预警 | 同上 |
| `boss_spawn` | Boss 出场 | 同上 |
| `perk` | 增益三选一（世界自动暂停） | 必须处理；模型没选则引擎选第一张不需要目标的卡 |
| `crate` | 补给箱打开待选 | 模型没选则选第一项 |
| `leak` | 自上次决策有漏怪 | 只作为附加原因 |

- 事件型原因距上次决策不足 `minGapSec`（3 秒）时先挂起，到时间合并触发，避免一波里被频繁打断。
- **硬币 / 补给箱默认自动拾取**（`autoCollect`）：真人点一下就行，不值得为此唤醒模型；拾取也会写进指令日志。
- 无尽模式 `maxWaves`：该波结束即停（结果 `cap`）；`maxGameSeconds`（默认 3 小时）兜底。

---

## 5. 观测格式

> **已更新**：模型实际收到的是 §17.4 的紧凑观测 v2（短键 + 进攻路线 + 增量）。下面的旧格式仍用于 `get_state` / MCP `observe` / `observe {detail:'full'}`。

每个决策点发给模型：开局信息（模式 / 地图 / 种子 / 技能 / 解锁的塔）+ 决策原因 + 观测。观测 = 一行紧凑 JSON + ASCII 地图：

```text
{"t":131.2,"tick":7873,"phase":"wave","wave":6,"totalWaves":0,"gold":8,"lives":"20/20","score":1555,
 "autoWave":"running","path":[14],
 "towers":["#1 pencil@4,11 L3 xp38%","#3 glue@4,12 L2 xp13%","#302 stapler@4,8 L1 xp22%", …],
 "enemies":{"alive":7,"groups":[{"type":"crumb","n":5,"hp":0.62,"band":[2,2,1]},{"type":"plane","n":2,"hp":1,"band":[2,0,0],"air":true}],
            "front":"crumb#412@5.5,11.2 hp6/16 d1.8"},
 "next":{"wave":7,"tags":["air"],"groups":["plane×6 from north","crumb×5 from north"],"earlyBonus":40},
 "skills":["eraser_strike:READY target=circle","bell:cd41.5 target=none","whiteout_zone:READY target=rect2"],
 "events":["fan(bad) warn in 4.0s area x3 y5 3×3"],"spawners":["north(edge)@5,0 open"],"pickups":[],
 "owned":["sale"],"build":["wall=5","pencil=20✗","stapler=45✗", …],
 "recent":"kills 12; gold +31; wave6 started","note":"plan: anti-air next"}
MAP
   0123456789ab
00 .....SS.....
01 #....:......
02 .....:###...
…
12 ....G:T.....
13 .....XX.....
```

**地图图例**：行 = y（0..13，上→下），列 = x（0..9，a=10，b=11）。`.` 空地 · `:` 当前敌人路线 · `#` 障碍 · `S` 入口 · `d` 空降预警（不可建）· `D` 空降出生点 · `X` 出口 · `*` 有敌人的空格；塔：`W` 墙 `P` 铅笔 `T` 订书机 `G` 胶水 `L` 台灯 `C` 圆规 `E` 橡皮 `R` 尺子 `N` 钢笔 `K` 计算器 `$` 存钱罐 `F` 苍蝇拍。

要点：
- **塔**：一行一座 `#uid id@x,y L级 [brA] [★n] [xp%] [tgt=mode] [DISABLED]`；Lv9+ / 有星的额外带 `up= evo= ability=`；Lv1 墙压缩成一行。
- **敌人按类型聚合**：数量、剩余血量比例、按到出口路程分段 `[远 >8, 中 4..8, 近 ≤3]`；另给最靠近出口的一只（`front`）与所有 Boss 的坐标。
- **build** 列出可建塔及价格，`✗` = 买不起 / 达上限。
- `get_state(detail:"full")` 额外给每座塔的升级 / 出售价、路线格序列、离出口最近的 12 个敌人。

**token 预算**（`estimateTokens` 估算，测试里有上限断言）：开局 ≈ 500，20 波 / 20 座塔 ≈ 600，测试上限：开局 < 1500，后期 < 3000，full < 4000。固定前缀：规则 ≈ 1.1k、资料表 ≈ 4.4k、工具定义 ≈ 2.8k（合计 ≈ 8.4k，全部可缓存）。

---

## 6. 工具

> **已更新**：发给模型的是 §17.3 的 5～6 个精简工具（`act` 批量动作 + `observe` / `preview` / `get_catalog` / `get_tower` / `suggest`）。下面的细粒度工具保留在 `LEGACY_TOOLS`：MCP 照常开放、军师建议按它们解析、模型若调用旧名字执行器照常执行。

全部工具定义在 `src/agent/tools.ts`，**strict JSON Schema**（每个 object 都 `additionalProperties: false` + `required`；可选字段不列入 required），Claude 用 `strict: true`，pi 转 TypeBox（字符串枚举用 `StringEnum`，兼容 Google）。坐标统一是**格**：`x` 列 0..11、`y` 行 0..13；圆形技能以格中心为圆心（执行器自动 +0.5）。

### 6.1 读取（不改变世界）

| 工具 | 输入 | 输出 |
|---|---|---|
| `get_state` | `detail?: compact\|full` | 同 §5 |
| `get_catalog` | `section?: all\|towers\|enemies\|skills\|perks\|abilities\|events` | 资料表文本（与系统提示里的相同） |
| `get_tower` | `uid` | `getTowerInfo` 精简版：属性、升级价、分支说明、进化价、出售价、能力冷却、可选目标策略 |
| `preview_placement` | `tower, x, y` | `canPlace` + `previewPath`：能否放、价格、路线长度变化 |

### 6.2 动作（与 Command 一一对应）

| 工具 | 输入 | Command |
|---|---|---|
| `place_tower` | `tower, x, y` | `{type:'place', tower, cx:x, cy:y}` |
| `upgrade_tower` | `uid` | `{type:'upgrade', uid}` |
| `choose_branch` | `uid, branch A\|B` | `{type:'upgrade', uid, branch}`（Lv9→10） |
| `evolve_tower` | `uid` | `{type:'evolve', uid}` |
| `sell_tower` | `uid` | `{type:'sell', uid}` |
| `set_target_mode` | `uid, mode` | `{type:'setTarget', uid, mode}` |
| `cast_skill` | `skill, x?, y?, uid?, axis?, index?, spawner?` | `{type:'cast', …}`：按技能目标类型取字段——circle → `x+.5,y+.5`；rect2 → `cx,cy`（左上角）；line → `axis` + `cx\|cy`；tower → `uid`；tower+cell → `uid,cx,cy`；spawner → `spawner` |
| `tower_ability` | `uid, x?, y?, angle?, axis?, index?, target_uid?` | `{type:'towerAbility', …}` |
| `choose_perk` | `id, uid?, branch?` | `{type:'choosePerk', …}` |
| `reroll_perks` | — | `{type:'rerollPerks'}` |
| `collect_pickup` | `uid?`（省略 = 全捡） | `{type:'collect', uid}` × n |
| `choose_crate` | `option` | `{type:'chooseCrate', option}` |
| `demolish_spawner` | `id` | `{type:'demolishSpawner', id}` |
| `start_wave` | — | `{type:'startWave'}` |

### 6.3 控制
- `end_turn(note?)`：结束本次决策（所有角色）。
- `suggest(text, actions?)`：仅军师。

### 6.4 结果与错误
执行器永不抛异常，返回给模型的是可读文本：
- 成功：`OK placed pencil #12 at 3,5 (-20g, gold 46). path lengths now 18`
- 参数错：`ERROR invalid input: input.y is required`（也覆盖类型、枚举、多余字段）
- 世界拒绝：`REJECTED {"type":"place",…}: 会堵死道路 (cost 20, gold 8)`——附带价格 / 分支提示 / 当前增益选项等帮助改正的信息。
- `is_error: true` 标在失败的 tool_result 上，模型能看出来。

### 6.5 JSON 动作模式（`toolMode: 'json'`）
给原生工具调用不可靠的小模型：系统提示里附上工具签名，模型只输出
`{"actions":[{"tool":"place_tower","args":{"tower":"pencil","x":3,"y":5}}, …],"note":"…"}`。
我们容错解析（去掉 ``` 包裹、找第一个完整对象）→ 逐个按同一份 Schema 校验 → 依次执行。含只读工具且没有 `end_turn` 时把结果回给模型再来一轮（最多 4 轮）。

---

## 7. 提示词与缓存

> **已更新**：`system[1]` 由完整资料表（≈4.4k）改为速查表（≈0.6k），完整资料改由 `get_catalog` 按需取；跨决策记忆改为结构化备忘（§17.6）。见 §17。

- **每个决策是一段新对话**：`system`（固定）+ 一条 user 消息（开局信息 + 原因 + 观测）；决策内多轮工具调用正常累积，决策结束即丢弃。上下文长度恒定，不需要压缩；跨决策记忆只靠 `note`。
- **缓存布局**（前缀匹配）：`tools`（固定顺序）→ `system[0]` 规则 + 角色说明 → `system[1]` 资料表（`cache_control: ephemeral`）→ messages。规则与资料表不含任何随局变化的东西（种子、时间、金币都在 user 消息里），同模型同角色的所有局共享缓存；再加顶层自动缓存，覆盖同一决策内的多轮请求。验证：报告里的 `cacheReadTokens` 应该在第二个决策起就 > 0。
- 规则只写游戏规则与少量策略提示，不写"必须先想清楚再行动"之类过时的强约束；靠 effort 控制思考深度。

---

## 8. 模型与厂商配置

### 8.1 配置结构（CLI / MCP / 桥接器 / 网页 共用，`src/agent/config.ts`）

```ts
interface AgentModelConfig {
  provider: 'claude-native' | 'pi' | 'bridge' | 'scripted';
  preset?: 'anthropic'|'openai'|'google'|'openrouter'|'deepseek'|'ollama'|'lmstudio'|'llamacpp'|'vllm'|'relay'|'custom';
  api?: 'anthropic-messages'|'openai-completions'|'openai-responses'|'google-generative-ai';
  baseUrl?: string;
  model: string;
  apiKey?: string;               // 只在内存；saveableConfig() 会删掉
  toolMode?: 'native' | 'json';
  effort?: 'low'|'medium'|'high'|'xhigh'|'max';
  temperature?: number;          // 仅部分 OpenAI 兼容模型；claude-native 不发送
  contextBudget?: 'full' | 'compact';   // compact：系统提示不带资料表（需要时 get_catalog）
  maxToolCallsPerDecision?: number;     // 默认 12
  maxOutputTokens?: number;
  role?: 'player' | 'advisor' | 'attacker';
  decision?: { mode?: 'pause'|'realtime'; waveIntervalSec?: number; realtimeLatencySec?: number | 'measured' };
  budget?: { tokens?: number; usd?: number };
  decisionTimeoutMs?: number;    // 默认 90000
  maxRetries?: number;           // pi：SDK 自动重试次数（缺省 SDK 默认 2；中转接口探测时为 0）
  bridge?: { url: string; code: string };
  refusalFallback?: boolean;     // claude-native：默认开
  browser?: boolean;             // 浏览器直连托管 API（BYO key）
}
```
`resolveConfig` 补缺省（预设 → api / baseUrl / 默认模型；本地预设默认 `waveIntervalSec = 20`），`validateConfig` 返回中文错误列表，`agentTag` 生成排行榜标记 `{provider, model}`。

### 8.2 预设

| 预设 | api | baseUrl | 默认模型 | 备注 |
|---|---|---|---|---|
| anthropic | anthropic-messages | https://api.anthropic.com | claude-opus-5-5 | 推荐改用 `claude-native` |
| openai | openai-responses | https://api.openai.com/v1 | gpt-5-mini | |
| google | google-generative-ai | https://generativelanguage.googleapis.com/v1beta | gemini-2.5-flash | |
| openrouter | openai-completions | https://openrouter.ai/api/v1 | 任意 | |
| deepseek | openai-completions | https://api.deepseek.com | deepseek-chat | |
| ollama | openai-completions | http://localhost:11434/v1 | qwen3:8b | 本机 |
| lmstudio | openai-completions | http://localhost:1234/v1 | qwen3-8b | 本机 |
| llamacpp | openai-completions | http://localhost:8080/v1 | — | `llama-server --jinja` 才有工具调用 |
| vllm | openai-completions | http://localhost:8000/v1 | Qwen/Qwen3-8B | `--enable-auto-tool-choice --tool-call-parser hermes` |
| relay | 自动检测 / 三选一 | 玩家填写（任意形式，自动规范化） | 自填 / 从列表选 | 中转服务，见 §10.8 |
| custom | 自填 | 自填 | 自填 | |

本机预设自动设 `compat: { supportsDeveloperRole:false, supportsReasoningEffort:false, supportsStore:false, supportsStrictMode:false }`。

### 8.3 适配器接口
```ts
interface LLMProvider { id: string; model: string; decide(ctx: DecisionContext): Promise<DecisionOutcome>; dispose?(): void }
```
`DecisionContext` 带系统提示两块、决策消息、工具定义、`callTool()`、`afterRequest(ms)`（实时模式推进世界）、`maxToolCalls`、剩余预算、`AbortSignal`。适配器自己跑工具循环；`DecisionOutcome` 返回用量、费用、工具调用数、是否 `end_turn`、备忘、错误。

- **claude-native**（`providers/claude.ts`，官方 `@anthropic-ai/sdk`，Claude 的推荐路径）
  - 模型：`claude-opus-5-5`（默认）/ `claude-sonnet-5-5` / `claude-haiku-5-5` / `claude-fable-5-2`。
  - `thinking: {type:'adaptive'}` + `output_config.effort`（默认 medium）；不用 `budget_tokens`，不发 `temperature`（Opus 5.5 不能关思考，effort 是唯一的控制）。
  - `tool_choice: auto` + 所有工具 `strict: true`（Opus 5.5 / Sonnet 5.5 / Fable 5.2 上强制 `any`/`tool` 会 400），靠提示要求以 `end_turn` 收尾。
  - 拒答：检查 `stop_reason === 'refusal'`（`stop_details.category` 写进错误）；opus-5-5 / sonnet-5-5 / fable-5-2 默认开**服务端回退** `fallbacks: 'default'`（beta `server-side-fallback-2026-07-01`）；haiku-5-5 没有服务端回退，拒答 → 本回合交给兜底机器人。
  - 助手内容（含 thinking 块）原样放回对话；并行工具调用的结果放在同一条 user 消息里。
  - 凭据：`new Anthropic()` 自己按 `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `ant auth login` 档案解析，代码里不写 Key；只有浏览器 BYO 模式显式传 `apiKey` + `dangerouslyAllowBrowser`。
  - 错误按类型区分（认证 / 权限 / 限流 / 400 / 5xx / 连接 / 中止），写进决策记录。
- **pi**（`providers/pi.ts`，`@mariozechner/pi-ai` 0.73）：`completeSimple` + 工具循环；已知厂商优先用 pi 自带模型表（含价格），否则构造自定义 `Model`；`effort` 映射到 pi 的 `reasoning`（仅推理模型）；用量与费用取自 `usage.cost`（本地模型 0）。
- **bridge**：见 §10.3。
- **scripted**：确定性脚本策略，与模型用同一套工具（测试、离线演示、评测下限）。

### 8.4 listModels / testConnection
- `listModels(config)`：中转服务（`preset: 'relay'`）`GET {根}/v1/models`，先 `Authorization: Bearer`，失败再试 `x-api-key` + `anthropic-version`；OpenAI 兼容（含所有本地服务）`GET {baseUrl}/models`；Anthropic `GET /v1/models`；Google / OpenAI 也可回退到 pi 内置表。失败时返回 CORS / 本地网络权限提示。
- `testConnection(config)`：发一个只有 `end_turn` 工具的极小请求，返回 `{ reachable, toolCalling, latencyMs, tokens, error, hint, advice }`。模型连得上但不调用工具时建议换模型或改 `toolMode: 'json'`。

---

## 9. 成本、延迟与可靠性

| 控制 | 默认 | 行为 |
|---|---|---|
| 整局 token 预算 `budget.tokens` | CLI 2,000,000 / 网页 1,000,000 | **折算**：新输入 + 输出 + 缓存写×1.25 + 缓存读×0.1（§17.1）；`budget.mode` 默认 soft = 分级收紧后继续，hard = 用尽交给内置机器人（§17.8） |
| 整局费用预算 `budget.usd` | 无 | 同上（按价格表估算） |
| 每次决策工具调用上限 | 12 | 超出的调用返回 `ERROR tool-call limit…`，本回合结束 |
| 单次决策超时 | 90 s | 中止请求，本回合由兜底机器人决定 |
| 连续失败熔断 | 3 次 | 停用模型（例如没有凭据、模型不存在），余下全部兜底 |
| 思考等级 `thinking` | Claude 中 / 中转 低 / 本机 无思考 | 见 §17.9 映射表（旧 `effort` 是别名） |
| 单次回复 max_tokens | 按上下文模式：省流 4096 / 均衡 8192 / 完整 16000 | 预算分级时更低（§17.8） |

**兜底机器人**：CLI 用 `scripts/bots` 的 StrategyBot（默认 `medium`，`--fallback expert` 可换）；浏览器默认用脚本策略。决策后还有"推进保证"：增益没选 → 选第一张不需要目标的；补给没选 → 选第一项；手动模式没开波 → 自动开波。这些都记在决策记录的 `fallbackReason` 里。

**价格估算**（美元 / 百万 token，以账单为准；cacheWrite = 5 分钟缓存 1.25× 输入）：

| 模型 | 输入 | 输出 | 缓存读 | 缓存写 |
|---|---|---|---|---|
| claude-opus-5-5 | 4 | 20 | 0.20 | 5 |
| claude-sonnet-5-5 | 2 | 10 | 0.10 | 2.5 |
| claude-haiku-5-5 | 0.10 | 0.50 | 0.01 | 0.125 |
| claude-fable-5-2 | 8 | 40 | 0.20 | 10 |

粗算：一次决策 ≈ 8.4k 缓存前缀 + 0.6～1.5k 观测 + 每轮工具结果；一波 3～5 个决策。缓存命中后每波输入成本主要是观测与思考输出。

---

## 10. 网页里接入模型（给 UI 工作的设计）

### 10.1 托管模型 + 玩家自带 Key（BYO key）
- Key 默认只在内存；勾选"本次会话记住"才放 `sessionStorage`（关标签页即清除），**永不写 localStorage、永不发给我们的服务器**。`createKeyStore()` 已实现。
- Claude：`provider: 'claude-native', browser: true, apiKey` → SDK 以 `dangerouslyAllowBrowser` 构造，会带 `anthropic-dangerous-direct-browser-access: true` 头直连 api.anthropic.com。其他厂商走 pi 的浏览器模式（显式传 `apiKey`）。部分厂商不支持浏览器 CORS（UI 用 `testConnection` 检测，失败则建议桥接器）。
- 警告文案（`BYO_KEY_WARNING`，UI 原样展示）：Key 只在本页内存中、直接发给模型服务商、不经过我们；页面上运行的扩展可能读到它；请使用单独的、设了额度上限的 Key，用完到服务商后台作废。

### 10.2 浏览器直连玩家电脑上的本地模型
`https://jjjj.games` 请求 `http://localhost:PORT` 在 Chrome / Edge / Firefox 中被视为"潜在可信来源"，**不算混合内容**；Chrome 的 Local Network Access 会弹出"允许访问本地网络"提示，玩家必须点允许。**Safari 可能直接拦截**（https 页面访问 http://localhost），Safari 用户请用桥接器。本地服务还必须允许跨域：

**Ollama**（`OLLAMA_ORIGINS`，改完要重启 Ollama）
- macOS：`launchctl setenv OLLAMA_ORIGINS "https://jjjj.games"`，然后退出并重新打开 Ollama 应用。
- Windows：系统设置 → 环境变量 → 新建用户变量 `OLLAMA_ORIGINS = https://jjjj.games`，任务栏退出 Ollama 后重开（或 PowerShell：`setx OLLAMA_ORIGINS "https://jjjj.games"`）。
- Linux（systemd）：
  ```bash
  sudo systemctl edit ollama.service
  # 加入：
  [Service]
  Environment="OLLAMA_ORIGINS=https://jjjj.games"
  sudo systemctl daemon-reload && sudo systemctl restart ollama
  ```
- 临时：`OLLAMA_ORIGINS=https://jjjj.games ollama serve`

**LM Studio**：Developer / Server 页面打开 **Enable CORS**，启动服务器（默认 1234 端口）。

**llama.cpp**：`llama-server -m model.gguf --jinja --port 8080`（新版本默认允许跨域；若前面有反向代理，需要加 `Access-Control-Allow-Origin: https://jjjj.games`）。

**vLLM**：`vllm serve Qwen/Qwen3-8B --enable-auto-tool-choice --tool-call-parser hermes --allowed-origins '["https://jjjj.games"]'`。

### 10.3 手机 / 平板 → 玩家电脑上的模型
https 页面访问 `http://192.168.x.x` 属于混合内容，会被拦截。两种办法：
1. **HTTPS 隧道**：`cloudflared tunnel --url http://localhost:11434`（得到 https 地址）或 `tailscale serve --https=443 localhost:11434`（仅 tailnet 内可见）。隧道必须加鉴权：cloudflared 配 Cloudflare Access，或在前面放一个校验 `Authorization: Bearer <随机 token>` 的反代；游戏里把 token 填在 Key 一栏。**不要把无鉴权的模型端口暴露到公网**。
2. **桥接器 + 隧道**：把桥接器（下节）经同样的隧道暴露（`--allow-lan` 或隧道指向 127.0.0.1:8787），手机连 `wss://…`，仍需配对码。

### 10.4 本机桥接器（推荐给进阶玩家）
```
npm run agent:bridge -- --provider pi --preset ollama --model qwen3:8b
npm run agent:bridge -- --provider claude --model claude-sonnet-5-5 --effort low
（发布后：npx desk-defense-agent bridge …）
```
- 桥接器在 Node 里调用模型（pi 或官方 SDK）：**没有 CORS 问题**，Key 从本机环境变量 / `ant auth` 读取，网页永远拿不到。
- 只监听 `127.0.0.1`（非本机地址要显式 `--allow-lan`）；启动时打印 **6 位一次性配对码**，配对成功后作废并生成新码；校验 `Origin`（默认允许 `https://jjjj.games`、`http://localhost`、`http://127.0.0.1`，`--origin` 追加）；同时只允许 1 个连接；消息上限 4 MB。
- 协议（`src/agent/bridge.ts`）：网页发 `decide`（系统提示、消息、工具定义），桥接器跑模型循环，每个工具调用以 `tool` 消息回到网页执行（世界只在浏览器里），`after` 消息让网页处理实时模式的时间推进，最后 `done` 带用量。网页端：`connectBridge('ws://127.0.0.1:8787', code)`。
- 浏览器访问 `ws://127.0.0.1` 同样受 Local Network Access 提示约束；Safari 一般允许 `ws://localhost`，不行时用 `wss://` 隧道。

### 10.5 运营方代付代理（以后，本期不做）
Pages Functions 代理调用模型、由我们付费：需要登录 + 每人配额 + Turnstile + 全局日预算熔断，否则会被刷成免费的大模型接口；成本与滥用风险高，等有赞助 / 付费方案再议。

### 10.6 小模型建议
- 选支持工具调用的模型：Qwen3 8B / 14B 及以上、Llama 3.1 8B Instruct、Mistral Small 等；7B 以下建议 `toolMode: 'json'`。
- `contextBudget: 'compact'`（不带 4.4k 的资料表）、`waveIntervalSec: 20～30`、`maxToolCallsPerDecision: 6`、暂停模式。
- 本地推理慢：暂停模式下延迟只影响等待时间，不影响结果；实时模式不建议用于本地小模型。

### 10.7 CSP / connect-src
当前站点没有 CSP。以后若加 CSP，`connect-src` 必须允许玩家配置的端点：`https://api.anthropic.com https://api.openai.com https://generativelanguage.googleapis.com https://openrouter.ai https://api.deepseek.com http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*`，以及"自定义" / "中转服务"预设——因为这些地址无法预知，建议 AI 模式放在单独的页面 / 路由下使用宽松的 `connect-src https: http://localhost:* ws://localhost:*`，主游戏页面保持严格。

### 10.8 中转服务（API relay / 代理商，纯前端）
很多玩家手里的是中转站（OpenAI / Anthropic 兼容的 API 代理商）的地址和 Key。设置页的模型服务列表里，"离线演示"之后就是 **中转服务（OpenAI / Anthropic 兼容）**（`preset: 'relay'`，代码在 `src/agent/relay.ts`）。

**设计原则：不做服务器转发。** 请求由玩家的浏览器直接发给他填写的中转地址，我们的服务器不经手 Key 也不经手流量；代价是**中转站必须允许跨域（CORS）**——多数中转站返回 `Access-Control-Allow-Origin: *` 并放行任意请求头，可以直接用；不允许的，诊断会明确说"中转站不允许网页跨域访问"，建议改用本机桥接器（§10.4）。

表单只有四项：
- **服务地址**：任意形式都行——带不带结尾斜杠、带不带 `/v1`、甚至直接粘贴完整端点。`normalizeRelayBase(url, api)` 统一规范化：

  | 玩家填写 | OpenAI 两种接口的 baseUrl | Anthropic Messages 的 baseUrl |
  |---|---|---|
  | `https://relay.example` / `…/` / `…/v1` / `…/v1/` | `https://relay.example/v1` | `https://relay.example` |
  | `…/v1/chat/completions`、`…/v1/responses`、`…/v1/messages`、`…/v1/models` | 同上（端点后缀被去掉） | 同上 |
  | `https://x.com/openai/v1`（带前缀） | `https://x.com/openai/v1` | `https://x.com/openai` |
  | `relay.example`（没写协议） | 按 https 处理 | 按 https 处理 |
  | `https://x.com/api/v3`（非 v1 版本段） | 原样保留 `…/api/v3` | `https://x.com/api` |

  原因：OpenAI SDK 在 baseUrl 后拼 `/chat/completions`、`/responses`，所以 baseUrl 要以 `/v1` 结尾；Anthropic SDK 自己拼 `/v1/messages`，所以 baseUrl **不能**带 `/v1`。
- **API Key**：和其他服务一样默认只在内存（可选 sessionStorage / localStorage），字段下方实时显示"Key 只会发送到 `主机名`"。Key 只发往玩家填写的这个主机（模型列表、探测、对局请求都一样）。
- **接口类型**：`自动检测`（默认）| `OpenAI Chat Completions` | `OpenAI Responses` | `Anthropic Messages`。三种都经 pi 适配器（`provider: 'pi'`），**中转服务不走 Claude 官方 SDK 适配器**；Anthropic Messages 由 pi 用 Anthropic SDK 以 `dangerouslyAllowBrowser` + `anthropic-dangerous-direct-browser-access: true` + `x-api-key` 发出。
- **模型**：可手填；"获取模型列表"调用 `GET {根}/v1/models`（先 Bearer，再试 `x-api-key` + `anthropic-version`），结果按家族（Claude / GPT / Gemini / 其他）分组、可搜索，点选即可。

**自动检测**（`detectRelayApi`）：点"测试连接"，或开始对局时发现这个"地址 + 模型"还没检测过，就按顺序用极小的工具调用请求探测——只有一个 `end_turn` 工具、一句提示、`maxOutputTokens` 很小、SDK 不重试：
1. 模型名像 Claude（含 `claude` / `anthropic`）→ 先试 Anthropic Messages；
2. OpenAI Responses；
3. OpenAI Chat Completions；
4. Anthropic Messages（非 Claude 模型时排最后）。

第一个**真正调用了工具**的接口即为结果，立即停止；界面显示进度（"正在检测接口…（2/3：OpenAI Responses）"）和每种接口的结果，并把结果缓存到不含 Key 的设置里（`per.relay.detected = { api, for: 规范化地址|模型 }`，换地址或模型自动失效）。全部失败时按错误分类给出说明：
- 全是网络错误 → **CORS**：中转站必须允许跨域，我们不做转发；或改用桥接器；
- 401 / 403 → Key 错误 / 过期 / 没额度；
- 404 → 路径不对或中转站不支持这种接口；
- 模型不存在（`model_not_found`、"无可用渠道"等）→ 从模型列表里选；
- 能回复但不调用工具 → 记下这个接口并自动切到 JSON 动作模式。

**为了少踩中转站的兼容坑**，`buildRelayModel` 给三种接口设了保守的 compat：Chat Completions 不发 `store`、不用 `developer` 角色、不发 `strict`、用 `max_tokens`；Responses 不发 `session_id` 头（多一个自定义头就多一分跨域预检被拒的可能）；Messages 不发 `eager_input_streaming`、不用 1 小时缓存。模型价格借用 pi 模型表里同名模型（只用于预算估算，以中转站账单为准）。工具调用与 JSON 动作模式（`toolMode: 'json'`）在三种接口上都可用（`tests/agent/relay.test.ts` 用 mock fetch 覆盖了 responses 的原生工具调用和 JSON 回退）。

---

## 11. MCP 服务模式（外部 Agent 直接当玩家）

```bash
# Claude Code（在项目目录里）
claude mcp add desk-defense -- npx vite-node scripts/mcp-server.ts
# 手动运行
npm run mcp
```

Claude Desktop（`claude_desktop_config.json`，macOS 在 `~/Library/Application Support/Claude/`，Windows 在 `%APPDATA%\Claude\`）：
```json
{
  "mcpServers": {
    "desk-defense": {
      "command": "npx",
      "args": ["vite-node", "scripts/mcp-server.ts"],
      "cwd": "/path/to/desk-defense"
    }
  }
}
```
（部分 Desktop 版本不支持 `cwd`：改为 `"args": ["vite-node", "/path/to/desk-defense/scripts/mcp-server.ts"]`，并确保在该目录装过依赖。）

工具：
- `new_game { mode?, map?, difficulty?, abyss_level?, seed?, skills?, auto_wave?, wave_interval?, max_waves?, agent_name?, include_rules? }` → `session_id` + 规则与资料表（第一局）+ 首个观测
- `observe { session_id, detail? }`
- 全部读取 / 动作工具（同 §6，多一个必填 `session_id`；`end_turn` 由 `advance` 代替）
- `advance { session_id, seconds? }`：不带秒数 = 推进到下一个决策点（最多 10 分钟游戏时间）；带秒数 = 精确推进（≤120）。增益待选、手动模式未开波时会返回"blocked"提示。
- `get_replay { session_id }` → `{ board: 'ai:…', replay }`（`agent: {provider:'mcp', model: agent_name}`）
- `list_sessions`、`end_session`

多局并存（默认最多 8 局）。stdio 传输占用 stdout，日志只写 stderr。

---

## 12. 网页 UI 接入 API（`src/agent/index.ts`）

```ts
import { createAgentController, listModels, testConnection, validateConfig, resolveConfig,
         saveableConfig, PRESETS, CLAUDE_MODELS, createKeyStore, BYO_KEY_WARNING, connectBridge, aiBoardKey } from './agent';

const errs = validateConfig(cfg);                 // 设置面板实时校验（中文）
const models = await listModels(cfg);             // 模型下拉框
const diag = await testConnection(cfg);           // "测试连接"按钮
const ctl = createAgentController({
  config: cfg,                                    // AgentModelConfig（apiKey 来自 createKeyStore().get()）
  session,                                        // src/game/Session 实例
  mode: 'pause',                                  // 或 'realtime'
  onEvent: (ev) => {                              // status | decision | usage | suggestion | error
    if (ev.type === 'usage') hud.setUsage(ev.usage, ev.costUsd);
  },
});
await ctl.start();                                // 动态 import 对应适配器（pi / 官方 SDK / 桥接器）
ctl.pause(); ctl.resume(); ctl.stop();
const rep = ctl.report();                         // { agent, board: 'ai:…', usage, costUsd, decisions, errors, suggestions, replay, config, trace }
ctl.trace.subscribe((ev) => panel.push(ev));      // 思路与请求（§12.1）
```
- 控制器订阅 `session.on()` 事件、每 100 ms 检查决策点（`pollMs: 0` 时由 UI 每帧调 `ctl.poll()`）；暂停模式下决策期间 `session.togglePause(true)`，结束后恢复（玩家自己暂停时不会被恢复）。
- 指令走 `session.command()`，渲染与 UI 事件照常触发。
- **打包（已验证）**：首屏包只多了 `src/ui/ai/launch.ts` 等几 KB 的入口；Agent 逻辑与模型 SDK 全部在 `dist/assets/ai/` 下的动态分包里（`vite.config.ts` 的 `chunkFileNames`），不进 PWA 预缓存，首次进入「AI 参战」时下载、之后由 Service Worker 缓存。构建产物里没有 undici / proxy-agent / @aws-sdk / ws。以下为最初的设计说明：`src/agent/index.ts` 本身只含纯逻辑；`createProvider` 用 `import()` 加载 `providers/claude.ts`、`providers/pi.ts`、`bridge.ts`，Vite 会拆成独立分包，只在玩家开启 AI 模式时下载。UI 工作需要确认构建产物里 pi 的 Node 专用依赖（undici、proxy-agent、bedrock）没有被打进浏览器包（必要时在 vite 配置里给它们设 `external` 或别名到空模块）。
- 结算：带 agent 标记的成绩只能提交到 `aiBoardKey(opts)`（`ai:` 前缀），UI 不得显示"提交到全服排行榜"按钮。

### 12.1 透明度：「思路与请求」面板（`src/agent/trace.ts` + `src/ui/ai/trace-panel.ts`）

观战的人要能在棋盘旁边实时看到 AI 的思路和**全部**请求信息。

**追踪层**（纯 TS，Node / 浏览器通用）：每次决策产生一串与厂商无关的事件，写进内存环形缓冲 `AgentTrace`（默认 ≤ 20000 条、≤ 6M 字符，超出丢最旧；思路 / 文字的流式增量合并存储，订阅者仍收到增量）。

| 事件 | 谁写 | 内容 |
|---|---|---|
| `decision_start` | 引擎 | 触发原因、波次、游戏时间 / 帧号、provider / model、观测（含 ASCII 地图）、系统提示词、工具定义（后三者按哈希去重存 blob） |
| `request` / `request_raw` | 适配器 | 第几次请求、API、模型、主机名、effort、关键参数、请求头（脱敏）、原始请求体（脱敏、≤ 64k 字符；系统提示 / 工具定义以 `$blob:哈希` 占位，复制 / 导出时还原）；pi 的 `onPayload` 拿到真正发出的请求体后用 `request_raw` 替换 |
| `thinking` / `text` | 适配器 | 流式的思路与回复 |
| `tool_call` / `tool_result` | 引擎 | 工具调用 id（模型那边的 tool_use id）、参数；结果 ✓/✗、文本、游戏里实际变化（金币 / 塔数 / 阶段……）、涉及的格子 |
| `response` | 适配器 | stop reason、用量（输入 / 输出 / 缓存读写）、延迟、费用估算、原始响应（脱敏、封顶） |
| `error` / `fallback` | 引擎 | 失败原因（脱敏）、内置机器人接手及其效果、自动开波 / 自动选增益 |
| `decision_end` | 引擎 | 由谁完成、总用时、用量、费用、工具调用数、备忘 |

各适配器：
- **Claude 原生**：`thinking: {type: "adaptive", display: "summarized"}`（当前模型默认 `omitted`，思考文本为空）；客户端支持时用 `messages.stream()`，`thinking_delta` / `text_delta` 边到边显示，`finalMessage()` 取完整消息。被安全过滤加密的思考显示为占位文字。
- **pi**（anthropic-messages / openai-completions / openai-responses / google-generative-ai，含中转服务）：改用 `streamSimple`，`thinking_delta` 覆盖 Anthropic 思考摘要、OpenAI responses 推理摘要、completions 的 `reasoning_content`、Gemini thoughts；JSON 动作模式的请求标为 `json-mode/…`。
- **本机桥接器**：桥接器把它那一侧的 request / thinking / response 经新消息 `B→C trace {id, ev}` 转发（先脱敏，桥接器本机环境变量里的 Key 也登记为必须替换的字符串）；工具调用的 id 随 `tool` 消息带过来。旧版网页忽略这条消息。
- **离线演示 / 内置策略**：合成一条"本机（离线，无网络请求）"的请求，规则策略每一步判断写成一行"思路"，工具调用照常记录——不用 Key 也能演示整个面板。演示军师同理（预演结果写成思路）。

**脱敏**（`src/agent/redact.ts`）：键名像密钥的字段（Authorization、x-api-key、x-goog-api-key、apiKey、access_token、cookie……）整值替换为 `•••`；字符串里的 `sk-ant-…` / `sk-proj-…` / `sk-…` / `AIza…` / `Bearer …` / JWT / URL 里的 `?key=` / `"x-api-key: …"` 一律替换；玩家填的真实 Key 登记到缓冲区，任何位置出现都替换。错误信息同样脱敏。

**面板**：宽横屏（宿主宽 ≥ 960 且宽高比 ≥ 1.25）是棋盘右侧的一栏（可拖动改宽 280–720px、可收成 40px 细边，宽度 / 筛选记在 localStorage）；竖屏手机与紧凑横屏是盖在棋盘上的抽屉（AI 徽标旁的「思路」按钮开关；竖屏盖住棋盘、横屏盖棋盘左侧，塔栏 / 技能 / 开波始终露在外面）。内容：决策时间线（跟随最新）、每张卡片的触发原因、流式思路（蓝色竖线斜体）、回复、工具调用（参数、✓/✗、结果、实际效果；悬停时棋盘上对应格子描品红色圈）、每次请求 / 响应的用量延迟费用；可展开 观察 / 系统提示词 / 工具定义 / 请求头 / 原始请求 JSON / 原始响应 JSON（各带复制，长内容「展开全部」）；筛选（只看思路 / 只看工具 / 显示原始数据）、搜索、合计栏、「导出全部 (JSON)」（Blob 下载链接 + 复制到剪贴板兜底）。底部注明"以上内容只在你的浏览器里，不会上传"。
- **性能**：事件只改数据模型并标脏，DOM 在 `requestAnimationFrame` 里批量更新；面板收起时不碰 DOM；只有最近 30 张卡片展开，更早的折叠成一行（点开再渲染），最多 300 张；长思路只显示末尾 12k 字符；折叠段懒渲染。
- **军师模式**同样显示；**回放**：`ctl.report().trace`（导出格式，封顶约 1.5M 字符，超出先去掉原始请求 / 响应再丢最旧的决策）随结算报告保存在内存里，「观看回放」时在旁边显示，随回放进度逐个展开决策。

---

## 13. 安全与排行榜

- **指令校验**：所有动作经 `World.command()`；工具输入先过 Schema 校验；军师角色根本拿不到动作工具。模型不能读未来（观测里没有随机数种子之外的内部状态，下一波预告与真人看到的一致）。
- **限速**：每次决策工具调用上限、单次决策超时、整局预算、连续失败熔断；MCP 会话数上限；桥接器单连接 + 配对码 + Origin 校验 + 仅本机监听。
- **AI 榜隔离（已实现）**：Agent 回放带 `agent: {provider, model, role}`，榜键 `ai:<无尽榜键>`（每日挑战没有 AI 榜）。
  - 提交仍走 `POST /api/runs`，请求体多一个 `agent: { provider, model, mode, botShare, decisions, tokens?, costUsd? }`（`src/shared/leaderboard.ts` 的 `AgentMeta`）。**标记与榜键必须成对**：带 `agent` 的成绩提交到真人榜 → 拒绝（"AI 对局的成绩只能提交到 AI 榜"）；`ai:` 榜没有 `agent` → 拒绝。真人榜的 `parseBoard` 仍然不认 `ai:`。得分 / 日志 / 限流校验与真人成绩完全相同。
  - 存储：同一张 `runs` 表，`migrations/0002_ai_board.sql` 加了 `agent_provider / agent_model / agent_mode / agent_bot_share / agent_json` 五列（真人成绩为 NULL）。AI 榜的去重键是 `sha256(salt|dev|uuid|ai|provider|model)`：同一设备的**每个模型各保留一条最佳**。
  - 展示：`GET /api/leaderboard?board=ai:normal:auto` 的每行带 `agent: { provider, model, mode, botShare, botAssisted }`；兜底机器人决策占比 > 20%（`AI_BOT_SHARE_FLAG`）标注"机器人代打"，内置策略 `scripted` 的占比恒为 1 并标注"内置策略"。只有"AI 玩家"、且玩家没有中途接管的无尽对局可以提交（军师模式是真人在玩，不进任何在线榜）。
  - 界面：`src/ui/ai/**`（设置表单、对局面板、结算报告、AI 榜表格）、`src/ui/screens/ai.ts`（路由 `ai`）、`src/styles/ai.css`；排行榜页多一个"AI 榜"分页。
- **隐私**：Key 不持久化、不上传；报告与回放里没有 Key（`saveableConfig`）；CLI 从不接受命令行 Key。

---

## 14. 评测场

```bash
# 5 个种子，Sonnet low，对照 medium / expert 机器人
npm run agent:play -- --model claude-sonnet-5-5 --effort low --seeds 5 --seed arena --max-waves 40 --compare medium,expert
# 纯机器人基线
npm run agent:play -- --provider baseline --fallback expert --seeds 5 --seed arena
```
`report.json` 的 `arena` 段给出中位波数 / 得分、总 token、总费用、**每波成本**，以及各对照机器人的中位波数。指标建议：中位波数、≥ medium 的比例、每波美元、平均每决策工具调用数、被拒指令比例、兜底比例。

---

## 15. CLI

```bash
npm run agent:play -- --mode endless --map ch1 --difficulty normal --model claude-opus-5-5 --thinking medium \
  --context balanced --seed X --max-waves 30 --budget-tokens 2000000 --decision pause --provider claude --out scripts/out/agent/run1
```
参数见 `scripts/agent-play.ts` 头部注释（`--provider claude|pi|scripted|baseline`、`--preset`、`--api`、`--base-url`、`--api-key-env`、`--tool-mode`、`--thinking off|low|medium|high|xhigh|max`（`--effort` 为别名）、`--context saver|balanced|full`（省流 / 均衡 / 完整）、`--budget-mode soft|hard`、`--wave-interval`、`--latency`、`--role`、`--fallback`、`--compare`、`--seeds`、`--budget-usd`、`--max-tool-calls`、`--timeout-ms`、`--quiet`）。

报告除原有字段外还有：用量分解（新输入 / 缓存读 / 缓存写 / 输出 / 折算预算）、每波原始与折算 token、请求数与"请求 / 决策"、叫模型 / 门控跳过 / 兜底的决策数、预算分级与压缩次数。离线 token 模型：`npm run agent:tokens`（§17.10）。

输出目录：
- `report.json`：配置（无 Key）、每局结果、每波进度（金币 / 生命 / 漏怪 / 累计 token 与费用 / 决策与兜底次数）、错误、评测汇总
- `replay-<seed>.json`：与 `MidRun` 同形 + `agent` 标记，可直接 `replaySync(createWorld(r.opts), r)` 复现
- `decisions-<seed>.jsonl`：每个决策点的原因、工具调用与结果、用量、耗时
- `report.html`：自包含小报告（结果表 + 每局生命 / token 曲线）

---

## 16. 测试（`tests/agent/`，无网络）

- 观测：字段齐全、地图 15 行 × 15 列、token 上限（开局 / 14 波后期 / full）、系统提示逐字节稳定且不含随局信息。
- 工具：全部 Schema 满足 strict 约束；每个动作工具 → 正确的 Command；`cast_skill` 按目标类型取字段；非法输入（类型 / 枚举 / 缺字段 / 多余字段）与世界拒绝都返回可读错误；读取工具不写日志；军师不能下指令。
- 调度：首个决策点在第 0 帧、`game_start/build/wave_interval/perk` 都会出现、wave_interval 间隔、手动模式等待开波、realtime `elapse`。
- 运行器：脚本策略端到端 ≥10 波、两次运行结果与日志完全一致、回放复现同一 `stateHash`；基线模式；token 预算耗尽转兜底；超时转兜底；连续错误熔断；realtime 下决策间世界前进。
- 适配器：Claude（注入假 client：自适应思考、effort、strict、缓存、服务端回退参数、thinking 块原样回传、并行工具结果同一消息；Haiku 无回退、拒答 → 错误）；pi（faux provider：原生工具循环、TypeBox 转换、JSON 模式、`testConnection`）；桥接器（内存 socket：错误配对码、配对、工具回传、after）；MCP 处理函数（new_game → 动作 → advance → 回放）。
- 思路与请求（`trace.test.ts`）：脱敏（请求头 / 请求体字段 / 多种格式的错误文本 / 已登记的 Key）、JSON 封顶；环形缓冲按条数与字符数封顶、增量合并、blob 去重与导出封顶；脚本策略经引擎的完整事件序列；失败 → error + fallback；pi faux（流式思路、回复、请求 / 响应、工具调用 id、JSON 模式）；Claude 假 client（非流式与流式两种：summarized 思路、tool_use id、每次响应的用量）；桥接器转发（线上传输不含 Key、工具 id 透传）。
- 中转服务（`relay.test.ts`，mock fetch）：`normalizeRelayBase` 的各种地址形式与幂等性；模型列表的 Bearer → x-api-key 回退与 CORS 提示；探测顺序（Claude 先试 Messages）、首个成功即停、错误分类（CORS / 401 / 404 / 模型 / 不调用工具）；经 pi 的 responses（原生工具 + JSON 回退）/ completions / messages 三种请求的 URL、鉴权头与兼容字段。

---

- 上下文与成本（`context.test.ts`）：预算折算；`act` 的顺序执行与逐条结果 / 错误、全部成功自动结束；速查表 < 800 token、精简工具 ≤ 7 且 Schema 严格、MCP 仍有细粒度工具；前缀（system + tools，以及 Claude 请求的 tools / system / cache_control）跨决策、跨对局逐字节相同；门控的跳过 / 不跳过条件与本地开波；增量可逐键还原、地图只在变化时 / 每 N 次发送、RLE 往返；后期观测大小上限；pi 历史压缩与不回传推理、Claude 原样回传 thinking + 服务端 context editing；备忘合并与 300 token 上限；思考等级映射（Claude 各模型的 off、pi 各接口）；预算分级（soft 不交机器人、hard 交机器人、ask 暂停询问与追加、压缩事件）；进攻路线（三张图 × 随机布局 × 空降点的航点还原、与世界路线一致、preview 不改状态、覆盖数值合理）；离线 token 模型（优化后每波折算 < 优化前的 1/3、请求 / 决策 ≈1）；三种模式下脚本策略都能打满 10 波。

---

## 17. 上下文与成本优化

**起因（实测）**：中转 deepseek-flash、5 波 5 个决策：20 次请求（≈4 次 / 决策），共 376k token = 缓存读 215k（57%）+ 新输入 102k（27%）+ 输出 60k（16%，大多是推理）。每次请求固定前缀 ≈7k（规则 1.1k + 资料表 4.4k + 19 个工具 1k+ + 观测 0.3～0.4k）。网页默认预算 1M 按原始总数计，第 12 波左右就耗尽；不少决策只是 `end_turn`。

### 17.1 预算按真实成本折算
`budgetTokens(u) = 新输入 + 输出 + 缓存写×1.25 + 缓存读×0.1`（权重 `BUDGET_WEIGHTS`，`src/agent/types.ts`）。`budget.tokens` 按折算值比较；原始总数仍保留（`usageTotal` / `usageRaw`）。面板、追踪合计、CLI 报告都显示分解：新输入 / 缓存读 / 缓存写 / 输出 / 折算预算。上面的实测换算：376k 原始 = 183.5k 折算。

### 17.2 一次决策一次请求：`act`
`act {actions:[…], end:{plan,maze,priorities,note}}`：按顺序执行，每条一行结果（`1 OK placed pencil #5 at 3,5 …` / `2 REJECTED …` / `3 ERROR …`），末尾一行金币 / 生命 / 阶段 / 路线长度。带 `end` 或"全部成功"即结束本回合；有失败且没写 `end` 时模型可以再发一次 `act` 纠正。提示词要求：读 STATE → 简短计划 → **一次** `act`（含 end）。纯文字回复（没调用工具）直接结束本回合，不再追问（只有因长度被截断时追问一次）。

### 17.3 精简工具与速查表（固定前缀 ≈2.9k，原 ≈8.1k）
| 工具 | 作用 |
|---|---|
| `act` | 批量动作（place / upgrade / branch / evolve / sell / target / cast_skill / tower_ability / collect / choose_perk / reroll_perks / choose_crate / demolish / start_wave / end_turn），`do` 是枚举 |
| `observe` | 完整（非增量）观测 + 地图；`detail:'full'` 加每塔覆盖、价格、路线格、最近敌人 |
| `preview` | 假设的放置 / 拆除（可多处）→ 合法性、每条路线的新航点与长度变化、覆盖得失、防空变化；不改世界 |
| `get_catalog` | `section` 或 `id`（塔 / 敌人 / 技能 / 能力 / 增益 / 事件）——完整资料按需取 |
| `get_tower` | 一座塔的详细信息 |
| `suggest` | 仅军师；发出即结束本回合 |

`system[1]` 换成速查表（≈590 token）：每种塔一行（地图字符、价格、定位、对地 / 对空、Lv1 伤害 / 间隔 / 射程、传奇分支名），每种敌人一行（两字母代号、血量、速度、护甲、飞行 / Boss、克制），技能一行，词缀一行。规则 ≈930 token，工具 ≈1.3k。MCP 同时开放 `act` / `preview` 与原来的细粒度工具。

### 17.4 紧凑观测 v2 与增量
短键：`t ph w g hp sc aw T W E Ef EB nx R Rs Rp Ra sk ev sp pu perk crate own b rc pe`（图例在规则里，只随前缀发一次）。塔一行 `#uid id x,y Llevel [A|B] [★n] [x xp%] [t=mode] [up|br 价] [ev 价] [ab R|cd]`（价格向上取整到 5，减少增量抖动）；敌人按代号聚合 `cr×5 62% 2/2/1 A`；建造价与速查表相同时只写 `"b":"base"`。
- **增量**：每次决策的第一次完整，之后只发变化的键（`STATE Δ`）；塔按 uid 发 `T+`（新增 / 变化的行）与 `T-`（消失的 uid），消失的键在 `_unset`。`applyObsDelta(旧, 增量)` 逐键还原新观测（测试覆盖）。模型调用 `observe` 后以它为新基线；模型出错 / 兜底后下次重发完整。
- **地图**：均衡 / 完整在地形版本（`grid.version`，含放塔）或路线变化时重发，均衡另外每 4 次决策重发一次；省流只在"地形（不含塔）或路线"变化时重发，行用游程编码（`3.` = `...`）。地图不画敌人（敌人在 `E`），路线画成字母 `a b c…`（首行图例 `routes a=north b=west`，重叠 `+`，将要落地的空降路线 `~`）。
- 开局信息（模式 / 地图 / 种子 / 技能）只随完整观测发送（不在前缀里，前缀逐字节稳定）。

### 17.5 进攻路线（`src/agent/routes.ts`）
- **地面路线 `R`**：每个开放出生点（边缘 / 打开的暗门 / 落地的空降箱）沿流场到出口，只留拐点：`north:5,0>5,4>9,4>9,13 L24`（相邻航点之间是 8 方向直线，`expandWaypoints` 逐格还原，与 `world.currentPaths()` 一致）；预警中的空降箱给出"落地后会出现的路线"：`drop-3:… L12 warn 8s`。
- **`Rs` 最长直线段**：`north 5,4>9,4 L5 b7`（b = 段旁可建空格数）；**`Rp` 好位置**：射程 2.5 内覆盖路线格最多的可建空格 `4,5:14`。
- **`Ra` 飞行线**：出生格中心 → 横向最近的出口中心，沿线每 0.25 格采样统计防空覆盖：`north 5.5,0.5>5.5,13.5 L13 aa38% #3,#7`。
- **`nx` 按出生点分组**的下一波：`w7 [air] | north: plane×6 crumb×5 | west: …`。
- **覆盖**：`observe {detail:'full'}` 附 `COVERAGE #3 pencil g14 a3.5`（射程内路线格数 / 飞行线长度）。
- **`preview`**：多处假设放置 + 拆除 → `VALID/INVALID`、逐步结论（第一处在没有拆除时用 `world.canPlace`，与真实放置完全一致；后续按同规则近似：越界 / 非空地 / 有地面敌人 / 堵路 / 困住敌人）、`route north L14→19 (+5) 航点`、`cover+ #3 g+2; new pencil@6,5 g+5 a+4.7`、`cover-`、`air north aa34→70%`。只读：流场用新缓冲区计算，`stateHash` 不变（测试覆盖）。

### 17.6 跨决策记忆（结构化备忘）
`act {end:{plan, maze, priorities, note}}` 合并更新（未给的字段保留），总量 ≤ 300 token（按字段顺序分配余量），每次决策消息里以 `MEMO plan: … | maze: …` 出现。取代"每次先 get_state"的习惯。

### 17.7 决策内历史
- 每次决策仍是新对话（不跨决策累积）。决策内对话超过模式阈值（省流 6k / 均衡 16k / 完整 40k 字符）时：
  - **pi**（completions / responses / google）：最近一轮之前的工具结果压成一行 `[…] 首行 (older result summarized)`；
  - **Anthropic Messages**（Claude 官方适配器 / pi 的 anthropic）：**不改写历史**——保留思考的历史校验要求 system / tools / 先前消息逐字节不变，改写会让后续 thinking 块失效（新账号直接 400）。Claude 官方适配器改用服务端 context editing（`clear_tool_uses_20250919`，beta `context-management-2025-06-27`，按输入 token 触发、保留最近 2 次工具调用），它不算改写。
- **推理内容回传**：thinking / reasoning 块在同一决策内原样回传给 Anthropic（必须，签名绑定）、OpenAI Responses（推理条目与 function_call 绑定）、Google（thoughtSignature）、DeepSeek 思考模式（工具调用轮次需要回传 reasoning_content）；其余 OpenAI 兼容（Qwen / 本机 / 通用中转）去掉思考块不回传（只是白花输入 token）。跨决策从不带。

### 17.8 预算分级（`budget.mode`：soft 默认 / hard / ask）
| 折算用量 | 行为 |
|---|---|
| ≥ 70% | 切换到省流（增量 + 激进门控 + 地图只在变化时 + 输出上限 ≤4096 + 历史阈值 6k） |
| ≥ 90% | 思考降到"低"（玩家原本选"无思考"则保持关闭；实测 deepseek-flash 无思考时打法明显变弱，见 §17.9）、输出上限 6144，波次中的定期检查一律跳过（只在建造阶段 / 事件 / 增益 / Boss / 漏怪时决策） |
| ≥ 100% | soft：最省模式继续（低思考、输出 4096、工具调用 ≤4），面板显示"已超出预算，已切换到最省模式继续"，**不交给机器人**；hard：余下交给内置机器人；ask：暂停游戏并询问（继续（最省模式）/ 追加预算（+500k）/ 交给机器人） |

每次分级上升都会**压缩上下文**：把备忘与最近几次决策的结果压成 ≤300 token 的备忘、清掉增量基线（下次发完整观测），追踪里记一条"上下文已压缩（第 N 次）：≈before → after token"。超时 / 出错 / 连续失败的兜底行为不变。网页默认预算 1,000,000 折算 token、soft；预算条带 70 / 90 刻度与模式标签（均衡 → 省流 → 省流·无思考 → 最省）；设置页"超出预算时：压缩后继续（默认）/ 交给机器人 / 暂停并询问"。控制器 API：`ctl.budget()`、`ctl.budgetPending`、`ctl.resolveBudget('continue'|'extend'|'bot')`，事件 `budget` / `budget_ask`。

### 17.9 上下文模式与思考等级
| 模式 | 观测 | 地图 | 门控 | 波中间隔 | 历史压缩 | 输出上限 | 工具调用上限 | 估算（折算 / 波，思考低） |
|---|---|---|---|---|---|---|---|---|
| 省流 `saver`（本机默认） | 增量 | 地形 / 路线变化，RLE | 激进 | 30 s | 6k 字符 | 4096 | 6 | ≈5.0k |
| 均衡 `balanced`（云端默认） | 增量 | 地形变化 + 每 4 次 | 普通 | 15 s | 16k | 8192 | 8 | ≈5.5k |
| 完整 `full` | 每次完整 | 每次 | 关 | 10 s | 40k | 16000 | 12 | ≈11k |

门控（`src/agent/gating.ts`）：永不跳过开局、增益、补给、事件 / 空降预警、Boss、漏怪、有危险时有就绪技能 / 能力、钱够拆空降箱；普通 = 金币够不上最便宜的有用动作（攻击塔 / 升级 / 分支 / 进化）才跳过；激进 = 另外波次中的定期检查还要求"上次叫模型后新到手的钱 ≥ 最便宜动作"且"手里的钱 ≥ 2×最便宜动作"。跳过的决策点在追踪里记为"跳过（无可行动作）"，手动开波模式下本地自动开波，期间的事件并入下一次决策的 `rc`。

**思考等级**（`config.thinking`：off / low / medium / high，Claude 另有 xhigh / max；`--thinking`，`--effort` 为别名；映射在 `src/agent/thinking.ts`，追踪面板每次请求显示实际生效的设置）：

| 服务 / 接口 | 无思考 off | 低 / 中 / 高（很高 / 最高） |
|---|---|---|
| Claude Opus 5.5（官方 SDK） | 不能关闭 → adaptive + effort low，提示"Opus 5.5 不支持关闭思考，已用最低强度" | adaptive（summarized）+ effort |
| Claude Sonnet 5.5 | `{type:'between_tools'}`（不带其他字段）+ effort low | 同上 |
| Claude Haiku 5.5 | `{type:'disabled'}` + effort low | 同上 |
| Claude Fable 5.2 | 不能关闭 → adaptive + effort low，同样提示 | 同上 |
| pi · openai-completions（DeepSeek / Qwen 格式） | 不传 reasoning → pi 发 `{thinking:{type:'disabled'}}` / `enable_thinking:false` | thinking enabled + reasoning_effort / enable_thinking |
| pi · openai-completions（其他） | 不发 reasoning_effort | reasoning_effort = 等级 |
| pi · openai-responses | 不发 reasoning（非推理模型永远不发） | reasoning.effort |
| pi · anthropic-messages | Claude 5.x：不发 thinking（服务端默认自适应；pi 只认得 4.6 / 4.7 的自适应，对 5.x 会发 budget_tokens → 400），Haiku 5.5 发 disabled；旧模型 disabled | Claude 5.x 同左（提示用官方适配器精细控制）；旧模型按 pi 语义 |
| pi · google | thinkingBudget 0 / 最低 thinkingLevel | thinking 等级 |

缺省：中转 低、本机 无思考、其他 中。预算 ≥90% 时降为 low（原本是 off 则保持 off）。

### 17.10 前缀稳定（缓存）
顺序固定：tools（`SLIM_TOOLS` 固定顺序）→ `system[0]` 规则 + 角色 → `system[1]` 速查表（Claude：`cache_control` 断点 1）→ messages（Claude：顶层自动缓存 = 断点 2，覆盖同一决策内的多轮）。前缀里没有时间 / 种子 / 随局内容（开局信息在 user 消息里）。测试断言：同一局所有决策、以及不同种子的两局之间，`system + tools` 逐字节相同；Claude 假客户端收到的每次请求 `tools / system / tool_choice / cache_control` 相同。注意：Claude 各模型的最小可缓存前缀不同（新模型 512，Opus 4.6 / Haiku 4.5 为 4096）；新前缀 ≈2.9k，在最新模型上可缓存。

### 17.11 离线 token 模型（优化前 / 后）
`npm run agent:tokens -- --waves 15`：用真实的提示词构造器回放一局脚本对局（种子 tok-1、ch1、普通），按实测锚点估算（每次请求输出 ≈3k，思考"低"；服务端自动前缀缓存；旧做法固定 4 次请求 / 决策、第 2 次带一次 get_state）。旧做法的单次请求估算 ≈16.5k，与实测 ≈18.8k 接近。15 波结果：

| 模式（思考低） | 决策点 | 叫模型 | 请求 / 决策 | 前缀 | 消息均值 | 原始 / 波 | **折算 / 波** |
|---|---|---|---|---|---|---|---|
| 优化前 | 45 | 45 | 4 | 8124 | 441 | 196.4k | **54.8k** |
| 完整 | 45 | 45 | 1 | 2881 | 370 | 18.8k | **11.1k** |
| 均衡 | 34 | 22（跳过 12） | 1 | 2881 | 239 | 9.0k | **5.3k** |
| 省流 | 21 | 21 | 1 | 2881 | 186 | 8.5k | **5.0k** |

无思考时：优化前 18.2k → 完整 3.2k / 均衡 1.5k / 省流 1.3k 折算 / 波。按均衡估算，1M 折算预算从 ≈18 波延长到 ≈180 波（思考低）。说明：脚本策略从不出错，所以"请求 / 决策"是理想值 1；真实模型偶尔需要第二次 `act` 纠正，预计 1.1～1.5。决策点更少对"每次只看眼前"的脚本策略有影响（30 波时均衡在 21 波、省流在 25 波失守，完整在 28 波），真实模型靠备忘里的计划弥补；这是省钱与稳健的取舍，可选"完整"。

---

## 18. 开放问题

1. **AI 榜服务端**：表结构、是否需要服务端回放校验（Agent 回放更长、指令更多），按 model 还是 provider 分榜。
2. **进攻方钩子** `overrideWave` 需要批准后再改 core；价格表需要平衡。
3. **跨决策记忆**：已改为结构化备忘（§17.6）；是否还需要"最近 N 个决策的精简结果"待真实模型评测后决定（预算分级压缩时已会带上）。
4. **实时模式的公平性**：固定延迟 vs 实测延迟；AI 榜是否只收暂停模式（建议：AI 榜按模式分榜）。
5. **硬币自动拾取**是否应算作"辅助"并在榜上标注。
6. **兜底机器人的贡献**：兜底比例高的局是否计入 AI 榜（建议：兜底决策 > 20% 不上榜或标注）。
7. **pi 的浏览器打包体积**与 Node 专用依赖处理（UI 工作验证）。
8. ~~观测里是否加入飞行路线~~：已加入（§17.5 `Ra`）。棋盘高亮目前只高亮单个格子，路线航点的高亮留给 UI 以后做。
9. 本地小模型的默认 `toolMode`：先 native 再按 `testConnection` 结果自动降级到 json？
