/**
 * 书桌防线 MCP 服务（stdio）。让任意 MCP 客户端里的模型直接玩游戏（文档 10 §11）。
 *
 *   Claude Code：  claude mcp add desk-defense -- npx vite-node scripts/mcp-server.ts
 *   手动运行：     npm run mcp
 *
 * 注意：stdio 传输占用 stdout，所有日志只能写 stderr。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpGameServer } from '../src/agent/mcp';

const game = new McpGameServer();
const server = new Server({ name: 'desk-defense', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: game.listTools() }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const res = game.callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
  return { content: res.content, isError: res.isError };
});

await server.connect(new StdioServerTransport());
process.stderr.write('desk-defense MCP server ready (stdio)\n');
