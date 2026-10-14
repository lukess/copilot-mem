// Search-quality and speed benchmark for embedding models, on a copy of your memory database.
//
//   bun scripts/bench-embeddings.ts [--queries FILE] [--db FILE] [--embedder local:MODEL|ollama:MODEL]... [--verbose]
//
// FILE (default $COPILOT_MEM_DATA_DIR/bench/queries.json) lists queries and the observation IDs that
// should come back: [{"query": "...", "expect": [123]}]. Write queries in your own words rather than
// the observation's, so they test meaning, not keyword overlap. Each embedder re-embeds every
// observation in the copy (no AI credits; ollama must be running for ollama:*).

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { dataDir, memoryDbPath } from '../src/config.ts';
import { createLocalEmbedder, createOllamaEmbedder, DEFAULT_LOCAL_MODEL, embedPending, type Embedder } from '../src/search/embeddings.ts';
import { MemoryStore } from '../src/storage/memory-store.ts';

const TOP = 10;

interface Case { query: string; expect: number[] }
interface Row { name: string; ranks: (number | null)[]; queryMs?: number; bulkS?: number; loadMs?: number }

const { values: args } = parseArgs({
  options: {
    queries: { type: 'string', default: join(dataDir(), 'bench', 'queries.json') },
    db: { type: 'string', default: memoryDbPath() },
    embedder: { type: 'string', multiple: true, default: [`local:${DEFAULT_LOCAL_MODEL}`, 'ollama:bge-m3'] },
    verbose: { type: 'boolean', default: false },
  },
});

function embedderFor(spec: string): Embedder {
  const [provider, ...rest] = spec.split(':');
  const model = rest.join(':');
  if (provider === 'local') return createLocalEmbedder(model || DEFAULT_LOCAL_MODEL);
  if (provider === 'ollama') return createOllamaEmbedder(model || 'bge-m3');
  throw new Error(`--embedder must be local:MODEL or ollama:MODEL (got "${spec}")`);
}

/** 1-based rank of the first expected ID in the results, or null when it is missing. */
function rankOf(ids: number[], expect: number[]): number | null {
  const i = ids.findIndex((id) => expect.includes(id));
  return i < 0 ? null : i + 1;
}

function summarize(row: Row): string[] {
  const n = row.ranks.length;
  const hit = (k: number) => `${Math.round((100 * row.ranks.filter((r) => r !== null && r <= k).length) / n)}%`;
  const mrr = row.ranks.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / n;
  return [row.name, hit(1), hit(5), hit(TOP), mrr.toFixed(2),
    row.queryMs === undefined ? '-' : `${row.queryMs.toFixed(0)} ms`,
    row.bulkS === undefined ? '-' : `${row.bulkS.toFixed(1)} s`,
    row.loadMs === undefined ? '-' : `${row.loadMs} ms`];
}

function table(rows: string[][]): string {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((cell, c) => (c ? cell.padStart(widths[c]) : cell.padEnd(widths[c]))).join('  ')).join('\n');
}

if (!existsSync(args.queries)) throw new Error(`no queries file at ${args.queries} (see the comment at the top of this script)`);
const cases = JSON.parse(readFileSync(args.queries, 'utf8')) as Case[];

const dir = mkdtempSync(join(tmpdir(), 'copilot-mem-bench-'));
const copy = join(dir, 'memory.db');
try {
  const source = new DatabaseSync(args.db, { readOnly: true });
  source.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
  source.close();
  // Every embedder starts from no vectors, so "embed all" times a full backfill.
  const raw = new DatabaseSync(copy);
  raw.exec('DELETE FROM observation_embeddings');
  raw.close();

  const store = new MemoryStore(copy);
  const expected = [...new Set(cases.flatMap((c) => c.expect))];
  const found = new Set(store.getObservations(expected).map((o) => o.id));
  const missing = expected.filter((id) => !found.has(id));
  if (missing.length) console.warn(`warning: expected IDs not in the database: ${missing.join(', ')}`);
  console.log(`${cases.length} queries, ${store.counts().observations} observations (${args.db})\n`);

  const search = (query: string, vector?: Parameters<MemoryStore['searchObservations']>[1]) =>
    store.searchObservations({ query, limit: TOP, offset: 0 }, vector).map((o) => o.id);

  const rows: Row[] = [{ name: 'keyword only', ranks: cases.map((c) => rankOf(search(c.query), c.expect)) }];
  const detail: Record<string, (number | null)[]> = { keyword: rows[0].ranks };

  for (const spec of args.embedder) {
    const embedder = embedderFor(spec);
    let started = Date.now();
    try {
      await embedder.embed(['warm up'], 120_000, 'query');
    } catch (error) {
      console.warn(`skipping ${spec}: ${(error as Error).message}`);
      continue;
    }
    const loadMs = Date.now() - started;
    started = Date.now();
    await embedPending(store, embedder);
    const bulkS = (Date.now() - started) / 1000;

    const hybrid: (number | null)[] = [];
    const semantic: (number | null)[] = [];
    let queryMs = 0;
    for (const c of cases) {
      const t = performance.now();
      const [values] = await embedder.embed([c.query], 30_000, 'query');
      queryMs += performance.now() - t;
      const vector = { model: embedder.model, values, minScore: embedder.minScore };
      hybrid.push(rankOf(search(c.query, vector), c.expect));
      // A query with no searchable words skips the keyword half: meaning only.
      semantic.push(rankOf(search('?', vector), c.expect));
    }
    rows.push({ name: `${embedder.model} (hybrid)`, ranks: hybrid, queryMs: queryMs / cases.length, bulkS, loadMs });
    rows.push({ name: `${embedder.model} (meaning only)`, ranks: semantic });
    detail[embedder.model] = hybrid;
  }
  store.close();

  console.log(table([['search', 'hit@1', 'hit@5', `hit@${TOP}`, 'MRR', 'query', 'embed all', 'load'], ...rows.map(summarize)]));
  console.log('\nhybrid = keyword + meaning, as copilot-mem searches. hit@k: the expected observation is in the top k.' +
    '\nMRR: mean of 1/rank (1.00 = always first). query: time to embed one search query.');
  if (args.verbose) {
    const names = Object.keys(detail);
    console.log(`\nRank of the expected observation in hybrid search (- = not in the top ${TOP}):\n`);
    console.log(table([['query', ...names], ...cases.map((c, i) => [c.query.slice(0, 60), ...names.map((n) => String(detail[n][i] ?? '-'))])]));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
