import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { appendReinforcement, parseReinforcementDates, rankByStrength, reinforcementStrength, strength } from '../src/rank/reinforcement.ts';
import { MemoryStore, MIGRATIONS, type Observation } from '../src/storage/memory-store.ts';

const TODAY = new Date('2026-06-30T12:00:00.000Z');

describe('reinforcement strength', () => {
  test('re-confirmed observations outrank equally old ones, decaying with age', () => {
    const plain = { occurred_at: '2026-01-01T00:00:00.000Z', reinforcement_dates: [] };
    const reinforced = { ...plain, reinforcement_dates: ['2026-06-29'] };
    const staleReinforced = { ...plain, reinforcement_dates: ['2026-02-01'] };
    assert.ok(strength(reinforced, TODAY) > strength(staleReinforced, TODAY));
    assert.ok(strength(staleReinforced, TODAY) > strength(plain, TODAY));
    // The occurrence day itself is not a reinforcement.
    assert.equal(strength({ ...plain, reinforcement_dates: ['2026-01-01'] }, TODAY), strength(plain, TODAY));
    // The search boost ignores recency: never re-confirmed means no boost, however new.
    assert.equal(reinforcementStrength({ occurred_at: '2026-06-30T00:00:00.000Z', reinforcement_dates: [] }, TODAY), 0);
    assert.ok(reinforcementStrength(reinforced, TODAY) > reinforcementStrength(staleReinforced, TODAY));
  });

  test('appendReinforcement is idempotent per day and keeps the newest days', () => {
    const dates = ['2026-01-02'];
    assert.equal(appendReinforcement(dates, '2026-01-02'), dates);
    assert.deepEqual(appendReinforcement(['2026-01-03'], '2026-01-01'), ['2026-01-01', '2026-01-03']);
    assert.deepEqual(appendReinforcement(['a1', 'a2', 'a3'], 'a4', 3), ['a2', 'a3', 'a4']);
    assert.deepEqual(parseReinforcementDates('nope'), []);
    assert.deepEqual(parseReinforcementDates('["2026-01-01", 3, ""]'), ['2026-01-01']);
  });

  test('rankByStrength keeps the newest quarter and fills the rest by strength, in pool order', () => {
    const pool = Array.from({ length: 8 }, (_, i) => ({
      name: `n${i}`,
      occurred_at: `2026-06-${String(28 - i * 3).padStart(2, '0')}T00:00:00.000Z`,
      reinforcement_dates: i === 7 ? ['2026-06-29', '2026-06-28', '2026-06-27'] : [],
    }));
    assert.deepEqual(rankByStrength(pool, 4, TODAY).map((p) => p.name), ['n0', 'n1', 'n2', 'n7']);
    assert.equal(rankByStrength(pool, 10, TODAY), pool);
  });
});

describe('reinforcement in the store', () => {
  let dir: string;
  let store: MemoryStore;
  const obs = (title: string): Observation => ({ type: 'discovery', title, narrative: 'n', facts: [], files: [] });
  const compress = (session: string, index: number, timestamp: string, observations: Observation[]) => {
    store.upsertTurn({ session_id: session, turn_index: index, user_message: 'u', assistant_response: 'a', timestamp }, 'x');
    store.completeBatch(session, [index], observations, 'm', timestamp);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copilot-mem-reinforce-'));
    store = new MemoryStore(join(dir, 'memory.db'));
    store.upsertSession({ id: 's', cwd: '/r', repository: 'acme/api', branch: null, host_type: null, summary: null, created_at: null, updated_at: null }, 'x');
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('exact-title merges record the turn day once per day', () => {
    compress('s', 0, '2026-01-01T10:00:00.000Z', [obs('Redis needs socket timeout')]);
    compress('s', 1, '2026-01-05T10:00:00.000Z', [obs('redis needs socket timeout')]);
    compress('s', 2, '2026-01-05T11:00:00.000Z', [obs('Redis needs socket timeout!')]);
    const [info] = store.reinforcementInfo([1]).values();
    assert.deepEqual(info!.reinforcement_dates, ['2026-01-05']);
    assert.equal(store.getObservations([1])[0]!.occurrences, 3);
  });

  test('search ranks a re-confirmed match above an equally relevant one', () => {
    compress('s', 0, '2026-01-01T10:00:00.000Z', [obs('Flaky cache test alpha'), obs('Flaky cache test beta')]);
    for (let i = 1; i <= 4; i++) compress('s', i, `2026-0${i + 1}-01T10:00:00.000Z`, [obs('Flaky cache test alpha')]);
    const titles = store.searchObservations({ query: 'flaky cache', limit: 5, offset: 0 }).map((o) => o.title);
    assert.deepEqual(titles, ['Flaky cache test alpha', 'Flaky cache test beta']);
  });

  test('the boost does not bury a clearly better match', () => {
    compress('s', 0, '2026-01-01T10:00:00.000Z', [obs('Redis timeout'), obs('Timeout in the cache warmer job for reports')]);
    for (let i = 1; i <= 4; i++) compress('s', i, `2026-0${i + 1}-01T10:00:00.000Z`, [obs('Timeout in the cache warmer job for reports')]);
    const titles = store.searchObservations({ query: 'redis timeout', limit: 5, offset: 0 }).map((o) => o.title);
    assert.equal(titles[0], 'Redis timeout');
  });

  test('migration backfills the last re-confirmation day', () => {
    const path = join(dir, 'v9.db');
    const db = new DatabaseSync(path);
    for (const [i, sql] of MIGRATIONS.slice(0, 9).entries()) db.exec(`${sql}; PRAGMA user_version = ${i + 1};`);
    db.exec(`INSERT INTO observations (session_id, first_turn, last_turn, type, title, narrative, model, created_at, occurred_at, occurrences, last_seen_at)
             VALUES ('s', 0, 0, 'bugfix', 'a', 'n', 'm', 'c', '2026-03-01T00:00:00.000Z', 2, '2026-03-04T00:00:00.000Z'),
                    ('s', 0, 0, 'bugfix', 'b', 'n', 'm', 'c', '2026-03-01T00:00:00.000Z', 1, NULL);`);
    db.close();
    const upgraded = new MemoryStore(path);
    try {
      const info = upgraded.reinforcementInfo([1, 2]);
      assert.deepEqual(info.get(1)!.reinforcement_dates, ['2026-03-04']);
      assert.deepEqual(info.get(2)!.reinforcement_dates, []);
    } finally {
      upgraded.close();
    }
  });
});
