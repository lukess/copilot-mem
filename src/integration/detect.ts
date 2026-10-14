import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export interface CopilotInstall {
  /** Absolute path to the copilot binary. */
  bin: string;
  version: string;
  home: string;
  sessionStore: string;
  sessionStoreExists: boolean;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Like `which`: a name with a slash is checked as-is, otherwise searched on PATH. */
export function findExecutable(name: string, pathEnv = process.env.PATH ?? ''): string | undefined {
  if (name.includes('/')) {
    const path = isAbsolute(name) ? name : resolve(name);
    return isExecutable(path) ? path : undefined;
  }
  for (const dir of pathEnv.split(delimiter)) {
    if (dir && isExecutable(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

export function detectCopilot(binName: string, home: string): CopilotInstall {
  const bin = findExecutable(binName);
  if (!bin) {
    throw new Error(
      `GitHub Copilot CLI not found (looked for "${binName}" on PATH). Install it, or set COPILOT_MEM_COPILOT_BIN.`,
    );
  }
  const output = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  const version = output.match(/\d+\.\d+\.\d+/)?.[0];
  if (!version) throw new Error(`${bin} does not look like GitHub Copilot CLI (--version printed: ${output.trim()})`);
  const sessionStore = join(home, 'session-store.db');
  return { bin, version, home, sessionStore, sessionStoreExists: existsSync(sessionStore) };
}

export interface IdeInstall {
  name: 'VS Code' | 'VS Code Insiders';
  /** User data directory, or the CLI found on PATH. */
  path: string;
}

/**
 * VS Code installs, found by their user data directory or CLI. VS Code's Copilot agent reads
 * copilot-mem's MCP server, skill and hooks from ~/.copilot, so nothing extra is installed.
 */
export function detectIdes(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): IdeInstall[] {
  const base = platform === 'darwin'
    ? join(home, 'Library', 'Application Support')
    : platform === 'win32'
      ? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
      : (env.XDG_CONFIG_HOME ?? join(home, '.config'));
  const found: IdeInstall[] = [];
  for (const [name, dir, cli] of [['VS Code', 'Code', 'code'], ['VS Code Insiders', 'Code - Insiders', 'code-insiders']] as const) {
    const data = join(base, dir);
    const path = existsSync(data) ? data : findExecutable(cli, env.PATH ?? '');
    if (path) found.push({ name, path });
  }
  return found;
}
