/**
 * 原创生成式配乐（纯 WebAudio，无音频文件）。
 *
 * - 6 种状态：菜单（lo-fi 书桌）、布防（轻快）、波次（推进）、Boss（紧张）、胜利 / 失败短乐句
 * - 每种状态一首「曲子」：和弦进行 + 低音 + 带变奏的旋律 + 用噪声做的轻打击乐
 * - 状态切换时新旧曲目交叉淡入淡出；短乐句播完自动回到菜单曲
 * - 省电：setInterval + lookahead 预排音符；每首曲子的滤波 / 打击乐滤波器常驻复用；
 *   标签页隐藏时停掉调度器（AudioContext 由 audio.ts 负责 suspend）
 *
 * 音乐不影响对局结果，所以可以随意用 Math.random。
 */

export type MusicState = 'menu' | 'build' | 'wave' | 'boss' | 'victory' | 'defeat';

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const rand = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];
const chance = (p: number) => Math.random() < p;

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];

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

interface Def {
  bpm: number;
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

const DEFS: Record<MusicState, Def> = {
  // 《台灯下》：ii–V–I–vi，摇摆的 lo-fi 节奏 + 唱片底噪
  menu: { bpm: 74, swing: 0.22, tonic: 60, scale: MAJOR, prog: [1, 4, 0, 5], cutoff: 2300, echo: 0.28, level: 1, fadeIn: 2.2 },
  // 《便利贴》：I–V–vi–IV，拨弦琶音
  build: { bpm: 96, swing: 0.1, tonic: 65, scale: MAJOR, prog: [0, 4, 5, 3], cutoff: 4200, echo: 0.2, level: 0.95, fadeIn: 1.6 },
  // 《纸页边缘》：i–VI–III–VII，八分音符推进的低音
  wave: { bpm: 120, swing: 0, tonic: 57, scale: MINOR, prog: [0, 5, 2, 6], cutoff: 5200, echo: 0.14, level: 1.15, fadeIn: 0.7 },
  // 《红墨水》：弗里吉亚 i–bII–i–vii，16 分音符低音持续音 + 3-3-2 鼓
  boss: { bpm: 138, swing: 0, tonic: 50, scale: PHRYGIAN, prog: [0, 1, 0, 6], cutoff: 4600, echo: 0.12, level: 1.1, fadeIn: 0.45 },
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
}

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
      const d = DEFS[this.state];
      if (d.bars && d.then) this.state = d.then;
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
    if (s === this.state && (this.tracks.some((t) => t.state === s && t.endAt === Infinity) || !this.enabled)) return;
    this.state = s;
    if (this.enabled) this.crossfade();
  }

  // ───────────── 曲目管理 ─────────────

  private crossfade(): void {
    const ctx = this.ctx;
    const def = DEFS[this.state];
    const now = ctx.currentTime;
    this.fadeOutAll(def.bars ? 0.25 : Math.max(0.5, def.fadeIn * 0.9));
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.linearRampToValueAtTime(def.level, now + def.fadeIn);
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
    hat.frequency.value = 7000;
    hat.connect(drums);
    const snare = ctx.createBiquadFilter();
    snare.type = 'bandpass';
    snare.frequency.value = 1700;
    snare.Q.value = 0.8;
    snare.connect(drums);
    // 回声时值：附点八分
    const beat = 60 / def.bpm;
    this.delay.delayTime.setTargetAtTime(Math.min(1.4, beat * 0.75), now, 0.3);
    this.tracks.push({
      state: this.state,
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
      const six = 60 / d.bpm / 4;
      while (tr.next < horizon && tr.next < tr.endAt) {
        if (d.bars && tr.step >= d.bars * 16) {
          tr.endAt = tr.next;
          if (this.state === tr.state && d.then && this.enabled) this.setState(d.then);
          break;
        }
        const i = tr.step % 16;
        const t = tr.next + (i % 2 === 1 ? d.swing * six : 0);
        this.playStep(tr, t, six);
        tr.step++;
        tr.next += six;
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

  // ───────────── 乐器 ─────────────

  private note(tr: Track, m: number, t: number, dur: number, o: NoteOpts = {}): void {
    if (this.voices > MAX_VOICES) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
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

  private playStep(tr: Track, t: number, six: number): void {
    const d = tr.def;
    const i = tr.step % 16;
    const bar = Math.floor(tr.step / 16);
    const root = d.prog[bar % d.prog.length];
    const cyc = tr.step % 64;
    const barLen = six * 16;
    switch (tr.state) {
      case 'menu':
        return this.menu(tr, t, six, i, cyc, root, barLen);
      case 'build':
        return this.build(tr, t, six, i, cyc, root, barLen);
      case 'wave':
        return this.wave(tr, t, six, i, cyc, root, barLen);
      case 'boss':
        return this.boss(tr, t, six, i, cyc, root, barLen);
      case 'victory':
        return this.victory(tr, t, six, tr.step);
      case 'defeat':
        return this.defeat(tr, t, six, tr.step);
    }
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
