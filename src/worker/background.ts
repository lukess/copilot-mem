import { join } from 'node:path';
import { SessionStoreReader } from '../capture/session-store-reader.ts';
import { syncOnce } from '../capture/sync.ts';
import { compressPending, formatCallCost } from '../compress/compressor.ts';
import { createCopilotRunner } from '../compress/copilot-runner.ts';
import { AUTO_SUMMARY_WINDOW_MS, summarizeSessions } from '../compress/summary.ts';
import { autoCompressLimit, compressorModel, copilotBin, copilotHome, dataDir, memoryDbPath, sessionStateDir, sourceDbPath } from '../config.ts';
import { embedderOrWarn, embedPending } from '../search/embeddings.ts';
import { MemoryStore } from '../storage/memory-store.ts';
import { withLock } from './lock.ts';
import type { WorkerFiles } from './worker.ts';

/** Observations embedded per round; a full backfill is `copilot-mem embed`. */
const EMBED_PER_ROUND = 500;
const EMBED_ERROR_KEY = 'embed_error';

/** One worker round: mirror new turns, then compress and summarize up to the auto-compress cap. */
export function backgroundRound(files: WorkerFiles, log: (message: string) => void): Promise<void> {
  return compressRound(files, autoCompressLimit(), log, undefined, true);
}

/**
 * Mirror new turns, then make at most `limit` Copilot calls (under compress.lock) on pending turns,
 * optionally only for one project. With `summarize`, calls left over go to summaries of recently
 * finished sessions.
 */
export async function compressRound(
  files: WorkerFiles,
  limit: number,
  log: (message: string) => void,
  project?: string,
  summarize = false,
): Promise<void> {
  const reader = new SessionStoreReader(sourceDbPath());
  const store = new MemoryStore(memoryDbPath());
  try {
    const sync = syncOnce(reader, store, { sessionStateDir: sessionStateDir() });
    log(`sync: ${sync.inserted} new, ${sync.updated} updated turn(s), ${sync.newToolEvents} tool call(s)`);
    if (limit > 0) {
      const model = compressorModel();
      const run = createCopilotRunner({ model, bin: copilotBin(), sourceHome: copilotHome(), workDir: join(dataDir(), 'compressor') });
      const ran = await withLock(files.compressLock, async () => {
        let calls = 0;
        if (store.counts().pendingTurns > 0) {
          const result = await compressPending(store, run, { model, maxBatches: limit, project, log });
          calls = result.batches + result.failedBatches;
          log(`compress: ${result.turns} turn(s) -> ${result.observations} observation(s)${result.merged ? ` (+${result.merged} merged)` : ''} in ${calls} call(s), ${result.failedBatches} failed (${formatCallCost(result.durationMs, result.credits)})`);
        }
        // Session summaries use whatever is left of this round's call cap.
        if (summarize && calls < limit) {
          const activeSince = new Date(Date.now() - AUTO_SUMMARY_WINDOW_MS).toISOString();
          const summary = await summarizeSessions(store, run, { model, maxCalls: limit - calls, activeSince, log });
          if (summary.calls) log(`summarize: ${summary.summaries} summary(ies), ${summary.skipped} skipped, ${summary.failed} failed in ${summary.calls} call(s) (${formatCallCost(summary.durationMs, summary.credits)})`);
        }
        return true;
      });
      if (!ran && store.counts().pendingTurns > 0) log('compress: skipped, another compression is running');
    }
    await embedRound(store, log);
  } finally {
    reader.close();
    store.close();
  }
}

/** Embeds new observations for semantic search; logs a failure (e.g. ollama not running) once until it changes. */
async function embedRound(store: MemoryStore, log: (message: string) => void): Promise<void> {
  const embedder = embedderOrWarn(log);
  if (!embedder) return;
  try {
    const n = await embedPending(store, embedder, EMBED_PER_ROUND);
    if (n) log(`embed: ${n} observation(s) with ${embedder.model}`);
    if (store.getState(EMBED_ERROR_KEY)) {
      store.setState(EMBED_ERROR_KEY, '');
      log('embed: semantic search available again');
    }
  } catch (error) {
    const message = (error as Error).message;
    if (store.getState(EMBED_ERROR_KEY) !== message) log(`embed: skipped (${message}); search stays keyword-only`);
    store.setState(EMBED_ERROR_KEY, message);
  }
}
