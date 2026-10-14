import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { autoCompressLimit } from '../src/config.ts';
import { settingsReport, tailLines } from '../src/status.ts';
import { MemoryStore, type Observation } from '../src/storage/memory-store.ts';
import { startViewer, type Viewer } from '../src/viewer/server.ts';
import { workerFiles } from '../src/worker/worker.ts';

let dir: string;
let dbPath: string;
let writer: MemoryStore;
let viewer: Viewer;
let compressCalls: (number | [number, string])[];
let finishCompress: () => void;
let logged: string[];

function addObservations(sessionId: string, repository: string | null, cwd: string, turn: number, titles: string[]): void {
  const at = `2026-09-0${turn + 1}T00:00:00.000Z`;
  writer.upsertSession({ id: sessionId, cwd, repository, branch: 'main', host_type: null, summary: null, created_at: at, updated_at: at }, at);
  writer.upsertTurn({ session_id: sessionId, turn_index: turn, user_message: 'u', assistant_response: 'a', timestamp: at }, at);
  const observations = titles.map((title): Observation => ({ type: 'decision', title, narrative: `about ${title}`, facts: ['f'], files: ['a.ts'] }));
  writer.completeBatch(sessionId, [turn], observations, 'm', at);
}

async function get(path: string, host?: string): Promise<{ status: number; body: any; type: string }> {
  const res = await fetch(new URL(path, viewer.url), host ? { headers: { host } } : undefined);
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, type, body: type.startsWith('application/json') ? await res.json() : await res.text() };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-mem-viewer-'));
  dbPath = join(dir, 'memory.db');
  writer = new MemoryStore(dbPath);
  addObservations('s1', 'acme/api', '/w/api', 0, ['Use port 4317 for OTLP', 'Retry with backoff']);
  addObservations('s2', null, '/w/scratch', 1, ['Scratch note']);
  writer.upsertTurn({ session_id: 's2', turn_index: 2, user_message: 'u', assistant_response: 'a', timestamp: '2026-09-03T00:00:00.000Z' }, 'x');
  compressCalls = [];
  logged = [];
  viewer = await startViewer({
    port: 0,
    files: workerFiles(dir),
    openStore: () => new MemoryStore(dbPath),
    status: () => ({ version: 'test', integration: { mcpServer: true, skill: true, hooks: true } }),
    compress: (limit, project) => {
      compressCalls.push(project === undefined ? limit : [limit, project]);
      return new Promise<void>((resolve) => (finishCompress = resolve));
    },
    log: (m) => logged.push(m),
    pollMs: 20,
    settings: () => ({
      path: '/x/settings.json',
      exists: true,
      settings: { COPILOT_MEM_MODEL: { value: 'gpt-5-mini', source: 'default' as const } } as any,
      embedding: { model: 'test-model' },
    }),
  });
});

function post(path: string, body: unknown, headers: Record<string, string> = { 'x-copilot-mem-action': '1' }) {
  return fetch(new URL(path, viewer.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

function postCompress(body: unknown, headers: Record<string, string> = { 'x-copilot-mem-action': '1' }) {
  return fetch(new URL('/api/compress', viewer.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

afterEach(async () => {
  await viewer.close();
  writer.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('viewer', () => {
  test('serves the page on loopback with a strict CSP', async () => {
    assert.match(viewer.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const res = await fetch(viewer.url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    const html = await res.text();
    assert.match(html, /<title>copilot-mem<\/title>/);
    assert.doesNotMatch(html, /innerHTML/);
  });

  test('page source is ASCII, so no runtime turns characters into literal \\u escapes in the markup', async () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'viewer', 'page.ts'), 'utf8');
    assert.match(source, /^[\x00-\x7f]*$/, 'use HTML entities in markup and \\u escapes in script');
    const html = await (await fetch(viewer.url)).text();
    const markup = html.slice(0, html.indexOf('<script>'));
    assert.doesNotMatch(markup, /\\u[0-9a-f]{4}/i);
    assert.match(markup, /placeholder="Filter projects&#x2026;"/);
  });

  test('page h() skips null children inside arrays instead of printing "null"', () => {
    const html = readFileSync(join(import.meta.dirname, '..', 'src', 'viewer', 'page.ts'), 'utf8');
    const src = html.slice(html.indexOf('function h(tag, props) {'), html.indexOf('\nfunction api('));
    class FakeNode {
      kids: unknown[] = [];
      className = '';
      append(c: unknown) { this.kids.push(c); }
      replaceChildren() { this.kids = []; }
      setAttribute() {}
      addEventListener() {}
    }
    const document = { createElement: () => new FakeNode() };
    const { h, fill } = new Function('document', 'Node', `${src}; return { h, fill };`)(document, FakeNode);
    const el = h('span', null, 'a', null, [null, 'b', undefined], [h('i', null), null]);
    assert.equal(el.kids.length, 3);
    assert.deepEqual(el.kids.slice(0, 2), ['a', 'b']);

    // Detail views pass optional [heading, list] sections and nulls; they must not print "[object ...]" or "null".
    const box = new FakeNode();
    box.kids = ['stale'];
    const heading = h('h4', null);
    const list = h('ul', null);
    fill(box, 'x', [heading, list], null, [[h('p', null), null], [] as unknown[]], undefined);
    assert.equal(box.kids.length, 4);
    assert.deepEqual(box.kids.slice(0, 3), ['x', heading, list]);
    assert.ok(box.kids.every((k) => k === 'x' || k instanceof FakeNode));

    const calls = html.match(/\.replaceChildren\(/g) ?? [];
    assert.equal(calls.length, 1, 'use fill(), not replaceChildren(), so arrays and nulls render correctly');
  });

  test('lists projects with observation and pending counts, newest first', async () => {
    const { body } = await get('/api/projects');
    assert.deepEqual(
      body.map((p: any) => [p.project, p.turns, p.pendingTurns, p.observations]),
      [['/w/scratch', 2, 1, 1], ['acme/api', 1, 0, 2]],
    );
  });

  test('reports compression time, tokens and AI credits', async () => {
    assert.equal((await get('/api/stats')).body.total.calls, 0);
    writer.recordCall({
      startedAt: new Date().toISOString(), durationMs: 20_000, sessionId: 's1', model: 'gpt-5-mini', status: 'ok', turns: 4,
      observations: 2, promptChars: 9000,
      usage: { apiMs: 15_000, inputTokens: 3000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 200, nanoAiu: 120_000_000, premiumRequests: 0 },
    });
    const { status, body } = await get('/api/stats');
    assert.equal(status, 200);
    assert.equal(body.total.calls, 1);
    assert.equal(body.last24h.credits, 0.12);
    assert.equal(body.total.inputTokens, 3000);
    assert.deepEqual([body.recent[0].project, body.recent[0].durationMs, body.recent[0].credits], ['acme/api', 20_000, 0.12]);
    assert.deepEqual(body.backlog, {
      pendingTurns: 1, calls: 1, credits: 0.03, durationMs: 5000, perTurn: { calls: 0.25, credits: 0.03, durationMs: 5000 },
    });
  });

  test('searches and filters observations, and returns detail with timeline', async () => {
    assert.deepEqual((await get('/api/observations?q=otlp')).body.map((o: any) => o.title), ['Use port 4317 for OTLP']);
    assert.equal((await get('/api/observations?project=acme/api')).body.length, 2);
    assert.equal((await get('/api/observations?limit=1&offset=1')).body.length, 1);
    assert.equal((await get('/api/observations?type=bugfix')).body.length, 0);

    const { body } = await get('/api/observations/1');
    assert.equal(body.observation.title, 'Use port 4317 for OTLP');
    assert.deepEqual(body.observation.files, ['a.ts']);
    assert.deepEqual(body.timeline.map((o: any) => o.id), [1, 2]);
    assert.equal(body.summary, null);
    writer.saveSummary(body.observation.session_id, {
      request: 'r', investigated: '', learned: '', completed: 'c', next_steps: 'n', notes: '',
    }, [1, 2], 'm', '2026-09-01T00:00:00.000Z');
    assert.equal((await get('/api/observations/1')).body.summary.next_steps, 'n');
  });

  test('lists sessions with turn, observation and recall counts, and filters to sessions that used memory', async () => {
    writer.insertContextInjections([{ session_id: 's1', injected_at: '2026-09-01T00:00:00.000Z', text: '# copilot-mem: recent memory for acme/api' }]);
    writer.insertToolEvents([
      { session_id: 's2', call_id: 'c1', tool_name: 'copilot-mem-search', started_at: '2026-09-02T00:00:01.000Z', summary: 'copilot-mem-search: {"query":"x"}' },
      { session_id: 's2', call_id: 'c2', tool_name: 'bash', started_at: '2026-09-02T00:00:02.000Z', summary: 'bash: ls' },
    ]);
    const { body } = await get('/api/sessions');
    assert.deepEqual(body.map((s: any) => [s.id, s.turns, s.pendingTurns, s.observations, s.injections, s.recallCalls]), [
      ['s2', 2, 1, 1, 0, 1],
      ['s1', 1, 0, 2, 1, 0],
    ]);
    assert.equal(body[0].title, 'u', 'falls back to the first prompt');
    assert.deepEqual((await get('/api/sessions?project=acme/api')).body.map((s: any) => s.id), ['s1']);
    writer.upsertSession({ id: 's3', cwd: '/w/api', repository: 'acme/api', branch: null, host_type: null, summary: 'Idle', created_at: null, updated_at: null }, 'x');
    assert.deepEqual((await get('/api/sessions?recall=1')).body.map((s: any) => s.id), ['s2', 's1']);

    writer.upsertTurn({ session_id: 's1', turn_index: 1, user_message: 'Fix the OTLP exporter', assistant_response: 'Done: 100% green', timestamp: '2026-09-01T00:01:00.000Z' }, 'x');
    const search = async (q: string) => (await get(`/api/sessions?q=${encodeURIComponent(q)}`)).body.map((s: any) => s.id);
    assert.deepEqual(await search('otlp'), ['s1'], 'matches turn text, case-insensitively');
    assert.deepEqual(await search('scratch'), ['s2'], 'matches the directory');
    assert.deepEqual(await search('idle'), ['s3'], 'matches the title');
    assert.deepEqual(await search('otlp exporter'), ['s1'], 'all words must match');
    assert.deepEqual(await search('otlp scratch'), []);
    assert.deepEqual(await search('100%'), ['s1'], 'LIKE wildcards are literal');
    assert.deepEqual(await search('1_0'), []);
    assert.deepEqual((await get('/api/sessions?q=otlp&project=/w/scratch')).body, [], 'combines with the project filter');
    assert.deepEqual((await get('/api/sessions?q=otlp&project=acme/api')).body.map((s: any) => s.id), ['s1']);

    const recall = (await get('/api/recall')).body;
    assert.deepEqual(recall, { sessions: 3, withContext: 1, withRecallCalls: 1, usedMemory: 2, recallCalls: 1, byTool: [{ tool: 'search', calls: 1 }] });
    assert.deepEqual((await get('/api/recall?project=acme/api')).body.usedMemory, 1);
  });

  test('returns a session with its turns, observations, injected context and copilot-mem calls', async () => {
    writer.insertToolEvents([
      { session_id: 's2', call_id: 'c1', tool_name: 'copilot-mem-timeline', started_at: '2026-09-02T00:00:01.000Z', summary: 'copilot-mem-timeline: {"anchor":1}' },
    ]);
    const { status, body } = await get('/api/sessions/s2');
    assert.equal(status, 200);
    assert.equal(body.session.repository, null);
    assert.deepEqual(body.turns.map((t: any) => [t.turn_index, t.compressed]), [[1, 1], [2, 0]]);
    assert.deepEqual(body.observations.map((o: any) => [o.title, o.first_turn, o.last_turn]), [['Scratch note', 1, 1]]);
    assert.deepEqual(body.recallCalls.map((c: any) => c.tool_name), ['copilot-mem-timeline']);
    assert.deepEqual(body.injections, []);
    assert.equal(body.summary, null);
    assert.equal((await get('/api/sessions/nope')).status, 404);
  });

  test('previews the context a new session in a project would get', async () => {
    const repo = (await get('/api/context?project=acme/api')).body;
    assert.equal(repo.cwd, '/w/api', 'a repository maps to its latest session directory');
    assert.match(repo.text, /Use port 4317 for OTLP/);
    assert.equal(repo.chars, repo.text.length);
    assert.ok(repo.chars <= repo.budget);
    const dirProject = (await get('/api/context?project=/w/scratch')).body;
    assert.equal(dirProject.cwd, '/w/scratch');
    assert.match(dirProject.text, /Scratch note/);
    assert.equal((await get('/api/context')).status, 400);
    assert.equal((await get('/api/context?project=nobody/nothing')).status, 404);
  });

  test('filters observations and sessions by date range', async () => {
    const titles = async (q: string) => (await get(`/api/observations?${q}`)).body.map((o: any) => o.title);
    assert.deepEqual(await titles('from=2026-09-02'), ['Scratch note']);
    assert.deepEqual(await titles('to=2026-09-01'), ['Retry with backoff', 'Use port 4317 for OTLP'], 'a bare end date includes that day');
    assert.deepEqual(await titles('from=2026-09-01T12:00:00.000Z&to=2026-09-02T12:00:00.000Z'), ['Scratch note']);
    assert.deepEqual(await titles('q=otlp&from=2026-09-02'), []);
    const sessions = async (q: string) => (await get(`/api/sessions?${q}`)).body.map((s: any) => s.id);
    assert.deepEqual(await sessions('from=2026-09-03'), ['s2'], 'a session matches by any of its turns');
    assert.deepEqual(await sessions('to=2026-09-01'), ['s1']);
    assert.deepEqual(await sessions('from=2026-10-01'), []);
    assert.equal((await get('/api/observations?from=yesterday')).status, 400);
    assert.equal((await get('/api/sessions?to=2026-13-45')).status, 400);
  });

  test('counts turns, sessions and observations per local day', async () => {
    const localDay = (iso: string) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const { body } = await get('/api/activity?since=2026-01-01');
    assert.deepEqual(body, [
      { day: localDay('2026-09-01T00:00:00.000Z'), turns: 1, sessions: 1, observations: 2 },
      { day: localDay('2026-09-02T00:00:00.000Z'), turns: 1, sessions: 1, observations: 1 },
      { day: localDay('2026-09-03T00:00:00.000Z'), turns: 1, sessions: 1, observations: 0 },
    ]);
    assert.deepEqual((await get('/api/activity?since=2026-01-01&project=acme/api')).body.map((d: any) => d.turns), [1]);
    assert.deepEqual((await get('/api/activity?since=2026-09-02T12:00:00.000Z')).body.map((d: any) => d.turns), [1]);
    const yearAgo = new Date(Date.now() - 366 * 86_400_000).toISOString();
    const recent = ['2026-09-01', '2026-09-02', '2026-09-03'].filter((d) => `${d}T00:00:00.000Z` >= yearAgo).length;
    assert.equal((await get('/api/activity')).body.length, recent, 'defaults to the last year');
    assert.equal((await get('/api/activity?since=soon')).status, 400);
  });

  test('exports the filtered observations and session summaries as a Markdown download', async () => {
    writer.saveSummary('s1', { request: 'Wire up OTLP', investigated: '', learned: '', completed: 'Exporter on 4317', next_steps: '', notes: '' },
      [1, 2], 'm', '2026-09-01T01:00:00.000Z');
    const res = await fetch(new URL('/api/export?project=acme/api&fromLabel=2026-09-01&toLabel=2026-09-01&from=2026-09-01&to=2026-09-01', viewer.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/markdown/);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="copilot-mem-acme_api-2026-09-01-2026-09-01.md"');
    const md = await res.text();
    assert.match(md, /^# copilot-mem export\n\nproject `acme\/api`, 2026-09-01 to 2026-09-01\./);
    assert.match(md, /2 observation\(s\) and 1 session summary across 1 project\(s\)/);
    assert.match(md, /## acme\/api\n/);
    assert.match(md, /### Sessions\n\n- \*\*2026-09-01\*\* Wire up OTLP - Exporter on 4317\n/);
    assert.match(md, /### Decisions\n\n- 2026-09-01 \*\*Use port 4317 for OTLP\*\* \(#1\)\n- 2026-09-01 \*\*Retry with backoff\*\* \(#2\)\n/);
    assert.doesNotMatch(md, /Scratch note/);

    const all = await (await fetch(new URL('/api/export?q=scratch', viewer.url))).text();
    assert.match(all, /all projects, all time, matching "scratch"/);
    assert.match(all, /## \/w\/scratch[\s\S]*Scratch note/);
    assert.doesNotMatch(all, /### Sessions/, 'summaries are left out of query-narrowed exports');
    assert.match(await (await fetch(new URL('/api/export?from=2030-01-01', viewer.url))).text(), /Nothing matches these filters\./);
    assert.equal((await get('/api/export?type=nope')).status, 400);
  });

  test('edits an observation: search index updated, vector dropped for re-embedding, marked edited', async () => {
    writer.saveEmbeddings('m1', [{ id: 1, vector: new Float32Array([1, 0]) }, { id: 2, vector: new Float32Array([0, 1]) }]);
    const edit = { type: 'bugfix', title: 'Collector listens on 4318', subtitle: 'HTTP, not gRPC', narrative: 'Switched to OTLP/HTTP.', facts: [' f1 ', '', 'f2'] };
    assert.deepEqual(await post('/api/observations/1', edit), { status: 200, body: { id: 1, ok: true } });
    const o = (await get('/api/observations/1')).body.observation;
    assert.deepEqual([o.type, o.title, o.subtitle, o.narrative, o.facts], ['bugfix', 'Collector listens on 4318', 'HTTP, not gRPC', 'Switched to OTLP/HTTP.', ['f1', 'f2']]);
    assert.ok(o.edited_at);
    assert.deepEqual((await get('/api/observations?q=4318')).body.map((r: any) => r.id), [1]);
    assert.deepEqual((await get('/api/observations?q=4317')).body, []);
    assert.equal(writer.embeddingCount('m1'), 1, 'only the edited one is re-embedded');
    assert.ok(logged.some((m) => m === 'viewer: observation #1 edited'));

    assert.equal((await post('/api/observations/1', { ...edit, type: 'nope' })).status, 400);
    assert.equal((await post('/api/observations/1', { ...edit, title: '  ' })).status, 400);
    assert.equal((await post('/api/observations/1', { ...edit, title: 'x'.repeat(121) })).status, 400);
    assert.equal((await post('/api/observations/1', { ...edit, facts: 'f' })).status, 400);
    assert.equal((await post('/api/observations/1', '[1]')).status, 400);
    assert.equal((await post('/api/observations/1', '{bad')).status, 400);
    assert.equal((await post('/api/observations/1', { ...edit, narrative: 'x'.repeat(70_000) })).status, 413);
    assert.equal((await post('/api/observations/999', edit)).status, 404);
  });

  test('pins, unpins and filters pinned observations', async () => {
    assert.equal((await post('/api/observations/2/pin', { pinned: true })).status, 200);
    assert.deepEqual((await get('/api/observations?pinned=1')).body.map((o: any) => o.id), [2]);
    assert.ok((await get('/api/observations/2')).body.observation.pinned_at);
    assert.equal((await post('/api/observations/2/pin', { pinned: 'yes' })).status, 400);
    assert.equal((await post('/api/observations/2/pin', { pinned: false })).status, 200);
    assert.deepEqual((await get('/api/observations?pinned=1')).body, []);
    assert.equal((await post('/api/observations/999/pin', { pinned: true })).status, 404);
  });

  test('deletes an observation and its vector, keeping the source turns', async () => {
    writer.saveEmbeddings('m1', [{ id: 1, vector: new Float32Array([1, 0]) }]);
    assert.equal((await post('/api/observations/1/delete', {})).status, 200);
    assert.equal((await get('/api/observations/1')).status, 404);
    assert.deepEqual((await get('/api/observations?q=otlp')).body, []);
    assert.equal(writer.embeddingCount('m1'), 0);
    assert.equal((await get('/api/sessions/s1')).body.turns.length, 1);
    assert.equal((await post('/api/observations/1/delete', {})).status, 404);
  });

  test('adds a note for a project', async () => {
    const { status, body } = await post('/api/notes', { project: 'acme/api', title: 'Use make lint', text: 'Before every PR.', facts: ['ci runs it'] });
    assert.equal(status, 201);
    assert.equal(body.project, 'acme/api');
    const o = (await get(`/api/observations/${body.id}`)).body.observation;
    assert.deepEqual([o.type, o.title, o.narrative, o.facts, o.repository], ['note', 'Use make lint', 'Before every PR.', ['ci runs it'], 'acme/api']);
    assert.equal((await post('/api/notes', { title: 't', text: 'x' })).status, 400, 'project is required');
    assert.equal((await post('/api/notes', { project: 'not a project', title: 't', text: 'x' })).status, 400);
    assert.equal((await post('/api/notes', { project: 'acme/api', title: 't', text: '' })).status, 400);
  });

  test('changes need the action header and a same-origin request', async () => {
    const edit = { type: 'note', title: 't', narrative: 'n' };
    assert.equal((await post('/api/observations/1', edit, {})).status, 403);
    assert.equal((await post('/api/observations/1/delete', {}, { 'x-copilot-mem-action': '1', origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/notes', { project: 'acme/api', title: 't', text: 'x' }, {})).status, 403);
    assert.equal((await post('/api/nope', {})).status, 405);
    assert.equal((await get('/api/observations/1')).body.observation.title, 'Use port 4317 for OTLP', 'nothing changed');
  });

  test('settings view: effective settings, embedding coverage and links', async () => {
    writer.saveEmbeddings('test-model', [{ id: 1, vector: new Float32Array([1, 0]) }]);
    writer.linkProjects(['acme/api', '/w/scratch'], '2026-09-01T00:00:00.000Z');
    const { status, body } = await get('/api/settings');
    assert.equal(status, 200);
    assert.deepEqual(body.settings, { path: '/x/settings.json', exists: true, values: { COPILOT_MEM_MODEL: { value: 'gpt-5-mini', source: 'default' } } });
    assert.deepEqual(body.embedding, { model: 'test-model', embedded: 1, observations: 3 });
    assert.deepEqual(body.links, [['/w/scratch', 'acme/api']]);

    const plain = await startViewer({ port: 0, files: workerFiles(dir), openStore: () => new MemoryStore(dbPath), status: () => ({}) });
    try {
      const res = await (await fetch(new URL('/api/settings', plain.url))).json();
      assert.deepEqual(res, { settings: null, embedding: null, links: [['/w/scratch', 'acme/api']] });
    } finally {
      await plain.close();
    }
  });

  test('links and unlinks projects', async () => {
    const linked = await post('/api/links', { projects: ['acme/api', '/w/scratch/'] });
    assert.equal(linked.status, 200);
    assert.deepEqual(linked.body.links, [['/w/scratch', 'acme/api']], 'trailing slash normalized');
    assert.match(linked.body.message, /^Linked acme\/api, \/w\/scratch \(1 new pair/);
    assert.ok(logged.some((m) => m.startsWith('viewer: Linked acme/api')));
    const removed = await post('/api/links/delete', { projects: ['/w/scratch', 'acme/api'] });
    assert.deepEqual([removed.status, removed.body.links, removed.body.message], [200, [], 'Removed 1 link(s) between /w/scratch, acme/api.']);

    assert.equal((await post('/api/links', { projects: ['acme/api'] })).status, 400, 'needs two projects');
    assert.equal((await post('/api/links', { projects: ['acme/api', 'not a project'] })).status, 400);
    assert.equal((await post('/api/links', { projects: 'acme/api' })).status, 400);
    assert.equal((await post('/api/links', { projects: ['acme/api', '/w/scratch'] }, {})).status, 403, 'needs the action header');
    assert.deepEqual(writer.projectLinks(), []);
  });

  test('a bad setting does not crash the live poll (it is reported instead)', async () => {
    const before = process.env.COPILOT_MEM_AUTO_COMPRESS;
    process.env.COPILOT_MEM_AUTO_COMPRESS = 'five';
    try {
      const res = await fetch(new URL('/api/events', viewer.url));
      const reader = res.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      assert.match(first, /"autoCompressLimit":null,"settingsError":"COPILOT_MEM_AUTO_COMPRESS must be/);
      writer.upsertTurn({ session_id: 's2', turn_index: 3, user_message: 'u', assistant_response: 'a', timestamp: '2026-09-04T00:00:00.000Z' }, 'y');
      const next = new TextDecoder().decode((await reader.read()).value);
      assert.match(next, /event: snapshot/, 'polling continues');
      await reader.cancel();
    } finally {
      if (before === undefined) delete process.env.COPILOT_MEM_AUTO_COMPRESS;
      else process.env.COPILOT_MEM_AUTO_COMPRESS = before;
    }
  });

  test('settingsReport reads the given environment and reports embedding errors', () => {
    const path = join(dir, 'settings.json');
    const ok = settingsReport({ COPILOT_MEM_EMBED_PROVIDER: 'ollama', COPILOT_MEM_EMBED_MODEL: 'nomic' }, path);
    assert.deepEqual([ok.path, ok.exists, ok.embedding], [path, false, { model: 'nomic' }]);
    const local = settingsReport({}, path).embedding;
    assert.equal(local.model, 'local:Xenova/bge-small-en-v1.5');
    assert.match(local.setup!, /run `copilot-mem embed --setup`/, 'the runtime is looked up next to settings.json');
    const pkg = join(dir, 'embed', 'node_modules', '@huggingface', 'transformers');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ main: 'index.js' }));
    writeFileSync(join(pkg, 'index.js'), '');
    assert.equal(settingsReport({}, path).embedding.setup, 'The model Xenova/bge-small-en-v1.5 is not downloaded: run `copilot-mem embed`.');
    const onnx = join(dir, 'embed', 'models', 'Xenova', 'bge-small-en-v1.5', 'onnx');
    mkdirSync(onnx, { recursive: true });
    writeFileSync(join(onnx, 'model_quantized.onnx'), '');
    assert.equal(settingsReport({}, path).embedding.setup, undefined);
    assert.deepEqual(ok.settings.COPILOT_MEM_EMBED_MODEL, { value: 'nomic', source: 'env' });
    assert.deepEqual(settingsReport({ COPILOT_MEM_EMBED_PROVIDER: 'off' }, path).embedding, { model: null });
    const bad = settingsReport({ COPILOT_MEM_EMBED_PROVIDER: 'voyage' }, path).embedding;
    assert.equal(bad.model, null);
    assert.match(bad.error!, /COPILOT_MEM_EMBED_API_KEY is required/);
  });

  test('page estimate() projects compression cost from measured per-turn rates', () => {
    const html = readFileSync(join(import.meta.dirname, '..', 'src', 'viewer', 'page.ts'), 'utf8');
    const src = html.slice(html.indexOf('function estimate('), html.indexOf('\nfunction totalPending('));
    const state = { stats: { backlog: { perTurn: { calls: 0.25, credits: 0.03, durationMs: 5000 } } } };
    const estimate = new Function('state', `${src}; return estimate;`)(state);
    assert.deepEqual(estimate(10), { need: 3, calls: 3, turns: 10, credits: 0.3, ms: 50_000 }, 'all 10 turns need ceil(2.5) calls');
    assert.deepEqual(estimate(10, 2), { need: 3, calls: 2, turns: 8, credits: 0.24, ms: 40_000 }, 'capped run covers ~8 turns');
    assert.deepEqual(estimate(1), { need: 1, calls: 1, turns: 1, credits: 0.03, ms: 5000 });
    assert.equal(estimate(0), null);
    assert.equal(new Function('state', `${src}; return estimate;`)({ stats: { backlog: null } })(10), null, 'unknown before any measured call');
  });

  test('rejects bad input and unknown routes with JSON errors', async () => {
    assert.equal((await get('/api/observations?type=nope')).status, 400);
    assert.equal((await get('/api/observations?limit=0')).status, 400);
    assert.equal((await get('/api/observations/999')).status, 404);
    assert.equal((await get('/api/sessions?limit=999')).status, 400);
    assert.equal((await get('/nope')).status, 404);
    const post = await fetch(new URL('/api/status', viewer.url), { method: 'POST' });
    assert.equal(post.status, 405);
  });

  test('rejects foreign Host headers (DNS rebinding)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      request(viewer.url, { headers: { host: `evil.example:${viewer.port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on('error', reject)
        .end();
    });
    assert.equal(status, 403);
    assert.equal((await get('/api/status')).body.version, 'test');
  });

  test('streams snapshots and pushes new observations and log lines live', async () => {
    const controller = new AbortController();
    const res = await fetch(new URL('/api/events', viewer.url), { signal: controller.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextSnapshot = async () => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = /^data: (.*)$/m.exec(event);
          if (data) return JSON.parse(data[1]);
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += decoder.decode(value, { stream: true });
      }
    };
    try {
      const first = await nextSnapshot();
      assert.deepEqual(first.counts, { sessions: 2, turns: 3, pendingTurns: 1, observations: 3 });
      assert.equal(first.latestObservationId, 3);
      assert.deepEqual(first.worker, { running: false, compressing: false, autoCompressLimit: autoCompressLimit() });
      assert.equal(first.canCompress, true);
      assert.equal(first.compressRequested, false);

      // Backfill: a new observation for an *older* turn must still count as new.
      addObservations('s3', 'acme/web', '/w/web', 0, ['Backfilled decision']);
      appendFileSync(workerFiles(dir).log, 'compress: 1 turn(s) -> 1 observation(s)\n');
      let next = await nextSnapshot();
      while (next.latestObservationId !== 4 || next.log.length === 0) next = await nextSnapshot();
      assert.equal(next.counts.observations, 4);
      assert.deepEqual(next.log, ['compress: 1 turn(s) -> 1 observation(s)']);
      assert.equal(next.latestCallId, null);

      // A recorded Copilot call changes the snapshot, so the page refreshes its usage stats.
      writer.recordCall({ startedAt: '2026-09-04T00:00:00.000Z', durationMs: 1, sessionId: 's1', model: 'm', status: 'ok', turns: 1, observations: 1, promptChars: 1 });
      while (next.latestCallId !== 1) next = await nextSnapshot();
    } finally {
      controller.abort();
    }
  });
});

describe('viewer compress button', () => {
  test('starts one capped run, refuses a second while it runs, then allows another', async () => {
    const first = await postCompress({ limit: 3 });
    assert.deepEqual(first, { status: 202, body: { started: true, limit: 3, project: null } });
    assert.deepEqual(compressCalls, [3]);
    assert.deepEqual(logged, ['viewer: compress requested (up to 3 call(s))']);
    assert.equal((await postCompress({ limit: 1 })).status, 409);

    finishCompress();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal((await postCompress({ limit: 2, project: 'acme/web' })).status, 202);
    assert.deepEqual(compressCalls, [3, [2, 'acme/web']]);
    assert.equal(logged[1], 'viewer: compress requested (up to 2 call(s) for acme/web)');
  });

  test('rejects cross-site requests (CSRF) and bad limits without starting anything', async () => {
    assert.equal((await postCompress({ limit: 1 }, {})).status, 403, 'missing action header');
    assert.equal((await postCompress({ limit: 1 }, { 'x-copilot-mem-action': '1', origin: 'https://evil.example' })).status, 403);
    for (const limit of [0, 1.5, '3', 501]) assert.equal((await postCompress({ limit })).status, 400, `limit ${limit}`);
    assert.equal((await postCompress('not json')).status, 400);
    assert.equal((await postCompress('null')).status, 400);
    for (const project of ['', 7, ['a']]) assert.equal((await postCompress({ limit: 1, project })).status, 400, `project ${project}`);
    assert.deepEqual(compressCalls, []);
  });

  test('without a compress function the endpoint is unavailable', async () => {
    const plain = await startViewer({ port: 0, files: workerFiles(dir), openStore: () => new MemoryStore(dbPath), status: () => ({}) });
    try {
      const res = await fetch(new URL('/api/compress', plain.url), { method: 'POST', headers: { 'x-copilot-mem-action': '1' }, body: '{"limit":1}' });
      assert.equal(res.status, 501);
    } finally {
      await plain.close();
    }
  });
});

describe('tailLines', () => {
  test('returns the last lines, dropping a partial first line when truncated', () => {
    const path = join(dir, 'big.log');
    assert.deepEqual(tailLines(path, 5), []);
    appendFileSync(path, Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n') + '\n');
    assert.deepEqual(tailLines(path, 2), ['line 19998', 'line 19999']);
    assert.ok(tailLines(path, 1_000_000).every((l) => /^line \d+$/.test(l)));
  });
});
