import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDir, loadSettings, type Settings } from '../config.ts';
import { MIN_SEMANTIC_SCORE, type MemoryStore } from '../storage/memory-store.ts';

// Optional semantic search. By default observations are embedded in-process with a small ONNX model
// (transformers.js, installed on demand by `copilot-mem embed --setup`; no server, no cloud, no AI
// credits). ollama or cloud providers can be configured instead (cloud ones receive the memory text).
// Everything degrades to keyword (FTS) search when the provider is absent or slow.

export const DEFAULT_EMBED_MODEL = 'bge-m3';
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const BATCH = 32;
/** First use loads a local model into memory (~1-8 s); later calls take ~0.2 s. */
const EMBED_TIMEOUT_MS = 30_000;
const QUERY_TIMEOUT_MS = 10_000;
/** After a failure, skip query embedding for a while instead of stalling every search. */
const QUERY_BACKOFF_MS = 60_000;

/** Stored observations are documents; search text is a query (some providers embed them differently). */
export type EmbedKind = 'document' | 'query';

export interface Embedder {
  /** Key for stored vectors: the model, prefixed with the provider unless it is ollama. */
  model: string;
  /** Cosine similarity below which a match is noise; it depends on the model (default MIN_SEMANTIC_SCORE). */
  minScore?: number;
  embed(texts: string[], timeoutMs?: number, kind?: EmbedKind): Promise<Float32Array[]>;
  /** Gets the model ready with no time limit, downloading it if needed (local provider; `copilot-mem embed`). */
  prepare?(log: (message: string) => void): Promise<void>;
}

export interface QueryVector {
  model: string;
  values: Float32Array;
  minScore?: number;
}

/** Unit length, so cosine similarity is a dot product. */
export function normalize(values: ArrayLike<number>): Float32Array {
  let norm = 0;
  for (let i = 0; i < values.length; i++) norm += values[i] * values[i];
  norm = Math.sqrt(norm) || 1;
  return Float32Array.from(values, (v) => v / norm);
}

interface Provider {
  model: string;
  url: string;
  needsKey: boolean;
  path: string;
  body(model: string, texts: string[], kind: EmbedKind): object;
  vectors(json: unknown): number[][] | undefined;
}

/** OpenAI-style responses: {data: [{index, embedding}]}. */
function dataVectors(json: unknown): number[][] | undefined {
  const data = (json as { data?: { index?: number; embedding: number[] }[] }).data;
  if (!Array.isArray(data)) return undefined;
  return [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
}

export const PROVIDERS = {
  ollama: {
    model: DEFAULT_EMBED_MODEL,
    url: DEFAULT_OLLAMA_URL,
    needsKey: false,
    path: '/api/embed',
    body: (model, input) => ({ model, input }),
    vectors: (json) => (json as { embeddings?: number[][] }).embeddings,
  },
  openai: {
    model: 'text-embedding-3-small',
    url: 'https://api.openai.com/v1',
    needsKey: false, // local OpenAI-compatible servers (LM Studio, vLLM...) need none
    path: '/embeddings',
    body: (model, input) => ({ model, input }),
    vectors: dataVectors,
  },
  voyage: {
    model: 'voyage-4-lite',
    url: 'https://api.voyageai.com/v1',
    needsKey: true,
    path: '/embeddings',
    body: (model, input, kind) => ({ model, input, input_type: kind }),
    vectors: dataVectors,
  },
  cohere: {
    model: 'embed-v4.0',
    url: 'https://api.cohere.com/v2',
    needsKey: true,
    path: '/embed',
    body: (model, texts, kind) => ({
      model, texts, input_type: kind === 'query' ? 'search_query' : 'search_document', embedding_types: ['float'],
    }),
    vectors: (json) => (json as { embeddings?: { float?: number[][] } }).embeddings?.float,
  },
  jina: {
    model: 'jina-embeddings-v5-text-small',
    url: 'https://api.jina.ai/v1',
    needsKey: true,
    path: '/embeddings',
    body: (model, input, kind) => ({ model, input, task: kind === 'query' ? 'retrieval.query' : 'retrieval.passage' }),
    vectors: dataVectors,
  },
} satisfies Record<string, Provider>;

export type ProviderName = keyof typeof PROVIDERS;

interface LocalModel {
  /** How token vectors become one sentence vector (as the model was trained). */
  pooling: 'cls' | 'mean';
  /** Prefixes the model expects on search queries and on stored documents. */
  query: string;
  document: string;
  minScore: number;
}

/**
 * Models for the local provider (ONNX, 8-bit; downloaded from Hugging Face on first use). Thresholds
 * were set on ~1500 real observations, from the best score an unrelated query reached.
 */
export const LOCAL_MODELS: Record<string, LocalModel> = {
  // Default. English, 384 dimensions, ~33 MB. Best quality for its size; bge-m3 ranks better but is 17x larger.
  'Xenova/bge-small-en-v1.5': {
    pooling: 'cls', query: 'Represent this sentence for searching relevant passages: ', document: '', minScore: 0.62,
  },
  // English, 384 dimensions, ~23 MB. Smallest and fastest; scores are spread widely (noise < 0.2).
  'Xenova/all-MiniLM-L6-v2': { pooling: 'mean', query: '', document: '', minScore: 0.35 },
  // ollama's default model run in-process: ~100 languages, 1024 dimensions, ~570 MB, 8192-token input.
  'Xenova/bge-m3': { pooling: 'cls', query: '', document: '', minScore: 0.5 },
  // ~100 languages, 384 dimensions, ~145 MB. For non-English memory; scores bunch up (noise ~0.81).
  'Xenova/multilingual-e5-small': { pooling: 'mean', query: 'query: ', document: 'passage: ', minScore: 0.84 },
};
export const DEFAULT_LOCAL_MODEL = 'Xenova/bge-small-en-v1.5';
/** Other Hugging Face feature-extraction models work too, with these assumptions. */
const OTHER_LOCAL_MODEL: LocalModel = { pooling: 'mean', query: '', document: '', minScore: MIN_SEMANTIC_SCORE };
const LOCAL_RUNTIME = '@huggingface/transformers';
const LOCAL_RUNTIME_VERSION = '^4.3.1';

/** Where `embed --setup` installs transformers.js (node_modules) and where models are cached (models/). */
export function localRuntimeDir(dir = dataDir()): string {
  return join(dir, 'embed');
}

/**
 * The installed package's Node ESM entry, read from its package.json (not require.resolve: Bun caches a
 * failed lookup, so the runtime would stay "missing" for the rest of the `embed --setup` process).
 */
function localRuntimeEntry(dir: string): string | undefined {
  const root = join(dir, 'node_modules', ...LOCAL_RUNTIME.split('/'));
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const entry = pkg.exports?.['.']?.node?.import ?? pkg.exports?.['.']?.import ?? pkg.module ?? pkg.main;
    const path = join(root, typeof entry === 'string' ? entry : entry?.default ?? 'index.js');
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

export function localRuntimeInstalled(dir = localRuntimeDir()): boolean {
  return localRuntimeEntry(dir) !== undefined;
}

/** Whether the 8-bit weights of `model` are in the runtime directory's model cache. */
export function localModelDownloaded(model: string, dir = localRuntimeDir()): boolean {
  return existsSync(join(dir, 'models', ...model.split('/'), 'onnx', 'model_quantized.onnx'));
}

/** Download progress from transformers.js; only the aggregate event is used. */
export type LocalProgress = { status: string; progress?: number; loaded?: number; total?: number };

/** The subset of transformers.js used here. */
export interface LocalRuntime {
  env: { cacheDir: string; allowRemoteModels: boolean; remoteHost: string };
  pipeline(task: 'feature-extraction', model: string, options: { dtype: string; progress_callback?: (p: LocalProgress) => void }): Promise<
    (texts: string[], options: { pooling: 'cls' | 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>
  >;
}

/** Loads transformers.js from the runtime directory (kept out of the bundle: it is ~330 MB with onnxruntime). */
export async function loadLocalRuntime(dir = localRuntimeDir()): Promise<LocalRuntime> {
  const path = localRuntimeEntry(dir);
  if (!path) throw new Error('local embedding runtime is not installed; run `copilot-mem embed --setup`');
  const runtime = (await import(pathToFileURL(path).href)) as LocalRuntime;
  runtime.env.cacheDir = join(dir, 'models');
  return runtime;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Logs aggregate download progress in 10% steps. */
function progressLogger(model: string, log: (message: string) => void): (p: LocalProgress) => void {
  let shown = -1;
  return (p) => {
    if (p.status !== 'progress_total' || !p.total) return;
    const step = Math.floor((p.progress ?? 0) / 10);
    if (step <= shown) return;
    shown = step;
    log(`Downloading ${model}: ${step * 10}% (${Math.round((p.loaded ?? 0) / 1e6)} of ${Math.round(p.total / 1e6)} MB)`);
  };
}

const HUGGING_FACE_HOST = 'https://huggingface.co/';
let localLoads: Promise<unknown> = Promise.resolve();

/**
 * Embeds in this process; the model loads once per process. Only prepare() (run by `copilot-mem
 * embed`) downloads it: the worker, MCP server and viewer use the cached copy, so a slow download
 * never runs against their timeouts or gets cut off when they exit. `url` replaces the Hugging Face
 * host (a mirror).
 */
export function createLocalEmbedder(
  model = DEFAULT_LOCAL_MODEL,
  load: () => Promise<LocalRuntime> = () => loadLocalRuntime(),
  url = '',
): Embedder {
  const spec = LOCAL_MODELS[model] ?? OTHER_LOCAL_MODEL;
  let extractor: ReturnType<LocalRuntime['pipeline']> | undefined;
  const host = url ? `${url.replace(/\/+$/, '')}/` : HUGGING_FACE_HOST;
  const pipe = (download?: (message: string) => void) => {
    extractor ??= load().then((runtime) => {
      // transformers.js settings are process-wide, so loads run one at a time with their own settings.
      const loading = localLoads.then(async () => {
        runtime.env.allowRemoteModels = Boolean(download);
        runtime.env.remoteHost = host;
        try {
          return await runtime.pipeline('feature-extraction', model, {
            dtype: 'q8',
            ...(download ? { progress_callback: progressLogger(model, download) } : {}),
          });
        } catch (error) {
          if (download) throw new Error(`could not download ${model} from ${host}: ${(error as Error).message}`);
          throw new Error(`local model ${model} is not downloaded; run \`copilot-mem embed\` (${(error as Error).message})`);
        }
      });
      localLoads = loading.catch(() => undefined);
      return loading;
    });
    extractor.catch(() => { extractor = undefined; }); // retry on the next call
    return extractor;
  };
  return {
    model: `local:${model}`,
    minScore: spec.minScore,
    async prepare(log) {
      // A cached model loads offline and silently; only a missing one is downloaded.
      await pipe().catch(() => pipe(log));
    },
    async embed(texts, timeoutMs = EMBED_TIMEOUT_MS, kind = 'document') {
      const prefix = kind === 'query' ? spec.query : spec.document;
      const run = pipe().then((extract) => extract(texts.map((t) => prefix + t), { pooling: spec.pooling, normalize: true }));
      const vectors = (await withTimeout(run, timeoutMs, 'local embedding')).tolist();
      if (vectors.length !== texts.length) throw new Error('local model returned no embeddings');
      return vectors.map(normalize);
    },
  };
}

/**
 * Packages the runtime installs but never loads under Node or Bun: transformers.js bundles its own
 * copy of onnxruntime-web (for browsers) and uses onnxruntime-node here.
 */
const UNUSED_RUNTIME_PACKAGES = ['onnxruntime-web'];

/** Deletes UNUSED_RUNTIME_PACKAGES (~140 MB); returns the ones removed. */
export function pruneLocalRuntime(dir = localRuntimeDir()): string[] {
  return UNUSED_RUNTIME_PACKAGES.filter((name) => {
    const path = join(dir, 'node_modules', name);
    if (!existsSync(path)) return false;
    rmSync(path, { recursive: true, force: true });
    return true;
  });
}

/**
 * Installs (or repairs/upgrades) transformers.js in the runtime directory with npm, else bun, then
 * prunes unused packages. Registry settings come from npm's or bun's own config. False on failure.
 */
type RunCommand = (bin: string, args: string[]) => { status: number | null; error?: Error };

export function setupLocalRuntime(
  dir = localRuntimeDir(),
  log: (message: string) => void = console.log,
  run: RunCommand = (bin, args) => spawnSync(bin, args, { stdio: 'inherit' }),
): boolean {
  mkdirSync(dir, { recursive: true });
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) writeFileSync(manifest, `${JSON.stringify({ private: true, description: 'copilot-mem local embedding runtime' }, null, 2)}\n`);
  const spec = `${LOCAL_RUNTIME}@${LOCAL_RUNTIME_VERSION}`;
  const attempts: [string, string[]][] = [
    ['npm', ['install', '--prefix', dir, '--no-audit', '--no-fund', '--ignore-scripts', spec]],
    ['bun', ['add', '--cwd', dir, spec]],
  ];
  let failed = false;
  for (const [bin, args] of attempts) {
    log(`Installing ${spec} into ${dir} with ${bin} (~330 MB)...`);
    const result = run(bin, args);
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') continue;
    if (result.status !== 0 || !localRuntimeInstalled(dir)) {
      log(`${bin} could not install ${spec}.`);
      failed = true;
      continue;
    }
    const pruned = pruneLocalRuntime(dir);
    if (pruned.length) log(`Removed unused ${pruned.join(', ')}.`);
    return true;
  }
  if (!failed) log('Neither npm nor bun was found on PATH.');
  return false;
}

export function createEmbedder(
  provider: ProviderName,
  options: { model?: string; url?: string; apiKey?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Embedder {
  const spec: Provider = PROVIDERS[provider];
  const model = options.model || spec.model;
  const url = (options.url || spec.url).replace(/\/+$/, '');
  if (spec.needsKey && !options.apiKey) throw new Error(`COPILOT_MEM_EMBED_API_KEY is required for the ${provider} embedding provider`);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  return {
    model: provider === 'ollama' ? model : `${provider}:${model}`,
    async embed(texts, timeoutMs = EMBED_TIMEOUT_MS, kind = 'document') {
      const res = await fetchImpl(`${url}${spec.path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(spec.body(model, texts, kind)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const vectors = spec.vectors(await res.json());
      if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new Error(`${provider} returned no embeddings`);
      return vectors.map(normalize);
    },
  };
}

export function createOllamaEmbedder(model: string, url = DEFAULT_OLLAMA_URL, fetchImpl: typeof fetch = fetch): Embedder {
  return createEmbedder('ollama', { model, url }, fetchImpl);
}

/** The configured embedder, or undefined when semantic search is off. */
export function embedderFromSettings(settings: Settings = loadSettings()): Embedder | undefined {
  const provider = settings('COPILOT_MEM_EMBED_PROVIDER');
  const model = settings('COPILOT_MEM_EMBED_MODEL');
  if (provider === 'off' || model === 'off') return undefined;
  if (provider === 'local') return createLocalEmbedder(model || DEFAULT_LOCAL_MODEL, undefined, settings('COPILOT_MEM_EMBED_URL'));
  if (!(provider in PROVIDERS)) {
    throw new Error(`COPILOT_MEM_EMBED_PROVIDER must be one of local, ${Object.keys(PROVIDERS).join(', ')} or off (got "${provider}")`);
  }
  return createEmbedder(provider as ProviderName, {
    model,
    url: settings('COPILOT_MEM_EMBED_URL'),
    apiKey: settings('COPILOT_MEM_EMBED_API_KEY'),
  });
}

/** Like embedderFromSettings, but a configuration error only logs and turns semantic search off. */
export function embedderOrWarn(log: (message: string) => void, settings?: Settings): Embedder | undefined {
  try {
    return embedderFromSettings(settings);
  } catch (error) {
    log(`copilot-mem: semantic search off: ${(error as Error).message}`);
    return undefined;
  }
}

export function observationText(o: { title: string; subtitle?: string; narrative: string; facts: string[] }): string {
  return [o.title, o.subtitle, o.narrative, ...o.facts].filter(Boolean).join('\n');
}

/** Embeds observations that have no vector for the embedder's model yet, newest first. */
export async function embedPending(store: MemoryStore, embedder: Embedder, limit = Infinity): Promise<number> {
  let done = 0;
  while (done < limit) {
    const todo = store.observationsToEmbed(embedder.model, Math.min(BATCH, limit - done));
    if (todo.length === 0) break;
    const vectors = await embedder.embed(todo.map(observationText));
    done += store.saveEmbeddings(embedder.model, todo.map((o, i) => ({ id: o.id, vector: vectors[i], editedAt: o.editedAt })));
  }
  return done;
}

/** Embeds a search query; undefined (keyword-only search) on any failure. */
export function createQueryEmbedder(embedder: Embedder | undefined, now = () => Date.now()) {
  let failedAt = -Infinity;
  return async (query: string | undefined): Promise<QueryVector | undefined> => {
    if (!embedder || !query?.trim() || now() - failedAt < QUERY_BACKOFF_MS) return undefined;
    try {
      const [values] = await embedder.embed([query], QUERY_TIMEOUT_MS, 'query');
      return { model: embedder.model, values, minScore: embedder.minScore };
    } catch {
      failedAt = now();
      return undefined;
    }
  };
}

export type QueryEmbedder = ReturnType<typeof createQueryEmbedder>;
