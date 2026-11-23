# 参与开发 · 书桌防线 / Desk Defense

本文是代码规范与日常工作流程。设计细节见 `docs/`（尤其是 [08 实现约定](docs/08-实现约定.md)）。

## 环境与常用命令

- Node.js **22.22 或更高**（见 `package.json` 的 `engines`；CI 用 Node 22）。
- `npm install` 会通过 `prepare` 安装 Git 预提交钩子（simple-git-hooks + lint-staged：对暂存的文件跑 `eslint --fix` 与 `prettier --write`）。临时跳过：`SKIP_SIMPLE_GIT_HOOKS=1 git commit …`，或 `git commit --no-verify`。

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器（热更新，局域网可访问） |
| `npm run build` | 类型检查 + 打包到 `dist/` |
| `npm run typecheck` / `npm run typecheck:functions` | 前端 / Pages Functions 类型检查 |
| `npm run lint` / `npm run lint:fix` | ESLint 检查 / 自动修复（含 Prettier） |
| `npm run format` / `npm run format:check` | Prettier 格式化 / 检查 |
| `npm test` | Vitest 全部单元测试 |
| **`npm run check`** | 提交前跑这一条：typecheck + typecheck:functions + lint + format:check + test（CI 同款） |

## 目录结构

| 目录 | 内容 | 约束 |
|---|---|---|
| `src/core/` | 纯游戏逻辑：世界状态、寻路、战斗、波次、技能 | 不碰 DOM / Phaser / 浏览器 API；**必须确定性**（见下） |
| `src/config/` | 数值配置：塔、敌人、技能、增益、天赋、难度、地图、战役 | 同 core：纯数据、确定性 |
| `src/render/` | Phaser 棋盘渲染、特效、棋盘指针输入 | 只读 `world.state`，通过 `Session` / 指令影响游戏 |
| `src/ui/` | HTML 界面：菜单、HUD、面板、图鉴、AI 面板 | 文字一律走 `t('…')` |
| `src/agent/` | AI 参战：观测、规划、工具、模型提供方 | 只经 `import()` 动态加载，不进主包（见 `vite.config.ts`） |
| `src/meta/` | 存档、进度、解锁、排行榜、在线功能 | 存储一律经 `meta/storage.ts` 的 `safeStorage()` |
| `src/i18n/` | 翻译入口与四种语言词典 | 见「国际化」 |
| `src/shared/` | 前端与 Pages Functions 共用的代码（校验、编码） | 同时受 `functions/tsconfig.json` 检查，不能依赖 DOM / i18n |
| `src/game/` | 运行循环 `Session` 与交互状态 `UiStore` | 跨模块共享，改动需同步各方 |
| `functions/` | Cloudflare Pages Functions（`/api/*`，D1 全服排行榜） | 独立 tsconfig（Workers 类型） |
| `migrations/` | D1 数据库迁移（按序号递增，已上线的不要改） | |
| `scripts/` | 平衡模拟、机器人、评测、文档 / 美术生成 | 允许 `console.log` |
| `tests/` | 单元测试（core / agent / ui / online / i18n / guide） | |
| `art/` | SVG 美术源文件 | 见「美术流程」 |

跨模块的接口只有 `src/core/types.ts`，改接口先改那里。

## 代码风格

- **Prettier** 负责格式（单引号、分号、尾逗号、`printWidth` 140），不要手动对齐；HTML 与 Markdown 不参与格式化。
- **ESLint**（`eslint.config.js`，typescript-eslint 类型感知）主要规则：
  - `@typescript-eslint/no-floating-promises`：Promise 必须 `await`、`.catch()`，或明确写 `void promise`（“发出去不管”）。
  - `@typescript-eslint/consistent-type-imports`：仅类型用 `import type` / `import { type X }`。
  - `eqeqeq`（smart）：只允许 `== null` 这一种宽松比较。
  - `no-console`：只允许 `console.warn` / `console.error`；`scripts/` 不限。
  - `prefer-const`、`@typescript-eslint/no-unused-vars`（未用的参数 / 变量以 `_` 开头）。
  - `@typescript-eslint/no-explicit-any`：警告；确需 `any` 时用 `eslint-disable-next-line … -- 理由`。
  - `simple-import-sort/imports`：导入自动排序（副作用导入如 `import './x.css'` 保持原顺序并排在最前）。
- 规则豁免一律写在行上，且必须附理由：`// eslint-disable-next-line 规则名 -- 理由`。多余的豁免注释会报错。
- 注释、提交信息用中文；标识符用英文。

## 确定性（core / config）

同一组「种子 + 指令序列」必须得到完全相同的结果——回放、中途存档、全服排行榜的服务端校验都依赖这一点（测试里用 `stateHash` 比对）。

- 随机数只能用 `src/core/rng.ts` 的 `Rng`（mulberry32，按种子派生）；**禁止** `Math.random`。
- 时间只能用模拟时间（固定步长、`state.time` / 帧数）；**禁止** `Date.now`、`performance.now`、`new Date()`。
  以上由 ESLint 的 `no-restricted-properties` / `no-restricted-syntax` 在 `src/core/**`、`src/config/**` 强制。确有正当用途时逐行豁免并写理由。
- 不要让语言、主题、屏幕尺寸等界面状态影响逻辑（`tests/i18n-data.test.ts` 会验证切换语言后 `stateHash` 不变）。
- 改了数值或逻辑后跑一遍平衡模拟：`npm run sim -- --scenario calib --seeds 2`。

## 国际化（i18n）

- 入口 `src/i18n/index.ts`；源语言是**简体中文（zh-CN）**，另有 zh-TW、en、ja 四种语言。
- 词典：`src/i18n/locales/<语言>/<命名空间>.ts`，命名空间 `common`、`ui`、`core`、`data`、`agent`、`guide`（及其拆分文件如 `ui.assist`、`agent.ops`）。
- key 用点分层级且稳定：`ui.menu.campaign`、`data.tower.pencil.name`、`core.reason.blocked`。插值写 `{name}`；英文复数写 `'one|other'`（其他语言不用 `|`）。
- **新增或修改文案时四种语言一起改**。`tests/i18n*.test.ts`、`tests/guide/guide-i18n.test.ts` 校验：
  - 四种语言 key 一一对应、占位符集合一致；
  - `src/ui`、`src/main.ts`、`src/render` 不含中日文字符串字面量（确需保留的写 `// i18n-ignore` 注释在同一行或上一行）；
  - `src/core`、`src/config`、`src/meta`、`src/shared` 不残留中文字面量（白名单在测试文件里，按行匹配——这些测试是唯一标准）。
- 译名统一查 [docs/i18n-glossary.md](docs/i18n-glossary.md)，新增术语时补齐四列。
- 介绍页 `about.html` 的简体中文直接写在 HTML 里，其他语言取 `guide.about.*`，两处一起改。

## 主题（浅色 / 深色）

- 样式只用 `src/styles/tokens.css` 里的**语义变量**（`--bg`、`--surface`、`--ink`、`--border`、`--accent`、`--good` / `--bad` / `--warn` 等），不要直接写色值。
- 亮色块（`--pencil`、`--gold-l`、`--sky` …）在两套主题里都是亮色，上面的字必须深色：选择器登记到 `tokens.css` 末尾的名单，或给元素加 `class="on-bright"`。
- 深色主题在 `tokens.css` 里写了两遍（`[data-theme="dark"]` 与 `prefers-color-scheme` 媒体查询），改的时候两处同步。
- 主题切换由 `src/ui/theme.ts` 负责；棋盘配色在 `src/render/palette.ts`（`setBoardTheme`）。

## 美术流程

- SVG 源文件放在 `art/`（`towers/`、`enemies/`、`affixes/`、`skills/`、`abilities/`、`events/`），命名规范见 [06 美术与建模](docs/06-美术与建模.md)。
- 运行时由 `src/render/assets.ts` 自动拆图层、生成纹理，无需额外构建。
- 增删 SVG 后运行 `npm run gallery` 重新生成预览页 `art/gallery.html`（生成文件，不要手改）。
- 分享图 `public/og.png` 由 `node scripts/gen-og.mjs` 从 `scripts/og/og.svg` 生成。
- 渲染调试页：`npm run dev` 后打开 `/render-dev.html`。

## 测试、模拟与评测

| 命令 | 作用 |
|---|---|
| `npm test` | 全部单元测试 |
| `npm run test:online` | 只跑在线排行榜相关（fake D1） |
| `npm run sim -- --scenario calib --seeds 2` | 平衡模拟（场景：`calib`、`campaign`、`endless`、`xp`、`ladder`、`custom`），报告在 `scripts/out/report.html` |
| `npx vite-node scripts/bench.ts -- --seeds 3` | 塔的性价比基准 |
| `npm run agent:eval` | AI 参战评测（缺省为离线确定性 scripted 策略；relay 模式的密钥只从环境变量读） |
| `npm run agent:play` / `agent:bridge` / `mcp` | 本地让 Agent 对局 / 浏览器桥接 / MCP 服务 |
| `npm run docs:data` | 重新生成 `docs/guide/数据/`（生成文件，不要手改） |

新功能请配测试；修 bug 先写能复现的测试。`scripts/out/` 是输出目录，已被忽略。

## 提交约定

- 一个提交只做一件事；格式化与逻辑改动分开提交。
- 提交信息用中文，首行形如 `类型: 简述`，类型取 `feat`、`fix`、`refactor`、`perf`、`style`（仅格式）、`test`、`docs`、`chore`（工具 / 依赖 / 配置）、`ci`；需要时空一行写正文说明原因。
- 提交前 `npm run check` 必须通过（CI：`.github/workflows/ci.yml` 跑 `npm ci`、`npm run check`、`npm run build`）。
- 新增开发依赖请固定精确版本（不加 `^`），并选择发布至少两周的版本。

## 部署（Cloudflare Pages + D1）

- 配置在 `wrangler.toml`（Pages 输出目录 `dist`、D1 绑定 `DB`、非机密变量 `[vars]`）。
- 部署：`npm run deploy`（= `npm run build` + `npx wrangler@4 pages deploy dist --project-name desk-defense`）。
- 数据库迁移：新增 `migrations/000N_*.sql`，先 `npm run db:migrate:local` 本地验证，再 `npm run db:migrate:remote`。已应用的迁移不要修改。
- 本地联调 API：`npm run dev:api`（打包后用 `wrangler pages dev`，数据在 `.wrangler/state`）。
- **机密不进仓库**：用 `npx wrangler@4 pages secret put HASH_SALT --project-name desk-defense`（必需）、`TURNSTILE_SECRET`（可选）。本地开发写在根目录 `.dev.vars`（已被 `.gitignore` 忽略）。AI 参战的模型密钥只存在玩家本机浏览器 / 环境变量里，不要写进代码、测试快照或报告。
- 改了 `src/shared/leaderboard.ts` 的校验或 `GAME_VERSION` 时，注意新旧客户端兼容（`ACCEPT_GAME_VERSIONS`），详见 [12 全服排行榜](docs/12-全服排行榜.md)。

## 发版与更新日志

- 版本号在 `package.json`，每个版本更新了什么写在 `src/meta/changelog.json`（最新在最前，简体中文必填，繁中 / 英 / 日条数与简中一致；缺的语言回退简中）。游戏内「设置 → 版本 · 更新日志」、升级提示卡片、`CHANGELOG.md`、GitHub Release 都从这里读。
- 发版：先在 `changelog.json` 最前面写好新版本的条目，再 `npm run release -- --deploy`；或直接 `npm run release -- patch|minor|major --deploy`，没写条目时用上个 tag 以来的提交标题生成简中条目。脚本会改版本号、生成 `CHANGELOG.md`、跑 `npm run check`、提交「发布 vX.Y.Z」、打 tag `vX.Y.Z` 并推送；`.github/workflows/release.yml` 收到 tag 后自动创建 GitHub Release。`--dry` 只打印步骤。
- 在线升级：构建时输出 `version.json`，已打开的页面每 10 分钟和切回前台时检查一次，发现新版本就自动激活新的 Service Worker 并刷新；正在对局、在 AI 设置页、开着对话框或正在输入时先挂起，空闲了再更新（`src/ui/update.ts`）。原生壳（Tauri / Capacitor）不走在线升级。
- 存档保留：升级只替换缓存里的页面和脚本，不动 localStorage。换版本时 `src/meta/backup.ts` 把进度、历史战绩、对战记录备份到 `desk-defense.backup.v1`（不含 AI 密钥）；存档 JSON 读坏时原文另存到 `desk-defense.profile.corrupt`。**改存档格式时只能加字段、做兼容读取，不要清空旧数据。**
