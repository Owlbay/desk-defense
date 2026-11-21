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
  'wall' | 'pencil' | 'stapler' | 'glue' | 'lamp' | 'compass' | 'eraser' | 'ruler' | 'pen' | 'calculator' | 'piggy' | 'swatter';

export const TOWER_IDS: TowerId[] = [
  'wall',
  'pencil',
  'stapler',
  'glue',
  'lamp',
  'compass',
  'eraser',
  'ruler',
  'pen',
  'calculator',
  'piggy',
  'swatter',
];

export type EnemyId =
  | 'crumb'
  | 'inkdot'
  | 'paperclip'
  | 'plane'
  | 'paperball'
  | 'sticky'
  | 'rubberband'
  | 'whiteout'
  | 'ant'
  | 'invisink'
  | 'tape'
  | 'moth'
  | 'crumbmini' // 纸团分裂出的小纸屑（美术复用 crumb，缩小 0.6）
  | 'goldbag' // 金币袋怪：只由随机事件召唤（文档 09 §3.2）
  | 'boss_coffee'
  | 'boss_coffee_small'
  | 'boss_shredder'
  | 'boss_inkbottle'
  | 'boss_alarm';

export type AffixId = 'hard' | 'swift' | 'regen' | 'shield' | 'split' | 'stealth' | 'reflect' | 'unstoppable' | 'rally' | 'golden'; // 金色精英：只由随机事件赋予，不参与随机抽取

export type SkillId =
  | 'eraser_strike'
  | 'bell'
  | 'whiteout_zone'
  | 'caffeine'
  | 'ruler_sweep'
  | 'scholarship'
  | 'relocate'
  | 'inspiration'
  | 'magnifier'
  | 'seal_tape'; // 封箱胶带：封掉一个空降出生点（文档 09 §2.2）

/** 随机事件（文档 09 §3.2） */
export type RandomEventId =
  // 负面
  | 'drop_box'
  | 'lamp_outage'
  | 'fan'
  | 'books_fall'
  | 'homework_check'
  | 'coffee_spill'
  | 'reinforce'
  | 'tea_break'
  | 'medic_squad'
  | 'shield_supply'
  // 正面
  | 'coins'
  | 'inspiration'
  | 'nap'
  | 'praise'
  | 'supply_crate'
  | 'goldbag'
  | 'bounty'
  | 'golden_elite'
  | 'training'
  // 中性
  | 'tidy'
  | 'wind'
  | 'secret_door'
  | 'frenzy';

export const RANDOM_EVENT_IDS: RandomEventId[] = [
  'drop_box',
  'lamp_outage',
  'fan',
  'books_fall',
  'homework_check',
  'coffee_spill',
  'reinforce',
  'tea_break',
  'medic_squad',
  'shield_supply',
  'coins',
  'inspiration',
  'nap',
  'praise',
  'supply_crate',
  'goldbag',
  'bounty',
  'golden_elite',
  'training',
  'tidy',
  'wind',
  'secret_door',
  'frenzy',
];

export type SpawnMode = 'fixed' | 'roundRobin' | 'random' | 'split' | 'focus';

export type TalentId = 'wallet' | 'bandaid' | 'alarm' | 'study' | 'secondhand' | 'bigbag' | 'luckydraw' | 'collector';

export type DifficultyId = 'easy' | 'normal' | 'hard' | 'nightmare' | 'abyss';
export type ModeId = 'campaign' | 'endless' | 'custom';
export type Branch = 'A' | 'B';
/** 1 草稿 / 2 精良 / 3 镀金 / 4 传奇 / 5 神话（传奇 ★3，文档 11） */
export type Tier = 1 | 2 | 3 | 4 | 5;
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
  eliteStart: number; // 0 或 >999 表示不出现
  eliteRate: number;
  eliteCap: number;
  maxAffix: number;
  bossHpMul: number;
  skillCdMul: number;
  interestCap: number;
  scoreMul: number;
  // ── 文档 09：动态战场 ──
  spawnMode: SpawnMode; // 默认出怪策略
  maxActiveSpawners: number; // 同时开放的出生点上限（含空降）
  maxDrops: number; // 同时存在的空降出生点上限
  dropWarn: number; // 空降预警秒数
  eventRate: number; // 随机事件频率倍率（0 = 关闭）
  eventHostile: number; // 负面事件占比 0..1
  waveGap: number; // 自动波次：本波刷完到下一波的倒计时（秒）
  waveMax: number; // 自动波次：每波上限时间（秒）
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
  /** 自动开波（文档 09 §4）；缺省 = 难度默认（简单为手动，其余为自动） */
  autoWave?: boolean;
  /** 战役使用固定杂物布局（不随机） */
  fixedLayout?: boolean;
  /** 单独关闭某些随机事件（自定义模式） */
  events?: Partial<Record<RandomEventId, boolean>>;
}

// ───────────────────────── 运行时状态（只读给 render/ui） ─────────────────────────

export type Phase = 'build' | 'wave' | 'perk' | 'won' | 'lost';

export const CellKind = { Empty: 0, Obstacle: 1, Tower: 2, Spawn: 3, Exit: 4 } as const;
export type CellKind = (typeof CellKind)[keyof typeof CellKind];

export interface Obstacle {
  kind:
    | 'cup'
    | 'books'
    | 'keyboard'
    | 'mouse'
    | 'palette'
    | 'paint'
    // 随机杂物（文档 09 §5）
    | 'eraser'
    | 'pencilcup'
    | 'sticky'
    | 'phone'
    | 'ruler'
    | 'tape'
    | 'stapler'
    | 'clip';
  x: number;
  y: number;
  w: number;
  h: number; // 格
}

export interface GridState {
  cols: number;
  rows: number;
  /** 长度 cols*rows，索引 y*cols+x，值为 CellKind */
  cells: Uint8Array;
  /** 每格的塔 uid（无塔为 0） */
  towerAt: Int32Array;
  /** 当前所有开放出生点的格子（兼容旧字段；详细信息见 WorldState.spawners） */
  spawns: { x: number; y: number }[];
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
  cx: number;
  cy: number; // 所在格
  level: number; // 1..10（墙 1..3）
  tier: Tier; // 由 level / branch 推出
  branch: Branch | null;
  xp: number; // 当前等级内的经验
  xpNext: number; // 升到下一级所需（满级为 0）
  /** 传奇进化星级（文档 11）；Lv10 之后的经验计入 evoXp */
  stars: 0 | 1 | 2 | 3;
  evoXp: number;
  evoXpNext: number; // 满星为 0
  /** ★3 主动能力剩余冷却（秒）；充能制能力见 abilityCharges */
  abilityCd: number;
  abilityCharges?: number;
  invested: number; // 已投入金币（出售依据）
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
  damage: number; // 累计伤害（结算 MVP）
  /** 相邻组合技是否激活（用于画连线）：与之配对的塔 uid 列表 */
  comboWith: number[];
  /** 台灯联动（文档 02 §2.5）：所在联动组编号（组内最小 uid；单独为 0）、组内座数 */
  prism?: number;
  prismSize?: number;
  /** 正在汇聚的主灯 uid（主灯和正在并入的辅灯上为同一值；没有汇聚为 0） */
  prismLead?: number;
  /** 主灯上：当前汇聚倍率（1 + Σ 辅灯加成）；其他为 1 */
  prismRelay?: number;
}

export interface EnemyState {
  uid: number;
  id: EnemyId;
  x: number;
  y: number; // 格坐标（浮点）
  angle: number; // 朝向
  hp: number;
  maxHp: number;
  shield: number;
  maxShield: number;
  armor: number;
  speed: number; // 当前基础速度（未计减速）
  radius: number; // 判定半径（格）
  scale: number; // 渲染缩放（精英 1.2、兵团等）
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
  slowPct: number;
  slowUntil: number;
  stunUntil: number;
  rootUntil: number;
  inkStacks: number;
  bleedStacks: number;
  burnUntil: number;
  markedUntil: number;
  /** 苍蝇拍·捕虫网：飞行敌人被网到地面，截止时间之前 flying=false 并按迷宫行走 */
  netUntil: number; // 红笔标记 / 护眼灯照射 / 修正带易伤
  /** 跳跃中（橡皮筋）——不可被选中 */
  jumping: boolean;
  /** 最近受击时间（渲染闪白） */
  lastHit: number;
  spawnedAt: number;
}

export type ProjectileKind = 'net' | 'graphite' | 'color' | 'glue' | 'ink' | 'brush' | 'ruler' | 'eraser' | 'nail'; // 工业钉枪「连环钉」（直线穿透）

export interface ProjectileState {
  uid: number;
  kind: ProjectileKind;
  x: number;
  y: number;
  angle: number;
  /** 'color' 弹的颜色：red / blue / yellow（彩色铅笔 ★2 增加 green 中毒 / purple 易伤） */
  color?: 'red' | 'blue' | 'yellow' | 'green' | 'purple';
  towerUid: number;
}

export type ZoneKind = 'glue' | 'hotglue' | 'whiteout' | 'tape' | 'magnifier' | 'coffee' | 'lava' | 'inkcross' | 'fullcorrect';

// ───────────────────────── 动态战场（文档 09） ─────────────────────────

export interface SpawnerState {
  id: string; // 'north' | 'west' | 'drop-3' | 'hidden-1' …
  /** 显示名（北入口 / 西入口 / 空降点 / 暗门） */
  name?: string;
  kind: 'edge' | 'hidden' | 'drop';
  cells: { x: number; y: number }[];
  /** 开放中（可出怪） */
  active: boolean;
  /** 空降：预警截止时间（之前为预警阶段，格子不可建造） */
  warnUntil?: number;
  /** 空降：在第几波结束后关闭 */
  expiresAfterWave?: number;
  /** 拆除价格（空降点） */
  demolishCost?: number;
  /** 纸箱上画的敌人图标（空降点） */
  icon?: EnemyId;
}

export interface RandomEventState {
  uid: number;
  id: RandomEventId;
  name: string;
  desc: string;
  tone: 'bad' | 'good' | 'neutral';
  phase: 'warn' | 'active' | 'done';
  startsAt: number; // 进入 active 的时间
  endsAt: number; // 结束时间（瞬时事件 = startsAt）
  /** 影响范围（格），渲染画预警框 */
  area?: { x: number; y: number; w: number; h: number };
}

export interface PickupState {
  uid: number;
  kind: 'coin' | 'crate';
  x: number;
  y: number; // 格坐标
  until: number;
  value: number; // 硬币金额
}

export interface CrateChoice {
  uid: number;
  options: { id: string; name: string; desc: string }[];
}

export interface ZoneState {
  uid: number;
  kind: ZoneKind;
  /** 圆形区域：x,y,r；矩形区域（whiteout 2×2、修正带）：x,y,w,h 左上角 + 角度 */
  shape: 'circle' | 'rect';
  x: number;
  y: number;
  r?: number;
  w?: number;
  h?: number;
  angle?: number;
  until: number;
  createdAt: number;
}

export interface SkillState {
  id: SkillId;
  level: number;
  cd: number; // 剩余冷却秒（0 = 就绪）
  cdMax: number;
  charges?: number; // 充能制技能（搬家）
  maxCharges?: number;
  /** 需要的目标类型 */
  target: 'none' | 'circle' | 'rect2' | 'line' | 'tower' | 'tower+cell' | 'spawner';
  radius?: number; // circle 半径（格）
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
  elite: number; // 其中精英数量
  affixes: AffixId[]; // 本组出现的词缀（去重）
  spawner: string; // 从哪个出生点出来（SpawnerState.id；split 策略为 '*'）
}

export interface WavePreview {
  wave: number; // 下一波的波号（1 起）
  tags: ('boss' | 'air' | 'rush')[];
  groups: WavePreviewGroup[];
  earlyBonus: number; // 现在提前开波可得金币（build 阶段为 0 以外的值仅在 wave 阶段有效）
}

export interface RunStats {
  kills: number;
  leaks: number;
  goldEarned: number;
  goldSpent: number;
  towersBuilt: number;
  skillsCast: number;
  /** 得分公式用的"最后完整清掉的波数"（排行榜重算得分用） */
  cleared: number;
  /** 累计的老师表扬等额外得分（排行榜重算得分用） */
  bonus: number;
}

export interface WorldState {
  opts: RunOptions;
  params: DifficultyParams; // 实际生效的参数（含魔境/自定义）
  seed: string;
  tick: number;
  time: number; // 秒
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
  perks: string[]; // 已获得的增益 id
  perkChoices: PerkCard[] | null; // phase === 'perk' 时有值
  perkRerollCost: number; // 刷新价格（0 = 免费）
  nextWave: WavePreview;
  /** 塔在战役中是否已解锁 */
  unlockedTowers: TowerId[];
  /** 全局增益：咖啡因截止时间等（渲染可做全屏色调） */
  caffeineUntil: number;
  /** 文档 09 */
  spawners: SpawnerState[];
  events: RandomEventState[]; // 预警中 / 进行中 + 最近结束的（保留 30 秒）
  eventLog: { wave: number; id: RandomEventId; name: string }[];
  pickups: PickupState[];
  crateChoice: CrateChoice | null; // 打开补给箱后待选择（不暂停游戏）
  autoWave: {
    enabled: boolean;
    /** 已开始自动模式（第一波由玩家开始之后） */
    started: boolean;
    /** 下一波自动开始的时间（state.time）；null = 未在倒计时 */
    nextAt: number | null;
    /** 当前波的上限时间 */
    deadline: number | null;
    /** 因同时进行波次已达上限而暂停倒计时 */
    blocked: boolean;
  };
  /** Boss 血条：场上所有 Boss 的 uid */
  bossUids: number[];
  stats: RunStats;
}

// ───────────────────────── 指令 ─────────────────────────

export type Command =
  | { type: 'place'; tower: TowerId; cx: number; cy: number }
  | { type: 'upgrade'; uid: number; branch?: Branch } // Lv9→10 必须带 branch；墙 Lv1→3
  | { type: 'sell'; uid: number } // 若可撤销则全额退款
  | { type: 'setTarget'; uid: number; mode: TargetMode }
  | { type: 'startWave' } // build 阶段开波；wave 阶段 = 提前开下一波
  | { type: 'cast'; skill: SkillId; x?: number; y?: number; uid?: number; cx?: number; cy?: number; axis?: 'row' | 'col'; spawner?: string }
  /** 传奇在望：uid 为目标塔，branch 为直接进入的传奇分支 */
  | { type: 'choosePerk'; id: string; uid?: number; branch?: Branch }
  | { type: 'rerollPerks' }
  // 文档 09
  | { type: 'collect'; uid: number }
  | { type: 'chooseCrate'; option: string }
  | { type: 'demolishSpawner'; id: string }
  // 文档 11
  | { type: 'evolve'; uid: number }
  | { type: 'towerAbility'; uid: number; x?: number; y?: number; angle?: number; axis?: 'row' | 'col'; index?: number; targetUid?: number };

export interface CommandResult {
  ok: boolean;
  /** 失败原因（当前语言的短句，直接展示给玩家；i18n key 为 core.reason.<code>） */
  reason?: string;
  /** 失败原因的稳定标识（与语言无关，程序判断请用它，不要比较 reason 文本） */
  code?: string;
}

// ───────────────────────── 事件（core → render/ui，每步产出，调用 drainEvents 取走） ─────────────────────────

export type GameEvent =
  | { type: 'place'; uid: number; tower: TowerId; cx: number; cy: number }
  | { type: 'sell'; uid: number; tower: TowerId; cx: number; cy: number; refund: number }
  | { type: 'levelUp'; uid: number; level: number; tier: Tier; tierChanged: boolean; byXp: boolean }
  | { type: 'fire'; uid: number; tower: TowerId; x: number; y: number; tx: number; ty: number }
  /** 光束；台灯另带 ramp（递增进度 0..1）、relay（汇聚倍率）、group（参与汇聚的座数，含主灯） */
  | {
      type: 'beam';
      uid: number;
      x: number;
      y: number;
      tx: number;
      ty: number;
      color: 'warm' | 'cyan' | 'magenta';
      width: number;
      ramp?: number;
      relay?: number;
      group?: number;
    }
  /** 台灯联动：辅灯 from 把光并入主灯 to（每跳一次） */
  | { type: 'prismLink'; from: number; to: number; x: number; y: number; tx: number; ty: number }
  | { type: 'pulse'; x: number; y: number; r: number; color: 'steel' | 'cyan' | 'magenta' | 'gold' | 'ink' }
  | { type: 'sweep'; uid: number; x: number; y: number; r0: number; r1: number; angle: number; arc: number }
  | { type: 'hit'; enemyUid: number; x: number; y: number; amount: number; crit: boolean; kind: 'normal' | 'shield' | 'true' | 'dot' }
  | { type: 'immune'; x: number; y: number }
  | { type: 'dodge'; x: number; y: number }
  | { type: 'heal'; x: number; y: number; amount: number }
  | { type: 'death'; enemyUid: number; enemy: EnemyId; x: number; y: number; gold: number; boss: boolean; elite: boolean; goldMul?: number }
  | { type: 'split'; x: number; y: number; enemy: EnemyId }
  | { type: 'leak'; enemy: EnemyId; lives: number; stolenGold: number }
  | { type: 'spawn'; enemyUid: number; enemy: EnemyId; boss: boolean }
  | { type: 'bossSkill'; enemyUid: number; skill: 'spill' | 'shred' | 'inkShield' | 'inkCloud' | 'ring'; x: number; y: number; r: number }
  | { type: 'towerDisabled'; uid: number; until: number }
  | { type: 'skill'; skill: SkillId; x?: number; y?: number; r?: number; cx?: number; cy?: number; axis?: 'row' | 'col'; uid?: number }
  | {
      type: 'gold';
      amount: number;
      x?: number;
      y?: number;
      reason: 'kill' | 'wave' | 'interest' | 'early' | 'piggy' | 'skill' | 'perk' | 'refund' | 'stolen' | 'color' | 'pickup';
    }
  | { type: 'waveStart'; wave: number; tags: WavePreview['tags'] }
  | { type: 'waveEnd'; wave: number; bonus: number; interest: number; piggy: number }
  | { type: 'perkOffer'; cards: PerkCard[] }
  | { type: 'perkChosen'; id: string }
  | { type: 'gameOver'; won: boolean; wave: number; score: number }
  /** text 为发出时按当前语言生成的文本；key / params 供需要换语言重新生成的消费者（如 AI 参战用源语言） */
  | { type: 'toast'; text: string; tone: 'info' | 'warn' | 'good'; key?: string; params?: Record<string, string | number> }
  /** 苍蝇拍：拍击（x,y 为落点，r 为拍击半径） / 电蚊拍连锁闪电（points 依次连接） */
  | { type: 'swat'; uid: number; x: number; y: number; r: number }
  | { type: 'chain'; uid: number; points: { x: number; y: number }[] }
  // 文档 09
  | {
      type: 'randomEvent';
      uid: number;
      id: RandomEventId;
      phase: 'warn' | 'start' | 'end';
      name: string;
      desc: string;
      tone: 'bad' | 'good' | 'neutral';
      area?: { x: number; y: number; w: number; h: number };
    }
  | { type: 'spawnerDrop'; id: string; x: number; y: number; phase: 'warn' | 'land' | 'close' | 'demolish' }
  | { type: 'terrainChanged'; reason: 'event' | 'drop' | 'tidy' }
  | { type: 'pickup'; uid: number; kind: 'coin' | 'crate'; x: number; y: number; phase: 'spawn' | 'collect' | 'expire'; value?: number }
  | { type: 'autoWave'; secondsLeft: number } // 倒计时剩 3/2/1 秒时各发一次
  | { type: 'towerMoved'; uid: number; fromX: number; fromY: number; cx: number; cy: number }
  // 文档 11
  | { type: 'evolve'; uid: number; stars: number; mythic: boolean }
  | {
      type: 'towerAbility';
      uid: number;
      ability: string;
      x?: number;
      y?: number;
      r?: number;
      angle?: number;
      axis?: 'row' | 'col';
      index?: number;
      targetUid?: number;
    };

// ───────────────────────── 给 UI 的计算视图 ─────────────────────────

export interface BuildOption {
  id: TowerId;
  name: string;
  cost: number;
  affordable: boolean;
  unlocked: boolean;
  hitsAir: boolean;
  hitsGround: boolean;
  role: string; // 定位短语："单体"、"减速"…
  desc: string; // 一句话说明
  limitReached?: boolean; // 存钱罐上限
}

export interface StatLine {
  label: string; // "伤害"、"攻击间隔"、"射程"…
  value: string; // 已格式化
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
  tierName: string; // 草稿 / 精良 / 镀金 / 传奇·xxx
  branch: Branch | null;
  xp: number;
  xpNext: number;
  xpCapped: boolean; // 已到经验上限（Lv9；Lv10 后经验计入进化）
  /** 文档 11：传奇进化 */
  stars: number;
  evoXp: number;
  evoXpNext: number;
  evolveCost: number | null; // null = 不能进化（未到 Lv10 / 已满星 / 书本墙）
  evolveDiscount: number;
  canAffordEvolve: boolean;
  evoTraits: TraitLine[]; // 当前分支 ★1/★2 特性（unlockLevel 用 11/12 表示 ★1/★2）
  ability?: {
    id: string;
    name: string;
    desc: string;
    cd: number;
    cdMax: number;
    ready: boolean;
    charges?: number;
    maxCharges?: number;
    target: 'none' | 'circle' | 'rect3' | 'direction' | 'axis' | 'enemy' | 'tower';
    radius?: number;
  };
  stats: StatLine[];
  traits: TraitLine[];
  range: number; // 当前射程（格），渲染射程圈；无攻击为 0
  innerRange?: number; // 圆规内圈
  auraRange?: number; // 计算器光环
  upgradeCost: number | null; // null = 已满级
  upgradeDiscount: number; // 经验折扣比例 0..0.5
  needsBranch: boolean;
  branches?: { A: { name: string; desc: string }; B: { name: string; desc: string } };
  canAffordUpgrade: boolean;
  sellValue: number;
  refundRate: number; // 0..1
  canUndo: boolean;
  undoRemaining: number; // 秒
  targetMode: TargetMode | null; // 无攻击的塔为 null
  targetModes: TargetMode[];
  kills: number;
  damage: number;
}

export interface PlaceCheck {
  ok: boolean;
  /** 当前语言的原因文本 */
  reason?: string;
  /** 稳定的原因标识（core.reason.<code>） */
  code?: string;
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
