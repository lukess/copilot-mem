# How copilot-mem works

The details behind the [README](../README.md).

## What install does

`install` is idempotent. Run it again after upgrading. It:

1. Finds `copilot` on `PATH` (or `COPILOT_MEM_COPILOT_BIN`) and checks its
   version and `COPILOT_HOME`. Creates or updates
   `~/.copilot-mem/settings.json` (see [Configuration](../README.md#configuration)),
   recording the binary and any `COPILOT_MEM_*` values exported in your shell.
2. Copies the bundle to `~/.copilot-mem/lib/copilot-mem.js`, so the
   integration doesn't depend on where you ran it from. A source checkout
   (`src/cli.ts`) is used in place. The runtime is recorded by its `PATH` name
   (e.g. `/opt/homebrew/bin/node`, not the versioned Cellar path), so a
   runtime upgrade doesn't break it.
3. Registers the MCP server with `copilot mcp add copilot-mem`.
4. Adds the `copilot-mem` skill (`copilot skill add`). The skill teaches the
   search → timeline → get_observations workflow.
5. Writes `$COPILOT_HOME/hooks/copilot-mem.json`:
   - `sessionStart`: starts the background worker. On new sessions (not
     resumes), it injects `additionalContext` (at most 3,000 chars) for the
     current repository: up to 10 observations you pinned in the dashboard
     (first, however old), the last session summary (request, completed, next
     steps), up to 5 notes, and 15 observations. The observations come from
     the newest 75: the newest quarter always, the rest by reinforcement
     strength (see [Reinforcement](#reinforcement)), skipping recorded
     near-duplicates. The repository is found via the git root, so other
     clones of the same repo also match. Outside a git repo (e.g. `~/dev`),
     it covers every repository worked on below that directory and lists
     them in the heading. Inside a repo, up to 5 of the 15 observations come
     from [linked projects](#linked-projects).
   - `agentStop` and `sessionEnd`: start the background worker.
6. Detects VS Code (user data directory or `code` on `PATH`) and says so.
   VS Code's Copilot agent reads the same `~/.copilot` MCP config, skills and
   hooks, so nothing else is installed (see [VS Code](#vs-code)).
7. Records what it did in `~/.copilot-mem/install.json`, then runs a first
   sync.

`copilot-mem uninstall` removes the MCP server, skill, hooks and bundle. It
keeps `memory.db`; delete `~/.copilot-mem` yourself to forget everything.
`copilot-mem status` prints JSON with the detection result, the integration
state, memory counts and recent worker log lines.

## Background worker

- Hooks never do real work inline. They touch a pending flag, spawn a
  detached `copilot-mem worker`, and exit within milliseconds.
- Hooks fail open: errors go to `~/.copilot-mem/worker.log` and the hook
  still exits 0.
- The worker holds `worker.lock`, so there is only one worker at a time. It
  debounces for 3 s, because Copilot writes the turn row just *after*
  `sessionEnd`.
- Each round, the worker syncs. Then, under `compress.lock`, it makes up to
  `COPILOT_MEM_AUTO_COMPRESS` Copilot calls (default 5, `0` disables
  auto-compression): pending batches first, then any calls left go to
  [session summaries](#session-summaries) for sessions active in the last 7
  days. It repeats while new work was requested.
- In interactive sessions, a turn is only finalized when the next prompt
  arrives. The next `agentStop` or `sessionStart` picks it up.
- The summarizer's own Copilot calls use an isolated `COPILOT_HOME`, so they
  never trigger the hooks.

## Dashboard

A live web viewer (like claude-mem's):

- Counts and compression progress, plus worker state (idle / running /
  compressing).
- A per-project list showing observation and pending-turn counts, with a
  filter box (words match anywhere in the name, e.g. `acme web`).
- A **Compress** button that compresses pending turns now, up to N Copilot
  calls (measured average about 0.5 AI credits each, as one call covers
  several turns). It asks for confirmation, then runs the same sync →
  compress round as the worker, under `compress.lock`.
  - With no project selected, it works newest sessions first, like the worker.
  - With a project selected, it becomes **Compress project** and only
    compresses that project's turns: exactly that repository or directory,
    not its subdirectories. Use this for older projects, which the
    newest-first worker may not reach for a long time.
  - It runs as a separate `copilot-mem compress --background` process that
    logs to `worker.log`, so closing or restarting the dashboard doesn't
    stop it. Each call usually takes 10–45 s.
  - Only one run happens at a time. Cross-site requests are refused: the
    endpoint requires a custom header, and a foreign `Origin` is rejected.
- Search that combines keyword and meaning-based matches (see
  [Semantic search](#semantic-search)), with a type filter (including
  "pinned").
- Observation detail with facts, files, source session and a timeline, plus
  the files Copilot's tools touched in those turns, the session's commits /
  PRs / issues (linked to GitHub), how often it was seen, and possible
  duplicates.
- A live tail of `worker.log`.
- **Sessions** (the list's Observations/Sessions switch): every Copilot CLI
  session, newest first, with turn, observation and pending counts. Open one to
  read its turns, observations and summary, the context copilot-mem injected at
  start, and its copilot-mem tool calls. An observation's session and turns link
  to the source turns, highlighted.
- **Sessions used memory** (header): how many sessions got context injected or
  called copilot-mem's tools (overall or for the selected project), calls per
  tool, and those sessions. Injected context is read from each session's
  `events.jsonl` `hook.end` events; upgrading re-reads existing sessions once.
- **Date range** (From / To, local dates): narrows the observation and session
  lists. **Activity** shows a year heatmap of turns per day for the selected
  project (or all), with monthly totals; click a day or month to filter to it.
- **Export**: downloads the observations matching the current project, date
  range, search and type as Markdown, grouped by project and type, with
  session summaries (when not narrowed by search or type). Useful for a work
  summary.
- **Curation**: an observation's detail has **Pin**, **Edit** and **Delete**.
  Pinned observations (filter: type "pinned") lead every new session's
  context for their project, however old; up to 10. Edits replace the
  compressed text and re-embed it. Delete removes it from search and context
  but keeps the session's raw turns. **+ Note** saves a note to a project, like
  the `remember` tool. These POST actions need the dashboard's own header, so
  other sites can't trigger them.
- **Context**: with a project selected, previews what the sessionStart hook
  would inject into a new session there now, and its size against the budget.
- **AI credits used** (header): opens compression usage for the last 24 h, all
  time and per day (calls, turns → observations, time, tokens, AI credits,
  premium requests), the most recent calls, and a projection for the pending
  backlog from measured averages, overall and for the 10 projects with the
  most pending turns (click one to select it). The Compress button's tooltip
  and confirmation show what this run covers: calls, turns, AI credits and
  time for the selected project (or all), and how many calls clearing it all
  would take.
- **Settings**: Copilot CLI and integration health (MCP server, skill, hooks,
  worker, auto-compress), the embedding model and how many observations it has
  embedded, every setting with its effective value and source (environment,
  file or default; API keys masked), and linked projects, which you can link
  and unlink there. Settings are read-only here: edit `settings.json`.

Updates arrive over server-sent events, polling the database every 2 s.
The page is self-contained (strict CSP, no external assets) and serves only
on `127.0.0.1`. It rejects other `Host` headers, because `memory.db` holds
conversation text.

## How sync works

- Copilot writes a turn row when the turn is finalized, which is usually when
  the next prompt arrives. Its `timestamp` is the write time. Because of this,
  the in-progress turn is never visible, and `sessions.updated_at` is **not** a
  reliable change signal.
- Each sync upserts all sessions. It then re-reads turns from 10 minutes before
  the last-seen turn timestamp (the watermark). Upserts are idempotent by
  content hash, and `turns.changed_at` moves only when the content changes.
- If a turn is rewritten with a timestamp older than that window, only
  `--full` picks it up.
- The watermark is tied to the source store's path. Pointing
  `COPILOT_MEM_SOURCE_DB` or `COPILOT_HOME` somewhere else triggers a full
  scan of that store.
- If Copilot changes the columns copilot-mem reads, sync fails with an
  `Unsupported Copilot session-store schema` error. It does not mirror
  partial data.
- Copilot's `session_files` and `session_refs` (files touched; commits, PRs
  and issues referenced) are mirrored too.
- **Tool calls** come from each session's
  `session-state/<id>/events.jsonl` (next to the session store). Reading these
  files passively costs Copilot nothing, unlike a `postToolUse` hook, which
  would run a process before every tool result. Each file is read
  incrementally by byte offset, and a partial last line is left for the next
  sync. Each call is stored as a one-line summary in `tool_events`, e.g.
  `bash: Run tests $ bun test`, `edit: src/a.ts`, or `report_intent: …`.
  Failed calls keep a 200-char error excerpt.
  - Credentials (GitHub/OpenAI/Slack/AWS tokens, JWTs, `Authorization`
    headers, `password=`-style values) are redacted on a best-effort basis.
  - Bash/agent plumbing (`read_bash`, `read_agent`, …) and subagent-internal
    calls are skipped.
  - The events format is undocumented. Unknown or malformed lines are
    ignored.

## How compression works

- Pending turns (not yet compressed, fewer than 3 failed attempts) are grouped
  by session, newest session first, into batches of about 48 KB of transcript.
  Long messages are clipped (user 4,000 chars, assistant 8,000).
- Each turn also lists the tool calls made during it, in a `<tools>` block of
  up to 3,000 chars with immediate repeats collapsed. That shows the model
  what was actually done, not just the final reply. A turn row is written when
  the next prompt arrives, so turn *k* covers the calls made after turn
  *k-1*'s timestamp, up to and including its own.
- Each batch is one `copilot` call. The transcript goes over **stdin**, so it
  never appears in `ps`. The reply must be JSON: a list of observations with
  `type` (decision, bugfix, feature, refactor, change, discovery), `title`,
  `subtitle` (one sentence), `narrative`, `facts`, `concepts` (claude-mem's
  knowledge tags: how-it-works, why-it-exists, what-changed, problem-solution,
  gotcha, pattern, trade-off; anything else is dropped), `files_read` and
  `files_modified`. Observations stored before these fields existed have them
  empty.
- Each call is isolated. It runs with a throwaway `COPILOT_HOME` that holds
  only your `lastLoggedInUser` (the token stays in the OS keychain), from an
  empty scratch cwd, with all tools disabled (`--available-tools` set to a
  nonexistent tool), and with `COPILOT_ALLOW_ALL` removed. The summarizer's
  own sessions never land in your `~/.copilot/session-store.db`, and the
  scratch dir is deleted afterwards.
- Cost: `gpt-5-mini` uses 0 premium requests. A real batch averages about
  0.5 AI credits per call (about 0.08 per turn); a trivial prompt is about
  0.06. Billing is per request, so larger batches are cheaper. Every call's
  wall time, API time, tokens, AI credits and premium requests
  are read from Copilot's `--usage-output-file` and stored in `compress_calls`;
  see `copilot-mem stats` or the dashboard. Calls made before this was added
  were not measured. A full backfill of a
  large history can mean hundreds of calls; use `--limit` to pace it.
- If the model output can't be parsed, that counts as a failed attempt for
  the batch's turns. After 3 failures those turns are skipped. Runner
  failures (not logged in, timeout after 180 s, missing binary) abort the run
  and don't count against the turns.
- Limitation: a turn that changes after it was compressed is not
  re-compressed.

## Duplicate observations

Ported from claude-mem's title dedup and scoped per project (repository,
else cwd):

- **Exact**: a new observation whose title matches an existing one after
  normalization (case, punctuation, spacing) is not stored again. The existing
  observation's `occurrences` and `last_seen_at` are bumped instead.
- **Near-duplicate**: an IDF-weighted cosine of at least 0.8 on title words,
  sharing at least 2 words, and with no rare word (in at most 10 titles) on
  only one side. Such pairs are recorded in `observation_duplicates` and shown
  as "Possible duplicates" in `get_observations` and the dashboard. They are
  never merged.
- `copilot-mem dedup` re-checks existing observations and records any pairs
  it finds; it never merges or deletes.

## Reinforcement

Ported from claude-mem's ACT-R reinforcement (Apache-2.0). Each exact-title
merge records the day of the merged turns in `reinforcement_dates` (at most
10 distinct days). Existing merges were backfilled from `last_seen_at`.

- Strength is `ln(1 + age^-0.5 + sum(reinforcement_age^-0.5))`, with ages in
  days. Something re-confirmed yesterday stays strong even if it was first
  seen months ago.
- Session-start context uses it to choose observations (above).
- Searches with a query multiply each result's relevance (bm25, or the fused
  score) by `1 + 0.1 * ln(1 + sum(reinforcement_age^-0.5))`. Observations
  never re-confirmed get no boost, so search doesn't favour recent items; a
  re-confirmed one passes comparably relevant results but not a clearly
  better match. Listing without a query stays newest first.

## Linked projects

Some repos are usually worked on together, e.g. an app debugged against its
API service. Link them once:

```sh
copilot-mem link acme/api acme/web acme/infra
copilot-mem links                                  # list
copilot-mem unlink acme/api acme/web  # remove that pair
```

- A project is a repository name or an absolute directory, as listed in the
  dashboard. Every pair is linked both ways. Links are not transitive: linking
  A with B and B with C does not link A with C.
- Session-start context in a linked repo keeps its own last-session recap and
  notes, and at least 10 of its 15 observations. Up to 5 slots go to the
  newest or most re-confirmed observations of the linked projects, under
  "From linked projects". The heading names them.
- Searching with a `project` also covers the projects linked to it. Search
  without a project already covers everything.
- The dashboard's **Settings** view also lists, adds and removes links.
- Links come from you only. Copilot's records of cross-repo work are too
  sparse to infer them reliably.

## Session summaries

Like claude-mem's session summaries: one Copilot call turns a finished
session's observations and opening request (clipped to 1,000 chars) into
`request`, `investigated`, `learned`, `completed`, `next_steps` and `notes`.

- A session is ready when it has been idle for 30 minutes, has no turns left
  to compress, and has at least one observation. It is summarized again once
  it gains new observations.
- The worker only uses calls left over from compression in its round, and
  only for sessions active in the last 7 days. `copilot-mem summarize
  [--limit N] [--session ID]` covers older ones (default 10 calls).
- A skipped or unparseable reply is recorded, so it is not retried until the
  session has new observations.
- Calls are measured like compression calls, with kind `summarize` (shown in
  `stats` and the dashboard). They don't count toward the backlog projection.
- Summaries appear in session-start context, in the dashboard's observation
  detail and Sessions view, and through the `summaries` MCP tool.

## Semantic search

Optional, local and free by default. `copilot-mem embed --setup` installs
[transformers.js](https://huggingface.co/docs/transformers.js) (with
onnxruntime, ~330 MB) into `~/.copilot-mem/embed`, outside the copilot-mem
bundle, removes the browser-only `onnxruntime-web` it does not use, and runs
`copilot-mem embed`. Run it again to repair or upgrade the runtime. Embedding
then runs inside the copilot-mem process: no server.

- **Model download.** Only `copilot-mem embed` downloads the model (with
  progress and no time limit) into `~/.copilot-mem/embed/models`. The worker,
  MCP server and dashboard only use a downloaded model, so a large download
  is never cut off; until then they log "run `copilot-mem embed`" and search
  stays keyword-only. After changing `COPILOT_MEM_EMBED_MODEL`, run
  `copilot-mem embed`.
- **Mirrors and offline use.** For `local`, `COPILOT_MEM_EMBED_URL` replaces
  the Hugging Face host (e.g. an internal mirror). The runtime comes from
  your npm (or bun) registry, so `.npmrc` settings apply. Offline, copy
  `~/.copilot-mem/embed` from a machine where setup worked; models are plain
  files under `models/<org>/<model>/`.

Each worker round embeds up to 500 new observations
(title, subtitle, narrative and facts); `copilot-mem embed` backfills all of
them (about 15 s for 1,500 observations with the default model). GitHub
Copilot offers no embeddings API, so the model comes from one of these
providers.

| `COPILOT_MEM_EMBED_PROVIDER` | Default model | Default endpoint | Key |
|---|---|---|---|
| `local` | `Xenova/bge-small-en-v1.5` | `https://huggingface.co` (model download) | no |
| `ollama` | `bge-m3` | `http://localhost:11434` | no |
| `openai` | `text-embedding-3-small` | `https://api.openai.com/v1` | for OpenAI |
| `voyage` | `voyage-4-lite` | `https://api.voyageai.com/v1` | yes |
| `cohere` | `embed-v4.0` | `https://api.cohere.com/v2` | yes |
| `jina` | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | yes |

- Local models (8-bit ONNX; any Hugging Face feature-extraction model works,
  these three are tuned):

  | Model | Languages | Download | Threshold |
  |---|---|---|---|
  | `Xenova/bge-small-en-v1.5` (default) | English | ~33 MB | 0.62 |
  | `Xenova/all-MiniLM-L6-v2` | English | ~23 MB | 0.35 |
  | `Xenova/multilingual-e5-small` | ~100 | ~145 MB | 0.84 |
  | `Xenova/bge-m3` | ~100 | ~570 MB | 0.5 |

  Each uses the pooling and query/document prefixes it was trained with.
  Thresholds were set on ~1,500 real observations, just above the best score an
  unrelated query reached. Other models use mean pooling and 0.5. Speed and
  thresholds compared with ollama: [embedding-benchmark.md](embedding-benchmark.md).
- `ollama` needs [ollama](https://ollama.com) running with the model pulled
  (`ollama pull bge-m3`); `bge-m3` is multilingual.
- `openai` works with any OpenAI-compatible `/embeddings` endpoint (LM Studio,
  vLLM, LiteLLM, ...) via `COPILOT_MEM_EMBED_URL`; the key is optional there.
  The key is sent as a Bearer token.
- voyage, cohere and jina are told whether they embed a document or a search
  query, as their APIs recommend.
- **Cloud providers receive the text of your memories** (and of search
  queries). Use `local`, ollama or a local OpenAI-compatible server to keep it
  local.
- Switching provider or model takes effect in new Copilot sessions (and a restarted dashboard) and the next worker
  round. Run `copilot-mem embed` to re-embed everything at once (cloud
  providers bill for it). Vectors are tagged `provider:model` (e.g.
  `local:Xenova/bge-small-en-v1.5`), ollama vectors with the bare model name.
- Searches in the MCP server and the dashboard embed the query and fuse the
  keyword (FTS5) ranking with the cosine-similarity ranking by reciprocal rank
  fusion (k = 60). An observation found both ways ranks first. A search such
  as "why was compression slow" now finds "Copilot call latency baseline".
- Vector matches below the model's threshold are dropped (0.5 for ollama and
  cloud models). With `bge-m3`, unrelated text scores about 0.33 and relevant
  text 0.55 or more.
- Vectors are unit-length float32 BLOBs in `observation_embeddings`, tagged
  with the model. Changing the provider or model re-embeds everything, and
  until that finishes only re-embedded observations get semantic matches.
- The local model loads once per process (about 0.1-0.6 s; the MCP server
  keeps it loaded). If it isn't installed or downloaded, or the provider is down or slow (10 s
  query timeout), search is keyword-only and
  query embedding is skipped for 60 s. The worker logs the error once. A
  misconfiguration (unknown provider, missing key) is logged and leaves search
  keyword-only. `COPILOT_MEM_EMBED_PROVIDER=off` disables the feature.
- The similarity scan is brute force over the filtered observations, which is
  fine for thousands of observations.

## Recall MCP server

`copilot-mem mcp` is a stdio MCP server over the observations. It follows
claude-mem's three-step pattern so the agent spends little context:

1. `search`: a compact index (`#id  date  type  title  [project]`). It does
   keyword search over title, subtitle, narrative, facts, concepts and files using SQLite FTS5
   with porter stemming. Results are ranked by bm25 and words are OR-ed, so
   documents matching more terms rank higher. With
   [semantic search](#semantic-search) available, keyword and meaning-based
   rankings are fused. Without a query it lists the newest observations. Filters: `project`, `type`, `dateStart`, `dateEnd`,
   `limit`, `offset`.
2. `timeline`: observations before and after an anchor ID (or the best match
   for a query), in time order. It is limited to the anchor's project unless
   `project` is given.
3. `get_observations`: full narrative, facts, files, branch, session and
   turn range for up to 50 IDs.

`summaries` (`project`, `session_id`, `limit`) returns session recaps, newest
first.

It also has `remember` (`title`, `text`, optional `facts`, `files`,
`project`). The agent calls it when you ask it to remember something. Notes
are observations of type `note`, which compression never produces or
changes. They belong to the current repository, or to the git root or
directory when no repository is recorded (the server runs in the session's
directory), or to an explicit `project`. Notes are searchable, appear in
session-start context and the dashboard (labeled "saved by you"), and are
embedded for semantic search. `copilot-mem remember <title> <text> [--fact F]...
[--file F]... [--project P]` does the same from a shell.

- `project` is a repository (`owner/name`) or a directory. A directory also
  matches sessions in its subdirectories.
- Dates are when the summarized turns happened, not when they were compressed.
- Query text is always treated as words, never as FTS syntax, so input like
  `example_diff.py` or `NEAR(` can't cause a syntax error.

`install` registers it. To try it for one Copilot session without changing
your config:

```bash
cat > /tmp/copilot-mem-mcp.json <<JSON
{"mcpServers": {"copilot-mem": {"type": "local", "command": "$(which bun)",
  "args": ["$PWD/src/cli.ts", "mcp"], "tools": ["*"]}}}
JSON
copilot --additional-mcp-config @/tmp/copilot-mem-mcp.json
```

Copilot exposes the tools as `copilot-mem-search`, `copilot-mem-timeline`,
`copilot-mem-get_observations`, `copilot-mem-summaries` and `copilot-mem-remember`.

## VS Code

VS Code's Copilot agent (Local harness) reads `~/.copilot/mcp-config.json`,
`~/.copilot/skills/` and `~/.copilot/hooks/*.json`, the same files `install`
writes. So the recall tools, the skill and the session-start context work
there too, with nothing extra installed. Copilot sessions on VS Code's Agent
Host use the Copilot CLI hook implementation directly.

- VS Code maps the Copilot-format hook file, but sends its own payload
  (`hook_event_name`, `session_id`, ...) and expects
  `{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ...}}`.
  The hook detects that payload and replies in that format.
- `install` and `status` report detected VS Code and VS Code Insiders installs.
- Memory is only *captured* from Copilot CLI's session store. VS Code chats
  can recall it but don't add to it.
