import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { appendReinforcement, parseReinforcementDates, reinforcementStrength, type Rankable } from '../rank/reinforcement.ts';
import { classifyTitles, normalizeTitle, TitleCorpus } from '../dedup/near-duplicate.ts';
import type { SourceFile, SourceRef, SourceSession, SourceTurn } from '../capture/session-store-reader.ts';

// Each entry upgrades PRAGMA user_version by one. Append only; never edit a shipped migration.
export const MIGRATIONS = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     cwd TEXT,
     repository TEXT,
     branch TEXT,
     host_type TEXT,
     summary TEXT,
     created_at TEXT,
     updated_at TEXT,
     synced_at TEXT NOT NULL
   );
   CREATE INDEX idx_sessions_repository ON sessions(repository);
   CREATE INDEX idx_sessions_cwd ON sessions(cwd);

   CREATE TABLE turns (
     session_id TEXT NOT NULL,
     turn_index INTEGER NOT NULL,
     user_message TEXT,
     assistant_response TEXT,
     timestamp TEXT,
     content_hash TEXT NOT NULL,
     changed_at TEXT NOT NULL,
     PRIMARY KEY (session_id, turn_index)
   );
   CREATE INDEX idx_turns_changed_at ON turns(changed_at);

   CREATE TABLE sync_state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  `ALTER TABLE turns ADD COLUMN compressed_at TEXT;
   ALTER TABLE turns ADD COLUMN compress_attempts INTEGER NOT NULL DEFAULT 0;

   CREATE TABLE observations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     first_turn INTEGER NOT NULL,
     last_turn INTEGER NOT NULL,
     type TEXT NOT NULL,
     title TEXT NOT NULL,
     narrative TEXT NOT NULL,
     facts TEXT NOT NULL DEFAULT '[]',
     files TEXT NOT NULL DEFAULT '[]',
     model TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX idx_observations_session ON observations(session_id, first_turn);`,
  // occurred_at = when the summarized turns happened (created_at is when they were compressed).
  `ALTER TABLE observations ADD COLUMN occurred_at TEXT;
   UPDATE observations SET occurred_at = coalesce(
     (SELECT max(t.timestamp) FROM turns t
      WHERE t.session_id = observations.session_id AND t.turn_index BETWEEN observations.first_turn AND observations.last_turn),
     created_at);
   CREATE INDEX idx_observations_occurred ON observations(occurred_at, id);

   CREATE VIRTUAL TABLE observations_fts USING fts5(
     title, narrative, facts, files, content = 'observations', content_rowid = 'id', tokenize = 'porter unicode61'
   );
   INSERT INTO observations_fts(observations_fts) VALUES ('rebuild');
   CREATE TRIGGER observations_fts_insert AFTER INSERT ON observations BEGIN
     INSERT INTO observations_fts(rowid, title, narrative, facts, files)
     VALUES (new.id, new.title, new.narrative, new.facts, new.files);
   END;
   CREATE TRIGGER observations_fts_delete AFTER DELETE ON observations BEGIN
     INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts, files)
     VALUES ('delete', old.id, old.title, old.narrative, old.facts, old.files);
   END;
   CREATE TRIGGER observations_fts_update AFTER UPDATE ON observations BEGIN
     INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts, files)
     VALUES ('delete', old.id, old.title, old.narrative, old.facts, old.files);
     INSERT INTO observations_fts(rowid, title, narrative, facts, files)
     VALUES (new.id, new.title, new.narrative, new.facts, new.files);
   END;`,
  // One row per Copilot call made by the compressor; usage columns are NULL when Copilot didn't report them.
  `CREATE TABLE compress_calls (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     started_at TEXT NOT NULL,
     duration_ms INTEGER NOT NULL,
     session_id TEXT NOT NULL,
     model TEXT NOT NULL,
     status TEXT NOT NULL,
     turns INTEGER NOT NULL,
     observations INTEGER NOT NULL,
     prompt_chars INTEGER NOT NULL,
     api_ms INTEGER,
     input_tokens INTEGER,
     output_tokens INTEGER,
     cache_read_tokens INTEGER,
     cache_write_tokens INTEGER,
     reasoning_tokens INTEGER,
     nano_aiu INTEGER,
     premium_requests REAL
   );
   CREATE INDEX idx_compress_calls_started ON compress_calls(started_at);`,
  // Mirrors of Copilot's session_files / session_refs: ground truth for what a session touched.
  `CREATE TABLE session_files (
     session_id TEXT NOT NULL,
     file_path TEXT NOT NULL,
     tool_name TEXT,
     turn_index INTEGER,
     first_seen_at TEXT,
     PRIMARY KEY (session_id, file_path)
   );
   CREATE INDEX idx_session_files_path ON session_files(file_path);
   CREATE TABLE session_refs (
     session_id TEXT NOT NULL,
     ref_type TEXT NOT NULL,
     ref_value TEXT NOT NULL,
     turn_index INTEGER,
     created_at TEXT,
     PRIMARY KEY (session_id, ref_type, ref_value)
   );`,
  // Dedup: exact-title repeats bump `occurrences`; near-duplicates are review-only candidates.
  `ALTER TABLE observations ADD COLUMN occurrences INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE observations ADD COLUMN last_seen_at TEXT;
   CREATE TABLE observation_duplicates (
     observation_id INTEGER NOT NULL,
     duplicate_of INTEGER NOT NULL,
     score REAL NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (observation_id, duplicate_of)
   );
   CREATE INDEX idx_observation_duplicates_of ON observation_duplicates(duplicate_of);
   CREATE TRIGGER observation_duplicates_cleanup AFTER DELETE ON observations BEGIN
     DELETE FROM observation_duplicates WHERE observation_id = old.id OR duplicate_of = old.id;
   END;`,
  // Tool calls mirrored from <session-state>/<id>/events.jsonl, read incrementally by byte offset.
  `CREATE TABLE tool_events (
     session_id TEXT NOT NULL,
     call_id TEXT NOT NULL,
     tool_name TEXT NOT NULL,
     started_at TEXT NOT NULL,
     summary TEXT NOT NULL,
     success INTEGER,
     exit_code INTEGER,
     result TEXT,
     PRIMARY KEY (session_id, call_id)
   );
   CREATE INDEX idx_tool_events_time ON tool_events(session_id, started_at);
   CREATE TABLE event_offsets (
     session_id TEXT PRIMARY KEY,
     offset INTEGER NOT NULL
   );`,
  // Unit-length float32 vectors from a local embedding model, for semantic search.
  `CREATE TABLE observation_embeddings (
     observation_id INTEGER PRIMARY KEY,
     model TEXT NOT NULL,
     vector BLOB NOT NULL
   );
   CREATE TRIGGER observation_embeddings_cleanup AFTER DELETE ON observations BEGIN
     DELETE FROM observation_embeddings WHERE observation_id = old.id;
   END;`,
  // claude-mem's richer fields; `files` keeps its role as the files modified. The FTS index is
  // rebuilt with the new columns, and only re-indexes on changes to indexed columns.
  `ALTER TABLE observations ADD COLUMN subtitle TEXT NOT NULL DEFAULT '';
   ALTER TABLE observations ADD COLUMN concepts TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE observations ADD COLUMN files_read TEXT NOT NULL DEFAULT '[]';
   DROP TRIGGER observations_fts_insert;
   DROP TRIGGER observations_fts_delete;
   DROP TRIGGER observations_fts_update;
   DROP TABLE observations_fts;
   CREATE VIRTUAL TABLE observations_fts USING fts5(
     title, subtitle, narrative, facts, concepts, files, files_read, content = 'observations', content_rowid = 'id', tokenize = 'porter unicode61'
   );
   INSERT INTO observations_fts(observations_fts) VALUES ('rebuild');
   CREATE TRIGGER observations_fts_insert AFTER INSERT ON observations BEGIN
     INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts, files, files_read) VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts, new.concepts, new.files, new.files_read);
   END;
   CREATE TRIGGER observations_fts_delete AFTER DELETE ON observations BEGIN
     INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, facts, concepts, files, files_read) VALUES ('delete', old.id, old.title, old.subtitle, old.narrative, old.facts, old.concepts, old.files, old.files_read);
   END;
   CREATE TRIGGER observations_fts_update AFTER UPDATE OF title, subtitle, narrative, facts, concepts, files, files_read ON observations BEGIN
     INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, facts, concepts, files, files_read) VALUES ('delete', old.id, old.title, old.subtitle, old.narrative, old.facts, old.concepts, old.files, old.files_read);
     INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts, files, files_read) VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts, new.concepts, new.files, new.files_read);
   END;`,
  // ACT-R reinforcement: the days (YYYY-MM-DD) an exact-title repeat re-confirmed an observation.
  `ALTER TABLE observations ADD COLUMN reinforcement_dates TEXT NOT NULL DEFAULT '[]';
   UPDATE observations SET reinforcement_dates = json_array(date(last_seen_at))
   WHERE occurrences > 1 AND date(last_seen_at) IS NOT NULL AND date(last_seen_at) <> date(occurred_at);`,
  // One summary per finished session (claude-mem's session summaries). A row with an empty request
  // records a skipped or unusable reply, so the session is only retried after new observations.
  `CREATE TABLE session_summaries (
     session_id TEXT PRIMARY KEY,
     request TEXT NOT NULL,
     investigated TEXT NOT NULL,
     learned TEXT NOT NULL,
     completed TEXT NOT NULL,
     next_steps TEXT NOT NULL,
     notes TEXT NOT NULL,
     observation_count INTEGER NOT NULL,
     last_observation_id INTEGER NOT NULL,
     model TEXT NOT NULL,
     created_at TEXT NOT NULL,
     occurred_at TEXT NOT NULL
   );
   CREATE INDEX idx_session_summaries_occurred ON session_summaries(occurred_at);
   ALTER TABLE compress_calls ADD COLUMN kind TEXT NOT NULL DEFAULT 'compress';`,
  // 12: user-declared related projects (stored both ways; repository names or directories).
  `CREATE TABLE project_links (
     project TEXT NOT NULL,
     linked TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (project, linked)
   ) WITHOUT ROWID;`,
  // 13: what copilot-mem's sessionStart hook injected, from events.jsonl. Offsets are reset so
  // existing sessions are re-read once (tool_events inserts are idempotent).
  `CREATE TABLE context_injections (
     session_id TEXT NOT NULL,
     injected_at TEXT NOT NULL,
     text TEXT NOT NULL,
     PRIMARY KEY (session_id, injected_at)
   ) WITHOUT ROWID;
   DELETE FROM event_offsets;`,
  // 14: dashboard curation. Pinned observations always lead the session-start context; edited_at marks hand edits.
  `ALTER TABLE observations ADD COLUMN pinned_at TEXT;
   ALTER TABLE observations ADD COLUMN edited_at TEXT;
   CREATE INDEX idx_observations_pinned ON observations(pinned_at) WHERE pinned_at IS NOT NULL;`,
  // 15: bookmarked answers, kept word for word. The observation (type "bookmark") makes them searchable.
  `CREATE TABLE bookmarks (
     observation_id INTEGER PRIMARY KEY,
     session_id TEXT NOT NULL,
     turn_index INTEGER NOT NULL,
     question TEXT NOT NULL,
     answer TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (session_id, turn_index)
   );
   CREATE TRIGGER bookmarks_cleanup AFTER DELETE ON observations BEGIN
     DELETE FROM bookmarks WHERE observation_id = old.id;
   END;`,
];

export type UpsertResult = 'inserted' | 'updated' | 'unchanged';

/** Types the compressor may produce. */
export const COMPRESSED_TYPES = ['decision', 'bugfix', 'feature', 'refactor', 'change', 'discovery'] as const;
/**
 * `note` is a user-authored memory (remember); `bookmark` is an answer the user kept word for word.
 * Compression never produces or changes either.
 */
export const OBSERVATION_TYPES = [...COMPRESSED_TYPES, 'note', 'bookmark'] as const;
/** Manual notes belong to a synthetic session per project, so all project scoping applies to them. */
export const MANUAL_SESSION_PREFIX = 'manual:';
/** Bookmarked answers are longer than notes; this only guards against runaway input. */
export const MAX_BOOKMARK_TEXT = 200_000;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

/** claude-mem's knowledge-type tags (code mode). */
export const CONCEPTS = ['how-it-works', 'why-it-exists', 'what-changed', 'problem-solution', 'gotcha', 'pattern', 'trade-off'] as const;

export interface Observation {
  type: ObservationType;
  title: string;
  /** One-sentence explanation. */
  subtitle?: string;
  narrative: string;
  facts: string[];
  /** Knowledge-type tags from CONCEPTS. */
  concepts?: string[];
  /** Files created or edited. */
  files: string[];
  /** Files only read. */
  files_read?: string[];
}

export interface PendingTurn {
  session_id: string;
  turn_index: number;
  user_message: string | null;
  assistant_response: string | null;
  timestamp: string | null;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
}

/** What Copilot reported for one call (`--usage-output-file`). 1 AI credit = 1e9 nano AIU. */
export interface CallUsage {
  apiMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  nanoAiu: number;
  premiumRequests: number;
}

export type CallKind = 'compress' | 'summarize';

/** ok = observations stored; bad_output = unparseable reply; error = the call itself failed (auth, timeout). */
export type CallStatus = 'ok' | 'bad_output' | 'error';

export interface CompressCall {
  /** compress = turns to observations; summarize = a session's observations to its summary. */
  kind?: CallKind;
  startedAt: string;
  durationMs: number;
  sessionId: string;
  model: string;
  status: CallStatus;
  turns: number;
  observations: number;
  promptChars: number;
  usage?: CallUsage;
}

export interface UsageTotals {
  calls: number;
  failed: number;
  turns: number;
  observations: number;
  durationMs: number;
  apiMs: number;
  /** Calls with usage reported; token and credit sums cover only these. */
  measuredCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  credits: number;
  premiumRequests: number;
}

export interface RecentCall {
  id: number;
  kind: CallKind;
  startedAt: string;
  durationMs: number;
  project: string;
  model: string;
  status: CallStatus;
  turns: number;
  observations: number;
  inputTokens: number | null;
  outputTokens: number | null;
  credits: number | null;
}

export interface CompressStats {
  total: UsageTotals;
  last24h: UsageTotals;
  /** Per local day, newest first (last 14 days with calls). */
  days: (UsageTotals & { day: string })[];
  recent: RecentCall[];
  /**
   * Projected cost of compressing every pending turn, from the measured averages; null until measured.
   * `perTurn` holds the rates (calls, credits, ms per turn) to project any other pending count.
   */
  backlog: {
    pendingTurns: number;
    calls: number;
    credits: number;
    durationMs: number;
    perTurn: { calls: number; credits: number; durationMs: number };
  } | null;
}

export interface SearchFilter {
  query?: string;
  /** Repository (owner/name) or a directory (also matches sessions under it); several are OR-ed. */
  project?: string | string[];
  type?: ObservationType;
  dateStart?: string;
  dateEnd?: string;
  /** Only observations the user pinned. */
  pinned?: boolean;
  /** With `project`: leave out bookmarks from other projects (they otherwise match everywhere). */
  localOnly?: boolean;
  limit: number;
  offset: number;
}

export interface ObservationSummary {
  id: number;
  type: ObservationType;
  title: string;
  occurred_at: string;
  session_id: string;
  repository: string | null;
  cwd: string | null;
  /** When the user pinned it (always in session-start context), else null. */
  pinned_at: string | null;
}

/** Fields the user can change from the dashboard. */
export interface ObservationEdit {
  type: ObservationType;
  title: string;
  subtitle: string;
  narrative: string;
  facts: string[];
}

export interface ProjectSummary {
  project: string;
  turns: number;
  pendingTurns: number;
  observations: number;
  lastActivity: string | null;
}

export interface TouchedFile {
  path: string;
  tool: string | null;
  turn: number | null;
}

export interface SessionRef {
  type: string;
  value: string;
  turn: number | null;
}

export interface ToolEvent {
  session_id: string;
  call_id: string;
  tool_name: string;
  started_at: string;
  summary: string;
}

export interface TurnToolEvent {
  turn_index: number;
  tool_name: string;
  summary: string;
  success: number | null;
  exit_code: number | null;
  result: string | null;
}

export interface ContextInjection {
  session_id: string;
  injected_at: string;
  text: string;
}

/** A session in the dashboard's session list, with whether and how it used copilot-mem. */
export interface SessionRow {
  id: string;
  repository: string | null;
  cwd: string | null;
  branch: string | null;
  /** Copilot's title for the session, else the start of the first prompt. */
  title: string | null;
  created_at: string | null;
  updated_at: string | null;
  turns: number;
  pendingTurns: number;
  observations: number;
  summarized: number;
  injections: number;
  recallCalls: number;
}

export interface SessionTurn {
  turn_index: number;
  timestamp: string | null;
  user_message: string | null;
  assistant_response: string | null;
  compressed: number;
}

export interface RecallCall {
  started_at: string;
  tool_name: string;
  summary: string;
  success: number | null;
}

export interface SessionDetail {
  session: SessionRow;
  summary: SessionSummary | null;
  observations: (ObservationSummary & { first_turn: number; last_turn: number })[];
  turns: SessionTurn[];
  injections: ContextInjection[];
  recallCalls: RecallCall[];
  /** Bookmarked turns, with their observation IDs. */
  bookmarks: { turn_index: number; observation_id: number }[];
}

export interface RecallOverview {
  sessions: number;
  withContext: number;
  withRecallCalls: number;
  /** Sessions with injected context or copilot-mem tool calls (or both). */
  usedMemory: number;
  recallCalls: number;
  byTool: { tool: string; calls: number }[];
}

/** One local calendar day of activity (dates use the machine's time zone, like the dashboard). */
export interface ActivityDay {
  day: string;
  turns: number;
  sessions: number;
  observations: number;
}

export interface SimilarObservation {
  id: number;
  title: string;
  score: number;
}

export interface BatchResult {
  inserted: number;
  /** Observations folded into an existing one with the same normalized title in the same project. */
  merged: number;
  /** Near-duplicate pairs recorded for review. */
  candidates: number;
}

export interface SummaryFields {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string;
}

export interface SessionSummary extends SummaryFields {
  session_id: string;
  repository: string | null;
  cwd: string | null;
  branch: string | null;
  observation_count: number;
  occurred_at: string;
}

export interface SummaryInput {
  session_id: string;
  repository: string | null;
  cwd: string | null;
  branch: string | null;
  first_request: string | null;
  observations: { id: number; type: ObservationType; title: string; subtitle: string; narrative: string }[];
}

export interface ObservationDetail extends ObservationSummary, Observation {
  subtitle: string;
  concepts: string[];
  files_read: string[];
  first_turn: number;
  last_turn: number;
  branch: string | null;
  /** How many times this observation was produced (exact-title repeats are merged into it). */
  occurrences: number;
  last_seen_at: string | null;
  /** When the user last edited it in the dashboard, else null. */
  edited_at: string | null;
  /** Bookmarks only: the question, word for word (the narrative holds the answer). */
  question?: string;
  /** Near-duplicate observations in the same project, best match first. */
  similar: SimilarObservation[];
  /** Files Copilot's tools touched during the observation's turns. */
  touched_files: TouchedFile[];
  /** Commits, PRs and issues referenced anywhere in the session. */
  refs: SessionRef[];
}

type JsonColumn = 'facts' | 'concepts' | 'files' | 'files_read';
const SUMMARY_COLUMNS = 'o.id, o.type, o.title, o.occurred_at, o.session_id, s.repository, s.cwd, o.pinned_at';
/** A session's project as listed by projects(): its repository, else its cwd. */
const PROJECT_KEY = "coalesce(s.repository, s.cwd, '(unknown)')";
const USAGE_TOTALS = `count(*) AS calls, coalesce(sum(status <> 'ok'), 0) AS failed,
  coalesce(sum(turns), 0) AS turns, coalesce(sum(observations), 0) AS observations,
  coalesce(sum(duration_ms), 0) AS durationMs, coalesce(sum(api_ms), 0) AS apiMs, count(nano_aiu) AS measuredCalls,
  coalesce(sum(input_tokens), 0) AS inputTokens, coalesce(sum(output_tokens), 0) AS outputTokens,
  coalesce(sum(cache_read_tokens), 0) AS cacheReadTokens, coalesce(sum(reasoning_tokens), 0) AS reasoningTokens,
  coalesce(sum(nano_aiu), 0) / 1e9 AS credits, coalesce(sum(premium_requests), 0) AS premiumRequests`;
const PROJECT_CLAUSE = "(s.repository = ? OR s.cwd = ? OR s.cwd LIKE ? ESCAPE '\\')";
/** Copilot names MCP tools <server>-<tool>; copilot-mem's server is registered as "copilot-mem". */
export const RECALL_TOOL_PREFIX = 'copilot-mem-';
const RECALL_TOOL_LIKE = "e.tool_name LIKE 'copilot-mem-%'";
const SESSION_COLUMNS = `s.id, s.repository, s.cwd, s.branch,
  coalesce(nullif(s.summary, ''), (SELECT substr(t.user_message, 1, 120) FROM turns t WHERE t.session_id = s.id ORDER BY t.turn_index LIMIT 1)) AS title,
  s.created_at, s.updated_at,
  (SELECT count(*) FROM turns t WHERE t.session_id = s.id) AS turns,
  (SELECT count(*) FROM turns t WHERE t.session_id = s.id AND t.compressed_at IS NULL) AS pendingTurns,
  (SELECT count(*) FROM observations o WHERE o.session_id = s.id) AS observations,
  EXISTS (SELECT 1 FROM session_summaries ss WHERE ss.session_id = s.id AND ss.request <> '') AS summarized,
  (SELECT count(*) FROM context_injections c WHERE c.session_id = s.id) AS injections,
  (SELECT count(*) FROM tool_events e WHERE e.session_id = s.id AND ${RECALL_TOOL_LIKE}) AS recallCalls`;

function projectParams(project: string): string[] {
  const dir = project.replace(/\/+$/, '');
  return [project, dir, `${dir.replace(/[\\%_]/g, '\\$&')}/%`];
}

/** Reciprocal rank fusion constant (the usual 60). */
const RRF_K = 60;
/**
 * Relevance multiplier per unit of reinforcement strength: an observation re-confirmed yesterday
 * gets about +7%, enough to pass a few comparably relevant results but not to bury a better match.
 */
const REINFORCEMENT_BOOST = 0.1;
/** Extra candidates per ranking beyond the requested page, so fusion can reorder. */
const HYBRID_POOL = 100;
/** Default threshold below which a vector match is noise (bge-m3: unrelated ~0.33, loosely related ~0.45, relevant 0.55+); local models set their own. */
export const MIN_SEMANTIC_SCORE = 0.5;

/** Dot product of a query vector with a stored float32 BLOB; vectors are unit length. */
function dot(query: Float32Array, blob: Uint8Array): number {
  const stored = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  if (stored.length !== query.length) return -1;
  let sum = 0;
  for (let i = 0; i < query.length; i++) sum += query[i] * stored[i];
  return sum;
}

/** A bare date means "through the end of that day". */
function endBound(dateEnd: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateEnd) ? `${dateEnd}T23:59:59.999Z` : dateEnd;
}

/** WHERE terms (over `o` and `s`) for a search filter's project, type and date range. */
function filterClause(filter: SearchFilter): { where: string[]; params: SQLInputValue[] } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  const projects = [filter.project ?? []].flat().filter(Boolean);
  if (projects.length) {
    // Bookmarks are global: found from any project, while still showing where they came from.
    where.push(`(${projects.map(() => PROJECT_CLAUSE).join(' OR ')}${filter.localOnly ? '' : " OR o.type = 'bookmark'"})`);
    params.push(...projects.flatMap(projectParams));
  }
  if (filter.type) {
    where.push('o.type = ?');
    params.push(filter.type);
  }
  if (filter.dateStart) {
    where.push('o.occurred_at >= ?');
    params.push(filter.dateStart);
  }
  if (filter.dateEnd) {
    where.push('o.occurred_at <= ?');
    params.push(endBound(filter.dateEnd));
  }
  if (filter.pinned) where.push('o.pinned_at IS NOT NULL');
  return { where, params };
}

/**
 * Turns free text into an FTS5 query that cannot be a syntax error: each word becomes a quoted
 * term, OR-ed together so bm25 ranks documents matching more (and rarer) terms first.
 */
export function toFtsQuery(text: string): string | null {
  const terms = [...new Set((text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []))].slice(0, 32);
  return terms.length ? terms.map((t) => `"${t}"`).join(' OR ') : null;
}

function hashTurn(turn: SourceTurn): string {
  return createHash('sha256').update(JSON.stringify([turn.user_message, turn.assistant_response])).digest('hex');
}

/** copilot-mem's own database (~/.copilot-mem/memory.db). */
export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly statements: Record<string, StatementSync>;

  constructor(path: string) {
    // Mirrors raw transcripts, so keep it private like ~/.copilot.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    // busy_timeout first: switching to WAL needs a lock another process may hold.
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    this.migrate();
    this.statements = {
      upsertSession: this.db.prepare(
        `INSERT INTO sessions (id, cwd, repository, branch, host_type, summary, created_at, updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cwd = excluded.cwd, repository = excluded.repository, branch = excluded.branch,
           host_type = excluded.host_type, summary = excluded.summary, created_at = excluded.created_at,
           updated_at = excluded.updated_at, synced_at = excluded.synced_at`,
      ),
      turnHash: this.db.prepare('SELECT content_hash FROM turns WHERE session_id = ? AND turn_index = ?'),
      upsertTurn: this.db.prepare(
        `INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp, content_hash, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, turn_index) DO UPDATE SET
           user_message = excluded.user_message, assistant_response = excluded.assistant_response,
           timestamp = excluded.timestamp, content_hash = excluded.content_hash, changed_at = excluded.changed_at`,
      ),
      getState: this.db.prepare('SELECT value FROM sync_state WHERE key = ?'),
      setState: this.db.prepare(
        'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ),
    };
  }

  /**
   * The MCP server, hooks, worker and viewer may open the database at once after an upgrade, so each
   * step takes the write lock first and re-reads the version: only one process applies it.
   */
  private migrate(): void {
    const version = () => (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    while (version() < MIGRATIONS.length) {
      this.transaction(() => {
        const current = version();
        if (current >= MIGRATIONS.length) return;
        this.db.exec(MIGRATIONS[current]);
        this.db.exec(`PRAGMA user_version = ${current + 1}`);
      });
    }
  }

  /** Takes the write lock up front (waiting up to busy_timeout), so a read-then-write can't fail as locked. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  upsertSession(session: SourceSession, syncedAt: string): void {
    this.statements.upsertSession.run(
      session.id, session.cwd, session.repository, session.branch, session.host_type,
      session.summary, session.created_at, session.updated_at, syncedAt,
    );
  }

  /** `changed_at` only moves when the turn's content changes; phase 2 uses it to find work. */
  upsertTurn(turn: SourceTurn, changedAt: string): UpsertResult {
    const hash = hashTurn(turn);
    const existing = this.statements.turnHash.get(turn.session_id, turn.turn_index) as
      | { content_hash: string }
      | undefined;
    if (existing?.content_hash === hash) return 'unchanged';
    this.statements.upsertTurn.run(
      turn.session_id, turn.turn_index, turn.user_message, turn.assistant_response, turn.timestamp, hash, changedAt,
    );
    return existing ? 'updated' : 'inserted';
  }

  getState(key: string): string | undefined {
    return (this.statements.getState.get(key) as { value: string } | undefined)?.value;
  }

  setState(key: string, value: string): void {
    this.statements.setState.run(key, value);
  }

  /**
   * Uncompressed turns that have not exhausted their attempts, ordered by session then turn.
   * `project` matches exactly the key of projects() (repository, else cwd), without subdirectories.
   */
  pendingTurns(maxAttempts: number, project?: string): PendingTurn[] {
    return this.db
      .prepare(
        `SELECT t.session_id, t.turn_index, t.user_message, t.assistant_response, t.timestamp,
                s.cwd, s.repository, s.branch
         FROM turns t LEFT JOIN sessions s ON s.id = t.session_id
         WHERE t.compressed_at IS NULL AND t.compress_attempts < ?
           ${project === undefined ? '' : `AND ${PROJECT_KEY} = ?`}
         ORDER BY t.session_id, t.turn_index`,
      )
      .all(...(project === undefined ? [maxAttempts] : [maxAttempts, project])) as unknown as PendingTurn[];
  }

  completeBatch(sessionId: string, turnIndexes: number[], observations: Observation[], model: string, now: string): BatchResult {
    const insert = this.db.prepare(
      `INSERT INTO observations
         (session_id, first_turn, last_turn, type, title, narrative, facts, files, model, created_at, subtitle, concepts, files_read, occurred_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, coalesce(
         (SELECT max(timestamp) FROM turns WHERE session_id = ?1 AND turn_index BETWEEN ?2 AND ?3), ?10))
       RETURNING id, occurred_at`,
    );
    const bump = this.db.prepare(
      `UPDATE observations SET occurrences = occurrences + 1, last_seen_at = coalesce(
         (SELECT max(timestamp) FROM turns WHERE session_id = ? AND turn_index BETWEEN ? AND ?), ?)
       WHERE id = ? RETURNING last_seen_at, reinforcement_dates`,
    );
    const reinforce = this.db.prepare('UPDATE observations SET reinforcement_dates = ? WHERE id = ?');
    const markDone = this.db.prepare('UPDATE turns SET compressed_at = ? WHERE session_id = ? AND turn_index = ?');
    const firstTurn = Math.min(...turnIndexes);
    const lastTurn = Math.max(...turnIndexes);
    const result: BatchResult = { inserted: 0, merged: 0, candidates: 0 };
    this.transaction(() => {
      const existing = this.projectTitles(sessionId);
      const corpus = new TitleCorpus(existing.map((e) => e.title));
      for (const o of observations) corpus.add(o.title);
      for (const o of observations) {
        const norm = normalizeTitle(o.title);
        const same = norm === '' ? undefined : existing.find((e) => normalizeTitle(e.title) === norm);
        if (same) {
          const seen = bump.get(sessionId, firstTurn, lastTurn, now, same.id) as { last_seen_at: string; reinforcement_dates: string };
          const dates = parseReinforcementDates(seen.reinforcement_dates);
          const next = appendReinforcement(dates, seen.last_seen_at.slice(0, 10));
          if (next !== dates) reinforce.run(JSON.stringify(next), same.id);
          result.merged++;
          continue;
        }
        const { id } = insert.get(
          sessionId, firstTurn, lastTurn, o.type, o.title, o.narrative,
          JSON.stringify(o.facts), JSON.stringify(o.files), model, now,
          o.subtitle ?? '', JSON.stringify(o.concepts ?? []), JSON.stringify(o.files_read ?? []),
        ) as { id: number };
        result.inserted++;
        for (const other of existing) {
          const { tier, score } = classifyTitles(o.title, other.title, corpus);
          if (tier === 'candidate') result.candidates += this.recordDuplicate(id, other.id, score, now);
        }
        existing.push({ id, title: o.title });
      }
      for (const index of turnIndexes) markDone.run(now, sessionId, index);
    });
    return result;
  }

  /** Titles of observations in the same project as `sessionId` (projects() key). */
  private projectTitles(sessionId: string): { id: number; title: string }[] {
    return (
      this.db
        .prepare(
          `SELECT o.id, o.title FROM observations o LEFT JOIN sessions s ON s.id = o.session_id
           WHERE ${PROJECT_KEY} = (SELECT ${PROJECT_KEY} FROM (SELECT ? AS id) x LEFT JOIN sessions s ON s.id = x.id)
             AND o.type <> 'bookmark'
           ORDER BY o.id`,
        )
        .all(sessionId) as { id: number; title: string }[]
    ).map((row) => ({ ...row }));
  }

  private recordDuplicate(observationId: number, duplicateOf: number, score: number, now: string): number {
    return Number(
      this.db
        .prepare('INSERT OR IGNORE INTO observation_duplicates (observation_id, duplicate_of, score, created_at) VALUES (?, ?, ?, ?)')
        .run(observationId, duplicateOf, score, now).changes,
    );
  }

  /**
   * Re-checks every pair of observations within each project and records near-duplicates (and
   * pre-existing exact-title pairs) as review candidates. Never merges or deletes anything.
   */
  scanDuplicates(now: string): { projects: number; observations: number; candidates: number } {
    const rows = this.db
      .prepare(`SELECT o.id, o.title, ${PROJECT_KEY} AS project FROM observations o LEFT JOIN sessions s ON s.id = o.session_id ORDER BY o.id`)
      .all() as { id: number; title: string; project: string }[];
    const byProject = new Map<string, { id: number; title: string }[]>();
    for (const r of rows) byProject.set(r.project, [...(byProject.get(r.project) ?? []), { id: r.id, title: r.title }]);
    let candidates = 0;
    this.transaction(() => {
      for (const group of byProject.values()) {
        const corpus = new TitleCorpus(group.map((g) => g.title));
        for (let i = 0; i < group.length; i++) {
          for (let j = 0; j < i; j++) {
            const { tier, score } = classifyTitles(group[i].title, group[j].title, corpus);
            if (tier !== 'none') candidates += this.recordDuplicate(group[i].id, group[j].id, score, now);
          }
        }
      }
    });
    return { projects: byProject.size, observations: rows.length, candidates };
  }

  duplicateCount(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM observation_duplicates').get() as { n: number }).n;
  }

  sessionIds(): string[] {
    return (this.db.prepare("SELECT id FROM sessions WHERE id NOT LIKE 'manual:%' ORDER BY id").all() as { id: string }[]).map((r) => r.id);
  }

  eventOffset(sessionId: string): number | undefined {
    return (this.db.prepare('SELECT offset FROM event_offsets WHERE session_id = ?').get(sessionId) as { offset: number } | undefined)?.offset;
  }

  setEventOffset(sessionId: string, offset: number): void {
    this.db
      .prepare('INSERT INTO event_offsets (session_id, offset) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET offset = excluded.offset')
      .run(sessionId, offset);
  }

  /** Returns how many tool calls were new. */
  insertToolEvents(events: ToolEvent[]): number {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO tool_events (session_id, call_id, tool_name, started_at, summary) VALUES (?, ?, ?, ?, ?)',
    );
    let inserted = 0;
    for (const e of events) inserted += Number(stmt.run(e.session_id, e.call_id, e.tool_name, e.started_at, e.summary).changes);
    return inserted;
  }

  completeToolEvents(sessionId: string, completions: { callId: string; success: boolean; exitCode: number | null; result: string | null }[]): void {
    const stmt = this.db.prepare('UPDATE tool_events SET success = ?, exit_code = ?, result = ? WHERE session_id = ? AND call_id = ?');
    for (const c of completions) stmt.run(c.success ? 1 : 0, c.exitCode, c.result, sessionId, c.callId);
  }

  insertContextInjections(rows: ContextInjection[]): number {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO context_injections (session_id, injected_at, text) VALUES (?, ?, ?)');
    let inserted = 0;
    for (const r of rows) inserted += Number(stmt.run(r.session_id, r.injected_at, r.text).changes);
    return inserted;
  }

  /** Sessions newest first, optionally of one project and only those that used copilot-mem. */
  sessions(filter: {
    project?: string;
    query?: string;
    recallOnly?: boolean;
    dateStart?: string;
    dateEnd?: string;
    limit: number;
    offset: number;
  }): SessionRow[] {
    const { where, params } = filterClause({ project: filter.project, localOnly: true, limit: 0, offset: 0 });
    where.push("s.id NOT LIKE 'manual:%'");
    if (filter.dateStart || filter.dateEnd) {
      // Sessions with a turn in the range.
      where.push('EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id AND t.timestamp >= ? AND t.timestamp <= ?)');
      params.push(filter.dateStart ?? '', filter.dateEnd ? endBound(filter.dateEnd) : '9999');
    }
    // Every word must appear in the session's metadata or in one of its turns (case-insensitive for ASCII).
    for (const word of (filter.query ?? '').split(/\s+/).filter(Boolean).slice(0, 8)) {
      const like = `%${word.replace(/[\\%_]/g, '\\$&')}%`;
      where.push(`(s.id LIKE ?1 ESCAPE '\\' OR s.summary LIKE ?1 ESCAPE '\\' OR s.repository LIKE ?1 ESCAPE '\\'
        OR s.cwd LIKE ?1 ESCAPE '\\' OR s.branch LIKE ?1 ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id
                   AND (t.user_message LIKE ?1 ESCAPE '\\' OR t.assistant_response LIKE ?1 ESCAPE '\\')))`.replaceAll('?1', '?'));
      params.push(...Array(7).fill(like));
    }
    if (filter.recallOnly) {
      where.push(`(EXISTS (SELECT 1 FROM context_injections c WHERE c.session_id = s.id)
        OR EXISTS (SELECT 1 FROM tool_events e WHERE e.session_id = s.id AND ${RECALL_TOOL_LIKE}))`);
    }
    return (
      this.db
        .prepare(
          `SELECT ${SESSION_COLUMNS} FROM sessions s WHERE ${where.join(' AND ')}
           ORDER BY coalesce(s.updated_at, s.created_at) DESC, s.id LIMIT ? OFFSET ?`,
        )
        .all(...params, filter.limit, filter.offset) as unknown as SessionRow[]
    ).map((r) => ({ ...r }));
  }

  /** Everything recorded for one session: turns, observations, summary and copilot-mem usage. */
  sessionDetail(id: string): SessionDetail | undefined {
    const session = this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions s WHERE s.id = ?`).get(id) as SessionRow | undefined;
    if (!session) return undefined;
    const all = <T>(sql: string) => (this.db.prepare(sql).all(id) as unknown as T[]).map((r) => ({ ...r }));
    const [summary] = this.summaries({ sessionId: id, limit: 1 });
    return {
      session: { ...session },
      summary: summary ?? null,
      observations: all(
        `SELECT ${SUMMARY_COLUMNS}, o.first_turn, o.last_turn FROM observations o LEFT JOIN sessions s ON s.id = o.session_id
         WHERE o.session_id = ? ORDER BY o.first_turn, o.id`,
      ),
      turns: all(
        `SELECT turn_index, timestamp, user_message, assistant_response, compressed_at IS NOT NULL AS compressed
         FROM turns WHERE session_id = ? ORDER BY turn_index`,
      ),
      injections: all('SELECT session_id, injected_at, text FROM context_injections WHERE session_id = ? ORDER BY injected_at'),
      recallCalls: all(
        `SELECT e.started_at, e.tool_name, e.summary, e.success FROM tool_events e
         WHERE e.session_id = ? AND ${RECALL_TOOL_LIKE} ORDER BY e.started_at, e.call_id`,
      ),
      bookmarks: this.bookmarkedTurns(id),
    };
  }

  /** How many sessions (optionally of one project) got context injected or called copilot-mem's tools. */
  recallOverview(project?: string): RecallOverview {
    const { where, params } = filterClause({ project, localOnly: true, limit: 0, offset: 0 });
    where.push("s.id NOT LIKE 'manual:%'");
    const scope = `SELECT s.id FROM sessions s WHERE ${where.join(' AND ')}`;
    const counts = this.db
      .prepare(
        `SELECT count(*) AS sessions,
                (SELECT count(DISTINCT c.session_id) FROM context_injections c WHERE c.session_id IN (${scope})) AS withContext,
                (SELECT count(DISTINCT e.session_id) FROM tool_events e WHERE ${RECALL_TOOL_LIKE} AND e.session_id IN (${scope})) AS withRecallCalls,
                (SELECT count(*) FROM (SELECT c.session_id FROM context_injections c UNION
                                       SELECT e.session_id FROM tool_events e WHERE ${RECALL_TOOL_LIKE}) u
                 WHERE u.session_id IN (${scope})) AS usedMemory
         FROM (${scope})`,
      )
      .get(...params, ...params, ...params, ...params) as Omit<RecallOverview, 'recallCalls' | 'byTool'>;
    const byTool = (
      this.db
        .prepare(
          `SELECT substr(e.tool_name, ${RECALL_TOOL_PREFIX.length + 1}) AS tool, count(*) AS calls FROM tool_events e
           WHERE ${RECALL_TOOL_LIKE} AND e.session_id IN (${scope}) GROUP BY 1 ORDER BY 2 DESC, 1`,
        )
        .all(...params) as unknown as { tool: string; calls: number }[]
    ).map((r) => ({ ...r }));
    return { ...counts, recallCalls: byTool.reduce((n, t) => n + t.calls, 0), byTool };
  }

  /** Turns, active sessions and observations per local day (this process's time zone) since `since`, optionally one project. */
  activity(filter: { project?: string; since: string }): ActivityDay[] {
    const { where, params } = filterClause({ project: filter.project, localOnly: true, limit: 0, offset: 0 });
    const scope = where.length ? `AND ${where.join(' AND ')}` : '';
    const turns = this.db
      .prepare(
        `SELECT t.timestamp AS at, t.session_id AS session FROM turns t JOIN sessions s ON s.id = t.session_id
         WHERE t.timestamp >= ? AND s.id NOT LIKE 'manual:%' ${scope}`,
      )
      .all(filter.since, ...params) as { at: string; session: string }[];
    const observations = this.db
      .prepare(`SELECT o.occurred_at AS at FROM observations o LEFT JOIN sessions s ON s.id = o.session_id WHERE o.occurred_at >= ? ${scope}`)
      .all(filter.since, ...params) as { at: string }[];
    const days = new Map<string, { turns: number; sessions: Set<string>; observations: number }>();
    const bucket = (at: string) => {
      const d = new Date(at);
      if (Number.isNaN(d.getTime())) return undefined;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      let b = days.get(key);
      if (!b) days.set(key, (b = { turns: 0, sessions: new Set(), observations: 0 }));
      return b;
    };
    for (const t of turns) {
      const b = bucket(t.at);
      if (b) {
        b.turns++;
        b.sessions.add(t.session);
      }
    }
    for (const o of observations) {
      const b = bucket(o.at);
      if (b) b.observations++;
    }
    return [...days.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, b]) => ({ day, turns: b.turns, sessions: b.sessions.size, observations: b.observations }));
  }

  /** The working directory of the most recent session in `repository`. */
  cwdForRepository(repository: string): string | undefined {
    return (
      this.db
        .prepare('SELECT cwd FROM sessions WHERE repository = ? AND cwd IS NOT NULL ORDER BY coalesce(updated_at, created_at) DESC LIMIT 1')
        .get(repository) as { cwd: string } | undefined
    )?.cwd;
  }

  toolEventCount(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM tool_events').get() as { n: number }).n;
  }

  /**
   * Tool calls made during turns first..last of a session. A turn row is written when the next
   * prompt arrives, so turn k covers calls after turn k-1's timestamp up to turn k's.
   */
  toolEventsForTurns(sessionId: string, firstTurn: number, lastTurn: number): TurnToolEvent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM (
             SELECT (SELECT min(t.turn_index) FROM turns t
                     WHERE t.session_id = e.session_id AND t.timestamp >= e.started_at) AS turn_index,
                    e.tool_name, e.summary, e.success, e.exit_code, e.result
             FROM tool_events e WHERE e.session_id = ?
             ORDER BY e.started_at, e.call_id)
           WHERE turn_index BETWEEN ? AND ?`,
        )
        .all(sessionId, firstTurn, lastTurn) as unknown as TurnToolEvent[]
    ).map((row) => ({ ...row }));
  }

  failBatch(sessionId: string, turnIndexes: number[]): void {
    const bump = this.db.prepare(
      'UPDATE turns SET compress_attempts = compress_attempts + 1 WHERE session_id = ? AND turn_index = ?',
    );
    this.transaction(() => {
      for (const index of turnIndexes) bump.run(sessionId, index);
    });
  }

  counts(): { sessions: number; turns: number; pendingTurns: number; observations: number } {
    return this.db
      .prepare(
        `SELECT (SELECT count(*) FROM sessions WHERE id NOT LIKE 'manual:%') AS sessions,
                (SELECT count(*) FROM turns) AS turns,
                (SELECT count(*) FROM turns WHERE compressed_at IS NULL) AS pendingTurns,
                (SELECT count(*) FROM observations) AS observations`,
      )
      .get() as { sessions: number; turns: number; pendingTurns: number; observations: number };
  }

  /**
   * Observation index rows, best match first (or newest first without a query). With a query
   * vector, keyword (FTS) and semantic rankings are fused (reciprocal rank fusion); without one,
   * it is keyword-only.
   */
  searchObservations(filter: SearchFilter, vector?: { model: string; values: Float32Array; minScore?: number }): ObservationSummary[] {
    const { where, params } = filterClause(filter);
    const match = filter.query === undefined ? null : toFtsQuery(filter.query);
    if (filter.query === undefined || (match === null && !vector)) {
      if (filter.query !== undefined) return [];
      return this.db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS} FROM observations o LEFT JOIN sessions s ON s.id = o.session_id
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY o.occurred_at DESC, o.id DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, filter.limit, filter.offset) as unknown as ObservationSummary[];
    }
    const pool = filter.offset + filter.limit + HYBRID_POOL;
    const keywordRows = match === null ? [] : (
      this.db
        .prepare(
          `SELECT o.id, observations_fts.rank AS rank FROM observations o JOIN observations_fts ON observations_fts.rowid = o.id
           LEFT JOIN sessions s ON s.id = o.session_id
           WHERE ${['observations_fts MATCH ?', ...where].join(' AND ')}
           ORDER BY observations_fts.rank, o.occurred_at DESC, o.id DESC LIMIT ?`,
        )
        .all(match, ...params, pool) as { id: number; rank: number }[]
    );
    // bm25 ranks are negative, lower is better; their magnitude keeps real relevance gaps.
    if (!vector) {
      const ids = this.boostReinforced(new Map(keywordRows.map((r) => [r.id, -r.rank])));
      return this.summariesByIds(ids.slice(filter.offset, filter.offset + filter.limit));
    }
    const keyword = keywordRows.map((r) => r.id);

    const semantic = (
      this.db
        .prepare(
          `SELECT o.id, e.vector FROM observations o
           JOIN observation_embeddings e ON e.observation_id = o.id AND e.model = ?
           LEFT JOIN sessions s ON s.id = o.session_id
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
        )
        .all(vector.model, ...params) as { id: number; vector: Uint8Array }[]
    )
      .map((r) => ({ id: r.id, score: dot(vector.values, r.vector) }))
      .filter((r) => r.score >= (vector.minScore ?? MIN_SEMANTIC_SCORE))
      .sort((a, b) => b.score - a.score || b.id - a.id)
      .slice(0, pool)
      .map((r) => r.id);

    const fused = new Map<number, number>();
    for (const ranking of [keyword, semantic]) {
      ranking.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
    }
    return this.summariesByIds(this.boostReinforced(fused).slice(filter.offset, filter.offset + filter.limit));
  }

  /**
   * IDs by relevance score (higher is better, in insertion order on ties) after boosting
   * re-confirmed observations, so among comparably relevant results the ones that keep coming up rise.
   */
  private boostReinforced(scores: Map<number, number>): number[] {
    const today = new Date();
    const order = new Map([...scores.keys()].map((id, i) => [id, i]));
    for (const [id, item] of this.reinforcementInfo([...scores.keys()])) {
      scores.set(id, scores.get(id)! * (1 + REINFORCEMENT_BOOST * reinforcementStrength(item, today)));
    }
    return [...scores].sort((a, b) => b[1] - a[1] || order.get(a[0])! - order.get(b[0])!).map(([id]) => id);
  }

  /** When each observation occurred and the days it was re-confirmed. */
  reinforcementInfo(ids: number[]): Map<number, Rankable> {
    const out = new Map<number, Rankable>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.db
        .prepare(`SELECT id, occurred_at, reinforcement_dates FROM observations WHERE id IN (${chunk.map(() => '?').join(', ')})`)
        .all(...chunk) as { id: number; occurred_at: string; reinforcement_dates: string }[];
      for (const r of rows) out.set(r.id, { occurred_at: r.occurred_at, reinforcement_dates: parseReinforcementDates(r.reinforcement_dates) });
    }
    return out;
  }

  /** Index rows for `ids`, in that order. */
  private summariesByIds(ids: number[]): ObservationSummary[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM observations o LEFT JOIN sessions s ON s.id = o.session_id
         WHERE o.id IN (${ids.map(() => '?').join(', ')})`,
      )
      .all(...ids) as unknown as ObservationSummary[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  /** Observations without a vector from `model` (missing or from another model), newest first. */
  observationsToEmbed(
    model: string,
    limit: number,
  ): { id: number; title: string; subtitle: string; narrative: string; facts: string[]; editedAt: string | null }[] {
    return (
      this.db
        .prepare(
          `SELECT o.id, o.title, o.subtitle, o.narrative, o.facts, o.edited_at FROM observations o
           LEFT JOIN observation_embeddings e ON e.observation_id = o.id
           WHERE e.observation_id IS NULL OR e.model <> ?
           ORDER BY o.id DESC LIMIT ?`,
        )
        .all(model, limit) as { id: number; title: string; subtitle: string; narrative: string; facts: string; edited_at: string | null }[]
    ).map((r) => ({
      id: r.id, title: r.title, subtitle: r.subtitle, narrative: r.narrative, facts: JSON.parse(r.facts) as string[], editedAt: r.edited_at,
    }));
  }

  /**
   * Stores vectors. Rows read for embedding pass `editedAt`: a vector is dropped if its observation was
   * deleted or edited while the provider was working, so the new text gets embedded on the next round.
   */
  saveEmbeddings(model: string, rows: { id: number; vector: Float32Array; editedAt?: string | null }[]): number {
    const stmt = this.db.prepare(
      `INSERT INTO observation_embeddings (observation_id, model, vector)
       SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM observations WHERE id = ? AND (? OR edited_at IS ?))
       ON CONFLICT(observation_id) DO UPDATE SET model = excluded.model, vector = excluded.vector`,
    );
    let saved = 0;
    this.transaction(() => {
      for (const r of rows) {
        const vector = new Uint8Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength);
        saved += Number(stmt.run(r.id, model, vector, r.id, r.editedAt === undefined ? 1 : 0, r.editedAt ?? null).changes);
      }
    });
    return saved;
  }

  /**
   * Saves a user-authored note for `project` (a repository "owner/name" or an absolute directory).
   * It is searchable like any observation but never touched by compression.
   */
  remember(project: string, note: Omit<Observation, 'type'>, now: string): number {
    const sessionId = MANUAL_SESSION_PREFIX + project;
    const isDir = project.startsWith('/');
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sessions (id, cwd, repository, created_at, updated_at, synced_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .run(sessionId, isDir ? project : null, isDir ? null : project, now, now, now);
      const { id } = this.db
        .prepare(
          `INSERT INTO observations (session_id, first_turn, last_turn, type, title, narrative, facts, files, model, created_at, occurred_at, last_seen_at)
           VALUES (?, 0, 0, 'note', ?, ?, ?, ?, 'manual', ?, ?, ?) RETURNING id`,
        )
        .get(sessionId, note.title, note.narrative, JSON.stringify(note.facts), JSON.stringify(note.files), now, now, now) as { id: number };
      return id;
    });
  }

  /** Applies a hand edit; returns false for an unknown ID. The vector is dropped so the worker re-embeds it. */
  updateObservation(id: number, edit: ObservationEdit, now: string): boolean {
    return this.transaction(() => {
      const changed = this.db
        .prepare('UPDATE observations SET type = ?, title = ?, subtitle = ?, narrative = ?, facts = ?, edited_at = ? WHERE id = ?')
        .run(edit.type, edit.title, edit.subtitle, edit.narrative, JSON.stringify(edit.facts), now, id).changes;
      if (!changed) return false;
      this.db.prepare('DELETE FROM observation_embeddings WHERE observation_id = ?').run(id);
      return true;
    });
  }

  /** Deletes an observation (triggers drop its search entry, vector and duplicate links). The source turns stay. */
  deleteObservation(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM observations WHERE id = ?').run(id).changes) > 0;
  }

  /** Pins (always in session-start context) or unpins an observation; returns false for an unknown ID. */
  setPinned(id: number, pinned: boolean, now: string): boolean {
    return Number(this.db.prepare('UPDATE observations SET pinned_at = ? WHERE id = ?').run(pinned ? now : null, id).changes) > 0;
  }

  /**
   * Bookmarks one answer, word for word, under its own session (so it keeps the repository, path and
   * turn). `session` fills in a session sync has not seen yet. Bookmarking the same turn or answer
   * again returns the same ID, renaming it only when `rename` is set.
   */
  bookmark(
    input: { sessionId: string; turnIndex: number; question: string; answer: string; title: string; rename?: boolean; occurredAt?: string | null },
    now: string,
    session?: { cwd: string | null; repository: string | null; branch: string | null },
  ): { id: number; created: boolean; title: string } {
    return this.transaction(() => {
      if (session) {
        this.db
          .prepare(
            `INSERT INTO sessions (id, cwd, repository, branch, created_at, updated_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING`,
          )
          .run(input.sessionId, session.cwd, session.repository, session.branch, now, now, now);
      }
      const existing = this.db
        .prepare(
          `SELECT b.observation_id AS id, o.title FROM bookmarks b JOIN observations o ON o.id = b.observation_id
           WHERE b.session_id = ? AND (b.turn_index = ? OR b.answer = ?) LIMIT 1`,
        )
        .get(input.sessionId, input.turnIndex, input.answer) as { id: number; title: string } | undefined;
      if (existing) {
        if (!input.rename) return { id: existing.id, created: false, title: existing.title };
        this.db.prepare('UPDATE observations SET title = ? WHERE id = ?').run(input.title, existing.id);
        return { id: existing.id, created: false, title: input.title };
      }
      const subtitle = input.question.replace(/\s+/g, ' ').trim().slice(0, 240);
      const { id } = this.db
        .prepare(
          `INSERT INTO observations (session_id, first_turn, last_turn, type, title, subtitle, narrative, model, created_at, occurred_at, last_seen_at)
           VALUES (?, ?, ?, 'bookmark', ?, ?, ?, 'manual', ?, ?, ?) RETURNING id`,
        )
        .get(input.sessionId, input.turnIndex, input.turnIndex, input.title, subtitle, input.answer, now, input.occurredAt ?? now, now) as { id: number };
      this.db
        .prepare('INSERT INTO bookmarks (observation_id, session_id, turn_index, question, answer, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, input.sessionId, input.turnIndex, input.question, input.answer, now);
      return { id, created: true, title: input.title };
    });
  }

  /** Turn indexes of `sessionId` that are bookmarked, with their observation IDs. */
  bookmarkedTurns(sessionId: string): { turn_index: number; observation_id: number }[] {
    return (this.db.prepare('SELECT turn_index, observation_id FROM bookmarks WHERE session_id = ? ORDER BY turn_index').all(sessionId) as unknown as {
      turn_index: number;
      observation_id: number;
    }[]).map((r) => ({ ...r }));
  }

  /** The synced turn holding this answer (or else this question, newest first), if sync has seen it. */
  matchTurn(sessionId: string, question: string, answer: string): number | null {
    const row = (this.db.prepare('SELECT turn_index FROM turns WHERE session_id = ? AND assistant_response = ? ORDER BY turn_index DESC LIMIT 1').get(sessionId, answer) ??
      this.db.prepare('SELECT turn_index FROM turns WHERE session_id = ? AND user_message = ? ORDER BY turn_index DESC LIMIT 1').get(sessionId, question)) as
      | { turn_index: number }
      | undefined;
    return row ? row.turn_index : null;
  }

  /** The repository (else cwd) a session ran in. */
  sessionProject(sessionId: string): string | undefined {
    const row = this.db.prepare('SELECT coalesce(repository, cwd) AS p FROM sessions WHERE id = ?').get(sessionId) as { p: string | null } | undefined;
    return row?.p ?? undefined;
  }

  /** One synced turn (question and answer) of a session; the newest one with an answer when `turnIndex` is omitted. */
  turn(sessionId: string, turnIndex?: number): { turn_index: number; user_message: string | null; assistant_response: string | null; timestamp: string | null } | undefined {
    const row = turnIndex === undefined
      ? this.db
          .prepare(
            `SELECT turn_index, user_message, assistant_response, timestamp FROM turns
             WHERE session_id = ? AND coalesce(assistant_response, '') <> '' ORDER BY turn_index DESC LIMIT 1`,
          )
          .get(sessionId)
      : this.db
          .prepare('SELECT turn_index, user_message, assistant_response, timestamp FROM turns WHERE session_id = ? AND turn_index = ?')
          .get(sessionId, turnIndex);
    return row ? ({ ...row } as { turn_index: number; user_message: string | null; assistant_response: string | null; timestamp: string | null }) : undefined;
  }

  /** How many observations have a vector from `model`. */
  embeddingCount(model: string): number {
    return (this.db.prepare('SELECT count(*) AS n FROM observation_embeddings WHERE model = ?').get(model) as { n: number }).n;
  }

  /**
   * Observations around `anchorId` in time. Scoped to `project` when given, otherwise to the
   * anchor's own repository (or cwd when the session has no repository).
   */
  observationTimeline(anchorId: number, before: number, after: number, project?: string): ObservationSummary[] | undefined {
    const anchor = this.db
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM observations o LEFT JOIN sessions s ON s.id = o.session_id WHERE o.id = ?`)
      .get(anchorId) as ObservationSummary | undefined;
    if (!anchor) return undefined;
    let scope = '';
    let scopeParams: SQLInputValue[] = [];
    if (project) {
      scope = `AND ${PROJECT_CLAUSE}`;
      scopeParams = projectParams(project);
    } else if (anchor.repository) {
      scope = 'AND s.repository = ?';
      scopeParams = [anchor.repository];
    } else if (anchor.cwd) {
      scope = 'AND s.cwd = ?';
      scopeParams = [anchor.cwd];
    }
    const around = (cmp: '<' | '>', order: 'ASC' | 'DESC', limit: number) =>
      this.db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS} FROM observations o LEFT JOIN sessions s ON s.id = o.session_id
           WHERE (o.occurred_at, o.id) ${cmp} (?, ?) ${scope}
           ORDER BY o.occurred_at ${order}, o.id ${order} LIMIT ?`,
        )
        .all(anchor.occurred_at, anchor.id, ...scopeParams, limit) as unknown as ObservationSummary[];
    return [...around('<', 'DESC', before).reverse(), anchor, ...around('>', 'ASC', after)];
  }

  /** Highest observation id: changes whenever any observation is added, even for old turns. */
  recordCall(call: CompressCall): void {
    const u = call.usage;
    this.db
      .prepare(
        `INSERT INTO compress_calls (started_at, duration_ms, session_id, model, status, turns, observations, prompt_chars,
           api_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, nano_aiu, premium_requests, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        call.startedAt, Math.round(call.durationMs), call.sessionId, call.model, call.status, call.turns, call.observations,
        call.promptChars, u?.apiMs ?? null, u?.inputTokens ?? null, u?.outputTokens ?? null, u?.cacheReadTokens ?? null,
        u?.cacheWriteTokens ?? null, u?.reasoningTokens ?? null, u?.nanoAiu ?? null, u?.premiumRequests ?? null,
        call.kind ?? 'compress',
      );
  }

  /**
   * Sessions ready for a summary, most recently active first: idle since `idleBefore`, no turns
   * left to compress, at least one observation, and no summary covering their newest observation.
   */
  sessionsToSummarize(options: { idleBefore: string; activeSince?: string; maxAttempts: number; limit: number; sessionId?: string }): string[] {
    const where = ['last_turn < ?', '(ss.session_id IS NULL OR ss.last_observation_id < x.last_obs)'];
    const params: SQLInputValue[] = [options.maxAttempts, options.idleBefore];
    if (options.activeSince !== undefined) {
      where.push('last_turn >= ?');
      params.push(options.activeSince);
    }
    if (options.sessionId !== undefined) {
      where.push('x.session_id = ?');
      params.push(options.sessionId);
    }
    return (
      this.db
        .prepare(
          `SELECT x.session_id FROM (
             SELECT o.session_id, max(o.id) AS last_obs,
                    (SELECT max(t.timestamp) FROM turns t WHERE t.session_id = o.session_id) AS last_turn
             FROM observations o
             WHERE o.session_id NOT LIKE '${MANUAL_SESSION_PREFIX}%' AND o.type <> 'bookmark'
               AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.session_id = o.session_id
                               AND t.compressed_at IS NULL AND t.compress_attempts < ?)
             GROUP BY o.session_id
           ) x LEFT JOIN session_summaries ss ON ss.session_id = x.session_id
           WHERE ${where.join(' AND ')}
           ORDER BY x.last_turn DESC LIMIT ?`,
        )
        .all(...params, options.limit) as { session_id: string }[]
    ).map((r) => r.session_id);
  }

  /** What a summary is written from: the session's opening request and its observations, oldest first. */
  summaryInput(sessionId: string): SummaryInput {
    const session = this.db
      .prepare(
        `SELECT s.repository, s.cwd, s.branch,
                (SELECT t.user_message FROM turns t WHERE t.session_id = ?1 ORDER BY t.turn_index LIMIT 1) AS first_request
         FROM (SELECT ?1 AS id) q LEFT JOIN sessions s ON s.id = q.id`,
      )
      .get(sessionId) as { repository: string | null; cwd: string | null; branch: string | null; first_request: string | null };
    const observations = (
      this.db
        .prepare("SELECT id, type, title, subtitle, narrative FROM observations WHERE session_id = ? AND type <> 'bookmark' ORDER BY first_turn, id")
        .all(sessionId) as unknown as SummaryInput['observations']
    ).map((o) => ({ ...o }));
    return { session_id: sessionId, ...session, observations };
  }

  /** Stores (or replaces) a session's summary; `summary` null records a skip. */
  saveSummary(sessionId: string, summary: SummaryFields | null, observationIds: number[], model: string, now: string): void {
    const s = summary ?? { request: '', investigated: '', learned: '', completed: '', next_steps: '', notes: '' };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_summaries
           (session_id, request, investigated, learned, completed, next_steps, notes, observation_count, last_observation_id,
            model, created_at, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                 coalesce((SELECT max(timestamp) FROM turns WHERE session_id = ?1), ?11))`,
      )
      .run(sessionId, s.request, s.investigated, s.learned, s.completed, s.next_steps, s.notes,
        observationIds.length, Math.max(0, ...observationIds), model, now);
  }

  /** Recorded near-duplicate pairs among `ids`, as [observation, duplicate_of]. */
  duplicateLinks(ids: number[]): [number, number][] {
    if (ids.length === 0) return [];
    const list = ids.map(() => '?').join(', ');
    return (
      this.db
        .prepare(`SELECT observation_id AS a, duplicate_of AS b FROM observation_duplicates WHERE observation_id IN (${list}) AND duplicate_of IN (${list})`)
        .all(...ids, ...ids) as { a: number; b: number }[]
    ).map((r) => [r.a, r.b]);
  }

  /** Links every pair of `projects` both ways; returns how many new pairs were added. */
  linkProjects(projects: string[], now: string): number {
    const insert = this.db.prepare('INSERT OR IGNORE INTO project_links (project, linked, created_at) VALUES (?, ?, ?)');
    let added = 0;
    this.transaction(() => {
      for (const a of projects) {
        for (const b of projects) if (a !== b) added += Number(insert.run(a, b, now).changes);
      }
    });
    return added / 2;
  }

  /** Removes the links between every pair of `projects`; returns how many pairs were removed. */
  unlinkProjects(projects: string[]): number {
    const remove = this.db.prepare('DELETE FROM project_links WHERE project = ? AND linked = ?');
    let removed = 0;
    this.transaction(() => {
      for (const a of projects) {
        for (const b of projects) if (a !== b) removed += Number(remove.run(a, b).changes);
      }
    });
    return removed / 2;
  }

  /** Projects linked to any of `projects` (not transitive), excluding `projects` themselves. */
  linkedProjects(projects: string[]): string[] {
    if (projects.length === 0) return [];
    const marks = projects.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT DISTINCT linked FROM project_links WHERE project IN (${marks}) AND linked NOT IN (${marks}) ORDER BY linked`)
      .all(...projects, ...projects) as { linked: string }[];
    return rows.map((r) => r.linked);
  }

  /** Every link as [project, linked] with project < linked. */
  projectLinks(): [string, string][] {
    const rows = this.db
      .prepare('SELECT project, linked FROM project_links WHERE project < linked ORDER BY project, linked')
      .all() as { project: string; linked: string }[];
    return rows.map((r) => [r.project, r.linked]);
  }

  summaryCount(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM session_summaries WHERE request <> ''").get() as { n: number }).n;
  }

  /** Stored (non-skipped) summaries, newest first. `project` matches like search filters. */
  summaries(filter: { project?: string | string[]; sessionId?: string; dateStart?: string; dateEnd?: string; limit: number }): SessionSummary[] {
    const { where, params } = filterClause({ project: filter.project, localOnly: true, limit: 0, offset: 0 });
    where.push("ss.request <> ''");
    if (filter.dateStart) {
      where.push('ss.occurred_at >= ?');
      params.push(filter.dateStart);
    }
    if (filter.dateEnd) {
      where.push('ss.occurred_at <= ?');
      params.push(endBound(filter.dateEnd));
    }
    if (filter.sessionId !== undefined) {
      where.push('ss.session_id = ?');
      params.push(filter.sessionId);
    }
    return (
      this.db
        .prepare(
          `SELECT ss.session_id, s.repository, s.cwd, s.branch, ss.request, ss.investigated, ss.learned, ss.completed,
                  ss.next_steps, ss.notes, ss.observation_count, ss.occurred_at
           FROM session_summaries ss LEFT JOIN sessions s ON s.id = ss.session_id
           WHERE ${where.join(' AND ')} ORDER BY ss.occurred_at DESC LIMIT ?`,
        )
        .all(...params, filter.limit) as unknown as SessionSummary[]
    ).map((r) => ({ ...r }));
  }

  /** Upserts mirrored session_files rows; returns how many were new. */
  upsertFiles(files: SourceFile[]): number {
    const stmt = this.db.prepare(
      `INSERT INTO session_files (session_id, file_path, tool_name, turn_index, first_seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (session_id, file_path) DO UPDATE SET
         tool_name = excluded.tool_name, turn_index = excluded.turn_index, first_seen_at = excluded.first_seen_at`,
    );
    const before = this.count('session_files');
    for (const f of files) stmt.run(f.session_id, f.file_path, f.tool_name, f.turn_index, f.first_seen_at);
    return this.count('session_files') - before;
  }

  /** Upserts mirrored session_refs rows; returns how many were new. */
  upsertRefs(refs: SourceRef[]): number {
    const stmt = this.db.prepare(
      `INSERT INTO session_refs (session_id, ref_type, ref_value, turn_index, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (session_id, ref_type, ref_value) DO UPDATE SET turn_index = excluded.turn_index, created_at = excluded.created_at`,
    );
    const before = this.count('session_refs');
    for (const r of refs) stmt.run(r.session_id, r.ref_type, r.ref_value, r.turn_index, r.created_at);
    return this.count('session_refs') - before;
  }

  private count(table: 'session_files' | 'session_refs'): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  latestCallId(): number | null {
    return (this.db.prepare('SELECT max(id) AS id FROM compress_calls').get() as { id: number | null }).id;
  }

  /** Time, token usage and AI credits spent by the compressor. Days are local (the process time zone). */
  compressStats(now = new Date(), recentLimit = 20): CompressStats {
    const totals = (where = '', ...params: SQLInputValue[]) =>
      ({ ...(this.db.prepare(`SELECT ${USAGE_TOTALS} FROM compress_calls ${where}`).get(...params) as object) }) as UsageTotals;
    const total = totals();
    const last24h = totals('WHERE started_at >= ?', new Date(now.getTime() - 86_400_000).toISOString());
    const days = (
      this.db
        .prepare(
          `SELECT date(started_at, 'localtime') AS day, ${USAGE_TOTALS} FROM compress_calls
           GROUP BY day ORDER BY day DESC LIMIT 14`,
        )
        .all() as unknown as (UsageTotals & { day: string })[]
    ).map((row) => ({ ...row }));
    const recent = (
      this.db
        .prepare(
          `SELECT c.id, c.kind, c.started_at AS startedAt, c.duration_ms AS durationMs, ${PROJECT_KEY} AS project, c.model, c.status,
                  c.turns, c.observations, c.input_tokens AS inputTokens, c.output_tokens AS outputTokens,
                  c.nano_aiu / 1e9 AS credits
           FROM compress_calls c LEFT JOIN sessions s ON s.id = c.session_id
           ORDER BY c.id DESC LIMIT ?`,
        )
        .all(recentLimit) as unknown as RecentCall[]
    ).map((row) => ({ ...row }));

    // Projection from successful, measured calls only.
    const ok = this.db
      .prepare(
        `SELECT count(*) AS calls, coalesce(sum(turns), 0) AS turns, coalesce(sum(duration_ms), 0) AS ms,
                coalesce(sum(nano_aiu), 0) / 1e9 AS credits
         FROM compress_calls WHERE status = 'ok' AND nano_aiu IS NOT NULL AND turns > 0`,
      )
      .get() as { calls: number; turns: number; ms: number; credits: number };
    const pendingTurns = this.counts().pendingTurns;
    const backlog = ok.calls === 0
      ? null
      : {
          pendingTurns,
          calls: Math.ceil((pendingTurns * ok.calls) / ok.turns),
          credits: (pendingTurns * ok.credits) / ok.turns,
          durationMs: Math.round((pendingTurns * ok.ms) / ok.turns),
          perTurn: { calls: ok.calls / ok.turns, credits: ok.credits / ok.turns, durationMs: ok.ms / ok.turns },
        };
    return { total, last24h, days, recent, backlog };
  }

  latestObservationId(): number | null {
    return (this.db.prepare('SELECT max(id) AS id FROM observations').get() as { id: number | null }).id;
  }

  /** Per project (repository, else cwd): turns, pending turns, observations, last activity. */
  projects(): ProjectSummary[] {
    const key = PROJECT_KEY;
    const turns = this.db
      .prepare(
        `SELECT ${key} AS project, count(*) AS turns, sum(t.compressed_at IS NULL) AS pendingTurns,
                max(t.timestamp) AS lastActivity
         FROM turns t LEFT JOIN sessions s ON s.id = t.session_id GROUP BY 1`,
      )
      .all() as unknown as Omit<ProjectSummary, 'observations'>[];
    const observations = new Map(
      (this.db
        .prepare(`SELECT ${key} AS project, count(*) AS n FROM observations o LEFT JOIN sessions s ON s.id = o.session_id GROUP BY 1`)
        .all() as { project: string; n: number }[]).map((r) => [r.project, r.n]),
    );
    return turns
      .map((r) => ({ ...r, observations: observations.get(r.project) ?? 0 }))
      .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  }

  /** Repositories worked on in `dir` or below it, most recently used first. */
  repositoriesForDir(dir: string): string[] {
    const [, exact, under] = projectParams(dir);
    const rows = this.db
      .prepare(
        `SELECT repository FROM sessions
         WHERE repository IS NOT NULL AND (cwd = ? OR cwd LIKE ? ESCAPE '\\')
         GROUP BY repository ORDER BY max(coalesce(updated_at, created_at, synced_at)) DESC`,
      )
      .all(exact, under) as { repository: string }[];
    return rows.map((r) => r.repository);
  }

  getObservations(ids: number[]): ObservationDetail[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS}, o.subtitle, o.narrative, o.facts, o.concepts, o.files, o.files_read,
                o.first_turn, o.last_turn, s.branch, o.occurrences, o.last_seen_at, o.edited_at, b.question
         FROM observations o LEFT JOIN sessions s ON s.id = o.session_id LEFT JOIN bookmarks b ON b.observation_id = o.id
         WHERE o.id IN (${ids.map(() => '?').join(', ')})
         ORDER BY o.occurred_at, o.id`,
      )
      .all(...ids) as unknown as (Omit<ObservationDetail, JsonColumn> & Record<JsonColumn, string>)[];
    const files = this.db.prepare(
      `SELECT file_path AS path, tool_name AS tool, turn_index AS turn FROM session_files
       WHERE session_id = ? AND turn_index BETWEEN ? AND ? ORDER BY turn_index, file_path`,
    );
    const refs = this.db.prepare(
      'SELECT ref_type AS type, ref_value AS value, turn_index AS turn FROM session_refs WHERE session_id = ? ORDER BY turn_index, ref_type, ref_value',
    );
    const similar = this.db.prepare(
      `SELECT o.id, o.title, d.score FROM observation_duplicates d
       JOIN observations o ON o.id = CASE WHEN d.observation_id = ?1 THEN d.duplicate_of ELSE d.observation_id END
       WHERE d.observation_id = ?1 OR d.duplicate_of = ?1
       ORDER BY d.score DESC, o.id LIMIT 10`,
    );
    return rows.map(({ question, ...row }) => ({
      ...row,
      ...(question == null ? {} : { question }),
      facts: JSON.parse(row.facts),
      concepts: JSON.parse(row.concepts),
      files: JSON.parse(row.files),
      files_read: JSON.parse(row.files_read),
      similar: similar.all(row.id).map((s) => ({ ...s })) as unknown as SimilarObservation[],
      touched_files: files.all(row.session_id, row.first_turn, row.last_turn).map((f) => ({ ...f })) as unknown as TouchedFile[],
      refs: refs.all(row.session_id).map((r) => ({ ...r })) as unknown as SessionRef[],
    }));
  }

  close(): void {
    this.db.close();
  }
}
