import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SessionStoreReader } from '../src/capture/session-store-reader.ts';
import { OVERLAP_MS, syncOnce } from '../src/capture/sync.ts';
import { MemoryStore } from '../src/storage/memory-store.ts';

// Copied from Copilot CLI's session-store.db (schema_version 8).
const COPILOT_SCHEMA = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    turn_index INTEGER NOT NULL,
    user_message TEXT, assistant_response TEXT,
    timestamp TEXT DEFAULT (datetime('now')),
    UNIQUE(session_id, turn_index)
  );`;

let dir: string;
let source: DatabaseSync;
let sourcePath: string;
let memoryPath: string;

function addSession(id: string): void {
  source.prepare('INSERT INTO sessions (id, cwd, repository, branch) VALUES (?, ?, ?, ?)')
    .run(id, '/repo', 'owner/repo', 'main');
}

// Mirrors Copilot's write: a finalized turn is (re)written with the current time.
function writeTurn(sessionId: string, index: number, response: string | null, timestamp: string): void {
  source.prepare(
    `INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, turn_index) DO UPDATE SET assistant_response = excluded.assistant_response, timestamp = excluded.timestamp`,
  ).run(sessionId, index, `prompt ${index}`, response, timestamp);
}

function sync(options: { full?: boolean } = {}, path = sourcePath) {
  const reader = new SessionStoreReader(path);
  const store = new MemoryStore(memoryPath);
  try {
    return { result: syncOnce(reader, store, options), counts: store.counts() };
  } finally {
    reader.close();
    store.close();
  }
}

const T0 = '2026-01-01T12:00:00.000Z';
const at = (offsetMs: number) => new Date(Date.parse(T0) + offsetMs).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-mem-'));
  sourcePath = join(dir, 'session-store.db');
  memoryPath = join(dir, 'data', 'memory.db');
  source = new DatabaseSync(sourcePath);
  source.exec(COPILOT_SCHEMA);
  addSession('s1');
  addSession('s2');
  writeTurn('s1', 0, 'answer 0', T0);
  writeTurn('s1', 1, null, T0);
  writeTurn('s2', 0, 'answer', T0);
});

afterEach(() => {
  source.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('syncOnce', () => {
  test('initial sync mirrors all sessions and turns, including null responses', () => {
    const { result, counts } = sync();
    assert.deepEqual(
      { ...result },
      { sessions: 2, turnsRead: 3, inserted: 3, updated: 0, unchanged: 0, watermark: T0, newFiles: 0, newRefs: 0, newToolEvents: 0 },
    );
    assert.deepEqual({ ...counts }, { sessions: 2, turns: 3, pendingTurns: 3, observations: 0 });
  });

  test('mirrors session_files and session_refs, idempotently, and shows them on observations', () => {
    // DDL as in Copilot CLI 1.0.94's session-store.db.
    source.exec(`
      CREATE TABLE session_files (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
        file_path TEXT NOT NULL, tool_name TEXT, turn_index INTEGER, first_seen_at TEXT DEFAULT (datetime('now')),
        UNIQUE(session_id, file_path));
      CREATE TABLE session_refs (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
        ref_type TEXT NOT NULL, ref_value TEXT NOT NULL, turn_index INTEGER, created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(session_id, ref_type, ref_value));
      INSERT INTO session_files (session_id, file_path, tool_name, turn_index) VALUES
        ('s1', '/repo/a.ts', 'edit', 0), ('s1', '/repo/b.ts', 'create', 1), ('s2', '/repo/c.ts', 'edit', 0);
      INSERT INTO session_refs (session_id, ref_type, ref_value, turn_index) VALUES ('s1', 'pr', '42', 1), ('s1', 'commit', 'abc123', 0);`);
    assert.deepEqual([sync().result.newFiles, sync().result.newRefs], [3, 0], 'second sync adds nothing');
    source.exec(`UPDATE session_files SET tool_name = 'view' WHERE file_path = '/repo/a.ts';
      INSERT INTO session_refs (session_id, ref_type, ref_value, turn_index) VALUES ('s2', 'issue', '7', 0);`);
    assert.equal(sync().result.newRefs, 1);

    const store = new MemoryStore(memoryPath);
    try {
      store.completeBatch('s1', [0], [{ type: 'change', title: 'T', narrative: 'N', facts: [], files: [] }], 'm', T0);
      const [o] = store.getObservations([1]);
      assert.deepEqual(o.touched_files, [{ path: '/repo/a.ts', tool: 'view', turn: 0 }], 'only files from the observation turns');
      assert.deepEqual(o.refs, [{ type: 'commit', value: 'abc123', turn: 0 }, { type: 'pr', value: '42', turn: 1 }], 'all refs of the session');
    } finally {
      store.close();
    }
  });

  test('re-running is idempotent', () => {
    sync();
    const { result, counts } = sync();
    assert.equal(result.inserted + result.updated, 0);
    assert.equal(result.unchanged, 3);
    assert.equal(counts.turns, 3);
  });

  test('incremental sync picks up new and rewritten turns after the watermark', () => {
    sync();
    writeTurn('s1', 2, 'answer 2', at(60_000));
    writeTurn('s1', 1, 'now answered', at(60_000));
    const { result, counts } = sync();
    assert.equal(result.inserted, 1);
    assert.equal(result.updated, 1);
    assert.equal(result.watermark, at(60_000));
    assert.equal(counts.turns, 4);
  });

  test('a timestamp-only rewrite is not reported as a change', () => {
    sync();
    writeTurn('s2', 0, 'answer', at(1_000));
    const { result } = sync();
    assert.equal(result.updated, 0);
    assert.equal(result.watermark, at(1_000));
  });

  test('incremental sync skips turns written before the overlap window; --full catches them', () => {
    writeTurn('s2', 1, 'late', at(OVERLAP_MS * 2));
    sync();
    writeTurn('s1', 0, 'edited long ago', at(-1));

    assert.equal(sync().result.updated, 0);
    const full = sync({ full: true }).result;
    assert.equal(full.updated, 1);
    assert.equal(full.watermark, at(OVERLAP_MS * 2), 'full sync must not move the watermark backwards');
  });

  test('switching to a different source store rescans it instead of reusing the old watermark', () => {
    const otherPath = join(dir, 'other-store.db');
    copyFileSync(sourcePath, otherPath);
    const other = new DatabaseSync(otherPath);
    other.prepare("INSERT INTO sessions (id) VALUES ('old')").run();
    other.prepare("INSERT INTO turns (session_id, turn_index, user_message, timestamp) VALUES ('old', 0, 'u', ?)").run(at(-OVERLAP_MS * 10));
    other.close();
    writeTurn('s1', 2, 'recent', at(OVERLAP_MS * 20));
    sync();

    const { result } = sync({}, otherPath);
    assert.equal(result.inserted, 1, 'turns older than the first store\'s watermark must still be imported');
    assert.equal(result.watermark, T0);
  });

  test('a failed sync rolls back and leaves the watermark untouched', () => {
    sync();
    writeTurn('s1', 2, 'answer 2', at(60_000));
    const reader = new SessionStoreReader(sourcePath);
    const store = new MemoryStore(memoryPath);
    try {
      const original = store.upsertTurn.bind(store);
      store.upsertTurn = (turn, now) => {
        if (turn.turn_index === 2) throw new Error('boom');
        return original(turn, now);
      };
      assert.throws(() => syncOnce(reader, store), /boom/);
      assert.equal(store.getState('turns_watermark'), T0);
      assert.equal(store.counts().turns, 3);
    } finally {
      reader.close();
      store.close();
    }
  });
});

describe('SessionStoreReader', () => {
  test('rejects a missing session store', () => {
    assert.throws(() => new SessionStoreReader(join(dir, 'nope.db')), /session store not found/);
  });

  test('rejects an incompatible Copilot schema', () => {
    source.exec('ALTER TABLE turns DROP COLUMN assistant_response');
    assert.throws(() => new SessionStoreReader(sourcePath), /turns is missing assistant_response/);
  });

  test('opens the Copilot database read-only', () => {
    const reader = new SessionStoreReader(sourcePath);
    try {
      const db = (reader as unknown as { db: DatabaseSync }).db;
      assert.throws(() => db.exec('DELETE FROM turns'), /readonly/);
    } finally {
      reader.close();
    }
  });
});
