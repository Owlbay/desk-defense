# 10 · Agent 参战（大模型来玩书桌防线）

> 让大模型（Claude、OpenAI、Gemini、本机的 Ollama / LM Studio……）像玩家一样玩这个游戏：
> 读状态、用工具下指令、在决策点思考。同一套代码跑在 CLI 评测、MCP 服务、本机桥接器和（之后的）网页 AI 模式里。
>
> 状态：已全部实现——核心（`src/agent/`）、CLI、MCP 服务、桥接器、网页 AI 模式（全局 AI 侧栏、思路与请求、操作解读、玩家指令）和测试。

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
- AI 进攻方已实现「出题人」模式（AI 进攻 vs 真人）与「AI 对战」（进攻方模型 vs 防守方模型，§2.3）；独立的 `ai-attack:` 榜未做（这两种局都不参与排行）。

---

## 2. 角色

| 角色 | 能做什么 | 工具 | 实现状态 |
|---|---|---|---|
| **AI 玩家** `player` | 建塔、升级、技能、选增益、开波…… | 读取 + 全部动作 + `end_turn` | ✅ |
| **AI 军师** `advisor` | 只读 + `suggest(text, actions[])` | 读取 + `suggest` + `end_turn` | ✅（无头模式下由兜底机器人代替"真人"执行，用于测试建议质量） |
| **AI 进攻方** `attacker` | 用预算编排下一波敌人 | `attack_plan` + 读取 + `end_turn` | ✅（出题人模式：真人防守；无头模式下由兜底机器人防守） |
| **AI 对战** 进攻方 + 防守方 | 两个模型同局：进攻方改写下一波，防守方按 `player` 防守 | 两边各用自己角色的工具 | ✅（网页「AI 参战」页 → AI 对战；CLI `--attacker`；不参与排行） |

### 2.1 AI 玩家
默认角色。每个决策点拿到观测，调用若干动作工具，以 `end_turn(note)` 收尾。`note`（≤200 字）会在下一次决策时回显给模型，充当跨决策记忆（每次决策都是新对话，见 §7）。

### 2.2 AI 军师
真人在玩时，控制器在决策点（同 §4；建议配置 `role: 'advisor'`、`waveIntervalSec: 20`、`mode: 'realtime'` 以免打断玩家）调用模型；模型只能 `suggest`。UI 把建议显示成卡片，`actions` 是形如 `place_tower pencil 3,5` 的字符串，UI 可解析成同名工具调用做"一键执行"（执行时仍走玩家的 `session.command`）。

### 2.3 AI 进攻方（出题人模式）
- **core 钩子**：`World.command({ type: 'overrideWave', wave, plan: { groups } })`。只在 `build` 阶段、且 `wave = 当前波 + 1`（该波尚未开始）时接受；替换生成器给出的本波条目（`wavegen.overridePlan`，不用随机数），照常写入指令日志 → 同种子 + 指令日志回放完全一致；没有 `overrideWave` 的对局行为与 `stateHash` 不变。开波时取用并清除。`World.attackContext()`（`IWorld` 可选方法）给出下一波的预算 / 出怪池 / 可指定出生点 / 默认组成 / 生命当量上限。`state.nextWave.override = { cost, budget }` 标记被改写的波。
- **价格表与校验**（`src/config/attack.ts`，`checkAttackPlan`，拒绝原因走 `core.reason.attack*`）：
  - 预算 `budget = 40 + 3×波数`（"墨水点"）；单价 = 赏金 × 1.5（向上取整，至少 1）；每个词缀 + 单价 × 0.6；从空降点出来每只 + 单价 × 0.5 + 1。
  - 敌人必须在本波出怪池内（无尽：已登场的敌人；战役：本章到这一波出现过的敌人；均不含 Boss）；最多 6 组、每组 1～60 只、2 个词缀（不含 `golden`，遵守互斥 / notOn）；`delay` 0～30 秒；出生点必须是该波可用的出生点。
  - **飞行敌人不能带词缀**（拒绝原因 `attackAffix`）。
  - 生命当量（基础生命 × 数量，精英 ×2.5）≤ 默认波（非 Boss 部分）的 1.2 倍；Boss 波的 Boss 原样保留、不能编排。
  - **价格平衡**（`npx vite-node scripts/sim-attack.ts -- --seeds 6`：普通难度，内置 medium 防守机器人，无尽 + 三章战役 × 三张图 × 6 个种子；模拟时进攻方只在建造阶段出题，自动波次重叠时会错过一些波 → "覆盖"列；正式对局现已改为上一波一开始就出题，不再错过）。初值 `50 + 10×波数` / 上限 1.5 倍的问题：默认波的生命当量不随波数增长（成长在生成时另乘），预算却线性涨，中后期预算是默认波的 5～8 倍，永远是生命上限先顶住、词缀几乎免费；而多出来的敌人 = 多出来的赏金和经验，堆量 / 堆快敌反而让防守方更强（`fast` +97%、`swarm` +40%）。任何带词缀的飞行敌人则是一招制胜（`airaffix` 无尽第 11 波崩盘、战役 0% 通关）。现值：预算压到 `40 + 3×波数`（≈ 默认波按价买下来的 0.6～1.6 倍，预算成为主要约束），上限 1.2 倍，飞行敌人禁词缀。

    | 策略（每策略 36 局） | 无尽中位波 初值 → 现值 | 无尽均值 Δ 初值 → 现值 | 战役通关率 初值 → 现值 | 战役掉命 初值 → 现值 | 现值：覆盖 / 顶到上限 / 预算用量 |
    |---|---|---|---|---|---|
    | default（不改写） | 48.5 | — | 100% | 3.6 | — |
    | scripted（内置出题；现值 = 新策略） | 47 → 38.5 | +9% → −23% | 100% → 56% | 5.2 → 14.7 | 54% / 13% / 65% |
    | swarm（最便宜的堆满） | 67 → 51 | +40% → +7% | 100% → 100% | 2.6 → 3.7 | 88% / 30% / 90% |
    | tank（每墨水生命最高） | 55.5 → 48 | +16% → +3% | 100% → 100% | 2.2 → 4.1 | 82% / 34% / 72% |
    | fast（最快的堆满） | 100（封顶）→ 51 | +97% → +6% | 100% → 100% | 1.2 → 5.4 | 90% / 5% / 95% |
    | air（全飞行） | 53.5 → 42.5 | +12% → −8% | 94% → 94% | 3.7 → 5.8 | 79% / 6% / 94% |
    | airaffix（飞行 + 护盾 / 再生） | 11.5 → 48.5（被禁，保留默认波） | −74% → 0% | 0% → 100% | 20 → 3.6 | 0% |
    | affix（最肉的敌人 + 两个词缀） | 39 → 41 | −19% → −17% | 61% → 67% | 14.3 → 12.5 | 53% / 12% / 66% |
    | mixed（精英主力 + 便宜填充） | 40.5 → 41 | −16% → −13% | 78% → 67% | 10.9 → 9.7 | 57% / 58% / 80% |
    | stealth（最肉的敌人 + 隐身） | 42 → 42 | −8% → −6% | 89% → 89% | 8.7 → 8.9 | 62% / 18% / 51% |
    | drop（全部从空降点出） | 49 → 49 | 0% → −2% | 100% → 100% | 3.1 → 3.7 | 2%（很少有空降点） |

    结论：现值下没有退化打法能一招制胜（最强的 `affix` 让无尽少撑 ~17%、战役通关率降到 ~2/3），堆量 / 堆快敌不再"送钱"；会用精英的进攻方（`affix` / `mixed`）落在目标区间（−13%～−17%）。旧的 `scriptedAttackPlan`（无词缀主力 + 25% 预算的精英小组）在现值下约等于默认波（−2%）；按模拟结论重写后（地面主力全部带「坚硬 + 再生」精英、防守方对空塔 < 2 时另配无词缀飞行敌人、不用便宜敌人填量、最后用 `checkAttackPlan` 自检）落在 −23%（战役通关率 56%），36 局 0 次被拒。测试 `tests/core/attack.test.ts`「attack balance invariants」钉住：预算 ≈ 默认波的 0.6～1.6 倍、满预算堆血计划被生命上限拦下、`scriptedAttackPlan` 在多种子 / 多波下从不被拒。
  - 指定了出生点的组用 `fixed` 并"钉住"（`SpawnEntry.pinned`），不被空降点分流。
- **Agent 侧**（`src/agent/attack.ts`）：工具 `attack_plan({ groups: [{ enemy, count, affixes?, spawner?, delay? }], note? })`（成功即结束回合，被拒返回原因可改正）+ 读取工具 + `end_turn`（保留默认波）；自己的紧凑观测（预算、出怪池与单价、默认波、可用出生点、防守方的塔 / 对空塔数 / 地面路线长度、最近 5 波的漏怪与掉命 `hist`）与中文系统提示（`systemBlocks('attacker')`）。引擎在下一波开始之前、还没改写时叫模型（上一波一开始就出题，建造 / 战斗 / 选增益阶段都行）；其余决策点本地处理。模型失败时用确定性出题策略补上。
- **离线策略**：`scriptedAttackPlan` / `ScriptedAttackerProvider`（`provider: 'scripted'` + `role: 'attacker'` 时由工厂返回；离线演示在进攻方角色下也自动换成它）：主力 = 地面敌人里"每点墨水生命最高"的，带两个词缀（坚硬 + 再生，不合法时依次换护盾 + 再生 / 迅捷 + 护盾 / 坚硬 + 护盾）；对空塔 < 2 时另配一组无词缀飞行敌人，与主力轮流加量到预算 / 生命上限；一只精英都放不下时才用最便宜的地面敌人；最后用 `checkAttackPlan` 自检（不会被拒）；有空降点且余钱够时让主力从空降点出。只读世界状态，确定性。
- **UI**：对局里的 AI 菜单（I）→「AI 出题」：用同样的开局参数新开一局（对局已开始时需再点一次确认），AI 当进攻方，真人防守。上一波一开始 AI 就在后台给下一波出题，不暂停游戏；题还没出完时手动开波会被挡下（提示「AI 还在给下一波出题」，`Session.holdStart`），自动开波倒计时剩 1 秒时临时暂停，出完再继续。下一波预告里显示「AI 出题 花费/预算」标签（出题前显示「AI 出题中…」）。这种局不上传全服榜（结算的 AI 报告里提示「不参与排行」，只记本地记录；服务端白名单里也没有 `overrideWave`）。
- **设置页入口**：「AI 参战」页的角色卡片有四个：AI 玩家 / AI 军师（AI 防守）、**AI 出题**（同上，从设置页直接开局）、**AI 对战**。`AiSetupSaved.kind = 'defend' | 'attack' | 'duel'`（旧设置按 defend）。
- **AI 对战（双模型）**：
  - 设置页显示两张模型卡片（同一个 `mountAiModelConfigForm` 组件）：「进攻方模型」另存一份设置（`desk-defense.ai.duel-attacker.v1`，Key 仍按来源共用），「防守方模型」就是共用的 AI 设置；两边各自可选离线演示或任意已配置的模型。启动参数 `duelLaunch(defender, attacker)` → `AiLaunch.duel`。
  - **调度**（`src/agent/duel.ts` `createDuelController`，与 `createAgentController` 同形；无头：`runAgentGame(opts, { …, attacker: { config, provider } })`）：两个 `DecisionEngine` 共用一个 `DecisionDetector`、一个世界、一次暂停。每个决策点只暂停一次；下一波可改写、还没问过进攻方时**先让进攻方出题，再让防守方决策**（防守方会开波，顺序不能反）。防守方开波后同一次暂停里进攻方马上给再下一波出题；其余决策点只有防守方。无头运行时调度器的 `interrupt` 在下一波还没出题时立刻交出一个空原因的决策点，只给进攻方。每波只问进攻方一次（选择保留默认波也算问过）。两边都固定为暂停模式。
  - **出题时机**：`overrideWave` 在下一波开始之前任何阶段都接受（建造 / 战斗 / 选增益），所以选完增益马上开波、自动开波时上一波没清完下一波就按计时开始，这两种情况下一波也都已经出好题。防守方引擎仍带 `holdWaveStart`：万一进攻方还没出完，防守方发出的 `startWave` 会被拒绝（原因「进攻方还在为下一波出题」），等下一个决策点再开。
  - **面板**：AI 侧栏标题「AI 对战」，状态页多两行状态（攻 / 守，各自的模型名与正在想的决策原因），决策流里每条记录带「攻 / 守」标签（`DecisionRecord.side`），`attack_plan` 显示为「出题：纸团×8、…」；不显示「给 AI 下指令」。下一波预告照常显示「AI 出题」标记；对局里的 AI 菜单徽标为「AI 对战」。
  - **记录**：`report().agent.role = 'duel'`（防守方的模型标记），`attacker` 是进攻方；回放 `AgentReplay.attacker`。结算报告提示「AI 对战局不参与排行」（`aiUploadPlan` → skip），只记本地记录。
  - **CLI**：`npm run agent:play -- --provider … --attacker scripted|claude|pi|baseline [--attacker-model M --attacker-preset P --attacker-api A --attacker-base-url URL --attacker-api-key-env NAME --attacker-thinking L --attacker-budget-tokens N]`；对照组（`--compare`）的内置机器人也面对同一个进攻方。report.json 每局多一个 `attacker` 汇总（改写波数、token、费用、兜底、错误），decisions-<seed>.jsonl 两边按决策序号合并（带 `side`）。
  - **测试**（`tests/agent/duel.test.ts`）：离线两边无头整局跑完、每波都在开始前被改写、进攻方排在防守方前面；两次运行指令日志相同、回放的 `stateHash` 一致；增益之后的那一波也被改写（自动 / 手动开波）；网页控制器每个决策点只暂停一次、先攻后守。
- **未做**：独立的 `ai-attack:` 榜、AI 对战的实时模式、更强的离线出题策略（见上面价格平衡的结论）。

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
| `src/agent/runner.ts` | `runAgentGame(opts, agent)`（报告里的 `board` = `boardForOpts(opts)`） |
| `src/agent/duel.ts` | `createDuelController`：AI 对战（进攻方 + 防守方两个引擎共用一个调度，§2.3） |
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

### 8.5 按模型的思考档位与价格（模型目录，数据来自 modelinfo.dev）
- 快照：`src/agent/modelinfo.data.json`（约 60 KB，只进 AI 分包），由 `npx vite-node scripts/sync-modelinfo.ts` 从 `https://modelinfo.dev/site/models?lang=en` 生成（`--from 文件` 可用本地保存的返回值）。只留仍可调用（active / preview / deprecated）、支持工具调用的模型；每个模型：`id / name / vendor / context / maxOut / efforts / off / price{in,out,cr,cw}（美元 / 百万 token）/ aliases`。JSON 里带 `note: 数据来自 modelinfo.dev` 与快照日期 `date`，设置页同样标注。
- 查找（`src/agent/modelinfo.ts` `lookupModel`）：精确 id → 服务商模型 id / 别名 → 去掉 `vendor/`、`us.anthropic.` 等前缀、`[1m]`、`@…`、`:free`、日期后缀再试；大小写、`.` / `-` 不敏感。查不到 = 未知模型：界面显示通用档位（Claude 6 档、其他 4 档）与"价格未知，可手动填"，适配器行为与以前完全一样。
- 思考（`thinkingSupport` / `clampThinking`，`thinking.ts` 里统一落档）：设置页只列这个模型支持的档位（能关时带"无思考"；DeepSeek / Qwen / Sonnet 5.5 / Haiku 5.5 由适配器负责关闭），每个模型分别记住（`AiSetupSaved.thinkingByModel`）。配置里的等级不在模型档位里时就近落档（平局取较低档，例如 DeepSeek 没有"中"→"低"），追踪里附提示。OpenAI 兼容接口（completions / responses）按目录档位原样发出（经 pi 的 `thinkingLevelMap`，所以 DeepSeek 的 `max`、GPT 的 `xhigh` 能真正发出去）；目录标明不支持思考的模型不发推理参数；responses 接口的"无思考"在模型可关时显式发 `effort: none`。
- 价格：手填（`config.price`，设置页「高级设置」按模型保存在 `priceByModel`）> 目录价格 > Claude 内置价格表 / pi 模型表 > 0（本机模型）。缓存读 / 写没公布时按输入价计（保守）。


---

## 9. 成本、延迟与可靠性

| 控制 | 默认 | 行为 |
|---|---|---|
| 整局 token 预算 `budget.tokens` | CLI 2,000,000 / 网页 1,000,000 | **折算**：新输入 + 输出 + 缓存写×1.25 + 缓存读×0.1（§17.1）；`budget.mode` 默认 soft = 分级收紧后继续，hard = 用尽交给内置机器人（§17.8） |
| 整局费用预算 `budget.usd` | 无 | 同上（按 §8.5 的模型目录价格估算；目录里没有的模型可手填价格，否则面板显示"价格未知"） |
| 每次决策工具调用上限 | 12 | 超出的调用返回 `ERROR tool-call limit…`，本回合结束 |
| 单次决策超时 | 90 s | 中止请求，本回合由兜底机器人决定 |
| 连续失败熔断 | 3 次 | 停用模型（例如没有凭据、模型不存在），余下全部兜底 |
| 思考等级 `thinking` | Claude 中 / 中转 低 / 本机 无思考 | 见 §17.9 映射表（旧 `effort` 是别名） |
| 单次回复 max_tokens | 按上下文模式：省流 4096 / 均衡 8192 / 完整 16000 | 预算分级时更低（§17.8） |

**兜底机器人**：CLI 用 `scripts/bots` 的 StrategyBot（默认 `medium`，`--fallback expert` 可换）；浏览器默认用脚本策略。决策后还有"推进保证"：增益没选 → 选第一张不需要目标的；补给没选 → 选第一项；手动模式没开波 → 自动开波。这些都记在决策记录的 `fallbackReason` 里。

**价格估算**：所有收录在模型目录（§8.5，数据来自 modelinfo.dev）里的模型都按目录价格估算费用；设置页显示"约 $x / 每波"= 上下文模式的 `estTokensPerWave`（折算 token）按离线 token 模型的构成拆分（约 15% 新输入、75% 输出、原始缓存读 ≈ 折算总数）后乘单价。下表是 Claude 原生适配器的内置兜底价（美元 / 百万 token，以账单为准；cacheWrite = 5 分钟缓存 1.25× 输入）：

| 模型 | 输入 | 输出 | 缓存读 | 缓存写 |
|---|---|---|---|---|
| claude-opus-5-5 | 4 | 20 | 0.20 | 5 |
| claude-sonnet-5-5 | 2 | 10 | 0.10 | 2.5 |
| claude-haiku-5-5 | 0.10 | 0.50 | 0.01 | 0.125 |
| claude-fable-5-2 | 8 | 40 | 0.20 | 10 |

粗算：一次决策 ≈ 8.4k 缓存前缀 + 0.6～1.5k 观测 + 每轮工具结果；一波 3～5 个决策。缓存命中后每波输入成本主要是观测与思考输出。

---

## 10. 网页里接入模型（给 UI 工作的设计）

**设置页的简化**：常显的只有「我的模型」列表 / 思考等级（只说这个模型支持哪些档位）/ 价格 / 决策方式 / token 与费用预算。工具模式不再让玩家选（"测试连接"判断：不会调用工具 → JSON 动作，会 → 原生）；上下文模式也不再让玩家选（一律自动 = 云端均衡、本机省流，预算分级自动收紧；旧设置读取时改回自动）。模型卡片的「高级设置」只剩手填价格；决策卡片的「高级设置」= 超出预算时的处理 + 波次中决策间隔。

**多渠道多模型**（`store.ts AiChannel`、`model-config.ts ensureChannels / useChannel / syncChannel / keyIdOf`）：渠道 = 一个服务（服务商类型 + 地址 + 接口）+ 一把 Key + 若干收藏的模型，可以有多个同类渠道（例如两家中转）。列表存在 `desk-defense.ai.channels.v1`（防守方与 AI 对战的进攻方共用，不含 Key）；Key 按渠道 id 存（`desk-defense.ai.key.<id>`）。设置页顶部「我的模型」：离线演示 + 按渠道分组的模型，输入框按渠道名 / 模型名筛选，点一下即切换渠道与模型；「＋ 添加渠道」新建；每组可删除渠道（连同 Key），每个模型可移出列表。下面折叠的「渠道设置 · 名称」就是原来的服务 / 地址 / Key / 模型 / 测试连接编辑器，新建或有错误时自动展开；在里面填过或从列表选过的模型自动收藏到该渠道。旧设置（每种服务一份）第一次打开时迁移成渠道，id = 服务名，旧 Key 原样可用。设置里的当前渠道记在 `st.channel`，`st.per[source]` 仍是编辑缓冲区（下游 buildModelConfig 不变，只是 Key 改按 keyIdOf 读）。

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
站点通过 `public/_headers`（Cloudflare Pages 响应头，作用于 `/*`：游戏页、介绍页、404 与 `sw.js`）下发 CSP，不用 `<meta>`（meta 不支持 `frame-ancestors` / 报告，且本地 dev 的 Vite HMR 需要内联样式与 ws，放在响应头里只影响线上）：

```
default-src 'self'; script-src 'self' 'sha256-…(about.html 主题脚本)'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:;
connect-src 'self' https: http: ws: wss:; worker-src 'self' blob:; manifest-src 'self';
object-src 'none'; base-uri 'self'; form-action 'self'
```

- **脚本**最严：只许本站文件；介绍页唯一一段内联脚本（套主题，避免闪烁）用哈希放行，JSON-LD 不是可执行脚本不受限。改了 `about.html` 的内联脚本要同步改哈希——`tests/csp.test.ts` 会逐页计算内联脚本的 sha256 并校验。无 `unsafe-eval`（构建产物与 Phaser 都不需要）。
- **样式**允许内联：界面代码用 `style` 属性 / 内联 SVG（`h(..., { style })`、图标 `innerHTML`），404 页有 `<style>`。不用外部字体（系统字体栈），所以没有放行 Google Fonts。
- **图片** `data:` / `blob:`：Phaser 的默认纹理是 data URI，图片加载走 blob URL。
- **connect-src 放宽到 `https: http: ws: wss:`**：玩家可以填任意厂商 / 中转服务（https）、本机模型（`http://localhost:*`）、局域网电脑（`http://192.168.x.x:*`）、本机桥接器（`ws://127.0.0.1:8787`），这些地址无法预知，只列白名单会让"自定义"预设失效；本站 `/api` 由 `'self'` 覆盖。真正的防线是脚本只能来自本站（注入的脚本跑不起来，也就无从外发）。
- **worker** `'self'`：PWA 的 `sw.js` + `workbox-*.js`（同源 importScripts）；`blob:` 留给以后的 Worker。
- 没有设 `frame-ancestors`：保留被游戏门户嵌入的可能；需要时再加。
- 本地核验方式：`vite build` 后用 `vite preview` 配 `preview.headers` 注入同一条 CSP（读 `_headers`），开局、菜单、介绍页、AI 面板均无违规；实测局域网 http / localhost / 未知 https / `ws://127.0.0.1:8787` 只报网络错误、无 `connect-src` 违规，动态插入的内联脚本被拦（CSP 生效）。注意 Cloudflare 的 Rocket Loader / 邮件混淆等会注入内联脚本，需保持关闭。

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
         saveableConfig, PRESETS, CLAUDE_MODELS, createKeyStore, BYO_KEY_WARNING, connectBridge } from './agent';

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
- 结算：带 agent 标记的成绩进**同一张**全服榜（2026-11 起，见第 12 章 §4.1），榜上带「AI 辅助」+ 模型名。运行报告里的榜键直接用 `boardForOpts(opts)`（src/shared/leaderboard.ts）；服务端 `normalizeBoardKey` 仍会把旧的 `ai:<榜键>` 归一到新榜。

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
- **AI 榜隔离（已取消，2026-11 起并入普通榜，见第 12 章 §3.1 / §4.1；下面是历史设计）**：Agent 回放带 `agent: {provider, model, role}`，榜键 `ai:<无尽榜键>`（每日挑战没有 AI 榜）。
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

### 14.1 批量对局（多渠道多模型 + 上传）

`npm run agent:batch -- --config my-batch.json`（`scripts/agent-batch.ts`，示例 `scripts/agent-batch.example.json`）：配置里列多个渠道（`preset` = relay / claude / openai / deepseek / ollama …，`baseUrl` 或 `baseUrlEnv`，`keyEnv`），每个渠道挂多个模型（可单独指定 `thinking`）；`games` 给出模式 / 地图 / 难度 / 种子 / 封顶波数，每个模型打同样的局；`concurrency` 控制并行。配置文件里出现 `apiKey` / `key` / `token` 字段直接报错——Key 只从环境变量读，配置可以放心分享。

- 输出：`summary.md`（与 agent:eval 同一张表，按「渠道/模型」分行）、`eval.html`、`batch.json`，每局 `decisions-*.jsonl` 与 `replay-*.json`（含上传用的 `batch` 字段）。
- 上传（`--upload` 或 `upload.enabled`）：只传无尽模式；上传前先用 `verifyRun` 在本地跑一遍服务端同款校验，声明结果取自重放，不通过的不传；遇到限流（每 IP 每 10 分钟 10 次）按 `retryAfter` 自动等待重试。每个模型一个固定设备 id（`uuidFrom(昵称模板|模型)`），榜上每个模型各占一行只留最佳；昵称模板 `{model}` 超过 12 字时保留模型名末尾（`~v4-flash`）。AI 标记与界面同口径（provider = llm、模型名、思考档位、兜底占比、token、费用）。
- `--upload-from DIR`：不重打，只把 DIR 里跑好的结果传上去；`--dry`：只列出要打的局。
- `--continue-from DIR [--max-waves N]`：DIR 里被封顶波数截停（outcome = cap）的局，从存档接着打到输为止（`runAgentGame` 的 `resume`：先把存档指令原样重放到存档帧，再交给模型；最终回放 = 存档指令 + 新指令，是一整局，可照常上传校验）。续打部分的 token / 决策单独统计，波数 / 生命是整局的；模型的备忘不延续。

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

- 打法辅助（`planner.test.ts`，§19）：迷宫意图只发合法指令、路线变长、同种子结果一致且可回放；funnel；build_near 的塔在射程内且不占规划路线；upgrade_best / spend（花到保留额）/ anti_air（飞行线覆盖上升）；三张图 × 随机意图序列 × 跑波次（含地形事件）永不堵路；save 抑制闲置提醒；act 里的意图与逐条结果、assist 关闭时拒绝意图；被拒放置自动挪位（墙不挪）；买不起的失败直接结束回合；Schema / 规则（< 1200 token、前缀稳定、军师不含意图）；战报（漏怪按敌人 @ 出生点、伤害、0 伤害塔、每份只发一次）；威胁估算（无塔 = 危险、加塔后安全、空军只算飞行线、建议 anti_air / 克制）；引擎每次决策附 BR / TH / NEXT（其余行不带「→ 建议」）、assist 关闭时没有；NEXT 清单（`advice.test.ts`：排序、最多 4 步、spend 在最后、可被 parseNext 原样解析）；脚本意图版确定性且强于旧脚本；评测场（脚本矩阵 + 机器人对照、表格 / JSON / HTML）。
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
> §19.12 起观测里的 `R` / `Ra` 与 `nx` 的按出生点列表合并成一个 `AR` 键（每条路线 + 下一波走它的组 + 无覆盖路段）；下面的 `R` / `Ra` 格式仍用于 `observe {detail:'full'}` 的 ROUTES 行与 `preview`。

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

### 17.12 术语表与词语精简（第三轮，配合 §19.11）
固定前缀重排为四段：**规则与无尽成长 → 打法手册 → 每次决策 → 术语表（Glossary）**。术语表逐个解释观测短键（`T` 的 `x25|50|75`、`up|br|ev`、`E` 的 `eN/hN`、`Ef dN`、`nx early+Ng`、`Rs bN`、`Ra aa%`、`rc` 的 `kN +Ng wN clear iN #uid→Llv`）和附加行（`BR TH CTR LK GAPn KH RC CB MZ IDLE EVT` 的每个字段、`TH` 阈值 安全 ≥2 / 吃紧 ≥1.2 / 危险 <1.2、`KH` 的 `f/m/l` 与 `LATE`、`LK` 的 `gap0/gap1`、`e.` 精英、`^` 飞行）。省出的地方：
- 速查表：塔行去掉中文定位与传奇分支名（`get_catalog` 可取），换成"什么时候用"的短说明，原来单独的 `Use:` 行并入；台灯 / 事件说明删重复。速查表 1207 → 962 token。
- 观测：`LK / GAP / KH` 改用敌人代号与短键（`LK w7 n4: cr×3(hp40 in35 north x5 y9..12 gap0 top#4pencil70)`、`GAP5 …`、`KH 22 f/m/l 20/55/25 hot x3-5 y6-8 41 LATE`），不再是整句中文；塔行经验进度按 25% 分档、升级 / 进化价 <100 取整到 5、<500 到 10、其余到 25（显示价 ≥ 实价），后期 `T+` 不再因为经验每秒变化整表重发。脚本对局（种子 e1，≈120 次决策）每次决策消息均值 529 → 452 token（−15%）。
- 工具描述略缩（1788 → 1779）。

前缀合计（规则 + 速查表 + 玩家工具，`estimateTokens`）：4281 → 4409（+3%；规则 1286 → 1668，多出来的是打法手册与术语表）；§19.12 加了 AR 图例、合并意图后为 **4513**（+5.4%）。观测里 `R` / `Ra` 与 `nx` 的出生点列表由 `AR` 取代（§19.12）。仍逐字节稳定（测试断言不变）；`tokenRun` 测试的"前缀 < 优化前的一半"放宽为 < 55%。

---

## 18. 开放问题

1. ~~**AI 榜服务端**~~：已定（docs/12 §3 / §4.1 / §5.2）。不单独分榜：AI 辅助成绩进同一张榜（无尽 / 每日 / 战役），带「AI 辅助」+ 模型标记，可一键隐藏；表结构见迁移 0002 / 0003。服务端回放校验已实现（`src/shared/replay-verify.ts`，指令一律经 `World.command()` 重放，`overrideWave` 等新指令自动支持；Agent 局与真人局同一套），默认关闭：线上 `POST /api/admin/verify` 需要 Workers 付费计划 + `REPLAY_VERIFY=1` + `ADMIN_TOKEN`，免费计划可用离线脚本 `scripts/verify-runs.ts`。
2. **进攻方**：`overrideWave` 钩子、`attack_plan`、出题人模式已实现（§2.3）；价格表（单价系数 1.5、词缀 0.6、空降 0.5+1、生命上限 1.5×）是初值，需要实测平衡；双模型对抗与 `ai-attack:` 榜待定。
3. **跨决策记忆**：已改为结构化备忘（§17.6）；是否还需要"最近 N 个决策的精简结果"待真实模型评测后决定（预算分级压缩时已会带上）。
4. **实时模式的公平性**：固定延迟 vs 实测延迟；AI 榜是否只收暂停模式（建议：AI 榜按模式分榜）。
5. ~~**硬币自动拾取**是否应算作"辅助"~~：**不算**。它是便利设置，不替玩家做任何决策（只省去点击），所以不上报、不标注、不影响排名（docs/12 §4.1）。
6. ~~**兜底机器人的贡献**~~：**照常上榜，只标注**。兜底决策占比随成绩上传（AI 参战：`agent.botShare`；中途接管：`aiAssist.botShare`），服务端存 `agent_bot_share`；> 20%（`AI_BOT_SHARE_FLAG`）时 `LeaderRow.botHeavy`，榜上与 AI 结算卡片显示「兜底多」；内置策略 scripted 不标（docs/12 §4.1）。对局中途开关的「让 AI 替我玩」暂不上报占比。
7. **pi 的浏览器打包体积**与 Node 专用依赖处理（UI 工作验证）。
8. ~~观测里是否加入飞行路线~~：已加入（§17.5 `Ra`）。~~路线航点高亮~~：已做——操作解读里悬停 / 聚焦涉及路线的意图（`maze` / `rebuild_maze` 全部路线或 `route`、`anti_air` 飞行线、`target`/`near` 的 `route:<id>` / `air` / `airline:<id>`）或施法 / 拆除某出生点的操作，写 `UiStore.routeFocus`（出生点 id + 是否画飞行线），棋盘按当前流场画整条折线 + 起点 / 拐点 / 终点航点（品红，与单格高亮同色）；玩家悬停出生点格或选中空降纸箱时也画该路线（主题色：浅色桌面墨蓝、深色桌面浅蓝）。render 只读 UiStore 与世界状态，不依赖 agent。
9. 本地小模型的默认 `toolMode`：先 native 再按 `testConnection` 结果自动降级到 json？

---

## 19. 打法优化与评测

§17 解决了"花多少 token"，这一节解决"打得好不好"。原则：**模型定策略，确定性规划器挑格子**；所有改动仍然只经 `World.command()`。实现：`src/agent/planner.ts`（意图规划器）、`src/agent/battle.ts`（战报 / 威胁估算 / 提示）、`src/agent/maze.ts`（迷宫规划，原 `scripts/bots/maze.ts`，机器人与规划器共用）、`scripts/agent-eval.ts` + `scripts/eval-lib.ts`（评测场）。配置开关 `assist`（缺省开；`false` = 旧版提示词 / 旧版 `act`，评测基线用；CLI `--assist off`）。

### 19.1 基线日志里的失败模式（中转 deepseek-flash，ch1 普通，6～8 波）
1. **不会造迷宫**：模型手放零散的墙，`preview` 一连 4～8 次（`route L14→14 (+0)`），8 波后路线仍只有 14～16 格（机器人 40～80 格）；有一次决策 8 次 `preview`、0 个动作。
2. **攒钱不花**：波末金币 130～185、只有 5～14 座塔（opt-budget 8 波一直 5 座塔、波末 75～119 金币）；利息只有 5%（封顶 20）。
3. **被拒动作**：`这里不能建造`（把障碍 / 出口格当空地）、`金币不足`（一批动作里算错钱，连着 2～3 条被拒）、`有敌人在这里`、`已经有塔了`；每次被拒都要再发一次请求纠正。
4. **无思考（off）时很弱**：开局把 150 金币全存着、0 座塔开第 1 波 → 漏 9 个；6 波掉 14 条命，2.7 次请求 / 决策，5 次被拒。
5. **塔够不着路线**：路线被墙改走后早先的塔留在原地（模型自己在备忘里写"col4 pencils out of range"），却没有人告诉它哪座塔一直 0 输出。
6. **防空太晚**：空军波前没有覆盖飞行线，纸飞机漏怪。
7. **请求 / 决策 1.7～2.7**：主要是 `preview` 循环与纠正被拒动作。

### 19.2 决策信息（一次性附在决策消息里，不进增量基线）
| 行 | 内容 | 何时 |
|---|---|---|
| `BR w5: LEAK 3 ik×2@north pl(air)×1@west \| kills 22 \| dmg #4ruler:820 #1pencil:310 … \| 0dmg #9 (out of reach?) \| idle@build 35g \| rejected 1: …` | 上次汇报以来清掉的波：漏怪（敌人 × 数量 @ 出生点，按开波前的预告归属）、击杀、每座塔造成的伤害（前 4 + 放了 10 秒以上仍 0 伤害的塔）、建造阶段剩余金币、被拒动作 | 每波结束后的下一次模型决策 |
| `TH w7: north 安全 ×3.1 (cr×10 hp245) \| air:north 危险 ×0.4 (pl×6 hp130) → {do:"anti_air",line:"north"}` | 下一波每条地面路线 / 飞行线：`cap = Σ 塔秒伤 × 护甲折减 × 群伤 1.5 × 有效时间`，有效时间 = `Σ组 min(n × 射程内格数 / 速度, 出怪跨度 + 射程内格数 / 速度)`；`ratio = cap / 来袭总血量`（含护盾、精英、难度成长）；≥2 安全、≥1.2 吃紧、否则危险，并给出建议意图 | 建造阶段，或下一波预告变了 |
| `CTR pc→lamp/eraser (armor); pl→AA: pencil/swatter/ruler` | 下一波敌人的克制（与速查表同一规则） | 同 TH |
| `IDLE 150g unspent (interest only +7/wave): …` | 建造阶段金币 ≥ 60 且没有 `save` 目标时提醒花钱 | 建造阶段 |

### 19.3 `act` 里的高层意图（`do` 枚举新增 6 种，旧的低层动作照旧）
> §19.12 起合并为 6 个：spend / maze(rebuild) / build_near(tower|purpose|pair) / upgrade_best / save / reclaim；anti_air / combo / support / economy / rebuild_maze 作为别名照收。

| 意图 | 字段 | 规划器做什么 |
|---|---|---|
| `maze` | `style` serpentine（缺省）/ funnel，`budget` | serpentine：按 `planMaze` 的蛇形挡板逐格放墙（与高手机器人同一规划；被拒的格子跳过并统计原因）；funnel：贪心放"让路线变长最多"的单格墙（用 `previewPath`，与真实放置同规则）。结果：墙数、花费、路线长度变化、规划完成度与剩余墙钱 |
| `build_near` | `tower`，`target` route / route:<出生点> / early / exit / air / airline:<出生点> / chokepoint，`count` | 候选 = 规划的迷宫格（空格或可替换的 Lv1 墙，塔同时是迷宫墙）+ 规划外的空格（不在当前 / 规划建成后的路线上 ⇒ 永远不会堵住规划）。规划格按"下一道挡板建成后的路线"与"现在的路线"各半打分；规划外的格按"迷宫建完后的路线"打分（避免迷宫一建完就够不着）。打分 = 射程覆盖 × 组合技加成；计算器看周围主力、存钱罐放最没用的格 |
| `upgrade_best` | `count`，`metric` dps（每金币收益，缺省）/ coverage，`budget` | 与机器人同口径的升级价值；Lv9 自动选分支（`DEFAULT_BRANCH`），Lv10 算进化 |
| `anti_air` | `route`（飞行线出生点，缺省最弱的一条），`count` | 苍蝇拍（买不起则铅笔）放在那条飞行线覆盖最多的位置 |
| `spend` | `reserve`，`focus` balanced / towers / upgrades / maze | 高手机器人的花钱循环：空军波前补最弱飞行线 → 墙的投入 ≤ 塔投入 × 50% + 25 → 轮换表买塔（开局 4 支铅笔）与"升级最值的"按每金币收益比较；下一波有路线"危险"或已漏怪时不为贵塔攒钱、先买铅笔。结果合并成一行 |
| `save` | `until` | 记下存钱目标（两波内有效），期间不发 IDLE 提醒 |

- **被拒放置自动挪位**：低层 `place`（非墙）因 `有敌人在这里 / 这里不能建造 / 已经有塔了 / 会堵死道路 / 会困住敌人` 被拒时，规划器在 2 格内找覆盖最好的可放空格（不在当前 / 规划路线上）重放，结果行 `MOVED 3,6 (已经有塔了) → OK placed …`。墙不挪（墙的位置就是意图）。
- **少一次纠正请求**：只剩"这回合修不好"的失败（金币不足、冷却中、没有充能、没东西可捡、位置错且也买不起）时直接结束回合。
- **realtime 排队**：规划器把已排队的放置记为占用、金币先扣，后续候选不会重复；落地时仍由 `World.command` 校验。
- 规则 / 速查表 / 工具仍逐字节稳定；`assist` 只换规则块（打法要点 + 开局 + 一个示例 act）和 `act` 的 Schema。前缀 ≈1190 + 593 + 1600 token（旧 ≈950 + 593 + 1340）。

### 19.4 提示词（`RULES`，仍 < 1200 token）
> §19.11 起改为「规则与无尽成长 / 打法手册 / 每次决策 / 术语表」四段（≈1.67k token），下面是第一轮的要点。

打法要点：早造迷宫（`maze`；手放的零散墙很少能拉长路线）· 让金币干活（建造阶段结束 ≲30 金币，除非 `save`）· 1～6 波买塔、之后加 `upgrade_best` · 空军波前每条飞行线要有对空（`anti_air`）· 克制 · 技能用在漏怪 / Boss / 逼近出口 · 读 TH / BR · 多入口用 chokepoint。开局：`[{do:"spend",reserve:0}]`；每个建造阶段：有空军则 `anti_air`、`maze`、`spend`，约第 6 波起加 `upgrade_best`。一个示例 act。

### 19.5 评测场
```bash
# 离线（脚本策略：旧版 v1 vs 意图版），对照 medium / expert 机器人
npm run agent:eval -- --seeds relay1,relay4,relay5 --maps ch1,ch2,ch3 --difficulties hard,nightmare --max-waves 15
# 中转（Key 只从环境变量读：RELAY_KEY / RELAY_BASE / RELAY_MODEL）
npm run agent:eval -- --provider relay --variants "base:assist=off,thinking=low;assist:assist=on,thinking=low;assist-off:assist=on,thinking=off" \
  --seeds relay1,relay4,relay5 --maps ch1 --difficulties normal --max-waves 8 --bots medium,expert --concurrency 4 --out scripts/out/eval/relay
```
输出 stdout 汇总表、`eval.json`、`eval.html`、`eval.md` 与每局 `decisions-*.jsonl`。指标：波数 / 剩余生命（固定波数封顶）/ 漏怪 / 得分、建造阶段决策后剩余金币（idle g）、塔 / 墙数、路线长度、每清一波的原始 / 折算 token、请求 / 决策、被拒动作、自动挪位、兜底。

### 19.6 实测
中转 deepseek-flash（OpenAI 兼容，思考"低"，均衡上下文），固定种子，无尽 8 波封顶；`base` = `assist:false`（旧提示词 / 旧 act），`assist` = 本节全部改动，`assist-off` = assist + 无思考。idle g = 建造阶段开波前（无开波则决策后）剩余金币均值。

**ch1 普通 · 种子 relay1 / relay4 / relay5**
| 变体 | 剩余生命 | 漏怪 | 得分 | idle g | 塔 / 墙 | 路线 | 原始 / 波 | 折算 / 波 | 请求 / 决策 | 被拒 |
|---|---|---|---|---|---|---|---|---|---|---|
| base（思考低） | 15.3/20（77%） | 14 | 1701 | 22 | 10 / 12 | 19 | 23.8k | 14.7k | 1.91 | 2 |
| **assist（思考低）** | **20/20（100%）** | **0** | **1938** | **9** | 12 / 30 | 41 | **7.4k** | **4.9k** | **1.06** | 0 |
| **assist-off（无思考）** | **20/20（100%）** | **0** | 1899 | 16 | 10 / 31 | 41 | 7.2k | 4.0k | 1.00 | 3（3 次自动挪位） |
| base-off（无思考，上一轮） | 12.7/20（63%） | 22 | 1526 | 62* | 11 / 9 | 17 | 14.6k | 4.9k | 2.19 | 24 |
| 机器人 medium | 19/20（95%） | 3 | 1849 | 24 | 12 / 25 | 41 | – | – | – | – |
| 机器人 expert | 20/20 | 0 | 1939 | 18 | 14 / 51 | 67 | – | – | – | – |

**ch2 困难（两个入口）· 种子 relay1 / relay4**
| 变体 | 剩余生命 | 漏怪 | 得分 | idle g | 塔 / 墙 | 路线 | 原始 / 波 | 折算 / 波 | 请求 / 决策 |
|---|---|---|---|---|---|---|---|---|---|
| base（思考低） | 8/15（53%） | 14 | 2125 | 24 | 12 / 0 | 16 | 15.7k | 9.0k | 1.71 |
| **assist（思考低）** | **15/15（100%）** | **0** | **2594** | 16 | 15 / 16 | 29 | 9.0k | 5.8k | 1.08 |
| 机器人 medium | 15/15 | 0 | 2505 | 19 | 12 / 26 | 48 | – | – | – |
| 机器人 expert | 15/15 | 0 | 2590 | 25 | 16 / 44 | 66 | – | – | – |

\* base-off 来自第一轮（idle 口径含提前开波奖励，偏高）；同一轮里 base 为 34、assist 21、assist-off 16。

离线（脚本策略，`--maps ch1,ch2,ch3 --difficulties hard,nightmare`，5 个种子 × 15 波 = 30 局）：旧脚本 v1 失守 24 局、剩余生命 11%；**意图版 0 失守、92%**；medium 2 失守、82%；expert 0 失守、99%。

结论：
- 打法：assist 在全部 8 局真实对局里 0 漏怪，≥ medium（ch1 medium 漏 3），与 expert 持平；无思考 + 意图也 0 漏怪（旧版无思考掉 37% 生命）——**意图让"无思考"可用**。
- 闲置金币 22 → 9（−59%）；被拒动作接近 0（剩下的都被自动挪位或属于"这回合修不好"）；请求 / 决策 1.9 → 1.06。
- token：每波原始 23.8k → 7.4k（−69%）、折算 14.7k → 4.9k（−67%）。固定前缀变大（规则 +240、工具 +260 token），但旧版每次决策要 2 次请求、还会 `preview` 循环，新版几乎 1 次请求就结束；离线 token 模型（`npm run agent:tokens`，脚本策略只按 1 次请求计）均衡模式每波原始 9.0k → 9.8k（+9%）、折算 5.3k → 5.6k（+5%）。
- 规划器建的迷宫比 expert 短（41 vs 67 格）：模型常给 `maze` 设预算、塔多墙少；目前生命已满，没有再调。

### 19.7 试过但没用 / 改掉的
- **规划外的格子按"近期路线"打分**：塔放在第一道挡板建成后的路线旁，第二道挡板一建路线就绕走，战报里一串 `0dmg`。改为：先用规划的迷宫格，规划外的格按"迷宫建完后的路线"打分。
- **规划器最初的买塔顺序**（第 4 座就买胶水、第 6 座台灯，墙占塔投入 40%、2 座塔就开始造墙，危急时也为贵塔攒钱）：脚本评测里 nightmare 失守 1 局、漏 20。改成高手机器人的开局（4 支铅笔）、墙 50%、3 座塔后造墙、危急时先买铅笔 → 0 失守、0 漏怪（ch1/ch2 × 普通 / 噩梦 × 3 种子）。
- **规划格只按"下一道挡板建成后"的路线打分**（机器人的口径）：迷宫没跟着建时塔这一波就打不到。改为与"现在的路线"各半；脚本评测剩余生命 94% → 92%（噪声级），换来 0 失守，保留。
- **闲置金币口径**：起初按"决策结束时"的金币算，提前开波的奖励（+20～30）也被算成闲置；改为开波前一刻的金币（第二轮起）。
- 没有为规划器加"每次 act 前自动 spend"：那等于机器人代打，模型就不再做决定；只在 IDLE 提醒里给出建议意图。


### 19.8 战场情报、回收与塔的多样性（第二轮）
主人看 AI 打的三点反馈：①"每一次进去的怪也应该展示给 agent"；②早期造了很多墙，后期没地方放塔，却从不拆墙；③很多塔从来不用（不会用组合技）。另外一张截图：AI 只造了 4 道横挡板、无视地图上的障碍物、下三分之一空着、攻击塔全挤在入口一排。

**战场情报（`src/agent/intel.ts`，每个世界事件喂一次：无头 runner 的 `sched.onEvent`、浏览器 `session.on` → `engine.onWorldEvent`）**
- 每 0.2 游戏秒采样场上敌人：出生点（首次出现时最近的出生格）、精英词缀、飞行 / 被网、按顺序走过的格子与每格同时够得着它的塔数、射程内时间 / 总时间；塔的累计伤害增量按当时射程内的敌人平分 → 每只敌人的"主伤塔 + 份额"。
- `leak` 事件与"刚消失、同种、离出口最近"的跟踪记录配对 → 漏怪记录（剩余血量、射程内占比、主伤塔、**缺口** = 走过的格里最长的无覆盖段 ≥2 格，没有则最长的"仅 1 塔"段 ≥3 格）。`death` 事件 → 击杀位置。波末快照每座塔的累计伤害 → 最近 2 波零伤害的塔。

| 行 | 例子 | 何时 |
|---|---|---|
| `LK` 漏怪明细 | `LK w7 n4: cr×3(hp40 in35 north x5 y9..12 gap0 top#4pencil70) e.pc[hard]×1(…)`（§19.11 起用敌人代号与短键：hp 剩余血量 %、in 射程内时间 %、gap0 无覆盖 / gap1 仅 1 塔、top 主伤塔与份额 %、`e.` 精英、`^` 飞行） | 有新漏怪的下一次模型决策（波中也发）；同种 / 同精英 / 同出生点合并，最多 4 组（`+N`） |
| `GAP` 缺口热点 | `GAP5 north x5 y9..12 gap0 ×6, air:north y2..9 gap1 ×2 → {do:"build_near",purpose:"dps",target:"seg:5,9-5,12"} {do:"anti_air",route:"north"}` | 同上；最近 5 波、重叠的缺口合并计数、前 3 |
| `KH` 击杀分布 | `KH 22 f/m/l 20/55/25 hot x3-5 y6-8 41` | 每波一次（与 BR 同窗口）；后段 >45% 末尾加 `LATE`（前中段火力不足） |
| `RC` 回收 | `RC 无用墙 6（拆了路线不变，各退≈3g）: #12@3,4 … \| 零伤害塔 #9pencil \| 被挤占格 4,5:14（Lv1 墙占着好格，换塔不改路线） → {do:"reclaim",…}` | 建造阶段，有才发；同样内容隔 3 次建造决策才重发 |
| `CB` 组合技 | `CB 激活 #3+#7 带橡皮的铅笔 \| 缺搭档 #4glue(配stapler) \| 塔种 3: pencil,glue,stapler → {do:"combo",pair:"glue+stapler"}` | 同上；建议按收益排序（胶水→订书机、台灯↔钢笔、尺子↔圆规；铅笔→橡皮擦只在下一波有护甲时） |
| `MZ` 迷宫 | `MZ 路线 L16 = 直线 15 的 1.1×（偏短），规划可达 L66（4.4×）\| 迷宫 4/58 格，还差 ≈270g \| 未利用障碍 4,4 2×2 … → {do:"maze"}` | 建造阶段，路线 < 规划可达的 85% 时 |
| `CTR`（改） | `CTR pc→armor ik→slow+aoe \| leaks need armor \| 缺 armor,aoe → {do:"build_near",purpose:"armor"} …` | 同 TH；敌人与最近 3 波漏怪的精英词缀 → 用途，没有主力塔的用途给建议 |

这些行典型 ≈200 token / 决策（脚本对局实测平均 202～225、最多 ≈330），只在有内容时出现。

**回收 / 重建（`src/agent/board.ts` 体检 + `planner.ts` 意图）**
- 无用墙 = 拆掉后没有任何路线变短（真实流场逐座复核）、不在迷宫规划里、也不是给相邻攻击塔加成的 Lv2+ 墙；零伤害塔 = 最近 2 波 0 伤害或射程内没有任何路线 / 飞行线；被挤占格 = Lv1 墙占着的、覆盖不少于最好空格的格。
- `reclaim {target:"useless_walls"|"idle_towers"|"cells", max, replaceWith?, dry?}`：拆无用墙（每拆一座复核路线，变短立刻补回）/ 卖零伤害塔（卖了会缩短路线的换成墙）/ 把被挤占格的墙直接换成塔（塔也是墙，路线不变）；`replaceWith` = 塔 id 或用途，在腾出的格上重建；`dry` 只列出。墙退款 3g（5g × 70%），腾出的好格价值高。
- `rebuild_maze {style, route}`：路线变了（空降点没了、入口变了）→ 先拆不再有用的旧墙，再按规划重建。

**塔的多样性与组合技**
- 速查表（固定前缀第二块，593 → 971 token）：每种塔"什么时候用"一行、用途 → 塔（`armor(eraser/lamp/stapler)` …）、敌人行的克制改成用途、全部 5 个组合技（数据里的中文说明）+"上下左右相邻"、书本墙 Lv2/Lv3 相邻加成与"墙换塔不改路线"、分支与进化建议。规则块加 3 条（混搭用途、读 LK/GAP/KH、满盘就回收）。
- `build_near {purpose}`：用途 dps / aoe / slow / armor / air / stealth / boss / antiheal / shield（`src/agent/purpose.ts`）→ 在买得起的候选里按 `覆盖 × 威力 × 适配 ÷ 价格 ÷ (1 + 0.12 × 同类已有数)` 挑塔与格（逐座重新挑）；`target` 新增 `seg:x1,y1-x2,y2`（缺口段）。
- `combo {pair, near}`：优先给已有的落单塔在上下左右放搭档，否则在前 8 个好格 × 相邻格里找一对；每座的格至少是该塔最好格覆盖的 70%（不为组合技牺牲位置）；第二座被拒就换第一座的其他邻格。
- `support`：计算器放在光环覆盖输出最多处（不足 2 座主力塔就不放）；`economy`：只有满血、≥6 座攻击塔、下一波每条线威胁 ≥×3 时才放存钱罐。
- 迷宫规划（`maze.ts`，与机器人共用）：除横向蛇形外也枚举纵向（列）蛇形，障碍物 / 出生格 / 出口当免费的墙；`maze` 意图不给 `budget` 时建到路线 ≥2.5× 直线（或至少补完下一道挡板），给了太小的 `budget` 也会补完正在建的这道挡板（半道挡板不拉长路线；`spend` 内部调用仍按给的预算）。
- 顺手修了战报的老毛病：决策里新放的塔要到下一个决策点才被"看到"，整波伤害被当成基线 → 战报误报 `0dmg (out of reach?)`；改为新塔从 0 起算。

**评测指标（`scripts/eval-lib.ts`，按回放统计，与引擎版本无关，所以 git HEAD 也能用同一口径）**：`types` 建过的不同攻击塔种类、`combos` 终局激活的组合技对数、`w.sold` 卖掉的墙、`reclaim` 卖出后又放了攻击塔的格、`leak/w>1st` 第一次漏怪之后平均每波漏怪、`path×` 终局路线 / 直线、`passes` 攻击塔平均覆盖几段路线（夹在两条通道之间的塔 ≥2）。每局另存 `replay-*.json`。

### 19.9 实测（第二轮）
中转 deepseek-flash（思考"低"，均衡上下文），无尽 12 波封顶，种子 relay1 / relay4，每格 2 局。`HEAD` = 提交 94b5c57 的 Agent 代码（`git archive` 出来跑，评测库用本轮的，指标同口径）；`new` = §19.8 全部改动。`passes` 需要回放文件，HEAD 那一轮没存，空着。

| 设定 | 版本 | 失守 | 剩余生命 | 漏怪 | 塔 / 墙 | 路线（×直线） | 塔种 | 组合技 | 卖墙 | 腾格重建 | 首漏后每波漏 | passes | 原始 / 波 | 折算 / 波 | 请求 / 决策 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ch1 困难 | HEAD | 0 | 12.5/15（83%） | 3 | 15 / 41.5 | 47.5（3.4×） | 5 | 1 | 14.5 | 14.5 | 0 | – | 9.6k | 4.9k | 1.02 |
| ch1 困难 | **new** | 0 | **14/15（93%）** | **2** | 19 / 46.5 | **67（4.8×）** | **7.5** | **5.5** | 22 | 20 | 0 | 2.1 | 14.1k | 5.7k | 1.13 |
| ch2 噩梦 | HEAD | 1 | 2.5/10（25%） | 15 | 17.5 / 38 | 42.5（3.0×） | 5 | 1 | 10 | 10.5 | 0.70 | – | 14.9k | 7.7k | 1.18 |
| ch2 噩梦 | **new** | 1 | **5/10（50%）** | **10** | 18.5 / 21.5 | 41（2.9×） | **7.5** | **3** | 18.5 | 14.5 | 2.5* | 3.0 | 15.2k | 6.5k | 1.15 |
| ch3 困难 | HEAD | 0 | 8.5/15（57%） | 15 | 19 / 26.5 | 45.3（3.2×） | 4.5 | 1 | 11.5 | 12 | 0.42 | – | 10.8k | 5.2k | 1.02 |
| ch3 困难 | **new** | 0 | **15/15（100%）** | **0** | 18.5 / 37 | **59.8（4.3×）** | **7** | **2.5** | 22.5 | 18 | 0 | 3.9 | 14.5k | 6.1k | 1.08 |

对照机器人（同种子，12 波）：expert 三格都 100%（塔种 5～6、组合技 1.5～4、路线 4.0～4.7×）；medium ch1 87% / ch2 100% / ch3 50%（失守 1）。

\* ch2 噩梦 relay4 这一局（新版）在第 10～11 波 Boss（咖啡渍分裂）时失守：模型在备忘里写"routes L27/L35 already long; no remaze, keep cells for towers"，迷宫只有 31 格，漏怪集中在最后两波；同设定另一局 10/10 满血。HEAD 失守的是 relay1（第 13 波），relay4 剩 5/10。

结论：
- 打法：6 局漏怪 33 → 12，剩余生命 55% → 81%（ch3 困难 57% → 100%、ch1 83% → 93%、ch2 噩梦 25% → 50%）；塔种 4.8 → 7.3，组合技 1 → 3.7，卖墙 / 腾格重建都多了一半以上，路线更长（3.2× → 4.0×）。
- token：每波原始 11.8k → 14.6k（+24%）、折算 5.9k → 6.1k（+3%）。固定前缀 +≈650 token（速查表 593 → 971、规则 +90、工具 +190）几乎全走缓存；多出来的原始 token 主要是 LK / GAP / KH / RC / CB / MZ 行（≈200 / 决策）和多了一点的请求 / 决策（1.07 → 1.12）。
- 本轮共用 ≈2.3M 原始 token（HEAD 0.83M、new 1.0M、一次评测脚本把变体名写坏、跑完无法落盘而作废的约 0.3～0.6M，未计量）。样本小（每格 2 局），ch2 仍有 1 局失守。

离线脚本（`scripted-tactics` = 意图版 + 每个建造阶段 reclaim 墙 / 塔、按 CTR 缺的用途 build_near、给落单塔配组合技、economy；ch1/2/3 × 困难 / 噩梦 × 3 种子 × 12 波）：塔种 6.7 → 7.0、组合技 1.6 → 3.7、passes 3.46 → 3.70，但剩余生命 98% → 93%～94%（漏 4 → 12～13）。逐项单开：回收墙 / 回收塔 98%（无损）、按用途补塔 95%、配组合技 91%（加了 70% 位置门槛后 95%）、economy 85% 且失守 2 局（收紧条件后 98%）。脚本玩家本来就≈expert，多样性对它是噪声级的小亏；对真实模型（基线弱得多）是净收益。

### 19.10 第二轮试过但没用 / 改掉的
- **迷宫段按"每格墙的路线增量"排序**（先建借障碍物的便宜挡板）：脚本评测生命 98% → 67%、失守 4 局，expert 机器人也 100% → 70%。保留原顺序（入口一侧先建）。
- **迷宫按"路线 − 0.08 × 墙格数"选布局**：路线略短、生命不变，弃用（仍取最长，同长取墙少）。
- **纵向（列）蛇形候选**：在 ch1～ch3 的种子上从没被选中（横向更长）；只保留"塞满"的列组以免规划耗时翻倍（规划 ≈450ms / 局面，HEAD ≈430ms）。
- **economy 的宽松条件**（满血、≥4 塔、下一波没有"危险"）：困难难度早放存钱罐，脚本评测失守 2 局；收紧为 ≥6 塔、每条线威胁 ≥×3。
- **combo 不设位置门槛**：给落单铅笔配橡皮擦，常放在覆盖很差的格；改为每座至少该塔最好格覆盖的 70%，CB 建议也按收益排序（铅笔→橡皮擦只在下一波有护甲时）。
- **`maze` 预算向上补完挡板也作用于 `spend`**：spend 内部的墙预算被放大，开局钱全进墙，脚本 ch2 噩梦第 3 波失守；只对模型直接给的 `maze` 生效。

### 19.11 第三轮：系统提示（打法手册 + 术语表）与后期规划器
反馈："AI 打无尽只能到 40 多波"。先量：中转 deepseek-flash 改前 3 局（种子 rm1～rm3，ch1 普通，无尽）49 / 49 / 50 波，全部死在 w40 闹钟 Boss 之后几波；脚本对照 `scripted-intents` 49.5 波、`scripted-tactics` 47.2、medium 45.7、expert 68.2（6 种子 e1～e6）。

**提示词（`src/agent/prompts.ts`，见 §17.12）**
- 规则里加无尽成长与日历（数值取自 `scaling.ts` / `difficulty.ts` / 波次生成）：敌人血量 ×(1+.18n)·1.04^n（w20 ×9、w40 ×37、w60 ×118、w80 ×340）、数量 +8%/波、护甲每 12 波 +1、普通 w30 起精英（困难 20 / 噩梦 15 / 魔境 12），击杀金币只 ×(1+.04n) ⇒ 后期靠等级 / ★ / 计算器 / 复利；Boss 每 10 波（50 波起 2 个）、空袭 7 的倍数、冲锋 5 的倍数、包夹 w12/28/36/44/52；利息 5%（上限 20，噩梦 / 魔境 15）、波奖励 10+2w、卖塔 70%…25%。
- 打法手册：开局 `[{do:"spend",reserve:0}]`；**默认回合 = [需要时 anti_air, spend]**，upgrade_best / build_near 只在有理由时放在 spend 前（它们在另一边更划算时会拒绝）；w1-10 / w10-30 / 护甲（伤害 = max(1, 攻击 − 护甲)：w40 回形针护甲 6、Boss 7+，纯铅笔会在 w40 Boss 崩）/ w30-60 / w60+ 或满盘的分阶段计划；增益优先级 legend（+uid 最好的 Lv7+ 铅笔 / 台灯，分支 A）> promotion > sale > compound > timemgmt > notes > sharpener > scholaraura > safe；补给 w30 前金币、之后经验；缺省分支；困难 / 噩梦 / 魔境更早造迷宫与对空、存钱罐只在每条线 TH ≥3 时。
- 术语表：全部观测短键与附加行的字段（§17.12）。

**规划器（`src/agent/planner.ts`）**——用脚本"模拟模型的用法"测出来的坑（种子 e1～e6，ch1 普通，150 波封顶）：

| 模拟 | 改前 | 改后 |
|---|---|---|
| 只 spend（+ anti_air / 技能，`scripted-intents`） | 49.5 | **60.0** |
| 每个决策先 `upgrade_best ×3` 再 spend（真实模型最常见的写法） | 36.5 | **55.3** |
| 每个建造阶段 `build_near purpose:dps` | 46.8 | **56.8** |
| 两者都有 | 32.3 | **49.5** |
| `scripted-tactics`（再加 reclaim / CTR 补塔 / combo / economy） | 47.2 | **54.7** |
| 困难：intents / tactics | 35.8 / 36.7 | 36.2 / 38.5 |
| 魔境 I：intents / tactics | 23.0 / 27.2 | 23.8 / 27.0 |
| 对照机器人 expert / medium（普通） | 68.2 / 45.7 | — |

- **轮换表**与高手机器人同序：开局 4 铅笔后穿插橡皮擦 / 台灯 / 胶水，≥8 座攻击塔后计算器、w15～25 前后存钱罐（最多 3，掉过命 / 下一波危险 / 35 波后不买）。顺手修了计数 bug：计算器 / 存钱罐不是攻击塔，按攻击塔计数时永远"还没买"，一局能买 40 座计算器。
- **买 / 升口径**：15 波起新塔的每金币收益要高过升级 ×1.5 才买（高手机器人的 upgradeBias）；升级买不起时，新塔不更差（或危急）就先买塔而不是干攒。
- **`upgrade_best` 与 spend 同口径**：塔没到上限且新塔更划算时拒绝（`stop: a new pencil is worth more per gold now … → {do:"spend"}`）。这是本轮最大的一项：模型几乎每个决策都先 upgrade_best，早期塔太少。
- **`build_near purpose:"dps"`**：升级更划算时拒绝；挑塔时覆盖取平方根、铅笔不打同类折扣（尺子 r4.5 覆盖是铅笔 3 倍但秒伤 / 金低得多）。其他用途（armor / boss / aoe…）仍线性，靠适配系数挑台灯 / 尺子 / 橡皮擦。
- **`build_near` 最好格覆盖 < 3 个路线格就不建**（后期满盘，模型连买 cov1.2 的圆规）→ 提示改升级。
- **`anti_air`**：下一波这条飞行线已"安全"（TH ≥2）就跳过（`count ≥2` 强制）；改前每个空袭波都补一座，后期 13～15 座苍蝇拍。
- **`reclaim idle_towers`**：够不着路线的照卖（再用规划器自己的覆盖口径复核，两套口径不一致时卖了又在原格重建同一座塔）；只是"最近 2 波 0 伤害"的，只卖放了 2 分钟以上的 Lv1 非对空塔（后段的塔是保险，卖塔亏钱）。
- **`combo`**：这一对已经激活过、又没有落单塔可配时，不再新建一整对（脚本里每波新建胶水 + 订书机，少活 3 波）。
- **`save`**：下一波有"危险"路线时拒绝（实测模型 hp 6/20 还在 save until 400）。
- **`maze`（模型直接调用）**：攻击塔不足 4 座时先留出铅笔钱（实测一局开局 `{do:"maze"}` 把 150 金币全换成 30 道墙，第 1 波 0 座塔漏 9 只、第 5 波失守）。
- TH 行建议的 `{do:"anti_air",line:…}` 字段名写错（Schema 是 `route`，照抄会被拒），已改。

**观测精简（`compact.ts` / `intel.ts`，§17.12）**：真实对局每次决策的观测 ≈370 → ≈280 token（−25%）。

**真实模型（中转 deepseek-flash，思考"低"，均衡上下文，ch1 普通无尽，种子 rm1～rm3，各 1 局）**

| 版本 | rm1 | rm2 | rm3 | 平均 | 每波原始 / 折算 token | 请求 / 决策 |
|---|---|---|---|---|---|---|
| 改前（§19.10 的代码） | 49 | 49 | 50 | **49.3** | 16.0k / 6.5k | 1.09 |
| 中间版 A：新提示词（偏铅笔）+ 轮换 / 对空 / 平方根选塔 | 42 | 41 | 47 | 43.3 | 17.9k / 7.7k | 1.17 |
| 中间版 B：+ 护甲段落、用途选塔改回线性 | 44 | 55 | 49 | 49.3 | 18.2k / 7.9k | 1.17 |
| **最终（本节全部 + upgrade_best / build_near dps 与 spend 同口径）** | **56** | **59** | 49 | **54.7** | 19.7k / 8.9k | 1.15 |

- 最终版另有 1 局（rm1 第一次）开局 `{do:"maze"}` 把钱全换成墙、第 5 波失守，修了 `maze` 留铅笔钱后重跑得到上表的 56；rm2 / rm3 是修之前跑的（只影响开局）。
- 中间版 A 掉到 43 波：替换下来的 3 局里塔是 29～34 支铅笔、5～7 尺子、5～6 台灯，改前是 12～18 铅笔、23～27 尺子、9～19 台灯——w40 闹钟 Boss（护甲 7）一来就崩。于是提示词补了护甲段落、用途选塔只对泛用 dps 取平方根。
- token：每波折算 6.5k → 8.9k（+37%）。前缀只 +3%、观测 −25%，涨在输出（推理 1.7k → 2.2k / 波，打法手册让模型想得更多）和新输入（第二次请求略多、对局更长后期塔多）。按均衡 1M 折算预算算，≈110 波。
- 样本小（每版 3 局，单局波动 ±5 波），结论按"方向"看：最终版 3 局里 2 局到 56～59 波，脚本模拟的同类写法从 32～47 提到 50～57。

### 19.12 进攻路线行 AR 与意图合并（第四轮）
**AR（attack routes，每个决策的观测都有，取代原来的 `R` / `Ra` 和 `nx` 里按出生点的列表；`nx` 只剩 `wN [tags] early+Ng`）**——给模型"下一波从哪来、走哪条路、哪里没火力"，好针对性落塔。下一波被 AI 出题改写时读的是改写后的 `state.nextWave`。格式只在术语表里定义一次：

```
"AR":["north: cr×10 pc×4(e1) | 5,0>8,0>8,2>1,2>1,7>3,9>3,11>5,13 L24 | gap 1,2>5,13(12)",
      "west: - | 0,3>0,4>11,4>…>5,13 L37 | gap -",
      "drop-3 lands 8s: - | 7,6>…>5,13 L12 | gap 7,6>7,9(4)",
      "air:north: pl×3 | 5,0>5,13 L13 aa28% #1,#2,#3,#15+6",
      "*: cr×5"]
```
地面 = `出生点: 下一波走这条线的地面组（代号×数量(e精英数)，没有写 -）| 拐点航点（最后一个是出口）L长度 | gap 没有任何对地塔够得着的路段 起>止(格数)，最长 3 段`；`lands Ns` = 空降箱落地后的路线；`air:` = 飞行线（起点格 > 出口格、对空覆盖比例、覆盖它的塔最多列 4 座）；`*` = 出生点未定的组。实现 `routes.ts attackRoutes()`，`compact.ts` 写入。

**漏怪按路线归并**：`LK w7 n4 | north: cr×3(hp40 in35 x5 y9..12 gap0 top#4pencil70) | air:west: pl^×1(hp80 in10 top-)`（路线名与 AR 相同）；`GAP` 只报近 5 波**漏过 ≥2 次**的路段，只出现一次的已在 LK 里。

**意图合并：Schema 只列 6 个**——`spend`、`maze`（`rebuild:true` = 原 rebuild_maze）、`build_near`（`tower` | `purpose` | `pair`；`purpose:"air"` = 原 anti_air，按飞行线 `route`、线已"安全"跳过、`count ≥2` 强制；`tower:"calculator"` / `"piggy"` 不给 target = 原 support / economy 的光环 / 安全门槛逻辑；`pair` = 原 combo）、`upgrade_best`、`save`、`reclaim`。旧名 `anti_air / combo / support / economy / rebuild_maze`（以及 combo 的 `near`）照收：`executeTool('act')` 与 MCP 都先经 `normalizeAction()` 改写再校验，脚本策略、玩家指令解析、旧客户端不用改。观测里的建议意图（TH / GAP / CB）都改成新写法。act 描述："Intents: spend | maze (rebuild) | build_near tower|purpose|pair (purpose air = anti-air; tower calculator/piggy = aura/economy spot) | upgrade_best | save | reclaim target"。

前缀（规则 + 速查表 + 玩家工具）4281 → **4513 token**（+5.4%）；脚本对局每次决策消息均值 529 → 440 token（−17%，AR 计入后）。脚本评测数字不变（intents 60.0 / tactics 54.7，旧名走别名）。

### 19.13 NEXT 行：一张排好序的建议清单（第五轮）
**问题**：建造阶段的附加行各自带一个「→ 建议意图」——TH 说补火力、CB 说补组合、RC 说回收、MZ 说修迷宫、IDLE 说花钱——没有先后，模型每回合要自己在 4～6 个互相打架的建议里取舍（Boss 波甚至没有一行明说先防 Boss）；`DOC none` 每回合把 6 个预设重新列一遍（≈100 token）。

**做法**（`src/agent/advice.ts` `turnAdvice()` / `adviceLine()`）：建造阶段**和波中**（自动开波后期几乎没有建造阶段，新出怪口只能在波中补）把这些信号合成一行，放在 DOC 之后：

```
NEXT [{"do":"build_near","purpose":"dps","target":"route:west"},{"do":"maze"},{"do":"spend","reserve":0}] ← west 危险 ×0 | maze 1.9× < 2.5× | spend the rest ; also: build_near pair:"glue+stapler"
```
- 优先级：TH 危险 / 吃紧的路线与飞行线（最危险的先；地面用第一个缺的克制，没有就 dps）> 近 5 波漏过 ≥2 次的缺口 > Boss 波（没有 Boss 克制，或 Boss 路线余量 < 3×）> 下一波缺的其他克制 > 迷宫短于中心策略目标 > `spend reserve:0`（永远最后；留 20 吃利息每波只多 1 金，评测里全花更稳）。最多 4 步。
- 组合技、回收**够不着任何路线**的塔放在 `also:`（不急）；最近 0 伤害的塔常常只是后备（前段把怪打完了），不建议卖。
- 其余行（TH / CTR / MZ / CB / RC / GAP）去掉「→ 建议」只当依据；建造阶段不再发 IDLE（并进 spend）；`save` 生效时清单不含 spend。
- `DOC none` 缩成一句（前 3 波附「可选：end.doctrine」），预设说明移进规则（缓存前缀）。规则 1796 → 1790 token（删掉与 NEXT 重复的段落）；每次决策消息均值 均衡 508 → 413、省流 434 → 339 token（`npm run agent:tokens`）。
- 规则「Each decision」：默认把 NEXT 照抄进 actions（玩家指令在前），只有说得出具体理由（MEMO 计划、Boss 路线、also 项）才改，理由写进 end.note。
- MCP 的 `observe` 在建造 / 波中也附 NEXT（与内置 AI 同一行）。

**检验 NEXT 本身**：新增脚本变体 `scripted-next`（完全照抄 NEXT，其余同 scripted-intents）。`--seeds f1..f6 --maps ch1,ch2,ch3 --difficulties normal,hard --max-waves 40`，各 36 局：

| 变体 | 普通 输 / 平均波 | 困难 输 / 平均波 | 困难漏怪 |
|---|---|---|---|
| scripted-intents（原脚本） | 0 / 41.2 | 16 / 37.4 | 263 |
| scripted-next（照抄 NEXT） | 0 / 41.3 | 15 / 38.2 | 258 |

即模型什么都不想、照抄 NEXT 也不比原脚本差。

**真实模型**（中转 deepseek-flash，思考低、均衡，种子 r1..r3 × ch1/ch2，改前 = v0.3.2，改后 = v0.3.3）：

| 设置 | 版本 | 输 | 生命% | 漏怪 | 被拒动作 | 请求/决策 | 折算/波 |
|---|---|---|---|---|---|---|---|
| 普通 15 波 | 改前 | 0/6 | 100 | 0 | 4 | 1.09 | 5693 |
| 普通 15 波 | 改后 | 0/6 | 100 | 0 | 1 | 1.13 | 5873 |
| 困难 30 波 | 改前 | 2/6 | 36 | 57 | 36 | 1.10 | 7411 |
| 困难 30 波 | 改后 | 0/6 | 54 | 40 | 18 | 1.23 | 8719 |

模型确实在用 NEXT：开局几乎照抄，之后按局面取舍并在 end.note 写理由（"air coverage 28% → anti-air before w7"、"boss on route → spend on upgrades"）。代价：困难里折算 token +18%，主要是 observe 调用从 24 次（380 次决策）涨到 59 次（399 次），新输入 / 决策 1982 → 2339。**已定位并修复（v0.3.4）**：抓思路追踪，模型原话是 "gold … not stated directly in STATE Δ. Let's observe" / "sk not shown"——增量观测只发变化过的键，金币、技能没变时就不在消息里，模型拿不准当前值只好整份重拉；NEXT 让模型更常在波中出手，碰到得更多。改为增量**总带** `ph w g hp sk`（`compact.ts ALWAYS_KEYS`，每次约十几 token），术语表写明，`w` 注明「next: nx」（模型曾把 w 和 TH 的波号搞混）。复测（困难 30 波，种子 r1..r6 × ch1/ch2，各 12 局）：

| 版本 | 输 | 生命% | 漏怪 | observe / 100 决策 | 新输入 / 决策 | 折算 / 波 |
|---|---|---|---|---|---|---|
| v0.3.3 | 3/12 | 36 | 112 | 13.3 | 2109 | 8225 |
| v0.3.4 | 1/12 | 40 | 108 | 6.5 | 1734 | 7108（−14%，也低于 v0.3.2 的 7417） |

## 20. 中心策略（Doctrine）

整局「以什么为主」的一组参数：核心塔（排序）、迷宫长度、选位方式、传奇分支、增益偏好。代码在 `src/agent/doctrine.ts`，只在 agent 一侧，不碰 core，回放与确定性不受影响。

### 20.1 预设

| 预设 | 核心塔 | 迷宫 | 分支 | 增益偏好 |
|---|---|---|---|---|
| balanced 均衡（缺省） | — | standard 2.5× | 规划器缺省 | — |
| pencil 铅笔流 | pencil > eraser > calculator | long 3.5× | pencil A | sharpener、legend |
| aoe 范围流 | stapler > compass > glue | long 3.5×，uturn | stapler A、compass A | staples、drafting、quickglue、thickcover |
| lamp 光束流 | lamp > glue > eraser | long 3.5× | lamp A | bulb、thickcover |
| economy 经济复利 | piggy > calculator > pencil | lean 2.0× | calculator A、piggy A | compound、sale、promotion |
| antiair 重防空 | swatter > pencil > lamp | standard 2.5× | swatter A | — |

- 也可以自定义：`core:[≤3 座塔]`、`maze long|standard|lean`、`focus uturn`；自定义的买塔轮换取最接近的预设。
- 去掉了 ruler（远程穿透）预设：调了两版轮换，6 局平均仍只有 47～49 波（均衡 60）。尺子可以放进自定义核心塔。

### 20.2 怎么驱动规划器（加权，不排他）

- 买塔轮换：`rotationFor(doctrine)`。所有预设开局都是 4 支铅笔（§19.7），之后按核心塔穿插，破甲（橡皮擦 / 台灯）都保留。
- 买 / 升比较：核心塔的每金币收益 ×1.3 / ×1.15 / ×1.05（`coreWeight`）；核心塔的升级价值 ×1.25。
- 分支：`doctrine.branches[id] ?? DEFAULT_BRANCH[id]`；模型在 act 里显式写的分支优先。
- 迷宫：目标倍数 long 3.5 / standard 2.5 / lean 2.0；spend 的墙投入上限 0.7 / 0.5 / 0.35 × 塔投入 + 25。
- 多层攻击（focus uturn）：`maze.ts layers()` 数射程内有几段不同的路线经过，核心塔的选位价值 ×(1 + 0.3 × (段数 − 1))。
- 自动选增益（推进保证）先看 `doctrine.perks`。
- 保底不受策略影响：紧急时先买铅笔、spend 里的防空分支、`build_near purpose` 的非 dps 用途（护甲 / Boss / 对空…）不乘核心权重。
- 兜底机器人：选了非均衡策略时改走 `scriptedIntentTurn`（经规划器，按策略买塔）；均衡时保持旧版 `scriptedTurn`。

### 20.3 模型怎么看到、怎么改

- 每次决策（玩家 / 军师）的附加信息第一行是 DOC 行，例如 `DOC aoe(player,w0,locked) | core stapler>compass>glue | maze long 3.5x uturn | br stapler A compass A | perks staples,…`。未选时是 `DOC none — pick one in end.doctrine {preset,why}: …`，列出各预设的一句话说明（只在选定前出现，不占固定前缀）。
- 固定前缀只加了两小段：打法里 1 行、术语表里「DOC strategy」。规则 1756 → 1796 token；act 工具 1243 → 1392 token（end.doctrine 的 Schema）。
- 修改：`act` 的 `end.doctrine {preset?, core?, maze?, focus?, why}`，先改再执行这次的动作。规则：
  - 必须写 why；只写 why（「保持」）不算修改；
  - 冷却 5 波（最近两波漏过怪除外）；第一次选不受冷却；
  - 玩家锁定时模型改不了，只记为建议，界面上出现「AI 建议改为…［采纳］」。
- 玩家修改不受冷却 / 锁定限制，并立即触发一次决策（`controller.setDoctrine`）。
- 追踪里每次切换记一条 `{k:'doctrine', from, to, by, why, wave}`，思路面板里显示。

### 20.4 界面

- 设置页（AI 玩家 / 军师 / AI 对战的防守方；AI 出题不显示）：「中心策略」卡片，「AI 自动选」+ 6 个预设，每个一句说明；「你的话」输入框（本地关键词认出预设，原话作为 player notes 转给 AI）；「锁定，不让 AI 改」开关。保存在 `AiSetupSaved.doctrine`，开局写进 `config.doctrine`。
- 对局「AI 状态」页：策略标签（例如「策略：范围流（锁定）」），点开是预设按钮、锁定开关和修改记录。
- 指令框：发送的话里认出策略（「主打范围」「铅笔流」「把路绕成弯弯绕」…）时先问「把中心策略改为『范围流』？［改策略］［当普通指令发送］」。

### 20.5 评测

离线（不花 token），`npm run agent:eval -- --variants "aoe:doctrine=aoe;…" --seeds e1,…,e6 --max-waves 120 --bots none`（或全局 `--doctrine aoe`），scripted-intents，ch1 普通无尽，6 个种子：

| 预设 | 平均波数 |
|---|---|
| balanced | 60.0（与 §19.11 基线相同） |
| pencil | 63.0 |
| economy | 61.2 |
| aoe | 56.7（第一版轮换 51.0：核心塔进场太早） |
| antiair | 56.3 |
| lamp | 56.2（第一版 53.8） |
| ruler（已去掉） | 47.5 / 47.0 / 48.7 |

真实模型（中转 deepseek-flash，思考「低」，ch1 普通无尽，种子 relay1 / relay4 / relay5，各 3 局打到失守；预设组锁定，auto 组由模型自选）：

| 组 | 平均波数 | 各局 | 每波折算 token | 模型想改策略被拒（锁定） |
|---|---|---|---|---|
| aoe 范围流 | 52.3 | 49 / 49 / 59 | 7458 | 2 次 |
| auto 模型自选 | 51.3 | 42 / 49 / 63 | 7653 | — |
| antiair 重防空 | 50.7 | 61 / 49 / 42 | 7705 | 0 |
| pencil 铅笔流 | 49.7 | 39 / 49 / 61 | 7551 | 2 次 |
| balanced 均衡 | 48.0 | 49 / 46 / 49 | 7447 | 2 次 |
| lamp 光束流 | 45.3 | 42 / 46 / 48 | 7637 | 3 次 |
| economy 经济复利 | 43.3 | 42 / 46 / 42 | 7746 | 2 次 |

- 同一组内单局相差可达 20 波，3 局的差别大多在噪声范围内；能看出的只有：范围流、自选、重防空、铅笔流、均衡在同一档（48～52），光束流和经济复利偏低（43～45）。经济复利在离线机器人上是 61.2，真实模型打不出复利节奏，设置页的说明保留「只建议普通难度」。
- auto 组 3 局都在第一次决策选了 pencil + long maze（两局 uturn），理由都是「铅笔每金币秒伤最高、Lv7 双发，长迷宫放大，后期补台灯 / 橡皮擦破甲」；之后没有真正换过策略，只是把同样的策略原样重写过 2 次（第一版把这种重写记成了修改并改成 custom，已修：与当前相同时返回 unchanged，不记录、不重置冷却）。
- 各组每波 token 基本一样（7.4k～7.7k），DOC 行不明显增加开销；21 局共约 1020 波，按 deepseek-flash 价格约 $5。
- 这次 balanced 的 48 波低于 §19.11 的 54.7，那 3 局用的是另一组种子，不能直接对比。
