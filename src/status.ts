import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { autoCompressLimit, copilotBin, copilotHome, dataDir, describeSettings, loadSettings, memoryDbPath, settingsPath } from './config.ts';
import { embedderFromSettings, localModelDownloaded, localRuntimeDir, localRuntimeInstalled } from './search/embeddings.ts';
import { detectCopilot, detectIdes } from './integration/detect.ts';
import { hooksPath, MCP_NAME, readManifest, skillPath } from './integration/install.ts';
import { MemoryStore } from './storage/memory-store.ts';
import { lockHolder } from './worker/lock.ts';
import { workerFiles, type WorkerFiles } from './worker/worker.ts';

const TAIL_BYTES = 64 * 1024;

/** The last `n` lines of a (possibly large) text file; [] if it doesn't exist. */
export function tailLines(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n').filter(Boolean);
    if (length < size) lines.shift(); // probably cut mid-line
    return lines.slice(-n);
  } finally {
    closeSync(fd);
  }
}

export type SettingsReport = ReturnType<typeof describeSettings> & {
  /** The configured embedding model ('provider:model' for cloud providers); null when off or misconfigured. */
  embedding: { model: string | null; error?: string; setup?: string };
};

/** Effective settings (secrets masked) and the embedding model they select, read fresh each call. */
export function settingsReport(env: NodeJS.ProcessEnv = process.env, path = settingsPath(dataDir(env))): SettingsReport {
  let embedding: SettingsReport['embedding'];
  try {
    embedding = { model: embedderFromSettings(loadSettings(env, path))?.model ?? null };
    const runtime = localRuntimeDir(dirname(path));
    if (embedding.model?.startsWith('local:') && !localRuntimeInstalled(runtime)) {
      embedding.setup = 'The local embedding runtime is not installed: run `copilot-mem embed --setup` (one-time, ~350 MB).';
    } else if (embedding.model?.startsWith('local:') && !localModelDownloaded(embedding.model.slice('local:'.length), runtime)) {
      embedding.setup = `The model ${embedding.model.slice('local:'.length)} is not downloaded: run \`copilot-mem embed\`.`;
    }
  } catch (error) {
    embedding = { model: null, error: (error as Error).message };
  }
  return { ...describeSettings(env, path), embedding };
}

export function workerState(files: WorkerFiles) {
  // A bad setting (or settings.json mid-save) must not take down the dashboard's poll loop.
  let limit: { autoCompressLimit: number | null; settingsError?: string };
  try {
    limit = { autoCompressLimit: autoCompressLimit() };
  } catch (error) {
    limit = { autoCompressLimit: null, settingsError: (error as Error).message };
  }
  return {
    running: lockHolder(files.lock) ?? false,
    compressing: lockHolder(files.compressLock) ?? false,
    ...limit,
  };
}

export function collectStatus(version: string): Record<string, unknown> {
  const files = workerFiles(dataDir());
  let copilot: unknown;
  try {
    copilot = detectCopilot(copilotBin(), copilotHome());
  } catch (error) {
    copilot = { error: (error as Error).message };
  }
  const home = readManifest(dataDir())?.copilotHome ?? copilotHome();
  let mcpRegistered = false;
  try {
    mcpRegistered = MCP_NAME in JSON.parse(readFileSync(join(home, 'mcp-config.json'), 'utf8')).mcpServers;
  } catch {
    // no user MCP config yet
  }
  const store = new MemoryStore(memoryDbPath());
  try {
    return {
      version,
      copilot,
      installed: readManifest(dataDir()) ?? false,
      integration: { mcpServer: mcpRegistered, skill: existsSync(skillPath(home)), hooks: existsSync(hooksPath(home)) },
      ides: detectIdes(),
      settings: settingsPath(),
      memory: { path: memoryDbPath(), ...store.counts() },
      worker: { ...workerState(files), recentLog: tailLines(files.log, 5) },
    };
  } finally {
    store.close();
  }
}
