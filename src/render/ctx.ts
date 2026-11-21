import type Phaser from 'phaser';

import type { Session } from '../game/Session';
import type { ArtAtlas } from './assets';
import type { Fx } from './fx';
import type { Quality } from './layout';
import type { CameraRig } from './motion';

/** 各渲染子模块共享的上下文 */
export interface RenderCtx {
  scene: Phaser.Scene;
  session: Session;
  atlas: ArtAtlas;
  fx: Fx;
  quality: Quality;
  /** 减弱动效（系统设置或应用内开关）：关闭震屏 / 缩放 / 拖尾，粒子减量 */
  reduced: boolean;
  /** 镜头（震屏、缩放冲击、闪屏） */
  cam: CameraRig;
  /** 视觉时间（秒），暂停时停止 */
  vtime: number;
  /** 本帧视觉 dt（秒），暂停时为 0；按游戏速度缩放 */
  vdt: number;
  /** 本帧真实 dt（秒） */
  rdt: number;
  /** 相机缩放（逻辑像素 → 设备像素） */
  zoom: number;
  /** 插值系数 0..1 */
  alpha: number;
}
