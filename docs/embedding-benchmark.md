# Embedding benchmark: local vs ollama

Measured 2026-10-13 on 1,531-1,552 real observations (title, subtitle, narrative and
facts, as embedded by `copilot-mem embed`).

- Machine: Apple Silicon laptop
- Runtime: Bun 1.4.2, ollama 0.32.14, transformers.js 4.3.1 (8-bit ONNX)
- Batches of 32, the same as `copilot-mem embed`
- The ollama model was already loaded; the local model was already downloaded

| | `local` `Xenova/bge-small-en-v1.5` | `ollama` `bge-m3` |
|---|---|---|
| Model load | 127 ms | 1.2 s |
| Embed all 1,531 | 14.1 s (9 ms each) | 30.9 s (20 ms each) |
| One search query | 2 ms | 129 ms |

Under Node 26, `copilot-mem embed` with the local model took 27.2 s for the
same observations.

The same bge-m3 model also runs in-process (`local` `Xenova/bge-m3`, 8-bit,
~570 MB download), measured on 1,557 observations:

| | `local` `Xenova/bge-m3` | `ollama` `bge-m3` | `local` bge-small |
|---|---|---|---|
| Model load | 0.6 s | 1.0 s | 0.07 s |
| Embed all | 118.6 s (76 ms each) | 30.9 s (20 ms each) | 14.7 s (9 ms each) |
| One search query | 7 ms | 133 ms | 2 ms |

In-process bge-m3 runs on the CPU, so bulk embedding is about 4× slower than
ollama, which uses the GPU (Metal). Queries are short, so the HTTP round trip
dominates and in-process is still faster per search.

## Takeaways

- The local model is about 2× faster at bulk embedding and about 60× faster
  per query. It runs in-process, with no HTTP round trip, and search waits on
  the query step every time.
- `bge-m3` is the stronger model: about 17× bigger (568M parameters, 1024
  dimensions), about 100 languages, and it reads up to 8,192 tokens, while
  `bge-small` cuts text off at 512. Prefer ollama for long or non-English
  memories. On these short, mostly English observations both gave good
  results.

## Match thresholds

Matches scoring below a model's threshold are dropped as noise. Each local
model's threshold was set just above the best score an unrelated query
("pizza recipe") reached against these observations:

| Model | Unrelated query, best score | Relevant matches | Threshold |
|---|---|---|---|
| `Xenova/bge-small-en-v1.5` | 0.58 | 0.64–0.84 | 0.62 |
| `Xenova/all-MiniLM-L6-v2` | 0.18 | 0.29–0.64 | 0.35 |
| `Xenova/multilingual-e5-small` | 0.81 | 0.85–0.90 | 0.84 |
| `Xenova/bge-m3` (local) | ~0.33 | 0.55+ | 0.5 (as ollama) |
| `bge-m3` (ollama) | ~0.33 | 0.55+ | 0.5 |

## Search quality

30 queries written in my own words, each pointing at one known observation
(for example, a query like "login keeps failing after an upgrade" pointing at
an observation about an expired session token). Each search returns the top 10.

| Search | hit@1 | hit@5 | hit@10 | MRR |
|---|---|---|---|---|
| keyword only | 47% | 73% | 80% | 0.59 |
| `local` bge-small (hybrid) | 50% | 80% | 87% | 0.63 |
| `local` bge-small (meaning only) | 53% | 77% | 87% | 0.64 |
| `ollama` bge-m3 (hybrid) | 60% | 83% | 87% | 0.70 |
| `ollama` bge-m3 (meaning only) | 63% | 83% | 83% | 0.71 |
| `local` bge-m3 (hybrid) | 57% | 83% | 87% | 0.68 |
| `local` bge-m3 (meaning only) | 63% | 83% | 83% | 0.70 |

- hit@k: the expected observation is in the top k. MRR: mean of 1/rank
  (1.00 = always first).
- Hybrid is what copilot-mem does: keyword and meaning-based rankings fused.
- Both models add to keyword search, mostly when the query shares no words
  with the observation (one such query was not found by keyword; both models
  ranked its observation 2nd).
- bge-m3 ranks the expected result first more often (60% vs 50%). bge-small
  is about as good at putting it in the top 10.
- In-process bge-m3 matches ollama's (one query ranked differently, from
  8-bit quantization), so it uses ollama's 0.5 threshold.
- 4 queries failed with every method. 30 queries is a small sample: one
  query is about 3 percentage points.

## Reproduce

```sh
bun run bench            # or: bun scripts/bench-embeddings.ts --verbose
```

[`scripts/bench-embeddings.ts`](../scripts/bench-embeddings.ts) copies your
memory database to a temporary file, re-embeds every observation with each
model (no AI credits) and runs the queries through copilot-mem's own search,
so your database is never changed. It prints the speed and quality tables
above; `--verbose` adds each query's rank.

- Queries: `~/.copilot-mem/bench/queries.json` (`--queries FILE`), a list of
  `{"query": "...", "expect": [observation IDs]}`. They describe your own
  memory, so they are not part of the repository. Write them in your own
  words, not the observation's, so they test meaning rather than shared
  keywords.
- Models: `--embedder local:MODEL` or `--embedder ollama:MODEL`, repeatable.
  The default is `local:Xenova/bge-small-en-v1.5` and `ollama:bge-m3`; ollama
  is skipped if it isn't running. The local model needs
  `copilot-mem embed --setup` first.
