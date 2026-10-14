import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildSessionContext, CONTEXT_BUDGET } from '../hooks/context.ts';
import { linkProjects, unlinkProjects } from '../links.ts';
import type { QueryEmbedder } from '../search/embeddings.ts';
import { tailLines, workerState, type SettingsReport } from '../status.ts';
import { OBSERVATION_TYPES, type MemoryStore, type ObservationType } from '../storage/memory-store.ts';
import type { WorkerFiles } from '../worker/worker.ts';
import { MAX_FACTS, MAX_TEXT, MAX_TITLE, rememberNote } from '../remember.ts';
import { exportMarkdown } from './export.ts';
import { VIEWER_HTML } from './page.ts';

export const DEFAULT_VIEWER_PORT = 37778; // claude-mem's viewer uses 37777
const LOG_LINES = 40;
export const MAX_COMPRESS_CALLS = 500;
/** Custom header a cross-site page can't send without a CORS preflight (which we never grant). */
export const ACTION_HEADER = 'x-copilot-mem-action';
const HEARTBEAT_MS = 15_000;

export interface ViewerOptions {
  port: number;
  files: WorkerFiles;
  openStore: () => MemoryStore;
  status: () => Record<string, unknown>;
  /** Starts a compression run of at most `limit` Copilot calls (optionally one project); omitted = disabled. */
  compress?: (limit: number, project?: string) => Promise<void>;
  log?: (message: string) => void;
  pollMs?: number;
  /** Embeds search text for hybrid keyword + semantic search; omitted = keyword only. */
  embedQuery?: QueryEmbedder;
  /** Effective settings and embedding model for the Settings view; omitted = not shown. */
  settings?: () => SettingsReport;
}

export interface Viewer {
  url: string;
  port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function intParam(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = params.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new HttpError(400, `${name} must be an integer in ${min}..${max}`);
  return value;
}

/** An ISO date (2026-09-01) or timestamp; the dashboard sends local-day boundaries as UTC timestamps. */
function dateParam(params: URLSearchParams, name: string): string | undefined {
  const raw = params.get(name)?.trim();
  if (!raw) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new HttpError(400, `${name} must be an ISO date or timestamp`);
  }
  return raw;
}

function typeParam(params: URLSearchParams): ObservationType | undefined {
  const type = params.get('type') || undefined;
  if (type && !OBSERVATION_TYPES.includes(type as ObservationType)) throw new HttpError(400, `unknown type: ${type}`);
  return type as ObservationType | undefined;
}

const MAX_BODY_BYTES = 64 * 1024;

/** Mutations need the action header (a cross-site page can't send it without a CORS preflight) and a same-origin Origin. */
function checkAction(req: IncomingMessage, port: number): void {
  if (req.headers[ACTION_HEADER] !== '1') throw new HttpError(403, `missing ${ACTION_HEADER} header`);
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
    throw new HttpError(403, 'forbidden origin');
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'body must be a JSON object');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
  return body as Record<string, unknown>;
}

function text(body: Record<string, unknown>, key: string, max: number, required: boolean): string {
  const value = body[key] ?? '';
  if (typeof value !== 'string') throw new HttpError(400, `${key} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new HttpError(400, `${key} is required`);
  if (trimmed.length > max) throw new HttpError(400, `${key} must be at most ${max} characters`);
  return trimmed;
}

function factList(body: Record<string, unknown>): string[] {
  const facts = body.facts ?? [];
  if (!Array.isArray(facts) || facts.some((f) => typeof f !== 'string' || f.length > MAX_TEXT)) {
    throw new HttpError(400, 'facts must be an array of strings');
  }
  const kept = (facts as string[]).map((f) => f.trim()).filter(Boolean);
  if (kept.length > MAX_FACTS) throw new HttpError(400, `at most ${MAX_FACTS} facts`);
  return kept;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * Dashboard over memory.db. Writes only on explicit actions (compress; add notes; edit, pin, delete observations). Listens on loopback only and rejects foreign Host headers
 * (DNS rebinding), since the database holds raw conversation text.
 */
export async function startViewer(options: ViewerOptions): Promise<Viewer> {
  const store = options.openStore();
  const clients = new Set<ServerResponse>();
  let lastSnapshot = '';
  let sinceHeartbeat = 0;
  let compressing = false;

  const snapshot = () => {
    return JSON.stringify({
      counts: store.counts(),
      latestObservationId: store.latestObservationId(),
      latestCallId: store.latestCallId(),
      worker: workerState(options.files),
      canCompress: Boolean(options.compress),
      compressRequested: compressing,
      log: tailLines(options.files.log, LOG_LINES),
    });
  };

  const pollMs = options.pollMs ?? 2000;
  const timer = setInterval(() => {
    if (clients.size === 0) return;
    let next: string;
    try {
      next = snapshot();
    } catch (error) {
      (options.log ?? (() => {}))(`viewer: snapshot failed: ${(error as Error).message}`);
      return;
    }
    sinceHeartbeat += pollMs;
    if (next !== lastSnapshot) {
      lastSnapshot = next;
      sinceHeartbeat = 0;
      for (const client of clients) client.write(`event: snapshot\ndata: ${next}\n\n`);
    } else if (sinceHeartbeat >= HEARTBEAT_MS) {
      sinceHeartbeat = 0;
      for (const client of clients) client.write(': ping\n\n');
    }
  }, pollMs);

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { port } = server.address() as AddressInfo;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      throw new HttpError(403, 'forbidden host');
    }
    if (req.method === 'POST' && req.url === '/api/compress') return startCompress(req, res, port);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST') return mutate(req, res, url.pathname, port);
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
    const params = url.searchParams;

    if (url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      });
      res.end(VIEWER_HTML);
      return;
    }
    if (url.pathname === '/api/status') return sendJson(res, 200, options.status());
    if (url.pathname === '/api/projects') return sendJson(res, 200, store.projects());
    if (url.pathname === '/api/stats') return sendJson(res, 200, store.compressStats());
    if (url.pathname === '/api/observations') {
      const query = params.get('q')?.trim() || undefined;
      const filter = {
        query,
        project: params.get('project') || undefined,
        type: typeParam(params),
        dateStart: dateParam(params, 'from'),
        dateEnd: dateParam(params, 'to'),
        pinned: params.get('pinned') === '1',
        limit: intParam(params, 'limit', 50, 1, 200),
        offset: intParam(params, 'offset', 0, 0, 1_000_000),
      };
      const vector = query && options.embedQuery ? await options.embedQuery(query) : undefined;
      if (res.destroyed) return;
      return sendJson(res, 200, store.searchObservations(filter, vector));
    }
    const detail = /^\/api\/observations\/(\d+)$/.exec(url.pathname);
    if (detail) {
      const id = Number(detail[1]);
      const [observation] = store.getObservations([id]);
      if (!observation) throw new HttpError(404, `no observation #${id}`);
      const [summary] = store.summaries({ sessionId: observation.session_id, limit: 1 });
      return sendJson(res, 200, { observation, timeline: store.observationTimeline(id, 3, 3) ?? [], summary: summary ?? null });
    }
    if (url.pathname === '/api/recall') return sendJson(res, 200, store.recallOverview(params.get('project') || undefined));
    if (url.pathname === '/api/sessions') {
      return sendJson(
        res,
        200,
        store.sessions({
          project: params.get('project') || undefined,
          query: params.get('q')?.trim() || undefined,
          recallOnly: params.get('recall') === '1',
          dateStart: dateParam(params, 'from'),
          dateEnd: dateParam(params, 'to'),
          limit: intParam(params, 'limit', 50, 1, 200),
          offset: intParam(params, 'offset', 0, 0, 1_000_000),
        }),
      );
    }
    const session = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (session) {
      const id = decodeURIComponent(session[1]);
      const found = store.sessionDetail(id);
      if (!found) throw new HttpError(404, `no session ${id}`);
      return sendJson(res, 200, found);
    }
    if (url.pathname === '/api/activity') {
      const since = dateParam(params, 'since') ?? new Date(Date.now() - 366 * 86_400_000).toISOString();
      return sendJson(res, 200, store.activity({ project: params.get('project') || undefined, since }));
    }
    if (url.pathname === '/api/export') {
      const filter = {
        project: params.get('project') || undefined,
        query: params.get('q')?.trim() || undefined,
        type: typeParam(params),
        dateStart: dateParam(params, 'from'),
        dateEnd: dateParam(params, 'to'),
        pinned: params.get('pinned') === '1',
        from: dateParam(params, 'fromLabel'),
        to: dateParam(params, 'toLabel'),
      };
      const name = ['copilot-mem', filter.project, filter.from, filter.to].filter(Boolean).join('-').replace(/[^\w.-]+/g, '_');
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${name}.md"`,
        'cache-control': 'no-store',
      });
      res.end(exportMarkdown(store, filter));
      return;
    }
    if (url.pathname === '/api/context') {
      // What the sessionStart hook would inject for a session started in this project now.
      const project = params.get('project');
      if (!project) throw new HttpError(400, 'project is required');
      const cwd = project.startsWith('/') ? project : store.cwdForRepository(project);
      if (!cwd) throw new HttpError(404, `no known directory for ${project}`);
      const text = buildSessionContext(store, cwd);
      return sendJson(res, 200, { project, cwd, text, chars: text.length, budget: CONTEXT_BUDGET });
    }
    if (url.pathname === '/api/settings') {
      const report = options.settings?.() ?? null;
      const model = report?.embedding.model;
      return sendJson(res, 200, {
        settings: report && { path: report.path, exists: report.exists, values: report.settings },
        embedding: report && {
          ...report.embedding,
          embedded: model ? store.embeddingCount(model) : 0,
          observations: store.counts().observations,
        },
        links: store.projectLinks(),
      });
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: snapshot\ndata: ${snapshot()}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    throw new HttpError(404, 'not found');
  };

  /** Dashboard curation: add notes; edit, pin and delete observations; link and unlink projects. */
  const mutate = async (req: IncomingMessage, res: ServerResponse, path: string, port: number): Promise<void> => {
    const target = /^\/api\/observations\/(\d+)(?:\/(pin|delete))?$/.exec(path);
    const links = path === '/api/links' || path === '/api/links/delete';
    if (path !== '/api/notes' && !links && !target) throw new HttpError(405, 'method not allowed');
    checkAction(req, port);
    const body = await readJson(req);
    const now = new Date().toISOString();
    if (links) {
      const projects = body.projects;
      if (!Array.isArray(projects) || projects.length > 20 || !projects.every((p) => typeof p === 'string' && p.length <= 4096)) {
        throw new HttpError(400, 'projects must be a list of up to 20 project names');
      }
      let message: string;
      try {
        message = path === '/api/links' ? linkProjects(store, projects, now) : unlinkProjects(store, projects);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
      (options.log ?? (() => {}))(`viewer: ${message.split('\n')[0]}`);
      return sendJson(res, 200, { message, links: store.projectLinks() });
    }
    if (path === '/api/notes') {
      const project = text(body, 'project', 4096, true);
      try {
        const saved = rememberNote(
          store,
          { title: text(body, 'title', MAX_TITLE, true), text: text(body, 'text', MAX_TEXT, true), facts: factList(body), project },
          '/',
          now,
        );
        return sendJson(res, 201, saved);
      } catch (error) {
        throw error instanceof HttpError ? error : new HttpError(400, (error as Error).message);
      }
    }
    const id = Number(target![1]);
    let found: boolean;
    if (target![2] === 'delete') {
      found = store.deleteObservation(id);
    } else if (target![2] === 'pin') {
      if (typeof body.pinned !== 'boolean') throw new HttpError(400, 'pinned must be true or false');
      found = store.setPinned(id, body.pinned, now);
    } else {
      const type = body.type;
      if (typeof type !== 'string' || !OBSERVATION_TYPES.includes(type as ObservationType)) throw new HttpError(400, `unknown type: ${String(type)}`);
      found = store.updateObservation(
        id,
        {
          type: type as ObservationType,
          title: text(body, 'title', MAX_TITLE, true),
          subtitle: text(body, 'subtitle', MAX_TITLE * 2, false),
          narrative: text(body, 'narrative', MAX_TEXT, true),
          facts: factList(body),
        },
        now,
      );
    }
    if (!found) throw new HttpError(404, `no observation #${id}`);
    (options.log ?? (() => {}))(`viewer: observation #${id} ${target![2] === 'delete' ? 'deleted' : target![2] === 'pin' ? (body.pinned ? 'pinned' : 'unpinned') : 'edited'}`);
    return sendJson(res, 200, { id, ok: true });
  };

  const startCompress = (req: IncomingMessage, res: ServerResponse, port: number): void => {
    // Spends AI credits, so only same-origin script may trigger it (CSRF).
    checkAction(req, port);
    if (!options.compress) throw new HttpError(501, 'compression is not available');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        let limit: unknown;
        let project: unknown;
        try {
          ({ limit, project } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          throw new HttpError(400, 'body must be a JSON object');
        }
        if (project !== undefined && (typeof project !== 'string' || project === '' || project.length > 4096)) {
          throw new HttpError(400, 'project must be a non-empty string');
        }
        if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_COMPRESS_CALLS) {
          throw new HttpError(400, `limit must be an integer in 1..${MAX_COMPRESS_CALLS}`);
        }
        if (compressing || workerState(options.files).compressing) throw new HttpError(409, 'a compression is already running');
        compressing = true;
        const log = options.log ?? (() => {});
        log(`viewer: compress requested (up to ${limit} call(s)${project ? ` for ${project}` : ''})`);
        options
          .compress!(limit as number, project as string | undefined)
          .catch((error: Error) => log(`viewer: compress failed: ${error.message}`))
          .finally(() => (compressing = false));
        sendJson(res, 202, { started: true, limit, project: project ?? null });
      } catch (error) {
        sendJson(res, error instanceof HttpError ? error.statusCode : 500, { error: (error as Error).message });
      }
    });
  };

  const server = createServer((req, res) => {
    route(req, res).catch((error: Error) => {
      if (!res.headersSent) sendJson(res, error instanceof HttpError ? error.statusCode : 500, { error: error.message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer);
        for (const client of clients) client.end();
        clients.clear();
        server.close(() => {
          store.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
