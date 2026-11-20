/**
 * JSON 动作模式（toolMode: 'json'）——给工具调用不可靠的小模型 / 本地模型用（文档 10 §6.4）。
 *
 * 模型不调用原生工具，而是只输出一个 JSON 对象：
 *   {"actions":[{"tool":"place_tower","args":{"tower":"pencil","x":3,"y":5}}, ...], "note":"..."}
 * 我们解析 → 逐个按工具 schema 校验 → 依次执行。只读工具（get_state / preview_placement / get_tower / get_catalog）
 * 的结果会作为下一条 user 消息回给模型，允许它再出一轮动作；出现 end_turn 或没有只读工具时本回合结束。
 */
import type { AgentToolDef, JsonSchema } from '../tools';
import { validateToolInput } from '../tools';

export interface JsonAction {
  tool: string;
  args: Record<string, unknown>;
}

export interface ParsedActions {
  actions: JsonAction[];
  note?: string;
  errors: string[];
}

function sig(s: JsonSchema): string {
  switch (s.type) {
    case 'string': return s.enum ? s.enum.join('|') : 'string';
    case 'integer': return 'int';
    case 'number': return 'number';
    case 'boolean': return 'bool';
    case 'array': return `[${sig(s.items)}]`;
    case 'object': return `{${Object.entries(s.properties).map(([k, v]) => `${k}${s.required.includes(k) ? '' : '?'}:${sig(v)}`).join(', ')}}`;
  }
}

/** 把工具列表压成 JSON 模式说明（附在系统提示后） */
export function jsonModeInstructions(tools: AgentToolDef[]): string {
  const lines = tools.map((t) => `- ${t.name} ${sig(t.input_schema)} — ${t.description.split('. ')[0]}.`);
  return `# Output format (JSON action mode)
You cannot call tools natively. Reply with ONLY one JSON object, no prose, no code fences:
{"actions":[{"tool":"<name>","args":{...}}, ...],"note":"<optional memo>"}
Actions run in order. If you include read-only tools (get_state, get_tower, preview_placement, get_catalog) and no end_turn, their results are sent back and you reply again. Finish with {"tool":"end_turn","args":{}}.
Available tools:
${lines.join('\n')}`;
}

/** 从模型文本里取出第一个完整 JSON 对象（容忍 ```json 包裹与前后杂字） */
export function extractJsonObject(text: string): unknown | undefined {
  const t = text.replace(/```(?:json)?/gi, '');
  const start = t.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(t.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function parseActions(text: string, allowed: AgentToolDef[]): ParsedActions {
  const out: ParsedActions = { actions: [], errors: [] };
  const raw = extractJsonObject(text);
  if (raw === undefined || typeof raw !== 'object' || raw === null) {
    out.errors.push('reply is not a JSON object');
    return out;
  }
  const o = raw as { actions?: unknown; note?: unknown };
  if (typeof o.note === 'string') out.note = o.note.slice(0, 200);
  const list = Array.isArray(o.actions) ? o.actions : Array.isArray(raw) ? raw : null;
  if (!list) {
    out.errors.push('missing "actions" array');
    return out;
  }
  const names = new Set(allowed.map((t) => t.name));
  for (const [i, a] of list.entries()) {
    if (typeof a !== 'object' || a === null) { out.errors.push(`actions[${i}] is not an object`); continue; }
    const { tool, args } = a as { tool?: unknown; args?: unknown };
    if (typeof tool !== 'string' || !names.has(tool)) { out.errors.push(`actions[${i}].tool "${String(tool)}" is not an available tool`); continue; }
    const input = (args ?? {}) as Record<string, unknown>;
    const errs = validateToolInput(tool, input);
    if (errs.length) { out.errors.push(`actions[${i}] ${tool}: ${errs.join('; ')}`); continue; }
    out.actions.push({ tool, args: input });
  }
  return out;
}

export const READ_TOOLS = new Set(['get_state', 'get_tower', 'preview_placement', 'get_catalog']);
