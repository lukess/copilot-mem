import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { buildSessionContext, CONTEXT_ITEMS } from '../src/hooks/context.ts';
import { runHook } from '../src/hooks/hook.ts';
import { MemoryStore, type Observation } from '../src/storage/memory-store.ts';

let dir: string;
let dbPath: string;
let store: MemoryStore;

function addSession(id: string, repository: string | null, cwd: string, timestamp: string, titles: string[]): void {
  store.upsertSession({ id, cwd, repository, branch: null, host_type: null, summary: null, created_at: timestamp, updated_at: timestamp }, timestamp);
  store.upsertTurn({ session_id: id, turn_index: 0, user_message: 'u', assistant_response: 'a', timestamp }, timestamp);
  const observations = titles.map((title): Observation => ({ type: 'decision', title, narrative: 'n', facts: [], files: [] }));
  store.completeBatch(id, [0], observations, 'm', timestamp);
}

beforeEach(() => {
  // Copilot records physical cwds (macOS: /private/var/...), so fixtures do too.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'copilot-mem-hooks-')));
  dbPath = join(dir, 'memory.db');
  store = new MemoryStore(dbPath);
  mkdirSync(join(dir, 'api', '.git'), { recursive: true });
  mkdirSync(join(dir, 'api', 'src', 'deep'), { recursive: true });
  mkdirSync(join(dir, 'other-clone'), { recursive: true });
  addSession('a', 'acme/api', join(dir, 'api'), '2026-09-01T00:00:00.000Z', ['API decision one']);
  addSession('b', 'acme/api', join(dir, 'other-clone'), '2026-09-02T00:00:00.000Z', ['API decision from another clone']);
  addSession('c', 'acme/web', join(dir, 'web'), '2026-09-03T00:00:00.000Z', ['Web decision']);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('buildSessionContext', () => {
  test('lists recent observations for the repository of the git root, from any clone', () => {
    const context = buildSessionContext(store, join(dir, 'api', 'src', 'deep'));
    assert.match(context, /^# copilot-mem: recent memory for acme\/api/);
    assert.match(context, /#2 2026-09-02 decision: API decision from another clone\n#1 2026-09-01 decision: API decision one/);
    assert.doesNotMatch(context, /Web decision/);
    assert.match(context, /search .*timeline .*get_observations/);
  });

  test('outside a git repo, covers every repository worked on below the directory', () => {
    // Regression: a session started in ~/dev was labelled with one arbitrary repo (the most
    // recent below it) while listing observations from all of them.
    const context = buildSessionContext(store, dir);
    assert.match(context, new RegExp(`^# copilot-mem: recent memory under ${dir} \\(repositories: acme/web, acme/api\\)\n`));
    assert.match(context, /Web decision/);
    assert.match(context, /API decision one/);
  });

  test('includes a few observations from linked projects, within the same item count', () => {
    store.linkProjects(['acme/api', 'acme/web'], 'now');
    addSession('d', 'acme/api', join(dir, 'api'), '2026-09-04T00:00:00.000Z', Array.from({ length: 20 }, (_, i) => `API filler ${i}`));
    const context = buildSessionContext(store, join(dir, 'api'));
    assert.match(context, /^# copilot-mem: recent memory for acme\/api \(linked: acme\/web\)\n/);
    assert.match(context, /## From linked projects\n#3 2026-09-03 \[acme\/web\] decision: Web decision\n/);
    assert.equal(context.match(/ decision: /g)!.length, CONTEXT_ITEMS);
    assert.doesNotMatch(context.split('## From linked')[0], /Web decision/);
    // A directory spanning several repos already includes them all; no separate linked section.
    assert.doesNotMatch(buildSessionContext(store, dir), /From linked projects/);
  });

  test('falls back to a note about the tools when nothing is known', () => {
    const context = buildSessionContext(store, join(dir, 'brand-new'));
    assert.doesNotMatch(context, /recent memory/);
    assert.match(context, /^copilot-mem memory tools are available/);
  });

  test('matches a cwd reached through a symlink (macOS /var -> /private/var)', () => {
    symlinkSync(dir, join(dir, 'alias'));
    assert.match(buildSessionContext(store, join(dir, 'alias', 'api', 'src')), /API decision one/);
  });

  test('leads with the last session summary and notes, and stays within the budget', () => {
    store.saveSummary('b', { request: 'Unify API clones', investigated: '', learned: 'x', completed: 'Merged config', next_steps: 'Delete old clone', notes: '' }, [2], 'm', 'now');
    store.remember('acme/api', { title: 'Always run make lint', narrative: 'n', facts: [], files: [] }, '2026-09-05T00:00:00.000Z');
    addSession('d', 'acme/api', join(dir, 'api'), '2026-09-04T00:00:00.000Z', Array.from({ length: 40 }, (_, i) => `Filler observation number ${i} about something`));
    const context = buildSessionContext(store, join(dir, 'api'));
    assert.match(context, /## Last session \(2026-09-02\)\nRequest: Unify API clones\nCompleted: Merged config\nNext steps: Delete old clone\n/);
    assert.doesNotMatch(context, /Learned:/);
    assert.match(context, /## Notes saved by the user\n#\d+ Always run make lint\n## Observations/);
    assert.equal(context.match(/ decision: /g)!.length, 15);
    assert.ok(context.endsWith('Fetch details only for IDs that matter to the current task.'));

    const small = buildSessionContext(store, join(dir, 'api'), 700);
    assert.ok(small.length <= 700, `${small.length} chars`);
    assert.match(small, /Next steps: Delete old clone/);
    assert.match(small, /search .*timeline .*get_observations/);
    assert.doesNotMatch(small, /## Observations\n\n/);
  });

  test('pinned observations and notes lead the context, even old ones, and are not repeated below', () => {
    addSession('d', 'acme/api', join(dir, 'api'), '2026-09-04T00:00:00.000Z', Array.from({ length: 40 }, (_, i) => `Filler observation number ${i} about something`));
    const note = store.remember('acme/api', { title: 'Always run make lint', narrative: 'n', facts: [], files: [] }, '2026-09-05T00:00:00.000Z');
    assert.ok(store.setPinned(1, true, '2026-09-06T00:00:00.000Z'));
    assert.ok(store.setPinned(note, true, '2026-09-06T00:00:00.000Z'));
    assert.ok(!store.setPinned(999, true, 'x'));
    const context = buildSessionContext(store, join(dir, 'api'));
    assert.match(context, new RegExp(`^# copilot-mem: recent memory for acme/api\n## Pinned by the user\n#${note} note: Always run make lint\n#1 decision: API decision one\n`));
    assert.equal(context.match(/API decision one/g)!.length, 1, 'oldest observation is in, once');
    assert.equal(context.match(/Always run make lint/g)!.length, 1);
    assert.doesNotMatch(context, /## Notes saved by the user/);
    assert.equal(context.match(/ decision: /g)!.length, 16, 'pins come on top of the usual 15 observations');
    assert.doesNotMatch(buildSessionContext(store, join(dir, 'web')), /Pinned/, 'pins stay in their project');

    store.setPinned(1, false, 'x');
    assert.doesNotMatch(buildSessionContext(store, join(dir, 'api')), /#1 decision/, 'unpinned, it is too old to make the cut again');
  });

  test('prefers re-confirmed observations over merely recent ones, and skips near-duplicates', () => {
    addSession('old', 'acme/api', join(dir, 'api'), '2026-06-01T00:00:00.000Z', ['Redis needs a socket timeout']);
    for (let i = 1; i <= 3; i++) {
      store.upsertTurn({ session_id: 'old', turn_index: i, user_message: 'u', assistant_response: 'a', timestamp: `2026-09-1${i}T00:00:00.000Z` }, 'x');
      store.completeBatch('old', [i], [{ type: 'decision', title: 'Redis needs a socket timeout', narrative: 'n', facts: [], files: [] }], 'm', 'x');
    }
    addSession('many', 'acme/api', join(dir, 'api'), '2026-09-20T00:00:00.000Z', Array.from({ length: 30 }, (_, i) => `Routine change ${i} in module ${i}`));
    const today = new Date('2026-09-21T00:00:00.000Z');
    assert.match(buildSessionContext(store, join(dir, 'api'), 10_000, today), /Redis needs a socket timeout/);

    const fresh = store.searchObservations({ query: 'Routine change 29', limit: 1, offset: 0 })[0]!.id;
    const twin = store.searchObservations({ query: 'Routine change 28', limit: 1, offset: 0 })[0]!.id;
    (store as unknown as { recordDuplicate(a: number, b: number, s: number, n: string): number }).recordDuplicate(twin, fresh, 0.9, 'x');
    const context = buildSessionContext(store, join(dir, 'api'), 10_000, today);
    assert.match(context, new RegExp(`#${fresh} `));
    assert.doesNotMatch(context, new RegExp(`#${twin} `));
  });

  test('a parent directory shows everything below it', () => {
    assert.match(buildSessionContext(store, dir), /Web decision/);
  });
});

describe('runHook', () => {
  const deps = () => {
    const calls = { workers: 0 };
    return { calls, deps: { openStore: () => new MemoryStore(dbPath), startWorker: () => void calls.workers++ } };
  };

  test('session-start starts the worker and returns additionalContext JSON', () => {
    const { calls, deps: d } = deps();
    const output = runHook('session-start', JSON.stringify({ cwd: join(dir, 'api'), source: 'new' }), d);
    assert.equal(calls.workers, 1);
    assert.match(JSON.parse(output ?? '').additionalContext, /API decision one/);
  });

  test('session-start answers VS Code (Local agent) payloads in its hookSpecificOutput format', () => {
    const { deps: d } = deps();
    const payload = { timestamp: 't', cwd: join(dir, 'api'), session_id: 'x', hook_event_name: 'SessionStart', source: 'new' };
    const output = JSON.parse(runHook('session-start', JSON.stringify(payload), d) ?? '');
    assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(output.hookSpecificOutput.additionalContext, /API decision one/);
  });

  test('session-start injects nothing on resume, and survives a garbage payload', () => {
    const { calls, deps: d } = deps();
    assert.equal(runHook('session-start', JSON.stringify({ cwd: dir, source: 'resume' }), d), undefined);
    assert.ok(JSON.parse(runHook('session-start', 'not json', d) ?? '').additionalContext);
    assert.equal(calls.workers, 2);
  });

  test('stop only starts the worker; unknown events throw', () => {
    const { calls, deps: d } = deps();
    assert.equal(runHook('stop', '{}', d), undefined);
    assert.equal(calls.workers, 1);
    assert.throws(() => runHook('preToolUse', '{}', d), /Unknown hook event/);
  });
});
