import type { TowerInfo } from '../../core/types';
import { ui } from '../../game/UiStore';
import { t } from '../../i18n';
import { audio } from '../audio';
import { fmtSec, type GameCtx } from './context';

type Ability = NonNullable<TowerInfo['ability']>;

/** 能力目标说明（getter：按当前语言翻译） */
export const ABILITY_TARGET_TEXT: Record<Ability['target'], string> = {
  get none() {
    return t('ui.game.abilityTarget.none');
  },
  get circle() {
    return t('ui.game.abilityTarget.circle');
  },
  get rect3() {
    return t('ui.game.abilityTarget.rect3');
  },
  get direction() {
    return t('ui.game.abilityTarget.direction');
  },
  get axis() {
    return t('ui.game.abilityTarget.axis');
  },
  get enemy() {
    return t('ui.game.abilityTarget.enemy');
  },
  get tower() {
    return t('ui.game.abilityTarget.tower');
  },
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
    ctx.toast(
      charged && (ab.charges ?? 0) <= 0
        ? t('ui.game.noCharges', { name: ab.name })
        : t('ui.game.cooldown', { name: ab.name, s: fmtSec(ab.cd) }),
      'warn',
    );
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
