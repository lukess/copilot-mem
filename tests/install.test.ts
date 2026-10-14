import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { detectIdes, findExecutable } from '../src/integration/detect.ts';
import { hooksConfig, install, readManifest, shellQuote, stableRuntime, uninstall, type InstallContext } from '../src/integration/install.ts';
import { SKILL_MD } from '../src/integration/skill.ts';

// Mimics the copilot subcommands install uses, including "already exists" / "not found" failures.
const FAKE_COPILOT = `#!/bin/sh
echo "$*" >> "$COPILOT_HOME/calls.log"
case "$1 $2" in
  "--version ") echo "GitHub Copilot CLI 9.8.7." ;;
  "mcp add") [ -f "$COPILOT_HOME/mcp.added" ] && exit 1; echo "$*" > "$COPILOT_HOME/mcp.added" ;;
  "mcp remove") [ -f "$COPILOT_HOME/mcp.added" ] || exit 1; rm "$COPILOT_HOME/mcp.added" ;;
  "skill add") [ -d "$COPILOT_HOME/skills/copilot-mem" ] && exit 1
               mkdir -p "$COPILOT_HOME/skills/copilot-mem" && cp "$3" "$COPILOT_HOME/skills/copilot-mem/SKILL.md" ;;
  "skill remove") [ -d "$COPILOT_HOME/skills/copilot-mem" ] || exit 1; rm -r "$COPILOT_HOME/skills/copilot-mem" ;;
  *) exit 3 ;;
esac
`;

let dir: string;
let home: string;
let ctx: InstallContext;
let logs: string[];

const calls = () => readFileSync(join(home, 'calls.log'), 'utf8').trim().split('\n').filter((c) => c !== '--version');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-mem-install-'));
  home = join(dir, 'copilot home');
  mkdirSync(home);
  const bin = join(dir, 'copilot');
  writeFileSync(bin, FAKE_COPILOT);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'bundle.js'), '// bundle');
  logs = [];
  ctx = {
    copilotHome: home,
    dataDir: join(dir, 'data'),
    copilotBinName: bin,
    runtime: '/usr/local/bin/node',
    entry: join(dir, 'bundle.js'),
    env: { COPILOT_MEM_MODEL: 'gpt-5-mini', COPILOT_MEM_AUTO_COMPRESS: '2', UNRELATED: 'x' },
    log: (m) => logs.push(m),
    home: join(dir, 'user'),
  };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('detectIdes', () => {
  test('finds VS Code by user data directory or CLI, per platform', () => {
    const user = join(dir, 'user');
    assert.deepEqual(detectIdes({ PATH: '' }, user, 'darwin'), []);
    mkdirSync(join(user, 'Library', 'Application Support', 'Code'), { recursive: true });
    assert.deepEqual(detectIdes({ PATH: '' }, user, 'darwin'), [{ name: 'VS Code', path: join(user, 'Library', 'Application Support', 'Code') }]);
    mkdirSync(join(dir, 'xdg', 'Code - Insiders'), { recursive: true });
    assert.deepEqual(detectIdes({ XDG_CONFIG_HOME: join(dir, 'xdg'), PATH: '' }, user, 'linux').map((i) => i.name), ['VS Code Insiders']);
    writeFileSync(join(dir, 'code'), '#!/bin/sh\n');
    chmodSync(join(dir, 'code'), 0o755);
    assert.deepEqual(detectIdes({ PATH: dir }, join(dir, 'nobody'), 'linux'), [{ name: 'VS Code', path: join(dir, 'code') }]);
  });

  test('install mentions a detected VS Code', () => {
    mkdirSync(join(dir, 'user', 'Library', 'Application Support', 'Code'), { recursive: true });
    mkdirSync(join(dir, 'user', '.config', 'Code'), { recursive: true });
    install({ ...ctx, env: { ...ctx.env, PATH: '' } }, '1');
    assert.ok(logs.some((l) => /Found VS Code .*same MCP server, skill and hooks/.test(l)));
  });
});

describe('install', () => {
  test('registers MCP server, skill, and hooks through a stable copy of the bundle', () => {
    const manifest = install(ctx, '1.2.3');
    const stable = join(dir, 'data', 'lib', 'copilot-mem.js');
    assert.equal(readFileSync(stable, 'utf8'), '// bundle');
    assert.deepEqual(manifest.command, ['/usr/local/bin/node', stable]);
    assert.match(logs[0], /Found GitHub Copilot CLI 9\.8\.7/);
    assert.ok(!logs.some((l) => /VS Code/.test(l)));

    assert.deepEqual(calls(), [
      'mcp remove copilot-mem',
      `mcp add copilot-mem -- /usr/local/bin/node ${stable} mcp`,
      'skill remove copilot-mem',
      calls()[3],
    ]);
    assert.match(calls()[3], /^skill add .*\/SKILL\.md$/);
    assert.equal(readFileSync(join(home, 'skills', 'copilot-mem', 'SKILL.md'), 'utf8'), SKILL_MD);

    const hooks = JSON.parse(readFileSync(join(home, 'hooks', 'copilot-mem.json'), 'utf8'));
    assert.equal(hooks.version, 1);
    assert.deepEqual(Object.keys(hooks.hooks), ['sessionStart', 'agentStop', 'sessionEnd']);
    assert.equal(hooks.hooks.sessionStart[0].bash, `/usr/local/bin/node ${stable} hook session-start`);
    assert.equal(hooks.hooks.sessionEnd[0].bash, `/usr/local/bin/node ${stable} hook stop`);
    // Settings live in settings.json (so later edits apply), not baked into the hooks or MCP config.
    assert.deepEqual(hooks.hooks.agentStop[0].env, {});
    const settings = JSON.parse(readFileSync(join(ctx.dataDir, 'settings.json'), 'utf8'));
    assert.equal(settings.COPILOT_MEM_MODEL, 'gpt-5-mini');
    assert.equal(settings.COPILOT_MEM_AUTO_COMPRESS, '2');
    assert.equal(settings.COPILOT_MEM_COPILOT_BIN, join(dir, 'copilot'));
    assert.equal(settings.UNRELATED, undefined);
    assert.ok(logs.some((l) => /Created settings .*settings\.json \(saved from your environment: COPILOT_MEM_AUTO_COMPRESS\)/.test(l)));
    assert.deepEqual(readManifest(ctx.dataDir), manifest);
  });

  test('can be re-run (replaces the existing registration)', () => {
    install(ctx, '1');
    install(ctx, '2');
    assert.equal(readManifest(ctx.dataDir)?.version, '2');
    assert.ok(logs.some((l) => /^Updated settings/.test(l)));
    assert.ok(existsSync(join(home, 'mcp.added')));
  });

  test('forwards only the data directory, which locates settings.json', () => {
    install({ ...ctx, env: { ...ctx.env, COPILOT_MEM_DATA_DIR: ctx.dataDir } }, '1');
    assert.equal(calls()[1].split(' -- ')[0], `mcp add copilot-mem --env COPILOT_MEM_DATA_DIR=${ctx.dataDir}`);
    const hooks = JSON.parse(readFileSync(join(home, 'hooks', 'copilot-mem.json'), 'utf8'));
    assert.deepEqual(hooks.hooks.sessionStart[0].env, { COPILOT_MEM_DATA_DIR: ctx.dataDir });
  });

  test('uses a source checkout in place', () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'cli.ts'), '');
    const manifest = install({ ...ctx, entry: join(dir, 'src', 'cli.ts') }, '1');
    assert.deepEqual(manifest.command, ['/usr/local/bin/node', join(realpathSync(dir), 'src', 'cli.ts')]);
    assert.equal(existsSync(join(dir, 'data', 'lib')), false);
  });

  test('copies the bundle when run through an npm bin symlink (no .js extension)', () => {
    mkdirSync(join(dir, 'bin'));
    symlinkSync(join(dir, 'bundle.js'), join(dir, 'bin', 'copilot-mem'));
    const manifest = install({ ...ctx, entry: join(dir, 'bin', 'copilot-mem') }, '1');
    assert.equal(manifest.command[1], join(dir, 'data', 'lib', 'copilot-mem.js'));
    assert.equal(readFileSync(manifest.command[1], 'utf8'), '// bundle');
  });

  test('records the runtime by its stable PATH name, not the versioned binary', () => {
    const versioned = join(dir, 'Cellar', 'node', '26.11.0', 'bin', 'node');
    mkdirSync(join(versioned, '..'), { recursive: true });
    writeFileSync(versioned, '');
    chmodSync(versioned, 0o755);
    mkdirSync(join(dir, 'bin'));
    symlinkSync(versioned, join(dir, 'bin', 'node'));
    const manifest = install({ ...ctx, runtime: versioned, env: { PATH: `/nonexistent:${join(dir, 'bin')}` } }, '1');
    assert.equal(manifest.command[0], join(dir, 'bin', 'node'));
    assert.equal(stableRuntime(versioned, '/nonexistent'), versioned, 'no PATH alias: keep execPath');
    assert.equal(stableRuntime(versioned, '/bin'), versioned, 'a different binary of the same name is not an alias');
  });

  test('fails clearly when Copilot CLI is missing', () => {
    assert.throws(() => install({ ...ctx, copilotBinName: join(dir, 'missing') }, '1'), /GitHub Copilot CLI not found/);
  });

  test('uninstall removes everything but the memory', () => {
    install(ctx, '1');
    writeFileSync(join(ctx.dataDir, 'memory.db'), '');
    uninstall(ctx);
    assert.equal(existsSync(join(home, 'mcp.added')), false);
    assert.equal(existsSync(join(home, 'skills', 'copilot-mem')), false);
    assert.equal(existsSync(join(home, 'hooks', 'copilot-mem.json')), false);
    assert.equal(existsSync(join(ctx.dataDir, 'lib')), false);
    assert.equal(readManifest(ctx.dataDir), undefined);
    assert.ok(existsSync(join(ctx.dataDir, 'memory.db')));
    uninstall(ctx); // idempotent
    assert.match(logs.at(-3) ?? '', /was not registered/);
  });
});

describe('helpers', () => {
  test('shellQuote survives spaces and quotes in paths', () => {
    const path = "/Users/o'neil/my dir/cli.js";
    assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(path)}`], { encoding: 'utf8' }), path);
    assert.equal(shellQuote('/opt/homebrew/bin/node'), '/opt/homebrew/bin/node');
  });

  test('hook commands quote every argument', () => {
    const config = hooksConfig(['/my node/node', '/a b/cli.js'], {});
    assert.equal(config.hooks.agentStop[0].bash, "'/my node/node' '/a b/cli.js' hook stop");
  });

  test('findExecutable searches PATH and checks explicit paths', () => {
    assert.equal(findExecutable('sh', `/nonexistent:/bin`), '/bin/sh');
    assert.equal(findExecutable('sh', '/nonexistent'), undefined);
    assert.equal(findExecutable('/bin/sh'), '/bin/sh');
    assert.equal(findExecutable(join(dir, 'bundle.js')), undefined, 'not executable');
  });
});
