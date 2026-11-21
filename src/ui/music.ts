/**
 * 原创生成式配乐（纯 WebAudio，无音频文件）。
 *
 * - 6 种状态：菜单、布防、波次、Boss、胜利 / 失败短乐句
 * - 4 套曲风（MusicStyle），每套给 4 个循环状态各写一首曲子：
 *     chip    「铅笔芯片」：脉冲波 8-bit + 铅笔敲桌的「嗒」声（新）
 *     wood    「木琴拨弦」：暖色钢琴华尔兹、马林巴 + 拨弦、12/8 与 7/8 的律动（新）
 *     night   「夜灯合成器」：失谐锯齿铺底、八度脉动低音、门限军鼓的合成器浪潮（新）
 *     classic 「台灯原声」：最早的那一套（lo-fi 书桌 / 拨弦琶音 / 推进 / 弗里吉亚）
 * - 播放列表：默认「自动轮换」——每局开始换一套战斗曲风、回到菜单换一首菜单曲，
 *   同一状态听够一段时间（几轮循环）后也会交叉淡化到下一套；首轮只在新曲风里抽，之后四套轮流
 *   设置里也可以固定某一套（setStylePref）
 * - 状态切换时新旧曲目交叉淡入淡出；短乐句播完自动回到菜单曲
 * - 省电：setInterval + lookahead 预排音符；每首曲子的滤波 / 打击乐滤波器常驻复用；
 *   自定义波形（脉冲 / 钢琴 / 马林巴）只在构造时生成一次；
 *   标签页隐藏时停掉调度器（AudioContext 由 audio.ts 负责 suspend）
 *
 * 音乐不影响对局结果，所以可以随意用 Math.random。
 */

export type MusicState = 'menu' | 'build' | 'wave' | 'boss' | 'victory' | 'defeat';
export type MusicStyle = 'chip' | 'wood' | 'night' | 'classic';
export type MusicStylePref = 'auto' | MusicStyle;
/** 设置里的顺序：新曲风在前 */
export const MUSIC_STYLES: readonly MusicStyle[] = ['chip', 'wood', 'night', 'classic'];
const NEW_STYLES: readonly MusicStyle[] = ['chip', 'wood', 'night'];

type LoopState = 'menu' | 'build' | 'wave' | 'boss';
const isLoop = (s: MusicState): s is LoopState => s !== 'victory' && s !== 'defeat';
const isBattle = (s: MusicState) => s === 'build' || s === 'wave' || s === 'boss';
/** 自动轮换：同一组（菜单 / 战斗）听了这么多秒后，在下一个 4 小节循环结束时换曲风 */
const ROTATE_SEC = { menu: 100, battle: 150 } as const;

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const rand = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];
const chance = (p: number) => Math.random() < p;

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
const MIXOLYDIAN = [0, 2, 4, 5, 7, 9, 10];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];
const HARMONIC = [0, 2, 3, 5, 7, 8, 11];

const shuffle = <T>(xs: T[]): T[] => {
  for (let k = xs.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1));
    [xs[k], xs[j]] = [xs[j], xs[k]];
  }
  return xs;
};

/** 调度参数 */
const TICK_MS = 50;
const LOOKAHEAD = 0.2;
const MAX_VOICES = 72;

/** 旋律节奏型：[16 分音符位置, 时值]，两小节（32 步）内 */
type Rhythm = readonly (readonly [number, number])[];
const RHYTHM_SPARSE: Rhythm[] = [
  [
    [0, 6],
    [6, 2],
    [8, 8],
    [20, 4],
    [24, 8],
  ],
  [
    [2, 2],
    [4, 4],
    [10, 6],
    [16, 6],
    [24, 4],
    [28, 4],
  ],
  [
    [0, 3],
    [3, 3],
    [6, 10],
    [22, 2],
    [24, 8],
  ],
];
const RHYTHM_MID: Rhythm[] = [
  [
    [0, 2],
    [2, 2],
    [4, 4],
    [8, 2],
    [10, 2],
    [12, 4],
    [16, 2],
    [18, 2],
    [20, 4],
    [24, 8],
  ],
  [
    [0, 3],
    [3, 3],
    [6, 2],
    [8, 4],
    [12, 4],
    [16, 3],
    [19, 3],
    [22, 2],
    [24, 6],
  ],
  [
    [0, 4],
    [4, 2],
    [6, 2],
    [8, 6],
    [14, 2],
    [16, 4],
    [20, 4],
    [24, 4],
    [28, 4],
  ],
];
const RHYTHM_LONG: Rhythm[] = [
  [
    [0, 8],
    [8, 4],
    [12, 4],
    [16, 12],
    [28, 4],
  ],
  [
    [0, 4],
    [4, 4],
    [8, 8],
    [16, 6],
    [22, 2],
    [24, 8],
  ],
];

/** 单小节节奏型（用于非 4/4 的曲子）：[步位置, 时值] */
const CELLS_WALTZ: Rhythm[] = [
  [
    [0, 4],
    [4, 4],
    [8, 4],
  ],
  [
    [0, 6],
    [6, 2],
    [8, 4],
  ],
  [
    [0, 8],
    [8, 2],
    [10, 2],
  ],
  [
    [0, 4],
    [4, 8],
  ],
];
/** 12/8：每拍 3 步 */
const CELLS_GALLOP: Rhythm[] = [
  [
    [0, 3],
    [3, 3],
    [6, 3],
    [9, 3],
  ],
  [
    [0, 2],
    [2, 1],
    [3, 3],
    [6, 6],
  ],
  [
    [0, 6],
    [6, 3],
    [9, 3],
  ],
  [
    [0, 3],
    [3, 2],
    [5, 1],
    [6, 6],
  ],
];
/** 7/8（2+2+3 个八分音符 = 4+4+6 步） */
const CELLS_SEVEN: Rhythm[] = [
  [
    [0, 4],
    [4, 4],
    [8, 6],
  ],
  [
    [0, 2],
    [2, 2],
    [4, 4],
    [8, 3],
    [11, 3],
  ],
  [
    [0, 8],
    [8, 6],
  ],
  [
    [0, 4],
    [4, 2],
    [6, 2],
    [8, 6],
  ],
];

interface Def {
  bpm: number;
  /** 每拍几步（默认 4 = 16 分音符；12/8 用 3） */
  sub?: number;
  /** 每小节几步（默认 16；华尔兹 12、7/8 是 14） */
  meter?: number;
  /** 打击乐滤波：踩镲高通 / 军鼓带通（铅笔敲击、木鱼用高 Q 带通） */
  hatHz?: number;
  snareHz?: number;
  snareQ?: number;
  /** 奇数 16 分音符的延后量（占一个 16 分音符的比例） */
  swing: number;
  tonic: number;
  scale: readonly number[];
  /** 每小节一个和弦（音阶级数，0 起） */
  prog: readonly number[];
  cutoff: number;
  echo: number;
  level: number;
  fadeIn: number;
  /** 有限长度（短乐句），播完切到 then */
  bars?: number;
  then?: MusicState;
}

const LOOPS: Record<MusicStyle, Record<LoopState, Def>> = {
  classic: {
    // 《台灯下》：ii–V–I–vi，摇摆的 lo-fi 节奏 + 唱片底噪
    menu: { bpm: 74, swing: 0.22, tonic: 60, scale: MAJOR, prog: [1, 4, 0, 5], cutoff: 2300, echo: 0.28, level: 1, fadeIn: 2.2 },
    // 《便利贴》：I–V–vi–IV，拨弦琶音
    build: { bpm: 96, swing: 0.1, tonic: 65, scale: MAJOR, prog: [0, 4, 5, 3], cutoff: 4200, echo: 0.2, level: 0.95, fadeIn: 1.6 },
    // 《纸页边缘》：i–VI–III–VII，八分音符推进的低音
    wave: { bpm: 120, swing: 0, tonic: 57, scale: MINOR, prog: [0, 5, 2, 6], cutoff: 5200, echo: 0.14, level: 1.15, fadeIn: 0.7 },
    // 《红墨水》：弗里吉亚 i–bII–i–vii，16 分音符低音持续音 + 3-3-2 鼓
    boss: { bpm: 138, swing: 0, tonic: 50, scale: PHRYGIAN, prog: [0, 1, 0, 6], cutoff: 4600, echo: 0.12, level: 1.1, fadeIn: 0.45 },
  },
  chip: {
    // 《草稿纸》：降 E 大调 I–IV–vi–V，摇摆的 25% 脉冲分解和弦 + 铅笔敲桌
    menu: {
      bpm: 88,
      swing: 0.18,
      tonic: 63,
      scale: MAJOR,
      prog: [0, 3, 5, 4],
      cutoff: 3800,
      echo: 0.22,
      level: 0.9,
      fadeIn: 2,
      snareHz: 3200,
      snareQ: 6,
    },
    // 《格子本》：G 混合利底亚 I–bVII–IV–I，三连音式 shuffle，八度跳跃低音
    build: {
      bpm: 112,
      swing: 0.3,
      tonic: 67,
      scale: MIXOLYDIAN,
      prog: [0, 6, 3, 0],
      cutoff: 5000,
      echo: 0.15,
      level: 0.9,
      fadeIn: 1.5,
      snareHz: 3400,
      snareQ: 6,
    },
    // 《橡皮大作战》：B 小调 i–VI–iv–v，八度三角波低音 + 反拍和弦
    wave: {
      bpm: 132,
      swing: 0,
      tonic: 59,
      scale: MINOR,
      prog: [0, 5, 3, 4],
      cutoff: 6000,
      echo: 0.12,
      level: 1,
      fadeIn: 0.7,
      snareHz: 3000,
      snareQ: 5,
    },
    // 《自动铅笔》：C 和声小调 i–i–VI–V，6 对 16 的复节奏琶音
    boss: {
      bpm: 150,
      swing: 0,
      tonic: 60,
      scale: HARMONIC,
      prog: [0, 0, 5, 4],
      cutoff: 6000,
      echo: 0.1,
      level: 1.05,
      fadeIn: 0.45,
      snareHz: 3000,
      snareQ: 5,
    },
  },
  wood: {
    // 《橡皮屑华尔兹》：F 大调 3/4，暖色钢琴「嘭-嚓-嚓」+ 马林巴旋律
    menu: {
      bpm: 108,
      swing: 0,
      meter: 12,
      tonic: 65,
      scale: MAJOR,
      prog: [0, 3, 1, 4, 0, 5, 1, 4],
      cutoff: 3200,
      echo: 0.25,
      level: 1,
      fadeIn: 2.4,
    },
    // 《回形针》：D 多利亚 i–IV–bVII–v，拨弦固定音型 + 木鱼 3-3-2
    build: {
      bpm: 104,
      swing: 0.12,
      tonic: 62,
      scale: DORIAN,
      prog: [0, 3, 6, 4],
      cutoff: 4500,
      echo: 0.18,
      level: 1,
      fadeIn: 1.6,
      snareHz: 2400,
      snareQ: 9,
    },
    // 《订书机进行曲》：E 小调 12/8 奔马节奏，i–iv–VI–VII，太鼓
    wave: {
      bpm: 116,
      sub: 3,
      meter: 12,
      swing: 0,
      tonic: 64,
      scale: MINOR,
      prog: [0, 3, 5, 6],
      cutoff: 5200,
      echo: 0.12,
      level: 1.1,
      fadeIn: 0.7,
    },
    // 《裁纸刀》：升 F 和声小调 7/8（2+2+3），拨弦固定音型 + 马林巴颤音
    boss: {
      bpm: 140,
      swing: 0,
      meter: 14,
      tonic: 54,
      scale: HARMONIC,
      prog: [0, 1, 0, 4],
      cutoff: 4800,
      echo: 0.1,
      level: 1.1,
      fadeIn: 0.45,
      snareHz: 1500,
      snareQ: 1,
    },
  },
  night: {
    // 《凌晨两点的台灯》：D 利底亚 I–II–vi–II，失谐锯齿铺底 + 铃声琶音，半速鼓
    menu: {
      bpm: 82,
      swing: 0,
      tonic: 62,
      scale: LYDIAN,
      prog: [0, 1, 5, 1],
      cutoff: 2600,
      echo: 0.4,
      level: 1,
      fadeIn: 2.6,
      snareHz: 1400,
      snareQ: 0.7,
    },
    // 《荧光笔》：降 B 大调 vi–IV–I–V，八度脉动锯齿低音
    build: {
      bpm: 100,
      swing: 0,
      tonic: 58,
      scale: MAJOR,
      prog: [5, 3, 0, 4],
      cutoff: 3600,
      echo: 0.3,
      level: 0.95,
      fadeIn: 1.6,
      snareHz: 1400,
      snareQ: 0.7,
    },
    // 《霓虹尺子》：F 小调 i–VII–VI–VII，16 分滚动低音 + 四拍底鼓 + 双锯齿主旋律
    wave: {
      bpm: 124,
      swing: 0,
      tonic: 65,
      scale: MINOR,
      prog: [0, 6, 5, 6],
      cutoff: 4800,
      echo: 0.22,
      level: 1.1,
      fadeIn: 0.7,
      snareHz: 1400,
      snareQ: 0.7,
    },
    // 《修正液警报》：升 C 和声小调 i–VI–ii°–V，小二度警报和弦 + 通鼓下行
    boss: {
      bpm: 144,
      swing: 0,
      tonic: 61,
      scale: HARMONIC,
      prog: [0, 5, 1, 4],
      cutoff: 5200,
      echo: 0.15,
      level: 1.1,
      fadeIn: 0.45,
    },
  },
};

const STINGERS: Record<'victory' | 'defeat', Def> = {
  victory: {
    bpm: 112,
    swing: 0,
    tonic: 60,
    scale: MAJOR,
    prog: [0],
    cutoff: 6000,
    echo: 0.25,
    level: 1,
    fadeIn: 0.05,
    bars: 4,
    then: 'menu',
  },
  defeat: { bpm: 72, swing: 0, tonic: 57, scale: MINOR, prog: [0], cutoff: 2600, echo: 0.3, level: 1, fadeIn: 0.05, bars: 4, then: 'menu' },
};

interface MelNote {
  d: number;
  len: number;
}

interface Track {
  state: MusicState;
  style: MusicStyle;
  def: Def;
  out: GainNode;
  /** 旋律 / 和声走这里（低通，决定音色明暗），并送一份到回声 */
  tone: BiquadFilterNode;
  drums: GainNode;
  hat: BiquadFilterNode;
  snare: BiquadFilterNode;
  send: GainNode;
  next: number;
  step: number;
  /** 停止排新音符的时间（淡出中） */
  endAt: number;
  motif: { s: number; d: number; len: number }[];
  /** 一个 4 小节循环（64 步）的旋律，按和弦级数相对存放 */
  mel: (MelNote | undefined)[];
  /** 这一循环是否有旋律 / 琶音等可选层 */
  lead: boolean;
  arp: boolean;
}

interface NoteOpts {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  decay?: number;
  sustain?: number;
  release?: number;
  vib?: boolean;
  detune?: number;
  dest?: AudioNode;
  /** 自定义波形（优先于 type） */
  wave?: PeriodicWave;
}

/** 每一步的位置信息 */
interface Step {
  t: number;
  six: number;
  i: number;
  cyc: number;
  bar: number;
  root: number;
  barLen: number;
}

type Score = (tr: Track, c: Step) => void;

export class MusicEngine {
  private tracks: Track[] = [];
  private state: MusicState = 'menu';
  private enabled = false;
  private timer: number | null = null;
  private voices = 0;
  private energy = 0;
  private echoIn: GainNode;
  private delay: DelayNode;
  private vib: GainNode;
  private waves: { p12: PeriodicWave; p25: PeriodicWave; piano: PeriodicWave; marimba: PeriodicWave };
  // 播放列表
  private pref: MusicStylePref = 'auto';
  private queue: MusicStyle[] = [];
  private refills = 0;
  private pick: Record<LoopState, MusicStyle>;
  private heard = { menu: 0, battle: 0 };
  private rotateDue = false;

  private readonly score: Record<MusicStyle, Record<LoopState, Score>> = {
    classic: {
      menu: (tr, c) => this.menu(tr, c.t, c.six, c.i, c.cyc, c.root, c.barLen),
      build: (tr, c) => this.build(tr, c.t, c.six, c.i, c.cyc, c.root, c.barLen),
      wave: (tr, c) => this.wave(tr, c.t, c.six, c.i, c.cyc, c.root, c.barLen),
      boss: (tr, c) => this.boss(tr, c.t, c.six, c.i, c.cyc, c.root, c.barLen),
    },
    chip: {
      menu: (tr, c) => this.chipMenu(tr, c),
      build: (tr, c) => this.chipBuild(tr, c),
      wave: (tr, c) => this.chipWave(tr, c),
      boss: (tr, c) => this.chipBoss(tr, c),
    },
    wood: {
      menu: (tr, c) => this.woodMenu(tr, c),
      build: (tr, c) => this.woodBuild(tr, c),
      wave: (tr, c) => this.woodWave(tr, c),
      boss: (tr, c) => this.woodBoss(tr, c),
    },
    night: {
      menu: (tr, c) => this.nightMenu(tr, c),
      build: (tr, c) => this.nightBuild(tr, c),
      wave: (tr, c) => this.nightWave(tr, c),
      boss: (tr, c) => this.nightBoss(tr, c),
    },
  };

  constructor(
    private readonly ctx: AudioContext,
    private readonly bus: GainNode,
    private readonly noise: AudioBuffer,
  ) {
    // 共享回声：echoIn → delay → 低通 → 反馈；输出回到音乐总线
    this.echoIn = ctx.createGain();
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = 0.45;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2000;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    this.echoIn.connect(this.delay);
    this.delay.connect(damp);
    damp.connect(fb);
    fb.connect(this.delay);
    damp.connect(wet);
    wet.connect(bus);
    // 共享颤音 LFO：接到需要颤音的振荡器 detune 上
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.2;
    this.vib = ctx.createGain();
    this.vib.gain.value = 9;
    lfo.connect(this.vib);
    lfo.start();
    // 自定义波形：只生成一次，所有音符复用
    const wave = (amps: number[], asCos = false) => {
      const re = new Float32Array(amps.length + 1);
      const im = new Float32Array(amps.length + 1);
      amps.forEach((a, k) => ((asCos ? re : im)[k + 1] = a));
      return ctx.createPeriodicWave(re, im);
    };
    const pulse = (duty: number) =>
      wave(
        Array.from({ length: 24 }, (_v, k) => Math.sin((k + 1) * Math.PI * duty) / (k + 1)),
        true,
      );
    this.waves = {
      p12: pulse(0.125),
      p25: pulse(0.25),
      // 钢琴：泛音逐级衰减
      piano: wave([1, 0.45, 0.22, 0.12, 0.07, 0.04, 0.02]),
      // 马林巴：基音 + 第 4、第 10 泛音（音板的非谐泛音近似）
      marimba: wave([1, 0, 0, 0.32, 0, 0, 0, 0, 0, 0.07]),
    };
    const first = this.draw();
    const battle = this.draw(first);
    this.pick = { menu: first, build: battle, wave: battle, boss: battle };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stopTimer();
      else if (this.tracks.length) this.startTimer();
    });
  }

  get current(): MusicState {
    return this.state;
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      // 关着音乐时错过的短乐句不补放
      if (!isLoop(this.state)) this.state = STINGERS[this.state].then ?? 'menu';
      this.crossfade();
    } else {
      this.fadeOutAll(0.4);
    }
  }

  /** 波次数 → 战斗曲的层次（越往后越热闹） */
  setEnergy(wave: number): void {
    this.energy = Math.max(0, Math.min(1, wave / 18));
  }

  setState(s: MusicState): void {
    const prev = this.state;
    if (s === prev && (this.tracks.some((t) => t.state === s && t.endAt === Infinity) || !this.enabled)) return;
    // 播放列表：新的一局换一套战斗曲风，回到菜单换一首菜单曲
    if (s === 'build' && !isBattle(prev)) {
      const st = this.draw(this.pick.build);
      this.pick.build = this.pick.wave = this.pick.boss = st;
      this.heard.battle = 0;
    } else if (s === 'menu' && prev !== 'menu') {
      this.pick.menu = this.draw(this.pick.menu);
      this.heard.menu = 0;
    }
    this.state = s;
    if (this.enabled) this.crossfade();
  }

  get stylePref(): MusicStylePref {
    return this.pref;
  }

  /** 当前（或接下来）这个状态用的曲风 */
  get style(): MusicStyle {
    return isLoop(this.state) ? this.styleFor(this.state) : 'classic';
  }

  /** 配乐风格：'auto' 自动轮换，或固定某一套；正在播的曲风不同就交叉淡化过去 */
  setStylePref(p: MusicStylePref): void {
    if (p === this.pref) return;
    const live = this.tracks.find((t) => t.endAt === Infinity && isLoop(t.state));
    this.pref = p;
    if (p === 'auto') {
      // 切回自动：先接着播当前这套，之后照常轮换
      if (live && isLoop(this.state)) {
        if (this.state === 'menu') this.pick.menu = live.style;
        else this.pick.build = this.pick.wave = this.pick.boss = live.style;
      }
      this.heard = { menu: 0, battle: 0 };
      return;
    }
    if (this.enabled && live && live.style !== p && isLoop(this.state)) this.crossfade(true);
  }

  private styleFor(s: LoopState): MusicStyle {
    return this.pref === 'auto' ? this.pick[s] : this.pref;
  }

  /** 从轮换队列里抽下一套曲风（避开 avoid）；第一轮只抽新曲风，之后四套一起洗牌 */
  private draw(avoid?: MusicStyle): MusicStyle {
    const refill = () => this.queue.push(...shuffle([...(this.refills++ === 0 ? NEW_STYLES : MUSIC_STYLES)]));
    if (!this.queue.length) refill();
    let k = this.queue.findIndex((s) => s !== avoid);
    if (k < 0) {
      refill();
      k = this.queue.findIndex((s) => s !== avoid);
    }
    return this.queue.splice(k, 1)[0];
  }

  // ───────────── 曲目管理 ─────────────

  /** slow：同一状态内换曲风（自动轮换 / 设置里换风格），淡入淡出更长 */
  private crossfade(slow = false): void {
    const ctx = this.ctx;
    const s = this.state;
    const style = isLoop(s) ? this.styleFor(s) : 'classic';
    const def = isLoop(s) ? LOOPS[style][s] : STINGERS[s];
    const now = ctx.currentTime;
    const fadeIn = slow ? Math.max(def.fadeIn, 2.5) : def.fadeIn;
    this.fadeOutAll(def.bars ? 0.25 : slow ? 3 : Math.max(0.5, def.fadeIn * 0.9));
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.linearRampToValueAtTime(def.level, now + fadeIn);
    out.connect(this.bus);
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = def.cutoff;
    tone.Q.value = 0.5;
    tone.connect(out);
    const send = ctx.createGain();
    send.gain.value = def.echo;
    tone.connect(send);
    send.connect(this.echoIn);
    const drums = ctx.createGain();
    drums.connect(out);
    const hat = ctx.createBiquadFilter();
    hat.type = 'highpass';
    hat.frequency.value = def.hatHz ?? 7000;
    hat.connect(drums);
    const snare = ctx.createBiquadFilter();
    snare.type = 'bandpass';
    snare.frequency.value = def.snareHz ?? 1700;
    snare.Q.value = def.snareQ ?? 0.8;
    snare.connect(drums);
    // 回声时值：附点八分
    const beat = 60 / def.bpm;
    this.delay.delayTime.setTargetAtTime(Math.min(1.4, beat * 0.75), now, 0.3);
    this.tracks.push({
      state: s,
      style,
      def,
      out,
      tone,
      drums,
      hat,
      snare,
      send,
      next: now + 0.06,
      step: 0,
      endAt: Infinity,
      motif: [],
      mel: [],
      lead: false,
      arp: false,
    });
    this.startTimer();
  }

  private fadeOutAll(sec: number): void {
    const now = this.ctx.currentTime;
    for (const tr of this.tracks) {
      if (tr.endAt !== Infinity) continue;
      const g = tr.out.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0.0001, now + sec);
      tr.endAt = now + sec;
    }
  }

  private dispose(tr: Track): void {
    for (const n of [tr.out, tr.tone, tr.drums, tr.hat, tr.snare, tr.send]) n.disconnect();
  }

  private startTimer(): void {
    if (this.timer !== null || document.hidden) return;
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (ctx.state !== 'running') {
      for (const tr of this.tracks) tr.next = now + 0.06;
      return;
    }
    const horizon = now + LOOKAHEAD;
    for (const tr of this.tracks) {
      // 被节流 / 卡顿后不补放积压的音符
      if (tr.next < now - 0.05) tr.next = now + 0.02;
      const d = tr.def;
      const six = 60 / d.bpm / (d.sub ?? 4);
      const cycSteps = (d.meter ?? 16) * 4;
      while (tr.next < horizon && tr.next < tr.endAt) {
        if (d.bars && tr.step >= d.bars * (d.meter ?? 16)) {
          tr.endAt = tr.next;
          if (this.state === tr.state && d.then && this.enabled) this.setState(d.then);
          break;
        }
        const t = tr.next + (tr.step % 2 === 1 ? d.swing * six : 0);
        this.playStep(tr, t, six);
        tr.step++;
        tr.next += six;
        if (tr.step % cycSteps === 0) this.onCycle(tr, cycSteps * six);
      }
    }
    // 自动轮换：在循环结尾交叉淡化到下一套曲风
    if (this.rotateDue) {
      this.rotateDue = false;
      const s = this.state;
      if (this.enabled && this.pref === 'auto' && isLoop(s)) {
        const st = this.draw(this.pick[s]);
        if (s === 'menu') this.pick.menu = st;
        else this.pick.build = this.pick.wave = this.pick.boss = st;
        this.crossfade(true);
      }
    }
    // 淡出结束、尾音也放完的曲目回收节点
    this.tracks = this.tracks.filter((tr) => {
      if (tr.endAt !== Infinity && now > tr.endAt + 3) {
        this.dispose(tr);
        return false;
      }
      return true;
    });
    if (!this.tracks.length) this.stopTimer();
  }

  /** 一个 4 小节循环播完：累计收听时长，够了就标记轮换 */
  private onCycle(tr: Track, sec: number): void {
    if (this.pref !== 'auto' || tr.endAt !== Infinity || tr.state !== this.state || !isLoop(tr.state)) return;
    const g = tr.state === 'menu' ? 'menu' : 'battle';
    this.heard[g] += sec;
    if (this.heard[g] >= ROTATE_SEC[g]) {
      this.heard[g] = 0;
      this.rotateDue = true;
    }
  }

  // ───────────── 乐理小工具 ─────────────

  /** 音阶级数 → MIDI（级数可为负或超过 7） */
  private deg(d: Def, degree: number, octave = 0): number {
    const n = d.scale.length;
    const o = Math.floor(degree / n);
    const idx = ((degree % n) + n) % n;
    return d.tonic + 12 * (o + octave) + d.scale[idx];
  }

  private chord(d: Def, root: number, count: number, octave = 0): number[] {
    const out: number[] = [];
    for (let k = 0; k < count; k++) out.push(this.deg(d, root + 2 * k, octave));
    return out;
  }

  private newMotif(rhythms: Rhythm[]): { s: number; d: number; len: number }[] {
    const r = rand(rhythms);
    let d = rand([0, 2, 4]);
    const out = r.map(([s, len], k) => {
      if (k > 0) d = Math.max(-3, Math.min(9, d + rand([-2, -1, -1, 1, 1, 2, 3])));
      return { s, d, len };
    });
    const last = out[out.length - 1];
    last.d = rand([0, 2, 4, 7]);
    return out;
  }

  /** 变奏：个别音上下挪一级、偶尔休止、整体上移三度、句尾落到和弦音 */
  private vary(m: { s: number; d: number; len: number }[]): { s: number; d: number; len: number }[] {
    const lift = chance(0.3) ? 2 : 0;
    const out = m
      .filter((_n, k) => k === 0 || k === m.length - 1 || !chance(0.15))
      .map((n) => ({ s: n.s, len: n.len, d: n.d + lift + (chance(0.25) ? rand([-1, 1]) : 0) }));
    out[out.length - 1].d = rand([0, 2, 4]);
    return out;
  }

  /** 每 4 小节重新编排一次旋律：A + A'（或 A' + A''） */
  private phrase(tr: Track, rhythms: Rhythm[], leadP: number, arpP: number): void {
    if (!tr.motif.length || chance(0.45)) tr.motif = this.newMotif(rhythms);
    else tr.motif = this.vary(tr.motif);
    const second = this.vary(tr.motif);
    tr.mel = [];
    for (const n of tr.motif) tr.mel[n.s] = { d: n.d, len: n.len };
    for (const n of second) tr.mel[n.s + 32] = { d: n.d, len: n.len };
    tr.lead = chance(leadP);
    tr.arp = chance(arpP);
  }

  /** 单小节乐句：在节奏型上随机游走，避免大跳 */
  private cell(cells: Rhythm[]): { s: number; d: number; len: number }[] {
    let d = rand([0, 2, 4]);
    return rand(cells).map(([s, len], k) => {
      if (k > 0) d = Math.max(-2, Math.min(8, d + rand([-2, -1, -1, 1, 1, 2])));
      return { s, d, len };
    });
  }

  /** 非 4/4 曲子的 4 小节旋律：A B A' C（C 落回主音） */
  private phraseBars(tr: Track, spb: number, cells: Rhythm[], leadP: number, arpP: number): void {
    const a = this.cell(cells);
    const c = this.cell(cells);
    c[c.length - 1].d = 0;
    tr.mel = [];
    [a, this.cell(cells), this.vary(a), c].forEach((ns, k) => {
      for (const n of ns) tr.mel[k * spb + n.s] = { d: n.d, len: n.len };
    });
    tr.lead = chance(leadP);
    tr.arp = chance(arpP);
  }

  // ───────────── 乐器 ─────────────

  private note(tr: Track, m: number, t: number, dur: number, o: NoteOpts = {}): void {
    if (this.voices > MAX_VOICES) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    if (o.wave) osc.setPeriodicWave(o.wave);
    else osc.type = o.type ?? 'sine';
    osc.frequency.value = hz(m);
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    const peak = o.gain ?? 0.05;
    const a = o.attack ?? 0.005;
    const rel = o.release ?? 0.08;
    const end = t + Math.max(a, dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    if (o.decay) g.gain.setTargetAtTime(peak * (o.sustain ?? 0), t + a, o.decay / 3);
    g.gain.setTargetAtTime(0, end, rel / 3);
    osc.connect(g);
    g.connect(o.dest ?? tr.tone);
    if (o.vib) this.vib.connect(osc.detune);
    osc.start(t);
    osc.stop(end + rel + 0.05);
    this.voices++;
    osc.onended = () => {
      this.voices--;
      if (o.vib) {
        try {
          this.vib.disconnect(osc.detune);
        } catch {
          /* 已断开 */
        }
      }
      osc.disconnect();
      g.disconnect();
    };
  }

  /** 噪声打击：经过曲目常驻的滤波器 */
  private hit(dest: AudioNode, t: number, gain: number, decay: number): void {
    if (this.voices > MAX_VOICES) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.002);
    g.gain.setTargetAtTime(0, t + 0.002, decay / 3);
    src.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 0.4);
    src.stop(t + decay * 1.6 + 0.05);
    this.voices++;
    src.onended = () => {
      this.voices--;
      src.disconnect();
      g.disconnect();
    };
  }

  private kick(tr: Track, t: number, gain: number, f0 = 120, f1 = 44, dec = 0.13): void {
    if (this.voices > MAX_VOICES) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + dec);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.003);
    g.gain.setTargetAtTime(0, t + 0.01, dec / 2);
    osc.connect(g);
    g.connect(tr.drums);
    osc.start(t);
    osc.stop(t + dec * 3 + 0.05);
    this.voices++;
    osc.onended = () => {
      this.voices--;
      osc.disconnect();
      g.disconnect();
    };
  }

  private snare(tr: Track, t: number, gain: number, decay = 0.11): void {
    this.hit(tr.snare, t, gain, decay);
    this.note(tr, 52, t, 0.02, { type: 'triangle', gain: gain * 0.5, release: 0.06, dest: tr.drums });
  }

  private hatHit(tr: Track, t: number, gain: number, decay = 0.035): void {
    this.hit(tr.hat, t, gain, decay);
  }

  // ───────────── 曲目 ─────────────

  /** 拨弦：极短的三角波 */
  private pizz(tr: Track, m: number, t: number, gain: number, decay = 0.14): void {
    this.note(tr, m, t, decay, { type: 'triangle', gain, attack: 0.002, decay, sustain: 0, release: 0.06 });
  }

  /** 马林巴：短促的木琴；长音用滚奏（每两步轻敲一次） */
  private mallet(tr: Track, m: number, t: number, len: number, six: number, gain: number): void {
    const o: NoteOpts = { wave: this.waves.marimba, gain, attack: 0.003, decay: 0.35, sustain: 0, release: 0.25 };
    this.note(tr, m, t, Math.min(len * six, 0.5), o);
    if (len >= 6) for (let k = 2; k < len - 1; k += 2) this.note(tr, m, t + k * six, 0.3, { ...o, gain: gain * 0.45 });
  }

  /** 失谐锯齿铺底（合成器浪潮的「厚」） */
  private pad(tr: Track, notes: number[], t: number, dur: number, gain: number, attack: number): void {
    for (const m of notes)
      for (const det of [-8, 8]) this.note(tr, m, t, dur, { type: 'sawtooth', gain, attack, detune: det, release: 0.9 });
  }

  private meloMallet(tr: Track, c: Step, octave: number, gain: number): void {
    if (!tr.lead) return;
    const n = tr.mel[c.cyc];
    if (n) this.mallet(tr, this.deg(tr.def, c.root + n.d, octave), c.t, n.len, c.six, gain);
  }

  private crash(tr: Track, t: number, gain = 0.05): void {
    this.hatHit(tr, t, gain, 0.8);
  }

  private playStep(tr: Track, t: number, six: number): void {
    if (tr.state === 'victory') return this.victory(tr, t, six, tr.step);
    if (tr.state === 'defeat') return this.defeat(tr, t, six, tr.step);
    const d = tr.def;
    const spb = d.meter ?? 16;
    const bar = Math.floor(tr.step / spb);
    const cyc = tr.step % (spb * 4);
    this.score[tr.style][tr.state](tr, {
      t,
      six,
      i: tr.step % spb,
      cyc,
      bar: Math.floor(cyc / spb),
      root: d.prog[bar % d.prog.length],
      barLen: six * spb,
    });
  }

  private melody(tr: Track, t: number, six: number, cyc: number, root: number, octave: number, o: NoteOpts): void {
    if (!tr.lead) return;
    const n = tr.mel[cyc];
    if (n) this.note(tr, this.deg(tr.def, root + n.d, octave), t, n.len * six * 0.92, o);
  }

  /** 菜单：Rhodes 般的七和弦 + 圆润低音 + 刷子军鼓 + 唱片底噪 */
  private menu(tr: Track, t: number, six: number, i: number, cyc: number, root: number, barLen: number): void {
    const d = tr.def;
    if (cyc === 0) this.phrase(tr, RHYTHM_SPARSE, 0.75, 0);
    if (i === 0 || (i === 10 && chance(0.45))) {
      const vel = i === 0 ? 1 : 0.55;
      const notes = this.chord(d, root, 4);
      notes.forEach((m, k) => {
        const tt = t + k * 0.012; // 轻微琶开
        this.note(tr, m, tt, barLen * 0.9, { gain: 0.032 * vel, attack: 0.01, decay: 1.4, sustain: 0.3, release: 0.5 });
        this.note(tr, m + 12, tt, 0.4, { gain: 0.008 * vel, attack: 0.005, decay: 0.3, release: 0.2 });
      });
    }
    if (i === 0) this.note(tr, this.deg(d, root, -2), t, six * 6, { type: 'triangle', gain: 0.13, attack: 0.02, release: 0.15 });
    if (i === 7 || (i === 10 && chance(0.5)))
      this.note(tr, this.deg(d, root + (chance(0.5) ? 4 : 0), -2), t, six * 3, {
        type: 'triangle',
        gain: 0.1,
        attack: 0.02,
        release: 0.12,
      });
    this.melody(tr, t, six, cyc, root, 1, { type: 'sine', gain: 0.045, attack: 0.02, decay: 0.6, sustain: 0.55, release: 0.3, vib: true });
    // 鼓
    if (i === 0 || i === 10 || (i === 7 && chance(0.35))) this.kick(tr, t, 0.22, 95, 45, 0.12);
    if (i === 4 || i === 12) this.snare(tr, t, 0.07, 0.16);
    if (i % 2 === 0) this.hatHit(tr, t, i % 4 === 0 ? 0.018 : 0.012, 0.03);
    if (chance(0.09)) this.hit(tr.hat, t + Math.random() * six, 0.004 + Math.random() * 0.012, 0.006);
  }

  /** 布防：拨弦琶音 + 柔和铺底 + 沙锤 */
  private build(tr: Track, t: number, six: number, i: number, cyc: number, root: number, barLen: number): void {
    const d = tr.def;
    if (cyc === 0) this.phrase(tr, RHYTHM_MID, 0.6, 1);
    if (i === 0)
      for (const m of this.chord(d, root, 3))
        this.note(tr, m, t, barLen * 0.95, { type: 'triangle', gain: 0.018, attack: 0.25, release: 0.4 });
    if (i % 2 === 0) {
      const pat = [0, 2, 4, 7, 4, 2, 4, 7];
      const k = pat[(i / 2) % pat.length];
      this.note(tr, this.deg(d, root + k, 0), t, six, { type: 'triangle', gain: 0.035, decay: 0.2, sustain: 0, release: 0.1 });
    }
    if (i === 0 || i === 8)
      this.note(tr, this.deg(d, root, -2), t, six * 5, { type: 'sine', gain: 0.16, attack: 0.01, decay: 0.5, sustain: 0.5 });
    if (i === 6 || i === 14) this.note(tr, this.deg(d, root + 4, -2), t, six * 1.5, { type: 'sine', gain: 0.1, attack: 0.01 });
    this.melody(tr, t, six, cyc, root, 1, {
      type: 'triangle',
      gain: 0.04,
      attack: 0.01,
      decay: 0.3,
      sustain: 0.5,
      release: 0.15,
      vib: true,
    });
    if (i === 0 || i === 8) this.kick(tr, t, 0.17, 110, 50, 0.1);
    if (i === 12) this.hit(tr.snare, t, 0.05, 0.03);
    this.hatHit(tr, t, i % 4 === 2 ? 0.026 : 0.01, 0.04);
  }

  /** 波次：八分音符推进的锯齿低音 + 四拍鼓 + 16 分琶音 / 主旋律轮替 */
  private wave(tr: Track, t: number, six: number, i: number, cyc: number, root: number, barLen: number): void {
    const d = tr.def;
    const e = this.energy;
    if (cyc === 0) {
      this.phrase(tr, RHYTHM_MID, 0.55 + e * 0.3, 0.5 + e * 0.4);
      this.hatHit(tr, t, 0.05, 0.7); // 段落起点的镲
    }
    if (i === 0)
      for (const m of this.chord(d, root, 3))
        this.note(tr, m, t, barLen * 0.95, { type: 'sawtooth', gain: 0.009, attack: 0.08, release: 0.2 });
    if (i % 2 === 0) {
      const oct = i === 6 || i === 14 ? -1 : -2;
      this.note(tr, this.deg(d, root, oct), t, six * 1.4, { type: 'sawtooth', gain: 0.05, decay: 0.15, sustain: 0.5, release: 0.05 });
    }
    if (tr.arp) {
      const pat = [0, 2, 4, 7, 9, 7, 4, 2];
      this.note(tr, this.deg(d, root + pat[i % 8], 1), t, six * 0.8, {
        type: 'square',
        gain: 0.012 + e * 0.006,
        decay: 0.12,
        sustain: 0.2,
      });
    }
    this.melody(tr, t, six, cyc, root, 1, {
      type: 'square',
      gain: 0.022,
      attack: 0.01,
      decay: 0.25,
      sustain: 0.6,
      release: 0.1,
      vib: true,
    });
    const bar = Math.floor(cyc / 16);
    if (i === 0 || i === 8 || (bar % 2 === 1 && i === 10) || (e > 0.5 && i === 6)) this.kick(tr, t, 0.3);
    if (i === 4 || i === 12) this.snare(tr, t, 0.1);
    if (bar === 3 && i >= 13 && e > 0.3) this.snare(tr, t, 0.04 + (i - 13) * 0.02, 0.06);
    if (i % 2 === 0) this.hatHit(tr, t, i % 4 === 2 ? 0.03 : 0.018);
    else if (e > 0.45) this.hatHit(tr, t, 0.008);
  }

  /** Boss：弗里吉亚 16 分低音持续音 + 3-3-2 通鼓 + 不协和铺底 + 长音主旋律 */
  private boss(tr: Track, t: number, six: number, i: number, cyc: number, root: number, barLen: number): void {
    const d = tr.def;
    const bar = Math.floor(cyc / 16);
    if (cyc === 0) {
      this.phrase(tr, RHYTHM_LONG, 0.8, 0);
      this.hatHit(tr, t, 0.06, 0.9);
      for (const m of [this.deg(d, 0, -1), this.deg(d, 4, -1)])
        this.note(tr, m, t, six * 3, { type: 'square', gain: 0.04, decay: 0.3, sustain: 0.3, release: 0.2 });
    }
    if (i === 0) {
      // 根音 + 五度 + 高八度小二度：持续的紧张感
      const r = this.deg(d, root, 0);
      for (const m of [r, r + 7, r + 13]) this.note(tr, m, t, barLen * 0.98, { type: 'sawtooth', gain: 0.007, attack: 0.3, release: 0.3 });
    }
    const ost = [0, 0, 7, 0, 0, 1, 0, 0, 7, 0, 0, 1, 0, 12, 0, 1];
    const base = this.deg(d, root, -2);
    this.note(tr, base + ost[i], t, six * 0.7, { type: 'sawtooth', gain: 0.045, decay: 0.08, sustain: 0.3, release: 0.04 });
    this.melody(tr, t, six, cyc, root, 1, { type: 'sawtooth', gain: 0.018, attack: 0.06, release: 0.2, vib: true });
    if (i === 0 || i === 8) this.kick(tr, t, 0.32, 110, 40, 0.15);
    if (i === 0 || i === 3 || i === 6 || i === 10 || i === 13) this.kick(tr, t, 0.15, 190, 95, 0.12); // 通鼓
    if (i === 4 || i === 12) this.snare(tr, t, 0.11);
    if (bar === 3 && i >= 8) this.snare(tr, t, 0.025 + (i - 8) * 0.012, 0.05);
    this.hatHit(tr, t, i % 2 === 0 ? 0.022 : 0.01, 0.025);
  }

  // ───────────── 铅笔芯片（chip） ─────────────

  /** 《草稿纸》：25% 脉冲分解和弦 + 12.5% 脉冲旋律 + 三角波低音 + 铅笔敲桌 */
  private chipMenu(tr: Track, c: Step): void {
    const d = tr.def;
    const { t, six, i, cyc, root } = c;
    if (cyc === 0) this.phrase(tr, RHYTHM_SPARSE, 0.7, 0.5);
    const bass: NoteOpts = { type: 'triangle', gain: 0.12, decay: 0.6, sustain: 0.5, release: 0.08 };
    if (i === 0) this.note(tr, this.deg(d, root, -2), t, six * 6, bass);
    if (i === 8) this.note(tr, this.deg(d, root + 4, -2), t, six * 4, { ...bass, gain: 0.1 });
    if (i === 14 && chance(0.5)) this.note(tr, this.deg(d, root, -1), t, six, { ...bass, gain: 0.08 });
    if (i % 2 === 0 && (tr.arp || i < 8)) {
      const pat = [0, 2, 4, 2, 7, 4, 2, 4];
      this.note(tr, this.deg(d, root + pat[i / 2], 0), t, six * 0.9, {
        wave: this.waves.p25,
        gain: 0.011,
        decay: 0.15,
        sustain: 0.25,
        release: 0.05,
      });
    }
    this.melody(tr, t, six, cyc, root, 1, {
      wave: this.waves.p12,
      gain: 0.016,
      attack: 0.01,
      decay: 0.2,
      sustain: 0.5,
      release: 0.08,
      vib: true,
    });
    // 铅笔敲桌：高 Q 带通噪声的「嗒」，偶尔多敲一下
    if (i === 4 || i === 12) this.hit(tr.snare, t, 0.3, 0.025);
    if (i % 2 === 1 && chance(0.16)) this.hit(tr.snare, t, 0.1 + Math.random() * 0.1, 0.015);
    if (i === 0 || (i === 10 && chance(0.4))) this.kick(tr, t, 0.15, 150, 55, 0.06);
    if (i % 4 === 2) this.hatHit(tr, t, 0.012, 0.02);
  }

  /** 《格子本》：shuffle 的 16 分八度琶音 + 跳跃低音 + 白噪声军鼓 */
  private chipBuild(tr: Track, c: Step): void {
    const d = tr.def;
    const { t, six, i, cyc, root } = c;
    if (cyc === 0) this.phrase(tr, RHYTHM_MID, 0.65, 0.6);
    const pat = [0, 7, 4, 7, 2, 7, 4, 7];
    if (tr.arp || i % 2 === 0)
      this.note(tr, this.deg(d, root + pat[i % 8], 0), t, six * 0.8, {
        wave: this.waves.p12,
        gain: 0.009,
        decay: 0.1,
        sustain: 0.2,
        release: 0.04,
      });
    if (i % 4 === 0) this.note(tr, this.deg(d, root, -2), t, six * 1.6, { type: 'triangle', gain: 0.12, decay: 0.2, sustain: 0.4 });
    if (i % 4 === 2) this.note(tr, this.deg(d, root, -1), t, six * 1.2, { type: 'triangle', gain: 0.08, decay: 0.15, sustain: 0.3 });
    this.melody(tr, t, six, cyc, root, 1, {
      wave: this.waves.p25,
      gain: 0.015,
      attack: 0.008,
      decay: 0.2,
      sustain: 0.55,
      release: 0.06,
      vib: true,
    });
    if (i === 0 || i === 6 || i === 8) this.kick(tr, t, 0.2, 160, 55, 0.07);
    if (i === 4 || i === 12) this.hit(tr.drums, t, 0.05, 0.06);
    if (i % 4 === 2) this.hit(tr.snare, t, 0.18, 0.02);
    if (i % 2 === 1 && chance(0.12)) this.hit(tr.snare, t, 0.1, 0.012);
  }

  /** 《橡皮大作战》：八度三角波低音 + 反拍和弦 + 高八度闪烁琶音 */
  private chipWave(tr: Track, c: Step): void {
    const d = tr.def;
    const e = this.energy;
    const { t, six, i, cyc, bar, root } = c;
    if (cyc === 0) {
      this.phrase(tr, RHYTHM_MID, 0.6 + e * 0.3, 0.4 + e * 0.4);
      this.crash(tr, t);
    }
    if (i % 2 === 0)
      this.note(tr, this.deg(d, root, (i / 2) % 2 ? -1 : -2), t, six * 1.6, {
        type: 'triangle',
        gain: 0.12,
        decay: 0.15,
        sustain: 0.5,
        release: 0.04,
      });
    if (i % 4 === 2)
      for (const m of this.chord(d, root, 3))
        this.note(tr, m, t, six * 0.9, { wave: this.waves.p25, gain: 0.007, decay: 0.1, sustain: 0.2, release: 0.04 });
    if (tr.arp) {
      const pat = [0, 4, 2, 4, 7, 4, 2, 4];
      this.note(tr, this.deg(d, root + pat[i % 8], 2), t, six * 0.7, {
        wave: this.waves.p12,
        gain: 0.005 + e * 0.004,
        decay: 0.08,
        sustain: 0,
      });
    }
    this.melody(tr, t, six, cyc, root, 1, {
      wave: this.waves.p12,
      gain: 0.018,
      attack: 0.006,
      decay: 0.2,
      sustain: 0.6,
      release: 0.06,
      vib: true,
    });
    if (i === 0 || i === 8 || (e > 0.4 && i === 10)) this.kick(tr, t, 0.24, 160, 50, 0.08);
    if (i === 4 || i === 12) this.hit(tr.drums, t, 0.07, 0.07);
    if (bar === 3 && i >= 12) this.hit(tr.snare, t, 0.12 + (i - 12) * 0.05, 0.02);
    if (i % 2 === 1) this.hatHit(tr, t, 0.016, 0.02);
    else if (e > 0.5) this.hit(tr.snare, t, 0.08, 0.012);
  }

  /** 《自动铅笔》：16 分三角波低音 + 6 对 16 的复节奏琶音 + 四拍底鼓 */
  private chipBoss(tr: Track, c: Step): void {
    const d = tr.def;
    const { t, six, i, cyc, bar, root } = c;
    if (cyc === 0) {
      this.phrase(tr, RHYTHM_LONG, 0.85, 0.7);
      this.crash(tr, t, 0.06);
    }
    const ost = [0, 12, 0, 0, 12, 0, 0, 12, 0, 12, 0, 0, 12, 0, 7, 6];
    this.note(tr, this.deg(d, root, -2) + ost[i], t, six * 0.7, { type: 'triangle', gain: 0.11, decay: 0.08, sustain: 0.4, release: 0.03 });
    const arp = [0, 2, 4, 7, 4, 2];
    if (tr.arp || i % 2 === 0)
      this.note(tr, this.deg(d, root + arp[tr.step % 6], 0), t, six * 0.8, {
        wave: this.waves.p25,
        gain: 0.009,
        decay: 0.08,
        sustain: 0.2,
        release: 0.03,
      });
    this.melody(tr, t, six, cyc, root, 1, {
      wave: this.waves.p12,
      gain: 0.017,
      attack: 0.02,
      decay: 0.3,
      sustain: 0.7,
      release: 0.1,
      vib: true,
    });
    if (i % 4 === 0) this.kick(tr, t, 0.24, 170, 50, 0.07);
    if (i === 4 || i === 12) this.hit(tr.drums, t, 0.07, 0.07);
    if (bar === 3 && i >= 8) this.hit(tr.drums, t, 0.02 + (i - 8) * 0.008, 0.04);
    this.hit(tr.snare, t, i % 2 === 0 ? 0.12 : 0.06, 0.015);
  }

  // ───────────── 木琴拨弦（wood） ─────────────

  /** 《橡皮屑华尔兹》：钢琴「嘭-嚓-嚓」+ 马林巴旋律（长音滚奏）+ 拨弦小过门 */
  private woodMenu(tr: Track, c: Step): void {
    const d = tr.def;
    const { t, six, i, cyc, root, barLen } = c;
    if (cyc === 0) this.phraseBars(tr, 12, CELLS_WALTZ, 0.8, 0.5);
    const piano = (m: number, len: number, gain: number) =>
      this.note(tr, m, t, len, { wave: this.waves.piano, gain, attack: 0.004, decay: 1.1, sustain: 0.12, release: 0.35 });
    if (i === 0) {
      piano(this.deg(d, root, -2), barLen * 0.9, 0.09);
      piano(this.deg(d, root, -1), barLen * 0.9, 0.025);
    }
    if (i === 4 || i === 8) for (const m of this.chord(d, root, 4).slice(1)) piano(m, six * 3, i === 4 ? 0.018 : 0.014);
    this.meloMallet(tr, c, 1, 0.05);
    if (tr.arp && i === 10) this.pizz(tr, this.deg(d, root + rand([2, 4, 7]), 1), t, 0.025, 0.2);
    if (i === 0) this.kick(tr, t, 0.08, 80, 45, 0.1);
    if (i === 4 || i === 8) this.hatHit(tr, t, 0.008, 0.05);
  }

  /** 《回形针》：多利亚拨弦固定音型 + 马林巴切分 + 木鱼 3-3-2 + 沙锤 */
  private woodBuild(tr: Track, c: Step): void {
    const d = tr.def;
    const { t, six, i, cyc, root } = c;
    if (cyc === 0) this.phrase(tr, RHYTHM_MID, 0.55, 0.7);
    if (i % 2 === 0) {
      const pat = [0, 4, 7, 4, 2, 4, 7, 4];
      this.pizz(tr, this.deg(d, root + pat[i / 2], -1), t, 0.045);
    }
    if (i === 0 || i === 10) this.pizz(tr, this.deg(d, root, -2), t, 0.13, 0.3);
    if (i === 6) this.pizz(tr, this.deg(d, root + 4, -2), t, 0.09, 0.2);
    if (!tr.lead && tr.arp && (i === 3 || i === 6 || i === 11 || i === 14))
      this.mallet(tr, this.deg(d, root + rand([2, 4, 7]), 1), t, 2, six, 0.035);
    this.meloMallet(tr, c, 1, 0.045);
    if (i === 0 || i === 6 || i === 12) this.hit(tr.snare, t, i === 0 ? 0.3 : 0.22, 0.03);
    this.hatHit(tr, t, i % 2 === 0 ? 0.014 : 0.008, 0.025);
    if (i === 0 || i === 8) this.kick(tr, t, 0.12, 100, 50, 0.1);
  }

  /** 《订书机进行曲》：12/8 奔马拨弦低音 + 马林巴三连琶音 + 太鼓 */
  private woodWave(tr: Track, c: Step): void {
    const d = tr.def;
    const e = this.energy;
    const { t, six, i, cyc, root } = c;
    if (cyc === 0) {
      this.phraseBars(tr, 12, CELLS_GALLOP, 0.6 + e * 0.3, 0.5 + e * 0.4);
      this.crash(tr, t);
    }
    const beat = Math.floor(i / 3);
    const sub = i % 3;
    if (sub !== 1) this.pizz(tr, this.deg(d, root + (beat % 2 ? 4 : 0), -2), t, sub === 0 ? 0.13 : 0.07, 0.18);
    if (i === 0) for (const m of this.chord(d, root, 3)) this.pizz(tr, m, t, 0.025, 0.3);
    if (tr.arp) {
      const pat = [0, 2, 4, 7, 4, 2];
      this.mallet(tr, this.deg(d, root + pat[i % 6], 0), t, 1, six, 0.014 + e * 0.008);
    }
    this.meloMallet(tr, c, 1, 0.048);
    if (i === 0 || i === 6 || (e > 0.35 && i === 8)) this.kick(tr, t, 0.28, 95, 42, 0.18);
    if (i === 3 || i === 9) this.snare(tr, t, 0.09, 0.12);
    if (e > 0.5 && (i === 10 || i === 11)) this.kick(tr, t, 0.12, 200, 110, 0.08);
    this.hatHit(tr, t, sub === 0 ? 0.02 : 0.009, 0.03);
  }

  /** 《裁纸刀》：7/8 拨弦固定音型（含小二度）+ 马林巴颤音 + 通鼓 */
  private woodBoss(tr: Track, c: Step): void {
    const d = tr.def;
    const { t, six, i, cyc, bar, root } = c;
    if (cyc === 0) {
      this.phraseBars(tr, 14, CELLS_SEVEN, 0.8, 0.6);
      this.crash(tr, t, 0.06);
    }
    if (i % 2 === 0) {
      const ost = [0, 0, 1, 0, 7, 6, 0];
      this.pizz(tr, this.deg(d, root, -1) + ost[i / 2], t, 0.05, 0.1);
    }
    if (i === 0 || i === 4 || i === 8) this.pizz(tr, this.deg(d, root, -2), t, 0.14, 0.25);
    if (tr.arp && i % 2 === 1) this.mallet(tr, this.deg(d, root + 4, 1), t, 1, six, 0.012);
    this.meloMallet(tr, c, 1, 0.05);
    if (i === 0) this.kick(tr, t, 0.3, 110, 40, 0.15);
    if (i === 4 || i === 12) this.kick(tr, t, 0.16, 200, 100, 0.1);
    if (i === 8) this.snare(tr, t, 0.1);
    if (bar === 3 && i >= 6) this.snare(tr, t, 0.025 + (i - 6) * 0.01, 0.05);
    this.hatHit(tr, t, i === 0 || i === 4 || i === 8 ? 0.02 : 0.009, 0.025);
  }

  // ───────────── 夜灯合成器（night） ─────────────

  /** 《凌晨两点的台灯》：利底亚铺底 + 正弦次低音 + 铃声琶音 + 半速鼓 */
  private nightMenu(tr: Track, c: Step): void {
    const d = tr.def;
    const { t, six, i, cyc, root, barLen } = c;
    if (cyc === 0) this.phrase(tr, RHYTHM_SPARSE, 0.6, 0.7);
    if (i === 0) {
      this.pad(tr, this.chord(d, root, 4), t, barLen * 0.95, 0.0042, 0.8);
      this.note(tr, this.deg(d, root, -2), t, barLen * 0.8, { type: 'sine', gain: 0.16, attack: 0.04, release: 0.3 });
    }
    const bell = [0, -1, -1, 2, -1, -1, 4, -1, -1, -1, 7, -1, -1, -1, -1, -1][i];
    if (tr.arp && bell >= 0) {
      const m = this.deg(d, root + bell, 1);
      this.note(tr, m, t, 0.5, { gain: 0.02, decay: 0.5, sustain: 0, release: 0.5 });
      this.note(tr, m + 12, t, 0.3, { gain: 0.006, decay: 0.3, sustain: 0, release: 0.3 });
    }
    this.melody(tr, t, six, cyc, root, 1, {
      type: 'triangle',
      gain: 0.032,
      attack: 0.04,
      decay: 0.5,
      sustain: 0.7,
      release: 0.4,
      vib: true,
    });
    if (i === 0 || (i === 10 && chance(0.4))) this.kick(tr, t, 0.2, 90, 42, 0.16);
    if (i === 8) this.snare(tr, t, 0.08, 0.3);
    if (i % 2 === 0) this.hatHit(tr, t, i % 4 === 2 ? 0.014 : 0.009, 0.03);
  }

  /** 《荧光笔》：八度脉动锯齿低音 + 失谐铺底 + 方波琶音 + 门限军鼓 */
  private nightBuild(tr: Track, c: Step): void {
    const d = tr.def;
    const { t, six, i, cyc, root, barLen } = c;
    if (cyc === 0) this.phrase(tr, RHYTHM_MID, 0.6, 0.6);
    if (i === 0) this.pad(tr, this.chord(d, root, 3), t, barLen * 0.95, 0.0035, 0.3);
    if (i % 2 === 0)
      this.note(tr, this.deg(d, root, (i / 2) % 2 ? -1 : -2), t, six * 1.5, {
        type: 'sawtooth',
        gain: 0.038,
        decay: 0.12,
        sustain: 0.35,
        release: 0.05,
      });
    if (tr.arp) {
      const pat = [0, 2, 4, 7];
      this.note(tr, this.deg(d, root + pat[i % 4], 1), t, six * 0.8, { type: 'square', gain: 0.007, decay: 0.1, sustain: 0.2 });
    }
    this.melody(tr, t, six, cyc, root, 1, {
      type: 'sawtooth',
      gain: 0.014,
      attack: 0.02,
      decay: 0.3,
      sustain: 0.6,
      release: 0.15,
      vib: true,
    });
    if (i === 0 || i === 8) this.kick(tr, t, 0.26, 110, 42, 0.14);
    if (i === 4 || i === 12) this.snare(tr, t, 0.1, 0.24);
    if (i % 4 === 2) this.hatHit(tr, t, 0.022, 0.09);
    else if (i % 2 === 0) this.hatHit(tr, t, 0.01, 0.03);
  }

  /** 《霓虹尺子》：16 分滚动低音 + 四拍底鼓 + 双锯齿主旋律 */
  private nightWave(tr: Track, c: Step): void {
    const d = tr.def;
    const e = this.energy;
    const { t, six, i, cyc, bar, root, barLen } = c;
    if (cyc === 0) {
      this.phrase(tr, RHYTHM_MID, 0.55 + e * 0.3, 0.5 + e * 0.4);
      this.crash(tr, t);
    }
    if (i === 0) this.pad(tr, this.chord(d, root, 3), t, barLen * 0.95, 0.0035, 0.15);
    this.note(tr, this.deg(d, root, -2) + (i === 14 ? 12 : 0), t, six * 0.8, {
      type: 'sawtooth',
      gain: i % 4 === 0 ? 0.045 : 0.03,
      decay: 0.08,
      sustain: 0.3,
      release: 0.03,
    });
    if (tr.arp) {
      const pat = [0, 4, 2, 7, 4, 9, 7, 4];
      this.note(tr, this.deg(d, root + pat[i % 8], 1), t, six * 0.8, {
        type: 'square',
        gain: 0.007 + e * 0.005,
        decay: 0.1,
        sustain: 0.2,
      });
    }
    for (const det of [-10, 10])
      this.melody(tr, t, six, cyc, root, 1, {
        type: 'sawtooth',
        gain: 0.011,
        attack: 0.01,
        decay: 0.25,
        sustain: 0.6,
        release: 0.1,
        detune: det,
      });
    if (i % 4 === 0) this.kick(tr, t, 0.3, 120, 42, 0.13);
    if (i === 4 || i === 12) this.snare(tr, t, 0.11, 0.2);
    if (bar === 3 && i >= 12 && e > 0.3) this.snare(tr, t, 0.04 + (i - 12) * 0.02, 0.06);
    if (i % 4 === 2) this.hatHit(tr, t, 0.025, 0.08);
    else if (i % 2 === 0 || e > 0.5) this.hatHit(tr, t, i % 2 === 0 ? 0.01 : 0.007, 0.025);
  }

  /** 《修正液警报》：八度跳跃锯齿低音 + 小二度警报和弦 + 通鼓下行 */
  private nightBoss(tr: Track, c: Step): void {
    const d = tr.def;
    const { t, six, i, cyc, bar, root, barLen } = c;
    if (cyc === 0) {
      this.phrase(tr, RHYTHM_LONG, 0.85, 0.5);
      this.crash(tr, t, 0.06);
    }
    if (i === 0) this.pad(tr, this.chord(d, root, 3, -1), t, barLen * 0.95, 0.004, 0.2);
    const ost = [0, 12, 0, 0, 12, 0, 0, 12, 0, 12, 0, 0, 12, 0, 1, 1];
    this.note(tr, this.deg(d, root, -2) + ost[i], t, six * 0.7, {
      type: 'sawtooth',
      gain: 0.042,
      decay: 0.07,
      sustain: 0.3,
      release: 0.03,
    });
    if (i === 0 || i === 6 || i === 12) {
      const r = this.deg(d, root, 0);
      for (const m of [r, r + 1, r + 7]) this.note(tr, m, t, six * 1.2, { type: 'square', gain: 0.006, decay: 0.1, sustain: 0.2 });
    }
    this.melody(tr, t, six, cyc, root, 1, { type: 'sawtooth', gain: 0.015, attack: 0.05, release: 0.2, vib: true });
    if (tr.arp) this.melody(tr, t, six, cyc, root, 0, { type: 'square', gain: 0.007, attack: 0.05, release: 0.2 });
    if (i % 4 === 0) this.kick(tr, t, 0.3, 120, 40, 0.13);
    if (i === 4 || i === 12) this.snare(tr, t, 0.11, 0.18);
    if (bar === 3 && i >= 8 && i % 2 === 0) this.kick(tr, t, 0.18, 220 - (i - 8) * 15, 90, 0.1);
    this.hatHit(tr, t, i % 2 === 0 ? 0.02 : 0.009, 0.025);
  }

  /** 胜利短乐句：上行琶音 → IV → V → I 大和弦 */
  private victory(tr: Track, t: number, six: number, n: number): void {
    const lead: NoteOpts = { type: 'triangle', gain: 0.06, attack: 0.01, decay: 0.4, sustain: 0.6, release: 0.3, vib: true };
    const pad = (ms: number[], len: number) => {
      for (const m of ms) this.note(tr, m, t, len * six, { type: 'sawtooth', gain: 0.011, attack: 0.05, release: 0.8 });
    };
    if (n <= 6) {
      const up = [60, 64, 67, 72, 76, 79, 84][n];
      this.note(tr, up, t, six * 2, { type: 'triangle', gain: 0.05, decay: 0.3, sustain: 0.2 });
      this.note(tr, up - 12, t, six * 2, { type: 'square', gain: 0.012, decay: 0.2, sustain: 0 });
    }
    if (n === 0) this.kick(tr, t, 0.25);
    if (n === 8) {
      pad([65, 69, 72], 8);
      this.note(tr, 41, t, six * 7, { type: 'triangle', gain: 0.14 });
      this.note(tr, 81, t, six * 4, lead);
      this.kick(tr, t, 0.22);
    }
    if (n === 12) this.note(tr, 79, t, six * 4, lead);
    if (n === 16) {
      pad([67, 71, 74, 77], 8);
      this.note(tr, 43, t, six * 7, { type: 'triangle', gain: 0.14 });
      this.note(tr, 83, t, six * 4, lead);
      this.kick(tr, t, 0.22);
    }
    if (n === 20) this.note(tr, 86, t, six * 3, lead);
    if (n === 20 || n === 22 || n === 23) this.snare(tr, t, 0.05 + (n - 20) * 0.02, 0.08);
    if (n === 24) {
      pad([60, 64, 67, 72, 76], 28);
      this.note(tr, 36, t, six * 24, { type: 'triangle', gain: 0.16, release: 0.8 });
      this.note(tr, 84, t, six * 22, { ...lead, release: 1 });
      this.kick(tr, t, 0.3);
      this.hatHit(tr, t, 0.06, 1.2);
    }
    if (n >= 28 && n <= 34 && n % 2 === 0)
      this.note(tr, [88, 91, 96, 100][(n - 28) / 2], t, six * 6, { gain: 0.02, decay: 0.5, sustain: 0, release: 0.4 });
  }

  /** 失败短乐句：iv → bVI → V → i，下行旋律慢慢沉下去 */
  private defeat(tr: Track, t: number, six: number, n: number): void {
    const lead: NoteOpts = { type: 'sine', gain: 0.06, attack: 0.03, decay: 0.6, sustain: 0.5, release: 0.4, vib: true };
    const pad = (ms: number[], len: number) => {
      for (const m of ms) this.note(tr, m, t, len * six, { type: 'triangle', gain: 0.02, attack: 0.15, release: 0.8 });
    };
    const steps: Record<number, () => void> = {
      0: () => (pad([62, 65, 69], 8), this.note(tr, 38, t, six * 7, { type: 'triangle', gain: 0.13 }), this.note(tr, 76, t, six * 3, lead)),
      3: () => this.note(tr, 74, t, six * 3, lead),
      6: () => this.note(tr, 72, t, six * 2, lead),
      8: () => (pad([65, 69, 72], 8), this.note(tr, 41, t, six * 7, { type: 'triangle', gain: 0.13 }), this.note(tr, 69, t, six * 4, lead)),
      12: () => this.note(tr, 67, t, six * 4, lead),
      16: () => (
        pad([64, 68, 71], 8),
        this.note(tr, 40, t, six * 7, { type: 'triangle', gain: 0.13 }),
        this.note(tr, 68, t, six * 7, lead)
      ),
      24: () => {
        pad([57, 60, 64], 28);
        this.note(tr, 33, t, six * 26, { type: 'triangle', gain: 0.15, release: 1 });
        this.note(tr, 69, t, six * 22, { ...lead, gain: 0.045, release: 1.2 });
        this.kick(tr, t, 0.25, 80, 38, 0.3);
      },
    };
    steps[n]?.();
  }
}
