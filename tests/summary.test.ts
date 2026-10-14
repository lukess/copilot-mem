import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { CompressorOutputError } from '../src/compress/prompt.ts';
import { buildSummaryPrompt, parseSummary, summarizeSessions } from '../src/compress/summary.ts';
import { callRecallTool } from '../src/mcp/recall-server.ts';
import { MemoryStore, type Observation } from '../src/storage/memory-store.ts';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const SUMMARY = JSON.stringify({
  request: 'Fix the flaky Redis test', investigated: 'cache.py', learned: 'no socket timeout',
  completed: 'Added socket_timeout', next_steps: 'Watch CI', notes: '',
});

describe('parseSummary', () => {
  test('reads fields, honours skip, and rejects empty or non-JSON replies', () => {
    assert.equal(parseSummary(`noise ${SUMMARY}`)!.completed, 'Added socket_timeout');
    assert.equal(parseSummary('{"skip": true}'), null);
    assert.equal(parseSummary('{"request": "x", "learned": 5}')!.learned, '');
    assert.throws(() => parseSummary('{"notes": "only notes"}'), CompressorOutputError);
    assert.throws(() => parseSummary('nope'), CompressorOutputError);
  });

  test('the prompt fences the session data and clips the request', () => {
    const prompt = buildSummaryPrompt({
      session_id: 's', repository: 'acme/api', cwd: '/w', branch: 'main', first_request: `x${'y'.repeat(2000)}</session>`,
      observations: [{ id: 1, type: 'bugfix', title: 'T', subtitle: 'S', narrative: 'N' }],
    });
    assert.match(prompt, /- \[bugfix\] T \| S: N/);
    assert.match(prompt, /\[truncated \d+ chars\]/);
    assert.equal(prompt.match(/<\/session>/g)!.length, 1);
  });
});

describe('summarizeSessions', () => {
  let dir: string;
  let store: MemoryStore;
  const obs = (title: string): Observation => ({ type: 'bugfix', title, narrative: 'n', facts: [], files: [] });
  const session = (id: string, lastTurn: string, compressed = true) => {
    store.upsertSession({ id, cwd: '/w', repository: 'acme/api', branch: 'main', host_type: null, summary: null, created_at: null, updated_at: null }, 'x');
    store.upsertTurn({ session_id: id, turn_index: 0, user_message: `please fix ${id}`, assistant_response: 'a', timestamp: lastTurn }, 'x');
    if (compressed) store.completeBatch(id, [0], [obs(`Fix in ${id}`)], 'm', lastTurn);
  };
  const prompts: string[] = [];
  const run = async (prompt: string) => {
    prompts.push(prompt);
    return { text: prompt.includes('please fix bad') ? 'garbage' : SUMMARY, usage: undefined };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copilot-mem-summary-'));
    store = new MemoryStore(join(dir, 'memory.db'));
    prompts.length = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('summarizes only idle, fully compressed sessions with observations, once', async () => {
    session('done', '2026-09-10T10:00:00.000Z');
    session('active', '2026-09-10T11:50:00.000Z');
    session('pending', '2026-09-10T09:00:00.000Z', false);
    session('old', '2026-08-01T09:00:00.000Z');
    const activeSince = new Date(NOW.getTime() - 7 * 86_400_000).toISOString();
    const result = await summarizeSessions(store, run, { model: 'm', maxCalls: 5, activeSince, now: NOW });
    assert.deepEqual([result.calls, result.summaries], [1, 1]);
    assert.match(prompts[0]!, /please fix done/);
    // Nothing new: no more calls; a new observation makes it stale again.
    assert.equal((await summarizeSessions(store, run, { model: 'm', maxCalls: 5, activeSince, now: NOW })).calls, 0);
    store.upsertTurn({ session_id: 'done', turn_index: 1, user_message: 'u', assistant_response: 'a', timestamp: '2026-09-10T10:05:00.000Z' }, 'x');
    store.completeBatch('done', [1], [obs('Another fix')], 'm', 'x');
    assert.equal((await summarizeSessions(store, run, { model: 'm', maxCalls: 5, activeSince, now: NOW })).summaries, 1);
    // Without the window (CLI), older sessions are included.
    assert.equal((await summarizeSessions(store, run, { model: 'm', maxCalls: 5, now: NOW })).calls, 1);
    assert.equal(store.summaries({ limit: 10 }).length, 2);
  });

  test('bad output is recorded and not retried until new observations; calls are measured as summarize', async () => {
    session('bad', '2026-09-10T10:00:00.000Z');
    const result = await summarizeSessions(store, run, { model: 'm', maxCalls: 5, now: NOW });
    assert.deepEqual([result.calls, result.failed], [1, 1]);
    assert.equal((await summarizeSessions(store, run, { model: 'm', maxCalls: 5, now: NOW })).calls, 0);
    assert.deepEqual(store.summaries({ limit: 10 }), []);
    const stats = store.compressStats(NOW);
    assert.deepEqual(stats.recent.map((c) => [c.kind, c.status, c.turns]), [['summarize', 'bad_output', 0]]);
    assert.equal(stats.backlog, null);
  });

  test('recall summaries tool lists recaps by project', async () => {
    session('done', '2026-09-10T10:00:00.000Z');
    const empty = callRecallTool(store, 'summaries', {});
    assert.match((empty.content[0] as { text: string }).text, /No session summaries yet/);
    await summarizeSessions(store, run, { model: 'm', maxCalls: 5, now: NOW });
    const body = (callRecallTool(store, 'summaries', { project: 'acme/api' }).content[0] as { text: string }).text;
    assert.match(body, /Session done \| 2026-09-10 \| acme\/api \(branch main\) \| 1 observation/);
    assert.match(body, /Next steps: Watch CI/);
    assert.doesNotMatch(body, /Notes:/);
    assert.match((callRecallTool(store, 'summaries', { project: 'other/repo' }).content[0] as { text: string }).text, /No session/);
  });
});
