import type { Dict } from '../../index';

// 命名空间 core · 精简排行榜（榜名 / 默认昵称前缀；src/shared 与 src/meta 用；zh-CN）
export default {
  'core.board.endless': '无尽榜',
  'core.board.campaign': '战役 · {map}',
  'core.board.custom': '自定义（不排名）',
  'core.online.nickPrefix': '玩家',
} satisfies Dict;
