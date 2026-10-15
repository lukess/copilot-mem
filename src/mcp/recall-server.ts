import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { QueryEmbedder, QueryVector } from '../search/embeddings.ts';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { bookmarkAnswer } from '../bookmark.ts';
import { formatSummary } from '../compress/summary.ts';
import { MAX_FACTS, MAX_TEXT, MAX_TITLE, rememberNote } from '../remember.ts';
import {
  MANUAL_SESSION_PREFIX,
  OBSERVATION_TYPES,
  type MemoryStore,
  type ObservationDetail,
  type ObservationSummary,
  type ObservationType,
} from '../storage/memory-store.ts';

const MAX_IDS = 50;

export const INSTRUCTIONS = `copilot-mem is long-term memory of past GitHub Copilot CLI sessions: decisions, bug fixes,
features, and discoveries summarized from earlier conversations. Use it when the user refers to
earlier work or when past context would help. Work in three steps to save context:
1. search -> a compact index of matching observation IDs
2. timeline -> what happened around an interesting ID
3. get_observations -> full details, only for the IDs you need
summaries gives per-session recaps (request, what was done, next steps): useful to resume earlier work.
When the user asks you to remember something, save it with remember (type "note").
When the user asks to bookmark or keep an answer you gave, call bookmark: it saves your previous answer word for word.`;

const PROJECT_PROP = {
  type: 'string',
  description: 'Limit to a repository ("owner/name") or a directory (also matches sessions in its subdirectories)',
};

const TOOLS = [
  {
    name: 'search',
    description:
      'Step 1: search memory of past Copilot CLI sessions. Returns a compact index (ID, date, type, title, project); ' +
      'fetch details with get_observations. Without a query, lists the newest observations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords; results matching more of them rank higher' },
        project: { ...PROJECT_PROP, description: `${PROJECT_PROP.description}, plus projects the user linked to it` },
        type: { type: 'string', enum: [...OBSERVATION_TYPES], description: 'Only this observation type' },
        dateStart: { type: 'string', description: 'Earliest date, ISO (e.g. 2026-09-01)' },
        dateEnd: { type: 'string', description: 'Latest date, ISO; a bare date includes that whole day' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 20)' },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many results (default 0)' },
      },
    },
  },
  {
    name: 'timeline',
    description:
      'Step 2: observations just before and after an anchor, in time order, within the same project. ' +
      'Give an anchor ID from search, or a query to use the best match as the anchor.',
    inputSchema: {
      type: 'object',
      properties: {
        anchor: { type: 'integer', description: 'Observation ID to center on' },
        query: { type: 'string', description: 'Used to find the anchor when no anchor ID is given' },
        depth_before: { type: 'integer', minimum: 0, maximum: 50, description: 'Observations before the anchor (default 3)' },
        depth_after: { type: 'integer', minimum: 0, maximum: 50, description: 'Observations after the anchor (default 3)' },
        project: { ...PROJECT_PROP, description: `${PROJECT_PROP.description}; defaults to the anchor's project` },
      },
    },
  },
  {
    name: 'get_observations',
    description: `Step 3: full details (narrative, facts, files, session) for observation IDs from search or timeline. At most ${MAX_IDS} IDs.`,
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: MAX_IDS, description: 'Observation IDs' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'summaries',
    description:
      'Recaps of past Copilot CLI sessions, newest first: what was requested, investigated, learned and completed, and next steps. ' +
      'Use to pick up where earlier work left off. Observation search covers the details.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PROP,
        session_id: { type: 'string', description: 'Only this session (session IDs appear in get_observations)' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max sessions (default 5)' },
      },
    },
  },
  {
    name: 'remember',
    description:
      'Save a note to long-term memory when the user explicitly asks to remember something (a preference, convention, ' +
      'decision or fact). Stored as type "note" for the project; found by search in later sessions and never changed by compression.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: MAX_TITLE, description: 'Short, specific title' },
        text: { type: 'string', maxLength: MAX_TEXT, description: 'The note itself, self-contained' },
        facts: { type: 'array', items: { type: 'string' }, maxItems: MAX_FACTS, description: 'Optional short facts' },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional related file paths' },
        project: {
          type: 'string',
          description: 'Repository ("owner/name") or absolute directory; defaults to the current repository or directory',
        },
      },
      required: ['title', 'text'],
    },
  },
  {
    name: 'bookmark',
    description:
      'Bookmark an answer from this session when the user asks to bookmark, star or keep it. Saves the question and your ' +
      'answer word for word (no rewriting), with the repository and path; search finds bookmarks from any project.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: MAX_TITLE, description: 'Short title; defaults to the first line of the question' },
        back: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Which earlier answer: 1 (default) is the answer just before the bookmark request, 2 the one before that',
        },
      },
    },
  },
];

class ArgumentError extends Error {}

type Args = Record<string, unknown>;

function optString(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ArgumentError(`${key} must be a string`);
  return value.trim() || undefined;
}

// Models sometimes send numbers as strings; accept those too.
function toInt(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) ? n : undefined;
}

function optInt(args: Args, key: string, fallback: number, min: number, max: number): number {
  if (args[key] === undefined || args[key] === null) return fallback;
  const n = toInt(args[key]);
  if (n === undefined) throw new ArgumentError(`${key} must be an integer`);
  return Math.min(Math.max(n, min), max);
}

function optType(args: Args): ObservationType | undefined {
  const value = optString(args, 'type');
  if (value === undefined) return undefined;
  if (!(OBSERVATION_TYPES as readonly string[]).includes(value)) {
    throw new ArgumentError(`type must be one of: ${OBSERVATION_TYPES.join(', ')}`);
  }
  return value as ObservationType;
}

function optDate(args: Args, key: string): string | undefined {
  const value = optString(args, key);
  if (value !== undefined && Number.isNaN(Date.parse(value))) throw new ArgumentError(`${key} must be an ISO date`);
  return value;
}

function idList(args: Args): number[] {
  const list = Array.isArray(args.ids) ? args.ids : [args.ids];
  const parsed = list.map(toInt);
  if (parsed.length === 0 || parsed.some((id) => id === undefined)) {
    throw new ArgumentError('ids must be a non-empty array of integer observation IDs');
  }
  if (parsed.length > MAX_IDS) throw new ArgumentError(`at most ${MAX_IDS} ids per call`);
  return [...new Set(parsed as number[])];
}

function stringList(args: Args, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new ArgumentError(`${key} must be an array of strings`);
  return value as string[];
}

function projectOf(o: ObservationSummary): string {
  return o.repository ?? o.cwd ?? 'unknown project';
}

function line(o: ObservationSummary, marker = ''): string {
  return `${marker}#${o.id}  ${o.occurred_at.slice(0, 10)}  ${o.type.padEnd(9)}  ${o.title}  [${projectOf(o)}]`;
}

function detail(o: ObservationDetail): string {
  const turns = o.first_turn === o.last_turn ? `turn ${o.first_turn}` : `turns ${o.first_turn}-${o.last_turn}`;
  const source = o.session_id.startsWith(MANUAL_SESSION_PREFIX)
    ? 'saved by the user'
    : `${o.type === 'bookmark' ? 'bookmarked from ' : ''}session ${o.session_id}, ${turns}`;
  if (o.type === 'bookmark') {
    // The answer is shown exactly as saved; the question replaces the truncated subtitle.
    return [`#${o.id} [bookmark] ${o.title}`, `when: ${o.occurred_at} | project: ${projectOf(o)}${o.cwd && o.cwd !== projectOf(o) ? ` | path: ${o.cwd}` : ''}${o.branch ? ` (branch ${o.branch})` : ''} | ${source}`, `Question:\n${o.question ?? o.subtitle ?? ''}`, `Answer:\n${o.narrative}`].join('\n');
  }
  const parts = [
    `#${o.id} [${o.type}] ${o.title}${o.subtitle ? ` | ${o.subtitle}` : ''}`,
    `when: ${o.occurred_at} | project: ${projectOf(o)}${o.branch ? ` (branch ${o.branch})` : ''} | ${source}`,
    o.narrative,
  ];
  if (o.facts.length) parts.push(`Facts:\n${o.facts.map((f) => `- ${f}`).join('\n')}`);
  if (o.concepts.length) parts.push(`Concepts: ${o.concepts.join(', ')}`);
  if (o.files.length) parts.push(`${o.type === 'note' ? 'Files' : 'Files modified'}: ${o.files.join(', ')}`);
  if (o.files_read.length) parts.push(`Files read: ${o.files_read.join(', ')}`);
  if (o.touched_files.length) {
    parts.push(`Files touched in these turns: ${o.touched_files.map((f) => (f.tool ? `${f.path} (${f.tool})` : f.path)).join(', ')}`);
  }
  if (o.refs.length) parts.push(`Session refs: ${o.refs.map((r) => `${r.type} ${r.value}`).join(', ')}`);
  if (o.occurrences > 1) parts.push(`Seen ${o.occurrences} times (last ${o.last_seen_at ?? 'unknown'})`);
  if (o.similar.length) {
    parts.push(`Possible duplicates: ${o.similar.map((s) => `#${s.id} ${s.title} (${s.score.toFixed(2)})`).join('; ')}`);
  }
  return parts.join('\n');
}

const text = (body: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: body }], isError });

/** The Copilot session the server runs in, for bookmark. */
export interface CurrentSession {
  id?: string;
  stateDir: string;
}

/**
 * `vector` is the embedded `query` (search/timeline), enabling hybrid keyword + semantic ranking.
 * `cwd` picks the default project for remember (Copilot starts the server in the session's directory).
 */
export function callRecallTool(
  store: MemoryStore,
  name: string,
  args: Args = {},
  vector?: QueryVector,
  cwd = process.cwd(),
  session?: CurrentSession,
): CallToolResult {
  try {
    switch (name) {
      case 'search': {
        const query = optString(args, 'query');
        const offset = optInt(args, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
        const project = optString(args, 'project');
        const results = store.searchObservations({
          query,
          project: project === undefined ? undefined : [project, ...store.linkedProjects([project])],
          type: optType(args),
          dateStart: optDate(args, 'dateStart'),
          dateEnd: optDate(args, 'dateEnd'),
          limit: optInt(args, 'limit', 20, 1, 100),
          offset,
        }, vector);
        const what = query === undefined ? 'recent observations' : `matches for "${query}"`;
        if (results.length === 0) return text(`No ${what}${offset ? ` after offset ${offset}` : ''}.`);
        return text(
          `${results.length} ${what} (get_observations for details, timeline for context):\n` +
            results.map((o) => line(o)).join('\n'),
        );
      }
      case 'timeline': {
        const project = optString(args, 'project');
        let anchor = args.anchor === undefined || args.anchor === null ? undefined : optInt(args, 'anchor', 0, 0, Number.MAX_SAFE_INTEGER);
        if (anchor === undefined) {
          const query = optString(args, 'query');
          if (query === undefined) throw new ArgumentError('give an anchor ID or a query');
          anchor = store.searchObservations({ query, project, limit: 1, offset: 0 }, vector)[0]?.id;
          if (anchor === undefined) return text(`No matches for "${query}".`);
        }
        const rows = store.observationTimeline(
          anchor,
          optInt(args, 'depth_before', 3, 0, 50),
          optInt(args, 'depth_after', 3, 0, 50),
          project,
        );
        if (!rows) return text(`No observation #${anchor}.`, true);
        return text(
          `Timeline around #${anchor} (oldest first; > marks the anchor):\n` +
            rows.map((o) => line(o, o.id === anchor ? '> ' : '  ')).join('\n'),
        );
      }
      case 'get_observations': {
        const wanted = idList(args);
        const found = store.getObservations(wanted);
        const missing = wanted.filter((id) => !found.some((o) => o.id === id));
        const body = found.map(detail).join('\n\n---\n\n');
        const note = missing.length ? `Not found: ${missing.map((id) => `#${id}`).join(', ')}` : '';
        return text([body, note].filter(Boolean).join('\n\n'), found.length === 0);
      }
      case 'summaries': {
        const found = store.summaries({
          project: optString(args, 'project'),
          sessionId: optString(args, 'session_id'),
          limit: optInt(args, 'limit', 5, 1, 20),
        });
        if (found.length === 0) return text('No session summaries yet (sessions are summarized after they have been idle for 30 minutes).');
        return text(found.map(formatSummary).join('\n\n---\n\n'));
      }
      case 'remember': {
        const title = optString(args, 'title');
        const body = optString(args, 'text');
        if (title === undefined || body === undefined) throw new ArgumentError('title and text are required');
        let saved;
        try {
          saved = rememberNote(store, {
            title,
            text: body,
            facts: stringList(args, 'facts'),
            files: stringList(args, 'files'),
            project: optString(args, 'project'),
          }, cwd);
        } catch (error) {
          if (error instanceof ArgumentError) throw error;
          throw new ArgumentError((error as Error).message);
        }
        return text(`Saved note #${saved.id} for ${saved.project}.`);
      }
      case 'bookmark': {
        const title = optString(args, 'title');
        const back = optInt(args, 'back', 1, 1, 50);
        if (!session?.id) return text('Cannot bookmark: the Copilot session ID is unknown (COPILOT_AGENT_SESSION_ID is not set).', true);
        let saved;
        try {
          saved = bookmarkAnswer(store, { sessionId: session.id, title, skipCurrent: true, back, sessionStateDir: session.stateDir });
        } catch (error) {
          return text(`Cannot bookmark: ${(error as Error).message}`, true);
        }
        return text(`${saved.created ? 'Bookmarked' : saved.title === title ? 'Already bookmarked; renamed' : 'Already bookmarked'}: #${saved.id} "${saved.title}" (${saved.project}, turn ${saved.turnIndex}).`);
      }
      default:
        return text(`Unknown tool: ${name}`, true);
    }
  } catch (error) {
    if (error instanceof ArgumentError) return text(`Invalid arguments: ${error.message}`, true);
    throw error;
  }
}

export function createRecallServer(store: MemoryStore, version: string, embedQuery?: QueryEmbedder, session?: CurrentSession): Server {
  const server = new Server({ name: 'copilot-mem', version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const query = typeof args.query === 'string' && (name === 'search' || name === 'timeline') ? args.query : undefined;
    const vector = query && embedQuery ? await embedQuery(query) : undefined;
    return callRecallTool(store, name, args, vector, process.cwd(), session);
  });
  return server;
}
