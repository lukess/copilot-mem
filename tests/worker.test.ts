import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { lockHolder, tryLock, unlock, withLock } from '../src/worker/lock.ts';
import { requestWork, runWorker, workerFiles, type WorkerFiles } from '../src/worker/worker.ts';

let dir: string;
let files: WorkerFiles;
const DEAD_PID = 2 ** 22 + 12345; // above macOS/Linux pid_max defaults

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-mem-worker-'));
  files = workerFiles(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('lock', () => {
  test('is exclusive while the holder lives and released only by the holder', () => {
    assert.equal(tryLock(files.lock), true);
    assert.equal(lockHolder(files.lock), process.pid);
    writeFileSync(files.compressLock, String(process.ppid));
    assert.equal(tryLock(files.compressLock), false, 'a live process (our parent) holds it');
    unlock(files.compressLock);
    assert.ok(existsSync(files.compressLock), 'cannot release a lock someone else holds');
    unlock(files.lock);
    assert.equal(existsSync(files.lock), false);
  });

  test('takes over a lock left by a dead process', () => {
    writeFileSync(files.lock, String(DEAD_PID));
    assert.equal(lockHolder(files.lock), undefined);
    assert.equal(tryLock(files.lock), true);
    assert.equal(readFileSync(files.lock, 'utf8'), String(process.pid));
  });

  test('withLock skips the work when busy and releases after errors', async () => {
    writeFileSync(files.compressLock, String(process.ppid));
    assert.equal(await withLock(files.compressLock, async () => 'ran'), undefined);
    rmSync(files.compressLock);
    await assert.rejects(withLock(files.compressLock, async () => { throw new Error('boom'); }), /boom/);
    assert.equal(existsSync(files.compressLock), false);
  });
});

describe('runWorker', () => {
  test('runs once per burst of requests, again for requests made while running, then exits', async () => {
    let rounds = 0;
    requestWork(files);
    const ran = await runWorker(files, {
      debounceMs: 5,
      log: () => {},
      task: async () => {
        rounds++;
        if (rounds === 1) {
          requestWork(files); // a hook fires while we sync
          requestWork(files);
        }
      },
    });
    assert.equal(ran, true);
    assert.equal(rounds, 2);
    assert.equal(existsSync(files.lock), false);
    assert.equal(existsSync(files.pending), false);
  });

  test('leaves the request to an already-running worker', async () => {
    writeFileSync(files.lock, String(process.ppid));
    requestWork(files);
    assert.equal(await runWorker(files, { debounceMs: 0, log: () => {}, task: async () => assert.fail('must not run') }), false);
    assert.ok(existsSync(files.pending));
  });

  test('logs a failing round and keeps the lock tidy', async () => {
    const logs: string[] = [];
    await runWorker(files, { debounceMs: 0, log: (m) => logs.push(m), task: async () => { throw new Error('db locked'); } });
    assert.deepEqual(logs, ['error: db locked']);
    assert.equal(existsSync(files.lock), false);
  });
});
