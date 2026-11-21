/**
 * JSON 动作模式（toolMode: 'json'）——给工具调用不可靠的小模型 / 本地模型用（文档 10 §6.4）。
 *
 * 模型不调用原生工具，而是只输出一个 JSON 对象：
 *   {"actions":[{"tool":"place_tower","args":{"tower":"pencil","x":3,"y":5}}, ...], "note":"..."}
 * 我们解析 → 逐个按工具 schema 校验 → 依次执行。只读工具（get_state / preview_placement / get_tower / get_catalog）
 * 的结果会作为下一条 user 消息回给模型，允许它再出一轮动作；出现 end_turn 或没有只读工具时本回合结束。
 */
import type { AgentToolDef, JsonSchema } from '../tools';
import { LEGACY_TOOLS, validateToolInput } from '../tools';

export interface JsonAction {
  tool: string;
  args: Record<string, unknown>;
}

export interface ParsedActions {
  actions: JsonAction[];
  note?: string;
  /** 顶层 end（结构化备忘）；有值 = 本回合结束 */
  end?: Record<string, unknown>;
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
  const act = tools.find((t) => t.name === 'act');
  const reads = tools.filter((t) => t.kind === 'read' || t.name === 'suggest');
  const lines = reads.map((t) => `- ${t.name} ${sig(t.input_schema)}`);
  const actLine = act ? `Game actions: {"do":"place","tower":"pencil","x":3,"y":5} — same fields as the act tool: ${act.description.split('Fields per do: ')[1] ?? ''}` : '';
  return `# Output format (JSON action mode)
You cannot call tools natively. Reply with ONLY one JSON object, no prose, no code fences:
{"actions":[{"do":"place","tower":"pencil","x":3,"y":5},{"do":"start_wave"}],"end":{"plan":"…"}}
Actions run in order; "end" finishes the turn and updates your MEMO. To read first, use {"actions":[{"tool":"preview","args":{…}}]} without "end": results are sent back and you reply again.
${actLine}
Read tools:
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
  const o = raw as { actions?: unknown; note?: unknown; end?: unknown };
  if (typeof o.note === 'string') out.note = o.note.slice(0, 600);
  if (o.end && typeof o.end === 'object') out.end = o.end as Record<string, unknown>;
  else if (o.end === true) out.end = {};
  const list = Array.isArray(o.actions) ? o.actions : Array.isArray(raw) ? raw : null;
  if (!list) {
    out.errors.push('missing "actions" array');
    return out;
  }
  const names = new Set(allowed.map((t) => t.name));
  // 能用 act 的角色也接受旧的细粒度工具名（小模型常照旧格式输出）
  if (names.has('act')) for (const t of LEGACY_TOOLS) if (t.roles.includes('player')) names.add(t.name);
  let group: Record<string, unknown>[] | null = null;
  for (const [i, a] of list.entries()) {
    if (typeof a !== 'object' || a === null) { out.errors.push(`actions[${i}] is not an object`); continue; }
    if (typeof (a as { do?: unknown }).do === 'string' && names.has('act')) {
      // {"do":…} 动作：连续的合并成一次 act 调用
      if (!group) {
        group = [];
        out.actions.push({ tool: 'act', args: { actions: group } });
      }
      group.push(a as Record<string, unknown>);
      continue;
    }
    group = null;
    const { tool, args } = a as { tool?: unknown; args?: unknown };
    if (typeof tool !== 'string' || !names.has(tool)) { out.errors.push(`actions[${i}].tool "${String(tool)}" is not an available tool`); continue; }
    const input = (args ?? {}) as Record<string, unknown>;
    const errs = validateToolInput(tool, input);
    if (errs.length) { out.errors.push(`actions[${i}] ${tool}: ${errs.join('; ')}`); continue; }
    out.actions.push({ tool, args: input });
  }
  for (const a of out.actions) {
    if (a.tool !== 'act') continue;
    const errs = validateToolInput('act', a.args);
    if (errs.length) out.errors.push(`act: ${errs.join('; ')}`);
  }
  out.actions = out.actions.filter((a) => a.tool !== 'act' || !validateToolInput('act', a.args).length);
  // 顶层 end 挂到最后一个 act 上；没有 act 时单独发一个空 act 结束回合
  if (out.end && names.has('act')) {
    const lastAct = [...out.actions].reverse().find((a) => a.tool === 'act');
    if (lastAct) lastAct.args = { ...lastAct.args, end: out.end };
    else out.actions.push({ tool: 'act', args: { actions: [], end: out.end } });
  }
  return out;
}

export const READ_TOOLS = new Set(['get_state', 'get_tower', 'preview_placement', 'get_catalog', 'observe', 'preview']);
