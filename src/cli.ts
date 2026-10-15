import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pkg from '../package.json' with { type: 'json' };
import { compressorModel, copilotBin, copilotHome, dataDir, describeSettings, memoryDbPath, sessionStateDir, sourceDbPath } from './config.ts';
import { SessionStoreReader } from './capture/session-store-reader.ts';
import { syncOnce } from './capture/sync.ts';
import { compressPending } from './compress/compressor.ts';
import { createCopilotRunner } from './compress/copilot-runner.ts';
import { summarizeSessions } from './compress/summary.ts';
import { runHook } from './hooks/hook.ts';
import { install, uninstall, type InstallContext } from './integration/install.ts';
import { createRecallServer } from './mcp/recall-server.ts';
import { createQueryEmbedder, embedderFromSettings, embedderOrWarn, embedPending, localRuntimeInstalled, setupLocalRuntime } from './search/embeddings.ts';
import { bookmarkAnswer, latestSession } from './bookmark.ts';
import { linkProjects, listLinks, unlinkProjects } from './links.ts';
import { rememberNote } from './remember.ts';
import { collectStatus, settingsReport } from './status.ts';
import { MemoryStore } from './storage/memory-store.ts';
import { backgroundRound, compressRound } from './worker/background.ts';
import { withLock } from './worker/lock.ts';
import { createFileLogger, requestWork, runWorker, workerFiles } from './worker/worker.ts';
import { DEFAULT_VIEWER_PORT, startViewer } from './viewer/server.ts';

const USAGE = `Usage: copilot-mem <command>

Setup:
  install                Detect Copilot CLI and register copilot-mem (MCP server, skill, hooks)
  uninstall              Remove what install added (keeps the memory database)
  status                 Show detection, installation, memory, and worker state
  settings               Show each setting's value and where it comes from (environment, settings
                         file, or default)

Memory:
  sync [--full]          Mirror new Copilot CLI sessions/turns into copilot-mem's database
  compress [--limit N] [--project P] [--background]
                         Summarize pending turns into observations (at most N Copilot calls; only
                         project P, a repository or directory as listed in the viewer). --background
                         syncs first and logs to worker.log instead of the terminal
  stats                  Show what copilot-mem has stored, plus compression time, tokens and AI credits
  dedup                  Record near-duplicate observations (per project) for review; merges nothing
  summarize [--limit N] [--session ID]
                         Summarize finished sessions (one Copilot call each, at most N; default 10).
                         The worker also does this for sessions active in the last 7 days
  embed [--setup]        Embed all observations for semantic search (on this machine; no AI credits).
                         --setup first installs (or repairs/upgrades) the local embedding runtime
                         (transformers.js, ~330 MB, into $COPILOT_MEM_DATA_DIR/embed). The local model
                         downloads here, never in the background
  remember <title> <text> [--fact F]... [--file F]... [--project P]
                         Save a note to memory (type "note"; never changed by compression). Project
                         defaults to the current repository or directory
  bookmark [--title T] [--back N] [--session ID] [--turn N]
                         Save a Copilot answer word for word, with its question, repository and path.
                         Default: the newest answer of the most recent session (--back 2 = the one
                         before). Bookmarks are found by search from any project
  bookmarks [query]      List bookmarked answers (newest first, or best matches for the query)
  link <project> <project>...
                         Mark projects you work on together (e.g. owner/app owner/api), both ways:
                         session-start context includes a few of their observations, and search
                         with a project covers the linked ones
  unlink <project> <project>...
                         Remove those links
  links                  List linked projects
  viewer [--port N] [--open]
                         Live web dashboard on http://127.0.0.1:${DEFAULT_VIEWER_PORT}

Used by Copilot (installed for you):
  mcp                    Run the recall MCP server (search / timeline / get_observations / remember /
                         bookmark) on stdio
  hook <event>           Handle a Copilot hook (session-start | stop)
  worker                 Background sync + capped compression (started by hooks)

Settings: $COPILOT_MEM_DATA_DIR/settings.json (created by install; an environment variable of the
same name overrides it; "" = default). Changes apply to new Copilot sessions without reinstalling.
  COPILOT_MEM_SOURCE_DB       Copilot session store (default $COPILOT_HOME/session-store.db)
  COPILOT_MEM_MODEL           Model used to compress turns (default gpt-5-mini)
  COPILOT_MEM_AUTO_COMPRESS   Copilot calls per background run, compression then session summaries (default 5; 0 = sync only)
  COPILOT_MEM_COPILOT_BIN     Copilot CLI binary (default: copilot on PATH; install records it)
  COPILOT_MEM_EMBED_PROVIDER  Semantic search embeddings: local (default; in-process, needs embed --setup) | ollama |
                              openai (any OpenAI-compatible endpoint) | voyage | cohere | jina | off. Cloud
                              providers receive the memory text
  COPILOT_MEM_EMBED_MODEL     Embedding model (default per provider: Xenova/bge-small-en-v1.5, bge-m3,
                              text-embedding-3-small, voyage-4-lite, embed-v4.0, jina-embeddings-v5-text-small;
                              off = keyword search only). Other local models: Xenova/all-MiniLM-L6-v2 (smaller,
                              English), Xenova/multilingual-e5-small or Xenova/bge-m3 (~100 languages)
  COPILOT_MEM_EMBED_URL       Provider endpoint (default per provider; ollama: http://localhost:11434;
                              local: a Hugging Face mirror, default https://huggingface.co)
  COPILOT_MEM_EMBED_API_KEY   API key for openai, voyage, cohere or jina
Environment only:
  COPILOT_HOME                Copilot CLI home (default ~/.copilot)
  COPILOT_MEM_DATA_DIR        copilot-mem data directory, where settings.json lives (default ~/.copilot-mem)`;

/** Waits for Copilot to finish writing the turn that triggered the hook. */
const WORKER_DEBOUNCE_MS = 3000;

function stringFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value) throw new Error(`${flag} needs a value`);
  return value;
}

/**
 * Runs `copilot-mem compress --background` as its own detached process, so it outlives the
 * caller (e.g. a restarted viewer). Resolves when it exits, if the caller is still around.
 */
function spawnCompress(limit: number, project?: string): Promise<void> {
  const args = [process.argv[1], 'compress', '--background', '--limit', String(limit)];
  if (project !== undefined) args.push('--project', project);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`compress exited with code ${code}`))));
    child.unref();
  });
}

function parseIntFlag(args: string[], flag: string, min: number): number | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const value = Number(args[i + 1]);
  if (!Number.isInteger(value) || value < min) throw new Error(`${flag} needs an integer >= ${min}`);
  return value;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function installContext(): InstallContext {
  return {
    copilotHome: copilotHome(),
    dataDir: dataDir(),
    copilotBinName: copilotBin(),
    runtime: process.execPath,
    entry: process.argv[1],
    env: process.env,
    log: (m) => console.log(m),
  };
}

function startWorker(): void {
  requestWork(workerFiles(dataDir()));
  spawn(process.execPath, [process.argv[1], 'worker'], { detached: true, stdio: 'ignore' }).unref();
}

function embedStats(store: MemoryStore): { model: string; embedded: number } | 'off' {
  const embedder = embedderOrWarn((m) => console.error(m));
  return embedder ? { model: embedder.model, embedded: store.embeddingCount(embedder.model) } : 'off';
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case 'install': {
      install(installContext(), pkg.version);
      // Mirror existing history now (free); compression happens in the background or via `compress`.
      let reader: SessionStoreReader | undefined;
      const store = new MemoryStore(memoryDbPath());
      try {
        reader = new SessionStoreReader(sourceDbPath());
        const result = syncOnce(reader, store, { sessionStateDir: sessionStateDir() });
        const { pendingTurns } = store.counts();
        console.log(`Synced ${result.sessions} session(s); ${pendingTurns} turn(s) await compression.`);
        console.log(
          `Done. New Copilot CLI sessions will load copilot-mem automatically.\n` +
            `Backfill older history with \`copilot-mem compress\` (spends AI credits with ${compressorModel()}; \`copilot-mem stats\` shows the actual usage).`,
        );
        if (embedderOrWarn((m) => console.error(m))?.model.startsWith('local:') && !localRuntimeInstalled()) {
          console.log('For meaning-based search, run `copilot-mem embed --setup` once (installs a local model runtime, ~350 MB).');
        }
      } catch (error) {
        console.log(`Installed, but the initial sync failed: ${(error as Error).message}`);
      } finally {
        reader?.close();
        store.close();
      }
      return 0;
    }
    case 'uninstall':
      uninstall(installContext());
      return 0;
    case 'status':
      console.log(JSON.stringify(collectStatus(pkg.version), null, 2));
      return 0;
    case 'sync': {
      const reader = new SessionStoreReader(sourceDbPath());
      const store = new MemoryStore(memoryDbPath());
      try {
        console.log(JSON.stringify(syncOnce(reader, store, { full: args.includes('--full'), sessionStateDir: sessionStateDir() }), null, 2));
      } finally {
        reader.close();
        store.close();
      }
      return 0;
    }
    case 'compress': {
      const maxBatches = parseIntFlag(args, '--limit', 1);
      const project = stringFlag(args, '--project');
      if (args.includes('--background')) {
        const files = workerFiles(dataDir());
        mkdirSync(dirname(files.log), { recursive: true, mode: 0o700 });
        const log = createFileLogger(files.log);
        try {
          await compressRound(files, maxBatches ?? Number.MAX_SAFE_INTEGER, log, project);
          return 0;
        } catch (error) {
          log(`compress failed: ${(error as Error).message}`);
          return 1;
        }
      }
      const model = compressorModel();
      const store = new MemoryStore(memoryDbPath());
      try {
        const run = createCopilotRunner({ model, bin: copilotBin(), sourceHome: copilotHome(), workDir: join(dataDir(), 'compressor') });
        const result = await withLock(workerFiles(dataDir()).compressLock, () =>
          compressPending(store, run, { model, maxBatches, project, log: (m) => console.error(m) }),
        );
        if (!result) throw new Error('another compression (background worker or compress) is running; try again shortly');
        console.log(JSON.stringify(result, null, 2));
      } finally {
        store.close();
      }
      return 0;
    }
    case 'summarize': {
      const maxCalls = parseIntFlag(args, '--limit', 1) ?? 10;
      const sessionId = stringFlag(args, '--session');
      const model = compressorModel();
      const store = new MemoryStore(memoryDbPath());
      try {
        const run = createCopilotRunner({ model, bin: copilotBin(), sourceHome: copilotHome(), workDir: join(dataDir(), 'compressor') });
        const result = await withLock(workerFiles(dataDir()).compressLock, () =>
          summarizeSessions(store, run, { model, maxCalls, sessionId, log: (m) => console.error(m) }),
        );
        if (!result) throw new Error('another compression (background worker or compress) is running; try again shortly');
        console.log(JSON.stringify(result, null, 2));
      } finally {
        store.close();
      }
      return 0;
    }
    case 'settings': {
      const { path, exists, settings } = describeSettings();
      console.log(`${path}${exists ? '' : ' (not created yet; `copilot-mem install` creates it)'}`);
      for (const [key, { value, source }] of Object.entries(settings)) {
        console.log(`  ${key.padEnd(27)}${(value || '""').padEnd(36)}(${source})`);
      }
      return 0;
    }
    case 'stats': {
      const store = new MemoryStore(memoryDbPath());
      try {
        console.log(JSON.stringify({ path: memoryDbPath(), ...store.counts(), sessionSummaries: store.summaryCount(), duplicatePairs: store.duplicateCount(), toolEvents: store.toolEventCount(), embeddings: embedStats(store), compression: store.compressStats() }, null, 2));
      } finally {
        store.close();
      }
      return 0;
    }
    case 'dedup': {
      const store = new MemoryStore(memoryDbPath());
      try {
        const found = store.scanDuplicates(new Date().toISOString());
        console.log(`Checked ${found.observations} observations in ${found.projects} project(s): ${found.candidates} new possible duplicate pair(s), ${store.duplicateCount()} recorded in total.`);
      } finally {
        store.close();
      }
      return 0;
    }
    case 'embed': {
      if (args.includes('--setup') && !setupLocalRuntime()) {
        throw new Error('could not install the local embedding runtime (see the output above)');
      }
      const embedder = embedderFromSettings();
      if (!embedder) throw new Error('semantic search is off (COPILOT_MEM_EMBED_PROVIDER or COPILOT_MEM_EMBED_MODEL is "off")');
      if (embedder.model.startsWith('local:') && !localRuntimeInstalled()) {
        throw new Error('the local embedding runtime is not installed; run `copilot-mem embed --setup`');
      }
      await embedder.prepare?.((m) => console.log(m));
      const store = new MemoryStore(memoryDbPath());
      try {
        const started = Date.now();
        const n = await embedPending(store, embedder);
        console.log(`Embedded ${n} observation(s) with ${embedder.model} in ${((Date.now() - started) / 1000).toFixed(1)}s; ${store.embeddingCount(embedder.model)} total.`);
      } finally {
        store.close();
      }
      return 0;
    }
    case 'remember': {
      const positional: string[] = [];
      const facts: string[] = [];
      const files: string[] = [];
      let project: string | undefined;
      for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (flag === '--fact' || flag === '--file' || flag === '--project') {
          const value = args[++i];
          if (value === undefined) throw new Error(`${flag} needs a value`);
          if (flag === '--fact') facts.push(value);
          else if (flag === '--file') files.push(value);
          else project = value;
        } else positional.push(flag);
      }
      if (positional.length !== 2) throw new Error('usage: copilot-mem remember <title> <text> [--fact F]... [--file F]... [--project P]');
      const store = new MemoryStore(memoryDbPath());
      try {
        const saved = rememberNote(store, { title: positional[0], text: positional[1], facts, files, project }, process.cwd());
        console.log(`Saved note #${saved.id} for ${saved.project}.`);
      } finally {
        store.close();
      }
      return 0;
    }
    case 'bookmark': {
      const turn = parseIntFlag(args, '--turn', 0);
      const back = parseIntFlag(args, '--back', 1);
      // Run from inside a Copilot session, the newest exchange is the request to bookmark, so skip it.
      const inSession = process.env.COPILOT_AGENT_SESSION_ID;
      const sessionId = stringFlag(args, '--session') ?? inSession ?? latestSession(sessionStateDir());
      if (!sessionId) throw new Error('no Copilot session found; pass --session ID');
      const store = new MemoryStore(memoryDbPath());
      try {
        const saved = bookmarkAnswer(store, {
          sessionId,
          turnIndex: turn,
          back,
          title: stringFlag(args, '--title'),
          skipCurrent: sessionId === inSession,
          sessionStateDir: sessionStateDir(),
        });
        console.log(`${saved.created ? 'Bookmarked' : saved.title === stringFlag(args, '--title') ? 'Already bookmarked; renamed' : 'Already bookmarked'}: #${saved.id} "${saved.title}" (${saved.project}, session ${sessionId}, turn ${saved.turnIndex}).`);
      } finally {
        store.close();
      }
      return 0;
    }
    case 'bookmarks': {
      const query = args.filter((a) => !a.startsWith('--')).join(' ').trim() || undefined;
      const store = new MemoryStore(memoryDbPath());
      try {
        const found = store.searchObservations({ query, type: 'bookmark', limit: 100, offset: 0 });
        if (!found.length) console.log(query ? `No bookmarks match "${query}".` : 'No bookmarks yet.');
        for (const o of found) console.log(`#${o.id}  ${o.occurred_at.slice(0, 10)}  ${o.title}  [${o.repository ?? o.cwd ?? 'unknown project'}]`);
      } finally {
        store.close();
      }
      return 0;
    }
    case 'link':
    case 'unlink':
    case 'links': {
      const store = new MemoryStore(memoryDbPath());
      try {
        if (command === 'link') console.log(linkProjects(store, args, new Date().toISOString()));
        else if (command === 'unlink') console.log(unlinkProjects(store, args));
        else console.log(listLinks(store));
      } finally {
        store.close();
      }
      return 0;
    }
    case 'viewer': {
      const port = parseIntFlag(args, '--port', 0) ?? DEFAULT_VIEWER_PORT;
      const log = createFileLogger(workerFiles(dataDir()).log);
      const viewer = await startViewer({
        port,
        files: workerFiles(dataDir()),
        openStore: () => new MemoryStore(memoryDbPath()),
        status: () => collectStatus(pkg.version),
        compress: spawnCompress,
        log,
        embedQuery: createQueryEmbedder(embedderOrWarn(log)),
        settings: () => settingsReport(),
      });
      console.log(`copilot-mem viewer: ${viewer.url}  (Ctrl-C to stop)`);
      if (args.includes('--open')) {
        spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [viewer.url], { stdio: 'ignore', detached: true })
          .on('error', () => {})
          .unref();
      }
      const stop = () => void viewer.close().then(() => process.exit(0));
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      await new Promise(() => {});
      return 0;
    }
    case 'mcp': {
      // stdout carries the MCP protocol; never print to it here.
      const store = new MemoryStore(memoryDbPath());
      const server = createRecallServer(store, pkg.version, createQueryEmbedder(embedderOrWarn((m) => console.error(m))), {
        id: process.env.COPILOT_AGENT_SESSION_ID,
        stateDir: sessionStateDir(),
      });
      server.onclose = () => store.close();
      await server.connect(new StdioServerTransport());
      return 0;
    }
    case 'hook': {
      // Hooks fail open: an error is logged, never shown to the Copilot session.
      const log = createFileLogger(workerFiles(dataDir()).log);
      try {
        const output = runHook(args[0], await readStdin(), { openStore: () => new MemoryStore(memoryDbPath()), startWorker });
        if (output) console.log(output);
      } catch (error) {
        log(`hook ${args[0]} failed: ${(error as Error).message}`);
      }
      return 0;
    }
    case 'worker': {
      const files = workerFiles(dataDir());
      const log = createFileLogger(files.log);
      await runWorker(files, { debounceMs: WORKER_DEBOUNCE_MS, task: () => backgroundRound(files, log), log });
      return 0;
    }
    case undefined:
    case '-h':
    case '--help':
      console.log(USAGE);
      return 0;
    case '-v':
    case '--version':
      console.log(pkg.version);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`copilot-mem: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
