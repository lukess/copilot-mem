import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { callRecallTool, createRecallServer } from '../src/mcp/recall-server.ts';
import { MemoryStore, MIGRATIONS, toFtsQuery, type Observation } from '../src/storage/memory-store.ts';

let dir: string;
let store: MemoryStore;

const obs = (type: Observation['type'], title: string, narrative: string, files: string[] = []): Observation => ({
  type, title, narrative, facts: [], files,
});

/** Adds a one-turn session whose turn happened at `timestamp`, compressed into `observations`. */
function addSession(id: string, repository: string | null, cwd: string, timestamp: string, observations: Observation[]): void {
  store.upsertSession(
    { id, cwd, repository, branch: 'main', host_type: null, summary: null, created_at: null, updated_at: null },
    timestamp,
  );
  store.upsertTurn({ session_id: id, turn_index: 0, user_message: 'u', assistant_response: 'a', timestamp }, timestamp);
  store.completeBatch(id, [0], observations, 'test-model', '2026-12-31T00:00:00.000Z');
}

const text = (result: object) => ((result as { content: { text: string }[] }).content)[0].text;
const ids = (body: string) => [...body.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-mem-recall-'));
  store = new MemoryStore(join(dir, 'memory.db'));
  addSession('s1', 'acme/api', '/work/api', '2026-09-01T10:00:00.000Z', [
    obs('bugfix', 'Redis pipeline hangs without socket timeout', 'get_redis() lacked socket_timeout so pipe.execute blocked.', ['cache.py']),
    obs('decision', 'Keep code reviews read-only', 'Reviews never edit the reviewed repo.'),
  ]);
  addSession('s2', 'acme/api', '/work/api', '2026-09-05T10:00:00.000Z', [
    obs('feature', 'Added example_diff.py topology diff', 'Compares topology versions between releases.', ['scripts/example_diff.py']),
  ]);
  addSession('s3', null, '/work/my_tool/sub', '2026-09-03T10:00:00.000Z', [
    obs('discovery', 'Redis cluster uses three shards', 'Seen while debugging timeouts.'),
  ]);
  addSession('s4', 'acme/web', '/work/web', '2026-09-10T10:00:00.000Z', [
    obs('change', 'Bumped Redis client', 'Upgraded redis-py to fix a timeout bug.'),
  ]);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('richer observation fields', () => {
  test('round-trip through storage, FTS and get_observations', () => {
    addSession('s5', 'acme/api', '/work/api', '2026-09-11T10:00:00.000Z', [{
      type: 'bugfix', title: 'Lock ordering fix', subtitle: 'Deadlock between flusher and writer', narrative: 'n',
      facts: [], concepts: ['gotcha'], files: ['w.go'], files_read: ['r.go'],
    }]);
    const [o] = store.searchObservations({ query: 'deadlock', limit: 5, offset: 0 });
    assert.equal(o?.title, 'Lock ordering fix');
    assert.deepEqual(store.searchObservations({ query: 'gotcha', limit: 5, offset: 0 }).map((x) => x.id), [o!.id]);
    const body = text(callRecallTool(store, 'get_observations', { ids: [o!.id] }));
    assert.match(body, /Lock ordering fix \| Deadlock between flusher and writer/);
    assert.match(body, /Concepts: gotcha/);
    assert.match(body, /Files modified: w\.go/);
    assert.match(body, /Files read: r\.go/);
    // Older rows default to empty fields.
    const [old] = store.getObservations([1]);
    assert.deepEqual([old!.subtitle, old!.concepts, old!.files_read], ['', [], []]);
  });

  test('migration keeps existing observations searchable', () => {
    const path = join(dir, 'v8.db');
    const db = new DatabaseSync(path);
    for (const [i, sql] of MIGRATIONS.slice(0, 8).entries()) db.exec(`${sql}; PRAGMA user_version = ${i + 1};`);
    db.exec(`INSERT INTO observations (session_id, first_turn, last_turn, type, title, narrative, model, created_at, occurred_at)
             VALUES ('s', 0, 0, 'bugfix', 'Legacy flake', 'n', 'm', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z');`);
    db.close();
    const upgraded = new MemoryStore(path);
    try {
      assert.deepEqual(upgraded.searchObservations({ query: 'flake', limit: 5, offset: 0 }).map((o) => o.title), ['Legacy flake']);
    } finally {
      upgraded.close();
    }
  });
});

describe('concurrent open', () => {
  test('processes opening an old database at once apply each migration exactly once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'copilot-mem-race-'));
    const path = join(dir, 'memory.db');
    try {
      const old = new DatabaseSync(path);
      old.exec('PRAGMA journal_mode = WAL; PRAGMA user_version = 0');
      old.close();
      const src = join(import.meta.dirname, '..', 'src', 'storage', 'memory-store.ts');
      // Every child loads first, then opens at the same instant, as hooks and the MCP server do at session start.
      const at = Date.now() + 1500;
      const code = `import { MemoryStore } from ${JSON.stringify(src)}; while (Date.now() < ${at}); new MemoryStore(${JSON.stringify(path)}).close(); console.log('ok');`;
      const runs = Array.from({ length: 8 }, () => new Promise<string>((resolve) => {
        const child = spawn(process.execPath, process.versions.bun ? ['-e', code] : ['--input-type=module', '-e', code]);
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('close', () => resolve(out.trim()));
      }));
      assert.deepEqual(await Promise.all(runs), Array(8).fill('ok'));
      const check = new DatabaseSync(path);
      assert.ok((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version >= 14);
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('migration 3', () => {
  test('backfills occurred_at and the FTS index for observations stored by v2', () => {
    const path = join(dir, 'v2.db');
    const db = new DatabaseSync(path);
    for (const [i, sql] of MIGRATIONS.slice(0, 2).entries()) db.exec(`${sql}; PRAGMA user_version = ${i + 1};`);
    db.exec(`INSERT INTO turns (session_id, turn_index, timestamp, content_hash, changed_at)
             VALUES ('s', 0, '2026-01-01T00:00:00.000Z', 'h', 'c'), ('s', 1, '2026-01-02T00:00:00.000Z', 'h', 'c');
             INSERT INTO observations (session_id, first_turn, last_turn, type, title, narrative, model, created_at)
             VALUES ('s', 0, 1, 'bugfix', 'Legacy flake', 'n', 'm', '2026-03-01T00:00:00.000Z'),
                    ('gone', 0, 0, 'bugfix', 'Orphan flake', 'n', 'm', '2026-03-01T00:00:00.000Z');`);
    db.close();

    const upgraded = new MemoryStore(path);
    try {
      const found = upgraded.searchObservations({ query: 'flake', limit: 10, offset: 0 });
      assert.deepEqual(
        found.map((o) => [o.title, o.occurred_at]).sort(),
        [['Legacy flake', '2026-01-02T00:00:00.000Z'], ['Orphan flake', '2026-03-01T00:00:00.000Z']],
      );
    } finally {
      upgraded.close();
    }
  });
});

describe('searchObservations', () => {
  const search = (filter: Partial<Parameters<MemoryStore['searchObservations']>[0]>) =>
    store.searchObservations({ limit: 20, offset: 0, ...filter }).map((o) => o.title);

  test('ranks documents that match more terms first and stems words', () => {
    assert.equal(search({ query: 'redis socket timeouts' })[0], 'Redis pipeline hangs without socket timeout');
    assert.equal(search({ query: 'redis' }).length, 3);
  });

  test('treats query text as words, never FTS syntax', () => {
    assert.equal(search({ query: 'example_diff.py' })[0], 'Added example_diff.py topology diff');
    for (const hostile of ['"', 'NEAR(', 'a* OR', 'title:x', '-redis', '(((']) {
      assert.doesNotThrow(() => search({ query: hostile }), hostile);
    }
    assert.deepEqual(search({ query: '!!!' }), []);
    assert.equal(toFtsQuery('Redis "redis" AND'), '"redis" OR "and"');
  });

  test('without a query lists newest first', () => {
    assert.deepEqual(search({ limit: 2 }), ['Bumped Redis client', 'Added example_diff.py topology diff']);
    assert.deepEqual(search({ limit: 2, offset: 1 }), ['Added example_diff.py topology diff', 'Redis cluster uses three shards']);
  });

  test('filters by project: repository, exact cwd, or a parent directory', () => {
    assert.equal(search({ project: 'acme/api' }).length, 3);
    assert.deepEqual(search({ project: '/work/web' }), ['Bumped Redis client']);
    assert.deepEqual(search({ project: '/work/my_tool/' }), ['Redis cluster uses three shards']);
    assert.deepEqual(search({ project: '/work/my%' }), [], 'LIKE wildcards in a path are literal');
    assert.deepEqual(search({ project: '/work/myXtool' }), [], '_ in a path is literal');
  });

  test('filters by type and date; a bare end date includes that day', () => {
    assert.deepEqual(search({ query: 'redis', type: 'change' }), ['Bumped Redis client']);
    assert.deepEqual(search({ dateStart: '2026-09-03', dateEnd: '2026-09-05' }), [
      'Added example_diff.py topology diff',
      'Redis cluster uses three shards',
    ]);
  });
});

describe('recall tools', () => {
  test('search returns a compact index and reports empty results', () => {
    const body = text(callRecallTool(store, 'search', { query: 'redis timeout', project: 'acme/api' }));
    assert.match(body, /^1 matches for "redis timeout"/);
    assert.match(body, /#1 {2}2026-09-01 {2}bugfix {5}Redis pipeline hangs without socket timeout {2}\[acme\/api\]/);
    assert.doesNotMatch(body, /get_redis\(\)/, 'index omits narratives');
    assert.equal(text(callRecallTool(store, 'search', { query: 'kafka' })), 'No matches for "kafka".');
  });

  test('search with a project also covers projects linked to it', () => {
    assert.deepEqual(ids(text(callRecallTool(store, 'search', { query: 'redis', project: 'acme/api' }))), [1]);
    store.linkProjects(['acme/api', '/work/my_tool'], 'now');
    assert.deepEqual(ids(text(callRecallTool(store, 'search', { query: 'redis', project: 'acme/api' }))).sort(), [1, 4]);
    assert.deepEqual(ids(text(callRecallTool(store, 'search', { query: 'redis', project: '/work/my_tool' }))).sort(), [1, 4]);
  });

  test('timeline stays within the anchor project unless told otherwise', () => {
    const body = text(callRecallTool(store, 'timeline', { anchor: 2 }));
    assert.deepEqual(ids(body).slice(1), [1, 2, 3], 'anchor #2 plus its acme/api neighbours, oldest first');
    assert.match(body, /> #2 /);
    assert.deepEqual(ids(text(callRecallTool(store, 'timeline', { anchor: 2, depth_before: 0, depth_after: 1 }))).slice(1), [2, 3]);
    assert.deepEqual(ids(text(callRecallTool(store, 'timeline', { anchor: 4, project: '/work' }))).slice(1), [1, 2, 4, 3, 5]);
  });

  test('timeline can find its anchor with a query', () => {
    const body = text(callRecallTool(store, 'timeline', { query: 'topology', depth_before: 1, depth_after: 1 }));
    assert.match(body, /^Timeline around #3/);
    assert.equal(text(callRecallTool(store, 'timeline', { query: 'kafka' })), 'No matches for "kafka".');
  });

  test('get_observations returns details and names missing IDs', () => {
    store.upsertFiles([{ session_id: 's1', file_path: '/w/api/cache.py', tool_name: 'edit', turn_index: 0, first_seen_at: null }]);
    store.upsertRefs([{ session_id: 's1', ref_type: 'pr', ref_value: '12', turn_index: 0, created_at: null }]);
    const result = callRecallTool(store, 'get_observations', { ids: [1, '3', 1, 99] });
    const body = text(result);
    assert.equal(result.isError, false);
    assert.match(body, /#1 \[bugfix\] Redis pipeline hangs/);
    assert.match(body, /project: acme\/api \(branch main\) \| session s1, turn 0/);
    assert.match(body, /get_redis\(\) lacked socket_timeout/);
    assert.match(body, /Files modified: cache\.py/);
    assert.match(body, /Files touched in these turns: \/w\/api\/cache\.py \(edit\)/);
    assert.match(body, /Session refs: pr 12/);
    assert.match(body, /#3 \[feature\]/);
    assert.match(body, /Not found: #99$/);
    assert.equal(callRecallTool(store, 'get_observations', { ids: [99] }).isError, true);
  });

  test('bad arguments become tool errors, not exceptions', () => {
    for (const [name, args] of [
      ['search', { limit: 'lots' }],
      ['search', { type: 'gossip' }],
      ['search', { dateStart: 'yesterday' }],
      ['timeline', {}],
      ['get_observations', { ids: [] }],
      ['get_observations', { ids: Array.from({ length: 51 }, (_, i) => i) }],
      ['nope', {}],
    ] as const) {
      const result = callRecallTool(store, name, args);
      assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    }
  });
});

describe('MCP server', () => {
  test('serves the recall tools, remember and instructions over the MCP protocol', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createRecallServer(store, '9.9.9');
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    try {
      assert.deepEqual(client.getServerVersion(), { name: 'copilot-mem', version: '9.9.9' });
      assert.match(client.getInstructions() ?? '', /search -> .*timeline -> .*get_observations/s);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name), ['search', 'timeline', 'get_observations', 'summaries', 'remember', 'bookmark']);
      const result = await client.callTool({ name: 'search', arguments: { query: 'shards' } });
      assert.match(text(result), /#4 .*Redis cluster uses three shards/);
    } finally {
      await client.close();
    }
  });

  test('the `mcp` command speaks MCP on stdout', async () => {
    store.close();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'mcp'],
      env: { ...process.env, COPILOT_MEM_DATA_DIR: dir } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'get_observations', arguments: { ids: [5] } });
      assert.match(text(result), /Bumped Redis client/);
    } finally {
      await client.close();
      store = new MemoryStore(join(dir, 'memory.db'));
    }
  });
});
