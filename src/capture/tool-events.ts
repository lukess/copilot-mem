import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextInjection, MemoryStore, ToolEvent } from '../storage/memory-store.ts';

// Copilot CLI appends every session event to <session-state>/<session id>/events.jsonl. Tool calls
// arrive as `tool.execution_start` (name + arguments) and `tool.execution_complete` (success, result),
// paired by toolCallId. Reading the file passively costs Copilot nothing, unlike a postToolUse hook
// that would run a process before every tool result is returned.

export const MAX_SUMMARY_CHARS = 240;
export const MAX_RESULT_CHARS = 200;
/** Bash/agent plumbing that says nothing about the work itself. */
const SKIPPED_TOOLS = new Set([
  'read_bash', 'write_bash', 'stop_bash', 'list_bash', 'read_agent', 'list_agents', 'write_agent', 'tool_search_tool',
]);
/** Larger reads are processed in this many bytes at a time. */
const CHUNK_BYTES = 8 * 1024 * 1024;

const SECRET_PATTERNS: RegExp[] = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  /(authorization:\s*(?:bearer|basic|token)\s+)\S+/gi,
  // KEY=v, key: v, "key":"v" and env names like AWS_SECRET_ACCESS_KEY=v.
  /([\w.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[\w.-]*['"]?\s*[=:]\s*['"]?)[^\s'",}]{4,}/gi,
  // --password v, --token=v, ...
  /(--?(?:password|passwd|pass|secret|token|api[_-]?key)(?:=|\s+)['"]?)[^\s'"]{3,}/gi,
  // mysql -pSECRET (only for MySQL clients: elsewhere -p is often a port or a flag).
  /(\bmysql(?:dump|admin)?\b[^|;&\n]*?\s-p)[^\s'"]+/gi,
];

const SECRET_KEY = /passw(or)?d|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization/i;

/** Best-effort removal of credentials from text we keep. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((out, re) => out.replace(re, (match, prefix: string) =>
    match.startsWith(prefix) && prefix !== match ? `${prefix}[redacted]` : '[redacted]'), text);
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));

/** A one-line description of a tool call, e.g. `bash: Run tests $ bun test`. */
export function summarizeToolCall(tool: string, args: unknown): string {
  const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  let detail: string;
  switch (tool) {
    case 'bash':
    case 'powershell':
      detail = `${str(a.description)}${a.command ? ` $ ${str(a.command)}` : ''}`;
      break;
    case 'view':
    case 'edit':
    case 'create':
      detail = str(a.path);
      break;
    case 'grep':
    case 'rg':
    case 'glob':
      detail = `${str(a.pattern)}${a.paths ? ` in ${str(a.paths)}` : ''}${a.glob ? ` (${str(a.glob)})` : ''}`;
      break;
    case 'report_intent':
      detail = str(a.intent);
      break;
    case 'web_fetch':
      detail = str(a.url);
      break;
    case 'sql':
    case 'task':
      detail = str(a.description);
      break;
    default:
      // MCP and other tools: drop secret-looking keys before the arguments become text.
      detail = Object.keys(a).length ? JSON.stringify(a, (key, value) => (key && SECRET_KEY.test(key) && typeof value !== 'object' ? '[redacted]' : value)) : '';
  }
  return oneLine(redact(`${tool}${detail ? `: ${detail}` : ''}`), MAX_SUMMARY_CHARS);
}

interface RawEvent {
  type?: string;
  timestamp?: string;
  data?: {
    toolCallId?: string;
    toolName?: string;
    arguments?: unknown;
    parentToolCallId?: string;
    success?: boolean;
    result?: { content?: unknown };
    error?: unknown;
    shellExecution?: { exitCode?: number };
    hookType?: string;
    output?: { additionalContext?: unknown };
  };
}

/** True for additionalContext produced by copilot-mem's sessionStart hook (not another tool's hook). */
export function isCopilotMemContext(text: string): boolean {
  return text.startsWith('# copilot-mem:') || text.startsWith('copilot-mem memory tools are available');
}

/** Turns events.jsonl lines into tool_events rows (starts) and completion updates. */
export function parseToolEventLines(sessionId: string, lines: string[]): {
  starts: ToolEvent[];
  completions: { callId: string; success: boolean; exitCode: number | null; result: string | null }[];
  injections: ContextInjection[];
} {
  const injections: ContextInjection[] = [];
  const starts: ToolEvent[] = [];
  const completions: { callId: string; success: boolean; exitCode: number | null; result: string | null }[] = [];
  for (const line of lines) {
    // Cheap prefilter: most lines (and all of the huge ones) are not tool events.
    if (!line.includes('"tool.execution_') && !line.includes('"hook.end"')) continue;
    let event: RawEvent;
    try {
      event = JSON.parse(line) as RawEvent;
    } catch {
      continue;
    }
    const d = event.data;
    if (event.type === 'hook.end') {
      const text = d?.output?.additionalContext;
      if (d?.hookType === 'sessionStart' && event.timestamp && typeof text === 'string' && isCopilotMemContext(text)) {
        injections.push({ session_id: sessionId, injected_at: event.timestamp, text });
      }
      continue;
    }
    if (!d?.toolCallId) continue;
    if (event.type === 'tool.execution_start' && d.toolName && event.timestamp) {
      // Subagent internals: the parent's `task` call already describes the work.
      if (d.parentToolCallId || SKIPPED_TOOLS.has(d.toolName)) continue;
      starts.push({
        session_id: sessionId, call_id: d.toolCallId, tool_name: d.toolName, started_at: event.timestamp,
        summary: summarizeToolCall(d.toolName, d.arguments),
      });
    } else if (event.type === 'tool.execution_complete') {
      const success = d.success !== false;
      const exitCode = typeof d.shellExecution?.exitCode === 'number' ? d.shellExecution.exitCode : null;
      // Keep an excerpt only for failures: that's where the lesson usually is.
      const raw = !success || (exitCode !== null && exitCode !== 0) ? str(d.error ?? d.result?.content) : '';
      completions.push({ callId: d.toolCallId, success, exitCode, result: raw ? oneLine(redact(raw), MAX_RESULT_CHARS) : null });
    }
  }
  return { starts, completions, injections };
}

/** Reads complete lines appended since `offset`; returns them and the offset after the last newline. */
function readNewLines(path: string, offset: number, size: number): { lines: string[]; offset: number } {
  const fd = openSync(path, 'r');
  const lines: string[] = [];
  let position = offset;
  let carry = Buffer.alloc(0);
  try {
    while (position < size) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - position));
      const read = readSync(fd, chunk, 0, chunk.length, position);
      if (read <= 0) break;
      position += read;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      const lastNewline = data.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        carry = data;
        continue;
      }
      lines.push(...data.subarray(0, lastNewline).toString('utf8').split('\n'));
      carry = data.subarray(lastNewline + 1);
    }
  } finally {
    closeSync(fd);
  }
  // A trailing partial line is still being written; read it next time.
  return { lines, offset: position - carry.length };
}

export interface ToolEventSyncResult {
  files: number;
  newToolEvents: number;
  newInjections: number;
}

/** Incrementally mirrors tool calls from each known session's events.jsonl into `store`. */
export function syncToolEvents(sessionStateDir: string, store: MemoryStore): ToolEventSyncResult {
  const result: ToolEventSyncResult = { files: 0, newToolEvents: 0, newInjections: 0 };
  if (!existsSync(sessionStateDir)) return result;
  for (const sessionId of store.sessionIds()) {
    const path = join(sessionStateDir, sessionId, 'events.jsonl');
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    const known = store.eventOffset(sessionId);
    // A shorter file was rewritten; start over (inserts are idempotent per call id).
    const from = known !== undefined && known <= size ? known : 0;
    if (from === size) continue;
    result.files++;
    const { lines, offset } = readNewLines(path, from, size);
    const { starts, completions, injections } = parseToolEventLines(sessionId, lines);
    store.transaction(() => {
      result.newToolEvents += store.insertToolEvents(starts);
      store.completeToolEvents(sessionId, completions);
      result.newInjections += store.insertContextInjections(injections);
      store.setEventOffset(sessionId, offset);
    });
  }
  return result;
}
