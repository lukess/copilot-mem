import type { SessionStoreReader } from './session-store-reader.ts';
import type { MemoryStore } from '../storage/memory-store.ts';
import { syncToolEvents } from './tool-events.ts';

// Copilot writes a turn when it is finalized, stamping `timestamp` with the write time.
// Re-reading a window behind the watermark is cheap (upserts are hash-idempotent) and
// absorbs late or out-of-order writes. `--full` rescans everything as a safety net.
export const OVERLAP_MS = 10 * 60 * 1000;
export const WATERMARK_KEY = 'turns_watermark';
// The watermark is only meaningful for the store it came from; a different source gets a full scan.
export const SOURCE_KEY = 'source_db';

export interface SyncResult {
  sessions: number;
  turnsRead: number;
  inserted: number;
  updated: number;
  unchanged: number;
  watermark: string | null;
  /** New mirrored session_files / session_refs rows. */
  newFiles: number;
  newRefs: number;
  /** New tool calls mirrored from events.jsonl (only when `sessionStateDir` is given). */
  newToolEvents: number;
}

export function syncOnce(
  reader: Pick<SessionStoreReader, 'path' | 'readSessions' | 'readTurns' | 'readFiles' | 'readRefs'>,
  store: MemoryStore,
  options: { full?: boolean; sessionStateDir?: string } = {},
): SyncResult {
  const sameSource = store.getState(SOURCE_KEY) === reader.path;
  const previous = sameSource ? store.getState(WATERMARK_KEY) : undefined;
  const since = options.full || previous === undefined
    ? undefined
    : new Date(Date.parse(previous) - OVERLAP_MS).toISOString();

  const sessions = reader.readSessions();
  const turns = reader.readTurns(since);
  // Small tables (one row per file / ref per session), so they are re-read in full each time.
  const files = reader.readFiles();
  const refs = reader.readRefs();
  const now = new Date().toISOString();
  const result: SyncResult = {
    sessions: sessions.length,
    turnsRead: turns.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    watermark: previous ?? null,
    newFiles: 0,
    newRefs: 0,
    newToolEvents: 0,
  };

  store.transaction(() => {
    for (const session of sessions) store.upsertSession(session, now);
    for (const turn of turns) {
      result[store.upsertTurn(turn, now)]++;
      if (turn.timestamp && (result.watermark === null || turn.timestamp > result.watermark)) {
        result.watermark = turn.timestamp;
      }
    }
    result.newFiles = store.upsertFiles(files);
    result.newRefs = store.upsertRefs(refs);
    if (result.watermark !== null) store.setState(WATERMARK_KEY, result.watermark);
    store.setState(SOURCE_KEY, reader.path);
  });

  if (options.sessionStateDir) result.newToolEvents = syncToolEvents(options.sessionStateDir, store).newToolEvents;
  return result;
}
