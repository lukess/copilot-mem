import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { callRecallTool, createRecallServer } from '../src/mcp/recall-server.ts';
import {
  createEmbedder,
  createLocalEmbedder,
  createOllamaEmbedder,
  createQueryEmbedder,
  embedderFromSettings,
  embedderOrWarn,
  embedPending,
  loadLocalRuntime,
  LOCAL_MODELS,
  localModelDownloaded,
  localRuntimeInstalled,
  pruneLocalRuntime,
  normalize,
  type Embedder,
  type LocalRuntime,
  setupLocalRuntime,
} from '../src/search/embeddings.ts';
import { loadSettings } from '../src/config.ts';
import { MemoryStore, type Observation } from '../src/storage/memory-store.ts';
import { startViewer } from '../src/viewer/server.ts';
import { workerFiles } from '../src/worker/worker.ts';

// A fake embedding model: one axis per concept, so "slow" and "Redis hangs" are close although they share no words.
const CONCEPTS = [/redis|cache|timeout|hang|slow|latency/i, /topology|diff/i, /review/i, /shard|cluster/i];

function fakeEmbedder(model = 'fake'): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model,
    calls,
    async embed(texts) {
      calls.push(texts);
      return texts.map((t) => {
        const v = CONCEPTS.map((re) => (re.test(t) ? 1 : 0));
        return normalize([...v, v.some(Boolean) ? 0 : 1]);
      });
    },
  };
}

let dir: string;
let store: MemoryStore;

const obs = (title: string, narrative = ''): Observation => ({ type: 'discovery', title, narrative, facts: [], files: [] });

function addSession(id: string, repository: string, timestamp: string, observations: Observation[]): void {
  store.upsertSession({ id, cwd: `/work/${id}`, repository, branch: 'main', host_type: null, summary: null, created_at: null, updated_at: null }, timestamp);
  store.upsertTurn({ session_id: id, turn_index: 0, user_message: 'u', assistant_response: 'a', timestamp }, timestamp);
  store.completeBatch(id, [0], observations, 'test-model', timestamp);
}

const titles = (rows: { title: string }[]) => rows.map((r) => r.title);
const page = { limit: 10, offset: 0 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-mem-semantic-'));
  store = new MemoryStore(join(dir, 'memory.db'));
  addSession('s1', 'acme/api', '2026-09-01T10:00:00.000Z', [
    obs('Redis pipeline hangs without socket timeout'),
    obs('Keep code reviews read-only'),
  ]);
  addSession('s2', 'acme/api', '2026-09-02T10:00:00.000Z', [obs('Added topology diff script')]);
  addSession('s3', 'acme/web', '2026-09-03T10:00:00.000Z', [obs('Cache warmup added for slow pages')]);
  addSession('s4', 'acme/web', '2026-09-04T10:00:00.000Z', [obs('Renamed the settings page')]);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('embedPending', () => {
  test('embeds every observation once, in batches, and re-embeds for a new model', async () => {
    for (let i = 0; i < 40; i++) addSession(`bulk${i}`, 'acme/bulk', `2026-08-01T10:00:${String(i).padStart(2, '0')}.000Z`, [obs(`Bulk note ${i}`)]);
    const embedder = fakeEmbedder();
    assert.equal(await embedPending(store, embedder), 45);
    assert.deepEqual(embedder.calls.map((c) => c.length), [32, 13]);
    assert.equal(store.embeddingCount('fake'), 45);
    assert.equal(await embedPending(store, embedder), 0, 'nothing left to embed');

    const other = fakeEmbedder('other');
    assert.equal(await embedPending(store, other, 10), 10, 'limit is respected');
    assert.equal(store.embeddingCount('other'), 10);
    assert.equal(store.embeddingCount('fake'), 35, 'a vector is replaced, not duplicated, when the model changes');
  });

  test('embeds title, narrative and facts together', async () => {
    const embedder = fakeEmbedder();
    addSession('s5', 'acme/api', '2026-09-05T10:00:00.000Z', [{ type: 'change', title: 'T', narrative: 'N', facts: ['F1', 'F2'], files: [] }]);
    await embedPending(store, embedder, 1);
    assert.deepEqual(embedder.calls[0], ['T\nN\nF1\nF2']);
  });

  test('an edit or delete during an embedding call drops the stale vector, and the new text is embedded next', async () => {
    const [redis, review] = store.searchObservations({ query: undefined, project: 'acme/api', limit: 10, offset: 0 }).slice(-2);
    let gate!: () => void;
    const slow: Embedder & { calls: string[][] } = {
      ...fakeEmbedder(),
      async embed(texts) {
        this.calls.push(texts);
        if (this.calls.length === 1) await new Promise<void>((resolve) => (gate = resolve));
        return texts.map(() => normalize([1, 0, 0, 0, 0]));
      },
    };
    const running = embedPending(store, slow);
    await new Promise((r) => setTimeout(r, 10));
    store.updateObservation(redis.id, { type: 'bugfix', title: 'Redis: set socket timeout', subtitle: '', narrative: 'new text', facts: [] }, '2026-09-10T00:00:00.000Z');
    store.deleteObservation(review.id);
    gate();
    assert.equal(await running, 4, 'only stored vectors count');
    assert.equal(slow.calls.length, 2, 'the edited observation is embedded again in the same run');
    assert.deepEqual(slow.calls[1], ['Redis: set socket timeout\nnew text']);
    assert.equal(store.embeddingCount('fake'), 4, '3 unchanged + the edited one; none for the deleted one');
  });

  test('deleting an observation deletes its vector', async () => {
    await embedPending(store, fakeEmbedder());
    (store as unknown as { db: { exec(sql: string): void } }).db.exec("DELETE FROM observations WHERE title LIKE 'Redis%'");
    assert.equal(store.embeddingCount('fake'), 4);
  });
});

describe('hybrid search', () => {
  const vectorFor = async (embedder: Embedder, q: string) => ({ model: embedder.model, values: (await embedder.embed([q]))[0] });

  test('finds observations that share meaning but no words with the query', async () => {
    const embedder = fakeEmbedder();
    await embedPending(store, embedder);
    const query = 'latency problems';
    assert.deepEqual(store.searchObservations({ query, ...page }), [], 'keyword search finds nothing');
    const found = titles(store.searchObservations({ query, ...page }, await vectorFor(embedder, query)));
    assert.deepEqual(found.sort(), ['Cache warmup added for slow pages', 'Redis pipeline hangs without socket timeout']);
  });

  test('ranks results matched by both keyword and meaning first', async () => {
    const embedder = fakeEmbedder();
    await embedPending(store, embedder);
    const query = 'slow pages';
    const keyword = titles(store.searchObservations({ query: 'pages', ...page }));
    assert.equal(keyword.length, 2, 'both "pages" observations match the keyword');
    const found = titles(store.searchObservations({ query, ...page }, await vectorFor(embedder, query)));
    assert.equal(found[0], 'Cache warmup added for slow pages');
    assert.ok(found.includes('Redis pipeline hangs without socket timeout'), 'semantic-only match is included');
    assert.ok(found.includes('Renamed the settings page'), 'keyword-only match is included');
    assert.ok(found.indexOf('Renamed the settings page') > 0 && found.indexOf('Redis pipeline hangs without socket timeout') > 0);
  });

  test('drops weak semantic matches and vectors from another model', async () => {
    const embedder = fakeEmbedder();
    await embedPending(store, embedder);
    // Equally (and weakly, cosine ~0.45) close to every concept.
    const unrelated = { model: 'fake', values: normalize([1, 1, 1, 1, 1]) };
    assert.deepEqual(store.searchObservations({ query: 'banana bread', ...page }, unrelated), []);
    const fromOtherModel = { model: 'other', values: (await vectorFor(embedder, 'latency')).values };
    assert.deepEqual(store.searchObservations({ query: 'latency', ...page }, fromOtherModel), []);
  });

  test("a query vector's own threshold replaces the default", async () => {
    await embedPending(store, fakeEmbedder());
    const weak = normalize([1, 1, 1, 1, 1]); // cosine ~0.45 to every observation
    assert.ok(store.searchObservations({ query: 'banana bread', ...page }, { model: 'fake', values: weak, minScore: 0.4 }).length > 0);
    assert.deepEqual(store.searchObservations({ query: 'banana bread', ...page }, { model: 'fake', values: weak, minScore: 0.5 }), []);
  });

  test('applies project filters and paging to semantic matches', async () => {
    const embedder = fakeEmbedder();
    await embedPending(store, embedder);
    const v = await vectorFor(embedder, 'latency');
    assert.deepEqual(titles(store.searchObservations({ query: 'latency', project: 'acme/web', ...page }, v)), ['Cache warmup added for slow pages']);
    const all = titles(store.searchObservations({ query: 'latency', ...page }, v));
    assert.deepEqual(titles(store.searchObservations({ query: 'latency', limit: 1, offset: 1 }, v)), all.slice(1, 2));
  });

  test('a query of only punctuation still searches by meaning', async () => {
    const embedder = fakeEmbedder();
    await embedPending(store, embedder);
    const v = { model: 'fake', values: normalize([0, 0, 0, 1, 0]) };
    assert.deepEqual(store.searchObservations({ query: '???', ...page }), []);
    assert.deepEqual(store.searchObservations({ query: '???', ...page }, v), []);
    addSession('s6', 'acme/api', '2026-09-06T10:00:00.000Z', [obs('Three shards in the cluster')]);
    await embedPending(store, embedder);
    assert.deepEqual(titles(store.searchObservations({ query: '???', ...page }, v)), ['Three shards in the cluster']);
  });
});

describe('query embedder', () => {
  test('falls back to keyword search on failure and backs off for a minute', async () => {
    let now = 0;
    let calls = 0;
    const failing: Embedder = { model: 'x', embed: async () => { calls++; throw new Error('connection refused'); } };
    const embedQuery = createQueryEmbedder(failing, () => now);
    assert.equal(await embedQuery('redis'), undefined);
    assert.equal(await embedQuery('redis'), undefined);
    assert.equal(calls, 1, 'no retry during the backoff');
    now = 61_000;
    await embedQuery('redis');
    assert.equal(calls, 2);
  });

  test('skips blank queries and a missing embedder', async () => {
    const embedder = fakeEmbedder();
    assert.equal(await createQueryEmbedder(embedder)('  '), undefined);
    assert.equal(await createQueryEmbedder(undefined)('redis'), undefined);
    assert.equal(embedder.calls.length, 0);
    assert.equal((await createQueryEmbedder(embedder)('redis'))?.model, 'fake');
  });

  test('embedderFromSettings honours the provider, model and off switches', () => {
    const from = (env: NodeJS.ProcessEnv) => embedderFromSettings(loadSettings(env, join(dir, 'none.json')));
    assert.equal(from({ COPILOT_MEM_EMBED_MODEL: 'off' }), undefined);
    assert.equal(from({ COPILOT_MEM_EMBED_PROVIDER: 'off' }), undefined);
    assert.equal(from({})?.model, 'local:Xenova/bge-small-en-v1.5');
    assert.equal(from({})?.minScore, 0.62);
    assert.equal(from({ COPILOT_MEM_EMBED_MODEL: 'Xenova/all-MiniLM-L6-v2' })?.model, 'local:Xenova/all-MiniLM-L6-v2');
    assert.equal(from({ COPILOT_MEM_EMBED_PROVIDER: 'ollama' })?.model, 'bge-m3');
    assert.equal(from({ COPILOT_MEM_EMBED_PROVIDER: 'ollama', COPILOT_MEM_EMBED_MODEL: 'qwen3-embedding:4b' })?.model, 'qwen3-embedding:4b');
    // Cloud vectors are kept apart from local ones of the same model name.
    assert.equal(from({ COPILOT_MEM_EMBED_PROVIDER: 'openai' })?.model, 'openai:text-embedding-3-small');
    assert.equal(from({ COPILOT_MEM_EMBED_PROVIDER: 'voyage', COPILOT_MEM_EMBED_API_KEY: 'k' })?.model, 'voyage:voyage-4-lite');
    assert.throws(() => from({ COPILOT_MEM_EMBED_PROVIDER: 'cohere' }), /COPILOT_MEM_EMBED_API_KEY is required for the cohere/);
    assert.throws(() => from({ COPILOT_MEM_EMBED_PROVIDER: 'chroma' }), /must be one of local, ollama, openai, voyage, cohere, jina or off/);
    const logs: string[] = [];
    assert.equal(embedderOrWarn((m) => logs.push(m), loadSettings({ COPILOT_MEM_EMBED_PROVIDER: 'jina' }, join(dir, 'none.json'))), undefined);
    assert.match(logs[0], /semantic search off: COPILOT_MEM_EMBED_API_KEY is required for the jina/);
  });
});

describe('local embedder', () => {
  /** `cached: false` acts like transformers.js without the model files: loading needs a download. */
  function fakeRuntime(options: { fail?: number; delayMs?: number; cached?: boolean } = {}) {
    const seen = {
      loads: 0,
      pipelines: [] as { model: string; dtype: string }[],
      calls: [] as { texts: string[]; pooling: string }[],
      remote: [] as { allowed: boolean; host: string }[],
    };
    let failures = options.fail ?? 0;
    let cached = options.cached ?? true;
    const load = async (): Promise<LocalRuntime> => {
      seen.loads++;
      if (failures-- > 0) throw new Error('runtime missing');
      const env = { cacheDir: '', allowRemoteModels: true, remoteHost: 'https://huggingface.co/' };
      return {
        env,
        async pipeline(_task, model, { dtype, progress_callback }) {
          seen.remote.push({ allowed: env.allowRemoteModels, host: env.remoteHost });
          if (!cached) {
            if (!env.allowRemoteModels) throw new Error('local_files_only');
            for (const loaded of [0, 15, 55, 100]) progress_callback?.({ status: 'progress_total', progress: loaded, loaded: loaded * 1e6, total: 100e6 });
            cached = true;
          }
          seen.pipelines.push({ model, dtype });
          return async (texts, { pooling }) => {
            seen.calls.push({ texts, pooling });
            if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
            return { tolist: () => texts.map((_, i) => [3, 4 * (i + 1)]) };
          };
        },
      };
    };
    return { seen, load };
  }

  test('loads the model once, adds the prefixes and pooling the model expects, returns unit vectors', async () => {
    const { seen, load } = fakeRuntime();
    const e = createLocalEmbedder('Xenova/multilingual-e5-small', load);
    assert.equal(e.model, 'local:Xenova/multilingual-e5-small');
    assert.equal(e.minScore, LOCAL_MODELS['Xenova/multilingual-e5-small'].minScore);
    const [v] = await e.embed(['Redis hangs']);
    assert.deepEqual([...v].map((x) => +x.toFixed(2)), [0.6, 0.8]);
    await e.embed(['slow'], undefined, 'query');
    assert.deepEqual(seen.calls, [{ texts: ['passage: Redis hangs'], pooling: 'mean' }, { texts: ['query: slow'], pooling: 'mean' }]);
    assert.deepEqual(seen.pipelines, [{ model: 'Xenova/multilingual-e5-small', dtype: 'q8' }]);
    assert.equal(seen.loads, 1);
  });

  test('bge uses CLS pooling and an instruction on queries only; unknown models get mean pooling and the default threshold', async () => {
    const { seen, load } = fakeRuntime();
    const bge = createLocalEmbedder(undefined, load);
    await bge.embed(['doc']);
    await bge.embed(['q'], undefined, 'query');
    assert.deepEqual(seen.calls, [
      { texts: ['doc'], pooling: 'cls' },
      { texts: ['Represent this sentence for searching relevant passages: q'], pooling: 'cls' },
    ]);
    const other = createLocalEmbedder('someone/model', load);
    assert.equal(other.minScore, 0.5);
    await other.embed(['x']);
    assert.equal(seen.calls.at(-1)?.pooling, 'mean');
  });

  test('a failed load is retried on the next call, and a slow model times out', async () => {
    const { seen, load } = fakeRuntime({ fail: 1 });
    const e = createLocalEmbedder(undefined, load);
    await assert.rejects(e.embed(['a']), /runtime missing/);
    assert.equal((await e.embed(['a'])).length, 1);
    assert.equal(seen.loads, 2);
    const slow = createLocalEmbedder(undefined, fakeRuntime({ delayMs: 200 }).load);
    await assert.rejects(slow.embed(['a'], 20), /local embedding timed out after 20 ms/);
  });

  test('only prepare() downloads: with progress, no time limit, and the model stays loaded for embedding', async () => {
    const { seen, load } = fakeRuntime({ cached: false });
    const e = createLocalEmbedder(undefined, load);
    // Background callers (worker, MCP server, viewer) must not start a download they may cut off.
    await assert.rejects(e.embed(['a']), /local model Xenova\/bge-small-en-v1.5 is not downloaded; run `copilot-mem embed` \(local_files_only\)/);
    const logs: string[] = [];
    await e.prepare!((m) => logs.push(m));
    assert.deepEqual(logs, [
      'Downloading Xenova/bge-small-en-v1.5: 0% (0 of 100 MB)',
      'Downloading Xenova/bge-small-en-v1.5: 10% (15 of 100 MB)',
      'Downloading Xenova/bge-small-en-v1.5: 50% (55 of 100 MB)',
      'Downloading Xenova/bge-small-en-v1.5: 100% (100 of 100 MB)',
    ]);
    assert.deepEqual(seen.remote.map((r) => r.allowed), [false, false, true], 'prepare tries the cache before downloading');
    assert.equal((await e.embed(['a'])).length, 1);
    assert.equal(seen.loads, 3, 'embedding reuses the prepared model');
  });

  test('prepare() on a cached model loads it offline without "Downloading" messages', async () => {
    const { seen, load } = fakeRuntime();
    const logs: string[] = [];
    await createLocalEmbedder(undefined, load).prepare!((m) => logs.push(m));
    assert.deepEqual(logs, []);
    assert.deepEqual(seen.remote.map((r) => r.allowed), [false]);
  });

  test('a configured URL replaces the Hugging Face host', async () => {
    const { seen, load } = fakeRuntime();
    await createLocalEmbedder(undefined, load, 'https://hf-mirror.example.com//').embed(['a']);
    await createLocalEmbedder(undefined, load).embed(['a']);
    assert.deepEqual(seen.remote.map((r) => r.host), ['https://hf-mirror.example.com/', 'https://huggingface.co/']);
    const offline = createLocalEmbedder(undefined, async () => ({
      env: { cacheDir: '', allowRemoteModels: true, remoteHost: '' },
      pipeline: async () => { throw new Error('fetch failed'); },
    }), 'http://127.0.0.1:9');
    await assert.rejects(offline.prepare!(() => {}), /could not download Xenova\/bge-small-en-v1.5 from http:\/\/127.0.0.1:9\/: fetch failed/);
  });

  test('setup falls back to bun when npm fails, and reports a missing package manager', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-setup-'));
    try {
      const bins: string[] = [];
      const logs: string[] = [];
      const installed = setupLocalRuntime(dir, (m) => logs.push(m), (bin) => {
        bins.push(bin);
        if (bin === 'npm') return { status: 1 };
        const pkg = join(dir, 'node_modules/@huggingface/transformers');
        mkdirSync(join(pkg, 'dist'), { recursive: true });
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ exports: { '.': { node: { import: './dist/t.mjs' } } } }));
        writeFileSync(join(pkg, 'dist/t.mjs'), '');
        return { status: 0 };
      });
      assert.equal(installed, true);
      assert.deepEqual(bins, ['npm', 'bun']);
      assert.ok(logs.some((m) => m.startsWith('npm could not install')));
      const missing: string[] = [];
      const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      assert.equal(setupLocalRuntime(join(dir, 'other'), (m) => missing.push(m), () => ({ status: null, error: enoent })), false);
      assert.equal(missing.at(-1), 'Neither npm nor bun was found on PATH.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('embedders sharing one runtime keep their own download and host settings', async () => {
    const env = { cacheDir: '', allowRemoteModels: true, remoteHost: 'https://huggingface.co/' };
    const seen: string[] = [];
    let cached = false;
    const runtime: LocalRuntime = {
      env,
      async pipeline() {
        const before = `${env.allowRemoteModels} ${env.remoteHost}`;
        await new Promise((r) => setTimeout(r, 20));
        seen.push(`${before} | ${env.allowRemoteModels} ${env.remoteHost}`);
        if (!cached && !env.allowRemoteModels) throw new Error('local_files_only');
        cached = true;
        return async (texts) => ({ tolist: () => texts.map(() => [1, 0]) });
      },
    };
    const mirror = createLocalEmbedder(undefined, async () => runtime, 'https://mirror.example.com');
    const plain = createLocalEmbedder('Xenova/all-MiniLM-L6-v2', async () => runtime);
    const [prepared, embedded] = await Promise.allSettled([mirror.prepare!(() => {}), plain.embed(['a'])]);
    assert.equal(prepared.status, 'fulfilled', 'a concurrent offline load did not break the download');
    assert.equal(embedded.status, 'rejected');
    await plain.embed(['a']);
    const m = 'https://mirror.example.com/';
    const hf = 'https://huggingface.co/';
    assert.deepEqual(seen, [
      `false ${m} | false ${m}`,
      `false ${hf} | false ${hf}`,
      `true ${m} | true ${m}`,
      `false ${hf} | false ${hf}`,
    ]);
  });

  test('pruning removes only packages the Node runtime never loads; model files are detected', () => {
    const runtime = join(dir, 'embed');
    for (const name of ['onnxruntime-web', 'onnxruntime-node']) mkdirSync(join(runtime, 'node_modules', name), { recursive: true });
    assert.deepEqual(pruneLocalRuntime(runtime), ['onnxruntime-web']);
    assert.deepEqual(readdirSync(join(runtime, 'node_modules')), ['onnxruntime-node']);
    assert.deepEqual(pruneLocalRuntime(runtime), []);
    assert.equal(localModelDownloaded('Xenova/bge-m3', runtime), false);
    mkdirSync(join(runtime, 'models', 'Xenova', 'bge-m3', 'onnx'), { recursive: true });
    writeFileSync(join(runtime, 'models', 'Xenova', 'bge-m3', 'onnx', 'model_quantized.onnx'), '');
    assert.equal(localModelDownloaded('Xenova/bge-m3', runtime), true);
  });

  test('the query embedder passes on the model threshold', async () => {
    const vector = await createQueryEmbedder(createLocalEmbedder(undefined, fakeRuntime().load))('slow');
    assert.equal(vector?.model, 'local:Xenova/bge-small-en-v1.5');
    assert.equal(vector?.minScore, 0.62);
  });

  test('loads transformers.js from the runtime directory and caches models there', async () => {
    const runtime = join(dir, 'embed');
    await assert.rejects(loadLocalRuntime(runtime), /run `copilot-mem embed --setup`/);
    assert.equal(localRuntimeInstalled(runtime), false);
    const pkg = join(runtime, 'node_modules', '@huggingface', 'transformers');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', type: 'module', exports: { '.': { node: { import: { types: './t.d.ts', default: './index.js' } } } } }));
    writeFileSync(join(pkg, 'index.js'), 'export const env = { cacheDir: "" }; export async function pipeline() {}');
    assert.equal(localRuntimeInstalled(runtime), true);
    const loaded = await loadLocalRuntime(runtime);
    assert.equal(loaded.env.cacheDir, join(runtime, 'models'));
  });
});

describe('cloud embedders', () => {
  function recorder(reply: unknown) {
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(reply));
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }
  const openaiReply = { data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [3, 4] }] };

  test('openai-compatible: bearer key, custom endpoint, results in input order', async () => {
    const { seen, fetchImpl } = recorder(openaiReply);
    const embedder = createEmbedder('openai', { url: 'http://127.0.0.1:1234/v1/', apiKey: 'sk-x', model: 'nomic' }, fetchImpl);
    const vectors = await embedder.embed(['a', 'b']);
    assert.equal(seen[0].url, 'http://127.0.0.1:1234/v1/embeddings');
    assert.equal(seen[0].headers.authorization, 'Bearer sk-x');
    assert.deepEqual(seen[0].body, { model: 'nomic', input: ['a', 'b'] });
    assert.deepEqual([...vectors[0]].map((v) => +v.toFixed(2)), [0.6, 0.8]);
    assert.deepEqual([...vectors[1]], [0, 1]);
  });

  test('voyage, cohere and jina mark documents and queries the way each API expects', async () => {
    const cases = [
      ['voyage', 'https://api.voyageai.com/v1/embeddings', openaiReply, { input_type: 'document' }, { input_type: 'query' }],
      ['cohere', 'https://api.cohere.com/v2/embed', { embeddings: { float: [[3, 4], [0, 2]] } },
        { input_type: 'search_document', texts: ['a', 'b'], embedding_types: ['float'] }, { input_type: 'search_query' }],
      ['jina', 'https://api.jina.ai/v1/embeddings', openaiReply, { task: 'retrieval.passage' }, { task: 'retrieval.query' }],
    ] as const;
    for (const [provider, url, reply, doc, query] of cases) {
      const { seen, fetchImpl } = recorder(reply);
      const embedder = createEmbedder(provider, { apiKey: 'k' }, fetchImpl);
      const vectors = await embedder.embed(['a', 'b']);
      await embedder.embed(['a', 'b'], 1000, 'query');
      assert.equal(seen[0].url, url, provider);
      assert.equal(seen[0].headers.authorization, 'Bearer k');
      assert.deepEqual({ ...seen[0].body, ...doc }, seen[0].body, `${provider} document fields`);
      assert.deepEqual({ ...seen[1].body, ...query }, seen[1].body, `${provider} query fields`);
      assert.deepEqual([...vectors[1]], [0, 1], provider);
    }
  });

  test('search queries are embedded as queries', async () => {
    const kinds: (string | undefined)[] = [];
    const embedder: Embedder = { model: 'm', embed: async (texts, _t, kind) => (kinds.push(kind), texts.map(() => normalize([1]))) };
    await createQueryEmbedder(embedder)('redis');
    assert.deepEqual(kinds, ['query']);
  });

  test('reports a short error for failed requests', async () => {
    const fetchImpl = (async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(createEmbedder('jina', { apiKey: 'k' }, fetchImpl).embed(['a']), /jina 401: bad key/);
  });
});

describe('ollama embedder', () => {
  test('posts to /api/embed and returns unit vectors', async () => {
    let seen: { url: string; body: unknown } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ embeddings: [[3, 4], [0, 2]] }));
    }) as unknown as typeof fetch;
    const vectors = await createOllamaEmbedder('bge-m3', 'http://ollama:1/', fetchImpl).embed(['a', 'b']);
    assert.deepEqual(seen, { url: 'http://ollama:1/api/embed', body: { model: 'bge-m3', input: ['a', 'b'] } });
    assert.deepEqual(vectors.map((v) => [...v].map((x) => Number(x.toFixed(3)))), [[0.6, 0.8], [0, 1]]);
  });

  test('reports HTTP errors and malformed replies', async () => {
    const reply = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    await assert.rejects(createOllamaEmbedder('m', undefined, reply('model "m" not found', 404)).embed(['a']), /ollama 404: model "m" not found/);
    await assert.rejects(createOllamaEmbedder('m', undefined, reply('{}')).embed(['a']), /no embeddings/);
  });
});

describe('callers', () => {
  test('the MCP search tool uses the query embedder', async () => {
    const embedder = fakeEmbedder();
    await embedPending(store, embedder);
    const server = createRecallServer(store, '0.0.0', createQueryEmbedder(embedder));
    const client = new Client({ name: 't', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const result = await client.callTool({ name: 'search', arguments: { query: 'latency problems' } });
    const body = (result.content as { text: string }[])[0].text;
    assert.match(body, /Redis pipeline hangs/);
    assert.match((callRecallTool(store, 'search', { query: 'latency problems' }).content[0] as { text: string }).text, /No matches/, 'keyword-only without a vector');
    const timeline = await client.callTool({ name: 'timeline', arguments: { query: 'topology changes' } });
    assert.match((timeline.content as { text: string }[])[0].text, /> .*topology diff/);
    await client.close();
  });

  test('the viewer search uses the query embedder and degrades to keyword search', async () => {
    const embedder = fakeEmbedder();
    await embedPending(store, embedder);
    const dbPath = join(dir, 'memory.db');
    const open = (embedQuery: ReturnType<typeof createQueryEmbedder>) =>
      startViewer({ port: 0, files: workerFiles(dir), openStore: () => new MemoryStore(dbPath), status: () => ({}), embedQuery });
    const search = async (port: number, q: string) =>
      titles((await (await fetch(`http://127.0.0.1:${port}/api/observations?q=${encodeURIComponent(q)}`)).json()) as { title: string }[]);

    const viewer = await open(createQueryEmbedder(embedder));
    try {
      assert.ok((await search(viewer.port, 'latency problems')).includes('Redis pipeline hangs without socket timeout'));
    } finally {
      await viewer.close();
    }
    const down = await open(createQueryEmbedder({ model: 'fake', embed: async () => { throw new Error('down'); } }));
    try {
      assert.deepEqual(await search(down.port, 'latency problems'), []);
      assert.deepEqual(await search(down.port, 'topology'), ['Added topology diff script']);
    } finally {
      await down.close();
    }
  });
});
