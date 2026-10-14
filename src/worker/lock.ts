import { readFileSync, rmSync, writeFileSync } from 'node:fs';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A pid lock file. Returns false while another live process holds it; takes over locks left
 * behind by processes that died.
 */
export function tryLock(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let holder = NaN;
    try {
      holder = Number(readFileSync(path, 'utf8'));
    } catch {
      continue; // released between our attempts; retry
    }
    if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) return false;
    rmSync(path, { force: true });
  }
  return false;
}

export function unlock(path: string): void {
  try {
    if (Number(readFileSync(path, 'utf8')) === process.pid) rmSync(path, { force: true });
  } catch {
    // already gone
  }
}

export function withLock<T>(path: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (!tryLock(path)) return Promise.resolve(undefined);
  return fn().finally(() => unlock(path));
}

/** The pid holding the lock, if that process is still alive. */
export function lockHolder(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, 'utf8'));
    return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}
