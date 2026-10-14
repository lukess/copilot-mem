import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export interface SourceSession {
  id: string;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  host_type: string | null;
  summary: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface SourceTurn {
  session_id: string;
  turn_index: number;
  user_message: string | null;
  assistant_response: string | null;
  timestamp: string | null;
}

export interface SourceFile {
  session_id: string;
  file_path: string;
  tool_name: string | null;
  turn_index: number | null;
  first_seen_at: string | null;
}

export interface SourceRef {
  session_id: string;
  ref_type: string;
  ref_value: string;
  turn_index: number | null;
  created_at: string | null;
}

const REQUIRED_COLUMNS: Record<string, string[]> = {
  sessions: ['id', 'cwd', 'repository', 'branch', 'host_type', 'summary', 'created_at', 'updated_at'],
  turns: ['session_id', 'turn_index', 'user_message', 'assistant_response', 'timestamp'],
};

/** Read-only view of Copilot CLI's ~/.copilot/session-store.db. */
export class SessionStoreReader {
  private readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    if (!existsSync(path)) throw new Error(`Copilot session store not found: ${path}`);
    this.path = path;
    this.db = new DatabaseSync(path, { readOnly: true });
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.assertSchema();
  }

  // Copilot owns this schema and may change it on upgrade; fail loudly instead of syncing garbage.
  private assertSchema(): void {
    const columnsOf = this.db.prepare('SELECT name FROM pragma_table_info(?)');
    for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
      const present = new Set(columnsOf.all(table).map((row) => row.name));
      const missing = required.filter((column) => !present.has(column));
      if (missing.length > 0) {
        throw new Error(`Unsupported Copilot session-store schema: ${table} is missing ${missing.join(', ')}`);
      }
    }
  }

  readSessions(): SourceSession[] {
    return this.db
      .prepare('SELECT id, cwd, repository, branch, host_type, summary, created_at, updated_at FROM sessions')
      .all() as unknown as SourceSession[];
  }

  /** Turns written at or after `since` (ISO timestamp), or all turns when omitted. */
  readTurns(since?: string): SourceTurn[] {
    const columns = 'session_id, turn_index, user_message, assistant_response, timestamp';
    const order = 'ORDER BY timestamp, session_id, turn_index';
    const rows = since === undefined
      ? this.db.prepare(`SELECT ${columns} FROM turns ${order}`).all()
      : this.db.prepare(`SELECT ${columns} FROM turns WHERE timestamp >= ? ${order}`).all(since);
    return rows as unknown as SourceTurn[];
  }

  /** Files Copilot's tools touched, per session (empty if this Copilot version has no such table). */
  readFiles(): SourceFile[] {
    if (!this.hasColumns('session_files', ['session_id', 'file_path', 'tool_name', 'turn_index', 'first_seen_at'])) return [];
    return this.db
      .prepare('SELECT session_id, file_path, tool_name, turn_index, first_seen_at FROM session_files')
      .all() as unknown as SourceFile[];
  }

  /** Commits, PRs and issues a session referenced (empty if this Copilot version has no such table). */
  readRefs(): SourceRef[] {
    if (!this.hasColumns('session_refs', ['session_id', 'ref_type', 'ref_value', 'turn_index', 'created_at'])) return [];
    return this.db
      .prepare('SELECT session_id, ref_type, ref_value, turn_index, created_at FROM session_refs')
      .all() as unknown as SourceRef[];
  }

  private hasColumns(table: string, columns: string[]): boolean {
    const present = new Set(this.db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((row) => row.name));
    return columns.every((column) => present.has(column));
  }

  close(): void {
    this.db.close();
  }
}
