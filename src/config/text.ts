/**
 * 配置表的本地化文本：名称 / 说明不再写死在表里，而是在读取时按当前语言从 i18n（命名空间 data）取。
 *
 * 做法：给配置对象定义可枚举的只读 getter（`obj.name` → `t('data.tower.pencil.name')`），
 * 这样已有的 `TOWERS[id].name`、`TOWER_META[id].desc` 等读法不用改，切换语言后再读就是新语言。
 * 说明文字里的数值通过参数插值（`{dmg}` 等），数值仍以配置表为准。
 *
 * 文本不参与任何游戏逻辑 / 状态哈希；核心逻辑只读数值字段。
 */
import { t, type Params } from '../i18n';

export type TextParams = Params | (() => Params);

const resolve = (p?: TextParams): Params | undefined => (typeof p === 'function' ? p() : p);

/**
 * 在 obj 上为每个字段定义 getter：obj[field] = t(`${prefix}.${field}`, params[field])。
 * 返回同一个对象（类型上补上这些字符串字段）。
 */
export function localize<T extends object, K extends string>(
  obj: T,
  prefix: string,
  fields: readonly K[],
  params?: Partial<Record<K, TextParams>>,
): T & Record<K, string> {
  for (const f of fields) {
    const key = `${prefix}.${f}`;
    Object.defineProperty(obj, f, {
      get: () => t(key, resolve(params?.[f])),
      enumerable: true,
      configurable: true,
    });
  }
  return obj as T & Record<K, string>;
}

/** { name, desc } 两个字段的本地化文本对象 */
export function nameDesc(prefix: string, descParams?: TextParams): { name: string; desc: string } {
  return localize({}, prefix, ['name', 'desc'] as const, descParams ? { desc: descParams } : undefined);
}

/** 本地化的字符串数组（下标读取时翻译），例如阶级名 */
export function localizedList(keys: readonly string[]): string[] {
  const arr: string[] = [];
  keys.forEach((key, i) => {
    Object.defineProperty(arr, i, { get: () => t(key), enumerable: true, configurable: true });
  });
  return arr;
}

/** 条件片段：cond 为真时返回 t(key, params)，否则空串（用于说明文字里随数值出现 / 消失的半句） */
export function part(cond: boolean, key: string, params?: Params): string {
  return cond ? t(key, params) : '';
}

/**
 * 给运行时状态对象（出生点 / 随机事件 / 增益卡 / 补给选项等）挂上"活"文本：
 * 每次读取 obj[field] 时调用 getter，切换语言后界面重读即是新语言。
 * 这些字段只用于展示，不参与逻辑与 stateHash。
 */
export function liveText<T extends object>(obj: T, getters: { [K in keyof T]?: () => string }): T {
  for (const [k, get] of Object.entries(getters) as [string, () => string][]) {
    Object.defineProperty(obj, k, { get, enumerable: true, configurable: true });
  }
  return obj;
}
