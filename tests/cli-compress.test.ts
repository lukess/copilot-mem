import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { MemoryStore } from '../src/storage/memory-store.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

// Slow enough that the viewer can be killed while the call is in flight.
const FAKE_COPILOT = `#!/bin/sh
cat > /dev/null
touch "$FAKE_DIR/started"
sleep 1
echo '{"observations":[{"type":"decision","title":"Fake decision","narrative":"n","facts":[],"files":[]}]}'
`;

let dir: string;
let env: NodeJS.ProcessEnv;
let viewer: ChildProcess | undefined;

const log = () => (existsSync(join(dir, 'data', 'worker.log')) ? readFileSync(join(dir, 'data', 'worker.log'), 'utf8') : '');

async function waitFor(what: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; worker.log:\n${log()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-mem-cli-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ lastLoggedInUser: { host: 'https://github.com', login: 'octocat' } }));
  const source = new DatabaseSync(join(home, 'session-store.db'));
  source.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL,
      user_message TEXT, assistant_response TEXT, timestamp TEXT, UNIQUE(session_id, turn_index));
    INSERT INTO sessions (id, cwd, repository) VALUES ('a', '/w/api', 'acme/api'), ('b', '/w/web', 'acme/web');
    INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES
      ('a', 0, 'u', 'r', '2026-01-01T00:00:00Z'), ('a', 1, 'u', 'r', '2026-01-01T00:01:00Z'),
      ('b', 0, 'u', 'r', '2026-01-02T00:00:00Z');`);
  source.close();
  const bin = join(dir, 'copilot');
  writeFileSync(bin, FAKE_COPILOT);
  chmodSync(bin, 0o755);
  env = {
    ...process.env,
    COPILOT_HOME: home,
    COPILOT_MEM_DATA_DIR: join(dir, 'data'),
    COPILOT_MEM_COPILOT_BIN: bin,
    FAKE_DIR: dir,
  };
  delete env.COPILOT_MEM_SOURCE_DB;
});

afterEach(() => {
  viewer?.kill('SIGKILL');
  viewer = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function pending(project: string): number {
  const store = new MemoryStore(join(dir, 'data', 'memory.db'));
  try {
    return store.pendingTurns(3, project).length;
  } finally {
    store.close();
  }
}

describe('compress from the viewer', () => {
  test('keeps running after the viewer is killed (it runs as its own process), scoped to the project', async () => {
    viewer = spawn(process.execPath, [CLI, 'viewer', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    viewer.stdout!.on('data', (chunk: Buffer) => (out += chunk));
    await waitFor('viewer url', () => /http:\/\/127\.0\.0\.1:\d+\//.test(out));
    const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(out)![0];

    const res = await fetch(new URL('/api/compress', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-copilot-mem-action': '1' },
      body: JSON.stringify({ limit: 5, project: 'acme/api' }),
    });
    assert.equal(res.status, 202);

    await waitFor('the copilot call to start', () => existsSync(join(dir, 'started')));
    viewer.kill('SIGKILL'); // e.g. the dashboard being restarted mid-run
    viewer = undefined;

    await waitFor('compression to finish', () => /compress: \d+ turn/.test(log()));
    assert.match(log(), /viewer: compress requested \(up to 5 call\(s\) for acme\/api\)/);
    assert.match(log(), /compress: 2 turn\(s\) -> 1 observation\(s\) in 1 call\(s\), 0 failed/);
    assert.equal(pending('acme/api'), 0);
    assert.equal(pending('acme/web'), 1, 'other projects are left alone');
  });

  test('compress --background logs failures to worker.log instead of a closed terminal', () => {
    rmSync(join(dir, 'home', 'session-store.db'));
    const result = spawnSync(process.execPath, [CLI, 'compress', '--background', '--limit', '1'], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(log(), /compress failed: Copilot session store not found/);
  });
});
