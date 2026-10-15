import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { bookmarkAnswer, latestSession, readExchanges } from '../src/bookmark.ts';
import { buildSessionContext } from '../src/hooks/context.ts';
import { callRecallTool } from '../src/mcp/recall-server.ts';
import { MemoryStore, type Observation } from '../src/storage/memory-store.ts';
import { exportMarkdown } from '../src/viewer/export.ts';

let dir: string;
let stateDir: string;
let store: MemoryStore;

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const NOW = '2026-10-01T00:00:00.000Z';
const text = (result: object) => ((result as { content: { text: string }[] }).content)[0].text;

const event = (type: string, data: object, extra: object = {}) => JSON.stringify({ type, data, timestamp: '2026-09-20T10:00:00.000Z', ...extra });

/** A live session: two answered exchanges, then the in-progress request that asks for the bookmark. */
function writeEvents(sessionId: string, tail = ''): string {
  mkdirSync(join(stateDir, sessionId), { recursive: true });
  const lines = [
    event('session.start', { context: { cwd: '/work/web', repository: 'acme/web', branch: 'dev' } }),
    event('user.message', { content: 'How do we rotate the API keys?' }),
    event('assistant.message', { content: '', toolRequests: [{ name: 'grep' }] }),
    event('user.message', { content: 'subagent prompt', source: 'agent-x' }),
    event('assistant.message', { content: 'subagent answer', parentToolCallId: 'c1' }),
    event('assistant.message', { content: 'Run `rotate --all`.\n\nThen restart.' }),
    event('user.message', { content: 'and for staging?' }),
    event('assistant.message', { content: 'Same, with --env staging.' }),
    event('user.message', { content: 'bookmark that' }),
  ];
  const path = join(stateDir, sessionId, 'events.jsonl');
  writeFileSync(path, `${lines.join('\n')}\n${tail}`);
  return path;
}

function addSession(id: string, repository: string, cwd: string, observations: Observation[]): void {
  const at = '2026-09-01T00:00:00.000Z';
  store.upsertSession({ id, cwd, repository, branch: 'main', host_type: null, summary: null, created_at: at, updated_at: at }, at);
  store.upsertTurn({ session_id: id, turn_index: 0, user_message: 'u', assistant_response: 'a', timestamp: at }, at);
  store.completeBatch(id, [0], observations, 'm', at);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-mem-bookmark-'));
  stateDir = join(dir, 'session-state');
  store = new MemoryStore(join(dir, 'memory.db'));
  addSession('api-session', 'acme/api', '/work/api', [{ type: 'decision', title: 'API decision', narrative: 'n', facts: [], files: [] }]);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('readExchanges', () => {
  test('keeps top-level exchanges with their last answer text, and the session context', () => {
    const { exchanges, session } = readExchanges(writeEvents('live', '{"type":"assistant.mes'));
    assert.deepEqual(session, { cwd: '/work/web', repository: 'acme/web', branch: 'dev' });
    assert.deepEqual(
      exchanges.map((x) => [x.question, x.answer]),
      [
        ['How do we rotate the API keys?', 'Run `rotate --all`.\n\nThen restart.'],
        ['and for staging?', 'Same, with --env staging.'],
        ['bookmark that', ''],
      ],
    );
  });

  test('latestSession picks the most recently written events file', () => {
    utimesSync(writeEvents('older'), new Date('2026-09-01'), new Date('2026-09-01'));
    writeEvents('newer');
    assert.equal(latestSession(stateDir), 'newer');
    assert.equal(latestSession(join(dir, 'missing')), undefined);
  });
});

describe('bookmarkAnswer', () => {
  test('in session, saves the previous answer word for word under the unsynced session', () => {
    writeEvents('live');
    const saved = bookmarkAnswer(store, { sessionId: 'live', skipCurrent: true, sessionStateDir: stateDir }, NOW);
    assert.equal(saved.created, true);
    assert.equal(saved.title, 'and for staging?');
    assert.equal(saved.project, 'acme/web');
    assert.equal(saved.turnIndex, 1);
    const [o] = store.getObservations([saved.id]);
    assert.equal(o.type, 'bookmark');
    assert.equal(o.narrative, 'Same, with --env staging.');
    assert.equal(o.question, 'and for staging?');
    assert.equal(o.cwd, '/work/web');
    assert.equal(o.branch, 'dev');

    const older = bookmarkAnswer(store, { sessionId: 'live', skipCurrent: true, back: 2, title: 'Key rotation', sessionStateDir: stateDir }, NOW);
    assert.equal(store.getObservations([older.id])[0].narrative, 'Run `rotate --all`.\n\nThen restart.');
    assert.equal(older.title, 'Key rotation');
  });

  test('bookmarking the same answer again keeps one bookmark; only an explicit title renames it', () => {
    writeEvents('live');
    const first = bookmarkAnswer(store, { sessionId: 'live', skipCurrent: true, sessionStateDir: stateDir }, NOW);
    const renamed = bookmarkAnswer(store, { sessionId: 'live', skipCurrent: true, title: 'Custom', sessionStateDir: stateDir }, NOW);
    assert.equal(renamed.title, 'Custom');
    // Regression: re-bookmarking without a title used to reset a custom title to the question.
    assert.equal(bookmarkAnswer(store, { sessionId: 'live', skipCurrent: true, sessionStateDir: stateDir }, NOW).title, 'Custom');
    const again = bookmarkAnswer(store, { sessionId: 'live', skipCurrent: true, title: 'Staging keys', sessionStateDir: stateDir }, NOW);
    assert.deepEqual([again.id, again.created], [first.id, false]);
    assert.equal(store.getObservations([first.id])[0].title, 'Staging keys');
    assert.equal(store.searchObservations({ type: 'bookmark', limit: 10, offset: 0 }).length, 1);
  });

  test('uses the synced turn index once sync has the turn', () => {
    writeEvents('live');
    store.upsertSession({ id: 'live', cwd: '/work/web', repository: 'acme/web', branch: 'dev', host_type: null, summary: null, created_at: null, updated_at: null }, NOW);
    store.upsertTurn({ session_id: 'live', turn_index: 7, user_message: 'and for staging?', assistant_response: 'Same, with --env staging.', timestamp: NOW }, NOW);
    assert.equal(bookmarkAnswer(store, { sessionId: 'live', skipCurrent: true, sessionStateDir: stateDir }, NOW).turnIndex, 7);
    assert.deepEqual(store.bookmarkedTurns('live').map((b) => b.turn_index), [7]);
  });

  test('a turn index reads the synced turn; errors name what is missing', () => {
    const saved = bookmarkAnswer(store, { sessionId: 'api-session', turnIndex: 0, sessionStateDir: stateDir }, NOW);
    assert.equal(store.getObservations([saved.id])[0].narrative, 'a');
    assert.throws(() => bookmarkAnswer(store, { sessionId: 'api-session', turnIndex: 9, sessionStateDir: stateDir }), /no turn 9/);
    assert.throws(() => bookmarkAnswer(store, { sessionId: 'nope', sessionStateDir: stateDir }), /no answer to bookmark/);
  });
});

describe('bookmarks in memory', () => {
  let id: number;
  beforeEach(() => {
    writeEvents('live');
    id = bookmarkAnswer(store, { sessionId: 'live', skipCurrent: true, title: 'Staging key rotation', sessionStateDir: stateDir }, NOW).id;
  });

  test('search finds them from any project; local-only filters and project views do not', () => {
    const found = store.searchObservations({ query: 'staging', project: 'acme/api', limit: 10, offset: 0 });
    assert.deepEqual(found.map((o) => [o.id, o.repository]), [[id, 'acme/web']]);
    assert.deepEqual(store.searchObservations({ query: 'staging', project: 'acme/api', localOnly: true, limit: 10, offset: 0 }), []);
    // Regression: these share the project filter but query sessions, not observations.
    assert.doesNotThrow(() => store.sessions({ project: 'acme/api', limit: 10, offset: 0 }));
    assert.doesNotThrow(() => store.recallOverview('acme/api'));
    assert.doesNotThrow(() => store.activity({ project: 'acme/api', since: '2026-01-01' }));
    assert.doesNotThrow(() => store.summaries({ project: 'acme/api', limit: 5 }));
  });

  test('stay out of session-start context, summaries and dedup merges', () => {
    assert.doesNotMatch(buildSessionContext(store, '/work/web'), /Staging key rotation/);
    assert.deepEqual(store.summaryInput('live').observations, []);
    store.upsertTurn({ session_id: 'live', turn_index: 1, user_message: 'u', assistant_response: 'a', timestamp: NOW }, NOW);
    store.completeBatch('live', [1], [{ type: 'decision', title: 'Staging key rotation', narrative: 'n', facts: [], files: [] }], 'm', NOW);
    assert.equal(store.searchObservations({ query: 'staging key rotation', limit: 10, offset: 0 }).length, 2);
  });

  test('deleting the observation removes the bookmark', () => {
    assert.equal(store.bookmarkedTurns('live').length, 1);
    store.deleteObservation(id);
    assert.deepEqual(store.bookmarkedTurns('live'), []);
  });

  test('export carries the full question and answer', () => {
    const md = exportMarkdown(store, { type: 'bookmark' });
    assert.match(md, /### Bookmarked answers/);
    assert.match(md, /> and for staging\?/);
    assert.match(md, /Same, with --env staging\./);
  });
});

describe('bookmark MCP tool', () => {
  test('saves the answer before the request and shows it word for word', () => {
    writeEvents('live');
    const body = text(callRecallTool(store, 'bookmark', { title: 'Staging keys' }, undefined, '/', { id: 'live', stateDir }));
    assert.match(body, /^Bookmarked: #\d+ "Staging keys" \(acme\/web, turn 1\)\.$/);
    const id = Number(/#(\d+)/.exec(body)![1]);
    const shown = text(callRecallTool(store, 'get_observations', { ids: [id] }));
    assert.match(shown, /bookmarked from session live, turn 1/);
    assert.match(shown, /path: \/work\/web/);
    assert.match(shown, /Question:\nand for staging\?\nAnswer:\nSame, with --env staging\./);
  });

  test('reports a missing session as a tool error', () => {
    const result = callRecallTool(store, 'bookmark', {}, undefined, '/', { stateDir });
    assert.equal(result.isError, true);
    assert.match(text(result), /session ID is unknown/);
    const none = callRecallTool(store, 'bookmark', {}, undefined, '/', { id: 'nope', stateDir });
    assert.equal(none.isError, true);
  });
});

describe('bookmark CLI', () => {
  test('bookmarks the newest answer of the latest session and lists bookmarks', () => {
    const home = join(dir, 'home');
    stateDir = join(home, 'session-state');
    writeEvents('live');
    const env: NodeJS.ProcessEnv = { ...process.env, COPILOT_HOME: home, COPILOT_MEM_DATA_DIR: join(dir, 'data'), COPILOT_MEM_SOURCE_DB: '' };
    delete env.COPILOT_AGENT_SESSION_ID;
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });

    const saved = run('bookmark', '--title', 'Staging keys');
    assert.equal(saved.status, 0, saved.stderr);
    assert.equal(saved.stdout.trim(), 'Bookmarked: #1 "Staging keys" (acme/web, session live, turn 1).');
    assert.equal(run('bookmark', '--back', '2').stdout.trim(), 'Bookmarked: #2 "How do we rotate the API keys?" (acme/web, session live, turn 0).');
    const listed = run('bookmarks', 'staging');
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /^#1 {2}\d{4}-\d\d-\d\d {2}Staging keys {2}\[acme\/web\]$/m);
    assert.doesNotMatch(listed.stdout, /#2/);
    const missing = run('bookmark', '--session', 'nope');
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /no answer to bookmark in session nope/);
  });
});
