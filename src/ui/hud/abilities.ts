import type { TowerInfo } from '../../core/types';
import { ui } from '../../game/UiStore';
import { audio } from '../audio';
import { fmtSec, type GameCtx } from './context';

type Ability = NonNullable<TowerInfo['ability']>;

export const ABILITY_TARGET_TEXT: Record<Ability['target'], string> = {
  none: '立即释放',
  circle: '选一个位置',
  rect3: '选一块 3×3 区域',
  direction: '选一个方向',
  axis: '选一行或一列',
  enemy: '选一个敌人',
  tower: '选一座塔',
};

/**
 * 释放神话塔的主动能力（文档 11 §1.4）：
 * 无需目标的直接发送 towerAbility；需要目标的进入瞄准（ui.abilityAiming），由棋盘完成。
 */
export function castTowerAbility(ctx: GameCtx, uid: number, info?: TowerInfo | null): void {
  const ti = info ?? ctx.world.getTowerInfo(uid);
  const ab = ti?.ability;
  if (!ti || !ab) return;
  if (ui.state.abilityAiming === uid) {
    audio.play('click');
    ui.set({ abilityAiming: null, abilityAngle: null });
    return;
  }
  if (!ab.ready) {
    audio.play('error');
    const charged = ab.maxCharges !== undefined;
    ctx.toast(charged && (ab.charges ?? 0) <= 0 ? `${ab.name}：没有充能了` : `${ab.name} 冷却中（${fmtSec(ab.cd)} 秒）`, 'warn');
    return;
  }
  if (ab.target === 'none') {
    ctx.cmd({ type: 'towerAbility', uid });
    ui.set({ abilityAiming: null, abilityAngle: null });
    return;
  }
  audio.play('select');
  ui.set({ abilityAiming: uid, aiming: null, build: null, relocateFrom: null, pending: null, spawnerSelected: null });
}
