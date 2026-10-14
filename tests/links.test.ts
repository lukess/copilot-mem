import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { linkProjects, listLinks, unlinkProjects } from '../src/links.ts';
import { MemoryStore } from '../src/storage/memory-store.ts';

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-mem-links-'));
  store = new MemoryStore(join(dir, 'memory.db'));
  store.upsertSession(
    { id: 's', cwd: '/work/app', repository: 'acme/app', branch: null, host_type: null, summary: null, created_at: null, updated_at: null },
    'now',
  );
  store.upsertTurn({ session_id: 's', turn_index: 0, user_message: 'u', assistant_response: 'a', timestamp: 'now' }, 'now');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('project links', () => {
  test('links every pair both ways, but not transitively across separate link commands', () => {
    const message = linkProjects(store, ['acme/app', 'acme/api', '/work/exp/'], 'now');
    assert.match(message, /^Linked acme\/app, acme\/api, \/work\/exp \(3 new pair\(s\)\)/);
    assert.match(message, /no memory recorded for acme\/api yet/);
    assert.doesNotMatch(message, /no memory recorded for acme\/app/);
    assert.deepEqual(store.linkedProjects(['acme/api']), ['/work/exp', 'acme/app']);
    linkProjects(store, ['acme/api', 'acme/other'], 'now');
    assert.deepEqual(store.linkedProjects(['acme/app']), ['/work/exp', 'acme/api']);
    assert.deepEqual(store.linkedProjects(['acme/app', 'acme/api']), ['/work/exp', 'acme/other']);
    assert.match(linkProjects(store, ['acme/app', 'acme/api'], 'now'), /\(0 new pair\(s\)\)/);
  });

  test('lists and removes links', () => {
    assert.match(listLinks(store), /^No linked projects/);
    linkProjects(store, ['acme/app', 'acme/api', 'acme/exp'], 'now');
    assert.equal(listLinks(store), 'acme/api -> acme/app, acme/exp\nacme/app -> acme/api, acme/exp\nacme/exp -> acme/api, acme/app');
    assert.equal(unlinkProjects(store, ['acme/app', 'acme/exp']), 'Removed 1 link(s) between acme/app, acme/exp.');
    assert.deepEqual(store.linkedProjects(['acme/exp']), ['acme/api']);
  });

  test('rejects malformed or too few projects', () => {
    assert.throws(() => linkProjects(store, ['acme/app'], 'now'), /at least two/);
    assert.throws(() => linkProjects(store, ['acme/app', 'acme/app/'], 'now'), /at least two/);
    assert.throws(() => linkProjects(store, ['acme/app', 'orbit'], 'now'), /"orbit": a project is a repository/);
  });
});
