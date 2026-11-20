import type { GameEvent, SkillId, TowerId } from '../core/types';

/**
 * 合成音效（WebAudio，无音频文件）+ 简单的生成式背景音乐。
 * 手机浏览器要求用户手势后才能出声：首次 pointerdown / keydown 时解锁。
 */

export type Sfx =
  | 'click'
  | 'select'
  | 'error'
  | 'place'
  | 'sell'
  | 'upgrade'
  | 'levelXp'
  | 'tierUp'
  | 'fire'
  | 'hit'
  | 'death'
  | 'bossDeath'
  | 'leak'
  | 'waveStart'
  | 'waveEnd'
  | 'bossWarn'
  | 'coins'
  | 'perkOffer'
  | 'perk'
  | 'win'
  | 'lose'
  | 'skill'
  // 文档 09 / 11
  | 'eventWarn'
  | 'eventStart'
  | 'dropWarn'
  | 'dropLand'
  | 'coin'
  | 'crateOpen'
  | 'countdown'
  | 'evolveStar'
  | 'mythic'
  | 'ability'
  // 苍蝇拍：电蚊拍连锁闪电
  | 'zap';

const MIN_GAP: Partial<Record<Sfx, number>> = {
  fire: 0.07,
  hit: 0.06,
  death: 0.05,
  coins: 0.08,
  click: 0.03,
  levelXp: 0.12,
  coin: 0.04,
  eventWarn: 0.4,
  eventStart: 0.4,
  zap: 0.08,
};

const PENTA = [0, 2, 4, 7, 9];
const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

type Ctx = AudioContext;

class AudioEngine {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private last = new Map<string, number>();
  private voices = 0;
  private sfxVol = 0.8;
  private musicVol = 0.5;
  private musicWanted = false;
  private musicTimer: number | null = null;
  private nextBeat = 0;
  private beat = 0;
  private chord = 0;
  private intensity = 0;
  unlocked = false;

  /** 安装首次手势解锁 */
  install(): void {
    const unlock = () => {
      this.unlock();
      if (this.unlocked) {
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('keydown', unlock, true);
        window.removeEventListener('touchend', unlock, true);
      }
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    window.addEventListener('touchend', unlock, true);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend().catch(() => {});
      else if (this.unlocked) void this.ctx.resume().catch(() => {});
    });
  }

  unlock(): void {
    try {
      if (!this.ctx) {
        const AC: typeof AudioContext | undefined =
          window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 4;
        this.master.connect(comp);
        comp.connect(this.ctx.destination);
        this.sfxBus = this.ctx.createGain();
        this.musicBus = this.ctx.createGain();
        this.sfxBus.connect(this.master);
        this.musicBus.connect(this.master);
        this.applyVolumes();
        const len = Math.floor(this.ctx.sampleRate * 0.6);
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
      // iOS：播放一个静音缓冲以真正解锁
      const b = this.ctx.createBufferSource();
      b.buffer = this.ctx.createBuffer(1, 1, 22050);
      b.connect(this.ctx.destination);
      b.start(0);
      this.unlocked = true;
      if (this.musicWanted) this.startMusicLoop();
    } catch {
      /* 无音频也能玩 */
    }
  }

  setVolumes(sfx: number, music: number): void {
    this.sfxVol = sfx;
    this.musicVol = music;
    this.applyVolumes();
    if (this.musicWanted && music > 0) this.startMusicLoop();
  }

  private applyVolumes(): void {
    if (!this.ctx || !this.sfxBus || !this.musicBus) return;
    const t = this.ctx.currentTime;
    this.sfxBus.gain.setTargetAtTime(this.sfxVol * this.sfxVol * 0.9, t, 0.03);
    this.musicBus.gain.setTargetAtTime(this.musicVol * this.musicVol * 0.35, t, 0.1);
  }

  // ───────────── 合成原语 ─────────────

  private tone(
    freq: number,
    dur: number,
    opts: { type?: OscillatorType; gain?: number; slide?: number; delay?: number; attack?: number; bus?: GainNode | null; detune?: number } = {},
  ): void {
    const ctx = this.ctx;
    const bus = opts.bus ?? this.sfxBus;
    if (!ctx || !bus) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = opts.type ?? 'sine';
    o.frequency.setValueAtTime(freq, t0);
    if (opts.detune) o.detune.value = opts.detune;
    if (opts.slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slide), t0 + dur);
    const peak = opts.gain ?? 0.3;
    const a = opts.attack ?? 0.005;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(bus);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
    this.voices++;
    o.onended = () => {
      this.voices--;
      o.disconnect();
      g.disconnect();
    };
  }

  private noise(dur: number, opts: { freq?: number; q?: number; gain?: number; delay?: number; type?: BiquadFilterType; sweep?: number } = {}): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus || !this.noiseBuf) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = opts.type ?? 'bandpass';
    f.frequency.setValueAtTime(opts.freq ?? 1200, t0);
    if (opts.sweep) f.frequency.exponentialRampToValueAtTime(opts.sweep, t0 + dur);
    f.Q.value = opts.q ?? 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.3, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.sfxBus);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
    this.voices++;
    src.onended = () => {
      this.voices--;
      src.disconnect();
      f.disconnect();
      g.disconnect();
    };
  }

  private arp(notes: number[], step: number, opts: { type?: OscillatorType; gain?: number; len?: number } = {}): void {
    notes.forEach((n, i) => this.tone(midi(n), opts.len ?? step * 2.2, { type: opts.type ?? 'triangle', gain: opts.gain ?? 0.22, delay: i * step }));
  }

  // ───────────── 音效 ─────────────

  play(name: Sfx, variant?: string): void {
    if (!this.ctx || !this.unlocked || this.sfxVol <= 0 || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const key = variant ? `${name}:${variant}` : name;
    const gap = MIN_GAP[name];
    if (gap) {
      const l = this.last.get(name) ?? -1;
      if (now - l < gap) return;
    }
    if (this.voices > 40 && (name === 'fire' || name === 'hit' || name === 'death')) return;
    this.last.set(name, now);
    this.last.set(key, now);
    const r = 1 + (Math.random() - 0.5) * 0.08;
    switch (name) {
      case 'click':
        this.tone(880 * r, 0.05, { type: 'triangle', gain: 0.12 });
        break;
      case 'select':
        this.tone(660 * r, 0.06, { type: 'triangle', gain: 0.14 });
        this.tone(990 * r, 0.06, { type: 'triangle', gain: 0.1, delay: 0.04 });
        break;
      case 'error':
        this.tone(220, 0.12, { type: 'square', gain: 0.08, slide: 160 });
        this.tone(180, 0.14, { type: 'square', gain: 0.06, delay: 0.08, slide: 130 });
        break;
      case 'place':
        this.noise(0.08, { freq: 500, q: 0.8, gain: 0.35 });
        this.tone(150 * r, 0.12, { type: 'sine', gain: 0.4, slide: 70 });
        break;
      case 'sell':
        this.arp([84, 88, 91], 0.05, { type: 'square', gain: 0.07, len: 0.12 });
        break;
      case 'upgrade':
        this.arp([67, 71, 74, 79], 0.055, { gain: 0.2 });
        break;
      case 'levelXp':
        this.tone(midi(79) * r, 0.12, { type: 'triangle', gain: 0.12 });
        this.tone(midi(86) * r, 0.16, { type: 'triangle', gain: 0.1, delay: 0.06 });
        break;
      case 'tierUp':
        this.arp([60, 64, 67, 72, 76, 79, 84], 0.05, { gain: 0.2, len: 0.3 });
        this.noise(0.5, { freq: 6000, q: 0.5, gain: 0.08, type: 'highpass', delay: 0.1 });
        break;
      case 'fire':
        this.fire(variant as TowerId | undefined, r);
        break;
      case 'hit':
        this.noise(0.035, { freq: 2400 * r, q: 2, gain: 0.06 });
        break;
      case 'death':
        this.tone(520 * r, 0.09, { type: 'triangle', gain: 0.1, slide: 180 });
        this.noise(0.06, { freq: 1600, q: 1, gain: 0.07 });
        break;
      case 'bossDeath':
        this.noise(0.9, { freq: 900, q: 0.6, gain: 0.4, sweep: 120, type: 'lowpass' });
        this.tone(110, 0.8, { type: 'sawtooth', gain: 0.18, slide: 40 });
        this.arp([72, 76, 79, 84], 0.09, { gain: 0.18, len: 0.4 });
        break;
      case 'leak':
        this.tone(330, 0.25, { type: 'sawtooth', gain: 0.12, slide: 140 });
        this.tone(165, 0.3, { type: 'square', gain: 0.06, slide: 90, delay: 0.03 });
        break;
      case 'waveStart':
        this.tone(midi(72), 0.14, { type: 'triangle', gain: 0.2 });
        this.tone(midi(79), 0.22, { type: 'triangle', gain: 0.2, delay: 0.1 });
        this.noise(0.12, { freq: 3000, q: 0.7, gain: 0.05, delay: 0.1 });
        break;
      case 'waveEnd':
        this.arp([76, 79, 84], 0.07, { gain: 0.15 });
        break;
      case 'bossWarn':
        for (let i = 0; i < 3; i++) {
          this.tone(196, 0.32, { type: 'sawtooth', gain: 0.14, delay: i * 0.38, slide: 185 });
          this.tone(98, 0.32, { type: 'square', gain: 0.08, delay: i * 0.38 });
        }
        break;
      case 'coins':
        this.tone(midi(88) * r, 0.08, { type: 'square', gain: 0.05 });
        this.tone(midi(93) * r, 0.12, { type: 'square', gain: 0.05, delay: 0.05 });
        break;
      case 'perkOffer':
        this.arp([72, 79, 84, 88], 0.08, { type: 'sine', gain: 0.18, len: 0.5 });
        break;
      case 'perk':
        this.arp([79, 83, 86, 91], 0.045, { gain: 0.18, len: 0.25 });
        this.noise(0.3, { freq: 7000, q: 0.5, gain: 0.06, type: 'highpass' });
        break;
      case 'win':
        this.arp([60, 64, 67, 72, 67, 72, 76, 79, 84], 0.11, { gain: 0.22, len: 0.35 });
        break;
      case 'lose':
        this.arp([67, 63, 60, 55], 0.22, { type: 'sawtooth', gain: 0.1, len: 0.5 });
        break;
      case 'skill':
        this.skill(variant as SkillId | undefined);
        break;
      case 'eventWarn':
        // variant = tone：bad 低沉双音 / good 明亮上行 / neutral 中性铃
        if (variant === 'bad') {
          this.tone(midi(62), 0.18, { type: 'square', gain: 0.07 });
          this.tone(midi(61), 0.26, { type: 'square', gain: 0.07, delay: 0.2 });
        } else if (variant === 'good') {
          this.arp([79, 84, 88], 0.06, { type: 'sine', gain: 0.14, len: 0.25 });
        } else {
          this.tone(midi(76), 0.3, { type: 'triangle', gain: 0.12 });
          this.tone(midi(81), 0.3, { type: 'triangle', gain: 0.08, delay: 0.12 });
        }
        break;
      case 'eventStart':
        if (variant === 'bad') {
          this.tone(150, 0.4, { type: 'sawtooth', gain: 0.12, slide: 90 });
          this.noise(0.25, { freq: 500, q: 0.8, gain: 0.12, type: 'lowpass' });
        } else if (variant === 'good') {
          this.arp([72, 76, 79, 84, 88], 0.05, { gain: 0.16, len: 0.3 });
          this.noise(0.3, { freq: 7000, q: 0.5, gain: 0.05, type: 'highpass', delay: 0.1 });
        } else {
          this.noise(0.45, { freq: 600, q: 0.7, gain: 0.12, sweep: 2400 });
        }
        break;
      case 'dropWarn':
        // 纸箱下坠的哨声
        this.tone(1400, 0.7, { type: 'sine', gain: 0.07, slide: 500 });
        break;
      case 'dropLand':
        this.noise(0.4, { freq: 300, q: 0.6, gain: 0.45, sweep: 80, type: 'lowpass' });
        this.tone(90, 0.35, { type: 'sine', gain: 0.45, slide: 40 });
        this.noise(0.25, { freq: 2500, q: 0.6, gain: 0.06, delay: 0.08 });
        break;
      case 'coin':
        this.tone(midi(91) * r, 0.06, { type: 'square', gain: 0.05 });
        this.tone(midi(96) * r, 0.14, { type: 'square', gain: 0.05, delay: 0.05 });
        break;
      case 'crateOpen':
        this.noise(0.12, { freq: 900, q: 1.2, gain: 0.18 });
        this.arp([76, 80, 83, 88], 0.05, { type: 'triangle', gain: 0.15, len: 0.3 });
        break;
      case 'countdown': {
        // variant = 剩余秒数；最后一下更高
        const last = variant === '1';
        this.tone(last ? midi(88) : midi(81), last ? 0.16 : 0.09, { type: 'square', gain: 0.06 });
        break;
      }
      case 'evolveStar':
        this.arp([79, 83, 86, 91, 95], 0.06, { type: 'sine', gain: 0.18, len: 0.4 });
        this.tone(midi(103), 0.5, { type: 'sine', gain: 0.05, delay: 0.3 });
        break;
      case 'mythic':
        this.tone(midi(48), 0.25, { type: 'sine', gain: 0.3, slide: midi(36) });
        this.noise(0.5, { freq: 5000, q: 0.4, gain: 0.12, type: 'highpass', delay: 0.25 });
        this.arp([60, 67, 72, 76, 79, 84, 88, 91], 0.06, { gain: 0.2, len: 0.45 });
        this.tone(midi(96), 1.1, { type: 'sine', gain: 0.08, delay: 0.5 });
        break;
      case 'zap':
        this.noise(0.09, { freq: 5200 * r, q: 6, gain: 0.05 });
        this.tone(1900 * r, 0.06, { type: 'square', gain: 0.025, slide: 2600 });
        break;
      case 'ability':
        this.tone(midi(69), 0.3, { type: 'sawtooth', gain: 0.07, slide: midi(93) });
        this.arp([81, 88, 93], 0.05, { type: 'triangle', gain: 0.14, len: 0.3 });
        this.noise(0.3, { freq: 3000, q: 0.6, gain: 0.08, sweep: 8000 });
        break;
    }
  }

  private fire(t: TowerId | undefined, r: number): void {
    switch (t) {
      case 'pencil':
        this.noise(0.03, { freq: 3500 * r, q: 3, gain: 0.05 });
        break;
      case 'stapler':
        this.noise(0.04, { freq: 1800 * r, q: 4, gain: 0.07 });
        this.tone(900 * r, 0.03, { type: 'square', gain: 0.03 });
        break;
      case 'glue':
        this.tone(240 * r, 0.08, { type: 'sine', gain: 0.07, slide: 120 });
        break;
      case 'lamp':
        this.tone(1300 * r, 0.06, { type: 'sine', gain: 0.03, slide: 1800 });
        break;
      case 'compass':
      case 'ruler':
        this.noise(0.08, { freq: 900 * r, q: 1, gain: 0.05, sweep: 2400 });
        break;
      case 'eraser':
        this.tone(140 * r, 0.06, { type: 'triangle', gain: 0.08, slide: 90 });
        break;
      case 'pen':
        this.noise(0.05, { freq: 700 * r, q: 2, gain: 0.06 });
        break;
      case 'swatter':
        // 挥拍的风声 + 拍下的「啪」
        this.noise(0.07, { freq: 600 * r, q: 0.8, gain: 0.05, sweep: 2600 });
        this.noise(0.035, { freq: 1500 * r, q: 1.5, gain: 0.09, delay: 0.06 });
        break;
      default:
        this.noise(0.03, { freq: 2600 * r, q: 2, gain: 0.04 });
    }
  }

  private skill(id: SkillId | undefined): void {
    switch (id) {
      case 'eraser_strike':
        this.noise(0.35, { freq: 400, q: 0.6, gain: 0.4, sweep: 90, type: 'lowpass' });
        this.tone(120, 0.3, { type: 'sine', gain: 0.4, slide: 45 });
        break;
      case 'bell':
        [0, 0.02].forEach((d, i) => {
          this.tone(midi(84 + i * 7), 1.2, { type: 'sine', gain: 0.16, delay: d });
          this.tone(midi(84 + i * 7) * 2.76, 0.6, { type: 'sine', gain: 0.05, delay: d });
        });
        for (let i = 0; i < 6; i++) this.tone(midi(91), 0.05, { type: 'triangle', gain: 0.06, delay: 0.05 * i });
        break;
      case 'whiteout_zone':
        this.noise(0.35, { freq: 1200, q: 0.8, gain: 0.18, sweep: 300 });
        break;
      case 'caffeine':
        this.arp([60, 67, 72, 79, 84], 0.04, { type: 'sawtooth', gain: 0.07, len: 0.18 });
        break;
      case 'ruler_sweep':
        this.noise(0.3, { freq: 400, q: 1.5, gain: 0.25, sweep: 5000 });
        this.tone(200, 0.2, { type: 'triangle', gain: 0.15, slide: 600 });
        break;
      case 'scholarship':
        for (let i = 0; i < 5; i++) this.tone(midi(88 + (i % 2) * 5), 0.08, { type: 'square', gain: 0.05, delay: i * 0.06 });
        break;
      case 'relocate':
        this.tone(300, 0.25, { type: 'triangle', gain: 0.15, slide: 700 });
        this.tone(700, 0.2, { type: 'triangle', gain: 0.12, slide: 300, delay: 0.22 });
        break;
      case 'inspiration':
        this.arp([76, 81, 84, 88, 93], 0.05, { type: 'sine', gain: 0.16, len: 0.4 });
        break;
      case 'magnifier':
        this.tone(midi(81), 0.5, { type: 'sine', gain: 0.12, slide: midi(88) });
        this.noise(0.3, { freq: 5000, q: 0.5, gain: 0.05, type: 'highpass' });
        break;
      case 'seal_tape':
        // 撕胶带
        this.noise(0.35, { freq: 1800, q: 2.5, gain: 0.16, sweep: 3800 });
        this.noise(0.08, { freq: 600, q: 1, gain: 0.15, delay: 0.34 });
        break;
      default:
        this.arp([72, 79], 0.06, { gain: 0.15 });
    }
  }

  /** 把游戏事件映射为音效 */
  onGameEvent(ev: GameEvent): void {
    switch (ev.type) {
      case 'place':
        return this.play('place');
      case 'sell':
        return this.play('sell');
      case 'levelUp':
        return this.play(ev.tierChanged ? 'tierUp' : ev.byXp ? 'levelXp' : 'upgrade');
      case 'fire':
        return this.play('fire', ev.tower);
      case 'beam':
      case 'sweep':
        return;
      case 'hit':
        return this.play('hit');
      case 'death':
        return this.play(ev.boss ? 'bossDeath' : 'death');
      case 'leak':
        return this.play('leak');
      case 'waveStart':
        return this.play(ev.tags.includes('boss') ? 'bossWarn' : 'waveStart');
      case 'waveEnd':
        return this.play('waveEnd');
      case 'skill':
        return this.play('skill', ev.skill);
      case 'perkOffer':
        return this.play('perkOffer');
      case 'perkChosen':
        return this.play('perk');
      case 'gameOver':
        return this.play(ev.won ? 'win' : 'lose');
      case 'gold':
        if (ev.reason === 'interest' || ev.reason === 'piggy' || ev.reason === 'early') this.play('coins');
        return;
      case 'randomEvent':
        if (ev.phase === 'warn') return this.play('eventWarn', ev.tone);
        if (ev.phase === 'start') return this.play('eventStart', ev.tone);
        return;
      case 'spawnerDrop':
        if (ev.phase === 'warn') return this.play('dropWarn');
        if (ev.phase === 'land') return this.play('dropLand');
        if (ev.phase === 'demolish') return this.play('sell');
        return;
      case 'pickup':
        if (ev.phase === 'collect') return this.play(ev.kind === 'coin' ? 'coin' : 'crateOpen');
        return;
      case 'autoWave':
        return this.play('countdown', String(ev.secondsLeft));
      case 'evolve':
        return this.play(ev.mythic ? 'mythic' : 'evolveStar');
      case 'towerAbility':
        return this.play('ability');
      case 'chain':
        return this.play('zap');
      default:
        return;
    }
  }

  // ───────────── 背景音乐（五声音阶的轻柔生成乐） ─────────────

  setMusic(on: boolean): void {
    this.musicWanted = on;
    if (on) this.startMusicLoop();
    else this.stopMusicLoop();
  }

  /** 0..1：战斗时稍微热闹一点 */
  setIntensity(v: number): void {
    this.intensity = Math.max(0, Math.min(1, v));
  }

  private startMusicLoop(): void {
    if (!this.ctx || !this.unlocked || this.musicTimer !== null || this.musicVol <= 0) return;
    this.nextBeat = this.ctx.currentTime + 0.1;
    this.musicTimer = window.setInterval(() => this.scheduleMusic(), 90);
  }

  private stopMusicLoop(): void {
    if (this.musicTimer !== null) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  private scheduleMusic(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    if (ctx.state !== 'running' || this.musicVol <= 0) {
      this.nextBeat = ctx.currentTime + 0.1;
      return;
    }
    const spb = 60 / (84 + this.intensity * 16) / 2; // 八分音符
    const chords = [0, -3, 5, 2]; // I vi IV ii（相对 C）
    while (this.nextBeat < ctx.currentTime + 0.3) {
      const t = this.nextBeat - ctx.currentTime;
      const step = this.beat % 16;
      if (step === 0) this.chord = (this.chord + 1) % chords.length;
      const root = 48 + chords[this.chord];
      if (step === 0 || step === 8) {
        this.tone(midi(root), spb * 7, { type: 'sine', gain: 0.22, delay: t, attack: 0.03, bus: this.musicBus });
        this.tone(midi(root + 7), spb * 7, { type: 'sine', gain: 0.08, delay: t, attack: 0.08, bus: this.musicBus });
      }
      const pattern = (this.beat * 7 + this.chord * 3) % 5;
      const density = 0.42 + this.intensity * 0.25;
      if (step % 2 === 0 || Math.random() < density * 0.5) {
        if (Math.random() < density) {
          const deg = PENTA[(pattern + Math.floor(Math.random() * 3)) % PENTA.length];
          const oct = Math.random() < 0.3 ? 84 : 72;
          this.tone(midi(oct + chords[this.chord] + deg), spb * 2.5, {
            type: 'triangle',
            gain: 0.09,
            delay: t,
            attack: 0.01,
            bus: this.musicBus,
          });
        }
      }
      if (this.intensity > 0.3 && step % 4 === 2) {
        // 轻轻的"铅笔敲桌"
        this.tickPerc(t);
      }
      this.nextBeat += spb;
      this.beat++;
    }
  }

  private tickPerc(delay: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus || !this.noiseBuf) return;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 3200;
    f.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
    src.connect(f);
    f.connect(g);
    g.connect(this.musicBus);
    src.start(t0);
    src.stop(t0 + 0.07);
    src.onended = () => {
      src.disconnect();
      f.disconnect();
      g.disconnect();
    };
  }
}

export const audio = new AudioEngine();
