# copilot-mem

Long-term memory for GitHub Copilot CLI, modeled on
[claude-mem](https://github.com/thedotmack/claude-mem).

copilot-mem remembers what you did in past Copilot sessions: decisions, bug
fixes, features and discoveries. It gives that memory back to Copilot when
you start a new session, so you don't have to explain your project again.

[Quick start](#quick-start) •
[How it works](#how-it-works) •
[Using your memory](#using-your-memory) •
[Dashboard](#dashboard) •
[Configuration](#configuration) •
[Commands](#commands) •
[Troubleshooting](#troubleshooting)

---

## Quick start

You need [Bun](https://bun.sh) 1.4+ (or Node.js 26+) and Copilot CLI, signed in.
From the copilot-mem folder:

```bash
bun install && bun run build
node dist/copilot-mem.js install
```

That's it. Start a new `copilot` session and memory works automatically.

`install` finds Copilot CLI and sets up copilot-mem for it (the MCP server, a
skill and hooks), then copies itself to `~/.copilot-mem/`. Run it again after
you upgrade.

To get the `copilot-mem` command in your shell:

```bash
alias copilot-mem="node ~/.copilot-mem/lib/copilot-mem.js"   # add to ~/.zshrc
copilot-mem status       # check everything is installed
copilot-mem viewer --open  # open the dashboard
```

**Optional: smarter search.** Run `copilot-mem embed --setup` once. It installs
a small embedding model that runs inside copilot-mem (about 350 MB of disk, no
server needed). Search then also finds results by meaning, not just by keyword.
It runs locally and costs nothing.

**Optional: backfill your history.** By default copilot-mem summarizes new
sessions a little at a time. To summarize older sessions now, run
`copilot-mem compress --limit 20`. This spends AI credits (see [Cost](#cost)).

## How it works

```
Copilot CLI session ──► session store ──► copilot-mem ──► observations
                        (~/.copilot)       (sync, then      │
                                            compress with    │
                                            Copilot)         ▼
New Copilot session ◄── context at start + search tools ◄── memory.db
```

1. **Capture.** Copilot CLI already saves every conversation. copilot-mem
   reads that store (read-only) after each session. It never slows Copilot
   down: hooks only start a small background worker and exit.
2. **Compress.** The worker asks Copilot (`claude-haiku-5.5`) to turn the raw
   conversation into short **observations**, e.g. *"bugfix: retry OTLP export
   with backoff"*, with facts and files. Finished sessions also get a
   one-paragraph summary.
3. **Recall.** When you start a new session in a project, Copilot gets a short
   recap (at most 3,000 characters): your pinned items, the last session's
   summary, your notes and recent observations. During the session Copilot can
   search the full memory with MCP tools.

Everything stays on your machine in `~/.copilot-mem/memory.db`.

Terms you'll see:

- **Turn**: one prompt and Copilot's reply.
- **Session**: one Copilot CLI conversation, made of turns.
- **Observation**: one remembered item, compressed from a few turns.
- **Project**: a repository (`owner/name`), or a directory outside git.

## Using your memory

Mostly you don't have to do anything. Copilot sees the recap at the start of
each new session, and searches memory when it needs more. You can also ask it
directly:

> *"What did we decide about the retry logic last week?"*
> *"Search memory for the OTLP port issue."*
> *"Remember that this repo uses pnpm workspaces."*
> *"Bookmark that answer."*

Copilot uses these tools (they are prefixed `copilot-mem-`):

| Tool | What it does |
|---|---|
| `search` | Find observations by keyword and meaning; returns a short list of IDs |
| `timeline` | Show what happened before and after an observation |
| `get_observations` | Full details for chosen IDs |
| `summaries` | Session recaps |
| `remember` | Save a note you asked for |
| `bookmark` | Save Copilot's previous answer word for word |

Searching first and fetching details only for the right IDs keeps Copilot's
context small, the same approach claude-mem uses.

**Bookmarks.** When an answer is worth keeping exactly as written, say
*"bookmark that"* (or run `copilot-mem bookmark`, or click ☆ next to a turn in
the dashboard). The question and answer are saved word for word, with the
repository, path and branch they came from. Bookmarks are global: search
finds them from any project. They are not added to the session-start recap.

**Related projects.** If you often work on two repos together (say an app and
its API), link them so each one's recap includes the other's recent work:

```bash
copilot-mem link owner/app owner/api
```

**VS Code.** VS Code's Copilot agent reads the same `~/.copilot` setup, so the
recap and the search tools work there too. Only Copilot CLI conversations are
*saved* to memory, though.

## Dashboard

```bash
copilot-mem viewer --open    # http://127.0.0.1:37778
```

A local web page to browse and manage your memory:

- **Search** observations and **sessions**, filter by project, type and date.
- **Open an observation** to see its facts, files, and the conversation it
  came from.
- **Pin** important observations so they always appear in the recap; **Edit**
  or **Delete** wrong ones; add a **+ Note**; ☆ a session turn to bookmark
  its answer.
- **Context** previews the exact recap a new session in a project would get.
- **Activity** shows a heatmap of your work; **Export** downloads what you
  filtered as Markdown (handy for a work summary).
- **Sessions used memory** shows whether Copilot actually got and used memory.
- **AI credits used** shows what compression has cost and what the pending
  backlog would cost.
- **Compress** summarizes pending conversations now, for one project or all.
- **Settings** shows your settings, health checks and linked projects.

It only listens on `127.0.0.1`.

## Configuration

Settings live in `~/.copilot-mem/settings.json` (created by `install`). Edit it
at any time; new sessions pick up changes. An environment variable with the
same name overrides the file. `copilot-mem settings` shows what's in effect.

| Setting | Default | What it does |
|---|---|---|
| `COPILOT_MEM_AUTO_COMPRESS` | `5` | Copilot calls the background worker may make each run; `0` turns automatic summarizing off |
| `COPILOT_MEM_MODEL` | `claude-haiku-5.5` | Model used to summarize |
| `COPILOT_MEM_EMBED_PROVIDER` | `local` | Meaning-based search: `local`, `ollama`, `openai`, `voyage`, `cohere`, `jina` or `off` |
| `COPILOT_MEM_EMBED_MODEL` | provider default | `local`: `Xenova/bge-small-en-v1.5` (English), `Xenova/all-MiniLM-L6-v2` (smaller) `Xenova/multilingual-e5-small` or `Xenova/bge-m3` (~100 languages); ollama: `bge-m3` |
| `COPILOT_MEM_EMBED_URL` | provider default | Endpoint, e.g. a local OpenAI-compatible server; for `local`, a Hugging Face mirror |
| `COPILOT_MEM_EMBED_API_KEY` | none | Needed for voyage, cohere and jina |
| `COPILOT_MEM_COPILOT_BIN` | `copilot` on PATH | Copilot CLI binary |
| `COPILOT_MEM_SOURCE_DB` | `~/.copilot/session-store.db` | Copilot's session store |

`COPILOT_HOME` (default `~/.copilot`) and `COPILOT_MEM_DATA_DIR` (default
`~/.copilot-mem`) can only be set as environment variables.

> Cloud embedding providers receive the text of your memories. Use `local` or
> ollama to keep everything on your machine.

### Cost

Summarizing uses `claude-haiku-5.5`. Each call costs about 0.16 AI credits
and covers several turns (on legacy premium-request billing, one premium
request). The background worker
makes at most 5 calls per run. `copilot-mem stats` and the dashboard show the
real usage. Search, the dashboard and local or ollama embeddings cost nothing.

## Commands

| Command | What it does |
|---|---|
| `copilot-mem install` / `uninstall` | Set up or remove the integration (uninstall keeps your memory) |
| `copilot-mem status` | Check installation, memory counts and the worker |
| `copilot-mem viewer --open` | Open the dashboard |
| `copilot-mem compress --limit N` | Summarize pending turns now (at most N Copilot calls) |
| `copilot-mem summarize` | Summarize finished older sessions |
| `copilot-mem remember "title" "text"` | Save a note |
| `copilot-mem bookmark [--title T] [--back N]` / `bookmarks [query]` | Bookmark the latest Copilot answer / list bookmarks |
| `copilot-mem link A B` / `unlink A B` / `links` | Manage related projects |
| `copilot-mem embed [--setup]` | Embed all observations for meaning-based search (`--setup` installs the local model first) |
| `copilot-mem settings` | Show settings and where each comes from |
| `copilot-mem stats` | Counts and AI-credit usage |
| `copilot-mem sync` | Pull new sessions now (the worker does this for you) |

Run `copilot-mem` without arguments for every option.

## Troubleshooting

- **No recap in new sessions.** Run `copilot-mem status`; `integration`
  should show the MCP server, skill and hooks. Recaps only appear in *new*
  sessions (not resumed ones), and only once the project has observations.
- **Nothing is being summarized.** Check `~/.copilot-mem/worker.log` (also at
  the bottom of the dashboard), and that `COPILOT_MEM_AUTO_COMPRESS` isn't `0`.
  The latest turn of a session is saved by Copilot only when you send the next
  prompt or end the session.
- **Search only matches keywords.** Run `copilot-mem embed --setup` (or, with
  `COPILOT_MEM_EMBED_PROVIDER=ollama`, start ollama and `ollama pull bge-m3`,
  then `copilot-mem embed`). The dashboard's Settings view shows what is
  missing. Restart the dashboard after changing search settings.
- **Start over.** `copilot-mem uninstall`, then delete `~/.copilot-mem`.

## Limitations

- macOS and Linux only.
- Only Copilot CLI conversations are saved; VS Code chats can use memory but
  aren't recorded.
- There's no `<private>` tag like claude-mem's: everything in a conversation
  can be summarized. Deleting an observation removes it from search and the
  recap, but the raw conversation stays in `memory.db`.

## Development

```bash
bun install
bun run test          # Bun test runner
bun run test:node     # same tests on Node
bun run typecheck
bun run bench         # compare embedding models (docs/embedding-benchmark.md)
bun src/cli.ts <command>   # run from source
npm pack              # build a tarball with a copilot-mem command
```

[docs/how-it-works.md](docs/how-it-works.md) covers the details: what install
writes, the background worker, sync and compression internals, duplicate
detection, ranking, semantic search, the MCP tools, VS Code and the dashboard.

## License

Apache-2.0 (see [LICENSE](LICENSE)). Parts are adapted from
[claude-mem](https://github.com/thedotmack/claude-mem); see [NOTICE](NOTICE).
