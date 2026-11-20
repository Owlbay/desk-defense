/**
 * 书桌防线 —— 模块间接口契约（core ⇄ render ⇄ ui）
 *
 * 规则：
 *  - core/ 不引用 DOM / Phaser，可在 Node 中运行（平衡模拟、测试）。
 *  - render/ 与 ui/ 只通过本文件定义的类型与 IWorld 方法读取状态、发送指令。
 *  - 逻辑坐标单位为「格」（浮点）。格子 (cx, cy) 的中心为 (cx + 0.5, cy + 0.5)。
 *    渲染层自行乘以像素尺寸（CELL_PX = 48）。
 *  - 角度为弧度，0 指向 +X，逆时针为正（与 Math.atan2(dy, dx) 一致）；屏幕 Y 向下。
 *  - 时间单位：逻辑以固定步长推进，每步 DT 秒；state.time 为累计秒数。
 */

export const DT = 1 / 60;
export const CELL_PX = 48;
export const GRID_COLS = 12;
export const GRID_ROWS = 14;

// ───────────────────────── 标识符 ─────────────────────────

export type TowerId =
  | 'wall' | 'pencil' | 'stapler' | 'glue' | 'lamp' | 'compass'
  | 'eraser' | 'ruler' | 'pen' | 'calculator' | 'piggy';

export const TOWER_IDS: TowerId[] = [
  'wall', 'pencil', 'stapler', 'glue', 'lamp', 'compass',
  'eraser', 'ruler', 'pen', 'calculator', 'piggy',
];

export type EnemyId =
  | 'crumb' | 'inkdot' | 'paperclip' | 'plane' | 'paperball' | 'sticky'
  | 'rubberband' | 'whiteout' | 'ant' | 'invisink' | 'tape' | 'moth'
  | 'crumbmini'            // 纸团分裂出的小纸屑（美术复用 crumb，缩小 0.6）
  | 'boss_coffee' | 'boss_coffee_small' | 'boss_shredder' | 'boss_inkbottle' | 'boss_alarm';

export type AffixId =
  | 'hard' | 'swift' | 'regen' | 'shield' | 'split'
  | 'stealth' | 'reflect' | 'unstoppable' | 'rally';

export type SkillId =
  | 'eraser_strike' | 'bell' | 'whiteout_zone' | 'caffeine' | 'ruler_sweep'
  | 'scholarship' | 'relocate' | 'inspiration' | 'magnifier';

export type TalentId =
  | 'wallet' | 'bandaid' | 'alarm' | 'study' | 'secondhand'
  | 'bigbag' | 'luckydraw' | 'collector';

export type DifficultyId = 'easy' | 'normal' | 'hard' | 'nightmare' | 'abyss';
export type ModeId = 'campaign' | 'endless' | 'custom';
export type Branch = 'A' | 'B';
export type Tier = 1 | 2 | 3 | 4;
export type TargetMode = 'first' | 'last' | 'strong' | 'weak' | 'close' | 'air';
export type Rarity = 'common' | 'rare' | 'epic';
export type MapId = 'ch1' | 'ch2' | 'ch3';

// ───────────────────────── 难度参数（文档 04 §2.1） ─────────────────────────

export interface DifficultyParams {
  startGold: number;
  lives: number;
  hpMul: number;
  hpLinear: number;
  hpExp: number;
  countMul: number;
  countGrowth: number;
  speedMul: number;
  armorStep: number;
  rewardMul: number;
  xpMul: number;
  eliteStart: number;   // 0 或 >999 表示不出现
  eliteRate: number;
  eliteCap: number;
  maxAffix: number;
  bossHpMul: number;
  skillCdMul: number;
  interestCap: number;
  scoreMul: number;
}

// ───────────────────────── 开局参数 ─────────────────────────

export interface RunOptions {
  mode: ModeId;
  map: MapId;
  /** 战役：normal | hard；无尽：任意；自定义：作为初始预设 */
  difficulty: DifficultyId;
  /** 魔境等级 1..10（difficulty === 'abyss' 时有效） */
  abyssLevel?: number;
  /** 自定义模式下覆盖的参数 */
  custom?: Partial<DifficultyParams>;
  /** 随机种子；缺省时由 core 生成 */
  seed?: string;
  /** 带入的主动技能（3 或 4 个） */
  skills: SkillId[];
  /** 技能等级 1..3，缺省为 1 */
  skillLevels?: Partial<Record<SkillId, number>>;
  /** 永久天赋等级；pure = true 时 core 忽略 */
  talents?: Partial<Record<TalentId, number>>;
  pure?: boolean;
}

// ───────────────────────── 运行时状态（只读给 render/ui） ─────────────────────────

export type Phase = 'build' | 'wave' | 'perk' | 'won' | 'lost';

export const CellKind = { Empty: 0, Obstacle: 1, Tower: 2, Spawn: 3, Exit: 4 } as const;
export type CellKind = (typeof CellKind)[keyof typeof CellKind];

export interface Obstacle {
  kind: 'cup' | 'books' | 'keyboard' | 'mouse' | 'palette' | 'paint';
  x: number; y: number; w: number; h: number;   // 格
}

export interface GridState {
  cols: number;
  rows: number;
  /** 长度 cols*rows，索引 y*cols+x，值为 CellKind */
  cells: Uint8Array;
  /** 每格的塔 uid（无塔为 0） */
  towerAt: Int32Array;
  spawns: { x: number; y: number }[];   // 入口格（每个入口 2 格，列出全部格）
  exits: { x: number; y: number }[];
  obstacles: Obstacle[];
  /** 流场：到出口的距离（不可达为 Infinity）；每次地形变化后更新 */
  dist: Float32Array;
  /** 地形版本号，每次变化 +1，便于渲染层缓存 */
  version: number;
}

export interface TowerState {
  uid: number;
  id: TowerId;
  cx: number; cy: number;              // 所在格
  level: number;                        // 1..10（墙 1..3）
  tier: Tier;                           // 由 level / branch 推出
  branch: Branch | null;
  xp: number;                           // 当前等级内的经验
  xpNext: number;                       // 升到下一级所需（满级为 0）
  mastery: number;                      // 熟练度（Lv10 后）
  invested: number;                     // 已投入金币（出售依据）
  targetMode: TargetMode;
  /** 炮台朝向（弧度） */
  angle: number;
  /** 最近一次开火的时间（state.time），渲染做后坐/闪光 */
  lastFire: number;
  /** 瘫痪（咖啡渍泼洒）截止时间 */
  disabledUntil: number;
  /** 放置时间；undoUntil 之前且未攻击过可撤销全额退款 */
  placedAt: number;
  undoUntil: number;
  kills: number;
  damage: number;                       // 累计伤害（结算 MVP）
  /** 相邻组合技是否激活（用于画连线）：与之配对的塔 uid 列表 */
  comboWith: number[];
}

export interface EnemyState {
  uid: number;
  id: EnemyId;
  x: number; y: number;                 // 格坐标（浮点）
  angle: number;                        // 朝向
  hp: number; maxHp: number;
  shield: number; maxShield: number;
  armor: number;
  speed: number;                        // 当前基础速度（未计减速）
  radius: number;                       // 判定半径（格）
  scale: number;                        // 渲染缩放（精英 1.2、兵团等）
  flying: boolean;
  boss: boolean;
  elite: boolean;
  affixes: AffixId[];
  /** 兵团合并数量（1 为普通） */
  group: number;
  /** 当前是否处于隐形且未被侦测（不可被选中） */
  hidden: boolean;
  /** 具备隐形能力（渲染画半透明轮廓/被侦测时的眼睛标记） */
  stealthy: boolean;
  slowPct: number; slowUntil: number;
  stunUntil: number;
  rootUntil: number;
  inkStacks: number;
  bleedStacks: number;
  burnUntil: number;
  markedUntil: number;                  // 红笔标记 / 护眼灯照射 / 修正带易伤
  /** 跳跃中（橡皮筋）——不可被选中 */
  jumping: boolean;
  /** 最近受击时间（渲染闪白） */
  lastHit: number;
  spawnedAt: number;
}

export type ProjectileKind = 'graphite' | 'color' | 'glue' | 'ink' | 'brush' | 'ruler' | 'eraser';

export interface ProjectileState {
  uid: number;
  kind: ProjectileKind;
  x: number; y: number;
  angle: number;
  /** 'color' 弹的颜色：red / blue / yellow */
  color?: 'red' | 'blue' | 'yellow';
  towerUid: number;
}

export type ZoneKind = 'glue' | 'hotglue' | 'whiteout' | 'tape' | 'magnifier';

export interface ZoneState {
  uid: number;
  kind: ZoneKind;
  /** 圆形区域：x,y,r；矩形区域（whiteout 2×2、修正带）：x,y,w,h 左上角 + 角度 */
  shape: 'circle' | 'rect';
  x: number; y: number; r?: number; w?: number; h?: number; angle?: number;
  until: number;
  createdAt: number;
}

export interface SkillState {
  id: SkillId;
  level: number;
  cd: number;            // 剩余冷却秒（0 = 就绪）
  cdMax: number;
  charges?: number;      // 充能制技能（搬家）
  maxCharges?: number;
  /** 需要的目标类型 */
  target: 'none' | 'circle' | 'rect2' | 'line' | 'tower' | 'tower+cell';
  radius?: number;       // circle 半径（格）
  ready: boolean;
}

export interface PerkCard {
  id: string;
  name: string;
  desc: string;
  rarity: Rarity;
  /** 需要再选一座塔作为目标（如"传奇在望"） */
  needsTower?: boolean;
}

export interface WavePreviewGroup {
  enemy: EnemyId;
  count: number;
  elite: number;           // 其中精英数量
  affixes: AffixId[];      // 本组出现的词缀（去重）
}

export interface WavePreview {
  wave: number;            // 下一波的波号（1 起）
  tags: ('boss' | 'air' | 'rush')[];
  groups: WavePreviewGroup[];
  earlyBonus: number;      // 现在提前开波可得金币（build 阶段为 0 以外的值仅在 wave 阶段有效）
}

export interface RunStats {
  kills: number;
  leaks: number;
  goldEarned: number;
  goldSpent: number;
  towersBuilt: number;
  skillsCast: number;
}

export interface WorldState {
  opts: RunOptions;
  params: DifficultyParams;   // 实际生效的参数（含魔境/自定义）
  seed: string;
  tick: number;
  time: number;               // 秒
  phase: Phase;
  /** 当前（或最近一次）进行中的波号；开局为 0 */
  wave: number;
  /** 战役总波数（20）；无尽为 0 表示不封顶 */
  totalWaves: number;
  gold: number;
  lives: number;
  maxLives: number;
  score: number;
  grid: GridState;
  towers: Map<number, TowerState>;
  enemies: EnemyState[];
  projectiles: ProjectileState[];
  zones: ZoneState[];
  skills: SkillState[];
  perks: string[];            // 已获得的增益 id
  perkChoices: PerkCard[] | null;  // phase === 'perk' 时有值
  perkRerollCost: number;     // 刷新价格（0 = 免费）
  nextWave: WavePreview;
  /** 塔在战役中是否已解锁 */
  unlockedTowers: TowerId[];
  /** 全局增益：咖啡因截止时间等（渲染可做全屏色调） */
  caffeineUntil: number;
  /** Boss 血条：场上所有 Boss 的 uid */
  bossUids: number[];
  stats: RunStats;
}

// ───────────────────────── 指令 ─────────────────────────

export type Command =
  | { type: 'place'; tower: TowerId; cx: number; cy: number }
  | { type: 'upgrade'; uid: number; branch?: Branch }   // Lv9→10 必须带 branch；墙 Lv1→3
  | { type: 'sell'; uid: number }                        // 若可撤销则全额退款
  | { type: 'setTarget'; uid: number; mode: TargetMode }
  | { type: 'startWave' }                                // build 阶段开波；wave 阶段 = 提前开下一波
  | { type: 'cast'; skill: SkillId; x?: number; y?: number; uid?: number; cx?: number; cy?: number; axis?: 'row' | 'col' }
  /** 传奇在望：uid 为目标塔，branch 为直接进入的传奇分支 */
  | { type: 'choosePerk'; id: string; uid?: number; branch?: Branch }
  | { type: 'rerollPerks' };

export interface CommandResult {
  ok: boolean;
  /** 失败原因（中文短句，直接展示给玩家） */
  reason?: string;
}

// ───────────────────────── 事件（core → render/ui，每步产出，调用 drainEvents 取走） ─────────────────────────

export type GameEvent =
  | { type: 'place'; uid: number; tower: TowerId; cx: number; cy: number }
  | { type: 'sell'; uid: number; tower: TowerId; cx: number; cy: number; refund: number }
  | { type: 'levelUp'; uid: number; level: number; tier: Tier; tierChanged: boolean; byXp: boolean }
  | { type: 'fire'; uid: number; tower: TowerId; x: number; y: number; tx: number; ty: number }
  | { type: 'beam'; uid: number; x: number; y: number; tx: number; ty: number; color: 'warm' | 'cyan' | 'magenta'; width: number }
  | { type: 'pulse'; x: number; y: number; r: number; color: 'steel' | 'cyan' | 'magenta' | 'gold' | 'ink' }
  | { type: 'sweep'; uid: number; x: number; y: number; r0: number; r1: number; angle: number; arc: number }
  | { type: 'hit'; enemyUid: number; x: number; y: number; amount: number; crit: boolean; kind: 'normal' | 'shield' | 'true' | 'dot' }
  | { type: 'immune'; x: number; y: number }
  | { type: 'dodge'; x: number; y: number }
  | { type: 'heal'; x: number; y: number; amount: number }
  | { type: 'death'; enemyUid: number; enemy: EnemyId; x: number; y: number; gold: number; boss: boolean; elite: boolean }
  | { type: 'split'; x: number; y: number; enemy: EnemyId }
  | { type: 'leak'; enemy: EnemyId; lives: number; stolenGold: number }
  | { type: 'spawn'; enemyUid: number; enemy: EnemyId; boss: boolean }
  | { type: 'bossSkill'; enemyUid: number; skill: 'spill' | 'shred' | 'inkShield' | 'inkCloud' | 'ring'; x: number; y: number; r: number }
  | { type: 'towerDisabled'; uid: number; until: number }
  | { type: 'skill'; skill: SkillId; x?: number; y?: number; r?: number; cx?: number; cy?: number; axis?: 'row' | 'col'; uid?: number }
  | { type: 'gold'; amount: number; x?: number; y?: number; reason: 'kill' | 'wave' | 'interest' | 'early' | 'piggy' | 'skill' | 'perk' | 'refund' | 'stolen' | 'color' }
  | { type: 'waveStart'; wave: number; tags: WavePreview['tags'] }
  | { type: 'waveEnd'; wave: number; bonus: number; interest: number; piggy: number }
  | { type: 'perkOffer'; cards: PerkCard[] }
  | { type: 'perkChosen'; id: string }
  | { type: 'gameOver'; won: boolean; wave: number; score: number }
  | { type: 'toast'; text: string; tone: 'info' | 'warn' | 'good' };

// ───────────────────────── 给 UI 的计算视图 ─────────────────────────

export interface BuildOption {
  id: TowerId;
  name: string;
  cost: number;
  affordable: boolean;
  unlocked: boolean;
  hitsAir: boolean;
  hitsGround: boolean;
  role: string;           // 定位短语："单体"、"减速"…
  desc: string;           // 一句话说明
  limitReached?: boolean; // 存钱罐上限
}

export interface StatLine {
  label: string;          // "伤害"、"攻击间隔"、"射程"…
  value: string;          // 已格式化
}

export interface TraitLine {
  name: string;
  desc: string;
  unlockLevel: number;
  unlocked: boolean;
}

export interface TowerInfo {
  uid: number;
  id: TowerId;
  name: string;
  level: number;
  maxLevel: number;
  tier: Tier;
  tierName: string;       // 草稿 / 精良 / 镀金 / 传奇·xxx
  branch: Branch | null;
  xp: number;
  xpNext: number;
  xpCapped: boolean;      // 已到经验上限（Lv9 / Lv10）
  mastery: number;
  stats: StatLine[];
  traits: TraitLine[];
  range: number;          // 当前射程（格），渲染射程圈；无攻击为 0
  innerRange?: number;    // 圆规内圈
  auraRange?: number;     // 计算器光环
  upgradeCost: number | null;   // null = 已满级
  upgradeDiscount: number;      // 经验折扣比例 0..0.5
  needsBranch: boolean;
  branches?: { A: { name: string; desc: string }; B: { name: string; desc: string } };
  canAffordUpgrade: boolean;
  sellValue: number;
  refundRate: number;           // 0..1
  canUndo: boolean;
  undoRemaining: number;        // 秒
  targetMode: TargetMode | null; // 无攻击的塔为 null
  targetModes: TargetMode[];
  kills: number;
  damage: number;
}

export interface PlaceCheck {
  ok: boolean;
  reason?: string;
}

// ───────────────────────── World 接口 ─────────────────────────

export interface IWorld {
  readonly state: WorldState;
  /** 推进一个固定步长 */
  step(): void;
  command(cmd: Command): CommandResult;
  /** 取走自上次调用以来产生的事件 */
  drainEvents(): GameEvent[];

  canPlace(tower: TowerId, cx: number, cy: number): PlaceCheck;
  /** 放置后的预览路径（从每个入口沿流场到出口的格序列），用于显示路线变化；不可放时返回 null */
  previewPath(tower: TowerId | null, cx: number, cy: number): { x: number; y: number }[][] | null;
  /** 当前路径（无假设放置） */
  currentPaths(): { x: number; y: number }[][];
  getBuildOptions(): BuildOption[];
  getTowerInfo(uid: number): TowerInfo | null;
  /** 某类塔 Lv1 的射程（放置预览画圈） */
  baseRange(tower: TowerId): { range: number; inner?: number; aura?: number };
  /** 敌人显示名 */
  enemyName(id: EnemyId): string;
  /** 指令序列（回放/中途存档） */
  readonly log: { tick: number; cmd: Command }[];
}
