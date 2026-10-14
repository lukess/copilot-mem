import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { saveSettingsFile, settingsPath } from '../config.ts';
import { detectCopilot, detectIdes, findExecutable, type CopilotInstall } from './detect.ts';
import { SKILL_MD, SKILL_NAME } from './skill.ts';

export const MCP_NAME = 'copilot-mem';
export const HOOKS_FILE = 'copilot-mem.json';

/**
 * Forwarded from the installing shell to the MCP server and hooks: only where the data (and so
 * settings.json) lives. Everything else is read from settings.json, so edits there need no reinstall.
 */
const FORWARDED_ENV = ['COPILOT_MEM_DATA_DIR'];

export interface InstallContext {
  copilotHome: string;
  dataDir: string;
  copilotBinName: string;
  /** Runtime that runs copilot-mem (process.execPath). */
  runtime: string;
  /** The running copilot-mem entry point: dist bundle (.js) or source checkout (src/cli.ts). */
  entry: string;
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
  /** User home for IDE detection (default os.homedir()). */
  home?: string;
}

export interface InstallManifest {
  version: string;
  installedAt: string;
  copilotBin: string;
  copilotVersion: string;
  copilotHome: string;
  command: string[];
  hooksPath: string;
  skillPath: string;
}

export const manifestPath = (dataDir: string) => join(dataDir, 'install.json');
export const hooksPath = (copilotHome: string) => join(copilotHome, 'hooks', HOOKS_FILE);
export const skillPath = (copilotHome: string) => join(copilotHome, 'skills', SKILL_NAME, 'SKILL.md');

export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function copilot(bin: string, home: string, args: string[]): void {
  execFileSync(bin, args, { env: { ...process.env, COPILOT_HOME: home }, stdio: 'pipe', timeout: 60_000 });
}

function tryCopilot(bin: string, home: string, args: string[]): boolean {
  try {
    copilot(bin, home, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * A bundled build is copied next to the data so hooks keep working after an npx cache is cleared;
 * a source checkout is used in place.
 */
function stableEntry(ctx: InstallContext): string {
  // npm/npx run us through a bin symlink without the .js extension.
  const entry = realpathSync(ctx.entry);
  if (!entry.endsWith('.js')) return entry;
  const target = join(ctx.dataDir, 'lib', 'copilot-mem.js');
  if (target !== entry) {
    mkdirSync(join(ctx.dataDir, 'lib'), { recursive: true, mode: 0o700 });
    copyFileSync(entry, target);
  }
  return target;
}

/**
 * Prefers a PATH entry (e.g. /opt/homebrew/bin/node) over the versioned binary it links to
 * (e.g. /opt/homebrew/Cellar/node/26.11.0/bin/node), so hooks survive runtime upgrades.
 */
export function stableRuntime(execPath: string, pathEnv = process.env.PATH ?? ''): string {
  const onPath = findExecutable(basename(execPath), pathEnv);
  try {
    if (onPath && realpathSync(onPath) === realpathSync(execPath)) return onPath;
  } catch {
    // fall through to execPath
  }
  return execPath;
}

export function hooksConfig(command: string[], env: Record<string, string>) {
  const hook = (event: string, timeoutSec: number) => ({
    type: 'command',
    bash: [...command, 'hook', event].map(shellQuote).join(' '),
    timeoutSec,
    env,
  });
  return {
    version: 1,
    hooks: {
      sessionStart: [hook('session-start', 10)],
      // Both only start the background worker, which waits for Copilot to write the turn.
      agentStop: [hook('stop', 10)],
      sessionEnd: [hook('stop', 10)],
    },
  };
}

export function install(ctx: InstallContext, version: string): InstallManifest {
  const found: CopilotInstall = detectCopilot(ctx.copilotBinName, ctx.copilotHome);
  ctx.log(`Found GitHub Copilot CLI ${found.version} at ${found.bin} (home ${found.home})`);
  if (!found.sessionStoreExists) {
    ctx.log(`Note: ${found.sessionStore} does not exist yet; it appears after your first Copilot session.`);
  }
  mkdirSync(ctx.dataDir, { recursive: true, mode: 0o700 });
  const command = [stableRuntime(ctx.runtime, ctx.env.PATH), stableEntry(ctx)];
  const forwarded = Object.fromEntries(
    FORWARDED_ENV.filter((key) => ctx.env[key]).map((key) => [key, ctx.env[key] as string]),
  );
  const settings = settingsPath(ctx.dataDir);
  const saved = saveSettingsFile(settings, ctx.env, { COPILOT_MEM_COPILOT_BIN: found.bin });
  ctx.log(`${saved.created ? 'Created' : 'Updated'} settings ${settings}` +
    (saved.fromEnv.length ? ` (saved from your environment: ${saved.fromEnv.join(', ')})` : ''));

  tryCopilot(found.bin, found.home, ['mcp', 'remove', MCP_NAME]);
  copilot(found.bin, found.home, [
    'mcp', 'add', MCP_NAME,
    ...Object.entries(forwarded).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    '--', ...command, 'mcp',
  ]);
  ctx.log(`Registered MCP server "${MCP_NAME}" (copilot mcp add)`);

  const scratch = mkdtempSync(join(ctx.dataDir, 'skill-'));
  try {
    writeFileSync(join(scratch, 'SKILL.md'), SKILL_MD);
    tryCopilot(found.bin, found.home, ['skill', 'remove', SKILL_NAME]);
    copilot(found.bin, found.home, ['skill', 'add', join(scratch, 'SKILL.md')]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  ctx.log(`Added skill "${SKILL_NAME}" (copilot skill add)`);

  const hooks = hooksPath(found.home);
  mkdirSync(join(found.home, 'hooks'), { recursive: true });
  writeFileSync(hooks, `${JSON.stringify(hooksConfig(command, forwarded), null, 2)}\n`);
  ctx.log(`Wrote hooks ${hooks} (sessionStart context; agentStop/sessionEnd background sync)`);
  for (const ide of detectIdes(ctx.env, ctx.home)) {
    ctx.log(`Found ${ide.name} (${ide.path}): its Copilot agent uses the same MCP server, skill and hooks from ${found.home}; ` +
      'memory is captured from Copilot CLI sessions only');
  }

  const manifest: InstallManifest = {
    version,
    installedAt: new Date().toISOString(),
    copilotBin: found.bin,
    copilotVersion: found.version,
    copilotHome: found.home,
    command,
    hooksPath: hooks,
    skillPath: skillPath(found.home),
  };
  writeFileSync(manifestPath(ctx.dataDir), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

export function readManifest(dataDir: string): InstallManifest | undefined {
  try {
    return JSON.parse(readFileSync(manifestPath(dataDir), 'utf8')) as InstallManifest;
  } catch {
    return undefined;
  }
}

/** Removes everything install added. The memory database is kept. */
export function uninstall(ctx: InstallContext): void {
  const manifest = readManifest(ctx.dataDir);
  const home = manifest?.copilotHome ?? ctx.copilotHome;
  const bin = manifest?.copilotBin && existsSync(manifest.copilotBin) ? manifest.copilotBin : findExecutable(ctx.copilotBinName);
  if (bin) {
    ctx.log(tryCopilot(bin, home, ['mcp', 'remove', MCP_NAME]) ? `Removed MCP server "${MCP_NAME}"` : `MCP server "${MCP_NAME}" was not registered`);
    ctx.log(tryCopilot(bin, home, ['skill', 'remove', SKILL_NAME]) ? `Removed skill "${SKILL_NAME}"` : `Skill "${SKILL_NAME}" was not installed`);
  } else {
    ctx.log(`Copilot CLI not found: remove the "${MCP_NAME}" entry from ${join(home, 'mcp-config.json')} and ${join(home, 'skills', SKILL_NAME)} by hand`);
  }
  const hooks = manifest?.hooksPath ?? hooksPath(home);
  if (existsSync(hooks)) {
    rmSync(hooks);
    ctx.log(`Removed hooks ${hooks}`);
  }
  rmSync(join(ctx.dataDir, 'lib'), { recursive: true, force: true });
  rmSync(manifestPath(ctx.dataDir), { force: true });
  ctx.log(`Kept memory data in ${ctx.dataDir} (delete it yourself to forget everything)`);
}
