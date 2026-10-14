import type { MemoryStore } from '../storage/memory-store.ts';
import { buildSessionContext } from './context.ts';

export const HOOK_EVENTS = ['session-start', 'stop'] as const;

export interface HookDeps {
  openStore: () => MemoryStore;
  /** Queue a background sync (+ capped compression) and make sure a worker is running. */
  startWorker: () => void;
}

/** Handles one Copilot hook invocation; returns what to print on stdout, if anything. */
export function runHook(event: string, input: string, deps: HookDeps): string | undefined {
  switch (event) {
    case 'session-start': {
      // Also catches up on turns from a previous session that ended without a sessionEnd hook.
      deps.startWorker();
      const payload = parsePayload(input);
      // A resumed session already got its context when it started.
      if (payload.source === 'resume') return undefined;
      const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
      const store = deps.openStore();
      try {
        const additionalContext = buildSessionContext(store, cwd);
        // VS Code's Local agent reads the same hook file but sends (and expects) its own schema.
        if (typeof payload.hook_event_name === 'string') {
          return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } });
        }
        return JSON.stringify({ additionalContext });
      } finally {
        store.close();
      }
    }
    case 'stop':
      deps.startWorker();
      return undefined;
    default:
      throw new Error(`Unknown hook event "${event}" (expected ${HOOK_EVENTS.join(' or ')})`);
  }
}

function parsePayload(input: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(input);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
