import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallUsage } from '../storage/memory-store.ts';

export interface CopilotReply {
  text: string;
  /** Missing if Copilot didn't write a usage file. */
  usage?: CallUsage;
}

/** Sends a prompt to Copilot and resolves with its reply. */
export type CopilotRunner = (prompt: string) => Promise<CopilotReply>;

export interface CopilotRunnerOptions {
  model: string;
  /** The user's Copilot home, used only to read which account is logged in. */
  sourceHome: string;
  /** Parent for per-call scratch directories; removed after each call. */
  workDir: string;
  bin?: string;
  timeoutMs?: number;
}

// A tool name that doesn't exist: an empty --available-tools list does NOT disable tools.
const NO_TOOLS = '--available-tools=copilot_mem_no_tools';

export function copilotArgs(model: string): string[] {
  return ['-s', '--model', model, NO_TOOLS, '--no-custom-instructions', '--disable-builtin-mcps', '--no-ask-user', '--no-auto-update'];
}

/** Reads the JSON Copilot writes for `--usage-output-file`; undefined if absent or unrecognized. */
export function readUsage(path: string): CallUsage | undefined {
  if (!existsSync(path)) return undefined;
  let raw: {
    totalNanoAiu?: unknown;
    totalPremiumRequestCost?: unknown;
    totalApiDurationMs?: unknown;
    modelMetrics?: Record<string, { usage?: Record<string, unknown> }>;
  };
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof raw?.totalNanoAiu !== 'number') return undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const usage: CallUsage = {
    apiMs: num(raw.totalApiDurationMs),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    nanoAiu: raw.totalNanoAiu,
    premiumRequests: num(raw.totalPremiumRequestCost),
  };
  for (const metrics of Object.values(raw.modelMetrics ?? {})) {
    const u = metrics?.usage ?? {};
    usage.inputTokens += num(u.inputTokens);
    usage.outputTokens += num(u.outputTokens);
    usage.cacheReadTokens += num(u.cacheReadTokens);
    usage.cacheWriteTokens += num(u.cacheWriteTokens);
    usage.reasoningTokens += num(u.reasoningTokens);
  }
  return usage;
}

// The login identity lives in config.json (the token itself is in the OS keychain).
// config.json starts with `//` comment lines, so strip those before parsing.
function readLogin(sourceHome: string): unknown {
  const path = join(sourceHome, 'config.json');
  if (!existsSync(path)) return undefined;
  const json = readFileSync(path, 'utf8').split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  return (JSON.parse(json) as { lastLoggedInUser?: unknown }).lastLoggedInUser;
}

/**
 * Runs `copilot` in a throwaway COPILOT_HOME so summarizer sessions never land in the
 * user's session store (which copilot-mem itself reads). The prompt goes over stdin so
 * transcript text never appears in the process list.
 */
export function createCopilotRunner(options: CopilotRunnerOptions): CopilotRunner {
  return async (prompt) => {
    mkdirSync(options.workDir, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(options.workDir, 'run-'));
    try {
      const home = join(scratch, 'home');
      const cwd = join(scratch, 'cwd');
      mkdirSync(home);
      mkdirSync(cwd);
      const login = readLogin(options.sourceHome);
      writeFileSync(join(home, 'config.json'), JSON.stringify(login ? { lastLoggedInUser: login } : {}));

      const env: NodeJS.ProcessEnv = { ...process.env, COPILOT_HOME: home };
      delete env.COPILOT_ALLOW_ALL;
      const usageFile = join(scratch, 'usage.json');
      const text = await spawnWithInput(options.bin ?? 'copilot', [...copilotArgs(options.model), '--usage-output-file', usageFile], {
        cwd, env, input: prompt, timeoutMs: options.timeoutMs ?? 180_000,
      });
      return { text, usage: readUsage(usageFile) };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
}

function spawnWithInput(
  bin: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.stdin.on('error', () => {}); // EPIPE if copilot exits before reading; surfaced via 'close'.
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`copilot timed out after ${options.timeoutMs}ms`));
      if (code === 0) return resolve(stdout);
      const detail = (stderr.trim() || stdout.trim()).slice(0, 500);
      reject(new Error(`copilot exited with code ${code}: ${detail}`));
    });
    child.stdin.end(options.input);
  });
}
