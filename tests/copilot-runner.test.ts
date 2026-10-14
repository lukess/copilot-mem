import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { copilotArgs, createCopilotRunner, readUsage } from '../src/compress/copilot-runner.ts';

// Stands in for `copilot`: records how it was invoked, then behaves per FAKE_MODE.
const FAKE_COPILOT = `#!/bin/sh
cat > "$FAKE_OUT/stdin.txt"
printf '%s\\n' "$@" > "$FAKE_OUT/args.txt"
cp "$COPILOT_HOME/config.json" "$FAKE_OUT/config.json"
pwd > "$FAKE_OUT/cwd.txt"
ls -A > "$FAKE_OUT/cwd-listing.txt"
echo "\${COPILOT_ALLOW_ALL:-unset}" > "$FAKE_OUT/allow-all.txt"
case "$FAKE_MODE" in
  usage)
    while [ $# -gt 0 ]; do
      if [ "$1" = --usage-output-file ]; then cp "$FAKE_OUT/usage-fixture.json" "$2"; fi
      shift
    done ;;
  fail) echo "No authentication information found." >&2; exit 1 ;;
  hang) exec sleep 5 ;;
esac
echo '{"observations":[]}'
`;

// Trimmed from a real `copilot --usage-output-file` (v1.0.94); two models to check the per-model sums.
const USAGE_SAMPLE = {
  totalPremiumRequestCost: 0,
  totalUserRequests: 1,
  totalNanoAiu: 61050000,
  aiCreditsStatus: 'complete',
  totalApiDurationMs: 1861,
  modelMetrics: {
    'gpt-5-mini': {
      requests: { count: 1, cost: 0 },
      usage: { inputTokens: 1802, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 64 },
      totalNanoAiu: 61050000,
    },
    other: { usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 0 } },
  },
};
const SAMPLE_USAGE = {
  apiMs: 1861, inputTokens: 1812, outputTokens: 81, cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 64,
  nanoAiu: 61050000, premiumRequests: 0,
};

let dir: string;
let out: string;
let sourceHome: string;
let workDir: string;
let bin: string;

const read = (name: string) => readFileSync(join(out, name), 'utf8').trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-mem-runner-'));
  out = join(dir, 'out');
  sourceHome = join(dir, 'copilot-home');
  workDir = join(dir, 'work');
  bin = join(dir, 'copilot');
  mkdirSync(out);
  mkdirSync(sourceHome);
  writeFileSync(bin, FAKE_COPILOT);
  chmodSync(bin, 0o755);
  process.env.FAKE_OUT = out;
  process.env.COPILOT_ALLOW_ALL = 'true';
  delete process.env.FAKE_MODE;
});

afterEach(() => {
  delete process.env.FAKE_OUT;
  delete process.env.FAKE_MODE;
  delete process.env.COPILOT_ALLOW_ALL;
  rmSync(dir, { recursive: true, force: true });
});

describe('createCopilotRunner', () => {
  test('pipes the prompt over stdin into an isolated, tool-less copilot and cleans up', async () => {
    writeFileSync(
      join(sourceHome, 'config.json'),
      '// User settings belong in settings.json.\n// This file is managed automatically.\n' +
        JSON.stringify({ lastLoggedInUser: { host: 'https://github.com', login: 'octocat' }, trustedFolders: ['/secret'] }),
    );
    const run = createCopilotRunner({ model: 'gpt-5-mini', sourceHome, workDir, bin });

    assert.deepEqual(await run('SECRET TRANSCRIPT'), { text: '{"observations":[]}\n', usage: undefined });
    assert.equal(read('stdin.txt'), 'SECRET TRANSCRIPT');
    const args = read('args.txt').split('\n');
    assert.deepEqual(args.slice(0, -2), copilotArgs('gpt-5-mini'));
    assert.equal(args.at(-2), '--usage-output-file');
    assert.ok(args.at(-1)!.startsWith(workDir), 'usage file lives in the scratch dir');
    assert.ok(!read('args.txt').includes('SECRET'), 'prompt must not be passed via argv');
    assert.ok(read('args.txt').includes('--available-tools=copilot_mem_no_tools'));
    assert.deepEqual(JSON.parse(read('config.json')), { lastLoggedInUser: { host: 'https://github.com', login: 'octocat' } });
    assert.ok(read('cwd.txt').startsWith(realpathSync(workDir)), 'runs inside the scratch dir, not the user cwd');
    assert.equal(read('cwd-listing.txt'), '', 'cwd is empty');
    assert.equal(read('allow-all.txt'), 'unset');
    assert.deepEqual(readdirSync(workDir), [], 'scratch home is removed');
  });

  test('returns the usage Copilot reports (tokens, API time, AI credits, premium requests)', async () => {
    process.env.FAKE_MODE = 'usage';
    writeFileSync(join(out, 'usage-fixture.json'), JSON.stringify(USAGE_SAMPLE));
    const run = createCopilotRunner({ model: 'gpt-5-mini', sourceHome, workDir, bin });
    assert.deepEqual(await run('x'), { text: '{"observations":[]}\n', usage: SAMPLE_USAGE });
    assert.deepEqual(readdirSync(workDir), [], 'scratch dir (with the usage file) is removed');
  });

  test('works without a logged-in user (token env vars still apply)', async () => {
    const run = createCopilotRunner({ model: 'm', sourceHome, workDir, bin });
    await run('x');
    assert.deepEqual(JSON.parse(read('config.json')), {});
  });

  test('rejects with stderr on non-zero exit and still cleans up', async () => {
    process.env.FAKE_MODE = 'fail';
    const run = createCopilotRunner({ model: 'm', sourceHome, workDir, bin });
    await assert.rejects(run('x'), /code 1: No authentication information found/);
    assert.deepEqual(readdirSync(workDir), []);
  });

  test('kills copilot after the timeout', async () => {
    process.env.FAKE_MODE = 'hang';
    const run = createCopilotRunner({ model: 'm', sourceHome, workDir, bin, timeoutMs: 200 });
    await assert.rejects(run('x'), /timed out after 200ms/);
  });

  test('rejects when the binary is missing', async () => {
    const run = createCopilotRunner({ model: 'm', sourceHome, workDir, bin: join(dir, 'nope') });
    await assert.rejects(run('x'), /ENOENT/);
    assert.ok(existsSync(workDir));
  });
});

describe('readUsage', () => {
  test('ignores a missing, malformed or unrecognized usage file', () => {
    assert.equal(readUsage(join(dir, 'missing.json')), undefined);
    writeFileSync(join(dir, 'bad.json'), '{not json');
    assert.equal(readUsage(join(dir, 'bad.json')), undefined);
    writeFileSync(join(dir, 'other.json'), '{"foo":1}');
    assert.equal(readUsage(join(dir, 'other.json')), undefined);
  });
});
