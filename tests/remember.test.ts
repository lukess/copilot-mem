import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { parseObservations } from '../src/compress/prompt.ts';
import { buildSessionContext } from '../src/hooks/context.ts';
import { callRecallTool } from '../src/mcp/recall-server.ts';
import { rememberNote } from '../src/remember.ts';
import { MemoryStore } from '../src/storage/memory-store.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const NOW = '2026-10-01T12:00:00.000Z';

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'copilot-mem-remember-')));
  store = new MemoryStore(join(dir, 'memory.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const textOf = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

function addSession(id: string, repository: string | null, cwd: string): void {
  store.upsertSession({ id, cwd, repository, branch: 'main', host_type: null, summary: null, created_at: null, updated_at: null }, NOW);
  store.upsertTurn({ session_id: id, turn_index: 0, user_message: 'u', assistant_response: 'a', timestamp: NOW }, NOW);
}

describe('rememberNote', () => {
  test('saves a searchable note for the project', () => {
    const { id, project } = rememberNote(store, { title: 'Use pnpm, not npm', text: 'The monorepo relies on pnpm workspaces.', facts: [' pnpm 9 ', ''], project: 'acme/api/' }, '/', NOW);
    assert.equal(project, 'acme/api');
    const [note] = store.getObservations([id]);
    assert.equal(note.type, 'note');
    assert.equal(note.repository, 'acme/api');
    assert.deepEqual(note.facts, ['pnpm 9']);
    assert.equal(note.occurred_at, NOW);
    assert.deepEqual(store.searchObservations({ query: 'pnpm', project: 'acme/api', limit: 5, offset: 0 }).map((o) => o.id), [id]);
    assert.deepEqual(store.searchObservations({ type: 'note', limit: 5, offset: 0 }).map((o) => o.id), [id]);
  });

  test('defaults to the repository recorded for the current git root, else the directory', () => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src'));
    addSession('s1', 'acme/web', repo);
    assert.equal(rememberNote(store, { title: 'a', text: 'b' }, join(repo, 'src'), NOW).project, 'acme/web');
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const saved = rememberNote(store, { title: 'c', text: 'd' }, plain, NOW);
    assert.equal(saved.project, plain);
    assert.equal(store.getObservations([saved.id])[0].cwd, plain);
    // Regression: a non-git parent of a repo used to take that repo's name.
    assert.equal(rememberNote(store, { title: 'e', text: 'f' }, dir, NOW).project, dir);
  });

  test('rejects empty or oversized input and malformed projects', () => {
    assert.throws(() => rememberNote(store, { title: ' ', text: 'x', project: 'a/b' }, '/'), /title is required/);
    assert.throws(() => rememberNote(store, { title: 'x', text: '', project: 'a/b' }, '/'), /text is required/);
    assert.throws(() => rememberNote(store, { title: 'x'.repeat(121), text: 'x', project: 'a/b' }, '/'), /at most 120/);
    assert.throws(() => rememberNote(store, { title: 'x', text: 'x'.repeat(4001), project: 'a/b' }, '/'), /at most 4000/);
    assert.throws(() => rememberNote(store, { title: 'x', text: 'x', project: 'relative/dir/path' }, '/'), /owner\/name/);
    assert.equal(store.counts().observations, 0);
  });

  test('notes do not count as Copilot sessions or get tool-event scans', () => {
    addSession('s1', 'acme/api', '/work/api');
    rememberNote(store, { title: 't', text: 'x', project: 'acme/api' }, '/', NOW);
    assert.equal(store.counts().sessions, 1);
    assert.deepEqual(store.sessionIds(), ['s1']);
  });

  test('compression never changes a note, even when it produces the same title', () => {
    const { id } = rememberNote(store, { title: 'Use pnpm', text: 'User said so.', project: 'acme/api' }, '/', NOW);
    addSession('s1', 'acme/api', '/work/api');
    store.completeBatch('s1', [0], [{ type: 'decision', title: 'Use pnpm', narrative: 'Model summary.', facts: [], files: [] }], 'm', NOW);
    const [note] = store.getObservations([id]);
    assert.equal(note.type, 'note');
    assert.equal(note.narrative, 'User said so.');
    assert.equal(parseObservations('{"observations":[{"type":"note","title":"t","narrative":"n"}]}')[0].type, 'discovery', 'the model cannot create notes');
  });

  test('notes show up in the session-start context', () => {
    const plain = join(dir, 'proj');
    mkdirSync(plain);
    rememberNote(store, { title: 'Deploy only on Tuesdays', text: 'Team rule.' }, plain, NOW);
    assert.match(buildSessionContext(store, plain), /## Notes saved by the user\n#\d+ Deploy only on Tuesdays/);
  });
});

describe('remember MCP tool', () => {
  test('saves a note in the server cwd project and shows it as user-saved', () => {
    const plain = join(dir, 'proj');
    mkdirSync(plain);
    const saved = textOf(callRecallTool(store, 'remember', { title: 'Prefer tabs', text: 'Use tabs in Go files.', files: ['main.go'] }, undefined, plain));
    assert.equal(saved, `Saved note #1 for ${plain}.`);
    const detail = textOf(callRecallTool(store, 'get_observations', { ids: [1] }));
    assert.match(detail, /\[note\] Prefer tabs/);
    assert.match(detail, /saved by the user/);
    assert.match(detail, /Files: main.go/);
    assert.match(textOf(callRecallTool(store, 'search', { query: 'tabs', type: 'note' })), /#1 .*note .*Prefer tabs/);
  });

  test('reports invalid arguments as tool errors', () => {
    for (const args of [{ title: 'x' }, { title: 'x', text: 'y', facts: 'nope' }, { title: 'x', text: 'y', project: 'bad' }]) {
      const result = callRecallTool(store, 'remember', args, undefined, '/');
      assert.equal(result.isError, true);
      assert.match(textOf(result), /^Invalid arguments:/);
    }
    assert.equal(store.counts().observations, 0);
  });
});

describe('remember CLI', () => {
  test('saves a note with facts, files and a project', () => {
    const dataDir = join(dir, 'data');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [CLI, 'remember', ...args], { env: { ...process.env, COPILOT_MEM_DATA_DIR: dataDir }, encoding: 'utf8' });
    const ok = run('Ship on green', 'Only merge when CI is green.', '--fact', 'CI = GitHub Actions', '--file', '.github/ci.yml', '--project', 'acme/api');
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), 'Saved note #1 for acme/api.');
    const db = new MemoryStore(join(dataDir, 'memory.db'));
    try {
      const [note] = db.getObservations([1]);
      assert.deepEqual([note.type, note.title, note.facts, note.files], ['note', 'Ship on green', ['CI = GitHub Actions'], ['.github/ci.yml']]);
    } finally {
      db.close();
    }
    const bad = run('only a title');
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /usage: copilot-mem remember/);
  });
});
