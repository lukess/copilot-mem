import type { CallStatus, MemoryStore, PendingTurn, TurnToolEvent } from '../storage/memory-store.ts';
import type { CopilotReply, CopilotRunner } from './copilot-runner.ts';
import { buildPrompt, CompressorOutputError, formatTurn, parseObservations } from './prompt.ts';

export const MAX_ATTEMPTS = 3;
// Copilot bills per request, so pack each call; a turn is clipped to ~15k chars in formatTurn.
export const BATCH_CHARS = 48_000;

export interface CompressOptions {
  model: string;
  maxBatches?: number;
  /** Only this project's turns (exact projects() key). */
  project?: string;
  log?: (message: string) => void;
}

export interface CompressResult {
  batches: number;
  turns: number;
  /** New observations stored. */
  observations: number;
  /** Observations folded into an existing one with the same title (exact-title dedup). */
  merged: number;
  failedBatches: number;
  durationMs: number;
  /** AI credits Copilot reported for these calls. */
  credits: number;
}

export function formatCallCost(durationMs: number, credits?: number): string {
  return `${(durationMs / 1000).toFixed(1)}s${credits === undefined ? '' : `, ${credits.toFixed(3)} AI credits`}`;
}

/** Splits each session's pending turns into prompt-sized batches, newest session first. */
export function planBatches(
  pending: PendingTurn[],
  batchChars = BATCH_CHARS,
  toolsFor: (turn: PendingTurn) => TurnToolEvent[] = () => [],
): PendingTurn[][] {
  const bySession = new Map<string, PendingTurn[]>();
  for (const turn of pending) {
    const turns = bySession.get(turn.session_id) ?? [];
    turns.push(turn);
    bySession.set(turn.session_id, turns);
  }
  const latest = (turns: PendingTurn[]) => turns.reduce((max, t) => ((t.timestamp ?? '') > max ? (t.timestamp ?? '') : max), '');
  const sessions = [...bySession.values()].sort((a, b) => latest(b).localeCompare(latest(a)));

  const batches: PendingTurn[][] = [];
  for (const turns of sessions) {
    let batch: PendingTurn[] = [];
    let size = 0;
    for (const turn of turns) {
      const turnSize = formatTurn(turn, toolsFor(turn)).length;
      if (batch.length > 0 && size + turnSize > batchChars) {
        batches.push(batch);
        batch = [];
        size = 0;
      }
      batch.push(turn);
      size += turnSize;
    }
    if (batch.length > 0) batches.push(batch);
  }
  return batches;
}

/** Each pending turn's tool calls, loaded once per session. */
function toolLookup(store: MemoryStore, pending: PendingTurn[]): (turn: PendingTurn) => TurnToolEvent[] {
  const byTurn = new Map<string, TurnToolEvent[]>();
  const ranges = new Map<string, [number, number]>();
  for (const t of pending) {
    const [lo, hi] = ranges.get(t.session_id) ?? [t.turn_index, t.turn_index];
    ranges.set(t.session_id, [Math.min(lo, t.turn_index), Math.max(hi, t.turn_index)]);
  }
  for (const [sessionId, [lo, hi]] of ranges) {
    for (const e of store.toolEventsForTurns(sessionId, lo, hi)) {
      const key = `${sessionId}\0${e.turn_index}`;
      const list = byTurn.get(key);
      if (list) list.push(e);
      else byTurn.set(key, [e]);
    }
  }
  return (turn) => byTurn.get(`${turn.session_id}\0${turn.turn_index}`) ?? [];
}

/**
 * Compresses pending turns into observations. Bad model output counts against the batch's
 * attempts; any other failure (auth, timeout, missing binary) aborts the run without
 * penalizing turns, so a logged-out Copilot can't permanently skip them.
 */
export async function compressPending(store: MemoryStore, run: CopilotRunner, options: CompressOptions): Promise<CompressResult> {
  const log = options.log ?? (() => {});
  const pending = store.pendingTurns(MAX_ATTEMPTS, options.project);
  const toolsFor = toolLookup(store, pending);
  const batches = planBatches(pending, BATCH_CHARS, toolsFor).slice(0, options.maxBatches ?? Infinity);
  const result: CompressResult = { batches: 0, turns: 0, observations: 0, merged: 0, failedBatches: 0, durationMs: 0, credits: 0 };

  for (const [i, batch] of batches.entries()) {
    const sessionId = batch[0].session_id;
    const turnIndexes = batch.map((t) => t.turn_index);
    const label = `[${i + 1}/${batches.length}] session ${sessionId} turns ${turnIndexes[0]}-${turnIndexes.at(-1)}`;
    const prompt = buildPrompt(batch, toolsFor);
    const startedAt = new Date();
    const record = (status: CallStatus, observations: number, reply?: CopilotReply) => {
      const durationMs = Date.now() - startedAt.getTime();
      const credits = reply?.usage === undefined ? undefined : reply.usage.nanoAiu / 1e9;
      store.recordCall({
        startedAt: startedAt.toISOString(), durationMs, sessionId, model: options.model, status,
        turns: batch.length, observations, promptChars: prompt.length, usage: reply?.usage,
      });
      result.durationMs += durationMs;
      result.credits += credits ?? 0;
      return formatCallCost(durationMs, credits);
    };

    let reply: CopilotReply;
    try {
      reply = await run(prompt);
    } catch (error) {
      record('error', 0);
      throw error;
    }
    try {
      const observations = parseObservations(reply.text);
      const saved = store.completeBatch(sessionId, turnIndexes, observations, options.model, new Date().toISOString());
      const cost = record('ok', observations.length, reply);
      result.batches++;
      result.turns += batch.length;
      result.observations += saved.inserted;
      result.merged += saved.merged;
      const dedup = [saved.merged && `${saved.merged} merged into existing`, saved.candidates && `${saved.candidates} possible duplicate(s)`]
        .filter(Boolean)
        .join(', ');
      log(`${label}: ${observations.length} observation(s)${dedup ? ` [${dedup}]` : ''} (${cost})`);
    } catch (error) {
      if (!(error instanceof CompressorOutputError)) throw error;
      store.failBatch(sessionId, turnIndexes);
      const cost = record('bad_output', 0, reply);
      result.failedBatches++;
      log(`${label}: ${error.message} (${cost})`);
    }
  }
  return result;
}
