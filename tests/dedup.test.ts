import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { compressPending } from '../src/compress/compressor.ts';
import { classifyTitles, normalizeTitle, TitleCorpus } from '../src/dedup/near-duplicate.ts';
import { callRecallTool } from '../src/mcp/recall-server.ts';
import { MemoryStore, type Observation } from '../src/storage/memory-store.ts';

const obs = (title: string, narrative = 'n'): Observation => ({ type: 'discovery', title, narrative, facts: [], files: [] });

/** Filler titles so shared words like "worker" are common and the IDF is realistic. */
const FILLER = Array.from({ length: 30 }, (_, i) => `worker ${['log', 'restart', 'retry'][i % 3]} note ${i}`);

describe('classifyTitles', () => {
  const corpus = new TitleCorpus([
    ...FILLER,
    'Viewer restart kills compression worker',
    'Viewer restart kills compression worker note',
    'Fix race in example-api handler',
    'Fix race in example-plugin handler',
  ]);

  test('exact tier ignores case, punctuation and spacing, but empty titles never match', () => {
    assert.equal(normalizeTitle('  Use  GPT-5-mini!! '), 'use gpt 5 mini');
    assert.equal(classifyTitles('Use gpt-5-mini', 'use GPT 5 mini.', corpus).tier, 'exact');
    assert.equal(classifyTitles('!!!', '???', corpus).tier, 'none');
  });

  test('near-duplicate titles become candidates', () => {
    const c = classifyTitles('Viewer restart kills compression worker', 'Viewer restart kills compression worker note', corpus);
    assert.equal(c.tier, 'candidate');
    assert.ok(c.score >= 0.8 && c.score < 1);
  });

  test('a rare token on only one side vetoes the candidate', () => {
    assert.equal(classifyTitles('Viewer restart kills compression worker', 'Viewer restart kills compression worker crash', corpus).tier, 'none');
    const c = classifyTitles('Fix race in example-api handler', 'Fix race in example-plugin handler', corpus);
    assert.equal(c.tier, 'none');
  });

  test('a single shared token is not enough', () => {
    assert.equal(classifyTitles('compression', 'compression stats', corpus).tier, 'none');
  });
});

describe('dedup in the store', () => {
  let dir: string;
  let store: MemoryStore;

  const session = (id: string, repository: string) =>
    store.upsertSession({ id, cwd: '/r', repository, branch: null, host_type: null, summary: null, created_at: null, updated_at: null }, 'x');
  const turn = (id: string, index: number, timestamp: string) =>
    store.upsertTurn({ session_id: id, turn_index: index, user_message: 'u', assistant_response: 'a', timestamp }, 'x');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copilot-mem-'));
    store = new MemoryStore(join(dir, 'memory.db'));
    session('s1', 'acme/api');
    session('s2', 'acme/api');
    session('other', 'acme/web');
    turn('s1', 0, '2026-01-01T00:00:00.000Z');
    turn('s2', 0, '2026-01-05T00:00:00.000Z');
    turn('other', 0, '2026-01-06T00:00:00.000Z');
    store.completeBatch('s1', [0], [...FILLER.map((t) => obs(t)), obs('Use gpt-5-mini for compression')], 'm', 'now');
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('an exact-title repeat in the same project bumps the existing observation instead of inserting', () => {
    const before = store.counts().observations;
    const result = store.completeBatch('s2', [0], [obs('use GPT-5-mini for compression.', 'newer')], 'm', 'now');
    assert.deepEqual(result, { inserted: 0, merged: 1, candidates: 0 });
    assert.equal(store.counts().observations, before);
    const [id] = store.searchObservations({ query: 'gpt', limit: 5, offset: 0 }).map((o) => o.id);
    const [detail] = store.getObservations([id]);
    assert.equal(detail.occurrences, 2);
    assert.equal(detail.last_seen_at, '2026-01-05T00:00:00.000Z');
    assert.equal(detail.narrative, 'n', 'the original observation is kept');
    assert.equal(store.pendingTurns(3).length, 1, 'merged turns still count as compressed');
  });

  test('the same title in another project is a separate observation', () => {
    assert.deepEqual(store.completeBatch('other', [0], [obs('Use gpt-5-mini for compression')], 'm', 'now'), {
      inserted: 1, merged: 0, candidates: 0,
    });
  });

  test('near duplicates are stored and linked both ways, and shown by get_observations', () => {
    const result = store.completeBatch('s2', [0], [obs('Use gpt-5-mini for compression worker')], 'm', 'now');
    assert.deepEqual(result, { inserted: 1, merged: 0, candidates: 1 });
    const [older, newer] = store.searchObservations({ query: 'gpt', limit: 5, offset: 0 }).map((o) => o.id).sort((a, b) => a - b);
    const [a, b] = store.getObservations([older, newer]);
    assert.deepEqual(a.similar.map((s) => s.id), [newer]);
    assert.deepEqual(b.similar.map((s) => s.id), [older]);
    const text = callRecallTool(store, 'get_observations', { ids: [newer] }).content[0];
    assert.match((text as { text: string }).text, new RegExp(`Possible duplicates: #${older} Use gpt-5-mini for compression \\(0\\.\\d\\d\\)`));
  });

  test('a scan finds pre-existing pairs once and merges nothing', () => {
    // Bypass the insert-time check by using different projects first, then moving the session.
    store.completeBatch('other', [0], [obs('Use gpt-5-mini for compression')], 'm', 'now');
    session('other', 'acme/api');
    const before = store.counts().observations;
    assert.equal(store.scanDuplicates('now').candidates, 1);
    assert.equal(store.scanDuplicates('now').candidates, 0, 'already recorded');
    assert.equal(store.counts().observations, before);
    assert.equal(store.duplicateCount(), 1);
  });

  test('compressPending reports merged observations', async () => {
    turn('s2', 1, '2026-01-05T00:01:00.000Z');
    const logs: string[] = [];
    const result = await compressPending(
      store,
      async () => ({ text: JSON.stringify({ observations: [obs('Use gpt-5-mini for compression'), obs('Brand new thing')] }) }),
      { model: 'm', project: 'acme/api', log: (line) => logs.push(line) },
    );
    assert.equal(result.observations, 1);
    assert.equal(result.merged, 1);
    assert.match(logs.join('\n'), /2 observation\(s\) \[1 merged into existing\]/);
  });
});
