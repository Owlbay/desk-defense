/** 批量对局（scripts/agent-batch.ts）的纯函数：昵称、设备 id。 */
import { createHash } from 'node:crypto';

import { NICK_MAX } from '../src/shared/leaderboard';

/** 由字符串派生一个固定的 v4 形 UUID（同一昵称 + 模型 → 同一设备 id → 榜上同一行） */
export function uuidFrom(s: string): string {
  const b = createHash('sha256').update(s).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/**
 * 昵称最多 NICK_MAX（24）个字：模板里的 {model} 太长时保留模型名的末尾（同一家的模型前缀相同、区别在后面），
 * 例如 deepseek-v4-flash → ~v4-flash（不用「…」：服务端按 NFKC 计字数，它会变成三个点）。榜上另有模型标记，昵称只用来一眼区分。
 */
export function fitNickname(templateRaw: string, model: string): string {
  let template = templateRaw;
  const short = [...model.replace(/^.*\//, '').normalize('NFKC')];
  template = template.normalize('NFKC');
  if (!template.includes('{model}')) return [...template].slice(0, NICK_MAX).join('');
  const room = Math.max(2, NICK_MAX - [...template.replaceAll('{model}', '')].length);
  const part = short.length <= room ? short.join('') : `~${short.slice(short.length - (room - 1)).join('')}`;
  return [...template.replaceAll('{model}', part)].slice(0, NICK_MAX).join('');
}
