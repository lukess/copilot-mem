import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { tryLock, unlock } from './lock.ts';

export interface WorkerFiles {
  /** Held by the one running worker. */
  lock: string;
  /** Exists while there is work the running worker has not started yet. */
  pending: string;
  /** Held by whoever is compressing (worker or `copilot-mem compress`). */
  compressLock: string;
  log: string;
}

export function workerFiles(dir: string): WorkerFiles {
  return {
    lock: join(dir, 'worker.lock'),
    pending: join(dir, 'worker.pending'),
    compressLock: join(dir, 'compress.lock'),
    log: join(dir, 'worker.log'),
  };
}

const MAX_LOG_BYTES = 1_000_000;

export function createFileLogger(path: string): (message: string) => void {
  return (message) => {
    try {
      if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
      appendFileSync(path, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
    } catch {
      // Logging must never break the worker.
    }
  };
}

export function requestWork(files: WorkerFiles): void {
  mkdirSync(join(files.pending, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(files.pending, '');
}

/**
 * Runs `task` until no work is pending. Copilot writes a turn shortly after the hooks fire, and
 * hooks fire in bursts, so each round first waits `debounceMs`; requests made meanwhile are
 * absorbed into that round. Returns false if another worker already holds the lock (it will
 * see our pending request).
 */
export async function runWorker(
  files: WorkerFiles,
  options: { debounceMs: number; task: () => Promise<void>; log: (message: string) => void },
): Promise<boolean> {
  if (!tryLock(files.lock)) return false;
  try {
    for (;;) {
      do {
        await sleep(options.debounceMs);
        rmSync(files.pending, { force: true });
        try {
          await options.task();
        } catch (error) {
          options.log(`error: ${error instanceof Error ? error.message : String(error)}`);
        }
      } while (existsSync(files.pending));
      unlock(files.lock);
      // A request that landed after the last check, but whose worker found us still holding the lock.
      if (!existsSync(files.pending) || !tryLock(files.lock)) return true;
    }
  } finally {
    unlock(files.lock);
  }
}
