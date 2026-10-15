import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_TITLE } from './remember.ts';
import { MAX_BOOKMARK_TEXT, type MemoryStore } from './storage/memory-store.ts';

/** One question from the user and the final answer to it. */
export interface Exchange {
  question: string;
  answer: string;
  timestamp: string | null;
}

export interface SessionInfo {
  cwd: string | null;
  repository: string | null;
  branch: string | null;
}

interface Event {
  type?: string;
  timestamp?: string;
  agentId?: string;
  data?: { content?: unknown; source?: unknown; parentToolCallId?: unknown; context?: Record<string, unknown> };
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/**
 * The session's exchanges from Copilot's live events.jsonl, oldest first. Copilot's session store
 * only gets a turn once it is finalized (sometimes much later), so the in-session bookmark reads
 * the events instead. Subagent traffic is skipped; the answer is the last assistant text.
 */
export function readExchanges(eventsPath: string): { exchanges: Exchange[]; session?: SessionInfo } {
  const exchanges: Exchange[] = [];
  let session: SessionInfo | undefined;
  for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e: Event;
    try {
      e = JSON.parse(line) as Event;
    } catch {
      continue; // a line still being written
    }
    const d = e.data ?? {};
    if (e.type === 'session.start' && d.context) {
      session = { cwd: str(d.context.cwd), repository: str(d.context.repository), branch: str(d.context.branch) };
    }
    if (e.agentId || d.source || d.parentToolCallId) continue;
    if (e.type === 'user.message' && typeof d.content === 'string') {
      exchanges.push({ question: d.content, answer: '', timestamp: e.timestamp ?? null });
    } else if (e.type === 'assistant.message' && typeof d.content === 'string' && d.content.trim() && exchanges.length) {
      const last = exchanges[exchanges.length - 1];
      last.answer = d.content;
      last.timestamp = e.timestamp ?? last.timestamp;
    }
  }
  return { exchanges, session };
}

/** The session with the most recently written events.jsonl. */
export function latestSession(sessionStateDir: string): string | undefined {
  if (!existsSync(sessionStateDir)) return undefined;
  let best: { id: string; mtime: number } | undefined;
  for (const id of readdirSync(sessionStateDir)) {
    const path = join(sessionStateDir, id, 'events.jsonl');
    if (!existsSync(path)) continue;
    const mtime = statSync(path).mtimeMs;
    if (!best || mtime > best.mtime) best = { id, mtime };
  }
  return best?.id;
}

export interface BookmarkRequest {
  sessionId: string;
  /** A synced turn; otherwise the newest answered exchange. */
  turnIndex?: number;
  title?: string;
  /** Skip the newest exchange: it is the in-progress request that asked for the bookmark. */
  skipCurrent?: boolean;
  /** 1 = the newest answered exchange (after skipCurrent), 2 = the one before, ... */
  back?: number;
  sessionStateDir: string;
}

export interface BookmarkResult {
  id: number;
  created: boolean;
  title: string;
  project: string;
  turnIndex: number;
}

function defaultTitle(question: string): string {
  const line = question.split('\n').map((l) => l.trim()).find(Boolean) ?? 'Bookmarked answer';
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}\u2026` : line;
}

/** Saves one answer, word for word, with its question. Throws when there is no answer to bookmark. */
export function bookmarkAnswer(store: MemoryStore, request: BookmarkRequest, now = new Date().toISOString()): BookmarkResult {
  let found: Exchange | undefined;
  let turnIndex: number | null = null;
  let session: SessionInfo | undefined;
  const eventsPath = join(request.sessionStateDir, request.sessionId, 'events.jsonl');
  if (request.turnIndex !== undefined) {
    const turn = store.turn(request.sessionId, request.turnIndex);
    if (!turn) throw new Error(`no turn ${request.turnIndex} in session ${request.sessionId}`);
    found = { question: turn.user_message ?? '', answer: turn.assistant_response ?? '', timestamp: turn.timestamp };
    turnIndex = turn.turn_index;
  } else if (existsSync(eventsPath)) {
    const read = readExchanges(eventsPath);
    session = read.session;
    const candidates = request.skipCurrent ? read.exchanges.slice(0, -1) : read.exchanges;
    let skip = (request.back ?? 1) - 1;
    for (let i = candidates.length - 1; i >= 0 && !found; i--) {
      if (!candidates[i].answer.trim() || skip-- > 0) continue;
      found = candidates[i];
      // Until sync records the turn, its position among the session's messages stands in for its index.
      turnIndex = store.matchTurn(request.sessionId, found.question, found.answer) ?? i;
    }
  } else {
    const turn = store.turn(request.sessionId);
    if (turn) {
      found = { question: turn.user_message ?? '', answer: turn.assistant_response ?? '', timestamp: turn.timestamp };
      turnIndex = turn.turn_index;
    }
  }
  if (!found || !found.answer.trim()) throw new Error(`no answer to bookmark in session ${request.sessionId}`);
  if (found.answer.length > MAX_BOOKMARK_TEXT) throw new Error(`the answer is longer than ${MAX_BOOKMARK_TEXT} characters`);
  const title = request.title?.trim() || defaultTitle(found.question);
  if (title.length > MAX_TITLE) throw new Error(`title must be at most ${MAX_TITLE} characters`);
  const saved = store.bookmark(
    { sessionId: request.sessionId, turnIndex: turnIndex ?? 0, question: found.question, answer: found.answer, title, rename: Boolean(request.title?.trim()), occurredAt: found.timestamp },
    now,
    session,
  );
  const project = store.sessionProject(request.sessionId) ?? session?.repository ?? session?.cwd ?? 'unknown project';
  return { ...saved, project, turnIndex: turnIndex ?? 0 };
}
